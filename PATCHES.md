# PATCHES

Local patches carried on `slp/patches` (fork `thomasvan/paseo`) on top of upstream
`getpaseo/paseo`. A patch is a change this fork makes to upstream code; git holds how each one
came to be, and this file says what each one does now, why, and how to carry it through a sync.

Every patch site in code is marked `SLP-PATCH(<name>)`, except `archived-live-list` and
`history-purpose-provider-contract`, which carry no marker and are checked by behaviour (see
their sections). When a hunk conflicts, re-apply the patch's intent onto upstream's current
shape from its section below; do not restore an old diff.

## The patches

| Patch                                                                       | What it fixes                                                                                 | Upstream                                                                                                                             |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [`wakeup-each`](#wakeup-each)                                               | a caller hears every finish of a long-lived child, not only the first                         | issue [#6346](https://github.com/getpaseo/paseo/issues/6346), Discussion [#4669](https://github.com/getpaseo/paseo/discussions/4669) |
| [`detached-wakeup`](#detached-wakeup)                                       | a child created detached still notifies the caller that created it                            | PR [#3094](https://github.com/getpaseo/paseo/pull/3094), issue [#6908](https://github.com/getpaseo/paseo/issues/6908)                |
| [`detached-arg`](#detached-arg)                                             | the advertised `create_agent` schema can ask for a detached child                             | Discussion [#4670](https://github.com/getpaseo/paseo/discussions/4670)                                                               |
| [`mcp-protocol-version-clip`](#mcp-protocol-version-clip)                   | an MCP client newer than the bundled SDK gets past `initialize`                               | PR [#4570](https://github.com/getpaseo/paseo/pull/4570), issue [#3009](https://github.com/getpaseo/paseo/issues/3009)                |
| [`native-tools-injection-independent`](#native-tools-injection-independent) | native Paseo tools survive MCP injection being off                                            | Discussion [#4671](https://github.com/getpaseo/paseo/discussions/4671)                                                               |
| [The Codex foreground cluster](#the-codex-foreground-cluster)               | a Codex session's foreground slot is released on every path that ends its turn (five patches) | issue [#3256](https://github.com/getpaseo/paseo/issues/3256); PR [#4041](https://github.com/getpaseo/paseo/pull/4041) open           |
| [`archived-live-list`](#archived-live-list)                                 | an archived agent resumed for a history read stays archived in `list_agents`                  | PR [#3803](https://github.com/getpaseo/paseo/pull/3803), issue [#4753](https://github.com/getpaseo/paseo/issues/4753)                |
| [`history-purpose-provider-contract`](#history-purpose-provider-contract)   | a pi history read releases the runtime it spawned                                             | not opened                                                                                                                           |
| [`agent-message-raw-body`](#agent-message-raw-body)                         | the receiving model gets an agent sender's bytes, not their XML-escaped form                  | not opened                                                                                                                           |
| [`agent-send-interrupt`](#agent-send-interrupt)                             | an agent's send interrupts a running turn unless it asks to steer                             | not opened                                                                                                                           |
| [`interrupted-turn-terminals`](#interrupted-turn-terminals)                 | an interrupted Codex turn's shell commands end                                                | not opened                                                                                                                           |
| [`interrupted-turn-tasks`](#interrupted-turn-tasks)                         | an interrupted Claude turn's shell commands end, its background ones included                 | not opened                                                                                                                           |

The Codex foreground cluster is five patches: `replace-awaits-teardown`, `dead-run-settles`,
`interrupt-releases-foreground`, `dispose-releases-foreground` and
`force-cancel-releases-foreground`, sixteen patches in all.

## Where the tests live

A patch's tests sit in a fork-only `.slp.test.ts` file where upstream owns the file beside the
code, so the upstream file stays upstream's and never conflicts on merge:
`agent-prompt.slp.test.ts`, `create-agent/create.slp.test.ts`, `native-tools-gate.slp.test.ts`,
`mcp-protocol-version-clip.slp.test.ts`, `agent-message-raw-body.slp.test.ts`,
`providers/codex-interrupted-turn-terminals.slp.test.ts`,
`providers/claude/agent.interrupted-turn-tasks.slp.test.ts` and, in the CLI package,
`commands/agent/send.slp.test.ts`. The other patches extend upstream's own suites, beside the
cases they change. Every patch test fails under at least one mutant of its patch's lines, and
together they kill every such mutant an earlier, larger set of tests killed.

Three fork tests guard upstream behaviour this fork depends on and no upstream test guards.
Each leaves when upstream adds an equivalent:

- `schedule/service.test.ts`, `refuses a manual run while a scheduled claim is in flight`:
  the reservation of a schedule before its claim. With the reservation moved after the claim,
  no other test fails.
- `providers/acp-agent.test.ts`, `purpose: history releases the child process after loadSession
replay, and close() afterward is a no-op`: an ACP history read releases its process once.
- `create-agent/create.slp.test.ts`, `a detached child's watcher is armed before its first
prompt and disarmed when that prompt fails`: the create path's arm-before-dispatch and
  disarm-on-failure.

Two patch files are end-to-end suites that upstream CI does not run (`agent-mcp.e2e.test.ts`
and `mcp-parity.e2e.test.ts`: the server's `test:integration` list names neither), so a sync
runs them by hand; see `Sync procedure`.

## wakeup-each

- **What:** the finish watcher in `setupFinishNotification` (`agent-prompt.ts`) stays armed
  after a finish. The idle `turn_completed` branch clears both per-cycle gates,
  `hasSeenRunning` and `hasSeenTurn`, and sends `finished` with `{ terminal: false }`, so the
  child's next observed turn notifies again and a repeated terminal event without one
  notifies nothing. An archived caller's branch calls `stop()` before it returns, because a
  watcher that outlives the first finish would otherwise hold its subscription for the child's
  whole life.
- **Why:** a caller that drives one long-lived child across many prompts has to hear every
  finish. Watchers exist only for agent callers (`notifyOnFinish` and `callerAgentId`), so the
  behaviour is derived, with no `notifyMode` parameter; upstream would want it opt-in, and that
  is the shape to propose there.
- **What it leaves to upstream:** the acknowledgement mechanics. A successful follow-up
  dispatch supersedes the re-armed watcher, a rejected one stops only its own, a new turn's
  watcher waits for the turn to start, and the watcher disarms on an idle `turn_canceled`
  (`was canceled`), `was closed` and `errored`.
- **Re-applying:** this is a semantic patch on a state machine upstream keeps rewriting. The
  idle state alone must never send `finished`; the finish is the terminal `turn_completed`
  with the child idle and a running turn observed. The shape check under `Sync procedure`
  reads it.
- **Tests:** `agent-prompt.slp.test.ts` drives a real `AgentManager` with the events the
  manager publishes, the idle state followed by the terminal stream event.

## detached-wakeup

- **What:** the watcher registration in `create-agent/create.ts` passes
  `requireParentOwnership: !(input.detached ?? false)` instead of `true`.
- **Why:** the guard asks at fire time whether the child is still labelled as the caller's.
  `resolveCreateAgentIntent` strips that label from a child created detached, so the guard
  could never pass and the caller that asked for the child would never hear it finish.
- **Why at the create site:** inside the watcher, a detached child and a child whose label
  was removed later are the same input, and upstream's `agent-prompt.test.ts` ("detaching a
  child ends its parent-owned finish notification") requires the second to stay silent. Only
  the create call knows the caller asked for a detached child.
- **Tests:** `create-agent/create.slp.test.ts`, a two-row table (detached and parented). If
  #3094 merges with its tests in `create.test.ts`, delete this file's table rather than
  reconcile the two.

## detached-arg

- **What:** the agent-scoped `create_agent` schema in `tools/paseo-tools.ts` gains an
  optional `detached` boolean, and the canonical branch returns `parsed.detached ?? false`.
- **Why:** upstream accepts a detached request only through the COMPAT nested `relationship`
  shape, which the advertised schema does not mention, so a client that trusts the schema
  cannot ask for one.
- **No `.default(false)`:** a default injects `detached` into every parsed call, and the
  legacy schema is `.strict()`, so legacy placements would fail on the unrecognized key. Keep
  the field `.optional()` and coalesce at the read site.
- **Retire when:** upstream owns canonical detached creation. If `COMPAT(detachedCreate)` is
  removed or rewritten first, adapt this patch so `detached: true` still creates a parentless
  agent.
- **Tests:** `mcp-parity.e2e.test.ts`, a two-row table beside the legacy-shape test.

## mcp-protocol-version-clip

- **What:** `clipMcpProtocolVersionHeader` (`mcp-protocol-version-clip.ts`), called at the top
  of the agent MCP route in `bootstrap.ts`, normalizes an unsupported `mcp-protocol-version`
  header to the newest version the bundled SDK server supports. It rewrites `headers` and
  every matching `rawHeaders` pair, in any case, and collapses duplicate raw pairs to one.
- **Why:** clients negotiate protocols newer than the bundled `@modelcontextprotocol/sdk`
  knows (Claude Code speaks `2026-07-28`). The streamable-HTTP transport checks the header on
  every request but `initialize` and rejects an unknown version, so the client fails on its
  first request after `initialize`. `@hono/node-server` builds the Web Request from
  `rawHeaders`, so rewriting `headers` alone does nothing, and it joins duplicate pairs into a
  comma-separated value the SDK also rejects.
- **Retire when:** the bundled SDK supports the protocols the room's clients speak. Claude Code
  also takes `MCP_PROTOCOL_NEGOTIATION=legacy`, a client-side alternative.
- **Tests:** `mcp-protocol-version-clip.slp.test.ts`, a table that CI runs; one end-to-end case
  in `agent-mcp.e2e.test.ts` proves the route calls it.

## native-tools-injection-independent

- **What:** `bootstrap.ts` sets the native Paseo tool catalog's master switch with
  `isNativePaseoToolsEnabled(mcpEnabled)` (`native-tools-gate.ts`) at startup, at the MCP mount
  and in both live field-change handlers (`mcp.enabled`, `mcp.injectIntoAgents`). Upstream
  ties it to MCP injection (`mcpEnabled && mcp.injectIntoAgents !== false`).
- **Why:** the room serves each seat its own caller-scoped MCP server and runs injection off.
  With the catalog tied to injection, `AgentManager.prepareSessionConfig` stores
  `{ enabled: false }` as every new agent's Paseo tool policy, and the caller-scoped server,
  which builds its catalog from that stored policy, serves no tools at all. The per-provider
  `paseoTools` policy is a second gate on top and cannot undo it.
- **Tests:** `native-tools-gate.slp.test.ts` starts a daemon and reads the launch context an
  agent gets: tools with MCP enabled and injection off, none with MCP disabled. The live
  field-change handlers have no test.
- **Retire when:** upstream decouples the catalog from injection; delete the marker sites and
  `native-tools-gate.ts`.

## The Codex foreground cluster

Five patches repair one piece of state, the Codex session's single `activeForegroundTurnId`
slot, in `providers/codex-app-server-agent.ts`, with `force-cancel-releases-foreground` also in
`agent-manager.ts`, `agent-sdk-types.ts` and `provider-registry.ts`. Every release goes through
one keyed `releaseForegroundTurn(turnId)`, which clears the slot only for the turn that owns it
and wakes every `startTurn` waiting on it.

- **`replace-awaits-teardown`:** `startTurn` waits up to `FOREGROUND_TEARDOWN_WAIT_MS` for a
  held slot to clear before refusing. A replace reaches `startTurn` milliseconds before the
  interrupted turn's teardown clears the slot, because the manager's force-cancel settles its
  run record first. Every site that clears the slot flushes the waiters; a waiter that times
  out removes itself.
- **`dead-run-settles`:** `interrupt()` resolves instead of throwing when Codex accepted
  `turn/start` but never identified the turn, matching the Claude and ACP providers. A throw
  leaves the manager reading the cancel as unacknowledged, so it refuses every later stop and
  replace.
- **`interrupt-releases-foreground`:** that no-op branch releases the slot it sampled, because
  no turn-end event will ever arrive for an unidentified turn; an already-idle interrupt
  releases through the same keyed path.
- **`dispose-releases-foreground`:** `disposeClient()` emits `turn_failed` and releases the
  slot. A failed reconnect disposes the client, and a slot held past that refuses every later
  `startTurn`.
- **`force-cancel-releases-foreground`:** after its force-cancel, `cancelAgentRunNow` calls the
  session's optional `releaseForegroundTurn(runTurnId)` before awaiting settlement, because the
  force-cancel settles only the manager's record. The registry facade forwards the method:
  `wrapSessionProvider` enumerates the session surface by hand, so a method it does not
  forward never runs.
- **Retire when:** upstream's runtime reconciliation (#4041) replaces the provider runtime
  after a forced settlement; re-evaluate `force-cancel-releases-foreground` and
  `replace-awaits-teardown` first. The other three stay until a focused fix lands.
- **Tests:** in upstream's `codex-app-server-agent.test.ts` and `agent-manager.test.ts`,
  beside the cases they extend, and `provider-registry-wrap.test.ts` for the forward.

## archived-live-list

**No marker, by design:** the code matches PR #3803's shape so that upstream's version
converges instead of conflicting. Its survival check is behavioural: after any merge, an
archived agent resumed by a history read must stay out of a default `list_agents` and report
its real `archivedAt` with `includeArchived: true`.

- **What:** `serializeSnapshotWithMetadata` (`mcp-shared.ts`) merges the stored record's
  `archivedAt` into the snapshot (`agent-projections.ts`, `messages.ts`), and `list_agents`
  (`tools/paseo-tools.ts`) filters archives after projection.
- **Why:** a history read resumes an archived agent into memory, so `list_agents` sees it as
  live. A live `ManagedAgent` carries no archive timestamp, and upstream's `AgentDirectory`
  filters archives on raw live snapshots, so the agent was listed as active.
- **Rejected alternative:** carrying `archivedAt` on `ManagedAgent`. `unarchiveSnapshot`
  clears only the stored record, so a managed copy would report an unarchived agent as
  archived. Storage stays the one owner.
- **Tests:** `mcp-server.test.ts`, `excludes an archived agent that is also live from
list_agents`; upstream's own archive cases there cover the `includeArchived` side.

## history-purpose-provider-contract

**No marker.** A sync reads the hunk: pi's `streamHistory()` release must survive.

- **What:** a pi session resumed with `{ purpose: "history" }` (`providers/pi/agent.ts`)
  releases its runtime after its first history read, in a `try`/`finally`, so a read that
  completes, throws, is abandoned early, or whose capture prompt rejects before it begins all
  release. Only a completed read is cached and replayed to later calls.
  `requestEntryCapture`'s pending result carries a no-op `catch`, so the release cannot surface
  as an unhandled rejection.
- **Why:** a pi history read needs the live runtime (`get_messages` has no file to read), and
  without the release every archived pi agent whose history is read keeps a runtime resident
  for the rest of the daemon's life.
- **Tests:** `providers/pi/agent.test.ts`, the `resumeSession purpose: history` suite.

## agent-message-raw-body

- **What:** `formatAgentMessage` (`agent-messages/index.ts`) writes the body of every
  agent-sent envelope, `agent-message` and every `agent-notification`, as the sender's bytes,
  and marks the envelope `body="raw"`. Upstream XML-escapes every body, so the model receives
  `&lt;sha&gt;` and `&amp;&amp;` and can run the entity form as a command.
- **The one escape kept:** only the envelope's own tag can end an envelope or open a second
  one. A raw body turns `<` before `paseo-system` or `/paseo-system`, in any letter case, into
  `&lt;`, and adds one `amp;` to an `&lt;` or `&amp;…lt;` already there. The entities match
  only in lower case, the case the escape writes, so any other spelling is never touched. The
  parser reverses exactly that escape, so every body round-trips byte for byte, and it refuses
  a raw body that carries an unescaped envelope tag.
- **What it leaves alone:** an envelope without `body="raw"` decodes as upstream wrote it, and
  the human send path still quotes a pasted envelope as a fully escaped `user-message`. Every
  reader goes through `parseAgentMessage`.
- **Known limit:** a daemon without this patch reads a raw body as XML: a body with a raw `<`,
  `>` or bare `&` falls back to a plain user row without its sender.
- **Tests:** `agent-message-raw-body.slp.test.ts` sends through `sendPromptToAgent` into a real
  `AgentManager` and replays the bytes the provider received as history.

## agent-send-interrupt

- **What:** an agent's send into a running turn interrupts it unless it asks for `steer`, on
  both agent paths: MCP `send_agent_prompt` with an agent-scoped server (`paseo-tools.ts`, the
  handler default and the schema text) and `paseo send` with `PASEO_AGENT_ID` set
  (`cli/src/commands/agent/send.ts`). Upstream defaults agent callers to `steer`.
- **Why:** a steered correction can be ignored by a turn that goes on to finish its original
  task, and the sender never learns.
- **Where the default is decided:** at each sender, because the daemon cannot tell an explicit
  `steer` from a defaulted one; the CLI always sends the field.
- **What it leaves alone:** sends the daemon makes itself. A finish notification still steers
  into the caller's running turn, and top-level sends (the app, the RPC, the Hub, voice) are
  upstream's.
- **Known limit:** an upstream `paseo` CLI on a seat's `PATH` still sends an explicit `steer`
  for an agent caller, and the daemon honours it.
- **Tests:** upstream's `send_agent_prompt` dispatch table in `mcp-server.test.ts`, whose
  agent-scoped default row expects an interrupt and whose steer cases ask for `steer`; the
  CLI's `send.slp.test.ts`. `skills/paseo/SKILL.md`, `public-docs/cli.md` and
  `public-docs/orchestration-workflows.md` state the default.

## interrupted-turn-terminals

- **What:** once Codex accepts `turn/interrupt`, the provider ends each shell command the
  interrupted turn started and that has not exited, by process id, with
  `thread/backgroundTerminals/terminate`. A turn Paseo starts waits for those calls before its
  `turn/start`.
- **Why:** `turn/interrupt` ends the turn and leaves its commands running.
- **Attribution:** `thread/backgroundTerminals/list` carries no turn, so the provider records
  each root-thread `commandExecution` process id under the turn of its `item/started`. A
  `completed` item drops its id; a `failed` one keeps it, because Codex reports an interrupted
  turn's still-running command as failed. A turn that ends any way but `interrupted` forgets
  its ids, so what an earlier turn left running on purpose is never ended. At most 16 turns are
  remembered.
- **What it never does:** send `thread/backgroundTerminals/clean`, which ends every terminal on
  the thread. It ends nothing after an already-idle interrupt, nothing on a subagent's thread,
  and nothing after an interrupt of a turn Codex never identified.
- **Bounds:** each terminate times out after 2 s; a failed one is logged
  (`provider.codex.interrupt.terminal_terminate_failed`) and fails nothing. `startTurn` waits
  at most the interrupt's bound plus one terminate's plus 500 ms.
- **Known limit:** archive and reload close the Codex app-server, which ends every terminal of
  the session, an earlier turn's included; that is upstream's behaviour, not this patch's.
- **Retire when:** Codex ends an interrupted turn's commands itself. If `list` gains a turn id,
  match on it instead of the record.
- **Tests:** `codex-interrupted-turn-terminals.slp.test.ts` drives a real session against the
  scripted app-server in `codex/test-utils/fake-app-server.ts`.

## interrupted-turn-tasks

- **What:** after the provider interrupts a Claude turn, it stops each shell command that turn
  started and that has not ended, by task id, with `Query.stopTask` (`providers/claude/agent.ts`).
  It stops no other turn's command.
- **Why:** upstream passes `perTaskStopAffordance: true` so an interrupt spares background
  subagents, and the interrupted turn's `run_in_background` commands are spared with them.
- **Attribution:** `task_started` carries a `task_id` and `task_type: local_bash` for every
  Bash call. The provider keeps one record per Claude turn: the turn's `system/init` opens it
  and its `result` lets it go; a `task_notification` removes an ended task. A task the
  interrupted turn announces after the stops were sent is stopped as it arrives. A command a
  subagent ran belongs to the subagent.
- **An interrupt sent between turns:** Claude can open the turn for a prompt it had already
  dequeued after the interrupt was sent. The interrupt waits for the turn of the prompts it was
  for, and the CLI's `command_lifecycle {command_uuid, state: started}` frame, which names the
  prompt a turn takes, tells that turn from the next prompt's. A turn that took another
  prompt, an interrupted prompt that ends, or a turn that closes first ends the wait. A turn
  whose prompt is not named yet is taken only while no newer prompt is waiting.
- **Bounds:** the stops are sent after `query.interrupt()` settles or times out, and nothing
  awaits them; each times out after 3 s. Each outcome is logged
  (`provider.claude.interrupt.task_stopped`, `provider.claude.interrupt.task_stop_failed`).
- **Known limit:** a CLI that sends no `command_lifecycle` frame leaves the commands of a turn
  that opens after the interrupt, while the next prompt waits, running. Archive and reload
  close the Claude CLI, which ends every command of the session.
- **Retire when:** Claude Code ends an interrupted turn's background commands while sparing
  background subagents, or upstream stops passing `perTaskStopAffordance`.
- **Tests:** `providers/claude/agent.interrupted-turn-tasks.slp.test.ts` drives a real
  `ClaudeAgentSession` against a scripted SDK query.

## Sync procedure

Derive the patch-owned files, check what upstream changed in them, dry-run the merge, then
merge and verify. The order is the safeguard: every check runs against the merge tree before
there is anything to undo.

```bash
git fetch upstream

# UPSTREAM_OID is the one value this procedure does not derive. Read the ref once,
# review that commit, then paste the literal: everything below consumes the variable
# and never re-reads the ref, so the commit checked is the commit merged.
#
#     git rev-parse upstream/main     # read it, review that commit, then:
#     UPSTREAM_OID=<the 40-char OID>  # a pasted literal, not a substitution
#
[ -n "${UPSTREAM_OID:-}" ] && [ ${#UPSTREAM_OID} -eq 40 ] || {
  echo "set UPSTREAM_OID to a literal 40-char OID you have reviewed"; exit 1; }
git merge-base --is-ancestor "$UPSTREAM_OID" upstream/main || {
  echo "UPSTREAM_OID is not an ancestor of upstream/main: history was rewritten"; exit 1; }
[ "$UPSTREAM_OID" = "$(git rev-parse upstream/main)" ] || {
  echo "NOTE: upstream/main has moved past UPSTREAM_OID; record which commit you chose and why."; }

BASE=$(git merge-base HEAD "$UPSTREAM_OID")

# Set A: the files the fork changed, which is exactly what the patches own.
git diff --name-only "$BASE" HEAD -- packages/ | sort > /tmp/set-a.txt
# Set B: the subset an upstream diff can touch (fork-only test files cannot).
grep -v '\.slp\.test\.ts$' /tmp/set-a.txt > /tmp/set-b.txt
git diff --name-only "$BASE" "$UPSTREAM_OID" -- $(cat /tmp/set-b.txt)

# Patched files with nothing to grep for, which only the diff above can see:
git grep -l 'SLP-PATCH' HEAD -- packages/ | sed 's|^[^:]*:||' | sort > /tmp/marked.txt
comm -23 /tmp/set-a.txt /tmp/marked.txt
```

Empty output from the diff means upstream changed no patch-owned file. Otherwise read
`git log "$BASE".."$UPSTREAM_OID" -- <file>` for each: a patch may have landed, been
redesigned, or lost its insertion point.

```bash
# Dry run: the whole merge in the object store. On a clean merge this prints the
# tree OID and exits 0; on conflict the lines after the OID name the paths.
out=$(git merge-tree --write-tree --name-only HEAD "$UPSTREAM_OID"); rc=$?
T=$(printf '%s\n' "$out" | head -1)
[ $rc -eq 0 ] || { echo "CONFLICTS:"; printf '%s\n' "$out" | tail -n +2; }

# Marker gate against the merged tree (-h is git grep's --no-filename).
git grep -oh "SLP-PATCH([a-z-]*)" "$T" -- packages/ | sort | uniq -c | sort -rn

# The wakeup-each watcher's shape, read rather than counted.
git cat-file -p "$T:packages/server/src/server/agent/agent-prompt.ts" \
  | grep -nE 'SLP-PATCH\(wakeup-each\)|agent_state|timeline_replacement|event\.event\.type|hasSeenRunning|hasSeenTurn|terminal: false'
```

Read the control flow around the lines the last command prints: the `agent_state` and
`timeline_replacement` variants return before any `event.event.type` read; the idle state
alone sends nothing; `turn_completed` notifies only with the child idle and a running turn
observed, then clears both gates and sends `finished` with `{ terminal: false }`; the
archived-caller branch calls `stop()`.

The marker manifest on this branch, which the gate must reproduce unless a patch changed:

```
16 interrupted-turn-tasks                  2 wakeup-each
 9 interrupted-turn-terminals              2 interrupt-releases-foreground
 7 agent-send-interrupt                    2 force-cancel-releases-foreground
 6 native-tools-injection-independent      2 detached-arg
 4 mcp-protocol-version-clip               2 agent-message-raw-body
 3 replace-awaits-teardown                 1 dispose-releases-foreground
                                           1 detached-wakeup
                                           1 dead-run-settles
```

Then merge and verify:

```bash
git merge "$UPSTREAM_OID"     # the pinned OID, not the ref

# --ignore-scripts keeps a just-merged upstream from running install scripts, but
# the repo's own postinstall applies the dependency patches under patches/, which
# the app typechecks against; run it through npm so node_modules/.bin is on PATH.
npm ci --ignore-scripts
npm run postinstall

# Build before typechecking: with scripts skipped, every cross-package declaration
# is whatever dist held, and a merge that adds a protocol module leaves the server
# importing a file no dist has.
npm run build:server
npm run typecheck             # the whole workspace: the app and desktop break too

# Every test run goes through vt, which refuses a call that names no existing test
# file (vitest reads a stray argument as a filter and runs the whole workspace) and
# gives each run scratch homes, so no run reaches the live ~/.paseo, Claude history,
# tmpfs or local speech models. Never call vitest any other way here.
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

# The fork's own files first: the cheapest signal.
vt packages/server/src/server/agent/agent-prompt.slp.test.ts
vt packages/server/src/server/agent/create-agent/create.slp.test.ts
vt packages/server/src/server/native-tools-gate.slp.test.ts
vt packages/server/src/server/mcp-protocol-version-clip.slp.test.ts
vt packages/server/src/server/agent/agent-message-raw-body.slp.test.ts
vt packages/server/src/server/agent/providers/codex-interrupted-turn-terminals.slp.test.ts
vt packages/server/src/server/agent/providers/claude/agent.interrupted-turn-tasks.slp.test.ts
vt packages/cli/src/commands/agent/send.slp.test.ts
# Upstream's suites for patched files: where a patch contradicting upstream intent shows.
vt packages/server/src/server/agent/agent-prompt.test.ts
vt packages/server/src/server/agent/create-agent/create.test.ts
vt packages/server/src/server/agent/mcp-server.test.ts
vt packages/server/src/server/agent/agent-manager.test.ts
vt packages/server/src/server/agent/provider-registry-wrap.test.ts
vt packages/server/src/server/agent/providers/codex-app-server-agent.test.ts
vt packages/server/src/server/agent/providers/claude/agent.test.ts
vt packages/server/src/server/agent/providers/pi/agent.test.ts
vt packages/server/src/server/agent/providers/acp-agent.test.ts
vt packages/server/src/server/schedule/service.test.ts
vt packages/server/src/server/bootstrap.smoke.test.ts
# The end-to-end suites upstream CI never runs; a timeout at the 5 s default is load.
vt packages/server/src/server/agent/mcp-parity.e2e.test.ts --testTimeout=30000
vt packages/server/src/server/agent/agent-mcp.e2e.test.ts --testTimeout=30000

npm run format:check
npm run lint
git push origin slp/patches
```

When a run fails on an upstream assertion a carried patch deliberately changes, adapt that
assertion in place with a comment naming the patch; never restore upstream's expectation or
delete the case. Update this file in the same commit as any patch change, and delete a
patch's section when it lands upstream.

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
