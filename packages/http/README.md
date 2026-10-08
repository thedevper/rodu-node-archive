# @shoal/http

Local JSON API behind the web board (`shoal web`). It is not a network service: it listens on
`127.0.0.1` only and every API call needs the per-run token.

## Security contract

| Check | Failure |
|---|---|
| `Host` is exactly `127.0.0.1:<port>` or `localhost:<port>` (blocks DNS rebinding) | `403 forbidden` |
| `/api/*` carries `Authorization: Bearer <token>`; token is 32 random bytes per run, compared in constant time | `401 unauthorized` |
| `POST`/`PATCH` bodies are `Content-Type: application/json` | `415 invalid` |
| Body at most 1 MB | `413 too_large` |
| Static files resolve inside the UI build directory only | `404 not_found` |

A cross-site page cannot set `Authorization` or a JSON content type without a CORS preflight, and
the server sends no CORS headers, so it cannot call the API. The token is handed to the browser in
the URL fragment (never sent to the server or in `Referer`) and kept in `sessionStorage`.
Every response carries a strict CSP, `Referrer-Policy: no-referrer` and `nosniff`.

The token is only valid while that `shoal web` run is up. The first URL (with `#token=`) can still
sit in terminal scrollback and the browser's history even though the page strips it from the
address bar, so treat the link like a short-lived password and stop the server when you are done.

## Errors

Every error is JSON `{ "code": string, "message": string, "hint": string | null }`.

| Domain code | HTTP |
|---|---|
| `invalid`, `limit` | 400 |
| `not_found` | 404 |
| `conflict` | 409 (stale `expectedVersion`, neighbours moved) |
| `rule_violation` | 422 (workflow refused; `hint` says how to fix it) |
| anything unexpected | 500 `internal`, no details |

## Endpoints

`ItemView` = `{ key, title, body, type, status, category, priority, assignee, estimate, due, rank, version }`
(`assignee` is a principal name or null).

| Method and path | Body | Success |
|---|---|---|
| `GET /api/me` | | `200 { name }` |
| `GET /api/collections` | | `200 [{ key, name, states: [{ name, category }] }]` |
| `GET /api/principals` | | `200 [{ name, kind }]` |
| `GET /api/board?collection=KEY&q=JQL` | | `200 { collection, items: ItemView[], total }`, items in rank order; `q` is a JQL-lite filter without `ORDER BY`, scoped to the collection; at most 1000 items |
| `POST /api/items` | `{ collection, item: { title, type?, priority?, assignee?, ... } }` | `201 ItemView` |
| `GET /api/items/:key` | | `200 { item: ItemView, comments: [{ id, author, via, body, createdAt }] }` |
| `PATCH /api/items/:key` | `{ patch: { title?, body?, priority?, assignee?, ... }, expectedVersion? }` | `200 ItemView` |
| `POST /api/items/:key/transition` | `{ to: status, after?: key, before?: key }` | `200 ItemView`; with `after`/`before` the status change and the position are applied in one transaction |
| `POST /api/items/:key/move` | `{ after?: key, before?: key }` | `200 ItemView` |
| `POST /api/items/:key/comments` | `{ body }` | `201 comment` |

All writes run as the workspace's human principal and are audited like CLI and MCP changes.
