/**
 * Spotify OAuth callback route.
 */

import { redirect } from 'next/navigation';
import { NextRequest } from 'next/server';
import { ensureDbInitialized } from '@/lib/api-helpers';
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

  // Exchange code and save credentials - capture any error to redirect after try/catch
  let exchangeError: Error | null = null;
  try {
    const credentials = await SpotifyClient.exchangeCode(
      code,
      clientId,
      clientSecret,
      storedState.redirect_uri
    );

    // Verify the credentials work
    const client = new SpotifyClient(credentials);
    await client.getStats();

    // Save credentials
    await storage.saveCredentials('spotify', credentials as unknown as Record<string, unknown>);

    logger.info('Spotify connected successfully');
  } catch (err) {
    exchangeError = err instanceof Error ? err : new Error(String(err));
  }

  // Redirect outside try/catch to avoid catching NEXT_REDIRECT
  if (exchangeError) {
    logger.error(`Spotify token exchange failed: ${exchangeError}`);
    redirect('/?error=token_exchange_failed');
  }

  redirect('/?spotify_connected=true');
}
