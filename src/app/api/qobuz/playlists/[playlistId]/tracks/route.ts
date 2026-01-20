/**
 * Qobuz playlist tracks API route.
 */

import { ensureDbInitialized, getQobuzClient, getCurrentUserId, jsonError } from '@/lib/api-helpers';
import { logger } from '@/lib/logger';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ playlistId: string }> }
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return jsonError('Not authenticated', 401);
  }

  const storage = await ensureDbInitialized();
  const client = await getQobuzClient(storage, userId);

  if (!client) {
    return jsonError('Qobuz not connected', 401);
  }

  const { playlistId } = await params;

  try {
    const tracks = await client.getPlaylistTracksWithDetails(playlistId);
    return Response.json({ tracks });
  } catch (error) {
    logger.error(`Failed to get Qobuz playlist tracks: ${error}`);
    return jsonError(String(error), 500);
  }
}
