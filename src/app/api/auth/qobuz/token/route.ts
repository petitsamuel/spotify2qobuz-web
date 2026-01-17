/**
 * Qobuz token submission route.
 */

import { NextRequest } from 'next/server';
import { ensureDbInitialized, getCurrentUserId, jsonError } from '@/lib/api-helpers';
import { QobuzClient } from '@/lib/services/qobuz';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return jsonError('Not authenticated - connect Spotify first', 401);
  }

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

    // Save credentials for this user
    await storage.saveCredentials(userId, 'qobuz', { user_auth_token: token });

    logger.info(`Qobuz connected successfully for user ${userId}`);
    return Response.json({ success: true });
  } catch (err) {
    logger.error(`Qobuz authentication failed: ${err}`);
    return jsonError('Authentication failed - invalid token', 401);
  }
}
