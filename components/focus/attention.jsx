'use client';

import { RotateCcw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { attention, localToday, sortByAttention } from '../../lib/urgency.mjs';
import { StatusBadge, formatDate } from './shared';

const tones = {
  overdue: 'warning',
  due: 'info',
  checkback: 'info',
  review: 'info',
};
const levelNames = {
  overdue: 'Overdue',
  due: 'Due soon',
  checkback: 'Check back',
  review: 'Review',
};
const countsByItem = (carryovers = []) =>
  Object.fromEntries(carryovers.map((row) => [row.item_id, row.n]));

export function AttentionBadge({ item, today }) {
  const signal = attention(item, today || localToday(new Date()));
  return signal ? (
    <StatusBadge tone={tones[signal.level]}>{signal.label}</StatusBadge>
  ) : null;
}
export function CarryoverBadge({ count = 0, hint = false }) {
  if (!(count >= 2)) return null;
  return (
    <>
      <StatusBadge tone="warning">
        <RotateCcw />
        Carried over {count} times
      </StatusBadge>
      {hint && (
        <span className="muted-caption">Re-decide scope or priority</span>
      )}
    </>
  );
}
export function AttentionStrip({ items = [], carryovers = [], edit, today }) {
  const day = today || localToday(new Date());
  const carried = countsByItem(carryovers);
  const rows = sortByAttention(
    items.filter(
      (item) =>
        attention(item, day) ||
        (carried[item.id] >= 2 && !['done', 'dropped'].includes(item.status)),
    ),
    day,
  );
  if (rows.length === 0) return null;
  return (
    <Card
      className="mb-7 gap-0 rounded-xl px-5 py-4 shadow-none"
      role="region"
      aria-label="Needs attention"
    >
      <div className="section-title">
        <h2>
          <TriangleAlert size={16} />
          Needs attention <span>{rows.length}</span>
        </h2>
        <span className="muted-caption">As of {formatDate(day)}</span>
      </div>
      <ul className="m-0 list-none p-0">
        {rows.map((item) => {
          const signal = attention(item, day);
          return (
            <li
              key={item.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border py-2.5 text-sm first:border-t-0 first:pt-0 last:pb-0"
            >
              {signal && (
                <StatusBadge tone={tones[signal.level]}>
                  {levelNames[signal.level]}
                </StatusBadge>
              )}
              <Button
                variant="link"
                size="sm"
                className="outcome-title"
                onClick={() => edit(item)}
              >
                {item.title}
              </Button>
              {signal && (
                <span className="text-muted-foreground">
                  {signal.label} · {formatDate(item[signal.field])}
                </span>
              )}
              <CarryoverBadge count={carried[item.id]} hint />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
