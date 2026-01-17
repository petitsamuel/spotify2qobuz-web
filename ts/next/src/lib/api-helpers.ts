/**
 * API helper functions for route handlers.
 */

import { Storage } from './db/storage';
import { SpotifyClient, SpotifyCredentials } from './services/spotify';
import { QobuzClient } from './services/qobuz';
import { QobuzCredentials } from './types';

// Singleton storage instance
let storageInstance: Storage | null = null;

export function getStorage(): Storage {
  if (!storageInstance) {
    storageInstance = new Storage();
  }
  return storageInstance;
}

// Initialize database on first use
let dbInitialized = false;

export async function ensureDbInitialized(): Promise<Storage> {
  const storage = getStorage();
  if (!dbInitialized) {
    await storage.initDb();
    dbInitialized = true;
  }
  return storage;
}

/**
 * Get authenticated Spotify client if credentials exist.
 */
export async function getSpotifyClient(
  storage: Storage,
  onTokenRefresh?: (creds: SpotifyCredentials) => Promise<void>
): Promise<SpotifyClient | null> {
  const creds = await storage.getCredentials('spotify') as SpotifyCredentials | null;
  if (!creds) return null;

  return new SpotifyClient(creds, async (newCreds) => {
    await storage.saveCredentials('spotify', newCreds as unknown as Record<string, unknown>);
    if (onTokenRefresh) {
      await onTokenRefresh(newCreds);
    }
  });
}

/**
 * Get authenticated Qobuz client if credentials exist.
 */
export async function getQobuzClient(storage: Storage): Promise<QobuzClient | null> {
  const creds = await storage.getCredentials('qobuz') as QobuzCredentials | null;
  if (!creds) return null;

  return new QobuzClient(creds.user_auth_token);
}

/**
 * Get both clients for sync operations.
 */
export async function getBothClients(storage: Storage): Promise<{
  spotify: SpotifyClient;
  qobuz: QobuzClient;
} | null> {
  const spotify = await getSpotifyClient(storage);
  const qobuz = await getQobuzClient(storage);

  if (!spotify || !qobuz) {
    return null;
  }

  return { spotify, qobuz };
}

/**
 * Standard JSON error response.
 */
export function jsonError(message: string, status: number = 400): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Get base URL from request headers.
 */
export function getBaseUrl(request: Request): string {
  const host = request.headers.get('host') || 'localhost:3000';
  const protocol = request.headers.get('x-forwarded-proto') || 'http';
  return `${protocol}://${host}`;
}
