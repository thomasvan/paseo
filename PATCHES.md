# PATCHES

Local patches carried on top of upstream `getpaseo/paseo` (fork: `thomasvan/paseo`, branch `slp/patches`).

Every patch site in code is marked `SLP-PATCH(<name>)`. `rg "SLP-PATCH\("` lists all sites.
When syncing with upstream, merge `upstream/main` into this branch; if a hunk
conflicts, the marker plus this file is enough to re-apply the intent by hand.

Patches live in **four source files** — `packages/server/src/server/agent/agent-prompt.ts`,
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
finish-notification behavior broke that model in five ways — two are now fixed upstream and
three are still carried here — and its native host-tool channel broke the omp family in a
sixth, unrelated way.

Two have landed upstream and their sections are gone. Five patches remain here:

| PR                                                   | Patches                    | Touches                        | Status                     |
| ---------------------------------------------------- | -------------------------- | ------------------------------ | -------------------------- |
| [#3192](https://github.com/getpaseo/paseo/pull/3192) | —                          | `agent-prompt.ts`              | landed `cdb116314`, synced |
| [#3455](https://github.com/getpaseo/paseo/pull/3455) | `wakeup-each`              | `agent-prompt.ts`              | open — **opt-in shape**    |
| [#3094](https://github.com/getpaseo/paseo/pull/3094) | `detached-wakeup`          | `create-agent/create.ts`       | open                       |
| [#3147](https://github.com/getpaseo/paseo/pull/3147) | `detached-arg`             | `paseo-tools.ts`               | open                       |
| [#3449](https://github.com/getpaseo/paseo/pull/3449) | `native-tools-optin`       | omp provider, config           | open                       |
| [#3495](https://github.com/getpaseo/paseo/pull/3495) | `question-answer-required` | `agent-manager.ts` + own files | open                       |

## `question-answer-required`

**PR:** [#3495](https://github.com/getpaseo/paseo/pull/3495), cut from
`upstream/main` so it carries no `SLP-PATCH` marker and no `.slp` filename — if
it lands the files converge instead of conflicting, and this section goes.

**Sites:** one condition in `packages/server/src/server/agent/agent-manager.ts`
(`respondToPermission`), plus `question-permission.slp.ts`,
`question-permission.slp.test.ts` and `question-permission.slp.parity.test.ts`,
which upstream does not own. The upstream PR carries the same three files without
the `.slp` infix; on a sync that takes #3495, delete the `.slp` trio and the
marker rather than merging them. The rule lives in
the fork-owned file so the upstream-owned call site is a single `if`.

**What it fixes.** A Claude `question` permission answered in any shape but
`updatedInput.answers` keyed by a question resolved as `allow` and delivered
nothing. The waiting agent was told `The user did not answer the questions.` — an
affirmative falsehood rather than silence, so neither side could see the failure.
The natural field to reach for, `selectedActionId`, is `z.string().optional()`
with no membership check and is read only for `plan` kinds, while a question
advertises `actions: undefined`.

Worse, it was unrecoverable: the session deletes the request on entry, so the
malformed answer consumed it and the retry failed with `No pending permission
request`. The check runs **before** `session.respondToPermission`, so both maps
stay intact and the request is still answerable.

**The rule is provider-specific, so the check is too.** It fires only on
`provider === "claude"`, and it mirrors Claude's mapping rather than approximating
it:

| provider | mapping                                                                                                                                                  | unmapped answer                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| claude   | `normalizeClaudeAskUserQuestionUpdatedInput` keeps an answer whose key is a question's full text **or** its header and whose value is a non-empty string | nothing is delivered — the defect                           |
| codex    | `mapCodexQuestionResponseByHeader`, headers only                                                                                                         | **selects each question's first option** — a supported path |
| opencode | headers only                                                                                                                                             | an empty answer list per question                           |

So `{"answers":{"wrongKey":"x"}}`, `{"answers":{"Colour":""}}` and
`{"answers":{"Colour":1}}` are rejected for Claude — each one is well-formed
enough to pass a shape-only check and is then discarded — while a Codex question
answered with `selectedActionId` is left alone, because rejecting it would break
a caller that upstream deliberately supports.

**Two details of the mirror are load-bearing, and both were wrong first.**
`readNonEmptyString` tests `value.trim()` for emptiness but returns the
**original** string, so a question whose text carries surrounding whitespace is
keyed _by that whitespace_: trimming the key here would accept
`{"Which colour?": …}` against a question named `" Which colour? "` — which
Claude cannot map — and reject `{" Which colour? ": …}`, which it can. And the
question list is taken from `updatedInput.questions` when the response supplies
one **at all**, including an empty array, which `Array.isArray` accepts and which
therefore maps nothing; only a response _and_ a request that both carry no list
is unreadable, and only that case is passed to the provider unchecked.

`question-permission.slp.parity.test.ts` runs the guard and the real
`normalizeClaudeAskUserQuestionUpdatedInput` against the same fifteen inputs and
requires them to agree. Unit tests state the rule as understood, which is the
thing that was wrong twice; this one compares against the code being mirrored.

The Codex and OpenCode rows are read from their providers' source, not measured:
neither `codex-lead` nor `codex-peer` will emit a question here — codex answers
`request_user_input is unavailable in Default mode` in both seat modes (`auto`,
`full-access`). What is covered by test is the part that matters, that the guard
does not fire for a non-Claude provider.

**Measured after the patch**, on the room's own MCP path — a Lead calling
`respond_to_permission` with `selectedActionId` receives:

```
Permission request '…' is a Claude question: allow requires updatedInput.answers
keyed by a question's full text or its header, with a non-empty string value …
Accepted keys: … The request is still pending; answer it again with that shape.
```

The keys it lists are the _effective_ ones — the echoed list when the response
carries one, the stored list otherwise — so the message never advertises a key
that validation would not have accepted.

and the request survives; answering again with `{"answers":{"Colour":"Cobalt"}}`
reaches the agent.

**Known limit.** The WebSocket path (`session.ts handleAgentPermissionResponse`)
catches the throw and emits an `activity_log` error rather than failing the
caller's call, because upstream treats a permission response as a notification
rather than a request. So `paseo permit allow` still prints `allowed` and exits
0 for a rejected shape. The destructive half is closed on every path — the
request survives and the agent is never told a falsehood — but CLI callers do
not see the error. Fixing that needs a protocol change and is upstream's to
make.

`closed-wakeup` and `response-cap` are upstream's code now. #2879 carried all three and the
maintainer closed it on 2026-08-11 as superseded by #3192 — _"which carries the closed-child
wakeup and response truncation onto current main with your authorship preserved"_ — taking
two and leaving `wakeup-each`, the one that changes default behavior for existing upstream
callers. That sync has since happened: `cdb116314` and `334bf6237` are both ancestors of this
branch, the two markers are gone, and `wakeup-each` was re-applied onto the new shape as
`notifySafely("finished", { terminal: false })` rather than as a restored diff.

**`wakeup-each` was resubmitted as [#3455](https://github.com/getpaseo/paseo/pull/3455) in the
opt-in shape**, which is the objection that closed #2879 answered rather than argued with:
`notifyMode` on the agent-scoped `create_agent` and `send_agent_prompt` schemas, `"once"` the
default and byte-identical to current upstream behaviour, `"each"` the re-arming one.

**The fork and the PR deliberately differ.** This branch keeps the _derived_ form — always
re-arm, no parameter — because every child in this room is a long-lived seat driven across
many turns, so an opt-in the room would pass on every single call is a parameter that only
exists to be forgotten once. Upstream does not have that guarantee about its callers, which
is exactly why the default-changing version was refused. If #3455 lands, this branch drops
its local patch and the room starts passing `notifyMode: "each"` — a seat-facing change to
the staffing prose, not just a submodule sync, so it does not ride an ordinary upgrade.

**Re-verified against `upstream/main` `8c4e54eac` on 2026-08-16.** Upstream has fixed none
of the four: `notifySafely("finished")` still takes no `terminal` option, `create-agent/create.ts`
still hardcodes `requireParentOwnership: true`, the canonical `create_agent` branch still returns
`detached: false` with no `detached` field on the advertised schema, and the omp provider still
has no `paseoTools`. All three open PR branches still merge into current `upstream/main` without
conflict and their fixes survive the merge, so none needs rebasing to stay applicable —
`#3094` and `#3147` are 94 and 89 commits behind and still clean because upstream has not
touched the lines they change.

The remaining patches share no files and can land in any order. When one lands upstream, the
next `upstream/main` sync brings it in: drop its `SLP-PATCH(` markers, delete its section
below, and keep the `.slp.test.ts` files only for whatever upstream did not take.

## Patches

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
- **Upstream status:** open — [getpaseo/paseo#3455](https://github.com/getpaseo/paseo/pull/3455), branch `fix/finish-watcher-notify-mode` off `upstream/main`, **in the opt-in shape**. [#2879](https://github.com/getpaseo/paseo/pull/2879) carried this patch and was closed on 2026-08-11 as superseded by #3192, which took the other two and left this one because it changed the default for every existing caller. #3455 answers that: `notifyMode` on the agent-scoped `create_agent` and `send_agent_prompt` schemas, `"once"` the default and byte-identical to current upstream, `"each"` the re-arming mode, the archived-caller disarm scoped to `"each"` so the existing path is untouched, and the field `.optional()` with no `.default()` for the `.strict()` reason recorded under `detached-arg`. Four tests, each mutation-checked. **This branch keeps the derived form instead** — see the note above the patch list for why, and for what changes here if #3455 lands.

### detached-wakeup

- **What:** `create-agent/create.ts` passes `requireParentOwnership: !input.detached` instead of a
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
- **Scope:** `create-agent/create.ts` is the only caller that passed `requireParentOwnership: true`.
  `paseo-tools.ts` omits it (defaults false), where the guard never ran.
- **Upstream status:** submitted — [getpaseo/paseo#3094](https://github.com/getpaseo/paseo/pull/3094)
  (branch `fix/detached-child-finish-notification`, off `upstream/main`, marker and SLP
  wording stripped). Independent of `wakeup-each`, which is entirely in `agent-prompt.ts`;
  the two can land in either order. The upstream branch puts its tests in `create.test.ts` rather
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
