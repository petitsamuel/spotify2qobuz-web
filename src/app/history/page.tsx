import { MigrationTable } from '@/components/history/migration-table';

export default function HistoryPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Migration History</h1>
        <p className="text-muted-foreground">
          View all past sync operations
        </p>
      </div>

      <MigrationTable />
    </div>
  );
}
