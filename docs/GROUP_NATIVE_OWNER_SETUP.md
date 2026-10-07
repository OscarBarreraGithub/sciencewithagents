# Native Groups owner setup

Your setup agent registers the host resources; Groups never asks a browser to select
executables, filesystem paths, Docker commands or arbitrary native RPC methods.
Human Groups messages require the separate protected service configuration described in
[Group workflow](GROUP_WORKFLOW.md).

On the owning installation, prepare a same-owner `0600` JSON file with no credentials:

```json
{
  "reviewedCommit": "<exact independently reviewed 40-character source commit>",
  "route": {
    "projectId": "<registered project UUID>",
    "provider": "codex",
    "image": "sha256:<current exact approved Linux image digest>",
    "resources": {
      "workspace": null,
      "stateBase": "/absolute/private/native-state",
      "readResources": [],
      "forbiddenPaths": ["/absolute/owner/home", "/absolute/app/private/data"],
      "outbound": [{ "host": "<reviewed exact provider host>", "ports": [443] }]
    }
  }
}
```

Use the complete reviewed provider outbound list and the **final composed** image/host
source, not an earlier image or a guessed host list. Follow [native isolation](GROUP_ISOLATION.md)
for resource and network review. Register through
`pnpm dock group-native configure /absolute/private/native-route.json`, then reopen the
app at a safe idle checkpoint. This command saves private configuration only; it does
not install Docker, start a guest, log in, purchase credits or run a model.

In normal Groups, create/join and open a saved shared or private context. Expand **Native
agent setup**, read the Linux/native-tool and separate-credential explanation, and consent
before sign-in. Your setup agent can prepare the isolated context through the typed owner
API or **Advanced setup-agent checks**. Authenticated paired owners can perform the same
workflow on their selected computer. Codex uses native device authorization; Claude opens
only the host-selected isolated subscription-login terminal. Codes and terminal output
never enter group messages or native-owner receipt logs. Check sign-in after completing it.

First artifact acceptance stays under **Advanced setup-agent checks** and uses real provider
work: **Check native tools (uses allowance)**, then
one detached-descendant stop check. Use another fresh shared/private context for the other
stop check, then **Finish verified setup**. Both actual stop receipts, native
tool/sandbox receipts and the host-pinned independent source review are required. Test
fixtures and this UI cannot set an arbitrary ready flag. Ordinary successful sign-in needs
no acknowledgment model turn or developer-check choices.

An expired, declined or lost Codex device challenge can use **Retry sign-in** explicitly
in the same admitted, unsubmitted context and saved request. At most three retries are
allowed within one minute; after the cooldown, **Check sign-in** offers retry again. All
attempt identities remain retained, so expired codes do not create a lifetime lockout. The old
challenge must be canceled or confirmed absent by the native protocol before another is
started; account/policy checks run again. No model input is replayed. Transient codes are
recovered only from memory, never receipt logs. Claude reconnects its original owned login
terminal. It has no supported equivalent device-challenge cancellation API here; an ended
or uncertain native runtime requires stopped-runtime reconciliation, not a guessed login
or model replay. The saved group/request remains intact. Actual native-client loss,
unverified cancellation or already submitted input fails closed with that uncertainty.

After an app restart, **Reconnect saved request** is available only when the immutable
native journal proves that this pending-consent request never reached input submission.
It re-admits the same context through QUARK, verifies every old owned namespace stopped,
and reopens the same private state volume and provider account. It makes no model call or
new sign-in. Check sign-in, then explicitly continue the same saved request. Original text,
request IDs and earlier receipts remain retained. Any recorded write intent or actual turn
keeps the existing read-only reconciliation path; uncertainty never authorizes replay.
Declined requests cannot reconnect. First artifact acceptance without a durable request
proof still requires setup-agent reconciliation if its runtime is lost.

After readiness, **Ask group agent** retains its exact request. A new context may require
its own authorization. Its saved-request panel checks that context's sign-in and offers
**Continue saved request**. Reconnect/recover retrieves the original result;
retry does not submit another tool turn. **Decline and stop** affects only that owned
context. Shared and private contexts keep separate native identities and credentials.

Provider sign-in, real native acceptance and physical-device delivery must be verified
on the installation; focused mock tests establish controller behavior, not acceptance.
