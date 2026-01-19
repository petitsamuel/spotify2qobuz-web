'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface Migration {
  id: number;
  sync_type: string;
  status: string;
  dry_run: boolean;
  tracks_matched: number;
  tracks_not_matched: number;
  isrc_matches: number;
  fuzzy_matches: number;
  started_at: string;
  completed_at: string | null;
}

export function MigrationTable() {
  const { data, isLoading } = useQuery<{ migrations: Migration[]; total: number }>({
    queryKey: ['migrations', 'all'],
    queryFn: async () => {
      const res = await fetch('/api/migrations?limit=50');
      if (!res.ok) return { migrations: [], total: 0 };
      return res.json();
    },
  });

  const migrations = data?.migrations ?? [];

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Migration History</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  if (migrations.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Migration History</CardTitle>
          <CardDescription>No migrations yet</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Start a sync from the dashboard to migrate your library.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Migration History</CardTitle>
        <CardDescription>
          All sync operations ({data?.total ?? 0} total)
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Matched</TableHead>
              <TableHead className="text-right">Unmatched</TableHead>
              <TableHead className="text-right">ISRC</TableHead>
              <TableHead className="text-right">Fuzzy</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {migrations.map((migration) => (
              <TableRow key={migration.id}>
                <TableCell className="text-sm">
                  <div>
                    {new Date(migration.started_at).toLocaleDateString()}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(migration.started_at).toLocaleTimeString()}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="capitalize">{migration.sync_type}</span>
                    {migration.dry_run && (
                      <Badge variant="outline" className="text-xs">
                        Dry
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell>
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
                </TableCell>
                <TableCell className="text-right">
                  {migration.tracks_matched}
                </TableCell>
                <TableCell className="text-right">
                  {migration.tracks_not_matched}
                </TableCell>
                <TableCell className="text-right">
                  {migration.isrc_matches}
                </TableCell>
                <TableCell className="text-right">
                  {migration.fuzzy_matches}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
