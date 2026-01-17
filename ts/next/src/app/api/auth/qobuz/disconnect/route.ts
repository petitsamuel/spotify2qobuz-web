/**
 * Disconnect Qobuz route.
 */

import { redirect } from 'next/navigation';
import { ensureDbInitialized } from '@/lib/api-helpers';
import { logger } from '@/lib/logger';

export async function POST() {
  const storage = await ensureDbInitialized();
  await storage.deleteCredentials('qobuz');
  logger.info('Qobuz disconnected');
  redirect('/');
}
