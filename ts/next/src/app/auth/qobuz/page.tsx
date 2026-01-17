'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export default function QobuzAuthPage() {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('token', token);

      const res = await fetch('/api/auth/qobuz/token', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Failed to authenticate');
        return;
      }

      router.push('/');
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Connect Qobuz</CardTitle>
          <CardDescription>
            Enter your Qobuz user auth token to connect your account
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="token">User Auth Token</Label>
              <Input
                id="token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Enter your Qobuz token"
                required
              />
              <div className="text-xs text-muted-foreground space-y-3 mt-3">
                <p className="font-medium">How to get your Qobuz token:</p>
                <ol className="list-decimal list-inside space-y-2 ml-1">
                  <li>
                    Open{' '}
                    <a
                      href="https://play.qobuz.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      play.qobuz.com
                    </a>{' '}
                    and log in to your account
                  </li>
                  <li>
                    Open your browser&apos;s Developer Tools:
                    <ul className="list-disc list-inside ml-4 mt-1 space-y-1">
                      <li><strong>Windows/Linux:</strong> Press F12 or Ctrl+Shift+I</li>
                      <li><strong>Mac:</strong> Press Cmd+Option+I</li>
                    </ul>
                  </li>
                  <li>Click the <strong>Network</strong> tab in Developer Tools</li>
                  <li>Play any song or navigate around the page to trigger API requests</li>
                  <li>
                    In the filter box, type <code className="bg-muted px-1 rounded">api.json</code> to
                    filter requests
                  </li>
                  <li>Click on any request in the list</li>
                  <li>
                    In the <strong>Headers</strong> section, scroll down to find{' '}
                    <code className="bg-muted px-1 rounded">X-User-Auth-Token</code>
                  </li>
                  <li>Copy the token value (it&apos;s a long string of letters and numbers)</li>
                </ol>
                <p className="text-amber-600 dark:text-amber-400">
                  Note: This token expires periodically. If syncing stops working, you may need to
                  get a fresh token.
                </p>
              </div>
            </div>

            <Button type="submit" className="w-full" disabled={isSubmitting || !token}>
              {isSubmitting ? 'Connecting...' : 'Connect Qobuz'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
