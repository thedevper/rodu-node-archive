# ADR 0001: CRDT library for team sync

- Status: proposed (spike done 2026-10-09; not implemented)
- Spike code: [`spikes/crdt`](../../spikes/crdt) (`pnpm install --ignore-workspace && node bench.ts`)

## Context

Rodu is single-user today: each person's `.rodu/rodu.db` is their own board. To replace a hosted
tracker for a team, replicas must merge without a central server Rodu runs. The constraints that
decide the library:

1. **Transports the team owns.** A self-hosted relay, a Git remote, S3, a synced folder or the
   LAN. The library must export and import plain bytes, with no protocol of its own.
2. **A synchronous `Store`.** `packages/core/src/store.ts` is synchronous by design; every
   implementation keeps an in-process replica.
3. **One binary.** Rodu ships as a Node SEA executable bundled with esbuild, for macOS and Windows.
   No native addons, and no files read from beside the binary at runtime.
4. **A CLI that starts per command.** `rodu add` loads the workspace every time, so cold-load time
   matters as much as throughput.

## Options measured

Same scenarios and data for each library, on an Apple silicon Mac with Node 26.11.0.

| | Yjs 13.6.33 | Loro 1.16.4 | Automerge 3.5.0 | Jazz 0.20.19 |
|---|---|---|---|---|
| All 7 merge scenarios converge | yes | yes | yes | not run |
| Runs as a SEA binary | yes, pure JS | yes, via `loro-crdt/base64` (+4.8 MB) | yes, via `slim` + base64 WASM (+4.8 MB, async init) | no: native `better-sqlite3` and NAPI crypto, no Windows build |
| Sync over plain bytes (shared folder) | yes | yes | yes | no: needs a Jazz sync server |
| Create 20k cards | 153 ms | 666 ms | ~17 s (est. from 1.7 s per 2k) | |
| Cold load, 20k cards | 218 ms | 9 ms (lazy) | ~2 s (est. from 206 ms per 2k) | |
| Read every card after cold load | 12 ms | 206 ms with `toJSON` | | |
| Snapshot, 20k cards | 4.2 MB | 3.1 MB | 1.0 MB (est.) | |
| One field edit on the wire | 321 B | 98 B | 155 B | |
| Process RSS, 20k cards (2 replicas) | 316 MB | 259 MB | | |
| Native moves and trees | no | `MovableList`, `Tree` | no | |
| Trims old history | GC of deleted content | shallow snapshots | no, keeps everything | |
| Maturity | since 2015, largest ecosystem | 1.0 in 2024, Rust core | since 2017 | 2.0 rewrite in alpha |

Jazz was assessed from its documentation only. It needs a sync server, its Node path uses
native modules without a Windows build, and its 2.0 alphas change storage and wire formats
between releases. Automerge is correct but roughly 50 times slower than Yjs on writes, which a
board with years of cards will feel.

## What no library solves for us

These showed up identically in all three libraries, so they are Rodu design work:

- **Card numbers collide.** Two people offline both create the next card, and both get `DEMO-13`.
  The library merges both cards correctly but cannot know that numbers are meant to be unique.
- **Delete beats a concurrent edit.** Removing a map entry discards an edit made at the same time.
  Rodu should never hard-delete a card; archive it with a field instead.
- **Workflow rules can break after a merge.** A moves a card to In Progress, which requires an
  assignee, while B unassigns it. Each write was valid locally, but the merge is not. Merged
  writes cannot be rejected, only reported.
- **The same field written twice keeps one value.** Both libraries pick a winner by peer order,
  not by time. That is fine for status and assignee if the event log records the other write.
- **Ranks can tie.** Two cards can end up with the same rank string. Ordering by `(rank, id)`
  already makes the order deterministic.
- **No access control.** Anyone who can write to the transport can write anything. That is
  acceptable for a small trusted team. Signing updates per principal is later hardening.

## Decision (proposed)

**Use Loro**, behind the existing `Store` interface, with SQLite kept as a derived index for
queries. Yjs is the fallback if Loro's WASM causes trouble in practice.

Why Loro over Yjs:

- **Fast cold load.** It loads lazily in single-digit milliseconds at 20k cards, where Yjs takes
  over 200 ms. That cost is paid on every CLI command and every `rodu mcp` start.
- **Smaller updates.** One edit on the wire is a third of Yjs's size, which matters for Git and S3
  transports that keep every file.
- **`Tree` and `MovableList` fit the data.** They match subtasks and card order, and shallow
  snapshots keep a long-lived board from growing forever.

What we give up: Yjs's maturity and ecosystem, pure-JS simplicity, and 4.8 MB of binary size. Loro
is also slower at a full read (about 200 ms for 20k cards). The SQLite index should be updated
from Loro's change events, not rebuilt by reading everything.

## Proposed design for the open problems

1. **Card numbers (decided 2026-10-09: provisional keys).** A new card gets a provisional key
   built from its id, such as `DEMO-~a3f9`, and keeps it until it is numbered. Exactly one peer per
   workspace, the *numbering peer*, gives out real numbers: when it imports a provisional card, it
   assigns the next number and writes it to the card. Two peers numbering at once would collide
   again without a server, so no other peer ever numbers. The numbering peer is the one that ran
   `init`. A command can hand the role to another peer if that machine is gone for good. A real
   number never changes once given, and the provisional key keeps resolving to the card as an
   alias, so links written before the sync still work. Rejected: renumbering the later card after
   a merge, because then a key someone has already shared can point to another card.
2. **Deletes** become `archivedAt`. Nothing is removed from the document.
3. **Rules** are checked locally at write time, as today. After every import, re-check the
   touched cards, and show any that now break a rule in a "needs attention" view. Never undo
   merged writes silently.
4. **`expectedVersion`** stays a local optimistic check on this replica. It no longer means a
   global version.
5. **Transport layout.** Each peer appends update files under
   `sync/<peer-id>/<sequence>.loro`, and a periodic compaction writes a shallow snapshot. The same
   folder works in Git, S3 or a synced drive. A relay can come later as a faster path for the same
   files.
6. **Identity.** Each person's replica has its own Loro peer id, and agents write through their
   owner's replica, as `viaAgentId` does today.

## Next steps

1. Design provisional keys and the numbering peer in the core model. This includes the alias
   lookup and the hand-over command. It also covers a single-user workspace, where the numbering
   peer is the only peer and every card is numbered immediately, as today.
2. Build `store-loro` implementing `Store`, keeping the SQLite index in sync from Loro events, and
   run the existing service tests against it.
3. Add a `rodu sync <folder>` command for the shared-folder transport, and test it with two
   workspaces in CI on macOS and Windows.
