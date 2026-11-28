# PATCHES

Local patches carried on `airoom/patches` (fork `thomasvan/paseo`) on top of upstream
`getpaseo/paseo`. A patch is a change this fork makes to upstream code; git holds how each one
came to be, and this file says what each one does now, why, and how to carry it through a sync.

Every patch site in code is marked `AIROOM-PATCH(<name>)`, except two one-line sites of
`force-cancel-releases-foreground`: the optional `releaseForegroundTurn` in `agent-sdk-types.ts`
and its forward in `provider-registry.ts`'s `wrapSessionProvider`, which its section names. Test
rows a patch adds to an upstream suite are named in its section, and fork-only test files open
with `AIROOM-PATCH coverage (<name>)`. When a hunk conflicts, re-apply the patch's intent onto
upstream's current shape from its section below; do not restore an old diff.

## Current upstream sync

`airoom/patches` carries upstream tag `v0.17.3` (commit
`dd7c0499a8c311fae7b3244722a64d73cc178e4a`, tag object `4dd1b201a6da3b75d7908be308d64a7fbb49a1c8`),
merged by its OID. The gate admitted it by the release-tag path after four literal paths joined
the release-metadata list: `fastlane/metadata/android/en-US/changelogs/17003{1,2,3,4}.txt`. The
paths of v0.17.1 and v0.17.2 reached `main` (`6ea095cb4`, `3e4f67d88`), so no line admits them.
The previous sync's pinned target was `v0.15.0` (`8938fde3c713143f12eacbdd60c11fdfc0be0fb1`).
v0.17.3 and v0.15.0 were cut from different release branches: `git merge-base HEAD <target>` was
`82d5f6c580fccf500ed718aa8dad1be03639df7a`, older than v0.15.0, so Set A comes from the previous
target. The merge conflicted in 32 files, 66 blocks:

| File                                                                                                                                                    | Resolution                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| both changelogs, `nix/npm-deps.hash`, `package-lock.json`, the root, `plugins/` and eleven workspace `package.json`                                     | upstream's blob; release bookkeeping of the two branches                                                                                         |
| `scripts/ci-workflow.test.mjs`, `settings-host-page.spec.ts`, `toast-host.tsx`                                                                          | upstream's blob; no patch involved                                                                                                               |
| `providers/codex-app-server-agent.ts`, seven blocks                                                                                                     | #7525's terminal cleanup as upstream wrote it, one copy of its helpers; the foreground cluster re-applied around #9931's pending-start handshake |
| `providers/claude/agent.ts`                                                                                                                             | upstream's `observeNotificationTurn` (#10092), then the task observer, both before the stale-result return                                       |
| `providers/pi/agent.ts`, three blocks                                                                                                                   | upstream's side (#8554, #10496); `history-purpose-provider-contract` retired, its capture observer kept as `pi-capture-rejection-observed`       |
| `cli/.../send.ts`, `host-operations/index.ts`, `tools/paseo-tools.ts`, `mcp-server.test.ts`, `skills/paseo/SKILL.md`, the four `public-docs` send files | upstream's #10483 shape, then `agent-send-interrupt` re-applied in its own commit                                                                |

`.github/workflows/desktop-release.yml` merged cleanly and brought back v0.15.0's cherry-pick of
#8445's signing backport, which #8450 removed upstream. It takes upstream's blob. After this sync
`git diff <target> --` the 20 bookkeeping and CI files and `.github/` is empty. Retired by this sync: `interrupted-turn-terminals`, which upstream's #7525 replaces, and the
release half of `history-purpose-provider-contract`, which #8554 replaces. Its unhandled-rejection
observer stays as `pi-capture-rejection-observed`. The other eleven carry over.

`mcp-protocol-version-clip` left with the v0.15.0 sync. No family needs it: on a stand-in of the agent
MCP route, Claude 2.1.317, Codex 0.166.0 and pi 1.4.0 each initialised, listed tools and
listed the tool with and without the clip (three runs per arm). Claude's first `server/discover`
probe gets a 400 on the stock transport and Claude falls back on its own; Codex and pi ask for
versions the bundled SDK supports. That sync's proof M repeats this on the merged daemon; if it
fails, revert the commit that retired the clip. A later client that sends an unsupported
`mcp-protocol-version` header after `initialize` shows as a seat whose Paseo tools fail to list,
with `Unsupported protocol version` in the daemon log.

`COMPAT(detachedCreate)` in `agent/create-agent/intent.ts` says "remove after 2027-01-17". A
target past that date may delete the legacy path `detached-arg` adapts; read it first.

## The patches

| Patch                                                                       | What it fixes                                                                                 | Upstream                                                                                                                                                   |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`wakeup-each`](#wakeup-each)                                               | a caller hears every finish of a child it owns, once each, across restarts                    | issue [#6346](https://github.com/getpaseo/paseo/issues/6346) (fix described there), Discussion [#4669](https://github.com/getpaseo/paseo/discussions/4669) |
| [`detached-arg`](#detached-arg)                                             | the advertised `create_agent` schema can ask for a detached child                             | Discussion [#4670](https://github.com/getpaseo/paseo/discussions/4670)                                                                                     |
| [`native-tools-injection-independent`](#native-tools-injection-independent) | native Paseo tools survive MCP injection being off                                            | Discussion [#4671](https://github.com/getpaseo/paseo/discussions/4671)                                                                                     |
| [The Codex foreground cluster](#the-codex-foreground-cluster)               | a Codex session's foreground slot is released on every path that ends its turn (five patches) | issue [#3256](https://github.com/getpaseo/paseo/issues/3256) (the fixes described there); PR [#4041](https://github.com/getpaseo/paseo/pull/4041) open     |
| [`pi-capture-rejection-observed`](#pi-capture-rejection-observed)           | a pi capture prompt that fails cannot crash the daemon worker                                 | not opened                                                                                                                                                 |
| [`agent-message-raw-body`](#agent-message-raw-body)                         | the receiving model gets an agent sender's bytes, not their XML-escaped form                  | PR [#7523](https://github.com/getpaseo/paseo/pull/7523), issue [#7520](https://github.com/getpaseo/paseo/issues/7520)                                      |
| [`agent-send-interrupt`](#agent-send-interrupt)                             | an agent's unflagged send interrupts a running turn                                           | Discussion [#7526](https://github.com/getpaseo/paseo/discussions/7526)                                                                                     |
| [`archived-out-of-band-declines`](#archived-out-of-band-declines)           | an urgent agent message to an archived agent unarchives it and starts its turn                | issue [#10598](https://github.com/getpaseo/paseo/issues/10598)                                                                                             |
| [`interrupted-turn-tasks`](#interrupted-turn-tasks)                         | an interrupted Claude turn's shell commands end, its background ones included                 | PR [#7524](https://github.com/getpaseo/paseo/pull/7524), issue [#7521](https://github.com/getpaseo/paseo/issues/7521)                                      |

The Codex foreground cluster is five patches: `replace-awaits-teardown`, `dead-run-settles`,
`interrupt-releases-foreground`, `dispose-releases-foreground` and
`force-cancel-releases-foreground`, thirteen patches in all.

## Where the tests live

A patch's tests sit in a fork-only `.airoom.test.ts` file where upstream owns the file beside the
code, so the upstream file stays upstream's and never conflicts on merge:
`native-tools-gate.airoom.test.ts`,
`agent-message-raw-body.airoom.test.ts`, `finish-subscriptions/finish-subscriptions.airoom.test.ts`,
`finish-subscriptions/internal/observation-stream.airoom.test.ts`,
`host-operations/index.airoom.test.ts`,
`providers/claude/agent.interrupted-turn-tasks.airoom.test.ts` and, in the CLI package,
`commands/agent/send.airoom.test.ts`. The other patches extend upstream's own suites, beside the
cases they change. Every patch test fails under at least one mutant of its patch's lines, and
together they kill every such mutant an earlier, larger set of tests killed. Each fork guard
listed next fails instead under a mutant of the upstream behaviour it guards.

Five fork tests or groups guard upstream behaviour this fork depends on and no upstream test
guards. Each leaves when upstream adds an equivalent. (`agent-messages/delivery.airoom.test.ts`
left with the v0.17.3 sync: #10404 deliberately orders what it asserted apart, a steer or
interrupt carrying the messages queued before it, and upstream's `delivery.test.ts` and
`mcp-server.test.ts` guard the new order.)

- `schedule/service.test.ts`, `refuses a manual run while a scheduled claim is in flight`:
  the reservation of a schedule before its claim. With the reservation moved after the claim,
  no other test fails.
- `providers/acp-agent.test.ts`, `purpose: history releases the child process after loadSession
replay, and close() afterward is a no-op`: an ACP history read releases its process once.
- `create-agent/create.airoom.test.ts`, its two rows: the create path registers its finish
  subscription pending before the first prompt's dispatch, rejects it when that prompt fails
  and accepts it only after dispatch. The rows drive an injected `FinishSubscriptions`;
  they stayed from the retired `detached-wakeup` patch, whose fix upstream carries (#7528).
- `mcp-server.test.ts`, `excludes an archived agent that is also live from list_agents`: an
  archived agent resumed into memory for a history read stays out of a default
  `list_agents`. It stayed from the retired `archived-live-list` patch, whose fix upstream
  carries (#7532: `AgentDirectory` filters again after projection). v0.17 reads stored records
  through `listActive`, so its fixture offers the archived record there.
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

Two patch files are end-to-end suites. Upstream CI does not run `agent-mcp.e2e.test.ts` or
`mcp-parity.e2e.test.ts` (the server's `test:integration` list names neither), so a sync runs
them by hand (`agent-mcp.e2e.test.ts` carries no patch now, but its offline MCP cases guard the
agent MCP route); `connected-hosts/hosts.e2e.test.ts` is in that list and carries adapted
assertions and fork rows, and a sync runs it by hand too. See `Sync procedure`.

## wakeup-each

- **What:** a finish subscription in `agent/finish-subscriptions/` whose child the caller owns
  re-arms in place after an acknowledged `finished` instead of being removed, behind a gate
  whose state its stored record keeps as `awaitingTurn: true`. Every other subscription keeps
  upstream's one-shot, and a send with `notifyOnFinish: false` removes the pair's subscription.
  - **Ownership** is read at each re-arm, in `settle`, from the delivered terminal's labels
    (`owned`, the reading upstream's `suppressed` does for a create subscription): the child's
    parent label names the caller on this server. A send's `accept` supersedes the create
    path's record with one that carries no `requireParentOwnership`, so a flag read at
    registration would turn a Lead's own Worker one-shot after the first follow-up; the label
    covers that record, a local and a remote child alike, and a later detach or reparent. The
    re-arm is the only place a record is written back after a delivery, and every watch,
    recovered ones included, reaches it through `run`, so the check covers a registration path
    no search found. A child the caller created detached on this host carries no parent
    label and is one-shot. Two root seats that prompt each other each hear one finish per send, where an
    unconditional re-arm woke them on each other's every turn.
  - **The cancel** (`cancel`, called by `send_agent_prompt` with `notifyOnFinish: false`, and
    by the routed send with that destination's `serverId`) runs inside `serialize` before the
    prompt is enqueued. It stops every watch of the caller-child-server group, a registration
    still pending dispatch included, whose later `accept` then finds nothing to revive, and
    removes the group's stored records. A registration made after it is untouched. A notice a
    watch already enqueued stays in the caller's queue; the aborted watch writes no re-arm or
    gate write afterwards, because both check the abort inside `serialize`.
    The cancel ends any watch the caller holds on that child, owned or not, a creation watch
    included, so after a notify-off send the caller hears that child's finishes again only after
    its next notify-on send. Because it runs before the enqueue, a notify-off send whose enqueue
    then throws (delivery closing at shutdown, say) has already removed the earlier watch, where
    a create or notify-on send whose dispatch fails keeps its predecessors through `reject()`;
    cancelling at dispatch instead would let the old watch deliver the turn the notify-off send
    itself starts.
  - **The gate** opens on a turn the child runs, whatever started it: a running snapshot, or
    a `turn_started` that carries a `turnId` (`internal/observation-stream.ts`, the top of
    `observeState`). A local observe opens with a synthetic `turn_started` with no `turnId` and
    the current snapshot, so it opens the gate only on a running child; a remote host
    re-fetches the snapshot per event, so the real event's `turnId` opens it after a fast turn.
    An `initializing` snapshot never opens it: a session load publishes one, a history read
    included, and every turn after the load publishes `running` (`AgentManager` sets
    `running` and emits state on a foreground or an autonomous turn start). Opening writes the
    record without the field, once per waiting-to-open change; a write that fails stays owed
    and is retried with the subscription's backoff, and a graceful close makes one last
    attempt, so a restart still reads the turn.
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
    armed; once open, `finished` and a mid-turn `was closed` are delivered and re-arm when the
    child is owned (one-shot otherwise), and
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
  finish, exactly once, across restarts. A caller that only messages a seat it does not own
  asked about one reply, and re-arming that watch let two root seats wake each other on every
  turn until one errored. No field of the agent record tells a child stopped
  mid-turn from one stopped idle (a restart rewrites `running` to `closed`, a graceful stop
  stores every agent `closed`, and an agent-sourced prompt never moves `lastUserMessageAt`), so
  the watch writes that mark itself. An unconditional re-arm sends a false notice on every
  reattach to an idle child and pins the caller for good.
- **Accepted gaps:** a crash between a turn's start and the gate-open write leaves the watch
  silent and armed; a turn started by the stop-time message flush, which runs after the watches
  close, is cut off silently; a remote child that runs and finishes while this daemon is down
  is missed; a crash inside the acknowledgement window repeats one notice; an archived caller's
  idle watch lingers until the child's next terminal or the next restart; a notice enqueued
  before a cancel is still delivered; a record an earlier build of this patch re-armed for a
  child the caller does not own delivers its next turn's terminal once more, then is removed.
  The shutdown order in
  `bootstrap.ts` (watches close before message delivery) stays upstream's: delivery throws once
  closed, and finish notices go through it.
- **Re-applying:** read `index.ts`'s `run` and the buffer against the shape check under _Sync
  procedure_. A record upstream wrote has no field and delivers its first terminal; a rollback
  to upstream drops the field on load.
- **Upstream at v0.15:** `83ed52669` (#8127) resumes a child that was running at shutdown with
  "Resume working." instead of storing it `closed`, and #8619 makes that opt-in
  (`agents.resumeOnStartup`, default off). The patch's code needed no change for either.
  - **Recovery off (the default):** a stop still closes the finish subscriptions before the
    message flush and then the providers; a start repairs `running` records to `closed` and
    sends nothing. The mid-turn rule above is what tells a caller its child was cut off.
  - **Recovery on:** a running, unarchived, unowned child is resumed with a continuation
    prompt. The observer waits for that dispatch (`waitForResume` in
    `internal/observation.ts`, a file the patch does not own, wired in `bootstrap.ts` beside
    `childArchived`), so the caller hears no premature `was closed`. A running snapshot opens
    the gate, and the resumed finish is delivered and re-arms, so the store keeps one record
    with `awaitingTurn: true` where upstream's is empty.
- **Upstream at v0.17:** #9757 makes the observer wait for a queued follow-up's dispatch before
  it reads a terminal, and lets a permission checkpoint through while that follow-up is still
  pending (`run`'s `pending.status !== "permission" || watch.pending`). #10483 enqueues every
  notice as `queue`, so a busy caller hears a finish when its own turn ends, or earlier as the
  rider of a later steer, interrupt or person's prompt. Both stay as upstream wrote them, and
  the patch's code needed no change for either.
- **History loads:** a timeline fetch that loads a stored, acknowledged child leaves its record
  awaiting, so a crash restart afterwards sends nothing. When the gate also opened on
  `initializing`, that load wrote the record open and the next crash restart delivered the
  idle baseline as an empty `finished`.
- **Tests:** `finish-subscriptions.airoom.test.ts` drives `createFinishSubscriptions` on the real
  JSON store through the real `openFinishObservation` over a child fake that publishes what
  the local observer does, including the agent-prompted cut-off across a crash and a graceful
  stop, a history load followed by a crash restart, a stored child loaded to run a prompt, a
  repeated completion (streamed, or supplied first by the initial wait) queued behind the
  acknowledged finish while a later turn is pending, and a rejected gate-open write followed by
  a mid-turn close and recovery, two root seats watching each other (one notice each, however
  many turns follow), a cancel while a notice awaits acknowledgement, and a cancel while a
  re-arm write is in flight;
  `internal/observation-stream.airoom.test.ts` drives the gate signal, an `initializing`
  snapshot included, and the queue on the `Host` fake. `every finish notifies` is the owned
  re-arm: its record carries no `requireParentOwnership`, as a send's does. `mcp-server.test.ts`,
  `send_agent_prompt with notifyOnFinish false`, drives the send tool: after a send with notify
  on, a registration still pending dispatch, and a routed send to another host.
- **Adapted upstream rows:** nine upstream tests expect the one-shot behaviour of a child their
  caller owns, and each is adapted in place with a comment naming the patch. Seven change only
  their store assertion, to one record with `awaitingTurn: true`, because the outcome they reach
  now re-arms:
  - `finish-subscriptions.test.ts`, after a `was closed` of a child that is not archived
    (D-Q2's mid-turn rule; the fake's child is stored `closed` with no archive stamp and labelled
    with the caller as parent): `retains intent until parent dispatch acknowledgment, then
restart sends nothing`, `restart coalesces predecessor and queued candidate into one settled
notification` and `dispatch failure retains intent and retries the ordinary finish
notification`.
  - `connected-hosts/hosts.e2e.test.ts`, after a remote `finished` of a child the caller created
    there: `durable remote finish intent survives origin restart and unavailable-host recovery`
    and `remote finish observation survives a permission checkpoint until resumed completion`.
    Their restart, availability, permission and wait assertions stay as upstream wrote them.
  - `daemon-e2e/daemon-restart-resume.e2e.test.ts`, with recovery on, after a recovered finish:
    `durable finish subscriptions recover a running child after restart (abrupt=false)` and
    `(abrupt=true)`. The store holds one re-armed record with `awaitingTurn: true` after the
    second start and still after the third, where upstream's is empty. The one-notice, no
    premature `was closed`, launch-config and idle-child assertions stay.

  The eighth, the browser spec `subagent-origin-pane.spec.ts`, `MCP delegates to self and B
and opens both qualified children in ordinary conversations`, prompts each child twice (its
  MCP initial prompt, then a prompt from the UI), so the parent now hears two finishes per
  child: its two `Agent finished` button checks expect two each, and the fleet helper's
  `expectCompletion` (`e2e/support/helpers/subagents.ts`, called only by this test) takes the
  exact count instead of a fixed one. With `rearms` limited to `was closed` (a `finished`
  disarms), the spec fails at `expectCompletion(fleet.local, 2)`: expected 2, received 1.

  The ninth, `failed removal after dispatch acknowledgment retries only storage, preserving
the accepted outcome`, follows a `finished` too, and a re-arm of one record removes nothing,
  so it now recovers a predecessor and a queued candidate as one group: the re-arm keeps the
  older record and removes the other, and that removal is the one that fails.

  Rows whose watch the caller does not own are upstream's bytes again: `finish-subscriptions.test.ts`'
  `remote finish intent protects its caller through registration, observation and delivery`
  (its child's label names a parent on the remote host), both rows of `mcp-server.test.ts`'
  `reports %s permission requests and final completion`, and both rows of `hosts.e2e.test.ts`'
  `remote prompt to a closed agent (archived=%s) reports its new turn instead of stale
closure` (each a send to a child with no parent).

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
- **Tests:** `native-tools-gate.airoom.test.ts` starts a daemon with injection off and reads the
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
- **Upstream at v0.17:** #9931 adds a pending-start handshake (`pendingForegroundStart`): an
  `interrupt()` that arrives while `startTurn` is still preparing marks the start cancelled and
  waits for it. The teardown wait tracks `activeForegroundTurnId` only, so a second start that
  overlaps one in flight still refuses, as upstream's does. #7525's interrupted-turn cleanup
  sits in the same `interrupt()`. The merge keeps the fork's split of `interrupt()` into
  `interruptWithoutIdentifiedTurn` and `interruptIdentifiedTurn`, with #7525's sweep inside the
  second.
- **Retire when:** upstream's runtime reconciliation (#4041) replaces the provider runtime
  after a forced settlement; re-evaluate `force-cancel-releases-foreground` and
  `replace-awaits-teardown` first. The other three stay until a focused fix lands.
- **Tests:** in upstream's `codex-app-server-agent.test.ts` and `agent-manager.test.ts`,
  beside the cases they extend, and `provider-registry-wrap.test.ts` for the forward.

## pi-capture-rejection-observed

- **What:** `requestEntryCapture` (`providers/pi/agent.ts`) attaches a no-op `catch` to the
  pending capture result before it sends the capture prompt.
- **Why:** the function starts waiting for the extension result, then awaits
  `runtimeSession.prompt`, and awaits the result only after that. When the prompt rejects,
  nothing awaits the pending result. `close()` rejects it then, and a history read's `finally`
  calls `close()` (#8554), and so does the extension timeout. The daemon worker treats an
  unhandled rejection as fatal: it logs "Unhandled promise rejection — daemon crashing" and
  exits (`daemon-worker.ts`), taking every seat's runtime with it. The `catch` observes the
  rejection, and the `await` that follows still throws when it is reached.
- **History:** the observer was part of `history-purpose-provider-contract`, which released a
  history-purpose pi runtime after its first read. Upstream's #8554 does that release itself
  (`streamHistory`'s `finally`, with `closeAfterHistory`). The v0.17.3 sync retired the release,
  its replay cache and its option plumbing for upstream's, and kept this one site.
- **Tests:** `providers/pi/agent.test.ts`, `a capture prompt that rejects before a history read
leaves no unhandled rejection when the runtime closes`. It drives a history-purpose resume
  whose capture prompt rejects, and asserts that the read rejects, that upstream's `finally`
  closed the runtime once, and that no `unhandledRejection` reached the process.
- **Retire when:** upstream observes the pending capture result, or reads pi history without a
  runtime (PR [#4473](https://github.com/getpaseo/paseo/pull/4473), open).

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
  upstream's. A `change-request-update` envelope (#10148) keeps the full escape and no marker:
  the daemon writes it from a forge, not from an agent sender. Its `source-url` stays an
  XML-escaped attribute.
- **Known limit:** a daemon without this patch reads raw history as XML: a body with a raw
  `<`, `>` or bare `&` falls back to a plain user row without its sender. A cross-host send
  carries no envelope: the receiving daemon formats it (`host-operations/index.ts`,
  `agent-messages/delivery.ts`), so a patched sender to an unpatched receiver gets the
  receiver's escaping, and the limit is only about an unpatched parser reading raw history.
- **Upstream assertions adapted:** `connected-hosts/hosts.e2e.test.ts` (the remote report
  arrives as `REMOTE_REPORT <ready>`) and the two exact envelopes in
  `agent-messages/delivery.test.ts`'s batch case, each with a comment naming the patch.
  `agent-manager.test.ts`'s escaped envelope is a deliberate legacy input and stays.
- **Tests:** `agent-message-raw-body.airoom.test.ts` drives `formatAgentMessage`,
  `parseAgentMessage` and `prepareAgentMessage` through the `agent-messages/index.ts` barrel,
  the same rows as the upstream PR's `agent-prompt.test.ts`, and a row that keeps a
  change-request update fully escaped and round-trips it.

## agent-send-interrupt

- **What:** an agent's send that names no `activeTurnBehavior` interrupts the recipient's running
  turn. Upstream (#10483) gives an agent sender three behaviours, `queue`, `steer` and
  `interrupt`, and defaults an omitted one to `queue`, which waits for the turn to end. The
  patch fills `interrupt` for an omitted value at the three places an agent's send is decided,
  each with nullish fallback, so an explicit value passes through:
  - MCP `send_agent_prompt` on an agent-scoped server (`tools/paseo-tools.ts`): the agent
    enqueue passes `activeTurnBehavior ?? "interrupt"`, and the agent schema's text and the
    tool summary say so;
  - `paseo send` with `PASEO_AGENT_ID` set (`cli/src/commands/agent/send.ts`), which sends
    `interrupt` explicitly; a person's omitted send stays unset;
  - MCP `send_agent_prompt` with a `serverId` naming another host
    (`host-operations/index.ts`), which fills `interrupt` for an identified caller. That call
    is routed before the local handler, so the local default never reaches it.

  An archived recipient gets the same `interrupt`: `archived-out-of-band-declines` makes the
  receiving daemon unarchive it and start its turn.

- **Why:** a correction that waits for the turn to end can arrive after the work it corrects,
  and a steered one can be ignored by a turn that goes on to finish its original task.
- **Where the default is decided:** at each sender. The daemon's own default for an omitted
  agent behaviour (`session.ts`'s `agentSenderBehavior`, delivery's enqueue) stays `queue`.
- **What it leaves alone:** sends the daemon makes itself (finish notices and change-request
  updates enqueue as `queue`); top-level sends (the app, the Hub, voice), which default to
  `interrupt` upstream already; raw RPC sends that carry `sourceAgentId`, which keep the
  daemon's `queue`; and the compatibility mapping that reads an older client's `steer` as
  `queue`. `session.ts`'s message-id fingerprint takes the wire value, so the fork CLI's send
  fingerprints as `interrupt`.
- **What a sender sees:** an unflagged send to a running agent replaces its turn at once, after
  any messages the sender queued before it, in the same prompt. `queue` waits for the turn to
  end; `steer` joins a turn whose provider can take it and otherwise interrupts, and a steer
  the provider has not read is lost if the turn ends first. The receipt reports admission; the
  recipient's later output is what shows it acted.
- **Known limits:** an upstream `paseo` CLI on a seat's `PATH` queues: a v0.17.2 or later CLI
  sends no field, and an older one sends `steer`, which the daemon reads as `queue`. An
  unflagged send to a compacting Claude seat interrupts, and Claude's interrupt cancels the
  compaction; upstream's `steer` would have waited for it.
- **Rollout requirement:** a connected destination daemon must carry
  `archived-out-of-band-declines`. The `serverId` route sends an agent's omitted behaviour as an
  explicit `interrupt`, and a destination without that patch (stock v0.17.3, issue
  [#10598](https://github.com/getpaseo/paseo/issues/10598)) acknowledges an urgent send to an
  archived agent and never starts its turn.
- **Tests:** the agent-scoped rows of upstream's `send_agent_prompt` behaviour matrix in
  `mcp-server.test.ts` (the two omitted rows expect an applied interrupt and a new turn, with
  an explicit `queue` row for waiting); the same file's idle-guidance row and queued-dispatch
  acknowledgement fixture, which ask for `queue`; the remote table in
  `host-operations/index.airoom.test.ts` (omitted, each explicit value, the source identities,
  and a person's omitted send unset); and the CLI's `send.airoom.test.ts` through
  `createCli().parseAsync` (omitted agent send, each explicit value, a person's omitted send
  unset). An omitted send to an archived agent is the omitted row of
  `archived-out-of-band-declines`' tables.
  `daemon-e2e/agent-message-behaviors.test.ts` stays upstream's and checks the scope: a raw
  RPC omission still queues. `skills/paseo/SKILL.md`, `public-docs/cli.md`,
  `public-docs/orchestration-workflows.md`, `public-docs/mcp.md`, their `zh-CN` copies,
  `docs/agent-lifecycle.md` and `docs/glossary.md` state the default.

## archived-out-of-band-declines

- **What:** the agent-message queue offers a message out of band through
  `AgentManager.offerOutOfBand` (`agent-manager.ts`), wired in `websocket-server.ts` and the
  tests' `test-utils/agent-messages.ts`. It returns `false`, before any load or read, unless the
  agent is a live interactive session, and the message goes on to normal dispatch. A live
  interactive agent gets upstream's `tryRunOutOfBand`, which the patch leaves as upstream's.
- **Why:** an urgent agent message (`interrupt` or `steer`) is offered out of band before it
  is dispatched (`agent-messages/delivery.ts` `advance` → `offerOutOfBand`). Upstream's offer
  loads the recipient; an archived one loads as a history session, and
  `ensureInteractiveSessionUnlocked` throws `Agent is archived`. That fails the message before
  `deliver` reaches `sendPreparedPromptToAgent`, the only place that unarchives the recipient.
  The sender already holds a queued receipt, and no turn starts. After the decline, dispatch
  unarchives the agent and starts its turn, as it does upstream for a `queue` message to an idle
  archived agent. `agent-send-interrupt` sends every omitted agent send as `interrupt`, so
  without this patch no unflagged agent send could wake an archived agent.
- **What it leaves alone:** `delivery.ts` and `tryRunOutOfBand` are upstream's. So is
  `startAgentRun`'s own out-of-band check, which every prompt entrypoint reaches after its load:
  a command a declined message carries still runs out of band there, on the agent dispatch just
  loaded. A person's send (the app, the CLI without `PASEO_AGENT_ID`, a top-level MCP call) goes
  through `sendPromptToAgent` and never reaches the queue's offer.
- **What changes for a closed agent that is not archived:** a slash command sent alone ends as
  upstream: run out of band after dispatch loads the agent, no turn. A slash command that
  releases messages still waiting in their quiet window differs. Upstream's offer loads the
  agent and runs the command alone, ahead of them; here the declined command goes with them in
  one prompt, so the provider gets it as text and starts a turn.
- **Known limit, upstream's:** an archive or close that lands while dispatch loads the agent
  still fails the message, for every behaviour. Pi shows it: an archive closes the resumed
  session while its history replay waits for entry capture, and the load throws `Pi session
closed` (`agent-prompt.ts` `sendPreparedPromptToAgent` → `ensureAgentLoaded`). Stock v0.17.3
  fails a `queue` send, which no offer touches, the same way.
- **Retire when:** upstream's out-of-band offer stops failing a message for an archived
  recipient: `tryRunOutOfBand` declines or unarchives it, or `delivery.ts`'s `offerOutOfBand`
  hands such a message to `deliver`. Delete `AgentManager.offerOutOfBand`, point both wirings back at
  `tryRunOutOfBand`, drop the suite mock's line, and keep the tables if upstream's own tests do
  not cover an archived recipient.
- **Tests:** `mcp-server.test.ts`, `an agent-scoped $behavior send to an archived agent unarchives
it and starts its turn` (omitted, `interrupt`, `steer`), on the agent-scoped MCP route, which
  also asserts that only an interactive resume ran; the same file's `an agent's slash command to
a closed agent runs out of band after the agent loads, and starts no turn`, whose outcome
  matches stock v0.17.3's; and `connected-hosts/hosts.e2e.test.ts`, `remote %s agent send to an
archived agent starts its turn` (the same three), on the `serverId` route. Each waits at most
  10 s, then asserts on the outcome, so a lost message fails by assertion, not by the test
  timeout. Upstream's `remote prompt to a closed agent (archived=true)…` row also needs the patch,
  and fails only by its timeout without it. The suite's mocked manager in `mcp-server.test.ts`
  carries `offerOutOfBand`.

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
- **Tests:** `providers/claude/agent.interrupted-turn-tasks.airoom.test.ts` drives a real
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
        # Added for v0.15.0: the Nix package's fixed-output dependency hash (read by nothing in
        # the npm build) and the four Android changelogs of the 0.15.0 cut.
        nix/npm-deps.hash) ;;
        fastlane/metadata/android/en-US/changelogs/150001.txt) ;;
        fastlane/metadata/android/en-US/changelogs/150002.txt) ;;
        fastlane/metadata/android/en-US/changelogs/150003.txt) ;;
        fastlane/metadata/android/en-US/changelogs/150004.txt) ;;
        # Added for v0.17.3: the four Android changelogs of the 0.17.3 cut. v0.17.1's and
        # v0.17.2's reached main, so their commits are patch-equivalent there.
        fastlane/metadata/android/en-US/changelogs/170031.txt) ;;
        fastlane/metadata/android/en-US/changelogs/170032.txt) ;;
        fastlane/metadata/android/en-US/changelogs/170033.txt) ;;
        fastlane/metadata/android/en-US/changelogs/170034.txt) ;;
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

# PREVIOUS_TARGET is the pinned target of the previous sync, named under "Current upstream
# sync" (v0.17.3 for the next one). Set A diffs from it, not from BASE: a tag cut from another
# release branch than the last target makes BASE older than that target, and the diff then
# carries the previous release branch's own commits, files no patch owns.
PREVIOUS_TARGET=dd7c0499a8c311fae7b3244722a64d73cc178e4a

# Set A: the files the fork changed, which is exactly what the patches own.
git diff --name-only "$PREVIOUS_TARGET" HEAD -- packages/ | sort > /tmp/set-a.txt
# Set B: the subset an upstream diff can touch (fork-only test files cannot).
grep -v '\.airoom\.test\.ts$' /tmp/set-a.txt > /tmp/set-b.txt
git diff --name-only "$BASE" "$UPSTREAM_OID" -- $(cat /tmp/set-b.txt)

# Patched files with nothing to grep for, which only the diff above can see:
git grep -l 'AIROOM-PATCH' HEAD -- packages/ | sed 's|^[^:]*:||' | sort > /tmp/marked.txt
comm -23 /tmp/set-a.txt /tmp/marked.txt
```

The gate admits a `main` commit, or a release tag whose own commits are cherry-picks of
`main` or release bookkeeping. Upstream cuts a release tag from `main` plus cherry-picks and
release commits, so a tag is often not an ancestor of `main`. A tag is admitted only when it
peels to `UPSTREAM_OID`, `base..UPSTREAM_OID` holds no merge commit, and every commit
`git cherry` marks `+` (no patch-equivalent on `main`) touches only two path classes: the
release metadata, as literal paths (both changelogs, the Android changelogs of v0.14.0,
v0.15.0 and v0.17.3, `nix/npm-deps.hash`, the root `package.json` and `package-lock.json`,
`plugins/package.json` and each workspace `package.json`), and anything under `.github/workflows/`, none of which ships in the daemon
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
git grep -oh "AIROOM-PATCH([a-z-]*)" "$T" -- packages/ | sort | uniq -c | sort -rn

# The wakeup-each gate's shape, read rather than counted.
F=packages/server/src/server/agent/finish-subscriptions
for f in index.ts internal/observation-stream.ts internal/observation-buffer.ts internal/json-store.ts; do
  echo "== $f"
  git cat-file -p "$T:$F/$f" | grep -nE 'AIROOM-PATCH\(wakeup-each\)|awaitingTurn|turnObserved|turnPending|turn_started|terminals\.|childArchived|watch\.awaiting|serialize\(|signal\.aborted\) return|owned\(|cancel'
done
git cat-file -p "$T:packages/server/src/server/bootstrap.ts" | grep -nE 'childArchived|finishSubscriptions\.close|agentMessages\.close'
```

Read the control flow around the lines that prints: the gate hook sits in `observeState`
before the `turn_started` early return and fires on a running snapshot or a `turn_started` with
a `turnId`, never on an `initializing` snapshot or the synthetic open alone; the buffer keeps a
queue, not one slot; the store schema carries `awaitingTurn`; `run` starts the gate waiting only when every
captured record awaits, drops a gated terminal of a child that is not archived, re-arms on
`finished` and a not-archived `was closed` of an `owned` child through `serialize` with an abort
check first, and removes on every other outcome; `cancel` runs inside `serialize` and
`send_agent_prompt` calls it, local and routed, for `notifyOnFinish: false`; `hasPendingForCaller` skips `watch.awaiting`; `bootstrap.ts`
passes `childArchived` and still closes the finish subscriptions before message delivery.

The marker manifest on this branch, which the gate must reproduce unless a patch changed:

```
52 wakeup-each                             7 archived-out-of-band-declines
16 interrupted-turn-tasks                  2 pi-capture-rejection-observed
 7 agent-send-interrupt                    2 interrupt-releases-foreground
 6 native-tools-injection-independent      2 force-cancel-releases-foreground
 5 agent-message-raw-body                  2 detached-arg
 3 replace-awaits-teardown                 1 dispose-releases-foreground
                                           1 dead-run-settles
```

106 sites under 13 names. `agent-send-interrupt`'s seven: the CLI sender, the remote sender, the
agent schema and the agent enqueue in `paseo-tools.ts`, and three in `mcp-server.test.ts` (the
behaviour matrix, the idle-guidance row, the queued-dispatch acknowledgement fixture).
`archived-out-of-band-declines`' seven: `offerOutOfBand` in `agent-manager.ts`, its wiring in
`websocket-server.ts` and `test-utils/agent-messages.ts`, its table, its slash-command row and the
suite mock's line in `mcp-server.test.ts`, and its table in `connected-hosts/hosts.e2e.test.ts`.
`pi-capture-rejection-observed`'s two: the `catch` in `pi/agent.ts` and its row in
`pi/agent.test.ts`.

`wakeup-each`'s 52 sites: 41 in `agent/finish-subscriptions/` (its four source files, both
fork test files and the four adapted upstream rows there), two in `tools/paseo-tools.ts` (the
local and the routed cancel), one in `bootstrap.ts`, one in `mcp-server.test.ts` (its
`notifyOnFinish false` group), two in `connected-hosts/hosts.e2e.test.ts` (its adapted rows), two in `daemon-e2e/daemon-restart-resume.e2e.test.ts` (the second- and
third-start assertions of its adapted rows) and three in the app's browser e2e (two in `subagent-origin-pane.spec.ts`, one
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

# Server files run from packages/server, under the server's own vitest config (globals,
# its setup env, a 30 s test timeout), as its npm test scripts do: run from the root,
# agent-manager.test.ts does not load (`describe is not defined`).
cd packages/server
# The fork's own files first: the cheapest signal.
vt src/server/agent/create-agent/create.airoom.test.ts
vt src/server/agent/finish-subscriptions/finish-subscriptions.airoom.test.ts
vt src/server/agent/finish-subscriptions/internal/observation-stream.airoom.test.ts
vt src/server/native-tools-gate.airoom.test.ts
vt src/server/agent/agent-message-raw-body.airoom.test.ts
vt src/server/agent/host-operations/index.airoom.test.ts
vt src/server/agent/providers/claude/agent.interrupted-turn-tasks.airoom.test.ts
# Upstream's suites for patched files: where a patch contradicting upstream intent shows.
vt src/server/agent/finish-subscriptions/finish-subscriptions.test.ts
vt src/server/agent/finish-subscriptions/internal/observation-stream.test.ts
vt src/server/agent/finish-subscriptions/internal/json-store.test.ts
vt src/server/agent/agent-messages/delivery.test.ts
vt src/server/agent/create-agent/create.test.ts
vt src/server/agent/mcp-server.test.ts
vt src/server/agent/agent-manager.test.ts
vt src/server/agent/provider-registry-wrap.test.ts
vt src/server/agent/providers/codex-app-server-agent.test.ts
vt src/server/agent/providers/codex-interrupted-turn-terminals.test.ts
vt src/server/agent/providers/claude/agent.test.ts
vt src/server/agent/providers/pi/agent.test.ts
vt src/server/agent/providers/acp-agent.test.ts
vt src/server/schedule/service.test.ts
vt src/server/bootstrap.smoke.test.ts
# The scope of agent-send-interrupt: upstream's raw-RPC, CLI, client and protocol guards.
vt src/server/daemon-e2e/agent-message-behaviors.test.ts
# The end-to-end suites: upstream CI never runs the first two, and the third and fourth carry
# adapted assertions. Run them below a one-minute load of 16; a timeout at the 5 s default
# is load.
vt src/server/agent/mcp-parity.e2e.test.ts --testTimeout=30000
vt src/server/agent/agent-mcp.e2e.test.ts --testTimeout=30000
vt src/server/connected-hosts/hosts.e2e.test.ts --testTimeout=30000
vt src/server/daemon-e2e/daemon-restart-resume.e2e.test.ts --testTimeout=30000
cd ../..
# The CLI, client and protocol packages have no vitest config of their own: from the root.
vt packages/cli/src/commands/agent/send.airoom.test.ts
vt packages/cli/src/commands/agent/send.test.ts
vt packages/cli/src/cli-surface.test.ts
vt packages/client/src/daemon-client.test.ts
vt packages/protocol/src/messages.active-turn-behavior.test.ts

npm run format:check
npm run lint
git push origin airoom/patches
```

When a run fails on an upstream assertion a carried patch deliberately changes, adapt that
assertion in place with a comment naming the patch; never restore upstream's expectation or
delete the case. Update this file in the same commit as any patch change, and delete a
patch's section when it lands upstream.

### After the push

A sync reaches no seat until the room activates it. The room repository (`~/Sites/AI/airoom`)
owns each step, and its `runtime/paseo/README.md` holds the commands; this list gives the
order, which is the safeguard:

1. **Land the sync** by fast-forwarding `airoom/patches` to the reviewed head.
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
