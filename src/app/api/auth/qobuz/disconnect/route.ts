/**
 * Disconnect Qobuz route.
 *
 * Uses NextResponse.redirect() for proper HTTP redirect handling on mobile browsers.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuthAndErrorHandling } from '@/lib/api-helpers';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  return withAuthAndErrorHandling(request, async (userId, storage, baseUrl) => {
    try {
      await storage.deleteCredentials(userId, 'qobuz');
      logger.info(`Qobuz disconnected for user ${userId}`);
      return NextResponse.redirect(new URL('/', baseUrl));
    } catch (error) {
      logger.error('Failed to delete Qobuz credentials', {
        error,
        userId,
        service: 'qobuz',
        stack: error instanceof Error ? error.stack : undefined,
      });
      return NextResponse.redirect(new URL('/?error=disconnect_failed', baseUrl));
    }
  });
}
