/**
 * Disconnect Qobuz route.
 */

import { redirect } from 'next/navigation';
import { ensureDbInitialized, getCurrentUserId } from '@/lib/api-helpers';
import { logger } from '@/lib/logger';

export async function POST() {
  const userId = await getCurrentUserId();
  if (!userId) {
    redirect('/?error=not_authenticated');
  }

  const storage = await ensureDbInitialized();
  await storage.deleteCredentials(userId, 'qobuz');
  logger.info(`Qobuz disconnected for user ${userId}`);
  redirect('/');
}
