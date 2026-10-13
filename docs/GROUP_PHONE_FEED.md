# Read a hosted group on your phone

This source candidate adds a direct Groups phone view to the creator’s existing Worker.
It requires the matching app and Worker update; it is not activated or deployed by opening
Manage. Desktop/phone browser fixtures and owned local services are separate from a real
phone and independent-person acceptance.

In **Groups → Manage → Read this group on your phone**, name the phone and choose
**Connect a phone**. Read-only is the default. Scan the one-use QR code or privately copy
its link to that phone within 10 minutes. Bookmark the group page after connecting. The
phone reads directly from the hosted service while the computer is closed. It shows recent
shared messages, earlier pages and full message text on request. Opening it makes no model
call and cannot start an agent, run commands or approve Git changes. GitHub project files
remain in the private repository; this phone view does not clone them or display report PDFs.

Optionally allow **human messages** when creating the link. This separate phone grant uses
no model. An agent interpreting messages still uses its ordinary allowance. Changing the
computer’s contribution selector does not revoke an existing phone grant: use **Revoke**
in the phone connection list. Revoke stops that phone’s future reads/posts; removing a group
from the local list preserves membership and phone grants. Removing the member denies all
of that enrollment’s phones. Revocation cannot recall text already read or copied.

A lost link request or revoke reply keeps the original request key; **Check saved phone
request** retries that exact request after reload. An expired link needs an explicitly new
link. On the phone, a failed send retains the exact message/key before delivery. **Retry
saved message** checks that original message. **Stop retrying saved message** stops further
retries; an accepted message remains shared. Unsent drafts and saved requests stay in that
phone browser’s local storage. During a send, connection check or feed refresh, the
send/retry/reset controls are disabled until that request finishes. Background reads keep
an unsent draft editable and preserve typing focus; a saved or unreadable request holds
the composer until it is resolved. A send
acknowledgement clears only that exact saved message and matching draft. An
unreadable saved request keeps its recovery explanation visible after connection/refresh.
Temporary claim refusals, including a capacity limit, preserve the original claim for
**Check phone connection**; they do not discard the link secret. Clearing browser storage
may remove unsent text and pairing.

## Authority and storage

The browser supplies a saved group handle and owner intent to the localhost app. Only an
authenticated owner browser or paired owner device may issue/revoke phone grants; native
agent credentials cannot. The host generates and privately retains the exact link request
before transport. Hosting/membership credentials never enter the phone link.

The link fragment contains a one-use secret, short expiry and purpose-separated routing
proof. The page removes it before any request and retains only the exact pending claim in
session storage until acknowledged. Successful claim sets a group-scoped HttpOnly,
SameSite=Strict, Secure cookie on the hosted HTTPS origin. Public routing rejects invalid
proofs before opening a Durable Object; the group rechecks current device and parent
membership for every read and post. The proof uses the hosting approval digest, a deployment
variable visible to people with dashboard access, to limit object allocation; it is not
device authorization. Rotating that digest requires re-pairing phones. Existing app
credentials and source identities remain separate. If a claim succeeded but its reply was
lost and the link then expires, its unused device still occupies a slot; revoke it in Manage
before pairing again.

The existing group SQLite object retains hashed link/device credentials, grant labels and
permissions, claim/revoke receipts and exact human-post receipts. Human posts enter the
ordinary authenticated delivery ledger and notify connected desktop members; there is no
second chat database or model call. These additive tables are included in the existing
creator-only checked hosted export. Update the existing creator Worker through its preserved
configuration and backup procedure in [hosting](GROUP_HOSTING.md); do not replace accounts,
identities, namespaces or deployment bindings.

Limits: eight active phones per enrollment; the connection list includes every active
phone and up to 64 recent entries. Immutable link/revoke receipts use the existing byte
ledger, without an arbitrary lifetime row cutoff; expired, unused links release only their
unused claim reservation. One link lasts
10 minutes; phone text is at most 16 KiB; reads return 20 messages per page and refresh at
most once per minute while the page is visible, plus explicit/focus refresh. These bounded
limits share existing group admission/storage and the creator’s Cloudflare Free account
quota. There is no paid fallback, automatic history deletion, offline history cache or
unlimited retention promise. Quota/service failures preserve drafts and original request
identities; they do not manufacture delivery receipts. See [group data](GROUP_DATA.md).

A provider-free local SQLite calibration of warm idle polling (no new messages) measured
24 rows read and two rows written per poll, both with an empty group and with 20 retained
messages. The writes are the existing health/authority probes, not new chat messages. Eight
phones visible for eight hours at one poll/minute would therefore use about 92,160 rows
read and 7,680 rows written before posts, startup, explicit refreshes and other account
activity. This is local source evidence, not deployed billing or an account-quota reservation.
Reading uses no model allowance but still uses Cloudflare requests/database operations.
See [account-wide Free capacity](GROUP_HOSTING.md#practical-shared-capacity-and-daily-costs).
