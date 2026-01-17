/**
 * Migrations/history API route.
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
  const limitParam = searchParams.get('limit') || '20';
  const limit = Math.min(Math.max(1, parseInt(limitParam, 10) || 20), 100);

  try {
    const storage = await ensureDbInitialized();
    const migrations = await storage.getMigrations(userId, limit);
    return Response.json({ migrations });
  } catch (error) {
    logger.error(`Failed to fetch migrations: ${error}`);
    return jsonError('Failed to fetch migrations', 500);
  }
}
