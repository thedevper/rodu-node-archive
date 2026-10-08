# Rodu

Local-first, AI-first work tracking: kanban, sprints and (soon) docs for small teams.
Your data lives on your machine; teams sync through transports they own. Agents are first-class
users through MCP.

> Status: v0. Single-user, local SQLite; CLI, MCP over stdio and a local web board. Sync and docs come later.

## Install

One self-contained `rodu` binary (Node, SQLite and the web board inside); nothing else to install.

| | |
|---|---|
| macOS (Homebrew) | `brew install TheDevper/tap/rodu` |
| macOS (no Homebrew) | `curl -fsSL https://raw.githubusercontent.com/TheDevper/rodu/v0.2.0/packaging/install.sh \| sh` |
| Windows (Scoop) | `scoop bucket add thedevper https://github.com/TheDevper/scoop-bucket` then `scoop install rodu` |
| Windows (PowerShell) | `irm https://raw.githubusercontent.com/TheDevper/rodu/v0.2.0/packaging/install.ps1 \| iex` |

**Upgrading from Shoal:** Rodu was called Shoal until 0.2.0.

1. Stop any running `shoal web` and any agent running `shoal mcp`.
2. Install Rodu. Homebrew 7 trusts tap formulae one by one, so trust the renamed formula once,
   then upgrade: `brew update && brew trust --formula thedevper/tap/rodu && brew upgrade`. With
   Scoop: `scoop uninstall shoal`, then `scoop install rodu`.
3. In each workspace, rename the folder `.shoal` to `.rodu`, and inside it `shoal.db` to
   `rodu.db`, plus `shoal.db-wal` and `shoal.db-shm` (if present, they hold recent changes) to
   `rodu.db-wal` and `rodu.db-shm`. `rodu` points at any workspace you missed.
4. In your agents' MCP config, change the command `shoal mcp` to `rodu mcp` and `SHOAL_DIR` to
   `RODU_DIR`.

The script URLs name a release tag, so they run that release's reviewed script; each release
updates them. Then, in any folder you want to track work in:

```sh
rodu init --name your-name --key DEMO --title "Demo project"
rodu web        # opens the board in your browser
```

Builds exist for macOS (Apple silicon and Intel) and Windows x64, which also runs on Windows on
ARM. The binaries are not signed by a paid certificate: installs through Homebrew, Scoop or the
scripts above run without a prompt, but a binary downloaded through a browser gets a Gatekeeper or
SmartScreen warning.

## Quick start (from source)

Requires Node 24+ (runs TypeScript directly, no build step) and pnpm.

```sh
pnpm install
pnpm rodu init --name your-name --key DEMO --title "Demo project"
pnpm rodu add Fix login crash --type bug --priority urgent --assignee me
pnpm rodu ls "assignee = me() ORDER BY priority"
pnpm rodu show DEMO-1
pnpm rodu mv DEMO-1 "In Progress"
```

`init` creates `.rodu/` (database and `config.json`) in the current directory. Commands use the
nearest `.rodu/` above the working directory, or `$RODU_DIR`.

## Web board

```sh
pnpm build:web          # once, and after UI changes
pnpm rodu web          # prints http://127.0.0.1:4870/#token=...
```

Open the printed link. Drag cards between columns to change status (workflow rules apply and
refusals show how to fix them), drag within a column to reorder, filter with JQL-lite, and click a
card to edit it or comment. The server listens on `127.0.0.1` only and every API call needs the
per-run token; see [`packages/http`](packages/http/README.md) for the API and security contract.

## Use it from an agent (MCP)

Add Rodu to Claude Code, from the directory that holds `.rodu/`:

```sh
claude mcp add rodu -- node /path/to/rodu/apps/cli/src/main.ts mcp
```

Tools: `search`, `get_my_work`, `get_context`, `create_items`, `update_item`, `transition`,
`comment`, `link`, `list_collections`, `cycle_report`, `plan_cycle`; resource `rodu://schema`.
Every change an agent makes is recorded as "owner via agent". Workflow rules are enforced in the
domain, and refusals carry a hint the agent can act on.

Only run `rodu mcp` against a workspace you trust: it serves whatever `.rodu/` it finds.

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
| `packages/core` | Domain model, workflow rules, `RoduService`, `Store` interface |
| `packages/query` | JQL-lite parser and SQL compiler |
| `packages/store-sqlite` | Local store on `node:sqlite` with FTS5 |
| `packages/mcp` | MCP server |
| `packages/http` | Local JSON API for the web board |
| `apps/web` | React kanban board (Vite) |
| `apps/cli` | `rodu` command |

## Releasing

```sh
pnpm build:binaries   # dist/release: archives, SHA256SUMS, rodu.rb, rodu.json, install scripts
pnpm smoke:binary     # drives the binary built for this machine
```

`build:binaries` downloads the official Node build for each target (checked against nodejs.org's
SHASUMS256.txt) and must run on a Mac, which signs the macOS binaries. CI
(`.github/workflows/ci.yml`) tests on macOS and Windows, builds the binaries, installs each one
with the user-facing script on its own OS and smoke-tests it. Pushing a `vX.Y.Z` tag (matching
`apps/cli/package.json` and `apps/cli/src/version.ts`) publishes a GitHub release. Then copy
`rodu.rb` to the `TheDevper/homebrew-tap` repository (`Formula/rodu.rb`) and `rodu.json` to
`TheDevper/scoop-bucket` (`bucket/rodu.json`). The tap keeps `formula_renames.json` mapping
`shoal` to `rodu` (added with 0.2.0, when `Formula/shoal.rb` was removed), so `brew upgrade` moves
Shoal installs over.

## Development

```sh
pnpm typecheck && pnpm lint && pnpm test
pnpm test:e2e     # builds the board and drives it in your installed Chrome
```

## Contributing

Every commit needs a `Signed-off-by` line (`git commit -s`): see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache License 2.0](LICENSE). Copyright 2026 TheDevper. The license does not grant use of the
Rodu name. The release archives also carry `THIRD-PARTY-NOTICES.txt` for Node.js and the npm
packages built into the binary.
