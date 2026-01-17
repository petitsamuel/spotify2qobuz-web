/**
 * Dismiss unmatched track API route.
 */

import { NextRequest } from 'next/server';
import { ensureDbInitialized, jsonError } from '@/lib/api-helpers';
import { isValidSpotifyId } from '@/lib/types';

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

  const searchParams = request.nextUrl.searchParams;
  const syncType = searchParams.get('sync_type') || 'favorites';

  await storage.dismissUnmatchedTrack(spotifyId, syncType);
  return Response.json({ success: true });
}
