# One shared model policy

Open **Settings → Model preferences**. Set your manager and worker defaults, refresh
available models, then **Save model settings**. This works on the
computer and paired phone; each selected computer keeps its own policy and sign-ins.

| Level        | Codex family | Claude family | Default work                                                                                                  |
| ------------ | ------------ | ------------- | ------------------------------------------------------------------------------------------------------------- |
| Postdoc      | Astra        | Fable         | Project/module managers and the strongest worker defaults                                                     |
| Grad student | Sol          | Opus          | Research, implementation, review, calculations, difficult questions and delegated orchestration               |
| Undergrad    | Terra        | Sonnet        | Routine checks, recurring monitoring                                                                          |
| Uncle        | Luna         | Sonnet        | They sound confident, but also believe whatever they read. Be careful trusting them. Use for cheap, bulk work |

These are the creator's work preferences, not measured intelligence ratings or accuracy
guarantees. The uncle name recalls a confident relative whose answers need checking.
Managers have the postdoc assignment tier. Planning, implementation and review cannot be
labelled routine/bulk to request weaker tiers. Task classification is explicit, not an
infallible content classifier. Owner-selected exact models can intentionally override a
family default; the app does not pretend an older/different pinned model has changed ability.

## Defaults and overrides

**New project defaults** is the user-wide starting point. Manager provider, model and
reasoning are separate from the workers' provider mix and spending slider. A manager model
pin does not change the model used by postdoc workers. Workers have
Research & coding, Review and Bulk choices, including exact versions from live catalogs.
The [recommended matrix](#recommended-worker-defaults) supplies
the family defaults. The initial recommendation is **Balanced + Tokenmax**; when only one
provider is enabled, use its **Only** preset instead. No second subscription is enabled by
restoring recommendations. Haiku is not a shipping default.

**Restore recommended defaults** fills the settings form with the creator's corrected
matrix, original family mappings, unpinned latest models, manager and routine defaults.
Review the form and Save to apply. It preserves enabled providers and existing projects.
The recommendation is configuration, not a promise that all families exist in every account.
Missing families stay visible and can be replaced with any supported exact model.

New projects copy the saved manager choices, worker mix, spending level, task overrides and family mappings
at registration, including projects created by the local API/CLI. Setup uses the same shared
snapshot function as registration and dispatch. Project customization never writes the
user-wide preferences. Existing project choices, explicit model pins and saved setup drafts
are preserved. **Use my general worker preferences** in project settings explicitly adopts
the current defaults; Save applies that project's change. The setup draft has the equivalent
**Use my current worker preferences** action. Neither resets the manager selection,
review/application policy or budgets.

Family mappings are shared across recommended worker choices and their corresponding model
levels. A renamed family or exact slot pin appears in new-project previews and dispatch.
A project's saved family continues resolving the latest available version at each new
assignment; an exact pin stays on that version. Later global changes do not rewrite its
snapshot. Existing projects without a snapshot retain legacy behavior until their settings
are changed. An already registered folder is never reinitialized with new preferences.

**App assistants** has one computer-health choice and one assisted-search choice. Each menu
shows the effective provider and model; changing it saves an explicit provider. Computer-health
changes also set the unattended provider, so there is no competing check-provider menu.
These assistants and stronger consultations reuse the central model levels. QUARK retains its explicit coordinator
model in its own controls. Inside new projects, routine work and calculations use the project's
provider choice; calculations and delegated orchestration retain the grad-or-higher minimum.
A Light Terra research choice is therefore not used for calculations. Explicit native choices
and imported conversations remain separate from defaults.

Old provider presets/task routing remain readable for saved installations and legacy projects.
The ordinary settings page resolves those to named choices instead of showing **Follow preset**.
Opening/saving an unrelated setting preserves existing routing. Choosing a manager at setup
retains the already resolved assistant choices instead of switching them to pick-as-you-go.
**Model levels and advanced choices** contains the family/version/thinking controls and
the retained calculation/orchestration defaults for work without saved project choices.
Detailed mappings are collapsed initially; catalog errors remain visible outside that section.
Thinking controls show the resolved level even when the saved choice follows the latest family.
Choosing the manager at project setup requires an explicit provider before Spawn when the
user-wide manager preference is **Choose at project setup**.

New managers whose central choice has no explicit effort prefer **xhigh** when the live
catalog supports it (then max/high/medium, then a reported level). Setup displays this
actual resolution; changing reasoning pins the displayed model and chosen effort so the
saved launch agrees with the form. Existing explicit settings remain unchanged. The shared
default resolver is used by both the setup form and backend policy.

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

Policy-managed conversations refresh available family versions **between turns on the same provider**.
New project managers use their project’s saved manager choice; workers use its worker mappings.
Queued/admitted work freezes its exact choice and policy revision. Existing legacy, imported,
explicitly pinned and native-controlled contexts retain their choices. The advanced session
model menu offers **Follow central model default** to opt back in. Changing presets does
not move an existing conversation to another provider or rewrite its history.

## Recommended worker defaults

Each cell is **Research/coding · Review · Bulk**. These are configurable families, resolved
to the latest available model unless explicitly pinned. Manager selection is independent.

| Spending | Codex only            | Codex heavy           | Balanced               | Claude heavy           | Claude only            |
| -------- | --------------------- | --------------------- | ---------------------- | ---------------------- | ---------------------- |
| Light    | Terra · Sol · Luna    | Terra · Opus · Luna   | Terra · Opus · Luna    | Opus · Sol · Sonnet    | Opus · Opus · Sonnet   |
| Default  | Sol · Astra · Luna    | Sol · Opus · Luna     | Sol · Opus · Sonnet    | Opus · Sol · Sonnet    | Opus · Fable · Sonnet  |
| Tokenmax | Astra · Astra · Terra | Astra · Fable · Terra | Astra · Fable · Sonnet | Fable · Astra · Sonnet | Fable · Fable · Sonnet |

The creator's preference is Balanced + Tokenmax. For an account with a replenishing Claude
five-hour allowance, Balanced or Claude heavy may fit its available capacity; QUARK still
checks actual reported windows, model-specific allowances and reserves. This is a configurable
recommendation, not an assertion about every institutional plan.

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

| Path                                                                    | Policy behavior                                                                                                                                                   |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New project, folder connection, additional manager, advanced `dock add` | Provider preset/explicit choice; postdoc on first managed turn                                                                                                    |
| Personal agent                                                          | Same manager policy, with original project-visibility controls                                                                                                    |
| `dock_delegate`                                                         | Explicit task class and optional higher tier; policy model/provider or exact overrides; durable assignment before queueing                                        |
| Computer Ask; checkpoint/pressure checks                                | Direct Ask defaults to the grad model on the routine provider; automatic checks remain undergrad. Exact selections and existing conversations retain their models |
| Undergrad consultation                                                  | Same-provider grad model from the central policy, bounded one-step escalation                                                                                     |
| Managed Codex native helpers                                            | Resolved parent model/effort set as native defaults; central policy in instructions; cheap routine/bulk work and consultations have native helpers disabled       |
| Native custom roles / explicit spawn overrides                          | Preserve owner/provider overrides; actual model and visible history are mirrored. These native choices are not hard host-enforced task classification             |
| Imported Codex sessions and original VS Code Codex/Claude chats         | Preserve native provider, identity and model choices; do not migrate them into fresh managed agents                                                               |
| Catalog discovery                                                       | No user/model turn. Claude uses its provider `default` discovery selector, not a hard-coded reasoning family                                                      |

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
Opus, following the latest family entry. The QUARK
model/settings panel supports exact catalog choices and another provider; no unavailable
model is silently substituted. This is the owner's explicit exception to ordinary project
manager postdoc defaults. Provider changes preserve the old conversation and use a new one.

Claude catalogs retain rolling aliases and now also expose concrete model IDs reported by
the provider, so “exact version” selections can remain pinned when an alias moves forward.
