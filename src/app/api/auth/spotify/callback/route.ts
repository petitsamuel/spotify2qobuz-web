/**
 * Spotify OAuth callback route.
 */

import { redirect } from 'next/navigation';
import { NextRequest } from 'next/server';
import { ensureDbInitialized, setCurrentUserId } from '@/lib/api-helpers';
import { SpotifyClient } from '@/lib/services/spotify';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  const storage = await ensureDbInitialized();

  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) {
    logger.error(`Spotify OAuth error: ${error}`);
    redirect('/?error=spotify_auth_error');
  }

  if (!code || !state) {
    redirect('/?error=missing_oauth_params');
  }

  // Validate state from database
  const storedState = await storage.getOAuthState(state);
  if (!storedState) {
    redirect('/?error=invalid_state');
  }

  // Delete used state
  await storage.deleteOAuthState(state);

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    logger.error('Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET');
    redirect('/?error=missing_spotify_config');
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
    redirect('/?error=token_exchange_failed');
  }

  // Verify credentials work and get user ID
  let userId: string;
  try {
    const client = new SpotifyClient(credentials);
    const stats = await client.getStats();
    if (!stats.user_id) {
      logger.error('Spotify profile returned no user ID');
      redirect('/?error=credential_verification_failed');
    }
    userId = stats.user_id;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('Spotify credential verification failed', {
      message: error.message,
      stack: error.stack,
    });
    redirect('/?error=credential_verification_failed');
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
    redirect('/?error=credential_storage_failed');
  }

  // Set user session cookie
  await setCurrentUserId(userId);

  logger.info(`Spotify connected successfully for user ${userId}`);
  redirect('/?spotify_connected=true');
}
