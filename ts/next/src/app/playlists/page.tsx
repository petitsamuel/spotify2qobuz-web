'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface Playlist {
  id: string;
  name: string;
  track_count: number;
  image_url: string | null;
}

export default function PlaylistsPage() {
  const { data, isLoading } = useQuery<{ playlists: Playlist[] }>({
    queryKey: ['playlists'],
    queryFn: async () => {
      const res = await fetch('/api/spotify/playlists');
      if (!res.ok) return { playlists: [] };
      return res.json();
    },
  });

  const playlists = data?.playlists ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Spotify Playlists</h1>
        <p className="text-muted-foreground">
          Your Spotify playlists ({playlists.length} total)
        </p>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading playlists...</p>
      ) : playlists.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No Playlists</CardTitle>
            <CardDescription>
              Connect your Spotify account to see your playlists.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {playlists.map((playlist) => (
            <Card key={playlist.id} className="overflow-hidden">
              {playlist.image_url && (
                <div className="aspect-square bg-muted">
                  <img
                    src={playlist.image_url}
                    alt={playlist.name}
                    className="h-full w-full object-cover"
                  />
                </div>
              )}
              <CardContent className="p-4">
                <p className="truncate font-medium">{playlist.name}</p>
                <p className="text-sm text-muted-foreground">
                  {playlist.track_count} tracks
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
