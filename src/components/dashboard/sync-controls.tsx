'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface StartSyncResult {
  task_id?: string;
  status?: string;
  error?: string;
  active_task_id?: string;
  sync_type?: string;
}

interface SyncControlsProps {
  onSyncStarted: (taskId: string, syncType: string) => void;
  disabled?: boolean;
}

export function SyncControls({ onSyncStarted, disabled }: SyncControlsProps) {
  const [dryRun, setDryRun] = useState(false);

  const startSync = useMutation<StartSyncResult, Error, string>({
    mutationFn: async (syncType) => {
      const formData = new FormData();
      formData.append('type', syncType);
      formData.append('dry_run', String(dryRun));

      const res = await fetch('/api/sync/start', {
        method: 'POST',
        body: formData,
      });
      return res.json();
    },
    onSuccess: (data, syncType) => {
      if (data.task_id) {
        onSyncStarted(data.task_id, syncType);
      } else if (data.active_task_id && data.sync_type) {
        // A sync is already running - reconnect to it
        onSyncStarted(data.active_task_id, data.sync_type);
      }
    },
  });

  const handleSync = (syncType: string) => {
    startSync.mutate(syncType);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sync Library</CardTitle>
        <CardDescription>
          Sync your Spotify library to Qobuz
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex items-center space-x-2">
          <input
            type="checkbox"
            id="dry-run"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
            className="h-4 w-4"
          />
          <Label htmlFor="dry-run" className="text-sm">
            Dry run (preview only, no changes)
          </Label>
        </div>

        {startSync.data?.error && (
          <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {startSync.data.error}
            {startSync.data.active_task_id && (
              <span className="block text-xs">
                Active sync: {startSync.data.sync_type}
              </span>
            )}
          </div>
        )}

        <Tabs defaultValue="favorites">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="favorites">Favorites</TabsTrigger>
            <TabsTrigger value="albums">Albums</TabsTrigger>
            <TabsTrigger value="playlists">Playlists</TabsTrigger>
          </TabsList>
          <TabsContent value="favorites" className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Sync your saved/liked tracks from Spotify to Qobuz favorites.
            </p>
            <Button
              onClick={() => handleSync('favorites')}
              disabled={disabled || startSync.isPending}
            >
              {startSync.isPending ? 'Starting...' : 'Sync Favorites'}
            </Button>
          </TabsContent>
          <TabsContent value="albums" className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Sync your saved albums from Spotify to Qobuz.
            </p>
            <Button
              onClick={() => handleSync('albums')}
              disabled={disabled || startSync.isPending}
            >
              {startSync.isPending ? 'Starting...' : 'Sync Albums'}
            </Button>
          </TabsContent>
          <TabsContent value="playlists" className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Recreate your Spotify playlists in Qobuz.
            </p>
            <Button
              onClick={() => handleSync('playlists')}
              disabled={disabled || startSync.isPending}
            >
              {startSync.isPending ? 'Starting...' : 'Sync Playlists'}
            </Button>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
