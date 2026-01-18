/**
 * Spotify OAuth start route.
 */

import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { ensureDbInitialized, getBaseUrl } from '@/lib/api-helpers';
import { SpotifyClient } from '@/lib/services/spotify';
import { logger } from '@/lib/logger';

export async function GET(request: Request) {
  try {
    const storage = await ensureDbInitialized();
    const baseUrl = getBaseUrl(request);

    const clientId = process.env.SPOTIFY_CLIENT_ID;
    if (!clientId) {
      return NextResponse.redirect(new URL('/?error=missing_spotify_config', baseUrl));
    }

    const redirectUri = process.env.SPOTIFY_REDIRECT_URI || `${baseUrl}/api/auth/spotify/callback`;

    // Generate and store state in database
    const state = randomBytes(16).toString('hex');
    await storage.saveOAuthState(state, redirectUri);

    const authUrl = SpotifyClient.getAuthUrl(clientId, redirectUri, state);
    return NextResponse.redirect(authUrl);
  } catch (error) {
    logger.error(`Failed to start Spotify OAuth: ${error}`);
    const baseUrl = getBaseUrl(request);
    return NextResponse.redirect(new URL('/?error=oauth_failed', baseUrl));
  }
}
