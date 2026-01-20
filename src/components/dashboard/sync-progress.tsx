'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';

// Spinning loader component
function Loader({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

// Animated stat component that pulses when value changes
function AnimatedStat({ label, value, prevValue }: { label: string; value: number; prevValue: number }) {
  const changed = value !== prevValue;

  return (
    <div className={changed ? 'animate-count-pulse' : ''}>
      <span className="text-muted-foreground">{label}: </span>
      <span className={changed ? 'text-primary font-medium' : ''}>{value}</span>
    </div>
  );
}

interface SyncProgressData {
  current_playlist?: string;
  current_playlist_index?: number;
  total_playlists?: number;
  playlists_skipped?: number;
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
  playlists_skipped?: number;
  isrc_matches?: number;
  upc_matches?: number;
  fuzzy_matches?: number;
}

interface ChunkState {
  offset: number;
  totalItems: number;
  processedInChunk: number;
  hasMore: boolean;
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
  const [prevProgress, setPrevProgress] = useState<SyncProgressData>({});
  const [report, setReport] = useState<SyncReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<boolean>(false);
  const [chunkState, setChunkState] = useState<ChunkState | null>(null);
  const [isContinuing, setIsContinuing] = useState<boolean>(false);
  const retryCountRef = useRef(0);
  const progressRef = useRef<SyncProgressData>({});
  const seenTracksRef = useRef<Set<string>>(new Set());
  const maxRetries = 3;

  // Continue the sync when a chunk completes
  const continueSync = useCallback(async (): Promise<boolean> => {
    if (isContinuing) return true; // Avoid duplicate calls

    setIsContinuing(true);
    try {
      const response = await fetch(`/api/sync/continue/${taskId}`, { method: 'POST' });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('Failed to continue sync:', errorData);
        setError(errorData.error || `Failed to continue sync: HTTP ${response.status}`);
        return false;
      }

      // Sync continuation started, continue polling
      setStatus('running');
      return true;
    } catch (err) {
      console.error('Failed to continue sync:', err);
      setError('Failed to continue sync. Please try again.');
      return false;
    } finally {
      setIsContinuing(false);
    }
  }, [taskId, isContinuing]);

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
        setPrevProgress(progressRef.current);
        setProgress(data.progress);
        progressRef.current = data.progress;
      }
      if (data.report) {
        setReport(data.report);
      }
      if (data.error) {
        setError(data.error);
      }
      if (data.chunk_state) {
        setChunkState(data.chunk_state);
      }

      // Handle chunk_complete status - automatically continue
      if (data.status === 'chunk_complete' && !isContinuing) {
        // Trigger continuation and continue polling
        continueSync();
        return true;
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
  }, [taskId, isContinuing, continueSync]);

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

  const handleRetry = async () => {
    retryCountRef.current = 0;
    setConnectionError(false);
    setError(null);
    try {
      await fetchProgress();
    } catch (err) {
      console.error('Retry failed:', err);
    }
  };

  const isActive = ['starting', 'running', 'chunk_complete'].includes(status) && !connectionError;
  const isComplete = status === 'completed';
  const isFailed = status === 'failed';
  const isCancelled = status === 'cancelled';
  const isChunkComplete = status === 'chunk_complete';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Sync Progress</CardTitle>
            <CardDescription>
              Syncing {syncType.charAt(0).toUpperCase() + syncType.slice(1)}
            </CardDescription>
          </div>
          <Badge
            variant={isComplete ? 'default' : isFailed ? 'destructive' : 'secondary'}
            className={isActive ? 'animate-pulse-glow' : ''}
          >
            {isActive && <Loader className="mr-1.5 animate-spin-slow inline-block" />}
            {isChunkComplete ? 'continuing...' : status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isActive && (
          <>
            <Progress
              value={chunkState && chunkState.totalItems > 0 ? (chunkState.offset / chunkState.totalItems) * 100 : progress.percent_complete ?? 0}
              animated={true}
              className="h-3"
            />
            {chunkState && chunkState.totalItems > 0 && (
              <div className="text-xs text-muted-foreground">
                Overall: {chunkState.offset} / {chunkState.totalItems} {syncType === 'albums' ? 'albums' : 'tracks'}
              </div>
            )}
            {syncType === 'playlists' && progress.total_playlists && progress.total_playlists > 0 && (
              <div className="text-sm font-medium">
                Playlist {progress.current_playlist_index ?? 0} / {progress.total_playlists}
                {(progress.playlists_skipped ?? 0) > 0 && (
                  <span className="text-muted-foreground ml-2">
                    ({progress.playlists_skipped} skipped)
                  </span>
                )}
              </div>
            )}
            {syncType === 'albums' && chunkState && chunkState.totalItems > 0 && (
              <div className="text-sm font-medium">
                Album {Math.min(chunkState.offset + (chunkState.processedInChunk || 0), chunkState.totalItems)} / {chunkState.totalItems}
              </div>
            )}
            <div className="grid grid-cols-2 gap-4 text-sm">
              {progress.current_playlist && (
                <div className="col-span-2">
                  <span className="text-muted-foreground">Current: </span>
                  <span className="font-medium">{progress.current_playlist}</span>
                </div>
              )}
              <div className={(progress.current_track_index ?? 0) !== (prevProgress.current_track_index ?? 0) ? 'animate-count-pulse' : ''}>
                <span className="text-muted-foreground">Tracks: </span>
                <span className="font-medium tabular-nums">{progress.current_track_index ?? 0}</span>
                <span className="text-muted-foreground"> / {progress.total_tracks ?? 0}</span>
              </div>
              <AnimatedStat
                label="Matched"
                value={progress.tracks_matched ?? 0}
                prevValue={prevProgress.tracks_matched ?? 0}
              />
              <AnimatedStat
                label="Not matched"
                value={progress.tracks_not_matched ?? 0}
                prevValue={prevProgress.tracks_not_matched ?? 0}
              />
              <AnimatedStat
                label="ISRC matches"
                value={progress.isrc_matches ?? 0}
                prevValue={prevProgress.isrc_matches ?? 0}
              />
            </div>
            {progress.recent_missing && progress.recent_missing.length > 0 && (
              <div className="rounded-md bg-muted p-3 overflow-hidden">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-medium">Recent missing tracks:</p>
                  <Link href="/review" className="text-xs text-primary hover:underline">
                    Review all
                  </Link>
                </div>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {progress.recent_missing.slice(-3).map((track, i) => {
                    const trackKey = `${track.title}-${track.artist}`;
                    const isNew = !seenTracksRef.current.has(trackKey);
                    if (isNew) seenTracksRef.current.add(trackKey);
                    return (
                      <li
                        key={trackKey}
                        className={isNew ? 'animate-slide-in' : ''}
                        style={isNew ? { animationDelay: `${i * 100}ms` } : undefined}
                      >
                        {track.title} - {track.artist}
                      </li>
                    );
                  })}
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
              {(report.playlists_skipped ?? 0) > 0 && (
                <div className="col-span-2">
                  <span className="text-muted-foreground">Playlists skipped (unchanged): </span>
                  {report.playlists_skipped}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={onComplete}>Done</Button>
              {((report.tracks_not_matched ?? report.albums_not_matched ?? 0) > 0) && (
                <Button variant="outline" asChild>
                  <Link href="/review">Review Unmatched</Link>
                </Button>
              )}
            </div>
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
