import { describe, expect, it } from 'vitest';
import { validateJsonSchema } from './json-schema-lite.js';

/** migration 0013 的 native.ParameterControl config_schema（原樣） */
const PARAMETER_CONTROL = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['parameters'],
  additionalProperties: false,
  properties: {
    parameters: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        required: ['id', 'label', 'min', 'max', 'step'],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          unit: { type: 'string' },
          min: { type: 'number' },
          max: { type: 'number' },
          step: { type: 'number' },
        },
      },
    },
    instructions: { type: 'string' },
  },
};

const paths = (schema: unknown, value: unknown) => validateJsonSchema(schema, value).violations.map((v) => v.path);

describe('validateJsonSchema (C5)', () => {
  it('accepts a valid ParameterControl config', () => {
    expect(validateJsonSchema(PARAMETER_CONTROL, { parameters: [{ id: 'p', label: '溫度', min: 0, max: 100, step: 1 }] })).toEqual({ violations: [], unsupported: [] });
  });

  it('reports missing, extra and mistyped fields with JSON pointers', () => {
    expect(paths(PARAMETER_CONTROL, {})).toEqual(['/parameters']);
    expect(paths(PARAMETER_CONTROL, { parameters: [{ id: 'p', label: 'x', min: '0', max: 1, step: 1, color: 'red' }], extra: true })).toEqual([
      '/parameters/0/min',
      '/parameters/0/color',
      '/extra',
    ]);
    expect(paths(PARAMETER_CONTROL, { parameters: [] })).toEqual(['/parameters']);
    expect(paths(PARAMETER_CONTROL, [])).toEqual(['']);
  });

  it('supports type unions, enum, const and numeric / length bounds', () => {
    const s = {
      type: 'object',
      properties: {
        score: { type: ['number', 'null'], minimum: 0, maximum: 10 },
        status: { enum: ['passed', 'failed'] },
        v: { const: 1 },
        name: { type: 'string', minLength: 2, maxLength: 3 },
      },
    };
    expect(paths(s, { score: null, status: 'passed', v: 1, name: '王小' })).toEqual([]);
    expect(paths(s, { score: 11, status: 'ok', v: 2, name: '王小明好' })).toEqual(['/score', '/status', '/v', '/name']);
  });

  it('flags unsupported keywords instead of silently passing', () => {
    expect(validateJsonSchema({ type: 'string', pattern: '^(a+)+$', oneOf: [] }, 'aaa').unsupported).toEqual(['oneOf', 'pattern']);
  });
});
