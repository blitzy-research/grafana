# Grafana Runtime Investigation — Internal Health & Background Activity

This document answers five runtime questions about how a running Grafana server manages its
internal health and background activity. Every answer was produced by **building, running, and
exercising the software first**, then capturing the **actual, unedited output**. Each answer leads
with the direct result, embeds the exact command and complete output that produced it, cites the
responsible code by `file:line` and by named symbol, and explains the rationale.

The investigation is **read-only**: no repository file was modified. All runtime artifacts
(scratch database, logs, and one temporary observation test) were written outside the repository
tree (under `/tmp/investigation/`) or removed afterward, leaving the working tree clean apart from
this document.

---

## Investigation environment & how the software was built and run

**Repository under test**

| Item                                      | Value                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| Project                                   | Grafana (monorepo: Go backend under `pkg/`, React/TypeScript frontend under `public/app/`) |
| Branch                                    | `grafana_4550cfb5b728` (the deliverable filename derives from this branch)                 |
| HEAD commit                               | `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`                                                 |
| Application version under test (observed) | `11.5.0-pre`                                                                               |

> Note on branch naming: `grafana_4550cfb5b728` is the logical source-branch name from which this
> document's filename derives. The binary under test was compiled on the concrete working branch
> `blitzy-4620db6d-41d6-422c-ac3b-f1e9ae4830e1`, so the startup banner captured for Q3 faithfully
> reports `branch=blitzy-4620db6d-41d6-422c-ac3b-f1e9ae4830e1`. Both refer to the same HEAD commit
> `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`.

**Toolchain (observed values)**

```
$ go version
go version go1.23.1 linux/amd64

$ gcc --version | head -1
gcc (Ubuntu 15.2.0-4ubuntu4) 15.2.0

$ node -v
v22.23.1

$ yarn --version
4.5.3
```

Notes: Go 1.23.1 matches `go.mod:L3` (`go 1.23.1`). GCC is required for the Cgo build of the
embedded SQLite default database (`grafana.db`). The repository pins Node `v22.11.0` in `.nvmrc:L1`;
the running host provides `v22.23.1` (which satisfies `package.json` `engines` `>= 22`), and
`.nvmrc` was **not** modified. Yarn `4.5.3` matches `package.json` `packageManager: "yarn@4.5.3"`
(via Corepack).

**Canonical build (drives Q3)**

The backend was built canonically with `make build-backend`, which runs the repository's own build
tool (`go run build.go … build-backend`). That tool reads the version from `package.json`
(`pkg/build/cmd.go:L55` `opts.version = packageJSON.Version`) and injects it into the binary at link
time (`pkg/build/cmd.go:L247` `-X main.version=%s`). The produced binary was verified directly:

```
$ ./bin/linux-amd64/grafana --version
grafana version 11.5.0-pre

$ make build-backend
build backend
go run build.go    build-backend
Version: 11.5.0, Linux Version: 11.5.0, Package Iteration: 1783483139pre
rm -r dist
rm -r tmp
rm -r /root/go/pkg/linux_amd64/github.com/grafana
building grafana ./pkg/cmd/grafana
rm -r ./bin/linux-amd64/grafana
rm -r ./bin/linux-amd64/grafana.md5
go build -ldflags -w -X main.version=11.5.0-pre -X main.commit=4550cfb5b7 -X main.buildstamp=1734099722 -X main.buildBranch=blitzy-4620db6d-41d6-422c-ac3b-f1e9ae4830e1 -o ./bin/linux-amd64/grafana ./pkg/cmd/grafana
go version
go version go1.23.1 linux/amd64
Targeting linux/amd64

real	3m22.335s
user	9m56.476s
sys	2m6.751s
BUILD_BACKEND_EXIT=0
```

The build tool link-stamps the binary with
`-X main.version=11.5.0-pre -X main.commit=4550cfb5b7 -X main.buildstamp=1734099722` — exactly the
values Q3 later reads back from the API. The binary under test was built at the investigation commit
`4550cfb5b7` and was deliberately **not** rebuilt during this investigation, so its stamped
`commit=4550cfb5b7` matches the HEAD commit recorded above.

This is the **default, canonical** value a normal user gets from a release-style build. A plain
`go run` path (`make run-go`, `Makefile:L236`) passes **no** ldflags and would instead report the
dev default `9.2.0` declared at `pkg/cmd/grafana/main.go:L17` — that dev value was **not** used for
any answer below and is labeled as non-canonical wherever it is mentioned.

**Server invocation (drives Q1–Q3)**

The server was run from the repository root so it reads the default configuration
(`conf/defaults.ini`: `app_mode = production` at `L7`, `http_port = 3000` at `L41`, `[log] level = info`
at `L1074` ⇒ default **INFO** log level). Data/logs/plugins were redirected outside the repository
tree to keep it clean:

```
BASE=/tmp/investigation

# (0) One-time: build a fresh schema from an empty data dir (drives the Q2 "before" state)
./bin/linux-amd64/grafana server --homepath="$PWD" \
    cfg:paths.data=$BASE/dataA cfg:paths.logs=$BASE/logsA cfg:paths.plugins=$BASE/pluginsA \
    > $BASE/runA_freshdb.log 2>&1 &
# ... waited for "HTTP Server Listen", then stopped it; $BASE/dataA now holds a migrated DB.
# Copied the migrated data dir for the second instance:  cp -r $BASE/dataA $BASE/data2

# (1) run1 — reuses the now-migrated dataA on the default port 3000 (drives Q2 performed=0 + Q3 API)
nohup ./bin/linux-amd64/grafana server --homepath="$PWD" \
    cfg:paths.data=$BASE/dataA cfg:paths.logs=$BASE/logs1 cfg:paths.plugins=$BASE/plugins1 \
    > $BASE/run1.log 2>&1 &        # PID 126070, address=[::]:3000

# (2) run2 — parallel, pure-idle reference on port 3001 (drives Q1 cadence stability)
nohup ./bin/linux-amd64/grafana server --homepath="$PWD" \
    cfg:server.http_port=3001 \
    cfg:paths.data=$BASE/data2 cfg:paths.logs=$BASE/logs2 cfg:paths.plugins=$BASE/plugins2 \
    > $BASE/run2.log 2>&1 &        # PID 126072, address=[::]:3001
```

Two idle instances were run in parallel to establish cadence stability for Q1. Both began their idle
window at `2026-07-08T05:41:47Z` (the instant each logged `HTTP Server Listen`) and each ran for
≈ 24 minutes:

| Run  | PID      | Port | Data dir           | Started (UTC)          | Requests during idle                                          |
| ---- | -------- | ---- | ------------------ | ---------------------- | ------------------------------------------------------------- |
| run1 | `126070` | 3000 | `dataA` (migrated) | `2026-07-08T05:41:47Z` | 4 deliberate curls (Q3 health/settings + Q5 Ruler), then idle |
| run2 | `126072` | 3001 | `data2` (migrated) | `2026-07-08T05:41:47Z` | **zero** (pure idle reference)                                |

**Methodology & honesty conventions**

- Backend questions (Q1–Q3) were answered from these running instances.
- Q1 additionally uses a pair of **extended (> 60-minute) pure-idle runs** — two instances on the
  canonical binary (`version=11.5.0-pre`), ports 3000/3001, `10:50:32Z` → `11:53:38Z` (≈ 63 min),
  data/logs redirected under `/tmp/investigation` — performed specifically to observe the 30-minute
  `infra.usagestats` cadence that the ≈ 24-minute runs above are too short to capture (see Q1's
  "Extended idle run"). The usage-stats cadence is set by `total_stats_collector_interval_seconds` and is
  independent of build stamping, so these runs are directly comparable to the runs above.
- Frontend questions (Q4–Q5) were answered by running the modules' own **Jest** tests through
  their real code paths (non-watch, `--ci`); Q5 additionally uses one temporary ad-hoc test
  (now deleted) that directly exercises the responsible functions.
- Byte-sensitive output (log lines, JSON) is quoted from the exact emitted bytes.
- Any claim that comes from **reading** code rather than observing it is explicitly labeled
  **(inferred)**.

---

## Q1 — "After the server has been running for at least 60 seconds with no user requests, what are the exact recurring log entries that appear? Provide the actual log output as runtime evidence."

### Direct answer

At the default **INFO** log level an idle Grafana server is almost silent. Distinguishing
**recurring** entries (what the question asks for) from one-time startup lines, the answer is:

**Three INFO log entries _recur_ on a fixed cadence — two every 10 minutes and one every 30 minutes:**

- `msg="Completed cleanup jobs"` (`logger=cleanup`) — the background cleanup service (**10-minute** cadence).
- `msg="Update check succeeded"` (`logger=plugins.update.checker`) — the plugin update checker (**10-minute** cadence).
- `msg="Usage stats are ready to report"` (`logger=infra.usagestats`) — the usage-stats collector (**30-minute** cadence).

The 10-minute cadence was **stable across two independent runs**: the measured cleanup interval was
`599.99 s` (run1) / `599.99 s` (run2), and the plugin-update-checker interval was `600.05 s`/`599.98 s`
(run1) and `600.03 s`/`600.00 s` (run2) — all within a few tens of milliseconds of the nominal 600 s.
The 30-minute usage-stats cadence was likewise **stable across two independent extended idle runs**,
each showing two consecutive `1800.00 s` intervals (`1800.002 s` then `1800.000 s` in *both* runs — see
the "Extended idle run" evidence below).

Two clarifications about the ≥ 60-second window the question specifies:

1. **Neither 10-minute entry has fired yet inside the first 60 seconds.** The first cleanup tick and the
   first *recurring* plugin-checker tick both land ~10 minutes after boot, so within the strict
   first-60-second window neither of the two 10-minute lines appears (the rest of the INFO stream at that
   point is one-time startup lines, which settle at ~`t+0`).
2. **The 30-minute usage-stats line is the one recurring entry whose _first_ occurrence can appear at/near
   the 60-second mark:** `msg="Usage stats are ready to report"` (`logger=infra.usagestats`). Its **first**
   occurrence lands at a **randomized 30–120 s** offset after startup — observed at `+58.0 s` in run2 and
   `+63.0 s` in run1 (original runs), and at `+54.0 s` (inside the window) and `+118.0 s` (just outside it)
   in the two extended idle runs. After that first tick it **recurs every 30 minutes** (see the "Extended
   idle run" evidence below); it is therefore a genuine recurring entry, not a one-time signal. Observing
   the recurrence requires an idle window longer than 30 minutes: the ≈ 24-minute runs used for Q1's
   10-minute cadence capture only the first usage-stats occurrence, which is why the extended (> 60-minute)
   idle runs below were performed.

### Runtime evidence

Both servers were left idle for ≈ 24 minutes. The pure-idle instance (run2, zero inbound requests)
is the canonical reference; run1 corroborates.

**Confirm the run was genuinely idle (zero inbound HTTP requests):**

```
$ grep -cE "logger=context|method=GET|method=POST|status=" /tmp/investigation/run2.log
0
```

(The same grep against `run1.log` returns `4`, accounting for the four deliberate curls used for the
Q3 API capture and the Q5 Ruler round-trip — run1 is therefore not used as the idle reference.)

**The complete set of notable INFO lines emitted by the pure-idle run2 (startup → periodic ticks):**

```
$ grep "level=info" /tmp/investigation/run2.log | grep -E "HTTP Server Listen|Update check succeeded|Completed cleanup jobs|Usage stats are ready"
logger=http.server t=2026-07-08T05:41:47.261314683Z level=info msg="HTTP Server Listen" address=[::]:3001 protocol=http subUrl= socket=
logger=plugins.update.checker t=2026-07-08T05:41:47.291152539Z level=info msg="Update check succeeded" duration=32.23827ms
logger=grafana.update.checker t=2026-07-08T05:41:47.293541783Z level=info msg="Update check succeeded" duration=34.620117ms
logger=infra.usagestats t=2026-07-08T05:42:45.26096101Z level=info msg="Usage stats are ready to report"
logger=cleanup t=2026-07-08T05:51:47.281188628Z level=info msg="Completed cleanup jobs" duration=21.43548ms
logger=plugins.update.checker t=2026-07-08T05:51:47.321291906Z level=info msg="Update check succeeded" duration=29.127095ms
logger=cleanup t=2026-07-08T06:01:47.270212733Z level=info msg="Completed cleanup jobs" duration=11.081488ms
logger=plugins.update.checker t=2026-07-08T06:01:47.323588687Z level=info msg="Update check succeeded" duration=32.293209ms
```

**Isolating the recurring `"Completed cleanup jobs"` line and measuring its cadence in both runs:**

```
$ grep "Completed cleanup jobs" /tmp/investigation/run1.log
logger=cleanup t=2026-07-08T05:51:47.281380027Z level=info msg="Completed cleanup jobs" duration=19.183881ms
logger=cleanup t=2026-07-08T06:01:47.27118049Z level=info msg="Completed cleanup jobs" duration=9.210017ms

$ grep "Completed cleanup jobs" /tmp/investigation/run2.log
logger=cleanup t=2026-07-08T05:51:47.281188628Z level=info msg="Completed cleanup jobs" duration=21.43548ms
logger=cleanup t=2026-07-08T06:01:47.270212733Z level=info msg="Completed cleanup jobs" duration=11.081488ms
```

Interval between consecutive occurrences:

| Run              | 1st occurrence       | 2nd occurrence       | Interval                    |
| ---------------- | -------------------- | -------------------- | --------------------------- |
| run1 (port 3000) | `05:51:47.281380027` | `06:01:47.27118049` | **599.99 s (10.00 min)** |
| run2 (port 3001) | `05:51:47.281188628` | `06:01:47.270212733` | **599.99 s (10.00 min)** |

The plugin update checker recurs on the same cadence (it additionally fires once at startup, so three
occurrences appear in a ~24-minute window):

```
$ grep "logger=plugins.update.checker" /tmp/investigation/run1.log
logger=plugins.update.checker t=2026-07-08T05:41:47.325481282Z level=info msg="Update check succeeded" duration=63.802873ms
logger=plugins.update.checker t=2026-07-08T05:51:47.375202739Z level=info msg="Update check succeeded" duration=48.698711ms
logger=plugins.update.checker t=2026-07-08T06:01:47.356381183Z level=info msg="Update check succeeded" duration=30.47596ms

$ grep "logger=plugins.update.checker" /tmp/investigation/run2.log
logger=plugins.update.checker t=2026-07-08T05:41:47.291152539Z level=info msg="Update check succeeded" duration=32.23827ms
logger=plugins.update.checker t=2026-07-08T05:51:47.321291906Z level=info msg="Update check succeeded" duration=29.127095ms
logger=plugins.update.checker t=2026-07-08T06:01:47.323588687Z level=info msg="Update check succeeded" duration=32.293209ms
```

Its intervals were `600.05 s`/`599.98 s` (run1) and `600.03 s`/`600.00 s` (run2).

**Run durations used (10-minute cadences):** both runs above ran ≈ 24 minutes (idle window
`05:41:47Z` → ~`06:05:47Z`; run1.log = 102 lines, run2.log = 71 lines total — themselves evidence of
how sparse an idle INFO stream is). A ≥ 60 s window proves idleness; a > 10 min window is required to
witness the first cleanup tick, and > 20 min to measure the interval between two consecutive 10-minute
ticks (done above — two ticks per run).

**Extended idle run (30-minute usage-stats cadence).** The ≈ 24-minute runs above are long enough to
measure the two 10-minute cadences but too short to capture a *second* `infra.usagestats` tick (its
cadence is 30 minutes). Two additional pure-idle instances were therefore run — on the canonical binary
(`version=11.5.0-pre`), ports 3000 and 3001, with data/logs/plugins redirected under `/tmp/investigation`
— for **63.1 minutes** (`10:50:32Z` → `11:53:38Z`), specifically to observe the recurrence. The
usage-stats cadence derives solely from `total_stats_collector_interval_seconds` (default `1800`) and is
independent of link-time build stamping, so these runs are directly comparable to the runs above.

Both extended instances were genuinely idle (zero inbound HTTP requests) and each emitted only 77 log
lines over the full 63 minutes:

```
$ grep -cE "logger=context|method=GET|method=POST|status=" /tmp/investigation/idle1.log
0
$ grep -cE "logger=context|method=GET|method=POST|status=" /tmp/investigation/idle2.log
0
```

The `infra.usagestats` line recurs three times per run — i.e. two consecutive 30-minute intervals:

```
$ grep "Usage stats are ready to report" /tmp/investigation/idle2.log
logger=infra.usagestats t=2026-07-08T10:52:30.734271555Z level=info msg="Usage stats are ready to report"
logger=infra.usagestats t=2026-07-08T11:22:30.735795343Z level=info msg="Usage stats are ready to report"
logger=infra.usagestats t=2026-07-08T11:52:30.73594465Z level=info msg="Usage stats are ready to report"

$ grep "Usage stats are ready to report" /tmp/investigation/idle1.log
logger=infra.usagestats t=2026-07-08T10:51:26.734078329Z level=info msg="Usage stats are ready to report"
logger=infra.usagestats t=2026-07-08T11:21:26.73622786Z level=info msg="Usage stats are ready to report"
logger=infra.usagestats t=2026-07-08T11:51:26.736005651Z level=info msg="Usage stats are ready to report"
```

Interval between consecutive occurrences (two intervals per run):

| Run               | 1st → 2nd               | 2nd → 3rd               | Both intervals                          |
| ----------------- | ----------------------- | ----------------------- | --------------------------------------- |
| idle1 (port 3000) | `10:51:26` → `11:21:26` | `11:21:26` → `11:51:26` | **1800.002 s / 1800.000 s (30.00 min)** |
| idle2 (port 3001) | `10:52:30` → `11:22:30` | `11:22:30` → `11:52:30` | **1800.002 s / 1800.000 s (30.00 min)** |

The two 10-minute lines recur throughout this same 63-minute window as well (six cleanup ticks and
seven plugin-checker occurrences per run), confirming those cadences over a longer horizon too:

```
$ grep -c "Completed cleanup jobs" /tmp/investigation/idle2.log
6
$ grep -c "logger=plugins.update.checker" /tmp/investigation/idle2.log
7
```

A per-message recurrence scan of the extended idle stream confirms **exactly these three** INFO
messages recur on a fixed cadence; every other message with more than one occurrence is a simultaneous
startup burst with a sub-second span (e.g. the `migrator` and `resource-migrator` scopes each logging
`Starting DB migrations`/`migrations completed` once at boot, ~0.2 s apart). The transient
`sqlstore.transactions` `"Database locked, sleeping then retrying"` retry — which can appear under
momentary SQLite write contention — did **not** occur at all in either extended idle run (`grep -c` =
`0`), confirming it is load-dependent rather than a ticker-driven recurring entry.

### Responsible code

- **`CleanUpService.clean()`** — `pkg/services/cleanup/cleanup.go:L128`
  `logger.Info("Completed cleanup jobs", "duration", time.Since(start))`. It is invoked from
  **`CleanUpService.Run()`** (`pkg/services/cleanup/cleanup.go:L77`) on a ticker created at
  `pkg/services/cleanup/cleanup.go:L80` `ticker := time.NewTicker(time.Minute * 10)` (the enclosing
  `for { select { case <-ticker.C: srv.clean(ctx) … } }`). Logger scope `"cleanup"` is set at
  `pkg/services/cleanup/cleanup.go:L56` `log.New("cleanup")`.
  Note: `Run()` calls `srv.cleanUpTmpFiles(ctx)` **once immediately** at `L78`, but that path does
  **not** emit the completion line; only the ticker-driven `clean()` does — which is why the first
  `"Completed cleanup jobs"` appears ~10 minutes after startup, not at boot.
- **Plugin update checker** — the INFO line is emitted by
  **`PluginsService.instrumentedCheckForUpdates()`** at `pkg/services/updatechecker/plugins.go:L123`
  `ctxLogger.Info("Update check succeeded", "duration", time.Since(start))`, driven by the 10-minute
  ticker created in **`PluginsService.Run()`** at `pkg/services/updatechecker/plugins.go:L78`
  `ticker := time.NewTicker(time.Minute * 10)`, under `logger=plugins.update.checker`.
- **Usage-stats readiness line** — `msg="Usage stats are ready to report"` is emitted by
  **`UsageStats.SetReadyToReport()`** at `pkg/infra/usagestats/service/service.go:L116`
  (`uss.log.Info("Usage stats are ready to report")` at `:L117`), under `logger=infra.usagestats`. Its
  **30-minute recurrence** is driven by the stats collector **`statscollector.Service.Run()`**
  (`pkg/infra/usagestats/statscollector/service.go:L106`): the loop's `sendInterval` is
  `MetricsTotalStatsIntervalSeconds` (`:L107`), whose default is **1800 s** (`conf/defaults.ini:L1592`
  `total_stats_collector_interval_seconds = 1800`, read by `pkg/setting/setting.go:L1153`
  `MustInt(1800)`). The **first** tick fires after a randomized initial delay computed at `:L108`
  (`nextSendInterval := time.Duration(rand.Intn(maxDelay-minDelay)+minDelay) * time.Second`, with
  `minDelay = 30`/`maxDelay = 120` at `:L28`/`:L29` ⇒ 30–119 s). Each tick calls
  `s.updateTotalStats(ctx)` (`:L116`), and **after the first tick the ticker is re-armed to the 1800 s
  `sendInterval`** (`:L120` `updateStatsTicker.Reset(nextSendInterval)`) — which is exactly why the line
  **recurs every 30 minutes**. `updateTotalStats()` is what invokes `SetReadyToReport(ctx)` (`:L339`).
  Note the distinction from a *separate* loop, **`UsageStats.Run()`**
  (`pkg/infra/usagestats/service/service.go:L56`), which runs on a **24 h** `sendInterval` (`:L70`
  `sendInterval := time.Hour * 24`) and merely *sends* the collected stats (logging
  `Warn("Failed to send usage stats")` on failure at `:L90`); it does **not** emit the readiness line.
  The 30-minute recurrence therefore comes from the collector's ticker, not from the 24 h send loop.
- Background services are launched as goroutines by **`Server.Run()`** —
  `pkg/server/server.go:L139` (`func (s *Server) Run() error`); the launch loop uses an `errgroup`
  and skips disabled services (`pkg/server/server.go:L150` `registry.IsDisabled(svc)`,
  `L156` `s.childRoutines.Go(...)`).
- Default INFO level: `conf/defaults.ini:L1074` `level = info`.

### Rationale

The idle INFO stream is sparse **by design**: the default log level is INFO, and most periodic
background services log their per-tick activity at **DEBUG** (invisible at INFO). The three lines that
do surface are the ones whose services log at INFO on a ticker: the cleanup service and the plugin
update checker, each on a 10-minute `time.NewTicker(time.Minute * 10)`, and the usage-stats collector on
a 30-minute ticker (`total_stats_collector_interval_seconds`, default 1800 s). The exact 10.00-minute
and 30.00-minute spacings follow directly from those ticker intervals. The first cleanup occurrence lands
~10 minutes after boot because the completion message is emitted only from the ticker branch; the
usage-stats line's first occurrence instead lands at a randomized 30–120 s offset — because its collector
ticker starts with a random initial delay — and then recurs every 30 minutes once that ticker is re-armed
to the fixed 1800 s interval.

### Secondary / edge conditions (enumerated and observed)

- **One-time startup INFO lines (NOT recurring)** — present once at boot, then never again:
  `msg="Starting Grafana"` (`logger=settings`, `pkg/setting/setting.go:L940`),
  `msg="App mode production"`, `msg=FeatureToggles …`, `msg="Connecting to DB"`, the migrator lines
  (see Q2), `msg="HTTP Server Listen"`, and the alerting scheduler start line:

  ```
  logger=ngalert.scheduler t=2026-07-08T05:41:47.259172886Z level=info msg="Starting scheduler" tickInterval=10s maxAttempts=3
  ```

  The scheduler ticks every 10 s, but its **per-tick** logging is DEBUG
  (`pkg/services/ngalert/schedule/schedule.go:L374`), so at INFO you see only the single startup line
  (`pkg/services/ngalert/schedule/schedule.go:L157` `sch.log.Info("Starting scheduler", ...)`) — not a
  recurring entry.

- **Two distinct `infra.usagestats` loops (only one produces the recurring readiness line).** The
  recurring 30-minute `msg="Usage stats are ready to report"` line is covered in the direct answer,
  runtime evidence, and responsible-code sections above; the edge-condition nuance worth enumerating here
  is that usage-stats runs **two** independent loops. The **stats collector**
  (`statscollector.Service.Run()`, `pkg/infra/usagestats/statscollector/service.go:L106`) drives the
  readiness line on the 30-minute `total_stats_collector_interval_seconds` ticker — its first tick fires
  at the randomized 30–120 s offset (`:L108`, `minDelay = 30`/`maxDelay = 120` at `:L28`/`:L29`), then the
  ticker is re-armed to the fixed 1800 s interval (`:L120`), with each tick calling `updateTotalStats()`
  (`:L116`) → `SetReadyToReport()` (`:L339`). A **separate** send loop (`UsageStats.Run()`,
  `pkg/infra/usagestats/service/service.go:L56`) runs on a **24 h** interval (`:L70`
  `sendInterval := time.Hour * 24`) and only *sends* the collected stats — logging
  `msg="Failed to send usage stats"` (Warn) on failure (`:L90`), which does not surface at INFO on an
  idle host. It is the collector's 30-minute ticker, **not** this 24 h send loop, that produces the
  recurring readiness line.
- **Longer-cadence (24 h) INFO line** that fires once in this ~24-minute window and would only recur
  after a day: `logger=grafana.update.checker msg="Update check succeeded"`, driven by a 24 h ticker
  (`pkg/services/updatechecker/grafana.go:L63` `time.NewTicker(time.Hour * 24)`) and emitted by
  **`GrafanaService.instrumentedCheckForUpdates()`** at `pkg/services/updatechecker/grafana.go:L89`;
  observed once at startup only (run2 `05:41:47.293541783`, run1 `05:41:47.32600732`).
- **DEBUG-only / conditional periodic services** (explain why they are absent from the INFO idle
  stream): ngalert per-tick (10 s, DEBUG); auth token cleanup (1 h, DEBUG,
  `pkg/services/auth/authimpl/token_cleanup.go:L11`); remote-cache cleanup (10 min, DEBUG,
  `pkg/infra/remotecache/database_storage.go:L30`); provisioning dashboard file reader (default 10 s,
  DEBUG, and only when dashboard provisioning is configured — it was not here, so no ticks appeared
  at INFO — `pkg/services/provisioning/dashboards/file_reader.go:L81`).

---

## Q2 — "When the server starts what is the specific output that confirms that the schema version is up to date."

### Direct answer

The specific confirmation is the migrator's terminal summary line, emitted at INFO under
`logger=migrator`, reporting **`performed=0`**:

```
logger=migrator t=2026-07-08T05:41:47.137407162Z level=info msg="migrations completed" performed=0 skipped=626 duration=812.461µs
```

`performed=0` (with `skipped=626`, i.e. every known migration was already applied) is the precise
"schema is up to date / nothing to do" signal. The migrator runs on **every** startup; when the
schema is current it performs zero migrations and skips them all.

### Runtime evidence — the before/after boundary

To make the signal unambiguous, both state transitions were captured: a **fresh** database (schema
built from scratch → `performed > 0`), then a **second start against the same, now-migrated**
database (`performed = 0`).

**(a) Fresh database — migrations are executed (`performed=626`):**

The complete, unedited migrator output of the fresh run is reproduced below (no lines elided). It
comprises 1296 log lines in total. Across the two migrator scopes there are 644 `"Executing
migration"` and 641 `"Migration successfully executed"` INFO lines; the primary `logger=migrator`
performs 626 migrations — bracketed by its `Locking database` / `Starting DB migrations` /
`migrations completed performed=626` / `Unlocking database` lines — followed by the separate
`logger=resource-migrator` block (18 migrations, ending in `performed=18`):

```
$ grep "logger=migrator\|logger=resource-migrator" /tmp/investigation/runA_freshdb.log
logger=migrator t=2026-07-08T05:41:17.342229702Z level=info msg="Locking database"
logger=migrator t=2026-07-08T05:41:17.34225389Z level=info msg="Starting DB migrations"
logger=migrator t=2026-07-08T05:41:17.342576611Z level=info msg="Executing migration" id="create migration_log table"
logger=migrator t=2026-07-08T05:41:17.342885083Z level=info msg="Migration successfully executed" id="create migration_log table" duration=305.883µs
logger=migrator t=2026-07-08T05:41:17.410929314Z level=info msg="Executing migration" id="create user table"
logger=migrator t=2026-07-08T05:41:17.411229391Z level=info msg="Migration successfully executed" id="create user table" duration=304.334µs
logger=migrator t=2026-07-08T05:41:17.416467074Z level=info msg="Executing migration" id="add unique index user.login"
logger=migrator t=2026-07-08T05:41:17.416741283Z level=info msg="Migration successfully executed" id="add unique index user.login" duration=275.902µs
logger=migrator t=2026-07-08T05:41:17.422174594Z level=info msg="Executing migration" id="add unique index user.email"
logger=migrator t=2026-07-08T05:41:17.422407273Z level=info msg="Migration successfully executed" id="add unique index user.email" duration=233.207µs
logger=migrator t=2026-07-08T05:41:17.424779076Z level=info msg="Executing migration" id="drop index UQE_user_login - v1"
logger=migrator t=2026-07-08T05:41:17.424996028Z level=info msg="Migration successfully executed" id="drop index UQE_user_login - v1" duration=216.688µs
logger=migrator t=2026-07-08T05:41:17.428676038Z level=info msg="Executing migration" id="drop index UQE_user_email - v1"
logger=migrator t=2026-07-08T05:41:17.428902693Z level=info msg="Migration successfully executed" id="drop index UQE_user_email - v1" duration=227.155µs
logger=migrator t=2026-07-08T05:41:17.431895632Z level=info msg="Executing migration" id="Rename table user to user_v1 - v1"
logger=migrator t=2026-07-08T05:41:17.432356036Z level=info msg="Migration successfully executed" id="Rename table user to user_v1 - v1" duration=459.97µs
logger=migrator t=2026-07-08T05:41:17.435442228Z level=info msg="Executing migration" id="create user table v2"
logger=migrator t=2026-07-08T05:41:17.435672248Z level=info msg="Migration successfully executed" id="create user table v2" duration=230.564µs
logger=migrator t=2026-07-08T05:41:17.439451562Z level=info msg="Executing migration" id="create index UQE_user_login - v2"
logger=migrator t=2026-07-08T05:41:17.439651128Z level=info msg="Migration successfully executed" id="create index UQE_user_login - v2" duration=200.038µs
logger=migrator t=2026-07-08T05:41:17.443298832Z level=info msg="Executing migration" id="create index UQE_user_email - v2"
logger=migrator t=2026-07-08T05:41:17.443556298Z level=info msg="Migration successfully executed" id="create index UQE_user_email - v2" duration=258.555µs
logger=migrator t=2026-07-08T05:41:17.446063152Z level=info msg="Executing migration" id="copy data_source v1 to v2"
logger=migrator t=2026-07-08T05:41:17.446211286Z level=info msg="Migration successfully executed" id="copy data_source v1 to v2" duration=148.604µs
logger=migrator t=2026-07-08T05:41:17.448300794Z level=info msg="Executing migration" id="Drop old table user_v1"
logger=migrator t=2026-07-08T05:41:17.448478379Z level=info msg="Migration successfully executed" id="Drop old table user_v1" duration=178.124µs
logger=migrator t=2026-07-08T05:41:17.450587568Z level=info msg="Executing migration" id="Add column help_flags1 to user table"
logger=migrator t=2026-07-08T05:41:17.450877189Z level=info msg="Migration successfully executed" id="Add column help_flags1 to user table" duration=288.983µs
logger=migrator t=2026-07-08T05:41:17.453033967Z level=info msg="Executing migration" id="Update user table charset"
logger=migrator t=2026-07-08T05:41:17.453058159Z level=info msg="Migration successfully executed" id="Update user table charset" duration=24.207µs
logger=migrator t=2026-07-08T05:41:17.455318808Z level=info msg="Executing migration" id="Add last_seen_at column to user"
logger=migrator t=2026-07-08T05:41:17.455653169Z level=info msg="Migration successfully executed" id="Add last_seen_at column to user" duration=334.104µs
logger=migrator t=2026-07-08T05:41:17.459513703Z level=info msg="Executing migration" id="Add missing user data"
logger=migrator t=2026-07-08T05:41:17.459701799Z level=info msg="Migration successfully executed" id="Add missing user data" duration=189.299µs
logger=migrator t=2026-07-08T05:41:17.462145044Z level=info msg="Executing migration" id="Add is_disabled column to user"
logger=migrator t=2026-07-08T05:41:17.462417515Z level=info msg="Migration successfully executed" id="Add is_disabled column to user" duration=272.087µs
logger=migrator t=2026-07-08T05:41:17.464675972Z level=info msg="Executing migration" id="Add index user.login/user.email"
logger=migrator t=2026-07-08T05:41:17.464950743Z level=info msg="Migration successfully executed" id="Add index user.login/user.email" duration=274.791µs
logger=migrator t=2026-07-08T05:41:17.467131806Z level=info msg="Executing migration" id="Add is_service_account column to user"
logger=migrator t=2026-07-08T05:41:17.467406014Z level=info msg="Migration successfully executed" id="Add is_service_account column to user" duration=273.961µs
logger=migrator t=2026-07-08T05:41:17.46953033Z level=info msg="Executing migration" id="Update is_service_account column to nullable"
logger=migrator t=2026-07-08T05:41:17.470237312Z level=info msg="Migration successfully executed" id="Update is_service_account column to nullable" duration=706.963µs
logger=migrator t=2026-07-08T05:41:17.472393985Z level=info msg="Executing migration" id="Add uid column to user"
logger=migrator t=2026-07-08T05:41:17.472584978Z level=info msg="Migration successfully executed" id="Add uid column to user" duration=191.174µs
logger=migrator t=2026-07-08T05:41:17.47480417Z level=info msg="Executing migration" id="Update uid column values for users"
logger=migrator t=2026-07-08T05:41:17.474870274Z level=info msg="Migration successfully executed" id="Update uid column values for users" duration=66.147µs
logger=migrator t=2026-07-08T05:41:17.477029429Z level=info msg="Executing migration" id="Add unique index user_uid"
logger=migrator t=2026-07-08T05:41:17.477188604Z level=info msg="Migration successfully executed" id="Add unique index user_uid" duration=158.975µs
logger=migrator t=2026-07-08T05:41:17.479477763Z level=info msg="Executing migration" id="update login field with orgid to allow for multiple service accounts with same name across orgs"
logger=migrator t=2026-07-08T05:41:17.479551848Z level=info msg="Migration successfully executed" id="update login field with orgid to allow for multiple service accounts with same name across orgs" duration=73.899µs
logger=migrator t=2026-07-08T05:41:17.48173152Z level=info msg="Executing migration" id="update service accounts login field orgid to appear only once"
logger=migrator t=2026-07-08T05:41:17.481830923Z level=info msg="Migration successfully executed" id="update service accounts login field orgid to appear only once" duration=99.36µs
logger=migrator t=2026-07-08T05:41:17.485180072Z level=info msg="Executing migration" id="update login and email fields to lowercase"
logger=migrator t=2026-07-08T05:41:17.485342521Z level=info msg="Migration successfully executed" id="update login and email fields to lowercase" duration=162.855µs
logger=migrator t=2026-07-08T05:41:17.487402187Z level=info msg="Executing migration" id="update login and email fields to lowercase2"
logger=migrator t=2026-07-08T05:41:17.487475049Z level=info msg="Migration successfully executed" id="update login and email fields to lowercase2" duration=72.775µs
logger=migrator t=2026-07-08T05:41:17.489518132Z level=info msg="Executing migration" id="create temp user table v1-7"
logger=migrator t=2026-07-08T05:41:17.489695879Z level=info msg="Migration successfully executed" id="create temp user table v1-7" duration=177.753µs
logger=migrator t=2026-07-08T05:41:17.491730599Z level=info msg="Executing migration" id="create index IDX_temp_user_email - v1-7"
logger=migrator t=2026-07-08T05:41:17.491900129Z level=info msg="Migration successfully executed" id="create index IDX_temp_user_email - v1-7" duration=167.332µs
logger=migrator t=2026-07-08T05:41:17.493954161Z level=info msg="Executing migration" id="create index IDX_temp_user_org_id - v1-7"
logger=migrator t=2026-07-08T05:41:17.494091237Z level=info msg="Migration successfully executed" id="create index IDX_temp_user_org_id - v1-7" duration=137.079µs
logger=migrator t=2026-07-08T05:41:17.496162828Z level=info msg="Executing migration" id="create index IDX_temp_user_code - v1-7"
logger=migrator t=2026-07-08T05:41:17.496336197Z level=info msg="Migration successfully executed" id="create index IDX_temp_user_code - v1-7" duration=174.995µs
logger=migrator t=2026-07-08T05:41:17.498360065Z level=info msg="Executing migration" id="create index IDX_temp_user_status - v1-7"
logger=migrator t=2026-07-08T05:41:17.498494088Z level=info msg="Migration successfully executed" id="create index IDX_temp_user_status - v1-7" duration=134.089µs
logger=migrator t=2026-07-08T05:41:17.500577871Z level=info msg="Executing migration" id="Update temp_user table charset"
logger=migrator t=2026-07-08T05:41:17.500597479Z level=info msg="Migration successfully executed" id="Update temp_user table charset" duration=19.915µs
logger=migrator t=2026-07-08T05:41:17.503556561Z level=info msg="Executing migration" id="drop index IDX_temp_user_email - v1"
logger=migrator t=2026-07-08T05:41:17.503778321Z level=info msg="Migration successfully executed" id="drop index IDX_temp_user_email - v1" duration=222.121µs
logger=migrator t=2026-07-08T05:41:17.506493841Z level=info msg="Executing migration" id="drop index IDX_temp_user_org_id - v1"
logger=migrator t=2026-07-08T05:41:17.506675047Z level=info msg="Migration successfully executed" id="drop index IDX_temp_user_org_id - v1" duration=181.33µs
logger=migrator t=2026-07-08T05:41:17.509127799Z level=info msg="Executing migration" id="drop index IDX_temp_user_code - v1"
logger=migrator t=2026-07-08T05:41:17.509273193Z level=info msg="Migration successfully executed" id="drop index IDX_temp_user_code - v1" duration=145.839µs
logger=migrator t=2026-07-08T05:41:17.511950095Z level=info msg="Executing migration" id="drop index IDX_temp_user_status - v1"
logger=migrator t=2026-07-08T05:41:17.512141642Z level=info msg="Migration successfully executed" id="drop index IDX_temp_user_status - v1" duration=192.103µs
logger=migrator t=2026-07-08T05:41:17.517296587Z level=info msg="Executing migration" id="Rename table temp_user to temp_user_tmp_qwerty - v1"
logger=migrator t=2026-07-08T05:41:17.517663098Z level=info msg="Migration successfully executed" id="Rename table temp_user to temp_user_tmp_qwerty - v1" duration=367.165µs
logger=migrator t=2026-07-08T05:41:17.519831759Z level=info msg="Executing migration" id="create temp_user v2"
logger=migrator t=2026-07-08T05:41:17.5200019Z level=info msg="Migration successfully executed" id="create temp_user v2" duration=170.239µs
logger=migrator t=2026-07-08T05:41:17.522719991Z level=info msg="Executing migration" id="create index IDX_temp_user_email - v2"
logger=migrator t=2026-07-08T05:41:17.522923774Z level=info msg="Migration successfully executed" id="create index IDX_temp_user_email - v2" duration=204.091µs
logger=migrator t=2026-07-08T05:41:17.525292171Z level=info msg="Executing migration" id="create index IDX_temp_user_org_id - v2"
logger=migrator t=2026-07-08T05:41:17.525449256Z level=info msg="Migration successfully executed" id="create index IDX_temp_user_org_id - v2" duration=157.516µs
logger=migrator t=2026-07-08T05:41:17.527881264Z level=info msg="Executing migration" id="create index IDX_temp_user_code - v2"
logger=migrator t=2026-07-08T05:41:17.528065793Z level=info msg="Migration successfully executed" id="create index IDX_temp_user_code - v2" duration=184.513µs
logger=migrator t=2026-07-08T05:41:17.530120787Z level=info msg="Executing migration" id="create index IDX_temp_user_status - v2"
logger=migrator t=2026-07-08T05:41:17.530279935Z level=info msg="Migration successfully executed" id="create index IDX_temp_user_status - v2" duration=159.462µs
logger=migrator t=2026-07-08T05:41:17.532872915Z level=info msg="Executing migration" id="copy temp_user v1 to v2"
logger=migrator t=2026-07-08T05:41:17.533011407Z level=info msg="Migration successfully executed" id="copy temp_user v1 to v2" duration=138.466µs
logger=migrator t=2026-07-08T05:41:17.535654529Z level=info msg="Executing migration" id="drop temp_user_tmp_qwerty"
logger=migrator t=2026-07-08T05:41:17.535852104Z level=info msg="Migration successfully executed" id="drop temp_user_tmp_qwerty" duration=198µs
logger=migrator t=2026-07-08T05:41:17.538272723Z level=info msg="Executing migration" id="Set created for temp users that will otherwise prematurely expire"
logger=migrator t=2026-07-08T05:41:17.538394651Z level=info msg="Migration successfully executed" id="Set created for temp users that will otherwise prematurely expire" duration=124.48µs
logger=migrator t=2026-07-08T05:41:17.540713828Z level=info msg="Executing migration" id="create star table"
logger=migrator t=2026-07-08T05:41:17.540895915Z level=info msg="Migration successfully executed" id="create star table" duration=182.768µs
logger=migrator t=2026-07-08T05:41:17.543230628Z level=info msg="Executing migration" id="add unique index star.user_id_dashboard_id"
logger=migrator t=2026-07-08T05:41:17.543467245Z level=info msg="Migration successfully executed" id="add unique index star.user_id_dashboard_id" duration=236.653µs
logger=migrator t=2026-07-08T05:41:17.546389771Z level=info msg="Executing migration" id="Add column dashboard_uid in star"
logger=migrator t=2026-07-08T05:41:17.546713281Z level=info msg="Migration successfully executed" id="Add column dashboard_uid in star" duration=323.595µs
logger=migrator t=2026-07-08T05:41:17.549027083Z level=info msg="Executing migration" id="Add column org_id in star"
logger=migrator t=2026-07-08T05:41:17.549230938Z level=info msg="Migration successfully executed" id="Add column org_id in star" duration=203.862µs
logger=migrator t=2026-07-08T05:41:17.552146738Z level=info msg="Executing migration" id="Add column updated in star"
logger=migrator t=2026-07-08T05:41:17.552350375Z level=info msg="Migration successfully executed" id="Add column updated in star" duration=203.786µs
logger=migrator t=2026-07-08T05:41:17.554591272Z level=info msg="Executing migration" id="add index in star table on dashboard_uid, org_id and user_id columns"
logger=migrator t=2026-07-08T05:41:17.554762735Z level=info msg="Migration successfully executed" id="add index in star table on dashboard_uid, org_id and user_id columns" duration=172.1µs
logger=migrator t=2026-07-08T05:41:17.557150308Z level=info msg="Executing migration" id="create org table v1"
logger=migrator t=2026-07-08T05:41:17.557316209Z level=info msg="Migration successfully executed" id="create org table v1" duration=166.083µs
logger=migrator t=2026-07-08T05:41:17.560040149Z level=info msg="Executing migration" id="create index UQE_org_name - v1"
logger=migrator t=2026-07-08T05:41:17.560211526Z level=info msg="Migration successfully executed" id="create index UQE_org_name - v1" duration=171.523µs
logger=migrator t=2026-07-08T05:41:17.562873646Z level=info msg="Executing migration" id="create org_user table v1"
logger=migrator t=2026-07-08T05:41:17.563054693Z level=info msg="Migration successfully executed" id="create org_user table v1" duration=181.006µs
logger=migrator t=2026-07-08T05:41:17.565652368Z level=info msg="Executing migration" id="create index IDX_org_user_org_id - v1"
logger=migrator t=2026-07-08T05:41:17.565837748Z level=info msg="Migration successfully executed" id="create index IDX_org_user_org_id - v1" duration=185.407µs
logger=migrator t=2026-07-08T05:41:17.568130172Z level=info msg="Executing migration" id="create index UQE_org_user_org_id_user_id - v1"
logger=migrator t=2026-07-08T05:41:17.568284443Z level=info msg="Migration successfully executed" id="create index UQE_org_user_org_id_user_id - v1" duration=154.261µs
logger=migrator t=2026-07-08T05:41:17.570350458Z level=info msg="Executing migration" id="create index IDX_org_user_user_id - v1"
logger=migrator t=2026-07-08T05:41:17.570501274Z level=info msg="Migration successfully executed" id="create index IDX_org_user_user_id - v1" duration=151.542µs
logger=migrator t=2026-07-08T05:41:17.572646963Z level=info msg="Executing migration" id="Update org table charset"
logger=migrator t=2026-07-08T05:41:17.57267348Z level=info msg="Migration successfully executed" id="Update org table charset" duration=27.317µs
logger=migrator t=2026-07-08T05:41:17.575684767Z level=info msg="Executing migration" id="Update org_user table charset"
logger=migrator t=2026-07-08T05:41:17.575757022Z level=info msg="Migration successfully executed" id="Update org_user table charset" duration=72.418µs
logger=migrator t=2026-07-08T05:41:17.579716137Z level=info msg="Executing migration" id="Migrate all Read Only Viewers to Viewers"
logger=migrator t=2026-07-08T05:41:17.579779713Z level=info msg="Migration successfully executed" id="Migrate all Read Only Viewers to Viewers" duration=64.975µs
logger=migrator t=2026-07-08T05:41:17.582130127Z level=info msg="Executing migration" id="create dashboard table"
logger=migrator t=2026-07-08T05:41:17.582356485Z level=info msg="Migration successfully executed" id="create dashboard table" duration=226.798µs
logger=migrator t=2026-07-08T05:41:17.584753948Z level=info msg="Executing migration" id="add index dashboard.account_id"
logger=migrator t=2026-07-08T05:41:17.584951532Z level=info msg="Migration successfully executed" id="add index dashboard.account_id" duration=196.824µs
logger=migrator t=2026-07-08T05:41:17.587283711Z level=info msg="Executing migration" id="add unique index dashboard_account_id_slug"
logger=migrator t=2026-07-08T05:41:17.587458958Z level=info msg="Migration successfully executed" id="add unique index dashboard_account_id_slug" duration=175.214µs
logger=migrator t=2026-07-08T05:41:17.589874991Z level=info msg="Executing migration" id="create dashboard_tag table"
logger=migrator t=2026-07-08T05:41:17.590018116Z level=info msg="Migration successfully executed" id="create dashboard_tag table" duration=143.638µs
logger=migrator t=2026-07-08T05:41:17.592438177Z level=info msg="Executing migration" id="add unique index dashboard_tag.dasboard_id_term"
logger=migrator t=2026-07-08T05:41:17.592665617Z level=info msg="Migration successfully executed" id="add unique index dashboard_tag.dasboard_id_term" duration=231.134µs
logger=migrator t=2026-07-08T05:41:17.595259798Z level=info msg="Executing migration" id="drop index UQE_dashboard_tag_dashboard_id_term - v1"
logger=migrator t=2026-07-08T05:41:17.595470618Z level=info msg="Migration successfully executed" id="drop index UQE_dashboard_tag_dashboard_id_term - v1" duration=211.573µs
logger=migrator t=2026-07-08T05:41:17.597947444Z level=info msg="Executing migration" id="Rename table dashboard to dashboard_v1 - v1"
logger=migrator t=2026-07-08T05:41:17.598469149Z level=info msg="Migration successfully executed" id="Rename table dashboard to dashboard_v1 - v1" duration=521.891µs
logger=migrator t=2026-07-08T05:41:17.600753888Z level=info msg="Executing migration" id="create dashboard v2"
logger=migrator t=2026-07-08T05:41:17.600942576Z level=info msg="Migration successfully executed" id="create dashboard v2" duration=188.471µs
logger=migrator t=2026-07-08T05:41:17.603573166Z level=info msg="Executing migration" id="create index IDX_dashboard_org_id - v2"
logger=migrator t=2026-07-08T05:41:17.603736729Z level=info msg="Migration successfully executed" id="create index IDX_dashboard_org_id - v2" duration=163.442µs
logger=migrator t=2026-07-08T05:41:17.606581592Z level=info msg="Executing migration" id="create index UQE_dashboard_org_id_slug - v2"
logger=migrator t=2026-07-08T05:41:17.606747918Z level=info msg="Migration successfully executed" id="create index UQE_dashboard_org_id_slug - v2" duration=166.933µs
logger=migrator t=2026-07-08T05:41:17.609388038Z level=info msg="Executing migration" id="copy dashboard v1 to v2"
logger=migrator t=2026-07-08T05:41:17.609506871Z level=info msg="Migration successfully executed" id="copy dashboard v1 to v2" duration=119.191µs
logger=migrator t=2026-07-08T05:41:17.612476982Z level=info msg="Executing migration" id="drop table dashboard_v1"
logger=migrator t=2026-07-08T05:41:17.612641314Z level=info msg="Migration successfully executed" id="drop table dashboard_v1" duration=164.606µs
logger=migrator t=2026-07-08T05:41:17.614993791Z level=info msg="Executing migration" id="alter dashboard.data to mediumtext v1"
logger=migrator t=2026-07-08T05:41:17.615028898Z level=info msg="Migration successfully executed" id="alter dashboard.data to mediumtext v1" duration=35.562µs
logger=migrator t=2026-07-08T05:41:17.617699347Z level=info msg="Executing migration" id="Add column updated_by in dashboard - v2"
logger=migrator t=2026-07-08T05:41:17.618129359Z level=info msg="Migration successfully executed" id="Add column updated_by in dashboard - v2" duration=429.268µs
logger=migrator t=2026-07-08T05:41:17.620443775Z level=info msg="Executing migration" id="Add column created_by in dashboard - v2"
logger=migrator t=2026-07-08T05:41:17.620701276Z level=info msg="Migration successfully executed" id="Add column created_by in dashboard - v2" duration=258.463µs
logger=migrator t=2026-07-08T05:41:17.627442171Z level=info msg="Executing migration" id="Add column gnetId in dashboard"
logger=migrator t=2026-07-08T05:41:17.627843334Z level=info msg="Migration successfully executed" id="Add column gnetId in dashboard" duration=401.936µs
logger=migrator t=2026-07-08T05:41:17.63034172Z level=info msg="Executing migration" id="Add index for gnetId in dashboard"
logger=migrator t=2026-07-08T05:41:17.630555012Z level=info msg="Migration successfully executed" id="Add index for gnetId in dashboard" duration=210.696µs
logger=migrator t=2026-07-08T05:41:17.633226836Z level=info msg="Executing migration" id="Add column plugin_id in dashboard"
logger=migrator t=2026-07-08T05:41:17.633493971Z level=info msg="Migration successfully executed" id="Add column plugin_id in dashboard" duration=269.923µs
logger=migrator t=2026-07-08T05:41:17.635799525Z level=info msg="Executing migration" id="Add index for plugin_id in dashboard"
logger=migrator t=2026-07-08T05:41:17.635991358Z level=info msg="Migration successfully executed" id="Add index for plugin_id in dashboard" duration=191.877µs
logger=migrator t=2026-07-08T05:41:17.638502468Z level=info msg="Executing migration" id="Add index for dashboard_id in dashboard_tag"
logger=migrator t=2026-07-08T05:41:17.638684918Z level=info msg="Migration successfully executed" id="Add index for dashboard_id in dashboard_tag" duration=182.711µs
logger=migrator t=2026-07-08T05:41:17.641730844Z level=info msg="Executing migration" id="Update dashboard table charset"
logger=migrator t=2026-07-08T05:41:17.641751658Z level=info msg="Migration successfully executed" id="Update dashboard table charset" duration=21.258µs
logger=migrator t=2026-07-08T05:41:17.643979761Z level=info msg="Executing migration" id="Update dashboard_tag table charset"
logger=migrator t=2026-07-08T05:41:17.643999052Z level=info msg="Migration successfully executed" id="Update dashboard_tag table charset" duration=19.49µs
logger=migrator t=2026-07-08T05:41:17.646047095Z level=info msg="Executing migration" id="Add column folder_id in dashboard"
logger=migrator t=2026-07-08T05:41:17.646313038Z level=info msg="Migration successfully executed" id="Add column folder_id in dashboard" duration=265.665µs
logger=migrator t=2026-07-08T05:41:17.648357687Z level=info msg="Executing migration" id="Add column isFolder in dashboard"
logger=migrator t=2026-07-08T05:41:17.648599371Z level=info msg="Migration successfully executed" id="Add column isFolder in dashboard" duration=241.495µs
logger=migrator t=2026-07-08T05:41:17.650613624Z level=info msg="Executing migration" id="Add column has_acl in dashboard"
logger=migrator t=2026-07-08T05:41:17.650874927Z level=info msg="Migration successfully executed" id="Add column has_acl in dashboard" duration=261.069µs
logger=migrator t=2026-07-08T05:41:17.652970809Z level=info msg="Executing migration" id="Add column uid in dashboard"
logger=migrator t=2026-07-08T05:41:17.653332682Z level=info msg="Migration successfully executed" id="Add column uid in dashboard" duration=361.616µs
logger=migrator t=2026-07-08T05:41:17.676345553Z level=info msg="Executing migration" id="Update uid column values in dashboard"
logger=migrator t=2026-07-08T05:41:17.67645895Z level=info msg="Migration successfully executed" id="Update uid column values in dashboard" duration=115.38µs
logger=migrator t=2026-07-08T05:41:17.679614897Z level=info msg="Executing migration" id="Add unique index dashboard_org_id_uid"
logger=migrator t=2026-07-08T05:41:17.67990679Z level=info msg="Migration successfully executed" id="Add unique index dashboard_org_id_uid" duration=293.397µs
logger=migrator t=2026-07-08T05:41:17.683355759Z level=info msg="Executing migration" id="Remove unique index org_id_slug"
logger=migrator t=2026-07-08T05:41:17.683646175Z level=info msg="Migration successfully executed" id="Remove unique index org_id_slug" duration=288.631µs
logger=migrator t=2026-07-08T05:41:17.6859336Z level=info msg="Executing migration" id="Update dashboard title length"
logger=migrator t=2026-07-08T05:41:17.685955332Z level=info msg="Migration successfully executed" id="Update dashboard title length" duration=22.232µs
logger=migrator t=2026-07-08T05:41:17.687999257Z level=info msg="Executing migration" id="Add unique index for dashboard_org_id_title_folder_id"
logger=migrator t=2026-07-08T05:41:17.688254775Z level=info msg="Migration successfully executed" id="Add unique index for dashboard_org_id_title_folder_id" duration=255.207µs
logger=migrator t=2026-07-08T05:41:17.690579677Z level=info msg="Executing migration" id="create dashboard_provisioning"
logger=migrator t=2026-07-08T05:41:17.690753772Z level=info msg="Migration successfully executed" id="create dashboard_provisioning" duration=173.18µs
logger=migrator t=2026-07-08T05:41:17.694216113Z level=info msg="Executing migration" id="Rename table dashboard_provisioning to dashboard_provisioning_tmp_qwerty - v1"
logger=migrator t=2026-07-08T05:41:17.694909602Z level=info msg="Migration successfully executed" id="Rename table dashboard_provisioning to dashboard_provisioning_tmp_qwerty - v1" duration=692.941µs
logger=migrator t=2026-07-08T05:41:17.697285038Z level=info msg="Executing migration" id="create dashboard_provisioning v2"
logger=migrator t=2026-07-08T05:41:17.697443411Z level=info msg="Migration successfully executed" id="create dashboard_provisioning v2" duration=158.392µs
logger=migrator t=2026-07-08T05:41:17.700127681Z level=info msg="Executing migration" id="create index IDX_dashboard_provisioning_dashboard_id - v2"
logger=migrator t=2026-07-08T05:41:17.700311208Z level=info msg="Migration successfully executed" id="create index IDX_dashboard_provisioning_dashboard_id - v2" duration=183.558µs
logger=migrator t=2026-07-08T05:41:17.703658772Z level=info msg="Executing migration" id="create index IDX_dashboard_provisioning_dashboard_id_name - v2"
logger=migrator t=2026-07-08T05:41:17.703863402Z level=info msg="Migration successfully executed" id="create index IDX_dashboard_provisioning_dashboard_id_name - v2" duration=204.871µs
logger=migrator t=2026-07-08T05:41:17.706553003Z level=info msg="Executing migration" id="copy dashboard_provisioning v1 to v2"
logger=migrator t=2026-07-08T05:41:17.706729155Z level=info msg="Migration successfully executed" id="copy dashboard_provisioning v1 to v2" duration=179.108µs
logger=migrator t=2026-07-08T05:41:17.709206042Z level=info msg="Executing migration" id="drop dashboard_provisioning_tmp_qwerty"
logger=migrator t=2026-07-08T05:41:17.709407244Z level=info msg="Migration successfully executed" id="drop dashboard_provisioning_tmp_qwerty" duration=200.721µs
logger=migrator t=2026-07-08T05:41:17.71249942Z level=info msg="Executing migration" id="Add check_sum column"
logger=migrator t=2026-07-08T05:41:17.712970045Z level=info msg="Migration successfully executed" id="Add check_sum column" duration=470.812µs
logger=migrator t=2026-07-08T05:41:17.716232728Z level=info msg="Executing migration" id="Add index for dashboard_title"
logger=migrator t=2026-07-08T05:41:17.716518919Z level=info msg="Migration successfully executed" id="Add index for dashboard_title" duration=286.888µs
logger=migrator t=2026-07-08T05:41:17.719162661Z level=info msg="Executing migration" id="delete tags for deleted dashboards"
logger=migrator t=2026-07-08T05:41:17.719241457Z level=info msg="Migration successfully executed" id="delete tags for deleted dashboards" duration=78.957µs
logger=migrator t=2026-07-08T05:41:17.72346174Z level=info msg="Executing migration" id="delete stars for deleted dashboards"
logger=migrator t=2026-07-08T05:41:17.723528492Z level=info msg="Migration successfully executed" id="delete stars for deleted dashboards" duration=66.993µs
logger=migrator t=2026-07-08T05:41:17.726707679Z level=info msg="Executing migration" id="Add index for dashboard_is_folder"
logger=migrator t=2026-07-08T05:41:17.726961233Z level=info msg="Migration successfully executed" id="Add index for dashboard_is_folder" duration=251.687µs
logger=migrator t=2026-07-08T05:41:17.729722106Z level=info msg="Executing migration" id="Add isPublic for dashboard"
logger=migrator t=2026-07-08T05:41:17.73016712Z level=info msg="Migration successfully executed" id="Add isPublic for dashboard" duration=445.632µs
logger=migrator t=2026-07-08T05:41:17.732559886Z level=info msg="Executing migration" id="Add deleted for dashboard"
logger=migrator t=2026-07-08T05:41:17.73295482Z level=info msg="Migration successfully executed" id="Add deleted for dashboard" duration=394.727µs
logger=migrator t=2026-07-08T05:41:17.735238993Z level=info msg="Executing migration" id="Add index for deleted"
logger=migrator t=2026-07-08T05:41:17.735458608Z level=info msg="Migration successfully executed" id="Add index for deleted" duration=219.938µs
logger=migrator t=2026-07-08T05:41:17.738032067Z level=info msg="Executing migration" id="Add missing dashboard_uid and org_id to star"
logger=migrator t=2026-07-08T05:41:17.738143816Z level=info msg="Migration successfully executed" id="Add missing dashboard_uid and org_id to star" duration=111.241µs
logger=migrator t=2026-07-08T05:41:17.74045525Z level=info msg="Executing migration" id="create data_source table"
logger=migrator t=2026-07-08T05:41:17.740737587Z level=info msg="Migration successfully executed" id="create data_source table" duration=283.045µs
logger=migrator t=2026-07-08T05:41:17.743547572Z level=info msg="Executing migration" id="add index data_source.account_id"
logger=migrator t=2026-07-08T05:41:17.743820613Z level=info msg="Migration successfully executed" id="add index data_source.account_id" duration=257.174µs
logger=migrator t=2026-07-08T05:41:17.74653546Z level=info msg="Executing migration" id="add unique index data_source.account_id_name"
logger=migrator t=2026-07-08T05:41:17.746778416Z level=info msg="Migration successfully executed" id="add unique index data_source.account_id_name" duration=242.362µs
logger=migrator t=2026-07-08T05:41:17.75003003Z level=info msg="Executing migration" id="drop index IDX_data_source_account_id - v1"
logger=migrator t=2026-07-08T05:41:17.750272031Z level=info msg="Migration successfully executed" id="drop index IDX_data_source_account_id - v1" duration=242.847µs
logger=migrator t=2026-07-08T05:41:17.752964179Z level=info msg="Executing migration" id="drop index UQE_data_source_account_id_name - v1"
logger=migrator t=2026-07-08T05:41:17.753163516Z level=info msg="Migration successfully executed" id="drop index UQE_data_source_account_id_name - v1" duration=201.191µs
logger=migrator t=2026-07-08T05:41:17.755597658Z level=info msg="Executing migration" id="Rename table data_source to data_source_v1 - v1"
logger=migrator t=2026-07-08T05:41:17.756617213Z level=info msg="Migration successfully executed" id="Rename table data_source to data_source_v1 - v1" duration=1.019028ms
logger=migrator t=2026-07-08T05:41:17.759087632Z level=info msg="Executing migration" id="create data_source table v2"
logger=migrator t=2026-07-08T05:41:17.759344853Z level=info msg="Migration successfully executed" id="create data_source table v2" duration=257.736µs
logger=migrator t=2026-07-08T05:41:17.762022363Z level=info msg="Executing migration" id="create index IDX_data_source_org_id - v2"
logger=migrator t=2026-07-08T05:41:17.762262052Z level=info msg="Migration successfully executed" id="create index IDX_data_source_org_id - v2" duration=239.63µs
logger=migrator t=2026-07-08T05:41:17.765673073Z level=info msg="Executing migration" id="create index UQE_data_source_org_id_name - v2"
logger=migrator t=2026-07-08T05:41:17.765930279Z level=info msg="Migration successfully executed" id="create index UQE_data_source_org_id_name - v2" duration=257.774µs
logger=migrator t=2026-07-08T05:41:17.768577693Z level=info msg="Executing migration" id="Drop old table data_source_v1 #2"
logger=migrator t=2026-07-08T05:41:17.768755319Z level=info msg="Migration successfully executed" id="Drop old table data_source_v1 #2" duration=173.54µs
logger=migrator t=2026-07-08T05:41:17.771515871Z level=info msg="Executing migration" id="Add column with_credentials"
logger=migrator t=2026-07-08T05:41:17.771963565Z level=info msg="Migration successfully executed" id="Add column with_credentials" duration=447.837µs
logger=migrator t=2026-07-08T05:41:17.774394156Z level=info msg="Executing migration" id="Add secure json data column"
logger=migrator t=2026-07-08T05:41:17.774834913Z level=info msg="Migration successfully executed" id="Add secure json data column" duration=440.625µs
logger=migrator t=2026-07-08T05:41:17.777164875Z level=info msg="Executing migration" id="Update data_source table charset"
logger=migrator t=2026-07-08T05:41:17.777196714Z level=info msg="Migration successfully executed" id="Update data_source table charset" duration=32.516µs
logger=migrator t=2026-07-08T05:41:17.779436076Z level=info msg="Executing migration" id="Update initial version to 1"
logger=migrator t=2026-07-08T05:41:17.779503936Z level=info msg="Migration successfully executed" id="Update initial version to 1" duration=66.892µs
logger=migrator t=2026-07-08T05:41:17.781703642Z level=info msg="Executing migration" id="Add read_only data column"
logger=migrator t=2026-07-08T05:41:17.782106234Z level=info msg="Migration successfully executed" id="Add read_only data column" duration=402.637µs
logger=migrator t=2026-07-08T05:41:17.78476771Z level=info msg="Executing migration" id="Migrate logging ds to loki ds"
logger=migrator t=2026-07-08T05:41:17.784838441Z level=info msg="Migration successfully executed" id="Migrate logging ds to loki ds" duration=70.649µs
logger=migrator t=2026-07-08T05:41:17.787112307Z level=info msg="Executing migration" id="Update json_data with nulls"
logger=migrator t=2026-07-08T05:41:17.787166009Z level=info msg="Migration successfully executed" id="Update json_data with nulls" duration=53.946µs
logger=migrator t=2026-07-08T05:41:17.789276902Z level=info msg="Executing migration" id="Add uid column"
logger=migrator t=2026-07-08T05:41:17.789691346Z level=info msg="Migration successfully executed" id="Add uid column" duration=414.047µs
logger=migrator t=2026-07-08T05:41:17.792069647Z level=info msg="Executing migration" id="Update uid value"
logger=migrator t=2026-07-08T05:41:17.792125084Z level=info msg="Migration successfully executed" id="Update uid value" duration=55.945µs
logger=migrator t=2026-07-08T05:41:17.7942733Z level=info msg="Executing migration" id="Add unique index datasource_org_id_uid"
logger=migrator t=2026-07-08T05:41:17.794504307Z level=info msg="Migration successfully executed" id="Add unique index datasource_org_id_uid" duration=230.52µs
logger=migrator t=2026-07-08T05:41:17.797146282Z level=info msg="Executing migration" id="add unique index datasource_org_id_is_default"
logger=migrator t=2026-07-08T05:41:17.797355906Z level=info msg="Migration successfully executed" id="add unique index datasource_org_id_is_default" duration=210.022µs
logger=migrator t=2026-07-08T05:41:17.800627004Z level=info msg="Executing migration" id="Add is_prunable column"
logger=migrator t=2026-07-08T05:41:17.801129388Z level=info msg="Migration successfully executed" id="Add is_prunable column" duration=503.111µs
logger=migrator t=2026-07-08T05:41:17.803507774Z level=info msg="Executing migration" id="Add api_version column"
logger=migrator t=2026-07-08T05:41:17.80395347Z level=info msg="Migration successfully executed" id="Add api_version column" duration=456.544µs
logger=migrator t=2026-07-08T05:41:17.806452524Z level=info msg="Executing migration" id="create api_key table"
logger=migrator t=2026-07-08T05:41:17.806698269Z level=info msg="Migration successfully executed" id="create api_key table" duration=245.954µs
logger=migrator t=2026-07-08T05:41:17.809621392Z level=info msg="Executing migration" id="add index api_key.account_id"
logger=migrator t=2026-07-08T05:41:17.8099074Z level=info msg="Migration successfully executed" id="add index api_key.account_id" duration=285.695µs
logger=migrator t=2026-07-08T05:41:17.812694873Z level=info msg="Executing migration" id="add index api_key.key"
logger=migrator t=2026-07-08T05:41:17.812932873Z level=info msg="Migration successfully executed" id="add index api_key.key" duration=237.94µs
logger=migrator t=2026-07-08T05:41:17.818413175Z level=info msg="Executing migration" id="add index api_key.account_id_name"
logger=migrator t=2026-07-08T05:41:17.818598149Z level=info msg="Migration successfully executed" id="add index api_key.account_id_name" duration=185.556µs
logger=migrator t=2026-07-08T05:41:17.822656547Z level=info msg="Executing migration" id="drop index IDX_api_key_account_id - v1"
logger=migrator t=2026-07-08T05:41:17.822857679Z level=info msg="Migration successfully executed" id="drop index IDX_api_key_account_id - v1" duration=201.28µs
logger=migrator t=2026-07-08T05:41:17.826709608Z level=info msg="Executing migration" id="drop index UQE_api_key_key - v1"
logger=migrator t=2026-07-08T05:41:17.826884299Z level=info msg="Migration successfully executed" id="drop index UQE_api_key_key - v1" duration=175.537µs
logger=migrator t=2026-07-08T05:41:17.829082477Z level=info msg="Executing migration" id="drop index UQE_api_key_account_id_name - v1"
logger=migrator t=2026-07-08T05:41:17.829241204Z level=info msg="Migration successfully executed" id="drop index UQE_api_key_account_id_name - v1" duration=158.928µs
logger=migrator t=2026-07-08T05:41:17.831750702Z level=info msg="Executing migration" id="Rename table api_key to api_key_v1 - v1"
logger=migrator t=2026-07-08T05:41:17.832423969Z level=info msg="Migration successfully executed" id="Rename table api_key to api_key_v1 - v1" duration=672.746µs
logger=migrator t=2026-07-08T05:41:17.834859145Z level=info msg="Executing migration" id="create api_key table v2"
logger=migrator t=2026-07-08T05:41:17.835022661Z level=info msg="Migration successfully executed" id="create api_key table v2" duration=163.547µs
logger=migrator t=2026-07-08T05:41:17.838169725Z level=info msg="Executing migration" id="create index IDX_api_key_org_id - v2"
logger=migrator t=2026-07-08T05:41:17.83833889Z level=info msg="Migration successfully executed" id="create index IDX_api_key_org_id - v2" duration=169.205µs
logger=migrator t=2026-07-08T05:41:17.843092882Z level=info msg="Executing migration" id="create index UQE_api_key_key - v2"
logger=migrator t=2026-07-08T05:41:17.843292733Z level=info msg="Migration successfully executed" id="create index UQE_api_key_key - v2" duration=200.37µs
logger=migrator t=2026-07-08T05:41:17.847165463Z level=info msg="Executing migration" id="create index UQE_api_key_org_id_name - v2"
logger=migrator t=2026-07-08T05:41:17.847347103Z level=info msg="Migration successfully executed" id="create index UQE_api_key_org_id_name - v2" duration=181.569µs
logger=migrator t=2026-07-08T05:41:17.850944334Z level=info msg="Executing migration" id="copy api_key v1 to v2"
logger=migrator t=2026-07-08T05:41:17.851056373Z level=info msg="Migration successfully executed" id="copy api_key v1 to v2" duration=106.932µs
logger=migrator t=2026-07-08T05:41:17.853226384Z level=info msg="Executing migration" id="Drop old table api_key_v1"
logger=migrator t=2026-07-08T05:41:17.853363687Z level=info msg="Migration successfully executed" id="Drop old table api_key_v1" duration=137.256µs
logger=migrator t=2026-07-08T05:41:17.85700203Z level=info msg="Executing migration" id="Update api_key table charset"
logger=migrator t=2026-07-08T05:41:17.857034428Z level=info msg="Migration successfully executed" id="Update api_key table charset" duration=33.512µs
logger=migrator t=2026-07-08T05:41:17.859653848Z level=info msg="Executing migration" id="Add expires to api_key table"
logger=migrator t=2026-07-08T05:41:17.860076035Z level=info msg="Migration successfully executed" id="Add expires to api_key table" duration=416.736µs
logger=migrator t=2026-07-08T05:41:17.862583172Z level=info msg="Executing migration" id="Add service account foreign key"
logger=migrator t=2026-07-08T05:41:17.862939713Z level=info msg="Migration successfully executed" id="Add service account foreign key" duration=357.072µs
logger=migrator t=2026-07-08T05:41:17.865182689Z level=info msg="Executing migration" id="set service account foreign key to nil if 0"
logger=migrator t=2026-07-08T05:41:17.865228423Z level=info msg="Migration successfully executed" id="set service account foreign key to nil if 0" duration=46.055µs
logger=migrator t=2026-07-08T05:41:17.867485438Z level=info msg="Executing migration" id="Add last_used_at to api_key table"
logger=migrator t=2026-07-08T05:41:17.867789482Z level=info msg="Migration successfully executed" id="Add last_used_at to api_key table" duration=304.001µs
logger=migrator t=2026-07-08T05:41:17.870029289Z level=info msg="Executing migration" id="Add is_revoked column to api_key table"
logger=migrator t=2026-07-08T05:41:17.870340577Z level=info msg="Migration successfully executed" id="Add is_revoked column to api_key table" duration=311.392µs
logger=migrator t=2026-07-08T05:41:17.8728908Z level=info msg="Executing migration" id="create dashboard_snapshot table v4"
logger=migrator t=2026-07-08T05:41:17.873073193Z level=info msg="Migration successfully executed" id="create dashboard_snapshot table v4" duration=182.894µs
logger=migrator t=2026-07-08T05:41:17.875689425Z level=info msg="Executing migration" id="drop table dashboard_snapshot_v4 #1"
logger=migrator t=2026-07-08T05:41:17.87588576Z level=info msg="Migration successfully executed" id="drop table dashboard_snapshot_v4 #1" duration=196.96µs
logger=migrator t=2026-07-08T05:41:17.87831039Z level=info msg="Executing migration" id="create dashboard_snapshot table v5 #2"
logger=migrator t=2026-07-08T05:41:17.878516319Z level=info msg="Migration successfully executed" id="create dashboard_snapshot table v5 #2" duration=206.055µs
logger=migrator t=2026-07-08T05:41:17.881089666Z level=info msg="Executing migration" id="create index UQE_dashboard_snapshot_key - v5"
logger=migrator t=2026-07-08T05:41:17.881280559Z level=info msg="Migration successfully executed" id="create index UQE_dashboard_snapshot_key - v5" duration=191.38µs
logger=migrator t=2026-07-08T05:41:17.883950153Z level=info msg="Executing migration" id="create index UQE_dashboard_snapshot_delete_key - v5"
logger=migrator t=2026-07-08T05:41:17.884119833Z level=info msg="Migration successfully executed" id="create index UQE_dashboard_snapshot_delete_key - v5" duration=170.315µs
logger=migrator t=2026-07-08T05:41:17.886568188Z level=info msg="Executing migration" id="create index IDX_dashboard_snapshot_user_id - v5"
logger=migrator t=2026-07-08T05:41:17.886732581Z level=info msg="Migration successfully executed" id="create index IDX_dashboard_snapshot_user_id - v5" duration=165.03µs
logger=migrator t=2026-07-08T05:41:17.890063153Z level=info msg="Executing migration" id="alter dashboard_snapshot to mediumtext v2"
logger=migrator t=2026-07-08T05:41:17.890094218Z level=info msg="Migration successfully executed" id="alter dashboard_snapshot to mediumtext v2" duration=32.04µs
logger=migrator t=2026-07-08T05:41:17.892831787Z level=info msg="Executing migration" id="Update dashboard_snapshot table charset"
logger=migrator t=2026-07-08T05:41:17.892868981Z level=info msg="Migration successfully executed" id="Update dashboard_snapshot table charset" duration=38.617µs
logger=migrator t=2026-07-08T05:41:17.89556337Z level=info msg="Executing migration" id="Add column external_delete_url to dashboard_snapshots table"
logger=migrator t=2026-07-08T05:41:17.89614202Z level=info msg="Migration successfully executed" id="Add column external_delete_url to dashboard_snapshots table" duration=579.021µs
logger=migrator t=2026-07-08T05:41:17.898772937Z level=info msg="Executing migration" id="Add encrypted dashboard json column"
logger=migrator t=2026-07-08T05:41:17.899312901Z level=info msg="Migration successfully executed" id="Add encrypted dashboard json column" duration=540.469µs
logger=migrator t=2026-07-08T05:41:17.903249948Z level=info msg="Executing migration" id="Change dashboard_encrypted column to MEDIUMBLOB"
logger=migrator t=2026-07-08T05:41:17.903299976Z level=info msg="Migration successfully executed" id="Change dashboard_encrypted column to MEDIUMBLOB" duration=45.504µs
logger=migrator t=2026-07-08T05:41:17.90686939Z level=info msg="Executing migration" id="create quota table v1"
logger=migrator t=2026-07-08T05:41:17.907133693Z level=info msg="Migration successfully executed" id="create quota table v1" duration=264.133µs
logger=migrator t=2026-07-08T05:41:17.911443172Z level=info msg="Executing migration" id="create index UQE_quota_org_id_user_id_target - v1"
logger=migrator t=2026-07-08T05:41:17.911744369Z level=info msg="Migration successfully executed" id="create index UQE_quota_org_id_user_id_target - v1" duration=301.651µs
logger=migrator t=2026-07-08T05:41:17.916589976Z level=info msg="Executing migration" id="Update quota table charset"
logger=migrator t=2026-07-08T05:41:17.916650445Z level=info msg="Migration successfully executed" id="Update quota table charset" duration=63.239µs
logger=migrator t=2026-07-08T05:41:17.920363666Z level=info msg="Executing migration" id="create plugin_setting table"
logger=migrator t=2026-07-08T05:41:17.92078539Z level=info msg="Migration successfully executed" id="create plugin_setting table" duration=422.031µs
logger=migrator t=2026-07-08T05:41:17.925027506Z level=info msg="Executing migration" id="create index UQE_plugin_setting_org_id_plugin_id - v1"
logger=migrator t=2026-07-08T05:41:17.925409729Z level=info msg="Migration successfully executed" id="create index UQE_plugin_setting_org_id_plugin_id - v1" duration=383.52µs
logger=migrator t=2026-07-08T05:41:17.929934545Z level=info msg="Executing migration" id="Add column plugin_version to plugin_settings"
logger=migrator t=2026-07-08T05:41:17.930579549Z level=info msg="Migration successfully executed" id="Add column plugin_version to plugin_settings" duration=649.835µs
logger=migrator t=2026-07-08T05:41:17.934171889Z level=info msg="Executing migration" id="Update plugin_setting table charset"
logger=migrator t=2026-07-08T05:41:17.934208134Z level=info msg="Migration successfully executed" id="Update plugin_setting table charset" duration=37.154µs
logger=migrator t=2026-07-08T05:41:17.937727854Z level=info msg="Executing migration" id="update NULL org_id to 1"
logger=migrator t=2026-07-08T05:41:17.937849787Z level=info msg="Migration successfully executed" id="update NULL org_id to 1" duration=122.495µs
logger=migrator t=2026-07-08T05:41:17.94131976Z level=info msg="Executing migration" id="make org_id NOT NULL and DEFAULT VALUE 1"
logger=migrator t=2026-07-08T05:41:17.942920422Z level=info msg="Migration successfully executed" id="make org_id NOT NULL and DEFAULT VALUE 1" duration=1.599764ms
logger=migrator t=2026-07-08T05:41:17.946775967Z level=info msg="Executing migration" id="create session table"
logger=migrator t=2026-07-08T05:41:17.947061248Z level=info msg="Migration successfully executed" id="create session table" duration=286.444µs
logger=migrator t=2026-07-08T05:41:17.950980929Z level=info msg="Executing migration" id="Drop old table playlist table"
logger=migrator t=2026-07-08T05:41:17.951047889Z level=info msg="Migration successfully executed" id="Drop old table playlist table" duration=67.941µs
logger=migrator t=2026-07-08T05:41:17.954697316Z level=info msg="Executing migration" id="Drop old table playlist_item table"
logger=migrator t=2026-07-08T05:41:17.954760699Z level=info msg="Migration successfully executed" id="Drop old table playlist_item table" duration=68.376µs
logger=migrator t=2026-07-08T05:41:17.958163321Z level=info msg="Executing migration" id="create playlist table v2"
logger=migrator t=2026-07-08T05:41:17.958461554Z level=info msg="Migration successfully executed" id="create playlist table v2" duration=298.439µs
logger=migrator t=2026-07-08T05:41:17.962119123Z level=info msg="Executing migration" id="create playlist item table v2"
logger=migrator t=2026-07-08T05:41:17.962395502Z level=info msg="Migration successfully executed" id="create playlist item table v2" duration=276.277µs
logger=migrator t=2026-07-08T05:41:17.967149502Z level=info msg="Executing migration" id="Update playlist table charset"
logger=migrator t=2026-07-08T05:41:17.967182064Z level=info msg="Migration successfully executed" id="Update playlist table charset" duration=33.609µs
logger=migrator t=2026-07-08T05:41:17.970817508Z level=info msg="Executing migration" id="Update playlist_item table charset"
logger=migrator t=2026-07-08T05:41:17.970854756Z level=info msg="Migration successfully executed" id="Update playlist_item table charset" duration=48.323µs
logger=migrator t=2026-07-08T05:41:17.975193421Z level=info msg="Executing migration" id="Add playlist column created_at"
logger=migrator t=2026-07-08T05:41:17.975901755Z level=info msg="Migration successfully executed" id="Add playlist column created_at" duration=709.12µs
logger=migrator t=2026-07-08T05:41:17.978501042Z level=info msg="Executing migration" id="Add playlist column updated_at"
logger=migrator t=2026-07-08T05:41:17.979187698Z level=info msg="Migration successfully executed" id="Add playlist column updated_at" duration=686.973µs
logger=migrator t=2026-07-08T05:41:17.983993574Z level=info msg="Executing migration" id="drop preferences table v2"
logger=migrator t=2026-07-08T05:41:17.984062364Z level=info msg="Migration successfully executed" id="drop preferences table v2" duration=69.365µs
logger=migrator t=2026-07-08T05:41:17.986729835Z level=info msg="Executing migration" id="drop preferences table v3"
logger=migrator t=2026-07-08T05:41:17.986780508Z level=info msg="Migration successfully executed" id="drop preferences table v3" duration=51.027µs
logger=migrator t=2026-07-08T05:41:17.989178824Z level=info msg="Executing migration" id="create preferences table v3"
logger=migrator t=2026-07-08T05:41:17.989480804Z level=info msg="Migration successfully executed" id="create preferences table v3" duration=302.991µs
logger=migrator t=2026-07-08T05:41:17.992470438Z level=info msg="Executing migration" id="Update preferences table charset"
logger=migrator t=2026-07-08T05:41:17.992497613Z level=info msg="Migration successfully executed" id="Update preferences table charset" duration=27.768µs
logger=migrator t=2026-07-08T05:41:17.994779297Z level=info msg="Executing migration" id="Add column team_id in preferences"
logger=migrator t=2026-07-08T05:41:17.995364363Z level=info msg="Migration successfully executed" id="Add column team_id in preferences" duration=585.052µs
logger=migrator t=2026-07-08T05:41:17.99798694Z level=info msg="Executing migration" id="Update team_id column values in preferences"
logger=migrator t=2026-07-08T05:41:17.9980431Z level=info msg="Migration successfully executed" id="Update team_id column values in preferences" duration=56.466µs
logger=migrator t=2026-07-08T05:41:18.000273479Z level=info msg="Executing migration" id="Add column week_start in preferences"
logger=migrator t=2026-07-08T05:41:18.000639723Z level=info msg="Migration successfully executed" id="Add column week_start in preferences" duration=366.259µs
logger=migrator t=2026-07-08T05:41:18.002934601Z level=info msg="Executing migration" id="Add column preferences.json_data"
logger=migrator t=2026-07-08T05:41:18.003266245Z level=info msg="Migration successfully executed" id="Add column preferences.json_data" duration=331.702µs
logger=migrator t=2026-07-08T05:41:18.005747127Z level=info msg="Executing migration" id="alter preferences.json_data to mediumtext v1"
logger=migrator t=2026-07-08T05:41:18.005773682Z level=info msg="Migration successfully executed" id="alter preferences.json_data to mediumtext v1" duration=26.661µs
logger=migrator t=2026-07-08T05:41:18.008057338Z level=info msg="Executing migration" id="Add preferences index org_id"
logger=migrator t=2026-07-08T05:41:18.008241263Z level=info msg="Migration successfully executed" id="Add preferences index org_id" duration=184.212µs
logger=migrator t=2026-07-08T05:41:18.010954119Z level=info msg="Executing migration" id="Add preferences index user_id"
logger=migrator t=2026-07-08T05:41:18.011131492Z level=info msg="Migration successfully executed" id="Add preferences index user_id" duration=183.353µs
logger=migrator t=2026-07-08T05:41:18.013879152Z level=info msg="Executing migration" id="create alert table v1"
logger=migrator t=2026-07-08T05:41:18.014096846Z level=info msg="Migration successfully executed" id="create alert table v1" duration=218.225µs
logger=migrator t=2026-07-08T05:41:18.016562226Z level=info msg="Executing migration" id="add index alert org_id & id "
logger=migrator t=2026-07-08T05:41:18.016764317Z level=info msg="Migration successfully executed" id="add index alert org_id & id " duration=199.751µs
logger=migrator t=2026-07-08T05:41:18.019052992Z level=info msg="Executing migration" id="add index alert state"
logger=migrator t=2026-07-08T05:41:18.019235542Z level=info msg="Migration successfully executed" id="add index alert state" duration=182.366µs
logger=migrator t=2026-07-08T05:41:18.021556901Z level=info msg="Executing migration" id="add index alert dashboard_id"
logger=migrator t=2026-07-08T05:41:18.021716555Z level=info msg="Migration successfully executed" id="add index alert dashboard_id" duration=159.753µs
logger=migrator t=2026-07-08T05:41:18.024177797Z level=info msg="Executing migration" id="Create alert_rule_tag table v1"
logger=migrator t=2026-07-08T05:41:18.024335453Z level=info msg="Migration successfully executed" id="Create alert_rule_tag table v1" duration=157.374µs
logger=migrator t=2026-07-08T05:41:18.026715541Z level=info msg="Executing migration" id="Add unique index alert_rule_tag.alert_id_tag_id"
logger=migrator t=2026-07-08T05:41:18.026894688Z level=info msg="Migration successfully executed" id="Add unique index alert_rule_tag.alert_id_tag_id" duration=179.193µs
logger=migrator t=2026-07-08T05:41:18.029140233Z level=info msg="Executing migration" id="drop index UQE_alert_rule_tag_alert_id_tag_id - v1"
logger=migrator t=2026-07-08T05:41:18.029313369Z level=info msg="Migration successfully executed" id="drop index UQE_alert_rule_tag_alert_id_tag_id - v1" duration=173.723µs
logger=migrator t=2026-07-08T05:41:18.031653353Z level=info msg="Executing migration" id="Rename table alert_rule_tag to alert_rule_tag_v1 - v1"
logger=migrator t=2026-07-08T05:41:18.03260129Z level=info msg="Migration successfully executed" id="Rename table alert_rule_tag to alert_rule_tag_v1 - v1" duration=952.182µs
logger=migrator t=2026-07-08T05:41:18.035201087Z level=info msg="Executing migration" id="Create alert_rule_tag table v2"
logger=migrator t=2026-07-08T05:41:18.035386003Z level=info msg="Migration successfully executed" id="Create alert_rule_tag table v2" duration=185.198µs
logger=migrator t=2026-07-08T05:41:18.037858142Z level=info msg="Executing migration" id="create index UQE_alert_rule_tag_alert_id_tag_id - Add unique index alert_rule_tag.alert_id_tag_id V2"
logger=migrator t=2026-07-08T05:41:18.038206047Z level=info msg="Migration successfully executed" id="create index UQE_alert_rule_tag_alert_id_tag_id - Add unique index alert_rule_tag.alert_id_tag_id V2" duration=347.266µs
logger=migrator t=2026-07-08T05:41:18.04096971Z level=info msg="Executing migration" id="copy alert_rule_tag v1 to v2"
logger=migrator t=2026-07-08T05:41:18.041137223Z level=info msg="Migration successfully executed" id="copy alert_rule_tag v1 to v2" duration=167.92µs
logger=migrator t=2026-07-08T05:41:18.043579417Z level=info msg="Executing migration" id="drop table alert_rule_tag_v1"
logger=migrator t=2026-07-08T05:41:18.043759881Z level=info msg="Migration successfully executed" id="drop table alert_rule_tag_v1" duration=178.778µs
logger=migrator t=2026-07-08T05:41:18.046348824Z level=info msg="Executing migration" id="create alert_notification table v1"
logger=migrator t=2026-07-08T05:41:18.046554694Z level=info msg="Migration successfully executed" id="create alert_notification table v1" duration=205.934µs
logger=migrator t=2026-07-08T05:41:18.049359855Z level=info msg="Executing migration" id="Add column is_default"
logger=migrator t=2026-07-08T05:41:18.049787331Z level=info msg="Migration successfully executed" id="Add column is_default" duration=424.477µs
logger=migrator t=2026-07-08T05:41:18.052685253Z level=info msg="Executing migration" id="Add column frequency"
logger=migrator t=2026-07-08T05:41:18.053104598Z level=info msg="Migration successfully executed" id="Add column frequency" duration=419.955µs
logger=migrator t=2026-07-08T05:41:18.055693765Z level=info msg="Executing migration" id="Add column send_reminder"
logger=migrator t=2026-07-08T05:41:18.056110109Z level=info msg="Migration successfully executed" id="Add column send_reminder" duration=403.693µs
logger=migrator t=2026-07-08T05:41:18.059052408Z level=info msg="Executing migration" id="Add column disable_resolve_message"
logger=migrator t=2026-07-08T05:41:18.059420275Z level=info msg="Migration successfully executed" id="Add column disable_resolve_message" duration=367.913µs
logger=migrator t=2026-07-08T05:41:18.061603896Z level=info msg="Executing migration" id="add index alert_notification org_id & name"
logger=migrator t=2026-07-08T05:41:18.061828268Z level=info msg="Migration successfully executed" id="add index alert_notification org_id & name" duration=218.683µs
logger=migrator t=2026-07-08T05:41:18.064643145Z level=info msg="Executing migration" id="Update alert table charset"
logger=migrator t=2026-07-08T05:41:18.06466412Z level=info msg="Migration successfully executed" id="Update alert table charset" duration=21.165µs
logger=migrator t=2026-07-08T05:41:18.067574368Z level=info msg="Executing migration" id="Update alert_notification table charset"
logger=migrator t=2026-07-08T05:41:18.067594792Z level=info msg="Migration successfully executed" id="Update alert_notification table charset" duration=20.319µs
logger=migrator t=2026-07-08T05:41:18.069741147Z level=info msg="Executing migration" id="create notification_journal table v1"
logger=migrator t=2026-07-08T05:41:18.069930965Z level=info msg="Migration successfully executed" id="create notification_journal table v1" duration=189.976µs
logger=migrator t=2026-07-08T05:41:18.073302098Z level=info msg="Executing migration" id="add index notification_journal org_id & alert_id & notifier_id"
logger=migrator t=2026-07-08T05:41:18.073512006Z level=info msg="Migration successfully executed" id="add index notification_journal org_id & alert_id & notifier_id" duration=209.963µs
logger=migrator t=2026-07-08T05:41:18.076491901Z level=info msg="Executing migration" id="drop alert_notification_journal"
logger=migrator t=2026-07-08T05:41:18.07664915Z level=info msg="Migration successfully executed" id="drop alert_notification_journal" duration=157.146µs
logger=migrator t=2026-07-08T05:41:18.079542688Z level=info msg="Executing migration" id="create alert_notification_state table v1"
logger=migrator t=2026-07-08T05:41:18.079720543Z level=info msg="Migration successfully executed" id="create alert_notification_state table v1" duration=177.64µs
logger=migrator t=2026-07-08T05:41:18.082502801Z level=info msg="Executing migration" id="add index alert_notification_state org_id & alert_id & notifier_id"
logger=migrator t=2026-07-08T05:41:18.082689493Z level=info msg="Migration successfully executed" id="add index alert_notification_state org_id & alert_id & notifier_id" duration=186.88µs
logger=migrator t=2026-07-08T05:41:18.085721183Z level=info msg="Executing migration" id="Add for to alert table"
logger=migrator t=2026-07-08T05:41:18.08612903Z level=info msg="Migration successfully executed" id="Add for to alert table" duration=407.918µs
logger=migrator t=2026-07-08T05:41:18.089046003Z level=info msg="Executing migration" id="Add column uid in alert_notification"
logger=migrator t=2026-07-08T05:41:18.0894247Z level=info msg="Migration successfully executed" id="Add column uid in alert_notification" duration=379.105µs
logger=migrator t=2026-07-08T05:41:18.092424437Z level=info msg="Executing migration" id="Update uid column values in alert_notification"
logger=migrator t=2026-07-08T05:41:18.092496739Z level=info msg="Migration successfully executed" id="Update uid column values in alert_notification" duration=67.89µs
logger=migrator t=2026-07-08T05:41:18.095440796Z level=info msg="Executing migration" id="Add unique index alert_notification_org_id_uid"
logger=migrator t=2026-07-08T05:41:18.095673037Z level=info msg="Migration successfully executed" id="Add unique index alert_notification_org_id_uid" duration=237.981µs
logger=migrator t=2026-07-08T05:41:18.10076256Z level=info msg="Executing migration" id="Remove unique index org_id_name"
logger=migrator t=2026-07-08T05:41:18.101033477Z level=info msg="Migration successfully executed" id="Remove unique index org_id_name" duration=271.475µs
logger=migrator t=2026-07-08T05:41:18.104690128Z level=info msg="Executing migration" id="Add column secure_settings in alert_notification"
logger=migrator t=2026-07-08T05:41:18.105138443Z level=info msg="Migration successfully executed" id="Add column secure_settings in alert_notification" duration=448.648µs
logger=migrator t=2026-07-08T05:41:18.10853808Z level=info msg="Executing migration" id="alter alert.settings to mediumtext"
logger=migrator t=2026-07-08T05:41:18.10857911Z level=info msg="Migration successfully executed" id="alter alert.settings to mediumtext" duration=35.547µs
logger=migrator t=2026-07-08T05:41:18.111899772Z level=info msg="Executing migration" id="Add non-unique index alert_notification_state_alert_id"
logger=migrator t=2026-07-08T05:41:18.112132328Z level=info msg="Migration successfully executed" id="Add non-unique index alert_notification_state_alert_id" duration=233.392µs
logger=migrator t=2026-07-08T05:41:18.117241701Z level=info msg="Executing migration" id="Add non-unique index alert_rule_tag_alert_id"
logger=migrator t=2026-07-08T05:41:18.117567116Z level=info msg="Migration successfully executed" id="Add non-unique index alert_rule_tag_alert_id" duration=326.136µs
logger=migrator t=2026-07-08T05:41:18.121251914Z level=info msg="Executing migration" id="Drop old annotation table v4"
logger=migrator t=2026-07-08T05:41:18.121311398Z level=info msg="Migration successfully executed" id="Drop old annotation table v4" duration=60.572µs
logger=migrator t=2026-07-08T05:41:18.124438394Z level=info msg="Executing migration" id="create annotation table v5"
logger=migrator t=2026-07-08T05:41:18.124669546Z level=info msg="Migration successfully executed" id="create annotation table v5" duration=231.783µs
logger=migrator t=2026-07-08T05:41:18.128344429Z level=info msg="Executing migration" id="add index annotation 0 v3"
logger=migrator t=2026-07-08T05:41:18.128549528Z level=info msg="Migration successfully executed" id="add index annotation 0 v3" duration=205.369µs
logger=migrator t=2026-07-08T05:41:18.134210906Z level=info msg="Executing migration" id="add index annotation 1 v3"
logger=migrator t=2026-07-08T05:41:18.134496773Z level=info msg="Migration successfully executed" id="add index annotation 1 v3" duration=286.116µs
logger=migrator t=2026-07-08T05:41:18.137985747Z level=info msg="Executing migration" id="add index annotation 2 v3"
logger=migrator t=2026-07-08T05:41:18.138172867Z level=info msg="Migration successfully executed" id="add index annotation 2 v3" duration=187.37µs
logger=migrator t=2026-07-08T05:41:18.141640594Z level=info msg="Executing migration" id="add index annotation 3 v3"
logger=migrator t=2026-07-08T05:41:18.141860781Z level=info msg="Migration successfully executed" id="add index annotation 3 v3" duration=220.046µs
logger=migrator t=2026-07-08T05:41:18.145590397Z level=info msg="Executing migration" id="add index annotation 4 v3"
logger=migrator t=2026-07-08T05:41:18.145804934Z level=info msg="Migration successfully executed" id="add index annotation 4 v3" duration=215.11µs
logger=migrator t=2026-07-08T05:41:18.149735131Z level=info msg="Executing migration" id="Update annotation table charset"
logger=migrator t=2026-07-08T05:41:18.149775794Z level=info msg="Migration successfully executed" id="Update annotation table charset" duration=41.39µs
logger=migrator t=2026-07-08T05:41:18.153676042Z level=info msg="Executing migration" id="Add column region_id to annotation table"
logger=migrator t=2026-07-08T05:41:18.154193577Z level=info msg="Migration successfully executed" id="Add column region_id to annotation table" duration=518.159µs
logger=migrator t=2026-07-08T05:41:18.157672518Z level=info msg="Executing migration" id="Drop category_id index"
logger=migrator t=2026-07-08T05:41:18.157941128Z level=info msg="Migration successfully executed" id="Drop category_id index" duration=269.043µs
logger=migrator t=2026-07-08T05:41:18.161314939Z level=info msg="Executing migration" id="Add column tags to annotation table"
logger=migrator t=2026-07-08T05:41:18.161766696Z level=info msg="Migration successfully executed" id="Add column tags to annotation table" duration=452.104µs
logger=migrator t=2026-07-08T05:41:18.165168615Z level=info msg="Executing migration" id="Create annotation_tag table v2"
logger=migrator t=2026-07-08T05:41:18.165348787Z level=info msg="Migration successfully executed" id="Create annotation_tag table v2" duration=184.537µs
logger=migrator t=2026-07-08T05:41:18.168382655Z level=info msg="Executing migration" id="Add unique index annotation_tag.annotation_id_tag_id"
logger=migrator t=2026-07-08T05:41:18.168592004Z level=info msg="Migration successfully executed" id="Add unique index annotation_tag.annotation_id_tag_id" duration=209.268µs
logger=migrator t=2026-07-08T05:41:18.171596389Z level=info msg="Executing migration" id="drop index UQE_annotation_tag_annotation_id_tag_id - v2"
logger=migrator t=2026-07-08T05:41:18.171790781Z level=info msg="Migration successfully executed" id="drop index UQE_annotation_tag_annotation_id_tag_id - v2" duration=186.484µs
logger=migrator t=2026-07-08T05:41:18.174708978Z level=info msg="Executing migration" id="Rename table annotation_tag to annotation_tag_v2 - v2"
logger=migrator t=2026-07-08T05:41:18.175743338Z level=info msg="Migration successfully executed" id="Rename table annotation_tag to annotation_tag_v2 - v2" duration=1.034022ms
logger=migrator t=2026-07-08T05:41:18.178679272Z level=info msg="Executing migration" id="Create annotation_tag table v3"
logger=migrator t=2026-07-08T05:41:18.178878577Z level=info msg="Migration successfully executed" id="Create annotation_tag table v3" duration=199.453µs
logger=migrator t=2026-07-08T05:41:18.182228629Z level=info msg="Executing migration" id="create index UQE_annotation_tag_annotation_id_tag_id - Add unique index annotation_tag.annotation_id_tag_id V3"
logger=migrator t=2026-07-08T05:41:18.182460105Z level=info msg="Migration successfully executed" id="create index UQE_annotation_tag_annotation_id_tag_id - Add unique index annotation_tag.annotation_id_tag_id V3" duration=231.5µs
logger=migrator t=2026-07-08T05:41:18.185566163Z level=info msg="Executing migration" id="copy annotation_tag v2 to v3"
logger=migrator t=2026-07-08T05:41:18.185673245Z level=info msg="Migration successfully executed" id="copy annotation_tag v2 to v3" duration=106.787µs
logger=migrator t=2026-07-08T05:41:18.188635946Z level=info msg="Executing migration" id="drop table annotation_tag_v2"
logger=migrator t=2026-07-08T05:41:18.188769398Z level=info msg="Migration successfully executed" id="drop table annotation_tag_v2" duration=133.251µs
logger=migrator t=2026-07-08T05:41:18.191860397Z level=info msg="Executing migration" id="Update alert annotations and set TEXT to empty"
logger=migrator t=2026-07-08T05:41:18.19191772Z level=info msg="Migration successfully executed" id="Update alert annotations and set TEXT to empty" duration=57.724µs
logger=migrator t=2026-07-08T05:41:18.194700013Z level=info msg="Executing migration" id="Add created time to annotation table"
logger=migrator t=2026-07-08T05:41:18.195166384Z level=info msg="Migration successfully executed" id="Add created time to annotation table" duration=465.829µs
logger=migrator t=2026-07-08T05:41:18.198311667Z level=info msg="Executing migration" id="Add updated time to annotation table"
logger=migrator t=2026-07-08T05:41:18.198737317Z level=info msg="Migration successfully executed" id="Add updated time to annotation table" duration=425.612µs
logger=migrator t=2026-07-08T05:41:18.201578066Z level=info msg="Executing migration" id="Add index for created in annotation table"
logger=migrator t=2026-07-08T05:41:18.20179459Z level=info msg="Migration successfully executed" id="Add index for created in annotation table" duration=216.632µs
logger=migrator t=2026-07-08T05:41:18.204871515Z level=info msg="Executing migration" id="Add index for updated in annotation table"
logger=migrator t=2026-07-08T05:41:18.205060513Z level=info msg="Migration successfully executed" id="Add index for updated in annotation table" duration=188.967µs
logger=migrator t=2026-07-08T05:41:18.208382944Z level=info msg="Executing migration" id="Convert existing annotations from seconds to milliseconds"
logger=migrator t=2026-07-08T05:41:18.208447963Z level=info msg="Migration successfully executed" id="Convert existing annotations from seconds to milliseconds" duration=65.42µs
logger=migrator t=2026-07-08T05:41:18.211528585Z level=info msg="Executing migration" id="Add epoch_end column"
logger=migrator t=2026-07-08T05:41:18.212008587Z level=info msg="Migration successfully executed" id="Add epoch_end column" duration=480.019µs
logger=migrator t=2026-07-08T05:41:18.214956969Z level=info msg="Executing migration" id="Add index for epoch_end"
logger=migrator t=2026-07-08T05:41:18.215183838Z level=info msg="Migration successfully executed" id="Add index for epoch_end" duration=225.966µs
logger=migrator t=2026-07-08T05:41:18.218089546Z level=info msg="Executing migration" id="Make epoch_end the same as epoch"
logger=migrator t=2026-07-08T05:41:18.218136703Z level=info msg="Migration successfully executed" id="Make epoch_end the same as epoch" duration=47.162µs
logger=migrator t=2026-07-08T05:41:18.220937915Z level=info msg="Executing migration" id="Move region to single row"
logger=migrator t=2026-07-08T05:41:18.221047795Z level=info msg="Migration successfully executed" id="Move region to single row" duration=109.755µs
logger=migrator t=2026-07-08T05:41:18.223881053Z level=info msg="Executing migration" id="Remove index org_id_epoch from annotation table"
logger=migrator t=2026-07-08T05:41:18.224060788Z level=info msg="Migration successfully executed" id="Remove index org_id_epoch from annotation table" duration=180.079µs
logger=migrator t=2026-07-08T05:41:18.226890117Z level=info msg="Executing migration" id="Remove index org_id_dashboard_id_panel_id_epoch from annotation table"
logger=migrator t=2026-07-08T05:41:18.227058013Z level=info msg="Migration successfully executed" id="Remove index org_id_dashboard_id_panel_id_epoch from annotation table" duration=167.921µs
logger=migrator t=2026-07-08T05:41:18.230106046Z level=info msg="Executing migration" id="Add index for org_id_dashboard_id_epoch_end_epoch on annotation table"
logger=migrator t=2026-07-08T05:41:18.230339489Z level=info msg="Migration successfully executed" id="Add index for org_id_dashboard_id_epoch_end_epoch on annotation table" duration=233.341µs
logger=migrator t=2026-07-08T05:41:18.255023658Z level=info msg="Executing migration" id="Add index for org_id_epoch_end_epoch on annotation table"
logger=migrator t=2026-07-08T05:41:18.25550812Z level=info msg="Migration successfully executed" id="Add index for org_id_epoch_end_epoch on annotation table" duration=486.105µs
logger=migrator t=2026-07-08T05:41:18.297020451Z level=info msg="Executing migration" id="Remove index org_id_epoch_epoch_end from annotation table"
logger=migrator t=2026-07-08T05:41:18.297339687Z level=info msg="Migration successfully executed" id="Remove index org_id_epoch_epoch_end from annotation table" duration=321.722µs
logger=migrator t=2026-07-08T05:41:18.34320321Z level=info msg="Executing migration" id="Add index for alert_id on annotation table"
logger=migrator t=2026-07-08T05:41:18.34355404Z level=info msg="Migration successfully executed" id="Add index for alert_id on annotation table" duration=352.386µs
logger=migrator t=2026-07-08T05:41:18.384433172Z level=info msg="Executing migration" id="Increase tags column to length 4096"
logger=migrator t=2026-07-08T05:41:18.384497217Z level=info msg="Migration successfully executed" id="Increase tags column to length 4096" duration=66.463µs
logger=migrator t=2026-07-08T05:41:18.387651129Z level=info msg="Executing migration" id="Increase prev_state column to length 40 not null"
logger=migrator t=2026-07-08T05:41:18.387697492Z level=info msg="Migration successfully executed" id="Increase prev_state column to length 40 not null" duration=48.49µs
logger=migrator t=2026-07-08T05:41:18.391039288Z level=info msg="Executing migration" id="Increase new_state column to length 40 not null"
logger=migrator t=2026-07-08T05:41:18.391085115Z level=info msg="Migration successfully executed" id="Increase new_state column to length 40 not null" duration=47.146µs
logger=migrator t=2026-07-08T05:41:18.39406254Z level=info msg="Executing migration" id="create test_data table"
logger=migrator t=2026-07-08T05:41:18.394285166Z level=info msg="Migration successfully executed" id="create test_data table" duration=223.325µs
logger=migrator t=2026-07-08T05:41:18.397734113Z level=info msg="Executing migration" id="create dashboard_version table v1"
logger=migrator t=2026-07-08T05:41:18.397951097Z level=info msg="Migration successfully executed" id="create dashboard_version table v1" duration=217.639µs
logger=migrator t=2026-07-08T05:41:18.400950017Z level=info msg="Executing migration" id="add index dashboard_version.dashboard_id"
logger=migrator t=2026-07-08T05:41:18.401151687Z level=info msg="Migration successfully executed" id="add index dashboard_version.dashboard_id" duration=201.809µs
logger=migrator t=2026-07-08T05:41:18.405260994Z level=info msg="Executing migration" id="add unique index dashboard_version.dashboard_id and dashboard_version.version"
logger=migrator t=2026-07-08T05:41:18.405591301Z level=info msg="Migration successfully executed" id="add unique index dashboard_version.dashboard_id and dashboard_version.version" duration=330.652µs
logger=migrator t=2026-07-08T05:41:18.409630936Z level=info msg="Executing migration" id="Set dashboard version to 1 where 0"
logger=migrator t=2026-07-08T05:41:18.40970518Z level=info msg="Migration successfully executed" id="Set dashboard version to 1 where 0" duration=74.83µs
logger=migrator t=2026-07-08T05:41:18.413053417Z level=info msg="Executing migration" id="save existing dashboard data in dashboard_version table v1"
logger=migrator t=2026-07-08T05:41:18.413187781Z level=info msg="Migration successfully executed" id="save existing dashboard data in dashboard_version table v1" duration=134.808µs
logger=migrator t=2026-07-08T05:41:18.416235001Z level=info msg="Executing migration" id="alter dashboard_version.data to mediumtext v1"
logger=migrator t=2026-07-08T05:41:18.416290098Z level=info msg="Migration successfully executed" id="alter dashboard_version.data to mediumtext v1" duration=55.933µs
logger=migrator t=2026-07-08T05:41:18.419094038Z level=info msg="Executing migration" id="create team table"
logger=migrator t=2026-07-08T05:41:18.419297441Z level=info msg="Migration successfully executed" id="create team table" duration=203.013µs
logger=migrator t=2026-07-08T05:41:18.422419743Z level=info msg="Executing migration" id="add index team.org_id"
logger=migrator t=2026-07-08T05:41:18.422683105Z level=info msg="Migration successfully executed" id="add index team.org_id" duration=263.376µs
logger=migrator t=2026-07-08T05:41:18.426310091Z level=info msg="Executing migration" id="add unique index team_org_id_name"
logger=migrator t=2026-07-08T05:41:18.426514732Z level=info msg="Migration successfully executed" id="add unique index team_org_id_name" duration=208.286µs
logger=migrator t=2026-07-08T05:41:18.429678775Z level=info msg="Executing migration" id="Add column uid in team"
logger=migrator t=2026-07-08T05:41:18.430207691Z level=info msg="Migration successfully executed" id="Add column uid in team" duration=528.478µs
logger=migrator t=2026-07-08T05:41:18.433071998Z level=info msg="Executing migration" id="Update uid column values in team"
logger=migrator t=2026-07-08T05:41:18.433122953Z level=info msg="Migration successfully executed" id="Update uid column values in team" duration=51.194µs
logger=migrator t=2026-07-08T05:41:18.436002337Z level=info msg="Executing migration" id="Add unique index team_org_id_uid"
logger=migrator t=2026-07-08T05:41:18.436196552Z level=info msg="Migration successfully executed" id="Add unique index team_org_id_uid" duration=194.291µs
logger=migrator t=2026-07-08T05:41:18.439289493Z level=info msg="Executing migration" id="create team member table"
logger=migrator t=2026-07-08T05:41:18.439452819Z level=info msg="Migration successfully executed" id="create team member table" duration=163.724µs
logger=migrator t=2026-07-08T05:41:18.442643249Z level=info msg="Executing migration" id="add index team_member.org_id"
logger=migrator t=2026-07-08T05:41:18.442832419Z level=info msg="Migration successfully executed" id="add index team_member.org_id" duration=189.401µs
logger=migrator t=2026-07-08T05:41:18.446012868Z level=info msg="Executing migration" id="add unique index team_member_org_id_team_id_user_id"
logger=migrator t=2026-07-08T05:41:18.446207139Z level=info msg="Migration successfully executed" id="add unique index team_member_org_id_team_id_user_id" duration=194.547µs
logger=migrator t=2026-07-08T05:41:18.450339068Z level=info msg="Executing migration" id="add index team_member.team_id"
logger=migrator t=2026-07-08T05:41:18.450663681Z level=info msg="Migration successfully executed" id="add index team_member.team_id" duration=324.942µs
logger=migrator t=2026-07-08T05:41:18.454157881Z level=info msg="Executing migration" id="Add column email to team table"
logger=migrator t=2026-07-08T05:41:18.454658343Z level=info msg="Migration successfully executed" id="Add column email to team table" duration=500.499µs
logger=migrator t=2026-07-08T05:41:18.457791854Z level=info msg="Executing migration" id="Add column external to team_member table"
logger=migrator t=2026-07-08T05:41:18.458323864Z level=info msg="Migration successfully executed" id="Add column external to team_member table" duration=531.483µs
logger=migrator t=2026-07-08T05:41:18.461294378Z level=info msg="Executing migration" id="Add column permission to team_member table"
logger=migrator t=2026-07-08T05:41:18.461783624Z level=info msg="Migration successfully executed" id="Add column permission to team_member table" duration=497.257µs
logger=migrator t=2026-07-08T05:41:18.465173721Z level=info msg="Executing migration" id="add unique index team_member_user_id_org_id"
logger=migrator t=2026-07-08T05:41:18.465404097Z level=info msg="Migration successfully executed" id="add unique index team_member_user_id_org_id" duration=230.731µs
logger=migrator t=2026-07-08T05:41:18.468894784Z level=info msg="Executing migration" id="create dashboard acl table"
logger=migrator t=2026-07-08T05:41:18.469105041Z level=info msg="Migration successfully executed" id="create dashboard acl table" duration=210.915µs
logger=migrator t=2026-07-08T05:41:18.472015896Z level=info msg="Executing migration" id="add index dashboard_acl_dashboard_id"
logger=migrator t=2026-07-08T05:41:18.472223223Z level=info msg="Migration successfully executed" id="add index dashboard_acl_dashboard_id" duration=199.915µs
logger=migrator t=2026-07-08T05:41:18.475122852Z level=info msg="Executing migration" id="add unique index dashboard_acl_dashboard_id_user_id"
logger=migrator t=2026-07-08T05:41:18.475313904Z level=info msg="Migration successfully executed" id="add unique index dashboard_acl_dashboard_id_user_id" duration=191.239µs
logger=migrator t=2026-07-08T05:41:18.478326154Z level=info msg="Executing migration" id="add unique index dashboard_acl_dashboard_id_team_id"
logger=migrator t=2026-07-08T05:41:18.478498712Z level=info msg="Migration successfully executed" id="add unique index dashboard_acl_dashboard_id_team_id" duration=172.742µs
logger=migrator t=2026-07-08T05:41:18.481548036Z level=info msg="Executing migration" id="add index dashboard_acl_user_id"
logger=migrator t=2026-07-08T05:41:18.481717728Z level=info msg="Migration successfully executed" id="add index dashboard_acl_user_id" duration=169.918µs
logger=migrator t=2026-07-08T05:41:18.484154913Z level=info msg="Executing migration" id="add index dashboard_acl_team_id"
logger=migrator t=2026-07-08T05:41:18.484326721Z level=info msg="Migration successfully executed" id="add index dashboard_acl_team_id" duration=171.935µs
logger=migrator t=2026-07-08T05:41:18.487316717Z level=info msg="Executing migration" id="add index dashboard_acl_org_id_role"
logger=migrator t=2026-07-08T05:41:18.487506399Z level=info msg="Migration successfully executed" id="add index dashboard_acl_org_id_role" duration=189.98µs
logger=migrator t=2026-07-08T05:41:18.489860218Z level=info msg="Executing migration" id="add index dashboard_permission"
logger=migrator t=2026-07-08T05:41:18.4900317Z level=info msg="Migration successfully executed" id="add index dashboard_permission" duration=171.912µs
logger=migrator t=2026-07-08T05:41:18.493002859Z level=info msg="Executing migration" id="save default acl rules in dashboard_acl table"
logger=migrator t=2026-07-08T05:41:18.493135787Z level=info msg="Migration successfully executed" id="save default acl rules in dashboard_acl table" duration=133.369µs
logger=migrator t=2026-07-08T05:41:18.495829017Z level=info msg="Executing migration" id="delete acl rules for deleted dashboards and folders"
logger=migrator t=2026-07-08T05:41:18.49588883Z level=info msg="Migration successfully executed" id="delete acl rules for deleted dashboards and folders" duration=60.117µs
logger=migrator t=2026-07-08T05:41:18.497798357Z level=info msg="Executing migration" id="create tag table"
logger=migrator t=2026-07-08T05:41:18.497976093Z level=info msg="Migration successfully executed" id="create tag table" duration=169.533µs
logger=migrator t=2026-07-08T05:41:18.501045551Z level=info msg="Executing migration" id="add index tag.key_value"
logger=migrator t=2026-07-08T05:41:18.50128516Z level=info msg="Migration successfully executed" id="add index tag.key_value" duration=239.927µs
logger=migrator t=2026-07-08T05:41:18.504899482Z level=info msg="Executing migration" id="create login attempt table"
logger=migrator t=2026-07-08T05:41:18.50508269Z level=info msg="Migration successfully executed" id="create login attempt table" duration=184.457µs
logger=migrator t=2026-07-08T05:41:18.509132067Z level=info msg="Executing migration" id="add index login_attempt.username"
logger=migrator t=2026-07-08T05:41:18.509374103Z level=info msg="Migration successfully executed" id="add index login_attempt.username" duration=243.024µs
logger=migrator t=2026-07-08T05:41:18.513077152Z level=info msg="Executing migration" id="drop index IDX_login_attempt_username - v1"
logger=migrator t=2026-07-08T05:41:18.513275445Z level=info msg="Migration successfully executed" id="drop index IDX_login_attempt_username - v1" duration=199.996µs
logger=migrator t=2026-07-08T05:41:18.516156784Z level=info msg="Executing migration" id="Rename table login_attempt to login_attempt_tmp_qwerty - v1"
logger=migrator t=2026-07-08T05:41:18.517393373Z level=info msg="Migration successfully executed" id="Rename table login_attempt to login_attempt_tmp_qwerty - v1" duration=1.236258ms
logger=migrator t=2026-07-08T05:41:18.520110156Z level=info msg="Executing migration" id="create login_attempt v2"
logger=migrator t=2026-07-08T05:41:18.52027484Z level=info msg="Migration successfully executed" id="create login_attempt v2" duration=165.099µs
logger=migrator t=2026-07-08T05:41:18.523160084Z level=info msg="Executing migration" id="create index IDX_login_attempt_username - v2"
logger=migrator t=2026-07-08T05:41:18.523375821Z level=info msg="Migration successfully executed" id="create index IDX_login_attempt_username - v2" duration=216.427µs
logger=migrator t=2026-07-08T05:41:18.526268909Z level=info msg="Executing migration" id="copy login_attempt v1 to v2"
logger=migrator t=2026-07-08T05:41:18.526371495Z level=info msg="Migration successfully executed" id="copy login_attempt v1 to v2" duration=102.772µs
logger=migrator t=2026-07-08T05:41:18.528792876Z level=info msg="Executing migration" id="drop login_attempt_tmp_qwerty"
logger=migrator t=2026-07-08T05:41:18.52892843Z level=info msg="Migration successfully executed" id="drop login_attempt_tmp_qwerty" duration=135.547µs
logger=migrator t=2026-07-08T05:41:18.531246635Z level=info msg="Executing migration" id="create user auth table"
logger=migrator t=2026-07-08T05:41:18.531405292Z level=info msg="Migration successfully executed" id="create user auth table" duration=158.851µs
logger=migrator t=2026-07-08T05:41:18.534536335Z level=info msg="Executing migration" id="create index IDX_user_auth_auth_module_auth_id - v1"
logger=migrator t=2026-07-08T05:41:18.534716325Z level=info msg="Migration successfully executed" id="create index IDX_user_auth_auth_module_auth_id - v1" duration=179.981µs
logger=migrator t=2026-07-08T05:41:18.540286499Z level=info msg="Executing migration" id="alter user_auth.auth_id to length 190"
logger=migrator t=2026-07-08T05:41:18.540326905Z level=info msg="Migration successfully executed" id="alter user_auth.auth_id to length 190" duration=40.706µs
logger=migrator t=2026-07-08T05:41:18.543089189Z level=info msg="Executing migration" id="Add OAuth access token to user_auth"
logger=migrator t=2026-07-08T05:41:18.543713671Z level=info msg="Migration successfully executed" id="Add OAuth access token to user_auth" duration=622.662µs
logger=migrator t=2026-07-08T05:41:18.546740731Z level=info msg="Executing migration" id="Add OAuth refresh token to user_auth"
logger=migrator t=2026-07-08T05:41:18.547268653Z level=info msg="Migration successfully executed" id="Add OAuth refresh token to user_auth" duration=527.842µs
logger=migrator t=2026-07-08T05:41:18.550294296Z level=info msg="Executing migration" id="Add OAuth token type to user_auth"
logger=migrator t=2026-07-08T05:41:18.550890947Z level=info msg="Migration successfully executed" id="Add OAuth token type to user_auth" duration=596.338µs
logger=migrator t=2026-07-08T05:41:18.555501336Z level=info msg="Executing migration" id="Add OAuth expiry to user_auth"
logger=migrator t=2026-07-08T05:41:18.556186823Z level=info msg="Migration successfully executed" id="Add OAuth expiry to user_auth" duration=684.797µs
logger=migrator t=2026-07-08T05:41:18.55929117Z level=info msg="Executing migration" id="Add index to user_id column in user_auth"
logger=migrator t=2026-07-08T05:41:18.559556821Z level=info msg="Migration successfully executed" id="Add index to user_id column in user_auth" duration=265.486µs
logger=migrator t=2026-07-08T05:41:18.561992023Z level=info msg="Executing migration" id="Add OAuth ID token to user_auth"
logger=migrator t=2026-07-08T05:41:18.562486734Z level=info msg="Migration successfully executed" id="Add OAuth ID token to user_auth" duration=494.944µs
logger=migrator t=2026-07-08T05:41:18.565690952Z level=info msg="Executing migration" id="create server_lock table"
logger=migrator t=2026-07-08T05:41:18.565884632Z level=info msg="Migration successfully executed" id="create server_lock table" duration=193.316µs
logger=migrator t=2026-07-08T05:41:18.569912242Z level=info msg="Executing migration" id="add index server_lock.operation_uid"
logger=migrator t=2026-07-08T05:41:18.570128039Z level=info msg="Migration successfully executed" id="add index server_lock.operation_uid" duration=215.923µs
logger=migrator t=2026-07-08T05:41:18.573416341Z level=info msg="Executing migration" id="create user auth token table"
logger=migrator t=2026-07-08T05:41:18.573595434Z level=info msg="Migration successfully executed" id="create user auth token table" duration=179.182µs
logger=migrator t=2026-07-08T05:41:18.576008356Z level=info msg="Executing migration" id="add unique index user_auth_token.auth_token"
logger=migrator t=2026-07-08T05:41:18.576224492Z level=info msg="Migration successfully executed" id="add unique index user_auth_token.auth_token" duration=216.333µs
logger=migrator t=2026-07-08T05:41:18.579333243Z level=info msg="Executing migration" id="add unique index user_auth_token.prev_auth_token"
logger=migrator t=2026-07-08T05:41:18.5795114Z level=info msg="Migration successfully executed" id="add unique index user_auth_token.prev_auth_token" duration=182.632µs
logger=migrator t=2026-07-08T05:41:18.582250349Z level=info msg="Executing migration" id="add index user_auth_token.user_id"
logger=migrator t=2026-07-08T05:41:18.582426299Z level=info msg="Migration successfully executed" id="add index user_auth_token.user_id" duration=176.088µs
logger=migrator t=2026-07-08T05:41:18.585957291Z level=info msg="Executing migration" id="Add revoked_at to the user auth token"
logger=migrator t=2026-07-08T05:41:18.586464455Z level=info msg="Migration successfully executed" id="Add revoked_at to the user auth token" duration=507.154µs
logger=migrator t=2026-07-08T05:41:18.589299276Z level=info msg="Executing migration" id="add index user_auth_token.revoked_at"
logger=migrator t=2026-07-08T05:41:18.589484973Z level=info msg="Migration successfully executed" id="add index user_auth_token.revoked_at" duration=185.837µs
logger=migrator t=2026-07-08T05:41:18.592614177Z level=info msg="Executing migration" id="add external_session_id to user_auth_token"
logger=migrator t=2026-07-08T05:41:18.593152005Z level=info msg="Migration successfully executed" id="add external_session_id to user_auth_token" duration=537.648µs
logger=migrator t=2026-07-08T05:41:18.595900343Z level=info msg="Executing migration" id="create cache_data table"
logger=migrator t=2026-07-08T05:41:18.596074968Z level=info msg="Migration successfully executed" id="create cache_data table" duration=175.018µs
logger=migrator t=2026-07-08T05:41:18.598727589Z level=info msg="Executing migration" id="add unique index cache_data.cache_key"
logger=migrator t=2026-07-08T05:41:18.598942668Z level=info msg="Migration successfully executed" id="add unique index cache_data.cache_key" duration=208.966µs
logger=migrator t=2026-07-08T05:41:18.601641189Z level=info msg="Executing migration" id="create short_url table v1"
logger=migrator t=2026-07-08T05:41:18.601869886Z level=info msg="Migration successfully executed" id="create short_url table v1" duration=229.005µs
logger=migrator t=2026-07-08T05:41:18.60452181Z level=info msg="Executing migration" id="add index short_url.org_id-uid"
logger=migrator t=2026-07-08T05:41:18.60470386Z level=info msg="Migration successfully executed" id="add index short_url.org_id-uid" duration=182.561µs
logger=migrator t=2026-07-08T05:41:18.608359223Z level=info msg="Executing migration" id="alter table short_url alter column created_by type to bigint"
logger=migrator t=2026-07-08T05:41:18.608390902Z level=info msg="Migration successfully executed" id="alter table short_url alter column created_by type to bigint" duration=37.224µs
logger=migrator t=2026-07-08T05:41:18.610872346Z level=info msg="Executing migration" id="delete alert_definition table"
logger=migrator t=2026-07-08T05:41:18.61091124Z level=info msg="Migration successfully executed" id="delete alert_definition table" duration=46.168µs
logger=migrator t=2026-07-08T05:41:18.613969335Z level=info msg="Executing migration" id="recreate alert_definition table"
logger=migrator t=2026-07-08T05:41:18.614188644Z level=info msg="Migration successfully executed" id="recreate alert_definition table" duration=219.784µs
logger=migrator t=2026-07-08T05:41:18.617252672Z level=info msg="Executing migration" id="add index in alert_definition on org_id and title columns"
logger=migrator t=2026-07-08T05:41:18.617439264Z level=info msg="Migration successfully executed" id="add index in alert_definition on org_id and title columns" duration=186.949µs
logger=migrator t=2026-07-08T05:41:18.620078399Z level=info msg="Executing migration" id="add index in alert_definition on org_id and uid columns"
logger=migrator t=2026-07-08T05:41:18.620262254Z level=info msg="Migration successfully executed" id="add index in alert_definition on org_id and uid columns" duration=184.07µs
logger=migrator t=2026-07-08T05:41:18.623540606Z level=info msg="Executing migration" id="alter alert_definition table data column to mediumtext in mysql"
logger=migrator t=2026-07-08T05:41:18.623567501Z level=info msg="Migration successfully executed" id="alter alert_definition table data column to mediumtext in mysql" duration=27.199µs
logger=migrator t=2026-07-08T05:41:18.625775376Z level=info msg="Executing migration" id="drop index in alert_definition on org_id and title columns"
logger=migrator t=2026-07-08T05:41:18.626026161Z level=info msg="Migration successfully executed" id="drop index in alert_definition on org_id and title columns" duration=251.218µs
logger=migrator t=2026-07-08T05:41:18.629105391Z level=info msg="Executing migration" id="drop index in alert_definition on org_id and uid columns"
logger=migrator t=2026-07-08T05:41:18.629289968Z level=info msg="Migration successfully executed" id="drop index in alert_definition on org_id and uid columns" duration=184.814µs
logger=migrator t=2026-07-08T05:41:18.632220378Z level=info msg="Executing migration" id="add unique index in alert_definition on org_id and title columns"
logger=migrator t=2026-07-08T05:41:18.632510775Z level=info msg="Migration successfully executed" id="add unique index in alert_definition on org_id and title columns" duration=290.128µs
logger=migrator t=2026-07-08T05:41:18.635534716Z level=info msg="Executing migration" id="add unique index in alert_definition on org_id and uid columns"
logger=migrator t=2026-07-08T05:41:18.635834733Z level=info msg="Migration successfully executed" id="add unique index in alert_definition on org_id and uid columns" duration=269.601µs
logger=migrator t=2026-07-08T05:41:18.639091892Z level=info msg="Executing migration" id="Add column paused in alert_definition"
logger=migrator t=2026-07-08T05:41:18.639704666Z level=info msg="Migration successfully executed" id="Add column paused in alert_definition" duration=617.349µs
logger=migrator t=2026-07-08T05:41:18.642426145Z level=info msg="Executing migration" id="drop alert_definition table"
logger=migrator t=2026-07-08T05:41:18.642666498Z level=info msg="Migration successfully executed" id="drop alert_definition table" duration=240.137µs
logger=migrator t=2026-07-08T05:41:18.644843559Z level=info msg="Executing migration" id="delete alert_definition_version table"
logger=migrator t=2026-07-08T05:41:18.644879072Z level=info msg="Migration successfully executed" id="delete alert_definition_version table" duration=35.448µs
logger=migrator t=2026-07-08T05:41:18.646993679Z level=info msg="Executing migration" id="recreate alert_definition_version table"
logger=migrator t=2026-07-08T05:41:18.647186481Z level=info msg="Migration successfully executed" id="recreate alert_definition_version table" duration=193.084µs
logger=migrator t=2026-07-08T05:41:18.651171881Z level=info msg="Executing migration" id="add index in alert_definition_version table on alert_definition_id and version columns"
logger=migrator t=2026-07-08T05:41:18.651383149Z level=info msg="Migration successfully executed" id="add index in alert_definition_version table on alert_definition_id and version columns" duration=211.297µs
logger=migrator t=2026-07-08T05:41:18.653703938Z level=info msg="Executing migration" id="add index in alert_definition_version table on alert_definition_uid and version columns"
logger=migrator t=2026-07-08T05:41:18.653925569Z level=info msg="Migration successfully executed" id="add index in alert_definition_version table on alert_definition_uid and version columns" duration=221.684µs
logger=migrator t=2026-07-08T05:41:18.65705484Z level=info msg="Executing migration" id="alter alert_definition_version table data column to mediumtext in mysql"
logger=migrator t=2026-07-08T05:41:18.657088808Z level=info msg="Migration successfully executed" id="alter alert_definition_version table data column to mediumtext in mysql" duration=34.228µs
logger=migrator t=2026-07-08T05:41:18.659435089Z level=info msg="Executing migration" id="drop alert_definition_version table"
logger=migrator t=2026-07-08T05:41:18.659666179Z level=info msg="Migration successfully executed" id="drop alert_definition_version table" duration=231.001µs
logger=migrator t=2026-07-08T05:41:18.662048895Z level=info msg="Executing migration" id="create alert_instance table"
logger=migrator t=2026-07-08T05:41:18.662257857Z level=info msg="Migration successfully executed" id="create alert_instance table" duration=209.132µs
logger=migrator t=2026-07-08T05:41:18.664498636Z level=info msg="Executing migration" id="add index in alert_instance table on def_org_id, def_uid and current_state columns"
logger=migrator t=2026-07-08T05:41:18.664695294Z level=info msg="Migration successfully executed" id="add index in alert_instance table on def_org_id, def_uid and current_state columns" duration=205.047µs
logger=migrator t=2026-07-08T05:41:18.667169939Z level=info msg="Executing migration" id="add index in alert_instance table on def_org_id, current_state columns"
logger=migrator t=2026-07-08T05:41:18.667353187Z level=info msg="Migration successfully executed" id="add index in alert_instance table on def_org_id, current_state columns" duration=183.272µs
logger=migrator t=2026-07-08T05:41:18.669839577Z level=info msg="Executing migration" id="add column current_state_end to alert_instance"
logger=migrator t=2026-07-08T05:41:18.670404454Z level=info msg="Migration successfully executed" id="add column current_state_end to alert_instance" duration=565.05µs
logger=migrator t=2026-07-08T05:41:18.672646644Z level=info msg="Executing migration" id="remove index def_org_id, def_uid, current_state on alert_instance"
logger=migrator t=2026-07-08T05:41:18.672856764Z level=info msg="Migration successfully executed" id="remove index def_org_id, def_uid, current_state on alert_instance" duration=210.571µs
logger=migrator t=2026-07-08T05:41:18.67584935Z level=info msg="Executing migration" id="remove index def_org_id, current_state on alert_instance"
logger=migrator t=2026-07-08T05:41:18.6760802Z level=info msg="Migration successfully executed" id="remove index def_org_id, current_state on alert_instance" duration=230.903µs
logger=migrator t=2026-07-08T05:41:18.678771385Z level=info msg="Executing migration" id="rename def_org_id to rule_org_id in alert_instance"
logger=migrator t=2026-07-08T05:41:18.681043121Z level=info msg="Migration successfully executed" id="rename def_org_id to rule_org_id in alert_instance" duration=2.271761ms
logger=migrator t=2026-07-08T05:41:18.684968392Z level=info msg="Executing migration" id="rename def_uid to rule_uid in alert_instance"
logger=migrator t=2026-07-08T05:41:18.687409492Z level=info msg="Migration successfully executed" id="rename def_uid to rule_uid in alert_instance" duration=2.440782ms
logger=migrator t=2026-07-08T05:41:18.691038959Z level=info msg="Executing migration" id="add index rule_org_id, rule_uid, current_state on alert_instance"
logger=migrator t=2026-07-08T05:41:18.691255792Z level=info msg="Migration successfully executed" id="add index rule_org_id, rule_uid, current_state on alert_instance" duration=217.15µs
logger=migrator t=2026-07-08T05:41:18.693447587Z level=info msg="Executing migration" id="add index rule_org_id, current_state on alert_instance"
logger=migrator t=2026-07-08T05:41:18.693641088Z level=info msg="Migration successfully executed" id="add index rule_org_id, current_state on alert_instance" duration=193.595µs
logger=migrator t=2026-07-08T05:41:18.695971935Z level=info msg="Executing migration" id="add current_reason column related to current_state"
logger=migrator t=2026-07-08T05:41:18.69652987Z level=info msg="Migration successfully executed" id="add current_reason column related to current_state" duration=557.879µs
logger=migrator t=2026-07-08T05:41:18.698738194Z level=info msg="Executing migration" id="add result_fingerprint column to alert_instance"
logger=migrator t=2026-07-08T05:41:18.699310846Z level=info msg="Migration successfully executed" id="add result_fingerprint column to alert_instance" duration=564.071µs
logger=migrator t=2026-07-08T05:41:18.70154167Z level=info msg="Executing migration" id="create alert_rule table"
logger=migrator t=2026-07-08T05:41:18.701746905Z level=info msg="Migration successfully executed" id="create alert_rule table" duration=205.204µs
logger=migrator t=2026-07-08T05:41:18.704186021Z level=info msg="Executing migration" id="add index in alert_rule on org_id and title columns"
logger=migrator t=2026-07-08T05:41:18.704391207Z level=info msg="Migration successfully executed" id="add index in alert_rule on org_id and title columns" duration=199.14µs
logger=migrator t=2026-07-08T05:41:18.709634252Z level=info msg="Executing migration" id="add index in alert_rule on org_id and uid columns"
logger=migrator t=2026-07-08T05:41:18.709970116Z level=info msg="Migration successfully executed" id="add index in alert_rule on org_id and uid columns" duration=335.787µs
logger=migrator t=2026-07-08T05:41:18.712833474Z level=info msg="Executing migration" id="add index in alert_rule on org_id, namespace_uid, group_uid columns"
logger=migrator t=2026-07-08T05:41:18.713051179Z level=info msg="Migration successfully executed" id="add index in alert_rule on org_id, namespace_uid, group_uid columns" duration=218.131µs
logger=migrator t=2026-07-08T05:41:18.715956501Z level=info msg="Executing migration" id="alter alert_rule table data column to mediumtext in mysql"
logger=migrator t=2026-07-08T05:41:18.715987566Z level=info msg="Migration successfully executed" id="alter alert_rule table data column to mediumtext in mysql" duration=31.54µs
logger=migrator t=2026-07-08T05:41:18.718239216Z level=info msg="Executing migration" id="add column for to alert_rule"
logger=migrator t=2026-07-08T05:41:18.718844996Z level=info msg="Migration successfully executed" id="add column for to alert_rule" duration=605.703µs
logger=migrator t=2026-07-08T05:41:18.720933694Z level=info msg="Executing migration" id="add column annotations to alert_rule"
logger=migrator t=2026-07-08T05:41:18.721476494Z level=info msg="Migration successfully executed" id="add column annotations to alert_rule" duration=542.803µs
logger=migrator t=2026-07-08T05:41:18.724222968Z level=info msg="Executing migration" id="add column labels to alert_rule"
logger=migrator t=2026-07-08T05:41:18.724760591Z level=info msg="Migration successfully executed" id="add column labels to alert_rule" duration=537.598µs
logger=migrator t=2026-07-08T05:41:18.726857867Z level=info msg="Executing migration" id="remove unique index from alert_rule on org_id, title columns"
logger=migrator t=2026-07-08T05:41:18.72704538Z level=info msg="Migration successfully executed" id="remove unique index from alert_rule on org_id, title columns" duration=187.856µs
logger=migrator t=2026-07-08T05:41:18.729357595Z level=info msg="Executing migration" id="add index in alert_rule on org_id, namespase_uid and title columns"
logger=migrator t=2026-07-08T05:41:18.7295331Z level=info msg="Migration successfully executed" id="add index in alert_rule on org_id, namespase_uid and title columns" duration=175.563µs
logger=migrator t=2026-07-08T05:41:18.731874413Z level=info msg="Executing migration" id="add dashboard_uid column to alert_rule"
logger=migrator t=2026-07-08T05:41:18.732417542Z level=info msg="Migration successfully executed" id="add dashboard_uid column to alert_rule" duration=543.08µs
logger=migrator t=2026-07-08T05:41:18.734454464Z level=info msg="Executing migration" id="add panel_id column to alert_rule"
logger=migrator t=2026-07-08T05:41:18.734983814Z level=info msg="Migration successfully executed" id="add panel_id column to alert_rule" duration=528.917µs
logger=migrator t=2026-07-08T05:41:18.738498749Z level=info msg="Executing migration" id="add index in alert_rule on org_id, dashboard_uid and panel_id columns"
logger=migrator t=2026-07-08T05:41:18.738699225Z level=info msg="Migration successfully executed" id="add index in alert_rule on org_id, dashboard_uid and panel_id columns" duration=200.675µs
logger=migrator t=2026-07-08T05:41:18.741458878Z level=info msg="Executing migration" id="add rule_group_idx column to alert_rule"
logger=migrator t=2026-07-08T05:41:18.742030943Z level=info msg="Migration successfully executed" id="add rule_group_idx column to alert_rule" duration=571.853µs
logger=migrator t=2026-07-08T05:41:18.746580108Z level=info msg="Executing migration" id="add is_paused column to alert_rule table"
logger=migrator t=2026-07-08T05:41:18.747203159Z level=info msg="Migration successfully executed" id="add is_paused column to alert_rule table" duration=630.437µs
logger=migrator t=2026-07-08T05:41:18.749963676Z level=info msg="Executing migration" id="fix is_paused column for alert_rule table"
logger=migrator t=2026-07-08T05:41:18.749996706Z level=info msg="Migration successfully executed" id="fix is_paused column for alert_rule table" duration=41.241µs
logger=migrator t=2026-07-08T05:41:18.752421596Z level=info msg="Executing migration" id="create alert_rule_version table"
logger=migrator t=2026-07-08T05:41:18.752636996Z level=info msg="Migration successfully executed" id="create alert_rule_version table" duration=215.251µs
logger=migrator t=2026-07-08T05:41:18.754780249Z level=info msg="Executing migration" id="add index in alert_rule_version table on rule_org_id, rule_uid and version columns"
logger=migrator t=2026-07-08T05:41:18.755007748Z level=info msg="Migration successfully executed" id="add index in alert_rule_version table on rule_org_id, rule_uid and version columns" duration=227.468µs
logger=migrator t=2026-07-08T05:41:18.757073954Z level=info msg="Executing migration" id="add index in alert_rule_version table on rule_org_id, rule_namespace_uid and rule_group columns"
logger=migrator t=2026-07-08T05:41:18.757262032Z level=info msg="Migration successfully executed" id="add index in alert_rule_version table on rule_org_id, rule_namespace_uid and rule_group columns" duration=188.139µs
logger=migrator t=2026-07-08T05:41:18.760010253Z level=info msg="Executing migration" id="alter alert_rule_version table data column to mediumtext in mysql"
logger=migrator t=2026-07-08T05:41:18.760041503Z level=info msg="Migration successfully executed" id="alter alert_rule_version table data column to mediumtext in mysql" duration=37.272µs
logger=migrator t=2026-07-08T05:41:18.762134559Z level=info msg="Executing migration" id="add column for to alert_rule_version"
logger=migrator t=2026-07-08T05:41:18.762731817Z level=info msg="Migration successfully executed" id="add column for to alert_rule_version" duration=596.952µs
logger=migrator t=2026-07-08T05:41:18.764849454Z level=info msg="Executing migration" id="add column annotations to alert_rule_version"
logger=migrator t=2026-07-08T05:41:18.765410363Z level=info msg="Migration successfully executed" id="add column annotations to alert_rule_version" duration=561.112µs
logger=migrator t=2026-07-08T05:41:18.767711701Z level=info msg="Executing migration" id="add column labels to alert_rule_version"
logger=migrator t=2026-07-08T05:41:18.768339353Z level=info msg="Migration successfully executed" id="add column labels to alert_rule_version" duration=627.878µs
logger=migrator t=2026-07-08T05:41:18.770597978Z level=info msg="Executing migration" id="add rule_group_idx column to alert_rule_version"
logger=migrator t=2026-07-08T05:41:18.771151668Z level=info msg="Migration successfully executed" id="add rule_group_idx column to alert_rule_version" duration=559.954µs
logger=migrator t=2026-07-08T05:41:18.773943721Z level=info msg="Executing migration" id="add is_paused column to alert_rule_versions table"
logger=migrator t=2026-07-08T05:41:18.774538656Z level=info msg="Migration successfully executed" id="add is_paused column to alert_rule_versions table" duration=594.904µs
logger=migrator t=2026-07-08T05:41:18.776730148Z level=info msg="Executing migration" id="fix is_paused column for alert_rule_version table"
logger=migrator t=2026-07-08T05:41:18.77675855Z level=info msg="Migration successfully executed" id="fix is_paused column for alert_rule_version table" duration=28.67µs
logger=migrator t=2026-07-08T05:41:18.779369641Z level=info msg="Executing migration" id=create_alert_configuration_table
logger=migrator t=2026-07-08T05:41:18.779528031Z level=info msg="Migration successfully executed" id=create_alert_configuration_table duration=158.683µs
logger=migrator t=2026-07-08T05:41:18.783706652Z level=info msg="Executing migration" id="Add column default in alert_configuration"
logger=migrator t=2026-07-08T05:41:18.784321666Z level=info msg="Migration successfully executed" id="Add column default in alert_configuration" duration=614.56µs
logger=migrator t=2026-07-08T05:41:18.787547305Z level=info msg="Executing migration" id="alert alert_configuration alertmanager_configuration column from TEXT to MEDIUMTEXT if mysql"
logger=migrator t=2026-07-08T05:41:18.787577225Z level=info msg="Migration successfully executed" id="alert alert_configuration alertmanager_configuration column from TEXT to MEDIUMTEXT if mysql" duration=30.285µs
logger=migrator t=2026-07-08T05:41:18.790271808Z level=info msg="Executing migration" id="add column org_id in alert_configuration"
logger=migrator t=2026-07-08T05:41:18.790855288Z level=info msg="Migration successfully executed" id="add column org_id in alert_configuration" duration=582.969µs
logger=migrator t=2026-07-08T05:41:18.793989429Z level=info msg="Executing migration" id="add index in alert_configuration table on org_id column"
logger=migrator t=2026-07-08T05:41:18.794187859Z level=info msg="Migration successfully executed" id="add index in alert_configuration table on org_id column" duration=198.518µs
logger=migrator t=2026-07-08T05:41:18.796799239Z level=info msg="Executing migration" id="add configuration_hash column to alert_configuration"
logger=migrator t=2026-07-08T05:41:18.797395082Z level=info msg="Migration successfully executed" id="add configuration_hash column to alert_configuration" duration=596.005µs
logger=migrator t=2026-07-08T05:41:18.799608293Z level=info msg="Executing migration" id=create_ngalert_configuration_table
logger=migrator t=2026-07-08T05:41:18.799774529Z level=info msg="Migration successfully executed" id=create_ngalert_configuration_table duration=166.388µs
logger=migrator t=2026-07-08T05:41:18.802018004Z level=info msg="Executing migration" id="add index in ngalert_configuration on org_id column"
logger=migrator t=2026-07-08T05:41:18.80222475Z level=info msg="Migration successfully executed" id="add index in ngalert_configuration on org_id column" duration=207.359µs
logger=migrator t=2026-07-08T05:41:18.805710503Z level=info msg="Executing migration" id="add column send_alerts_to in ngalert_configuration"
logger=migrator t=2026-07-08T05:41:18.806281409Z level=info msg="Migration successfully executed" id="add column send_alerts_to in ngalert_configuration" duration=570.954µs
logger=migrator t=2026-07-08T05:41:18.808691982Z level=info msg="Executing migration" id="create provenance_type table"
logger=migrator t=2026-07-08T05:41:18.808867226Z level=info msg="Migration successfully executed" id="create provenance_type table" duration=169.928µs
logger=migrator t=2026-07-08T05:41:18.811259442Z level=info msg="Executing migration" id="add index to uniquify (record_key, record_type, org_id) columns"
logger=migrator t=2026-07-08T05:41:18.811468693Z level=info msg="Migration successfully executed" id="add index to uniquify (record_key, record_type, org_id) columns" duration=202.838µs
logger=migrator t=2026-07-08T05:41:18.8147522Z level=info msg="Executing migration" id="create alert_image table"
logger=migrator t=2026-07-08T05:41:18.815190513Z level=info msg="Migration successfully executed" id="create alert_image table" duration=439.108µs
logger=migrator t=2026-07-08T05:41:18.818582083Z level=info msg="Executing migration" id="add unique index on token to alert_image table"
logger=migrator t=2026-07-08T05:41:18.818795827Z level=info msg="Migration successfully executed" id="add unique index on token to alert_image table" duration=214.192µs
logger=migrator t=2026-07-08T05:41:18.821451823Z level=info msg="Executing migration" id="support longer URLs in alert_image table"
logger=migrator t=2026-07-08T05:41:18.821484767Z level=info msg="Migration successfully executed" id="support longer URLs in alert_image table" duration=40.773µs
logger=migrator t=2026-07-08T05:41:18.824072637Z level=info msg="Executing migration" id=create_alert_configuration_history_table
logger=migrator t=2026-07-08T05:41:18.824263979Z level=info msg="Migration successfully executed" id=create_alert_configuration_history_table duration=191.117µs
logger=migrator t=2026-07-08T05:41:18.826716534Z level=info msg="Executing migration" id="drop non-unique orgID index on alert_configuration"
logger=migrator t=2026-07-08T05:41:18.826936414Z level=info msg="Migration successfully executed" id="drop non-unique orgID index on alert_configuration" duration=227.39µs
logger=migrator t=2026-07-08T05:41:18.829146735Z level=info msg="Executing migration" id="drop unique orgID index on alert_configuration if exists"
logger=migrator t=2026-07-08T05:41:18.829218214Z level=warn msg="Skipping migration: Already executed, but not recorded in migration log" id="drop unique orgID index on alert_configuration if exists"
logger=migrator t=2026-07-08T05:41:18.831272005Z level=info msg="Executing migration" id="extract alertmanager configuration history to separate table"
logger=migrator t=2026-07-08T05:41:18.831387004Z level=info msg="Migration successfully executed" id="extract alertmanager configuration history to separate table" duration=115.131µs
logger=migrator t=2026-07-08T05:41:18.833359376Z level=info msg="Executing migration" id="add unique index on orgID to alert_configuration"
logger=migrator t=2026-07-08T05:41:18.833548838Z level=info msg="Migration successfully executed" id="add unique index on orgID to alert_configuration" duration=189.726µs
logger=migrator t=2026-07-08T05:41:18.835925088Z level=info msg="Executing migration" id="add last_applied column to alert_configuration_history"
logger=migrator t=2026-07-08T05:41:18.83655592Z level=info msg="Migration successfully executed" id="add last_applied column to alert_configuration_history" duration=630.952µs
logger=migrator t=2026-07-08T05:41:18.838682335Z level=info msg="Executing migration" id="create library_element table v1"
logger=migrator t=2026-07-08T05:41:18.838906339Z level=info msg="Migration successfully executed" id="create library_element table v1" duration=224.046µs
logger=migrator t=2026-07-08T05:41:18.841538395Z level=info msg="Executing migration" id="add index library_element org_id-folder_id-name-kind"
logger=migrator t=2026-07-08T05:41:18.841743193Z level=info msg="Migration successfully executed" id="add index library_element org_id-folder_id-name-kind" duration=204.402µs
logger=migrator t=2026-07-08T05:41:18.843769082Z level=info msg="Executing migration" id="create library_element_connection table v1"
logger=migrator t=2026-07-08T05:41:18.843928664Z level=info msg="Migration successfully executed" id="create library_element_connection table v1" duration=159.508µs
logger=migrator t=2026-07-08T05:41:18.847088338Z level=info msg="Executing migration" id="add index library_element_connection element_id-kind-connection_id"
logger=migrator t=2026-07-08T05:41:18.847302904Z level=info msg="Migration successfully executed" id="add index library_element_connection element_id-kind-connection_id" duration=214.784µs
logger=migrator t=2026-07-08T05:41:18.849700682Z level=info msg="Executing migration" id="add unique index library_element org_id_uid"
logger=migrator t=2026-07-08T05:41:18.849886058Z level=info msg="Migration successfully executed" id="add unique index library_element org_id_uid" duration=185.375µs
logger=migrator t=2026-07-08T05:41:18.852208437Z level=info msg="Executing migration" id="increase max description length to 2048"
logger=migrator t=2026-07-08T05:41:18.852229044Z level=info msg="Migration successfully executed" id="increase max description length to 2048" duration=20.822µs
logger=migrator t=2026-07-08T05:41:18.854203477Z level=info msg="Executing migration" id="alter library_element model to mediumtext"
logger=migrator t=2026-07-08T05:41:18.854234529Z level=info msg="Migration successfully executed" id="alter library_element model to mediumtext" duration=23.527µs
logger=migrator t=2026-07-08T05:41:18.85639947Z level=info msg="Executing migration" id="add library_element folder uid"
logger=migrator t=2026-07-08T05:41:18.857093732Z level=info msg="Migration successfully executed" id="add library_element folder uid" duration=687.458µs
logger=migrator t=2026-07-08T05:41:18.859240331Z level=info msg="Executing migration" id="populate library_element folder_uid"
logger=migrator t=2026-07-08T05:41:18.859315222Z level=info msg="Migration successfully executed" id="populate library_element folder_uid" duration=75.385µs
logger=migrator t=2026-07-08T05:41:18.861350299Z level=info msg="Executing migration" id="add index library_element org_id-folder_uid-name-kind"
logger=migrator t=2026-07-08T05:41:18.861544003Z level=info msg="Migration successfully executed" id="add index library_element org_id-folder_uid-name-kind" duration=193.787µs
logger=migrator t=2026-07-08T05:41:18.863620778Z level=info msg="Executing migration" id="clone move dashboard alerts to unified alerting"
logger=migrator t=2026-07-08T05:41:18.863751255Z level=info msg="Migration successfully executed" id="clone move dashboard alerts to unified alerting" duration=130.546µs
logger=migrator t=2026-07-08T05:41:18.866064427Z level=info msg="Executing migration" id="create data_keys table"
logger=migrator t=2026-07-08T05:41:18.866238675Z level=info msg="Migration successfully executed" id="create data_keys table" duration=174.38µs
logger=migrator t=2026-07-08T05:41:18.868597413Z level=info msg="Executing migration" id="create secrets table"
logger=migrator t=2026-07-08T05:41:18.8687697Z level=info msg="Migration successfully executed" id="create secrets table" duration=172.127µs
logger=migrator t=2026-07-08T05:41:18.87125854Z level=info msg="Executing migration" id="rename data_keys name column to id"
logger=migrator t=2026-07-08T05:41:18.873999117Z level=info msg="Migration successfully executed" id="rename data_keys name column to id" duration=2.739935ms
logger=migrator t=2026-07-08T05:41:18.876250358Z level=info msg="Executing migration" id="add name column into data_keys"
logger=migrator t=2026-07-08T05:41:18.876924044Z level=info msg="Migration successfully executed" id="add name column into data_keys" duration=673.587µs
logger=migrator t=2026-07-08T05:41:18.879001045Z level=info msg="Executing migration" id="copy data_keys id column values into name"
logger=migrator t=2026-07-08T05:41:18.879041268Z level=info msg="Migration successfully executed" id="copy data_keys id column values into name" duration=40.255µs
logger=migrator t=2026-07-08T05:41:18.880997074Z level=info msg="Executing migration" id="rename data_keys name column to label"
logger=migrator t=2026-07-08T05:41:18.88365799Z level=info msg="Migration successfully executed" id="rename data_keys name column to label" duration=2.660423ms
logger=migrator t=2026-07-08T05:41:18.88588225Z level=info msg="Executing migration" id="rename data_keys id column back to name"
logger=migrator t=2026-07-08T05:41:18.88849147Z level=info msg="Migration successfully executed" id="rename data_keys id column back to name" duration=2.608965ms
logger=migrator t=2026-07-08T05:41:18.891429128Z level=info msg="Executing migration" id="create kv_store table v1"
logger=migrator t=2026-07-08T05:41:18.891616285Z level=info msg="Migration successfully executed" id="create kv_store table v1" duration=187.298µs
logger=migrator t=2026-07-08T05:41:18.89409351Z level=info msg="Executing migration" id="add index kv_store.org_id-namespace-key"
logger=migrator t=2026-07-08T05:41:18.894297855Z level=info msg="Migration successfully executed" id="add index kv_store.org_id-namespace-key" duration=204.144µs
logger=migrator t=2026-07-08T05:41:18.896686918Z level=info msg="Executing migration" id="update dashboard_uid and panel_id from existing annotations"
logger=migrator t=2026-07-08T05:41:18.89678754Z level=info msg="Migration successfully executed" id="update dashboard_uid and panel_id from existing annotations" duration=101.121µs
logger=migrator t=2026-07-08T05:41:18.898896679Z level=info msg="Executing migration" id="create permission table"
logger=migrator t=2026-07-08T05:41:18.89904977Z level=info msg="Migration successfully executed" id="create permission table" duration=153.133µs
logger=migrator t=2026-07-08T05:41:18.901881301Z level=info msg="Executing migration" id="add unique index permission.role_id"
logger=migrator t=2026-07-08T05:41:18.902065682Z level=info msg="Migration successfully executed" id="add unique index permission.role_id" duration=184.599µs
logger=migrator t=2026-07-08T05:41:18.904492635Z level=info msg="Executing migration" id="add unique index role_id_action_scope"
logger=migrator t=2026-07-08T05:41:18.904685732Z level=info msg="Migration successfully executed" id="add unique index role_id_action_scope" duration=193.069µs
logger=migrator t=2026-07-08T05:41:18.907330827Z level=info msg="Executing migration" id="create role table"
logger=migrator t=2026-07-08T05:41:18.907512532Z level=info msg="Migration successfully executed" id="create role table" duration=181.974µs
logger=migrator t=2026-07-08T05:41:18.909994105Z level=info msg="Executing migration" id="add column display_name"
logger=migrator t=2026-07-08T05:41:18.910667489Z level=info msg="Migration successfully executed" id="add column display_name" duration=673.463µs
logger=migrator t=2026-07-08T05:41:18.912672807Z level=info msg="Executing migration" id="add column group_name"
logger=migrator t=2026-07-08T05:41:18.913313462Z level=info msg="Migration successfully executed" id="add column group_name" duration=640.059µs
logger=migrator t=2026-07-08T05:41:18.915311657Z level=info msg="Executing migration" id="add index role.org_id"
logger=migrator t=2026-07-08T05:41:18.915499613Z level=info msg="Migration successfully executed" id="add index role.org_id" duration=187.946µs
logger=migrator t=2026-07-08T05:41:18.917672283Z level=info msg="Executing migration" id="add unique index role_org_id_name"
logger=migrator t=2026-07-08T05:41:18.917862583Z level=info msg="Migration successfully executed" id="add unique index role_org_id_name" duration=190.65µs
logger=migrator t=2026-07-08T05:41:18.920151683Z level=info msg="Executing migration" id="add index role_org_id_uid"
logger=migrator t=2026-07-08T05:41:18.92032711Z level=info msg="Migration successfully executed" id="add index role_org_id_uid" duration=175.515µs
logger=migrator t=2026-07-08T05:41:18.922943472Z level=info msg="Executing migration" id="create team role table"
logger=migrator t=2026-07-08T05:41:18.92309889Z level=info msg="Migration successfully executed" id="create team role table" duration=155.535µs
logger=migrator t=2026-07-08T05:41:18.929486524Z level=info msg="Executing migration" id="add index team_role.org_id"
logger=migrator t=2026-07-08T05:41:18.929925798Z level=info msg="Migration successfully executed" id="add index team_role.org_id" duration=440.052µs
logger=migrator t=2026-07-08T05:41:18.933974754Z level=info msg="Executing migration" id="add unique index team_role_org_id_team_id_role_id"
logger=migrator t=2026-07-08T05:41:18.934255741Z level=info msg="Migration successfully executed" id="add unique index team_role_org_id_team_id_role_id" duration=281.391µs
logger=migrator t=2026-07-08T05:41:18.936754767Z level=info msg="Executing migration" id="add index team_role.team_id"
logger=migrator t=2026-07-08T05:41:18.936961281Z level=info msg="Migration successfully executed" id="add index team_role.team_id" duration=206.521µs
logger=migrator t=2026-07-08T05:41:18.939334819Z level=info msg="Executing migration" id="create user role table"
logger=migrator t=2026-07-08T05:41:18.939507366Z level=info msg="Migration successfully executed" id="create user role table" duration=172.458µs
logger=migrator t=2026-07-08T05:41:18.941799086Z level=info msg="Executing migration" id="add index user_role.org_id"
logger=migrator t=2026-07-08T05:41:18.941993018Z level=info msg="Migration successfully executed" id="add index user_role.org_id" duration=193.923µs
logger=migrator t=2026-07-08T05:41:18.944292156Z level=info msg="Executing migration" id="add unique index user_role_org_id_user_id_role_id"
logger=migrator t=2026-07-08T05:41:18.944481349Z level=info msg="Migration successfully executed" id="add unique index user_role_org_id_user_id_role_id" duration=189.292µs
logger=migrator t=2026-07-08T05:41:18.946699409Z level=info msg="Executing migration" id="add index user_role.user_id"
logger=migrator t=2026-07-08T05:41:18.946895003Z level=info msg="Migration successfully executed" id="add index user_role.user_id" duration=195.557µs
logger=migrator t=2026-07-08T05:41:18.949090085Z level=info msg="Executing migration" id="create builtin role table"
logger=migrator t=2026-07-08T05:41:18.949250718Z level=info msg="Migration successfully executed" id="create builtin role table" duration=166.5µs
logger=migrator t=2026-07-08T05:41:18.951392597Z level=info msg="Executing migration" id="add index builtin_role.role_id"
logger=migrator t=2026-07-08T05:41:18.951596039Z level=info msg="Migration successfully executed" id="add index builtin_role.role_id" duration=203.658µs
logger=migrator t=2026-07-08T05:41:18.953602093Z level=info msg="Executing migration" id="add index builtin_role.name"
logger=migrator t=2026-07-08T05:41:18.953785582Z level=info msg="Migration successfully executed" id="add index builtin_role.name" duration=183.903µs
logger=migrator t=2026-07-08T05:41:18.955845089Z level=info msg="Executing migration" id="Add column org_id to builtin_role table"
logger=migrator t=2026-07-08T05:41:18.956549477Z level=info msg="Migration successfully executed" id="Add column org_id to builtin_role table" duration=704.428µs
logger=migrator t=2026-07-08T05:41:18.958584713Z level=info msg="Executing migration" id="add index builtin_role.org_id"
logger=migrator t=2026-07-08T05:41:18.958825178Z level=info msg="Migration successfully executed" id="add index builtin_role.org_id" duration=240.544µs
logger=migrator t=2026-07-08T05:41:18.960967436Z level=info msg="Executing migration" id="add unique index builtin_role_org_id_role_id_role"
logger=migrator t=2026-07-08T05:41:18.961164777Z level=info msg="Migration successfully executed" id="add unique index builtin_role_org_id_role_id_role" duration=197.419µs
logger=migrator t=2026-07-08T05:41:18.963280139Z level=info msg="Executing migration" id="Remove unique index role_org_id_uid"
logger=migrator t=2026-07-08T05:41:18.963478499Z level=info msg="Migration successfully executed" id="Remove unique index role_org_id_uid" duration=198.282µs
logger=migrator t=2026-07-08T05:41:18.965603619Z level=info msg="Executing migration" id="add unique index role.uid"
logger=migrator t=2026-07-08T05:41:18.96579678Z level=info msg="Migration successfully executed" id="add unique index role.uid" duration=186.037µs
logger=migrator t=2026-07-08T05:41:18.968116626Z level=info msg="Executing migration" id="create seed assignment table"
logger=migrator t=2026-07-08T05:41:18.968268049Z level=info msg="Migration successfully executed" id="create seed assignment table" duration=151.837µs
logger=migrator t=2026-07-08T05:41:18.970393706Z level=info msg="Executing migration" id="add unique index builtin_role_role_name"
logger=migrator t=2026-07-08T05:41:18.970587174Z level=info msg="Migration successfully executed" id="add unique index builtin_role_role_name" duration=193.513µs
logger=migrator t=2026-07-08T05:41:18.972673504Z level=info msg="Executing migration" id="add column hidden to role table"
logger=migrator t=2026-07-08T05:41:18.97340147Z level=info msg="Migration successfully executed" id="add column hidden to role table" duration=727.637µs
logger=migrator t=2026-07-08T05:41:18.975665066Z level=info msg="Executing migration" id="permission kind migration"
logger=migrator t=2026-07-08T05:41:18.976360836Z level=info msg="Migration successfully executed" id="permission kind migration" duration=695.793µs
logger=migrator t=2026-07-08T05:41:18.978522027Z level=info msg="Executing migration" id="permission attribute migration"
logger=migrator t=2026-07-08T05:41:18.979223583Z level=info msg="Migration successfully executed" id="permission attribute migration" duration=705.595µs
logger=migrator t=2026-07-08T05:41:18.981607097Z level=info msg="Executing migration" id="permission identifier migration"
logger=migrator t=2026-07-08T05:41:18.98275516Z level=info msg="Migration successfully executed" id="permission identifier migration" duration=1.147377ms
logger=migrator t=2026-07-08T05:41:18.985678602Z level=info msg="Executing migration" id="add permission identifier index"
logger=migrator t=2026-07-08T05:41:18.985959491Z level=info msg="Migration successfully executed" id="add permission identifier index" duration=280.589µs
logger=migrator t=2026-07-08T05:41:18.988257311Z level=info msg="Executing migration" id="add permission action scope role_id index"
logger=migrator t=2026-07-08T05:41:18.988514659Z level=info msg="Migration successfully executed" id="add permission action scope role_id index" duration=257.429µs
logger=migrator t=2026-07-08T05:41:18.991215604Z level=info msg="Executing migration" id="remove permission role_id action scope index"
logger=migrator t=2026-07-08T05:41:18.991476192Z level=info msg="Migration successfully executed" id="remove permission role_id action scope index" duration=261.159µs
logger=migrator t=2026-07-08T05:41:18.993691063Z level=info msg="Executing migration" id="add group mapping UID column to user_role table"
logger=migrator t=2026-07-08T05:41:18.994818741Z level=info msg="Migration successfully executed" id="add group mapping UID column to user_role table" duration=1.116793ms
logger=migrator t=2026-07-08T05:41:18.997052414Z level=info msg="Executing migration" id="add user_role org ID, user ID, role ID, group mapping UID index"
logger=migrator t=2026-07-08T05:41:18.997330545Z level=info msg="Migration successfully executed" id="add user_role org ID, user ID, role ID, group mapping UID index" duration=278.317µs
logger=migrator t=2026-07-08T05:41:18.999649491Z level=info msg="Executing migration" id="remove user_role org ID, user ID, role ID index"
logger=migrator t=2026-07-08T05:41:18.999901533Z level=info msg="Migration successfully executed" id="remove user_role org ID, user ID, role ID index" duration=252.129µs
logger=migrator t=2026-07-08T05:41:19.008009529Z level=info msg="Executing migration" id="create query_history table v1"
logger=migrator t=2026-07-08T05:41:19.008264142Z level=info msg="Migration successfully executed" id="create query_history table v1" duration=261.148µs
logger=migrator t=2026-07-08T05:41:19.011366668Z level=info msg="Executing migration" id="add index query_history.org_id-created_by-datasource_uid"
logger=migrator t=2026-07-08T05:41:19.011593237Z level=info msg="Migration successfully executed" id="add index query_history.org_id-created_by-datasource_uid" duration=226.836µs
logger=migrator t=2026-07-08T05:41:19.014003462Z level=info msg="Executing migration" id="alter table query_history alter column created_by type to bigint"
logger=migrator t=2026-07-08T05:41:19.014028985Z level=info msg="Migration successfully executed" id="alter table query_history alter column created_by type to bigint" duration=26.001µs
logger=migrator t=2026-07-08T05:41:19.017310782Z level=info msg="Executing migration" id="create query_history_details table v1"
logger=migrator t=2026-07-08T05:41:19.017490109Z level=info msg="Migration successfully executed" id="create query_history_details table v1" duration=179.512µs
logger=migrator t=2026-07-08T05:41:19.020649203Z level=info msg="Executing migration" id="rbac disabled migrator"
logger=migrator t=2026-07-08T05:41:19.020682076Z level=info msg="Migration successfully executed" id="rbac disabled migrator" duration=33.479µs
logger=migrator t=2026-07-08T05:41:19.023116887Z level=info msg="Executing migration" id="teams permissions migration"
logger=migrator t=2026-07-08T05:41:19.023266226Z level=info msg="Migration successfully executed" id="teams permissions migration" duration=148.647µs
logger=migrator t=2026-07-08T05:41:19.025464144Z level=info msg="Executing migration" id="dashboard permissions"
logger=migrator t=2026-07-08T05:41:19.02571411Z level=info msg="Migration successfully executed" id="dashboard permissions" duration=250.418µs
logger=migrator t=2026-07-08T05:41:19.027741219Z level=info msg="Executing migration" id="dashboard permissions uid scopes"
logger=migrator t=2026-07-08T05:41:19.027896765Z level=info msg="Migration successfully executed" id="dashboard permissions uid scopes" duration=155.613µs
logger=migrator t=2026-07-08T05:41:19.030921067Z level=info msg="Executing migration" id="drop managed folder create actions"
logger=migrator t=2026-07-08T05:41:19.031045679Z level=info msg="Migration successfully executed" id="drop managed folder create actions" duration=126.261µs
logger=migrator t=2026-07-08T05:41:19.03403721Z level=info msg="Executing migration" id="alerting notification permissions"
logger=migrator t=2026-07-08T05:41:19.034231324Z level=info msg="Migration successfully executed" id="alerting notification permissions" duration=194.86µs
logger=migrator t=2026-07-08T05:41:19.03651709Z level=info msg="Executing migration" id="create query_history_star table v1"
logger=migrator t=2026-07-08T05:41:19.036749456Z level=info msg="Migration successfully executed" id="create query_history_star table v1" duration=232.922µs
logger=migrator t=2026-07-08T05:41:19.039499095Z level=info msg="Executing migration" id="add index query_history.user_id-query_uid"
logger=migrator t=2026-07-08T05:41:19.039859953Z level=info msg="Migration successfully executed" id="add index query_history.user_id-query_uid" duration=360.964µs
logger=migrator t=2026-07-08T05:41:19.042760528Z level=info msg="Executing migration" id="add column org_id in query_history_star"
logger=migrator t=2026-07-08T05:41:19.04407512Z level=info msg="Migration successfully executed" id="add column org_id in query_history_star" duration=1.314273ms
logger=migrator t=2026-07-08T05:41:19.046537184Z level=info msg="Executing migration" id="alter table query_history_star_mig column user_id type to bigint"
logger=migrator t=2026-07-08T05:41:19.046573329Z level=info msg="Migration successfully executed" id="alter table query_history_star_mig column user_id type to bigint" duration=36.377µs
logger=migrator t=2026-07-08T05:41:19.048964263Z level=info msg="Executing migration" id="create correlation table v1"
logger=migrator t=2026-07-08T05:41:19.049232777Z level=info msg="Migration successfully executed" id="create correlation table v1" duration=268.527µs
logger=migrator t=2026-07-08T05:41:19.051803995Z level=info msg="Executing migration" id="add index correlations.uid"
logger=migrator t=2026-07-08T05:41:19.052107773Z level=info msg="Migration successfully executed" id="add index correlations.uid" duration=303.879µs
logger=migrator t=2026-07-08T05:41:19.054854882Z level=info msg="Executing migration" id="add index correlations.source_uid"
logger=migrator t=2026-07-08T05:41:19.055120275Z level=info msg="Migration successfully executed" id="add index correlations.source_uid" duration=265.445µs
logger=migrator t=2026-07-08T05:41:19.057577504Z level=info msg="Executing migration" id="add correlation config column"
logger=migrator t=2026-07-08T05:41:19.058818445Z level=info msg="Migration successfully executed" id="add correlation config column" duration=1.22894ms
logger=migrator t=2026-07-08T05:41:19.060993363Z level=info msg="Executing migration" id="drop index IDX_correlation_uid - v1"
logger=migrator t=2026-07-08T05:41:19.061249033Z level=info msg="Migration successfully executed" id="drop index IDX_correlation_uid - v1" duration=255.743µs
logger=migrator t=2026-07-08T05:41:19.063838155Z level=info msg="Executing migration" id="drop index IDX_correlation_source_uid - v1"
logger=migrator t=2026-07-08T05:41:19.064077371Z level=info msg="Migration successfully executed" id="drop index IDX_correlation_source_uid - v1" duration=239.436µs
logger=migrator t=2026-07-08T05:41:19.066550969Z level=info msg="Executing migration" id="Rename table correlation to correlation_tmp_qwerty - v1"
logger=migrator t=2026-07-08T05:41:19.069848526Z level=info msg="Migration successfully executed" id="Rename table correlation to correlation_tmp_qwerty - v1" duration=3.296257ms
logger=migrator t=2026-07-08T05:41:19.0724662Z level=info msg="Executing migration" id="create correlation v2"
logger=migrator t=2026-07-08T05:41:19.072742591Z level=info msg="Migration successfully executed" id="create correlation v2" duration=276.431µs
logger=migrator t=2026-07-08T05:41:19.07622668Z level=info msg="Executing migration" id="create index IDX_correlation_uid - v2"
logger=migrator t=2026-07-08T05:41:19.076486136Z level=info msg="Migration successfully executed" id="create index IDX_correlation_uid - v2" duration=259.558µs
logger=migrator t=2026-07-08T05:41:19.078947695Z level=info msg="Executing migration" id="create index IDX_correlation_source_uid - v2"
logger=migrator t=2026-07-08T05:41:19.079202223Z level=info msg="Migration successfully executed" id="create index IDX_correlation_source_uid - v2" duration=254.57µs
logger=migrator t=2026-07-08T05:41:19.082002032Z level=info msg="Executing migration" id="create index IDX_correlation_org_id - v2"
logger=migrator t=2026-07-08T05:41:19.082246236Z level=info msg="Migration successfully executed" id="create index IDX_correlation_org_id - v2" duration=244.998µs
logger=migrator t=2026-07-08T05:41:19.085044249Z level=info msg="Executing migration" id="copy correlation v1 to v2"
logger=migrator t=2026-07-08T05:41:19.085120928Z level=info msg="Migration successfully executed" id="copy correlation v1 to v2" duration=77.227µs
logger=migrator t=2026-07-08T05:41:19.087428061Z level=info msg="Executing migration" id="drop correlation_tmp_qwerty"
logger=migrator t=2026-07-08T05:41:19.087676237Z level=info msg="Migration successfully executed" id="drop correlation_tmp_qwerty" duration=248.459µs
logger=migrator t=2026-07-08T05:41:19.090243684Z level=info msg="Executing migration" id="add provisioning column"
logger=migrator t=2026-07-08T05:41:19.091535764Z level=info msg="Migration successfully executed" id="add provisioning column" duration=1.291708ms
logger=migrator t=2026-07-08T05:41:19.094055096Z level=info msg="Executing migration" id="add type column"
logger=migrator t=2026-07-08T05:41:19.095355024Z level=info msg="Migration successfully executed" id="add type column" duration=1.299943ms
logger=migrator t=2026-07-08T05:41:19.097885384Z level=info msg="Executing migration" id="create entity_events table"
logger=migrator t=2026-07-08T05:41:19.098125091Z level=info msg="Migration successfully executed" id="create entity_events table" duration=239.874µs
logger=migrator t=2026-07-08T05:41:19.100688801Z level=info msg="Executing migration" id="create dashboard public config v1"
logger=migrator t=2026-07-08T05:41:19.100978501Z level=info msg="Migration successfully executed" id="create dashboard public config v1" duration=289.914µs
logger=migrator t=2026-07-08T05:41:19.106611049Z level=info msg="Executing migration" id="drop index UQE_dashboard_public_config_uid - v1"
logger=migrator t=2026-07-08T05:41:19.106778078Z level=warn msg="Skipping migration: Already executed, but not recorded in migration log" id="drop index UQE_dashboard_public_config_uid - v1"
logger=migrator t=2026-07-08T05:41:19.109398083Z level=info msg="Executing migration" id="drop index IDX_dashboard_public_config_org_id_dashboard_uid - v1"
logger=migrator t=2026-07-08T05:41:19.109529322Z level=warn msg="Skipping migration: Already executed, but not recorded in migration log" id="drop index IDX_dashboard_public_config_org_id_dashboard_uid - v1"
logger=migrator t=2026-07-08T05:41:19.112055693Z level=info msg="Executing migration" id="Drop old dashboard public config table"
logger=migrator t=2026-07-08T05:41:19.112328593Z level=info msg="Migration successfully executed" id="Drop old dashboard public config table" duration=272.932µs
logger=migrator t=2026-07-08T05:41:19.115117171Z level=info msg="Executing migration" id="recreate dashboard public config v1"
logger=migrator t=2026-07-08T05:41:19.115410246Z level=info msg="Migration successfully executed" id="recreate dashboard public config v1" duration=292.76µs
logger=migrator t=2026-07-08T05:41:19.118109726Z level=info msg="Executing migration" id="create index UQE_dashboard_public_config_uid - v1"
logger=migrator t=2026-07-08T05:41:19.118373154Z level=info msg="Migration successfully executed" id="create index UQE_dashboard_public_config_uid - v1" duration=263.583µs
logger=migrator t=2026-07-08T05:41:19.121055576Z level=info msg="Executing migration" id="create index IDX_dashboard_public_config_org_id_dashboard_uid - v1"
logger=migrator t=2026-07-08T05:41:19.121326531Z level=info msg="Migration successfully executed" id="create index IDX_dashboard_public_config_org_id_dashboard_uid - v1" duration=271.032µs
logger=migrator t=2026-07-08T05:41:19.124155086Z level=info msg="Executing migration" id="drop index UQE_dashboard_public_config_uid - v2"
logger=migrator t=2026-07-08T05:41:19.12440953Z level=info msg="Migration successfully executed" id="drop index UQE_dashboard_public_config_uid - v2" duration=255.156µs
logger=migrator t=2026-07-08T05:41:19.12702735Z level=info msg="Executing migration" id="drop index IDX_dashboard_public_config_org_id_dashboard_uid - v2"
logger=migrator t=2026-07-08T05:41:19.127267851Z level=info msg="Migration successfully executed" id="drop index IDX_dashboard_public_config_org_id_dashboard_uid - v2" duration=240.516µs
logger=migrator t=2026-07-08T05:41:19.131239206Z level=info msg="Executing migration" id="Drop public config table"
logger=migrator t=2026-07-08T05:41:19.131494797Z level=info msg="Migration successfully executed" id="Drop public config table" duration=249.87µs
logger=migrator t=2026-07-08T05:41:19.134751223Z level=info msg="Executing migration" id="Recreate dashboard public config v2"
logger=migrator t=2026-07-08T05:41:19.135052472Z level=info msg="Migration successfully executed" id="Recreate dashboard public config v2" duration=301.487µs
logger=migrator t=2026-07-08T05:41:19.138119169Z level=info msg="Executing migration" id="create index UQE_dashboard_public_config_uid - v2"
logger=migrator t=2026-07-08T05:41:19.138413024Z level=info msg="Migration successfully executed" id="create index UQE_dashboard_public_config_uid - v2" duration=294.447µs
logger=migrator t=2026-07-08T05:41:19.142193197Z level=info msg="Executing migration" id="create index IDX_dashboard_public_config_org_id_dashboard_uid - v2"
logger=migrator t=2026-07-08T05:41:19.142449724Z level=info msg="Migration successfully executed" id="create index IDX_dashboard_public_config_org_id_dashboard_uid - v2" duration=250.894µs
logger=migrator t=2026-07-08T05:41:19.145002833Z level=info msg="Executing migration" id="create index UQE_dashboard_public_config_access_token - v2"
logger=migrator t=2026-07-08T05:41:19.145222773Z level=info msg="Migration successfully executed" id="create index UQE_dashboard_public_config_access_token - v2" duration=220.22µs
logger=migrator t=2026-07-08T05:41:19.148132654Z level=info msg="Executing migration" id="Rename table dashboard_public_config to dashboard_public - v2"
logger=migrator t=2026-07-08T05:41:19.150167064Z level=info msg="Migration successfully executed" id="Rename table dashboard_public_config to dashboard_public - v2" duration=2.033801ms
logger=migrator t=2026-07-08T05:41:19.152571339Z level=info msg="Executing migration" id="add annotations_enabled column"
logger=migrator t=2026-07-08T05:41:19.153367224Z level=info msg="Migration successfully executed" id="add annotations_enabled column" duration=788.477µs
logger=migrator t=2026-07-08T05:41:19.155598876Z level=info msg="Executing migration" id="add time_selection_enabled column"
logger=migrator t=2026-07-08T05:41:19.156423359Z level=info msg="Migration successfully executed" id="add time_selection_enabled column" duration=824.772µs
logger=migrator t=2026-07-08T05:41:19.158586552Z level=info msg="Executing migration" id="delete orphaned public dashboards"
logger=migrator t=2026-07-08T05:41:19.158644689Z level=info msg="Migration successfully executed" id="delete orphaned public dashboards" duration=63.991µs
logger=migrator t=2026-07-08T05:41:19.160722679Z level=info msg="Executing migration" id="add share column"
logger=migrator t=2026-07-08T05:41:19.161468977Z level=info msg="Migration successfully executed" id="add share column" duration=745.903µs
logger=migrator t=2026-07-08T05:41:19.163749764Z level=info msg="Executing migration" id="backfill empty share column fields with default of public"
logger=migrator t=2026-07-08T05:41:19.163798362Z level=info msg="Migration successfully executed" id="backfill empty share column fields with default of public" duration=48.772µs
logger=migrator t=2026-07-08T05:41:19.166055942Z level=info msg="Executing migration" id="create file table"
logger=migrator t=2026-07-08T05:41:19.166235506Z level=info msg="Migration successfully executed" id="create file table" duration=179.662µs
logger=migrator t=2026-07-08T05:41:19.168678776Z level=info msg="Executing migration" id="file table idx: path natural pk"
logger=migrator t=2026-07-08T05:41:19.168892524Z level=info msg="Migration successfully executed" id="file table idx: path natural pk" duration=213.778µs
logger=migrator t=2026-07-08T05:41:19.171602812Z level=info msg="Executing migration" id="file table idx: parent_folder_path_hash fast folder retrieval"
logger=migrator t=2026-07-08T05:41:19.171831645Z level=info msg="Migration successfully executed" id="file table idx: parent_folder_path_hash fast folder retrieval" duration=228.924µs
logger=migrator t=2026-07-08T05:41:19.175040127Z level=info msg="Executing migration" id="create file_meta table"
logger=migrator t=2026-07-08T05:41:19.175245319Z level=info msg="Migration successfully executed" id="create file_meta table" duration=205.512µs
logger=migrator t=2026-07-08T05:41:19.177940489Z level=info msg="Executing migration" id="file table idx: path key"
logger=migrator t=2026-07-08T05:41:19.178159102Z level=info msg="Migration successfully executed" id="file table idx: path key" duration=213.886µs
logger=migrator t=2026-07-08T05:41:19.180684873Z level=info msg="Executing migration" id="set path collation in file table"
logger=migrator t=2026-07-08T05:41:19.180711127Z level=info msg="Migration successfully executed" id="set path collation in file table" duration=26.497µs
logger=migrator t=2026-07-08T05:41:19.183410757Z level=info msg="Executing migration" id="migrate contents column to mediumblob for MySQL"
logger=migrator t=2026-07-08T05:41:19.18343876Z level=info msg="Migration successfully executed" id="migrate contents column to mediumblob for MySQL" duration=27.867µs
logger=migrator t=2026-07-08T05:41:19.185542085Z level=info msg="Executing migration" id="managed permissions migration"
logger=migrator t=2026-07-08T05:41:19.185666175Z level=info msg="Migration successfully executed" id="managed permissions migration" duration=124.177µs
logger=migrator t=2026-07-08T05:41:19.187885807Z level=info msg="Executing migration" id="managed folder permissions alert actions migration"
logger=migrator t=2026-07-08T05:41:19.187936503Z level=info msg="Migration successfully executed" id="managed folder permissions alert actions migration" duration=51.073µs
logger=migrator t=2026-07-08T05:41:19.19006174Z level=info msg="Executing migration" id="RBAC action name migrator"
logger=migrator t=2026-07-08T05:41:19.190279372Z level=info msg="Migration successfully executed" id="RBAC action name migrator" duration=224.539µs
logger=migrator t=2026-07-08T05:41:19.193379673Z level=info msg="Executing migration" id="Add UID column to playlist"
logger=migrator t=2026-07-08T05:41:19.194801312Z level=info msg="Migration successfully executed" id="Add UID column to playlist" duration=1.420503ms
logger=migrator t=2026-07-08T05:41:19.198216551Z level=info msg="Executing migration" id="Update uid column values in playlist"
logger=migrator t=2026-07-08T05:41:19.198276402Z level=info msg="Migration successfully executed" id="Update uid column values in playlist" duration=60.155µs
logger=migrator t=2026-07-08T05:41:19.200647301Z level=info msg="Executing migration" id="Add index for uid in playlist"
logger=migrator t=2026-07-08T05:41:19.200907131Z level=info msg="Migration successfully executed" id="Add index for uid in playlist" duration=260.129µs
logger=migrator t=2026-07-08T05:41:19.302699756Z level=info msg="Executing migration" id="update group index for alert rules"
logger=migrator t=2026-07-08T05:41:19.303068814Z level=info msg="Migration successfully executed" id="update group index for alert rules" duration=372.18µs
logger=migrator t=2026-07-08T05:41:19.310050302Z level=info msg="Executing migration" id="managed folder permissions alert actions repeated migration"
logger=migrator t=2026-07-08T05:41:19.310186169Z level=info msg="Migration successfully executed" id="managed folder permissions alert actions repeated migration" duration=138.079µs
logger=migrator t=2026-07-08T05:41:19.312820228Z level=info msg="Executing migration" id="admin only folder/dashboard permission"
logger=migrator t=2026-07-08T05:41:19.31303942Z level=info msg="Migration successfully executed" id="admin only folder/dashboard permission" duration=231.931µs
logger=migrator t=2026-07-08T05:41:19.316113245Z level=info msg="Executing migration" id="add action column to seed_assignment"
logger=migrator t=2026-07-08T05:41:19.317052112Z level=info msg="Migration successfully executed" id="add action column to seed_assignment" duration=938.704µs
logger=migrator t=2026-07-08T05:41:19.319619794Z level=info msg="Executing migration" id="add scope column to seed_assignment"
logger=migrator t=2026-07-08T05:41:19.321014007Z level=info msg="Migration successfully executed" id="add scope column to seed_assignment" duration=1.394374ms
logger=migrator t=2026-07-08T05:41:19.323531449Z level=info msg="Executing migration" id="remove unique index builtin_role_role_name before nullable update"
logger=migrator t=2026-07-08T05:41:19.323816379Z level=info msg="Migration successfully executed" id="remove unique index builtin_role_role_name before nullable update" duration=285.68µs
logger=migrator t=2026-07-08T05:41:19.326536315Z level=info msg="Executing migration" id="update seed_assignment role_name column to nullable"
logger=migrator t=2026-07-08T05:41:19.33342383Z level=info msg="Migration successfully executed" id="update seed_assignment role_name column to nullable" duration=6.886099ms
logger=migrator t=2026-07-08T05:41:19.336383656Z level=info msg="Executing migration" id="add unique index builtin_role_name back"
logger=migrator t=2026-07-08T05:41:19.336663054Z level=info msg="Migration successfully executed" id="add unique index builtin_role_name back" duration=289.684µs
logger=migrator t=2026-07-08T05:41:19.339400293Z level=info msg="Executing migration" id="add unique index builtin_role_action_scope"
logger=migrator t=2026-07-08T05:41:19.339629914Z level=info msg="Migration successfully executed" id="add unique index builtin_role_action_scope" duration=229.552µs
logger=migrator t=2026-07-08T05:41:19.342241014Z level=info msg="Executing migration" id="add primary key to seed_assigment"
logger=migrator t=2026-07-08T05:41:19.34457576Z level=info msg="Migration successfully executed" id="add primary key to seed_assigment" duration=2.334685ms
logger=migrator t=2026-07-08T05:41:19.34863119Z level=info msg="Executing migration" id="add origin column to seed_assignment"
logger=migrator t=2026-07-08T05:41:19.34990293Z level=info msg="Migration successfully executed" id="add origin column to seed_assignment" duration=1.272958ms
logger=migrator t=2026-07-08T05:41:19.352621146Z level=info msg="Executing migration" id="add origin to plugin seed_assignment"
logger=migrator t=2026-07-08T05:41:19.352684154Z level=info msg="Migration successfully executed" id="add origin to plugin seed_assignment" duration=63.33µs
logger=migrator t=2026-07-08T05:41:19.354982017Z level=info msg="Executing migration" id="prevent seeding OnCall access"
logger=migrator t=2026-07-08T05:41:19.355038579Z level=info msg="Migration successfully executed" id="prevent seeding OnCall access" duration=56.717µs
logger=migrator t=2026-07-08T05:41:19.357184562Z level=info msg="Executing migration" id="managed folder permissions alert actions repeated fixed migration"
logger=migrator t=2026-07-08T05:41:19.357241332Z level=info msg="Migration successfully executed" id="managed folder permissions alert actions repeated fixed migration" duration=61.998µs
logger=migrator t=2026-07-08T05:41:19.359553238Z level=info msg="Executing migration" id="managed folder permissions library panel actions migration"
logger=migrator t=2026-07-08T05:41:19.359600979Z level=info msg="Migration successfully executed" id="managed folder permissions library panel actions migration" duration=54.306µs
logger=migrator t=2026-07-08T05:41:19.361720897Z level=info msg="Executing migration" id="migrate external alertmanagers to datsourcse"
logger=migrator t=2026-07-08T05:41:19.361792095Z level=info msg="Migration successfully executed" id="migrate external alertmanagers to datsourcse" duration=71.401µs
logger=migrator t=2026-07-08T05:41:19.363997819Z level=info msg="Executing migration" id="create folder table"
logger=migrator t=2026-07-08T05:41:19.364215116Z level=info msg="Migration successfully executed" id="create folder table" duration=212.543µs
logger=migrator t=2026-07-08T05:41:19.366293392Z level=info msg="Executing migration" id="Add index for parent_uid"
logger=migrator t=2026-07-08T05:41:19.366516108Z level=info msg="Migration successfully executed" id="Add index for parent_uid" duration=222.866µs
logger=migrator t=2026-07-08T05:41:19.370067115Z level=info msg="Executing migration" id="Add unique index for folder.uid and folder.org_id"
logger=migrator t=2026-07-08T05:41:19.370326063Z level=info msg="Migration successfully executed" id="Add unique index for folder.uid and folder.org_id" duration=263.021µs
logger=migrator t=2026-07-08T05:41:19.373863229Z level=info msg="Executing migration" id="Update folder title length"
logger=migrator t=2026-07-08T05:41:19.373885755Z level=info msg="Migration successfully executed" id="Update folder title length" duration=23.429µs
logger=migrator t=2026-07-08T05:41:19.376270756Z level=info msg="Executing migration" id="Add unique index for folder.title and folder.parent_uid"
logger=migrator t=2026-07-08T05:41:19.376503695Z level=info msg="Migration successfully executed" id="Add unique index for folder.title and folder.parent_uid" duration=233.174µs
logger=migrator t=2026-07-08T05:41:19.379135667Z level=info msg="Executing migration" id="Remove unique index for folder.title and folder.parent_uid"
logger=migrator t=2026-07-08T05:41:19.379390603Z level=info msg="Migration successfully executed" id="Remove unique index for folder.title and folder.parent_uid" duration=255.281µs
logger=migrator t=2026-07-08T05:41:19.382084048Z level=info msg="Executing migration" id="Add unique index for title, parent_uid, and org_id"
logger=migrator t=2026-07-08T05:41:19.382316138Z level=info msg="Migration successfully executed" id="Add unique index for title, parent_uid, and org_id" duration=232.066µs
logger=migrator t=2026-07-08T05:41:19.385435463Z level=info msg="Executing migration" id="Sync dashboard and folder table"
logger=migrator t=2026-07-08T05:41:19.385556046Z level=info msg="Migration successfully executed" id="Sync dashboard and folder table" duration=120.77µs
logger=migrator t=2026-07-08T05:41:19.387766652Z level=info msg="Executing migration" id="Remove ghost folders from the folder table"
logger=migrator t=2026-07-08T05:41:19.387833734Z level=info msg="Migration successfully executed" id="Remove ghost folders from the folder table" duration=67.075µs
logger=migrator t=2026-07-08T05:41:19.390057515Z level=info msg="Executing migration" id="Remove unique index UQE_folder_uid_org_id"
logger=migrator t=2026-07-08T05:41:19.390260063Z level=info msg="Migration successfully executed" id="Remove unique index UQE_folder_uid_org_id" duration=202.96µs
logger=migrator t=2026-07-08T05:41:19.3930134Z level=info msg="Executing migration" id="Add unique index UQE_folder_org_id_uid"
logger=migrator t=2026-07-08T05:41:19.393222498Z level=info msg="Migration successfully executed" id="Add unique index UQE_folder_org_id_uid" duration=208.961µs
logger=migrator t=2026-07-08T05:41:19.396778587Z level=info msg="Executing migration" id="Remove unique index UQE_folder_title_parent_uid_org_id"
logger=migrator t=2026-07-08T05:41:19.397000287Z level=info msg="Migration successfully executed" id="Remove unique index UQE_folder_title_parent_uid_org_id" duration=217.557µs
logger=migrator t=2026-07-08T05:41:19.399564904Z level=info msg="Executing migration" id="Add unique index UQE_folder_org_id_parent_uid_title"
logger=migrator t=2026-07-08T05:41:19.39977258Z level=info msg="Migration successfully executed" id="Add unique index UQE_folder_org_id_parent_uid_title" duration=207.599µs
logger=migrator t=2026-07-08T05:41:19.40557232Z level=info msg="Executing migration" id="Remove index IDX_folder_parent_uid_org_id"
logger=migrator t=2026-07-08T05:41:19.405936193Z level=info msg="Migration successfully executed" id="Remove index IDX_folder_parent_uid_org_id" duration=365.735µs
logger=migrator t=2026-07-08T05:41:19.525178014Z level=info msg="Executing migration" id="Remove unique index UQE_folder_org_id_parent_uid_title"
logger=migrator t=2026-07-08T05:41:19.525522428Z level=info msg="Migration successfully executed" id="Remove unique index UQE_folder_org_id_parent_uid_title" duration=345.893µs
logger=migrator t=2026-07-08T05:41:19.529439457Z level=info msg="Executing migration" id="create anon_device table"
logger=migrator t=2026-07-08T05:41:19.529738929Z level=info msg="Migration successfully executed" id="create anon_device table" duration=300.507µs
logger=migrator t=2026-07-08T05:41:19.532768345Z level=info msg="Executing migration" id="add unique index anon_device.device_id"
logger=migrator t=2026-07-08T05:41:19.533062254Z level=info msg="Migration successfully executed" id="add unique index anon_device.device_id" duration=294.394µs
logger=migrator t=2026-07-08T05:41:19.535860193Z level=info msg="Executing migration" id="add index anon_device.updated_at"
logger=migrator t=2026-07-08T05:41:19.536113455Z level=info msg="Migration successfully executed" id="add index anon_device.updated_at" duration=253.451µs
logger=migrator t=2026-07-08T05:41:19.539245341Z level=info msg="Executing migration" id="create signing_key table"
logger=migrator t=2026-07-08T05:41:19.539499387Z level=info msg="Migration successfully executed" id="create signing_key table" duration=254.928µs
logger=migrator t=2026-07-08T05:41:19.542317785Z level=info msg="Executing migration" id="add unique index signing_key.key_id"
logger=migrator t=2026-07-08T05:41:19.542547409Z level=info msg="Migration successfully executed" id="add unique index signing_key.key_id" duration=229.784µs
logger=migrator t=2026-07-08T05:41:19.544968821Z level=info msg="Executing migration" id="set legacy alert migration status in kvstore"
logger=migrator t=2026-07-08T05:41:19.545293915Z level=info msg="Migration successfully executed" id="set legacy alert migration status in kvstore" duration=325.04µs
logger=migrator t=2026-07-08T05:41:19.547549991Z level=info msg="Executing migration" id="migrate record of created folders during legacy migration to kvstore"
logger=migrator t=2026-07-08T05:41:19.54763868Z level=info msg="Migration successfully executed" id="migrate record of created folders during legacy migration to kvstore" duration=89.047µs
logger=migrator t=2026-07-08T05:41:19.54997277Z level=info msg="Executing migration" id="Add folder_uid for dashboard"
logger=migrator t=2026-07-08T05:41:19.550883963Z level=info msg="Migration successfully executed" id="Add folder_uid for dashboard" duration=911.054µs
logger=migrator t=2026-07-08T05:41:19.55334454Z level=info msg="Executing migration" id="Populate dashboard folder_uid column"
logger=migrator t=2026-07-08T05:41:19.553526755Z level=info msg="Migration successfully executed" id="Populate dashboard folder_uid column" duration=183.009µs
logger=migrator t=2026-07-08T05:41:19.55591905Z level=info msg="Executing migration" id="Add unique index for dashboard_org_id_folder_uid_title"
logger=migrator t=2026-07-08T05:41:19.555933302Z level=info msg="Migration successfully executed" id="Add unique index for dashboard_org_id_folder_uid_title" duration=14.891µs
logger=migrator t=2026-07-08T05:41:19.559179132Z level=info msg="Executing migration" id="Delete unique index for dashboard_org_id_folder_id_title"
logger=migrator t=2026-07-08T05:41:19.559387012Z level=info msg="Migration successfully executed" id="Delete unique index for dashboard_org_id_folder_id_title" duration=208.286µs
logger=migrator t=2026-07-08T05:41:19.56219622Z level=info msg="Executing migration" id="Delete unique index for dashboard_org_id_folder_uid_title"
logger=migrator t=2026-07-08T05:41:19.562209121Z level=info msg="Migration successfully executed" id="Delete unique index for dashboard_org_id_folder_uid_title" duration=19.14µs
logger=migrator t=2026-07-08T05:41:19.56453386Z level=info msg="Executing migration" id="Add unique index for dashboard_org_id_folder_uid_title_is_folder"
logger=migrator t=2026-07-08T05:41:19.564764657Z level=info msg="Migration successfully executed" id="Add unique index for dashboard_org_id_folder_uid_title_is_folder" duration=239.165µs
logger=migrator t=2026-07-08T05:41:19.567149413Z level=info msg="Executing migration" id="Restore index for dashboard_org_id_folder_id_title"
logger=migrator t=2026-07-08T05:41:19.567345569Z level=info msg="Migration successfully executed" id="Restore index for dashboard_org_id_folder_id_title" duration=196.331µs
logger=migrator t=2026-07-08T05:41:19.56956164Z level=info msg="Executing migration" id="Remove unique index for dashboard_org_id_folder_uid_title_is_folder"
logger=migrator t=2026-07-08T05:41:19.569763665Z level=info msg="Migration successfully executed" id="Remove unique index for dashboard_org_id_folder_uid_title_is_folder" duration=202.137µs
logger=migrator t=2026-07-08T05:41:19.572301139Z level=info msg="Executing migration" id="create sso_setting table"
logger=migrator t=2026-07-08T05:41:19.572495265Z level=info msg="Migration successfully executed" id="create sso_setting table" duration=194.132µs
logger=migrator t=2026-07-08T05:41:19.575208287Z level=info msg="Executing migration" id="copy kvstore migration status to each org"
logger=migrator t=2026-07-08T05:41:19.575455235Z level=info msg="Migration successfully executed" id="copy kvstore migration status to each org" duration=247.233µs
logger=migrator t=2026-07-08T05:41:19.577718293Z level=info msg="Executing migration" id="add back entry for orgid=0 migrated status"
logger=migrator t=2026-07-08T05:41:19.577804877Z level=info msg="Migration successfully executed" id="add back entry for orgid=0 migrated status" duration=81.726µs
logger=migrator t=2026-07-08T05:41:19.580259357Z level=info msg="Executing migration" id="managed dashboard permissions annotation actions migration"
logger=migrator t=2026-07-08T05:41:19.580362119Z level=info msg="Migration successfully executed" id="managed dashboard permissions annotation actions migration" duration=102.946µs
logger=migrator t=2026-07-08T05:41:19.582687153Z level=info msg="Executing migration" id="create cloud_migration table v1"
logger=migrator t=2026-07-08T05:41:19.582900595Z level=info msg="Migration successfully executed" id="create cloud_migration table v1" duration=207.257µs
logger=migrator t=2026-07-08T05:41:19.585665802Z level=info msg="Executing migration" id="create cloud_migration_run table v1"
logger=migrator t=2026-07-08T05:41:19.585875971Z level=info msg="Migration successfully executed" id="create cloud_migration_run table v1" duration=210.385µs
logger=migrator t=2026-07-08T05:41:19.591579199Z level=info msg="Executing migration" id="add stack_id column"
logger=migrator t=2026-07-08T05:41:19.592525806Z level=info msg="Migration successfully executed" id="add stack_id column" duration=939.343µs
logger=migrator t=2026-07-08T05:41:19.595778861Z level=info msg="Executing migration" id="add region_slug column"
logger=migrator t=2026-07-08T05:41:19.596716595Z level=info msg="Migration successfully executed" id="add region_slug column" duration=937.52µs
logger=migrator t=2026-07-08T05:41:19.599703128Z level=info msg="Executing migration" id="add cluster_slug column"
logger=migrator t=2026-07-08T05:41:19.600617604Z level=info msg="Migration successfully executed" id="add cluster_slug column" duration=914.333µs
logger=migrator t=2026-07-08T05:41:19.60453915Z level=info msg="Executing migration" id="add migration uid column"
logger=migrator t=2026-07-08T05:41:19.605588093Z level=info msg="Migration successfully executed" id="add migration uid column" duration=1.049231ms
logger=migrator t=2026-07-08T05:41:19.610354822Z level=info msg="Executing migration" id="Update uid column values for migration"
logger=migrator t=2026-07-08T05:41:19.610414857Z level=info msg="Migration successfully executed" id="Update uid column values for migration" duration=61.492µs
logger=migrator t=2026-07-08T05:41:19.614463497Z level=info msg="Executing migration" id="Add unique index migration_uid"
logger=migrator t=2026-07-08T05:41:19.614839394Z level=info msg="Migration successfully executed" id="Add unique index migration_uid" duration=376.366µs
logger=migrator t=2026-07-08T05:41:19.6183016Z level=info msg="Executing migration" id="add migration run uid column"
logger=migrator t=2026-07-08T05:41:19.619627722Z level=info msg="Migration successfully executed" id="add migration run uid column" duration=1.326263ms
logger=migrator t=2026-07-08T05:41:19.623035734Z level=info msg="Executing migration" id="Update uid column values for migration run"
logger=migrator t=2026-07-08T05:41:19.623087511Z level=info msg="Migration successfully executed" id="Update uid column values for migration run" duration=52.346µs
logger=migrator t=2026-07-08T05:41:19.625284516Z level=info msg="Executing migration" id="Add unique index migration_run_uid"
logger=migrator t=2026-07-08T05:41:19.625503412Z level=info msg="Migration successfully executed" id="Add unique index migration_run_uid" duration=218.942µs
logger=migrator t=2026-07-08T05:41:19.635272846Z level=info msg="Executing migration" id="Rename table cloud_migration to cloud_migration_session_tmp_qwerty - v1"
logger=migrator t=2026-07-08T05:41:19.637560694Z level=info msg="Migration successfully executed" id="Rename table cloud_migration to cloud_migration_session_tmp_qwerty - v1" duration=2.288091ms
logger=migrator t=2026-07-08T05:41:19.640280668Z level=info msg="Executing migration" id="create cloud_migration_session v2"
logger=migrator t=2026-07-08T05:41:19.640519476Z level=info msg="Migration successfully executed" id="create cloud_migration_session v2" duration=239.041µs
logger=migrator t=2026-07-08T05:41:19.643083954Z level=info msg="Executing migration" id="create index UQE_cloud_migration_session_uid - v2"
logger=migrator t=2026-07-08T05:41:19.643350109Z level=info msg="Migration successfully executed" id="create index UQE_cloud_migration_session_uid - v2" duration=266.248µs
logger=migrator t=2026-07-08T05:41:19.646802821Z level=info msg="Executing migration" id="copy cloud_migration_session v1 to v2"
logger=migrator t=2026-07-08T05:41:19.646927336Z level=info msg="Migration successfully executed" id="copy cloud_migration_session v1 to v2" duration=128.024µs
logger=migrator t=2026-07-08T05:41:19.649824101Z level=info msg="Executing migration" id="drop cloud_migration_session_tmp_qwerty"
logger=migrator t=2026-07-08T05:41:19.650006339Z level=info msg="Migration successfully executed" id="drop cloud_migration_session_tmp_qwerty" duration=188.354µs
logger=migrator t=2026-07-08T05:41:19.653441052Z level=info msg="Executing migration" id="Rename table cloud_migration_run to cloud_migration_snapshot_tmp_qwerty - v1"
logger=migrator t=2026-07-08T05:41:19.655653016Z level=info msg="Migration successfully executed" id="Rename table cloud_migration_run to cloud_migration_snapshot_tmp_qwerty - v1" duration=2.204379ms
logger=migrator t=2026-07-08T05:41:19.659020934Z level=info msg="Executing migration" id="create cloud_migration_snapshot v2"
logger=migrator t=2026-07-08T05:41:19.659221336Z level=info msg="Migration successfully executed" id="create cloud_migration_snapshot v2" duration=200.563µs
logger=migrator t=2026-07-08T05:41:19.662492161Z level=info msg="Executing migration" id="create index UQE_cloud_migration_snapshot_uid - v2"
logger=migrator t=2026-07-08T05:41:19.662752184Z level=info msg="Migration successfully executed" id="create index UQE_cloud_migration_snapshot_uid - v2" duration=260.18µs
logger=migrator t=2026-07-08T05:41:19.665910685Z level=info msg="Executing migration" id="copy cloud_migration_snapshot v1 to v2"
logger=migrator t=2026-07-08T05:41:19.666033513Z level=info msg="Migration successfully executed" id="copy cloud_migration_snapshot v1 to v2" duration=123.104µs
logger=migrator t=2026-07-08T05:41:19.669174484Z level=info msg="Executing migration" id="drop cloud_migration_snapshot_tmp_qwerty"
logger=migrator t=2026-07-08T05:41:19.669350491Z level=info msg="Migration successfully executed" id="drop cloud_migration_snapshot_tmp_qwerty" duration=174.763µs
logger=migrator t=2026-07-08T05:41:19.673066099Z level=info msg="Executing migration" id="add snapshot upload_url column"
logger=migrator t=2026-07-08T05:41:19.674246042Z level=info msg="Migration successfully executed" id="add snapshot upload_url column" duration=1.17939ms
logger=migrator t=2026-07-08T05:41:19.676824515Z level=info msg="Executing migration" id="add snapshot status column"
logger=migrator t=2026-07-08T05:41:19.677708405Z level=info msg="Migration successfully executed" id="add snapshot status column" duration=884.07µs
logger=migrator t=2026-07-08T05:41:19.680900217Z level=info msg="Executing migration" id="add snapshot local_directory column"
logger=migrator t=2026-07-08T05:41:19.681766752Z level=info msg="Migration successfully executed" id="add snapshot local_directory column" duration=866.553µs
logger=migrator t=2026-07-08T05:41:19.690000092Z level=info msg="Executing migration" id="add snapshot gms_snapshot_uid column"
logger=migrator t=2026-07-08T05:41:19.690886695Z level=info msg="Migration successfully executed" id="add snapshot gms_snapshot_uid column" duration=886.41µs
logger=migrator t=2026-07-08T05:41:19.693726725Z level=info msg="Executing migration" id="add snapshot encryption_key column"
logger=migrator t=2026-07-08T05:41:19.694579418Z level=info msg="Migration successfully executed" id="add snapshot encryption_key column" duration=851.734µs
logger=migrator t=2026-07-08T05:41:19.69800084Z level=info msg="Executing migration" id="add snapshot error_string column"
logger=migrator t=2026-07-08T05:41:19.699222811Z level=info msg="Migration successfully executed" id="add snapshot error_string column" duration=1.220778ms
logger=migrator t=2026-07-08T05:41:19.703846626Z level=info msg="Executing migration" id="create cloud_migration_resource table v1"
logger=migrator t=2026-07-08T05:41:19.70411242Z level=info msg="Migration successfully executed" id="create cloud_migration_resource table v1" duration=266.578µs
logger=migrator t=2026-07-08T05:41:19.71209186Z level=info msg="Executing migration" id="delete cloud_migration_snapshot.result column"
logger=migrator t=2026-07-08T05:41:19.715366573Z level=info msg="Migration successfully executed" id="delete cloud_migration_snapshot.result column" duration=3.275161ms
logger=migrator t=2026-07-08T05:41:19.721267175Z level=info msg="Executing migration" id="add cloud_migration_resource.name column"
logger=migrator t=2026-07-08T05:41:19.72218079Z level=info msg="Migration successfully executed" id="add cloud_migration_resource.name column" duration=913.407µs
logger=migrator t=2026-07-08T05:41:19.725742888Z level=info msg="Executing migration" id="add cloud_migration_resource.parent_name column"
logger=migrator t=2026-07-08T05:41:19.727186056Z level=info msg="Migration successfully executed" id="add cloud_migration_resource.parent_name column" duration=1.441967ms
logger=migrator t=2026-07-08T05:41:19.730596251Z level=info msg="Executing migration" id="add cloud_migration_session.org_id column"
logger=migrator t=2026-07-08T05:41:19.731429478Z level=info msg="Migration successfully executed" id="add cloud_migration_session.org_id column" duration=832.772µs
logger=migrator t=2026-07-08T05:41:19.742246515Z level=info msg="Executing migration" id="add cloud_migration_resource.error_code column"
logger=migrator t=2026-07-08T05:41:19.743226796Z level=info msg="Migration successfully executed" id="add cloud_migration_resource.error_code column" duration=980.35µs
logger=migrator t=2026-07-08T05:41:19.749519364Z level=info msg="Executing migration" id="increase resource_uid column length"
logger=migrator t=2026-07-08T05:41:19.749565123Z level=info msg="Migration successfully executed" id="increase resource_uid column length" duration=46.898µs
logger=migrator t=2026-07-08T05:41:19.756656826Z level=info msg="Executing migration" id="alter kv_store.value to longtext"
logger=migrator t=2026-07-08T05:41:19.756701247Z level=info msg="Migration successfully executed" id="alter kv_store.value to longtext" duration=45.243µs
logger=migrator t=2026-07-08T05:41:19.76709989Z level=info msg="Executing migration" id="add notification_settings column to alert_rule table"
logger=migrator t=2026-07-08T05:41:19.768151097Z level=info msg="Migration successfully executed" id="add notification_settings column to alert_rule table" duration=1.051721ms
logger=migrator t=2026-07-08T05:41:19.771319557Z level=info msg="Executing migration" id="add notification_settings column to alert_rule_version table"
logger=migrator t=2026-07-08T05:41:19.772295961Z level=info msg="Migration successfully executed" id="add notification_settings column to alert_rule_version table" duration=986.863µs
logger=migrator t=2026-07-08T05:41:19.775269393Z level=info msg="Executing migration" id="removing scope from alert.instances:read action migration"
logger=migrator t=2026-07-08T05:41:19.775353403Z level=info msg="Migration successfully executed" id="removing scope from alert.instances:read action migration" duration=90.722µs
logger=migrator t=2026-07-08T05:41:19.778148968Z level=info msg="Executing migration" id="managed folder permissions alerting silences actions migration"
logger=migrator t=2026-07-08T05:41:19.778218147Z level=info msg="Migration successfully executed" id="managed folder permissions alerting silences actions migration" duration=69.177µs
logger=migrator t=2026-07-08T05:41:19.780982522Z level=info msg="Executing migration" id="add record column to alert_rule table"
logger=migrator t=2026-07-08T05:41:19.781842785Z level=info msg="Migration successfully executed" id="add record column to alert_rule table" duration=859.973µs
logger=migrator t=2026-07-08T05:41:19.785226883Z level=info msg="Executing migration" id="add record column to alert_rule_version table"
logger=migrator t=2026-07-08T05:41:19.786060609Z level=info msg="Migration successfully executed" id="add record column to alert_rule_version table" duration=833.766µs
logger=migrator t=2026-07-08T05:41:19.788871056Z level=info msg="Executing migration" id="add resolved_at column to alert_instance table"
logger=migrator t=2026-07-08T05:41:19.789988735Z level=info msg="Migration successfully executed" id="add resolved_at column to alert_instance table" duration=1.107236ms
logger=migrator t=2026-07-08T05:41:19.792732643Z level=info msg="Executing migration" id="add last_sent_at column to alert_instance table"
logger=migrator t=2026-07-08T05:41:19.793515333Z level=info msg="Migration successfully executed" id="add last_sent_at column to alert_instance table" duration=783.103µs
logger=migrator t=2026-07-08T05:41:19.795508359Z level=info msg="Executing migration" id="Enable traceQL streaming for all Tempo datasources"
logger=migrator t=2026-07-08T05:41:19.79552916Z level=info msg="Migration successfully executed" id="Enable traceQL streaming for all Tempo datasources" duration=16.661µs
logger=migrator t=2026-07-08T05:41:19.797637884Z level=info msg="Executing migration" id="Add scope to alert.notifications.receivers:read and alert.notifications.receivers.secrets:read"
logger=migrator t=2026-07-08T05:41:19.797723854Z level=info msg="Migration successfully executed" id="Add scope to alert.notifications.receivers:read and alert.notifications.receivers.secrets:read" duration=86.117µs
logger=migrator t=2026-07-08T05:41:19.799975243Z level=info msg="Executing migration" id="add metadata column to alert_rule table"
logger=migrator t=2026-07-08T05:41:19.800857716Z level=info msg="Migration successfully executed" id="add metadata column to alert_rule table" duration=859.932µs
logger=migrator t=2026-07-08T05:41:19.805325315Z level=info msg="Executing migration" id="add metadata column to alert_rule_version table"
logger=migrator t=2026-07-08T05:41:19.806270297Z level=info msg="Migration successfully executed" id="add metadata column to alert_rule_version table" duration=946.052µs
logger=migrator t=2026-07-08T05:41:19.809520521Z level=info msg="Executing migration" id="delete orphaned service account permissions"
logger=migrator t=2026-07-08T05:41:19.809590966Z level=info msg="Migration successfully executed" id="delete orphaned service account permissions" duration=70.963µs
logger=migrator t=2026-07-08T05:41:19.812588405Z level=info msg="Executing migration" id="adding action set permissions"
logger=migrator t=2026-07-08T05:41:19.812686585Z level=info msg="Migration successfully executed" id="adding action set permissions" duration=98.714µs
logger=migrator t=2026-07-08T05:41:19.814878383Z level=info msg="Executing migration" id="create user_external_session table"
logger=migrator t=2026-07-08T05:41:19.815081321Z level=info msg="Migration successfully executed" id="create user_external_session table" duration=203.039µs
logger=migrator t=2026-07-08T05:41:19.817804414Z level=info msg="Executing migration" id="increase name_id column length to 1024"
logger=migrator t=2026-07-08T05:41:19.817848288Z level=info msg="Migration successfully executed" id="increase name_id column length to 1024" duration=37.727µs
logger=migrator t=2026-07-08T05:41:19.820272047Z level=info msg="Executing migration" id="increase session_id column length to 1024"
logger=migrator t=2026-07-08T05:41:19.820293127Z level=info msg="Migration successfully executed" id="increase session_id column length to 1024" duration=21.456µs
logger=migrator t=2026-07-08T05:41:19.826117818Z level=info msg="Executing migration" id="remove scope from alert.notifications.receivers:create"
logger=migrator t=2026-07-08T05:41:19.82620274Z level=info msg="Migration successfully executed" id="remove scope from alert.notifications.receivers:create" duration=84.882µs
logger=migrator t=2026-07-08T05:41:19.828991617Z level=info msg="migrations completed" performed=626 skipped=0 duration=2.486449102s
logger=migrator t=2026-07-08T05:41:19.829181603Z level=info msg="Unlocking database"
logger=resource-migrator t=2026-07-08T05:41:20.009964542Z level=info msg="Locking database"
logger=resource-migrator t=2026-07-08T05:41:20.009988262Z level=info msg="Starting DB migrations"
logger=resource-migrator t=2026-07-08T05:41:20.010125029Z level=info msg="Executing migration" id="create resource_migration_log table"
logger=resource-migrator t=2026-07-08T05:41:20.010365058Z level=info msg="Migration successfully executed" id="create resource_migration_log table" duration=239.695µs
logger=resource-migrator t=2026-07-08T05:41:20.047483381Z level=info msg="Executing migration" id="Initialize resource tables"
logger=resource-migrator t=2026-07-08T05:41:20.047538498Z level=info msg="Migration successfully executed" id="Initialize resource tables" duration=58.6µs
logger=resource-migrator t=2026-07-08T05:41:20.062776485Z level=info msg="Executing migration" id="drop table resource"
logger=resource-migrator t=2026-07-08T05:41:20.062864672Z level=info msg="Migration successfully executed" id="drop table resource" duration=91.396µs
logger=resource-migrator t=2026-07-08T05:41:20.075190118Z level=info msg="Executing migration" id="create table resource"
logger=resource-migrator t=2026-07-08T05:41:20.075500142Z level=info msg="Migration successfully executed" id="create table resource" duration=312.311µs
logger=resource-migrator t=2026-07-08T05:41:20.088692728Z level=info msg="Executing migration" id="create table resource, index: 0"
logger=resource-migrator t=2026-07-08T05:41:20.089027399Z level=info msg="Migration successfully executed" id="create table resource, index: 0" duration=335.522µs
logger=resource-migrator t=2026-07-08T05:41:20.105418716Z level=info msg="Executing migration" id="drop table resource_history"
logger=resource-migrator t=2026-07-08T05:41:20.10559281Z level=info msg="Migration successfully executed" id="drop table resource_history" duration=174.287µs
logger=resource-migrator t=2026-07-08T05:41:20.115624201Z level=info msg="Executing migration" id="create table resource_history"
logger=resource-migrator t=2026-07-08T05:41:20.11593767Z level=info msg="Migration successfully executed" id="create table resource_history" duration=312.64µs
logger=resource-migrator t=2026-07-08T05:41:20.11976636Z level=info msg="Executing migration" id="create table resource_history, index: 0"
logger=resource-migrator t=2026-07-08T05:41:20.120063726Z level=info msg="Migration successfully executed" id="create table resource_history, index: 0" duration=297.632µs
logger=resource-migrator t=2026-07-08T05:41:20.123266241Z level=info msg="Executing migration" id="create table resource_history, index: 1"
logger=resource-migrator t=2026-07-08T05:41:20.123491278Z level=info msg="Migration successfully executed" id="create table resource_history, index: 1" duration=226.611µs
logger=resource-migrator t=2026-07-08T05:41:20.12651151Z level=info msg="Executing migration" id="drop table resource_version"
logger=resource-migrator t=2026-07-08T05:41:20.126547262Z level=info msg="Migration successfully executed" id="drop table resource_version" duration=36.124µs
logger=resource-migrator t=2026-07-08T05:41:20.129644443Z level=info msg="Executing migration" id="create table resource_version"
logger=resource-migrator t=2026-07-08T05:41:20.129890639Z level=info msg="Migration successfully executed" id="create table resource_version" duration=246.204µs
logger=resource-migrator t=2026-07-08T05:41:20.13568047Z level=info msg="Executing migration" id="create table resource_version, index: 0"
logger=resource-migrator t=2026-07-08T05:41:20.135959848Z level=info msg="Migration successfully executed" id="create table resource_version, index: 0" duration=278.468µs
logger=resource-migrator t=2026-07-08T05:41:20.140875814Z level=info msg="Executing migration" id="Add column previous_resource_version in resource_history"
logger=resource-migrator t=2026-07-08T05:41:20.141994394Z level=info msg="Migration successfully executed" id="Add column previous_resource_version in resource_history" duration=1.11641ms
logger=resource-migrator t=2026-07-08T05:41:20.225601546Z level=info msg="Executing migration" id="Add column previous_resource_version in resource"
logger=resource-migrator t=2026-07-08T05:41:20.227193433Z level=info msg="Migration successfully executed" id="Add column previous_resource_version in resource" duration=1.592958ms
logger=resource-migrator t=2026-07-08T05:41:20.239364677Z level=info msg="Executing migration" id="Add index to resource_history for polling"
logger=resource-migrator t=2026-07-08T05:41:20.239723094Z level=info msg="Migration successfully executed" id="Add index to resource_history for polling" duration=359.427µs
logger=resource-migrator t=2026-07-08T05:41:20.255863068Z level=info msg="Executing migration" id="Add index to resource for loading"
logger=resource-migrator t=2026-07-08T05:41:20.256205516Z level=info msg="Migration successfully executed" id="Add index to resource for loading" duration=347.432µs
logger=resource-migrator t=2026-07-08T05:41:20.265198387Z level=info msg="Executing migration" id="Add column folder in resource_history"
logger=resource-migrator t=2026-07-08T05:41:20.26618135Z level=info msg="Migration successfully executed" id="Add column folder in resource_history" duration=982.862µs
logger=resource-migrator t=2026-07-08T05:41:20.276754292Z level=info msg="Executing migration" id="Add column folder in resource"
logger=resource-migrator t=2026-07-08T05:41:20.278153283Z level=info msg="Migration successfully executed" id="Add column folder in resource" duration=1.401452ms
logger=resource-migrator t=2026-07-08T05:41:20.283472354Z level=info msg="migrations completed" performed=18 skipped=0 duration=273.375263ms
logger=resource-migrator t=2026-07-08T05:41:20.283645434Z level=info msg="Unlocking database"
```

**(b) Same database, second start — schema already up to date (`performed=0`):**

```
$ grep "logger=migrator" /tmp/investigation/run1.log
logger=migrator t=2026-07-08T05:41:47.129890897Z level=info msg="Locking database"
logger=migrator t=2026-07-08T05:41:47.129955981Z level=info msg="Starting DB migrations"
logger=migrator t=2026-07-08T05:41:47.137407162Z level=info msg="migrations completed" performed=0 skipped=626 duration=812.461µs
logger=migrator t=2026-07-08T05:41:47.137660951Z level=info msg="Unlocking database"
```

The second (pure-idle) instance corroborates the identical up-to-date signal (both the primary and
the resource migrator report `performed=0`):

```
$ grep "migrations completed" /tmp/investigation/run2.log
logger=migrator t=2026-07-08T05:41:47.136736764Z level=info msg="migrations completed" performed=0 skipped=626 duration=697.198µs
logger=resource-migrator t=2026-07-08T05:41:47.255456009Z level=info msg="migrations completed" performed=0 skipped=18 duration=49.432µs
```

Two observations worth calling out:

- On the fresh run, `performed` jumps from `626` (all migrations executed) to `0` on the next start,
  while `skipped` moves from `0` to `626` — the boundary that defines "up to date."
- There are **two** migrator scopes: the primary `logger=migrator` (the classic SQL schema
  migrator, `performed=626` → `0`) and a separate `logger=resource-migrator`
  (`performed=18` → it likewise reports `performed=0` on a migrated DB). The primary migrator is the
  one that answers the question; the resource migrator is noted for completeness.
- At the default INFO level the per-migration `"Skipping migration: Already executed"` lines are
  **not** shown (they are DEBUG — `pkg/services/sqlstore/migrator/migrator.go:L262`); the observable
  INFO signal is the single `"migrations completed" … performed=0` summary.

### Responsible code

- **`Migrator.run()`** — `pkg/services/sqlstore/migrator/migrator.go:L241` (`func (mg *Migrator) run(ctx context.Context)`).
  - Opening line: `L247` `logger.Info("Starting DB migrations")`.
  - Per-already-applied migration (DEBUG, skipped at INFO): `L262`
    `logger.Debug("Skipping migration: Already executed", "id", m.Id())`; counter `L266`
    `migrationsSkipped++`.
  - Terminal summary: `L287`
    `logger.Info("migrations completed", "performed", migrationsPerformed, "skipped", migrationsSkipped, "duration", time.Since(start))`.
  - Logger scope `"migrator"`: `L98` `mg.Logger = log.New("migrator")`.

### Rationale

Grafana's migrator executes at every startup and is idempotent: it consults the `migration_log`
table, runs only migrations not yet recorded, and skips the rest. On an already-migrated schema
every migration is skipped, so `migrationsPerformed` stays `0` and `migrationsSkipped` equals the
full count. The single INFO summary line therefore encodes "nothing was applied because the schema
already matches the code's expected version" as `performed=0`.

---

## Q3 — "Can you verify the current build information by querying the api endpoints of the running instance. What is the exact value of version string reported by the api. Give me runtime evidence to show that this value was reported by querying the api."

### Direct answer

The exact `version` string reported by the API of the canonically built, running instance is:

> **`11.5.0-pre`**

This value was returned by **two** independent HTTP endpoints of the running instance
(`/api/health` and `/api/frontend/settings`) and matches the startup banner. It is the **canonical**
value (link-time stamped from `package.json`); the dev-build default `9.2.0` was **not** observed
because the binary was built canonically.

### Runtime evidence — querying the running instance

**Endpoint 1 — `GET /api/health` (public; complete, unedited JSON):**

```
$ curl -s http://localhost:3000/api/health
{
  "database": "ok",
  "version": "11.5.0-pre",
  "commit": "4550cfb5b7"
}
```

**Endpoint 2 — `GET /api/frontend/settings`.** In the default `app_mode = production` this endpoint
requires authentication; querying it anonymously returns `401` (itself an observed behavior). The
complete, unedited response (status line, all headers, and the JSON body) is:

```
$ curl -s -i http://localhost:3000/api/frontend/settings
HTTP/1.1 401 Unauthorized
Cache-Control: no-store
Content-Type: application/json; charset=UTF-8
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Wed, 08 Jul 2026 05:43:32 GMT
Content-Length: 102

{"extra":null,"message":"Unauthorized","messageId":"auth.unauthorized","statusCode":401,"traceID":""}
```

Re-issued with the default `admin:admin` credentials, the full `buildInfo` object is returned. The
response is a single JSON document with **103 top-level keys**; `jq` is not present in this shell, so
`buildInfo` was extracted with `python3`. The complete, unedited `buildInfo` object (pretty-printed
by `python3`, no field elided) is:

```
$ curl -s -u admin:admin http://localhost:3000/api/frontend/settings \
    | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin)["buildInfo"], indent=2))'
{
  "hideVersion": false,
  "version": "11.5.0-pre",
  "versionString": "Grafana v11.5.0-pre (4550cfb5b7)",
  "commit": "4550cfb5b7",
  "commitShort": "4550cfb5b7",
  "buildstamp": 1734099722,
  "edition": "Open Source",
  "latestVersion": "",
  "hasUpdate": false,
  "env": "production"
}
```

The top-level key count was verified so the extraction is provably complete rather than truncated:

```
$ curl -s -u admin:admin http://localhost:3000/api/frontend/settings \
    | python3 -c 'import sys,json; print(len(json.load(sys.stdin)), "top-level keys")'
103 top-level keys
```

**Cross-check — startup banner in the server log matches the API:**

```
$ grep "Starting Grafana" /tmp/investigation/run1.log | head -1
logger=settings t=2026-07-08T05:41:47.125422901Z level=info msg="Starting Grafana" version=11.5.0-pre commit=4550cfb5b7 branch=blitzy-4620db6d-41d6-422c-ac3b-f1e9ae4830e1 compiled=2024-12-13T14:22:02Z
```

All three sources agree:

| Source                                     | `version`    | `commit`     | extra                                                                                                                        |
| ------------------------------------------ | ------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                          | `11.5.0-pre` | `4550cfb5b7` | `database: ok`                                                                                                               |
| `GET /api/frontend/settings` → `buildInfo` | `11.5.0-pre` | `4550cfb5b7` | `versionString: "Grafana v11.5.0-pre (4550cfb5b7)"`, `buildstamp: 1734099722`, `edition: "Open Source"`, `env: "production"` |
| startup banner (`logger=settings`)         | `11.5.0-pre` | `4550cfb5b7` | `compiled=2024-12-13T14:22:02Z` (= `buildstamp 1734099722`)                                                                  |

**Build and invocation commands used (canonical labeling, mandatory):**

- Build: `make build-backend` → `./bin/linux-amd64/grafana`, link-stamped
  `-X main.version=11.5.0-pre -X main.commit=4550cfb5b7 -X main.buildstamp=1734099722` (the complete
  build output is embedded in the "Investigation environment" section above). Verified directly:
  `./bin/linux-amd64/grafana --version` → `grafana version 11.5.0-pre`.
- Invocation (run1, the instance queried above): `./bin/linux-amd64/grafana server --homepath="$PWD"
  cfg:paths.data=/tmp/investigation/dataA cfg:paths.logs=/tmp/investigation/logs1
  cfg:paths.plugins=/tmp/investigation/plugins1` (listening on `http://localhost:3000`).
- The reported `11.5.0-pre` is therefore the **canonical** value. The dev default `9.2.0`
  (`pkg/cmd/grafana/main.go:L17`) would appear only from an unstamped `go run` / `make run-go` and
  was **not** used here.

### Responsible code

- **`HTTPServer.apiHealthHandler`** — `pkg/api/http_server.go:L710`. It builds a `healthResponse`
  (`pkg/api/http_server.go:L694`, JSON keys `database`, `version`, `commit`, `enterpriseCommit`) and,
  guarded by `if !hs.Cfg.Anonymous.HideVersion` (`L719`), sets the field at `L720`
  `data.Version = hs.Cfg.BuildVersion`, serializing with `json.MarshalIndent` (`L736`). The route is
  registered at `pkg/api/http_server.go:L634` `m.Use(hs.apiHealthHandler)`.
- **`hs.getFrontendSettings`** — `pkg/api/frontendsettings.go:L161` `version := setting.BuildVersion`;
  the `versionString` is formatted at `L165`
  `fmt.Sprintf(`%s v%s (%s)`, setting.ApplicationName, version, commitShort)` and surfaced as
  `buildInfo.versionString` (`L250`).
- **Startup banner** — `pkg/setting/setting.go:L940`
  `Info("Starting Grafana", "version", BuildVersion, "commit", BuildCommit, "branch", BuildBranch, "compiled", …)`.
- **Version source chain** — the single source `setting.BuildVersion` originates as the dev default
  `pkg/cmd/grafana/main.go:L17` `var version = "9.2.0"`, overridden at link time by the build tool:
  `pkg/build/cmd.go:L55` `opts.version = packageJSON.Version` → `pkg/build/cmd.go:L247`
  `-X main.version=%s`. `package.json` `version` = `11.5.0-pre`.

### Rationale

Both API endpoints and the banner read the same in-process variable, `setting.BuildVersion`. Its
value is decided **at build time**: a canonical build injects `package.json`'s `11.5.0-pre` via the
`-X main.version=` linker flag, so the running instance reports `11.5.0-pre` everywhere. This is why
building canonically matters — an unstamped `go run` would report `9.2.0` from the same code paths.

---

## Q4 — "Investigate its initialization logic during the transition from the dashboard view to the panel editor. Specifically, provide test script outputs to prove whether the picker automatically resolves to and displays the datasource already defined in the panel queries. Tell me which part of the codebase is responsible for this."

### Direct answer

**Yes — the datasource picker automatically resolves to and displays the datasource already defined
in the panel's queries.** When the dashboard-scene panel editor's queries tab activates (the
dashboard-view → panel-editor transition), **`PanelDataQueriesTab.loadDataSource()`** reads the
datasource from the panel's query runner (`this.queryRunner.state.datasource`), resolves it, and
stores it in the tab's state as `datasource` / `dsSettings`. That `dsSettings` is not passed to the
picker directly; instead **`PanelDataQueriesTab.buildQueryOptions()`** converts it into
`options.dataSource`, and the rendered tab hands that `options` object to `QueryGroupTopSection`,
which forwards it to `DataSourcePickerWithPrompt`; the prompt sets the picker's `current` selection to
`options.dataSource`. The responsible part of the codebase is
`public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx`
(methods `loadDataSource()` and `buildQueryOptions()`), with the picker hosted by
`public/app/features/query/components/QueryGroup.tsx`.

### Runtime evidence — the module's own Jest test

```
$ yarn jest public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx --ci --watchAll=false --verbose
```

Complete, unedited output (the leading `jest-haste-map` "duplicate manual mock" warnings are
pre-existing repository noise from duplicate `__mocks__` fixtures — not failures):

```
jest-haste-map: duplicate manual mock found: store.navIndex.mock
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/features/connections/__mocks__/store.navIndex.mock.ts
    * <rootDir>/public/app/features/datasources/__mocks__/store.navIndex.mock.ts

jest-haste-map: duplicate manual mock found: datasource
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/plugins/datasource/azuremonitor/__mocks__/datasource.ts
    * <rootDir>/public/app/plugins/datasource/influxdb/__mocks__/datasource.ts

jest-haste-map: duplicate manual mock found: query
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/plugins/datasource/azuremonitor/__mocks__/query.ts
    * <rootDir>/public/app/plugins/datasource/influxdb/__mocks__/query.ts

jest-haste-map: duplicate manual mock found: datasource
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/plugins/datasource/influxdb/__mocks__/datasource.ts
    * <rootDir>/public/app/plugins/datasource/loki/__mocks__/datasource.ts

jest-haste-map: duplicate manual mock found: index
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/features/datasources/__mocks__/index.ts
    * <rootDir>/public/app/features/plugins/admin/__mocks__/index.ts

jest-haste-map: duplicate manual mock found: datasource
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/plugins/datasource/loki/__mocks__/datasource.ts
    * <rootDir>/packages/grafana-prometheus/src/test/__mocks__/datasource.ts

PASS public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx
  PanelDataQueriesTab
    Adding queries
      ✓ can add a new query (29 ms)
      ✓ Can add a new query when datasource is mixed (8 ms)
    PanelDataQueriesTab
      ✓ renders query group top section (109 ms)
      ✓ renders queries rows when queries are set (83 ms)
      ✓ allow to add a new query when user clicks on add new (154 ms)
      ✓ allow to remove a query when user clicks on remove (439 ms)
    query options
      activation
        ✓ should load data source (7 ms)
        ✓ should store loaded data source in local storage (5 ms)
        ✓ should load default datasource if the datasource passed is not found (7 ms)
      data source change
        ✓ should load new data source (7 ms)
        ✓ changing from one plugin to another (5 ms)
        ✓ changing from a plugin to a dashboard data source (5 ms)
        ✓ changing from dashboard data source to a plugin (5 ms)
      query options change
        time overrides
          ✓ should create PanelTimeRange object (6 ms)
          ✓ should update hoverHeader (6 ms)
          ✓ should update PanelTimeRange object on time options update (5 ms)
          ✓ should remove PanelTimeRange object on time options cleared (6 ms)
        max data points and interval
          ✓ should update max data points (7 ms)
          ✓ should update min interval (5 ms)
          ✓ should update min interval to undefined if empty input (6 ms)
        query caching
          ✓ updates cacheTimeout and queryCachingTTL (9 ms)
      query inspection
        ✓ allows query inspection from the tab (5 ms)
      change queries
        plugin queries
          ✓ should update queries (4 ms)
        dashboard queries
          ✓ should update queries (5 ms)
          ✓ should load last used data source if no data source specified for a panel (4 ms)

Test Suites: 1 passed, 1 total
Tests:       25 passed, 25 total
Snapshots:   0 total
Time:        5.255 s, estimated 19 s
Ran all test suites matching /public\/app\/features\/dashboard-scene\/panel-edit\/PanelDataPane\/PanelDataQueriesTab.test.tsx/i.
```

The tests that directly substantiate the answer (all `✓`):

- **`should load data source`** — the primary path: on activation the resolved `state.datasource`
  matches the datasource defined on the query runner.
- **`Can add a new query when datasource is mixed`** — the source assertions
  (`PanelDataQueriesTab.test.tsx:L295-296`) show `queriesTab.state.datasource?.uid` equals
  `queriesTab.queryRunner.state.datasource?.uid` (`'-- Mixed --'`), i.e. the resolved picker
  datasource is taken from the query runner.
- **`should load default datasource if the datasource passed is not found`** and
  **`should load last used data source if no data source specified for a panel`** — the two fallback
  branches (below).

### Responsible code

- **`PanelDataQueriesTab.loadDataSource()`** — `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx:L63`.
  - Activation: `L44` `this.addActivationHandler(() => this.onActivate())`; `L59` `onActivate()`;
    `L60` `this.loadDataSource()`.
  - Reads the query-defined datasource: `L71`
    `let datasourceToLoad = this.queryRunner.state.datasource;`.
  - Primary resolution (datasource present on the query): `L101`
    `datasource = await getDataSourceSrv().get(datasourceToLoad)`; `L102`
    `dsSettings = getDataSourceSrv().getInstanceSettings(datasourceToLoad)`; then `L106`
    `this.setState({ datasource, dsSettings })`.
  - Converted for the picker: **`PanelDataQueriesTab.buildQueryOptions()`**
    (`PanelDataQueriesTab.tsx:L148-L157`) derives `options.dataSource` from `this.state.dsSettings`
    (`L149` `const dsSettings = this.state.dsSettings;`; `L154-L157`
    `dataSource: { default: dsSettings?.isDefault, ...getDataSourceRef(dsSettings) }`). The rendered
    `PanelDataQueriesTabRendered` then passes that `options` object to `QueryGroupTopSection` at
    `L318-L326` (`options={model.buildQueryOptions()}`, `L322`).
- **Picker host and the actual `dsSettings → picker` data flow** —
  `public/app/features/query/components/QueryGroup.tsx`. (Note: `QueryGroup.tsx:L50`
  `dsSettings?: DataSourceInstanceSettings;` is a field of the local `State` interface declared at
  `L48`, **not** picker-rendering code.) The datasource reaches the picker as `options.dataSource`,
  not as a `dsSettings` prop: **`QueryGroupTopSection`** (`QueryGroup.tsx:L386-L404`) receives the
  `options` prop and renders `<DataSourcePickerWithPrompt options={options} …>`
  (`QueryGroup.tsx:L415-L421`); **`DataSourcePickerWithPrompt`** then builds `commonProps` with
  `current: options.dataSource` (`QueryGroup.tsx:L498`, within `L493-L504`) and renders
  `<DataSourcePicker {...commonProps} />` (`QueryGroup.tsx:L512`) — so the picker's `current`
  selection is exactly the datasource resolved from the panel's query runner.

### Rationale

The queries tab is a scene object; on activation it initializes its own state from the panel's
existing query runner. Because `loadDataSource()` seeds `state.datasource`/`state.dsSettings`
directly from `this.queryRunner.state.datasource`, and the picker is a controlled component fed by
that `dsSettings`, the picker necessarily displays the datasource already defined in the panel's
queries — there is no user interaction required for it to resolve.

### Secondary / edge conditions (acknowledged, and covered by passing tests)

- **No datasource on the query** → `loadDataSource()` falls back to the **last-used** datasource from
  `localStorage` (`getLastUsedDatasourceFromStorage`, `PanelDataQueriesTab.tsx:L80`) and then to
  `config.defaultDatasource`. Covered by `✓ should load last used data source if no data source
specified for a panel`.
- **Resolution failure** → the `catch` block falls back to `config.defaultDatasource`
  (`PanelDataQueriesTab.tsx:L111-112`). Covered by `✓ should load default datasource if the
datasource passed is not found`.
- **Mixed datasource** → resolves to the `'-- Mixed --'` datasource, as asserted at
  `PanelDataQueriesTab.test.tsx:L295-296`.

---

## Q5 — "Investigate the alerting api's rule creation process at runtime to determine if the backend's rule definition populates the query state when the edit view is opened, show me test script output for this and identify the part of the codebase responsible for this behavior."

### Direct answer

**Yes — when the edit view is opened, the backend rule definition populates the editor's query
state.** `AlertRuleForm` seeds its React-Hook-Form `defaultValues` from the existing rule via
**`formValuesFromExistingRule(existing)`**, which is **`ignoreHiddenQueries(rulerRuleToFormValues(rule))`**.
**`rulerRuleToFormValues()`** maps the backend rule's query array (`grafana_alert.data`, whose
backend origin is `AlertRule.Data`) directly onto the form's **`queries`** state
(`queries: ga.data`). `ignoreHiddenQueries` then strips `model.hide` from each mapped query. The
responsible functions are `formValuesFromExistingRule` and `rulerRuleToFormValues` in
`public/app/features/alerting/unified/utils/rule-form.ts`, invoked by `AlertRuleForm`.

### Runtime evidence

**(a) The module's own Jest test** exercises the same conversion utilities in `rule-form.ts`
(it covers the **form → DTO** direction, `formValuesToRulerGrafanaRuleDTO`, plus related helpers —
the inverse of the edit-population mapping):

```
$ yarn jest public/app/features/alerting/unified/utils/rule-form.test.ts --ci --watchAll=false --verbose
```

Complete, unedited output (leading `jest-haste-map` warnings are pre-existing repo noise):

```
jest-haste-map: duplicate manual mock found: store.navIndex.mock
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/features/connections/__mocks__/store.navIndex.mock.ts
    * <rootDir>/public/app/features/datasources/__mocks__/store.navIndex.mock.ts

jest-haste-map: duplicate manual mock found: datasource
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/plugins/datasource/azuremonitor/__mocks__/datasource.ts
    * <rootDir>/public/app/plugins/datasource/influxdb/__mocks__/datasource.ts

jest-haste-map: duplicate manual mock found: query
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/plugins/datasource/azuremonitor/__mocks__/query.ts
    * <rootDir>/public/app/plugins/datasource/influxdb/__mocks__/query.ts

jest-haste-map: duplicate manual mock found: datasource
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/plugins/datasource/influxdb/__mocks__/datasource.ts
    * <rootDir>/public/app/plugins/datasource/loki/__mocks__/datasource.ts

jest-haste-map: duplicate manual mock found: index
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/features/datasources/__mocks__/index.ts
    * <rootDir>/public/app/features/plugins/admin/__mocks__/index.ts

jest-haste-map: duplicate manual mock found: datasource
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/plugins/datasource/loki/__mocks__/datasource.ts
    * <rootDir>/packages/grafana-prometheus/src/test/__mocks__/datasource.ts

PASS public/app/features/alerting/unified/utils/rule-form.test.ts
  formValuesToRulerGrafanaRuleDTO
    ✓ should correctly convert rule form values for grafana alerting rule (5 ms)
    ✓ should correctly convert rule form values for grafana recording rule (1 ms)
    ✓ should not save both instant and range type queries (1 ms)
    ✓ should set keep_firing_for if values are populated (1 ms)
    ✓ should not set keep_firing_for if values are undefined (1 ms)
    ✓ should parse keep_firing_for (1 ms)
    ✓ should set keepFiringForTime and keepFiringForTimeUnit to undefined if keep_firing_for not set
  getContactPointsFromDTO
    ✓ should return undefined if notification_settings is not defined
    ✓ should return routingSettings with correct props if notification_settings is defined (1 ms)
  getNotificationSettingsForDTO
    ✓ should return undefined if manualRouting is false (1 ms)
    ✓ should return undefined if selectedContactPoint is not defined
    ✓ should return notification settings if manualRouting is true and selectedContactPoint is defined (1 ms)
  getDefautManualRouting
    ✓ returns false if the feature toggle is not enabled (1 ms)
    ✓ returns true if the feature toggle is enabled and localStorage is not set
    ✓ returns false if the feature toggle is enabled and localStorage is set to "false" (3 ms)
    ✓ returns true if the feature toggle is enabled and localStorage is set to any value other than "false"
  cleanAnnotations
    ✓ should remove falsy KVs
    ✓ should trim keys and values (1 ms)
  cleanLabels
    ✓ should remove falsy KVs (1 ms)
    ✓ should trim keys and values
    ✓ should leave empty values (1 ms)

Test Suites: 1 passed, 1 total
Tests:       21 passed, 21 total
Snapshots:   7 passed, 7 total
Time:        4.573 s, estimated 5 s
Ran all test suites matching /public\/app\/features\/alerting\/unified\/utils\/rule-form.test.ts/i.
```

**(b) Direct proof of the edit-population path.** Because the shipped test covers the inverse
(form → DTO) direction, a **temporary** ad-hoc test (prefixed `blitzy_adhoc_test_`, created under
`public/app/features/alerting/unified/utils/`, re-run to confirm reproducibility, then removed —
see cleanup) was written to invoke the actual edit-population functions and print the runtime values.
It uses `process.stdout.write` (the repository's Jest setup fails any test that calls `console.log`
via `jest-fail-on-console`):

```
$ yarn jest public/app/features/alerting/unified/utils/blitzy_adhoc_test_q5.test.ts --ci --watchAll=false --verbose
jest-haste-map: duplicate manual mock found: store.navIndex.mock
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/features/connections/__mocks__/store.navIndex.mock.ts
    * <rootDir>/public/app/features/datasources/__mocks__/store.navIndex.mock.ts

jest-haste-map: duplicate manual mock found: datasource
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/plugins/datasource/azuremonitor/__mocks__/datasource.ts
    * <rootDir>/public/app/plugins/datasource/influxdb/__mocks__/datasource.ts

jest-haste-map: duplicate manual mock found: query
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/plugins/datasource/azuremonitor/__mocks__/query.ts
    * <rootDir>/public/app/plugins/datasource/influxdb/__mocks__/query.ts

jest-haste-map: duplicate manual mock found: datasource
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/plugins/datasource/influxdb/__mocks__/datasource.ts
    * <rootDir>/public/app/plugins/datasource/loki/__mocks__/datasource.ts

jest-haste-map: duplicate manual mock found: index
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/features/datasources/__mocks__/index.ts
    * <rootDir>/public/app/features/plugins/admin/__mocks__/index.ts

jest-haste-map: duplicate manual mock found: datasource
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/plugins/datasource/loki/__mocks__/datasource.ts
    * <rootDir>/packages/grafana-prometheus/src/test/__mocks__/datasource.ts

BACKEND grafana_alert.data = [{"datasourceUid":"123","refId":"A","queryType":"huh","model":{}}]
EDITOR  form.queries       = [{"datasourceUid":"123","refId":"A","queryType":"huh","model":{}}]
EDITOR  form.condition     = "A"
formValuesFromExistingRule queries = [{"refId":"A","datasourceUid":"ds-uid-A","queryType":"","model":{"refId":"A"}},{"refId":"B","datasourceUid":"__expr__","queryType":"","model":{"refId":"B"}}]
PASS public/app/features/alerting/unified/utils/blitzy_adhoc_test_q5.test.ts
  BLITZY ADHOC Q5: backend rule definition populates editor query state on edit
    ✓ rulerRuleToFormValues maps backend grafana_alert.data -> form queries (alerting rule) (3 ms)
    ✓ formValuesFromExistingRule (AlertRuleForm defaultValues source) populates queries and strips model.hide (1 ms)

Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total
Snapshots:   0 total
Time:        4.057 s, estimated 5 s
Ran all test suites matching /public\/app\/features\/alerting\/unified\/utils\/blitzy_adhoc_test_q5.test.ts/i.
```

This is direct, observed proof:

- `EDITOR form.queries` is **byte-for-byte identical** to the backend rule's `grafana_alert.data`
  (`rulerRuleToFormValues` sets `queries: ga.data`), and `form.condition` is taken from the rule too.
- In the second case the input query `A` had `model: { refId: 'A', hide: true }`; the output query
  `A` has `model: { refId: 'A' }` — `model.hide` was **stripped** by `ignoreHiddenQueries`, while
  both queries `A` and `B` are still present in `form.queries`.

The ad-hoc test constructed its backend rule with the repository's own factory
`mockRulerGrafanaRule` (`public/app/features/alerting/unified/mocks.ts:L117`), wrapped in a
`RuleWithLocation` sourced from `GRAFANA_RULES_SOURCE_NAME` — i.e. it drove the real functions, not
a stand-in.

**(c) Backend runtime — a real Ruler API create/get round-trip (observed, not inferred).** To ground
the backend HTTP-transport step itself, a Grafana-managed alert rule was created and then read back
through the running instance's real Ruler API on run1 (`admin:admin`, folder UID `blitzyq5`). The
rule's `grafana_alert.data` query array is the payload sent:

```
$ cat rule_payload.json
{
  "name": "blitzy-q5-group",
  "interval": "1m",
  "rules": [
    {
      "grafana_alert": {
        "title": "blitzy-q5-rule",
        "condition": "A",
        "no_data_state": "NoData",
        "exec_err_state": "Error",
        "data": [
          {
            "refId": "A",
            "queryType": "",
            "relativeTimeRange": { "from": 0, "to": 0 },
            "datasourceUid": "__expr__",
            "model": { "refId": "A", "type": "math", "datasource": { "type": "__expr__", "uid": "__expr__" }, "expression": "1 < 2" }
          }
        ]
      },
      "for": "0s",
      "labels": {},
      "annotations": {}
    }
  ]
}

$ curl -s -u admin:admin -H 'Content-Type: application/json' \
    -X POST http://localhost:3000/api/ruler/grafana/api/v1/rules/blitzyq5 \
    --data @rule_payload.json -o /dev/null -w 'HTTP %{http_code}\n'
HTTP 202
```

Server-side confirmation of the create, taken verbatim from the run1 access log (the authoritative
observation of the HTTP transport):

```
$ grep 'method=POST' /tmp/investigation/run1.log
logger=context userId=1 orgId=1 uname=admin t=2026-07-08T05:42:24.848783274Z level=info msg="Request Completed" method=POST path=/api/ruler/grafana/api/v1/rules/blitzyq5 status=202 remote_addr=127.0.0.1 time_ms=11 duration=11.321817ms size=74 referer= handler=/api/ruler/grafana/api/v1/rules/:Namespace status_source=server
```

Reading the rule back returns it with `grafana_alert.data` populated — the complete, unedited
response body:

```
$ curl -s -u admin:admin http://localhost:3000/api/ruler/grafana/api/v1/rules/blitzyq5
{"Blitzy Q5 Folder":[{"name":"blitzy-q5-group","interval":"1m","rules":[{"expr":"","for":"0s","grafana_alert":{"id":1,"orgId":1,"title":"blitzy-q5-rule","condition":"A","data":[{"refId":"A","queryType":"","relativeTimeRange":{"from":0,"to":0},"datasourceUid":"__expr__","model":{"datasource":{"type":"__expr__","uid":"__expr__"},"expression":"1 \u003c 2","intervalMs":1000,"maxDataPoints":43200,"refId":"A","type":"math"}}],"updated":"2026-07-08T05:42:24Z","intervalSeconds":60,"version":1,"uid":"bfrgmot6e28zkd","namespace_uid":"blitzyq5","rule_group":"blitzy-q5-group","no_data_state":"NoData","exec_err_state":"Error","is_paused":false,"metadata":{"editor_settings":{"simplified_query_and_expressions_section":false,"simplified_notifications_section":false}}}}]}]}
```

Server-side confirmation of the read, and a byte-count cross-check (the log's `size=767` equals the
response body's exact byte length, proving the body above is complete and unedited):

```
$ grep 'method=GET path=/api/ruler/grafana/api/v1/rules/blitzyq5' /tmp/investigation/run1.log
logger=context userId=1 orgId=1 uname=admin t=2026-07-08T05:42:33.809695415Z level=info msg="Request Completed" method=GET path=/api/ruler/grafana/api/v1/rules/blitzyq5 status=202 remote_addr=127.0.0.1 time_ms=6 duration=6.25171ms size=767 referer= handler=/api/ruler/grafana/api/v1/rules/:Namespace status_source=server

$ curl -s -u admin:admin http://localhost:3000/api/ruler/grafana/api/v1/rules/blitzyq5 | wc -c
767
```

The returned `grafana_alert.data` (a single query `refId=A` carrying the `__expr__` math expression
`1 < 2`) is exactly the query definition that `rulerRuleToFormValues` maps into the editor's
`queries` state when the rule's edit view opens. This confirms the full path — backend
`AlertRule.Data` → the HTTP Ruler API → the returned `grafana_alert.data` — is **observed at runtime**,
so the edit view is seeded from a query definition the backend genuinely persisted and served (note
Grafana's Ruler API returns `202 Accepted` for both the create and the read, as observed above).

### Responsible code

- **`AlertRuleForm`** — `public/app/features/alerting/unified/components/rule-editor/alert-rule-form/AlertRuleForm.tsx`.
  - `L103` `const defaultValues: RuleFormValues = useMemo(() => {`; `L104` `if (existing) {`;
    `L105` `return formValuesFromExistingRule(existing);`.
  - `L126` `const formAPI = useForm<RuleFormValues>({` … `L128` `defaultValues,` — seeding the
    editor's fields (including `queries`) from those defaults when the edit view opens.
- **`formValuesFromExistingRule`** — `public/app/features/alerting/unified/utils/rule-form.ts:L916`;
  `L917` `return ignoreHiddenQueries(rulerRuleToFormValues(rule));`.
- **`rulerRuleToFormValues`** — `public/app/features/alerting/unified/utils/rule-form.ts:L365`; maps
  the backend query array to the form: `L380` `queries: ga.data` (grafana **recording** rule branch)
  and `L402` `queries: ga.data` (grafana **alerting** rule branch — the standard alert-edit path).
- **`ignoreHiddenQueries`** — `public/app/features/alerting/unified/utils/rule-form.ts:L909`; `L912`
  `queries: ruleDefinition.queries?.map((query) => omit(query, 'model.hide'))`.
- **Backend origin of the data** — `pkg/services/ngalert/models/alert_rule.go:L746`
  `Data []AlertQuery` (comment `L745`: "Data is an array of data source queries and/or server side
  expressions."), surfaced by the Ruler API in `pkg/services/ngalert/api/api_ruler.go`. The endpoints
  exercised in evidence (c) are the create handler **`RulerSrv.RoutePostNameRulesConfig`** (`L331`)
  and the folder/namespace read handler **`RulerSrv.RouteGetNamespaceRulesConfig`** (`L193`); the
  single-rule variant is **`RulerSrv.RouteGetRuleByUID`** (`L309`).

### Rationale

Opening the edit view mounts `AlertRuleForm` with the existing rule. React-Hook-Form is initialized
once with `defaultValues`, and those defaults come from `formValuesFromExistingRule`. The core
mapping `rulerRuleToFormValues` copies the rule's `grafana_alert.data` array (populated by the
backend from `AlertRule.Data`) straight into the form's `queries` field, so the query editor opens
pre-populated with exactly the queries the rule was created/saved with. `ignoreHiddenQueries` only
removes the transient `model.hide` flag from each query; it does not drop queries.

### Secondary / edge conditions

- **Recording vs alerting rule** — both branches map `queries: ga.data` (`rule-form.ts:L380` and
  `L402`); the ad-hoc test exercised the alerting branch, and the shipped test snapshots both
  grafana alerting and grafana recording conversions.
- **Hidden queries** — `ignoreHiddenQueries` strips `model.hide`; demonstrated directly above
  (query `A`'s `hide: true` removed while the query itself is retained).
- **Backend runtime note** — the frontend edit-population path was exercised end-to-end via Jest
  against the real functions, **and** the backend `AlertRule.Data` → Ruler-API linkage was
  **observed at runtime** (no longer inferred) via the real create/get round-trip in evidence (c)
  above (`pkg/services/ngalert/api/api_ruler.go` — `RoutePostNameRulesConfig` create returned
  `202`, `RouteGetNamespaceRulesConfig` read returned the rule with `grafana_alert.data` populated,
  byte-count cross-checked against the run1 access log). The field that carries the queries,
  `AlertRule.Data`, is grounded at `pkg/services/ngalert/models/alert_rule.go:L746`.

---

## Coverage pass

Each question decomposed into every distinct thing and named item it asks for, with where it is
answered.

| #   | Distinct ask                                                                            | Answered? | Where / value                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Server running ≥ 60 s with no user requests                                             | ✅        | Idle proven; `grep` for request logs = `0` across all runs; no 10-minute recurring entry fires in the first 60 s (the usage-stats line's first tick can land at ~30–120 s)                           |
| Q1  | The **exact recurring** log entries                                                     | ✅        | `msg="Completed cleanup jobs"` (10 min), `msg="Update check succeeded"` (`plugins.update.checker`, 10 min), **and** `msg="Usage stats are ready to report"` (`infra.usagestats`, 30 min)             |
| Q1  | **Actual log output** as runtime evidence                                               | ✅        | Verbatim logfmt lines from run1 & run2 (10-min lines) + extended idle runs idle1 & idle2 (30-min usage-stats line) embedded                                                                          |
| Q1  | Magnitude/timing observed & stable across ≥ 2 runs                                      | ✅        | Cleanup `599.99 s` & plugin-check `~600 s` in both ≈ 24-min runs; usage-stats **two consecutive `1800.00 s` intervals** (`1800.002 s`/`1800.000 s`) in each of two extended > 60-min idle runs (`10:50:32Z`→`11:53:38Z`, ≈ 63 min) |
| Q1  | Which part of the codebase                                                              | ✅        | `CleanUpService.clean()`/`Run()` (`cleanup.go:L77,L80,L128`); plugin checker `plugins.go:L78` (ticker) + `L123` (INFO emit); usage-stats `UsageStats.SetReadyToReport()` (`service.go:L116-117`) driven by `statscollector.Service.Run()` (`statscollector/service.go:L106,L120,L339`); `Server.Run()` (`server.go:L139`) |
| Q2  | Server-start output confirming schema up to date                                        | ✅        | `msg="migrations completed" … performed=0 skipped=626`                                                                                                                                               |
| Q2  | Runtime evidence of the migration check (before/after)                                  | ✅        | Fresh DB `performed=626`; migrated DB `performed=0` — both embedded                                                                                                                                  |
| Q2  | Responsible symbol                                                                      | ✅        | `Migrator.run()` (`migrator.go:L241`, Info at `L247` & `L287`)                                                                                                                                       |
| Q3  | Verify build info **by querying the API of the running instance**                       | ✅        | `GET /api/health` and `GET /api/frontend/settings` both queried live                                                                                                                                 |
| Q3  | **Exact value** of the version string                                                   | ✅        | **`11.5.0-pre`**                                                                                                                                                                                     |
| Q3  | Runtime evidence it was reported by the API                                             | ✅        | Full `curl` commands + unedited JSON for both endpoints + matching banner                                                                                                                            |
| Q3  | Canonical build labeling / dev `9.2.0` handling                                         | ✅        | Canonical `make build-backend` (`-X main.version=11.5.0-pre`); dev `9.2.0` labeled non-canonical, not observed                                                                                       |
| Q3  | Responsible symbols                                                                     | ✅        | `HTTPServer.apiHealthHandler` (`http_server.go:L710,L720`), `getFrontendSettings` (`frontendsettings.go:L161`), source chain `main.go:L17`→`build/cmd.go:L55,L247`                                   |
| Q4  | Initialization logic during dashboard-view → panel-editor transition                    | ✅        | `onActivate()`→`loadDataSource()` (`PanelDataQueriesTab.tsx:L59-60,L63`)                                                                                                                             |
| Q4  | **Test script output** proving the picker auto-resolves to the query-defined datasource | ✅        | `yarn jest PanelDataQueriesTab.test.tsx` — 25/25 PASS, incl. `should load data source`                                                                                                               |
| Q4  | Whether it displays the datasource defined in the panel queries                         | ✅        | Yes — `state.datasource`/`dsSettings` from `queryRunner.state.datasource` → `QueryGroupTopSection`                                                                                                   |
| Q4  | Which part of the codebase                                                              | ✅        | `PanelDataQueriesTab.loadDataSource()` + `QueryGroup.tsx` (picker host)                                                                                                                              |
| Q5  | Alerting rule-creation process at runtime                                               | ✅        | Ruler API observed live — POST `RoutePostNameRulesConfig:L331` (202) + GET `RouteGetNamespaceRulesConfig:L193` (202, `grafana_alert.data` populated); by-UID variant `RouteGetRuleByUID:L309`; `AlertRule.Data` (`alert_rule.go:L746`)                                                                        |
| Q5  | Whether backend rule definition populates query state on edit                           | ✅        | Yes — `form.queries` == backend `grafana_alert.data` (ad-hoc test) **and** confirmed by the observed Ruler round-trip (evidence (c))                                                                                                                     |
| Q5  | **Test script output**                                                                  | ✅        | `yarn jest rule-form.test.ts` (21/21 PASS) + ad-hoc test (2/2 PASS) embedded                                                                                                                         |
| Q5  | Which part of the codebase                                                              | ✅        | `formValuesFromExistingRule` & `rulerRuleToFormValues` (`rule-form.ts:L916-917,L365,L380,L402`), invoked by `AlertRuleForm` (`AlertRuleForm.tsx:L105,L126-128`); `ignoreHiddenQueries` (`L909,L912`) |

**"Which part of the codebase" — answered by name for every question:**
Q1 → `CleanUpService.clean()` (cleanup run loop) + `plugins.update.checker` + `statscollector.Service.Run()` / `UsageStats.SetReadyToReport()` (usage-stats);
Q2 → `Migrator.run()`;
Q3 → `HTTPServer.apiHealthHandler` and `getFrontendSettings` (both reading `setting.BuildVersion`);
Q4 → `PanelDataQueriesTab.loadDataSource()` (picker hosted by `QueryGroup.tsx`);
Q5 → `formValuesFromExistingRule` / `rulerRuleToFormValues`.

### Summary of direct answers

- **Q1:** At INFO, the idle stream is sparse; the recurring INFO entries are `"Completed cleanup jobs"`
  and `"Update check succeeded"` (both every **10 minutes**) plus `"Usage stats are ready to report"`
  (every **30 minutes**) — all stable across two runs. Within a strict 60 s window neither 10-minute
  line has fired; the usage-stats line's first occurrence may fall at/just after the 60 s mark
  (randomized 30–120 s initial delay) and then recurs every 30 minutes.
- **Q2:** `msg="migrations completed" … performed=0` (schema already up to date).
- **Q3:** `version = 11.5.0-pre` (canonical build), reported identically by `/api/health`,
  `/api/frontend/settings`, and the startup banner.
- **Q4:** **Yes** — the picker auto-resolves to and displays the query-defined datasource, via
  `PanelDataQueriesTab.loadDataSource()`.
- **Q5:** **Yes** — the backend rule definition populates the editor's query state, via
  `AlertRuleForm` → `formValuesFromExistingRule` → `rulerRuleToFormValues` (`queries: ga.data`).
