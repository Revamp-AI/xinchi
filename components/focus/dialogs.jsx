'use client';

import { useCallback, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  Clock3,
  FileText,
  History,
  LockKeyhole,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldLabel } from '@/components/ui/field';
import { Card } from '@/components/ui/card';
import {
  Choice,
  FormField,
  Modal,
  Notice,
  ProviderIcon,
  StatusBadge,
  formatDate,
  providerNames,
  statusNames,
} from './shared';

const statusNeeds = {
  candidate: [],
  now: ['done_when', 'next_action', 'owner', 'checkpoint'],
  waiting: ['dependency', 'checkpoint'],
  later: ['reason', 'checkpoint'],
  dropped: ['reason'],
  done: ['evidence'],
};
const statusHints = {
  candidate: 'Only a title is needed while you decide.',
  now: 'Needs what done means, a next action, an owner, and a checkpoint.',
  waiting: 'Needs who or what you are waiting on and a check-back date.',
  later: 'Needs a reason and a review date.',
  dropped: 'Needs a reason for closing it.',
  done: 'Needs the finished output or decision as evidence.',
};
const checkpointLabels = {
  now: 'Delivery or review checkpoint',
  waiting: 'Check back on',
  later: 'Review on',
};
const reasonLabels = {
  later: 'Why defer, and what brings it back?',
  dropped: 'Why close this?',
};
export function CommitmentDialog({
  item,
  setItem,
  now,
  busy,
  error,
  close,
  save,
  openSource,
  showHistory,
}) {
  const update = (key, value) =>
    setItem((current) => ({ ...current, [key]: value }));
  const status = item.status || 'candidate';
  const needs = (key) => statusNeeds[status].includes(key);
  const field = (key, label, extra = {}) => (
    <FormField
      label={label}
      required={needs(key)}
      value={item[key] || ''}
      onChange={(event) => update(key, event.target.value)}
      {...extra}
    />
  );
  const checkpoint = field(
    'checkpoint',
    checkpointLabels[status] || 'Delivery or review checkpoint',
    { type: 'date' },
  );
  const hardDeadline = field('hard_deadline', 'Hard external deadline', {
    type: 'date',
    description: 'Only add a date that is confirmed.',
  });
  const requiresTradeoff =
    item.status === 'now' &&
    now.filter((other) => other.id !== item.id).length >= 3;
  return (
    <Modal
      title={item.id ? 'Review commitment' : 'Choose an outcome'}
      description="Make the finish clear before you make the commitment."
      onClose={close}
      wide
    >
      <form
        className="commitment-form"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <FormField
          label="What is the outcome?"
          required
          value={item.title || ''}
          onChange={(event) => update('title', event.target.value)}
          placeholder="A concrete output or decision"
        />
        <div className="form-pair">
          <FormField label="Type">
            <Choice
              value={item.kind || 'action'}
              onChange={(value) => update('kind', value)}
              options={{ action: 'Action / output', decision: 'Decision' }}
              label="Type"
            />
          </FormField>
          <FormField label="Your decision" description={statusHints[status]}>
            <Choice
              value={status}
              onChange={(value) => update('status', value)}
              options={statusNames}
              label="Your decision"
            />
          </FormField>
        </div>
        {field('done_when', 'Done means', {
          multiline: true,
          rows: 2,
          placeholder: 'What will exist when this is finished?',
        })}
        {field('next_action', 'Next concrete action', {
          placeholder: 'The next step you can actually take',
        })}
        <div className="form-pair">
          {field('owner', 'Owner')}
          {checkpoint}
        </div>
        {status === 'waiting' && (
          <>
            <div className="form-pair">
              {hardDeadline}
              {field('dependency', 'Waiting for / dependency', {
                placeholder: 'Who or what needs to move first?',
              })}
            </div>
            <div className="form-pair">
              {field('last_action', 'Last thing you did', {
                placeholder: 'The nudge or hand-off you already made',
              })}
              {field('fallback', 'If still blocked on the check-back date', {
                placeholder: 'What you will do instead',
              })}
            </div>
          </>
        )}
        {['candidate', 'now', 'later'].includes(status) && hardDeadline}
        {['now', 'done'].includes(status) &&
          field(
            'evidence',
            status === 'done'
              ? 'Completion evidence'
              : 'Finished output or evidence',
            {
              multiline: true,
              rows: 2,
              placeholder: 'A link or description of the completed output',
            },
          )}
        {field(
          'reason',
          reasonLabels[status] || 'Why this decision or change?',
          { multiline: true, rows: 2 },
        )}
        {requiresTradeoff && (
          <Card className="tradeoff-panel">
            <StatusBadge tone="warning">
              Three outcomes are already active
            </StatusBadge>
            <h3>Make room by subtraction</h3>
            <p>Choose what moves aside and when you’ll reconsider it.</p>
            <FormField label="Move this outcome to Later">
              <Choice
                required
                label="Outcome to replace"
                value={item.replace_id || ''}
                onChange={(value) => update('replace_id', value)}
                options={{
                  '': 'Choose an outcome',
                  ...Object.fromEntries(
                    now
                      .filter((other) => other.id !== item.id)
                      .map((other) => [other.id, other.title]),
                  ),
                }}
              />
            </FormField>
            <FormField
              label="Why is the tradeoff worth it?"
              required
              value={item.tradeoff_reason || ''}
              onChange={(event) =>
                update('tradeoff_reason', event.target.value)
              }
            />
            <FormField
              label="Reconsider the displaced work on"
              type="date"
              required
              value={item.replace_checkpoint || ''}
              onChange={(event) =>
                update('replace_checkpoint', event.target.value)
              }
            />
          </Card>
        )}
        <Field className="checkbox-field">
          <FieldLabel>
            <Checkbox
              checked={!!item.shared}
              onCheckedChange={(checked) => update('shared', checked)}
            />
            Include in business updates <span>(nothing is sent)</span>
          </FieldLabel>
        </Field>
        {item.source_id && (
          <Card className="evidence-preview">
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                openSource(
                  item.source_id,
                  item.source_quote,
                  item.source_version_id,
                )
              }
            >
              <FileText />
              View source material
              <ArrowUpRight />
            </Button>
            <blockquote>
              {item.source_quote || 'Source linked; no excerpt selected.'}
            </blockquote>
          </Card>
        )}
        {error && <Notice error>{error}</Notice>}
        <div className="dialog-actions">
          <div>
            {item.id && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => showHistory(item.id)}
              >
                <History />
                History
              </Button>
            )}
          </div>
          <div>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              <Check />
              Save decision
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
export function SourceDialog({ source, close }) {
  const quote = source.quote || '';
  const body = source.body || '';
  const start = quote ? body.indexOf(quote) : -1;
  const scrollToMark = useCallback((node) => {
    node?.scrollIntoView({ block: 'center' });
  }, []);
  return (
    <Modal
      title={source.title}
      description="Original material from your saved context."
      onClose={close}
      wide
    >
      <div className="source-view">
        <div className="source-view-meta">
          <span>
            <ProviderIcon provider={source.provider} small />
            {providerNames[source.provider]}
          </span>
          <StatusBadge>{source.coverage}</StatusBadge>
          <span>{formatDate(source.occurred_at)}</span>
          {source.url && (
            <Button
              variant="outline"
              size="sm"
              render={<a href={source.url} target="_blank" rel="noreferrer" />}
            >
              Open original
              <ArrowUpRight />
            </Button>
          )}
        </div>
        {quote && (
          <blockquote className="mt-5 border-l-2 border-border pl-3 text-sm leading-relaxed text-muted-foreground">
            <span className="muted-caption block">Cited excerpt</span>
            {quote}
          </blockquote>
        )}
        <pre className="source-text">
          {start >= 0 ? (
            <>
              {body.slice(0, start)}
              <mark
                ref={scrollToMark}
                className="bg-warning/20 text-foreground rounded-sm px-0.5"
              >
                {quote}
              </mark>
              {body.slice(start + quote.length)}
            </>
          ) : (
            body ||
            'Only metadata is available. Connect this source to retrieve the available text.'
          )}
        </pre>
      </div>
    </Modal>
  );
}
export function ActivityDialog({ trace, close }) {
  return (
    <Modal
      title="Agent activity"
      description="The sources and actions behind this review."
      onClose={close}
    >
      <div className="activity-prompt">{trace.job.prompt}</div>
      <div className="activity-timeline">
        {trace.events.map((event) => (
          <div key={event.id}>
            <span className="timeline-dot" />
            <div>
              <p>{event.label}</p>
              <time>{new Date(event.created_at).toLocaleTimeString()}</time>
            </div>
          </div>
        ))}
      </div>
      <p className="dialog-note">This log shows tool activity and status.</p>
    </Modal>
  );
}
export function HistoryDialog({ events, close }) {
  return (
    <Modal
      title="Decision history"
      description="How this commitment changed over time."
      onClose={close}
    >
      <div className="activity-timeline">
        {events.map((event) => {
          const before = event.before_json
              ? JSON.parse(event.before_json)
              : null,
            after = JSON.parse(event.after_json);
          return (
            <div key={event.id}>
              <Clock3 size={16} />
              <div>
                <p>
                  <strong>{event.action}</strong> ·{' '}
                  {formatDate(event.created_at)}
                </p>
                <p>
                  {before
                    ? `${statusNames[before.status]} → ${statusNames[after.status]}`
                    : 'Created as ' + statusNames[after.status]}
                </p>
                {before && before.checkpoint !== after.checkpoint && (
                  <p>
                    Checkpoint: {formatDate(before.checkpoint)} →{' '}
                    {formatDate(after.checkpoint)}
                  </p>
                )}
                {event.reason && <small>{event.reason}</small>}
              </div>
            </div>
          );
        })}
        {events.length === 0 && (
          <p className="dialog-note">No changes recorded yet.</p>
        )}
      </div>
    </Modal>
  );
}
export function ConnectionDialog({
  provider,
  state,
  close,
  busy,
  error,
  save,
  reconnect,
}) {
  const [key, setKey] = useState(''),
    [query, setQuery] = useState(state.connections.gmail.query);
  const gmail = provider === 'gmail';
  return (
    <Modal
      title={gmail ? 'Gmail settings' : `Connect ${providerNames[provider]}`}
      description={
        gmail
          ? 'Your inbox, with read-only access.'
          : 'Keep your meeting context up to date.'
      }
      onClose={close}
    >
      <form
        className="connection-form"
        onSubmit={(event) => {
          event.preventDefault();
          save(gmail ? { gmail_query: query } : { [provider + '_key']: key });
        }}
      >
        {gmail ? (
          <>
            <div className="connected-account">
              <ProviderIcon provider="gmail" />
              <div>
                <strong>{state.user?.email}</strong>
                <span>Use the same account as this workspace.</span>
              </div>
              <LockKeyhole size={17} />
            </div>
            <FormField
              label="Which emails should Focus read?"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              description="Use Gmail search syntax. The default includes all mail except spam and trash."
            />
            <div className="reconnect-row">
              <div>
                <strong>Need to renew access?</strong>
                <p>Reconnect if access expired or was not granted.</p>
              </div>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => reconnect(query)}
              >
                <RefreshCw />
                Reconnect
              </Button>
            </div>
          </>
        ) : (
          <>
            <p>
              {provider === 'fireflies'
                ? 'Create an API key in your Fireflies settings. Imports use the participant email configured for your workspace.'
                : 'Use a Granola Personal API key from Settings → Connectors → API keys. Availability depends on your workspace plan.'}
            </p>
            <FormField
              label="API key"
              type="password"
              required
              autoComplete="off"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="Paste your API key"
            />
            <p className="dialog-note">
              <LockKeyhole size={14} />
              Stored privately on the server. Excluded from exports.
            </p>
          </>
        )}
        {error && <Notice error>{error}</Notice>}
        <div className="dialog-actions">
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            {gmail ? 'Save changes' : 'Save connection'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
