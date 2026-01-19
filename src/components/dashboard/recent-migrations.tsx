'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface Migration {
  id: number;
  sync_type: string;
  status: string;
  dry_run: boolean;
  tracks_matched: number;
  tracks_not_matched: number;
  started_at: string;
  completed_at: string | null;
}

export function RecentMigrations() {
  const { data: migrations, isLoading } = useQuery<Migration[]>({
    queryKey: ['migrations'],
    queryFn: async () => {
      const res = await fetch('/api/migrations?limit=5');
      if (!res.ok) return [];
      const data = await res.json();
      return data.migrations ?? [];
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recent Migrations</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  if (!migrations || migrations.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recent Migrations</CardTitle>
          <CardDescription>No migrations yet</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Start a sync to migrate your library.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Migrations</CardTitle>
        <CardDescription>Last 5 sync operations</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {migrations.map((migration) => (
            <div
              key={migration.id}
              className="flex items-center justify-between border-b pb-3 last:border-0 last:pb-0"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium capitalize">{migration.sync_type}</span>
                  {migration.dry_run && (
                    <Badge variant="outline" className="text-xs">
                      Dry run
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(migration.started_at).toLocaleDateString()}{' '}
                  {new Date(migration.started_at).toLocaleTimeString()}
                </p>
              </div>
              <div className="text-right">
                <Badge
                  variant={
                    migration.status === 'completed'
                      ? 'default'
                      : migration.status === 'failed'
                      ? 'destructive'
                      : migration.status === 'interrupted'
                      ? 'outline'
                      : 'secondary'
                  }
                >
                  {migration.status}
                </Badge>
                {migration.status === 'completed' && (
                  <p className="text-xs text-muted-foreground">
                    {migration.tracks_matched} matched
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
