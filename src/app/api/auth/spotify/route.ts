/**
 * Spotify OAuth start route.
 */

import { redirect } from 'next/navigation';
import { randomBytes } from 'crypto';
import { ensureDbInitialized, getBaseUrl } from '@/lib/api-helpers';
import { SpotifyClient } from '@/lib/services/spotify';

export async function GET(request: Request) {
  const storage = await ensureDbInitialized();

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) {
    redirect('/?error=missing_spotify_config');
  }

  const baseUrl = getBaseUrl(request);
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI || `${baseUrl}/api/auth/spotify/callback`;

  // Generate and store state in database
  const state = randomBytes(16).toString('hex');
  await storage.saveOAuthState(state, redirectUri);

  const authUrl = SpotifyClient.getAuthUrl(clientId, redirectUri, state);
  redirect(authUrl);
}
