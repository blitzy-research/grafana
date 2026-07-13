# Grafana Unified Alerting under stress vs. normal load — a runtime investigation

**Subject:** the Grafana Unified Alerting *scheduler* (`pkg/services/ngalert/schedule`), its per‑rule evaluation routine, and the *state manager* (`pkg/services/ngalert/state`).
**Commit under test:** `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` (branch `grafana_4550cfb5b728`).
**Nature of this document:** every behavioral claim below was produced by **building and running the real code and capturing real output** (structured logs + the Prometheus `/metrics` endpoint), and only then written down. Claims are tagged **`[OBSERVED]`** (captured at runtime) or **`[INFERRED]`** (read from source and labeled as such). Exact source locations are cited as `file:line`.

> This investigation is strictly **read‑only** against the repository. The only persistent artifact it produces is this document. Every temporary script/harness lived outside the tree (under `/tmp`) or was an ephemeral in‑package test that was deleted afterwards; the repository is byte‑for‑byte unchanged otherwise (see §10).

---

## 1. Scope, method, and how the questions map to code

### 1.1 The questions (answered by name in §3–§8)

- **Q1 — Prioritization under backpressure.** When many rule changes arrive *while evaluations are already falling behind* *and* a data source begins to time out, how does the scheduler decide what to evaluate next, and **where does that choice first become visible at runtime?** → §3.
- **Q2 — Cancellation vs. deletion (vs. restart) cleanup.** If an in‑flight evaluation is *canceled*, or a rule is *removed* partway through, is anything left behind (leaked goroutine, stale in‑memory state, undeleted DB instance, orphaned metric), or does the system cleanly move on — and **what runtime signs distinguish each case?** → §4.
- **Q3 — Result ordering.** During the stressed window, do a rule’s evaluation results ever appear **out of order**? If not, what observable behavior proves ordering was preserved? → §5.
- **Q4 — Live evidence + rationale.** Every claim is exercised live, backed by complete unedited output, with an explanation of *why* the evidence supports it. → throughout, plus the appendix §6.
- **Q5 — Signal attention.** Log messages, Prometheus counters/gauges, identifiers (**rule UID, org ID, rule title/key**), and timing/rhythm patterns (pauses, recovery). → §8.
- **Q6 — Normal‑load comparison.** The identical scenario repeated against a fast/healthy data source, describing what visibly changes in timing and volume. → §7.
- **Q7 — Repository integrity.** Temporary scripts permitted but removed; the repository unchanged. → §10.

### 1.2 Two complementary, canonical observation approaches

Both approaches exercise the **real** scheduler/rule‑routine/state‑manager code — no debug hooks, fallbacks, or synthetic stand‑ins for the subject under observation.

- **Approach A — the canonical `grafana‑server`.** The real production binary is run under the default unified‑alerting configuration through the real entry point `pkg/services/ngalert/ngalert.go`: `schedule.NewScheduler(...)` [pkg/services/ngalert/ngalert.go:424] → `ng.schedule = scheduler` [pkg/services/ngalert/ngalert.go:432] → `ng.schedule.Run(subCtx)` [pkg/services/ngalert/ngalert.go:558]. Thirty Grafana‑managed rules in one 10‑second group are pointed first at a **slow/timing‑out** data source (stressed) and then at a **fast/healthy** one (normal). Evidence is scraped from the live `/metrics` endpoint and the structured server log. This proves the metric/log surfaces exist in production form and yields authentic timing values.
- **Approach B — a deterministic in‑package harness.** A temporary Go test (`pkg/services/ngalert/schedule/blitzy_adhoc_probe_test.go`, created for the investigation and **deleted afterwards** — see §10) modeled on the repository’s own `TestProcessTicks` [pkg/services/ngalert/schedule/schedule_unit_test.go:40] and `setupScheduler` [pkg/services/ngalert/schedule/schedule_unit_test.go:938]. It constructs the **real** `schedule` via `NewScheduler` [pkg/services/ngalert/schedule/schedule.go:125], a **real** `state.Manager`, a `fakeRulesStore` [pkg/services/ngalert/schedule/testing.go:44], a real `prometheus.Registry`, and a deliberately slow/erroring/alerting evaluator, then drives `processTick` over a `benbjohnson/clock` mock clock, tick by tick. The rules‑store and clock are test doubles for the *inputs*; the code being *observed* (dispatch, the `Eval` mailbox, the stop/cleanup branches, the state manager) is the real, unmodified scheduler code, and its log/metric surfaces match Approach A exactly.

To make the harness’s per‑rule log lines carry `rule_uid`/`org_id` exactly as a running server does, the harness registered the **same** contextual log provider the production entry point registers — `log.RegisterContextualLogProvider(...)` at [pkg/services/ngalert/ngalert.go:506], which pulls the rule key from context via `models.RuleKeyFromContext` and emits `key.LogContext()` = `{"rule_uid", k.UID, "org_id", k.OrgID}` [pkg/services/ngalert/models/alert_rule.go:460-462].

### 1.3 Why these two approaches together are sufficient

Approach A answers “does this happen in the real server, and what do the real numbers look like?”. Approach B answers “can each condition be triggered precisely, repeatably, and in isolation, with before/during/after state captured?”. The **same** log strings (`"Tick dropped because alert rule evaluation is too slow"`, `"Processing tick"`, `"Rules state was reset"`, …) and the **same** metric series (`grafana_alerting_*`) appear in both, which is itself evidence that the harness observes the canonical code.

---

## 2. Environment & exact reproduction

**Toolchain / environment `[OBSERVED]`:**
- Go `1.23.1` (matches the `go 1.23.1` directive in `go.mod`); the repo uses a `go.work` workspace at its root, so module resolution uses workspace defaults (never `-mod=mod`).
- `CGO_ENABLED=1` with `gcc` present — required because the default store uses the SQLite driver `github.com/mattn/go-sqlite3` (CGO).
- Git `HEAD = 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`.

**Canonical default configuration `[OBSERVED]`** (`conf/defaults.ini`, section `[unified_alerting]` at line 1220):

```
execute_alerts = true      # conf/defaults.ini:1335
evaluation_timeout = 30s   # conf/defaults.ini:1339
max_attempts = 3           # conf/defaults.ini:1342
min_interval = 10s         # conf/defaults.ini:1346  (the scheduler base tick)
```

**Commands used.**

Sanity‑compile the subject package (Approach B host):

```
$ export CGO_ENABLED=1
$ go test ./pkg/services/ngalert/schedule/
ok  	github.com/grafana/grafana/pkg/services/ngalert/schedule	3.219s
```

Run the canonical server (Approach A). All writable paths were redirected under `/tmp/gf-run` so **nothing is written into the repository tree**; the repository root is used only as the read‑only `--homepath` (for `conf/defaults.ini` + `public/`):

```
$ /tmp/grafana_bin/grafana server \
    --homepath "$REPO" \
    cfg:paths.data=/tmp/gf-run/data \
    cfg:paths.logs=/tmp/gf-run/logs \
    cfg:paths.plugins=/tmp/gf-run/plugins \
    cfg:paths.provisioning=/tmp/gf-run/prov \
    cfg:server.http_port=3000 \
    cfg:log.mode=console cfg:log.level=info \
    cfg:analytics.reporting_enabled=false cfg:analytics.check_for_updates=false \
    cfg:security.admin_password=admin
```

(The canonical build targets are `make gen-go` [Makefile:167] then `make build-server` [Makefile:201] / `make run-go` [Makefile:236]; a prebuilt canonical binary of the same commit was used to save build time. Backend/alerting runs even though `public/build` frontend assets were absent.)

Scrape metrics:

```
$ curl -s http://localhost:3000/metrics | grep '^grafana_alerting_'
```

Run the deterministic harness (Approach B), repeated for stability:

```
$ export CGO_ENABLED=1
$ go test -count=1 -v -run 'TestBlitzy(Drop|Failures|Cancellation|Deletion|Restart|Ordering|NormalBaseline)$' \
    ./pkg/services/ngalert/schedule/
```

**Scale & repetition `[OBSERVED]`.** Approach A used **30 rules** in one 10‑second group and ran each scenario for ≈100 s, repeated twice (stress run 1 and stress run 2). Approach B ran all seven scenarios **three times** (run 1 pre‑fix, runs 2 and 3 post‑fix); every headline value below was identical across runs (only random rule UIDs and wall‑clock timestamps differ). Per‑run stability is reported inline; any variation is called out explicitly.

---

## 3. Q1 — Prioritization under backpressure

### 3.1 Direct answer

**There is no global priority queue and no cross‑rule prioritization.** On every base tick the scheduler *recomputes from scratch* which rules are due, in a **deterministic order**, and hands each due rule’s tick to **that rule’s own goroutine**. “What to work on next” is therefore answered *per rule, per tick*: each rule always works on **its newest tick**, and if its previous evaluation is still running, the **older, unconsumed tick is dropped** (not queued, not reordered). A data source that begins to time out does **not** change this ordering; it only makes each evaluation occupy its routine longer (so more ticks are dropped) and, once the per‑evaluation attempts are exhausted, increments a failure counter.

**Where the choice first becomes visible at runtime:** the *drop* is the first‑visible signal, and it appears **simultaneously** as (a) a `WARN` log line `"Tick dropped because alert rule evaluation is too slow"` carrying the rule’s UID/org and the exact `droppedTick`, and (b) an increment of the Prometheus counter `grafana_alerting_schedule_rule_evaluations_missed_total{org,name}`. `[OBSERVED]`

### 3.2 The mechanism, named

Per tick, `processTick` [pkg/services/ngalert/schedule/schedule.go:235] re‑syncs the rule set from the database via `updateSchedulableAlertRules` [pkg/services/ngalert/schedule/fetcher.go:14] (which short‑circuits with `"No changes detected. Skip updating"` [pkg/services/ngalert/schedule/fetcher.go:27] when nothing changed), decides which rules are due this tick with the readiness test

```go
isReadyToRun := item.IntervalSeconds != 0 && (tickNum%itemFrequency)-offset == 0   // schedule.go:316
```

then **staggers** the due rules across the interval (`step = sch.baseInterval.Nanoseconds() / int64(len(readyToRun))` [pkg/services/ngalert/schedule/schedule.go:361]) and dispatches them in a **deterministic order sorted by rule UID** (`slices.SortFunc(readyToRun, …)` [pkg/services/ngalert/schedule/schedule.go:364]). Each due rule’s tick is delivered to that rule’s goroutine through `Eval` [pkg/services/ngalert/schedule/alert_rule.go:196], which implements a bounded “keep‑newest” mailbox over an **unbuffered** channel `evalCh: make(chan *Evaluation)` [pkg/services/ngalert/schedule/alert_rule.go:161]:

```go
case droppedMsg = <-a.evalCh:   // alert_rule.go:205  (drain a stale, unconsumed tick, if present)
...
case a.evalCh <- eval:          // alert_rule.go:210  (send the newest tick)
```

When a rule’s routine is still busy with a prior evaluation, the newer tick supersedes the older one, and the scheduler emits the drop signal at [pkg/services/ngalert/schedule/schedule.go:378] and [pkg/services/ngalert/schedule/schedule.go:380]:

```go
sch.log.Warn("Tick dropped because alert rule evaluation is too slow", append(key.LogContext(), "time", tick, "droppedTick", dropped.scheduledAt)...)   // schedule.go:378
sch.metrics.EvaluationMissed.WithLabelValues(orgID, item.rule.Title).Inc()                                                                             // schedule.go:380
```

The failure counter, when the data source times out, is `grafana_alerting_rule_evaluation_failures_total` [pkg/services/ngalert/metrics/scheduler.go:63]; the missed counter is `schedule_rule_evaluations_missed_total` [pkg/services/ngalert/metrics/scheduler.go:181]; the behind gauge is `scheduler_behind_seconds` [pkg/services/ngalert/metrics/scheduler.go:43], set each tick by `sch.metrics.BehindSeconds.Set(start.Sub(tick).Seconds())` [pkg/services/ngalert/schedule/schedule.go:215]. All series carry the prefix `grafana_alerting_` (Namespace `"grafana"` [pkg/services/ngalert/metrics/ngalert.go:10] + Subsystem `"alerting"` [pkg/services/ngalert/metrics/ngalert.go:11]).

### 3.3 Live evidence — canonical server under stress (Approach A) `[OBSERVED]`

Thirty rules in one 10 s group were pointed at a data source that sleeps 35 s (> the 30 s `evaluation_timeout`). The scheduler started canonically:

```
$ grep 'Starting scheduler' /tmp/gf-run/server_stress.log
logger=ngalert.scheduler t=2026-07-13T16:56:19.069810376Z level=info msg="Starting scheduler" tickInterval=10s maxAttempts=3
```

The **first‑visible drop signal** — the warning, carrying `rule_uid`, `org_id`, `time` (the newer tick) and `droppedTick` (the older, superseded tick):

```
$ grep 'Tick dropped' /tmp/gf-run/server_stress.log | head -6
logger=ngalert.scheduler t=2026-07-13T16:56:50.001581539Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=stressrule0000 org_id=1 time=2026-07-13T16:56:40Z droppedTick=2026-07-13T16:56:30Z
logger=ngalert.scheduler t=2026-07-13T16:56:50.335200585Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=stressrule0001 org_id=1 time=2026-07-13T16:56:40Z droppedTick=2026-07-13T16:56:30Z
logger=ngalert.scheduler t=2026-07-13T16:56:50.668552454Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=stressrule0002 org_id=1 time=2026-07-13T16:56:40Z droppedTick=2026-07-13T16:56:30Z
logger=ngalert.scheduler t=2026-07-13T16:56:51.001793182Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=stressrule0003 org_id=1 time=2026-07-13T16:56:40Z droppedTick=2026-07-13T16:56:30Z
logger=ngalert.scheduler t=2026-07-13T16:56:51.335804981Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=stressrule0004 org_id=1 time=2026-07-13T16:56:40Z droppedTick=2026-07-13T16:56:30Z
logger=ngalert.scheduler t=2026-07-13T16:56:51.66878168Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=stressrule0005 org_id=1 time=2026-07-13T16:56:40Z droppedTick=2026-07-13T16:56:30Z
```

The matching counter, and the aggregate scheduler gauges, at ≈105 s into the run:

```
$ curl -s http://localhost:3000/metrics | grep grafana_alerting_
grafana_alerting_rule_evaluation_failures_total{org="1"} 60
grafana_alerting_rule_evaluations_total{org="1"} 90
grafana_alerting_schedule_alert_rules 30
grafana_alerting_schedule_alert_rules_hash 1.3930619380427095e+18
grafana_alerting_schedule_periodic_duration_seconds_count 20
grafana_alerting_schedule_periodic_duration_seconds_sum 0.01341962
grafana_alerting_scheduler_behind_seconds 0.000233977
grafana_alerting_schedule_rule_evaluations_missed_total{name="stress-rule-000",org="1"} 16
grafana_alerting_schedule_rule_evaluations_missed_total{name="stress-rule-001",org="1"} 16
grafana_alerting_schedule_rule_evaluations_missed_total{name="stress-rule-002",org="1"} 16
grafana_alerting_schedule_rule_evaluations_missed_total{name="stress-rule-003",org="1"} 16
grafana_alerting_schedule_rule_evaluations_missed_total{name="stress-rule-004",org="1"} 16
```

The data‑source **timeout** surface (Q1’s “a data source begins to time out”), showing `attempt=1` and the real client‑timeout error:

```
$ grep 'Failed to evaluate rule' /tmp/gf-run/server_stress.log | head -1
logger=ngalert.scheduler rule_uid=stressrule0000 org_id=1 version=2 fingerprint=77d44bbfa95c41a4 now=2026-07-13T16:56:20Z t=2026-07-13T16:56:50.005006909Z level=error msg="Failed to evaluate rule" attempt=1 error="the result-set has errors that can be retried: [sse.dataQueryError] failed to execute query [A]: Post \"http://127.0.0.1:9199/api/v1/query\": net/http: request canceled (Client.Timeout exceeded while awaiting headers)"
```

**What this proves.** The drop warning names the exact superseded tick (`droppedTick=…16:56:30Z`) while the routine works the newer `time=…16:56:40Z`, which is precisely the “keep‑newest, drop‑older” mailbox behavior of `Eval`. The `…missed_total` counter increments in lock‑step (16 per rule at this point), and the `…failures_total` rises only once the data source’s attempts are exhausted. The stressed run accumulated **507 drop warnings** total; stress run 2 reproduced the same behavior (**52 → 109** drops climbing, same `droppedTick` supersession pattern).

### 3.4 The important, non‑obvious finding about `scheduler_behind_seconds` `[OBSERVED]`

A natural expectation is that a slow data source makes `scheduler_behind_seconds` climb. **It does not.** Across the stressed run it stayed **sub‑millisecond** even while 500+ ticks were being dropped:

| Snapshot | `scheduler_behind_seconds` | `schedule_periodic_duration_seconds` (sum / count) |
|---|---|---|
| stress run 1, t≈50 s | `0.000873644` | 0.006737 / 8  → ≈0.84 ms per tick |
| stress run 1, t≈105 s | `0.000064433` | 0.013420 / 20 → ≈0.67 ms per tick |
| stress run 1, t≈110 s | `0.000233977` | — |
| stress run 2, t≈55 s | `0.000774428` | 0.005466 / 5 → ≈1.09 ms per tick |

**Why.** `processTick` dispatches each rule’s evaluation *asynchronously* (via a `time.AfterFunc`/`errgroup` fan‑out) and returns quickly; the slow work happens inside each rule’s own goroutine. `scheduler_behind_seconds` is defined as `start.Sub(tick)` [pkg/services/ngalert/schedule/schedule.go:215] — i.e. how late the *tick loop* is, **not** how late any evaluation is. Because the loop never blocks on evaluations, it stays essentially on time, and every tick lands in the smallest histogram bucket of `schedule_periodic_duration_seconds` (`≤0.1 s`; buckets `{0.1,0.25,0.5,1,2,5,10}` [pkg/services/ngalert/metrics/scheduler.go:147]). **Consequence for Q1:** the *first* and *primary* runtime signal of backpressure is the **drop warning + `…missed_total` counter**, not `behind_seconds`. `behind_seconds` would rise only if the *tick loop itself* were delayed (e.g. a slow DB re‑sync in `updateSchedulableAlertRules`), which is a different mechanism. This refines the intuition rather than confirming it, and it is stated here as an observed result stable across two runs.

### 3.5 Corroboration — deterministic harness (Approach B) `[OBSERVED]`

The harness makes one rule’s evaluation block, then advances a further tick so the older tick is superseded:

```
$ go test -count=1 -v -run 'TestBlitzyDrop$' ./pkg/services/ngalert/schedule/
    ... level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=bfs04gid51fynd org_id=1 time=0001-01-01T00:00:03Z droppedTick=0001-01-01T00:00:02Z
    # HELP grafana_alerting_schedule_rule_evaluations_missed_total The total number of rule evaluations missed due to a slow rule evaluation.
    # TYPE grafana_alerting_schedule_rule_evaluations_missed_total counter
    grafana_alerting_schedule_rule_evaluations_missed_total{name="drop-rule",org="1"} 1
    grafana_alerting_rule_evaluations_total{org="1"} 2
    grafana_alerting_schedule_alert_rules 1
```

Ticks fired at `…:01`, `…:02`, `…:03`. The routine, busy since tick `…:01`, had tick `…:02` **drained and dropped** when tick `…:03` arrived, so `droppedTick=…00:00:02Z`. The decisive number is `rule_evaluations_total=2` (not 3): the dropped tick was **discarded, not deferred and not reordered**. The data‑source‑timeout path (separate harness case, `max_attempts=3`) shows the retry rhythm and that only the **final** attempt counts as a failure:

```
$ go test -count=1 -v -run 'TestBlitzyFailures$' ./pkg/services/ngalert/schedule/
    ... t=...:19.308... level=error msg="Failed to evaluate rule" ... "context deadline exceeded"
    ... t=...:20.309... level=error msg="Failed to evaluate rule" attempt=2 ...
    ... t=...:21.310... level=error msg="Failed to evaluate rule" ... "context deadline exceeded"
    grafana_alerting_rule_evaluation_failures_total{org="1"} 1
    grafana_alerting_rule_evaluations_total{org="1"} 1
```

The three attempts are ≈1 s apart (`…:19`, `…:20`, `…:21`), matching `const retryDelay = 1 * time.Second` [pkg/services/ngalert/schedule/schedule.go:36] and the loop `for attempt := int64(1); attempt <= a.maxAttempts; attempt++` [pkg/services/ngalert/schedule/alert_rule.go:282]; `failures_total=1` confirms only the exhausted‑attempts case increments the counter. (The raw grep count of the string `"Failed to evaluate rule"` was 5, because per attempt both the evaluator‑package error line and the rule‑routine error line are logged; the number of *attempts* is 3.)

---

## 4. Q2 — Cancellation vs. deletion vs. restart: what is left behind, and how to tell them apart

### 4.1 Direct answer

All three cases **cleanly move on** — no goroutine leak, no undeleted database instance, and no orphaned metric in any case — but they differ in **what happens to the rule’s in‑memory state and its alerts**, and each has a **distinct runtime fingerprint**:

| Case | In‑memory state cache | Stored alert instances (DB) | Resolve notification | Goroutine | Distinguishing log line |
|---|---|---|---|---|---|
| **(a) Rule deleted** mid‑flight | **cleared** | **deleted** | **sent** (for a previously‑firing rule) | returns | `"Resetting state of the rule"` → `"Rules state was reset"` → `"Stopping alert rule routine"` |
| **(b) Evaluation canceled** mid‑eval | **preserved** (prior state kept) | untouched | none | keeps running | `"Skip updating the state because the context has been cancelled"` |
| **(c) Rule restarted** (type changed) | **retained** (handed to the replacement routine) | untouched | none | old routine returns, new one starts | `"Rule restarted because type changed"` (and **no** `"Rules state was reset"`) |

The stop *cause* is what selects the cleanup branch: deletion stops the routine with `errRuleDeleted` [pkg/services/ngalert/schedule/registry.go:19] and restart with `errRuleRestarted` [pkg/services/ngalert/schedule/registry.go:20]; a plain evaluation cancellation is neither — it is an in‑flight context cancellation handled inside `evaluate`. Below, each case reports **before / during / after** state, captured with the deterministic harness (which lets each condition be triggered in isolation), and the log/metric signs.

### 4.2 (a) Rule deleted mid‑flight `[OBSERVED]`

A rule that was firing (`Alerting`) is removed from the store between ticks. The routine’s stop branch runs `DeleteStateByRuleUID(…, StateReasonRuleDeleted)` [pkg/services/ngalert/schedule/alert_rule.go:355] (reason constant `StateReasonRuleDeleted = "RuleDeleted"` [pkg/services/ngalert/models/alert_rule.go:165]) under a bounded context, then returns:

```
$ go test -count=1 -v -run 'TestBlitzyDeletion$' ./pkg/services/ngalert/schedule/
    BEFORE delete: states=1 firstState=Alerting senderSends=1
    AFTER delete:  states=0 senderSends=2
    rule_uid=cfs04go9lwirrd org_id=1 t=...Z level=debug msg="Resetting state of the rule"
    rule_uid=cfs04go9lwirrd org_id=1 t=...Z level=info  msg="Rules state was reset" states=1
    rule_uid=cfs04go9lwirrd org_id=1 t=...Z level=debug msg="Stopping alert rule routine"
```

- **Before:** the state cache holds 1 state (`Alerting`); the notifier has received 1 send (the firing alert).
- **During/after:** `states` drops **1 → 0** (cache cleared by `st.cache.removeByRuleUID` inside `DeleteStateByRuleUID` [pkg/services/ngalert/state/manager.go:236]); the notifier send count rises **1 → 2** — the extra send is the **resolve** emitted because the removed state was `Alerting` (the manager sets `ResolvedAt` for a firing→normal transition and posts the resolved alert). The `INFO` line `"Rules state was reset" states=1` [pkg/services/ngalert/state/manager.go:278] and the preceding `"Resetting state of the rule"` [pkg/services/ngalert/state/manager.go:238] are the delete fingerprint, and `"Stopping alert rule routine"` [pkg/services/ngalert/schedule/alert_rule.go:358] confirms the goroutine returns.
- **Left behind? Nothing.** Cache: cleared (`states=0`). DB instances: deleted — `DeleteStateByRuleUID` calls `st.instanceStore.DeleteAlertInstancesByRule(...)` immediately before the `"Rules state was reset"` log, so that log line firing is proof the DB‑delete path executed. Metric: the per‑rule label on `…missed_total` is `name`=rule title; a deleted rule simply stops incrementing (Prometheus counters are not “orphaned” — they are inert once the routine is gone). Goroutine: returns via `"Stopping alert rule routine"`.

### 4.3 (b) Evaluation canceled mid‑evaluation `[OBSERVED]`

Here the *evaluation’s* context is canceled while the query is in flight (e.g. the surrounding server is shutting down, or the tick’s context is done). The rule routine is **not** told to delete anything; instead `evaluate` notices the cancellation and **skips the state write**, so the previous state is preserved:

```
$ go test -count=1 -v -run 'TestBlitzyCancellation$' ./pkg/services/ngalert/schedule/
    BEFORE cancel:                       states=1 firstState=Alerting
    DURING (blocked, not yet written):   states=1 firstState=Alerting
    AFTER cancel:                        states=1 firstState=Alerting
    rule_uid=dfs04gnu7j217f org_id=1 ... level=debug msg="Skip updating the state because the context has been cancelled"
    rule_uid=dfs04gnu7j217f org_id=1 ... level=debug msg="Stopping alert rule routine"
    resolve/sends captured by sender = 1 (cancellation should not emit a resolve)
```

- **Before / during / after:** `states=1 firstState=Alerting` at **all three** points — the in‑flight result is discarded and the prior state is left exactly as it was. The decisive log line is `"Skip updating the state because the context has been cancelled"` [pkg/services/ngalert/schedule/alert_rule.go:393], which is the branch that returns without calling the state manager.
- **Left behind? Nothing stale, and — importantly — nothing *cleaned* either.** There is **no** `"Rules state was reset"` (count 0), and the sender’s send count stays **1** (that single send is tick 1’s original `Alerting` notification, *not* a resolve). Cache: unchanged (correctly — the rule still exists). DB: untouched. Goroutine: in this harness case the routine is then stopped and returns cleanly (`"Stopping alert rule routine"`); in a running server whose rule was merely canceled for one tick, the same routine simply proceeds to the next tick. This is the crucial contrast with deletion: **cancellation preserves state; deletion erases it.**

### 4.4 (c) Rule restarted (type changed) `[OBSERVED]`

When a rule’s *type* changes (e.g. alerting → recording), `processTick` restarts its routine, stopping the old one with `errRuleRestarted` and logging the reason [pkg/services/ngalert/schedule/schedule.go:295] / `oldRoutine.Stop(errRuleRestarted)` [pkg/services/ngalert/schedule/schedule.go:387]:

```
$ go test -count=1 -v -run 'TestBlitzyRestart$' ./pkg/services/ngalert/schedule/
    BEFORE restart: states=1 firstState=Alerting
    AFTER restart:  states=1
    rule_uid=ffs04gooxs364a org_id=1 ... level=debug msg="Rule restarted because type changed" old=alerting new=recording
    rule_uid=ffs04gooxs364a org_id=1 ... level=debug msg="Stopping alert rule routine"
    (no "Rules state was reset" expected: count=0)
```

- **Before / after:** `states=1` on both sides — **state is retained** for the replacement routine. There is **no** `DeleteStateByRuleUID` and therefore **no** `"Rules state was reset"` (count 0). The fingerprint is `"Rule restarted because type changed" old=alerting new=recording`.
- **Left behind? Nothing, and by design nothing is cleaned.** The old goroutine returns (`"Stopping alert rule routine"`); the new goroutine takes over the same key and inherits the state. Cache/DB/metric: untouched. This is why restart is *not* the same as delete even though both `Stop(...)` the routine — the **cause** (`errRuleRestarted` vs `errRuleDeleted`) selects whether cleanup runs.

### 4.5 Why these three are distinguishable at runtime

The three cases are told apart purely by **which log lines appear** (and the state/sender deltas):

- **Delete** ⇒ `"Resetting state of the rule"` + `"Rules state was reset"` + a resolve send + `states→0`.
- **Cancel** ⇒ `"Skip updating the state because the context has been cancelled"`, **no** reset, **no** resolve, `states` unchanged.
- **Restart** ⇒ `"Rule restarted because type changed"`, **no** reset, `states` unchanged.

All three end with `"Stopping alert rule routine"`, so that line alone does **not** disambiguate — the *preceding* line does. Every one of these was triggered in isolation and reproduced identically across runs 2 and 3 of the harness.

---

## 5. Q3 — Result ordering

### 5.1 Direct answer

**No.** During the stressed window a rule’s evaluation results **never appeared out of order.** Per rule, the observed sequence of processed ticks was **strictly monotonically increasing**, with dropped ticks showing up as **gaps** (skipped values), never as reorderings. This held across repeated, identical runs.

### 5.2 Why ordering is structurally guaranteed

Two facts make per‑rule reordering impossible:

1. **One goroutine per rule, reading its own unbuffered channel.** Each rule owns a single routine that receives ticks from its own `evalCh: make(chan *Evaluation)` [pkg/services/ngalert/schedule/alert_rule.go:161] (no capacity → unbuffered), and processes them one at a time in the routine loop (`Processing tick` [pkg/services/ngalert/schedule/alert_rule.go:269] → `Tick processed` [pkg/services/ngalert/schedule/alert_rule.go:332]). A single consumer of a single channel cannot interleave its own iterations.
2. **At most one pending evaluation (keep‑newest).** `Eval` [pkg/services/ngalert/schedule/alert_rule.go:196] drains any unconsumed older tick before sending the newest (`case droppedMsg = <-a.evalCh` [pkg/services/ngalert/schedule/alert_rule.go:205] then `case a.evalCh <- eval` [pkg/services/ngalert/schedule/alert_rule.go:210]). So the channel never holds a backlog that could be consumed out of order; a superseded tick is *discarded*, and the newest replaces it. `[INFERRED from source, confirmed by the observations below]`

This design is **uniform across rule types**: the recording‑rule routine uses the same unbuffered channel and the same drain‑then‑send mailbox (`evalCh` and its `Eval` in `pkg/services/ngalert/schedule/recording_rule.go`), so the ordering guarantee is not specific to alerting rules.

### 5.3 Live evidence — monotonic `scheduledAt` per rule `[OBSERVED]`

Three rules were driven over six ticks; for each rule, the `now=` (a.k.a. `scheduledAt`) value on its `"Processing tick"` lines was extracted (the harness registered the production contextual log provider so lines carry `rule_uid`, §1.2):

```
$ go test -count=1 -v -run 'TestBlitzyOrdering$' ./pkg/services/ngalert/schedule/   # run 2
    rule order-rule-0 (cfs04gp49nnkgf): processing-tick now-sequence = [00:00:01 00:00:02 00:00:03 00:00:04 00:00:05 00:00:06]
    rule order-rule-1 (efs04gp49nnl2e): processing-tick now-sequence = [00:00:01 00:00:02 00:00:03 00:00:04 00:00:05 00:00:06]
    rule order-rule-2 (ffs04gp49nnlce): processing-tick now-sequence = [00:00:01 00:00:02 00:00:03 00:00:04 00:00:05 00:00:06]
```

A sample of the raw interleaved lines shows that although *different rules* interleave (each on its own goroutine), *within* a rule the ticks are strictly in order and each `"Processing tick"` is immediately followed by its `"Tick processed"`:

```
rule_uid=afs... now=0001-01-01T00:00:01Z ... msg="Processing tick"
rule_uid=afs... now=0001-01-01T00:00:01Z ... msg="Tick processed" attempt=1 duration=0s
rule_uid=cfs... now=0001-01-01T00:00:01Z ... msg="Processing tick"
rule_uid=cfs... now=0001-01-01T00:00:01Z ... msg="Tick processed" attempt=1 duration=0s
rule_uid=afs... now=0001-01-01T00:00:02Z ... msg="Processing tick"
rule_uid=afs... now=0001-01-01T00:00:02Z ... msg="Tick processed" attempt=1 duration=0s
```

### 5.4 Run‑to‑run distribution (the ordering was not a fluke) `[OBSERVED]`

The identical input was run again (run 3); the per‑rule sequences were **identical and monotonic** again:

```
$ go test -count=1 -v -run 'TestBlitzyOrdering$' ./pkg/services/ngalert/schedule/   # run 3
    rule order-rule-0 (cfs04hl76yr63b): processing-tick now-sequence = [00:00:01 00:00:02 00:00:03 00:00:04 00:00:05 00:00:06]
    rule order-rule-1 (cfs04hl76yr6lf): processing-tick now-sequence = [00:00:01 00:00:02 00:00:03 00:00:04 00:00:05 00:00:06]
    rule order-rule-2 (afs04hl76yr6vd): processing-tick now-sequence = [00:00:01 00:00:02 00:00:03 00:00:04 00:00:05 00:00:06]
```

**Distribution:** across the two identical runs (2 and 3), for all three rules, the sequence was `[:01,:02,:03,:04,:05,:06]` every time — 0 inversions observed out of 6 rule‑sequences. Under stress (§3), the *same* property holds with the additional observation that dropped ticks appear as **missing** values in the sequence (e.g. the `droppedTick=…:30Z` in §3.3 is simply absent from that rule’s processed sequence), never as a later value appearing before an earlier one. **There is no cross‑rule ordering guarantee, and none is required** — ordering is a per‑rule property, and that is what the data shows.

---

## 6. Stressed‑run evidence appendix (complete, unedited captures)

**A.1 — Canonical server baseline `/metrics` (0 rules), proving the production metric surface `[OBSERVED]`:**

```
$ curl -s http://localhost:3000/metrics | grep '^grafana_alerting_'   # (scheduler/ticker series)
grafana_alerting_schedule_alert_rules 0
grafana_alerting_schedule_alert_rules_hash 1.4695981039346655e+19
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="0.1"} 8
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="0.25"} 8
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="0.5"} 8
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="1"} 8
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="2"} 8
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="5"} 8
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="10"} 8
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="+Inf"} 8
grafana_alerting_schedule_periodic_duration_seconds_count 8
grafana_alerting_schedule_periodic_duration_seconds_sum 0.002006054
grafana_alerting_scheduler_behind_seconds 0.000473901
grafana_alerting_ticker_interval_seconds 10
grafana_alerting_ticker_last_consumed_tick_timestamp_seconds 1.7839617e+09
grafana_alerting_ticker_next_tick_timestamp_seconds 1.78396171e+09
```

The histogram buckets `{0.1,0.25,0.5,1,2,5,10}` match the definition at [pkg/services/ngalert/metrics/scheduler.go:147]; `ticker_interval_seconds=10` matches the base tick (`min_interval = 10s`, `conf/defaults.ini:1346`) and the ticker metric names at [pkg/util/ticker/metrics.go:19-31].

**A.2 — Stressed aggregate series (30 rules, slow data source), t≈105 s `[OBSERVED]`** (full unedited block):

```
$ curl -s http://localhost:3000/metrics | grep '^grafana_alerting_'
grafana_alerting_rule_evaluation_failures_total{org="1"} 60
grafana_alerting_rule_evaluations_total{org="1"} 90
grafana_alerting_schedule_alert_rules 30
grafana_alerting_schedule_alert_rules_hash 1.3930619380427095e+18
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="0.1"} 20
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="0.25"} 20
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="0.5"} 20
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="1"} 20
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="2"} 20
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="5"} 20
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="10"} 20
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="+Inf"} 20
grafana_alerting_schedule_periodic_duration_seconds_count 20
grafana_alerting_schedule_periodic_duration_seconds_sum 0.01341962
grafana_alerting_scheduler_behind_seconds 0.000233977
```

All 20 ticks fell into the smallest bucket (`≤0.1 s`), i.e. the loop stayed fast while evaluations were slow — the §3.4 finding.

**A.3 — Total drop warnings accumulated (stressed run 1) `[OBSERVED]`:**

```
$ grep -c 'Tick dropped because alert rule evaluation is too slow' /tmp/gf-run/server_stress.log
507
```

**A.4 — Stress run 2 (repeat, for ≥2‑run stability) `[OBSERVED]`:**

```
drop warnings (t≈55s): 109
scheduler_behind_seconds: 0.000513501     (earlier in the same run: 0.000774428)
missed_total series count: 30
... msg="Tick dropped because alert rule evaluation is too slow" rule_uid=stressrule0000 org_id=1 time=2026-07-13T17:03:20Z droppedTick=2026-07-13T17:03:10Z
```

Same supersession pattern (`droppedTick=…:10Z` while working `time=…:20Z`); `behind_seconds` again sub‑millisecond.

---

## 7. Q6 — Normal‑load baseline and what visibly changes

### 7.1 Direct answer

Under normal load — the **identical 30 rules** pointed at a **fast/healthy** data source — the backpressure signals **vanish** and the evaluation **volume rises sharply**, while the tick‑loop timing is essentially unchanged (it was already fast under stress). Concretely: **drops 507 → 0**, **failures 30 → 0**, **`…missed_total` 30 series → 0 series**, and **`rule_evaluations_total` climbs steadily at ≈30/tick** instead of stalling.

### 7.2 Live evidence `[OBSERVED]`

```
$ grep 'Starting scheduler' /tmp/gf-run/server_normal.log
logger=ngalert.scheduler t=2026-07-13T17:00:05.132843136Z level=info msg="Starting scheduler" tickInterval=10s maxAttempts=3

$ curl -s http://localhost:3000/metrics | grep '^grafana_alerting_'
grafana_alerting_rule_evaluation_failures_total{org="1"} 0
grafana_alerting_rule_evaluations_total{org="1"} 374
grafana_alerting_schedule_alert_rules 30
grafana_alerting_schedule_alert_rules_hash 1.3930619380427095e+18
grafana_alerting_schedule_periodic_duration_seconds_count 13
grafana_alerting_schedule_periodic_duration_seconds_sum 0.01045691
grafana_alerting_scheduler_behind_seconds 0.000624048

$ curl -s http://localhost:3000/metrics | grep -c 'schedule_rule_evaluations_missed_total{'
0
$ grep -c 'Tick dropped because alert rule evaluation is too slow' /tmp/gf-run/server_normal.log
0
$ grep -c 'Failed to evaluate rule' /tmp/gf-run/server_normal.log
0
```

Throughput samples 25 s apart show the steady ≈30/tick cadence (all rules evaluate every interval):

```
rule_evaluations_total: t0 = 299   →   t+25s = 374   (delta = +75 over ~25s ≈ 2–3 ticks × 30 rules)
```

### 7.3 Side‑by‑side contrast `[OBSERVED]`

| Signal | Stressed (slow 35 s data source) | Normal (fast data source) |
|---|---|---|
| `"Tick dropped…"` warnings | **507** (run 1); reproduced in run 2 | **0** |
| `…schedule_rule_evaluations_missed_total` | **30 series**, climbing (16+/rule) | **0 series** |
| `rule_evaluation_failures_total{org="1"}` | **30 → 60** (rising) | **0** |
| `rule_evaluations_total{org="1"}` (volume) | **90** at t≈105 s (stalled ≈30 s/eval) | **374** by t≈90 s (climbing ≈30/tick) |
| `scheduler_behind_seconds` | ≈`0.0002`–`0.0009` s | ≈`0.0006` s |
| `schedule_periodic_duration_seconds` per tick | ≈0.7 ms | ≈0.8 ms |

**What visibly changes (timing & volume):** the *volume* difference is dramatic — normal load performs far more successful evaluations in less time (374 vs 90), because each evaluation returns in milliseconds instead of blocking for the full timeout. The *rhythm* difference is the disappearance of the `WARN` drop cadence and the failure lines. What **does not** change is `scheduler_behind_seconds`/`schedule_periodic_duration_seconds` — both remain sub‑10‑ms in *both* regimes, which is the same §3.4 point observed from the other direction: the tick loop is decoupled from evaluation latency, so the visible stress signal is drops/failures/volume, not loop lag.

### 7.4 Harness corroboration `[OBSERVED]`

The deterministic harness’s normal baseline (5 rules, fast evaluator, 6 ticks) shows zero drops/failures across runs 2 and 3:

```
NORMAL BASELINE: rules=5 ticks=6 | missed_total=0 failures_total=0 evaluations_total=30 schedule_alert_rules=5
```

---

## 8. Q5 — Identifiers, counters, and timing patterns (tracing one rule end‑to‑end)

### 8.1 Identifiers `[OBSERVED]`

A single rule is traceable across **both** the log stream and the metric labels by the **same identifiers**:

- **Rule UID** and **org ID** appear on every per‑rule log line, injected by the contextual log provider from `key.LogContext()` = `{"rule_uid", k.UID, "org_id", k.OrgID}` [pkg/services/ngalert/models/alert_rule.go:460-462]. Example from the stressed run: `rule_uid=stressrule0000 org_id=1`.
- The **rule title** is the `name` label on the drop counter: `grafana_alerting_schedule_rule_evaluations_missed_total{name="stress-rule-000",org="1"}` — the counter is incremented with `WithLabelValues(orgID, item.rule.Title)` [pkg/services/ngalert/schedule/schedule.go:380].

So rule `stressrule0000` / title `stress-rule-000` / org `1` can be followed from its `"Processing tick"` line, to its `"Failed to evaluate rule"` line, to its `"Tick dropped…"` warning, to its `…missed_total{name="stress-rule-000",org="1"}` counter — one identity, four surfaces.

### 8.2 Counters & gauges observed (all `grafana_alerting_*`) `[OBSERVED]`

| Series | Type | Definition | Role in this investigation |
|---|---|---|---|
| `schedule_rule_evaluations_missed_total{org,name}` | counter | scheduler.go:181 | **Q1 primary** drop counter |
| `rule_evaluation_failures_total{org}` | counter | scheduler.go:63 | data‑source‑timeout failures (final attempt only) |
| `rule_evaluations_total{org}` | counter | scheduler.go:52 | evaluation volume (Q6 contrast) |
| `scheduler_behind_seconds` | gauge | scheduler.go:43 | tick‑loop lag (stays ~0; §3.4) |
| `schedule_periodic_duration_seconds` | histogram | scheduler.go:147 | per‑tick loop time (buckets 0.1…10) |
| `schedule_alert_rules`, `_hash` | gauge | scheduler.go:156,164 | scheduled rule count / set hash |
| `ticker_interval_seconds`, `ticker_last_consumed_tick_…`, `ticker_next_tick_…` | gauge | ticker/metrics.go:31,19,25 | 10 s base tick and tick timestamps |

### 8.3 Timing / rhythm patterns, pauses, and recovery `[OBSERVED]`

- **Base cadence:** `ticker_interval_seconds=10` and the drop warnings falling on exact 10 s wall‑clock boundaries (`…:56:30Z`, `…:56:40Z`) show the 10 s heartbeat.
- **Stagger:** within a tick, the 30 rules’ log lines are spread out (successive `"Tick dropped…"` timestamps ≈0.33 s apart: `…:50.001`, `…:50.335`, `…:50.668`, `…:51.001`). This is the interval‑spreading `step = baseInterval / len(readyToRun)` [pkg/services/ngalert/schedule/schedule.go:361] (≈10 s / 30 ≈ 0.33 s) combined with the jitter offset (`jitterOffsetInTicks` in `pkg/services/ngalert/schedule/jitter.go`).
- **Pause under load:** while a rule’s routine is blocked on the slow data source (~30 s), that rule’s cadence *stalls* — no `"Tick processed"` for it — and the intervening ticks are dropped. The retry rhythm inside a blocked evaluation is ≈1 s (`retryDelay` [pkg/services/ngalert/schedule/schedule.go:36]) across `max_attempts=3`.
- **Recovery:** when the data source becomes healthy (the normal run), the drop `WARN` lines cease entirely and the even ≈0.33 s‑staggered cadence of successful evaluations returns, with `rule_evaluations_total` climbing ≈30/tick (§7). The transition is visible as the simultaneous disappearance of `…missed_total` series and failure lines.

---

## 9. Observed‑vs‑inferred ledger

| # | Claim | Label | Primary evidence |
|---|---|---|---|
| 1 | Scheduler starts canonically with `tickInterval=10s maxAttempts=3` | `[OBSERVED]` | server log `"Starting scheduler"` (both runs); schedule.go:157, ngalert.go:424/558 |
| 2 | Backpressure’s first‑visible signal is the drop warning + `…missed_total` | `[OBSERVED]` | §3.3 warning lines + counter; schedule.go:378,380 |
| 3 | The dropped tick is the *older* (`droppedTick`), the routine keeps the *newest* | `[OBSERVED]` | §3.3/§3.5 `droppedTick` values; `rule_evaluations_total=2` not 3 |
| 4 | A slow data source does **not** materially raise `scheduler_behind_seconds` (stays sub‑ms) | `[OBSERVED]` (2 runs) | §3.4 table; schedule.go:215 |
| 5 | Data‑source timeout → `rule_evaluation_failures_total`, final attempt only; 3 attempts ≈1 s apart | `[OBSERVED]` | §3.3/§3.5; schedule.go:36, alert_rule.go:282 |
| 6 | Delete: cache cleared, DB instances deleted, resolve sent, routine returns | `[OBSERVED]` | §4.2 (`states 1→0`, sends `1→2`); manager.go:236/238/278, alert_rule.go:355/358 |
| 7 | Cancel: prior state preserved, no reset, no resolve | `[OBSERVED]` | §4.3 (`states=1` before/during/after); alert_rule.go:393 |
| 8 | Restart: state retained, no cleanup | `[OBSERVED]` | §4.4 (`states=1` both sides, no reset); schedule.go:295/387, registry.go:20 |
| 9 | Per‑rule results are strictly ordered (monotonic `scheduledAt`), drops are gaps not reorderings | `[OBSERVED]` (2 identical runs) | §5.3/§5.4 now‑sequences |
| 10 | Ordering guaranteed by single goroutine + unbuffered channel + keep‑newest mailbox | `[INFERRED]`, confirmed by #9 | alert_rule.go:161/196/205/210/269/332 |
| 11 | Normal load: 0 drops, 0 failures, higher volume; loop timing unchanged | `[OBSERVED]` | §7.2/§7.3 |
| 12 | Mailbox/ordering behavior is uniform across rule types (recording rules) | `[INFERRED]` | recording_rule.go (same `evalCh`/`Eval` pattern) |

---

## 10. Repository integrity (Q7)

**Guarantee:** the repository is byte‑for‑byte unchanged apart from this one document.

**Method.** Every observation artifact lived outside the repository tree: the canonical server wrote only under `/tmp/gf-run/**` (all `paths.*` redirected; the repo root was used read‑only as `--homepath`), the mock data source and provisioning YAML lived under `/tmp/gf-run/**`, and the raw captures under `/tmp/blitzy-probe/**`. The one artifact that had to live *inside* the package (so it could exercise the real, unexported scheduler code) was the ephemeral Go test `pkg/services/ngalert/schedule/blitzy_adhoc_probe_test.go`; it was treated as a temporary observation script and **deleted** after the captures were taken.

**Before (clean baseline) `[OBSERVED]`:**

```
$ git rev-parse HEAD
4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff
$ git status --porcelain
        (empty)
```

**After cleanup `[OBSERVED]` (only this new document remains, under `blitzy/`):**

```
$ git status --porcelain
?? blitzy/documentation/grafana_4550cfb5b728.md
$ ls pkg/services/ngalert/schedule/blitzy_adhoc_probe_test.go
ls: cannot access '...': No such file or directory     # harness removed
$ ls data 2>/dev/null || echo "no data/ dir in repo"
no data/ dir in repo                                   # server wrote only to /tmp
```

All temporary servers and the mock data source were stopped by their exact PIDs (never with broad `pkill`/`killall`), and the `/tmp` scratch directories are removed on completion. The single persistent change introduced by this investigation is the file you are reading.

---

*End of investigation. All commands and outputs above were captured at commit `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`; source citations were re‑verified with `grep -n` against that commit.*
