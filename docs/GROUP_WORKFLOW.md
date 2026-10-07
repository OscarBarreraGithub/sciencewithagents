# Groups in the normal app

Groups brings shared conversations and an evidence feed into the ordinary app.
Each person keeps their own installation, provider account and private conversation. Start at
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
2. In Groups, expand **Set up Groups with your agent**. The creator copies **Cloudflare
   setup prompt** into their external Codex or Claude setup agent. It deploys Groups in
   the creator's **own Cloudflare Workers Free account**, following the concrete
   [hosting runbook](GROUP_HOSTING.md). Human steps are sign-in, account/Free confirmation
   and the chosen HTTPS address. Fresh installations use no maintainer service or beta
   operator code. Existing saved Groups settings and memberships are preserved.
3. New/Join actions appear above setup help. The open Groups page detects completed configuration and collapses the setup prompt
   automatically. Choose **New project**, enter project and display names, then
   **Continue setup**. In the group header, choose **Invite people → Create invitation → Copy invitation**
   and send it privately. The same link can invite multiple people for 7 days. Each
   recipient joins directly with the link; no confirmation code or creator approval.
   New links open the service's `/join` page, which guides recipients into their own app.
   A creator's private localhost/phone address is not a group login. Older links can be
   pasted into **Join by invitation** in the recipient's configured app.
4. The member gives the **join setup prompt** and invitation to their setup agent. It
   configures the creator's service in private host files; members do not deploy another
   Worker or need Cloudflare for Groups. If setup outlasts the invitation, obtain a fresh
   link from the same creator. Choose **Join by invitation → Join group**. The group opens
   immediately, and the creator's member list updates automatically. Previously accepted
   pending requests become members when read by the updated service, provided their
   invitation was not revoked and its issuer remains active. Existing members stay joined
   when invitations expire. Updating an older installation requires both the app update
   and the creator's existing Worker redeployment, preserving configuration and memberships.
5. Group agents use the native agent installed on each person's own computer, with its
   existing provider sign-in, tools, skills, hooks and permissions. No Docker, Linux guest
   or separate provider account is required for local execution. Read **Manage →
   Local agent access**, then choose **Enable agents on this computer** once for your group
   membership. This makes no model call. The provider checks its existing sign-in when a
   request starts; use ordinary provider sign-in if needed. See [native owner
   setup](GROUP_NATIVE_OWNER_SETUP.md) for the supported setup and retained isolated mode.
6. On the creator's computer, choose **Manage → Shared feed agent → Use this
   computer for the shared feed**. Keep that computer running. Send a short human message
   from each installation and confirm both people can open the originals in the shared
   feed before calling messaging setup complete. Feed updates happen in background batches;
   native-agent readiness is a separate check.

Opening an invitation in an existing app tab opens Join with that invitation, including
from an already open group. The app removes the invitation from the address immediately;
its secret stays in memory until the authenticated join request receives it.

A lost network reply does not require creating another group or sending another join
request. Use **Recover an interrupted request** on the original installation; it reconciles the saved
request and identity after reload or restart. If the service is unavailable, leave the
request saved and retry when it returns. Do not change the service mapping to evade a pending
request. A setup agent must reconcile changed endpoints or installation identities explicitly.
Existing beta installations retain their original creation-code recovery controls. New
owner-hosted setup requires no operator code. Use the creator's invitation to join an
existing group; never copy their creation capability to a member host.

## Conversation and work

Groups opens a full-width **Shared chat**. Switch to **Shared feed** for the condensed record;
**Manage** opens group settings without shrinking the conversation. **Invite people** opens
the invitation controls directly. The invitation shows its actual expiry date.
Catch up uses the same reading surface, loads the unread page when opened and keeps detailed
evidence queries collapsed. Opening it does not mark anything read.

**Shared chat** contains messages you choose to send to the group. **Private to you** opens
your separate local conversation and draft. Each person requests their own enrolled local
agent; another participant's message does not authorize work on your computer.

The ordinary composer defaults to **Your agent** and **Ask**. Choose **Work** only to
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

**Manage** collects invitations, the feed writer and local agent access. The
separately configured mode also offers shared actions, Git and reports. Saved agent
receipts are collapsed separately; a request needing authorization opens its existing
controls.

Work records the exact shared instruction before native handoff. Questions, private
conversations and incoming group messages do not grant work authority. Cancellation and
retries stay bound to the original local request; they do not borrow a personal manager
or silently create a new instruction.

If a saved request needs local access enabled, its controls open automatically. Enable
access, then choose **Continue saved request** to authorize that exact request. **Cancel
saved request** targets the saved local request. A lost reply or restart retains its
identity; recovery inspects it instead of replaying tools. Agent availability does not
mean provider sign-in has been verified, and a provider failure leaves the request saved.

Shared and private chats use separate native conversations. Local execution is not
filesystem or credential isolation: the agent retains the computer's ordinary tools and
account access. Existing isolated contexts remain separate and retain their own sign-in
and acceptance controls; switching modes does not import their history or rebind a saved
request. The separate action board, protected shared Git and captured-report sharing
panels are unavailable in local mode; their saved records are retained. Native Ask and
Work keep the agent's ordinary tools. These optional panels remain available only with
their separately configured adapter.

## Private reading, files and Git

GitHub is optional for messaging. For shared code/files, copy the optional **GitHub setup
prompt** in Groups into your external setup agent. It helps sign in, choose the repository
and visibility, and invite collaborators through native Git/GitHub tools. It does not
enable the separate protected Git panel or automatically publish local files.

Private conversations, drafts, files and native history are not automatically published to
the shared feed. **What mattered
since last visit?** opens private catch-up without replacing your draft. It reads bounded
shared evidence and retains its exact acknowledged snapshot across reload; unknown facts
remain unknown. Notepad/draft conflicts require choosing a version rather than silently
replacing your text.

The protected shared Git, captured reports and confirmed-action board are not available
in local-agent v1. Their older records are retained. Native agents can still use their
ordinary Git, terminal and file tools; this does not automatically transfer files to
other members. [Status](STATUS.md#groups) records the current scope.

## Setup-agent boundary and limits

The creator's own Cloudflare service is configured by the external setup agent, following
[hosting](GROUP_HOSTING.md). Each installation generates its own membership bearer and
retains exact setup requests in private host storage. Invitations can carry routing-only
configuration for the setup agent, but cannot change browser-selected endpoints or overwrite
existing mappings. Creation credentials stay on the creator's computer. Private
`groups/service.json` uses a same-owner `0700` directory and `0600` files; symlinks and hard
links are refused. Redirects are refused. Existing pinned beta groups remain compatible.
See [delivery contracts and limits](GROUP_DELIVERY.md), [native owner setup](GROUP_NATIVE_OWNER_SETUP.md)
and [documents](GROUP_DOCUMENTS.md).

Storage is bounded beta storage. New work can be refused at capacity without deleting
originals or changing their retry identities. Membership has 64 active members; local setup
retains at most 32 enrollments. Feed originals are at most 1 MiB, and native requests allow
64 outstanding results within a 512 MiB logical journal envelope. Shared report transport
has a separate 32 MiB actual-plus-pending allowance inside the existing service storage
fence; a larger owner-local PDF can remain local. These application limits do not prove a
provider quota, physical disk guarantee or Free hosting entitlement.
