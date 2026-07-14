# Grouping to matrix — what value fills the missing cells, and how it behaves downstream

## Direct answer

**When a `(row, column)` combination is missing from a sparse input, Grafana's "Grouping to matrix"
transformation emits the empty string `''` by default — not `0`, and not `null`.** [OBSERVED]

- The missing cell is resolved at
  `const value = matrixValues[columnName][rowName] ?? getSpecialValue(emptyValue);`
  (`packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts:117`).
- The default `emptyValue` is `SpecialValue.Empty`
  (`const DEFAULT_EMPTY_VALUE = SpecialValue.Empty;` — `groupingToMatrix.ts:26`), applied at
  `const emptyValue = options.emptyValue || DEFAULT_EMPTY_VALUE;` — `groupingToMatrix.ts:71`.
- `getSpecialValue` (`groupingToMatrix.ts:178`) maps the default `Empty` → `''`
  (`groupingToMatrix.ts:186-188`); it also maps `False → false` (`:180-181`), `True → true`
  (`:182-183`), and `Null → null` (`:184-185`).

**The value can be configured to `Null`, `True`, or `False`, but there is _no_ `Zero` option.** [OBSERVED]

- The `SpecialValue` enum contains exactly `True`, `False`, `Null`, `Empty` — and nothing else
  (`packages/grafana-data/src/types/transformations.ts:113-117`).
- The transform editor's **"Empty Value"** dropdown mirrors exactly those four choices
  (`public/app/features/transformers/editors/GroupingToMatrixTransformerEditor.tsx:61-66`, with
  `<InlineField label="Empty Value">` at `:100`); the in-app help lists the same four
  (`public/app/features/transformers/docs/content.ts:631`). **So "missing means zero" is not a value
  you can select.**

**The root of the perceived inconsistency is a type/semantic mismatch.** [OBSERVED] The output column
field's declared `type` is _copied from the value field_ (typically `number`) at `type: valueField.type,`
(`groupingToMatrix.ts:133`; the column name is set at `:130`). So a field that _declares itself_ `number`
ends up **holding a string `''`** for missing cells. Downstream code then coerces that `''` **differently
in every path**:

| Downstream path             | What actually happens to the missing `''`                                                               | Reads as `0`? |
| --------------------------- | ------------------------------------------------------------------------------------------------------- | :-----------: |
| Totals (SUM), raw reducer   | String concatenation; the total is a **string** whose text depends on cell position (`"5"`, `"05"`, …)  |      No       |
| Totals (SUM), table footer  | The raw string is **re-parsed** by the display processor, so the footer shows `"5"` (from `"05"`, …)    |    Numeric    |
| Per-cell text (table body)  | `anyToNumber('') = NaN` → the cell text is **blank**                                                    |      No       |
| Per-cell color (table body) | `NaN` skips numeric scaling, so the cell takes the **base/lowest** color via `scaleFunc(-Infinity)`     |   No (base)   |
| Thresholds (raw function)   | `'' >= step` coerces `'' → 0` — but the **table body does not use this path** (it uses the color above) |   Yes (raw)   |
| Color scale (raw function)  | `(value - min)` coerces `'' → 0`, percent `0` — again **not** the path the table body renders through   |   Yes (raw)   |

That divergence — a **string** in a raw total, a re-parsed number in the footer, blank text plus a
base-band color in the cell — is exactly the "different choice somewhere along the way" the dashboard
exhibits.

**Bottom line for the "missing means zero" model:** it is not expressible directly (there is no `Zero`).
The closest clean result for **totals/means** is `emptyValue = SpecialValue.Null` on the transform **plus**
the null-as-zero null-value mode (`NullValueMode.AsZero`) on the field — but that mode is honored only by
the reducers, **not** by the per-cell display (missing cells still render blank; see
[§4](#4-missing-means-zero-done-correctly)).

---

## How this was verified (run-first) and provenance

Every behavioral claim below is labeled **[OBSERVED]** (captured from an actual run of the real code path)
or **[INFERRED]** (reasoned from reading the source). The observed values were produced by exercising the
**registered** `groupingToMatrix` transformer through its canonical entry point `transformDataFrame`, then
feeding the transformed field into the real downstream pipeline (`reduceField`, `getActiveThreshold`,
`getScaleCalculator`, `getDisplayProcessor`) and the real table footer path (`getFooterItems`). No Grafana
source file was modified; the harness lived in a private temporary directory outside the checkout and was
removed afterward. The complete harness source, config, and unedited output are in
[§6.3](#63-the-safe-reproducible-observation-harness)–[§6.4](#64-complete-captured-output).

**Provenance**

| Item                            | Value                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Grafana version                 | `11.5.0-pre` (`package.json`)                                                                                              |
| Branch                          | `blitzy-c5fb97cc-48b1-4f5d-8122-07151346d787`                                                                              |
| Source baseline (parent commit) | `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` — the commit whose short SHA names this deliverable (its parent on this branch) |
| This deliverable                | committed on the branch above, atop that baseline (this revision supersedes the initial documentation commit `64e977e531`) |
| Node (pinned by `.nvmrc`)       | `v22.11.0`                                                                                                                 |
| Node (actual runtime used)      | `v22.23.1`                                                                                                                 |
| Yarn (vendored)                 | `4.5.3` (`.yarn/releases/yarn-4.5.3.cjs`)                                                                                  |
| Jest                            | `29.7.0`                                                                                                                   |

All `file:line` citations were verified against the source tree at the baseline above, which is
**byte-for-byte unchanged** on this branch — the only file added anywhere is this document
(`git status` confirmed clean; see [§6.4](#64-complete-captured-output)).

Commands used are **non-interactive, CI mode** (never the repo-root `test` script, which runs in watch
mode). The canonical project spec and the observation harness are both shown in full in
[§6.3](#63-the-safe-reproducible-observation-harness).

```bash
# Canonical spec — exercises transformDataFrame on a sparse dataset (the project's own test):
CI=true node .yarn/releases/yarn-4.5.3.cjs jest \
  packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts \
  --watchAll=false --ci
#   => Test Suites: 1 passed, Tests: 4 passed, Snapshots: 1 passed
```

> **Why the transform is exercised through a registration helper.** The harness registers the **real**
> transformer with `mockTransformationsRegistry([groupingToMatrixTransformer])` — exactly how the project's
> own spec (`groupingToMatrix.test.ts:12`) registers it so `transformDataFrame` can resolve it by id. That
> helper registers the genuine transformer; it does **not** mock or bypass the transformation logic.

---

## 1. The transform boundary — what value is emitted

**Input frame** (three fields; the `(C2, R2)` pairing is deliberately absent):

| Column | Row | Temp |
| ------ | --- | ---- |
| C1     | R1  | 1    |
| C1     | R2  | 4    |
| C2     | R1  | 5    |

Pivoting on `Column` (columns), `Row` (rows), `Temp` (cell value) yields a matrix with rows `R1`, `R2` and
columns `C1`, `C2`. The only cell with no source value is **`(C2, R2)`**.

**Command:** run
`transformDataFrame([{ id:'groupingToMatrix', options:{ columnField:'Column', rowField:'Row', valueField:'Temp', /* emptyValue varied */ } }], [frame])`
and inspect each output field's `type` and `values`.

**Observed output — emit boundary, by `emptyValue`:** [OBSERVED]

```
=== A1 DEFAULT (options={} apart from field names) rows=R1,R2,R1 -> (C2,R2) missing ===
@@@ field Row\Column type=string => ["R1","R2"]  typeof=[string,string]
@@@ field C1 type=number => [1,4]  typeof=[number,number]
@@@ field C2 type=number => [5,""]  typeof=[number,string]
=== A2 emptyValue=Null rows=R1,R2,R1 -> (C2,R2) missing ===
@@@ field C2 type=number => [5,null]  typeof=[number,object]
=== A3 emptyValue=False rows=R1,R2,R1 -> (C2,R2) missing ===
@@@ field C2 type=number => [5,false]  typeof=[number,boolean]
=== A4 emptyValue=True rows=R1,R2,R1 -> (C2,R2) missing ===
@@@ field C2 type=number => [5,true]  typeof=[number,boolean]
=== A5 emptyValue=Empty (explicit) rows=R1,R2,R1 -> (C2,R2) missing ===
@@@ field C2 type=number => [5,""]  typeof=[number,string]
```

Reading the output:

- **`C2 = [5, ""]`** with `type=number` and `typeof=[number,string]`. The first cell `(C2, R1) = 5` is the
  real value; the missing `(C2, R2)` is the empty **string** `''`, sitting inside a field that declares
  itself `number`. This is the exact shape the project's own spec asserts: `type: FieldType.number`,
  `values: [5, '']` at
  `packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts:97-100`. [OBSERVED]
- Switching `emptyValue` changes only the missing cell: `Null → null` (`typeof object`), `False → false`,
  `True → true`, explicit `Empty → ''`. **There is no setting that produces the number `0`.** [OBSERVED]

`(JSON note: typeof null is "object"; that is standard JavaScript, not a Grafana quirk.)`

---

## 2. Following that value downstream

Each subsection feeds the transformed value into a real downstream function, shows the command, pastes the
unedited output, cites the `file:line` cause, and labels the finding. The comparison values `0`, `5`, and
`null` are included alongside `''` so the coercion is unambiguous.

A **critical distinction** runs through this section: some of the functions below are **raw probes** — they
show what a function does _if handed_ `''` directly — while the **table body** actually routes every cell
value through the display processor first (§2.4). Where those two differ, it is called out explicitly.

### 2.1 Totals (SUM) — raw reducer, then the actual table footer

**Command (raw reducer):** `reduceField({ field: { type: number, values }, reducers: [ReducerID.sum] })[ReducerID.sum]`
for several value orderings.

**Observed output — raw reducer:** [OBSERVED]

```
=== B SUM totals (raw reduceField; position sensitivity / string concat) ===
@@@ C2 trailing-empty values => [5,""]  typeof=[number,string]
@@@ C2 leading-empty values => ["",5]  typeof=[string,number]
@@@ SUM(trailing [5,empty]) = "5" typeof=string
@@@ SUM(leading [empty,5]) = "05" typeof=string
@@@ SUM([empty,2]) = "02" typeof=string
@@@ SUM([2,empty]) = "2" typeof=string
@@@ SUM([empty,empty]) = "0" typeof=string
@@@ SUM([empty,1,2,3]) = "0123" typeof=string
```

**Every raw sum is a string** (`typeof=string`), and its exact text **depends on the position of the empty
cells.** Cause chain:

- `doStandardCalcs` (`packages/grafana-data/src/transformations/fieldReducer.ts:468`) treats the field as
  numeric because `isNumberField = field.type === FieldType.number || field.type === FieldType.time`
  (`fieldReducer.ts:478`) — and the field _declares_ `number`.
- The accumulator starts as the numeric `0` (`defaultCalcs.sum: 0` — `fieldReducer.ts:446`).
- The null-guard `if (currentValue == null)` (`fieldReducer.ts:489`) only catches `null`/`undefined`. An
  empty string is **not** `== null`, so `''` slips past it.
- The value then passes the guard `if (currentValue != null && !Number.isNaN(currentValue))` at
  **`fieldReducer.ts:500`** (its comment `// null || undefined || NaN` is on `:501`) — because `'' != null`
  is `true` and `Number.isNaN('')` is `false` — and reaches `calcs.sum += currentValue`
  (`fieldReducer.ts:508`). For a string operand, `+=` performs **string concatenation**, not addition.

So the first `0 + ''` yields the string `"0"`, which is why a **leading** empty prepends a `'0'`
(`['',5] → "05"`, `['',2] → "02"`, `['',1,2,3] → "0123"`), whereas a **trailing** empty appends nothing
visible after the number stringifies (`[5,''] → "5"`, `[2,''] → "2"`). Two empties give `"0"`
(`0 + '' + '' → "0"`). [OBSERVED]

**But the table footer does _not_ show that raw string.** The footer runs each column through
`getFooterItems` → `getFormattedValue` (`packages/grafana-ui/src/components/Table/utils.ts:336,395`). There,
`fieldCalcValue = reduceField({ field, reducers: reducer })[calc]` (`utils.ts:404`) produces the raw string
(`"05"`), and because the SUM reducer has `preservesUnits: true` (`fieldReducer.ts:313`; the reducer is
defined at `:307-314`), the code re-runs it through the display processor:
`if (reducerInfo.preservesUnits) { return formattedValueToString(format(fieldCalcValue)); }`
(`utils.ts:408-410`, with `format = field.display ?? getDisplayProcessor(...)` at `:403`). The display
processor parses `"05"` back to the number `5`.

**Observed output — actual footer via `getFooterItems`:** [OBSERVED]

```
=== C ACTUAL FOOTER getFooterItems(reducer=sum) vs raw reduceField ===
@@@ values=[5,""]  raw reduceField="5" (string)  ACTUAL footer="5" (string)
@@@ values=["",5]  raw reduceField="05" (string)  ACTUAL footer="5" (string)
@@@ values=["",1,2,3]  raw reduceField="0123" (string)  ACTUAL footer="123" (string)
```

So the footer **normalizes** the concatenated string: `"05" → "5"`, `"0123" → "123"`. The position-dependent
`'0'` prefix that appears in a bare `reduceField` call is stripped again by the footer's re-parse. [OBSERVED]
The still-observable effect on the footer is subtler: a leading empty produces `"05"`, which parses cleanly
to `5`; but with mixed/non-numeric leftovers the re-parse can yield `NaN` and render blank. The key
correction to the naive mental model is that **the raw concatenated string does not surface directly in the
footer** — it is re-parsed first.

> **Note (not a contradiction):** the sum reducer's `emptyInputResult: 0` (`fieldReducer.ts:310`) and the
> comment at `fieldReducer.ts:143` ("typically null, but … 'count' & 'sum' should be zero") govern only the
> **empty-input** case (a field with _no rows at all_). They do **not** coerce a per-row `''` to `0`.
> [INFERRED — read from source; the empty-input case was not separately exercised]

### 2.2 Thresholds — raw function probe (`''` coerces to `0` in `>=`)

**Command:** `getActiveThreshold(value, [{ value: -Infinity, color: 'green' }, { value: 3, color: 'red' }])`
for `value ∈ {5, 0, '', null}`.

**Observed output:** [OBSERVED]

```
=== D THRESHOLDS getActiveThreshold(value, steps=[{-Infinity,green},{3,red}]) ===
@@@ threshold(5) = {"value":3,"color":"red"}
@@@ threshold(0) = {"value":null,"color":"green"}
@@@ threshold(empty) = {"value":null,"color":"green"}
@@@ threshold(null) = {"value":null,"color":"green"}
```

`getActiveThreshold('')` is **identical to `getActiveThreshold(0)`** — both select the `green` band and are
distinct from `getActiveThreshold(5)` (which selects `red`). Cause: `getActiveThreshold`
(`packages/grafana-data/src/field/thresholds.ts:7`) compares `if (value >= threshold.value)`
(`thresholds.ts:15`); the relational operator coerces `'' → 0`, and `0 >= -Infinity` is `true` while
`0 >= 3` is `false`, leaving the `-Infinity`/green step active. [OBSERVED]

> **This is a raw-function fact, not the table's rendered behavior.** The table body never hands `''` to
> `getActiveThreshold` — it hands it to the display processor first, where `''` becomes `NaN` and takes a
> _different_ path (§2.4). This raw probe is included because it explains why isolated threshold code
> "treats empty as zero," which is a common source of the confusion.
>
> **JSON nuance:** the `{"value":null,…}` you see is the `{ value: -Infinity, color: 'green' }` step, not a
> literal `null` threshold — `JSON.stringify(-Infinity) === null` (confirmed in
> [§6.2](#62-json-serialization-nuances)). [OBSERVED]

### 2.3 Color scale — raw function probe (`''` coerces to `0` via subtraction, percent 0)

**Command:** `getScaleCalculator(field{ type:number, config:{ min:0, max:10 } }, createTheme())(value)` for
`value ∈ {5, 0, ''}`.

**Observed output:** [OBSERVED]

```
=== E COLOR SCALE getScaleCalculator(field{min:0,max:10}) ===
@@@ scale(5) = {"percent":0.5,"threshold":{"value":0,"color":"#808080"},"color":"#808080"}
@@@ scale(0) = {"percent":0,"threshold":{"value":0,"color":"#808080"},"color":"#808080"}
@@@ scale(empty) = {"percent":0,"threshold":{"value":0,"color":"#808080"},"color":"#808080"}
```

`scale('').percent === 0`, **identical to `scale(0)`** and distinct from `scale(5).percent === 0.5`. Cause:
`getScaleCalculator` (`packages/grafana-data/src/field/scale.ts:19`) computes
`percent = (value - info.min!) / info.delta` (`scale.ts:32`); the `-` operator coerces `'' → 0`, giving
`(0 - 0) / 10 = 0`. (The guard `if (value !== -Infinity)` at `scale.ts:31` is satisfied because
`'' !== -Infinity`, so the subtraction runs.) The field's min/max come from `getMinMaxAndDelta`
(`scale.ts:74`), which calls `reduceField({ field, reducers: [ReducerID.min, ReducerID.max] })`
(`scale.ts:85`) when they are not set explicitly. [OBSERVED]

> The `color` is `#808080` (a neutral gray) only because this harness field configured **no** thresholds or
> color mode, so the color calculator falls back to the fixed fallback color; the **percent** (0 vs 0.5) is
> the coercion evidence that matters here. §2.4 shows what happens once thresholds are present. As in §2.2,
> this is a **raw-function probe**: the table body reaches color through the display processor, not by
> handing `''` to `getScaleCalculator` directly. The percent values here are **[OBSERVED]**; the
> raw-vs-render distinction is **[INFERRED]** from the display-processor source examined in §2.4.

### 2.4 Per-cell display and the actual rendered color

This is the path the **table body cell actually uses.** `DefaultCell` computes
`const displayValue = field.display!(cell.value)` (`packages/grafana-ui/src/components/Table/DefaultCell.tsx:23`),
renders the text via `formattedValueToString(displayValue)` (`:50`), and derives the cell colors from
`getCellColors(tableStyles, cellOptions, displayValue)` (`:145`). So the cell's text **and** its color both
come from the `DisplayValue` that `getDisplayProcessor` produces.

**Command:** `getDisplayProcessor({ field:{ type:number, config:{ min:0, max:10 } }, theme:createTheme() })(value)`
for `value ∈ {5, 0, '', null}`, reading the **full** `DisplayValue` (`text`, `numeric`, `color`, `percent`).

**Observed output — no thresholds/color mode configured:** [OBSERVED]

```
=== F PER-CELL DISPLAY getDisplayProcessor(field type=number, min0/max10, no thresholds) FULL DisplayValue ===
@@@ display(5) = {text:"5", numeric=5, color:"#808080", percent:0.5}  isNaN(numeric)=false
@@@ display(0) = {text:"0", numeric=0, color:"#808080", percent:0}  isNaN(numeric)=false
@@@ display(empty) = {text:"", numeric=NaN, color:"#808080", percent:0}  isNaN(numeric)=true
@@@ display(null) = {text:"", numeric=NaN, color:"#808080", percent:0}  isNaN(numeric)=true
```

Two facts, both important, and both **correcting the naive "blank and uncolored" reading**:

1. **The text is blank** for `''` (and `null`): `display('').text === ""`, whereas `display(0).text === "0"`.
   So per-cell **text** does _not_ treat `''` like `0`.
2. **The cell is still colored.** `display('')` returns `color: "#808080"` and `percent: 0` — it is **not**
   color-less. That color is assigned by the fallback branch, not by the numeric-scaling branch.

Cause chain (`packages/grafana-data/src/field/displayProcessor.ts`):

- `let numeric = isStringUnit ? NaN : anyToNumber(value);` (`:96`), and `anyToNumber('')` returns `NaN` — the
  helper deliberately overrides lodash for `''`/`null`/`undefined`/arrays
  (`packages/grafana-data/src/utils/anyToNumber.ts:13-14`, comment "lodash calls them 0").
- Because `numeric` is `NaN`, the block `if (!Number.isNaN(numeric)) { … }` (`:144`) — which formats the text
  and calls `scaleFunc(numeric)` for scale-based color (`:166-170`) — is **skipped**. This is why the text is
  blank and why `''` is _not_ colored by its own value.
- But then the text falls through to `text = toString(value)` → `''` (`:177-186`), and the **fallback color
  block** runs: `if (!color) { const scaleResult = scaleFunc(-Infinity); color = scaleResult.color; percent = scaleResult.percent; }`
  (`displayProcessor.ts:188-192`). So the missing cell's color is `scaleFunc(-Infinity)` — the **base/lowest**
  band — **not** the color of `0`.

To make the difference concrete, here is the same processor with an explicit threshold ladder
`[-Infinity → green, -1 → blue, 3 → red]` (default color mode is thresholds —
`packages/grafana-data/src/field/fieldColor.ts:234`):

**Observed output — with thresholds `[-Infinity=green, -1=blue, 3=red]`:** [OBSERVED]

```
=== G PER-CELL DISPLAY WITH thresholds [-Inf=green,-1=blue,3=red] ===
@@@ theme colors: green=#73BF69 blue=#5794F2 red=#F2495C
@@@ display(5) = {text:"5", numeric=5, color:"#F2495C", percent:0.5}
@@@ display(0) = {text:"0", numeric=0, color:"#5794F2", percent:0}
@@@ display(empty) = {text:"", numeric=NaN, color:"#73BF69", percent:0}
@@@ display(null) = {text:"", numeric=NaN, color:"#73BF69", percent:0}
```

- A real `0` lands in the `-1 → blue` band and renders **blue** (`#5794F2`): its `numeric` is `0`, so the
  numeric branch runs `scaleFunc(0)`, whose active threshold for `0` is the `-1/blue` step.
- The missing `''` renders with **blank text** and the **`-Infinity → green` base color** (`#73BF69`): its
  `numeric` is `NaN`, so the numeric branch is skipped and the fallback `scaleFunc(-Infinity)` selects the
  lowest (`green`) band. [OBSERVED]

**So the actual table body does _not_ send the missing cell through the "empty → 0 → threshold band" route
of §2.2.** It sends it through `scaleFunc(-Infinity)`, which lands it in the **base** band. With this ladder,
`0` and `''` end up **different colors** (`0` = blue, `''` = green), and the `''` cell shows **no text**.
[OBSERVED for the `DisplayValue`; the mapping of `DisplayValue.color` onto the painted cell background —
`getCellColors` `ColorBackground` branch at `packages/grafana-ui/src/components/Table/utils.ts:620-635`,
which sets `bgColor` from `displayValue.color` — is INFERRED from source, since a live DOM table was not
mounted.]

---

## 3. Reconciliation — where the code diverges from "missing means zero"

The single emitted value `''` is **coerced path-dependently**, and separating the **raw-function** behavior
from the **actual table render** is the whole story:

| Path                            | What happens to the missing `''`                                                               |       Behaves like `0`?        | Cause (`file:line`)                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------- | :----------------------------: | ------------------------------------------------------------------------------------------------- |
| Totals (SUM), **raw reducer**   | String concatenation; result is a **string** whose text depends on position (`"05"`, `"5"`, …) |      No — it is a string       | `fieldReducer.ts:489` (guard misses `''`), `:500` (guard passes `''`), `:508` (`+=` concatenates) |
| Totals (SUM), **table footer**  | Raw string is **re-parsed** by the display processor (`"05" → "5"`, `"0123" → "123"`)          |     Numeric (via re-parse)     | `utils.ts:404,408-410`; SUM `preservesUnits` `fieldReducer.ts:313`                                |
| Thresholds (**raw function**)   | `'' >= step` coerces `'' → 0`; banded exactly like `0`                                         |       Yes (in isolation)       | `thresholds.ts:15`                                                                                |
| Color scale (**raw function**)  | `(value - min)` coerces `'' → 0`; `percent = 0`, same as `0`                                   |       Yes (in isolation)       | `scale.ts:32`                                                                                     |
| Per-cell **text** (table body)  | `anyToNumber('') = NaN` → text is blank (unlike `0`, which shows `"0"`)                        |           No — blank           | `displayProcessor.ts:96,144`; `anyToNumber.ts:13-14`                                              |
| Per-cell **color** (table body) | `NaN` skips numeric scaling; color comes from `scaleFunc(-Infinity)` → **base** band           | No — base band, not `0`'s band | `displayProcessor.ts:188-192`; `scale.ts:31`                                                      |

So the **same** missing cell simultaneously reads as a _string_ in a raw total (re-parsed to a number in the
footer), and as _blank text with a base-band color_ in the cell body — while the isolated threshold/scale
_functions_ would treat it as `0` if they were handed it directly (which the table body does not do). Several
different meanings for one value — that is exactly why the dashboard "feels like it is making a different
choice somewhere along the way." [OBSERVED]

The user's mental model, **"missing means zero,"** is not wrong about intent — it is simply **not
expressible** in this transform. The chooseable values are `Null`, `True`, `False`, `Empty`
(`transformations.ts:113-117`); there is **no `Zero`**. The default `Empty` (`''`) then _resembles_ zero only
inside the isolated comparison functions (§2.2–2.3), while the paths a user actually sees — the raw total, the
footer, and the cell body — each do something else. The mismatch is seeded at the transform boundary, where a
`number`-typed field (`groupingToMatrix.ts:133`) is filled with a string (`groupingToMatrix.ts:117`, `:26`,
`:186-188`). [OBSERVED]

---

## 4. "Missing means zero," done correctly

Because there is no `Zero` option, the way to get true numeric zero semantics **for the reducers** (totals,
means) with the **existing** options is two coordinated settings:

1. On the transform, set **`emptyValue = SpecialValue.Null`** so missing cells become a real `null` (observed
   `C2 = [5, null]`), instead of the string `''`.
2. On the value field, set the null-value mode to **null-as-zero** (`NullValueMode.AsZero`).

**Command:** reduce the `emptyValue=Null` field `C2 = [5, null]` with `field.config.nullValueMode` set to
`Ignore` vs `AsZero`, contrast with the default `''` field under `AsZero`, and also run the field's display
processor under `AsZero`.

**Observed output:** [OBSERVED]

```
=== H RECIPE emptyValue=Null + nullValueMode ===
@@@ C2 (emptyValue=Null) values => [5,null]  typeof=[number,object]
@@@ Null+Ignore  sum=5 (number) mean=5
@@@ Null+AsZero  sum=5 (number) mean=2.5
@@@ Empty+AsZero [5,empty] sum="5" (string) mean=2.5
@@@ Empty+AsZero [empty,5] sum="05" (string) mean=2.5
@@@ Null+AsZero display(null) = {text:"", numeric=NaN, color:"#808080", percent:0}  isNaN=true
```

- With **`Null`**, the sum is a clean **numeric `5`** (not a string), regardless of null-value mode. [OBSERVED]
- Adding **`AsZero`** makes the `null` **count as `0`**: the mean drops from `5` (one value counted) to `2.5`
  (two values, one of them `0`). This is `fieldReducer.ts:493-494` setting `currentValue = 0` inside the
  `if (currentValue == null)` guard (`:489`), gated by `nullAsZero = nullValueMode === NullValueMode.AsZero`
  (`:201`). [OBSERVED]
- **`Empty + AsZero` still yields a _string_** (`"5"` for `[5,'']`, `"05"` for `['',5]`) — because `''` is not
  `== null`, the `nullAsZero` branch never fires for it. So the default `Empty` cannot be rescued by
  null-as-zero; **only `Null` yields clean numeric reducer behavior.** [OBSERVED]

**Two caveats that keep this recipe honest:**

- **Scope: reducers only.** `NullValueMode.AsZero` is consumed by `doStandardCalcs` (totals, means, etc.). The
  per-cell **display** does **not** consult it: `Null + AsZero` still yields
  `display(null) = {text:"", numeric:NaN, color:"#808080", percent:0}` — a **blank** cell with the base
  fallback color, identical to the `''` case in §2.4. So this recipe fixes the **footer/aggregate** numbers,
  not the empty look of the missing **cells**. [OBSERVED] If a visible `0` is required in the cell body, a
  value mapping (mapping `null`/empty → the text `0`) would be needed; that is a display-layer configuration
  and is out of scope for this behavior investigation. [INFERRED — from the display-processor source, which
  applies mappings at `displayProcessor.ts:104-119` before the numeric branch]
- **There is no Table panel UI control for `nullValueMode`.** In this revision, the field-config option named
  **"No value"** is only a **placeholder-text** editor — `id: 'noValue'`, a text input with placeholder `'-'`
  and description "What to show when there is no value"
  (`public/app/core/components/OptionsUI/registry.tsx:333-349`) — it sets `FieldConfig.noValue`, not
  `nullValueMode`. The Table panel registers no `nullValueMode` editor either (its custom field-config editors
  are `minWidth`, `width`, `align`, `cellOptions`, `inspect`, `filterable`, `hidden` —
  `public/app/plugins/panel/table/module.tsx:25-101`); a repository-wide search finds **no** `nullValueMode`
  editor in the standard options registry. So `nullValueMode = AsZero` is settable **programmatically**
  (`field.config.nullValueMode`, e.g. via a field override in provisioning/JSON) but is **not exposed as a
  click-path** in the Table editor of this build. [OBSERVED — from the registered editors] In particular,
  there is no "Standard options → No value / null handling" control that sets `nullValueMode` in this build,
  so that configuration route is not claimed here.

---

## 5. Edge and robustness notes

- **Duplicate `(row, column)` pairs resolve last-value-wins.** [OBSERVED] Feeding `Column=['C1','C1']`,
  `Row=['R1','R1']`, `Temp=[10,20]` (the same cell twice) produces:

  ```
  === J EDGE duplicate (row,column) last-value-wins (input [10,20] for (R1,C1)) ===
  @@@ dup field Row\Column => ["R1"]  typeof=[string]
  @@@ dup field C1 => [20]  typeof=[number]
  ```

  The second value `20` overwrote the first `10`, because the fill loop does a plain assignment
  `matrixValues[columnName][rowName] = value` (`groupingToMatrix.ts:102`) with no aggregation — this source
  line is the authority for the last-value-wins behavior. [OBSERVED]

- **The `dataplaneFrontendFallback` feature toggle does not change the emitted value.** [OBSERVED] Read at
  module load (`groupingToMatrix.ts:31`), it defaults to `undefined` (OFF). With the toggle OFF and ON, the
  missing cell is `''` in both cases (the ON case was exercised in a separate process that forced the toggle
  before the module loaded):

  ```
  === K DATAPLANE TOGGLE default (this process) ===
  @@@ default window.grafanaBootData...dataplaneFrontendFallback = undefined  (=> OFF)
  @@@ toggle OFF C2 = [5,""]  typeof=[number,string] type=number
  === TOGGLE ON (separate process, forced before module load) ===
  @@@ window.grafanaBootData...dataplaneFrontendFallback = true  (=> ON)
  @@@ toggle ON  C2 = [5,""]  typeof=[number,string] type=number
  ```

  The toggle only affects field **matching** (`groupingToMatrix.ts:163-168`) and numeric-**column naming**
  (`groupingToMatrix.ts:125-127`), **not** the emit at `:117`. [OBSERVED] In production this boot data is
  injected by the Go backend into the served HTML, so its default state is environment-dependent; either way
  it does not change the answer. [INFERRED — from how the toggle is read; the Go injection was not exercised]

- **Mixed value types coerce the pivoted output toward string.** [INFERRED — from source] The output field's
  `type` is copied verbatim from the value field (`groupingToMatrix.ts:133`); if the value field is `number`
  but a missing cell is `''`, the field is already type-inconsistent, and any consumer that concatenates (as
  the raw sum path does) will produce strings. This compounds the perceived inconsistency.

- **The Gauge cell renderer degrades gracefully on the missing value.** [OBSERVED] `BarGaugeCell` is the
  **Gauge** cell type (`packages/grafana-ui/src/components/Table/BarGaugeCell.tsx`); like `DefaultCell` it
  computes `field.display!(cell.value)` (`:28`), so it receives the same `DisplayValue` (`numeric = NaN`,
  base fallback color). Its bar length comes from `getValuePercent(displayValue.numeric, min, max)`
  (used at `BarGauge.tsx:494`), which is defined to return `0` for a `NaN` ratio
  (`BarGauge.tsx:479-483`, `return isNaN(valueRatio) ? 0 : valueRatio;`):

  ```
  === I GAUGE CELL getValuePercent (BarGaugeCell consumes DisplayValue.numeric) ===
  @@@ getValuePercent(NaN,0,10) = 0
  @@@ getValuePercent(5,0,10)   = 0.5
  @@@ getValuePercent(0,0,10)   = 0
  ```

  So in a Gauge cell the missing value draws a **zero-length bar** with the base fallback color — not because
  `''` was treated as `0`, but because `NaN` is clamped to `0` by `getValuePercent`. [OBSERVED]

- **This is documented, not fixed, behavior.** No source code is changed by this investigation; implementing a
  `Zero` option is explicitly out of scope. See [§6.6](#66-external-corroboration) for public corroboration.

---

## 6. Appendix

### 6.1 Observed vs inferred — summary

**[OBSERVED]** (captured from the harness run or the canonical spec): the default emit `''`; the
`Null`/`False`/`True`/`Empty` variants; the raw-sum string concatenation and its position sensitivity; the
**actual footer re-parse** (`"05" → "5"`, `"0123" → "123"`) via `getFooterItems`;
`getActiveThreshold('') == getActiveThreshold(0)`; `scale('').percent == 0 == scale(0)`; the **full**
`DisplayValue` for `5`/`0`/`''`/`null` with and without a threshold ladder (blank text for `''`/`null`; base
`scaleFunc(-Infinity)` color; `0` → blue vs `''` → green under the ladder); the `Null` + `AsZero` recipe
(mean `5 → 2.5`), that `Empty + AsZero` stays a string, and that `Null + AsZero` still renders the **cell**
blank; `getValuePercent(NaN, …) = 0`; duplicate-pair last-value-wins; the dataplane toggle OFF/ON both
emitting `''`; and the two JSON nuances.

**[INFERRED]** (reasoned from source, not directly rendered): that `getCellColors`/`DefaultCell` paint the
cell background from `DisplayValue.color` (a DOM table was not mounted); that a value **mapping** would be
needed to show a literal `0` in the cell body; that in production the Go backend injects the boot-data toggle
(its _effect on the emit_ was observed to be none); that mixed value types coerce output toward string; and
that the sum reducer's `emptyInputResult: 0` governs only the empty-input case.

### 6.2 JSON serialization nuances

Both were confirmed at runtime, and explain why some raw values above print as `null`: [OBSERVED]

```
=== L JSON NUANCES (why some raw values print as null) ===
@@@ JSON.stringify(-Infinity) = null
@@@ JSON.stringify(NaN) = null
```

- In §2.2, a threshold shown as `{"value":null,…}` is the `{ value: -Infinity, color: 'green' }` step —
  `JSON.stringify(-Infinity)` is `null`. It is **not** a literal `null` threshold value.
- In §2.4, a `numeric` shown as `null` is really `NaN` — `JSON.stringify(NaN)` is `null`. The explicit
  `isNaN(numeric)=true` annotations in the captured output confirm the real value is `NaN`.

### 6.3 The safe, reproducible observation harness

The harness is created inside a **unique, private temporary directory outside the checkout** so the source
repository is never touched and no predictable, world-writable path is used for executable config. Recreate
it exactly as follows.

**1) Create a private working directory (unique name, owner-only permissions), outside the repo:**

```bash
REPO="$(pwd)"                                            # run from the repository root
HARNESS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gtm_harness.XXXXXXXX")"
chmod 700 "$HARNESS_DIR"                                 # owner-only; not shared/predictable
```

**2) `"$HARNESS_DIR/harness.jest.config.js"` — reuse the repo's canonical Jest config, redirect discovery to
the private dir:**

```js
// Reuse the repo's canonical Jest config verbatim (transforms, moduleNameMapper, resolver, setup),
// then point test discovery at this private, owner-only dir OUTSIDE the repo.
const base = require(process.env.REPO + '/jest.config.js');
module.exports = {
  ...base,
  rootDir: process.env.REPO,
  roots: [process.env.HARNESS_DIR],
  testMatch: [process.env.HARNESS_DIR + '/**/*.test.ts'],
  testRegex: undefined,
  modulePaths: [process.env.REPO + '/node_modules'], // so 'tslib' etc. resolve from outside the repo
};
```

**3) `"$HARNESS_DIR/observe.test.ts"` — the main suite.** It registers the real transformer and drives the
real pipeline; output is appended to a file (the repo's Jest setup fails any test that logs to the console
via `jest-fail-on-console`). Key steps:

- Build the sparse frame `Column=['C1','C1','C2']`, `Row=['R1','R2','R1']`, `Temp=[1,4,5]` (so `(C2,R2)` is
  missing) and run
  `await lastValueFrom(transformDataFrame([{ id:'groupingToMatrix', options:{columnField:'Column',rowField:'Row',valueField:'Temp'} }], [frame]))`;
  vary `options.emptyValue` over the default, `Null`, `False`, `True`, `Empty` (capture **A**).
- Reduce crafted orderings `[5,'']`, `['',5]`, `['',2]`, `[2,'']`, `['','']`, `['',1,2,3]` with
  `reduceField(..., [ReducerID.sum])` (capture **B**), and run the **real footer** path
  `getFooterItems([{id:'0',field}], [values], {show:true, reducer:[ReducerID.sum]}, theme)` for `[5,'']`,
  `['',5]`, `['',1,2,3]` (capture **C**).
- Call `getActiveThreshold(value, [{value:-Infinity,color:'green'},{value:3,color:'red'}])` for
  `value ∈ {5,0,'',null}` (capture **D**).
- Call `getScaleCalculator(field{min:0,max:10}, createTheme())(value)` for `value ∈ {5,0,''}` (capture **E**).
- Call `getDisplayProcessor({field{min:0,max:10}, theme})(value)` for `value ∈ {5,0,'',null}` and read the
  **full** `DisplayValue` — once with no thresholds (capture **F**) and once with
  `thresholds:{mode:'absolute',steps:[{value:-Infinity,color:'green'},{value:-1,color:'blue'},{value:3,color:'red'}]}`
  (capture **G**).
- Recipe (capture **H**): reduce `[5,null]` and `[5,'']`/`['',5]` with `config.nullValueMode` set to
  `Ignore` vs `AsZero`, and run `getDisplayProcessor(field{nullValueMode:AsZero})(null)`.
- `getValuePercent(NaN,0,10)`, `(5,0,10)`, `(0,0,10)` (capture **I**); duplicate `(R1,C1)=[10,20]` (capture
  **J**); toggle default value (capture **K**); `JSON.stringify(-Infinity)` / `JSON.stringify(NaN)` (capture
  **L**).
- Every case has a strict, type-sensitive assertion (e.g. `expect(sum).toBe('05')`,
  `expect(typeof def.values[1]).toBe('string')`, `expect(disp('').color).toBe(gc('green'))`). A deliberately
  false assertion was confirmed to fail the run with a non-zero exit (`Expected: 5 / Received: "05"`), so the
  assertions genuinely gate the output.

Imports resolve exactly as the project's own tests do: index symbols from `@grafana/data`
(`transformDataFrame`, `reduceField`, `ReducerID`, `getActiveThreshold`, `getScaleCalculator`,
`getDisplayProcessor`, `createTheme`, `toDataFrame`, `FieldType`, `SpecialValue`, `NullValueMode`), plus deep
imports for the two test-only helpers
(`@grafana/data/src/utils/tests/mockTransformationsRegistry`,
`@grafana/data/src/transformations/transformers/groupingToMatrix`,
`@grafana/data/src/transformations/transformers/ids`), and the render helpers
`@grafana/ui/src/components/Table/utils` (`getFooterItems`) and
`@grafana/ui/src/components/BarGauge/BarGauge` (`getValuePercent`).

**4) `"$HARNESS_DIR/toggle.test.ts"` — an isolated second suite** that sets
`window.grafanaBootData.settings.featureToggles.dataplaneFrontendFallback = true` and then `require`s the
transformer **fresh** (the toggle is read at module-load time, `groupingToMatrix.ts:31`, and
`mockTransformationsRegistry` can be called only once per process — so this must be a separate file using
`require`, not a hoisted `import`).

**5) Run each suite non-interactively (CI mode) and read the captured file:**

```bash
: > "$HARNESS_DIR/out.txt"
CI=true REPO="$REPO" HARNESS_DIR="$HARNESS_DIR" node .yarn/releases/yarn-4.5.3.cjs jest \
  --config "$HARNESS_DIR/harness.jest.config.js" --watchAll=false --ci --runInBand
cat "$HARNESS_DIR/out.txt"
```

**6) Clean up (leaving the repository byte-for-byte unchanged):**

```bash
rm -rf "$HARNESS_DIR"
git status --porcelain            # => only blitzy/documentation/grafana_4550cfb5b728.md
```

### 6.4 Complete captured output

**Canonical project spec** (`groupingToMatrix.test.ts`) — complete, unedited (the six
`jest-haste-map: duplicate manual mock` warnings are pre-existing, unrelated to this transform, and come from
scanning `public/app`; they do not affect results):

```
jest-haste-map: duplicate manual mock found: store.navIndex.mock
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/features/connections/__mocks__/store.navIndex.mock.ts
    * <rootDir>/public/app/features/datasources/__mocks__/store.navIndex.mock.ts

jest-haste-map: duplicate manual mock found: index
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/features/datasources/__mocks__/index.ts
    * <rootDir>/public/app/features/plugins/admin/__mocks__/index.ts

jest-haste-map: duplicate manual mock found: datasource
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/plugins/datasource/azuremonitor/__mocks__/datasource.ts
    * <rootDir>/public/app/plugins/datasource/influxdb/__mocks__/datasource.ts

jest-haste-map: duplicate manual mock found: query
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/plugins/datasource/azuremonitor/__mocks__/query.ts
    * <rootDir>/public/app/plugins/datasource/influxdb/__mocks__/query.ts

jest-haste-map: duplicate manual mock found: datasource
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/plugins/datasource/influxdb/__mocks__/datasource.ts
    * <rootDir>/public/app/plugins/datasource/loki/__mocks__/datasource.ts

jest-haste-map: duplicate manual mock found: datasource
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/plugins/datasource/loki/__mocks__/datasource.ts
    * <rootDir>/packages/grafana-prometheus/src/test/__mocks__/datasource.ts

PASS packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts

Test Suites: 1 passed, 1 total
Tests:       4 passed, 4 total
Snapshots:   1 passed, 1 total
Time:        1.411 s, estimated 2 s
Ran all test suites matching /packages\/grafana-data\/src\/transformations\/transformers\/groupingToMatrix.test.ts/i.
```

**Harness — Suite 1 (`observe.test.ts`), complete captured `out.txt`** (Jest reported
`Test Suites: 1 passed, Tests: 12 passed, Snapshots: 0`; the harness itself emits no duplicate-mock warnings
because its `roots` is only the private dir): [OBSERVED]

```
=== A1 DEFAULT (options={} apart from field names) rows=R1,R2,R1 -> (C2,R2) missing ===
@@@ field Row\Column type=string => ["R1","R2"]  typeof=[string,string]
@@@ field C1 type=number => [1,4]  typeof=[number,number]
@@@ field C2 type=number => [5,""]  typeof=[number,string]
=== A2 emptyValue=Null rows=R1,R2,R1 -> (C2,R2) missing ===
@@@ field C2 type=number => [5,null]  typeof=[number,object]
=== A3 emptyValue=False rows=R1,R2,R1 -> (C2,R2) missing ===
@@@ field C2 type=number => [5,false]  typeof=[number,boolean]
=== A4 emptyValue=True rows=R1,R2,R1 -> (C2,R2) missing ===
@@@ field C2 type=number => [5,true]  typeof=[number,boolean]
=== A5 emptyValue=Empty (explicit) rows=R1,R2,R1 -> (C2,R2) missing ===
@@@ field C2 type=number => [5,""]  typeof=[number,string]
=== B SUM totals (raw reduceField; position sensitivity / string concat) ===
@@@ C2 trailing-empty values => [5,""]  typeof=[number,string]
@@@ C2 leading-empty values => ["",5]  typeof=[string,number]
@@@ SUM(trailing [5,empty]) = "5" typeof=string
@@@ SUM(leading [empty,5]) = "05" typeof=string
@@@ SUM([empty,2]) = "02" typeof=string
@@@ SUM([2,empty]) = "2" typeof=string
@@@ SUM([empty,empty]) = "0" typeof=string
@@@ SUM([empty,1,2,3]) = "0123" typeof=string
=== C ACTUAL FOOTER getFooterItems(reducer=sum) vs raw reduceField ===
@@@ values=[5,""]  raw reduceField="5" (string)  ACTUAL footer="5" (string)
@@@ values=["",5]  raw reduceField="05" (string)  ACTUAL footer="5" (string)
@@@ values=["",1,2,3]  raw reduceField="0123" (string)  ACTUAL footer="123" (string)
=== D THRESHOLDS getActiveThreshold(value, steps=[{-Infinity,green},{3,red}]) ===
@@@ threshold(5) = {"value":3,"color":"red"}
@@@ threshold(0) = {"value":null,"color":"green"}
@@@ threshold(empty) = {"value":null,"color":"green"}
@@@ threshold(null) = {"value":null,"color":"green"}
=== E COLOR SCALE getScaleCalculator(field{min:0,max:10}) ===
@@@ scale(5) = {"percent":0.5,"threshold":{"value":0,"color":"#808080"},"color":"#808080"}
@@@ scale(0) = {"percent":0,"threshold":{"value":0,"color":"#808080"},"color":"#808080"}
@@@ scale(empty) = {"percent":0,"threshold":{"value":0,"color":"#808080"},"color":"#808080"}
=== F PER-CELL DISPLAY getDisplayProcessor(field type=number, min0/max10, no thresholds) FULL DisplayValue ===
@@@ display(5) = {text:"5", numeric=5, color:"#808080", percent:0.5}  isNaN(numeric)=false
@@@ display(0) = {text:"0", numeric=0, color:"#808080", percent:0}  isNaN(numeric)=false
@@@ display(empty) = {text:"", numeric=NaN, color:"#808080", percent:0}  isNaN(numeric)=true
@@@ display(null) = {text:"", numeric=NaN, color:"#808080", percent:0}  isNaN(numeric)=true
=== G PER-CELL DISPLAY WITH thresholds [-Inf=green,-1=blue,3=red] ===
@@@ theme colors: green=#73BF69 blue=#5794F2 red=#F2495C
@@@ display(5) = {text:"5", numeric=5, color:"#F2495C", percent:0.5}
@@@ display(0) = {text:"0", numeric=0, color:"#5794F2", percent:0}
@@@ display(empty) = {text:"", numeric=NaN, color:"#73BF69", percent:0}
@@@ display(null) = {text:"", numeric=NaN, color:"#73BF69", percent:0}
=== H RECIPE emptyValue=Null + nullValueMode ===
@@@ C2 (emptyValue=Null) values => [5,null]  typeof=[number,object]
@@@ Null+Ignore  sum=5 (number) mean=5
@@@ Null+AsZero  sum=5 (number) mean=2.5
@@@ Empty+AsZero [5,empty] sum="5" (string) mean=2.5
@@@ Empty+AsZero [empty,5] sum="05" (string) mean=2.5
@@@ Null+AsZero display(null) = {text:"", numeric=NaN, color:"#808080", percent:0}  isNaN=true
=== I GAUGE CELL getValuePercent (BarGaugeCell consumes DisplayValue.numeric) ===
@@@ getValuePercent(NaN,0,10) = 0
@@@ getValuePercent(5,0,10)   = 0.5
@@@ getValuePercent(0,0,10)   = 0
=== J EDGE duplicate (row,column) last-value-wins (input [10,20] for (R1,C1)) ===
@@@ dup field Row\Column => ["R1"]  typeof=[string]
@@@ dup field C1 => [20]  typeof=[number]
=== K DATAPLANE TOGGLE default (this process) ===
@@@ default window.grafanaBootData...dataplaneFrontendFallback = undefined  (=> OFF)
@@@ toggle OFF C2 = [5,""]  typeof=[number,string] type=number
=== L JSON NUANCES (why some raw values print as null) ===
@@@ JSON.stringify(-Infinity) = null
@@@ JSON.stringify(NaN) = null
```

**Harness — Suite 2 (`toggle.test.ts`), complete captured `out.txt`** (Jest reported
`Test Suites: 1 passed, Tests: 1 passed, Snapshots: 0`): [OBSERVED]

```
=== TOGGLE ON (separate process, forced before module load) ===
@@@ window.grafanaBootData...dataplaneFrontendFallback = true  (=> ON)
@@@ toggle ON  C2 = [5,""]  typeof=[number,string] type=number
```

### 6.5 Verified `file:line` citations

**Emit boundary / options**

- `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts` — `:26`
  `DEFAULT_EMPTY_VALUE = SpecialValue.Empty`; `:31` dataplane toggle read; `:71`
  `options.emptyValue || DEFAULT_EMPTY_VALUE`; `:102` `matrixValues[col][row] = value` (last-wins authority);
  `:117` `?? getSpecialValue(emptyValue)`; `:125-127` dataplane column naming; `:130`
  `name: columnName.toString()`; `:133` `type: valueField.type`; `:163-168` dataplane field matching; `:178`
  `getSpecialValue` (`False→false :180-181`, `True→true :182-183`, `Null→null :184-185`,
  `Empty/default→'' :186-188`).
- `packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts` — `:1` `toDataFrame`,
  `:5` `transformDataFrame`, `:12` `mockTransformationsRegistry([groupingToMatrixTransformer])`, `:97-100`
  `type: number` / `values: [5, '']`, `:112` `SpecialValue.Null`.
- `packages/grafana-data/src/types/transformations.ts` — `:113-117` `SpecialValue` enum
  (`True`/`False`/`Null`/`Empty`; **no `Zero`**).
- `packages/grafana-data/src/index.ts` — `:431` exports `GroupingToMatrixTransformerOptions`.
- `packages/grafana-data/src/transformations/transformDataFrame.ts` — canonical entry point.
- `packages/grafana-data/src/transformations/transformers.ts` — `:13` import, `:56` registry entry.
- `packages/grafana-data/src/transformations/transformers/ids.ts` — `:36`
  `groupingToMatrix = 'groupingToMatrix'`.
- `public/app/features/transformers/editors/GroupingToMatrixTransformerEditor.tsx` — `:61-66`
  `specialValueOptions` (`Null :62`, `True :63`, `False :64`, `Empty :65`), `:100`
  `<InlineField label="Empty Value">`.
- `public/app/features/transformers/docs/content.ts` — `:617` `groupingToMatrix` block; `:631` lists
  "Null, True, False, or Empty".
- `public/app/features/dashboard/components/TransformationsEditor/TransformationPickerNg.tsx` — `:297`
  transformation description.
- `public/app/features/transformers/standardTransformers.ts` — `:16` import, `:63` registry item.

**Downstream pipeline**

- `packages/grafana-data/src/transformations/fieldReducer.ts` — `:143` `emptyInputResult` comment (governs
  only the empty-**input** case); `:201` `nullAsZero = nullValueMode === NullValueMode.AsZero`; `:307-314` sum
  reducer definition (`emptyInputResult: 0` at `:310`, `preservesUnits: true` at `:313`); `:446`
  `defaultCalcs.sum: 0`; `:468` `doStandardCalcs`; `:478` `isNumberField = field.type === number || time`;
  `:489` `if (currentValue == null)`; `:493-494` `if (nullAsZero) currentValue = 0`; `:500` the guard
  `if (currentValue != null && !Number.isNaN(currentValue))` (its comment is on `:501`); `:508`
  `calcs.sum += currentValue`.
- `packages/grafana-data/src/field/thresholds.ts` — `:5` `fallBackThreshold = { value: 0, color: FALLBACK_COLOR }`;
  `:7` `getActiveThreshold`; `:15` `if (value >= threshold.value)`.
- `packages/grafana-data/src/field/scale.ts` — `:19` `getScaleCalculator`; `:31` `if (value !== -Infinity)`;
  `:32` `percent = (value - info.min!) / info.delta`; `:39` `getActiveThresholdForValue`; `:44`
  `getColor(value, percent, threshold)`; `:74` `getMinMaxAndDelta`; `:85`
  `reduceField({ field, reducers: [ReducerID.min, ReducerID.max] })`.
- `packages/grafana-data/src/field/fieldColor.ts` — `:44-53` thresholds color mode (color from the active
  threshold, else `fallBackThreshold`); `:234` default color mode is `FieldColorModeId.Thresholds`.
- `packages/grafana-data/src/field/displayProcessor.ts` — `:96`
  `numeric = isStringUnit ? NaN : anyToNumber(value)`; `:104-119` value-mapping branch; `:144`
  `if (!Number.isNaN(numeric))` (numeric text + scale color; skipped when `NaN`); `:166-170` `scaleFunc(numeric)`;
  `:177-186` text fallback (`toString(value)` / `config.noValue` / `''`); `:188-192` `if (!color)` →
  `scaleFunc(-Infinity)` base-color fallback.
- `packages/grafana-data/src/utils/anyToNumber.ts` — `:13-14` returns `NaN` for `''`/`null`/`undefined`/array
  (deliberately overriding lodash; comment "lodash calls them 0").
- `packages/grafana-data/src/types/fieldColor.ts` — `:40` `FALLBACK_COLOR = '#808080'`.

**Render surface (where it becomes visible)**

- `public/app/plugins/panel/table/TablePanel.tsx` — renders the matrix, footer totals, and cell coloring.
- `public/app/plugins/panel/table/module.tsx` — `:25-101` the `useFieldConfig`/`useCustomConfig` block; its
  field-config editors are `minWidth` (`:28`), `width` (`:40`), `align` (`:51`), `cellOptions` (`:64-65`),
  and three boolean switches (`:75,:90,:96`); there is no `nullValueMode` editor anywhere in the file.
- `public/app/core/components/OptionsUI/registry.tsx` — `:333-349` the standard "No value" editor
  (`id: 'noValue'`, a text/placeholder editor for `FieldConfig.noValue`); there is no `nullValueMode` editor.
- `packages/grafana-ui/src/components/Table/utils.ts` — `:336` `getFooterItems`; `:395` `getFormattedValue`;
  `:403` `format = field.display ?? getDisplayProcessor(...)`; `:404` `reduceField(...)[calc]`; `:408-410`
  `preservesUnits` re-parse; `:605` `getCellColors`; `:620-635` `ColorBackground` sets `bgColor` from
  `displayValue.color`.
- `packages/grafana-ui/src/components/Table/FooterCell.tsx` — the footer/totals render surface.
- `packages/grafana-ui/src/components/Table/DefaultCell.tsx` — `:23`
  `const displayValue = field.display!(cell.value)`; `:50` `formattedValueToString(displayValue)` (blank text
  for `''`); `:145` `getCellColors(tableStyles, cellOptions, displayValue)`.
- `packages/grafana-ui/src/components/Table/BarGaugeCell.tsx` — `:28`
  `const displayValue = field.display!(cell.value)`; the Gauge cell renderer.
- `packages/grafana-ui/src/components/BarGauge/BarGauge.tsx` — `:479-483` `getValuePercent`
  (`return isNaN(valueRatio) ? 0 : valueRatio;`); `:494` `getValuePercent(value.numeric, minValue, maxValue)`.

### 6.6 External corroboration

Cited by platform, number, and title only; no external text is reproduced.

- **Grafana "Transform data" documentation** — for the remaining (missing) cells the user selects a value
  among Null / True / False / Empty; there is no built-in `Zero`, and the pivoted output defaults to string
  when types are mixed.
- **GitHub issue grafana/grafana#97632** — "Grouping to matrix doesn't support 0 for undefined combinations":
  corroborates that undefined combinations render as empty cells rather than `0`, and that no `Zero` option
  exists.
- **Grafana Community topic #74645** — "Transform Grouping To Matrix issue" (a `community.grafana.com` forum
  thread, not a GitHub issue): reports that with blank columns, addition is performed as string concatenation
  rather than numeric addition — corroborating the raw-reducer behavior in §2.1.
- **Duplicate `(row, column)` last-value-wins** is established directly by the source line
  `groupingToMatrix.ts:102` (`matrixValues[columnName][rowName] = value`), which is the authority for that
  claim; related discussion appears in the issue tracker (e.g. grafana/grafana#65248), but the source line is
  the definitive reference.
