import { toDataFrame } from '../../dataframe/processDataFrame';
import { FieldType, Field } from '../../types/dataFrame';
import { DataTransformerConfig } from '../../types/transformations';
import { mockTransformationsRegistry } from '../../utils/tests/mockTransformationsRegistry';
import { transformDataFrame } from '../transformDataFrame';

import { deduplicateRowsTransformer, DeduplicateRowsTransformerOptions } from './deduplicateRows';
import { DataTransformerID } from './ids';

/**
 * The shared five-row fixture is produced per call rather than held in a shared constant: some cases
 * assert object identity with `toBe`, so no frame may be observed — or mutated — by another case.
 */
const getTestSeries = () =>
  toDataFrame({
    name: 'A',
    fields: [
      { name: 'time', type: FieldType.time, values: [1, 2, 3, 4, 5] },
      { name: 'host', type: FieldType.string, values: ['a', 'a', 'b', 'a', 'b'] },
      { name: 'value', type: FieldType.number, values: [10, 10, 20, 10, 20] },
    ],
  });

describe('Deduplicate rows transformer', () => {
  beforeAll(() => {
    mockTransformationsRegistry([deduplicateRowsTransformer]);
  });

  it('should keep the first occurrence when deduplicating by field', async () => {
    const testSeries = getTestSeries();

    const cfg: DataTransformerConfig<DeduplicateRowsTransformerOptions> = {
      id: DataTransformerID.deduplicateRows,
      options: {
        field: 'host',
        keep: 'first',
      },
    };

    await expect(transformDataFrame([cfg], [testSeries])).toEmitValuesWith((received) => {
      const result = received[0];
      const expected: Field[] = [
        { name: 'time', type: FieldType.time, state: { calcs: undefined }, values: [1, 3], config: {} },
        { name: 'host', type: FieldType.string, state: { calcs: undefined }, values: ['a', 'b'], config: {} },
        { name: 'value', type: FieldType.number, state: { calcs: undefined }, values: [10, 20], config: {} },
      ];

      expect(result[0].fields).toEqual(expected);
      expect(result[0].length).toBe(2);
    });
  });

  // Retains the highest original index per key, yet still emits ascending: rows 3 and 4, not 4 and 3.
  it('should keep the last occurrence when deduplicating by field', async () => {
    const testSeries = getTestSeries();

    const cfg: DataTransformerConfig<DeduplicateRowsTransformerOptions> = {
      id: DataTransformerID.deduplicateRows,
      options: {
        field: 'host',
        keep: 'last',
      },
    };

    await expect(transformDataFrame([cfg], [testSeries])).toEmitValuesWith((received) => {
      const result = received[0];
      const expected: Field[] = [
        { name: 'time', type: FieldType.time, state: { calcs: undefined }, values: [4, 5], config: {} },
        { name: 'host', type: FieldType.string, state: { calcs: undefined }, values: ['a', 'b'], config: {} },
        { name: 'value', type: FieldType.number, state: { calcs: undefined }, values: [10, 20], config: {} },
      ];

      expect(result[0].fields).toEqual(expected);
      expect(result[0].length).toBe(2);
    });
  });

  // Empty options also prove `defaultOptions` participates: the merged `keep` must resolve to 'first'.
  it('should use every field value as the key when no field is configured', async () => {
    const testSeries = toDataFrame({
      name: 'A',
      fields: [
        { name: 'host', type: FieldType.string, values: ['x', 'y', 'x', 'x', 'y'] },
        { name: 'code', type: FieldType.number, values: [200, 200, 200, 500, 200] },
      ],
    });

    const cfg: DataTransformerConfig<DeduplicateRowsTransformerOptions> = {
      id: DataTransformerID.deduplicateRows,
      options: {},
    };

    await expect(transformDataFrame([cfg], [testSeries])).toEmitValuesWith((received) => {
      const result = received[0];
      const expected: Field[] = [
        { name: 'host', type: FieldType.string, state: { calcs: undefined }, values: ['x', 'y', 'x'], config: {} },
        { name: 'code', type: FieldType.number, state: { calcs: undefined }, values: [200, 200, 500], config: {} },
      ];

      expect(result[0].fields).toEqual(expected);
      expect(result[0].length).toBe(3);
    });
  });

  // The expectations below deliberately omit `state`, which fields built by `toDataFrame` never carry.
  // Only returning the original frame reference satisfies that, so this asserts passthrough identity.
  it('should return the frame unchanged when the configured field does not exist', async () => {
    const testSeries = getTestSeries();

    const cfg: DataTransformerConfig<DeduplicateRowsTransformerOptions> = {
      id: DataTransformerID.deduplicateRows,
      options: {
        field: 'nope',
      },
    };

    await expect(transformDataFrame([cfg], [testSeries])).toEmitValuesWith((received) => {
      const result = received[0];
      const expected: Field[] = [
        { name: 'time', type: FieldType.time, values: [1, 2, 3, 4, 5], config: {} },
        { name: 'host', type: FieldType.string, values: ['a', 'a', 'b', 'a', 'b'], config: {} },
        { name: 'value', type: FieldType.number, values: [10, 10, 20, 10, 20], config: {} },
      ];

      expect(result[0].fields).toEqual(expected);
      expect(result[0].length).toBe(5);
    });
  });

  // Regression guard the `keep: 'last'` oracle above cannot provide: here the elected owners are rows
  // 3 then 2 in key-first-appearance order, so emitting them unsorted would yield ['a','b'] / [4, 3].
  it('should emit kept rows in ascending original order when keeping the last occurrence', async () => {
    const testSeries = toDataFrame({
      name: 'A',
      fields: [
        { name: 'host', type: FieldType.string, values: ['a', 'b', 'b', 'a'] },
        { name: 'value', type: FieldType.number, values: [1, 2, 3, 4] },
      ],
    });

    const cfg: DataTransformerConfig<DeduplicateRowsTransformerOptions> = {
      id: DataTransformerID.deduplicateRows,
      options: {
        field: 'host',
        keep: 'last',
      },
    };

    await expect(transformDataFrame([cfg], [testSeries])).toEmitValuesWith((received) => {
      const result = received[0];
      const expected: Field[] = [
        { name: 'host', type: FieldType.string, state: { calcs: undefined }, values: ['b', 'a'], config: {} },
        { name: 'value', type: FieldType.number, state: { calcs: undefined }, values: [3, 4], config: {} },
      ];

      expect(result[0].fields).toEqual(expected);
      expect(result[0].length).toBe(2);
    });
  });

  // Keys compare raw values, so `1` never collides with `'1'` the way a joined string key would.
  it('should treat values of different types as distinct row keys', async () => {
    const testSeries = toDataFrame({
      name: 'A',
      fields: [{ name: 'value', type: FieldType.other, values: [1, '1', 1] }],
    });

    const cfg: DataTransformerConfig<DeduplicateRowsTransformerOptions> = {
      id: DataTransformerID.deduplicateRows,
      options: {},
    };

    await expect(transformDataFrame([cfg], [testSeries])).toEmitValuesWith((received) => {
      const result = received[0];
      const expected: Field[] = [
        { name: 'value', type: FieldType.other, state: { calcs: undefined }, values: [1, '1'], config: {} },
      ];

      expect(result[0].fields).toEqual(expected);
      expect(result[0].length).toBe(2);
    });
  });

  it('should treat null as equal to null while keeping unrelated values apart', async () => {
    const testSeries = toDataFrame({
      name: 'A',
      fields: [{ name: 'value', type: FieldType.other, values: [null, 0, null, ''] }],
    });

    const cfg: DataTransformerConfig<DeduplicateRowsTransformerOptions> = {
      id: DataTransformerID.deduplicateRows,
      options: {},
    };

    await expect(transformDataFrame([cfg], [testSeries])).toEmitValuesWith((received) => {
      const result = received[0];
      const expected: Field[] = [
        { name: 'value', type: FieldType.other, state: { calcs: undefined }, values: [null, 0, ''], config: {} },
      ];

      expect(result[0].fields).toEqual(expected);
      expect(result[0].length).toBe(3);
    });
  });

  // Both frames travel through one call, so this also proves keys never span frames.
  it('should return duplicate-free frames and empty frames unchanged', async () => {
    const uniqueSeries = toDataFrame({
      name: 'A',
      fields: [{ name: 'value', type: FieldType.number, values: [1, 2, 3] }],
    });

    const emptySeries = toDataFrame({
      name: 'B',
      fields: [{ name: 'value', type: FieldType.number, values: [] }],
    });

    const cfg: DataTransformerConfig<DeduplicateRowsTransformerOptions> = {
      id: DataTransformerID.deduplicateRows,
      options: {},
    };

    await expect(transformDataFrame([cfg], [uniqueSeries, emptySeries])).toEmitValuesWith((received) => {
      const result = received[0];

      expect(result[0]).toBe(uniqueSeries);
      expect(result[0].length).toBe(3);
      expect(result[1]).toBe(emptySeries);
      expect(result[1].length).toBe(0);
    });
  });
});
