import { useEffect, useRef, useState } from 'react';
import {
  effortLabel,
  providerCatalogSchema,
  usageSummarySchema,
  type Agent,
  type UsageSummary,
  type QuotaWindow,
} from '@dock/shared';
import { api, apiScope } from './api';
import './ExecutionInfo.css';

type Catalog = ReturnType<typeof providerCatalogSchema.parse>;
const providerName = (id: Agent['provider']) => (id === 'codex' ? 'Codex' : 'Claude Code');
const number = (value: number | null | undefined) =>
  value == null ? 'Not reported' : value.toLocaleString();
const date = (value: string | number | null) => {
  if (value === null) return 'Not reported';
  const parsed = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : 'Time unavailable';
};
const old = (at: string) => Date.now() - new Date(at).getTime() > 5 * 60_000;
const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.name !== 'TypeError' ? error.message : fallback;

export function ExecutionInfo({ agent }: { agent: Agent }) {
  // A late response for a previous agent/computer must not replace this view's information.
  return <ExecutionDetails key={`${apiScope()}:${agent.id}:${agent.provider}`} agent={agent} />;
}

function ExecutionDetails({ agent }: { agent: Agent }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [usageError, setUsageError] = useState('');
  const [readingCatalog, setReadingCatalog] = useState(false);
  const [readingUsage, setReadingUsage] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const live = useRef(false);
  const generation = useRef({ catalog: 0, usage: 0 });
  const refreshKey = useRef<string | null>(null);
  const pendingUsage = useRef(false);

  const readCatalog = async () => {
    const version = ++generation.current.catalog;
    setReadingCatalog(true);
    try {
      const parsed = providerCatalogSchema.safeParse(await api('/providers'));
      if (!parsed.success) throw new Error('Provider details could not be read. Try again.');
      if (live.current && version === generation.current.catalog) {
        setCatalog(parsed.data);
        setCatalogError('');
      }
    } catch (error) {
      if (live.current && version === generation.current.catalog)
        setCatalogError(
          message(error, 'This computer could not be reached. Try reading provider details again.'),
        );
    } finally {
      if (live.current && version === generation.current.catalog) setReadingCatalog(false);
    }
  };
  const readUsage = async (refresh = false) => {
    if (refresh && agent.provider !== 'codex') return;
    if (pendingUsage.current) return;
    pendingUsage.current = true;
    const version = ++generation.current.usage;
    setReadingUsage(true);
    setRefreshing(refresh);
    try {
      const value = await api(
        `/agents/${agent.id}/usage${refresh ? '/refresh' : ''}`,
        refresh ? { key: (refreshKey.current ??= crypto.randomUUID()) } : undefined,
      );
      const parsed = usageSummarySchema.safeParse(value);
      if (
        !parsed.success ||
        parsed.data.agentId !== agent.id ||
        parsed.data.projectId !== agent.projectId
      )
        throw new Error(
          'Usage details did not match this conversation. The previous report is retained; try again.',
        );
      if (live.current && version === generation.current.usage) {
        setUsage(parsed.data);
        setUsageError('');
        if (refresh) {
          refreshKey.current = null;
          setRefreshFailed(false);
        }
      }
    } catch (error) {
      if (live.current && version === generation.current.usage) {
        setUsageError(
          message(error, 'This computer could not be reached. Saved usage is retained; try again.'),
        );
        setRefreshFailed(refresh);
      }
    } finally {
      if (live.current && version === generation.current.usage) {
        pendingUsage.current = false;
        setReadingUsage(false);
        setRefreshing(false);
      }
    }
  };
  useEffect(() => {
    live.current = true;
    pendingUsage.current = false;
    void readCatalog();
    void readUsage();
    return () => {
      live.current = false;
      generation.current.catalog++;
      generation.current.usage++;
    };
  }, []);

  const provider = catalog?.providers.find((item) => item.id === agent.provider);
  const snapshots =
    usage?.tokenSnapshots
      .filter((item) => item.agentId === agent.id && item.provider === agent.provider)
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt)) ?? [];
  const current = snapshots.find((item) => item.currentContext);
  const lastOnly =
    !!current &&
    Object.values(current.total).every((value) => value === null) &&
    Object.values(current.last).some((value) => value !== null);
  const displayedTokens = current ? (lastOnly ? current.last : current.total) : null;
  const quota = usage?.quotaSnapshots
    .filter((item) => item.agentId === agent.id && item.provider === agent.provider)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
  const assignment = agent.assignment;
  return (
    <section className="execution-info" aria-label="Provider and usage">
      <h3>Provider and usage</h3>
      <dl className="execution-facts">
        <div>
          <dt>Current provider</dt>
          <dd>{providerName(agent.provider)}</dd>
        </div>
        <div>
          <dt>Current model</dt>
          <dd>{agent.model ?? (agent.nativeRootId ? 'Not reported' : 'Central model default')}</dd>
        </div>
        <div>
          <dt>Current reasoning</dt>
          <dd>{effortLabel(agent.effort)}</dd>
        </div>
      </dl>
      {/* Provider details only gate the limit refresh; availability lists are not repeated here. */}
      {catalogError && (
        <div className="execution-error">
          <p role="alert">{catalogError}</p>
          <button
            type="button"
            className="secondary"
            disabled={readingCatalog}
            onClick={() => void readCatalog()}
          >
            {readingCatalog ? 'Reading provider details…' : 'Try reading provider details again'}
          </button>
        </div>
      )}

      {assignment ? (
        <details className="execution-assignment">
          <summary>Why this agent was assigned</summary>
          <p>
            {assignment.policyRevision === null
              ? 'This is the original delegation choice. Later session settings do not rewrite it.'
              : 'The latest resolved assignment. Earlier choices and reasons are retained in recorded events.'}
          </p>
          <dl className="execution-facts">
            <div>
              <dt>Original provider</dt>
              <dd>{providerName(assignment.provider)}</dd>
            </div>
            <div>
              <dt>{assignment.policyRevision === null ? 'Original model' : 'Resolved model'}</dt>
              <dd>{assignment.model ?? 'Provider default'}</dd>
            </div>
            <div>
              <dt>
                {assignment.policyRevision === null ? 'Original reasoning' : 'Resolved reasoning'}
              </dt>
              <dd>{effortLabel(assignment.effort)}</dd>
            </div>
            <div>
              <dt>Task difficulty</dt>
              <dd>{assignment.difficulty === 'unspecified' ? 'Not set' : assignment.difficulty}</dd>
            </div>
            <div>
              <dt>Chosen by</dt>
              <dd>
                {assignment.source === 'model_policy'
                  ? 'Central model policy'
                  : assignment.source === 'manager_selection'
                    ? 'Manager selection'
                    : 'Inherited from the manager'}
              </dd>
            </div>
          </dl>
          <p className="execution-reason">{assignment.reason || 'No reason was recorded.'}</p>
          {assignment.policyRevision !== null && (
            <p>
              Policy revision {assignment.policyRevision} · {assignment.tier ?? 'Custom'} ·{' '}
              {assignment.taskClass ?? 'Assigned work'}.
            </p>
          )}
        </details>
      ) : null}

      <section aria-label="Recorded usage">
        <h4>Recorded usage</h4>
        {readingUsage && !usage && <p role="status">Reading saved usage…</p>}
        <p className="execution-total">
          Current conversation:{' '}
          <strong>
            {current?.total.totalTokens == null
              ? usage
                ? 'Not reported'
                : 'Unknown'
              : `${number(current.total.totalTokens)} tokens reported`}
          </strong>
        </p>
        {lastOnly && (
          <p>
            Last reported turn: {number(current!.last.inputTokens)} input tokens ·{' '}
            {number(current!.last.outputTokens)} output tokens. This is not a conversation total;
            cache counts are listed separately below.
          </p>
        )}
        {!current && (
          <p>
            {usage
              ? 'The provider has not reported usage for this conversation’s current context.'
              : 'No saved usage report could be read yet.'}{' '}
            This does not mean zero usage.
          </p>
        )}
        {current && (
          <>
            <Observation at={current.observedAt} stale={current.stale || old(current.observedAt)} />
            <details>
              <summary>Token details</summary>
              <p>
                Tokens are pieces of text processed by the model, not message counts or charges.{' '}
                {lastOnly
                  ? 'These are the last reported turn’s counters, not cumulative conversation totals.'
                  : 'This is one saved snapshot, not a sum of updates.'}
              </p>
              {current.provider === 'claude' && (
                <p>
                  {current.coverage === 'whole-tree'
                    ? 'Includes the main agent and its native helpers for this turn.'
                    : current.coverage === 'observed-steps'
                      ? 'Partial activity received so far. Missing helper or output counts are not treated as zero.'
                      : 'Main agent only. Helper spending may be missing from these counters.'}
                </p>
              )}
              <dl className="execution-facts">
                <div>
                  <dt>Input</dt>
                  <dd>{number(displayedTokens?.inputTokens)}</dd>
                </div>
                <div>
                  <dt>Output</dt>
                  <dd>{number(displayedTokens?.outputTokens)}</dd>
                </div>
                <div>
                  <dt>Cached input</dt>
                  <dd>{number(displayedTokens?.cachedInputTokens)}</dd>
                </div>
                <div>
                  <dt>Cache writes</dt>
                  <dd>{number(displayedTokens?.cacheWriteInputTokens)}</dd>
                </div>
                <div>
                  <dt>Reasoning output</dt>
                  <dd>{number(displayedTokens?.reasoningOutputTokens)}</dd>
                </div>
              </dl>
              <p>
                Model recorded with this context: {current.modelAtObservation ?? 'Not reported'}.
                This is not a per-model billing breakdown.
              </p>
            </details>
          </>
        )}
        {snapshots.some((item) => item !== current) && (
          <details>
            <summary>Other saved usage reports</summary>
            <p>Separate context snapshots are shown individually, never added together.</p>
            {snapshots
              .filter((item) => item !== current)
              .map((item) => (
                <div key={`${item.threadId}:${item.observedAt}`} className="execution-snapshot">
                  <p>
                    {item.currentContext
                      ? 'Current context report'
                      : 'Earlier conversation context'}
                    :{' '}
                    {item.total.totalTokens === null
                      ? 'Total not reported'
                      : `${number(item.total.totalTokens)} tokens reported`}
                  </p>
                  <Observation at={item.observedAt} stale={item.stale || old(item.observedAt)} />
                </div>
              ))}
          </details>
        )}
      </section>

      <section aria-label="Reported account limits">
        <h4>Reported account limits</h4>
        {!quota || (!quota.buckets.length && quota.ordinaryUsageAllowed === null) ? (
          <p>
            Remaining allowance and reset time are unknown.{' '}
            {usage
              ? 'No account limits have been reported.'
              : 'No saved account-limit report could be read yet.'}
          </p>
        ) : (
          <>
            <Observation at={quota.observedAt} stale={quota.stale || old(quota.observedAt)} />
            {quota.ordinaryUsageAllowed !== null && (
              <p>
                {quota.ordinaryUsageStale ||
                (quota.ordinaryUsageObservedAt && old(quota.ordinaryUsageObservedAt))
                  ? 'An older report said'
                  : 'The provider last reported'}{' '}
                ordinary usage was {quota.ordinaryUsageAllowed ? 'allowed' : 'not allowed'}. This is
                not a guarantee that another request can run now.
              </p>
            )}
            {quota.buckets.map((bucket, index) => (
              <div className="execution-quota" key={bucket.id ?? index}>
                <h5>{bucket.name ?? `Reported limit ${index + 1}`}</h5>
                {bucket.normalModel && <p>Applies to: {bucket.normalModel}</p>}
                {bucket.primary && (
                  <LimitWindow
                    window={bucket.primary}
                    stale={bucket.primaryStale === true}
                    label="First reporting window"
                  />
                )}
                {bucket.secondary && (
                  <LimitWindow
                    window={bucket.secondary}
                    stale={bucket.secondaryStale === true}
                    label="Second reporting window"
                  />
                )}
                {!bucket.primary && !bucket.secondary && <p>Usage windows were not reported.</p>}
                {bucket.spendControlReached === true && (
                  <p>The provider reported that a spending limit was reached.</p>
                )}
                {bucket.rateLimitReachedType && (
                  <p>A provider limit was reported: {bucket.rateLimitReachedType}.</p>
                )}
              </div>
            ))}
          </>
        )}
        <p>
          These reports describe the provider connection on this computer; its account identity is
          not verified here. They are not a project budget or a billing statement.
        </p>
        {usageError && (
          <div className="execution-error">
            <p role="alert">{usageError}</p>
            {!refreshFailed && (
              <button
                type="button"
                className="secondary"
                disabled={readingUsage}
                onClick={() => void readUsage()}
              >
                Try reading saved usage again
              </button>
            )}
          </div>
        )}
        {agent.provider === 'codex' ? (
          <>
            <button
              type="button"
              className="secondary"
              disabled={readingUsage || !provider?.enabled}
              onClick={() => void readUsage(true)}
            >
              {refreshing
                ? 'Checking reported limits…'
                : refreshFailed
                  ? 'Try refreshing limits again'
                  : 'Refresh reported limits'}
            </button>
            <p className="execution-muted">
              Refresh only asks the provider for its latest reported limits. It does not send a
              message or start a model turn.
            </p>
          </>
        ) : (
          <>
            <p className="execution-muted">
              Claude account limits are not available through this connection. Check Claude Code’s
              own usage controls on this computer. sciencewithagents does not reset limits or start
              a turn to check them.
            </p>
            <button
              type="button"
              className="secondary"
              disabled={readingUsage}
              onClick={() => void readUsage()}
            >
              Read saved usage again
            </button>
          </>
        )}
        {provider && !provider.enabled && (
          <p>Usage refresh is unavailable until this provider is enabled.</p>
        )}
        {!!usage && Object.values(usage.omitted).some((count) => count > 0) && (
          <p>
            Some older reports are outside this view. Missing information is not counted as zero.
          </p>
        )}
        {usage?.notice && (
          <details>
            <summary>How to read these reports</summary>
            <p>{usage.notice}</p>
          </details>
        )}
      </section>
    </section>
  );
}

function Observation({ at, stale }: { at: string; stale: boolean }) {
  return (
    <p className="execution-observed">
      Observed <time dateTime={at}>{date(at)}</time>
      {stale && <span> · Older report — may be out of date</span>}
    </p>
  );
}

function LimitWindow({
  window,
  stale,
  label,
}: {
  window: QuotaWindow;
  stale: boolean;
  label: string;
}) {
  const resetPassed = window.resetsAt !== null && window.resetsAt * 1000 <= Date.now();
  const minutes = window.windowDurationMins;
  const title =
    minutes === null
      ? label
      : minutes > 0 && minutes % 1440 === 0
        ? `${minutes / 1440}-day window`
        : minutes > 0 && minutes % 60 === 0
          ? `${minutes / 60}-hour window`
          : `${minutes}-minute window`;
  return (
    <div className="execution-window">
      <p>
        <strong>
          {title}: {window.usedPercent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%
          used
        </strong>
      </p>
      <Observation at={window.observedAt} stale={stale || old(window.observedAt) || resetPassed} />
      <p>Reported reset: {date(window.resetsAt)}.</p>
      {resetPassed && (
        <p>
          The reported reset time has passed. Available capacity is unknown until a fresh report
          arrives.
        </p>
      )}
    </div>
  );
}
