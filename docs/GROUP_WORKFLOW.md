# Groups in the normal app

Groups brings a shared conversation, evidence feed and work board into the ordinary app.
Each person keeps their own installation, provider account and private asides. Start at
**Home → Groups**, including from an authenticated paired phone or laptop. The selected
computer must be awake, reachable and running the app.

This workflow is integrated into the normal app. [Status](STATUS.md#groups) separates
installed/local checks from the remaining hosting,
provider and two-computer acceptance work. The [development fixture](GROUP_DEVELOPMENT.md)
uses fake providers and is not a substitute for this setup.

## First setup

1. Install and open the app using the [setup prompt](../README.md#set-up). To use another
   computer from your phone or laptop, complete [owner pairing](PHONE_WORKFLOW.md) and select
   that computer first. Pairing gives owner access to that installation; a group invitation
   gives group membership instead.
2. Fresh installations use the built-in hosted beta service. The creator obtains one beta
   setup code from the operator; other members need only an invitation. Desktop Groups
   requires no Cloudflare account, Tailscale or private operator configuration. Existing
   protected service settings are preserved; ask the setup agent to reconcile a different
   service explicitly. Human messaging can work without native-agent configuration.
3. If you want group agents, have the setup agent register the reviewed isolated native
   route on each worker computer, using [native owner setup](GROUP_NATIVE_OWNER_SETUP.md).
   This includes the approved image, protected resources and provider network access.
   Groups does not ask you to enter paths, executables, credentials or shell commands.
4. In Groups, choose **New project**, enter the project and display names, then
   paste the **Beta setup code**, then **Continue setup**. The creator opens **Group controls → Invitations and approval → Create invitation**
   and sends the invitation privately to the intended person. Invitations expire after
   15 minutes. They carry scoped group admission, never the creation capability or a
   selectable service URL.
5. On the other installation, use **Join by invitation → Request to join**. Send the exact
   confirmation code privately to the creator. The creator selects the matching request,
   enters that code and chooses **Approve exact enrollment**. Matching display names alone
   do not prove identity. Reopen the group after approval.
6. On the creator's computer, choose **Group controls → Shared feed agent → Use this
   computer for the shared feed**. Keep that computer running. Send a short human message
   from each installation and confirm both people can open the originals in the shared
   feed before calling messaging setup complete. Feed updates happen in background batches;
   native-agent readiness is a separate check.

Opening an invitation in an existing app tab opens Join with that invitation, including
from an already open group. The app removes the invitation from the address immediately;
its secret stays in memory until the authenticated join request receives it.

A lost network reply does not require creating another group or sending another join
request. Use **Recover pending setup** on the original installation; it reconciles the saved
request and identity after reload or restart. If the service is unavailable, leave the
request saved and retry when it returns. Do not change the service mapping to evade a pending
request. A setup agent must reconcile changed endpoints or installation identities explicitly.
Creation codes have a creation deadline; established groups and memberships do not expire
with that deadline. An exact lost-acknowledgement create retry can recover the original
group after it. If the service confirms that an expired code never created a group or
that the code was already used by another installation, **Use a new setup code** starts
a fresh request and retains the old host receipt. To join an existing group, use its
invitation instead.

## Conversation and work

The ordinary composer defaults to **Group agent** and **Ask**. Choose **Work** only to
authorize shared work. Private agent requests always use Ask. **Send to** also offers an
explicit human group message or private note. Failed, unknown or blocked agent requests
retain their exact request ID, text, destination and intent across retry/reload, with no
fallback to a human message; newer typing stays separate.

Human-message Send retains what you send before delivery. **Retry delivery** uses the
same saved message after a lost reply; it does not create another message. Open an original
from the feed to read the exact retained text. Delivery status is separate from local saving.
The selected computer resumes pending summaries when it reconnects, even with its browser closed.
Longer summaries can need native setup and QUARK admission; originals remain retained while
summaries wait.

**Group controls** collects invitations, shared actions, Git, reports, the feed writer and
native setup in one expandable area. Saved agent receipts are collapsed separately; a
request needing authorization opens its existing setup controls.

Work records the exact
shared instruction before native handoff; questions, private asides and native replies do
not grant work authority. **Shared work and actions** shows verified tasks and owner controls.
Start, Stop and retries stay bound to the original task and worker; they do not borrow a
personal manager or silently create a new instruction.

A new isolated native context can require its own provider authorization. Expand **Native
agent setup** or **Authorize this saved agent request**, read the tool and credential
tradeoffs, then use **Sign in**. Codex offers native device authorization; Claude uses the
fixed isolated owner-login terminal. A paired owner can authorize their selected computer.
Existing personal credentials are not copied into the context. Check sign-in and choose
**Continue saved request** after consent. Preparation and sign-in make no model turn;
explicit native acceptance checks under **Advanced setup-agent checks** do use allowance.
Production readiness still requires the actual reviewed artifact and isolation checks.

**Retry sign-in** recovers a canceled/expired Codex challenge without losing the saved text;
retries are rate-limited, not a lifetime lockout. After an app restart, **Reconnect saved
request** is available only when the journal proves no native input was submitted and the
old owned runtime is stopped. It reopens the same account/state and requires explicit
continuation. If input may already have started, recovery inspects the original request
instead of replaying tools. See [native owner setup](GROUP_NATIVE_OWNER_SETUP.md) for details.

## Private reading, files and Git

Private asides, drafts and native history do not enter the shared feed. **What mattered
since last visit?** opens private catch-up without replacing your draft. It reads bounded
shared evidence and retains its exact acknowledged snapshot across reload; unknown facts
remain unknown. Notepad/draft conflicts require choosing a version rather than silently
replacing your text.

Reports open in the existing **Reading** and **Original PDF** interface, scoped to the group
and immutable version. They never fall back to your personal document library. A local
report stays local until its owner explicitly chooses **Share this report → Share selected
report files with group**. The other installation uses **Group controls → Shared reports → Load shared
reports**, then opens a chosen report. Listing loads metadata; selected source/assets or PDF
bytes transfer on demand. Removing a grant or enrollment refuses future authenticated reads;
a recipient's already downloaded copy cannot be recalled. Native report capture/compilation
and cross-installation sharing must be configured and accepted separately.

**Shared Git workspace** shows a protected, setup-agent-configured repository and saved
branch. Visibility defaults to private: choose metadata only or explicitly selected content
files before sharing them. Edit intentions and working-tree warnings help people avoid
collisions; they are not a file lock. Reviewed proposals and separate main/task views are
explicit controls, not an automatic merge or account switch. A pending Git change retains
its exact retry until acknowledged; an uncertain network failure does not authorize a new
operation. Missing repository configuration shows a setup-agent notice.

## Setup-agent boundary and limits

The built-in beta service pins its public identity, HTTPS origin and verification keys in
source. Setup codes and invitations cannot change them. Each installation generates its
own membership bearer and retains exact setup requests in private host storage. The
creation capability is excluded from invitations and browser storage. Existing optional
`groups/service.json` configuration remains authoritative, with a same-owner `0700`
directory and `0600` files; symlinks and hard links are refused. Redirects are refused. See
[hosting](GROUP_HOSTING.md), [delivery contracts and limits](GROUP_DELIVERY.md),
[native isolation](GROUP_ISOLATION.md) and [documents](GROUP_DOCUMENTS.md).

Storage is bounded beta storage. New work can be refused at capacity without deleting
originals or changing their retry identities. Membership has 64 active members; local setup
retains at most 32 enrollments. Feed originals are at most 1 MiB, and native requests allow
64 outstanding results within a 512 MiB logical journal envelope. Shared report transport
has a separate 32 MiB actual-plus-pending allowance inside the existing service storage
fence; a larger owner-local PDF can remain local. These application limits do not prove a
provider quota, physical disk guarantee or Free hosting entitlement.
