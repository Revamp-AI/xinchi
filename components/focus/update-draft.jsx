'use client';

import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormField, Modal, formatDate, statusNames } from './shared';

const dayOnly = /^\d{4}-\d{2}-\d{2}$/;
const label = (status) => statusNames[status] || status || 'None';
function describeChange(change) {
  if (change.what === 'status')
    return `${label(change.from)} → ${label(change.to)}`;
  if (change.what === 'checkpoint')
    return `Checkpoint ${formatDate(change.from)} → ${formatDate(change.to)}`;
  return `Scope: ${change.from || 'none'} → ${change.to || 'none'}`;
}
const sections = [
  {
    key: 'completed',
    title: 'Completed',
    detail: (row) => [row.evidence, formatDate(row.at)],
  },
  {
    key: 'changed',
    title: 'Changed',
    detail: (row) => [describeChange(row), row.reason, formatDate(row.at)],
  },
  {
    key: 'next',
    title: 'Next',
    detail: (row) => [
      row.next_action,
      row.checkpoint && `Checkpoint ${formatDate(row.checkpoint)}`,
      row.hard_deadline && `Due ${formatDate(row.hard_deadline)}`,
    ],
  },
  {
    key: 'needs',
    title: 'Need from you',
    detail: (row) =>
      'dependency' in row
        ? [
            `Waiting on ${row.dependency}`,
            `Check back ${formatDate(row.checkpoint)}`,
            row.last_action,
          ]
        : ['Decision needed', row.next_action],
  },
];
export function UpdateDraftDialog({ draft, since, setSince, reload, close }) {
  const [text, setText] = useState(draft.text);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setText(draft.text);
  }, [draft.text]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <Modal
      title="Draft update"
      description="Completed, changed, next, and what you need — from commitments marked for business updates."
      onClose={close}
      wide
    >
      <div className="flex flex-col gap-5">
        <FormField
          label="Changes since"
          type="date"
          value={since}
          onChange={(event) => {
            setSince(event.target.value);
            if (dayOnly.test(event.target.value)) reload(event.target.value);
          }}
          description="Completed and changed items are limited to this window."
        />
        <div className="grid gap-5 sm:grid-cols-2">
          {sections.map((section) => {
            const rows = draft.draft[section.key];
            return (
              <section key={section.key}>
                <div className="section-title">
                  <h2>
                    {section.title}
                    <span>{rows.length}</span>
                  </h2>
                </div>
                {rows.length ? (
                  <ul className="m-0 flex list-none flex-col gap-3 p-0">
                    {rows.map((row, index) => (
                      <li key={`${row.id}-${index}`}>
                        <strong>{row.title}</strong>
                        <p className="text-muted-foreground">
                          {section.detail(row).filter(Boolean).join(' · ')}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="dialog-note">Nothing to report.</p>
                )}
              </section>
            );
          })}
        </div>
        <FormField
          label="Update text"
          multiline
          value={text}
          onChange={(event) => setText(event.target.value)}
          description="Edit the wording here before you paste it anywhere."
        />
        <div className="dialog-actions">
          <p className="dialog-note">Nothing is sent from Focus.</p>
          <div>
            <Button variant="outline" onClick={close}>
              Close
            </Button>
            <Button onClick={copy}>
              {copied ? <Check /> : <Copy />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
