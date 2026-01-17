/**
 * Dismiss unmatched track API route.
 */

import { NextRequest } from 'next/server';
import { ensureDbInitialized, jsonError } from '@/lib/api-helpers';
import { isValidSpotifyId } from '@/lib/types';
import { logger } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ spotifyId: string }> }
) {
  const { spotifyId } = await params;

  // Validate spotifyId
  if (!isValidSpotifyId(spotifyId)) {
    return jsonError('Invalid spotifyId format', 400);
  }

  const searchParams = request.nextUrl.searchParams;
  const syncType = searchParams.get('sync_type') || 'favorites';

  try {
    const storage = await ensureDbInitialized();
    await storage.dismissUnmatchedTrack(spotifyId, syncType);
    return Response.json({ success: true });
  } catch (error) {
    logger.error(`Failed to dismiss track ${spotifyId}: ${error}`);
    return jsonError('Failed to dismiss track', 500);
  }
}
