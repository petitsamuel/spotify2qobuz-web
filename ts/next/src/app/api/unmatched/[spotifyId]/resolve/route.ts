/**
 * Resolve unmatched track API route.
 */

import { NextRequest } from 'next/server';
import { ensureDbInitialized, getQobuzClient, jsonError } from '@/lib/api-helpers';
import { logger } from '@/lib/logger';
import { isValidSpotifyId, isValidQobuzTrackId, isValidQobuzAlbumId } from '@/lib/types';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ spotifyId: string }> }
) {
  const { spotifyId } = await params;
  const storage = await ensureDbInitialized();

  // Validate spotifyId
  if (!isValidSpotifyId(spotifyId)) {
    return jsonError('Invalid spotifyId format', 400);
  }

  const formData = await request.formData();
  const qobuzId = formData.get('qobuz_id') as string;
  const syncType = (formData.get('sync_type') as string) || 'favorites';

  if (!qobuzId) {
    return jsonError('Missing qobuz_id', 400);
  }

  // Validate qobuz_id based on sync type
  if (syncType !== 'albums') {
    if (!isValidQobuzTrackId(qobuzId)) {
      return jsonError('Invalid qobuz_id: must be a positive integer', 400);
    }
  } else {
    if (!isValidQobuzAlbumId(qobuzId)) {
      return jsonError('Invalid qobuz_id: must be a positive integer string', 400);
    }
  }

  try {
    // Add to Qobuz favorites
    const client = await getQobuzClient(storage);
    if (client) {
      if (syncType === 'albums') {
        await client.addFavoriteAlbum(qobuzId);
      } else {
        await client.addFavoriteTrack(parseInt(qobuzId, 10));
      }
    }

    await storage.markTrackSynced(spotifyId, qobuzId, syncType);
    await storage.resolveUnmatchedTrack(spotifyId, syncType, qobuzId);

    return Response.json({ success: true });
  } catch (error) {
    logger.error(`Failed to resolve track ${spotifyId}: ${error}`);
    return jsonError(String(error), 500);
  }
}
