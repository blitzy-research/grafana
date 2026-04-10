# Technical Specification

# 0. Agent Action Plan

## 0.1 Intent Clarification

### 0.1.1 Core Documentation Objective

Based on the provided requirements, the Blitzy platform understands that the documentation objective is to **create a new investigative reference document** that traces, step-by-step, how Grafana's _Grouping to Matrix_ transformation handles sparse input data — specifically, what value it emits for row/column pairings that never appear in the source series — and how that fill value propagates through the downstream visualization pipeline (display formatting, field reducers, threshold/color-scale evaluation, and panel rendering). The user has observed a semantic mismatch between the human intent ("missing means zero") and the dashboard's actual behavior, and needs a precise, code-backed explanation of where and why the semantics diverge.

**Category:** Create new documentation
**Documentation type:** Technical investigative analysis / Q&A reference document

**Documented requirements with enhanced clarity:**

- **R1 — Transformation fill-value semantics:** Document exactly what the `groupingToMatrixTransformer` emits for each `SpecialValue` option (`Empty`, `Null`, `True`, `False`) when a row/column intersection is absent from the input data.
- **R2 — Downstream display processing:** Trace how each fill value is converted by `anyToNumber`, `getDisplayProcessor`, and `getScaleCalculator`, documenting the resulting `numeric`, `text`, and `color` fields in the `DisplayValue`.
- **R3 — Reducer/aggregation impact:** Show how each fill value is handled by `doStandardCalcs` (sum, mean, count, nonNullCount, allIsNull, allIsZero) and document the concrete corruption path for the default empty-string fill.
- **R4 — Threshold and color-scale behavior:** Explain how each fill value maps to a threshold color via `getActiveThresholdForValue` and `percent` normalization.
- **R5 — Concrete walkthrough:** Present a small, concrete sparse dataset, run it through the transformation conceptually, and show the exact output field structure for each `emptyValue` setting.
- **R6 — No repository modification:** The repository itself must remain unchanged. The only created artifact is the markdown document placed in `blitzy/documentation/`.

**Inferred documentation needs:**

- The existing Grafana docs at `docs/sources/panels-visualizations/query-transform-data/transform-data/index.md` describe the transformation at a surface level but do not document sparse-data fill semantics, the `SpecialValue` enum behavior, or downstream calculation effects. A focused deep-dive document is required.
- Users who rely on heatmap, table, or status-history panels after a Grouping to Matrix step need to understand that the default `Empty` fill (`''`) silently corrupts numeric aggregations through JavaScript type coercion, while `Null` provides the cleanest "absent-value" semantics.
- The gap between "missing means zero" intent and actual platform behavior (no `SpecialValue` option emits the number `0` — only `False` approximates zero through boolean coercion to `0`) should be explicitly called out.

### 0.1.2 Special Instructions and Constraints

- **Repository immutability:** No existing files in the source repository may be modified. The only artifact is a new markdown file.
- **Implementation rule (SWE-AtlasQnA-Repo):** The document must be named `grafana_4550cfb5b728.md` and placed in the `blitzy/documentation` directory in the destination repo. It must provide thinking/rationale behind the answers. Answers must be based on the code as the truth — no assumptions.
- **Temporary scripts:** The user permits temporary scripts for observation but requires cleanup. Since no scripts are needed (the analysis is code-reading based), this constraint is satisfied by default.
- **Style:** Technical, code-referenced, with source citations pointing to specific files and line numbers.

### 0.1.3 Technical Interpretation

These documentation requirements translate to the following technical documentation strategy:

- To **document fill-value semantics (R1)**, we will **create** a new section in `blitzy/documentation/grafana_4550cfb5b728.md` that cites `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts` lines 91–103 (matrix value population), lines 114–117 (empty-cell fill via `getSpecialValue`), and lines 178–190 (the `getSpecialValue` switch statement).
- To **document downstream display processing (R2)**, we will **create** a section referencing `packages/grafana-data/src/utils/anyToNumber.ts` lines 8–22, `packages/grafana-data/src/field/displayProcessor.ts` lines 88–211, and `packages/grafana-data/src/field/scale.ts` lines 19–44.
- To **document reducer/aggregation impact (R3)**, we will **create** a section tracing the logic in `packages/grafana-data/src/transformations/fieldReducer.ts` lines 468–588 (`doStandardCalcs`), specifically the `currentValue == null` check at line 489 and the `calcs.sum += currentValue` accumulation at line 508.
- To **document threshold and color behavior (R4)**, we will **create** a section citing `packages/grafana-data/src/field/scale.ts` and `packages/grafana-data/src/field/thresholds.ts`.
- To **present the concrete walkthrough (R5)**, we will **create** worked examples using the same data patterns found in `packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts`.


## 0.2 Documentation Discovery and Analysis

### 0.2.1 Existing Documentation Infrastructure Assessment

Repository analysis reveals a Hugo-based documentation site rooted at `docs/` with content sources under `docs/sources/`. The documentation is organized into major topic areas including `panels-visualizations/`, `dashboards/`, `datasources/`, and `fundamentals/`.

- **Current documentation framework:** Hugo (static site generator), configured via `docs/Makefile` and `docs/variables.mk`
- **Documentation generator configuration:** `docs/` root with `make-docs` build script
- **API documentation tools in use:** No dedicated API doc generator (JSDoc, TypeDoc) is configured at the monorepo level for frontend packages
- **Diagram tools detected:** Mermaid is used throughout the codebase and tech spec; SVG icons are stored in `public/img/transformations/`
- **Transformation documentation location:** `docs/sources/panels-visualizations/query-transform-data/transform-data/index.md` — a single monolithic file covering all transformations

**Existing Grouping to Matrix documentation (lines 653–681 of `index.md`):**

The existing docs describe the transformation at a user-workflow level: how to select Column, Row, and Cell value fields to generate a matrix. It provides a before/after table example showing Server ID × Server Status with CPU Temperature as cell content. It mentions the empty-cell option choices (Null, True, False, Empty) in a single sentence. Critically, the existing documentation does **not** cover:

- What runtime value each option produces
- How those values interact with numeric fields and downstream calculations
- The type-coercion behavior when empty strings appear in `FieldType.number` arrays
- Any guidance on which option to choose for different use cases

### 0.2.2 Repository Code Analysis for Documentation

**Search patterns used for code to document:**

- Transformation implementation: `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts`
- Transformation tests: `packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts`
- Editor UI component: `public/app/features/transformers/editors/GroupingToMatrixTransformerEditor.tsx`
- SpecialValue enum: `packages/grafana-data/src/types/transformations.ts` (lines 113–118)
- Display processing: `packages/grafana-data/src/field/displayProcessor.ts`
- Numeric coercion utility: `packages/grafana-data/src/utils/anyToNumber.ts`
- Field reducer engine: `packages/grafana-data/src/transformations/fieldReducer.ts`
- Scale/color calculator: `packages/grafana-data/src/field/scale.ts`
- Threshold resolution: `packages/grafana-data/src/field/thresholds.ts`
- Field display assembly: `packages/grafana-data/src/field/fieldDisplay.ts`

**Key directories examined:**

- `packages/grafana-data/src/transformations/transformers/` — all transformation implementations
- `packages/grafana-data/src/field/` — display processing, scale, thresholds, color
- `packages/grafana-data/src/utils/` — numeric conversion helpers
- `packages/grafana-data/src/types/` — type definitions including SpecialValue
- `public/app/features/transformers/editors/` — transformation UI editors
- `docs/sources/panels-visualizations/query-transform-data/transform-data/` — existing docs

### 0.2.3 Web Search Research Conducted

No external web search was required. All answers are grounded in the source code itself, per the user's instruction to "base answers on the code as the truth." The analysis relies entirely on code reading and logical tracing through the Grafana data-processing pipeline.


## 0.3 Documentation Scope Analysis

### 0.3.1 Code-to-Documentation Mapping

- **Module: `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts`**
  - Public APIs: `groupingToMatrixTransformer` (exported descriptor), `GroupingToMatrixTransformerOptions` (exported interface)
  - Key internal functions: `getSpecialValue()`, `findKeyField()`, `uniqueValues()`
  - Current documentation: Surface-level user guide exists in `docs/.../transform-data/index.md`; no developer-facing documentation of fill semantics or type-coercion behavior
  - Documentation needed: Deep technical explanation of the matrix-construction algorithm, empty-cell fill logic, and type implications

- **Module: `packages/grafana-data/src/types/transformations.ts`**
  - Public APIs: `SpecialValue` enum (`True`, `False`, `Null`, `Empty`)
  - Current documentation: Not documented outside of inline code
  - Documentation needed: Mapping from each enum variant to its runtime JavaScript value and downstream numeric/display interpretation

- **Module: `packages/grafana-data/src/utils/anyToNumber.ts`**
  - Public APIs: `anyToNumber(value: unknown): number`
  - Current documentation: JSDoc `@internal` tag only
  - Documentation needed: Behavior table for each fill-value type (empty string, null, boolean) showing the numeric output

- **Module: `packages/grafana-data/src/field/displayProcessor.ts`**
  - Public APIs: `getDisplayProcessor(options)`, `getRawDisplayProcessor()`
  - Current documentation: Inline code comments only
  - Documentation needed: How each fill value flows through display formatting, producing `text`, `numeric`, and `color` in the `DisplayValue` struct

- **Module: `packages/grafana-data/src/transformations/fieldReducer.ts`**
  - Public APIs: `reduceField()`, `doStandardCalcs()`, `ReducerID` enum
  - Current documentation: Inline comments only
  - Documentation needed: Null-check behavior at line 489 (`currentValue == null`), the JavaScript loose-equality semantics, and how empty strings bypass the null gate to corrupt `calcs.sum`

- **Module: `packages/grafana-data/src/field/scale.ts`**
  - Public APIs: `getScaleCalculator()`, `getMinMaxAndDelta()`
  - Current documentation: Inline comments only
  - Documentation needed: How NaN percentages are handled (clamped to 0) and threshold color assignment for missing values

### 0.3.2 Documentation Gap Analysis

Given the requirements and repository analysis, documentation gaps include:

- **Undocumented runtime semantics:** The `SpecialValue` enum's mapping to JavaScript runtime values (`''`, `null`, `true`, `false`) is nowhere documented outside the `getSpecialValue` switch statement
- **Undocumented type-coercion hazard:** The default `SpecialValue.Empty` (`''`) placed into a `FieldType.number` field array creates a mixed-type array (`number | string`) that silently corrupts JavaScript arithmetic via string concatenation — this is not documented anywhere
- **Missing guidance on fill-value selection:** No documentation helps users choose between Empty, Null, True, and False based on their downstream visualization needs
- **Missing calculation-impact documentation:** The field reducer's `doStandardCalcs` function treats empty strings differently from null/undefined, but this distinction is not documented
- **Missing end-to-end trace:** No existing document traces a concrete dataset from sparse input through the transformation, display processor, reducer, and threshold evaluator


## 0.4 Documentation Implementation Design

### 0.4.1 Documentation Structure Planning

The target document `blitzy/documentation/grafana_4550cfb5b728.md` will follow a linear investigative structure that mirrors the data's journey through the pipeline:

```
blitzy/documentation/
└── grafana_4550cfb5b728.md
    ├── Overview and Question Framing
    ├── The Transformation: How the Matrix Is Built
    │   ├── Input Requirements and Field Resolution
    │   ├── Matrix Construction Algorithm
    │   └── The getSpecialValue Fill Logic
    ├── SpecialValue Enum: Runtime Values
    │   └── Mapping Table (enum → JS value → typeof)
    ├── Tracing a Concrete Sparse Dataset
    │   ├── Input Data
    │   ├── Output with SpecialValue.Empty (default)
    │   ├── Output with SpecialValue.Null
    │   └── Output with SpecialValue.False
    ├── Downstream: Display Processing
    │   ├── anyToNumber Coercion
    │   ├── getDisplayProcessor Flow
    │   └── Display Value Comparison Table
    ├── Downstream: Field Reducer (Calculations)
    │   ├── The Null Gate (line 489)
    │   ├── Sum Corruption with Empty Strings
    │   ├── Clean Handling with Null
    │   └── Calculation Comparison Table
    ├── Downstream: Threshold and Color Scale
    │   ├── Scale Calculator Behavior for NaN
    │   └── Color Assignment for Each Fill Type
    ├── The Semantic Gap: "Missing Means Zero"
    │   ├── Why No SpecialValue Produces Zero
    │   ├── SpecialValue.False: The Closest Approximation
    │   └── Practical Recommendations
    └── Source Citations
```

### 0.4.2 Content Generation Strategy

**Information Extraction Approach:**

- "Extract the `getSpecialValue` switch statement from `groupingToMatrix.ts:178–190` and map each case to its JavaScript runtime value"
- "Extract the `anyToNumber` function from `anyToNumber.ts:8–22` and trace each fill value through its branches"
- "Extract the null-check logic from `fieldReducer.ts:489–508` and demonstrate the JavaScript type-coercion path for empty strings"
- "Extract the percent normalization from `scale.ts:29–35` and show the NaN fallback"
- "Generate worked examples using the same data patterns found in `groupingToMatrix.test.ts` (lines 15–60 and 108–149)"

**Documentation Standards:**

- Markdown formatting with proper headers (`#`, `##`, `###`)
- Code examples using TypeScript/JavaScript syntax highlighting
- Tables for parameter descriptions, value comparisons, and behavior matrices
- Source citations as inline references: `Source: packages/grafana-data/src/.../file.ts:LineNumber`
- Mermaid diagrams for the data-flow pipeline
- Consistent terminology aligned with Grafana's codebase (`SpecialValue`, `DisplayValue`, `FieldCalcs`)

### 0.4.3 Diagram and Visual Strategy

**Mermaid diagrams to create:**

- **Data flow diagram:** Showing the path from sparse input → Grouping to Matrix → field with fill values → display processor → reducer → threshold evaluator → rendered panel
- **Decision tree:** Illustrating the `getSpecialValue` switch and the downstream branching for each fill type
- **Comparison table visualizations:** Showing side-by-side behavior of each `SpecialValue` option across all pipeline stages

No screenshots are required since this is a code-analysis document, not a UI walkthrough.


## 0.5 Documentation File Transformation Mapping

### 0.5.1 File-by-File Documentation Plan

| Target Documentation File | Transformation | Source Code/Docs | Content/Changes |
|---|---|---|---|
| `blitzy/documentation/grafana_4550cfb5b728.md` | CREATE | `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts`, `packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts`, `packages/grafana-data/src/types/transformations.ts`, `packages/grafana-data/src/utils/anyToNumber.ts`, `packages/grafana-data/src/field/displayProcessor.ts`, `packages/grafana-data/src/transformations/fieldReducer.ts`, `packages/grafana-data/src/field/scale.ts`, `packages/grafana-data/src/field/thresholds.ts`, `public/app/features/transformers/editors/GroupingToMatrixTransformerEditor.tsx` | Comprehensive investigative document answering: what does Grouping to Matrix emit for missing intersections in sparse data, how does each fill value propagate through display processing / reducers / thresholds, and where does the semantic gap between "missing means zero" and actual behavior originate |

No existing files are updated or deleted, per the repository immutability constraint and the `SWE-AtlasQnA-Repo` implementation rule.

### 0.5.2 New Documentation File Detail

```
File: blitzy/documentation/grafana_4550cfb5b728.md
Type: Technical Q&A / Investigative Analysis
Source Code:
  - packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts
  - packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts
  - packages/grafana-data/src/types/transformations.ts (SpecialValue enum)
  - packages/grafana-data/src/utils/anyToNumber.ts
  - packages/grafana-data/src/field/displayProcessor.ts
  - packages/grafana-data/src/transformations/fieldReducer.ts (doStandardCalcs)
  - packages/grafana-data/src/field/scale.ts (getScaleCalculator)
  - packages/grafana-data/src/field/thresholds.ts (getActiveThresholdForValue)
  - public/app/features/transformers/editors/GroupingToMatrixTransformerEditor.tsx
Sections:
  - Overview and question framing
  - Transformation algorithm walkthrough with code citations
  - SpecialValue enum runtime value mapping
  - Concrete sparse-dataset trace (input → output for each emptyValue)
  - Display processor pipeline trace (anyToNumber → formatting → color)
  - Field reducer behavior trace (null gate, sum corruption, count semantics)
  - Threshold/color-scale behavior for each fill type
  - The "missing means zero" semantic gap analysis
  - Practical recommendations for fill-value selection
  - Complete source citations with file paths and line numbers
Diagrams:
  - Mermaid flowchart: sparse data pipeline from input to rendered panel
  - Mermaid decision tree: getSpecialValue → downstream branching
Key Citations:
  - groupingToMatrix.ts:91-103 (matrix value population loop)
  - groupingToMatrix.ts:114-117 (empty-cell fill with getSpecialValue)
  - groupingToMatrix.ts:178-190 (getSpecialValue switch)
  - transformations.ts:113-118 (SpecialValue enum)
  - anyToNumber.ts:8-22 (numeric coercion)
  - displayProcessor.ts:88-211 (display value assembly)
  - fieldReducer.ts:468-588 (doStandardCalcs)
  - fieldReducer.ts:489 (null gate: currentValue == null)
  - fieldReducer.ts:508 (sum accumulation: calcs.sum += currentValue)
  - scale.ts:19-44 (scale calculator with NaN fallback)
```

### 0.5.3 Documentation Configuration Updates

No documentation generator configuration changes are required. The document is a standalone Markdown file that does not need to be integrated into the Hugo-based docs site or any navigation system. It lives in the `blitzy/documentation/` directory as a self-contained Q&A artifact.

### 0.5.4 Cross-Documentation Dependencies

- **Shared context:** The document references concepts from `docs/sources/panels-visualizations/query-transform-data/transform-data/index.md` (the existing Grouping to Matrix section) but does not modify it
- **Navigation links:** None required — the document is standalone
- **Table of contents updates:** None required
- **Index/glossary updates:** None required


## 0.6 Dependency Inventory

### 0.6.1 Documentation Dependencies

No external documentation tooling is required for this task. The deliverable is a standalone Markdown file authored directly and placed into the `blitzy/documentation/` directory. The file uses standard Markdown syntax with optional Mermaid diagram blocks that can be rendered by any Mermaid-compatible viewer (GitHub, GitLab, VS Code extensions, etc.).

For reference, the key packages whose source code is analyzed and cited in the document are:

| Registry | Package Name | Version | Purpose |
|---|---|---|---|
| npm (workspace) | `@grafana/data` | 11.5.0-pre | Core data layer containing the groupingToMatrix transformer, SpecialValue enum, anyToNumber, displayProcessor, fieldReducer, and scale utilities |
| npm (workspace) | `@grafana/ui` | 11.5.0-pre | UI components used by the GroupingToMatrixTransformerEditor (Select, InlineField, InlineFieldRow) |
| npm (workspace) | `@grafana/schema` | 11.5.0-pre | Schema types used by the editor (SpecialValue re-exports, display mode enums) |
| npm | `rxjs` | (per package.json) | Observable pipeline used by the transformer's `operator` function |
| npm | `lodash` | (per package.json) | `toString`, `toNumber`, `isNumber`, `isBoolean`, `isEmpty` utilities used in display processing and reducers |

### 0.6.2 Documentation Reference Updates

No link updates are required. The new document does not replace or supersede any existing documentation file. It exists as a supplementary investigative analysis in a separate directory (`blitzy/documentation/`) outside the main docs tree.


## 0.7 Coverage and Quality Targets

### 0.7.1 Documentation Coverage Metrics

**Current coverage analysis (for the topic of sparse-data fill semantics in Grouping to Matrix):**

- Transformation overview documented: 1/1 (100%) — the existing docs describe the basic Column/Row/CellValue workflow
- SpecialValue options mentioned: 1/4 (25%) — existing docs name the four options in a single sentence but do not explain runtime behavior
- Fill-value downstream behavior documented: 0/4 (0%) — no existing documentation covers display processing, reducer, or threshold effects
- Type-coercion hazards documented: 0/1 (0%) — the empty-string-in-number-field corruption path is completely undocumented
- End-to-end trace documented: 0/1 (0%) — no worked example exists

**Target coverage after this task:**

- SpecialValue runtime behavior: 4/4 (100%) — all four options fully documented with runtime values and typeof
- Downstream pipeline stages: 4/4 (100%) — display processor, anyToNumber, field reducer, and scale calculator all covered
- Type-coercion hazards: 1/1 (100%) — the sum-corruption path explicitly documented with JS semantics
- End-to-end traces: 3/3 (100%) — worked examples for Empty (default), Null, and False fill values
- Practical recommendations: 1/1 (100%) — guidance on which fill value to use for which intent

### 0.7.2 Documentation Quality Criteria

**Completeness requirements:**

- Every `SpecialValue` variant has a documented runtime value, `anyToNumber` output, display text, and reducer behavior
- The concrete walkthrough uses a minimal but representative sparse dataset (3 rows, 3 columns with 2 missing intersections)
- Source citations reference specific file paths and line numbers for every behavioral claim
- The "missing means zero" semantic gap is explicitly explained with code evidence

**Accuracy validation:**

- All code behavior claims are verified against the actual source in the repository
- The test file `groupingToMatrix.test.ts` serves as ground truth for transformation output shapes
- JavaScript type-coercion behavior (`0 + '' = '0'`) is a language-level fact, not an assumption

**Clarity standards:**

- Technical accuracy with accessible language for dashboard authors who are not TypeScript developers
- Progressive disclosure: overview first, then increasing detail through each pipeline stage
- Consistent terminology using Grafana's actual type names (`SpecialValue`, `DisplayValue`, `FieldCalcs`)

**Maintainability:**

- Source citations include file paths and line numbers for traceability
- The document structure follows the data flow, making it easy to update if the pipeline changes
- All behavioral claims can be verified by re-reading the cited source lines

### 0.7.3 Example and Diagram Requirements

- **Minimum examples per fill-value option:** 1 complete trace (input → matrix output → display → reducer → threshold)
- **Diagram types required:** 1 Mermaid flowchart (data pipeline overview), 1 comparison table per pipeline stage
- **Code example testing:** Examples are derived from the existing test suite in `groupingToMatrix.test.ts`; no separate test execution is needed
- **Visual content freshness:** N/A — this is a one-time investigative document, not a living reference


## 0.8 Scope Boundaries

### 0.8.1 Exhaustively In Scope

- **New documentation file:**
  - `blitzy/documentation/grafana_4550cfb5b728.md` — the complete investigative Q&A document

- **Source code analyzed and cited (read-only):**
  - `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts` — transformation implementation
  - `packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts` — test cases as behavioral contracts
  - `packages/grafana-data/src/types/transformations.ts` — SpecialValue enum definition
  - `packages/grafana-data/src/utils/anyToNumber.ts` — numeric coercion utility
  - `packages/grafana-data/src/field/displayProcessor.ts` — display value assembly
  - `packages/grafana-data/src/transformations/fieldReducer.ts` — field reducer and doStandardCalcs
  - `packages/grafana-data/src/field/scale.ts` — scale calculator and percent normalization
  - `packages/grafana-data/src/field/thresholds.ts` — threshold resolution
  - `packages/grafana-data/src/field/fieldDisplay.ts` — field display assembly
  - `packages/grafana-data/src/field/fieldColor.ts` — field color mode system
  - `public/app/features/transformers/editors/GroupingToMatrixTransformerEditor.tsx` — editor UI
  - `docs/sources/panels-visualizations/query-transform-data/transform-data/index.md` — existing docs (reference only)

- **Documentation content areas:**
  - SpecialValue enum runtime mapping
  - Matrix construction algorithm trace
  - Concrete sparse-data walkthrough
  - Display processor pipeline analysis
  - Field reducer calculation-impact analysis
  - Threshold/color-scale behavior analysis
  - Semantic gap analysis ("missing ≠ zero")
  - Practical recommendations for fill-value selection

### 0.8.2 Explicitly Out of Scope

- **Source code modifications:** No files in the repository may be changed, per the user's explicit instruction and the `SWE-AtlasQnA-Repo` rule
- **Test file modifications:** No test files are modified
- **Feature additions or code refactoring:** This is purely a documentation exercise
- **Deployment configuration changes:** Not applicable
- **Modifications to existing Grafana documentation:** The `docs/` tree is not modified; the new document is placed in `blitzy/documentation/`
- **Other transformations:** Only the Grouping to Matrix transformation is in scope; other transformations (transpose, reduce, group-by, etc.) are referenced only for contrast or context
- **Panel-specific rendering internals:** While the document explains how fill values affect display processing and reducers (which panels consume), it does not trace into specific panel rendering code (table panel, heatmap panel, etc.)
- **Backend Go code:** The transformation is entirely frontend TypeScript; no backend analysis is needed
- **Plugin-specific behavior:** Third-party panel plugins are out of scope


## 0.9 Execution Parameters

### 0.9.1 Documentation-Specific Instructions

- **Documentation build command:** Not applicable — the deliverable is a standalone Markdown file, not part of the Hugo docs build
- **Documentation preview command:** Any Markdown viewer or `cat blitzy/documentation/grafana_4550cfb5b728.md`
- **Diagram generation command:** Mermaid blocks within the Markdown are rendered natively by GitHub/GitLab/VS Code; no separate generation step is needed
- **Documentation deployment command:** Not applicable — the file is committed to the repository directly
- **Default format:** Markdown with Mermaid diagrams and fenced code blocks using TypeScript syntax highlighting
- **Citation requirement:** Every behavioral claim must reference a specific source file path and line number or line range
- **Style guide:** Technical investigative analysis with code-as-truth methodology; no assumptions; rationale provided for all conclusions
- **Documentation validation:** Manual review against the cited source code; the document's behavioral claims can be verified by reading the cited lines in the repository


## 0.10 Rules for Documentation

The following documentation rules are derived from the user's instructions and the `SWE-AtlasQnA-Repo` implementation rule:

- **Create a new markdown document named `grafana_4550cfb5b728.md`** — the file name corresponds to the source branch name `grafana_4550cfb5b728` and must be placed in the `blitzy/documentation` directory
- **Provide thinking / rationale behind the answers** — the document must not merely state conclusions but show the code-level reasoning that supports each claim
- **Do not make assumptions; base answers on the code as the truth** — every behavioral claim must cite specific source files and line numbers; no "typically" or "probably" statements
- **Do not modify any existing files in the source repository** — the only permissible write operation is the creation of the new markdown file in `blitzy/documentation/`
- **Temporary scripts may be used for observation but the repository itself should remain unchanged and anything temporary should be cleaned up afterward** — since the analysis is purely code-reading based, no temporary scripts are required; this constraint is satisfied by default
- **Use consistent terminology from the codebase** — refer to `SpecialValue`, `DisplayValue`, `FieldCalcs`, `doStandardCalcs`, `anyToNumber`, `getScaleCalculator`, etc. by their exact names in the code
- **Include source code citations for all technical details** — format as `Source: path/to/file.ts:LineNumber` or `Source: path/to/file.ts:StartLine-EndLine`


## 0.11 References

### 0.11.1 Codebase Files and Folders Searched

The following files and folders were retrieved, read, or searched to derive the conclusions in this Agent Action Plan:

**Primary source files (read in full):**

| File Path | Purpose in Analysis |
|---|---|
| `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts` | Core transformation implementation — matrix construction algorithm, `getSpecialValue` helper, `findKeyField`, `uniqueValues`, and the `operator` function |
| `packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts` | Test suite — behavioral contracts for default fields, explicit fields, null empty entries, and metadata preservation |
| `packages/grafana-data/src/types/transformations.ts` (lines 113–118) | `SpecialValue` enum definition: `True='true'`, `False='false'`, `Null='null'`, `Empty='empty'` |
| `packages/grafana-data/src/utils/anyToNumber.ts` | Numeric coercion utility — explicit handling of `''`, `null`, `undefined`, arrays, and booleans |
| `packages/grafana-data/src/field/displayProcessor.ts` | Display value assembly — formatting, mapping, threshold color, scale percent, and noValue fallback logic |
| `packages/grafana-data/src/transformations/fieldReducer.ts` (lines 468–588) | `doStandardCalcs` — the null gate at line 489, sum accumulation at line 508, nonNullCount tracking, mean calculation |
| `packages/grafana-data/src/field/scale.ts` | `getScaleCalculator` — percent normalization, NaN-to-zero fallback, threshold color resolution |
| `packages/grafana-data/src/field/thresholds.ts` | `getActiveThreshold` and `getActiveThresholdForValue` — threshold step selection |
| `public/app/features/transformers/editors/GroupingToMatrixTransformerEditor.tsx` | Editor UI — four Select controls for Column, Row, Cell Value, and Empty Value; `specialValueOptions` array |
| `docs/sources/panels-visualizations/query-transform-data/transform-data/index.md` (lines 653–681) | Existing Grafana documentation for the Grouping to Matrix transformation |

**Supporting files referenced for context:**

| File Path | Purpose in Analysis |
|---|---|
| `packages/grafana-data/src/field/fieldDisplay.ts` | Field display assembly — `getFieldDisplayValues` and how display processors are applied to frame data |
| `packages/grafana-data/src/field/fieldColor.ts` | Field color mode system — how color modes interact with threshold-based coloring |
| `packages/grafana-data/src/field/scale.test.ts` | Scale calculator tests — behavioral evidence for percent computation and boolean field handling |
| `packages/grafana-data/src/field/thresholds.test.ts` | Threshold resolution tests — evidence for boundary semantics |
| `packages/grafana-data/src/field/displayProcessor.test.ts` | Display processor tests — evidence for null, NaN, empty-string handling |
| `package.json` | Monorepo metadata — Node >= 22, Yarn 4.5.3, version 11.5.0-pre |
| `.nvmrc` | Node version specification — v22.11.0 |

**Folders explored:**

| Folder Path | Exploration Depth | Purpose |
|---|---|---|
| `` (root) | Level 0 | Repository structure overview |
| `packages/grafana-data/src/transformations/transformers/` | Level 3 | All transformer implementations |
| `packages/grafana-data/src/field/` | Level 2 | Display processing, scale, thresholds, color |
| `packages/grafana-data/src/utils/` | Level 2 | Utility functions (anyToNumber) |
| `packages/grafana-data/src/types/` | Level 2 | Type definitions (SpecialValue, transformations) |
| `public/app/features/transformers/editors/` | Level 2 | Transformation editor UI components |
| `docs/sources/panels-visualizations/query-transform-data/transform-data/` | Level 3 | Existing transformation documentation |
| `docs/sources/` | Level 1 | Documentation site structure overview |

### 0.11.2 Attachments and External Resources

No attachments were provided by the user. No Figma URLs were referenced. No external URLs are required for this analysis — all findings are derived from the source code in the repository.

### 0.11.3 Tech Spec Sections Referenced

- **Section 1.1 Executive Summary** — Confirmed Grafana version 11.5.0-pre, Go 1.23.1 backend, TypeScript/React frontend monorepo
- **Section 3.1 Programming Languages** — Confirmed TypeScript 5.5.4, Node >= 22, language constraints and dependencies


