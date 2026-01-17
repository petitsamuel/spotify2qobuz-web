'use client';

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

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

export function ConnectionStatus() {
  const queryClient = useQueryClient();
  const hasProcessedOAuthRef = useRef(false);

  // Handle OAuth redirect params on mount - use window.location directly
  // to avoid Next.js useSearchParams hydration timing issues
  useEffect(() => {
    if (hasProcessedOAuthRef.current) return;

    const params = new URLSearchParams(window.location.search);
    let shouldCleanUrl = false;

    if (params.get('spotify_connected') === 'true') {
      queryClient.invalidateQueries({ queryKey: ['spotifyStats'] });
      shouldCleanUrl = true;
    }
    if (params.get('qobuz_connected') === 'true') {
      queryClient.invalidateQueries({ queryKey: ['qobuzStats'] });
      shouldCleanUrl = true;
    }

    if (shouldCleanUrl) {
      hasProcessedOAuthRef.current = true;
      window.history.replaceState({}, '', '/');
    }
  }, [queryClient]);

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

  const handleSpotifyConnect = () => {
    window.location.href = '/api/auth/spotify';
  };

  const handleSpotifyDisconnect = async () => {
    await fetch('/api/auth/spotify/disconnect', { method: 'POST' });
    spotifyQuery.refetch();
  };

  const handleQobuzDisconnect = async () => {
    await fetch('/api/auth/qobuz/disconnect', { method: 'POST' });
    qobuzQuery.refetch();
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Spotify</CardTitle>
            <Badge variant={spotifyQuery.data ? 'default' : 'secondary'}>
              {spotifyQuery.data ? 'Connected' : 'Not Connected'}
            </Badge>
          </CardHeader>
          <CardContent>
            {spotifyQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : spotifyQuery.data ? (
              <div className="space-y-2">
                <p className="text-lg font-semibold">{spotifyQuery.data.display_name}</p>
                <div className="text-sm text-muted-foreground">
                  <p>{spotifyQuery.data.playlists} playlists</p>
                  <p>{spotifyQuery.data.saved_tracks} saved tracks</p>
                  <p>{spotifyQuery.data.saved_albums} saved albums</p>
                </div>
                <Button variant="outline" size="sm" onClick={handleSpotifyDisconnect}>
                  Disconnect
                </Button>
              </div>
            ) : (
              <Button onClick={handleSpotifyConnect}>Connect Spotify</Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Qobuz</CardTitle>
            <Badge variant={qobuzQuery.data ? 'default' : 'secondary'}>
              {qobuzQuery.data ? 'Connected' : 'Not Connected'}
            </Badge>
          </CardHeader>
          <CardContent>
            {qobuzQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : qobuzQuery.data ? (
              <div className="space-y-2">
                <p className="text-lg font-semibold">{qobuzQuery.data.display_name}</p>
                <div className="text-sm text-muted-foreground">
                  <p>{qobuzQuery.data.playlists} playlists</p>
                  <p>{qobuzQuery.data.favorites} favorite tracks</p>
                  <p>{qobuzQuery.data.albums} albums</p>
                </div>
                <Button variant="outline" size="sm" onClick={handleQobuzDisconnect}>
                  Disconnect
                </Button>
              </div>
            ) : (
              <Button asChild>
                <a href="/auth/qobuz">Connect Qobuz</a>
              </Button>
            )}
          </CardContent>
        </Card>
    </div>
  );
}
