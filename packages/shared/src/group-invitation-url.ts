/** A hosted invitation belongs to the shared service, never the creator's private app URL. */
export function groupInvitationUrl(fragment: string, localOrigin: string) {
  const encoded = new URLSearchParams(fragment.replace(/^\/?groups\?/, '')).get('invite');
  const payload = JSON.parse(encoded ?? 'null') as {
    service?: { endpoint?: string; mode?: string };
  } | null;
  if (payload?.service) {
    const endpoint = new URL(payload.service.endpoint ?? '');
    if (
      payload.service.mode !== 'hosted' ||
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error(
        'The invitation service address is invalid. Ask your setup agent to check Groups.',
      );
    return `${endpoint.origin}/join#${fragment}`;
  }
  // Retain legacy beta and local fixture envelopes; joining still parses only the fragment.
  return `${localOrigin}/#${fragment}`;
}
