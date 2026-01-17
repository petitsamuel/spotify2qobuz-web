/**
 * Resolve unmatched track API route.
 */

import { NextRequest } from 'next/server';
import { ensureDbInitialized, getQobuzClient, getCurrentUserId, jsonError } from '@/lib/api-helpers';
import { logger } from '@/lib/logger';
import { isValidSpotifyId, isValidQobuzTrackId, isValidQobuzAlbumId } from '@/lib/types';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ spotifyId: string }> }
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return jsonError('Not authenticated', 401);
  }

  const { spotifyId } = await params;

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
    const storage = await ensureDbInitialized();

    // Get Qobuz client - fail if not connected
    const client = await getQobuzClient(storage, userId);
    if (!client) {
      return jsonError('Qobuz not connected', 401);
    }

    // Add to Qobuz favorites
    if (syncType === 'albums') {
      await client.addFavoriteAlbum(qobuzId);
    } else {
      await client.addFavoriteTrack(parseInt(qobuzId, 10));
    }

    // Only mark as synced after successfully adding to Qobuz
    await storage.markTrackSynced(userId, spotifyId, qobuzId, syncType);
    await storage.resolveUnmatchedTrack(userId, spotifyId, syncType, qobuzId);

    return Response.json({ success: true });
  } catch (error) {
    logger.error(`Failed to resolve track ${spotifyId}: ${error}`);
    return jsonError('Failed to resolve track', 500);
  }
}
