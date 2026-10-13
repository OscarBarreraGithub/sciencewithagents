import { providerDefaultEffort, type Model } from '@dock/shared';
import type { ClaudeModel } from './claude-session.js';
import { Conflict } from './store.js';
/** Preserve native aliases, exact resolved versions and optional effort metadata. */
export function claudeModelCatalog(models: ClaudeModel[]): Model[] {
  // Effort is optional native metadata, not a prerequisite for model access.
  // Unreported/unsupported levels leave the provider's own behavior untouched.
  const catalog = models.map((model) => ({
    id: model.value,
    label: model.displayName,
    isDefault: model.value === 'default',
    efforts: [
      ...new Set([
        ...(model.supportsEffort !== false ? (model.supportedEffortLevels ?? []) : []),
        providerDefaultEffort,
      ]),
    ],
  }));
  // Keep rolling aliases, and also expose provider-reported concrete IDs for exact pins.
  // Never invent release identifiers or turn a context-size alias into a different variant.
  for (const native of models) {
    if (
      !native.resolvedModel ||
      native.value.includes('[') ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(native.resolvedModel) ||
      catalog.some((model) => model.id === native.resolvedModel)
    )
      continue;
    const labelled =
      models.find(
        (model) =>
          model.resolvedModel === native.resolvedModel &&
          model.value !== 'default' &&
          !model.value.includes('['),
      ) ?? native;
    const alias = catalog.find((model) => model.id === labelled.value)!;
    catalog.push({
      ...alias,
      id: native.resolvedModel,
      label: `${labelled.displayName} (exact version)`,
      isDefault: false,
    });
  }
  if (!catalog.length)
    throw new Conflict(
      'This Claude installation did not report usable model settings. Nothing was started.',
    );
  return catalog;
}
