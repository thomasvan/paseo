# PATCHES

Local patches carried on `slp/patches` (fork `thomasvan/paseo`) on top of upstream
`getpaseo/paseo`. A patch is a change this fork makes to upstream code; git holds how each one
came to be, and this file says what each one does now, why, and how to carry it through a sync.

Every patch site in code is marked `SLP-PATCH(<name>)`, except
`history-purpose-provider-contract`, which carries no marker and is checked by reading its hunk
(see its section). When a hunk conflicts, re-apply the patch's intent onto upstream's current
shape from its section below; do not restore an old diff.

## Current upstream sync

`slp/patches` carries upstream tag `v0.14.0` (`8c6de842a3157530c26a7a94c78a3d647fb96ce9`),
admitted by the release-tag path of the gate: its one non-metadata `+` commit, `f59ebd4fd`,
changes only `.github/workflows/ci.yml`. The merge resolved nine conflict blocks in seven files:

| File                                           | Resolution                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `agent/agent-messages/index.ts`                | upstream's barrel (#7561); `agent-message-raw-body` moved into `envelope.ts`                                             |
| `agent/agent-prompt.ts`                        | upstream's side; #7683 deleted the watcher, and `wakeup-each` moved into `finish-subscriptions/`                         |
| `agent/create-agent/create.ts`                 | upstream's side; #7528 carries `detached-wakeup`                                                                         |
| `providers/codex-app-server-agent.ts`, block 1 | both: the `interrupted-turn-terminals` helpers, `releaseForegroundTurn` and #7782's `canStopRuntime` as separate methods |
| same file, blocks 2 and 3                      | #7954's `async …: Promise<void>` handlers, each first calling `recordTurnTerminalProcess`                                |
| `providers/pi/agent.test.ts`                   | both; the `history-purpose` suite closes before #7782's and #7954's tests                                                |
| `agent/tools/paseo-tools.ts`                   | upstream's `selectAgentListItems`; #7532 filters archives in `AgentDirectory`                                            |
| `skills/paseo/SKILL.md`                        | both: the interrupt default, with upstream's queued receipt and quiet window                                             |

Two patches left with this sync, because upstream carries their fixes: `detached-wakeup`
(#7528) and `archived-live-list` (#7532). Each one's last test that guards upstream behaviour
is under _Where the tests live_. On top of the merge, the sync redesigned `wakeup-each` inside
`finish-subscriptions/`, made `interrupted-turn-terminals` keep an accepted interrupt's record
so a late-started command still ends, and updated `agent-message-raw-body`,
`agent-send-interrupt` and `history-purpose-provider-contract`; the other nine patches, the
five Codex foreground patches among them, carry over unchanged.

## The patches

| Patch                                                                       | What it fixes                                                                                 | Upstream                                                                                                                                                   |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`wakeup-each`](#wakeup-each)                                               | a caller hears every finish of a long-lived child, once each, across restarts                 | issue [#6346](https://github.com/getpaseo/paseo/issues/6346) (fix described there), Discussion [#4669](https://github.com/getpaseo/paseo/discussions/4669) |
| [`detached-arg`](#detached-arg)                                             | the advertised `create_agent` schema can ask for a detached child                             | Discussion [#4670](https://github.com/getpaseo/paseo/discussions/4670)                                                                                     |
| [`mcp-protocol-version-clip`](#mcp-protocol-version-clip)                   | an MCP client newer than the bundled SDK gets past `initialize`                               | PR [#4570](https://github.com/getpaseo/paseo/pull/4570), issue [#3009](https://github.com/getpaseo/paseo/issues/3009)                                      |
| [`native-tools-injection-independent`](#native-tools-injection-independent) | native Paseo tools survive MCP injection being off                                            | Discussion [#4671](https://github.com/getpaseo/paseo/discussions/4671)                                                                                     |
| [The Codex foreground cluster](#the-codex-foreground-cluster)               | a Codex session's foreground slot is released on every path that ends its turn (five patches) | issue [#3256](https://github.com/getpaseo/paseo/issues/3256) (the fixes described there); PR [#4041](https://github.com/getpaseo/paseo/pull/4041) open     |
| [`history-purpose-provider-contract`](#history-purpose-provider-contract)   | a pi history read releases the runtime it spawned                                             | not opened: no raw-log repro yet; upstream left pi out of #5550                                                                                            |
| [`agent-message-raw-body`](#agent-message-raw-body)                         | the receiving model gets an agent sender's bytes, not their XML-escaped form                  | PR [#7523](https://github.com/getpaseo/paseo/pull/7523), issue [#7520](https://github.com/getpaseo/paseo/issues/7520)                                      |
| [`agent-send-interrupt`](#agent-send-interrupt)                             | an agent's send interrupts a running turn unless it asks to steer                             | Discussion [#7526](https://github.com/getpaseo/paseo/discussions/7526)                                                                                     |
| [`interrupted-turn-terminals`](#interrupted-turn-terminals)                 | an interrupted Codex turn's shell commands end                                                | PR [#7525](https://github.com/getpaseo/paseo/pull/7525), issue [#7522](https://github.com/getpaseo/paseo/issues/7522)                                      |
| [`interrupted-turn-tasks`](#interrupted-turn-tasks)                         | an interrupted Claude turn's shell commands end, its background ones included                 | PR [#7524](https://github.com/getpaseo/paseo/pull/7524), issue [#7521](https://github.com/getpaseo/paseo/issues/7521)                                      |

The Codex foreground cluster is five patches: `replace-awaits-teardown`, `dead-run-settles`,
`interrupt-releases-foreground`, `dispose-releases-foreground` and
`force-cancel-releases-foreground`, fourteen patches in all.

## Where the tests live

A patch's tests sit in a fork-only `.slp.test.ts` file where upstream owns the file beside the
code, so the upstream file stays upstream's and never conflicts on merge:
`native-tools-gate.slp.test.ts`, `mcp-protocol-version-clip.slp.test.ts`,
`agent-message-raw-body.slp.test.ts`, `finish-subscriptions/finish-subscriptions.slp.test.ts`,
`finish-subscriptions/internal/observation-stream.slp.test.ts`,
`host-operations/index.slp.test.ts`, `providers/codex-interrupted-turn-terminals.slp.test.ts`,
`providers/claude/agent.interrupted-turn-tasks.slp.test.ts` and, in the CLI package,
`commands/agent/send.slp.test.ts`. The other patches extend upstream's own suites, beside the
cases they change. Every patch test fails under at least one mutant of its patch's lines, and
together they kill every such mutant an earlier, larger set of tests killed. Each fork guard
listed next fails instead under a mutant of the upstream behaviour it guards.

Six fork tests or groups guard upstream behaviour this fork depends on and no upstream test
guards. Each leaves when upstream adds an equivalent:

- `agent-messages/delivery.slp.test.ts`: delivery dispatches adjacent messages whose
  behaviour differs as separate groups, in arrival order, each after the previous group's
  acknowledgement and none waiting for a turn to end. `agent-send-interrupt` relies on it
  (see its _Batching_). The rows pass explicit behaviours, so they never reach the sender
  default; mutants of delivery's grouping and serialization turn them red.
- `schedule/service.test.ts`, `refuses a manual run while a scheduled claim is in flight`:
  the reservation of a schedule before its claim. With the reservation moved after the claim,
  no other test fails.
- `providers/acp-agent.test.ts`, `purpose: history releases the child process after loadSession
replay, and close() afterward is a no-op`: an ACP history read releases its process once.
- `create-agent/create.slp.test.ts`, its two rows: the create path registers its finish
  subscription pending before the first prompt's dispatch, rejects it when that prompt fails
  and accepts it only after dispatch. The rows drive an injected `FinishSubscriptions`;
  they stayed from the retired `detached-wakeup` patch, whose fix upstream carries (#7528).
- `mcp-server.test.ts`, `excludes an archived agent that is also live from list_agents`: an
  archived agent resumed into memory for a history read stays out of a default
  `list_agents`. It stayed from the retired `archived-live-list` patch, whose fix upstream
  carries (#7532: `AgentDirectory` filters again after projection).
- `mcp-parity.e2e.test.ts`, six finish-notification rows whose assertions this fork adapted:
  at `v0.14.0` they fail unpatched, because #7370 added the sending host's `serverId` to a
  notice's source and the assertions predate it. Upstream CI does not run this file, so the
  failure went unnoticed. Each now asserts the test daemon's exact `serverId`, with a comment
  naming this. They guard the create path's registration (detached and parented children), a
  notice on Stop and on Reload, and a notice after `send_agent_prompt`:
  - `create_agent 'detached' (reparent=false) sends 1 finish notification(s)`
  - `create_agent 'subagent' (reparent=false) sends 1 finish notification(s)`
  - `Stop tells the parent that a watched child was canceled`
  - `Reload tells the parent that a watched child was canceled`
  - `a watched child still reports 'finished' after send_agent_prompt`
  - `a watched child still reports 'errored' after send_agent_prompt`

  A seventh test in the file, `list_providers returns providers`, also fails at `v0.14.0`
  unpatched: it times out at 30 s on the room's host. It is upstream's and left as it is.

Three patch files are end-to-end suites. Upstream CI does not run `agent-mcp.e2e.test.ts` or
`mcp-parity.e2e.test.ts` (the server's `test:integration` list names neither), so a sync runs
them by hand; `connected-hosts/hosts.e2e.test.ts` is in that list and carries adapted
assertions, and a sync runs it by hand too. See `Sync procedure`.

## wakeup-each

- **What:** a finish subscription in `agent/finish-subscriptions/` re-arms in place after an
  acknowledged `finished` instead of being removed, behind a gate whose state its stored
  record keeps as `awaitingTurn: true`. Upstream's subscription is one-shot.
  - **The gate** opens on a new turn, whatever started it: a running or initializing
    snapshot, or a `turn_started` that carries a `turnId` (`internal/observation-stream.ts`,
    the top of `observeState`). A local observe opens with a synthetic `turn_started` with no
    `turnId` and the current snapshot, so it opens the gate only on a running child; a remote
    host re-fetches the snapshot per event, so the real event's `turnId` opens it after a fast
    turn. Opening writes the record without the field, once per waiting-to-open change; a
    write that fails stays owed and is retried with the subscription's backoff, and a graceful
    close makes one last attempt, so a restart still reads the turn.
  - **Re-arm** is one serialized, abort-checked `put` of the oldest captured record, with
    `awaitingTurn: true` unless a turn was observed since the delivered terminal, then removal
    of the other captured ids. The abort check stops a superseded watch's late write from
    bringing back a record that `accept` removed. After a re-arm, each queued terminal is
    judged by its own stamp (below), never by a turn that is merely pending, because a repeat
    of the acknowledged turn can still be queued ahead of a later turn's finish.
  - **Recovery** starts the gate waiting only when every record in a caller-child-server group
    awaits, so a fresh registration is not hidden behind an older re-armed record.
  - **Outcomes** (the room's D-Q2): an archived child sends `was closed` and disarms; while the
    gate waits, any other terminal of a child that is not archived is silent and the watch stays
    armed; once open, `finished` and a mid-turn `was closed` are delivered and re-arm, and
    `errored`, `was canceled`, `is unavailable` and the host reasons keep upstream's
    remove-and-stop. Archive state comes from storage through the `childArchived` dependency
    (`bootstrap.ts`), because the live closed payload carries `archivedAt: null`; a remote child
    is archived only when its payload says so.
  - **The buffer** (`internal/observation-buffer.ts`) queues terminals first in, first out, and
    stamps each with whether a turn came between it and the one before, so two finishes inside
    one acknowledgement window both arrive and a repeated terminal is recognised.
  - **`hasPendingForCaller`** skips a watch that awaits a turn and holds no outcome, so a
    re-armed watch does not pin its caller, or through the family walk the caller's parent,
    against idle-runtime cleanup.
- **Why:** a caller that drives one long-lived child across many prompts has to hear every
  finish, exactly once, across restarts. No field of the agent record tells a child stopped
  mid-turn from one stopped idle (a restart rewrites `running` to `closed`, a graceful stop
  stores every agent `closed`, and an agent-sourced prompt never moves `lastUserMessageAt`), so
  the watch writes that mark itself. An unconditional re-arm sends a false notice on every
  reattach to an idle child and pins the caller for good.
- **Accepted gaps:** a crash between a turn's start and the gate-open write leaves the watch
  silent and armed; a turn started by the stop-time message flush, which runs after the watches
  close, is cut off silently; a remote child that runs and finishes while this daemon is down
  is missed; a crash inside the acknowledgement window repeats one notice; an archived caller's
  idle watch lingers until the child's next terminal or the next restart. The shutdown order in
  `bootstrap.ts` (watches close before message delivery) stays upstream's: delivery throws once
  closed, and finish notices go through it.
- **Re-applying:** read `index.ts`'s `run` and the buffer against the shape check under _Sync
  procedure_. A record upstream wrote has no field and delivers its first terminal; a rollback
  to upstream drops the field on load.
- **Upstream after v0.14:** `83ed52669` (#8127) resumes a child that was running at shutdown
  with "Resume working." instead of storing it `closed`. The mid-turn rule and this gate are
  re-read at the sync that carries it.
- **Tests:** `finish-subscriptions.slp.test.ts` drives `createFinishSubscriptions` on the real
  JSON store through the real `openFinishObservation` over a child fake that publishes what
  the local observer does, including the agent-prompted cut-off across a crash and a graceful
  stop, a repeated completion (streamed, or supplied first by the initial wait) queued behind
  the acknowledged finish while a later turn is pending, and a rejected gate-open write
  followed by a mid-turn close and recovery; `internal/observation-stream.slp.test.ts` drives
  the gate signal and the queue on the `Host` fake.
- **Adapted upstream rows:** ten upstream tests expect the one-shot behaviour, and each is
  adapted in place with a comment naming the patch. Eight change only their store assertion,
  to one record with `awaitingTurn: true`, because the outcome they reach now re-arms:
  - `finish-subscriptions.test.ts`, after a `was closed` of a child that is not archived
    (D-Q2's mid-turn rule; the fake's child is stored `closed` with no archive stamp):
    `retains intent until parent dispatch acknowledgment, then restart sends nothing`,
    `restart coalesces predecessor and queued candidate into one settled notification`,
    `dispatch failure retains intent and retries the ordinary finish notification` and
    `remote finish intent protects its caller through registration, observation and delivery`.
    The last keeps its `hasPendingForCaller` and idle-sweep lines unchanged: they are the
    guard that a re-armed watch pins no caller.
  - `mcp-server.test.ts`, after a `finished`: both rows of `reports %s permission requests and
final completion`.
  - `connected-hosts/hosts.e2e.test.ts`, after a remote `finished`: `durable remote finish
intent survives origin restart and unavailable-host recovery` and `remote finish observation
survives a permission checkpoint until resumed completion`. Their restart, availability,
    permission and wait assertions stay as upstream wrote them.

  The ninth, the browser spec `subagent-origin-pane.spec.ts`, `MCP delegates to self and B
and opens both qualified children in ordinary conversations`, prompts each child twice (its
  MCP initial prompt, then a prompt from the UI), so the parent now hears two finishes per
  child: its two `Agent finished` button checks expect two each, and the fleet helper's
  `expectCompletion` (`e2e/support/helpers/subagents.ts`, called only by this test) takes the
  exact count instead of a fixed one. With `rearms` limited to `was closed` (a `finished`
  disarms), the spec fails at `expectCompletion(fleet.local, 2)`: expected 2, received 1.

  The tenth, `failed removal after dispatch acknowledgment retries only storage, preserving
the accepted outcome`, follows a `finished` too, and a re-arm of one record removes nothing,
  so it now recovers a predecessor and a queued candidate as one group: the re-arm keeps the
  older record and removes the other, and that removal is the one that fails.

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
- **Tests:** `native-tools-gate.slp.test.ts` starts a daemon with injection off and reads the
  launch context of a new agent after each change: at start, after injection is turned on and
  off by a config patch, after `mcp.enabled` is turned off and on by a config reload. A unit row
  keeps an absent `mcp.enabled` enabled, and a read of `bootstrap.ts` checks every switch's
  argument, because the plugin provider runtime's catalog switch has no observable here: a
  behaviour-equivalent re-coupling of that switch alone passes every test.
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

## history-purpose-provider-contract

**No marker.** A sync reads the hunk: pi's `streamHistory()` release must survive.

- **What:** a pi session resumed with `{ purpose: "history" }` (`providers/pi/agent.ts`)
  releases its runtime after its first history read, in a `try`/`finally`, so a read that
  completes, throws, is abandoned early, or whose capture prompt rejects before it begins all
  release. Only a completed read is cached and replayed to later calls.
  `requestEntryCapture`'s pending result carries a no-op `catch`: `close()` rejects pending
  extension results, so without it a capture prompt that rejects first leaves a rejection
  nothing awaits.
- **Why:** the pi handle's `nativeHandle` is the session file (`describePersistence`, and
  resume reads it), but the history read goes through the live runtime: the entry capture and
  `get_messages`. Without the release, every archived pi agent whose history is read keeps a
  runtime resident. Upstream's idle-runtime release (`canStopRuntime`, #7782) also collects it
  while `agents.idleRuntimeCleanup` is on; the room runs it off, so there the runtime stays
  for the rest of the daemon's life.
- **Better design:** upstream PR [#4473](https://github.com/getpaseo/paseo/pull/4473) (open)
  reads the JSONL session file directly and returns the whole history with no runtime. That
  is this patch's natural successor.
- **Tests:** `providers/pi/agent.test.ts`, the `resumeSession purpose: history` suite: a
  completed read, an interactive control, an abandoned read, a capture rejection, and a
  `getMessages()` rejection after a successful capture.
- **Retire when:** upstream releases a history-purpose pi runtime itself or reads history
  without one (#4473), or at the first sync where this patch conflicts in `pi/agent.ts` while
  upstream has not taken it. A collision of test blocks at the end of `pi/agent.test.ts` is
  not such a conflict.

## agent-message-raw-body

- **What:** `formatAgentMessage` (`agent-messages/envelope.ts`) writes the body of every
  agent-sent envelope, `agent-message` and every `agent-notification`, as the sender's bytes,
  and marks the envelope `body="raw"`, after every upstream attribute (`event` included).
  Upstream XML-escapes every body, so the model receives `&lt;sha&gt;` and `&amp;&amp;` and can
  run the entity form as a command.
- **The one escape kept:** only the envelope's own tag can end an envelope or open a second
  one. A raw body turns `<` before `paseo-system` or `/paseo-system`, in any letter case, into
  `&lt;`, and adds one `amp;` to an `&lt;` or `&amp;…lt;` already there. The entities match
  only in lower case, the case the escape writes, so any other spelling is never touched. The
  parser reverses exactly that escape, so every body round-trips byte for byte, and it refuses
  a raw body that carries an unescaped envelope tag. That escape is also what lets
  `parseAgentMessages` split a batch at a literal closing tag.
- **What it leaves alone:** an envelope without `body="raw"` decodes as upstream wrote it, and
  the human send path still quotes a pasted envelope as a fully escaped `user-message`. Every
  reader goes through `parseAgentMessage`; batch parsing, plural and heartbeat projection are
  upstream's.
- **Known limit:** a daemon without this patch reads raw history as XML: a body with a raw
  `<`, `>` or bare `&` falls back to a plain user row without its sender. A cross-host send
  carries no envelope: the receiving daemon formats it (`host-operations/index.ts`,
  `agent-messages/delivery.ts`), so a patched sender to an unpatched receiver gets the
  receiver's escaping, and the limit is only about an unpatched parser reading raw history.
- **Upstream assertions adapted:** `connected-hosts/hosts.e2e.test.ts` (the remote report
  arrives as `REMOTE_REPORT <ready>`) and the two exact envelopes in
  `agent-messages/delivery.test.ts`'s batch case, each with a comment naming the patch.
  `agent-manager.test.ts`'s escaped envelope is a deliberate legacy input and stays.
- **Tests:** `agent-message-raw-body.slp.test.ts` drives `formatAgentMessage`,
  `parseAgentMessage` and `prepareAgentMessage` through the `agent-messages/index.ts` barrel,
  the same rows as the upstream PR's `agent-prompt.test.ts`.

## agent-send-interrupt

- **What:** an agent's send into a running turn interrupts it unless it asks for `steer`, on
  the three surfaces where an agent's send is decided. Upstream defaults agent callers to
  `steer` on each:
  - MCP `send_agent_prompt` on an agent-scoped server (`tools/paseo-tools.ts`, the handler
    default and the schema text);
  - `paseo send` with `PASEO_AGENT_ID` set (`cli/src/commands/agent/send.ts`), which always
    sends the field;
  - MCP `send_agent_prompt` with a `serverId` naming another host
    (`host-operations/index.ts`). That call is routed before the local handler, so the
    local default never reaches it.
- **Why:** a steered correction can be ignored by a turn that goes on to finish its original
  task, and the sender never learns.
- **Where the default is decided:** at each sender, because the daemon cannot tell an explicit
  `steer` from a defaulted one.
- **What it leaves alone:** sends the daemon makes itself (a finish notice enqueues as `steer`
  into the caller's running turn), and top-level sends: the app, the Hub, voice, and direct
  RPC sends, including RPC sends that carry `sourceAgentId` (`session.ts`), which keep
  upstream's steer default.
- **Batching:** an agent-scoped send is queued and delivered after two quiet seconds for its
  recipient (`agent-messages/delivery.ts`). Delivery splits adjacent messages whose
  behaviour or session mode differs into ordered groups, each dispatched after the previous
  group's dispatch is acknowledged. So a seat's interrupt that lands in the same window as a
  pending finish notice is dispatched on its own, before or after the notice in arrival
  order, and no longer shares the notice's dispatch. Neither group waits for the recipient's
  turn to end.
- **Known limit:** an upstream `paseo` CLI on a seat's `PATH` still sends an explicit `steer`
  for an agent caller, and the daemon honours it.
- **Tests:** the guards of the sender default are upstream's `send_agent_prompt` dispatch table
  in `mcp-server.test.ts`, whose agent-scoped default row expects an interrupt and whose steer
  cases ask for `steer`; the remote table in `host-operations/index.slp.test.ts` (omitted,
  explicit steer, explicit interrupt, and a human caller as the control); and the CLI's
  `send.slp.test.ts`. The batching account rests on `agent-messages/delivery.slp.test.ts`, a
  fork guard of upstream delivery (see _Where the tests live_). `skills/paseo/SKILL.md`, `public-docs/cli.md`,
  `public-docs/orchestration-workflows.md` and their `zh-CN` copies state the default.

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
  remembered, including accepted interrupts with no commands yet. After acknowledgement,
  the record stays in an interrupt-accepted state: a late root start is terminated at once,
  even when notification conversion held it in the queue. Each process is terminated once,
  and late termination calls join the cleanup the next turn waits for.
- **What it never does:** send `thread/backgroundTerminals/clean`, which ends every terminal on
  the thread. It ends nothing after an already-idle interrupt, nothing on a subagent's thread,
  and nothing after an interrupt of a turn Codex never identified.
- **Bounds:** each terminate times out after 2 s; a failed one is logged
  (`provider.codex.interrupt.terminal_terminate_failed`) and fails nothing. `startTurn` waits
  at most the interrupt's bound plus one terminate's plus 500 ms.
- **Known limit:** archive and reload close the Codex app-server, which ends every terminal of
  the session, an earlier turn's included; that is upstream's behaviour, not this patch's.
- **Retire when:** Codex ends an interrupted turn's commands itself. If `list` gains a turn
  id, match on it instead of the record.
- **Tests:** `codex-interrupted-turn-terminals.slp.test.ts` drives a real session against the
  scripted app-server in `codex/test-utils/fake-app-server.ts`. It covers ownership,
  autonomous next turns, queued and post-acknowledgement starts, completed versus failed
  commands, deduplication, the 16-turn bound and bounded cleanup before the next start.

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
git fetch upstream --tags

# UPSTREAM_OID is the one value this procedure does not derive. Read the target once,
# review that commit, then paste the literal: everything below consumes the variable
# and never re-reads the ref, so the commit checked is the commit merged.
#
#     git rev-parse upstream/main                  # a main commit, or
#     git rev-parse 'refs/tags/v0.14.0^{commit}'   # a release tag; then also
#     UPSTREAM_TAG=refs/tags/v0.14.0
#     UPSTREAM_OID=<the 40-char OID>               # a pasted literal, not a substitution
#
[ -n "${UPSTREAM_OID:-}" ] && [ ${#UPSTREAM_OID} -eq 40 ] || {
  echo "set UPSTREAM_OID to a literal 40-char OID you have reviewed"; exit 1; }

# upstream_gate MAIN_OID UPSTREAM_OID [TAG_REF]: status 0 admits UPSTREAM_OID as a sync
# target; any other status refuses it, with the reason on stdout. TAG_REF is the full
# ref of the release tag, e.g. refs/tags/v0.14.0.
upstream_gate() {
  local main=$1 target=$2 tag=${3:-} base sign oid path
  if git merge-base --is-ancestor "$target" "$main"; then
    echo "ADMIT $target: an ancestor of upstream/main"; return 0
  fi
  [ -n "$tag" ] || { echo "REFUSE $target: not on upstream/main and no tag named"; return 1; }
  [ "$(git rev-parse --verify -q "$tag^{commit}")" = "$target" ] || {
    echo "REFUSE $target: tag $tag does not peel to it"; return 1; }
  base=$(git merge-base "$target" "$main") || { echo "REFUSE $target: no base on upstream/main"; return 1; }
  [ -z "$(git rev-list --merges "$base..$target")" ] || {
    echo "REFUSE $target: $base..$target holds a merge commit"; return 1; }
  while read -r sign oid; do
    [ "$sign" = + ] || continue
    while IFS= read -r -d '' path; do
      case "$path" in
        # Release metadata: literal paths, no wildcards, so adding one takes an edit.
        CHANGELOG.md | CHANGELOG.zh-CN.md | package-lock.json | package.json | plugins/package.json) ;;
        fastlane/metadata/android/en-US/changelogs/140001.txt) ;;
        fastlane/metadata/android/en-US/changelogs/140002.txt) ;;
        fastlane/metadata/android/en-US/changelogs/140003.txt) ;;
        fastlane/metadata/android/en-US/changelogs/140004.txt) ;;
        packages/app/package.json | packages/cli/package.json | packages/client/package.json) ;;
        packages/desktop/package.json | packages/expo-two-way-audio/package.json) ;;
        packages/highlight/package.json | packages/plugin/package.json) ;;
        packages/protocol/package.json | packages/relay/package.json) ;;
        packages/server/package.json | packages/website/package.json) ;;
        # CI workflows: nothing here ships in the daemon build.
        .github/workflows/*) ;;
        *) echo "REFUSE $target: $oid touches $path"; return 1 ;;
      esac
    done < <(git diff-tree --no-commit-id --name-only -z -r "$oid")
  done < <(git cherry "$main" "$target" "$base")
  echo "ADMIT $target: release delta over $base"
}

upstream_gate "$(git rev-parse upstream/main)" "$UPSTREAM_OID" "${UPSTREAM_TAG:-}" || exit 1

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

The gate admits a `main` commit, or a release tag whose own commits are cherry-picks of
`main` or release bookkeeping. Upstream cuts a release tag from `main` plus cherry-picks and
release commits, so a tag is often not an ancestor of `main`. A tag is admitted only when it
peels to `UPSTREAM_OID`, `base..UPSTREAM_OID` holds no merge commit, and every commit
`git cherry` marks `+` (no patch-equivalent on `main`) touches only two path classes: the
release metadata, as literal paths (both changelogs, the four Android changelogs, the root
`package.json` and `package-lock.json`, `plugins/package.json` and each workspace
`package.json`), and anything under `.github/workflows/`, none of which ships in the daemon
build. Otherwise it refuses, naming the commit and path it stopped on. A later `main` that
rewrites a cherry-pick's patch turns that commit `+`, and it is refused unless its paths are
on the list.

The list admits a path, not its content: read each `+` commit's diff before the merge, and
record that read in the fork PR. A release cut changes only `version` and the `@getpaseo/*`
pins; a changelog commit changes only release notes. A new release can add an Android
changelog path; adding it is an edit to the gate, made after that read.

A sync merges its target into the previous sync commit, whether the base was a tag or a `main`
commit, as any merge: cherry-picks are not replayed and no base is recreated. Cherry-equivalence
does not make that merge clean. A tag's release files and backports conflict with `main`'s own
copies (`v0.14.0` against `main` conflicts in both changelogs, `docs/release.md`,
`packages/app/fastlane/Fastfile` and `attachment-lightbox.tsx`, no patch involved). A conflict in
a file outside Set B below is upstream's: take the later target's side.

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

# The wakeup-each gate's shape, read rather than counted.
F=packages/server/src/server/agent/finish-subscriptions
for f in index.ts internal/observation-stream.ts internal/observation-buffer.ts internal/json-store.ts; do
  echo "== $f"
  git cat-file -p "$T:$F/$f" | grep -nE 'SLP-PATCH\(wakeup-each\)|awaitingTurn|turnObserved|turnPending|turn_started|terminals\.|childArchived|watch\.awaiting|serialize\(|signal\.aborted\) return'
done
git cat-file -p "$T:packages/server/src/server/bootstrap.ts" | grep -nE 'childArchived|finishSubscriptions\.close|agentMessages\.close'
```

Read the control flow around the lines that prints: the gate hook sits in `observeState`
before the `turn_started` early return and fires on a running or initializing snapshot or a
`turn_started` with a `turnId`, never on the synthetic open alone; the buffer keeps a queue, not
one slot; the store schema carries `awaitingTurn`; `run` starts the gate waiting only when every
captured record awaits, drops a gated terminal of a child that is not archived, re-arms on
`finished` and a not-archived `was closed` through `serialize` with an abort check first, and
removes on every other outcome; `hasPendingForCaller` skips `watch.awaiting`; `bootstrap.ts`
passes `childArchived` and still closes the finish subscriptions before message delivery.

The marker manifest on this branch, which the gate must reproduce unless a patch changed:

```
46 wakeup-each                             3 replace-awaits-teardown
16 interrupted-turn-tasks                  2 interrupt-releases-foreground
10 interrupted-turn-terminals              2 force-cancel-releases-foreground
 8 agent-send-interrupt                    2 detached-arg
 6 native-tools-injection-independent      1 dispose-releases-foreground
 5 agent-message-raw-body                  1 dead-run-settles
 4 mcp-protocol-version-clip
```

`wakeup-each`'s 46 sites: 39 in `agent/finish-subscriptions/` (its four source files, both
fork test files and the five adapted upstream rows there), one in `bootstrap.ts`, one in
`mcp-server.test.ts` (its adapted row), two in `connected-hosts/hosts.e2e.test.ts` (its
adapted rows) and three in the app's browser e2e (two in `subagent-origin-pane.spec.ts`, one
in `e2e/support/helpers/subagents.ts`).

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
vt packages/server/src/server/agent/create-agent/create.slp.test.ts
vt packages/server/src/server/agent/finish-subscriptions/finish-subscriptions.slp.test.ts
vt packages/server/src/server/agent/finish-subscriptions/internal/observation-stream.slp.test.ts
vt packages/server/src/server/native-tools-gate.slp.test.ts
vt packages/server/src/server/mcp-protocol-version-clip.slp.test.ts
vt packages/server/src/server/agent/agent-message-raw-body.slp.test.ts
vt packages/server/src/server/agent/agent-messages/delivery.slp.test.ts
vt packages/server/src/server/agent/host-operations/index.slp.test.ts
vt packages/server/src/server/agent/providers/codex-interrupted-turn-terminals.slp.test.ts
vt packages/server/src/server/agent/providers/claude/agent.interrupted-turn-tasks.slp.test.ts
vt packages/cli/src/commands/agent/send.slp.test.ts
# Upstream's suites for patched files: where a patch contradicting upstream intent shows.
vt packages/server/src/server/agent/finish-subscriptions/finish-subscriptions.test.ts
vt packages/server/src/server/agent/finish-subscriptions/internal/observation-stream.test.ts
vt packages/server/src/server/agent/finish-subscriptions/internal/json-store.test.ts
vt packages/server/src/server/agent/agent-messages/delivery.test.ts
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
# The end-to-end suites: upstream CI never runs the first two, and the third carries
# adapted assertions. Run them below a one-minute load of 16; a timeout at the 5 s default
# is load.
vt packages/server/src/server/agent/mcp-parity.e2e.test.ts --testTimeout=30000
vt packages/server/src/server/agent/agent-mcp.e2e.test.ts --testTimeout=30000
vt packages/server/src/server/connected-hosts/hosts.e2e.test.ts --testTimeout=30000

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
   `npm run build:server && npm run build:daemon-web-ui`, write the daemon config the new
   build needs (the room's `daemon-config-sync --write`; since v0.14 it carries
   `agents.idleRuntimeCleanup`, which a v0.12 daemon refuses to load, so it is written only
   after the stop), then `paseo-daemon.sh start`.
5. **Read the running version.** `paseo daemon status` and the daemon log's `daemonVersion`
   must name the new release. The preflight in step 3 read HEAD only, so this read is what
   catches a start that served the old build.

The room publishes before the stop, not after it, because the daemon serves whatever
`packages/server/dist` holds at start and loads the room's plugins then: its first start
must find room code that admits it, which a revision bump published after the restart
cannot give.
