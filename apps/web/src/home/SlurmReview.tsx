import { useCallback, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  defaultSlurmSubmissionPolicy,
  effortLabel,
  effortSchema,
  modelPolicyStatusSchema,
  slurmOwnerDecisionSchema,
  slurmPolicySaveSchema,
  slurmReviewSchema,
  slurmReviewStatusSchema,
  slurmSubmissionPolicySchema,
  type SlurmReview as Review,
  type SlurmSubmissionPolicy as Policy,
} from '@dock/shared';
import { apiComputer, ApiError, controllerApi, saveSlurmPolicy } from '../api';
import { useReading } from './useHomeData';
import './slurm-review.css';

type PolicyRequest = Extract<ReturnType<typeof slurmPolicySaveSchema.parse>, { scope: 'global' }>;
type Pending =
  | { kind: 'policy'; body: PolicyRequest }
  | { kind: 'decision'; id: string; body: ReturnType<typeof slurmOwnerDecisionSchema.parse> };
const storage = () => `dock:${apiComputer()}:slurm-review-edit`;
type Edits = {
  draft: Policy | null;
  base: Policy | null;
  pending: Pending | null;
  numbers: Record<string, string>;
  partitions: string | null;
  account: string | null;
};
const emptyEdits = (): Edits => ({
  draft: null,
  base: null,
  pending: null,
  numbers: {},
  partitions: null,
  account: null,
});
function restore(): Edits {
  try {
    const value = JSON.parse(localStorage.getItem(storage()) ?? 'null');
    const parsed = slurmSubmissionPolicySchema.safeParse(value?.draft);
    let pending: Pending | null = null;
    if (value?.pending?.kind === 'policy') {
      const body = slurmPolicySaveSchema.parse(value.pending.body);
      if (body.scope === 'global') pending = { kind: 'policy', body };
    } else if (value?.pending?.kind === 'decision' && /^[0-9a-f-]{36}$/i.test(value.pending.id))
      pending = {
        kind: 'decision',
        id: value.pending.id,
        body: slurmOwnerDecisionSchema.parse(value.pending.body),
      };
    const numbers = Object.fromEntries(
      Object.entries(value?.numbers ?? {}).filter(
        ([key, text]) =>
          [
            ...Object.keys(resourceLabels),
            'evidenceMaxAgeMinutes',
            'approvalValidMinutes',
          ].includes(key) &&
          typeof text === 'string' &&
          text.length <= 100,
      ),
    );
    return {
      draft: parsed.success ? parsed.data : null,
      base: slurmSubmissionPolicySchema.safeParse(value?.base).data ?? null,
      pending,
      numbers: numbers as Record<string, string>,
      partitions: typeof value?.partitions === 'string' ? value.partitions.slice(0, 2000) : null,
      account: typeof value?.account === 'string' ? value.account.slice(0, 100) : null,
    };
  } catch {
    return emptyEdits();
  }
}
function retain(value: Edits) {
  try {
    localStorage.setItem(storage(), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
const resourceLabels = {
  maxTimeMinutes: 'Time (minutes)',
  maxCpus: 'CPUs',
  maxMemoryGb: 'Memory (GB)',
  maxGpus: 'GPUs',
  maxNodes: 'Nodes',
  maxArrayTasks: 'Array tasks',
} as const;
/** Cached policy and review receipts; opening this panel never requests a model review. */
export function SlurmReview() {
  const [supported, setSupported] = useState(true);
  const read = useCallback<typeof controllerApi>(async (...args) => {
    try {
      return await controllerApi(...args);
    } catch (cause) {
      if (cause instanceof ApiError && [404, 501].includes(cause.status)) setSupported(false);
      throw cause;
    }
  }, []);
  const reading = useReading('/slurm-review', slurmReviewStatusSchema.parse, read, supported);
  const catalogs = useReading(
    '/model-policy',
    modelPolicyStatusSchema.parse,
    controllerApi,
    !!reading.data && supported,
  );
  const [saved, setSaved] = useState(restore);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [modelError, setModelError] = useState('');
  const refreshing = useRef(false);
  const state = reading.data;
  const policy = saved.draft ?? state?.policy;
  const update = (value: typeof saved) => {
    if (!retain(value)) {
      setError('This browser could not save the change. Copy your rules before leaving.');
      return false;
    }
    setSaved(value);
    return true;
  };
  const change = (patch: Partial<Policy>) => {
    if (!policy || saved.pending || busy) return;
    if (update({ ...saved, base: saved.base ?? policy, draft: { ...policy, ...patch } })) {
      setError('');
      setMessage('Unsaved');
    }
  };
  const changeNumber = (key: string, text: string) => {
    if (!policy || saved.pending || busy) return;
    if (
      update({
        ...saved,
        base: saved.base ?? policy,
        draft: policy,
        numbers: { ...saved.numbers, [key]: text },
      })
    ) {
      setError('');
      setMessage('Unsaved');
    }
  };
  const numberText = (key: string, value: number | null) =>
    saved.numbers[key] ?? String(value ?? '');
  async function refreshModels() {
    if (refreshing.current) return;
    refreshing.current = true;
    setRefreshingModels(true);
    setModelError('');
    try {
      const status = modelPolicyStatusSchema.parse(
        await controllerApi('/model-policy/catalogs', {}),
      );
      if (status.catalogs.some((catalog) => catalog.error))
        setModelError('Some models could not refresh. Your saved choice and edits are retained.');
      catalogs.retry();
    } catch {
      setModelError('Models could not refresh. Your saved choice and edits are retained.');
    } finally {
      refreshing.current = false;
      setRefreshingModels(false);
    }
  }
  const changeAccount = (account: string) => {
    if (!policy || saved.pending || busy) return;
    if (update({ ...saved, base: saved.base ?? policy, draft: policy, account })) {
      setError('');
      setMessage('Unsaved');
    }
  };
  async function submit(pending: Pending) {
    if (running.current || !update({ ...saved, pending })) return;
    const reconciling = !!saved.pending;
    running.current = true;
    setBusy(true);
    setError('');
    setMessage('Saving…');
    try {
      if (pending.kind === 'policy') {
        const result = slurmSubmissionPolicySchema.parse(await saveSlurmPolicy(pending.body));
        if (
          JSON.stringify(result) !==
          JSON.stringify({ ...pending.body.policy, revision: pending.body.expectedRevision + 1 })
        )
          throw new Error('The policy receipt could not be confirmed. Retry the same change.');
        update(emptyEdits());
      } else {
        const result = slurmReviewSchema.parse(
          await controllerApi(`/slurm-review/reviews/${pending.id}/decision`, pending.body),
        );
        if (result.id !== pending.id) throw new Error('A different review answered. Retry safely.');
        update({ ...saved, pending: null });
      }
      setConflict(false);
      setMessage('Saved');
      reading.retry();
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        (!reconciling || (pending.kind === 'policy' && cause.status === 409))
      ) {
        update({ ...saved, pending: null });
        setConflict(cause.status === 409);
        setMessage('Change not applied');
        reading.retry();
      } else setMessage('Not confirmed. Retry checks the same change.');
      setError(cause instanceof Error ? cause.message : 'Could not confirm the change.');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  function save() {
    if (!policy) return;
    const resources = { ...policy.resources };
    for (const key of Object.keys(resourceLabels) as (keyof Policy['resources'])[])
      if (saved.numbers[key] !== undefined)
        resources[key] = saved.numbers[key]!.trim() === '' ? null : Number(saved.numbers[key]);
    const requiredNumber = (key: 'evidenceMaxAgeMinutes' | 'approvalValidMinutes') =>
      saved.numbers[key] === undefined
        ? policy[key]
        : saved.numbers[key]!.trim()
          ? Number(saved.numbers[key])
          : NaN;
    const proposed = {
      ...policy,
      confirmedAccount:
        saved.account === null ? policy.confirmedAccount : saved.account.trim() || null,
      resources,
      allowedPartitions:
        saved.partitions === null
          ? policy.allowedPartitions
          : saved.partitions
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
      evidenceMaxAgeMinutes: requiredNumber('evidenceMaxAgeMinutes'),
      approvalValidMinutes: requiredNumber('approvalValidMinutes'),
    };
    const result = slurmPolicySaveSchema.safeParse({
      scope: 'global',
      key: crypto.randomUUID(),
      expectedRevision: policy.revision,
      policy: proposed,
    });
    if (!result.success || result.data.scope !== 'global')
      return setError('Check the model, rules and numeric limits before saving.');
    void submit({ kind: 'policy', body: result.data });
  }
  const selected = policy?.reviewer.model
    ? `${policy.reviewer.provider}:${policy.reviewer.model}`
    : policy &&
        (policy.reviewer.provider !== defaultSlurmSubmissionPolicy.reviewer.provider ||
          policy.reviewer.family !== defaultSlurmSubmissionPolicy.reviewer.family)
      ? 'saved-latest'
      : 'default';
  const listed =
    catalogs.data?.catalogs.flatMap((catalog) =>
      catalog.models.map((model) => ({ ...model, provider: catalog.provider })),
    ) ?? [];
  const model = listed.find((item) => `${item.provider}:${item.id}` === selected);
  const locked = busy || !!saved.pending || conflict;
  if (!supported || !state) return null;
  return (
    <section className="slurm-review" aria-label="Slurm submission review">
      <header>
        <h3>Submission review</h3>
        <span role="status">{state.policy.enabled ? 'On' : 'Off'}</span>
      </header>
      {state && (
        <small>
          {state.policy.confirmedAccount ? `Account ${state.policy.confirmedAccount} · ` : ''}
          {state.policy.reviewer.model ?? `Latest ${state.policy.reviewer.family}`} · before new
          Slurm submissions
        </small>
      )}
      {reading.error && (
        <p role="alert">
          Could not update submission reviews.{' '}
          <button className="flow-button" onClick={reading.retry}>
            Retry reading
          </button>
        </p>
      )}
      {policy && (
        <details>
          <summary>Reviewer and lab rules</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <fieldset disabled={locked}>
              <label className="cluster-control-check">
                <input
                  type="checkbox"
                  checked={policy.enabled}
                  onChange={(e) => change({ enabled: e.target.checked })}
                />{' '}
                Review new Slurm submissions
              </label>
              <div className="cluster-control-grid">
                <label>
                  Default account
                  <input
                    value={saved.account ?? policy.confirmedAccount ?? ''}
                    maxLength={100}
                    placeholder="Confirm your lab account"
                    onChange={(e) => changeAccount(e.target.value)}
                  />
                </label>
                <label>
                  Site rules
                  <select
                    value={policy.siteRules ?? ''}
                    onChange={(e) => change({ siteRules: e.target.value || null })}
                  >
                    <option value="">None selected</option>
                    {policy.siteRules &&
                      !state.siteRuleSets.some((rules) => rules.id === policy.siteRules) && (
                        <option value={policy.siteRules}>{policy.siteRules} (saved)</option>
                      )}
                    {state.siteRuleSets.map((rules) => (
                      <option key={rules.id} value={rules.id}>
                        {rules.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                Reviewer model
                <select
                  value={selected}
                  onChange={(e) => {
                    const choice = listed.find(
                      (item) => `${item.provider}:${item.id}` === e.target.value,
                    );
                    if (e.target.value === 'saved-latest') return;
                    change({
                      reviewer: choice
                        ? {
                            ...policy.reviewer,
                            provider: choice.provider,
                            model: choice.id,
                            effort: null,
                          }
                        : { ...defaultSlurmSubmissionPolicy.reviewer },
                    });
                  }}
                >
                  <option value="default">Latest Claude Sonnet (default)</option>
                  {selected === 'saved-latest' && (
                    <option value="saved-latest">
                      Latest {policy.reviewer.family} · {policy.reviewer.provider} (saved)
                    </option>
                  )}
                  {policy.reviewer.model && !model && (
                    <option value={selected}>
                      {policy.reviewer.model} (saved; not currently listed)
                    </option>
                  )}
                  {listed.map((item) => (
                    <option
                      key={`${item.provider}:${item.id}`}
                      value={`${item.provider}:${item.id}`}
                    >
                      {item.label} · {item.provider === 'codex' ? 'Codex' : 'Claude'}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="flow-button slurm-model-refresh"
                disabled={refreshingModels}
                onClick={() => void refreshModels()}
              >
                <RefreshCw size={15} /> {refreshingModels ? 'Reading models…' : 'Refresh models'}
              </button>
              {modelError && <small role="alert">{modelError}</small>}
              <label>
                Reasoning
                <select
                  value={policy.reviewer.effort ?? ''}
                  onChange={(e) =>
                    change({
                      reviewer: {
                        ...policy.reviewer,
                        effort: e.target.value ? effortSchema.parse(e.target.value) : null,
                      },
                    })
                  }
                >
                  <option value="">Native default</option>
                  {policy.reviewer.effort && !model?.efforts.includes(policy.reviewer.effort) && (
                    <option value={policy.reviewer.effort}>
                      {effortLabel(policy.reviewer.effort)} (saved)
                    </option>
                  )}
                  {model?.efforts
                    .filter((effort) => effortSchema.safeParse(effort).success)
                    .map((effort) => (
                      <option key={effort} value={effort}>
                        {effortLabel(effort)}
                      </option>
                    ))}
                </select>
              </label>
              {catalogs.error && (
                <small>Model choices could not update; the saved choice is retained.</small>
              )}
              <label>
                Lab rules
                <textarea
                  rows={3}
                  maxLength={4000}
                  value={policy.labRules}
                  onChange={(e) => change({ labRules: e.target.value })}
                />
              </label>
              <details>
                <summary>Resource limits and validity</summary>
                <small>
                  Blank limits add no owner restriction. Native Slurm and site rules still apply.
                </small>
                <div className="cluster-control-grid">
                  {Object.entries(resourceLabels).map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <input
                        type="number"
                        min={key === 'maxGpus' ? 0 : 1}
                        step={key === 'maxMemoryGb' ? 'any' : 1}
                        value={numberText(
                          key,
                          policy.resources[key as keyof typeof resourceLabels],
                        )}
                        onChange={(e) => changeNumber(key, e.target.value)}
                      />
                    </label>
                  ))}
                  <label>
                    Allowed partitions
                    <input
                      value={saved.partitions ?? policy.allowedPartitions.join(', ')}
                      maxLength={2000}
                      onChange={(e) =>
                        update({
                          ...saved,
                          base: saved.base ?? policy,
                          draft: policy,
                          partitions: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    Reading age (minutes)
                    <input
                      type="number"
                      min={1}
                      max={240}
                      value={numberText('evidenceMaxAgeMinutes', policy.evidenceMaxAgeMinutes)}
                      onChange={(e) => changeNumber('evidenceMaxAgeMinutes', e.target.value)}
                    />
                  </label>
                  <label>
                    Approval lasts (minutes)
                    <input
                      type="number"
                      min={5}
                      max={1440}
                      value={numberText('approvalValidMinutes', policy.approvalValidMinutes)}
                      onChange={(e) => changeNumber('approvalValidMinutes', e.target.value)}
                    />
                  </label>
                </div>
              </details>
            </fieldset>
            <button type="submit" className="flow-button" disabled={locked || !saved.draft}>
              Save review settings
            </button>
          </form>
        </details>
      )}
      {message && <small role="status">{message}</small>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {saved.pending && (
        <button className="flow-button" disabled={busy} onClick={() => void submit(saved.pending!)}>
          Retry same change
        </button>
      )}
      {conflict && state && (
        <button
          className="flow-button"
          onClick={() => {
            // Keep explicit edits; untouched account/site choices follow current policy.
            update({
              ...saved,
              draft: saved.draft
                ? {
                    ...state.policy,
                    ...Object.fromEntries(
                      (
                        [
                          'enabled',
                          'confirmedAccount',
                          'siteRules',
                          'reviewer',
                          'labRules',
                        ] as const
                      )
                        .filter(
                          (key) =>
                            !saved.base ||
                            JSON.stringify(saved.draft![key]) !== JSON.stringify(saved.base[key]),
                        )
                        .map((key) => [key, saved.draft![key]]),
                    ),
                  }
                : null,
              base: state.policy,
              pending: null,
            });
            setConflict(false);
            setError('');
            setMessage('Review your retained edits, then save.');
          }}
        >
          Use current policy and retain edits
        </button>
      )}
      {!!state?.reviews.length && (
        <details>
          <summary>Recent submissions ({state.reviews.length})</summary>
          <ul className="cluster-review-list">
            {state.reviews.map((review) => (
              <ReviewRow
                key={review.id}
                review={review}
                disabled={busy || !!saved.pending}
                decide={(body) => void submit({ kind: 'decision', id: review.id, body })}
              />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
function ReviewRow({
  review,
  disabled,
  decide,
}: {
  review: Review;
  disabled: boolean;
  decide: (body: ReturnType<typeof slurmOwnerDecisionSchema.parse>) => void;
}) {
  const [note, setNote] = useState('');
  const [override, setOverride] = useState(false);
  return (
    <li>
      <strong>{review.subject.name}</strong>
      <small>
        {review.status.replaceAll('_', ' ')} ·{' '}
        {review.verification === 'exact' ? 'Exact submission' : 'Unverified submission'}
      </small>
      <p>{review.allowsSubmission ? 'Allowed to submit now' : review.validity.message}</p>
      <details>
        <summary>Evidence and owner decision</summary>
        <p>{review.assessment?.summary ?? review.failure ?? review.message}</p>
        <small>
          Evidence {review.evidence.state}
          {review.evidence.observedAt
            ? ` · ${new Date(review.evidence.observedAt).toLocaleString()}`
            : ''}
        </small>
        <small>{review.evidence.message}</small>
        {[...review.hostFindings, ...(review.assessment?.findings ?? [])].map((finding, i) => (
          <p key={i}>
            {finding.severity}: {finding.detail}
          </p>
        ))}
        <label>
          Decision note
          <textarea
            rows={2}
            maxLength={1000}
            value={note}
            disabled={disabled}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <label className="cluster-control-check">
          <input
            type="checkbox"
            checked={override}
            disabled={disabled}
            onChange={(e) => setOverride(e.target.checked)}
          />{' '}
          Approve without current matching evidence
        </label>
        <div className="cluster-control-actions">
          {(['approve', 'reject', 'retry'] as const).map((decision) => (
            <button
              className="flow-button"
              key={decision}
              disabled={disabled}
              onClick={() =>
                decide(
                  slurmOwnerDecisionSchema.parse({
                    key: crypto.randomUUID(),
                    decision,
                    note,
                    withoutCurrentEvidence: decision === 'approve' && override,
                  }),
                )
              }
            >
              {decision === 'approve'
                ? 'Approve submission'
                : decision === 'reject'
                  ? 'Reject'
                  : 'Retry review'}
            </button>
          ))}
        </div>
      </details>
    </li>
  );
}
