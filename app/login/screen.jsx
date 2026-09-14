'use client';

import { useEffect, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  LockKeyhole,
  Mail,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionPanel,
} from '@/components/ui/accordion';
import { Brand, Notice } from '@/components/focus/shared';
import { authMessages } from '../../lib/auth-messages.mjs';

const callback = 'http://127.0.0.1:3210/api/auth/google/callback';
async function post(path, data) {
  const response = await fetch('/api/auth/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Xin-Request': '1' },
    body: JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) throw Error(body.error || 'Could not continue. Try again.');
  return body;
}
function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.25c1.9-1.75 2.97-4.33 2.97-7.36Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 4.97-.9 6.63-2.41l-3.25-2.51c-.9.6-2.05.97-3.38.97-2.6 0-4.8-1.76-5.59-4.12H3.05v2.59A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.41 13.93a6 6 0 0 1 0-3.86V7.48H3.05a10 10 0 0 0 0 9.04l3.36-2.59Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.95c1.47 0 2.79.51 3.82 1.51l2.87-2.87A9.64 9.64 0 0 0 12 2a10 10 0 0 0-8.95 5.48l3.36 2.59A5.99 5.99 0 0 1 12 5.95Z"
      />
    </svg>
  );
}
export default function Login({ configured, ownerConfigured = true }) {
  const [ready, setReady] = useState(configured),
    [client, setClient] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    setError(authMessages[query.get('error')] || '');
    if (query.has('error')) history.replaceState(null, '', '/login');
  }, []);
  async function signIn() {
    setBusy(true);
    setError('');
    try {
      if (!ready) {
        await post('setup', client);
        setReady(true);
      }
      const flow = await post('google/start', {});
      window.location.assign(flow.url);
    } catch (error) {
      setError(error.message);
      setBusy(false);
    }
  }
  return (
    <main className="sign-in-page">
      <section className="sign-in-main">
        <div className="sign-in-brand">
          <Brand />
          <span>
            <LockKeyhole size={13} />
            Private workspace
          </span>
        </div>
        <div className="sign-in-content">
          <span className="welcome-symbol">
            <Sparkles size={24} />
          </span>
          <p className="view-eyebrow">WELCOME TO FOCUS</p>
          <h1>
            A clear head.
            <br />A deliberate next step.
          </h1>
          <p className="sign-in-description">
            Your meetings, messages, and decisions.
            <br />
            One place to turn context into progress.
          </p>
          <Button
            size="lg"
            variant="outline"
            className="google-sign-in"
            loading={busy}
            disabled={!ownerConfigured || (!ready && !client)}
            onClick={signIn}
          >
            <GoogleIcon />
            Continue with Google
            <ArrowRight />
          </Button>
          <div className="sign-in-gmail">
            <Mail size={16} />
            <p>
              <strong>Gmail comes with you.</strong> Read-only access brings
              email into context. You can also sign in without it.
            </p>
          </div>
          {!ownerConfigured && (
            <Notice error>
              Set the workspace owner in <code>XIN_ALLOWED_EMAIL</code> in your
              local <code>.env.local</code> file, then restart Focus.
            </Notice>
          )}
          {error && <Notice error>{error}</Notice>}
          {!ready && (
            <Accordion defaultValue={['setup']} className="sign-in-setup">
              <AccordionItem value="setup">
                <AccordionTrigger>One-time Google setup</AccordionTrigger>
                <AccordionPanel>
                  <div>
                    <p>
                      Create a Google OAuth client for a{' '}
                      <strong>Web application</strong> and enable the Gmail API.
                      Add this authorized redirect URI:
                    </p>
                    <code>{callback}</code>
                    <p>
                      Use your Workspace organization, or add your account as a
                      test user on the consent screen.
                    </p>
                    <Button
                      variant="link"
                      size="sm"
                      render={
                        <a
                          href="https://console.cloud.google.com/apis/credentials"
                          target="_blank"
                          rel="noreferrer"
                        />
                      }
                    >
                      Open Google Cloud setup
                      <ArrowUpRight />
                    </Button>
                    <Field>
                      <FieldLabel>Upload the downloaded client JSON</FieldLabel>
                      <Input
                        type="file"
                        accept=".json,application/json"
                        onChange={async (event) => {
                          setError('');
                          setClient(null);
                          try {
                            const file = event.target.files?.[0];
                            if (!file) return;
                            if (file.size > 32768)
                              throw Error(
                                'Choose the small client JSON downloaded from Google Cloud.',
                              );
                            setClient(JSON.parse(await file.text()));
                          } catch {
                            setError(
                              'Choose a valid Google OAuth client JSON file.',
                            );
                          }
                        }}
                      />
                    </Field>
                  </div>
                </AccordionPanel>
              </AccordionItem>
            </Accordion>
          )}
        </div>
        <p className="sign-in-footer">
          <LockKeyhole size={13} />
          Your archive stays on this Mac.
        </p>
      </section>
      <aside className="sign-in-story">
        <span className="story-overline">LESS NOISE. MORE FOLLOW-THROUGH.</span>
        <div className="story-content">
          <h2>
            Keep the context.
            <br />
            <span>Choose what matters.</span>
          </h2>
          <p>
            An operating partner for the space between
            <br className="desktop-break" /> “I should do this” and getting it
            done.
          </p>
          <div className="story-steps">
            {[
              [
                BookOpen,
                '01',
                'Bring the context together',
                'Meetings, email, and the details behind the work.',
              ],
              [
                Sparkles,
                '02',
                'Get a clearer perspective',
                'Evidence-backed suggestions from your agent.',
              ],
              [
                CheckCheck,
                '03',
                'Make a deliberate commitment',
                'Three outcomes. A next action. A clear finish.',
              ],
            ].map(([Icon, number, title, description]) => (
              <Card className="story-step" key={number}>
                <span className="story-step-icon">
                  <Icon size={18} />
                </span>
                <div>
                  <strong>{title}</strong>
                  <p>{description}</p>
                </div>
                <Check size={15} />
              </Card>
            ))}
          </div>
        </div>
        <div className="story-bottom">
          <span className="story-dot" />
          Built around your attention.
        </div>
      </aside>
    </main>
  );
}
