/**
 * Sync routes for managing synchronization tasks.
 */

import { Hono } from 'hono';
import { randomBytes } from 'crypto';
import { Storage } from '../db/storage';
import { SpotifyClient, SpotifyCredentials } from '../services/spotify';
import { QobuzClient } from '../services/qobuz';
import { AsyncSyncService, SyncProgress, SyncReport, AlbumSyncReport } from '../services/sync';
import { logger } from '../lib/logger';

// Active tasks storage
const activeTasks = new Map<string, {
  syncType: string;
  status: string;
  progress: SyncProgress;
  report?: SyncReport | AlbumSyncReport;
  error?: string;
  dryRun: boolean;
  service?: AsyncSyncService;
}>();

export function createSyncRoutes(storage: Storage): Hono {
  const app = new Hono();

  // Start a sync
  app.post('/start', async (c) => {
    const body = await c.req.parseBody();
    const syncType = body.type as string;
    const dryRun = body.dry_run === 'true';

    if (!['playlists', 'favorites', 'albums'].includes(syncType)) {
      return c.json({ error: 'Invalid sync type' }, 400);
    }

    // Get clients
    const clients = await getClients(storage);
    if (!clients) {
      return c.json({ error: 'Not authenticated' }, 401);
    }

    // Create task
    const taskId = randomBytes(8).toString('hex');
    const migrationId = await storage.createMigration(syncType, dryRun);
    await storage.createTask(taskId, migrationId);

    // Initialize task state
    activeTasks.set(taskId, {
      syncType,
      status: 'starting',
      progress: {
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
      },
      dryRun,
    });

    // Start sync in background
    runSync(taskId, syncType, dryRun, storage, clients.spotify, clients.qobuz, migrationId);

    logger.info(`Started ${syncType} sync (task=${taskId}, dry_run=${dryRun})`);
    return c.json({ task_id: taskId, status: 'starting' });
  });

  // Get sync status
  app.get('/status/:taskId', async (c) => {
    const taskId = c.req.param('taskId');
    const task = activeTasks.get(taskId);

    if (!task) {
      // Check database
      const dbTask = await storage.getTask(taskId);
      if (dbTask) {
        return c.json({
          task_id: taskId,
          status: dbTask.status,
          progress: dbTask.progress,
        });
      }
      return c.json({ error: 'Task not found' }, 404);
    }

    return c.json({
      task_id: taskId,
      status: task.status,
      progress: task.progress,
      report: task.report,
      error: task.error,
    });
  });

  // Get active sync
  app.get('/active', (c) => {
    for (const [taskId, task] of activeTasks) {
      if (task.status === 'running' || task.status === 'starting') {
        return c.json({
          task_id: taskId,
          sync_type: task.syncType,
          progress: task.progress,
          dry_run: task.dryRun,
        });
      }
    }
    return c.json({});
  });

  // Cancel sync
  app.post('/cancel/:taskId', (c) => {
    const taskId = c.req.param('taskId');
    const task = activeTasks.get(taskId);

    if (!task) {
      return c.json({ error: 'Task not found' }, 404);
    }

    if (task.service) {
      task.service.cancel();
    }
    task.status = 'cancelled';

    return c.json({ status: 'cancelled' });
  });

  // SSE progress stream
  app.get('/progress/:taskId', async (c) => {
    const taskId = c.req.param('taskId');

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        const sendProgress = () => {
          const task = activeTasks.get(taskId);
          if (!task) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: 'not_found' })}\n\n`));
            controller.close();
            return false;
          }

          const data = JSON.stringify({
            status: task.status,
            progress: task.progress,
            ...(task.status === 'completed' && { report: task.report }),
            ...(task.error && { error: task.error }),
          });

          controller.enqueue(encoder.encode(`data: ${data}\n\n`));

          if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
            controller.close();
            return false;
          }

          return true;
        };

        // Send initial progress
        if (!sendProgress()) return;

        // Poll for updates
        const interval = setInterval(() => {
          if (!sendProgress()) {
            clearInterval(interval);
          }
        }, 500);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  });

  return app;
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
  const task = activeTasks.get(taskId);
  if (!task) return;

  // Get already synced tracks
  const alreadySynced = await storage.getSyncedTrackIds(syncType);

  // Create sync service with progress callback
  const syncService = new AsyncSyncService(spotifyClient, qobuzClient, async (progress) => {
    task.progress = progress;
    await storage.updateTask(taskId, 'running', progress as unknown as Record<string, unknown>);
  });

  task.service = syncService;
  task.status = 'running';
  await storage.updateTask(taskId, 'running');

  try {
    let report: SyncReport | AlbumSyncReport;

    // Track synced callback
    const onItemSynced = async (spotifyId: string, qobuzId: string) => {
      await storage.markTrackSynced(spotifyId, qobuzId, syncType);
    };

    if (syncType === 'favorites') {
      report = await syncService.syncFavorites(dryRun, alreadySynced, onItemSynced);

      // Save unmatched tracks
      for (const track of report.missing_tracks) {
        await storage.saveUnmatchedTrack(
          track.spotify_id,
          track.title,
          track.artist,
          track.album,
          syncType,
          track.suggestions
        );
      }
    } else if (syncType === 'albums') {
      report = await syncService.syncAlbums(dryRun, alreadySynced, onItemSynced);

      // Save unmatched albums
      for (const album of (report as AlbumSyncReport).missing_albums) {
        await storage.saveUnmatchedTrack(
          album.spotify_id,
          album.title,
          album.artist,
          '',
          syncType,
          album.suggestions
        );
      }
    } else {
      report = await syncService.syncPlaylists(undefined, dryRun);

      // Save unmatched tracks
      for (const track of report.missing_tracks) {
        await storage.saveUnmatchedTrack(
          track.spotify_id,
          track.title,
          track.artist,
          track.album,
          syncType,
          track.suggestions
        );
      }
    }

    task.status = 'completed';
    task.report = report;

    // Update migration record
    await storage.updateMigration(migrationId, {
      completed_at: new Date().toISOString(),
      status: 'completed',
      tracks_matched: 'tracks_matched' in report ? report.tracks_matched : (report as AlbumSyncReport).albums_matched,
      tracks_not_matched: 'tracks_not_matched' in report ? report.tracks_not_matched : (report as AlbumSyncReport).albums_not_matched,
      isrc_matches: 'isrc_matches' in report ? report.isrc_matches : (report as AlbumSyncReport).upc_matches,
      fuzzy_matches: report.fuzzy_matches,
      report_json: JSON.stringify(report),
    });

    await storage.updateTask(taskId, 'completed', task.progress as unknown as Record<string, unknown>);

    logger.info(`Sync completed: ${taskId}`);
  } catch (error) {
    task.status = 'failed';
    task.error = String(error);

    await storage.updateMigration(migrationId, {
      completed_at: new Date().toISOString(),
      status: 'failed',
      report_json: JSON.stringify({ error: String(error) }),
    });

    await storage.updateTask(taskId, 'failed');
    logger.error(`Sync failed: ${error}`);
  }
}

async function getClients(storage: Storage): Promise<{ spotify: SpotifyClient; qobuz: QobuzClient } | null> {
  const spotifyCreds = await storage.getCredentials('spotify') as SpotifyCredentials | null;
  const qobuzCreds = await storage.getCredentials('qobuz') as { user_auth_token: string } | null;

  if (!spotifyCreds || !qobuzCreds) {
    return null;
  }

  const spotifyClient = new SpotifyClient(spotifyCreds, async (newCreds) => {
    await storage.saveCredentials('spotify', newCreds as unknown as Record<string, unknown>);
  });

  const qobuzClient = new QobuzClient(qobuzCreds.user_auth_token);

  return { spotify: spotifyClient, qobuz: qobuzClient };
}
