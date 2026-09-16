'use client';

import { useEffect, useState } from 'react';
import { Combobox } from '@base-ui/react/combobox';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SelectButton } from '@/components/ui/select';

export function OwnerPicker({
  value,
  onChange,
  self,
  owners = [],
  api,
  required,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const selfValue = self || 'You';
  const selected = !value || value === 'You' ? selfValue : value;
  const label = (owner) => (owner === selfValue ? 'You' : owner);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const data = await api('owners?q=' + encodeURIComponent(query));
        if (active) setResult({ ...data, query, attempt });
      } catch {
        if (active) setResult({ query, attempt, error: true, owners: [] });
      }
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, open, query, attempt]);

  const current = result?.query === query && result?.attempt === attempt;
  const pinned = [selfValue, selected, ...owners].filter(
    (owner) =>
      owner &&
      owner !== 'You' &&
      label(owner).toLowerCase().includes(query.toLowerCase()),
  );
  if (selfValue === 'You' && 'you'.includes(query.toLowerCase()))
    pinned.unshift('You');
  const options = [
    ...new Set([
      ...pinned,
      ...(current ? result.owners : []).map((owner) =>
        owner === 'You' ? selfValue : owner,
      ),
    ]),
  ];

  return (
    <Combobox.Root
      items={options}
      filter={null}
      value={selected}
      itemToStringLabel={label}
      onValueChange={(owner) => owner && onChange(owner)}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      required={required}
    >
      <Combobox.Trigger render={<SelectButton aria-label="Owner" />}>
        <Combobox.Value>{label(selected)}</Combobox.Value>
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={6} className="z-50">
          <Combobox.Popup
            aria-label="Choose an owner"
            className="w-[var(--anchor-width)] min-w-60 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
          >
            <Combobox.Input
              aria-labelledby={undefined}
              aria-label="Search owners"
              placeholder="Search names or email…"
              className="mb-1 h-10 w-full border-b px-3 text-base outline-none sm:text-sm"
            />
            <Combobox.List className="max-h-60 overflow-y-auto overscroll-contain">
              {(owner) => (
                <Combobox.Item
                  key={owner}
                  value={owner}
                  className="flex min-h-9 cursor-default items-center justify-between gap-2 rounded-md px-3 py-2 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  <span className="break-words">{label(owner)}</span>
                  <Combobox.ItemIndicator>
                    <Check className="size-4 shrink-0" />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
            <Combobox.Status className="px-3 text-xs text-muted-foreground">
              {!current && <p className="py-2">Loading contacts…</p>}
              {current && result.error && (
                <div className="py-2">
                  Contacts couldn’t load.
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => setAttempt((n) => n + 1)}
                  >
                    Try again
                  </Button>
                </div>
              )}
              {current && !result.error && !options.length && (
                <p className="py-2">No matching owners.</p>
              )}
              {current && result.hasMore && (
                <p className="py-2">Keep typing to narrow the list.</p>
              )}
            </Combobox.Status>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
