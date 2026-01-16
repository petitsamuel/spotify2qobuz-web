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

// Database initialization state
let dbInitialized = false;
let dbInitError: Error | null = null;

// Initialize database with proper error handling
const dbReady = (async () => {
  try {
    await storage.initDb();
    await storage.cleanupStaleTasks();
    dbInitialized = true;
    logger.info('Database initialization complete');
  } catch (error) {
    dbInitError = error as Error;
    logger.error(`Database initialization failed: ${error}`);
    // In production, we might want to exit; for now, log and continue
    // so developers can see the error via health check
  }
})();

// Create Hono app
const app = new Hono();

// Middleware
app.use('*', honoLogger());

// Database readiness middleware - block requests if DB failed to initialize
app.use('*', async (c, next) => {
  // Allow health check and static files through always
  if (c.req.path === '/health' || c.req.path.startsWith('/static/')) {
    return next();
  }

  // If database initialization failed, return 503
  if (dbInitError) {
    logger.error(`Request blocked due to database error: ${c.req.path}`);
    return c.json({
      error: 'Service unavailable',
      message: 'Database initialization failed. Please check server logs.',
    }, 503);
  }

  // If still initializing, wait briefly then check again
  if (!dbInitialized) {
    // Wait up to 10 seconds for initialization
    const maxWait = 10000;
    const checkInterval = 100;
    let waited = 0;

    while (!dbInitialized && !dbInitError && waited < maxWait) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      waited += checkInterval;
    }

    if (dbInitError) {
      return c.json({
        error: 'Service unavailable',
        message: 'Database initialization failed. Please check server logs.',
      }, 503);
    }

    if (!dbInitialized) {
      return c.json({
        error: 'Service starting',
        message: 'Database is still initializing. Please retry shortly.',
      }, 503);
    }
  }

  return next();
});

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
    logger.error(`Template not found: ${templatePath}`);
    throw new Error(`Template not found: ${name}`);
  }
  const template = readFileSync(templatePath, 'utf-8');
  return ejs.render(template, data, { filename: templatePath });
}

// Global error handler for unhandled errors
app.onError((err, c) => {
  logger.error(`Unhandled error: ${err.message}`);
  return c.html(`
    <!DOCTYPE html>
    <html>
    <head><title>Error</title></head>
    <body style="font-family: system-ui; padding: 2rem; background: #1a1a2e; color: #eee;">
      <h1>Something went wrong</h1>
      <p>${err.message}</p>
      <a href="/" style="color: #6366f1;">Go back home</a>
    </body>
    </html>
  `, 500);
});

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

// Health check with database status
app.get('/health', async (c) => {
  // Wait for db init to complete (with timeout)
  const timeout = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), 5000)
  );

  try {
    await Promise.race([dbReady, timeout]);
  } catch (error) {
    // Log timeout/error but continue to report current status
    const message = error instanceof Error ? error.message : 'unknown error';
    logger.debug(`Health check db wait: ${message}`);
  }

  if (dbInitError) {
    return c.json({
      status: 'unhealthy',
      database: 'error',
      error: dbInitError.message,
    }, 503);
  }

  if (!dbInitialized) {
    return c.json({
      status: 'starting',
      database: 'initializing',
    }, 503);
  }

  return c.json({
    status: 'ok',
    database: 'connected',
  });
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
