/**
 * Shared chunk sync helper functions.
 * Extracts common logic from start and continue routes.
 */

import { AsyncSyncService } from './sync';
import { Storage } from '../db/storage';
import { SpotifyClient } from './spotify';
import { QobuzClient } from './qobuz';
import { logger } from '../logger';

// How many items to process per chunk (tuned for ~30s execution time)
export const CHUNK_SIZE = 50;

export interface CumulativeStats {
  tracks_matched: number;
  tracks_not_matched: number;
  isrc_matches: number;
  fuzzy_matches: number;
  albums_matched?: number;
  albums_not_matched?: number;
  upc_matches?: number;
}

/**
 * Get cumulative stats from the migration record.
 */
export async function getCumulativeStats(storage: Storage, migrationId: number): Promise<CumulativeStats> {
  const migration = await storage.getMigration(migrationId);
  if (!migration) {
    return {
      tracks_matched: 0,
      tracks_not_matched: 0,
      isrc_matches: 0,
      fuzzy_matches: 0,
    };
  }

  return {
    tracks_matched: migration.tracks_matched || 0,
    tracks_not_matched: migration.tracks_not_matched || 0,
    isrc_matches: migration.isrc_matches || 0,
    fuzzy_matches: migration.fuzzy_matches || 0,
  };
}

/**
 * Run a chunk of sync operations.
 */
export async function runSyncChunk(
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

  // Get cumulative stats from previous chunks
  const cumulativeStats = await getCumulativeStats(storage, migrationId);

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

      // Update migration with cumulative stats
      await storage.updateMigration(migrationId, {
        completed_at: new Date().toISOString(),
        status: 'completed',
        tracks_matched: cumulativeStats.tracks_matched + report.tracks_matched,
        tracks_not_matched: cumulativeStats.tracks_not_matched + report.tracks_not_matched,
        isrc_matches: cumulativeStats.isrc_matches + report.isrc_matches,
        fuzzy_matches: cumulativeStats.fuzzy_matches + report.fuzzy_matches,
        report_json: JSON.stringify(report),
      });

      await storage.updateActiveTask(taskId, 'completed', undefined, undefined, report as unknown as Record<string, unknown>);
      await storage.updateTask(taskId, 'completed');

      logger.info(`Playlist sync completed: ${taskId}`);
      return;
    }

    // Calculate cumulative stats for this chunk
    const chunkTracksMatched = 'tracks_matched' in chunkResult.partialReport
      ? chunkResult.partialReport.tracks_matched ?? 0
      : 'albums_matched' in chunkResult.partialReport
        ? chunkResult.partialReport.albums_matched ?? 0
        : 0;
    const chunkTracksNotMatched = 'tracks_not_matched' in chunkResult.partialReport
      ? chunkResult.partialReport.tracks_not_matched ?? 0
      : 'albums_not_matched' in chunkResult.partialReport
        ? chunkResult.partialReport.albums_not_matched ?? 0
        : 0;
    const chunkIsrcMatches = 'isrc_matches' in chunkResult.partialReport
      ? chunkResult.partialReport.isrc_matches ?? 0
      : 'upc_matches' in chunkResult.partialReport
        ? chunkResult.partialReport.upc_matches ?? 0
        : 0;
    const chunkFuzzyMatches = chunkResult.partialReport.fuzzy_matches ?? 0;

    // Update migration with cumulative stats after each chunk
    await storage.updateMigration(migrationId, {
      tracks_matched: cumulativeStats.tracks_matched + chunkTracksMatched,
      tracks_not_matched: cumulativeStats.tracks_not_matched + chunkTracksNotMatched,
      isrc_matches: cumulativeStats.isrc_matches + chunkIsrcMatches,
      fuzzy_matches: cumulativeStats.fuzzy_matches + chunkFuzzyMatches,
    });

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
      // All done! Mark as completed
      await storage.updateMigration(migrationId, {
        completed_at: new Date().toISOString(),
        status: 'completed',
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
    // Update database to reflect failure
    await storage.updateMigration(migrationId, {
      completed_at: new Date().toISOString(),
      status: 'failed',
      report_json: JSON.stringify({ error: String(error) }),
    });

    await storage.updateActiveTask(taskId, 'failed', undefined, String(error));
    await storage.updateTask(taskId, 'failed');

    // Log with comprehensive context for debugging
    logger.error('Chunk sync failed', {
      error,
      taskId,
      userId,
      syncType,
      offset,
      chunkSize: CHUNK_SIZE,
      migrationId,
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
    });

    // Re-throw to let caller handle the error
    throw error;
  }
}
