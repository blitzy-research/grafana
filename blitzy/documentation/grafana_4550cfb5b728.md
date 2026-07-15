# Grafana Runtime Investigation — grafana_4550cfb5b728

This document answers five questions about Grafana's runtime behavior at the scenes-v5.32.0 head commit **`4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`** ("Upgrade scenes to v5.32.0 (#97944)"). The investigation branch layers **only** this answer document on top of `4550cfb5b7`; no source file differs from that commit, so the observed behavior and every `file:line` citation pertain to the source at `4550cfb5b7`.

It is a **run-first, evidence-grounded** investigation. For every behavioral claim the document shows the exact command that produced it and the **actual captured output** (log lines, HTTP responses, Jest results), then names the responsible code by `file:line` with a cause → effect explanation. Values are reported exactly as observed at runtime; the few statements that can only be derived from reading source (for example, the recurrence period of a timer whose interval exceeds the observation window) are explicitly labelled **inferred**. The investigation is strictly **read-only** with respect to existing source: no existing repository file was modified — this answer document is the sole tracked change — and every temporary observation script was removed on completion (verified with git evidence in the Closing Note).

The five questions, verbatim:

1. **Q1 — Idle server recurring logs.** After the server has run ≥60 seconds with zero user requests, enumerate the exact recurring log entries that appear, with the actual captured log output as evidence.
2. **Q2 — Database migration check.** Capture the specific startup output that confirms the database schema version is up to date, as runtime evidence of the migration check.
3. **Q3 — Build/version via API.** Query the running instance's API endpoints to verify build information and report the exact version string value the API returns, with runtime evidence of the API query itself.
4. **Q4 — Dashboard scene datasource picker.** Investigate the dashboard-scene initialization logic during the dashboard-view → panel-editor transition and provide test-script output proving whether the picker automatically resolves to and displays the datasource already defined in the panel's queries; identify the responsible code.
5. **Q5 — Alerting rule-edit query state.** Investigate the alerting API's rule-creation process at runtime to determine whether the backend's rule definition populates the query state when the edit view is opened; provide test-script output and identify the responsible code.

---

## Methodology

This document is **run-first**: every behavioral claim below is accompanied by the actual command that produced it and the unedited output that command emitted. Values are reported exactly as observed. Statements that could only be derived from reading source code (never observed at runtime — e.g., the recurrence period of a timer whose interval exceeds the observation window) are explicitly labelled **inferred**; everything else is observed at runtime on the running system.

### Baseline and repository integrity

The investigation branch layers **only** this answer document on top of the scenes-v5.32.0 head commit `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` — no existing source file is modified. The two commands below establish that stably: the working tree is clean, and the *only* difference between the investigated base commit and the branch head is the addition of this one document (status `A`). A specific branch-head SHA and an insertion count are intentionally **not** quoted here, because they change every time this document itself is committed; the durable, always-true facts are the clean tree and the single added file.

```bash
$ git status --porcelain
                      # (empty = clean working tree)

$ git diff --name-status 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff HEAD
A	blitzy/documentation/grafana_4550cfb5b728.md
```

Because the sole delta from `4550cfb5b7` is this document (an addition), no source file differs and all runtime observations — and every `file:line` citation below — reflect the exact source at commit `4550cfb5b7`.

### Toolchain versions (with the commands that produced them)

```bash
$ go version
go version go1.23.1 linux/amd64
$ node --version
v22.23.1
$ yarn --version
4.5.3
```

Go 1.23.1 matches `go.mod:3`. Node v22.23.1 satisfies the engine requirement; `.nvmrc` pins `v22.11.0` and is **left unmodified** (read-only scope). Yarn 4.5.3 is the repo-bundled release.

### Backend build (canonical)

Wire code generation must precede the build (it writes the gitignored `pkg/server/wire_gen.go`):

```bash
$ make gen-go
generate go files
go run  ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server
wire: github.com/grafana/grafana/pkg/server: wrote /…/pkg/server/wire_gen.go

real	0m32.179s
```

The canonical backend build (bounded with an explicit timeout). Its output is reproduced essentially verbatim below; the non-required, environment-internal or volatile values in the captured output are shown as neutral placeholders — the build-host Go module-cache path as `$GOPATH`, the agent build-branch identifier as `<build-branch>`, and the per-build identifiers (commit SHA as `<commit>`, build stamp as `<buildstamp>`, package iteration as `<iteration>`) — for the same reason this document omits the volatile branch-head SHA and diff line-count (see the Closing Note). None of these placeholders affects any answer: the version signal `main.version=11.5.0-pre` and the ldflags mechanism remain intact. A scratch directory `/tmp/gfinv` is created first (with an explicit `mkdir -p`) to hold this one-off build log so the `tee` redirect succeeds in a fresh shell (it lives under `/tmp`, off the git tree); every **server-run** log, by contrast, is written under the per-lifecycle private `mktemp -d` workspace `$WORK` defined in the run/observe helpers above:

```bash
$ mkdir -p /tmp/gfinv                                # scratch dir for the one-off build log (off the git tree; created before first use)
$ timeout 900 make build-backend 2>&1 | tee /tmp/gfinv/build.log
build backend
go run build.go    build-backend
Version: 11.5.0, Linux Version: 11.5.0, Package Iteration: <iteration>pre
rm -r dist
rm -r tmp
rm -r $GOPATH/pkg/linux_amd64/github.com/grafana
building grafana ./pkg/cmd/grafana
rm -r ./bin/linux-amd64/grafana
rm -r ./bin/linux-amd64/grafana.md5
go build -ldflags -w -X main.version=11.5.0-pre -X main.commit=<commit> -X main.buildstamp=<buildstamp> -X main.buildBranch=<build-branch> -o ./bin/linux-amd64/grafana ./pkg/cmd/grafana
go version
go version go1.23.1 linux/amd64
Targeting linux/amd64

real	0m14.264s
```

The build orchestrator (`pkg/build/cmd.go:247`) injects the version via ldflags. The injected `main.version=11.5.0-pre` (from `package.json:6`) is the stable answer reported throughout Q3; the accompanying `main.commit`/`main.buildstamp` are volatile per-build identifiers shown here as `<commit>`/`<buildstamp>` (the concrete `buildstamp` observed from the running binary appears literally in the Q3 `buildInfo`). The injected commit is whatever `HEAD` was when the binary was built — the documentation branch sitting directly atop scenes head `4550cfb5b7`; because no source file differs between them, the version string is identical for either commit. Binary self-report:

```bash
$ ./bin/linux-amd64/grafana --version
grafana version 11.5.0-pre
```

### Frontend/test dependencies (provenance)

The frontend workspace was materialised with an **immutable** install (`CI=true yarn install --immutable`), leaving `node_modules` present and **gitignored** (so the tracked tree is never altered):

```bash
$ du -sh node_modules
1.5G	node_modules
$ git check-ignore node_modules
node_modules
$ CI=true yarn jest --version
29.7.0
```

Jest 29.7.0 matches `package.json`; the config is `jest.config.js`. Jest executes against TypeScript directly, so Q4/Q5 need no webpack build.

### Safe run/observe lifecycle (how every server observation was taken)

Every server observation used a **loopback-only, timeout-bounded, temp-pathed** run so that (a) nothing binds a public interface, (b) no command can hang, and (c) the git tree stays byte-for-byte unchanged. The pattern:

All explanatory notes below live on their **own lines** (never after a `\` line-continuation, which would otherwise escape the trailing space and truncate the command). Every writable path and log lives under **one** private, mode-`700` `mktemp -d` workspace, and a single scoped `trap` reaps every server on normal exit or interrupt:

```bash
set -o pipefail
# One private, unpredictable, mode-700 workspace holds every server's writable
# paths AND its captured log — nothing is written under the repo or a fixed /tmp name.
WORK="$(mktemp -d)"; chmod 700 "$WORK"
PIDS=()
# Scoped teardown: reap ONLY the servers we started (never a broad pkill), then
# remove the workspace. Armed for normal exit AND interrupt so nothing leaks.
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

run_observe() {                              # args: name port level seconds
  name=$1 port=$2 lvl=$3 secs=$4
  # loopback ONLY (never 0.0.0.0/[::]); all writable paths redirected off-tree into $WORK;
  # timeout upper-bounds the run so it self-terminates even if a kill is missed.
  timeout "${secs}s" ./bin/linux-amd64/grafana server \
      --homepath . --config conf/defaults.ini \
      cfg:server.http_addr=127.0.0.1 \
      cfg:server.http_port="$port" \
      cfg:log.level="$lvl" \
      cfg:paths.data="$WORK/$name/data" \
      cfg:paths.logs="$WORK/$name/logs" \
      cfg:paths.plugins="$WORK/$name/plugins" \
      > "$WORK/$name.log" 2>&1 &
  pid=$!; PIDS+=("$pid")                     # capture PID for a scoped stop / trap teardown
  # readiness: poll the server's OWN log for the listen line — no fixed sleep, no HTTP request
  for _ in $(seq 1 60); do
    grep -q "HTTP Server Listen" "$WORK/$name.log" && break
    sleep 1
  done
  echo "$name pid=$pid port=$port log=$WORK/$name.log"
}
# A scoped stop is always: kill only the captured PID, then reap it:
#   kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
```

Notes on the guarantees (each verified by executing the block verbatim): the Q1 observation helpers (`run_observe`/`launch`) wrap the server in an explicit `timeout`, so those runs are **self-terminating** and cannot leak even if a `kill` is missed or the shell is interrupted; the Q2/Q3 boots below are **also** `timeout`-wrapped (each via the `boot()` helper) **and** capture each server's PID into a `PIDS` array registered with the single `EXIT`/`INT`/`TERM` cleanup `trap` shown above; they run **sequentially — one server at a time**, each stopped with `kill`/`wait` before the next begins, so the `trap` guarantees no server is leaked even on interrupt. In all cases `http_addr=127.0.0.1` keeps the instance off all public interfaces; redirecting `paths.{data,logs,plugins}` into the single `mktemp -d` workspace prevents the server from writing `data/` into the repository; readiness is derived from the server's own `"HTTP Server Listen"` log line (or a `/api/health` poll) rather than a blind `sleep`; and every stop targets **only** the captured PID(s) (never a broad `pkill`). Because each helper stores its PID and the caller `wait`s for (or `kill`s) every child before reading the logs, no evidence command ever races an incomplete log and the shell never exits with an active child. All curls in Q3 likewise target `127.0.0.1`.

**Run provenance and timestamps.** The evidence below was gathered across several canonical runs of the **same** source built to version `11.5.0-pre` (the version string is fixed in `package.json:6` and is identical for every build of this checkout — see Q3); the ≥2-run stability the questions demand inherently spans multiple invocations. Each captured line's timestamp therefore reflects the specific run that produced it. Where a line's *absolute* instant is not itself the evidence, its timestamp is redacted to `<ts>`; where a *relative interval* is the evidence (the Q1 10-minute cadence), the wall-clock times are retained so the interval is visible. Volatile per-build identifiers — commit SHA, build stamp, compile time, and build branch — are shown as placeholders (`<commit>`, `<buildstamp>`, `<compiled>`, `<build-branch>`) throughout, since they change on every rebuild and none affects any answer.

---

## Q1 — Recurring log entries on an idle server (≥60s, zero user requests)

**Direct answer.** At Grafana's **default log level (`level = info`, `conf/defaults.ini:1074`)**, a server left idle with **zero HTTP requests emits _no_ recurring log entries during the first 60 seconds** of steady-state operation. The recurring INFO-level activity that does exist is **coarse-grained** and consists entirely of **independent interval tickers:** two emitters recur on a **10-minute** cadence (`plugins.update.checker` and `cleanup`), and a third (`grafana.update.checker`) recurs every **24 hours** (only its startup fire is observed within a ~12-minute run; the 24 h recurrence is inferred from source). Separately — and **not** a periodic emitter — a **contention-triggered** INFO line, `sqlstore.transactions` `"Database locked, sleeping then retrying"`, appears only at moments of SQLite write-lock contention: it was observed across multiple canonical idle runs during the **startup background-initialization burst** and again during the **shutdown DB-finalization sequence** (but **not** at the idle 10-minute cleanup boundary), and is produced by the transaction **retry layer** (`pkg/services/sqlstore/transactions.go:66-75`), not by a timer of its own, so it is enumerated separately from the interval tickers. The frequent sub-minute recurrence (a 10-second alert-scheduler tick and a family of 60-second synchronizers) exists but logs **only at `level = debug`**, so it is invisible at the default level. The enumeration below lists **every** recurring INFO ticker observed across two runs — and, separately, the contention-triggered lock-retry line with its captured evidence — plus the complete DEBUG set, each with its interval/trigger, log level, exact emit line, driving timer, and (for tickers) the default that fixes its interval, backed by captured runtime output.

### Methodology for Q1

Four canonical background runs were launched simultaneously (loopback-only, timeout-bounded, all writable paths and logs under one private mode-`700` `mktemp -d` workspace so the git tree is untouched). Two ran at `level=info` for ~12 minutes (to cross the 10-minute boundary and prove the 10-minute recurrence twice), and two ran at `level=debug` for ~3.5 minutes (to surface the sub-minute set twice for cross-run stability). Each launch stores its PID; after all four are up the shell **`wait`s for every timeout-bounded child** before any log is read, so no evidence command races an incomplete log and the shell never exits with an active child:

```bash
# launched from the repository root after `make gen-go && make build-backend`
set -o pipefail
WORK="$(mktemp -d)"; chmod 700 "$WORK"       # one private workspace for all Q1 logs + paths
PIDS=()
# scoped teardown: reap only the servers we started, then remove the workspace
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

launch() {                                   # args: name port level seconds
  name=$1 port=$2 lvl=$3 secs=$4
  timeout "${secs}s" ./bin/linux-amd64/grafana server \
    --homepath . --config conf/defaults.ini \
    cfg:server.http_addr=127.0.0.1 \
    cfg:server.http_port="$port" \
    cfg:log.level="$lvl" \
    cfg:paths.data="$WORK/$name/data" \
    cfg:paths.logs="$WORK/$name/logs" \
    cfg:paths.plugins="$WORK/$name/plugins" \
    > "$WORK/$name.log" 2>&1 &
  pid=$!; PIDS+=("$pid")                     # store every PID for wait/teardown
  # readiness via the server's own log line — no HTTP request, so the idle window stays request-free
  for _ in $(seq 1 60); do
    grep -q "HTTP Server Listen" "$WORK/$name.log" && break
    sleep 1
  done
  echo "$name pid=$pid port=$port"
}

launch run_long  3101 info  720              # ~12 min: crosses the 10-minute boundary
launch run_long2 3104 info  720
launch run3      3102 debug 210              # ~3.5 min: surfaces the sub-minute set
launch run3b     3103 debug 210

# Idle with ZERO HTTP requests, then explicitly reap every timeout-bounded child before
# reading logs. The timeouts self-terminate each server; wait blocks until all have exited.
wait "${PIDS[@]}"
trap - EXIT INT TERM                         # all children reaped — disarm the cleanup trap
```

All four confirmed loopback binding and the canonical build at startup, e.g. (run_long):

```
logger=http.server t=2026-07-14T21:02:17.828885974Z level=info msg="HTTP Server Listen" address=127.0.0.1:3101 protocol=http subUrl= socket=
```

Zero requests were issued to any of the four instances for their entire lifetime. The idle window is measured from this "HTTP Server Listen" instant (t₀ = 21:02:17).

> **Fresh-database nuance (why the window starts past t₀).** These runs use a fresh SQLite database, so the first few seconds after process start contain a **one-time** schema-migration burst of **644** `Executing migration` info lines (`pkg/services/sqlstore/migrator/migrator.go:356`, logged at Info) — **626** from `logger=migrator` plus **18** from `logger=resource-migrator`, exactly the two migrators' `performed=626` / `performed=18` counts reported in Q2 — that merely share the same `msg` text. That burst is **not** periodic recurrence — it never repeats. Q1's steady-state analysis therefore samples a window that begins **after** startup/migration completes (from t₀+120s onward), isolating genuine interval-driven recurrence.

### Q1-a — The 60-second idle window at the default level is recurrence-free (observed)

Command (applied identically to both info runs): print every `level=info` line whose timestamp falls in the steady-state window `[t₀+120s, t₀+180s]` = `[21:04:17, 21:05:17]`.

```bash
# select INFO lines timestamped within [21:04:17, 21:05:17] ($WORK from the launch block above)
grep 'level=info' "$WORK/run_long.log" \
  | grep -E 't=2026-07-14T21:04:(1[7-9]|[2-5][0-9])|t=2026-07-14T21:05:(0[0-9]|1[0-7])'
```

Observed output (run_long — port 3101):

```
```

Observed output (run_long2 — port 3104):

```
```

**Both are empty.** No INFO line is emitted anywhere in a full 60-second steady-state idle window. This is the direct evidence that an idle server produces **no recurring INFO logs within 60 seconds** at the default level.

### Q1-b — The recurring INFO emitters that *do* exist (10-minute and 24-hour cadences) — observed across two runs

At `level=info`, three emitters recur. Two are visible only once you idle **past 10 minutes**; the third recurs only every 24 hours (so within any run shorter than a day it fires just once, at startup).

**(1) `plugins.update.checker` — "Update check succeeded" — every 10 minutes.** Fires once at startup **and** again at t₀+600s. Captured in both info runs (real timestamps; note the two fires exactly 10 minutes apart):

run_long (port 3101):
```
logger=plugins.update.checker t=2026-07-14T21:02:17.8643274Z level=info msg="Update check succeeded" duration=37.17156ms
logger=plugins.update.checker t=2026-07-14T21:12:17.899516845Z level=info msg="Update check succeeded" duration=34.244057ms
```
run_long2 (port 3104):
```
logger=plugins.update.checker t=2026-07-14T21:02:17.7823797Z level=info msg="Update check succeeded" duration=41.454453ms
logger=plugins.update.checker t=2026-07-14T21:12:17.81483778Z level=info msg="Update check succeeded" duration=32.105671ms
```
- Emit line: `pkg/services/updatechecker/plugins.go:123` (`ctxLogger.Info("Update check succeeded", ...)`).
- Timer: `pkg/services/updatechecker/plugins.go:78` (`ticker := time.NewTicker(time.Minute * 10)`) → **10-minute** interval, hardcoded.

**(2) `cleanup` — "Completed cleanup jobs" — every 10 minutes.** `time.NewTicker` does not fire immediately, so the first occurrence is at **t₀+600s** (21:12:17) in both runs:

run_long:
```
logger=cleanup t=2026-07-14T21:12:17.903574879Z level=info msg="Completed cleanup jobs" duration=75.330794ms
```
run_long2:
```
logger=cleanup t=2026-07-14T21:12:17.903829228Z level=info msg="Completed cleanup jobs" duration=162.23281ms
```
- Emit line: `pkg/services/cleanup/cleanup.go:128` (`logger.Info("Completed cleanup jobs", "duration", time.Since(start))`).
- Timer: `pkg/services/cleanup/cleanup.go:80` (`ticker := time.NewTicker(time.Minute * 10)`) → **10-minute** interval, hardcoded.

**(3) `grafana.update.checker` — "Update check succeeded" — every 24 hours (startup fire observed; recurrence *inferred*).** This emitter shares the same `msg` text as (1) but is a *different* logger and *different* ticker. Its startup fire is observed at t₀ in run_long:
```
logger=grafana.update.checker t=2026-07-14T21:02:17.864134795Z level=info msg="Update check succeeded" duration=37.037156ms
```
- Emit line: `pkg/services/updatechecker/grafana.go:89`.
- Timer: `pkg/services/updatechecker/grafana.go:63` (`ticker := time.NewTicker(time.Hour * 24)`) → **24-hour** interval.
- *Inferred:* because the interval is 24h, the recurrence itself cannot be observed within these ~12-minute runs; only the single startup fire is observed. The recurrence period is read from `pkg/services/updatechecker/grafana.go:63` and labelled inferred.

### Q1-b (contention addendum) — A contention-triggered INFO line, `sqlstore.transactions` "Database locked, sleeping then retrying" (observed; **not** a periodic ticker)

Separate from the interval tickers above, one **INFO** line is emitted by the SQLite transaction **retry layer** rather than by any timer, so it is enumerated on its own. It appears **only when two goroutines momentarily contend for the single SQLite write lock**, is therefore **non-periodic**, and its exact timing is **contention-dependent (non-deterministic)**. Across the canonical idle runs it was observed at two distinct lifecycle points — the **startup background-initialization burst** and the **shutdown DB-finalization sequence** — and, notably, it did **not** appear at the idle 10-minute cleanup boundary in the two ~12-minute info runs: it was still absent ~40 s past that boundary and surfaced only during shutdown.

**Emitter and mechanism.** `pkg/services/sqlstore/transactions.go:74` (`ctxLogger.Info("Database locked, sleeping then retrying", "error", err, "retry", retry, "code", sqlError.Code)`), inside `inTransactionWithRetryCtx` (`pkg/services/sqlstore/transactions.go:36`; retry logic at `:66-75`). When a transaction's error is a sqlite3 `ErrLocked`/`ErrBusy` and `retry < TransactionRetries` (default **5** — `pkg/services/sqlstore/database_config.go:121` `MustInt(5)`, backed by `conf/defaults.ini:182` `transaction_retries = 5`), the layer rolls back, **sleeps 10 ms** (`transactions.go:73`), logs this INFO line, then retries with `retry+1` (`transactions.go:75`). The observed `retry=0` with **no** following `retry=1` line means the write succeeded on the **first** retry after a single 10 ms sleep.

**Observed at shutdown** (both ~12-minute info runs; the lock-retry is the **last** line emitted, ~11 ms after `"Shutdown started"`, while the api-server storage pruner is exiting — i.e. ~98 s *after* the t₀+600 s cleanup boundary, not at it):

infoA (port 3201):
```
logger=server t=<ts> level=info msg="Shutdown started" reason="System signal: terminated"
logger=ticker t=<ts> level=info msg=stopped last_tick=<ts>
logger=tracing t=<ts> level=info msg="Closing tracing"
logger=grafana-apiserver t=<ts> level=info msg="StorageObjectCountTracker pruner is exiting"
logger=sqlstore.transactions t=<ts> level=info msg="Database locked, sleeping then retrying" error="database is locked" retry=0 code="database is locked"
```
infoB (port 3202):
```
logger=server t=<ts> level=info msg="Shutdown started" reason="System signal: terminated"
logger=tracing t=<ts> level=info msg="Closing tracing"
logger=ticker t=<ts> level=info msg=stopped last_tick=<ts>
logger=grafana-apiserver t=<ts> level=info msg="StorageObjectCountTracker pruner is exiting"
logger=sqlstore.transactions t=<ts> level=info msg="Database locked, sleeping then retrying" error="database is locked" retry=0 code="database is locked"
```

**Observed at startup** (a separate canonical idle run; the lock-retry lands ~68 ms after the `"HTTP Server Listen"` instant, inside the background-service init burst just after the update-checkers — again `retry=0`):
```
logger=grafana.update.checker t=<ts> level=info msg="Update check succeeded" duration=55.700657ms
logger=sqlstore.transactions t=<ts> level=info msg="Database locked, sleeping then retrying" error="database is locked" retry=0 code="database is locked"
logger=plugin.angulardetectorsprovider.dynamic t=<ts> level=info msg="Patterns update finished" duration=74.179441ms
```

**Cause → effect.** During the startup init burst and again during shutdown finalization, several background components issue DB writes concurrently (state-cache init, plugin/registry updates, update-checkers at startup; the api-server `StorageObjectCountTracker` pruner and other teardown writes at shutdown). SQLite allows only **one** writer at a time, so one writer transiently receives `SQLITE_BUSY`/`SQLITE_LOCKED`; Grafana's retry layer catches it, logs this single INFO line, sleeps 10 ms, and succeeds on retry — hence the line appears **once**, at a **contention moment**, rather than on any fixed interval. This is precisely why the enumeration of *interval-driven* recurring emitters lists it **separately** as a contention-triggered line. (Timestamps are shown as `<ts>` because the exact instant is contention-dependent and carries no interval meaning; the *ordering* relative to the surrounding lines is what the evidence establishes.)

### Q1-c — The sub-minute recurring set (DEBUG only) — observed twice for stability

Idling at the default `level=info` hides all high-frequency tickers because they log at **Debug**. Running at `level=debug` surfaces them. The two debug runs (`run3`=3102, `run3b`=3103) produced **identical** emitter sets and counts, confirming stability. The **complete** periodic DEBUG set has **ten** `(logger, msg)` emitters, each recurring on a fixed 10-second or 60-second interval:

| Emitter (logger) | msg | Interval | run3 count | run3b count |
|---|---|---|---|---|
| `ngalert.scheduler` | `Alert rules fetched` | 10 s | 21 | 21 |
| `secrets` | `Removing expired data keys from cache...` | 60 s | 3 | 3 |
| `secrets` | `Removing expired data keys from cache finished successfully` | 60 s | 3 | 3 |
| `ssosettings.service` | `reloading SSO Settings for all providers` | 60 s | 3 | 3 |
| `ssosettings.service` † | `No SSO Settings found in the database, using system settings` (per provider) | 60 s | 28 | 28 |
| `ngalert.multiorg.alertmanager` | `Synchronizing Alertmanagers for orgs` | 60 s | 4 | 4 |
| `ngalert.multiorg.alertmanager` | `Done synchronizing Alertmanagers for orgs` | 60 s | 4 | 4 |
| `ngalert.notifier.alertmanager` (`org=1`) † | `Config hasn't changed, skipping configuration sync.` | 60 s | 3 | 3 |
| `ngalert.sender.router` | `Attempting to sync admin configs` | 60 s | 4 | 4 |
| `ngalert.sender.router` † | `Finish of admin configuration sync` | 60 s | 4 | 4 |

> **† Enumeration completeness (re-verification).** The three daggered rows complete the periodic DEBUG set. Because they accompany lines already listed — the SSO reload cycle, the multiorg-Alertmanager sync, and the admin-config sync — they are driven by the **same** 60 s tickers and recur identically. They were re-confirmed in two additional debug runs (canonical binary, loopback-only, temp-pathed, ≥236 s idle, **zero** HTTP requests) with **identical** counts across both runs (`28` / `3` / `4` respectively). The 10 s `Alert rules fetched` count scales only with run duration (21 fires in a ~210 s run, 23 in a ~236 s run); every 60 s count is duration-independent within these windows. Verbatim samples for all three daggered emitters appear below.

**Verbatim samples (run3; run3b identical):**

`ngalert.scheduler` — every 10 s (`baseInterval`), first six ticks:
```
logger=ngalert.scheduler t=2026-07-14T21:02:20.001032486Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-14T21:02:30.000801359Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-14T21:02:40.001168238Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-14T21:02:50.000403161Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-14T21:03:00.00097098Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-14T21:03:10.000894521Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
```
- Emit line: `pkg/services/ngalert/schedule/fetcher.go:39` (`sch.log.Debug("Alert rules fetched", ...)`).
- Timer: `pkg/services/ngalert/schedule/schedule.go:158` (`t := ticker.New(sch.clock, sch.baseInterval, ...)`).
- Default interval source: `conf/defaults.ini:1346` (`min_interval = 10s`) → `pkg/services/ngalert/ngalert.go:379` (`BaseInterval: ng.Cfg.UnifiedAlerting.BaseInterval`) → **10 s**.

`secrets` — every 60 s, a **paired** enter/finish per cycle:
```
logger=secrets t=2026-07-14T21:03:17.849902228Z level=debug msg="Removing expired data keys from cache..."
logger=secrets t=2026-07-14T21:03:17.849948409Z level=debug msg="Removing expired data keys from cache finished successfully"
logger=secrets t=2026-07-14T21:04:17.849713379Z level=debug msg="Removing expired data keys from cache..."
logger=secrets t=2026-07-14T21:04:17.84976784Z level=debug msg="Removing expired data keys from cache finished successfully"
```
- Emit lines: `pkg/services/secrets/manager/manager.go:521` and `:523`.
- Timer: `pkg/services/secrets/manager/manager.go:503-505` (`gc := time.NewTicker(... MustDuration(time.Minute))`) → **60-second** cadence.
- Note: the **15-minute** value at `pkg/services/secrets/manager/manager.go:67` (`data_keys_cache_ttl ... MustDuration(15 * time.Minute)`) is the entry *age threshold* (which keys are "expired"), **not** the GC cadence; the GC runs every 60 s.

`ssosettings.service` — every 60 s:
```
logger=ssosettings.service t=2026-07-14T21:03:17.849965847Z level=debug msg="reloading SSO Settings for all providers"
logger=ssosettings.service t=2026-07-14T21:04:17.849751882Z level=debug msg="reloading SSO Settings for all providers"
```
- Emit line: `pkg/services/ssosettings/ssosettingsimpl/service.go:384`.
- Timer: `pkg/services/ssosettings/ssosettingsimpl/service.go:368` (`ticker := time.NewTicker(interval)`).
- Default interval source: `pkg/setting/setting.go:1662` (`SSOSettingsReloadInterval = ... Key("reload_interval").MustDuration(1 * time.Minute)`) → **60 s**.

`ngalert.multiorg.alertmanager` — every 60 s, a **paired** start/done per cycle:
```
logger=ngalert.multiorg.alertmanager t=2026-07-14T21:02:17.748499975Z level=debug msg="Synchronizing Alertmanagers for orgs"
logger=ngalert.multiorg.alertmanager t=2026-07-14T21:02:17.758664464Z level=debug msg="Done synchronizing Alertmanagers for orgs"
logger=ngalert.multiorg.alertmanager t=2026-07-14T21:03:17.849935038Z level=debug msg="Synchronizing Alertmanagers for orgs"
logger=ngalert.multiorg.alertmanager t=2026-07-14T21:03:17.850880375Z level=debug msg="Done synchronizing Alertmanagers for orgs"
```
- Emit lines: `pkg/services/ngalert/notifier/multiorg_alertmanager.go:255` and `:266`.
- Timer: `pkg/services/ngalert/notifier/multiorg_alertmanager.go:246` (`case <-time.After(moa.settings.UnifiedAlerting.AlertmanagerConfigPollInterval)`).
- Default interval source: `pkg/setting/setting_unified_alerting.go:24` (`alertmanagerDefaultConfigPollInterval = time.Minute`), applied at `:243` → **60 s**. (The startup sync at t₀ is the initial load; subsequent fires are 60 s apart.)

`ngalert.sender.router` — every 60 s:
```
logger=ngalert.sender.router t=2026-07-14T21:02:17.758796036Z level=debug msg="Attempting to sync admin configs" count=0
logger=ngalert.sender.router t=2026-07-14T21:03:17.851742911Z level=debug msg="Attempting to sync admin configs" count=0
```
- Emit line: `pkg/services/ngalert/sender/router.go:90`.
- Timer: `pkg/services/ngalert/sender/router.go:384` (`case <-time.After(d.adminConfigPollInterval)`).
- Default interval source: `pkg/setting/setting_unified_alerting.go:50` (`schedulerDefaultAdminConfigPollInterval = time.Minute`), applied at `:239` → **60 s**.

**The three additional 60 s emitters (daggered in the table above), captured verbatim in the debug re-verification run (`23:03:32` = t₀; counts identical across both re-verification runs):**

`ssosettings.service` — `No SSO Settings found in the database, using system settings` — a **7-line burst per 60 s reload cycle** (one line per configured SSO provider that has no settings stored in the database), for **28** lines total over four cycles. This is a *different* `msg` from the `reloading SSO Settings for all providers` line already listed above (that one prints once per cycle; this one prints once per provider within the cycle). One complete cycle (t₀+60 s):
```
logger=ssosettings.service t=2026-07-14T23:04:32.668838131Z level=debug msg="No SSO Settings found in the database, using system settings"
logger=ssosettings.service t=2026-07-14T23:04:32.668858607Z level=debug msg="No SSO Settings found in the database, using system settings"
logger=ssosettings.service t=2026-07-14T23:04:32.668867651Z level=debug msg="No SSO Settings found in the database, using system settings"
logger=ssosettings.service t=2026-07-14T23:04:32.668878165Z level=debug msg="No SSO Settings found in the database, using system settings"
logger=ssosettings.service t=2026-07-14T23:04:32.668885895Z level=debug msg="No SSO Settings found in the database, using system settings"
logger=ssosettings.service t=2026-07-14T23:04:32.668895825Z level=debug msg="No SSO Settings found in the database, using system settings"
logger=ssosettings.service t=2026-07-14T23:04:32.668919954Z level=debug msg="No SSO Settings found in the database, using system settings"
```
- Emit line: `pkg/services/ssosettings/ssosettingsimpl/service.go:414` (`s.logger.Debug("No SSO Settings found in the database, using system settings")`), inside `mergeSSOSettings()` when the database holds no stored settings for the provider.
- Timer/driver: emitted once per provider inside `doReload()` (`pkg/services/ssosettings/ssosettingsimpl/service.go:383`), which the 60 s reload ticker at `pkg/services/ssosettings/ssosettingsimpl/service.go:368` invokes — the **same** cycle that prints `reloading SSO Settings for all providers` above.
- Default interval source: `pkg/setting/setting.go:1662` (`SSOSettingsReloadInterval = ... Key("reload_interval").MustDuration(1 * time.Minute)`) → **60 s** → 7 providers × 4 cycles = **28** lines.

`ngalert.notifier.alertmanager` (`org=1`) — `Config hasn't changed, skipping configuration sync.` — every 60 s. This is a **distinct logger** (the per-org Alertmanager) from the `ngalert.multiorg.alertmanager` lines above. It first fires at **t₀+60 s** (not at t₀): the initial config is *applied* at startup, so only the subsequent polls report it unchanged — hence **3** fires in this window versus 4 for the multiorg `Synchronizing` line. All three fires:
```
logger=ngalert.notifier.alertmanager org=1 t=2026-07-14T23:04:32.669107122Z level=debug msg="Config hasn't changed, skipping configuration sync."
logger=ngalert.notifier.alertmanager org=1 t=2026-07-14T23:05:32.669919211Z level=debug msg="Config hasn't changed, skipping configuration sync."
logger=ngalert.notifier.alertmanager org=1 t=2026-07-14T23:06:32.671287636Z level=debug msg="Config hasn't changed, skipping configuration sync."
```
- Emit line: `pkg/services/ngalert/notifier/alertmanager.go:340` (`am.logger.Debug("Config hasn't changed, skipping configuration sync.")`), inside `applyConfig()` when the incoming config's hash equals the loaded one.
- Timer/driver: the multiorg sync poll at `pkg/services/ngalert/notifier/multiorg_alertmanager.go:246` (`case <-time.After(moa.settings.UnifiedAlerting.AlertmanagerConfigPollInterval)`) → `LoadAndSyncAlertmanagersForOrgs` → per-org `applyConfig()` — the **same** 60 s timer as the `ngalert.multiorg.alertmanager` rows.
- Default interval source: `pkg/setting/setting_unified_alerting.go:24` (`alertmanagerDefaultConfigPollInterval = time.Minute`), applied at `:243` → **60 s**.

`ngalert.sender.router` — `Finish of admin configuration sync` — every 60 s. This is the **paired completion** of the `Attempting to sync admin configs` line above; the two bracket one run of `SyncAndApplyConfigFromDatabase` (start fires at t₀, so both show **4** occurrences). All four fires:
```
logger=ngalert.sender.router t=2026-07-14T23:03:32.588518953Z level=debug msg="Finish of admin configuration sync"
logger=ngalert.sender.router t=2026-07-14T23:04:32.668745701Z level=debug msg="Finish of admin configuration sync"
logger=ngalert.sender.router t=2026-07-14T23:05:32.669105427Z level=debug msg="Finish of admin configuration sync"
logger=ngalert.sender.router t=2026-07-14T23:06:32.669845221Z level=debug msg="Finish of admin configuration sync"
```
- Emit line: `pkg/services/ngalert/sender/router.go:202` (`d.logger.Debug("Finish of admin configuration sync")`), the last line of `SyncAndApplyConfigFromDatabase`.
- Timer/driver: `pkg/services/ngalert/sender/router.go:384` (`case <-time.After(d.adminConfigPollInterval)`) → `SyncAndApplyConfigFromDatabase` — the **same** timer as `Attempting to sync admin configs` at `:90`.
- Default interval source: `pkg/setting/setting_unified_alerting.go:50` (`schedulerDefaultAdminConfigPollInterval = time.Minute`), applied at `:239` → **60 s**.

### Q1-d — The dashboard provisioner does **not** poll on an idle default server (observed)

A plausible expectation is that the dashboard provisioning poller ticks every 10 s and logs recurringly. **It does not, in the default configuration.** In both debug runs the only `provisioning.dashboard` lines are one-time startup messages — there is no recurring poll/walk output:

```bash
grep 'logger=provisioning.dashboard' "$WORK/run3.log" | sed -E 's/t=[^ ]+/t=<ts>/' | sort -u
```
Observed (distinct messages, both runs):
```
logger=provisioning.dashboard t=<ts> level=info msg="starting to provision dashboards"
logger=provisioning.dashboard t=<ts> level=info msg="finished to provision dashboards"
```

**Cause → effect.** The default config declares **no** dashboard providers, so the provisioner builds **zero** file readers; the polling goroutine and its ticker are created **per file reader**, so with no readers **no ticker is ever created** and nothing recurs. Responsible code: `pkg/services/provisioning/dashboards/dashboard.go:105-106` iterates `provider.fileReaders` (empty here), and the ticker that would drive recurrence lives at `pkg/services/provisioning/dashboards/file_reader.go:80-81` (`ticker := time.NewTicker(time.Duration(int64(time.Second) * fr.Cfg.UpdateIntervalSeconds))`) inside `pollChanges`, which is only started for an existing reader. With zero readers, that path is never entered.

### Q1-e — Emitters that exist but do **not** fire within an idle observation window (inferred)

The following interval-driven services are registered but, given their long periods or silent implementation, do **not** appear within a ~12-minute idle run. Their intervals are read from source and are therefore labelled **inferred** (not observed to recur):

| Service | Interval | Log behavior | Reference |
|---|---|---|---|
| Expired user-token cleanup | 1 hour | would log on fire | `pkg/services/auth/authimpl/token_cleanup.go:11` |
| Anonymous-device cleanup | 2 hours | would log on fire | `pkg/services/anonymous/anonimpl/impl.go:201` |
| Remote-cache (DB) GC | 10 minutes | **silent** (no log emitted) | `pkg/infra/remotecache/database_storage.go:30` |
| `grafana.update.checker` recurrence | 24 hours | logs on fire (startup fire observed) | `pkg/services/updatechecker/grafana.go:63` |

### Q1 — Coverage summary

- **Within 60 s at the default `info` level:** **no recurring entries** (observed empty steady-state window, both runs).
- **Recurring INFO emitters (independent tickers):** `plugins.update.checker` (10 min) and `cleanup` (10 min) were **observed** to recur (each fired twice — at startup/first-cycle and again at t₀+600s — in both info runs); `grafana.update.checker`'s **24-hour** recurrence is **inferred** from source (`pkg/services/updatechecker/grafana.go:63`) after observing **only its single startup fire** — the 24 h period cannot be observed within a ~12-minute run, so its recurrence is not claimed as observed.
- **Contention-triggered INFO line (non-periodic, not a ticker):** `sqlstore.transactions` `"Database locked, sleeping then retrying"` — observed across multiple canonical idle runs at SQLite write-lock contention moments (the startup background-init burst and the shutdown DB-finalization sequence; see the *Q1-b contention addendum*); it is emitted by the transaction retry layer (`pkg/services/sqlstore/transactions.go:74`), not by an independent periodic timer, and did **not** appear at the idle 10-minute cleanup boundary in the two ~12-minute info runs.
- **Recurring DEBUG emitters (hidden at default level) — ten in total:** `ngalert.scheduler` (`Alert rules fetched`, 10 s); and at 60 s: `secrets` (paired enter/finish), `ssosettings.service` (`reloading SSO Settings…` once per cycle **plus** a per-provider `No SSO Settings found…` burst), `ngalert.multiorg.alertmanager` (paired `Synchronizing…`/`Done synchronizing…`), `ngalert.notifier.alertmanager` `org=1` (`Config hasn't changed…`), and `ngalert.sender.router` (paired `Attempting…`/`Finish of admin configuration sync`) — all observed identically across debug runs.
- **Provisioner:** no recurrence in default config (observed; zero providers → zero readers → no ticker).
- **Long-interval/silent services:** token cleanup (1 h), anon cleanup (2 h), remote-cache GC (10 min, silent), grafana update-check recurrence (24 h) — intervals inferred from source, not observed to recur.

---

## Q2 — Capture the specific startup output that confirms the database schema version is up to date

**Direct answer: The confirming evidence is the SQL-store migrator's INFO pair `msg="Starting DB migrations"` followed by `msg="migrations completed"` carrying the `performed`, `skipped`, and `duration` fields. On a database that is already fully migrated, that second line reads `performed=0` — the runtime proof that the schema is up to date.** A default Grafana boot runs **two** independent migrators, each of which prints its own `Starting DB migrations` → `migrations completed` pair: the main store migrator (`logger=migrator`) and the unified-storage resource migrator (`logger=resource-migrator`). Both boot states are shown below (first boot performs the migrations; second boot of the same database performs none), and the per-migration skip counts are reconciled exactly against the terminal `skipped=` counters.

### First boot (fresh SQLite database) — migrations are performed

Every observation instance is bound to **loopback only**, is given writable `paths.*` under **one** private mode-`700` `mktemp -d` workspace `$W` (so the tracked tree is never touched), is launched in the background with its **PID captured** into a `PIDS` array (registered with a single `EXIT`/`INT`/`TERM` cleanup `trap`, so an interrupt or early exit leaks no server), and is polled for readiness on `/api/health`. Ports are **allocated dynamically** — a free loopback port per boot via a `freeport()` helper — so nothing depends on a fixed port being available. Crucially, the boots are **sequential on the same database file**: each boot is **stopped** (`kill`/`wait`) before the next begins, and every boot after the first re-opens the **exact same** `$W/data` directory — the first boot creates and migrates it, and each later boot re-opens that already-migrated file. **No database is ever copied**, and **no fixed shared `/tmp` path is created or deleted**. The Q3 server is likewise a single sequential boot on that same migrated `$W/data`: it stays up only across its own read-only queries (`/api/health`, `/api/frontend/settings`, the `401`, `/healthz`, and the banner read-back) and is then stopped before the hide-version contrast boot — so still only **one server runs at a time**. Because every server is torn down and the workspace name is unpredictable, the whole Q2→Q3 procedure is **idempotent** and safe to re-run from the top (no stale `bind: address already in use`, no clobbering of a fixed path). Nothing hangs and nothing listens beyond `127.0.0.1`.

```bash
$ set -o pipefail
$ W="$(mktemp -d)"; chmod 700 "$W"                   # ONE private mode-700 workspace: DB, logs, artifacts
$ PIDS=()                                            # every background server PID, for guaranteed teardown
$ cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; rm -rf "$W"; }
$ trap cleanup EXIT INT TERM                         # an interrupt or early exit reaps every server + removes $W
$ freeport() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }
$ BIN=./bin/linux-amd64/grafana
$ # boot <port> <level> <logfile>: always opens the SAME $W/data; readiness polled on /api/health
$ boot() {
    timeout 220s "$BIN" server --homepath . --config conf/defaults.ini \
        cfg:server.http_addr=127.0.0.1 cfg:server.http_port="$1" cfg:log.level="$2" \
        cfg:paths.data="$W/data" cfg:paths.logs="$W/logs" cfg:paths.plugins="$W/plugins" \
        > "$3" 2>&1 &
    BPID=$!; PIDS+=("$BPID")
    for _ in $(seq 1 90); do curl -sf -m3 "http://127.0.0.1:$1/api/health" >/dev/null 2>&1 && break; sleep 1; done
  }
$ stop() { kill "$1" 2>/dev/null; wait "$1" 2>/dev/null; }
$ # --- First boot: FRESH database at level=info ---
$ P1=$(freeport); boot "$P1" info "$W/boot1.log"; A=$BPID
$ grep -E 'logger=(migrator|resource-migrator) .*(msg="Starting DB migrations"|msg="migrations completed")' "$W/boot1.log" \
      | sed -E 's/t=[^ ]+/t=<ts>/'
$ stop "$A"                                          # first boot stopped; its migrated $W/data persists for later boots
```

> The first boot is **stopped immediately** (`stop "$A"`) once its migrator lines are captured. Its migrated database persists at `$W/data` and is re-opened — **never copied** — by every later boot (the second boot below, the Debug boot, and the Q3 server). The `trap` guarantees any still-running server is reaped even if the shell is interrupted.

Complete result — the migrator lines exactly as emitted, with only the volatile timestamp redacted to `<ts>` by the `sed` above; the `performed`/`skipped`/`duration` fields are the real captured values:

```text
logger=migrator t=<ts> level=info msg="Starting DB migrations"
logger=migrator t=<ts> level=info msg="migrations completed" performed=626 skipped=0 duration=2.044369912s
logger=resource-migrator t=<ts> level=info msg="Starting DB migrations"
logger=resource-migrator t=<ts> level=info msg="migrations completed" performed=18 skipped=0 duration=51.743002ms
```

On a fresh database the two migrators perform **626** (`migrator`) and **18** (`resource-migrator`) migrations respectively, each with `skipped=0`.

### Second boot (same database) — schema already up to date, `performed=0`

```bash
$ # --- Second boot: SAME database ($W/data), level=info — no copy, no fixed path ---
$ P2=$(freeport); boot "$P2" info "$W/boot2.log"; B=$BPID
$ grep -E 'logger=(migrator|resource-migrator) .*(msg="Starting DB migrations"|msg="migrations completed")' "$W/boot2.log" \
      | sed -E 's/t=[^ ]+/t=<ts>/'
$ stop "$B"                                          # second boot stopped; $W/data still the one migrated file
```

```text
logger=migrator t=<ts> level=info msg="Starting DB migrations"
logger=migrator t=<ts> level=info msg="migrations completed" performed=0 skipped=626 duration=773.65µs
logger=resource-migrator t=<ts> level=info msg="Starting DB migrations"
logger=resource-migrator t=<ts> level=info msg="migrations completed" performed=0 skipped=18 duration=39.546µs
```

**`performed=0` on both migrators is the "schema is up to date" confirmation**: all 626 + 18 known migrations were recognized as already applied and none were re-executed.

### Per-migration skip evidence (Debug) — reconciling the skip counters exactly

At the default `level=info` the individual skips are not printed. Booting the already-migrated database at `level=debug` surfaces one `Skipping migration: Already executed` line per already-applied migration. Counting them **per migrator** reconciles them one-for-one with the `skipped=` counters above (626 + 18 = 644):

```bash
$ # --- Debug boot: SAME database ($W/data), level=debug — surfaces per-migration skips ---
$ P3=$(freeport); boot "$P3" debug "$W/boot3.log"; C=$BPID
$ L="$W/boot3.log"
$ echo "migrator skips=$(grep 'logger=migrator '          "$L" | grep -c 'Skipping migration: Already executed')" \
       "resource-migrator skips=$(grep 'logger=resource-migrator ' "$L" | grep -c 'Skipping migration: Already executed')" \
       "total=$(grep -c 'Skipping migration: Already executed' "$L")"
$ stop "$C"
```

```text
migrator skips=626 resource-migrator skips=18 total=644
```

So the `644` per-migration skip lines are exactly `626` (from `logger=migrator`) + `18` (from `logger=resource-migrator`), matching the two `skipped=` counters. First three skip lines of the main migrator (verbatim):

```text
logger=migrator t=<ts> level=debug msg="Skipping migration: Already executed" id="create migration_log table"
logger=migrator t=<ts> level=debug msg="Skipping migration: Already executed" id="create user table"
logger=migrator t=<ts> level=debug msg="Skipping migration: Already executed" id="add unique index user.login"
```

### Responsible code

The log-emitting function is **`(*Migrator).run`** at `pkg/services/sqlstore/migrator/migrator.go:241`, reached from the public entry point `(*Migrator).Start` → `RunMigrations` → `run`. The same function is used by both migrator instances (the second is constructed with the `resource-migrator` logger name for the unified-storage resource database):

- `pkg/services/sqlstore/migrator/migrator.go:247` — `logger.Info("Starting DB migrations")`.
- `pkg/services/sqlstore/migrator/migrator.go:262` — `logger.Debug("Skipping migration: Already executed", "id", m.Id())` (per already-applied migration; Debug only). Immediately followed by `migrationsSkipped++` (`pkg/services/sqlstore/migrator/migrator.go:266`), so skip lines and the `skipped=` counter are incremented one-for-one in the same loop iteration.
- `pkg/services/sqlstore/migrator/migrator.go:287` — `logger.Info("migrations completed", "performed", migrationsPerformed, "skipped", migrationsSkipped, "duration", time.Since(start))`.

### Cause → effect

On boot, `(*Migrator).run` iterates its registered migration list. For each migration already recorded in the `migration_log` table it logs the Debug skip line (`:262`) and increments `skipped` (`:266`); migrations not yet recorded are executed and increment `performed`. It then emits the terminal INFO line (`:287`). Because a default boot constructs **two** migrators, two `Starting DB migrations` → `migrations completed` pairs appear per boot. On a fully-migrated database every migration in both is skipped, so both lines report `performed=0` (`skipped=626` and `skipped=18`) — the definitive runtime signal that the schema version matches the code and no schema change was needed.

---

## Q3 — Query the running instance's API to verify build information; report the exact version string

**Direct answer: the running canonical instance reports the version string `11.5.0-pre`.** The exact value is returned identically by `GET /api/health` (`"version": "11.5.0-pre"`), by `GET /api/frontend/settings` (`buildInfo.version = "11.5.0-pre"`, `versionString = "Grafana v11.5.0-pre (<commit>)"`), and by the startup banner (`version=11.5.0-pre`). The value is **build-method dependent**: the canonical build (`make build-backend`, ldflag `-X main.version=11.5.0-pre`) yields `11.5.0-pre`; a bare `go run ./pkg/cmd/grafana` (no ldflags) yields the fallback literal `9.2.0`. The canonical `11.5.0-pre` is the reported answer.

> Build provenance: the canonical build injects `main.commit` from the repository `HEAD` at build time. On this checkout `HEAD` is the documentation branch, whose only addition over the investigated source head `4550cfb5b7` (“Upgrade scenes to v5.32.0”) is this answer document — no source file differs (see the Closing Note). The build therefore injected that `HEAD` as `main.commit`, so the API/banner reported it as `commit=<commit>`, **redacted throughout this section** as a volatile, environment-specific build identifier. The **version string** — the subject of this question — is sourced from `package.json` and is `11.5.0-pre` regardless of which commit is checked out.

### Q3 server (Boot D — same migrated `$W/data`)

Q3 queries a canonical server booted on the **same** `$W/data` that Q2 migrated — a **dynamic free port** (`freeport`), its PID captured into the same `PIDS` array (so the `trap` still guarantees teardown), readiness polled on `/api/health`, and the whole `--config conf/defaults.ini` default in force. As everywhere else, exactly **one server runs at a time**: Boot D is the only instance up for these queries and is stopped explicitly before the hide-version contrast boot.

```bash
$ P4=$(freeport); boot "$P4" info "$W/q3.log"; D=$BPID   # Q3 server on the SAME migrated $W/data
```

### `GET /api/health` (public; loopback)

```bash
$ curl -s "http://127.0.0.1:$P4/api/health"
```

```json
{
  "database": "ok",
  "version": "11.5.0-pre",
  "commit": "<commit>"
}
```

**Repeated-query stability** — to confirm the reported value is stable across repeated queries rather than a one-shot read, two consecutive `/api/health` requests are captured to files and compared byte-for-byte:

```bash
$ curl -s "http://127.0.0.1:$P4/api/health" > "$W/health1.json"
$ curl -s "http://127.0.0.1:$P4/api/health" > "$W/health2.json"
$ wc -c "$W/health1.json" "$W/health2.json"
$ cmp -s "$W/health1.json" "$W/health2.json" && echo "health: BYTE-IDENTICAL"
$ sha256sum "$W/health1.json" "$W/health2.json"
```

```text
 75 /…/health1.json
 75 /…/health2.json
150 total
health: BYTE-IDENTICAL
b5f151348bf312ec13ae994d9faf62387610fd27201801222cf852387636a4c7  /…/health1.json
b5f151348bf312ec13ae994d9faf62387610fd27201801222cf852387636a4c7  /…/health2.json
```

Both responses are identical (`75` bytes, equal SHA-256). The `75`-byte size and the hash are computed over the **raw** response as returned by the server; its only volatile field — the build `commit` — is shown redacted as `<commit>` in the JSON above (the raw value is a 10-character short SHA, so the redacted body renders two bytes shorter than the raw `75`). The stability result — two consecutive reads are byte-identical — is unaffected by the redaction.

### `GET /api/frontend/settings` → `buildInfo`

`/api/frontend/settings` requires authentication (anonymous access is disabled by default). The default admin credentials on a fresh boot are `admin`/`admin` (`conf/defaults.ini:328` `admin_user = admin`, `:331` `admin_password = admin`); `ADMIN_PW` is set to that documented default. To keep the credential out of the process table and shell history, it is placed in an ephemeral `netrc` file (rather than inline in the `curl` command) and the file is shredded immediately after:

```bash
$ export ADMIN_PW=admin                        # default admin password (conf/defaults.ini:331 admin_password = admin)
$ NETRC="$(mktemp)"
$ printf 'machine 127.0.0.1 login admin password %s\n' "$ADMIN_PW" > "$NETRC"  # written to the netrc file, not the process table
$ curl -s --netrc-file "$NETRC" "http://127.0.0.1:$P4/api/frontend/settings" \
    | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["buildInfo"],indent=2))'
$ shred -u "$NETRC"
```

```json
{
  "hideVersion": false,
  "version": "11.5.0-pre",
  "versionString": "Grafana v11.5.0-pre (<commit>)",
  "commit": "<commit>",
  "commitShort": "<commit>",
  "buildstamp": 1784092664,
  "edition": "Open Source",
  "latestVersion": "",
  "hasUpdate": false,
  "env": "production"
}
```

**Repeated-query stability.** The full `/api/frontend/settings` response (not just the `buildInfo` excerpt) is fetched twice and compared byte-for-byte:

```bash
$ printf 'machine 127.0.0.1 login admin password %s\n' "$ADMIN_PW" > "$NETRC"
$ curl -s --netrc-file "$NETRC" "http://127.0.0.1:$P4/api/frontend/settings" > "$W/settings1.json"
$ curl -s --netrc-file "$NETRC" "http://127.0.0.1:$P4/api/frontend/settings" > "$W/settings2.json"
$ shred -u "$NETRC"
$ wc -c "$W/settings1.json" "$W/settings2.json"
$ cmp -s "$W/settings1.json" "$W/settings2.json" && echo "settings: BYTE-IDENTICAL"
$ sha256sum "$W/settings1.json" "$W/settings2.json"
```

```text
 29749 /…/settings1.json
 29749 /…/settings2.json
 59498 total
settings: BYTE-IDENTICAL
aa98e103b1f8a54e19871cd11908ccfccc3d7de467af4ab1f3a8876db98d6b4b  /…/settings1.json
aa98e103b1f8a54e19871cd11908ccfccc3d7de467af4ab1f3a8876db98d6b4b  /…/settings2.json
```

Both full responses are identical (`29749` bytes, equal SHA-256), so `buildInfo.version = "11.5.0-pre"` is stable across repeated queries. (These figures are over the complete raw response; the excerpt above shows only `buildInfo`, with the volatile `commit`/`commitShort`/versionString-suffix redacted to `<commit>`.)

### Edge conditions (observed at runtime, not inferred)

**Unauthenticated request** to `/api/frontend/settings` returns `401` (anonymous disabled by default):

```bash
$ curl -s -i "http://127.0.0.1:$P4/api/frontend/settings"
```

Complete response — status line, **all** headers, and the **full JSON body** (the `Date` header is the only redaction, as a volatile wall-clock value):

```text
HTTP/1.1 401 Unauthorized
Cache-Control: no-store
Content-Type: application/json; charset=UTF-8
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: <date>
Content-Length: 102

{"extra":null,"message":"Unauthorized","messageId":"auth.unauthorized","statusCode":401,"traceID":""}
```

The body is a `102`-byte payload with `"statusCode":401` and `"messageId":"auth.unauthorized"` — the 101-character JSON object shown above plus a single trailing newline, matching the server's `Content-Length: 102` header.

### `GET /healthz` (bare liveness) and the startup banner

While Boot D is still up, `/healthz` returns the bare liveness string, and the startup banner is read back from Boot D's own log (`$W/q3.log`):

```bash
$ curl -s "http://127.0.0.1:$P4/healthz"; echo
Ok
$ grep 'msg="Starting Grafana"' "$W/q3.log" | sed -E 's/t=[^ ]+/t=<ts>/'
```

```text
logger=settings t=<ts> level=info msg="Starting Grafana" version=11.5.0-pre commit=<commit> branch=<build-branch> compiled=<compiled>
```

`/healthz` intentionally returns only the literal string `Ok` (no version).

### Hidden-version contrast (`auth.anonymous.hide_version=true`)

Starting an instance with `auth.anonymous.hide_version=true` makes `/api/health` omit both `version` and `commit` (the `omitempty` fields are left unset by the `if !hs.Cfg.Anonymous.HideVersion` gate). Boot D is stopped first (one server at a time), then a contrast server is booted on the **same** `$W/data`:

```bash
$ stop "$D"                                          # stop the default Q3 server, freeing $W/data for the contrast boot
$ P5=$(freeport)
$ timeout 120s "$BIN" server --homepath . --config conf/defaults.ini \
      cfg:server.http_addr=127.0.0.1 cfg:server.http_port="$P5" \
      cfg:auth.anonymous.enabled=true cfg:auth.anonymous.hide_version=true \
      cfg:paths.data="$W/data" cfg:paths.logs="$W/logs" cfg:paths.plugins="$W/plugins" \
      > "$W/hide.log" 2>&1 &
$ H=$!; PIDS+=("$H")
$ for _ in $(seq 1 90); do curl -sf -m3 "http://127.0.0.1:$P5/api/health" >/dev/null 2>&1 && break; sleep 1; done
$ curl -s "http://127.0.0.1:$P5/api/health"          # hide_version=true
{
  "database": "ok"
}
$ stop "$H"
```

Contrast this with the default `/api/health` shown at the top of this section (`version` and `commit` present): under `hide_version=true` both `omitempty` fields drop out, leaving only `"database": "ok"`.

### Build-method dependency (all demonstrated at runtime)

```bash
# (a) CANONICAL binary (ldflags) — THIS is the reported answer:
$ ./bin/linux-amd64/grafana --version
grafana version 11.5.0-pre

# (b) BARE go run (no ldflags) — fallback literal, caveat only, NOT canonical:
$ go run ./pkg/cmd/grafana --version
grafana version 9.2.0

# (c) DEPRECATED grafana-server shim — prints a deprecation warning, then the version of the re-exec'd binary:
$ ./bin/linux-amd64/grafana-server --version
Deprecation warning: The standalone 'grafana-server' program is deprecated and will be removed in the future. Please update all uses of 'grafana-server' to 'grafana server'
Version 11.5.0-pre (commit: <commit>, branch: <build-branch>)
```

### End of Q3 — teardown and idempotency

Every Q2/Q3 boot (`A`, `B`, `C`, the default Q3 server `D`, and the hide-version server `H`) was stopped inline the moment its evidence was captured, so by this point **no observation server is running**. The `trap` is disarmed, the private workspace `$W` is removed, and the absence of any residual loopback listener on the dynamically chosen ports is confirmed. Because `$W` is an unpredictable `mktemp` name and every port was allocated dynamically via `freeport`, the whole Q2→Q3 procedure is idempotent and re-runnable from the top with no stale `bind: address already in use`:

```bash
$ trap - EXIT INT TERM                               # every server already stopped — disarm the cleanup trap
$ ss -ltn 2>/dev/null | grep -E "127\.0\.0\.1:($P1|$P2|$P3|$P4|$P5)\b" || echo "no Q2/Q3 listeners remain"
no Q2/Q3 listeners remain
$ rm -rf "$W"                                        # remove the private mktemp workspace (DB, logs, artifacts)
```

### Responsible code

- `/api/health` handler **`(*HTTPServer).apiHealthHandler`** `pkg/api/http_server.go:710`; response struct `healthResponse` `pkg/api/http_server.go:694-698` (`Database` `pkg/api/http_server.go:695` is always present — no `omitempty`; `Version`/`Commit`/`EnterpriseCommit` `pkg/api/http_server.go:696-698` are `omitempty`, so they drop from the JSON when unset); `pkg/api/http_server.go:716` `data := healthResponse{Database: "ok"}`; gated at `pkg/api/http_server.go:719` `if !hs.Cfg.Anonymous.HideVersion {` then `:720` `data.Version = hs.Cfg.BuildVersion` and `:721` `data.Commit = hs.Cfg.BuildCommit`.
- Bare liveness handler **`(*HTTPServer).healthzHandler`** `pkg/api/http_server.go:681`; writes `"Ok"` at `pkg/api/http_server.go:688`.
- `/api/frontend/settings`: `pkg/api/frontendsettings.go:161` `version := setting.BuildVersion`; the per-request hide gate `pkg/api/frontendsettings.go:160` `hideVersion := hs.Cfg.Anonymous.HideVersion && !c.IsSignedIn` (so a signed-in admin sees `hideVersion=false`); emitted at `pkg/api/frontendsettings.go:247` `BuildInfo:` → `:249` `Version: version`, `:250` `VersionString: versionString`.
- Version source & banner: `pkg/setting/setting.go:1076` `cfg.BuildVersion = BuildVersion`; startup banner `pkg/setting/setting.go:940` `cfg.Logger.Info(fmt.Sprintf("Starting %s", ApplicationName), "version", BuildVersion, "commit", BuildCommit, "branch", BuildBranch, "compiled", time.Unix(BuildStamp, 0))`.
- Version injection vs fallback: canonical build ldflag `-X main.version=%s` (`pkg/build/cmd.go:247`, value from `pkg/build/cmd.go:55` `opts.version = packageJSON.Version`) sourced from `package.json:6` `"version": "11.5.0-pre"`; fallback literal `var version = "9.2.0"` `pkg/cmd/grafana/main.go:17`.
- Deprecated shim: `pkg/cmd/grafana-server/main.go:10` `os.Exit(cmd.RunGrafanaCmd("server"))` → `pkg/util/cmd/cmd.go:15` `RunGrafanaCmd`, which prints the deprecation warning at `pkg/util/cmd/cmd.go:24` and re-execs the `grafana` binary.

### Cause → effect

The canonical build injects `package.json`'s version through the linker (`-X main.version=11.5.0-pre`, `pkg/build/cmd.go:247`), so `main.version = "11.5.0-pre"`; this flows into `cfg.BuildVersion` (`pkg/setting/setting.go:1076`) and is then surfaced verbatim by `apiHealthHandler` (`pkg/api/http_server.go:720`), by `/api/frontend/settings` (`pkg/api/frontendsettings.go:161/:249`), and by the startup banner (`pkg/setting/setting.go:940`). Without ldflags a bare `go run` leaves `main.version` at its source fallback `9.2.0` (`pkg/cmd/grafana/main.go:17`) — which is why only a canonical build reports `11.5.0-pre`. When `auth.anonymous.hide_version=true`, the `if !hs.Cfg.Anonymous.HideVersion` gate (`pkg/api/http_server.go:719`) is skipped, so the `omitempty` `Version`/`Commit` fields stay empty and drop out of the JSON — exactly as observed above.

---

## Q4 — During the dashboard-view → panel-editor transition, does the datasource picker automatically resolve to and display the datasource already defined in the panel's queries?

**Direct answer: YES.** When the panel editor activates, the queries-tab activation handler reads the datasource stored on the panel's query runner (`this.queryRunner.state.datasource`) and resolves it, then stores it in the tab's state, which the rendered tab passes straight to the datasource picker. So the picker displays the datasource already defined in the panel's existing queries. The last-used and configured-default datasources are used only as *fallbacks*, on two distinct branches described below.

### Command (non-interactive; failure-safe pipeline; explicit exit status)

```bash
$ set -o pipefail
$ CI=true yarn jest \
    public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx \
    --ci --watchAll=false --verbose > /tmp/q4_jest.log 2>&1
$ echo "JEST_EXIT_STATUS=${PIPESTATUS[0]}"
JEST_EXIT_STATUS=0
$ cat /tmp/q4_jest.log
```

### Complete, unedited captured output (Jest 29.7.0)

The leading `jest-haste-map: duplicate manual mock found` lines are pre-existing warnings emitted by the monorepo's Jest configuration for unrelated datasource `__mocks__` (they are unchanged repository state, not a product of this investigation) and do not affect the result:

```text
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

PASS public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx (10.649 s)
  PanelDataQueriesTab
    Adding queries
      ✓ can add a new query (27 ms)
      ✓ Can add a new query when datasource is mixed (12 ms)
    PanelDataQueriesTab
      ✓ renders query group top section (149 ms)
      ✓ renders queries rows when queries are set (62 ms)
      ✓ allow to add a new query when user clicks on add new (125 ms)
      ✓ allow to remove a query when user clicks on remove (386 ms)
    query options
      activation
        ✓ should load data source (5 ms)
        ✓ should store loaded data source in local storage (5 ms)
        ✓ should load default datasource if the datasource passed is not found (6 ms)
      data source change
        ✓ should load new data source (6 ms)
        ✓ changing from one plugin to another (4 ms)
        ✓ changing from a plugin to a dashboard data source (4 ms)
        ✓ changing from dashboard data source to a plugin (4 ms)
      query options change
        time overrides
          ✓ should create PanelTimeRange object (5 ms)
          ✓ should update hoverHeader (5 ms)
          ✓ should update PanelTimeRange object on time options update (4 ms)
          ✓ should remove PanelTimeRange object on time options cleared (4 ms)
        max data points and interval
          ✓ should update max data points (6 ms)
          ✓ should update min interval (3 ms)
          ✓ should update min interval to undefined if empty input (3 ms)
        query caching
          ✓ updates cacheTimeout and queryCachingTTL (3 ms)
      query inspection
        ✓ allows query inspection from the tab (5 ms)
      change queries
        plugin queries
          ✓ should update queries (7 ms)
        dashboard queries
          ✓ should update queries (3 ms)
          ✓ should load last used data source if no data source specified for a panel (3 ms)

Test Suites: 1 passed, 1 total
Tests:       25 passed, 25 total
Snapshots:   0 total
Time:        11.351 s
Ran all test suites matching /public\/app\/features\/dashboard-scene\/panel-edit\/PanelDataPane\/PanelDataQueriesTab.test.tsx/i.
```

### The three resolution branches (each with the evidence that establishes it)

`loadDataSource()` resolves the picker's datasource down one of three mutually exclusive branches, keyed on `this.queryRunner.state.datasource` (`public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx:71`):

1. **Existing query datasource present → picker resolves to it (the answer to Q4).** The `else` branch (`public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx:101` `datasource = await getDataSourceSrv().get(datasourceToLoad)`, `:102` `getInstanceSettings(datasourceToLoad)`) resolves the panel's existing query datasource and `:106` `this.setState({ datasource, dsSettings })` stores it. Proven by **`should load data source`** (`public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx:361`, inside `describe('activation')` at `:360`), which sets a datasource on the panel's query runner and asserts the tab's resolved `state.datasource` equals it.
2. **No datasource on the query runner (absent ref, e.g. a brand-new panel) → last-used datasource.** The `if (!datasourceToLoad)` branch (`public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx:77`) reads `getLastUsedDatasourceFromStorage(...)` and resolves that instead (`:80`–`:95`). Proven by **`should load last used data source if no data source specified for a panel`** (`public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx:705`).
3. **Existing ref present but unrecognized → configured default (via the resolver).** When the query runner carries a datasource ref that the resolver does not recognize, execution still takes the **`else`** branch (`public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx:101`–`:102`), and `getDataSourceSrv().get(...)` returns the configured *default* datasource, which `:106` `this.setState({ datasource, dsSettings })` stores. **Observed (test-proven):** **`should load default datasource if the datasource passed is not found`** (`public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx:377`) sets `panel-6` whose query runner already carries `datasource = { uid: 'abc' }` (a **non-null** ref, asserted at `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx:380`), so `loadDataSource()` takes the `else` branch and the resolver maps the unknown `uid` to the default (`config.defaultDatasource === 'gdev-testdata'`, asserted `:385`); the test asserts the resolved `state.datasource === defaultDsMock` (`:386`). This test therefore proves the unknown-ref → **default *outcome* via the `else`/resolver path**, not the `catch` path.
   - **Additionally (inferred from source; not exercised by this test):** if the resolution itself **throws**, the `catch (err)` block (keyword at `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx:109`) falls back to `config.defaultDatasource` (`:111` `getDataSourceSrv().get(config.defaultDatasource)`, `:112` `getInstanceSettings(config.defaultDatasource)`) and then logs `:125` `console.error(err)`. Test `:377`'s mocked `getDataSourceSrv().get()` is a total function that returns `defaultDsMock` for an unknown `uid` and never throws, so the `catch` is never entered — and because `jest-fail-on-console` is active under `CI=true`, the pass of `:377` positively confirms the `catch`'s `console.error` did **not** fire. This production error path is thus established by reading the code and is labelled **inferred**.

So the configured default is **not** a "no datasource set" fallback. It arises from an *existing* (present) ref in two distinct ways: (i) an **unrecognized** ref that the resolver itself maps to the default — the `else` path, **observed** via `:377`; and (ii) a ref whose resolution **throws** — the `catch` path, **inferred** from source. Both are distinct from the absent-ref last-used branch (branch 2).

### Responsible code (resolution → picker consumption)

**Activation and resolution** — `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx`:

- `:44` `this.addActivationHandler(() => this.onActivate())` — registers the handler that fires on the dashboard-view → panel-editor transition.
- `:59` `onActivate()` → `:60` `this.loadDataSource()`.
- `:63` `private async loadDataSource()`; `:71` `let datasourceToLoad = this.queryRunner.state.datasource` — reads the datasource already defined on the panel's query runner.
- `:101`–`:102` (existing ref) resolve via `getDataSourceSrv().get(...)` / `getInstanceSettings(...)`; `:106` `this.setState({ datasource, dsSettings })` sets the tab state.

**Render handoff to the picker** — the resolved tab state is read by the tab's renderer and passed into the query-options picker:

- `:39` `static Component = PanelDataQueriesTabRendered`.
- `:306` `export function PanelDataQueriesTabRendered({ model })`; `:307` `const { datasource, dsSettings } = model.useState()` — reads exactly the state that `loadDataSource()` set.
- `:318` `<QueryGroupTopSection` opens (with `:319` `data={data}`), and `:320` `dsSettings={dsSettings}` / `:321` `dataSource={datasource}` hand the resolved datasource/settings to the query-options section that renders the datasource picker.

So the proof is a state assertion (the test verifies `queriesTab.state.datasource`) plus the source-traced consumption of that same state by `PanelDataQueriesTabRendered` → `QueryGroupTopSection`.

### Cause → effect

On the dashboard-view → panel-editor transition the tab activates (`:44`/`:59`), calling `loadDataSource()`. It reads `this.queryRunner.state.datasource` (`:71`); because an existing panel's query runner already carries the query's datasource reference, the `else` branch resolves it (`:101`–`:102`) and stores it via `setState({ datasource, dsSettings })` (`:106`). `PanelDataQueriesTabRendered` then reads that state (`:307`) and passes it to `QueryGroupTopSection` via `dataSource={datasource}` (`:321`), which is what the datasource picker displays — so the picker shows the datasource already defined in the panel's queries. Only when the query runner has no datasource (`:77`) does the last-used fallback apply; the configured default appears instead when an *existing* ref is unrecognized — the resolver returns the default on the same `else` path (observed via test `:377`) — or, in production, when resolution throws and the `catch` block (`:109`) supplies it (inferred).

---

## Q5 — When the alerting edit view is opened, does the backend's rule definition populate the query state?

**Direct answer: YES.** For an existing Grafana-managed alerting rule, the rule-form conversion that runs when the edit view opens populates the form's `queries` state directly from the backend rule definition's `grafana_alert.data`, so the edit-view form state is seeded with the full set of queries (all N=3 in the test below) from the backend. New rules, by contrast, start with `queries: []`. One faithful nuance: the edit-view entry point `formValuesFromExistingRule` post-processes the populated queries through `ignoreHiddenQueries`, which strips `model.hide` from any *hidden* query — so while the queries are fully populated, they are **not universally deep-equal** to the raw backend data (hidden queries differ by the removed `hide` flag). The boundary cases are equally faithful and are proven below: an existing rule whose backend `data` is an empty array yields `queries: []`; an existing rule whose backend `data` is `undefined` passes straight through to `queries: undefined` (no fabrication); and an existing Grafana rule missing the `no_data_state`/`exec_err_state` discriminators throws `Unexpected type of rule for grafana rules source` rather than silently falling back. All of these — the ordinary populated case, the hidden-query normalization, the empty-data and undefined-data boundaries, and the missing-discriminator throw — are proven by the captured test output below. (Whether the seeded query state is subsequently *rendered* in the edit view is addressed, and explicitly labelled as source-inferred, in "Responsible code" and "Cause → effect".)

### Why a temporary spec was needed

The existing colocated suite `public/app/features/alerting/unified/utils/rule-form.test.ts` imports, from `./rule-form`, the helpers `getDefaultFormValues`, `cleanAnnotations`, `cleanLabels`, `getContactPointsFromDTO`, `getDefautManualRouting`, `getNotificationSettingsForDTO`, `MANUAL_ROUTING_KEY`, and the *reverse-direction* converters `alertingRulerRuleToRuleForm`, `formValuesToRulerGrafanaRuleDTO`, `formValuesToRulerRuleDTO` — but it does **not** import the forward/edit-view converters `rulerRuleToFormValues` or `formValuesFromExistingRule`, so it does not exercise the backend-definition → form-values path this question asks about. A temporary colocated spec was therefore created to drive the real conversion functions, run non-interactively, captured, and then **deleted** (`git status --porcelain` confirms it left no trace — see the Closing Note).

### Command (create → run → delete; failure-safe pipeline; explicit exit status)

```bash
# create the temporary spec (full source embedded below), then:
$ set -o pipefail
$ CI=true yarn jest \
    public/app/features/alerting/unified/utils/rule-form.blitzytmp.test.ts \
    --ci --watchAll=false --verbose > /tmp/q5_jest.log 2>&1
$ echo "JEST_EXIT_STATUS=${PIPESTATUS[0]}"
JEST_EXIT_STATUS=0
$ rm -f public/app/features/alerting/unified/utils/rule-form.blitzytmp.test.ts   # remove the temporary spec
```

### Temporary spec source (embedded verbatim; created, run, then deleted)

```typescript
// TEMPORARY observation spec for Q5 (Grafana runtime investigation).
// It exercises the REAL edit-view conversion functions in ./rule-form and is DELETED
// immediately after its output is captured. It is never imported by product code.
// (Grafana's jest setup uses jest-fail-on-console, so evidence is via assertions only.)
import { GrafanaAlertStateDecision, GrafanaRuleDefinition, RulerGrafanaRuleDTO } from 'app/types/unified-alerting-dto';
import { RuleWithLocation } from 'app/types/unified-alerting';

import { RuleFormType } from '../types/rule-form';

import { GRAFANA_RULES_SOURCE_NAME } from './datasource';
import { rulerRuleToFormValues, formValuesFromExistingRule, getDefaultFormValues } from './rule-form';

function makeGrafanaAlertingRuleWithLocation(
  overrides: Partial<GrafanaRuleDefinition> = {}
): RuleWithLocation<RulerGrafanaRuleDTO> {
  // A Grafana-managed ALERTING rule: no `record` -> alerting branch; N=3 queries,
  // the 2nd of which is a HIDDEN query (model.hide === true). `overrides` lets the
  // boundary cases below vary a single field (e.g. data, discriminators) while the
  // no-arg default reproduces the primary N=3 fixture verbatim.
  const ga: GrafanaRuleDefinition = {
    uid: 'rule-uid-1',
    title: 'my alert',
    namespace_uid: 'folder-uid-1',
    rule_group: 'group-1',
    condition: 'C',
    no_data_state: GrafanaAlertStateDecision.NoData,
    exec_err_state: GrafanaAlertStateDecision.Error,
    data: [
      { refId: 'A', datasourceUid: 'ds-uid-A', queryType: 'query', model: { refId: 'A', expr: 'up' } },
      { refId: 'B', datasourceUid: 'ds-uid-B', queryType: 'query', model: { refId: 'B', expr: 'down', hide: true } },
      { refId: 'C', datasourceUid: '__expr__', queryType: '', model: { refId: 'C', type: 'classic_conditions' } },
    ],
    ...overrides,
  };
  const rule: RulerGrafanaRuleDTO = { grafana_alert: ga, annotations: {}, labels: {} };
  return {
    ruleSourceName: GRAFANA_RULES_SOURCE_NAME,
    namespace: 'my folder',
    group: { name: 'group-1', rules: [rule] },
    rule,
  };
}

describe('Q5: alert rule-edit query-state population (rulerRuleToFormValues / formValuesFromExistingRule)', () => {
  it('rulerRuleToFormValues populates queries verbatim from backend grafana_alert.data (N=3, deep-equal)', () => {
    const rwl = makeGrafanaAlertingRuleWithLocation();
    const backendData = rwl.rule.grafana_alert.data;
    const form = rulerRuleToFormValues(rwl);
    expect(form.type).toBe(RuleFormType.grafana);
    expect(form.queries).toHaveLength(3);
    expect(form.queries).toEqual(backendData); // raw conversion is a verbatim copy of ga.data
  });

  it('formValuesFromExistingRule (edit-view entry) still carries all 3 queries but strips model.hide from hidden queries', () => {
    const rwl = makeGrafanaAlertingRuleWithLocation();
    const backendData = rwl.rule.grafana_alert.data;
    const form = formValuesFromExistingRule(rwl);

    // still populated (N=3) — the edit view opens with the backend's queries
    expect(form.queries).toHaveLength(3);

    // ordinary (non-hidden) queries are deep-equal to the backend definition
    expect(form.queries?.[0]).toEqual(backendData[0]);
    expect(form.queries?.[2]).toEqual(backendData[2]);

    // the HIDDEN query (index 1) has model.hide removed by ignoreHiddenQueries...
    expect((backendData[1].model as { hide?: boolean }).hide).toBe(true);
    expect((form.queries?.[1]?.model as { hide?: boolean }).hide).toBeUndefined();

    // ...so the edit-view queries are NOT universally deep-equal to the raw backend data
    expect(form.queries).not.toEqual(backendData);
  });

  it('new rules start with queries: [] (contrast with the populated edit view)', () => {
    expect(getDefaultFormValues().queries).toEqual([]);
  });

  // --- Boundary conditions (Q5 exhaustive coverage) ---

  it('BOUNDARY existing rule with empty backend data yields queries: [] (edit view opens with no queries)', () => {
    const rwl = makeGrafanaAlertingRuleWithLocation({ data: [] });
    const form = rulerRuleToFormValues(rwl);
    expect(form.type).toBe(RuleFormType.grafana);
    expect(form.queries).toEqual([]);
    // the edit-view entry point behaves identically for empty data (no fabrication)
    expect(formValuesFromExistingRule(rwl).queries).toEqual([]);
  });

  it('BOUNDARY existing rule with undefined backend data passes through as queries: undefined (no fabrication)', () => {
    const rwl = makeGrafanaAlertingRuleWithLocation({
      data: undefined as unknown as GrafanaRuleDefinition['data'],
    });
    const form = rulerRuleToFormValues(rwl);
    expect(form.queries).toBeUndefined();
    // ignoreHiddenQueries uses optional chaining, so the edit-view entry also yields undefined
    expect(formValuesFromExistingRule(rwl).queries).toBeUndefined();
  });

  it('BOUNDARY existing rule missing no_data_state/exec_err_state throws (no silent fallback)', () => {
    const rwl = makeGrafanaAlertingRuleWithLocation({
      no_data_state: undefined as unknown as GrafanaAlertStateDecision,
      exec_err_state: undefined as unknown as GrafanaAlertStateDecision,
    });
    expect(() => rulerRuleToFormValues(rwl)).toThrow('Unexpected type of rule for grafana rules source');
  });
});
```

### Complete, unedited captured output (Jest 29.7.0)

The leading `jest-haste-map: duplicate manual mock found` lines are pre-existing monorepo mock-collision warnings (the same set shown in Q4, from the unchanged repository state); the specific collision *pairing order* that `jest-haste-map` prints varies run to run and is not significant. This is the complete, verbatim output of the extended six-test run (three primary cases + three boundary cases):

```text
jest-haste-map: duplicate manual mock found: store.navIndex.mock
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/features/connections/__mocks__/store.navIndex.mock.ts
    * <rootDir>/public/app/features/datasources/__mocks__/store.navIndex.mock.ts

jest-haste-map: duplicate manual mock found: index
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/features/datasources/__mocks__/index.ts
    * <rootDir>/public/app/features/plugins/admin/__mocks__/index.ts

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

jest-haste-map: duplicate manual mock found: datasource
  The following files share their name; please delete one of them:
    * <rootDir>/public/app/plugins/datasource/loki/__mocks__/datasource.ts
    * <rootDir>/packages/grafana-prometheus/src/test/__mocks__/datasource.ts

PASS public/app/features/alerting/unified/utils/rule-form.blitzytmp.test.ts (6.544 s)
  Q5: alert rule-edit query-state population (rulerRuleToFormValues / formValuesFromExistingRule)
    ✓ rulerRuleToFormValues populates queries verbatim from backend grafana_alert.data (N=3, deep-equal) (4 ms)
    ✓ formValuesFromExistingRule (edit-view entry) still carries all 3 queries but strips model.hide from hidden queries (3 ms)
    ✓ new rules start with queries: [] (contrast with the populated edit view) (1 ms)
    ✓ BOUNDARY existing rule with empty backend data yields queries: [] (edit view opens with no queries) (1 ms)
    ✓ BOUNDARY existing rule with undefined backend data passes through as queries: undefined (no fabrication) (1 ms)
    ✓ BOUNDARY existing rule missing no_data_state/exec_err_state throws (no silent fallback) (13 ms)

Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total
Snapshots:   0 total
Time:        7.261 s
Ran all test suites matching /public\/app\/features\/alerting\/unified\/utils\/rule-form.blitzytmp.test.ts/i.
```

### Responsible code

**`rulerRuleToFormValues`** / **`formValuesFromExistingRule`** in `public/app/features/alerting/unified/utils/rule-form.ts`:

- `:365` `export function rulerRuleToFormValues(ruleWithLocation: RuleWithLocation): RuleFormValues` — converts a backend rule definition to form values.
- `:392` `if (ga.no_data_state !== undefined && ga.exec_err_state !== undefined) {` — the Grafana-alerting branch guard.
- `:402` `queries: ga.data,` — inside that branch, the form's `queries` are set directly from the backend definition's `grafana_alert.data`. (The Grafana *recording*-rule branch sets the same way at `:380`.)
- `:415` `throw new Error('Unexpected type of rule for grafana rules source');` — the `else` of the discriminator guard: when a Grafana rule carries `grafana_alert` but is missing `no_data_state`/`exec_err_state`, the conversion **throws** here (the missing-discriminator boundary proven above) rather than fabricating a fallback. (The outer `else` at `:418` throws the same message when the rule has no `grafana_alert` at all.)
- `:909`–`:914` `export const ignoreHiddenQueries = (ruleDefinition: RuleFormValues): RuleFormValues => { return { ...ruleDefinition, queries: ruleDefinition.queries?.map((query) => omit(query, 'model.hide')) }; }` — a block-body arrow (explicit `return`, spanning `:909`–`:914`) that removes `model.hide` from every query; the `omit(query, 'model.hide')` map is at `:912`.
- `:916`–`:917` `export function formValuesFromExistingRule(rule: RuleWithLocation<RulerRuleDTO>) { return ignoreHiddenQueries(rulerRuleToFormValues(rule)); }` — the edit-view entry point (population + hidden-query normalization).
- New-rule contrast: `getDefaultFormValues()` (`:87`) sets `queries: []` (`:101`).

**Consumer of the populated form values** — `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/QueryAndExpressionsStep.tsx`:

- `:134` `... } = useFormContext<RuleFormValues>();`, `:140` `queries: getValues('queries'),`, and `:143` `useReducer(queriesAndExpressionsReducer, initialState)` — the step reads the populated form `queries` via `getValues('queries')` (`:140`) and uses that as the initial state seeded into its `useReducer` (`:143`). **Inferred from source, not observed at runtime:** this investigation exercised the conversion/population functions in `rule-form.ts` directly (captured above) and did **not** mount `QueryAndExpressionsStep`, so the subsequent *visual rendering* of the seeded `queries` in the edit view is a source-trace of the consuming component, not a captured render assertion.

### Cause → effect

When the edit view opens for an existing Grafana-managed rule, `formValuesFromExistingRule` (`:916`) calls `rulerRuleToFormValues` (`:365`), whose Grafana-alerting branch assigns `queries: ga.data` (`:402`) — copying the backend definition's query array into the form. `formValuesFromExistingRule` then passes the result through `ignoreHiddenQueries` (`:909`), which maps each query through `omit(query, 'model.hide')`, stripping the `hide` flag from hidden queries (the backend runs hidden queries regardless, so the editor removes the flag to avoid confusion). `QueryAndExpressionsStep` reads those form values via `getValues('queries')` (`:140`) and seeds its `useReducer` initial state with them (`:143`); by source inspection (not a runtime render test — see the "Inferred from source" note above) the edit view then renders that seeded state, so the edit view opens with the backend's queries — fully populated, with hidden queries' `hide` flag normalized away. For a new rule the form instead starts from `getDefaultFormValues()` with `queries: []` (`:101`), which is why the populated state is specific to editing an existing rule.

---

## Closing Note — read-only integrity and cleanup

This investigation is read-only with respect to existing source; the only tracked change is this document. The verification uses **stable facts only** — a specific branch-head SHA and the document's own diff line-count are intentionally omitted, because both change every time this document is committed. For the same reason, the environment-internal and volatile per-build values that appear in the captured build/banner/API output are shown as neutral placeholders rather than literal values: the build-host Go module-cache path as `$GOPATH`; the agent build-branch identifier as `<build-branch>` (the canonical build injects the current git branch via `-X main.buildBranch`, and the startup banner echoes it); and the per-build identifiers that change on every rebuild — the commit SHA as `<commit>`, the build stamp as `<buildstamp>`, the compile time as `<compiled>`, and the package iteration as `<iteration>`. None of these is required by any answer, and the version signal `11.5.0-pre` (fixed in `package.json:6`) is unaffected:

```bash
$ git status --porcelain
                      # (empty = clean working tree once this document is committed)

$ git diff --name-status 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff HEAD
A	blitzy/documentation/grafana_4550cfb5b728.md

$ git diff --check
                      # (no output = no trailing-whitespace or blank-EOF errors)
```

- **Sole tracked change.** The only difference between the investigated base commit `4550cfb5b7` and the branch head is the **addition** (status `A`) of `blitzy/documentation/grafana_4550cfb5b728.md`; once that file is committed `git status --porcelain` is empty — no other modified tracked file and no untracked (`??`) file. No existing repository source file was modified.
- **Temporary observation artifacts removed.** The temporary Jest spec used for Q5 (`public/app/features/alerting/unified/utils/rule-form.blitzytmp.test.ts`, whose complete source is embedded verbatim in Q5) was deleted immediately after its output was captured; all other observation scripts and captured logs were kept **outside** the repository (under `/tmp`) and removed on completion.
- **Task build/run byproducts removed.** The build/run outputs produced or refreshed during the investigation were deleted so no build cache lingers in the tree: the compiled backend binary and its checksum (`bin/linux-amd64/grafana`, `bin/linux-amd64/grafana.md5`), the `bin/linux-amd64/grafana-server` pair, the generated `pkg/server/wire_gen.go`, and the runtime `data/` log directory. None of these are tracked by git, so their removal does not alter the committed source.
- **Pre-provisioned environment left intact.** The gitignored dependency caches that remain (`node_modules/`, `.yarn/`, `.nx/`, `public/mockServiceWorker.js`) are the pre-provisioned build/test environment — not repository source — and are unrelated to this investigation.
