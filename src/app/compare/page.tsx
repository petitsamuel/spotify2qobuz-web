'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

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

export default function ComparePage() {
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

  const isLoading = spotifyQuery.isLoading || qobuzQuery.isLoading;
  const spotifyData = spotifyQuery.data;
  const qobuzData = qobuzQuery.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Compare Libraries</h1>
        <p className="text-muted-foreground">
          Side-by-side comparison of your Spotify and Qobuz libraries
        </p>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading stats...</p>
      ) : !spotifyData && !qobuzData ? (
        <Card>
          <CardHeader>
            <CardTitle>Connect Your Accounts</CardTitle>
            <CardDescription>
              Connect both Spotify and Qobuz to compare your libraries.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Spotify</CardTitle>
              <CardDescription>
                {spotifyData ? spotifyData.display_name : 'Not connected'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {spotifyData ? (
                <dl className="space-y-4">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Playlists</dt>
                    <dd className="font-medium">{spotifyData.playlists}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Saved Tracks</dt>
                    <dd className="font-medium">{spotifyData.saved_tracks}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Saved Albums</dt>
                    <dd className="font-medium">{spotifyData.saved_albums}</dd>
                  </div>
                </dl>
              ) : (
                <p className="text-muted-foreground">
                  Connect your Spotify account to see stats.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Qobuz</CardTitle>
              <CardDescription>
                {qobuzData ? qobuzData.display_name : 'Not connected'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {qobuzData ? (
                <dl className="space-y-4">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Playlists</dt>
                    <dd className="font-medium">{qobuzData.playlists}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Favorite Tracks</dt>
                    <dd className="font-medium">{qobuzData.favorites}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Albums</dt>
                    <dd className="font-medium">{qobuzData.albums}</dd>
                  </div>
                </dl>
              ) : (
                <p className="text-muted-foreground">
                  Connect your Qobuz account to see stats.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {spotifyData && qobuzData && (
        <Card>
          <CardHeader>
            <CardTitle>Comparison</CardTitle>
            <CardDescription>
              Differences between your libraries
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="space-y-4">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Track difference</dt>
                <dd className="font-medium">
                  {spotifyData.saved_tracks - qobuzData.favorites > 0 ? '+' : ''}
                  {spotifyData.saved_tracks - qobuzData.favorites} tracks in Spotify
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Album difference</dt>
                <dd className="font-medium">
                  {spotifyData.saved_albums - qobuzData.albums > 0 ? '+' : ''}
                  {spotifyData.saved_albums - qobuzData.albums} albums in Spotify
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Playlist difference</dt>
                <dd className="font-medium">
                  {spotifyData.playlists - qobuzData.playlists > 0 ? '+' : ''}
                  {spotifyData.playlists - qobuzData.playlists} playlists in Spotify
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
