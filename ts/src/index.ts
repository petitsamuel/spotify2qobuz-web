/**
 * Main entry point for the Spotify2Qobuz web application.
 */

import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { logger as honoLogger } from 'hono/logger';
import { Storage } from './db/storage';
import { createAuthRoutes } from './routes/auth';
import { createSyncRoutes } from './routes/sync';
import { createApiRoutes } from './routes/api';
import { logger } from './lib/logger';
import { SpotifyCredentials } from './services/spotify';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import ejs from 'ejs';

// Initialize storage
const storage = new Storage();

// Initialize database (async, runs at startup)
(async () => {
  await storage.initDb();
  await storage.cleanupStaleTasks();
})();

// Create Hono app
const app = new Hono();

// Middleware
app.use('*', honoLogger());

// Static files
app.use('/static/*', serveStatic({ root: './' }));

// Mount routes
app.route('/auth', createAuthRoutes(storage));
app.route('/sync', createSyncRoutes(storage));
app.route('/api', createApiRoutes(storage));

// Helper to check auth status
async function getAuthStatus(storage: Storage): Promise<{ spotify: boolean; qobuz: boolean; both_connected: boolean }> {
  const spotify = await storage.hasCredentials('spotify');
  const qobuz = await storage.hasCredentials('qobuz');
  return { spotify, qobuz, both_connected: spotify && qobuz };
}

// Template rendering helper
function renderTemplate(name: string, data: Record<string, unknown>): string {
  const templatePath = join(import.meta.dir, '..', 'views', `${name}.ejs`);
  if (!existsSync(templatePath)) {
    return `Template not found: ${name}`;
  }
  const template = readFileSync(templatePath, 'utf-8');
  return ejs.render(template, data, { filename: templatePath });
}

// Page routes
app.get('/', async (c) => {
  const authStatus = await getAuthStatus(storage);
  const migrations = await storage.getMigrations(5);

  const html = renderTemplate('index', {
    auth_status: authStatus,
    migrations,
  });

  return c.html(html);
});

app.get('/playlists', async (c) => {
  const authStatus = await getAuthStatus(storage);
  if (!authStatus.spotify) {
    return c.redirect('/');
  }

  const html = renderTemplate('playlists', {
    auth_status: authStatus,
  });

  return c.html(html);
});

app.get('/compare', async (c) => {
  const authStatus = await getAuthStatus(storage);
  if (!authStatus.both_connected) {
    return c.redirect('/');
  }

  const html = renderTemplate('compare', {
    auth_status: authStatus,
  });

  return c.html(html);
});

app.get('/history', async (c) => {
  const authStatus = await getAuthStatus(storage);
  const migrations = await storage.getMigrations(50);

  const html = renderTemplate('history', {
    auth_status: authStatus,
    migrations,
  });

  return c.html(html);
});

app.get('/review', async (c) => {
  const authStatus = await getAuthStatus(storage);

  const html = renderTemplate('review', {
    auth_status: authStatus,
  });

  return c.html(html);
});

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

// Start server
const port = parseInt(process.env.PORT || '8000');

logger.info(`Starting server on port ${port}...`);
logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);

export default {
  port,
  fetch: app.fetch,
};

// Also export for direct Bun usage
console.log(`Server running at http://localhost:${port}`);
