/**
 * Add track/album to Qobuz favorites.
 */

import { NextRequest } from 'next/server';
import { ensureDbInitialized, getQobuzClient, jsonError } from '@/lib/api-helpers';
import { logger } from '@/lib/logger';
import { isValidQobuzTrackId, isValidQobuzAlbumId } from '@/lib/types';

export async function POST(request: NextRequest) {
  const storage = await ensureDbInitialized();
  const client = await getQobuzClient(storage);

  if (!client) {
    return jsonError('Qobuz not connected', 401);
  }

  const formData = await request.formData();
  const qobuzId = formData.get('qobuz_id') as string;
  const spotifyId = formData.get('spotify_id') as string | undefined;
  const isAlbum = formData.get('is_album') === 'true';

  if (!qobuzId) {
    return jsonError('Missing qobuz_id', 400);
  }

  if (isAlbum) {
    if (!isValidQobuzAlbumId(qobuzId)) {
      return jsonError('Invalid qobuz_id: must be a positive integer string', 400);
    }
  } else {
    if (!isValidQobuzTrackId(qobuzId)) {
      return jsonError('Invalid qobuz_id: must be a positive integer', 400);
    }
  }

  try {
    if (isAlbum) {
      await client.addFavoriteAlbum(qobuzId);
    } else {
      await client.addFavoriteTrack(parseInt(qobuzId, 10));
    }

    if (spotifyId) {
      const syncType = isAlbum ? 'albums' : 'favorites';
      await storage.markTrackSynced(spotifyId, qobuzId, syncType);
      await storage.resolveUnmatchedTrack(spotifyId, syncType, qobuzId, 'resolved');
    }

    return Response.json({ success: true });
  } catch (error) {
    logger.error(`Failed to add favorite: ${error}`);
    return jsonError(String(error), 500);
  }
}
