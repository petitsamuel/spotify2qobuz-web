/**
 * Spotify OAuth callback route.
 *
 * Uses NextResponse.redirect() instead of next/navigation redirect()
 * for proper HTTP redirect handling on mobile browsers.
 */

import { NextRequest, NextResponse } from 'next/server';
import { ensureDbInitialized, getBaseUrl, USER_ID_COOKIE } from '@/lib/api-helpers';
import { SpotifyClient } from '@/lib/services/spotify';
import { logger } from '@/lib/logger';

/**
 * Create a redirect response with optional user ID cookie.
 */
function createRedirect(url: string, userId?: string): NextResponse {
  const response = NextResponse.redirect(url);

  if (userId) {
    response.cookies.set(USER_ID_COOKIE, userId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: '/',
    });
  }

  return response;
}

export async function GET(request: NextRequest) {
  const storage = await ensureDbInitialized();
  const baseUrl = getBaseUrl(request);

  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) {
    logger.error(`Spotify OAuth error: ${error}`);
    return createRedirect(`${baseUrl}/?error=spotify_auth_error`);
  }

  if (!code || !state) {
    return createRedirect(`${baseUrl}/?error=missing_oauth_params`);
  }

  // Validate state from database
  const storedState = await storage.getOAuthState(state);
  if (!storedState) {
    return createRedirect(`${baseUrl}/?error=invalid_state`);
  }

  // Delete used state
  await storage.deleteOAuthState(state);

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    logger.error('Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET');
    return createRedirect(`${baseUrl}/?error=missing_spotify_config`);
  }

  // Exchange code for credentials
  let credentials;
  try {
    credentials = await SpotifyClient.exchangeCode(
      code,
      clientId,
      clientSecret,
      storedState.redirect_uri
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('Spotify token exchange failed', {
      message: error.message,
      stack: error.stack,
    });
    return createRedirect(`${baseUrl}/?error=token_exchange_failed`);
  }

  // Verify credentials work and get user ID
  let userId: string;
  try {
    const client = new SpotifyClient(credentials);
    const stats = await client.getStats();
    if (!stats.user_id) {
      logger.error('Spotify profile returned no user ID');
      return createRedirect(`${baseUrl}/?error=credential_verification_failed`);
    }
    userId = stats.user_id;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('Spotify credential verification failed', {
      message: error.message,
      stack: error.stack,
    });
    return createRedirect(`${baseUrl}/?error=credential_verification_failed`);
  }

  // Save credentials to database with user ID
  try {
    await storage.saveCredentials(userId, 'spotify', credentials as unknown as Record<string, unknown>);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('Failed to save Spotify credentials', {
      message: error.message,
      stack: error.stack,
    });
    return createRedirect(`${baseUrl}/?error=credential_storage_failed`);
  }

  logger.info(`Spotify connected successfully for user ${userId}`);
  return createRedirect(`${baseUrl}/?spotify_connected=true`, userId);
}
