# "Grouping to matrix" — what a _missing_ row/column intersection actually becomes, and how that value is carried forward

**An evidence‑grounded, run‑first investigation.** Every value in this document was produced by executing the real Grafana code on this exact commit through its canonical entry point; the exact command that produced each block is shown adjacent to it, and the temporary observation spec is deleted afterward so the repository is left unchanged.

---

## 0. Context under test

| Item                            | Value                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Repository                      | `grafana/grafana`                                                                                               |
| Branch (source)                 | `grafana_4550cfb5b728`                                                                                          |
| Source commit                   | `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`                                                                      |
| Package                         | `@grafana/data`                                                                                                 |
| Canonical transform entry point | `transformDataFrame` — `packages/grafana-data/src/transformations/transformDataFrame.ts:76`                     |
| Transformer under test          | `groupingToMatrixTransformer` — `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts:33` |
| Test runner                     | `jest 29.7.0` (`ts-jest 29.2.5`, `typescript 5.5.4`) — versions confirmed by the provenance block in §1.1        |

**The question.** In the "Grouping to matrix" transformation, when the input series is _sparse_ — i.e. some `column × row` intersections never occur — what value is placed in the empty cell (empty, `null`, or `0`), how is that value carried forward when a panel renders the matrix, and how does it affect totals, thresholds, and color scales? Following one concrete sparse dataset end‑to‑end, where do the semantics shift?

**User hypothesis (verbatim):** _"missing means zero."_

**User observation (verbatim):** the dashboard _"feels like it is making a different choice somewhere."_

**Short verdict.** The hypothesis is **false**. By default a missing intersection is emitted as the **empty string `''`** (never `0`), and — critically — that `''` is stored in a **`FieldType.number`‑typed** column. The user's _sense_ that a different choice is being made "somewhere" is **correct and precisely localizable**: it is not one decision but the **divergence among the downstream consumers**, each of which coerces the identical `''` cell differently — totals **string‑concatenate** it, thresholds and the direct color scale **coerce it to numeric `0`**, and display renders it **blank** (its color arriving from a _separate_ `-Infinity` fallback path). Every value below was produced by running the real code on this exact commit and is reproducible from the single spec in §1.2.

---

## 1. Methodology (run‑first, canonical path, deterministic, fully reproducible)

All values in this document come from executing the **canonical** entry point `transformDataFrame` and the **real exported** field‑processing functions — never a re‑implementation of the grouping loop. A single temporary Jest spec drives a deliberately sparse `DataFrame` through the transform for **every** `emptyValue` variant — the omitted/default case, the **explicit** `SpecialValue.Empty`, `Null`, `True`, and `False` — plus a clearly‑labeled **non‑canonical numeric‑zero control** (a `[2, 0, 4]` column that no option can emit), and then feeds the emitted missing cell of **each** condition into **every** downstream consumer:

- `reduceField` / `doStandardCalcs` — totals (`packages/grafana-data/src/transformations/fieldReducer.ts`)
- `getActiveThreshold` / `getActiveThresholdForValue` — thresholds (`packages/grafana-data/src/field/thresholds.ts`)
- `getScaleCalculator` — color scale (`packages/grafana-data/src/field/scale.ts`)
- `getDisplayProcessor` + `anyToNumber` — rendered cell (`packages/grafana-data/src/field/displayProcessor.ts`, `packages/grafana-data/src/utils/anyToNumber.ts`)

The spec asserts **every** value it captures (so the test _passes_ only if all documented values hold) and writes its captured lines to a file — Grafana's Jest setup fails any test that calls `console.log`, so output is written via `fs.writeFileSync` to the path named by `INV_OUT`. This section is a complete, copy/paste‑runnable transcript: §1.1 records the exact build/runtime provenance and the install prerequisite; §1.2 is the single self‑contained reproducer (it creates the spec, runs it twice, runs the pre‑existing colocated suite as a regression check, and prints determinism — all under `set -euo pipefail` with a `trap` that guarantees the temporary spec is removed on any exit); §1.3 shows the reproducer's own stdout with **exact exit codes**; §1.4 shows the full captured value artifact; §1.5 shows the runner output with its volatility called out; and §1.6 proves the read‑only scope.

### 1.1 Provenance and the install prerequisite (exact build/runtime the values below were produced on)

The transform is a pure TypeScript library exercised under `ts-jest`; no server, database, or network is involved. The dependency graph must be installed **once** before the reproducer can run — `@grafana/data` imports (e.g. `rxjs`, the theme) resolve from `node_modules`, and the runner binary is `node_modules/.bin/jest`. On a bare checkout with no `node_modules`, invoking that binary fails with shell status `127` (command not found); therefore the documented prerequisite, run once from the repository root, is:

```bash
corepack enable                 # provisions the pinned yarn@4.5.3 shim
CI=true yarn install --immutable  # installs the graph without mutating yarn.lock
```

The following block is the **complete, unedited** output of the provenance commands, captured on the same checkout that produced every value in this document:

```text
$ git rev-parse HEAD
5b9ec9502ee3f63d2227eb8588ad56141bbf7114
$ git rev-parse --abbrev-ref HEAD
blitzy-e38a3b1f-f62c-4035-8bb3-8792efaabd5a
$ git rev-parse --show-toplevel
/tmp/blitzy/grafana/blitzy-e38a3b1f-f62c-4035-8bb3-8792efaabd5a_88d36b
$ git merge-base --is-ancestor 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff HEAD && echo 'source commit IS an ancestor of HEAD'
source commit IS an ancestor of HEAD
$ node --version
v22.23.1
$ corepack --version
0.34.6
$ yarn --version
4.5.3
$ node_modules/.bin/jest --version
29.7.0
$ node -e "console.log('typescript', require('typescript/package.json').version, '| ts-jest', require('ts-jest/package.json').version)"
typescript 5.5.4 | ts-jest 29.2.5
$ node -e "const p=require('./package.json'); console.log('packageManager', p.packageManager, '| engines.node', p.engines.node)"
packageManager yarn@4.5.3 | engines.node >= 22
$ cat .nvmrc
v22.11.0
```

Notes grounded in that output: the working tree is at HEAD `5b9ec9502ee3f63d2227eb8588ad56141bbf7114` on branch `blitzy-e38a3b1f-f62c-4035-8bb3-8792efaabd5a`, and the **source commit `4550cfb5b728…` is an ancestor of HEAD**, so the code under observation is exactly this commit's code. The runtime is Node `v22.23.1` satisfying `engines.node ">= 22"`; note that `.nvmrc` pins `v22.11.0` but the provisioned runtime is intentionally newer (`v22.23.1`) — the pin is overridden upward, which is compatible with the `">= 22"` engine constraint. The package manager is `yarn@4.5.3` (via `corepack`), and the toolchain is `jest 29.7.0` / `ts-jest 29.2.5` / `typescript 5.5.4`. The observations were produced inside the project's container image `andrewparkscaleai/coding-agent:grafana__grafana__4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` (from `ghcr.io/scaleapi/swe-atlas:swe_atlas_QnA_grafana_grafana_1.0`), which ships that Node/Yarn toolchain; any equivalent Node `>= 22` environment with the immutable install reproduces the same values.

### 1.2 The single, self‑contained reproducer (safe bash; guaranteed cleanup)

Run this **one** script from the repository root. It uses `set -euo pipefail` so a failure cannot be silently swallowed; a `trap … EXIT ERR INT TERM` guarantees the temporary in‑repo spec is deleted on **any** exit (success, error, or Ctrl‑C); a pre‑existence guard refuses to clobber a file that already exists at that path; and each test invocation's exit status is **captured and printed** (never masked) while still failing the script if any run is non‑zero. The quoted `<<'EOF'` heredoc means the TypeScript body — including its `${…}` and back‑ticks — is written literally.

```bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT"
SPEC=packages/grafana-data/src/transformations/transformers/groupingToMatrixMissingCell.investigation.test.ts
RUN1=/tmp/inv_run1.txt
RUN2=/tmp/inv_run2.txt
JEST="node_modules/.bin/jest --watchAll=false --ci"

# Guarantee the temporary in-repo spec is removed on ANY exit (read-only scope), and tidy /tmp captures.
trap 'rm -f "$SPEC" "$RUN1" "$RUN2"' EXIT ERR INT TERM

# Pre-existence guard: never overwrite an existing tracked file at this path.
if [ -e "$SPEC" ]; then echo "refusing to overwrite existing $SPEC" >&2; exit 3; fi

# 1) Create the temporary observation spec, colocated so its relative imports resolve.
cat > "$SPEC" <<'EOF'
/**
 * TEMPORARY INVESTIGATION SPEC (created solely to capture runtime output, then deleted).
 *
 * Canonical path only: transformDataFrame(groupingToMatrix) on a sparse frame for
 * EVERY emptyValue variant (omitted/default, explicit Empty, Null, True, False), plus a
 * clearly-labeled NON-CANONICAL numeric-zero control that no option can emit; then the
 * emitted missing cell of EACH condition is driven through EVERY real exported downstream
 * consumer: reduceField (sum/mean/min/max/count), getActiveThreshold / getActiveThresholdForValue,
 * getScaleCalculator, anyToNumber, and getDisplayProcessor.
 *
 * Output is written to a file (Grafana's jest setup fails any test that calls console.*),
 * with a lossless representation for every value so '', null, false, true, 0, NaN, -0,
 * undefined and Infinity never collapse. Assertions are exhaustive so the test PASSES only
 * if every documented value holds.
 */
import fs from 'fs';

import { lastValueFrom } from 'rxjs';

import { toDataFrame } from '../../dataframe/processDataFrame';
import { getDisplayProcessor } from '../../field/displayProcessor';
import { getMinMaxAndDelta, getScaleCalculator } from '../../field/scale';
import { getActiveThreshold, getActiveThresholdForValue } from '../../field/thresholds';
import { createTheme } from '../../themes/createTheme';
import { Field, FieldType } from '../../types/dataFrame';
import { FieldColorModeId } from '../../types/fieldColor';
import { Threshold, ThresholdsMode } from '../../types/thresholds';
import { DataTransformerConfig, SpecialValue } from '../../types/transformations';
import { anyToNumber } from '../../utils/anyToNumber';
import { mockTransformationsRegistry } from '../../utils/tests/mockTransformationsRegistry';
import { reduceField, ReducerID } from '../fieldReducer';
import { transformDataFrame } from '../transformDataFrame';

import { GroupingToMatrixTransformerOptions, groupingToMatrixTransformer } from './groupingToMatrix';
import { DataTransformerID } from './ids';

const theme = createTheme();
const LINES: string[] = [];
const log = (s = '') => LINES.push(s);

// Lossless single-value representation with an explicit JS type tag.
function show(v: unknown): string {
  const t = typeof v;
  if (t === 'string') {
    return `(string) ${JSON.stringify(v)}`;
  }
  if (t === 'number') {
    if (Number.isNaN(v as number)) {
      return `(number) NaN`;
    }
    if (v === Infinity) {
      return `(number) Infinity`;
    }
    if (v === -Infinity) {
      return `(number) -Infinity`;
    }
    if (Object.is(v, -0)) {
      return `(number) -0`;
    }
    return `(number) ${String(v)}`;
  }
  if (t === 'boolean') {
    return `(boolean) ${String(v)}`;
  }
  if (t === 'undefined') {
    return `(undefined) undefined`;
  }
  if (v === null) {
    return `(object) null`;
  }
  return `(${t}) ${JSON.stringify(v)}`;
}

// Lossless facts about a single target value.
function facts(v: unknown): string {
  return [
    `repr=${show(v)}`,
    `typeof=${typeof v}`,
    `isNull=${v === null}`,
    `isUndefined=${v === undefined}`,
    `Number.isNaN=${Number.isNaN(v as number)}`,
    `strictZero(===0)=${(v as unknown) === 0}`,
    `Object.is(x,0)=${Object.is(v, 0)}`,
  ].join('  ');
}

function printFields(label: string, fields: Field[]): void {
  log(`\n----- ${label} -----`);
  for (const f of fields) {
    const vals = f.values.map((x: unknown) => show(x)).join(', ');
    log(`  field name="${f.name}" type=${f.type} config=${JSON.stringify(f.config)}  values=[ ${vals} ]`);
  }
}

// Absolute threshold steps that DISTINGUISH a coerced 0 (red) from a coerced 1 (blue),
// so a value that coerces to 1 (boolean true) selects a visibly different step than a
// value that coerces to 0 ('' / null / false / numeric 0).
const STEPS: Threshold[] = [
  { value: -Infinity, color: 'green' },
  { value: 0, color: 'red' },
  { value: 1, color: 'blue' },
  { value: 10, color: 'orange' },
];

// Explicit, printed consumer field config (min/max fix the scale range so results are
// interpretable; thresholds+color mode make the step selection deterministic).
function consumerConfig() {
  return {
    min: 0,
    max: 4,
    color: { mode: FieldColorModeId.Thresholds },
    thresholds: { mode: ThresholdsMode.Absolute, steps: STEPS },
  };
}

const SPARSE = () =>
  toDataFrame({
    name: 'sparse',
    fields: [
      { name: 'Row', type: FieldType.string, values: ['r1', 'r2', 'r3'] },
      { name: 'Column', type: FieldType.string, values: ['A', 'B', 'A'] },
      { name: 'Value', type: FieldType.number, values: [2, 5, 4] },
    ],
  });

async function emit(options: GroupingToMatrixTransformerOptions): Promise<Field[]> {
  const cfg: DataTransformerConfig<GroupingToMatrixTransformerOptions> = {
    id: DataTransformerID.groupingToMatrix,
    options,
  };
  const out = await lastValueFrom(transformDataFrame([cfg], [SPARSE()]));
  return out[0].fields;
}

function colA(fields: Field[]): Field {
  return fields.find((f) => f.name === 'A')!;
}

interface Condition {
  label: string;
  colA: Field; // the emitted (or constructed) column that contains the missing cell at index 1
  isControl?: boolean;
}

describe('INVESTIGATION: Grouping to matrix missing-cell semantics (every condition x every consumer)', () => {
  beforeAll(() => {
    mockTransformationsRegistry([groupingToMatrixTransformer]);
  });

  it('captures emission + lossless facts + every downstream consumer for every condition', async () => {
    // ---------------------------------------------------------------- SECTION 1
    log('================ SECTION 1: SPARSE INPUT FRAME ================');
    log('  columnField=Column, rowField=Row, valueField=Value');
    log('  Row(string)=[r1,r2,r3]  Column(string)=[A,B,A]  Value(number)=[2,5,4]');
    log('  Present intersections: (A,r1)=2  (B,r2)=5  (A,r3)=4');
    log('  MISSING intersections: (A,r2), (B,r1), (B,r3)');
    log('  => Column "A" = [ (A,r1)=2, (A,r2)=MISSING, (A,r3)=4 ]; tracked missing cell is (A,r2) at index 1');

    // ---------------------------------------------------------------- SECTION 2
    log('\n================ SECTION 2: EMITTED MATRIX PER emptyValue VARIANT ================');
    const def = await emit({ columnField: 'Column', rowField: 'Row', valueField: 'Value' });
    const emp = await emit({ columnField: 'Column', rowField: 'Row', valueField: 'Value', emptyValue: SpecialValue.Empty });
    const nul = await emit({ columnField: 'Column', rowField: 'Row', valueField: 'Value', emptyValue: SpecialValue.Null });
    const tru = await emit({ columnField: 'Column', rowField: 'Row', valueField: 'Value', emptyValue: SpecialValue.True });
    const fal = await emit({ columnField: 'Column', rowField: 'Row', valueField: 'Value', emptyValue: SpecialValue.False });
    printFields('emptyValue: OMITTED / DEFAULT  (options {})', def);
    printFields('emptyValue: EXPLICIT SpecialValue.Empty', emp);
    printFields('emptyValue: SpecialValue.Null', nul);
    printFields('emptyValue: SpecialValue.True', tru);
    printFields('emptyValue: SpecialValue.False', fal);

    const controlColA: Field = { name: 'A', type: FieldType.number, config: {}, values: [2, 0, 4] };

    const CONDITIONS: Condition[] = [
      { label: 'omitted/default (options {})', colA: colA(def) },
      { label: 'explicit SpecialValue.Empty', colA: colA(emp) },
      { label: 'SpecialValue.Null', colA: colA(nul) },
      { label: 'SpecialValue.True', colA: colA(tru) },
      { label: 'SpecialValue.False', colA: colA(fal) },
      { label: 'NON-CANONICAL numeric-zero CONTROL [2,0,4] (no emptyValue option emits this)', colA: controlColA, isControl: true },
    ];

    // ---------------------------------------------------------------- SECTION 3
    log('\n================ SECTION 3: LOSSLESS PER-CONDITION TARGET FACTS (missing cell (A,r2)) ================');
    for (const c of CONDITIONS) {
      const cell = c.colA.values[1];
      log(`\n----- ${c.label} -----`);
      log(`  Grafana field.type = ${c.colA.type}   field.config = ${JSON.stringify(c.colA.config)}`);
      log(`  column "A" values = [ ${c.colA.values.map(show).join(', ')} ]`);
      log(`  target (A,r2): ${facts(cell)}`);
    }

    // ---------------------------------------------------------------- SECTION 4
    log('\n================ SECTION 4: CONSUMER INPUT CONFIGS (printed so every result is interpretable) ================');
    log(`  threshold steps (ThresholdsMode.Absolute) = [`);
    for (const s of STEPS) {
      log(`      { value: ${show(s.value)}, color: ${JSON.stringify(s.color)} },`);
    }
    log(`  ]`);
    const scaleCfg = consumerConfig();
    log(`  scale/display field.config = { min: ${scaleCfg.min}, max: ${scaleCfg.max}, color.mode: ${JSON.stringify(scaleCfg.color.mode)}, thresholds.mode: ${JSON.stringify(scaleCfg.thresholds.mode)} (steps as above) }`);
    const rangeField: Field = { name: 'A', type: FieldType.number, config: consumerConfig(), values: [2, 0, 4] };
    const range = getMinMaxAndDelta(rangeField);
    log(`  computed scale range via getMinMaxAndDelta(field) = { min: ${show(range.min)}, max: ${show(range.max)}, delta: ${show(range.delta)} }`);

    // ---------------------------------------------------------------- SECTION 5
    log('\n================ SECTION 5: TOTALS via reduceField / doStandardCalcs (Q3a) ================');
    for (const c of CONDITIONS) {
      const f: Field = { name: 'A', type: FieldType.number, config: {}, values: [...c.colA.values] };
      const calcs = reduceField({ field: f, reducers: [ReducerID.sum, ReducerID.mean, ReducerID.min, ReducerID.max, ReducerID.count] });
      log(`\n----- ${c.label} -----`);
      log(`  reduceField over [ ${c.colA.values.map(show).join(', ')} ]  (default nullValueMode=Ignore)`);
      log(`  sum=${show(calcs.sum)}  mean=${show(calcs.mean)}  min=${show(calcs.min)}  max=${show(calcs.max)}  count=${show(calcs.count)}`);
    }

    // ---------------------------------------------------------------- SECTION 6
    log('\n================ SECTION 6: THRESHOLDS via getActiveThreshold / getActiveThresholdForValue (Q3b) ================');
    for (const c of CONDITIONS) {
      const cell = c.colA.values[1];
      const tField: Field = { name: 'A', type: FieldType.number, config: consumerConfig(), values: [...c.colA.values] };
      const tDirect = getActiveThreshold(cell as unknown as number, STEPS);
      const tForVal = getActiveThresholdForValue(tField, cell as unknown as number, 0);
      log(`\n----- ${c.label} -----`);
      log(`  getActiveThreshold(cell, steps)          = { value: ${show(tDirect.value)}, color: ${JSON.stringify(tDirect.color)} }`);
      log(`  getActiveThresholdForValue(field, cell,0) = { value: ${show(tForVal.value)}, color: ${JSON.stringify(tForVal.color)} }`);
    }

    // ---------------------------------------------------------------- SECTION 7
    log('\n================ SECTION 7: COLOR SCALE via getScaleCalculator (Q3c) ================');
    for (const c of CONDITIONS) {
      const cell = c.colA.values[1];
      const sField: Field = { name: 'A', type: FieldType.number, config: consumerConfig(), values: [...c.colA.values] };
      const scale = getScaleCalculator(sField, theme);
      const r = scale(cell as unknown as number);
      log(`\n----- ${c.label} -----`);
      log(`  getScaleCalculator(field)(cell) => percent=${show(r.percent)}  color=${JSON.stringify(r.color)}  threshold={ value: ${show(r.threshold.value)}, color: ${JSON.stringify(r.threshold.color)} }`);
    }

    // ---------------------------------------------------------------- SECTION 8
    log('\n================ SECTION 8: DISPLAY via getDisplayProcessor + anyToNumber (Q2) ================');
    for (const c of CONDITIONS) {
      const cell = c.colA.values[1];
      const dp = getDisplayProcessor({ field: { type: FieldType.number, config: consumerConfig() }, theme });
      const d = dp(cell);
      log(`\n----- ${c.label} -----`);
      log(`  anyToNumber(cell) = ${show(anyToNumber(cell))}`);
      log(`  getDisplayProcessor(field)(cell) => text=${show(d.text)}  numeric=${show(d.numeric)}  color=${JSON.stringify(d.color)}  percent=${show(d.percent)}`);
    }

    // ---------------------------------------------------------------- SECTION 9
    log('\n================ SECTION 9: NO ZERO OPTION (Q5) ================');
    log(`  Object.values(SpecialValue) = ${JSON.stringify(Object.values(SpecialValue))}`);
    const emittedCells = [colA(def).values[1], colA(emp).values[1], colA(nul).values[1], colA(tru).values[1], colA(fal).values[1]];
    log(`  emitted missing cells across the 5 modes = [ ${emittedCells.map(show).join(', ')} ]`);
    log(`  any emitted mode strictly === 0 ? ${emittedCells.some((v) => (v as unknown) === 0)}`);

    // ---------------------------------------------------------------- SECTION 10
    log('\n================ SECTION 10: NULL CONTRAST (the one clean built-in option) ================');
    const defCalc = reduceField({ field: { name: 'A', type: FieldType.number, config: {}, values: [...colA(def).values] }, reducers: [ReducerID.sum] });
    const nulCalc = reduceField({ field: { name: 'A', type: FieldType.number, config: {}, values: [...colA(nul).values] }, reducers: [ReducerID.sum] });
    log(`  default(Empty) sum = ${show(defCalc.sum)}   vs   Null sum = ${show(nulCalc.sum)}  (Null ignored under default nullValueMode=Ignore)`);

    // ---------------------------------------------------------------- SECTION 11
    log('\n================ SECTION 11: ILLUSTRATIVE JS COERCION (NON-CANONICAL aside) ================');
    log(`  '' + 1        = ${show(('' as any) + 1)}`);
    log(`  0 + '' + 4    = ${show(0 + ('' as any) + 4)}`);
    log(`  Number('')    = ${show(Number(''))}`);
    log(`  '' == null    = ${show(('' as any) == null)}`);
    log(`  '' - 5        = ${show(('' as any) - 5)}`);
    log(`  null - 0      = ${show((null as any) - 0)}`);
    log(`  true - 0      = ${show((true as any) - 0)}`);
    log(`  false - 0     = ${show((false as any) - 0)}`);

    const outPath = process.env.INV_OUT || '/tmp/investigation_output.txt';
    fs.writeFileSync(outPath, LINES.join('\n') + '\n');

    // ===================== EXHAUSTIVE ASSERTIONS =====================
    // The test PASSES only if EVERY documented value holds. Any drift fails the run.

    // ---- Q1 emission: number-typed columns; default === explicit Empty; '' / null / true / false; never 0.
    expect(colA(def).type).toBe(FieldType.number);
    expect(colA(def).values).toEqual([2, '', 4]);
    expect(colA(emp).values).toEqual([2, '', 4]); // explicit Empty === omitted/default
    expect(def.find((f) => f.name === 'B')!.values).toEqual(['', 5, '']);
    expect(colA(nul).values).toEqual([2, null, 4]);
    expect(colA(tru).values).toEqual([2, true, 4]);
    expect(colA(fal).values).toEqual([2, false, 4]);
    expect(emittedCells.some((v) => (v as unknown) === 0)).toBe(false);
    // Q5 enum has no Zero.
    expect(Object.values(SpecialValue)).toEqual(['true', 'false', 'null', 'empty']);

    // ---- SECTION 4: scale range from the printed config.
    expect(range.min).toBe(0);
    expect(range.max).toBe(4);
    expect(range.delta).toBe(4);

    // ---- SECTION 5: totals (Q3a).
    const red = (vals: unknown[]) =>
      reduceField({
        field: { name: 'A', type: FieldType.number, config: {}, values: [...vals] },
        reducers: [ReducerID.sum, ReducerID.mean, ReducerID.min, ReducerID.max, ReducerID.count],
      });
    const cDef = red(colA(def).values);
    expect(cDef.sum).toBe('24'); // string concatenation, NOT numeric 6
    expect(cDef.mean).toBe(8);
    expect(cDef.min).toBe('');
    expect(cDef.max).toBe(4);
    expect(cDef.count).toBe(3);
    const cEmp = red(colA(emp).values);
    expect(cEmp.sum).toBe('24'); // explicit Empty identical to default
    expect(cEmp.mean).toBe(8);
    expect(cEmp.min).toBe('');
    const cNul = red(colA(nul).values);
    expect(cNul.sum).toBe(6); // clean numeric sum; null ignored
    expect(cNul.mean).toBe(3);
    expect(cNul.min).toBe(2);
    expect(cNul.count).toBe(2);
    const cTru = red(colA(tru).values);
    expect(cTru.sum).toBe(7); // true coerces to 1
    expect(cTru.mean).toBeCloseTo(2.3333333333333335, 12);
    expect(cTru.min).toBe(true);
    const cFal = red(colA(fal).values);
    expect(cFal.sum).toBe(6); // false coerces to 0
    expect(cFal.mean).toBe(2);
    expect(cFal.min).toBe(false);
    const cCtl = red(controlColA.values);
    expect(cCtl.sum).toBe(6);
    expect(cCtl.mean).toBe(2);
    expect(cCtl.min).toBe(0);

    // ---- SECTION 6: thresholds (Q3b). '' / null / false / 0 => 0-step (red); true => 1-step (blue).
    const th = (cell: unknown) => getActiveThreshold(cell as unknown as number, STEPS);
    expect(th(colA(def).values[1])).toMatchObject({ value: 0, color: 'red' });
    expect(th(colA(emp).values[1])).toMatchObject({ value: 0, color: 'red' });
    expect(th(colA(nul).values[1])).toMatchObject({ value: 0, color: 'red' });
    expect(th(colA(tru).values[1])).toMatchObject({ value: 1, color: 'blue' });
    expect(th(colA(fal).values[1])).toMatchObject({ value: 0, color: 'red' });
    expect(th(controlColA.values[1])).toMatchObject({ value: 0, color: 'red' });

    // ---- SECTION 7: color scale (Q3c). '' coerces to 0 => red; true coerces to 1 => 0.25/blue.
    const sc = (cell: unknown) =>
      getScaleCalculator({ name: 'A', type: FieldType.number, config: consumerConfig(), values: [2, 0, 4] }, theme)(
        cell as unknown as number
      );
    const sDef = sc(colA(def).values[1]);
    expect(sDef.percent).toBe(0);
    expect(sDef.color).toBe('#F2495C');
    expect(sDef.threshold).toMatchObject({ value: 0, color: 'red' });
    const sTru = sc(colA(tru).values[1]);
    expect(sTru.percent).toBe(0.25);
    expect(sTru.color).toBe('#5794F2');
    expect(sTru.threshold).toMatchObject({ value: 1, color: 'blue' });
    const sFal = sc(colA(fal).values[1]);
    expect(sFal.percent).toBe(0);
    expect(sFal.color).toBe('#F2495C');

    // ---- SECTION 8: display (Q2). '' => blank text, NaN numeric, GREEN via -Infinity fallback.
    const disp = (cell: unknown) => getDisplayProcessor({ field: { type: FieldType.number, config: consumerConfig() }, theme })(cell);
    const dDef = disp(colA(def).values[1]);
    expect(dDef.text).toBe('');
    expect(Number.isNaN(dDef.numeric)).toBe(true);
    expect(dDef.color).toBe('#73BF69'); // green (-Infinity fallback step), NOT the red 0-step of direct scale
    expect(dDef.percent).toBe(0);
    expect(anyToNumber(colA(def).values[1])).toBeNaN();
    const dTru = disp(colA(tru).values[1]);
    expect(dTru.text).toBe('true');
    expect(dTru.numeric).toBe(1);
    expect(dTru.color).toBe('#5794F2');
    expect(anyToNumber(colA(tru).values[1])).toBe(1);
    const dFal = disp(colA(fal).values[1]);
    expect(dFal.text).toBe('false');
    expect(dFal.numeric).toBe(0);
    expect(dFal.color).toBe('#F2495C');
    expect(anyToNumber(colA(fal).values[1])).toBe(0);
    // The identical '' cell: DIRECT scale is red (#F2495C) but DISPLAY fallback is green (#73BF69) => different paths.
    expect(sDef.color).not.toBe(dDef.color);

    // ---- SECTION 11: illustrative JS coercion.
    expect(('' as unknown as number) + 1).toBe('1');
    expect(0 + ('' as unknown as string) + 4).toBe('04');
    expect(Number('')).toBe(0);
    expect(('' as unknown) == null).toBe(false);
  });
});
EOF

# 2) Run it twice, non-interactively, to two separate value-artifact files.
#    Capture each exit code WITHOUT masking failures (the `if` keeps set -e happy).
if CI=true INV_OUT="$RUN1" $JEST "$SPEC"; then r1=0; else r1=$?; fi; echo "run1_exit=$r1"
if CI=true INV_OUT="$RUN2" $JEST "$SPEC"; then r2=0; else r2=$?; fi; echo "run2_exit=$r2"

# 3) Regression: run the PRE-EXISTING colocated suite to prove nothing here perturbs it.
if CI=true $JEST packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts; then rreg=0; else rreg=$?; fi; echo "regression_exit=$rreg"

# 4) Determinism — scoped to the captured VALUE artifact (not the runner log; see §1.5).
sha256sum "$RUN1" "$RUN2"
wc -c "$RUN1" "$RUN2"
if cmp -s "$RUN1" "$RUN2"; then echo "VALUE-ARTIFACT: byte-identical"; else echo "VALUE-ARTIFACT: DIFFER"; fi

# 5) Show the captured values (the ten SECTION blocks quoted throughout this document).
cat "$RUN1"

# 6) Fail loudly if any run was non-zero (does not mask; trap still cleans up).
if [ "$r1" -ne 0 ] || [ "$r2" -ne 0 ] || [ "$rreg" -ne 0 ]; then
  echo "a test run failed" >&2; exit 1
fi
```

The full text written into `$SPEC` by the heredoc above is:

```ts
/**
 * TEMPORARY INVESTIGATION SPEC (created solely to capture runtime output, then deleted).
 *
 * Canonical path only: transformDataFrame(groupingToMatrix) on a sparse frame for
 * EVERY emptyValue variant (omitted/default, explicit Empty, Null, True, False), plus a
 * clearly-labeled NON-CANONICAL numeric-zero control that no option can emit; then the
 * emitted missing cell of EACH condition is driven through EVERY real exported downstream
 * consumer: reduceField (sum/mean/min/max/count), getActiveThreshold / getActiveThresholdForValue,
 * getScaleCalculator, anyToNumber, and getDisplayProcessor.
 *
 * Output is written to a file (Grafana's jest setup fails any test that calls console.*),
 * with a lossless representation for every value so '', null, false, true, 0, NaN, -0,
 * undefined and Infinity never collapse. Assertions are exhaustive so the test PASSES only
 * if every documented value holds.
 */
import fs from 'fs';

import { lastValueFrom } from 'rxjs';

import { toDataFrame } from '../../dataframe/processDataFrame';
import { getDisplayProcessor } from '../../field/displayProcessor';
import { getMinMaxAndDelta, getScaleCalculator } from '../../field/scale';
import { getActiveThreshold, getActiveThresholdForValue } from '../../field/thresholds';
import { createTheme } from '../../themes/createTheme';
import { Field, FieldType } from '../../types/dataFrame';
import { FieldColorModeId } from '../../types/fieldColor';
import { Threshold, ThresholdsMode } from '../../types/thresholds';
import { DataTransformerConfig, SpecialValue } from '../../types/transformations';
import { anyToNumber } from '../../utils/anyToNumber';
import { mockTransformationsRegistry } from '../../utils/tests/mockTransformationsRegistry';
import { reduceField, ReducerID } from '../fieldReducer';
import { transformDataFrame } from '../transformDataFrame';

import { GroupingToMatrixTransformerOptions, groupingToMatrixTransformer } from './groupingToMatrix';
import { DataTransformerID } from './ids';

const theme = createTheme();
const LINES: string[] = [];
const log = (s = '') => LINES.push(s);

// Lossless single-value representation with an explicit JS type tag.
function show(v: unknown): string {
  const t = typeof v;
  if (t === 'string') {
    return `(string) ${JSON.stringify(v)}`;
  }
  if (t === 'number') {
    if (Number.isNaN(v as number)) {
      return `(number) NaN`;
    }
    if (v === Infinity) {
      return `(number) Infinity`;
    }
    if (v === -Infinity) {
      return `(number) -Infinity`;
    }
    if (Object.is(v, -0)) {
      return `(number) -0`;
    }
    return `(number) ${String(v)}`;
  }
  if (t === 'boolean') {
    return `(boolean) ${String(v)}`;
  }
  if (t === 'undefined') {
    return `(undefined) undefined`;
  }
  if (v === null) {
    return `(object) null`;
  }
  return `(${t}) ${JSON.stringify(v)}`;
}

// Lossless facts about a single target value.
function facts(v: unknown): string {
  return [
    `repr=${show(v)}`,
    `typeof=${typeof v}`,
    `isNull=${v === null}`,
    `isUndefined=${v === undefined}`,
    `Number.isNaN=${Number.isNaN(v as number)}`,
    `strictZero(===0)=${(v as unknown) === 0}`,
    `Object.is(x,0)=${Object.is(v, 0)}`,
  ].join('  ');
}

function printFields(label: string, fields: Field[]): void {
  log(`\n----- ${label} -----`);
  for (const f of fields) {
    const vals = f.values.map((x: unknown) => show(x)).join(', ');
    log(`  field name="${f.name}" type=${f.type} config=${JSON.stringify(f.config)}  values=[ ${vals} ]`);
  }
}

// Absolute threshold steps that DISTINGUISH a coerced 0 (red) from a coerced 1 (blue),
// so a value that coerces to 1 (boolean true) selects a visibly different step than a
// value that coerces to 0 ('' / null / false / numeric 0).
const STEPS: Threshold[] = [
  { value: -Infinity, color: 'green' },
  { value: 0, color: 'red' },
  { value: 1, color: 'blue' },
  { value: 10, color: 'orange' },
];

// Explicit, printed consumer field config (min/max fix the scale range so results are
// interpretable; thresholds+color mode make the step selection deterministic).
function consumerConfig() {
  return {
    min: 0,
    max: 4,
    color: { mode: FieldColorModeId.Thresholds },
    thresholds: { mode: ThresholdsMode.Absolute, steps: STEPS },
  };
}

const SPARSE = () =>
  toDataFrame({
    name: 'sparse',
    fields: [
      { name: 'Row', type: FieldType.string, values: ['r1', 'r2', 'r3'] },
      { name: 'Column', type: FieldType.string, values: ['A', 'B', 'A'] },
      { name: 'Value', type: FieldType.number, values: [2, 5, 4] },
    ],
  });

async function emit(options: GroupingToMatrixTransformerOptions): Promise<Field[]> {
  const cfg: DataTransformerConfig<GroupingToMatrixTransformerOptions> = {
    id: DataTransformerID.groupingToMatrix,
    options,
  };
  const out = await lastValueFrom(transformDataFrame([cfg], [SPARSE()]));
  return out[0].fields;
}

function colA(fields: Field[]): Field {
  return fields.find((f) => f.name === 'A')!;
}

interface Condition {
  label: string;
  colA: Field; // the emitted (or constructed) column that contains the missing cell at index 1
  isControl?: boolean;
}

describe('INVESTIGATION: Grouping to matrix missing-cell semantics (every condition x every consumer)', () => {
  beforeAll(() => {
    mockTransformationsRegistry([groupingToMatrixTransformer]);
  });

  it('captures emission + lossless facts + every downstream consumer for every condition', async () => {
    // ---------------------------------------------------------------- SECTION 1
    log('================ SECTION 1: SPARSE INPUT FRAME ================');
    log('  columnField=Column, rowField=Row, valueField=Value');
    log('  Row(string)=[r1,r2,r3]  Column(string)=[A,B,A]  Value(number)=[2,5,4]');
    log('  Present intersections: (A,r1)=2  (B,r2)=5  (A,r3)=4');
    log('  MISSING intersections: (A,r2), (B,r1), (B,r3)');
    log('  => Column "A" = [ (A,r1)=2, (A,r2)=MISSING, (A,r3)=4 ]; tracked missing cell is (A,r2) at index 1');

    // ---------------------------------------------------------------- SECTION 2
    log('\n================ SECTION 2: EMITTED MATRIX PER emptyValue VARIANT ================');
    const def = await emit({ columnField: 'Column', rowField: 'Row', valueField: 'Value' });
    const emp = await emit({ columnField: 'Column', rowField: 'Row', valueField: 'Value', emptyValue: SpecialValue.Empty });
    const nul = await emit({ columnField: 'Column', rowField: 'Row', valueField: 'Value', emptyValue: SpecialValue.Null });
    const tru = await emit({ columnField: 'Column', rowField: 'Row', valueField: 'Value', emptyValue: SpecialValue.True });
    const fal = await emit({ columnField: 'Column', rowField: 'Row', valueField: 'Value', emptyValue: SpecialValue.False });
    printFields('emptyValue: OMITTED / DEFAULT  (options {})', def);
    printFields('emptyValue: EXPLICIT SpecialValue.Empty', emp);
    printFields('emptyValue: SpecialValue.Null', nul);
    printFields('emptyValue: SpecialValue.True', tru);
    printFields('emptyValue: SpecialValue.False', fal);

    const controlColA: Field = { name: 'A', type: FieldType.number, config: {}, values: [2, 0, 4] };

    const CONDITIONS: Condition[] = [
      { label: 'omitted/default (options {})', colA: colA(def) },
      { label: 'explicit SpecialValue.Empty', colA: colA(emp) },
      { label: 'SpecialValue.Null', colA: colA(nul) },
      { label: 'SpecialValue.True', colA: colA(tru) },
      { label: 'SpecialValue.False', colA: colA(fal) },
      { label: 'NON-CANONICAL numeric-zero CONTROL [2,0,4] (no emptyValue option emits this)', colA: controlColA, isControl: true },
    ];

    // ---------------------------------------------------------------- SECTION 3
    log('\n================ SECTION 3: LOSSLESS PER-CONDITION TARGET FACTS (missing cell (A,r2)) ================');
    for (const c of CONDITIONS) {
      const cell = c.colA.values[1];
      log(`\n----- ${c.label} -----`);
      log(`  Grafana field.type = ${c.colA.type}   field.config = ${JSON.stringify(c.colA.config)}`);
      log(`  column "A" values = [ ${c.colA.values.map(show).join(', ')} ]`);
      log(`  target (A,r2): ${facts(cell)}`);
    }

    // ---------------------------------------------------------------- SECTION 4
    log('\n================ SECTION 4: CONSUMER INPUT CONFIGS (printed so every result is interpretable) ================');
    log(`  threshold steps (ThresholdsMode.Absolute) = [`);
    for (const s of STEPS) {
      log(`      { value: ${show(s.value)}, color: ${JSON.stringify(s.color)} },`);
    }
    log(`  ]`);
    const scaleCfg = consumerConfig();
    log(`  scale/display field.config = { min: ${scaleCfg.min}, max: ${scaleCfg.max}, color.mode: ${JSON.stringify(scaleCfg.color.mode)}, thresholds.mode: ${JSON.stringify(scaleCfg.thresholds.mode)} (steps as above) }`);
    const rangeField: Field = { name: 'A', type: FieldType.number, config: consumerConfig(), values: [2, 0, 4] };
    const range = getMinMaxAndDelta(rangeField);
    log(`  computed scale range via getMinMaxAndDelta(field) = { min: ${show(range.min)}, max: ${show(range.max)}, delta: ${show(range.delta)} }`);

    // ---------------------------------------------------------------- SECTION 5
    log('\n================ SECTION 5: TOTALS via reduceField / doStandardCalcs (Q3a) ================');
    for (const c of CONDITIONS) {
      const f: Field = { name: 'A', type: FieldType.number, config: {}, values: [...c.colA.values] };
      const calcs = reduceField({ field: f, reducers: [ReducerID.sum, ReducerID.mean, ReducerID.min, ReducerID.max, ReducerID.count] });
      log(`\n----- ${c.label} -----`);
      log(`  reduceField over [ ${c.colA.values.map(show).join(', ')} ]  (default nullValueMode=Ignore)`);
      log(`  sum=${show(calcs.sum)}  mean=${show(calcs.mean)}  min=${show(calcs.min)}  max=${show(calcs.max)}  count=${show(calcs.count)}`);
    }

    // ---------------------------------------------------------------- SECTION 6
    log('\n================ SECTION 6: THRESHOLDS via getActiveThreshold / getActiveThresholdForValue (Q3b) ================');
    for (const c of CONDITIONS) {
      const cell = c.colA.values[1];
      const tField: Field = { name: 'A', type: FieldType.number, config: consumerConfig(), values: [...c.colA.values] };
      const tDirect = getActiveThreshold(cell as unknown as number, STEPS);
      const tForVal = getActiveThresholdForValue(tField, cell as unknown as number, 0);
      log(`\n----- ${c.label} -----`);
      log(`  getActiveThreshold(cell, steps)          = { value: ${show(tDirect.value)}, color: ${JSON.stringify(tDirect.color)} }`);
      log(`  getActiveThresholdForValue(field, cell,0) = { value: ${show(tForVal.value)}, color: ${JSON.stringify(tForVal.color)} }`);
    }

    // ---------------------------------------------------------------- SECTION 7
    log('\n================ SECTION 7: COLOR SCALE via getScaleCalculator (Q3c) ================');
    for (const c of CONDITIONS) {
      const cell = c.colA.values[1];
      const sField: Field = { name: 'A', type: FieldType.number, config: consumerConfig(), values: [...c.colA.values] };
      const scale = getScaleCalculator(sField, theme);
      const r = scale(cell as unknown as number);
      log(`\n----- ${c.label} -----`);
      log(`  getScaleCalculator(field)(cell) => percent=${show(r.percent)}  color=${JSON.stringify(r.color)}  threshold={ value: ${show(r.threshold.value)}, color: ${JSON.stringify(r.threshold.color)} }`);
    }

    // ---------------------------------------------------------------- SECTION 8
    log('\n================ SECTION 8: DISPLAY via getDisplayProcessor + anyToNumber (Q2) ================');
    for (const c of CONDITIONS) {
      const cell = c.colA.values[1];
      const dp = getDisplayProcessor({ field: { type: FieldType.number, config: consumerConfig() }, theme });
      const d = dp(cell);
      log(`\n----- ${c.label} -----`);
      log(`  anyToNumber(cell) = ${show(anyToNumber(cell))}`);
      log(`  getDisplayProcessor(field)(cell) => text=${show(d.text)}  numeric=${show(d.numeric)}  color=${JSON.stringify(d.color)}  percent=${show(d.percent)}`);
    }

    // ---------------------------------------------------------------- SECTION 9
    log('\n================ SECTION 9: NO ZERO OPTION (Q5) ================');
    log(`  Object.values(SpecialValue) = ${JSON.stringify(Object.values(SpecialValue))}`);
    const emittedCells = [colA(def).values[1], colA(emp).values[1], colA(nul).values[1], colA(tru).values[1], colA(fal).values[1]];
    log(`  emitted missing cells across the 5 modes = [ ${emittedCells.map(show).join(', ')} ]`);
    log(`  any emitted mode strictly === 0 ? ${emittedCells.some((v) => (v as unknown) === 0)}`);

    // ---------------------------------------------------------------- SECTION 10
    log('\n================ SECTION 10: NULL CONTRAST (the one clean built-in option) ================');
    const defCalc = reduceField({ field: { name: 'A', type: FieldType.number, config: {}, values: [...colA(def).values] }, reducers: [ReducerID.sum] });
    const nulCalc = reduceField({ field: { name: 'A', type: FieldType.number, config: {}, values: [...colA(nul).values] }, reducers: [ReducerID.sum] });
    log(`  default(Empty) sum = ${show(defCalc.sum)}   vs   Null sum = ${show(nulCalc.sum)}  (Null ignored under default nullValueMode=Ignore)`);

    // ---------------------------------------------------------------- SECTION 11
    log('\n================ SECTION 11: ILLUSTRATIVE JS COERCION (NON-CANONICAL aside) ================');
    log(`  '' + 1        = ${show(('' as any) + 1)}`);
    log(`  0 + '' + 4    = ${show(0 + ('' as any) + 4)}`);
    log(`  Number('')    = ${show(Number(''))}`);
    log(`  '' == null    = ${show(('' as any) == null)}`);
    log(`  '' - 5        = ${show(('' as any) - 5)}`);
    log(`  null - 0      = ${show((null as any) - 0)}`);
    log(`  true - 0      = ${show((true as any) - 0)}`);
    log(`  false - 0     = ${show((false as any) - 0)}`);

    const outPath = process.env.INV_OUT || '/tmp/investigation_output.txt';
    fs.writeFileSync(outPath, LINES.join('\n') + '\n');

    // ===================== EXHAUSTIVE ASSERTIONS =====================
    // The test PASSES only if EVERY documented value holds. Any drift fails the run.

    // ---- Q1 emission: number-typed columns; default === explicit Empty; '' / null / true / false; never 0.
    expect(colA(def).type).toBe(FieldType.number);
    expect(colA(def).values).toEqual([2, '', 4]);
    expect(colA(emp).values).toEqual([2, '', 4]); // explicit Empty === omitted/default
    expect(def.find((f) => f.name === 'B')!.values).toEqual(['', 5, '']);
    expect(colA(nul).values).toEqual([2, null, 4]);
    expect(colA(tru).values).toEqual([2, true, 4]);
    expect(colA(fal).values).toEqual([2, false, 4]);
    expect(emittedCells.some((v) => (v as unknown) === 0)).toBe(false);
    // Q5 enum has no Zero.
    expect(Object.values(SpecialValue)).toEqual(['true', 'false', 'null', 'empty']);

    // ---- SECTION 4: scale range from the printed config.
    expect(range.min).toBe(0);
    expect(range.max).toBe(4);
    expect(range.delta).toBe(4);

    // ---- SECTION 5: totals (Q3a).
    const red = (vals: unknown[]) =>
      reduceField({
        field: { name: 'A', type: FieldType.number, config: {}, values: [...vals] },
        reducers: [ReducerID.sum, ReducerID.mean, ReducerID.min, ReducerID.max, ReducerID.count],
      });
    const cDef = red(colA(def).values);
    expect(cDef.sum).toBe('24'); // string concatenation, NOT numeric 6
    expect(cDef.mean).toBe(8);
    expect(cDef.min).toBe('');
    expect(cDef.max).toBe(4);
    expect(cDef.count).toBe(3);
    const cEmp = red(colA(emp).values);
    expect(cEmp.sum).toBe('24'); // explicit Empty identical to default
    expect(cEmp.mean).toBe(8);
    expect(cEmp.min).toBe('');
    const cNul = red(colA(nul).values);
    expect(cNul.sum).toBe(6); // clean numeric sum; null ignored
    expect(cNul.mean).toBe(3);
    expect(cNul.min).toBe(2);
    expect(cNul.count).toBe(2);
    const cTru = red(colA(tru).values);
    expect(cTru.sum).toBe(7); // true coerces to 1
    expect(cTru.mean).toBeCloseTo(2.3333333333333335, 12);
    expect(cTru.min).toBe(true);
    const cFal = red(colA(fal).values);
    expect(cFal.sum).toBe(6); // false coerces to 0
    expect(cFal.mean).toBe(2);
    expect(cFal.min).toBe(false);
    const cCtl = red(controlColA.values);
    expect(cCtl.sum).toBe(6);
    expect(cCtl.mean).toBe(2);
    expect(cCtl.min).toBe(0);

    // ---- SECTION 6: thresholds (Q3b). '' / null / false / 0 => 0-step (red); true => 1-step (blue).
    const th = (cell: unknown) => getActiveThreshold(cell as unknown as number, STEPS);
    expect(th(colA(def).values[1])).toMatchObject({ value: 0, color: 'red' });
    expect(th(colA(emp).values[1])).toMatchObject({ value: 0, color: 'red' });
    expect(th(colA(nul).values[1])).toMatchObject({ value: 0, color: 'red' });
    expect(th(colA(tru).values[1])).toMatchObject({ value: 1, color: 'blue' });
    expect(th(colA(fal).values[1])).toMatchObject({ value: 0, color: 'red' });
    expect(th(controlColA.values[1])).toMatchObject({ value: 0, color: 'red' });

    // ---- SECTION 7: color scale (Q3c). '' coerces to 0 => red; true coerces to 1 => 0.25/blue.
    const sc = (cell: unknown) =>
      getScaleCalculator({ name: 'A', type: FieldType.number, config: consumerConfig(), values: [2, 0, 4] }, theme)(
        cell as unknown as number
      );
    const sDef = sc(colA(def).values[1]);
    expect(sDef.percent).toBe(0);
    expect(sDef.color).toBe('#F2495C');
    expect(sDef.threshold).toMatchObject({ value: 0, color: 'red' });
    const sTru = sc(colA(tru).values[1]);
    expect(sTru.percent).toBe(0.25);
    expect(sTru.color).toBe('#5794F2');
    expect(sTru.threshold).toMatchObject({ value: 1, color: 'blue' });
    const sFal = sc(colA(fal).values[1]);
    expect(sFal.percent).toBe(0);
    expect(sFal.color).toBe('#F2495C');

    // ---- SECTION 8: display (Q2). '' => blank text, NaN numeric, GREEN via -Infinity fallback.
    const disp = (cell: unknown) => getDisplayProcessor({ field: { type: FieldType.number, config: consumerConfig() }, theme })(cell);
    const dDef = disp(colA(def).values[1]);
    expect(dDef.text).toBe('');
    expect(Number.isNaN(dDef.numeric)).toBe(true);
    expect(dDef.color).toBe('#73BF69'); // green (-Infinity fallback step), NOT the red 0-step of direct scale
    expect(dDef.percent).toBe(0);
    expect(anyToNumber(colA(def).values[1])).toBeNaN();
    const dTru = disp(colA(tru).values[1]);
    expect(dTru.text).toBe('true');
    expect(dTru.numeric).toBe(1);
    expect(dTru.color).toBe('#5794F2');
    expect(anyToNumber(colA(tru).values[1])).toBe(1);
    const dFal = disp(colA(fal).values[1]);
    expect(dFal.text).toBe('false');
    expect(dFal.numeric).toBe(0);
    expect(dFal.color).toBe('#F2495C');
    expect(anyToNumber(colA(fal).values[1])).toBe(0);
    // The identical '' cell: DIRECT scale is red (#F2495C) but DISPLAY fallback is green (#73BF69) => different paths.
    expect(sDef.color).not.toBe(dDef.color);

    // ---- SECTION 11: illustrative JS coercion.
    expect(('' as unknown as number) + 1).toBe('1');
    expect(0 + ('' as unknown as string) + 4).toBe('04');
    expect(Number('')).toBe(0);
    expect(('' as unknown) == null).toBe(false);
  });
});
```

### 1.3 The reproducer's own stdout — exact exit codes and determinism

The lines the script prints (its own `echo`/`sha256sum`/`wc`/`cmp` output, excluding the two runner transcripts and the `cat` of the value artifact, which are shown in §1.4/§1.5) are, verbatim:

```text
run1_exit=0
run2_exit=0
regression_exit=0
1c820bdd724f0c09631c2a8530e6dc5c9a76592d358739bd0ca47b6db6b6c7a4  /tmp/inv_run1.txt
1c820bdd724f0c09631c2a8530e6dc5c9a76592d358739bd0ca47b6db6b6c7a4  /tmp/inv_run2.txt
10658 /tmp/inv_run1.txt
10658 /tmp/inv_run2.txt
21316 total
VALUE-ARTIFACT: byte-identical
```

Both observation runs and the regression run exited `0`. The two value artifacts are **byte‑identical** (`sha256 = 1c820bdd724f0c09631c2a8530e6dc5c9a76592d358739bd0ca47b6db6b6c7a4`, `10658` bytes each). Determinism is asserted **only** on this captured value artifact — see §1.5 for why the runner transcript itself is deliberately excluded from the byte‑identity claim.

### 1.4 The captured value artifact (`cat /tmp/inv_run1.txt`, verbatim)

This is the complete, unedited value artifact — the ten `SECTION N` blocks that the rest of this document quotes. It is byte‑identical to `/tmp/inv_run2.txt` (§1.3). Every later block labeled "SECTION N" is copied verbatim from here, and each is annotated with the exact adjacent command that extracts it from this file.

```text
================ SECTION 1: SPARSE INPUT FRAME ================
  columnField=Column, rowField=Row, valueField=Value
  Row(string)=[r1,r2,r3]  Column(string)=[A,B,A]  Value(number)=[2,5,4]
  Present intersections: (A,r1)=2  (B,r2)=5  (A,r3)=4
  MISSING intersections: (A,r2), (B,r1), (B,r3)
  => Column "A" = [ (A,r1)=2, (A,r2)=MISSING, (A,r3)=4 ]; tracked missing cell is (A,r2) at index 1

================ SECTION 2: EMITTED MATRIX PER emptyValue VARIANT ================

----- emptyValue: OMITTED / DEFAULT  (options {}) -----
  field name="Row\Column" type=string config={}  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number config={}  values=[ (number) 2, (string) "", (number) 4 ]
  field name="B" type=number config={}  values=[ (string) "", (number) 5, (string) "" ]

----- emptyValue: EXPLICIT SpecialValue.Empty -----
  field name="Row\Column" type=string config={}  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number config={}  values=[ (number) 2, (string) "", (number) 4 ]
  field name="B" type=number config={}  values=[ (string) "", (number) 5, (string) "" ]

----- emptyValue: SpecialValue.Null -----
  field name="Row\Column" type=string config={}  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number config={}  values=[ (number) 2, (object) null, (number) 4 ]
  field name="B" type=number config={}  values=[ (object) null, (number) 5, (object) null ]

----- emptyValue: SpecialValue.True -----
  field name="Row\Column" type=string config={}  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number config={}  values=[ (number) 2, (boolean) true, (number) 4 ]
  field name="B" type=number config={}  values=[ (boolean) true, (number) 5, (boolean) true ]

----- emptyValue: SpecialValue.False -----
  field name="Row\Column" type=string config={}  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number config={}  values=[ (number) 2, (boolean) false, (number) 4 ]
  field name="B" type=number config={}  values=[ (boolean) false, (number) 5, (boolean) false ]

================ SECTION 3: LOSSLESS PER-CONDITION TARGET FACTS (missing cell (A,r2)) ================

----- omitted/default (options {}) -----
  Grafana field.type = number   field.config = {}
  column "A" values = [ (number) 2, (string) "", (number) 4 ]
  target (A,r2): repr=(string) ""  typeof=string  isNull=false  isUndefined=false  Number.isNaN=false  strictZero(===0)=false  Object.is(x,0)=false

----- explicit SpecialValue.Empty -----
  Grafana field.type = number   field.config = {}
  column "A" values = [ (number) 2, (string) "", (number) 4 ]
  target (A,r2): repr=(string) ""  typeof=string  isNull=false  isUndefined=false  Number.isNaN=false  strictZero(===0)=false  Object.is(x,0)=false

----- SpecialValue.Null -----
  Grafana field.type = number   field.config = {}
  column "A" values = [ (number) 2, (object) null, (number) 4 ]
  target (A,r2): repr=(object) null  typeof=object  isNull=true  isUndefined=false  Number.isNaN=false  strictZero(===0)=false  Object.is(x,0)=false

----- SpecialValue.True -----
  Grafana field.type = number   field.config = {}
  column "A" values = [ (number) 2, (boolean) true, (number) 4 ]
  target (A,r2): repr=(boolean) true  typeof=boolean  isNull=false  isUndefined=false  Number.isNaN=false  strictZero(===0)=false  Object.is(x,0)=false

----- SpecialValue.False -----
  Grafana field.type = number   field.config = {}
  column "A" values = [ (number) 2, (boolean) false, (number) 4 ]
  target (A,r2): repr=(boolean) false  typeof=boolean  isNull=false  isUndefined=false  Number.isNaN=false  strictZero(===0)=false  Object.is(x,0)=false

----- NON-CANONICAL numeric-zero CONTROL [2,0,4] (no emptyValue option emits this) -----
  Grafana field.type = number   field.config = {}
  column "A" values = [ (number) 2, (number) 0, (number) 4 ]
  target (A,r2): repr=(number) 0  typeof=number  isNull=false  isUndefined=false  Number.isNaN=false  strictZero(===0)=true  Object.is(x,0)=true

================ SECTION 4: CONSUMER INPUT CONFIGS (printed so every result is interpretable) ================
  threshold steps (ThresholdsMode.Absolute) = [
      { value: (number) -Infinity, color: "green" },
      { value: (number) 0, color: "red" },
      { value: (number) 1, color: "blue" },
      { value: (number) 10, color: "orange" },
  ]
  scale/display field.config = { min: 0, max: 4, color.mode: "thresholds", thresholds.mode: "absolute" (steps as above) }
  computed scale range via getMinMaxAndDelta(field) = { min: (number) 0, max: (number) 4, delta: (number) 4 }

================ SECTION 5: TOTALS via reduceField / doStandardCalcs (Q3a) ================

----- omitted/default (options {}) -----
  reduceField over [ (number) 2, (string) "", (number) 4 ]  (default nullValueMode=Ignore)
  sum=(string) "24"  mean=(number) 8  min=(string) ""  max=(number) 4  count=(number) 3

----- explicit SpecialValue.Empty -----
  reduceField over [ (number) 2, (string) "", (number) 4 ]  (default nullValueMode=Ignore)
  sum=(string) "24"  mean=(number) 8  min=(string) ""  max=(number) 4  count=(number) 3

----- SpecialValue.Null -----
  reduceField over [ (number) 2, (object) null, (number) 4 ]  (default nullValueMode=Ignore)
  sum=(number) 6  mean=(number) 3  min=(number) 2  max=(number) 4  count=(number) 2

----- SpecialValue.True -----
  reduceField over [ (number) 2, (boolean) true, (number) 4 ]  (default nullValueMode=Ignore)
  sum=(number) 7  mean=(number) 2.3333333333333335  min=(boolean) true  max=(number) 4  count=(number) 3

----- SpecialValue.False -----
  reduceField over [ (number) 2, (boolean) false, (number) 4 ]  (default nullValueMode=Ignore)
  sum=(number) 6  mean=(number) 2  min=(boolean) false  max=(number) 4  count=(number) 3

----- NON-CANONICAL numeric-zero CONTROL [2,0,4] (no emptyValue option emits this) -----
  reduceField over [ (number) 2, (number) 0, (number) 4 ]  (default nullValueMode=Ignore)
  sum=(number) 6  mean=(number) 2  min=(number) 0  max=(number) 4  count=(number) 3

================ SECTION 6: THRESHOLDS via getActiveThreshold / getActiveThresholdForValue (Q3b) ================

----- omitted/default (options {}) -----
  getActiveThreshold(cell, steps)          = { value: (number) 0, color: "red" }
  getActiveThresholdForValue(field, cell,0) = { value: (number) 0, color: "red" }

----- explicit SpecialValue.Empty -----
  getActiveThreshold(cell, steps)          = { value: (number) 0, color: "red" }
  getActiveThresholdForValue(field, cell,0) = { value: (number) 0, color: "red" }

----- SpecialValue.Null -----
  getActiveThreshold(cell, steps)          = { value: (number) 0, color: "red" }
  getActiveThresholdForValue(field, cell,0) = { value: (number) 0, color: "red" }

----- SpecialValue.True -----
  getActiveThreshold(cell, steps)          = { value: (number) 1, color: "blue" }
  getActiveThresholdForValue(field, cell,0) = { value: (number) 1, color: "blue" }

----- SpecialValue.False -----
  getActiveThreshold(cell, steps)          = { value: (number) 0, color: "red" }
  getActiveThresholdForValue(field, cell,0) = { value: (number) 0, color: "red" }

----- NON-CANONICAL numeric-zero CONTROL [2,0,4] (no emptyValue option emits this) -----
  getActiveThreshold(cell, steps)          = { value: (number) 0, color: "red" }
  getActiveThresholdForValue(field, cell,0) = { value: (number) 0, color: "red" }

================ SECTION 7: COLOR SCALE via getScaleCalculator (Q3c) ================

----- omitted/default (options {}) -----
  getScaleCalculator(field)(cell) => percent=(number) 0  color="#F2495C"  threshold={ value: (number) 0, color: "red" }

----- explicit SpecialValue.Empty -----
  getScaleCalculator(field)(cell) => percent=(number) 0  color="#F2495C"  threshold={ value: (number) 0, color: "red" }

----- SpecialValue.Null -----
  getScaleCalculator(field)(cell) => percent=(number) 0  color="#F2495C"  threshold={ value: (number) 0, color: "red" }

----- SpecialValue.True -----
  getScaleCalculator(field)(cell) => percent=(number) 0.25  color="#5794F2"  threshold={ value: (number) 1, color: "blue" }

----- SpecialValue.False -----
  getScaleCalculator(field)(cell) => percent=(number) 0  color="#F2495C"  threshold={ value: (number) 0, color: "red" }

----- NON-CANONICAL numeric-zero CONTROL [2,0,4] (no emptyValue option emits this) -----
  getScaleCalculator(field)(cell) => percent=(number) 0  color="#F2495C"  threshold={ value: (number) 0, color: "red" }

================ SECTION 8: DISPLAY via getDisplayProcessor + anyToNumber (Q2) ================

----- omitted/default (options {}) -----
  anyToNumber(cell) = (number) NaN
  getDisplayProcessor(field)(cell) => text=(string) ""  numeric=(number) NaN  color="#73BF69"  percent=(number) 0

----- explicit SpecialValue.Empty -----
  anyToNumber(cell) = (number) NaN
  getDisplayProcessor(field)(cell) => text=(string) ""  numeric=(number) NaN  color="#73BF69"  percent=(number) 0

----- SpecialValue.Null -----
  anyToNumber(cell) = (number) NaN
  getDisplayProcessor(field)(cell) => text=(string) ""  numeric=(number) NaN  color="#73BF69"  percent=(number) 0

----- SpecialValue.True -----
  anyToNumber(cell) = (number) 1
  getDisplayProcessor(field)(cell) => text=(string) "true"  numeric=(number) 1  color="#5794F2"  percent=(number) 0.25

----- SpecialValue.False -----
  anyToNumber(cell) = (number) 0
  getDisplayProcessor(field)(cell) => text=(string) "false"  numeric=(number) 0  color="#F2495C"  percent=(number) 0

----- NON-CANONICAL numeric-zero CONTROL [2,0,4] (no emptyValue option emits this) -----
  anyToNumber(cell) = (number) 0
  getDisplayProcessor(field)(cell) => text=(string) "0"  numeric=(number) 0  color="#F2495C"  percent=(number) 0

================ SECTION 9: NO ZERO OPTION (Q5) ================
  Object.values(SpecialValue) = ["true","false","null","empty"]
  emitted missing cells across the 5 modes = [ (string) "", (string) "", (object) null, (boolean) true, (boolean) false ]
  any emitted mode strictly === 0 ? false

================ SECTION 10: NULL CONTRAST (the one clean built-in option) ================
  default(Empty) sum = (string) "24"   vs   Null sum = (number) 6  (Null ignored under default nullValueMode=Ignore)

================ SECTION 11: ILLUSTRATIVE JS COERCION (NON-CANONICAL aside) ================
  '' + 1        = (string) "1"
  0 + '' + 4    = (string) "04"
  Number('')    = (number) 0
  '' == null    = (boolean) false
  '' - 5        = (number) -5
  null - 0      = (number) 0
  true - 0      = (number) 1
  false - 0     = (number) 0
```

### 1.5 Runner output and why it is _not_ part of the byte‑identity claim

Below is the **complete, unedited** runner transcript of observation RUN 1 (combined stdout+stderr). It is shown for completeness, but it is deliberately **excluded** from the determinism claim in §1.3: two parts of it vary run‑to‑run — the `Time:` line (wall‑clock duration) and the **order** of the six pre‑existing `jest-haste-map: duplicate manual mock found` warnings (they are emitted as the monorepo's `__mocks__` files are visited, which is not stably ordered). Those warnings are unrelated to this spec — they are pre‑existing duplicate `__mocks__` filenames under `public/` and `packages/grafana-prometheus/` that appear on every `--ci` run of this repository — and they do not affect the result. Because of that volatility, this document does **not** assert the runner transcript is byte‑reproducible; it asserts only that (a) the run **passes** with exit `0` and (b) the captured **value artifact** is byte‑identical (§1.3).

```text
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

PASS packages/grafana-data/src/transformations/transformers/groupingToMatrixMissingCell.investigation.test.ts

Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
Snapshots:   0 total
Time:        1.404 s, estimated 2 s
Ran all test suites matching /packages\/grafana-data\/src\/transformations\/transformers\/groupingToMatrixMissingCell.investigation.test.ts/i.
```

The pre‑existing colocated suite used as the regression check prints, verbatim (note `Tests: 4 passed`):

```text
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
Time:        1.448 s, estimated 2 s
Ran all test suites matching /packages\/grafana-data\/src\/transformations\/transformers\/groupingToMatrix.test.ts/i.
```

### 1.6 Clean up and confirm read‑only scope

The `trap` in §1.2 removes the temporary spec on any exit, so the source tree carries no observation artifact once the script returns. The **stable** proof that the only persistent change is this answer document is the diff against the source commit — this is independent of authoring‑time working‑tree state:

```bash
git diff --name-status 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff HEAD
# => A	blitzy/documentation/grafana_4550cfb5b728.md
```

Only `blitzy/documentation/grafana_4550cfb5b728.md` is **A**dded relative to the source commit; nothing under `packages/` or `public/` is modified. (Interpreting the working‑tree view depends on _when_ you look: while authoring, `git status --porcelain` shows this file as untracked `??` before the first commit — or as modified `M` if a prior revision already committed it — plus the temporary spec as `??` until the trap deletes it; **after** the commit the working tree is clean. The source‑commit diff above avoids that ambiguity and is the authoritative read‑only proof.) A scoped check confirms zero source edits:

```bash
git status --porcelain -- packages public
# => (empty)
```

---

## 2. Direct answers to Q1–Q5

Each answer is grounded in a specific function at a specific `file:line` and in the runtime output reproduced in §1.4 (extraction commands are shown next to each block in §3–§11).

### Q1 — What value is placed in a missing cell (empty, `null`, or `0`)?

**The empty string `''`, by default — not `null`, and never `0` — and it is placed into a `FieldType.number` column.** The missing‑cell decision is the nullish‑coalescing expression at `groupingToMatrix.ts:117`, shown here inside its complete enclosing per‑column loop (the full surrounding block, including the typed‑column push, is quoted in §4):

```ts
for (const rowName of rowValues) {
  const value = matrixValues[columnName][rowName] ?? getSpecialValue(emptyValue);
  values.push(value);
}
```

When the `column × row` pairing never occurred, `matrixValues[columnName][rowName]` is `undefined`, so the expression falls through to `getSpecialValue(emptyValue)`. The default is `SpecialValue.Empty` (`groupingToMatrix.ts:26`, applied at `groupingToMatrix.ts:71`), and `getSpecialValue` maps `Empty` (and the `default`) to `''` (`groupingToMatrix.ts:178–190`). The output column is pushed with `type: valueField.type` (`groupingToMatrix.ts:133`), so when the value field is numeric the column is `FieldType.number` yet holds `''`. **Runtime:** SECTION 2 shows column `"A"` = `type=number, config={}` with values `[ (number) 2, (string) "", (number) 4 ]`; SECTION 3 shows the tracked cell `(A,r2)` is `(string) ""` with `typeof=string`, `strictZero(===0)=false`. The **explicit** `SpecialValue.Empty` row is identical to the omitted/default row (SECTION 2), confirming `Empty` is the applied default.

### Q2 — How is the emitted value carried forward when the panel renders?

**Through `getDisplayProcessor`, the `''` renders as a _blank_ cell — and its color arrives from a fallback path, not from coercing `''` to zero.** `getDisplayProcessor` (`displayProcessor.ts:42`) assigns `numeric = anyToNumber(value)` for a non‑string‑unit field (`displayProcessor.ts:96`), and `anyToNumber('')` returns `NaN` (`anyToNumber.ts:8`, guard at `:13`). Because `numeric` is `NaN`, the entire numeric‑formatting branch `if (!Number.isNaN(numeric)) { … }` (`displayProcessor.ts:144–171`) is **skipped**, so no numeric text is produced and the **text** is left blank. The blank text and the reported color have _different_ origins — both are shown with their complete enclosing blocks in §5.4:

- **Text `""` (blank):** the numeric‑formatting branch that would have produced a number never runs (`displayProcessor.ts:144–171`); the string fall‑through leaves `text = toString('') = ''` (`displayProcessor.ts:177–186`).
- **`color` and `percent:0`:** these come **not** from coercing `''` to zero, but from the _no‑color fallback_ `if (!color) { const scaleResult = scaleFunc(-Infinity); … }` (`displayProcessor.ts:188–192`, the call at `:189`). Passing `-Infinity` makes `getScaleCalculator`'s closure keep `percent = 0` (the `value !== -Infinity` guard at `scale.ts:31` is false) and return the color of the step active at `-Infinity`. With the thresholds configured in §5 (a `-Infinity → green` step), that fallback color is **green `#73BF69`** — whereas the _direct_ `getScaleCalculator('')` call in §5.3 returns **red `#F2495C`** (the `value:0` step). **The identical `''` cell therefore yields different colors on the two paths**, which is direct proof that display's color is the `-Infinity` fallback, not `''`‑coercion. (When the field has no thresholds configured, the same fallback yields the theme's default gray instead — the point is that the color is whatever step sits at `-Infinity`, not a zero mapping.)

**Runtime:** SECTION 8 — `getDisplayProcessor(number field)('')` → `text=(string) ""  numeric=(number) NaN  color="#73BF69"  percent=(number) 0` (display), versus SECTION 7 — `getScaleCalculator(field)('')` → `color="#F2495C"` (direct scale).

### Q3 — How does the emitted value affect calculations?

**(a) Totals / reductions → string concatenation.** `reduceField` (`fieldReducer.ts:159`) delegates to `doStandardCalcs` (`fieldReducer.ts:468`). The null check `if (currentValue == null)` (`fieldReducer.ts:489`) does **not** catch `''` (because `'' == null` is `false`), and the accumulation guard `if (currentValue != null && !Number.isNaN(currentValue))` (`fieldReducer.ts:500`) **passes** for `''` (because `Number.isNaN('')` is `false`). With `calcs.sum` initialized to `0` (`defaultCalcs`, `fieldReducer.ts:446`), the statement `calcs.sum += currentValue` (`fieldReducer.ts:508`) becomes JavaScript **string concatenation**. **Runtime:** SECTION 5 — `sum` over `[2, '', 4]` = `(string) "24"` (the numeric sum would be `6`); the same section shows `mean=(number) 8` and `min=(string) ""`, further evidence the `''` entered numeric accumulation.

**(b) Threshold evaluation → coerced to numeric `0`.** `getActiveThreshold` (`thresholds.ts:7`) selects a step via `if (value >= threshold.value)` (`thresholds.ts:15`); `getActiveThresholdForValue` (`thresholds.ts:25`) forwards to it. For `''` against steps `[-Infinity(green), 0(red), 1(blue), 10(orange)]`, the `value: 0` step is chosen — **identical** to the result for numeric `0` (and, notably, `SpecialValue.True` coerces to `1` and selects the distinct `value: 1` blue step, proving the comparison is a numeric coercion). **Runtime:** SECTION 6 — both `getActiveThreshold` and `getActiveThresholdForValue` return `{ value: 0, color: "red" }` for `''`, `null`, `false`, and the `0` control, but `{ value: 1, color: "blue" }` for `true`.

**(c) Color‑scale mapping → coerced to numeric `0`.** `getScaleCalculator` (`scale.ts:19`) computes `percent = (value - info.min!) / info.delta` (`scale.ts:32`); the subtraction coerces `''` to `0`, and the `if (Number.isNaN(percent)) { percent = 0; }` guard (`scale.ts:34–36`) normalizes any `NaN`. With the printed range `{min:0, max:4, delta:4}` (SECTION 4), `''` yields `percent 0` and the red `value:0` step — **identical** to the `0` control — while `true` yields `percent 0.25` and the blue `value:1` step. **Runtime:** SECTION 7.

### Q4 — Following a concrete sparse dataset end‑to‑end, where do the semantics shift?

**The shift is not a single decision; it is the divergence among the consumers applied to the identical `''` cell.** The same emitted cell `(A, r2) = ''` — a `FieldType.number` field holding a string — travels from the sparse input (SECTION 1) → the emitted matrix (SECTION 2/3) → consumers that disagree:

| Consumer    | Function (`file:line`)                                                    | Treatment of the identical `''` cell        | Observed result                        |
| ----------- | ------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------- |
| Totals      | `reduceField`/`doStandardCalcs` (`fieldReducer.ts:159`,`468`,`508`)       | string concatenation                        | `(string) "24"`                        |
| Thresholds  | `getActiveThreshold(ForValue)` (`thresholds.ts:7`,`25`)                   | coerced to numeric `0`                      | step `{ value: 0, color: "red" }`      |
| Color scale | `getScaleCalculator` (`scale.ts:19`,`32`)                                 | coerced to numeric `0`                      | `percent 0`, `color "#F2495C"` (red)   |
| Display     | `getDisplayProcessor`+`anyToNumber` (`displayProcessor.ts:42`,`96`,`144`) | `NaN` → blank text; color via `-Infinity`   | `text "" `, `numeric NaN`, `#73BF69`   |

So the semantics "shift" _per consumer_, all downstream of a single emitted `''`. Note that display's color (`#73BF69`, green) even differs from the direct scale's color (`#F2495C`, red) for the same cell, because display reaches color through the `-Infinity` fallback while the direct scale coerces `''` to `0`. See the full per‑consumer captures in §5 and the consolidated **divergence table** in §5.5.

### Q5 — Is "missing means zero" correct, or is the dashboard making a different choice?

**"missing means zero" is FALSE.** There is no mechanism to emit `0` for a missing cell. The `SpecialValue` enum (`types/transformations.ts:113–118`) has only `True`, `False`, `Null`, and `Empty` — there is **no `Zero` member**. Runtime confirms it: `Object.values(SpecialValue) = ["true","false","null","empty"]`, and across all five emitted modes the missing cell is `['', '', null, true, false]` with **`any === 0 ? false`** (SECTION 9). The only way to get a numeric `0` in that cell is the **non‑canonical control** (`[2, 0, 4]`) constructed by hand in §5 and explicitly labeled as _not_ producible by any option. The editor's "Empty Value" dropdown exposes exactly those four options (`GroupingToMatrixTransformerEditor.tsx:61–66`), and the in‑product docs state the choices are "Null, True, False, or Empty" (`docs/content.ts:631`). The user's intuition that the dashboard "makes a different choice somewhere" is **correct and localized**: the "different choice" is the downstream **divergence** of Q4 applied to the identical default `''` cell — not a hidden zero.

---

## 3. The sparse input frame (before)

The deliberately sparse input has three columns — `Row` (string), `Column` (string), and `Value` (number) — with three present pairings and three absent ones. Grouping is configured `columnField=Column`, `rowField=Row`, `valueField=Value`.

**Command producing this block** (extracts SECTION 1 from the value artifact built by the §1.2 reproducer):

```bash
awk '/^===.*SECTION 1:/{f=1} /^===.*SECTION 2:/{f=0} f' /tmp/inv_run1.txt
```

**Output — SECTION 1 (verbatim):**

```text
================ SECTION 1: SPARSE INPUT FRAME ================
  columnField=Column, rowField=Row, valueField=Value
  Row(string)=[r1,r2,r3]  Column(string)=[A,B,A]  Value(number)=[2,5,4]
  Present intersections: (A,r1)=2  (B,r2)=5  (A,r3)=4
  MISSING intersections: (A,r2), (B,r1), (B,r3)
  => Column "A" = [ (A,r1)=2, (A,r2)=MISSING, (A,r3)=4 ]; tracked missing cell is (A,r2) at index 1
```

The unique columns are `A` and `B`; the unique rows are `r1`, `r2`, `r3`. Three of the six `column × row` intersections are **present** — `(A,r1)=2`, `(B,r2)=5`, `(A,r3)=4` — and three are **missing** — `(A,r2)`, `(B,r1)`, `(B,r3)`. Those three missing intersections are exactly the cells the transform must fill via `getSpecialValue`. The tracked cell throughout this document is `(A, r2)` (column `A`, index 1).

---

## 4. The emitted matrix — values _with field types_ — for every `emptyValue` variant (during)

The emission is governed by this loop in `groupingToMatrixTransformer` (`packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts:114–135`). Note the missing‑cell decision at `:117` and the typed‑column push at `:129–134`, which copies `config` and `type` from the _value_ field:

```ts
for (const columnName of columnValues) {
  let values = [];
  for (const rowName of rowValues) {
    const value = matrixValues[columnName][rowName] ?? getSpecialValue(emptyValue);
    values.push(value);
  }

  // setting the displayNameFromDS in prometheus overrides
  // the column name based on value fields that are numbers
  // this prevents columns that should be named 1000190
  // from becoming named {__name__: 'metricName'}
  if (supportDataplaneFallback && typeof columnName === 'number') {
    valueField.config = { ...valueField.config, displayNameFromDS: undefined };
  }

  fields.push({
    name: columnName.toString(),
    values: values,
    config: valueField.config,
    type: valueField.type,
  });
}
```

The primitive substituted for a missing cell is chosen by `getSpecialValue` (`groupingToMatrix.ts:178–190`) — note that `Empty` and the `default` both return `''`, and there is **no branch that returns `0`**:

```ts
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

The default is set at `groupingToMatrix.ts:26` (`const DEFAULT_EMPTY_VALUE = SpecialValue.Empty;`) and resolved at `groupingToMatrix.ts:71` (`const emptyValue = options.emptyValue || DEFAULT_EMPTY_VALUE;`).

**Command producing this block** (extracts SECTION 2):

```bash
awk '/^===.*SECTION 2:/{f=1} /^===.*SECTION 3:/{f=0} f' /tmp/inv_run1.txt
```

**Output — SECTION 2 (verbatim), all five emission variants** — the omitted/default case, the **explicit** `SpecialValue.Empty` (independently invoked, and identical to the default), plus `Null`, `True`, `False`:

```text
================ SECTION 2: EMITTED MATRIX PER emptyValue VARIANT ================

----- emptyValue: OMITTED / DEFAULT  (options {}) -----
  field name="Row\Column" type=string config={}  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number config={}  values=[ (number) 2, (string) "", (number) 4 ]
  field name="B" type=number config={}  values=[ (string) "", (number) 5, (string) "" ]

----- emptyValue: EXPLICIT SpecialValue.Empty -----
  field name="Row\Column" type=string config={}  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number config={}  values=[ (number) 2, (string) "", (number) 4 ]
  field name="B" type=number config={}  values=[ (string) "", (number) 5, (string) "" ]

----- emptyValue: SpecialValue.Null -----
  field name="Row\Column" type=string config={}  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number config={}  values=[ (number) 2, (object) null, (number) 4 ]
  field name="B" type=number config={}  values=[ (object) null, (number) 5, (object) null ]

----- emptyValue: SpecialValue.True -----
  field name="Row\Column" type=string config={}  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number config={}  values=[ (number) 2, (boolean) true, (number) 4 ]
  field name="B" type=number config={}  values=[ (boolean) true, (number) 5, (boolean) true ]

----- emptyValue: SpecialValue.False -----
  field name="Row\Column" type=string config={}  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number config={}  values=[ (number) 2, (boolean) false, (number) 4 ]
  field name="B" type=number config={}  values=[ (boolean) false, (number) 5, (boolean) false ]
```

Summarized — note **every** column is `type=number` with `config={}` (inherited from the value field), yet the missing cells hold non‑numeric primitives for every variant except `Null`, and never `0`:

| `emptyValue`             | Missing‑cell value (observed)           | JS `typeof` | Column `field.type` | Type match?            |
| ------------------------ | --------------------------------------- | ----------- | ------------------- | ---------------------- |
| _omitted_ (→ `Empty`)    | `""`                                    | `string`    | `number`            | **mismatch**           |
| **explicit** `Empty`     | `""` (identical to omitted)             | `string`    | `number`            | **mismatch**           |
| `Null`                   | `null`                                  | `object`    | `number`            | (null is type‑neutral) |
| `True`                   | `true`                                  | `boolean`   | `number`            | **mismatch**           |
| `False`                  | `false`                                 | `boolean`   | `number`            | **mismatch**           |
| _(no such option)_       | `0` would match, but is **unavailable** | —           | —                   | —                      |

The single fact underlying everything downstream — **a `FieldType.number` field legitimately holding the string `''`** — is confirmed cell‑by‑cell in §5.0.

---

## 5. Per‑consumer captures — the same `''` cell, four different fates (after)

This section drives the emitted missing cell of **every** condition (omitted/default, explicit `Empty`, `Null`, `True`, `False`, and the non‑canonical numeric‑zero control) through **every** exported consumer. All output is verbatim from `/tmp/inv_run1.txt` (§1.4); the adjacent command for each block extracts exactly that block from the artifact.

### 5.0 Lossless per‑condition target facts (why the value never round‑trips through a single type)

For each condition, the tracked cell `(A, r2)` is reported losslessly — its `repr` (a type‑tagged rendering that never collapses `''`, `null`, `false`, `true`, `0`, `NaN`, or `-0`), its JavaScript `typeof`, the `isNull`/`isUndefined`/`Number.isNaN` flags, a **strict‑zero** test (`=== 0`), and `Object.is(x, 0)` — alongside the Grafana `field.type` and `field.config`.

**Command producing this block** (extracts SECTION 3):

```bash
awk '/^===.*SECTION 3:/{f=1} /^===.*SECTION 4:/{f=0} f' /tmp/inv_run1.txt
```

**Output — SECTION 3 (verbatim):**

```text
================ SECTION 3: LOSSLESS PER-CONDITION TARGET FACTS (missing cell (A,r2)) ================

----- omitted/default (options {}) -----
  Grafana field.type = number   field.config = {}
  column "A" values = [ (number) 2, (string) "", (number) 4 ]
  target (A,r2): repr=(string) ""  typeof=string  isNull=false  isUndefined=false  Number.isNaN=false  strictZero(===0)=false  Object.is(x,0)=false

----- explicit SpecialValue.Empty -----
  Grafana field.type = number   field.config = {}
  column "A" values = [ (number) 2, (string) "", (number) 4 ]
  target (A,r2): repr=(string) ""  typeof=string  isNull=false  isUndefined=false  Number.isNaN=false  strictZero(===0)=false  Object.is(x,0)=false

----- SpecialValue.Null -----
  Grafana field.type = number   field.config = {}
  column "A" values = [ (number) 2, (object) null, (number) 4 ]
  target (A,r2): repr=(object) null  typeof=object  isNull=true  isUndefined=false  Number.isNaN=false  strictZero(===0)=false  Object.is(x,0)=false

----- SpecialValue.True -----
  Grafana field.type = number   field.config = {}
  column "A" values = [ (number) 2, (boolean) true, (number) 4 ]
  target (A,r2): repr=(boolean) true  typeof=boolean  isNull=false  isUndefined=false  Number.isNaN=false  strictZero(===0)=false  Object.is(x,0)=false

----- SpecialValue.False -----
  Grafana field.type = number   field.config = {}
  column "A" values = [ (number) 2, (boolean) false, (number) 4 ]
  target (A,r2): repr=(boolean) false  typeof=boolean  isNull=false  isUndefined=false  Number.isNaN=false  strictZero(===0)=false  Object.is(x,0)=false

----- NON-CANONICAL numeric-zero CONTROL [2,0,4] (no emptyValue option emits this) -----
  Grafana field.type = number   field.config = {}
  column "A" values = [ (number) 2, (number) 0, (number) 4 ]
  target (A,r2): repr=(number) 0  typeof=number  isNull=false  isUndefined=false  Number.isNaN=false  strictZero(===0)=true  Object.is(x,0)=true
```

The decisive rows: for the default/explicit‑`Empty` cell, `repr=(string) ""`, `typeof=string`, **`strictZero(===0)=false`** — a `number`‑typed field holds a `string`, and it is emphatically **not** numeric zero. Only the **non‑canonical control** row shows `typeof=number` with `strictZero(===0)=true`; no `emptyValue` option produces it.

### 5.0b Consumer input configs (printed so every downstream result is interpretable)

The threshold steps and the scale/display `field.config` used by §5.2–§5.4 are printed explicitly, together with the range that `getScaleCalculator` derives via `getMinMaxAndDelta`. Fixing `min:0, max:4` makes the color‑scale percentages deterministic and interpretable, and the four‑step threshold ladder (with a distinct `value:1` step) lets a value that coerces to `1` (boolean `true`) select a visibly different step than a value that coerces to `0`.

**Command producing this block** (extracts SECTION 4):

```bash
awk '/^===.*SECTION 4:/{f=1} /^===.*SECTION 5:/{f=0} f' /tmp/inv_run1.txt
```

**Output — SECTION 4 (verbatim):**

```text
================ SECTION 4: CONSUMER INPUT CONFIGS (printed so every result is interpretable) ================
  threshold steps (ThresholdsMode.Absolute) = [
      { value: (number) -Infinity, color: "green" },
      { value: (number) 0, color: "red" },
      { value: (number) 1, color: "blue" },
      { value: (number) 10, color: "orange" },
  ]
  scale/display field.config = { min: 0, max: 4, color.mode: "thresholds", thresholds.mode: "absolute" (steps as above) }
  computed scale range via getMinMaxAndDelta(field) = { min: (number) 0, max: (number) 4, delta: (number) 4 }
```

### 5.1 Totals — `reduceField` / `doStandardCalcs` (Q3a)

`reduceField` (`fieldReducer.ts:159`) delegates to `doStandardCalcs`, whose **complete** accumulation loop is `fieldReducer.ts:480–554`, quoted in full below (no elision). Three lines decide the `''` cell's fate: the null check `if (currentValue == null)` at `:489` does **not** catch `''` (because `'' == null` is `false`); the accumulation guard `if (currentValue != null && !Number.isNaN(currentValue))` at `:500` **passes** for `''` (because `Number.isNaN('')` is `false`); and — with `calcs.sum` seeded to `0` in `defaultCalcs` (`fieldReducer.ts:446`) — the statement `calcs.sum += currentValue` at `:508` performs JavaScript **string concatenation**:

```ts
for (let i = 0; i < data.length; i++) {
  let currentValue = data[i];

  if (i === 0) {
    calcs.first = currentValue;
  }

  calcs.last = currentValue;

  if (currentValue == null) {
    if (ignoreNulls) {
      continue;
    }
    if (nullAsZero) {
      currentValue = 0;
    }
  }

  calcs.count++;

  if (currentValue != null && !Number.isNaN(currentValue)) {
    // null || undefined || NaN
    const isFirst = calcs.firstNotNull === null;
    if (isFirst) {
      calcs.firstNotNull = currentValue;
    }

    if (isNumberField) {
      calcs.sum += currentValue;
      calcs.allIsNull = false;
      calcs.nonNullCount++;

      if (!isFirst) {
        const step = currentValue - calcs.lastNotNull!;
        if (calcs.step > step) {
          calcs.step = step; // the minimum interval
        }

        if (calcs.lastNotNull! > currentValue) {
          // counter reset
          calcs.previousDeltaUp = false;
          if (i === data.length - 1) {
            // reset on last
            calcs.delta += currentValue;
          }
        } else {
          if (calcs.previousDeltaUp) {
            calcs.delta += step; // normal increment
          } else {
            calcs.delta += currentValue; // account for counter reset
          }
          calcs.previousDeltaUp = true;
        }
      }

      if (currentValue > calcs.max) {
        calcs.max = currentValue;
      }

      if (currentValue < calcs.min) {
        calcs.min = currentValue;
      }

      if (currentValue < calcs.logmin && currentValue > 0) {
        calcs.logmin = currentValue;
      }
    }

    if (currentValue !== 0) {
      calcs.allIsZero = false;
    }

    calcs.lastNotNull = currentValue;
  }
}
```

**Command producing this block** (extracts SECTION 5):

```bash
awk '/^===.*SECTION 5:/{f=1} /^===.*SECTION 6:/{f=0} f' /tmp/inv_run1.txt
```

**Output — SECTION 5 (verbatim), all six conditions with `[sum, mean, min, max, count]`:**

```text
================ SECTION 5: TOTALS via reduceField / doStandardCalcs (Q3a) ================

----- omitted/default (options {}) -----
  reduceField over [ (number) 2, (string) "", (number) 4 ]  (default nullValueMode=Ignore)
  sum=(string) "24"  mean=(number) 8  min=(string) ""  max=(number) 4  count=(number) 3

----- explicit SpecialValue.Empty -----
  reduceField over [ (number) 2, (string) "", (number) 4 ]  (default nullValueMode=Ignore)
  sum=(string) "24"  mean=(number) 8  min=(string) ""  max=(number) 4  count=(number) 3

----- SpecialValue.Null -----
  reduceField over [ (number) 2, (object) null, (number) 4 ]  (default nullValueMode=Ignore)
  sum=(number) 6  mean=(number) 3  min=(number) 2  max=(number) 4  count=(number) 2

----- SpecialValue.True -----
  reduceField over [ (number) 2, (boolean) true, (number) 4 ]  (default nullValueMode=Ignore)
  sum=(number) 7  mean=(number) 2.3333333333333335  min=(boolean) true  max=(number) 4  count=(number) 3

----- SpecialValue.False -----
  reduceField over [ (number) 2, (boolean) false, (number) 4 ]  (default nullValueMode=Ignore)
  sum=(number) 6  mean=(number) 2  min=(boolean) false  max=(number) 4  count=(number) 3

----- NON-CANONICAL numeric-zero CONTROL [2,0,4] (no emptyValue option emits this) -----
  reduceField over [ (number) 2, (number) 0, (number) 4 ]  (default nullValueMode=Ignore)
  sum=(number) 6  mean=(number) 2  min=(number) 0  max=(number) 4  count=(number) 3
```

Reading the rows: the default/explicit‑`Empty` column `[2, '', 4]` yields `sum=(string) "24"` — not the numeric `6` — because `0 + 2 → 2` (number), then `2 + '' → "2"` (the first string flips `+` to concatenation), then `"2" + 4 → "24"`; `mean=(number) 8` (JS coerces `"24" / nonNullCount`) and `min=(string) ""` confirm the string entered numeric accumulation. In contrast, `Null` gives the **clean numeric** `sum=6, mean=3, min=2, count=2` (the `null` is ignored, so `count` drops to 2); `True` gives `sum=7` (`true` coerces to `1`); `False` and the numeric‑zero control both give `sum=6` (coerced/actual `0`). This one table _is_ the totals half of the "different choice."

### 5.2 Thresholds — `getActiveThreshold` / `getActiveThresholdForValue` (Q3b)

`getActiveThreshold` (`packages/grafana-data/src/field/thresholds.ts:7–23`) walks the steps and keeps the last step whose `value` the input meets or exceeds. The **complete** function is quoted below — including its closing brace on line 23:

```ts
export function getActiveThreshold(value: number, thresholds: Threshold[] | undefined): Threshold {
  if (!thresholds || thresholds.length === 0) {
    return fallBackThreshold;
  }

  let active = thresholds[0];

  for (const threshold of thresholds) {
    if (value >= threshold.value) {
      active = threshold;
    } else {
      break;
    }
  }

  return active;
}
```

**Command producing this block** (extracts SECTION 6):

```bash
awk '/^===.*SECTION 6:/{f=1} /^===.*SECTION 7:/{f=0} f' /tmp/inv_run1.txt
```

**Output — SECTION 6 (verbatim), all six conditions (both the low‑level and field‑aware entry points):**

```text
================ SECTION 6: THRESHOLDS via getActiveThreshold / getActiveThresholdForValue (Q3b) ================

----- omitted/default (options {}) -----
  getActiveThreshold(cell, steps)          = { value: (number) 0, color: "red" }
  getActiveThresholdForValue(field, cell,0) = { value: (number) 0, color: "red" }

----- explicit SpecialValue.Empty -----
  getActiveThreshold(cell, steps)          = { value: (number) 0, color: "red" }
  getActiveThresholdForValue(field, cell,0) = { value: (number) 0, color: "red" }

----- SpecialValue.Null -----
  getActiveThreshold(cell, steps)          = { value: (number) 0, color: "red" }
  getActiveThresholdForValue(field, cell,0) = { value: (number) 0, color: "red" }

----- SpecialValue.True -----
  getActiveThreshold(cell, steps)          = { value: (number) 1, color: "blue" }
  getActiveThresholdForValue(field, cell,0) = { value: (number) 1, color: "blue" }

----- SpecialValue.False -----
  getActiveThreshold(cell, steps)          = { value: (number) 0, color: "red" }
  getActiveThresholdForValue(field, cell,0) = { value: (number) 0, color: "red" }

----- NON-CANONICAL numeric-zero CONTROL [2,0,4] (no emptyValue option emits this) -----
  getActiveThreshold(cell, steps)          = { value: (number) 0, color: "red" }
  getActiveThresholdForValue(field, cell,0) = { value: (number) 0, color: "red" }
```

Against steps `[-Infinity→green, 0→red, 1→blue, 10→orange]`, `''` selects `{ value: 0, color: "red" }` — **identical** to numeric `0`, `null`, and `false` — because `'' >= 0` is truthy (`''` coerces to `0`) while `'' >= 1` is false. `true` selects the distinct `{ value: 1, color: "blue" }` step, proving the comparison is a numeric coercion. Both the low‑level `getActiveThreshold` and the field‑aware `getActiveThresholdForValue` agree for every row.

### 5.3 Color scale — `getScaleCalculator` (Q3c)

The **complete** `getScaleCalculator` function (`packages/grafana-data/src/field/scale.ts:19–47`) is quoted below. For a numeric field it returns the closure at `:28`; inside it the subtraction `percent = (value - info.min!) / info.delta` at `:32` coerces `''` numerically (so `'' - min` behaves like `0 - min`), the `if (Number.isNaN(percent)) { percent = 0; }` guard at `:34–36` normalizes edge cases, and the returned object (`:41–45`) carries `percent`, the active `threshold`, and the mapped `color`:

```ts
export function getScaleCalculator(field: Field, theme: GrafanaTheme2): ScaleCalculator {
  if (field.type === FieldType.boolean) {
    return getBooleanScaleCalculator(field, theme);
  }

  const mode = getFieldColorModeForField(field);
  const getColor = mode.getCalculator(field, theme);
  const info = field.state?.range ?? getMinMaxAndDelta(field);

  return (value: number) => {
    let percent = 0;

    if (value !== -Infinity) {
      percent = (value - info.min!) / info.delta;

      if (Number.isNaN(percent)) {
        percent = 0;
      }
    }

    const threshold = getActiveThresholdForValue(field, value, percent);

    return {
      percent,
      threshold,
      color: getColor(value, percent, threshold),
    };
  };
}
```

**Command producing this block** (extracts SECTION 7):

```bash
awk '/^===.*SECTION 7:/{f=1} /^===.*SECTION 8:/{f=0} f' /tmp/inv_run1.txt
```

**Output — SECTION 7 (verbatim), all six conditions:**

```text
================ SECTION 7: COLOR SCALE via getScaleCalculator (Q3c) ================

----- omitted/default (options {}) -----
  getScaleCalculator(field)(cell) => percent=(number) 0  color="#F2495C"  threshold={ value: (number) 0, color: "red" }

----- explicit SpecialValue.Empty -----
  getScaleCalculator(field)(cell) => percent=(number) 0  color="#F2495C"  threshold={ value: (number) 0, color: "red" }

----- SpecialValue.Null -----
  getScaleCalculator(field)(cell) => percent=(number) 0  color="#F2495C"  threshold={ value: (number) 0, color: "red" }

----- SpecialValue.True -----
  getScaleCalculator(field)(cell) => percent=(number) 0.25  color="#5794F2"  threshold={ value: (number) 1, color: "blue" }

----- SpecialValue.False -----
  getScaleCalculator(field)(cell) => percent=(number) 0  color="#F2495C"  threshold={ value: (number) 0, color: "red" }

----- NON-CANONICAL numeric-zero CONTROL [2,0,4] (no emptyValue option emits this) -----
  getScaleCalculator(field)(cell) => percent=(number) 0  color="#F2495C"  threshold={ value: (number) 0, color: "red" }
```

With the printed range `{min:0, max:4, delta:4}` (SECTION 4), the `''` cell produces `percent 0`, `color "#F2495C"` (the red `value:0` step) — **the same** result as the numeric‑zero control, `null`, and `false`. In color terms, the missing cell **is** treated as zero. `true` diverges: `(1 - 0) / 4 = 0.25`, selecting the blue `value:1` step (`color "#5794F2"`).

### 5.4 Display — `getDisplayProcessor` + `anyToNumber` (Q2)

`anyToNumber` (`packages/grafana-data/src/utils/anyToNumber.ts:8–22`) returns `NaN` for `''` at the guard on `:13–14` (and, notably, maps booleans to `1`/`0` at `:17–18`):

```ts
export function anyToNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }

  if (value === '' || value === null || value === undefined || Array.isArray(value)) {
    return NaN; // lodash calls them 0
  }

  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  return toNumber(value);
}
```

`getDisplayProcessor` (`displayProcessor.ts:42`) assigns `numeric = anyToNumber(value)` for a non‑string‑unit field at `displayProcessor.ts:96` (`let numeric = isStringUnit ? NaN : anyToNumber(value);`), so for `''` `numeric` is `NaN`. That `NaN` gates the **entire** numeric‑formatting branch behind `if (!Number.isNaN(numeric))` — the complete enclosing block is `displayProcessor.ts:144–171`:

```ts
if (!Number.isNaN(numeric)) {
  if (text == null && !isBoolean(value)) {
    let v: FormattedValue;

    if (canTrimTrailingDecimalZeros && adjacentDecimals != null) {
      v = formatFunc(numeric, adjacentDecimals, null, options.timeZone, showMs);

      // if no explicit decimals config, we strip trailing zeros e.g. 60.00 -> 60
      // this is needed because we may have determined the minimum determined `adjacentDecimals` for y tick increments based on
      // e.g. 'seconds' field unit (0.15s, 0.20s, 0.25s), but then formatFunc decided to return milli or nanos (150, 200, 250)
      // so we end up with excess precision: 150.00, 200.00, 250.00
      v.text = +v.text + '';
    } else {
      v = formatFunc(numeric, config.decimals, null, options.timeZone, showMs);
    }

    text = v.text;
    suffix = v.suffix;
    prefix = v.prefix;
  }

  // Return the value along with scale info
  if (color == null) {
    const scaleResult = scaleFunc(numeric);
    color = scaleResult.color;
    percent = scaleResult.percent;
  }
}
```

For `''` this whole block is **skipped**, so neither the numeric **text** nor the numeric‑value color (`scaleFunc(numeric)` at `:167`) is produced. The text is then left blank by the string fall‑through below (`text = toString('')` yields `''`, `config.noValue` unset; `displayProcessor.ts:177–186`), and the color/percent are supplied instead by the **no‑color fallback** immediately after — the complete enclosing block is `displayProcessor.ts:188–192`:

```ts
if (!color) {
  const scaleResult = scaleFunc(-Infinity);
  color = scaleResult.color;
  percent = scaleResult.percent;
}
```

Because no color was set, `scaleFunc(-Infinity)` is called at `:189`; inside `getScaleCalculator` the `value !== -Infinity` guard (`scale.ts:31`) is then **false**, so `percent` stays `0` and the returned color is the color of the step active at `-Infinity` — here the `-Infinity → green` step, `#73BF69`. Thus display's `color`/`percent:0` originate from the **`-Infinity` fallback**, **not** from coercing `''` to numeric zero — which is why they differ from the direct scale's red `#F2495C` (§5.3).

**Command producing this block** (extracts SECTION 8):

```bash
awk '/^===.*SECTION 8:/{f=1} /^===.*SECTION 9:/{f=0} f' /tmp/inv_run1.txt
```

**Output — SECTION 8 (verbatim), all six conditions (with `anyToNumber` alongside):**

```text
================ SECTION 8: DISPLAY via getDisplayProcessor + anyToNumber (Q2) ================

----- omitted/default (options {}) -----
  anyToNumber(cell) = (number) NaN
  getDisplayProcessor(field)(cell) => text=(string) ""  numeric=(number) NaN  color="#73BF69"  percent=(number) 0

----- explicit SpecialValue.Empty -----
  anyToNumber(cell) = (number) NaN
  getDisplayProcessor(field)(cell) => text=(string) ""  numeric=(number) NaN  color="#73BF69"  percent=(number) 0

----- SpecialValue.Null -----
  anyToNumber(cell) = (number) NaN
  getDisplayProcessor(field)(cell) => text=(string) ""  numeric=(number) NaN  color="#73BF69"  percent=(number) 0

----- SpecialValue.True -----
  anyToNumber(cell) = (number) 1
  getDisplayProcessor(field)(cell) => text=(string) "true"  numeric=(number) 1  color="#5794F2"  percent=(number) 0.25

----- SpecialValue.False -----
  anyToNumber(cell) = (number) 0
  getDisplayProcessor(field)(cell) => text=(string) "false"  numeric=(number) 0  color="#F2495C"  percent=(number) 0

----- NON-CANONICAL numeric-zero CONTROL [2,0,4] (no emptyValue option emits this) -----
  anyToNumber(cell) = (number) 0
  getDisplayProcessor(field)(cell) => text=(string) "0"  numeric=(number) 0  color="#F2495C"  percent=(number) 0
```

The `''` cell renders as `text=(string) ""  numeric=(number) NaN` — a **blank** cell — with `color="#73BF69"` from the `-Infinity` fallback. `true` renders `text="true"  numeric=1  color="#5794F2"` (blue) and `false`/`0` render `text="false"`/`"0"` with `numeric=0  color="#F2495C"` (red). Two distinct causes produce the `''` row: the blank **text** is the skipped numeric‑formatting block (`:144–171`), while the reported `color`/`percent` come from the `scaleFunc(-Infinity)` no‑color fallback (`:188–192`, call at `:189`) — **not** from coercing `''` to zero. Numeric‑zero coercion of `''` happens only on the _direct_ scale and threshold calls in §5.2/§5.3, which are separate code paths — and the green‑vs‑red color difference between display and direct scale on the identical `''` cell is the visible proof of that separation.

### 5.5 Divergence table — the "different choice," made explicit

The identical emitted cell `(A, r2) = ''` (a `FieldType.number` field holding a string) is treated four different ways:

| Consumer        | Function (`file:line`)                                                                     | Coercion of `''`                | Observed output for `''`               | Equals numeric `0`?    |
| --------------- | ------------------------------------------------------------------------------------------ | ------------------------------- | -------------------------------------- | ---------------------- |
| **Totals**      | `reduceField`→`doStandardCalcs` `sum +=` (`fieldReducer.ts:159`, `468`, `508`)             | none — treated as string in `+` | `(string) "24"`                        | **No** (concatenation) |
| **Thresholds**  | `getActiveThreshold(ForValue)` (`thresholds.ts:7`, `25`)                                   | numeric via `value >= step`     | `{ value: 0, color: "red" }`           | **Yes**                |
| **Color scale** | `getScaleCalculator` (`scale.ts:19`, `32`)                                                 | numeric via `value - min`       | `percent 0`, `color "#F2495C"` (red)   | **Yes**                |
| **Display**     | `getDisplayProcessor`+`anyToNumber` (`displayProcessor.ts:96`, `144`; `anyToNumber.ts:13`) | `NaN` → blank; color via `-∞`   | `text ""`, `numeric NaN`, `#73BF69`    | **No** (blank; green)  |

This table _is_ the answer to the user's "different choice somewhere": distinct coercion rules — string‑`+`, numeric‑subtraction/comparison, and `anyToNumber`→`NaN` (with a `-Infinity` color fallback) — applied to one `''` cell. The color even differs _between_ the two scale‑touching consumers (direct scale red vs. display's `-Infinity`‑fallback green) because they enter the scale with different inputs.

---

## 6. The `emptyValue: Null` contrast — the "clean" case

Switching the option to `SpecialValue.Null` emits `null` (not `''`), and `null` is handled cleanly by the reducer. In `doStandardCalcs`, `null` _is_ caught by `if (currentValue == null)` (`fieldReducer.ts:489`); with the default `nullValueMode` of `Ignore` (`reduceField`, `fieldReducer.ts:198`) it hits `if (ignoreNulls) { continue; }` (`fieldReducer.ts:490`), so it never enters the sum (and, were `nullValueMode` `AsZero`, `if (nullAsZero) { currentValue = 0; }` at `fieldReducer.ts:493` would make it a real numeric `0`).

**Command producing this block** (extracts SECTION 10):

```bash
awk '/^===.*SECTION 10:/{f=1} /^===.*SECTION 11:/{f=0} f' /tmp/inv_run1.txt
```

**Output — SECTION 10 (verbatim):**

```text
================ SECTION 10: NULL CONTRAST (the one clean built-in option) ================
  default(Empty) sum = (string) "24"   vs   Null sum = (number) 6  (Null ignored under default nullValueMode=Ignore)
```

With `null` cells the total is the **clean numeric `6`** — the correct sum of `2 + 4` with the missing cell ignored — in stark contrast to the default `Empty` path's `(string) "24"` (§5.1). This is why `Null` is the "clean" contrast: it is the only built‑in option whose missing‑cell value is _type‑neutral_ and understood by the reducer. It is still **not** `0`; it is "ignored" (or, opt‑in via `nullValueMode: AsZero`, "as zero"). The full six‑row totals table in §5.1 shows the same `Null` result (`sum=6, count=2`) alongside every other condition.

---

## 7. The "no zero option" finding (Q5)

There is no way — via API, enum, or UI — to make a missing cell numeric `0`.

**Enum (`packages/grafana-data/src/types/transformations.ts:113–118`):**

```ts
export enum SpecialValue {
  True = 'true',
  False = 'false',
  Null = 'null',
  Empty = 'empty',
}
```

**Command producing this block** (extracts SECTION 9):

```bash
awk '/^===.*SECTION 9:/{f=1} /^===.*SECTION 10:/{f=0} f' /tmp/inv_run1.txt
```

**Runtime confirmation — SECTION 9 (verbatim):**

```text
================ SECTION 9: NO ZERO OPTION (Q5) ================
  Object.values(SpecialValue) = ["true","false","null","empty"]
  emitted missing cells across the 5 modes = [ (string) "", (string) "", (object) null, (boolean) true, (boolean) false ]
  any emitted mode strictly === 0 ? false
```

The enum has exactly four members; across the five emitted modes the missing cell is `['', '', null, true, false]`, and **`any === 0 ? false`** — no mode yields numeric zero. The only zero in this entire investigation is the hand‑constructed **non‑canonical control** column, explicitly labeled as unattainable through any option.

**Editor dropdown (`public/app/features/transformers/editors/GroupingToMatrixTransformerEditor.tsx:61–66`)** — exactly four options, no zero, and (per upstream issue #100690) no free‑text entry:

```tsx
const specialValueOptions: Array<SelectableValue<SpecialValue>> = [
  { label: 'Null', value: SpecialValue.Null, description: 'Null value' },
  { label: 'True', value: SpecialValue.True, description: 'Boolean true value' },
  { label: 'False', value: SpecialValue.False, description: 'Boolean false value' },
  { label: 'Empty', value: SpecialValue.Empty, description: 'Empty string' },
];
```

**In‑product documentation (`public/app/features/transformers/docs/content.ts:631`)** states the choices verbatim: _"For the rest of the cells, you can select which value to display between: **Null**, **True**, **False**, or **Empty**."_ — and its worked example renders the missing combinations as blank cells. All three sources agree: **no `Zero`**.

---

## 8. Where the totals path actually surfaces (call paths and registration)

The `''`‑concatenation total observed in §5.1 is produced by the shared **`reduceField`** utility (`packages/grafana-data/src/transformations/fieldReducer.ts:159`). Several surfaces reach that _same_ utility, but through **distinct call paths** — it is **not** the reduce _transform_ that feeds table footers or stat‑style panels:

- **Table‑footer totals** call `reduceField` **directly** in `getFormattedValue` (`packages/grafana-ui/src/components/Table/utils.ts:395`), at `utils.ts:404` (`const fieldCalcValue = reduceField({ field, reducers: reducer })[calc];`), with `reduceField` imported at `utils.ts:21`.
- **Stat, gauge, and bar‑gauge panels** call `reduceField` **indirectly** through `getFieldDisplayValues` (`packages/grafana-data/src/field/fieldDisplay.ts:75`), which invokes `reduceField` at `fieldDisplay.ts:167` (imported at `fieldDisplay.ts:6`). Those panels call `getFieldDisplayValues` from `public/app/plugins/panel/stat/StatPanel.tsx:109`, `public/app/plugins/panel/gauge/GaugePanel.tsx:72`, and `public/app/plugins/panel/bargauge/BarGaugePanel.tsx:80`.
- **The reduce transformation** (`packages/grafana-data/src/transformations/transformers/reduce.ts`) _also_ imports the same `reduceField` at `reduce.ts:8` (`import { fieldReducers, reduceField, ReducerID } from '../fieldReducer';`), but it is a **separate data transformation** that emits reduced rows into the data frame — it is **not** the code path that renders table footers or stat‑style panels.

In short, the reduce transform, the table footer, and the stat‑style panels **share the same `reduceField` implementation** — so each inherits the `''` string‑concatenation behavior traced in §5.1 — while invoking it through **different callers**. The grouping transformer under test is itself registered for the pipeline at `packages/grafana-data/src/transformations/transformers.ts:13` (import) and `:56` (registration), which is why exercising it through `transformDataFrame` is the canonical path.

---

## 9. Determinism

Determinism is asserted on the captured **value artifact**, not on the runner transcript (which carries a wall‑clock `Time:` line and an unstably‑ordered set of pre‑existing haste‑map warnings — see §1.5). The reproducer in §1.2 writes two independent artifacts and compares them; its own stdout (§1.3) is, verbatim:

```text
run1_exit=0
run2_exit=0
regression_exit=0
1c820bdd724f0c09631c2a8530e6dc5c9a76592d358739bd0ca47b6db6b6c7a4  /tmp/inv_run1.txt
1c820bdd724f0c09631c2a8530e6dc5c9a76592d358739bd0ca47b6db6b6c7a4  /tmp/inv_run2.txt
10658 /tmp/inv_run1.txt
10658 /tmp/inv_run2.txt
21316 total
VALUE-ARTIFACT: byte-identical
```

Two runs produce a byte‑identical `10658`‑byte artifact (`sha256 = 1c820bdd724f0c09631c2a8530e6dc5c9a76592d358739bd0ca47b6db6b6c7a4`); every value quoted in §3–§11 and §5 is drawn from it. Both observation runs and the pre‑existing colocated regression suite exit `0` (`Tests: 4 passed`, §1.5). The output is stable; no run‑to‑run variation was observed in the value artifact.

---

## 10. Cause‑and‑effect, named end to end

A single walk, naming each responsible function:

1. **Emission.** `groupingToMatrixTransformer`'s operator emits the missing cell via the nullish‑coalescing `matrixValues[columnName][rowName] ?? getSpecialValue(emptyValue)` (`groupingToMatrix.ts:117`); `getSpecialValue` returns `''` for the default `Empty` (`groupingToMatrix.ts:178–190`, default set at `:26`, applied at `:71`).
2. **Typing.** That `''` is pushed into a column typed from the _value_ field — `type: valueField.type` (`groupingToMatrix.ts:133`) — so a **`FieldType.number` field ends up holding the string `''`** (confirmed losslessly in §5.0). This is the root cause.
3. **Totals.** `reduceField`→`doStandardCalcs` neither rejects `''` at the null check (`fieldReducer.ts:489`) nor at the accumulation guard (`fieldReducer.ts:500`), so `calcs.sum += ''` (`fieldReducer.ts:508`, sum seeded `0` at `:446`) **string‑concatenates** → `"24"` (§5.1).
4. **Thresholds & color.** `getActiveThreshold`/`getActiveThresholdForValue` (`thresholds.ts:15`, `:25`) and `getScaleCalculator` (`scale.ts:32`) put `''` through numeric operators (`>=`, `-`), which **coerce it to `0`**, so both behave exactly as they would for numeric `0` — the red `value:0` step and `percent 0` (§5.2/§5.3).
5. **Display.** `getDisplayProcessor` runs `anyToNumber('')` → `NaN` (`anyToNumber.ts:13`, assigned at `displayProcessor.ts:96`); the numeric‑format gate `if (!Number.isNaN(numeric))` (`displayProcessor.ts:144–171`) is skipped, so the **text** renders **blank**, and the reported `color`/`percent` come from the separate no‑color fallback `scaleFunc(-Infinity)` (`displayProcessor.ts:188–192`, call at `:189`) — the color of the `-Infinity` step (green `#73BF69` here) — **not** from coercing `''` to zero (unlike the direct color/threshold paths in step 4). That is why display's green differs from the direct scale's red for the identical cell (§5.4).

**Net:** one number‑typed field holding a non‑numeric `''`, with each consumer applying its own disagreeing coercion rule — string concat, numeric‑`0`, and blank/`-Infinity`‑fallback — which is exactly the "different choice somewhere" the user perceived.

---

## 11. Illustrative plain‑JavaScript coercion (NON‑CANONICAL aside)

> **Label:** The block below is **illustrative only** and **non‑canonical**. It is plain‑JavaScript coercion that explains _why_ the divergence happens; it is **not** produced by the Grafana code path. The authoritative results are the real‑function captures in §4–§8 (`transformDataFrame`, `reduceField`, `getActiveThreshold(ForValue)`, `getScaleCalculator`, `getDisplayProcessor`).

**Command producing this block** (extracts SECTION 11):

```bash
awk '/^===.*SECTION 11:/{f=1} f' /tmp/inv_run1.txt
```

**Output — SECTION 11 (verbatim):**

```text
================ SECTION 11: ILLUSTRATIVE JS COERCION (NON-CANONICAL aside) ================
  '' + 1        = (string) "1"
  0 + '' + 4    = (string) "04"
  Number('')    = (number) 0
  '' == null    = (boolean) false
  '' - 5        = (number) -5
  null - 0      = (number) 0
  true - 0      = (number) 1
  false - 0     = (number) 0
```

These primitives explain the observed behavior: `+` with a string concatenates (`0 + '' + 4 = "04"`, mirroring the `"24"` total), while `-`/`>=`/`Number()` coerce `''` to `0` (mirroring the color/threshold results); `'' == null` is `false` (which is why the reducer's null check does not catch `''`); and `null - 0 = 0`, `true - 0 = 1`, `false - 0 = 0` mirror the way `null`/`true`/`false` coerce numerically in the scale/threshold paths (`true` → `1` is exactly why it selects the blue `value:1` step).

---

## 12. Coverage pass

| Item                                                              | Addressed | Where                                   |
| ----------------------------------------------------------------- | --------- | --------------------------------------- |
| **Q1** emitted value (`''`, number‑typed; not `null`/`0`)         | ✅        | §2 (Q1), §4, §5.0                       |
| **Q2** carry‑forward on render (blank text; `-∞` fallback color)  | ✅        | §2 (Q2), §5.4                           |
| **Q3a** totals → string concat `"24"`                             | ✅        | §2 (Q3a), §5.1                          |
| **Q3b** thresholds → numeric `0` step                             | ✅        | §2 (Q3b), §5.2                          |
| **Q3c** color scale → numeric `0`                                 | ✅        | §2 (Q3c), §5.3                          |
| **Q4** end‑to‑end trace / divergence                              | ✅        | §2 (Q4), §5.5                           |
| **Q5** "missing means zero" is false                              | ✅        | §2 (Q5), §7                             |
| `emptyValue` variant **omitted / default**                        | ✅        | §4 (SECTION 2), §5.*                     |
| `emptyValue` variant **explicit `Empty`** (independently invoked) | ✅        | §4 (SECTION 2, distinct row), §5.*       |
| `emptyValue` variant **Null**                                     | ✅        | §4, §5.*, §6                             |
| `emptyValue` variant **True**                                     | ✅        | §4, §5.*                                 |
| `emptyValue` variant **False**                                    | ✅        | §4, §5.*                                 |
| Non‑canonical numeric‑zero **control** (labeled)                  | ✅        | §5.0–§5.4 (control row)                  |
| Consumer: totals (`sum/mean/min/max/count`)                       | ✅        | §5.1                                    |
| Consumer: thresholds (direct + field‑aware)                       | ✅        | §5.2                                    |
| Consumer: color scale                                             | ✅        | §5.3                                    |
| Consumer: display (+ `anyToNumber`)                               | ✅        | §5.4                                    |
| Every condition × every consumer (matrix)                         | ✅        | §5.1–§5.4 (six rows each)                |
| Lossless per‑condition facts (type/null/NaN/strict‑zero)          | ✅        | §5.0 (SECTION 3)                        |
| Consumer input configs printed (steps; scale min/max/delta)       | ✅        | §5.0b (SECTION 4)                       |
| `field.type` + `field.config` shown next to `''`                  | ✅        | §5.0                                    |
| `Null` "clean" contrast (total `6`)                               | ✅        | §5.1, §6                                |
| Exact exit codes (`run*_exit`, `regression_exit`)                 | ✅        | §1.3, §9                                |
| Focused pre‑existing suite as regression check                    | ✅        | §1.2, §1.5 (`Tests: 4 passed`)          |
| Determinism (≥2 byte‑identical value artifacts)                   | ✅        | §1.3, §9                                |
| Runner‑transcript volatility acknowledged (not byte‑claimed)      | ✅        | §1.5, §9                                |
| Build/runtime provenance + install prerequisite                  | ✅        | §1.1                                    |
| Safe bash (`set -euo pipefail`, `trap`, guard, exit capture)      | ✅        | §1.2                                    |
| Adjacent producing command for every output block                 | ✅        | §1.1–§1.5, §3–§11 (per‑block commands)   |
| Canonical path only (real functions)                              | ✅        | §1, §5                                  |
| Illustrative JS aside labeled non‑canonical                       | ✅        | §11                                     |
| Read‑only + temp‑spec cleanup (source‑base diff proof)            | ✅        | §1.2 (trap), §1.6                       |
| No dependency change (baseline advisories noted)                  | ✅        | §14                                     |

---

## 13. External corroboration (prior art only — secondary to the runtime observation above)

These public sources corroborate the findings but do **not** substitute for the fresh runtime observation on this commit (which is the authority for every value above):

- **Amazon Managed Grafana — transformation reference** ([docs.aws.amazon.com/grafana/latest/userguide/v10-panels-xform-functions.html](https://docs.aws.amazon.com/grafana/latest/userguide/v10-panels-xform-functions.html)). Lists the missing‑cell choices as Null, True, False, or Empty; offers no zero option — matching `docs/content.ts:631`.
- **`grafana/grafana` issue #97632** ([github.com/grafana/grafana/issues/97632](https://github.com/grafana/grafana/issues/97632)) — _"Grouping to matrix doesn't support 0 for undefined combinations"_: documents that cells are emitted empty rather than `0`, directly validating the user's "missing means zero" gap.
- **`grafana/grafana` issue #100690** ([github.com/grafana/grafana/issues/100690](https://github.com/grafana/grafana/issues/100690)) — confirms the editor's four fixed dropdowns (Column, Row, Cell Value, Empty Value) reject arbitrary custom entries, so a `0` cannot be typed in.
- **Grafana community thread 74645** ([community.grafana.com/t/transform-grouping-to-matrix-issue/74645](https://community.grafana.com/t/transform-grouping-to-matrix-issue/74645)) — reports that, with blank columns, addition performs string concatenation instead of a numeric sum — the exact `fieldReducer` behavior traced in §5.1.

---

## 14. Baseline note — dependencies unchanged (read‑only scope)

This investigation adds **no** dependency and changes **no** manifest: it only _exercises_ the already‑installed `@grafana/data` graph. The dependency manifests are byte‑identical between the source commit and HEAD, so there is provably zero dependency delta introduced by this task:

```text
# package.json + yarn.lock: source commit 4550cfb5b728 vs HEAD (identical => zero dependency change)
$ git show 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff:package.json | sha256sum
6d5ae57bf5cb5ebb5e94bee5370a4bff8aeaade663874b68dd974e138e7cbebc  -
$ git show HEAD:package.json | sha256sum
6d5ae57bf5cb5ebb5e94bee5370a4bff8aeaade663874b68dd974e138e7cbebc  -
$ git show 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff:yarn.lock | sha256sum
f2eb73c0045f97f143c4e3978d4429e546d53e951a17925dc75874f976f3e5d5  -
$ git show HEAD:yarn.lock | sha256sum
f2eb73c0045f97f143c4e3978d4429e546d53e951a17925dc75874f976f3e5d5  -
$ git diff --name-status 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff HEAD -- package.json yarn.lock '**/package.json'
(empty above => no manifest changed)
```

Any dependency‑audit advisories reported by tooling on this checkout (a baseline count of **277** pre‑existing advisories was observed by the security review) are inherited from the repository as it already stands at the source commit; they are **out of scope** for this read‑only, documentation‑only task, which introduces no manifest or lockfile change (`package.json` `sha256 6d5ae57b…` and `yarn.lock` `sha256 f2eb73c0…` are identical base‑vs‑HEAD, and the manifest diff is empty). They are noted here purely as baseline context.
