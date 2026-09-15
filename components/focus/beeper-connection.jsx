'use client';

import { useState } from 'react';
import { RefreshCw, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Modal,
  Notice,
  ProviderIcon,
  StatusBadge,
  countSources,
} from './shared';

export default function BeeperConnection({ state, api, refresh }) {
  const [open, setOpen] = useState(false);
  const [pairing, setPairing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connection = state.connections.beeper || { configured: false };
  const latest = state.sync.find((r) => r.provider === 'beeper');
  const active = ['uploading', 'queued', 'running'].includes(latest?.state);
  const waiting = connection.configured && !connection.online;
  async function act(path) {
    setBusy(true);
    setError('');
    try {
      const result = await api(path, {});
      if (path === 'beeper/pairing') setPairing(result);
      if (path === 'beeper/revoke') setPairing(null);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function sync() {
    if (latest?.state !== 'failed') return act('beeper/refresh');
    setBusy(true);
    setError('');
    try {
      await api('sync', { provider: 'beeper', retry_id: latest.id });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const label = !connection.configured
    ? 'Not connected'
    : waiting
      ? 'Waiting for your Mac'
      : connection.issue
        ? 'Needs attention'
        : active
          ? 'Importing'
          : 'Connected';
  return (
    <>
      <Card className="connection-row">
        <div className="connection-primary">
          <ProviderIcon provider="beeper" />
          <div className="connection-identity">
            <h2>
              Beeper{' '}
              <StatusBadge dot tone={active ? 'info' : 'neutral'}>
                {label}
              </StatusBadge>
            </h2>
            <p>
              Selected conversations from your Mac, connected to your contacts.
            </p>
            {connection.configured && (
              <span>
                {connection.label} · {connection.selection.length} conversations
              </span>
            )}
          </div>
          <div className="connection-total">
            <strong>{countSources(state, 'beeper').toLocaleString()}</strong>
            <span>messages stored</span>
          </div>
          <div className="connection-buttons">
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
              <Settings2 />
              {connection.configured ? 'Beeper settings' : 'Connect Beeper'}
            </Button>
            <Button
              size="sm"
              disabled={
                busy || !connection.configured || active || connection.requested
              }
              onClick={sync}
            >
              <RefreshCw />
              {active
                ? 'Importing'
                : connection.requested
                  ? 'Refresh queued'
                  : latest?.state === 'failed'
                    ? 'Retry import'
                    : 'Refresh'}
            </Button>
          </div>
        </div>
        <div className="connection-progress">
          <p>
            {connection.issue ||
              (waiting
                ? 'Syncing resumes when your Mac and Beeper are available.'
                : latest?.message) ||
              'Pair your Mac to choose which conversations Focus can read.'}
          </p>
          {connection.last_seen && (
            <small>
              Last seen {new Date(connection.last_seen).toLocaleString()}
            </small>
          )}
        </div>
        {error && !open && <Notice error>{error}</Notice>}
      </Card>
      {open && (
        <Modal
          title="Connect Beeper from your Mac"
          description="Read-only syncing for conversations you select. Your Beeper credential stays on this Mac."
          onClose={() => {
            setOpen(false);
            setPairing(null);
          }}
        >
          <div className="connection-form">
            <ol className="beeper-setup-steps">
              <li>
                Open Beeper Desktop. In Settings → Integrations, enable the
                Desktop API. Keep Remote Access off.
              </li>
              <li>
                <a href="/beeper-companion.mjs" download="beeper-companion.mjs">
                  Download the Focus companion
                </a>
                . It requires Node.js 24 or newer.
              </li>
              <li>
                Run this command in Terminal on your Mac:
                <pre className="beeper-command">
                  node ~/Downloads/beeper-companion.mjs setup
                </pre>
              </li>
              <li>
                Approve read-only access in Beeper, then select conversations in
                Terminal. Focus imports up to 90 days of available message text.
              </li>
              <li>
                Generate a pairing code here when the companion asks for it.
                Setup enables syncing when you sign in to your Mac.
              </li>
            </ol>
            <p>
              Selected messages are saved in your Focus cloud archive and used
              for contact extraction and cloud reviews. Attachments and group
              conversations are excluded from this first version.
            </p>
            <Button disabled={busy} onClick={() => act('beeper/pairing')}>
              {pairing
                ? 'Generate another pairing code'
                : 'Generate pairing code'}
            </Button>
            {pairing && (
              <div>
                <label htmlFor="beeper-pairing">
                  One-time pairing code · expires in 10 minutes
                </label>
                <input
                  id="beeper-pairing"
                  className="beeper-pairing"
                  value={pairing.code}
                  readOnly
                  onFocus={(e) => e.target.select()}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            )}
            {connection.configured && (
              <>
                <p>
                  Paired with {connection.label}. To change your conversation
                  selection, run setup again. Completing a new pairing replaces
                  this Mac’s previous connection.
                </p>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => act('beeper/revoke')}
                >
                  Disconnect companion
                </Button>
                <p>
                  Disconnecting stops new uploads. Previously imported messages
                  remain in your archive.
                </p>
              </>
            )}
            {error && <Notice error>{error}</Notice>}
          </div>
        </Modal>
      )}
    </>
  );
}
