/**
 * Async sync service with progress callbacks.
 *
 * PR Review fixes applied:
 * - addFavoriteTracksBatch now throws on error, so we wrap in try/catch
 * - Better error handling throughout
 */

import { logger } from '../logger';
import { SpotifyClient, SpotifyTrack, SpotifyAlbum } from './spotify';
import { QobuzClient, QobuzAlbum } from './qobuz';
import { TrackMatcher, Suggestion, bestFuzzyScore } from './matcher';
import type { SyncProgress, SyncReport, AlbumSyncReport, MissingTrack, ChunkResult } from '../types';

/**
 * Comprehensive album edition normalization.
 * Handles all common special edition formats across music platforms.
 */

// Edition keywords that appear in parentheses or brackets
const EDITION_KEYWORDS = [
  // Deluxe variants
  'deluxe', 'super deluxe', 'deluxe edition', 'deluxe version',
  // Expanded/Special/Collector
  'expanded', 'expanded edition', 'special edition', 'collector\'s edition',
  'limited edition', 'premium edition', 'ultimate edition', 'complete edition',
  // Anniversary
  'anniversary', 'anniversary edition', '\\d+(?:th|st|nd|rd)?\\s*anniversary',
  // Remaster variants
  'remaster', 'remastered', 'remastered \\d{4}', '\\d{4} remaster',
  '\\d{4} mix', '\\d{4} version',
  // Live variants
  'live', 'live at [^\\]\\)]*', 'live from [^\\]\\)]*', 'live in [^\\]\\)]*',
  'mtv unplugged', 'unplugged', 'in concert',
  // Acoustic/Stripped
  'acoustic', 'acoustic version', 'stripped', 'stripped down',
  // Audio formats
  'mono', 'stereo', 'mono version', 'stereo version',
  'hi-res', 'high resolution', 'atmos', 'dolby atmos', 'spatial',
  // Regional variants
  'uk edition', 'us edition', 'japan edition', 'japanese edition',
  'international', 'international version', 'import',
  // Content variants
  'explicit', 'clean', 'edited', 'censored', 'uncensored',
  'radio edit', 'single version',
  // Instrumental/Remix
  'instrumental', 'instrumentals', 'karaoke',
  'remix', 'remixed', 'remixes',
  // Bonus content
  'bonus track', 'bonus tracks', 'bonus disc', 'with bonus',
  'extra tracks', 'b-sides',
  // Demos/Sessions
  'demo', 'demos', 'sessions', 'the sessions', 'outtakes',
  // Revisited/Reimagined
  'revisited', 'reimagined', 'redux', 'reworked', 're-recorded',
  // Soundtrack
  'original motion picture soundtrack', 'original soundtrack', 'ost',
  'motion picture', 'film score',
  // Format indicators
  'vinyl', 'cd', 'digital', 'streaming',
  // Note: Removed standalone '\\d{4}' as it's too broad and would strip
  // legitimate album titles like "1989", "2001", "1984". Year-based editions
  // are covered by specific patterns like 'remastered \\d{4}', '\\d{4} remaster'.
];

// Build a mega-pattern that matches any edition keyword in () or []
const EDITION_KEYWORD_PATTERN = new RegExp(
  `\\s*[([](${EDITION_KEYWORDS.join('|')})[^\\]\\)]*[\\])]`,
  'gi'
);

// Patterns for hyphen-based suffixes (no brackets)
const HYPHEN_EDITION_PATTERNS = [
  /\s+-\s*deluxe\s*$/i,
  /\s+-\s*remaster(?:ed)?\s*$/i,
  /\s+-\s*remastered\s+\d{4}\s*$/i,
  /\s+-\s*\d{4}\s+remaster(?:ed)?\s*$/i,
  /\s+-\s*live\s*$/i,
  /\s+-\s*acoustic\s*$/i,
  /\s+-\s*unplugged\s*$/i,
  /\s+-\s*mono\s*$/i,
  /\s+-\s*stereo\s*$/i,
  /\s+-\s*expanded\s*$/i,
  /\s+-\s*anniversary\s*edition?\s*$/i,
  /\s+-\s*\d+(?:th|st|nd|rd)?\s*anniversary[^-]*$/i,
  /\s+-\s*special\s*edition?\s*$/i,
  /\s+-\s*single\s*$/i,
  /\s+-\s*ep\s*$/i,
];

// Standalone patterns for specific formats
const STANDALONE_PATTERNS = [
  /\s+\[Explicit\]\s*$/i,
  /\s+\(Explicit\)\s*$/i,
  /\s+\[Clean\]\s*$/i,
  /\s+\(Clean\)\s*$/i,
  // Common Qobuz/Spotify format: "Album Name (Year Remaster)"
  /\s*\(\d{4}\s+Remaster(?:ed)?\)\s*$/i,
  // "Album Name [2019 Mix]" style
  /\s*\[\d{4}\s+Mix\]\s*$/i,
  // "Album - 25th Anniversary Edition" without parentheses
  /\s+-\s+\d+(?:th|st|nd|rd)?\s+Anniversary[^()\[\]]*$/i,
];

/**
 * Normalize an album title by stripping edition suffixes.
 * Tries multiple strategies to get the base album name.
 */
function stripEditionSuffix(title: string): string {
  let result = title;

  // Strategy 1: Remove bracketed/parenthesized edition keywords
  result = result.replace(EDITION_KEYWORD_PATTERN, '');

  // Strategy 2: Remove hyphen-based suffixes
  for (const pattern of HYPHEN_EDITION_PATTERNS) {
    result = result.replace(pattern, '');
  }

  // Strategy 3: Remove standalone patterns
  for (const pattern of STANDALONE_PATTERNS) {
    result = result.replace(pattern, '');
  }

  // Strategy 4: Remove any remaining empty brackets
  result = result.replace(/\s*\(\s*\)\s*/g, '');
  result = result.replace(/\s*\[\s*\]\s*/g, '');

  // Clean up multiple spaces and trim
  result = result.replace(/\s+/g, ' ').trim();

  // Remove trailing punctuation that might be left over
  result = result.replace(/\s*[-:]\s*$/, '').trim();

  return result;
}

/**
 * Get multiple normalized variants of an album title for matching.
 * Returns array of titles to try, from most specific to most general.
 */
function getAlbumTitleVariants(title: string): string[] {
  const variants = new Set<string>();

  // Original title
  variants.add(title);

  // Basic stripped version
  const stripped = stripEditionSuffix(title);
  if (stripped !== title) {
    variants.add(stripped);
  }

  // Aggressive strip: remove ALL parenthetical/bracketed content
  const aggressive = title.replace(/\s*[([][^\]()]*[\])]/g, '').trim();
  if (aggressive !== title && aggressive.length > 0) {
    variants.add(aggressive);
  }

  // Remove "The" prefix
  if (title.toLowerCase().startsWith('the ')) {
    variants.add(title.substring(4));
    if (stripped.toLowerCase().startsWith('the ')) {
      variants.add(stripped.substring(4));
    }
  }

  return Array.from(variants);
}

type ProgressCallback = (progress: SyncProgress) => void;
type TrackSyncedCallback = (spotifyId: string, qobuzId: string) => void;
type CancellationChecker = () => Promise<boolean>;
type PlaylistSyncedCallback = (playlistId: string, snapshotId: string, trackCount: number) => void;

export interface PlaylistSyncOptions {
  skipUnchanged: boolean;
  syncedPlaylistsMap: Map<string, { snapshot_id: string; track_count: number }>;
  onPlaylistSynced?: PlaylistSyncedCallback;
}

// Batch sizes
const FAVORITE_BATCH_SIZE = 25;

export class ProgressTracker {
  current_playlist = '';
  current_playlist_index = 0;
  total_playlists = 0;
  playlists_skipped = 0;
  current_track_index = 0;
  total_tracks = 0;
  tracks_matched = 0;
  tracks_not_matched = 0;
  isrc_matches = 0;
  fuzzy_matches = 0;
  recent_missing: MissingTrack[] = [];
  private maxRecentMissing = 20;
  private callback?: ProgressCallback;

  constructor(callback?: ProgressCallback, initialRecentMissing?: MissingTrack[]) {
    this.callback = callback;
    if (initialRecentMissing) {
      this.recent_missing = initialRecentMissing.slice(-this.maxRecentMissing);
    }
  }

  update(updates: Partial<SyncProgress>): void {
    Object.assign(this, updates);
    if (this.callback) {
      this.callback(this.toDict());
    }
  }

  addMissingTrack(track: MissingTrack): void {
    this.recent_missing.push(track);
    if (this.recent_missing.length > this.maxRecentMissing) {
      this.recent_missing.shift();
    }
  }

  toDict(): SyncProgress {
    return {
      current_playlist: this.current_playlist,
      current_playlist_index: this.current_playlist_index,
      total_playlists: this.total_playlists,
      playlists_skipped: this.playlists_skipped,
      current_track_index: this.current_track_index,
      total_tracks: this.total_tracks,
      tracks_matched: this.tracks_matched,
      tracks_not_matched: this.tracks_not_matched,
      isrc_matches: this.isrc_matches,
      fuzzy_matches: this.fuzzy_matches,
      percent_complete: this.calculatePercent(),
      recent_missing: this.recent_missing,
    };
  }

  private calculatePercent(): number {
    if (this.total_playlists === 0) return 0;

    // For single playlist (favorites), just use track progress
    if (this.total_playlists === 1) {
      if (this.total_tracks > 0) {
        return (this.current_track_index / this.total_tracks) * 100;
      }
      return 0;
    }

    // For multiple playlists
    const completedPlaylists = Math.max(0, this.current_playlist_index - 1);
    const playlistPercent = (completedPlaylists / this.total_playlists) * 100;

    if (this.total_tracks > 0) {
      const trackPercent = (this.current_track_index / this.total_tracks) * 100;
      const currentPlaylistContrib = trackPercent / this.total_playlists;
      return Math.min(playlistPercent + currentPlaylistContrib, 100);
    }

    return playlistPercent;
  }
}

export class AsyncSyncService {
  private spotifyClient: SpotifyClient;
  private qobuzClient: QobuzClient;
  private matcher: TrackMatcher;
  private progress: ProgressTracker;
  private cancelled = false;
  private checkCancelled?: CancellationChecker;
  private lastCancellationCheck = 0;
  private cancellationCheckInterval = 2000; // Check every 2 seconds

  constructor(
    spotifyClient: SpotifyClient,
    qobuzClient: QobuzClient,
    progressCallback?: ProgressCallback,
    cancellationChecker?: CancellationChecker,
    initialRecentMissing?: MissingTrack[]
  ) {
    this.spotifyClient = spotifyClient;
    this.qobuzClient = qobuzClient;
    this.matcher = new TrackMatcher(qobuzClient);
    this.progress = new ProgressTracker(progressCallback, initialRecentMissing);
    this.checkCancelled = cancellationChecker;
  }

  cancel(): void {
    this.cancelled = true;
    logger.info('Sync cancellation requested');
  }

  /**
   * Check if sync has been cancelled (from internal flag or external checker).
   * Throttled to avoid excessive DB queries.
   */
  private async isCancelled(): Promise<boolean> {
    if (this.cancelled) return true;

    if (this.checkCancelled) {
      const now = Date.now();
      if (now - this.lastCancellationCheck >= this.cancellationCheckInterval) {
        this.lastCancellationCheck = now;
        const cancelled = await this.checkCancelled();
        if (cancelled) {
          this.cancelled = true;
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Sync playlists from Spotify to Qobuz.
   */
  async syncPlaylists(
    playlistIds?: string[],
    dryRun: boolean = false,
    options?: PlaylistSyncOptions
  ): Promise<SyncReport> {
    const report: SyncReport = {
      started_at: new Date().toISOString(),
      completed_at: null,
      tracks_matched: 0,
      tracks_not_matched: 0,
      tracks_skipped: 0,
      tracks_already_in_qobuz: 0,
      playlists_skipped: 0,
      isrc_matches: 0,
      fuzzy_matches: 0,
      missing_tracks: [],
      synced_tracks: [],
      errors: [],
    };

    try {
      let playlists = await this.spotifyClient.listPlaylists();

      if (playlistIds) {
        playlists = playlists.filter(p => playlistIds.includes(p.id));
      }

      this.progress.update({ total_playlists: playlists.length });

      for (let i = 0; i < playlists.length; i++) {
        const playlist = playlists[i];

        // Check if we should skip this playlist (unchanged snapshot_id)
        if (options?.skipUnchanged) {
          const syncedPlaylist = options.syncedPlaylistsMap.get(playlist.id);
          if (syncedPlaylist && syncedPlaylist.snapshot_id === playlist.snapshot_id) {
            logger.info(`Skipping unchanged playlist: ${playlist.name} (snapshot: ${playlist.snapshot_id})`);
            report.playlists_skipped++;
            this.progress.update({
              current_playlist: `${playlist.name} (skipped - unchanged)`,
              current_playlist_index: i + 1,
              playlists_skipped: report.playlists_skipped,
              current_track_index: 0,
              total_tracks: 0,
            });
            continue;
          }
        }

        this.progress.update({
          current_playlist: playlist.name,
          current_playlist_index: i + 1,
          current_track_index: 0,
          total_tracks: playlist.tracks_count,
        });

        try {
          await this.syncSinglePlaylist(playlist, report, dryRun);

          // Mark playlist as synced after successful sync
          if (!dryRun && options?.onPlaylistSynced) {
            await options.onPlaylistSynced(playlist.id, playlist.snapshot_id, playlist.tracks_count);
          }
        } catch (error) {
          logger.error(`Error syncing playlist ${playlist.name}: ${error}`);
          report.errors.push(`Playlist ${playlist.name}: ${String(error)}`);
        }
      }

      report.completed_at = new Date().toISOString();
      this.progress.update({ current_playlist_index: playlists.length });
    } catch (error) {
      logger.error(`Sync failed: ${error}`);
      report.errors.push(String(error));
      report.completed_at = new Date().toISOString();
    }

    return report;
  }

  private async syncSinglePlaylist(
    playlist: { id: string; name: string },
    report: SyncReport,
    dryRun: boolean
  ): Promise<void> {
    const spotifyTracks = await this.spotifyClient.listTracks(playlist.id);
    if (spotifyTracks.length === 0) return;

    const qobuzPlaylistName = `${playlist.name} (from Spotify)`;
    let qobuzPlaylistId: string | null = null;
    const existingTrackIds = new Set<number>();

    if (!dryRun) {
      const existingPlaylist = await this.qobuzClient.findPlaylistByName(qobuzPlaylistName);
      if (existingPlaylist) {
        qobuzPlaylistId = existingPlaylist.id;
        const trackIds = await this.qobuzClient.getPlaylistTracks(qobuzPlaylistId);
        trackIds.forEach(id => existingTrackIds.add(id));
      } else {
        qobuzPlaylistId = await this.qobuzClient.createPlaylist(
          qobuzPlaylistName,
          `Synced from Spotify on ${new Date().toISOString().split('T')[0]}`
        );
      }
    }

    const tracksToAdd: number[] = [];

    for (let i = 0; i < spotifyTracks.length; i++) {
      const track = spotifyTracks[i];
      this.progress.update({ current_track_index: i + 1 });

      const matchResult = await this.matcher.matchTrack(track);

      if (matchResult) {
        report.tracks_matched++;
        this.progress.update({ tracks_matched: report.tracks_matched });

        if (matchResult.matchType === 'isrc') {
          report.isrc_matches++;
          this.progress.update({ isrc_matches: report.isrc_matches });
        } else {
          report.fuzzy_matches++;
          this.progress.update({ fuzzy_matches: report.fuzzy_matches });
        }

        const qobuzTrackId = matchResult.qobuzTrack.id;
        if (!existingTrackIds.has(qobuzTrackId)) {
          tracksToAdd.push(qobuzTrackId);
          existingTrackIds.add(qobuzTrackId);
        }
      } else {
        report.tracks_not_matched++;
        this.progress.update({ tracks_not_matched: report.tracks_not_matched });
        const missingTrack: MissingTrack = {
          spotify_id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          suggestions: [],
        };
        report.missing_tracks.push(missingTrack);
        this.progress.addMissingTrack(missingTrack);
        this.progress.update({});
      }
    }

    // Add tracks to playlist
    if (!dryRun && qobuzPlaylistId) {
      for (const trackId of tracksToAdd) {
        try {
          await this.qobuzClient.addTrack(qobuzPlaylistId, trackId);
        } catch (error) {
          logger.error(`Failed to add track ${trackId} to playlist: ${error}`);
          // Continue with other tracks even if one fails
        }
      }
    }
  }

  /**
   * Sync saved tracks from Spotify to Qobuz favorites.
   */
  async syncFavorites(
    dryRun: boolean = false,
    alreadySynced: Set<string> = new Set(),
    onTrackSynced?: TrackSyncedCallback
  ): Promise<SyncReport> {
    const report: SyncReport = {
      started_at: new Date().toISOString(),
      completed_at: null,
      tracks_matched: 0,
      tracks_not_matched: 0,
      tracks_skipped: 0,
      tracks_already_in_qobuz: 0,
      playlists_skipped: 0,
      isrc_matches: 0,
      fuzzy_matches: 0,
      missing_tracks: [],
      synced_tracks: [],
      errors: [],
    };

    try {
      // Pre-fetch Qobuz favorites with ISRCs
      logger.info('Pre-fetching Qobuz favorites for diff computation...');
      const qobuzIsrcMap = await this.qobuzClient.getFavoriteTracksWithIsrc();
      const existingFavorites = new Set(qobuzIsrcMap.values());

      // Pass ISRC map to matcher for instant lookups
      this.matcher.setIsrcMap(qobuzIsrcMap);

      this.progress.update({
        total_playlists: 1,
        current_playlist: 'Saved Tracks',
        current_playlist_index: 1,
        total_tracks: 0,
      });

      let trackIndex = 0;
      const pendingFavorites: Array<{ spotify_id: string; qobuz_id: number }> = [];

      const flushFavorites = async () => {
        if (pendingFavorites.length > 0 && !dryRun) {
          const trackIds = pendingFavorites.map(f => f.qobuz_id);
          const currentBatch = [...pendingFavorites];

          try {
            await this.qobuzClient.addFavoriteTracksBatch(trackIds);
            for (const f of currentBatch) {
              if (onTrackSynced) {
                onTrackSynced(f.spotify_id, String(f.qobuz_id));
              }
            }
          } catch (error) {
            logger.error(`Failed to add ${trackIds.length} tracks to Qobuz favorites: ${error}`);
            report.errors.push(`Failed to add batch of ${trackIds.length} tracks to Qobuz: ${error}`);
            // Don't mark failed tracks as synced - they'll be retried on next sync
          }

          pendingFavorites.length = 0;
        }
      };

      // Stream tracks from Spotify
      for await (const { track, spotifyId, total } of this.spotifyClient.iterSavedTracks()) {
        if (await this.isCancelled()) {
          logger.info('Sync cancelled by user');
          report.errors.push('Cancelled by user');
          break;
        }

        if (trackIndex === 0) {
          this.progress.update({ total_tracks: total });
        }

        trackIndex++;

        // Skip already synced
        if (alreadySynced.has(spotifyId)) {
          report.tracks_skipped++;
          continue;
        }

        // Fast path: check if ISRC already exists in Qobuz favorites
        if (track.isrc && qobuzIsrcMap.has(track.isrc)) {
          report.tracks_already_in_qobuz++;
          report.tracks_matched++;
          report.isrc_matches++;
          this.progress.update({
            tracks_matched: report.tracks_matched,
            isrc_matches: report.isrc_matches,
          });
          continue;
        }

        // Match track
        const [matchResult, suggestions] = await this.matcher.matchTrackWithSuggestions(track);

        if (matchResult) {
          report.tracks_matched++;
          this.progress.update({ tracks_matched: report.tracks_matched });

          if (matchResult.matchType === 'isrc') {
            report.isrc_matches++;
            this.progress.update({ isrc_matches: report.isrc_matches });
          } else {
            report.fuzzy_matches++;
            this.progress.update({ fuzzy_matches: report.fuzzy_matches });
          }

          const qobuzTrackId = matchResult.qobuzTrack.id;

          if (!existingFavorites.has(qobuzTrackId)) {
            pendingFavorites.push({ spotify_id: spotifyId, qobuz_id: qobuzTrackId });
            existingFavorites.add(qobuzTrackId);
          }

          report.synced_tracks.push({ spotify_id: spotifyId, qobuz_id: String(qobuzTrackId) });
        } else {
          report.tracks_not_matched++;
          this.progress.update({ tracks_not_matched: report.tracks_not_matched });

          const missingTrack: MissingTrack = {
            spotify_id: spotifyId,
            title: track.title,
            artist: track.artist,
            album: track.album,
            suggestions,
          };
          report.missing_tracks.push(missingTrack);
          this.progress.addMissingTrack(missingTrack);
          this.progress.update({});
        }

        // Flush favorites in batches
        if (pendingFavorites.length >= FAVORITE_BATCH_SIZE) {
          await flushFavorites();
        }

        this.progress.update({ current_track_index: trackIndex });
      }

      // Flush remaining
      await flushFavorites();

      report.completed_at = new Date().toISOString();
    } catch (error) {
      logger.error(`Favorites sync failed: ${error}`);
      report.errors.push(String(error));
      report.completed_at = new Date().toISOString();
    }

    return report;
  }

  /**
   * Sync saved albums from Spotify to Qobuz favorites.
   */
  async syncAlbums(
    dryRun: boolean = false,
    alreadySynced: Set<string> = new Set(),
    onAlbumSynced?: TrackSyncedCallback
  ): Promise<AlbumSyncReport> {
    const report: AlbumSyncReport = {
      started_at: new Date().toISOString(),
      completed_at: null,
      albums_matched: 0,
      albums_not_matched: 0,
      albums_skipped: 0,
      albums_already_in_qobuz: 0,
      upc_matches: 0,
      fuzzy_matches: 0,
      missing_albums: [],
      synced_albums: [],
      errors: [],
    };

    try {
      // Pre-fetch Qobuz favorite albums with UPCs
      logger.info('Pre-fetching Qobuz favorite albums for diff computation...');
      const qobuzUpcMap = await this.qobuzClient.getFavoriteAlbumsWithUpc();
      const existingFavorites = new Set(qobuzUpcMap.values());

      this.progress.update({
        total_playlists: 1,
        current_playlist: 'Saved Albums',
        current_playlist_index: 1,
        total_tracks: 0,
      });

      let albumIndex = 0;
      const pendingFavorites: Array<{ spotify_id: string; qobuz_id: string }> = [];

      const flushAlbums = async () => {
        if (pendingFavorites.length > 0 && !dryRun) {
          const albumIds = pendingFavorites.map(f => f.qobuz_id);
          const currentBatch = [...pendingFavorites];

          try {
            await this.qobuzClient.addFavoriteAlbumsBatch(albumIds);
            for (const f of currentBatch) {
              if (onAlbumSynced) {
                onAlbumSynced(f.spotify_id, f.qobuz_id);
              }
            }
          } catch (error) {
            logger.error(`Failed to add ${albumIds.length} albums to Qobuz favorites: ${error}`);
            report.errors.push(`Failed to add batch of ${albumIds.length} albums to Qobuz: ${error}`);
            // Don't mark failed albums as synced - they'll be retried on next sync
          }

          pendingFavorites.length = 0;
        }
      };

      // Stream albums from Spotify
      for await (const { album, spotifyId, total } of this.spotifyClient.iterSavedAlbums()) {
        if (await this.isCancelled()) {
          logger.info('Album sync cancelled by user');
          report.errors.push('Cancelled by user');
          break;
        }

        if (albumIndex === 0) {
          this.progress.update({ total_tracks: total });
        }

        albumIndex++;

        // Skip already synced
        if (alreadySynced.has(spotifyId)) {
          report.albums_skipped++;
          continue;
        }

        // Fast path: check if UPC already exists in Qobuz favorites
        if (album.upc && qobuzUpcMap.has(album.upc)) {
          report.albums_already_in_qobuz++;
          report.albums_matched++;
          report.upc_matches++;
          this.progress.update({
            tracks_matched: report.albums_matched,
            isrc_matches: report.upc_matches,
          });
          continue;
        }

        // Match album
        const matchResult = await this.matchAlbum(album, qobuzUpcMap, existingFavorites);

        if (matchResult) {
          report.albums_matched++;
          this.progress.update({ tracks_matched: report.albums_matched });

          if (matchResult.matchType === 'upc') {
            report.upc_matches++;
            this.progress.update({ isrc_matches: report.upc_matches });
          } else {
            report.fuzzy_matches++;
            this.progress.update({ fuzzy_matches: report.fuzzy_matches });
          }

          if (!existingFavorites.has(matchResult.qobuzId)) {
            pendingFavorites.push({ spotify_id: spotifyId, qobuz_id: matchResult.qobuzId });
            existingFavorites.add(matchResult.qobuzId);
          }

          report.synced_albums.push({ spotify_id: spotifyId, qobuz_id: matchResult.qobuzId });
        } else {
          report.albums_not_matched++;
          this.progress.update({ tracks_not_matched: report.albums_not_matched });

          // Get suggestions
          const suggestions = await this.getAlbumSuggestions(album);

          const missingAlbum: MissingTrack = {
            spotify_id: spotifyId,
            title: album.title,
            artist: album.artist,
            album: '',
            suggestions,
          };
          report.missing_albums.push(missingAlbum);
          this.progress.addMissingTrack(missingAlbum);
          this.progress.update({});
        }

        // Flush favorites in batches
        if (pendingFavorites.length >= FAVORITE_BATCH_SIZE) {
          await flushAlbums();
        }

        this.progress.update({ current_track_index: albumIndex });
      }

      // Flush remaining
      await flushAlbums();

      report.completed_at = new Date().toISOString();
    } catch (error) {
      logger.error(`Album sync failed: ${error}`);
      report.errors.push(String(error));
      report.completed_at = new Date().toISOString();
    }

    return report;
  }

  /**
   * Sync a chunk of saved tracks from Spotify to Qobuz favorites.
   * Processes up to chunkSize items starting from the given offset.
   * Returns a ChunkResult indicating if there are more items to process.
   */
  async syncFavoritesChunk(
    offset: number,
    chunkSize: number = 50,
    dryRun: boolean = false,
    alreadySynced: Set<string> = new Set(),
    onTrackSynced?: TrackSyncedCallback
  ): Promise<ChunkResult> {
    const partialReport: Partial<SyncReport> = {
      started_at: new Date().toISOString(),
      completed_at: null,
      tracks_matched: 0,
      tracks_not_matched: 0,
      tracks_skipped: 0,
      tracks_already_in_qobuz: 0,
      isrc_matches: 0,
      fuzzy_matches: 0,
      missing_tracks: [],
      synced_tracks: [],
      errors: [],
    };

    let processedInChunk = 0;
    let totalItems = 0;
    let nextOffset = offset;

    try {
      // Pre-fetch Qobuz favorites with ISRCs
      logger.info(`Pre-fetching Qobuz favorites for chunk starting at ${offset}...`);
      const qobuzIsrcMap = await this.qobuzClient.getFavoriteTracksWithIsrc();
      const existingFavorites = new Set(qobuzIsrcMap.values());

      // Pass ISRC map to matcher for instant lookups
      this.matcher.setIsrcMap(qobuzIsrcMap);

      this.progress.update({
        total_playlists: 1,
        current_playlist: 'Saved Tracks',
        current_playlist_index: 1,
      });

      const pendingFavorites: Array<{ spotify_id: string; qobuz_id: number }> = [];

      const flushFavorites = async () => {
        if (pendingFavorites.length > 0 && !dryRun) {
          const trackIds = pendingFavorites.map(f => f.qobuz_id);
          const currentBatch = [...pendingFavorites];

          try {
            await this.qobuzClient.addFavoriteTracksBatch(trackIds);
            for (const f of currentBatch) {
              if (onTrackSynced) {
                onTrackSynced(f.spotify_id, String(f.qobuz_id));
              }
            }
          } catch (error) {
            logger.error(`Failed to add ${trackIds.length} tracks to Qobuz favorites: ${error}`);
            partialReport.errors!.push(`Failed to add batch of ${trackIds.length} tracks to Qobuz: ${error}`);
          }

          pendingFavorites.length = 0;
        }
      };

      // Stream tracks from Spotify starting at offset
      for await (const { track, spotifyId, total } of this.spotifyClient.iterSavedTracks(offset)) {
        if (await this.isCancelled()) {
          logger.info('Chunk sync cancelled by user');
          partialReport.errors!.push('Cancelled by user');
          break;
        }

        totalItems = total;

        // Check if we've processed enough for this chunk
        if (processedInChunk >= chunkSize) {
          break;
        }

        nextOffset++;
        processedInChunk++;

        this.progress.update({
          total_tracks: total,
          current_track_index: nextOffset,
        });

        // Skip already synced
        if (alreadySynced.has(spotifyId)) {
          partialReport.tracks_skipped!++;
          continue;
        }

        // Fast path: check if ISRC already exists in Qobuz favorites
        if (track.isrc && qobuzIsrcMap.has(track.isrc)) {
          partialReport.tracks_already_in_qobuz!++;
          partialReport.tracks_matched!++;
          partialReport.isrc_matches!++;
          this.progress.update({
            tracks_matched: this.progress.tracks_matched + 1,
            isrc_matches: this.progress.isrc_matches + 1,
          });
          continue;
        }

        // Match track
        const [matchResult, suggestions] = await this.matcher.matchTrackWithSuggestions(track);

        if (matchResult) {
          partialReport.tracks_matched!++;
          this.progress.update({ tracks_matched: this.progress.tracks_matched + 1 });

          if (matchResult.matchType === 'isrc') {
            partialReport.isrc_matches!++;
            this.progress.update({ isrc_matches: this.progress.isrc_matches + 1 });
          } else {
            partialReport.fuzzy_matches!++;
            this.progress.update({ fuzzy_matches: this.progress.fuzzy_matches + 1 });
          }

          const qobuzTrackId = matchResult.qobuzTrack.id;

          if (!existingFavorites.has(qobuzTrackId)) {
            pendingFavorites.push({ spotify_id: spotifyId, qobuz_id: qobuzTrackId });
            existingFavorites.add(qobuzTrackId);
          }

          partialReport.synced_tracks!.push({ spotify_id: spotifyId, qobuz_id: String(qobuzTrackId) });
        } else {
          partialReport.tracks_not_matched!++;
          this.progress.update({ tracks_not_matched: this.progress.tracks_not_matched + 1 });

          const missingTrack: MissingTrack = {
            spotify_id: spotifyId,
            title: track.title,
            artist: track.artist,
            album: track.album,
            suggestions,
          };
          partialReport.missing_tracks!.push(missingTrack);
          this.progress.addMissingTrack(missingTrack);
          this.progress.update({});
        }

        // Flush favorites in batches
        if (pendingFavorites.length >= FAVORITE_BATCH_SIZE) {
          await flushFavorites();
        }
      }

      // Flush remaining
      await flushFavorites();

      partialReport.completed_at = new Date().toISOString();
    } catch (error) {
      logger.error(`Favorites chunk sync failed: ${error}`);
      partialReport.errors!.push(String(error));
      partialReport.completed_at = new Date().toISOString();
    }

    const hasMore = nextOffset < totalItems;
    logger.info(`Chunk complete: processed ${processedInChunk}, nextOffset=${nextOffset}, total=${totalItems}, hasMore=${hasMore}`);

    return {
      hasMore,
      nextOffset,
      totalItems,
      processedInChunk,
      partialReport,
    };
  }

  /**
   * Sync a chunk of saved albums from Spotify to Qobuz favorites.
   * Processes up to chunkSize items starting from the given offset.
   * Returns a ChunkResult indicating if there are more items to process.
   */
  async syncAlbumsChunk(
    offset: number,
    chunkSize: number = 50,
    dryRun: boolean = false,
    alreadySynced: Set<string> = new Set(),
    onAlbumSynced?: TrackSyncedCallback
  ): Promise<ChunkResult> {
    const partialReport: Partial<AlbumSyncReport> = {
      started_at: new Date().toISOString(),
      completed_at: null,
      albums_matched: 0,
      albums_not_matched: 0,
      albums_skipped: 0,
      albums_already_in_qobuz: 0,
      upc_matches: 0,
      fuzzy_matches: 0,
      missing_albums: [],
      synced_albums: [],
      errors: [],
    };

    let processedInChunk = 0;
    let totalItems = 0;
    let nextOffset = offset;

    try {
      // Pre-fetch Qobuz favorite albums with UPCs
      logger.info(`Pre-fetching Qobuz favorite albums for chunk starting at ${offset}...`);
      const qobuzUpcMap = await this.qobuzClient.getFavoriteAlbumsWithUpc();
      const existingFavorites = new Set(qobuzUpcMap.values());

      this.progress.update({
        total_playlists: 1,
        current_playlist: 'Saved Albums',
        current_playlist_index: 1,
      });

      const pendingFavorites: Array<{ spotify_id: string; qobuz_id: string }> = [];

      const flushAlbums = async () => {
        if (pendingFavorites.length > 0 && !dryRun) {
          const albumIds = pendingFavorites.map(f => f.qobuz_id);
          const currentBatch = [...pendingFavorites];

          try {
            await this.qobuzClient.addFavoriteAlbumsBatch(albumIds);
            for (const f of currentBatch) {
              if (onAlbumSynced) {
                onAlbumSynced(f.spotify_id, f.qobuz_id);
              }
            }
          } catch (error) {
            logger.error(`Failed to add ${albumIds.length} albums to Qobuz favorites: ${error}`);
            partialReport.errors!.push(`Failed to add batch of ${albumIds.length} albums to Qobuz: ${error}`);
          }

          pendingFavorites.length = 0;
        }
      };

      // Stream albums from Spotify starting at offset
      for await (const { album, spotifyId, total } of this.spotifyClient.iterSavedAlbums(offset)) {
        if (await this.isCancelled()) {
          logger.info('Album chunk sync cancelled by user');
          partialReport.errors!.push('Cancelled by user');
          break;
        }

        totalItems = total;

        // Check if we've processed enough for this chunk
        if (processedInChunk >= chunkSize) {
          break;
        }

        nextOffset++;
        processedInChunk++;

        this.progress.update({
          total_tracks: total,
          current_track_index: nextOffset,
        });

        // Skip already synced
        if (alreadySynced.has(spotifyId)) {
          partialReport.albums_skipped!++;
          continue;
        }

        // Fast path: check if UPC already exists in Qobuz favorites
        if (album.upc && qobuzUpcMap.has(album.upc)) {
          partialReport.albums_already_in_qobuz!++;
          partialReport.albums_matched!++;
          partialReport.upc_matches!++;
          this.progress.update({
            tracks_matched: this.progress.tracks_matched + 1,
            isrc_matches: this.progress.isrc_matches + 1,
          });
          continue;
        }

        // Match album
        const matchResult = await this.matchAlbum(album, qobuzUpcMap, existingFavorites);

        if (matchResult) {
          partialReport.albums_matched!++;
          this.progress.update({ tracks_matched: this.progress.tracks_matched + 1 });

          if (matchResult.matchType === 'upc') {
            partialReport.upc_matches!++;
            this.progress.update({ isrc_matches: this.progress.isrc_matches + 1 });
          } else {
            partialReport.fuzzy_matches!++;
            this.progress.update({ fuzzy_matches: this.progress.fuzzy_matches + 1 });
          }

          if (!existingFavorites.has(matchResult.qobuzId)) {
            pendingFavorites.push({ spotify_id: spotifyId, qobuz_id: matchResult.qobuzId });
            existingFavorites.add(matchResult.qobuzId);
          }

          partialReport.synced_albums!.push({ spotify_id: spotifyId, qobuz_id: matchResult.qobuzId });
        } else {
          partialReport.albums_not_matched!++;
          this.progress.update({ tracks_not_matched: this.progress.tracks_not_matched + 1 });

          // Get suggestions
          const suggestions = await this.getAlbumSuggestions(album);

          const missingAlbum: MissingTrack = {
            spotify_id: spotifyId,
            title: album.title,
            artist: album.artist,
            album: '',
            suggestions,
          };
          partialReport.missing_albums!.push(missingAlbum);
          this.progress.addMissingTrack(missingAlbum);
          this.progress.update({});
        }

        // Flush favorites in batches
        if (pendingFavorites.length >= FAVORITE_BATCH_SIZE) {
          await flushAlbums();
        }
      }

      // Flush remaining
      await flushAlbums();

      partialReport.completed_at = new Date().toISOString();
    } catch (error) {
      logger.error(`Album chunk sync failed: ${error}`);
      partialReport.errors!.push(String(error));
      partialReport.completed_at = new Date().toISOString();
    }

    const hasMore = nextOffset < totalItems;
    logger.info(`Album chunk complete: processed ${processedInChunk}, nextOffset=${nextOffset}, total=${totalItems}, hasMore=${hasMore}`);

    return {
      hasMore,
      nextOffset,
      totalItems,
      processedInChunk,
      partialReport,
    };
  }

  private async matchAlbum(
    spotifyAlbum: SpotifyAlbum,
    qobuzUpcMap: Map<string, string>,
    existingFavorites: Set<string>
  ): Promise<{ qobuzId: string; matchType: 'upc' | 'fuzzy' } | null> {
    // Try UPC match via search API
    if (spotifyAlbum.upc) {
      const qobuzAlbum = await this.qobuzClient.searchAlbumByUpc(spotifyAlbum.upc);
      if (qobuzAlbum) {
        return { qobuzId: qobuzAlbum.id, matchType: 'upc' };
      }
    }

    // Get all title variants to try
    const titleVariants = getAlbumTitleVariants(spotifyAlbum.title);
    const allCandidates: QobuzAlbum[] = [];
    const seenIds = new Set<string>();

    // Search with each title variant
    for (const titleVariant of titleVariants) {
      const candidates = await this.qobuzClient.searchAlbum(titleVariant, spotifyAlbum.artist);
      for (const candidate of candidates) {
        if (!seenIds.has(candidate.id)) {
          seenIds.add(candidate.id);
          allCandidates.push(candidate);
        }
      }

      // Also try with just the artist if we haven't found enough candidates
      if (allCandidates.length < 5 && titleVariant !== spotifyAlbum.title) {
        const artistOnlyCandidates = await this.qobuzClient.searchAlbum('', spotifyAlbum.artist);
        for (const candidate of artistOnlyCandidates) {
          if (!seenIds.has(candidate.id)) {
            seenIds.add(candidate.id);
            allCandidates.push(candidate);
          }
        }
      }
    }

    // Find best match across all candidates using all title variants
    if (allCandidates.length > 0) {
      const bestMatch = this.findBestAlbumMatch(spotifyAlbum, allCandidates, titleVariants);
      if (bestMatch) {
        return { qobuzId: bestMatch.id, matchType: 'fuzzy' };
      }
    }

    return null;
  }

  private findBestAlbumMatch(
    spotifyAlbum: SpotifyAlbum,
    candidates: QobuzAlbum[],
    titleVariants?: string[]
  ): QobuzAlbum | null {
    const spotifyArtist = spotifyAlbum.artist.toLowerCase();

    // Use provided variants or generate them
    const spotifyTitleVariants = (titleVariants || getAlbumTitleVariants(spotifyAlbum.title))
      .map(t => t.toLowerCase());

    let bestMatch: QobuzAlbum | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const candidateTitle = candidate.title.toLowerCase();

      // Get variants of the candidate title too for cross-matching
      const candidateTitleVariants = getAlbumTitleVariants(candidate.title)
        .map(t => t.toLowerCase());

      // Find best title score across all variant combinations
      let titleScore = 0;
      for (const spotifyVariant of spotifyTitleVariants) {
        for (const candidateVariant of candidateTitleVariants) {
          const score = bestFuzzyScore(spotifyVariant, candidateVariant);
          if (score > titleScore) {
            titleScore = score;
          }
        }
      }

      // Artist score
      const artistScore = bestFuzzyScore(spotifyArtist, candidate.artist.toLowerCase());

      // Weighted average favoring title
      let combinedScore = titleScore * 0.6 + artistScore * 0.4;

      // Bonus for matching release year
      if (spotifyAlbum.release_year && candidate.release_year) {
        if (spotifyAlbum.release_year === candidate.release_year) {
          combinedScore += 10;
        }
      }

      // Bonus for similar track count (helps distinguish deluxe from standard)
      if (spotifyAlbum.total_tracks && candidate.tracks_count) {
        const trackDiff = Math.abs(spotifyAlbum.total_tracks - candidate.tracks_count);
        if (trackDiff === 0) {
          combinedScore += 5;
        } else if (trackDiff <= 2) {
          combinedScore += 2;
        } else if (trackDiff <= 4) {
          combinedScore += 1;
        }
      }

      // Log high-scoring matches for debugging
      if (combinedScore >= 70) {
        logger.debug(
          `Album candidate: "${candidate.title}" by ${candidate.artist} ` +
          `(title=${titleScore.toFixed(0)}, artist=${artistScore.toFixed(0)}, combined=${combinedScore.toFixed(0)})`
        );
      }

      if (combinedScore > bestScore && combinedScore >= 70) {
        bestScore = combinedScore;
        bestMatch = candidate;
      }
    }

    if (bestMatch) {
      logger.info(
        `Album match: "${spotifyAlbum.title}" -> "${bestMatch.title}" (score=${bestScore.toFixed(0)})`
      );
    }

    return bestMatch;
  }

  private async getAlbumSuggestions(spotifyAlbum: SpotifyAlbum): Promise<Suggestion[]> {
    const candidates = await this.qobuzClient.searchAlbum(spotifyAlbum.title, spotifyAlbum.artist);
    if (candidates.length === 0) {
      // Try artist-only search
      const artistCandidates = await this.qobuzClient.searchAlbum('', spotifyAlbum.artist);
      if (artistCandidates.length === 0) return [];
      return this.buildAlbumSuggestions(spotifyAlbum, artistCandidates.slice(0, 5));
    }
    return this.buildAlbumSuggestions(spotifyAlbum, candidates.slice(0, 5));
  }

  private buildAlbumSuggestions(spotifyAlbum: SpotifyAlbum, candidates: QobuzAlbum[]): Suggestion[] {
    const spotifyArtist = spotifyAlbum.artist.toLowerCase();

    // Get all title variants for comprehensive matching
    const spotifyTitleVariants = getAlbumTitleVariants(spotifyAlbum.title)
      .map(t => t.toLowerCase());

    // Minimum title score to include a suggestion - prevents showing completely
    // unrelated albums by the same artist (e.g., "Macadelic" suggesting "Circles")
    const MIN_TITLE_SCORE_FOR_ALBUM_SUGGESTION = 50;
    const MIN_ARTIST_SCORE_FOR_ALBUM_SUGGESTION = 60;

    const suggestions: Suggestion[] = [];

    for (const candidate of candidates) {
      const candidateTitleVariants = getAlbumTitleVariants(candidate.title)
        .map(t => t.toLowerCase());
      const candidateArtist = candidate.artist.toLowerCase();

      // Find best title score across all variant combinations
      let titleScore = 0;
      for (const spotifyVariant of spotifyTitleVariants) {
        for (const candidateVariant of candidateTitleVariants) {
          const score = bestFuzzyScore(spotifyVariant, candidateVariant);
          if (score > titleScore) {
            titleScore = score;
          }
        }
      }

      const artistScore = bestFuzzyScore(spotifyArtist, candidateArtist);

      // Filter out suggestions with low title match - we don't want to suggest
      // completely different albums just because the artist matches
      if (titleScore < MIN_TITLE_SCORE_FOR_ALBUM_SUGGESTION ||
          artistScore < MIN_ARTIST_SCORE_FOR_ALBUM_SUGGESTION) {
        continue;
      }

      // Weight title more heavily (70-30) for album suggestions since users
      // are looking for specific albums, not just any album by the artist
      const combinedScore = Math.round(titleScore * 0.7 + artistScore * 0.3);

      suggestions.push({
        qobuz_id: parseInt(candidate.id),
        title: candidate.title,
        artist: candidate.artist,
        album: candidate.title,
        title_score: titleScore,
        artist_score: artistScore,
        score: combinedScore,
        duration_diff_sec: 0,
      });
    }

    // Sort by combined score (which now prioritizes title match)
    suggestions.sort((a, b) => b.score - a.score);
    return suggestions.slice(0, 5);
  }
}

// Re-export types
export type { SyncProgress, SyncReport, AlbumSyncReport, MissingTrack, ProgressCallback, TrackSyncedCallback, PlaylistSyncedCallback };
