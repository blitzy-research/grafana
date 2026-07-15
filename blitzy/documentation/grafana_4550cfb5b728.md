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

The canonical backend build (bounded with an explicit timeout, output captured in full). The scratch directory `/tmp/gfinv` — used here for the build log and later for every server-run log — is created first so all `>`/`tee` redirects below succeed in a fresh shell (it lives under `/tmp`, off the git tree):

```bash
$ mkdir -p /tmp/gfinv                                # scratch dir for build/run logs (off the git tree; created before first use)
$ timeout 900 make build-backend 2>&1 | tee /tmp/gfinv/build.log
build backend
go run build.go    build-backend
Version: 11.5.0, Linux Version: 11.5.0, Package Iteration: 1784062851pre
rm -r dist
rm -r tmp
rm -r /root/go/pkg/linux_amd64/github.com/grafana
building grafana ./pkg/cmd/grafana
rm -r ./bin/linux-amd64/grafana
rm -r ./bin/linux-amd64/grafana.md5
go build -ldflags -w -X main.version=11.5.0-pre -X main.commit=b23f15d49d -X main.buildstamp=1784060137 -X main.buildBranch=blitzy-bd7c52bb-ddb1-4334-9ff1-3439b97e50cf -o ./bin/linux-amd64/grafana ./pkg/cmd/grafana
go version
go version go1.23.1 linux/amd64
Targeting linux/amd64

real	0m14.264s
```

The build orchestrator (`pkg/build/cmd.go:247`) injects the version via ldflags. The observed injected values are therefore `main.version=11.5.0-pre` (from `package.json:6`), `main.commit=b23f15d49d`, and `main.buildstamp=1784060137` — the **actual** values captured from this build and reported throughout Q3. (`main.commit=b23f15d49d` is the commit that was `HEAD` when this binary was built — the documentation commit sitting directly atop scenes head `4550cfb5b7`; because no source file differs between them, the version string is identical for either commit.) Binary self-report:

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

```bash
set -o pipefail                              # (a) fail-fast in pipelines

run_observe() {                              # name port level seconds
  name=$1 port=$2 lvl=$3 secs=$4
  dir=$(mktemp -d)                           # (b) unpredictable, private temp dir
  mkdir -p /tmp/gfinv                        # (b') ensure the scratch log dir exists (idempotent)
  timeout "${secs}s" ./bin/linux-amd64/grafana server \
      --homepath . --config conf/defaults.ini \
      cfg:server.http_addr=127.0.0.1 \       # (c) loopback ONLY — never 0.0.0.0/[::]
      cfg:server.http_port="$port" \
      cfg:log.level="$lvl" \
      cfg:paths.data="$dir/data" \           # (d) redirect ALL writable paths off-tree
      cfg:paths.logs="$dir/logs" \
      cfg:paths.plugins="$dir/plugins" \
      > "/tmp/gfinv/$name.log" 2>&1 &         # capture stdout+stderr
  pid=$!                                      # (e) capture PID for a scoped stop
  # (f) readiness: poll the log for the listen line (no fixed sleep)
  for _ in $(seq 1 60); do
    grep -q "HTTP Server Listen" "/tmp/gfinv/$name.log" && break
    sleep 1
  done
  echo "$name pid=$pid port=$port"
}
# stop is always scoped to the captured PID, then reaped:
#   kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
```

Notes on the guarantees: the Q1 observation helpers (`run_observe`/`launch`) wrap the server in an explicit `timeout`, so those runs are **self-terminating** and cannot leak even if a `kill` is missed or the shell is interrupted; the Q2/Q3 boots below are **not** `timeout`-wrapped (one instance must stay up across Q2→Q3), so they instead capture each server's PID, register an `EXIT`/`INT`/`TERM` cleanup `trap`, and stop it with `kill`/`wait` once its evidence is captured — the `trap` guarantees no server is leaked even on interrupt. In all cases `http_addr=127.0.0.1` keeps the instance off all public interfaces; redirecting `paths.{data,logs,plugins}` into a `mktemp -d` directory prevents the server from writing `data/` into the repository; readiness is derived from the server's own `"HTTP Server Listen"` log line (or a `/api/health` poll) rather than a blind `sleep`; and every stop targets **only** the captured PID(s) (never a broad `pkill`). All curls in Q3 likewise target `127.0.0.1`.

---

## Q1 — Recurring log entries on an idle server (≥60s, zero user requests)

**Direct answer.** At Grafana's **default log level (`level = info`, `conf/defaults.ini:1074`)**, a server left idle with **zero HTTP requests emits _no_ recurring log entries during the first 60 seconds** of steady-state operation. The recurring INFO-level activity that does exist is **coarse-grained**: two emitters recur on a **10-minute** cadence (`plugins.update.checker` and `cleanup`), and a third (`grafana.update.checker`) recurs only every **24 hours**. The frequent sub-minute recurrence (a 10-second alert-scheduler tick and a family of 60-second synchronizers) exists but logs **only at `level = debug`**, so it is invisible at the default level. The complete enumeration below lists **every** recurring emitter, its interval, its log level, the exact emit line, the timer that drives it, and the default-setting that fixes its interval — each backed by captured runtime output.

### Methodology for Q1

Four canonical background runs were launched simultaneously (loopback-only, timeout-bounded, per-run temp dirs so the git tree is untouched). Two ran at `level=info` for ~12 minutes (to cross the 10-minute boundary and prove the 10-minute recurrence twice), and two ran at `level=debug` for ~3.5 minutes (to surface the sub-minute set twice for cross-run stability):

```bash
# launched from the repository root after `make gen-go && make build-backend`
launch() {                       # name port level seconds
  name=$1 port=$2 lvl=$3 secs=$4
  dir=$(mktemp -d)
  mkdir -p /tmp/gfinv            # ensure the scratch log dir exists (idempotent)
  timeout ${secs}s ./bin/linux-amd64/grafana server \
    --homepath . --config conf/defaults.ini \
    cfg:server.http_addr=127.0.0.1 cfg:server.http_port=$port \
    cfg:log.level=$lvl \
    cfg:paths.data=$dir/data cfg:paths.logs=$dir/logs cfg:paths.plugins=$dir/plugins \
    > /tmp/gfinv/$name.log 2>&1 &
}
launch run_long  3101 info  720   # ends ~+12min
launch run_long2 3104 info  720
launch run3      3102 debug 210   # ends ~+3.5min
launch run3b     3103 debug 210
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
# select INFO lines timestamped within [21:04:17, 21:05:17]
grep 'level=info' /tmp/gfinv/run_long.log \
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
grep 'logger=provisioning.dashboard' /tmp/gfinv/run3.log | sed -E 's/t=[^ ]+/t=<ts>/' | sort -u
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
- **Recurring INFO emitters:** `plugins.update.checker` (10 min), `cleanup` (10 min), `grafana.update.checker` (24 h) — all observed (10-min pair observed to recur twice; 24-h fire observed once at startup).
- **Recurring DEBUG emitters (hidden at default level) — ten in total:** `ngalert.scheduler` (`Alert rules fetched`, 10 s); and at 60 s: `secrets` (paired enter/finish), `ssosettings.service` (`reloading SSO Settings…` once per cycle **plus** a per-provider `No SSO Settings found…` burst), `ngalert.multiorg.alertmanager` (paired `Synchronizing…`/`Done synchronizing…`), `ngalert.notifier.alertmanager` `org=1` (`Config hasn't changed…`), and `ngalert.sender.router` (paired `Attempting…`/`Finish of admin configuration sync`) — all observed identically across debug runs.
- **Provisioner:** no recurrence in default config (observed; zero providers → zero readers → no ticker).
- **Long-interval/silent services:** token cleanup (1 h), anon cleanup (2 h), remote-cache GC (10 min, silent), grafana update-check recurrence (24 h) — intervals inferred from source, not observed to recur.

---

## Q2 — Capture the specific startup output that confirms the database schema version is up to date

**Direct answer: The confirming evidence is the SQL-store migrator's INFO pair `msg="Starting DB migrations"` followed by `msg="migrations completed"` carrying the `performed`, `skipped`, and `duration` fields. On a database that is already fully migrated, that second line reads `performed=0` — the runtime proof that the schema is up to date.** A default Grafana boot runs **two** independent migrators, each of which prints its own `Starting DB migrations` → `migrations completed` pair: the main store migrator (`logger=migrator`) and the unified-storage resource migrator (`logger=resource-migrator`). Both boot states are shown below (first boot performs the migrations; second boot of the same database performs none), and the per-migration skip counts are reconciled exactly against the terminal `skipped=` counters.

### First boot (fresh SQLite database) — migrations are performed

Every observation instance is bound to loopback, given writable `paths.*` under a private `mktemp -d` directory, launched in the background with its PID captured (and registered with a single `EXIT`/`INT`/`TERM` cleanup `trap` — installed once at the first boot below — so an interrupt or early exit leaks no server), and polled for readiness on `/api/health`. Each instance is stopped with `kill`/`wait` as soon as its evidence is captured; the **one** exception is the port-3000 first-boot instance, which is intentionally kept running so Q3 can query the same live server, and is then stopped explicitly at the end of Q3. Because every server is torn down, the whole Q2→Q3 procedure is **idempotent** — it can be re-run from the top without hitting a stale `bind: address already in use`. Nothing hangs and nothing listens beyond `127.0.0.1`.

```bash
$ REPO="$(pwd)"; BIN="$REPO/bin/linux-amd64/grafana"
$ PIDS=()                                            # accumulate every background server PID for guaranteed teardown
$ cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; }
$ trap cleanup EXIT INT TERM                         # safety net: an interrupt or early exit leaks no server (F5/F6)
$ d="$(mktemp -d)"                                   # private writable paths; tracked tree untouched
$ "$BIN" server --homepath "$REPO" \
      cfg:server.http_addr=127.0.0.1 cfg:server.http_port=3000 \
      cfg:paths.data="$d/data" cfg:paths.logs="$d/logs" cfg:paths.plugins="$d/plugins" \
      > /tmp/run1.log 2>&1 &
$ PID=$!; PIDS+=("$PID")                             # port-3000 instance — kept up for Q3, stopped at the end of Q3
$ for i in $(seq 1 120); do curl -sf -m3 http://127.0.0.1:3000/api/health >/dev/null && break; sleep 1; done
$ grep -nE 'msg="Starting DB migrations"|msg="migrations completed"' /tmp/run1.log
```

> This port-3000 instance is intentionally **left running** — Q3 queries this same live server. It is stopped explicitly at the end of Q3 ("Stop the shared instances," below); until then the `trap` above guarantees it is reaped even if the shell is interrupted.

Complete, unedited result (timestamps are the container wall clock; nothing else is altered):

```text
21:logger=migrator t=2026-07-14T21:04:27.479130944Z level=info msg="Starting DB migrations"
1274:logger=migrator t=2026-07-14T21:04:29.644016332Z level=info msg="migrations completed" performed=626 skipped=0 duration=2.16466157s
1287:logger=resource-migrator t=2026-07-14T21:04:29.814867154Z level=info msg="Starting DB migrations"
1324:logger=resource-migrator t=2026-07-14T21:04:29.892366092Z level=info msg="migrations completed" performed=18 skipped=0 duration=77.409834ms
```

On a fresh database the two migrators perform **626** (`migrator`) and **18** (`resource-migrator`) migrations respectively, each with `skipped=0`.

### Second boot (same database) — schema already up to date, `performed=0`

```bash
$ rm -rf /tmp/db2 /tmp/logs2 /tmp/plugins2           # idempotent: clear any prior copy so cp -a does not nest /tmp/db2/data
$ cp -a "$d/data" /tmp/db2                            # snapshot the now-migrated DB (server idle -> quiescent)
$ "$BIN" server --homepath "$REPO" \
      cfg:server.http_addr=127.0.0.1 cfg:server.http_port=3005 \
      cfg:paths.data=/tmp/db2 cfg:paths.logs=/tmp/logs2 cfg:paths.plugins=/tmp/plugins2 \
      > /tmp/run2.log 2>&1 &
$ PID2=$!; PIDS+=("$PID2")
$ for i in $(seq 1 60); do curl -sf -m3 http://127.0.0.1:3005/api/health >/dev/null && break; sleep 1; done
$ grep -nE 'msg="Starting DB migrations"|msg="migrations completed"' /tmp/run2.log
$ kill "$PID2"; wait "$PID2" 2>/dev/null              # stop the port-3005 instance now its evidence is captured
```

```text
20:logger=migrator t=2026-07-14T21:05:17.330526624Z level=info msg="Starting DB migrations"
21:logger=migrator t=2026-07-14T21:05:17.338884789Z level=info msg="migrations completed" performed=0 skipped=626 duration=864.821µs
32:logger=resource-migrator t=2026-07-14T21:05:17.564226964Z level=info msg="Starting DB migrations"
33:logger=resource-migrator t=2026-07-14T21:05:17.564626876Z level=info msg="migrations completed" performed=0 skipped=18 duration=38.14µs
```

**`performed=0` on both migrators is the "schema is up to date" confirmation**: all 626 + 18 known migrations were recognized as already applied and none were re-executed.

### Per-migration skip evidence (Debug) — reconciling the skip counters exactly

At the default `level=info` the individual skips are not printed. Booting the already-migrated database at `level=debug` surfaces one `Skipping migration: Already executed` line per already-applied migration. Counting them **per migrator** reconciles them one-for-one with the `skipped=` counters above (626 + 18 = 644):

```bash
$ "$BIN" server --homepath "$REPO" \
      cfg:server.http_addr=127.0.0.1 cfg:server.http_port=3006 cfg:log.level=debug \
      cfg:paths.data=/tmp/db2 cfg:paths.logs=/tmp/logs2 cfg:paths.plugins=/tmp/plugins2 \
      > /tmp/run2_debug.log 2>&1 &
$ PID3=$!; PIDS+=("$PID3")
$ for i in $(seq 1 60); do curl -sf -m3 http://127.0.0.1:3006/api/health >/dev/null && break; sleep 1; done
$ echo "migrator=$(grep 'logger=migrator '          /tmp/run2_debug.log | grep -c 'Skipping migration: Already executed')"
$ echo "resource=$(grep 'logger=resource-migrator ' /tmp/run2_debug.log | grep -c 'Skipping migration: Already executed')"
$ echo "total=$(grep -c 'Skipping migration: Already executed' /tmp/run2_debug.log)"
$ kill "$PID3"; wait "$PID3" 2>/dev/null
```

```text
migrator=626
resource=18
total=644
```

So the `644` per-migration skip lines are exactly `626` (from `logger=migrator`) + `18` (from `logger=resource-migrator`), matching the two `skipped=` counters. First three skip lines of the main migrator (verbatim):

```text
logger=migrator t=2026-07-14T21:05:33.549818539Z level=debug msg="Skipping migration: Already executed" id="create migration_log table"
logger=migrator t=2026-07-14T21:05:33.549861665Z level=debug msg="Skipping migration: Already executed" id="create user table"
logger=migrator t=2026-07-14T21:05:33.549867299Z level=debug msg="Skipping migration: Already executed" id="add unique index user.login"
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

**Direct answer: the running canonical instance reports the version string `11.5.0-pre`.** The exact value is returned identically by `GET /api/health` (`"version": "11.5.0-pre"`), by `GET /api/frontend/settings` (`buildInfo.version = "11.5.0-pre"`, `versionString = "Grafana v11.5.0-pre (b23f15d49d)"`), and by the startup banner (`version=11.5.0-pre`). The value is **build-method dependent**: the canonical build (`make build-backend`, ldflag `-X main.version=11.5.0-pre`) yields `11.5.0-pre`; a bare `go run ./pkg/cmd/grafana` (no ldflags) yields the fallback literal `9.2.0`. The canonical `11.5.0-pre` is the reported answer.

> Build provenance: the canonical binary was built with the documentation commit `b23f15d49d` as `HEAD` — the commit layered directly on top of the investigated source head `4550cfb5b7` (“Upgrade scenes to v5.32.0”); no source file differs between them (see the Closing Note). Consequently the build injected `main.commit=b23f15d49d`, and the API/banner reported `commit=b23f15d49d`. The **version string** — the subject of this question — is sourced from `package.json` and is `11.5.0-pre` regardless of which of the two commits is checked out.

### `GET /api/health` (public; loopback)

```bash
$ curl -s http://127.0.0.1:3000/api/health
```

```json
{
  "database": "ok",
  "version": "11.5.0-pre",
  "commit": "b23f15d49d"
}
```

### `GET /api/frontend/settings` → `buildInfo`

`/api/frontend/settings` requires authentication (anonymous access is disabled by default). The default admin credentials on a fresh boot are `admin`/`admin` (`conf/defaults.ini:328` `admin_user = admin`, `:331` `admin_password = admin`); `ADMIN_PW` is set to that documented default. To keep the credential out of the process table and shell history, it is placed in an ephemeral `netrc` file (rather than inline in the `curl` command) and the file is shredded immediately after:

```bash
$ export ADMIN_PW=admin                        # default admin password (conf/defaults.ini:331 admin_password = admin)
$ NETRC="$(mktemp)"
$ printf 'machine 127.0.0.1 login admin password %s\n' "$ADMIN_PW" > "$NETRC"  # written to the netrc file, not the process table
$ curl -s --netrc-file "$NETRC" http://127.0.0.1:3000/api/frontend/settings \
    | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["buildInfo"],indent=2))'
$ shred -u "$NETRC"
```

```json
{
  "hideVersion": false,
  "version": "11.5.0-pre",
  "versionString": "Grafana v11.5.0-pre (b23f15d49d)",
  "commit": "b23f15d49d",
  "commitShort": "b23f15d49d",
  "buildstamp": 1784060137,
  "edition": "Open Source",
  "latestVersion": "",
  "hasUpdate": false,
  "env": "production"
}
```

### Edge conditions (observed at runtime, not inferred)

**Unauthenticated request** to `/api/frontend/settings` returns `401` (anonymous disabled by default):

```bash
$ curl -s -i http://127.0.0.1:3000/api/frontend/settings | sed -n '1,6p'
```

```text
HTTP/1.1 401 Unauthorized
Cache-Control: no-store
Content-Type: application/json; charset=UTF-8
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
```

**Hidden-version** case: starting an instance with `auth.anonymous.hide_version=true` makes `/api/health` omit both `version` and `commit` (the `omitempty` fields are left unset by the `if !hs.Cfg.Anonymous.HideVersion` gate). Observed directly:

```bash
$ "$BIN" server --homepath "$REPO" cfg:server.http_addr=127.0.0.1 cfg:server.http_port=3007 \
      cfg:auth.anonymous.enabled=true cfg:auth.anonymous.hide_version=true \
      cfg:paths.data="$d/data" cfg:paths.logs="$d/logs" cfg:paths.plugins="$d/plugins" > /tmp/run_hide.log 2>&1 &
$ PID4=$!; PIDS+=("$PID4")                           # hide_version instance — registered for teardown; stopped at end of Q3
$ for i in $(seq 1 60); do curl -sf -m3 http://127.0.0.1:3007/api/health >/dev/null && break; sleep 1; done  # readiness
$ curl -s http://127.0.0.1:3007/api/health          # hide_version=true
{
  "database": "ok"
}
$ curl -s http://127.0.0.1:3000/api/health          # default (hide_version=false) — contrast
{
  "database": "ok",
  "version": "11.5.0-pre",
  "commit": "b23f15d49d"
}
```

### `GET /healthz` (bare liveness) and the startup banner

```bash
$ curl -s http://127.0.0.1:3000/healthz
Ok
$ grep 'msg="Starting Grafana"' /tmp/run1.log
```

```text
logger=settings t=2026-07-14T21:04:27.477055456Z level=info msg="Starting Grafana" version=11.5.0-pre commit=b23f15d49d branch=blitzy-bd7c52bb-ddb1-4334-9ff1-3439b97e50cf compiled=2026-07-14T20:15:37Z
```

`/healthz` intentionally returns only the literal string `Ok` (no version).

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
Version 11.5.0-pre (commit: b23f15d49d, branch: blitzy-bd7c52bb-ddb1-4334-9ff1-3439b97e50cf)
```

### Stop the shared instances (end of Q3)

All Q3 queries are complete, so the two instances still running from earlier — the port-3000 first-boot server started in Q2 and the port-3007 hide_version server — are stopped explicitly now. After this, no observation server is left running and the entire Q2→Q3 sequence can be re-run from the top without a stale `bind: address already in use`:

```bash
$ kill "$PID4" 2>/dev/null; wait "$PID4" 2>/dev/null   # stop the hide_version instance (port 3007)
$ kill "$PID"  2>/dev/null; wait "$PID"  2>/dev/null   # stop the shared first-boot instance (port 3000)
$ trap - EXIT INT TERM                                 # every server is stopped — disarm the cleanup trap
$ ss -ltn 2>/dev/null | grep -E ':3000|:3005|:3006|:3007' || echo "no Q2/Q3 listeners remain"
no Q2/Q3 listeners remain
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

**Direct answer: YES.** For an existing Grafana-managed alerting rule, the rule-form conversion populates the form's `queries` state directly from the backend rule definition's `grafana_alert.data`, so opening the edit view carries the full set of queries (all N=3 in the test below) from the backend. New rules, by contrast, start with `queries: []`. One faithful nuance: the edit-view entry point `formValuesFromExistingRule` post-processes the populated queries through `ignoreHiddenQueries`, which strips `model.hide` from any *hidden* query — so while the queries are fully populated, they are **not universally deep-equal** to the raw backend data (hidden queries differ by the removed `hide` flag). Both the ordinary and the hidden-query cases are proven below.

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

function makeGrafanaAlertingRuleWithLocation(): RuleWithLocation<RulerGrafanaRuleDTO> {
  // A Grafana-managed ALERTING rule: no `record` -> alerting branch; N=3 queries,
  // the 2nd of which is a HIDDEN query (model.hide === true).
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
});
```

### Complete, unedited captured output (Jest 29.7.0)

The leading `jest-haste-map` warnings are the same pre-existing monorepo mock warnings shown in Q4 (unchanged repository state):

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
    * <rootDir>/packages/grafana-prometheus/src/test/__mocks__/datasource.ts
    * <rootDir>/public/app/plugins/datasource/azuremonitor/__mocks__/datasource.ts

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

PASS public/app/features/alerting/unified/utils/rule-form.blitzytmp.test.ts (14.575 s)
  Q5: alert rule-edit query-state population (rulerRuleToFormValues / formValuesFromExistingRule)
    ✓ rulerRuleToFormValues populates queries verbatim from backend grafana_alert.data (N=3, deep-equal) (3 ms)
    ✓ formValuesFromExistingRule (edit-view entry) still carries all 3 queries but strips model.hide from hidden queries (3 ms)
    ✓ new rules start with queries: [] (contrast with the populated edit view) (1 ms)

Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
Snapshots:   0 total
Time:        16.121 s
Ran all test suites matching /public\/app\/features\/alerting\/unified\/utils\/rule-form.blitzytmp.test.ts/i.
```

### Responsible code

**`rulerRuleToFormValues`** / **`formValuesFromExistingRule`** in `public/app/features/alerting/unified/utils/rule-form.ts`:

- `:365` `export function rulerRuleToFormValues(ruleWithLocation: RuleWithLocation): RuleFormValues` — converts a backend rule definition to form values.
- `:392` `if (ga.no_data_state !== undefined && ga.exec_err_state !== undefined) {` — the Grafana-alerting branch guard.
- `:402` `queries: ga.data,` — inside that branch, the form's `queries` are set directly from the backend definition's `grafana_alert.data`. (The Grafana *recording*-rule branch sets the same way at `:380`.)
- `:909`–`:914` `export const ignoreHiddenQueries = (ruleDefinition: RuleFormValues): RuleFormValues => { return { ...ruleDefinition, queries: ruleDefinition.queries?.map((query) => omit(query, 'model.hide')) }; }` — a block-body arrow (explicit `return`, spanning `:909`–`:914`) that removes `model.hide` from every query; the `omit(query, 'model.hide')` map is at `:912`.
- `:916`–`:917` `export function formValuesFromExistingRule(rule: RuleWithLocation<RulerRuleDTO>) { return ignoreHiddenQueries(rulerRuleToFormValues(rule)); }` — the edit-view entry point (population + hidden-query normalization).
- New-rule contrast: `getDefaultFormValues()` (`:87`) sets `queries: []` (`:101`).

**Consumer of the populated form values** — `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/QueryAndExpressionsStep.tsx`:

- `:134` `... } = useFormContext<RuleFormValues>();` and `:140` `queries: getValues('queries'),` — the step seeds its initial reducer state from the populated form `queries`, then `:143` `useReducer(queriesAndExpressionsReducer, initialState)` renders them.

### Cause → effect

When the edit view opens for an existing Grafana-managed rule, `formValuesFromExistingRule` (`:916`) calls `rulerRuleToFormValues` (`:365`), whose Grafana-alerting branch assigns `queries: ga.data` (`:402`) — copying the backend definition's query array into the form. `formValuesFromExistingRule` then passes the result through `ignoreHiddenQueries` (`:909`), which maps each query through `omit(query, 'model.hide')`, stripping the `hide` flag from hidden queries (the backend runs hidden queries regardless, so the editor removes the flag to avoid confusion). `QueryAndExpressionsStep` seeds its reducer from `getValues('queries')` (`:140`) and renders them, so the edit view shows the backend's queries — fully populated, with hidden queries' `hide` flag normalized away. For a new rule the form instead starts from `getDefaultFormValues()` with `queries: []` (`:101`), which is why the populated state is specific to editing an existing rule.

---

## Closing Note — read-only integrity and cleanup

This investigation is read-only with respect to existing source; the only tracked change is this document. The verification uses **stable facts only** — a specific branch-head SHA and the document's own diff line-count are intentionally omitted, because both change every time this document is committed:

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
