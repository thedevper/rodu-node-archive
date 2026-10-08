// Client for the local API (packages/http). Types mirror its README contract.

export type Category = "backlog" | "active" | "review" | "done";
export type Priority = "none" | "urgent" | "high" | "normal" | "low";
export type ItemType = "epic" | "story" | "task" | "bug" | "subtask";

export interface ItemView {
  key: string;
  title: string;
  body: string;
  type: ItemType;
  status: string;
  category: Category;
  priority: Priority;
  assignee: string | null;
  estimate: number | null;
  due: string | null;
  rank: string;
  version: number;
}

export interface State {
  name: string;
  category: Category;
}

export interface CollectionView {
  key: string;
  name: string;
  states: State[];
}

export interface CommentView {
  id: string;
  author: string;
  via: string | null;
  body: string;
  createdAt: string;
}

export interface BoardView {
  collection: CollectionView;
  items: ItemView[];
  total: number;
}

export interface PrincipalView {
  name: string;
  kind: "human" | "agent";
}

export const PRIORITIES: Priority[] = ["urgent", "high", "normal", "low", "none"];
export const ITEM_TYPES: ItemType[] = ["task", "bug", "story", "epic", "subtask"];

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | null;

  constructor(status: number, code: string, message: string, hint: string | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

const TOKEN_KEY = "shoal.token";

/**
 * `shoal web` opens the page with `#token=...`. The fragment never reaches the server; move it
 * into sessionStorage and strip it from the address bar so it is not bookmarked or shared.
 */
export function takeToken(): string | null {
  const match = /(?:^#|&)token=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (match?.[1]) {
    try {
      sessionStorage.setItem(TOKEN_KEY, match[1]);
    } catch {
      // Storage can be unavailable; keep the token in memory for this page only.
    }
    history.replaceState(null, "", window.location.pathname + window.location.search);
    return match[1];
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function createApi(token: string) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as
      | (T & { code?: string; message?: string; hint?: string | null })
      | null;
    if (!res.ok) {
      throw new ApiError(
        res.status,
        data?.code ?? "error",
        data?.message ?? `Request failed (${res.status})`,
        data?.hint ?? null,
      );
    }
    return data as T;
  }

  const item = (key: string) => `/api/items/${encodeURIComponent(key)}`;

  return {
    me: () => call<{ name: string }>("GET", "/api/me"),
    collections: () => call<CollectionView[]>("GET", "/api/collections"),
    principals: () => call<PrincipalView[]>("GET", "/api/principals"),
    board: (collection: string, q: string) =>
      call<BoardView>(
        "GET",
        `/api/board?collection=${encodeURIComponent(collection)}&q=${encodeURIComponent(q)}`,
      ),
    create: (collection: string, fields: { title: string; type?: ItemType }) =>
      call<ItemView>("POST", "/api/items", { collection, item: fields }),
    item: (key: string) => call<{ item: ItemView; comments: CommentView[] }>("GET", item(key)),
    update: (key: string, patch: Record<string, unknown>, expectedVersion: number) =>
      call<ItemView>("PATCH", item(key), { patch, expectedVersion }),
    transition: (
      key: string,
      to: string,
      position: { after: string | null; before: string | null } | null = null,
    ) => call<ItemView>("POST", `${item(key)}/transition`, { to, ...position }),
    move: (key: string, to: { after: string | null; before: string | null }) =>
      call<ItemView>("POST", `${item(key)}/move`, to),
    comment: (key: string, body: string) =>
      call<CommentView>("POST", `${item(key)}/comments`, { body }),
  };
}

export type Api = ReturnType<typeof createApi>;
