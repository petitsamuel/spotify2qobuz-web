/**
 * Spotify playlists API route.
 */

import { ensureDbInitialized, getSpotifyClient, jsonError } from '@/lib/api-helpers';
import { logger } from '@/lib/logger';

export async function GET() {
  const storage = await ensureDbInitialized();
  const client = await getSpotifyClient(storage);

  if (!client) {
    return jsonError('Spotify not connected', 401);
  }

  try {
    const playlists = await client.listPlaylists();
    return Response.json({ playlists });
  } catch (error) {
    logger.error(`Failed to get playlists: ${error}`);
    return jsonError(String(error), 500);
  }
}
