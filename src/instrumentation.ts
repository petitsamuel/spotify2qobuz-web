/**
 * Next.js Instrumentation Hook
 *
 * This file runs once when the Next.js server starts.
 * Used to run database migrations before handling requests.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only run migrations on the server (not during build or on edge)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { runMigrations } = await import('./lib/db/migrator');

    try {
      console.log('[instrumentation] Running database migrations...');
      await runMigrations();
      console.log('[instrumentation] Database migrations complete');
    } catch (error) {
      console.error('[instrumentation] Database migration failed:', error);
      // Don't throw - let the app start anyway
      // Individual requests will fail if DB is misconfigured
    }
  }
}
