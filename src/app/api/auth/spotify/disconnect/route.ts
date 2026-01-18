/**
 * Disconnect Spotify route.
 *
 * Uses NextResponse.redirect() for proper HTTP redirect handling on mobile browsers.
 */

import { NextRequest, NextResponse } from 'next/server';
import { ensureDbInitialized, getCurrentUserId, getBaseUrl, USER_ID_COOKIE } from '@/lib/api-helpers';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  const baseUrl = getBaseUrl(request);

  try {
    const userId = await getCurrentUserId();

    if (!userId) {
      return NextResponse.redirect(new URL('/?error=not_authenticated', baseUrl));
    }

    const storage = await ensureDbInitialized();
    await storage.deleteCredentials(userId, 'spotify');

    // Create redirect response and clear the user cookie
    const response = NextResponse.redirect(new URL('/', baseUrl));
    response.cookies.delete(USER_ID_COOKIE);

    logger.info(`Spotify disconnected for user ${userId}`);
    return response;
  } catch (error) {
    logger.error(`Failed to disconnect Spotify: ${error}`);
    return NextResponse.redirect(new URL('/?error=disconnect_failed', baseUrl));
  }
}
