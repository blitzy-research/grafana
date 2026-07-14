# Grouping to Matrix — What value fills the missing cells, and how it behaves downstream

> **Runtime‑grounded investigation.** Every behavioral claim below is labeled **[OBSERVED]** (captured
> from an actual run of the real code path) or **[INFERRED]** (reasoned from reading the source). The
> observed values were produced by exercising the **registered** `groupingToMatrix` transformer through
> its canonical entry point `transformDataFrame`, and then feeding the transformed field into the real
> downstream field pipeline (`reduceField`, `getActiveThreshold`, `getScaleCalculator`,
> `getDisplayProcessor`). No Grafana source file was modified; the harness lived outside the checkout and
> was removed afterward.

**Provenance**

```
# Grafana version: 11.5.0-pre  | Node: v22.23.1 | Jest: 29.7.0
# canonical: mockTransformationsRegistry([groupingToMatrixTransformer]) + transformDataFrame
```

Commands used (non‑interactive, CI mode — never the repo‑root `test` script, which runs in watch mode):

```bash
# 1) Sanity: the project's own canonical spec (exercises transformDataFrame on a sparse dataset)
CI=true node .yarn/releases/yarn-4.5.3.cjs jest \
  packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts \
  --watchAll=false --ci
#   => Test Suites: 1 passed, Tests: 4 passed

# 2) The observation harness (placed under /tmp/obs, OUTSIDE the repo; removed afterwards)
CI=true node .yarn/releases/yarn-4.5.3.cjs jest \
  --config /tmp/obs/jest.config.obs.js --watchAll=false --ci
#   => Test Suites: 2 passed, Tests: 2 passed
```

The harness registered the **real** transformer with `mockTransformationsRegistry([groupingToMatrixTransformer])`
(exactly how the project's own spec registers it so `transformDataFrame` can resolve it by id — this is not
a bypass of the transformer) and ran it on the sparse frame `Column=['C1','C1','C2']`, `Row=['R1','R2','R1']`,
`Temp=[1,4,5]`, so the pairing **`(C2,R2)` never appears** in the input. Output was written to a file (the
repo's Jest setup fails any test that calls `console.log` via `jest-fail-on-console`).

---

## 1. Direct answer

**When a `(row, column)` combination is missing from a sparse input, the "Grouping to matrix" transformation
emits the empty string `''` by default — not `0`, and not `null`.** [OBSERVED]

- The missing cell is resolved here:
  `const value = matrixValues[columnName][rowName] ?? getSpecialValue(emptyValue);`
  — `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts:117`.
- The default `emptyValue` is `SpecialValue.Empty`
  (`const DEFAULT_EMPTY_VALUE = SpecialValue.Empty;` — `groupingToMatrix.ts:26`), applied at
  `const emptyValue = options.emptyValue || DEFAULT_EMPTY_VALUE;` — `groupingToMatrix.ts:71`.
- `getSpecialValue` (`groupingToMatrix.ts:178`) maps the default `Empty` → `''`
  (`groupingToMatrix.ts:186-188`); it also maps `False→false` (`:180`), `True→true` (`:182`),
  `Null→null` (`:184`).

**The value can be configured to `Null`, `True`, or `False`, but there is _no_ `Zero` option.** [OBSERVED]

- The `SpecialValue` enum contains exactly `True`, `False`, `Null`, `Empty` — and nothing else:
  `packages/grafana-data/src/types/transformations.ts:113-117`.
- The transform editor's **"Empty Value"** dropdown mirrors exactly those four choices
  (`public/app/features/transformers/editors/GroupingToMatrixTransformerEditor.tsx:61-66`, options at
  `:62-65`, `<InlineField label="Empty Value">` at `:100`); the in‑app help lists the same four
  (`public/app/features/transformers/docs/content.ts:631`). **So "missing means zero" is not a value you
  can select.**

**The root cause of the perceived inconsistency is a type/semantic mismatch.** [OBSERVED] The output column
field's declared `type` is _copied from the value field_ (typically `number`) at
`type: valueField.type,` — `groupingToMatrix.ts:133` (column name set at `:130`). So a field that _declares
itself_ `number` ends up **holding a string `''`** for missing cells. Downstream code then coerces that `''`
**differently in every path** — string in totals, `0` in threshold/scale comparisons, and `NaN` (blank) in
the per‑cell renderer. That divergence is precisely the "different choice somewhere along the way" the
dashboard exhibits.

**Bottom line for the user's "missing means zero" model:** it is not expressible directly. The closest clean
result is `emptyValue = SpecialValue.Null` on the transform **plus** the panel's null‑as‑zero null‑value mode
(`NullValueMode.AsZero`). See [§5](#5-missing-means-zero-the-correct-recipe).

---

## 2. Sparse‑dataset walkthrough — the value at the transform boundary

**Input frame** (three fields; the `(C2,R2)` pairing is deliberately absent):

| Column | Row | Temp |
| ------ | --- | ---- |
| C1     | R1  | 1    |
| C1     | R2  | 4    |
| C2     | R1  | 5    |

Pivoting on `Column` (columns), `Row` (rows), `Temp` (cell value) yields a matrix with rows `R1`, `R2` and
columns `C1`, `C2`. The only cell with no source value is **`(C2, R2)`**.

**Command:** run `transformDataFrame([{ id:'groupingToMatrix', options:{columnField:'Column',
rowField:'Row', valueField:'Temp', /* emptyValue varied */ } }], [frame])` and inspect each output field's
`type` and `values`.

**Observed output — emit boundary, by `emptyValue`:** [OBSERVED]

```
=== A1 DEFAULT (options={} apart from field names) rows=R1,R2,R1 -> (C2,R2) missing ===
@@@ field Row\Column type=string => ["R1","R2"]  typeof=[string,string]
@@@ field C1 type=number => [1,4]  typeof=[number,number]
@@@ field C2 type=number => [5,""]  typeof=[number,string]
=== A2 emptyValue=Null ===
@@@ field C2 type=number => [5,null]  typeof=[number,object]
=== A3 emptyValue=False ===
@@@ field C2 type=number => [5,false]  typeof=[number,boolean]
=== A4 emptyValue=True ===
@@@ field C2 type=number => [5,true]  typeof=[number,boolean]
=== A5 emptyValue=Empty (explicit) ===
@@@ field C2 type=number => [5,""]  typeof=[number,string]
```

Reading the output:

- **`C2 = [5, ""]`** with `type=number` and `typeof=[number,string]`. The first cell `(C2,R1)=5` is the real
  value; the missing `(C2,R2)` is the empty **string** `''`, sitting inside a field that declares itself
  `number`. This is the exact shape the project's own spec asserts:
  `type: FieldType.number`, `values: [5, '']` at
  `packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts:97-100`. [OBSERVED]
- Switching `emptyValue` changes only the missing cell: `Null → null` (`typeof object`), `False → false`,
  `True → true`, explicit `Empty → ''`. There is no setting that produces the number `0`. [OBSERVED]

`(JSON note: typeof null is "object"; that is standard JavaScript, not a Grafana quirk.)`

---

## 3. Following the `''` downstream — four calculation paths

Each subsection below feeds the transformed value into one real downstream function, shows the exact command,
pastes the unedited output, cites the `file:line` cause, and labels the finding. The comparison values `0`,
`5`, and `null` are included alongside `''` so the coercion is unambiguous.

### 3.1 Totals (SUM) → JavaScript string concatenation (position‑sensitive)

**Command:** `reduceField({ field: { type: number, values }, reducers: [ReducerID.sum] })[ReducerID.sum]`
for several value orderings.

**Observed output:** [OBSERVED]

```
=== B SUM totals (position sensitivity / string concat) ===
@@@ C2 trailing-empty values => [5,""]  typeof=[number,string]
@@@ C2 leading-empty values => ["",5]  typeof=[string,number]
@@@ SUM(trailing [5,empty]) = "5" typeof=string
@@@ SUM(leading [empty,5]) = "05" typeof=string
@@@ SUM([empty,2]) = "02"
@@@ SUM([2,empty]) = "2"
@@@ SUM([empty,empty]) = "0"
@@@ SUM([empty,1,2,3]) = "0123"
```

**Every sum is a string** (`typeof=string`), and its exact text **depends on the position of the empty
cells**. Cause chain:

- `doStandardCalcs` (`packages/grafana-data/src/transformations/fieldReducer.ts:468`) treats the field as
  numeric because `isNumberField = field.type === FieldType.number || field.type === FieldType.time`
  (`fieldReducer.ts:478`) — and the field _declares_ `number`.
- The accumulator starts as the numeric `0`: `defaultCalcs` at `fieldReducer.ts:445` with `sum: 0` at
  `fieldReducer.ts:446`.
- The null‑guard `if (currentValue == null)` (`fieldReducer.ts:489`) only catches `null`/`undefined`. An
  empty string is **not** `== null`, so `''` slips past it.
- The value then passes the guard `if (currentValue != null && !Number.isNaN(currentValue))` at
  **`fieldReducer.ts:500`** (its comment `// null || undefined || NaN` is on `:501`) — because `'' != null`
  is `true` and `Number.isNaN('')` is `false` — and reaches `calcs.sum += currentValue`
  (`fieldReducer.ts:508`). For a string operand, `+=` performs **string concatenation**, not addition.

So the very first `0 + ''` yields the string `"0"`, which is why a **leading** empty prepends a `'0'`
(`['',5] → "05"`, `['',2] → "02"`, `['',1,2,3] → "0123"`), whereas a **trailing** empty appends nothing
visible after the number stringifies (`[5,''] → "5"`, `[2,''] → "2"`). Two empties give `"0"`
(`0 + '' + '' → "0"`). [OBSERVED] This position‑dependent footer total is exactly the "different choice
somewhere along the way" a user notices. In a table panel the footer total is computed through
`reduceField(...)[calc]` at `packages/grafana-ui/src/components/Table/utils.ts:404` and rendered by
`packages/grafana-ui/src/components/Table/FooterCell.tsx`, so this string surfaces directly in the totals row.

> **Note (not a contradiction):** the sum reducer's `emptyInputResult: 0` (`fieldReducer.ts:310`) and the
> comment at `fieldReducer.ts:143` ("typically null, but … 'count' & 'sum' should be zero") govern only the
> **empty‑input** case (a field with _no rows at all_). They do **not** coerce a per‑row `''` to `0`. [INFERRED]

### 3.2 Thresholds → `''` is coerced to `0` in the `>=` comparison

**Command:** `getActiveThreshold(value, [{ value: -Infinity, color: 'green' }, { value: 3, color: 'red' }])`
for `value ∈ {5, 0, '', null}`.

**Observed output:** [OBSERVED]

```
=== C THRESHOLDS getActiveThreshold(value, steps=[{-Infinity,green},{3,red}]) ===
@@@ threshold(5)    = {"value":3,"color":"red"}
@@@ threshold(0)    = {"value":null,"color":"green"}
@@@ threshold(empty)= {"value":null,"color":"green"}
@@@ threshold(null) = {"value":null,"color":"green"}
```

`threshold('')` is **identical to `threshold(0)`**: both select the `green` band and are distinct from
`threshold(5)` (which selects `red`). So a missing cell is banded **as if it were `0`**. Cause:
`getActiveThreshold` (`packages/grafana-data/src/field/thresholds.ts:7`) compares
`if (value >= threshold.value)` (`thresholds.ts:15`); the relational operator coerces `'' → 0`, and
`0 >= -Infinity` is `true` while `0 >= 3` is `false`, leaving the `-Infinity`/green step active. [OBSERVED]

> **JSON nuance:** the `{"value":null,…}` you see is the `{ value: -Infinity, color: 'green' }` step, not a
> literal `null` threshold — `JSON.stringify(-Infinity) === null` (demonstrated in the appendix). [OBSERVED]

### 3.3 Color scale → `''` is coerced to `0` via subtraction (percent 0)

**Command:** `getScaleCalculator(field{ type:number, config:{ min:0, max:10 } }, createTheme())(value)` for
`value ∈ {5, 0, ''}`.

**Observed output:** [OBSERVED]

```
=== D COLOR SCALE getScaleCalculator(field{min:0,max:10}) ===
@@@ scale(5)     = {"percent":0.5,"threshold":{"value":0,"color":"#808080"},"color":"#808080"}
@@@ scale(0)     = {"percent":0,"threshold":{"value":0,"color":"#808080"},"color":"#808080"}
@@@ scale(empty) = {"percent":0,"threshold":{"value":0,"color":"#808080"},"color":"#808080"}
```

`scale('').percent === 0`, **identical to `scale(0)`** and distinct from `scale(5).percent === 0.5`. So on a
0→10 range, the missing cell is placed at the _bottom_ of the color scale exactly like a real `0`. Cause:
`getScaleCalculator` computes `percent = (value - info.min!) / info.delta`
(`packages/grafana-data/src/field/scale.ts:32`); the `-` operator coerces `'' → 0`, giving
`(0 - 0) / 10 = 0`. (The guard `if (value !== -Infinity)` at `scale.ts:31` is satisfied because
`'' !== -Infinity`, so the subtraction runs.) The field's min/max come from `getMinMaxAndDelta`
(`scale.ts:74`), which calls `reduceField({ field, reducers: [ReducerID.min, ReducerID.max] })`
(`scale.ts:85`) when they are not set explicitly. [OBSERVED]

> The `color` is `#808080` (a neutral gray) only because the harness field configured **no** color mode, so
> the calculator falls back to a fixed color; the **percent** (0 vs 0.5) is the evidence that matters. With a
> continuous color mode configured (e.g. `field.config.color = { mode: 'continuous-GrYlRd' }`) the resulting
> `color` would differ between `5` and `0`/`''`, but `''` would still track `0`. [INFERRED]

### 3.4 Per‑cell display → `''` becomes `NaN` → the cell renders blank

**Command:** `getDisplayProcessor({ field:{ type:number }, theme:createTheme() })(value)` for
`value ∈ {5, 0, '', null}`, reading `.text` and `.numeric`.

**Observed output:** [OBSERVED]

```
=== E PER-CELL DISPLAY getDisplayProcessor(field type=number) ===
@@@ display(5)     = {"text":"5","numeric":5}
@@@ display(0)     = {"text":"0","numeric":0}
@@@ display(empty) = {"text":"","numeric":null}
@@@ display(null)  = {"text":"","numeric":null}
@@@ display(empty).numeric Number.isNaN? = true
```

`display('')` renders **blank** (`text:""`). Note the crucial contrast: unlike thresholds and scale, per‑cell
display does **not** treat `''` like `0` — `display(0)` shows `text:"0"`, whereas `display('')` shows an empty
string. Cause: `numeric = isStringUnit ? NaN : anyToNumber(value)`
(`packages/grafana-data/src/field/displayProcessor.ts:96`), and `anyToNumber('')` returns `NaN` — the helper
deliberately overrides lodash for `''`/`null`/`undefined`/arrays
(`packages/grafana-data/src/utils/anyToNumber.ts:13-14`, comment "lodash calls them 0"). Because `numeric` is
`NaN`, the block `if (!Number.isNaN(numeric))` at `displayProcessor.ts:144` — which formats text and applies
scale‑based color — is **skipped**. So the missing cell is neither `0` nor colored; it is blank. [OBSERVED]

> **JSON nuance:** `numeric` prints as `null` above only because `JSON.stringify(NaN) === null`. The explicit
> check `display('').numeric Number.isNaN? = true` confirms the real value is `NaN`, not `null`. [OBSERVED]
> The per‑cell text is produced by `field.display!(cell.value)` in the table renderer
> (`packages/grafana-ui/src/components/Table/DefaultCell.tsx:23`), so this blank is what appears in the cell.

---

## 4. Reconciliation — where the code diverges from "missing means zero"

The single emitted value `''` is **coerced path‑dependently**, and that is the whole story:

| Downstream path      | What happens to the missing `''`                                                                                            |    Behaves like `0`?    | Cause (`file:line`)                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | :---------------------: | ------------------------------------------------------------------------------------------------- |
| **Totals (sum)**     | String concatenation; result is a **string** whose text depends on position (`"05"`, `"5"`, `"02"`, `"2"`, `"0"`, `"0123"`) | **No** — it is a string | `fieldReducer.ts:489` (guard misses `''`), `:500` (guard passes `''`), `:508` (`+=` concatenates) |
| **Thresholds**       | `'' >= step` coerces `'' → 0`; banded exactly like `0`                                                                      |         **Yes**         | `thresholds.ts:15`                                                                                |
| **Color scale**      | `(value - min)` coerces `'' → 0`; `percent = 0`, same as `0`                                                                |         **Yes**         | `scale.ts:32`                                                                                     |
| **Per‑cell display** | `anyToNumber('') = NaN`; text is blank, color block skipped                                                                 |  **No** — blank/`NaN`   | `displayProcessor.ts:96`, `:144`; `anyToNumber.ts:13-14`                                          |

So the **same** missing cell simultaneously reads as a _string_ in the footer total, as _`0`_ in the
threshold/scale comparisons, and as _blank (`NaN`)_ in the cell body. Three different meanings for one value —
that is exactly why the dashboard "feels like it is making a different choice somewhere along the way."
[OBSERVED]

The user's mental model, **"missing means zero,"** is not wrong about intent — it is simply **not expressible**
in this transform. The chooseable values are `Null`, `True`, `False`, `Empty` (`transformations.ts:113-117`);
there is **no `Zero`**. The default `Empty` (`''`) then _approximates_ zero in the two comparison paths
(threshold/scale) while _failing_ to be zero in the two value paths (totals concatenate; the cell renders
blank). The mismatch is seeded at the transform boundary, where a `number`‑typed field
(`groupingToMatrix.ts:133`) is filled with a string (`groupingToMatrix.ts:117`, `:26`, `:186-188`). [OBSERVED]

---

## 5. "Missing means zero," the correct recipe

Because there is no `Zero` option, the clean way to get true numeric zero semantics with the **existing**
options is two coordinated settings:

1. On the transform, set **`emptyValue = SpecialValue.Null`** so missing cells become a real `null`
   (observed `C2 = [5, null]`), instead of the string `''`.
2. On the panel/field, set the null‑value mode to **null‑as‑zero** (`NullValueMode.AsZero`).

**Command:** reduce the `emptyValue=Null` field `C2 = [5, null]` with `field.config.nullValueMode` set to
`Ignore` vs `AsZero`, and contrast with the default `''` field under `AsZero`.

**Observed output:** [OBSERVED]

```
=== F RECIPE emptyValue=Null + nullValueMode ===
@@@ C2 (emptyValue=Null) values => [5,null]  typeof=[number,object]
@@@ Null+Ignore  sum=5 (number) mean=5
@@@ Null+AsZero  sum=5 (number) mean=2.5
@@@ Empty+AsZero [5,empty] sum="5" (string) mean=2.5
@@@ Empty+AsZero [empty,5] sum="05" (string) mean=2.5
```

- With **`Null`**, the sum is a clean **numeric `5`** (not a string), regardless of null‑value mode. [OBSERVED]
- Adding **`AsZero`** makes the `null` **count as `0`**: the mean drops from `5` (one value counted) to
  `2.5` (two values, one of them `0`). This is `fieldReducer.ts:493` setting `currentValue = 0` inside the
  `if (currentValue == null)` guard (`:489`), gated by
  `nullAsZero = nullValueMode === NullValueMode.AsZero` (`:201`). [OBSERVED]
- Crucially, **`Empty + AsZero` still yields a _string_** (`"5"` for `[5,'']`, `"05"` for `['',5]`) — because
  `''` is not `== null`, the `nullAsZero` branch never fires for it. So the default `Empty` cannot be
  rescued by the panel's null‑as‑zero mode; **only `Null` yields clean numeric behavior.** [OBSERVED]

> **My run vs the reference capture:** the architect's baseline showed `Empty+AsZero` only for the trailing
> ordering (`[5,''] → "5"`). My run reproduces that (`"5"`) **and** adds the leading ordering
> (`['',5] → "05"`) to show the string result is position‑sensitive even under `AsZero`. All other observed
> values matched the baseline exactly. [OBSERVED]

**Recipe, stated plainly:** \*Grouping to matrix → Empty Value = **Null\***, then on the value field set
_Standard options → No value / null handling_ to treat null **as zero** (`NullValueMode.AsZero`). Do **not**
rely on the default `Empty`.

---

## 6. Edge and robustness notes

- **Duplicate `(row, column)` pairs resolve last‑value‑wins.** [OBSERVED] Feeding `Column=['C1','C1']`,
  `Row=['R1','R1']`, `Temp=[10,20]` (the same cell twice) produces:

  ```
  === G EDGE duplicate (row,column) last-value-wins ===
  @@@ dup field Row\Column => ["R1"]  typeof=[string]
  @@@ dup field C1 => [20]  typeof=[number]     (input values were [10,20] for (R1,C1))
  ```

  The second value `20` overwrote the first `10`, because the fill loop does a plain assignment
  `matrixValues[columnName][rowName] = value` (`groupingToMatrix.ts:102`) with no aggregation. [OBSERVED]

- **The `dataplaneFrontendFallback` feature toggle does not change the emitted value.** [OBSERVED] Read at
  module load (`groupingToMatrix.ts:31`), it defaults to `undefined` (OFF). With the toggle OFF and ON the
  missing cell is `''` in both cases:

  ```
  ----- DATAPLANE TOGGLE -----
  @@@ default window.grafanaBootData...dataplaneFrontendFallback = undefined  (=> OFF)
  @@@ toggle OFF C2 = [5,""]  typeof=[number,string] type=number
  # (separate process, toggle forced ON before module load)
  @@@ window.grafanaBootData...dataplaneFrontendFallback = true  (=> ON)
  @@@ toggle ON  C2 = [5,""]  typeof=[number,string] type=number
  ```

  The toggle only affects field **matching** (`groupingToMatrix.ts:163-168`) and numeric‑**column naming**
  (`groupingToMatrix.ts:125-127`), **not** the emit at `:117`. [OBSERVED] In production this boot data is
  injected by the Go backend into the served HTML, so its default state is environment‑dependent; either
  way it does not change the answer. [INFERRED]

- **Mixed value types coerce the pivoted output toward string.** [INFERRED] The output field's `type` is
  copied verbatim from the value field (`groupingToMatrix.ts:133`); if the value field is `number` but a
  missing cell is `''`, the field is already type‑inconsistent, and any consumer that concatenates (as the
  sum path does) will produce strings. This compounds the perceived inconsistency.

- **This is documented, not fixed, behavior.** Community reports corroborate the observations: the request
  for a zero option for undefined combinations (GitHub issue #97632), the string‑concatenation of blank
  columns in totals (community report #74645), and last‑value‑wins on duplicate pairs (issue #65248). No
  source code is changed by this investigation; implementing a `Zero` option is explicitly out of scope.

---

## 7. Appendix — observed‑vs‑inferred, JSON nuances, and citations

### 7.1 Two JSON‑serialization nuances (so the raw output above is not misread)

Both were confirmed at runtime: [OBSERVED]

```
=== H JSON NUANCES (why some raw values print as null) ===
@@@ JSON.stringify(-Infinity) = null
@@@ JSON.stringify(NaN) = null
```

- In §3.2, the threshold shown as `{"value":null,…}` is the `{ value: -Infinity, color: 'green' }` step —
  `JSON.stringify(-Infinity)` is `null`. It is **not** a literal `null` threshold value.
- In §3.4, `display('').numeric` shown as `null` is really `NaN` — `JSON.stringify(NaN)` is `null`. The
  explicit `Number.isNaN(...) = true` check confirms it.

### 7.2 Observed vs inferred — summary

**[OBSERVED]** (captured from the harness run): the default emit `''`; the `Null`/`False`/`True`/`Empty`
variants; the sum string‑concatenation and its position sensitivity; `threshold('') == threshold(0)`;
`scale('').percent == 0 == scale(0)`; `display('')` blank with `numeric = NaN`; the `Null` + `AsZero` recipe
(mean `5 → 2.5`) and that `Empty + AsZero` stays a string; duplicate‑pair last‑value‑wins; the dataplane
toggle default (OFF) and that OFF/ON both emit `''`; and both JSON nuances.

**[INFERRED]** (reasoned from source, not directly rendered): that a configured continuous color mode would
produce visibly different cell colors for `5` vs `0`/`''` (the harness used no color mode, so only `percent`
was observed); that mixed value types coerce output toward string; and that in production the Go backend
injects the boot‑data toggle (the toggle's _effect on the emit_ was observed to be none).

### 7.3 Verified `file:line` citations (all checked against this checkout at HEAD `4550cfb5b7`)

**Emit boundary / options**

- `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts` — `:26`
  `DEFAULT_EMPTY_VALUE = SpecialValue.Empty`; `:31` dataplane toggle read; `:71`
  `options.emptyValue || DEFAULT_EMPTY_VALUE`; `:102` `matrixValues[col][row] = value` (last‑wins); `:117`
  `?? getSpecialValue(emptyValue)`; `:125-127` dataplane column naming; `:130` `name: columnName.toString()`;
  `:133` `type: valueField.type`; `:163-168` dataplane field matching; `:178` `getSpecialValue`
  (`False→false :180`, `True→true :182`, `Null→null :184`, `Empty/default→'' :186-188`).
- `packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts` — `:1` `toDataFrame`,
  `:5` `transformDataFrame`, `:97-100` `type: number` / `values: [5, '']`, `:112` `SpecialValue.Null`.
- `packages/grafana-data/src/types/transformations.ts` — `:113-117` `SpecialValue` enum
  (`True`/`False`/`Null`/`Empty`; **no `Zero`**).
- `packages/grafana-data/src/index.ts` — `:431` exports `GroupingToMatrixTransformerOptions`.
- `packages/grafana-data/src/transformations/transformDataFrame.ts` — `:76` `transformDataFrame` (canonical
  entry point).
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
  only the empty‑**input** case); `:201` `nullAsZero = nullValueMode === NullValueMode.AsZero`; `:310` sum
  `emptyInputResult: 0`; `:445-446` `defaultCalcs` with `sum: 0`; `:468` `doStandardCalcs`; `:478`
  `isNumberField = field.type === number || time`; `:489` `if (currentValue == null)`; `:493`
  `if (nullAsZero)` → `:494` `currentValue = 0`; **`:500`** the guard
  `if (currentValue != null && !Number.isNaN(currentValue))` (its comment `// null || undefined || NaN` is
  on `:501` — cite **`:500`**); `:508` `calcs.sum += currentValue`.
- `packages/grafana-data/src/field/thresholds.ts` — `:7` `getActiveThreshold`; `:15`
  `if (value >= threshold.value)`.
- `packages/grafana-data/src/field/scale.ts` — `:31` `if (value !== -Infinity)`; `:32`
  `percent = (value - info.min!) / info.delta`; `:74` `getMinMaxAndDelta`; `:85`
  `reduceField({ field, reducers: [ReducerID.min, ReducerID.max] })`.
- `packages/grafana-data/src/field/displayProcessor.ts` — `:96`
  `numeric = isStringUnit ? NaN : anyToNumber(value)`; `:144` `if (!Number.isNaN(numeric))` (scale/color
  block skipped when `NaN`).
- `packages/grafana-data/src/utils/anyToNumber.ts` — `:13-14` returns `NaN` for `''`/`null`/`undefined`/array
  (deliberately overriding lodash; comment "lodash calls them 0").

**Render surface (where it becomes visible)**

- `public/app/plugins/panel/table/TablePanel.tsx` — renders the matrix, footer totals, and cell coloring.
- `packages/grafana-ui/src/components/Table/utils.ts` — `:404`
  `reduceField({ field, reducers: reducer })[calc]` (footer totals reduction).
- `packages/grafana-ui/src/components/Table/FooterCell.tsx` — value map `:31`; `EmptyCell` `:47`.
- `packages/grafana-ui/src/components/Table/DefaultCell.tsx` — `:23`
  `const displayValue = field.display!(cell.value)` (per‑cell display → `''` yields blank text); color
  background via `getCellColors`/`getCellOptions` (`:17`, `:27`).
- `packages/grafana-ui/src/components/Table/BarGaugeCell.tsx` — gauge cell path (alternative
  color‑background surface).

### 7.4 Reproduction provenance

```
# Grafana version: 11.5.0-pre  | Node: v22.23.1 | Jest: 29.7.0
# canonical registration: mockTransformationsRegistry([groupingToMatrixTransformer]) + transformDataFrame
# canonical spec:  CI=true node .yarn/releases/yarn-4.5.3.cjs jest \
#                    packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts \
#                    --watchAll=false --ci      => Test Suites: 1 passed, Tests: 4 passed
# harness (removed after capture; lived under /tmp/obs, outside the repo):
#                  CI=true node .yarn/releases/yarn-4.5.3.cjs jest \
#                    --config /tmp/obs/jest.config.obs.js --watchAll=false --ci
#                                               => Test Suites: 2 passed, Tests: 2 passed
```

_External corroboration (cited by number/title only; no external text reproduced):_ Grafana "Transform data"
documentation (missing cells choose among Null/True/False/Empty; pivoted output defaults to string when types
are mixed); GitHub issues #97632 (no zero option for undefined combinations), #74645 (blank‑column totals
concatenate as strings), and #65248 (duplicate pairs resolve last‑value‑wins).
