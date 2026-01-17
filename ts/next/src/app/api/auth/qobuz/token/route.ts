/**
 * Qobuz token submission route.
 */

import { NextRequest } from 'next/server';
import { ensureDbInitialized, jsonError } from '@/lib/api-helpers';
import { QobuzClient } from '@/lib/services/qobuz';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const token = formData.get('token') as string;

  if (!token) {
    return jsonError('Token is required', 400);
  }

  try {
    const storage = await ensureDbInitialized();

    // Validate the token
    const client = new QobuzClient(token);
    await client.authenticate();

    // Save credentials
    await storage.saveCredentials('qobuz', { user_auth_token: token });

    logger.info('Qobuz connected successfully');
    return Response.json({ success: true });
  } catch (err) {
    logger.error(`Qobuz authentication failed: ${err}`);
    return jsonError('Authentication failed - invalid token', 401);
  }
}
