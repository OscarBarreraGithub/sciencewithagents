# Native sessions in Chats

Choose **New → Connect native session** to observe or control an existing terminal
session. The first-run setup page also has **Connect native session**. This path does
not require a local Codex or Claude installation, sign-in, model catalog or QUARK
admission. The computer supplies the available session identities; the browser cannot
choose a launch command or arbitrary filesystem path.

**Observe** is the default. It offers no input or saved-send controls. **Request
control** is an explicit owner action and cannot take over an occupied exclusive
controller. Unsupported versions, missing tools, unavailable SSH authentication and
unverified session identities stay visible. Refreshing the list starts no model work.
Existing editor and Codex daemon chats keep their original shared-chat path and history.

The native session keeps running where it started. **Back** closes the view; **Detach**
releases the app's attachment. Neither stops that external session. Reconnection requires
an explicit new attachment after fresh identity checks. Phone attachment does not resize
an existing tmux desktop client. Native terminal input is owner-operated, including any
shell commands; raw keys and passwords are not saved as prompts.

**Send and save prompt** pastes text into the current terminal program and presses
Enter. That program could be a shell: check its prompt first. **Delivered to terminal
pane** confirms pane submission, never agent acceptance, a model turn or completion.
Uncertain deliveries are not replayed. After a lost response, **Check saved receipt**
reads the original receipt without sending again. A missing receipt is not proof that
sending is safe. A definite first-send refusal shows **Not sent** and keeps the draft;
no native handoff or receipt was created. An interrupted intermediary response, including
an HTML error page, retains the exact pending prompt for receipt inspection. Browser-save
failures also send nothing.
Unresolved requests show their exact original text beside the newer editable draft.
**Your saved prompts** lists only text submitted through this app,
with bounded pages and exact original receipts; it is not the complete native history.
Drafts and original pending receipts remain in this browser across Back and reload.

**New → Chat → Start chat + save contact** creates a separate app-owned conversation
in a private folder. Fresh personal chats default to **Native agent**, preserving native
tools, skills, hooks and approval settings. Owner-selected Read-only permissions may
narrow a launch. Managed setup is optional; saved older contexts keep their original
mode. Direct chats show native helper activity when the provider reports it, without
app delegation, managed goals, per-tool restrictions or QUARK launch controls. Creating
a chat sends no prompt; this app must remain running for its native work.

**New → Start native in a folder** chooses an existing folder through the computer's
folder browser, then explicitly starts Codex or Claude in a configured local tmux source.
Opening setup sends no prompt and creates no session. **Keep native settings** passes no override; **Saved app model defaults** resolves the central policy;
**Choose exact model** uses the selected provider's live catalog, including light
models. Native sign-in, tools, hooks and permissions stay native. Missing optional tools
are shown without installing them. SSH and Herdr folder start are not supported here.

The exact start input is saved before HTTP. **Check saved start receipt** only reads its
original receipt after an interrupted response; uncertainty and missing receipts are never
replayed. After an explicit check still reports uncertainty or a missing receipt,
**Inspect native connections** opens the ordinary session picker without attaching.
**Set aside unconfirmed start** requires acknowledgement that the original may have
created a session. It retains the exact original input and last receipt in this browser,
with **Check original receipt** available later; it never cancels, stops or replays that
start. A separate explicit **Start native session** uses a new request identity and may
create another session. Reload and Back send nothing automatically. Retention is bounded
at 32 set-aside starts and 128,000 encoded text units; full, unreadable or unavailable
browser storage keeps the original held and erases no retained records.

**Native session created** proves creation only, not sign-in, an agent turn or
present liveness. **Connect created session** explicitly opens the ordinary observer/control
picker; no attachment or input happens automatically. The native session continues when
this app closes. **Managed project setup (Advanced)** keeps the original project/folder
workflow and its saved setup receipts. Personal sessions are not enrolled in Groups or published to a group merely by
connecting or opening them. Group conversations retain their own membership, folder,
Ask/Work and publication boundaries.
