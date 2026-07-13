# "Grouping to matrix" — what a _missing_ row/column intersection actually becomes, and how that value is carried forward

**An evidence‑grounded, run‑first investigation.**

---

## 0. Context under test

| Item                            | Value                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Repository                      | `grafana/grafana`                                                                                               |
| Branch                          | `grafana_4550cfb5b728`                                                                                          |
| Commit                          | `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`                                                                      |
| Package                         | `@grafana/data`                                                                                                 |
| Canonical transform entry point | `transformDataFrame` — `packages/grafana-data/src/transformations/transformDataFrame.ts:76`                     |
| Transformer under test          | `groupingToMatrixTransformer` — `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts:33` |
| Runtime                         | Node ≥ 22 (observed `v22.23.1`; `.nvmrc` pins `v22.11.0`, `engines.node` `">= 22"`)                             |
| Test runner                     | `jest 29.7.0` (`ts-jest 29.2.5`, `typescript 5.5.4`)                                                            |

**The question.** In the "Grouping to matrix" transformation, when the input series is _sparse_ — i.e. some `column × row` intersections never occur — what value is placed in the empty cell, and how is that value carried forward when a panel renders the matrix and computes totals, thresholds, and color scales?

**User hypothesis (verbatim):** _"missing means zero."_

**User observation (verbatim):** the dashboard _"feels like it is making a different choice somewhere."_

**Short verdict.** The hypothesis is **false**. By default a missing intersection is emitted as the **empty string `''`** (never `0`), and — critically — that `''` is stored in a **`FieldType.number`‑typed** column. The user's _sense_ that a different choice is being made "somewhere" is **correct and precisely localizable**: it is not one decision but the **divergence among four downstream consumers**, each of which coerces the identical `''` cell differently — totals **string‑concatenate** it, color‑scale and thresholds **coerce it to numeric `0`**, and display renders it **blank**. Every value below was produced by running the real code on this exact commit.

---

## 1. Methodology (run‑first, canonical path, deterministic, fully reproducible)

All values in this document come from executing the **canonical** entry point `transformDataFrame` and the **real exported** field‑processing functions — never a re‑implementation of the grouping loop. A single temporary Jest spec drives a deliberately sparse `DataFrame` through the transform for **every** `emptyValue` variant, then feeds the emitted `''` cell into each downstream consumer:

- `reduceField` / `doStandardCalcs` — totals (`packages/grafana-data/src/transformations/fieldReducer.ts`)
- `getScaleCalculator` — color scale (`packages/grafana-data/src/field/scale.ts`)
- `getActiveThreshold` / `getActiveThresholdForValue` — thresholds (`packages/grafana-data/src/field/thresholds.ts`)
- `getDisplayProcessor` + `anyToNumber` — rendered cell (`packages/grafana-data/src/field/displayProcessor.ts`, `packages/grafana-data/src/utils/anyToNumber.ts`)

The spec asserts **every** value it captures (so the test _passes_ only if all documented values hold) and writes its captured lines to a file — Grafana's Jest setup fails any test that calls `console.log`, so output is written via `fs.writeFileSync` instead. This section is a complete, copy/paste‑runnable transcript: it (1) creates the temporary spec, (2) runs it twice with full runner output, (3) displays the captured values and confirms determinism, and (4) deletes the spec and proves the working tree is unchanged.

### 1.1 Create the temporary observation spec (verbatim, self‑contained)

The spec is created in the real checkout, colocated next to `groupingToMatrix.test.ts` so its relative imports resolve. Run this exact command from the repository root to recreate it byte‑for‑byte (the quoted `<<'EOF'` heredoc means the TypeScript body — including its `${…}` and back‑ticks — is written literally):

```bash
cat > packages/grafana-data/src/transformations/transformers/groupingToMatrixMissingCell.investigation.test.ts <<'EOF'
/**
 * TEMPORARY INVESTIGATION SPEC (deleted after capturing output).
 * Canonical path: transformDataFrame(groupingToMatrix) on a sparse frame for
 * every emptyValue variant, then the emitted '' cell through the real exported
 * field-processing functions (reduceField, getScaleCalculator,
 * getActiveThreshold, getDisplayProcessor). Output is written to a file to keep
 * it free of jest console-capture noise. Assertions are exhaustive: every
 * emptyValue variant, every downstream consumer, the enum, and the Null
 * contrast are verified so the test PASSES only if every documented value holds.
 */
import fs from 'fs';

import { lastValueFrom } from 'rxjs';

import { toDataFrame } from '../../dataframe/processDataFrame';
import { getDisplayProcessor } from '../../field/displayProcessor';
import { getScaleCalculator } from '../../field/scale';
import { getActiveThreshold, getActiveThresholdForValue } from '../../field/thresholds';
import { createTheme } from '../../themes/createTheme';
import { Field, FieldType } from '../../types/dataFrame';
import { ThresholdsMode } from '../../types/thresholds';
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

function show(v: unknown): string {
  if (typeof v === 'string') {
    return `(${typeof v}) ${JSON.stringify(v)}`;
  }
  return `(${typeof v}) ${String(v)}`;
}

function printFields(label: string, fields: Field[]): void {
  log(`\n----- ${label} -----`);
  for (const f of fields) {
    const vals = f.values.map((x: unknown) => show(x)).join(', ');
    log(`  field name="${f.name}" type=${f.type}  values=[ ${vals} ]`);
  }
}

async function runVariant(label: string, options: GroupingToMatrixTransformerOptions) {
  const cfg: DataTransformerConfig<GroupingToMatrixTransformerOptions> = {
    id: DataTransformerID.groupingToMatrix,
    options,
  };
  const sparse = toDataFrame({
    name: 'sparse',
    fields: [
      { name: 'Row', type: FieldType.string, values: ['r1', 'r2', 'r3'] },
      { name: 'Column', type: FieldType.string, values: ['A', 'B', 'A'] },
      { name: 'Value', type: FieldType.number, values: [2, 5, 4] },
    ],
  });
  const out = await lastValueFrom(transformDataFrame([cfg], [sparse]));
  printFields(label, out[0].fields);
  return out[0].fields;
}

describe('INVESTIGATION: Grouping to matrix missing-cell semantics', () => {
  beforeAll(() => {
    mockTransformationsRegistry([groupingToMatrixTransformer]);
  });

  it('captures emission for every emptyValue variant + downstream consumers', async () => {
    log('================ SECTION 1: SPARSE INPUT FRAME ================');
    log('  columnField=Column, rowField=Row, valueField=Value');
    log('  Row=[r1,r2,r3]  Column=[A,B,A]  Value(number)=[2,5,4]');
    log('  Present intersections: (A,r1)=2  (B,r2)=5  (A,r3)=4');
    log('  MISSING intersections: (A,r2), (B,r1), (B,r3)');

    log('\n================ SECTION 2: EMITTED MATRIX PER VARIANT ================');
    const emptyFields = await runVariant('emptyValue: DEFAULT (Empty) - options {}', {
      columnField: 'Column', rowField: 'Row', valueField: 'Value',
    });
    const nullVariantFields = await runVariant('emptyValue: SpecialValue.Null', {
      columnField: 'Column', rowField: 'Row', valueField: 'Value', emptyValue: SpecialValue.Null,
    });
    const trueVariantFields = await runVariant('emptyValue: SpecialValue.True', {
      columnField: 'Column', rowField: 'Row', valueField: 'Value', emptyValue: SpecialValue.True,
    });
    const falseVariantFields = await runVariant('emptyValue: SpecialValue.False', {
      columnField: 'Column', rowField: 'Row', valueField: 'Value', emptyValue: SpecialValue.False,
    });

    const colA = emptyFields.find((f) => f.name === 'A')!;
    const emittedEmptyCell = colA.values[1];
    log('\n================ SECTION 3: THE OFFENDING CELL ================');
    log(`  Default column "A": type=${colA.type}  values=[ ${colA.values.map(show).join(', ')} ]`);
    log(`  Emitted missing cell (A,r2) = ${show(emittedEmptyCell)}   <-- number-typed field holds a string`);

    log('\n================ SECTION 4: TOTALS via reduceField (Q3a) ================');
    const totalField: Field = { name: 'A', type: FieldType.number, config: {}, values: [...colA.values] };
    const calcs = reduceField({ field: totalField, reducers: [ReducerID.sum] });
    log(`  reduceField({reducers:[sum]}) over number field [2,'',4]`);
    log(`  => sum = ${show(calcs.sum)}   (numeric sum would be 6)`);

    log('\n================ SECTION 5: COLOR SCALE via getScaleCalculator (Q3c) ================');
    const scaleField: Field = { name: 'A', type: FieldType.number, config: {}, values: [...colA.values] };
    const scale = getScaleCalculator(scaleField, theme);
    const scaleResultEmpty = scale(emittedEmptyCell as unknown as number);
    const scaleResultZero = scale(0);
    log(`  getScaleCalculator(field)(''):  ${JSON.stringify(scaleResultEmpty)}`);
    log(`  getScaleCalculator(field)(0):   ${JSON.stringify(scaleResultZero)}`);

    log('\n================ SECTION 6: THRESHOLDS via getActiveThreshold (Q3b) ================');
    const steps = [
      { value: -Infinity, color: 'green' },
      { value: 0, color: 'red' },
      { value: 10, color: 'orange' },
    ];
    const tEmpty = getActiveThreshold(emittedEmptyCell as unknown as number, steps);
    const tZero = getActiveThreshold(0, steps);
    log(`  getActiveThreshold('', steps): ${JSON.stringify(tEmpty)}`);
    log(`  getActiveThreshold(0, steps):  ${JSON.stringify(tZero)}`);
    const threshField: Field = {
      name: 'A', type: FieldType.number,
      config: { thresholds: { mode: ThresholdsMode.Absolute, steps } },
      values: [...colA.values],
    };
    const tForVal = getActiveThresholdForValue(threshField, emittedEmptyCell as unknown as number, 0);
    log(`  getActiveThresholdForValue(field, '', 0): ${JSON.stringify(tForVal)}`);

    log('\n================ SECTION 7: DISPLAY via getDisplayProcessor (Q2) ================');
    const dp = getDisplayProcessor({ field: { type: FieldType.number, config: {} }, theme });
    const dEmpty = dp(emittedEmptyCell);
    const dNum = dp(4);
    log(`  anyToNumber('') = ${show(anyToNumber(''))}`);
    log(`  getDisplayProcessor(number field)(''): ${JSON.stringify(dEmpty)}`);
    log(`  getDisplayProcessor(number field)(4):  ${JSON.stringify(dNum)}`);

    log('\n================ SECTION 8: NULL CONTRAST - totals (clean case) ================');
    const nullFields = await runVariant('emptyValue: SpecialValue.Null (for downstream)', {
      columnField: 'Column', rowField: 'Row', valueField: 'Value', emptyValue: SpecialValue.Null,
    });
    const colANull = nullFields.find((f) => f.name === 'A')!;
    const nullTotalField: Field = { name: 'A', type: FieldType.number, config: {}, values: [...colANull.values] };
    const nullCalcs = reduceField({ field: nullTotalField, reducers: [ReducerID.sum] });
    log(`  Null column "A": values=[ ${colANull.values.map(show).join(', ')} ]`);
    log(`  reduceField sum over [2,null,4] (default nullValueMode=Ignore) => ${show(nullCalcs.sum)}`);

    log('\n================ SECTION 9: NO ZERO OPTION (Q5) ================');
    log(`  Object.values(SpecialValue) = ${JSON.stringify(Object.values(SpecialValue))}`);

    log('\n================ SECTION 10: ILLUSTRATIVE JS COERCION (non-canonical aside) ================');
    log(`  '' + 1        = ${show(('' as any) + 1)}`);
    log(`  0 + '' + 4    = ${show(0 + ('' as any) + 4)}`);
    log(`  Number('')    = ${show(Number(''))}`);
    log(`  '' == null    = ${show(('' as any) == null)}`);
    log(`  '' - 5        = ${show(('' as any) - 5)}`);

    const outPath = process.env.INV_OUT || '/tmp/investigation_output.txt';
    fs.writeFileSync(outPath, LINES.join('\n') + '\n');

    // ---- EXHAUSTIVE ASSERTIONS: every variant, consumer, enum, and the Null contrast ----
    // Q1 emission (default Empty): number-typed column holds the string ''
    expect(colA.type).toBe(FieldType.number);
    expect(emittedEmptyCell).toBe('');
    expect(emptyFields.find((f) => f.name === 'B')!.values).toEqual(['', 5, '']);
    // emptyValue variant Null
    expect(nullVariantFields.find((f) => f.name === 'A')!.values).toEqual([2, null, 4]);
    expect(nullVariantFields.find((f) => f.name === 'B')!.values).toEqual([null, 5, null]);
    // emptyValue variant True
    expect(trueVariantFields.find((f) => f.name === 'A')!.values).toEqual([2, true, 4]);
    expect(trueVariantFields.find((f) => f.name === 'B')!.values).toEqual([true, 5, true]);
    // emptyValue variant False
    expect(falseVariantFields.find((f) => f.name === 'A')!.values).toEqual([2, false, 4]);
    expect(falseVariantFields.find((f) => f.name === 'B')!.values).toEqual([false, 5, false]);
    // Q3a totals: '' string-concatenates -> "24" (not numeric 6)
    expect(calcs.sum).toBe('24');
    // Q3c color scale: '' equals numeric 0
    expect(scaleResultEmpty).toEqual(scaleResultZero);
    expect(scaleResultEmpty.percent).toBe(0);
    expect(scaleResultEmpty.color).toBe('#808080');
    // Q3b thresholds: '' selects the value:0 step, same as numeric 0 (direct + field-aware)
    expect(tEmpty).toEqual({ value: 0, color: 'red' });
    expect(tZero).toEqual({ value: 0, color: 'red' });
    expect(tForVal).toEqual({ value: 0, color: 'red' });
    // Q2 display: blank text; numeric is NaN (serialized as null); anyToNumber('')=NaN
    expect(anyToNumber('')).toBeNaN();
    expect(dEmpty.text).toBe('');
    expect(Number.isNaN(dEmpty.numeric as number)).toBe(true);
    expect(dNum.text).toBe('4');
    // Q5 no-zero: enum members are exactly these four
    expect(Object.values(SpecialValue)).toEqual(['true', 'false', 'null', 'empty']);
    // Null contrast: clean numeric total 6
    expect(nullCalcs.sum).toBe(6);
  });
});
EOF
```

### 1.2 Run it twice, non‑interactively, capturing the complete runner output

The repository root `test` script is watch mode, so the runner is invoked directly with `--watchAll=false --ci`:

```bash
# from the repository root — RUN 1
CI=true INV_OUT=/tmp/inv_run1.txt node_modules/.bin/jest --config jest.config.js --watchAll=false --ci --no-cache \
  packages/grafana-data/src/transformations/transformers/groupingToMatrixMissingCell.investigation.test.ts

# RUN 2 (identical invocation, second output file)
CI=true INV_OUT=/tmp/inv_run2.txt node_modules/.bin/jest --config jest.config.js --watchAll=false --ci --no-cache \
  packages/grafana-data/src/transformations/transformers/groupingToMatrixMissingCell.investigation.test.ts
```

**Complete, unedited runner output — RUN 1** (combined stdout+stderr):

```
jest-haste-map: duplicate manual mock found: store.navIndex.mock
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/features/connections/__mocks__/store.navIndex.mock.ts
    * <rootDir>/public/app/features/datasources/__mocks__/store.navIndex.mock.ts

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

jest-haste-map: duplicate manual mock found: index
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/features/datasources/__mocks__/index.ts
    * <rootDir>/public/app/features/plugins/admin/__mocks__/index.ts

jest-haste-map: duplicate manual mock found: datasource
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/plugins/datasource/loki/__mocks__/datasource.ts
    * <rootDir>/packages/grafana-prometheus/src/test/__mocks__/datasource.ts

PASS packages/grafana-data/src/transformations/transformers/groupingToMatrixMissingCell.investigation.test.ts

Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
Snapshots:   0 total
Time:        3.383 s
Ran all test suites matching /packages\/grafana-data\/src\/transformations\/transformers\/groupingToMatrixMissingCell.investigation.test.ts/i.
```

**Complete, unedited runner output — RUN 2** (identical to RUN 1 except the `Time:` line):

```
jest-haste-map: duplicate manual mock found: store.navIndex.mock
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/features/connections/__mocks__/store.navIndex.mock.ts
    * <rootDir>/public/app/features/datasources/__mocks__/store.navIndex.mock.ts

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

jest-haste-map: duplicate manual mock found: index
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/features/datasources/__mocks__/index.ts
    * <rootDir>/public/app/features/plugins/admin/__mocks__/index.ts

jest-haste-map: duplicate manual mock found: datasource
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/plugins/datasource/loki/__mocks__/datasource.ts
    * <rootDir>/packages/grafana-prometheus/src/test/__mocks__/datasource.ts

PASS packages/grafana-data/src/transformations/transformers/groupingToMatrixMissingCell.investigation.test.ts

Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
Snapshots:   0 total
Time:        4.545 s
Ran all test suites matching /packages\/grafana-data\/src\/transformations\/transformers\/groupingToMatrixMissingCell.investigation.test.ts/i.
```

> The six `jest-haste-map: duplicate manual mock found` lines are **pre‑existing repository warnings** (duplicate `__mocks__` filenames under `public/` and `packages/grafana-prometheus/`) that appear on every `--no-cache` run of this monorepo; they are unrelated to this spec and do not affect its result. They are reproduced here so the runner output is complete and unedited. The only run‑to‑run difference is the `Time:` line.

### 1.3 Display the captured values and confirm determinism

```bash
cat /tmp/inv_run1.txt
diff /tmp/inv_run1.txt /tmp/inv_run2.txt && echo "IDENTICAL"
wc -c /tmp/inv_run1.txt /tmp/inv_run2.txt
sha256sum /tmp/inv_run1.txt /tmp/inv_run2.txt
```

`cat /tmp/inv_run1.txt` prints the complete captured output (the ten `SECTION N` blocks below are the verbatim, unedited contents of this file, byte‑identical to `/tmp/inv_run2.txt`):

```
================ SECTION 1: SPARSE INPUT FRAME ================
  columnField=Column, rowField=Row, valueField=Value
  Row=[r1,r2,r3]  Column=[A,B,A]  Value(number)=[2,5,4]
  Present intersections: (A,r1)=2  (B,r2)=5  (A,r3)=4
  MISSING intersections: (A,r2), (B,r1), (B,r3)

================ SECTION 2: EMITTED MATRIX PER VARIANT ================

----- emptyValue: DEFAULT (Empty) - options {} -----
  field name="Row\Column" type=string  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number  values=[ (number) 2, (string) "", (number) 4 ]
  field name="B" type=number  values=[ (string) "", (number) 5, (string) "" ]

----- emptyValue: SpecialValue.Null -----
  field name="Row\Column" type=string  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number  values=[ (number) 2, (object) null, (number) 4 ]
  field name="B" type=number  values=[ (object) null, (number) 5, (object) null ]

----- emptyValue: SpecialValue.True -----
  field name="Row\Column" type=string  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number  values=[ (number) 2, (boolean) true, (number) 4 ]
  field name="B" type=number  values=[ (boolean) true, (number) 5, (boolean) true ]

----- emptyValue: SpecialValue.False -----
  field name="Row\Column" type=string  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number  values=[ (number) 2, (boolean) false, (number) 4 ]
  field name="B" type=number  values=[ (boolean) false, (number) 5, (boolean) false ]

================ SECTION 3: THE OFFENDING CELL ================
  Default column "A": type=number  values=[ (number) 2, (string) "", (number) 4 ]
  Emitted missing cell (A,r2) = (string) ""   <-- number-typed field holds a string

================ SECTION 4: TOTALS via reduceField (Q3a) ================
  reduceField({reducers:[sum]}) over number field [2,'',4]
  => sum = (string) "24"   (numeric sum would be 6)

================ SECTION 5: COLOR SCALE via getScaleCalculator (Q3c) ================
  getScaleCalculator(field)(''):  {"percent":0,"threshold":{"value":0,"color":"#808080"},"color":"#808080"}
  getScaleCalculator(field)(0):   {"percent":0,"threshold":{"value":0,"color":"#808080"},"color":"#808080"}

================ SECTION 6: THRESHOLDS via getActiveThreshold (Q3b) ================
  getActiveThreshold('', steps): {"value":0,"color":"red"}
  getActiveThreshold(0, steps):  {"value":0,"color":"red"}
  getActiveThresholdForValue(field, '', 0): {"value":0,"color":"red"}

================ SECTION 7: DISPLAY via getDisplayProcessor (Q2) ================
  anyToNumber('') = (number) NaN
  getDisplayProcessor(number field)(''): {"text":"","numeric":null,"color":"#808080","percent":0}
  getDisplayProcessor(number field)(4):  {"text":"4","numeric":4,"color":"#808080","percent":0.04}

================ SECTION 8: NULL CONTRAST - totals (clean case) ================

----- emptyValue: SpecialValue.Null (for downstream) -----
  field name="Row\Column" type=string  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number  values=[ (number) 2, (object) null, (number) 4 ]
  field name="B" type=number  values=[ (object) null, (number) 5, (object) null ]
  Null column "A": values=[ (number) 2, (object) null, (number) 4 ]
  reduceField sum over [2,null,4] (default nullValueMode=Ignore) => (number) 6

================ SECTION 9: NO ZERO OPTION (Q5) ================
  Object.values(SpecialValue) = ["true","false","null","empty"]

================ SECTION 10: ILLUSTRATIVE JS COERCION (non-canonical aside) ================
  '' + 1        = (string) "1"
  0 + '' + 4    = (string) "04"
  Number('')    = (number) 0
  '' == null    = (boolean) false
  '' - 5        = (number) -5
```

The determinism commands print (see §9 for the interpretation):

```
IDENTICAL
3786 /tmp/inv_run1.txt
3786 /tmp/inv_run2.txt
7572 total
f51ef19683534a967b79febea4c59fa5ec4c7eaf998f32ebfac08a63cd28cc6e  /tmp/inv_run1.txt
f51ef19683534a967b79febea4c59fa5ec4c7eaf998f32ebfac08a63cd28cc6e  /tmp/inv_run2.txt
```

Every `SECTION N` block quoted next to a claim in §3–§10 is copied verbatim from this same output.

### 1.4 Clean up (mandatory) and confirm read‑only scope

The temporary spec and the two `/tmp` capture files are deleted; then `git status` proves the working tree carries no source change:

```bash
rm -f packages/grafana-data/src/transformations/transformers/groupingToMatrixMissingCell.investigation.test.ts
rm -f /tmp/inv_run1.txt /tmp/inv_run2.txt

# The only working-tree change is this answer document:
git status --porcelain
# =>  M blitzy/documentation/grafana_4550cfb5b728.md

# Scoped to the source trees — zero modifications (prints nothing):
git status --porcelain -- packages public
# => (empty)
```

> **Read‑only note.** The investigation spec is a _temporary_ observation artifact: it is created solely to drive the canonical path and is deleted after capture, so it is never committed. The **only** persistent change in the repository is this answer document — it is the single entry in `git status --porcelain` (shown as `M` here because a prior delivery already committed this file and this revision edits that same file; on a fresh checkout it would appear as `?? blitzy/documentation/grafana_4550cfb5b728.md`). The scoped `git status --porcelain -- packages public` prints nothing, proving no existing source, test, or configuration file under `packages/` or `public/` was modified. After the final commit the working tree is fully clean.

---

## 2. Direct answers to Q1–Q5

Each answer is grounded in a specific function at a specific `file:line` and in the runtime output reproduced later in this document.

### Q1 — What value is placed in a missing cell (empty, `null`, or `0`)?

**The empty string `''`, by default — not `null`, and never `0` — and it is placed into a `FieldType.number` column.** The missing‑cell decision is the nullish‑coalescing expression at `groupingToMatrix.ts:117`, shown here inside its complete enclosing per‑column loop (the full surrounding block, including the typed‑column push, is quoted in §4):

```ts
for (const rowName of rowValues) {
  const value = matrixValues[columnName][rowName] ?? getSpecialValue(emptyValue);
  values.push(value);
}
```

When the `column × row` pairing never occurred, `matrixValues[columnName][rowName]` is `undefined`, so the expression falls through to `getSpecialValue(emptyValue)`. The default is `SpecialValue.Empty` (`groupingToMatrix.ts:26`, applied at `groupingToMatrix.ts:71`), and `getSpecialValue` maps `Empty` (and the `default`) to `''` (`groupingToMatrix.ts:178–190`). The output column is pushed with `type: valueField.type` (`groupingToMatrix.ts:133`), so when the value field is numeric the column is `FieldType.number` yet holds `''`. **Runtime:** SECTION 2 / SECTION 3 (§4/§5 below) — column `"A"` is `type=number` with values `[ (number) 2, (string) "", (number) 4 ]`.

### Q2 — How is the emitted value carried forward when the panel renders?

**Through `getDisplayProcessor`, the `''` renders as a _blank_ cell.** `getDisplayProcessor` (`displayProcessor.ts:42`) assigns `numeric = anyToNumber(value)` for a non‑string‑unit field (`displayProcessor.ts:96`), and `anyToNumber('')` returns `NaN` (`anyToNumber.ts:8`, guard at `:13`). Because `numeric` is `NaN`, the entire numeric‑formatting branch `if (!Number.isNaN(numeric)) { … }` (`displayProcessor.ts:144–171`) is **skipped**, so no numeric text is produced and the **text** is left blank. The blank text and the reported color have _different_ origins — both are shown with their complete enclosing blocks in §5.4:

- **Text `""` (blank):** the numeric‑formatting branch that would have produced a number never runs.
- **`color:"#808080"` and `percent:0`:** these come **not** from coercing `''` to zero, but from the _no‑color fallback_ `if (!color) { const scaleResult = scaleFunc(-Infinity); … }` (`displayProcessor.ts:188–192`, the call at `:189`). Passing `-Infinity` makes `getScaleCalculator`'s closure keep `percent = 0` (the `value !== -Infinity` guard at `scale.ts:31` is false) and return the percent‑`0` color — the theme's default gray. This is a _distinct_ path from the direct `getScaleCalculator('')` call in §5.2, where `''` is numerically coerced in the subtraction.

**Runtime:** SECTION 7 — `getDisplayProcessor(number field)('')` → `{"text":"","numeric":null,"color":"#808080","percent":0}` (the `numeric` field is JavaScript `NaN`, which `JSON.stringify` serializes as `null`).

### Q3 — How does the emitted value affect calculations?

**(a) Totals / reductions → string concatenation.** `reduceField` (`fieldReducer.ts:159`) delegates to `doStandardCalcs` (`fieldReducer.ts:468`). The null check `if (currentValue == null)` (`fieldReducer.ts:489`) does **not** catch `''` (because `'' == null` is `false`), and the accumulation guard `if (currentValue != null && !Number.isNaN(currentValue))` (`fieldReducer.ts:500`) **passes** for `''` (because `Number.isNaN('')` is `false`). With `calcs.sum` initialized to `0` (`defaultCalcs`, `fieldReducer.ts:446`), the statement `calcs.sum += currentValue` (`fieldReducer.ts:508`) becomes JavaScript **string concatenation**. **Runtime:** SECTION 4 — sum over `[2, '', 4]` = `(string) "24"` (the numeric sum would be `6`).

**(b) Threshold evaluation → coerced to numeric `0`.** `getActiveThreshold` (`thresholds.ts:7`) selects a step via `if (value >= threshold.value)` (`thresholds.ts:15`); `getActiveThresholdForValue` (`thresholds.ts:25`) forwards to it. For `''` against steps `[-Infinity(green), 0(red), 10(orange)]`, the `value: 0` step is chosen — **identical** to the result for numeric `0`. **Runtime:** SECTION 6 — both `getActiveThreshold('', steps)` and `getActiveThreshold(0, steps)` → `{"value":0,"color":"red"}`.

**(c) Color‑scale mapping → coerced to numeric `0`.** `getScaleCalculator` (`scale.ts:19`) computes `percent = (value - info.min!) / info.delta` (`scale.ts:32`); the subtraction coerces `''` to `0`, and the `if (Number.isNaN(percent)) { percent = 0; }` guard (`scale.ts:34–36`) normalizes any `NaN`. The result for `''` is **identical** to the result for `0`. **Runtime:** SECTION 5 — both `getScaleCalculator(field)('')` and `getScaleCalculator(field)(0)` → `{"percent":0,"threshold":{"value":0,"color":"#808080"},"color":"#808080"}`.

### Q4 — Following a concrete sparse dataset end‑to‑end, where do the semantics shift?

**The shift is not a single decision; it is the divergence among the four consumers applied to the identical `''` cell.** The same emitted cell `(A, r2) = ''` — a `FieldType.number` field holding a string — travels from the sparse input (SECTION 1) → the emitted matrix (SECTION 2/3) → four consumers that disagree:

| Consumer    | Function (`file:line`)                                                    | Treatment of the identical `''` cell | Observed result                  |
| ----------- | ------------------------------------------------------------------------- | ------------------------------------ | -------------------------------- |
| Totals      | `reduceField`/`doStandardCalcs` (`fieldReducer.ts:159`,`468`,`508`)       | string concatenation                 | `(string) "24"`                  |
| Color scale | `getScaleCalculator` (`scale.ts:19`,`32`)                                 | coerced to numeric `0`               | `percent 0`, `color "#808080"`   |
| Thresholds  | `getActiveThreshold(ForValue)` (`thresholds.ts:7`,`25`)                   | coerced to numeric `0`               | step `{"value":0,"color":"red"}` |
| Display     | `getDisplayProcessor`+`anyToNumber` (`displayProcessor.ts:42`,`96`,`144`) | `NaN` → blank                        | `{"text":"","numeric":null,...}` |

So the semantics "shift" _per consumer_, all downstream of a single emitted `''`. See the full per‑consumer captures in §5 and the consolidated **divergence table** there.

### Q5 — Is "missing means zero" correct, or is the dashboard making a different choice?

**"missing means zero" is FALSE.** There is no mechanism to emit `0` for a missing cell. The `SpecialValue` enum (`types/transformations.ts:113–118`) has only `True`, `False`, `Null`, and `Empty` — there is **no `Zero` member**. Runtime confirms it: `Object.values(SpecialValue) = ["true","false","null","empty"]` (SECTION 9). The editor's "Empty Value" dropdown exposes exactly those four options (`GroupingToMatrixTransformerEditor.tsx:61–66`), and the in‑product docs state the choices are "Null, True, False, or Empty" (`docs/content.ts:631`). The user's intuition that the dashboard "makes a different choice somewhere" is **correct and localized**: the "different choice" is the downstream **divergence** of Q4 applied to the identical default `''` cell — not a hidden zero.

---

## 3. The sparse input frame

The deliberately sparse input has three columns — `Row` (string), `Column` (string), and `Value` (number) — with three present pairings and three absent ones. Grouping is configured `columnField=Column`, `rowField=Row`, `valueField=Value`.

**Command:** the single Jest invocation from §1 (this one command produces every `SECTION N` block in this document).

**Output — SECTION 1 (verbatim from `/tmp/inv_run1.txt`):**

```
================ SECTION 1: SPARSE INPUT FRAME ================
  columnField=Column, rowField=Row, valueField=Value
  Row=[r1,r2,r3]  Column=[A,B,A]  Value(number)=[2,5,4]
  Present intersections: (A,r1)=2  (B,r2)=5  (A,r3)=4
  MISSING intersections: (A,r2), (B,r1), (B,r3)
```

The unique columns are `A` and `B`; the unique rows are `r1`, `r2`, `r3`. Three of the six `column × row` intersections are **present** — `(A,r1)=2`, `(B,r2)=5`, `(A,r3)=4` — and three are **missing** — `(A,r2)`, `(B,r1)`, `(B,r3)`. Those three missing intersections are exactly the cells the transform must fill via `getSpecialValue`.

---

## 4. The emitted matrix — values _with field types_ — for every `emptyValue` variant

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

**Command:** the single Jest invocation from §1.

**Output — SECTION 2 (verbatim), all four variants:**

```
================ SECTION 2: EMITTED MATRIX PER VARIANT ================

----- emptyValue: DEFAULT (Empty) - options {} -----
  field name="Row\Column" type=string  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number  values=[ (number) 2, (string) "", (number) 4 ]
  field name="B" type=number  values=[ (string) "", (number) 5, (string) "" ]

----- emptyValue: SpecialValue.Null -----
  field name="Row\Column" type=string  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number  values=[ (number) 2, (object) null, (number) 4 ]
  field name="B" type=number  values=[ (object) null, (number) 5, (object) null ]

----- emptyValue: SpecialValue.True -----
  field name="Row\Column" type=string  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number  values=[ (number) 2, (boolean) true, (number) 4 ]
  field name="B" type=number  values=[ (boolean) true, (number) 5, (boolean) true ]

----- emptyValue: SpecialValue.False -----
  field name="Row\Column" type=string  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number  values=[ (number) 2, (boolean) false, (number) 4 ]
  field name="B" type=number  values=[ (boolean) false, (number) 5, (boolean) false ]
```

Summarized — note **every** column is `type=number`, yet the missing cells hold non‑numeric primitives for every variant except `Null`:

| `emptyValue`       | Missing‑cell value (observed)           | JS `typeof` | Column `field.type` | Type match?            |
| ------------------ | --------------------------------------- | ----------- | ------------------- | ---------------------- |
| `Empty` (default)  | `""`                                    | `string`    | `number`            | **mismatch**           |
| `Null`             | `null`                                  | `object`    | `number`            | (null is type‑neutral) |
| `True`             | `true`                                  | `boolean`   | `number`            | **mismatch**           |
| `False`            | `false`                                 | `boolean`   | `number`            | **mismatch**           |
| _(no such option)_ | `0` would match, but is **unavailable** | —           | —                   | —                      |

**The crux (SECTION 3, verbatim):**

```
================ SECTION 3: THE OFFENDING CELL ================
  Default column "A": type=number  values=[ (number) 2, (string) "", (number) 4 ]
  Emitted missing cell (A,r2) = (string) ""   <-- number-typed field holds a string
```

The offending cell `(A, r2)` is `(string) ""` living inside a field whose `type` is `number`. This single fact — **a `FieldType.number` field legitimately holding the string `''`** — is the root cause of everything downstream. The type mismatch persists for `True`/`False` as well; only `Null` avoids a _typed_ primitive (though it is still not `0`).

---

## 5. Per‑consumer captures — the same `''` cell, four different fates

Each capture below feeds the **same** emitted default cell (`''` from column `A`) into a real exported function. All output is verbatim from `/tmp/inv_run1.txt`; all were produced by the single Jest command in §1.

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

**Output — SECTION 4 (verbatim):**

```
================ SECTION 4: TOTALS via reduceField (Q3a) ================
  reduceField({reducers:[sum]}) over number field [2,'',4]
  => sum = (string) "24"   (numeric sum would be 6)
```

The total is `(string) "24"`, not the numeric `6`. For this specific column the accumulation is `0 + 2 → 2` (number), then `2 + '' → "2"` (the first string flips the operator to concatenation), then `"2" + 4 → "24"`. The result is therefore **order‑dependent** for this frame: the concatenated digits are the surviving numeric values in field order with the empty cell contributing nothing visible, yielding the misleading `"24"`.

### 5.2 Color scale — `getScaleCalculator` (Q3c)

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

**Output — SECTION 5 (verbatim):**

```
================ SECTION 5: COLOR SCALE via getScaleCalculator (Q3c) ================
  getScaleCalculator(field)(''):  {"percent":0,"threshold":{"value":0,"color":"#808080"},"color":"#808080"}
  getScaleCalculator(field)(0):   {"percent":0,"threshold":{"value":0,"color":"#808080"},"color":"#808080"}
```

The `''` cell produces **byte‑for‑byte the same** `ColorScaleValue` as numeric `0` (`percent:0`, `color:"#808080"`). In color terms, the missing cell **is** treated as zero.

### 5.3 Thresholds — `getActiveThreshold` / `getActiveThresholdForValue` (Q3b)

`getActiveThreshold` (`packages/grafana-data/src/field/thresholds.ts:7–22`) walks the steps and keeps the last step whose `value` the input meets or exceeds:

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

**Output — SECTION 6 (verbatim):**

```
================ SECTION 6: THRESHOLDS via getActiveThreshold (Q3b) ================
  getActiveThreshold('', steps): {"value":0,"color":"red"}
  getActiveThreshold(0, steps):  {"value":0,"color":"red"}
  getActiveThresholdForValue(field, '', 0): {"value":0,"color":"red"}
```

Against steps `[-Infinity→green, 0→red, 10→orange]`, the comparison `'' >= 0` evaluates truthy (`''` coerces to `0`) while `'' >= 10` is false, so the selected step is `{"value":0,"color":"red"}` — **identical** to feeding numeric `0`. Both the low‑level `getActiveThreshold` and the field‑aware `getActiveThresholdForValue` agree.

### 5.4 Display — `getDisplayProcessor` + `anyToNumber` (Q2)

`anyToNumber` (`packages/grafana-data/src/utils/anyToNumber.ts:8–22`) returns `NaN` for `''` at the guard on `:13–14`:

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

Because no color was set, `scaleFunc(-Infinity)` is called at `:189`; inside `getScaleCalculator` the `value !== -Infinity` guard (`scale.ts:31`) is then **false**, so `percent` stays `0` and the returned color is the theme's percent‑`0` gray. Thus display's `color:"#808080"`/`percent:0` originate from the **`-Infinity` fallback**, **not** from coercing `''` to numeric zero.

**Output — SECTION 7 (verbatim):**

```
================ SECTION 7: DISPLAY via getDisplayProcessor (Q2) ================
  anyToNumber('') = (number) NaN
  getDisplayProcessor(number field)(''): {"text":"","numeric":null,"color":"#808080","percent":0}
  getDisplayProcessor(number field)(4):  {"text":"4","numeric":4,"color":"#808080","percent":0.04}
```

The `''` cell renders as `{"text":"","numeric":null,...}` — a **blank** cell — whereas the numeric `4` renders `{"text":"4","numeric":4,...}`. Two distinct causes produce this row: the blank **text** is the skipped numeric‑formatting block (`:144–171`), while the reported `color:"#808080"` and `percent:0` come from the `scaleFunc(-Infinity)` no‑color fallback (`:188–192`, call at `:189`) — **not** from coercing `''` to zero. (In the JSON, `numeric` is JavaScript `NaN`, which `JSON.stringify` serializes as `null`; the numeric `4` reaches the `:144–171` branch and is colored via `scaleFunc(4)`, hence `percent:0.04`.) Numeric‑zero coercion of `''` happens only on the _direct_ scale and threshold calls in §5.2/§5.3, which are separate code paths.

### 5.5 Divergence table — the "different choice," made explicit

The identical emitted cell `(A, r2) = ''` (a `FieldType.number` field holding a string) is treated four different ways:

| Consumer        | Function (`file:line`)                                                                     | Coercion of `''`                | Observed output                       | Equals numeric `0`?    |
| --------------- | ------------------------------------------------------------------------------------------ | ------------------------------- | ------------------------------------- | ---------------------- |
| **Totals**      | `reduceField`→`doStandardCalcs` `sum +=` (`fieldReducer.ts:159`, `468`, `508`)             | none — treated as string in `+` | `(string) "24"`                       | **No** (concatenation) |
| **Color scale** | `getScaleCalculator` (`scale.ts:19`, `32`)                                                 | numeric via `value - min`       | `{"percent":0,...,"color":"#808080"}` | **Yes**                |
| **Thresholds**  | `getActiveThreshold(ForValue)` (`thresholds.ts:7`, `25`)                                   | numeric via `value >= step`     | `{"value":0,"color":"red"}`           | **Yes**                |
| **Display**     | `getDisplayProcessor`+`anyToNumber` (`displayProcessor.ts:96`, `144`; `anyToNumber.ts:13`) | `NaN`                           | `{"text":"","numeric":null,...}`      | **No** (blank)         |

This table _is_ the answer to the user's "different choice somewhere": three distinct coercion rules (string‑`+`, numeric‑subtraction/comparison, and `anyToNumber`→`NaN`) applied to one `''` cell.

---

## 6. The `emptyValue: Null` contrast — the "clean" case

Switching the option to `SpecialValue.Null` emits `null` (not `''`), and `null` is handled cleanly by the reducer. In `doStandardCalcs`, `null` _is_ caught by `if (currentValue == null)` (`fieldReducer.ts:489`); with the default `nullValueMode` of `Ignore` (`reduceField`, `fieldReducer.ts:198`) it hits `if (ignoreNulls) { continue; }` (`fieldReducer.ts:490`), so it never enters the sum (and, were `nullValueMode` `AsZero`, `if (nullAsZero) { currentValue = 0; }` at `fieldReducer.ts:493` would make it a real numeric `0`).

**Command:** the single Jest invocation from §1.

**Output — SECTION 8 (verbatim):**

```
================ SECTION 8: NULL CONTRAST - totals (clean case) ================

----- emptyValue: SpecialValue.Null (for downstream) -----
  field name="Row\Column" type=string  values=[ (string) "r1", (string) "r2", (string) "r3" ]
  field name="A" type=number  values=[ (number) 2, (object) null, (number) 4 ]
  field name="B" type=number  values=[ (object) null, (number) 5, (object) null ]
  Null column "A": values=[ (number) 2, (object) null, (number) 4 ]
  reduceField sum over [2,null,4] (default nullValueMode=Ignore) => (number) 6
```

With `null` cells the total is the **clean numeric `6`** — the correct sum of `2 + 4` with the missing cell ignored — in stark contrast to the default `Empty` path's `(string) "24"` (§5.1). This is why `Null` is the "clean" contrast: it is the only built‑in option whose missing‑cell value is _type‑neutral_ and understood by the reducer. It is still **not** `0`; it is "ignored" (or, opt‑in, "as zero").

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

**Runtime confirmation — SECTION 9 (verbatim):**

```
================ SECTION 9: NO ZERO OPTION (Q5) ================
  Object.values(SpecialValue) = ["true","false","null","empty"]
```

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

Every capture was produced twice, non‑interactively, with the exact commands in §1, writing to two separate files. The outputs are **byte‑identical**:

```
$ diff /tmp/inv_run1.txt /tmp/inv_run2.txt && echo "IDENTICAL"
IDENTICAL

$ wc -c /tmp/inv_run1.txt /tmp/inv_run2.txt
3786 /tmp/inv_run1.txt
3786 /tmp/inv_run2.txt
7572 total

$ sha256sum /tmp/inv_run1.txt /tmp/inv_run2.txt
f51ef19683534a967b79febea4c59fa5ec4c7eaf998f32ebfac08a63cd28cc6e  /tmp/inv_run1.txt
f51ef19683534a967b79febea4c59fa5ec4c7eaf998f32ebfac08a63cd28cc6e  /tmp/inv_run2.txt
```

Both Jest runs reported `Test Suites: 1 passed, 1 total` and `Tests: 1 passed, 1 total`. The output is stable; no run‑to‑run variation was observed.

---

## 10. Cause‑and‑effect, named end to end

A single walk, naming each responsible function:

1. **Emission.** `groupingToMatrixTransformer`'s operator emits the missing cell via the nullish‑coalescing `matrixValues[columnName][rowName] ?? getSpecialValue(emptyValue)` (`groupingToMatrix.ts:117`); `getSpecialValue` returns `''` for the default `Empty` (`groupingToMatrix.ts:178–190`, default set at `:26`, applied at `:71`).
2. **Typing.** That `''` is pushed into a column typed from the _value_ field — `type: valueField.type` (`groupingToMatrix.ts:133`) — so a **`FieldType.number` field ends up holding the string `''`**. This is the root cause.
3. **Totals.** `reduceField`→`doStandardCalcs` neither rejects `''` at the null check (`fieldReducer.ts:489`) nor at the accumulation guard (`fieldReducer.ts:500`), so `calcs.sum += ''` (`fieldReducer.ts:508`, sum seeded `0` at `:446`) **string‑concatenates** → `"24"`.
4. **Color & thresholds.** `getScaleCalculator` (`scale.ts:32`) and `getActiveThreshold`/`getActiveThresholdForValue` (`thresholds.ts:15`, `:25`) put `''` through numeric operators (`-`, `>=`), which **coerce it to `0`**, so both behave exactly as they would for numeric `0`.
5. **Display.** `getDisplayProcessor` runs `anyToNumber('')` → `NaN` (`anyToNumber.ts:13`, assigned at `displayProcessor.ts:96`); the numeric‑format gate `if (!Number.isNaN(numeric))` (`displayProcessor.ts:144–171`) is skipped, so the **text** renders **blank**, and the reported `color`/`percent` come from the separate no‑color fallback `scaleFunc(-Infinity)` (`displayProcessor.ts:188–192`, call at `:189`) — the theme's percent‑`0` gray — **not** from coercing `''` to zero (unlike the direct color/threshold paths in step 4).

**Net:** one number‑typed field holding a non‑numeric `''`, with each consumer applying its own disagreeing coercion rule — string concat, numeric‑`0`, and blank — which is exactly the "different choice somewhere" the user perceived.

---

## 11. Illustrative plain‑JavaScript coercion (NON‑CANONICAL aside)

> **Label:** The block below is **illustrative only** and **non‑canonical**. It is plain‑JavaScript coercion that explains _why_ the divergence happens; it is **not** produced by the Grafana code path. The authoritative results are the real‑function captures in §4–§6 (`transformDataFrame`, `reduceField`, `getScaleCalculator`, `getActiveThreshold(ForValue)`, `getDisplayProcessor`).

**Output — SECTION 10 (verbatim):**

```
================ SECTION 10: ILLUSTRATIVE JS COERCION (non-canonical aside) ================
  '' + 1        = (string) "1"
  0 + '' + 4    = (string) "04"
  Number('')    = (number) 0
  '' == null    = (boolean) false
  '' - 5        = (number) -5
```

These primitives explain the observed behavior: `+` with a string concatenates (`0 + '' + 4 = "04"`, mirroring the `"24"` total), while `-`/`>=`/`Number()` coerce `''` to `0` (mirroring the color/threshold results), and `'' == null` is `false` (which is why the reducer's null check does not catch `''`).

---

## 12. Coverage pass

| Item                                                      | Addressed | Where                          |
| --------------------------------------------------------- | --------- | ------------------------------ |
| **Q1** emitted value (`''`, number‑typed; not `null`/`0`) | ✅        | §2 (Q1), §4                    |
| **Q2** carry‑forward on render (blank)                    | ✅        | §2 (Q2), §5.4                  |
| **Q3a** totals → string concat `"24"`                     | ✅        | §2 (Q3a), §5.1                 |
| **Q3b** thresholds → numeric `0` step                     | ✅        | §2 (Q3b), §5.3                 |
| **Q3c** color scale → numeric `0`                         | ✅        | §2 (Q3c), §5.2                 |
| **Q4** end‑to‑end trace / divergence                      | ✅        | §2 (Q4), §5.5                  |
| **Q5** "missing means zero" is false                      | ✅        | §2 (Q5), §7                    |
| `emptyValue` variant **Empty** (default)                  | ✅        | §4                             |
| `emptyValue` variant **Null**                             | ✅        | §4, §6                         |
| `emptyValue` variant **True**                             | ✅        | §4                             |
| `emptyValue` variant **False**                            | ✅        | §4                             |
| Consumer: totals                                          | ✅        | §5.1                           |
| Consumer: color scale                                     | ✅        | §5.2                           |
| Consumer: thresholds                                      | ✅        | §5.3                           |
| Consumer: display                                         | ✅        | §5.4                           |
| `Null` "clean" contrast (total `6`)                       | ✅        | §6                             |
| `field.type` shown next to `''`                           | ✅        | §4 (SECTION 3)                 |
| Determinism (≥2 byte‑identical runs)                      | ✅        | §9                             |
| Canonical path only (real functions)                      | ✅        | §1, §5                         |
| Illustrative JS aside labeled non‑canonical               | ✅        | §11                            |
| Read‑only + temp‑spec cleanup                             | ✅        | §1 note; verified post‑cleanup |

---

## 13. External corroboration (prior art only — secondary to the runtime observation above)

These public sources corroborate the findings but do **not** substitute for the fresh runtime observation on this commit (which is the authority for every value above):

- **Amazon Managed Grafana — transformation reference** ([docs.aws.amazon.com/grafana/latest/userguide/v10-panels-xform-functions.html](https://docs.aws.amazon.com/grafana/latest/userguide/v10-panels-xform-functions.html)). Lists the missing‑cell choices as Null, True, False, or Empty; offers no zero option — matching `docs/content.ts:631`.
- **`grafana/grafana` issue #97632** ([github.com/grafana/grafana/issues/97632](https://github.com/grafana/grafana/issues/97632)) — _"Grouping to matrix doesn't support 0 for undefined combinations"_: documents that cells are emitted empty rather than `0`, directly validating the user's "missing means zero" gap.
- **`grafana/grafana` issue #100690** ([github.com/grafana/grafana/issues/100690](https://github.com/grafana/grafana/issues/100690)) — confirms the editor's four fixed dropdowns (Column, Row, Cell Value, Empty Value) reject arbitrary custom entries, so a `0` cannot be typed in.
- **Grafana community thread 74645** ([community.grafana.com/t/transform-grouping-to-matrix-issue/74645](https://community.grafana.com/t/transform-grouping-to-matrix-issue/74645)) — reports that, with blank columns, addition performs string concatenation instead of a numeric sum — the exact `fieldReducer` behavior traced in §5.1.
