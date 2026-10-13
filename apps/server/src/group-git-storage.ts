import type { DatabaseSync } from 'node:sqlite';
/** Existing append-only Git receipt tables shared by full SWA and the thin Groups host. */
export function initializeGroupGitStorage(db: DatabaseSync) {
  db.exec(`
      CREATE TABLE IF NOT EXISTS gng_settings(handle TEXT NOT NULL,key TEXT PRIMARY KEY,input TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gng_baselines(handle TEXT NOT NULL,origin TEXT NOT NULL,oid TEXT NOT NULL,PRIMARY KEY(handle,oid));
      CREATE TABLE IF NOT EXISTS gng_operations(key TEXT PRIMARY KEY,input TEXT NOT NULL,result TEXT);
      CREATE TABLE IF NOT EXISTS gng_applies(key TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gng_repositories(handle TEXT PRIMARY KEY,origin TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gng_connections(handle TEXT NOT NULL,scope_key TEXT NOT NULL,origin TEXT NOT NULL,key TEXT PRIMARY KEY,UNIQUE(handle,scope_key,origin));
      CREATE TABLE IF NOT EXISTS gng_native_previews(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,origin TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(scope_key,origin,fingerprint));
      CREATE INDEX IF NOT EXISTS gng_native_previews_head ON gng_native_previews(scope_key,origin,json_extract(body,'$.preview.head'),json_extract(body,'$.preview.branch'));
      CREATE TABLE IF NOT EXISTS gng_native_reviews(key TEXT PRIMARY KEY,preview_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS gng_native_previews_immutable BEFORE UPDATE ON gng_native_previews BEGIN SELECT RAISE(ABORT,'retained native commit preview'); END;
      CREATE TRIGGER IF NOT EXISTS gng_native_previews_retain BEFORE DELETE ON gng_native_previews BEGIN SELECT RAISE(ABORT,'retained native commit preview'); END;
      CREATE TRIGGER IF NOT EXISTS gng_native_reviews_immutable BEFORE UPDATE ON gng_native_reviews BEGIN SELECT RAISE(ABORT,'retained owner review'); END;
      CREATE TRIGGER IF NOT EXISTS gng_native_reviews_retain BEFORE DELETE ON gng_native_reviews BEGIN SELECT RAISE(ABORT,'retained owner review'); END;
      CREATE TRIGGER IF NOT EXISTS gng_connections_immutable BEFORE UPDATE ON gng_connections BEGIN SELECT RAISE(ABORT,'retained verified Git connection'); END;
      CREATE TRIGGER IF NOT EXISTS gng_connections_retain BEFORE DELETE ON gng_connections BEGIN SELECT RAISE(ABORT,'retained verified Git connection'); END;
      CREATE TRIGGER IF NOT EXISTS gng_settings_immutable BEFORE UPDATE ON gng_settings BEGIN SELECT RAISE(ABORT,'retained Git settings'); END;
      CREATE TRIGGER IF NOT EXISTS gng_baselines_immutable BEFORE UPDATE ON gng_baselines BEGIN SELECT RAISE(ABORT,'retained Git baseline'); END;
      CREATE TRIGGER IF NOT EXISTS gng_operations_identity BEFORE UPDATE OF key,input ON gng_operations BEGIN SELECT RAISE(ABORT,'retained Git operation'); END;
      CREATE TRIGGER IF NOT EXISTS gng_applies_immutable BEFORE UPDATE ON gng_applies BEGIN SELECT RAISE(ABORT,'retained exact Git preview'); END;
      CREATE TRIGGER IF NOT EXISTS gng_repositories_immutable BEFORE UPDATE ON gng_repositories BEGIN SELECT RAISE(ABORT,'retained Git remote'); END;
    `);
}
