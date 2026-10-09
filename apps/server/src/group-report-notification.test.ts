import { test } from 'vitest';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { groupReportNotification } from '@dock/shared/dist/group-report-notification.js';

test('report notifications accept only an exact immutable publication reference and preserve Unicode title', () => {
  const publication = { publicationId: randomUUID(), manifestHash: 'a'.repeat(64) };
  const notification = {
    kind: 'shared-report',
    title: 'Retained report · α → β 📚',
    publication,
    href: `#/groups/report/${publication.publicationId}/${publication.manifestHash}`,
  };
  const original = JSON.stringify(notification, null, 2);
  assert.deepEqual(groupReportNotification(original), notification);
  for (const change of [
    { href: 'https://example.test/report' },
    { href: `#/documents/${publication.publicationId}` },
    { href: `#/groups/report/${randomUUID()}/${publication.manifestHash}` },
    { publication: { ...publication, manifestHash: 'b'.repeat(64) } },
    { publication: { ...publication, path: '/private/report.pdf' } },
    { endpoint: '/documents/private' },
    { kind: 'message' },
  ])
    assert.equal(groupReportNotification(JSON.stringify({ ...notification, ...change })), null);
});

test('malformed or oversized originals remain ordinary text instead of creating a report action', () => {
  assert.equal(groupReportNotification('A report is at #/groups/report/not-a-publication'), null);
  assert.equal(groupReportNotification('{"kind":"shared-report"'), null);
  assert.equal(groupReportNotification('α'.repeat(16_385)), null);
});
