/**
 * Spotify API client for retrieving playlists and tracks.
 */

import { logger } from '../logger';
import type { SpotifyCredentials } from '../types';

export interface SpotifyTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  isrc: string | null;
}

export interface SpotifyAlbum {
  id: string;
  title: string;
  artist: string;
  upc: string | null;
  release_year: string | null;
  total_tracks: number;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  tracks_count: number;
}

const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const SPOTIFY_ACCOUNTS_BASE = 'https://accounts.spotify.com';

export class SpotifyClient {
  private accessToken: string;
  private credentials: SpotifyCredentials;
  private onTokenRefresh?: (newCreds: SpotifyCredentials) => void;

  constructor(credentials: SpotifyCredentials, onTokenRefresh?: (newCreds: SpotifyCredentials) => void) {
    this.credentials = credentials;
    this.accessToken = credentials.access_token;
    this.onTokenRefresh = onTokenRefresh;
  }

  /**
   * Ensure we have a valid access token, refreshing if necessary.
   */
  private async ensureValidToken(): Promise<void> {
    const now = Date.now() / 1000;
    // Refresh if token expires in less than 5 minutes
    if (now < this.credentials.expires_at - 300) {
      return;
    }

    if (!this.credentials.refresh_token) {
      throw new Error('Spotify session expired and no refresh token available. Please reconnect Spotify.');
    }

    logger.info('Refreshing Spotify access token...');

    const response = await fetch(`${SPOTIFY_ACCOUNTS_BASE}/api/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.credentials.refresh_token,
        client_id: this.credentials.client_id,
        client_secret: this.credentials.client_secret,
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to refresh Spotify token. Please reconnect Spotify.');
    }

    const tokenData = await response.json();

    this.accessToken = tokenData.access_token;
    this.credentials = {
      ...this.credentials,
      access_token: tokenData.access_token,
      expires_at: now + (tokenData.expires_in || 3600),
      ...(tokenData.refresh_token && { refresh_token: tokenData.refresh_token }),
    };

    if (this.onTokenRefresh) {
      this.onTokenRefresh(this.credentials);
    }

    logger.info('Spotify token refreshed successfully');
  }

  /**
   * Make an authenticated request to the Spotify API.
   */
  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    await this.ensureValidToken();

    const response = await fetch(`${SPOTIFY_API_BASE}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Spotify API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  /**
   * List all playlists for the authenticated user.
   */
  async listPlaylists(): Promise<SpotifyPlaylist[]> {
    const playlists: SpotifyPlaylist[] = [];
    let offset = 0;
    const limit = 50;

    while (true) {
      const data = await this.request<{
        items: Array<{ id: string; name: string; tracks: { total: number } }>;
        next: string | null;
      }>(`/me/playlists?limit=${limit}&offset=${offset}`);

      for (const item of data.items) {
        playlists.push({
          id: item.id,
          name: item.name,
          tracks_count: item.tracks.total,
        });
        logger.debug(`Found playlist: ${item.name} (${item.tracks.total} tracks)`);
      }

      if (!data.next) break;
      offset += limit;
    }

    logger.info(`Retrieved ${playlists.length} playlists from Spotify`);
    return playlists;
  }

  /**
   * List all tracks in a playlist.
   */
  async listTracks(playlistId: string): Promise<SpotifyTrack[]> {
    const tracks: SpotifyTrack[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const data = await this.request<{
        items: Array<{
          track: {
            id: string;
            name: string;
            artists: Array<{ name: string }>;
            album: { name: string };
            duration_ms: number;
            external_ids?: { isrc?: string };
          } | null;
        }>;
        next: string | null;
      }>(`/playlists/${playlistId}/tracks?limit=${limit}&offset=${offset}&fields=items(track(name,id,artists,album,duration_ms,external_ids)),next`);

      for (const item of data.items) {
        const trackData = item.track;
        if (!trackData) continue;

        tracks.push({
          id: trackData.id,
          title: trackData.name,
          artist: trackData.artists[0]?.name || 'Unknown',
          album: trackData.album.name,
          duration: trackData.duration_ms,
          isrc: trackData.external_ids?.isrc || null,
        });
      }

      if (!data.next) break;
      offset += limit;
    }

    logger.info(`Retrieved ${tracks.length} tracks from playlist ${playlistId}`);
    return tracks;
  }

  /**
   * Get all saved/liked tracks for the authenticated user.
   */
  async getSavedTracks(): Promise<SpotifyTrack[]> {
    const tracks: SpotifyTrack[] = [];
    let offset = 0;
    const limit = 50;

    while (true) {
      const data = await this.request<{
        items: Array<{
          track: {
            id: string;
            name: string;
            artists: Array<{ name: string }>;
            album: { name: string };
            duration_ms: number;
            external_ids?: { isrc?: string };
          } | null;
        }>;
        next: string | null;
      }>(`/me/tracks?limit=${limit}&offset=${offset}`);

      for (const item of data.items) {
        const trackData = item.track;
        if (!trackData) continue;

        tracks.push({
          id: trackData.id,
          title: trackData.name,
          artist: trackData.artists[0]?.name || 'Unknown',
          album: trackData.album.name,
          duration: trackData.duration_ms,
          isrc: trackData.external_ids?.isrc || null,
        });
      }

      if (!data.next) break;
      offset += limit;
    }

    logger.info(`Retrieved ${tracks.length} saved tracks from Spotify`);
    return tracks;
  }

  /**
   * Generator that yields saved tracks one at a time with pagination.
   * More memory-efficient than getSavedTracks() for large libraries.
   */
  async *iterSavedTracks(startOffset: number = 0): AsyncGenerator<{
    track: SpotifyTrack;
    spotifyId: string;
    offset: number;
    total: number;
  }> {
    let offset = startOffset;
    const limit = 50;
    let total: number | null = null;

    while (true) {
      const data = await this.request<{
        items: Array<{
          track: {
            id: string;
            name: string;
            artists: Array<{ name: string }>;
            album: { name: string };
            duration_ms: number;
            external_ids?: { isrc?: string };
          } | null;
        }>;
        total: number;
        next: string | null;
      }>(`/me/tracks?limit=${limit}&offset=${offset}`);

      if (total === null) {
        total = data.total;
        logger.info(`Streaming ${total} saved tracks from Spotify (starting at ${startOffset})`);
      }

      for (const item of data.items) {
        const trackData = item.track;
        if (!trackData) continue;

        const track: SpotifyTrack = {
          id: trackData.id,
          title: trackData.name,
          artist: trackData.artists[0]?.name || 'Unknown',
          album: trackData.album.name,
          duration: trackData.duration_ms,
          isrc: trackData.external_ids?.isrc || null,
        };

        yield { track, spotifyId: trackData.id, offset, total };
      }

      if (!data.next) break;
      offset += limit;
    }
  }

  /**
   * Get all saved/liked albums for the authenticated user.
   */
  async getSavedAlbums(): Promise<SpotifyAlbum[]> {
    const albums: SpotifyAlbum[] = [];
    let offset = 0;
    const limit = 50;

    while (true) {
      const data = await this.request<{
        items: Array<{
          album: {
            id: string;
            name: string;
            artists: Array<{ name: string }>;
            external_ids?: { upc?: string };
            release_date?: string;
            total_tracks?: number;
          };
        }>;
        next: string | null;
      }>(`/me/albums?limit=${limit}&offset=${offset}`);

      for (const item of data.items) {
        const albumData = item.album;
        const releaseDate = albumData.release_date || '';

        albums.push({
          id: albumData.id,
          title: albumData.name,
          artist: albumData.artists[0]?.name || 'Unknown',
          upc: albumData.external_ids?.upc || null,
          release_year: releaseDate.slice(0, 4) || null,
          total_tracks: albumData.total_tracks || 0,
        });
      }

      if (!data.next) break;
      offset += limit;
    }

    logger.info(`Retrieved ${albums.length} saved albums from Spotify`);
    return albums;
  }

  /**
   * Generator that yields saved albums one at a time with pagination.
   */
  async *iterSavedAlbums(startOffset: number = 0): AsyncGenerator<{
    album: SpotifyAlbum;
    spotifyId: string;
    offset: number;
    total: number;
  }> {
    let offset = startOffset;
    const limit = 50;
    let total: number | null = null;

    while (true) {
      const data = await this.request<{
        items: Array<{
          album: {
            id: string;
            name: string;
            artists: Array<{ name: string }>;
            external_ids?: { upc?: string };
            release_date?: string;
            total_tracks?: number;
          };
        }>;
        total: number;
        next: string | null;
      }>(`/me/albums?limit=${limit}&offset=${offset}`);

      if (total === null) {
        total = data.total;
        logger.info(`Streaming ${total} saved albums from Spotify (starting at ${startOffset})`);
      }

      for (const item of data.items) {
        const albumData = item.album;
        const releaseDate = albumData.release_date || '';

        const album: SpotifyAlbum = {
          id: albumData.id,
          title: albumData.name,
          artist: albumData.artists[0]?.name || 'Unknown',
          upc: albumData.external_ids?.upc || null,
          release_year: releaseDate.slice(0, 4) || null,
          total_tracks: albumData.total_tracks || 0,
        };

        yield { album, spotifyId: albumData.id, offset, total };
      }

      if (!data.next) break;
      offset += limit;
    }
  }

  /**
   * Get library statistics including user display name.
   */
  async getStats(): Promise<{
    display_name: string;
    playlists: number;
    saved_tracks: number;
    saved_albums: number;
  }> {
    const [profileData, playlistsData, tracksData, albumsData] = await Promise.all([
      this.request<{ display_name: string | null; id: string }>('/me'),
      this.request<{ total: number }>('/me/playlists?limit=1'),
      this.request<{ total: number }>('/me/tracks?limit=1'),
      this.request<{ total: number }>('/me/albums?limit=1'),
    ]);

    return {
      display_name: profileData.display_name ?? profileData.id,
      playlists: playlistsData.total,
      saved_tracks: tracksData.total,
      saved_albums: albumsData.total,
    };
  }

  /**
   * Get the Spotify OAuth authorization URL.
   */
  static getAuthUrl(clientId: string, redirectUri: string, state: string): string {
    const scope = 'playlist-read-private playlist-read-collaborative user-library-read';
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope,
      state,
    });
    return `${SPOTIFY_ACCOUNTS_BASE}/authorize?${params}`;
  }

  /**
   * Exchange an authorization code for tokens.
   */
  static async exchangeCode(
    code: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string
  ): Promise<SpotifyCredentials> {
    const response = await fetch(`${SPOTIFY_ACCOUNTS_BASE}/api/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    const tokenData = await response.json();

    return {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() / 1000 + (tokenData.expires_in || 3600),
    };
  }
}

// Re-export type for convenience
export type { SpotifyCredentials };
