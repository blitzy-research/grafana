# Technical Specification

# 0. Agent Action Plan

## 0.1 Intent Clarification

### 0.1.1 Core Documentation Objective

Based on the provided requirements, the Blitzy platform understands that the documentation objective is to **create a comprehensive investigative document** that traces, explains, and provides runtime-observable evidence for the entire lifecycle of stale alert series detection and resolution within the Grafana Unified Alerting (ngalert) subsystem.

- **Category:** Create new documentation
- **Documentation Type:** Technical deep-dive / Investigative analysis document
- **Output File:** `blitzy/documentation/grafana_4550cfb5b728.md`

The user is investigating a performance issue where alert states for disappeared time series appear to linger longer than expected. The documentation must answer eight specific, interrelated questions by tracing actual code paths and providing verifiable runtime evidence. Each answer must be grounded in source code analysis rather than assumptions.

**Specific Documentation Requirements:**

- Trace the staleness detection formula and its boundary behavior when a time series vanishes from query results during an active multi-series alert evaluation
- Explain how the scheduler distinguishes a series that stopped reporting from one that is merely slow, by documenting the exact threshold and the relationship between `LastEvaluationTime` and `evaluatedAt`
- Document the interplay among `ResendDelay` (default 30s), `ResolvedRetention` (default 15m), and `LastSentAt` during repeated evaluation cycles for resolved alerts
- Determine whether stale series resolutions trigger the same screenshot capture path as natural resolutions
- Determine whether vanishing series honor the pending period (`For` duration) on their way to resolved
- Determine whether a reappearing series with identical labels is recognized as the same entity or treated as brand-new
- Provide runtime-observable evidence (temporary scripts, logging, metric queries) without modifying the repository itself
- Clean up any temporary observation artifacts after analysis

### 0.1.2 Special Instructions and Constraints

- **CRITICAL:** The repository itself must remain unchanged. No existing files may be modified. Temporary observation scripts may be created for runtime evidence gathering but must be cleaned up afterward.
- **CRITICAL:** The implementation rule requires the output to be a single Markdown document named `grafana_4550cfb5b728.md` placed in the `blitzy/documentation/` directory.
- The document must provide thinking and rationale behind all answers.
- All answers must be grounded in the actual source code as the source of truth — no assumptions.
- **Style:** Technical deep-dive narrative with code citations, diagrams, and worked examples demonstrating evaluation cycles
- **Depth:** Comprehensive — tracing from the scheduler tick through evaluation, state management, notification dispatch, and screenshot capture

### 0.1.3 Technical Interpretation

These documentation requirements translate to the following technical documentation strategy:

- To document the staleness detection threshold, we will trace the `stateIsStale` function in `pkg/services/ngalert/state/manager.go:627-629` and the `deleteStaleStatesFromCache` method at lines 586–625, showing how `lastEval + 2 * intervalSeconds <= evaluatedAt` determines the cutoff.
- To document the resolution lifecycle, we will trace `ProcessEvalResults` in `manager.go:307-355`, the `setNextState` method at lines 437–540, and the `NeedsSending` method in `state.go:500-520` to show how `ResendDelay`, `ResolvedRetention`, and `LastSentAt` interact during repeated evaluation cycles.
- To document screenshot behavior, we will compare the screenshot path in `deleteStaleStatesFromCache` (line 604–614 of `manager.go`) with the `shouldTakeImage` function in `state.go:581-585` and its test at `state_test.go:572-616`.
- To document pending period behavior for vanishing series, we will analyze how `deleteStaleStatesFromCache` unconditionally sets state to `Normal` regardless of prior `Pending` state, bypassing the `For` duration entirely.
- To document series identity and reappearance, we will trace the `cache.create` method in `cache.go:146-219` showing that `CacheID = lbs.Fingerprint()` is the identity key and that stale deletion removes the cache entry, causing reappearing series to be treated as new.
- To provide runtime evidence, we will create temporary Go test scripts and diagnostic queries that can observe these behaviors in a running Grafana instance.

### 0.1.4 Inferred Documentation Needs

Based on code analysis, the following implicit documentation needs were identified:

- The `nextEndsTime` function (`state.go:534-544`) computes the alert expiry horizon as `4 * max(ResendDelay, interval)`, synchronized with Prometheus behavior — this must be documented to explain why alerts appear to linger even after resolution.
- The `FromAlertsStateToStoppedAlert` function (`compat.go:143-155`) filters expired transitions only for previously-firing states (Alerting, Error, NoData) — Normal and Pending states are excluded from expiration notifications.
- The `StateToPostableAlert` function (`compat.go:29-99`) uses `PreviousState` when `ResolvedAt` is set to correctly expire NoData/Error alerts via label rewriting — this resolved-alert label behavior must be explained.
- The `resultKeepLast` path in `state.go:470-493` interacts with staleness because KeepLast rules may hold Alerting state longer before staleness kicks in — this edge case warrants mention.
- The `StateReason` annotation system (`models/alert_rule.go:160-166`) provides the `grafana_state_reason=MissingSeries` annotation that operators use for troubleshooting — this must be documented as the primary diagnostic signal.


## 0.2 Documentation Discovery and Analysis

### 0.2.1 Existing Documentation Infrastructure Assessment

Repository analysis reveals a **Hugo-based documentation framework** in `docs/sources/` with Markdown content files, alongside Go package-level README files providing developer-facing architectural narratives. The documentation infrastructure includes:

- **Documentation framework:** Hugo static site generator with Grafana's custom docs tooling (`docs/make-docs`, `docs/docs.mk`, `docs/Makefile`)
- **Documentation generator configuration:** `docs/Makefile` at repository root, with `docs.mk` and `variables.mk` for build orchestration
- **Alerting docs location:** `docs/sources/alerting/` — contains user-facing alerting documentation
- **Key alerting docs found:**
  - `docs/sources/alerting/fundamentals/alert-rule-evaluation/_index.md` — Alert rule evaluation mechanics, pending period, evaluation group
  - `docs/sources/alerting/fundamentals/alert-rule-evaluation/state-and-health.md` — Alert states, stale instance lifecycle, No Data/Error handling, `grafana_state_reason`
- **Developer architecture docs:** `pkg/services/ngalert/README.md` — Package-level overview of scheduling, evaluation, state management, and notification flow
- **API documentation tools:** None specifically for the alerting Go code (no Godoc generation configured)
- **Diagram tools:** Mermaid (used in existing docs via commented Mermaid blocks in `_index.md`)

### 0.2.2 Repository Code Analysis for Documentation

Search patterns used to identify code files relevant to the documentation:

**Core State Management (primary targets):**
- `pkg/services/ngalert/state/manager.go` — State manager: `ProcessEvalResults`, `deleteStaleStatesFromCache`, `stateIsStale`, `updateLastSentAt`
- `pkg/services/ngalert/state/state.go` — State model: `NeedsSending`, `shouldTakeImage`, `nextEndsTime`, `resultAlerting`, `resultNormal`, `resultKeepLast`, state setters
- `pkg/services/ngalert/state/cache.go` — Cache: `create` (identity computation via label fingerprinting), `deleteRuleStates`, `set`, `get`
- `pkg/services/ngalert/state/compat.go` — `StateToPostableAlert`, `FromAlertsStateToStoppedAlert` — conversion to Alertmanager postable alerts

**Scheduler (evaluation dispatch):**
- `pkg/services/ngalert/schedule/schedule.go` — Scheduler: `Run`, `schedulePeriodic`, `processTick`
- `pkg/services/ngalert/schedule/alert_rule.go` — Alert rule runtime: `Run`, `evaluate`, `send`, `expireAndSend`
- `pkg/services/ngalert/schedule/loaded_metrics_reader.go` — `AlertingResultsFromRuleState.Read` filtering active fingerprints

**Evaluation Engine:**
- `pkg/services/ngalert/eval/eval.go` — Evaluator: `Evaluate`, result processing, state enum definitions

**Models and Configuration:**
- `pkg/services/ngalert/models/alert_rule.go` — State reason constants: `StateReasonMissingSeries`, `StateReasonKeepLast`, etc.
- `pkg/setting/setting_unified_alerting.go` — Configuration: `ResolvedAlertRetention` default of 15 minutes

**Test Coverage (behavioral evidence):**
- `pkg/services/ngalert/state/manager_private_test.go` — `TestStateIsStale` boundary tests, `TestProcessEvalResults_StateTransitions` exhaustive multi-dimensional state transitions
- `pkg/services/ngalert/state/manager_test.go` — `TestStaleResultsHandler`, `TestStaleResults` — stale removal and resolved notification verification
- `pkg/services/ngalert/state/state_test.go` — `TestNeedsSending`, `TestShouldTakeImage`, `TestTakeImage`
- `pkg/services/ngalert/schedule/alert_rule_test.go` — Resolved retention and resend delay integration test

**Existing related documentation found:**
- `docs/sources/alerting/fundamentals/alert-rule-evaluation/state-and-health.md` provides user-facing explanation of stale instances: "An alert instance is considered stale if its dimension or series has disappeared from the query results entirely for two evaluation intervals."

### 0.2.3 Web Search Research Conducted

No external web research was required for this documentation task. All answers are derived exclusively from the source code as the authoritative truth, per the user's instruction to base all conclusions on the code rather than assumptions. The Grafana documentation within the repository provides sufficient context for architectural understanding.


## 0.3 Documentation Scope Analysis

### 0.3.1 Code-to-Documentation Mapping

**Module: `pkg/services/ngalert/state/manager.go` — State Manager**
- Public APIs: `ProcessEvalResults`, `DeleteStateByRuleUID`, `ResetStateByRuleUID`, `Warm`, `Get`, `GetAll`, `GetStatesForRuleUID`, `Put`
- Internal methods: `setNextStateForRule`, `setNextState`, `deleteStaleStatesFromCache`, `stateIsStale`, `updateLastSentAt`
- Current documentation: Partially covered in `pkg/services/ngalert/README.md` at a high level; no per-function documentation exists
- Documentation needed: Detailed walkthrough of `ProcessEvalResults` flow, the stale detection formula, and the `updateLastSentAt` notification gating logic

**Module: `pkg/services/ngalert/state/state.go` — State Model**
- Public APIs: `NeedsSending`, `shouldTakeImage`, `takeImage`, `nextEndsTime`, `SetAlerting`, `SetPending`, `SetNormal`, `Maintain`, `IsStale`
- State transition handlers: `resultNormal`, `resultAlerting`, `resultError`, `resultNoData`, `resultKeepLast`
- Current documentation: Inline Go comments; no external documentation
- Documentation needed: The `NeedsSending` decision tree, the `shouldTakeImage` decision matrix, the `nextEndsTime` expiry calculation, and the interaction between `ResolvedAt`, `LastSentAt`, and `ResendDelay`

**Module: `pkg/services/ngalert/state/cache.go` — State Cache**
- Public APIs: `create`, `set`, `get`, `deleteRuleStates`, `removeByRuleUID`
- Current documentation: None beyond inline comments
- Documentation needed: How `CacheID = lbs.Fingerprint()` determines series identity, and how deletion + recreation handles reappearing series

**Module: `pkg/services/ngalert/schedule/alert_rule.go` — Alert Rule Runtime**
- Public APIs: `Run`, `Eval`, `Update`, `Stop`, `evaluate`, `send`
- Current documentation: Covered in `README.md` at architectural level
- Documentation needed: How the evaluation loop dispatches results to `ProcessEvalResults` with the `send` callback, and how `expireAndSend` handles rule deletion

**Module: `pkg/setting/setting_unified_alerting.go` — Configuration**
- Configuration option: `resolved_alert_retention` (default: 15 minutes)
- Documentation needed: How this setting controls the resolved notification retention window

### 0.3.2 Documentation Gap Analysis

Given the requirements and repository analysis, documentation gaps include:

- **No existing document traces the full staleness lifecycle end-to-end** — from series disappearance through stale detection, state transition, screenshot capture, notification dispatch, and eventual notification cessation
- **The staleness formula `lastEval + 2 * interval <= evaluatedAt` is not explained** in any developer-facing or user-facing doc with code-level precision
- **The interplay of `ResendDelay`, `ResolvedRetention`, and `LastSentAt`** is documented only as inline Go comments in `NeedsSending`; no external document walks through evaluation cycle examples
- **Screenshot behavior divergence** between stale Alerting resolutions and stale non-Alerting resolutions is not documented anywhere
- **Pending period bypass for vanishing series** is not explicitly documented — the user-facing docs say instances "transition to Normal as Resolved" but do not mention that Pending states skip the For duration
- **Series reappearance after staleness** is not documented — the fact that cache deletion causes identity loss for identical label sets is implicit in the code but not stated anywhere
- **Runtime observability techniques** for diagnosing staleness behavior are not documented


## 0.4 Documentation Implementation Design

### 0.4.1 Documentation Structure Planning

The output is a single comprehensive Markdown document structured as follows:

```
blitzy/documentation/
└── grafana_4550cfb5b728.md
    ├── Introduction & Context
    ├── 1. The Staleness Detection Formula
    │   ├── The Threshold Boundary
    │   ├── Worked Example (30s interval)
    │   └── Mermaid Timeline Diagram
    ├── 2. How Stale Series Get Detected and Resolved
    │   ├── The ProcessEvalResults Flow
    │   ├── deleteStaleStatesFromCache Walkthrough
    │   └── Multi-Series Partial Disappearance Scenario
    ├── 3. Scheduler: Stopped vs Slow Series
    │   ├── Why the Scheduler Cannot Distinguish
    │   └── The 2-Interval Grace Period Rationale
    ├── 4. The Notification Retention Dance
    │   ├── ResendDelay, ResolvedRetention, LastSentAt
    │   ├── NeedsSending Decision Tree
    │   └── Worked Example: 10 Evaluation Cycles
    ├── 5. Screenshot Capture: Stale vs Natural Resolution
    │   ├── shouldTakeImage Decision Matrix
    │   ├── Stale Alerting → Normal: Screenshots Taken
    │   └── Stale Pending/Normal → Normal: No Screenshots
    ├── 6. Pending Period and Vanishing Series
    │   ├── Pending States Skip the For Duration
    │   └── ResolvedAt Only Set for Alerting→Normal
    ├── 7. Series Identity: Vanish and Reappear
    │   ├── CacheID = Label Fingerprint
    │   ├── Stale Deletion Erases Memory
    │   └── Reappearance Creates Brand-New Instance
    ├── 8. Runtime Observability Techniques
    │   ├── Temporary Diagnostic Script
    │   ├── Prometheus Metric Queries
    │   └── Log Inspection Patterns
    └── References
```

### 0.4.2 Content Generation Strategy

**Information Extraction Approach:**
- Extract the `stateIsStale` formula from `pkg/services/ngalert/state/manager.go:627-629`
- Extract the `NeedsSending` decision logic from `pkg/services/ngalert/state/state.go:500-520`
- Extract the `shouldTakeImage` conditions from `pkg/services/ngalert/state/state.go:581-585`
- Extract the `deleteStaleStatesFromCache` resolution behavior from `pkg/services/ngalert/state/manager.go:586-625`
- Extract cache identity computation from `pkg/services/ngalert/state/cache.go:146-177`
- Generate worked examples by analyzing `pkg/services/ngalert/state/manager_private_test.go` test scenarios (TestStateIsStale at line 41, TestProcessEvalResults_StateTransitions at line 119)
- Generate notification flow examples by analyzing `pkg/services/ngalert/schedule/alert_rule_test.go:792-846` resolved retention test

**Documentation Standards:**
- Markdown formatting with proper headers (`#`, `##`, `###`)
- Mermaid diagram integration for state transitions, evaluation timelines, and decision trees
- Code snippets with Go syntax highlighting, citing exact file paths and line numbers: `Source: pkg/services/ngalert/state/manager.go:627`
- Tables for parameter descriptions, state transition matrices, and comparison matrices
- Consistent terminology: "stale" for disappeared series, "resolved" for Alerting→Normal transitions, "evaluation cycle" for each scheduler tick

### 0.4.3 Diagram and Visual Strategy

Mermaid diagrams to create in the output document:

- **State transition diagram:** Showing all paths through Normal, Pending, Alerting states with stale branch highlighted
- **Evaluation timeline:** Showing a 5-cycle sequence where a series vanishes at cycle 3, becomes stale at cycle 5, and resolved notifications flow until retention expires
- **Decision flowchart for `NeedsSending`:** Three-gate decision tree showing the Pending gate, ResolvedAt gate, and ResendDelay gate
- **Screenshot decision matrix:** When screenshots are captured for stale vs natural resolutions
- **Cache identity diagram:** How label fingerprinting, deletion, and recreation affect series identity


## 0.5 Documentation File Transformation Mapping

### 0.5.1 File-by-File Documentation Plan

| Target Documentation File | Transformation | Source Code/Docs | Content/Changes |
|---------------------------|----------------|------------------|-----------------|
| `blitzy/documentation/grafana_4550cfb5b728.md` | CREATE | `pkg/services/ngalert/state/manager.go`, `pkg/services/ngalert/state/state.go`, `pkg/services/ngalert/state/cache.go`, `pkg/services/ngalert/state/compat.go`, `pkg/services/ngalert/schedule/alert_rule.go`, `pkg/services/ngalert/schedule/schedule.go`, `pkg/services/ngalert/eval/eval.go`, `pkg/services/ngalert/models/alert_rule.go`, `pkg/setting/setting_unified_alerting.go`, `pkg/services/ngalert/state/manager_private_test.go`, `pkg/services/ngalert/state/manager_test.go`, `pkg/services/ngalert/state/state_test.go`, `pkg/services/ngalert/schedule/alert_rule_test.go`, `docs/sources/alerting/fundamentals/alert-rule-evaluation/state-and-health.md`, `pkg/services/ngalert/README.md` | Complete investigative document answering all eight user questions with code-grounded evidence, Mermaid diagrams, worked evaluation cycle examples, runtime observability techniques, and source citations |

This is the sole documentation file to be created. No existing files in the repository will be modified per the user's explicit constraint and the implementation rule.

### 0.5.2 New Documentation File Detail

```
File: blitzy/documentation/grafana_4550cfb5b728.md
Type: Technical Deep-Dive / Investigative Analysis
Source Code:
  - pkg/services/ngalert/state/manager.go (ProcessEvalResults, deleteStaleStatesFromCache, stateIsStale, updateLastSentAt)
  - pkg/services/ngalert/state/state.go (NeedsSending, shouldTakeImage, nextEndsTime, resultAlerting, resultNormal)
  - pkg/services/ngalert/state/cache.go (create, deleteRuleStates, CacheID fingerprinting)
  - pkg/services/ngalert/state/compat.go (StateToPostableAlert, FromAlertsStateToStoppedAlert)
  - pkg/services/ngalert/schedule/alert_rule.go (Run, evaluate, send, expireAndSend)
  - pkg/services/ngalert/schedule/schedule.go (schedulePeriodic, processTick)
  - pkg/services/ngalert/eval/eval.go (State enum, Results model)
  - pkg/services/ngalert/models/alert_rule.go (StateReasonMissingSeries, StateReason constants)
  - pkg/setting/setting_unified_alerting.go (ResolvedAlertRetention default 15m)
Sections:
  - Introduction explaining the investigation context
  - Section 1: Staleness Detection Formula — stateIsStale logic, 2-interval threshold, boundary tests
  - Section 2: Stale Series Resolution Lifecycle — deleteStaleStatesFromCache walkthrough, state transitions
  - Section 3: Stopped vs Slow Series — why the scheduler cannot distinguish, grace period rationale
  - Section 4: Notification Retention Interplay — ResendDelay/ResolvedRetention/LastSentAt dance, NeedsSending logic
  - Section 5: Screenshot Capture Paths — shouldTakeImage conditions, stale vs natural comparison
  - Section 6: Pending Period Bypass — deleteStaleStatesFromCache ignores For duration
  - Section 7: Series Identity on Reappearance — CacheID fingerprinting, cache deletion, brand-new treatment
  - Section 8: Runtime Observability — temporary diagnostic scripts, metric queries, log patterns
  - References section with all source file citations
Diagrams:
  - State transition diagram with stale branches
  - Evaluation cycle timeline for partial series disappearance
  - NeedsSending decision flowchart
  - Screenshot capture decision matrix
  - Cache identity lifecycle diagram
Key Citations:
  - pkg/services/ngalert/state/manager.go:627-629 (staleIsStale formula)
  - pkg/services/ngalert/state/state.go:500-520 (NeedsSending)
  - pkg/services/ngalert/state/state.go:581-585 (shouldTakeImage)
  - pkg/services/ngalert/state/manager.go:586-625 (deleteStaleStatesFromCache)
  - pkg/services/ngalert/state/cache.go:146-177 (cache.create identity)
  - pkg/setting/setting_unified_alerting.go:465 (ResolvedAlertRetention default)
```

### 0.5.3 Documentation Configuration Updates

No documentation configuration updates are required. The output file is a standalone Markdown document placed in the `blitzy/documentation/` directory, which does not participate in the Grafana Hugo docs build pipeline or any navigation configuration.

### 0.5.4 Cross-Documentation Dependencies

- The document will reference the existing user-facing alerting docs at `docs/sources/alerting/fundamentals/alert-rule-evaluation/state-and-health.md` for context on the user-facing description of stale instances
- The document will reference the developer README at `pkg/services/ngalert/README.md` for the architectural overview of the scheduling and evaluation pipeline
- No navigation links, table of contents updates, or index changes are needed since the output is a standalone document in a separate directory


## 0.6 Dependency Inventory

### 0.6.1 Documentation Dependencies

The following tools and packages are relevant to this documentation exercise:

| Registry | Package Name | Version | Purpose |
|----------|--------------|---------|---------|
| Go | go | 1.23.1 | Runtime for the Grafana backend — required for compiling and running temporary diagnostic test scripts |
| Go module | github.com/grafana/grafana | (monorepo) | The Grafana monorepo itself — all source code analysis is within this module |
| Go module | github.com/benbjohnson/clock | (per go.mod) | Mock clock used in state manager tests — relevant for understanding time-based staleness behavior |
| Go module | github.com/grafana/grafana-plugin-sdk-go/data | (per go.mod) | Provides `data.Fingerprint` and `data.Labels` — central to cache identity computation |
| Go module | github.com/prometheus/common/model | (per go.mod) | Provides `AlertNameLabel` and label model constants used in alert-to-notification conversion |
| Hugo | docs build tooling | (per docs/Makefile) | Documentation site generator — relevant for understanding existing docs structure only |

### 0.6.2 Documentation Reference Updates

No documentation files require link updates. The output document is standalone and does not modify or depend on existing documentation links. Internal cross-references within the output document will use relative section anchors only.


## 0.7 Coverage and Quality Targets

### 0.7.1 Documentation Coverage Metrics

**Current coverage analysis for the user's eight questions:**

| Question | Source Files Identified | Coverage Status |
|----------|----------------------|-----------------|
| How stale series are detected and resolved | `manager.go:586-629`, `state.go:574-576` | Fully traceable |
| How scheduler distinguishes stopped vs slow series | `manager.go:627-629`, `manager_private_test.go:41-81` | Fully traceable |
| Staleness detection threshold formula | `manager.go:627-629` | Fully traceable |
| ResendDelay / ResolvedRetention / LastSentAt interplay | `state.go:500-520`, `manager.go:357-368`, `setting_unified_alerting.go:465` | Fully traceable |
| Screenshot capture for stale vs natural resolution | `manager.go:604-614`, `state.go:581-585`, `state_test.go:572-616` | Fully traceable |
| Pending period behavior for vanishing series | `manager.go:586-625` (no For check), `state.go:316-370` (resultAlerting For check) | Fully traceable |
| Series identity on vanish and reappear | `cache.go:146-177`, `cache.go:244-263` | Fully traceable |
| Runtime observability techniques | Test files, Prometheus metrics in `metrics.go`, log statements | Derivable from code |

- **Questions fully answerable from code:** 8/8 (100%)
- **Target coverage:** 100% — every question answered with code citations and worked examples

### 0.7.2 Documentation Quality Criteria

**Completeness requirements:**
- Every question has a dedicated section with: (a) the code-level answer, (b) the reasoning/rationale, (c) file path citations, (d) a worked example or timeline
- All state transitions involving staleness are covered: Normal→Normal(MissingSeries), Alerting→Normal(MissingSeries), Pending→Normal(MissingSeries), NoData→Normal(MissingSeries), Error→Normal(MissingSeries)
- The notification flow is traced through at least 10 evaluation cycles showing exactly when sends occur and when they stop

**Accuracy validation:**
- Every claim must reference a specific file path and line range
- The staleness formula must be verified against `TestStateIsStale` boundary tests in `manager_private_test.go:41-81`
- The `NeedsSending` behavior must be verified against `TestNeedsSending` in `state_test.go:351-513`
- The screenshot behavior must be verified against `TestShouldTakeImage` in `state_test.go:572-616`
- The resolved retention test at `alert_rule_test.go:792-846` must be used to verify the notification cessation timeline

**Clarity standards:**
- Technical accuracy with accessible language — the document should be understandable by a Grafana operator investigating alert behavior
- Progressive disclosure: start with the formula, then trace the lifecycle, then walk through examples
- Consistent terminology: "stale" = disappeared series, "resolved" = transitioned from Alerting to Normal, "evaluation cycle" = one scheduler tick

### 0.7.3 Example and Diagram Requirements

- **Minimum worked examples:** 3 (staleness boundary, notification retention cycles, multi-series partial disappearance)
- **Mermaid diagrams required:** 5 (state transition, evaluation timeline, NeedsSending flowchart, screenshot decision, cache identity lifecycle)
- **Code example verification:** All Go code snippets are excerpts from actual source files with exact line citations — no fabricated code
- **Runtime evidence:** At least one temporary diagnostic approach (test script, metric query, or log pattern) per major question


## 0.8 Scope Boundaries

### 0.8.1 Exhaustively In Scope

**New documentation files:**
- `blitzy/documentation/grafana_4550cfb5b728.md` — The sole output artifact

**Source code analysis targets (read-only, for content extraction):**
- `pkg/services/ngalert/state/manager.go` — `ProcessEvalResults`, `deleteStaleStatesFromCache`, `stateIsStale`, `updateLastSentAt`, `setNextState`, `setNextStateForRule`
- `pkg/services/ngalert/state/state.go` — `NeedsSending`, `shouldTakeImage`, `takeImage`, `nextEndsTime`, `resultNormal`, `resultAlerting`, `resultError`, `resultNoData`, `resultKeepLast`, `SetAlerting`, `SetPending`, `SetNormal`, `Maintain`, `IsStale`
- `pkg/services/ngalert/state/cache.go` — `create`, `set`, `get`, `deleteRuleStates`, `removeByRuleUID`, `mergeLabels`
- `pkg/services/ngalert/state/compat.go` — `StateToPostableAlert`, `FromAlertsStateToStoppedAlert`, `noDataAlert`, `errorAlert`
- `pkg/services/ngalert/schedule/alert_rule.go` — `Run`, `evaluate`, `send`, `expireAndSend`, `resetState`
- `pkg/services/ngalert/schedule/schedule.go` — `Run`, `schedulePeriodic`, `processTick`, `deleteAlertRule`
- `pkg/services/ngalert/schedule/loaded_metrics_reader.go` — `AlertingResultsFromRuleState.Read`
- `pkg/services/ngalert/eval/eval.go` — `State` enum, `Results`, `Result`, `ExecutionResults`
- `pkg/services/ngalert/models/alert_rule.go` — `StateReasonMissingSeries`, `StateReasonKeepLast`, `ConcatReasons`, state reason constants
- `pkg/setting/setting_unified_alerting.go` — `ResolvedAlertRetention` configuration
- `pkg/services/ngalert/README.md` — Architectural overview
- `docs/sources/alerting/fundamentals/alert-rule-evaluation/state-and-health.md` — User-facing stale lifecycle docs

**Test files (read-only, for behavioral verification):**
- `pkg/services/ngalert/state/manager_private_test.go` — `TestStateIsStale`, `TestProcessEvalResults_StateTransitions`
- `pkg/services/ngalert/state/manager_test.go` — `TestStaleResultsHandler`, `TestStaleResults`
- `pkg/services/ngalert/state/state_test.go` — `TestNeedsSending`, `TestShouldTakeImage`, `TestTakeImage`
- `pkg/services/ngalert/schedule/alert_rule_test.go` — Resolved retention and resend delay integration test

**Temporary diagnostic artifacts (created and cleaned up):**
- Temporary Go test scripts for runtime observation of staleness behavior
- Any temporary helper files in a temporary directory

### 0.8.2 Explicitly Out of Scope

- **Source code modifications:** No existing files in the Grafana repository will be modified (per explicit user instruction and implementation rule)
- **Test file modifications:** No test files will be modified or created permanently
- **Feature additions or code refactoring:** This is a documentation-only exercise
- **External Alertmanager notification pipeline:** The document focuses on the Grafana-side state management and notification dispatch, not the downstream Alertmanager routing, grouping, silencing, or receiver stages
- **Data-source-managed alert rules:** The analysis focuses on Grafana-managed alert rules where stale detection is applicable
- **Recording rules:** The `recordingRule` worker in `schedule/recording_rule.go` is excluded as staleness detection applies only to alerting rules
- **Provisioning, RBAC, and access control:** These subsystems do not interact with the staleness lifecycle
- **Frontend/UI alert state display:** Only backend alerting pipeline behavior is in scope
- **Non-alerting Grafana subsystems:** Dashboard rendering, plugin management, data source configuration, etc.


## 0.9 Execution Parameters

### 0.9.1 Documentation-Specific Instructions

- **Documentation build command:** Not applicable — the output is a standalone Markdown file, not integrated into the Hugo docs pipeline
- **Documentation preview command:** Standard Markdown preview via a text viewer
- **Diagram generation command:** Mermaid diagrams are embedded inline in the Markdown using fenced mermaid code blocks; no external generation step required
- **Default format:** Markdown with Mermaid diagrams
- **Citation requirement:** Every technical claim must reference its source file path and line number(s). Format: `Source: pkg/services/ngalert/state/manager.go:627-629`
- **Style guide:** Technical deep-dive narrative suitable for a Grafana backend engineer investigating alert staleness behavior. Code excerpts are short (2-5 lines), always with file citations. Worked examples use concrete numbers (e.g., 30s interval, specific timestamps).
- **Temporary script policy:** Temporary Go test scripts or diagnostic scripts may be created in a temporary directory for observation. These must be cleaned up after use. The repository must remain unchanged.
- **Runtime verification:** Where applicable, include temporary test scripts that can be compiled with `go test` to demonstrate staleness behavior against the actual codebase. Include commands to run them and commands to clean them up.

### 0.9.2 Environment Configuration

- **Go version:** 1.23.1 (from go.mod)
- **Module path:** github.com/grafana/grafana
- **Test execution example:** `go test ./pkg/services/ngalert/state/ -run TestStateIsStale -v` (for verifying staleness formula)
- **Repository root:** The repository root where source analysis was performed


## 0.10 Rules for Documentation

The following rules are explicitly derived from the user's instructions and the project's implementation rules:

- **Do not modify any existing files in the source repository.** The repository must remain entirely unchanged. This applies to all Go source files, test files, configuration files, documentation files, and any other tracked files.
- **Create the output as a single Markdown document named `grafana_4550cfb5b728.md`** placed in the `blitzy/documentation/` directory.
- **Provide thinking and rationale behind all answers.** Every conclusion must include the reasoning chain that led to it, referencing specific code paths and data flow.
- **Do not make assumptions — base all answers on the code as the truth.** Every claim must be traceable to a specific source file, function, and line range. Speculation about behavior not evidenced in the code must be explicitly flagged as such.
- **Temporary scripts may be used for observation but must be cleaned up afterward.** Any diagnostic Go test files, shell scripts, or helper artifacts created during runtime evidence gathering must be removed upon completion. The goal is observation, not modification.
- **The document should show actual runtime evidence** rather than merely explaining theory. This means: include concrete examples of how to invoke tests, inspect logs, query metrics, and observe state transitions in a running or test-instrumented Grafana instance.
- **All Mermaid diagrams must be syntactically valid** and renderable by standard Mermaid processors. No nested triple-backtick blocks inside diagram definitions.
- **Code citations must use the format** `Source: <relative_file_path>:<line_range>` for traceability.


## 0.11 References

### 0.11.1 Source Files Searched and Analyzed

The following files and folders were comprehensively searched across the codebase to derive the conclusions in this Agent Action Plan:

**Core State Management:**
| File Path | Key Content Extracted |
|-----------|----------------------|
| `pkg/services/ngalert/state/manager.go` | `ProcessEvalResults` (L307-355), `deleteStaleStatesFromCache` (L586-625), `stateIsStale` (L627-629), `updateLastSentAt` (L357-368), `setNextState` (L437-540), `setNextStateForRule` (L370-418), `NewManager` (L88-119), `Warm` (L126-227), `DeleteStateByRuleUID` (L236-281), `ResendDelay` default 30s (L24) |
| `pkg/services/ngalert/state/state.go` | `NeedsSending` (L500-520), `shouldTakeImage` (L581-585), `takeImage` (L589-600), `nextEndsTime` (L534-544), `resultNormal` (L297-314), `resultAlerting` (L316-370), `resultError` (L372-423), `resultNoData` (L425-468), `resultKeepLast` (L470-493), `IsStale` (L574-576), `Maintain` (L171-173), `State` struct (L25-77), `StateTransition` type (L242-246) |
| `pkg/services/ngalert/state/cache.go` | `create` with CacheID = lbs.Fingerprint() (L146-219), `deleteRuleStates` (L255-263), `set` (L274-284), `get` (L286-298), `removeByRuleUID` (L337-357), `expandAnnotationsAndLabels` (L74-144) |
| `pkg/services/ngalert/state/compat.go` | `StateToPostableAlert` (L35-99), `FromAlertsStateToStoppedAlert` (L143-155), `noDataAlert` (L105-120), `errorAlert` (L124-139) |

**Scheduler and Evaluation:**
| File Path | Key Content Extracted |
|-----------|----------------------|
| `pkg/services/ngalert/schedule/alert_rule.go` | `Run` loop (L242-362), `evaluate` (L364-459), `send` (L462-473), `expireAndSend` (L476-481), `resetState` (L483-491), `alertRule` struct (L114-139) |
| `pkg/services/ngalert/schedule/schedule.go` | `Run` (L-), `schedulePeriodic`, `processTick` — scheduler lifecycle and rule dispatch |
| `pkg/services/ngalert/schedule/loaded_metrics_reader.go` | `AlertingResultsFromRuleState.Read` — active fingerprint filtering for Alerting/Pending states without reason |
| `pkg/services/ngalert/eval/eval.go` | `State` enum (Normal, Alerting, Pending, NoData, Error), `Results` helpers, `Result` struct |

**Models and Configuration:**
| File Path | Key Content Extracted |
|-----------|----------------------|
| `pkg/services/ngalert/models/alert_rule.go` | `StateReasonMissingSeries = "MissingSeries"` (L160), `StateReasonKeepLast` (L166), `ConcatReasons` (L169), all state reason constants (L160-166) |
| `pkg/setting/setting_unified_alerting.go` | `ResolvedAlertRetention` default 15 minutes (L125, L465) |
| `go.mod` | Go version 1.23.1 (L3) |

**Test Files (Behavioral Verification):**
| File Path | Key Content Extracted |
|-----------|----------------------|
| `pkg/services/ngalert/state/manager_private_test.go` | `TestStateIsStale` (L41-81) — boundary verification at exactly 2 intervals; `TestProcessEvalResults_StateTransitions` (L119+) — exhaustive multi-dimensional state transition scenarios including MissingSeries transitions |
| `pkg/services/ngalert/state/manager_test.go` | `TestStaleResultsHandler` (L1695-1844) — stale cache removal and state verification; `TestStaleResults` (L1846-1976) — stale marking, cache removal, database deletion, ResolvedAt verification |
| `pkg/services/ngalert/state/state_test.go` | `TestNeedsSending` (L351-513) — 12 test cases covering all NeedsSending decision paths; `TestShouldTakeImage` (L572-616) — screenshot decision matrix; `TestTakeImage` (L618+) — screenshot error handling |
| `pkg/services/ngalert/schedule/alert_rule_test.go` | Resolved retention integration test (L792-846) — 10 evaluations verifying 3 resolve sends before retention expires |

**Documentation Files:**
| File Path | Key Content Extracted |
|-----------|----------------------|
| `docs/sources/alerting/fundamentals/alert-rule-evaluation/state-and-health.md` | User-facing explanation: "stale if disappeared for two evaluation intervals", notification routing, grafana_state_reason annotation |
| `docs/sources/alerting/fundamentals/alert-rule-evaluation/_index.md` | Evaluation group, pending period, state diagram, evaluation example |
| `pkg/services/ngalert/README.md` | Architectural overview of scheduling, evaluation, state management, and notification delivery |

### 0.11.2 Attachments

No attachments were provided by the user for this project.

### 0.11.3 Figma Screens

No Figma screens were provided for this project.

### 0.11.4 Key Findings Summary

The code analysis conclusively answers all eight user questions:

| Question | Answer Summary | Primary Evidence |
|----------|---------------|-----------------|
| Staleness detection formula | `lastEval + 2 * intervalSeconds <= evaluatedAt` | `manager.go:627-629` |
| Stopped vs slow series | Scheduler cannot distinguish; uses a fixed 2-interval grace period | `manager.go:627-629`, `manager_private_test.go:41-81` |
| What happens to disappeared series | Force-set to Normal with reason MissingSeries, removed from cache | `manager.go:586-625` |
| ResendDelay/ResolvedRetention/LastSentAt dance | 3-gate decision: Pending gate → ResolvedAt gate → ResendDelay gate; resolved alerts resent every 30s for up to 15m | `state.go:500-520`, `setting_unified_alerting.go:465` |
| Screenshot capture for stale series | Only taken if old state was Alerting; Pending/Normal stale series get no screenshot | `manager.go:604-614`, `state.go:581-585` |
| Pending period on vanishing series | Bypassed entirely; Pending→Normal(MissingSeries) with no For wait | `manager.go:586-625` (no For check) |
| Reappearing series identity | Treated as brand-new; stale deletion removes cache entry, same CacheID is recreated fresh | `cache.go:146-177`, `cache.go:244-263` |
| Runtime observability | Test commands, Prometheus metrics, log patterns for MissingSeries | Test files, metrics package |


