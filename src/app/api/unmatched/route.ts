/**
 * Unmatched tracks API route.
 */

import { NextRequest } from 'next/server';
import { ensureDbInitialized, getCurrentUserId, jsonError } from '@/lib/api-helpers';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return jsonError('Not authenticated', 401);
  }

  const searchParams = request.nextUrl.searchParams;
  const syncType = searchParams.get('sync_type') || undefined;
  const status = searchParams.get('status') || 'pending';
  const limitParam = searchParams.get('limit') || '100';
  const offsetParam = searchParams.get('offset') || '0';

  const limit = Math.min(Math.max(1, parseInt(limitParam, 10) || 100), 500);
  const offset = Math.max(0, parseInt(offsetParam, 10) || 0);

  try {
    const storage = await ensureDbInitialized();
    const tracks = await storage.getUnmatchedTracks(userId, syncType, status, limit, offset);
    const total = await storage.getUnmatchedCount(userId, syncType, status);

    return Response.json({ tracks, total, limit, offset });
  } catch (error) {
    logger.error(`Failed to fetch unmatched tracks: ${error}`);
    return jsonError('Failed to fetch unmatched tracks', 500);
  }
}
