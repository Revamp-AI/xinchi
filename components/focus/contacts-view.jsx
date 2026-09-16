'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  CircleHelp,
  Clock3,
  List,
  Map,
  Merge,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Upload,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  Choice,
  FormField,
  Heading,
  Modal,
  Notice,
  StatusBadge,
  formatDate,
} from './shared';
import { SEGMENTS } from '../../lib/relationship-rules.mjs';
import { ReviewSelection, BulkMergeReview } from './contact-bulk-review';

const descriptions = {
  New: 'A new connection, still taking shape',
  Active: 'An exchange within your chosen cadence',
  Cooling: 'Past the cadence you chose',
  Dormant: 'More than three cadence periods',
  Paused: 'Space you deliberately made',
  Unclassified: 'More verified activity or history is needed',
};
const tone = {
  New: 'info',
  Active: 'success',
  Cooling: 'warning',
  Dormant: 'neutral',
  Paused: 'neutral',
  Unclassified: 'neutral',
};
const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toUpperCase();
const localDateTime = () => {
  const d = new Date();
  return new Date(+d - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
function Toggle({ label, checked, onChange }) {
  return (
    <Field className="contact-toggle">
      <FieldLabel>
        <Checkbox checked={!!checked} onCheckedChange={onChange} />
        {label}
      </FieldLabel>
    </Field>
  );
}
function ContactForm({ value, busy, onSave, onCancel }) {
  const [form, setForm] = useState({
    tracked: true,
    cadence_days: 30,
    tags: [],
    ...value,
    organization: '',
  });
  const update = (key, v) => setForm((f) => ({ ...f, [key]: v }));
  const field = (key, label, props = {}) => (
    <FormField
      label={label}
      value={form[key] || ''}
      onChange={(e) => update(key, e.target.value)}
      {...props}
    />
  );
  return (
    <form
      className="contact-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(form);
      }}
    >
      <div className="contact-form-grid">
        {field('name', 'Name', { required: true })}
        {field('email', 'Email', { type: 'email' })}
        {field('role', 'Role')}
        {field('organization', 'Add organization', {
          description: 'Previous affiliations stay on the profile.',
        })}
        {field('started_on', 'Affiliation started', { type: 'date' })}
        {field('ended_on', 'Affiliation ended', { type: 'date' })}
      </div>
      <FormField
        label="Purpose tags"
        value={form.tags.join(', ')}
        onChange={(e) =>
          update(
            'tags',
            e.target.value.split(',').map((t) => t.trim()),
          )
        }
        placeholder="Partner, Investor, Peer…"
      />
      {field('notes', 'Private notes', { multiline: true, rows: 4 })}
      <div className="contact-policy">
        <Toggle
          label="Track for follow-ups"
          checked={form.tracked}
          onChange={(v) => update('tracked', v)}
        />
        <FormField
          label="Preferred cadence (days)"
          type="number"
          min="1"
          max="3650"
          value={form.cadence_days}
          onChange={(e) => update('cadence_days', e.target.value)}
        />
        <Toggle
          label="Pause relationship reminders"
          checked={form.paused}
          onChange={(v) => update('paused', v)}
        />
        {field('snoozed_until', 'Snooze until', { type: 'date' })}
        <Toggle
          label="Do not contact"
          checked={form.do_not_contact}
          onChange={(v) => update('do_not_contact', v)}
        />
      </div>
      <p className="contact-hint">
        Relationship classification uses verified activity automatically.
        Identity confirmation and follow-up tracking are separate preferences.
      </p>
      <div className="contact-actions">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy} type="submit">
          Save contact
        </Button>
      </div>
    </form>
  );
}
function InteractionForm({ contact, busy, onSave, onCancel }) {
  const [form, setForm] = useState({
    contact_id: contact.id,
    kind: 'meeting',
    direction: 'mutual',
    occurred_at: localDateTime(),
    meaningful: true,
    body: '',
  });
  return (
    <form
      className="contact-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          ...form,
          occurred_at: new Date(form.occurred_at).toISOString(),
        });
      }}
    >
      <div className="contact-form-grid">
        <Choice
          label="Interaction type"
          value={form.kind}
          options={{
            meeting: 'Meeting',
            email: 'Email',
            note: 'Conversation or note',
          }}
          onChange={(kind) => setForm({ ...form, kind })}
        />
        <Choice
          label="Direction"
          value={form.direction}
          options={{
            mutual: 'We spoke',
            inbound: 'They replied',
            outbound: 'I reached out',
          }}
          onChange={(direction) => setForm({ ...form, direction })}
        />
      </div>
      <FormField
        label="When it happened"
        type="datetime-local"
        required
        value={form.occurred_at}
        onChange={(e) => setForm({ ...form, occurred_at: e.target.value })}
      />
      <FormField
        label="What happened?"
        multiline
        rows={5}
        required
        value={form.body}
        onChange={(e) => setForm({ ...form, body: e.target.value })}
      />
      <Toggle
        label="Count as a meaningful exchange"
        checked={form.meaningful}
        onChange={(meaningful) => setForm({ ...form, meaningful })}
      />
      <p className="contact-hint">
        Outbound outreach appears in the timeline. A reply or conversation
        renews activity.
      </p>
      <div className="contact-actions">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy} type="submit">
          Save interaction
        </Button>
      </div>
    </form>
  );
}
function DraftForm({
  contact,
  value = {},
  busy,
  onSave,
  onCancel,
  openSource,
}) {
  const [form, setForm] = useState({
    contact_id: contact.id,
    subject: '',
    body: '',
    ...value,
  });
  const [copied, setCopied] = useState(false);
  return (
    <form
      className="contact-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(form);
      }}
    >
      <p className="contact-hint">
        A private draft for {contact.name}. Saving keeps it inside Focus.
      </p>
      <FormField
        label="Subject"
        value={form.subject}
        onChange={(e) => setForm({ ...form, subject: e.target.value })}
      />
      <FormField
        label="Message"
        required
        multiline
        rows={10}
        value={form.body}
        onChange={(e) => setForm({ ...form, body: e.target.value })}
      />
      {value.citations?.map((c, i) => (
        <Button
          type="button"
          variant="ghost"
          key={i}
          onClick={() => openSource(c.source_id, c.quote, c.source_version_id)}
        >
          View supporting source <ArrowUpRight />
        </Button>
      ))}
      <div className="contact-actions">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                [form.subject, form.body].filter(Boolean).join('\n\n'),
              );
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy text'}
        </Button>
        <Button type="submit" disabled={busy}>
          Save draft
        </Button>
      </div>
    </form>
  );
}
export default function ContactsView({
  api,
  openSource,
  onReview,
  onCommitment,
  items,
}) {
  const [data, setData] = useState(null),
    [status, setStatus] = useState(null),
    [q, setQ] = useState(''),
    [segment, setSegment] = useState(''),
    [tag, setTag] = useState(''),
    [archived, setArchived] = useState(false),
    [offset, setOffset] = useState(0),
    [mode, setMode] = useState('map');
  const [modal, setModal] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [linkId, setLinkId] = useState(''),
    [mergeId, setMergeId] = useState(''),
    [aliases, setAliases] = useState('');
  const [selectedReviews, setSelectedReviews] = useState([]);
  const [selectedRecordings, setSelectedRecordings] = useState([]);
  const [bulkProgress, setBulkProgress] = useState('');
  const csvInput = useRef(null);
  const query = new URLSearchParams({
    q,
    segment,
    tag,
    archived: String(archived),
    offset: String(offset),
  }).toString();
  const load = useCallback(async () => {
    const [contacts, progress] = await Promise.all([
      api('contacts?' + query),
      api('contacts/status'),
    ]);
    setData(contacts);
    setStatus(progress);
  }, [api, query]);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      Promise.all([api('contacts?' + query), api('contacts/status')])
        .then(([contacts, progress]) => {
          if (active) {
            setData(contacts);
            setStatus(progress);
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, query]);
  const running =
    status?.auto_match?.running ||
    status?.runs.some((r) => ['queued', 'running'].includes(r.state));
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(
      () => load().catch((e) => setError(e.message)),
      3000,
    );
    return () => clearInterval(timer);
  }, [running, load]);
  const open = async (id) => {
    setError('');
    setLinkId('');
    setMergeId('');
    try {
      setModal({ type: 'detail', contact: await api('contacts/' + id) });
    } catch (e) {
      setError(e.message);
    }
  };
  const mutate = async (path, input, next) => {
    setBusy(true);
    setError('');
    try {
      const result = await api(path, input);
      await load();
      if (next) await next(result);
      return result;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const previewMerge = async (target, source) => {
    setError('');
    try {
      setModal({
        type: 'merge',
        preview: await api(
          'contacts/merge-preview?' +
            new URLSearchParams({ target_id: target, source_id: source }),
        ),
      });
    } catch (e) {
      setError(e.message);
    }
  };
  const toggleSelection = (setter, id, checked) =>
    setter((ids) =>
      checked
        ? [...new Set([...ids, id])]
        : ids.filter((value) => value !== id),
    );
  const previewBulkMerge = async () => {
    setBusy(true);
    setError('');
    try {
      const preview = await api('contacts/bulk-merge-preview', {
        ids: reviews
          .filter((r) => selectedReviews.includes(r.id))
          .map((r) => r.id),
      });
      setModal({ type: 'bulk-merge', preview });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const runBulkMerge = async (groups) => {
    setBusy(true);
    setError('');
    setNotice('');
    let merged = 0,
      completed = [];
    const failures = [];
    for (const [index, group] of groups.entries()) {
      setBulkProgress(`Merging group ${index + 1} of ${groups.length}…`);
      try {
        const result = await api('contacts/bulk-merge', group);
        merged += result.merged;
        completed.push(...group.review_ids);
      } catch (e) {
        failures.push(`${group.label || `Group ${index + 1}`}: ${e.message}`);
      }
    }
    setSelectedReviews((ids) => ids.filter((id) => !completed.includes(id)));
    setModal(null);
    setBulkProgress('');
    setNotice(
      `${merged} ${merged === 1 ? 'profile' : 'profiles'} merged. Each completed group is available in Recent merges.`,
    );
    try {
      await load();
    } catch (e) {
      failures.push(`Could not refresh the list: ${e.message}`);
    }
    if (failures.length)
      setError(
        `Some results could not be confirmed. Refresh or preview the remaining matches. ${failures.join(' ')}`,
      );
    setBusy(false);
  };
  const separateSelected = async () => {
    const ids = reviews
      .filter((r) => selectedReviews.includes(r.id))
      .map((r) => r.id);
    await mutate('contacts/bulk-separate', { ids }, (result) => {
      setSelectedReviews([]);
      setNotice(
        `${result.completed.length} ${result.completed.length === 1 ? 'match' : 'matches'} marked as different people.${result.skipped.length ? ` ${result.skipped.length} already changed and were skipped.` : ''}`,
      );
    });
  };
  const reviewSelectedRecordings = async (action) => {
    const selected = duplicates.filter((d) =>
        selectedRecordings.includes(d.id),
      ),
      completed = [],
      failures = [];
    setBusy(true);
    setError('');
    for (const [index, d] of selected.entries()) {
      setBulkProgress(
        `Reviewing recording ${index + 1} of ${selected.length}…`,
      );
      try {
        await api('contacts/interaction-review', {
          id: d.id,
          version: d.version,
          action,
        });
        completed.push(d.id);
      } catch (e) {
        failures.push(`${d.title}: ${e.message}`);
      }
    }
    setSelectedRecordings((ids) => ids.filter((id) => !completed.includes(id)));
    setBulkProgress('');
    setNotice(
      `${completed.length} recording ${completed.length === 1 ? 'match' : 'matches'} marked as ${action === 'duplicate' ? 'the same meeting' : 'separate meetings'}.`,
    );
    try {
      await load();
    } catch (e) {
      failures.push(`Could not refresh the list: ${e.message}`);
    }
    if (failures.length)
      setError(
        `Some decisions could not be confirmed. Refresh before retrying. ${failures.join(' ')}`,
      );
    setBusy(false);
  };
  const filter = (value) => {
    setSegment(value);
    setOffset(0);
  };
  const records = data?.records || [],
    counts = data?.counts || {},
    reviews = status?.reviews || [],
    duplicates = status?.duplicates || [];
  const selectedReviewCount = reviews.filter((r) =>
    selectedReviews.includes(r.id),
  ).length;
  const selectedRecordingCount = duplicates.filter((d) =>
    selectedRecordings.includes(d.id),
  ).length;
  const due = records.filter((c) => c.promises_due > 0),
    tags = [...new Set(records.flatMap((c) => c.tags))].sort();
  const c = modal?.contact;
  return (
    <>
      <Heading
        eyebrow="YOUR PEOPLE, WITH CONTEXT"
        title="Your contacts"
        description="A clearer view of your relationships, and a thoughtful next step."
      >
        <Button
          variant="outline"
          className="me-2"
          onClick={() => setModal({ type: 'backfill' })}
        >
          <RefreshCw />
          Bring in contacts
        </Button>
        <Button onClick={() => setModal({ type: 'edit', contact: {} })}>
          <Plus />
          New contact
        </Button>
      </Heading>
      {error && !modal && (
        <Notice error onClose={() => setError('')}>
          {error}
        </Notice>
      )}
      {notice && <Notice onClose={() => setNotice('')}>{notice}</Notice>}
      <div className="contact-summary">
        <div>
          <Users />
          <strong>{data?.total ?? '—'}</strong>
          <span>people in view</span>
        </div>
        <div>
          <span className="contact-dot active" />
          <strong>{counts.Active || 0}</strong>
          <span>active relationships</span>
        </div>
        <button onClick={() => setMode('review')}>
          <Clock3 />
          <strong>{due.length}</strong>
          <span>with a checkpoint due</span>
        </button>
        <button onClick={() => setMode('review')}>
          <CircleHelp />
          <strong>
            {(status?.review_total ?? reviews.length) +
              (status?.duplicate_total ?? duplicates.length)}
          </strong>
          <span>matches to review</span>
        </button>
      </div>
      <Card className="contacts-workbench">
        <div className="contact-toolbar">
          <div className="contact-search">
            <Search size={16} />
            <Input
              aria-label="Search contacts"
              placeholder="Find a person, role, or organization"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setOffset(0);
              }}
            />
          </div>
          <div
            className="contact-view-switch"
            role="group"
            aria-label="Contact view"
          >
            {[
              ['map', Map, 'Map'],
              ['list', List, 'List'],
              ['review', Check, 'Review'],
            ].map(([id, Icon, label]) => (
              <Button
                key={id}
                variant={mode === id ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={mode === id}
                onClick={() => setMode(id)}
              >
                <Icon />
                {label}
              </Button>
            ))}
          </div>
        </div>
        <div className="contact-filters">
          <Choice
            label="Relationship segment"
            value={segment}
            onChange={filter}
            options={{
              '': 'All relationships',
              ...Object.fromEntries(SEGMENTS.map((s) => [s, s])),
            }}
          />
          <Choice
            label="Purpose tag"
            value={tag}
            onChange={(v) => {
              setTag(v);
              setOffset(0);
            }}
            options={{
              '': 'All purposes',
              ...Object.fromEntries(
                [...new Set([tag, ...tags])].filter(Boolean).map((t) => [t, t]),
              ),
            }}
          />
          <Button
            variant={archived ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={archived}
            onClick={() => {
              setArchived(!archived);
              setOffset(0);
            }}
          >
            {archived ? 'Showing archived' : 'Show archived'}
          </Button>
          {running && (
            <span className="contact-hint" role="status">
              Reading stored sources…
            </span>
          )}
        </div>
        {!data ? (
          <div className="contact-empty">Loading your relationships…</div>
        ) : mode === 'map' ? (
          <>
            <div
              className="relationship-map"
              aria-label="Relationship heat map"
            >
              {SEGMENTS.filter((s) => !segment || s === segment).map(
                (state) => {
                  const people = records.filter((c) => c.state === state);
                  return (
                    <section
                      key={state}
                      className={
                        'relationship-region region-' + state.toLowerCase()
                      }
                      aria-label={state + ' relationships'}
                    >
                      <div className="region-heading">
                        <button
                          onClick={() => {
                            filter(state);
                            setMode('list');
                          }}
                        >
                          <span className="contact-dot" />
                          <h2>{state}</h2>
                          <span>{counts[state] || 0}</span>
                        </button>
                        <p>{descriptions[state]}</p>
                      </div>
                      <div className="contact-orbit">
                        {people.slice(0, 15).map((person) => (
                          <button
                            key={person.id + person.state}
                            className={
                              'contact-node' +
                              (person.reconnected ? ' reconnected' : '')
                            }
                            onClick={() => open(person.id)}
                            aria-label={person.name + ', ' + state}
                            title={
                              person.name +
                              (person.organization
                                ? ' · ' + person.organization
                                : '')
                            }
                          >
                            <span className="contact-node-avatar">
                              {initials(person.name)}
                            </span>
                            <span className="contact-node-name">
                              {person.name.split(' ')[0]}
                            </span>
                            {person.promises_due > 0 && (
                              <span
                                className="contact-node-attention"
                                aria-label="Checkpoint due"
                              />
                            )}
                          </button>
                        ))}
                        {!people.length && (
                          <span className="region-empty">
                            {!counts[state]
                              ? 'No contacts here yet'
                              : 'More contacts on another page'}
                          </span>
                        )}
                        {(counts[state] || 0) > 15 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              filter(state);
                              setMode('list');
                            }}
                          >
                            View all {counts[state]}
                          </Button>
                        )}
                      </div>
                    </section>
                  );
                },
              )}
            </div>
            <div className="map-caption">
              <span>
                <span className="contact-dot attention" /> Commitment checkpoint
                due
              </span>
              <span>
                Cadence comes from each person’s preferences. Select someone to
                see the evidence.
              </span>
            </div>
          </>
        ) : mode === 'list' ? (
          <div className="contact-table-wrap">
            <table className="contact-table" aria-label="Contacts">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Relationship</th>
                  <th>Last exchange</th>
                  <th>Purpose</th>
                </tr>
              </thead>
              <tbody>
                {records.map((person) => (
                  <tr key={person.id}>
                    <td>
                      <button
                        className="contact-person-button"
                        onClick={() => open(person.id)}
                      >
                        <span className="contact-list-avatar">
                          {initials(person.name)}
                        </span>
                        <span>
                          <strong>{person.name}</strong>
                          <small>
                            {person.organization ||
                              person.email ||
                              person.role ||
                              'Add context'}
                          </small>
                        </span>
                      </button>
                    </td>
                    <td>
                      <StatusBadge tone={tone[person.state]}>
                        {person.state}
                      </StatusBadge>
                      {person.reconnected && (
                        <small className="contact-hint">Reconnected</small>
                      )}
                      {person.promises_due > 0 && (
                        <small className="contact-due">Checkpoint due</small>
                      )}
                    </td>
                    <td>
                      {person.basis?.last_meaningful_at
                        ? formatDate(person.basis.last_meaningful_at)
                        : 'Not established'}
                      <small className="contact-hint">
                        {person.cadence_days}-day cadence
                      </small>
                    </td>
                    <td>{person.tags.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!records.length && (
              <div className="contact-empty">
                <Users />
                <h2>No contacts in this view</h2>
                <p>
                  Add someone or bring in contacts from your stored
                  conversations.
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="contact-review-list">
            <h2>Automatic LinkedIn matching</h2>
            <p className="contact-hint">
              Match the same full name with the employer in your LinkedIn export
              and a verified company email domain. Ambiguous matches stay here
              for review. Automatic merges can be undone below.
            </p>
            <div
              className="contact-bulk-toolbar"
              role="group"
              aria-label="Automatic LinkedIn matching"
            >
              <label
                className="contact-bulk-select"
                htmlFor="contact-auto-match-enabled"
              >
                <Checkbox
                  id="contact-auto-match-enabled"
                  checked={status?.auto_match?.enabled !== false}
                  disabled={busy}
                  onCheckedChange={(enabled) =>
                    mutate('contacts/auto-match/settings', { enabled })
                  }
                />
                Match automatically
              </label>
              <Button
                variant="outline"
                disabled={
                  busy ||
                  status?.auto_match?.running ||
                  status?.auto_match?.enabled === false
                }
                onClick={() =>
                  mutate('contacts/auto-match', {}, (result) =>
                    setNotice(
                      result.skipped
                        ? 'Automatic matching is already running or paused.'
                        : `${result.merged} ${result.merged === 1 ? 'profile' : 'profiles'} matched automatically.${result.deferred ? ' More company checks will continue automatically.' : ''}`,
                    ),
                  )
                }
              >
                {status?.auto_match?.running
                  ? 'Checking matches…'
                  : 'Match now'}
              </Button>
              <span className="contact-hint" role="status">
                {status?.auto_match?.last_run
                  ? `${status.auto_match.total_merged || 0} matched automatically · last checked ${formatDate(status.auto_match.last_run)}`
                  : 'Checks new and existing contacts automatically.'}
              </span>
            </div>
            {status?.auto_match?.error && (
              <Notice error>{status.auto_match.error}</Notice>
            )}
            <h2>Commitments to revisit</h2>
            {due.length ? (
              due.map((person) => (
                <div className="contact-review-row" key={person.id}>
                  <div>
                    <strong>{person.name}</strong>
                    <p>
                      {person.promises_due} commitment checkpoint
                      {person.promises_due === 1 ? '' : 's'} due
                    </p>
                  </div>
                  <Button variant="outline" onClick={() => open(person.id)}>
                    Review
                  </Button>
                </div>
              ))
            ) : (
              <p className="contact-hint">
                No linked commitment checkpoints are due in this view.
              </p>
            )}
            <h2>Could these be the same person?</h2>
            <ReviewSelection
              label="Bulk identity review"
              total={status?.review_total ?? reviews.length}
              visible={reviews.length}
              selected={selectedReviewCount}
              busy={busy}
              onSelectAll={(checked) =>
                setSelectedReviews(checked ? reviews.map((r) => r.id) : [])
              }
            >
              <Button
                variant="outline"
                disabled={busy || !selectedReviewCount}
                onClick={previewBulkMerge}
              >
                Review selected merges
              </Button>
              <Button
                variant="ghost"
                disabled={busy || !selectedReviewCount}
                onClick={separateSelected}
              >
                Mark selected as different people
              </Button>
            </ReviewSelection>
            {reviews.length > 0 && (
              <p className="contact-hint">
                Showing {reviews.length} of{' '}
                {status?.review_total ?? reviews.length} pending matches. New
                matches appear after you finish this batch.
              </p>
            )}
            {!reviews.length && (
              <p className="contact-hint">No unresolved identity matches.</p>
            )}
            {reviews.map((r) => (
              <div className="contact-review-row" key={r.id}>
                <div className="contact-review-selection">
                  <Checkbox
                    aria-label={`Select match: ${r.left_name} and ${r.right_name}`}
                    disabled={busy}
                    checked={selectedReviews.includes(r.id)}
                    onCheckedChange={(checked) =>
                      toggleSelection(setSelectedReviews, r.id, checked)
                    }
                  />
                  <div>
                    <strong>
                      {r.left_name} ↔ {r.right_name}
                    </strong>
                    <p>{r.reason}</p>
                    <small>
                      {r.left_email} · {r.right_email}
                    </small>
                  </div>
                </div>
                <div className="contact-inline-actions">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => previewMerge(r.left_id, r.right_id)}
                  >
                    Compare
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => mutate('contacts/separate', { id: r.id })}
                  >
                    Different people
                  </Button>
                </div>
              </div>
            ))}
            <h2>Possible duplicate recordings</h2>
            <ReviewSelection
              label="Bulk recording review"
              total={status?.duplicate_total ?? duplicates.length}
              visible={duplicates.length}
              selected={selectedRecordingCount}
              busy={busy}
              onSelectAll={(checked) =>
                setSelectedRecordings(
                  checked ? duplicates.map((d) => d.id) : [],
                )
              }
            >
              <Button
                variant="outline"
                disabled={busy || !selectedRecordingCount}
                onClick={() => reviewSelectedRecordings('duplicate')}
              >
                Mark selected as same meeting
              </Button>
              <Button
                variant="ghost"
                disabled={busy || !selectedRecordingCount}
                onClick={() => reviewSelectedRecordings('separate')}
              >
                Mark selected as separate meetings
              </Button>
            </ReviewSelection>
            {bulkProgress && modal?.type !== 'bulk-merge' && (
              <p role="status">{bulkProgress}</p>
            )}
            {!duplicates.length && (
              <p className="contact-hint">
                No duplicate recordings need a decision.
              </p>
            )}
            {duplicates.map((d) => (
              <div className="contact-review-row" key={d.id}>
                <div className="contact-review-selection">
                  <Checkbox
                    aria-label={`Select recording: ${d.title}`}
                    disabled={busy}
                    checked={selectedRecordings.includes(d.id)}
                    onCheckedChange={(checked) =>
                      toggleSelection(setSelectedRecordings, d.id, checked)
                    }
                  />
                  <div>
                    <strong>{d.title}</strong>
                    <p>
                      {formatDate(d.occurred_at)} · {d.source_id.split(':')[0]}{' '}
                      and {d.other_source_id.split(':')[0]}
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openSource(d.source_id)}
                    >
                      First source
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openSource(d.other_source_id)}
                    >
                      Other source
                    </Button>
                  </div>
                </div>
                <div className="contact-inline-actions">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      mutate('contacts/interaction-review', {
                        id: d.id,
                        version: d.version,
                        action: 'duplicate',
                      })
                    }
                  >
                    Same meeting
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      mutate('contacts/interaction-review', {
                        id: d.id,
                        version: d.version,
                        action: 'separate',
                      })
                    }
                  >
                    Separate meetings
                  </Button>
                </div>
              </div>
            ))}
            <h2>Recent merges</h2>
            {!status?.decisions.length && (
              <p className="contact-hint">
                Identity decisions will appear here.
              </p>
            )}
            {status?.decisions.map((d) => (
              <div className="contact-review-row" key={d.id}>
                <div>
                  <strong>
                    {d.merged_count > 1
                      ? `${d.merged_count} profiles`
                      : d.right_name}{' '}
                    → {d.left_name}
                  </strong>
                  <p>Merged {formatDate(d.created_at)}</p>
                  {d.automatic_match && (
                    <p className="contact-hint">
                      Automatically matched: same name,{' '}
                      {d.automatic_match.company}, and{' '}
                      {d.automatic_match.domain}.{' '}
                      <a
                        href={d.automatic_match.profile_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        LinkedIn evidence
                      </a>
                      {' · '}
                      <a
                        href={d.automatic_match.website.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Company website
                      </a>
                    </p>
                  )}
                  {d.merged_count > 1 && (
                    <small>Undo restores the whole group.</small>
                  )}
                </div>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    mutate('contacts/undo-merge', { id: d.id }, () =>
                      setNotice(
                        'Merge undone. The original profiles were restored.',
                      ),
                    )
                  }
                >
                  Undo merge
                </Button>
              </div>
            ))}
          </div>
        )}
        {mode !== 'review' && data?.total > 500 && (
          <div className="contact-pagination">
            <span>
              Showing {offset + 1}–{Math.min(offset + 500, data.total)} of{' '}
              {data.total}
            </span>
            <Button
              variant="outline"
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 500))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={offset + 500 >= data.total}
              onClick={() => setOffset(offset + 500)}
            >
              Next
            </Button>
          </div>
        )}
      </Card>
      <div className="contact-footer">
        <span>Private notes. Real exchanges. Room for quieter seasons.</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setModal({ type: 'backfill' })}
        >
          Data & coverage <ArrowUpRight />
        </Button>
      </div>
      {modal && (
        <Modal
          wide={['detail', 'edit', 'bulk-merge'].includes(modal.type)}
          title={
            modal.type === 'detail'
              ? c.name
              : modal.type === 'edit'
                ? c.id
                  ? 'Edit contact'
                  : 'New contact'
                : modal.type === 'log'
                  ? 'Log an interaction'
                  : modal.type === 'draft'
                    ? 'Message draft'
                    : modal.type === 'bulk-merge'
                      ? 'Review selected merges'
                      : modal.type === 'merge'
                        ? 'Review this merge'
                        : modal.type === 'affiliation'
                          ? 'Edit affiliation'
                          : 'Bring your people into Focus'
          }
          description={
            modal.type === 'detail'
              ? [c.role, c.email].filter(Boolean).join(' · ')
              : undefined
          }
          onClose={() => {
            if (busy && modal.type === 'bulk-merge') return;
            setModal(null);
            setError('');
          }}
        >
          {error && <Notice error>{error}</Notice>}
          {modal.type === 'bulk-merge' && (
            <BulkMergeReview
              preview={modal.preview}
              busy={busy}
              progress={bulkProgress}
              onMerge={runBulkMerge}
              onCancel={() => setModal(null)}
            />
          )}
          {modal.type === 'edit' && (
            <ContactForm
              value={c}
              busy={busy}
              onCancel={() => (c.id ? open(c.id) : setModal(null))}
              onSave={(input) =>
                mutate('contacts', input, (row) => open(row.id))
              }
            />
          )}
          {modal.type === 'log' && (
            <InteractionForm
              contact={c}
              busy={busy}
              onCancel={() => open(c.id)}
              onSave={(input) =>
                mutate('contacts/interaction', input, () => open(c.id))
              }
            />
          )}
          {modal.type === 'draft' && (
            <DraftForm
              contact={c}
              value={modal.draft}
              busy={busy}
              openSource={openSource}
              onCancel={() => open(c.id)}
              onSave={(input) =>
                mutate('contacts/draft', input, () => open(c.id))
              }
            />
          )}
          {modal.type === 'detail' && (
            <div className="contact-detail">
              <div className="contact-profile-actions">
                <StatusBadge tone={tone[c.relationship?.state]}>
                  {c.relationship?.state || 'Unclassified'}
                </StatusBadge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setModal({ type: 'edit', contact: c })}
                >
                  Edit profile
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setModal({ type: 'log', contact: c })}
                >
                  <Plus />
                  Log interaction
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    mutate('contacts', { ...c, archived: !c.archived }, () =>
                      open(c.id),
                    )
                  }
                >
                  {c.archived ? 'Restore' : 'Archive'}
                </Button>
              </div>
              {!c.confirmed && (
                <Notice>
                  <div className="contact-confirm">
                    This identity was found in your sources. Classification
                    already uses its verified activity. You can confirm the
                    identity separately. Clear employer matches can merge
                    automatically; uncertain matches stay in Review.
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        mutate('contacts', { ...c, confirmed: true }, () =>
                          open(c.id),
                        )
                      }
                    >
                      Confirm contact
                    </Button>
                  </div>
                </Notice>
              )}
              {c.identities.some(
                (i) => i.provider === 'apple' && i.address,
              ) && (
                <section>
                  <h3>Apple contact details</h3>
                  {[
                    ...new Set(
                      c.identities
                        .filter((i) => i.provider === 'apple' && i.address)
                        .map((i) => i.address),
                    ),
                  ].map((address) => (
                    <p key={address}>{address}</p>
                  ))}
                </section>
              )}
              <div className="relationship-explanation">
                <h3>Why this state?</h3>
                <p>{c.relationship?.basis.reason}</p>
                <small>
                  {c.relationship?.basis.coverage.reason} Preferred cadence:{' '}
                  {c.cadence_days} days.
                </small>
                {!c.relationship?.basis.coverage.fresh && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      mutate('contacts/coverage', { id: c.id }, () =>
                        open(c.id),
                      )
                    }
                  >
                    I have checked: this timeline is complete through today
                  </Button>
                )}
              </div>
              {!!c.tags.length && (
                <div className="contact-tags">
                  {c.tags.map((t) => (
                    <StatusBadge key={t}>{t}</StatusBadge>
                  ))}
                </div>
              )}
              {c.affiliations.length > 0 && (
                <section>
                  <h3>Organizations</h3>
                  {c.affiliations.map((a) => (
                    <div className="contact-review-row" key={a.id}>
                      <div>
                        <strong>{a.organization}</strong>
                        <p>
                          {a.role} · {a.started_on || 'Start unknown'} →{' '}
                          {a.ended_on || 'Present'}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setModal({
                            type: 'affiliation',
                            contact: c,
                            affiliation: a,
                          })
                        }
                      >
                        Edit dates
                      </Button>
                    </div>
                  ))}
                </section>
              )}
              {c.notes && (
                <section>
                  <h3>Private notes</h3>
                  <p className="contact-note">{c.notes}</p>
                </section>
              )}
              <section>
                <div className="contact-section-title">
                  <h3>Commitments</h3>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      onCommitment({
                        title: '',
                        status: 'candidate',
                        kind: 'action',
                        contact_ids: [c.id],
                        owner: 'You',
                      })
                    }
                  >
                    <Plus />
                    New outcome
                  </Button>
                </div>
                {c.items.length ? (
                  c.items.map((item) => (
                    <div className="contact-review-row" key={item.id}>
                      <div>
                        <button
                          className="contact-text-button"
                          onClick={() => onCommitment(item)}
                        >
                          {item.title}
                        </button>
                        <p>
                          {item.status} ·{' '}
                          {item.checkpoint
                            ? formatDate(item.checkpoint)
                            : 'No checkpoint'}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          mutate(
                            'contacts/link',
                            {
                              item_id: item.id,
                              contact_id: c.id,
                              remove: true,
                            },
                            () => open(c.id),
                          )
                        }
                      >
                        Unlink
                      </Button>
                    </div>
                  ))
                ) : (
                  <p className="contact-hint">No linked commitments yet.</p>
                )}
                {items.length > 0 && (
                  <div className="contact-inline-actions">
                    <Choice
                      label="Commitment to link"
                      value={linkId}
                      onChange={setLinkId}
                      options={{
                        '': 'Choose an existing commitment',
                        ...Object.fromEntries(
                          items
                            .filter((i) => !c.items.some((x) => x.id === i.id))
                            .map((i) => [i.id, i.title]),
                        ),
                      }}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!linkId || busy}
                      onClick={() =>
                        mutate(
                          'contacts/link',
                          { contact_id: c.id, item_id: linkId },
                          () => open(c.id),
                        )
                      }
                    >
                      Link
                    </Button>
                  </div>
                )}
              </section>
              <section>
                <div className="contact-section-title">
                  <h3>Conversation timeline</h3>
                  <span className="contact-hint">
                    {c.interactions.length} recorded interactions
                  </span>
                </div>
                {!c.interactions.length && (
                  <p className="contact-hint">
                    Log a conversation or extract contacts from stored sources.
                  </p>
                )}
                <div className="contact-timeline">
                  {c.interactions.map((i) => (
                    <article key={i.id}>
                      <span className="timeline-mark">
                        <MessageSquare size={14} />
                      </span>
                      <div>
                        <small>
                          {i.occurred_at
                            ? new Date(i.occurred_at).toLocaleDateString()
                            : 'Date unknown'}{' '}
                          · {i.kind} · {i.direction}
                        </small>
                        <h4>{i.title}</h4>
                        {(i.exclusion || i.duplicate_status) && (
                          <p className="contact-hint">
                            {i.exclusion || 'Duplicate ' + i.duplicate_status}
                          </p>
                        )}
                        {i.citations.slice(-1).map((citation) => (
                          <div key={citation.source_version_id}>
                            <blockquote>
                              {citation.quote.slice(0, 280)}
                              {citation.quote.length > 280 ? '…' : ''}
                            </blockquote>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                openSource(
                                  citation.source_id,
                                  citation.quote,
                                  citation.source_version_id,
                                )
                              }
                            >
                              Read source <ArrowUpRight />
                            </Button>
                          </div>
                        ))}
                        {!i.duplicate_of && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              mutate(
                                'contacts/interaction-review',
                                {
                                  id: i.id,
                                  version: i.version,
                                  action:
                                    i.qualified && !i.exclusion
                                      ? 'exclude'
                                      : 'include',
                                },
                                () => open(c.id),
                              )
                            }
                          >
                            {i.qualified && !i.exclusion
                              ? 'Exclude from relationship state'
                              : 'Confirm meaningful interaction'}
                          </Button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
              <section>
                <div className="contact-section-title">
                  <h3>Private drafts</h3>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={c.do_not_contact || c.archived}
                    onClick={() => setModal({ type: 'draft', contact: c })}
                  >
                    <Plus />
                    Write draft
                  </Button>
                </div>
                {c.drafts.map((d) => (
                  <button
                    className="contact-draft-row"
                    key={d.id}
                    onClick={() =>
                      setModal({ type: 'draft', contact: c, draft: d })
                    }
                  >
                    <strong>{d.subject || 'Untitled message'}</strong>
                    <span>{d.body.slice(0, 140)}</span>
                  </button>
                ))}
                <div className="contact-inline-actions">
                  <Button
                    variant="outline"
                    disabled={
                      c.do_not_contact || c.paused || c.archived || busy
                    }
                    onClick={() =>
                      onReview(
                        `Review my relationship with ${c.name} (contact ID ${c.id}). Read their profile, timeline, coverage and sources. Suggest a small cited next step only if warranted; link any proposal to this contact.`,
                      )
                    }
                  >
                    Ask Focus to review
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={
                      c.do_not_contact || c.paused || c.archived || busy
                    }
                    onClick={() =>
                      onReview(
                        `Draft a thoughtful follow-up message for ${c.name} (contact ID ${c.id}) using read_contact and recent verified sources. Respect relationship preferences. Keep the draft inside Focus; do not send it.`,
                      )
                    }
                  >
                    Ask Focus for a draft
                  </Button>
                </div>
              </section>
              <details className="contact-provenance">
                <summary>Identity bindings and relationship history</summary>
                {c.identities.map((i) => (
                  <p key={i.id}>
                    {i.provider} · {i.display_name || i.address}
                    {i.address && i.display_name !== i.address
                      ? ' · ' + i.address
                      : ''}{' '}
                    {i.address || i.profile_url
                      ? ''
                      : '· identity needs review'}
                    {i.provider === 'linkedin' && (
                      <>
                        {i.profile_url && (
                          <a
                            href={i.profile_url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            LinkedIn profile{' '}
                            <ArrowUpRight className="inline size-3" />
                          </a>
                        )}
                        {i.connected_on && (
                          <small>
                            Connected on LinkedIn {formatDate(i.connected_on)} ·
                            connection date only
                          </small>
                        )}
                        {i.source_id && (
                          <Button
                            variant="link"
                            size="sm"
                            onClick={() =>
                              openSource(i.source_id, '', i.source_version_id)
                            }
                          >
                            View imported connection
                          </Button>
                        )}
                      </>
                    )}
                    {i.provider === 'apple' &&
                      i.source_id &&
                      !i.external_key.includes(':email:') &&
                      !i.external_key.includes(':phone:') && (
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() =>
                            openSource(i.source_id, '', i.source_version_id)
                          }
                        >
                          View imported contact
                        </Button>
                      )}
                  </p>
                ))}
                {c.history.map((h) => (
                  <p key={h.id}>
                    {formatDate(h.changed_at)} ·{' '}
                    {h.from_state || 'First evaluation'} → {h.to_state}
                    <small>{h.reason}</small>
                  </p>
                ))}
                <div className="contact-inline-actions">
                  <Choice
                    label="Merge with another contact"
                    value={mergeId}
                    onChange={setMergeId}
                    options={{
                      '': 'Choose another profile',
                      ...Object.fromEntries(
                        records
                          .filter((r) => r.id !== c.id)
                          .map((r) => [
                            r.id,
                            r.name + (r.email ? ' · ' + r.email : ''),
                          ]),
                      ),
                    }}
                  />
                  <Button
                    variant="outline"
                    disabled={!mergeId}
                    onClick={() => previewMerge(c.id, mergeId)}
                  >
                    <Merge />
                    Preview merge
                  </Button>
                </div>
              </details>
            </div>
          )}
          {modal.type === 'merge' && (
            <div className="contact-form">
              <p>{modal.preview.note}</p>
              <div className="contact-merge-pair">
                {[modal.preview.target, modal.preview.source].map((p, i) => (
                  <Card key={p.id}>
                    <small>
                      {i === 0 ? 'Keep this profile' : 'Move records from'}
                    </small>
                    <h3>{p.name}</h3>
                    <p>{p.email || 'No email'}</p>
                    <p>{p.role}</p>
                    <p>{p.notes || 'No private notes'}</p>
                  </Card>
                ))}
              </div>
              <dl className="contact-merge-counts">
                {Object.entries(modal.preview.counts).map(([key, n]) => (
                  <div key={key}>
                    <dt>{key.replaceAll('_', ' ')}</dt>
                    <dd>{n}</dd>
                  </div>
                ))}
              </dl>
              <p className="contact-hint">
                The source profile remains archived. You can undo this merge
                from Review while the affected records are unchanged.
              </p>
              <div className="contact-actions">
                <Button variant="outline" onClick={() => setModal(null)}>
                  Cancel
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    mutate(
                      'contacts/merge',
                      {
                        target_id: modal.preview.target.id,
                        source_id: modal.preview.source.id,
                        token: modal.preview.token,
                      },
                      (r) => open(r.contact_id),
                    )
                  }
                >
                  Merge contacts
                </Button>
              </div>
            </div>
          )}
          {modal.type === 'affiliation' && (
            <form
              className="contact-form"
              onSubmit={(e) => {
                e.preventDefault();
                mutate(
                  'contacts/affiliation',
                  { ...modal.affiliation, contact_version: c.version },
                  () => open(c.id),
                );
              }}
            >
              <h3>{modal.affiliation.organization}</h3>
              {[
                ['role', 'Role', 'text'],
                ['started_on', 'Started', 'date'],
                ['ended_on', 'Ended', 'date'],
              ].map(([key, label, type]) => (
                <FormField
                  key={key}
                  label={label}
                  type={type}
                  value={modal.affiliation[key] || ''}
                  onChange={(e) =>
                    setModal({
                      ...modal,
                      affiliation: {
                        ...modal.affiliation,
                        [key]: e.target.value,
                      },
                    })
                  }
                />
              ))}
              <div className="contact-actions">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => open(c.id)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  Save affiliation
                </Button>
              </div>
            </form>
          )}
          {modal.type === 'backfill' && (
            <div className="contact-form">
              <p>
                Find people in your stored Gmail messages, Fireflies meetings
                and Granola notes. New identities arrive for your review.
              </p>
              <div className="contact-inline-actions">
                <Button
                  disabled={busy || running}
                  onClick={() =>
                    mutate(
                      'contacts/backfill',
                      {
                        aliases: aliases
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      },
                      () => {
                        setModal(null);
                        setNotice(
                          'Contact extraction started for the last 90 days.',
                        );
                      },
                    )
                  }
                >
                  Extract last 90 days
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || running}
                  onClick={() =>
                    mutate(
                      'contacts/backfill',
                      {
                        full: true,
                        aliases: aliases
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      },
                      () => {
                        setModal(null);
                        setNotice('Full stored-history extraction started.');
                      },
                    )
                  }
                >
                  Extract all stored history
                </Button>
              </div>
              <FormField
                label="Your other email addresses"
                description="Comma-separated aliases help keep your own identities out of the map."
                value={aliases}
                onChange={(e) => setAliases(e.target.value)}
                placeholder="alias@example.com"
              />
              <hr />
              <h3>Import a contact list</h3>
              <p className="contact-hint">
                CSV columns: name, email, company, role, notes, tags. Separate
                tags with semicolons. Quoted commas and multiline notes are
                supported.
              </p>
              <input
                ref={csvInput}
                type="file"
                accept=".csv,text/csv"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    await mutate(
                      'contacts/import',
                      { csv: await file.text() },
                      (r) => {
                        setModal(null);
                        setNotice(
                          `${r.added} contacts added from ${r.total} rows.`,
                        );
                      },
                    );
                  }
                  e.target.value = '';
                }}
              />
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => csvInput.current?.click()}
              >
                <Upload />
                Choose CSV
              </Button>
              <hr />
              <h3>Data & coverage</h3>
              {status?.runs.map((r) => (
                <div className="contact-review-row" key={r.id}>
                  <div>
                    <strong>
                      {r.state} · {r.imported} sources processed
                    </strong>
                    <p>{r.message || 'Waiting for worker'}</p>
                  </div>
                  <small>{formatDate(r.started_at)}</small>
                </div>
              ))}
              <p className="contact-hint">
                {status?.queue.map((r) => `${r.n} ${r.state}`).join(' · ') ||
                  'No source extraction has run yet.'}
              </p>
              {status?.exclusions.map((r) => (
                <p className="contact-hint" key={r.exclusion}>
                  {r.n} excluded: {r.exclusion}
                </p>
              ))}
              <Button
                variant="outline"
                disabled={busy || running}
                onClick={() =>
                  mutate('contacts/backfill', { retry: true }, () =>
                    setNotice('Extraction will resume from saved progress.'),
                  )
                }
              >
                <RefreshCw />
                Retry unfinished extraction
              </Button>
              <p className="contact-hint">
                Provider import and contact extraction are separate. Refresh
                your providers in Connections to bring in new source material.
              </p>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
