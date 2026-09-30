import { z } from 'zod';

// MCP 2025-11-25 typed elicitation, as exposed by the installed Codex protocol.
// No schema references, executable patterns, nested objects or remote schema loading.
const label = z.string().max(2000);
const choice = z.string().max(8000);
const count = z.number().int().min(0).max(8000);
const names = z
  .string()
  .min(1)
  .max(200)
  .refine((name) => !['__proto__', 'prototype', 'constructor'].includes(name));
// Check raw keys before Zod's record parser can discard a prototype-bearing key.
const namedRecord = <T extends z.ZodType>(value: T) =>
  z
    .unknown()
    .refine((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
      if (![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return false;
      const keys = Object.keys(raw);
      return keys.length <= 32 && keys.every((name) => names.safeParse(name).success);
    })
    .pipe(z.record(names, value));
const options = z
  .array(choice)
  .min(1)
  .max(100)
  .refine((values) => new Set(values).size === values.length);
const titled = z
  .array(z.object({ const: choice, title: label }).strict())
  .min(1)
  .max(100)
  .refine((values) => new Set(values.map((value) => value.const)).size === values.length);
const description = { title: label.optional(), description: label.optional() };
export const mcpFormFieldSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('string'),
        ...description,
        minLength: count.optional(),
        maxLength: count.optional(),
        format: z.enum(['email', 'uri', 'date', 'date-time']).optional(),
        enum: options.optional(),
        enumNames: z.array(label).max(100).optional(),
        oneOf: titled.optional(),
        default: choice.optional(),
      })
      .strict(),
    z
      .object({
        type: z.enum(['number', 'integer']),
        ...description,
        minimum: z.number().optional(),
        maximum: z.number().optional(),
        default: z.number().optional(),
      })
      .strict(),
    z
      .object({ type: z.literal('boolean'), ...description, default: z.boolean().optional() })
      .strict(),
    z
      .object({
        type: z.literal('array'),
        ...description,
        minItems: count.optional(),
        maxItems: count.optional(),
        items: z.union([
          z.object({ type: z.literal('string'), enum: options }).strict(),
          z.object({ anyOf: titled }).strict(),
        ]),
        default: z.array(choice).max(100).optional(),
      })
      .strict(),
  ])
  .refine((field) => {
    if (field.type === 'string')
      return (
        !(field.enum && field.oneOf) &&
        (!field.enumNames || field.enumNames.length === field.enum?.length) &&
        (field.minLength ?? 0) <= (field.maxLength ?? 8000)
      );
    if (field.type === 'array')
      return (field.minItems ?? 0) <= Math.min(field.maxItems ?? 100, 100);
    if (field.type === 'number' || field.type === 'integer')
      return (field.minimum ?? -Infinity) <= (field.maximum ?? Infinity);
    return true;
  });
export const mcpRequestedSchema = z
  .object({
    $schema: z.string().max(1000).optional(),
    type: z.literal('object'),
    properties: namedRecord(mcpFormFieldSchema),
    required: z.array(names).max(32).optional(),
    additionalProperties: z.literal(false).optional(),
  })
  .strict()
  .refine((schema) =>
    (schema.required ?? []).every((name) => Object.hasOwn(schema.properties, name)),
  );
export const mcpFormSchema = z
  .object({
    serverName: z.string().min(1).max(200),
    message: z.string().max(2000),
    requestedSchema: mcpRequestedSchema,
  })
  .strict();
export const mcpFormValuesSchema = namedRecord(
  z.union([choice, z.number(), z.boolean(), z.array(choice).max(100)]),
);
export type McpForm = z.infer<typeof mcpFormSchema>;
export type McpFormField = z.infer<typeof mcpFormFieldSchema>;
export type McpFormValues = z.infer<typeof mcpFormValuesSchema>;

export function mcpFormOptions(field: McpFormField): { value: string; label: string }[] | null {
  if (field.type === 'array')
    return 'enum' in field.items
      ? field.items.enum.map((value) => ({ value, label: value }))
      : field.items.anyOf.map((option) => ({ value: option.const, label: option.title }));
  if (field.type !== 'string') return null;
  if (field.enum)
    return field.enum.map((value, index) => ({ value, label: field.enumNames?.[index] ?? value }));
  return field.oneOf?.map((option) => ({ value: option.const, label: option.title })) ?? null;
}

/** Validate on the server too; browser controls and schema defaults cannot authorize a reply. */
export function parseMcpFormValues(form: McpForm, raw: unknown): McpFormValues {
  const parsed = mcpFormValuesSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error('Form answers must be bounded text, numbers, booleans or choices.');
  const values = parsed.data,
    schema = form.requestedSchema;
  if (Object.keys(values).some((name) => !Object.hasOwn(schema.properties, name)))
    throw new Error('The answer contains a field that was not requested.');
  for (const [name, field] of Object.entries(schema.properties)) {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    const invalid = (reason: string): never => {
      throw new Error(`${field.title ?? name}: ${reason}`);
    };
    if (value === undefined) {
      if (schema.required?.includes(name)) invalid('an answer is required.');
      continue;
    }
    const choices = mcpFormOptions(field);
    if (field.type === 'string') {
      if (typeof value !== 'string') invalid('enter text.');
      const text = value as string;
      if ([...text].length < (field.minLength ?? 0) || [...text].length > (field.maxLength ?? 8000))
        invalid('text length is outside the requested bounds.');
      if (choices && !choices.some((option) => option.value === text))
        invalid('choose a listed option.');
      const formats = {
        email: z.email(),
        uri: z.url(),
        date: z.iso.date(),
        'date-time': z.iso.datetime({ offset: true }),
      };
      if (field.format && !formats[field.format].safeParse(text).success)
        invalid(`enter a valid ${field.format}.`);
    } else if (field.type === 'number' || field.type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value)) invalid('enter a number.');
      if (field.type === 'integer' && !Number.isSafeInteger(value))
        invalid('enter a safe whole number.');
      if (
        (value as number) < (field.minimum ?? -Infinity) ||
        (value as number) > (field.maximum ?? Infinity)
      )
        invalid('number is outside the requested bounds.');
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') invalid('choose Yes or No.');
    } else if (field.type === 'array') {
      if (!Array.isArray(value)) invalid('choose from the listed options.');
      const selected = value as string[];
      if (
        new Set(selected).size !== selected.length ||
        selected.some((item) => !choices?.some((option) => option.value === item))
      )
        invalid('choose distinct listed options.');
      if (selected.length < (field.minItems ?? 0) || selected.length > (field.maxItems ?? 100))
        invalid('selection count is outside the requested bounds.');
    }
  }
  return values;
}
