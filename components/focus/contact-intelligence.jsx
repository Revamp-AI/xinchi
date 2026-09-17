'use client';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { StatusBadge, formatDate } from './shared';

export function ContactIntelligencePanel({ status, busy, mutate }) {
  if (!status) return null;
  return (
    <section className="contact-review-group" aria-label="Relationship agent">
      <div className="contact-section-title">
        <div>
          <h2>Relationship agent</h2>
          <p className="contact-hint">
            Reads your conversations to understand each relationship and suggest
            a next step. Starred contacts are analyzed first. Uses the model
            selected in review settings.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || status.running}
          onClick={() => mutate('contacts/intelligence', {})}
        >
          Analyze now
        </Button>
      </div>
      <label className="contact-toggle" htmlFor="contact-analysis-enabled">
        <Checkbox
          id="contact-analysis-enabled"
          checked={status.enabled}
          disabled={busy}
          onCheckedChange={(enabled) =>
            mutate('contacts/intelligence/settings', { enabled })
          }
        />
        Analyze relationships automatically
      </label>
      <p className="contact-hint" role="status">
        {status.running
          ? 'Reading relationship evidence… '
          : status.enabled
            ? 'Runs automatically as context changes. '
            : 'Automatic analysis is paused. '}
        {status.reviewed || 0} of {status.total || 0} profiles assessed ·{' '}
        {status.enriched || 0} with inferred purpose.
        {status.pending > 0 ? ` ${status.pending} awaiting analysis.` : ''}
      </p>
      {status.error && (
        <p role="alert">
          {status.error} Unfinished analysis will retry automatically.
        </p>
      )}
    </section>
  );
}

export function ContactInsight({ contact, busy, mutate, refresh, openSource }) {
  const insight = contact.insight;
  if (insight?.dismissed)
    return (
      <p className="contact-hint">
        Agent insights dismissed. Your purpose tags stay in control.
      </p>
    );
  const result = insight?.result;
  const restricted =
    contact.paused ||
    contact.do_not_contact ||
    (contact.snoozed_until &&
      contact.snoozed_until >= new Date().toISOString().slice(0, 10));
  return (
    <section aria-label="Relationship context">
      <h3>Relationship context</h3>
      {!result ? (
        <p className="contact-hint">
          Awaiting automatic analysis of the available conversations.
        </p>
      ) : (
        <>
          <div className="contact-tags">
            {result.purpose_tags.map((tag) => (
              <StatusBadge key={tag}>{tag} · inferred</StatusBadge>
            ))}
          </div>
          {!result.purpose_tags.length && (
            <p className="contact-hint">
              Not enough context to establish this relationship’s purpose.
            </p>
          )}
          {result.summary && <p>{result.summary}</p>}
          {result.next_action && !restricted && (
            <p>
              <strong>Suggested next step: </strong>
              {result.next_action}
            </p>
          )}
          <p className="contact-hint">
            Assessed {formatDate(insight.reviewed_at)} ·{' '}
            {result.confidence === 'unknown'
              ? 'Purpose unknown'
              : `${result.confidence} confidence`}
            . Your manual purpose tags take precedence.
          </p>
          {result.citations.map((citation, index) => (
            <div key={`${citation.source_version_id}-${index}`}>
              <blockquote>{citation.quote}</blockquote>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  openSource(
                    citation.source_id,
                    citation.quote,
                    citation.source_version_id,
                  )
                }
              >
                View evidence {index + 1}
              </Button>
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              mutate(
                'contacts/intelligence/dismiss',
                { id: contact.id },
                refresh,
              )
            }
          >
            Dismiss agent insights
          </Button>
        </>
      )}
    </section>
  );
}
