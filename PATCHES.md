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
field in `packages/server/src/server/agent/tools/paseo-tools.ts`, four provider-local
repairs in `packages/server/src/server/agent/providers/codex-app-server-agent.ts`
(`dead-run-settles`, `replace-awaits-teardown`, `dispose-releases-foreground`,
`interrupt-releases-foreground`), and a fifth,
`force-cancel-releases-foreground`, which spans the manager
(`agent-manager.ts`) and the registry facade (`agent-sdk-types.ts`,
`provider-registry.ts`).

Six patches keep their tests in fork-only `.slp.test.ts` files upstream does
not own: `agent-prompt.slp.test.ts`, `create-agent/create.slp.test.ts`,
`native-tools-gate.slp.test.ts`, `agent-message-raw-body.slp.test.ts`,
`providers/codex-interrupted-turn-terminals.slp.test.ts` and, in the CLI package,
`commands/agent/send.slp.test.ts`.
(`native-tools-optin.slp.test.ts` was the third until the 2026-09-07 sync retired its
patch; `native-tools-gate.slp.test.ts` replaced it there.)

Another patch puts its tests in an upstream-owned file, because the test belongs next to
the thing it checks: `detached-arg`'s behaviour only shows through a live MCP tool call, so
its two tests sit in `mcp-parity.e2e.test.ts` beside the legacy-shape test they mirror.

`schedule/service.test.ts` carries one fork test that belongs to no patch:
`refuses a manual run while a scheduled claim is in flight`. It came from
`schedule-claim-in-flight`, which retired at the v0.12.0 sync, and stays as the one guard on
upstream's reservation of a schedule before its claim (#6532): no upstream test fails when
that reservation moves after the claim. It carries no marker, keeps
`schedule/service.test.ts` in the derived file manifest, and leaves when upstream adds an
equivalent.

## Why these patches exist

The SLP room repository — named `room-workflow` until 2026-08-10, now `airoom` — runs its daemon from this repository, cloned at `~/.local/share/airoom/paseo` and kept on `slp/patches` (it was a `paseo/` submodule until 2026-09-22).
Its Supervisor > Lead > Peers model runs long-lived agents as Paseo subagents. Upstream's
finish-notification behavior broke that model in five ways — two are now fixed upstream and
three are still carried here — and its native host-tool channel broke the omp family in a
sixth, unrelated way. The sixth one left the merge, then came back narrower
the same day: #4277 superseded the fork's shape but still ties the native
catalog to MCP injection, so a minimal follow-up patch (below) re-couples it to
`mcp.enabled` alone.

Patches that landed upstream have left, and their sections with them. **Fifteen patches
remain here** — the count was nine for a while after `force-cancel-releases-foreground`
and `archived-live-list` arrived without it being updated,
`mcp-protocol-version-clip` made it twelve on 2026-09-09,
`claude-history-follows-provider-env` made it thirteen on 2026-09-11,
`history-purpose-provider-contract` made it fourteen on 2026-09-21,
`acp-provider-mcp-servers` made it fifteen on 2026-09-25, the v0.10.0 sync
dropped `claude-history-follows-provider-env` (upstream shipped it as #5437) and
`schedule-claim-slots` brought it back to fifteen on 2026-10-01 and
`schedule-claim-in-flight` made it sixteen the same day, and the v0.11.0-beta.5
sync dropped `acp-provider-mcp-servers` for fifteen, the v0.11.0 sync kept
all fifteen, and the v0.12.0 sync retired `question-answer-required`,
`schedule-claim-slots` and `schedule-claim-in-flight` for twelve, and
`agent-message-raw-body` made it thirteen on 2026-10-20 and
`agent-send-interrupt` fourteen and `interrupted-turn-terminals` fifteen the same
day, which is
why the `Sync procedure` below now derives its file manifest with a command
instead of restating a total.
Current upstream sync: **2026-10-19**, tag `v0.12.0` at
`cafe4b01c8522ff39560241c5deb01427dc8dc5b` (tag object `d288bcfc8`), merged by
`5bf333959` on top of the v0.11.0 sync below, 248 upstream commits later, by the
room's plan `plans/paseo-sync-v0.12.md` (AI-airoom `4283af45e`). Eight files conflicted:

- `agent/agent-prompt.ts`: #6660 settles a turn on its terminal stream event, #5164 adds
  dispatch acknowledgement and observer supersession, and #6373 marks the sender. The merge
  takes all three; `wakeup-each` moved into the idle `turn_completed` branch (see its section).
- `agent/create-agent/create.ts`: #5039 arms the finish watcher before the first prompt is
  dispatched. `detached-wakeup`'s argument moved into that registration, and the fork's later
  arming block left.
- `agent/agent-projections.ts`: the fork's `archivedAt` sits beside #5039's `internal`.
- `agent/tools/paseo-tools.ts`: `list_agents` takes #5039's `AgentDirectory`, and
  `archived-live-list` keeps its archive filter after projection (see its section).
- `agent/providers/acp-agent.ts`: #6766's `releaseHistoryRuntime()` replaces the fork's
  release helper; `history-purpose-provider-contract`'s ACP half is narrowed to returning
  before the configured overrides (see its section).
- `agent/providers/claude/agent.ts` and `schedule/service.ts` take upstream's files whole.
  `schedule/service.test.ts` takes upstream's tests and adds the fork's manual-run-during-claim
  case.

Three patches retired, each on its proof run against the merged tree:

- `question-answer-required`, by #6936 (`71f575e16`): an undeliverable question answer is
  rejected before the request is consumed, with a typed `question_answer_required` error, and a
  corrected retry on the same request id delivers. Upstream's rejection does not name the keys
  a request accepts, which two of the fork's nineteen helper cases asserted; that message is
  lost, by decision. Upstream's `providers/claude/question-response.test.ts` carries the
  behaviour.
- `schedule-claim-slots`, by #6532 (`ee0d901ef`), which carries keithpk's #4904 forward with
  its credit, adds final-slot handling and drops the persisted-running veto that wedged later
  slots after an unsaved outcome.
- `schedule-claim-in-flight`, by the same commit's reservation of the schedule before any
  store I/O, which #6334 (`0fc6bf0c9`) releases when the run record cannot be written.

Outside the patches, the sync restored upstream's positive Codex test
`getAvailableModes includes auto-review when the Codex version supports it` and its
`Codex app-server provider` describe, which an unrelated fork commit (`a54319c5a`) had deleted
and renamed.
Previous upstream sync: **2026-10-07**, tag `v0.11.0` at
`22488d4502cd0c8a4ee4619af991762f071b60a7`, merged by `9f0f820bd` on top of the
beta.5 sync below, 58 upstream commits later. One file conflicted:
`providers/acp-agent.ts`, where #6228 (`a9fef4879`, an archived ACP agent's
history loads after its worktree is removed) added the same resume-purpose
plumbing `history-purpose-provider-contract` carried — the option, the fourth
`resumeSession` argument and the `resumePurpose` field. The merge takes
upstream's plumbing and keeps the patch's post-load release (see its section).
Eight patch-owned files changed upstream, and none of the changes fixes a carried
patch or moves its insertion point:
#6255 (`2ecf3ba78`) re-archives an agent when a send cannot load it, in
`sendPromptToAgent`, away from `wakeup-each`'s watcher; #6273 (`a162e1075`) adds
`configuredModelIds` to the registry's session options, beside
`force-cancel-releases-foreground`'s forward; #6224 (`7fd469ae1`) turns registry
installs on, and #6254 (`3c478e596`) then removed `pluginRegistryEnabled` from
the strict config schema, so at `v0.11.0` a config carrying that key is refused
at startup (`Unrecognized key`); #6278 and #6281 change file downloads in
`bootstrap.ts`; #6295, #6272 and #6248 change the Claude provider outside
`respondToPermission`; #6213 bounds ACP `close()`, which the history release does
not call. Everything else auto-merged, and the other 28 files that differ from
the tag carry the same patch lines as at beta.5. Every kept patch's defect is still present at
the pin.
Earlier upstream sync: **2026-10-07**, tag `v0.11.0-beta.5` at
`15d774d4a17c69bc0f8a62a85842764fab3c038d`, merged by `69763bbde`. Three files conflicted.
`provider-registry.ts` keeps `force-cancel-releases-foreground`'s
`releaseForegroundTurn` forward inside #5780's `satisfies ForwardedAgentSession`
guard, which requires every session member to be forwarded. `generic-acp-agent.ts`
and its suite took upstream's side whole: #5780 deleted the provider-params
schema `acp-provider-mcp-servers` extended, and moved ACP options into
`acp-options.ts`. **`acp-provider-mcp-servers` was dropped by the room's
decision, not because upstream fixed it:** the target still mounts only a
session's own `mcpServers`. Its remaining sites in `acp-agent.ts` and its four
tests there left in the commit after the merge; the `history-purpose-provider-contract`
hunks in both ACP files stayed. Everything else auto-merged, and no other
patch changed shape. Every kept patch's defect was still present at that pin.
Earlier upstream sync: **2026-09-28**, tag `v0.10.0` at
`c481ecf3e101326e3758d419341bc4faaf5b4f98` (on `upstream/main`), merged by the
commit that introduced this paragraph, with the patch set reviewed against it
first. Four files conflicted. `providers/claude/agent.ts` took upstream's #5437
at the three config-dir sites, and the fork's `resolveConfigDir()` went with the
patch. `providers/pi/agent.ts` re-applied `history-purpose-provider-contract`'s
`try`/`finally` release around upstream's new `streamPiHistory` call (#5309 added
the extension host and the close signal, and `capturedUserEntries` is
`contextUserEntries` now). `providers/opencode-agent.ts` took upstream's side,
because that half of the patch was dropped (see its section). In
`agent-mcp.e2e.test.ts`, `mcp-protocol-version-clip`'s helper sits beside
upstream's offline-daemon helpers. Everything else auto-merged. Three patches
changed shape:
`claude-history-follows-provider-env` was **dropped** (#4694 closed on
2026-09-26 in favour of #5437, merged as `76a9781ba`, which resolves the Claude
config dir from the provider's launch env for history, the import list and the
model catalog — the same four sites; its fork-only e2e test left with it, and
upstream's `claude-provider-config-dir-history.e2e.test.ts` covers the history
read). `history-purpose-provider-contract` was **narrowed** to the two providers
the room runs seats on that need it, pi and the ACP family; its omp, opencode and
plugin-provider halves, the Claude and Codex guard tests and the
`docs/agent-lifecycle.md` edit now read as upstream's. `native-tools-injection-independent`
is kept, but **for a different reason** than the one it was written for (see its
section). Every other patch is carried unchanged. #5407 now replaces an armed
finish watcher when the same caller arms another for the same child, and
`wakeup-each` keeps working through that change: its re-armed watcher is the
armed one that a later arm replaces.
Earlier upstream sync: **2026-09-23**, `upstream/main` at
`d6861f81e5e584aec9951dbcf7a37d9d2b7dfa9a` (`v0.9.1` plus 17 commits, the tip
when merged), merge `6e41ee81a`. No conflict
and no fork test adapted; 30 marker sites under 11 names in 12 files. Of its four
commits past the previous sync, #5253 reorders daemon shutdown — agents close
(each close bounded by a deadline) before plugins stop — and #5248 gives an ACP
terminal the agent's launch environment; they touch `bootstrap.ts` and
`acp-agent.ts` outside every patch hunk, and #5258 and #5255 touch neither
server patch files nor the room's providers. None of the four fixes a carried
patch, so the 2026-09-23 re-verification above still holds here.
`mcp-parity.e2e.test.ts` failed the same five tests before and after the merge.
Earlier upstream sync: **2026-09-23**, `upstream/main` at `d161b5987`
(`v0.9.1` plus 13), merge `99503082c`: one conflict, `providers/claude/agent.test.ts`'s
import block after #5240, both sides kept in #3495's order. It brought #5229,
which lets a history read load an archived agent whose working directory is gone;
before it, `paseo logs` on such an agent failed with `Working directory does not
exist`, the error behind the level-50 `fetch_agent_timeline_request` lines in the
room's `daemon.log` (304 between the 0.9.1 restart and that sync, none after).
Earlier upstream sync: **2026-09-23**, tag `v0.9.1` at
`81865852011df86aa0ad0ae411cb2f5e4078153f`, merge `ebbc3167d`. `codex-app-server-agent.ts`
conflicted with upstream #4736's `connectionState` (so `dispose-releases-foreground`
sits after `this.connectionState = "disconnected"` and the Codex part of
`history-purpose-provider-contract` gave way to upstream's own history read), and
`plugin-provider.test.ts` took both sides' helpers; two fork tests were adapted to
0.9 (`connectionState`; `subscribe: {}`). Before that, **2026-09-11**: tag `v0.8.0`
at `b8e24677e`, merge `683d6e776`, twelve patches carried with no adaptation.
Before that: **2026-09-07**, `upstream/main` at `c424f8292` (0.7.2),
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

| PR                                                   | Patches                                                                                                                                           | Touches                                                                                                                                                                                   | Status                                                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#3192](https://github.com/getpaseo/paseo/pull/3192) | —                                                                                                                                                 | `agent-prompt.ts`                                                                                                                                                                         | landed `cdb116314`, synced                                                                                                                                                                        |
| [#3455](https://github.com/getpaseo/paseo/pull/3455) | `wakeup-each`                                                                                                                                     | `agent-prompt.ts`                                                                                                                                                                         | closed 2026-09-08 — feature-PR sweep; fork branch deleted 2026-09-23; Discussion [#4669](https://github.com/getpaseo/paseo/discussions/4669)                                                      |
| [#3094](https://github.com/getpaseo/paseo/pull/3094) | `detached-wakeup`                                                                                                                                 | `create-agent/create.ts`                                                                                                                                                                  | open — QA evidence added 2026-09-23                                                                                                                                                               |
| [#3147](https://github.com/getpaseo/paseo/pull/3147) | `detached-arg`                                                                                                                                    | `paseo-tools.ts`                                                                                                                                                                          | closed 2026-09-08 — feature-PR sweep; fork branch deleted 2026-09-23; Discussion [#4670](https://github.com/getpaseo/paseo/discussions/4670)                                                      |
| [#4277](https://github.com/getpaseo/paseo/pull/4277) | — superseded `native-tools-optin`                                                                                                                 | per-provider Paseo tool policy                                                                                                                                                            | landed `53c960747`; closed #3449 as superseded 2026-09-03                                                                                                                                         |
| [#4434](https://github.com/getpaseo/paseo/pull/4434) | `native-tools-injection-independent`                                                                                                              | `bootstrap.ts`, `native-tools-gate.ts`                                                                                                                                                    | closed 2026-09-08 — feature-PR sweep; fork branch deleted 2026-09-23; Discussion [#4671](https://github.com/getpaseo/paseo/discussions/4671)                                                      |
| [#3640](https://github.com/getpaseo/paseo/pull/3640) | `dead-run-settles`, `interrupt-releases-foreground`, `replace-awaits-teardown`, `dispose-releases-foreground`, `force-cancel-releases-foreground` | `codex-app-server-agent.ts`, `agent-manager.ts`, `agent-sdk-types.ts`, `provider-registry.ts`                                                                                             | closed 2026-09-08 in favor of #4041 (still open 2026-10-19) — follow-up remains; fork branch deleted 2026-09-23                                                                                   |
| [#3495](https://github.com/getpaseo/paseo/pull/3495) | — retired `question-answer-required`                                                                                                              | claude provider                                                                                                                                                                           | closed unmerged — superseded by [#6936](https://github.com/getpaseo/paseo/pull/6936), landed `71f575e16`, in `v0.12.0`; patch retired at the v0.12.0 sync                                         |
| [#3803](https://github.com/getpaseo/paseo/pull/3803) | `archived-live-list`                                                                                                                              | `mcp-shared.ts`, `agent-projections.ts`, `messages.ts`, `paseo-tools.ts`                                                                                                                  | open — **no marker**; QA evidence added 2026-09-23                                                                                                                                                |
| [#3674](https://github.com/getpaseo/paseo/pull/3674) | —                                                                                                                                                 | `codex-app-server-agent.ts`                                                                                                                                                               | closed into #3640; fork branch deleted 2026-09-23                                                                                                                                                 |
| [#3683](https://github.com/getpaseo/paseo/pull/3683) | —                                                                                                                                                 | `codex-app-server-agent.ts`                                                                                                                                                               | closed into #3640; fork branch deleted 2026-09-23                                                                                                                                                 |
| [#4570](https://github.com/getpaseo/paseo/pull/4570) | `mcp-protocol-version-clip`                                                                                                                       | `bootstrap.ts`                                                                                                                                                                            | open — QA evidence added 2026-09-23                                                                                                                                                               |
| [#4694](https://github.com/getpaseo/paseo/pull/4694) | — dropped `claude-history-follows-provider-env`                                                                                                   | `providers/claude/agent.ts`                                                                                                                                                               | closed 2026-09-26 as superseded by [#5437](https://github.com/getpaseo/paseo/pull/5437), landed `76a9781ba`, in `v0.10.0`; patch dropped at the v0.10.0 sync                                      |
| [#5132](https://github.com/getpaseo/paseo/pull/5132) | `history-purpose-provider-contract`                                                                                                               | this branch carries two of the PR's five providers — `acp-agent.ts`, `pi/agent.ts` (Codex's part landed upstream as #4736; omp, opencode and plugin-provider dropped at the v0.10.0 sync) | closed unmerged — the OMP half landed as [#5550](https://github.com/getpaseo/paseo/pull/5550) (`264f6e1cc`); the pi and ACP halves were not included. **No marker**; kept, with no upstream route |
| [#4904](https://github.com/getpaseo/paseo/pull/4904) | — retired `schedule-claim-slots`, `schedule-claim-in-flight`                                                                                      | `schedule/service.ts`                                                                                                                                                                     | closed unmerged — superseded by [#6532](https://github.com/getpaseo/paseo/pull/6532), landed `ee0d901ef` with keithpk's credit, in `v0.12.0`; both patches retired at the v0.12.0 sync            |
| —                                                    | `interrupted-turn-terminals`                                                                                                                      | `codex-app-server-agent.ts`                                                                                                                                                               | not opened upstream: the room decided nothing goes to getpaseo/paseo                                                                                                                              |
| —                                                    | `agent-send-interrupt`                                                                                                                            | `tools/paseo-tools.ts`, `cli/src/commands/agent/send.ts`                                                                                                                                  | not opened upstream: the room decided nothing goes to getpaseo/paseo                                                                                                                              |
| —                                                    | `agent-message-raw-body`                                                                                                                          | `agent-messages/index.ts`                                                                                                                                                                 | not opened upstream: the room decided nothing goes to getpaseo/paseo                                                                                                                              |

**Re-verified 2026-10-19** against tag `v0.12.0` (`cafe4b01c`): of the fifteen, upstream
fixes three, `question-answer-required` (#6936) and both schedule patches (#6532, #6334), and
they were retired. For each of the twelve kept, the v0.12.0 source still has the defect. A
successful finish still stops the watcher, and an archived caller returns without stopping it.
`create.ts` still passes `requireParentOwnership: true`. The canonical agent-scoped
`create_agent` still returns `detached: false`. The seven native-catalog enables are still
gated on injection. The lockfile still pins `@modelcontextprotocol/sdk` 1.29.0. The Codex
provider still throws on an unidentified turn, refuses a new turn at once while the slot is
held, and keeps the slot through disposal and forced settlement; #7339 buffers startup events
and closes none of these, and #4041 is still open. `list_agents`' new `AgentDirectory` filters
archives on raw live snapshots, which carry no archive timestamp. pi still ignores `purpose`,
and ACP applies the configured overrides before it releases a history read's process.

**Re-verified 2026-09-28** against tag `v0.10.0` (`c481ecf3e`): of the fourteen,
upstream fixes one, `claude-history-follows-provider-env` (#5437), and it was
dropped. For each of the others, the v0.10.0 source still has the defect.
`notifySafely("finished")` still takes no `terminal: false` (#5407 only replaces
an armed watcher on re-arm). `create.ts` still passes `requireParentOwnership: true`
(`create.ts:215`). The canonical agent-scoped `create_agent` still returns
`detached: false`. Both `setPaseoToolsEnabled` and
`setAgentProviderToolsEnabled` are still gated on `mcpInjectIntoAgents` at
startup and in both field-change handlers. The lockfile still pins
`@modelcontextprotocol/sdk` 1.29.0, whose newest protocol is `2025-11-25`, while
Claude Code 2.1.283 speaks `2026-07-28`. The Codex provider is unchanged under all
five foreground patches, and #4041 is still open. The Claude provider still
deletes a pending permission before any deliverability check. `list_agents`
still filters archives on the stored branch only. pi and acp still ignore
`purpose`. The generic ACP provider still passes no provider-level MCP servers
to `session/new`.

**Re-verified 2026-09-23** against `upstream/main` `d161b5987` (`v0.9.1` plus 13
commits): upstream fixes none of the fourteen. `notifySafely("finished")` still
takes no `terminal: false`; `create.ts` still passes `requireParentOwnership: true`;
the canonical agent-scoped `create_agent` still returns `detached: false`; the
native catalog is still gated on `mcpInjectIntoAgents` at all seven call sites; the
lockfile still pins `@modelcontextprotocol/sdk` 1.29.0, and neither it nor 1.30.0, the npm latest, knows `2026-07-28`, which Claude Code 2.1.280 still speaks; Codex
`interrupt()` still throws on an unidentified turn, `startTurn` still refuses at
once and `disposeClient()` still leaves the slot; the Claude provider still
deletes a pending permission before any deliverability check and still reads
`process.env.CLAUDE_CONFIG_DIR`; `list_agents` still filters archives on the
stored branch only; omp, pi, acp, opencode and plugin still ignore `purpose`. A dry-run
merge of that commit conflicts only in `providers/claude/agent.test.ts`'s import
block (#5240 added imports beside `question-answer-required`'s; keep both) and
keeps 30 marker sites under 11 names.

Upstream's `CONTRIBUTING.md` now closes pull requests by default and closes any
without QA evidence from running the changed service, so on the same day the open
PRs without such a section gained one, measured on the room's deployment of this
branch: #3094, #3803, #4570 and #5132 (#3495 already carried a measured
Verification table, #4694 a QA section). The fork branches of the seven closed
PRs — #3455, #3147, #4434, #3640, #3674, #3683 and #3449 — were deleted that day;
each head survives upstream at `refs/pull/<n>/head`. The three
patches the feature sweep closed have each had an open Ideas Discussion since
2026-09-10 — `wakeup-each` #4669, `detached-arg` #4670 and
`native-tools-injection-independent` #4671 — with no maintainer reply as of
2026-09-23; #4670 carries one outside comment (2026-09-18) describing the same
create-schema gap from the plugin side.

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
belongs to a later sync round. As of 2026-09-23 #4041 is still open and
unmerged (last updated 2026-09-16). If it lands, re-evaluate
`force-cancel-releases-foreground` first — #4041 replaces the provider runtime
after a forced settlement, which is the path that patch releases — and with it
the race `replace-awaits-teardown` covers. `dead-run-settles`,
`interrupt-releases-foreground` and `dispose-releases-foreground` stay either way
(the maintainer's closing note names them as follow-up); their route upstream is
a focused bug-fix PR with a reproduction and QA once #4041 has landed.

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

## How the wakeup patches reached upstream

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

- **What:** the finish watcher stays armed after a successful finish instead of
  unsubscribing, so a caller wakes for every finish of a long-lived child across many
  prompts. Since #6660 (`v0.12.0`) a turn settles on its terminal stream event, not on the
  idle state: the watcher sends `finished` from the idle `turn_completed` branch. This patch
  passes `{ terminal: false }` there and clears both per-cycle gates, `hasSeenRunning` and
  `hasSeenTurn`, so the child's next observed turn notifies again and a repeated terminal
  event without one notifies nothing. The watcher disarms on an idle `turn_canceled`
  (`was canceled`), on `was closed`, on `errored`, and when the caller is archived, where the
  patch calls `stop()`. Two markers, both in `agent-prompt.ts`. Watchers only ever exist for
  agent callers (`notifyOnFinish` + `callerAgentId`), so this is derived: no `notifyMode`
  parameter, no schema or plumbing change. An earlier revision threaded an opt-in
  `notifyMode: "once" | "each"` through the tool schemas; that shape is the right artifact if
  upstream asks for this to be opt-in.
- **What it leaves to upstream:** #5164's acknowledgement mechanics. A successful follow-up
  dispatch supersedes and stops the re-armed watcher, so a caller and child keep one live
  observation; a rejected dispatch stops only its own; a new turn's watcher waits for the
  turn to start.
- **Re-applying:** this is a semantic patch on a state machine upstream keeps rewriting.
  #3177 added the `terminal` option, and the patch collapsed to `{ terminal: false }` on the
  finish; #6660 moved the finish from the idle state to the terminal completion event, and
  the patch moved with it. Re-apply it onto whatever shape upstream has; do not restore an old
  diff. The idle state alone must never send `finished`. The check under `Sync procedure`
  reads the shape, and `agent-prompt.slp.test.ts` drives it with the events the manager
  publishes, the idle state followed by the terminal stream event.
- **Upstream status:** closed 2026-09-08 in the feature-PR sweep; the workflow is argued in Discussion [#4669](https://github.com/getpaseo/paseo/discussions/4669). [#2879](https://github.com/getpaseo/paseo/pull/2879) carried this patch and was closed on 2026-08-11 as superseded by #3192, which took the other two and left this one because it changed the default for every existing caller. #3455 proposed `notifyMode` on the agent-scoped `create_agent` and `send_agent_prompt` schemas, with `"once"` as the default and `"each"` as the re-arming mode. This branch keeps the derived form instead — see the note above the patch list.

### detached-wakeup

- **What:** `create-agent/create.ts` passes `requireParentOwnership: !(input.detached ?? false)`
  instead of a hardcoded `true`, in the watcher registration #5039 (`v0.12.0`) arms before the
  initial prompt is dispatched, so a child that finishes fast still reaches its caller and a
  failed first prompt disarms it. Before `v0.12.0` the fork armed a second watcher after
  dispatch; that block left at the v0.12.0 sync. The guard asks the watcher to check, at fire time, whether the child
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
- **Upstream status:** closed 2026-09-08 in the feature-PR sweep — [getpaseo/paseo#3147](https://github.com/getpaseo/paseo/pull/3147) (branch `fix/canonical-detached-create-agent`, deleted from the fork 2026-09-23; its head survives at `refs/pull/3147/head`). The workflow is argued in Discussion [#4670](https://github.com/getpaseo/paseo/discussions/4670).
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
[#4434](https://github.com/getpaseo/paseo/pull/4434). The workflow is argued in Discussion
[#4671](https://github.com/getpaseo/paseo/discussions/4671).

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
- **Why here:** the room runs `daemon.mcp.injectIntoAgents: false`, because its
  launchers give each seat its own caller-scoped server
  (`/mcp/agents?callerAgentId=<seat>`). The patch was written for omp seats that
  needed the native catalog. omp is retired from the room, and the patch is still
  load-bearing for a wider reason. `AgentManager.prepareSessionConfig` stores
  `{ enabled: false }` as every new agent's Paseo tool policy whenever
  `paseoToolsEnabled` is false. The caller-scoped MCP server builds its catalog
  from that stored policy (`getPaseoToolPolicy(callerAgentId)` in `bootstrap.ts`),
  and `registerTool` skips every tool whose policy is disabled. So under upstream's
  injection-coupled gate, every Claude, Codex, pi and ACP seat's own Paseo MCP
  server serves no tools. Measured at the v0.10.0 sync with a scratch
  daemon-boot probe (not committed). The daemon ran with `mcpInjectIntoAgents:
false`, an agent was created, and its caller-scoped server was listed. With
  the patch, `list_agents`, `create_agent` and `send_agent_prompt` are present.
  With the three startup sites reverted to upstream's expressions, the stored
  policy reads `{ enabled: false }` and the listing fails with
  `MCPClientError: Server does not support tools`. `#4277`'s per-provider policy
  cannot help, because it is a second gate on top of a `paseoToolsEnabled` that
  injection has already forced to false.
- **Coverage:** `native-tools-gate.slp.test.ts` pins the room's live shape
  (mcp enabled + injection off ⇒ catalog available), the two other helper
  branches, and a source-level check that every `setPaseoToolsEnabled` /
  `setAgentProviderToolsEnabled` call in `bootstrap.ts` passes the fork gate
  and never an injection expression. A booted-daemon regression for the live
  field-change handlers remains uncovered. After a daemon upgrade, the room's
  preflight and first seats confirm that tools reach a seat.
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
said so until now: since the v0.12.0 sync four patches are documented as `##` sections
_above_ `## Patches`, and nine as `###` sections under it:
`sed -n '/^## Patches$/,/^## Sync procedure$/p' PATCHES.md | rg -c '^### '`
measures **9**, so neither level alone lists them all. The roster is the marker manifest
in `Sync procedure`, plus `archived-live-list` and `history-purpose-provider-contract`,
which carry no marker. That mattered more than a missing heading
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
- **No `SLP-PATCH` marker, deliberately.** Until `v0.12.0` the diff was byte-identical to the
  upstream PR, so that if upstream took it the files would converge instead of conflicting.
  #5039 rewrote the list assembly #3803 edits, so the `paseo-tools.ts` hunk here is now the
  post-projection filter below, and the PR no longer applies as written; the storage read,
  the projection option and the payload field are unchanged. If upstream takes an
  equivalent, delete this section.
- **Since `v0.12.0`:** `list_agents` builds its list with upstream's `AgentDirectory`
  (#5039), which applies `includeArchived` to raw live snapshots before projecting them. A
  live `ManagedAgent` carries no archive timestamp, so that predicate passes an archived
  agent resumed for a history read. The patch keeps its own
  `includeArchived || !agent.archivedAt` filter after projection in the MCP tool; the
  directory looking as if it filters archives is not a reason to drop it.
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

### history-purpose-provider-contract

Opened 2026-09-21. Every `resumeAgentFromPersistence` call the manager makes for a history
read already threads `{ purpose: "history" }` — upstream's own `agent-loading.ts` puts it
there for an archived agent (`archived-live-list`, above, never touches that file) — but most
`resumeSession` implementations ignored the option and spawned a full interactive runtime to
serve one read. Measured on one host: eleven such runtimes left resident, ~1.36 GB.

- **Narrowed at the v0.10.0 sync (2026-09-28).** This branch carries only the **pi** and
  **ACP** halves (`providers/pi/agent.ts`, `providers/acp-agent.ts` and their suites). Those
  are the two families the room runs seats on whose history read would otherwise spawn and
  keep a runtime. Claude spawns nothing, and Codex's half is upstream's #4736. The omp,
  opencode and plugin-provider halves were dropped. omp is retired from the room, and the
  room runs no opencode or plugin-provider seat, so on this daemon an archived agent of
  those providers leaks its runtime on a history read again, as upstream does. The Claude
  spawn guard, the Codex transport guard and the `docs/agent-lifecycle.md` rewrite were
  dropped too, because each describes upstream code rather than a patch. `v0.10.0`
  rewrote pi's `streamHistory` (#5309 added the extension host and the close signal), so
  the pi release was re-applied by hand around the new call. The bullets below describe the
  whole PR, #5132; where they name omp, opencode, plugin-provider, Claude or Codex, that
  code is upstream's on this branch.
- **ACP release is upstream's since the v0.12.0 sync.** #6228 (`a9fef4879`, `v0.11.0`)
  threads `purpose` into `ACPAgentSession`, and #6766 (`058375dac`, `v0.12.0`) releases a
  history read's process with `releaseHistoryRuntime()`: it keeps the child registered when
  the kill times out, so `close()` can retry, settles the commands-ready wait and marks the
  session released. It calls `applyConfiguredOverrides()` first, so a session opened only to
  be read is still sent mode, model, thinking and feature writes. The patch in
  `acp-agent.ts` is now only the `resumePurpose === "history"` branch that calls upstream's
  release and returns before the overrides; the fork's `releaseTransportAfterHistoryLoad()`
  left. Its test, `purpose: %s resume sends these stored mode, model and thinking overrides`,
  binds both halves: a history resume sends none of them, an interactive resume sends all
  three.
- **What:** `purpose: "history"` is now a real per-provider contract instead of an ignored
  hint. Claude and OMP already spawn nothing to serve a history read (Claude reads the
  session's own `.jsonl`; OMP's `streamHistory` reads the session file directly) — Claude
  gets a regression guard so a future edit that starts spawning here turns red, and OMP
  returns a dedicated `OmpHistorySession` instead of calling `runtime.startSession`. Codex,
  Pi, and the ACP-based providers (`acp-agent.ts`) spawn to serve the read and release that
  process themselves right after. Codex's half is upstream's own since the 0.9.1 sync:
  #4736 (`a7ce602c8`) reads an archived thread through a temporary app-server that
  `readArchivedHistory()` disposes in a `finally`, never loads or resumes the native thread,
  and leaves the session `history-ready`, which keeps `getRuntimeInfo()` from reconnecting —
  so the fork's post-connect dispose was dropped in that merge, and the fork's test
  `releases the Codex app-server transport once the history read completes` stays as a guard
  on upstream's behaviour. The ACP providers skip the interactive setup calls
  (`applyConfiguredOverrides`) that would otherwise mutate a session opened only to read it,
  then release the child process without the `unstable_closeSession` RPC a real teardown
  sends; Pi's `streamHistory()` self-releases the runtime (and MCP/extension cleanup) after
  its first read and replays a cache on any later call — see below for a completion the
  first cut of this left open. Plugin-provider spawns nothing new per read — its session sits
  on the plugin's shared connection — but still does not release what it holds. OpenCode's
  shared-server path is the same, a refcount on an existing server rather than a new process
  (its live event-stream subscription is skipped for a history purpose, and a
  provider-declared `abort()` branch that could reach the shared server's session is also
  skipped), but `resumeSession`'s dedicated-server path is not: when
  `requiresDedicatedOpenCodeServer` is true it calls `acquireDedicated`, which starts a new
  process regardless of purpose, and nothing calls `close()` on a history-purpose session, so
  that process leaks in full — see `docs/agent-lifecycle.md`'s `purpose: "history"` paragraph,
  which this branch corrected to state only what each provider's own code supports.
- **What this branch deliberately does not do:** a shared helper releasing the read endpoints
  by last-reader accounting went through four designs — a module-level refcount, a scope
  object with an `AgentSession` ownership token, a manager-held lease, and an ownership
  decision made inside the lifecycle lane — and all four failed independent cross-review on
  the same shape, eight blocking findings across four rounds: state mutated from outside
  `AgentManager`'s per-agent lifecycle lane (`runLifecycleMutation`, a tail-chained queue with no
  re-entrancy — awaiting anything inside a lane operation that takes the lane for the same
  agent deadlocks it permanently). That half is going upstream as an issue instead of landing
  here. That gap is stated in #5132's `What this does not solve` section rather than in a
  separate issue. Plugin-provider's and OpenCode's leaks are the resulting, documented gap;
  do not close it with a shared helper.
- **Pi's release also covers the error and early-abandon paths**, not just the path where
  `streamHistory()`'s read completes normally: the read is now wrapped in a `try`/`finally`,
  so a `get_messages` RPC failure or a consumer that stops iterating early still reaches the
  `resumePurpose === "history"` release. Only a _completed_ read populates
  `historyReplayCache` — a partial one is not cached and replayed as if it were whole.
  Regression tests: `releases the runtime when the history read throws mid-fetch` and
  `releases the runtime when the history read is abandoned before it completes`
  (`providers/pi/agent.test.ts`), both stated as mutant claims and executed both ways —
  reverting the `try`/`finally` to the original "release only after the loop" shape fails
  both with `expected "close" to be called 1 times, but got 0 times`; restored, the full
  file passes 90/90. Since `7af90acd0` (a cherry-pick of #5132's `c86ee249e`) the
  entry-capture prompt runs inside that same `try`, so a capture that rejects before
  the read begins releases the runtime too, and `requestEntryCapture`'s still-pending
  extension result carries a no-op `catch`, so the release cannot surface as an
  unhandled rejection. Regression test: `releases the runtime when the entry-capture
prompt rejects before the read begins`. Both mutants were executed: `pi/agent.ts`
  reverted to its pre-fix version fails that test (1 failed, 108 passed); removing
  only the `catch` passes all 109 tests but vitest exits 1 on the unhandled rejection.
- **Sites (since the v0.10.0 sync):** `providers/acp-agent.ts`, `providers/pi/agent.ts`,
  `providers/acp-agent.test.ts`, `providers/pi/agent.test.ts`. Before that sync this
  patch also owned `plugin-provider.ts`, `providers/omp/agent.ts`,
  `providers/opencode-agent.ts`, their suites, the opencode test harness,
  `providers/omp/agent.history-purpose.test.ts`, `providers/claude/agent.spawn.test.ts`,
  the Codex suite's transport guard and `docs/agent-lifecycle.md`. Derive the current set
  with the `Sync procedure` gate below. Do not trust this list.
- **Coverage:** `providers/pi/agent.test.ts` and `providers/acp-agent.test.ts` by
  explicit path (see the sync counts in `Sync procedure`).
- **No `SLP-PATCH` marker.** The marker gate cannot see this patch, so a sync reads
  its hunks: pi's `try`/`finally` release in `streamHistory()` and ACP's history branch,
  which returns before `applyConfiguredOverrides()`, must both survive.
- **Upstream status: none, and the patch is kept.**
  [getpaseo/paseo#5132](https://github.com/getpaseo/paseo/pull/5132) is closed unmerged.
  Its OMP half landed with co-authorship as #5550; the maintainer's closing comment says
  the pi, ACP, OpenCode and plugin changes are not included. The pi defect and the ACP
  overrides are still present at `v0.12.0`, so this branch carries them with no upstream route.

### agent-message-raw-body

Added 2026-10-20, on the v0.12.0 sync branch. Room-local: the room decided nothing goes to
getpaseo/paseo, so there is no upstream PR.

- **What:** `formatAgentMessage` (`agent/agent-messages/index.ts`) writes the body of every
  agent-sent envelope, `agent-message` and every `agent-notification` event, as the sender's
  bytes, and marks the envelope `body="raw"`. Upstream (#6373, `v0.12.0`) XML-escapes every
  body, so the receiving model is given `&lt;sha&gt;` and `&amp;&amp;` for `<sha>` and `&&`.
- **Why it matters here:** the room's scratch proof E sent each family the command
  `printf '%s\n' '<sha>' && printf '%s\n' 'ROOM-XML-PASS'` on the idle and steered paths,
  three times each. Every harness delivered the escaped form, Codex ran the entity form as
  written in two of its six runs (exit 2), and a field holding a literal `&amp;` came back
  double-encoded in most runs. The table is the room's `~/.cache/paseo-sync-v0.12/proofs/E-table.md`.
- **The one escape kept:** only the envelope's own tag can end an envelope or open a second
  one, so a raw body escapes that tag sequence alone: `<` before `paseo-system` or
  `/paseo-system`, the tag in any letter case, becomes `&lt;`, and an `&lt;` or `&amp;…lt;`
  already there gains one `amp;`. The entities match only in lower case, the case the
  escape writes, so any other spelling (`&LT;`, `&Lt;`, `&AMP;lt;`) is never touched in
  either direction. The parser reverses exactly that escape, so every body round-trips byte
  for byte, whatever the case of its entities or tags, and it refuses a raw body that
  carries an unescaped envelope tag, so a body cannot read as a second sender.
- **What it leaves alone:** an envelope without `body="raw"` decodes as upstream wrote it,
  so history an unpatched v0.12 daemon wrote still projects as before. The human send path
  is upstream's: `prepareAgentMessage` with no source still quotes a pasted envelope, raw or
  escaped, as a fully escaped `user-message`. Every reader of the envelope goes through
  `parseAgentMessage`: the timeline projection `projectAgentMessage` (live events, history
  replay, accepted submissions), the human path's quoting check, and the manager's
  out-of-band slash-command unwrap in `tryRunOutOfBand`. The app, the protocol package and
  the activity curator read the projected `agentMessage.text`, never the envelope.
- **Known limit:** a reader that does not know `body="raw"`, an unpatched v0.12 daemon reading
  this daemon's history, decodes a raw body as XML. A body with a raw `<`, `>` or bare `&`
  then falls back to a plain user row without its sender, and `&amp;` reads as `&`. A rollback
  to the v0.11 fork reads no envelope at all.
- **Sites:** two markers, both in `agent/agent-messages/index.ts` (the format and the parse).
- **Coverage:** `agent-message-raw-body.slp.test.ts` drives `sendPromptToAgent` into a real
  `AgentManager` whose fake provider records the prompt its session receives, then replays
  those bytes as provider history through `hydrateTimelineFromProvider`. Its tables bind the
  model's bytes per envelope kind, the projected text, history written escaped, the envelope
  boundary, and the human path.
- **Retirement and revisit:** if upstream stops escaping agent bodies, or delivers them some
  other way that gives the model the sender's bytes, re-run the room's proof E on the new
  pin before dropping this patch.

### agent-send-interrupt

Added 2026-10-20, on `slp/agent-send-interrupt`, by the room's plan
`plans/agent-send-interrupt.md` (AI-airoom `f4bc11420`). Room-local, no upstream PR.

- **What:** an agent's send into a running turn interrupts it unless the sender asks for
  `steer`. Upstream #5164 (`v0.12.0`) made `steer` the default for agent callers on both
  agent-send paths: MCP `send_agent_prompt` with an agent-scoped server (`callerAgentId`),
  and `paseo send` with `PASEO_AGENT_ID` set. Both now default to `interrupt`, as top-level
  sends already did. An explicit `activeTurnBehavior: "steer"` or `--behavior steer` still
  steers, with upstream's fallback to interrupt-and-replace when the provider reports steering
  unavailable.
- **Why it matters here:** a steered correction can be ignored by a codex turn that finishes
  its original task, and the sender learns nothing. The room's Phase B measured 11 misses in
  27 steered sends and 0 in 33 interrupting ones (AI-airoom#849).
- **Where the default is decided:** at each sender, because the daemon cannot tell an
  explicit `steer` from a defaulted one. The CLI always sends the field, so a daemon whose
  default for an absent field differs cannot steer it.
- **What it leaves alone:** sends the daemon makes itself keep the `steer` they pass
  explicitly. A finish notification (`setupFinishNotification`) steers into the caller's
  running turn, so a child finishing does not abort the work of the agent that waits on it. A
  schedule fire refuses an agent with a run in flight, and its `steer` only governs the race
  between that check and the dispatch. The `send_agent_message_request` RPC, the app composer,
  review feedback, the Hub and voice input are top-level and unchanged: the RPC still
  defaults an absent field to `interrupt` and honours an explicit one.
- **Known limit:** an unpatched `paseo` CLI (upstream `v0.12`) on a seat's `PATH` still
  sends an explicit `steer` for `PASEO_AGENT_ID` callers, and this daemon honours it.
- **Sites:** three markers in code (`paseo-tools.ts`: the handler default and the schema
  text; `cli/src/commands/agent/send.ts`) and four in `mcp-server.test.ts`, where upstream's
  dispatch table now expects an agent-scoped send with no behavior to interrupt, its
  unavailable-steer row asks for `steer` explicitly, and the steer-acknowledgement tests ask
  for `steer` on the sends they mean to steer. `skills/paseo/SKILL.md`,
  `public-docs/cli.md` and `public-docs/orchestration-workflows.md` state the new default.
- **Coverage:** upstream's `send_agent_prompt` dispatch table in `mcp-server.test.ts` drives
  the tool through its input schema into a real `AgentManager`; the CLI's
  `send.slp.test.ts` drives `paseo send` and `paseo agent send` through commander and records
  what reaches `sendAgentMessage`.
- **Retirement and revisit:** if upstream returns the agent default to `interrupt`, drop the
  patch; if it moves the decision into the daemon, re-apply it there.

### interrupted-turn-terminals

Added 2026-10-20 by the same plan as `agent-send-interrupt`. Room-local, no upstream PR. It
is a patch of its own, not a widening of that one: it repairs every interrupt of a Codex turn,
whoever sends it, it lives in the provider rather than at the senders, and it retires on a
different condition.

- **What:** after Codex accepts `turn/interrupt`, the provider ends each shell command the
  interrupted turn started that has not exited, with
  `thread/backgroundTerminals/terminate {threadId, processId}`. It ends no other turn's
  process. A turn Paseo starts through `startTurn` waits for those calls before its
  `turn/start`. A turn Codex starts on its own, such as a goal continuation, is not ordered by
  that wait and can begin before the cleanup ends. Its commands still survive the cleanup,
  because the cleanup ends only the interrupted turn's ids.
- **Why it matters here:** `turn/interrupt` ends the turn and leaves its commands running
  (codex 0.163). The room's first live interrupt series saw the interrupted command run to its
  own end in all three runs (AI-airoom#849), and the room's hand probe P2a
  (`~/.cache/paseo-fix-interrupt/p2a/SUMMARY.md`) read it from `/proc`.
- **Attribution:** `thread/backgroundTerminals/list` carries no turn and a null `osPid`, so the
  provider records each root-thread `commandExecution` `processId` under the `turnId` of its
  `item/started`. A `completed` item drops its id. A `failed` one keeps it, because Codex
  reports the interrupted turn's still-running command as failed. A turn that ends any way
  other than `interrupted` forgets its ids, so a server an earlier turn left running on
  purpose is never ended by a later interrupt. At most 16 turns are remembered.
- **What it never does:** call `thread/backgroundTerminals/clean`, which ends every terminal on
  the thread, an earlier turn's and a running later turn's included (probe runs A and B). It
  ends nothing after an already-idle interrupt, nothing on a subagent's thread, and nothing
  after an interrupt of a turn Codex never identified.
- **Bounds:** each terminate times out after 2 s. A refused, failed or unanswered terminate is
  logged (`provider.codex.interrupt.terminal_terminate_failed`) and never fails the interrupt
  or the next turn. `startTurn` waits at most the interrupt's bound plus one terminate's plus
  500 ms, then starts and logs `provider.codex.interrupt.terminal_cleanup_timed_out`.
- **Entry points:** every path to `AgentManager.cancelAgentRun`, which calls the session's
  `interrupt()`. These are the app's stop and `cancel_agent_request`, MCP `cancel_agent`,
  `paseo stop`, archive (`archiveAgentCommand`), Hub interrupt (`DaemonExecutions`), refresh,
  and through `cancelAgentRunBefore` the replace of a running turn (every interrupting send,
  and a steer the provider cannot take), reload and rewind.
- **Known limit:** archive and reload still end every terminal of the session, an earlier
  turn's included, because they close the Codex app-server after the interrupt, and closing it
  ends its terminals. This is measured, it is unchanged from `558899202`, and this patch does
  not cause it. The room's proof runs `p2b-archive` and `p2b-reload`
  (`~/.cache/paseo-fix-interrupt/proofs/runs/`) read from `/proc` that turn 1's background
  command and the interrupted turn 2's command were both alive before the action and both gone
  after it, and probe P2a saw the same by hand when the app-server closed. The patch's cleanup
  for those two paths runs on the closing session's client and is logged as failed if that
  client is already gone.
- **Sites:** nine markers, all in `providers/codex-app-server-agent.ts`.
- **Coverage:** `codex-interrupted-turn-terminals.slp.test.ts` drives a real
  `CodexAppServerAgentSession` against the scripted app-server in
  `codex/test-utils/fake-app-server.ts`. It binds which processes end, an earlier turn's and a
  Codex-started next turn's surviving, the order against `turn/start`, a failing terminate, and
  that `clean` is never sent.
- **Retirement and revisit:** if Codex ends an interrupted turn's commands itself, re-run the
  room's probe P2a on the new version and drop the patch. If `list` gains a turn id, match on
  it instead of the record.

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

At `HEAD=7af90acd0`, with `UPSTREAM_OID` the `v0.9.1` tag
(`81865852011df86aa0ad0ae411cb2f5e4078153f`) and
`BASE=$(git merge-base HEAD "$UPSTREAM_OID")`, the documented
`git diff --name-only "$BASE" HEAD -- packages/ | sort` invocation returned
**36 files** for Set A (23 at `e92e5d29`, before
`history-purpose-provider-contract` and `claude-history-follows-provider-env`'s
e2e test); filtering `.slp.test.ts` returned **33** for Set B. The difference from
Set A is the three fork-only `.slp.test.ts` files, which cannot appear in an
upstream diff. Set B itself still contains three fork-only files —
`native-tools-gate.ts`, `providers/omp/agent.history-purpose.test.ts` and
`daemon-e2e/agent-refresh-follows-provider-env.e2e.test.ts` — so only **30** of
its arguments can match an upstream diff. Both numbers are outputs of the
that command, not claims: regenerate them, do not trust them.

At the v0.10.0 sync the same Set A command against `d6861f81e`, the previous
sync's base, returned **38** files. With `BASE` = `v0.10.0` after the merge it
returns **29**, because two patches narrowed or left. The fork's code diff
against its upstream base went from 39 files, +3224/−78 (at `0a71258c1` over
`d6861f81e`, `packages/` and `docs/`) to 29 files, +2483/−63 (over `v0.10.0`).
The only fork-only file left in Set B is `native-tools-gate.ts`.

After the v0.12.0 sync, with `BASE` = `v0.12.0`, Set A returns **26** files and Set B
**23**, and the fork's code diff over `packages/` is +2167/−45. `comm -23` below leaves
**14** patched files with nothing to grep for.

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

# The wakeup-each watcher's shape, without checking anything out.
git cat-file -p "$T:packages/server/src/server/agent/agent-prompt.ts" \
  | grep -nE 'SLP-PATCH\(wakeup-each\)|agent_state|observeState|timeline_replacement|event\.event\.type|hasSeenRunning|hasSeenTurn|waitForTurnStart|dispatchResult|supersed|terminal: false'
```

The last one is the check no marker count can make, and it is read, not counted. Read the
control flow around the lines it prints:

- The `agent_state` and `timeline_replacement` variants return before any
  `event.event.type` read. A replacement carries no `.event`; read below the guard, the
  first one throws inside the watcher that makes a caller hear its children finish, and
  every marker is still present.
- The idle state alone sends nothing.
- `turn_completed` notifies only with the child idle and a running turn observed, then
  clears both `hasSeenRunning` and `hasSeenTurn` and sends `finished` with
  `{ terminal: false }`. A repeated terminal event with no new turn sends nothing.
- An idle `turn_canceled` is the one terminal `was canceled`; a cancellation while the child
  is still running sends nothing. `errored` and `was closed` stay terminal; permission
  checkpoints stay nonterminal.
- The archived-caller branch calls `stop()` before it returns.
- #5164's mechanics are upstream's, unchanged: a failed dispatch removes only its own
  observer, a successful one supersedes earlier observations of the pair, a new turn's
  observer waits for the turn to start, and the `dispatchResult === "turn_started"` stop
  stays.

Then merge:

```bash
git merge "$UPSTREAM_OID"     # the pinned OID, not the ref: a ref re-read at
                              # merge time can differ from the one you checked

# Marker gate. Measured after interrupted-turn-terminals (2026-10-20): expect 13
# names across 46 code/test sites in 14 files, and use the per-name manifest
# below -- a bare total hides a site moving from one patch to another. This file is excluded
# because it quotes marker-shaped strings in its own prose, in a number that
# changes whenever the prose does; include it and the gate can never pass on a
# healthy tree. Note -I (--no-filename): -o alone prefixes each match with its
# path, so sort -u would dedupe path:name pairs and return one line per file,
# not per name.
rg -c "SLP-PATCH\(" packages/ | awk -F: '{n+=$2} END {print n" sites"}'
rg -oI "SLP-PATCH\([a-z-]+\)" packages/ | sort -u | wc -l  # expect 13
rg -oI "SLP-PATCH\([a-z-]+\)" packages/ | sort | uniq -c | sort -rn
#    9 interrupted-turn-terminals             3 interrupt-releases-foreground
#    7 agent-send-interrupt                   3 detached-wakeup
#    6 native-tools-injection-independent     2 force-cancel-releases-foreground
#    4 wakeup-each                            2 detached-arg
#    3 replace-awaits-teardown                2 agent-message-raw-body
#    3 mcp-protocol-version-clip              1 dispose-releases-foreground
#                                             1 dead-run-settles
# The census is scoped to packages/ because that is the measured code/test
# population; evidence/080-mutants/MUTANTS.md quotes the marker in prose.
# archived-live-list and history-purpose-provider-contract are absent from this
# manifest by design -- they carry no marker, so their survival checks are
# behavioural (see their sections).

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

# Every test run goes through vt, which refuses a call that names no existing
# test file and gives each run fresh scratch homes under ~/.cache, not /tmp, and
# no seat identity. vitest reads a positional argument as a substring filter, so
# a stray `--` or a typo runs the whole workspace: the v0.12.0 sync's measurement
# did exactly that once. Code that is passed no home falls back to the
# environment's PASEO_HOME (packages/server/src/utils/worktree.ts:867,871), which
# in a seat is the live ~/.paseo; CLAUDE_CONFIG_DIR and TMPDIR reach the live
# Claude history and a quota'd tmpfs the same way. PASEO_HOME alone does not
# isolate a run: two e2e files resolve the local speech model directory from
# homedir() unless PASEO_LOCAL_MODELS_DIR is set, and that stray run wrote
# ~/.paseo/models/local-speech/silero-vad/silero_vad.onnx. So vt sets HOME and
# PASEO_LOCAL_MODELS_DIR to scratch too. Never call vitest any other way here.
vt() {
  local a f=0
  for a in "$@"; do
    case "$a" in
      --) echo "vt: refused: a bare --"; return 64 ;;
      -*) ;;
      *.test.ts) [ -f "$a" ] || { echo "vt: refused: no file $a"; return 64; }; f=1 ;;
      *) echo "vt: refused: $a is not a test file"; return 64 ;;
    esac
  done
  [ "$f" = 1 ] || { echo "vt: refused: no test file named"; return 64; }
  local scratch; scratch=$(mktemp -d ~/.cache/paseo-sync-test.XXXXXX) || return 70
  mkdir -p "$scratch"/{paseo-home,claude,tmp,home,local-models}
  env -u PASEO_AGENT_ID -u PASEO_AGENT_CWD \
    PASEO_HOME="$scratch/paseo-home" CLAUDE_CONFIG_DIR="$scratch/claude" \
    TMPDIR="$scratch/tmp" HOME="$scratch/home" PASEO_LOCAL_MODELS_DIR="$scratch/local-models" \
    ./node_modules/.bin/vitest run "$@"
}
vt                            # shows the refusal once, before the first run

vt packages/server/src/server/agent/agent-prompt.slp.test.ts --bail=1
vt packages/server/src/server/agent/agent-prompt.test.ts --bail=1
vt packages/server/src/server/agent/create-agent/create.slp.test.ts --bail=1
vt packages/server/src/server/native-tools-gate.slp.test.ts --bail=1
vt packages/server/src/server/agent/create-agent/create.test.ts --bail=1
vt packages/server/src/server/agent/provider-registry-wrap.test.ts --bail=1
vt packages/server/src/server/agent/mcp-server.test.ts
vt packages/server/src/server/agent/providers/claude/agent.test.ts
vt packages/server/src/server/agent/providers/claude/question-response.test.ts    # #6936, retired question-answer-required
vt packages/server/src/server/agent/providers/codex-app-server-agent.test.ts
vt packages/server/src/server/agent/agent-manager.test.ts
vt packages/server/src/server/agent/mcp-parity.e2e.test.ts --testTimeout=30000    # below a 1-minute load of 16
vt packages/server/src/server/agent/agent-mcp.e2e.test.ts     # mcp-protocol-version-clip
vt packages/server/src/server/agent/providers/pi/agent.test.ts        # history-purpose (pi)
vt packages/server/src/server/agent/providers/acp-agent.test.ts       # history-purpose (acp)
vt packages/server/src/server/agent/providers/generic-acp-agent.test.ts
vt packages/server/src/server/agent/providers/generic-acp-agent.archived-history.test.ts  # #6766's release
vt packages/server/src/server/agent/agent-message-raw-body.slp.test.ts --bail=1   # agent-message-raw-body
vt packages/cli/src/commands/agent/send.slp.test.ts --bail=1   # agent-send-interrupt
vt packages/server/src/server/agent/providers/codex-interrupted-turn-terminals.slp.test.ts --bail=1   # interrupted-turn-terminals
vt packages/server/src/server/schedule/service.test.ts
vt packages/server/src/server/daemon-e2e/claude-provider-config-dir-history.e2e.test.ts

npm run format:check

# Lint was measured on HEAD with `npm run lint`: Found 0 warnings and 0 errors.
# The former two-error baseline was stale; commit
# `06ac487da8bc1b2398eaedba11da4d3fff958938` fixed the `complexity 24 > 20`
# error in `interrupt()` and `no-multiple-resolved`, both in
# `codex-app-server-agent.ts`. Measure lint again after each merge.
npm run lint
git push origin slp/patches
```

Measured at the v0.12.0 sync (2026-10-19), each file through `vt` by explicit path, at a
1-minute load of 1.4 to 4.7. Every file passed completely: `agent-prompt.slp` 10,
`agent-prompt` 17, `create.slp` 4, `native-tools-gate.slp` 4, `create` 11,
`provider-registry-wrap` 4, `mcp-server` 201, `claude/agent` 94, `claude/question-response` 12,
`codex-app-server-agent` 193, `agent-manager` 208, `mcp-parity.e2e` 35 (35 at the 5 s default
too), `agent-mcp.e2e` 12, `pi/agent` 130, `acp-agent` 119, `generic-acp-agent` 1,
`generic-acp-agent.archived-history` 5, `schedule/service` 71 and
`claude-provider-config-dir-history.e2e` 2; `agent-message-raw-body.slp` (added 2026-10-20) 28; CLI `send.slp` (added 2026-10-20) 7; `codex-interrupted-turn-terminals.slp` (added
2026-10-20) 5.
`npm run build:server` and `npm run typecheck`
exit 0, `npm run format:check` is clean, and `npm run lint` reports 0 warnings and 0 errors.
Against unpatched `v0.12.0`, by full test name, no upstream test is missing; every surplus
name is a kept, adapted or new fork test.

- `agent-mcp.e2e` builds its daemons with `createPaseoDaemon` directly, which starts every
  built-in plugin (#5465, #5714): each is compiled with esbuild and run in-process
  (`packages/server/src/server/plugins/runtime.ts`). `test-utils/paseo-daemon.ts` passes an
  empty `BuiltinPluginLoader`. Under load its `create_agent` tests have hit their 30 s
  timeout at earlier syncs; read a timeout here as that cost, not as a patch regression.

Order matters. Typecheck first — it fails fastest and on the class of breakage
a merge introduces. Then the `.slp.` files, which this fork owns and which are
the cheapest signal. Then the upstream-owned suites, which are where a patch
contradicting upstream intent surfaces.

`mcp-parity.e2e.test.ts` runs without `--bail=1`, at `--testTimeout=30000`, and below a
1-minute load of 16. Until `v0.11.0` it failed four Suite E worktree-tool names in this
environment before and after every sync, and those four names were its baseline. They do not
exist at `v0.12.0`: upstream replaced them, and unpatched `v0.12.0` passes 33 of 33 at
`--testTimeout=30000`. **So every failure at 30 s is the merge's.** A timeout at the 5 s
default is machine load (Suite D's `list_providers returns providers` has timed out there
before); re-run it at 30 s before reading it.

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

A sync reaches no seat until the room activates it. The room repository (`~/Sites/AI/airoom`)
owns each step, and its `runtime/paseo/README.md` holds the commands; this list gives the
order, which is the safeguard:

1. **Land the sync** by fast-forwarding `slp/patches` to the reviewed head.
2. **Advance this clone's git HEAD, with the daemon still running.** No `npm` yet: `npm ci`
   replaces `node_modules` under a running daemon. Seats reach this repository's `skills/`
   through membership links into the clone's working tree, so a skill change is live from
   here, before any restart; read it with `git diff --name-only <old-revision>..HEAD --
skills/`, and open no seat until the restart is done.
3. **Merge and publish the room PR** that moves `runtime/paseo/revision.json` to the new head
   and carries the room code the new daemon needs, the recorder's plugin range first.
   `room-seat-preflight` compares this clone's HEAD with `revision.json`, so it passes against
   the daemon still running the old build.
4. **Stop, build, start.** The room's `AGENTS.md` R3 applies before the stop: every active
   schedule targeting a seat the stop closes is dispositioned. Stop through the room
   entrypoint (`paseo-daemon.sh stop`), run `npm ci --ignore-scripts`, `npm run postinstall`,
   `npm run build:server && npm run build:daemon-web-ui`, then `paseo-daemon.sh start`.
5. **Read the running version.** `paseo daemon status` and the daemon log's `daemonVersion`
   must name the new release. The preflight in step 3 read HEAD only, so this read is what
   catches a start that served the old build.

The room publishes before the stop, not after it, because the daemon serves whatever
`packages/server/dist` holds at start and loads the room's plugins then: its first start
must find room code that admits it, which a revision bump published after the restart
cannot give.
