# Provider-Neutral Agent Roles

**Status:** Approved design

**Date:** 2026-08-08

## Summary

Paseo will own three provider-neutral agent roles: `lead`, `peer`, and `supervisor`.
Every new role-managed agent must choose one role. Codex and Claude receive the
same immutable role instructions, while their adapters translate the shared
launch contract into provider-specific prompt and permission settings.

The daemon persists the resolved role instructions and capability policy before
starting an agent. Resume uses that snapshot rather than resolving the current
role definition again. A role definition update therefore affects new agents
only.

Role enforcement happens in two places: the daemon filters the tool catalog
before launch and authorizes every invocation at runtime. Provider-native tools
receive equivalent restrictions in the Codex and Claude adapters. Prompt text is
behavioral guidance, not an authorization boundary.

## Goals

- Give Codex and Claude the same `lead`, `peer`, and `supervisor` roles.
- Use one canonical instruction body and capability policy per role.
- Require an explicit role selection for every new agent when role enforcement
  is enabled.
- Preserve the exact resolved role contract across restart and resume.
- Prevent provider configuration or custom options from bypassing role policy.
- Keep old clients and persisted legacy agents parseable.
- Show role and provider as separate concepts in the UI.

## Non-goals

- Do not add `claude-profile` or `codex-room` wrapper scripts.
- Do not create provider entries such as `claude-lead` or `codex-peer` for new
  agents.
- Do not mutate the role of an existing conversation.
- Do not update old conversations to the newest role definition on resume.
- Do not add user-defined roles in v1.
- Do not make `WORKSPACE_PROTOCOL.md` discovery or editing part of this feature.
  A caller-supplied workspace protocol may be included in the persisted prompt
  snapshot, but its lifecycle remains owned by the existing workspace workflow.
- Do not add temporary capability escalation for Supervisor in v1.

## Terminology

### Role definition

The built-in, versioned source for one role's label, instructions, and
capability policy. Definitions are provider-neutral and live in one daemon-owned
registry.

### Role binding

The immutable role snapshot resolved for one conversation. It contains the
canonical role bytes that both providers receive.

```ts
type RoleId = "lead" | "peer" | "supervisor";

interface RoleBinding {
  roleId: RoleId;
  label: "Lead" | "Peer" | "Supervisor";
  roleVersion: number;
  instructions: string;
  capabilityPolicy: CapabilityPolicy;
  workspaceProtocolDigest?: string;
  digest: string;
}
```

`digest` covers the role id, role version, exact instruction bytes, capability
policy, and optional workspace protocol digest using stable serialization.

### Launch contract

The immutable launch snapshot that combines a `RoleBinding` with provider,
model, and prompt delivery information.

```ts
interface LaunchContract {
  contractVersion: 1;
  provider: AgentProvider;
  model?: string;
  roleBinding: RoleBinding;
  effectivePrompt: string;
  effectivePromptDigest: string;
}
```

The persisted contract is authoritative on resume. Provider discovery and the
current role registry must not change it.

## Role semantics

The initial definitions preserve the current Codex room model:

- **Lead** owns project coordination, delegation, integration, and acceptance.
  It may inspect and change the workspace and use Paseo lifecycle tools.
- **Peer** owns independent judgment and implementation inside a bounded task.
  It may inspect and change the workspace but may not orchestrate agents.
- **Supervisor** observes workflow and reasoning, communicates evidence-backed
  concerns, and relays owner decisions. It may not change the workspace or own
  project acceptance.

All three roles have provider-native subagents disabled. Paseo remains the only
agent lifecycle control plane.

## Capability policy

Capabilities use semantic action groups rather than provider tool names. Each
adapter compiles these groups into provider-specific restrictions.

| Capability                                     |  Lead |  Peer |                Supervisor |
| ---------------------------------------------- | ----: | ----: | ------------------------: |
| Read workspace and timeline                    | Allow | Allow |                     Allow |
| Mutate workspace                               | Allow | Allow |                      Deny |
| Use Paseo lifecycle create/stop/archive/delete | Allow |  Deny |                      Deny |
| Send prompts or follow-ups to another agent    | Allow |  Deny | Allow within daemon scope |
| Wait for or inspect another agent              | Allow |  Deny |                     Allow |
| Change another agent's launch contract         |  Deny |  Deny |                      Deny |
| Use provider-native subagents                  |  Deny |  Deny |                      Deny |

Supervisor cannot create a replacement Lead in v1. A future human-authorized
recovery grant must be a separate, auditable capability rather than an
instructional exception.

"Within daemon scope" uses the daemon's existing caller visibility and ownership
checks. V1 does not introduce a second role-specific workspace or agent
ownership model.

## Architecture

### Foundation role registry

Add a daemon-owned registry such as
`packages/server/src/server/agent/roles/foundation-role-definitions.ts`. It is the
only source for the three labels, instruction bodies, versions, and capability
policies.

Role instructions must not mention Codex or Claude. Updating any instruction or
capability increments that role's version. Tests pin the exact definition bytes
and digest algorithm.

### Role resolution

A small role-binding module validates `roleId`, loads the definition, combines
any caller-supplied workspace protocol snapshot, and returns an immutable
`RoleBinding`. It does not know which provider will run the agent.

Role resolution runs only for a new conversation or when a persisted schedule
is explicitly updated. Resume and restart never call the registry.

### Launch contract assembly

The agent manager assembles the launch contract after provider/model validation
and before creating the provider process. Prompt assembly uses a fixed order:

1. Existing daemon/global system instructions.
2. Existing caller-supplied system instructions.
3. The exact persisted role instructions.
4. A caller-supplied workspace protocol snapshot, when present.

The role instruction segment remains byte-identical for Codex and Claude. Their
built-in provider prompts may differ.

The storage write must complete before the provider starts. If persistence
fails, launch fails without starting an unbound agent.

### Persistence

Add an optional `launchContract` object to the persisted agent record schema.
Paseo's file-backed storage has no migration phase, so existing records remain
valid and new records write the additional object atomically.

Persist the resolved bytes, not a pointer to the role registry. A role id alone
is insufficient because a later definition change would alter resume behavior.

Secrets and provider credentials remain outside the launch contract. The
contract stores only provider identity, model identity, prompts, and policy.

### Prompt delivery

The provider adapter applies role-owned options after all user/provider custom
options so custom configuration cannot overwrite the role prompt or policy.

#### Codex

- Deliver `effectivePrompt` through developer instructions.
- Force native Codex agents off for all three roles.
- Force a read-only sandbox for Supervisor.
- Reject any role-policy override from provider extras.

#### Claude

- Keep the Claude Code preset system prompt.
- Set `systemPrompt` to `{ type: "preset", preset: "claude_code", append:
effectivePrompt }` after merging custom Claude options.
- Remove or replace custom `agents` configuration so native Claude subagents
  cannot be enabled.
- Compile the capability policy into the existing `canUseTool` authorization
  callback.
- Deny mutation-capable native tools for Supervisor. In v1 this includes shell
  execution as well as direct write/edit tools; an allowlisted read-only shell
  grammar is out of scope.
- Deny native Agent, Task, team, and provider-to-provider messaging tools for all
  roles, including names introduced by supported Claude SDK versions.

### Tool authorization

Authorization is fail-closed and has two gates:

1. Build a caller-scoped Paseo tool catalog that omits unauthorized actions.
2. Authorize every invocation again against the persisted `RoleBinding`.

The second gate protects resumed sessions, stale provider catalogs, and direct
calls from older clients. A denied call emits a structured audit event with
agent id, role id, semantic capability, tool name, and denial reason. It must not
record secret tool arguments.

Provider-native tools use the same semantic policy through adapter-specific
mappers. Unknown provider tools that could mutate state or create agents are
denied until explicitly classified.

## Lifecycle

### New conversation

```text
create(roleId, provider, model)
  -> validate role and provider
  -> resolve RoleBinding
  -> compile capability policy
  -> build LaunchContract
  -> persist agent record atomically
  -> construct filtered tool catalog
  -> launch provider adapter
```

The daemon never starts an agent if role validation, policy compilation, digest
generation, or persistence fails.

### Resume and daemon restart

```text
load agent record
  -> load persisted LaunchContract
  -> verify role and prompt digests
  -> compile policy from persisted snapshot
  -> launch provider adapter with persisted prompt
  -> resume provider session
```

Digest mismatch is treated as corrupted state. Paseo does not repair it by
loading the current role definition because that would silently change the
conversation's authority and behavior.

### Fork

A fork creates a conversation and therefore requires a role. The UI preselects
the source conversation's role but requires the user to confirm it. The new
conversation resolves the current role version; it does not copy the old role
snapshot unless a future explicit "clone launch contract" operation is added.

### Schedules and loops

A schedule must choose a role when it is created. The schedule persists its
resolved role binding so later runs remain stable until the schedule is edited.
Editing the schedule's role or explicitly refreshing its role creates a new
binding for future runs and does not mutate existing conversations.

A loop reuses the conversation's persisted contract. Heartbeats and follow-ups
do not resolve or change roles.

## Protocol and compatibility

Wire schemas must remain backward-compatible. New request fields are therefore
structurally optional even though the feature requires them at runtime.

- Add `roleId?: RoleId` to every agent-creation request shape.
- Advertise a server feature such as `agentRolesV1` in `server_info.features`.
- New clients gate the role UI once and always send `roleId` to capable daemons.
- A daemon configured with required roles rejects roleless creation with the
  existing RPC error envelope and a stable `ROLE_REQUIRED` code.
- Old clients continue to parse all messages. On a required-role daemon, their
  roleless creation request fails with an actionable update-client message.
- New clients connecting to an old daemon do not show the role workflow and
  explain that the host must be updated.

Every compatibility shim must carry a dated `COMPAT(agentRolesV1)` tag in code.

Role enforcement is enabled through daemon configuration during rollout. The
target deployment sets it to required. Product-wide default enforcement can be
enabled only after the supported clients expose role selection.

## Creation surfaces

Every path that creates a conversation must provide or persist a role:

- app composer/new-agent flow;
- CLI agent run/create commands;
- `@getpaseo/client` APIs;
- MCP/Paseo `create_agent` and related host tools;
- schedules;
- forks;
- any automation that creates a fresh agent.

Resume, follow-up, heartbeat, and loop turns inherit the stored contract and do
not ask for a role again.

## UI

Provider and role are separate required selectors.

- Provider labels remain `Codex` and `Claude`.
- Role labels are `Lead`, `Peer`, and `Supervisor`.
- Do not show `Codex Lead`, `Codex Peer`, `Codex Supervisor`, or equivalent
  Claude-prefixed role labels.
- Conversation summaries use `Lead · Claude`, `Peer · Codex`, and the same
  pattern for other combinations.
- Role selection appears only after the connected daemon advertises
  `agentRolesV1`.
- Role errors remain visible in the creation surface and preserve the user's
  other selections.

The provider picker chooses a runtime. The role picker chooses authority and
behavior.

## Legacy migration

### Persisted conversations

Legacy conversations without `launchContract` continue through the existing
resume path and receive no inferred role. The UI identifies them as `Legacy`
rather than guessing from provider or prompt text.

Legacy conversations cannot be converted in place. Users start a new
conversation with an explicit role.

### Existing custom providers

Deployments using `codex-root`, `codex-peer`, and `codex-supervisor` may map them
to migration suggestions:

| Legacy provider/profile | Suggested provider | Role       |
| ----------------------- | ------------------ | ---------- |
| `codex-root`            | Codex              | Lead       |
| `codex-peer`            | Codex              | Peer       |
| `codex-supervisor`      | Codex              | Supervisor |

The daemon does not silently rewrite config. After native roles are verified,
operators remove the wrapper providers explicitly. Visible labels lose the
`Codex` prefix immediately in the native role UI; legacy custom provider labels
remain unchanged until their config is removed.

## Errors

| Code                           | Meaning                              | Result                         |
| ------------------------------ | ------------------------------------ | ------------------------------ |
| `ROLE_REQUIRED`                | New conversation has no role         | Reject before launch           |
| `UNKNOWN_ROLE`                 | Role id is not built in              | Reject before launch           |
| `ROLE_PROVIDER_UNSUPPORTED`    | Provider cannot enforce the role     | Reject before launch           |
| `ROLE_POLICY_COMPILE_FAILED`   | Adapter cannot map the policy safely | Reject before launch           |
| `ROLE_CONTRACT_PERSIST_FAILED` | Atomic storage write failed          | Reject before launch           |
| `ROLE_CONTRACT_CORRUPT`        | Persisted digest does not match      | Refuse resume; preserve record |
| `CAPABILITY_DENIED`            | Tool invocation violates role policy | Deny call and audit            |

Errors use the existing RPC error envelope. The app renders creation failures in
place with retry or update-host/client guidance.

## Testing strategy

Work in vertical TDD slices and run only targeted files locally.

### Unit contracts

- Role definitions produce deterministic snapshots and digests.
- Codex and Claude receive the same exact role instruction segment.
- Custom provider options cannot overwrite role prompt or capability policy.
- Each role compiles to the expected semantic capability matrix.
- Unknown native tools fail closed.
- A persisted contract round-trips without byte changes.
- Changing a role definition does not change a loaded old contract.
- Corrupted role or prompt digests reject resume.
- Legacy records still parse and enter the legacy resume path.

### Server integration

- Creation persists the contract before the provider starts.
- Missing and unknown roles return stable errors.
- Filtered catalogs omit unauthorized Paseo tools.
- Direct invocation of an omitted tool is also denied.
- Peer cannot orchestrate agents.
- Supervisor cannot mutate the workspace.
- Lead can use Paseo lifecycle tools.
- Native subagents are disabled for all roles.
- Schedule runs and loop/resume paths reuse their stored bindings.

### App and CLI behavior

- New-agent UI requires a role and preserves selections after failure.
- UI labels are `Lead`, `Peer`, and `Supervisor` without provider prefixes.
- Conversation summaries combine role and provider as separate labels.
- Old-daemon and old-client capability gates produce actionable feedback.
- CLI and client APIs reject missing roles locally when the daemon advertises
  required roles.

### Real-provider smoke

Add focused real-provider coverage for the six combinations of three roles and
two providers. The smoke test verifies prompt identity, one representative
allowed action, one denied action, and resume using the stored contract. These
tests belong in `*.real.e2e.test.ts` and do not run in the default unit suite.

## Rollout

1. Add persisted role types, registry, digesting, and legacy parsing with the
   feature disabled.
2. Add daemon authorization and provider adapters with targeted unit tests.
3. Add role selection to client, CLI, MCP, schedules, and fork flows behind
   `agentRolesV1`.
4. Enable required roles on an isolated development daemon.
5. Verify all six Codex/Claude role combinations, denial paths, and resume.
6. Enable required roles on the target workstation.
7. Remove `codex-room` custom providers only after native-role conversations
   pass end-to-end verification.
8. Consider a product-wide default only after supported clients have shipped.

The production daemon on port `6767` must not be restarted as part of
development or verification without explicit permission.

## Acceptance criteria

- Every new agent on the target deployment has an explicit `lead`, `peer`, or
  `supervisor` role.
- Codex and Claude receive byte-identical role instructions for the same role
  version.
- Resume uses the persisted role and prompt bytes even after definitions change.
- Unauthorized Paseo and provider-native actions are denied at runtime.
- Supervisor cannot mutate the workspace; Peer cannot orchestrate; Lead can
  orchestrate through Paseo.
- Native provider subagents are disabled for all roles.
- Existing roleless conversations still resume without inferred roles.
- UI role labels contain no `Codex` or `Claude` prefix.
- The target workstation no longer depends on role-specific wrapper providers
  after native roles are verified.
