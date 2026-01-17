/**
 * PostgreSQL storage for migration history and credentials.
 * Uses Neon serverless driver for Vercel deployment.
 *
 * PR Review fixes applied:
 * - OAuth state stored in database with TTL cleanup
 * - getCredentials throws DecryptionError instead of masking failures
 * - JSON parse returns null and logs corruption instead of empty object
 */

import { neon } from '@neondatabase/serverless';
import { encrypt, decrypt, generateEncryptionKey, DecryptionError } from '../crypto';
import { logger } from '../logger';

// Constants
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface Migration {
  id: number;
  started_at: string;
  completed_at: string | null;
  status: string;
  migration_type: string;
  dry_run: boolean;
  playlists_total: number;
  playlists_synced: number;
  tracks_matched: number;
  tracks_not_matched: number;
  isrc_matches: number;
  fuzzy_matches: number;
  report_json: string | null;
}

export interface SyncTask {
  id: string;
  user_id: string;
  migration_id: number;
  status: string;
  progress_json: string | null;
  created_at: string;
  updated_at: string;
  progress?: Record<string, unknown>;
}

export interface UnmatchedTrack {
  id: number;
  spotify_id: string;
  title: string;
  artist: string;
  album: string | null;
  sync_type: string;
  suggestions_json: string | null;
  status: string;
  resolved_qobuz_id: string | null;
  created_at: string;
  updated_at: string;
  suggestions?: Array<Record<string, unknown>>;
}

export interface OAuthState {
  id: string;
  redirect_uri: string;
  created_at: Date;
  expires_at: Date;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqlFunction = ReturnType<typeof neon>;

export class Storage {
  private sql: SqlFunction;
  private encryptionKey: string;

  constructor(databaseUrl?: string) {
    const url = databaseUrl || process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    this.sql = neon(url);
    this.encryptionKey = this.getEncryptionKey();
  }

  private getEncryptionKey(): string {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('ENCRYPTION_KEY environment variable is required in production');
      }
      logger.warn('ENCRYPTION_KEY not set, generating temporary key (credentials will be lost on restart)');
      return generateEncryptionKey();
    }
    return key;
  }

  // Helper to execute query and return rows as array
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toRows(result: any): Record<string, unknown>[] {
    if (Array.isArray(result)) {
      return result;
    }
    return [];
  }

  /**
   * Ensures a UNIQUE constraint exists on a table, handling legacy constraints and deduplication.
   * @param tableName The table to add the constraint to
   * @param oldConstraint Legacy constraint name to drop (if it exists), or null if none
   * @param newConstraint The new constraint name to create
   * @param columns Array of column names that form the unique constraint
   */
  private async ensureUniqueConstraint(
    tableName: string,
    oldConstraint: string | null,
    newConstraint: string,
    columns: string[]
  ): Promise<void> {
    const columnsList = columns.join(', ');
    const deduplicationCondition = columns.map((col) => `a.${col} = b.${col}`).join(' AND ');

    const dropLegacyBlock = oldConstraint
      ? `
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = '${oldConstraint}' AND conrelid = '${tableName}'::regclass
        ) THEN
          ALTER TABLE ${tableName} DROP CONSTRAINT ${oldConstraint};
        END IF;
      `
      : '';

    const sqlBlock = `
      DO $$
      BEGIN
        ${dropLegacyBlock}

        DELETE FROM ${tableName} a USING ${tableName} b
        WHERE a.id > b.id AND ${deduplicationCondition};

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = '${newConstraint}' AND conrelid = '${tableName}'::regclass
        ) THEN
          ALTER TABLE ${tableName} ADD CONSTRAINT ${newConstraint} UNIQUE (${columnsList});
        END IF;
      END $$;
    `;

    await this.sql.unsafe(sqlBlock);
  }

  async initDb(): Promise<void> {
    // Credentials now keyed by (user_id, service) for multi-user support
    await this.sql`
      CREATE TABLE IF NOT EXISTS credentials (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        service TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, service)
      )
    `;

    // Migrations track sync history per user
    await this.sql`
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
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS sync_tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        migration_id INTEGER REFERENCES migrations(id),
        status TEXT NOT NULL,
        progress_json TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Synced tracks keyed by (user_id, spotify_id, sync_type) for multi-user support
    await this.sql`
      CREATE TABLE IF NOT EXISTS synced_tracks (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        spotify_id TEXT NOT NULL,
        qobuz_id TEXT,
        sync_type TEXT NOT NULL,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, spotify_id, sync_type)
      )
    `;

    // Sync progress per user
    await this.sql`
      CREATE TABLE IF NOT EXISTS sync_progress (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        sync_type TEXT NOT NULL,
        last_offset INTEGER DEFAULT 0,
        total_tracks INTEGER DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, sync_type)
      )
    `;

    // Unmatched tracks per user
    await this.sql`
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
      )
    `;

    // OAuth state table for secure state management
    await this.sql`
      CREATE TABLE IF NOT EXISTS oauth_state (
        id TEXT PRIMARY KEY,
        redirect_uri TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      )
    `;

    // Active tasks table (replaces in-memory Map for multi-instance support)
    await this.sql`
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
      )
    `;

    // Add chunk_state_json column if it doesn't exist (for existing deployments)
    await this.sql`
      DO $$ BEGIN
        ALTER TABLE active_tasks ADD COLUMN IF NOT EXISTS chunk_state_json TEXT;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `;

    // Ensure user_id columns exist on all tables (handles legacy databases where
    // migrations may have been marked complete but columns weren't actually added)
    await this.sql`
      DO $$
      BEGIN
        -- Add user_id to credentials if missing
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'credentials' AND column_name = 'user_id'
        ) THEN
          ALTER TABLE credentials ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy_user';
        END IF;

        -- Add user_id to migrations if missing
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'migrations' AND column_name = 'user_id'
        ) THEN
          ALTER TABLE migrations ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy_user';
        END IF;

        -- Add user_id to sync_tasks if missing
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'sync_tasks' AND column_name = 'user_id'
        ) THEN
          ALTER TABLE sync_tasks ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy_user';
        END IF;

        -- Add user_id to synced_tracks if missing
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'synced_tracks' AND column_name = 'user_id'
        ) THEN
          ALTER TABLE synced_tracks ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy_user';
        END IF;

        -- Add user_id to sync_progress if missing
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'sync_progress' AND column_name = 'user_id'
        ) THEN
          ALTER TABLE sync_progress ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy_user';
        END IF;

        -- Add user_id to unmatched_tracks if missing
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'unmatched_tracks' AND column_name = 'user_id'
        ) THEN
          ALTER TABLE unmatched_tracks ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy_user';
        END IF;

        -- Add user_id to active_tasks if missing
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'active_tasks' AND column_name = 'user_id'
        ) THEN
          ALTER TABLE active_tasks ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy_user';
        END IF;
      END $$;
    `;

    // Ensure UNIQUE constraints exist on all tables (handles legacy databases where
    // user_id column was added but constraints weren't updated)
    await this.ensureUniqueConstraint(
      'credentials',
      'credentials_service_key',
      'credentials_user_id_service_key',
      ['user_id', 'service']
    );

    await this.ensureUniqueConstraint(
      'synced_tracks',
      null,
      'synced_tracks_user_id_spotify_id_sync_type_key',
      ['user_id', 'spotify_id', 'sync_type']
    );

    await this.ensureUniqueConstraint(
      'sync_progress',
      null,
      'sync_progress_user_id_sync_type_key',
      ['user_id', 'sync_type']
    );

    await this.ensureUniqueConstraint(
      'unmatched_tracks',
      null,
      'unmatched_tracks_user_id_spotify_id_sync_type_key',
      ['user_id', 'spotify_id', 'sync_type']
    );

    // Create indexes for performance (safe now that columns are guaranteed to exist)
    await this.sql`CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_migrations_user ON migrations(user_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_sync_tasks_user ON sync_tasks(user_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_synced_tracks_user ON synced_tracks(user_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_synced_tracks_sync_type ON synced_tracks(sync_type)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_sync_progress_user ON sync_progress(user_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_unmatched_user ON unmatched_tracks(user_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_unmatched_status ON unmatched_tracks(status)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_migrations_started ON migrations(started_at DESC)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_oauth_state_expires ON oauth_state(expires_at)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_active_tasks_user ON active_tasks(user_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_active_tasks_status ON active_tasks(status)`;

    logger.info('Database initialized');
  }

  // --- OAuth State Management ---

  async saveOAuthState(state: string, redirectUri: string): Promise<void> {
    const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);
    await this.sql`
      INSERT INTO oauth_state (id, redirect_uri, expires_at)
      VALUES (${state}, ${redirectUri}, ${expiresAt.toISOString()})
    `;
  }

  async getOAuthState(state: string): Promise<OAuthState | null> {
    const result = await this.sql`
      SELECT id, redirect_uri, created_at, expires_at
      FROM oauth_state
      WHERE id = ${state} AND expires_at > NOW()
    `;
    const rows = this.toRows(result);

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: String(row.id),
      redirect_uri: String(row.redirect_uri),
      created_at: new Date(String(row.created_at)),
      expires_at: new Date(String(row.expires_at)),
    };
  }

  async deleteOAuthState(state: string): Promise<void> {
    await this.sql`DELETE FROM oauth_state WHERE id = ${state}`;
  }

  async cleanupExpiredOAuthStates(): Promise<number> {
    const result = await this.sql`
      DELETE FROM oauth_state WHERE expires_at <= NOW() RETURNING id
    `;
    return this.toRows(result).length;
  }

  // --- Credentials ---

  async saveCredentials(userId: string, service: string, credentials: Record<string, unknown>): Promise<void> {
    const encrypted = encrypt(JSON.stringify(credentials), this.encryptionKey);
    await this.sql`
      INSERT INTO credentials (user_id, service, data, updated_at)
      VALUES (${userId}, ${service}, ${encrypted}, NOW())
      ON CONFLICT (user_id, service) DO UPDATE SET data = ${encrypted}, updated_at = NOW()
    `;
  }

  /**
   * Get credentials for a service.
   * @throws DecryptionError if decryption fails (e.g., key changed)
   * @returns null if no credentials exist for the service
   */
  async getCredentials(userId: string, service: string): Promise<Record<string, unknown> | null> {
    const result = await this.sql`SELECT data FROM credentials WHERE user_id = ${userId} AND service = ${service}`;
    const rows = this.toRows(result);
    if (rows.length === 0) {
      return null;
    }

    try {
      const decrypted = decrypt(String(rows[0].data), this.encryptionKey);
      return JSON.parse(decrypted);
    } catch (error) {
      logger.error(`Failed to decrypt credentials for ${service}: ${error}`);
      throw new DecryptionError(`Failed to decrypt credentials for ${service}. The encryption key may have changed.`);
    }
  }

  async hasCredentials(userId: string, service: string): Promise<boolean> {
    const result = await this.sql`SELECT 1 FROM credentials WHERE user_id = ${userId} AND service = ${service}`;
    return this.toRows(result).length > 0;
  }

  async deleteCredentials(userId: string, service: string): Promise<void> {
    await this.sql`DELETE FROM credentials WHERE user_id = ${userId} AND service = ${service}`;
  }

  // --- Migrations ---

  async createMigration(userId: string, migrationType: string, dryRun: boolean = false): Promise<number> {
    const result = await this.sql`
      INSERT INTO migrations (user_id, status, migration_type, dry_run)
      VALUES (${userId}, 'running', ${migrationType}, ${dryRun})
      RETURNING id
    `;
    const rows = this.toRows(result);
    return Number(rows[0].id);
  }

  async updateMigration(migrationId: number, updates: Partial<Migration>): Promise<void> {
    if (updates.status !== undefined) {
      await this.sql`UPDATE migrations SET status = ${updates.status} WHERE id = ${migrationId}`;
    }
    if (updates.completed_at !== undefined) {
      if (updates.completed_at === null) {
        await this.sql`UPDATE migrations SET completed_at = NULL WHERE id = ${migrationId}`;
      } else {
        await this.sql`UPDATE migrations SET completed_at = ${updates.completed_at} WHERE id = ${migrationId}`;
      }
    }
    if (updates.playlists_total !== undefined) {
      await this.sql`UPDATE migrations SET playlists_total = ${updates.playlists_total} WHERE id = ${migrationId}`;
    }
    if (updates.playlists_synced !== undefined) {
      await this.sql`UPDATE migrations SET playlists_synced = ${updates.playlists_synced} WHERE id = ${migrationId}`;
    }
    if (updates.tracks_matched !== undefined) {
      await this.sql`UPDATE migrations SET tracks_matched = ${updates.tracks_matched} WHERE id = ${migrationId}`;
    }
    if (updates.tracks_not_matched !== undefined) {
      await this.sql`UPDATE migrations SET tracks_not_matched = ${updates.tracks_not_matched} WHERE id = ${migrationId}`;
    }
    if (updates.isrc_matches !== undefined) {
      await this.sql`UPDATE migrations SET isrc_matches = ${updates.isrc_matches} WHERE id = ${migrationId}`;
    }
    if (updates.fuzzy_matches !== undefined) {
      await this.sql`UPDATE migrations SET fuzzy_matches = ${updates.fuzzy_matches} WHERE id = ${migrationId}`;
    }
    if (updates.report_json !== undefined) {
      await this.sql`UPDATE migrations SET report_json = ${updates.report_json} WHERE id = ${migrationId}`;
    }
  }

  async getMigration(migrationId: number): Promise<Migration | null> {
    const result = await this.sql`SELECT * FROM migrations WHERE id = ${migrationId}`;
    const rows = this.toRows(result);
    return rows.length > 0 ? rows[0] as unknown as Migration : null;
  }

  async getMigrations(userId: string, limit: number = 20): Promise<Migration[]> {
    const result = await this.sql`
      SELECT * FROM migrations WHERE user_id = ${userId} ORDER BY started_at DESC LIMIT ${limit}
    `;
    return this.toRows(result) as unknown as Migration[];
  }

  // --- Tasks ---

  async createTask(userId: string, taskId: string, migrationId: number): Promise<string> {
    await this.sql`
      INSERT INTO sync_tasks (id, user_id, migration_id, status)
      VALUES (${taskId}, ${userId}, ${migrationId}, 'pending')
    `;
    return taskId;
  }

  async updateTask(taskId: string, status: string, progress?: Record<string, unknown>): Promise<void> {
    const progressJson = progress ? JSON.stringify(progress) : null;
    await this.sql`
      UPDATE sync_tasks SET status = ${status}, progress_json = ${progressJson}, updated_at = NOW()
      WHERE id = ${taskId}
    `;
  }

  async getTask(taskId: string): Promise<SyncTask | null> {
    const result = await this.sql`SELECT * FROM sync_tasks WHERE id = ${taskId}`;
    const rows = this.toRows(result);
    if (rows.length === 0) return null;

    const row = rows[0] as unknown as SyncTask;
    if (row.progress_json) {
      const parsed = this.safeJsonParse(row.progress_json, `task ${taskId} progress`);
      row.progress = parsed ?? {};
    }
    return row;
  }

  // --- Active Tasks (Database-backed for multi-instance support) ---

  async createActiveTask(
    userId: string,
    taskId: string,
    migrationId: number,
    syncType: string,
    dryRun: boolean,
    progress: Record<string, unknown>
  ): Promise<void> {
    await this.sql`
      INSERT INTO active_tasks (id, user_id, migration_id, sync_type, status, dry_run, progress_json)
      VALUES (${taskId}, ${userId}, ${migrationId}, ${syncType}, 'starting', ${dryRun}, ${JSON.stringify(progress)})
    `;
  }

  async updateActiveTask(
    taskId: string,
    status: string,
    progress?: Record<string, unknown>,
    error?: string,
    report?: Record<string, unknown>,
    chunkState?: { offset: number; totalItems: number; processedInChunk: number; hasMore: boolean }
  ): Promise<void> {
    const progressJson = progress ? JSON.stringify(progress) : null;
    const reportJson = report ? JSON.stringify(report) : null;
    const errorVal = error ?? null;
    const chunkStateJson = chunkState ? JSON.stringify(chunkState) : null;

    await this.sql`
      UPDATE active_tasks
      SET status = ${status},
          progress_json = COALESCE(${progressJson}, progress_json),
          error = COALESCE(${errorVal}, error),
          report_json = COALESCE(${reportJson}, report_json),
          chunk_state_json = COALESCE(${chunkStateJson}, chunk_state_json),
          updated_at = NOW()
      WHERE id = ${taskId}
    `;
  }

  async getActiveTask(taskId: string): Promise<{
    id: string;
    user_id: string;
    migration_id: number;
    sync_type: string;
    status: string;
    dry_run: boolean;
    progress: Record<string, unknown> | null;
    error: string | null;
    report: Record<string, unknown> | null;
    chunkState: { offset: number; totalItems: number; processedInChunk: number; hasMore: boolean } | null;
  } | null> {
    const result = await this.sql`SELECT * FROM active_tasks WHERE id = ${taskId}`;
    const rows = this.toRows(result);
    if (rows.length === 0) return null;

    const row = rows[0];
    const chunkStateRaw = row.chunk_state_json ? this.safeJsonParse(String(row.chunk_state_json), `active task ${taskId} chunk_state`) : null;

    return {
      id: String(row.id),
      user_id: String(row.user_id),
      migration_id: Number(row.migration_id),
      sync_type: String(row.sync_type),
      status: String(row.status),
      dry_run: Boolean(row.dry_run),
      progress: row.progress_json ? this.safeJsonParse(String(row.progress_json), `active task ${taskId} progress`) : null,
      error: row.error ? String(row.error) : null,
      report: row.report_json ? this.safeJsonParse(String(row.report_json), `active task ${taskId} report`) : null,
      chunkState: chunkStateRaw as { offset: number; totalItems: number; processedInChunk: number; hasMore: boolean } | null,
    };
  }

  async getRunningTask(userId: string): Promise<{
    id: string;
    user_id: string;
    migration_id: number;
    sync_type: string;
    status: string;
    dry_run: boolean;
    progress: Record<string, unknown> | null;
  } | null> {
    const result = await this.sql`
      SELECT * FROM active_tasks
      WHERE user_id = ${userId} AND status IN ('starting', 'running')
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const rows = this.toRows(result);

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: String(row.id),
      user_id: String(row.user_id),
      migration_id: Number(row.migration_id),
      sync_type: String(row.sync_type),
      status: String(row.status),
      dry_run: Boolean(row.dry_run),
      progress: row.progress_json ? this.safeJsonParse(String(row.progress_json), `running task progress`) : null,
    };
  }

  async deleteActiveTask(taskId: string): Promise<void> {
    await this.sql`DELETE FROM active_tasks WHERE id = ${taskId}`;
  }

  async cleanupStaleActiveTasks(): Promise<void> {
    await this.sql`
      UPDATE active_tasks
      SET status = 'failed', error = 'Task timed out', updated_at = NOW()
      WHERE status IN ('starting', 'running')
        AND updated_at < NOW() - INTERVAL '1 hour'
    `;
  }

  // --- Synced Track Tracking ---

  async isTrackSynced(userId: string, spotifyId: string, syncType: string): Promise<boolean> {
    const result = await this.sql`
      SELECT 1 FROM synced_tracks WHERE user_id = ${userId} AND spotify_id = ${spotifyId} AND sync_type = ${syncType}
    `;
    return this.toRows(result).length > 0;
  }

  async markTrackSynced(userId: string, spotifyId: string, qobuzId: string, syncType: string): Promise<void> {
    await this.sql`
      INSERT INTO synced_tracks (user_id, spotify_id, qobuz_id, sync_type)
      VALUES (${userId}, ${spotifyId}, ${qobuzId}, ${syncType})
      ON CONFLICT (user_id, spotify_id, sync_type) DO UPDATE SET qobuz_id = ${qobuzId}, synced_at = NOW()
    `;
  }

  async getSyncedTrackIds(userId: string, syncType: string): Promise<Set<string>> {
    const result = await this.sql`SELECT spotify_id FROM synced_tracks WHERE user_id = ${userId} AND sync_type = ${syncType}`;
    const rows = this.toRows(result);
    return new Set(rows.map((r) => String(r.spotify_id)));
  }

  async getSyncedCount(userId: string, syncType: string): Promise<number> {
    const result = await this.sql`SELECT COUNT(*) as count FROM synced_tracks WHERE user_id = ${userId} AND sync_type = ${syncType}`;
    const rows = this.toRows(result);
    return parseInt(String(rows[0].count));
  }

  async clearSyncedTracks(userId: string, syncType: string): Promise<void> {
    await this.sql`DELETE FROM synced_tracks WHERE user_id = ${userId} AND sync_type = ${syncType}`;
  }

  // --- Sync Progress ---

  async saveSyncProgress(userId: string, syncType: string, lastOffset: number, totalTracks: number): Promise<void> {
    await this.sql`
      INSERT INTO sync_progress (user_id, sync_type, last_offset, total_tracks, updated_at)
      VALUES (${userId}, ${syncType}, ${lastOffset}, ${totalTracks}, NOW())
      ON CONFLICT (user_id, sync_type) DO UPDATE SET last_offset = ${lastOffset}, total_tracks = ${totalTracks}, updated_at = NOW()
    `;
  }

  async getSyncProgress(userId: string, syncType: string): Promise<{ last_offset: number; total_tracks: number } | null> {
    const result = await this.sql`SELECT last_offset, total_tracks FROM sync_progress WHERE user_id = ${userId} AND sync_type = ${syncType}`;
    const rows = this.toRows(result);
    if (rows.length === 0) return null;
    return {
      last_offset: Number(rows[0].last_offset),
      total_tracks: Number(rows[0].total_tracks),
    };
  }

  async clearSyncProgress(userId: string, syncType: string): Promise<void> {
    await this.sql`DELETE FROM sync_progress WHERE user_id = ${userId} AND sync_type = ${syncType}`;
  }

  async cleanupStaleTasks(): Promise<void> {
    await this.sql`
      UPDATE sync_tasks SET status = 'interrupted', updated_at = NOW()
      WHERE status IN ('running', 'pending', 'starting')
    `;

    await this.sql`
      UPDATE migrations SET status = 'interrupted', completed_at = NOW()
      WHERE status = 'running'
    `;
  }

  // --- Unmatched Tracks ---

  async saveUnmatchedTrack(
    userId: string,
    spotifyId: string,
    title: string,
    artist: string,
    album: string,
    syncType: string,
    suggestions: Array<Record<string, unknown>>
  ): Promise<void> {
    const suggestionsJson = suggestions.length > 0 ? JSON.stringify(suggestions) : null;

    await this.sql`
      INSERT INTO unmatched_tracks (user_id, spotify_id, title, artist, album, sync_type, suggestions_json, status)
      VALUES (${userId}, ${spotifyId}, ${title}, ${artist}, ${album}, ${syncType}, ${suggestionsJson}, 'pending')
      ON CONFLICT (user_id, spotify_id, sync_type) DO UPDATE SET
        title = ${title}, artist = ${artist}, album = ${album},
        suggestions_json = ${suggestionsJson}, updated_at = NOW()
    `;
  }

  async getUnmatchedTracks(
    userId: string,
    syncType?: string,
    status: string = 'pending',
    limit: number = 100,
    offset: number = 0
  ): Promise<UnmatchedTrack[]> {
    let result;
    if (syncType) {
      result = await this.sql`
        SELECT * FROM unmatched_tracks
        WHERE user_id = ${userId} AND sync_type = ${syncType} AND status = ${status}
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      result = await this.sql`
        SELECT * FROM unmatched_tracks
        WHERE user_id = ${userId} AND status = ${status}
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
      `;
    }
    const rows = this.toRows(result);

    return rows.map((row) => {
      const track = row as unknown as UnmatchedTrack;
      if (track.suggestions_json) {
        const parsed = this.safeJsonParse(track.suggestions_json, `track ${track.spotify_id} suggestions`);
        track.suggestions = Array.isArray(parsed) ? parsed : [];
      } else {
        track.suggestions = [];
      }
      return track;
    });
  }

  async getUnmatchedCount(userId: string, syncType?: string, status: string = 'pending'): Promise<number> {
    let result;
    if (syncType) {
      result = await this.sql`
        SELECT COUNT(*) as count FROM unmatched_tracks
        WHERE user_id = ${userId} AND sync_type = ${syncType} AND status = ${status}
      `;
    } else {
      result = await this.sql`
        SELECT COUNT(*) as count FROM unmatched_tracks WHERE user_id = ${userId} AND status = ${status}
      `;
    }
    const rows = this.toRows(result);
    return parseInt(String(rows[0].count));
  }

  async resolveUnmatchedTrack(userId: string, spotifyId: string, syncType: string, qobuzId: string, status: string = 'resolved'): Promise<void> {
    await this.sql`
      UPDATE unmatched_tracks SET status = ${status}, resolved_qobuz_id = ${qobuzId}, updated_at = NOW()
      WHERE user_id = ${userId} AND spotify_id = ${spotifyId} AND sync_type = ${syncType}
    `;
  }

  async dismissUnmatchedTrack(userId: string, spotifyId: string, syncType: string): Promise<void> {
    await this.sql`
      UPDATE unmatched_tracks SET status = 'dismissed', updated_at = NOW()
      WHERE user_id = ${userId} AND spotify_id = ${spotifyId} AND sync_type = ${syncType}
    `;
  }

  async clearUnmatchedTracks(userId: string, syncType?: string): Promise<void> {
    if (syncType) {
      await this.sql`DELETE FROM unmatched_tracks WHERE user_id = ${userId} AND sync_type = ${syncType}`;
    } else {
      await this.sql`DELETE FROM unmatched_tracks WHERE user_id = ${userId}`;
    }
  }

  // --- Helper Methods ---

  /**
   * Safely parse JSON, returning null and logging on failure instead of throwing.
   */
  private safeJsonParse(json: string, context: string): Record<string, unknown> | null {
    try {
      return JSON.parse(json);
    } catch (error) {
      logger.error(`JSON parse error for ${context}: ${error}. Data may be corrupted.`);
      return null;
    }
  }
}
