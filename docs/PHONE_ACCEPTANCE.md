# Phone acceptance — real-device checklist

Purpose: finish the deployed workflow, not repeat fixture testing. Keep device names,
authentication results and any diagnostics private. Never record credentials or pairing
codes here. Read [PHONE_WORKFLOW.md](PHONE_WORKFLOW.md) for the behavior contract,
CLOUDFLARE_SETUP.md for setup/recovery and STATUS.md for actual evidence.

Do not remove a working enrollment merely to repeat acceptance. Record each actual device
result privately; browser emulation does not certify physical retention or connectivity.

## Owner journey

1. **New phone or intentional re-pair only:** on the computer, open sciencewithagents →
   **Phone access**. Wait for the connection-ready
   message after the setup agent has verified and activated paired mode. Choose
   **Create a new code** to show the QR, address and instructions; they are hidden while
   pairing is closed. Scan the QR and open it in Safari on iPhone or Chrome on Android.
   **Scanning must open Name your phone directly**, with only a blank **Phone nickname**
   field: no code field or autofill notice. Do not type a code to make this scan check pass.
   The temporary code fragment should disappear from the address without submitting the
   form. If scanning is unavailable, opening the bare address and entering the code is
   a separate fallback, not evidence that scanning worked.
2. Type a nickname you will recognize on the computer, choose **Continue**, then
   **Save passkey**. Confirm the matching number on the computer.
   New codes allow 15 minutes for this whole sequence, including computer confirmation.
   There is no phone Cloudflare/GitHub login or app password. Scanning alone cannot pair.
   Pairing must then close; an unapproved browser must not see private data.
   While the phone saves its passkey, the computer should say to continue on the phone,
   not suggest another code. If the phone requests a fresh start, cancel pairing on the
   computer first. The QR disappears during that wait and computer confirmation.
3. After computer confirmation, verify **Add sciencewithagents to your Home Screen** appears
   directly, without an unlock or lock preference screen. Follow the guide after pairing;
   **Open my workspace** must also work without installing. Reload and verify setup stays
   complete and the workspace opens directly. Open a newly installed icon and verify the
   same enrolled browser is recognized. An icon installed before pairing may need adding
   again. Keep the working icon/browser until the replacement connects; do not clear data.
4. Confirm the same project and existing conversation are visible. Send a harmless message
   to the manager from the phone and see that exact message/reply on the computer. Do not
   start implementation solely to test connectivity.
5. Background and reopen the app; no Face ID or app-unlock prompt should appear. Keep an
   unsent draft and confirm it remains on return. The Home header and Phone access must not
   contain Lock app or repeat-verification settings. Record physical storage compatibility
   failures separately; browser emulation does not prove this device's retention behavior.
6. Switch the phone to cellular, close/reopen it, and confirm history returns without
   resending messages. Check team/child history and native terminal. After a terminal
   disconnect, **Reconnect terminal** restores its view; **Take control here** deliberately
   transfers input from the other device. Check the phone keyboard and orientation. Pinch
   in slightly with the chat keyboard open, dismiss it and swipe back: the app must fill
   the screen without reopening.
7. Once work is idle, have the setup agent restart only sciencewithagents. Confirm the same
   conversation and enrollment return. Inspect interrupted work before resuming; neither
   command input nor approvals should replay automatically.
8. Turn phone access off and back on from the computer: active connections stop and private
   access is denied while off. Approved phones reconnect directly when it returns. When the
   owner is ready for a removal test, use **Remove device** while its view is open; access
   must stop and fresh pairing must be required. Otherwise leave real removal unverified
   rather than revoking a working phone. A synced passkey alone cannot enroll a new browser.

Manual fallback: open the bare address to **Enter pairing code**, which shows only
**Connection code**. Enter it and choose **Continue** to reach **Name your phone**.
That first Continue only changes screens; server verification waits until the nickname
screen's Continue. **Use a different code** returns to the code screen without losing
the nickname. A server-rejected code also returns there; changing screens does not open
enrollment, start passkey creation or submit another request automatically.

WebKit documents copying cookies when **creating a new home-screen web app** in iOS/iPadOS
17.2, with no later browser/app data sharing and no copying of other local storage. That
supports pairing before installation; it does not update an already-installed app or prove
this phone's result. Verify the actual OS/browser, new installation and returning access separately.
See [WebKit's login-cookie explanation](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/#web-apps).

## Agent responsibilities

- Verify QR-to-nickname navigation separately from manual entry, and never record a live QR, pairing
  link or code in screenshots, logs or committed evidence. The app scrubs the fragment
  before React/API startup and keeps the handoff only in page memory, not local/session
  storage. It must not submit registration merely because the QR was opened. Browser or
  scanner history outside the app is not guaranteed erased; treat the QR as a temporary secret.
- Record successful Safari enrollment as completed, without extending it to installation,
  cellular, restart or returning access. A server-persisted setup flag means the app's
  setup screens were completed, not that the browser installed or retained an icon.
- If saving a passkey fails before submission, use the page's explicit retry while its
  prepared request is still valid; the accepted code need not be typed again. For expired,
  reloaded or uncertain-submission state, inspect status before creating a fresh code.
  Record only the safe displayed error category and the person's browser/app context,
  never cookies, credential responses, pairing codes or raw diagnostic payloads.
- Keep original Codex permissions and exact integration confirmation unchanged. Existing
  local evidence proves the approval adapter; never fabricate a pending approval just to
  claim a real-phone approval check. Record that check separately when actual work needs it.
- If an Access login appears, stop and inspect the scoped migration/read-back; this is
  still the legacy flow, not a reason to ask for phone account authentication. Never copy
  authentication cookies or impersonate physical verification. Use the tested app-owned
  boundary and controlled migration in CLOUDFLARE_SETUP.md, not an ad hoc gate removal.
- Preserve the owner database before initial activation. Keep one app/tunnel, no idle test
  browsers, no unrelated process kills. The Mac must be awake and online; no physical reboot
  or power-setting change is authorized merely by this checklist.
- For normal use, open the installed sciencewithagents app; it owns its server and tunnel. After
  power-on and login, reopen it manually. Streamlined login-item setup remains deferred;
  enable the optional login service only if the owner explicitly chooses it. Do not leave
  a developer preview or install a second cloudflared daemon. Stop temporary acceptance processes
  when the active check ends. See OPERATIONS.md for the development process-ownership rule.
- Mark completion only from the observed steps. Desktop viewports, fake WebSocket routes,
  connector readiness and CI do not replace physical-device evidence. Keep any remaining
  platform-specific limits explicit rather than claiming all iOS/Android combinations.
