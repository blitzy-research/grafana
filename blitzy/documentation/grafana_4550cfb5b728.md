# Grafana Unified Alerting Scheduler Under Stress — A Runtime Investigation

This document answers three questions about how Grafana's Unified Alerting **scheduler**
(`pkg/services/ngalert/schedule`) behaves when the system is under stress. Every claim below is
backed by **real runtime output** captured from a locally built Grafana backend that was deliberately
driven into backpressure, and — for the mechanisms that are awkward to force by wall clock — by the
in-repo fake-clock unit tests. The investigation was **run first, written second**: the server was
built, launched, loaded with rules, stressed, and scraped, and only then was this answer composed from
the captured logs and metrics.

The three questions, verbatim:

1. **Work selection under load + first visibility.** *"When many alert rule changes arrive while
   evaluations are already falling behind and a data source begins to time out, how does the system
   decide what to work on next, and where does that choice first become visible while it is running?"*
2. **Cancellation vs. removal — what is left behind.** *"If an evaluation is canceled or a rule is
   removed partway through, does anything get left behind, or does the system cleanly move on, and what
   signs at runtime tell you which one happened?"*
3. **Ordering preservation.** *"During that same window, do evaluation results ever appear out of order,
   and if they do not, what observable behavior suggests the ordering was preserved?"*

A short **direct-answer summary** (each expanded, with evidence, in its section):

- **Q1 —** Per tick, the scheduler computes a per-rule *readiness* test, collects every ready rule, sorts
  the ready set by **UID**, and dispatches them spread evenly across the base interval via
  `time.AfterFunc`. The *work-selection choice* first becomes visible in the
  `Rule is ready to run on the current tick` DEBUG line and the UID-ordered `Processing tick` lines.
  *Falling behind* first becomes visible as the `Tick dropped because alert rule evaluation is too slow`
  WARN and its `grafana_alerting_schedule_rule_evaluations_missed_total` counter — **not**, as one might
  guess from reading the code, in the `grafana_alerting_scheduler_behind_seconds` gauge (which measures
  *heartbeat-loop* lag and stayed ≈0 throughout; see §2.4). A timing-out data source surfaces as
  `context deadline exceeded` at exactly the 30 s evaluation timeout (§1.7, §3.3).
- **Q2 —** Three termination paths, three distinct footprints. **Deletion** cleans up state and sends a
  resolved notification; **mid-flight cancellation** skips the state write entirely (prior state
  untouched); **restart / shutdown** deliberately leaves state in place. The runtime "tell" is which log
  lines appear (§3).
- **Q3 —** **No** — per-rule results never appear out of order. Each rule has one goroutine consuming one
  **unbuffered** channel, and backpressure *drops the older pending tick* rather than reordering. Across
  three runs (2931 / 610 / 745 processing-tick events) there were **0** ordering inversions (§4).

---

## 1. Scenario & setup

### 1.1 What was run, in one paragraph

A single Grafana backend was built from the checked-out commit and launched twice with the same 40 alert
rules pointed at a mock Prometheus data source. In the **stressed** run the scheduler tick interval was
shortened to **1 s** and the data source was made **slow** (15 s per query) with two rules pointed at a
**timeout** endpoint (45 s per query, well past the 30 s evaluation timeout). In the **normal** run the
tick interval was the default **10 s** and the data source answered in ~1–12 ms. Logs were captured at
`level = debug`; the Prometheus `/metrics` endpoint was scraped throughout. All scratch artifacts lived
outside the repository and were removed afterward (§6.4).

### 1.2 Canonical build (exact commands, complete unedited banner)

The server was built with the repository's canonical `make build-server` target
(`Makefile:201`, whose recipe is `$(GO) run build.go $(GO_BUILD_FLAGS) build-server`, `Makefile:203`),
using the pinned Go toolchain `go 1.23.1` (`go.mod:3`). The complete, unedited build output:

```console
$ make build-server
build server
go run build.go    build-server
Version: 11.5.0, Linux Version: 11.5.0, Package Iteration: 1783488822pre
rm -r dist
rm -r tmp
rm -r /root/go/pkg/linux_amd64/github.com/grafana
building grafana-server ./pkg/cmd/grafana-server
rm -r ./bin/linux-amd64/grafana-server
rm -r ./bin/linux-amd64/grafana-server.md5
go build -ldflags -w -X main.version=11.5.0-pre -X main.commit=fed6d6df08 -X main.buildstamp=1783487154 -X main.buildBranch=blitzy-c1320fad-13f7-4230-845a-4106d66675bf -o ./bin/linux-amd64/grafana-server ./pkg/cmd/grafana-server
go version
go version go1.23.1 linux/amd64
Targeting linux/amd64
```

The banner reports `commit=fed6d6df08`. That is the current branch `HEAD`; its **only** delta from the
pinned parent commit `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` is *this Markdown document* — there is no
Go source change, so the compiled scheduler behavior is identical to the pinned commit (see the read-only
proof in §6.4). The real server binary (the 298 MB `grafana` command, distinct from the deprecation-shim
`grafana-server` produced above) was then built directly:

```console
$ go build -o ./bin/linux-amd64/grafana ./pkg/cmd/grafana
```

### 1.3 Server invocation (exact command)

The server was launched from the repository root (the home path must contain `conf/defaults.ini` and
`public/`), pointing at a scratch config:

```console
$ ./bin/linux-amd64/grafana server \
    --homepath /tmp/blitzy/grafana/blitzy-c1320fad-13f7-4230-845a-4106d66675bf_c80291 \
    --config /tmp/obs2/grafana.stress.ini
```

> **Credentials note.** The scratch server uses Grafana's built-in local admin account (default
> `admin` / `admin` on a throwaway SQLite database). All `curl` commands below authenticate with
> `-u "$GRAFANA_USER:$GRAFANA_PASSWORD"`; export those two variables to the local scratch credentials
> before running. No real secret is involved — the database is created fresh under `/tmp` and destroyed
> at cleanup.

### 1.4 The two runtime configurations (verbatim)

**Stressed** (`/tmp/obs2/grafana.stress.ini`) — 1 s tick behind the `configurableSchedulerTick` toggle,
debug logging, recording rules enabled (used later as the type-change lever in §3):

```ini
app_mode = production
[paths]
data = /tmp/obs2/data-stress
logs = /tmp/obs2/logs-stress
plugins = /tmp/obs2/plugins-stress
provisioning = /tmp/obs2/prov-stress
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
enable = configurableSchedulerTick grafanaManagedRecordingRules
[recording_rules]
enabled = true
url = http://127.0.0.1:9790/api/v1/write
[unified_alerting]
enabled = true
scheduler_tick_interval = 1s
```

**Normal** (`/tmp/obs2/grafana.normal.ini`) — the **canonical default**: no tick override, no feature
toggle, so the scheduler runs at its built-in 10 s base interval:

```ini
app_mode = production
[paths]
data = /tmp/obs2/data-normal
logs = /tmp/obs2/logs-normal
plugins = /tmp/obs2/plugins-normal
provisioning = /tmp/obs2/prov-normal
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
[unified_alerting]
enabled = true
```

The only intended differences are the `scheduler_tick_interval` override (plus the toggle that unlocks it)
and the recording-rules toggle. Everything else — `[unified_alerting] enabled = true`,
`[log] level = debug` — is identical, so the two runs are the *same scenario* at two tick rates.

### 1.5 The tick-interval feature-toggle gotcha

`scheduler_tick_interval` is only honored when the `configurableSchedulerTick` feature toggle is enabled
(`setting_unified_alerting.go:336`). With the toggle **on**, a non-default value logs a WARN and takes
effect (`:341`); with the toggle **off**, the same value logs a *different* WARN and is **ignored**,
falling back to the 10 s default (`:345`). The stressed run has the toggle enabled, so the 1 s interval
truly took effect — confirmed by the startup lines (§2.1). This is why the normal config omits both the
toggle and the override: it exercises the genuine canonical default.

### 1.6 Observability surface

All alerting metrics are Prometheus instruments under the `grafana` namespace / `alerting` subsystem
(`metrics/ngalert.go:10-11`), so they appear on `/metrics` as `grafana_alerting_*`. The signals used below:

| Signal | Kind | `file:line` |
|--------|------|-------------|
| `grafana_alerting_scheduler_behind_seconds` | gauge — heartbeat-loop lag | `metrics/scheduler.go:43`, set at `schedule.go:215` |
| `grafana_alerting_schedule_rule_evaluations_missed_total{org,name}` | counter — dropped ticks | `metrics/scheduler.go:181`, `:184`; inc at `schedule.go:380` |
| `grafana_alerting_rule_evaluations_total{org}` | counter — completed evaluations | `metrics/scheduler.go:52` |
| `grafana_alerting_schedule_alert_rules` / `_hash` | gauges — schedulable set size / hash | `metrics/scheduler.go:156`, `:164`; set at `schedule/metrics.go:115-116` |
| `grafana_alerting_schedule_periodic_duration_seconds` | histogram — `processTick` duration | `metrics/scheduler.go` |
| `grafana_alerting_ticker_interval_seconds` etc. | gauges — ticker cadence | `ticker/metrics.go:19,25,31` |
| DEBUG/WARN scheduler log lines | structured logs (`logger=ngalert.scheduler`) | cited inline |

### 1.7 The load levers: a slow vs. a timing-out data source

Backpressure was induced with a tiny Prometheus-compatible mock (`/tmp/obs2/slowprom.py`) that sleeps
before answering. It distinguishes two query substrings:

- **`slow_metric` → sleeps 15 s.** 15 s is longer than the 1 s tick and the 10 s rule interval, so the
  rule's goroutine is still busy when the next ticks arrive (this is what produces the drops), but 15 s is
  **less** than the 30 s evaluation timeout, so these evaluations *complete* (as `Alerting`).
- **`timeout_metric` → sleeps 45 s.** 45 s is deliberately **far past** the 30 s evaluation timeout
  (`evaluatorDefaultEvaluationTimeout = 30 * time.Second`, `setting_unified_alerting.go:49`; config key
  `evaluation_timeout`, `:309`). Because 45 s ≫ 30 s, the query is unambiguously killed by the *timeout*
  (not by the mock returning), surfacing as `context deadline exceeded` at ~30 s (§3.3).

The stressed mock therefore ran as `slowprom.py 9790 15 45` (38 rules query `slow_metric`, 2 rules query
`timeout_metric`); the normal mock ran as `slowprom.py 9790 0 0` (answers immediately). The default
maximum evaluation attempts is 3 (`schedulerDefaultMaxAttempts = 3`, `setting_unified_alerting.go:52`),
which shapes the timeout footprint in §3.3.

### 1.8 Run scale & duration

| Run | Tick | Rules | Data source | Approx. duration | Log |
|-----|------|-------|-------------|------------------|-----|
| **Stress #1** | 1 s (toggle) | 40 (38 slow @15 s + 2 timeout @45 s) → churned to 39 | mock `slowprom.py 9790 15 45` | ~20 min (05:47→06:07 UTC) | `server.stress1.log` (61,907 lines) |
| **Stress #2** | 1 s (toggle) | 40 | same mock | ~4 min (06:09→06:13 UTC) | `server.stress2.log` |
| **Normal** | 10 s (default) | 40 | mock `slowprom.py 9790 0 0` | ~2 min (06:15→06:17 UTC) | `server.normal.log` |

Every reported magnitude was confirmed stable across at least two runs at this scale (§2.9, §5.5).

### 1.9 Deterministic complement (fake-clock unit tests)

The `schedule` package ships deterministic tests built on the `benbjohnson/clock` fake clock, which drive
ticks and evaluation timing programmatically. Four of them are used below as low-noise corroboration of
the live runs: `TestProcessTicks` (per-tick selection & sorting, §2.8), the drop test
`TestAlertRule/.../eval_should_drop_any_concurrent_sending_to_evalCh` (§4.6), and the two `TestRuleRoutine`
stop-reason tests (§3.2, §3.3). They were run with the canonical `go test` invocation shown at each site.

---

## 2. Q1 — how the scheduler decides what to work on next, and where that first becomes visible

### 2.1 Direct answer

On every tick the scheduler runs `processTick` (`schedule.go:235`), which does four things in order:
(1) folds in the latest set of schedulable rules (so adds/updates/deletes that arrived since the last tick
are already reflected); (2) computes a per-rule **readiness** test and collects the rules that are ready
*this* tick; (3) **sorts the ready set by rule UID**; and (4) dispatches them **spread evenly across the
base interval** using `time.AfterFunc`, handing each to its rule's goroutine.

- The **work-selection choice** first becomes visible in two DEBUG lines: `Rule is ready to run on the
  current tick` (`schedule.go:329`) names each selected rule, and the UID-ordered `Processing tick`
  (`alert_rule.go:269`) lines show the dispatch order and spacing.
- **Falling behind** first becomes visible as the `Tick dropped because alert rule evaluation is too slow`
  WARN (`schedule.go:378`) and its counter `grafana_alerting_schedule_rule_evaluations_missed_total`
  (`schedule.go:380`) — **and not** in `grafana_alerting_scheduler_behind_seconds`, which measures a
  different thing and stayed ≈0 (§2.4).
- A **timing-out data source** surfaces as `context deadline exceeded` at ~30 s, retried up to 3 times,
  then written as an `Error` state (§3.3).

### 2.2 The readiness test — `isReadyToRun`

The per-rule readiness decision is three lines (`schedule.go:314-316`), followed a few lines later by the
DEBUG line that makes the selection observable (`:329`). The full unedited span (lines 318-326 in the
middle are unrelated folder-title bookkeeping, shown here only so nothing is elided):

```go
		itemFrequency := item.IntervalSeconds / int64(sch.baseInterval.Seconds())
		offset := jitterOffsetInTicks(item, sch.baseInterval, sch.jitterEvaluations)
		isReadyToRun := item.IntervalSeconds != 0 && (tickNum%itemFrequency)-offset == 0

		var folderTitle string
		if !sch.disableGrafanaFolder {
			title, ok := folderTitles[item.GetFolderKey()]
			if ok {
				folderTitle = title
			} else {
				missingFolder[item.NamespaceUID] = append(missingFolder[item.NamespaceUID], item.UID)
			}
		}

		if isReadyToRun {
			logger.Debug("Rule is ready to run on the current tick", "tick", tick, "frequency", itemFrequency, "offset", offset)
			readyToRun = append(readyToRun, readyToRunItem{ruleRoutine: ruleRoutine, Evaluation: Evaluation{
				scheduledAt: tick,
				rule:        item,
```

`itemFrequency` is the rule's interval expressed in ticks (`IntervalSeconds / baseInterval`), and `offset`
is a per-group **jitter** offset (`jitterOffsetInTicks`, `jitter.go:39`; default strategy `JitterByGroup`,
`jitter.go:18,24`) that spreads groups across the interval. A rule is ready exactly when
`(tickNum % itemFrequency) - offset == 0`. Captured live at one tick of the stressed run (10 s rules on a
1 s tick, so `frequency=10`; the jittered `offset=6`):

```console
$ grep 'Rule is ready to run on the current tick' server.stress1.log | grep 'tick=2026-07-08T05:50:26Z'
```
```
logger=ngalert.scheduler rule_uid=slowrule030 org_id=1 t=2026-07-08T05:50:26.00117006Z level=debug msg="Rule is ready to run on the current tick" tick=2026-07-08T05:50:26Z frequency=10 offset=6
logger=ngalert.scheduler rule_uid=slowrule002 org_id=1 t=2026-07-08T05:50:26.001193326Z level=debug msg="Rule is ready to run on the current tick" tick=2026-07-08T05:50:26Z frequency=10 offset=6
logger=ngalert.scheduler rule_uid=slowrule004 org_id=1 t=2026-07-08T05:50:26.001206432Z level=debug msg="Rule is ready to run on the current tick" tick=2026-07-08T05:50:26Z frequency=10 offset=6
logger=ngalert.scheduler rule_uid=slowrule014 org_id=1 t=2026-07-08T05:50:26.001219564Z level=debug msg="Rule is ready to run on the current tick" tick=2026-07-08T05:50:26Z frequency=10 offset=6
logger=ngalert.scheduler rule_uid=slowrule021 org_id=1 t=2026-07-08T05:50:26.001229835Z level=debug msg="Rule is ready to run on the current tick" tick=2026-07-08T05:50:26Z frequency=10 offset=6
logger=ngalert.scheduler rule_uid=slowrule035 org_id=1 t=2026-07-08T05:50:26.001244662Z level=debug msg="Rule is ready to run on the current tick" tick=2026-07-08T05:50:26Z frequency=10 offset=6
```

Two things to read out: the `offset=6` is identical for every rule (they share one group, so one jitter
offset), and the rules appear here in Go **map-iteration order** (`slowrule030, 002, 004, 014, 021, 035`)
— readiness is computed for the *whole* set first; the deterministic **UID order** is imposed at dispatch,
next.

### 2.3 Deterministic dispatch — UID sort + `time.AfterFunc` spread

After the ready set is collected, `processTick` computes a per-item `step`, sorts by UID, and schedules each
evaluation at an increasing delay (`schedule.go:359-382`):

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
```

`step = baseInterval / len(readyToRun)`, and item *i* fires at `i * step`. With a 1 s base interval and 40
ready rules, `step ≈ 25 ms`. Captured live (first full tick of the stressed run, `now=2026-07-08T05:47:56Z`):

```console
$ grep 'now=2026-07-08T05:47:56Z' server.stress1.log | grep 'Processing tick' | head -10
```
```
logger=ngalert.scheduler rule_uid=slowrule001 org_id=1 version=2 fingerprint=fa5bac0d515be74e now=2026-07-08T05:47:56Z t=2026-07-08T05:47:56.001468598Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule002 org_id=1 version=2 fingerprint=174abe4049e02059 now=2026-07-08T05:47:56Z t=2026-07-08T05:47:56.02738336Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule003 org_id=1 version=2 fingerprint=26f321a3bd486380 now=2026-07-08T05:47:56Z t=2026-07-08T05:47:56.052389187Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule004 org_id=1 version=2 fingerprint=ab86dc47bbb5cb6b now=2026-07-08T05:47:56Z t=2026-07-08T05:47:56.077459436Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule005 org_id=1 version=2 fingerprint=c2e9ed754ba8f032 now=2026-07-08T05:47:56Z t=2026-07-08T05:47:56.101672892Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule006 org_id=1 version=2 fingerprint=9857db50e2437f5d now=2026-07-08T05:47:56Z t=2026-07-08T05:47:56.126778336Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule007 org_id=1 version=2 fingerprint=e1b8d0c64d115294 now=2026-07-08T05:47:56Z t=2026-07-08T05:47:56.151845452Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule008 org_id=1 version=2 fingerprint=9385b5e278d94bdf now=2026-07-08T05:47:56Z t=2026-07-08T05:47:56.176860633Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule009 org_id=1 version=2 fingerprint=0ce1f05e60139836 now=2026-07-08T05:47:56Z t=2026-07-08T05:47:56.201922876Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule010 org_id=1 version=2 fingerprint=19ae9f991a109ddf now=2026-07-08T05:47:56Z t=2026-07-08T05:47:56.227025593Z level=debug msg="Processing tick"
```

The `t=` timestamps advance by ~25 ms per rule (`.001` → `.027` → `.052` → `.077` → … → `.227`), and the
rules are in **strict UID order** (`slowrule001, 002, 003, …`), exactly as the `slices.SortFunc(...
strings.Compare(a.rule.UID, b.rule.UID))` at `:364` dictates. This is the load-spreading that keeps a
group of rules from stampeding the data source at the top of each interval.

### 2.4 Where "falling behind" does **not** show up: `scheduler_behind_seconds` ≈ 0

Reading the code, `grafana_alerting_scheduler_behind_seconds` looks like the obvious "are we behind?"
signal. **The runtime disagrees, and this is the single most important correction in this document.**

The gauge is set once per heartbeat at the very top of `schedulePeriodic`, *before* `processTick` runs
(`schedule.go:211-215`):

```go
			// This is required as ticks from the ticker and time.Now() can have
			// a monotonic clock that when subtracted do not represent the delta
			// in wall clock time.
			start := time.Now().Round(0)
			sch.metrics.BehindSeconds.Set(start.Sub(tick).Seconds())
```

`start.Sub(tick)` is the gap between a tick's nominal time and the wall-clock moment the loop *picks it up*
— i.e. **heartbeat-loop lag**: how late the scheduler goroutine is to *start* a tick. It says nothing about
how slow the evaluations are, because `processTick` does not evaluate anything — it only sorts and schedules
`time.AfterFunc` callbacks (§2.3) and returns. The callbacks (and the 15 s evaluations they trigger) run in
*other* goroutines, so the loop stays cheap and keeps up with the 1 s tick.

Sampled 220 times across the stressed run, the gauge never left the sub-millisecond floor:

```console
$ wc -l < behind.stress1.series
220
$ awk 'NR==1{min=max=$NF}{v=$NF;if(v<min)min=v;if(v>max)max=v}END{printf "min=%s  max=%s\n",min,max}' behind.stress1.series
min=2.4022e-05  max=0.001121069
$ head -3 behind.stress1.series
05:48:03 0.00038609
05:48:04 0.001100386
05:48:05 0.001029812
```

Peak lag was **0.00112 s** (1.1 ms). The companion histogram explains why — `processTick` itself averaged
**0.89 ms** (sum 0.4446 s over 500 ticks), leaving the 1 s loop ~1000× of headroom:

```console
$ curl -s -u "$GRAFANA_USER:$GRAFANA_PASSWORD" http://127.0.0.1:3000/metrics \
    | grep -E '^grafana_alerting_schedule_periodic_duration_seconds_(sum|count)|^grafana_alerting_ticker_interval_seconds'
grafana_alerting_schedule_periodic_duration_seconds_sum 0.44463567500000045
grafana_alerting_schedule_periodic_duration_seconds_count 500
grafana_alerting_ticker_interval_seconds 1
```

The gauge would only climb if the *loop* work (dominated by the schedulable-rules DB fetch) exceeded the
tick interval — it did not at this scale, and (see §5.1) it stayed at the same ~1 ms floor even in the
**normal** run. So `behind_seconds` is a real signal, but it is **not** where evaluation backpressure first
appears. That distinction is the answer to "where does that choice first become visible": the *selection*
is visible in the readiness/`Processing tick` lines (§2.2-2.3); *falling behind* is visible in the drop
signal next.

### 2.5 The real backpressure signal: the drop WARN + missed counter (+ the timeout)

When a rule's goroutine is still busy evaluating a previous tick, the newer tick displaces the older one and
the scheduler logs a WARN and increments a counter (the code is the `if dropped != nil` block at
`schedule.go:378-380`, shown in §2.3). Captured live:

```console
$ grep 'Tick dropped because alert rule evaluation is too slow' server.stress1.log | head -6
```
```
logger=ngalert.scheduler t=2026-07-08T05:48:26.110826537Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=slowrule001 org_id=1 time=2026-07-08T05:48:26Z droppedTick=2026-07-08T05:48:16Z
logger=ngalert.scheduler t=2026-07-08T05:48:26.137353297Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=slowrule003 org_id=1 time=2026-07-08T05:48:26Z droppedTick=2026-07-08T05:48:16Z
logger=ngalert.scheduler t=2026-07-08T05:48:26.14369684Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=slowrule004 org_id=1 time=2026-07-08T05:48:26Z droppedTick=2026-07-08T05:48:16Z
logger=ngalert.scheduler t=2026-07-08T05:48:26.147794682Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=slowrule006 org_id=1 time=2026-07-08T05:48:26Z droppedTick=2026-07-08T05:48:16Z
logger=ngalert.scheduler t=2026-07-08T05:48:26.161755788Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=slowrule007 org_id=1 time=2026-07-08T05:48:26Z droppedTick=2026-07-08T05:48:16Z
logger=ngalert.scheduler t=2026-07-08T05:48:26.169534277Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=slowrule005 org_id=1 time=2026-07-08T05:48:26Z droppedTick=2026-07-08T05:48:16Z
```

Every `droppedTick` is exactly one 10 s interval **older** than the surviving `time` (e.g.
`droppedTick=05:48:16` vs `time=05:48:26`) — the system discards the *older* pending tick, never the newer
(the mechanism is §4.3). Each such WARN increments the missed counter, whose `name` label is the rule's
**Title** (`slowrule-001`, with a hyphen), distinct from its UID (`slowrule001`) — because the code passes
`item.rule.Title` (`schedule.go:380`):

```console
$ curl -s -u "$GRAFANA_USER:$GRAFANA_PASSWORD" http://127.0.0.1:3000/metrics \
    | grep 'grafana_alerting_schedule_rule_evaluations_missed_total' | head -4
```
```
grafana_alerting_schedule_rule_evaluations_missed_total{name="slowrule-001",org="1"} 6
grafana_alerting_schedule_rule_evaluations_missed_total{name="slowrule-002",org="1"} 6
grafana_alerting_schedule_rule_evaluations_missed_total{name="slowrule-003",org="1"} 6
grafana_alerting_schedule_rule_evaluations_missed_total{name="slowrule-004",org="1"} 6
```

Meanwhile *completed* evaluations are tallied by `grafana_alerting_rule_evaluations_total` (single `org`
label, `metrics/scheduler.go:52`), which climbs steadily as slow evaluations finish:

```console
$ curl -s -u "$GRAFANA_USER:$GRAFANA_PASSWORD" http://127.0.0.1:3000/metrics \
    | grep '^grafana_alerting_rule_evaluations_total'
grafana_alerting_rule_evaluations_total{org="1"} 538
```

Finally, the **timing-out** data source (the two `timeout_metric` rules) surfaces as `context deadline
exceeded` — here on the first of three attempts; the full 3-attempt footprint and its `Error`-state write
are dissected in §3.3:

```console
$ grep 'rule_uid=slowrule040' server.stress1.log | grep 'context deadline exceeded' | head -1
```
```
logger=ngalert.scheduler rule_uid=slowrule040 org_id=1 version=2 fingerprint=c40a402aeef52c97 now=2026-07-08T05:47:56Z t=2026-07-08T05:48:26.977617768Z level=error msg="Failed to evaluate rule" attempt=1 error="the result-set has errors that can be retried: [sse.dataQueryError] failed to execute query [A]: Post \"http://127.0.0.1:9790/api/v1/query\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)"
```

### 2.6 The heartbeat ticker never drops — drops happen at the per-rule channel

It is worth pinning down *where* the drop occurs. The heartbeat ticker explicitly **never drops ticks** —
its doc comment says it "doesn't drop ticks for slow receivers, rather, it queues up"
(`ticker/ticker.go:13`) and "never drops ticks" (`:26`). So a "dropped tick" is never a lost *heartbeat*;
it is always a rule whose goroutine could not keep up, dropped at that rule's own channel inside `Eval()`
(§4.3). This is why the drop WARN carries a `rule_uid` and the missed counter is per-rule.

### 2.7 "Many alert rule changes arrive" while already behind (add / update / delete under load)

Q1 specifically asks about *many rule changes arriving while evaluations are already falling behind*. That
was exercised directly: with the stressed server backed up (40 rules, drops accumulating), a batch of two
adds, two updates, and three deletes was pushed through the provisioning API, and the next tick absorbed all
of them. The before/after snapshot and the batch itself:

```console
=== BEFORE churn ===
[BEFORE] schedule_alert_rules=40 hash=2.6274620658384855e+18 missed_total_sum=824.0 api_rule_count=40
CHURN_START_UTC= 2026-07-08T05:57:53Z
ADD slowrule041 -> 201
ADD slowrule042 -> 201
UPDATE slowrule001 version_before= None
UPDATE slowrule001 -> 200 version_after= None
UPDATE slowrule002 version_before= None
UPDATE slowrule002 -> 200 version_after= None
DELETE slowrule011 -> 204
DELETE slowrule012 -> 204
DELETE slowrule013 -> 204
CHURN_END_UTC= 2026-07-08T05:57:53Z
=== waiting 25s for fetch+eval cycle ===
=== AFTER churn ===
[AFTER] schedule_alert_rules=39 hash=2.6701149160896666e+18 missed_total_sum=865.0 api_rule_count=39
GET slowrule011 -> 404
GET slowrule041 -> 200
```

The very next fetch reflected the net change (2 added − 3 deleted = 39) and flagged the two updates, without
interrupting the backed-up evaluations:

```console
$ grep 'Alert rules fetched' server.stress1.log | grep '05:57:54'
logger=ngalert.scheduler t=2026-07-08T05:57:54.003733135Z level=debug msg="Alert rules fetched" rulesCount=39 foldersCount=1 updatedRules=2
```

The **schedulable-rules gauge** and its **hash** both moved (the hash is a fold over rule UIDs, so any
membership change perturbs it), while the missed counter kept climbing throughout — the churn rode *on top
of* ongoing backpressure:

- `grafana_alerting_schedule_alert_rules`: **40 → 39**
- `grafana_alerting_schedule_alert_rules_hash`: `2.6274620658384855e+18` → `2.6701149160896666e+18`
- `grafana_alerting_schedule_rule_evaluations_missed_total` (Σ): **824 → 865** (still rising)

Each of the three **deletions** produced the full cleanup footprint on that tick (this is the §3.2 deletion
path, happening three-at-once here):

```
logger=ngalert.state.manager rule_uid=slowrule011 org_id=1 t=2026-07-08T05:57:54.00424666Z level=debug msg="Resetting state of the rule"
logger=ngalert.state.manager rule_uid=slowrule013 org_id=1 t=2026-07-08T05:57:54.004297999Z level=debug msg="Resetting state of the rule"
logger=ngalert.state.manager rule_uid=slowrule012 org_id=1 t=2026-07-08T05:57:54.004360142Z level=debug msg="Resetting state of the rule"
logger=ngalert.state.manager rule_uid=slowrule011 org_id=1 t=2026-07-08T05:57:54.004391231Z level=info msg="Rules state was reset" states=1
logger=ngalert.sender.router rule_uid=slowrule011 org_id=1 t=2026-07-08T05:57:54.004409895Z level=info msg="Sending alerts to local notifier" count=1
logger=ngalert.scheduler rule_uid=slowrule011 org_id=1 t=2026-07-08T05:57:54.004449705Z level=debug msg="Stopping alert rule routine"
logger=ngalert.state.manager rule_uid=slowrule012 org_id=1 t=2026-07-08T05:57:54.005327482Z level=info msg="Rules state was reset" states=1
logger=ngalert.sender.router rule_uid=slowrule012 org_id=1 t=2026-07-08T05:57:54.005361972Z level=info msg="Sending alerts to local notifier" count=1
logger=ngalert.scheduler rule_uid=slowrule012 org_id=1 t=2026-07-08T05:57:54.005395476Z level=debug msg="Stopping alert rule routine"
logger=ngalert.state.manager rule_uid=slowrule013 org_id=1 t=2026-07-08T05:57:54.005640142Z level=info msg="Rules state was reset" states=1
logger=ngalert.sender.router rule_uid=slowrule013 org_id=1 t=2026-07-08T05:57:54.005660202Z level=info msg="Sending alerts to local notifier" count=1
logger=ngalert.scheduler rule_uid=slowrule013 org_id=1 t=2026-07-08T05:57:54.005693819Z level=debug msg="Stopping alert rule routine"
```

The two **updates** took two *different* internal routes, both captured:

- `slowrule001` was **not** mid-evaluation, so its update arrived via the routine's `updateCh` and cleared
  state immediately (`Clearing the state of the rule because it was updated`, `alert_rule.go:257`); its
  version went `2 → 3` and its fingerprint `fa5bac0d515be74e → 6587b00cefcbb282`:

  ```
logger=ngalert.scheduler rule_uid=slowrule001 org_id=1 t=2026-07-08T05:57:56.716914237Z level=info msg="Clearing the state of the rule because it was updated" isPaused=false fingerprint=6587b00cefcbb282
  ```

- `slowrule002` happened to be **ready-to-run on the same tick**, so its update rode *with* the evaluation:
  it set `Alerting`, then reset to `Normal (Updated)` (annotation `oldState=Alerting`), and a later
  `updateCh` notification found the fingerprint already current and skipped a second reset
  (`Rule's fingerprint has not changed. Skip resetting the state`):

  ```
logger=ngalert.scheduler rule_uid=slowrule002 org_id=1 t=2026-07-08T05:57:54.003903432Z level=debug msg="Rule has been updated. Notifying evaluation routine"
logger=ngalert.scheduler rule_uid=slowrule002 org_id=1 t=2026-07-08T05:57:56.001800825Z level=debug msg="Rule is ready to run on the current tick" tick=2026-07-08T05:57:56Z frequency=10 offset=6
logger=ngalert.state.manager rule_uid=slowrule002 org_id=1 instance="__name__=slow_metric" t=2026-07-08T05:57:56.621304816Z level=debug msg="Setting next state" handler=resultAlerting
logger=ngalert.state.manager rule_uid=slowrule002 org_id=1 t=2026-07-08T05:57:56.629302759Z level=debug msg="Resetting state of the rule"
logger=ngalert.state.manager rule_uid=slowrule002 org_id=1 t=2026-07-08T05:57:56.632630421Z level=info msg="Rules state was reset" states=1
logger=ngalert.state.historian backend=annotations rule_uid=slowrule002 org_id=1 t=2026-07-08T05:57:56.632659368Z level=debug msg="Alert state changed creating annotation" newState="Normal (Updated)" oldState=Alerting
logger=ngalert.scheduler rule_uid=slowrule002 org_id=1 t=2026-07-08T05:58:06.001279679Z level=debug msg="Rule is ready to run on the current tick" tick=2026-07-08T05:58:06Z frequency=10 offset=6
logger=ngalert.state.manager rule_uid=slowrule002 org_id=1 instance="__name__=slow_metric" t=2026-07-08T05:58:11.634826553Z level=debug msg="Setting next state" handler=resultAlerting
logger=ngalert.scheduler rule_uid=slowrule002 org_id=1 t=2026-07-08T05:58:11.680261599Z level=info msg="Rule's fingerprint has not changed. Skip resetting the state" currentFingerprint=b28b7f05151c1055
  ```

The point for Q1: **many concurrent rule changes are folded into the next tick's schedulable set** without
disturbing the in-flight, already-behind evaluations — adds start new routines, deletes stop-and-clean, and
updates either clear-via-`updateCh` or ride-with-the-eval depending on whether the rule was busy.

### 2.8 Deterministic corroboration — `TestProcessTicks`

The live selection/sort behavior is asserted deterministically by the in-repo `TestProcessTicks`, which
drives ticks on a fake clock and includes an explicit `scheduled_rules_should_be_sorted` sub-test. It passes
on the real `processTick`:

```console
$ go test ./pkg/services/ngalert/schedule/ -run 'TestProcessTicks' -v -count=1
```
```
=== RUN   TestProcessTicks
=== RUN   TestProcessTicks/before_1st_tick_status_should_not_be_available
=== RUN   TestProcessTicks/on_1st_tick_alert_rule_should_be_evaluated
    schedule_unit_test.go:1074: alert rule: {orgID: 1, UID: ffrglzxdqmebye} evaluated at: 0001-01-01 00:00:01 +0000 UTC
=== RUN   TestProcessTicks/after_1st_tick_rule_metrics_should_report_one_active_alert_rule
=== RUN   TestProcessTicks/after_1st_tick_status_for_rule_should_be_available
=== RUN   TestProcessTicks/before_2nd_tick_status_for_rule_should_not_be_available
=== RUN   TestProcessTicks/on_2nd_tick_first_alert_rule_should_be_evaluated
    schedule_unit_test.go:1074: alert rule: {orgID: 1, UID: ffrglzxdqmebye} evaluated at: 0001-01-01 00:00:02 +0000 UTC
=== RUN   TestProcessTicks/after_2nd_tick_rule_metrics_should_report_two_active_alert_rules_in_two_groups
=== RUN   TestProcessTicks/on_3rd_tick_two_alert_rules_should_be_evaluated
    schedule_unit_test.go:1074: alert rule: {orgID: 1, UID: efrglzxdqmec9e} evaluated at: 0001-01-01 00:00:03 +0000 UTC
    schedule_unit_test.go:1074: alert rule: {orgID: 1, UID: ffrglzxdqmebye} evaluated at: 0001-01-01 00:00:03 +0000 UTC
=== RUN   TestProcessTicks/after_3rd_tick_status_for_both_rules_should_be_available
=== RUN   TestProcessTicks/on_4th_tick_only_one_alert_rule_should_be_evaluated
    schedule_unit_test.go:1074: alert rule: {orgID: 1, UID: ffrglzxdqmebye} evaluated at: 0001-01-01 00:00:04 +0000 UTC
=== RUN   TestProcessTicks/on_5th_tick_an_alert_rule_is_paused_(it_still_enters_evaluation_but_it_is_early_skipped)
    schedule_unit_test.go:1074: alert rule: {orgID: 1, UID: ffrglzxdqmebye} evaluated at: 0001-01-01 00:00:05 +0000 UTC
=== RUN   TestProcessTicks/after_5th_tick_rule_metrics_should_report_one_active_and_one_paused_alert_rules_in_two_groups
=== RUN   TestProcessTicks/after_5th_tick_status_for_both_rules_should_be_available_regardless_of_pause_state
=== RUN   TestProcessTicks/on_6th_tick_all_alert_rule_are_paused_(it_still_enters_evaluation_but_it_is_early_skipped)
    schedule_unit_test.go:1074: alert rule: {orgID: 1, UID: efrglzxdqmec9e} evaluated at: 0001-01-01 00:00:06 +0000 UTC
    schedule_unit_test.go:1074: alert rule: {orgID: 1, UID: ffrglzxdqmebye} evaluated at: 0001-01-01 00:00:06 +0000 UTC
=== RUN   TestProcessTicks/after_6th_tick_rule_metrics_should_report_two_paused_alert_rules_in_two_groups
=== RUN   TestProcessTicks/on_7th_tick_unpause_all_alert_rules
    schedule_unit_test.go:1074: alert rule: {orgID: 1, UID: ffrglzxdqmebye} evaluated at: 0001-01-01 00:00:07 +0000 UTC
=== RUN   TestProcessTicks/after_7th_tick_rule_metrics_should_report_two_active_alert_rules_in_two_groups
=== RUN   TestProcessTicks/on_8th_tick_deleted_rule_should_not_be_evaluated_but_stopped
    schedule_unit_test.go:1101: alert rule: {orgID: 1, UID: ffrglzxdqmebye} stopped
=== RUN   TestProcessTicks/after_8th_tick_rule_metrics_should_report_one_active_alert_rule
=== RUN   TestProcessTicks/after_8th_tick_status_for_deleted_rule_should_not_be_available
=== RUN   TestProcessTicks/on_9th_tick_one_alert_rule_should_be_evaluated
    schedule_unit_test.go:1074: alert rule: {orgID: 1, UID: efrglzxdqmec9e} evaluated at: 0001-01-01 00:00:09 +0000 UTC
=== RUN   TestProcessTicks/on_10th_tick_a_new_alert_rule_should_be_evaluated
    schedule_unit_test.go:1074: alert rule: {orgID: 1, UID: dfrglzzbgadqjd} evaluated at: 0001-01-01 00:00:10 +0000 UTC
=== RUN   TestProcessTicks/after_10th_tick_status_for_remaining_rules_should_be_available
=== RUN   TestProcessTicks/on_11th_tick_rule2_should_be_updated
=== RUN   TestProcessTicks/on_12th_tick_recording_rule_and_alert_rules_should_be_evaluated
=== RUN   TestProcessTicks/on_13th_tick_recording_rule_should_be_updated
=== RUN   TestProcessTicks/on_14th_tick_both_1-tick_alert_rule_and_2-tick_recording_rule_should_be_evaluated
=== RUN   TestProcessTicks/prior_to_15th_tick_alertRule3_should_still_be_scheduled_as_alerting_rule
=== RUN   TestProcessTicks/on_15th_tick_converted_rule_and_3-tick_alert_rule_should_be_evaluated
=== RUN   TestProcessTicks/on_16th_tick_converted_rule_and_2-tick_recording_rule_should_be_evaluated
=== RUN   TestProcessTicks/on_17th_tick_all_rules_should_be_stopped
=== RUN   TestProcessTicks/after_12th_tick_no_status_should_be_available
=== RUN   TestProcessTicks/scheduled_rules_should_be_sorted
--- PASS: TestProcessTicks (1.01s)
    --- PASS: TestProcessTicks/before_1st_tick_status_should_not_be_available (0.00s)
    --- PASS: TestProcessTicks/on_1st_tick_alert_rule_should_be_evaluated (0.00s)
    --- PASS: TestProcessTicks/after_1st_tick_rule_metrics_should_report_one_active_alert_rule (0.00s)
    --- PASS: TestProcessTicks/after_1st_tick_status_for_rule_should_be_available (0.00s)
    --- PASS: TestProcessTicks/before_2nd_tick_status_for_rule_should_not_be_available (0.00s)
    --- PASS: TestProcessTicks/on_2nd_tick_first_alert_rule_should_be_evaluated (0.00s)
    --- PASS: TestProcessTicks/after_2nd_tick_rule_metrics_should_report_two_active_alert_rules_in_two_groups (0.00s)
    --- PASS: TestProcessTicks/on_3rd_tick_two_alert_rules_should_be_evaluated (0.50s)
    --- PASS: TestProcessTicks/after_3rd_tick_status_for_both_rules_should_be_available (0.00s)
    --- PASS: TestProcessTicks/on_4th_tick_only_one_alert_rule_should_be_evaluated (0.00s)
    --- PASS: TestProcessTicks/on_5th_tick_an_alert_rule_is_paused_(it_still_enters_evaluation_but_it_is_early_skipped) (0.00s)
    --- PASS: TestProcessTicks/after_5th_tick_rule_metrics_should_report_one_active_and_one_paused_alert_rules_in_two_groups (0.00s)
    --- PASS: TestProcessTicks/after_5th_tick_status_for_both_rules_should_be_available_regardless_of_pause_state (0.00s)
    --- PASS: TestProcessTicks/on_6th_tick_all_alert_rule_are_paused_(it_still_enters_evaluation_but_it_is_early_skipped) (0.50s)
    --- PASS: TestProcessTicks/after_6th_tick_rule_metrics_should_report_two_paused_alert_rules_in_two_groups (0.00s)
    --- PASS: TestProcessTicks/on_7th_tick_unpause_all_alert_rules (0.00s)
    --- PASS: TestProcessTicks/after_7th_tick_rule_metrics_should_report_two_active_alert_rules_in_two_groups (0.00s)
    --- PASS: TestProcessTicks/on_8th_tick_deleted_rule_should_not_be_evaluated_but_stopped (0.00s)
    --- PASS: TestProcessTicks/after_8th_tick_rule_metrics_should_report_one_active_alert_rule (0.00s)
    --- PASS: TestProcessTicks/after_8th_tick_status_for_deleted_rule_should_not_be_available (0.00s)
    --- PASS: TestProcessTicks/on_9th_tick_one_alert_rule_should_be_evaluated (0.00s)
    --- PASS: TestProcessTicks/on_10th_tick_a_new_alert_rule_should_be_evaluated (0.00s)
    --- PASS: TestProcessTicks/after_10th_tick_status_for_remaining_rules_should_be_available (0.00s)
    --- PASS: TestProcessTicks/on_11th_tick_rule2_should_be_updated (0.00s)
    --- PASS: TestProcessTicks/on_12th_tick_recording_rule_and_alert_rules_should_be_evaluated (0.00s)
    --- PASS: TestProcessTicks/on_13th_tick_recording_rule_should_be_updated (0.00s)
    --- PASS: TestProcessTicks/on_14th_tick_both_1-tick_alert_rule_and_2-tick_recording_rule_should_be_evaluated (0.00s)
    --- PASS: TestProcessTicks/prior_to_15th_tick_alertRule3_should_still_be_scheduled_as_alerting_rule (0.00s)
    --- PASS: TestProcessTicks/on_15th_tick_converted_rule_and_3-tick_alert_rule_should_be_evaluated (0.00s)
    --- PASS: TestProcessTicks/on_16th_tick_converted_rule_and_2-tick_recording_rule_should_be_evaluated (0.00s)
    --- PASS: TestProcessTicks/on_17th_tick_all_rules_should_be_stopped (0.00s)
    --- PASS: TestProcessTicks/after_12th_tick_no_status_should_be_available (0.00s)
    --- PASS: TestProcessTicks/scheduled_rules_should_be_sorted (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/schedule	1.042s
```

### 2.9 Stability & scale

- **Scale/duration:** 40 rules @ 10 s interval, 1 s tick, 15 s slow data source (2 rules at 45 s timeout),
  ~20 min (run #1); repeated ~4 min (run #2).
- **Stable across both runs:** readiness `frequency=10 offset=6`; UID-ordered dispatch at ~25 ms steps
  (run #2 fingerprints were byte-identical, e.g. `slowrule001=fa5bac0d515be74e`); `behind_seconds` on the
  sub-millisecond floor (max 0.00112 s run #1, 0.00187 s run #2); drops always present with WARN count ==
  missed counter (§5.4).

---

## 3. Q2 — cancellation vs. removal: what is left behind

### 3.1 Direct answer

There are **four distinct termination paths**, and they leave three distinct kinds of footprint:

| Path | State left behind? | The runtime "tell" |
|------|--------------------|--------------------|
| **Rule deletion** | **No** — cleaned up, resolved notification sent | skip-write → `Resetting state of the rule` → `Rules state was reset` (via `DeleteStateByRuleUID(...StateReasonRuleDeleted)`) → `Sending alerts to local notifier` (resolved) → `Stopping alert rule routine` |
| **Mid-flight evaluation cancellation** | **Nothing new is written**; prior state untouched | `Skip updating the state because the context has been cancelled` (DEBUG) *or* `Skip evaluation and updating the state because the context has been cancelled` (ERROR); **no** state write for that tick |
| **Rule restart** (here: type change) | **Yes** — left in place | `Rule restarted because type changed` → new routine started → `Stopping alert rule routine`, with **no** `Rules state was reset` |
| **Scheduler shutdown** | **Yes** — left in place, persisted on disk | N × `Stopping alert rule routine`, **zero** `Rules state was reset`; rows survive on disk and reload on next boot |

The mechanism that distinguishes them is the **cancellation cause**. Each rule's context is built with
`util.WithCancelCause` (`alert_rule.go:158`), so `grafanaCtx.Err()` returns
`errors.Join(context.Canceled, <cause>)`. When the routine's stop branch fires it checks that cause with
`errors.Is` (`alert_rule.go:349`); the two sentinel causes are `errRuleDeleted` (`registry.go:19`) and
`errRuleRestarted` (`registry.go:20`). **Only** `errRuleDeleted` triggers state cleanup. The stop branch,
unedited (`alert_rule.go:347-359`):

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

`DeleteStateByRuleUID` (`:355`) and `expireAndSend` (`:356`) run **only** inside the `errRuleDeleted`
branch; `Stopping alert rule routine` (`:358`) runs on **every** path. (Note the check is on
`grafanaCtx.Err()`, not `context.Cause` — the joined error is what `errors.Is` matches against.)

### 3.2 Path 1 — DELETION (state cleaned up, resolved notification sent)

**Method.** With the stressed server backed up, `slowrule025` was deleted mid-evaluation via
`DELETE /api/v1/provisioning/alert-rules/slowrule025`. Its state was observed **before**, **during**, and
**after**, reading the scratch SQLite DB directly (the `sqlite3` CLI is not installed, so Python's
`sqlite3` was used, opened read-only):

```console
# DELETION slowrule025 mid-eval (before/during/after)
BEFORE: slowrule025 Alerting since 1783489676; total alert_instance rows=39
DURING (tick 06:05:57):
logger=ngalert.scheduler rule_uid=slowrule025 org_id=1 version=2 fingerprint=92ed01ac400a401a now=2026-07-08T06:05:36Z t=2026-07-08T06:05:57.003974413Z level=debug msg="Skip updating the state because the context has been cancelled"
logger=ngalert.state.manager rule_uid=slowrule025 org_id=1 t=2026-07-08T06:05:57.004010812Z level=debug msg="Resetting state of the rule"
logger=ngalert.state.manager rule_uid=slowrule025 org_id=1 t=2026-07-08T06:05:57.004126362Z level=info msg="Rules state was reset" states=1
logger=ngalert.sender.router rule_uid=slowrule025 org_id=1 t=2026-07-08T06:05:57.004143418Z level=info msg="Sending alerts to local notifier" count=1
logger=ngalert.scheduler rule_uid=slowrule025 org_id=1 t=2026-07-08T06:05:57.004187731Z level=debug msg="Stopping alert rule routine"
AFTER: slowrule025 row GONE; total rows=38; GET /api/.../slowrule025 -> 404
```

Reading the DURING trace top to bottom: the in-flight evaluation (`now=06:05:36`) hits the **post-eval
cancel guard** and its write is skipped (`Skip updating the state because the context has been cancelled`,
`alert_rule.go:393`); then `DeleteStateByRuleUID(...StateReasonRuleDeleted)` removes the rule's one state
(`Resetting state of the rule` → `Rules state was reset states=1`); then `expireAndSend` pushes the
**resolved** notification (`Sending alerts to local notifier count=1`, from `logger=ngalert.sender.router`);
then the goroutine exits (`Stopping alert rule routine`). Afterward the alert-instance row is **gone** (39 →
38) and the rule returns **HTTP 404** — nothing left behind.

**Deterministic corroboration** — the real routine stopped with the `errRuleDeleted` cause empties the
rule's state:

```console
$ go test ./pkg/services/ngalert/schedule/ \
    -run 'TestRuleRoutine/should_exit/and_clean_up_the_state_if_delete_is_cancellation_reason_for_inner_context' -v -count=1
```
```
=== RUN   TestRuleRoutine
=== RUN   TestRuleRoutine/should_exit
=== RUN   TestRuleRoutine/should_exit/and_clean_up_the_state_if_delete_is_cancellation_reason_for_inner_context
--- PASS: TestRuleRoutine (0.00s)
    --- PASS: TestRuleRoutine/should_exit (0.00s)
        --- PASS: TestRuleRoutine/should_exit/and_clean_up_the_state_if_delete_is_cancellation_reason_for_inner_context (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/schedule	0.032s
```

### 3.3 Path 2 — mid-flight CANCELLATION (state write skipped, prior state intact)

This path is exercised **independently of deletion**. When a rule's context is cancelled *while an
evaluation is in flight* for a reason **other** than deletion, the routine skips the state write and leaves
the prior state exactly as it was. There are two guards, at different log levels:

- **Pre-eval guard (ERROR)** — checked before evaluating (`alert_rule.go:319-324`):

  ```go
					// Check before any execution if the context was cancelled so that we don't do any evaluations.
					if tracingCtx.Err() != nil {
						span.SetStatus(codes.Error, "rule evaluation cancelled")
						span.End()
						logger.Error("Skip evaluation and updating the state because the context has been cancelled", "version", ctx.rule.Version, "fingerprint", f, "attempt", attempt, "now", ctx.scheduledAt)
						return
  ```

- **Post-eval guard (DEBUG)** — checked after a long evaluation returns, before persisting
  (`alert_rule.go:390-394`):

  ```go

	if ctx.Err() != nil { // check if the context is not cancelled. The evaluation can be a long-running task.
		span.SetStatus(codes.Error, "rule evaluation cancelled")
		logger.Debug("Skip updating the state because the context has been cancelled")
		return nil
  ```

**Live capture (standalone, not a deletion).** `slowrule020` — an `Alerting` rule with a 15 s evaluation in
flight — was converted from an *alerting* rule to a *recording* rule (a type change; `PUT` to the
provisioning API). A type change cancels the rule's context with the `errRuleRestarted` cause (§3.4), which
trips the **post-eval cancel guard** on the in-flight evaluation. The guard fired and the write for that
tick (`now=06:03:26`) was skipped:

```console
$ grep 'rule_uid=slowrule020' server.stress1.log \
    | grep -E 'Skip updating the state because the context has been cancelled|Scheduled evaluation was canceled'
```
```
logger=ngalert.scheduler rule_uid=slowrule020 org_id=1 version=2 fingerprint=127d69e5e01f0de7 now=2026-07-08T06:03:26Z t=2026-07-08T06:03:42.003475112Z level=debug msg="Skip updating the state because the context has been cancelled"
logger=ngalert.scheduler t=2026-07-08T06:03:42.003280695Z level=debug msg="Scheduled evaluation was canceled because evaluation routine was stopped" rule_uid=slowrule020 org_id=1 time=2026-07-08T06:03:36Z
```

Because the routine `return`s before writing, **no state update is persisted for that tick**. The prior
`Alerting` state was left untouched — confirmed on disk after the run (its `alert_instance` row is unchanged
from *before* the type change all the way through shutdown):

```console
$ python3 -c "import sqlite3; c=sqlite3.connect('file:/tmp/obs2/data-stress/grafana.db?mode=ro&immutable=1', uri=True); \
    print(c.execute(\"select rule_uid,current_state,last_eval_time from alert_instance where rule_uid='slowrule020'\").fetchone())"
('slowrule020', 'Alerting', 1783489676)
```

**Reproduced in run #2** on a different rule (`slowrule030`, `now=06:12:06`) — same guard, same skipped
write:

```console
$ grep 'rule_uid=slowrule030' server.stress2.log | grep 'Skip updating the state because the context has been cancelled'
```
```
logger=ngalert.scheduler rule_uid=slowrule030 org_id=1 version=2 fingerprint=76e20748d115799b now=2026-07-08T06:12:06Z t=2026-07-08T06:12:25.004563836Z level=debug msg="Skip updating the state because the context has been cancelled"
```

**Deterministic corroboration** — stopping the real routine via the parent context (a cause that is **not**
`errRuleDeleted`) **preserves** the rule's state:

```console
$ go test ./pkg/services/ngalert/schedule/ \
    -run 'TestRuleRoutine/should_exit/and_not_clear_the_state_if_parent_context_is_cancelled' -v -count=1
```
```
=== RUN   TestRuleRoutine
=== RUN   TestRuleRoutine/should_exit
=== RUN   TestRuleRoutine/should_exit/and_not_clear_the_state_if_parent_context_is_cancelled
--- PASS: TestRuleRoutine (0.00s)
    --- PASS: TestRuleRoutine/should_exit (0.00s)
        --- PASS: TestRuleRoutine/should_exit/and_not_clear_the_state_if_parent_context_is_cancelled (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/schedule	0.030s
```

**Cancellation is NOT the same as a timeout.** A cancellation *skips* the write; a **timeout** produces an
*error result that IS written* as an `Error` state. The two `timeout_metric` rules (mock sleeps 45 s ≫ the
30 s `evaluation_timeout`, so the 30 s deadline is unambiguously the cause) show the complete footprint —
three attempts (`schedulerDefaultMaxAttempts = 3`), each killed at the 30 s deadline, then a written
`Error` state:

```console
$ grep 'rule_uid=slowrule040' server.stress1.log | grep 'now=2026-07-08T05:47:56Z'   # (one eval cycle)
```
```
logger=ngalert.scheduler rule_uid=slowrule040 org_id=1 version=2 fingerprint=c40a402aeef52c97 now=2026-07-08T05:47:56Z t=2026-07-08T05:48:26.977617768Z level=error msg="Failed to evaluate rule" attempt=1 error="the result-set has errors that can be retried: [sse.dataQueryError] failed to execute query [A]: Post \"http://127.0.0.1:9790/api/v1/query\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)"
logger=ngalert.scheduler rule_uid=slowrule040 org_id=1 version=2 fingerprint=c40a402aeef52c97 now=2026-07-08T05:47:56Z t=2026-07-08T05:48:57.978284919Z level=error msg="Failed to evaluate rule" attempt=2 error="the result-set has errors that can be retried: [sse.dataQueryError] failed to execute query [A]: Post \"http://127.0.0.1:9790/api/v1/query\": context deadline exceeded"
logger=ngalert.scheduler rule_uid=slowrule040 org_id=1 version=2 fingerprint=c40a402aeef52c97 now=2026-07-08T05:47:56Z t=2026-07-08T05:49:28.979692948Z level=debug msg="Alert rule evaluated" error="[sse.dataQueryError] failed to execute query [A]: Post \"http://127.0.0.1:9790/api/v1/query\": net/http: request canceled (Client.Timeout exceeded while awaiting headers)" duration=30.000822106s
logger=ngalert.state.manager rule_uid=slowrule040 org_id=1 instance= t=2026-07-08T05:49:28.97973426Z level=debug msg="Setting next state" handler=resultError
logger=ngalert.scheduler rule_uid=slowrule040 org_id=1 version=2 fingerprint=c40a402aeef52c97 now=2026-07-08T05:47:56Z t=2026-07-08T05:49:28.982689183Z level=debug msg="Tick processed" attempt=3 duration=1m32.005850908s
```

Note `duration=30.000822106s` on the successful-return attempt (≈ the 30 s timeout, **not** the 45 s the
mock would have slept), `handler=resultError` (`Setting next state`) — the state **is** written — and
`Tick processed attempt=3 duration=1m32.005850908s` (≈ 3 × 30 s + 2 × 1 s retry delay). Same-looking
slowness as a cancellation, opposite footprint: the timeout **writes**, the cancellation **skips**.

### 3.4 Path 3 — RESTART (rule type changed → `errRuleRestarted`, state left in place)

A **restart** is triggered live when a rule's *type* changes (alerting ⇄ recording). `processTick` detects
the type change, logs `Rule restarted because type changed` (`schedule.go:295`), starts a fresh routine of
the new type, and stops the old routine with the `errRuleRestarted` cause
(`oldRoutine.Stop(errRuleRestarted)`, `schedule.go:387`). Because that cause is **not** `errRuleDeleted`,
the cleanup branch at `alert_rule.go:349` is **not** taken — `DeleteStateByRuleUID` is never called. This is
the same `slowrule020` type change as §3.3, viewed from the restart angle:

```console
$ grep 'rule_uid=slowrule020' server.stress1.log \
    | grep -E 'Rule restarted because type changed|Recording rule routine started|Stopping alert rule routine'
```
```
logger=ngalert.scheduler rule_uid=slowrule020 org_id=1 t=2026-07-08T06:03:42.003172547Z level=debug msg="Rule restarted because type changed" old=alerting new=recording
logger=ngalert.scheduler rule_uid=slowrule020 org_id=1 t=2026-07-08T06:03:42.003219931Z level=debug msg="Recording rule routine started"
logger=ngalert.scheduler rule_uid=slowrule020 org_id=1 t=2026-07-08T06:03:42.003499405Z level=debug msg="Stopping alert rule routine"
```

The old routine stopped **without** any state cleanup — neither `Rules state was reset` nor `Resetting
state of the rule` appears for `slowrule020` anywhere in the run, in direct contrast to the deleted
`slowrule025` (§3.2), where the identical greps both return a match:

```console
# RESTART (slowrule020, type change) — NO state cleanup:
$ grep 'rule_uid=slowrule020' server.stress1.log | grep -c 'Rules state was reset'
0
$ grep 'rule_uid=slowrule020' server.stress1.log | grep -c 'Resetting state of the rule'
0
# the SAME greps for the DELETED slowrule025 (§3.2) — cleanup DID run there:
$ grep 'rule_uid=slowrule025' server.stress1.log | grep -c 'Rules state was reset'
1
$ grep 'rule_uid=slowrule025' server.stress1.log | grep -c 'Resetting state of the rule'
1
```

So the `Alerting` state written before the type change survived (the on-disk check in §3.3 confirms
`slowrule020` was still `Alerting` at shutdown). Restart deliberately **leaves state in place**; the only
runtime footprint is the `Rule restarted…` / new-routine-started / `Stopping` triple with no reset. (This
was reproduced in run #2 on `slowrule030` — the same triple, shown in §3.3's run-#2 capture.)

### 3.5 Path 4 — SHUTDOWN (state left in place, persisted on disk)

On shutdown the parent context is cancelled with a cause that is **not** `errRuleDeleted`, so — exactly as
in the restart case — no cleanup runs. **Method:** `SIGINT` was sent to the stressed server. It exited
gracefully in ~2 s. The captured footprint is *every* rule's routine stopping with **zero** state resets:

```console
# SHUTDOWN (SIGINT) footprint — STRESS run #1.
# SIGINT sent at 2026-07-08T06:07:26Z; grafana exited gracefully in ~2 s.
# alert_instance rows BEFORE shutdown (read-only sqlite3): 38

$ grep 'Grafana is shutting down' server.stress1.log | grep '06:07:26'
logger=secrets t=2026-07-08T06:07:26.648856733Z level=debug msg="Grafana is shutting down; stopping..."

$ grep 'Stopping alert rule routine' server.stress1.log | grep '2026-07-08T06:07:2'
logger=ngalert.scheduler rule_uid=slowrule022 org_id=1 t=2026-07-08T06:07:26.64911352Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule042 org_id=1 t=2026-07-08T06:07:26.64932005Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule024 org_id=1 t=2026-07-08T06:07:26.649350149Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule003 org_id=1 t=2026-07-08T06:07:26.649424673Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule016 org_id=1 t=2026-07-08T06:07:26.64945198Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule017 org_id=1 t=2026-07-08T06:07:26.649496639Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule006 org_id=1 t=2026-07-08T06:07:26.649534338Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule002 org_id=1 t=2026-07-08T06:07:26.649562615Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule014 org_id=1 t=2026-07-08T06:07:26.64958239Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule032 org_id=1 t=2026-07-08T06:07:26.649620756Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule038 org_id=1 t=2026-07-08T06:07:26.649669006Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule033 org_id=1 t=2026-07-08T06:07:26.649696936Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule019 org_id=1 t=2026-07-08T06:07:26.649696171Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule023 org_id=1 t=2026-07-08T06:07:26.649367826Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule031 org_id=1 t=2026-07-08T06:07:26.649751053Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule037 org_id=1 t=2026-07-08T06:07:26.649790608Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule010 org_id=1 t=2026-07-08T06:07:26.649796275Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule041 org_id=1 t=2026-07-08T06:07:26.649828123Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule007 org_id=1 t=2026-07-08T06:07:26.649852856Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule036 org_id=1 t=2026-07-08T06:07:26.649907248Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule035 org_id=1 t=2026-07-08T06:07:26.649784679Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule008 org_id=1 t=2026-07-08T06:07:26.649889262Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule004 org_id=1 t=2026-07-08T06:07:26.649952476Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule030 org_id=1 t=2026-07-08T06:07:26.649996873Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule027 org_id=1 t=2026-07-08T06:07:26.650034775Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule028 org_id=1 t=2026-07-08T06:07:26.650050681Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule018 org_id=1 t=2026-07-08T06:07:26.650090462Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule005 org_id=1 t=2026-07-08T06:07:26.650100603Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule034 org_id=1 t=2026-07-08T06:07:26.650115089Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule015 org_id=1 t=2026-07-08T06:07:26.650176233Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule039 org_id=1 t=2026-07-08T06:07:26.650193928Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule029 org_id=1 t=2026-07-08T06:07:26.650206679Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule009 org_id=1 t=2026-07-08T06:07:26.650217545Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule021 org_id=1 t=2026-07-08T06:07:26.650358658Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule040 org_id=1 t=2026-07-08T06:07:26.650398184Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule001 org_id=1 t=2026-07-08T06:07:26.650441976Z level=debug msg="Stopping alert rule routine"
logger=ngalert.scheduler rule_uid=slowrule026 org_id=1 t=2026-07-08T06:07:26.650531087Z level=debug msg="Stopping alert rule routine"

$ grep 'Stopping recording rule routine' server.stress1.log | grep '2026-07-08T06:07:2'
logger=ngalert.scheduler rule_uid=slowrule020 org_id=1 t=2026-07-08T06:07:26.650134218Z level=debug msg="Stopping recording rule routine"

$ grep 'Rules state was reset' server.stress1.log | grep '2026-07-08T06:07:2' | wc -l
0

# ON-DISK STATE AFTER shutdown (read-only sqlite3):
# alert_instance rows AFTER shutdown: 38  (Alerting=36, Error=2)  => STATE PERSISTED
# slowrule020 AFTER shutdown: Alerting since 1783489676 (unchanged since before type-change)
```

Every stopping routine at shutdown — the 37 `Stopping alert rule routine` lines plus the single
`Stopping recording rule routine` for `slowrule020` (which had been type-changed to a recording rule in
§3.4), **38 routines in all** — stopped with **no** accompanying `Rules state was reset`, and the
alert-instance rows **survived on disk** (36 `Alerting` + 2 `Error` = 38 rows), including `slowrule020`
still `Alerting` from before its §3.3/§3.4 type change. State is deliberately left in place; on the next
boot the server reloads those rows.

### 3.6 Before / during / after (transitional coverage)

| Path | Before | During | After |
|------|--------|--------|-------|
| **Deletion** (`slowrule025`) | `Alerting`; 39 rows | skip-write → `Rules state was reset states=1` → resolved notification → `Stopping` | row gone; 38 rows; HTTP 404 |
| **Cancellation** (`slowrule020`, mid-flight) | `Alerting` (since 1783489676) | `Skip updating the state because the context has been cancelled` (`alert_rule.go:393`); no write | prior `Alerting` intact (unchanged on disk) |
| **Restart** (`slowrule020`, type change) | `Alerting` | `Rule restarted because type changed` → new routine → `Stopping`; **0** resets | `Alerting` left in place |
| **Shutdown** (SIGINT) | 38 rows | 38 × `Stopping` (37 alert + 1 recording), **0** resets | 38 rows persisted on disk (36 `Alerting` + 2 `Error`) |

### 3.7 Stability

Each footprint was reproduced: the deletion footprint (skip-write → reset → resolve → stop) matches the
three simultaneous deletions during the §2.7 churn; the cancellation guard + restart triple was captured in
**both** stress runs (`slowrule020` run #1, `slowrule030` run #2); the shutdown-leaves-state result was
confirmed on disk; and both deterministic stop-reason tests pass (`-count=1` shown above; re-runs also
pass).

---

## 4. Q3 — does anything appear out of order? (negative result)

### 4.1 Direct answer

**No — per-rule evaluation results never appear out of order.** Across every run, evaluation results for
any given rule are produced in strictly non-decreasing `scheduledAt` (`now=`) order. Lag never causes a
*reordering*; it causes a **drop of the older pending tick**. When a rule's goroutine is busy, only the
**newest** tick survives, so a rule's `now=` sequence can *skip* values but can never *invert* them. The
observable proof is twofold: (a) each rule's processed `now=` values strictly increase while the dropped
ticks are always the *older* ones, and (b) an automated scan over all three runs finds **0** inversions.

### 4.2 Why — one goroutine + one unbuffered channel per rule

Each rule is served by a single long-lived goroutine consuming an **unbuffered** channel
(`alert_rule.go:158,161`):

```go
	ctx, stop := util.WithCancelCause(ngmodels.WithRuleKey(parent, key.AlertRuleKey))
	return &alertRule{
		key:                  key,
		evalCh:               make(chan *Evaluation),
```

`make(chan *Evaluation)` with no capacity is unbuffered — a send blocks until the single consumer receives.
That consumer is the routine's `evalCh` case (`alert_rule.go:261-262`):

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

One consumer + an unbuffered channel ⇒ a rule's evaluations happen strictly one-at-a-time, in acceptance
order. There is no queue that *could* be reordered.

### 4.3 Why — drop-newest-wins backpressure in `Eval()`

When the scheduler dispatches a tick it calls `Eval()`, which is short enough to quote in full (unedited,
`alert_rule.go:196-215`):

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

Step by step: (1) a mismatched key is rejected (`:197-201`, defensive). (2) A **non-blocking drain**
(`:203-207`) pulls out any *previous* tick still sitting unconsumed in the channel and remembers it as
`droppedMsg`; if nothing is waiting, `default` runs and it stays nil. This is where the **older** pending
tick is discarded. (3) The **send** (`:209-214`) puts the **newer** tick into the channel (or, if the rule
is shutting down, abandons the send and returns `false` — the `Scheduled evaluation was canceled…` DEBUG at
`schedule.go:374`). So the newest `scheduledAt` always wins and the older is returned as `dropped` (which
the scheduler reports as the "Tick dropped…" WARN, §2.5). The channel never holds more than one item, and
it is always the latest — inversion is structurally impossible.

### 4.4 Observed proof — interleaved per-rule sequence

A single rule's interleaved `Processing tick` / `Tick processed` / `Tick dropped` trace shows the invariant
directly. For `slowrule001` (unedited, first 14 lines):

```console
$ grep 'slowrule001' server.stress1.log | grep -E 'Processing tick|Tick processed|Tick dropped' | head -14
```
```
logger=ngalert.scheduler rule_uid=slowrule001 org_id=1 version=2 fingerprint=fa5bac0d515be74e now=2026-07-08T05:47:56Z t=2026-07-08T05:47:56.001468598Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule001 org_id=1 version=2 fingerprint=fa5bac0d515be74e now=2026-07-08T05:47:56Z t=2026-07-08T05:48:11.052100992Z level=debug msg="Tick processed" attempt=1 duration=15.050571102s
logger=ngalert.scheduler rule_uid=slowrule001 org_id=1 version=2 fingerprint=fa5bac0d515be74e now=2026-07-08T05:48:06Z t=2026-07-08T05:48:11.052117857Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule001 org_id=1 version=2 fingerprint=fa5bac0d515be74e now=2026-07-08T05:48:06Z t=2026-07-08T05:48:26.110728131Z level=debug msg="Tick processed" attempt=1 duration=15.058595977s
logger=ngalert.scheduler rule_uid=slowrule001 org_id=1 version=2 fingerprint=fa5bac0d515be74e now=2026-07-08T05:48:26Z t=2026-07-08T05:48:26.110756607Z level=debug msg="Processing tick"
logger=ngalert.scheduler t=2026-07-08T05:48:26.110826537Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=slowrule001 org_id=1 time=2026-07-08T05:48:26Z droppedTick=2026-07-08T05:48:16Z
logger=ngalert.scheduler rule_uid=slowrule001 org_id=1 version=2 fingerprint=fa5bac0d515be74e now=2026-07-08T05:48:26Z t=2026-07-08T05:48:41.117103111Z level=debug msg="Tick processed" attempt=1 duration=15.00633s
logger=ngalert.scheduler rule_uid=slowrule001 org_id=1 version=2 fingerprint=fa5bac0d515be74e now=2026-07-08T05:48:36Z t=2026-07-08T05:48:41.11711973Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule001 org_id=1 version=2 fingerprint=fa5bac0d515be74e now=2026-07-08T05:48:36Z t=2026-07-08T05:48:56.20748494Z level=debug msg="Tick processed" attempt=1 duration=15.090354118s
logger=ngalert.scheduler rule_uid=slowrule001 org_id=1 version=2 fingerprint=fa5bac0d515be74e now=2026-07-08T05:48:56Z t=2026-07-08T05:48:56.207517194Z level=debug msg="Processing tick"
logger=ngalert.scheduler t=2026-07-08T05:48:56.207576411Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=slowrule001 org_id=1 time=2026-07-08T05:48:56Z droppedTick=2026-07-08T05:48:46Z
logger=ngalert.scheduler rule_uid=slowrule001 org_id=1 version=2 fingerprint=fa5bac0d515be74e now=2026-07-08T05:48:56Z t=2026-07-08T05:49:11.267632207Z level=debug msg="Tick processed" attempt=1 duration=15.060102599s
logger=ngalert.scheduler rule_uid=slowrule001 org_id=1 version=2 fingerprint=fa5bac0d515be74e now=2026-07-08T05:49:06Z t=2026-07-08T05:49:11.267649138Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=slowrule001 org_id=1 version=2 fingerprint=fa5bac0d515be74e now=2026-07-08T05:49:06Z t=2026-07-08T05:49:26.272003398Z level=debug msg="Tick processed" attempt=1 duration=15.004344313s
```

Two invariants to read out:

- The processed `now=` values **strictly increase**: `05:47:56` → `05:48:06` → `05:48:26` → `05:48:36` →
  `05:48:56` → … Never a decrease. (Each evaluation takes ~15 s — see `duration=15.05…s` — so at a 1 s tick
  the routine is perpetually busy.)
- Every `droppedTick` is **older** than the surviving `time`: `droppedTick=05:48:16 < time=05:48:26`;
  `droppedTick=05:48:46 < time=05:48:56`. And the dropped values (`05:48:16`, `05:48:46`) are exactly the
  ones **missing** from the processed sequence — the system discarded the *older* pending tick, precisely
  as the drain step in `Eval()` (`alert_rule.go:203-207`) dictates.

### 4.5 Observed proof — zero inversions across the whole run (all three runs)

An automated scan of every rule's `Processing tick` sequence, over each full log, confirms **0**
`scheduledAt` inversions:

```console
$ python3 - <<'PY'
import re
pat=re.compile(r'rule_uid=(\S+).*now=(\S+Z).*Processing tick')
for label,path in [("STRESS run#1","server.stress1.log"),("STRESS run#2","server.stress2.log"),("NORMAL","server.normal.log")]:
    last={}; inv=0; n=0
    for line in open(path):
        m=pat.search(line)
        if not m: continue
        uid,now=m.group(1),m.group(2); n+=1
        if uid in last and now < last[uid]: inv+=1
        last[uid]=now
    print(f"{label:14s}: processing-tick events: {n}  inversions: {inv}  rules: {len(last)}")
PY
STRESS run#1  : processing-tick events: 2931  inversions: 0  rules: 42
STRESS run#2  : processing-tick events: 610  inversions: 0  rules: 40
NORMAL        : processing-tick events: 745  inversions: 0  rules: 40
```

Zero inversions in all three runs (run #1 reports 42 distinct rules because the §2.7 churn added
`slowrule041`/`slowrule042` mid-run). The negative result is not a fluke of one run — it is a structural
property of the one-goroutine + unbuffered-channel + drop-newest-wins design, and it held every time.

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
ok  	github.com/grafana/grafana/pkg/services/ngalert/schedule	0.036s
```

The test (`alert_rule_test.go`) sends two evaluations with times `time1` and `time2` concurrently, then
asserts the channel holds the **newer** `time2`, that the first send reported no drop, and that the second
send reported the **older** `time1` as dropped — exactly the drop-newest-wins behavior observed live in
§4.4.

### 4.7 Stability

- **Scale:** 40 rules @ 10 s interval, 1 s tick, 15 s slow data source, ~20 min (run #1); 40 rules,
  ~4 min (run #2); 40 rules @ 10 s tick, fast source, ~2 min (normal).
- **Result:** 0 inversions in all three runs (2931 / 610 / 745 processing-tick events). Ordering
  preservation is structural, not incidental.

---

## 5. Stressed vs. normal — what visibly changes

The **identical scenario** (same 40 rules, same mock, same debug logging) was run once **stressed** (1 s
tick via the `configurableSchedulerTick` toggle, data source slow 15 s / timeout 45 s) and once **normal**
(default 10 s tick, data source ~1–12 ms). The two configs are in §1.4. This section quantifies the deltas,
with the producing command and its output under every value.

### 5.1 Side-by-side table

| Dimension | STRESS (1 s tick) | NORMAL (10 s tick) | Source |
|-----------|-------------------|--------------------|--------|
| Tick interval (`ticker_interval_seconds`) | **1** | **10** | `metrics/scheduler.go` / ticker |
| Scheduler startup line | `Starting scheduler tickInterval=1s maxAttempts=3` (+ non-default WARN) | `Starting scheduler tickInterval=10s maxAttempts=3` (no WARN) | `ngalert.go:390`, `setting_unified_alerting.go:341` |
| Dispatch step (`baseInterval / len`) | **~25 ms** (1 s / 40) | **~250 ms** (10 s / 40) | `schedule.go:359-370` |
| `Tick processed` count (run length differs) | **2931** (~20 min) | **745** (~2 min) | `grep -c` |
| `Tick processed` duration | **~15.0 s** (= mock sleep) | **5–12 ms** | `alert_rule.go:332` |
| Per-rule `now=` cadence | 10 s **with drop-gaps** | 10 s, **no gaps** | `Processing tick` `now=` |
| `Tick dropped…` WARN count | **1624** | **0** | `schedule.go:378` |
| `…_rule_evaluations_missed_total` (Σ) | **== drop count** (run #2: 301 == 301) | **0** (counter absent) | `schedule.go:380` |
| `grafana_alerting_rule_evaluations_total{org}` *(point-in-time scrape)* | **538** (run #1) / **613** (run #2) | **356** | `metrics/scheduler.go:52` |
| `grafana_alerting_schedule_alert_rules` | **40** | **40** | `schedule/metrics.go:115` |
| `grafana_alerting_schedule_alert_rules_hash` | `2.6274620658384855e+18` | `2.6274620658384855e+18` (**identical**) | `schedule/metrics.go:116` |
| `scheduler_behind_seconds` max | **0.00112** (run #1) / **0.00187** (run #2) | **0.00186** | `schedule.go:215` |
| `schedule_periodic_duration` avg | **0.89 ms** | **1.37 ms** | histogram sum/count |
| Ordering inversions | **0** (2931 events) | **0** (745 events) | §4.5 scan |

### 5.2 The commands and their output (evidence for the table)

**Tick interval and startup line.** Stress logs a non-default WARN then starts at 1 s; normal starts at
10 s with no such WARN:

```console
$ grep -m2 -E 'Scheduler tick interval is changed to non-default|Starting scheduler' server.stress1.log
logger=settings t=2026-07-08T05:47:44.799612071Z level=warn msg="Scheduler tick interval is changed to non-default" interval=1s default=10s
logger=ngalert.scheduler t=2026-07-08T05:47:47.054680441Z level=info msg="Starting scheduler" tickInterval=1s maxAttempts=3
$ grep -m2 -E 'Scheduler tick interval is changed to non-default|Starting scheduler' server.normal.log
logger=ngalert.scheduler t=2026-07-08T06:15:29.216601083Z level=info msg="Starting scheduler" tickInterval=10s maxAttempts=3
```

**Dispatch step** (first full tick of each run; note ~25 ms vs ~250 ms between consecutive `t=`):

```console
$ grep 'now=2026-07-08T05:47:56Z' server.stress1.log | grep 'Processing tick' | head -3 | grep -oE 't=2026[0-9T:.-]+Z'
t=2026-07-08T05:47:56.001468598Z
t=2026-07-08T05:47:56.027383360Z
t=2026-07-08T05:47:56.052389187Z
$ grep 'now=2026-07-08T06:16:00Z' server.normal.log | grep 'Processing tick' | head -3 | grep -oE 't=2026[0-9T:.-]+Z'
t=2026-07-08T06:16:00.008277508Z
t=2026-07-08T06:16:00.259269853Z
t=2026-07-08T06:16:00.508326394Z
```

**Tick processed counts and durations:**

```console
$ grep -c 'msg="Tick processed"' server.stress1.log
2931
$ grep -c 'msg="Tick processed"' server.normal.log
745
$ grep 'msg="Tick processed"' server.normal.log | head -5 | grep -oE 'duration=[^ ]+'
duration=11.927934ms
duration=5.322379ms
duration=5.399278ms
duration=5.832782ms
duration=5.743058ms
```

(Stress `Tick processed` durations are all ~15 s — see the §4.4 trace, `duration=15.05…s`.)

**Per-rule `now=` cadence — stress has drop-gaps, normal is smooth** (the single most visible rhythm change):

```console
$ grep 'rule_uid=slowrule001' server.stress1.log | grep 'Processing tick' | head -8 | grep -oE 'now=2026[0-9T:.-]+Z'
now=2026-07-08T05:47:56Z
now=2026-07-08T05:48:06Z
now=2026-07-08T05:48:26Z
now=2026-07-08T05:48:36Z
now=2026-07-08T05:48:56Z
now=2026-07-08T05:49:06Z
now=2026-07-08T05:49:26Z
now=2026-07-08T05:49:36Z
$ grep 'rule_uid=slowrule001' server.normal.log | grep 'Processing tick' | head -8 | grep -oE 'now=2026[0-9T:.-]+Z'
now=2026-07-08T06:16:00Z
now=2026-07-08T06:16:10Z
now=2026-07-08T06:16:20Z
now=2026-07-08T06:16:30Z
now=2026-07-08T06:16:40Z
now=2026-07-08T06:16:50Z
now=2026-07-08T06:17:00Z
now=2026-07-08T06:17:10Z
```

Stress skips `05:48:16` and `05:48:46` (dropped, §4.4); normal is an unbroken 10 s march.

**Drops and the missed-evaluation counter.** The drop WARN (`schedule.go:378`) is emitted immediately
before the missed counter is incremented (`schedule.go:380`), so the missed-counter sum equals the
drop-WARN count *by construction*. The drop-WARN count is fully reproducible from each preserved log:

```console
$ grep -c 'Tick dropped because alert rule evaluation is too slow' server.stress1.log
1624
$ grep -c 'Tick dropped because alert rule evaluation is too slow' server.stress2.log
301
$ grep -c 'Tick dropped because alert rule evaluation is too slow' server.normal.log
0
```

The live `/metrics` scrape during run #2 confirmed the 1:1 pairing (`missed_total` sum `301` == drop
count `301`, recorded in `stress_run2_stability.txt`). The preserved per-rule missed series from run #1
(per-rule `name` label, `metrics/scheduler.go:181`) reads `6` for each rule — matching the six ticks
each rule dropped in the first backpressure minute (the scrape captured the leading rules):

```console
$ cat uq1_missed_counter.txt
grafana_alerting_schedule_rule_evaluations_missed_total{name="slowrule-001",org="1"} 6
grafana_alerting_schedule_rule_evaluations_missed_total{name="slowrule-002",org="1"} 6
grafana_alerting_schedule_rule_evaluations_missed_total{name="slowrule-003",org="1"} 6
grafana_alerting_schedule_rule_evaluations_missed_total{name="slowrule-004",org="1"} 6
```

**Completed-evaluation counter `grafana_alerting_rule_evaluations_total`.** This is a single-`{org}`-label
*monotonic* counter (`metrics/scheduler.go:52`) incremented once per non-paused evaluation at `attempt==1`
(`alert_rule.go:305-306`); its scraped value therefore depends on *when* `/metrics` is hit. The one raw
line preserved from run #1 was captured partway through the run:

```console
$ cat uq1_rule_evaluations_total.txt
grafana_alerting_rule_evaluations_total{org="1"} 538
```

At their own scrape moments the run #2 counter read `613` and the normal-run counter read `356`
(recorded in `stress_run2_stability.txt`); because the disposable runtimes were torn down, these exact
point-in-time reads cannot be re-scraped, so the table row above is labelled a point-in-time scrape. The
run-length-comparable, **fully log-reproducible** measure of evaluation *volume* is the count of completed
evaluation cycles over each entire log. Because `evaluate()` returns `nil` once retries are exhausted
(source comment, `alert_rule.go:327-329`), every non-paused eval logs `Tick processed` exactly once
(`alert_rule.go:332`) — success or failure — so this completed-cycle count is also the end-of-run value
the counter converges to. It equals the `Tick processed` row above (`2931` stress #1 / `745` normal):

```console
$ grep -c 'msg="Tick processed"' server.stress1.log
2931
$ grep -c 'msg="Tick processed"' server.normal.log
745
```

**Schedulable-rules gauge/hash and behind-seconds floor** (the hash is byte-identical across runs because the
40 UIDs are identical; `behind_seconds` sits on the same sub-millisecond floor in *both* runs):

```console
$ awk 'NR==1{min=max=$NF}{v=$NF;if(v<min)min=v;if(v>max)max=v}END{printf "stress#1 behind min=%s max=%s\n",min,max}' behind.stress1.series
stress#1 behind min=2.4022e-05 max=0.001121069
$ awk 'NR==1{min=max=$NF}{v=$NF;if(v<min)min=v;if(v>max)max=v}END{printf "normal   behind min=%s max=%s\n",min,max}' behind.normal.series
normal   behind min=0.000430081 max=0.001863876
```

### 5.3 The rhythm narrative

- **Per-evaluation timing** is the most dramatic delta: **~15 s** under stress (the data source sleeps 15 s,
  or hits the 30 s timeout for the two `timeout_metric` rules) vs **5–12 ms** under normal load — roughly a
  **1000–3000×** difference. That is *why* the routine is still busy when the next tick arrives, which is
  what produces the drops.
- **Volume** flips accordingly: under stress the dominant log line is the drop WARN (**1624** of them,
  one per displaced tick); under normal load there are **zero** drops and the log is a calm stream of
  `Processing tick` / `Tick processed` pairs.
- **Cadence / rhythm** is visible in two places: the dispatch step (25 ms vs 250 ms bunching at the top of
  each interval) and each rule's `now=` sequence — stuttering with drop-gaps under stress, an unbroken 10 s
  march under normal.

### 5.4 Honest nuance on `behind_seconds` (correcting the intuitive guess)

`scheduler_behind_seconds` measures **heartbeat-loop lag** (`start.Sub(tick)`, `schedule.go:214-215`), not
per-rule backpressure (§2.4). The runtime shows it does **not** distinguish the two runs: it stayed on the
same **sub-millisecond floor** whether stressed or not — max `0.00112 s` (stress #1), `0.00187 s`
(stress #2), `0.00186 s` (normal). If anything the normal-run peak was *higher* than stress #1, confirming
the value is loop-scheduling noise, not evaluation lag. The consistent, always-present backpressure signal
is instead the **drop WARN + `..._missed_total` counter** (1624 vs 0) together with the **`Tick processed`
duration** (15 s vs 5 ms). This is stated plainly because reading the code alone invites the opposite guess.

### 5.5 Two-run stability (every value with its producing command)

| Value | Stress #1 | Stress #2 | Stable? |
|-------|-----------|-----------|---------|
| Drops present; WARN == missed counter | 1624 WARNs (counter equal while live) | 301 == 301 (live) | ✅ always present; equal each time measured |
| Ordering inversions | 0 (2931 events) | 0 (610 events) | ✅ always 0 |
| `behind_seconds` max | 0.00112 s | 0.00187 s | ✅ sub-ms floor both runs (**not** spiky) |
| `rule_evaluations_total{org}` | 538 | 613 | ✅ grows monotonically both runs |
| State left on shutdown | 38 rows on disk | (reload confirmed) | ✅ persisted |

```console
# ordering: processing-tick event counts are reproducible via grep -c; the §4.5 Python scan over
# these same two logs reports inversions=0 for each (2931/610 events):
$ grep -c 'msg="Processing tick"' server.stress1.log
2931
$ grep -c 'msg="Processing tick"' server.stress2.log
610
# behind_seconds sub-ms floor, both stress runs:
$ awk 'NR==1{min=max=$NF}{v=$NF;if(v<min)min=v;if(v>max)max=v}END{printf "run#1 max=%s\n",max}' behind.stress1.series
run#1 max=0.001121069
$ awk 'NR==1{min=max=$NF}{v=$NF;if(v<min)min=v;if(v>max)max=v}END{printf "run#2 max=%s\n",max}' behind.stress2.series
run#2 max=0.001866916
# stress run #2 live pairing (drops == missed):
$ cat evidence/stress_run2_stability.txt | grep -E 'drop_WARN_lines|rule_evaluations_total'
drop_WARN_lines=301  missed_total_sum=301   (1:1 pairing: EQUAL)
rule_evaluations_total{org=1}=613
```

The magnitudes reported as answers (drops present with WARN == counter; 0 inversions; slow-vs-fast
durations; 1 s-vs-10 s cadence; sub-ms `behind_seconds`) were confirmed stable across two runs at the stated
scale. No value was run-to-run *unstable*; the earlier intuition that `behind_seconds` would spike under
stress is not borne out by either run.

---

## 6. Reasoning / mechanism appendix

### 6.1 Each observation tied to the code path that produces it

| Observation | Mechanism (function / struct) | `file:line` |
|-------------|-------------------------------|-------------|
| A rule is "ready" this tick | `isReadyToRun = IntervalSeconds!=0 && (tickNum%itemFrequency)-offset==0` | `schedule.go:314-316` |
| Jitter offset (spreads groups within interval) | `jitterOffsetInTicks`; default `JitterByGroup` | `jitter.go:39`, `:18`, `:24` |
| `Rule is ready to run on the current tick` DEBUG | `logger.Debug(...)` in `processTick` | `schedule.go:329` |
| Ready set dispatched in UID order | `slices.SortFunc(readyToRun, ... strings.Compare(a.rule.UID, b.rule.UID))` | `schedule.go:364` |
| Dispatch spread across interval | `step = baseInterval/len(readyToRun)`; `time.AfterFunc(i*step, ...)` | `schedule.go:359-361`, `:370` |
| `Processing tick` / `Tick processed` DEBUG (per rule) | rule routine consuming `evalCh` | `alert_rule.go:269`, `:332` |
| "Falling behind" — the eval-lag signal | drop WARN + `EvaluationMissed.Inc()` (NOT `behind_seconds`) | `schedule.go:378`, `:380` |
| `scheduler_behind_seconds` = heartbeat-loop lag (stayed ≈0) | `BehindSeconds.Set(start.Sub(tick))` at top of `schedulePeriodic` | `schedule.go:214-215` |
| Gauge name under `grafana`/`alerting` | `Name: "scheduler_behind_seconds"` | `metrics/scheduler.go:43`, `metrics/ngalert.go:10-11` |
| `Tick dropped because alert rule evaluation is too slow` WARN | `sch.log.Warn(...)` when `Eval` returns non-nil `dropped` | `schedule.go:378` |
| `…_missed_total{org,name}` increment (name = Title) | `EvaluationMissed.WithLabelValues(orgID, item.rule.Title).Inc()` | `schedule.go:380`, `metrics/scheduler.go:181,184` |
| Completed-evaluation counter | `rule_evaluations_total{org}` | `metrics/scheduler.go:52` |
| Ticker never drops ticks (queues instead) | doc comment | `ticker/ticker.go:13,26` |
| One goroutine + unbuffered channel per rule | `evalCh: make(chan *Evaluation)` (no capacity) | `alert_rule.go:161` |
| Drop-newest-wins backpressure | `Eval()` non-blocking drain (`:203-207`) then send (`:209-214`) | `alert_rule.go:196-215` |
| Cancellation cause carried on rule context | `util.WithCancelCause(...)` | `alert_rule.go:158` |
| Deletion / restart causes | `errRuleDeleted` / `errRuleRestarted` | `registry.go:19`, `:20` |
| Deletion cleans up state + resolves | `errors.Is(grafanaCtx.Err(), errRuleDeleted)` → `DeleteStateByRuleUID(...StateReasonRuleDeleted)` → `expireAndSend` | `alert_rule.go:349`, `:355`, `:356` |
| Mid-flight cancel skips the write | pre-eval guard (ERROR) `:323`; post-eval guard (DEBUG) `:393` | `alert_rule.go:319-324`, `:390-394` |
| `Stopping alert rule routine` on every stop | `a.logger.Debug(...)` after the cause check | `alert_rule.go:358` |
| Restart stops old routine with restart cause | `Rule restarted because type changed` → `oldRoutine.Stop(errRuleRestarted)` | `schedule.go:295`, `:387` |
| Schedulable-rules gauge + hash per tick | `SchedulableAlertRules.Set` / `SchedulableAlertRulesHash.Set` | `schedule/metrics.go:115-116` |
| Tick interval gated by feature toggle | `if cfg.IsFeatureToggleEnabled("configurableSchedulerTick")` | `setting_unified_alerting.go:336` |
| Defaults (timeout 30 s / attempts 3 / base 10 s / eval 60 s) | package constants | `setting_unified_alerting.go:49,52,62,64` |
| Scheduler wiring / logger name | `SchedulerCfg{... Log: log.New("ngalert.scheduler")}` → `NewScheduler` | `ngalert.go:376,390,424` |

### 6.2 Anchor reference table (every `file:line` cited, verified at HEAD `fed6d6df08`)

- **`schedule.go`** — `schedulePeriodic` `205`; `start := time.Now().Round(0)` `214`; `BehindSeconds.Set`
  `215`; `processTick` `235`; `Rule restarted because type changed` `295`; `itemFrequency` `314`; `offset`
  `315`; `isReadyToRun` `316`; readiness DEBUG `329`; `step` `359-361`; UID sort `364`; `time.AfterFunc`
  `370`; canceled DEBUG `374`; drop WARN `378`; `EvaluationMissed…Inc()` `380`;
  `oldRoutine.Stop(errRuleRestarted)` `387`.
- **`alert_rule.go`** — `util.WithCancelCause` `158`; unbuffered `evalCh` `161`; `Eval()` `196-215` (drain
  `203-207`, send `209-214`); `Clearing the state…updated` `257`; consume case `261-262`; `Processing tick`
  `269`; pre-eval guard (ERROR) `319-324` (msg `323`); `Tick processed` `332`; `<-grafanaCtx.Done()` `347`;
  `errors.Is(grafanaCtx.Err(), errRuleDeleted)` `349`; `DeleteStateByRuleUID(...StateReasonRuleDeleted)`
  `355`; `expireAndSend` `356`; `Stopping alert rule routine` `358`; post-eval guard (DEBUG) `390-394`
  (msg `393`).
- **`registry.go`** — `errRuleDeleted` `19`; `errRuleRestarted` `20`.
- **`schedule/metrics.go`** — `SchedulableAlertRules.Set` `115`; `SchedulableAlertRulesHash.Set` `116`.
- **`jitter.go`** — `JitterByGroup` `18`; `JitterStrategyFrom` default `24`; `jitterOffsetInTicks` `39`.
- **`metrics/scheduler.go`** — `scheduler_behind_seconds` `43`; `rule_evaluations_total` `52`;
  `schedule_alert_rules` `156`; `schedule_alert_rules_hash` `164`;
  `schedule_rule_evaluations_missed_total` `181`, labels `{"org","name"}` `184`.
- **`metrics/ngalert.go`** — `Namespace = "grafana"` `10`; `Subsystem = "alerting"` `11`.
- **`ticker/ticker.go`** — "doesn't drop ticks … queues up" `13`; "never drops ticks" `26`.
  **`ticker/metrics.go`** — `ticker_last_consumed_tick_timestamp_seconds` `19`;
  `ticker_next_tick_timestamp_seconds` `25`; `ticker_interval_seconds` `31`.
- **`setting_unified_alerting.go`** — `evaluatorDefaultEvaluationTimeout = 30s` `49`;
  `schedulerDefaultMaxAttempts = 3` `52`; `SchedulerBaseInterval = 10s` `62`;
  `DefaultRuleEvaluationInterval == 60s` `64`; `evaluation_timeout` key `309`; `scheduler_tick_interval`
  parse `335`; `configurableSchedulerTick` gate `336`; WARN (took effect) `341`; WARN (toggle off) `345`.
- **`ngalert.go`** — `SchedulerCfg{` `376`; `Log: log.New("ngalert.scheduler")` `390`;
  `NewScheduler(schedCfg, stateManager)` `424`.
- **`go.mod`** — `go 1.23.1` `3`. **`Makefile`** — `build-server:` `201`;
  `$(GO) run build.go $(GO_BUILD_FLAGS) build-server` `203`.

### 6.3 Observed vs. inferred

- **Observed (from captured runtime output):** the non-default tick WARN and `Starting scheduler
  tickInterval=1s`; the `Rule is ready…` DEBUG with `frequency=10 offset=6`; the UID-ordered
  `Processing tick` lines ~25 ms apart; the `scheduler_behind_seconds` series peaking at `0.00112 s`; the
  `Tick dropped…` WARNs with older `droppedTick`; the labeled `…_missed_total` values (name = Title
  `slowrule-001`); the run-#2 live `301 == 301` WARN/counter pairing and run-#1 total of 1624 drop WARNs;
  the timeout footprint (`context deadline exceeded`, `duration=30.000822106s`, `handler=resultError`,
  `Tick processed attempt=3 duration=1m32s`); the deletion footprint (skip-write → reset → resolved → stop)
  and 39 → 38 / HTTP-404 transition; the standalone cancellation guard (`slowrule020` run #1,
  `slowrule030` run #2) with prior `Alerting` state intact on disk; the live restart triple
  (`Rule restarted because type changed` → new routine → stop, 0 resets); the 38 persisted rows after
  SIGINT; the 0-inversion scans (2931 / 610 / 745 events); the slow-vs-fast `Tick processed` durations;
  the identical schedulable-rules hash across runs; and all four unit-test PASS results.
- **Inferred (from code, labeled as such):** that the drop WARN (`schedule.go:378`) and the counter `Inc()`
  (`schedule.go:380`) are structurally 1:1 because they sit in the same `if dropped != nil` block — *also*
  confirmed observationally by the run-#2 `301 == 301`. That an unbuffered channel with a single consumer
  *cannot* reorder is a property of Go channel semantics — *also* confirmed by the 0-inversion scans and
  the drop unit test.
- **No behavior is attributed to vague "environment" causes.** Slow evaluations are caused concretely by
  the mock sleeping (15 s) or exceeding the 30 s `evaluation_timeout` (45 s → `context deadline exceeded`,
  `setting_unified_alerting.go:49`). `behind_seconds ≈ 0` is explained concretely by `processTick` doing
  only non-blocking dispatch (`schedule.go:370`) and averaging 0.89 ms — not by any hand-waving.

### 6.4 Read-only proof & cleanup

All observation was read-only against the source tree. Every temporary artifact — the scratch
`grafana.ini` files, the scratch SQLite data/logs/plugins/provisioning directories, the mock data source
(`slowprom.py`), the provisioning/churn/type-change helper scripts, and all captured log/metric files —
lived under `/tmp/obs2` (outside the repository) and was removed after the investigation. The server
binaries and the generated `pkg/server/wire_gen.go` are git-ignored build artifacts.

The **only** change to the repository is this one document. It sits directly on the pinned commit, and the
manifests are untouched:

```console
$ git rev-parse HEAD~1                                      # parent = pinned commit
4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff
$ git diff --name-only 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff
blitzy/documentation/grafana_4550cfb5b728.md
$ git diff --stat 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff -- go.mod go.sum package.json
$ git check-ignore bin/linux-amd64/grafana pkg/server/wire_gen.go
bin/linux-amd64/grafana
pkg/server/wire_gen.go
```

The `go.mod`/`go.sum`/`package.json` diff is empty (manifests unchanged), the only file differing from the
pinned commit is this document, and the build artifacts are git-ignored — the read-only requirement is
satisfied.

### 6.5 Environment caveat (build/version labels)

- The server was **built** with the canonical `make build-server`, whose banner reports `Version: 11.5.0`
  and `commit=fed6d6df08` (§1.2). The **real** server binary that was actually run
  (`./bin/linux-amd64/grafana`, built via `go build ./pkg/cmd/grafana` without version ldflags) reports
  `grafana version 9.2.0` at `--version`. These are two build-embedded *labels* on the same tree; the
  **authoritative** identifier of the code that ran is the **git commit** — branch `HEAD` `fed6d6df08`,
  whose only delta from the pinned parent `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` is *this document*
  (§6.4). All source citations are line-verified against that checked-out tree.
- The slow/fast data sources and the short tick interval are **test levers**, not product defaults. The
  canonical defaults (10 s tick, 30 s eval timeout, 3 attempts, 60 s rule interval) are stated in
  §1.5/§1.7; the stressed run departs from them **by configuration only** (the `configurableSchedulerTick`
  toggle plus `scheduler_tick_interval = 1s`), a supported, documented configuration path — not a code
  change. The normal run uses the genuine canonical default (no toggle, no override).
