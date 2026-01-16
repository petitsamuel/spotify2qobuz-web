/**
 * Authentication routes for Spotify and Qobuz OAuth.
 */

import { Hono } from 'hono';
import { randomBytes } from 'crypto';
import { Storage } from '../db/storage';
import { SpotifyClient, SpotifyCredentials } from '../services/spotify';
import { QobuzClient } from '../services/qobuz';
import { logger } from '../lib/logger';

// In-memory state storage for OAuth
const spotifyOAuthState = new Map<string, string>();

export function createAuthRoutes(storage: Storage): Hono {
  const app = new Hono();

  // Spotify OAuth start
  app.get('/spotify', (c) => {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const redirectUri = process.env.SPOTIFY_REDIRECT_URI || `${getBaseUrl(c)}/auth/spotify/callback`;

    if (!clientId) {
      return c.redirect('/?error=missing_spotify_config');
    }

    const state = randomBytes(16).toString('hex');
    spotifyOAuthState.set(state, redirectUri);

    // Clean up old states after 10 minutes
    setTimeout(() => spotifyOAuthState.delete(state), 10 * 60 * 1000);

    const authUrl = SpotifyClient.getAuthUrl(clientId, redirectUri, state);
    return c.redirect(authUrl);
  });

  // Spotify OAuth callback
  app.get('/spotify/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');

    if (error) {
      logger.error(`Spotify OAuth error: ${error}`);
      return c.redirect(`/?error=spotify_auth_failed&message=${error}`);
    }

    if (!code || !state) {
      return c.redirect('/?error=missing_oauth_params');
    }

    const redirectUri = spotifyOAuthState.get(state);
    if (!redirectUri) {
      return c.redirect('/?error=invalid_state');
    }
    spotifyOAuthState.delete(state);

    try {
      const clientId = process.env.SPOTIFY_CLIENT_ID!;
      const clientSecret = process.env.SPOTIFY_CLIENT_SECRET!;

      const credentials = await SpotifyClient.exchangeCode(code, clientId, clientSecret, redirectUri);

      // Verify the credentials work
      const client = new SpotifyClient(credentials);
      await client.getStats();

      // Save credentials
      storage.saveCredentials('spotify', credentials as unknown as Record<string, unknown>);

      logger.info('Spotify connected successfully');
      return c.redirect('/?spotify_connected=true');
    } catch (err) {
      logger.error(`Spotify token exchange failed: ${err}`);
      return c.redirect(`/?error=token_exchange_failed&message=${encodeURIComponent(String(err))}`);
    }
  });

  // Qobuz auth page (shows token input form)
  app.get('/qobuz', async (c) => {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect Qobuz</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-900 text-gray-100 min-h-screen flex items-center justify-center">
  <div class="max-w-xl w-full mx-4">
    <div class="bg-gray-800 rounded-lg p-6 border border-gray-700">
      <h1 class="text-2xl font-bold mb-4">Connect Qobuz</h1>

      <div class="bg-blue-900/30 border border-blue-600/50 rounded-lg p-4 mb-6">
        <h2 class="font-semibold text-blue-400 mb-2">How to get your Qobuz token:</h2>
        <ol class="text-sm text-gray-300 space-y-2 list-decimal list-inside">
          <li>Go to <a href="https://play.qobuz.com" target="_blank" class="text-blue-400 hover:underline">play.qobuz.com</a> and log in</li>
          <li>Open DevTools (F12 or Cmd+Option+I)</li>
          <li>Go to Application > Cookies > qobuz.com</li>
          <li>Find the cookie named <code class="bg-gray-700 px-1 rounded">x-user-auth-token</code> or check Network requests for the header</li>
          <li>Copy the full token value</li>
        </ol>
      </div>

      <form action="/auth/qobuz/token" method="POST">
        <label class="block mb-4">
          <span class="text-sm text-gray-400">Qobuz Auth Token</span>
          <input type="text" name="token" required
            class="mt-1 block w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:ring-blue-500 focus:border-blue-500"
            placeholder="Paste your token here...">
        </label>
        <div class="flex gap-3">
          <button type="submit"
            class="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg font-semibold">
            Connect
          </button>
          <a href="/" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg">Cancel</a>
        </div>
      </form>
    </div>
  </div>
</body>
</html>
    `;
    return c.html(html);
  });

  // Qobuz token submission
  app.post('/qobuz/token', async (c) => {
    const body = await c.req.parseBody();
    const token = body.token as string;

    if (!token) {
      return c.redirect('/auth/qobuz?error=missing_token');
    }

    try {
      // Validate the token
      const client = new QobuzClient(token);
      await client.authenticate();

      // Save credentials
      storage.saveCredentials('qobuz', { user_auth_token: token });

      logger.info('Qobuz connected successfully');
      return c.redirect('/?qobuz_connected=true');
    } catch (err) {
      logger.error(`Qobuz authentication failed: ${err}`);
      return c.redirect(`/auth/qobuz?error=${encodeURIComponent(String(err))}`);
    }
  });

  // Disconnect Spotify
  app.post('/spotify/disconnect', (c) => {
    storage.deleteCredentials('spotify');
    logger.info('Spotify disconnected');
    return c.redirect('/');
  });

  // Disconnect Qobuz
  app.post('/qobuz/disconnect', (c) => {
    storage.deleteCredentials('qobuz');
    logger.info('Qobuz disconnected');
    return c.redirect('/');
  });

  return app;
}

function getBaseUrl(c: { req: { url: string } }): string {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}
