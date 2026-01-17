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

  if (!spotifyQuery.data && !qobuzQuery.data) {
    return null;
  }

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Tracks
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
            </div>
            <div className="text-right">
              <p className="text-2xl font-bold">{qobuzQuery.data?.playlists ?? '-'}</p>
              <p className="text-xs text-muted-foreground">Qobuz</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
