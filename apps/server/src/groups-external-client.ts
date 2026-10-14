import { groupInvitationUrl } from '@dock/shared/dist/group-invitation-url.js';
import { localAuthorization } from '@dock/shared/dist/local-authorization.js';
import * as contracts from '@dock/shared/dist/group-host.js';
import { groupExternalInputs, type GroupExternalTool } from '@dock/shared/dist/group-external.js';
import { readLocalAccess } from './local-access.js';
import { GroupsConversationJournal } from './groups-conversation-journal.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { groupExternalFilesViewSchema } from '@dock/shared/dist/group-external-files.js';

/** Uses the existing authenticated companion. It never starts a provider or QUARK. */
export class GroupsExternalClient {
  constructor(readonly dataDirectory: string) {}
  private async request(action: string, input?: unknown): Promise<unknown> {
    const config = readLocalAccess(this.dataDirectory);
    const path = action ? `/api/groups/${action}` : '/api/groups';
    const method = input === undefined ? 'GET' : 'POST';
    const authorization = await localAuthorization(
      config.origin,
      config.owner,
      'owner',
      method,
      path,
    );
    const response = await fetch(config.origin + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: {
        Origin: config.origin,
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const parts: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    if (!reader)
      throw new Error('Groups returned no response. Open SWA and retry the same request.');
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2 * 1024 * 1024) throw new Error('Groups response exceeds the reading limit.');
        parts.push(value);
      }
    } finally {
      await reader.cancel();
    }
    let result: unknown;
    try {
      result = JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch {
      throw new Error('Groups returned an invalid response. Retry the same request.');
    }
    if (!response.ok) {
      const error = contracts.groupHostErrorSchema.safeParse(result);
      throw Object.assign(
        new Error(error.success ? error.data.error : 'Groups refused this request.'),
        { status: response.status },
      );
    }
    return result;
  }
  private async opened(handle: string) {
    return contracts.groupHostOpenSchema.parse(await this.request('open', { handle }));
  }
  private publicGroup(group: contracts.GroupHostOpen) {
    return { group: group.group, member: group.member, members: group.members };
  }
  async call(name: GroupExternalTool, raw: unknown): Promise<unknown> {
    switch (name) {
      case 'groups_list': {
        groupExternalInputs[name].parse(raw);
        const value = contracts.groupHostListSchema.parse(await this.request(''));
        return {
          groups: value.groups,
          removed: value.removed ?? [],
          service: value.service,
          ...(value.appUpdates ? { appUpdates: value.appUpdates } : {}),
        };
      }
      case 'groups_open':
        return this.publicGroup(await this.opened(groupExternalInputs[name].parse(raw).handle));
      case 'groups_create':
        return this.publicGroup(
          contracts.groupHostOpenSchema.parse(
            await this.request('create', groupExternalInputs[name].parse(raw)),
          ),
        );
      case 'groups_join': {
        const value = contracts.groupHostJoinResultSchema.parse(
          await this.request('join', groupExternalInputs[name].parse(raw)),
        );
        return { group: value.group }; // Never return retained bearer/confirmation material.
      }
      case 'groups_invite': {
        const input = groupExternalInputs[name].parse(raw);
        const value = contracts.groupHostInviteResultSchema.parse(
          await this.request('invite', input),
        );
        return {
          invitation: groupInvitationUrl(
            value.fragment,
            readLocalAccess(this.dataDirectory).origin,
          ),
          expiresAt: value.expiresAt,
          note: 'Send privately. Group membership does not grant GitHub access.',
        };
      }
      case 'groups_remove_member':
        return this.request('revoke', groupExternalInputs[name].parse(raw));
      case 'groups_remove_here':
        return this.request('local-visibility', groupExternalInputs[name].parse(raw));
      case 'groups_set_read_only':
        return this.request('local-mode', groupExternalInputs[name].parse(raw));
      case 'groups_read': {
        const input = groupExternalInputs[name].parse(raw),
          group = await this.opened(input.handle);
        return this.request('feed', { handle: group.shared.handle, query: input.query });
      }
      case 'groups_original': {
        const input = groupExternalInputs[name].parse(raw),
          group = await this.opened(input.handle);
        return this.request('original', { handle: group.shared.handle, eventId: input.eventId });
      }
      case 'groups_post': {
        const input = groupExternalInputs[name].parse(raw),
          group = await this.opened(input.handle);
        return this.request('send', { ...input, handle: group.shared.handle });
      }
      case 'groups_delivery': {
        const input = groupExternalInputs[name].parse(raw),
          group = await this.opened(input.handle);
        if (input.retry && existsSync(join(this.dataDirectory, 'groups-conversations.sqlite'))) {
          const journal = new GroupsConversationJournal(this.dataDirectory);
          try {
            const job = journal.job(input.key),
              saved = journal.state(input.key),
              selected = journal.selection(group.group.handle);
            if (job) {
              if (
                job.handle !== group.group.handle ||
                !selected?.enabled ||
                job.generation !== selected.generation ||
                job.sessionId !== selected.sessionId ||
                saved.summary === undefined ||
                !['unknown', 'ready'].includes(saved.state)
              )
                throw new Error(
                  'This saved automatic update cannot be retried: sharing is stopped, the selection changed, or no undelivered summary is available. Nothing was sent.',
                );
              if (group.group.local?.mode === 'read-only' || group.group.local?.hidden)
                throw new Error(
                  'Automatic updates stay paused while this group is read-only or removed.',
                );
              const receipt = await this.request('send', {
                handle: group.shared.handle,
                key: input.key,
                text: `Shared update · Claude Code\n${saved.summary}`,
              });
              if (
                receipt &&
                typeof receipt === 'object' &&
                'delivery' in receipt &&
                receipt.delivery === 'complete'
              )
                journal.mark(input.key, {
                  ...saved,
                  state: 'published',
                  message: 'Shared with the group after an explicit delivery retry.',
                });
              return receipt;
            }
            const receipt = await this.request('status', {
              handle: group.shared.handle,
              key: input.key,
            });
            if (
              !receipt ||
              typeof receipt !== 'object' ||
              !('delivery' in receipt) ||
              receipt.delivery === 'unknown'
            )
              throw new Error(
                'No saved message is available for this delivery retry. Nothing was sent.',
              );
          } finally {
            journal.close();
          }
        }
        return this.request('status', { ...input, handle: group.shared.handle });
      }
      case 'groups_select_conversation': {
        const input = groupExternalInputs[name].parse(raw),
          group = await this.opened(input.handle);
        if (group.group.local?.mode === 'read-only')
          throw new Error(
            'This group is in read-only mode. Enable contribution before automatic sharing.',
          );
        const journal = new GroupsConversationJournal(this.dataDirectory);
        try {
          const selection = journal.select({ ...input, handle: group.group.handle });
          let background: unknown;
          try {
            background = await this.request('conversation-sharing', {
              action: 'activate',
              handle: group.group.handle,
            });
          } catch {
            background = {
              available: false,
              message:
                'Selection saved. Background sharing needs this SWA update running; check Your Claude Code in Groups.',
            };
          }
          return {
            selection,
            background,
            note: 'Only this native conversation is selected. New prompts/final replies will be summarized for all members using model allowance. No previous transcript is read.',
          };
        } finally {
          journal.close();
        }
      }
      case 'groups_stop_sharing': {
        const input = groupExternalInputs[name].parse(raw);
        const journal = new GroupsConversationJournal(this.dataDirectory);
        try {
          return journal.stop(input);
        } finally {
          journal.close();
        }
      }
      case 'groups_sharing_status':
        return this.request('conversation-sharing', {
          action: 'status',
          ...groupExternalInputs[name].parse(raw),
        });
      case 'groups_files_status':
      case 'groups_files_propose': {
        const input = groupExternalInputs[name].parse(raw),
          group = await this.opened(input.handle);
        const value = groupExternalFilesViewSchema.parse(
          await this.request('files', {
            ...input,
            handle: group.shared.handle,
            action: name === 'groups_files_status' ? 'status' : 'propose',
          }),
        );
        return { proposals: value.proposals }; // Full committed diffs belong in the owner review UI.
      }
    }
  }
}
