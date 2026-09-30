# One shared model policy

Open **Workspace settings** (the settings icon on Home). Choose a provider preset, refresh
available models, adjust any defaults, then **Save model settings**. This works on the
computer and paired phone; each selected computer keeps its own policy and sign-ins.

| Level        | Codex family | Claude family | Default work                                                                                    |
| ------------ | ------------ | ------------- | ----------------------------------------------------------------------------------------------- |
| Bulk default | Luna         | Sonnet        | Explicitly simple batches of text or images                                                     |
| Undergrad    | Terra        | Sonnet        | Routine checks, recurring monitoring                                                            |
| Grad student | Sol          | Opus          | Research, implementation, review, calculations, difficult questions and delegated orchestration |
| Postdoc      | Astra        | Fable         | Project/module managers and the personal agent                                                  |

These are the owner's work preferences, not measured intelligence ratings or accuracy
guarantees. The uncle name recalls a confident relative whose answers need checking.
Managers have the postdoc assignment tier. Planning, implementation and review cannot be
labelled routine/bulk to request weaker tiers. Task classification is explicit, not an
infallible content classifier. Owner-selected exact models can intentionally override a
family default; the app does not pretend an older/different pinned model has changed ability.

## Defaults and overrides

Project creation uses separate manager selection, provider-mix and spending controls. The
[corrected project matrix](CHAT_UI_REQUIREMENTS.md#corrected-worker-defaults) supplies research,
review and bulk families; exact versions come from the live catalog. These project settings
override the global fallback below. Explicit supported versions remain selectable. Haiku is
not a shipping default. Legacy saved pins are retained; known low-tier models cannot be
relabelled as suitable for a managed calculation/review. Unknown future models are not
assigned an invented capability classification.

A new empty installation uses **Codex only** until another provider is deliberately enabled.
Saved policies and existing workspaces retain their choices. **Providers in your defaults**
controls automatic routing: with one provider, both heavy presets keep managers and workers
there. Removing a provider resets its task overrides to Follow preset and chooses an enabled
provider for unattended checks; exact model pins remain saved. Explicit conversation/delegation
provider choices and existing identities are still honored. This setting is not a security ban.
A transient sign-in/catalog failure never changes the selected providers.

With both providers enabled:

- **Codex heavy:** Codex manager/research/coding defaults and Luna for bulk work.
- **Claude heavy:** Claude manager/research/coding defaults and Sonnet for bulk work.
- Routine checks use the saved scheduled-provider choice; both providers retain their own
  central Terra/Sonnet defaults. Exact saved overrides are preserved.
- **Pick as I go:** choose a provider when creating a manager or the personal agent.
  Managers must name a provider on each delegation. Instructions tell them to honor the
  owner's choice, otherwise choose fresh available QUARK headroom and record a reason.
  They ask the owner if neither fits. Unattended checks use a saved provider choice.
- Per-task provider settings override the preset. A per-delegation provider overrides those.
- Each provider/tier has one editable **family name**, an optional exact **model** pin and
  optional **thinking level**. Family names are not scattered across launchers. Renaming a
  family in Settings updates its consumers. Exact pins can use any model the installed
  provider reports, including an older version outside the normal family.

Claude's **Provider default** thinking choice leaves the optional native effort override
unset. Models without reported thinking levels remain selectable with that choice;
they are not hidden or assigned an invented level. Saved explicit unsupported levels
still require a correction, rather than being silently discarded. Native model discovery
also leaves effort unset and does not start a model turn.

Latest means the newest identifiable generation **available in the installed account's
catalog**, with numeric version ordering and unversioned rolling aliases preferred when offered. Context-size suffixes
are not version increments. A rolling alias without a version stays an alias; the app cannot
prove which unpublished revision the provider serves. Discovery is metadata-only, shared
in flight and cached for five minutes. Refresh available models refreshes enabled providers;
an unavailable provider does not hide the other's choices. Failed/stale discovery never
silently falls back to an old list for a new assignment. Providers can still reject a model
that disappears between discovery and submission; that failure is retained for inspection,
not replayed by the app on another model. Provider-internal alias resolution or fallback
remains provider behavior; an assignment records the requested choice, not a guarantee of
every hidden inference step. Future unknown family names require a central mapping change.

Policy-managed conversations refresh family defaults **between turns on the same provider**.
Queued/admitted work freezes its exact choice and policy revision. Existing legacy, imported,
explicitly pinned and native-controlled contexts retain their choices. The advanced session
model menu offers **Follow central model default** to opt back in. Changing presets does
not move an existing conversation to another provider or rewrite its history.

## Undergrad escalation

An undergrad receives `dock_escalate(question, evidence)` when escalation is enabled. It can
request **one grad consultation per assignment**, on the same provider, and finish its turn.
The grad gets the bounded question/evidence and read-only permissions; it cannot escalate
again or launch native helpers. A project consultation reports directly to the responsible
manager; a computer check produces a separately labelled report in Computer health.

Escalation uses durable receipts and the same QUARK queue, task priority and budget. It
cannot bypass approvals or task accounting. A resource escalation counts toward the six
automatic attempts per rolling day and receives the normal 15-minute queue expiry and
three-minute runtime limit. It estimates 6,000 tokens / 2% allowance, not a hard token cap.
The watcher releases both diagnostic processes when they finish. Turning escalation off
blocks new consultations; queued work remains reviewable. No model polling or reply loop.

## Launch-path coverage

| Path                                                                    | Policy behavior                                                                                                                                             |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New project, folder connection, additional manager, advanced `dock add` | Provider preset/explicit choice; postdoc on first managed turn                                                                                              |
| Personal agent                                                          | Same manager policy, with original project-visibility controls                                                                                              |
| `dock_delegate`                                                         | Explicit task class and optional higher tier; policy model/provider or exact overrides; durable assignment before queueing                                  |
| Computer Ask, checkpoint, pressure check                                | Routine undergrad policy; former Terra preference migrates to the central routine-provider choice                                                           |
| Undergrad consultation                                                  | Same-provider grad model from the central policy, bounded one-step escalation                                                                               |
| Managed Codex native helpers                                            | Resolved parent model/effort set as native defaults; central policy in instructions; cheap routine/bulk work and consultations have native helpers disabled |
| Native custom roles / explicit spawn overrides                          | Preserve owner/provider overrides; actual model and visible history are mirrored. These native choices are not hard host-enforced task classification       |
| Imported Codex sessions and original VS Code Codex/Claude chats         | Preserve native provider, identity and model choices; do not migrate them into fresh managed agents                                                         |
| Catalog discovery                                                       | No user/model turn. Claude uses its provider `default` discovery selector, not a hard-coded reasoning family                                                |

Claude rolling choices follow its [model-alias configuration](https://code.claude.com/docs/en/model-config); local/organization remapping can affect what an alias serves.
Native default precedence follows the [official Codex subagent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents).
The policy does not control independently launched terminals, third-party plugins' internal
model calls, provider-internal summarizers or original editor sessions. Original controls
remain available; app-managed model assignment and external native choice are distinct.

The **Require its own usage meter** setting preserves the independent Fable allowance by
default. A family rename updates its meter matching centrally. Provider protocol field
names (such as Anthropic's `seven_day_sonnet`) remain in provider adapters, not task routing.
An absent required meter holds work; it is not additional capacity. Exact pins must retain
an appropriate meter requirement when an account needs one.

## Implementation and acceptance

Shared contracts/default families/version resolution: `packages/shared/src/model-policy.ts`.
Settings persistence, catalog cache and assignment resolution: `apps/server/src/model-policy.ts`.
No versions are embedded in production task-routing code. Policy saves use revision checks,
durable retry IDs and append-only events. Runtime data, live catalogs and screenshots stay
under ignored `data/`. Maintained tests remain source, not personal demonstration artifacts.

- [x] Central modular policy for all app-owned launch paths; original native sessions preserved.
- [x] All four tier/family mappings and appropriate task floors.
- [x] Managers postdoc; recurring checks undergrad; tricky reasoning/calculation/orchestration grad; uncle reserved for simple bulk work.
- [x] Both provider-heavy presets and explicit pick-as-you-go rules for managers and scheduled work.
- [x] Latest available families, exact historical-version choices and thinking-level overrides.
- [x] Editable family mappings and independent allowance requirement.
- [x] Settings UI on phone/desktop; first-read failure, retry and concurrent-device conflicts.
- [x] One-step undergrad-to-grad escalation with queue, permission and resource caps.
- [x] Retained provider identity/history, frozen queued choices and explicit native pins.
- [x] Nontechnical website story in PRODUCT_STORY.md.

Verified evidence and current installed-provider limitations are recorded in VERIFICATION.md.

## QUARK allocation desk

The separate QUARK coordinator has a central model choice in shared/quark-coordinator.ts,
resolved by ModelPolicy.resolveQuark against the installed catalog. Its default is Claude
Opus (currently reported here as Opus 5.5), following the latest family entry. The QUARK
model/settings panel supports exact catalog choices and another provider; no unavailable
model is silently substituted. This is the owner's explicit exception to ordinary project
manager postdoc defaults. Provider changes preserve the old conversation and use a new one.

Claude catalogs retain rolling aliases and now also expose concrete model IDs reported by
the provider, so “exact version” selections can remain pinned when an alias moves forward.
