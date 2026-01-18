/**
 * Disconnect Qobuz route.
 *
 * Uses NextResponse.redirect() for proper HTTP redirect handling on mobile browsers.
 */

import { NextRequest, NextResponse } from 'next/server';
import { ensureDbInitialized, getCurrentUserId, getBaseUrl } from '@/lib/api-helpers';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  const baseUrl = getBaseUrl(request);

  try {
    const userId = await getCurrentUserId();

    if (!userId) {
      return NextResponse.redirect(new URL('/?error=not_authenticated', baseUrl));
    }

    const storage = await ensureDbInitialized();
    await storage.deleteCredentials(userId, 'qobuz');
    logger.info(`Qobuz disconnected for user ${userId}`);
    return NextResponse.redirect(new URL('/', baseUrl));
  } catch (error) {
    logger.error(`Failed to disconnect Qobuz: ${error}`);
    return NextResponse.redirect(new URL('/?error=disconnect_failed', baseUrl));
  }
}
