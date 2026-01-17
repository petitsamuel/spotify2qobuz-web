/**
 * SSE progress stream API route.
 */

import { NextRequest } from 'next/server';
import { ensureDbInitialized } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await params;
  const storage = await ensureDbInitialized();

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const sendProgress = async (): Promise<boolean> => {
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

      // Send initial progress
      if (!(await sendProgress())) {
        controller.close();
        return;
      }

      // Poll for updates
      const poll = async () => {
        if (!(await sendProgress())) {
          controller.close();
          return;
        }
        setTimeout(poll, 500);
      };

      setTimeout(poll, 500);
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
