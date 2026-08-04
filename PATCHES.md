# PATCHES

Local patches carried on top of upstream `pasetoventures/paseo` (fork: `thomasvan/paseo`, branch `slp/patches`).

Every patch site in code is marked `SLP-PATCH(<name>)`. `rg "SLP-PATCH\("` lists all sites.
When syncing with upstream, rebase this branch onto the new upstream HEAD; if a hunk
conflicts, the marker plus this file is enough to re-apply the intent by hand.

## Why these patches exist

The SLP orchestration model (Supervisor > Lead > Peers, see `SLP-docs/`) runs long-lived
Codex agents as Paseo subagents. Two upstream behaviors broke that model; both are fixed
here and are candidates for upstream PRs.

## Patches

### closed-wakeup

- **Files:** `packages/server/src/server/agent/agent-prompt.ts`,
  `packages/server/src/server/agent/agent-prompt.test.ts`
- **What:** `setupFinishNotification` now fires a `"was closed"` finish notification when
  a watched child agent is killed/closed before finishing. Upstream set `fired = true`
  and unsubscribed silently, so the calling agent (Supervisor/Lead) never woke up and
  waited forever on a dead delegation.
- **Upstream status:** not submitted yet.

### response-cap

- **Files:** same as above.
- **What:** the child's last assistant message embedded in a finish notification is
  truncated at `FINISH_NOTIFICATION_MESSAGE_LIMIT` (4000 chars) with a pointer to
  `get_agent_activity` for the full text. Prevents one verbose Peer from blowing out the
  caller's context window.
- **Upstream status:** not submitted yet.

## Sync procedure

```bash
git fetch upstream
git rebase upstream/main slp/patches
rg "SLP-PATCH\("        # verify every marker survived the rebase
npx vitest run packages/server/src/server/agent/agent-prompt.test.ts --bail=1
git push -f origin slp/patches
```

Update this file in the same commit as any new patch. One section per patch; delete the
section when a patch lands upstream.
