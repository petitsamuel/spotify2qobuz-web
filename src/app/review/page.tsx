import { UnmatchedList } from '@/components/review/unmatched-list';

export default function ReviewPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Review Unmatched</h1>
        <p className="text-muted-foreground">
          Manually resolve tracks that couldn&apos;t be automatically matched
        </p>
      </div>

      <UnmatchedList />
    </div>
  );
}
