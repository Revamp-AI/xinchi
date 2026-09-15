'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Brand, Notice } from '@/components/focus/shared';

export default function McpConsent({ clientName, request, signedIn }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const canWrite = request.scope.split(' ').includes('focus:write');
  async function decide(allow) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/mcp/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Xin-Request': '1' },
        body: JSON.stringify({ request, allow }),
      });
      const data = await response.json();
      if (!response.ok)
        throw Error(data.error_description || 'Could not connect. Try again.');
      window.location.assign(data.redirect);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-6">
      <Brand />
      <Card className="space-y-5 p-6">
        <h1 className="text-2xl font-semibold">
          Connect {clientName} to Focus
        </h1>
        <p className="text-sm text-muted-foreground">
          This connection can read your private workspace
          {canWrite ? ' and make changes when you ask' : ''}.
        </p>
        <ul className="list-disc space-y-2 pl-5 text-sm">
          <li>
            Read commitments, contacts, the heat map, and source documents.
          </li>
          {canWrite && (
            <>
              <li>
                Create and update commitments, contacts, and private drafts.
              </li>
              <li>Manage proposals, source imports, and AI reviews.</li>
            </>
          )}
        </ul>
        <p className="text-sm text-muted-foreground">
          Access lasts up to 90 days. Revoke it anytime in Focus Settings.
          Provider credentials are never returned.
        </p>
        <p className="break-all text-xs text-muted-foreground">
          Return address: {new URL(request.redirect_uri).origin}
        </p>
        {error && <Notice error>{error}</Notice>}
        {signedIn ? (
          <div className="flex flex-wrap gap-3">
            <Button disabled={busy} onClick={() => decide(true)}>
              Allow {canWrite ? 'read and write' : 'read-only'} access
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => decide(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm">
              Sign in to Focus, then return to this tab to continue.
            </p>
            <a
              href="/login"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Sign in to Focus
            </a>
            <Button
              className="block"
              variant="outline"
              onClick={() => window.location.reload()}
            >
              I’m signed in — continue
            </Button>
          </div>
        )}
      </Card>
    </main>
  );
}
