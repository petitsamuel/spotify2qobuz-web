/**
 * Qobuz API client using token-based authentication.
 * Equivalent to Python's src/qobuz_client.py
 */

import { logger } from '../lib/logger';

export interface QobuzTrack {
  id: number;
  title: string;
  artist: string;
  album: string;
  duration: number;
  isrc?: string;
}

export interface QobuzAlbum {
  id: string;
  title: string;
  artist: string;
  release_year: string | null;
  tracks_count: number;
  upc?: string;
}

export interface QobuzPlaylist {
  id: string;
  name: string;
  tracks_count: number;
}

const QOBUZ_API_BASE = 'https://www.qobuz.com/api.json/0.2';
const QOBUZ_APP_ID = '798273057'; // App ID used by web player

/**
 * Adaptive rate limiter that slows down when rate limited.
 */
class AdaptiveRateLimiter {
  private delay: number;
  private initialDelay: number;
  private maxDelay: number;
  private consecutiveSuccesses: number = 0;
  private rateLimitedCount: number = 0;

  constructor(initialDelay: number = 0.1, maxDelay: number = 5.0) {
    this.delay = initialDelay;
    this.initialDelay = initialDelay;
    this.maxDelay = maxDelay;
  }

  async wait(): Promise<void> {
    if (this.delay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.delay * 1000));
    }
  }

  onSuccess(): void {
    this.consecutiveSuccesses++;
    // Speed up after 10 consecutive successes
    if (this.consecutiveSuccesses >= 10 && this.delay > this.initialDelay) {
      this.delay = Math.max(this.initialDelay, this.delay * 0.8);
      this.consecutiveSuccesses = 0;
      logger.debug(`Rate limiter: speeding up to ${this.delay.toFixed(2)}s delay`);
    }
  }

  onRateLimit(): void {
    this.consecutiveSuccesses = 0;
    this.rateLimitedCount++;
    this.delay = Math.min(this.maxDelay, this.delay * 2);
    logger.warn(`Rate limited! Slowing down to ${this.delay.toFixed(2)}s delay`);
  }

  getStats(): { currentDelay: number; rateLimitedCount: number } {
    return {
      currentDelay: this.delay,
      rateLimitedCount: this.rateLimitedCount,
    };
  }
}

export class QobuzClient {
  private userAuthToken: string;
  private userId: number | null = null;
  private userName: string | null = null;
  private rateLimiter: AdaptiveRateLimiter;

  constructor(userAuthToken: string) {
    this.userAuthToken = userAuthToken;
    this.rateLimiter = new AdaptiveRateLimiter(0.05, 5.0);
  }

  private get headers(): HeadersInit {
    return {
      'X-App-Id': QOBUZ_APP_ID,
      'X-User-Auth-Token': this.userAuthToken,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Origin': 'https://play.qobuz.com',
      'Referer': 'https://play.qobuz.com/',
    };
  }

  /**
   * Validate the session token by fetching user favorites.
   */
  async authenticate(): Promise<void> {
    try {
      const url = new URL(`${QOBUZ_API_BASE}/favorite/getUserFavorites`);
      url.searchParams.set('type', 'albums');
      url.searchParams.set('limit', '1');

      const response = await fetch(url.toString(), {
        headers: this.headers,
        signal: AbortSignal.timeout(10000),
      });

      if (response.status === 401 || response.status === 400) {
        logger.error(`Token validation failed with status ${response.status}`);
        logger.info('Your token may be expired. Please get a fresh one from:');
        logger.info('https://play.qobuz.com -> DevTools -> Application -> Cookies -> qobuz.com');
        throw new Error(`Invalid or expired Qobuz token (status ${response.status})`);
      }

      const data = await response.json();

      if (data.user?.id) {
        this.userId = data.user.id;
        this.userName = data.user.display_name || 'Qobuz User';
      } else {
        this.userId = 1;
        this.userName = 'Qobuz User';
      }

      logger.info('Authenticated with Qobuz successfully');
    } catch (error) {
      if (error instanceof Error && error.message.includes('Qobuz token')) {
        throw error;
      }
      logger.error(`Network error during token validation: ${error}`);
      throw new Error(`Qobuz authentication failed: ${error}`);
    }
  }

  /**
   * Make authenticated request to Qobuz API with retry and rate limiting.
   */
  private async request<T>(
    endpoint: string,
    params: Record<string, string | number> = {},
    method: 'GET' | 'POST' = 'GET',
    maxRetries: number = 3
  ): Promise<T> {
    const url = new URL(`${QOBUZ_API_BASE}/${endpoint}`);

    if (method === 'GET') {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
    }

    let lastError: Error | null = null;
    let delay = 1.0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.rateLimiter.wait();

        const response = await fetch(url.toString(), {
          method,
          headers: this.headers,
          ...(method === 'POST' && {
            body: new URLSearchParams(
              Object.entries(params).map(([k, v]) => [k, String(v)])
            ),
          }),
          signal: AbortSignal.timeout(15000),
        });

        if (response.status === 429) {
          this.rateLimiter.onRateLimit();
          const retryAfter = parseInt(response.headers.get('Retry-After') || String(delay * 2));
          logger.warn(`Rate limited on ${endpoint}. Waiting ${retryAfter}s...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          delay = retryAfter;
          continue;
        }

        if (!response.ok) {
          if (response.status >= 400 && response.status < 500) {
            const text = await response.text();
            logger.error(`Client error on ${endpoint}: ${response.status}`);
            logger.error(`Response: ${text}`);
            throw new Error(`Qobuz API error: ${response.status}`);
          }

          // Server error - retry
          if (attempt < maxRetries) {
            logger.warn(`Server error on ${endpoint} (attempt ${attempt + 1}): ${response.status}`);
            await new Promise(resolve => setTimeout(resolve, delay * 1000));
            delay *= 2;
            continue;
          }
        }

        this.rateLimiter.onSuccess();
        return await response.json();
      } catch (error) {
        lastError = error as Error;
        if (attempt < maxRetries) {
          logger.warn(`Request failed for ${endpoint} (attempt ${attempt + 1}): ${error}`);
          await new Promise(resolve => setTimeout(resolve, delay * 1000));
          delay *= 2;
        }
      }
    }

    logger.error(`Qobuz API request failed for ${endpoint} after ${maxRetries + 1} attempts`);
    throw new Error(`Qobuz API request failed: ${lastError?.message}`);
  }

  /**
   * Search for a track by ISRC code with fallback strategies.
   */
  async searchByIsrc(
    isrc: string,
    titleHint?: string,
    artistHint?: string
  ): Promise<QobuzTrack | null> {
    try {
      // Strategy 1: Direct ISRC search
      const data = await this.request<{
        tracks?: { items?: Array<{
          id: number;
          title: string;
          performer: { name: string };
          album: { title: string };
          duration: number;
          isrc?: string;
        }> };
      }>('track/search', { query: isrc, limit: 25 });

      if (data.tracks?.items) {
        for (const item of data.tracks.items) {
          if (item.isrc?.toUpperCase() === isrc.toUpperCase()) {
            return {
              id: item.id,
              title: item.title,
              artist: item.performer.name,
              album: item.album.title,
              duration: item.duration * 1000,
              isrc: item.isrc,
            };
          }
        }
      }

      // Strategy 2: Search by metadata and verify ISRC
      if (titleHint && artistHint) {
        const metadataData = await this.request<{
          tracks?: { items?: Array<{
            id: number;
            title: string;
            performer: { name: string };
            album: { title: string };
            duration: number;
            isrc?: string;
          }> };
        }>('track/search', { query: `${titleHint} ${artistHint}`, limit: 15 });

        if (metadataData.tracks?.items) {
          for (const item of metadataData.tracks.items) {
            if (item.isrc?.toUpperCase() === isrc.toUpperCase()) {
              return {
                id: item.id,
                title: item.title,
                artist: item.performer.name,
                album: item.album.title,
                duration: item.duration * 1000,
              };
            }
          }
        }
      }

      logger.debug(`No exact ISRC match found for: ${isrc}`);
      return null;
    } catch (error) {
      logger.error(`Error searching by ISRC ${isrc}: ${error}`);
      return null;
    }
  }

  /**
   * Search for a track by metadata (title, artist, duration).
   */
  async searchByMetadata(title: string, artist: string): Promise<QobuzTrack | null> {
    try {
      const query = `${title} ${artist}`;
      const data = await this.request<{
        tracks?: { total?: number; items?: Array<{
          id: number;
          title: string;
          performer: { name: string };
          album: { title: string };
          duration: number;
        }> };
      }>('track/search', { query, limit: 10 });

      if (!data.tracks?.total || data.tracks.total === 0) {
        logger.debug(`No tracks found for query: ${query}`);
        return null;
      }

      const items = data.tracks.items;
      if (items && items.length > 0) {
        const item = items[0];
        return {
          id: item.id,
          title: item.title,
          artist: item.performer.name,
          album: item.album.title,
          duration: item.duration * 1000,
        };
      }

      return null;
    } catch (error) {
      logger.error(`Error searching by metadata ${title} - ${artist}: ${error}`);
      return null;
    }
  }

  /**
   * Search for candidates (multiple tracks) for fuzzy matching.
   */
  async searchCandidates(title: string, artist: string): Promise<QobuzTrack[]> {
    const query = `${title} ${artist}`.trim();
    if (!query) return [];

    try {
      const data = await this.request<{
        tracks?: { total?: number; items?: Array<{
          id: number;
          title: string;
          performer: { name: string };
          album: { title: string };
          duration: number;
        }> };
      }>('track/search', { query, limit: 15 });

      if (!data.tracks?.total || data.tracks.total === 0) {
        return [];
      }

      return (data.tracks.items || []).map(item => ({
        id: item.id,
        title: item.title,
        artist: item.performer.name,
        album: item.album.title,
        duration: item.duration * 1000,
      }));
    } catch (error) {
      logger.error(`Error searching candidates: ${error}`);
      return [];
    }
  }

  /**
   * Create a new playlist.
   */
  async createPlaylist(name: string, description: string = ''): Promise<string | null> {
    try {
      const response = await fetch(`${QOBUZ_API_BASE}/playlist/create`, {
        method: 'POST',
        headers: {
          ...this.headers,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          name,
          is_public: 'false',
          is_collaborative: 'false',
          ...(description && { description }),
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.error(`Error creating playlist ${name}: ${response.status} - ${text}`);
        return null;
      }

      const result = await response.json();
      const playlistId = String(result.id);
      logger.info(`Created Qobuz playlist: ${name} (ID: ${playlistId})`);
      return playlistId;
    } catch (error) {
      logger.error(`Error creating playlist ${name}: ${error}`);
      return null;
    }
  }

  /**
   * Add a track to a playlist.
   */
  async addTrack(playlistId: string, trackId: number): Promise<boolean> {
    try {
      const response = await fetch(`${QOBUZ_API_BASE}/playlist/addTracks`, {
        method: 'POST',
        headers: {
          ...this.headers,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          playlist_id: playlistId,
          track_ids: String(trackId),
        }),
        signal: AbortSignal.timeout(10000),
      });

      await new Promise(resolve => setTimeout(resolve, 100)); // Rate limit prevention

      if (!response.ok) {
        logger.error(`Error adding track ${trackId} to playlist ${playlistId}`);
        return false;
      }

      logger.debug(`Added track ${trackId} to playlist ${playlistId}`);
      return true;
    } catch (error) {
      logger.error(`Error adding track ${trackId} to playlist ${playlistId}: ${error}`);
      return false;
    }
  }

  /**
   * Get all user playlists.
   */
  async listUserPlaylists(): Promise<QobuzPlaylist[]> {
    try {
      const data = await this.request<{
        playlists?: { items?: Array<{
          id: number;
          name: string;
          tracks_count?: number;
        }> };
      }>('playlist/getUserPlaylists', { limit: 500 });

      const playlists: QobuzPlaylist[] = [];
      if (data.playlists?.items) {
        for (const item of data.playlists.items) {
          playlists.push({
            id: String(item.id),
            name: item.name,
            tracks_count: item.tracks_count || 0,
          });
        }
      }

      logger.info(`Found ${playlists.length} Qobuz playlists`);
      return playlists;
    } catch (error) {
      logger.error(`Error listing user playlists: ${error}`);
      return [];
    }
  }

  /**
   * Find a playlist by exact name match.
   */
  async findPlaylistByName(name: string): Promise<QobuzPlaylist | null> {
    const playlists = await this.listUserPlaylists();
    const found = playlists.find(p => p.name === name);
    if (found) {
      logger.debug(`Found existing playlist: ${name} (ID: ${found.id})`);
    }
    return found || null;
  }

  /**
   * Get all track IDs in a playlist.
   */
  async getPlaylistTracks(playlistId: string): Promise<number[]> {
    try {
      const trackIds: number[] = [];
      let offset = 0;
      const limit = 500;

      while (true) {
        const data = await this.request<{
          tracks?: {
            items?: Array<{ id: number }>;
            total?: number;
          };
        }>('playlist/get', { playlist_id: playlistId, extra: 'tracks', limit, offset });

        if (!data.tracks) break;

        const items = data.tracks.items || [];
        if (items.length === 0) break;

        trackIds.push(...items.map(t => t.id));

        const total = data.tracks.total || 0;
        if (trackIds.length >= total) break;

        offset += limit;
      }

      logger.debug(`Found ${trackIds.length} tracks in playlist ${playlistId}`);
      return trackIds;
    } catch (error) {
      logger.error(`Error getting playlist tracks ${playlistId}: ${error}`);
      return [];
    }
  }

  /**
   * Get favorite track IDs.
   */
  async getFavoriteTracks(limit: number = 5000): Promise<number[]> {
    try {
      const response = await fetch(
        `${QOBUZ_API_BASE}/favorite/getUserFavorites?type=tracks&limit=${limit}&offset=0`,
        { headers: this.headers, signal: AbortSignal.timeout(30000) }
      );

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const trackIds: number[] = [];

      if (data.tracks?.items) {
        for (const item of data.tracks.items) {
          if (item.id) trackIds.push(item.id);
        }
      }

      logger.info(`Retrieved ${trackIds.length} favorite tracks from Qobuz`);
      return trackIds;
    } catch (error) {
      logger.error(`Failed to get favorite tracks: ${error}`);
      throw error;
    }
  }

  /**
   * Get favorites count.
   */
  async getFavoritesCount(): Promise<number> {
    try {
      const response = await fetch(
        `${QOBUZ_API_BASE}/favorite/getUserFavorites?type=tracks&limit=1&offset=0`,
        { headers: this.headers, signal: AbortSignal.timeout(10000) }
      );

      if (!response.ok) return 0;

      const data = await response.json();
      return data.tracks?.total || 0;
    } catch (error) {
      logger.error(`Failed to get favorites count: ${error}`);
      return 0;
    }
  }

  /**
   * Get favorite tracks with their ISRCs for pre-matching.
   */
  async getFavoriteTracksWithIsrc(limit: number = 5000): Promise<Map<string, number>> {
    try {
      const response = await fetch(
        `${QOBUZ_API_BASE}/favorite/getUserFavorites?type=tracks&limit=${limit}&offset=0`,
        { headers: this.headers, signal: AbortSignal.timeout(60000) }
      );

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const isrcMap = new Map<string, number>();

      if (data.tracks?.items) {
        for (const item of data.tracks.items) {
          if (item.isrc && item.id) {
            isrcMap.set(item.isrc, item.id);
          }
        }
      }

      logger.info(`Retrieved ${isrcMap.size} favorite tracks with ISRCs from Qobuz`);
      return isrcMap;
    } catch (error) {
      logger.error(`Failed to get favorite tracks with ISRC: ${error}`);
      return new Map();
    }
  }

  /**
   * Add a track to favorites.
   */
  async addFavoriteTrack(trackId: number): Promise<boolean> {
    try {
      const response = await fetch(
        `${QOBUZ_API_BASE}/favorite/create?track_ids=${trackId}`,
        { method: 'POST', headers: this.headers, signal: AbortSignal.timeout(10000) }
      );

      // 400 = already favorited, which is fine
      if (response.status === 400) {
        logger.debug(`Track ${trackId} is already favorited`);
        return true;
      }

      if (!response.ok) {
        logger.error(`Failed to add track ${trackId} to favorites: ${response.status}`);
        return false;
      }

      logger.debug(`Added track ${trackId} to favorites`);
      return true;
    } catch (error) {
      logger.error(`Failed to add track ${trackId} to favorites: ${error}`);
      return false;
    }
  }

  /**
   * Add multiple tracks to favorites in batch.
   */
  async addFavoriteTracksBatch(trackIds: number[]): Promise<boolean> {
    if (trackIds.length === 0) return true;

    try {
      const response = await fetch(
        `${QOBUZ_API_BASE}/favorite/create?track_ids=${trackIds.join(',')}`,
        { method: 'POST', headers: this.headers, signal: AbortSignal.timeout(30000) }
      );

      if (response.status === 400) {
        logger.debug('Some tracks already favorited');
        return true;
      }

      if (!response.ok) {
        logger.error(`Failed to batch add favorites: ${response.status}`);
        return false;
      }

      logger.debug(`Added ${trackIds.length} tracks to favorites in batch`);
      return true;
    } catch (error) {
      logger.error(`Failed to batch add favorites: ${error}`);
      return false;
    }
  }

  // --- Album Methods ---

  /**
   * Search for albums by title and artist.
   */
  async searchAlbum(title: string, artist: string): Promise<QobuzAlbum[]> {
    try {
      const query = `${title} ${artist}`;
      const data = await this.request<{
        albums?: { items?: Array<{
          id: string;
          title: string;
          artist?: { name: string };
          released_at?: number;
          tracks_count?: number;
          upc?: string;
        }> };
      }>('album/search', { query, limit: 10 });

      const albums: QobuzAlbum[] = [];
      if (data.albums?.items) {
        for (const item of data.albums.items) {
          const releasedAt = item.released_at ? String(item.released_at).slice(0, 4) : null;
          albums.push({
            id: item.id,
            title: item.title || '',
            artist: item.artist?.name || 'Unknown',
            release_year: releasedAt,
            tracks_count: item.tracks_count || 0,
            upc: item.upc,
          });
        }
      }

      logger.debug(`Found ${albums.length} albums for query: ${query}`);
      return albums;
    } catch (error) {
      logger.error(`Error searching albums for ${title} - ${artist}: ${error}`);
      return [];
    }
  }

  /**
   * Search for an album by UPC code.
   */
  async searchAlbumByUpc(upc: string): Promise<QobuzAlbum | null> {
    try {
      const data = await this.request<{
        albums?: { items?: Array<{
          id: string;
          title: string;
          artist?: { name: string };
          released_at?: number;
          tracks_count?: number;
          upc?: string;
        }> };
      }>('album/search', { query: upc, limit: 5 });

      if (data.albums?.items) {
        for (const item of data.albums.items) {
          if (item.upc === upc) {
            const releasedAt = item.released_at ? String(item.released_at).slice(0, 4) : null;
            return {
              id: item.id,
              title: item.title || '',
              artist: item.artist?.name || 'Unknown',
              release_year: releasedAt,
              tracks_count: item.tracks_count || 0,
              upc: item.upc,
            };
          }
        }
      }

      logger.debug(`No exact UPC match found for: ${upc}`);
      return null;
    } catch (error) {
      logger.error(`Error searching by UPC ${upc}: ${error}`);
      return null;
    }
  }

  /**
   * Get favorite album IDs.
   */
  async getFavoriteAlbums(limit: number = 5000): Promise<string[]> {
    try {
      const response = await fetch(
        `${QOBUZ_API_BASE}/favorite/getUserFavorites?type=albums&limit=${limit}&offset=0`,
        { headers: this.headers, signal: AbortSignal.timeout(30000) }
      );

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const albumIds: string[] = [];

      if (data.albums?.items) {
        for (const item of data.albums.items) {
          if (item.id) albumIds.push(String(item.id));
        }
      }

      logger.info(`Retrieved ${albumIds.length} favorite albums from Qobuz`);
      return albumIds;
    } catch (error) {
      logger.error(`Failed to get favorite albums: ${error}`);
      return [];
    }
  }

  /**
   * Get favorite albums count.
   */
  async getFavoriteAlbumsCount(): Promise<number> {
    try {
      const response = await fetch(
        `${QOBUZ_API_BASE}/favorite/getUserFavorites?type=albums&limit=1&offset=0`,
        { headers: this.headers, signal: AbortSignal.timeout(10000) }
      );

      if (!response.ok) return 0;

      const data = await response.json();
      return data.albums?.total || 0;
    } catch (error) {
      logger.error(`Failed to get favorite albums count: ${error}`);
      return 0;
    }
  }

  /**
   * Get favorite albums with UPCs for pre-matching.
   */
  async getFavoriteAlbumsWithUpc(limit: number = 5000): Promise<Map<string, string>> {
    try {
      const response = await fetch(
        `${QOBUZ_API_BASE}/favorite/getUserFavorites?type=albums&limit=${limit}&offset=0`,
        { headers: this.headers, signal: AbortSignal.timeout(60000) }
      );

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const upcMap = new Map<string, string>();

      if (data.albums?.items) {
        for (const item of data.albums.items) {
          if (item.upc && item.id) {
            upcMap.set(item.upc, String(item.id));
          }
        }
      }

      logger.info(`Retrieved ${upcMap.size} favorite albums with UPCs from Qobuz`);
      return upcMap;
    } catch (error) {
      logger.error(`Failed to get favorite albums with UPC: ${error}`);
      return new Map();
    }
  }

  /**
   * Add an album to favorites.
   */
  async addFavoriteAlbum(albumId: string | number): Promise<boolean> {
    try {
      const response = await fetch(
        `${QOBUZ_API_BASE}/favorite/create?album_ids=${albumId}`,
        { method: 'POST', headers: this.headers, signal: AbortSignal.timeout(10000) }
      );

      if (response.status === 400) {
        logger.debug(`Album ${albumId} is already favorited`);
        return true;
      }

      if (!response.ok) {
        logger.error(`Failed to add album ${albumId} to favorites: ${response.status}`);
        return false;
      }

      logger.debug(`Added album ${albumId} to favorites`);
      return true;
    } catch (error) {
      logger.error(`Failed to add album ${albumId} to favorites: ${error}`);
      return false;
    }
  }

  /**
   * Add multiple albums to favorites in batch.
   */
  async addFavoriteAlbumsBatch(albumIds: (string | number)[]): Promise<boolean> {
    if (albumIds.length === 0) return true;

    try {
      const response = await fetch(
        `${QOBUZ_API_BASE}/favorite/create?album_ids=${albumIds.join(',')}`,
        { method: 'POST', headers: this.headers, signal: AbortSignal.timeout(30000) }
      );

      if (response.status === 400) {
        logger.debug('Some albums already favorited');
        return true;
      }

      if (!response.ok) {
        logger.error(`Failed to batch add favorite albums: ${response.status}`);
        return false;
      }

      logger.debug(`Added ${albumIds.length} albums to favorites in batch`);
      return true;
    } catch (error) {
      logger.error(`Failed to batch add favorite albums: ${error}`);
      return false;
    }
  }

  /**
   * Get stats for the Qobuz library.
   */
  async getStats(): Promise<{
    playlists: number;
    fromSpotify: number;
    favorites: number;
    favoriteAlbums: number;
  }> {
    const [playlists, favoritesCount, favoriteAlbumsCount] = await Promise.all([
      this.listUserPlaylists(),
      this.getFavoritesCount(),
      this.getFavoriteAlbumsCount(),
    ]);

    const fromSpotify = playlists.filter(
      p => p.name.includes('(from Spotify)') || p.name.includes('[Spotify]')
    ).length;

    return {
      playlists: playlists.length,
      fromSpotify,
      favorites: favoritesCount,
      favoriteAlbums: favoriteAlbumsCount,
    };
  }
}
