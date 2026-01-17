/**
 * Disconnect Spotify route.
 */

import { redirect } from 'next/navigation';
import { ensureDbInitialized, getCurrentUserId, clearCurrentUserId } from '@/lib/api-helpers';
import { logger } from '@/lib/logger';

export async function POST() {
  const userId = await getCurrentUserId();
  if (!userId) {
    redirect('/?error=not_authenticated');
  }

  const storage = await ensureDbInitialized();
  await storage.deleteCredentials(userId, 'spotify');
  await clearCurrentUserId();
  logger.info(`Spotify disconnected for user ${userId}`);
  redirect('/');
}
