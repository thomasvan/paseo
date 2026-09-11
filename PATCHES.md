# PATCHES

Local patches carried on top of upstream `getpaseo/paseo` (fork: `thomasvan/paseo`, branch `slp/patches`).

Every patch site in code is marked `SLP-PATCH(<name>)` — one patch,
`archived-live-list`, is deliberately unmarked and survives by its behavioural
check (see its section). To list them, use the
gate in `Sync procedure` below — a bare `rg` also matches this file's own prose,
which is why the gate excludes it.
When syncing with upstream, merge `upstream/main` into this branch; if a hunk
conflicts, the marker plus this file is enough to re-apply the intent by hand.

Patches live in **more files than any sentence here should try to list** — the
manifest is derived in `Sync procedure` below, and a hand-kept list drifted
twice before that. The shape, though: `packages/server/src/server/agent/agent-prompt.ts`,
one argument in `packages/server/src/server/agent/create-agent/create.ts`, one schema
field in `packages/server/src/server/agent/tools/paseo-tools.ts`, one guard in
`packages/server/src/server/agent/providers/claude/agent.ts`, four provider-local
repairs in `packages/server/src/server/agent/providers/codex-app-server-agent.ts`
(`dead-run-settles`, `replace-awaits-teardown`, `dispose-releases-foreground`,
`interrupt-releases-foreground`), and a fifth,
`force-cancel-releases-foreground`, which spans the manager
(`agent-manager.ts`) and the registry facade (`agent-sdk-types.ts`,
`provider-registry.ts`).

Three patches keep their tests in fork-only `.slp.test.ts` files upstream does
not own: `agent-prompt.slp.test.ts`, `create-agent/create.slp.test.ts` and
`native-tools-gate.slp.test.ts`. (`native-tools-optin.slp.test.ts` was the
third until the 2026-09-07 sync retired its patch; `native-tools-gate.slp.test.ts`
replaced it there, keeping the count at three.)

Two other patches put their tests in upstream-owned files, for the same reason in
both cases — the test belongs next to the thing it checks. `detached-arg`'s behaviour only
shows through a live MCP tool call, so its two tests sit in `mcp-parity.e2e.test.ts` beside
the legacy-shape test they mirror; `question-answer-required` guards a rule defined in the
Claude provider, so its tests sit in `providers/claude/agent.test.ts` beside that rule. The
new `a rejected question answer leaves the request answerable by a corrected retry` test
follows that upstream-owned-file convention and carries no marker: these tests are expected
to converge if upstream takes the patch, and adding a marker would falsely change the patch
census.

## Why these patches exist

The SLP room repository — named `room-workflow` until 2026-08-10, now `airoom` — uses this checkout as its editable `paseo/` submodule.
Its Supervisor > Lead > Peers model runs long-lived agents as Paseo subagents. Upstream's
finish-notification behavior broke that model in five ways — two are now fixed upstream and
three are still carried here — and its native host-tool channel broke the omp family in a
sixth, unrelated way. The sixth one left the merge, then came back narrower
the same day: #4277 superseded the fork's shape but still ties the native
catalog to MCP injection, so a minimal follow-up patch (below) re-couples it to
`mcp.enabled` alone.

Two have landed upstream and their sections are gone. **Twelve patches remain
here** — the count was nine for a while after `force-cancel-releases-foreground`
and `archived-live-list` arrived without it being updated, and
`mcp-protocol-version-clip` made it twelve on 2026-09-09, which is why the
`Sync procedure` below now derives its file manifest with a command instead of
restating a total.
Current upstream sync: **2026-09-11**, tag `v0.8.0` at
`b8e24677e12b226c7c38c1c3a40649daa9f1152f`, merge
`683d6e776e3aa29f213c925fe3bc6a21a261fb3c`. All twelve patches carried with
no adaptation. The tag is pinned rather than `upstream/main`, which is one
commit past it, so the merge is reproducible.
Previous upstream sync: **2026-09-07**, `upstream/main` at `c424f8292` (0.7.2),
merge `9934a5a60`. One patch left in that merge: `native-tools-optin`. Its PR
[#3449](https://github.com/getpaseo/paseo/pull/3449) was closed on 2026-09-03
as superseded by the maintainer's own
[#4277](https://github.com/getpaseo/paseo/pull/4277) ("Control Paseo tools per
provider", merged as `53c960747`), which delivers per-provider control of the
Paseo tool catalog across native and MCP delivery and deliberately refused the
fork's two switches — `daemon.mcp.nativeAgentTools` and the omp-specific
`params.paseoTools` — as two global switches for one catalog. The fork hunks
were dropped to upstream's shape. Only two files conflicted (`bootstrap.ts`,
`omp/provider-config.ts`); everything else auto-merged, and no marker site of
another patch was lost. Consequences to hold onto: the room's omp configuration
must migrate to #4277's per-provider policy before this merge is activated, and
two adaptations rode the merge in — `agent-prompt.slp.test.ts` was re-seamed to
the merged dispatch internals (it now mirrors upstream's own harness, a real
`AgentManager` with `streamAgent` recording the prompts, because merged
`sendPromptToAgent` walks `ensureAgentLoaded → startAgentRun`, which the old
stub could not satisfy), and `force-cancel-releases-foreground` reads the
canceled run's turn id from `this.runs.getTurnId(agentId)` now that upstream
tracks runs in `AgentRunState`. Twelve patches are retained in total; the
current PR states and the two merged PRs are recorded in the table below.

A same-day review follow-up re-opened part of the retirement. A read-only Lead
review (codex-lead, room review of the merge) found that #4277 alone does not
preserve the room's setup: upstream still gates the native catalog on
`mcp.injectIntoAgents !== false` (bootstrap startup and both live field-change
handlers), and the room runs injection off. So `native-tools-injection-independent`
below re-couples the native catalog's master enable to `mcp.enabled` alone,
keeping #4277's per-provider policy as the seat-level gate. The room's live
`~/.paseo/config.json` still carries the retired shape (`daemon.mcp.nativeAgentTools`
and omp `params.paseoTools`) and must migrate to `paseoTools: { enabled: … }`
per provider id before this merge is activated.

The 2026-08-24 sync note follows. `upstream/main` was at `8fdca94ea`;
all six upstream PRs were still open, so all six carried patches survive — the
merge was conflict-free, but it brought an upstream test pinning the
pre-#3640 interrupt-throw (`does not interrupt after the accepted turn
terminates before identification`, upstream `9a7301d9a`), adapted on this
branch to the no-op semantics `dead-run-settles` carries. The seventh patch,
`replace-awaits-teardown`, was added in the same window from a production
incident. The earlier 2026-08-20 sync note follows. The sync moved
two of them: `native-tools-optin` re-woven through the rewritten daemon-config
store (the field now rides `SupportedMutableConfigPatch`, the
`pickSupportedPatchFields` gate, `mergeMutableDaemonPatch`, the reloadable-path
maps, and a `persistConfig` step that materializes the current value on any mcp
write so a restart cannot revert a seeded setting), and `wakeup-each`'s harness
now stubs `steerOrReplaceActiveTurn` because upstream notify() dispatches with
`activeTurnBehavior: "steer"`. Upstream's own Suite E (worktree tools) in
`mcp-parity.e2e.test.ts` fails in this environment before and after the sync —
not patch-related. Suite D can fail here too, but only by timing out; see the
baseline under `Sync procedure`. One more environment note from the 2026-08-22 sync: the
tip's `websocket-server.ts` typechecks only against a rebuilt
`@getpaseo/protocol` dist (`pluginThemes` rode the protocol package), so a
stale protocol dist fails `build:lib` with an error that looks like upstream
breakage and is not. The patch table:

| PR                                                   | Patches                                                                                                                                           | Touches                                                                                       | Status                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [#3192](https://github.com/getpaseo/paseo/pull/3192) | —                                                                                                                                                 | `agent-prompt.ts`                                                                             | landed `cdb116314`, synced                                |
| [#3455](https://github.com/getpaseo/paseo/pull/3455) | `wakeup-each`                                                                                                                                     | `agent-prompt.ts`                                                                             | closed 2026-09-08 — feature-PR sweep                      |
| [#3094](https://github.com/getpaseo/paseo/pull/3094) | `detached-wakeup`                                                                                                                                 | `create-agent/create.ts`                                                                      | open                                                      |
| [#3147](https://github.com/getpaseo/paseo/pull/3147) | `detached-arg`                                                                                                                                    | `paseo-tools.ts`                                                                              | closed 2026-09-08 — feature-PR sweep                      |
| [#4277](https://github.com/getpaseo/paseo/pull/4277) | — superseded `native-tools-optin`                                                                                                                 | per-provider Paseo tool policy                                                                | landed `53c960747`; closed #3449 as superseded 2026-09-03 |
| [#4434](https://github.com/getpaseo/paseo/pull/4434) | `native-tools-injection-independent`                                                                                                              | `bootstrap.ts`, `native-tools-gate.ts`                                                        | closed 2026-09-08 — feature-PR sweep                      |
| [#3640](https://github.com/getpaseo/paseo/pull/3640) | `dead-run-settles`, `interrupt-releases-foreground`, `replace-awaits-teardown`, `dispose-releases-foreground`, `force-cancel-releases-foreground` | `codex-app-server-agent.ts`, `agent-manager.ts`, `agent-sdk-types.ts`, `provider-registry.ts` | closed 2026-09-08 in favor of #4041 — follow-up remains   |
| [#3495](https://github.com/getpaseo/paseo/pull/3495) | `question-answer-required`                                                                                                                        | claude provider                                                                               | open                                                      |
| [#3803](https://github.com/getpaseo/paseo/pull/3803) | `archived-live-list`                                                                                                                              | `mcp-shared.ts`, `agent-projections.ts`, `messages.ts`, `paseo-tools.ts`                      | open — **no marker**                                      |
| [#3674](https://github.com/getpaseo/paseo/pull/3674) | —                                                                                                                                                 | `codex-app-server-agent.ts`                                                                   | closed into #3640                                         |
| [#3683](https://github.com/getpaseo/paseo/pull/3683) | —                                                                                                                                                 | `codex-app-server-agent.ts`                                                                   | closed into #3640                                         |
| [#4570](https://github.com/getpaseo/paseo/pull/4570) | `mcp-protocol-version-clip`                                                                                                                       | `bootstrap.ts`                                                                                | open                                                      |

## The five codex patches ride one PR

`replace-awaits-teardown`, `dead-run-settles`, `interrupt-releases-foreground`
and `dispose-releases-foreground` all repair one piece of state — the
provider's single `activeForegroundTurnId` slot — and on 2026-08-23 they were
consolidated onto #3640; #3674 and #3683 are closed pointing at it.
`force-cancel-releases-foreground` joined the same PR (manager + registry
facade), and the 2026-09-07 sync adapted it to upstream's `AgentRunState` run
tracker and added the already-idle waiter flush under
`interrupt-releases-foreground`.

Not for tidiness. **Two lines could not exist in any of the three PRs
separately.** `interrupt()` and `disposeClient()` each release the slot, and
each must wake the callers blocked on it through
`flushForegroundTurnClearWaiters()` — a method `replace-awaits-teardown`
introduces. Both other branches were cut against a base that lacks it, so in
_every_ merge order upstream would have landed slot releases that leave
waiters asleep for the full 10s timeout: the exact race #3674 exists to close,
reintroduced at the two sites #3640 and #3683 repair. The note that used to
stand here — _"if #3674 lands first, the flush must be added there"_ —
understated it; the call appeared in no PR at all.

Neither call was proven upstream: on a branch carrying all four patches
without this branch's own tests, deleting both left the provider suite at
148/148. The consolidated PR therefore adds one test per call, each asserting
that a `startTurn` blocked on the teardown settles within 50ms of the release
rather than sleeping out the timeout; there, deleting either call fails its
own test and nothing else.

**Here the two calls are not equally exposed**, and an earlier version of this
section said they were. `d7c8450c6` already pinned the interrupt-side call:
`releases an orphaned foreground slot when the turn was never identified`
queues a real prompt, then asserts the waiter list empties and the queued
prompt is not refused. Deleting that call fails it. Only the dispose-side call
was unproven on this branch — deleted alone at `716b6379c`, the suite passed
148/148 — so only its test is carried here; the interrupt-side test would
duplicate coverage that already exists.

Each of the four upstream commits is green on its own. `dead-run-settles` and
`interrupt-releases-foreground` are squashed into one commit because the
former invalidates an upstream test that only the latter repairs, which is why
#3640 sat red on its first push.

## `replace-awaits-teardown`

**PR:** [#3640](https://github.com/getpaseo/paseo/pull/3640), consolidated
there on 2026-08-23; [#3674](https://github.com/getpaseo/paseo/pull/3674) is
closed into it. Cut from `upstream/main` without the fork markers.

**Site:** `packages/server/src/server/agent/providers/codex-app-server-agent.ts` —
one constant, one waiter field, two private methods, a bounded wait at the top
of `startTurn`, and a flush at the five sites that clear
`activeForegroundTurnId`. Tests sit in upstream's own
`codex-app-server-agent.test.ts` (no marker, so the file converges if taken).

**Why.** A prompt injected while a codex turn is being cancelled races the
teardown. `steerOrReplaceActiveTurn` falls back to replace when steering is
unavailable; `cancelAgentRunBefore` returns once the **manager's** run record
settles — and a force-cancel settles it without waiting for the provider — so
`startTurn` finds `activeForegroundTurnId` still set and throws `A foreground
turn is already active`. Measured in production 2026-08-22: force-cancel
logged at `.022`, the throw at `.026` — four milliseconds — six occurrences in
one engagement on the busiest seat (the Supervisor), each one turning a live
wakeup into a lost prompt and an `error`-status seat until the next heartbeat
sweep re-prompted it. The provider owns "when may a new turn start", so the
repair is provider-local: `startTurn` waits up to `FOREGROUND_TEARDOWN_WAIT_MS`
(10s) for the teardown to clear the id — the five clear sites flush the
waiters — and refuses only a turn that genuinely will not end. A timed-out
waiter removes itself, so a stuck turn plus retrying prompts retains no dead
closures. Zero manager changes; the refusal semantics for a truly stuck turn
are unchanged.

## `dispose-releases-foreground`

**PR:** [#3640](https://github.com/getpaseo/paseo/pull/3640), consolidated
there on 2026-08-23; [#3683](https://github.com/getpaseo/paseo/pull/3683) is
closed into it. Cut from `upstream/main` without the fork markers, and
**adapted**: the upstream commit now carries the
`flushForegroundTurnClearWaiters()` call this branch has, which the standalone
PR could not.

**Site:** `packages/server/src/server/agent/providers/codex-app-server-agent.ts` —
`disposeClient()`, with its test beside the others in the provider's own suite.

**Why.** `disposeClient()` cleared `currentTurnId` but not
`activeForegroundTurnId`. `close()` clears the slot itself before disposing, so
the asymmetry only shows on the other caller: a **failed reconnect**. The seat
is then permanently wedged, and the state is invisible from outside — the
manager reports `activeTurn: null` while the provider still holds the slot:
`interrupt()` finds no turn and no-ops (`dead-run-settles`), the manager
force-cancels its own run record and believes the agent free, and every later
`startTurn` refuses with "A foreground turn is already active". With
`replace-awaits-teardown` carried, each refusal now takes the full 10s wait
first. **The heartbeat cannot rescue this**: the daemon refuses a scheduled
run against an agent with an in-flight run, so every beat fails too. Measured
in production 2026-08-22 on the Supervisor seat — fifteen minutes of refused
prompts and failed beats, `paseo stop` reporting `stoppedCount 0`, `send`
answering `failed to start`, recovered only by a daemon restart.

**Fix.** A disposed client cannot own a live turn, so `disposeClient()`
releases the slot with it: emit `turn_failed` so the manager's run settles,
clear the foreground and client-message ids, flush the teardown waiters, and
resolve any pending turn identification. Idempotent on the `close()` path,
which already cleared the slot.

PR #3640 was closed on 2026-09-08 in favor of the still-open runtime-
reconciliation approach in [#4041](https://github.com/getpaseo/paseo/pull/4041):
"The Codex-specific failed-reconnect and unidentified-turn cases remain
follow-up work." This is a technical successor, not the feature-PR sweep that
closed #3455, #3147, and #4434; deciding whether #4041 replaces these patches
belongs to a later sync round.

## `interrupt-releases-foreground`

**PR:** [#3640](https://github.com/getpaseo/paseo/pull/3640) — squashed with
`dead-run-settles` into one commit there, because the release only makes sense
once that patch has replaced the throw with the no-op branch it attaches to,
and because `dead-run-settles` alone leaves red the upstream interrupt test
that this patch repairs. Cut without the fork markers. Since the 2026-08-23
consolidation the upstream commit carries the
`flushForegroundTurnClearWaiters()` call this branch has; before it, the PR
omitted that call because the method arrives with `replace-awaits-teardown`.

**Site:** `packages/server/src/server/agent/providers/codex-app-server-agent.ts` —
`interrupt()`, on the branch `dead-run-settles` added, with its tests beside the
others in the provider's own suite.

**Why.** `dead-run-settles` stopped `interrupt()` throwing when Codex accepted
`turn/start` but never published a native turn id, so the manager can settle
its own run record. Nothing releases the **session's** foreground slot on that
path, and no turn-end event is ever coming to clear it — the turn Codex would
report the end of was never identified. Every later `startTurn` then refuses
with "A foreground turn is already active", permanently. This is the same
terminal state `dispose-releases-foreground` fixed for the failed-reconnect
caller, reached through the other door: `paseo stop` reports a no-op,
`paseo agent reload` reports `thread ... already has an active writer`, and
only killing the agent's `codex app-server` process recovers the seat.

Measured **nine times in one 8h window** on 2026-08-22, on a daemon already
carrying `dead-run-settles`, `replace-awaits-teardown` and
`dispose-releases-foreground`. The blast radius is wider than the wedged seat:
while a parent holds an unreachable foreground turn, the child-finish
notifications addressed to it are dropped with no retry — 20 in that window, 15
`finished` and 5 `was closed`, three of them addressed to a Lead rather than
the Supervisor. A supervising agent silently loses the completion signals it
delegates on, and its scheduled sweeps are refused too (14 of 68 that window).

**Fix.** An unidentifiable turn is one nothing will ever end, so the no-op
branch releases the slot it sampled: clear the foreground and client-message
ids, flush the teardown waiters `replace-awaits-teardown` installs, and resolve
any pending turn identification. It releases **only** the slot this call
sampled — if identification raced a newer turn into it, that turn is live and
owns the slot, which the third test pins.

**Test-file note.** `it` arrived with `replace-awaits-teardown` and was never
added to the provider suite's `vitest` import, so the file failed to load
outright and every test in it — including the ones pinning
`replace-awaits-teardown` and `dispose-releases-foreground` — had been
silently not running. The suite now calls `test()` throughout, matching the
file's own convention, which fixes the load without touching the import.

## `force-cancel-releases-foreground`

**PR:** [#3640](https://github.com/getpaseo/paseo/pull/3640).
**Sites:** `agent-manager.ts` (`cancelAgentRunNow`), plus the facade forward in
`provider-registry.ts` and the declaration in `agent-sdk-types.ts`.

**Why.** `cancelAgentRunNow`'s force-cancel dispatches `turn_canceled`, which
resolves `runs.getMatchingWaiters` and settles the **manager's** run record.
Nothing on that path reaches the provider session, and the session clears
`activeForegroundTurnId` only on a turn end that a force-cancel means is never
coming. The slot is then held for the rest of the session: `startTurn` burns
the `replace-awaits-teardown` wait against a turn that will never end and
refuses, every retry re-wedges the seat, and only killing the app-server
process clears it. Measured four times in one hour (2026-08-24) with the other
four repairs live — none of them covers this path.

**Fix.** Release the slot the cancel targeted, before awaiting settlement so a
settle that never arrives cannot strand it. Keyed: `runTurnId` — obtained from
`this.runs.getTurnId(agentId)` and equal to the session's own `createTurnId()`
value for the canceled run — so a mismatch means a newer turn owns the slot and
keeps it.

**Why the facade forward is part of the patch, not incidental.**
`wrapSessionProvider` returns a plain object literal that hand-enumerates the
`AgentSession` surface. A method added to `CodexAppServerAgentSession` is
invisible through it, and the manager's optional-method probe finds
`undefined`. Every room provider is registry-defined and therefore wrapped, so
without the forward the release is correct code that never executes — measured
directly: the probe reported the method missing with `sessionClass: Object`
while the same session's `startTurn` demonstrably came from the patched class.
Declaring it on `AgentSession` also brings it under the wrap test's
compile-time exhaustiveness guard, which exists for exactly this omission.

**Shared release.** All three provider-local releases
(`interrupt-releases-foreground`, `dispose-releases-foreground`, and this one)
call one keyed `releaseForegroundTurn()`, so the slot has a single release
path and one test covers the waiter flush for all of them.

## `question-answer-required`

**PR:** [#3495](https://github.com/getpaseo/paseo/pull/3495), cut from
`upstream/main` so it carries no `SLP-PATCH` marker — if it lands the file
converges instead of conflicting, and this section goes.

**Sites:** `packages/server/src/server/agent/providers/claude/agent.ts` — one
extracted helper, one guard beside the normalizer, one call at the top of
`respondToPermission` — with its tests in upstream's own
`providers/claude/agent.test.ts`. Two markers, both in that one file.

**What it fixes.** A `question` permission answered in any shape but
`updatedInput.answers` keyed by one of its questions resolved as `allow` and
delivered nothing. The waiting agent was told `The user did not answer the
questions.` — an affirmative falsehood rather than silence, so neither side
could see the failure. The natural field to reach for, `selectedActionId`, is
`z.string().optional()` with no membership check and is read only for `plan`
kinds, while a question advertises `actions: undefined`.

Worse, it was unrecoverable: `respondToPermission` deletes the request from
`pendingPermissions` on entry, so the malformed answer consumed it and the retry
failed with `No pending permission request`. The guard runs **before** that
delete, and `AgentManager` drops its own copy only once the call resolves, so
both maps are intended to survive the throw and the request should stay
answerable. The committed test `a rejected question answer leaves the request
answerable by a corrected retry` proves that recoverability behaviour: it rejects
the non-deliverable answer, retries the same `requestId` with a corrected answer,
and observes the normalized answer at the waiting caller. With the M12 mutation
moving the deliverability check after `pendingPermissions.delete`, the test fails
with `No pending permission request`. Both captures are re-runs at revision
`e92e5d29434b925647b0c6f1e53322f6073d977a`, not at the census tree: under
`--bail=1` the mutated file reports 1 failed and 40 passed of 99
(`m12-qar-ordering-KILLED.log`); reverted and re-run without `--bail`, 99 pass
(`m12-qar-ordering-restored.log`). The proof is behavioural rather than a call-order
assertion, so the test guards the property the ordering exists to preserve.

**Why it lives in the Claude provider.** The answer contract is per provider,
not shared. Claude keeps an answer only when its key is a question's full text
or its header and its value is a non-empty string. Codex's
`mapCodexQuestionResponseByHeader` reads headers only, and an unmapped response
**selects each question's first option** — a supported path a shared guard would
have broken. OpenCode reads headers only as well. A first version of this patch
sat in `AgentManager.respondToPermission`, which is the join point for all three,
and so had to restate Claude's rule and scope itself with `provider === "claude"`.
That restatement drifted twice before it was correct — it trimmed keys the
normalizer does not trim, and read an empty `updatedInput.questions` array as an
absent one.

Both bugs are structurally impossible now. The check calls
`resolveClaudeAskUserQuestionAnswers`, the same function the normalizer uses to
produce the answers it delivers, so "would this deliver anything" is answered by
the code that does the delivering rather than by a copy of it. The provider
scoping is likewise structural: the guard is in the Claude provider, so no other
provider can reach it.

**Measured after the patch**, on the room's own MCP path, against a seat whose
question text is literally `" Which colour? "`:

| response                                             | result                                |
| ---------------------------------------------------- | ------------------------------------- |
| `{"behavior":"allow","selectedActionId":"Viridian"}` | rejected, still pending               |
| `{"answers":{"Which colour?":"Viridian"}}`           | rejected, still pending               |
| `{"questions":[],"answers":{"Colour":"Viridian"}}`   | rejected, still pending               |
| `{"answers":{"Colour":1}}`                           | rejected, still pending               |
| `{"answers":{" Which colour? ":"Ochre"}}`            | `success: true`, seat replied `Ochre` |

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
- **Upstream status:** closed 2026-09-08 in the feature-PR sweep. [#2879](https://github.com/getpaseo/paseo/pull/2879) carried this patch and was closed on 2026-08-11 as superseded by #3192, which took the other two and left this one because it changed the default for every existing caller. #3455 proposed `notifyMode` on the agent-scoped `create_agent` and `send_agent_prompt` schemas, with `"once"` as the default and `"each"` as the re-arming mode. This branch keeps the derived form instead — see the note above the patch list.

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
- **Upstream status:** open — [getpaseo/paseo#3094](https://github.com/getpaseo/paseo/pull/3094)
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
- **Upstream status:** closed 2026-09-08 in the feature-PR sweep — [getpaseo/paseo#3147](https://github.com/getpaseo/paseo/pull/3147) (branch `fix/canonical-detached-create-agent`, off `upstream/main`, marker and SLP wording stripped).
- **Retirement and revisit:** this patch retires when upstream owns canonical detached
  creation — either `#3147 lands first` or upstream ships a behaviorally equivalent advertised
  path some other way. In that case, drop the marker and this section during the incorporating
  sync; any later cleanup of `COMPAT(detachedCreate)` itself is upstream's own concern from
  there. The other order matters too: if `COMPAT(detachedCreate)` is removed before that — or
  rewritten enough to change what it does — do not retire this patch. Reopen it and adapt so
  `detached: true` still creates a parentless agent and still strips the injected parent label.
  `2027-01-17` is `COMPAT(detachedCreate)`'s own revisit deadline in
  `packages/server/src/server/agent/create-agent/intent.ts`, not a retirement trigger for this
  patch — the date changes no runtime behavior, it only forces a look. Removing
  `COMPAT(nestedCreateAgentPlacement)` alone does not retire this patch either: that only drops
  the hidden legacy `relationship` fallback this patch's canonical path already bypasses, and
  may just mean rebasing the explanation above.

### mcp-protocol-version-clip

Added 2026-09-09 after a two-Lead review (Codex `327815ba`, Claude `ec43aec0`,
both `needs-change` with the same must-fixes, folded in) and a third Lead
review-and-adjust (Claude `348b437`); plan and impact at
`plans/omp-mcp-protocol-skew-fix.md` / `plans/IMPACT-omp-mcp-protocol-skew.md`
(branch `plan/omp-mcp-protocol-skew-review`).

- **What:** `runAgentMcpRequest` in `packages/server/src/server/bootstrap.ts`
  normalises the `mcp-protocol-version` request header to
  `SUPPORTED_PROTOCOL_VERSIONS[0]` (`2025-11-25`) whenever it is present but
  unsupported — rewriting both `req.headers` and every
  `req.rawHeaders[i + 1]` pair whose name matches case-insensitively, then
  **collapsing duplicate raw pairs to one effective value** (Hono joins
  same-name raw pairs into a comma-separated value the SDK rejects)
  (Node preserves wire case in `rawHeaders`; `@hono/node-server` builds the
  Web Request from `incoming.rawHeaders`, so mutating only `req.headers` is a
  silent no-op).
- **Why it matters here:** seat CLIs bundle MCP clients that negotiate protocol
  versions newer than the bundled `@modelcontextprotocol/sdk` server supports —
  the Claude CLI 2.1.266 speaks `2026-07-28` (26 literal hits; it implements it
  as a live revision). The streamable-HTTP transport hard-gates every
  _non-initialize_ request on the header (`webStandardStreamableHttp.js`
  wraps the check in `if (!isInitializationRequest)`), so a seat's injected
  `paseo` MCP mount fails on its first post-initialize request with
  `Bad Request: Unsupported protocol version` and the daemon logs a level-50
  `Agent MCP transport error` after claude seat creations (measured 2026-09-09:
  5 errors against 6 mount-bearing claude creations in the daemon logs — a
  rate, not a fixed count; claude peers never mount the endpoint).
  `initialize` itself is exempt and its body-param negotiation is already soft
  (`server/index.js`), so clipping only the header leaves the response honest.
  The clip lets the seat's injected mount complete its post-initialize
  requests; peers never mount the endpoint (`claude-room:169`,
  `omp-room:174-176`), so this only reaches non-peer seats.
- **Scope:** `bootstrap.ts` `runAgentMcpRequest` only; no SDK
  (`node_modules/@modelcontextprotocol/sdk`, hoisted, not vendored) and no
  other file. Four e2e cases in `agent-mcp.e2e.test.ts` prove it
  (`2026-07-28`, `DRAFT-2026-v1`, the `2025-11-25` untouched control, and
  duplicated raw headers collapsing to one effective value),
  red before the patch (the client's `notifications/initialized` gets the 400)
  and green after.
- **Upstream status:** open — [#4570](https://github.com/getpaseo/paseo/pull/4570),
  branch `fix/mcp-protocol-version-clip-upstream` off `upstream/main`
  (`fdf3b4b47`), marker and SLP wording stripped (same pattern as
  #4434/#3094/#3455). Expected to be **superseded when the
  bundled `@modelcontextprotocol/sdk` learns `2026-07-28`** (`npm view
@modelcontextprotocol/sdk version` is 1.30.0 as of 2026-09-09 and its dist
  still carries only `2025-11-25`/`DRAFT-2026-v1`); when that lands, the next
  `upstream/main` sync drops the markers and this section per the convention.

### native-tools-injection-independent

Opened the same day the 2026-09-07 sync retired `native-tools-optin`, after a
Lead review showed the retirement alone breaks the room. It was closed on
2026-09-08 in the feature-PR sweep — see the table above and
[#4434](https://github.com/getpaseo/paseo/pull/4434).

- **What:** upstream #4277 kept `agentManager.setPaseoToolsEnabled` and the
  provider-runtime catalog switch tied to MCP injection
  (`mcpEnabled && mcp.injectIntoAgents !== false`) at bootstrap startup and at
  both live field-change handlers (`mcp.enabled`, `mcp.injectIntoAgents`). A
  deployment that serves MCP caller-scoped — injection off — therefore loses
  the native catalog entirely, whatever its per-provider policy says, which is
  the original defect #3449 existed to close. This fork calls a fork-owned
  gate, `isNativePaseoToolsEnabled(mcpEnabled)` (`native-tools-gate.ts`), at
  those sites instead: the catalog's master enable follows the MCP stack being
  enabled, and injection controls only the injected MCP server
  (`agentMcpBaseUrl`/`setMcpBaseUrl`), never the native catalog.
- **Why here:** the room runs `daemon.mcp.injectIntoAgents: false` (launchers
  give each seat caller-scoped servers) while its omp Supervisor and Lead seats
  must receive the native catalog and its omp Peer seat must not. Under merged
  upstream, `#4277`'s per-provider policy cannot help: it is a second gate on
  top of a `paseoToolsEnabled` that injection already forced to false.
- **Coverage:** `native-tools-gate.slp.test.ts` pins the room's live shape
  (mcp enabled + injection off ⇒ catalog available), the two other helper
  branches, and a source-level check that every `setPaseoToolsEnabled` /
  `setAgentProviderToolsEnabled` call in `bootstrap.ts` passes the fork gate
  and never an injection expression. A booted-daemon regression for the live
  field-change handlers remains uncovered; activation verifies delivery on
  fresh omp seats.
- **Counting note:** on upstream tag `v0.8.0` (`b8e24677e`),
  `rg -n 'setAgentProviderToolsEnabled|setPaseoToolsEnabled' packages/server/src/server/bootstrap.ts`
  returned eight hits at lines 1429, 1433, 1434, 1606, 1611, 1612, 1616, and 1617. Line 1429 is the helper definition, not a call, so there are seven
  call sites. The earlier count of five missed a block; the count of eight
  included the definition. All seven call sites remain coupled to
  `mcpInjectIntoAgents`/`inject`/`value`, so the patch is still needed. When
  recounting, state whether the grep includes the definition.
- **Retirement and revisit:** if upstream decouples the native master from MCP
  injection on its own — or accepts this patch — delete the marker sites, this
  section, and the fork-owned gate module.

### dead-run-settles

`packages/server/src/server/agent/providers/codex-app-server-agent.ts` — one
marker, in `interrupt()`.

**It had no section here until 2026-08-26**, while being named in the PR table,
in the cluster rationale, and inside four other patches' sections, so a reader
scanning headings concluded it was gone.

Scanning headings does not enumerate the patches anyway, and nothing in this file
said so until now: five patches are documented as `##` sections _above_
`## Patches`, and seven as `###` sections under it. At
`HEAD=e92e5d29434b925647b0c6f1e53322f6073d977a`,
`sed -n '/^## Patches$/,/^## Sync procedure$/p' PATCHES.md | rg -c '^### '
measured **7** lower-level patch sections, so neither level alone lists them
all. The roster is the marker manifest in `Sync procedure`, plus
`archived-live-list`, which carries no marker. That mattered more than a missing heading
usually does: it is the patch nearest the region upstream rewrote in #3742, so
it is the one most likely to need re-applying by hand, and it had the least
written intent to re-apply _from_.

**What it changes.** Codex accepted `turn/start` but never published a native
turn id, so there is nothing identifiable to interrupt. Upstream throws.
This resolves instead, matching the claude and acp providers.

**Why.** A throw leaves the manager reading the cancel as unacknowledged, and
it then refuses every later stop and replace for the rest of the session.
Resolving lets the existing acknowledged-timeout force-cancel settle the
orphaned run.

**Carried in #3640**, squashed with `interrupt-releases-foreground` into one
commit — the two are one repair read from two sides: this one decides not to
throw, that one releases the foreground slot the no-op branch had sampled.
Separating them would land a resolve that leaks a slot.

**Its test lives in upstream's own file** (`codex-app-server-agent.test.ts`),
which is where a silent reversal arrives. Note the recorded episode where that
whole suite failed to load for a period because `it` was never imported, so the
tests pinning this cluster "had been silently not running" — a marker check
would not have noticed either.

### archived-live-list

**This patch carries no `SLP-PATCH(` marker, by design** — so `rg` cannot
see it, and a silent reversal during a sync leaves nothing to grep for. Its
survival check is **behavioural, not textual**: after any merge, an archived
agent hydrated by a history read must stay out of a default `list_agents`
and must report a real `archivedAt` under `includeArchived: true`. Run that,
not a marker count. It was also missing from the PR table above until
2026-08-26 — the mirror of `dead-run-settles` having a table row and no
section.

- **What:** an archived agent is resumed back into memory whenever something reads its
  history — `agent-loading.ts` passes `{ purpose: "history" }` to
  `resumeAgentFromPersistence` exactly when `record.archivedAt` is set. Its id is then in
  the manager's map, so `list_agents` treats it as live and the stored branch drops it
  (`!liveIds.has(record.id)`). The stored record is the only carrier of the archive
  timestamp, so the value and the archive filter went with it: the agent came back as live
  with `archivedAt: null`, and `includeArchived: false` returned it anyway because that
  filter only ever ran on the stored branch. The protocol declares the field
  `z.string().nullable().optional()`, so the omission validated silently. The fix keeps
  storage the single owner — `serializeSnapshotWithMetadata` merges the stored record at
  the MCP boundary, reusing the read it already did for the title, and archive filtering
  moves to the combined live-plus-stored list.
- **Why it matters here:** this stopped the room. A Supervisor reconciling project
  ownership read an archived Lead as live and refused to proceed, correctly, on data that
  was wrong. It then recurred while the review of its own fix was running: reading the
  archived Lead's and Peer's transcripts resurrected both, and the next sweep found two
  seats it had already closed. Whole-project ownership reconciliation is built on this
  call, so it can invent an owning Lead from an archived one.
- **No `SLP-PATCH` marker, deliberately.** The diff is byte-identical to the upstream PR,
  so if upstream takes it the files converge instead of conflicting — the same reasoning
  recorded above for `detached-arg`'s and `question-answer-required`'s tests. Nothing here
  needs re-applying by hand; if the PR lands, delete this section.
- **Rejected alternative, recorded because it is the tempting one:** carrying `archivedAt`
  on `ManagedAgent`. `unarchiveSnapshot` clears only the stored record and then notifies,
  so a managed copy survives the unarchive and reports a live agent as archived until it
  is reloaded — a second owner of state that one transition forgets to update, which is
  the same bug in mirror image. Review caught this; it was not caught by writing it.
- **Upstream status:** open — [getpaseo/paseo#3803](https://github.com/getpaseo/paseo/pull/3803),
  branch `fix/archived-agents-in-live-listing` off `upstream/main`. Coverage lives in
  upstream's own `packages/server/src/server/agent/mcp-server.test.ts`, beside the archive
  cases it extends; two of the three tests are mutation-checked, and the third is labelled
  in-file as a structural guard that passes on unfixed code.

## Sync procedure

First, derive the patch-owned file manifest, then check whether upstream touched
any of it since the last sync.

The fork has a Supervisor-granted exception for `evidence/080-mutants/`: its
durable mutation census artifact may be committed because the census needs
citable evidence, and the audit found its provenance too thin. The directory
is fork-only and never converges upstream. Carry it at the next merge; do not
drop it as an apparent upstream addition. Its contents remain evidence rather
than sync narrative.

**The manifest is derived, never restated.** Every hand-kept total in this file
has been wrong at least once — nine patches when there were eleven, five source
files when there were far more, and a marker count that could not pass on a
healthy tree. A number nobody can regenerate is a number nobody can check.

```bash
git fetch upstream

# UPSTREAM_OID is the one value this procedure will NOT derive for you, and the
# refusal is the point. Read the ref once, review THAT commit, then paste the
# literal in. Everything below -- derivation, dry run, merge -- consumes the
# variable and never re-reads the ref, because a procedure that re-resolves
# after a fetch can verify one commit and merge another.
#
#     git rev-parse upstream/main     # read it, go review that commit, then:
#     UPSTREAM_OID=<the 40-char OID>  # a literal, pasted, not a substitution
#
[ -n "${UPSTREAM_OID:-}" ] && [ ${#UPSTREAM_OID} -eq 40 ] || {
  echo "set UPSTREAM_OID to a literal 40-char OID you have reviewed"; exit 1; }

# It need not be the tip -- deliberately merging an older reviewed commit is a
# legitimate choice -- but it must still exist on upstream's line.
git merge-base --is-ancestor "$UPSTREAM_OID" upstream/main || {
  echo "UPSTREAM_OID is not an ancestor of upstream/main: history was rewritten"; exit 1; }
[ "$UPSTREAM_OID" = "$(git rev-parse upstream/main)" ] || {
  echo "NOTE: upstream/main has moved past UPSTREAM_OID. That is allowed, but it"
  echo "is a decision -- record which commit you chose and why, before merging."; }

BASE=$(git merge-base HEAD "$UPSTREAM_OID")

# Set A -- everything a patch owns, and nothing else. A patch is a change this
# fork made, so the files a patch owns are exactly the files the fork changed.
# No marker grep, no curated list: both were proxies for this, and both leaked.
# (The grep once missed native-tools-optin.slp.test.ts, whose header read
# "SLP-PATCH coverage (...)" with a space; that file left with its patch in the
# 2026-09-07 sync.)
git diff --name-only "$BASE" HEAD -- packages/ | sort > /tmp/set-a.txt

# Set B -- the diff argument. Fork-only files cannot appear in an upstream diff.
grep -v '\.slp\.test\.ts$' /tmp/set-a.txt > /tmp/set-b.txt
git diff --name-only "$BASE" "$UPSTREAM_OID" -- $(cat /tmp/set-b.txt)
```

On current tip `HEAD=e92e5d29434b925647b0c6f1e53322f6073d977a`, with
`UPSTREAM_OID=b8e24677e12b226c7c38c1c3a40649daa9f1152f`, and
`BASE=$(git merge-base HEAD "$UPSTREAM_OID")`, the documented
`git diff --name-only "$BASE" HEAD -- packages/ | sort` invocation returned
the same patch-owned file list as the pre-merge measurement: **23 files** for
Set A; filtering `.slp.test.ts` returned **20** for Set B. The difference from Set A is the three
fork-only `.slp.test.ts` files, which cannot appear in an upstream diff. Set B
itself still contains one fork-only file, `native-tools-gate.ts`, so only **19**
of its arguments can match an upstream diff. Both numbers are outputs of the
that command, not claims: regenerate them, do not trust them.

Set A is wider than the marker set on purpose, and by more than you would guess.
Ask it, do not estimate it:

```bash
git grep -l 'SLP-PATCH' HEAD -- packages/ | sed 's|^[^:]*:||' | sort > /tmp/marked.txt
comm -23 /tmp/set-a.txt /tmp/marked.txt        # patched, but nothing to grep for
```

At the 2026-08-26 sync that was **11 of 27** — five source files
(`force-cancel-releases-foreground`'s interface and facade, and all of
`archived-live-list`) and six test files, every one of them owned by upstream.
A marker gate is blind to all eleven, which is why the diff runs on Set A and not
on the marker set.

It is also _narrower_ than the watch list you might reach for. `agent-prompt.test.ts`
and `create-agent/create.test.ts` are upstream's own suites for two patched source
files, and this fork has never touched either, so they are not patch-owned and do
not belong in a set that answers "what does a patch own". They are still run after
every merge — see the test list below. Coverage comes from the test list; the
manifest only answers ownership. Conflating the two is what put them in a curated
list nothing could regenerate.

Empty output means a conflict-free merge for the patches. Non-empty output is the normal
case once patches start landing, and it means read the upstream commits before merging —
a patch of yours may have landed, been redesigned, or had its insertion point rewritten.
`git log "$BASE".."$UPSTREAM_OID" -- <file>` names them.

**Dry-run the merge before committing to it.** `git merge-tree --write-tree`
performs the whole merge in the object store and touches nothing — it prints the
resulting tree OID on success, or the conflict list and a non-zero exit. Then
every post-merge check below can be run against that tree first, so a merge that
would lose a patch is discovered before there is anything to undo.

```bash
# On a clean merge this prints one line, the tree OID, and exits 0. On conflict
# it exits non-zero and the lines after the OID name the conflicted paths.
out=$(git merge-tree --write-tree --name-only HEAD "$UPSTREAM_OID"); rc=$?
T=$(printf '%s\n' "$out" | head -1)
[ $rc -eq 0 ] || { echo "CONFLICTS:"; printf '%s\n' "$out" | tail -n +2; }

# The same marker gate, against the merged tree. Note -h here means
# --no-filename: that is git grep, not ripgrep, where -h is --help.
git grep -c  "SLP-PATCH(" "$T" -- packages/ | awk -F: '{n+=$NF} END {print n}'
git grep -oh "SLP-PATCH([a-z-]*)" "$T" -- packages/ | sort -u | wc -l

# The wakeup-each / timeline_replacement shape, without checking anything out.
git cat-file -p "$T:packages/server/src/server/agent/agent-prompt.ts" \
  | grep -n 'SLP-PATCH(wakeup-each)\|timeline_replacement\|event.event.type ==='
```

The last one is the check no marker count can make. Upstream guards
`timeline_replacement` with an early `return` inside `setupFinishNotification`,
and that variant carries no `.event`. The guard must land **above** every
`event.event.type` read; below them, the first replacement event throws inside
the watcher that makes a caller hear its children finish, and every marker is
still present.

Then merge:

```bash
git merge "$UPSTREAM_OID"     # the pinned OID, not the ref: a ref re-read at
                              # merge time can differ from the one you checked

# Marker gate. On `HEAD=e92e5d29434b925647b0c6f1e53322f6073d977a`, measured
# 2026-09-11, the package-scoped command below summed to 30 sites; expect
# 11 names across 30 code/test sites in 12 files, and use the per-name
# manifest below -- a bare total hides a site moving from one patch to another.
# This file is excluded because it quotes marker-shaped strings in its own
# prose, in a number that changes whenever the prose does; include it and the
# gate can never pass on a healthy tree. Note -I (--no-filename): -o alone
# prefixes each match with its path, so sort -u would dedupe path:name pairs
# and return one line per file, not per name.
rg -c "SLP-PATCH\(" packages/ | awk -F: '{n+=$2} END {print n" sites"}'
rg -oI "SLP-PATCH\([a-z-]+\)" packages/ | sort -u | wc -l  # expect 11
rg -oI "SLP-PATCH\([a-z-]+\)" packages/ | sort | uniq -c | sort -rn
#    6 native-tools-injection-independent   2 force-cancel-releases-foreground
#    4 wakeup-each                          2 detached-arg
#    3 replace-awaits-teardown              3 interrupt-releases-foreground
#    3 detached-wakeup                      1 dispose-releases-foreground
#    2 question-answer-required             1 dead-run-settles
#    3 mcp-protocol-version-clip
# The census is scoped to packages/ because that is the measured code/test
# population; evidence/080-mutants/MUTANTS.md quotes the marker in prose.
# archived-live-list is absent from this manifest by design -- it carries no
# marker, so its survival check is behavioural (see its section below).

npm ci --ignore-scripts       # the lockfile moves on any non-patch bump;
                              # building without it resolves the old graph

# --ignore-scripts is deliberate -- a just-merged upstream should not get to run
# arbitrary install scripts -- but this repo NEEDS its own postinstall. At
# `HEAD=e92e5d29434b925647b0c6f1e53322f6073d977a`, `find patches -maxdepth 1
# -type f | wc -l` measured **8** dependency patch files, applied by
# scripts/postinstall-patches.mjs, and
# react-native-draggable-flatlist+4.0.3.patch adds the very prop that
# sidebar-workspace-list.tsx passes down. Skip this and @getpaseo/app fails
# typecheck with TS2322 on a prop that "does not exist". Read the script, then
# run it -- via npm, so node_modules/.bin is on PATH; calling node directly
# fails with `patch-package ENOENT`.
npm run postinstall

# Build BEFORE typechecking, and do not skip this because the merge "looks
# clean". --ignore-scripts means no workspace built, so every cross-package
# declaration is whatever dist held before -- and a merge that adds a protocol
# module leaves the server importing a file no dist has. The 0.6.1 sync failed
# here on @getpaseo/protocol/gitlab-pipeline: src had it, dist did not, and the
# error reads as upstream breakage. Same shape as the pluginThemes trap in the
# 2026-08-22 sync, one package over.
npm run build:server

npm run typecheck             # the WHOLE workspace, not typecheck:server.
                              # typecheck:server catches a new union member
                              # across session.ts and hub/daemon-executions.ts,
                              # which no test does -- but it cannot see the app
                              # or desktop, and the 0.6.1 sync broke exactly
                              # there. The pre-commit hook runs the full one
                              # regardless, so a server-only check just moves
                              # the failure to your first commit.

npx vitest run packages/server/src/server/agent/agent-prompt.slp.test.ts --bail=1
npx vitest run packages/server/src/server/agent/agent-prompt.test.ts --bail=1
npx vitest run packages/server/src/server/agent/create-agent/create.slp.test.ts --bail=1
npx vitest run packages/server/src/server/native-tools-gate.slp.test.ts --bail=1
npx vitest run packages/server/src/server/agent/create-agent/create.test.ts --bail=1
npx vitest run packages/server/src/server/agent/provider-registry-wrap.test.ts --bail=1
npx vitest run packages/server/src/server/agent/mcp-server.test.ts
npx vitest run packages/server/src/server/agent/providers/claude/agent.test.ts
npx vitest run packages/server/src/server/agent/providers/codex-app-server-agent.test.ts
npx vitest run packages/server/src/server/agent/agent-manager.test.ts
npx vitest run packages/server/src/server/agent/mcp-parity.e2e.test.ts   # diff vs baseline
npx vitest run packages/server/src/server/agent/agent-mcp.e2e.test.ts     # mcp-protocol-version-clip

npm run format:check

# Lint was measured on HEAD with `npm run lint`: Found 0 warnings and 0 errors.
# The former two-error baseline was stale; commit
# `06ac487da8bc1b2398eaedba11da4d3fff958938` fixed the `complexity 24 > 20`
# error in `interrupt()` and `no-multiple-resolved`, both in
# `codex-app-server-agent.ts`. Measure lint again after each merge.
npm run lint
git push origin slp/patches
```

Order matters. Typecheck first — it fails fastest and on the class of breakage
a merge introduces. Then the `.slp.` files, which this fork owns and which are
the cheapest signal. Then the upstream-owned suites, which are where a patch
contradicting upstream intent surfaces.

`mcp-parity.e2e.test.ts` is the only one without `--bail=1`, because it fails
in this environment before and after a sync. **Re-measure the baseline before
merging** — without it you cannot tell a pre-existing failure from one the merge
caused. Measured twice on 2026-08-26 at `8fdca94ea`, 33 tests:

| Suite              | Failing                                                                                                                                                                                | Kind                          | Stable?                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------- |
| E (worktree tools) | `list_worktrees on empty repo`, `create_worktree and list_worktrees`, `archive_worktree removes worktree`, `archive_worktree succeeds when caller cwd is inside the archived worktree` | `ZodError` / `AssertionError` | yes — 4/4 both runs       |
| D (provider tools) | `list_providers returns providers`, `list_profiles returns configured agent profiles, including notes`                                                                                 | `Test timed out in 5000ms`    | **no** — 2 failed, then 1 |

So the gate is not a failure count. **Suite E's four names are the baseline.**
A Suite D timeout is machine load against a 5 s default, not merge damage —
re-run before concluding. Anything else is the merge's: a failure outside D and
E, a _non-timeout_ failure in D, or a fifth name in E.

Two of these were missing from this list until 2026-08-26:
`provider-registry-wrap.test.ts` and `mcp-server.test.ts` — the two covering
`force-cancel-releases-foreground` and `archived-live-list`. A third,
`native-tools-optin.slp.test.ts`, joined on that date and left on 2026-09-07
when its patch retired.

Run the upstream-owned files (`agent-prompt.test.ts`, `create.test.ts`, both provider
suites, `agent-manager.test.ts`) too, not just the `.slp.` ones: they are the tripwire for a
patch that contradicts upstream intent, which is how `detached-wakeup` got redesigned before
landing — and how the 2026-08-22 sync's contradicting codex test surfaced. When a run fails
on an upstream assertion that a carried patch deliberately changed, adapt that assertion in
place with a comment naming the patch and its PR; do not restore upstream's expectation and
do not silently delete the case.

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
