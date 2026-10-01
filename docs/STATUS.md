# Build status

The Apple Silicon Mac setup path has passed the checks below. This does not mean every
owner request is complete; the current follow-ups are listed explicitly below. The MIT
source, website and installed app include the drawn Home, chat, project setup, notepad,
Computer health and QUARK workflows. Real isolated Codex-only and Claude-only setup journeys
pass. [CI 36798429104](https://github.com/OscarBarreraGithub/sciencewithagents/actions/runs/36798429104) passed production builds, 772 backend checks, 88 companion checks and
435 browser cases. Thirteen backend/companion and ten browser checks are deliberately skipped.

Phone/browser checks cover desktop, portrait, landscape and iPhone WebKit, including the
reported keyboard/scroll regressions. Physical Home Screen, cellular and hardware keyboard
behavior remain separate device checks; do not call those verified by emulation. Other
platforms and account/device boundaries are listed in CONTRIBUTOR_SETUP.md. No new drawing
or owner decision is required for the verified installation path.

## Latest owner correction

GitHub and Cloudflare copy prompts had pale text on an inherited pale code-block background,
making populated cards appear blank. Their text/background now stay readable in Apps and Help.
Production build, five-profile contrast/copy/fallback checks and live Safari inspection pass.

### Open owner follow-ups — checked against source, 2026-10-01

- **Model defaults — completed 2026-10-01:** Model preferences now saves general manager,
  worker and app-assistant choices. New projects snapshot those preferences, allow project
  customization and can explicitly adopt current general worker preferences. Restore
  recommended defaults returns the form to the creator's defaults without changing projects
  or enabling another subscription. Legacy saved projects retain their original choices.
- **Orb:** random selection, placement and tap-outline removal are done, but animation still
  stops after 1.8 seconds and there are only seven real shapes. The duration/variety concern
  was explained, not resolved. Do not count randomized rotation as additional shapes.
- **Updates:** the agent-assisted update runbook exists, but the app still asks the person to
  create a recovery copy before copying the update request. Moving that preparation into the
  update-agent workflow remains unfinished; removal of the Home shortcut did not complete it.
- **Account setup:** the readable prompts are static instructions. They do not detect GitHub
  or Cloudflare readiness, hide completed steps or mark verified completion. Copying never
  starts setup. This is separate from the working native-provider sign-in checks in Welcome.

- **Apps gallery:** it currently renders a fixed empty state. Registered app launch tiles
  and project website publication are not wired; the empty screen is not proof that those
  capabilities exist. The owner explicitly deferred visual fine-tuning until there are apps.

**Deliberately later:** AI news, the personal-agent destination and public Guide/FAQ remain
deferred. Marketplace publication and physical-phone acceptance remain separate from source
installation and browser simulation. Older private-ledger counts are historical evidence, not
proof that these later requests were implemented.

The VS Code control at the top of Chats shows connection/setup status and extension instructions.
Shared conversations remain in Chats. Initial shared history now loads even when the browser
is in the background; returning to the foreground refreshes promptly. The actual live editor
conversation was opened and confirmed Working with saved history.

QUARK supports closing obsolete task assignments with a saved reason and retained history.
It cancels their queued agent turns, leaves quotas/reviews/files intact, and refuses running
work or unresolved subtasks. Ten stale development assignments have been closed; the live
queue and Active board are empty. This corrects the earlier premature completion claim
while preserving evidence of what was implemented outside the in-app review flow.

## Latest collaborator-setup corrections

Fresh isolated native Codex-only and Claude-only first-project flows now pass. Fixed long
installation paths exceeding the native socket limit and Claude-only projects selecting
Codex workers by default. Updated setup prompts and automatic manager instructions to match
current independent manager/worker choices. QUARK now groups turns by task. Focused backend
and five-profile browser checks pass, followed by the successful public CI run above.

## Latest owner-reported corrections

Home fills the browser width, shows a short grouped attention list and lets mobile allowance
scroll away. Computer no longer exposes recovery/accounting shortcuts. QUARK/resource chats
open full-screen; labelled Open notepad controls also serve shared chats, with separate tab
drafts and local recovery versions. Automatic resource reports stay in health history. Asked
resource conversations can use native diagnostic tools. The alien icon is installed across
the app, launcher, companion and public site. Focused browser checks plus actual saved-history
checks cover all five profiles; a real native diagnostic command passed. See VERIFICATION.md.

## Connected behavior

- Home shows remaining Codex/Claude allowance, editor status, computer pressure,
  project rates and durable human/general to-dos. Chats, Apps and QUARK are connected.
- Project managers have independent provider/model/reasoning choices, separate worker
  provider-mix and spending controls, current catalog choices and the corrected defaults.
  Spawn creates the project without model work, then opens a full-page saved brief.
  The same notepad is available from chat, with Minimize, versions and safe send retry.
- Phone conversations use compact headers, message bubbles and grouped expandable
  tool activity. Codex steering targets the observed running turn. Claude editor
  follow-ups use its acknowledged native queue. Companion 0.2.6 is installed here,
  and the live editor now reports Working with steering available after correcting stale list
  summaries. No editor reload was needed. Both paths
  passed real isolated native editor checks, preserving unsent desktop drafts.
  Existing Codex shared-server sessions now appear separately in Chats → Shared. A real
  native terminal passed first send, exact-turn guidance, stale-input refusal and Stop;
  disconnecting the observer retained the terminal and completed work. Older isolated
  terminals remain unsupported; simultaneous native/phone sends can join one reply.
- QUARK's conversation and status board share the existing scheduler, signed manager
  leases, account readings, resource limits, project caps and durable pauses. Its
  bounded automatic checks spend nothing while idle. Owner instructions and timing
  examples live outside project repositories. Managers can dispatch across providers.
- Managers retain internal/human work items, concise human requests, notes, checkpoints
  and decisions. Instructions require continuing independent work while awaiting input.
  Claude launches configure native 60% compaction and handoff hooks; Codex uses native
  compaction. One real Claude automatic compaction saved a handoff and summary, then
  continued and finished frontend work; this does not prove every detail is retained.
- Reviewed code is applied by its manager by default, with exact reviewed source/target
  validation. A project can require human review instead. Small reviews have two
  correction rounds, then a recorded manager disposition or human handoff.
- Computer health has a current snapshot, charts and grouped project/app activity. Historical
  evidence remains available to the assistant without a human history list. Ask Codex/Claude
  supports central defaults, explicit live
  model choices, retained diagnostic conversations and same-request recovery.
- Saved conversations, worker evidence and eligible native conversation copies support
  separate questions about completed work. Finished tasks and their reviews stay finished.
  New Misc chats have private folders; Codex terminal sessions stay outside the contact list.
  Explicit assisted search ranks a bounded saved-chat sample using the central bulk model;
  it discloses partial coverage and opens original chats without sending to them.
  Configure can pause other projects and later restore only the pauses it created.
- Welcome reuses native sign-in, supports either provider alone and starts new empty
  installs with Codex-only choices and pacing enabled. The Applications launcher, optional
  phone pairing, private source backups and update-agent handoff are connected.

## Current evidence and remaining acceptance

Focused phone/editor/resource checks pass at desktop, 412×915, 360×800, 915×412 and
iPhone WebKit. The real demo-API project/notepad journey passes desktop and portrait
phone profiles, including the corrected landscape configuration panel. These
tests include failure/retry and saved-data behavior, not just page rendering.

The newest backend was deployed with verified recovery copies and the existing phone
connection retained. Fresh-terminal opening now passes injected provider/PTY checks,
including no fabricated first message. Project priority/cap controls use existing QUARK
policy. A priority response lost after saving recovers through reload with the same receipt.

The public landing at sciencewithagents.com and combined SyllabusGraph export pass live
browser/route checks across all five profiles. Both domains respond, all six public datasets
retain their exact contents, and legacy links redirect correctly. The MIT repository is public
at [OscarBarreraGithub/sciencewithagents](https://github.com/OscarBarreraGithub/sciencewithagents).
A fresh public-source clone plus the now-published corrections passed dependency installation,
production builds, usage-reader and Mac launcher setup, and actual native Codex-only and
Claude-only first replies with separate app data. Another person completes their own account
sign-in and device steps. MIT is selected;
the public repository contains clean source history, without the old private Git history or
runtime files. The latest release check passed format, production builds, 772 backend checks,
88 companion checks and 435 browser cases. Thirteen backend/companion and ten browser cases
are deliberately skipped; physical device acceptance is not inferred from them.
No Guide/FAQ is published.

Native computer-use reached the real app in Safari and loaded the corrected layout.
Physical phone Home Screen/cellular/restart
journeys are distinct from browser fixtures. Do not claim those passed. Other people must
use their own accounts and complete their own device sign-ins.

Real native Codex and Claude checks pass broad reads, public HTTPS, role-appropriate scoped
writes and refused outside-folder writes without routine permission requests. Recovery copies
now use a separate read snapshot, with normal writes and retry receipts verified during copying.

Allowance attribution is an estimate without validated 2–3 percentage-point accuracy.
Cache expiry is estimated or unknown; refreshes cannot guarantee retention. Native tools
remain available under provider permissions. Scoped writes are not a promise to contain
arbitrary external MCP services or user overrides.

Continue from [Resume](RESUME.md). Dated evidence is in [Verification](VERIFICATION.md),
capabilities and limits in [Features](FEATURES.md), new-user setup in
[Contributor setup](CONTRIBUTOR_SETUP.md), and customized updates in [Update](UPDATE_APP.md).
