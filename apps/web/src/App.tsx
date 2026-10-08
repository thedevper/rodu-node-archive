import {
  type DragEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type Api,
  ApiError,
  type BoardView,
  type CollectionView,
  createApi,
  type ItemView,
  type PrincipalView,
  type State,
  takeToken,
} from "./api.ts";
import { dropNeighbours, groupByState, insertionIndex } from "./board.ts";
import { ItemPanel } from "./ItemPanel.tsx";

export interface Notice {
  message: string;
  hint: string | null;
}

const LAST_COLLECTION = "rodu.collection";

export function toNotice(error: unknown): Notice {
  if (error instanceof ApiError) return { message: error.message, hint: error.hint };
  return { message: error instanceof Error ? error.message : String(error), hint: null };
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Remembering the last collection is a convenience only.
  }
}

function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function App() {
  const [token] = useState(takeToken);
  const api = useMemo(() => (token ? createApi(token) : null), [token]);

  if (!api) {
    return (
      <main className="empty-state">
        <h1>Rodu</h1>
        <p>
          Open the link printed by <code>rodu web</code>. It carries a one-time key for this browser
          tab.
        </p>
      </main>
    );
  }
  return <Workspace api={api} />;
}

function Workspace({ api }: { api: Api }) {
  const [collections, setCollections] = useState<CollectionView[]>([]);
  const [collectionKey, setCollectionKey] = useState<string | null>(null);
  const [principals, setPrincipals] = useState<PrincipalView[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardView | null>(null);
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const [filterError, setFilterError] = useState<Notice | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.collections(), api.principals(), api.me()])
      .then(([cols, people, self]) => {
        setCollections(cols);
        setPrincipals(people);
        setMe(self.name);
        const last = recall(LAST_COLLECTION);
        setCollectionKey(cols.find((c) => c.key === last)?.key ?? cols[0]?.key ?? null);
      })
      .catch((e) => setNotice(toNotice(e)));
  }, [api]);

  // Stable, so ItemPanel's load effect does not re-run (and loop on failure) on every render.
  const reportError = useCallback((e: unknown) => setNotice(toNotice(e)), []);

  // Only the newest board request may update the screen; an older, slower one is dropped.
  const latestBoard = useRef(0);
  const reload = useCallback(async () => {
    if (!collectionKey) return;
    const request = ++latestBoard.current;
    try {
      const next = await api.board(collectionKey, applied);
      if (request !== latestBoard.current) return;
      setBoard(next);
      setFilterError(null);
    } catch (e) {
      if (request !== latestBoard.current) return;
      if (applied && e instanceof ApiError && e.status === 400) setFilterError(toNotice(e));
      else setNotice(toNotice(e));
    }
  }, [api, collectionKey, applied]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (e) {
        setNotice(toNotice(e));
      }
      await reload();
    },
    [reload],
  );

  function chooseCollection(key: string) {
    remember(LAST_COLLECTION, key);
    setCollectionKey(key);
    setSelected(null);
  }

  function applyFilter(event: FormEvent) {
    event.preventDefault();
    setApplied(filter.trim());
  }

  const columns = board ? groupByState(board.collection.states, board.items) : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          Rodu
        </div>
        <select
          aria-label="Collection"
          value={collectionKey ?? ""}
          onChange={(e) => chooseCollection(e.target.value)}
        >
          {collections.map((c) => (
            <option key={c.key} value={c.key}>
              {c.key} · {c.name}
            </option>
          ))}
        </select>
        <form className="filter" onSubmit={applyFilter}>
          <input
            aria-label="Filter"
            placeholder="Filter, e.g. assignee = me() AND priority IN (urgent, high)"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            spellCheck={false}
          />
          {applied && (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setFilter("");
                setApplied("");
              }}
            >
              Clear
            </button>
          )}
        </form>
        <span className="me">{me}</span>
      </header>

      {filterError && (
        <div className="filter-error" role="alert">
          <strong>{filterError.message}</strong>
          {filterError.hint && <pre>{filterError.hint}</pre>}
        </div>
      )}

      {notice && (
        <div className="notice" role="alert">
          <div>
            <strong>{notice.message}</strong>
            {notice.hint && <p>{notice.hint}</p>}
          </div>
          <button
            type="button"
            className="ghost"
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <main className="board">
        {board && columns ? (
          board.collection.states.map((state) => (
            <Column
              key={state.name}
              state={state}
              initial={board.collection.states[0]?.name ?? ""}
              items={columns.get(state.name) ?? []}
              onOpen={setSelected}
              onDrop={(key, index) => {
                // Only cards on this board can be dropped; anything else is ignored.
                const dragged = board.items.find((i) => i.key === key);
                if (!dragged) return;
                const target = dropNeighbours(columns.get(state.name) ?? [], key, index);
                void run(async () => {
                  if (dragged.status.toLowerCase() !== state.name.toLowerCase()) {
                    // Status and position change together on the server, or not at all.
                    await api.transition(key, state.name, target);
                  } else if (target) {
                    await api.move(key, target);
                  }
                });
              }}
              onCreate={(title) =>
                // One request: if the workflow refuses this column, no card is created.
                run(() => api.create(board.collection.key, { title }, state.name))
              }
            />
          ))
        ) : (
          <p className="loading">{collections.length === 0 && !notice ? "Loading…" : ""}</p>
        )}
      </main>

      {board && board.total > board.items.length && (
        <p className="truncated">
          Showing {board.items.length} of {board.total} items. Narrow the filter to see the rest.
        </p>
      )}

      {selected && board && (
        <ItemPanel
          api={api}
          itemKey={selected}
          states={board.collection.states}
          principals={principals}
          onClose={() => setSelected(null)}
          onChanged={reload}
          onError={reportError}
        />
      )}
    </div>
  );
}

interface ColumnProps {
  state: State;
  initial: string;
  items: ItemView[];
  onOpen: (key: string) => void;
  onDrop: (key: string, index: number) => void;
  onCreate: (title: string) => void;
}

const DRAG_TYPE = "application/x-rodu-item";

function Column({ state, items, onOpen, onDrop, onCreate }: ColumnProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");

  function indexAt(event: DragEvent): number {
    const cards = listRef.current?.querySelectorAll<HTMLElement>("[data-card]") ?? [];
    const mids = [...cards].map((c) => {
      const box = c.getBoundingClientRect();
      return box.top + box.height / 2;
    });
    return insertionIndex(mids, event.clientY);
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    const raw = event.dataTransfer.getData(DRAG_TYPE);
    setDropIndex(null);
    let key: unknown;
    try {
      key = (JSON.parse(raw) as { key?: unknown }).key;
    } catch {
      return;
    }
    if (typeof key !== "string") return;
    let index = indexAt(event);
    // Within a column the dragged card is still in the list; count positions without it.
    const current = items.findIndex((i) => i.key === key);
    if (current !== -1 && current < index) index -= 1;
    onDrop(key, index);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = title.trim();
    if (text) onCreate(text);
    setTitle("");
    setAdding(false);
  }

  return (
    <section
      className={`column cat-${state.category}`}
      aria-label={state.name}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropIndex(indexAt(e));
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropIndex(null);
      }}
      onDrop={handleDrop}
    >
      <header className="column-head">
        <span className="dot" aria-hidden="true" />
        <h2>{state.name}</h2>
        <span className="count">{items.length}</span>
        <button
          type="button"
          className="ghost add"
          aria-label={`Add item to ${state.name}`}
          onClick={() => setAdding(true)}
        >
          +
        </button>
      </header>
      <ol ref={listRef} className="cards">
        {items.map((item, i) => (
          <li key={item.key} className={dropIndex === i ? "drop-before" : undefined}>
            <Card item={item} onOpen={onOpen} />
          </li>
        ))}
        {dropIndex !== null && dropIndex >= items.length && <li className="drop-end" />}
      </ol>
      {adding && (
        <form className="new-card" onSubmit={submit}>
          <input
            // biome-ignore lint/a11y/noAutofocus: the field appears because the user asked to add a card
            autoFocus
            aria-label="New item title"
            placeholder="Title, then Enter"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setAdding(false);
            }}
            onBlur={() => {
              if (!title.trim()) setAdding(false);
            }}
          />
        </form>
      )}
    </section>
  );
}

function initials(name: string): string {
  return name
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

function Card({ item, onOpen }: { item: ItemView; onOpen: (key: string) => void }) {
  return (
    <button
      type="button"
      className="card"
      data-card={item.key}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ key: item.key }));
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => onOpen(item.key)}
    >
      <span className="card-top">
        <span className="key">{item.key}</span>
        {item.type !== "task" && <span className={`type type-${item.type}`}>{item.type}</span>}
        {item.priority !== "none" && (
          <span className={`priority p-${item.priority}`}>{item.priority}</span>
        )}
      </span>
      <span className="title">{item.title}</span>
      <span className="card-bottom">
        {item.estimate !== null && <span className="estimate">{item.estimate} pt</span>}
        {item.due && <span className="due">due {item.due}</span>}
        {item.assignee && (
          <span className="avatar" title={item.assignee}>
            {initials(item.assignee)}
          </span>
        )}
      </span>
    </button>
  );
}
