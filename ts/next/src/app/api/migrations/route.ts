/**
 * Migrations/history API route.
 */

import { NextRequest } from 'next/server';
import { ensureDbInitialized } from '@/lib/api-helpers';

export async function GET(request: NextRequest) {
  const storage = await ensureDbInitialized();

  const searchParams = request.nextUrl.searchParams;
  const limitParam = searchParams.get('limit') || '20';
  const limit = Math.min(Math.max(1, parseInt(limitParam, 10) || 20), 100);

  const migrations = await storage.getMigrations(limit);
  return Response.json({ migrations });
}
