# Native Groups owner setup

Your setup agent registers the host resources; Groups never asks a browser to select
executables, filesystem paths, Docker commands or arbitrary native RPC methods.
Human Groups messages use the built-in beta service or an existing protected service
configuration, as described in [Group workflow](GROUP_WORKFLOW.md).

The current native route targets **Apple Silicon macOS with an existing Docker Desktop
Linux ARM64 Engine** and `/usr/local/bin/docker`. Other platforms are not qualified for
native Groups. The person starts Docker Desktop and makes its licence choice; the setup
agent must not install or reconfigure a runtime silently. Native agents run Linux tools;
macOS app control and browser-extension bridges are unavailable. Each isolated context
needs this person's own Codex or Claude subscription sign-in, even if their personal
host CLI is already signed in. Human group messages need none of this native setup.

## Resolve the local route

Work from the installed clone and its usual data directory. If the launcher uses an
explicit `DOCK_DATA_DIR`, use that same value for these CLI commands.

1. Use the final clean source checkout and build it through
   `sh scripts/pnpm build`. Record `git rev-parse HEAD` and obtain an independent review
   of that exact source before registering its `reviewedCommit`. A commit hash or passing
   fixture alone is not a review; never copy another installation's private receipts.
2. Run `sh scripts/pnpm dock list`. Use an existing local project, or register this clone
   with `sh scripts/pnpm dock add "$PWD" --name "Groups native host" --provider codex`
   (choose `claude` for Claude). Run `sh scripts/pnpm dock list` again and copy the project's
   UUID, not its manager UUID. Registration starts no model work. Keeping `workspace: null` below
   grants no project files to the guest; the local project supplies the existing policy
   and accounting context. No GitHub account or new personal work brief is required.
3. After source review and owner runtime startup, build only the public image context.
   This invokes the shipped recipe and inspects its resulting **local immutable image ID**
   through the same fixed Engine, without using the owner's Docker configuration:

   ```sh
   node --input-type=module <<'NODE'
   import { execFileSync } from 'node:child_process';
   import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
   import { join } from 'node:path';
   import {
     groupContainerBuildRecipe, groupEngineSockets,
   } from './apps/server/dist/group-container.js';
   const config = mkdtempSync(join(process.cwd(), 'data', 'group-native-build-'));
   chmodSync(config, 0o700);
   const socket = existsSync(groupEngineSockets[1])
     ? groupEngineSockets[1] : groupEngineSockets[0];
   const recipe = groupContainerBuildRecipe(config, socket);
   try {
     execFileSync(recipe.executable, recipe.args, {
       env: recipe.environment, stdio: 'inherit',
     });
     const image = execFileSync(recipe.executable, [
       '--host', `unix://${socket}`, '--config', config,
       'image', 'inspect', '--format', '{{.Id}}', recipe.tag,
     ], { env: recipe.environment, encoding: 'utf8' }).trim();
     if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Image ID missing');
     console.log(JSON.stringify({ image, sourceDigest: recipe.sourceDigest }, null, 2));
   } finally {
     rmSync(config, { recursive: true });
   }
   NODE
   ```

   Retain build provenance and resolved package versions locally as described in
   [native isolation](GROUP_ISOLATION.md#full-native-execution-route-and-owner-acceptance).
   Use the returned image ID below, never a mutable tag or a maintainer's private path.

4. Review the chosen provider's current official sign-in/service endpoint requirements
   and fill the exact DNS-name/port grants in `outbound`. This source does **not** ship a
   complete accepted provider host list. The three OpenAI hosts in the retained macOS
   authentication-only section of GROUP_ISOLATION are not full native acceptance. Do not
   guess, grant wildcard hosts or disable the network boundary; leave native readiness
   pending until the chosen provider's real sign-in and tool checks pass with the grants.
   Additional remote MCP, browser or Git destinations require their own explicit grants.

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
