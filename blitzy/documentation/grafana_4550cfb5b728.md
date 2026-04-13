# Grafana "Grouping to Matrix" Transformation: Sparse Data Handling Analysis

**Branch**: `grafana_4550cfb5b728`
**Date**: 2026-04-13
**Scope**: Code-grounded analysis of how the Grouping to Matrix transformation handles missing row/column intersections, and how the emitted fill values propagate through downstream calculations, color scales, thresholds, and display rendering.
**Grafana Version**: 11.5.0-pre (monorepo, `@grafana/data` workspace package)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Transformation Mechanics — `getSpecialValue()` Dispatch](#2-transformation-mechanics--getspecialvalue-dispatch)
3. [Concrete Sparse Dataset Walkthrough](#3-concrete-sparse-dataset-walkthrough)
4. [Field Reducer Divergence — `doStandardCalcs`](#4-field-reducer-divergence--dostandardcalcs)
5. [Scale and Color Impact](#5-scale-and-color-impact)
6. [Display Convergence via `anyToNumber`](#6-display-convergence-via-anytonumber)
7. [Threshold Resolution](#7-threshold-resolution)
8. [Value Mapping Consideration](#8-value-mapping-consideration)
9. [Practical Recommendation Summary](#9-practical-recommendation-summary)
10. [Code Reference Index](#10-code-reference-index)

---

## 1. Executive Summary

The **Grouping to Matrix** transformation (`DataTransformerID.groupingToMatrix`) pivots a flat three-column dataset (row key, column key, cell value) into a matrix-shaped DataFrame. When a particular row/column intersection does not exist in the source data, the transformation must fill the gap with a configurable placeholder value.

### Core Finding

The default fill setting — `SpecialValue.Empty`, which emits an empty string `''` — causes **missing data to silently behave like zero in downstream calculations** (field reducer sum, min/max, mean, color scale percentages) **while displaying as a blank cell** in the table UI. This creates a deceptive situation: the user sees blank cells suggesting absent data, but aggregate statistics (totals, averages, gauge values, stat panels) treat those cells as if their value were `0`.

### Root Cause

The JavaScript loose equality check `currentValue == null` at `fieldReducer.ts` line 489 returns `false` for empty strings. Combined with `Number.isNaN('')` also returning `false` (line 500), empty strings enter the "valid non-null, non-NaN value" branch of the field reducer, where they corrupt the `sum` accumulator via string concatenation (`5 + '' = "5"`) and distort `min`/`max` via numeric coercion (`'' < 5` evaluates as `0 < 5`).

### Recommended Fix

When the intent is "missing means absent," set the transformation's **Empty Value** option to **`Null`** (`SpecialValue.Null`). Null values pass the `== null` check and are skipped by the default `ignoreNulls` mode, ensuring that sum, min, max, mean, and count reflect only real data.

---

## 2. Transformation Mechanics — `getSpecialValue()` Dispatch

**Source file**: `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts`

### 2.1 The `emptyValue` Option

The transformation options interface is defined at line 16:

```typescript
export interface GroupingToMatrixTransformerOptions {
  columnField?: string;
  rowField?: string;
  valueField?: string;
  emptyValue?: SpecialValue; // line 20
}
```

The default is established at line 26:

```typescript
const DEFAULT_EMPTY_VALUE = SpecialValue.Empty;
```

At runtime (line 71), the option is resolved with a fallback to the default:

```typescript
const emptyValue = options.emptyValue || DEFAULT_EMPTY_VALUE;
```

### 2.2 The Fill Logic

During matrix construction, the transformation iterates over every unique column value and, for each row, looks up whether a value exists in the intermediate `matrixValues` dictionary. At line 117, the nullish coalescing operator (`??`) is used:

```typescript
const value = matrixValues[columnName][rowName] ?? getSpecialValue(emptyValue);
```

If a row/column pair does **not** exist in `matrixValues`, the expression evaluates to `undefined`, which triggers the `??` operator to call `getSpecialValue(emptyValue)`.

### 2.3 The `getSpecialValue()` Function

Defined at lines 178–190, this function maps each `SpecialValue` enum member to a concrete JavaScript value:

```typescript
function getSpecialValue(specialValue: SpecialValue) {
  switch (specialValue) {
    case SpecialValue.False:
      return false; // line 181
    case SpecialValue.True:
      return true; // line 183
    case SpecialValue.Null:
      return null; // line 185
    case SpecialValue.Empty:
    default:
      return ''; // line 188
  }
}
```

| `emptyValue` Setting           | `getSpecialValue()` Returns | JavaScript Type |
| ------------------------------ | --------------------------- | --------------- |
| `SpecialValue.False`           | `false`                     | boolean         |
| `SpecialValue.True`            | `true`                      | boolean         |
| `SpecialValue.Null`            | `null`                      | object (null)   |
| `SpecialValue.Empty` (default) | `''`                        | string          |

### 2.4 The `SpecialValue` Enum

Defined in `packages/grafana-data/src/types/transformations.ts` at lines 113–118:

```typescript
export enum SpecialValue {
  True = 'true',
  False = 'false',
  Null = 'null',
  Empty = 'empty',
}
```

### 2.5 The Silent Type Mismatch

At lines 129–134 in `groupingToMatrix.ts`, each output column field is constructed by copying the original value field's type and config:

```typescript
fields.push({
  name: columnName.toString(), // line 130
  values: values, // line 131
  config: valueField.config, // line 132
  type: valueField.type, // line 133
});
```

When the source value field has `type: FieldType.number`, the output field also declares `type: FieldType.number` — but when the default `SpecialValue.Empty` fill is used, the field's `values` array contains empty strings alongside numbers. This is a **silent type-level mismatch**: the field metadata claims numeric type, but the actual data contains strings. JavaScript's dynamic typing tolerates this silently, but the mismatch causes divergent behavior in downstream numeric operations.

### 2.6 Editor UI

The transformation editor at `public/app/features/transformers/editors/GroupingToMatrixTransformerEditor.tsx` presents all four options in a dropdown (lines 61–66):

```typescript
const specialValueOptions: Array<SelectableValue<SpecialValue>> = [
  { label: 'Null', value: SpecialValue.Null, description: 'Null value' },
  { label: 'True', value: SpecialValue.True, description: 'Boolean true value' },
  { label: 'False', value: SpecialValue.False, description: 'Boolean false value' },
  { label: 'Empty', value: SpecialValue.Empty, description: 'Empty string' },
];
```

---

## 3. Concrete Sparse Dataset Walkthrough

### 3.1 Input Data

Consider a DataFrame with 3 fields representing server-status-count relationships:

| Index | Column (string) | Row (string) | Value (number) |
| ----- | --------------- | ------------ | -------------- |
| 0     | `"Status_OK"`   | `"Server_A"` | `10`           |
| 1     | `"Status_OK"`   | `"Server_B"` | `20`           |
| 2     | `"Status_ERR"`  | `"Server_A"` | `5`            |

Three data points, but the matrix requires 2 rows × 2 columns = 4 cells. The cell `Server_B × Status_ERR` is **missing**.

### 3.2 Expected Matrix

| Row \ Column | Status_OK | Status_ERR    |
| ------------ | --------- | ------------- |
| Server_A     | 10        | 5             |
| Server_B     | 20        | **[MISSING]** |

### 3.3 Output with Default `SpecialValue.Empty`

The missing cell becomes `''` (empty string). The output DataFrame has these fields:

| Field Name   | Type               | Values                     |
| ------------ | ------------------ | -------------------------- |
| `Row\Column` | `FieldType.string` | `["Server_A", "Server_B"]` |
| `Status_OK`  | `FieldType.number` | `[10, 20]`                 |
| `Status_ERR` | `FieldType.number` | `[5, '']`                  |

Note: `Status_ERR` is declared as `FieldType.number` but contains an empty string at index 1.

This behavior is verified by the test at `groupingToMatrix.test.ts` lines 15–59. The test uses default options (no explicit `emptyValue`) and the expected output at lines 39–55 shows fields like:

```typescript
{ name: '1000', type: FieldType.number, values: [1, '', ''], config: {} },
{ name: '1001', type: FieldType.number, values: ['', 2, ''], config: {} },
{ name: '1002', type: FieldType.number, values: ['', '', 3], config: {} },
```

### 3.4 Output with `SpecialValue.Null`

The missing cell becomes `null`. The output DataFrame:

| Field Name   | Type               | Values                     |
| ------------ | ------------------ | -------------------------- |
| `Row\Column` | `FieldType.string` | `["Server_A", "Server_B"]` |
| `Status_OK`  | `FieldType.number` | `[10, 20]`                 |
| `Status_ERR` | `FieldType.number` | `[5, null]`                |

Verified by the test at `groupingToMatrix.test.ts` lines 108–149, which configures `emptyValue: SpecialValue.Null` (line 112) and expects:

```typescript
{ name: '1000', type: FieldType.number, values: [1, null], config: {} },
{ name: '1001', type: FieldType.number, values: [null, 2], config: {} },
```

---

## 4. Field Reducer Divergence — `doStandardCalcs`

**Source file**: `packages/grafana-data/src/transformations/fieldReducer.ts`

This is where the **primary semantic divergence** between empty-string and null fill values occurs. The field reducer computes aggregate statistics (sum, min, max, mean, count) that are consumed by stat panels, gauges, color scales, and any visualization that reduces a field to a single value.

### 4.1 Default Null Handling Mode

At lines 197–201, `reduceField` establishes the default null-handling behavior:

```typescript
const { nullValueMode = NullValueMode.Ignore } = field.config; // line 198
const ignoreNulls = nullValueMode === NullValueMode.Ignore; // line 200
const nullAsZero = nullValueMode === NullValueMode.AsZero; // line 201
```

Since the transformation copies `valueField.config` without adding a `nullValueMode` property, the default `NullValueMode.Ignore` applies. This means `ignoreNulls = true` and `nullAsZero = false`.

### 4.2 Initial State (`defaultCalcs`, lines 445–466)

```typescript
export const defaultCalcs: FieldCalcs = {
  sum: 0,
  max: -Number.MAX_VALUE,
  min: Number.MAX_VALUE,
  logmin: Number.MAX_VALUE,
  mean: null,
  last: null,
  first: null,
  lastNotNull: null,
  firstNotNull: null,
  count: 0,
  nonNullCount: 0,
  allIsNull: true,
  allIsZero: true,
  range: null,
  diff: null,
  delta: 0,
  step: Number.MAX_VALUE,
  diffperc: 0,
  previousDeltaUp: true,
};
```

### 4.3 Walkthrough: `Status_ERR` with values `[5, '']` (Default Empty Mode)

The `doStandardCalcs` function begins its loop at line 480: `for (let i = 0; i < data.length; i++)`.

**Iteration 1: `currentValue = 5`** (identical in both modes)

| Line    | Code                                                       | Evaluation                                        | Result             |
| ------- | ---------------------------------------------------------- | ------------------------------------------------- | ------------------ |
| 483–484 | `if (i === 0) calcs.first = currentValue`                  | `0 === 0` → `true`                                | `first = 5`        |
| 487     | `calcs.last = currentValue`                                | —                                                 | `last = 5`         |
| 489     | `if (currentValue == null)`                                | `5 == null` → `false`                             | Does NOT skip      |
| 498     | `calcs.count++`                                            | —                                                 | `count = 1`        |
| 500     | `if (currentValue != null && !Number.isNaN(currentValue))` | `5 != null` → `true`; `!Number.isNaN(5)` → `true` | Enters block       |
| 502     | `calcs.firstNotNull === null`                              | `null === null` → `true`                          | `isFirst = true`   |
| 504     | `calcs.firstNotNull = currentValue`                        | —                                                 | `firstNotNull = 5` |
| 508     | `calcs.sum += currentValue`                                | `0 + 5 = 5`                                       | `sum = 5`          |
| 510     | `calcs.nonNullCount++`                                     | —                                                 | `nonNullCount = 1` |
| 535     | `if (currentValue > calcs.max)`                            | `5 > -1.7976e+308` → `true`                       | `max = 5`          |
| 539     | `if (currentValue < calcs.min)`                            | `5 < 1.7976e+308` → `true`                        | `min = 5`          |
| 552     | `calcs.lastNotNull = currentValue`                         | —                                                 | `lastNotNull = 5`  |

**Iteration 2: `currentValue = ''`** (Default Empty mode — the critical divergence)

| Line    | Code                                                       | Evaluation                                          | Explanation                                                                                                                                                                                                                 |
| ------- | ---------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 487     | `calcs.last = currentValue`                                | —                                                   | `last = ''`                                                                                                                                                                                                                 |
| **489** | `if (currentValue == null)`                                | **`'' == null` → `false`**                          | Per ECMAScript Abstract Equality (§7.2.14): only `null` and `undefined` are loosely equal to each other. An empty string is **not** loosely equal to `null`. The empty string **bypasses** the null-handling path entirely. |
| **498** | `calcs.count++`                                            | —                                                   | **`count = 2`** — the empty string is counted as a value                                                                                                                                                                    |
| **500** | `if (currentValue != null && !Number.isNaN(currentValue))` | `'' != null` → `true`; `Number.isNaN('')` → `false` | `Number.isNaN` (§21.1.2.4) checks whether the value **is** the actual `NaN` value. `''` is a string, not `NaN`. The empty string enters the "valid non-null, non-NaN" branch.                                               |
| **508** | `calcs.sum += currentValue`                                | `5 + ''` = **`"5"`**                                | **String concatenation!** JavaScript's `+` operator (§13.15.3), when one operand is a string, invokes `ToString` on both operands. The sum accumulator becomes the string `"5"` instead of the number `5`.                  |
| **510** | `calcs.nonNullCount++`                                     | —                                                   | **`nonNullCount = 2`** — empty string counted as non-null                                                                                                                                                                   |
| **535** | `if (currentValue > calcs.max)`                            | `'' > 5` → `ToNumber('') = 0`; `0 > 5` → `false`    | Max stays at `5`. Relational operators (§13.10) use `ToNumber` coercion, which maps `''` to `0`.                                                                                                                            |
| **539** | `if (currentValue < calcs.min)`                            | `'' < 5` → `ToNumber('') = 0`; `0 < 5` → **`true`** | **`min = ''`** — the empty string becomes the minimum value!                                                                                                                                                                |
| 548     | `if (currentValue !== 0)`                                  | `'' !== 0` → `true`                                 | `allIsZero = false`                                                                                                                                                                                                         |
| 552     | `calcs.lastNotNull = currentValue`                         | —                                                   | `lastNotNull = ''`                                                                                                                                                                                                          |

**Post-loop calculations:**

| Line    | Code                                           | Evaluation                   | Result                                                                             |
| ------- | ---------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| 556     | `if (calcs.max === -Number.MAX_VALUE)`         | `5 === -MAX_VALUE` → `false` | max stays `5`                                                                      |
| 560     | `if (calcs.min === Number.MAX_VALUE)`          | `'' === MAX_VALUE` → `false` | min stays `''`                                                                     |
| 568–569 | `calcs.mean = calcs.sum! / calcs.nonNullCount` | `"5" / 2 = 2.5`              | JS coerces `"5"` back to `5` for division. **Mean = 2.5** instead of correct `5.0` |
| 576–577 | `calcs.range = calcs.max - calcs.min`          | `5 - '' = 5 - 0 = 5`         | `range = 5`                                                                        |

**Final reducer output for `[5, '']`:**

| Statistic      | Value          | Correct Value | Corrupted?                          |
| -------------- | -------------- | ------------- | ----------------------------------- |
| `sum`          | `"5"` (string) | `5` (number)  | **Yes** — string concatenation      |
| `min`          | `''` (string)  | `5`           | **Yes** — empty string treated as 0 |
| `max`          | `5`            | `5`           | No                                  |
| `count`        | `2`            | `1`           | **Yes** — empty string counted      |
| `nonNullCount` | `2`            | `1`           | **Yes** — empty string counted      |
| `mean`         | `2.5`          | `5`           | **Yes** — denominator inflated      |
| `first`        | `5`            | `5`           | No                                  |
| `last`         | `''`           | `null` or N/A | **Yes** — empty string              |

### 4.4 Walkthrough: `Status_ERR` with values `[5, null]` (Null Mode)

**Iteration 1: `currentValue = 5`** — identical to above.

**Iteration 2: `currentValue = null`**

| Line        | Code                             | Evaluation                  | Result                                                       |
| ----------- | -------------------------------- | --------------------------- | ------------------------------------------------------------ |
| 487         | `calcs.last = currentValue`      | —                           | `last = null`                                                |
| **489**     | `if (currentValue == null)`      | **`null == null` → `true`** | Enters the null-handling block                               |
| **490–491** | `if (ignoreNulls) { continue; }` | `ignoreNulls = true`        | **`continue`** — skips the entire rest of the loop iteration |

The null value is **skipped entirely**. Lines 498 (`count++`), 500–553 (all calculations), and 552 (`lastNotNull`) are never reached for this iteration.

**Final reducer output for `[5, null]`:**

| Statistic      | Value  | Correct?                   |
| -------------- | ------ | -------------------------- |
| `sum`          | `5`    | **Yes**                    |
| `min`          | `5`    | **Yes**                    |
| `max`          | `5`    | **Yes**                    |
| `count`        | `1`    | **Yes** — null not counted |
| `nonNullCount` | `1`    | **Yes**                    |
| `mean`         | `5`    | **Yes**                    |
| `first`        | `5`    | **Yes**                    |
| `last`         | `null` | **Yes**                    |

### 4.5 Divergence Summary

| Processing Stage                         | Default `''` (Empty)                         | `null` (Null)                       |
| ---------------------------------------- | -------------------------------------------- | ----------------------------------- |
| Transformation output                    | `''` in `FieldType.number` field             | `null` in `FieldType.number` field  |
| Reducer null check (`== null`, line 489) | **Fails** — treated as valid value           | **Passes** — skipped by `continue`  |
| Reducer sum (line 508)                   | **Corrupted** via string concatenation       | Unaffected — only real values       |
| Reducer min/max (lines 535–541)          | `''` coerces to 0, distorts range            | Excluded — real range preserved     |
| Reducer count (line 498)                 | Incremented (empty string counted)           | Not incremented (skipped)           |
| Reducer nonNullCount (line 510)          | Incremented                                  | Not incremented                     |
| Reducer mean (line 569)                  | Denominator inflated; value diluted toward 0 | Denominator reflects only real data |
| Display text                             | Empty string (blank cell)                    | Empty string (blank cell)           |
| Color scale percent                      | Maps to 0% (looks like zero)                 | Maps to 0% but min/max are accurate |
| Threshold resolution                     | Falls to base threshold via NaN              | Falls to base threshold via NaN     |

### 4.6 Extended Example: Three-Element Array `[1, '', '']`

This matches the exact test case at `groupingToMatrix.test.ts` line 41.

After full iteration through `doStandardCalcs`:

| Iteration | `currentValue` | `sum` after `+=`                 | `min`        | `max` | `count` | `nonNullCount` |
| --------- | -------------- | -------------------------------- | ------------ | ----- | ------- | -------------- |
| 0         | `1`            | `1` (number)                     | `1`          | `1`   | `1`     | `1`            |
| 1         | `''`           | `"1"` (string: `1 + '' = "1"`)   | `''` (0 < 1) | `1`   | `2`     | `2`            |
| 2         | `''`           | `"1"` (string: `"1" + '' = "1"`) | `''`         | `1`   | `3`     | `3`            |

Final: `sum = "1"`, `mean = "1" / 3 ≈ 0.333` instead of correct `1 / 1 = 1`.

---

## 5. Scale and Color Impact

**Source file**: `packages/grafana-data/src/field/scale.ts`

### 5.1 `getMinMaxAndDelta(field)` (Lines 74–103)

When the field type is `FieldType.number` (checked at line 75) and no explicit `min`/`max` is configured, this function calls `reduceField` to compute the range (line 85):

```typescript
const stats = reduceField({ field, reducers: [ReducerID.min, ReducerID.max] });
```

At lines 86–91, it extracts min and max from the reducer output:

```typescript
if (!isNumber(min)) {
  min = stats[ReducerID.min]; // line 87
}
if (!isNumber(max)) {
  max = stats[ReducerID.max]; // line 90
}
```

The delta is then calculated at line 101:

```typescript
delta: max! - min!;
```

### 5.2 With Empty-String Corruption

When the reducer returns `min = ''` (empty string) and `max = 5`:

- `lodash.isNumber('')` returns `false`, so line 86 check fails and `min` is assigned `''` from `stats[ReducerID.min]`
- Line 101: `delta = max! - min!` → `5 - ''` → JavaScript's `-` operator invokes `ToNumber('')` = `0` → `delta = 5 - 0 = 5`
- The scale range becomes `{ min: '', max: 5, delta: 5 }`

### 5.3 In the Scale Closure (Lines 28–46)

The `getScaleCalculator` function (line 19) returns a closure that computes color scale percentages:

```typescript
return (value: number) => {
  let percent = 0;

  if (value !== -Infinity) {
    // line 31
    percent = (value - info.min!) / info.delta; // line 32

    if (Number.isNaN(percent)) {
      // line 34
      percent = 0; // line 35
    }
  }

  const threshold = getActiveThresholdForValue(field, value, percent); // line 39
  // ...
};
```

For an empty-string cell value that has been converted to `NaN` by `anyToNumber('')`:

- The scale function receives `NaN` (from the display processor)
- Line 31: `NaN !== -Infinity` → `true` → enters the block
- Line 32: `percent = (NaN - '') / 5` → `NaN` (any arithmetic with NaN produces NaN)
- Line 34: `Number.isNaN(NaN)` → `true` → `percent = 0`
- The cell maps to **0%** on the color scale

### 5.4 With Null Mode

The reducer excludes nulls, so `min = 5`, `max = 5`, `delta = 0`. The scale range is accurate. For a null cell value converted to `NaN`:

- Line 32: `percent = (NaN - 5) / 0` → `NaN`
- Line 34: `Number.isNaN(NaN)` → `true` → `percent = 0`

While the percent output is the same (0), the critical difference is that the **min/max range is accurate**, meaning other cells' percentages are correctly computed. With empty-string corruption, the inflated range (min coerced to 0) distorts percentages for all cells in the field.

---

## 6. Display Convergence via `anyToNumber`

**Source file**: `packages/grafana-data/src/utils/anyToNumber.ts`

### 6.1 The `anyToNumber()` Function (Lines 8–22)

This function is the key normalizer that makes empty strings and nulls display identically:

```typescript
export function anyToNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value; // line 10
  }

  if (value === '' || value === null || value === undefined || Array.isArray(value)) {
    return NaN; // lodash calls them 0              // line 14
  }

  if (typeof value === 'boolean') {
    return value ? 1 : 0; // line 18
  }

  return toNumber(value); // line 21
}
```

The critical line is 13–14: both `''` and `null` are **explicitly** mapped to `NaN`. The comment `// lodash calls them 0` is significant — Grafana intentionally overrides lodash's `toNumber` behavior (which would convert `''` to `0`) to prevent empty strings from displaying as zero.

### 6.2 In `getDisplayProcessor` (displayProcessor.ts, lines 42–212)

When the display processor processes a cell value:

1. **Line 96**: `let numeric = isStringUnit ? NaN : anyToNumber(value)`

   - For a number field: `anyToNumber('')` → `NaN`; `anyToNumber(null)` → `NaN`
   - Both produce `NaN` as the numeric representation

2. **Line 144**: `if (!Number.isNaN(numeric))`

   - `!Number.isNaN(NaN)` → `false`
   - The number formatting block is **skipped** — no formatted number text is produced

3. **Lines 177–186**: Falls through to the text fallback:

   ```typescript
   if (text == null) {
     text = toString(value); // line 178
     if (!text) {
       // line 179
       if (config.noValue) {
         text = config.noValue; // line 181
       } else {
         text = ''; // line 183
       }
     }
   }
   ```

   - `toString('')` → `''` (lodash) and `toString(null)` → `''` (lodash)
   - `!''` → `true` → falls to the `config.noValue` or empty string fallback
   - Both modes produce an **empty string** as display text

4. **Lines 188–192**: Since `color` was not set (the NaN check at line 144 skipped the scale call at line 167), the fallback invokes `scaleFunc(-Infinity)`:
   ```typescript
   if (!color) {
     const scaleResult = scaleFunc(-Infinity); // line 189
     color = scaleResult.color;
     percent = scaleResult.percent;
   }
   ```
   In the scale closure (scale.ts line 31): `value !== -Infinity` → `false` for `-Infinity` → `percent = 0` → resolves to base threshold color.

### 6.3 Key Insight

Despite vastly different **computational** behavior upstream (corrupted sum/min/max vs. clean statistics), both fill modes produce **identical display output**: blank cells with the base threshold color. This is precisely why the problem is deceptive — the user sees blank cells suggesting absent data, but the calculations silently treat those cells differently.

---

## 7. Threshold Resolution

**Source file**: `packages/grafana-data/src/field/thresholds.ts`

### 7.1 `getActiveThreshold` (Lines 7–23)

Iterates through sorted threshold steps, selecting the last threshold where `value >= threshold.value`:

```typescript
export function getActiveThreshold(value: number, thresholds: Threshold[] | undefined): Threshold {
  if (!thresholds || thresholds.length === 0) {
    return fallBackThreshold; // line 9
  }

  let active = thresholds[0]; // line 12

  for (const threshold of thresholds) {
    if (value >= threshold.value) {
      // line 15
      active = threshold;
    } else {
      break;
    }
  }

  return active;
}
```

### 7.2 `getActiveThresholdForValue` (Lines 25–33)

Delegates to `getActiveThreshold`, passing either the absolute value or the percentage depending on threshold mode:

```typescript
export function getActiveThresholdForValue(field: Field, value: number, percent: number): Threshold {
  const { thresholds } = field.config;

  if (thresholds?.mode === ThresholdsMode.Percentage) {
    return getActiveThreshold(percent * 100, thresholds?.steps);
  }

  return getActiveThreshold(value, thresholds?.steps);
}
```

### 7.3 Individual Cell Threshold Resolution

For an individual empty-string or null cell displayed in a table:

1. `anyToNumber(value)` → `NaN` for both `''` and `null`
2. The display processor skips the `scaleFunc(numeric)` call at line 167 (because `Number.isNaN(NaN)` is true)
3. Falls to `scaleFunc(-Infinity)` at line 189
4. In the scale closure: `value !== -Infinity` → `false` → `percent = 0`
5. `getActiveThresholdForValue(field, -Infinity, 0)` is called (line 39 in scale.ts)
6. In `getActiveThreshold`: `NaN >= threshold.value` is always `false` for any threshold value → active stays as `thresholds[0]` (the base/green threshold)

Both fill modes resolve to the **same base threshold** for individual cell display.

### 7.4 Aggregate Threshold Impact

The critical difference appears when the reducer is used for **aggregate statistics** (stat panels, gauges, bar gauges):

- With **empty-string fill**: The corrupted `sum` (`"5"` string), inflated `count` (2 instead of 1), and incorrect `mean` (2.5 instead of 5) are passed to `getFieldDisplayValues` (via `packages/grafana-data/src/field/fieldDisplay.ts`), which calls `reduceField`. These corrupted aggregate values then resolve to **different thresholds** than the real data would warrant.
- With **null fill**: Clean statistics are passed through, and thresholds resolve correctly.

---

## 8. Value Mapping Consideration

**Source files**: `packages/grafana-data/src/utils/valueMappings.ts` and `packages/grafana-data/src/types/valueMapping.ts`

### 8.1 `SpecialValueMatch` Enum (valueMapping.ts, lines 78–85)

```typescript
export enum SpecialValueMatch {
  True = 'true',
  False = 'false',
  Null = 'null',
  NaN = 'nan',
  NullAndNaN = 'null+nan',
  Empty = 'empty',
}
```

### 8.2 Matching Logic in `getValueMappingResult` (valueMappings.ts, lines 70–108)

The `MappingType.SpecialValue` case handles each `SpecialValueMatch` variant:

| Match Type                                  | Condition                                    | Catches `''`? | Catches `null`?    |
| ------------------------------------------- | -------------------------------------------- | ------------- | ------------------ | --- | ------- |
| `SpecialValueMatch.Null` (line 72–76)       | `value == null` (loose equality)             | No            | **Yes**            |
| `SpecialValueMatch.NaN` (line 78–82)        | `typeof value === 'number' && isNaN(value)`  | No            | No                 |
| `SpecialValueMatch.NullAndNaN` (line 84–88) | `(typeof value === 'number' && isNaN(value)) |               | value == null`     | No  | **Yes** |
| `SpecialValueMatch.True` (line 90–94)       | `value === true                              |               | value === 'true'`  | No  | No      |
| `SpecialValueMatch.False` (line 96–100)     | `value === false                             |               | value === 'false'` | No  | No      |
| `SpecialValueMatch.Empty` (line 102–106)    | `value === ''` (strict equality)             | **Yes**       | No                 |

### 8.3 Practical Advice

Users can configure value mappings to give missing cells explicit display text (e.g., "N/A", "—", or "No Data"):

- **When using default fill (`SpecialValue.Empty`)**: Add a `SpecialValueMatch.Empty` value mapping. This matches `value === ''` and will intercept the empty string before it falls through to the blank-cell display path.
- **When using `SpecialValue.Null` fill**: Add a `SpecialValueMatch.Null` or `SpecialValueMatch.NullAndNaN` value mapping. This matches `value == null` and provides explicit display text for null cells.

Note that value mappings affect **display** only — they do not alter the underlying value that the reducer processes. The computational corruption described in Section 4 still occurs regardless of value mappings when using the default empty-string fill.

---

## 9. Practical Recommendation Summary

### 9.1 Decision Matrix

| Scenario                                                    | Recommended `emptyValue`                       | Rationale                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing means **"absent"** — should not affect calculations | `SpecialValue.Null`                            | Null passes the `== null` check (fieldReducer.ts line 489), gets skipped by `ignoreNulls` (line 490–491); sum, min, max, mean, and count reflect only real data                                                                             |
| Missing means **"zero"** — should be counted as zero        | Neither default nor any single option is ideal | The default `SpecialValue.Empty` coerces to 0 in comparisons but **corrupts sum** via string concatenation; consider using a pre-transformation step (e.g., "Convert field type" or a calculated field) to explicitly fill with numeric `0` |
| Missing needs **custom display text**                       | Any fill + appropriate value mapping           | Use `SpecialValueMatch.Empty` for the default fill, or `SpecialValueMatch.Null` for null fill; value mappings intercept before formatting and provide explicit display text                                                                 |
| Matrix is **display-only** (no aggregations)                | Default (`SpecialValue.Empty`) is acceptable   | Without aggregations, the computational corruption is never triggered; the display shows blank cells as expected                                                                                                                            |

### 9.2 Why `SpecialValue.Empty` Is the Default

The default appears to be a legacy design decision optimized for the **table-only display** use case. When the matrix is only rendered in a table panel without aggregate calculations, empty strings display as blank cells — which is the intuitively correct visual representation of "no data." The computational side effects only manifest when the matrix output is consumed by:

- Stat panels (which reduce the field to a single value)
- Gauge or bar gauge panels (which use min/max range)
- Color scales or threshold-based cell coloring (which depend on accurate min/max)
- Any downstream transformation that performs numeric operations

### 9.3 The "Missing Means Zero" Trap

The user's original observation — that the dashboard treats missing data as zero — is explained by this chain:

1. The default fill emits `''` (empty string) into a `FieldType.number` field (groupingToMatrix.ts line 117, 133)
2. The field reducer's null check `currentValue == null` does not catch `''` (fieldReducer.ts line 489)
3. `Number.isNaN('')` returns `false`, so `''` enters the "valid value" branch (fieldReducer.ts line 500)
4. The `+=` operator triggers string concatenation for sum (fieldReducer.ts line 508)
5. Relational operators (`>`, `<`) coerce `''` to `0`, making min/max behave as if the value were 0 (fieldReducer.ts lines 535, 539)
6. The display processor normalizes both `''` and `null` to `NaN` via `anyToNumber` (anyToNumber.ts line 13), producing identical blank cell output
7. **Result**: Blank cells in the UI (suggesting "absent"), but 0-like behavior in calculations (suggesting "zero")

---

## 10. Code Reference Index

| File Path                                                                         | Key Lines                            | Purpose                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts`      | 16–21, 26, 71, 117, 129–134, 178–190 | Transformation options interface, default empty value, fill logic with `??` operator, field construction with inherited type, `getSpecialValue()` dispatch                                                                                      |
| `packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts` | 15–59, 108–149                       | Default empty-string test case (`values: [1, '', '']`), null-mode test case (`values: [1, null]`)                                                                                                                                               |
| `packages/grafana-data/src/types/transformations.ts`                              | 113–118                              | `SpecialValue` enum definition: `True`, `False`, `Null`, `Empty`                                                                                                                                                                                |
| `packages/grafana-data/src/transformations/fieldReducer.ts`                       | 197–201, 445–466, 468–588            | Default `NullValueMode.Ignore` and `ignoreNulls`/`nullAsZero` derivation (197–201); `defaultCalcs` initial values (445–466); `doStandardCalcs` with null check at 489, sum accumulation at 508, min/max comparisons at 535–541, mean at 568–569 |
| `packages/grafana-data/src/field/displayProcessor.ts`                             | 42–212, 96, 144, 177–186, 188–192    | `getDisplayProcessor` factory; `anyToNumber(value)` call at 96; NaN gate at 144; `toString` fallback at 177–186; `scaleFunc(-Infinity)` color fallback at 188–192                                                                               |
| `packages/grafana-data/src/utils/anyToNumber.ts`                                  | 8–22, 13–14                          | `anyToNumber` function; critical normalization at line 13 where `''`, `null`, `undefined` all → `NaN`                                                                                                                                           |
| `packages/grafana-data/src/field/scale.ts`                                        | 19–47, 74–103                        | `getScaleCalculator` closure with percent calculation (28–46); `getMinMaxAndDelta` calling `reduceField` for min/max (74–103)                                                                                                                   |
| `packages/grafana-data/src/field/thresholds.ts`                                   | 7–23, 25–33                          | `getActiveThreshold` iterating sorted steps with `value >= threshold.value` (line 15); `getActiveThresholdForValue` delegating by threshold mode                                                                                                |
| `packages/grafana-data/src/utils/valueMappings.ts`                                | 13, 70–108                           | `getValueMappingResult` function; `SpecialValueMatch.Null` at 72–76, `.NullAndNaN` at 84–88, `.Empty` at 102–106                                                                                                                                |
| `packages/grafana-data/src/types/valueMapping.ts`                                 | 78–85                                | `SpecialValueMatch` enum: `True`, `False`, `Null`, `NaN`, `NullAndNaN`, `Empty`                                                                                                                                                                 |
| `public/app/features/transformers/editors/GroupingToMatrixTransformerEditor.tsx`  | 61–66                                | `specialValueOptions` array listing all four `SpecialValue` options with labels and descriptions                                                                                                                                                |

---

_This document is a read-only analysis. No source files were modified._
