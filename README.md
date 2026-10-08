# Shoal

Local-first, AI-first work tracking: kanban, sprints and (soon) docs for small teams.
Your data lives on your machine; teams sync through transports they own. Agents are first-class
users through MCP.

> Status: v0. Single-user, local SQLite; CLI, MCP over stdio and a local web board. Sync and docs come later.

## Quick start

Requires Node 24+ (runs TypeScript directly, no build step) and pnpm.

```sh
pnpm install
pnpm shoal init --name alice --key MED --title "Medical app"
pnpm shoal add Fix login crash --type bug --priority urgent --assignee me
pnpm shoal ls "assignee = me() ORDER BY priority"
pnpm shoal show MED-1
pnpm shoal mv MED-1 "In Progress"
```

`init` creates `.shoal/` (database and `config.json`) in the current directory. Commands use the
nearest `.shoal/` above the working directory, or `$SHOAL_DIR`.

## Web board

```sh
pnpm build:web          # once, and after UI changes
pnpm shoal web          # prints http://127.0.0.1:4870/#token=...
```

Open the printed link. Drag cards between columns to change status (workflow rules apply and
refusals show how to fix them), drag within a column to reorder, filter with JQL-lite, and click a
card to edit it or comment. The server listens on `127.0.0.1` only and every API call needs the
per-run token; see [`packages/http`](packages/http/README.md) for the API and security contract.

## Use it from an agent (MCP)

Add Shoal to Claude Code, from the directory that holds `.shoal/`:

```sh
claude mcp add shoal -- node /path/to/shoal/apps/cli/src/main.ts mcp
```

Tools: `search`, `get_my_work`, `get_context`, `create_items`, `update_item`, `transition`,
`comment`, `link`, `list_collections`, `cycle_report`, `plan_cycle`; resource `shoal://schema`.
Every change an agent makes is recorded as "owner via agent". Workflow rules are enforced in the
domain, and refusals carry a hint the agent can act on.

Only run `shoal mcp` against a workspace you trust: it serves whatever `.shoal/` it finds.

## Query language (JQL-lite)

```
assignee = me() AND category != done AND updated > -7d ORDER BY priority
text ~ "login" AND type IN (bug, story)
cycle = currentCycle() AND assignee IS EMPTY
```

Fields: key, title, body, text, type, status, category, priority, estimate, assignee,
collection, cycle, parent, created, updated, due.

## Layout

| Package | Role |
|---|---|
| `packages/core` | Domain model, workflow rules, `ShoalService`, `Store` interface |
| `packages/query` | JQL-lite parser and SQL compiler |
| `packages/store-sqlite` | Local store on `node:sqlite` with FTS5 |
| `packages/mcp` | MCP server |
| `packages/http` | Local JSON API for the web board |
| `apps/web` | React kanban board (Vite) |
| `apps/cli` | `shoal` command |

## Development

```sh
pnpm typecheck && pnpm lint && pnpm test
pnpm test:e2e     # builds the board and drives it in your installed Chrome
```

## License

To be decided before the first public release.
