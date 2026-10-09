import {
  assignmentSchema,
  workerDefault,
  projectFamilyDefault,
  projectManagerDefault,
  managerModelChoice,
  modelFamilies,
  type Role,
  quarkModelChoiceSchema,
  quarkDefaultFamilies,
  defaultModelPolicy,
  modelPolicySaveSchema,
  modelPolicySchema,
  modelPolicyStatusSchema,
  policyProvider,
  policyDefaultEffort,
  workerDefaultEffort,
  taskTiers,
  nativeRunnerModelResolutionSchema,
  providerDefaultEffort,
  tierLabels,
  type Assignment,
  type ExecutionRequest,
  type Model,
  type ModelPolicy as Policy,
  type ModelTier,
  type ProviderId,
  type TaskClass,
  type NativeRunnerModelChoice,
} from '@dock/shared';
import { Conflict, type PrivateAgent, type Store } from './store.js';

const key = 'model-policy';
const levels: ModelTier[] = ['uncle', 'undergrad', 'grad', 'postdoc'];
export { latestFamily } from '@dock/shared';
import { latestFamily } from '@dock/shared';
import { projectWorkflow } from './project-workflow.js';
export class ModelPolicy {
  private closed = false;
  private cache = new Map<
    ProviderId,
    { models: Model[]; observedAt: string | null; error: string | null }
  >();
  private pending = new Map<ProviderId, Promise<Model[]>>();
  private retryAfter = new Map<ProviderId, number>();
  constructor(
    private store: Store,
    private discover: (provider: ProviderId) => Promise<Model[]>,
    private clock = Date.now,
  ) {
    // Preserve the only old per-task model preference without touching conversations.
    const old = store.getSetting('resources:settings') as { model?: string } | undefined;
    if (!store.getSetting(key) && old?.model === 'terra') {
      const policy = structuredClone(defaultModelPolicy);
      policy.providers.routine = 'codex';
      store.setSetting(key, policy);
    } else if (!store.getSetting(key) && store.projects().length === 0) {
      // A clean install must not require a second subscription. Never migrate an
      // existing workspace's routing or infer provider choices from a failed probe.
      const policy = structuredClone(defaultModelPolicy);
      policy.enabledProviders = ['codex'];
      policy.scheduledProvider = 'codex';
      store.setSetting(key, policy);
    }
  }
  policy(): Policy {
    return modelPolicySchema.parse(this.store.getSetting(key) ?? defaultModelPolicy);
  }
  provider(task: TaskClass, explicit?: ProviderId, scheduled = false) {
    const selected = policyProvider(this.policy(), task, explicit, scheduled);
    if (!selected)
      throw new Conflict(
        'Choose a provider for this new agent or delegation, or enable its provider in Model settings. Pick as I go requires an explicit choice; unattended checks use the saved provider.',
      );
    return selected;
  }
  /** An owner-operated native runner has no inferred Dock role or tier floor. */
  async resolveNativeLaunch(provider: ProviderId, choice: NativeRunnerModelChoice) {
    const revision = this.policy().revision;
    let model: string | null = null,
      effort: string | null = null;
    if (choice.mode === 'policy') {
      const assignment = await this.resolve('manager', {
        provider,
        mode: 'manual',
        difficulty: 'unspecified',
      });
      model = assignment.model;
      effort = assignment.effort === providerDefaultEffort ? null : assignment.effort;
    } else if (choice.mode === 'exact') {
      const selected = (await this.catalog(provider)).find((item) => item.id === choice.model);
      if (!selected || (choice.effort && !selected.efforts.includes(choice.effort)))
        throw new Conflict(
          'Choose an available native model and thinking level. No substitute was started.',
        );
      model = selected.id;
      effort = !choice.effort || choice.effort === providerDefaultEffort ? null : choice.effort;
    }
    if (this.closed)
      throw new Conflict('Native model selection was cancelled while the app was stopping.');
    return nativeRunnerModelResolutionSchema.parse({
      provider,
      mode: choice.mode,
      model,
      effort,
      policyRevision: revision,
    });
  }
  async catalog(provider: ProviderId, refresh = false): Promise<Model[]> {
    if (this.closed) throw new Conflict('Model discovery is stopping.');
    const pending = this.pending.get(provider);
    if (pending) return pending;
    const cached = this.cache.get(provider);
    if (!refresh && cached?.error && this.clock() < (this.retryAfter.get(provider) ?? 0))
      throw new Conflict(cached.error, 'MODEL_DISCOVERY_WAIT');
    if (
      !refresh &&
      cached &&
      !cached.error &&
      cached.observedAt &&
      this.clock() - Date.parse(cached.observedAt) < 300_000
    )
      return cached.models;
    const request = (async () => {
      try {
        const models = await this.discover(provider);
        this.retryAfter.delete(provider);
        this.cache.set(provider, {
          models,
          observedAt: new Date(this.clock()).toISOString(),
          error: null,
        });
        return models;
      } catch {
        this.retryAfter.set(provider, this.clock() + 60_000);
        const error = `${provider === 'codex' ? 'Codex' : 'Claude'} model discovery failed. Refresh available models to retry. This does not mean you are signed out.`;
        this.cache.set(provider, {
          models: cached?.models ?? [],
          observedAt: cached?.observedAt ?? null,
          error,
        });
        throw new Conflict(error, 'MODEL_DISCOVERY_WAIT');
      } finally {
        this.pending.delete(provider);
      }
    })();
    this.pending.set(provider, request);
    return request;
  }
  status() {
    return modelPolicyStatusSchema.parse({
      policy: this.policy(),
      catalogs: (['codex', 'claude'] as const).map((provider) => ({
        provider,
        ...(this.cache.get(provider) ?? { models: [], observedAt: null, error: null }),
      })),
    });
  }
  async refresh() {
    await Promise.allSettled(this.policy().enabledProviders.map((p) => this.catalog(p, true)));
    return this.status();
  }
  save(raw: unknown) {
    const input = modelPolicySaveSchema.parse(raw);
    this.store.operation(`${key}:${input.key}`, input, () => {
      const previous = this.policy();
      if (previous.revision !== input.expectedRevision)
        throw new Conflict(
          'Model settings changed on another device. Reload the saved settings before saving your changes.',
        );
      if (
        Object.values(input.policy.providers).some(
          (p) => p !== 'preset' && !input.policy.enabledProviders.includes(p),
        ) ||
        !input.policy.enabledProviders.includes(input.policy.scheduledProvider)
      )
        throw new Conflict('Choose enabled providers for task defaults and unattended checks.');
      for (const provider of ['codex', 'claude'] as const)
        for (const tier of [...levels, 'manager'] as const) {
          const selection =
            tier === 'manager'
              ? managerModelChoice(input.policy, provider)
              : input.policy.models[provider][tier];
          const old =
            tier === 'manager'
              ? managerModelChoice(previous, provider)
              : previous.models[provider][tier];
          if (JSON.stringify(selection) === JSON.stringify(old)) continue;
          if (!selection.model && !selection.effort) continue; // New family names can be prepared before provider access exists.
          const cached = this.cache.get(provider);
          const selectedId =
            selection.model ?? latestFamily(cached?.models ?? [], selection.family)?.id;
          const model = cached?.models.find((m) => m.id === selectedId);
          if (
            !model ||
            cached?.error ||
            !cached?.observedAt ||
            this.clock() - Date.parse(cached.observedAt) >= 300_000 ||
            (selection.effort && !model.efforts.includes(selection.effort))
          )
            throw new Conflict(
              `Refresh ${provider} models and choose an available model and thinking level for ${tier === 'manager' ? 'managers' : tierLabels[tier]}.`,
            );
        }
      for (const [purpose, choice] of Object.entries(input.policy.projectDefaults.overrides)) {
        if (
          JSON.stringify(choice) ===
          JSON.stringify(
            previous.projectDefaults.overrides[purpose as 'research' | 'review' | 'bulk'],
          )
        )
          continue;
        if (!input.policy.enabledProviders.includes(choice.provider))
          throw new Conflict('Choose an enabled provider for new-project defaults.');
        if (!choice.model && !choice.effort) continue;
        const cached = this.cache.get(choice.provider);
        const selected = choice.model
          ? cached?.models.find((m) => m.id === choice.model)
          : latestFamily(cached?.models ?? [], choice.family);
        if (
          !selected ||
          cached?.error ||
          !cached?.observedAt ||
          this.clock() - Date.parse(cached.observedAt) >= 300_000 ||
          (choice.effort && !selected.efforts.includes(choice.effort))
        )
          throw new Conflict(
            'Refresh models and choose an available model and thinking level for new-project defaults.',
          );
      }
      const policy = modelPolicySchema.parse({ ...input.policy, revision: previous.revision + 1 });
      this.store.setSetting(key, policy);
      this.store.event('model_policy.changed', null, null, policy);
      return policy;
    });
    return this.status();
  }
  async resolve(
    task: TaskClass,
    request?: ExecutionRequest,
    scheduled = false,
    defaultChoice?: { family: string; model: string | null; effort: string | null },
  ): Promise<Assignment> {
    const policy = this.policy();
    const provider = this.provider(task, request?.provider, scheduled);
    const minimum = taskTiers[task];
    const requestedTier = request?.tier ?? minimum;
    if (
      levels.indexOf(requestedTier) < levels.indexOf(minimum) ||
      (requestedTier === 'uncle' && task !== 'bulk') ||
      (task === 'manager' && requestedTier !== 'postdoc')
    )
      throw new Conflict(
        `${task} work requires ${tierLabels[minimum]} or above. Uncles are reserved for explicit simple bulk work.`,
      );
    if (request?.difficulty === 'high' && levels.indexOf(requestedTier) < levels.indexOf('grad'))
      throw new Conflict('Difficult questions and calculations require a grad student or postdoc.');
    const choice =
      defaultChoice ??
      (task === 'manager'
        ? managerModelChoice(policy, provider)
        : policy.models[provider][requestedTier]);
    const pin = request?.model ?? choice.model;
    const catalog = await this.catalog(provider);
    if (this.closed)
      throw new Conflict('Model selection was cancelled while the app was stopping.');
    const selectedId = pin ?? latestFamily(catalog, choice.family)?.id;
    const selected = catalog.find((m) => m.id === selectedId);
    if (!selected)
      throw new Conflict(
        `${provider}: ${pin ? `model ${pin} is not available` : `no ${choice.family} model is available`} in the installed catalog for ${tierLabels[requestedTier]}. Refresh models or edit Model settings. No substitute was started.`,
      );
    const detected = Object.entries(modelFamilies).find(
      ([name, value]) => value.provider === provider && latestFamily([selected], name),
    );
    // Tier labels supplied by callers or saved slots cannot promote a known light model.
    // Unknown future/native names retain the caller's selection without guessed classification.
    const tier = detected?.[1].tier ?? requestedTier;
    if (
      levels.indexOf(tier) < levels.indexOf(minimum) ||
      (tier === 'uncle' && task !== 'bulk') ||
      (request?.difficulty === 'high' && levels.indexOf(tier) < levels.indexOf('grad'))
    )
      throw new Conflict(
        `${task} work requires ${tierLabels[minimum]} or above${request?.difficulty === 'high' ? ', and difficult work needs a grad student or postdoc' : ''}. Choose an appropriate model; a requested tier cannot promote a known lightweight model.`,
      );
    const effort = request?.effort ?? choice.effort ?? policyDefaultEffort(selected.efforts, tier);
    if (!effort || !selected.efforts.includes(effort))
      throw new Conflict(
        `The selected thinking level is unavailable for ${selected.label}. Update Model settings.`,
      );
    return assignmentSchema.parse({
      provider,
      model: selected.id,
      effort,
      difficulty: request?.difficulty ?? 'unspecified',
      source: request?.model || request?.effort ? 'manager_selection' : 'model_policy',
      reason:
        request?.reason ??
        `${tierLabels[tier]} for ${task}; ${pin ? 'exact model pin' : `latest available ${choice.family}`}.`,
      policyRevision: String(policy.revision),
      tier,
      taskClass: task,
    });
  }
  /** Project presets select families centrally; explicit native model choices remain available. */
  async resolveWorker(
    projectId: string,
    role: Role,
    request?: ExecutionRequest,
  ): Promise<Assignment> {
    const task = request?.taskClass ?? 'reasoning';
    const minimum = taskTiers[task];
    if (
      request?.tier &&
      (levels.indexOf(request.tier) < levels.indexOf(minimum) ||
        (request.tier === 'uncle' && task !== 'bulk'))
    )
      throw new Conflict(
        `${task} work requires ${tierLabels[minimum]} or above. Uncles are reserved for explicit simple bulk work.`,
      );
    // Existing installations keep their saved central routing until a project preset is chosen.
    if (!this.store.getSetting(`project-workflow:${projectId}`)) return this.resolve(task, request);
    const workflow = projectWorkflow(this.store, projectId);
    const purpose = role === 'reviewer' ? 'review' : task === 'bulk' ? 'bulk' : 'research';
    let choice = workerDefault(workflow, purpose);
    // Stay within this project's provider choice for routine and more demanding work.
    // Legacy projects retain prior routing until their settings are explicitly changed.
    if (['calculation', 'orchestration', 'routine'].includes(task)) {
      if (!workflow.familyDefaults) return this.resolve(task, request);
      const provider = request?.provider ?? choice.provider;
      const tier = request?.tier ?? taskTiers[task];
      const minimum = projectFamilyDefault(workflow, provider, tier);
      if (task === 'routine') choice = minimum ?? choice;
      else {
        const model = choice.model ?? choice.family;
        const detected = Object.entries(modelFamilies).find(
          ([family, slot]) =>
            slot.provider === provider &&
            latestFamily([{ id: model, label: model, isDefault: false }], family),
        );
        if (
          provider !== choice.provider ||
          !detected ||
          levels.indexOf(detected[1].tier) < levels.indexOf(tier)
        )
          choice = minimum ?? choice;
      }
      return this.resolve(
        task,
        {
          ...request,
          mode: request?.mode ?? 'automatic',
          difficulty: request?.difficulty ?? 'unspecified',
          provider,
        },
        false,
        choice,
      );
    }
    const provider = request?.provider ?? choice.provider;
    if (!this.policy().enabledProviders.includes(provider))
      throw new Conflict(
        `Enable ${provider} or choose a project preset using your connected provider.`,
      );
    if (provider !== choice.provider) {
      const tier = request?.tier ?? (purpose === 'bulk' ? 'undergrad' : 'grad');
      choice = projectFamilyDefault(workflow, provider, tier) ?? {
        provider,
        ...this.policy().models[provider][tier],
      };
    }
    const catalog = await this.catalog(provider);
    const select = (candidate: typeof choice, exact?: string) => {
      const pin = exact ?? candidate.model;
      const selected = pin
        ? catalog.find((model) => model.id === pin)
        : latestFamily(catalog, candidate.family);
      if (!selected)
        throw new Conflict(
          `No available ${pin ?? candidate.family} model. Refresh models or change this project's model selection; no substitute was started.`,
        );
      return selected;
    };
    const detectedTier = (model: Model) =>
      Object.entries(modelFamilies).find(
        ([name, value]) => value.provider === provider && latestFamily([model], name),
      )?.[1].tier;
    let selected = select(choice, request?.model ?? undefined);
    let knownTier = detectedTier(selected);
    if (request?.tier && knownTier && levels.indexOf(knownTier) < levels.indexOf(request.tier)) {
      if (request.model)
        throw new Conflict(
          `The selected model is below the requested ${tierLabels[request.tier]} tier. Choose a stronger model or lower the requested tier.`,
        );
      choice = projectFamilyDefault(workflow, provider, request.tier) ?? {
        provider,
        ...this.policy().models[provider][request.tier],
      };
      selected = select(choice);
      knownTier = detectedTier(selected);
      if (knownTier && levels.indexOf(knownTier) < levels.indexOf(request.tier))
        throw new Conflict(
          `The selected model is below the requested ${tierLabels[request.tier]} tier. Choose a stronger model or lower the requested tier.`,
        );
    }
    // A caller's requested tier cannot promote a known lightweight model.
    const tier = knownTier ?? request?.tier ?? 'grad';
    if (
      (purpose !== 'bulk' && tier === 'uncle') ||
      (purpose === 'review' && levels.indexOf(tier) < levels.indexOf('grad')) ||
      (request?.difficulty === 'high' && levels.indexOf(tier) < levels.indexOf('grad'))
    )
      throw new Conflict(
        'Use a reasoning model for reviews or difficult work. Light models are for explicit bulk work only.',
      );
    const effort = request?.effort ?? choice.effort ?? workerDefaultEffort(selected.efforts, tier);
    if (!effort || !selected.efforts.includes(effort))
      throw new Conflict('Choose an available thinking level for this model.');
    return assignmentSchema.parse({
      provider,
      model: selected.id,
      effort,
      tier,
      taskClass: task,
      difficulty: request?.difficulty ?? 'unspecified',
      source: request?.model || request?.effort ? 'manager_selection' : 'model_policy',
      reason:
        request?.reason ??
        `${workflow.providerMix}, ${workflow.spending}: ${purpose}, latest available ${choice.family}.`,
      policyRevision: `${this.policy().revision}:${workflow.revision}`,
    });
  }
  defaultQuarkChoice() {
    const enabled = this.policy().enabledProviders;
    const provider = enabled.includes('claude') ? 'claude' : 'codex';
    return quarkModelChoiceSchema.parse({ provider, family: quarkDefaultFamilies[provider] });
  }
  async resolveQuark(raw: unknown) {
    const choice = quarkModelChoiceSchema.parse(raw);
    const catalog = await this.catalog(choice.provider);
    const model = choice.model ?? latestFamily(catalog, choice.family)?.id;
    if (!model || !catalog.some((item) => item.id === model))
      throw new Conflict(
        'The QUARK model is unavailable. Choose a model from this computer’s current catalog; no substitute was started.',
      );
    return this.resolve('orchestration', {
      mode: 'automatic',
      provider: choice.provider,
      model,
      ...(choice.effort ? { effort: choice.effort } : {}),
      difficulty: 'high',
      reason: 'Central QUARK coordinator model selection.',
    });
  }
  /** Freeze each admitted run; refresh defaults only between turns on the SAME provider. */
  async prepare(agent: PrivateAgent, runId?: string) {
    const follow = this.store.getSetting(`model-policy:follow:${agent.id}`) === true;
    if (
      agent.nativeRootId ||
      (runId && this.store.getSetting(`model-policy:run:${runId}`)) ||
      (!follow && (agent.threadId || agent.model || agent.assignment)) ||
      (follow && !runId && agent.model)
    )
      return agent;
    const selection = {
      mode: 'automatic' as const,
      provider: agent.provider,
      ...(agent.assignment?.tier ? { tier: agent.assignment.tier } : {}),
      difficulty: agent.assignment?.difficulty ?? ('unspecified' as const),
    };
    const assignment =
      agent.taskId && agent.role !== 'manager'
        ? await this.resolveWorker(agent.projectId, agent.role, {
            ...selection,
            taskClass:
              agent.assignment?.taskClass === 'manager' ? 'reasoning' : agent.assignment?.taskClass,
          })
        : await this.resolve(
            agent.assignment?.taskClass ?? (agent.role === 'manager' ? 'manager' : 'reasoning'),
            {
              mode: 'automatic',
              provider: agent.provider,
              ...(agent.assignment?.tier ? { tier: agent.assignment.tier } : {}),
              difficulty: agent.assignment?.difficulty ?? 'unspecified',
            },
            false,
            agent.role === 'manager'
              ? projectManagerDefault(projectWorkflow(this.store, agent.projectId), agent.provider)
              : undefined,
          );
    return this.store.transaction(() => {
      if (this.store.agent(agent.id).updatedAt !== agent.updatedAt)
        throw new Conflict(
          'This conversation changed during model discovery. Retry with its current settings.',
        );
      this.store.setSetting(`model-policy:follow:${agent.id}`, true);
      if (runId) this.store.setSetting(`model-policy:run:${runId}`, assignment);
      const result = this.store.updateAgent(agent.id, {
        model: assignment.model,
        modelSelection: 'policy',
        effort: assignment.effort,
        assignment,
      });
      this.store.event('agent.model_resolved', agent.projectId, agent.id, {
        runId: runId ?? null,
        assignment,
      });
      return result;
    });
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending.values()]);
  }
  context() {
    return {
      ...this.policy(),
      taskTiers,
      rules:
        'Managers are postdocs. Routine checks use undergrads. Calculations, difficult questions and delegated orchestration use grad students or above. Only explicitly simple bulk tasks use uncles. Defaults use enabledProviders only; never assume the other provider is available. Explicit provider choices and existing conversation identities are preserved. Pick as I go requires an explicit provider on every new delegation; unattended checks use scheduledProvider. Exact pins override family defaults. Never switch saved providers or silently downgrade.',
    };
  }
}
