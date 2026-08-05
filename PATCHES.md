# PATCHES

Local patches carried on top of upstream `getpaseo/paseo` (fork: `thomasvan/paseo`, branch `slp/patches`).

Every patch site in code is marked `SLP-PATCH(<name>)`. `rg "SLP-PATCH\("` lists all sites.
When syncing with upstream, merge `upstream/main` into this branch; if a hunk
conflicts, the marker plus this file is enough to re-apply the intent by hand.

All patches live in **one source file** — `packages/server/src/server/agent/agent-prompt.ts` —
and their tests in `agent-prompt.slp.test.ts`, a file upstream does not own. Merge
conflicts with upstream are only possible in `agent-prompt.ts`.

## Why these patches exist

The SLP orchestration model (Supervisor > Lead > Peers, see `SLP-docs/`) runs long-lived
Codex agents as Paseo subagents. Upstream's finish-notification behavior broke that model
in three ways; all three are fixed here.

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
  right artifact if this is ever submitted upstream as an opt-in feature.
- **Upstream status:** local only, not yet submitted.

## Sync procedure

```bash
git fetch upstream
git merge upstream/main       # merge, not rebase: pushed history stays stable, no force-push
rg "SLP-PATCH\("              # verify every marker survived the merge
npx vitest run packages/server/src/server/agent/agent-prompt.slp.test.ts --bail=1
npx vitest run packages/server/src/server/agent/agent-prompt.test.ts --bail=1
git push origin slp/patches
```

Before merging, check whether upstream touched the patched file since the last sync:
`git diff --name-only $(git merge-base HEAD upstream/main) upstream/main -- packages/server/src/server/agent/agent-prompt.ts`.
Empty output means a conflict-free merge for the patches.

Update this file in the same commit as any new patch. One section per patch; delete the
section when a patch lands upstream.
