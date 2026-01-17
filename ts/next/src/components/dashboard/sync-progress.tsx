'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';

interface SyncProgressData {
  current_playlist?: string;
  current_playlist_index?: number;
  total_playlists?: number;
  current_track_index?: number;
  total_tracks?: number;
  tracks_matched?: number;
  tracks_not_matched?: number;
  isrc_matches?: number;
  fuzzy_matches?: number;
  percent_complete?: number;
  recent_missing?: Array<{
    title: string;
    artist: string;
  }>;
}

interface SyncReport {
  tracks_matched?: number;
  tracks_not_matched?: number;
  albums_matched?: number;
  albums_not_matched?: number;
  isrc_matches?: number;
  upc_matches?: number;
  fuzzy_matches?: number;
}

interface SyncProgressProps {
  taskId: string;
  syncType: string;
  onComplete: () => void;
}

export function SyncProgress({ taskId, syncType, onComplete }: SyncProgressProps) {
  const [status, setStatus] = useState<string>('starting');
  const [progress, setProgress] = useState<SyncProgressData>({});
  const [report, setReport] = useState<SyncReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const eventSource = new EventSource(`/api/sync/progress/${taskId}`);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.status === 'not_found') {
        eventSource.close();
        setError('Task not found');
        return;
      }

      setStatus(data.status);
      if (data.progress) {
        setProgress(data.progress);
      }
      if (data.report) {
        setReport(data.report);
      }
      if (data.error) {
        setError(data.error);
      }

      if (['completed', 'failed', 'cancelled'].includes(data.status)) {
        eventSource.close();
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [taskId]);

  const handleCancel = async () => {
    await fetch(`/api/sync/cancel/${taskId}`, { method: 'POST' });
  };

  const isActive = ['starting', 'running'].includes(status);
  const isComplete = status === 'completed';
  const isFailed = status === 'failed';
  const isCancelled = status === 'cancelled';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Sync Progress</CardTitle>
            <CardDescription>
              Syncing {syncType}
            </CardDescription>
          </div>
          <Badge variant={isComplete ? 'default' : isFailed ? 'destructive' : 'secondary'}>
            {status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isActive && (
          <>
            <Progress value={progress.percent_complete ?? 0} />
            <div className="grid grid-cols-2 gap-4 text-sm">
              {progress.current_playlist && (
                <div className="col-span-2">
                  <span className="text-muted-foreground">Current: </span>
                  {progress.current_playlist}
                </div>
              )}
              <div>
                <span className="text-muted-foreground">Tracks: </span>
                {progress.current_track_index ?? 0} / {progress.total_tracks ?? 0}
              </div>
              <div>
                <span className="text-muted-foreground">Matched: </span>
                {progress.tracks_matched ?? 0}
              </div>
              <div>
                <span className="text-muted-foreground">Not matched: </span>
                {progress.tracks_not_matched ?? 0}
              </div>
              <div>
                <span className="text-muted-foreground">ISRC matches: </span>
                {progress.isrc_matches ?? 0}
              </div>
            </div>
            {progress.recent_missing && progress.recent_missing.length > 0 && (
              <div className="rounded-md bg-muted p-3">
                <p className="mb-2 text-sm font-medium">Recent missing tracks:</p>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {progress.recent_missing.slice(-3).map((track, i) => (
                    <li key={i}>
                      {track.title} - {track.artist}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <Button variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
          </>
        )}

        {isComplete && report && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="font-medium">Matched: </span>
                {report.tracks_matched ?? report.albums_matched ?? 0}
              </div>
              <div>
                <span className="font-medium">Not matched: </span>
                {report.tracks_not_matched ?? report.albums_not_matched ?? 0}
              </div>
              <div>
                <span className="text-muted-foreground">ISRC/UPC matches: </span>
                {report.isrc_matches ?? report.upc_matches ?? 0}
              </div>
              <div>
                <span className="text-muted-foreground">Fuzzy matches: </span>
                {report.fuzzy_matches ?? 0}
              </div>
            </div>
            <Button onClick={onComplete}>Done</Button>
          </div>
        )}

        {isFailed && (
          <div className="space-y-4">
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error ?? 'Unknown error occurred'}
            </div>
            <Button variant="outline" onClick={onComplete}>
              Dismiss
            </Button>
          </div>
        )}

        {isCancelled && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Sync was cancelled.</p>
            <Button variant="outline" onClick={onComplete}>
              Dismiss
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
