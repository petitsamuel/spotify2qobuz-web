/**
 * PostgreSQL storage for migration history and credentials.
 * Uses Neon serverless driver for Vercel deployment.
 */

import { neon, neonConfig } from '@neondatabase/serverless';
import { encrypt, decrypt, generateEncryptionKey } from '../lib/crypto';
import { logger } from '../lib/logger';

// Enable connection pooling for serverless
neonConfig.poolConnections = true;
neonConfig.useSecureWebSocket = true;

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

type SQL = ReturnType<typeof neon>;

export class Storage {
  private sql: SQL;
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
      // In production, encryption key is required to prevent data loss
      if (process.env.NODE_ENV === 'production') {
        throw new Error('ENCRYPTION_KEY environment variable is required in production');
      }
      // In development, generate a temporary key (credentials won't persist across restarts)
      logger.warn('ENCRYPTION_KEY not set, generating temporary key (credentials will be lost on restart)');
      return generateEncryptionKey();
    }
    return key;
  }

  async initDb(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS credentials (
        id SERIAL PRIMARY KEY,
        service TEXT UNIQUE NOT NULL,
        data TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
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
        migration_id INTEGER REFERENCES migrations(id),
        status TEXT NOT NULL,
        progress_json TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS synced_tracks (
        spotify_id TEXT PRIMARY KEY,
        qobuz_id TEXT,
        sync_type TEXT NOT NULL,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS sync_progress (
        sync_type TEXT PRIMARY KEY,
        last_offset INTEGER DEFAULT 0,
        total_tracks INTEGER DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS unmatched_tracks (
        id SERIAL PRIMARY KEY,
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
        UNIQUE(spotify_id, sync_type)
      )
    `;

    // Create indexes for performance
    await this.sql`CREATE INDEX IF NOT EXISTS idx_synced_tracks_sync_type ON synced_tracks(sync_type)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_unmatched_status ON unmatched_tracks(status)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_migrations_started ON migrations(started_at DESC)`;

    logger.info('Database initialized');
  }

  // --- Credentials ---

  async saveCredentials(service: string, credentials: Record<string, unknown>): Promise<void> {
    const encrypted = encrypt(JSON.stringify(credentials), this.encryptionKey);
    await this.sql`
      INSERT INTO credentials (service, data, updated_at)
      VALUES (${service}, ${encrypted}, NOW())
      ON CONFLICT (service) DO UPDATE SET data = ${encrypted}, updated_at = NOW()
    `;
  }

  async getCredentials(service: string): Promise<Record<string, unknown> | null> {
    const rows = await this.sql`SELECT data FROM credentials WHERE service = ${service}`;
    if (rows.length > 0) {
      return JSON.parse(decrypt(rows[0].data, this.encryptionKey));
    }
    return null;
  }

  async hasCredentials(service: string): Promise<boolean> {
    const rows = await this.sql`SELECT 1 FROM credentials WHERE service = ${service}`;
    return rows.length > 0;
  }

  async deleteCredentials(service: string): Promise<void> {
    await this.sql`DELETE FROM credentials WHERE service = ${service}`;
  }

  // --- Migrations ---

  async createMigration(migrationType: string, dryRun: boolean = false): Promise<number> {
    const rows = await this.sql`
      INSERT INTO migrations (status, migration_type, dry_run)
      VALUES ('running', ${migrationType}, ${dryRun})
      RETURNING id
    `;
    return rows[0].id;
  }

  async updateMigration(migrationId: number, updates: Partial<Migration>): Promise<void> {
    // Use individual parameterized updates for each field to avoid SQL injection
    // This is safer than building dynamic queries with string interpolation
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
    const rows = await this.sql`SELECT * FROM migrations WHERE id = ${migrationId}`;
    return rows.length > 0 ? rows[0] as Migration : null;
  }

  async getMigrations(limit: number = 20): Promise<Migration[]> {
    const rows = await this.sql`
      SELECT * FROM migrations ORDER BY started_at DESC LIMIT ${limit}
    `;
    return rows as Migration[];
  }

  // --- Tasks ---

  async createTask(taskId: string, migrationId: number): Promise<string> {
    await this.sql`
      INSERT INTO sync_tasks (id, migration_id, status)
      VALUES (${taskId}, ${migrationId}, 'pending')
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
    const rows = await this.sql`SELECT * FROM sync_tasks WHERE id = ${taskId}`;
    if (rows.length > 0) {
      const row = rows[0] as SyncTask;
      if (row.progress_json) {
        row.progress = JSON.parse(row.progress_json);
      }
      return row;
    }
    return null;
  }

  // --- Synced Track Tracking ---

  async isTrackSynced(spotifyId: string, syncType: string): Promise<boolean> {
    const rows = await this.sql`
      SELECT 1 FROM synced_tracks WHERE spotify_id = ${spotifyId} AND sync_type = ${syncType}
    `;
    return rows.length > 0;
  }

  async markTrackSynced(spotifyId: string, qobuzId: string, syncType: string): Promise<void> {
    await this.sql`
      INSERT INTO synced_tracks (spotify_id, qobuz_id, sync_type)
      VALUES (${spotifyId}, ${qobuzId}, ${syncType})
      ON CONFLICT (spotify_id) DO UPDATE SET qobuz_id = ${qobuzId}, synced_at = NOW()
    `;
  }

  async getSyncedTrackIds(syncType: string): Promise<Set<string>> {
    const rows = await this.sql`SELECT spotify_id FROM synced_tracks WHERE sync_type = ${syncType}`;
    return new Set(rows.map((r: { spotify_id: string }) => r.spotify_id));
  }

  async getSyncedCount(syncType: string): Promise<number> {
    const rows = await this.sql`SELECT COUNT(*) as count FROM synced_tracks WHERE sync_type = ${syncType}`;
    return parseInt(rows[0].count);
  }

  async clearSyncedTracks(syncType: string): Promise<void> {
    await this.sql`DELETE FROM synced_tracks WHERE sync_type = ${syncType}`;
  }

  // --- Sync Progress ---

  async saveSyncProgress(syncType: string, lastOffset: number, totalTracks: number): Promise<void> {
    await this.sql`
      INSERT INTO sync_progress (sync_type, last_offset, total_tracks, updated_at)
      VALUES (${syncType}, ${lastOffset}, ${totalTracks}, NOW())
      ON CONFLICT (sync_type) DO UPDATE SET last_offset = ${lastOffset}, total_tracks = ${totalTracks}, updated_at = NOW()
    `;
  }

  async getSyncProgress(syncType: string): Promise<{ last_offset: number; total_tracks: number } | null> {
    const rows = await this.sql`SELECT last_offset, total_tracks FROM sync_progress WHERE sync_type = ${syncType}`;
    return rows.length > 0 ? { last_offset: rows[0].last_offset, total_tracks: rows[0].total_tracks } : null;
  }

  async clearSyncProgress(syncType: string): Promise<void> {
    await this.sql`DELETE FROM sync_progress WHERE sync_type = ${syncType}`;
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
    spotifyId: string,
    title: string,
    artist: string,
    album: string,
    syncType: string,
    suggestions: Array<Record<string, unknown>>
  ): Promise<void> {
    const suggestionsJson = suggestions.length > 0 ? JSON.stringify(suggestions) : null;

    await this.sql`
      INSERT INTO unmatched_tracks (spotify_id, title, artist, album, sync_type, suggestions_json, status)
      VALUES (${spotifyId}, ${title}, ${artist}, ${album}, ${syncType}, ${suggestionsJson}, 'pending')
      ON CONFLICT (spotify_id, sync_type) DO UPDATE SET
        title = ${title}, artist = ${artist}, album = ${album},
        suggestions_json = ${suggestionsJson}, updated_at = NOW()
    `;
  }

  async getUnmatchedTracks(
    syncType?: string,
    status: string = 'pending',
    limit: number = 100,
    offset: number = 0
  ): Promise<UnmatchedTrack[]> {
    let rows;
    if (syncType) {
      rows = await this.sql`
        SELECT * FROM unmatched_tracks
        WHERE sync_type = ${syncType} AND status = ${status}
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      rows = await this.sql`
        SELECT * FROM unmatched_tracks
        WHERE status = ${status}
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
      `;
    }

    return rows.map((row: Record<string, unknown>) => {
      const track = row as unknown as UnmatchedTrack;
      if (track.suggestions_json) {
        track.suggestions = JSON.parse(track.suggestions_json);
      } else {
        track.suggestions = [];
      }
      return track;
    });
  }

  async getUnmatchedCount(syncType?: string, status: string = 'pending'): Promise<number> {
    let rows;
    if (syncType) {
      rows = await this.sql`
        SELECT COUNT(*) as count FROM unmatched_tracks
        WHERE sync_type = ${syncType} AND status = ${status}
      `;
    } else {
      rows = await this.sql`
        SELECT COUNT(*) as count FROM unmatched_tracks WHERE status = ${status}
      `;
    }
    return parseInt(rows[0].count);
  }

  async resolveUnmatchedTrack(spotifyId: string, syncType: string, qobuzId: string, status: string = 'resolved'): Promise<void> {
    await this.sql`
      UPDATE unmatched_tracks SET status = ${status}, resolved_qobuz_id = ${qobuzId}, updated_at = NOW()
      WHERE spotify_id = ${spotifyId} AND sync_type = ${syncType}
    `;
  }

  async dismissUnmatchedTrack(spotifyId: string, syncType: string): Promise<void> {
    await this.sql`
      UPDATE unmatched_tracks SET status = 'dismissed', updated_at = NOW()
      WHERE spotify_id = ${spotifyId} AND sync_type = ${syncType}
    `;
  }

  async clearUnmatchedTracks(syncType?: string): Promise<void> {
    if (syncType) {
      await this.sql`DELETE FROM unmatched_tracks WHERE sync_type = ${syncType}`;
    } else {
      await this.sql`DELETE FROM unmatched_tracks`;
    }
  }
}
