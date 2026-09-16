'use client';

import { Check, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusBadge, formatDate } from './shared';

export const isFollowUp = (prompt) =>
  String(prompt || '').startsWith('Follow-up to review');
export function promptSnippet(prompt, limit = 64) {
  const text = String(prompt || '');
  const original = [...text.matchAll(/^Original request: (.*)$/gm)].pop();
  const line = (original ? original[1] : text.split('\n')[0]).trim();
  return line.length > limit ? line.slice(0, limit - 1).trimEnd() + '…' : line;
}
const firstLine = (text) =>
  String(text || '')
    .split('\n')[0]
    .trim();
export function ReviewHistory({ jobs, selectedJobId, onSelect }) {
  const complete = jobs
    .filter((job) => job.status === 'complete')
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const selected =
    complete.find((job) => job.id === selectedJobId) || complete[0];
  return (
    <section className="mt-7" aria-label="Past reviews">
      <div className="section-title">
        <h2>
          <History size={16} />
          Past reviews
          {complete.length > 1 && <span>{complete.length}</span>}
        </h2>
        {complete.length > 1 && (
          <span className="muted-caption">Pick one to revisit</span>
        )}
      </div>
      {complete.length < 2 ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          Each review you run is kept here so you can come back to it.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {complete.map((job) => {
            const current = job.id === selected?.id;
            return (
              <Button
                key={job.id}
                variant="ghost"
                aria-current={current ? 'true' : undefined}
                className={`h-auto w-full min-w-0 items-start justify-start gap-3 whitespace-normal rounded-lg px-3 py-2.5 text-left sm:h-auto ${current ? 'border-border bg-muted' : ''}`}
                onClick={() => onSelect(job.id)}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusBadge
                      tone={job.kind === 'import_review' ? 'info' : 'neutral'}
                    >
                      {job.kind === 'import_review'
                        ? 'Import review'
                        : 'Review'}
                    </StatusBadge>
                    {isFollowUp(job.prompt) && (
                      <StatusBadge tone="info">Follow-up</StatusBadge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {formatDate(job.created_at)}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-sm leading-snug font-medium [overflow-wrap:anywhere]">
                    {firstLine(job.result?.brief) || 'Review ready'}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {promptSnippet(job.prompt)}
                  </span>
                </span>
                {current && <Check size={15} className="mt-1 shrink-0" />}
              </Button>
            );
          })}
        </div>
      )}
    </section>
  );
}
