# Groups in the normal app

Groups lives inside the ordinary Chats list. Each person keeps their own installation
and provider account. Start at **Chats → Groups**, including from an authenticated paired phone or laptop. The selected
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
2. In **Chats → Groups**, open **Setup** and choose creating, joining or shared files. The creator copies **Cloudflare
   setup prompt** into their external Codex or Claude setup agent. It deploys Groups in
   the creator's **own Cloudflare Workers Free account**, following the concrete
   [hosting runbook](GROUP_HOSTING.md). Human steps are sign-in, account/Free confirmation
   and the chosen HTTPS address. Fresh installations use no maintainer service or beta
   operator code. The setup agent first inspects saved hosting and pending bundles.
   An existing creator uses the preserved upgrade candidate; a matching member mapping
   is reused. Phone access is optional. Existing Groups settings and memberships are preserved.
3. **New group** and **Join group** stay visible beside the list. Setup instructions open
   separately and the list detects completed configuration automatically. Choose **New group**,
   enter project and display names, then **Create group**. In the group header, choose **Invite people → Create invitation → Copy invitation**
   and send it privately. The same link can invite multiple people for 7 days. Each
   recipient joins directly with the link; no confirmation code or creator approval.
   New links open the service's `/join` page, which guides recipients into their own app.
   A creator's private localhost/phone address is not a group login. Older links can be
   pasted into **Join group** in the recipient's configured app.
4. The member gives the **join setup prompt** and invitation to their setup agent. It
   configures the creator's service in private host files; members do not deploy another
   Worker or need Cloudflare for Groups. One installation can retain Groups from several
   creators; each imported service keeps its own route. Joining first does not grant creator
   permission or prevent later setup of your own service. If setup outlasts the invitation, obtain a fresh
   link from the same creator. Choose **Join group**. The group opens
   immediately, and the creator's member list updates automatically. Previously accepted
   pending requests become members when read by the updated service, provided their
   invitation was not revoked and its issuer remains active. Existing members stay joined
   when invitations expire. Updating an older installation requires both the app update
   and the creator's existing Worker redeployment, preserving configuration and memberships.
5. Group agents use the native agent installed on each person's own computer, with its
   existing provider sign-in, tools, skills, hooks and permissions. No Docker, Linux guest
   or separate provider account is required for local execution. Read **Manage →
   My agent on this computer**, then choose **Enable agents on this computer** once for your group
   membership. This makes no model call. The provider checks its existing sign-in when a
   request starts; use ordinary provider sign-in if needed. See [native owner
   setup](GROUP_NATIVE_OWNER_SETUP.md) for the supported setup and retained isolated mode.
6. Send a short human message from each installation and confirm both people can read it
   in **Group chat**. Shared messages and completed agent replies
   publish directly; selecting a feed-summary computer is not required. The visible feed
   checks for new arrivals automatically. Native-agent readiness is a separate check.

Opening an invitation in an existing app tab opens Join with that invitation, including
from an already open group. The app removes the invitation from the address immediately;
its secret stays in memory until the authenticated join request receives it.

A lost network reply does not require creating another group or sending another join
request. Open **Setup → Recover an interrupted request** on the original installation; it reconciles the saved
request and identity after reload or restart. If the service is unavailable, leave the
request saved and retry when it returns. Do not change the service mapping to evade a pending
request. A setup agent must reconcile changed endpoints or installation identities explicitly.
Existing beta installations retain their original creation-code recovery controls. New
owner-hosted setup requires no operator code. Use the creator's invitation to join an
existing group; never copy their creation capability to a member host.

## Conversation and work

The Groups filter lists your shared chats in the normal Chats frame. Desktop keeps the list
beside the selected group; phones show the list or the selected conversation. Old Groups links
still open the corresponding chat. Back returns to the list, not another conversation.

Each group has two tabs:

- **Group chat** shows everyone's shared messages as ordinary chat bubbles. Sending here posts
  a human message without invoking a model.
- **My group agent** shows your agent's shared working conversation. **Ask** requests a read-only
  reply; **Work** authorizes shared work. Other members' incoming messages do not authorize
  work on your computer.

Opening or reloading a group, reading shared reports and receiving another member's messages
do not request a model turn. Data transport and report reading do not call a model. **Ask** and **Work**
request your agent and use your provider allowance, including an Ask for a read-only answer.

Both tabs use the shared context. The current draft and exact retry identity remain retained
when switching tabs. Saved private conversations and drafts stay private; this view neither
opens nor publishes them. Failed requests retain their exact ID, text, destination and intent
across retry/reload, even after changing tabs.

**Invite** opens sharing controls, and **Manage (⋯)** opens settings without displacing the
conversation. The invitation shows its actual expiry date.

Human-message Send retains what you send before delivery. **Retry delivery** uses the
same saved message after a lost reply; it does not create another message. Group chat reads the verified retained originals. Delivery status is separate from local saving.
Shared originals use the durable delivery queue independently of optional summaries.
Read-only refresh pauses while the page is hidden and checks immediately when you return.
Updated group services send small change notifications through each member's protected
computer connection. Visible chats refresh on a notification and reconcile every five
minutes; unfinished local deliveries still check every five seconds. An older or disconnected
service falls back to minute idle checks, brief five-second active checks and five-minute
roster checks. Notifications carry no chat text and never authorize work. These reductions
do not establish that a busy group fits its creator's daily Free allowance.
A summary, provider limit or offline summary computer cannot hold up a saved chat reply.
After native access is enabled on a member's computer, its new already-shared messages
and replies receive background summaries and labels using that provider's saved **Bulk**
model. Nearby messages share one bounded turn; opening a chat starts no summary turn.
Each computer handles only its own shared originals. Private chats and local history are
excluded, originals remain readable, and a failed/uncertain summary is never replayed.
These background summaries use the contributing member's provider allowance, including
summaries of their own human messages. Reading another member's originals or summaries
does not run a summary on your account; already authorized local work may still finish.
The older selected-writer workflow remains separate for retained activity; selecting it
does not take over these per-member summaries. Long originals and full summary storage
remain original-only. See [summary limits](GROUP_PROMOTION.md#per-member-local-feed-summaries).

The visible **Contribute / Read-only** selector controls this computer’s saved participation.
Read-only keeps drafts, messages, reports and model-free Git sync available while blocking new
contributions and unstarted group model handoffs. Already running work may finish. Returning
to Contribute may release previously authorized queued work using your allowance; it does not
enable agents or replay uncertain turns. Interrupted changes keep an exact explicit retry.
See [local settings](GROUP_LOCAL_SETTINGS.md).

**Manage** keeps invitations and **My agent on this computer** easy to reach. **Advanced**
contains **Git sync and reviewed changes**, **Review proposed shared actions**,
**Browse earlier shared reports**, creator backups and the retained older summary-computer
workflow. Advanced tools load on first opening and stay mounted when collapsed, preserving
unfinished fields. Review an exact shared proposal there, including a competing override;
work stays on its original owner’s computer and account. Saved agent receipts remain under
**Message details**. A request needing authorization opens its exact contextual controls.

Work records the exact shared instruction before native handoff. Questions, private
conversations and incoming group messages do not grant work authority. Cancellation and
retries stay bound to the original local request; they do not borrow a personal manager
or silently create a new instruction.

If a saved request needs local access enabled, its controls open automatically. Enable
access, then choose **Continue this request** to authorize that exact request.
**Cancel this request** targets the saved local request. A lost reply or restart retains its
identity; recovery inspects it instead of replaying tools. Agent availability does not
mean provider sign-in has been verified, and a provider failure leaves the request saved.

Shared and private chats use separate native conversations. Local execution is not
filesystem or credential isolation: the agent retains the computer's ordinary tools and
account access. Existing isolated contexts remain separate and retain their own sign-in
and acceptance controls; switching modes does not import their history or rebind a saved
request. Native shared actions use ordinary task worktrees, independent review and exact
integration previews. Native Work captures offered report files before the workspace can
change again. Choose **Open report from this reply** on the exact completed reply, then
select the offered files and grants before reading or publishing. Shared report notifications
have an **Open report** button in Group chat and retain their exact original notification.
**Manage → Advanced → Browse earlier shared reports** lists older selected shared copies.
Every open still checks current group authorization. Native Ask and Work retain the agent's
ordinary tools within their requested mode. Older isolated records and adapters remain
separate. See [shared actions](GROUP_ACTIONS.md) and [reports](GROUP_DOCUMENTS.md).

## Shared files and Git

GitHub is optional for messaging. For shared code/files, open **Setup → Shared files →
Choose work folder**. The app saves the selected folder and offers **Copy folder setup prompt**
for your own setup agent. After creating or joining, open **Manage → Work folder** and choose
**Use this folder for this group**. Selecting a folder or connecting Git makes no model call;
asking the setup agent uses its own account and allowance.

The setup prompt inspects intended files and preserves existing Git history and remotes.
Each person supplies their own GitHub account; unknown usernames stay blank. Repository
access is separate from group membership. Choose **Connect shared repository** once setup is
ready. If setup changes outside this page, use **Check repository** before connecting.
A newly verified connection defaults to automatic sync for reviewed, applied commits
and clean checkouts; a previously saved pause stays paused. **Manage → Advanced → Git sync
and reviewed changes** offers pause/resume and exact review controls. Uncertain replies retain
an exact saved retry through reload; checking status does not resend a change.
See [shared files and branches](GROUP_NATIVE_GIT.md).

Private conversations, drafts, files and native history are not automatically published to
the shared feed. Previously saved private conversations and catch-up records stay private;
the current two-tab Groups view does not expose those older controls. Notepad/draft conflicts
require choosing a version rather than silently replacing your text.

Shared files also shows bounded unfinished-file status for the group folder and its task
worktrees without staging or publishing those edits. The older protected Git adapter retains
its separate records. Creating a group alone does not select or create a remote repository:
connect the intended shared folder and collaborators with the setup agent before verifying
the connection. Private conversation history and credentials stay outside Git.
[Status](STATUS.md#groups) records the current scope.

**Manage → Remove from this app** hides this computer’s entry without leaving the group or
deleting shared data. **Removed groups** on the Groups list restores it with its saved history,
work and drafts. A lost acknowledgement offers **Review saved list change**, a read-only
**Check current setting**, and an exact **Retry saved change**. See [local settings](GROUP_LOCAL_SETTINGS.md).

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
