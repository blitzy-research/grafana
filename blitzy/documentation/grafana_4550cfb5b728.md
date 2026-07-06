# Grouping to matrix: what value is emitted for a missing row/column intersection, and how it propagates downstream

**Repository:** `grafana/grafana`
**Pinned commit (HEAD):** `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`
**Investigation type:** read-only, run-first codebase Q&A. The only file added to the repository is this document. No existing source, test, configuration, or documentation file was modified.

---

## 1. Direct answer

**For a row+column intersection that never appears in the sparse source data, Grafana's "Grouping to matrix" transformation emits the empty string `''` — not `0`, and (by default) not `null`.** There is **no way to make it emit `0`**: the option that governs the missing cell (`SpecialValue`) offers only `True`, `False`, `Null`, and `Empty` — there is **no `Zero` member** at this commit.

Why, in one paragraph, grounded in code and confirmed by running it:

- The missing-cell value is computed by `const value = matrixValues[columnName][rowName] ?? getSpecialValue(emptyValue);` at `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts:L117`. The coalescing operator is **nullish** (`??`), so only `null`/`undefined`/absent keys trigger the fallback — a present `0` is preserved.
- `emptyValue` resolves via `const emptyValue = options.emptyValue || DEFAULT_EMPTY_VALUE;` (`groupingToMatrix.ts:L71`), and `DEFAULT_EMPTY_VALUE = SpecialValue.Empty` (`groupingToMatrix.ts:L26`).
- `getSpecialValue` maps `Empty` (and the `default`) to `''`: `case SpecialValue.Empty: default: return '';` (`groupingToMatrix.ts:L186-L188`).
- The emitted value is written into an output field that **keeps the value field's original type** (usually `number`): `fields.push({ name: columnName.toString(), values, config: valueField.config, type: valueField.type })` (`groupingToMatrix.ts:L129-L134`, type at `L133`). This type/value mismatch (`''` inside a `number` field) is the root of every downstream inconsistency below.
- The closed option set is `export enum SpecialValue { True = 'true', False = 'false', Null = 'null', Empty = 'empty' }` (`packages/grafana-data/src/types/transformations.ts:L113-L118`) — **no `Zero`**, so no code path can produce `0` and no user option can request it.

**Answer at a glance** (all values observed at runtime through the real entry point `transformDataFrame`; see §3–§6 for the commands and complete output):

| `emptyValue` option | Missing-cell value emitted | Present `0` preserved? | Column total via `reduceField` (footer math)            | Rendered cell text |
| ------------------- | -------------------------- | ---------------------- | ------------------------------------------------------- | ------------------ |
| `Empty` (default)   | `''` (empty string)        | Yes                    | **string-corrupted** (`"82"`, `"060"`)                  | blank              |
| `Null`              | `null`                     | Yes                    | clean numeric (`82`, `60`) — but still not per-cell `0` | blank              |
| `True`              | `true`                     | Yes                    | numeric-but-wrong (`83`, `62`; `true`→`1`)              | `"true"`           |
| `False`             | `false`                    | Yes                    | numeric (`82`, `60`; `false`→`0`)                       | `"false"`          |
| _(any option)_      | —                          | —                      | **never `0` per-cell**                                  | —                  |

The operator's usual intent — "a missing cell means `0`" — is **unreachable at this commit** (§7).

---

## 2. Environment and exact commands

- **Commit (HEAD):** `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` (verified with `git rev-parse HEAD`).
- **Node.js:** `v22.12.0` (the repo's `.nvmrc` pins `v22.11.0`; the canonical image ships `v22.12.0`, which satisfies `engines.node` `">= 22"`).
- **Package manager:** `yarn@4.5.3` (via Corepack).
- **Test harness:** Jest `29.7.0` with the root `jest.config.js` (jsdom env, `ts-jest`, `process.env.TZ = 'Pacific/Easter'`).
- **Real entry point exercised:** the transform was run through `transformDataFrame` (`packages/grafana-data/src/transformations/transformDataFrame.ts:L76`) with the registered `groupingToMatrixTransformer` (registered in `standardTransformers` at `packages/grafana-data/src/transformations/transformers.ts:L56`), registered for the test via `mockTransformationsRegistry([groupingToMatrixTransformer])`. The operator was **not** called directly, and no synthetic stand-in was used. All downstream consumers (`reduceField`, `getDisplayProcessor`, `getActiveThreshold`, `getScaleCalculator`) are the real exported functions.

**Command A — the committed canonical spec** (the repository's own before/after contract; run with watch disabled because the root `test` script is watch-mode):

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true \
  yarn jest packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts \
  --ci --watchAll=false
```

Result:

```
Test Suites: 1 passed, 1 total
Tests:       4 passed, 4 total
Snapshots:   1 passed, 1 total
Time:        1.589 s
```

That spec imports the real `transformDataFrame` (`groupingToMatrix.test.ts:L5`), registers the transformer (`L12`), and asserts the canonical contract: default missing cells are `''` inside `FieldType.number` fields (`[1, '', '']` at `L41`, `['', 2, '']` at `L47`, `['', '', 3]` at `L53`) and the `Null` option yields `null` (`[1, null]` at `L136`, `[null, 2]` at `L142`). Its passing therefore confirms, canonically, that the default emits `''` and `Null` emits `null` inside number-typed fields.

**Command B — the concrete-dataset observation spec** (temporary; created under the repo tree with the mandated `blitzy_adhoc_test_` prefix, run, then removed — see §10). Grafana's `public/test/setupTests.ts` fails any test that calls `console.log`, so the spec writes its output to `/tmp/blitzy_obs_grouping_output.txt` and also encodes the values as `expect` assertions:

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true \
  yarn jest packages/grafana-data/src/transformations/transformers/blitzy_adhoc_test_grouping_obs.test.ts \
  --ci --watchAll=false
```

Result: `Tests: 1 passed, 1 total`. The complete captured output is reproduced verbatim in §4–§6. It was confirmed **identical across two runs** (`diff run1 run2` produced no output, exit `0`) — §5.2 magnitude stability.

---

## 3. The concrete sparse dataset (O4)

A single `DataFrame` with three fields — a Column key (`Status`), a Row key (`Server`), and a numeric Value (`Temp`). It is deliberately sparse and deliberately contains a **present zero**:

| `Status` (Column, `FieldType.string`) | `Server` (Row, `FieldType.string`) | `Temp` (Value, `FieldType.number`) |
| ------------------------------------- | ---------------------------------- | ---------------------------------- |
| `OK`                                  | `server1`                          | `82`                               |
| `OK`                                  | `server2`                          | `0` ← **a present zero**           |
| `Shutdown`                            | `server3`                          | `60`                               |

- **Present pairs:** `OK/server1 = 82`, `OK/server2 = 0`, `Shutdown/server3 = 60`.
- **Intersections that never appear:** `OK/server3`, `Shutdown/server1`, `Shutdown/server2`.

The transform is invoked with `options: { columnField: 'Status', rowField: 'Server', valueField: 'Temp' }`. The frame is built exactly as the committed spec does, with `toDataFrame` from `packages/grafana-data/src/transformations/dataframe/processDataFrame`:

```ts
function buildSparseFrame() {
  return toDataFrame({
    name: 'servers',
    fields: [
      { name: 'Status', type: FieldType.string, values: ['OK', 'OK', 'Shutdown'] },
      { name: 'Server', type: FieldType.string, values: ['server1', 'server2', 'server3'] },
      { name: 'Temp', type: FieldType.number, values: [82, 0, 60] },
    ],
  });
}

// REAL ENTRY POINT — transformDataFrame with the registered standard transformer:
const result = await lastValueFrom(transformDataFrame([cfg], [buildSparseFrame()]));
```

The output matrix has one row-header field (`Server\Status`) plus one field per distinct column key (`OK`, `Shutdown`); the row order is `[server1, server2, server3]`.

---

## 4. Transform output (O1) — the emitted value is `''`, and a present `0` is preserved

Real serialized `processed[0].fields` for the **default (`Empty`)** run (this is the direct, unedited output written by the observation spec):

```
[A] REAL transform output  (processed[0].fields, JSON.stringify):
[
  {
    "name": "Server\\Status",
    "values": [
      "server1",
      "server2",
      "server3"
    ],
    "type": "string",
    "config": {}
  },
  {
    "name": "OK",
    "values": [
      82,
      0,
      ""
    ],
    "config": {},
    "type": "number"
  },
  {
    "name": "Shutdown",
    "values": [
      "",
      "",
      60
    ],
    "config": {},
    "type": "number"
  }
]

[A2] Per-column cell values (row order = [server1, server2, server3]):
   field "Server\Status" (type=string): [ "server1", "server2", "server3" ]
   field "OK" (type=number): [ 82, 0, "" ]
   field "Shutdown" (type=number): [ "", "", 60 ]

[A3] PRESENT-ZERO check — (OK, server2) cell = 0  (typeof number)
```

Reading of the output:

- The missing intersections `OK/server3` (row 3 of column `OK`) and `Shutdown/server1`, `Shutdown/server2` (rows 1–2 of column `Shutdown`) are each the **empty string `''`**, inside fields whose declared `type` is `"number"`. This is the type/value mismatch: `''` (a string) lives in a `number`-typed field. Cause: the fallback at `groupingToMatrix.ts:L117` (`?? getSpecialValue(emptyValue)`), `getSpecialValue` returning `''` for `Empty`/default (`L186-L188`), and the output field inheriting `valueField.type` (`L133`).
- The **present `0`** at `(OK, server2)` remains `0` with `typeof number`. Cause: the fallback uses **nullish** coalescing (`??`), so a real `0` (which is neither `null` nor `undefined`) is never replaced. This is exactly why `??` matters rather than `||`: `0 || x` would have discarded the zero, but `0 ?? x` keeps it.

This directly answers O1: **the emitted value for a missing cell is `''` (empty string); it is never `0`.**

---

## 5. Downstream propagation (O2)

The emitted `''` (and its `Null`/`True`/`False` siblings) was fed into each downstream consumer through its real exported function. Each subsection gives the command context, the complete observed output, the `file:line` citation, and the cause→effect.

### 5.1 Rendering — `getDisplayProcessor`

Command context: `getDisplayProcessor({ field, theme })` (`packages/grafana-data/src/field/displayProcessor.ts`) was called on each transformed column field (config as emitted), and the returned display function was invoked on each distinct cell value. Observed output (default `Empty` run, then the `Null`/`True`/`False` variants):

```
[D] Rendering via REAL getDisplayProcessor(field) → display(cellValue) = { text, numeric, color }:

  VARIANT Empty (default):
   column "OK" value 82  ->  { text: "82", numeric: 82, color: "#808080" }
   column "OK" value 0  ->  { text: "0", numeric: 0, color: "#808080" }
   column "OK" value ""  ->  { text: "", numeric: NaN, color: "#808080" }
   column "Shutdown" value ""  ->  { text: "", numeric: NaN, color: "#808080" }
   column "Shutdown" value 60  ->  { text: "60", numeric: 60, color: "#808080" }

  VARIANT Null:
   column "OK" value null  ->  { text: "", numeric: NaN, color: "#808080" }
   column "Shutdown" value null  ->  { text: "", numeric: NaN, color: "#808080" }

  VARIANT True:
   column "OK" value true  ->  { text: "true", numeric: 1, color: "#808080" }
   column "Shutdown" value true  ->  { text: "true", numeric: 1, color: "#808080" }

  VARIANT False:
   column "OK" value false  ->  { text: "false", numeric: 0, color: "#808080" }
   column "Shutdown" value false  ->  { text: "false", numeric: 0, color: "#808080" }
```

Cause→effect:

- For `''` (Empty) and `null` (Null): the display closure computes `numeric = isStringUnit ? NaN : anyToNumber(value)` (`displayProcessor.ts:L96`). `anyToNumber('')` and `anyToNumber(null)` both return `NaN` because of `if (value === '' || value === null || value === undefined || Array.isArray(value)) { return NaN; }` (`packages/grafana-data/src/utils/anyToNumber.ts:L13-L14`). Because `numeric` is `NaN`, the `if (!Number.isNaN(numeric)) { ... }` block (`displayProcessor.ts:L144`) is **skipped**, so no numeric text and no primary (numeric) color are set; `text` then falls through to blank via `if (text == null) { text = toString(value); if (!text) { ...; text = ''; } }` (`L177-L186`). **Effect: the missing cell renders blank.**
- For `true`/`false` (True/False): `anyToNumber(true) = 1` and `anyToNumber(false) = 0` (boolean branch `return value ? 1 : 0;` at `anyToNumber.ts:L17-L18`) — not `NaN` — so the numeric block runs (for color), but the text branch is guarded by `if (text == null && !isBoolean(value))` (`L145`); since the value _is_ boolean, `formatFunc` does not set text, and `text` falls to `toString(value)` (`L178`). **Effect: the cell renders the literal text `"true"`/`"false"`.**
- The `color` is `#808080` here because the transformed field carries no thresholds config (it inherited `valueField.config`, which was empty); `#808080` is the gray `FALLBACK_COLOR` produced by the base-color path `if (!color) { const scaleResult = scaleFunc(-Infinity); ... }` (`L188-L192`). With a thresholds config present the base color is the base threshold instead — see §5.4, where the blank cell renders the **same base green as a real `0`**.

### 5.2 Totals / footer — `reduceField` → `doStandardCalcs`

Command context: for each transformed column field, the real `reduceField({ field, reducers: [ReducerID.sum] })` (`packages/grafana-data/src/transformations/fieldReducer.ts:L159`) was called and `calcs.sum` captured together with its `typeof`. This is the **same** computation the Table-panel footer performs (§5.5). Observed output across all four options:

```
[C] Totals via REAL reduceField({ field, reducers: [ReducerID.sum] }).sum  (footer math):

  VARIANT Empty (default):
   column "OK": sum = "82"    (typeof string)     <-- CORRUPTED
   column "Shutdown": sum = "060"    (typeof string)     <-- CORRUPTED (leading-zero artifact)

  VARIANT Null:
   column "OK": sum = 82    (typeof number)        <-- clean
   column "Shutdown": sum = 60    (typeof number)        <-- clean

  VARIANT True:
   column "OK": sum = 83    (typeof number)        <-- WRONG (true -> 1 added)
   column "Shutdown": sum = 62    (typeof number)        <-- WRONG (two true -> 1+1)

  VARIANT False:
   column "OK": sum = 82    (typeof number)        <-- coincidental (false -> 0)
   column "Shutdown": sum = 60    (typeof number)
```

**Magnitude stability (Rule 7):** the observation spec was executed twice; `diff` of the two output files produced no differences (`IDENTICAL ACROSS 2 RUNS`, exit `0`). The corrupted totals `"82"` and `"060"` are stable.

Cause→effect (why `Empty` corrupts but `Null` does not):

- A single-`sum` reduction goes through `doStandardCalcs` (`fieldReducer.ts:L468`), not a fast path: the fast path `if (queue.length === 1 && queue[0].reduce) { ... }` (`L204-L211`) requires a standalone `reduce` function, but the `sum` reducer definition (`{ id: ReducerID.sum, name: 'Total', emptyInputResult: 0, standard: true, ... }` at `L307`) has **no** `reduce` field, so execution falls through to the standard calculation loop.
- Accumulation starts from `defaultCalcs` with `sum: 0` (`L445-L466`, `sum` at `L446`).
- The per-value guard is `if (currentValue != null && !Number.isNaN(currentValue))` (`L500`). For `''`: `'' != null` is `true` and `Number.isNaN('')` is `false`, so **`''` passes the guard**.
- The field is numeric (`isNumberField = field.type === FieldType.number || field.type === FieldType.time`, `L478`; the transform output field kept `type: 'number'` at `groupingToMatrix.ts:L133`), so it executes `calcs.sum += currentValue` (`L507-L508`). In JavaScript, `0 + ''` yields the string `"0"`, and each subsequent `+=` **concatenates**. For column `Shutdown` the values are `['', '', 60]`: `0 + '' → "0"`, `"0" + '' → "0"`, `"0" + 60 → "060"` — exactly the observed `"060"`. For column `OK` the values are `[82, 0, '']`: `0 + 82 → 82`, `82 + 0 → 82`, `82 + '' → "82"` — the observed `"82"`. **Effect: the footer total is a string, silently corrupting the numeric sum.**
- For the `Null` option, `null` is short-circuited earlier by `if (currentValue == null) { if (ignoreNulls) { continue; } ... }` (`L489-L491`) under the default `NullValueMode.Ignore` (`L198`), so it is skipped cleanly and the sums stay numeric (`82`, `60`). **This is clean — but still not a per-cell `0`.**
- For `True`/`False`, the booleans pass the guard and are added numerically (`true → 1`, `false → 0`), producing `83`/`62` and `82`/`60` respectively — numeric but semantically wrong (they count "missing" as `1` or `0` depending on the option, not as an absent value).

### 5.3 Thresholds — `getActiveThreshold`

Command context: the raw JavaScript coercion used by the threshold comparison was evaluated, and the real `getActiveThreshold(value, steps)` (`packages/grafana-data/src/field/thresholds.ts:L7-L22`) was called for each candidate value against steps `[{0,green},{50,orange},{80,red}]`. Observed output:

```
[E] THRESHOLDS — getActiveThreshold(value, steps) uses `value >= threshold.value` (thresholds.ts:L15)
    fallBackThreshold = { value: 0, ... } (thresholds.ts:L5)
    Raw JS coercion of the emitted values in that comparison:
      '' >= 0    -> true
      null >= 0  -> true
    getActiveThreshold(<value>, [ {0,green},{50,orange},{80,red} ]).value / .color :
      value ""  ->  threshold { value: 0, color: "green" }
      value null  ->  threshold { value: 0, color: "green" }
      value 0  ->  threshold { value: 0, color: "green" }
      value 60  ->  threshold { value: 50, color: "orange" }
      value 82  ->  threshold { value: 80, color: "red" }
```

Cause→effect: `getActiveThreshold` walks the steps and keeps the last step for which `value >= threshold.value` (`thresholds.ts:L15`), starting from `fallBackThreshold = { value: 0, color: FALLBACK_COLOR }` (`L5`). In `'' >= 0`, JavaScript coerces `''` to `0`, so the comparison is `true`; likewise `null >= 0` is `true`. **Effect: a blank `''` (and `null`) selects the _same_ base threshold as a real `0` — at the threshold level a missing cell is indistinguishable from a genuine `0`.** (This is a semantic coincidence, not evidence that `0` is emitted: the emitted value remains `''`/`null` per §4; the coercion only happens inside the `>=` comparison.)

### 5.4 Color scale — `getScaleCalculator`

Command context: `getScaleCalculator(field, theme)` (`packages/grafana-data/src/field/scale.ts:L19-L44`) was built for a `number` field carrying thresholds `[{-Infinity,green},{50,orange},{80,red}]`, and evaluated at several values; then `getDisplayProcessor` was run on the same field to show the rendered color for each cell. Observed output:

```
[F] COLOR SCALE — getScaleCalculator(field) on a NUMBER field with thresholds
    (missing cell reaches color via displayProcessor `if(!color) scaleFunc(-Infinity)`; percent stays 0)
   scale(-Infinity)  ->  { percent: 0, thresholdColor: "green", color: "#73BF69" }
   scale(NaN)  ->  { percent: 0, thresholdColor: "green", color: "#73BF69" }
   scale(0)  ->  { percent: 0, thresholdColor: "green", color: "#73BF69" }
   scale(60)  ->  { percent: 0.7317073170731707, thresholdColor: "orange", color: "#FF9830" }
   scale(82)  ->  { percent: 1, thresholdColor: "red", color: "#F2495C" }

   getDisplayProcessor on the SAME thresholds field:
      value ""  ->  { text: "", numeric: NaN, color: "#73BF69" }
      value 0  ->  { text: "0", numeric: 0, color: "#73BF69" }
      value 60  ->  { text: "60", numeric: 60, color: "#FF9830" }
      value 82  ->  { text: "82", numeric: 82, color: "#F2495C" }
```

Cause→effect: for a blank cell, `displayProcessor` reaches color through the base path `if (!color) { const scaleResult = scaleFunc(-Infinity); ... }` (`displayProcessor.ts:L188-L192`). Inside `getScaleCalculator`, when `value === -Infinity` the `if (value !== -Infinity)` guard (`scale.ts:L31`) is skipped so `percent` stays `0` (`L29`), and the active threshold comes from `getActiveThresholdForValue(...)` (`L39`) — the base green `#73BF69`. **Effect: the blank cell renders the base-threshold color, which is the _same_ color a real `0` renders (`scale(0)` → `#73BF69`).** Visually, a missing cell and a genuine `0` are indistinguishable in both text (blank vs `"0"` differ, but color matches) and color-background.

### 5.5 Table panel — the real visualization surface

The Table panel wires its footer via `footerOptions={options.footer}` (`public/app/plugins/panel/table/TablePanel.tsx:L65`), and the footer value is computed in `packages/grafana-ui/src/components/Table/utils.ts` by `const fieldCalcValue = reduceField({ field, reducers: reducer })[calc];` (`utils.ts:L404`; `getFooterValue` imported at `L37`, used at `L151`). That is the **identical** `reduceField` → `doStandardCalcs` path exercised in §5.2. Therefore the corrupted totals observed there (`"82"`, `"060"`) are exactly what surfaces in a real Table footer for the default `Empty` option. The `reduceField` invocation in §5.2 _is_ the footer's computation and is canonical for the footer math; a full React Table render was not performed in this unit context (the footer arithmetic is fully captured by the `reduceField` call).

---

## 6. Full cross-product — `{Empty, Null, True, False}` × `{missing cell, present 0}` × `{render, total, threshold, color}`

All values below were observed at runtime. "Missing cell" is `(Shutdown, server1)` (an intersection that never appears); "present 0" is `(OK, server2)` (a genuine zero in the source). Render `text`/`numeric` and `color` are from `getDisplayProcessor`; `total` is the whole-column `reduceField(sum)`; `threshold` is `getActiveThreshold` against `[{0,green},{50,orange},{80,red}]`.

| Option              | Cell case | Emitted value | Render `text` | Render `numeric` | Render `color` (no-config field) | Column `sum` (footer)                                                 | Active threshold                                |
| ------------------- | --------- | ------------- | ------------- | ---------------- | -------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| **Empty** (default) | missing   | `''`          | `""` (blank)  | `NaN`            | `#808080` (base gray)            | `"060"` _(string, corrupted)_                                         | `{0, green}` (`'' >= 0` → true)                 |
| **Empty** (default) | present 0 | `0`           | `"0"`         | `0`              | `#808080`                        | `"82"` for column `OK` _(string, corrupted by the column's own `''`)_ | `{0, green}`                                    |
| **Null**            | missing   | `null`        | `""` (blank)  | `NaN`            | `#808080`                        | `60` _(number, clean)_                                                | `{0, green}` (`null >= 0` → true)               |
| **Null**            | present 0 | `0`           | `"0"`         | `0`              | `#808080`                        | `82` _(number, clean)_                                                | `{0, green}`                                    |
| **True**            | missing   | `true`        | `"true"`      | `1`              | `#808080`                        | `62` _(number, wrong; two `true`→1+1)_                                | `{0, green}` (`true` coerces to `1` → `1 >= 0`) |
| **True**            | present 0 | `0`           | `"0"`         | `0`              | `#808080`                        | `83` for column `OK` _(number, wrong)_                                | `{0, green}`                                    |
| **False**           | missing   | `false`       | `"false"`     | `0`              | `#808080`                        | `60` _(number; `false`→0)_                                            | `{0, green}` (`false` coerces to `0`)           |
| **False**           | present 0 | `0`           | `"0"`         | `0`              | `#808080`                        | `82` for column `OK` _(number)_                                       | `{0, green}`                                    |

Notes:

- The **present `0`** is preserved in every one of the eight rows (`typeof number`), because the fallback is nullish (`??`, `groupingToMatrix.ts:L117`).
- The **missing cell is never `0`** in any row — it is `''`/`null`/`true`/`false` depending on the option.
- The **color** column shows `#808080` because the transformed fields inherited an empty config; when a thresholds config is present, both the missing cell and a real `0` render the base green `#73BF69` (§5.4) — i.e., the missing cell is colored identically to a real `0`, reinforcing the visual confusion.
- The **corruption is confined to the `Empty` default** at the _totals_ stage; `Null` is clean-but-not-zero, and `True`/`False` are numeric-but-semantically-wrong.

---

## 7. O3 — where the semantics diverge from "missing means zero"

**Plainly: no code path yields `0` for a missing intersection, and no option can request it.** The operator's usual intent (a missing cell means `0`) is unreachable at this commit.

- The option set is closed and has no zero: `export enum SpecialValue { True = 'true', False = 'false', Null = 'null', Empty = 'empty' }` (`packages/grafana-data/src/types/transformations.ts:L113-L118`). Verified in the committed tree with `git show HEAD:packages/grafana-data/src/types/transformations.ts` — only the four members, **no `Zero`**.
- `getSpecialValue` therefore has no `Zero` case and never returns `0`; its cases are `False → false` (`groupingToMatrix.ts:L180-L181`), `True → true` (`L182-L183`), `Null → null` (`L184-L185`), and `Empty`/`default → ''` (`L186-L188`). Verified with `git show HEAD:.../groupingToMatrix.ts | grep -n "Zero\|return 0"` → no matches.
- The **pivot** that makes this subtle is the default `''`: it renders as a _blank_ cell (because `anyToNumber('') = NaN`, §5.1) — which visually resembles "nothing" and, at thresholds/color, resolves to the same base step as a real `0` (§5.3–§5.4) — **yet it silently corrupts numeric totals into a string** (`"82"`, `"060"`, §5.2). So the value looks harmless where a human eyeballs it, but breaks aggregation. Even the "clean" alternative (`Null`) only avoids the corruption; it still does not put a `0` in the cell, so a downstream sum treats the cell as absent rather than as `0`.

**Context only (no fix introduced or assumed).** This gap is a known, tracked limitation, and the corruption a reported real-world symptom — but the code at the pinned commit is the source of truth:

- grafana/grafana **#97632** — "Transformations: Grouping to matrix doesn't support 0 for undefined combinations" — reports that cells are empty rather than `0` and that this disrupts downstream visualizations (e.g., Bar Chart grouping), with the reporter expecting the cells to hold `0`. This corroborates O3.
- A Grafana community report ("Transform Grouping To Matrix issue") describes that, with blank columns, footer addition behaves as string concatenation rather than numeric addition — corroborating the `"060"`/`"82"` totals observed in §5.2.
- grafana/grafana **#97642** — "Transformations: GroupToMatrix add 0 as special value" (commit `c901b76a8a`) — is the upstream change that adds a zero option. It is **not** an ancestor of HEAD `4550cfb5`: `git merge-base --is-ancestor c901b76a8a HEAD` returns non-zero (NO), and the commit is reachable only from `main`/`origin/main`. Therefore, **at this commit the empty-string behavior is canonical and no zero option exists.** This document explains the behavior at `4550cfb5`; it does not backport or assume the fix.

---

## 8. Secondary and edge conditions

- **Frame-count guard.** The transformer returns the input unchanged when the frame count is not exactly one: `if (data.length !== 1) { return data; }` (`groupingToMatrix.ts:L74-L76`). So the matrix (and the missing-cell fallback) is only produced for a single input frame. _(inferred — read from source; not separately executed in the observation spec, which always passes exactly one frame.)_
- **Field-not-found guard.** If the configured column/row/value field cannot be resolved, the transformer returns the input unchanged: `if (!keyColumnField || !keyRowField || !valueField) { return data; }` (`groupingToMatrix.ts:L84-L86`). _(inferred.)_
- **Dataplane fallback toggle.** Field matching is influenced by `supportDataplaneFallback = ...featureToggles?.dataplaneFrontendFallback` (`groupingToMatrix.ts:L28-L31`, used at `L125`); with the default (toggle off) the plain field names are matched, as in this investigation. _(inferred — the default configuration was used; the toggle was not flipped.)_
- **`emptyValue` resolution uses `||`, not `??`.** `const emptyValue = options.emptyValue || DEFAULT_EMPTY_VALUE;` (`L71`). Because the enum has no empty/zero-ish string member that is falsy (all members are non-empty strings `'true'`/`'false'`/`'null'`/`'empty'`), this `||` behaves correctly for every valid option; only an omitted/undefined option falls back to `Empty`. _(inferred — the four options were exercised explicitly and the omitted-option default was observed as `''`.)_

---

## 9. Cross-check with the user-facing surfaces

The four-option, no-zero set is consistent across the editor UI, the in-app help, and the docs site — each agreeing with the `SpecialValue` enum:

- **Editor dropdown:** `specialValueOptions` lists Null / True / False / Empty (`public/app/features/transformers/editors/GroupingToMatrixTransformerEditor.tsx:L61-L66`), rendered by a `Select` (`L101`); the registry item wires `standardTransformers.groupingToMatrixTransformer` (`L108-L116`, transformation at `L111`). No zero option.
- **In-app help:** the help text states the missing-cell value can be chosen "between: **Null**, **True**, **False**, or **Empty**." (`public/app/features/transformers/docs/content.ts:L631`; block header `name: 'Grouping to matrix'` at `L618`).
- **Docs site:** the "Grouping to matrix" section (`docs/sources/panels-visualizations/query-transform-data/transform-data/index.md:L653`) enumerates the same four options (`L665`), and its **Output example literally shows blank cells** for the missing intersections (`L668-L673`) — a documented confirmation that `''` renders blank.
- **External corroboration (context):** Amazon Managed Grafana's transformation reference likewise lists the choices as Null, True, False, or Empty — no zero.

---

## 10. Integrity confirmation

- The transform was exercised through the **real** `transformDataFrame` entry point with the registered `groupingToMatrixTransformer`; every downstream value came from the real exported functions (`reduceField`, `getDisplayProcessor`, `getActiveThreshold`, `getScaleCalculator`). No bypassing interface, fallback, or synthetic stand-in produced any reported value. The raw `'' >= 0` / `null >= 0` results in §5.3 are direct JavaScript evaluations demonstrating the coercion that `getActiveThreshold` relies on at `thresholds.ts:L15`, and they were also confirmed via the real `getActiveThreshold` calls shown in the same block.
- Reported magnitudes were confirmed **stable across two runs** (§5.2).
- The unrelated `remotes/origin/blitzy-7e848cb5-...` branch was **not** read or copied; this answer was derived independently from the code at `4550cfb5` and the observed runtime output.
- All temporary observation scripts were removed (the observation spec `blitzy_adhoc_test_grouping_obs.test.ts` and the `/tmp/blitzy_obs_*.txt` output files), and the working tree was verified byte-for-byte unchanged except for this document. The plain `git status --porcelain` collapses the wholly-untracked directory to `blitzy/`; expanding with `--untracked-files=all` shows the single file is the only addition:

```bash
$ git status --porcelain
?? blitzy/

$ git status --porcelain --untracked-files=all
?? blitzy/documentation/grafana_4550cfb5b728.md
```

- No tracked file was modified — `git diff --stat` produces no output — and `HEAD` is still `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`:

```bash
$ git diff --stat
$ git rev-parse HEAD
4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff
```

_(The `blitzy/documentation/` directory did not previously exist and was created solely to hold this file; the `??` marks it as the only untracked addition. No existing repository file was modified, added to, or deleted.)_
