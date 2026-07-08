# Grouping to Matrix — What fills a missing cell, and how it propagates downstream

This document answers, from **observed runtime behavior**, what value Grafana's **"Grouping to matrix"** data transformation places in a `(column, row)` intersection that never appears in a sparse input, and how that value carries forward when a downstream panel computes totals/footers, selects thresholds, and maps colors. The human intent is **"missing means zero,"** but the dashboard appears to make a different choice somewhere along the way; below, a concrete sparse dataset is watched as it moves through the transformation and then through the real downstream consumers to find **exactly where the semantics shift** — if they shift at all.

Every behavioral claim is grounded in a `file:line` reference on branch `grafana_4550cfb5b728` and is backed by actual, unedited output captured from an executed code path (see **How it was investigated** and the **Appendix**).

## TL;DR — Direct answer

- A missing `(column, row)` intersection is **NOT** filled with `0`. By default it is filled with an **empty string `''`**, produced by `getSpecialValue(SpecialValue.Empty)` returning `''` (`groupingToMatrix.ts:117` → `:188`).
- That empty string is written into a field whose declared **`type` is still numeric** — the value field's type is preserved (`groupingToMatrix.ts:133`, `type: valueField.type`). So a non-numeric placeholder sits inside a numeric-typed column. **This type mismatch is the root cause of the downstream inconsistency.**
- The configurable fill options are exactly **Null, True, False, Empty** (default) — see the `SpecialValue` enum (`transformations.ts:113-118`) and the editor (`GroupingToMatrixTransformerEditor.tsx:61-66`). **There is no "Zero" option** in the enum or the editor.
- Downstream, each consumer coerces `''` under its own rules, so the semantics diverge:
  - **SUM** performs JavaScript string concatenation → the total becomes the **string `"30"`** (NOT the number `0`, and NOT the numeric `30`) — `fieldReducer.ts:508`.
  - **MEAN** coerces the string back to a number → `15` (zero-like: behaves as if the missing cell were `0`) — `fieldReducer.ts:569`.
  - **COUNT** includes the empty cell → `2` (NOT skipped as if absent) — `fieldReducer.ts:498`.
  - **THRESHOLD/COLOR** coerces `''` → `0` → lands on the base/first step (zero-like coloring) — `thresholds.ts:15`.
- **Bottom line:** "missing = zero" **holds for mean and threshold/color, but breaks for sum (string concatenation) and count (the empty cell is counted).** The divergence originates at the sum's `+=` string concatenation (`fieldReducer.ts:508`).
- The **only** configuration that produces true numeric-zero semantics for every consumer is **Empty value = `Null`** combined with the field's **`null as zero`** (`NullValueMode.AsZero`). This is verified in **Part B** below.

## How it was investigated (environment + exact commands)

**Environment.** The repository is the Grafana monorepo on branch `grafana_4550cfb5b728`. The toolchain is the repo's pinned, canonical one:

- **Node.js `v22.23.1`** — satisfies `package.json` engines `"node": ">= 22"`.
- **Corepack `0.34.6`** — activates the pinned package manager.
- **`yarn@4.5.3`** — pinned via `package.json` `"packageManager": "yarn@4.5.3"`.
- **Jest `29.7.0`** — the test runner.

Grafana's Jest setup uses `jest-fail-on-console`, so a stray `console.log` **fails** a test even when the body executes. The observation harness therefore writes its results to a file **outside** the repository (`/tmp/gtm_observed.json`) rather than to stdout, keeping the run clean and the captured output complete.

**Exact commands used** (the canonical build + invocation, unshortened):

```bash
# 1. Activate the pinned package manager
corepack enable

# 2. Install dependencies from the existing lockfile (touches only git-ignored node_modules;
#    --immutable forbids any lockfile mutation, so the repo stays unchanged)
yarn install --immutable

# 3. Run the transformer's existing test suite (baseline behavior)
node_modules/.bin/jest --silent --runInBand \
  packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts

# 4. Run the temporary observation harness that exercises the REAL
#    transformDataFrame -> reduceField -> getActiveThreshold code paths.
#    (The harness is created under packages/grafana-data/src/transformations/transformers/,
#     writes JSON to /tmp/gtm_observed.json, and is DELETED afterward.)
node_modules/.bin/jest --silent --runInBand \
  packages/grafana-data/src/transformations/transformers/__gtm_observe.test.ts
```

**Result & stability.** The harness run **PASSED** (`Test Suites: 1 passed`, `Tests: 1 passed`), and its output was **byte-identical across 3 runs** (`md5 = e19cf70ae4c711b87b8f1ffffd7d18e2`), confirming the observed values are stable.

**Known-harmless warnings** (observed during the run; not failures): a `jest-haste-map` "share their name" notice for a duplicate manual mock named `datasource` (unrelated loki/prometheus mocks), and a Node `punycode` `DEP0040` DeprecationWarning.

**Cleanup.** After capture, the temporary harness was deleted and `git status --porcelain` returned empty — the repository is left pristine apart from this answer document.

## Emit code path — where the fill value is chosen (`file:line`)

The chain that selects a missing cell's value, naming the specific function that performs each step:

**1. The default fill option** — `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts:26`:

```typescript
const DEFAULT_EMPTY_VALUE = SpecialValue.Empty;
```

**2. Resolving the option to the default when unset** — `groupingToMatrix.ts:71`:

```typescript
        const emptyValue = options.emptyValue || DEFAULT_EMPTY_VALUE;
```

**3. The missing-cell line (the heart of the emit)** — `groupingToMatrix.ts:117`:

```typescript
            const value = matrixValues[columnName][rowName] ?? getSpecialValue(emptyValue);
```

`matrixValues[columnName][rowName]` is `undefined` for a `(column, row)` combination that never appeared in the input. The `??` (nullish coalescing) operator therefore falls through to `getSpecialValue(emptyValue)` — so the emitted value for a missing cell is whatever `getSpecialValue` returns for the resolved `emptyValue`.

**4. The produced column preserves the value field's config and type** — `groupingToMatrix.ts:132-133`:

```typescript
            config: valueField.config,
            type: valueField.type,
```

This is why the empty-string fill lands in a field still declared as `number`: the column inherits `type: valueField.type`. That preserved numeric type over a non-numeric placeholder is the **latent root cause** of the downstream coercion inconsistencies.

**5. `getSpecialValue` — the function that actually produces the fill value** — `groupingToMatrix.ts:178-188`:

```typescript
function getSpecialValue(specialValue: SpecialValue) {
  switch (specialValue) {
    case SpecialValue.False:
      return false;
    case SpecialValue.True:
      return true;
    case SpecialValue.Null:
      return null;
    case SpecialValue.Empty:
    default:
      return '';
  }
}
```

For the default `SpecialValue.Empty` (which shares the `default:` branch), it returns `''` — an **empty string** (`groupingToMatrix.ts:186-188`).

**6. The set of fill options — the `SpecialValue` enum** — `packages/grafana-data/src/types/transformations.ts:113-118`:

```typescript
export enum SpecialValue {
  True = 'true',
  False = 'false',
  Null = 'null',
  Empty = 'empty',
}
```

There is **no `Zero` member** — zero is not an available fill option anywhere in the type.

**7. The editor UI exposing the options** — `public/app/features/transformers/editors/GroupingToMatrixTransformerEditor.tsx:61-66`:

```typescript
  const specialValueOptions: Array<SelectableValue<SpecialValue>> = [
    { label: 'Null', value: SpecialValue.Null, description: 'Null value' },
    { label: 'True', value: SpecialValue.True, description: 'Boolean true value' },
    { label: 'False', value: SpecialValue.False, description: 'Boolean false value' },
    { label: 'Empty', value: SpecialValue.Empty, description: 'Empty string' },
  ];
```

The user sees exactly **Null / True / False / Empty** — confirming the UI has no zero option.

**8. User-facing help text** — `public/app/features/transformers/docs/content.ts:618` (`name: 'Grouping to matrix'`) and `:631`: the help text lists the choice as **Null**, **True**, **False**, or **Empty**, and its example matrix shows blank cells for the missing combinations.

**9. Real, registered entry point (not a bypass).** The transformer id is defined at `packages/grafana-data/src/transformations/transformers/ids.ts:36` (`groupingToMatrix = 'groupingToMatrix'`) and registered into the app in `public/app/features/transformers/standardTransformers.ts` (import at `:16`, registration at `:63`). The harness drives this same registered transformer through `transformDataFrame`, so the observed behavior reflects the real code path.

## Part A — Verbatim emit output (the transform result)

**Concrete sparse input.** This realizes the user's "some row/column pairings never show up" scenario, with exactly one intersection (`C2 × R2`) absent:

- `Column = ['C1', 'C1', 'C2']`
- `Row    = ['R1', 'R2', 'R1']`
- `Temp   = [10, 20, 30]` (this is the `valueField`)
- Options: `columnField: 'Column'`, `rowField: 'Row'`, `valueField: 'Temp'` (default `emptyValue`).

The `(C2, R2)` pairing never occurs, so the output column **`C2 = [30, '']`** — the missing cell is filled with `''`.

Captured from the **real** `transformDataFrame` path (via the harness in the Appendix), the `partA_transform` slice of `/tmp/gtm_observed.json` is, verbatim:

```json
"partA_transform": [
  {
    "name": "Row\\Column",
    "type": "string",
    "values": [
      "R1",
      "R2"
    ],
    "config": {}
  },
  {
    "name": "C1",
    "type": "number",
    "values": [
      10,
      20
    ],
    "config": {}
  },
  {
    "name": "C2",
    "type": "number",
    "values": [
      30,
      ""
    ],
    "config": {}
  }
]
```

**Key observation.** Field `C2` has `"type": "number"`, yet its second value is `""` (an empty string) — a non-numeric value inside a numeric-typed field. Cross-reference `groupingToMatrix.ts:133` (`type: valueField.type`), which is exactly why the empty-string fill inherits the numeric type.

**Corroboration from the existing test suite.** `packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts:40-42` shows the default sparse fill as `type: FieldType.number`, `values: [1, '', '']`; `:163-208` shows a units-preserved scenario where the empty cell keeps `type: number` and its `units` config; and the `Null` option baseline at `:136` produces `values: [1, null]`.

## Part B — Totals/footer propagation (the reducer engine), verbatim output

Table footer totals, Stat/Gauge values, and the "Reduce" transformation all share one reducer engine. The mechanism, grounded in exact anchors:

**1. Shared entry point** — `packages/grafana-data/src/transformations/fieldReducer.ts:159`:

```typescript
export function reduceField(options: ReduceFieldOptions): FieldCalcs {
```

**2. Result cache** — `fieldReducer.ts:166`:

```typescript
  if (field.state?.calcs) {
```

`reduceField` caches its results on `field.state.calcs`, so **each measurement must use a freshly transformed frame**; otherwise a second call for the same field returns stale numbers. (The harness uses a fresh frame per measurement — see the fresh-frame proof below.)

**3. Default null handling** — `fieldReducer.ts:198`:

```typescript
  const { nullValueMode = NullValueMode.Ignore } = field.config;
```

**4. The function that actually performs sum/mean/count** — `fieldReducer.ts:468`:

```typescript
export function doStandardCalcs(field: Field, ignoreNulls: boolean, nullAsZero: boolean): FieldCalcs {
```

**5. The null special-case block (applies to `== null` only)** — `fieldReducer.ts:489-494`:

```typescript
    if (currentValue == null) {
      if (ignoreNulls) {
        continue;
      }
      if (nullAsZero) {
        currentValue = 0;
```

An empty string is **not** `== null`, so it is **neither** skipped (ignoreNulls) **nor** converted to zero (nullAsZero). This is the crux of why the default `''` fill never benefits from `null as zero`.

**6. Count increments for every cell** — `fieldReducer.ts:498`:

```typescript
    calcs.count++;
```

**7. The numeric guard** — `fieldReducer.ts:500`:

```typescript
    if (currentValue != null && !Number.isNaN(currentValue)) {
```

`''` **passes** this guard, because `'' != null` is `true` and `Number.isNaN('')` is `false`.

**8. The divergence site (SUM)** — `fieldReducer.ts:508`:

```typescript
        calcs.sum += currentValue;
```

For the empty string this executes `30 + ''`, which in JavaScript is **string concatenation** → the running sum becomes the string `"30"`.

**9. Non-null count increments too** — `fieldReducer.ts:510`:

```typescript
        calcs.nonNullCount++;
```

The empty string counts as non-null.

**10. MEAN divides the (string) sum** — `fieldReducer.ts:569`:

```typescript
    calcs.mean = calcs.sum! / calcs.nonNullCount;
```

Dividing the string `"30"` by a number coerces back to a number: `"30" / 2 === 15`.

**11. The null-handling modes** — `packages/grafana-data/src/types/data.ts:202-206`:

```typescript
export enum NullValueMode {
  Null = 'null',
  Ignore = 'connected',
  AsZero = 'null as zero',
}
```

Human labels map as: `Ignore` ↔ `'connected'`, `AsZero` ↔ `'null as zero'`.

**Observed output.** The real `reduceField` / `doStandardCalcs` output, one entry per `emptyValue` × `nullValueMode` (each from a freshly transformed frame), from the `partB_reducers` slice of `/tmp/gtm_observed.json`, verbatim:

```json
"partB_reducers": [
  {
    "emptyValue": "Empty(default)",
    "nullValueMode": "connected",
    "c2Values": [
      30,
      "\"\" (empty string)"
    ],
    "sum": "30",
    "sumType": "string",
    "mean": 15,
    "meanType": "number",
    "count": 2,
    "nonNullCount": 2
  },
  {
    "emptyValue": "Empty(default)",
    "nullValueMode": "null as zero",
    "c2Values": [
      30,
      "\"\" (empty string)"
    ],
    "sum": "30",
    "sumType": "string",
    "mean": 15,
    "meanType": "number",
    "count": 2,
    "nonNullCount": 2
  },
  {
    "emptyValue": "Null",
    "nullValueMode": "connected",
    "c2Values": [
      30,
      null
    ],
    "sum": 30,
    "sumType": "number",
    "mean": 30,
    "meanType": "number",
    "count": 1,
    "nonNullCount": 1
  },
  {
    "emptyValue": "Null",
    "nullValueMode": "null as zero",
    "c2Values": [
      30,
      null
    ],
    "sum": 30,
    "sumType": "number",
    "mean": 15,
    "meanType": "number",
    "count": 2,
    "nonNullCount": 2
  },
  {
    "emptyValue": "False",
    "nullValueMode": "connected",
    "c2Values": [
      30,
      false
    ],
    "sum": 30,
    "sumType": "number",
    "mean": 15,
    "meanType": "number",
    "count": 2,
    "nonNullCount": 2
  },
  {
    "emptyValue": "False",
    "nullValueMode": "null as zero",
    "c2Values": [
      30,
      false
    ],
    "sum": 30,
    "sumType": "number",
    "mean": 15,
    "meanType": "number",
    "count": 2,
    "nonNullCount": 2
  },
  {
    "emptyValue": "True",
    "nullValueMode": "connected",
    "c2Values": [
      30,
      true
    ],
    "sum": 31,
    "sumType": "number",
    "mean": 15.5,
    "meanType": "number",
    "count": 2,
    "nonNullCount": 2
  },
  {
    "emptyValue": "True",
    "nullValueMode": "null as zero",
    "c2Values": [
      30,
      true
    ],
    "sum": 31,
    "sumType": "number",
    "mean": 15.5,
    "meanType": "number",
    "count": 2,
    "nonNullCount": 2
  }
]
```

**Row-by-row interpretation:**

- **Empty (default), both null modes:** `sum = "30"` (a **string**, from `30 + '' → "30"`), `count = 2`, `nonNullCount = 2`, `mean = 15` (number, `"30" / 2 → 15`). `AsZero` has **no effect** here because `''` is not `== null`.
- **Null + Ignore (`connected`):** the null row is skipped → `sum = 30` (number), `count = 1`, `nonNullCount = 1`, `mean = 30`.
- **Null + AsZero (`null as zero`):** the null is converted to `0` → `sum = 30` (number), `count = 2`, `nonNullCount = 2`, `mean = 15`. **This is the only configuration that yields true numeric-zero semantics.**
- **False:** coerces to `0` in arithmetic → `sum = 30` (number), `mean = 15`, `count = 2`.
- **True:** coerces to `1` in arithmetic → `sum = 31` (number), `mean = 15.5`, `count = 2`.

**Fresh-frame proof.** The distinct `count` values — **1** for `Null + Ignore` versus **2** for `Null + AsZero` — prove that each measurement used a freshly transformed frame. A stale `field.state.calcs` cache (`fieldReducer.ts:166`) would have collapsed the two into a single value.

## Part C — Thresholds / color-scale mapping, verbatim output

**The selecting function** — `packages/grafana-data/src/field/thresholds.ts:7`:

```typescript
export function getActiveThreshold(value: number, thresholds: Threshold[] | undefined): Threshold {
```

**The numeric comparison** — `thresholds.ts:15`:

```typescript
    if (value >= threshold.value) {
```

When `value` is `''`, the comparison `'' >= <number>` coerces `''` to `0`, so an empty cell behaves like `0` for coloring and lands on the base/first step.

**Observed output.** The harness fed each candidate value through the real `getActiveThreshold` with steps `[{value:-Infinity,color:'green(base)'},{value:50,color:'orange'},{value:80,color:'red'}]`. Note that `-Infinity` serializes to `null` in JSON, so `activeStepValue: null` denotes the base step. From the `partC_thresholds` slice of `/tmp/gtm_observed.json`, verbatim:

```json
"partC_thresholds": [
  {
    "input": "empty string \"\"",
    "rawValue": "\"\"",
    "activeColor": "green(base)",
    "activeStepValue": null
  },
  {
    "input": "null",
    "rawValue": "null",
    "activeColor": "green(base)",
    "activeStepValue": null
  },
  {
    "input": "zero 0",
    "rawValue": "0",
    "activeColor": "green(base)",
    "activeStepValue": null
  },
  {
    "input": "false",
    "rawValue": "false",
    "activeColor": "green(base)",
    "activeStepValue": null
  },
  {
    "input": "true",
    "rawValue": "true",
    "activeColor": "green(base)",
    "activeStepValue": null
  }
]
```

**Interpretation.** The empty string `''` (and `null`, `0`, `false`) all resolve to the **base (green)** step — i.e., for coloring, the missing cell looks like `0`. `true` also lands on base here only because the base step is `-Infinity` and the next step is `50`; the point is that `''` is coerced numerically to `0` (zero-like), consistent with `thresholds.ts:15`.

**Ground-truth JS coercion facts.** These raw coercions (captured in the `coercionFacts` slice of `/tmp/gtm_observed.json`) explain every behavior above, verbatim:

```json
"coercionFacts": {
  "30 + \"\" ": "\"30\" (typeof string)",
  "\"30\" / 2": 15,
  "\"\" == null": false,
  "Number.isNaN(\"\")": false,
  "\"\" >= 0": true
}
```

Explained one line each:

- `30 + '' === "30"` — string concatenation; this drives the **sum** divergence (`fieldReducer.ts:508`).
- `"30" / 2 === 15` — division coerces back to a number; this drives the **mean** (`fieldReducer.ts:569`).
- `'' == null === false` — so null-handling never touches the empty string (`fieldReducer.ts:489`).
- `Number.isNaN('') === false` — so `''` passes the reducer's numeric guard (`fieldReducer.ts:500`).
- `'' >= 0 === true` — so `''` colors as the base/zero step (`thresholds.ts:15`).

## Where the semantics shift (summary)

For the default (**Empty**) fill, here is how each consumer treats the missing cell relative to the "missing = 0" expectation, using the observed values:

| Consumer            | Code (`file:line`)                | What it does with `''`                                    | Result                  | Matches "missing = 0"?  |
| ------------------- | --------------------------------- | --------------------------------------------------------- | ----------------------- | ----------------------- |
| Transform emit      | `groupingToMatrix.ts:117`, `:188` | fills missing cell via `?? getSpecialValue(Empty)` → `''` | `''` in a numeric field | No — it's `''`, not `0` |
| SUM (totals/footer) | `fieldReducer.ts:508`             | `30 + ''` → string concat                                 | `"30"` (string)         | **No — breaks**         |
| COUNT               | `fieldReducer.ts:498`             | counts the empty cell                                     | `2`                     | **No — counts it**      |
| MEAN                | `fieldReducer.ts:569`             | `"30" / 2` → numeric coercion                             | `15`                    | Yes (zero-like)         |
| THRESHOLD/COLOR     | `thresholds.ts:15`                | `'' >= x` → `''` coerced to `0`                           | base/green step         | Yes (zero-like)         |

**Synthesis.** The default fill is an **empty string, not zero**, placed in a numeric column (`groupingToMatrix.ts:117`, `:133`, `:188`). "Missing = zero" **holds for mean and threshold/color** (because those coerce `''` numerically to `0`) but **breaks for sum** (string concatenation yields a string like `"30"`) **and for count** (the empty cell is counted). The precise point where the semantics shift is `fieldReducer.ts:508` (`calcs.sum += currentValue`), where `30 + ''` becomes `"30"` rather than a numeric addition.

## How to actually achieve "missing = zero"

Grounded in the observed **Part B** data, the recipe is:

1. Set the transformation's **Empty value** option to **`Null`** (so the missing cell becomes an actual `null`, not `''`).
2. Set the field's null handling to **`null as zero`** (`NullValueMode.AsZero`, the standard/threshold option).

Per the observed **`Null` + `null as zero`** row: `sum = 30` (number), `count = 2`, `nonNullCount = 2`, `mean = 15` — true numeric-zero semantics for all consumers.

**Why the default cannot achieve this.** The default fill `''` is not `== null` (`fieldReducer.ts:489`), so `null as zero` cannot convert it; only an actual `null` (produced by **Empty value = `Null`**) is eligible for the `AsZero` conversion. Note also that adding a literal `Zero` fill option does not exist in this codebase (there is no `SpecialValue.Zero` — `transformations.ts:113-118`), and implementing one is out of scope for this document.

## External corroboration (validation only)

The source code and captured runtime output above are authoritative; the following external sources only corroborate the findings.

- **Official Grafana transformation documentation** (Grafana Labs docs; also mirrored by Amazon Managed Grafana at `https://docs.aws.amazon.com/grafana/latest/userguide/v10-panels-xform-functions.html`) lists the empty-cell fill choices as `"Null, True, False, or Empty"` — confirming there is no zero option, consistent with the `SpecialValue` enum.
- **GitHub issue grafana/grafana #97632** — _Transformations: Grouping to matrix doesn't support 0 for undefined combinations_ (`https://github.com/grafana/grafana/issues/97632`, opened Dec 9 2024) reports that cells come out empty rather than `0`, which breaks Bar Chart grouping — the same missing-should-be-zero expectation, filed as a known limitation: "Cells are empty, rather than having 0."
- **Grafana community forum thread #74645** — _Transform Grouping To Matrix issue_ (`https://community.grafana.com/t/transform-grouping-to-matrix-issue/74645`, Grafana 9.0.6) reports that with blank columns the addition is string concatenation rather than numeric addition, independently matching the observed string-concatenation behavior in Part B: "addition shud be numeric rather than string concat".

These are corroboration only; the authoritative evidence is the source code (`file:line`) and the captured runtime output in Parts A, B, and C above.

## Per-question coverage check

Re-verifying each named part of the original question, with the section/anchor that proves it:

- **Q1 — What value is emitted for a missing cell?** An **empty string `''`** by default (`groupingToMatrix.ts:117` + `:188`); shown in **Part A** as `C2 = [30, ""]`.
- **Q2 — Default vs. configurable fill behavior?** Default is `SpecialValue.Empty` (`groupingToMatrix.ts:26`, resolved at `:71`); the options are **Null / True / False / Empty** (`transformations.ts:113-118`, editor `:61-66`); there is **no zero** option.
- **Q3 — How does it propagate downstream (totals/footer, thresholds, color)?** **SUM** string-concatenates to `"30"` (`fieldReducer.ts:508`), **MEAN** coerces to `15` (`:569`), **COUNT** = `2` (`:498`), **THRESHOLD/COLOR** coerces `''` → `0` → base step (`thresholds.ts:15`); all shown verbatim in **Parts B and C**.
- **Q4 — Where do the semantics shift vs. "missing = zero"?** It **holds** for mean and threshold/color; it **breaks** for sum (string) and count; the shift point is `fieldReducer.ts:508`.
- **Q5 — Reproduce end-to-end.** The concrete sparse input, the exact commands, the harness, and the byte-stable captured output are all included; and the true-zero recipe (**Empty = `Null`** + **`null as zero`**) is verified in **Part B**.

Every fill option (**Empty**/default, **Null**, **False**, **True**) and both null modes (**Ignore**, **AsZero**) were exercised — **8 combinations** in Part B — and the values were **stable across runs** (byte-identical over 3 runs; see **How it was investigated**).

## Appendix — The exact observation harness (for reproducibility)

The following ephemeral Jest harness produced the output quoted above. It was created as a temporary file at `packages/grafana-data/src/transformations/transformers/__gtm_observe.test.ts`, run, captured to `/tmp/gtm_observed.json`, and then **deleted** — the repository is left unchanged. It exercises the real `transformDataFrame` → `reduceField` → `getActiveThreshold` code paths and writes results to a file (not stdout) to satisfy Grafana's `jest-fail-on-console` rule.

```typescript
import * as fs from 'fs';
import { lastValueFrom } from 'rxjs';
import { getActiveThreshold } from '../../field/thresholds';
import { NullValueMode } from '../../types/data';
import { FieldType } from '../../types/dataFrame';
import { Threshold } from '../../types/thresholds';
import { DataTransformerConfig, SpecialValue } from '../../types/transformations';
import { toDataFrame } from '../../dataframe/processDataFrame';
import { mockTransformationsRegistry } from '../../utils/tests/mockTransformationsRegistry';
import { reduceField, ReducerID } from '../fieldReducer';
import { transformDataFrame } from '../transformDataFrame';
import { GroupingToMatrixTransformerOptions, groupingToMatrixTransformer } from './groupingToMatrix';
import { DataTransformerID } from './ids';

const OUT = '/tmp/gtm_observed.json';

function makeInput() {
  return toDataFrame({
    name: 'sparse',
    fields: [
      { name: 'Column', type: FieldType.string, values: ['C1', 'C1', 'C2'] },
      { name: 'Row', type: FieldType.string, values: ['R1', 'R2', 'R1'] },
      { name: 'Temp', type: FieldType.number, values: [10, 20, 30] },
    ],
  });
}

async function transformFresh(emptyValue?: SpecialValue) {
  const cfg: DataTransformerConfig<GroupingToMatrixTransformerOptions> = {
    id: DataTransformerID.groupingToMatrix,
    options: { columnField: 'Column', rowField: 'Row', valueField: 'Temp', emptyValue },
  };
  const frames = await lastValueFrom(transformDataFrame([cfg], [makeInput()]));
  return frames[0];
}

describe('groupingToMatrix observation harness', () => {
  beforeAll(() => {
    mockTransformationsRegistry([groupingToMatrixTransformer]);
  });

  it('captures emit + downstream propagation', async () => {
    const result: any = {};

    result.coercionFacts = {
      '30 + "" ': `${JSON.stringify(30 + '')} (typeof ${typeof (30 + '')})`,
      '"30" / 2': ('30' as any) / 2,
      '"" == null': ('' as any) == null,
      'Number.isNaN("")': Number.isNaN('' as any),
      '"" >= 0': ('' as any) >= 0,
    };

    const def = await transformFresh();
    result.partA_transform = def.fields.map((f: any) => ({
      name: f.name,
      type: f.type,
      values: f.values,
      config: f.config,
    }));

    const emptyOpts: Array<{ label: string; value?: SpecialValue }> = [
      { label: 'Empty(default)', value: undefined },
      { label: 'Null', value: SpecialValue.Null },
      { label: 'False', value: SpecialValue.False },
      { label: 'True', value: SpecialValue.True },
    ];
    const nullModes = [NullValueMode.Ignore, NullValueMode.AsZero];

    result.partB_reducers = [];
    for (const eo of emptyOpts) {
      for (const nm of nullModes) {
        const frame = await transformFresh(eo.value);
        const c2 = frame.fields.find((f: any) => f.name === 'C2')!;
        c2.config = { ...c2.config, nullValueMode: nm };
        const calcs = reduceField({ field: c2, reducers: [ReducerID.sum, ReducerID.mean, ReducerID.count] });
        result.partB_reducers.push({
          emptyValue: eo.label,
          nullValueMode: nm,
          c2Values: c2.values.map((v: any) => (v === '' ? '"" (empty string)' : v)),
          sum: calcs.sum,
          sumType: typeof calcs.sum,
          mean: calcs.mean,
          meanType: typeof calcs.mean,
          count: calcs.count,
          nonNullCount: calcs.nonNullCount,
        });
      }
    }

    const steps: Threshold[] = [
      { value: -Infinity, color: 'green(base)' },
      { value: 50, color: 'orange' },
      { value: 80, color: 'red' },
    ];
    const inputs: Array<{ input: string; raw: any }> = [
      { input: 'empty string ""', raw: '' },
      { input: 'null', raw: null },
      { input: 'zero 0', raw: 0 },
      { input: 'false', raw: false },
      { input: 'true', raw: true },
    ];
    result.partC_thresholds = inputs.map(({ input, raw }) => {
      const t = getActiveThreshold(raw as any, steps);
      return {
        input,
        rawValue: JSON.stringify(raw),
        activeColor: t.color,
        activeStepValue: t.value,
      };
    });

    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    expect(fs.existsSync(OUT)).toBe(true);
  });
});
```

**Cleanup discipline.** After capture, the harness was deleted and `git status --porcelain` confirmed the repository contained only this new documentation file — no source file, manifest, or lockfile was modified.
