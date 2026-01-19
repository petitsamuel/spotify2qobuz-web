'use client';

import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ConnectionStatus } from '@/components/dashboard/connection-status';
import { SyncControls } from '@/components/dashboard/sync-controls';
import { SyncProgress } from '@/components/dashboard/sync-progress';
import { LibraryStats } from '@/components/dashboard/library-stats';
import { RecentMigrations } from '@/components/dashboard/recent-migrations';

interface ActiveTask {
  task_id: string;
  sync_type: string;
  progress: Record<string, unknown>;
  dry_run: boolean;
}

export default function DashboardPage() {
  const queryClient = useQueryClient();
  const [manualActiveSync, setManualActiveSync] = useState<{ taskId: string; syncType: string } | null>(null);

  // Check for existing active sync on mount
  const { data: existingTask, isLoading: isCheckingActiveTask } = useQuery<ActiveTask | null>({
    queryKey: ['activeTask'],
    queryFn: async () => {
      const res = await fetch('/api/sync/active');
      if (!res.ok) return null;
      const data = await res.json();
      return data.task_id ? data : null;
    },
    enabled: !manualActiveSync,
    staleTime: 0, // Always refetch on mount
    refetchOnWindowFocus: true, // Refetch when user returns to the page
  });

  // Derive activeSync from either manual state or query data
  const activeSync = manualActiveSync ?? (existingTask ? {
    taskId: existingTask.task_id,
    syncType: existingTask.sync_type,
  } : null);

  const handleSyncStarted = useCallback((taskId: string, syncType: string) => {
    setManualActiveSync({ taskId, syncType });
  }, []);

  const handleSyncComplete = useCallback(() => {
    setManualActiveSync(null);
    // Clear the activeTask cache so stale data doesn't keep the modal open
    queryClient.setQueryData(['activeTask'], null);
    // Refresh Qobuz stats and migrations list to show updated data after sync
    queryClient.invalidateQueries({ queryKey: ['qobuzStats'] });
    queryClient.invalidateQueries({ queryKey: ['migrations'] });
  }, [queryClient]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">
          Sync your Spotify library to Qobuz
        </p>
      </div>

      <ConnectionStatus />

      <LibraryStats />

      <div className="grid gap-6 lg:grid-cols-2">
        {activeSync ? (
          <SyncProgress
            taskId={activeSync.taskId}
            syncType={activeSync.syncType}
            onComplete={handleSyncComplete}
          />
        ) : (
          <SyncControls
            onSyncStarted={handleSyncStarted}
            disabled={isCheckingActiveTask}
          />
        )}

        <RecentMigrations />
      </div>
    </div>
  );
}
