/**
 * Start sync API route.
 * Uses chunked sync to avoid Vercel timeout limits.
 */

import { NextRequest, after } from 'next/server';
import { randomBytes } from 'crypto';
import { withSyncAuth, getBothClients, jsonError } from '@/lib/api-helpers';
import { runSyncChunk } from '@/lib/services/chunk-sync';
import { logger } from '@/lib/logger';
import type { SyncProgress } from '@/lib/types';

export async function POST(request: NextRequest) {
  return withSyncAuth(request, async (userId, storage) => {

    const formData = await request.formData();
    const syncType = formData.get('type') as string;
    const dryRun = formData.get('dry_run') === 'true';

    if (!['playlists', 'favorites', 'albums'].includes(syncType)) {
      return jsonError('Invalid sync type', 400);
    }

    // Check for existing active sync
    const existingTask = await storage.getRunningTask(userId);
    if (existingTask) {
      return Response.json({
        error: 'A sync is already in progress',
        active_task_id: existingTask.id,
        sync_type: existingTask.sync_type,
      }, { status: 409 });
    }

    // Get clients
    const clients = await getBothClients(storage, userId);
    if (!clients) {
      return jsonError('Not authenticated', 401);
    }

    // Create task and initialize in database before starting background work
    let taskId: string;
    let migrationId: number;
    try {
      taskId = randomBytes(8).toString('hex');
      migrationId = await storage.createMigration(userId, syncType, dryRun);
      await storage.createTask(userId, taskId, migrationId);

      // Initialize progress
      const initialProgress: SyncProgress = {
        current_playlist: '',
        current_playlist_index: 0,
        total_playlists: 0,
        current_track_index: 0,
        total_tracks: 0,
        tracks_matched: 0,
        tracks_not_matched: 0,
        isrc_matches: 0,
        fuzzy_matches: 0,
        percent_complete: 0,
        recent_missing: [],
      };

      // Store active task in database
      await storage.createActiveTask(userId, taskId, migrationId, syncType, dryRun, initialProgress as unknown as Record<string, unknown>);
    } catch (error) {
      logger.error('Failed to create task in database before starting sync', {
        error,
        userId,
        syncType,
        dryRun,
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
          syncType,
          dryRun,
          0, // Start from offset 0
          storage,
          clients.spotify,
          clients.qobuz,
          migrationId
        );
      } catch (err) {
        logger.error('Background sync task failed', {
          error: err,
          taskId,
          userId,
          syncType,
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
              syncType,
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
            syncType,
            originalError: err,
            errorMessage: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
        }
      }
    });

    logger.info(`Started ${syncType} sync (task=${taskId}, user=${userId}, dry_run=${dryRun})`);
    return Response.json({
      task_id: taskId,
      status: 'starting',
      message: 'Sync started successfully. Poll /api/sync/status for progress updates.'
    });
  });
}
