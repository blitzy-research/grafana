# Technical Specification

# 0. Agent Action Plan

## 0.1 Intent Clarification

### 0.1.1 Core Feature Objective

Based on the prompt, the Blitzy platform understands that the new feature requirement is to **produce a comprehensive code-grounded analysis document** that traces how Grafana's "Grouping to Matrix" transformation handles sparse input data — specifically what happens to row/column intersections that never appear in the source series — and how those emitted fill values propagate through downstream visualization rendering, calculations (totals, thresholds, color scales), and display.

The concrete requirements are:

- **Trace the empty-cell emission**: Determine exactly what value the transformation emits for a row/column pair that does not exist in the input data, under each of the four configurable `emptyValue` options (`Empty`, `Null`, `True`, `False`), and document the default.
- **Trace downstream propagation**: Follow that emitted value through the field reducer (`doStandardCalcs`), the display processor (`getDisplayProcessor`), the scale calculator (`getScaleCalculator` / `getMinMaxAndDelta`), and threshold resolution (`getActiveThresholdForValue`) to identify where semantic meaning shifts.
- **Identify the "missing means zero" divergence**: Explain why the user observes a dashboard treating missing data as zero rather than as absent — pinpointing the exact code paths where the default empty-string fill value is coerced to zero by JavaScript's type system inside numeric operations, despite being displayed as blank.
- **Repository integrity**: The repository must remain unchanged. The only deliverable is a markdown analysis document placed in `blitzy/documentation/`. Any temporary observation scripts must be cleaned up.

### 0.1.2 Implicit Requirements Detected

- The analysis must be evidence-based, citing specific source file paths and line numbers.
- The user needs a concrete sparse dataset walkthrough — not just abstract descriptions but value-by-value tracing showing how `[1, '', '']` (default) versus `[1, null, null]` (Null mode) behave differently through the reducer pipeline.
- The answer must cover the `anyToNumber` helper (`packages/grafana-data/src/utils/anyToNumber.ts`) which plays a pivotal role in how the display processor normalizes empty strings vs nulls.
- The document should explain the practical consequence: the default `SpecialValue.Empty` causes the field reducer to treat empty strings as valid values (corrupting sum via string concatenation, affecting min/max via JS coercion to 0), while `SpecialValue.Null` causes the reducer to skip missing cells entirely.

### 0.1.3 Special Instructions and Constraints

- **CRITICAL**: The implementation rule `SWE-AtlasQnA-Repo` mandates: Create a new markdown document named `<source_branch_name>.md` that comprehensively answers the question(s) posed in the prompt.
- The document must be placed in the `blitzy/documentation` directory.
- No existing files in the source repository may be modified.
- No code may be added to the source repository besides the requested document.
- The source branch name is `grafana_4550cfb5b728`, so the output file is `blitzy/documentation/grafana_4550cfb5b728.md`.

### 0.1.4 Technical Interpretation

These feature requirements translate to the following technical implementation strategy:

- To **answer the user's question**, we will perform deep static analysis of the transformation source code at `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts` and trace data flow through the field reducer at `packages/grafana-data/src/transformations/fieldReducer.ts`, the display processor at `packages/grafana-data/src/field/displayProcessor.ts`, the scale calculator at `packages/grafana-data/src/field/scale.ts`, and the threshold resolver at `packages/grafana-data/src/field/thresholds.ts`.
- To **deliver the document**, we will create `blitzy/documentation/grafana_4550cfb5b728.md` containing a structured analysis with code-referenced findings, a concrete walkthrough of a sparse dataset through the transformation pipeline, and actionable guidance on the `emptyValue` configuration option.
- To **maintain repository integrity**, no existing files will be modified and no temporary scripts will remain.

## 0.2 Repository Scope Discovery

### 0.2.1 Comprehensive File Analysis

The investigation requires deep analysis of files across multiple layers of the Grafana monorepo. All files listed below were discovered via systematic folder exploration and semantic search.

**Core Transformation Implementation (Primary Focus)**

| File Path | Purpose | Relevance |
|---|---|---|
| `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts` | Implements the "Grouping to Matrix" transformer; defines `GroupingToMatrixTransformerOptions`, `getSpecialValue()`, `findKeyField()`, `uniqueValues()` | **Central** — contains the `emptyValue` → fill logic at lines 117 and 178-190 |
| `packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts` | Jest test suite with 4 test cases covering default, explicit fields, null empty, and metadata preservation | **Central** — proves the default empty-string behavior and the null alternative |
| `packages/grafana-data/src/types/transformations.ts` | Defines `SpecialValue` enum: `True`, `False`, `Null`, `Empty` (line 113-118) | **Central** — canonical definition of all fill-value options |
| `packages/grafana-data/src/transformations/transformers/ids.ts` | Defines `DataTransformerID.groupingToMatrix = 'groupingToMatrix'` (line 36) | Supporting — transformer registry identity |

**Downstream Value Processing (Secondary Focus)**

| File Path | Purpose | Relevance |
|---|---|---|
| `packages/grafana-data/src/transformations/fieldReducer.ts` | Field statistics engine: `doStandardCalcs()`, `reduceField()`, `defaultCalcs` | **Critical** — the null check at line 489 (`currentValue == null`) does NOT catch empty strings; the sum accumulation at line 508 (`calcs.sum += currentValue`) causes string concatenation when `currentValue` is `''` |
| `packages/grafana-data/src/field/displayProcessor.ts` | `getDisplayProcessor()` factory; converts raw values to `DisplayValue` objects | **Critical** — calls `anyToNumber(value)` which treats `''` as NaN, so display is identical for `''` and `null` |
| `packages/grafana-data/src/utils/anyToNumber.ts` | `anyToNumber()` helper: explicitly maps `''`, `null`, `undefined` to NaN (line 13) | **Critical** — the key normalizer that makes display behave identically for both fill modes |
| `packages/grafana-data/src/field/scale.ts` | `getScaleCalculator()`, `getMinMaxAndDelta()` — derives color and threshold from numeric range | **Critical** — calls `reduceField` for min/max, so corrupted reducer output affects color scales |
| `packages/grafana-data/src/field/thresholds.ts` | `getActiveThreshold()`, `getActiveThresholdForValue()` — resolves which threshold applies to a value | Important — threshold selection depends on the numeric value passed from the scale calculator |

**Editor and UI Layer**

| File Path | Purpose | Relevance |
|---|---|---|
| `public/app/features/transformers/editors/GroupingToMatrixTransformerEditor.tsx` | React editor UI for the transformation; renders Column, Row, Cell Value, and Empty Value dropdowns | Important — the `specialValueOptions` array (lines 61-66) documents the four available fill options |
| `public/app/features/transformers/standardTransformers.ts` | Registry aggregation for all standard transformers | Supporting — includes the groupingToMatrix registration |

**Table and Visualization Rendering**

| File Path | Purpose | Relevance |
|---|---|---|
| `packages/grafana-ui/src/components/Table/DefaultCell.tsx` | Default table cell renderer; calls `field.display!(cell.value)` | Important — display processor output determines what the user sees |
| `packages/grafana-ui/src/components/Table/TableCell.tsx` | Table cell wrapper; suppresses output when `field?.display` is absent | Supporting — structural context for rendering |
| `packages/grafana-data/src/field/fieldDisplay.ts` | `getFieldDisplayValues()` — converts DataFrames into FieldDisplay records for stat panels, gauges | Important — uses `reduceField` which is affected by empty-string corruption |

**Documentation**

| File Path | Purpose | Relevance |
|---|---|---|
| `docs/sources/panels-visualizations/query-transform-data/transform-data/index.md` | Official docs for all transformations including Grouping to Matrix | Supporting — describes the four Empty Value options (Null, True, False, Empty) |

**Test Infrastructure**

| File Path | Purpose | Relevance |
|---|---|---|
| `packages/grafana-data/src/transformations/fieldReducer.test.ts` | Reducer test suite covering null, NaN, empty edge cases | Supporting — documents expected reducer behavior |
| `packages/grafana-data/src/field/scale.test.ts` | Scale calculator tests for threshold coloring and boolean fields | Supporting — documents expected scale behavior |
| `packages/grafana-data/src/field/displayProcessor.test.ts` | Display processor tests for null, empty string, NaN, and mapping scenarios | Supporting — tests confirm `''` and `null` both display as empty |

### 0.2.2 Integration Point Discovery

The data flows through the following integration points after the transformation:

- **Transformation Pipeline** → `packages/grafana-data/src/transformations/transformDataFrame.ts` — orchestrates RxJS pipeline; the matrix output feeds downstream transformers or panel data processing
- **Panel Data Preprocessing** → `packages/grafana-data/src/dataframe/processDataFrame.ts` via `preProcessPanelData` — normalizes frames before panel rendering
- **Field Configuration & Overrides** → `packages/grafana-data/src/field/fieldOverrides.ts` — applies field config including display processors, thresholds, value mappings
- **Value Mappings** → `packages/grafana-data/src/utils/valueMappings.ts` via `getValueMappingResult` — the `SpecialValueMatch` enum includes `Empty` and `NullAndNan` which could match empty/null cells differently

### 0.2.3 New File Requirements

- **CREATE**: `blitzy/documentation/grafana_4550cfb5b728.md` — comprehensive analysis document answering all questions about sparse data handling in the Grouping to Matrix transformation
- No other files are created or modified.

## 0.3 Dependency Inventory

### 0.3.1 Key Packages Relevant to This Analysis

Since this is a code analysis task (not a runtime feature addition), no dependencies need to be installed or modified. The following table catalogs the packages whose source code was analyzed to derive the conclusions in this plan.

| Registry | Package Name | Version | Purpose in This Analysis |
|---|---|---|---|
| npm (workspace) | `@grafana/data` | `11.5.0-pre` | Core data package containing the transformation implementation, field reducer, display processor, scale calculator, and type definitions |
| npm (workspace) | `@grafana/ui` | `11.5.0-pre` | UI component library containing table cell renderers (`DefaultCell`, `TableCell`, `FooterCell`) that consume the display processor output |
| npm (workspace) | `@grafana/runtime` | `11.5.0-pre` | Runtime services including template variable interpolation used by the transformation editor |
| npm | `rxjs` | per `package.json` | Reactive pipeline used by the transformation `operator` function via `source.pipe(map(...))` |
| npm | `lodash` | per `package.json` | Utility library; `isNumber` used in scale calculator, `toString` in display processor, `toNumber` in `anyToNumber` |

### 0.3.2 Dependency Updates

No dependency changes are required. This task produces only a markdown analysis document and does not modify any source code or configuration.

### 0.3.3 Import Relationships in the Analysis Chain

The following import chain traces how a sparse value travels from transformation output through to the panel:

```
groupingToMatrix.ts → emits DataFrame with '' or null in numeric fields
    ↓
transformDataFrame.ts → passes DataFrame[] through RxJS pipeline
    ↓
fieldReducer.ts (doStandardCalcs) → computes sum, min, max, mean, count
    ↓
scale.ts (getMinMaxAndDelta) → calls reduceField for min/max range
    ↓
displayProcessor.ts (getDisplayProcessor) → calls anyToNumber(value)
    ↓
anyToNumber.ts → '' → NaN, null → NaN (both become NaN for display)
    ↓
DefaultCell.tsx → renders formattedValueToString(displayValue)
```

## 0.4 Integration Analysis

### 0.4.1 Existing Code Touchpoints

This section documents the exact code paths where the semantics of a missing matrix cell shift, based on the source code analysis.

**Stage 1: Transformation Emission (`groupingToMatrix.ts`, lines 114-119)**

The transformation iterates over unique column values and, for each row, looks up `matrixValues[columnName][rowName]`. When the pair does not exist, it applies the nullish coalescing operator:

```typescript
const value = matrixValues[columnName][rowName] ?? getSpecialValue(emptyValue);
```

The `getSpecialValue` function (lines 178-190) maps the `emptyValue` option:
- `SpecialValue.Empty` (default) → `''` (empty string)
- `SpecialValue.Null` → `null`
- `SpecialValue.True` → `true`
- `SpecialValue.False` → `false`

The emitted field inherits `type: valueField.type` (line 133) and `config: valueField.config` (line 132). So a numeric value field produces output fields typed as `FieldType.number` containing empty strings — a type-level mismatch that JavaScript silently tolerates but that produces divergent behavior downstream.

**Stage 2: Field Reducer (`fieldReducer.ts`, `doStandardCalcs`, lines 468-595)**

This is where the primary semantic divergence occurs.

For **empty string** `''`:
- Line 489: `if (currentValue == null)` → `'' == null` is `false` in JavaScript → empty string is NOT treated as null
- Line 500: `if (currentValue != null && !Number.isNaN(currentValue))` → both conditions pass (`'' != null` is true; `Number.isNaN('')` is false because `Number.isNaN` only returns true for the actual NaN value)
- Line 508: `calcs.sum += currentValue` → `1 + ''` = `"1"` (string concatenation, corrupting the accumulator)
- Line 535: `if (currentValue > calcs.max)` → `'' > -MAX_VALUE` coerces to `0 > -MAX_VALUE` → true (first empty string sets max to `''`)
- Line 539: `if (currentValue < calcs.min)` → `'' < MAX_VALUE` coerces to `0 < MAX_VALUE` → true (first empty string sets min to `''`)
- Result: empty strings are counted as valid values; sum becomes a corrupted string; min/max may become `''`

For **null**:
- Line 489: `if (currentValue == null)` → `null == null` is `true`
- Line 490-491: With default `ignoreNulls` mode → `continue` (skipped entirely)
- Result: null values are excluded from all calculations; sum/min/max/mean reflect only real data

**Stage 3: Scale and Color Calculator (`scale.ts`, lines 74-103)**

`getMinMaxAndDelta(field)` calls `reduceField` to compute min and max. When empty strings corrupted the reducer:
- `min` may be `''` (an empty string), `max` is the real maximum
- `delta = max! - min!` → JS subtraction coerces `''` to `0`, so `delta = max - 0 = max`
- In the scale closure (line 32): `percent = (value - info.min!) / info.delta` → for an empty-string cell, `('' - '') / delta` → `0 / delta = 0` → the cell maps to 0% on the color scale, indistinguishable from a real zero

When null was used instead, the reducer excludes nulls, so min/max reflect only real values, and null cells produce `NaN` through `anyToNumber`, which the scale calculator catches at line 34 (`Number.isNaN(percent)`) and resets to 0%.

**Stage 4: Display Processor (`displayProcessor.ts`, lines 88-211)**

Both paths converge here. The display processor calls `anyToNumber(value)` (line 96), which explicitly returns `NaN` for both `''` and `null` (see `anyToNumber.ts` line 13). Because `Number.isNaN(NaN)` is true, the formatting branch at line 144 is skipped. The `text` falls through to `toString(value)` (line 178): `toString('')` produces `''`, `toString(null)` produces `''`. Both display as empty.

**Summary of Semantic Divergence**

| Processing Stage | Default (`''`) | Null (`null`) |
|---|---|---|
| Transformation output | `''` in `FieldType.number` field | `null` in `FieldType.number` field |
| Reducer null check (`== null`) | Fails — treated as valid value | Passes — skipped by `continue` |
| Reducer sum | Corrupted via string concatenation | Unaffected — only real values |
| Reducer min/max | `''` coerces to 0, distorts range | Excluded — real range preserved |
| Reducer count | Incremented (cell counted) | Not incremented |
| Reducer mean | Denominator inflated; value diluted toward 0 | Denominator reflects only real data |
| Display text | Empty string (blank cell) | Empty string (blank cell) |
| Color scale percent | Maps to 0% (looks like zero) | Maps to 0% but min/max are accurate |
| Threshold resolution | Resolves as if value were 0 | Falls to base threshold via -Infinity path |

### 0.4.2 Dependency Injections

No service container or dependency injection changes are required. The analysis covers read-only code paths.

### 0.4.3 Database/Schema Updates

No database or schema changes are involved. The Grouping to Matrix transformation operates entirely in the frontend data pipeline.

## 0.5 Technical Implementation

### 0.5.1 File-by-File Execution Plan

This task produces a single deliverable: a comprehensive markdown analysis document. No source code is modified.

**Group 1 — Deliverable Document**

- **CREATE**: `blitzy/documentation/grafana_4550cfb5b728.md`
  - Purpose: Comprehensive answer to the user's questions about sparse data handling in the Grouping to Matrix transformation
  - Contents:
    - Explanation of what the transformation emits for missing row/column pairs under each `emptyValue` setting
    - Step-by-step trace of a concrete sparse dataset (`[1, '', '']` vs `[1, null, null]`) through `doStandardCalcs`
    - Analysis of how the emitted value propagates through scale calculation, threshold resolution, and color mapping
    - Identification of the exact code points where "missing" diverges from "zero"
    - Practical guidance on choosing `SpecialValue.Null` over `SpecialValue.Empty` when the intent is "missing means absent"

### 0.5.2 Implementation Approach

The document will be structured as follows:

- **Section 1 — Transformation Mechanics**: Explain `getSpecialValue()`, the `emptyValue` option, and why `SpecialValue.Empty` is the default (backward compatibility with the original design that assumed table display only)
- **Section 2 — Concrete Walkthrough**: Trace a 3×3 sparse dataset (e.g., servers × statuses with 5 of 9 cells populated) through the transformation, showing the exact output DataFrame with field types
- **Section 3 — Field Reducer Divergence**: Walk through `doStandardCalcs` line by line for both `''` and `null`, showing JavaScript coercion behavior at each step
- **Section 4 — Scale and Color Impact**: Show how corrupted min/max from the reducer affects `getMinMaxAndDelta`, percent calculation, and threshold selection
- **Section 5 — Display Convergence**: Explain why both modes display identically (via `anyToNumber` normalization) despite having different computational semantics
- **Section 6 — Practical Recommendation**: When "missing means absent," set `emptyValue` to `Null`; when "missing means zero," leave the default but be aware of the sum-corruption side effect
- **Section 7 — Value Mapping Consideration**: Note that `SpecialValueMatch.Empty` and `SpecialValueMatch.NullAndNan` in the value mappings system can be used to give missing cells explicit display text

### 0.5.3 Key Technical Findings to Document

The analysis document must cover these specific code-level findings:

**Finding 1: The `getSpecialValue` dispatch (groupingToMatrix.ts:178-190)**
- Default `SpecialValue.Empty` returns `''` — an empty string placed into a `FieldType.number` field
- This is a silent type mismatch: the field claims to be numeric, but contains string values

**Finding 2: JavaScript loose equality in the null check (fieldReducer.ts:489)**
- `'' == null` is `false` in JavaScript (empty string is only loosely equal to `undefined` via `''`)
- This means empty strings bypass the null-handling path entirely

**Finding 3: `Number.isNaN` strictness (fieldReducer.ts:500)**
- `Number.isNaN('')` is `false` because `Number.isNaN` checks if the value IS the NaN value, not whether it would convert to NaN
- This differs from the global `isNaN('')` which would return `false` (because `Number('')` is `0`)
- The empty string enters the "valid non-null, non-NaN value" branch

**Finding 4: Sum corruption via `+=` (fieldReducer.ts:508)**
- `calcs.sum += ''` triggers JavaScript string concatenation: `0 + '' = "0"`, `1 + '' = "1"`
- Once sum becomes a string, all subsequent additions continue as concatenation
- This can produce completely nonsensical "sum" values like `"1234"` instead of `10`

**Finding 5: Comparison coercion (fieldReducer.ts:535-541)**
- `'' > -MAX_VALUE` → `0 > -1.7976...e+308` → `true` (JS coerces `''` to `0` for comparison)
- `'' < MAX_VALUE` → `0 < 1.7976...e+308` → `true`
- Empty strings behave like `0` in relational comparisons, causing min to become `''`

**Finding 6: Display normalization via anyToNumber (anyToNumber.ts:13)**
- `anyToNumber('')` explicitly returns `NaN` (not `0`), overriding lodash's default which would return `0`
- `anyToNumber(null)` also returns `NaN`
- This causes both fill modes to display identically as blank cells

**Finding 7: The user's observed behavior explained**
- The user sees "missing" acting like "zero" because: (a) the default fill is `''`, (b) the reducer treats `''` as a valid value due to the loose null check, (c) JS coercion makes `''` behave like `0` in numeric operations, and (d) the display shows blank, hiding the computational corruption
- Switching `emptyValue` to `Null` resolves this because `null == null` passes the null check, and the default `ignoreNulls` mode skips the value entirely

## 0.6 Scope Boundaries

### 0.6.1 Exhaustively In Scope

**Analysis Targets (read-only inspection)**:
- `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts` — full implementation analysis
- `packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts` — test case analysis for behavioral verification
- `packages/grafana-data/src/transformations/fieldReducer.ts` — `doStandardCalcs()` null/empty-string handling analysis
- `packages/grafana-data/src/field/displayProcessor.ts` — display normalization path analysis
- `packages/grafana-data/src/field/scale.ts` — `getMinMaxAndDelta()` and `getScaleCalculator()` analysis
- `packages/grafana-data/src/field/thresholds.ts` — threshold resolution analysis
- `packages/grafana-data/src/utils/anyToNumber.ts` — value normalization analysis
- `packages/grafana-data/src/utils/valueMappings.ts` — value mapping SpecialValueMatch analysis
- `packages/grafana-data/src/types/transformations.ts` — `SpecialValue` enum definition
- `public/app/features/transformers/editors/GroupingToMatrixTransformerEditor.tsx` — editor UI analysis
- `docs/sources/panels-visualizations/query-transform-data/transform-data/index.md` — documentation review

**Deliverable**:
- `blitzy/documentation/grafana_4550cfb5b728.md` — the analysis document

### 0.6.2 Explicitly Out of Scope

- Modifying the transformation implementation to fix the type mismatch
- Modifying the field reducer to handle empty strings differently
- Modifying any existing test files
- Adding new test cases
- Backend Go code analysis (the transformation runs entirely in the frontend)
- Performance optimization of the transformation
- Analysis of other transformations beyond Grouping to Matrix
- Plugin-specific panel rendering internals beyond the standard table cell renderer
- Changes to `anyToNumber.ts` or any other utility
- Refactoring of existing code unrelated to the analysis

## 0.7 Rules for Feature Addition

### 0.7.1 Implementation Rule: SWE-AtlasQnA-Repo

The user-specified implementation rule governs the entire deliverable:

- **Create a new markdown document** named `grafana_4550cfb5b728.md` (matching the source branch name) that comprehensively answers the question(s) posed in the prompt
- **Provide thinking / rationale** behind the answers — the document must not merely state conclusions but trace them through specific code paths with file references and line numbers
- **Do not make assumptions** — base all answers on the code as the truth; every claim must cite a specific file, line, or code construct
- **Do not modify any existing files** in the source repository
- **Do not add any other code** in the source repository besides the requested document
- **Place the generated document** in the `blitzy/documentation` directory in the destination repo

### 0.7.2 Repository Integrity Constraint

The user explicitly states: "the repository itself should remain unchanged and anything temporary should be cleaned up afterward." This means:

- No source files may be created, modified, or deleted
- No configuration files may be altered
- No test files may be added
- The only permitted file creation is the documentation deliverable at `blitzy/documentation/grafana_4550cfb5b728.md`
- If any temporary scripts are used during analysis, they must be removed before completion

### 0.7.3 Analysis Quality Standards

- Every finding must reference a specific file path and line number
- JavaScript coercion behavior must be verified against the ECMAScript specification (e.g., `'' == null` is `false` per Abstract Equality Comparison, `'' > -MAX_VALUE` coerces via ToNumber which maps `''` to `0`)
- The walkthrough must use concrete values, not abstract descriptions
- The document must distinguish between "display behavior" (what the user sees) and "computational behavior" (what the reducer calculates), as these diverge for the default `emptyValue` setting

## 0.8 References

### 0.8.1 Files and Folders Searched

The following files and folders were systematically retrieved and analyzed to derive the conclusions in this Agent Action Plan:

**Transformation Core**:
- `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts` — full read (191 lines)
- `packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts` — full read (210 lines)
- `packages/grafana-data/src/types/transformations.ts` — lines 110-118 (SpecialValue enum)
- `packages/grafana-data/src/transformations/transformers/ids.ts` — line 36 (transformer ID)

**Field Processing Pipeline**:
- `packages/grafana-data/src/transformations/fieldReducer.ts` — lines 1-595 (full reducer engine)
- `packages/grafana-data/src/field/displayProcessor.ts` — full read (230 lines)
- `packages/grafana-data/src/field/scale.ts` — full read (122 lines)
- `packages/grafana-data/src/field/thresholds.ts` — summary reviewed
- `packages/grafana-data/src/utils/anyToNumber.ts` — full read (22 lines)
- `packages/grafana-data/src/utils/valueMappings.ts` — summary reviewed

**Editor and UI**:
- `public/app/features/transformers/editors/GroupingToMatrixTransformerEditor.tsx` — full read (117 lines)
- `packages/grafana-ui/src/components/Table/DefaultCell.tsx` — summary reviewed
- `packages/grafana-ui/src/components/Table/TableCell.tsx` — summary reviewed
- `packages/grafana-data/src/field/fieldDisplay.ts` — summary reviewed

**Documentation**:
- `docs/sources/panels-visualizations/query-transform-data/transform-data/index.md` — Grouping to Matrix section

**Folders Explored**:
- Root repository (`""`) — full folder listing
- `packages/grafana-data/src/transformations/` — folder summary
- `packages/grafana-data/src/transformations/transformers/` — folder summary
- `public/app/features/transformers/` — folder summary
- `public/app/features/transformers/editors/` — folder summary
- `devenv/dev-dashboards/transforms/` — folder summary
- `packages/grafana-data/src/field/` — files reviewed via summaries

**Test Suites Reviewed (Summaries)**:
- `packages/grafana-data/src/transformations/fieldReducer.test.ts`
- `packages/grafana-data/src/field/scale.test.ts`
- `packages/grafana-data/src/field/displayProcessor.test.ts`
- `packages/grafana-data/src/transformations/transformers/reduce.test.ts`

### 0.8.2 Tech Spec Sections Retrieved

- `1.1 Executive Summary` — confirmed project identity (Grafana v11.5.0-pre monorepo)

### 0.8.3 Attachments

No attachments were provided by the user. No Figma URLs were referenced.

### 0.8.4 External References

No external web searches were required. All findings are derived directly from the source code in the repository.

