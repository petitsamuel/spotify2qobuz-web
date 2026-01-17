/**
 * Spotify stats API route.
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
    const stats = await client.getStats();
    return Response.json(stats);
  } catch (error) {
    logger.error(`Failed to get Spotify stats: ${error}`);
    return jsonError(String(error), 500);
  }
}
