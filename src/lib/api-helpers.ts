/**
 * API helper functions for route handlers.
 */

import { cookies } from 'next/headers';
import { Storage } from './db/storage';
import { SpotifyClient, SpotifyCredentials } from './services/spotify';
import { QobuzClient } from './services/qobuz';
import { QobuzCredentials } from './types';

// Cookie name for user session
export const USER_ID_COOKIE = 'spotify_user_id';

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
 * Get the current user ID from cookies.
 * Returns null if no user is logged in.
 */
export async function getCurrentUserId(): Promise<string | null> {
  const cookieStore = await cookies();
  const userId = cookieStore.get(USER_ID_COOKIE)?.value;
  return userId ?? null;
}

/**
 * Set the current user ID in a cookie.
 * Called after successful Spotify authentication.
 */
export async function setCurrentUserId(userId: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(USER_ID_COOKIE, userId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: '/',
  });
}

/**
 * Clear the current user session.
 */
export async function clearCurrentUserId(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(USER_ID_COOKIE);
}

/**
 * Get authenticated Spotify client if credentials exist.
 */
export async function getSpotifyClient(
  storage: Storage,
  userId: string,
  onTokenRefresh?: (creds: SpotifyCredentials) => Promise<void>
): Promise<SpotifyClient | null> {
  const creds = await storage.getCredentials(userId, 'spotify') as SpotifyCredentials | null;
  if (!creds) return null;

  return new SpotifyClient(creds, async (newCreds) => {
    await storage.saveCredentials(userId, 'spotify', newCreds as unknown as Record<string, unknown>);
    if (onTokenRefresh) {
      await onTokenRefresh(newCreds);
    }
  });
}

/**
 * Get authenticated Qobuz client if credentials exist.
 */
export async function getQobuzClient(storage: Storage, userId: string): Promise<QobuzClient | null> {
  const creds = await storage.getCredentials(userId, 'qobuz') as QobuzCredentials | null;
  if (!creds) return null;

  return new QobuzClient(creds.user_auth_token);
}

/**
 * Get both clients for sync operations.
 */
export async function getBothClients(storage: Storage, userId: string): Promise<{
  spotify: SpotifyClient;
  qobuz: QobuzClient;
} | null> {
  const spotify = await getSpotifyClient(storage, userId);
  const qobuz = await getQobuzClient(storage, userId);

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
