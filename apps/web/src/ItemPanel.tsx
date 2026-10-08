import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  type Api,
  type CommentView,
  ITEM_TYPES,
  type ItemView,
  PRIORITIES,
  type PrincipalView,
  type State,
} from "./api.ts";

interface Props {
  api: Api;
  itemKey: string;
  states: State[];
  principals: PrincipalView[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  onError: (error: unknown) => void;
}

/** Side panel to read and edit one item. All user text is rendered as plain text. */
export function ItemPanel({
  api,
  itemKey,
  states,
  principals,
  onClose,
  onChanged,
  onError,
}: Props) {
  const [item, setItem] = useState<ItemView | null>(null);
  const [comments, setComments] = useState<CommentView[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [comment, setComment] = useState("");

  const load = useCallback(async () => {
    try {
      const detail = await api.item(itemKey);
      setItem(detail.item);
      setComments(detail.comments);
      setTitle(detail.item.title);
      setBody(detail.item.body);
    } catch (e) {
      onError(e);
    }
  }, [api, itemKey, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function act(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (e) {
      onError(e);
    }
    await load();
    await onChanged();
  }

  if (!item) return <aside className="panel" aria-label="Item details" />;
  const current = item;

  const update = (patch: Record<string, unknown>) =>
    act(() => api.update(current.key, patch, current.version));

  function saveTitle() {
    const text = title.trim();
    if (text && text !== current.title) void update({ title: text });
    else setTitle(current.title);
  }

  function addComment(event: FormEvent) {
    event.preventDefault();
    const text = comment.trim();
    if (!text) return;
    setComment("");
    void act(() => api.comment(current.key, text));
  }

  return (
    <aside className="panel" aria-label={`${current.key} details`}>
      <header className="panel-head">
        <span className="key">{current.key}</span>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <input
        className="panel-title"
        aria-label="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={saveTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />

      <dl className="fields">
        <dt>Status</dt>
        <dd>
          <select
            aria-label="Status"
            value={
              states.find((s) => s.name.toLowerCase() === current.status.toLowerCase())?.name ?? ""
            }
            onChange={(e) => void act(() => api.transition(current.key, e.target.value))}
          >
            {!states.some((s) => s.name.toLowerCase() === current.status.toLowerCase()) && (
              <option value="" disabled>
                {current.status}
              </option>
            )}
            {states.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </dd>
        <dt>Assignee</dt>
        <dd>
          <select
            aria-label="Assignee"
            value={current.assignee ?? ""}
            onChange={(e) => void update({ assignee: e.target.value || null })}
          >
            <option value="">Unassigned</option>
            {principals.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.kind === "agent" ? " (agent)" : ""}
              </option>
            ))}
          </select>
        </dd>
        <dt>Priority</dt>
        <dd>
          <select
            aria-label="Priority"
            value={current.priority}
            onChange={(e) => void update({ priority: e.target.value })}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </dd>
        <dt>Type</dt>
        <dd>
          <select
            aria-label="Type"
            value={current.type}
            onChange={(e) => void update({ type: e.target.value })}
          >
            {ITEM_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </dd>
        <dt>Estimate</dt>
        <dd>
          <input
            type="number"
            min={0}
            aria-label="Estimate"
            defaultValue={current.estimate ?? ""}
            key={`estimate-${current.version}`}
            onBlur={(e) => {
              const value = e.target.value === "" ? null : Number(e.target.value);
              if (value !== current.estimate) void update({ estimate: value });
            }}
          />
        </dd>
      </dl>

      <section className="description">
        <h3>Description</h3>
        <textarea
          aria-label="Description"
          value={body}
          rows={8}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add details, acceptance criteria, links…"
        />
        {body !== current.body && (
          <div className="row">
            <button type="button" onClick={() => void update({ body })}>
              Save description
            </button>
            <button type="button" className="ghost" onClick={() => setBody(current.body)}>
              Discard
            </button>
          </div>
        )}
      </section>

      <section className="comments">
        <h3>Comments</h3>
        {comments.length === 0 && <p className="muted">No comments yet.</p>}
        <ol>
          {comments.map((c) => (
            <li key={c.id}>
              <div className="comment-meta">
                <strong>{c.author}</strong>
                {c.via && <span className="via">via {c.via}</span>}
                <time dateTime={c.createdAt}>{new Date(c.createdAt).toLocaleString()}</time>
              </div>
              <p className="comment-body">{c.body}</p>
            </li>
          ))}
        </ol>
        <form onSubmit={addComment}>
          <textarea
            aria-label="New comment"
            value={comment}
            rows={3}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Write a comment"
          />
          <button type="submit" disabled={!comment.trim()}>
            Comment
          </button>
        </form>
      </section>
    </aside>
  );
}
