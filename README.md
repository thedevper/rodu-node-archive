# Shoal

Local-first, AI-first work tracking: kanban, sprints and (soon) docs for small teams.
Your data lives on your machine; teams sync through transports they own. Agents are first-class
users through MCP.

> Status: v0. Single-user, local SQLite; CLI, MCP over stdio and a local web board. Sync and docs come later.

## Install

One self-contained `shoal` binary (Node, SQLite and the web board inside); nothing else to install.

| | |
|---|---|
| macOS (Homebrew) | `brew install TheDevper/tap/shoal` |
| macOS (no Homebrew) | `curl -fsSL https://raw.githubusercontent.com/TheDevper/shoal/v0.1.0/packaging/install.sh \| sh` |
| Windows (Scoop) | `scoop bucket add thedevper https://github.com/TheDevper/scoop-bucket` then `scoop install shoal` |
| Windows (PowerShell) | `irm https://raw.githubusercontent.com/TheDevper/shoal/v0.1.0/packaging/install.ps1 \| iex` |

The script URLs name a release tag, so they run that release's reviewed script; each release
updates them. Then, in any folder you want to track work in:

```sh
shoal init --name alice --key MED --title "Medical app"
shoal web        # opens the board in your browser
```

Builds exist for macOS (Apple silicon and Intel) and Windows x64, which also runs on Windows on
ARM. The binaries are not signed by a paid certificate: installs through Homebrew, Scoop or the
scripts above run without a prompt, but a binary downloaded through a browser gets a Gatekeeper or
SmartScreen warning.

## Quick start (from source)

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

## Releasing

```sh
pnpm build:binaries   # dist/release: archives, SHA256SUMS, shoal.rb, shoal.json, install scripts
pnpm smoke:binary     # drives the binary built for this machine
```

`build:binaries` downloads the official Node build for each target (checked against nodejs.org's
SHASUMS256.txt) and must run on a Mac, which signs the macOS binaries. CI
(`.github/workflows/ci.yml`) tests on macOS and Windows, builds the binaries, installs each one
with the user-facing script on its own OS and smoke-tests it. Pushing a `vX.Y.Z` tag (matching
`apps/cli/package.json` and `apps/cli/src/version.ts`) publishes a GitHub release. Then copy
`shoal.rb` to the `TheDevper/homebrew-tap` repository (`Formula/shoal.rb`) and `shoal.json` to
`TheDevper/scoop-bucket` (`bucket/shoal.json`).

## Development

```sh
pnpm typecheck && pnpm lint && pnpm test
pnpm test:e2e     # builds the board and drives it in your installed Chrome
```

## License

To be decided before the first public release.
