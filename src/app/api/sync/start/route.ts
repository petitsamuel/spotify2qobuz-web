/**
 * Start sync API route.
 * Uses chunked sync to avoid Vercel timeout limits.
 */

import { NextRequest } from 'next/server';
import { randomBytes } from 'crypto';
import { ensureDbInitialized, getBothClients, getCurrentUserId, jsonError } from '@/lib/api-helpers';
import { AsyncSyncService } from '@/lib/services/sync';
import { logger } from '@/lib/logger';
import { Storage } from '@/lib/db/storage';
import { SpotifyClient } from '@/lib/services/spotify';
import { QobuzClient } from '@/lib/services/qobuz';
import type { SyncProgress } from '@/lib/types';

// How many items to process per chunk (tuned for ~30s execution time)
const CHUNK_SIZE = 50;

export async function POST(request: NextRequest) {
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

  // Start sync in background
  runSync(userId, taskId, syncType, dryRun, storage, clients.spotify, clients.qobuz, migrationId)
    .catch((err) => {
      logger.error(`Unexpected sync error for task ${taskId}: ${err}`);
      storage.updateActiveTask(taskId, 'failed', undefined, String(err));
    });

  logger.info(`Started ${syncType} sync (task=${taskId}, user=${userId}, dry_run=${dryRun})`);
  return Response.json({ task_id: taskId, status: 'starting' });
}

async function runSync(
  userId: string,
  taskId: string,
  syncType: string,
  dryRun: boolean,
  storage: Storage,
  spotifyClient: SpotifyClient,
  qobuzClient: QobuzClient,
  migrationId: number
): Promise<void> {
  const alreadySynced = await storage.getSyncedTrackIds(userId, syncType);

  // Create cancellation checker that queries the database
  const checkCancelled = async (): Promise<boolean> => {
    const task = await storage.getActiveTask(taskId);
    return task?.status === 'cancelled';
  };

  const syncService = new AsyncSyncService(
    spotifyClient,
    qobuzClient,
    async (progress) => {
      await storage.updateActiveTask(taskId, 'running', progress as unknown as Record<string, unknown>);
      await storage.updateTask(taskId, 'running', progress as unknown as Record<string, unknown>);
    },
    checkCancelled
  );

  await storage.updateActiveTask(taskId, 'running');
  await storage.updateTask(taskId, 'running');

  try {
    const onItemSynced = async (spotifyId: string, qobuzId: string) => {
      await storage.markTrackSynced(userId, spotifyId, qobuzId, syncType);
    };

    // For favorites and albums, use chunked sync
    if (syncType === 'favorites' || syncType === 'albums') {
      let chunkResult;

      if (syncType === 'favorites') {
        chunkResult = await syncService.syncFavoritesChunk(0, CHUNK_SIZE, dryRun, alreadySynced, onItemSynced);

        // Save unmatched tracks from this chunk
        const partialReport = chunkResult.partialReport;
        if ('missing_tracks' in partialReport && partialReport.missing_tracks) {
          for (const track of partialReport.missing_tracks) {
            await storage.saveUnmatchedTrack(
              userId,
              track.spotify_id,
              track.title,
              track.artist,
              track.album,
              syncType,
              track.suggestions as unknown as Array<Record<string, unknown>>
            );
          }
        }
      } else {
        chunkResult = await syncService.syncAlbumsChunk(0, CHUNK_SIZE, dryRun, alreadySynced, onItemSynced);

        // Save unmatched albums from this chunk
        const partialReport = chunkResult.partialReport;
        if ('missing_albums' in partialReport && partialReport.missing_albums) {
          for (const album of partialReport.missing_albums) {
            await storage.saveUnmatchedTrack(
              userId,
              album.spotify_id,
              album.title,
              album.artist,
              '',
              syncType,
              album.suggestions as unknown as Array<Record<string, unknown>>
            );
          }
        }
      }

      // Check if there are more items to process
      if (chunkResult.hasMore) {
        // Save chunk state for next continuation
        const chunkState = {
          offset: chunkResult.nextOffset,
          totalItems: chunkResult.totalItems,
          processedInChunk: chunkResult.processedInChunk,
          hasMore: true,
        };

        await storage.updateActiveTask(
          taskId,
          'chunk_complete',
          undefined,
          undefined,
          chunkResult.partialReport as unknown as Record<string, unknown>,
          chunkState
        );
        await storage.updateTask(taskId, 'chunk_complete');

        // Also save to sync_progress for resumability
        await storage.saveSyncProgress(userId, syncType, chunkResult.nextOffset, chunkResult.totalItems);

        logger.info(`First chunk completed, more to go: ${taskId} (next offset: ${chunkResult.nextOffset})`);
      } else {
        // All done in the first chunk! Update migration and mark as completed
        await storage.updateMigration(migrationId, {
          completed_at: new Date().toISOString(),
          status: 'completed',
          tracks_matched: 'tracks_matched' in chunkResult.partialReport ? chunkResult.partialReport.tracks_matched ?? 0 : 0,
          tracks_not_matched: 'tracks_not_matched' in chunkResult.partialReport ? chunkResult.partialReport.tracks_not_matched ?? 0 : 0,
          isrc_matches: 'isrc_matches' in chunkResult.partialReport ? chunkResult.partialReport.isrc_matches ?? 0 : 0,
          fuzzy_matches: chunkResult.partialReport.fuzzy_matches ?? 0,
          report_json: JSON.stringify(chunkResult.partialReport),
        });

        await storage.updateActiveTask(
          taskId,
          'completed',
          undefined,
          undefined,
          chunkResult.partialReport as unknown as Record<string, unknown>,
          { offset: chunkResult.nextOffset, totalItems: chunkResult.totalItems, processedInChunk: 0, hasMore: false }
        );
        await storage.updateTask(taskId, 'completed');

        logger.info(`Sync completed in first chunk: ${taskId}`);
      }
    } else {
      // Playlists use full sync (no chunking yet)
      const report = await syncService.syncPlaylists(undefined, dryRun);
      for (const track of report.missing_tracks) {
        await storage.saveUnmatchedTrack(
          userId,
          track.spotify_id,
          track.title,
          track.artist,
          track.album,
          syncType,
          track.suggestions as unknown as Array<Record<string, unknown>>
        );
      }

      // Update migration record
      await storage.updateMigration(migrationId, {
        completed_at: new Date().toISOString(),
        status: 'completed',
        tracks_matched: report.tracks_matched,
        tracks_not_matched: report.tracks_not_matched,
        isrc_matches: report.isrc_matches,
        fuzzy_matches: report.fuzzy_matches,
        report_json: JSON.stringify(report),
      });

      await storage.updateActiveTask(taskId, 'completed', undefined, undefined, report as unknown as Record<string, unknown>);
      await storage.updateTask(taskId, 'completed');

      logger.info(`Sync completed: ${taskId}`);
    }
  } catch (error) {
    await storage.updateMigration(migrationId, {
      completed_at: new Date().toISOString(),
      status: 'failed',
      report_json: JSON.stringify({ error: String(error) }),
    });

    await storage.updateActiveTask(taskId, 'failed', undefined, String(error));
    await storage.updateTask(taskId, 'failed');

    logger.error(`Sync failed: ${error}`);
  }
}
