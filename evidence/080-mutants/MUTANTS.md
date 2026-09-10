# Mutation census — twelve carried patches on tree 4d1275495d92e92cec32e1ab6950c4601ccccf97

Method: mutate production code only, keep every test, require a named assertion failure,
restore to green. Controls on the same tree: `control-*.log`. Every mutant reverted with
`git checkout --`; the census ran against a tree byte-identical to
`4d1275495d92e92cec32e1ab6950c4601ccccf97`. One test was added afterwards to close the M12
coverage hole (`providers/claude/agent.test.ts`); it is the only non-`evidence/` change on this
branch, and no production code moved. That test carries no patch marker: it lives in an
upstream-owned file, and the convention keeps those files marker-free so upstream #3495 converges
instead of conflicting. Marker census on this branch, excluding `PATCHES.md` and `evidence/`:
11 names, 30 sites, 12 files — unchanged from `683d6e776`.

| #    | Patch                                             | Mutant                                                                    | Result       | Killing assertion                                                                                                                                                                            |
| ---- | ------------------------------------------------- | ------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M05  | replace-awaits-teardown                           | `FOREGROUND_TEARDOWN_WAIT_MS = 0` (codex-app-server-agent.ts)             | KILLED       | "waits out a clearing foreground turn instead of refusing" — expected `pending`, got rejection                                                                                               |
| M06a | interrupt-releases-foreground                     | drop release on unidentified interrupt                                    | KILLED       | "releases the foreground slot when no turn was ever identified"                                                                                                                              |
| M06b | interrupt-releases-foreground                     | drop keyed release on already-idle interrupt                              | KILLED       | "flushes a queued startTurn when Codex reports the interrupted turn is already idle"                                                                                                         |
| M07  | dispose-releases-foreground                       | drop release in `disposeClient()`                                         | KILLED       | "releases the foreground slot when the client is disposed"                                                                                                                                   |
| M08  | dead-run-settles                                  | throw instead of no-op on unidentifiable interrupt                        | KILLED       | two tests: "releases … no turn was ever identified", "leaves the foreground slot to a newer turn that raced into it"                                                                         |
| M09  | force-cancel-releases-foreground                  | drop `releaseForegroundTurn?.(runTurnId)` in agent-manager                | KILLED       | "cancelAgentRun force-cancel releases the session's foreground slot"                                                                                                                         |
| M10  | force-cancel-releases-foreground (facade)         | `releaseForegroundTurn: undefined` in provider-registry                   | KILLED       | "forwards every optional AgentSession method" — a runtime `recordedCalls` equality at provider-registry-wrap.test.ts:192                                                                     |
| M11  | question-answer-required                          | make the deliverability helper always accept                              | KILLED       | 11 rejection tests in claude/agent.test.ts                                                                                                                                                   |
| M12  | question-answer-required (ordering)               | move the deliverability check after `pendingPermissions.delete`           | KILLED       | "a rejected question answer leaves the request answerable by a corrected retry" (added this round)                                                                                           |
| M13  | detached-arg                                      | read `parsed.detached` as `false`                                         | KILLED       | "create_agent detached:true omits the parent agent label"                                                                                                                                    |
| M14  | detached-arg (schema)                             | restore `.default(false)` on the schema field                             | KILLED       | 3 new failures over a 4-failure control (7 failed / 26 passed of 33, vs 4 failed / 29 passed): `ZodError` from `createChildAgent` — `create_agent` never returns, so no label assertion runs |
| M15  | detached-wakeup                                   | hardcode `requireParentOwnership: true`                                   | KILLED       | "a deliberately detached child does not have its wakeup gated on parent ownership"                                                                                                           |
| M16  | wakeup-each                                       | disarm after first finish (`hasSeenRunning = false` → notify once)        | KILLED       | "the watcher re-arms: every finish of the child notifies the caller"                                                                                                                         |
| M17  | wakeup-each (archived disarm)                     | drop the archived-caller disarm                                           | KILLED       | "an archived caller disarms the watcher instead of leaking it"                                                                                                                               |
| M18  | native-tools-injection-independent                | gate default `(mcpEnabled ?? true) !== false` → `=== true`                | KILLED       | "absent mcp.enabled defaults to enabled (upstream default)"                                                                                                                                  |
| M19  | native-tools-injection-independent (bootstrap)    | re-couple native catalog to `mcp.injectIntoAgents` at a field-change site | KILLED       | source-level gate test: "bootstrap gates the native catalog on mcp.enabled alone, never on MCP injection"                                                                                    |
| M20  | native-tools-injection-independent (live handler) | behaviour-equivalent re-couple through a boolean temp                     | **SURVIVED** | textual gate test only; no booted-daemon coverage — see disposition                                                                                                                          |
| M21  | mcp-protocol-version-clip                         | skip the rawHeaders rewrite                                               | KILLED       | three e2e cases in agent-mcp.e2e.test.ts (`2026-07-28`, `DRAFT-2026-v1`, normalisation)                                                                                                      |
| M22  | mcp-protocol-version-clip (duplicates)            | drop the duplicate-collapse loop                                          | KILLED       | "duplicate mcp-protocol-version raw headers collapse to one effective value" — expected 400 to be 200                                                                                        |
| M24  | archived-live-list                                | drop `archivedAt` from `serializeSnapshotWithMetadata`                    | KILLED       | "excludes an archived agent that is also live from list_agents"; "reports the archive timestamp of a live archived agent"                                                                    |
| M25  | archived-live-list (filter)                       | make the combined-list archive filter a no-op                             | KILLED       | two tests: "defaults list_agents to caller cwd and excludes archived agents" (length 3 → 4), "excludes an archived agent that is also live from list_agents"                                 |

**Population: 21 mutants** (20 killed, 1 survived), one log each, all listed above. M12 survived
the first run against the tree as merged (`m12-qar-ordering-SURVIVED.log`); that survival is the
evidence that the test was missing, and the log is kept for it. **The M12 kill is a re-run on a
later revision, not the original measurement** — see "M12 re-run provenance" below. One further
run — M23 — was made and discarded as mis-targeted; it is not a mutant of this population and is
recorded below with its log. A sixth flush-site sub-population (M26) was measured after the audit;
it is listed in "Flush-site sub-population (M26)" and is not counted in the 21.

## Id space

The ids are not dense, and nothing is missing.

- **M01–M04 were never run.** No mutation was ever assigned to those ids and no log exists for
  them. The sequence began at M05 through an accident of numbering while surveying the codex
  cluster; every mutation actually executed is in the table above. I record this rather than
  renumbering, because renumbering after the fact would make the logs disagree with the report.
- **M23 was run and discarded as mis-targeted, not survived.** It mutated the `record.archivedAt ?
{ purpose: "history" } : undefined` line in `agent-loading.ts`, which is upstream-owned code the
  `archived-live-list` patch does not touch. `mcp-server.test.ts` stayed green (122/122), which is
  the correct outcome for mutating a non-patch site and proves nothing either way about the patch.
  Re-targeting to the patch's real sites produced M24 and M25, both killed. Log:
  `m23-mistargeted-agent-loading.log`.

## Constituent coverage

- **replace-awaits-teardown** — M05 proves the bounded wait at the top of `startTurn`. It does
  **not** prove the `flushForegroundTurnClearWaiters()` call sites individually. M26 measures each
  of the five call sites directly: all five killed, including line 4301 (the `turn/start` failure
  path), corrected from NOT KILLED after the first pass. See "Flush-site sub-population (M26)".
- **interrupt-releases-foreground** — two of its marker sites killed (M06a, M06b). The third
  marker (the extracted-helper comment at `interruptIdentifiedTurn`) is documentation of a
  refactor, not behaviour, and has no mutable content.
- **force-cancel-releases-foreground** — M09 proves the manager call. M10 proves the registry
  facade forwards the call at runtime — `wrapSessionProvider` is invoked, `releaseForegroundTurn`
  is called through the wrapper, and the recorded call list is compared — and nothing more. The
  `agent-sdk-types.ts` declaration is a type-only site, exempt from mutation because erasing it
  changes no emitted code, so M10 does not reach it. A compile-time guard for it does exist —
  `_allOptionalAgentSessionMethodsAreCovered` plus the `satisfies` on
  `OPTIONAL_AGENT_SESSION_METHOD_NAMES`, provider-registry-wrap.test.ts:12–39 — but M10 is a
  value-level mutation and does not trip it, and no committed artifact here shows it firing.
  Whether removing the declaration fails compilation is **NOT MEASURED**; closing it would take a
  `npm run typecheck` capture with the declaration removed, which was not run this round.
- **question-answer-required** — M11 proves the rejection rule. The _ordering_ half of the patch
  ("before the delete, so a rejected answer leaves the request pending and answerable") had no
  committed test: M12 survived the merged tree. It is now covered by "a rejected question answer
  leaves the request answerable by a corrected retry" in `providers/claude/agent.test.ts`, which
  rejects a non-deliverable answer against a live `pendingPermissions` entry, then asserts a
  corrected retry against the same `requestId` resolves and delivers the answer to the waiting
  caller. The test is an observation of behaviour through `respondToPermission`, not an assertion
  about call order. Positive control: with the check moved after the delete, exactly this test
  reds on an assertion (`promise rejected "Error: No pending permission request with…" instead of
resolving`, `m12-qar-ordering-KILLED.log`); reverted, the file is 99/99 green
  (`m12-qar-ordering-restored.log`). Both captures are re-runs — see "M12 re-run provenance".
- **native-tools-injection-independent** — M18/M19 prove the gate function and the bootstrap
  source shape. M20 confirms what PATCHES.md already records: the live `mcp.enabled` /
  `mcp.injectIntoAgents` field-change handlers have **no booted-daemon coverage**; the only guard
  is a textual scan of `bootstrap.ts`, which a behaviour-equivalent rewrite walks past.
- **archived-live-list** — M24 and M25 each red two tests and share one of them. Both red
  "excludes an archived agent that is also live from list_agents", so that test alone separates
  neither mutant from the other; the discriminating failure is the second one in each case. M24's
  is "reports the archive timestamp of a live archived agent" (`expected null to be
'2026-09-10T16:57:51.480Z'`), which is what ties M24 to the stored `archivedAt` merge. M25's is
  "defaults list_agents to caller cwd and excludes archived agents" (length 3 → 4), which is what
  ties M25 to the combined-list filter.

  Both are **seeded-state boundary tests**. The live/archived overlap they depend on is asserted
  into existence by fixtures, not produced: `spies.agentManager.listAgents.mockReturnValue([...])`
  supplies the live agent and `spies.agentStorage.list/get` supply the archived record
  (`mcp-server.test.ts:5510`, `:5544`). That exercises the real filter and the real serializer at
  the MCP boundary, which is what the two mutants prove.

  It is not the survival check PATCHES.md:661-662 specifies for this patch, which is that an
  agent **hydrated by a history read** stays out of a default `list_agents` and reports a real
  `archivedAt` under `includeArchived: true`. No test here performs that read:
  `resumeAgentFromPersistence` and `hydrateTimelineFromProvider` are `vi.fn()` stubs
  (`mcp-server.test.ts:217-218`) and the archived-live-list cases never invoke them — the
  comment at `:5505-5508` states the hydration as the fixture's premise rather than running it.
  **The history-hydration half of the survival check is NOT MEASURED.** Closing it takes a test
  that resumes an archived agent through a real history read and then calls `list_agents` twice,
  default and `includeArchived: true`; that test was not written this round.

  This is the one patch with no `SLP-PATCH` marker by design, so the behavioural check is all
  that stands between it and silent loss at a future sync. M24 and M25 are half of that check.
  The patch carries no `SLP-PATCH` marker by design, so "remove the marker and see" has no
  meaning for it; its survival check is behavioural, and these two mutants cover only the
  seeded-state boundary checks.

- **detached-arg / detached-wakeup / wakeup-each / mcp-protocol-version-clip** — every marker
  site in these four has a killed mutant above except the `paseo-tools.ts:1592` detached-arg
  comment site, which restates the schema field M14 proves load-bearing — M14 kills by breaking
  `create_agent` outright, not by the parent-label behaviour.

## Flush-site sub-population (M26)

Measured after the audit, against revision `e92e5d29434b925647b0c6f1e53322f6073d977a` plus the
`codex-app-server-agent.test.ts` additions in this commit. Mutation: replace the single statement
`this.flushForegroundTurnClearWaiters();` at the named line with a comment, one line at a time.
Mutator: `m26-flush-site-mutator.py` (argument = line number). Exact diff per site:
`m26-flush-site-<line>.diff`. Invocation, once per site, from `packages/server`:

    npx vitest run src/server/agent/providers/codex-app-server-agent.test.ts

| Site | Method                            | Result | Killing assertion                                                             |
| ---- | --------------------------------- | ------ | ----------------------------------------------------------------------------- |
| 3578 | `handleUnexpectedTermination`     | KILLED | "frees a startTurn queued behind the slot when the app-server dies"           |
| 4301 | `startTurn` turn/start failure    | KILLED | "frees a startTurn queued behind a slot whose turn/start is refused by Codex" |
| 4970 | `releaseForegroundTurn`           | KILLED | "frees a startTurn queued behind a stuck slot when the slot is released"      |
| 4983 | `close()`                         | KILLED | "frees a startTurn queued behind a stuck slot when the session closes"        |
| 6121 | `handleTurnCompletedNotification` | KILLED | "frees a startTurn queued behind the slot when the turn completes normally"   |

Logs: `m26-flush-site-<line>.log`. All five kills are measured. Four of them come from tests
added in this commit (3578, 4301, 4983, 6121); 4970 was already covered.

**What the restoration evidence is.** Per site there is an exact mutation diff
(`m26-flush-site-<line>.diff`) and an individual red capture (`m26-flush-site-<line>.log`). Green
afterwards is thinner than that, and the logs' own start times say how much thinner:

| Capture                              | Start at |
| ------------------------------------ | -------- |
| `m26-flush-site-3578.log`            | 00:48:40 |
| `m26-flush-site-4970.log`            | 00:48:51 |
| `m26-flush-site-4983.log`            | 00:48:56 |
| `m26-flush-site-6121.log`            | 00:49:02 |
| `control-codex-app-server-agent.log` | 01:01:21 |
| `m26-flush-site-4301.log`            | 01:01:35 |

`control-codex-app-server-agent.log` (162/162) ran after all four of the early mutations were
reverted, so it is **one collective green capture covering those four sites together**. It is not
four per-site restoration captures, and no such per-site captures were taken. Read with the four
mutation diffs and the tree-identity check, it supports the claim that no residue from any
individual early mutation remains; it does not support "each of the four sites was restored to
green", which would be four measurements that do not exist.

4301 ran at 01:01:35, after that control, so the control says nothing about it. Its restoration is
`m26-flush-site-4301-restored.log`, captured separately at revision
`512bdd0078e63a4f61f60d4693fa4b724f13da22` with a clean working tree, all five
`flushForegroundTurnClearWaiters()` call sites present at their recorded lines and no `MUTANT:`
residue anywhere under `packages/`: 162/162. That revision is later than the one the
sub-population was mutated against; the mutated source and the asserting test file are unchanged
between them, which is what makes the capture applicable.

4301 was recorded NOT KILLED in the first pass of this sub-population, on the stated grounds that
the harness could not pair a rejecting `turn/start` with a second prompt queued behind the slot.
That was wrong, and the correction is measured, not argued: `createFakeCodexAppServer` dispatches
per method and rejects when its handler rejects, and a second `startTurn` against a live
`CodexAppServerAgentSession` registers a waiter without any special support. The re-measured run
is the one in the table; `m26-flush-site-4301.log` is that run.

## M12 re-run provenance

`m12-qar-ordering-KILLED.log` and `m12-qar-ordering-restored.log` are **re-runs produced after the
audit**, not the original measurement. The originals were cited by this file but never committed
and are unrecoverable.

- Revision: `e92e5d29434b925647b0c6f1e53322f6073d977a`, working tree differing from it only in
  `packages/server/src/server/agent/providers/codex-app-server-agent.test.ts` (unrelated file;
  neither the mutated source nor the asserting test is in it).
- Mutation: `m12-qar-ordering.diff` — move `this.pendingPermissions.delete(requestId)` above
  `assertClaudeQuestionAnswerDeliverable(...)` in `providers/claude/agent.ts`.
- Invocation, from `packages/server`:
  `npx vitest run src/server/agent/providers/claude/agent.test.ts --bail=1`
- Mutant result: 1 failed | 40 passed of 99 (bailed). Restored with `git checkout --`, re-run
  without `--bail`: 99/99.

The re-run confirms the property. It is not evidence about the tree the original census ran on
(`4d1275495d92e92cec32e1ab6950c4601ccccf97`); no measurement of M12 on that tree survives except
the SURVIVED log.

## What is not captured

Stated so the population is not read as more than it is.

- **Exact mutation diffs exist only for M12 and M26.** M05–M25 were applied and reverted without
  capturing a diff; their "Mutant" column is a prose statement of the edit, and cannot be
  re-derived from this directory. Re-deriving one requires re-applying the described edit.
- **Restoration is captured collectively for most mutants, not per mutant; M12 and M26 are
  exceptions with dedicated captures (`m12-qar-ordering-restored.log` and
  `m26-flush-site-4301-restored.log`).** The census asserts every mutant was
  reverted with `git checkout --`; the evidence for that is the four suite controls
  (`control-*.log`), `m12-qar-ordering-restored.log`, `control-codex-app-server-agent.log`, and
  `m26-flush-site-4301-restored.log`. Each is a green run of a whole suite at a moment after some
  set of mutations was reverted — end-state evidence covering that set together, not a
  per-mutant revert-and-re-run cycle. Read "restore to green" as proved for the suites those logs
  cover at those moments, and NOT MEASURED per mutant for the remaining mutants.
- **No compilation evidence exists for the type-only `agent-sdk-types.ts` site.** See
  force-cancel-releases-foreground under "Constituent coverage".
- **`archived-live-list`'s specified survival check is half unmeasured.** M24 and M25 are
  seeded-state boundary tests; the history-hydration path PATCHES.md:661-662 names is NOT
  MEASURED. See archived-live-list under "Constituent coverage". This is the patch with no
  marker, so the gap is in the only guard it has.
- **M20 is a survivor with no booted-daemon coverage.** It is recorded SURVIVED, not dispositioned
  into a pass.

Capture hazard — **read this before adding a capture here.** The repository's `.gitignore:21`
ignores `*.log`, so every log in this directory was and must be committed with `git add -f`. A log written here and committed without `-f` is silently not
committed; that is consistent with how the originally cited M12 captures were lost.

Status vocabulary used in this directory: KILLED, SURVIVED, NOT KILLED, NOT MEASURED,
NOT_APPLICABLE. A non-pass is never renamed.
