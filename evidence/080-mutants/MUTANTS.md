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

| #    | Patch                                             | Mutant                                                                    | Result       | Killing assertion                                                                                                         |
| ---- | ------------------------------------------------- | ------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| M05  | replace-awaits-teardown                           | `FOREGROUND_TEARDOWN_WAIT_MS = 0` (codex-app-server-agent.ts)             | KILLED       | "waits out a clearing foreground turn instead of refusing" — expected `pending`, got rejection                            |
| M06a | interrupt-releases-foreground                     | drop release on unidentified interrupt                                    | KILLED       | "releases the foreground slot when no turn was ever identified"                                                           |
| M06b | interrupt-releases-foreground                     | drop keyed release on already-idle interrupt                              | KILLED       | "flushes a queued startTurn when Codex reports the interrupted turn is already idle"                                      |
| M07  | dispose-releases-foreground                       | drop release in `disposeClient()`                                         | KILLED       | "releases the foreground slot when the client is disposed"                                                                |
| M08  | dead-run-settles                                  | throw instead of no-op on unidentifiable interrupt                        | KILLED       | two tests: "releases … no turn was ever identified", "leaves the foreground slot to a newer turn that raced into it"      |
| M09  | force-cancel-releases-foreground                  | drop `releaseForegroundTurn?.(runTurnId)` in agent-manager                | KILLED       | "cancelAgentRun force-cancel releases the session's foreground slot"                                                      |
| M10  | force-cancel-releases-foreground (facade)         | `releaseForegroundTurn: undefined` in provider-registry                   | KILLED       | "forwards every optional AgentSession method" (compile-time exhaustiveness surrogate)                                     |
| M11  | question-answer-required                          | make the deliverability helper always accept                              | KILLED       | 11 rejection tests in claude/agent.test.ts                                                                                |
| M12  | question-answer-required (ordering)               | move the deliverability check after `pendingPermissions.delete`           | KILLED       | "a rejected question answer leaves the request answerable by a corrected retry" (added this round)                        |
| M13  | detached-arg                                      | read `parsed.detached` as `false`                                         | KILLED       | "create_agent detached:true omits the parent agent label"                                                                 |
| M14  | detached-arg (schema)                             | restore `.default(false)` on the schema field                             | KILLED       | "create_agent with detached relationship omits the parent agent label" + 6 more                                           |
| M15  | detached-wakeup                                   | hardcode `requireParentOwnership: true`                                   | KILLED       | "a deliberately detached child does not have its wakeup gated on parent ownership"                                        |
| M16  | wakeup-each                                       | disarm after first finish (`hasSeenRunning = false` → notify once)        | KILLED       | "the watcher re-arms: every finish of the child notifies the caller"                                                      |
| M17  | wakeup-each (archived disarm)                     | drop the archived-caller disarm                                           | KILLED       | "an archived caller disarms the watcher instead of leaking it"                                                            |
| M18  | native-tools-injection-independent                | gate default `(mcpEnabled ?? true) !== false` → `=== true`                | KILLED       | "absent mcp.enabled defaults to enabled (upstream default)"                                                               |
| M19  | native-tools-injection-independent (bootstrap)    | re-couple native catalog to `mcp.injectIntoAgents` at a field-change site | KILLED       | source-level gate test: "bootstrap gates the native catalog on mcp.enabled alone, never on MCP injection"                 |
| M20  | native-tools-injection-independent (live handler) | behaviour-equivalent re-couple through a boolean temp                     | **SURVIVED** | textual gate test only; no booted-daemon coverage — see disposition                                                       |
| M21  | mcp-protocol-version-clip                         | skip the rawHeaders rewrite                                               | KILLED       | three e2e cases in agent-mcp.e2e.test.ts (`2026-07-28`, `DRAFT-2026-v1`, normalisation)                                   |
| M22  | mcp-protocol-version-clip (duplicates)            | drop the duplicate-collapse loop                                          | KILLED       | "duplicate mcp-protocol-version raw headers collapse to one effective value" — expected 400 to be 200                     |
| M24  | archived-live-list                                | drop `archivedAt` from `serializeSnapshotWithMetadata`                    | KILLED       | "excludes an archived agent that is also live from list_agents"; "reports the archive timestamp of a live archived agent" |
| M25  | archived-live-list (filter)                       | make the combined-list archive filter a no-op                             | KILLED       | "defaults list_agents to caller cwd and excludes archived agents" (length 3 → 4)                                          |

**Population: 21 mutants** (20 killed, 1 survived), one log each, all listed above. M12 survived
the first run against the tree as merged (`m12-qar-ordering-SURVIVED.log`) and was killed on the
re-run after this round added a test for the property (`m12-qar-ordering-KILLED.log`); both logs
are kept, because the survival is the evidence that the test was missing. One further
run — M23 — was made and discarded as mis-targeted; it is not a mutant of this population and is
recorded below with its log.

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
  **not** prove the four `flushForegroundTurnClearWaiters()` call sites individually; M06a/M06b/M07
  each exercise one of them (interrupt-unidentified, interrupt-already-idle, dispose). The
  `close()` flush site is unproven by any mutant here.
- **interrupt-releases-foreground** — two of its marker sites killed (M06a, M06b). The third
  marker (the extracted-helper comment at `interruptIdentifiedTurn`) is documentation of a
  refactor, not behaviour, and has no mutable content.
- **force-cancel-releases-foreground** — M09 proves the manager call; M10 proves the registry
  facade forward. The `agent-sdk-types.ts` declaration is type-only; its "test" is compilation,
  which M10's exhaustiveness assertion stands in for.
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
  (`m12-qar-ordering-test-green.log`).
- **native-tools-injection-independent** — M18/M19 prove the gate function and the bootstrap
  source shape. M20 confirms what PATCHES.md already records: the live `mcp.enabled` /
  `mcp.injectIntoAgents` field-change handlers have **no booted-daemon coverage**; the only guard
  is a textual scan of `bootstrap.ts`, which a behaviour-equivalent rewrite walks past.
- **archived-live-list** — M24 proves the storage merge at the MCP boundary (both the
  live-plus-stored exclusion and the reported timestamp); M25 proves the combined-list filter.
  The patch carries no `SLP-PATCH(` marker by design, so "remove the marker and see" has no
  meaning for it; its survival check is behavioural, and these two mutants are that check.
- **detached-arg / detached-wakeup / wakeup-each / mcp-protocol-version-clip** — every marker
  site in these four has a killed mutant above except the `paseo-tools.ts:1592` detached-arg
  comment site, which restates the schema rule proven by M14.
