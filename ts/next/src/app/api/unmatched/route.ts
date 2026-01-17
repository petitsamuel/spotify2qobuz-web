/**
 * Unmatched tracks API route.
 */

import { NextRequest } from 'next/server';
import { ensureDbInitialized } from '@/lib/api-helpers';

export async function GET(request: NextRequest) {
  const storage = await ensureDbInitialized();

  const searchParams = request.nextUrl.searchParams;
  const syncType = searchParams.get('sync_type') || undefined;
  const status = searchParams.get('status') || 'pending';
  const limitParam = searchParams.get('limit') || '100';
  const offsetParam = searchParams.get('offset') || '0';

  const limit = Math.min(Math.max(1, parseInt(limitParam, 10) || 100), 500);
  const offset = Math.max(0, parseInt(offsetParam, 10) || 0);

  const tracks = await storage.getUnmatchedTracks(syncType, status, limit, offset);
  const total = await storage.getUnmatchedCount(syncType, status);

  return Response.json({ tracks, total, limit, offset });
}
