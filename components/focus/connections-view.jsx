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
            importing = run?.state === 'running';
          const tone = importing
            ? 'info'
            : connection.issue || run?.state === 'failed'
              ? 'warning'
              : connection.configured
                ? 'success'
                : 'neutral';
          const label = importing
            ? 'Importing'
            : connection.issue || run?.state === 'failed'
              ? 'Needs attention'
              : connection.configured
                ? 'Connected'
                : count
                  ? 'Archive imported'
                  : 'Not connected';
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
                        ? run.message || 'Reading source material…'
                        : `${run.state === 'partial' ? 'More history available' : run.state === 'complete' ? 'Import complete' : 'Import interrupted'} · ${formatDate(run.finished_at || run.started_at)}`}
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
              {run && !importing && (
                <Accordion className="sync-details-accordion">
                  <AccordionItem value="import-details">
                    <AccordionTrigger>Last import details</AccordionTrigger>
                    <AccordionPanel>
                      <div className="sync-detail-content">
                        <StatusBadge
                          tone={run.state === 'failed' ? 'warning' : 'neutral'}
                        >
                          {run.state}
                        </StatusBadge>
                        <span>{run.imported || 0} records processed</span>
                        <p>{run.message}</p>
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
            <h3>Your context stays on this Mac</h3>
            <p>
              Source text, previous versions, decisions, and agent activity are
              saved in one local archive.
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
