'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import AppShell from '@/components/focus/app-shell';
import AgentView from '@/components/focus/agent-view';
import BoardView from '@/components/focus/board-view';
import LibraryView from '@/components/focus/library-view';
import ConnectionsView from '@/components/focus/connections-view';
import {
  ActivityDialog,
  CommitmentDialog,
  ConnectionDialog,
  HistoryDialog,
  SourceDialog,
} from '@/components/focus/dialogs';
import { UpdateDraftDialog } from '@/components/focus/update-draft';
import { Brand, Notice } from '@/components/focus/shared';
import { gmailMessages } from '../lib/auth-messages.mjs';

async function api(path, data) {
  const response = await fetch(
    '/api/' + path,
    data === undefined
      ? { cache: 'no-store' }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Xin-Request': '1' },
          body: JSON.stringify(data),
        },
  );
  const body = await response.json();
  if (response.status === 401) {
    window.location.replace('/login?error=expired');
    throw Error('Your session expired. Sign in again.');
  }
  if (!response.ok) throw Error(body.error || 'Could not save. Try again.');
  return body;
}
export default function Workspace() {
  const [view, setView] = useState('agent'),
    [state, setState] = useState(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState(''),
    [editing, setEditing] = useState(null),
    [source, setSource] = useState(null),
    [setup, setSetup] = useState(null),
    [trace, setTrace] = useState(null),
    [events, setEvents] = useState(null);
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [q, setQ] = useState(''),
    [provider, setProvider] = useState(''),
    [offset, setOffset] = useState(0),
    [library, setLibrary] = useState({ total: 0, records: [] }),
    [libraryLoading, setLibraryLoading] = useState(false);
  const [tab, setTab] = useState('now'),
    [focus, setFocus] = useState(''),
    [hours, setHours] = useState(0);
  const [draft, setDraft] = useState(null);
  const refresh = async () => {
    const next = await api('state');
    setState(next);
    return next;
  };
  useEffect(() => {
    let mounted = true;
    api('state')
      .then((next) => {
        if (mounted) {
          setState(next);
          setFocus(next.focus);
          setHours(next.available_hours);
        }
      })
      .catch((error) => {
        if (mounted) setError(error.message);
      });
    const timer = setInterval(() => {
      api('state')
        .then((next) => {
          if (mounted) setState(next);
        })
        .catch(() => {});
    }, 2500);
    const query = new URLSearchParams(location.search),
      gmail = query.get('gmail');
    if (gmail) {
      setNotice(
        gmailMessages[gmail] ||
          (gmail === 'connected'
            ? query.get('import') === 'started'
              ? 'Signed in. Gmail import started; follow its progress in Connections.'
              : 'Signed in. Gmail access is ready. Open Connections to refresh your mail.'
            : 'Signed in. Gmail access was not granted. Open Connections to enable it.'),
      );
      history.replaceState(null, '', '/');
    }
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (view !== 'library') return;
    let mounted = true;
    setLibraryLoading(true);
    const timer = setTimeout(
      () =>
        api(
          `sources?q=${encodeURIComponent(q)}&provider=${encodeURIComponent(provider)}&offset=${offset}`,
        )
          .then((result) => {
            if (mounted) setLibrary(result);
          })
          .catch((error) => {
            if (mounted) setError(error.message);
          })
          .finally(() => {
            if (mounted) setLibraryLoading(false);
          }),
      200,
    );
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [view, q, provider, offset]);
  const act = async (action) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  };
  const openSource = async (id, quote = '') => {
    setError('');
    try {
      const record = await api('sources/' + encodeURIComponent(id));
      setSource({ ...record, quote });
    } catch (error) {
      setError(error.message);
    }
  };
  const navigate = (next, nextTab) => {
    setView(next);
    if (nextTab) setTab(nextTab);
  };
  const start = (text) =>
    act(async () => {
      await api('jobs', { prompt: text || prompt });
      setPrompt('');
      setSelectedJobId(null);
      setView('agent');
    });
  const cancel = (id) => act(() => api('jobs/cancel', { id }));
  const answer = (parentId, answers) =>
    act(async () => {
      await api('jobs', { prompt: 'Follow-up', answers, parent_id: parentId });
      setSelectedJobId(null);
    });
  const edit = (item) => {
    setError('');
    setEditing(item);
  };
  const create = () =>
    edit({
      title: '',
      status: 'candidate',
      kind: 'action',
      owner: state?.user?.name || 'You',
      shared: false,
    });
  const selectProposal = (proposal) => {
    const original = state.items.find(
      (item) => item.id === proposal.payload.existing_item_id,
    );
    edit({
      ...original,
      ...proposal.payload,
      source_id: proposal.payload.citations[0].source_id,
      source_quote: proposal.payload.citations[0].quote,
      proposal_id: proposal.id,
      status: original?.status || 'candidate',
      reason: proposal.payload.rationale,
    });
  };
  const inspect = async (path, setter) => {
    try {
      setter(await api(path));
    } catch (error) {
      setError(error.message);
    }
  };
  const openDraft = (since = '') =>
    inspect('update-draft?since=' + encodeURIComponent(since), setDraft);
  const importFile = (file) =>
    act(async () => {
      const text = await file.text();
      const result = await api(
        'import',
        file.name.endsWith('.json')
          ? JSON.parse(text)
          : {
              provider: 'manual',
              external_id: crypto.randomUUID(),
              title: file.name,
              body: text,
              coverage: 'document',
              occurred_at: new Date().toISOString(),
            },
      );
      setNotice(
        `${result.changed} sources added or updated. Agent review queued when available.`,
      );
      setQ('');
      setProvider('');
      setOffset(0);
      setLibrary(await api('sources'));
    });
  const onLogout = async () => {
    setBusy(true);
    try {
      await api('auth/logout', {});
      window.location.replace('/login');
    } catch (error) {
      setError(error.message);
      setBusy(false);
    }
  };
  if (!state)
    return (
      <div className="workspace-loading">
        <Brand />
        <Spinner />
        <p>{error || 'Bringing your context together…'}</p>
        {error && (
          <Button variant="outline" onClick={() => location.reload()}>
            Try again
          </Button>
        )}
      </div>
    );
  const now = state.items.filter((item) => item.status === 'now');
  return (
    <AppShell {...{ view, state, busy, onLogout }} onViewChange={navigate}>
      {error && !editing && !setup && (
        <Notice error onClose={() => setError('')}>
          {error}
        </Notice>
      )}
      {notice && <Notice onClose={() => setNotice('')}>{notice}</Notice>}
      {view === 'agent' && (
        <AgentView
          {...{
            state,
            prompt,
            setPrompt,
            busy,
            start,
            openSource,
            selectProposal,
            create,
            edit,
            navigate,
            selectedJobId,
            setSelectedJobId,
            cancel,
            answer,
          }}
          dismiss={(id) => act(() => api('proposals/dismiss', { id }))}
          showTrace={(id) => inspect('jobs/' + id, setTrace)}
        />
      )}
      {view === 'board' && (
        <BoardView
          {...{
            state,
            tab,
            setTab,
            focus,
            setFocus,
            hours,
            setHours,
            busy,
            create,
            edit,
            openDraft,
          }}
          saveFocus={() =>
            act(async () => {
              await api('settings', { focus, available_hours: hours });
              setNotice('Weekly focus saved.');
            })
          }
        />
      )}
      {view === 'library' && (
        <LibraryView
          {...{
            library,
            q,
            setQ,
            provider,
            setProvider,
            offset,
            setOffset,
            openSource,
            importFile,
            busy,
          }}
          loading={libraryLoading}
        />
      )}
      {view === 'connections' && (
        <ConnectionsView
          {...{ state, busy }}
          configure={(provider) => {
            setError('');
            setSetup(provider);
          }}
          sync={(provider) =>
            act(async () => {
              await api('sync', { provider });
              setNotice('Import started. Progress appears below.');
            })
          }
        />
      )}
      {editing && (
        <CommitmentDialog
          item={editing}
          setItem={setEditing}
          {...{ now, busy, error, openSource }}
          close={() => setEditing(null)}
          save={() =>
            act(async () => {
              await api('items', editing);
              setEditing(null);
              setNotice('Decision saved.');
            })
          }
          showHistory={(id) => inspect('events/' + id, setEvents)}
        />
      )}
      {source && <SourceDialog source={source} close={() => setSource(null)} />}
      {trace && <ActivityDialog trace={trace} close={() => setTrace(null)} />}
      {events && (
        <HistoryDialog events={events} close={() => setEvents(null)} />
      )}
      {draft && (
        <UpdateDraftDialog
          draft={draft}
          since={draft.since}
          setSince={(value) => setDraft({ ...draft, since: value })}
          reload={openDraft}
          close={() => setDraft(null)}
        />
      )}
      {setup && (
        <ConnectionDialog
          key={setup}
          provider={setup}
          {...{ state, busy, error }}
          close={() => setSetup(null)}
          save={(data) =>
            act(async () => {
              await api('connections', data);
              setSetup(null);
              setNotice(
                'Connection settings saved. Refresh to import available history.',
              );
            })
          }
          reconnect={(query) =>
            act(async () => {
              await api('connections', { gmail_query: query });
              const result = await api('auth/google/start', {});
              window.location.href = result.url;
            })
          }
        />
      )}
    </AppShell>
  );
}
