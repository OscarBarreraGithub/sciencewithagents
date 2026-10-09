import { createHash } from 'node:crypto';
import {
  GROUP_EXPORT_LIMITS as L,
  groupExportRequestSchema,
  groupExportPageSchema,
  type GroupExportCell,
  type GroupExportResult,
} from '@dock/shared/dist/group-hosted-export.js';
import { publicationCanonical } from '@dock/shared/dist/group-delivery.js';

class Refused extends Error {
  constructor(readonly code: 'changed' | 'limit' | 'unsupported') {
    super(code);
  }
}
const quoted = (name: string) => {
  if (!/^[a-z_][a-z0-9_]{0,100}$/.test(name)) throw new Refused('unsupported');
  return `"${name}"`;
};
const owned = (name: string) =>
  /^(metadata|enrollments|invitations|receipts|audit|sqlite_sequence)$/.test(name) ||
  /^(delivery_|document_|group_promotion_|ga_)[a-z0-9_]+$/.test(name);
/** Logical SQL archive only. No restore, SQL selector, schema writes, bookmark
 * restore, KV mutation or feature initialization occurs on this path. */
export async function exportHostedGroup(
  storage: DurableObjectStorage,
  groupId: string,
  request: unknown,
  authorize: () => void,
  local: boolean,
): Promise<GroupExportResult> {
  const parsed = groupExportRequestSchema.safeParse(request);
  if (!parsed.success) return { ok: false, error: 'invalid' };
  try {
    authorize();
    if ((await storage.getAlarm()) !== null) throw new Refused('unsupported');
    for (const _key of storage.kv.list({ limit: 1 })) throw new Refused('unsupported');
    const deadline = Date.now() + L.pageMs;
    const catalog = () => {
      const schema = storage.sql
        .exec<{
          type: string;
          name: string;
          tbl_name: string;
          sql: string | null;
        }>(
          "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE substr(name,1,5)<>'__cf_' ORDER BY type,name",
        )
        .toArray();
      if (
        Buffer.byteLength(JSON.stringify(schema)) > L.schemaBytes ||
        // Standalone local Wrangler records the selected DO name in one SQL
        // table. Retain it locally; production never accepts that exception.
        schema.some(
          (row) =>
            !(owned(row.tbl_name) || (local && row.tbl_name === '__miniflare_do_name')) ||
            !['table', 'index', 'trigger', 'view'].includes(row.type),
        )
      )
        throw new Refused('unsupported');
      const tables = schema
        .filter((row) => row.type === 'table')
        .map((row) => {
          if (/WITHOUT\s+ROWID|CREATE\s+VIRTUAL/i.test(row.sql ?? ''))
            throw new Refused('unsupported');
          const columns = storage.sql
            .exec<{ name: string }>(`PRAGMA table_info(${quoted(row.name)})`)
            .toArray()
            .map((row) => row.name);
          if (columns.some((name) => ['rowid', '_rowid_', 'oid'].includes(name)))
            throw new Refused('unsupported');
          const count = storage.sql
            .exec<{ n: number }>(`SELECT count(*) n FROM ${quoted(row.name)}`)
            .one().n;
          return { name: row.name, columns, rows: count };
        });
      if (tables.length > L.tables || tables.reduce((n, t) => n + t.rows, 0) > L.rows)
        throw new Refused('limit');
      return {
        schema: schema.map((row) => ({
          type: row.type,
          name: row.name,
          table: row.tbl_name,
          sql: row.sql,
        })),
        tables,
      };
    };
    const records = (name: string, columns: string[], after: string | null, limit?: number) => {
      const select = columns
        .flatMap((name, index) => {
          const c = quoted(name);
          return [
            `typeof(${c}) AS t${index}`,
            `CASE WHEN typeof(${c})='blob' THEN hex(${c}) WHEN typeof(${c})='real' THEN printf('%!.17g',${c}) ELSE CAST(${c} AS TEXT) END AS v${index}`,
          ];
        })
        .join(',');
      return storage.sql.exec(
        `SELECT CAST(_rowid_ AS TEXT) export_rowid,${select} FROM ${quoted(name)} ${after === null ? '' : 'WHERE _rowid_>?'} ORDER BY _rowid_ ${limit === undefined ? '' : `LIMIT ${limit}`}`,
        ...(after === null ? [] : [after]),
      );
    };
    // Local development has no PITR log/bookmarks. Its bounded digest is explicit
    // fixture support, never a fallback from a failed production bookmark call.
    const pin = async () => {
      if (!local) return storage.getCurrentBookmark();
      const hash = createHash('sha256'),
        state = catalog();
      let bytes = 0;
      hash.update(publicationCanonical(state));
      for (const table of state.tables)
        for (const row of records(table.name, table.columns, null)) {
          const encoded = publicationCanonical(row);
          bytes += Buffer.byteLength(encoded);
          if (bytes > L.totalBytes || Date.now() > deadline) throw new Refused('limit');
          hash.update(encoded);
        }
      return hash.digest('hex');
    };
    const before = await pin(),
      prior = parsed.data.snapshot;
    if (
      prior &&
      (prior.kind !== (local ? 'digest' : 'bookmark') ||
        prior.value !== before ||
        prior.expiresAt < Date.now())
    )
      throw new Refused('changed');
    const page = storage.transactionSync(() => {
      authorize();
      for (const _key of storage.kv.list({ limit: 1 })) throw new Refused('unsupported');
      const state = catalog(),
        cursor = parsed.data.cursor ?? { table: 0, after: null };
      const table = state.tables[cursor.table];
      if (!table) throw new Refused('unsupported');
      const rows: { rowid: string; cells: GroupExportCell[] }[] = [];
      let bytes = 0,
        more = false;
      for (const row of records(table.name, table.columns, cursor.after, L.pageRows + 1)) {
        const cells = table.columns.map((_, i): GroupExportCell => {
          const type = String(row[`t${i}`]),
            value = row[`v${i}`];
          if (type === 'null') return { type: 'null' };
          if (!['text', 'integer', 'real', 'blob'].includes(type) || typeof value !== 'string')
            throw new Refused('unsupported');
          return {
            type: type as 'text' | 'integer' | 'real' | 'blob',
            value: type === 'blob' ? Buffer.from(value, 'hex').toString('base64') : value,
          };
        });
        const result = { rowid: String(row.export_rowid), cells },
          size = Buffer.byteLength(JSON.stringify(result));
        if (rows.length === L.pageRows || bytes + size > L.pageBytes - L.schemaBytes - 8192) {
          more = true;
          break;
        }
        rows.push(result);
        bytes += size;
      }
      if (more && !rows.length) throw new Refused('limit');
      return groupExportPageSchema.parse({
        version: 1,
        groupId,
        snapshot: prior ?? {
          kind: local ? 'digest' : 'bookmark',
          value: before,
          expiresAt: Date.now() + L.timeoutMs,
        },
        table: cursor.table,
        columns: table.columns,
        rows,
        next: more
          ? { table: cursor.table, after: rows.at(-1)!.rowid }
          : cursor.table + 1 < state.tables.length
            ? { table: cursor.table + 1, after: null }
            : null,
        schema: prior ? null : state.schema,
        tables: prior ? null : state.tables,
      });
    });
    if ((await storage.getAlarm()) !== null) throw new Refused('unsupported');
    if ((await pin()) !== before) throw new Refused('changed');
    authorize();
    if (Date.now() > deadline || Buffer.byteLength(JSON.stringify(page)) > L.pageBytes)
      throw new Refused('limit');
    return { ok: true, value: page };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Refused
          ? error.code
          : error instanceof Error && error.message === 'export-denied'
            ? 'denied'
            : 'unavailable',
    };
  }
}
