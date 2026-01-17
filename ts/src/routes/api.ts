/**
 * API routes for stats and operations.
 */

import { Hono } from 'hono';
import { Storage } from '../db/storage';
import { SpotifyClient, SpotifyCredentials } from '../services/spotify';
import { QobuzClient } from '../services/qobuz';
import { logger } from '../lib/logger';

export function createApiRoutes(storage: Storage): Hono {
  const app = new Hono();

  // Spotify stats
  app.get('/spotify/stats', async (c) => {
    const creds = await storage.getCredentials('spotify') as SpotifyCredentials | null;
    if (!creds) {
      return c.json({ error: 'Spotify not connected' }, 401);
    }

    try {
      const client = new SpotifyClient(creds, async (newCreds) => {
        await storage.saveCredentials('spotify', newCreds as unknown as Record<string, unknown>);
      });

      const stats = await client.getStats();
      return c.json(stats);
    } catch (error) {
      logger.error(`Failed to get Spotify stats: ${error}`);
      return c.json({ error: String(error) }, 500);
    }
  });

  // Qobuz stats
  app.get('/qobuz/stats', async (c) => {
    const creds = await storage.getCredentials('qobuz') as { user_auth_token: string } | null;
    if (!creds) {
      return c.json({ error: 'Qobuz not connected' }, 401);
    }

    try {
      const client = new QobuzClient(creds.user_auth_token);
      const stats = await client.getStats();
      return c.json(stats);
    } catch (error) {
      logger.error(`Failed to get Qobuz stats: ${error}`);
      return c.json({ error: String(error) }, 500);
    }
  });

  // Add track to Qobuz favorites
  app.post('/qobuz/favorite', async (c) => {
    const creds = await storage.getCredentials('qobuz') as { user_auth_token: string } | null;
    if (!creds) {
      return c.json({ error: 'Qobuz not connected' }, 401);
    }

    const body = await c.req.parseBody();
    const qobuzId = body.qobuz_id as string;
    const spotifyId = body.spotify_id as string | undefined;

    if (!qobuzId) {
      return c.json({ error: 'Missing qobuz_id' }, 400);
    }

    const qobuzIdNum = parseInt(qobuzId, 10);
    if (isNaN(qobuzIdNum) || qobuzIdNum <= 0) {
      return c.json({ error: 'Invalid qobuz_id: must be a positive integer' }, 400);
    }

    try {
      const client = new QobuzClient(creds.user_auth_token);
      const success = await client.addFavoriteTrack(qobuzIdNum);

      if (success && spotifyId) {
        // Mark as synced and resolve unmatched
        await storage.markTrackSynced(spotifyId, qobuzId, 'favorites');
        await storage.resolveUnmatchedTrack(spotifyId, 'favorites', qobuzId, 'resolved');
      }

      return c.json({ success });
    } catch (error) {
      logger.error(`Failed to add favorite: ${error}`);
      return c.json({ error: String(error) }, 500);
    }
  });

  // Add album to Qobuz favorites
  app.post('/qobuz/favorite/album', async (c) => {
    const creds = await storage.getCredentials('qobuz') as { user_auth_token: string } | null;
    if (!creds) {
      return c.json({ error: 'Qobuz not connected' }, 401);
    }

    const body = await c.req.parseBody();
    const qobuzId = body.qobuz_id as string;
    const spotifyId = body.spotify_id as string | undefined;

    if (!qobuzId) {
      return c.json({ error: 'Missing qobuz_id' }, 400);
    }

    try {
      const client = new QobuzClient(creds.user_auth_token);
      const success = await client.addFavoriteAlbum(qobuzId);

      if (success && spotifyId) {
        await storage.markTrackSynced(spotifyId, qobuzId, 'albums');
        await storage.resolveUnmatchedTrack(spotifyId, 'albums', qobuzId, 'resolved');
      }

      return c.json({ success });
    } catch (error) {
      logger.error(`Failed to add favorite album: ${error}`);
      return c.json({ error: String(error) }, 500);
    }
  });

  // Get unmatched tracks
  app.get('/unmatched', async (c) => {
    const syncType = c.req.query('sync_type');
    const status = c.req.query('status') || 'pending';
    // Validate and clamp limit/offset to prevent abuse
    const limit = Math.min(Math.max(1, parseInt(c.req.query('limit') || '100', 10) || 100), 500);
    const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10) || 0);

    const tracks = await storage.getUnmatchedTracks(syncType, status, limit, offset);
    const total = await storage.getUnmatchedCount(syncType, status);

    return c.json({ tracks, total, limit, offset });
  });

  // Resolve unmatched track
  app.post('/unmatched/:spotifyId/resolve', async (c) => {
    const spotifyId = c.req.param('spotifyId');
    const body = await c.req.parseBody();
    const qobuzId = body.qobuz_id as string;
    const syncType = (body.sync_type as string) || 'favorites';

    if (!qobuzId) {
      return c.json({ error: 'Missing qobuz_id' }, 400);
    }

    // Validate qobuz_id for track resolution (albums can have string IDs)
    if (syncType !== 'albums') {
      const qobuzIdNum = parseInt(qobuzId, 10);
      if (isNaN(qobuzIdNum) || qobuzIdNum <= 0) {
        return c.json({ error: 'Invalid qobuz_id: must be a positive integer' }, 400);
      }
    }

    // Add to Qobuz favorites
    const creds = await storage.getCredentials('qobuz') as { user_auth_token: string } | null;
    if (creds) {
      const client = new QobuzClient(creds.user_auth_token);
      if (syncType === 'albums') {
        await client.addFavoriteAlbum(qobuzId);
      } else {
        await client.addFavoriteTrack(parseInt(qobuzId, 10));
      }
    }

    await storage.markTrackSynced(spotifyId, qobuzId, syncType);
    await storage.resolveUnmatchedTrack(spotifyId, syncType, qobuzId);

    return c.json({ success: true });
  });

  // Dismiss unmatched track
  app.post('/unmatched/:spotifyId/dismiss', async (c) => {
    const spotifyId = c.req.param('spotifyId');
    const syncType = c.req.query('sync_type') || 'favorites';

    await storage.dismissUnmatchedTrack(spotifyId, syncType);
    return c.json({ success: true });
  });

  // Get Spotify playlists
  app.get('/spotify/playlists', async (c) => {
    const creds = await storage.getCredentials('spotify') as SpotifyCredentials | null;
    if (!creds) {
      return c.json({ error: 'Spotify not connected' }, 401);
    }

    try {
      const client = new SpotifyClient(creds, async (newCreds) => {
        await storage.saveCredentials('spotify', newCreds as unknown as Record<string, unknown>);
      });

      const playlists = await client.listPlaylists();
      return c.json({ playlists });
    } catch (error) {
      logger.error(`Failed to get playlists: ${error}`);
      return c.json({ error: String(error) }, 500);
    }
  });

  // Get migrations/history
  app.get('/migrations', async (c) => {
    // Validate and clamp limit
    const limit = Math.min(Math.max(1, parseInt(c.req.query('limit') || '20', 10) || 20), 100);
    const migrations = await storage.getMigrations(limit);
    return c.json({ migrations });
  });

  return app;
}
