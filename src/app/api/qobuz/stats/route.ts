/**
 * Qobuz stats API route.
 */

import { ensureDbInitialized, getQobuzClient, jsonError } from '@/lib/api-helpers';
import { logger } from '@/lib/logger';

export async function GET() {
  const storage = await ensureDbInitialized();
  const client = await getQobuzClient(storage);

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
