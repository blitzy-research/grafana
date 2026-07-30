import { map } from 'rxjs/operators';

import { DataFrame, Field } from '../../types/dataFrame';
import { DataTransformerInfo } from '../../types/transformations';

import { DataTransformerID } from './ids';

/** Which occurrence of a duplicated row key survives deduplication. */
export type DeduplicateRowsKeep = 'first' | 'last';

export interface DeduplicateRowsTransformerOptions {
  /** Name of the field whose value forms the row key. When empty or unset, the whole row is the key. */
  field?: string;
  /** Which occurrence of a duplicated key survives. */
  keep?: DeduplicateRowsKeep;
}

const DEFAULT_KEEP: DeduplicateRowsKeep = 'first';

/**
 * Collapses rows that share a key into a single row. The key is the value of one named field, or the
 * ordered tuple of every field value in the row when no field is configured. Retained rows are always
 * emitted in ascending original-index order, so the output is a subsequence of the input.
 */
export const deduplicateRowsTransformer: DataTransformerInfo<DeduplicateRowsTransformerOptions> = {
  id: DataTransformerID.deduplicateRows,
  name: 'Deduplicate rows',
  description: 'Remove duplicate rows, keeping either the first or the last occurrence',
  defaultOptions: {
    keep: DEFAULT_KEEP,
  },

  operator: (options) => (source) => source.pipe(map((data) => data.map((frame) => deduplicateFrame(frame, options)))),
};

/** Terminal trie node: remembers which original row currently owns one distinct key. */
interface DeduplicateKeyNode {
  /** Owning row index, or `-1` while the key is unclaimed (row indices are always >= 0). */
  chosen: number;
}

// One trie level per key field, keyed on the RAW field value rather than on a joined string. The
// `String(...)` join that `groupValuesByKey` uses in ./groupBy.ts is rejected here as lossy: `1`
// collides with `'1'`, `null` collides with `undefined`, and delimiter-bearing values cross-collide
// (`['a,b','c']` would be judged equal to `['a','b,c']`).
//
// Documented deviation from `===`: `Map` keys compare with SameValueZero, so `NaN` equals `NaN` and
// `+0` equals `-0`. Such rows collapse, which is pragmatic for deduplication rather than a defect.
type DeduplicateKeyLevel = Map<unknown, DeduplicateKeyLevel | DeduplicateKeyNode>;

/** Gets (or creates) the nested level under `value`; only used for non-terminal key fields. */
function descendKeyLevel(level: DeduplicateKeyLevel, value: unknown): DeduplicateKeyLevel {
  const existing = level.get(value);

  if (existing instanceof Map) {
    return existing;
  }

  const created: DeduplicateKeyLevel = new Map();
  level.set(value, created);

  return created;
}

/** Gets (or creates) the terminal node under `value`; only used for the last key field. */
function resolveKeyNode(level: DeduplicateKeyLevel, value: unknown): DeduplicateKeyNode {
  const existing = level.get(value);

  if (existing !== undefined && !(existing instanceof Map)) {
    return existing;
  }

  const created: DeduplicateKeyNode = { chosen: -1 };
  level.set(value, created);

  return created;
}

/**
 * Deduplicates a single frame in isolation, so keys never span frames. The original frame reference
 * is returned whenever nothing can be, or needs to be, removed.
 */
function deduplicateFrame(frame: DataFrame, options: DeduplicateRowsTransformerOptions): DataFrame {
  // Without rows, or without fields, there is no key material to compare.
  if (frame.length === 0 || frame.fields.length === 0) {
    return frame;
  }

  // A missing, empty, or interpolated-to-empty field name keys on the whole row.
  let keyFields: Field[] = frame.fields;

  if (options.field) {
    const keyField = frame.fields.find((field) => field.name === options.field);

    if (!keyField) {
      return frame;
    }

    keyFields = [keyField];
  }

  // Normalise `keep` here as well as through `defaultOptions`: callers may invoke the operator
  // directly and bypass that merge, and every string option is variable-interpolated first, so
  // any value other than 'last' resolves to the documented first-wins default.
  const keepLast = options.keep === 'last';

  // Pass one: elect the row that owns each distinct key.
  const root: DeduplicateKeyLevel = new Map();
  const owners: DeduplicateKeyNode[] = [];
  const lastKeyIndex = keyFields.length - 1;

  for (let row = 0; row < frame.length; row++) {
    let level = root;

    for (let i = 0; i < lastKeyIndex; i++) {
      level = descendKeyLevel(level, keyFields[i].values[row]);
    }

    const node = resolveKeyNode(level, keyFields[lastKeyIndex].values[row]);

    if (node.chosen === -1) {
      node.chosen = row;
      owners.push(node);
    } else if (keepLast) {
      node.chosen = row;
    }
  }

  // Nothing was removed when every row produced a distinct key.
  const distinct = owners.length;

  if (distinct === frame.length) {
    return frame;
  }

  // Pass two: read the elected rows only now (so `keep: 'last'` overwrites are honoured) and scan
  // indices ascending, which makes original-index order a structural property of the loop instead
  // of a sort or a reliance on map iteration order.
  const chosenRows = new Set(owners.map((owner) => owner.chosen));
  const keptRows: number[] = [];

  for (let row = 0; row < frame.length; row++) {
    if (chosenRows.has(row)) {
      keptRows.push(row);
    }
  }

  // Rebuild through shallow spreads so no input frame, field, or array is mutated; only rows change.
  return {
    ...frame,
    fields: frame.fields.map((field) => {
      const nanos = field.nanos;

      return {
        ...field,
        // Clear cached field calculations since removing rows changes the dataset
        // and previously computed stats (min, max, mean, etc.) are no longer valid
        state: { ...field.state, calcs: undefined },
        values: keptRows.map((row) => field.values[row]),
        // Keep nanos aligned with the values it annotates, without adding one to a field without it
        ...(nanos ? { nanos: keptRows.map((row) => nanos[row]) } : {}),
      };
    }),
    length: keptRows.length,
  };
}
