'use client';

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
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
  const [activeSync, setActiveSync] = useState<{ taskId: string; syncType: string } | null>(null);

  // Check for existing active sync on mount
  const { data: existingTask } = useQuery<ActiveTask | null>({
    queryKey: ['activeTask'],
    queryFn: async () => {
      const res = await fetch('/api/sync/active');
      if (!res.ok) return null;
      const data = await res.json();
      return data.task_id ? data : null;
    },
    enabled: !activeSync,
  });

  useEffect(() => {
    if (existingTask?.task_id && !activeSync) {
      setActiveSync({
        taskId: existingTask.task_id,
        syncType: existingTask.sync_type,
      });
    }
  }, [existingTask, activeSync]);

  const handleSyncStarted = (taskId: string, syncType: string) => {
    setActiveSync({ taskId, syncType });
  };

  const handleSyncComplete = () => {
    setActiveSync(null);
  };

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
            disabled={!!activeSync}
          />
        )}

        <RecentMigrations />
      </div>
    </div>
  );
}
