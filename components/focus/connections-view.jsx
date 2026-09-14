'use client';

import {
  ArrowRight,
  ArrowUpRight,
  CheckCheck,
  Clock3,
  Database,
  HardDrive,
  LockKeyhole,
  RefreshCw,
  Settings2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionPanel,
} from '@/components/ui/accordion';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Heading,
  Notice,
  ProviderIcon,
  StatusBadge,
  countSources,
  formatDate,
  providerNames,
} from './shared';

const descriptions = {
  fireflies: 'Your conversations, transcripts, and meeting action items.',
  granola: 'Meeting notes and the thinking around your conversations.',
  gmail: 'Email threads, follow-ups, and decisions waiting in your inbox.',
};
const runTones = {
  running: 'info',
  complete: 'success',
  partial: 'info',
  failed: 'warning',
};
const runLabels = {
  running: 'Running',
  complete: 'Complete',
  partial: 'Partial',
  failed: 'Failed',
};
const finished = (run) => ['complete', 'partial'].includes(run?.state);
function formatStarted(value) {
  const date = new Date(value);
  return Number.isNaN(+date)
    ? value
    : date.toLocaleString('en', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}
function formatDuration(run) {
  const seconds = Math.round(
    (Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000,
  );
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
const secondsAgo = (value) =>
  Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
const successLine = (run) =>
  `Last successful import ${formatDate(run.finished_at || run.started_at)} · ${(run.changed || 0).toLocaleString()} added or updated · ${(run.imported || 0).toLocaleString()} processed`;
export default function ConnectionsView({ state, busy, configure, sync }) {
  const active = state.sync.find((run) => run.state === 'running');
  return (
    <>
      <Heading
        eyebrow="A WORKSPACE THAT REMEMBERS"
        title="Your connections"
        description="Bring in the context once. Keep every decision connected to its source."
      >
        <StatusBadge dot>
          {countSources(state).toLocaleString()} records stored
        </StatusBadge>
      </Heading>
      <div className="connection-list">
        {['gmail', 'fireflies', 'granola'].map((provider) => {
          const connection = state.connections[provider],
            rows = state.coverage.filter((row) => row.provider === provider),
            count = countSources(state, provider),
            run = state.sync.find((item) => item.provider === provider),
            history = state.sync_history
              .filter((item) => item.provider === provider)
              .slice(0, 10),
            lastSuccess = finished(run)
              ? run
              : state.sync_history.find(
                  (item) => item.provider === provider && finished(item),
                ),
            importing = run?.state === 'running';
          const [label, tone] = importing
            ? ['Importing', 'info']
            : connection.issue || run?.state === 'failed'
              ? ['Needs attention', 'warning']
              : connection.configured
                ? finished(run)
                  ? ['Connected', 'success']
                  : ['Credentials saved', 'neutral']
                : count
                  ? ['Archive imported', 'neutral']
                  : ['Not connected', 'neutral'];
          return (
            <Card className="connection-row" key={provider}>
              <div className="connection-primary">
                <ProviderIcon provider={provider} />
                <div className="connection-identity">
                  <h2>
                    {providerNames[provider]}
                    <StatusBadge tone={tone} dot>
                      {label}
                    </StatusBadge>
                  </h2>
                  <p>{descriptions[provider]}</p>
                  {connection.email && <span>{connection.email}</span>}
                </div>
                <div className="connection-total">
                  <strong>{count.toLocaleString()}</strong>
                  <span>records stored</span>
                </div>
                <div className="connection-buttons">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => configure(provider)}
                    aria-label={`${connection.configured ? 'Settings for' : 'Connect'} ${provider}`}
                  >
                    {connection.configured ? (
                      <>
                        <Settings2 />
                        Settings
                      </>
                    ) : (
                      <>
                        Connect
                        <ArrowRight />
                      </>
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant={connection.configured ? 'default' : 'outline'}
                    disabled={!connection.configured || busy || !!active}
                    onClick={() => sync(provider)}
                  >
                    {importing ? <Spinner /> : <RefreshCw />}
                    {importing
                      ? 'Importing'
                      : run?.state === 'partial'
                        ? 'Continue import'
                        : 'Refresh'}
                  </Button>
                </div>
              </div>
              {connection.issue && !importing && (
                <Notice error>
                  {connection.issue.message}
                  {connection.issue.code === 'gmail_api_disabled' && (
                    <Button
                      variant="link"
                      size="sm"
                      render={
                        <a
                          href="https://console.cloud.google.com/apis/library/gmail.googleapis.com"
                          target="_blank"
                          rel="noreferrer"
                        />
                      }
                    >
                      Open Gmail API settings
                      <ArrowUpRight />
                    </Button>
                  )}
                </Notice>
              )}
              <div className="connection-details">
                <span>
                  <Database size={14} />
                  {rows.length
                    ? rows
                        .map(
                          (row) =>
                            `${row.count.toLocaleString()} ${row.coverage}`,
                        )
                        .join(' · ')
                    : 'Waiting for the first import'}
                </span>
                {run ? (
                  <span
                    className={run.state === 'failed' ? 'failed-detail' : ''}
                  >
                    {importing ? (
                      <Spinner className="size-3" />
                    ) : (
                      <Clock3 size={14} />
                    )}
                    <span>
                      {importing
                        ? `${run.message || 'Reading source material…'} · updated ${secondsAgo(run.updated_at || run.started_at)}s ago`
                        : run.state === 'failed'
                          ? `Import interrupted · ${formatDate(run.finished_at || run.started_at)}`
                          : `${successLine(run)}${run.state === 'partial' ? ' · More history available' : ''}`}
                      {run.state === 'failed' && lastSuccess && (
                        <>
                          <br />
                          {successLine(lastSuccess)}
                        </>
                      )}
                    </span>
                  </span>
                ) : (
                  <span>
                    {connection.configured
                      ? 'Ready to import'
                      : count
                        ? 'Connect to keep this archive up to date'
                        : 'Connect to start importing'}
                  </span>
                )}
              </div>
              {history.length > 0 && (
                <Accordion className="sync-details-accordion">
                  <AccordionItem value="import-history">
                    <AccordionTrigger>Import history</AccordionTrigger>
                    <AccordionPanel>
                      <div className="pb-3.5">
                        <Table className="text-xs">
                          <TableHeader>
                            <TableRow>
                              <TableHead>Started</TableHead>
                              <TableHead>Duration</TableHead>
                              <TableHead>State</TableHead>
                              <TableHead className="text-right">
                                Processed
                              </TableHead>
                              <TableHead className="text-right">
                                Added or updated
                              </TableHead>
                              <TableHead>Message</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {history.map((item) => (
                              <TableRow key={item.id}>
                                <TableCell>
                                  {formatStarted(item.started_at)}
                                </TableCell>
                                <TableCell>{formatDuration(item)}</TableCell>
                                <TableCell>
                                  <StatusBadge
                                    tone={runTones[item.state] || 'neutral'}
                                  >
                                    {runLabels[item.state] || item.state}
                                  </StatusBadge>
                                </TableCell>
                                <TableCell className="text-right">
                                  {(item.imported || 0).toLocaleString()}
                                </TableCell>
                                <TableCell className="text-right">
                                  {(item.changed || 0).toLocaleString()}
                                </TableCell>
                                <TableCell className="whitespace-normal leading-snug text-muted-foreground">
                                  {item.message}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </AccordionPanel>
                  </AccordionItem>
                </Accordion>
              )}
            </Card>
          );
        })}
      </div>
      <div className="storage-grid">
        <Card className="storage-card">
          <span className="storage-icon">
            <HardDrive size={19} />
          </span>
          <div>
            <h3>Your context, stored in Postgres</h3>
            <p>
              Source text, previous versions, decisions, and agent activity are
              saved in your configured Postgres database. Provider credentials
              remain on this computer.
            </p>
            <Accordion>
              <AccordionItem value="storage">
                <AccordionTrigger>What’s included</AccordionTrigger>
                <AccordionPanel>
                  <p>
                    Searchable meeting text and email bodies are stored with
                    their original source. Recording media and email attachment
                    contents are not downloaded. Attachment names are retained.
                    Imports update existing records and keep their history.
                  </p>
                </AccordionPanel>
              </AccordionItem>
            </Accordion>
          </div>
        </Card>
        <Card className="storage-card">
          <span className="storage-icon">
            <LockKeyhole size={19} />
          </span>
          <div>
            <h3>Read-only by design</h3>
            <p>
              Connections bring context into Focus. Your agent proposes changes;
              you choose what becomes a commitment.
            </p>
            <div className="storage-assurance">
              <CheckCheck size={14} />
              No emails sent. No mailbox changes.
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
