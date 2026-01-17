'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SuggestionCard } from './suggestion-card';

interface Suggestion {
  qobuz_id: number;
  title: string;
  artist: string;
  album: string;
  score: number;
}

interface UnmatchedTrack {
  spotify_id: string;
  title: string;
  artist: string;
  album: string;
  sync_type: string;
  status: string;
  suggestions: Suggestion[];
  created_at: string;
}

interface UnmatchedListProps {
  syncType?: string;
}

export function UnmatchedList({ syncType }: UnmatchedListProps) {
  const [activeTab, setActiveTab] = useState(syncType ?? 'favorites');
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{ tracks: UnmatchedTrack[]; total: number }>({
    queryKey: ['unmatched', activeTab],
    queryFn: async () => {
      const res = await fetch(`/api/unmatched?sync_type=${activeTab}&status=pending`);
      if (!res.ok) return { tracks: [], total: 0 };
      return res.json();
    },
  });

  const resolveMutation = useMutation({
    mutationFn: async ({ spotifyId, qobuzId }: { spotifyId: string; qobuzId: number }) => {
      const formData = new FormData();
      formData.append('qobuz_id', String(qobuzId));
      const res = await fetch(`/api/unmatched/${spotifyId}/resolve`, {
        method: 'POST',
        body: formData,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['unmatched'] });
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async (spotifyId: string) => {
      const res = await fetch(`/api/unmatched/${spotifyId}/dismiss`, {
        method: 'POST',
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['unmatched'] });
    },
  });

  const handleResolve = (spotifyId: string, qobuzId: number) => {
    resolveMutation.mutate({ spotifyId, qobuzId });
  };

  const handleDismiss = (spotifyId: string) => {
    dismissMutation.mutate(spotifyId);
  };

  const tracks = data?.tracks ?? [];
  const total = data?.total ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Unmatched Tracks</CardTitle>
        <CardDescription>
          Review and resolve tracks that couldn&apos;t be automatically matched
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="favorites">Favorites</TabsTrigger>
            <TabsTrigger value="albums">Albums</TabsTrigger>
            <TabsTrigger value="playlists">Playlists</TabsTrigger>
          </TabsList>

          <TabsContent value={activeTab}>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : tracks.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No unmatched tracks to review.
              </p>
            ) : (
              <div className="space-y-6">
                <p className="text-sm text-muted-foreground">
                  {total} unmatched track{total !== 1 ? 's' : ''} to review
                </p>

                {tracks.map((track) => (
                  <div key={track.spotify_id} className="space-y-3 rounded-lg border p-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="font-medium">{track.title}</p>
                        <p className="text-sm text-muted-foreground">{track.artist}</p>
                        {track.album && (
                          <p className="text-xs text-muted-foreground">{track.album}</p>
                        )}
                      </div>
                      <Badge variant="outline" className="text-xs">
                        Spotify
                      </Badge>
                    </div>

                    {track.suggestions && track.suggestions.length > 0 ? (
                      <div className="space-y-2">
                        <p className="text-sm font-medium">Suggestions from Qobuz:</p>
                        {track.suggestions.map((suggestion) => (
                          <SuggestionCard
                            key={suggestion.qobuz_id}
                            suggestion={suggestion}
                            onSelect={(qobuzId) => handleResolve(track.spotify_id, qobuzId)}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No suggestions available.
                      </p>
                    )}

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDismiss(track.spotify_id)}
                      disabled={dismissMutation.isPending}
                    >
                      Dismiss
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
