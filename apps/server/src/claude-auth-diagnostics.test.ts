import { describe, expect, it } from 'vitest';
import {
  claudeAuthDiagnosticReader,
  claudeAuthScanner,
  type ClaudeAuthClassification,
  type ClaudeAuthDiagnostic,
} from './claude-auth-diagnostics.js';

describe('private native Claude auth diagnostics', () => {
  it('recognizes split native markers and emits each fixed class once without raw text', () => {
    const observed: ClaudeAuthClassification[] = [];
    const scan = claudeAuthScanner((event) => observed.push(event));
    scan(
      Buffer.from('secret-token fixture@example.invalid https://example.invalid/?token=private\n'),
    );
    scan(Buffer.from('tengu_oauth_refresh_token_marked_dead_invalid_'));
    scan(Buffer.from('grant\nOAuth token refresh failed — run /login to re-authenticate\n'));
    scan(Buffer.from('tengu_oauth_refresh_token_cleared_on_disk\n'));
    scan(Buffer.from('OAuth dead-token disk clear: backend write failed\n'));
    for (let i = 0; i < 20; i++)
      scan(
        Buffer.from(
          'tengu_oauth_refresh_token_marked_dead_invalid_grant\nOAuth token refresh failed\n',
        ),
      );
    expect(observed).toEqual([
      'refresh-invalid-grant',
      'refresh-failed',
      'stored-token-cleared',
      'stored-token-clear-failed',
    ]);
    expect(JSON.stringify(observed)).not.toMatch(/secret-token|@|https:|private/);
  });

  it('does not infer sign-out from generic usage, network, HTTP or unrelated OAuth errors', () => {
    const observed: ClaudeAuthClassification[] = [];
    const scan = claudeAuthScanner((event) => observed.push(event));
    scan(
      Buffer.from(
        'Usage request failed: HTTP 401\nNetwork timeout\nHTTP 500\ninvalid_grant\n' +
          'MCP OAuth token expired/revoked\nGrowthBook: pre-init OAuth refresh failed (timeout)\n',
      ),
    );
    expect(observed).toEqual([]);
  });

  it('rejects arbitrary, oversized and extra-field frames and bounds duplicate observations', () => {
    const observed: ClaudeAuthDiagnostic[] = [];
    const read = claudeAuthDiagnosticReader((event) => observed.push(event));
    const frame = {
      classification: 'refresh-invalid-grant',
      observedAt: '2026-10-05T07:26:10.000Z',
      nativeProcessId: 123,
    };
    read(Buffer.from('native raw secret\n' + 'x'.repeat(100_000) + '\n'));
    read(Buffer.from(JSON.stringify({ ...frame, token: 'private-secret' }) + '\n'));
    read(Buffer.from(JSON.stringify({ ...frame, classification: 'http-401' }) + '\n'));
    read(Buffer.from(JSON.stringify({ ...frame, nativeProcessId: -1 }) + '\n'));
    const wire = JSON.stringify(frame) + '\n';
    read(Buffer.from(wire.slice(0, 19)));
    read(Buffer.from(wire.slice(19)));
    for (let i = 0; i < 20; i++) read(Buffer.from(wire));
    expect(observed).toEqual([frame]);
    expect(JSON.stringify(observed)).not.toMatch(/private-secret|raw secret|token/);
  });
});
