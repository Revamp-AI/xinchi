'use client';

import {
  ArrowUpRight,
  Check,
  Circle,
  FileText,
  Flame,
  Focus,
  Leaf,
  Mail,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from '@/components/ui/select';
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from '@/components/ui/dialog';

export const statusNames = {
  candidate: 'To decide',
  now: 'Now',
  waiting: 'Waiting',
  later: 'Later',
  done: 'Done',
  dropped: 'Closed',
};
export const providerNames = {
  fireflies: 'Fireflies',
  granola: 'Granola',
  gmail: 'Gmail',
  manual: 'Your notes',
};
export function formatDate(value) {
  if (!value) return 'No checkpoint';
  const date = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? value + 'T12:00:00' : value,
  );
  return Number.isNaN(+date)
    ? value
    : date.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}
export const countSources = (state, provider) =>
  state.coverage
    .filter((row) => !provider || row.provider === provider)
    .reduce((sum, row) => sum + row.count, 0);
export function Brand({ compact = false }) {
  return (
    <div className="focus-brand">
      <span className="focus-logo">
        <Focus size={19} strokeWidth={2.3} />
      </span>
      {!compact && (
        <span>
          focus<span className="brand-period">.</span>
        </span>
      )}
    </div>
  );
}
export function ProviderIcon({ provider, small = false }) {
  const Icon =
    { fireflies: Flame, granola: Leaf, gmail: Mail, manual: FileText }[
      provider
    ] || FileText;
  return (
    <span
      className={`provider-symbol provider-${provider}${small ? ' provider-small' : ''}`}
      aria-hidden="true"
    >
      <Icon size={small ? 15 : 20} strokeWidth={1.8} />
    </span>
  );
}
export function StatusBadge({ children, tone = 'neutral', dot = false }) {
  return (
    <Badge variant="outline" className={`status-badge tone-${tone}`}>
      {dot && <span className="status-dot" />}
      {children}
    </Badge>
  );
}
export function Heading({ eyebrow, title, description, children }) {
  return (
    <header className="view-heading">
      <div>
        {eyebrow && <p className="view-eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="view-description">{description}</p>}
      </div>
      {children && <div className="heading-actions">{children}</div>}
    </header>
  );
}
export function Empty({ icon: Icon = Circle, title, description, children }) {
  return (
    <div className="empty-state">
      <span className="empty-symbol">
        <Icon size={23} strokeWidth={1.5} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function FormField({
  label,
  description,
  multiline,
  children,
  ...props
}) {
  return (
    <Field className="form-field">
      <FieldLabel>{label}</FieldLabel>
      {children || (multiline ? <Textarea {...props} /> : <Input {...props} />)}
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  );
}
export function Choice({
  value,
  onChange,
  options,
  label,
  className,
  ...props
}) {
  const items = Object.entries(options).map(([value, label]) => ({
    value,
    label,
  }));
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => onChange(next ?? '')}
      {...props}
    >
      <SelectTrigger aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
export function Modal({ title, description, children, onClose, wide }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className={wide ? 'sm:max-w-3xl' : 'sm:max-w-xl'}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogPanel>{children}</DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
export function Notice({ children, onClose, error = false }) {
  return (
    <Card
      className={`notice-banner ${error ? 'notice-error' : ''}`}
      role={error ? 'alert' : 'status'}
    >
      <span className="notice-symbol">
        {error ? <Circle size={16} /> : <Check size={16} />}
      </span>
      <div>{children}</div>
      {onClose && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={error ? 'Dismiss error' : 'Dismiss notice'}
        >
          <X />
        </Button>
      )}
    </Card>
  );
}
export function Citations({ citations = [], openSource }) {
  return (
    <div className="citation-list">
      {citations.map((citation, index) => (
        <Button
          key={`${citation.source_id}-${index}`}
          variant="outline"
          size="xs"
          onClick={() => openSource(citation.source_id)}
        >
          <ProviderIcon small provider={citation.source_id.split(':')[0]} />
          {providerNames[citation.source_id.split(':')[0]] || 'Source'}
          <ArrowUpRight size={12} />
        </Button>
      ))}
    </div>
  );
}
