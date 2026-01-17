/**
 * Qobuz stats API route.
 */

import { ensureDbInitialized, getQobuzClient, getCurrentUserId, jsonError } from '@/lib/api-helpers';
import { logger } from '@/lib/logger';

export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return jsonError('Not authenticated', 401);
  }

  const storage = await ensureDbInitialized();
  const client = await getQobuzClient(storage, userId);

  if (!client) {
    return jsonError('Qobuz not connected', 401);
  }

  try {
    const stats = await client.getStats();
    return Response.json(stats);
  } catch (error) {
    logger.error(`Failed to get Qobuz stats: ${error}`);
    return jsonError(String(error), 500);
  }
}
