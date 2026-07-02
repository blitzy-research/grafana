# Grafana Runtime Investigation — Evidence-Backed Answers

This document answers five runtime-behavior questions about Grafana. Per the project rule, every answer was produced by **actually building and running the code first**, then quoting the captured output verbatim; each behavioral claim is paired with the specific observed line that demonstrates it, and each is attributed to the responsible source with a `file:line` citation. Nothing in the source repository was modified; all temporary observation scripts/tests were removed.

## Environment & build provenance

- Repository: `grafana/grafana`; branch `grafana_4550cfb5b728`; commit `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`.
- Toolchain used to observe (already provisioned): Go `1.23.1` (matches `go.mod:L3`), Node `v22.12.0`, Yarn `4.5.3`. The repository pins Node `v22.11.0` (`.nvmrc:L1`) and declares `engines.node` `">= 22"` (`package.json:L450-L451`) and `packageManager` `"yarn@4.5.3"` (`package.json:L453`); the provisioned Node `v22.12.0` satisfies the `">= 22"` engine constraint. The Node version was observed at runtime — command and verbatim output:

```
$ node --version
v22.12.0
```

- Backend binary: built from `./pkg/cmd/grafana` into `./bin/linux-amd64/grafana` (the `build-backend` target builds `grafana` from `./pkg/cmd/grafana` — `doBuild("grafana", "./pkg/cmd/grafana", opts)` at `pkg/build/cmd.go:L81`, within `pkg/build/cmd.go:L76-L84`). Note that `make build-server` builds only `./pkg/cmd/grafana-server` (the `build-srv`/`build-server` target at `pkg/build/cmd.go:L86-L91`), which is a **deprecated shim**: its `main()` calls `cmd.RunGrafanaCmd("server")` (`pkg/cmd/grafana-server/main.go:L9-L10`), and `RunGrafanaCmd` prints a deprecation warning and `syscall.Exec`s the sibling `grafana` binary (`pkg/util/cmd/cmd.go:L15-L67`; the deprecation warning is emitted at `pkg/util/cmd/cmd.go:L23-L24` and the exec at `pkg/util/cmd/cmd.go:L67`). The runnable server is therefore `grafana`. Building required first generating the Google Wire file via `make gen-go` (produces the gitignored `pkg/server/wire_gen.go` providing `func Initialize`), then `go build` with the documented linker flags `-X main.version=11.5.0-pre -X main.commit=4550cfb5b7 -X main.buildBranch=grafana_4550cfb5b728` (the `-X main.version=%s` ldflag is assembled at `pkg/build/cmd.go:L247`).
- The compiled `grafana` binary self-reports its version — command and verbatim output:

```
$ ./bin/linux-amd64/grafana -v
grafana version 11.5.0-pre
```

- Default configuration used to run (from `conf/defaults.ini`): `http_port = 3000` (`conf/defaults.ini:L41`), `type = sqlite3` (`conf/defaults.ini:L123`), log `mode = console file` (`conf/defaults.ini:L1071`), `level = info` (`conf/defaults.ini:L1074`), `reporting_enabled = true` (`conf/defaults.ini:L258`), `check_for_updates = true` (`conf/defaults.ini:L268`). Data/logs/plugins were redirected under `/tmp` so the working tree stayed clean. The server was run with `./bin/linux-amd64/grafana server --homepath <repo> cfg:default.paths.data=/tmp/gf/data cfg:default.paths.logs=/tmp/gf/logs cfg:default.paths.plugins=/tmp/gf/plugins`. (For the Q1 idle observation only, the runtime override `cfg:default.server.router_logging=true` was additionally passed to obtain positive inbound-request log evidence — see Q1. This is a command-line override that modifies no file; `router_logging` defaults to `false` at `conf/defaults.ini:L57`, and enabling it affects only per-request logging, not the timer-driven background services studied in Q1.)

---

## Q1 — What recurring log entries appear when the server has been idle (no user requests) for at least 60 seconds?

The server was launched with default configuration and left **completely idle (zero inbound HTTP requests)**. Because the strongest periodic Info emitter (the cleanup service) runs on a 10-minute ticker, the instance was held idle well beyond 60 seconds (~20 minutes) to observe the true recurrence cadence. The idle window is anchored at the "HTTP Server Listen" line (call this timestamp **T**):

```
logger=http.server t=2026-07-01T23:16:39.853607253Z level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=
```

So the strict 60-second idle window is **[T, T+60s] = [2026-07-01T23:16:39.853607253Z .. 2026-07-01T23:17:39.853607253Z]**. For this idle observation the runtime override `cfg:default.server.router_logging=true` was passed so that any inbound HTTP request would be logged at Info; this modifies no file and does not affect the timer-driven background services under study (see the Environment section).

### Sub-answer 1a — Within a STRICT ≥60-second idle window (report honestly)

**Claim: within the strict 60-second window no log entry *recurs* — every line in the window is a one-time startup or first-fire entry.** Producing command (timestamp-filter the captured console log to the window `[T, T+60s]`):

```
$ awk -v lo="2026-07-01T23:16:39.853607253Z" -v hi="2026-07-01T23:17:39.853607253Z" \
    '{ if (match($0,/t=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/)) { ts=substr($0,RSTART+2,RLENGTH-2); if (ts>=lo && ts<=hi) print } }' \
    consoleB.log
```

Verbatim output — the complete contents of the strict 60-second window (17 lines):

```
logger=http.server t=2026-07-01T23:16:39.853607253Z level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=
logger=ngalert.state.manager t=2026-07-01T23:16:39.86257362Z level=info msg="State cache has been initialized" states=0 duration=10.397997ms
logger=ngalert.scheduler t=2026-07-01T23:16:39.862651952Z level=info msg="Starting scheduler" tickInterval=10s maxAttempts=3
logger=ticker t=2026-07-01T23:16:39.862690053Z level=info msg=starting first_tick=2026-07-01T23:16:40Z
logger=plugins.update.checker t=2026-07-01T23:16:39.886709037Z level=info msg="Update check succeeded" duration=34.634656ms
logger=grafana.update.checker t=2026-07-01T23:16:39.888679443Z level=info msg="Update check succeeded" duration=36.41669ms
logger=grafana-apiserver t=2026-07-01T23:16:40.060697137Z level=info msg="Adding GroupVersion playlist.grafana.app v0alpha1 to ResourceManager"
logger=resource-server t=2026-07-01T23:16:40.060850468Z level=warn msg="failed to register storage metrics" error="duplicate metrics collector registration attempted"
logger=resource-server t=2026-07-01T23:16:40.060946204Z level=warn msg="failed to register storage metrics" error="duplicate metrics collector registration attempted"
logger=resource-server t=2026-07-01T23:16:40.06097981Z level=warn msg="failed to register storage metrics" error="duplicate metrics collector registration attempted"
logger=grafana-apiserver t=2026-07-01T23:16:40.065038124Z level=info msg="Adding GroupVersion dashboard.grafana.app v0alpha1 to ResourceManager"
logger=grafana-apiserver t=2026-07-01T23:16:40.06564101Z level=info msg="Adding GroupVersion dashboard.grafana.app v1alpha1 to ResourceManager"
logger=grafana-apiserver t=2026-07-01T23:16:40.066218672Z level=info msg="Adding GroupVersion dashboard.grafana.app v2alpha1 to ResourceManager"
logger=grafana-apiserver t=2026-07-01T23:16:40.06667879Z level=info msg="Adding GroupVersion featuretoggle.grafana.app v0alpha1 to ResourceManager"
logger=grafana-apiserver t=2026-07-01T23:16:40.067920124Z level=info msg="Adding GroupVersion iam.grafana.app v0alpha1 to ResourceManager"
logger=app-registry t=2026-07-01T23:16:40.086875976Z level=info msg="app registry initialized"
logger=infra.usagestats t=2026-07-01T23:17:10.854219023Z level=info msg="Usage stats are ready to report"
```

Every one of these 17 lines is a distinct **one-time** event: the HTTP listen line, the alerting scheduler/ticker start, the **first** fire of each of the two update-checkers, six API-server `GroupVersion` registrations, three (distinct) resource-server warnings, `app registry initialized`, and a single `Usage stats are ready to report` readiness line at T+31.0s. **None of these repeats within the window.** To prove the periodic services do not recur inside the window, count their occurrences in `[T, T+60s]`:

```
$ for lg in cleanup plugins.update.checker grafana.update.checker; do
    c=$(awk -v lo="2026-07-01T23:16:39.853607253Z" -v hi="2026-07-01T23:17:39.853607253Z" -v L="logger=$lg " \
        '{ if (match($0,/t=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/)) { ts=substr($0,RSTART+2,RLENGTH-2); if (ts>=lo && ts<=hi && index($0,L)==1) n++ } } END{print n+0}' consoleB.log)
    echo "logger=$lg  count_in_window=$c"
  done
logger=cleanup  count_in_window=0
logger=plugins.update.checker  count_in_window=1
logger=grafana.update.checker  count_in_window=1
```

That is: `cleanup` has **not fired at all** yet (its first `Completed cleanup jobs` is at T+600s, see 1b); each update-checker shows exactly its **single startup fire** — neither has recurred. So within a strict 60-second idle window **no entry recurs**; the shortest recurrence cadence is 10 minutes (1b). This is reported exactly as observed.

**Zero inbound HTTP requests during the window (proof).** Count request-completion log lines (emitted at Info by `pkg/middleware/loggermw/logger.go:L84` when `router_logging=true`) inside `[T, T+60s]`:

```
$ awk -v lo="2026-07-01T23:16:39.853607253Z" -v hi="2026-07-01T23:17:39.853607253Z" \
    '/msg="Request Completed"/{ if (match($0,/t=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/)) { ts=substr($0,RSTART+2,RLENGTH-2); if (ts>=lo && ts<=hi) n++ } } END{print "Request Completed count in window =", n+0}' consoleB.log
Request Completed count in window = 0
```

Positive control that request logging was actually active: the only `Request Completed` line in the entire run is a deliberate `GET /` issued **after** the window closed (at T+94.4s), which *was* logged — confirming the zero count above reflects genuine idleness, not a disabled logger:

```
logger=context userId=0 orgId=0 uname= t=2026-07-01T23:18:14.251148743Z level=info msg="Request Completed" method=GET path=/ status=302 remote_addr=127.0.0.1 time_ms=0 duration=93.289µs size=29 referer= handler=/ status_source=server
```

(The `/api/health` request issued at T+91.4s is intentionally not logged — `apiHealthHandler` short-circuits the request before the logging middleware at `pkg/api/http_server.go:L710-L714`; the `GET /` above is used precisely because it passes through the logging middleware.)

### Sub-answer 1b — The recurring entries over the true (extended) window

Over the ~20-minute idle window, exactly **two** distinct Info-level entries recur, both on a **10-minute** cadence:

**(1) Cleanup service — `Completed cleanup jobs`.** Producing command:

```
$ grep 'logger=cleanup' consoleB.log
logger=cleanup t=2026-07-01T23:26:39.907405031Z level=info msg="Completed cleanup jobs" duration=54.586462ms
logger=cleanup t=2026-07-01T23:36:39.854455624Z level=info msg="Completed cleanup jobs" duration=2.081532ms
```

The two cycles are 10 minutes apart (23:26:39.907 → 23:36:39.854 ≈ 599.95s), the first at T+600.05s. Attribution: emitted at `pkg/services/cleanup/cleanup.go:L128` (`logger.Info("Completed cleanup jobs", "duration", time.Since(start))`) on the ticker created at `pkg/services/cleanup/cleanup.go:L80` (`ticker := time.NewTicker(time.Minute * 10)`). Note the first `Completed cleanup jobs` appears ~10 minutes **after** startup, not immediately: `CleanUpService.Run` (`pkg/services/cleanup/cleanup.go:L77`) runs an initial temp-file cleanup that does **not** emit this line, then waits on the 10-minute ticker before the first full `clean()`.

**(2) Plugins update checker — `Update check succeeded`.** Producing command:

```
$ grep 'logger=plugins.update.checker' consoleB.log
logger=plugins.update.checker t=2026-07-01T23:16:39.886709037Z level=info msg="Update check succeeded" duration=34.634656ms
logger=plugins.update.checker t=2026-07-01T23:26:39.911550013Z level=info msg="Update check succeeded" duration=24.214131ms
logger=plugins.update.checker t=2026-07-01T23:36:39.918222774Z level=info msg="Update check succeeded" duration=31.054276ms
```

Three occurrences 10 minutes apart (the first at startup T+0.03s, then T+600.06s and T+1200.06s). Attribution: emitted at `pkg/services/updatechecker/plugins.go:L123` (`ctxLogger.Info("Update check succeeded", "duration", time.Since(start))`) on the ticker at `pkg/services/updatechecker/plugins.go:L78` (`ticker := time.NewTicker(time.Minute * 10)`).

### Sub-answer 1c — Entries that appear once but do NOT recur (to disambiguate)

The following appear exactly once in the idle window and are therefore **not** recurring:

- Grafana update checker (24-hour ticker), fires once at startup only:

```
$ grep 'logger=grafana.update.checker' consoleB.log
logger=grafana.update.checker t=2026-07-01T23:16:39.888679443Z level=info msg="Update check succeeded" duration=36.41669ms
```

(One line only, over the full ~20-minute run.) Attribution: ticker at `pkg/services/updatechecker/grafana.go:L63` (`ticker := time.NewTicker(time.Hour * 24)`), emit at `pkg/services/updatechecker/grafana.go:L89`.

- The alerting scheduler logs its start line once and does **not** emit a per-tick Info line:

```
$ grep 'logger=ngalert.scheduler' consoleB.log
logger=ngalert.scheduler t=2026-07-01T23:16:39.862651952Z level=info msg="Starting scheduler" tickInterval=10s maxAttempts=3
```

(One line only, over the full ~20-minute run.) Attribution: `pkg/services/ngalert/schedule/schedule.go:L157`; the periodic loop `schedulePeriodic` at `pkg/services/ngalert/schedule/schedule.go:L205` has no default per-tick Info log.

- The usage-stats readiness line shown in 1a (`logger=infra.usagestats ... "Usage stats are ready to report"`), once.

### Q1 orchestration note & rationale

Background services are launched by `Server.Run()` which iterates the registry and starts each as a goroutine (`pkg/server/server.go:L139-L180`), and the set of services is assembled in `pkg/registry/backgroundsvcs/background_services.go`.

Rationale: with no user traffic, request-driven loggers stay silent, so the only repeated lines are timer-driven background services; at default `info` level the two that log on each tick at Info are the cleanup service and the plugins update checker, both on 10-minute tickers — which is why (i) nothing recurs inside a strict 60-second window and (ii) the true recurrence cadence is 10 minutes.

---

## Q2 — On startup, what output confirms the database schema version is already up to date?

This was proven with a **two-run technique** against the default SQLite database (`type = sqlite3`, `conf/defaults.ini:L123`). Run A used a **fresh** database (migrations execute); Run B restarted against the **same, now-migrated** database (nothing to do).

**Run A (fresh database) — migrations are performed.** Producing command (filter the Run A startup console log):

```
$ grep 'DB migrations\|migrations completed' consoleA.log
logger=migrator t=2026-07-01T23:02:40.656537702Z level=info msg="Starting DB migrations"
logger=migrator t=2026-07-01T23:02:42.303833283Z level=info msg="migrations completed" performed=626 skipped=0 duration=1.647102587s
logger=resource-migrator t=2026-07-01T23:02:42.454704692Z level=info msg="Starting DB migrations"
logger=resource-migrator t=2026-07-01T23:02:42.507713875Z level=info msg="migrations completed" performed=18 skipped=0 duration=52.928007ms
```

**Run B (same migrated database) — schema is up to date.** Producing command (filter the second, migrated-DB startup console log):

```
$ grep 'DB migrations\|migrations completed' consoleB.log
logger=migrator t=2026-07-01T23:16:39.667629778Z level=info msg="Starting DB migrations"
logger=migrator t=2026-07-01T23:16:39.674354263Z level=info msg="migrations completed" performed=0 skipped=626 duration=731.095µs
logger=resource-migrator t=2026-07-01T23:16:39.849340522Z level=info msg="Starting DB migrations"
logger=resource-migrator t=2026-07-01T23:16:39.849698523Z level=info msg="migrations completed" performed=0 skipped=18 duration=33.037µs
```

Claim + evidence pairing:

- The line that confirms the check ran: `msg="Starting DB migrations"` — emitted at `pkg/services/sqlstore/migrator/migrator.go:L247`.
- The line that confirms **schema up to date**: on the second start, `msg="migrations completed" performed=0 skipped=626 duration=731.095µs` — i.e., **`performed=0`** (zero migrations applied) with all 626 **skipped** — emitted at `pkg/services/sqlstore/migrator/migrator.go:L287` (`logger.Info("migrations completed", "performed", migrationsPerformed, "skipped", migrationsSkipped, "duration", ...)`). Contrast with Run A's `performed=626 skipped=0`.
- Note the second `logger=resource-migrator` migrator (the unified-storage schema) shows the same pattern (`performed=18 skipped=0` fresh → `performed=0 skipped=18` up-to-date).

Rationale: on each start Grafana runs the migrator, which compares recorded migration IDs against the migration list; already-applied migrations are skipped (`Skipping migration: Already executed` at `pkg/services/sqlstore/migrator/migrator.go:L262`, Debug level), so a `performed=0` summary is the definitive "schema already at the current version" signal. (The expected shape of a health response and the `version==BuildVersion` wiring are separately confirmed by `pkg/api/health_test.go:L18` `TestHealthAPI_Version`.)

---

## Q3 — Query the running instance's API and report the exact `version` string.

The value was obtained at runtime by querying the running instance's health endpoint.

**Command and full verbatim response (primary, documented build):**

```
curl -si http://localhost:3000/api/health
```

```
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json; charset=UTF-8
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Wed, 01 Jul 2026 23:18:11 GMT
Content-Length: 75

{
  "database": "ok",
  "version": "11.5.0-pre",
  "commit": "4550cfb5b7"
}
```

Claim: the exact `version` string returned by the running instance is **`11.5.0-pre`** (with `"commit": "4550cfb5b7"` and `"database": "ok"`). Report this exact literal; do not paraphrase.

Attribution: `GET /api/health` is served by `apiHealthHandler` (`pkg/api/http_server.go:L710`), registered as middleware at `pkg/api/http_server.go:L634` (`m.Use(hs.apiHealthHandler)`). The version field is set at `pkg/api/http_server.go:L720` (`data.Version = hs.Cfg.BuildVersion`), guarded by `!hs.Cfg.Anonymous.HideVersion` at `pkg/api/http_server.go:L719` (default shows the version); commit is set at `pkg/api/http_server.go:L721` (`data.Commit = hs.Cfg.BuildCommit`).

### Q3 build provenance (must be explained)

Data flow and why the value is `11.5.0-pre`:

- `version` flows: `pkg/cmd/grafana/main.go:L17` `var version` → `setting.BuildVersion` (`pkg/setting/setting.go:L1076`, `cfg.BuildVersion = BuildVersion`) → `apiHealthHandler` `data.Version` (`pkg/api/http_server.go:L720`) → JSON `version`.
- The compiled fallback is `var version = "9.2.0"` at `pkg/cmd/grafana/main.go:L17`.
- The documented build overrides it via the linker flag `-X main.version=%s` at `pkg/build/cmd.go:L247`; that value derives from `package.json` (`"version": "11.5.0-pre"` at `package.json:L6`, read by `OpenPackageJSON` at `pkg/build/version.go:L16-L31`). Because the runnable binary here was built with that ldflag, the endpoint returns `11.5.0-pre`.

Prove the fallback empirically (so the number is not misinterpreted): a binary built with a bare `CGO_ENABLED=1 go build -o /tmp/grafana_noldflags ./pkg/cmd/grafana` (NO `-X main.version` ldflag) reports the compiled fallback. Command and verbatim response (run on an alternate port):

```
curl -si http://localhost:3001/api/health
```

```
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json; charset=UTF-8
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Wed, 01 Jul 2026 23:39:04 GMT
Content-Length: 62

{
  "database": "ok",
  "version": "9.2.0",
  "commit": "NA"
}
```

And its CLI self-report:

```
$ /tmp/grafana_noldflags -v
grafana version 9.2.0
```

Rationale: The endpoint reports whatever `BuildVersion` the binary was compiled with. The documented/`make`-driven build injects `11.5.0-pre` (from `package.json`), which is what the running instance returned; a no-ldflags build returns the source fallback `9.2.0` with `commit=NA`. Both are reported exactly as observed.

---

## Q4 — During the dashboard view → panel-editor transition, does the datasource picker automatically resolve to the datasource already defined in the panel's queries? Which part of the codebase is responsible?

Proven via the existing jest test (run non-interactively). Command:

```
corepack yarn jest public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx -t "should load data source" --watchAll=false --ci
```

Verbatim result (test-runner markers):

```
PASS public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx

Test Suites: 1 passed, 1 total
Tests:       24 skipped, 1 passed, 25 total
Snapshots:   0 total
Time:        3.881 s, estimated 4 s
Ran all test suites matching /public\/app\/features\/dashboard-scene\/panel-edit\/PanelDataPane\/PanelDataQueriesTab.test.tsx/i with tests matching "should load data source".
```

The passing test asserts (`public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx:L361-L365`):

```
it('should load data source', async () => {
  const { queriesTab } = await setupScene('panel-1');

  expect(queriesTab.state.datasource).toEqual(ds1Mock);
  expect(queriesTab.state.dsSettings).toEqual(instance1SettingsMock);
});
```

Claim + evidence: `panel-1`'s query runner already has a datasource (`uid: 'gdev-testdata'`), and after the tab activates, `queriesTab.state.datasource` equals `ds1Mock` and `queriesTab.state.dsSettings` equals `instance1SettingsMock` — both `uid: 'gdev-testdata'` (test `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx:L95,L131,L139`). So **yes**, the picker automatically resolves to and displays the panel's already-defined datasource.

Attribution (the responsible code): `PanelDataQueriesTab.loadDataSource()` at `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx:L63`, invoked when the tab activates (`...:L60`). It reads the datasource already on the panel's query runner at `...:L71` (`let datasourceToLoad = this.queryRunner.state.datasource;`); when that is set, the `else` branch resolves it via `getDataSourceSrv().get(datasourceToLoad)` and `getDataSourceSrv().getInstanceSettings(datasourceToLoad)` (`...:L101-L102`) and commits it with `this.setState({ datasource, dsSettings })` (`...:L106`), which drives the picker selection. Only when no datasource is defined does it fall back to last-used/default (`...:L77-L99`) — demonstrated by the sibling test `'should load default datasource if the datasource passed is not found'` (`panel-6`). The panel-edit scene that hosts this tab is built during the view→edit transition by `PanelEditor` (`public/app/features/dashboard-scene/panel-edit/PanelEditor.tsx`).

Rationale: the queries tab does not reset the datasource on entry; it re-hydrates the picker from the query runner's existing `datasource`, so the editor opens showing the datasource already defined in the panel's queries.

Note: the `jest-haste-map` "duplicate manual mock" warnings emitted during the run are pre-existing repository noise unrelated to this test's PASS.

---

## Q5 — When the rule edit view opens, does the backend rule definition populate the query state? Prove it and name the responsible code.

Proven via a **temporary** jest test (created outside version control's committed set, run non-interactively, then **deleted** — the working tree was verified clean afterward). The test constructed a mock Grafana-managed rule (`RuleWithLocation`) whose backend `grafana_alert.data` held two queries and `condition = 'C'`, then ran the mapper.

Command:

```
corepack yarn jest public/app/features/alerting/unified/utils/rule-form.q5observation.test.ts --watchAll=false --ci
```

Verbatim result (observed values + markers; the test prints via `process.stdout.write` because the repo's `jest-fail-on-console` setup fails tests that call `console.log`):

```
PASS public/app/features/alerting/unified/utils/rule-form.q5observation.test.ts
Q5_OBSERVED_queries_count=2
Q5_OBSERVED_queries=[{"refId":"A","datasourceUid":"my-prom-uid","queryType":"range","relativeTimeRange":{"from":600,"to":0},"model":{"refId":"A","expr":"up"}},{"refId":"C","datasourceUid":"__expr__","queryType":"","model":{"refId":"C","type":"threshold","expression":"A"}}]
Q5_OBSERVED_condition=C
Q5_OBSERVED_queries_is_same_ref_as_ga_data=true
Q5_OBSERVED_prefilled_queries=[{"refId":"A","datasourceUid":"my-prom-uid","queryType":"range","relativeTimeRange":{"from":600,"to":0},"model":{"refId":"A","expr":"up"}},{"refId":"C","datasourceUid":"__expr__","queryType":"","model":{"refId":"C","type":"threshold","expression":"A"}}]
Q5_OBSERVED_prefilled_condition=C

Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
```

Claim + evidence: **yes** — the backend rule definition populates the form's query state. The mapper's `queries` output equals the backend `ga.data` (two queries), and `Q5_OBSERVED_queries_is_same_ref_as_ga_data=true` shows it is the **same array reference** (a direct assignment, `queries: ga.data`), and `condition` equals the backend `ga.condition` (`C`). The wrapper used by the edit form produced the same populated `queries`/`condition` (`Q5_OBSERVED_prefilled_*`).

Attribution (the responsible code): `rulerRuleToFormValues` at `public/app/features/alerting/unified/utils/rule-form.ts:L365`. For a Grafana-managed rule it assigns `queries: ga.data` and `condition: ga.condition` (`ga = rule.grafana_alert`). The mock used here is a Grafana **alerting** rule (it defines `no_data_state`/`exec_err_state` and no `record`), so it takes the `isGrafanaRulerRule` branch that assigns `queries: ga.data` at `public/app/features/alerting/unified/utils/rule-form.ts:L402` and `condition: ga.condition` at `...:L403`; the identical assignment for the Grafana **recording**-rule branch is at `...:L380`/`...:L381`. The edit form consumes this via the wrapper `formValuesFromExistingRule` at `public/app/features/alerting/unified/utils/rule-form.ts:L916` (`return ignoreHiddenQueries(rulerRuleToFormValues(rule));`), which `AlertRuleForm` uses to compute `defaultValues` when editing an existing rule: `if (existing) { return formValuesFromExistingRule(existing); }` at `public/app/features/alerting/unified/components/rule-editor/alert-rule-form/AlertRuleForm.tsx:L104-L105`, fed into `useForm({ defaultValues })` (`...:L126-L128`).

Rationale: opening the edit view computes the form's default values directly from the existing backend rule, mapping the stored query array (`ga.data`) straight into the form's `queries` and the stored `condition` into `condition`; therefore the query editor is pre-populated from the backend definition rather than reset to empty. Note (honesty): the temporary observation test was removed after capture — `git status` was verified to show no residual test file.

---

## Coverage pass

Confirmation that each named item is answered and where:

- **Q1 — recurring log entries (idle ≥60s):** answered — strict-60s window shows no recurrence (1a); true recurrence is two 10-min entries: `cleanup` `"Completed cleanup jobs"` and `plugins.update.checker` `"Update check succeeded"` (1b); non-recurring one-time lines disambiguated (1c). Responsible code cited (`pkg/services/cleanup/cleanup.go:L80,L128`; `pkg/services/updatechecker/plugins.go:L78,L123`; `pkg/server/server.go:L139-L180`).
- **Q2 — "schema version up to date":** answered — two-run technique; `"Starting DB migrations"` (`pkg/services/sqlstore/migrator/migrator.go:L247`) and `"migrations completed" performed=0 skipped=626` on the second start (`pkg/services/sqlstore/migrator/migrator.go:L287`).
- **Q3 — the exact `version` string:** answered — `11.5.0-pre` from `curl -si http://localhost:3000/api/health` (with `commit=4550cfb5b7`); provenance explained and the fallback `9.2.0` proven; responsible code cited (`pkg/api/http_server.go:L719-L721`, `pkg/cmd/grafana/main.go:L17`, `pkg/build/cmd.go:L247`, `pkg/setting/setting.go:L1076`).
- **Q4 — picker resolves to the panel's datasource + which code is responsible:** answered — jest `PASS` of `'should load data source'`; responsible: `PanelDataQueriesTab.loadDataSource()` reading `this.queryRunner.state.datasource` (`public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx:L63,L71,L101-L106`).
- **Q5 — backend rule populates query state + which code is responsible:** answered — temp jest `PASS` with `queries === ga.data`; responsible: `rulerRuleToFormValues` (`public/app/features/alerting/unified/utils/rule-form.ts:L365`, `queries: ga.data` at `public/app/features/alerting/unified/utils/rule-form.ts:L402` / `:L380`) via `formValuesFromExistingRule` (`public/app/features/alerting/unified/utils/rule-form.ts:L916`) invoked by `public/app/features/alerting/unified/components/rule-editor/alert-rule-form/AlertRuleForm.tsx:L104-L105`.
- **Read-only compliance & final repository state:** the repository was not modified except for this document, and all temporary observation scripts/tests were deleted. The final working tree is clean — `git status --porcelain` produces **no output** — and, relative to the baseline commit `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`, the only changed path is the single added deliverable:

```
$ git diff --name-status 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff --
A	blitzy/documentation/grafana_4550cfb5b728.md
```
