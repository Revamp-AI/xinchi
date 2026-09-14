'use client';

import {
  ArrowRight,
  CheckCheck,
  ClipboardPen,
  Clock3,
  Plus,
  Target,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs, TabsList, TabsTab, TabsPanel } from '@/components/ui/tabs';
import { localToday } from '../../lib/urgency.mjs';
import { AttentionBadge, CarryoverBadge } from './attention';
import {
  Empty,
  FormField,
  Heading,
  StatusBadge,
  formatDate,
  statusNames,
} from './shared';

export default function BoardView({
  state,
  tab,
  setTab,
  focus,
  setFocus,
  hours,
  setHours,
  saveFocus,
  busy,
  create,
  edit,
  openDraft,
}) {
  const today = localToday(new Date());
  const carried = Object.fromEntries(
    (state.carryovers || []).map((row) => [row.item_id, row.n]),
  );
  return (
    <>
      <Heading
        eyebrow="MAKE SPACE FOR THE IMPORTANT"
        title="Your commitments"
        description="Three active outcomes. A clear finish. Room to follow through."
      >
        <Button variant="outline" className="me-2" onClick={() => openDraft()}>
          <ClipboardPen />
          Draft update
        </Button>
        <Button onClick={create}>
          <Plus />
          New outcome
        </Button>
      </Heading>
      <Card className="weekly-focus">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            saveFocus();
          }}
        >
          <div className="weekly-focus-label">
            <Target size={18} />
            <h2>This week’s focus</h2>
            <StatusBadge>70% capacity rule</StatusBadge>
          </div>
          <div className="weekly-focus-fields">
            <FormField
              label="The one constraint to remove"
              value={focus}
              onChange={(event) => setFocus(event.target.value)}
              placeholder="What would make the biggest difference this week?"
            />
            <FormField
              label="Available hours"
              type="number"
              min="0"
              max="168"
              value={hours}
              onChange={(event) => setHours(event.target.value)}
            />
            <div className="capacity-budget">
              <strong>
                {Math.round(Number(hours) * 0.7)}
                <span>h</span>
              </strong>
              <small>commitment budget</small>
            </div>
            <Button variant="outline" type="submit" disabled={busy}>
              Save focus
            </Button>
          </div>
        </form>
      </Card>
      <Tabs value={tab} onValueChange={setTab} className="commitment-tabs">
        <div className="tabs-scroll">
          <TabsList variant="underline" aria-label="Commitment status">
            {Object.entries(statusNames).map(([id, label]) => (
              <TabsTab key={id} value={id}>
                {label}
                <span className="tab-count">
                  {state.items.filter((item) => item.status === id).length}
                </span>
              </TabsTab>
            ))}
          </TabsList>
        </div>
        {Object.entries(statusNames).map(([id, label]) => (
          <TabsPanel key={id} value={id}>
            {id === 'candidate' && (
              <p className="queue-note">
                These are possibilities, not commitments. Confirm what’s still
                relevant before choosing one.
              </p>
            )}
            <Card className="commitment-list">
              {state.items
                .filter((item) => item.status === id)
                .map((item, index) => (
                  <div className="commitment-row" key={item.id}>
                    <span className="outcome-index">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <div className="commitment-info">
                      <div>
                        <Button
                          variant="link"
                          className="outcome-title"
                          onClick={() => edit(item)}
                        >
                          {item.title}
                        </Button>
                        <StatusBadge>{item.kind}</StatusBadge>
                      </div>
                      <p>
                        {item.next_action || 'Define a concrete next action'}
                      </p>
                    </div>
                    <div className="checkpoint">
                      <span>
                        <Clock3 size={14} />
                        {formatDate(item.checkpoint)}
                      </span>
                      {item.hard_deadline && (
                        <small>Due {formatDate(item.hard_deadline)}</small>
                      )}
                      <div className="mt-1.5 flex flex-wrap justify-end gap-1.5 empty:hidden">
                        <AttentionBadge item={item} today={today} />
                        <CarryoverBadge count={carried[item.id]} />
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Review ${item.title}`}
                      onClick={() => edit(item)}
                    >
                      <ArrowRight />
                    </Button>
                  </div>
                ))}
              {!state.items.some((item) => item.status === id) && (
                <Empty
                  icon={CheckCheck}
                  title={
                    id === 'now'
                      ? 'Make one deliberate choice'
                      : `Nothing ${label.toLowerCase()} yet`
                  }
                  description={
                    id === 'now'
                      ? 'Choose a meaningful outcome from your queue, or ask Focus to help you decide.'
                      : 'Your outcomes will appear here when you move them to this stage.'
                  }
                >
                  {id === 'now' && (
                    <Button
                      variant="outline"
                      onClick={() => setTab('candidate')}
                    >
                      Review the queue
                      <ArrowRight />
                    </Button>
                  )}
                </Empty>
              )}
            </Card>
          </TabsPanel>
        ))}
      </Tabs>
    </>
  );
}
