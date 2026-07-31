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

    // This richer fixture exercises the rest of the keep-first contract: non-contiguous `nanos` selection,
    // metadata preservation, cached-calculation invalidation, and input immutability.
    const metaSeries = toDataFrame({
      name: 'A',
      fields: [
        {
          name: 'time',
          type: FieldType.time,
          values: [100, 100, 200, 200],
          nanos: [11, 22, 33, 44],
          config: { unit: 'ns' },
          labels: { host: 'a' },
        },
        { name: 'value', type: FieldType.number, values: [1, 2, 3, 4], config: { decimals: 2 } },
      ],
    });

    // `createDataFrame` strips `state` from the fields it builds, so the cached calcs that this
    // transformation has to invalidate are attached to the fixture here.
    metaSeries.fields[0].state = { displayName: 'time', calcs: { sum: 600 } };
    metaSeries.fields[1].state = { calcs: { sum: 10 } };

    const originalTimeField = metaSeries.fields[0];
    const originalValues = originalTimeField.values;
    const originalNanos = originalTimeField.nanos;
    const originalState = originalTimeField.state;

    const metaCfg: DataTransformerConfig<DeduplicateRowsTransformerOptions> = {
      id: DataTransformerID.deduplicateRows,
      options: {
        field: 'time',
        keep: 'first',
      },
    };

    await expect(transformDataFrame([metaCfg], [metaSeries])).toEmitValuesWith((received) => {
      const result = received[0];
      const timeField = result[0].fields[0];
      // Rows 0 and 2 are retained, so `nanos` must read [11, 33]: slicing would yield [11, 22] and leaving
      // the array unfiltered would yield all four. `value` carries no `nanos` and must not acquire one.
      const expected: Field[] = [
        {
          name: 'time',
          type: FieldType.time,
          state: { displayName: 'time', calcs: undefined },
          values: [100, 200],
          nanos: [11, 33],
          config: { unit: 'ns' },
          labels: { host: 'a' },
        },
        {
          name: 'value',
          type: FieldType.number,
          state: { calcs: undefined },
          values: [1, 3],
          config: { decimals: 2 },
        },
      ];

      expect(result[0].fields).toEqual(expected);
      expect(result[0].length).toBe(2);
      expect(timeField.nanos?.length).toBe(timeField.values.length);

      // Every row-aligned container is a fresh object, so nothing this transformation writes is written
      // through to a structure the caller still holds.
      expect(result[0]).not.toBe(metaSeries);
      expect(timeField).not.toBe(originalTimeField);
      expect(timeField.values).not.toBe(originalValues);
      expect(timeField.nanos).not.toBe(originalNanos);
      expect(timeField.state).not.toBe(originalState);

      // The caller-owned frame remains unchanged, including its cached calculations.
      expect(metaSeries.length).toBe(4);
      expect(metaSeries.fields[0].values).toEqual([100, 100, 200, 200]);
      expect(metaSeries.fields[0].nanos).toEqual([11, 22, 33, 44]);
      expect(metaSeries.fields[0].state).toEqual({ displayName: 'time', calcs: { sum: 600 } });
      expect(metaSeries.fields[1].values).toEqual([1, 2, 3, 4]);
      expect(metaSeries.fields[1].state).toEqual({ calcs: { sum: 10 } });
    });
  });

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

  // Two descriptor contracts need independent assertions here. The transformer normalises every `keep`
  // other than 'last' to first-wins internally, so the emitted rows alone cannot verify `defaultOptions`.
  // Every config in this suite is built from the enum member, so the literal serialised id — the form a
  // saved dashboard uses — is likewise only pinned by asserting it directly.
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

    expect(DataTransformerID.deduplicateRows).toBe('deduplicateRows');
    expect(deduplicateRowsTransformer.defaultOptions).toEqual({ keep: 'first' });

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

  // Two independent protections cover the passthrough contract. The expectations omit `state`, which fields
  // built by `toDataFrame` never carry, so the reconstruction path — which always adds `state` — fails them.
  // The identity assertion then rejects the remaining hole: a clone whose fields stayed state-free.
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

      expect(result[0]).toBe(testSeries);
      expect(result[0].fields).toEqual(expected);
      expect(result[0].length).toBe(5);
    });
  });

  // In this fixture the elected owners are rows 3 then 2 in key-first-appearance order, so emitting them
  // in that order would yield ['a','b'] / [4, 3]. The expectation below is rows 2 then 3, which is what
  // proves emission is restored to ascending original-index order.
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

    // Both row keys, (a, 200) and (b, 500), occur in both frames, and each frame retains them at a
    // different index, so only per-frame key state can produce both expectations below.
    const firstSeries = toDataFrame({
      name: 'C',
      fields: [
        { name: 'host', type: FieldType.string, values: ['a', 'a', 'b'] },
        { name: 'code', type: FieldType.number, values: [200, 200, 500] },
      ],
    });

    const secondSeries = toDataFrame({
      name: 'D',
      fields: [
        { name: 'host', type: FieldType.string, values: ['b', 'a', 'b'] },
        { name: 'code', type: FieldType.number, values: [500, 200, 500] },
      ],
    });

    await expect(transformDataFrame([cfg], [firstSeries, secondSeries])).toEmitValuesWith((received) => {
      const result = received[0];
      const expectedFirst: Field[] = [
        { name: 'host', type: FieldType.string, state: { calcs: undefined }, values: ['a', 'b'], config: {} },
        { name: 'code', type: FieldType.number, state: { calcs: undefined }, values: [200, 500], config: {} },
      ];
      const expectedSecond: Field[] = [
        { name: 'host', type: FieldType.string, state: { calcs: undefined }, values: ['b', 'a'], config: {} },
        { name: 'code', type: FieldType.number, state: { calcs: undefined }, values: [500, 200], config: {} },
      ];

      expect(result[0].fields).toEqual(expectedFirst);
      expect(result[0].length).toBe(2);
      expect(result[1].fields).toEqual(expectedSecond);
      expect(result[1].length).toBe(2);
    });
  });
});
