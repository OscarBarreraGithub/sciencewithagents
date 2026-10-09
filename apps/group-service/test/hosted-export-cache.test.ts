import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import {
  GROUP_EXPORT_LIMITS,
  type GroupExportPage,
  type GroupExportRequest,
} from '@dock/shared/dist/group-hosted-export.js';
import { exportHostedGroup, GroupExportCatalogue } from '../src/group-hosted-export.js';

// Local SQLite has no production PITR bookmarks. Only that API is controlled:
// every query, row read, cursor and transaction below uses real Worker storage.
function observedStorage(storage: DurableObjectStorage) {
  const queries: { query: string; cursor: { rowsRead: number; rowsWritten: number } }[] = [];
  let bookmark = 'controlled-production-bookmark-1',
    bookmarkCalls = 0,
    changeAfter = 0;
  const sql: SqlStorage = {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]) {
      const cursor = storage.sql.exec<T>(query, ...bindings);
      queries.push({ query, cursor });
      return cursor;
    },
    get databaseSize() {
      return storage.sql.databaseSize;
    },
    Cursor: storage.sql.Cursor,
    Statement: storage.sql.Statement,
  };
  const view = {
    sql,
    kv: storage.kv,
    getAlarm: () => storage.getAlarm(),
    transactionSync: <T>(closure: () => T) => storage.transactionSync(closure),
    getCurrentBookmark: async () => {
      bookmarkCalls++;
      if (bookmarkCalls === changeAfter) bookmark += '-changed';
      return bookmark;
    },
  } satisfies Parameters<typeof exportHostedGroup>[0];
  const metrics = () => ({
    counts: queries.filter(({ query }) => query.startsWith('SELECT count(*)')).length,
    schemaReads: queries.filter(({ query }) => query.includes('FROM sqlite_master')).length,
    rowsRead: queries.reduce((n, { cursor }) => n + cursor.rowsRead, 0),
    rowsWritten: queries.reduce((n, { cursor }) => n + cursor.rowsWritten, 0),
  });
  return {
    view,
    metrics,
    clear: () => {
      queries.length = 0;
    },
    mutate: () => {
      bookmark += '-changed';
    },
    changeDuringPage: () => {
      changeAfter = bookmarkCalls + 2;
    },
  };
}

async function fixture<T>(run: (storage: DurableObjectStorage, groupId: string) => Promise<T>) {
  const groupId = crypto.randomUUID(),
    stub = env.GROUPS.getByName(groupId);
  return runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql
      .exec('CREATE TABLE ga_export_cache(id INTEGER PRIMARY KEY,body TEXT)')
      .toArray();
    state.storage.sql
      .exec(
        "WITH RECURSIVE entries(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM entries WHERE n<1024) INSERT INTO ga_export_cache(id,body) SELECT n,'exact 🧬 retained row '||n FROM entries",
      )
      .toArray();
    return run(state.storage, groupId);
  });
}
const firstRequest = (): GroupExportRequest => ({ snapshot: null, cursor: null });
const nextRequest = (page: GroupExportPage): GroupExportRequest => {
  if (!page.next) throw new Error('fixture needs another page');
  return { snapshot: page.snapshot, cursor: page.next };
};
function requirePage(result: Awaited<ReturnType<typeof exportHostedGroup>>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

it('counts the real SQLite catalogue once across bookmark-pinned pages, with no writes and bounded row reads', async () => {
  const evidence = await fixture(async (storage, groupId) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const observed = observedStorage(storage),
      catalogue = new GroupExportCatalogue();
    let authorizations = 0;
    const authorize = () => {
      authorizations++;
    };
    const collect = async (cache?: GroupExportCatalogue) => {
      const pages: GroupExportPage[] = [];
      let request = firstRequest();
      for (let n = 0; n < 100; n++) {
        const page = requirePage(
          await exportHostedGroup(observed.view, groupId, request, authorize, false, cache),
        );
        pages.push(page);
        if (!page.next) return pages;
        request = nextRequest(page);
      }
      throw new Error('page bound');
    };
    const cached = await collect(catalogue),
      warmMetrics = observed.metrics();
    expect(warmMetrics.counts).toBe(cached[0].tables!.length);
    expect(warmMetrics.schemaReads).toBe(1);
    expect(warmMetrics.rowsWritten).toBe(0);
    expect(authorizations).toBe(3 * cached.length);
    observed.clear();
    const uncached = await collect(),
      coldMetrics = observed.metrics();
    expect(uncached).toEqual(cached);
    expect(coldMetrics.counts).toBe(cached.length * cached[0].tables!.length);
    expect(coldMetrics.schemaReads).toBe(cached.length);
    expect(coldMetrics.rowsWritten).toBe(0);
    // Real rowsRead proves that repeated COUNT scans were removed, beyond merely
    // checking the SQL text or trusting a mocked counter.
    expect(warmMetrics.rowsRead).toBeLessThan(coldMetrics.rowsRead / 2);
    return { pages: cached.length, tables: cached[0].tables!.length, warmMetrics, coldMetrics };
  });
  console.info('Actual SQLite export catalogue evidence', evidence);
});

it('a cold DO catalogue rebuilds once for an existing pinned continuation and retains exact rows', async () => {
  await fixture(async (storage, groupId) => {
    const observed = observedStorage(storage);
    const first = requirePage(
      await exportHostedGroup(
        observed.view,
        groupId,
        firstRequest(),
        () => {},
        false,
        new GroupExportCatalogue(),
      ),
    );
    observed.clear();
    const cold = new GroupExportCatalogue(),
      next = requirePage(
        await exportHostedGroup(observed.view, groupId, nextRequest(first), () => {}, false, cold),
      );
    expect(observed.metrics().counts).toBe(first.tables!.length);
    expect(next.snapshot).toEqual(first.snapshot);
    observed.clear();
    requirePage(
      await exportHostedGroup(observed.view, groupId, nextRequest(next), () => {}, false, cold),
    );
    expect(observed.metrics()).toMatchObject({ counts: 0, schemaReads: 0, rowsWritten: 0 });
  });
});

it('a changed bookmark refuses old pages and rebuilds row counts and new owned tables for a fresh export', async () => {
  await fixture(async (storage, groupId) => {
    const observed = observedStorage(storage),
      catalogue = new GroupExportCatalogue(),
      first = requirePage(
        await exportHostedGroup(observed.view, groupId, firstRequest(), () => {}, false, catalogue),
      );
    storage.sql
      .exec(
        "INSERT INTO ga_export_cache(id,body) VALUES(2049,'new exact row');CREATE TABLE delivery_feature_export_fixture(receipt TEXT);",
      )
      .toArray();
    observed.mutate();
    observed.clear();
    expect(
      await exportHostedGroup(
        observed.view,
        groupId,
        nextRequest(first),
        () => {},
        false,
        catalogue,
      ),
    ).toEqual({ ok: false, error: 'changed' });
    expect(observed.metrics().counts).toBe(0);
    const fresh = requirePage(
      await exportHostedGroup(observed.view, groupId, firstRequest(), () => {}, false, catalogue),
    );
    expect(fresh.snapshot.value).not.toBe(first.snapshot.value);
    expect(fresh.tables).toContainEqual({
      name: 'ga_export_cache',
      columns: ['id', 'body'],
      rows: 1025,
    });
    expect(fresh.tables).toContainEqual({
      name: 'delivery_feature_export_fixture',
      columns: ['receipt'],
      rows: 0,
    });
    expect(observed.metrics().counts).toBe(fresh.tables!.length);
  });
});

it('a mutation between bookmark checks cannot publish page bytes or populate the catalogue', async () => {
  await fixture(async (storage, groupId) => {
    const observed = observedStorage(storage),
      catalogue = new GroupExportCatalogue();
    observed.changeDuringPage();
    expect(
      await exportHostedGroup(observed.view, groupId, firstRequest(), () => {}, false, catalogue),
    ).toEqual({ ok: false, error: 'changed' });
    expect(observed.metrics().schemaReads).toBe(1);
    observed.clear();
    requirePage(
      await exportHostedGroup(observed.view, groupId, firstRequest(), () => {}, false, catalogue),
    );
    expect(observed.metrics().schemaReads).toBe(1);
  });
});

it('expiry is fixed despite warm reads and a fresh export rebuilds after it', async () => {
  await fixture(async (storage, groupId) => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const observed = observedStorage(storage),
      catalogue = new GroupExportCatalogue(),
      first = requirePage(
        await exportHostedGroup(observed.view, groupId, firstRequest(), () => {}, false, catalogue),
      );
    now += GROUP_EXPORT_LIMITS.timeoutMs - 1;
    observed.clear();
    requirePage(
      await exportHostedGroup(
        observed.view,
        groupId,
        nextRequest(first),
        () => {},
        false,
        catalogue,
      ),
    );
    expect(observed.metrics().schemaReads).toBe(0);
    now += 2;
    expect(
      await exportHostedGroup(
        observed.view,
        groupId,
        nextRequest(first),
        () => {},
        false,
        catalogue,
      ),
    ).toEqual({ ok: false, error: 'changed' });
    requirePage(
      await exportHostedGroup(observed.view, groupId, firstRequest(), () => {}, false, catalogue),
    );
    expect(observed.metrics().schemaReads).toBe(1);
    // A caller's later snapshot expiry cannot prolong a cold entry beyond the
    // server-owned maximum. The existing request format is unchanged.
    const longLived = nextRequest(first);
    longLived.snapshot!.expiresAt = now + 10 * GROUP_EXPORT_LIMITS.timeoutMs;
    const clamped = new GroupExportCatalogue();
    requirePage(
      await exportHostedGroup(observed.view, groupId, longLived, () => {}, false, clamped),
    );
    observed.clear();
    now += GROUP_EXPORT_LIMITS.timeoutMs + 1;
    requirePage(
      await exportHostedGroup(observed.view, groupId, longLived, () => {}, false, clamped),
    );
    expect(observed.metrics().schemaReads).toBe(1);
  });
});

it('fresh creator checks still deny a warm cache and a final authorization failure cannot populate a cold cache', async () => {
  await fixture(async (storage, groupId) => {
    const observed = observedStorage(storage),
      catalogue = new GroupExportCatalogue(),
      first = requirePage(
        await exportHostedGroup(observed.view, groupId, firstRequest(), () => {}, false, catalogue),
      );
    observed.clear();
    expect(
      await exportHostedGroup(
        observed.view,
        groupId,
        nextRequest(first),
        () => {
          throw new Error('export-denied');
        },
        false,
        catalogue,
      ),
    ).toEqual({ ok: false, error: 'denied' });
    expect(observed.metrics()).toMatchObject({
      counts: 0,
      schemaReads: 0,
      rowsRead: 0,
      rowsWritten: 0,
    });
    let checks = 0;
    const cold = new GroupExportCatalogue();
    expect(
      await exportHostedGroup(
        observed.view,
        groupId,
        firstRequest(),
        () => {
          if (++checks === 3) throw new Error('export-denied');
        },
        false,
        cold,
      ),
    ).toEqual({ ok: false, error: 'denied' });
    expect(checks).toBe(3);
    observed.clear();
    requirePage(
      await exportHostedGroup(observed.view, groupId, firstRequest(), () => {}, false, cold),
    );
    expect(observed.metrics().schemaReads).toBe(1);
  });
});

it('local digest fixtures continue hashing the whole SQL state on every page without a production bookmark fallback', async () => {
  await fixture(async (storage, groupId) => {
    const observed = observedStorage(storage),
      catalogue = new GroupExportCatalogue();
    observed.view.getCurrentBookmark = async () => {
      throw new Error('production API unavailable locally');
    };
    const first = requirePage(
      await exportHostedGroup(observed.view, groupId, firstRequest(), () => {}, true, catalogue),
    );
    expect(first.snapshot.kind).toBe('digest');
    expect(observed.metrics().schemaReads).toBe(3);
    observed.clear();
    requirePage(
      await exportHostedGroup(
        observed.view,
        groupId,
        nextRequest(first),
        () => {},
        true,
        catalogue,
      ),
    );
    expect(observed.metrics().schemaReads).toBe(3);
    storage.sql.exec("UPDATE ga_export_cache SET body='changed' WHERE id=1").toArray();
    expect(
      await exportHostedGroup(
        observed.view,
        groupId,
        nextRequest(first),
        () => {},
        true,
        catalogue,
      ),
    ).toEqual({ ok: false, error: 'changed' });
    expect(
      await exportHostedGroup(observed.view, groupId, firstRequest(), () => {}, false, catalogue),
    ).toEqual({ ok: false, error: 'unavailable' });
  });
});
