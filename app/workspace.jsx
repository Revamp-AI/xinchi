'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import AppShell from '@/components/focus/app-shell';
import AgentView from '@/components/focus/agent-view';
import BoardView from '@/components/focus/board-view';
import LibraryView from '@/components/focus/library-view';
import ContactsView from '@/components/focus/contacts-view';
import ConnectionsView from '@/components/focus/connections-view';
import ReviewSettingsView from '@/components/focus/review-settings-view';
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
    [busy, setBusy] = useState(false),
    [connectionLost, setConnectionLost] = useState(false);
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
    setConnectionLost(false);
    return next;
  };
  useEffect(() => {
    const fromHash = () => {
      const requested = window.location.hash.slice(1);
      if (
        [
          'agent',
          'board',
          'contacts',
          'library',
          'connections',
          'settings',
        ].includes(requested)
      )
        setView(requested);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);
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
          if (mounted) {
            setState(next);
            setConnectionLost(false);
          }
        })
        .catch(() => {
          if (mounted) setConnectionLost(true);
        });
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
      return true;
    } catch (error) {
      setError(error.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const openSource = async (id, quote = '', version = '') => {
    setError('');
    try {
      const record = await api(
        'sources/' +
          encodeURIComponent(id) +
          (version ? '?version=' + encodeURIComponent(version) : ''),
      );
      setSource({ ...record, quote });
    } catch (error) {
      setError(error.message);
    }
  };
  const navigate = (next, nextTab) => {
    window.history.replaceState(null, '', '#' + next);
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
    setEditing({ ...item, owner: item.owner || state?.user?.name || 'You' });
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
      source_version_id: proposal.payload.citations[0].source_version_id,
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
      if (state?.worker?.mode !== 'cloud') {
        const text = await file.text();
        const result = await api(
          'import',
          file.name.toLowerCase().endsWith('.json')
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
        return;
      }
      if (!file.size || file.size > 64 * 1024 * 1024) {
        throw Error('Choose a non-empty file of up to 64 MiB.');
      }
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(
          await file.arrayBuffer(),
        );
      } catch {
        throw Error('Choose a valid UTF-8 text or JSON file.');
      }
      let id;
      try {
        ({ id } = await api('imports/start', {
          format: file.name.toLowerCase().endsWith('.json') ? 'json' : 'text',
          title: file.name,
          bytes: new TextEncoder().encode(text).length,
        }));
        setView('connections');
        setNotice(
          'Uploading file. Keep this tab open until the upload finishes.',
        );
        await refresh();
        let part = 0;
        for (let offset = 0; offset < text.length; part++) {
          let end = Math.min(offset + 128 * 1024, text.length);
          // Keep surrogate pairs together so every part has the same UTF-8 bytes.
          if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
          await api('imports/chunk', {
            id,
            part,
            content: text.slice(offset, end),
          });
          offset = end;
          setNotice(
            `Uploading file: ${Math.floor((offset / text.length) * 100)}%.`,
          );
        }
        await api('imports/finish', { id, parts: part });
        setNotice(
          'File uploaded. Import queued; progress appears in Connections. You can close this tab.',
        );
        setQ('');
        setProvider('');
        setOffset(0);
      } catch (error) {
        if (id) await api('imports/cancel', { id }).catch(() => {});
        setNotice('');
        throw error;
      }
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
    <AppShell
      {...{ view, state, busy, onLogout, connectionLost }}
      onViewChange={navigate}
    >
      {connectionLost && (
        <Notice error>
          Connection interrupted. Showing the last loaded data; saving changes
          needs a connection.
        </Notice>
      )}
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
            openSource,
            selectProposal,
          }}
          dismiss={(id) => act(() => api('proposals/dismiss', { id }))}
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
      {view === 'contacts' && (
        <ContactsView
          api={api}
          openSource={openSource}
          onReview={start}
          onCommitment={edit}
          items={state.items}
        />
      )}
      {view === 'settings' && <ReviewSettingsView api={api} />}
      {view === 'connections' && (
        <ConnectionsView
          {...{ state, busy, api, refresh }}
          configure={(provider) => {
            setError('');
            setSetup(provider);
          }}
          sync={(provider, retry_id) =>
            act(async () => {
              await api('sync', { provider, retry_id });
              setNotice('Import started. Progress appears below.');
            })
          }
          cancelUpload={(id) =>
            act(async () => {
              await api('imports/cancel', { id });
              setNotice('Upload cancelled. You can choose another file.');
            })
          }
        />
      )}
      {editing && (
        <CommitmentDialog
          item={editing}
          setItem={setEditing}
          {...{ now, busy, error, openSource }}
          api={api}
          self={state.user?.name}
          owners={state.items.map((item) => item.owner)}
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
