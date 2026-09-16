'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Card } from '@/components/ui/card';
import { Choice, Notice } from './shared';

export function ReviewSelection({
  label,
  total,
  visible,
  selected,
  busy,
  onSelectAll,
  children,
}) {
  if (!visible) return null;
  return (
    <div className="contact-bulk-toolbar" role="group" aria-label={label}>
      <label className="contact-bulk-select">
        <Checkbox
          checked={selected === visible}
          indeterminate={selected > 0 && selected < visible}
          disabled={busy}
          onCheckedChange={onSelectAll}
        />
        Select all {visible} visible
      </label>
      <span className="contact-hint" aria-live="polite">
        {selected} selected · {total} pending
      </span>
      <div className="contact-inline-actions">{children}</div>
    </div>
  );
}

export function BulkMergeReview({
  preview,
  busy,
  progress,
  onMerge,
  onCancel,
}) {
  const [targets, setTargets] = useState(() =>
    Object.fromEntries(preview.groups.map((g) => [g.token, g.target_id])),
  );
  const [included, setIncluded] = useState(() =>
    preview.groups.filter((g) => !g.blocked).map((g) => g.token),
  );
  const selected = preview.groups.filter(
    (g) => included.includes(g.token) && !g.blocked,
  );
  const profiles = selected.reduce((sum, g) => sum + g.contacts.length - 1, 0);
  return (
    <div className="contact-form">
      <p>
        Choose the profile to keep in each group. Its name and follow-up cadence
        stay. Identities, evidence, affiliations, notes, drafts and commitment
        links move to it. Do-not-contact and pause preferences are preserved.
      </p>
      <p className="contact-hint">
        Matches that share a person form one group. Each group saves separately
        and can be undone from Recent merges while its records remain unchanged.
      </p>
      {preview.groups.map((g, index) => (
        <Card className="contact-bulk-group" key={g.token}>
          <label className="contact-bulk-select">
            <Checkbox
              aria-label={`Include group ${index + 1}`}
              disabled={busy || !!g.blocked}
              checked={included.includes(g.token)}
              onCheckedChange={(checked) =>
                setIncluded((ids) =>
                  checked
                    ? [...ids, g.token]
                    : ids.filter((id) => id !== g.token),
                )
              }
            />
            <strong>
              Group {index + 1} · {g.contacts.length} profiles
            </strong>
          </label>
          {g.blocked ? (
            <Notice error>{g.blocked} This group will be skipped.</Notice>
          ) : (
            <Choice
              label={`Keep profile for group ${index + 1}`}
              disabled={busy || !included.includes(g.token)}
              value={targets[g.token]}
              onChange={(id) => setTargets((t) => ({ ...t, [g.token]: id }))}
              options={Object.fromEntries(
                g.contacts.map((c) => [
                  c.id,
                  `${c.name} · ${c.email || 'No email'}${c.role ? ' · ' + c.role : ''}`,
                ]),
              )}
            />
          )}
          <div className="contact-merge-pair">
            {g.contacts.map((c) => (
              <div className="contact-bulk-profile" key={c.id}>
                <small>
                  {targets[g.token] === c.id
                    ? 'Keep this profile'
                    : 'Move records from'}
                </small>
                <h3>{c.name}</h3>
                <p>{c.email || 'No email'}</p>
                <p>
                  {[c.role, ...c.organizations].filter(Boolean).join(' · ')}
                </p>
                <p>
                  {c.providers.join(', ') || 'Manually added'} ·{' '}
                  {c.counts.interaction_participants} interactions ·{' '}
                  {c.cadence_days}-day cadence
                </p>
                {(c.do_not_contact || c.paused || c.archived) && (
                  <p>
                    {[
                      c.do_not_contact && 'Do not contact',
                      c.paused && 'Paused',
                      c.archived && 'Archived',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
                {c.notes && (
                  <details>
                    <summary>Private notes</summary>
                    <p>{c.notes}</p>
                  </details>
                )}
              </div>
            ))}
          </div>
        </Card>
      ))}
      {progress && <p role="status">{progress}</p>}
      <div className="contact-actions">
        <Button variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={busy || !selected.length}
          onClick={() =>
            onMerge(
              selected.map((g) => ({
                label: `Group ${preview.groups.indexOf(g) + 1}`,
                review_ids: g.review_ids,
                token: g.token,
                target_id: targets[g.token],
              })),
            )
          }
        >
          {busy
            ? 'Merging…'
            : `Merge ${profiles} ${profiles === 1 ? 'profile' : 'profiles'} in ${selected.length} ${selected.length === 1 ? 'group' : 'groups'}`}
        </Button>
      </div>
    </div>
  );
}
