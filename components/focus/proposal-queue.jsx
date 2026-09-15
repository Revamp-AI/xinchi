'use client';

import { ArrowRight, CircleHelp, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Citations } from './shared';

export function ProposalQueue({
  proposals,
  busy,
  openSource,
  selectProposal,
  dismiss,
}) {
  if (!proposals.length) return null;
  return (
    <section
      className="decision-section"
      aria-label="Proposals awaiting your decision"
    >
      <div className="section-title">
        <h2>
          Ready for your decision <span>{proposals.length}</span>
        </h2>
        <span className="muted-caption">You make the call</span>
      </div>
      <div className="decision-list">
        {proposals.map((proposal, index) => (
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
        ))}
      </div>
    </section>
  );
}
