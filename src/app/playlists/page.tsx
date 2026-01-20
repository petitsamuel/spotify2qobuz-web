'use client';

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface SpotifyPlaylist {
  id: string;
  name: string;
  tracks_count: number;
  image_url: string | null;
}

interface QobuzPlaylist {
  id: string;
  name: string;
  tracks_count: number;
}

interface SpotifyTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  isrc: string | null;
}

interface QobuzTrack {
  id: number;
  title: string;
  artist: string;
  album: string;
  isrc?: string;
}

interface MatchedPlaylist {
  spotifyPlaylist: SpotifyPlaylist;
  qobuzPlaylist: QobuzPlaylist | null;
  trackDiff: number;
}

function normalizePlaylistName(name: string): string {
  return name
    .replace(/\s*\(from Spotify\)\s*/gi, '')
    .replace(/\s*\[Spotify\]\s*/gi, '')
    .trim()
    .toLowerCase();
}

function normalizeForComparison(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export default function PlaylistsPage() {
  const [selectedPlaylist, setSelectedPlaylist] = useState<MatchedPlaylist | null>(null);
  const [diffDialogOpen, setDiffDialogOpen] = useState(false);

  const spotifyPlaylistsQuery = useQuery<{ playlists: SpotifyPlaylist[] }>({
    queryKey: ['spotifyPlaylists'],
    queryFn: async () => {
      const res = await fetch('/api/spotify/playlists');
      if (!res.ok) return { playlists: [] };
      return res.json();
    },
  });

  const qobuzPlaylistsQuery = useQuery<{ playlists: QobuzPlaylist[] }>({
    queryKey: ['qobuzPlaylists'],
    queryFn: async () => {
      const res = await fetch('/api/qobuz/playlists');
      if (!res.ok) return { playlists: [] };
      return res.json();
    },
  });

  const spotifyPlaylists = spotifyPlaylistsQuery.data?.playlists ?? [];
  const qobuzPlaylists = qobuzPlaylistsQuery.data?.playlists ?? [];
  const isLoading = spotifyPlaylistsQuery.isLoading || qobuzPlaylistsQuery.isLoading;

  const matchedPlaylists = useMemo(() => {
    const qobuzByNormalizedName = new Map<string, QobuzPlaylist>();
    for (const qp of qobuzPlaylists) {
      qobuzByNormalizedName.set(normalizePlaylistName(qp.name), qp);
    }

    return spotifyPlaylists.map((sp): MatchedPlaylist => {
      const normalizedName = normalizePlaylistName(sp.name);
      const qobuzMatch = qobuzByNormalizedName.get(normalizedName) || null;
      const trackDiff = qobuzMatch ? sp.tracks_count - qobuzMatch.tracks_count : sp.tracks_count;
      return {
        spotifyPlaylist: sp,
        qobuzPlaylist: qobuzMatch,
        trackDiff,
      };
    });
  }, [spotifyPlaylists, qobuzPlaylists]);

  const totalSpotifyTracks = spotifyPlaylists.reduce((sum, p) => sum + p.tracks_count, 0);
  const totalQobuzTracks = qobuzPlaylists.reduce((sum, p) => sum + p.tracks_count, 0);
  const matchedCount = matchedPlaylists.filter(m => m.qobuzPlaylist).length;

  const handlePlaylistClick = (matched: MatchedPlaylist) => {
    setSelectedPlaylist(matched);
    setDiffDialogOpen(true);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Playlist Comparison</h1>
        <p className="text-muted-foreground">
          Compare your Spotify playlists with Qobuz
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Spotify Playlists
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{spotifyPlaylists.length}</p>
            <p className="text-xs text-muted-foreground">
              {totalSpotifyTracks.toLocaleString()} total tracks
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Qobuz Playlists
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{qobuzPlaylists.length}</p>
            <p className="text-xs text-muted-foreground">
              {totalQobuzTracks.toLocaleString()} total tracks
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Matched Playlists
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{matchedCount}</p>
            <p className="text-xs text-muted-foreground">
              of {spotifyPlaylists.length} Spotify playlists
            </p>
          </CardContent>
        </Card>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading playlists...</p>
      ) : matchedPlaylists.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No Playlists</CardTitle>
            <CardDescription>
              Connect your Spotify account to see your playlists.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Click on a playlist to see track differences
          </p>
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {matchedPlaylists.map((matched) => (
              <Card
                key={matched.spotifyPlaylist.id}
                className="overflow-hidden cursor-pointer hover:border-primary transition-colors"
                onClick={() => handlePlaylistClick(matched)}
              >
                {matched.spotifyPlaylist.image_url && (
                  <div className="aspect-square bg-muted">
                    <img
                      src={matched.spotifyPlaylist.image_url}
                      alt={matched.spotifyPlaylist.name}
                      className="h-full w-full object-cover"
                    />
                  </div>
                )}
                <CardContent className="p-4">
                  <p className="truncate font-medium">{matched.spotifyPlaylist.name}</p>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-sm text-muted-foreground">
                      {matched.spotifyPlaylist.tracks_count} tracks
                    </span>
                    {matched.qobuzPlaylist ? (
                      matched.trackDiff === 0 ? (
                        <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                          Synced
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-orange-600 border-orange-300">
                          {matched.trackDiff > 0 ? `+${matched.trackDiff}` : matched.trackDiff} diff
                        </Badge>
                      )
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        Not synced
                      </Badge>
                    )}
                  </div>
                  {matched.qobuzPlaylist && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Qobuz: {matched.qobuzPlaylist.tracks_count} tracks
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      <PlaylistDiffDialog
        open={diffDialogOpen}
        onOpenChange={setDiffDialogOpen}
        matched={selectedPlaylist}
      />
    </div>
  );
}

function PlaylistDiffDialog({
  open,
  onOpenChange,
  matched,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  matched: MatchedPlaylist | null;
}) {
  const spotifyTracksQuery = useQuery<{ tracks: SpotifyTrack[] }>({
    queryKey: ['spotifyPlaylistTracks', matched?.spotifyPlaylist.id],
    queryFn: async () => {
      const res = await fetch(`/api/spotify/playlists/${matched!.spotifyPlaylist.id}/tracks`);
      if (!res.ok) return { tracks: [] };
      return res.json();
    },
    enabled: open && !!matched,
  });

  const qobuzTracksQuery = useQuery<{ tracks: QobuzTrack[] }>({
    queryKey: ['qobuzPlaylistTracks', matched?.qobuzPlaylist?.id],
    queryFn: async () => {
      const res = await fetch(`/api/qobuz/playlists/${matched!.qobuzPlaylist!.id}/tracks`);
      if (!res.ok) return { tracks: [] };
      return res.json();
    },
    enabled: open && !!matched?.qobuzPlaylist,
  });

  const isLoading = spotifyTracksQuery.isLoading || (matched?.qobuzPlaylist && qobuzTracksQuery.isLoading);
  const spotifyTracks = spotifyTracksQuery.data?.tracks ?? [];
  const qobuzTracks = qobuzTracksQuery.data?.tracks ?? [];

  const { missingTracks, matchedTracks } = useMemo(() => {
    if (!matched?.qobuzPlaylist) {
      return { missingTracks: spotifyTracks, matchedTracks: [] };
    }

    const qobuzIsrcs = new Set(
      qobuzTracks
        .filter(t => t.isrc)
        .map(t => t.isrc!.toUpperCase().replace(/[-\s]/g, ''))
    );

    const qobuzByNormalizedTitle = new Map<string, QobuzTrack>();
    for (const qt of qobuzTracks) {
      const key = `${normalizeForComparison(qt.title)}|${normalizeForComparison(qt.artist)}`;
      qobuzByNormalizedTitle.set(key, qt);
    }

    const missing: SpotifyTrack[] = [];
    const foundTracks: SpotifyTrack[] = [];

    for (const st of spotifyTracks) {
      let found = false;

      if (st.isrc) {
        const normalizedIsrc = st.isrc.toUpperCase().replace(/[-\s]/g, '');
        if (qobuzIsrcs.has(normalizedIsrc)) {
          found = true;
        }
      }

      if (!found) {
        const key = `${normalizeForComparison(st.title)}|${normalizeForComparison(st.artist)}`;
        if (qobuzByNormalizedTitle.has(key)) {
          found = true;
        }
      }

      if (found) {
        foundTracks.push(st);
      } else {
        missing.push(st);
      }
    }

    return { missingTracks: missing, matchedTracks: foundTracks };
  }, [spotifyTracks, qobuzTracks, matched?.qobuzPlaylist]);

  if (!matched) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{matched.spotifyPlaylist.name}</DialogTitle>
          <DialogDescription>
            {matched.qobuzPlaylist ? (
              <>
                Comparing {matched.spotifyPlaylist.tracks_count} Spotify tracks with{' '}
                {matched.qobuzPlaylist.tracks_count} Qobuz tracks
              </>
            ) : (
              'This playlist has not been synced to Qobuz'
            )}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 text-center text-muted-foreground">
            Loading tracks...
          </div>
        ) : (
          <div className="flex-1 overflow-hidden flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold">{spotifyTracks.length}</p>
                <p className="text-xs text-muted-foreground">Spotify tracks</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-green-600">{matchedTracks.length}</p>
                <p className="text-xs text-muted-foreground">Matched</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-orange-600">{missingTracks.length}</p>
                <p className="text-xs text-muted-foreground">Missing in Qobuz</p>
              </div>
            </div>

            {missingTracks.length > 0 && (
              <div className="flex-1 overflow-hidden">
                <h4 className="font-medium mb-2">Missing Tracks ({missingTracks.length})</h4>
                <div className="overflow-y-auto max-h-[40vh] border rounded-md">
                  <div className="divide-y">
                    {missingTracks.map((track) => (
                      <div key={track.id} className="p-3 hover:bg-muted/50">
                        <p className="font-medium text-sm truncate">{track.title}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {track.artist} - {track.album}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {missingTracks.length === 0 && matched.qobuzPlaylist && (
              <div className="py-8 text-center">
                <p className="text-green-600 font-medium">All tracks are synced!</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Every track from Spotify was found in Qobuz
                </p>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
