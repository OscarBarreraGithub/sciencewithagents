# Next owner check-in

Only the steps below need the person or another physical device. They do not block
independent implementation. Never put passwords, pairing codes, cookies or tokens here.

## VS Code companion

The owner confirmed both Codex and Claude sharing work. The central web chat needs only a
page refresh, not new pairing. Companion **0.2.6 is installed** and includes exact-turn Codex
steering, acknowledged Claude queued follow-ups, **Stop reply**, compatible update detection
and message-first bounded history with grouped tools. Separate editor authentication has been removed at the owner’s request. One
intentional **Reload window** activates a newly installed companion when native work is safe;
never reload the active editor automatically. Sharing uses the renamed **sciencewithagents** menu.
Native account login and advanced controls remain in the original provider extension.
The owner’s reported long-chat freeze now has a deployed paging/rendering fix, verified with
actual-history replay on mobile/WebKit. Refresh the existing phone page for device acceptance;
no new pairing or interruption of the current editor is required.

Automatic VS Code crash recovery is explicitly not required. Reopen the editor and original
chat, then share again if necessary; native Agent Dock recovery is a separate contract.
Marketplace publication still needs the owner's review/release decision,
public source/license/support choices and publisher confirmation. It has not been published.

## Phone

The real hostname now uses app-owned pairing without phone-side Cloudflare/GitHub login.
**Safari enrollment succeeded:** the owner confirmed connection on 2026-09-14. Keep that
enrollment; there is no need for a new code or another initial Save passkey. Next, on the
already-paired phone:

1. Unlock if asked. In **Make this phone yours**, keep **Ask for Face ID or screen lock**
   or choose **Stay signed in**, then **Continue** to the Home Screen guide.
2. Follow the installation instructions if wanted. **Open my workspace** also works in
   the browser and saves setup completion; it does not verify installation. Open the icon
   separately to check it retains enrollment and follows your selected lock preference.
   An icon added before pairing may need adding again from the paired browser; confirm
   the new icon does not ask to enroll again. Do not clear paired browser data.
3. Test both choices under **Phone access → App lock**. **Stay signed in** skips repeat
   prompts, but **Lock app** or turning phone access off must still require a passkey next
   time. Neither unpairs the phone. Confirm the saved choice/setup survive reload.
4. Check cellular reconnection, separate drafts and native **Take control here**. Restart
   the idle computer app and confirm enrollment, preferences and conversations remain.
   Real device-removal acceptance can wait until you are ready to revoke and re-pair it.

The agent handles its app and connector; only the person can complete the actual phone's
passkey/Face ID/screen-lock prompts. Follow PHONE_ACCEPTANCE.md. Browser WebAuthn tests and
live locked-endpoint checks do not establish these remaining physical outcomes. Home-screen
cookie transfer and durable browser storage have limits; see [the phone workflow](PHONE_WORKFLOW.md)
and PHONE_ACCEPTANCE.md. The initial paired passkey remains needed even if repeat prompts
are disabled; explicit removal, lost enrollment storage or a trust/origin reset need recovery.

## Other computers

Identify the intended school/family computers and the Codex account on each. Complete any
local account sign-in or operating-system permission required there. A setup agent follows
MULTI_COMPUTER_SETUP.md and does the remaining scoped connection work.

No suitable school/family Agent Dock SSH targets are configured on this Mac yet. Existing
unrelated SSH aliases are not authority to access those systems. Do not copy credentials,
Codex homes or runtime databases across accounts. Each machine needs to be on, logged in,
running the app and privately reachable.

## Intentional later choices

- Central model routing and the requested tiers/presets are implemented. Use **Models and
  roles** for preference changes; no new policy decision is needed to continue the build.
  New managed Codex/Claude contexts inherit native capabilities, while saved explicit
  restrictions remain. See MODEL_POLICY.md and MANAGED_CLAUDE.md.
- The owner authorized a new public sciencewithagents repository under OscarBarreraGithub
  and the website migration, and selected the MIT licence. The suggested VS Code
  publisher is oscarphysics; marketplace publication may follow once ready.
- Streamlined login-item setup is explicitly deferred by the owner. Manual app launch is
  the required restart workflow; no pre-login daemon.
- Assistant visibility is per-computer, with no project shared by default. Cross-account
  memory/routing would need a separate, explicit sharing choice; switching the UI does not
  grant that sharing.
- Distributed job migration/placement and a packaged installer remain later scope, not
  hidden requirements for the local queue or the local Mac launcher.

## No repeated approvals or sign-in repair

Git writes/push, Cloudflare operations and isolated browser checks work in the current
full-access environment. The September 9 restrictions are historical; do not repeat OAuth,
node_repl repairs or blanket approval requests. Earlier incident evidence remains in Git,
VERIFICATION.md and ORCHESTRATOR_TROUBLESHOOTING.md.

Stop owned temporary development checks afterwards. Keep the normal app/connector running
when the owner has requested pairing or normal use; do not stop them as test cleanup.
The login service remains opt-in. STATUS.md and RESUME.md record current verification and
the continuation point.
