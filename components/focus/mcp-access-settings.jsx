'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Plug, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Notice, StatusBadge } from './shared';

export default function McpAccessSettings({ api }) {
  const [settings, setSettings] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(''),
    [copied, setCopied] = useState(false);
  const refresh = useCallback(async () => {
    const data = await api('mcp/access');
    setSettings(data);
    setError('');
  }, [api]);
  useEffect(() => {
    let active = true;
    api('mcp/access')
      .then((data) => {
        if (active) setSettings(data);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [api]);
  async function disconnect(id) {
    setBusy(id);
    try {
      await api('mcp/disconnect', { id });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(settings.url);
      setCopied(true);
    } catch {
      setError('Copy the server URL from the field below.');
    }
  }
  return (
    <section className="mt-10 space-y-4" aria-labelledby="mcp-settings-title">
      <div>
        <h2
          id="mcp-settings-title"
          className="flex items-center gap-2 text-xl font-semibold"
        >
          <Plug className="size-5" />
          Connect Codex
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Let Codex read your Focus workspace and take actions when you ask.
        </p>
      </div>
      {error && (
        <Notice error>
          {error}
          <Button
            variant="link"
            onClick={() => refresh().catch((e) => setError(e.message))}
          >
            Try again
          </Button>
        </Notice>
      )}
      {!settings ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading MCP connections…
        </p>
      ) : (
        <>
          <Card className="space-y-4 p-5">
            <p className="text-sm">
              In Codex settings, add a <strong>Streamable HTTP</strong> MCP
              server named <strong>focus</strong>, paste this URL, then
              authenticate.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="Focus MCP server URL"
                className="min-w-0 flex-1 rounded-md border bg-muted/30 px-3 py-2 font-mono text-sm"
                value={settings.url}
                readOnly
              />
              <Button variant="outline" onClick={copy}>
                {copied ? <Check /> : <Copy />}
                {copied ? 'Copied' : 'Copy URL'}
              </Button>
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">
                Connect from the Codex CLI
              </summary>
              <pre className="mt-3 overflow-x-auto rounded-md bg-muted/50 p-3 text-xs">{`codex mcp add focus --url ${settings.url}\ncodex mcp login focus`}</pre>
            </details>
            <p className="text-sm text-muted-foreground">
              Manage commitments, contacts, proposals, source context, drafts,
              reviews, and imports. Imports and cloud reviews continue in the
              background. Provider credentials remain private.
            </p>
          </Card>
          <Card className="space-y-4 p-5">
            <h3 className="font-medium">Connected clients</h3>
            {!settings.grants.length ? (
              <p className="text-sm text-muted-foreground">
                No clients connected yet. Authenticate from Codex to grant
                access.
              </p>
            ) : (
              settings.grants.map((grant) => {
                const active = !grant.revoked_at && !grant.expired;
                return (
                  <div
                    key={grant.id}
                    className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"
                  >
                    <div>
                      <p className="font-medium">{grant.client_name}</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {grant.scope.includes('focus:write')
                          ? 'Read and write'
                          : 'Read only'}{' '}
                        ·{' '}
                        {grant.last_used_at
                          ? 'Last used ' +
                            new Date(grant.last_used_at).toLocaleString()
                          : 'Not used yet'}
                      </p>
                    </div>
                    {active ? (
                      <Button
                        variant="outline"
                        disabled={!!busy}
                        onClick={() => disconnect(grant.id)}
                      >
                        <Unplug />
                        Revoke access
                      </Button>
                    ) : (
                      <StatusBadge>
                        {grant.revoked_at ? 'Revoked' : 'Expired'}
                      </StatusBadge>
                    )}
                  </div>
                );
              })
            )}
          </Card>
          {settings.activity.length > 0 && (
            <Card className="space-y-3 p-5">
              <h3 className="font-medium">Recent MCP actions</h3>
              {settings.activity.map((entry, index) => (
                <div
                  key={index}
                  className="flex flex-wrap justify-between gap-2 text-sm"
                >
                  <span>
                    {entry.client_name} ·{' '}
                    {entry.tool.replace(/^focus_/, '').replaceAll('_', ' ')}
                  </span>
                  <time className="text-muted-foreground">
                    {new Date(entry.created_at).toLocaleString()}
                  </time>
                </div>
              ))}
            </Card>
          )}
        </>
      )}
    </section>
  );
}
