/**
 * Shared chunk sync helper functions.
 * Extracts common logic from start and continue routes.
 */

import { AsyncSyncService, PlaylistSyncOptions } from './sync';
import { Storage } from '../db/storage';
import { SpotifyClient } from './spotify';
import { QobuzClient } from './qobuz';
import { logger } from '../logger';
import { MissingTrack } from '../types';

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
  migrationId: number,
  options?: { skipUnchangedPlaylists?: boolean }
): Promise<void> {
  const alreadySynced = await storage.getSyncedTrackIds(userId, syncType);

  // Get cumulative stats from previous chunks
  const cumulativeStats = await getCumulativeStats(storage, migrationId);

  // Retrieve existing recent_missing from previous chunk progress
  const existingTask = await storage.getActiveTask(taskId);
  const existingRecentMissing = (existingTask?.progress as { recent_missing?: MissingTrack[] } | null)?.recent_missing;

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
    checkCancelled,
    existingRecentMissing
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
      // Playlists now use chunking (10 playlists per chunk)
      // Build playlist sync options if skipUnchangedPlaylists is enabled
      let playlistSyncOptions: PlaylistSyncOptions | undefined;
      if (options?.skipUnchangedPlaylists) {
        const syncedPlaylistsMap = await storage.getSyncedPlaylistsMap(userId);
        playlistSyncOptions = {
          skipUnchanged: true,
          syncedPlaylistsMap,
          onPlaylistSynced: async (playlistId, snapshotId, trackCount) => {
            await storage.markPlaylistSynced(userId, playlistId, snapshotId, trackCount);
          },
        };
        logger.info(`Skip unchanged playlists enabled. Found ${syncedPlaylistsMap.size} previously synced playlists.`);
      }

      // Use smaller chunk size for playlists (10) since each playlist can have many tracks
      const PLAYLIST_CHUNK_SIZE = 10;
      chunkResult = await syncService.syncPlaylistsChunk(offset, PLAYLIST_CHUNK_SIZE, dryRun, playlistSyncOptions);

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

      // Build aggregated report with cumulative totals (not just last chunk)
      const finalCumulativeStats = {
        tracks_matched: cumulativeStats.tracks_matched + chunkTracksMatched,
        tracks_not_matched: cumulativeStats.tracks_not_matched + chunkTracksNotMatched,
        isrc_matches: cumulativeStats.isrc_matches + chunkIsrcMatches,
        fuzzy_matches: cumulativeStats.fuzzy_matches + chunkFuzzyMatches,
      };

      // Create aggregated report using cumulative stats while preserving other report fields
      const aggregatedReport = {
        ...chunkResult.partialReport,
        // Override count fields with cumulative totals
        ...(syncType === 'albums'
          ? {
              albums_matched: finalCumulativeStats.tracks_matched,
              albums_not_matched: finalCumulativeStats.tracks_not_matched,
              upc_matches: finalCumulativeStats.isrc_matches,
              fuzzy_matches: finalCumulativeStats.fuzzy_matches,
            }
          : {
              tracks_matched: finalCumulativeStats.tracks_matched,
              tracks_not_matched: finalCumulativeStats.tracks_not_matched,
              isrc_matches: finalCumulativeStats.isrc_matches,
              fuzzy_matches: finalCumulativeStats.fuzzy_matches,
            }),
      };

      await storage.updateActiveTask(
        taskId,
        'completed',
        undefined,
        undefined,
        aggregatedReport as unknown as Record<string, unknown>,
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
