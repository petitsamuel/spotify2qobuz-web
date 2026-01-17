/**
 * Async sync service with progress callbacks.
 * Equivalent to Python's src/async_sync.py
 */

import { logger } from '../lib/logger';
import { SpotifyClient, SpotifyTrack, SpotifyAlbum } from './spotify';
import { QobuzClient, QobuzAlbum } from './qobuz';
import { TrackMatcher, MatchResult, Suggestion, fuzzyRatio } from './matcher';

// Edition patterns to strip when searching for base albums
const EDITION_PATTERNS = [
  /\s*\(Deluxe\s*Edition?\)/i,
  /\s*\(Super\s*Deluxe\)/i,
  /\s*\(Deluxe\)/i,
  /\s*\(Expanded\s*Edition?\)/i,
  /\s*\(Special\s*Edition?\)/i,
  /\s*\(Anniversary\s*Edition?\)/i,
  /\s*\(\d+(?:th|st|nd|rd)?\s*Anniversary[^)]*\)/i,
  /\s*\(Remaster(?:ed)?\)/i,
  /\s*\(Remastered\s*\d{4}\)/i,
  /\s*\(Acoustic\)/i,
  /\s*\(Instrumentals?\)/i,
  /\s*\(Live[^)]*\)/i,
  /\s*\(Bonus\s*Track[^)]*\)/i,
  /\s*\(Complete[^)]*\)/i,
  /\s*\(Music\s+for[^)]*\)/i,
  /\s*-\s*Deluxe\s*$/i,
  /\s*-\s*Remastered\s*$/i,
];

function stripEditionSuffix(title: string): string {
  let result = title;
  for (const pattern of EDITION_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result.trim();
}

export interface MissingTrack {
  spotify_id: string;
  title: string;
  artist: string;
  album: string;
  suggestions: Suggestion[];
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

type ProgressCallback = (progress: SyncProgress) => void;
type TrackSyncedCallback = (spotifyId: string, qobuzId: string) => void;

export class ProgressTracker {
  current_playlist = '';
  current_playlist_index = 0;
  total_playlists = 0;
  current_track_index = 0;
  total_tracks = 0;
  tracks_matched = 0;
  tracks_not_matched = 0;
  isrc_matches = 0;
  fuzzy_matches = 0;
  recent_missing: MissingTrack[] = [];
  private maxRecentMissing = 20;
  private callback?: ProgressCallback;

  constructor(callback?: ProgressCallback) {
    this.callback = callback;
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

  constructor(
    spotifyClient: SpotifyClient,
    qobuzClient: QobuzClient,
    progressCallback?: ProgressCallback
  ) {
    this.spotifyClient = spotifyClient;
    this.qobuzClient = qobuzClient;
    this.matcher = new TrackMatcher(qobuzClient);
    this.progress = new ProgressTracker(progressCallback);
  }

  cancel(): void {
    this.cancelled = true;
    logger.info('Sync cancellation requested');
  }

  /**
   * Sync playlists from Spotify to Qobuz.
   */
  async syncPlaylists(
    playlistIds?: string[],
    dryRun: boolean = false
  ): Promise<SyncReport> {
    const report: SyncReport = {
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

    try {
      let playlists = await this.spotifyClient.listPlaylists();

      if (playlistIds) {
        playlists = playlists.filter(p => playlistIds.includes(p.id));
      }

      this.progress.update({ total_playlists: playlists.length });

      for (let i = 0; i < playlists.length; i++) {
        const playlist = playlists[i];
        this.progress.update({
          current_playlist: playlist.name,
          current_playlist_index: i + 1,
          current_track_index: 0,
          total_tracks: playlist.tracks_count,
        });

        try {
          await this.syncSinglePlaylist(playlist, report, dryRun);
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
        // createPlaylist now throws on error
        qobuzPlaylistId = await this.qobuzClient.createPlaylist(
          qobuzPlaylistName,
          `Synced from Spotify on ${new Date().toISOString().split('T')[0]}`
        );
      }
    }

    const tracksToAdd: number[] = [];

    // Process tracks (could parallelize with Promise.all in batches)
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
        report.missing_tracks.push({
          spotify_id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          suggestions: [],
        });
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
      isrc_matches: 0,
      fuzzy_matches: 0,
      missing_tracks: [],
      synced_tracks: [],
      errors: [],
    };

    const BATCH_SIZE = 50;
    const FAVORITE_BATCH = 25;

    try {
      // Pre-fetch Qobuz favorites with ISRCs
      logger.info('Pre-fetching Qobuz favorites for diff computation...');
      const qobuzIsrcMap = await this.qobuzClient.getFavoriteTracksWithIsrc();
      const existingFavorites = new Set(qobuzIsrcMap.values());

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
          const currentBatch = [...pendingFavorites]; // Copy before clearing
          const success = await this.qobuzClient.addFavoriteTracksBatch(trackIds);

          if (success) {
            for (const f of currentBatch) {
              if (onTrackSynced) {
                onTrackSynced(f.spotify_id, String(f.qobuz_id));
              }
            }
          } else {
            logger.error(`Failed to add ${trackIds.length} tracks to Qobuz favorites`);
            report.errors.push(`Failed to add batch of ${trackIds.length} tracks to Qobuz`);
            // Don't mark failed tracks as synced - they'll be retried on next sync
          }
          pendingFavorites.length = 0;
        }
      };

      // Stream tracks from Spotify
      for await (const { track, spotifyId, total } of this.spotifyClient.iterSavedTracks()) {
        if (this.cancelled) {
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
        if (pendingFavorites.length >= FAVORITE_BATCH) {
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

    const FAVORITE_BATCH = 25;

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
          const currentBatch = [...pendingFavorites]; // Copy before clearing
          const success = await this.qobuzClient.addFavoriteAlbumsBatch(albumIds);

          if (success) {
            for (const f of currentBatch) {
              if (onAlbumSynced) {
                onAlbumSynced(f.spotify_id, f.qobuz_id);
              }
            }
          } else {
            logger.error(`Failed to add ${albumIds.length} albums to Qobuz favorites`);
            report.errors.push(`Failed to add batch of ${albumIds.length} albums to Qobuz`);
            // Don't mark failed albums as synced - they'll be retried on next sync
          }
          pendingFavorites.length = 0;
        }
      };

      // Stream albums from Spotify
      for await (const { album, spotifyId, total } of this.spotifyClient.iterSavedAlbums()) {
        if (this.cancelled) {
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
        if (pendingFavorites.length >= FAVORITE_BATCH) {
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

    // Fuzzy match by title and artist
    const candidates = await this.qobuzClient.searchAlbum(spotifyAlbum.title, spotifyAlbum.artist);
    if (candidates.length > 0) {
      const bestMatch = this.findBestAlbumMatch(spotifyAlbum, candidates);
      if (bestMatch) {
        return { qobuzId: bestMatch.id, matchType: 'fuzzy' };
      }
    }

    // Fallback: try with stripped edition suffix
    const baseTitle = stripEditionSuffix(spotifyAlbum.title);
    if (baseTitle !== spotifyAlbum.title) {
      logger.debug(`Trying base title: '${baseTitle}' (was: '${spotifyAlbum.title}')`);
      const baseCandidates = await this.qobuzClient.searchAlbum(baseTitle, spotifyAlbum.artist);
      if (baseCandidates.length > 0) {
        const bestMatch = this.findBestAlbumMatch({ ...spotifyAlbum, title: baseTitle }, baseCandidates);
        if (bestMatch) {
          return { qobuzId: bestMatch.id, matchType: 'fuzzy' };
        }
      }
    }

    return null;
  }

  private findBestAlbumMatch(
    spotifyAlbum: SpotifyAlbum,
    candidates: QobuzAlbum[]
  ): QobuzAlbum | null {
    const spotifyTitle = spotifyAlbum.title.toLowerCase();
    const spotifyArtist = spotifyAlbum.artist.toLowerCase();

    let bestMatch: QobuzAlbum | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const titleScore = fuzzyRatio(spotifyTitle, candidate.title.toLowerCase());
      const artistScore = fuzzyRatio(spotifyArtist, candidate.artist.toLowerCase());

      // Weighted average favoring title
      let combinedScore = titleScore * 0.6 + artistScore * 0.4;

      // Bonus for matching release year
      if (spotifyAlbum.release_year && candidate.release_year) {
        if (spotifyAlbum.release_year === candidate.release_year) {
          combinedScore += 10;
        }
      }

      // Bonus for similar track count
      if (spotifyAlbum.total_tracks && candidate.tracks_count) {
        const trackDiff = Math.abs(spotifyAlbum.total_tracks - candidate.tracks_count);
        if (trackDiff === 0) {
          combinedScore += 5;
        } else if (trackDiff <= 2) {
          combinedScore += 2;
        }
      }

      if (combinedScore > bestScore && combinedScore >= 70) {
        bestScore = combinedScore;
        bestMatch = candidate;
      }
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
    const spotifyTitle = spotifyAlbum.title.toLowerCase();
    const spotifyArtist = spotifyAlbum.artist.toLowerCase();
    const baseTitle = stripEditionSuffix(spotifyAlbum.title).toLowerCase();

    const suggestions: Suggestion[] = [];

    for (const candidate of candidates) {
      const candidateTitle = candidate.title.toLowerCase();
      const candidateArtist = candidate.artist.toLowerCase();

      const titleScore = Math.max(
        fuzzyRatio(spotifyTitle, candidateTitle),
        fuzzyRatio(baseTitle, candidateTitle)
      );
      const artistScore = fuzzyRatio(spotifyArtist, candidateArtist);

      suggestions.push({
        qobuz_id: parseInt(candidate.id),
        title: candidate.title,
        artist: candidate.artist,
        album: candidate.title,
        title_score: titleScore,
        artist_score: artistScore,
        score: Math.round((titleScore + artistScore) / 2),
        duration_diff_sec: 0,
      });
    }

    suggestions.sort((a, b) => b.score - a.score);
    return suggestions.slice(0, 5);
  }
}
