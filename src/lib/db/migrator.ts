/**
 * Database migration runner.
 *
 * Uses versioned migrations with advisory locking for safe
 * multi-instance deployments on Vercel.
 */

import { neon } from '@neondatabase/serverless';
import { logger } from '../logger';

// Migration definition
interface Migration {
  version: number;
  name: string;
  up: string;
}

// All migrations in order
const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: `
      -- Credentials table
      CREATE TABLE IF NOT EXISTS credentials (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        service TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, service)
      );

      -- Migrations history table
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        status TEXT NOT NULL,
        migration_type TEXT NOT NULL,
        dry_run BOOLEAN DEFAULT FALSE,
        playlists_total INTEGER DEFAULT 0,
        playlists_synced INTEGER DEFAULT 0,
        tracks_matched INTEGER DEFAULT 0,
        tracks_not_matched INTEGER DEFAULT 0,
        isrc_matches INTEGER DEFAULT 0,
        fuzzy_matches INTEGER DEFAULT 0,
        report_json TEXT
      );

      -- Sync tasks table
      CREATE TABLE IF NOT EXISTS sync_tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        migration_id INTEGER REFERENCES migrations(id),
        status TEXT NOT NULL,
        progress_json TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Synced tracks with proper unique constraint
      CREATE TABLE IF NOT EXISTS synced_tracks (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        spotify_id TEXT NOT NULL,
        qobuz_id TEXT,
        sync_type TEXT NOT NULL,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, spotify_id, sync_type)
      );

      -- Sync progress table
      CREATE TABLE IF NOT EXISTS sync_progress (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        sync_type TEXT NOT NULL,
        last_offset INTEGER DEFAULT 0,
        total_tracks INTEGER DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, sync_type)
      );

      -- Unmatched tracks table
      CREATE TABLE IF NOT EXISTS unmatched_tracks (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        spotify_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT,
        sync_type TEXT NOT NULL,
        suggestions_json TEXT,
        status TEXT DEFAULT 'pending',
        resolved_qobuz_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, spotify_id, sync_type)
      );

      -- OAuth state table
      CREATE TABLE IF NOT EXISTS oauth_state (
        id TEXT PRIMARY KEY,
        redirect_uri TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );

      -- Active tasks table with chunk support
      CREATE TABLE IF NOT EXISTS active_tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        migration_id INTEGER REFERENCES migrations(id),
        sync_type TEXT NOT NULL,
        status TEXT NOT NULL,
        dry_run BOOLEAN DEFAULT FALSE,
        progress_json TEXT,
        error TEXT,
        report_json TEXT,
        chunk_state_json TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id);
      CREATE INDEX IF NOT EXISTS idx_migrations_user ON migrations(user_id);
      CREATE INDEX IF NOT EXISTS idx_sync_tasks_user ON sync_tasks(user_id);
      CREATE INDEX IF NOT EXISTS idx_synced_tracks_user ON synced_tracks(user_id);
      CREATE INDEX IF NOT EXISTS idx_synced_tracks_sync_type ON synced_tracks(sync_type);
      CREATE INDEX IF NOT EXISTS idx_unmatched_user ON unmatched_tracks(user_id);
      CREATE INDEX IF NOT EXISTS idx_unmatched_status ON unmatched_tracks(status);
      CREATE INDEX IF NOT EXISTS idx_migrations_started ON migrations(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_oauth_state_expires ON oauth_state(expires_at);
      CREATE INDEX IF NOT EXISTS idx_active_tasks_user ON active_tasks(user_id);
      CREATE INDEX IF NOT EXISTS idx_active_tasks_status ON active_tasks(status);
    `,
  },
  {
    version: 2,
    name: 'fix_synced_tracks_constraint',
    up: `
      -- Fix synced_tracks unique constraint if it exists with wrong columns
      -- This handles existing deployments that had UNIQUE(user_id, spotify_id)
      DO $$
      BEGIN
        -- Try to drop the old constraint if it exists
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'synced_tracks_user_id_spotify_id_key'
        ) THEN
          ALTER TABLE synced_tracks DROP CONSTRAINT synced_tracks_user_id_spotify_id_key;
        END IF;

        -- Add the correct constraint if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'synced_tracks_user_id_spotify_id_sync_type_key'
        ) THEN
          -- First, remove any duplicates that would violate the new constraint
          DELETE FROM synced_tracks a USING synced_tracks b
          WHERE a.id < b.id
            AND a.user_id = b.user_id
            AND a.spotify_id = b.spotify_id
            AND a.sync_type = b.sync_type;

          ALTER TABLE synced_tracks
            ADD CONSTRAINT synced_tracks_user_id_spotify_id_sync_type_key
            UNIQUE (user_id, spotify_id, sync_type);
        END IF;
      END $$;
    `,
  },
  {
    version: 3,
    name: 'add_chunk_state_column',
    up: `
      -- Add chunk_state_json column if it doesn't exist
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'active_tasks' AND column_name = 'chunk_state_json'
        ) THEN
          ALTER TABLE active_tasks ADD COLUMN chunk_state_json TEXT;
        END IF;
      END $$;
    `,
  },
  {
    version: 4,
    name: 'add_user_id_to_legacy_tables',
    up: `
      -- Add user_id column to tables that were created before multi-user support
      -- This migration handles databases that existed before user_id was added

      DO $$
      BEGIN
        -- Add user_id to credentials if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'credentials' AND column_name = 'user_id'
        ) THEN
          ALTER TABLE credentials ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy_user';
          -- Drop old unique constraint on service only (if exists)
          IF EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'credentials_service_key'
          ) THEN
            ALTER TABLE credentials DROP CONSTRAINT credentials_service_key;
          END IF;
          -- Add new unique constraint on (user_id, service)
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'credentials_user_id_service_key'
          ) THEN
            ALTER TABLE credentials ADD CONSTRAINT credentials_user_id_service_key UNIQUE (user_id, service);
          END IF;
        END IF;

        -- Add user_id to migrations table if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'migrations' AND column_name = 'user_id'
        ) THEN
          ALTER TABLE migrations ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy_user';
        END IF;

        -- Add user_id to sync_tasks if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'sync_tasks' AND column_name = 'user_id'
        ) THEN
          ALTER TABLE sync_tasks ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy_user';
        END IF;

        -- Add user_id to synced_tracks if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'synced_tracks' AND column_name = 'user_id'
        ) THEN
          ALTER TABLE synced_tracks ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy_user';
          -- Drop old unique constraint on (spotify_id) only if it exists
          IF EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'synced_tracks_spotify_id_key'
          ) THEN
            ALTER TABLE synced_tracks DROP CONSTRAINT synced_tracks_spotify_id_key;
          END IF;
          -- Add new unique constraint (will be handled by migration v2 if needed)
        END IF;

        -- Add user_id to sync_progress if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'sync_progress' AND column_name = 'user_id'
        ) THEN
          ALTER TABLE sync_progress ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy_user';
          -- Drop old unique constraint on (sync_type) only if it exists
          IF EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'sync_progress_sync_type_key'
          ) THEN
            ALTER TABLE sync_progress DROP CONSTRAINT sync_progress_sync_type_key;
          END IF;
          -- Add new unique constraint
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'sync_progress_user_id_sync_type_key'
          ) THEN
            ALTER TABLE sync_progress ADD CONSTRAINT sync_progress_user_id_sync_type_key UNIQUE (user_id, sync_type);
          END IF;
        END IF;

        -- Add user_id to unmatched_tracks if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'unmatched_tracks' AND column_name = 'user_id'
        ) THEN
          ALTER TABLE unmatched_tracks ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy_user';
          -- Drop old unique constraint on (spotify_id, sync_type) only if it exists
          IF EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'unmatched_tracks_spotify_id_sync_type_key'
          ) THEN
            ALTER TABLE unmatched_tracks DROP CONSTRAINT unmatched_tracks_spotify_id_sync_type_key;
          END IF;
          -- Add new unique constraint
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'unmatched_tracks_user_id_spotify_id_sync_type_key'
          ) THEN
            ALTER TABLE unmatched_tracks ADD CONSTRAINT unmatched_tracks_user_id_spotify_id_sync_type_key UNIQUE (user_id, spotify_id, sync_type);
          END IF;
        END IF;

        -- Add user_id to active_tasks if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'active_tasks' AND column_name = 'user_id'
        ) THEN
          ALTER TABLE active_tasks ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy_user';
        END IF;
      END $$;

      -- Create indexes (these will be created by initDb but adding here for completeness)
      CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id);
      CREATE INDEX IF NOT EXISTS idx_migrations_user ON migrations(user_id);
      CREATE INDEX IF NOT EXISTS idx_sync_tasks_user ON sync_tasks(user_id);
      CREATE INDEX IF NOT EXISTS idx_synced_tracks_user ON synced_tracks(user_id);
      CREATE INDEX IF NOT EXISTS idx_unmatched_user ON unmatched_tracks(user_id);
      CREATE INDEX IF NOT EXISTS idx_active_tasks_user ON active_tasks(user_id);
    `,
  },
];

/**
 * Run all pending migrations.
 * Uses advisory locks to prevent concurrent migration runs.
 */
export async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.warn('DATABASE_URL not set, skipping migrations');
    return;
  }

  const sql = neon(databaseUrl);

  try {
    // Create schema_versions table if it doesn't exist
    await sql`
      CREATE TABLE IF NOT EXISTS schema_versions (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Get advisory lock to prevent concurrent migrations
    // Using a fixed lock ID based on a hash of 'spotify2qobuz_migrations'
    const lockId = 1234567890;
    const lockResult = await sql`SELECT pg_try_advisory_lock(${lockId}) as acquired`;

    if (!lockResult[0]?.acquired) {
      logger.info('Another instance is running migrations, skipping');
      return;
    }

    try {
      // Get current schema version
      const versionResult = await sql`
        SELECT COALESCE(MAX(version), 0) as current_version FROM schema_versions
      `;
      const currentVersion = Number(versionResult[0]?.current_version || 0);

      logger.info(`Current schema version: ${currentVersion}`);

      // Run pending migrations
      const pendingMigrations = migrations.filter(m => m.version > currentVersion);

      if (pendingMigrations.length === 0) {
        logger.info('No pending migrations');
        return;
      }

      logger.info(`Running ${pendingMigrations.length} pending migration(s)`);

      for (const migration of pendingMigrations) {
        logger.info(`Running migration ${migration.version}: ${migration.name}`);

        try {
          // Run the migration SQL
          // Note: neon serverless driver executes each statement atomically
          // We use unsafe() for multi-statement migrations
          await sql.unsafe(migration.up);

          // Record the migration
          await sql`
            INSERT INTO schema_versions (version, name)
            VALUES (${migration.version}, ${migration.name})
          `;

          logger.info(`Migration ${migration.version} completed successfully`);
        } catch (error) {
          logger.error(`Migration ${migration.version} failed: ${error}`);
          throw error;
        }
      }

      logger.info('All migrations completed successfully');
    } finally {
      // Release advisory lock
      await sql`SELECT pg_advisory_unlock(${lockId})`;
    }
  } catch (error) {
    logger.error(`Migration runner failed: ${error}`);
    throw error;
  }
}

/**
 * Get current schema version.
 */
export async function getSchemaVersion(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return 0;
  }

  const sql = neon(databaseUrl);

  try {
    const result = await sql`
      SELECT COALESCE(MAX(version), 0) as current_version
      FROM schema_versions
    `;
    return Number(result[0]?.current_version || 0);
  } catch {
    // Table might not exist yet
    return 0;
  }
}
