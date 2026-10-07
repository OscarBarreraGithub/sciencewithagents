import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { parse } from 'jsonc-parser';
const require = createRequire(import.meta.url);
const errors = [];
const config = parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'), errors, {
  allowTrailingComma: true,
});
assert.deepEqual(errors, []);
const schema = JSON.parse(
  readFileSync(
    new URL('config-schema.json', 'file://' + require.resolve('wrangler/package.json')),
    'utf8',
  ),
);
const validate = new Ajv({ strict: false, allowUnionTypes: true }).compile(schema);
assert(validate(config), JSON.stringify(validate.errors));
assert.equal(config.compatibility_date, '2026-10-06');
assert.equal(config.vars.HOSTING_MODE, 'disabled');
assert.equal(config.vars.GROUP_SETUP_HASH, '');
assert.equal(config.vars.HOSTING_ORIGIN, '');
assert.equal(config.vars.HOSTING_APPROVAL_HASH, '');
assert.equal(config.workers_dev, false);
assert.equal(config.preview_urls, false);
assert.equal(config.dev.ip, '127.0.0.1');
assert.deepEqual(config.migrations[0].new_sqlite_classes, ['GroupMembership']);
assert.equal(config.durable_objects.bindings.length, 1);
assert.equal(config.observability.enabled, false);
console.log('Current Wrangler schema and disabled-default configuration pass.');
