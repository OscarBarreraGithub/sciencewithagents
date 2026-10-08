import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import Fastify from 'fastify';
import { proxyPath, registerHostRoutes } from './hosts.js';
const id = randomUUID();
it('allows only exact submission-review owner routes on controller and nested project proxies', () => {
  for (const [method, path] of [
    ['GET', '/slurm-review'],
    ['GET', '/slurm-review/policy'],
    ['PUT', '/slurm-review/policy'],
    ['GET', '/slurm-review/reviews'],
    ['POST', '/slurm-review/reviews'],
    ['GET', `/slurm-review/reviews/${id}`],
    ['POST', `/slurm-review/reviews/${id}/decision`],
    ['GET', `/slurm-review/policy?projectId=${id}`],
    ['GET', `/slurm-review/reviews?projectId=${id}&limit=50`],
  ]) {
    expect(proxyPath(method!, path!)).toBe('/api' + path);
    expect(proxyPath(method!, `/cluster/projects/${id}/proxy${path}`)).toBe(
      `/api/cluster/projects/${id}/proxy${path}`,
    );
    expect(proxyPath(method!, path!, true)).toBeNull();
  }
  for (const [method, path] of [
    ['POST', '/slurm-review/policy'],
    ['PUT', '/model-policy'],
    ['PUT', '/slurm-review/reviews'],
    ['GET', `/slurm-review/reviews/${id}/decision`],
    ['GET', '/slurm-review/private'],
    ['GET', '/slurm-review?limit=1'],
    ['GET', '/slurm-review/policy?limit=1'],
    ['GET', '/slurm-review/reviews?limit=51'],
    ['GET', '/slurm-review/reviews?limit=0'],
    ['GET', '/slurm-review/reviews?limit=1&limit=2'],
    ['GET', '/slurm-review/reviews?projectId=bad'],
    ['GET', `/slurm-review/reviews/${id}?projectId=${id}`],
    ['POST', `/slurm-review/reviews/${id}/decision?key=${id}`],
    ['POST', '/cluster/runtime/admission/install'],
    ['POST', '/cluster/runtime/admission/drain'],
  ])
    expect(proxyPath(method!, path!)).toBeNull();
});
it('forwards policy PUT unchanged through the injected gateway without exposing upstream credentials', async () => {
  const upstream = Fastify(),
    gateway = Fastify();
  const body = { key: randomUUID(), expectedRevision: 2, policy: { enabled: false } };
  upstream.put('/api/slurm-review/policy', (request, reply) => {
    expect(request.body).toEqual(body);
    reply.header('Set-Cookie', 'native-secret=never-forward');
    return { revision: 3, enabled: false };
  });
  await upstream.listen({ host: '127.0.0.1', port: 0 });
  const port = (upstream.server.address() as { port: number }).port;
  registerHostRoutes(gateway, {
    status: () => ({}) as never,
    connection: async () => ({}) as never,
    checked: async () => ({}) as never,
    forward: async (_id, method, path, payload) =>
      new Promise((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: '127.0.0.1',
            port,
            path,
            method,
            headers: { 'Content-Type': 'application/json' },
          },
          resolve,
        );
        request.on('error', reject);
        request.end(JSON.stringify(payload));
      }),
  });
  try {
    const response = await gateway.inject({
      method: 'PUT',
      url: `/api/hosts/${id}/proxy/slurm-review/policy`,
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revision: 3, enabled: false });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(
      (
        await gateway.inject({
          method: 'PUT',
          url: `/api/hosts/${id}/proxy/model-policy`,
          payload: body,
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});
