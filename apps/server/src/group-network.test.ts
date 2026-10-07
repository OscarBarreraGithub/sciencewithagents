import { connect, type Socket } from 'node:net';
import { expect, it, vi } from 'vitest';
import { GroupNetworkProxy, publicIPv4 } from './group-network.js';
import * as dns from 'node:dns/promises';
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

it.each([
  '127.0.0.1',
  '10.1.2.3',
  '169.254.1.2',
  '172.16.1.2',
  '192.168.0.2',
  '100.64.0.2',
  '198.18.0.2',
  '224.1.2.3',
  '::1',
  '1.2.3.999',
])('denies private/special address %s', (address) => expect(publicIPv4(address)).toBe(false));
it('accepts public IPv4 and refuses wildcard/IP/URL proxy grants', async () => {
  expect(publicIPv4('104.18.30.15')).toBe(true);
  for (const domain of ['*', '127.0.0.1', 'https://auth.openai.com', 'localhost'])
    await expect(GroupNetworkProxy.open([domain], () => true)).rejects.toThrow(/exact DNS/);
});

it('rejects missing context capability, unrelated domains/plain HTTP and private DNS before dialing; closes on revocation', async () => {
  let current = true;
  const proxy = await GroupNetworkProxy.open(['auth.openai.com'], () => current);
  const lookup = vi
    .mocked(dns.lookup)
    .mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
  const sockets: Socket[] = [];
  const request = async (headers: string) =>
    new Promise<string>((done) => {
      const socket = connect(proxy.port, '127.0.0.1');
      sockets.push(socket);
      let result = '';
      socket.on('data', (chunk: Buffer) => {
        result += chunk.toString();
      });
      socket.on('error', () => {});
      socket.on('close', () => done(result));
      socket.on('connect', () => socket.end(headers));
    });
  const url = new URL(proxy.url);
  const authorization = `Proxy-Authorization: Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}\r\n`;
  try {
    expect(
      await request('CONNECT auth.openai.com:443 HTTP/1.1\r\nHost: auth.openai.com\r\n\r\n'),
    ).toBe('');
    expect(
      await request(
        `CONNECT host-database.invalid:443 HTTP/1.1\r\nHost: auth.openai.com\r\n${authorization}\r\n`,
      ),
    ).toBe('');
    expect(lookup).not.toHaveBeenCalled();
    expect(
      await request(
        `GET http://auth.openai.com/ HTTP/1.1\r\nHost: auth.openai.com\r\n${authorization}\r\n`,
      ),
    ).toContain('403');
    expect(
      await request(
        `CONNECT auth.openai.com:443 HTTP/1.1\r\nHost: auth.openai.com\r\n${authorization}\r\n`,
      ),
    ).toBe('');
    expect(lookup).toHaveBeenCalledOnce();
    current = false;
    await proxy.close();
    await expect(GroupNetworkProxy.open(['auth.openai.com'], () => current)).rejects.toThrow(
      /admission/,
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await proxy.close();
    lookup.mockReset();
  }
});
