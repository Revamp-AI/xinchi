'use client';

import { useState } from 'react';
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
          <FormField label="Your decision">
            <Choice
              value={item.status || 'candidate'}
              onChange={(value) => update('status', value)}
              options={statusNames}
              label="Your decision"
            />
          </FormField>
        </div>
        <FormField
          label="Done means"
          multiline
          rows={2}
          value={item.done_when || ''}
          onChange={(event) => update('done_when', event.target.value)}
          placeholder="What will exist when this is finished?"
        />
        <FormField
          label="Next concrete action"
          value={item.next_action || ''}
          onChange={(event) => update('next_action', event.target.value)}
          placeholder="The next step you can actually take"
        />
        <div className="form-pair">
          <FormField
            label="Owner"
            value={item.owner || ''}
            onChange={(event) => update('owner', event.target.value)}
          />
          <FormField
            label="Delivery or review checkpoint"
            type="date"
            value={item.checkpoint || ''}
            onChange={(event) => update('checkpoint', event.target.value)}
          />
        </div>
        <div className="form-pair">
          <FormField
            label="Hard external deadline"
            description="Only add a date that is confirmed."
            type="date"
            value={item.hard_deadline || ''}
            onChange={(event) => update('hard_deadline', event.target.value)}
          />
          <FormField
            label="Waiting for / dependency"
            value={item.dependency || ''}
            onChange={(event) => update('dependency', event.target.value)}
            placeholder="Who or what needs to move first?"
          />
        </div>
        <FormField
          label={
            item.status === 'done'
              ? 'Completion evidence'
              : 'Finished output or evidence'
          }
          multiline
          rows={2}
          value={item.evidence || ''}
          onChange={(event) => update('evidence', event.target.value)}
          placeholder="A link or description of the completed output"
        />
        <FormField
          label="Why this decision or change?"
          multiline
          rows={2}
          value={item.reason || ''}
          onChange={(event) => update('reason', event.target.value)}
        />
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
              onClick={() => openSource(item.source_id)}
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
        <pre className="source-text">
          {source.body ||
            'Only metadata is available. Connect this source to retrieve the available text.'}
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
              Stored privately on this Mac. Excluded from exports.
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
