# Technical Specification

# 0. Agent Action Plan

## 0.1 Intent Clarification

### 0.1.1 Core Documentation Objective

Based on the provided requirements, the Blitzy platform understands that the documentation objective is to **create a new investigative Q&A document** that explains and demonstrates the runtime behavior of the Grafana unified alerting (ngalert) subsystem under stress conditions, grounded entirely in evidence from the source code and observable runtime output. The document must answer a series of tightly interlinked questions about scheduling priority, cancellation semantics, result ordering, and observable runtime indicators — and must back each answer with live experimental evidence.

- **Category:** Create new documentation
- **Documentation type:** Technical deep-dive / Q&A investigation document
- **Target file:** `blitzy/documentation/grafana_4550cfb5b728.md`

The user's requirements, restated with technical precision, are:

- **Scheduling under contention:** When a burst of alert rule version changes coincides with the scheduler falling behind its heartbeat tick (`grafana_alerting_scheduler_behind_seconds` > 0) and one or more data sources begin returning timeout errors during evaluation, how does the scheduler in `pkg/services/ngalert/schedule/schedule.go:processTick()` decide which rules to dispatch next, and which Prometheus metrics, log lines, or trace spans first surface that decision?
- **Cancellation and cleanup semantics:** When a rule evaluation is canceled mid-flight (because the rule's context is canceled via `util.CancelCauseFunc` in `alert_rule.go`) or when a rule is deleted while its goroutine is active (via `deleteAlertRule()` → `Stop(errRuleDeleted)`), does the state cache in `pkg/services/ngalert/state/cache.go` retain orphaned entries, or does the system cleanly invoke `DeleteStateByRuleUID()` and send expiry alerts? What runtime signs differentiate these paths?
- **Evaluation result ordering:** Since each rule's goroutine receives `*Evaluation` events through a dedicated unbuffered channel (`evalCh chan *Evaluation`), and the scheduler sends evaluations via `time.AfterFunc` with staggered delays sorted by rule UID, do evaluation results ever appear out of order across ticks? If not, what observable behavior (log timestamps, trace attributes, metric counters) confirms ordering is preserved?
- **Live exercise requirement:** The user explicitly requests that these behaviors be exercised with live runtime output. Temporary scripts for observation are acceptable, but the repository must remain unmodified and any temporary files must be cleaned up afterward.
- **Stressed vs. normal comparison:** Run the same scenario under normal load and describe what visibly changes in timing, volume, or rhythm of observable outputs.

### 0.1.2 Special Instructions and Constraints

- **Repository immutability:** "The repository itself should remain unchanged and anything temporary should be cleaned up afterward." No existing files in the Grafana source may be modified.
- **Implementation rules mandate:** Per the `SWE-AtlasQnA-Repo` rule, the output must be a single markdown document named `grafana_4550cfb5b728.md` placed in the `blitzy/documentation` directory. The document must provide thinking/rationale behind each answer and must base all answers on the code as the ground truth.
- **Observation methodology:** The user permits temporary scripts for observation but expects them to be cleaned up. Observation should focus on messages, counters, identifiers, and timing patterns that are visible during live execution.
- **Comparative analysis required:** The same scenario must be run under both stressed and normal conditions, with explicit description of what visibly differs in timing, volume, and rhythm.
- **No assumptions:** All answers must be derived from the code — no assumptions or general industry patterns.

### 0.1.3 Technical Interpretation

These documentation requirements translate to the following technical documentation strategy:

- To **document scheduling priority under contention**, we will analyze the `processTick()` function in `pkg/services/ngalert/schedule/schedule.go` (lines 235–397), the `updateSchedulableAlertRules()` fetcher in `fetcher.go`, the `alertRulesRegistry.set()/getDiff()` diff mechanism in `registry.go` (lines 129–205), and the jitter-based dispatch logic in `jitter.go`. The document will trace the exact sequence: fetch rules → compute diff → build `readyToRun` list → sort by UID → stagger dispatch via `time.AfterFunc` — and identify which metrics (`grafana_alerting_scheduler_behind_seconds`, `grafana_alerting_schedule_periodic_duration_seconds`, `grafana_alerting_schedule_rule_evaluations_missed_total`) and log messages ("Alert rules fetched", "Rule is ready to run on the current tick", "Tick dropped because alert rule evaluation is too slow") first expose the scheduling decisions.
- To **document cancellation and cleanup**, we will trace the `alertRule.Run()` loop in `alert_rule.go` (lines 242–361), specifically the `<-grafanaCtx.Done()` branch that checks `errors.Is(grafanaCtx.Err(), errRuleDeleted)` to decide whether to invoke `DeleteStateByRuleUID()` and `expireAndSend()`, versus simply logging "Stopping alert rule routine" and returning. The difference between `errRuleDeleted` and `errRuleRestarted` as cancellation causes will be documented as the distinguishing factor.
- To **document result ordering**, we will analyze the unbuffered `evalCh` channel semantics in `alertRule.Eval()` (lines 196–215) that perform a non-blocking drain before a blocking send, the `slices.SortFunc` by rule UID (line 364), and the `time.AfterFunc` staggered dispatch pattern (lines 370–383). The ordering guarantee comes from per-rule channel serialization: each goroutine processes one `*Evaluation` at a time, and any concurrent send to a busy rule results in a dropped tick with a logged warning.
- To **exercise live behavior**, we will create temporary Go test scripts or shell-based observation harnesses that run the existing test infrastructure, inspect log output and metrics, and then clean up. The observations will be captured and embedded in the documentation.

### 0.1.4 Inferred Documentation Needs

Based on code analysis, the following implicit documentation needs are identified:

- **Metric catalog for stress observability:** The scheduler exposes `grafana_alerting_scheduler_behind_seconds`, `grafana_alerting_rule_evaluations_total`, `grafana_alerting_rule_evaluation_failures_total`, `grafana_alerting_rule_evaluation_duration_seconds`, `grafana_alerting_schedule_rule_evaluations_missed_total`, `grafana_alerting_rule_evaluation_attempts_total`, and `grafana_alerting_rule_evaluation_attempt_failures_total`. These are defined in `pkg/services/ngalert/metrics/scheduler.go` and must be documented as the primary runtime signals.
- **Ticker behavior under lag:** The custom ticker in `pkg/util/ticker/ticker.go` does not drop ticks when consumers are slow — unlike `time.Ticker`. This design choice is critical for understanding why `BehindSeconds` accumulates rather than ticks being silently lost. The document must explain this.
- **Retry semantics under timeout:** The evaluator in `eval.go` wraps the expression pipeline execution in a `context.WithTimeout` (line 74) using the configured `EvaluationTimeout`. When a data source times out, this triggers the retry loop in `alert_rule.go` (lines 282–344) with up to `maxAttempts` retries and a 1-second `retryDelay`. This retry behavior is a key observable under stress.
- **State persistence paths:** The `SyncStatePersister` in `persister_sync.go` and `AsyncStatePersister` in `persister_async.go` have different cleanup behaviors that affect what artifacts remain after cancellation. This needs to be documented.
- **Fingerprint-based change detection:** The `ruleWithFolder.Fingerprint()` mechanism in `registry.go` (lines 222–300) uses FNV-64 hashing of all rule fields except `Version` and `Updated` timestamp. When a rule changes, the fingerprint changes, causing the goroutine to reset state. This is observable in the "Clearing the state of the rule because it was updated" log message.

## 0.2 Documentation Discovery and Analysis

### 0.2.1 Existing Documentation Infrastructure Assessment

Repository analysis reveals a mature Hugo-based documentation framework with extensive alerting coverage, but no existing documentation specifically addressing runtime behavior under stress or the internal scheduling mechanics at the code level.

- **Documentation framework:** Hugo with custom Grafana docs pipeline
- **Documentation source root:** `docs/sources/alerting/`
- **Existing alerting documentation areas:**
  - `docs/sources/alerting/fundamentals/` — Conceptual introduction to alerting lifecycle, states, and health
  - `docs/sources/alerting/fundamentals/alert-rule-evaluation/` — Explains evaluation groups, pending periods, and Grafana-managed vs. data-source-managed evaluation concurrency
  - `docs/sources/alerting/fundamentals/alert-rule-evaluation/state-and-health.md` — Documents alert states (Normal, Pending, Alerting, NoData, Error) and health indicators
  - `docs/sources/alerting/set-up/performance-limitations/index.md` — Performance considerations: evaluation frequency, cardinality, complexity, database write load, and the `grafana_alerting_rule_evaluations_total` metric
  - `docs/sources/alerting/alerting-rules/` — Rule creation workflows
  - `docs/sources/alerting/configure-notifications/` — Notification routing and suppression
  - `docs/sources/alerting/set-up/` — Operational and advanced configuration
  - `docs/sources/alerting/manage-notifications/` — Alert monitoring and investigation
- **Internal architecture documentation:**
  - `pkg/services/ngalert/README.md` — Architectural guide describing the scheduler/evaluator/state-manager flow, per-rule goroutines, evaluation events, multi-dimensional handling, and Alertmanager delivery paths
  - `pkg/services/ngalert/CHANGELOG.md` — Curated release-notes log for ngalert changes
- **Documentation generators detected:** Hugo with YAML front matter, Mermaid diagrams (commented out in `_index.md` of alert-rule-evaluation)
- **API documentation tools:** Swagger annotations in `pkg/api/`, but not directly relevant to this task
- **Diagram tools detected:** Mermaid (referenced in docs and tech spec)

### 0.2.2 Repository Code Analysis for Documentation

The following search patterns were used to identify code modules relevant to the user's questions:

- **Scheduler orchestration:** `pkg/services/ngalert/schedule/schedule.go` — The `processTick()` function (lines 235–397) is the central dispatch loop that fetches rules, computes diffs, resolves readiness, sorts by UID, and staggers evaluation delivery via `time.AfterFunc`
- **Per-rule goroutine lifecycle:** `pkg/services/ngalert/schedule/alert_rule.go` — The `Run()` method (lines 242–361) contains the event loop with `updateCh`, `evalCh`, and `ctx.Done()` select branches; the `evaluate()` method (lines 364–459) contains the retry loop and tracing
- **Rule registry and diff detection:** `pkg/services/ngalert/schedule/registry.go` — `alertRulesRegistry.set()` and `getDiff()` (lines 129–205) detect which rules changed between ticks; `ruleRegistry` manages active goroutines
- **Fetching logic:** `pkg/services/ngalert/schedule/fetcher.go` — `updateSchedulableAlertRules()` performs two-phase fetch optimization: first checking keys-only for changes, then fetching full rules when changes detected
- **Jitter strategy:** `pkg/services/ngalert/schedule/jitter.go` — Computes deterministic tick offsets from rule identity using FNV-based fingerprinting
- **Evaluation engine:** `pkg/services/ngalert/eval/eval.go` — `conditionEvaluator.EvaluateRaw()` wraps expression pipeline execution in a timeout context; handles panics via defer/recover
- **State management:** `pkg/services/ngalert/state/manager.go` — `ProcessEvalResults()` (lines 307–355) processes results, detects stale states, persists, records history, and triggers sends
- **State cache:** `pkg/services/ngalert/state/cache.go` — Concurrent org/rule/fingerprint-indexed in-memory store with `removeByRuleUID()` for cleanup
- **State model:** `pkg/services/ngalert/state/state.go` — `State` struct with evaluation timing, transition markers, and resolution tracking
- **Persistence:** `pkg/services/ngalert/state/persister_sync.go` and `persister_async.go` — Sync vs. async state persistence strategies
- **Metrics definitions:** `pkg/services/ngalert/metrics/scheduler.go` — All scheduler Prometheus metrics including `BehindSeconds`, `EvalTotal`, `EvalFailures`, `EvalDuration`, `EvaluationMissed`, etc.
- **Metrics wiring:** `pkg/services/ngalert/metrics/ngalert.go` — Central metrics factory that assembles scheduler, state, alertmanager, API, historian, and remote writer metric bundles
- **Ticker implementation:** `pkg/util/ticker/ticker.go` — Custom interval-aligned ticker that does not drop ticks when consumers are slow
- **Notification sender:** `pkg/services/ngalert/sender/router.go` — Multi-org alert routing with internal/external Alertmanager delivery
- **Notifier integration:** `pkg/services/ngalert/notifier/alertmanager.go` — Embedded Alertmanager with config apply, alert forwarding, and readiness management
- **Bootstrap:** `pkg/services/ngalert/ngalert.go` — `ProvideService()` wires the entire alerting pipeline including scheduler, evaluator, state manager, notifier, and sender

### 0.2.3 Web Search Research Conducted

No external web search is needed for this task. All answers are derived from the source code, as required by the user's directive to "base your answers on the code as the truth." The existing Grafana documentation on alerting performance (`docs/sources/alerting/set-up/performance-limitations/index.md`) provides supplementary context about metrics and write-load behavior but does not cover the internal scheduling mechanics under stress that the user is asking about.

## 0.3 Documentation Scope Analysis

### 0.3.1 Code-to-Documentation Mapping

The user's questions require deep analysis of the following modules, each of which contributes specific evidence to the Q&A document:

- **Module:** `pkg/services/ngalert/schedule/schedule.go`
  - Public APIs: `ScheduleService.Run()`, `processTick()`, `deleteAlertRule()`, `schedulePeriodic()`
  - Current documentation: Internal README only; no detailed runtime-behavior docs
  - Documentation needed: Detailed explanation of tick processing loop, readyToRun construction, staggered dispatch, and behind-seconds tracking

- **Module:** `pkg/services/ngalert/schedule/alert_rule.go`
  - Public APIs: `Rule` interface (`Run()`, `Stop()`, `Eval()`, `Update()`), `alertRule.evaluate()`, `alertRule.send()`
  - Current documentation: Godoc-level comments on interface methods
  - Documentation needed: Explanation of the event loop select branches, cancellation behavior (errRuleDeleted vs. errRuleRestarted), retry semantics, channel drain logic in `Eval()`

- **Module:** `pkg/services/ngalert/schedule/registry.go`
  - Public APIs: `ruleRegistry`, `alertRulesRegistry`, `Evaluation`, `RuleVersionAndPauseStatus`
  - Current documentation: Inline comments
  - Documentation needed: How diff tracking identifies changed rules, fingerprint-based change detection, and its observable log messages

- **Module:** `pkg/services/ngalert/schedule/fetcher.go`
  - Public APIs: `updateSchedulableAlertRules()`
  - Current documentation: Single-line godoc
  - Documentation needed: Two-phase fetch optimization (keys-only check, then full fetch if changed) and the "No changes detected. Skip updating" log message

- **Module:** `pkg/services/ngalert/schedule/jitter.go`
  - Public APIs: `JitterStrategy`, `jitterOffsetInTicks()`, `JitterStrategyFrom()`
  - Current documentation: Brief godoc
  - Documentation needed: How jitter affects scheduling rhythm under stress and its deterministic nature

- **Module:** `pkg/services/ngalert/eval/eval.go`
  - Public APIs: `ConditionEvaluator.Evaluate()`, `EvaluateRaw()`, `EvaluateAlert()`, `NewEvaluatorFactory()`
  - Current documentation: Package-level doc comment
  - Documentation needed: Timeout enforcement via `context.WithTimeout`, panic recovery, result-limit checking, retry classification (retryable vs. non-retryable errors)

- **Module:** `pkg/services/ngalert/state/manager.go`
  - Public APIs: `Manager.ProcessEvalResults()`, `DeleteStateByRuleUID()`, `ResetStateByRuleUID()`, `Warm()`
  - Current documentation: Godoc comments
  - Documentation needed: How state transitions are computed, persisted, and sent; stale state cleanup; ordering of persist → history → send operations

- **Module:** `pkg/services/ngalert/state/cache.go`
  - Public APIs: `cache`, `ruleStates`, `RegisterMetrics()`
  - Current documentation: Inline comments
  - Documentation needed: Concurrency model (RWMutex), org/rule/fingerprint indexing, and the `grafana_alerting_alerts` gauge by state

- **Module:** `pkg/services/ngalert/metrics/scheduler.go`
  - Public APIs: `Scheduler` struct with all metric fields
  - Current documentation: Prometheus Help strings only
  - Documentation needed: Catalog of all metrics with their labels, semantics, and when they change under stress

- **Module:** `pkg/util/ticker/ticker.go`
  - Public APIs: `T`, `New()`, `Stop()`
  - Current documentation: File-level summary
  - Documentation needed: Non-dropping tick behavior and its implications for behind-seconds accumulation

### 0.3.2 Documentation Gap Analysis

Given the requirements and repository analysis, documentation gaps include:

- **No existing documentation** on the scheduler's internal priority decisions when processing ticks: how rules are selected, sorted, and staggered
- **No existing documentation** on the per-rule goroutine lifecycle and its cancellation semantics — specifically what `errRuleDeleted` vs. `errRuleRestarted` cause at runtime
- **No existing documentation** on evaluation result ordering guarantees from the unbuffered channel + sorted dispatch pattern
- **No existing documentation** on the complete set of runtime observables (metrics, log lines, trace spans) that reveal scheduling behavior under load
- **No existing documentation** providing comparative runtime observations between stressed and normal execution
- **Missing integration-level explanation** connecting the ticker → processTick → eval channel → evaluate → state → send pipeline as a single observable flow
- **The performance limitations page** (`docs/sources/alerting/set-up/performance-limitations/index.md`) mentions `grafana_alerting_rule_evaluations_total` but does not document scheduler-level metrics like `grafana_alerting_scheduler_behind_seconds` or `grafana_alerting_schedule_rule_evaluations_missed_total`

## 0.4 Documentation Implementation Design

### 0.4.1 Documentation Structure Planning

The deliverable is a single comprehensive markdown document. Its internal structure will follow a logical progression that mirrors the user's questions and provides supporting evidence from code analysis and live observation.

```
blitzy/documentation/
└── grafana_4550cfb5b728.md
    ├── Introduction and Scope
    ├── System Architecture Context (with Mermaid diagram)
    ├── Q1: Scheduling Priority Under Contention
    │   ├── Code-Level Analysis
    │   ├── Key Metrics and Log Signals
    │   └── Supporting Evidence from Runtime Observation
    ├── Q2: Cancellation and Cleanup Semantics
    │   ├── errRuleDeleted Path (with state cleanup)
    │   ├── errRuleRestarted Path (without state cleanup)
    │   ├── Mid-Evaluation Cancellation (context check)
    │   └── Runtime Indicators
    ├── Q3: Evaluation Result Ordering
    │   ├── Channel Semantics and Sorted Dispatch
    │   ├── Per-Rule Serialization Guarantee
    │   └── Observable Ordering Evidence
    ├── Q4: Live Exercise — Stressed Execution
    │   ├── Methodology and Script Design
    │   ├── Observations Under Stress
    │   └── Key Patterns Identified
    ├── Q5: Live Exercise — Normal Execution
    │   ├── Observations Under Normal Load
    │   └── Comparative Analysis (Stressed vs. Normal)
    ├── Metric and Signal Catalog
    └── Conclusion and Summary of Findings
```

### 0.4.2 Content Generation Strategy

- **Information Extraction Approach:**
  - Extract scheduling logic from `pkg/services/ngalert/schedule/schedule.go:processTick()` by reading the function line by line and documenting the decision tree
  - Extract cancellation semantics from `pkg/services/ngalert/schedule/alert_rule.go:Run()` by tracing each `select` case and its cleanup behavior
  - Extract metric definitions from `pkg/services/ngalert/metrics/scheduler.go:NewSchedulerMetrics()` and map each metric to its usage site
  - Generate runtime observations by running the existing unit test suite (particularly `schedule_unit_test.go` and `alert_rule_test.go`) with verbose output and analyzing log/metric patterns
  - Create comparative observations by running the same tests under different conditions

- **Documentation Standards:**
  - All code references include file path and line numbers: `Source: pkg/services/ngalert/schedule/schedule.go:235`
  - Mermaid diagrams for the tick processing flow and cancellation decision tree
  - Code snippets kept to 2–3 lines for key decision points
  - Tables for metric catalogs and comparison data
  - Thinking/rationale sections for each answer, per the implementation rule

### 0.4.3 Diagram and Visual Strategy

The following Mermaid diagrams will be created within the document:

- **Tick processing flow:** Flowchart showing `schedulePeriodic()` → `processTick()` → fetch rules → compute diff → iterate rules → sort readyToRun → staggered dispatch → handle deletions
- **Per-rule goroutine lifecycle:** State diagram showing the `alertRule.Run()` event loop with `updateCh`, `evalCh`, and `ctx.Done()` branches and their effects
- **Cancellation decision tree:** Decision flowchart showing how `grafanaCtx.Err()` → `errors.Is(errRuleDeleted)` → `DeleteStateByRuleUID()` + `expireAndSend()` vs. simple exit
- **Evaluation ordering guarantee:** Sequence diagram showing ticker → `processTick()` → sorted `time.AfterFunc` → `alertRule.Eval()` → unbuffered channel → `Run()` loop processing

## 0.5 Documentation File Transformation Mapping

### 0.5.1 File-by-File Documentation Plan

| Target Documentation File | Transformation | Source Code/Docs | Content/Changes |
|---------------------------|----------------|------------------|-----------------|
| `blitzy/documentation/grafana_4550cfb5b728.md` | CREATE | `pkg/services/ngalert/schedule/schedule.go`, `pkg/services/ngalert/schedule/alert_rule.go`, `pkg/services/ngalert/schedule/registry.go`, `pkg/services/ngalert/schedule/fetcher.go`, `pkg/services/ngalert/schedule/jitter.go`, `pkg/services/ngalert/schedule/metrics.go`, `pkg/services/ngalert/eval/eval.go`, `pkg/services/ngalert/state/manager.go`, `pkg/services/ngalert/state/cache.go`, `pkg/services/ngalert/state/state.go`, `pkg/services/ngalert/state/persister_sync.go`, `pkg/services/ngalert/state/persister_async.go`, `pkg/services/ngalert/metrics/scheduler.go`, `pkg/services/ngalert/metrics/ngalert.go`, `pkg/util/ticker/ticker.go`, `pkg/services/ngalert/README.md`, `docs/sources/alerting/set-up/performance-limitations/index.md` | Complete Q&A document answering all five user questions about scheduling priority, cancellation cleanup, result ordering, live stressed observations, and normal-load comparison. Includes Mermaid diagrams, code-referenced analysis, runtime output evidence, metric catalog, and thinking/rationale for each answer. |
| `pkg/services/ngalert/schedule/schedule.go` | REFERENCE | — | Used as primary source for `processTick()` scheduling logic, staggered dispatch via `time.AfterFunc`, and behind-seconds metric recording. Not modified. |
| `pkg/services/ngalert/schedule/alert_rule.go` | REFERENCE | — | Used as primary source for `Run()` event loop, cancellation paths (`errRuleDeleted` vs. `errRuleRestarted`), retry logic, and `Eval()` channel drain semantics. Not modified. |
| `pkg/services/ngalert/schedule/registry.go` | REFERENCE | — | Used as source for `alertRulesRegistry.getDiff()`, fingerprint calculation, and `ruleRegistry` lifecycle. Not modified. |
| `pkg/services/ngalert/schedule/fetcher.go` | REFERENCE | — | Used as source for two-phase rule fetch optimization. Not modified. |
| `pkg/services/ngalert/schedule/jitter.go` | REFERENCE | — | Used as source for jitter strategy and deterministic offset computation. Not modified. |
| `pkg/services/ngalert/eval/eval.go` | REFERENCE | — | Used as source for evaluation timeout enforcement, panic recovery, and result-limit checking. Not modified. |
| `pkg/services/ngalert/state/manager.go` | REFERENCE | — | Used as source for `ProcessEvalResults()`, `DeleteStateByRuleUID()`, stale state cleanup, and persist-then-send ordering. Not modified. |
| `pkg/services/ngalert/state/cache.go` | REFERENCE | — | Used as source for concurrent state cache structure, `removeByRuleUID()`, and `grafana_alerting_alerts` gauge. Not modified. |
| `pkg/services/ngalert/metrics/scheduler.go` | REFERENCE | — | Used as authoritative source for all scheduler metric names, labels, and help strings. Not modified. |
| `pkg/util/ticker/ticker.go` | REFERENCE | — | Used as source for non-dropping tick behavior and its implications for behind-seconds accumulation. Not modified. |
| `pkg/services/ngalert/README.md` | REFERENCE | — | Used as architectural context for the scheduler → evaluator → state manager → Alertmanager flow. Not modified. |
| `docs/sources/alerting/set-up/performance-limitations/index.md` | REFERENCE | — | Used as supplementary context for performance metrics and database write considerations. Not modified. |
| `pkg/services/ngalert/state/persister_sync.go` | REFERENCE | — | Used as source for synchronous persistence behavior including stale state deletion. Not modified. |
| `pkg/services/ngalert/state/state.go` | REFERENCE | — | Used as source for State struct fields, timing markers, and resolution tracking. Not modified. |
| `pkg/services/ngalert/ngalert.go` | REFERENCE | — | Used as source for bootstrap wiring that connects scheduler, evaluator, state manager, and sender. Not modified. |
| `pkg/services/ngalert/sender/router.go` | REFERENCE | — | Used as source for multi-org alert routing and internal/external delivery mode. Not modified. |
| `pkg/services/ngalert/schedule/schedule_unit_test.go` | REFERENCE | — | Used for runtime observation of scheduling behavior through test execution. Not modified. |
| `pkg/services/ngalert/schedule/alert_rule_test.go` | REFERENCE | — | Used for runtime observation of cancellation and evaluation behavior through test execution. Not modified. |

### 0.5.2 New Documentation File Detail

```
File: blitzy/documentation/grafana_4550cfb5b728.md
Type: Technical Q&A Investigation Document
Source Code: Multiple (see table above)
Sections:
    - Introduction and Scope (context for the investigation)
    - System Architecture Context (Mermaid overview of the scheduler pipeline)
    - Q1: Scheduling Priority Under Contention
        - Code analysis of processTick() decision tree
        - Metric and log signal catalog for scheduling decisions
        - Runtime observation evidence
    - Q2: Cancellation and Cleanup Semantics
        - errRuleDeleted path analysis (full cleanup)
        - errRuleRestarted path analysis (goroutine replacement)
        - Mid-evaluation context cancellation
        - Runtime indicators differentiating each path
    - Q3: Evaluation Result Ordering
        - Channel semantics analysis
        - Sorted dispatch mechanism
        - Observable ordering evidence
    - Q4: Live Exercise Under Stress
        - Methodology and observation approach
        - Stressed runtime output with annotations
        - Pattern analysis
    - Q5: Comparative Normal-Load Exercise
        - Normal runtime output
        - Timing and volume differences
    - Metric and Signal Catalog (comprehensive table)
    - Conclusion and Summary
Diagrams:
    - Tick processing flowchart (Mermaid)
    - Per-rule goroutine lifecycle (Mermaid)
    - Cancellation decision tree (Mermaid)
    - Evaluation ordering sequence (Mermaid)
Key Citations: All source files listed in transformation table above
```

### 0.5.3 Documentation Configuration Updates

No documentation configuration files need to be modified. The output document is placed in a standalone `blitzy/documentation/` directory outside the Grafana docs pipeline and does not require integration with Hugo, mkdocs, or any existing documentation build system.

## 0.6 Dependency Inventory

### 0.6.1 Documentation Dependencies

The following tools and packages are relevant to producing and validating this documentation:

| Registry | Package Name | Version | Purpose |
|----------|--------------|---------|---------|
| go | go (toolchain) | 1.23.1 | Required Go version per `go.mod`; needed to compile and run test harnesses for runtime observation |
| go | github.com/grafana/grafana (module) | v0.0.0 (local) | The Grafana monorepo itself, used as the source of truth for all code analysis |
| go | github.com/prometheus/client_golang | (per go.sum) | Prometheus client library that defines the metric types observed in scheduler metrics |
| go | github.com/benbjohnson/clock | (per go.sum) | Mock clock library used throughout the scheduler and test infrastructure for deterministic timing |
| go | github.com/stretchr/testify | (per go.sum) | Test assertion library used in the scheduler and alert_rule test suites whose output forms runtime evidence |
| go | go.opentelemetry.io/otel | (per go.sum) | OpenTelemetry tracing library that produces trace spans and events observable in alert evaluation |
| go | golang.org/x/sync/errgroup | (per go.sum) | Concurrency library used by the scheduler's `dispatcherGroup` for managing rule goroutine lifecycle |
| n/a | Mermaid (embedded in Markdown) | n/a | Diagram rendering for the documentation; rendered by any Mermaid-compatible Markdown viewer |

### 0.6.2 Runtime Observation Dependencies

For the live exercise portion of the documentation, the following are required:

| Tool | Purpose |
|------|---------|
| `go test` | Execute existing unit tests in `pkg/services/ngalert/schedule/` with verbose output to capture runtime log messages, timing, and test results |
| `grep` / `sed` | Filter and annotate test output to identify key log lines, metric-related messages, and timing patterns |
| Temporary Go scripts (if needed) | Custom harnesses to exercise specific scheduler paths under controlled stress; these must be cleaned up after use |

### 0.6.3 Documentation Reference Updates

No documentation link updates are required. The new `blitzy/documentation/grafana_4550cfb5b728.md` file is a standalone document that does not need to be cross-referenced from existing Grafana documentation. All internal references within the document use source-code paths as citations rather than documentation links.

## 0.7 Coverage and Quality Targets

### 0.7.1 Documentation Coverage Metrics

The user posed five interconnected question areas. Coverage is measured by whether each question is fully answered with code evidence, runtime observation, and thinking/rationale.

- **Q1 — Scheduling priority under contention:** Must trace the complete `processTick()` decision chain from rule fetch through staggered dispatch, identify every metric and log signal, and show runtime evidence. Target: 100% of the code path documented with source citations.
- **Q2 — Cancellation and cleanup semantics:** Must distinguish all cancellation causes (`errRuleDeleted`, `errRuleRestarted`, context cancellation during evaluation), document what state is or is not cleaned up in each case, and identify runtime indicators. Target: 100% of cancellation paths documented.
- **Q3 — Evaluation result ordering:** Must explain the channel serialization mechanism, sorted dispatch, and tick-dropping behavior with observable evidence. Target: 100% of ordering-relevant code paths documented.
- **Q4 — Live stressed execution:** Must produce actual runtime output showing the behaviors described in Q1–Q3 under stress, with annotations explaining what each observation means. Target: At least one live observation per question area.
- **Q5 — Normal-load comparison:** Must run the same scenario under normal conditions and explicitly describe what changes in timing, volume, or rhythm. Target: Side-by-side comparison with specific quantitative or qualitative differences.

Coverage gaps to address:
- The scheduler metric catalog in `pkg/services/ngalert/metrics/scheduler.go` has 15+ metrics; all relevant ones must be documented with their names, labels, and behavioral significance under stress
- The ticker's non-dropping behavior in `pkg/util/ticker/ticker.go` must be explained as it directly impacts behind-seconds accumulation
- The `retryDelay` constant (1 second) and `maxAttempts` configuration in `schedule.go` must be documented as they affect observable timing patterns during data source timeouts

### 0.7.2 Documentation Quality Criteria

- **Completeness requirements:**
  - Every claim references a specific source file and line range
  - Every question from the user receives a direct, explicit answer
  - Thinking/rationale is provided for each answer per the implementation rules
  - Mermaid diagrams are provided for complex flows (tick processing, cancellation, ordering)

- **Accuracy validation:**
  - All code references are verified against the actual repository at branch `grafana_4550cfb5b728`
  - Metric names match the exact Prometheus metric definitions in `pkg/services/ngalert/metrics/scheduler.go`
  - Log message strings match the exact string literals in the source code
  - Runtime observations are produced from actual test execution, not fabricated

- **Clarity standards:**
  - Each question section begins with a direct answer, followed by supporting evidence
  - Code snippets are kept to 2–3 lines to illustrate key decision points
  - Technical terms are defined when first used (e.g., "fingerprint" as used in the registry)
  - The document reads as a narrative investigation, not a code dump

- **Maintainability:**
  - Source citations use the format `Source: path/to/file.go:LineNumber`
  - Metric names use the full Prometheus-qualified name (e.g., `grafana_alerting_scheduler_behind_seconds`)
  - The document is self-contained and does not depend on external links

### 0.7.3 Example and Diagram Requirements

- **Minimum diagrams:** 4 Mermaid diagrams (tick processing flow, goroutine lifecycle, cancellation tree, ordering sequence)
- **Code examples:** Short (2–3 line) extracts from key decision points in `processTick()`, `Run()`, `Eval()`, and `evaluate()`
- **Runtime output examples:** Actual log lines and timing data from test execution, annotated with explanations
- **Metric tables:** Complete table of scheduler metrics with name, labels, help string, and stress-relevance assessment

## 0.8 Scope Boundaries

### 0.8.1 Exhaustively In Scope

- **New documentation file:**
  - `blitzy/documentation/grafana_4550cfb5b728.md` — The single deliverable Q&A document

- **Source code analysis (read-only reference):**
  - `pkg/services/ngalert/schedule/*.go` — All scheduler files (schedule.go, alert_rule.go, registry.go, fetcher.go, jitter.go, metrics.go, recording_rule.go)
  - `pkg/services/ngalert/eval/eval.go` — Evaluation engine with timeout and retry semantics
  - `pkg/services/ngalert/state/manager.go` — State manager ProcessEvalResults and cleanup
  - `pkg/services/ngalert/state/cache.go` — State cache with concurrency and metric registration
  - `pkg/services/ngalert/state/state.go` — State model and transition helpers
  - `pkg/services/ngalert/state/persister_sync.go` — Synchronous state persistence
  - `pkg/services/ngalert/state/persister_async.go` — Asynchronous state persistence
  - `pkg/services/ngalert/metrics/scheduler.go` — Scheduler metric definitions
  - `pkg/services/ngalert/metrics/ngalert.go` — Metric factory and wiring
  - `pkg/services/ngalert/metrics/state.go` — State metric definitions
  - `pkg/util/ticker/ticker.go` — Custom non-dropping ticker
  - `pkg/services/ngalert/README.md` — Architecture overview
  - `pkg/services/ngalert/ngalert.go` — Bootstrap and service wiring
  - `pkg/services/ngalert/sender/router.go` — Alert routing logic
  - `pkg/services/ngalert/notifier/alertmanager.go` — Alertmanager integration
  - `docs/sources/alerting/set-up/performance-limitations/index.md` — Performance docs

- **Test execution for runtime observation (read-only, verbose output capture):**
  - `pkg/services/ngalert/schedule/schedule_unit_test.go`
  - `pkg/services/ngalert/schedule/alert_rule_test.go`
  - `pkg/services/ngalert/schedule/registry_test.go`
  - `pkg/services/ngalert/state/manager_test.go`

- **Temporary observation artifacts (created and cleaned up):**
  - Any temporary Go test scripts or shell observation harnesses used to exercise runtime behavior
  - Temporary log capture files used during test execution

### 0.8.2 Explicitly Out of Scope

- **Source code modifications:** No existing file in the Grafana repository may be modified, per the user's explicit instruction and the `SWE-AtlasQnA-Repo` implementation rule
- **Test file modifications:** No existing test files are altered; tests are only executed for observation
- **Feature additions or code refactoring:** This is purely a documentation and investigation task
- **Deployment configuration changes:** No changes to CI/CD, Docker, or deployment configs
- **Frontend/UI analysis:** The user's questions are entirely about backend scheduler and evaluation runtime behavior
- **External Alertmanager behavior:** While the notification pipeline is referenced for context, the user's questions focus on the scheduling and evaluation phases before notifications are sent
- **Data source plugin internals:** The user mentions data source timeouts but does not ask about the internal behavior of any specific data source plugin; the timeout is observed from the evaluator's perspective
- **Grafana database schema or migration changes:** Not relevant to this investigation
- **Documentation pipeline integration:** The output file is standalone and does not integrate into the Hugo/Grafana docs build
- **Performance tuning recommendations:** The user asks for behavioral explanation, not optimization advice
- **Recording rules:** While `recording_rule.go` follows a similar pattern, the user's questions specifically address alerting rules and their evaluation/notification behavior

## 0.9 Execution Parameters

### 0.9.1 Documentation-Specific Instructions

- **Runtime observation command (scheduler tests):**
  ```
  cd pkg/services/ngalert/schedule && go test -v -run "Test" -count=1 -timeout 300s ./...
  ```
- **Runtime observation command (alert rule tests):**
  ```
  cd pkg/services/ngalert/schedule && go test -v -run "TestAlertRule" -count=1 -timeout 300s ./...
  ```
- **Runtime observation command (state manager tests):**
  ```
  cd pkg/services/ngalert/state && go test -v -run "TestProcessEvalResults" -count=1 -timeout 300s ./...
  ```
- **Diagram generation:** Mermaid diagrams are embedded directly in the Markdown document and rendered by any compatible viewer
- **Default format:** Markdown with Mermaid diagrams
- **Citation requirement:** Every technical claim must reference a specific source file and line range
- **Style guide:** Follow the analytical narrative style with clear Question → Answer → Evidence → Rationale structure
- **Cleanup requirement:** Any temporary files created during runtime observation must be removed before the task is complete

### 0.9.2 Go Environment Configuration

- **Go version:** 1.23.1 (as specified in `go.mod`)
- **Repository root:** The Grafana monorepo at branch `grafana_4550cfb5b728`
- **Test execution mode:** Verbose (`-v`) to capture log output; non-watch mode (`-count=1`); with timeout (`-timeout 300s`)
- **No build modifications:** Tests are executed as-is without modifying build flags, feature toggles, or test fixtures

## 0.10 Rules for Documentation

The following rules are explicitly derived from the user's instructions and the `SWE-AtlasQnA-Repo` implementation rule:

- **Create a new markdown document named `grafana_4550cfb5b728.md`** that comprehensively answers the question(s) posed in the prompt.
- **Provide thinking / rationale behind the answers.** Each answer section must include a "Rationale" or "Why this matters" explanation that connects the code-level behavior to the user's observable concern.
- **Do not make assumptions, base your answers on the code as the truth.** Every claim must cite a specific source file and line range. No appeal to "typical Prometheus behavior" or "industry standard" patterns unless explicitly supported by the Grafana code.
- **Do not modify any existing files in the source repository.** All source files are read-only references. The only writable output is the new document in `blitzy/documentation/`.
- **Place the generated document in the `blitzy/documentation` directory in the destination repo.**
- **Temporary scripts may be used for observation, but the repository itself should remain unchanged and anything temporary should be cleaned up afterward.** Any observation harnesses, log capture files, or temporary test scripts must be deleted upon completion.
- **Pay attention to any messages, counters, identifiers, or timing patterns that stand out while the system is under load, and note any pauses or rhythm changes you notice as things slow down or recover.** The document must include detailed annotation of runtime output identifying specific log messages, metric counter changes, trace span attributes, and timing intervals.
- **Repeat the same scenario under normal load and describe what visibly changes in terms of timing or volume compared to the stressed run.** A dedicated comparison section must quantify or qualitatively describe differences between stressed and normal execution.
- **Answers must be exercised live and backed by real runtime output.** The document must include actual test execution output, not hypothetical or synthesized examples.

## 0.11 References

### 0.11.1 Codebase Files and Folders Searched

The following files and folders were systematically explored to derive the conclusions in this Agent Action Plan:

**Scheduler subsystem (primary focus):**
- `pkg/services/ngalert/schedule/schedule.go` — Main scheduler orchestration: `Run()`, `processTick()`, `schedulePeriodic()`, `deleteAlertRule()`, `readyToRunItem`, staggered dispatch logic
- `pkg/services/ngalert/schedule/alert_rule.go` — Per-rule goroutine: `Rule` interface, `alertRule` struct, `Run()` event loop, `Eval()` channel semantics, `Update()`, `Stop()`, `evaluate()` with retry, `send()`, `expireAndSend()`, `resetState()`
- `pkg/services/ngalert/schedule/registry.go` — Rule registries: `ruleRegistry` (active goroutines), `alertRulesRegistry` (schedulable rules), `Evaluation`, `RuleVersionAndPauseStatus`, `diff`, `getDiff()`, `fingerprint`, `ruleWithFolder.Fingerprint()`
- `pkg/services/ngalert/schedule/fetcher.go` — Two-phase rule fetch: `updateSchedulableAlertRules()` with keys-only optimization
- `pkg/services/ngalert/schedule/jitter.go` — Jitter strategies: `JitterStrategy`, `JitterNever`, `JitterByGroup`, `JitterByRule`, `jitterOffsetInTicks()`, `jitterHash()`
- `pkg/services/ngalert/schedule/metrics.go` — Scheduler metrics maintenance: `hashUIDs()`, `updateRulesMetrics()`
- `pkg/services/ngalert/schedule/testing.go` — Test utilities for the scheduler

**Evaluation subsystem:**
- `pkg/services/ngalert/eval/eval.go` — Evaluation engine: `ConditionEvaluator`, `conditionEvaluator.EvaluateRaw()` with timeout and panic recovery, `Evaluate()`, `EvaluateAlert()`, `NewEvaluatorFactory()`, retry classification (`IsNonRetryableError`, `HasNonRetryableErrors`)

**State management subsystem:**
- `pkg/services/ngalert/state/manager.go` — State manager: `Manager`, `ProcessEvalResults()`, `DeleteStateByRuleUID()`, `ResetStateByRuleUID()`, `setNextStateForRule()`, `deleteStaleStatesFromCache()`, `updateLastSentAt()`, `Warm()`
- `pkg/services/ngalert/state/cache.go` — State cache: `cache` struct with RWMutex, `ruleStates`, `RegisterMetrics()`, `countAlertsBy()`, `expandAnnotationsAndLabels()`
- `pkg/services/ngalert/state/state.go` — State model: `State` struct with OrgID, AlertRuleUID, CacheID, State, StateReason, timing fields, ResolvedAt, LastSentAt
- `pkg/services/ngalert/state/persister_sync.go` — Synchronous persistence: `SyncStatePersister`, `Sync()`, `deleteAlertStates()`, `saveAlertStates()`
- `pkg/services/ngalert/state/persister_async.go` — Asynchronous persistence

**Metrics definitions:**
- `pkg/services/ngalert/metrics/scheduler.go` — All scheduler metrics: `BehindSeconds`, `EvalTotal`, `EvalFailures`, `EvalDuration`, `EvalAttemptTotal`, `EvalAttemptFailures`, `ProcessDuration`, `SendDuration`, `GroupRules`, `Groups`, `SchedulePeriodicDuration`, `SchedulableAlertRules`, `SchedulableAlertRulesHash`, `UpdateSchedulableAlertRulesDuration`, `EvaluationMissed`, `SimplifiedEditorRules`
- `pkg/services/ngalert/metrics/ngalert.go` — Metrics factory: `NGAlert`, `NewNGAlert()`, `ProvideService()`
- `pkg/services/ngalert/metrics/state.go` — State metrics

**Infrastructure:**
- `pkg/util/ticker/ticker.go` — Custom ticker: non-dropping, interval-aligned scheduling primitive
- `pkg/services/ngalert/ngalert.go` — Bootstrap: `ProvideService()` wiring scheduler, evaluator, state manager, notifier, sender

**Notification subsystem (contextual reference):**
- `pkg/services/ngalert/sender/router.go` — Alert routing: `AlertsRouter`, `Send()`, internal/external delivery
- `pkg/services/ngalert/notifier/alertmanager.go` — Alertmanager wrapper with config apply and alert forwarding

**Documentation sources:**
- `pkg/services/ngalert/README.md` — Architecture guide for the ngalert subsystem
- `docs/sources/alerting/set-up/performance-limitations/index.md` — Performance considerations and limitations
- `docs/sources/alerting/fundamentals/alert-rule-evaluation/_index.md` — Alert rule evaluation fundamentals
- `docs/sources/alerting/fundamentals/alert-rule-evaluation/state-and-health.md` — State and health documentation

**Test files (for runtime observation):**
- `pkg/services/ngalert/schedule/schedule_unit_test.go` — Scheduler tick processing tests
- `pkg/services/ngalert/schedule/alert_rule_test.go` — Alert rule lifecycle tests
- `pkg/services/ngalert/schedule/registry_test.go` — Registry and diff tests
- `pkg/services/ngalert/state/manager_test.go` — State manager processing tests

**Folder-level exploration:**
- Root repository (`""`) — Identified all top-level directories and configuration files
- `pkg/` — Main backend namespace
- `pkg/services/ngalert/` — Top-level ngalert service area
- `pkg/services/ngalert/schedule/` — Scheduler subsystem (all files)
- `pkg/services/ngalert/state/` — State management subsystem (all files)
- `pkg/services/ngalert/eval/` — Evaluation subsystem
- `pkg/services/ngalert/metrics/` — Metrics definitions
- `pkg/services/ngalert/sender/` — Notification sender
- `pkg/services/ngalert/notifier/` — Alertmanager integration
- `docs/sources/alerting/` — Documentation source tree

### 0.11.2 Attachments

No attachments were provided by the user. No Figma screens or external design assets are relevant to this documentation task.

### 0.11.3 Technical Specification Sections Retrieved

- **Section 4.7 — UNIFIED ALERTING PIPELINE:** Provided the architectural overview of the three-phase alerting pipeline (scheduling → evaluation → state management), state machine diagram, notification delivery flowchart, and supporting subsystem table.
- **Section 4.12 — ERROR HANDLING AND RECOVERY:** Provided context on alerting-specific error recovery mechanisms including rule version mismatch handling, NoData/Error state transitions, and notification delivery retry pipeline.

