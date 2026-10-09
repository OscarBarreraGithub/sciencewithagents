import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  clusterWorkspaceControlSchema,
  inspectSchema,
  jobEstimateSchema,
  roleSchema,
  slurmReviewToolSchema,
} from '@dock/shared';
import { toolsFor } from './charters.js';
import { slurmReviewToolDefinition } from './slurm-review.js';
import { toolInputSchema } from './tool-schema.js';

const tool = (name: string) => toolsFor('manager').find((item) => item.name === name)!;

describe('advertised coordination tool contracts', () => {
  it('advertises and explains the single dock_inspect target, preserving its modifiers', () => {
    const schema = tool('dock_inspect').inputSchema as { description?: string };
    expect(schema.description).toContain('Choose one inspection target per call');
    expect(tool('dock_inspect').description).toContain('separate calls');
    // The actual rejected Groupchat input combined two targets.
    const combined = inspectSchema.safeParse({
      workItems: { includeDone: false, limit: 30 },
      ownerRequests: { includeHandled: false, limit: 20 },
    });
    expect(combined.success).toBe(false);
    expect(combined.error!.issues[0]!.message).toContain('Make separate dock_inspect calls');
    expect(inspectSchema.parse({})).toEqual({});
    // goal is returned before other targets, so it must not combine silently.
    expect(schema.description).toContain('goal');
    expect(inspectSchema.parse({ goal: true })).toEqual({ goal: true });
    for (const raw of [
      { goal: true, capacity: true },
      { goal: true, workItems: {} },
      { goal: true, taskId: randomUUID() },
    ])
      expect(inspectSchema.safeParse(raw).success).toBe(false);
    const taskId = randomUUID();
    expect(inspectSchema.parse({ taskId, changes: true })).toEqual({ taskId, changes: true });
    expect(inspectSchema.parse({ models: true, provider: 'claude' })).toEqual({
      models: true,
      provider: 'claude',
    });
  });
  it('accepts a legacy zero tokenBudget without loosening meaningful estimates', () => {
    expect(jobEstimateSchema.parse({ tokenBudget: 0 }).tokenBudget).toBe(0);
    for (const raw of [
      { tokenBudget: -1 },
      { tokenBudget: 100_000_001 },
      { tokenBudget: 1.5 },
      { expectedTokens: 99 },
    ])
      expect(jobEstimateSchema.safeParse(raw).success).toBe(false);
    for (const name of ['dock_task_create', 'dock_schedule'])
      expect(tool(name).description.toLowerCase()).toContain('omit legacy tokenbudget');
  });
  it('gives every advertised schema an object root without loosening union branches', () => {
    for (const role of roleSchema.options)
      for (const item of toolsFor(role))
        expect([item.name, item.inputSchema.type]).toEqual([item.name, 'object']);
    // Zod emits bare anyOf/oneOf roots for these unions; Claude rejects the whole MCP server.
    expect(z.toJSONSchema(slurmReviewToolSchema).type).toBeUndefined();
    expect(z.toJSONSchema(clusterWorkspaceControlSchema).type).toBeUndefined();
    const slurm = slurmReviewToolDefinition.inputSchema;
    expect(slurm.type).toBe('object');
    expect(slurm.anyOf).toHaveLength(2);
    for (const branch of slurm.anyOf as Record<string, unknown>[])
      expect(branch).toMatchObject({ type: 'object', additionalProperties: false });
    const workspace = toolInputSchema(clusterWorkspaceControlSchema);
    expect(workspace.type).toBe('object');
    expect(workspace.oneOf).toHaveLength(3);
    const reviewId = randomUUID();
    expect(slurmReviewToolSchema.parse({ reviewId })).toEqual({ reviewId });
    expect(slurmReviewToolSchema.parse({ command: 'sbatch run.sh' })).toEqual({
      command: 'sbatch run.sh',
    });
    for (const raw of [{}, { command: 'sbatch run.sh', reviewId }, { reviewId, extra: true }])
      expect(slurmReviewToolSchema.safeParse(raw).success).toBe(false);
    expect(clusterWorkspaceControlSchema.parse({ action: 'renew', hours: 2 })).toEqual({
      action: 'renew',
      hours: 2,
    });
    for (const raw of [{}, { action: 'renew' }, { action: 'stop', hours: 2 }])
      expect(clusterWorkspaceControlSchema.safeParse(raw).success).toBe(false);
    expect(() => toolInputSchema(z.string())).toThrow('JSON object');
  });
});
