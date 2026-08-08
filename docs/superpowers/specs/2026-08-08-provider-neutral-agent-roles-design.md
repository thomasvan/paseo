# Provider-Neutral Agent Roles — Hybrid Bridge

**Status:** Draft for review — Hybrid direction approved

**Date:** 2026-08-08

## Summary

Paseo will enforce three closed foundation roles: `supervisor`, `lead`, and
`peer`. Phase 1 keeps the existing `codex-room` runtime and adds a matching
`claude-room` runtime. Six role-mapped provider profiles select the provider and
foundation role together while the bridge is active.

The boundary is deliberate:

- Room wrappers own provider launch configuration and deliver one shared role
  prompt to Codex or Claude.
- Paseo owns role identity, immutable policy snapshots, staffing authorization,
  limits, lifecycle, audit events, and caller-scoped Paseo tool enforcement.
- Provider/model/mode/thinking selection remains Paseo's normalized runtime
  vocabulary and is validated by the selected provider adapter.

The bridge avoids a new native role selector and provider-adapter prompt changes
in Phase 1. It does not weaken enforcement. A wrapper-only implementation is out
of scope because prompts and provider settings cannot enforce staffing topology,
limits, archive behavior, or direct daemon calls.

Phase 2 may move prompt delivery into native provider adapters and add separate
role selectors across every creation surface. The role domain and enforcement
modules from Phase 1 remain authoritative.

## Goals

- Give Codex and Claude the same `supervisor`, `lead`, and `peer` role prose.
- Keep `codex-room` and add `claude-room` as the Phase 1 provider bridge.
- Require every role-managed provider profile to resolve one foundation role.
- Preserve exact role prompt and capability bytes across restart and resume.
- Enforce `Human > Supervisor > Lead > Peer` for agent-initiated staffing.
- Allow Human creation and explicit override at every tier.
- Enforce one unarchived Lead per project workspace and four unarchived Peers per
  Lead for agent-initiated staffing.
- Keep Supervisor-to-Lead staffing durable and Lead-to-Peer delegation
  cascading.
- Prevent provider configuration, prompt text, stale catalogs, or direct daemon
  calls from bypassing the role policy.
- Preserve backward-compatible wire schemas and legacy agent resume.

## Non-goals

- Do not add a fourth foundation role. Challenger, owner, reviewer, and similar
  names are assignments.
- Do not add a native role picker or `roleId` to every creation request in Phase
  1. The selected provider profile supplies the role.
- Do not remove `codex-room` or the new `claude-room` until native Phase 2 reaches
  parity.
- Do not infer a role from an arbitrary provider id, label, prompt, title, or
  model name.
- Do not mutate an existing conversation's foundation role or prompt snapshot.
- Do not silently substitute a retired model, mode, or thinking option.
- Do not add user-defined roles in v1.
- Do not make `WORKSPACE_PROTOCOL.md` ownership part of the role feature.
- Do not restart the production daemon on port `6767` during development or
  verification without explicit permission.

## Terminology

### Foundation role

The authority and capability class for an agent:

```ts
type FoundationRole = "supervisor" | "lead" | "peer";
```

The set is closed. A task-specific disposition such as `Design challenger A` or
`Implementation owner` never creates a fourth role.

### Assignment

The work an agent was created to perform. Paseo already stores this through the
agent title, initial prompt, and conversation timeline. Phase 1 adds no mutable
`assignment` field to the role contract.

- A Peer is minted for one bounded assignment. Material reassignment creates a
  new Peer.
- A durable Lead may receive follow-up directives inside the same project.
  Moving it to a different project creates a new Lead.
- The display title may be renamed. A rename does not change authority.

The UI calls the task-specific column **Assignment**, not **Role**.

### Role definition

The built-in label, capability policy, and policy version for one foundation
role. The Paseo daemon owns these definitions. The Phase 1 role prompt source is
the corresponding shared room file:

```text
SLP-docs/runtime/roles/<role>.role.md
```

Both wrappers receive the same prompt snapshot. Phase 2 may move the prompt
source into the daemon registry without changing stored contracts.

### Role binding

The immutable role and policy snapshot for one conversation:

```ts
interface RoleBinding {
  roleId: FoundationRole;
  label: "Supervisor" | "Lead" | "Peer";
  policyVersion: number;
  instructions: string;
  capabilityPolicy: CapabilityPolicy;
  instructionsDigest: string;
  digest: string;
}
```

`digest` covers the role id, label, policy version, exact instruction bytes,
capability policy, and digest algorithm version using stable serialization.

### Runtime selection

The staffer explicitly selects the provider profile, model, mode, and supported
thinking option when creating an agent. Paseo already persists these values in
the agent record and maps `modeId` and `thinkingOptionId` through the selected
provider manifest. Phase 1 reuses those fields; it does not add a duplicate
`RuntimeBinding`, a runtime revision log, or a Codex/Claude tagged union.

Existing Human controls may revise a running agent's model, mode, or thinking
option when the provider supports it. Agents cannot change their own or another
agent's runtime. The latest accepted persisted values are authoritative on
resume.

### Stored role contract

The persisted agent record carries the immutable `RoleBinding` next to Paseo's
existing provider and session configuration. Assignment and staffing
relationships are not part of the role contract.

The storage write completes before the provider starts. Existing records keep
both objects optional so legacy agents continue to parse.

## Human authority and staffing graph

The graph constrains agent-initiated staffing only:

```text
Human      -> Supervisor | Lead | Peer
Supervisor -> Lead
Lead       -> Peer
Peer       -> none
```

Human may create, resume, replace, archive, or explicitly revise the runtime of
an agent at any tier. Human override does not mutate the role or prompt contract
of an existing conversation. A different role or role prompt requires a new
agent.

Agent-initiated creation must state a complete runtime selection. Nothing is
inherited from the staffer, including same-provider creation. Fields unsupported
by the chosen model are absent by definition rather than guessed.

## Staffing limits

Limits are live operational policy, not immutable role capabilities:

- A project workspace has at most one unarchived Lead.
- A Lead has at most four unarchived Peer children.
- `initializing`, `idle`, `running`, `error`, and `closed` unarchived agents all
  occupy a slot.
- Archive releases the slot. Finishing a turn or closing a provider process does
  not.
- Human can explicitly override a limit. The override is audited with the Human
  actor, target role, workspace, current count, and configured limit.

The limits are daemon configuration so operators can change them without
rewriting stored role contracts. An agent cannot override them.

## Role capabilities

Capabilities are semantic action groups. The daemon authorizes Paseo actions;
the room wrapper and provider adapter apply the corresponding provider-native
restrictions.

| Capability                                |    Supervisor |                Lead |                  Peer |
| ----------------------------------------- | ------------: | ------------------: | --------------------: |
| Read agent/workspace status and timelines |         Allow |    Allow in project |              Own task |
| Mutate project workspace                  |          Deny |               Allow | Allow in bounded task |
| Create Paseo agents                       |     Lead only |           Peer only |                  Deny |
| Prompt or inspect another agent           | Staffed Leads |           Own Peers |                  Deny |
| Archive managed agents/workspaces         | Staffed Leads | Own Peers/worktrees |                  Deny |
| Respond to another agent's permissions    | Staffed Leads |           Own Peers |                  Deny |
| Change role or another agent's runtime    |          Deny |                Deny |                  Deny |
| Use provider-native subagents/teams       |          Deny |                Deny |                  Deny |

`Peer cannot create agents` means managed Paseo agents. Provider-native Task,
Agent, team, or equivalent tools are a separate capability and are denied for
all three roles in Phase 1.

Unknown provider-native tools that can mutate state, create agents, or message
teams fail closed until classified.

## Provider profiles

Phase 1 exposes six role-mapped profiles:

| Profile id          | Base provider | Foundation role | Label                 |
| ------------------- | ------------- | --------------- | --------------------- |
| `codex-supervisor`  | Codex         | Supervisor      | `Supervisor · Codex`  |
| `claude-supervisor` | Claude        | Supervisor      | `Supervisor · Claude` |
| `codex-lead`        | Codex         | Lead            | `Lead · Codex`        |
| `claude-lead`       | Claude        | Lead            | `Lead · Claude`       |
| `codex-peer`        | Codex         | Peer            | `Peer · Codex`        |
| `claude-peer`       | Claude        | Peer            | `Peer · Claude`       |

Custom provider configuration gains an optional `foundationRole`. It remains
optional for general custom providers. A daemon with required role enforcement
rejects creation through a profile that does not supply it.

Daemon configuration supplies exactly one canonical prompt source for each
foundation role, independent of provider profiles:

```ts
interface FoundationRoleSourceConfig {
  promptFile: string;
}

type FoundationRoleSources = Record<FoundationRole, FoundationRoleSourceConfig>;
```

Required-role startup fails when a role source is missing, empty, or unreadable.
Codex and Claude profiles mapped to the same role can therefore never select
different prompt sources.

The profile id or label is never parsed to infer a role. Provider configuration
resolves the role only for a new agent. Resume uses the stored binding even if
the profile's label or `foundationRole` mapping later changes; configuration
drift never rewrites an existing role.

The target deployment disables or hides the unmapped built-in Codex and Claude
profiles while required enforcement is active. Human role selection therefore
happens by choosing one of the six mapped profiles during the bridge.

## Role resolution and prompt materialization

For a new role-managed agent, the daemon:

1. Loads the selected profile's explicit `foundationRole`.
2. Validates the full provider/model/mode/thinking selection.
3. Loads the role's canonical prompt source once and rejects missing or empty
   content.
4. Resolves the built-in capability policy.
5. Builds and digests the immutable `RoleBinding`.
6. Persists the role binding atomically with Paseo's existing agent
   configuration.
7. Materializes the persisted instruction bytes to a per-agent read-only prompt
   file.
8. Passes its path as `PASEO_ROLE_PROMPT_FILE` and the stored role as
   `PASEO_FOUNDATION_ROLE` in the provider launch environment.
9. Starts the provider wrapper.

The materialized file is an adapter bridge, not the source of truth. Resume
re-materializes it from the persisted binding and never re-reads the current
role source.

If storage or materialization fails, launch fails before the provider starts. A
missing or corrupt persisted binding is never repaired from the current prompt
file.

Secrets, provider credentials, assignment content, and workspace files stay out
of the role binding.

## Minimum Paseo core delta

Phase 1 limits core changes to enforcement Paseo cannot delegate safely to a
wrapper:

1. Optional role-source and provider-profile configuration.
2. Optional persisted `RoleBinding` and `staffedByAgentId` fields.
3. Caller-scoped tool authorization, staffing graph, one-Lead/four-Peer limits,
   and role-derived archive behavior.
4. Optional role/staffing snapshot fields, one feature gate, and the minimum UI
   surfaces needed to distinguish Staffed Leads from Peer subagents.

Phase 1 does not change Codex or Claude adapter prompt composition, add a native
role picker, add provider-specific runtime schema, add assignment storage, or
replace Paseo's existing provider/model/mode/thinking persistence. These
omissions are the scope reduction enabled by `codex-room` and `claude-room`.

## Room wrapper architecture

### Shared room source

`SLP-docs/runtime/roomlib.py` will own shared role loading, seat specifications,
seat table generation, catalog validation, and wrapper snapshot helpers.

Role prose moves from provider overlays into
`SLP-docs/runtime/roles/<role>.role.md`. Both providers use the daemon-materialized
`PASEO_ROLE_PROMPT_FILE` when launched by Paseo. A direct terminal launch without
`PASEO_AGENT_ID` may use the current shared role source but must warn that it has
no persisted Paseo role contract.

Seat tables contain the complete runtime selection for every staffable seat.
Supervisor gets Lead rows, Lead gets Peer rows, and Peer gets none. Mixed rooms
are normal.

### Codex room

Keep `codex-room` and `codex-room-sync`:

- Continue isolated `CODEX_HOME` generation and native multi-agent catalog
  stripping.
- Read the shared role prompt rather than embedded duplicate prose.
- When Paseo supplies `PASEO_ROLE_PROMPT_FILE`, inject those exact bytes into
  Codex developer instructions.
- Retain positional role input for direct terminal compatibility. The persisted
  Paseo role wins when both are present, and a mismatch fails launch.
- Keep role-scoped caller MCP wiring for Supervisor and Lead; Peer gets no Paseo
  server. The daemon still filters and authorizes every call.

### Claude room

Add `claude-room` and `claude-room-sync`:

- `claude-room` forwards every argument received from the Claude Agent SDK and
  appends `--append-system-prompt-file "$PASEO_ROLE_PROMPT_FILE"`.
- Use append, not replacement, so Claude Code keeps its default identity, tool
  guidance, safety instructions, and coding conventions.
- Load the generated role settings with `--settings`; do not require a separate
  `CLAUDE_CONFIG_DIR` for Paseo launches. This preserves normal Claude auth and
  user configuration.
- Apply an explicit per-role tool allowlist and permission settings. Supervisor
  is read-only; Lead and Peer may mutate their bounded workspace; native agent
  and team tools are absent for all roles.
- Model, mode, and thinking stay Paseo runtime selections. The wrapper does not
  invent or silently replace them.

The Claude adapter currently accepts a custom executable but discards additional
configured command arguments before assigning `pathToClaudeCodeExecutable`.
Claude profiles must therefore set a single wrapper executable. The daemon
passes the stored role through `PASEO_FOUNDATION_ROLE`; profiles must not depend
on `command: ["claude-room", "lead"]`.

Direct terminal use may accept `claude-room <role>` when the Paseo role
environment is absent.

### Claude prompt precedence gate

Claude's Agent SDK also supplies the `claude_code` preset with an append string.
Implementation must verify the combined path rather than assume CLI precedence:

- Capture wrapper argv without invoking a model.
- Verify the installed Claude CLI accepts the append-file and settings flags
  before and after SDK arguments.
- Verify the wrapper's settings remain effective when the SDK also supplies
  settings-related arguments.
- Run create and resume smokes through Paseo.
- Assert one unique role marker appears exactly once in effective behavior.
- Assert the Claude Code default prompt remains active.
- Assert one denied native subagent tool and one role-specific filesystem denial
  are enforced.

If SDK arguments override the role prompt or settings, implementation stops and
the adapter boundary must be redesigned before continuing. `CLAUDE.md` is not a
fallback because it is conversation context rather than the system prompt and
cannot provide the required authorization boundary.

## Tool authorization

Authorization is fail-closed and has two daemon gates:

1. Build a caller-scoped Paseo tool catalog that omits unauthorized semantic
   actions for the persisted role.
2. Authorize every invocation again against the persisted role binding,
   staffing relationship, target role, workspace, and live staffing limits.

The second gate protects resumed sessions, stale catalogs, handcrafted HTTP
calls, and provider configurations that expose too many tools.

A denied call emits an audit event containing agent id, role id, target id,
semantic capability, tool name, and denial reason. It must not record secret tool
arguments.

## Staffing lifecycle

Relationship and lifecycle enums are not persisted. Behavior derives from the
role pair.

### Supervisor to Lead

A Supervisor-created Lead is a durable staffed agent:

- Persist `staffedByAgentId`; do not stamp `paseo.parent-agent-id`.
- Show it in a **Staffed Leads** section, not the subagents track.
- Subscribe the Supervisor to Lead finish, error, closed, and permission events
  using staffing ownership rather than parent ownership.
- Archiving the Supervisor stops the active subscription but does not archive or
  close the Lead.
- The archived Supervisor reference remains valid provenance because archive is
  a soft delete. An active Lead whose staffer is archived displays **Needs
  Supervisor**.
- Human may explicitly assign the Lead to a replacement Supervisor. Reassignment
  updates `staffedByAgentId`, rebinds notifications, and writes an audit event.

One Supervisor may staff Leads in multiple projects, subject to one unarchived
Lead per project workspace.

### Lead to Peer

A Lead-created Peer uses Paseo's existing managed subagent relationship:

- Stamp `paseo.parent-agent-id` with the Lead id.
- Show it in the Lead's subagents track.
- Cascade archive when the Lead is explicitly archived.
- Do not cascade on idle, provider process exit, `closed`, daemon restart, or a
  completed turn.
- Do not auto-archive at the first terminal turn. The Lead reviews, accepts,
  merges, archives the Peer and worktree workspace, then deletes the merged
  branch.

Writing Peers use isolated worktrees through the existing
`create_workspace -> create_agent(workspaceId)` flow. Read-only Peers use the
project checkout and no worktree.

## Runtime validation and resume

Every Human or agent creation states the complete runtime selection. UI defaults
may preselect values, but the request carries the resolved provider profile,
model, mode, and supported thinking option explicitly.

Resume performs this sequence:

```text
load agent record
  -> verify RoleBinding digest
  -> load existing persisted provider/model/mode/thinking values
  -> validate runtime against the live provider catalog
  -> materialize persisted role prompt bytes
  -> compile persisted capability policy
  -> launch wrapper and resume provider session
```

If the model, mode, or thinking option is unavailable, return
`RUNTIME_UNAVAILABLE`. Paseo never substitutes another value. Human recovery is
an explicit change through Paseo's existing runtime controls when the provider
can resume with it, or a replacement agent when it cannot.

Provider-side downgrades that can be observed must surface as
`RUNTIME_DEGRADED`; they never rewrite persisted values silently. A downgrade
that would weaken role enforcement fails closed.

## Protocol and compatibility

Phase 1 minimizes new wire surface but keeps normal Paseo compatibility rules:

- New provider-profile, persisted-agent, and agent-snapshot fields are optional.
- Advertise `server_info.features.agentRolesV1` once.
- Gate role-specific UI once on that feature.
- Old clients continue to parse provider and agent snapshots.
- New clients connected to an old daemon do not show role enforcement state.
- A required-role daemon rejects unmapped provider creation with a stable error
  and update/configuration guidance.
- Every compatibility shim carries a dated `COMPAT(agentRolesV1)` tag.
- Do not simulate the feature through legacy RPC fallbacks.

Phase 2 may add an optional `roleId` creation field and a separate role picker.
That later field must remain structurally optional on the wire.

## UI

Phase 1 uses role-first custom provider labels:

- `Supervisor · Codex`, `Supervisor · Claude`
- `Lead · Codex`, `Lead · Claude`
- `Peer · Codex`, `Peer · Claude`

Do not use `Codex Supervisor`, `Codex Lead`, `Codex Peer`, or Claude-prefixed
equivalents.

Agent and staffing views display these concepts separately where data is
available:

- **Foundation role:** Supervisor, Lead, or Peer.
- **Assignment:** current agent title.
- **Runtime:** provider, model, mode, and thinking/effort.
- **State:** lifecycle status.

Supervisor panes show durable Leads under **Staffed Leads**. Lead panes keep
Peers under the existing subagents track.

## Legacy agents and bridge retirement

Legacy agents without a role binding continue through the existing resume path
and receive no inferred role. They display as `Legacy` when role-aware UI is
available.

Legacy conversations cannot be converted in place. Human starts a new mapped
profile when enforcement is required.

The wrapper profiles remain until Phase 2 proves parity for:

- prompt identity and resume;
- native tool restrictions;
- role-scoped Paseo tools;
- mixed-provider staffing;
- durable Lead lifecycle;
- limits and denial paths.

After parity, operators remove the six wrapper profiles explicitly. The daemon
never silently rewrites provider configuration.

## Errors

| Code                           | Meaning                                        | Result                          |
| ------------------------------ | ---------------------------------------------- | ------------------------------- |
| `ROLE_REQUIRED`                | Selected provider profile has no role          | Reject before launch            |
| `UNKNOWN_ROLE`                 | Profile names an unsupported role              | Reject before launch            |
| `ROLE_PROVIDER_UNSUPPORTED`    | Provider cannot enforce the role               | Reject before launch            |
| `ROLE_POLICY_COMPILE_FAILED`   | Policy cannot map safely                       | Reject before launch            |
| `ROLE_CONTRACT_PERSIST_FAILED` | Atomic storage failed                          | Reject before provider start    |
| `ROLE_SNAPSHOT_MISSING`        | Persisted prompt bytes are unavailable         | Refuse resume; preserve record  |
| `ROLE_CONTRACT_CORRUPT`        | Stored digest does not match                   | Refuse resume; preserve record  |
| `STAFFING_DENIED`              | Agent role pair is not allowed                 | Deny and audit                  |
| `STAFFING_LIMIT_REACHED`       | Project or Lead reached its live limit         | Deny and report counts          |
| `RUNTIME_UNAVAILABLE`          | Persisted runtime no longer exists             | Refuse launch/resume            |
| `RUNTIME_DEGRADED`             | Provider reports a different effective runtime | Surface; fail if policy weakens |
| `CAPABILITY_DENIED`            | Invocation violates role policy                | Deny and audit                  |

Errors use the existing RPC error envelope. New error metadata remains optional
for old clients.

## Testing strategy

Work in vertical TDD slices and run only targeted test files locally.

### Role and storage contracts

- Provider profiles resolve only explicit `foundationRole` metadata.
- Role prompt bytes are read once for new creation and persisted exactly.
- Resume never re-reads the current prompt source.
- Capability and instruction digests are deterministic.
- Legacy records parse without inferred roles.
- Missing or corrupt snapshots reject resume.

### Runtime contracts

- Every creation path sends a full runtime selection.
- Same-provider and cross-provider spawns never inherit staffer settings.
- Retired selections return `RUNTIME_UNAVAILABLE` with no substitution.
- Existing Human runtime changes persist and resume with their latest accepted
  values.

### Authorization and limits

- Human can create every role.
- Supervisor can create Lead only.
- Lead can create Peer only.
- Peer cannot create managed Paseo agents.
- One project rejects a second unarchived Lead unless Human explicitly
  overrides.
- A Lead rejects its fifth unarchived Peer unless Human explicitly overrides.
- Archive releases a slot; idle, error, and closed do not.
- Explicit Human overrides succeed and audit.
- Filtered catalogs omit unauthorized tools and direct invocation is denied.
- Provider-native subagent and team tools are unavailable for all roles.

### Lifecycle

- Supervisor-created Lead has staffing ownership and no parent label.
- Supervisor archive leaves the Lead unarchived and marks it as needing a
  Supervisor.
- Human reassignment rebinds notifications.
- Lead archive cascades to Peer.
- Lead idle, closed, process exit, and daemon restart do not cascade.
- Peer completion does not auto-archive before acceptance.

### Wrapper contracts

- Codex and Claude consume byte-identical role prompt files.
- `codex-room` retains native multi-agent stripping.
- `claude-room` forwards SDK argv and appends the prompt/settings flags.
- Claude custom provider role comes from environment, not a discarded positional
  command argument.
- Prompt marker appears exactly once on create and resume.
- Claude Code's default preset remains active.
- Direct terminal launches warn when no persisted Paseo contract exists.

### Protocol and UI

- New fields remain optional and wire-compat fixtures pass both directions.
- Role behavior is gated once on `agentRolesV1`.
- Every shim is tagged `COMPAT(agentRolesV1)`.
- Labels are role-first and the task column is **Assignment**.
- Supervisor and Lead use separate Staffed Leads and subagent surfaces.

### Real-provider smoke

Verify all six provider/role combinations. Each smoke checks:

- exact role prompt identity;
- requested model/mode/thinking;
- one representative allowed action;
- one representative denied action;
- caller-scoped Paseo tools;
- create, close/restart, and resume;
- no provider-native subagent creation.

Add mixed-room smokes for Codex Supervisor to Claude Lead and Claude Lead to
Codex Peer. These tests do not run in the default unit suite.

## Rollout

1. Add optional role/profile/storage types, persisted RoleBinding, prompt
   materialization, and legacy parsing with enforcement off; reuse existing
   runtime persistence.
2. Extract shared role prose and room helpers; update `codex-room`; implement
   `claude-room` and `claude-room-sync`.
3. Add caller-scoped authorization, spawn graph, operational limits, and stable
   errors.
4. Add durable Supervisor-to-Lead staffing, notification ownership, Human
   reassignment, and UI presentation.
5. Add role-first profile labels, Assignment terminology, and compatibility
   gates.
6. Enable required roles on an isolated development daemon and verify all six
   provider/role combinations plus mixed rooms.
7. Enable required roles on the target workstation only after independent
   verification. Do not integrate into `slp/patches` or restart production as
   part of development.
8. Plan Phase 2 native role selection and provider-adapter delivery upstream.
9. Remove wrappers only after Phase 2 proves parity.

## Acceptance criteria

- Every new role-managed target agent resolves exactly one of three foundation
  roles.
- Codex and Claude receive byte-identical role instruction segments.
- Resume uses persisted prompt and policy bytes after role sources change.
- Human can staff any tier; agents follow Supervisor-to-Lead-to-Peer only.
- Agent staffing enforces one Lead per project and four Peers per Lead.
- Supervisor cannot mutate project files; Peer cannot orchestrate agents.
- Native provider subagents are disabled for all roles.
- Supervisor archive does not archive Lead; Lead archive cascades to Peer.
- Runtime catalog drift fails explicitly without fallback.
- Unauthorized catalog entries and direct invocations are denied at runtime.
- Role labels are role-first and assignments are not treated as authority roles.
- Existing roleless conversations still resume without inferred roles.
- Production stays untouched until the isolated six-combination and mixed-room
  verification passes.
