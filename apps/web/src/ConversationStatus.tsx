import { useEffect, useState } from 'react';
import { schedulerStatusSchema, type Agent } from '@dock/shared';
import { api } from './api';

/** Read the same queue explanation in every app-managed conversation. */
export function ConversationStatus({ agent }: { agent: Pick<Agent, 'id' | 'name' | 'status'> }) {
  const [reading, setReading] = useState<{
    agentId: string;
    explanation: string | null;
    unavailable: boolean;
  } | null>(null);
  useEffect(() => {
    setReading(null);
    if (agent.status !== 'queued') return;
    let alive = true;
    let pending = false;
    let controller: AbortController | undefined;
    const read = async () => {
      if (pending || document.hidden) return;
      pending = true;
      controller = new AbortController();
      try {
        const queue = schedulerStatusSchema.parse(
          await api('/scheduler', undefined, controller.signal),
        );
        const next = queue.items
          .filter((item) => item.agentId === agent.id && item.status === 'queued')
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (alive)
          setReading({
            agentId: agent.id,
            explanation: next?.explanation ?? null,
            unavailable: false,
          });
      } catch {
        if (alive) setReading({ agentId: agent.id, explanation: null, unavailable: true });
      } finally {
        pending = false;
      }
    };
    const refresh = () => void read();
    refresh();
    const timer = window.setInterval(refresh, 2000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      alive = false;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [agent.id, agent.status]);
  if (!['running', 'queued'].includes(agent.status)) return null;
  const current = reading?.agentId === agent.id ? reading : null;
  return (
    <div className="thinking" role="status">
      <span />
      <span />
      <span />
      <p>
        {agent.status === 'running'
          ? `${agent.name} is working`
          : current?.unavailable
            ? 'Queue status is unavailable. Your message is saved.'
            : (current?.explanation ?? 'Checking why this message is waiting…')}
      </p>
    </div>
  );
}
