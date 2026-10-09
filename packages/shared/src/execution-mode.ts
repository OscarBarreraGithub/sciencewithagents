import { z } from 'zod';

/** Missing on retained records means managed; only fresh owner creation chooses direct. */
export const executionModeSchema = z.enum(['direct', 'managed']);
export type ExecutionMode = z.infer<typeof executionModeSchema>;
export const isDirectExecution = (agent: { executionMode?: ExecutionMode }) =>
  agent.executionMode === 'direct';
