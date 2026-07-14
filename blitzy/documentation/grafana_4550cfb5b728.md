# Grafana Runtime Investigation — grafana_4550cfb5b728

This document answers five questions about Grafana's runtime behavior at head commit
**`4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`** ("Upgrade scenes to v5.32.0 (#97944)").

It is a **run‑first, evidence‑grounded** investigation: for every behavioral claim the
document shows the exact command that produced it and the **actual captured output**
(logs, HTTP responses, Jest results), then names the responsible code by `file:line`
with a cause → effect explanation. Nothing here is written from reading code alone; each
answer was produced by **building, running, and observing** Grafana (Q1–Q3) or by
**executing Jest** (Q4–Q5). This investigation is strictly read‑only: no repository file
was modified, and every temporary observation script was removed on completion (verified
in the Closing Note).

---

## Methodology

### Commit under investigation

```bash
$ git rev-parse HEAD
4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff
```

### Backend build (canonical) — foundation for Q1–Q3

The canonical Grafana build is driven by `make` → `go run build.go <target>`
(`Makefile:196` `build-backend`, `Makefile:187` `build-go`, `Makefile:201` `build-server`).
The build injects the version from `package.json:6` (`"version": "11.5.0-pre"`) into the
binary via the ldflag `-X main.version` (`pkg/build/cmd.go:55` `opts.version = packageJSON.Version`,
`pkg/build/cmd.go:247` `" -X main.version=%s"`).

Build command used (Go 1.23.1, `go.mod:3`):

```bash
$ make build-backend            # -> go run build.go build-backend -> builds ./bin/linux-amd64/grafana
# tail of /tmp/build.log (verbatim ldflags line):
go build -ldflags -w -X main.version=11.5.0-pre -X main.commit=4550cfb5b7 \
  -X main.buildstamp=1734099722 -X main.buildBranch=blitzy-bd7c52bb-ddb1-4334-9ff1-3439b97e50cf \
  -o ./bin/linux-amd64/grafana ./pkg/cmd/grafana
$ ./bin/linux-amd64/grafana --version
grafana version 11.5.0-pre
```

`make build-backend` builds the **real** entry point `./pkg/cmd/grafana`
(`pkg/cmd/grafana/main.go`) — the binary that carries the ldflag‑injected `main.version`
and actually serves. (The sibling `grafana-server` binary built by `make build-server` is
a deprecated shim — see Q3.)

### Backend run (canonical, default config)

The server was run with the canonical binary against the **unmodified** `conf/defaults.ini`
(`app_mode = production` `conf/defaults.ini:7`, `http_port = 3000` `:41`,
`[log] mode = console file` `:1071`, `level = info` `:1074`). To keep the repository tree
byte‑for‑byte clean, only the writable `paths.*` were redirected to `/tmp` via CLI overrides
(this does not affect any answer). The canonical run command:

```bash
$ ./bin/linux-amd64/grafana server --homepath "$(pwd)" \
    cfg:paths.data=/tmp/gf-data1 cfg:paths.logs=/tmp/gf-logs1 cfg:paths.plugins=/tmp/gf-plugins1
```

Multiple observation runs were used (all with the same canonical binary + unmodified
`conf/defaults.ini`; only `paths.*`, and where noted `server.http_port` / `log.level`,
were overridden on the CLI — never in the tracked file):

| Run | Purpose | Level | Port | Notes |
|-----|---------|-------|------|-------|
| run1 | Q3 curls, Q2 first boot, banner | info | 3000 | fresh DB `/tmp/gf-data1` |
| run2 | Q2 second boot (same DB) | info | 3000 | reuses `/tmp/gf-data1` |
| run2_debug | Q2 debug per‑migration skips | debug | 3000 | reuses `/tmp/gf-data1` |
| run3 / run3b | Q1 sub‑minute recurring set (2 runs) | debug | 3002 / 3003 | `cfg:log.level=debug` |
| run_long / run_long2 | Q1 10‑minute recurring INFO (2 runs) | info | 3001 / 3004 | extended ≥13 min |

### Frontend tests (Q4–Q5)

Jest was run **non‑interactively** (never the watch‑mode `"test"` script at `package.json:26`),
with Node.js v22 and Yarn Berry 4.5.3, jest 29.7.0 (`jest.config.js`):

```bash
$ CI=true yarn jest <file> --ci --watchAll=false --verbose
```

### Redaction & stability conventions

- **Redaction:** volatile values are replaced with `<REDACTED>`. Full log timestamps are
  shown as `t=<REDACTED>` **except** in Q1, where — to demonstrate recurrence intervals —
  the wall‑clock time `t=HH:MM:SS` is preserved (only the date is omitted); `duration=…`
  values are always redacted.
- **Stability:** all timing/recurring results were confirmed **stable across ≥2 identical
  runs** (Q1 across run3/run3b and run_long/run_long2; Q2 across the two boots).

---

## Q1 — After the server has run ≥60 seconds idle with zero user requests, what are the exact recurring log entries?

**Direct answer: At the default log `level = info` (`conf/defaults.ini:1074`), a ≥60‑second idle window contains NO recurring log entries — the recurring‑INFO set within 60 s is EMPTY.** Every INFO line printed during the first 60 s is a **one‑time** startup/initialization message that never repeats. The reason is that every sub‑minute background ticker logs at **Debug** (suppressed at `level=info`), and the lowest‑frequency **INFO** recurring emitters do not fire until the **10‑minute** mark. The complete recurring set is therefore only observable by (a) extending the run to ≥10 minutes at `level=info`, and/or (b) re‑running at `level=debug`. All variants are enumerated below and each is correlated to its emitting ticker.

### (a) 60‑second idle window at the default `level=info` — sparse/empty

```bash
# pristine idle instance (zero HTTP requests), default level=info:
$ ./bin/linux-amd64/grafana server --homepath "$(pwd)" cfg:server.http_port=3001 \
    cfg:paths.data=/tmp/gf-datalong cfg:paths.logs=/tmp/gf-logslong cfg:paths.plugins=/tmp/gf-pluginslong \
    > /tmp/run_long.log 2>&1 &
# server became ready ("HTTP Server Listen") at t=19:39:50; window examined = 19:39:50 -> 19:40:50
```

The INFO lines emitted around and after the listen event are all **one‑time startup**
messages (they appear once and are never repeated). Representative excerpt (verbatim,
`t` date omitted):

```text
logger=ngalert.state.manager t=19:39:5x level=info msg="State cache has been initialized" states=0 duration=<REDACTED>
logger=ngalert.scheduler     t=19:39:5x level=info msg="Starting scheduler" tickInterval=10s maxAttempts=3
logger=ticker                t=19:39:5x level=info msg=starting first_tick=2026-07-14T19:40:00Z
logger=http.server           t=19:39:50 level=info msg="HTTP Server Listen" address=[::]:3001 protocol=http subUrl= socket=
logger=plugins.update.checker t=19:39:50 level=info msg="Update check succeeded" duration=<REDACTED>
logger=grafana.update.checker t=19:39:50 level=info msg="Update check succeeded" duration=<REDACTED>
logger=infra.usagestats       t=19:40:37 level=info msg="Usage stats are ready to report"
```

Filtering the whole idle window (19:41:00 → 19:50:30) for INFO lines confirms that
**nothing recurs until the 10‑minute mark**:

```bash
$ grep 'level=info' /tmp/run_long.log | grep -E 't=2026-07-14T19:(4[1-9]|50):' \
    | grep -oE 'logger=[^ ]+ .*msg="[^"]+"' | sed -E 's/(msg="[^"]+").*/\1/'
logger=plugins.update.checker ... msg="Update check succeeded"     # t=19:49:50
logger=cleanup ...                msg="Completed cleanup jobs"      # t=19:49:50
```

So the honest, direct result for a **60‑second** window is: **no recurring INFO entries**
(the single `msg="Usage stats are ready to report"` line is emitted once and does not repeat).

### (b) Extended run at `level=info` — the recurring INFO entries appear at 10 minutes

Two independent extended runs (run_long, run_long2) show the **same** two INFO emitters
recurring at the **10‑minute** cadence, at exactly `listen + 10:00` in both runs (stability
confirmed):

```text
# run_long  (ready at t=19:39:50):
logger=http.server t=19:39:50 level=info msg="HTTP Server Listen" address=[::]:3001 protocol=http subUrl= socket=
logger=cleanup     t=19:49:50 level=info msg="Completed cleanup jobs" duration=<REDACTED>

# run_long2 (ready at t=19:54:09):
logger=http.server t=19:54:09 level=info msg="HTTP Server Listen" address=[::]:3004 protocol=http subUrl= socket=
logger=cleanup     t=20:04:09 level=info msg="Completed cleanup jobs" duration=<REDACTED>
```

The **plugins update checker** (also a 10‑minute ticker) demonstrates its recurrence twice
within a single run (at startup and again at +10:00):

```text
logger=plugins.update.checker t=19:39:50 level=info msg="Update check succeeded" duration=<REDACTED>
logger=plugins.update.checker t=19:49:50 level=info msg="Update check succeeded" duration=<REDACTED>
```

### (c) Debug run — the true sub‑minute recurring set

Re‑running at `level=debug` (enabled via the CLI override `cfg:log.level=debug`, **never** by
editing `conf/defaults.ini`) surfaces the frequent tickers that are hidden at `level=info`:

```bash
$ ./bin/linux-amd64/grafana server --homepath "$(pwd)" cfg:server.http_port=3002 cfg:log.level=debug \
    cfg:paths.data=/tmp/gf-data2 cfg:paths.logs=/tmp/gf-logs2 cfg:paths.plugins=/tmp/gf-plugins2 \
    > /tmp/run3.log 2>&1 &
```

**Alerting scheduler tick — every 10 s** (verbatim; the identical cadence appeared in both
run3 and run3b):

```text
logger=ngalert.scheduler t=19:40:10 level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=19:40:20 level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=19:40:30 level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=19:40:40 level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=19:40:50 level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=19:41:00 level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
```

**Secrets data‑keys cache GC — every 60 s:**

```text
logger=secrets t=19:41:09 level=debug msg="Removing expired data keys from cache..."
logger=secrets t=19:42:09 level=debug msg="Removing expired data keys from cache..."
```

**SSO settings reload — every 60 s:**

```text
logger=ssosettings.service t=19:41:09 level=debug msg="reloading SSO Settings for all providers"
logger=ssosettings.service t=19:42:09 level=debug msg="reloading SSO Settings for all providers"
```

**Multi‑org Alertmanager sync — every ~60 s:**

```text
logger=ngalert.multiorg.alertmanager t=19:40:08 level=debug msg="Synchronizing Alertmanagers for orgs"
logger=ngalert.multiorg.alertmanager t=19:41:09 level=debug msg="Synchronizing Alertmanagers for orgs"
logger=ngalert.multiorg.alertmanager t=19:42:09 level=debug msg="Synchronizing Alertmanagers for orgs"
```

**Alertmanager admin‑config sync (sender router) — every ~60 s:**

```text
logger=ngalert.sender.router t=19:40:08 level=debug msg="Attempting to sync admin configs" count=0
logger=ngalert.sender.router t=19:41:09 level=debug msg="Attempting to sync admin configs" count=0
logger=ngalert.sender.router t=19:42:09 level=debug msg="Attempting to sync admin configs" count=0
```

### Complete enumeration of recurring emitters (with intervals, levels, and responsible code)

Background services are launched in `(*Server).Run()` (`pkg/server/server.go:139`), each enabled
service started as a goroutine via `s.childRoutines.Go(...)` (`pkg/server/server.go:156`; the Debug
line `"Starting background service"` is at `:162`). Each recurring emitter below is correlated to
the observed line above.

| # | Emitter (observed message) | Interval | Level | Observed? | Responsible code (`file:line`) |
|---|---|---|---|---|---|
| 1 | `cleanup` `"Completed cleanup jobs"` | 10 min | **Info** | ✅ (run_long, run_long2) | emit `pkg/services/cleanup/cleanup.go:128`; ticker `:80` `time.NewTicker(time.Minute*10)`; fn `(*CleanUpService).Run` `:77` |
| 2 | `plugins.update.checker` `"Update check succeeded"` | 10 min | **Info** | ✅ (run_long ×2) | emit `pkg/services/updatechecker/plugins.go:123`; ticker `:78` `time.NewTicker(time.Minute*10)` |
| 3 | `grafana.update.checker` `"Update check succeeded"` | 24 h | **Info** | startup only (next +24 h) | emit `pkg/services/updatechecker/grafana.go:89`; ticker `:63` `time.NewTicker(time.Hour*24)` |
| 4 | `ngalert.scheduler` `"Alert rules fetched"` | 10 s | **Debug** | ✅ (run3, run3b) | emit `pkg/services/ngalert/schedule/fetcher.go:39`; `baseInterval` ticker `schedule.go:158`; Info‑once `"Starting scheduler"` `:157` |
| 5 | `secrets` `"Removing expired data keys from cache..."` | 60 s | **Debug** | ✅ (run3, run3b) | emit `pkg/services/secrets/manager/manager.go:521` (+`:523`); GC ticker `:503`–`:505` `MustDuration(time.Minute)`; TTL `:67` |
| 6 | `ssosettings.service` `"reloading SSO Settings for all providers"` | 60 s | **Debug** | ✅ (run3) | emit `pkg/services/ssosettings/ssosettingsimpl/service.go:384`; ticker `:368` `time.NewTicker(interval)` |
| 7 | `ngalert.multiorg.alertmanager` `"Synchronizing Alertmanagers for orgs"` | ~60 s | **Debug** | ✅ (run3) | emit `pkg/services/ngalert/notifier/multiorg_alertmanager.go:255`; driven by `AlertmanagerConfigPollInterval` `:246` |
| 8 | `ngalert.sender.router` `"Attempting to sync admin configs"` | ~60 s | **Debug** | ✅ (run3) | emit `pkg/services/ngalert/sender/router.go:90`; driven by `AdminConfigPollInterval` (`pkg/services/ngalert/ngalert.go:354`) |

**Present in code but NOT observed as recurring in the idle windows (reported honestly):**

- **Dashboard provisioning poller** — ticker `pkg/services/provisioning/dashboards/file_reader.go:81`
  (every `UpdateIntervalSeconds`, default 10 s). With the default config **no dashboards are
  provisioned**, so the per‑poll Debug lines (`file_reader.go:97`, `:288`) were **not emitted** during
  idle — only one‑time startup provisioning INFO lines (`"starting/finished to provision dashboards"`)
  appeared. (Inferred from code: the 10 s ticker still runs; it simply produces no log output when
  there is nothing to walk.)
- **Remote‑cache GC** — ticker `pkg/infra/remotecache/database_storage.go:30` (every 10 min). No log
  line is emitted by this GC, so nothing was observed (silent by design).
- **Expired‑token cleanup** — ticker `pkg/services/auth/authimpl/token_cleanup.go:11` (every 1 h) and
  **Anonymous‑device cleanup** — ticker `pkg/services/anonymous/anonimpl/impl.go:201` (every 2 h): both
  fire beyond the practical observation window (their tickers are cited from code).

### Cause → effect

The default `[log] level = info` (`conf/defaults.ini:1074`) filters out every `Debug` line. Emitters
#4–#8 (the 10 s and 60 s tickers) log **only at Debug**, so they are invisible at `level=info`.
The only **INFO** emitters that recur are the two 10‑minute tickers (#1 cleanup, #2 plugins update
checker). Consequently a 60‑second idle window shows **no recurring INFO entry at all**; the first
recurring INFO entries (`"Completed cleanup jobs"` and the plugins `"Update check succeeded"`) appear
at the 10‑minute mark, exactly as observed in both extended runs.

---

## Q2 — Capture the specific startup output that confirms the database schema version is up to date

**Direct answer: The confirming evidence is the SQL-store migrator's INFO pair `msg="Starting DB migrations"` followed by `msg="migrations completed" performed=<N> skipped=<M> duration=<...>`. On a database that is already fully migrated, that second line reads `performed=0` (with `skipped=626`) — the `performed=0` line is the runtime proof that the schema is up to date.** Both boot states are shown (first boot performs the migrations; second boot of the same database performs none).

### First boot (fresh SQLite database) — migrations are performed

```bash
$ ./bin/linux-amd64/grafana server --homepath "$(pwd)" \
    cfg:paths.data=/tmp/gf-data1 cfg:paths.logs=/tmp/gf-logs1 cfg:paths.plugins=/tmp/gf-plugins1 > /tmp/run1.log 2>&1 &
$ grep 'logger=migrator' /tmp/run1.log | grep -E 'Starting DB migrations|migrations completed'
```

```text
logger=migrator t=<REDACTED> level=info msg="Starting DB migrations"
logger=migrator t=<REDACTED> level=info msg="migrations completed" performed=626 skipped=0 duration=<REDACTED>
```

### Second boot (same database) — schema already up to date, `performed=0`

```bash
# stop the first instance, then re-run against the SAME data dir /tmp/gf-data1:
$ ./bin/linux-amd64/grafana server --homepath "$(pwd)" \
    cfg:paths.data=/tmp/gf-data1 cfg:paths.logs=/tmp/gf-logs1 cfg:paths.plugins=/tmp/gf-plugins1 > /tmp/run2.log 2>&1 &
$ grep 'logger=migrator' /tmp/run2.log | grep -E 'Starting DB migrations|migrations completed'
```

```text
logger=migrator t=<REDACTED> level=info msg="Starting DB migrations"
logger=migrator t=<REDACTED> level=info msg="migrations completed" performed=0 skipped=626 duration=<REDACTED>
```

`performed=0 skipped=626` is the "schema is up to date" confirmation: all 626 known migrations were
recognized as already applied and none were re-executed.

### Per-migration skip evidence (Debug) — only visible at `level=debug`

At the default `level=info` the individual skips are not printed. Booting the already-migrated
database at `level=debug` surfaces the per-migration skip line (644 such lines were emitted; first
three shown):

```bash
$ ./bin/linux-amd64/grafana server --homepath "$(pwd)" cfg:log.level=debug \
    cfg:paths.data=/tmp/gf-data1 cfg:paths.logs=/tmp/gf-logs1 cfg:paths.plugins=/tmp/gf-plugins1 > /tmp/run2_debug.log 2>&1 &
$ grep 'level=debug' /tmp/run2_debug.log | grep 'msg="Skipping migration: Already executed"' | head -3
```

```text
logger=migrator t=<REDACTED> level=debug msg="Skipping migration: Already executed" id="create migration_log table"
logger=migrator t=<REDACTED> level=debug msg="Skipping migration: Already executed" id="create user table"
logger=migrator t=<REDACTED> level=debug msg="Skipping migration: Already executed" id="add unique index user.login"
```

### Responsible code

The log-emitting function is **`(*Migrator).run`** at `pkg/services/sqlstore/migrator/migrator.go:241`,
reached from the public entry point `(*Migrator).Start` (`:195`) -> `RunMigrations` -> `run`:

- `pkg/services/sqlstore/migrator/migrator.go:247` — `logger.Info("Starting DB migrations")`.
- `pkg/services/sqlstore/migrator/migrator.go:262` — `logger.Debug("Skipping migration: Already executed", "id", m.Id())` (per already-applied migration; Debug only).
- `pkg/services/sqlstore/migrator/migrator.go:287` — `logger.Info("migrations completed", "performed", migrationsPerformed, "skipped", migrationsSkipped, "duration", time.Since(start))`.

### Cause -> effect

On boot, `(*Migrator).run` iterates the registered migration list. For each migration already
recorded in the `migration_log` table it logs the Debug skip line (`:262`) and increments the
`skipped` counter; migrations not yet recorded are executed and increment `performed`. It then emits
the terminal INFO line (`:287`). On a fully-migrated database every migration is skipped, so the line
reports `performed=0` — the definitive runtime signal that the schema version matches the code and no
schema change was needed.

---

## Q3 — Query the running instance's API to verify build information; report the exact version string

**Direct answer: The running canonical instance reports the version string `11.5.0-pre`.** The exact value is returned identically by `GET /api/health` (`"version": "11.5.0-pre"`), by `GET /api/frontend/settings` (`buildInfo.version = "11.5.0-pre"`, `versionString = "Grafana v11.5.0-pre (4550cfb5b7)"`), and by the startup banner (`version=11.5.0-pre`). The value is **build-method dependent**: the canonical build (`make build-backend`, ldflag `-X main.version=11.5.0-pre`) yields `11.5.0-pre`; a bare `go run ./pkg/cmd/grafana` (no ldflags) yields the fallback `9.2.0`. The canonical `11.5.0-pre` is the answer; the fallback and the deprecated `grafana-server` shim are noted as caveats.

### `GET /api/health`

```bash
$ curl -s http://localhost:3000/api/health
```

```json
{
  "database": "ok",
  "version": "11.5.0-pre",
  "commit": "4550cfb5b7"
}
```

### `GET /api/frontend/settings` -> `buildInfo`

`/api/frontend/settings` requires authentication (anonymous access is disabled by default, returning
HTTP 401); it was queried with the default `admin` login:

```bash
$ curl -s -u admin:admin http://localhost:3000/api/frontend/settings \
    | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["buildInfo"],indent=2))'
```

```json
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

### `GET /healthz` (bare liveness) and the startup banner

```bash
$ curl -s http://localhost:3000/healthz
Ok
$ grep 'msg="Starting Grafana"' /tmp/run1.log
```

```text
logger=settings t=<REDACTED> level=info msg="Starting Grafana" version=11.5.0-pre commit=4550cfb5b7 branch=blitzy-bd7c52bb-ddb1-4334-9ff1-3439b97e50cf compiled=2024-12-13T14:22:02Z
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

# (c) DEPRECATED grafana-server shim — prints a deprecation warning then re-execs `grafana`:
$ ./bin/linux-amd64/grafana-server --homepath "$(pwd)" cfg:server.http_port=3005 cfg:paths.data=/tmp/gf-data5 ...
Deprecation warning: The standalone 'grafana-server' program is deprecated and will be removed in the future. Please update all uses of 'grafana-server' to 'grafana server'
# (its subsequent banner still shows version=11.5.0-pre because it re-execs the ldflag-built grafana binary)
```

### Responsible code

- `/api/health` handler **`(*HTTPServer).apiHealthHandler`** `pkg/api/http_server.go:710`; response struct
  `healthResponse` `:694` (`database`, `version` omitempty, `commit`, `enterpriseCommit`); `:716`
  `data := healthResponse{Database: "ok"}`; gated at `:719` `if !hs.Cfg.Anonymous.HideVersion` then `:720`
  `data.Version = hs.Cfg.BuildVersion`.
- Bare liveness handler **`(*HTTPServer).healthzHandler`** `pkg/api/http_server.go:681`; writes `"Ok"` at `:688`.
- `/api/frontend/settings`: `pkg/api/frontendsettings.go:161` `version := setting.BuildVersion`; emitted at
  `:247` `BuildInfo:` -> `:249` `Version: version` (with `:248 HideVersion`).
- Version source & banner: `pkg/setting/setting.go:1076` `cfg.BuildVersion = BuildVersion`; startup banner
  `:940` `cfg.Logger.Info(fmt.Sprintf("Starting %s", ApplicationName), "version", BuildVersion, ...)`.
- Version injection vs fallback: canonical build ldflag `-X main.version` (`pkg/build/cmd.go:55`, `:247`)
  from `package.json:6` `"11.5.0-pre"`; fallback literal `var version = "9.2.0"` `pkg/cmd/grafana/main.go:17`.
- Deprecated shim: `pkg/cmd/grafana-server/main.go` -> `cmd.RunGrafanaCmd("server")`
  (`pkg/util/cmd/cmd.go:15`), which prints the deprecation warning (`:24`) and re-execs `grafana`.

### Cause -> effect

The canonical build injects `package.json`'s version through the linker (`-X main.version=11.5.0-pre`),
so `main.version = "11.5.0-pre"`; this flows into `cfg.BuildVersion` (`setting.go:1076`) and is then
surfaced verbatim by `apiHealthHandler` (`http_server.go:720`), by `/api/frontend/settings`
(`frontendsettings.go:161/:249`), and by the startup banner (`setting.go:940`). Without ldflags a bare
`go run` leaves `main.version` at its source fallback `9.2.0` (`main.go:17`) — which is why only a
canonical build reports `11.5.0-pre`.


---

## Q4 — Does the panel-editor datasource picker automatically resolve to the datasource already defined in the panel's queries?

**Direct answer: YES.** During the dashboard-view -> panel-editor transition, the queries-tab activation handler reads the datasource stored on the panel's query runner and resolves it, so the picker displays the datasource already defined in the panel's existing queries. The last-used / default datasource is used only as a fallback when the panel has no datasource set.

### Command

```bash
$ CI=true yarn jest \
    public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx \
    --ci --watchAll=false --verbose 2>&1 | tee /tmp/q4_verbose.log
```

### Verbatim captured output (Jest)

```text
PASS public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx
  PanelDataQueriesTab
    Adding queries
      ✓ can add a new query (30 ms)
      ✓ Can add a new query when datasource is mixed (7 ms)
    PanelDataQueriesTab
      ✓ renders query group top section (102 ms)
      ✓ renders queries rows when queries are set (65 ms)
      ✓ allow to add a new query when user clicks on add new (150 ms)
      ✓ allow to remove a query when user clicks on remove (472 ms)
    query options
      activation
        ✓ should load data source (7 ms)
        ✓ should store loaded data source in local storage (5 ms)
        ✓ should load default datasource if the datasource passed is not found (7 ms)
      data source change
        ✓ should load new data source (5 ms)
        ✓ changing from one plugin to another (5 ms)
        ✓ changing from a plugin to a dashboard data source (4 ms)
        ✓ changing from dashboard data source to a plugin (4 ms)
      query options change
        time overrides
          ✓ should create PanelTimeRange object (5 ms)
          ✓ should update hoverHeader (7 ms)
          ✓ should update PanelTimeRange object on time options update (5 ms)
          ✓ should remove PanelTimeRange object on time options cleared (4 ms)
        max data points and interval
          ✓ should update max data points (6 ms)
          ✓ should update min interval (4 ms)
          ✓ should update min interval to undefined if empty input (4 ms)
        query caching
          ✓ updates cacheTimeout and queryCachingTTL (6 ms)
      query inspection
        ✓ allows query inspection from the tab (4 ms)
      change queries
        plugin queries
          ✓ should update queries (4 ms)
        dashboard queries
          ✓ should update queries (4 ms)
          ✓ should load last used data source if no data source specified for a panel (4 ms)

Test Suites: 1 passed, 1 total
Tests:       25 passed, 25 total
Snapshots:   0 total
Time:        5.062 s, estimated 9 s
```

The `should load data source` case (defined at `PanelDataQueriesTab.test.tsx:361`, inside
`describe('activation')` at `:360`) mocks `getDataSourceSrv` within `jest.mock('@grafana/runtime')`
(`:198`, `:207`) and asserts that after activation `queriesTab.state.datasource` equals the resolved
mock datasource that was defined in the panel's query — i.e. the picker resolved to the panel's
existing query datasource. The companion case `should load default datasource if the datasource passed
is not found` proves the fallback path.

### Responsible code

**`PanelDataQueriesTab.loadDataSource`** in
`public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx`:

- `:44` `this.addActivationHandler(() => this.onActivate())` — registers the activation handler that fires on the dashboard-view -> panel-editor transition.
- `:59` `onActivate()` -> `:60` calls `this.loadDataSource()`.
- `:63` `private async loadDataSource()`; `:71` `let datasourceToLoad = this.queryRunner.state.datasource` — reads the datasource already defined on the panel's query runner.
- Else-branch (datasource present, ~`:100`): `:101` `datasource = await getDataSourceSrv().get(datasourceToLoad)`, `:102` `getDataSourceSrv().getInstanceSettings(datasourceToLoad)`, then `:106` `this.setState({ datasource, dsSettings })` — this sets the picker's displayed value.
- Fallback (no datasource on the panel — new panel): `:80`–`:95` resolves the last-used datasource; the catch at `:111`–`:112` falls back to `config.defaultDatasource`.

### Cause -> effect

When the panel editor activates, `loadDataSource()` reads `this.queryRunner.state.datasource`
(`:71`). Because an existing panel's query runner already carries the query's datasource reference,
the else-branch resolves it via `getDataSourceSrv().get(...)` / `getInstanceSettings(...)` and calls
`setState({ datasource, dsSettings })` (`:106`). That state feeds the datasource picker, so the picker
displays the datasource already defined in the panel's queries. Only when
`this.queryRunner.state.datasource` is empty (a brand-new panel) does the last-used/default fallback
apply.

---

## Q5 — Does the backend's rule definition populate the query state when the alerting edit view is opened?

**Direct answer: YES.** For an existing Grafana-managed alerting rule, the rule-form conversion populates the form's `queries` state directly from the backend rule definition's `grafana_alert.data`, so opening the edit view carries the full set of queries (deep-equal, all N=3 in the test) from the backend. New rules, by contrast, start with `queries: []`.

### Command

A temporary colocated spec was created to exercise the real edit-view conversion functions
(the existing `rule-form.test.ts` imports only the reverse-direction converters, so it could not
observe this path). The spec was run non-interactively and then **deleted**:

```bash
# temporary spec: public/app/features/alerting/unified/utils/rule-form.blitzytmp.test.ts
$ CI=true yarn jest \
    public/app/features/alerting/unified/utils/rule-form.blitzytmp.test.ts \
    --ci --watchAll=false --verbose 2>&1 | tee /tmp/q5.log
# ...then removed:
$ rm public/app/features/alerting/unified/utils/rule-form.blitzytmp.test.ts
```

### Verbatim captured output (Jest)

```text
PASS public/app/features/alerting/unified/utils/rule-form.blitzytmp.test.ts
  Q5: rule-edit query state population (rulerRuleToFormValues / formValuesFromExistingRule)
    ✓ rulerRuleToFormValues populates queries from backend grafana_alert.data (N=3, deep-equal) (5 ms)
    ✓ formValuesFromExistingRule (edit-view entry point) also carries the populated queries (N=3) (2 ms)
    ✓ new rules (getDefaultFormValues contrast) would start with queries: [] — existing rule differs (1 ms)
Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
Snapshots:   0 total
Time:        4.635 s, estimated 5 s
```

The spec built a mock `RuleWithLocation` for a Grafana-managed alerting rule
(`ruleSourceName = GRAFANA_RULES_SOURCE_NAME`, `grafana_alert.data` carrying 3 query entries plus
`no_data_state` / `exec_err_state` / `condition` / `title`) and asserted that the returned
`RuleFormValues.queries` deep-equals `grafana_alert.data` with length 3.

> Note: Grafana's Jest setup uses `jest-fail-on-console`, so the spec relies on assertions (never
> `console.log`) as its evidence. The temporary spec was deleted after capture and `git status
> --porcelain` confirms it left no trace.

### Responsible code

**`rulerRuleToFormValues`** / **`formValuesFromExistingRule`** in
`public/app/features/alerting/unified/utils/rule-form.ts`:

- `:365` `export function rulerRuleToFormValues(ruleWithLocation: RuleWithLocation): RuleFormValues` — converts a backend rule definition to form values.
- `:402` `queries: ga.data,` — in the Grafana-alerting branch (guarded by `ga.no_data_state` and `ga.exec_err_state` being defined, `:392`), the form's `queries` are set directly from the backend definition's `grafana_alert.data`.
- `:916`/`:917` `export function formValuesFromExistingRule(rule: RuleWithLocation)` = `ignoreHiddenQueries(rulerRuleToFormValues(rule))` — the edit-view entry point.
- New-rule contrast: `getDefaultFormValues()` (`:87`) sets `queries: []` (`:101`).
- The populated values are consumed by
  `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/QueryAndExpressionsStep.tsx`.

### Cause -> effect

When the edit view opens for an existing Grafana-managed rule, `formValuesFromExistingRule` (`:916`)
calls `rulerRuleToFormValues` (`:365`), whose Grafana-alerting branch assigns `queries: ga.data`
(`:402`) — copying the backend definition's query array into the form. The QueryAndExpressionsStep
then renders from those populated form values, so the edit view shows the queries defined by the
backend. For a new rule the form instead starts from `getDefaultFormValues()` with `queries: []`
(`:101`), which is why the populated state is specific to editing an existing rule.


---

## Closing note — repository integrity

This was a strictly read-only investigation. No existing repository file was modified, added to, or
deleted. All runtime observation used temporary scripts, logs, binaries, data directories, and one
temporary Jest spec confined to `/tmp` (or created and then removed inside the worktree); every such
artifact was cleaned up on completion. In particular, the temporary spec
`public/app/features/alerting/unified/utils/rule-form.blitzytmp.test.ts` (used for Q5) was deleted
after its output was captured. `conf/defaults.ini` and all other source files, as well as the
dependency manifests (`package.json`, `yarn.lock`, `go.mod`, `go.sum`), are byte-for-byte unchanged.

The only new artifact is this documentation file. `git status --porcelain` at completion:

```text
?? blitzy/
```

The sole untracked path is the `blitzy/` tree containing this document
(`blitzy/documentation/grafana_4550cfb5b728.md`); no tracked file appears, confirming the working
tree is otherwise unchanged.

