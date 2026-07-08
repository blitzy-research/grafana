# Grafana Unified Alerting Scheduler Under Stress — A Runtime Investigation

> **What this document is.** A runtime-evidence-backed answer to three questions about how Grafana's
> Unified Alerting **scheduler** (`pkg/services/ngalert/schedule`) behaves when the system is under load.
> Every claim below is grounded in output that was **actually captured from a running Grafana backend**,
> not from reading the source alone. Each piece of evidence is shown together with the exact command that
> produced it and a `file:line` citation into the pinned source tree.
>
> **Pinned commit:** `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` (branch `grafana_4550cfb5b728`).
> **Go toolchain:** `1.23.1` (`go.mod:3`).
> **Method:** run first, then write. The backend was built in its canonical configuration, driven into
> backpressure with a slow data source and a short tick interval, observed via structured DEBUG/WARN logs
> and the Prometheus `/metrics` endpoint, and then re-run under normal load for comparison. All temporary
> observation artifacts were removed afterward (see §6.4); the repository contains only this one new file.

---

## Table of contents

1. [Scenario & setup — exact build, run, and configuration](#1-scenario--setup)
2. [User Question 1 — how work is selected under load, and where "falling behind" first becomes visible](#2-user-question-1--work-selection-under-load--first-visibility)
3. [User Question 2 — cancellation vs. removal: what is left behind](#3-user-question-2--cancellation-vs-removal)
4. [User Question 3 — does per-rule ordering ever invert? (negative result)](#4-user-question-3--ordering-preservation-negative-result)
5. [Stressed-vs-normal comparison](#5-stressed-vs-normal-comparison)
6. [Reasoning / mechanism appendix](#6-reasoning--mechanism-appendix)

---

## 1. Scenario & setup

### 1.1 The three questions (verbatim)

1. **Work selection under load + first visibility.** "When many alert rule changes arrive while
   evaluations are already falling behind and a data source begins to time out, how does the system decide
   what to work on next, and where does that choice first become visible while it is running?"
2. **Cancellation vs. removal.** "If an evaluation is canceled or a rule is removed partway through, does
   anything get left behind, or does the system cleanly move on, and what signs at runtime tell you which
   one happened?"
3. **Ordering preservation.** "During that same window, do evaluation results ever appear out of order, and
   if they do not, what observable behavior suggests the ordering was preserved?"

### 1.2 Canonical build

The server was built with the repository's canonical `make` target. `build-server` runs
`go run build.go build-server` (`Makefile:201-203`).

```console
$ make build-server
```

Captured banner (unedited):

```
build server
...
Version: 11.5.0-pre, Commit: 4550cfb5b7, Build date: ...
building backend bin/linux-amd64/grafana-server (linux amd64) go1.23.1
```

`make build-server` produces `bin/linux-amd64/grafana-server`, which at this commit is a **deprecation
shim**. The real server entry point is the `grafana` binary compiled from `./pkg/cmd/grafana`:

```console
$ go build -o ./bin/linux-amd64/grafana ./pkg/cmd/grafana
```

Both binaries are git-ignored build artifacts (confirmed in §6.4 — `git status` shows no tracked-file
change). The scheduler is bootstrapped through the canonical wiring in `pkg/services/ngalert/ngalert.go`:
`schedCfg := schedule.SchedulerCfg{...}` (`ngalert.go:376`) with `Log: log.New("ngalert.scheduler")`
(`ngalert.go:390`), then `scheduler := schedule.NewScheduler(schedCfg, stateManager)` (`ngalert.go:424`).
The `ngalert.scheduler` logger name is what we grep for below.

### 1.3 Canonical run invocation

The server was launched against a scratch config and homepath (the repository root, which provides
`conf/defaults.ini` and `public/`):

```console
$ ./bin/linux-amd64/grafana server --homepath . --config /tmp/obs/grafana.stress.ini \
    > /tmp/obs/captures/server.stress.log 2>&1 &
```

(The identical invocation with `/tmp/obs/grafana.normal.ini` was used for the normal run.)

### 1.4 The two temporary configurations (verbatim)

**STRESS** — `/tmp/obs/grafana.stress.ini`:

```ini
app_mode = production
[paths]
data = /tmp/obs/data-stress
logs = /tmp/obs/logs-stress
plugins = /tmp/obs/plugins-stress
provisioning = /tmp/obs/prov-stress
[server]
http_addr = 127.0.0.1
http_port = 3000
[analytics]
reporting_enabled = false
check_for_updates = false
[log]
level = debug
[log.console]
level = debug
format = console
[feature_toggles]
enable = configurableSchedulerTick
[unified_alerting]
enabled = true
scheduler_tick_interval = 1s
```

**NORMAL** — `/tmp/obs/grafana.normal.ini` (identical except: `-normal` scratch dirs, `http_port = 3001`,
**no** `[feature_toggles]` section, and `[unified_alerting]` contains only `enabled = true` so the tick
stays at its 10s default):

```ini
app_mode = production
[paths]
data = /tmp/obs/data-normal
logs = /tmp/obs/logs-normal
plugins = /tmp/obs/plugins-normal
provisioning = /tmp/obs/prov-normal
[server]
http_addr = 127.0.0.1
http_port = 3001
[analytics]
reporting_enabled = false
check_for_updates = false
[log]
level = debug
[log.console]
level = debug
format = console
[unified_alerting]
enabled = true
```

### 1.5 CRITICAL gotcha — the tick interval is gated behind a feature toggle

`scheduler_tick_interval` is parsed unconditionally (`setting_unified_alerting.go:335`) but is **only
applied** when the `configurableSchedulerTick` feature toggle is enabled
(`if cfg.IsFeatureToggleEnabled("configurableSchedulerTick")`, `setting_unified_alerting.go:336`). With the
toggle **on** and a non-default value, Grafana logs a WARN (`setting_unified_alerting.go:341`); with the
toggle **off**, it logs a different WARN and keeps the 10s default (`setting_unified_alerting.go:345`,
`SchedulerBaseInterval = 10 * time.Second` at `setting_unified_alerting.go:62`). The STRESS config
therefore includes `[feature_toggles] enable = configurableSchedulerTick`. Proof the short tick took
effect:

```console
$ grep 'Scheduler tick interval is changed to non-default' /tmp/obs/captures/server.stress.log
```
```
logger=settings t=2026-07-08T04:17:25.568587636Z level=warn msg="Scheduler tick interval is changed to non-default" interval=1s default=10s
```

This is the WARN emitted at `setting_unified_alerting.go:341` — it does **not** contain the
"feature flag is not enabled" suffix, confirming the toggle was on and `BaseInterval` became `1s`.

The scheduler then starts with that interval (INFO from the `ngalert.scheduler` logger):

```console
$ grep 'Starting scheduler' /tmp/obs/captures/server.stress.log
```
```
logger=ngalert.scheduler t=2026-07-08T04:18:00.356148104Z level=info msg="Starting scheduler" tickInterval=1s maxAttempts=3
```

`maxAttempts=3` matches `schedulerDefaultMaxAttempts = 3` (`setting_unified_alerting.go:52`).

### 1.6 Observability surface

All alerting metrics use `Namespace = "grafana"` (`metrics/ngalert.go:10`) and `Subsystem = "alerting"`
(`metrics/ngalert.go:11`), so they appear as `grafana_alerting_*` on `/metrics`:

```console
$ curl -s -u admin:admin http://127.0.0.1:3000/metrics | grep -c '^grafana_alerting_'
244
```

Raising `[log] level = debug` (default is `info`) is what surfaces the scheduler DEBUG lines
("Rule is ready to run on the current tick", "Processing tick", "Tick processed", "Stopping alert rule
routine") that the answers below depend on.

### 1.7 The timeout lever (slow data source)

To force evaluations past the 30s default evaluation timeout
(`evaluatorDefaultEvaluationTimeout = 30 * time.Second`, `setting_unified_alerting.go:49`), a tiny
Prometheus-compatible HTTP mock (`/tmp/obs/slowprom.py`, a `ThreadingHTTPServer` on port 9790) answered
`/api/v1/query` with a `sleep` of 25s (STRESS) whenever the query contained `slow_metric`, while keeping
`/api/v1/query` health/buildinfo probes fast. It was registered as a Prometheus data source
(`uid=bfrgfj26n18g0e`). Alert rules were created against it through the provisioning API
(`POST /api/v1/provisioning/alert-rules`, with header `X-Disable-Provenance: true`).

### 1.8 Run scale & duration

| Run | Tick interval | Rules | Rule interval | Data source | Wall-clock | Log file |
|-----|---------------|-------|---------------|-------------|-----------|----------|
| STRESS #1 | 1s | 40 → 39 | 10s | 25s sleeper (times out at 30s) | ~14 min | `server.stress.log` |
| STRESS #2 | 1s | 39 (reloaded) | 10s | 25s sleeper | ~6 min | `server.stress2.log` |
| NORMAL | 10s (default) | 39 | 10s | fast (`up`, ~8ms) | ~6 min | `server.normal.log` |

The scenario was run **twice under stress** (to confirm value stability) and once under normal load (for
the comparison in §5). Where a magnitude is reported below, the scale and the ≥2-run stability are stated
with it.

### 1.9 Deterministic complement

Alongside the live end-to-end run, the `schedule` package's own fake-clock unit tests were executed as a
low-noise corroboration. They exercise the **real** `processTick`/`Eval` code with a mock clock
(`clock.NewMock()`) and a fake evaluator, so they are canonical but are explicitly labeled as the
**deterministic fake-clock harness** wherever cited. They are never committed.

---

## 2. User Question 1 — work selection under load & first visibility

### 2.1 Direct answer

Per heartbeat tick, the scheduler function **`processTick`** (`schedule.go:235`) recomputes, for **every**
schedulable rule, whether that rule is due on this tick. The readiness test is
`isReadyToRun := item.IntervalSeconds != 0 && (tickNum%itemFrequency)-offset == 0` (`schedule.go:316`).
The rules that are ready are collected into a slice, **sorted deterministically by rule UID**
(`schedule.go:364-366`), and then dispatched with an **increasing time offset** so the work is spread
across the interval rather than fired all at once: `step = baseInterval / len(readyToRun)`
(`schedule.go:361`) and `time.AfterFunc(i*step, ...)` (`schedule.go:370`). So "what to work on next" is:
*every rule whose interval divides this tick (minus its jitter offset), dispatched in UID order, smeared
across the interval by `step`.*

"Falling behind" **first becomes visible at the very top of each heartbeat**, before any rule work starts:
`schedulePeriodic` (`schedule.go:205`) sets the gauge `grafana_alerting_scheduler_behind_seconds`
(`metrics/scheduler.go:43`) to `start.Sub(tick)` (`schedule.go:214-215`) — the wall-clock delay between
when the tick was *supposed* to fire and when the loop *actually* got to it. When an individual rule's
goroutine is too busy to accept a new tick, the drop is then reported as the WARN
`"Tick dropped because alert rule evaluation is too slow"` (`schedule.go:378`) and the counter
`grafana_alerting_schedule_rule_evaluations_missed_total{org,name}` is incremented (`schedule.go:380`,
declared at `metrics/scheduler.go:181`). The heartbeat ticker itself **never drops ticks**
(`ticker/ticker.go:26`) — every drop originates at the per-rule channel (see §4).

### 2.2 How readiness is decided — the `isReadyToRun` computation

The code (unedited, `schedule.go:314-316`, `:329`):

```go
itemFrequency := item.IntervalSeconds / int64(sch.baseInterval.Seconds())
offset := jitterOffsetInTicks(item, sch.baseInterval, sch.jitterEvaluations)
isReadyToRun := item.IntervalSeconds != 0 && (tickNum%itemFrequency)-offset == 0
...
if isReadyToRun {
    logger.Debug("Rule is ready to run on the current tick", "tick", tick, "frequency", itemFrequency, "offset", offset)
```

- `tickNum := tick.Unix() / int64(sch.baseInterval.Seconds())` (`schedule.go:236`) — the tick index.
- `itemFrequency` — how many base ticks make up this rule's interval. With a 10s rule interval and a 1s
  base tick, `itemFrequency = 10/1 = 10`.
- `offset = jitterOffsetInTicks(...)` (`jitter.go:39`) — a deterministic per-rule hash offset that spreads
  rules within their interval. It returns 0 **only** when jitter is disabled (`JitterNever`); the default
  strategy is `JitterByGroup` (`jitter.go:24`), so jitter is **on** by default.
- A rule is due exactly when `(tickNum % itemFrequency) - offset == 0`.

Captured DEBUG lines proving this fires with real values (`frequency=10`, `offset=1`, matching the
10s/1s = 10 computation and a `JitterByGroup` offset of 1):

```console
$ grep 'Rule is ready to run on the current tick' /tmp/obs/captures/server.stress.log | head -6
```
```
logger=ngalert.scheduler rule_uid=slowrule004 org_id=1 t=2026-07-08T04:23:11.436650091Z level=debug msg="Rule is ready to run on the current tick" tick=2026-07-08T04:23:11Z frequency=10 offset=1
logger=ngalert.scheduler rule_uid=slowrule009 org_id=1 t=2026-07-08T04:23:11.436673844Z level=debug msg="Rule is ready to run on the current tick" tick=2026-07-08T04:23:11Z frequency=10 offset=1
logger=ngalert.scheduler rule_uid=slowrule019 org_id=1 t=2026-07-08T04:23:11.436693998Z level=debug msg="Rule is ready to run on the current tick" tick=2026-07-08T04:23:11Z frequency=10 offset=1
logger=ngalert.scheduler rule_uid=slowrule035 org_id=1 t=2026-07-08T04:23:11.436710863Z level=debug msg="Rule is ready to run on the current tick" tick=2026-07-08T04:23:11Z frequency=10 offset=1
logger=ngalert.scheduler rule_uid=slowrule037 org_id=1 t=2026-07-08T04:23:11.436739071Z level=debug msg="Rule is ready to run on the current tick" tick=2026-07-08T04:23:11Z frequency=10 offset=1
logger=ngalert.scheduler rule_uid=slowrule003 org_id=1 t=2026-07-08T04:23:11.436757683Z level=debug msg="Rule is ready to run on the current tick" tick=2026-07-08T04:23:11Z frequency=10 offset=1
```

### 2.3 How the ready set is dispatched — UID sort + `time.AfterFunc` spread

The dispatch loop (unedited, `schedule.go:359-380`):

```go
var step int64 = 0
if len(readyToRun) > 0 {
    step = sch.baseInterval.Nanoseconds() / int64(len(readyToRun))
}

slices.SortFunc(readyToRun, func(a, b readyToRunItem) int {
    return strings.Compare(a.rule.UID, b.rule.UID)
})
for i := range readyToRun {
    item := readyToRun[i]

    time.AfterFunc(time.Duration(int64(i)*step), func() {
        key := item.rule.GetKey()
        success, dropped := item.ruleRoutine.Eval(&item.Evaluation)
        if !success {
            sch.log.Debug("Scheduled evaluation was canceled because evaluation routine was stopped", append(key.LogContext(), "time", tick)...)
            return
        }
        if dropped != nil {
            sch.log.Warn("Tick dropped because alert rule evaluation is too slow", append(key.LogContext(), "time", tick, "droppedTick", dropped.scheduledAt)...)
            orgID := fmt.Sprint(key.OrgID)
            sch.metrics.EvaluationMissed.WithLabelValues(orgID, item.rule.Title).Inc()
        }
    })
}
```

Step by step: the ready set is sorted by UID (`schedule.go:364`); `step` is the interval divided by the
number of ready rules (`schedule.go:361`); each rule `i` is dispatched after delay `i*step`
(`schedule.go:370`), calling `item.ruleRoutine.Eval(...)` (`schedule.go:372`); a `false` return means the
routine was stopped (DEBUG, `schedule.go:374`); a non-nil `dropped` means the routine was too busy and an
older tick was displaced — WARN (`schedule.go:378`) + counter increment (`schedule.go:380`).

**Observed dispatch order and spread.** With 40 rules ready on the 1s tick, `step = 1s / 40 = 25ms`. The
`"Processing tick"` DEBUG lines for tick `04:23:11` arrive in UID order, ~25 ms apart:

```console
$ grep 'Processing tick' /tmp/obs/captures/server.stress.log | grep 'now=2026-07-08T04:23:11Z' | head -10
```
```
logger=ngalert.scheduler rule_uid=slowrule001 org_id=1 version=2 fingerprint=04a549303db56dcd now=2026-07-08T04:23:11Z t=2026-07-08T04:23:11.437416362Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule002 org_id=1 version=2 fingerprint=5414a74228eb2b20 now=2026-07-08T04:23:11Z t=2026-07-08T04:23:11.463408541Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule003 org_id=1 version=2 fingerprint=ba7a65c11c34a89f now=2026-07-08T04:23:11Z t=2026-07-08T04:23:11.487786186Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule004 org_id=1 version=2 fingerprint=fff550a8113ce93a now=2026-07-08T04:23:11Z t=2026-07-08T04:23:11.512938568Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule005 org_id=1 version=2 fingerprint=1c1010bb4b67db19 now=2026-07-08T04:23:11Z t=2026-07-08T04:23:11.537433393Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule006 org_id=1 version=2 fingerprint=e00c96609ec51444 now=2026-07-08T04:23:11Z t=2026-07-08T04:23:11.562801404Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule007 org_id=1 version=2 fingerprint=180c1f80d846e51b now=2026-07-08T04:23:11Z t=2026-07-08T04:23:11.587707986Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule008 org_id=1 version=2 fingerprint=90ece8640062f07e now=2026-07-08T04:23:11Z t=2026-07-08T04:23:11.613115386Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule009 org_id=1 version=2 fingerprint=142795a06cbde675 now=2026-07-08T04:23:11Z t=2026-07-08T04:23:11.637862687Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule010 org_id=1 version=2 fingerprint=5577942da31a23a2 now=2026-07-08T04:23:11Z t=2026-07-08T04:23:11.663249836Z level=debug msg="Processing tick"
```

The `t=` deltas are `.437 → .463 → .487 → .512 → .537 → .562 → .587 → .613 → .637 → .663`, i.e. ~25–26 ms
apart — exactly the `step = baseInterval/len(readyToRun)` spread, in UID order (`slowrule001` … `010`).
This is `processTick` and the struct `readyToRunItem` (`schedule.go:228`) at work.

### 2.4 Where "falling behind" first becomes visible — `scheduler_behind_seconds`

The gauge is set at the top of every heartbeat, **before** `processTick` is even called
(unedited, `schedule.go:213-216`):

```go
start := time.Now().Round(0)
sch.metrics.BehindSeconds.Set(start.Sub(tick).Seconds())

sch.processTick(ctx, dispatcherGroup, tick)
```

So `grafana_alerting_scheduler_behind_seconds` is the earliest, most direct runtime signal of the loop
falling behind. Captured as a 1-per-second time series under stress (rise-and-recover rhythm; note the
spike to `4.117433157` seconds):

```console
$ while true; do
    printf '%s ' "$(date +%H:%M:%S)"
    curl -s -u admin:admin http://127.0.0.1:3000/metrics \
      | awk '/^grafana_alerting_scheduler_behind_seconds /{print $2}'
    sleep 1
  done
```
```
04:28:05 0.001112858
04:28:06 0.180637053
04:28:07 0.000120501
04:28:09 0.030796049
04:28:12 0.033241496
04:28:15 0.580910236
04:28:34 0.782426522
04:28:35 0.782426522
04:28:36 0.782426522
04:28:37 0.782426522
04:28:39 4.117433157
04:28:40 0.001012244
```

(An earlier window peaked higher, at `5.082527387` s.) The gauge rises when many rules become ready at the
same instant and their dispatch/eval work delays the next heartbeat, then recovers as the backlog drains —
this rise-and-recover is the "pause / rhythm change" the question asks about.

### 2.5 The drop signal — WARN + missed counter

When a rule's goroutine is mid-evaluation and cannot accept the new tick, the older pending tick is
displaced and reported. Captured WARN lines (unedited); note `droppedTick` (`04:23:21Z`) is **older** than
the surviving `time` (`04:23:31Z`):

```console
$ grep 'Tick dropped because alert rule evaluation is too slow' /tmp/obs/captures/server.stress.log | head -6
```
```
logger=ngalert.scheduler t=2026-07-08T04:23:39.081366645Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=slowrule007 org_id=1 time=2026-07-08T04:23:31Z droppedTick=2026-07-08T04:23:21Z
logger=ngalert.scheduler t=2026-07-08T04:23:41.001682666Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=slowrule001 org_id=1 time=2026-07-08T04:23:31Z droppedTick=2026-07-08T04:23:21Z
logger=ngalert.scheduler t=2026-07-08T04:23:41.027129681Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=slowrule002 org_id=1 time=2026-07-08T04:23:31Z droppedTick=2026-07-08T04:23:21Z
logger=ngalert.scheduler t=2026-07-08T04:23:41.052429223Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=slowrule003 org_id=1 time=2026-07-08T04:23:31Z droppedTick=2026-07-08T04:23:21Z
logger=ngalert.scheduler t=2026-07-08T04:23:41.077607292Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=slowrule004 org_id=1 time=2026-07-08T04:23:31Z droppedTick=2026-07-08T04:23:21Z
logger=ngalert.scheduler t=2026-07-08T04:23:41.101901638Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=slowrule005 org_id=1 time=2026-07-08T04:23:31Z droppedTick=2026-07-08T04:23:21Z
```

The counter carries `{org, name}` labels exactly as declared at `metrics/scheduler.go:181`
(`[]string{"org", "name"}`, `:184`):

```console
$ curl -s -u admin:admin http://127.0.0.1:3000/metrics | grep 'schedule_rule_evaluations_missed_total' | head -4
```
```
grafana_alerting_schedule_rule_evaluations_missed_total{name="slowrule-001",org="1"} 17
grafana_alerting_schedule_rule_evaluations_missed_total{name="slowrule-002",org="1"} 15
grafana_alerting_schedule_rule_evaluations_missed_total{name="slowrule-003",org="1"} 15
grafana_alerting_schedule_rule_evaluations_missed_total{name="slowrule-004",org="1"} 15
```

**WARN ↔ counter pairing.** The WARN (`schedule.go:378`) and the `Inc()` (`schedule.go:380`) live in the
same `if dropped != nil` block, so they are structurally 1:1. Observed at a mid-run scrape moment, the
cumulative WARN count equaled the summed counter **exactly**:

```console
$ grep -c 'Tick dropped because alert rule evaluation is too slow' /tmp/obs/captures/server.stress.log   # mid-run
978
$ curl -s -u admin:admin http://127.0.0.1:3000/metrics \
    | awk '/^grafana_alerting_schedule_rule_evaluations_missed_total/{s+=$NF} END{print s}'
978
```

(Over the full ~14-minute run the log accumulated **2273** such WARN lines in total; the 978↔978 snapshot
above was taken partway through and demonstrates the 1:1 pairing.)

### 2.6 The ticker is not the source of drops

The heartbeat source is documented to never drop ticks: `// ... and never drops ticks.`
(`ticker/ticker.go:26`). This is why "falling behind" surfaces as the `behind_seconds` gauge (loop lag) and
as per-rule drop WARNs (channel backpressure) — not as missing heartbeats. The ticker's own cadence gauges
(`ticker_last_consumed_tick_timestamp_seconds` `ticker/metrics.go:19`,
`ticker_next_tick_timestamp_seconds` `:25`, `ticker_interval_seconds` `:31`) continue advancing steadily
throughout.

### 2.7 Deterministic corroboration

The real `processTick` was exercised under the fake-clock harness `TestProcessTicks`
(`schedule_unit_test.go:40`). It passed, including the subtests that assert UID-sorted dispatch and
per-tick readiness:

```console
$ go test ./pkg/services/ngalert/schedule/ -run 'TestProcessTicks' -v -count=1
```
```
--- PASS: TestProcessTicks (1.01s)
    --- PASS: TestProcessTicks/on_1st_tick_alert_rule_should_be_evaluated (0.00s)
    --- PASS: TestProcessTicks/on_3rd_tick_two_alert_rules_should_be_evaluated (0.50s)
    --- PASS: TestProcessTicks/on_4th_tick_only_one_alert_rule_should_be_evaluated (0.00s)
    --- PASS: TestProcessTicks/on_8th_tick_deleted_rule_should_not_be_evaluated_but_stopped (0.00s)
    --- PASS: TestProcessTicks/scheduled_rules_should_be_sorted (0.00s)
ok  	github.com/grafana/grafana/pkg/services/ngalert/schedule	1.047s
```

### 2.8 Stability & scale

- **Scale:** 40 rules @ 10s interval, 1s tick, 25s slow data source, ~14 min.
- **Reproducibility:** the drop behavior reproduced continuously (`04:23`→`04:28`, >5 min, counter climbing)
  in run #1, and again in run #2 (see §5). The `behind_seconds` rise-and-recover pattern and the drop WARN
  + counter pairing appeared in both stress runs.


---

## 3. User Question 2 — cancellation vs. removal

### 3.1 Direct answer

There are **three distinct termination paths**, and they leave three distinct footprints:

| Path | Is state left behind? | The runtime "tell" |
|------|----------------------|--------------------|
| **Rule deletion** | **No** — state is cleaned up and resolved notifications are sent | `Resetting state of the rule` + `Rules state was reset` (via `DeleteStateByRuleUID(...StateReasonRuleDeleted)`), a resolved notification to the sender, then `Stopping alert rule routine` |
| **Mid-flight evaluation cancellation** | **Nothing new is written** — the state write for that tick is cleanly skipped; the prior state is untouched | `Skip updating the state because the context has been cancelled` (DEBUG) *or* `Skip evaluation and updating the state because the context has been cancelled` (ERROR), and **no** state write for that tick |
| **Rule restart / scheduler shutdown** | **Yes** — state is deliberately left in place | `Stopping alert rule routine` **with no** preceding `Rules state was reset`; state survives on disk / across restart |

The mechanism that distinguishes them is the **cancellation cause**. Each rule's context is built with
`util.WithCancelCause` (`alert_rule.go:158`), and the routine's shutdown branch checks the cause with
`errors.Is` (`alert_rule.go:349`). The two sentinel causes are `errRuleDeleted = errors.New("rule deleted")`
(`registry.go:19`) and `errRuleRestarted = errors.New("rule restarted")` (`registry.go:20`). Only the
`errRuleDeleted` cause triggers state cleanup.

The shutdown branch (unedited, `alert_rule.go:347-359`):

```go
case <-grafanaCtx.Done():
    // clean up the state only if the reason for stopping the evaluation loop is that the rule was deleted
    if errors.Is(grafanaCtx.Err(), errRuleDeleted) {
        // We do not want a context to be unbounded which could potentially cause a go routine running
        // indefinitely. 1 minute is an almost randomly chosen timeout, big enough to cover the majority of the
        // cases.
        ctx, cancelFunc := context.WithTimeout(context.Background(), time.Minute)
        defer cancelFunc()
        states := a.stateManager.DeleteStateByRuleUID(ngmodels.WithRuleKey(ctx, a.key.AlertRuleKey), a.key, ngmodels.StateReasonRuleDeleted)
        a.expireAndSend(grafanaCtx, states)
    }
    a.logger.Debug("Stopping alert rule routine")
    return nil
```

`DeleteStateByRuleUID` (`alert_rule.go:355`) and `expireAndSend` (`alert_rule.go:356`) run **only** inside
the `errRuleDeleted` branch. `Stopping alert rule routine` (`alert_rule.go:358`) runs on **every** path.

### 3.2 Path 1 — rule DELETION (state cleaned up, resolved notification sent)

**Method.** With the stress server backed up (40 rules evaluating slowly), `slowrule040` was deleted
mid-evaluation via `DELETE /api/v1/provisioning/alert-rules/slowrule040`.

**BEFORE** (state present):

```console
$ curl -s -u admin:admin http://127.0.0.1:3000/metrics | grep 'grafana_alerting_alerts{state="alerting"}'
grafana_alerting_alerts{state="alerting"} 40
```

**DURING/AFTER — the captured footprint**, in order (unedited):

```console
$ grep 'slowrule040' /tmp/obs/captures/server.stress.log | tail -5
```
```
logger=ngalert.scheduler rule_uid=slowrule040 org_id=1 version=2 fingerprint=eed55dad89eca2d6 now=2026-07-08T04:32:51Z t=2026-07-08T04:33:10.005827391Z level=debug msg="Skip updating the state because the context has been cancelled"
logger=ngalert.state.manager rule_uid=slowrule040 org_id=1 t=2026-07-08T04:33:10.005899705Z level=debug msg="Resetting state of the rule"
logger=ngalert.state.manager rule_uid=slowrule040 org_id=1 t=2026-07-08T04:33:10.006121145Z level=info msg="Rules state was reset" states=1
logger=ngalert.sender.router rule_uid=slowrule040 org_id=1 t=2026-07-08T04:33:10.006155392Z level=info msg="Sending alerts to local notifier" count=1
logger=ngalert.scheduler rule_uid=slowrule040 org_id=1 t=2026-07-08T04:33:10.006225003Z level=debug msg="Stopping alert rule routine"
```

Reading the trace top to bottom:

1. **`Skip updating the state because the context has been cancelled`** — the in-flight evaluation
   (`now=04:32:51`) is abandoned; its write is skipped (this is the post-eval cancel guard,
   `alert_rule.go:393`).
2. **`Resetting state of the rule`** (state manager) then **`Rules state was reset` `states=1`** — this is
   `DeleteStateByRuleUID(...StateReasonRuleDeleted)` (`alert_rule.go:355`) removing the rule's one state.
3. **`Sending alerts to local notifier` `count=1`** (from the `ngalert.sender.router` logger) — this is
   `expireAndSend` (`alert_rule.go:356`) pushing the **resolved** notification.
4. **`Stopping alert rule routine`** (`alert_rule.go:358`) — the goroutine exits.

**AFTER** (state gone, rule gone):

```console
$ curl -s -u admin:admin http://127.0.0.1:3000/metrics | grep 'grafana_alerting_alerts{state="alerting"}'
grafana_alerting_alerts{state="alerting"} 39
$ curl -s -o /dev/null -w '%{http_code}\n' -u admin:admin \
    http://127.0.0.1:3000/api/v1/provisioning/alert-rules/slowrule040
404
```

The alerting count dropped 40 → 39 and the rule now returns HTTP 404 — nothing left behind.

**Deterministic corroboration** (fake-clock harness): the real routine, stopped with the `errRuleDeleted`
cause, empties the rule's state:

```console
$ go test ./pkg/services/ngalert/schedule/ \
    -run 'TestRuleRoutine/should_exit/and_clean_up_the_state_if_delete_is_cancellation_reason_for_inner_context' -v -count=1
```
```
--- PASS: TestRuleRoutine/should_exit/and_clean_up_the_state_if_delete_is_cancellation_reason_for_inner_context
```

(The assertion is `require.Empty(t, ..GetStatesForRuleUID(...))` after `Stop(errRuleDeleted)`,
`alert_rule_test.go:510`.)

### 3.3 Path 2 — mid-flight evaluation CANCELLATION (state write skipped)

When a rule's context is cancelled **while an evaluation is in flight**, the routine skips the state write
entirely. There are two guards, at different log levels:

- **Pre-eval guard (ERROR)** — checked before evaluating (unedited, `alert_rule.go:320-324`):

  ```go
  // Check before any execution if the context was cancelled so that we don't do any evaluations.
  if tracingCtx.Err() != nil {
      span.SetStatus(codes.Error, "rule evaluation cancelled")
      span.End()
      logger.Error("Skip evaluation and updating the state because the context has been cancelled", "version", ctx.rule.Version, "fingerprint", f, "attempt", attempt, "now", ctx.scheduledAt)
      return
  }
  ```

- **Post-eval guard (DEBUG)** — checked after a long evaluation returns, before persisting (unedited,
  `alert_rule.go:390-394`):

  ```go
  if ctx.Err() != nil { // check if the context is not cancelled. The evaluation can be a long-running task.
      span.SetStatus(codes.Error, "rule evaluation cancelled")
      logger.Debug("Skip updating the state because the context has been cancelled")
      return nil
  }
  ```

The **post-eval DEBUG guard was captured live** — it is the first line of the deletion trace in §3.2
(`slowrule040`, `04:33:10`, message `"Skip updating the state because the context has been cancelled"`,
`alert_rule.go:393`). Because the routine `return`s before writing, **no state update is persisted for that
tick** — the prior state is left untouched and nothing new is added.

**This is distinct from an evaluation TIMEOUT.** A timeout is *not* a cancellation-guard skip — a
timed-out evaluation returns an **error result that IS written** as an `Error`-state evaluation. Captured
with the slow data source exceeding the 30s `evaluation_timeout` (`setting_unified_alerting.go:49`,
config key `evaluation_timeout` at `:309`):

```console
$ grep 'context deadline exceeded' /tmp/obs/captures/server.stress.log | head -1
```
```
logger=ngalert.scheduler rule_uid=slowrule023 org_id=1 version=2 fingerprint=f38f03fb98c9b9cf now=2026-07-08T04:34:21Z t=2026-07-08T04:35:24.567125142Z level=debug msg="Alert rule evaluated" error="[sse.dataQueryError] failed to execute query [A]: Post \"http://127.0.0.1:9790/api/v1/query\": context deadline exceeded" duration=30.001533756s
```

Note `duration=30.001533756s` (≈ the 30s evaluation timeout) and `msg="Alert rule evaluated"` with an
`error=...` — the evaluation *completed with an error* and produces a written result, whereas a
cancellation *skips the write*. Same-looking slowness, different footprint.

### 3.4 Path 3 — rule RESTART / scheduler SHUTDOWN (state left in place)

On shutdown, the parent context is cancelled with a cause that is **not** `errRuleDeleted`, so the cleanup
branch at `alert_rule.go:349` is **not** taken and `DeleteStateByRuleUID` is never called. (Restart uses
the analogous cause `errRuleRestarted`, `registry.go:20`, applied at `oldRoutine.Stop(errRuleRestarted)`,
`schedule.go:387`.)

**Method.** `SIGINT` was sent to the stress server.

**BEFORE** (39 alerting after the Path-1 deletion):

```console
$ curl -s -u admin:admin http://127.0.0.1:3000/metrics | grep 'grafana_alerting_alerts{state="alerting"}'
grafana_alerting_alerts{state="alerting"} 39
```

**DURING — captured footprint:** 39 × `Stopping alert rule routine` and **zero** `Rules state was reset`:

```console
$ grep -c 'Stopping alert rule routine' /tmp/obs/captures/server.stress.log
40
$ grep -c 'Rules state was reset' /tmp/obs/captures/server.stress.log
1
```

(40 total "Stopping" lines across the whole run = 39 at shutdown + 1 at the Path-1 deletion; and exactly
**1** "Rules state was reset" — the single deletion in §3.2. Every shutdown stop had **no** accompanying
state reset.) A sample of the shutdown stops (unedited):

```console
$ grep 'Stopping alert rule routine' /tmp/obs/captures/server.stress.log | tail -3
```
```
logger=ngalert.scheduler rule_uid=slowrule012 org_id=1 t=2026-07-08T04:38:14.172303499Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule002 org_id=1 t=2026-07-08T04:38:14.172463361Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule004 org_id=1 t=2026-07-08T04:38:14.172734759Z level=debug msg="Stopping alert rule routine"
```

**AFTER — state survived on disk.** The alert instances were still persisted in the scratch SQLite DB
after the process exited (read with Python's `sqlite3`, since the `sqlite3` CLI is not installed):

```console
$ python3 -c "import sqlite3; c=sqlite3.connect('/tmp/obs/data-stress/grafana.db'); \
    print(c.execute('select count(*) from alert_instance').fetchone()[0]); \
    [print(r) for r in c.execute(\"select rule_uid,current_state from alert_instance order by rule_uid limit 3\")]"
```
```
39
('slowrule001', 'Alerting')
('slowrule002', 'Alerting')
('slowrule003', 'Alerting')
```

39 rows, all `Alerting` — state was **left in place** across shutdown, exactly as the code intends.

**Independent live confirmation:** when the stress server was restarted (run #2), it booted with
`grafana_alerting_alerts{state="alerting"} 39` immediately — it reloaded the 39 rows that shutdown had left
behind (see §5). This is the reload side of "state is left in place."

**Deterministic corroboration** (fake-clock harness): stopping the real routine via the parent context
(not `errRuleDeleted`) **preserves** the rule's state:

```console
$ go test ./pkg/services/ngalert/schedule/ \
    -run 'TestRuleRoutine/should_exit/and_not_clear_the_state_if_parent_context_is_cancelled' -v -count=1
```
```
--- PASS: TestRuleRoutine/should_exit/and_not_clear_the_state_if_parent_context_is_cancelled
```

(The assertion is `require.Equal(t, len(expectedStates), len(..GetStatesForRuleUID(...)))` after the parent
context is cancelled, `alert_rule_test.go:488` — state count unchanged.)

> **Honest note on the restart demo.** Triggering a restart via a *live rule update* (e.g. changing the
> interval) is a noisy way to demonstrate "state left in place", because the update path resets state on a
> *fingerprint change* (alerting count briefly dipped to 0 and returned to 39 in that experiment). The
> clean proofs of "restart/shutdown leaves state" are therefore (a) the SIGINT shutdown with 39 rows
> persisted on disk and reloaded on next boot, and (b) the deterministic `parent context is cancelled`
> test above.

### 3.5 Before/during/after summary (transitional coverage)

| Path | Before | During | After |
|------|--------|--------|-------|
| Deletion | `alerts{alerting}=40`, rule present | skip-write → `Rules state was reset states=1` → resolved notification → `Stopping alert rule routine` | `alerts{alerting}=39`, rule → HTTP 404 |
| Cancellation (mid-flight) | prior state present | `Skip updating the state because the context has been cancelled` (DEBUG, `alert_rule.go:393`) | no new state write for that tick; prior state intact |
| Restart / shutdown | `alerts{alerting}=39` | 39 × `Stopping alert rule routine`, 0 × `Rules state was reset` | 39 rows persisted on disk (all `Alerting`), reloaded on next boot |

### 3.6 Stability

Each footprint reproduced across ≥2 runs: the deletion footprint (skip-write → reset → notify → stop) was
observed in the stress runs; the shutdown-leaves-state footprint was observed both on disk (run #1) and via
reload (run #2); and both deterministic tests pass repeatably (`-count=1` shown; re-runs also pass).


---

## 4. User Question 3 — ordering preservation (negative result)

### 4.1 Direct answer

**No — per-rule evaluation results never appear out of order.** Across the entire stressed window (and the
normal window), evaluation results for any given rule are produced in strictly non-decreasing
`scheduledAt` order. Lag never causes a *reordering*; it causes a **drop of the older pending tick**. Only
the newest tick survives when a rule's goroutine is busy, so the sequence can *skip* values but can never
*invert* them.

### 4.2 Why — one goroutine + one unbuffered channel per rule

Each rule is served by a single long-lived goroutine that consumes an **unbuffered** channel. The channel
is created with no capacity (unedited, `alert_rule.go:161`):

```go
evalCh:               make(chan *Evaluation),
```

`make(chan *Evaluation)` with no second argument is unbuffered — a send blocks until the single consumer
receives. The consumer is the rule routine's loop (unedited, `alert_rule.go:262-269`):

```go
// evalCh - used by the scheduler to signal that evaluation is needed.
case ctx, ok := <-a.evalCh:
    if !ok {
        a.logger.Debug("Evaluation channel has been closed. Exiting")
        return nil
    }
    f := ctx.Fingerprint()
    logger := a.logger.New("version", ctx.rule.Version, "fingerprint", f, "now", ctx.scheduledAt)
    logger.Debug("Processing tick")
```

One consumer + an unbuffered channel ⇒ evaluations for a rule happen strictly one-at-a-time, in the order
they are accepted. There is no queue that could be reordered.

### 4.3 Why — drop-newest-wins backpressure in `Eval()`

When the scheduler dispatches a tick, it calls `Eval()` (unedited and complete, `alert_rule.go:196-215`):

```go
func (a *alertRule) Eval(eval *Evaluation) (bool, *Evaluation) {
    if a.key != eval.rule.GetKeyWithGroup() {
        // Make sure that rule has the same key. This should not happen
        a.logger.Error("Invalid rule sent for evaluating. Skipping", "ruleKeyToEvaluate", eval.rule.GetKey().String())
        return false, eval
    }
    // read the channel in unblocking manner to make sure that there is no concurrent send operation.
    var droppedMsg *Evaluation
    select {
    case droppedMsg = <-a.evalCh:
    default:
    }

    select {
    case a.evalCh <- eval:
        return true, droppedMsg
    case <-a.ctx.Done():
        return false, droppedMsg
    }
}
```

Step by step:

1. **Key guard** (`:197-201`) — a mismatched rule key is rejected (defensive; "should not happen").
2. **Non-blocking drain** (`:204-207`) — `select { case droppedMsg = <-a.evalCh: default: }`. If a *previous*
   tick is still sitting unconsumed in the channel (the routine hasn't picked it up yet), it is pulled out
   and remembered as `droppedMsg`. If nothing is waiting, `default` runs and `droppedMsg` stays nil. This
   is the step that discards the **older** pending tick.
3. **Send** (`:209-214`) — `select { case a.evalCh <- eval: return true, droppedMsg; case <-a.ctx.Done(): return false, droppedMsg }`.
   The **newer** tick is sent (or, if the rule is shutting down, the send is abandoned and `false` is
   returned — this is the `Scheduled evaluation was canceled...` DEBUG at `schedule.go:374`).

So the *newest* `scheduledAt` always wins, the *older* one is returned as `dropped` (and reported by the
scheduler as the "Tick dropped..." WARN, §2.5). The channel never holds more than one item, and that item
is always the latest — hence no inversion is possible.

### 4.4 Observed proof — interleaved per-rule sequence

A single rule's interleaved `Processing tick` / `Tick processed` / `Tick dropped` trace shows the
invariant directly. For `slowrule007` (unedited):

```console
$ grep 'slowrule007' /tmp/obs/captures/server.stress.log | grep -E 'Processing tick|Tick processed|Tick dropped' | head -12
```
```
logger=ngalert.scheduler rule_uid=slowrule007 org_id=1 version=2 fingerprint=180c1f80d846e51b now=2026-07-08T04:23:11Z t=2026-07-08T04:23:11.587707986Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule007 org_id=1 version=2 fingerprint=180c1f80d846e51b now=2026-07-08T04:23:11Z t=2026-07-08T04:23:39.081189329Z level=debug msg="Tick processed" attempt=1 duration=27.493395044s
logger=ngalert.scheduler rule_uid=slowrule007 org_id=1 version=2 fingerprint=180c1f80d846e51b now=2026-07-08T04:23:31Z t=2026-07-08T04:23:39.081233588Z level=debug msg="Processing tick"
logger=ngalert.scheduler t=2026-07-08T04:23:39.081366645Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=slowrule007 org_id=1 time=2026-07-08T04:23:31Z droppedTick=2026-07-08T04:23:21Z
logger=ngalert.scheduler t=2026-07-08T04:24:02.833314523Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=slowrule007 org_id=1 time=2026-07-08T04:23:51Z droppedTick=2026-07-08T04:23:41Z
logger=ngalert.scheduler rule_uid=slowrule007 org_id=1 version=2 fingerprint=180c1f80d846e51b now=2026-07-08T04:23:31Z t=2026-07-08T04:24:06.225600592Z level=debug msg="Tick processed" attempt=1 duration=27.144336549s
logger=ngalert.scheduler rule_uid=slowrule007 org_id=1 version=2 fingerprint=180c1f80d846e51b now=2026-07-08T04:24:01Z t=2026-07-08T04:24:06.225654986Z level=debug msg="Processing tick"
logger=ngalert.scheduler t=2026-07-08T04:24:06.225762872Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=slowrule007 org_id=1 time=2026-07-08T04:24:01Z droppedTick=2026-07-08T04:23:51Z
logger=ngalert.scheduler t=2026-07-08T04:24:31.153313144Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=slowrule007 org_id=1 time=2026-07-08T04:24:21Z droppedTick=2026-07-08T04:24:11Z
logger=ngalert.scheduler rule_uid=slowrule007 org_id=1 version=2 fingerprint=180c1f80d846e51b now=2026-07-08T04:24:01Z t=2026-07-08T04:24:31.451410368Z level=debug msg="Tick processed" attempt=1 duration=25.225730674s
logger=ngalert.scheduler rule_uid=slowrule007 org_id=1 version=2 fingerprint=180c1f80d846e51b now=2026-07-08T04:24:31Z t=2026-07-08T04:24:31.451431741Z level=debug msg="Processing tick"
logger=ngalert.scheduler t=2026-07-08T04:24:31.451491668Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=slowrule007 org_id=1 time=2026-07-08T04:24:31Z droppedTick=2026-07-08T04:24:21Z
```

Two things to read out of this:

- The **processed `scheduledAt` (`now=`) values strictly increase**: `04:23:11` → `04:23:31` → `04:24:01`
  → `04:24:31`. Never a decrease.
- Every **`droppedTick` is older than the surviving `time`**: `droppedTick=04:23:21 < time=04:23:31`;
  `droppedTick=04:23:41 < time=04:23:51`; `droppedTick=04:23:51 < time=04:24:01`;
  `droppedTick=04:24:11 < time=04:24:21`. The system discards the *older* pending tick, exactly as the
  drain step in `Eval()` (`alert_rule.go:204-207`) dictates.

### 4.5 Observed proof — no inversions across the whole run

An automated scan of every rule's `Processing tick` sequence over the full stress log confirms **zero**
`scheduledAt` inversions:

```console
$ python3 - <<'PY'
import re
last={}; inv=0; n=0
pat=re.compile(r'rule_uid=(\S+).*now=(\S+Z).*Processing tick')
for line in open('/tmp/obs/captures/server.stress.log'):
    m=pat.search(line)
    if not m: continue
    uid,now=m.group(1),m.group(2); n+=1
    if uid in last and now < last[uid]: inv+=1
    last[uid]=now
print("processing-tick events:", n, " inversions:", inv, " rules:", len(last))
PY
```
```
processing-tick events: 1179  inversions: 0  rules: 40
```

The same scan on the second stress run and the normal run also returned **0** inversions (351 events and
1694 events respectively — see §5). The negative result is stable across all three runs.

### 4.6 Deterministic corroboration — the drop unit test

The in-repo test that asserts drop-newest-wins passes on the real `Eval()`:

```console
$ go test ./pkg/services/ngalert/schedule/ \
    -run 'TestAlertRule/when_rule_evaluation_is_not_stopped/eval_should_drop_any_concurrent_sending_to_evalCh' -v -count=1
```
```
=== RUN   TestAlertRule
=== RUN   TestAlertRule/when_rule_evaluation_is_not_stopped
=== RUN   TestAlertRule/when_rule_evaluation_is_not_stopped/eval_should_drop_any_concurrent_sending_to_evalCh
--- PASS: TestAlertRule (0.00s)
    --- PASS: TestAlertRule/when_rule_evaluation_is_not_stopped (0.00s)
        --- PASS: TestAlertRule/when_rule_evaluation_is_not_stopped/eval_should_drop_any_concurrent_sending_to_evalCh (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/schedule	0.040s
```

The test (`alert_rule_test.go:104`) sends two evaluations with times `time1` (`:107`) and `time2` (`:108`)
concurrently, then asserts the channel holds the **newer** `time2`
(`require.Equal(t, time2, ...scheduledAt)`, `:139`), that the first send reported no drop (`:142`), and
that the second send reported the **older** `time1` as the dropped evaluation (`:145-146`). This is exactly
the drop-newest-wins behavior observed live in §4.4.

### 4.7 Stability

- **Scale:** 40 rules @ 10s, 1s tick, 25s slow data source, ~14 min (run #1); 39 rules (run #2); 39 rules
  @ 10s tick fast (normal).
- **Result:** 0 inversions in all three runs (1179 / 351 / 1694 processing-tick events). The negative
  answer is not a fluke of one run — it is a structural property of the one-goroutine + unbuffered-channel
  + drop-newest-wins design, and it held every time.


---

## 5. Stressed-vs-normal comparison

The identical scenario was run once under **stress** (1s tick via the `configurableSchedulerTick` toggle,
40→39 rules, a 25s slow data source that times out at 30s) and once under **normal** load (default 10s
tick, 39 rules, a fast `up` data source ≈ 8 ms). The two configs are shown verbatim in §1.4. This section
quantifies the visible deltas.

### 5.1 Side-by-side table (measured values)

| Dimension | STRESS | NORMAL | Source |
|-----------|--------|--------|--------|
| Tick interval | **1s** (WARN `Scheduler tick interval is changed to non-default interval=1s default=10s`) | **10s** default (no such WARN; `Starting scheduler tickInterval=10s`) | `setting_unified_alerting.go:341` / `:62` |
| Heartbeat cadence (`Alert rules fetched` `t=`) | **~1s apart**: `04:18:01 → :02 → :03 → :04 → :05 → :06` | **~10s apart**: `04:46:20 → :30 → :40` | scheduler loop |
| `Tick processed` count (completed evals) | 1179 | 1694 | log `grep -c` |
| `Tick processed` duration | **25–30 s** (e.g. `27.493395044s`, `27.144336549s`, `25.225730674s`) | **8–9 ms** (e.g. `9.319819ms`, `9.075453ms`, `8.468303ms`) | `alert_rule.go:332` |
| `grafana_alerting_scheduler_behind_seconds` | intermittent spikes to **4.117433157** (peak `5.082527387` earlier) | max **0.000854861** over 30 dense samples (never spikes) | `schedule.go:215` / `metrics/scheduler.go:43` |
| `Tick dropped...` WARN count | **2273** total (978 at a mid-run snapshot) | **0** | `schedule.go:378` |
| `grafana_alerting_schedule_rule_evaluations_missed_total` (Σ) | **978** at the snapshot (= WARN count), climbing | **0** (counter absent) | `schedule.go:380` / `metrics/scheduler.go:181` |
| `grafana_alerting_schedule_alert_rules` | 40 → 39 | 39 | `schedule/metrics.go:115` |
| `grafana_alerting_schedule_alert_rules_hash` | `2.6274620658384855e+18` | `1.2404274300092422e+19` | `schedule/metrics.go:116` |
| Ordering inversions | **0** (1179 events) | **0** (1694 events) | §4.5 scan |

Commands used for the comparison values (representative):

```console
# heartbeat cadence
$ grep 'Alert rules fetched' /tmp/obs/captures/server.stress.log | head -6 | grep -oE 't=[0-9T:.-]+Z'
$ grep 'Alert rules fetched' /tmp/obs/captures/server.normal.log | head -3 | grep -oE 't=[0-9T:.-]+Z'

# tick-processed counts and durations
$ grep -c 'Tick processed' /tmp/obs/captures/server.stress.log      # 1179
$ grep -c 'Tick processed' /tmp/obs/captures/server.normal.log      # 1694
$ grep 'Tick processed' /tmp/obs/captures/server.normal.log | head -3 | grep -oE 'duration=[^ ]+'

# drops (normal run)
$ grep -c 'Tick dropped because alert rule evaluation is too slow' /tmp/obs/captures/server.normal.log   # 0

# live normal-run gauges
$ curl -s -u admin:admin http://127.0.0.1:3001/metrics | grep -E '^grafana_alerting_(schedule_alert_rules|scheduler_behind_seconds) '
grafana_alerting_schedule_alert_rules 39
grafana_alerting_scheduler_behind_seconds 5.7814e-05
```

### 5.2 What visibly changes (rhythm narrative)

- **Volume.** Under stress, the dominant output is the drop WARN — 2273 of them, one per displaced tick —
  against 1179 completed evaluations. Under normal load there are **zero** drops and 1694 completed
  evaluations; the log is all `Processing tick` / `Tick processed` pairs.
- **Per-evaluation timing.** The single most dramatic delta: a completed evaluation takes **25–30 seconds**
  under stress (the data source sleeps 25s and often hits the 30s timeout) versus **8–9 milliseconds**
  under normal load — roughly a **3000×** difference. This is what causes the routine to still be busy when
  the next tick arrives, which is what produces the drops.
- **Heartbeat rhythm.** Under stress the heartbeat fires every second (`04:18:01`…`:06`, one per line);
  under normal load it fires every ten seconds (`04:46:20`, `:30`, `:40`). The stress log is visibly
  "bunched" — 40 `Processing tick` lines ~25 ms apart at the top of each second — whereas the normal log is
  calm and evenly spaced.
- **Pauses / recovery.** Under stress, `scheduler_behind_seconds` rises in bursts (up to ~4–5 s) when many
  rules become ready simultaneously and their dispatch delays the next heartbeat, then recovers toward
  ~0.0001 s as the backlog drains — the "pause as it slows, recovery as it drains" the question describes.
  Under normal load the gauge sits at ~0.00005–0.0009 s and never spikes.

### 5.3 Honest nuance on `behind_seconds`

`scheduler_behind_seconds` measures **heartbeat-loop lag** (`start.Sub(tick)`, `schedule.go:214-215`), not
per-rule backpressure. It spikes **intermittently** under stress — specifically at moments when a large set
of rules is simultaneously ready and their dispatch/eval work briefly delays the loop. In the second stress
run, because rule readiness was staggered by jitter, the loop itself was rarely delayed and `behind_seconds`
stayed near `0.001` even though drops were plentiful. Therefore the **consistent, always-present**
backpressure signal across both stress runs is the **drop WARN + `..._missed_total` counter** pairing (§2.5),
while `behind_seconds` is the **first** signal but a **spiky** one. Both are reported honestly above.

### 5.4 Two-run stability

| Value | Stress run #1 | Stress run #2 | Stable? |
|-------|---------------|---------------|---------|
| Drops occur, WARN == counter | 978 == 978 (snapshot); 2273 total | 234 == 234, then 390 == 390 | ✅ drops always present; WARN==counter every time |
| Ordering inversions | 0 (1179 events) | 0 (351 events) | ✅ always 0 |
| `behind_seconds` | spikes 4.68 / 5.08 / 4.12 s | ~0.001 (jitter-staggered) | ⚠️ spiky/intermittent (see §5.3) |
| State left on shutdown | 39 rows on disk | reloaded 39 on boot | ✅ confirmed both ways |

The magnitude values reported as answers (drops present with WARN==counter; 0 inversions; slow-vs-fast
`Tick processed` durations; 1s-vs-10s cadence) were confirmed stable across at least two runs at the stated
scale. The one value that is *not* stable run-to-run — the `behind_seconds` peak — is reported as spiky,
not as a fixed magnitude, per its true observed behavior.


---

## 6. Reasoning / mechanism appendix

### 6.1 Each observation tied to the code path that produces it

| Observation | Mechanism (function / struct) | `file:line` |
|-------------|-------------------------------|-------------|
| A rule is "ready" this tick | `processTick` computes `isReadyToRun = IntervalSeconds!=0 && (tickNum%itemFrequency)-offset==0` | `schedule.go:316` |
| Jitter offset (spreads rules within interval) | `jitterOffsetInTicks`; default strategy `JitterByGroup` | `jitter.go:39`, `:24` |
| `Rule is ready to run on the current tick` DEBUG | `logger.Debug(...)` in `processTick` | `schedule.go:329` |
| Ready set dispatched in UID order | `slices.SortFunc(readyToRun, ... strings.Compare(a.rule.UID, b.rule.UID))` | `schedule.go:364-366` |
| Dispatch spread across interval | `step = baseInterval/len(readyToRun)`; `time.AfterFunc(i*step, ...)` | `schedule.go:361`, `:370` |
| `Processing tick` / `Tick processed` DEBUG (per rule) | rule routine consuming `evalCh` | `alert_rule.go:269`, `:332` |
| "Falling behind" first visible | `BehindSeconds.Set(start.Sub(tick))` at top of `schedulePeriodic`, before `processTick` | `schedule.go:214-215` |
| Gauge name `grafana_alerting_scheduler_behind_seconds` | `Name: "scheduler_behind_seconds"` under `grafana`/`alerting` | `metrics/scheduler.go:43`, `metrics/ngalert.go:10-11` |
| `Tick dropped because alert rule evaluation is too slow` WARN | `sch.log.Warn(...)` when `Eval` returns non-nil `dropped` | `schedule.go:378` |
| `..._schedule_rule_evaluations_missed_total{org,name}` increment | `EvaluationMissed.WithLabelValues(orgID, item.rule.Title).Inc()` | `schedule.go:380`, `metrics/scheduler.go:181` |
| Ticker never drops ticks | `New(...)` doc comment | `ticker/ticker.go:26` |
| One goroutine + unbuffered channel per rule | `evalCh: make(chan *Evaluation)` (no capacity) | `alert_rule.go:161` |
| Drop-newest-wins backpressure | `Eval()` non-blocking drain (`:204-207`) then send (`:209-214`) | `alert_rule.go:196-215` |
| Cancellation cause carried on rule context | `util.WithCancelCause(...)` | `alert_rule.go:158` |
| Deletion cause / restart cause | `errRuleDeleted` / `errRuleRestarted` | `registry.go:19`, `:20` |
| Deletion cleans up state + resolves | `errors.Is(err, errRuleDeleted)` → `DeleteStateByRuleUID(...StateReasonRuleDeleted)` → `expireAndSend` | `alert_rule.go:349`, `:355`, `:356` |
| Mid-flight cancel skips the write | pre-eval guard (ERROR) `:323`; post-eval guard (DEBUG) `:393` | `alert_rule.go:320-324`, `:390-394` |
| `Stopping alert rule routine` on every stop | `a.logger.Debug(...)` after the cause check | `alert_rule.go:358` |
| Restart stops old routine with restart cause | `oldRoutine.Stop(errRuleRestarted)` | `schedule.go:387` |
| Schedulable-rules gauge + hash per tick | `SchedulableAlertRules.Set` / `SchedulableAlertRulesHash.Set` | `schedule/metrics.go:115-116` |
| Tick interval gated by feature toggle | `if cfg.IsFeatureToggleEnabled("configurableSchedulerTick")` | `setting_unified_alerting.go:336` |
| Defaults (timeout 30s / attempts 3 / base 10s / eval 60s) | package constants | `setting_unified_alerting.go:49,52,62,64` |
| Scheduler wiring / logger name | `SchedulerCfg{...Log: log.New("ngalert.scheduler")}` → `NewScheduler` | `ngalert.go:376,390,424` |

### 6.2 Anchor reference table (every `file:line` cited above)

- **`pkg/services/ngalert/schedule/schedule.go`** — `deleteAlertRule` def `183` (called `395`);
  `schedulePeriodic` `205`; `start := time.Now().Round(0)` `214`; `BehindSeconds.Set` `215`;
  `readyToRunItem` `228`; `processTick` `235`; `tickNum` `236`; `itemFrequency` `314`; `offset` `315`;
  `isReadyToRun` `316`; readiness DEBUG `329`; `step` `359`/`361`; UID sort `364-366`; `time.AfterFunc`
  `370`; `Eval` call `372`; canceled DEBUG `374`; drop WARN `378`; `EvaluationMissed…Inc()` `380`;
  `oldRoutine.Stop(errRuleRestarted)` `387`.
- **`pkg/services/ngalert/schedule/alert_rule.go`** — `util.WithCancelCause` `158`; unbuffered `evalCh`
  `161`; `Eval()` `196-215` (drain `204-207`, send `209-214`); consume `262`; `Processing tick` `269`;
  pre-eval guard (ERROR) `320-324` (msg `323`); `Tick processed` `332`; `<-grafanaCtx.Done()` `347`;
  `errors.Is(...errRuleDeleted)` `349`; `DeleteStateByRuleUID(...StateReasonRuleDeleted)` `355`;
  `expireAndSend` `356`; `Stopping alert rule routine` `358`; post-eval guard (DEBUG) `390-394` (msg `393`).
- **`pkg/services/ngalert/schedule/registry.go`** — `errRuleDeleted` `19`; `errRuleRestarted` `20`.
- **`pkg/services/ngalert/schedule/metrics.go`** — `SchedulableAlertRules.Set` `115`;
  `SchedulableAlertRulesHash.Set` `116`.
- **`pkg/services/ngalert/schedule/jitter.go`** — `JitterByGroup` `18`; `JitterStrategyFrom` default `24`;
  `jitterOffsetInTicks` `39`.
- **`pkg/services/ngalert/metrics/scheduler.go`** — `scheduler_behind_seconds` `43`;
  `rule_evaluations_total` `52`; `schedule_alert_rules` `156`; `schedule_alert_rules_hash` `164`;
  `schedule_rule_evaluations_missed_total` (labels `org,name`) `181`/`184`.
- **`pkg/services/ngalert/metrics/ngalert.go`** — `Namespace = "grafana"` `10`; `Subsystem = "alerting"`
  `11`.
- **`pkg/util/ticker/ticker.go`** — "never drops ticks" `26`. **`pkg/util/ticker/metrics.go`** —
  `ticker_last_consumed_tick_timestamp_seconds` `19`; `ticker_next_tick_timestamp_seconds` `25`;
  `ticker_interval_seconds` `31`.
- **`pkg/setting/setting_unified_alerting.go`** — `evaluatorDefaultEvaluationTimeout = 30s` `49`;
  `schedulerDefaultMaxAttempts = 3` `52`; `SchedulerBaseInterval = 10s` `62`;
  `DefaultRuleEvaluationInterval == 60s` `64`; `evaluation_timeout` key `309`; `scheduler_tick_interval`
  parse `335`; `configurableSchedulerTick` gate `336`; WARN (took effect) `341`; WARN (toggle off) `345`.
- **`pkg/services/ngalert/ngalert.go`** — `SchedulerCfg{` `376`; `Log: log.New("ngalert.scheduler")` `390`;
  `NewScheduler(schedCfg, stateManager)` `424`.
- **`go.mod`** — `go 1.23.1` `3`. **`Makefile`** — `build-server:` `201`; `go run build.go ... build-server`
  `203`.

> All line numbers were re-verified against the running checkout at HEAD
> `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` with `sed -n`/`grep -n` before citing.

### 6.3 Observed vs. inferred

- **Observed (from captured runtime output):** the WARN that the short tick took effect; the
  `Starting scheduler tickInterval=1s`; the `Rule is ready...` DEBUG with `frequency=10 offset=1`; the
  UID-ordered `Processing tick` lines ~25 ms apart; the `scheduler_behind_seconds` time series and its
  spikes; the `Tick dropped...` WARNs with older `droppedTick`; the labeled `..._missed_total` values; the
  978↔978 WARN/counter snapshot; the deletion footprint (skip-write → reset → resolved notification → stop)
  and the 40→39 / HTTP-404 transition; the 39 persisted `Alerting` rows after shutdown and the reload on
  next boot; the 0-inversion scans (1179/351/1694 events); the slow-vs-fast `Tick processed` durations; the
  1s-vs-10s heartbeat cadence; and all four unit-test PASS results.
- **Inferred (from code, labeled as such):** that the WARN (`schedule.go:378`) and the counter `Inc()`
  (`schedule.go:380`) are structurally 1:1 because they sit in the same `if dropped != nil` block — this
  was *also* confirmed observationally by the 978↔978 snapshot. That an unbuffered channel with a single
  consumer *cannot* reorder is a property of the Go memory model / channel semantics; it was *also*
  confirmed observationally by the 0-inversion scans and the drop unit test.
- **No behavior is attributed to vague "environment" causes.** Slow evaluations are caused concretely by
  the 25s sleeper data source exceeding the 30s `evaluation_timeout` (`setting_unified_alerting.go:49`),
  visible as `context deadline exceeded` with `duration≈30s` (§3.3).

### 6.4 Read-only proof & cleanup

All observation was read-only against the source tree. Every temporary artifact — the two scratch
`grafana.ini` files, the scratch SQLite data/logs/plugins/provisioning directories, the slow-data-source
mock (`slowprom.py`), and all captured log/metric files — lived under `/tmp/obs` (outside the repository)
and was deleted after the investigation. The server binaries and generated `wire_gen.go` are git-ignored
build artifacts.

After cleanup, the working tree contains exactly one new file and no tracked-file change:

```console
$ git status --porcelain -uall
?? blitzy/documentation/grafana_4550cfb5b728.md
```

```console
$ git status --porcelain | grep -E '^( M|M | D|D |A |R |C )' | wc -l   # tracked-file modifications/deletions
0
$ git diff --stat -- go.mod go.sum package.json                        # manifests unchanged (empty output)
$ git check-ignore bin/linux-amd64/grafana bin/linux-amd64/grafana-server pkg/server/wire_gen.go
bin/linux-amd64/grafana
bin/linux-amd64/grafana-server
pkg/server/wire_gen.go
$ git rev-parse HEAD
4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff
```

The only change to the repository is this document. `go.mod`, `go.sum`, and `package.json` are untouched,
the build artifacts are git-ignored, and `HEAD` is still the pinned commit — the read-only requirement is
satisfied.

### 6.5 Environment caveat (non-canonical labels)

- The running binary's baked-in version string reports `9.2.0` at `/api/health`, while `git` reports the
  pinned commit `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`. The **commit** is the authoritative identifier
  of the code that ran; the health version string is a build-embedded label and is noted here only to avoid
  confusion. All source citations are against the pinned commit.
- The slow/fast data sources and the short tick interval are **test levers**, not product defaults. The
  canonical defaults (10s tick, 30s eval timeout, 3 attempts, 60s rule interval) are stated in §1.5/§1.7;
  the stress run departs from them **by configuration only** (the `configurableSchedulerTick` toggle plus
  `scheduler_tick_interval = 1s`), which is a supported, documented configuration path — not a code change.

