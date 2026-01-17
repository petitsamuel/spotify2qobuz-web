/**
 * Shared type definitions with PR review fixes.
 * Uses discriminated unions to prevent illegal states.
 */

// === Migration Types ===

export type MigrationStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export type TaskStatus = 'pending' | 'starting' | 'running' | 'chunk_complete' | 'completed' | 'failed' | 'cancelled';

export type SyncType = 'favorites' | 'albums' | 'playlists';

// === Credential Types ===

export interface QobuzCredentials {
  user_auth_token: string;
}

export interface SpotifyCredentials {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  access_token: string;
  refresh_token?: string;
  expires_at: number;
}

// === Progress Types ===

export interface MissingTrack {
  spotify_id: string;
  title: string;
  artist: string;
  album: string;
  suggestions: Suggestion[];
}

export interface Suggestion {
  qobuz_id: number;
  title: string;
  artist: string;
  album: string;
  score: number;
  title_score: number;
  artist_score: number;
  duration_diff_sec: number;
}

export interface SyncProgress {
  current_playlist: string;
  current_playlist_index: number;
  total_playlists: number;
  current_track_index: number;
  total_tracks: number;
  tracks_matched: number;
  tracks_not_matched: number;
  isrc_matches: number;
  fuzzy_matches: number;
  percent_complete: number;
  recent_missing: MissingTrack[];
}

// === Report Types ===

export interface SyncReport {
  started_at: string;
  completed_at: string | null;
  tracks_matched: number;
  tracks_not_matched: number;
  tracks_skipped: number;
  tracks_already_in_qobuz: number;
  isrc_matches: number;
  fuzzy_matches: number;
  missing_tracks: MissingTrack[];
  synced_tracks: Array<{ spotify_id: string; qobuz_id: string }>;
  errors: string[];
}

export interface AlbumSyncReport {
  started_at: string;
  completed_at: string | null;
  albums_matched: number;
  albums_not_matched: number;
  albums_skipped: number;
  albums_already_in_qobuz: number;
  upc_matches: number;
  fuzzy_matches: number;
  missing_albums: MissingTrack[];
  synced_albums: Array<{ spotify_id: string; qobuz_id: string }>;
  errors: string[];
}

// === Active Task Type (Discriminated Union) ===
// This prevents illegal states like 'starting' with a report, or 'completed' without one.

interface BaseActiveTask {
  syncType: SyncType;
  dryRun: boolean;
}

interface StartingTask extends BaseActiveTask {
  status: 'starting';
  progress: SyncProgress;
}

interface RunningTask extends BaseActiveTask {
  status: 'running';
  progress: SyncProgress;
}

interface CompletedTask extends BaseActiveTask {
  status: 'completed';
  progress: SyncProgress;
  report: SyncReport | AlbumSyncReport;
}

interface FailedTask extends BaseActiveTask {
  status: 'failed';
  progress: SyncProgress;
  error: string;
}

interface CancelledTask extends BaseActiveTask {
  status: 'cancelled';
  progress: SyncProgress;
}

interface ChunkCompleteTask extends BaseActiveTask {
  status: 'chunk_complete';
  progress: SyncProgress;
  chunkState: ChunkState;
}

export type ActiveTask =
  | StartingTask
  | RunningTask
  | CompletedTask
  | FailedTask
  | CancelledTask
  | ChunkCompleteTask;

// === Chunked Sync Types ===

export interface ChunkState {
  offset: number;
  totalItems: number;
  processedInChunk: number;
  hasMore: boolean;
}

export interface ChunkResult {
  hasMore: boolean;
  nextOffset: number;
  totalItems: number;
  processedInChunk: number;
  partialReport: Partial<SyncReport | AlbumSyncReport>;
}

// === OAuth State ===

export interface OAuthState {
  id: string;
  redirect_uri: string;
  created_at: Date;
  expires_at: Date;
}

// === API Error Types ===

export class QobuzApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly endpoint?: string
  ) {
    super(message);
    this.name = 'QobuzApiError';
  }
}

export class SpotifyApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly endpoint?: string
  ) {
    super(message);
    this.name = 'SpotifyApiError';
  }
}

// === Validation Helpers ===

/**
 * Validates a Spotify track ID format.
 * Spotify IDs are 22 alphanumeric characters.
 */
export function isValidSpotifyId(id: string): boolean {
  return /^[a-zA-Z0-9]{22}$/.test(id);
}

/**
 * Validates a Qobuz track ID format.
 * Qobuz track IDs are positive integers.
 */
export function isValidQobuzTrackId(id: string | number): boolean {
  const num = typeof id === 'string' ? parseInt(id, 10) : id;
  return Number.isInteger(num) && num > 0;
}

/**
 * Validates a Qobuz album ID format.
 * Qobuz album IDs can be numeric strings.
 */
export function isValidQobuzAlbumId(id: string): boolean {
  return /^\d+$/.test(id) && parseInt(id, 10) > 0;
}
