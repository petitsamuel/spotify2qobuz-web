/**
 * Continue sync API route.
 * Continues a chunked sync from where it left off.
 */

import { NextRequest, after } from 'next/server';
import { withSyncAuth, getBothClients, jsonError } from '@/lib/api-helpers';
import { runSyncChunk } from '@/lib/services/chunk-sync';
import { logger } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await params;

  return withSyncAuth(request, async (userId, storage) => {

    // Get the existing task
    const task = await storage.getActiveTask(taskId);
    if (!task) {
      return jsonError('Task not found', 404);
    }

    // Verify task belongs to current user
    if (task.user_id !== userId) {
      return jsonError('Task not found', 404);
    }

    // Only allow continuing chunk_complete tasks
    if (task.status !== 'chunk_complete') {
      return jsonError(`Cannot continue task with status: ${task.status}`, 400);
    }

    if (!task.chunkState) {
      return jsonError('Task has no chunk state to continue from', 400);
    }

    // Get clients
    const clients = await getBothClients(storage, userId);
    if (!clients) {
      return jsonError('Not authenticated', 401);
    }

    // Update task status to running
    await storage.updateActiveTask(taskId, 'running');
    await storage.updateTask(taskId, 'running');

    // Use Next.js after() to run sync after response is sent
    // This ensures Vercel keeps the function alive until the background work completes
    after(async () => {
      try {
        await runSyncChunk(
          userId,
          taskId,
          task.sync_type,
          task.dry_run,
          task.chunkState!.offset, // Continue from where we left off
          storage,
          clients.spotify,
          clients.qobuz,
          task.migration_id
        );
      } catch (err) {
        logger.error('Background sync chunk continuation failed', {
          error: err,
          taskId,
          userId,
          syncType: task.sync_type,
          offset: task.chunkState?.offset,
          errorMessage: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        try {
          await storage.updateActiveTask(taskId, 'failed', undefined, String(err));
        } catch (updateErr) {
          logger.error('Failed to record sync failure in database (task state may be inconsistent)', {
            error: updateErr,
            taskId,
            originalError: err,
            errorMessage: updateErr instanceof Error ? updateErr.message : String(updateErr),
            stack: updateErr instanceof Error ? updateErr.stack : undefined,
          });
        }
      }
    });

    logger.info(`Continuing ${task.sync_type} sync chunk (task=${taskId}, offset=${task.chunkState.offset})`);
    return Response.json({ task_id: taskId, status: 'running' });
  });
}
