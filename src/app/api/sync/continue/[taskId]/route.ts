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

    // Update task status to running before starting background work
    try {
      await storage.updateActiveTask(taskId, 'running');
      await storage.updateTask(taskId, 'running');
    } catch (error) {
      logger.error('Failed to update task status to running before starting sync', {
        error,
        taskId,
        userId,
        syncType: task.sync_type,
        errorMessage: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return jsonError(
        'Failed to start sync due to database error. Please try again or contact support if the issue persists.',
        500
      );
    }

    // Use Next.js after() to run sync after response is sent
    // Note: Work in after() is subject to platform timeouts (e.g., 60s on Vercel Pro)
    // Errors in after() cannot affect the HTTP response (already sent to client)
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

        // Try multiple times to record the failure with exponential backoff
        let updateSuccess = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await storage.updateActiveTask(taskId, 'failed', undefined, String(err));
            updateSuccess = true;
            break;
          } catch (updateErr) {
            logger.error(`Failed to record sync failure in database (attempt ${attempt}/3)`, {
              error: updateErr,
              taskId,
              userId,
              originalError: err,
              attempt,
              errorMessage: updateErr instanceof Error ? updateErr.message : String(updateErr),
              stack: updateErr instanceof Error ? updateErr.stack : undefined,
            });

            if (attempt < 3) {
              // Wait before retry with exponential backoff
              await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            }
          }
        }

        if (!updateSuccess) {
          logger.error('CRITICAL: Failed to record sync failure after 3 attempts. Task state is inconsistent.', {
            taskId,
            userId,
            syncType: task.sync_type,
            originalError: err,
            errorMessage: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
        }
      }
    });

    logger.info(`Continuing ${task.sync_type} sync chunk (task=${taskId}, offset=${task.chunkState.offset})`);
    return Response.json({
      task_id: taskId,
      status: 'running',
      message: 'Sync chunk started successfully. Poll /api/sync/status for progress updates.'
    });
  });
}
