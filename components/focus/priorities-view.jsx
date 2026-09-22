'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import {
  Theme,
  Button,
  IconButton,
  Card,
  Badge,
  TextField,
  TextArea,
  Select,
  Dialog,
  Flex,
  Callout,
  DropdownMenu,
} from '@radix-ui/themes';
import {
  DndContext,
  MeasuringStrategy,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Plus,
  GripVertical,
  ArrowUp,
  ArrowDown,
  ArrowRight,
  MoreHorizontal,
  Sparkles,
  X,
  FileText,
  Check,
  RefreshCw,
  Layers3,
} from 'lucide-react';

const date = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      })
    : '';
const initials = (name) =>
  (name || 'You')
    .split(/\s+/)
    .slice(0, 2)
    .map((n) => n[0])
    .join('')
    .toUpperCase();
function PriorityTheme({ children }) {
  const { resolvedTheme } = useTheme();
  return (
    <Theme
      accentColor="grass"
      grayColor="sage"
      radius="medium"
      appearance={resolvedTheme === 'dark' ? 'dark' : 'light'}
      className="priority-theme"
    >
      {children}
    </Theme>
  );
}
function ErrorMessage({ message }) {
  return message ? (
    <Callout.Root color="red" role="alert">
      <Callout.Text>{message}</Callout.Text>
    </Callout.Root>
  ) : null;
}
function SourceLinks({ citations, onSource }) {
  return (
    <div className="priority-sources">
      {citations.map((c, i) => (
        <button
          key={`${c.source_version_id}-${i}`}
          type="button"
          onClick={() => onSource(c.source_id, c.quote, c.source_version_id)}
        >
          <FileText size={14} />
          <span>
            {c.title || 'Source'}
            {c.occurred_at ? ` · ${date(c.occurred_at)}` : ''}
          </span>
          <ArrowRight size={13} />
        </button>
      ))}
    </div>
  );
}
function SortablePriority({
  item,
  index,
  count,
  onOpen,
  onMove,
  busy,
  selected,
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled: busy });
  return (
    <Card
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.55 : 1,
      }}
      className={`priority-card ${selected ? 'is-selected' : ''}`}
      data-testid="priority-card"
    >
      <div className="priority-card-top">
        <span className="priority-rank">
          {String(index + 1).padStart(2, '0')}
        </span>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          className="priority-drag"
          ref={setActivatorNodeRef}
          aria-label={`Reorder ${item.title}`}
          disabled={busy}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={15} />
        </IconButton>
      </div>
      <button
        type="button"
        className="priority-card-open"
        onClick={() => onOpen(item.id)}
      >
        <h3>{item.title}</h3>
        {item.financials && (
          <p className="priority-financials">{item.financials}</p>
        )}
        <p className="priority-preview">
          {item.latest_summary ||
            item.next_decision ||
            'Add context. Focus will keep it connected.'}
        </p>
      </button>
      <div className="priority-card-bottom">
        <span className="priority-owner">
          <span className="priority-avatar">{initials(item.owner)}</span>
          {item.owner}
        </span>
        <div className="priority-move">
          <IconButton
            size="1"
            variant="ghost"
            color="gray"
            aria-label={`Move ${item.title} up`}
            disabled={busy || index === 0}
            onClick={() => onMove(index, index - 1)}
          >
            <ArrowUp size={14} />
          </IconButton>
          <IconButton
            size="1"
            variant="ghost"
            color="gray"
            aria-label={`Move ${item.title} down`}
            disabled={busy || index === count - 1}
            onClick={() => onMove(index, index + 1)}
          >
            <ArrowDown size={14} />
          </IconButton>
        </div>
      </div>
      {(item.last_context_at || Number(item.suggestion_count) > 0) && (
        <div className="priority-card-status">
          {item.last_context_at && (
            <span>Context · {date(item.last_context_at)}</span>
          )}
          {Number(item.suggestion_count) > 0 && (
            <Badge size="1" variant="soft">
              {item.suggestion_count} suggestion
              {Number(item.suggestion_count) === 1 ? '' : 's'}
            </Badge>
          )}
        </div>
      )}
    </Card>
  );
}
function PriorityStack({
  stack,
  items,
  onOpen,
  onAdd,
  onOrder,
  onStackMove,
  index,
  stackCount,
  busy,
  selectedId,
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: stack.id, disabled: busy });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  function move(from, to) {
    if (from !== to && from >= 0 && to >= 0)
      onOrder(
        stack.id,
        arrayMove(
          items.map((p) => p.id),
          from,
          to,
        ),
      );
  }
  return (
    <section
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.55 : 1,
      }}
      className="priority-stack"
      aria-label={`${stack.name} stack`}
    >
      <div className="priority-stack-heading">
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          className="priority-drag"
          ref={setActivatorNodeRef}
          aria-label={`Reorder ${stack.name} stack`}
          disabled={busy}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={15} />
        </IconButton>
        <h2>{stack.name}</h2>
        <span>{items.length}</span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <IconButton
              size="1"
              variant="ghost"
              color="gray"
              aria-label={`${stack.name} stack options`}
            >
              <MoreHorizontal size={18} />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            <DropdownMenu.Item
              disabled={busy || index === 0}
              onSelect={() => onStackMove(index, index - 1)}
            >
              Move stack earlier
            </DropdownMenu.Item>
            <DropdownMenu.Item
              disabled={busy || index === stackCount - 1}
              onSelect={() => onStackMove(index, index + 1)}
            >
              Move stack later
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
      <DndContext
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={({ active, over }) => {
          if (over)
            move(
              items.findIndex((p) => p.id === active.id),
              items.findIndex((p) => p.id === over.id),
            );
        }}
      >
        <SortableContext
          items={items.map((p) => p.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="priority-stack-items">
            {items.map((item, index) => (
              <SortablePriority
                key={item.id}
                {...{ item, index, onOpen, busy }}
                selected={selectedId === item.id}
                count={items.length}
                onMove={move}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {!items.length && (
        <div className="priority-stack-empty">
          <Layers3 size={24} />
          <p>What matters most here?</p>
          <span>Put the most important work on top.</span>
        </div>
      )}
      <Button
        className="priority-add"
        variant="ghost"
        color="gray"
        onClick={() => onAdd(stack.id)}
      >
        <Plus size={15} />
        Add a priority
      </Button>
    </section>
  );
}
function PriorityEditor({
  value,
  stacks,
  items,
  owners,
  onSave,
  onClose,
  busy,
  error,
}) {
  const [draft, setDraft] = useState(value);
  const set = (key, value) => setDraft((old) => ({ ...old, [key]: value }));
  const ownerOptions = [...new Set([draft.owner || 'You', 'You', ...owners])];
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Content maxWidth="540px" className="priority-editor">
        <Flex justify="between" align="start">
          <div>
            <Dialog.Title>
              {draft.id ? 'Edit priority' : 'Add a priority'}
            </Dialog.Title>
            <Dialog.Description size="2" color="gray">
              Set the direction. Focus connects the context.
            </Dialog.Description>
          </div>
          <IconButton
            variant="ghost"
            color="gray"
            onClick={onClose}
            aria-label="Close priority form"
            disabled={busy}
          >
            <X size={18} />
          </IconButton>
        </Flex>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave(draft);
          }}
        >
          <ErrorMessage message={error} />
          <label className="priority-field" htmlFor="priority-title">
            Title
            <TextField.Root
              id="priority-title"

              required
              maxLength={200}
              value={draft.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder="A deal, initiative, or outcome"
            />
          </label>
          <div className="priority-form-row">
            <label className="priority-field" htmlFor="priority-stack">
              Stack
              <Select.Root
                value={draft.stack_id}
                onValueChange={(v) => set('stack_id', v)}
              >
                <Select.Trigger id="priority-stack" aria-label="Stack" />
                <Select.Content>
                  {stacks.map((s) => (
                    <Select.Item key={s.id} value={s.id}>
                      {s.name}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </label>
            <label className="priority-field" htmlFor="priority-owner">
              Owner
              <Select.Root
                value={draft.owner || 'You'}
                onValueChange={(v) => set('owner', v)}
              >
                <Select.Trigger id="priority-owner" aria-label="Owner" />
                <Select.Content>
                  {ownerOptions.map((name) => (
                    <Select.Item key={name} value={name}>
                      {name}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </label>
          </div>
          {draft.stack_id === 'deal-flow' && (
            <label className="priority-field" htmlFor="priority-financials">
              Financials <span className="priority-muted">Optional</span>
              <TextField.Root
                id="priority-financials"
                value={draft.financials}
                onChange={(e) => set('financials', e.target.value)}
                maxLength={500}
                placeholder="Potential ARR, deal value, or commercial terms"
              />
            </label>
          )}
          <label className="priority-field" htmlFor="priority-decision">
            Next decision
            <TextField.Root
              id="priority-decision"
              value={draft.next_decision}
              onChange={(e) => set('next_decision', e.target.value)}
              maxLength={1000}
              placeholder="What needs to be decided next?"
            />
          </label>
          <label className="priority-field" htmlFor="priority-commitment">
            Linked commitment
            <Select.Root
              value={draft.commitment_id || 'none'}
              onValueChange={(v) =>
                set('commitment_id', v === 'none' ? null : v)
              }
            >
              <Select.Trigger
                id="priority-commitment"
                aria-label="Linked commitment"
                placeholder="Choose a commitment"
              />
              <Select.Content>
                <Select.Item value="none">No linked commitment</Select.Item>
                {items.map((p) => (
                  <Select.Item key={p.id} value={p.id}>
                    {p.title}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </label>
          <label className="priority-field" htmlFor="priority-notes">
            Context to remember
            <TextArea
              id="priority-notes"
              value={draft.notes}
              onChange={(e) => set('notes', e.target.value)}
              maxLength={4000}
              placeholder="The outcome, background, or constraints"
            />
          </label>
          <label className="priority-field" htmlFor="priority-keywords">
            Names & keywords <span className="priority-muted">Optional</span>
            <TextField.Root
              id="priority-keywords"
              value={draft.keywords}
              onChange={(e) => set('keywords', e.target.value)}
              maxLength={500}
              placeholder="Company, project name, aliases"
            />
            <small>
              Helps Focus find related meetings already in your archive.
            </small>
          </label>
          <Flex justify="end" gap="2" mt="5">
            <Button
              type="button"
              variant="soft"
              color="gray"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !draft.title.trim()}>
              {busy ? 'Saving…' : 'Save priority'}
            </Button>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
function Suggestion({ suggestion, version, onDecide, onSource, busy }) {
  const p = suggestion.payload;
  const stale = !!suggestion.priority_id && p.base_version !== version;
  return (
    <Card className="priority-suggestion">
      <div className="priority-suggestion-label">
        <Sparkles size={15} />
        {suggestion.priority_id ? 'Suggested update' : 'Suggested priority'}
      </div>
      {!suggestion.priority_id && <h3>{p.title}</h3>}
      <p>{suggestion.priority_id ? p.reason || p.summary : p.summary}</p>
      {p.next_decision && (
        <p>
          <strong>Next decision:</strong> {p.next_decision}
        </p>
      )}
      {p.suggested_rank != null && (
        <p>
          <strong>Suggested position:</strong> {p.suggested_rank}
        </p>
      )}
      <SourceLinks citations={p.citations || []} onSource={onSource} />
      {stale && (
        <p className="priority-muted">
          You changed this priority. Review its context again for a fresh
          suggestion.
        </p>
      )}
      <Flex gap="2" mt="3">
        <Button
          size="2"
          disabled={busy || stale}
          onClick={() => onDecide(suggestion, 'apply', version)}
        >
          {suggestion.priority_id ? 'Apply update' : 'Add to stack'}
        </Button>
        <Button
          size="2"
          color="gray"
          variant="soft"
          disabled={busy}
          onClick={() => onDecide(suggestion, 'dismiss', version)}
        >
          Dismiss
        </Button>
      </Flex>
    </Card>
  );
}
export function PrioritiesOverview({ priorities, onOpen }) {
  if (!priorities) return null;
  return (
    <PriorityTheme>
      <section className="priorities-overview" aria-label="Priority overview">
        <div className="priorities-overview-heading">
          <h2>Top of your stacks</h2>
          <Button variant="ghost" color="gray" onClick={() => onOpen(null)}>
            View priorities
            <ArrowRight size={14} />
          </Button>
        </div>
        <div className="priority-summary-grid">
          {priorities.stacks.map((stack) => {
            const first = priorities.items.find(
              (p) => p.stack_id === stack.id && p.status === 'active',
            );
            return (
              <Card key={stack.id} asChild>
                <button
                  type="button"
                  className="priority-summary"
                  onClick={() => onOpen(first?.id || null)}
                >
                  <span>{stack.name}</span>
                  <strong>{first?.title || 'Set your first priority'}</strong>
                  <p>
                    {first?.next_decision ||
                      first?.latest_summary ||
                      'Choose what belongs on top.'}
                  </p>
                </button>
              </Card>
            );
          })}
        </div>
      </section>
    </PriorityTheme>
  );
}
export default function PrioritiesView({
  state,
  api,
  refresh,
  openSource,
  editCommitment,
  selectedId,
  setSelectedId,
}) {
  const board = state.priorities;
  const [loadedDetail, setDetail] = useState(null),
    [editor, setEditor] = useState(null),
    [owners, setOwners] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [update, setUpdate] = useState(''),
    [showDone, setShowDone] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const detail = loadedDetail?.id === selectedId ? loadedDetail : null;
  const selected = board.items.find((p) => p.id === selectedId),
    selectedChanged = selected?.updated_at;
  useEffect(() => {
    let alive = true;
    if (selectedId)
      api('priorities/' + encodeURIComponent(selectedId))
        .then((p) => {
          if (alive) setDetail(p);
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    return () => {
      alive = false;
    };
  }, [selectedId, selectedChanged, api]);
  useEffect(() => {
    let alive = true;
    api('owners')
      .then((r) => {
        if (alive) setOwners(r.owners);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api]);
  async function act(action) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await action();
      await refresh();
      if (selectedId)
        setDetail(await api('priorities/' + encodeURIComponent(selectedId)));
      return result;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  function add(stack_id) {
    setError('');
    setEditor({
      stack_id,
      title: '',
      owner: state.user?.name || 'You',
      financials: '',
      notes: '',
      keywords: '',
      next_decision: '',
      commitment_id: null,
    });
  }
  async function save(draft) {
    const result = await act(() => api('priorities', draft));
    if (result) {
      setEditor(null);
      setDetail(result);
      setSelectedId(result.id);
      setNotice(
        'Saved. Focus will connect matching meetings and updates automatically.',
      );
    }
  }
  function edit() {
    const keys = [
      'id',
      'version',
      'stack_id',
      'title',
      'owner',
      'financials',
      'notes',
      'keywords',
      'next_decision',
      'commitment_id',
    ];
    setError('');
    setEditor(Object.fromEntries(keys.map((k) => [k, detail[k]])));
  }
  function order(stack_id, ids) {
    return act(() =>
      api('priorities/order', { stack_id, ids, version: board.order_version }),
    );
  }
  function source(...args) {
    setSelectedId(null);
    openSource(...args);
  }
  async function decide(s, action, version) {
    const result = await act(() =>
      api('priorities/suggestion', { id: s.id, action, version }),
    );
    if (result && action === 'apply' && !s.priority_id)
      setSelectedId(result.id);
  }
  const activeJob = state.jobs.find((j) =>
    ['queued', 'running'].includes(j.status),
  );
  const lastJob = state.jobs[0];
  const newSuggestions = board.suggestions.filter((s) => !s.priority_id);
  const done = board.items.filter((p) => p.status === 'done');
  const rank = selected
    ? board.items
        .filter(
          (p) => p.stack_id === selected.stack_id && p.status === 'active',
        )
        .findIndex((p) => p.id === selectedId) + 1
    : 0;
  return (
    <PriorityTheme>
      <div className="priorities-view">
        <header className="priorities-heading">
          <div>
            <span className="priority-eyebrow">YOUR COMPANY, IN ORDER</span>
            <h1>Priorities</h1>
            <p>Keep the most important work on top.</p>
          </div>
          <Flex gap="2" wrap="wrap">
            <Button
              variant="soft"
              color="gray"
              disabled={busy || !!activeJob}
              onClick={() =>
                act(async () => {
                  const result = await api('priorities/discover', {});
                  setNotice(
                    'Review started. Suggested priorities will appear here when it finishes.',
                  );
                  return result;
                })
              }
            >
              <Sparkles size={15} />
              Suggest from meetings
            </Button>
            <Button onClick={() => add(board.stacks[0].id)}>
              <Plus size={16} />
              New priority
            </Button>
          </Flex>
        </header>
        <div className="priority-enrichment-status" role="status">
          <Sparkles size={14} />
          <span>
            {activeJob
              ? 'Reviewing context. Updates and suggestions appear here as each review finishes.'
              : lastJob?.status === 'failed'
                ? 'The latest context review was interrupted. Open Overview to review its status.'
                : 'New meetings and updates add context automatically. You control the order.'}
          </span>
        </div>
        {!editor && !selectedId && <ErrorMessage message={error} />}
        {notice && !selectedId && !editor && (
          <Callout.Root>
            <Callout.Text>{notice}</Callout.Text>
          </Callout.Root>
        )}
        <DndContext
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={({ active, over }) => {
            if (over && active.id !== over.id)
              order(
                undefined,
                arrayMove(
                  board.stacks.map((s) => s.id),
                  board.stacks.findIndex((s) => s.id === active.id),
                  board.stacks.findIndex((s) => s.id === over.id),
                ),
              );
          }}
        >
          <SortableContext
            items={board.stacks.map((s) => s.id)}
            strategy={rectSortingStrategy}
          >
            <div className="priority-stacks">
              {board.stacks.map((stack, index) => (
                <PriorityStack
                  key={stack.id}
                  {...{ stack, index, busy, selectedId }}
                  items={board.items.filter(
                    (p) => p.stack_id === stack.id && p.status === 'active',
                  )}
                  onOpen={(id) => {
                    setUpdate('');
                    setError('');
                    setNotice('');
                    setSelectedId(id);
                  }}
                  onAdd={add}
                  onOrder={order}
                  stackCount={board.stacks.length}
                  onStackMove={(from, to) =>
                    order(
                      undefined,
                      arrayMove(
                        board.stacks.map((s) => s.id),
                        from,
                        to,
                      ),
                    )
                  }
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        {newSuggestions.length > 0 && (
          <section className="priority-new-suggestions">
            <h2>
              From your context{' '}
              <Badge variant="soft">{newSuggestions.length}</Badge>
            </h2>
            <p>Possible priorities, ready for your decision.</p>
            <div className="priority-summary-grid">
              {newSuggestions.map((s) => (
                <Suggestion
                  key={s.id}
                  suggestion={s}
                  onDecide={decide}
                  onSource={source}
                  busy={busy}
                />
              ))}
            </div>
          </section>
        )}
        {done.length > 0 && (
          <section className="priority-completed">
            <Button
              variant="ghost"
              color="gray"
              onClick={() => setShowDone(!showDone)}
            >
              {showDone ? 'Hide' : 'Show'} completed priorities ({done.length})
            </Button>
            {showDone &&
              done.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                >
                  <Check size={14} />
                  {p.title}
                </button>
              ))}
          </section>
        )}
        <Dialog.Root
          open={!!selectedId && !editor}
          onOpenChange={(open) => {
            if (!open && !busy) setSelectedId(null);
          }}
        >
          <Dialog.Content
            className="priority-drawer"
            aria-describedby="priority-detail-description"
          >
            <Flex justify="between" align="center" mb="5">
              <span className="priority-muted">
                {board.stacks.find((s) => s.id === selected?.stack_id)?.name}
                {rank > 0
                  ? ` / Priority ${rank}`
                  : selected?.status === 'done'
                    ? ' / Completed'
                    : ''}
              </span>
              <IconButton
                variant="ghost"
                color="gray"
                aria-label="Close priority"
                onClick={() => setSelectedId(null)}
              >
                <X size={20} />
              </IconButton>
            </Flex>
            <Dialog.Title size="7">
              {detail?.title || selected?.title || 'Priority'}
            </Dialog.Title>
            <Dialog.Description
              id="priority-detail-description"
              size="2"
              color="gray"
            >
              Decisions, updates, and the context behind them.
            </Dialog.Description>
            <ErrorMessage message={error} />
            {!detail && !error && <p>Loading context…</p>}
            {detail && (
              <>
                <div className="priority-detail-meta">
                  <span className="priority-owner">
                    <span className="priority-avatar">
                      {initials(detail.owner)}
                    </span>
                    {detail.owner}
                  </span>
                  {detail.financials && <span>{detail.financials}</span>}
                  <Button variant="ghost" color="gray" size="2" onClick={edit}>
                    Edit
                  </Button>
                </div>
                <section className="priority-detail-section">
                  <h2>
                    Latest update{' '}
                    {detail.last_context_at && (
                      <span>{date(detail.last_context_at)}</span>
                    )}
                  </h2>
                  <p>
                    {detail.latest_summary ||
                      'No updates yet. Add an update or review matching archive context.'}
                  </p>
                  {detail.updates[0] && (
                    <SourceLinks
                      citations={detail.updates[0].citations}
                      onSource={source}
                    />
                  )}
                </section>
                <section className="priority-detail-section">
                  <h2>Next decision</h2>
                  <p>{detail.next_decision || 'No next decision set.'}</p>
                  {detail.commitment && (
                    <Button
                      variant="outline"
                      color="gray"
                      onClick={() => {
                        setSelectedId(null);
                        editCommitment(detail.commitment);
                      }}
                    >
                      Open linked commitment
                      <ArrowRight size={14} />
                    </Button>
                  )}
                </section>
                {detail.notes && (
                  <section className="priority-detail-section">
                    <h2>Context to remember</h2>
                    <p>{detail.notes}</p>
                  </section>
                )}
                {detail.suggestions.map((s) => (
                  <Suggestion
                    key={s.id}
                    suggestion={s}
                    version={detail.version}
                    onDecide={decide}
                    onSource={source}
                    busy={busy}
                  />
                ))}
                <section className="priority-detail-section">
                  <div className="priority-section-heading">
                    <h2>Recent context</h2>
                    <Button
                      size="1"
                      variant="ghost"
                      disabled={busy || detail.status !== 'active'}
                      onClick={() =>
                        act(async () => {
                          const r = await api('priorities/review', {
                            id: detail.id,
                          });
                          setNotice(
                            r.queued
                              ? `${r.queued} matching sources queued for review.`
                              : 'No matching sources found in the last 30 days. Add names or keywords to help Focus find them.',
                          );
                          return r;
                        })
                      }
                    >
                      <RefreshCw size={13} />
                      Review context
                    </Button>
                  </div>
                  {notice && (
                    <p className="priority-muted" role="status">
                      {notice}
                    </p>
                  )}
                  {!detail.updates.length ? (
                    <p className="priority-muted">
                      Related meetings and updates will appear here.
                    </p>
                  ) : (
                    detail.updates.map((u) => (
                      <article className="priority-update" key={u.id}>
                        <div>
                          <span>
                            {u.origin === 'user'
                              ? 'Your update'
                              : 'From your context'}
                          </span>
                          <time>{date(u.occurred_at)}</time>
                        </div>
                        <p>{u.body}</p>
                        <SourceLinks
                          citations={u.citations}
                          onSource={source}
                        />
                      </article>
                    ))
                  )}
                </section>
                <form
                  className="priority-update-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (
                      await act(() =>
                        api('priorities/update', {
                          id: detail.id,
                          body: update,
                        }),
                      )
                    )
                      setUpdate('');
                  }}
                >
                  <label htmlFor="priority-update-body">Add an update</label>
                  <TextArea
                    id="priority-update-body"
                    value={update}
                    onChange={(e) => setUpdate(e.target.value)}
                    maxLength={4000}
                    placeholder="What changed?"
                  />
                  <Flex justify="between" align="center" mt="2">
                    <span className="priority-muted">
                      Saved with its date and source.
                    </span>
                    <Button
                      type="submit"
                      size="2"
                      disabled={busy || !update.trim()}
                    >
                      Save update
                    </Button>
                  </Flex>
                </form>
                <Button
                  className="priority-complete"
                  variant="soft"
                  color="gray"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await act(() =>
                        api('priorities', {
                          id: detail.id,
                          version: detail.version,
                          status: detail.status === 'done' ? 'active' : 'done',
                        }),
                      )
                    )
                      setSelectedId(null);
                  }}
                >
                  <Check size={14} />
                  {detail.status === 'done'
                    ? 'Restore priority'
                    : 'Mark complete'}
                </Button>
              </>
            )}
          </Dialog.Content>
        </Dialog.Root>
        {editor && (
          <PriorityEditor
            key={editor.id || 'new'}
            value={editor}
            stacks={board.stacks}
            items={state.items}
            owners={owners}
            onSave={save}
            onClose={() => {
              setEditor(null);
              setError('');
            }}
            busy={busy}
            error={error}
          />
        )}
      </div>
    </PriorityTheme>
  );
}
