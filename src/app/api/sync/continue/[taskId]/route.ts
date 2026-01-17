/**
 * Continue sync API route.
 * Continues a chunked sync from where it left off.
 */

import { NextRequest } from 'next/server';
import { ensureDbInitialized, getBothClients, getCurrentUserId, jsonError } from '@/lib/api-helpers';
import { AsyncSyncService } from '@/lib/services/sync';
import { logger } from '@/lib/logger';
import { Storage } from '@/lib/db/storage';
import { SpotifyClient } from '@/lib/services/spotify';
import { QobuzClient } from '@/lib/services/qobuz';

// How many items to process per chunk (tuned for ~30s execution time)
const CHUNK_SIZE = 50;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return jsonError('Not authenticated', 401);
  }

  const { taskId } = await params;

  const storage = await ensureDbInitialized();

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

  // Run the next chunk in background
  runChunk(
    userId,
    taskId,
    task.sync_type,
    task.dry_run,
    task.chunkState.offset, // Continue from where we left off
    storage,
    clients.spotify,
    clients.qobuz,
    task.migration_id
  ).catch((err) => {
    logger.error(`Unexpected chunk error for task ${taskId}: ${err}`);
    storage.updateActiveTask(taskId, 'failed', undefined, String(err));
  });

  logger.info(`Continuing ${task.sync_type} sync chunk (task=${taskId}, offset=${task.chunkState.offset})`);
  return Response.json({ task_id: taskId, status: 'running' });
}

async function runChunk(
  userId: string,
  taskId: string,
  syncType: string,
  dryRun: boolean,
  offset: number,
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

  try {
    const onItemSynced = async (spotifyId: string, qobuzId: string) => {
      await storage.markTrackSynced(userId, spotifyId, qobuzId, syncType);
    };

    let chunkResult;

    if (syncType === 'favorites') {
      chunkResult = await syncService.syncFavoritesChunk(offset, CHUNK_SIZE, dryRun, alreadySynced, onItemSynced);

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
    } else if (syncType === 'albums') {
      chunkResult = await syncService.syncAlbumsChunk(offset, CHUNK_SIZE, dryRun, alreadySynced, onItemSynced);

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
    } else {
      // Playlists don't support chunking yet - run full sync
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

      // Update migration and mark as completed
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

      logger.info(`Playlist sync completed: ${taskId}`);
      return;
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

      logger.info(`Chunk completed, more to go: ${taskId} (next offset: ${chunkResult.nextOffset})`);
    } else {
      // All done! Update migration and mark as completed
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

      // Clear sync progress since we're done
      await storage.clearSyncProgress(userId, syncType);

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

    logger.error(`Chunk sync failed: ${error}`);
  }
}
