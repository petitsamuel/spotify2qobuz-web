'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface Suggestion {
  qobuz_id: number;
  title: string;
  artist: string;
  album: string;
  score: number;
}

interface SuggestionCardProps {
  suggestion: Suggestion;
  onSelect: (qobuzId: number) => void;
}

export function SuggestionCard({ suggestion, onSelect }: SuggestionCardProps) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{suggestion.title}</p>
            <p className="truncate text-sm text-muted-foreground">
              {suggestion.artist}
            </p>
            {suggestion.album && (
              <p className="truncate text-xs text-muted-foreground">
                {suggestion.album}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="text-xs text-muted-foreground">
              {Math.round(suggestion.score * 100)}% match
            </span>
            <Button size="sm" onClick={() => onSelect(suggestion.qobuz_id)}>
              Select
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
