import { expect, it } from 'vitest';
import { mcpFormSchema, mcpFormOptions, parseMcpFormValues } from '@dock/shared';

const form = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  mcpFormSchema.parse({
    serverName: 'fixture',
    message: 'Provide fixture preferences',
    requestedSchema: { type: 'object', properties, required },
  });

it('validates every standard primitive, required fields, bounds and formats without coercion', () => {
  const request = form({
    text: { type: 'string', minLength: 2, maxLength: 3 },
    count: { type: 'integer', minimum: 0, maximum: 4 },
    amount: { type: 'number', minimum: -1, maximum: 1 },
    enabled: { type: 'boolean', default: true },
    email: { type: 'string', format: 'email' },
    uri: { type: 'string', format: 'uri' },
    date: { type: 'string', format: 'date' },
    time: { type: 'string', format: 'date-time' },
  });
  const values = {
    text: '🌱🌱',
    count: 0,
    amount: 0.5,
    enabled: false,
    email: 'fixture@example.invalid',
    uri: 'https://example.invalid',
    date: '2026-09-08',
    time: '2026-09-08T12:30:00-04:00',
  };
  expect(parseMcpFormValues(request, values)).toEqual(values);
  expect(() => parseMcpFormValues(request, {})).toThrow('required');
  for (const changes of [
    { text: 'x' },
    { text: 'four' },
    { count: '0' },
    { count: 1.5 },
    { count: 5 },
    { amount: 2 },
    { amount: NaN },
    { enabled: 'false' },
    { email: 'invalid' },
    { uri: 'relative' },
    { date: '2026-02-30' },
    { time: '12:30' },
    { unexpected: 'not requested' },
  ])
    expect(() => parseMcpFormValues(request, { ...values, ...changes })).toThrow();
  expect(
    parseMcpFormValues(form({ optional: { type: 'string', default: 'suggestion' } }, []), {}),
  ).toEqual({});
});

it('preserves enum values separately from labels, including legacy, empty and multiple choices', () => {
  const request = form({
    single: {
      type: 'string',
      oneOf: [
        { const: '', title: 'None' },
        { const: 'a', title: 'Alpha' },
      ],
    },
    legacy: { type: 'string', enum: ['x', 'y'], enumNames: ['First', 'Second'] },
    many: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: {
        anyOf: [
          { const: 'a', title: 'Alpha' },
          { const: 'b', title: 'Beta' },
        ],
      },
    },
    plain: { type: 'array', items: { type: 'string', enum: ['x', 'y'] } },
  });
  expect(mcpFormOptions(request.requestedSchema.properties.legacy)).toEqual([
    { value: 'x', label: 'First' },
    { value: 'y', label: 'Second' },
  ]);
  const values = { single: '', legacy: 'x', many: ['a'], plain: [] };
  expect(parseMcpFormValues(request, values)).toEqual(values);
  for (const changes of [
    { single: 'Alpha' },
    { legacy: 'First' },
    { many: [] },
    { many: ['a', 'a'] },
    { many: ['foreign'] },
    { plain: 'x' },
  ])
    expect(() => parseMcpFormValues(request, { ...values, ...changes })).toThrow();
});

it('rejects unsupported, oversized, contradictory or prototype-bearing schemas instead of weakening them', () => {
  for (const field of [
    { type: 'object', properties: {} },
    { type: 'string', pattern: '(a+)+$' },
    { type: 'string', $ref: 'https://example.invalid/schema' },
    { type: 'string', format: 'password' },
    { type: 'string', minLength: 3, maxLength: 2 },
    { type: 'integer', minimum: 2, maximum: 1 },
    { type: 'string', enum: ['a', 'a'] },
    { type: 'string', enumNames: ['a'] },
    { type: 'array', minItems: 101, items: { type: 'string', enum: ['a'] } },
  ])
    expect(() => form({ field })).toThrow();
  expect(() => form({}, ['missing'])).toThrow();
  expect(() =>
    form(
      Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [String(index), { type: 'string' }]),
      ),
    ),
  ).toThrow();
  expect(() => form(JSON.parse('{"__proto__":{"type":"string"}}'))).toThrow();
  expect(() => parseMcpFormValues(form({}), JSON.parse('{"__proto__":"value"}'))).toThrow();
});
