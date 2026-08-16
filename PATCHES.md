# PATCHES

Local patches carried on top of upstream `getpaseo/paseo` (fork: `thomasvan/paseo`, branch `slp/patches`).

Every patch site in code is marked `SLP-PATCH(<name>)`. `rg "SLP-PATCH\("` lists all sites.
When syncing with upstream, merge `upstream/main` into this branch; if a hunk
conflicts, the marker plus this file is enough to re-apply the intent by hand.

Patches live in **three source files** — `packages/server/src/server/agent/agent-prompt.ts`,
one argument in `packages/server/src/server/agent/create-agent/create.ts`, and one schema
field in `packages/server/src/server/agent/tools/paseo-tools.ts`. Tests for the first two
are in `agent-prompt.slp.test.ts` and `create-agent/create.slp.test.ts`, files upstream does
not own. `detached-arg` is the exception: its behaviour only shows through a live MCP tool
call, so its two tests sit in upstream's `mcp-parity.e2e.test.ts` next to the legacy-shape
test they mirror. They carry no marker, so if upstream takes them the files converge instead
of conflicting.

## Why these patches exist

The SLP room repository — named `room-workflow` until 2026-08-10, now `airoom` — uses this checkout as its editable `paseo/` submodule.
Its Supervisor > Lead > Peers model runs long-lived agents as Paseo subagents. Upstream's
finish-notification behavior broke that model in five ways; all five are fixed here.

Two have landed upstream. Three are still in flight:

| PR                                                   | Patches                         | Touches           | Status             |
| ---------------------------------------------------- | ------------------------------- | ----------------- | ------------------ |
| [#3192](https://github.com/getpaseo/paseo/pull/3192) | `closed-wakeup`, `response-cap` | `agent-prompt.ts` | landed `cdb116314` |
| [#2879](https://github.com/getpaseo/paseo/pull/2879) | `wakeup-each`                   | `agent-prompt.ts` | in flight          |
| [#3094](https://github.com/getpaseo/paseo/pull/3094) | `detached-wakeup`               | `create.ts`       | in flight          |
| [#3147](https://github.com/getpaseo/paseo/pull/3147) | `detached-arg`                  | `paseo-tools.ts`  | in flight          |

#2879 carried three patches and upstream took two of them, as #3192. `wakeup-each` was left
behind — it is the one that changes default behavior for existing upstream callers. Delete
the two landed sections in the merge commit that brings #3192 in, not before: until that
merge, this branch still carries its own copies and they still need markers.

They share no files and can land in either order. When a patch lands upstream, the next
`upstream/main` sync brings it in: drop its `SLP-PATCH(` markers, delete its section below,
and keep the `.slp.test.ts` files only for whatever upstream did not take.

## Patches

### closed-wakeup

- **What:** `setupFinishNotification` now fires a `"was closed"` finish notification when
  a watched child agent is killed/closed before finishing. Upstream set `fired = true`
  and unsubscribed silently, so the calling agent (Supervisor/Lead) never woke up and
  waited forever on a dead delegation.
- **Upstream status:** landed — [getpaseo/paseo#3192](https://github.com/getpaseo/paseo/pull/3192), commit `cdb116314`. Upstream's `notifySafely("was closed")` is this patch. Delete this section and the local markers when the merge lands.

### response-cap

- **What:** the child's last assistant message embedded in a finish notification is
  truncated at `FINISH_NOTIFICATION_MESSAGE_LIMIT` (4000 chars) with a pointer to
  `get_agent_activity` for the full text. Prevents one verbose Peer from blowing out the
  caller's context window.
- **Upstream status:** landed — [getpaseo/paseo#3192](https://github.com/getpaseo/paseo/pull/3192), commit `cdb116314`. Upstream uses the same 4000-char limit and the same `get_agent_activity` pointer. Delete this section and the local markers when the merge lands.

### wakeup-each

- **What:** the finish watcher re-arms after every wakeup instead of unsubscribing after
  the first, so a caller keeps waking for every finish of a long-lived child across
  multiple prompts. It disarms only when the child closes (`"was closed"`) or the caller
  is archived. Watchers only ever exist for agent callers (`notifyOnFinish` +
  `callerAgentId`), so this is derived — no `notifyMode` parameter, no schema or
  plumbing changes in `create.ts` / `paseo-tools.ts`. An earlier revision threaded an
  opt-in `notifyMode: "once" | "each"` param through the tool schemas; that shape is the
  right artifact if upstream asks for this to be opt-in.
- **Re-applying after #3177:** upstream's permission-prompt fix ([#3177](https://github.com/getpaseo/paseo/pull/3177), commit `334bf6237`) rewrote this watcher and added a `terminal` option to `notifySafely` — permission notifications pass `terminal: false` to stay armed. `"finished"` still defaults to terminal, so upstream still unsubscribes after the first finish and this patch is still needed. Re-apply it onto the new shape rather than restoring the old diff: it collapses to passing `{ terminal: false }` on the `"finished"` path, with the disarm left on `"was closed"` and caller-archived. Expect the merge conflict here to be semantic, not textual.
- **Upstream status:** in flight — [getpaseo/paseo#2879](https://github.com/getpaseo/paseo/pull/2879) (branch `fix/finish-notification-closed-wakeup`, markers stripped). Upstream took the other two patches from this PR as #3192 and left this one, which changes default behavior for existing upstream callers.

### detached-wakeup

- **What:** `create.ts` passes `requireParentOwnership: !input.detached` instead of a
  hardcoded `true`. The guard asks the watcher to check, at fire time, whether the child
  is still labelled as the caller's. For a child created detached, `resolveCreateAgentIntent`
  strips that label on purpose (`intent.ts`, `legacyDetached` branch), so the guard can
  never pass and the caller is silenced permanently — even though it is the agent that
  asked for the child and set `notifyOnFinish`.
- **Why it matters here:** SLP Leads are spawned detached by design, so no Supervisor in
  the room ever got a Lead-finish wakeup. Measured in an end-to-end run: the Lead finished
  at 13:43:39Z and the Supervisor did not stir until 14:07:25.581Z — 23m46s of silence,
  ended by an unrelated heartbeat sweep rather than by the notification (the room-workflow
  repository's `docs/research-notes.md` §10).
- **Why not fix it in `agent-prompt.ts` like the others:** the first attempt narrowed the
  guard inside `setupFinishNotification` by snapshotting ownership when the watcher armed.
  It fails upstream's own test — `agent-prompt.test.ts`, "detaching a child ends its
  parent-owned finish notification" (added in `ffe76a7e5`, #2186) — which constructs a
  child with **no parent label at setup** and asserts the caller is _not_ prompted. Inside
  the watcher, that fixture and an SLP detached Lead are byte-identical inputs; nothing
  can tell them apart. The distinguishing fact — that the caller explicitly asked for a
  detached child — exists only at the create call site, which is why the patch lives there
  and why upstream's guard semantics are left exactly as upstream tests them.
- **Scope:** `create.ts` is the only caller that passed `requireParentOwnership: true`.
  `paseo-tools.ts` omits it (defaults false), where the guard never ran.
- **Upstream status:** submitted — [getpaseo/paseo#3094](https://github.com/getpaseo/paseo/pull/3094)
  (branch `fix/detached-child-finish-notification`, off `upstream/main`, marker and SLP
  wording stripped). Independent of #2879, which is entirely in `agent-prompt.ts`; the two
  can land in either order. The upstream branch puts its tests in `create.test.ts` rather
  than a `.slp.` file, so if it merges, delete `create.slp.test.ts` here rather than trying
  to reconcile the two.

### detached-arg

- **What:** the agent-scoped `create_agent` schema gains an optional `detached` boolean, and
  the canonical branch returns `parsed.detached ?? false` instead of a hardcoded `false`.
  Upstream can only be asked for a detached child through the COMPAT nested `relationship`
  shape, which the advertised schema does not mention — so the canonical schema had no way
  to express the request at all.
- **Why it matters here:** a client that trusts the advertised schema serializes the unknown
  `relationship` key as a _string_, and the daemon rejects it with
  `expected object, received string`. Measured on 2026-08-10 with daemon 0.3.1: the same
  prompt from a Codex seat sent `"relationship":{"kind":"detached"}` and succeeded, from a
  Claude seat sent `"relationship":"{\"kind\": \"detached\"}"` and failed. So a Claude
  Supervisor could not open a detached Lead — the core SLP staffing move.
- **No `.default(false)`:** a default makes the tool schema inject `detached` into _every_
  parsed call, and the legacy schema is `.strict()`, so legacy placements start failing on
  the unrecognized key. This was caught by three upstream tests in `mcp-parity.e2e.test.ts`
  going red; keep the field `.optional()` and coalesce at the read site.
- **Relation to `detached-wakeup`:** that patch makes a detached child _notify_ its caller;
  this one makes a detached child _requestable_ from the canonical shape. Independent fixes,
  different files.
- **Upstream status:** submitted — [getpaseo/paseo#3147](https://github.com/getpaseo/paseo/pull/3147) (branch `fix/canonical-detached-create-agent`, off `upstream/main`, marker and SLP wording stripped).

### native-tools-optin

- **What:** Paseo's native host-tool channel (the one that carries `create_agent`
  and friends to an omp seat) is no longer governed by `daemon.mcp.injectIntoAgents`,
  and the per-provider `paseoTools` param decides whether a given omp provider's
  seats receive it. Two changes, one cause. Upstream gated a non-MCP mechanism on
  an MCP-injection flag, so a room that turns daemon-wide MCP injection off — as
  this one does, because its launchers generate caller-scoped servers per seat and
  an inherited one would be scoped to another agent — silently loses native tools
  as collateral. And `supportsNativePaseoTools` was a constant `true`, so every omp
  provider advertised the channel when the room needs its Peer seats to hold no
  orchestration tools at all while its Lead and Supervisor do.
  `daemon.mcp.nativeAgentTools` (default `true`) is the global switch; per-provider
  `params.paseoTools` (default `true`) is the seat-level one.
- **Why here:** measured in the omp pilot of 2026-08-16. An omp Lead attempting
  `create_agent` returned `Unknown tool from js runtime`, while a codex Lead and a
  claude Lead on the same daemon both created an omp Peer that ran and replied. The
  difference was not the room's configuration: the caller-scoped endpoint answered
  `initialize` with HTTP 200, and omp reaches its stdio MCP servers normally. It is
  that omp's tools arrive over the native channel, and that channel was switched
  off by a flag about something else.
- **Upstream status:** submitted — [getpaseo/paseo#3449](https://github.com/getpaseo/paseo/pull/3449),
  branch `feat/omp-native-tools-optin` off `upstream/main`. Delete this section and
  the local markers if it lands. Coverage lives in
  `packages/server/src/server/agent/providers/omp/native-tools-optin.slp.test.ts`.

## Sync procedure

First, check whether upstream touched the patched files since the last sync:

```bash
git fetch upstream
git diff --name-only $(git merge-base HEAD upstream/main) upstream/main -- \
  packages/server/src/server/agent/agent-prompt.ts \
  packages/server/src/server/agent/create-agent/create.ts \
  packages/server/src/server/agent/tools/paseo-tools.ts
```

Empty output means a conflict-free merge for the patches. Non-empty output is the normal
case once patches start landing, and it means read the upstream commits before merging —
a patch of yours may have landed, been redesigned, or had its insertion point rewritten.
`git log $(git merge-base HEAD upstream/main)..upstream/main -- <file>` names them.

Then merge:

```bash
git merge upstream/main       # merge, not rebase: pushed history stays stable, no force-push
rg "SLP-PATCH\("              # verify every marker survived the merge
npx vitest run packages/server/src/server/agent/agent-prompt.slp.test.ts --bail=1
npx vitest run packages/server/src/server/agent/agent-prompt.test.ts --bail=1
npx vitest run packages/server/src/server/agent/create-agent/create.slp.test.ts --bail=1
npx vitest run packages/server/src/server/agent/create-agent/create.test.ts --bail=1
npx vitest run packages/server/src/server/agent/mcp-parity.e2e.test.ts
git push origin slp/patches
```

Run the two upstream-owned files (`agent-prompt.test.ts`, `create.test.ts`) too, not just
the `.slp.` ones: they are the tripwire for a patch that contradicts upstream intent, which
is how `detached-wakeup` got redesigned before landing.

Update this file in the same commit as any new patch. One section per patch; delete the
section when a patch lands upstream.

### After the push

Four more steps have to run after the push before a sync reaches a seat. Each is owned by
the parent SLP repository, so this list links out rather than restating them:

1. **Rebuild, then restart.** `npm run build:server && npm run build:daemon-web-ui`, then
   restart the daemon. Global `paseo` is an npm link into `packages/cli`, so the daemon
   serves whatever `packages/server/dist` holds at start time — restarting without
   rebuilding serves the old dist and nothing explains why. See the parent repo's
   `INSTALL.md`. Never restart the daemon on port 6767 without explicit human permission;
   it kills every running agent, often including the one asking.
2. **Bump the parent gitlink.** The superproject pins this checkout by commit. Commit the
   moved gitlink from the parent repo root and open a PR to `master`. See `AGENTS.md`.
3. **Publish to the deployment worktree.** Once CI is green and the PR is merged,
   fast-forward `~/.config/airoom` and update its submodule pointer. The fast-forward is
   the publish step — until it runs, no seat sees the merge. See `AGENTS.md`.
4. **Refresh vendored skills if they moved.** `skills/paseo` and `skills/paseo-handoff` are
   copied into the parent repo, not symlinked, and pinned by commit in the parent's
   `skills/VENDORED.md`. If this sync changed `skills/` here, re-copy and read the diff.
   Check with `git diff --name-only <old-gitlink>..HEAD -- skills/`.
