# Grafana Unified Alerting under stress vs. normal load: scheduler work-selection, cancellation/cleanup, and ordering

> **Repository:** `github.com/grafana/grafana` &nbsp;•&nbsp; **Branch:** `grafana_4550cfb5b728` &nbsp;•&nbsp; **Pinned HEAD:** `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`
>
> Every behavioral claim in this document is grounded in the source at this exact revision and is cited in `[path:Lline]` form. Each claim is then demonstrated with **real runtime output** captured from a Grafana server **built and run from this repository**. Official Grafana documentation is used only as *corroboration* and is clearly labeled as such.

---

## 1. Introduction and method

A new contributor asked three questions about how Grafana's Unified Alerting evaluation/notification path behaves *while it is running*, because reading the code alone did not make the runtime behavior obvious. This document answers them by (a) explaining the relevant code paths at the pinned revision, and (b) exercising a live server under a deliberately **stressed** scenario and then under a **normal** scenario, capturing the observable signals in both and explaining *why* each signal supports the described behavior.

The three questions, reproduced verbatim, are:

- **Q1 — work-selection under backpressure:** *"When many alert rule changes arrive while evaluations are already falling behind and a data source begins to time out, how does the system decide what to work on next, and where does that choice first become visible while it is running?"*
- **Q2 — cancellation/removal cleanup:** *"If an evaluation is canceled or a rule is removed partway through, does anything get left behind, or does the system cleanly move on, and what signs at runtime tell you which one happened?"*
- **Q3 — ordering:** *"During that same window, do evaluation results ever appear out of order, and if they do not, what observable behavior suggests the ordering was preserved?"*

### 1.1 What was built and run

- **Build/run environment:** the user-provided Docker environment (`ghcr.io/scaleapi/swe-atlas:swe_atlas_QnA_grafana_grafana_1.0`), Go `1.23.1` `[go.mod:L3]`. A backend-only build is sufficient because Unified Alerting and the `/metrics` endpoint are entirely backend; no frontend build was required.
- **Server binary:** the real Grafana server (`./pkg/cmd/grafana`), run as `grafana server`. Unified Alerting is on by default — the `enabled` key in `[unified_alerting]` is intentionally blank `[conf/defaults.ini:L1220-L1222]`.
- **Source repository was never modified.** All alerting source files are read-only references. Every artifact used to drive and observe the experiment (config `.ini` files, datasource/rule provisioning, a slow HTTP server, a `/metrics` scraper, a churn driver) lived **outside** the repository tree under `/tmp` and was removed afterward. The only repository change is this document. See the cleanup note in [Appendix B](#appendix-b--cleanup-and-repository-integrity).

### 1.2 Two evidence channels

All evidence comes from two channels exposed by the running process:

1. **Structured logs (JSON)** emitted by the alerting loggers:
   - `ngalert.scheduler` — the scheduler tick loop and per-rule routines (the per-rule routine logger carries `org_id` and `rule_uid` via `WithRuleKey`) `[pkg/services/ngalert/ngalert.go:L390]`.
   - `ngalert.state.manager` — state processing and cleanup `[pkg/services/ngalert/ngalert.go:L414]`.
   - `ticker` — the tick generator.
2. **Prometheus `/metrics`** served at `http://127.0.0.1:3000/metrics`. The endpoint is implemented by `metricsEndpoint` `[pkg/api/http_server.go:L660]`, gated by `if !hs.Cfg.MetricsEndpointEnabled { return }` `[pkg/api/http_server.go:L661]`, restricted to the `/metrics` path `[pkg/api/http_server.go:L665]`, and served by `promhttp.HandlerFor(hs.promGatherer, …)` `[pkg/api/http_server.go:L675-L677]`. The alerting series carry the prefix `grafana_alerting_` because `Namespace = "grafana"` `[pkg/services/ngalert/metrics/ngalert.go:L10]` and `Subsystem = "alerting"` `[pkg/services/ngalert/metrics/ngalert.go:L11]`; the full series name is `<Namespace>_<Subsystem>_<Name>`.

### 1.3 The defaults that frame the experiment

| Constant | Value | Source |
|---|---|---|
| Scheduler base / tick interval | `10s` | `SchedulerBaseInterval = 10 * time.Second` `[pkg/setting/setting_unified_alerting.go:L62]`, `min_interval = 10s` `[conf/defaults.ini:L1346]` |
| Default rule evaluation interval | `60s` | `DefaultRuleEvaluationInterval = SchedulerBaseInterval * 6` `[pkg/setting/setting_unified_alerting.go:L64]` |
| Per-evaluation timeout | `30s` | `evaluatorDefaultEvaluationTimeout = 30 * time.Second` `[pkg/setting/setting_unified_alerting.go:L49]` |
| Max evaluation attempts | `3` | `schedulerDefaultMaxAttempts = 3` `[pkg/setting/setting_unified_alerting.go:L52]` |

### 1.4 The two scenarios

| | **Stressed** | **Normal** |
|---|---|---|
| Rules | many (60 slow + up to 700 fast) | few — **3** (timing baseline) / **24** (churn comparison) |
| Rule interval | `10s` (minimum) | `60s` (default) |
| Data source | a **slow HTTP datasource** whose latency exceeds the 30s eval timeout | a healthy fast TestData source |
| Rule churn | scripted create / update / delete / **type-change** mid-run | the **same** scripted create / update / delete / type-change churn |
| Scheduler tick | `1s` (via the `configurableSchedulerTick` feature toggle) to magnify and accelerate the effect | `10s` (default) |

> **A note on the stressed tick interval.** Grafana allows the scheduler tick to be overridden when the `configurableSchedulerTick` feature toggle is enabled; the value is parsed at `[pkg/setting/setting_unified_alerting.go:L335]` and gated by the toggle at `[pkg/setting/setting_unified_alerting.go:L336]`. Using `1s` does not change *what* the scheduler does — it only makes "falling behind" accumulate faster and more visibly. The normal scenario uses the real default `10s` tick for an honest baseline.

### 1.5 Summary of findings

- **Q1:** There is **no priority queue**. On each tick the scheduler selects exactly the rules whose interval has elapsed, sorts them by rule UID, and spreads their dispatch evenly across the base interval. "Falling behind" is reported by the `grafana_alerting_scheduler_behind_seconds` gauge, which is set at the very top of every tick *before any rule is dispatched*. A separate, eval-layer signal — the `…schedule_rule_evaluations_missed_total` counter together with the WARN `"Tick dropped because alert rule evaluation is too slow"` — fires when a rule's previous evaluation is still running and a newer one supersedes it (newest-wins). The live runs let me show that these are **two distinct layers** of backpressure.
- **Q2:** Deleting a rule produces a **clean teardown** (state deleted + resolved notifications sent + `"Stopping alert rule routine"`); a *restart* due to a type change deliberately **preserves** state; and a canceled in-flight evaluation is guarded so that **nothing partial is persisted**. Each case has a distinct runtime signature, captured live.
- **Q3:** Each rule is evaluated by a **single consumer goroutine** reading from its **own unbuffered channel**, which makes per-rule reordering structurally impossible. The observable evidence is the strictly monotonic per-evaluation `now`/scheduled-at timestamps in the rule's logs, even when individual evaluations slow down.

The rest of this document answers each question with code, then evidence, then rationale, and finishes with a side-by-side stressed-vs-normal comparison and a reproduction appendix.

---

## 2. Q1 — Work-selection under backpressure

> *"When many alert rule changes arrive while evaluations are already falling behind and a data source begins to time out, how does the system decide what to work on next, and where does that choice first become visible while it is running?"*

### 2.1 What the code does

**There is no priority queue and no notion of "most important" rule.** Work selection is purely *time-driven*. The scheduler runs a periodic loop, and on each tick it asks, for every registered rule, a single arithmetic question: *has this rule's interval elapsed on this tick?*

```go
// pkg/services/ngalert/schedule/schedule.go  (processTick)
isReadyToRun := item.IntervalSeconds != 0 && (tickNum%itemFrequency)-offset == 0
```

This readiness test is at `[pkg/services/ngalert/schedule/schedule.go:L316]`; the per-rule `offset` it subtracts is the jitter offset computed one line earlier `[pkg/services/ngalert/schedule/schedule.go:L315]`. A rule "wins" a tick **iff** its interval (expressed in ticks, `itemFrequency`) divides the current tick number after the jitter offset — there is no scoring, no deadline ranking, no starvation avoidance beyond this modular schedule.

Once the set of ready rules for the tick is known, the scheduler makes the choice **deterministic and evenly spread**:

```go
// pkg/services/ngalert/schedule/schedule.go
step = sch.baseInterval.Nanoseconds() / int64(len(readyToRun))          // L359-361
slices.SortFunc(readyToRun, func(a, b readyToRunItem) int {
    return strings.Compare(a.rule.UID, b.rule.UID)                      // L364-366  (sort by rule UID)
})
// …dispatch rule i after i*step, each in its own goroutine:
time.AfterFunc(time.Duration(int64(i)*step), func() { … })             // L370
```

So the ready rules are **sorted by UID** `[pkg/services/ngalert/schedule/schedule.go:L364-L366]` and then **dispatched at staggered offsets** across the base interval via `time.AfterFunc` `[pkg/services/ngalert/schedule/schedule.go:L370]`. The per-rule jitter offset itself comes from `jitterOffsetInTicks(...)` `[pkg/services/ngalert/schedule/jitter.go:L39]`, which deterministically distributes a group's rules across the interval so they don't all fire on the same tick. This staggering is the "rhythm" you can observe in the logs.

**Where does "falling behind" first become visible?** At the very top of every tick, *before any rule is dispatched*, the scheduler records how late the tick is:

```go
// pkg/services/ngalert/schedule/schedule.go  (schedulePeriodic → processTick)
start := time.Now().Round(0)                                  // L214
sch.metrics.BehindSeconds.Set(start.Sub(tick).Seconds())      // L215
```

`BehindSeconds` is the gauge `grafana_alerting_scheduler_behind_seconds` `[pkg/services/ngalert/metrics/scheduler.go:L43]`. Because the assignment at `[pkg/services/ngalert/schedule/schedule.go:L215]` happens *before* the readiness scan and dispatch, **this gauge is the single earliest, most direct place that "we are behind" is observable while running.** It measures the gap between *now* and the timestamp of the tick currently being processed.

There is a second, **eval-layer** backpressure signal. Each rule has its own **unbuffered** evaluation channel:

```go
evalCh: make(chan *Evaluation),   // pkg/services/ngalert/schedule/alert_rule.go:L161  (UNBUFFERED)
```

When the scheduler dispatches a rule, `Eval()` first performs a **non-blocking drain** of any still-pending evaluation (newest-wins), then offers the newest one:

```go
// pkg/services/ngalert/schedule/alert_rule.go  (Eval)
select {
case droppedMsg = <-a.evalCh:   // discard the older, not-yet-consumed evaluation
default:
}                                                        // L204-207
select {
case a.evalCh <- eval:
    return true, droppedMsg
case <-a.ctx.Done():
    return false, droppedMsg
}                                                        // L209-214
```

If the previous evaluation is still running (the single consumer hasn't taken the prior item), the drained older item becomes `dropped`, and the scheduler logs a WARN and increments a counter:

```go
// pkg/services/ngalert/schedule/schedule.go
sch.log.Warn("Tick dropped because alert rule evaluation is too slow", …)  // L378
sch.metrics.EvaluationMissed.WithLabelValues(orgID, item.rule.Title).Inc() // L379-380
```

`EvaluationMissed` is `grafana_alerting_schedule_rule_evaluations_missed_total{org,name}` `[pkg/services/ngalert/metrics/scheduler.go:L181]` (labels `org`, `name` `[pkg/services/ngalert/metrics/scheduler.go:L184]`). This is the **per-rule** "we couldn't keep up" signal, as distinct from the scheduler-loop `behind_seconds` gauge above.

Crucially, the tick generator **queues** ticks rather than dropping them. The ticker doc comment states it "doesn't drop ticks for slow receivers, rather, it queues up" `[pkg/util/ticker/ticker.go:L12-L16]`, and it advances its internal `last` marker **only after** a tick is accepted by the receiver: `t.last = next` `[pkg/util/ticker/ticker.go:L64]`. Therefore, backpressure manifests as a **rising `behind_seconds`** and a **`ticker_last_consumed_tick_timestamp_seconds` that lags `ticker_next_tick_timestamp_seconds`** `[pkg/util/ticker/metrics.go:L19,L25]` — **not** as skipped tick numbers.

Finally, the "data source begins to time out" part of the question: each evaluation wraps its query execution in a per-evaluation timeout,

```go
if r.evalTimeout >= 0 {
    timeoutCtx, cancel := context.WithTimeout(ctx, r.evalTimeout)   // pkg/services/ngalert/eval/eval.go:L73-L77
    …
}
```

and a failed/timed-out evaluation becomes an **Error-state** result via `NewResultFromError(...)` `[pkg/services/ngalert/eval/eval.go:L265]`, which sets `State: Error` `[pkg/services/ngalert/eval/eval.go:L267]`. With the default 30s timeout `[pkg/setting/setting_unified_alerting.go:L49]` and up to 3 attempts `[pkg/setting/setting_unified_alerting.go:L52]`, a slow data source consumes a rule's evaluation slot for tens of seconds before resolving to Error.

### 2.2 Live evidence (stressed run)

**(a) "Falling behind" is reported by the gauge, and the ticker lags but does not skip.** A `/metrics` snapshot during the stressed run (1s tick, 760 rules, slow datasource):

```text
grafana_alerting_scheduler_behind_seconds 46.971341101
grafana_alerting_ticker_interval_seconds 1
grafana_alerting_ticker_last_consumed_tick_timestamp_seconds 1.782509078e+09
grafana_alerting_ticker_next_tick_timestamp_seconds 1.782509079e+09
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="0.1"} 140
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="0.5"} 201
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="1"} 211
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="10"} 273
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="+Inf"} 275
grafana_alerting_schedule_periodic_duration_seconds_sum 317.9696965410002
grafana_alerting_schedule_periodic_duration_seconds_count 275
```

The gauge reads **46.97s behind** (it peaked around **64.5s** during the run). The `schedule_periodic_duration_seconds` histogram `[pkg/services/ngalert/metrics/scheduler.go:L147]` explains *why*: most ticks are fast (211 of 275 finish under 1s) but a heavy tail runs longer than 10s, so the mean tick-processing time (`sum/count` ≈ 317.97/275 ≈ **1.16s**) exceeds the **1s** tick interval — every such tick pushes the scheduler further behind.

A subtle point about the two ticker timestamps in this snapshot: `ticker_next_tick_timestamp_seconds − ticker_last_consumed_tick_timestamp_seconds = 1.782509079e9 − 1.782509078e9 = ` **exactly 1s — the tick interval, not the backlog.** This is structural: the ticker computes `next := t.last.Add(t.interval)` and publishes it as `NextTickTime`, then advances `t.last = next` and sets `LastTickTime` *only after* the scheduler consumes the tick `[pkg/util/ticker/ticker.go:L54-L65]`, so `next − last_consumed` is always one interval by construction and can never widen into a backlog reading. Backpressure instead surfaces as the rising **`scheduler_behind_seconds`** (46.97s here) — computed as wall-clock now minus the timestamp of the tick currently being processed `[pkg/services/ngalert/schedule/schedule.go:L214-L215]`. The ticker itself *queues rather than drops*: its `last` marker advances monotonically by exactly one interval per consumed tick and never skips a tick number `[pkg/util/ticker/ticker.go:L12-L16]`, so "falling behind" is visible as a growing `behind_seconds` (and a `last_consumed` timestamp lagging wall-clock), never as gaps in the tick sequence — exactly the "queue, don't drop" signature.

**(b) The per-rule "too slow" signal: WARN + missed counter.** Real log lines (identifiers preserved — note `org_id` and `rule_uid`):

```json
{"droppedTick":"2026-06-26T21:20:16Z","level":"warn","logger":"ngalert.scheduler","msg":"Tick dropped because alert rule evaluation is too slow","org_id":1,"rule_uid":"slow0047","t":"2026-06-26T21:21:01.24496341Z","time":"2026-06-26T21:20:26Z"}
{"droppedTick":"2026-06-26T21:20:16Z","level":"warn","logger":"ngalert.scheduler","msg":"Tick dropped because alert rule evaluation is too slow","org_id":1,"rule_uid":"slow0029","t":"2026-06-26T21:21:01.244988574Z","time":"2026-06-26T21:20:26Z"}
{"droppedTick":"2026-06-26T21:20:16Z","level":"warn","logger":"ngalert.scheduler","msg":"Tick dropped because alert rule evaluation is too slow","org_id":1,"rule_uid":"slow0048","t":"2026-06-26T21:21:01.444486485Z","time":"2026-06-26T21:20:26Z"}
```

and the matching counter, scraped from `/metrics` (per-rule, labeled `org` and `name`):

```text
grafana_alerting_schedule_rule_evaluations_missed_total{name="slow_rule_0002",org="1"} 24
grafana_alerting_schedule_rule_evaluations_missed_total{name="slow_rule_0057",org="1"} 23
grafana_alerting_schedule_rule_evaluations_missed_total{name="slow_rule_0055",org="1"} 23
grafana_alerting_schedule_rule_evaluations_missed_total{name="slow_rule_0054",org="1"} 23
```

Over the run this counter climbed from `0` to **927** across the slow rules, and the WARN fired **1158** times. The `droppedTick` field is the `scheduledAt` of the *older* evaluation that the newest-wins drain discarded — precisely the item drained at `[pkg/services/ngalert/schedule/alert_rule.go:L204-L207]`.

**(c) The data source timing out → retries → Error state.** The slow datasource's latency exceeds the 30s eval timeout, so queries fail with `context deadline exceeded` after ~30s, and the evaluation retries up to attempt 3:

```json
{"attempt":1,"error":"… Post \"http://127.0.0.1:9099/api/v1/query\": context deadline exceeded","level":"error","logger":"ngalert.scheduler","msg":"Failed to evaluate rule","now":"2026-06-26T21:20:06Z","org_id":1,"rule_uid":"slow0025","t":"2026-06-26T21:20:41.771399641Z","version":2}
{"attempt":2,"error":"… context deadline exceeded","level":"error","logger":"ngalert.scheduler","msg":"Failed to evaluate rule","now":"2026-06-26T21:20:06Z","org_id":1,"rule_uid":"slow0027","t":"2026-06-26T21:20:43.871698245Z","version":2}
{"duration":"30.012496293s","error":"… net/http: timeout awaiting response headers","level":"debug","logger":"ngalert.scheduler","msg":"Alert rule evaluated","now":"2026-06-26T21:20:06Z","org_id":1,"rule_uid":"slow0044","t":"2026-06-26T21:20:50.357893424Z","version":2}
```

The `duration":"30.01…s"` confirms the **30s** per-evaluation timeout `[pkg/setting/setting_unified_alerting.go:L49]` firing on the wrapper at `[pkg/services/ngalert/eval/eval.go:L73-L77]`. The state manager then transitions the instance to `Error` (this is the `NewResultFromError`/`State: Error` path `[pkg/services/ngalert/eval/eval.go:L265-L267]`):

```json
{"handler":"resultError","level":"debug","logger":"ngalert.state.manager","msg":"Setting next state","org_id":1,"rule_uid":"slow0044","t":"2026-06-26T21:20:50.357973224Z"}
{"level":"debug","logger":"ngalert.state.manager","msg":"Changing state","next_state":"Error","previous_state":"Normal","next_ends_at":"2026-06-26T21:22:06Z","org_id":1,"rule_uid":"slow0044","t":"2026-06-26T21:20:50.357984773Z"}
```

The `rule_evaluation_failures_total` counter `[pkg/services/ngalert/metrics/scheduler.go:L63]` rose from `0` to **174** while this was happening.

**(d) The decisive nuance: `behind_seconds` and `missed_total` are two *different* backpressure layers.** This is the one place where the live runs taught me something the code reading alone did not make obvious, so I triangulated it deliberately:

- **Run 1** — 760 rules, `wal=false`, state history on → `behind_seconds` climbed to **64.5s**.
- **Run 2** — 210 rules, `wal=true` → *identical* eval backpressure (slow datasource, same missed/Error signals) but `behind_seconds` stayed at **~0.0008s**.
- **Stress 3** — 211 rules, `wal=false`, state history **off**, 1s tick, with a write-storm of **1825** rule create/delete bursts in 60s → `behind_seconds` stayed **flat at 0.00** the entire time; `missed_total` delta was `0`; mean tick processing was **~6.3 ms** (`schedule_periodic_duration_seconds` sum 1.23s / 197 ticks).

```text
# stress3: 211 rules, wal=false, state_history OFF, 1s tick
# 1825 write-bursts (storm) -> behind_seconds stayed 0.00 throughout
# CONFIRMS: behind_seconds is driven by processTick read latency (rule-count x contention),
# NOT by write churn alone at moderate rule count. Eval layer (missed_total) also flat (evals fast).
```

The interpretation, grounded in the code: `behind_seconds` is set from how long *the tick itself* takes `[pkg/services/ngalert/schedule/schedule.go:L214-L215]`, and the dominant cost inside `processTick` is reading all rules from the database; the evaluations themselves run in **separate goroutines** scheduled by `time.AfterFunc` `[pkg/services/ngalert/schedule/schedule.go:L370]` and therefore do **not** block the tick loop. So `behind_seconds` rises when *rule-count × DB-read contention* makes per-tick processing exceed the tick interval (Run 1's combination did; the lighter runs did not), while *slow evaluations* surface separately through `missed_total` + the WARN + Error-state results. Both were present in Run 1, which is why it is the headline stressed run.

### 2.3 Rationale — why this answers Q1

- **"How does the system decide what to work on next?"** It does **not** prioritize; it selects exactly the rules whose interval has elapsed on the current tick `[pkg/services/ngalert/schedule/schedule.go:L316]`, orders them deterministically by UID `[pkg/services/ngalert/schedule/schedule.go:L364-L366]`, and spreads them across the interval via jitter + `AfterFunc` `[pkg/services/ngalert/schedule/jitter.go:L39]`, `[pkg/services/ngalert/schedule/schedule.go:L370]`. "Many rule changes arriving" does not reshuffle priorities — the next tick simply re-scans the (now updated) rule set with the same modular test. When a rule can't keep up, the newest-wins drain `[pkg/services/ngalert/schedule/alert_rule.go:L204-L214]` keeps only the freshest pending evaluation and *drops* the stale one.
- **"Where does that choice first become visible?"** The earliest, most direct runtime signal is the `grafana_alerting_scheduler_behind_seconds` gauge, set at the top of the tick *before any rule runs* `[pkg/services/ngalert/schedule/schedule.go:L214-L215]` — demonstrated above reading 46.97s (peak 64.5s). The per-rule consequence becomes visible a moment later as the WARN `"Tick dropped because alert rule evaluation is too slow"` `[pkg/services/ngalert/schedule/schedule.go:L378]` plus the `…rule_evaluations_missed_total{org,name}` counter `[pkg/services/ngalert/metrics/scheduler.go:L181]` — demonstrated climbing to 927 with `org_id=1` and specific `rule_uid`s. The slow data source surfaces as 30s-timeout errors and `Error`-state transitions.
- **Pauses / rhythm changes (a meta-requirement).** Under stress the staggered `AfterFunc` cadence becomes irregular: ticks bunch up (heavy histogram tail), the consumed-tick timestamp lags the next-tick timestamp, and slow rules visibly stall for ~30s at a time before erroring. The *measurable* expression of that "pause" is the rising `behind_seconds` and the climbing `missed_total`, neither of which appears in the normal run ([§5](#5-stressed-vs-normal-comparison)).


---

## 3. Q2 — Cancellation / removal cleanup

> *"If an evaluation is canceled or a rule is removed partway through, does anything get left behind, or does the system cleanly move on, and what signs at runtime tell you which one happened?"*

### 3.1 What the code does

Each rule's routine runs under a context built with a **cancel-cause**, so the *reason* a routine stops is recoverable later:

```go
// pkg/services/ngalert/schedule/alert_rule.go
ctx, stop := util.WithCancelCause(ngmodels.WithRuleKey(parent, key.AlertRuleKey))  // L158
```

There are **three** distinct outcomes, distinguished by the cancel cause and by *where* in the routine the cancellation is observed. Two sentinel errors encode the intent:

```go
// pkg/services/ngalert/schedule/registry.go
errRuleDeleted   = errors.New("rule deleted")     // L19
errRuleRestarted = errors.New("rule restarted")   // L20
```

**Outcome 1 — rule removed (delete): clean teardown.** Deleting a rule goes through `deleteAlertRule` `[pkg/services/ngalert/schedule/schedule.go:L183]`, which stops the routine with the delete cause: `ruleRoutine.Stop(errRuleDeleted)` `[pkg/services/ngalert/schedule/schedule.go:L198]`. The routine's main `select` observes the done context and inspects the cause:

```go
// pkg/services/ngalert/schedule/alert_rule.go  (Run)
case <-grafanaCtx.Done():                                         // L347
    if errors.Is(grafanaCtx.Err(), errRuleDeleted) {              // L349
        // clean teardown: remove state + send resolved notifications
        states := a.stateManager.DeleteStateByRuleUID(ctx, a.key, ngmodels.StateReasonRuleDeleted)  // L355
        a.expireAndSend(grafanaCtx, states)                       // L356
    }
    a.logger.Debug("Stopping alert rule routine")                 // L358
```

So a deleted rule **does not leave state behind**: `DeleteStateByRuleUID(..., StateReasonRuleDeleted)` `[pkg/services/ngalert/state/manager.go:L236]` removes the cached/persisted state, and `expireAndSend` pushes **resolved** notifications for whatever was firing, before the routine logs `"Stopping alert rule routine"` `[pkg/services/ngalert/schedule/alert_rule.go:L358]`.

**Outcome 2 — rule restarted (e.g. its query/type changed): state preserved on purpose.** When a rule must be restarted rather than deleted, the stop cause is `errRuleRestarted` `[pkg/services/ngalert/schedule/registry.go:L20]`. Because the `errors.Is(..., errRuleDeleted)` guard at `[pkg/services/ngalert/schedule/alert_rule.go:L349]` is **false** in this case, the teardown branch is skipped and the rule's state is **deliberately preserved** across the restart. This is the key behavioral difference: *delete throws state away; restart keeps it.*

**Outcome 3 — an in-flight evaluation is canceled: nothing partial is persisted.** The routine guards the state write on both sides of the evaluation. Before evaluating:

```go
// pkg/services/ngalert/schedule/alert_rule.go
if tracingCtx.Err() != nil {                                                                 // L320
    … logger.Error("Skip evaluation and updating the state because the context has been cancelled", …)  // L323
    return …
}
```

and after evaluating, before writing state:

```go
if ctx.Err() != nil {                                                                        // L391
    logger.Debug("Skip updating the state because the context has been cancelled")           // L393
    return nil                                                                               // L394
}
```

The post-eval guard returns `nil` **without** calling `ProcessEvalResults`, so a canceled evaluation **never partially writes state** — it is simply abandoned `[pkg/services/ngalert/schedule/alert_rule.go:L391-L394]`. (For completeness, when the scheduler tears a routine down it may also log the DEBUG `"Scheduled evaluation was canceled because evaluation routine was stopped"` `[pkg/services/ngalert/schedule/schedule.go:L374]`.)

### 3.2 Live evidence (stressed run with scripted churn)

During the stressed run I drove scripted churn against **named UIDs** so each path is UID-traceable rather than inferred from aggregate counts: I deleted `fast0000…fast0009` (clean teardown), deleted the slow, timing-out rules `slow0000…slow0009` while their evaluations were *in flight* (in-flight cancel), updated `fast0020` (state reset *without* a routine stop), and forced a **type change** on `fast0021` (`alerting → recording`, which forces a *restart* with state preserved). The capture's timeline markers pin each action's wall-clock time, so every signature below can be correlated to a specific UID and instant.

**(a) Delete → clean teardown, correlated on a single UID.** For the deleted rule `fast0000`, three lines fire within ~1 ms on the *same* `org_id`/`rule_uid`: the state manager resets the rule's state, reports how many states it removed, and the scheduler stops the routine:

```json
{"level":"debug","logger":"ngalert.state.manager","msg":"Resetting state of the rule","org_id":1,"rule_uid":"fast0000","t":"2026-06-26T22:43:13.005044886Z"}
{"level":"info","logger":"ngalert.state.manager","msg":"Rules state was reset","org_id":1,"rule_uid":"fast0000","states":1,"t":"2026-06-26T22:43:13.006231399Z"}
{"level":"debug","logger":"ngalert.scheduler","msg":"Stopping alert rule routine","org_id":1,"rule_uid":"fast0000","t":"2026-06-26T22:43:13.006249575Z"}
```

Crucially — and this is precisely *why an aggregate count cannot prove cleanup* — the **same** `"Resetting state of the rule"` line also appears at **creation** time for `fast0000`, ~18 s earlier, but with **no** accompanying `"Rules state was reset"` because there were zero states to remove yet:

```json
{"level":"debug","logger":"ngalert.state.manager","msg":"Resetting state of the rule","org_id":1,"rule_uid":"fast0000","t":"2026-06-26T22:42:55.006014358Z"}
```

This is structural: `DeleteStateByRuleUID` logs `"Resetting state of the rule"` *unconditionally on entry* `[pkg/services/ngalert/state/manager.go:L236-L238]`, then returns early — **without** logging `"Rules state was reset"` — when there are no states to remove `[pkg/services/ngalert/state/manager.go:L240-L242,L278]`. So the cleanup proof must be **per-UID**, not a global tally: the *delete* of `fast0000` is the line at `22:43:13` that is **paired with a routine stop**, and the `states:1` field confirms one live state was actually removed (resolved notifications are then pushed by `expireAndSend` `[pkg/services/ngalert/schedule/alert_rule.go:L355-L356]`). After this instant, `fast0000` never appears in another `"Processing tick"`/`"Tick processed"` line — the routine is genuinely gone.

**(b) Update → state reset *without* a routine stop (the reason a global count is ambiguous).** Updating `fast0020` mid-run emits `"Clearing the state of the rule because it was updated"` `[pkg/services/ngalert/schedule/alert_rule.go:L257]`, which calls `resetState → ResetStateByRuleUID → DeleteStateByRuleUID` `[pkg/services/ngalert/schedule/alert_rule.go:L259,L483-L489; pkg/services/ngalert/state/manager.go:L285-L287]` — so it **also** logs `"Resetting state of the rule"` — but there is **no** `"Stopping alert rule routine"` for `fast0020`, and its routine keeps evaluating:

```json
{"fingerprint":"2aecd1703593714a","isPaused":false,"level":"info","logger":"ngalert.scheduler","msg":"Clearing the state of the rule because it was updated","org_id":1,"rule_uid":"fast0020","t":"2026-06-26T22:43:19.00465433Z"}
{"level":"debug","logger":"ngalert.state.manager","msg":"Resetting state of the rule","org_id":1,"rule_uid":"fast0020","t":"2026-06-26T22:43:19.00466926Z"}
```

This is the concrete reason the earlier "count the resets, count the stops, compare" approach is unsound: `"Resetting state of the rule"` is emitted by **delete *and* update *and* pause** (all three route through `DeleteStateByRuleUID`), while `"Stopping alert rule routine"` is emitted by **delete *and* restart**. The two totals draw from overlapping-but-different populations, so their equality proves nothing. The reliable disambiguator is the **pairing on the same UID**: *delete* = reset **+** stop; *update* = reset **without** stop.

**(c) Restart (type change) → routine stops *without* a delete-time reset; state preserved.** Forcing `fast0021` from `alerting` to `recording` makes `processTick` observe `item.Type() != ruleRoutine.Type()` `[pkg/services/ngalert/schedule/schedule.go:L293]`, log the restart, and stop the *old* routine with the `errRuleRestarted` cause `[pkg/services/ngalert/schedule/schedule.go:L295-L296,L386-L387; pkg/services/ngalert/schedule/registry.go:L20]`:

```json
{"level":"debug","logger":"ngalert.scheduler","msg":"Rule restarted because type changed","new":"recording","old":"alerting","org_id":1,"rule_uid":"fast0021","t":"2026-06-26T22:43:24.004565903Z"}
{"level":"debug","logger":"ngalert.scheduler","msg":"Stopping alert rule routine","org_id":1,"rule_uid":"fast0021","t":"2026-06-26T22:43:24.004983486Z"}
```

The decisive contrast with delete is what is **absent**: for `fast0021` the *only* `"Resetting state of the rule"` was at creation (`22:42:55`, ~29 s earlier) — there is **no** reset at restart time (`22:43:24`), even though the routine stopped 418 µs after the restart was logged. The `errRuleDeleted` guard at `[pkg/services/ngalert/schedule/alert_rule.go:L349]` is **false** for `errRuleRestarted`, so the teardown branch is skipped and the state survives the restart. *Delete throws state away; restart keeps it* — and the runtime signature is exactly that asymmetry (reset+stop for `fast0000`, stop-only for `fast0021`).

**(d) In-flight evaluation canceled → state write skipped.** Deleting the slow rules while their (timing-out) evaluations were in flight tripped the **post-eval** cancel guard. Each of `slow0000…slow0009` logged exactly one `"Skip updating the state because the context has been cancelled"` `[pkg/services/ngalert/schedule/alert_rule.go:L393]`; e.g. `slow0003`, whose evaluation began at `now=22:43:04` and was cancelled ~12 s later at `t=22:43:16`, carrying its `version`/`fingerprint`:

```json
{"fingerprint":"0cd3fae3aee26d70","level":"debug","logger":"ngalert.scheduler","msg":"Skip updating the state because the context has been cancelled","now":"2026-06-26T22:43:04Z","org_id":1,"rule_uid":"slow0003","t":"2026-06-26T22:43:16.005097491Z","version":2}
```

The guard returns `nil` *before* `ProcessEvalResults`, so nothing partial is persisted `[pkg/services/ngalert/schedule/alert_rule.go:L391-L394]` — an interrupted evaluation leaves no half-written state.

**(e) `/metrics` corroboration (M1).** The Prometheus endpoint corroborates the same churn from the counter side. As the two delete batches landed, `grafana_alerting_schedule_alert_rules` `[pkg/services/ngalert/metrics/scheduler.go:L156]` stepped **down** in exact lock-step — `70 → 60` when `fast0000…fast0009` were removed at `22:43:13`, then `→ 50` when `slow0000…slow0009` were removed at `22:43:16` — while `rule_evaluations_total` kept climbing and the slow-datasource timeouts surfaced as rising `rule_evaluation_failures_total` and `schedule_rule_evaluations_missed_total` (the per-second scrape CSV; columns trimmed for readability):

```text
wall_iso                schedule_alert_rules  rule_evaluations_total  rule_evaluation_failures_total  schedule_rule_evaluations_missed_total
2026-06-26T22:43:12Z    70                    100                     0                               0
2026-06-26T22:43:13Z    60                    100                     0                               0   <- DELETE fast0000..fast0009
2026-06-26T22:43:15Z    60                    100                     0                               0
2026-06-26T22:43:16Z    50                    100                     0                               0   <- DELETE slow0000..slow0009 (mid-eval)
2026-06-26T22:44:08Z    50                    219                     4                               120
```

Interpretation: the gauge **falling** in lock-step with the delete markers is the metric-side proof that removed rules are *fully unregistered* — not merely paused, and not leaked (a leaked routine would keep the gauge flat and keep emitting ticks for the dead UID, which we do not observe). The `failures`/`missed` counters rising afterward confirm the timed-out and canceled evaluations are **accounted for** in the meta-metrics rather than silently disappearing. (The headline backpressure gauge `scheduler_behind_seconds` stayed near zero in this 70-rule churn run because the load here is the *churn*, not raw rule count; the tens-of-seconds backlog is the separate 760-rule run in [§2.2](#22-live-evidence-stressed-run).)

### 3.3 Rationale — why this answers Q2

- **"Does anything get left behind?"** For a **delete**, no — and the proof is **per-UID**, not a global tally. For `fast0000`, the *same* `org_id`/`rule_uid` shows `"Resetting state of the rule"` **+** `"Rules state was reset" states:1` **+** `"Stopping alert rule routine"` within ~1 ms `[pkg/services/ngalert/state/manager.go:L236-L238,L278; pkg/services/ngalert/schedule/alert_rule.go:L355-L358]`, the `states:1` field confirms a live state was actually removed, resolved notifications are pushed via `expireAndSend` `[pkg/services/ngalert/schedule/alert_rule.go:L356]`, and `fast0000` never appears in a later tick. *(The earlier draft's aggregate "182 == 182" equality is **not** a valid proof: `"Resetting state of the rule"` also fires for **updates/pauses** via `ResetStateByRuleUID` `[pkg/services/ngalert/state/manager.go:L285-L287]` — shown live by `fast0020` — and even at **creation** with zero states, while `"Stopping alert rule routine"` also fires for **restarts**; the two totals draw from overlapping-but-different populations, so their equality is coincidental, not causal.)* For a **canceled in-flight evaluation**, also no: the post-eval guard returns before any state write `[pkg/services/ngalert/schedule/alert_rule.go:L391-L394]`, so nothing partial is persisted — confirmed by the per-UID `"Skip updating the state because the context has been cancelled"` line for each of `slow0000…slow0009`, each carrying `org_id`/`rule_uid`/`version`/`fingerprint`.
- **"…or does the system cleanly move on?"** Yes, and the *cause* determines the cleanup policy: `errRuleDeleted` triggers teardown (reset **+** stop, seen for `fast0000`), while `errRuleRestarted` deliberately **preserves** state (stop **without** a delete-time reset, seen for `fast0021`) `[pkg/services/ngalert/schedule/registry.go:L19-L20]`, `[pkg/services/ngalert/schedule/alert_rule.go:L349]`. That is the design distinction between "the rule is gone" and "the rule is being re-created." The metric side agrees: `grafana_alerting_schedule_alert_rules` steps down `70 → 60 → 50` exactly as the two delete batches land, so removed rules are fully unregistered rather than leaked.
- **"What signs at runtime tell you which one happened?"** Distinct, UID-correlated signatures, all carrying the `org_id` and `rule_uid` identifiers:
  1. **Delete** → `ngalert.state.manager` `"Resetting state of the rule"` (+ `"Rules state was reset"` when state existed) **paired on the same UID with** `ngalert.scheduler` `"Stopping alert rule routine"`, and the rule vanishes from later ticks (`fast0000`).
  2. **Update/pause** → `"Clearing the state of the rule because it was updated"` + `"Resetting state of the rule"` **without** any `"Stopping alert rule routine"`; the routine keeps evaluating (`fast0020`).
  3. **Restart (type change)** → `"Rule restarted because type changed"` + `"Stopping alert rule routine"`, but **no** `"Resetting state of the rule"` for that UID at restart time — state survives (`fast0021`).
  4. **In-flight cancel** → `"Skip updating the state because the context has been cancelled"` (post-eval) or `"Skip evaluation and updating the state because the context has been cancelled"` (pre-eval), with **no** state change recorded (`slow0000…slow0009`).


---

## 4. Q3 — Ordering

> *"During that same window, do evaluation results ever appear out of order, and if they do not, what observable behavior suggests the ordering was preserved?"*

### 4.1 What the code does

For a given rule, results **cannot** appear out of order, and this is a *structural* guarantee, not a best-effort one. The reason is the shape of the per-rule pipeline:

1. **One unbuffered channel per rule** — `evalCh: make(chan *Evaluation)` `[pkg/services/ngalert/schedule/alert_rule.go:L161]`. An unbuffered channel has no slots: a send cannot complete until a receive is ready.
2. **Exactly one consumer goroutine per rule** — `func (a *alertRule) Run() error` `[pkg/services/ngalert/schedule/alert_rule.go:L242]` is the rule's single evaluation loop, and it reads sequentially:

   ```go
   // pkg/services/ngalert/schedule/alert_rule.go  (Run)
   case ctx, ok := <-a.evalCh:    // L262  — the one and only consumer
   ```

Because there is a **single** consumer and the channel is **unbuffered**, the producer side in `Eval()` blocks on `a.evalCh <- eval` `[pkg/services/ngalert/schedule/alert_rule.go:L209-L214]` until that one consumer is ready to take the item. A rule therefore can **never** have two evaluations in flight at once: tick *N+1* cannot be handed to the consumer until the consumer has finished accepting (and is processing) tick *N*. Sequential consumption ⇒ results are produced in the same order the ticks were issued.

The newest-wins drain discussed in [§2.1](#21-what-the-code-does) does not undermine this: when the consumer is busy, a superseded evaluation is **dropped** (drained at `[pkg/services/ngalert/schedule/alert_rule.go:L204-L207]`), never **reordered**. So the only two possibilities for a rule are "evaluated in order" or "an intermediate tick was dropped" — and a dropped tick is itself reported by the missed counter ([§2](#2-q1--work-selection-under-backpressure)). There is no code path that lets an *older* result overtake a *newer* one for the same rule.

(Across *different* rules the dispatch is concurrent — each rule runs in its own goroutine via `time.AfterFunc` `[pkg/services/ngalert/schedule/schedule.go:L370]` — so inter-rule completion order is not guaranteed and is not expected to be. The ordering guarantee is *per rule*, which is what matters for a rule's own state transitions.)

### 4.2 Live evidence (stressed run)

The observable proof is the **ordered pair** of log lines the single consumer emits for *each* evaluation: `"Processing tick"` when it picks the evaluation up `[pkg/services/ngalert/schedule/alert_rule.go:L269]` and `"Tick processed"` when it finishes `[pkg/services/ngalert/schedule/alert_rule.go:L332]`. Both are stamped, by the same per-evaluation logger `[pkg/services/ngalert/schedule/alert_rule.go:L268]`, with the evaluation's `now` (scheduled tick time), `version`, and `fingerprint`. Here is the slow, timing-out rule `slow0015` during the stressed window, read top-to-bottom in log order:

```json
{"fingerprint":"9d471f93fcf206b6","level":"debug","logger":"ngalert.scheduler","msg":"Processing tick","now":"2026-06-26T22:43:04Z","org_id":1,"rule_uid":"slow0015","t":"2026-06-26T22:43:04.377384509Z","version":2}
{"attempt":3,"duration":"1m32.00589391s","fingerprint":"9d471f93fcf206b6","level":"debug","logger":"ngalert.scheduler","msg":"Tick processed","now":"2026-06-26T22:43:04Z","org_id":1,"rule_uid":"slow0015","t":"2026-06-26T22:44:36.38331178Z","version":2}
{"fingerprint":"9d471f93fcf206b6","level":"debug","logger":"ngalert.scheduler","msg":"Processing tick","now":"2026-06-26T22:44:34Z","org_id":1,"rule_uid":"slow0015","t":"2026-06-26T22:44:36.383326037Z","version":2}
{"attempt":3,"duration":"1m32.006717979s","fingerprint":"9d471f93fcf206b6","level":"debug","logger":"ngalert.scheduler","msg":"Tick processed","now":"2026-06-26T22:44:34Z","org_id":1,"rule_uid":"slow0015","t":"2026-06-26T22:46:08.390053766Z","version":2}
{"fingerprint":"9d471f93fcf206b6","level":"debug","logger":"ngalert.scheduler","msg":"Processing tick","now":"2026-06-26T22:46:04Z","org_id":1,"rule_uid":"slow0015","t":"2026-06-26T22:46:08.390069487Z","version":2}
{"attempt":3,"duration":"1m32.016401955s","fingerprint":"9d471f93fcf206b6","level":"debug","logger":"ngalert.scheduler","msg":"Tick processed","now":"2026-06-26T22:46:04Z","org_id":1,"rule_uid":"slow0015","t":"2026-06-26T22:47:40.406488859Z","version":2}
```

Three independent observations confirm ordering held even though each evaluation took **92 s** (`attempt:3`, datasource timing out):

- **`Processing tick` and `Tick processed` strictly alternate, and `now` is monotonic** — `:43:04 → :44:34 → :46:04`, each pair fully bracketed before the next begins. There is never a second `Processing tick` before the prior `Tick processed`, so two evaluations of `slow0015` are never in flight at once. (The `now` advances by ~90 s rather than the 10 s interval because, while the consumer was busy for 92 s, the newest-wins drain discarded the intervening ticks — they are *dropped and counted as missed* per [§2](#2-q1--work-selection-under-backpressure), never reordered; the surviving `now` values are still strictly increasing.)
- **The single consumer is visible in the timestamps:** each `Processing tick`'s wall-clock `t` equals the *previous* `Tick processed`'s `t` to the microsecond — e.g. `now=:43:04` finished at `t=22:44:36.383311`, then `now=:44:34` was picked up at `t=22:44:36.383326`, just **15 µs** later. The consumer literally cannot start tick *N+1* until it has finished tick *N*, which is the structural guarantee of [§4.1](#41-what-the-code-does) made observable.
- **`fingerprint` is stable and `version` is constant** — `fingerprint:"9d471f93fcf206b6"` and `version:2` on every line, because the rule definition did not change during this window. The stable fingerprint ties every line to the *same* rule definition, so the monotonic `now` is a like-for-like ordering of that definition's evaluations. (Either field changes only when the rule is *edited* — a changed fingerprint is the "this is a different definition" signal, not a reordering.)

**`/metrics` corroboration (M1).** The Prometheus side shows the same forward-only progress aligned to the window above. The ticker's consumed-tick marker advances by exactly one interval per scrape and **never rewinds or skips**, and the evaluation counter is monotonically non-decreasing (per-second scrape CSV, columns trimmed):

```text
wall_iso                ticker_last_consumed_tick_timestamp_seconds  rule_evaluations_total
2026-06-26T22:43:04Z    1.782513784e+09                              46
2026-06-26T22:43:05Z    1.782513785e+09                              70
2026-06-26T22:43:06Z    1.782513786e+09                              70
2026-06-26T22:43:07Z    1.782513787e+09                              82
2026-06-26T22:43:08Z    1.782513788e+09                              100
```

`ticker_last_consumed_tick_timestamp_seconds` `[pkg/util/ticker/metrics.go:L16-L19]` increments by exactly `1e9` ns (the 1 s interval) each row — the ticker's `last` marker only ever advances forward by one interval as each tick is consumed `[pkg/util/ticker/ticker.go:L64]` — and `grafana_alerting_rule_evaluations_total` `[pkg/services/ngalert/metrics/scheduler.go:L52]` only ever rises. A counter that never decreases and a tick marker that never rewinds are the metric-level shadow of the per-rule in-order consumption: there is no observable signal of an evaluation being processed "behind" an already-processed later one.

### 4.3 Rationale — why this answers Q3

- **"Do evaluation results ever appear out of order?"** No — not for a given rule. The single-consumer-on-an-unbuffered-channel structure `[pkg/services/ngalert/schedule/alert_rule.go:L161,L242,L262]` makes concurrent evaluation of the same rule impossible, so its results are emitted strictly in scheduled order.
- **"What observable behavior suggests the ordering was preserved?"** The **monotonically advancing `now`/scheduled-at timestamps** in a rule's own log stream — shown above advancing `:43:04→:44:34→:46:04` *even while* each `duration` was **92 s** with `attempt:3` and the wall-clock `t` fell ~92 s behind. If results could overtake one another, you would see a smaller `now` logged after a larger `now` for the same `rule_uid`; that never occurs. The corroborating identifier is the **stable per-rule `fingerprint`** (`9d471f93fcf206b6` on every `slow0015` line): it confirms all those lines belong to the *same* rule definition, so the `now` ordering is a like-for-like sequence. The `version` field stays **constant** (`2`) for the same reason — it is *not* an increasing sequence number; it changes only when the rule is edited, which is a different event from reordering. On the metric side this is mirrored by `rule_evaluations_total` only ever rising and the ticker's consumed-tick marker only ever advancing. The newest-wins drain means a skipped tick is *dropped and counted* ([§2](#2-q1--work-selection-under-backpressure)), never reordered.
- **Timing/rhythm note (meta-requirement):** the widening gap between `now` and `t`, plus the jump to `attempt:3` and the **92 s** `duration`s, is the visible "rhythm change" of Q3's "same window" — the cadence stretches and stalls under load (and, after the datasource recovers, snaps back to `attempt:1` ~200 ms evaluations 10 s apart, see [§5.3](#53-recovery-demonstration)), but the ordering invariant holds throughout.


---

## 5. Stressed vs. normal comparison

The same scenario was repeated under **normal load** in two parts: a **timing/volume baseline** (3 rules at the default 60s interval, default 10s tick, healthy fast TestData) and a **churn repeat** that re-ran the *same* create/update/delete/type-change script at normal load (24 rules @60s, healthy fast DS) so the Q2 cleanup/cancel and Q3 ordering paths can be compared directly against the stressed run. Below are the real captured signals from the baseline (§5.1), the throughput delta (§5.2), recovery (§5.3), the visible changes (§5.4), and the normal-load churn comparison (§5.5).

### 5.1 Normal run — captured signals

**`/metrics` snapshot (normal):**

```text
=== NORMAL baseline /metrics snapshot (3 rules @60s, default 10s tick, healthy TestData) ===
grafana_alerting_rule_evaluation_duration_seconds_sum{org="1"} 0.016792121000000004
grafana_alerting_rule_evaluation_duration_seconds_count{org="1"} 13
grafana_alerting_rule_evaluation_failures_total{org="1"} 0
grafana_alerting_rule_evaluations_total{org="1"} 13
grafana_alerting_schedule_alert_rules 3
grafana_alerting_scheduler_behind_seconds 3.4506e-05
grafana_alerting_ticker_interval_seconds 10
grafana_alerting_ticker_last_consumed_tick_timestamp_seconds 1.78251043e+09
grafana_alerting_ticker_next_tick_timestamp_seconds 1.78251044e+09
```

**`behind_seconds` over 200s of baseline:**

```text
behind_seconds over 200s: min=0.0002 max=0.0011 mean=0.0006 (essentially zero)
missed_total delta over 200s: 0
ticker last_consumed vs next_tick gap: exactly 10.0s
```

**Per-rule cadence for `norm0000` (exact 60s spacing, single attempt, sub-millisecond-to-few-ms durations):**

```json
{"attempt":1,"duration":"3.476838ms","msg":"Tick processed","now":"2026-06-26T21:43:10Z","org_id":1,"rule_uid":"norm0000","t":"2026-06-26T21:43:10.004667832Z","version":1}
{"attempt":1,"duration":"1.067518ms","msg":"Tick processed","now":"2026-06-26T21:44:10Z","org_id":1,"rule_uid":"norm0000","t":"2026-06-26T21:44:10.004888021Z","version":1}
{"attempt":1,"duration":"1.151266ms","msg":"Tick processed","now":"2026-06-26T21:45:10Z","org_id":1,"rule_uid":"norm0000","t":"2026-06-26T21:45:10.002156049Z","version":1}
{"attempt":1,"duration":"1.097948ms","msg":"Tick processed","now":"2026-06-26T21:46:10Z","org_id":1,"rule_uid":"norm0000","t":"2026-06-26T21:46:10.001706916Z","version":1}
```

Notice the **same ordering invariant from Q3 holds here too**, but cleanly: `now` advances by exactly 60s and the wall-clock `t` tracks `now` to within a few milliseconds — there is no lag because there is no backpressure.

### 5.2 Side-by-side delta

| Signal | **Stressed** (760 rules, slow DS, 1s tick) | **Normal** (3 rules @60s, healthy DS, 10s tick) |
|---|---|---|
| `grafana_alerting_scheduler_behind_seconds` | peak ~**64.5s** (snapshot 46.97s) | mean **0.0006s**, max 0.0011s |
| `…schedule_rule_evaluations_missed_total` | `0 → 927` | **0** (flat) |
| WARN `"Tick dropped…too slow"` | **1158×** | **0** |
| `…rule_evaluation_failures_total` | `0 → 174` | **0** |
| per-evaluation `duration` | up to **30.01s** (datasource timeout) → also 10–18s with retries | **1–3.5 ms** |
| per-rule cadence | bunched, stalled, `attempt:3` retries | exact **60s**, always `attempt:1` |
| ticker `next − last_consumed` gap (= tick interval by construction `[pkg/util/ticker/ticker.go:L54-L65]`; **not** a backlog signal) | exactly **1.0s** (1s tick) | exactly **10.0s** (10s tick) |
| `last_consumed` timestamp vs **wall-clock now** (the true backlog, mirrors `scheduler_behind_seconds`) | lags by tens of seconds (peak ~**64.5s**) | ≤ one interval (**≈0s**) |
| `…rule_evaluations_total` growth | `1459 → 14922` | **13** over ~4 min |
| `…schedule_periodic_duration_seconds` (mean tick) | ~**1.16s**/tick (heavy tail >10s) | sub-tick (single-digit ms class) |

### 5.3 Recovery demonstration

To show the signals are *reversible* (not a one-way ratchet), I flipped the slow data source back to fast mid-run. The slow rules, which had been timing out at 30s, immediately returned to fast, successful evaluations on `attempt:1`:

```json
{"attempt":1,"duration":"501.375392ms","msg":"Tick processed","now":"2026-06-26T21:36:06Z","org_id":1,"rule_uid":"slow0005","t":"2026-06-26T21:36:07.243382073Z","version":2}
{"attempt":1,"duration":"501.203438ms","msg":"Tick processed","now":"2026-06-26T21:36:06Z","org_id":1,"rule_uid":"slow0006","t":"2026-06-26T21:36:07.243…Z","version":2}
{"attempt":1,"duration":"501.372248ms","msg":"Tick processed","now":"2026-06-26T21:36:06Z","org_id":1,"rule_uid":"slow0007","t":"2026-06-26T21:36:07.243…Z","version":2}
```

The `duration` dropped from ~30s to ~501ms, the `attempt` fell back to `1`, and — consistent with [§2.1](#21-what-the-code-does) — `behind_seconds` decays back toward zero once per-tick processing is again faster than the tick interval. This matches the gauge's documented floor-at-zero, decreasing behavior (see [Appendix A](#appendix-a--web-corroboration-subordinate-to-code)).

### 5.4 What visibly changes

- **Volume:** evaluation throughput in the stressed run is far higher and *failing* (14922 evals, 174 failures, 927 missed) versus a trickle of clean successes in the normal run (13 evals, 0 failures, 0 missed).
- **Timing:** the stressed run shows tens of seconds of `behind_seconds` — i.e. the consumed-tick timestamp lagging **wall-clock now**, while the `next − last_consumed` ticker gap stays pinned at the 1s interval — plus ballooning per-eval durations, retries to `attempt:3`, and an irregular, stalling rhythm. The normal run is metronomic: `behind_seconds`≈0, `next − last_consumed` ticker gap exactly equal to the 10s interval, single-attempt evaluations a few ms long, and `now`/`t` essentially coincident.
- **Churn (cleanup / cancel / order):** the delete-teardown and type-change-restart signatures are **identical in kind** under both loads (delete = reset + stop; restart = stop, no reset), and the `schedule_alert_rules` gauge steps down on every delete in both (24 → 14 normal, 70 → 60 → 50 stressed). The one behavior that *visibly* changes is **in-flight cancellation**: the stressed run produced **10** `"Skip updating the state…"` lines (slow evaluations caught mid-flight by a delete) while the normal run produced **0** — under a healthy data source evaluations finish in milliseconds, so a delete essentially never lands while one is running. Cancellation is therefore a *symptom of backpressure*, not of deletion itself. Detailed side-by-side churn evidence is in [§5.5](#55-normal-load-churn--the-same-scenario-repeated).

### 5.5 Normal-load churn — the same scenario, repeated

To compare the **cleanup, cancellation, and ordering** behavior (not just throughput) under normal load, I re-ran the *same* churn script — bulk-create, then delete `fast0000…fast0009`, update `fast0020`, and type-change `fast0021` (`alerting → recording`) — against a **healthy fast** TestData source with **24 rules @60s** and the default **10s** tick.

**Delete → clean teardown, same signature as stress.** `fast0000` shows the state-manager reset paired with the routine stop on the same UID, ~24 µs apart:

```json
{"level":"debug","logger":"ngalert.state.manager","msg":"Resetting state of the rule","org_id":1,"rule_uid":"fast0000","t":"2026-06-26T22:49:40.002976587Z"}
{"level":"debug","logger":"ngalert.scheduler","msg":"Stopping alert rule routine","org_id":1,"rule_uid":"fast0000","t":"2026-06-26T22:49:40.003000241Z"}
```

The one *visible* difference from the stressed delete is the **absence of `"Rules state was reset"`**: at the 60 s interval, `fast0000` had not yet completed an evaluation when it was deleted ~13 s after creation, so there were **zero** cached states to remove — recall `DeleteStateByRuleUID` logs `"Resetting state of the rule"` unconditionally but only logs `"Rules state was reset"` when `len(states) > 0` `[pkg/services/ngalert/state/manager.go:L240-L242,L278]`. Same teardown path; there was simply less accumulated state to clean.

**Restart (type change) → same state-preserving signature.** `fast0021` produces the identical restart pair as the stressed run — the restart is logged and the old routine is stopped with `errRuleRestarted`, with **no** `"Resetting state of the rule"` at restart time:

```json
{"level":"debug","logger":"ngalert.scheduler","msg":"Rule restarted because type changed","new":"recording","old":"alerting","org_id":1,"rule_uid":"fast0021","t":"2026-06-26T22:50:00.002619754Z"}
{"level":"debug","logger":"ngalert.scheduler","msg":"Stopping alert rule routine","org_id":1,"rule_uid":"fast0021","t":"2026-06-26T22:50:00.00268299Z"}
```

**In-flight cancellation → the headline delta: it essentially does not happen under normal load.** Under stress, deleting the slow rules caught 10 evaluations mid-flight and produced 10 `"Skip updating the state…"` lines. Under normal load, with a healthy data source every evaluation finishes in a few milliseconds, so a delete almost never lands while an evaluation is running — the entire normal run produced **zero** cancel lines of either kind:

```text
Skip updating the state because the context has been cancelled:                 0   (stressed: 10)
Skip evaluation and updating the state because the context has been cancelled:   0   (stressed: present)
```

There is nothing in flight to cancel: cancellation is a *consequence of backpressure*, not of deletion per se.

**Ordering still holds, cleanly.** `fast0015` advances by exactly 60 s with no inversions — the same Q3 invariant as the stressed run, but without the 92 s stalls (stable `fingerprint`, constant `version`, `attempt:1`, single-digit-ms durations):

```json
{"fingerprint":"a70a2ac5ec3f4f19","level":"debug","logger":"ngalert.scheduler","msg":"Processing tick","now":"2026-06-26T22:49:50Z","org_id":1,"rule_uid":"fast0015","t":"2026-06-26T22:49:53.573646138Z","version":2}
{"attempt":1,"duration":"4.706774ms","fingerprint":"a70a2ac5ec3f4f19","level":"debug","logger":"ngalert.scheduler","msg":"Tick processed","now":"2026-06-26T22:49:50Z","org_id":1,"rule_uid":"fast0015","t":"2026-06-26T22:49:53.578445027Z","version":2}
{"fingerprint":"a70a2ac5ec3f4f19","level":"debug","logger":"ngalert.scheduler","msg":"Processing tick","now":"2026-06-26T22:50:50Z","org_id":1,"rule_uid":"fast0015","t":"2026-06-26T22:50:53.573847147Z","version":2}
{"attempt":1,"duration":"44.945653ms","fingerprint":"a70a2ac5ec3f4f19","level":"debug","logger":"ngalert.scheduler","msg":"Tick processed","now":"2026-06-26T22:50:50Z","org_id":1,"rule_uid":"fast0015","t":"2026-06-26T22:50:53.618861289Z","version":2}
```

**Churn-signal delta (stressed-churn vs normal-churn):**

| Q2/Q3 signal | **Stressed churn** (70 rules @10s, slow DS, 1s tick) | **Normal churn** (24 rules @60s, healthy DS, 10s tick) |
|---|---|---|
| Delete teardown (`Resetting state` + `Stopping routine`, same UID) | present (`fast0000`, + `Rules state was reset` `states:1`) | present (`fast0000`, no states to reset yet) |
| Restart on type change (`Rule restarted` + stop, no reset) | present (`fast0021`) | present (`fast0021`) |
| In-flight cancels (`Skip updating the state…`) | **10** (slow rules caught mid-eval) | **0** (evaluations finish in ms) |
| `grafana_alerting_schedule_alert_rules` on delete | `70 → 60 → 50` | `24 → 14` |
| `…rule_evaluation_failures_total` | `0 → 4` | **0** |
| `…schedule_rule_evaluations_missed_total` | `0 → 120` | **0** |
| WARN `"Tick dropped…too slow"` | many (`120` in the capture window) | **0** |
| Per-rule ordering (`now` monotonic) | holds (with 92 s stalls) | holds (clean 60 s cadence) |

**What this shows.** The *cleanup* and *ordering* behaviors are **identical in kind** under both loads — delete tears down, restart preserves state, ordering holds — exactly as the code predicts, because those paths do not depend on load. What load changes is *how often the cancellation path is exercised at all*: in-flight cancellation is a side-effect of an evaluation outliving the moment its rule is deleted, which only happens when evaluations are slow. Under normal load that window is microscopic, so cancellation effectively disappears while teardown and ordering look the same — just faster and without stalls.

---

## 6. Reproduction / observation method

All of the following ran **outside** the repository tree (under `/tmp`); the repository itself was never modified.

### 6.1 Build and run

```bash
# Build the REAL server (the build-server make target produces only a thin shim;
# build ./pkg/cmd/grafana for the actual binary). Requires Go 1.23.1 [go.mod:L3].
go build -o ./bin/linux-amd64/grafana ./pkg/cmd/grafana

# Explicit paths used for these runs. All config/data/log/provisioning dirs live
# OUTSIDE the repository tree (under /tmp/blitzy_obs); the repo is only the homepath.
REPO=/tmp/blitzy/grafana/blitzy-fd396a32-9746-4b6c-babd-1717a5987128_95dd04  # repository root (your checkout path)
SCENARIO=stress                              # one of: stress | normal
CONFIG=/tmp/blitzy_obs/${SCENARIO}/grafana.ini  # e.g. /tmp/blitzy_obs/stress/grafana.ini or /tmp/blitzy_obs/normal/grafana.ini

# Run with the out-of-repo config, repo as homepath.
# Unified Alerting is on by default [conf/defaults.ini:L1220-L1222].
./bin/linux-amd64/grafana server --config="${CONFIG}" --homepath="${REPO}"
```

Key out-of-repo config knobs used (in the temporary `.ini` files, never in `conf/defaults.ini`):

- `[metrics] enabled = true` so `/metrics` is served `[pkg/api/http_server.go:L661]` (it is on by default, but set explicitly for clarity).
- `[log] mode = console`, `level = debug` (and `console` formatted as JSON) so `org_id`/`rule_uid`/`now`/`version`/`fingerprint` fields are machine-greppable on the `ngalert.scheduler`, `ngalert.state.manager`, and `ticker` loggers.
- For the stressed run only: the `configurableSchedulerTick` feature toggle plus a `1s` tick `[pkg/setting/setting_unified_alerting.go:L335-L336]` to accelerate the effect. The normal run used the default `10s` tick.

Confirm the endpoint and the alerting series:

```bash
curl -s http://127.0.0.1:3000/metrics | grep -E 'grafana_alerting_|_ticker_' | head
```

### 6.2 Provisioning (temporary, out-of-repo)

- **Data sources:** a `SlowProm` Prometheus-type datasource pointing at a tiny local Python HTTP server (`127.0.0.1:9099`) that answers `buildinfo`/`health` fast but **sleeps** on `/api/v1/query` longer than the 30s eval timeout, plus a healthy `FastTestData` (grafana-testdata) datasource for the normal run and recovery.
- **Alert rules:** generated via the provisioning API/files — 60 "slow" rules (pointing at `SlowProm`) and up to 700 "fast" rules at the 10s minimum interval `[conf/defaults.ini:L1346]` for the stressed run; 3 rules at the 60s default interval `[pkg/setting/setting_unified_alerting.go:L64]` for the normal run.
- **Churn:** a small driver issued create/update/**delete** calls in a tight loop during the stressed window so the deletion-cleanup and in-flight-cancellation paths fired.

### 6.3 Capture

- **Logs:** the server's stdout/stderr (JSON) was tee'd to a timestamped file and filtered by `logger` and `msg`.
- **Metrics:** a scraper polled `/metrics` every 0.5–2s and appended timestamped samples for the `grafana_alerting_*` and `*_ticker_*` series to CSV, from which the deltas in [§5](#5-stressed-vs-normal-comparison) were computed.

### 6.4 Mapping of the runtime path

```mermaid
flowchart TD
    A["ticker.T: emits tick on unbuffered C; queues, never drops<br/>[ticker.go:L12-16, L64]"] --> B["processTick: set scheduler_behind_seconds = now - tick<br/>BEFORE any dispatch [schedule.go:L214-215]"]
    B --> C["select ready rules: (tickNum%freq)-offset==0 [schedule.go:L316]<br/>sort by UID [L364-366]; spread via time.AfterFunc [L370]"]
    C -->|per ready rule| D["Eval(): newest-wins drain of evalCh [alert_rule.go:L204-207]<br/>send on UNBUFFERED evalCh [L161, L209-214]"]
    D -->|older eval dropped| E["WARN 'Tick dropped…too slow' [schedule.go:L378]<br/>+ schedule_rule_evaluations_missed_total [L379-380]"]
    D --> F["Run(): SINGLE consumer goroutine reads evalCh [alert_rule.go:L242,L262]"]
    F -->|datasource timeout 30s| G["NewResultFromError -> State=Error [eval.go:L265-267]"]
    F -->|ctx cancelled post-eval| H["Skip state write; return nil [alert_rule.go:L391-394]"]
    C -->|rule removed| J["deleteAlertRule -> Stop(errRuleDeleted) [schedule.go:L183,L198]"]
    J --> K["DeleteStateByRuleUID + expireAndSend + 'Stopping alert rule routine'<br/>[alert_rule.go:L347-358]"]
```

---

## Appendix A — Web corroboration (subordinate to code)

The code is the authority; the following official Grafana documentation only *corroborates* the code-derived interpretation.

- **`scheduler_behind_seconds` semantics.** Grafana's [Meta monitoring documentation][meta-monitoring] describes it as "a gauge that shows you the number of seconds that the scheduler is behind", which (per the same page) increases when `schedule_periodic_duration_seconds` exceeds 10 seconds and decreases otherwise, with a smallest value of 0. This matches the code at `[pkg/services/ngalert/schedule/schedule.go:L214-L215]` and the live behavior in [§2.2](#22-live-evidence-stressed-run) and the recovery demo in [§5.3](#53-recovery-demonstration).
- **Tick accumulation.** The same [Meta monitoring documentation][meta-monitoring] notes that when the scheduler takes longer than its tick interval to process a tick, "pending evaluations start to accumulate", corroborating the queue-don't-drop ticker `[pkg/util/ticker/ticker.go:L12-L16]` and the rising-gauge / lagging-consumed-tick signature rather than skipped ticks.
- **`/metrics` exposure.** The docs confirm metrics are exposed at the `/metrics` endpoint and that `[metrics] enabled = true` controls it, matching the gating at `[pkg/api/http_server.go:L661]`.
- **Data-source error → Error instance.** Official docs describe a timing-out/erroring data source producing a `DatasourceError` alert instance, corroborating the `Error`-state result path `[pkg/services/ngalert/eval/eval.go:L265-L267]` observed in [§2.2](#22-live-evidence-stressed-run).

[meta-monitoring]: https://grafana.com/docs/grafana/latest/alerting/set-up/meta-monitoring/

---

## Appendix B — Cleanup and repository integrity

Per the task rules, **the source repository was not modified** and **no temporary code was committed**. After capturing all evidence:

- The Grafana process and all helper processes (slow HTTP server, scrapers, churn driver) were stopped.
- Every temporary artifact under `/tmp/blitzy_obs` (the `.ini` configs, the Python helper scripts, the provisioning directories, the SQLite data dirs, and the captured logs/metrics/excerpts) was removed.
- `git status` was used to confirm that the **only** change in the repository is the addition of this document, `blitzy/documentation/grafana_4550cfb5b728.md`.

All code citations in this document correspond to the pinned revision **`4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`** (branch `grafana_4550cfb5b728`) and were verified line-exact against the on-disk source tree; they should not be assumed to hold at other revisions.
