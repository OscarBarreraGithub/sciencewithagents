/// <reference path="./phone-worker.env.d.ts" />

// The VPC service must point only at 127.0.0.1:4331 on the owner's tunnel.
// Its fixed service configuration chooses the destination; request URLs never do.
function unavailable(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export default {
  async fetch(request: Request, env: PhoneWorkerEnv): Promise<Response> {
    let publicUrl: URL;
    try {
      publicUrl = new URL(env.PHONE_PUBLIC_ORIGIN);
      if (
        publicUrl.protocol !== 'https:' ||
        publicUrl.origin !== env.PHONE_PUBLIC_ORIGIN ||
        publicUrl.username ||
        publicUrl.password ||
        publicUrl.port ||
        !/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(publicUrl.hostname)
      )
        return unavailable(503, 'Phone connection is not configured.');
    } catch {
      return unavailable(503, 'Phone connection is not configured.');
    }
    const target = new URL(request.url);
    if (target.origin !== publicUrl.origin)
      return unavailable(421, 'Use the configured secure phone address.');

    // HTTP is only the last loopback hop. Cloudflare encrypts the tunnel itself.
    // Keep the public Host, cookies and original Origin for the app's own checks.
    target.protocol = 'http:';
    const headers = new Headers(request.headers);
    headers.set('Host', publicUrl.host);
    headers.set('X-Forwarded-Proto', 'https');
    const upstream = new Request(new Request(target, request), {
      headers,
      redirect: 'manual',
      cache: 'no-store',
    });

    try {
      const response = await env.PAIRED_APP.fetch(upstream);
      // Returning the original upgrade response preserves the WebSocket tunnel.
      if (response.status === 101) return response;
      const result = new Response(response.body, response);
      result.headers.set('Cache-Control', 'no-store');
      result.headers.set('CDN-Cache-Control', 'no-store');
      result.headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
      return result;
    } catch {
      // Never include URLs, headers, credentials or connector errors in logs.
      return unavailable(503, 'Your computer is unavailable. Try again when it is connected.');
    }
  },
} satisfies ExportedHandler<PhoneWorkerEnv>;
