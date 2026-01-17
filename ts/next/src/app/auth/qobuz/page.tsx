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
              <p className="text-xs text-muted-foreground">
                You can find this token in your browser&apos;s developer tools when logged into
                Qobuz. Look for the &quot;x-user-auth-token&quot; header in network requests.
              </p>
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
