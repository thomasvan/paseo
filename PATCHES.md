# PATCHES

Local patches carried on top of upstream `getpaseo/paseo` (fork: `thomasvan/paseo`, branch `slp/patches`).

Every patch site in code is marked `SLP-PATCH(<name>)`. `rg "SLP-PATCH\("` lists all sites.
When syncing with upstream, merge `upstream/main` into this branch; if a hunk
conflicts, the marker plus this file is enough to re-apply the intent by hand.

Patches live in **two source files** — `packages/server/src/server/agent/agent-prompt.ts`
and one argument in `packages/server/src/server/agent/create-agent/create.ts` — with their
tests in `agent-prompt.slp.test.ts` and `create-agent/create.slp.test.ts`, files upstream
does not own. Merge conflicts with upstream are only possible in those two source files.

## Why these patches exist

The SLP orchestration model (Supervisor > Lead > Peers, see `SLP-docs/`) runs long-lived
agents as Paseo subagents. Upstream's finish-notification behavior broke that model in
four ways; all four are fixed here.

All four are in flight upstream, as two independent PRs:

| PR                                                   | Patches                                        | Touches           |
| ---------------------------------------------------- | ---------------------------------------------- | ----------------- |
| [#2879](https://github.com/getpaseo/paseo/pull/2879) | `closed-wakeup`, `response-cap`, `wakeup-each` | `agent-prompt.ts` |
| [#3094](https://github.com/getpaseo/paseo/pull/3094) | `detached-wakeup`                              | `create.ts`       |

They share no files and can land in either order. When a patch lands upstream, the next
`upstream/main` sync brings it in: drop its `SLP-PATCH(` markers, delete its section below,
and keep the `.slp.test.ts` files only for whatever upstream did not take.

## Patches

### closed-wakeup

- **What:** `setupFinishNotification` now fires a `"was closed"` finish notification when
  a watched child agent is killed/closed before finishing. Upstream set `fired = true`
  and unsubscribed silently, so the calling agent (Supervisor/Lead) never woke up and
  waited forever on a dead delegation.
- **Upstream status:** submitted — [getpaseo/paseo#2879](https://github.com/getpaseo/paseo/pull/2879) (branch `fix/finish-notification-closed-wakeup`, markers stripped).

### response-cap

- **What:** the child's last assistant message embedded in a finish notification is
  truncated at `FINISH_NOTIFICATION_MESSAGE_LIMIT` (4000 chars) with a pointer to
  `get_agent_activity` for the full text. Prevents one verbose Peer from blowing out the
  caller's context window.
- **Upstream status:** submitted — [getpaseo/paseo#2879](https://github.com/getpaseo/paseo/pull/2879) (branch `fix/finish-notification-closed-wakeup`, markers stripped).

### wakeup-each

- **What:** the finish watcher re-arms after every wakeup instead of unsubscribing after
  the first, so a caller keeps waking for every finish of a long-lived child across
  multiple prompts. It disarms only when the child closes (`"was closed"`) or the caller
  is archived. Watchers only ever exist for agent callers (`notifyOnFinish` +
  `callerAgentId`), so this is derived — no `notifyMode` parameter, no schema or
  plumbing changes in `create.ts` / `paseo-tools.ts`. An earlier revision threaded an
  opt-in `notifyMode: "once" | "each"` param through the tool schemas; that shape is the
  right artifact if upstream asks for this to be opt-in.
- **Upstream status:** submitted — [getpaseo/paseo#2879](https://github.com/getpaseo/paseo/pull/2879) (branch `fix/finish-notification-closed-wakeup`, markers stripped). This one changes default behavior for existing upstream callers, so it is the likeliest of the three to be pushed back on.

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
  ended by an unrelated heartbeat sweep rather than by the notification
  (`SLP-docs/docs/research-notes.md` §10).
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

## Sync procedure

```bash
git fetch upstream
git merge upstream/main       # merge, not rebase: pushed history stays stable, no force-push
rg "SLP-PATCH\("              # verify every marker survived the merge
npx vitest run packages/server/src/server/agent/agent-prompt.slp.test.ts --bail=1
npx vitest run packages/server/src/server/agent/agent-prompt.test.ts --bail=1
npx vitest run packages/server/src/server/agent/create-agent/create.slp.test.ts --bail=1
npx vitest run packages/server/src/server/agent/create-agent/create.test.ts --bail=1
git push origin slp/patches
```

Run the two upstream-owned files (`agent-prompt.test.ts`, `create.test.ts`) too, not just
the `.slp.` ones: they are the tripwire for a patch that contradicts upstream intent, which
is how `detached-wakeup` got redesigned before landing.

Before merging, check whether upstream touched the patched files since the last sync:

```bash
git diff --name-only $(git merge-base HEAD upstream/main) upstream/main -- \
  packages/server/src/server/agent/agent-prompt.ts \
  packages/server/src/server/agent/create-agent/create.ts
```

Empty output means a conflict-free merge for the patches.

Update this file in the same commit as any new patch. One section per patch; delete the
section when a patch lands upstream.
