'use client';

import { ArrowRight, CircleHelp, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Citations, formatDate } from './shared';

export function ProposalQueue({
  proposals,
  deferred = [],
  history = [],
  restore,
  busy,
  openSource,
  selectProposal,
  dismiss,
}) {
  const cards = (rows) =>
    rows.map((proposal, index) => (
      <Card className="decision-card" key={proposal.id}>
        <div className="decision-heading">
          <span className="decision-index">
            {String(index + 1).padStart(2, '0')}
          </span>
          <div>
            <div className="decision-meta">
              <span>
                {proposal.payload.kind === 'decision'
                  ? 'DECISION'
                  : 'PROPOSED OUTCOME'}
              </span>
              <span>·</span>
              <span>{proposal.payload.confidence} confidence</span>
            </div>
            <h3>{proposal.payload.title}</h3>
          </div>
        </div>
        {proposal.payload.qualification && (
          <p className="muted-caption">
            {
              {
                verbal_promise: 'Your verbal promise',
                written_promise: 'Your written promise',
                direct_request: 'Requested from you',
              }[proposal.payload.qualification.basis]
            }
            {' · '}
            {
              {
                customer: 'Customer',
                internal: 'Internal',
                personal: 'Personal',
              }[proposal.payload.qualification.area]
            }
            {proposal.payload.qualification.due_date && (
              <>
                {' '}
                ·{' '}
                {proposal.payload.qualification.deadline_kind === 'hard'
                  ? 'Due'
                  : 'Suggested checkpoint'}{' '}
                {formatDate(proposal.payload.qualification.due_date)}
              </>
            )}
          </p>
        )}
        <p className="decision-rationale">{proposal.payload.rationale}</p>
        {proposal.payload.citations.length > 1 && (
          <Citations
            citations={proposal.payload.citations}
            openSource={openSource}
          />
        )}
        {proposal.payload.uncertainty && (
          <div className="verify-note">
            <CircleHelp size={14} />
            <span>{proposal.payload.uncertainty}</span>
          </div>
        )}
        <div className="decision-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              openSource(
                proposal.payload.citations[0].source_id,
                proposal.payload.citations[0].quote,
                proposal.payload.citations[0].source_version_id,
              )
            }
          >
            <FileText />
            Evidence
          </Button>
          <div>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => dismiss(proposal.id)}
            >
              Dismiss
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => selectProposal(proposal)}
            >
              Review
              <ArrowRight />
            </Button>
          </div>
        </div>
      </Card>
    ));
  return (
    <>
      {(proposals.length > 0 || deferred.length > 0) && (
        <section
          className="decision-section"
          aria-label="Proposals awaiting your decision"
        >
          <div className="section-title">
            <h2>
              Ready for your decision <span>{proposals.length}</span>
            </h2>
            <span className="muted-caption">
              Your promises first · Reviewed automatically
            </span>
          </div>
          <div className="decision-list">{cards(proposals)}</div>
          {deferred.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-muted-foreground">
                For later · {deferred.length} suggestions
              </summary>
              <p className="my-3 text-sm text-muted-foreground">
                Kept for review as priorities change. Your shortlist has at most
                ten suggestions.
              </p>
              <div className="decision-list">{cards(deferred)}</div>
            </details>
          )}
        </section>
      )}
      {history.length > 0 && (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Recently removed · {history.length}
          </summary>
          <div className="mt-3 space-y-3">
            {history.map((event) => (
              <Card className="p-4" key={event.id}>
                <strong>{event.title}</strong>
                <p className="my-2 text-sm text-muted-foreground">
                  {event.detail?.explanation || 'Dismissed by you.'}
                </p>
                {event.detail?.citations?.length > 0 && (
                  <Citations
                    citations={event.detail.citations}
                    openSource={openSource}
                  />
                )}
                {restore && event.status === 'dismissed' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => restore(event.proposal_id, event.version)}
                  >
                    Restore suggestion
                  </Button>
                )}
              </Card>
            ))}
          </div>
        </details>
      )}
    </>
  );
}
