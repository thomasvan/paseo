---
name: upstream-sync
description: Sync the paseo fork with upstream and put the daemon on the merged code. Use when the user says "sync upstream", "merge upstream", "update from upstream", "fetch and merge main", "rebuild and restart the daemon", or "/upstream-sync". Merges upstream/main into slp/patches, re-verifies the SLP patches, rebuilds, and restarts the 6767 daemon.
user-invocable: true
---

# Upstream sync

Merge `upstream/main` into `slp/patches`, verify the local patches survived, rebuild, and restart the daemon. `PATCHES.md` (repo root) owns the sync procedure; `SLP-docs/INSTALL.md` § "Daemon rebuild & restart" owns the rebuild/restart rules. Follow them — this skill is the run order, not a replacement.

## 1. Preflight

- Branch must be `slp/patches`; working tree clean. Commit or stash anything pending first.
- Remotes: `origin` = `thomasvan/paseo`, `upstream` = `getpaseo/paseo`.

## 2. Sync

Run the **Sync procedure** in `PATCHES.md`:

1. `git fetch upstream`
2. Overlap pre-check: diff upstream against the merge base for the patched paths listed in `PATCHES.md`. Empty output means the patches merge clean.
3. `git merge upstream/main --no-edit` — merge, not rebase; never force-push.
4. On conflict in a patched file, re-apply the intent by hand from the `SLP-PATCH(<name>)` markers and the matching `PATCHES.md` section.
5. Verify: `rg "SLP-PATCH\("` still lists every site, then run the patch test file from `PATCHES.md` with `--bail=1`.
6. `git push origin slp/patches`

If the merge touched `package-lock.json`, run `npm install` before building.

## 3. Rebuild

```bash
npm run build:server && npm run build:daemon-web-ui
```

Global `paseo` is an npm link into this checkout, so the daemon serves whatever `packages/server/dist` holds at next start. Restart without rebuild serves the old code; rebuild without restart changes nothing.

## 4. Restart

Restarting the 6767 daemon closes every running agent. List them first (`paseo ls`); if any are mid-task, tell the user what will die and get an explicit go-ahead before `paseo daemon restart`.

## 5. Verify

- `paseo daemon status` — running, relay reachable, Daemon Version matches `packages/server/package.json`.
- SLP wiring intact: supervisor/lead/peer providers still listed, `mcp.injectIntoAgents` still `true` (`~/.paseo/config.json`).

Report: merged commit range, patch verification result, version before → after.
