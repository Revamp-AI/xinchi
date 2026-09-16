'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, Settings2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField, Heading, Notice, StatusBadge } from './shared';

export default function ReviewSettingsView({ api }) {
  const [settings, setSettings] = useState(null);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pollStopped, setPollStopped] = useState(false);
  useEffect(() => {
    let live = true;
    api('settings/reviews')
      .then((next) => {
        if (live) {
          setSettings(next);
          setModel(next.model);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [api]);
  const loginId = settings?.login?.id;
  const interval = settings?.login?.interval || 5;
  useEffect(() => {
    if (!loginId || pollStopped || busy) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const next = await api('settings/reviews/chatgpt/poll', {
          id: loginId,
        });
        if (live) {
          setSettings(next);
          if (!next.login && next.chatgpt.connected)
            setNotice('ChatGPT connected. Test your model to enable reviews.');
        }
      } catch (e) {
        if (live) {
          setError(e.message);
          setPollStopped(true);
        }
      }
    }, interval * 1000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, loginId, interval, settings, pollStopped, busy]);
  async function act(action, data = {}, message = '') {
    setBusy(action);
    setError('');
    setNotice('');
    try {
      const next = await api(
        'settings/reviews' + (action === 'save' ? '' : '/chatgpt/' + action),
        data,
      );
      setSettings(next);
      setPollStopped(false);
      if (message) setNotice(message);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }
  const tested =
    settings?.chatgpt.connected &&
    settings?.test?.ok &&
    settings.test.model === model;
  const active = settings?.provider === 'chatgpt';
  return (
    <section className="review-settings-view">
      <Heading
        eyebrow="WORKSPACE SETTINGS"
        title="AI reviews"
        description="Choose how Focus reviews your context. Manage your connection and model in one place."
      />
      {error && (
        <Notice error onClose={() => setError('')}>
          {error}
        </Notice>
      )}
      {notice && <Notice onClose={() => setNotice('')}>{notice}</Notice>}
      {!settings ? (
        <p role="status">
          {error
            ? 'Settings could not load. Refresh to try again.'
            : 'Loading review settings…'}
        </p>
      ) : (
        <>
          <Card
            className="review-provider-card"
            aria-labelledby="chatgpt-heading"
          >
            <div className="review-provider-heading">
              <div>
                <h2 id="chatgpt-heading">ChatGPT subscription</h2>
                <p>Connect your ChatGPT account through Codex sign-in.</p>
              </div>
              <StatusBadge tone={active ? 'success' : 'neutral'}>
                {active ? 'Selected for reviews' : 'Optional provider'}
              </StatusBadge>
            </div>
            <p>
              Uses your eligible ChatGPT subscription and its usage limits.
              Model availability depends on your account. The connection test
              uses a small amount of that allowance.
            </p>
            {settings.chatgpt.connected ? (
              <p className="review-account">
                <ShieldCheck size={17} /> Connected
                {settings.chatgpt.email ? ' as ' + settings.chatgpt.email : ''}
                {settings.chatgpt.plan ? ' · ' + settings.chatgpt.plan : ''}
              </p>
            ) : (
              <p>
                {settings.chatgpt.needsLogin
                  ? 'Sign in again to restore this connection.'
                  : active
                    ? 'Reviews are paused until you reconnect ChatGPT.'
                    : 'No ChatGPT account connected.'}
              </p>
            )}
            <div className="review-settings-actions">
              <Button
                disabled={!!busy || !!settings.login}
                variant={settings.chatgpt.connected ? 'outline' : 'default'}
                onClick={() => act('start')}
              >
                {busy === 'start'
                  ? 'Starting sign-in…'
                  : settings.chatgpt.connected || settings.chatgpt.needsLogin
                    ? 'Reconnect ChatGPT'
                    : 'Connect ChatGPT'}
              </Button>
              {(settings.chatgpt.connected || settings.chatgpt.needsLogin) && (
                <Button
                  variant="ghost"
                  disabled={!!busy}
                  onClick={() =>
                    act(
                      'disconnect',
                      {},
                      active
                        ? 'ChatGPT disconnected. Reviews are paused until you reconnect or select AI Gateway.'
                        : 'ChatGPT disconnected.',
                    )
                  }
                >
                  Disconnect ChatGPT
                </Button>
              )}
            </div>
            {settings.login && (
              <div className="review-login" aria-label="ChatGPT sign-in">
                <h3>Finish signing in with OpenAI</h3>
                <p>
                  Open the sign-in page and enter this code. Keep this Settings
                  page open while you approve the connection.
                </p>
                <code className="review-device-code">
                  {settings.login.userCode}
                </code>
                <p className="text-sm text-muted-foreground">
                  Code expires at{' '}
                  {new Date(settings.login.expiresAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  .
                </p>
                <div className="review-settings-actions">
                  <a
                    className="review-signin-link"
                    href={settings.login.verificationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open OpenAI sign-in <ExternalLink size={15} />
                  </a>
                  <Button
                    variant="ghost"
                    disabled={!!busy}
                    onClick={() => act('cancel', { id: settings.login.id })}
                  >
                    Cancel sign-in
                  </Button>
                  {pollStopped && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setError('');
                        setPollStopped(false);
                      }}
                    >
                      Check sign-in again
                    </Button>
                  )}
                </div>
                <p role="status">
                  {pollStopped
                    ? 'Automatic checking paused.'
                    : 'Waiting for you to finish signing in…'}
                </p>
              </div>
            )}
            <FormField
              label="Codex model"
              description="Use a model available to your ChatGPT account, such as gpt-6-astra."
              value={model}
              maxLength={100}
              disabled={!!busy}
              onChange={(e) => setModel(e.target.value)}
            />
            {settings.test && (
              <Notice error={!settings.test.ok}>
                {settings.test.message}
                <br />
                <span className="text-sm">
                  {settings.test.model} ·{' '}
                  {new Date(settings.test.at).toLocaleString()}
                </span>
              </Notice>
            )}
            <div className="review-settings-actions">
              <Button
                variant="outline"
                disabled={
                  !!busy || !settings.chatgpt.connected || !model.trim()
                }
                onClick={() => act('test', { model })}
              >
                {busy === 'test' ? 'Testing ChatGPT…' : 'Test connection'}
              </Button>
              <Button
                disabled={
                  !!busy || !tested || (active && settings.model === model)
                }
                onClick={() =>
                  act(
                    'save',
                    { provider: 'chatgpt', model },
                    'ChatGPT is now selected for new reviews.',
                  )
                }
              >
                {active && settings.model === model
                  ? 'Using ChatGPT for reviews'
                  : 'Use ChatGPT for reviews'}
              </Button>
            </div>
          </Card>
          <Card
            className="review-provider-card"
            aria-labelledby="gateway-heading"
          >
            <div className="review-provider-heading">
              <div>
                <h2 id="gateway-heading">AI Gateway</h2>
                <p>Use the workspace’s Vercel AI Gateway connection.</p>
              </div>
              <StatusBadge tone={!active ? 'success' : 'neutral'}>
                {!active ? 'Selected for reviews' : 'Optional provider'}
              </StatusBadge>
            </div>
            <p>
              Model: <strong>{settings.gatewayModel}</strong>. Uses separate API
              credits and billing configured in Vercel.
            </p>
            <div>
              <Button
                variant="outline"
                disabled={!!busy || !active}
                onClick={() =>
                  act(
                    'save',
                    { provider: 'gateway', model: settings.model },
                    'AI Gateway is now selected for new reviews.',
                  )
                }
              >
                {!active
                  ? 'Using AI Gateway for reviews'
                  : 'Use AI Gateway for reviews'}
              </Button>
            </div>
          </Card>
          <p className="review-settings-note">
            <Settings2 size={17} /> Provider changes apply to new reviews. A
            running review finishes with the provider it started with. ChatGPT
            credentials are kept on the server and excluded from workspace
            exports.
          </p>
        </>
      )}
    </section>
  );
}
