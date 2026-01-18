/**
 * Spotify OAuth start route.
 */

import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { ensureDbInitialized, getBaseUrl } from '@/lib/api-helpers';
import { SpotifyClient } from '@/lib/services/spotify';
import { logger } from '@/lib/logger';

export async function GET(request: Request) {
  const baseUrl = getBaseUrl(request);

  try {
    const storage = await ensureDbInitialized();

    const clientId = process.env.SPOTIFY_CLIENT_ID;
    if (!clientId) {
      logger.error('Spotify OAuth attempted but SPOTIFY_CLIENT_ID not configured');
      return NextResponse.redirect(new URL('/?error=missing_spotify_config', baseUrl));
    }

    const redirectUri = process.env.SPOTIFY_REDIRECT_URI || `${baseUrl}/api/auth/spotify/callback`;

    // Generate and store state in database
    const state = randomBytes(16).toString('hex');
    await storage.saveOAuthState(state, redirectUri);

    const authUrl = SpotifyClient.getAuthUrl(clientId, redirectUri, state);
    return NextResponse.redirect(authUrl);
  } catch (error) {
    logger.error('Failed to start Spotify OAuth', {
      error,
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.redirect(new URL('/?error=oauth_failed', baseUrl));
  }
}
