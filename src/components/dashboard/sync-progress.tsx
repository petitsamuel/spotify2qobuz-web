'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
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

// Polling interval in milliseconds - fast enough for good UX, slow enough to not overload
const POLLING_INTERVAL_MS = 1500;

export function SyncProgress({ taskId, syncType, onComplete }: SyncProgressProps) {
  const [status, setStatus] = useState<string>('starting');
  const [progress, setProgress] = useState<SyncProgressData>({});
  const [report, setReport] = useState<SyncReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<boolean>(false);
  const retryCountRef = useRef(0);
  const maxRetries = 3;

  const fetchProgress = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch(`/api/sync/status/${taskId}`);

      if (!response.ok) {
        if (response.status === 404) {
          setError('Task not found');
          return false; // Stop polling
        }
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      // Reset retry count on successful fetch
      retryCountRef.current = 0;
      setConnectionError(false);

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

      // Return false to stop polling when task is complete
      if (['completed', 'failed', 'cancelled'].includes(data.status)) {
        return false;
      }

      return true; // Continue polling
    } catch (err) {
      retryCountRef.current++;
      console.error(`Failed to fetch progress (attempt ${retryCountRef.current}):`, err);

      if (retryCountRef.current >= maxRetries) {
        setConnectionError(true);
        setError('Lost connection to server. Please refresh the page.');
        return false; // Stop polling after max retries
      }

      return true; // Continue polling to retry
    }
  }, [taskId]);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let isMounted = true;

    const startPolling = async () => {
      // Fetch immediately on mount
      const shouldContinue = await fetchProgress();

      if (!isMounted) return;

      if (shouldContinue) {
        intervalId = setInterval(async () => {
          if (!isMounted) {
            if (intervalId) clearInterval(intervalId);
            return;
          }

          const continuePolling = await fetchProgress();
          if (!continuePolling && intervalId) {
            clearInterval(intervalId);
          }
        }, POLLING_INTERVAL_MS);
      }
    };

    startPolling();

    return () => {
      isMounted = false;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [fetchProgress]);

  const handleCancel = async () => {
    await fetch(`/api/sync/cancel/${taskId}`, { method: 'POST' });
  };

  const handleRetry = () => {
    retryCountRef.current = 0;
    setConnectionError(false);
    setError(null);
    fetchProgress();
  };

  const isActive = ['starting', 'running'].includes(status) && !connectionError;
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

        {connectionError && (
          <div className="space-y-4">
            <div className="rounded-md bg-yellow-500/10 p-3 text-sm text-yellow-700 dark:text-yellow-400">
              {error ?? 'Connection lost. The sync may still be running in the background.'}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleRetry}>
                Retry
              </Button>
              <Button variant="ghost" onClick={onComplete}>
                Dismiss
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
