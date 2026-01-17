/**
 * SSE progress stream API route.
 */

import { NextRequest } from 'next/server';
import { ensureDbInitialized } from '@/lib/api-helpers';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await params;
  const storage = await ensureDbInitialized();
  const signal = request.signal;

  const encoder = new TextEncoder();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let isClosed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (!isClosed) {
          isClosed = true;
          try {
            controller.close();
          } catch {
            // Controller may already be closed
          }
        }
      };

      // Listen for client disconnect
      signal.addEventListener('abort', cleanup);

      const sendProgress = async (): Promise<boolean> => {
        if (signal.aborted || isClosed) return false;

        const task = await storage.getActiveTask(taskId);
        if (!task) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: 'not_found' })}\n\n`));
          return false;
        }

        const data = JSON.stringify({
          status: task.status,
          progress: task.progress,
          ...(task.status === 'completed' && { report: task.report }),
          ...(task.error && { error: task.error }),
        });

        controller.enqueue(encoder.encode(`data: ${data}\n\n`));

        if (['completed', 'failed', 'cancelled'].includes(task.status)) {
          return false;
        }

        return true;
      };

      const poll = async () => {
        if (signal.aborted || isClosed) {
          cleanup();
          return;
        }

        try {
          if (!(await sendProgress())) {
            cleanup();
            return;
          }
          timeoutId = setTimeout(poll, 500);
        } catch (error) {
          logger.error(`SSE progress poll failed for task ${taskId}: ${error}`);
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              status: 'error',
              error: 'Failed to fetch progress update',
            })}\n\n`));
          } catch {
            // Controller may be closed
          }
          cleanup();
        }
      };

      // Send initial progress
      try {
        if (!(await sendProgress())) {
          cleanup();
          return;
        }
        timeoutId = setTimeout(poll, 500);
      } catch (error) {
        logger.error(`SSE initial progress failed for task ${taskId}: ${error}`);
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            status: 'error',
            error: 'Failed to fetch initial progress',
          })}\n\n`));
        } catch {
          // Controller may be closed
        }
        cleanup();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
