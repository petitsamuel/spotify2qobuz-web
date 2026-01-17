/**
 * Start sync API route.
 */

import { NextRequest } from 'next/server';
import { randomBytes } from 'crypto';
import { ensureDbInitialized, getBothClients, jsonError } from '@/lib/api-helpers';
import { AsyncSyncService } from '@/lib/services/sync';
import { logger } from '@/lib/logger';
import { Storage } from '@/lib/db/storage';
import { SpotifyClient } from '@/lib/services/spotify';
import { QobuzClient } from '@/lib/services/qobuz';
import type { SyncProgress } from '@/lib/types';

export async function POST(request: NextRequest) {
  const storage = await ensureDbInitialized();

  const formData = await request.formData();
  const syncType = formData.get('type') as string;
  const dryRun = formData.get('dry_run') === 'true';

  if (!['playlists', 'favorites', 'albums'].includes(syncType)) {
    return jsonError('Invalid sync type', 400);
  }

  // Check for existing active sync
  const existingTask = await storage.getRunningTask();
  if (existingTask) {
    return Response.json({
      error: 'A sync is already in progress',
      active_task_id: existingTask.id,
      sync_type: existingTask.sync_type,
    }, { status: 409 });
  }

  // Get clients
  const clients = await getBothClients(storage);
  if (!clients) {
    return jsonError('Not authenticated', 401);
  }

  // Create task
  const taskId = randomBytes(8).toString('hex');
  const migrationId = await storage.createMigration(syncType, dryRun);
  await storage.createTask(taskId, migrationId);

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
  await storage.createActiveTask(taskId, migrationId, syncType, dryRun, initialProgress as unknown as Record<string, unknown>);

  // Start sync in background
  runSync(taskId, syncType, dryRun, storage, clients.spotify, clients.qobuz, migrationId)
    .catch((err) => {
      logger.error(`Unexpected sync error for task ${taskId}: ${err}`);
      storage.updateActiveTask(taskId, 'failed', undefined, String(err));
    });

  logger.info(`Started ${syncType} sync (task=${taskId}, dry_run=${dryRun})`);
  return Response.json({ task_id: taskId, status: 'starting' });
}

async function runSync(
  taskId: string,
  syncType: string,
  dryRun: boolean,
  storage: Storage,
  spotifyClient: SpotifyClient,
  qobuzClient: QobuzClient,
  migrationId: number
): Promise<void> {
  const alreadySynced = await storage.getSyncedTrackIds(syncType);

  const syncService = new AsyncSyncService(spotifyClient, qobuzClient, async (progress) => {
    await storage.updateActiveTask(taskId, 'running', progress as unknown as Record<string, unknown>);
    await storage.updateTask(taskId, 'running', progress as unknown as Record<string, unknown>);
  });

  await storage.updateActiveTask(taskId, 'running');
  await storage.updateTask(taskId, 'running');

  try {
    const onItemSynced = async (spotifyId: string, qobuzId: string) => {
      await storage.markTrackSynced(spotifyId, qobuzId, syncType);
    };

    let report;

    if (syncType === 'favorites') {
      report = await syncService.syncFavorites(dryRun, alreadySynced, onItemSynced);
      for (const track of report.missing_tracks) {
        await storage.saveUnmatchedTrack(
          track.spotify_id,
          track.title,
          track.artist,
          track.album,
          syncType,
          track.suggestions as unknown as Array<Record<string, unknown>>
        );
      }
    } else if (syncType === 'albums') {
      report = await syncService.syncAlbums(dryRun, alreadySynced, onItemSynced);
      for (const album of report.missing_albums) {
        await storage.saveUnmatchedTrack(
          album.spotify_id,
          album.title,
          album.artist,
          '',
          syncType,
          album.suggestions as unknown as Array<Record<string, unknown>>
        );
      }
    } else {
      report = await syncService.syncPlaylists(undefined, dryRun);
      for (const track of report.missing_tracks) {
        await storage.saveUnmatchedTrack(
          track.spotify_id,
          track.title,
          track.artist,
          track.album,
          syncType,
          track.suggestions as unknown as Array<Record<string, unknown>>
        );
      }
    }

    // Update migration record
    await storage.updateMigration(migrationId, {
      completed_at: new Date().toISOString(),
      status: 'completed',
      tracks_matched: 'tracks_matched' in report ? report.tracks_matched : report.albums_matched,
      tracks_not_matched: 'tracks_not_matched' in report ? report.tracks_not_matched : report.albums_not_matched,
      isrc_matches: 'isrc_matches' in report ? report.isrc_matches : report.upc_matches,
      fuzzy_matches: report.fuzzy_matches,
      report_json: JSON.stringify(report),
    });

    await storage.updateActiveTask(taskId, 'completed', undefined, undefined, report as unknown as Record<string, unknown>);
    await storage.updateTask(taskId, 'completed');

    logger.info(`Sync completed: ${taskId}`);
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
