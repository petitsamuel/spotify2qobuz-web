/**
 * Continue sync API route.
 * Continues a chunked sync from where it left off.
 */

import { NextRequest, after } from 'next/server';
import { withSyncAuth, getBothClients, jsonError, handleBackgroundSyncError } from '@/lib/api-helpers';
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

    // Capture values before async callback
    const offset = task.chunkState.offset;
    const syncType = task.sync_type;
    const dryRun = task.dry_run;
    const migrationId = task.migration_id;

    // Run sync in background after response is sent
    after(async () => {
      try {
        await runSyncChunk(
          userId,
          taskId,
          syncType,
          dryRun,
          offset,
          storage,
          clients.spotify,
          clients.qobuz,
          migrationId
        );
      } catch (err) {
        await handleBackgroundSyncError(err, storage, taskId, userId, syncType, offset);
      }
    });

    logger.info(`Continuing ${syncType} sync chunk (task=${taskId}, offset=${offset})`);
    return Response.json({ task_id: taskId, status: 'running' });
  });
}
