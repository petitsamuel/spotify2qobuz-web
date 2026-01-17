/**
 * Qobuz token submission route.
 */

import { redirect } from 'next/navigation';
import { NextRequest } from 'next/server';
import { ensureDbInitialized } from '@/lib/api-helpers';
import { QobuzClient } from '@/lib/services/qobuz';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  const storage = await ensureDbInitialized();

  const formData = await request.formData();
  const token = formData.get('token') as string;

  if (!token) {
    redirect('/auth/qobuz?error=missing_token');
  }

  try {
    // Validate the token
    const client = new QobuzClient(token);
    await client.authenticate();

    // Save credentials
    await storage.saveCredentials('qobuz', { user_auth_token: token });

    logger.info('Qobuz connected successfully');
    redirect('/?qobuz_connected=true');
  } catch (err) {
    logger.error(`Qobuz authentication failed: ${err}`);
    redirect('/auth/qobuz?error=auth_failed');
  }
}
