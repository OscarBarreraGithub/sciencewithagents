import type { GroupPromotionSource } from '@dock/shared/dist/group-promotion.js';
import type { GroupPromotionDoStorage } from './group-promotion.js';
type Sql = GroupPromotionDoStorage['sql'];

function promotionReady(sql: Sql) {
  return (
    sql
      .exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='group_promotion_sources'")
      .toArray().length > 0
  );
}
function committed(sql: Sql, sourceId: string) {
  return (
    sql
      .exec("SELECT 1 FROM delivery_operations WHERE source_id=? AND state='committed'", sourceId)
      .toArray().length > 0
  );
}
function chat(source: GroupPromotionSource) {
  return source.kind === 'human' || source.kind === 'native';
}
function projectedSource(sql: Sql, source: GroupPromotionSource) {
  const row = sql
    .exec<{
      source_id: string;
      binding: string;
      member_id: string;
      provider: string;
      native_id: string;
      session_id: string;
    }>(
      'SELECT source_id,binding,member_id,provider,native_id,session_id FROM delivery_messages WHERE message_id=?',
      source.projectionScope.source.messageId,
    )
    .toArray()[0];
  if (!row) return null;
  const binding = JSON.parse(row.binding);
  const scope = source.projectionScope;
  return binding.groupId === scope.groupId &&
    binding.installationId === scope.installationId &&
    row.member_id === scope.memberId &&
    row.provider === scope.source.provider &&
    row.native_id === scope.source.nativeSessionId &&
    row.session_id === scope.source.sessionId
    ? row.source_id
    : null;
}
/** Both paths use the same DO transaction: the original and its legacy summary
 * cannot each acquire a committed delivery, even if both were already staged. */
export function chatDeliveryConflict(sql: Sql, sourceId: string, original: string) {
  if (!promotionReady(sql)) return false;
  const producer = sql
    .exec<{
      source_json: string;
    }>('SELECT source_json FROM group_promotion_producers WHERE source_id=?', sourceId)
    .toArray()[0];
  if (producer) {
    const source = JSON.parse(producer.source_json) as GroupPromotionSource;
    if (chat(source)) {
      const expected =
        source.original.kind === 'inline' ? source.original.text : source.original.chunks.join('');
      if (expected !== original) return true;
      for (const row of sql
        .exec<{
          source_json: string;
        }>('SELECT source_json FROM group_promotion_sources WHERE source_id=?', sourceId)
        .toArray()) {
        const projected = projectedSource(sql, JSON.parse(row.source_json) as GroupPromotionSource);
        if (projected && committed(sql, projected)) return true;
      }
    }
  }
  const message = sql
    .exec<{
      message_id: string;
    }>('SELECT message_id FROM delivery_messages WHERE source_id=?', sourceId)
    .toArray()[0];
  if (!message) return false;
  for (const row of sql
    .exec<{
      source_id: string;
      source_json: string;
    }>(
      "SELECT source_id,source_json FROM group_promotion_sources WHERE json_extract(source_json,'$.projectionScope.source.messageId')=?",
      message.message_id,
    )
    .toArray()) {
    const source = JSON.parse(row.source_json) as GroupPromotionSource;
    if (chat(source) && projectedSource(sql, source) === sourceId && committed(sql, row.source_id))
      return true;
  }
  return false;
}

export function directChatDelivered(sql: Sql, sourceId: string) {
  if (!promotionReady(sql) || !committed(sql, sourceId)) return false;
  const row = sql
    .exec<{
      source_json: string;
    }>('SELECT source_json FROM group_promotion_producers WHERE source_id=?', sourceId)
    .toArray()[0];
  return !!row && chat(JSON.parse(row.source_json) as GroupPromotionSource);
}

export function chatSourceDelivered(sql: Sql, sourceId: string) {
  if (directChatDelivered(sql, sourceId)) return true;
  if (!promotionReady(sql)) return false;
  for (const row of sql
    .exec<{
      source_json: string;
    }>('SELECT source_json FROM group_promotion_sources WHERE source_id=?', sourceId)
    .toArray()) {
    const source = JSON.parse(row.source_json) as GroupPromotionSource;
    const projected = chat(source) ? projectedSource(sql, source) : null;
    if (projected && committed(sql, projected)) return true;
  }
  return false;
}
