/**
 * Start sync API route.
 * Uses chunked sync to avoid Vercel timeout limits.
 */

import { NextRequest } from 'next/server';
import { randomBytes } from 'crypto';
import { ensureDbInitialized, getBothClients, getCurrentUserId, jsonError } from '@/lib/api-helpers';
import { runSyncChunk } from '@/lib/services/chunk-sync';
import { logger } from '@/lib/logger';
import type { SyncProgress } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) {
      return jsonError('Not authenticated', 401);
    }

    const storage = await ensureDbInitialized();

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

    // Create task
    const taskId = randomBytes(8).toString('hex');
    const migrationId = await storage.createMigration(userId, syncType, dryRun);
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

    // Start sync in background (fire and forget, but handle errors)
    runSyncChunk(
      userId,
      taskId,
      syncType,
      dryRun,
      0, // Start from offset 0
      storage,
      clients.spotify,
      clients.qobuz,
      migrationId
    ).catch(async (err) => {
      logger.error(`Unexpected sync error for task ${taskId}: ${err}`);
      try {
        await storage.updateActiveTask(taskId, 'failed', undefined, String(err));
      } catch (updateErr) {
        logger.error(`Failed to update task status after error: ${updateErr}`);
      }
    });

    logger.info(`Started ${syncType} sync (task=${taskId}, user=${userId}, dry_run=${dryRun})`);
    return Response.json({ task_id: taskId, status: 'starting' });
  } catch (error) {
    logger.error(`Failed to start sync: ${error}`);
    return jsonError('Failed to start sync', 500);
  }
}
