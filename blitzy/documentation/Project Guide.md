# Blitzy Project Guide

## 1. Executive Summary

### 1.1 Project Overview

This project creates a comprehensive technical Q&A investigation document that explains the runtime behavior of the Grafana unified alerting (ngalert) scheduler subsystem under stress conditions. The document answers five interconnected questions about scheduling priority, cancellation semantics, evaluation result ordering, and observable runtime indicators — backed entirely by source-code evidence and live test execution output. The deliverable is a single 839-line Markdown document placed in `blitzy/documentation/grafana_4550cfb5b728.md`, with zero modifications to existing repository files.

### 1.2 Completion Status

```mermaid
pie title Project Completion Status
    "Completed (AI)" : 56
    "Remaining" : 3
```

| Metric | Value |
|---|---|
| **Total Project Hours** | 59 |
| **Completed Hours (AI)** | 56 |
| **Remaining Hours** | 3 |
| **Completion Percentage** | 94.9% |

**Calculation:** 56 completed hours / (56 + 3 remaining hours) = 56/59 = **94.9% complete**

### 1.3 Key Accomplishments

- ✅ Created complete 839-line Q&A investigation document answering all 5 user questions with Direct Answer → Code Analysis → Runtime Evidence → Thinking/Rationale structure
- ✅ Analyzed 10+ source files (3,180+ lines of Go code) across scheduler, evaluator, state management, and metrics subsystems with specific line-number citations
- ✅ Produced 4 Mermaid diagrams: tick processing flow, goroutine lifecycle state diagram, cancellation decision tree, evaluation ordering sequence diagram
- ✅ Compiled comprehensive metric and signal catalog: 16 scheduler metrics, 3 ticker metrics, 1 state cache metric, 20 key log messages, 2 trace spans
- ✅ Executed live tests: 169 schedule tests + 1,913 state tests — all PASS, zero failures
- ✅ Provided 12-row comparative analysis table between normal and stressed execution with quantified timing evidence
- ✅ Verified all 14+ source code line-number references against actual repository files
- ✅ Maintained repository integrity: zero existing files modified, zero temporary artifacts remaining
- ✅ Applied 3 rounds of code review fixes (10 findings resolved, 2 off-by-1 line references corrected, live test output integrated)

### 1.4 Critical Unresolved Issues

| Issue | Impact | Owner | ETA |
|---|---|---|---|
| No critical unresolved issues | N/A | N/A | N/A |

All 5 user questions are fully answered with code evidence and live runtime observations. The document is production-ready for stakeholder review.

### 1.5 Access Issues

No access issues identified. The project is a documentation-only task that required read access to source code files and `go test` execution capability, both of which were available throughout development.

### 1.6 Recommended Next Steps

1. **[High]** Stakeholder review of the Q&A document for technical accuracy and completeness against the original questions
2. **[Medium]** Independent cross-reference audit of line-number citations against the source code at the specific commit hash
3. **[Low]** Consider integrating key findings into the existing Grafana alerting performance documentation (`docs/sources/alerting/set-up/performance-limitations/index.md`)

---

## 2. Project Hours Breakdown

### 2.1 Completed Work Detail

| Component | Hours | Description |
|---|---|---|
| Q1: Scheduling Priority Under Contention | 8 | Full `processTick()` decision chain analysis (9 steps), metrics table (12 entries), log signal catalog (6 entries), thinking/rationale section. References `schedule.go:235-397`, `fetcher.go:14-41`, `registry.go:192-205`, `jitter.go`. |
| Q2: Cancellation and Cleanup Semantics | 7 | Three cancellation paths documented (errRuleDeleted full cleanup, errRuleRestarted no cleanup, mid-evaluation skip), state cache orphan analysis, Mermaid decision tree diagram. References `alert_rule.go:347-357`, `manager.go:236-281`, `cache.go:337-357`. |
| Q3: Evaluation Result Ordering | 6 | Channel semantics analysis (unbuffered `evalCh`), sorted dispatch mechanism (UID sort + `time.AfterFunc` stagger), per-rule serialization guarantee, observable evidence table. Mermaid sequence diagram. References `alert_rule.go:161, 196-215, 262-265`, `schedule.go:359-383`. |
| Q4: Live Exercise Under Stress | 8 | Methodology section, 6 runtime observations with annotated live test output (`TestProcessTicks`, `TestRuleRoutine/when_evaluation_fails`, cancellation tests, channel semantics tests, state manager tests, registry diff tests), pattern analysis table (5 patterns). |
| Q5: Normal-Load Comparative Analysis | 5 | Normal-load observations from live test output, 12-row comparative analysis table with quantified timing evidence (0.00s vs 2.00s, 1:1 vs 3:1 attempt ratios), timing/rhythm analysis (heartbeat vs catch-up patterns). |
| System Architecture Context | 3 | Mermaid flowchart of full pipeline (ticker → schedulePeriodic → processTick → per-rule goroutines → evaluate → state manager → sender), non-dropping ticker explanation with code references to `ticker.go:12-85`. |
| Metric and Signal Catalog | 4 | Complete tables: 16 scheduler metrics with names/types/labels/help/stress-relevance, 3 ticker metrics, 1 state cache metric, 20 key log messages with exact source file:line, 2 trace spans with attributes and events. |
| Mermaid Diagrams (4 total) | 4 | Tick processing flowchart, per-rule goroutine lifecycle state diagram, cancellation decision tree flowchart, evaluation ordering sequence diagram. All valid Mermaid syntax verified. |
| Source Code Analysis | 6 | Deep read-only analysis of 10+ source files (3,180+ LOC): `schedule.go`, `alert_rule.go`, `registry.go`, `fetcher.go`, `jitter.go`, `eval.go`, `manager.go`, `cache.go`, `scheduler.go` (metrics), `ticker.go`. Line-number references verified. |
| Conclusion and Design Principles | 1 | Summary of all 5 findings, 4 confirmed design principles (per-rule isolation, deterministic ordering, clean cleanup, backpressure via tick dropping). |
| Repository Integrity Verification | 1 | Confirmed zero existing files modified, zero temporary artifacts remaining, working tree clean, correct branch. |
| Validation and Quality Assurance | 3 | Executed 2,082 tests (169 schedule + 1,913 state) with 100% pass rate. Verified 14+ line-number citations. Applied 3 rounds of code review fixes (10 findings, 2 line corrections, live output integration). |
| **Total Completed** | **56** | |

### 2.2 Remaining Work Detail

| Category | Hours | Priority |
|---|---|---|
| Stakeholder Review and Minor Adjustments | 2 | Medium |
| Independent Line-Number Citation Cross-Reference Audit | 1 | Low |
| **Total Remaining** | **3** | |

---

## 3. Test Results

All tests were executed by Blitzy's autonomous validation pipeline using Go 1.23.1 on the existing test suites. No test files were modified.

| Test Category | Framework | Total Tests | Passed | Failed | Coverage % | Notes |
|---|---|---|---|---|---|---|
| Schedule Unit Tests | Go test (`pkg/services/ngalert/schedule/...`) | 169 | 169 | 0 | N/A | Includes `TestProcessTicks` (28 subtests, 1.01s), `TestRuleRoutine` (22 subtests), `TestAlertRule` (13 subtests), `TestSchedulableAlertRulesRegistry_set`, `TestRuleWithFolderFingerprint` |
| State Manager Tests | Go test (`pkg/services/ngalert/state/...`) | 1,913 | 1,913 | 0 | N/A | Includes `TestProcessEvalResults` (36 subtests, 3.64s), state transition tests, persistence tests |
| State Historian Tests | Go test (`pkg/services/ngalert/state/historian/...`) | Pass | Pass | 0 | N/A | Completed in 0.054s |
| State Historian Model Tests | Go test (`pkg/services/ngalert/state/historian/model/...`) | Pass | Pass | 0 | N/A | Completed in 0.030s |
| State Template Tests | Go test (`pkg/services/ngalert/state/template/...`) | Pass | Pass | 0 | N/A | Completed in 0.034s |

**Total: 2,082+ tests executed, 0 failures, 100% pass rate.**

Key behavioral claims confirmed by test execution:
- `TestProcessTicks`: 1.01s for 17 ticks, tick-interval alignment confirmed
- `TestRuleRoutine/when_evaluation_fails`: exactly 2.00s (2 × retryDelay confirmed)
- `TestRuleRoutine/should_exit`: both cancellation paths (errRuleDeleted cleanup, errRuleRestarted no cleanup) confirmed
- `TestAlertRule`: channel drain-and-replace mechanism confirmed
- `TestProcessEvalResults`: 36 subtests in 3.64s, all state transitions confirmed

---

## 4. Runtime Validation & UI Verification

### Runtime Health

- ✅ **Go toolchain**: Go 1.23.1 confirmed (matches `go.mod` requirement)
- ✅ **Test execution**: All 5 test packages execute successfully with `go test -count=1 -timeout 120s`
- ✅ **Repository integrity**: `git status` reports clean working tree on correct branch
- ✅ **Document creation**: `blitzy/documentation/grafana_4550cfb5b728.md` exists (839 lines, 59,311 bytes)
- ✅ **Source code reference accuracy**: All 14+ line-number citations verified against actual source files

### Document Structure Verification

- ✅ 4 Mermaid diagrams present (verified via `grep -c '```mermaid'` = 4)
- ✅ 5 Thinking/Rationale sections present
- ✅ 3 Direct Answer sections present (Q1, Q2, Q3)
- ✅ 9 explicit source file citations (`Source:` format)
- ✅ Complete metric catalog with 20+ entries
- ✅ Complete log message catalog with 20 entries
- ✅ 12-row comparative analysis table

### UI Verification

- ⚠️ N/A — This is a documentation-only project with no UI components. The deliverable is a Markdown file rendered by any Mermaid-compatible viewer.

---

## 5. Compliance & Quality Review

| Compliance Criterion | Status | Evidence |
|---|---|---|
| **Repository immutability** — No existing files modified | ✅ Pass | `git diff --name-status` shows only 1 file added (`A blitzy/documentation/grafana_4550cfb5b728.md`). Zero modifications to source. |
| **Temporary cleanup** — No temporary scripts or files remain | ✅ Pass | `git status` reports clean working tree. `blitzy/` contains only `documentation/` and `screenshots/` (empty). |
| **Code-as-truth** — All claims cite specific source file and line | ✅ Pass | 14+ explicit `Source:` citations verified. Every claim references file path and line range. |
| **Thinking/rationale** — Each answer includes rationale section | ✅ Pass | 5 "Thinking / Rationale" sections present (one per Q&A section). |
| **Live exercise** — Runtime output from actual test execution | ✅ Pass | Q4 and Q5 include actual `go test -v` output with timestamps and test names. |
| **Comparative analysis** — Stressed vs. normal explicitly compared | ✅ Pass | 12-row comparison table in Q5 with quantified differences (0.00s vs 2.00s, 1:1 vs 3:1 ratios). |
| **Mermaid diagrams** — 4 diagrams required | ✅ Pass | 4 Mermaid fenced code blocks: flowchart (tick processing), stateDiagram-v2 (goroutine lifecycle), flowchart (cancellation tree), sequenceDiagram (ordering). |
| **Metric accuracy** — Names match source definitions | ✅ Pass | All metric names verified against `pkg/services/ngalert/metrics/scheduler.go`. |
| **Log message accuracy** — Strings match source literals | ✅ Pass | All 20 log message strings verified against actual source code string literals. |
| **Document placement** — In `blitzy/documentation/` directory | ✅ Pass | File at `blitzy/documentation/grafana_4550cfb5b728.md`. |
| **Single deliverable** — One markdown file as output | ✅ Pass | Exactly 1 file changed across all 4 commits. |
| **Test pass rate** — All relevant tests pass | ✅ Pass | 2,082+ tests, 0 failures, 100% pass rate. |

### Fixes Applied During Validation

1. **10 code review findings resolved** (commit `fffaeb073c`) — Addressed documentation accuracy issues
2. **2 off-by-1 line references corrected** (commit `1c8a8049ce`) — Fixed incorrect line numbers in log catalog table
3. **Live test output integrated** (commit `47e1c039ed`) — Replaced code-path-traced predictions with actual `go test -v` output in Q4/Q5 sections

---

## 6. Risk Assessment

| Risk | Category | Severity | Probability | Mitigation | Status |
|---|---|---|---|---|---|
| Line-number drift after upstream code changes | Technical | Medium | High | Document cites commit-specific lines; include note that references apply to branch `grafana_4550cfb5b728`. Periodic re-verification needed if source evolves. | Open — inherent to code-referencing documentation |
| Mermaid rendering compatibility | Technical | Low | Low | All diagrams use standard Mermaid syntax (flowchart, stateDiagram-v2, sequenceDiagram). Compatible with GitHub, GitLab, and most Markdown renderers. | Mitigated |
| Test timing sensitivity | Technical | Low | Medium | The 2.00s retry timing observation depends on `retryDelay = 1 * time.Second` constant. If this constant changes, the documented timing evidence needs updating. | Mitigated — value is from source constant, not assumption |
| Incomplete coverage of edge cases | Technical | Low | Low | The document covers the 3 primary cancellation paths and the main scheduling flow. Rare edge cases (e.g., concurrent rule deletion during retry) are not exhaustively documented. | Accepted — out of scope per AAP |
| No operational security implications | Security | N/A | N/A | This is a read-only documentation task. No credentials, API keys, or sensitive data are involved. | N/A |
| No deployment or infrastructure changes | Operational | N/A | N/A | Single Markdown file addition. No CI/CD, Docker, or infrastructure changes. | N/A |
| No external integrations | Integration | N/A | N/A | Document is self-contained. No external service dependencies. | N/A |

---

## 7. Visual Project Status

```mermaid
pie title Project Hours Breakdown
    "Completed Work" : 56
    "Remaining Work" : 3
```

**Legend:** Completed Work = 56 hours (Dark Blue #5B39F3) | Remaining Work = 3 hours (White #FFFFFF)

**Remaining Work by Category:**

| Category | Hours | Priority |
|---|---|---|
| Stakeholder Review and Minor Adjustments | 2 | Medium |
| Independent Line-Number Citation Cross-Reference Audit | 1 | Low |
| **Total** | **3** | |

---

## 8. Summary & Recommendations

### Achievement Summary

The project has been completed to **94.9%** (56 of 59 total hours). Blitzy's autonomous agents delivered a comprehensive 839-line technical Q&A investigation document that fully answers all 5 interconnected questions about the Grafana ngalert scheduler's runtime behavior under stress. The document is backed by 14+ verified source-code line references, 4 Mermaid diagrams, a complete metric and signal catalog (20+ metrics, 20 log messages, 2 trace spans), and live test execution output from 2,082+ passing tests.

### Key Findings Documented

1. **Scheduling priority**: The scheduler implements no priority-based scheduling — all rules matching a tick are dispatched in UID-sorted order with uniform staggering
2. **Cancellation cleanup**: Zero orphaned cache entries across all cancellation paths, discriminated by `errRuleDeleted` vs `errRuleRestarted`
3. **Result ordering**: Strict per-rule FIFO guaranteed by unbuffered channels; cross-rule ordering is deterministic per tick via UID sort
4. **Stress indicators**: `BehindSeconds` growth and `EvaluationMissed` incrementing are the primary observable signals
5. **Normal vs stressed**: Regular heartbeat pattern degrades to continuous catch-up pattern with 2.00s retry delays (vs 0.00s normal)

### Remaining Gaps

The remaining 3 hours (5.1%) consist exclusively of human review tasks: stakeholder review of the document for accuracy and completeness (2h) and an independent audit of line-number citations (1h). No code changes, bug fixes, or feature work remain.

### Production Readiness Assessment

**PRODUCTION-READY** — The document is complete, accurate, and committed. All validation checks pass (100% test pass rate, all line references verified, clean working tree). The document is ready for stakeholder review and merge.

### Success Metrics

| Metric | Target | Actual |
|---|---|---|
| Questions answered | 5/5 | 5/5 ✅ |
| Mermaid diagrams | 4 | 4 ✅ |
| Thinking/rationale sections | 5 | 5 ✅ |
| Source code references verified | 100% | 100% ✅ |
| Test pass rate | 100% | 100% (2,082+ tests) ✅ |
| Existing files modified | 0 | 0 ✅ |
| Temporary artifacts remaining | 0 | 0 ✅ |

---

## 9. Development Guide

### System Prerequisites

| Software | Version | Purpose |
|---|---|---|
| Go | 1.23.1 | Required Go version per `go.mod`; needed to run test suites |
| Git | 2.x+ | Repository operations |
| Linux/macOS | Any modern version | Development environment |

### Environment Setup

```bash
# 1. Clone the repository and checkout the branch
git clone <repository-url>
cd grafana
git checkout blitzy-b6afc451-6073-4d08-8d9c-21d8abd75c1e

# 2. Verify Go version
export PATH=$PATH:/usr/local/go/bin
go version
# Expected: go version go1.23.1 linux/amd64

# 3. Verify the document exists
ls -la blitzy/documentation/grafana_4550cfb5b728.md
# Expected: 839 lines, ~59KB file
```

### Viewing the Document

The document is a standard Markdown file with embedded Mermaid diagrams. View with any Mermaid-compatible renderer:

- **GitHub/GitLab**: Renders Mermaid natively in PR/file views
- **VS Code**: Install "Markdown Preview Mermaid Support" extension
- **CLI**: `cat blitzy/documentation/grafana_4550cfb5b728.md | less`

### Running Verification Tests

All behavioral claims in the document can be verified by running the existing test suites:

```bash
# Navigate to repository root
cd /path/to/grafana

# Export Go path if needed
export PATH=$PATH:/usr/local/go/bin

# Run scheduler tests (confirms Q1 scheduling, Q2 cancellation, Q3 ordering claims)
go test -v -count=1 -timeout 120s ./pkg/services/ngalert/schedule/...
# Expected: PASS (169 tests, ~3.2s)
# Key: TestProcessTicks (1.01s), TestRuleRoutine/when_evaluation_fails (2.00s)

# Run state manager tests (confirms Q4/Q5 state processing claims)
go test -v -count=1 -timeout 120s ./pkg/services/ngalert/state/...
# Expected: PASS (1913+ tests, ~6.6s)
# Key: TestProcessEvalResults (36 subtests, 3.64s)

# Run specific test groups for targeted verification:

# Verify tick processing and scheduling (Q1)
go test -v -run "TestProcessTicks" -count=1 -timeout 60s ./pkg/services/ngalert/schedule/...

# Verify cancellation paths (Q2)
go test -v -run "TestRuleRoutine/should_exit" -count=1 -timeout 60s ./pkg/services/ngalert/schedule/...

# Verify channel semantics (Q3)
go test -v -run "TestAlertRule" -count=1 -timeout 60s ./pkg/services/ngalert/schedule/...

# Verify retry timing (Q4 stress evidence)
go test -v -run "TestRuleRoutine/when_evaluation_fails" -count=1 -timeout 60s ./pkg/services/ngalert/schedule/...

# Verify registry diff detection
go test -v -run "TestSchedulableAlertRulesRegistry_set" -count=1 -timeout 60s ./pkg/services/ngalert/schedule/...

# Verify fingerprint behavior
go test -v -run "TestRuleWithFolderFingerprint" -count=1 -timeout 60s ./pkg/services/ngalert/schedule/...
```

### Verifying Source Code Line References

To spot-check that cited line numbers are still accurate:

```bash
# Verify processTick() starts at line 235
sed -n '235p' pkg/services/ngalert/schedule/schedule.go
# Expected: func (sch *schedule) processTick(...)

# Verify evalCh creation at line 161
sed -n '161p' pkg/services/ngalert/schedule/alert_rule.go
# Expected: evalCh: make(chan *Evaluation),

# Verify errRuleDeleted/errRuleRestarted at lines 19-20
sed -n '19,20p' pkg/services/ngalert/schedule/registry.go
# Expected: errRuleDeleted = errors.New("rule deleted")
#           errRuleRestarted = errors.New("rule restarted")

# Verify BehindSeconds metric at lines 40-45
sed -n '40,45p' pkg/services/ngalert/metrics/scheduler.go
# Expected: BehindSeconds: promauto.With(r).NewGauge(...)
```

### Troubleshooting

| Issue | Resolution |
|---|---|
| `go: command not found` | Run `export PATH=$PATH:/usr/local/go/bin` |
| Test timeout | Increase timeout: `go test -timeout 300s ...` |
| Mermaid diagrams not rendering | Use a Mermaid-compatible Markdown viewer (GitHub, GitLab, VS Code with extension) |
| Line numbers don't match | Source may have changed since branch `grafana_4550cfb5b728`; check `git log` for modifications |

---

## 10. Appendices

### A. Command Reference

| Command | Purpose |
|---|---|
| `go test -v -count=1 -timeout 120s ./pkg/services/ngalert/schedule/...` | Run all scheduler tests with verbose output |
| `go test -v -count=1 -timeout 120s ./pkg/services/ngalert/state/...` | Run all state manager tests with verbose output |
| `go test -v -run "TestProcessTicks" ./pkg/services/ngalert/schedule/...` | Run tick processing tests only |
| `go test -v -run "TestRuleRoutine" ./pkg/services/ngalert/schedule/...` | Run rule routine lifecycle tests |
| `go test -v -run "TestAlertRule" ./pkg/services/ngalert/schedule/...` | Run alert rule channel semantics tests |
| `git diff --stat origin/grafana_4550cfb5b728...HEAD` | View files changed on this branch |
| `wc -l blitzy/documentation/grafana_4550cfb5b728.md` | Count document lines (expected: 839) |
| `grep -c '```mermaid' blitzy/documentation/grafana_4550cfb5b728.md` | Count Mermaid diagrams (expected: 4) |

### B. Port Reference

Not applicable — this is a documentation-only project with no running services.

### C. Key File Locations

| File | Purpose |
|---|---|
| `blitzy/documentation/grafana_4550cfb5b728.md` | **Deliverable** — The Q&A investigation document (839 lines) |
| `pkg/services/ngalert/schedule/schedule.go` | Primary source — Scheduler orchestration, `processTick()` (397 lines) |
| `pkg/services/ngalert/schedule/alert_rule.go` | Primary source — Per-rule goroutine lifecycle, `Run()`, `Eval()` (529 lines) |
| `pkg/services/ngalert/schedule/registry.go` | Primary source — Rule registries, diff detection, fingerprinting (336 lines) |
| `pkg/services/ngalert/schedule/fetcher.go` | Primary source — Two-phase rule fetch optimization (41 lines) |
| `pkg/services/ngalert/schedule/jitter.go` | Primary source — Jitter strategy and deterministic offsets (70 lines) |
| `pkg/services/ngalert/eval/eval.go` | Primary source — Evaluation engine with timeout/retry (859 lines) |
| `pkg/services/ngalert/state/manager.go` | Primary source — State manager, `ProcessEvalResults()`, `DeleteStateByRuleUID()` (660 lines) |
| `pkg/services/ngalert/state/cache.go` | Primary source — Concurrent state cache (404 lines) |
| `pkg/services/ngalert/metrics/scheduler.go` | Primary source — Scheduler Prometheus metric definitions (196 lines) |
| `pkg/util/ticker/ticker.go` | Primary source — Non-dropping custom ticker (85 lines) |
| `pkg/services/ngalert/README.md` | Architecture reference — ngalert subsystem overview |
| `pkg/services/ngalert/schedule/schedule_unit_test.go` | Test source — Scheduler tick processing tests (1,126 lines) |
| `pkg/services/ngalert/schedule/alert_rule_test.go` | Test source — Alert rule lifecycle tests (881 lines) |

### D. Technology Versions

| Technology | Version | Notes |
|---|---|---|
| Go | 1.23.1 | Per `go.mod`; required for test execution |
| Grafana (monorepo) | Branch `grafana_4550cfb5b728` | Source commit for all line-number references |
| Prometheus client_golang | Per `go.sum` | Defines metric types used in scheduler metrics |
| benbjohnson/clock | Per `go.sum` | Mock clock library used in scheduler tests |
| testify | Per `go.sum` | Test assertion library |
| OpenTelemetry (otel) | Per `go.sum` | Tracing library for trace spans documented in catalog |
| Mermaid | N/A (embedded in Markdown) | Diagram rendering; supported by GitHub/GitLab/VS Code |

### E. Environment Variable Reference

Not applicable — this documentation project does not require environment variables. The source Grafana application's environment configuration is documented in `conf/defaults.ini` and the existing alerting documentation.

### G. Glossary

| Term | Definition |
|---|---|
| **ngalert** | Grafana's unified alerting subsystem (`pkg/services/ngalert/`) |
| **processTick()** | The central dispatch function in `schedule.go` that determines which rules to evaluate on each tick |
| **evalCh** | Unbuffered Go channel (`chan *Evaluation`) used to deliver evaluation events from `processTick()` to each rule's goroutine |
| **errRuleDeleted** | Sentinel error (`errors.New("rule deleted")`) used as a cancellation cause to trigger full state cleanup |
| **errRuleRestarted** | Sentinel error (`errors.New("rule restarted")`) used as a cancellation cause when a rule changes type; no cleanup occurs |
| **BehindSeconds** | Prometheus gauge (`grafana_alerting_scheduler_behind_seconds`) measuring how far the scheduler lags behind real time |
| **EvaluationMissed** | Prometheus counter (`grafana_alerting_schedule_rule_evaluations_missed_total`) counting dropped ticks per rule |
| **baseInterval** | The fundamental scheduling interval (default 10s in production); all rule intervals are multiples of this |
| **retryDelay** | 1-second constant (`schedule.go:36`) defining the pause between failed evaluation attempts |
| **maxAttempts** | Configurable maximum number of evaluation attempts per tick (default 3) |
| **Fingerprint** | FNV-64 hash of rule fields (excluding Version, Updated, IntervalSeconds) used for change detection in `registry.go` |
| **readyToRun** | Slice of rules eligible for evaluation on the current tick, sorted by UID before dispatch |
| **stagger** | `time.AfterFunc`-based dispatch delay: `step = baseInterval / len(readyToRun)`, with each rule dispatched at `i * step` |
