/**
 * SQLite storage for migration history and credentials.
 * Equivalent to Python's src/storage.py
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { dirname, join } from 'path';
import { encrypt, decrypt, generateEncryptionKey } from '../lib/crypto';
import { logger } from '../lib/logger';

export interface Migration {
  id: number;
  started_at: string;
  completed_at: string | null;
  status: string;
  migration_type: string;
  dry_run: number;
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

export class Storage {
  private db: Database.Database;
  private encryptionKey: string;

  constructor(dbPath: string = 'data/migrations.db') {
    this.ensureDirectory(dbPath);
    this.encryptionKey = this.getOrCreateKey(dbPath);
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  private ensureDirectory(dbPath: string): void {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private getOrCreateKey(dbPath: string): string {
    // Check environment variable first (for cloud deployments)
    if (process.env.ENCRYPTION_KEY) {
      return process.env.ENCRYPTION_KEY;
    }

    // Fall back to file-based key (for local development)
    const keyPath = join(dirname(dbPath), '.encryption_key');
    if (existsSync(keyPath)) {
      return readFileSync(keyPath, 'utf-8').trim();
    }

    const key = generateEncryptionKey();
    writeFileSync(keyPath, key);
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // chmod may fail on some systems
    }
    return key;
  }

  initDb(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        id INTEGER PRIMARY KEY,
        service TEXT UNIQUE NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL,
        migration_type TEXT NOT NULL,
        dry_run INTEGER DEFAULT 0,
        playlists_total INTEGER DEFAULT 0,
        playlists_synced INTEGER DEFAULT 0,
        tracks_matched INTEGER DEFAULT 0,
        tracks_not_matched INTEGER DEFAULT 0,
        isrc_matches INTEGER DEFAULT 0,
        fuzzy_matches INTEGER DEFAULT 0,
        report_json TEXT
      )
    `);

    // Add dry_run column if it doesn't exist (migration for existing DBs)
    try {
      this.db.exec('ALTER TABLE migrations ADD COLUMN dry_run INTEGER DEFAULT 0');
    } catch {
      // Column already exists
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_tasks (
        id TEXT PRIMARY KEY,
        migration_id INTEGER,
        status TEXT NOT NULL,
        progress_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (migration_id) REFERENCES migrations(id)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS synced_tracks (
        spotify_id TEXT PRIMARY KEY,
        qobuz_id TEXT,
        sync_type TEXT NOT NULL,
        synced_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_progress (
        sync_type TEXT PRIMARY KEY,
        last_offset INTEGER DEFAULT 0,
        total_tracks INTEGER DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS unmatched_tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spotify_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT,
        sync_type TEXT NOT NULL,
        suggestions_json TEXT,
        status TEXT DEFAULT 'pending',
        resolved_qobuz_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(spotify_id, sync_type)
      )
    `);

    logger.info('Database initialized');
  }

  // --- Credentials ---

  saveCredentials(service: string, credentials: Record<string, unknown>): void {
    const encrypted = encrypt(JSON.stringify(credentials), this.encryptionKey);
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO credentials (service, data, updated_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(service, encrypted, new Date().toISOString());
  }

  getCredentials(service: string): Record<string, unknown> | null {
    const stmt = this.db.prepare('SELECT data FROM credentials WHERE service = ?');
    const row = stmt.get(service) as { data: string } | undefined;
    if (row) {
      return JSON.parse(decrypt(row.data, this.encryptionKey));
    }
    return null;
  }

  hasCredentials(service: string): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM credentials WHERE service = ?');
    return stmt.get(service) !== undefined;
  }

  deleteCredentials(service: string): void {
    const stmt = this.db.prepare('DELETE FROM credentials WHERE service = ?');
    stmt.run(service);
  }

  // --- Migrations ---

  createMigration(migrationType: string, dryRun: boolean = false): number {
    const stmt = this.db.prepare(`
      INSERT INTO migrations (started_at, status, migration_type, dry_run)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(new Date().toISOString(), 'running', migrationType, dryRun ? 1 : 0);
    return result.lastInsertRowid as number;
  }

  updateMigration(migrationId: number, updates: Partial<Migration>): void {
    const allowedFields = new Set([
      'completed_at', 'status', 'playlists_total', 'playlists_synced',
      'tracks_matched', 'tracks_not_matched', 'isrc_matches',
      'fuzzy_matches', 'report_json'
    ]);

    const filtered = Object.entries(updates).filter(([k]) => allowedFields.has(k));
    if (filtered.length === 0) return;

    const setClause = filtered.map(([k]) => `${k} = ?`).join(', ');
    const values = [...filtered.map(([, v]) => v), migrationId];

    const stmt = this.db.prepare(`UPDATE migrations SET ${setClause} WHERE id = ?`);
    stmt.run(...values);
  }

  getMigration(migrationId: number): Migration | null {
    const stmt = this.db.prepare('SELECT * FROM migrations WHERE id = ?');
    return stmt.get(migrationId) as Migration | null;
  }

  getMigrations(limit: number = 20): Migration[] {
    const stmt = this.db.prepare(`
      SELECT * FROM migrations ORDER BY started_at DESC LIMIT ?
    `);
    return stmt.all(limit) as Migration[];
  }

  // --- Tasks ---

  createTask(taskId: string, migrationId: number): string {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO sync_tasks (id, migration_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(taskId, migrationId, 'pending', now, now);
    return taskId;
  }

  updateTask(taskId: string, status: string, progress?: Record<string, unknown>): void {
    const progressJson = progress ? JSON.stringify(progress) : null;
    const stmt = this.db.prepare(`
      UPDATE sync_tasks SET status = ?, progress_json = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(status, progressJson, new Date().toISOString(), taskId);
  }

  getTask(taskId: string): SyncTask | null {
    const stmt = this.db.prepare('SELECT * FROM sync_tasks WHERE id = ?');
    const row = stmt.get(taskId) as SyncTask | undefined;
    if (row) {
      if (row.progress_json) {
        row.progress = JSON.parse(row.progress_json);
      }
      return row;
    }
    return null;
  }

  // --- Synced Track Tracking ---

  isTrackSynced(spotifyId: string, syncType: string): boolean {
    const stmt = this.db.prepare(
      'SELECT 1 FROM synced_tracks WHERE spotify_id = ? AND sync_type = ?'
    );
    return stmt.get(spotifyId, syncType) !== undefined;
  }

  markTrackSynced(spotifyId: string, qobuzId: string, syncType: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO synced_tracks (spotify_id, qobuz_id, sync_type, synced_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(spotifyId, qobuzId, syncType, new Date().toISOString());
  }

  getSyncedTrackIds(syncType: string): Set<string> {
    const stmt = this.db.prepare('SELECT spotify_id FROM synced_tracks WHERE sync_type = ?');
    const rows = stmt.all(syncType) as Array<{ spotify_id: string }>;
    return new Set(rows.map(r => r.spotify_id));
  }

  getSyncedCount(syncType: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM synced_tracks WHERE sync_type = ?');
    const row = stmt.get(syncType) as { count: number };
    return row.count;
  }

  clearSyncedTracks(syncType: string): void {
    const stmt = this.db.prepare('DELETE FROM synced_tracks WHERE sync_type = ?');
    stmt.run(syncType);
  }

  // --- Sync Progress ---

  saveSyncProgress(syncType: string, lastOffset: number, totalTracks: number): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sync_progress (sync_type, last_offset, total_tracks, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(syncType, lastOffset, totalTracks, new Date().toISOString());
  }

  getSyncProgress(syncType: string): { last_offset: number; total_tracks: number } | null {
    const stmt = this.db.prepare('SELECT * FROM sync_progress WHERE sync_type = ?');
    return stmt.get(syncType) as { last_offset: number; total_tracks: number } | null;
  }

  clearSyncProgress(syncType: string): void {
    const stmt = this.db.prepare('DELETE FROM sync_progress WHERE sync_type = ?');
    stmt.run(syncType);
  }

  cleanupStaleTasks(): void {
    const now = new Date().toISOString();

    this.db.exec(`
      UPDATE sync_tasks SET status = 'interrupted', updated_at = '${now}'
      WHERE status IN ('running', 'pending', 'starting')
    `);

    this.db.exec(`
      UPDATE migrations SET status = 'interrupted', completed_at = '${now}'
      WHERE status = 'running'
    `);
  }

  // --- Unmatched Tracks ---

  saveUnmatchedTrack(
    spotifyId: string,
    title: string,
    artist: string,
    album: string,
    syncType: string,
    suggestions: Array<Record<string, unknown>>
  ): void {
    const now = new Date().toISOString();
    const suggestionsJson = suggestions.length > 0 ? JSON.stringify(suggestions) : null;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO unmatched_tracks
      (spotify_id, title, artist, album, sync_type, suggestions_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);
    stmt.run(spotifyId, title, artist, album, syncType, suggestionsJson, now, now);
  }

  getUnmatchedTracks(
    syncType?: string,
    status: string = 'pending',
    limit: number = 100,
    offset: number = 0
  ): UnmatchedTrack[] {
    let query = 'SELECT * FROM unmatched_tracks WHERE 1=1';
    const params: unknown[] = [];

    if (syncType) {
      query += ' AND sync_type = ?';
      params.push(syncType);
    }

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as UnmatchedTrack[];

    return rows.map(row => {
      if (row.suggestions_json) {
        row.suggestions = JSON.parse(row.suggestions_json);
      } else {
        row.suggestions = [];
      }
      return row;
    });
  }

  getUnmatchedCount(syncType?: string, status: string = 'pending'): number {
    let query = 'SELECT COUNT(*) as count FROM unmatched_tracks WHERE 1=1';
    const params: unknown[] = [];

    if (syncType) {
      query += ' AND sync_type = ?';
      params.push(syncType);
    }

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    const stmt = this.db.prepare(query);
    const row = stmt.get(...params) as { count: number };
    return row.count;
  }

  resolveUnmatchedTrack(spotifyId: string, syncType: string, qobuzId: string, status: string = 'resolved'): void {
    const stmt = this.db.prepare(`
      UPDATE unmatched_tracks SET status = ?, resolved_qobuz_id = ?, updated_at = ?
      WHERE spotify_id = ? AND sync_type = ?
    `);
    stmt.run(status, qobuzId, new Date().toISOString(), spotifyId, syncType);
  }

  dismissUnmatchedTrack(spotifyId: string, syncType: string): void {
    const stmt = this.db.prepare(`
      UPDATE unmatched_tracks SET status = 'dismissed', updated_at = ?
      WHERE spotify_id = ? AND sync_type = ?
    `);
    stmt.run(new Date().toISOString(), spotifyId, syncType);
  }

  clearUnmatchedTracks(syncType?: string): void {
    if (syncType) {
      const stmt = this.db.prepare('DELETE FROM unmatched_tracks WHERE sync_type = ?');
      stmt.run(syncType);
    } else {
      this.db.exec('DELETE FROM unmatched_tracks');
    }
  }

  close(): void {
    this.db.close();
  }
}
