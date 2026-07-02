# Blitzy Project Guide

**Project:** Grouping-to-matrix sparse-data behavior investigation (`@grafana/data`)
**Repository:** `grafana/grafana` @ `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` · branch `grafana_4550cfb5b728`
**Task type:** Read-only investigative Q&A documentation (rule set "SWE-AtlasQnA-Repo")
**Guide generated:** Post-validation assessment

> **Color legend (Blitzy brand):** Completed / AI Work = **Dark Blue `#5B39F3`** · Remaining / Not Completed = **White `#FFFFFF`** · Headings / Accents = Violet-Black `#B23AF2` · Highlight = Mint `#A8FDD9`.

---

## 1. Executive Summary

### 1.1 Project Overview

This project answers a precise engineering question for a Grafana dashboard author: when the "Grouping to matrix" transformation receives a *sparse* series, what value does it emit for `(column, row)` pairings that never appear in the input, and how does that value travel through a downstream visualization's rendering, totals, thresholds, and color scales? The deliverable is a single evidence-backed Markdown document produced by **building and running** the actual `@grafana/data` code paths and quoting verbatim runtime output. The target users are dashboard builders and Grafana engineers who need to know whether "missing" silently becomes empty, null, or zero — a difference that can change what a panel appears to say. The scope is strictly read-only: exactly one documentation file is created; no product code is changed.

### 1.2 Completion Status

The project is **84.8% complete** on an AAP-scoped, hours-based basis. The single documentation deliverable is fully authored, committed, and independently re-validated; the remaining work is human path-to-production (SME review and merge).

```mermaid
%%{init: {'theme':'base', 'themeVariables':{'pie1':'#5B39F3','pie2':'#FFFFFF','pieStrokeColor':'#B23AF2','pieStrokeWidth':'2px','pieOuterStrokeColor':'#B23AF2','pieOuterStrokeWidth':'2px','pieTitleTextSize':'16px','pieSectionTextColor':'#B23AF2','pieSectionTextSize':'14px'}}}%%
pie showData
    title Completion — 84.8%
    "Completed Work (19.5h)" : 19.5
    "Remaining Work (3.5h)" : 3.5
```

| Metric | Hours |
|---|---|
| **Total Hours** | **23.0** |
| **Completed Hours (AI + Manual)** | **19.5** (AI 19.5 + Manual 0.0) |
| **Remaining Hours** | **3.5** |
| **Percent Complete** | **84.8%** |

> Formula: `Completion % = Completed / (Completed + Remaining) = 19.5 / 23.0 = 84.8%`.

### 1.3 Key Accomplishments

- ✅ **Sole deliverable created** at the mandated path/name: `blitzy/documentation/grafana_4550cfb5b728.md` (427 lines), with the `blitzy/documentation/` directory created as required.
- ✅ **All five sub-questions (Q1–Q5) answered by name** with verbatim runtime evidence (OBS-A … OBS-G).
- ✅ **All eight named items covered by name** — empty cells, nulls, zeros, totals, thresholds, color scales, the transformation, and a downstream visualization — plus an explicit *absent-vs-present-zero* distinction and an explicit "no Zero option" statement.
- ✅ **Build-and-run-first methodology honored**: the canonical `groupingToMatrix.test.ts` was independently reproduced (PASS 4/4) and the ephemeral harness captured live output before any conclusion was written.
- ✅ **~40 `file:line` citations grounded**; ≈20 independently re-verified exact this session, including the document's own path-correction note.
- ✅ **External corroboration** completed against GitHub issue #97632, the official docs, and the community forum.
- ✅ **Repository left pristine** — working tree clean, temporary harness deleted, exactly one file added vs. base.

### 1.4 Critical Unresolved Issues

| Issue | Impact | Owner | ETA |
|---|---|---|---|
| _None_ — no blocking issues. All validation gates pass; the deliverable is complete and the repository is clean. | None | — | — |

### 1.5 Access Issues

| System/Resource | Type of Access | Issue Description | Resolution Status | Owner |
|---|---|---|---|---|
| — | — | **No access issues identified.** The repository, toolchain (Node 22.x, Yarn 4.5.3, Jest 29.7.0), and dependencies (`node_modules` present) were all accessible; the canonical test ran successfully. | N/A | — |

### 1.6 Recommended Next Steps

1. **[High]** Have a Grafana/`@grafana/data`-familiar engineer perform an SME technical review of the analysis and its citations (HT-1, 2.0h).
2. **[Medium]** Approve and merge the branch, and surface the answer to the requester (HT-3, 0.5h).
3. **[Low]** Optionally reproduce the evidence by rebuilding the ephemeral Jest harness from the documented pattern (HT-2, 1.0h).
4. **[Low]** _(Out of scope, 0h)_ If a genuine `0` fill is desired, track upstream GitHub issue #97632 / PR #97642 rather than modifying this snapshot.

---

## 2. Project Hours Breakdown

### 2.1 Completed Work Detail

All completed work was performed autonomously by Blitzy agents (0 manual hours). Each component traces to an AAP requirement.

| Component | Hours | Description |
|---|---|---|
| Environment setup & dependency verification | 1.5 | Confirm Node 22.x / Yarn 4.5.3 / Jest 29.7.0; verify `node_modules` present and `@grafana/data` resolves to TS source (`main=src/index.ts`, no build step) — AAP §0.6, R22 |
| Code-path investigation & tracing | 4.0 | Trace the value across 15+ files: `groupingToMatrix.ts`, `transformations.ts`, `fieldReducer.ts`, `thresholds.ts`, `scale.ts`, `displayProcessor.ts`, `anyToNumber.ts`, Table components — R1–R7, R18–R19 |
| Observation harness design & implementation | 3.0 | Ephemeral Jest spec (7 cases) stubbing the registry and driving `transformDataFrame` + `reduceField` + `getDisplayProcessor` + `getActiveThreshold` + `getScaleCalculator` — R22 |
| Harness execution & verbatim evidence capture | 1.5 | Run the harness; capture OBS-A…G verbatim (fields, sums, display text, threshold, color) — R23, R24 |
| Deliverable authoring (427-line document) | 4.5 | Write the evidence-backed answer: TL;DR, data-flow diagram, Q1–Q5, absent-vs-present-zero, coverage checklist — R1–R19 |
| Citation grounding & verification (~40 `file:line`) | 1.5 | Ground every claim in an exact `file:line`; correct the `transformers.ts` path note — R25 |
| External corroboration via web search | 1.0 | Cross-check issue #97632, official "Transform data" docs, forum #74645, issues #106631/#87332 — R28 |
| Correction cycles | 1.0 | Fix nullish-coalescing (`??`) semantics; make threshold evidence blocks strictly verbatim — R24 |
| Independent validation re-verification | 1.5 | Re-run tests (canonical 4/4; harness 7/7 ×3), full coverage pass, citation re-check, git cleanliness confirmation — R26, R27 |
| **Total Completed** | **19.5** | **Matches Section 1.2 Completed Hours** |

### 2.2 Remaining Work Detail

All remaining work is human path-to-production; each item traces to an AAP requirement (R29–R31).

| Category | Hours | Priority |
|---|---|---|
| SME technical review of the analysis (Q1–Q5 conclusions, coercion reasoning, ~40 citations) — R29 | 2.0 | High |
| Independent evidence reproduction (rebuild ephemeral harness, re-run OBS-A…G) — R30 | 1.0 | Low |
| Merge/PR approval & delivery of the answer to the requester — R31 | 0.5 | Medium |
| **Total Remaining** | **3.5** | **Matches Section 1.2 Remaining Hours & Section 7 pie** |

### 2.3 Hours Reconciliation

| Check | Result |
|---|---|
| Section 2.1 total (Completed) | 19.5 h |
| Section 2.2 total (Remaining) | 3.5 h |
| 2.1 + 2.2 = Total | 19.5 + 3.5 = **23.0 h** ✅ (equals Section 1.2 Total) |
| Completion % | 19.5 / 23.0 = **84.8%** ✅ |

---

## 3. Test Results

All tests below originate from Blitzy's autonomous validation execution for this project. The canonical test was **independently reproduced** during this assessment (PASS 4/4, exit=0). The observation harness (7/7 pass, executed 3× consecutively during prior validation) was **deleted afterward** per the read-only mandate, so its cases are reported from the autonomous validation logs.

| Test Category | Framework | Total Tests | Passed | Failed | Coverage % | Notes |
|---|---|---|---|---|---|---|
| Unit — Transformation (canonical) | Jest 29.7.0 | 4 | 4 | 0 | N/A (doc task) | `groupingToMatrix.test.ts`; 1 snapshot passed; independently reproduced this session (exit=0). Anchors the Q1 finding (`[1,'','']`). |
| Behavioral — Observation harness (ephemeral) | Jest 29.7.0 | 7 | 7 | 0 | 100% of investigated paths | `zz_blitzy_observe.test.ts`; drove transformation + `reduceField` + `getDisplayProcessor` + `getActiveThreshold` + `getScaleCalculator`; produced OBS-A…G; **deleted** post-capture. |
| **Total** | **Jest** | **11** | **11** | **0** | — | 100% pass rate; zero failures. |

**Verbatim run marker (canonical, reproduced this session):**

```
PASS packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts
Test Suites: 1 passed, 1 total
Tests:       4 passed, 4 total
Snapshots:   1 passed, 1 total
Time:        ~1.4 s
```

> Note: harmless `jest-haste-map` "duplicate manual mock" warnings (influxdb/loki/prometheus) are emitted by the monorepo but do **not** fail the run (exit=0).

---

## 4. Runtime Validation & UI Verification

Every code path the emitted value travels through was executed with a concrete sparse dataset, and verbatim output was captured. Because this is a read-only investigation, the downstream visualization was traced through its **calculation and render code paths** rather than a live Grafana UI.

**Runtime health (all investigated paths executed):**

- ✅ **Operational** — Transformation (`transformDataFrame` + `groupingToMatrix`): absent `(col,row)` → empty string `''` inside a number-typed field (OBS-A / OBS-B); a present `0` is preserved as numeric `0`; `SpecialValue.Null` → `null` (OBS-C).
- ✅ **Operational** — Totals (`reduceField` → `doStandardCalcs`): `''` passes the numeric gate and `calcs.sum += ''` string-concatenates (e.g., `"02"`, `"0300"`, `typeof=string`); `Null` fill yields numeric sums (OBS-A_SUM / OBS-B_SUM / OBS-C_SUM).
- ✅ **Operational** — Display (`getDisplayProcessor`): `''` → `text="" numeric=null` (blank); present `0` → `text="0"` (OBS-D).
- ✅ **Operational** — Thresholds (`getActiveThreshold`): `''` selects the `0` step (green), same as a genuine `0` (OBS-E).
- ✅ **Operational** — Color scale (`getScaleCalculator`): `''` → `percent=0`, color `#73BF69` (green), identical to `0` (OBS-F).
- ✅ **Operational** — Pure-JS coercion proofs confirm the mechanism (`Number.isNaN('')===false`, `'' == null` is `false`, `0 + '' → "0"`) (OBS-G).

**UI verification:**

- ⚠ **Partial (by design)** — No live Grafana server/UI was launched (out of scope for a read-only doc task). The downstream **Table panel** visualization was verified via its render code path (`DefaultCell.tsx:23/50`, footer `utils.ts:404`, `FooterRow.tsx`/`FooterCell.tsx`) and the calculation paths above, which is the appropriate level of verification for this investigation.

---

## 5. Compliance & Quality Review

AAP deliverables and rule-set directives are cross-mapped to their verification status. Fixes applied during autonomous validation are noted.

| Benchmark / AAP Directive | Status | Evidence / Notes |
|---|---|---|
| Single deliverable at correct path & branch-derived name | ✅ Pass | `blitzy/documentation/grafana_4550cfb5b728.md`; `git diff` shows only `A` for this file |
| `blitzy/documentation/` directory created | ✅ Pass | Directory now exists; contains only the deliverable |
| Build-and-run-first methodology | ✅ Pass | Canonical test reproduced (4/4); harness produced OBS-A…G before conclusions |
| Verbatim output, one-claim-one-evidence | ✅ Pass | OBS-A…G blocks; **fix applied** (commit `6e6d17f41e`) removed non-observed editorial parentheticals from threshold blocks |
| Exact `file:line` grounding | ✅ Pass | ~40 citations; ≈20 independently re-verified exact; path-correction (`transformers.ts`) confirmed |
| All 5 sub-questions (Q1–Q5) answered by name | ✅ Pass | Headings present; each answered with evidence |
| All 8 named items covered by name | ✅ Pass | empty cells / nulls / zeros / totals / thresholds / color scales / the transformation / a downstream visualization |
| Absent-vs-present-zero distinction | ✅ Pass | Dedicated section; `''` (string) vs `0` (number) in same column |
| Explicit "no Zero option" statement | ✅ Pass | `SpecialValue` enum has only True/False/Null/Empty (`transformations.ts:113-118`) |
| Nullish-coalescing (`??`) semantics correct | ✅ Pass | **Fix applied** (commit `c2ed032153`) corrected `??` semantics |
| Read-only scope — repository unchanged | ✅ Pass | Working tree clean; no source/test/config modified |
| Temporary scripts removed | ✅ Pass | No `zz_blitzy*` files present in tree or git index |
| Web-search corroboration | ✅ Pass | Issue #97632, official docs, forum #74645, issues #106631/#87332 |
| Coverage pass performed before completion | ✅ Pass | Coverage-pass checklist section present in deliverable |

**Overall compliance: 14/14 Pass.**

---

## 6. Risk Assessment

Overall risk posture: **Low**. No High/Critical risks. This is a completed, validated, read-only documentation task; no code, dependencies, or credentials were introduced.

| Risk | Category | Severity | Probability | Mitigation | Status |
|---|---|---|---|---|---|
| Evidence-reproduction gap — the observation harness was deleted per the read-only mandate, so OBS-A…G cannot be re-run as-is | Technical | Low | Medium | Document specifies the exact harness pattern; canonical `groupingToMatrix.test.ts` independently reproduced (4/4) anchors the core finding | Open (mitigated) |
| Version-pinned findings may drift as Grafana evolves (e.g., if issue #97632 / PR #97642 lands a Zero option) | Technical | Low | Medium (over time) | Every claim is version-stamped to HEAD `4550cfb5b728` / `@grafana/data 11.5.0-pre`; doc notes the "support 0" change is not present at this commit | Accepted |
| Citation line numbers drift if source files change | Technical | Low | Low | Commit-pinned; ≈20/40 citations independently re-verified exact | Accepted |
| Answer discoverability — the deliverable must be surfaced to the requester | Operational | Low | Low | Deliver via PR/merge; PR description references the file path | Open |
| External corroboration URLs may rot over time | Integration | Low | Low | Authoritative evidence is the observed runtime output, not the URLs (doc states this explicitly) | Accepted |
| Security surface | Security | None | N/A | Documentation-only: no product code, dependency changes, credentials/secrets, or data/network paths introduced | N/A |

---

## 7. Visual Project Status

**Project hours breakdown** (Completed = Dark Blue `#5B39F3`, Remaining = White `#FFFFFF`):

```mermaid
%%{init: {'theme':'base', 'themeVariables':{'pie1':'#5B39F3','pie2':'#FFFFFF','pieStrokeColor':'#B23AF2','pieStrokeWidth':'2px','pieOuterStrokeColor':'#B23AF2','pieOuterStrokeWidth':'2px','pieTitleTextSize':'16px','pieSectionTextColor':'#B23AF2','pieSectionTextSize':'14px'}}}%%
pie showData
    title Project Hours Breakdown (Total 23.0h)
    "Completed Work" : 19.5
    "Remaining Work" : 3.5
```

**Remaining work by priority** (sums to 3.5h — matches Section 2.2):

```mermaid
%%{init: {'theme':'base', 'themeVariables':{'pie1':'#B23AF2','pie2':'#5B39F3','pie3':'#A8FDD9','pieStrokeColor':'#5B39F3','pieSectionTextColor':'#1A1A1A','pieTitleTextSize':'16px'}}}%%
pie showData
    title Remaining Hours by Priority (3.5h)
    "High — SME review" : 2.0
    "Low — Evidence reproduction" : 1.0
    "Medium — Merge & deliver" : 0.5
```

> **Integrity:** "Remaining Work" = **3.5h** here equals Section 1.2 Remaining Hours and the Section 2.2 "Hours" total. "Completed Work" = **19.5h** equals Section 1.2 Completed Hours and the Section 2.1 total.

---

## 8. Summary & Recommendations

**Achievements.** The project delivers a rigorous, runtime-verified answer to a subtle Grafana behavior question. It establishes that a missing `(column, row)` combination is emitted as an **empty string `''`** (not null, not zero) into a **number-typed** field, that **no "Zero" fill option exists**, and that this single `''` then diverges into three different downstream behaviors — a **string-corrupted total**, a **blank** rendered cell, and a **zero-equivalent** threshold/color — which is precisely the "semantic shift" the requester sensed. It also proves that a genuine present `0` is preserved, so "absent" and "present-zero" are represented differently.

**Remaining gaps.** Only human path-to-production remains: an SME technical review, an optional independent reproduction of the evidence, and merge/delivery — **3.5 hours** total.

**Critical path to production.** SME review (2.0h) → merge & deliver (0.5h). The optional evidence reproduction (1.0h) can proceed in parallel and is not blocking.

**Success metrics.** All five sub-questions answered by name; all eight named items covered; canonical test reproduced (4/4); repository left unchanged (1 file added); ≈20 citations re-verified exact; external corroboration complete.

**Production-readiness assessment.** The project is **84.8% complete** and **production-ready pending human review**. There are no blocking issues and no High/Critical risks. The deliverable faithfully documents current behavior at the pinned commit and explicitly scopes out the (upstream) "support 0" change — an honest, conservative, and directly usable answer.

| Metric | Value |
|---|---|
| Completion | 84.8% |
| Total / Completed / Remaining hours | 23.0 / 19.5 / 3.5 |
| Blocking issues | 0 |
| High/Critical risks | 0 |
| Tests passed | 11 / 11 (100%) |
| Files changed vs base | 1 (+427 / -0) |

---

## 9. Development Guide

This guide documents how to reproduce the investigation environment and the anchor evidence. Every command was tested during assessment.

### 9.1 System Prerequisites

- **OS:** Linux/macOS (developed on Ubuntu container).
- **Node.js:** `v22.x` (repo pins `v22.11.0` in `.nvmrc`; `engines.node ">= 22"`). Verified `v22.12.0`.
- **Package manager:** **Yarn 4.5.3** (via Corepack).
- **Test runner:** **Jest 29.7.0** (already a dev dependency).
- **Disk:** ~2 GB free (repo + `node_modules`).

```bash
node --version      # -> v22.x
yarn --version      # -> 4.5.3
```

### 9.2 Environment Setup

```bash
# From the repository root:
cd <repo-root>

# @grafana/data resolves directly to TypeScript source — NO build step is required:
node -e "const p=require('./packages/grafana-data/package.json'); console.log(p.name, p.version, p.main)"
# -> @grafana/data 11.5.0-pre src/index.ts
```

### 9.3 Dependency Installation

`node_modules` is already present in the working environment. If you need a fresh install:

```bash
corepack enable          # ensures Yarn 4.5.3 is active
yarn install --immutable # Yarn 4 immutable install
```

### 9.4 Reproduce the Anchor Evidence (canonical test)

```bash
node_modules/.bin/jest \
  packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts \
  --no-coverage --silent
```

**Expected output (verified, exit=0):**

```
PASS packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts
Test Suites: 1 passed, 1 total
Tests:       4 passed, 4 total
Snapshots:   1 passed, 1 total
Time:        ~1.4 s
```

This confirms the Q1 finding: a missing combination is emitted as `''` inside a number-typed field (e.g., column `"1000"` → `[1, "", ""]`).

### 9.5 (Optional) Rebuild the Ephemeral Observation Harness

To independently reproduce OBS-A…G, create a temporary spec at `packages/grafana-data/src/transformations/transformers/zz_blitzy_observe.test.ts` that:

1. Stubs the registry: `mockTransformationsRegistry([groupingToMatrixTransformer])`.
2. Builds a sparse frame with `toDataFrame({ fields: [...] })` (include an absent pairing **and** a genuine present `0`).
3. Runs `transformDataFrame([{ id: DataTransformerID.groupingToMatrix, options }], [input])` and reads frames inside `.toEmitValuesWith((received) => { ... })`.
4. Drives the emitted field through `reduceField`, `getDisplayProcessor`, `getActiveThreshold`, and `getScaleCalculator`.

```bash
node_modules/.bin/jest \
  packages/grafana-data/src/transformations/transformers/zz_blitzy_observe.test.ts \
  --no-coverage --silent=false
```

> **Critical:** emit output with `process.stdout.write(...)`, **not** `console.log(...)` — `public/test/setupTests.ts` enables `jest-fail-on-console`, which fails any test that calls `console.log`.
>
> **Cleanup (mandatory, read-only scope):** delete the temp spec afterward and confirm `git status --short` is empty.

### 9.6 View the Deliverable

```bash
sed -n '1,60p' blitzy/documentation/grafana_4550cfb5b728.md
# First line: "# Grouping to matrix + sparse data: ..."
```

### 9.7 Verify Repository Cleanliness

```bash
git status --short                        # -> (empty) == clean
git diff 4550cfb5b7 --name-status         # -> A  blitzy/documentation/grafana_4550cfb5b728.md
```

### 9.8 Troubleshooting

- **`jest-haste-map: duplicate manual mock` warnings** — harmless monorepo noise (influxdb/loki/prometheus mocks); the run still exits 0.
- **Test fails with "Expected test not to call console.log()"** — you used `console.log`; switch to `process.stdout.write`.
- **"Cannot find module @grafana/data"** — run from the repo root and ensure `node_modules` is installed (§9.3).
- **Wrong Node version** — use the version in `.nvmrc` (`nvm use`); Jest config assumes Node ≥ 22.

---

## 10. Appendices

### A. Command Reference

| Purpose | Command |
|---|---|
| Node version | `node --version` |
| Yarn version | `yarn --version` |
| Install deps | `corepack enable && yarn install --immutable` |
| Run canonical test | `node_modules/.bin/jest packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts --no-coverage --silent` |
| View deliverable | `sed -n '1,60p' blitzy/documentation/grafana_4550cfb5b728.md` |
| Check cleanliness | `git status --short` |
| Diff vs base | `git diff 4550cfb5b7 --name-status` |

### B. Port Reference

Not applicable — no server or service is started for this read-only documentation task.

### C. Key File Locations

| Path | Role |
|---|---|
| `blitzy/documentation/grafana_4550cfb5b728.md` | **The deliverable** (answer document, 427 lines) |
| `packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts` | Transformer: default `Empty` fill (`:26`), `??` fill (`:117`), field type (`:133`), `getSpecialValue` (`:178-189`) |
| `packages/grafana-data/src/transformations/transformers/groupingToMatrix.test.ts` | Canonical test / harness template |
| `packages/grafana-data/src/types/transformations.ts` | `SpecialValue` enum (`:113-118`) — no Zero |
| `packages/grafana-data/src/transformations/fieldReducer.ts` | Totals: `reduceField` (`:159`), `calcs.sum += currentValue` (`:508`) |
| `packages/grafana-data/src/field/thresholds.ts` | `getActiveThreshold` (`:7`, `:15`) |
| `packages/grafana-data/src/field/scale.ts` | `getScaleCalculator` (`:19`, `:32`) |
| `packages/grafana-data/src/field/displayProcessor.ts` | Display coercion (`:96`, `:144`) |
| `packages/grafana-data/src/utils/anyToNumber.ts` | `anyToNumber('') → NaN` (`:12-14`) |
| `packages/grafana-ui/src/components/Table/utils.ts` | Footer totals via `reduceField` (`:404`) |
| `packages/grafana-ui/src/components/Table/DefaultCell.tsx` | Per-cell render (`:23`, `:50`) |
| `public/app/features/transformers/editors/GroupingToMatrixTransformerEditor.tsx` | Four selectable fill options (`:61-66`) |

### D. Technology Versions

| Component | Version |
|---|---|
| Node.js | v22.x (`.nvmrc` v22.11.0; verified v22.12.0) |
| Yarn | 4.5.3 |
| Jest | 29.7.0 |
| `@grafana/data` | 11.5.0-pre (`main=src/index.ts`) |
| rxjs | 7.8.1 |
| lodash | 4.17.21 |
| Repository HEAD | `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` |

### E. Environment Variable Reference

None required. The investigation runs entirely offline against local TypeScript source; no environment variables, secrets, or credentials are needed.

### F. Developer Tools Guide

- **Jest** — test runner used to build and run the observation harness (`transformDataFrame` + `.toEmitValuesWith`). Prevent watch mode with `--silent`/`--no-coverage`; never rely on `console.log` output (fail-on-console policy).
- **Git** — used to confirm the read-only mandate: `git status --short` (clean) and `git diff 4550cfb5b7 --name-status` (single file added).
- **Node one-liners** — `node -e "..."` used to confirm package resolution without a build.

### G. Glossary

| Term | Meaning |
|---|---|
| **Grouping to matrix** | Grafana transformation that pivots Column/Row/Value fields into a matrix (grid) of cells. |
| **`SpecialValue`** | Enum of fill values for empty cells: `True`, `False`, `Null`, `Empty` — **no** `Zero`. |
| **`??` (nullish coalescing)** | Replaces only `undefined`/`null`; a present `0` is therefore preserved. |
| **Sparse series** | Input where some `(column, row)` pairings never appear. |
| **Absent vs present-zero** | An *absent* pairing → `''` (string); a *present* `0` → numeric `0` — represented differently. |
| **Semantic shift** | The same `''` behaving as a corrupt string (totals), blank (display), or zero (thresholds/color). |
| **OBS-A…G** | Verbatim observed-output markers captured by the ephemeral harness. |
| **Path-to-production** | Remaining human activities (SME review, merge) beyond the autonomous work. |

---

*End of Blitzy Project Guide. Cross-section integrity validated: Remaining hours (3.5) are identical across Sections 1.2, 2.2, and 7; Section 2.1 (19.5) + Section 2.2 (3.5) = Total (23.0) in Section 1.2; completion 84.8% is consistent throughout; all listed tests originate from Blitzy's autonomous validation; brand colors applied (Completed `#5B39F3`, Remaining `#FFFFFF`).*