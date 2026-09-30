# Phone workflow — behavior contract

Use this checklist when changing the phone UI so a redesign does not lose working behavior.
Current owner observation, 2026-09-14: **physical Safari enrollment succeeded**. That is not
acceptance of Home Screen installation, cellular use, restart or the new lock preferences.
Actual runs belong in [Verification](VERIFICATION.md); person-only checks are in
[Phone acceptance](PHONE_ACCEPTANCE.md). This contract is not a passing-test report.

## The normal journey

1. Choose a connection in **Phone access**: a private Tailscale address without a domain,
   or an agent-configured domain. The computer stays awake, online and running the app.
   Local-only use needs neither. Phone use does not require GitHub/Cloudflare sign-in;
   the Tailscale route needs Tailscale connected on both devices. See [phone setup](PHONE_SETUP.md).
2. On the computer, **Phone access → Create a new code** opens one 15-minute invitation.
   The QR appears only while the connection and invitation are usable. Scanning opens
   **Name your phone** directly with one blank **Phone nickname** field. Manual fallback
   is **Enter pairing code → Continue → Name your phone**, with one input on each screen.
3. Enter a nickname, **Continue → Save passkey**, then confirm the matching number on the
   computer. This entire sequence shares the original deadline. Screen navigation alone
   makes no pairing request. Different/rejected codes return to code entry while preserving
   the nickname. Pairing then closes; a synced passkey alone cannot enroll another browser.
4. After successful unlock, **Make this phone yours** offers **Ask for Face ID or screen
   lock** (default) or **Stay signed in**. Initial passkey creation and computer confirmation
   remain mandatory in either mode. These choices affect this paired device, not every phone.
5. **Continue** opens **Add Agent Dock to your Home Screen**, with iPhone/iPad and Android
   instructions. **Open my workspace** finishes setup and also works in the browser:
   installation is optional, and this button is not proof an icon was installed.
6. Later, **Phone access → App lock → Save lock preference** changes the same choice.
   The Home Screen guide remains available. Failed saves offer retry without resetting
   pairing; setup completion and the chosen preference survive reload and server restart.

## Pairing, sessions and setup are different state

| State                  | Stored meaning                                                              | Expiry or reset                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Approved enrollment    | This browser/device may authenticate with its registered passkey.           | No automatic server expiry. Explicit removal or a trust/origin reset revokes it.                                |
| `requireUnlock`        | Per-device repeat-lock preference; default `true`, including older records. | Persists until an authenticated change; not a way around initial pairing.                                       |
| `setupComplete`        | The person completed the app's setup screens.                               | Server-persisted; not an installation detector or a physical-acceptance receipt.                                |
| Default unlock session | A verified passkey permits private access briefly.                          | At most 15 minutes; backgrounding locks the view, with best-effort server lock and expiry backstop.             |
| Remembered session     | **Stay signed in** retains access after an initial verified unlock.         | No automatic server expiry; explicit lock/off/removal invalidates it. Browser cookie retention remains limited. |

Only an authenticated active session may save preferences or finish setup. Locked or
unpaired requests cannot do so. Restoring an existing enrollment must not silently enable
remembered access. Returning to the default lock must not leave older remembered sessions
valid indefinitely. Neither setup completion nor preference changes start a model turn.

**Stay signed in** trusts anyone who can use this enrolled browser profile to access the
workspace; it is a convenience/security choice, not an extra phone-level app lock. Keep the
phone's own screen lock enabled. Agent Dock cannot promise a particular biometric method:
the phone controls Face ID, fingerprint and screen-lock fallback.

**Lock app** and **Turn off phone access** invalidate active/remembered sessions, not approved
enrollment or the saved preference. The next connection requires a passkey even when
**Stay signed in** was selected. **Remove device** revokes enrollment and private streams;
do not remove a working phone just to repeat a completed setup check.

Server revocation requires reaching the computer. If **Lock app** is pressed offline,
hide the workspace immediately and explain that the server session may still be active.
A deny-only local flag preserves this manual lock across reload; it is not a credential
or access grant. Retry revocation on return/reload/**Check connection** and never reopen
automatically: successful passkey verification plus fresh status is required. Other browser/
Home Screen contexts are revoked only when the server confirms. If local storage is
unavailable, warn that this local intent may not survive closing the page.

Enrollment and remembered-session cookies request a 400-day browser lifetime and are
renewed on visits. That is not a 400-day server enrollment timeout or a promise of permanent
storage. Chrome documents that cookies can be renewed but may disappear before their
requested expiry. [Chrome cookie lifetime](https://developer.chrome.com/blog/cookie-max-age-expires/)

If only a session is gone, unlock again; if enrollment storage is lost, the device is removed,
the phone/browser is replaced or the trusted origin changes, deliberate re-pairing may be
needed. Never automatically create new enrollment or copy credentials to repair it. Browser
data deletion/eviction and cookie limits are outside the app's permanence guarantee.

## Home Screen installation

Pair in the browser **before** creating the icon. On iPhone, use Safari's Share menu
(under More in some layouts), **Add to Home Screen**, enable **Open as Web App** if offered,
then **Add**. [Apple's current instructions](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios)

On Android Chrome, use More → **Install and create shortcut → Install**, following the
device's prompts; labels vary by version. [Chrome's install guide](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=en)

WebKit documents copying cookies into a **new** iOS/iPadOS 17.2 home-screen web app, not
other local storage or later synchronization. An icon added before pairing may need adding
again from the paired browser; never assume a preexisting installation updates itself.
[WebKit's cookie-transfer boundary](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/#web-apps)
Verify the new icon opens the same paired workspace using its chosen lock mode. Do not
erase working browser data as a first repair. An installed icon does not add an offline
command queue, guarantee storage survival or make the host available while it is off.

## Preserve these behaviors in every redesign

- [ ] QR handoff removes its secret fragment before React/API startup; code remains in page
      memory only, never logs/local/session storage. No automatic form submission or live-QR
      screenshots. External scanner/browser history is not guaranteed erased.
- [ ] One-use/attempt-limited invitations, explicit passkey action, verified computer
      confirmation, cancellation/expiry, safe failure categories and uncertain-response
      reconciliation remain intact. No automatic resend of signed registration.
- [ ] Every private API, image, event stream and terminal upgrade requires an enrolled
      device and valid current session; remembered access is not public access.
- [ ] Default and remembered modes survive reload/restart as documented. Confirmed lock/off,
      preference tightening and device removal stop access in other tabs; offline local lock
      warns honestly and keeps its own view sealed until verified recovery.
- [ ] Setup is prominent until completed, persisted per device, retryable, and never a
      requirement to install an icon. App lock and installation help remain discoverable.
- [ ] The same projects, managers/workers, retained history, approvals, images and advanced
      native tools remain available; onboarding is not a replacement or limited phone app.
- [ ] Drafts stay separate across devices/hosts; copied sends retain receipts. Native input
      still needs explicit **Take control here**; reconnection never replays terminal bytes.
- [ ] **Computer** selection preserves host/account boundaries. Offline hosts offer a clear
      retry, not another account, automatic migration or hidden conversation replay.
- [ ] Restart preserves identities and visible evidence without automatic model turns or
      repeated uncertain actions. Network loss leaves recoverable drafts and honest status.
- [ ] Check desktop, 412×915, 360×800 and 915×412, plus actual phone keyboard, installation,
      cellular, both lock modes and restart. Fixtures do not certify physical behavior.

Use [Features](FEATURES.md) for the wider app contract and [Operations](OPERATIONS.md) for
recovery and the exact local/remote trust boundary. New authenticated sessions and new
paired devices are different operations; simplifying one must not silently open the other.
