# Provider-Neutral Agent Roles — Bridge and Enforcement Boundary

**Status:** Approved direction — implementation not started

**Date:** 2026-08-08

## Summary

Paseo rooms use three closed foundation roles: `supervisor`, `lead`, and `peer`.
Codex and Claude share the same role prose, while the staffer chooses the
provider, model, mode, and thinking or effort for each seat.

Delivery is intentionally split:

- **Phase 1 — profile bridge:** no Paseo core or wire changes. Existing custom
  provider profiles, launch wrappers, Claude settings and hooks, and current
  `create_agent` relationships provide a usable six-profile room.
- **Phase 2 — native enforcement:** four bounded modules, each justified by a
  verified Phase 1 gap. Phase 2 is required before the room may claim strict
  role enforcement.

The Phase 1 build belongs to the
[Claude Room implementation plan](https://github.com/thomasvan/AI-SLP_docs/blob/master/plans/claude-room-plan.md).
That plan is authoritative for the folded directory tree, wrappers, hooks,
provider entries, verification, and deployment. This spec does not duplicate
those details.

Profile law is useful access shaping, not a security boundary. A Peer without a
wired Paseo MCP server is less likely to orchestrate accidentally, but Bash and
an unprotected local daemon still permit intentional bypass. Phase 1 must state
that residual honestly.

## Goals

- Use the same role vocabulary and prose for Codex and Claude.
- Keep exactly three foundation roles; task-specific dispositions are
  assignments.
- Support mixed-provider staffing with explicit provider/model/mode/effort.
- Use today's detached/subagent relationships for the agreed lifecycle without
  Paseo core changes.
- Make every Phase 2 change close one named, observed Phase 1 gap.
- Preserve wrapper profiles until native behavior reaches verified parity.

## Non-goals

- Phase 1 does not add role schemas, daemon-persisted role snapshots, protocol
  fields, feature gates, error codes, or role-specific UI.
- Phase 1 does not claim mechanical enforcement of the staffing graph or limits.
- A challenger, reviewer, implementer, or owner is never a fourth foundation
  role.
- Assignment is not stored inside an immutable role contract.
- Provider-native subagents and teams are not an alternative staffing plane.
- Phase 2 is not one monolithic agent-roles project.

## Role vocabulary

### Foundation role

```ts
type FoundationRole = "supervisor" | "lead" | "peer";
```

The foundation role defines authority and operating boundaries:

- **Supervisor** observes process across projects, staffs Leads, communicates
  evidence-backed concerns, and relays Human decisions. It does not own project
  implementation or acceptance.
- **Lead** owns one project's decomposition, staffing, integration, acceptance,
  and cleanup.
- **Peer** owns independent judgment inside one bounded assignment and returns
  evidence to its Lead.

### Assignment

An assignment is the work a seat was opened to perform. Paseo already represents
it through the title, initial prompt, and conversation timeline.

- `Design challenger A` and `Implementation owner` are assignments, not roles.
- A Peer is minted for one bounded assignment. Material reassignment creates a
  new Peer.
- A durable Lead may receive follow-ups within the same project. Moving it to a
  different project creates a new Lead.
- Renaming a title does not change authority.

The UI task column is called **Assignment**, not **Role**.

## Staffing contract

Human may create or override seats at any tier. The agent-initiated graph is:

```text
Human      -> Supervisor | Lead | Peer
Supervisor -> Lead
Lead       -> Peer
Peer       -> none
```

The staffer states the complete provider/model selection and supported
mode/thinking option on every creation. No same-provider or cross-provider
inheritance is part of the room contract.

Operational limits are one unarchived Lead per project and four unarchived
Peers per Lead. Phase 1 treats these as room law and telemetry review; Phase 2
enforces them mechanically with an explicit Human override.

Provider-native `Agent`, `Task`, team, or equivalent tools are disabled for all
three roles. Paseo seats are the only supported delegation surface.

## Phase 1 — profile bridge

### Ownership

The Claude Room implementation plan owns all Phase 1 build details. In
particular, its §3 and §8 own the folded `runtime/` tree and deployment symlink;
this spec does not restate paths.

Phase 1 includes both:

- the `codex-room` fold into that tree; and
- shared-prose adoption, where Codex and Claude both read the same role Markdown
  while Codex TOML files retain provider configuration only.

There is no `roomlib.py`, daemon-materialized role file, `PASEO_ROLE_PROMPT_FILE`,
or `PASEO_FOUNDATION_ROLE` in Phase 1. Claude uses one shared launcher plus three
thin role executables because Paseo's Claude adapter honors a replacement
executable but discards configured positional arguments before the Agent SDK
launch.

The six provider labels remain role-first:

- `Supervisor · Codex`, `Supervisor · Claude`
- `Lead · Codex`, `Lead · Claude`
- `Peer · Codex`, `Peer · Claude`

### Prompt delivery and precedence gate

Claude appends the shared profile with `--append-system-prompt-file` and loads
the room settings with `--settings`. Append preserves Claude Code's default tool
guidance and safety prompt.

The implementation plan's prompt-precedence test is a release gate:

- capture wrapper argv under the Paseo Agent SDK path;
- prove the append-file and settings flags remain effective;
- prove one unique role marker appears exactly once on create and resume;
- prove Claude Code's default prompt remains active;
- prove native subagent denial and one role-specific denial;
- stop deployment if the SDK overrides or drops the profile.

A `SessionStart` hook may restate identity after resume or compaction, but its
stdout is conversation context, not a system prompt. It is not a fallback for a
failed append-file gate.

### Lifecycle convention available today

The agreed lifecycle works without new core behavior:

- Supervisor creates Lead through the accepted legacy placement shape with
  `relationship: {kind: "detached"}` and an explicit `workspace` placement. The
  created Lead omits `paseo.parent-agent-id`, stays out of the Supervisor
  subagent track, and is not archived when the Supervisor is archived.
- Lead creates Peer as the normal subagent relationship. Paseo stamps
  `paseo.parent-agent-id`, shows the Peer in the subagent track, and cascades
  archive from Lead to Peer.

This is correct behavior today but is convention, not role enforcement. The
detached placement shape is currently accepted through
`COMPAT(nestedCreateAgentPlacement)` and is no longer advertised to models. The
Phase 2 staffing module replaces that compatibility dependency with an explicit
role-derived graph.

### Caller-scoped Paseo tools

Phase 1 keeps global `daemon.mcp.injectIntoAgents` off. The launcher uses the
existing `PASEO_AGENT_ID` to materialize caller-scoped Paseo MCP only for
Supervisor and Lead. Peer receives no configured Paseo MCP server.

Two verified limitations remain:

- Without a daemon password, `/mcp/agents` accepts a caller id from the query
  string. An agent with Bash can forge another id.
- With a daemon password, the wrapper cannot access the daemon's per-run MCP
  capability token, so launcher materialization cannot authenticate.

The second gap is already tracked by the
[SLP-docs `INSTALL.md` Planned item](https://github.com/thomasvan/AI-SLP_docs/blob/master/INSTALL.md#planned)
**Password-protected Paseo MCP — pass a daemon-issued credential into
Supervisor/Lead without exposing it to Peer**. Phase 2 references that owner
instead of duplicating a second credential plan here.

### Resume semantics

The custom provider id is the Phase 1 role-routing identity. Paseo already
persists it with provider/model/mode/thinking settings.

For Paseo-managed Claude seats, the launcher pins the profile bytes per seat on
first launch and resumes from the pin (build plan §4.1), so editing `runtime/`
affects new seats and direct terminal launches only. The pin is same-user
wrapper state — tamper-evident, not a trusted record. Codex seats share the
per-role materialized config, so a re-sync still updates their instructions on
next launch. Module B remains the trusted, daemon-persisted form of this
property and extends it to every provider.

### Phase 1 acceptance

Phase 1 is complete when the implementation plan verifies:

- all six role-first profiles are selectable;
- Codex and Claude consume the same current role prose;
- Claude prompt/settings survive the Paseo SDK path;
- provider-native subagents are unavailable;
- Supervisor can create a detached Lead with explicit runtime selection;
- Lead can create a parent-labelled Peer with explicit runtime selection;
- Supervisor archive leaves the detached Lead active;
- Lead archive cascades to its Peers;
- Peer has no configured Paseo MCP server;
- a Paseo-managed Claude seat resumes with its pinned instruction bytes after a
  profile edit, and a corrupt pin refuses to launch;
- the open-endpoint, password-token, limit, Codex resume-drift, and
  untrusted-pin residuals are documented rather than represented as enforced.

Phase 1 changes no wire schema. Its tests and rollout live only in the build
plan.

## Phase 2 — named enforcement modules

Each module needs its own implementation plan, targeted tests, compatibility
review, and independently useful deliverable. Do not restore the old monolithic
rollout.

### Module A: authenticated wrapper grant

**Observed Phase 1 gap:** a passwordless MCP endpoint permits forged
`callerAgentId`; a password-protected endpoint requires a per-run capability
token the wrapper cannot access.

**Deliverable:** Paseo grants an agent-bound credential to approved
Supervisor/Lead launches without exposing it to Peer, and validates that the
credential matches the claimed caller. This module owns no role prompt or
staffing lifecycle work.

Until Module B supplies persisted role identity, the grant may target only the
closed, explicitly configured Supervisor/Lead provider-profile allowlist. After
Module B lands, the grant must consume `RoleBinding` rather than profile labels
or ids.

**Acceptance:** forged caller ids fail, password-protected Supervisor/Lead MCP
works, Peer receives neither server configuration nor credential, and secrets
are redacted from logs and persisted records.

### Module B: byte-stable role binding

**Observed Phase 1 gap:** the Claude launcher pin is same-user wrapper state
outside daemon persistence, Codex seats still take re-synced instructions on
their next launch, and provider id alone is not an immutable authority record.

**Deliverable:** an optional immutable `RoleBinding` stores one of the three
foundation roles, exact instruction bytes, binding-format version, and digest
before provider launch. Resume uses the stored bytes. Legacy agents keep the
existing path. Staffing policy and capability grants remain owned by their
separate modules.

**Acceptance:** new role-managed agents persist before launch, changed source
files affect new agents only, corrupt or missing bindings refuse role-managed
resume without rewriting records, and legacy records still parse and resume.

### Module C: enforced staffing graph

**Observed Phase 1 gap:** Supervisor must remember to request the compatibility
`detached` relationship for Lead, any MCP-enabled caller can choose another
relationship, and the daemon stores no durable staffing ownership.

**Deliverable:** derive allowed creation and lifecycle from the persisted role
pair: Supervisor→Lead is durable/non-cascading; Lead→Peer is
parent-labelled/cascading; Peer→agent is denied. Human creation and explicit
override remain available at every tier. Replace the compatibility placement
dependency before its removal date.

This module depends on Module B for trusted role identity; it does not infer a
role from a provider label.

Minimal optional snapshot/UI data may be added only where needed to show a
Lead's staffing owner and keep durable Leads separate from Peer subagents.

**Acceptance:** direct calls cannot choose a forbidden pair or lifecycle,
Supervisor archive leaves Lead active, Lead archive cascades to Peer, and Human
override is explicit and audited.

### Module D: staffing limits

**Observed Phase 1 gap:** profile law and telemetry cannot prevent a second Lead
or fifth Peer, and concurrent creations can race.

**Deliverable:** atomically enforce one unarchived Lead per project and four
unarchived Peers per Lead. Archive releases a slot; idle, closed, error, process
exit, and completed turns do not. Human may explicitly override with an audit
record.

This module depends on Module C's staffing ownership and lifecycle semantics.

**Acceptance:** concurrent creation cannot exceed either cap, denial reports the
current count and limit, and only a Human override bypasses the cap.

## Phase 2 compatibility discipline

Only the module that needs a wire or storage change adds it. New fields remain
optional, role-aware UI gates once on `server_info.features.agentRolesV1`, and
every temporary shim is tagged `COMPAT(agentRolesV1)` with a removal condition.
Follow `docs/protocol-compatibility.md`; do not add protocol surface in advance
for another module.

Stable errors are introduced with their owning modules rather than as a single
up-front catalog:

- Module A: caller authentication and credential errors.
- Module B: role binding missing/corrupt and runtime-unavailable errors.
- Module C: staffing-pair and lifecycle authorization errors.
- Module D: staffing-limit errors.

## Bridge retirement

Phase 2 enforcement does not automatically retire the wrappers. Remove a
wrapper only after native delivery proves parity for prompt identity, settings
and tool restrictions, mixed-provider staffing, resume, and direct terminal
behavior. Removal is an explicit provider-configuration migration with rollback,
not a silent rewrite.

## Completion criteria

The overall initiative is complete only when:

- Phase 1 provides a working mixed Codex/Claude room with the documented
  convention-based lifecycle;
- Module A closes caller impersonation and password-token delivery;
- Module B provides byte-stable role identity on resume;
- Module C enforces the role graph and durable/cascading lifecycle;
- Module D enforces one Lead/four Peers with Human override; and
- wrappers remain or retire according to measured parity, not schedule.
