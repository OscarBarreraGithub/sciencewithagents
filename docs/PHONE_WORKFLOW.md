# Phone workflow — behavior contract

Use this checklist when changing the phone UI so a redesign does not lose working behavior.
Actual runs belong in [Verification](VERIFICATION.md); person-only checks are in
[Phone acceptance](PHONE_ACCEPTANCE.md). This contract is not a passing-test report.

## The normal journey

1. In **Phone access**, copy the Cloudflare setup prompt into an external agent on the
   computer. The agent sets up a named tunnel and domain in that person's own Cloudflare
   account, following [the runbook](CLOUDFLARE_SETUP.md), and walks them through necessary
   sign-in, domain choices and pairing. The phone has no separate Cloudflare/GitHub sign-in;
   GitHub is not a phone prerequisite. The computer stays awake, online and running the app.
   Existing connections and approved devices are preserved. See [phone setup](PHONE_SETUP.md).
2. On the computer, **Phone access → Create a new code** opens one 15-minute invitation.
   The QR appears only while the connection and invitation are usable. Scanning opens
   **Name your phone** directly with one blank **Phone nickname** field. Manual fallback
   is **Enter pairing code → Continue → Name your phone**, with one input on each screen.
3. Enter a nickname, **Continue → Save passkey**, then confirm the matching number on the
   computer. This entire sequence shares the original deadline. Screen navigation alone
   makes no pairing request. Different/rejected codes return to code entry while preserving
   the nickname. Pairing then closes; a synced passkey alone cannot enroll another browser.
4. Computer confirmation opens **Add sciencewithagents to your device**, with
   iPhone/iPad, Android and laptop instructions. **Open my workspace** finishes setup and also
   works in the browser; it does not prove an icon was installed.
5. Later, Phone access keeps the installation guide available. Failed setup saves offer
   retry without resetting pairing. Setup completion survives reload and server restart.

## Pairing and continued access

There is no Lock app button, unlock screen,
repeat-verification setting, inactivity timeout or background lock. Initial passkey
registration and exact computer confirmation still approve each new browser. After that,
the server accepts only its random, 256-bit browser credential against a non-revoked device.
The credential is stored as a hash on the computer and in a Secure, HttpOnly, SameSite=Strict,
host-only cookie on the phone. Private APIs, images, event streams and terminals enforce this
check; knowing the public address or holding a synced passkey does not pair another browser.
Same-origin/host checks and HTTPS remain. These controls reduce unauthorized access; they
are not a guarantee against every attack. Physical access to an approved browser is outside
this app's protection. [Cookie controls](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)

**Remove device** on the computer revokes enrollment and closes private streams. A trust/origin
reset also revokes enrollment. **Turn off phone access** closes connections and pending pairing,
and blocks remote access while off; turning it back on lets approved browsers reconnect directly.
A restart, backgrounding, or temporary connection failure does not ask for another passkey.
Do not remove a working phone merely to repeat a completed setup check.

The existing browser credential and approved devices are preserved during upgrade, including
phones previously set to require a lock. Removed devices stay removed. Obsolete lock tables,
preferences and endpoints are removed; an old local lock flag has no effect. Reload an old
frontend once to get the new behavior. Setup completion records only the completed setup
screen and never authorizes an unapproved browser or starts a model turn.

The cookie requests a 400-day browser lifetime, renewed on visits; there is no server-side
inactivity expiry. Actual browser retention is not guaranteed. Lost browser storage, a removed
device, or a changed trusted origin may require deliberate re-pairing. Never automatically
create enrollment or copy credentials to repair it.

## App shortcuts on phones and laptops

A laptop can use the same paired workspace without installing a second server. In Safari on
Mac, use **Share → Add to Dock → Add**; the shortcut appears in the Dock and Applications.
In desktop Chrome, use **More → Cast, save and share → Install page as app → Install**.
The connected computer continues to run jobs. These steps also appear under **On a laptop
or desktop** in the device installation guide. Keeping the paired page bookmarked is sufficient.
[Safari instructions](https://support.apple.com/en-ca/104996),
[desktop Chrome instructions](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DDesktop&hl=en).

Pair in the browser **before** creating the icon. On iPhone, use Safari's Share menu
(under More in some layouts), **Add to Home Screen**, enable **Open as Web App** if offered,
then **Add**. [Apple's current instructions](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios)

On Android Chrome, use More → **Install and create shortcut → Install**, following the
device's prompts; labels vary by version. [Chrome's install guide](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=en)

WebKit documents copying cookies into a **new** iOS/iPadOS 17.2 home-screen web app, not
other local storage or later synchronization. An icon added before pairing may need adding
again from the paired browser; never assume a preexisting installation updates itself.
[WebKit's cookie-transfer boundary](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/#web-apps)
Verify the new icon opens the same paired workspace without another verification prompt. Do not
erase working browser data as a first repair. An installed icon does not add an offline
command queue, guarantee storage survival or make the host available while it is off.

## Notifications

**Settings → Notifications** is off until the owner presses **Turn on notifications on this
device** (the browser permission prompt only follows that button) and checks individual
projects. iPhone/iPad need iOS 16.4+ and the Home Screen app; Safari tabs cannot subscribe.
[WebKit's web push boundary](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

Only new attention items that stop work without the owner notify: pending approvals, tasks
needing a decision, and failed or interrupted runs. Ready-to-apply changes, backups, items
already present when notifications were enabled, stops caused by the owner's own chat action
(such as **Stop**) and blockers resolved within 45 seconds stay silent. So does an interrupted
run held by a typed QUARK pause cause (manager/owner, project schedule, budget cap) or an
allowance wait QUARK resumes itself; lost-acknowledgement holds, unheld interruptions and
failures still notify. Each project sends at most one combined message per 10 minutes; one
item notifies at most once per 6 hours. Messages name the project and kind of stop only. A tap
opens a new window on the entry computer (`?computer=entry`). That window keeps the entry
computer across reloads until a computer is chosen in it; other tabs, their drafts and the
saved computer selection are untouched. An invalid `vapid.json` keeps
notifications off and is never replaced automatically. The push ledger, keys and subscriptions stay in
`data/push/` (owner-only); delivery uses the browser's standard push service with VAPID.
A subscription belongs to the paired device or local owner that created it. Revoking a device
deletes its subscription; turning phone access off pauses delivery. Gone endpoints and
repeated failures are pruned. Notifications cover the entry computer's projects only.

## Preserve these behaviors in every redesign

- [ ] QR handoff removes its secret fragment before React/API startup; code remains in page
      memory only, never logs/local/session storage. No automatic form submission or live-QR
      screenshots. External scanner/browser history is not guaranteed erased.
- [ ] One-use/attempt-limited invitations, explicit passkey action, verified computer
      confirmation, cancellation/expiry, safe failure categories and uncertain-response
      reconciliation remain intact. No automatic resend of signed registration.
- [ ] Every private API, image, event stream and terminal upgrade requires an enrolled
      device and its valid browser credential; persistent pairing is not public access.
- [ ] Reload, backgrounding and restart preserve approved access and unsent drafts.
      Turning access off or removing a device closes its private streams; removal persists.
- [ ] Installation setup is prominent until completed, persisted per device and retryable.
      Finishing setup is optional to installation, and never a substitute for approval.
- [ ] The same projects, managers/workers, retained history, approvals, images and advanced
      native tools remain available; onboarding is not a replacement or limited phone app.
- [ ] Drafts stay separate across devices/hosts; copied sends retain receipts. Native input
      still needs explicit **Take control here**; reconnection never replays terminal bytes.
- [ ] **Computer** selection preserves host/account boundaries. Offline hosts offer a clear
      retry, not another account, automatic migration or hidden conversation replay.
- [ ] Restart preserves identities and visible evidence without automatic model turns or
      repeated uncertain actions. Network loss leaves recoverable drafts and honest status.
- [ ] Check desktop, 412×915, 360×800 and 915×412, plus actual phone keyboard, installation,
      cellular, returning access and restart. Fixtures do not certify physical behavior.

Use [Features](FEATURES.md) for the wider app contract and [Operations](OPERATIONS.md) for
recovery and the exact local/remote trust boundary. New authenticated sessions and new
paired devices are different operations; simplifying one must not silently open the other.
