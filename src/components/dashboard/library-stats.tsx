'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface SpotifyStats {
  display_name: string;
  playlists: number;
  saved_tracks: number;
  saved_albums: number;
}

interface QobuzStats {
  display_name: string;
  favorites: number;
  albums: number;
  playlists: number;
}

interface SpotifyPlaylist {
  id: string;
  name: string;
  tracks_count: number;
}

interface QobuzPlaylist {
  id: string;
  name: string;
  tracks_count: number;
}

export function LibraryStats() {
  const spotifyQuery = useQuery<SpotifyStats | null>({
    queryKey: ['spotifyStats'],
    queryFn: async () => {
      const res = await fetch('/api/spotify/stats');
      if (!res.ok) return null;
      const data = await res.json();
      return data.display_name ? data : null;
    },
  });

  const qobuzQuery = useQuery<QobuzStats | null>({
    queryKey: ['qobuzStats'],
    queryFn: async () => {
      const res = await fetch('/api/qobuz/stats');
      if (!res.ok) return null;
      const data = await res.json();
      return data.display_name ? data : null;
    },
  });

  const spotifyPlaylistsQuery = useQuery<{ playlists: SpotifyPlaylist[] } | null>({
    queryKey: ['spotifyPlaylists'],
    queryFn: async () => {
      const res = await fetch('/api/spotify/playlists');
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!spotifyQuery.data,
  });

  const qobuzPlaylistsQuery = useQuery<{ playlists: QobuzPlaylist[] } | null>({
    queryKey: ['qobuzPlaylists'],
    queryFn: async () => {
      const res = await fetch('/api/qobuz/playlists');
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!qobuzQuery.data,
  });

  const spotifyTotalTracks = spotifyPlaylistsQuery.data?.playlists?.reduce(
    (sum, p) => sum + (p.tracks_count || 0),
    0
  );
  const qobuzTotalTracks = qobuzPlaylistsQuery.data?.playlists?.reduce(
    (sum, p) => sum + (p.tracks_count || 0),
    0
  );

  if (!spotifyQuery.data && !qobuzQuery.data) {
    return null;
  }

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Liked Tracks
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline justify-between">
            <div>
              <p className="text-2xl font-bold">{spotifyQuery.data?.saved_tracks ?? '-'}</p>
              <p className="text-xs text-muted-foreground">Spotify</p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-bold">{qobuzQuery.data?.favorites ?? '-'}</p>
              <p className="text-xs text-muted-foreground">Qobuz</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Albums
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline justify-between">
            <div>
              <p className="text-2xl font-bold">{spotifyQuery.data?.saved_albums ?? '-'}</p>
              <p className="text-xs text-muted-foreground">Spotify</p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-bold">{qobuzQuery.data?.albums ?? '-'}</p>
              <p className="text-xs text-muted-foreground">Qobuz</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Playlists
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline justify-between">
            <div>
              <p className="text-2xl font-bold">{spotifyQuery.data?.playlists ?? '-'}</p>
              <p className="text-xs text-muted-foreground">Spotify</p>
              {spotifyTotalTracks !== undefined && (
                <p className="text-xs text-muted-foreground mt-1">
                  {spotifyTotalTracks.toLocaleString()} tracks
                </p>
              )}
            </div>
            <div className="text-right">
              <p className="text-2xl font-bold">{qobuzQuery.data?.playlists ?? '-'}</p>
              <p className="text-xs text-muted-foreground">Qobuz</p>
              {qobuzTotalTracks !== undefined && (
                <p className="text-xs text-muted-foreground mt-1">
                  {qobuzTotalTracks.toLocaleString()} tracks
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
