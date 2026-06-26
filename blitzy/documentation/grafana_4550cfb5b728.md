# Grafana Runtime Investigation — Idle Health, Migrations, Build Info, Dashboard Scenes & Alerting

This report answers five runtime-behavior questions about Grafana. Every answer is grounded in the source code as the authoritative source of truth and corroborated by runtime evidence captured from a locally built-and-run instance (idle log output, startup migration logs, live API responses, and Jest test-script output). For each question the document presents, in order: **(a)** the question verbatim, **(b)** the captured runtime evidence verbatim (in fenced code blocks), **(c)** the rationale/reasoning, and **(d)** the responsible-code citation (file path + line numbers, verified at the HEAD commit below).

**Subject under test**

- Repository branch: `grafana_4550cfb5b728`
- HEAD commit: `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`
- Package version: `11.5.0-pre` (`package.json` line 6)
- Toolchain: Go 1.23.1 (`go.mod` line 3), Node v22.x (`.nvmrc` pins v22.11.0), Yarn 4.5.3 (`package.json` line 453)
- Method: code inspection + live runtime evidence (logs, API JSON, Jest test output)

---

## Build & Run Methodology

The instance was built and run before any evidence was captured. This methodology is recorded explicitly because the version string reported by the API (O3) depends on the linker flags used at build time — so the exact build command is part of the evidence.

Backend build (injects the real version via ldflags — equivalent to `make build-backend` / `Makefile` line 196):

```
# 1) Generate the wire DI code the server entrypoint needs (Makefile gen-go target).
#    This writes the gitignored pkg/server/wire_gen.go (which defines Initialize()).
go run ./pkg/build/wire/cmd/wire/main.go gen -tags oss ./pkg/server

# 2) Build the real grafana binary with version injected through linker flags.
CGO_ENABLED=1 go build \
  -ldflags '-w -X main.version=11.5.0-pre -X main.commit=4550cfb5b7 -X main.buildstamp=1734099722 -X main.buildBranch=grafana_4550cfb5b728' \
  -o ./bin/linux-amd64/grafana ./pkg/cmd/grafana
```

Run (server listens on http://localhost:3000 — `conf/defaults.ini` line 41; admin/admin — `conf/defaults.ini` lines 328 & 331; default `level = info` — `conf/defaults.ini` line 1074):

```
./bin/linux-amd64/grafana server \
  --homepath <repo-root> \
  cfg:paths.data=<data-dir> cfg:paths.logs=<logs-dir> \
  cfg:server.http_port=3000
# (append cfg:log.level=debug to capture DEBUG-level periodic activity for O1)
```

Startup banner confirming the injected version (verbatim captured line):

```
logger=settings t=2026-06-26T19:58:03.011136327Z level=info msg="Starting Grafana" version=11.5.0-pre commit=4550cfb5b7 branch=grafana_4550cfb5b728 compiled=2024-12-13T14:22:02Z
```

Frontend / tests (Node 22, Yarn 4.5.3):

```
yarn install --immutable        # contribute/developer-guide.md line 71
# Jest default script enables watch mode ("test": "jest --notify --watch", package.json line 26),
# so specs are run NON-interactively with --watchAll=false:
yarn jest <spec-path> --watchAll=false --verbose
```

**Important notes on the build method (relevant to O3):**

- The reported API version is governed by the build's linker flag `-X main.version=%s` (`pkg/build/cmd.go` line 247). When built that way the value is `11.5.0-pre` (`package.json` line 6). A plain `go build`/`go run` WITHOUT those flags would instead leave the compiled-in fallback `var version = "9.2.0"` (`pkg/cmd/grafana/main.go` line 17). This is why the document records the exact build command alongside the actual API value.
- The correct Make target for the real runnable binary is `make build-backend` (`Makefile` line 196), which runs `go run build.go build-backend` → `doBuild("grafana", "./pkg/cmd/grafana", …)` (`pkg/build/cmd.go` line 81). This is what the manual command above reproduces. It is **not** `make build-server` (`Makefile` line 201), which builds the deprecated server shim `grafana-server` from `./pkg/cmd/grafana-server` (`pkg/build/cmd.go` line 91) — a different binary that is not the one queried for O3.
- `bin/` and `pkg/server/wire_gen.go` are git-ignored build artifacts; no committed repository file was changed by the investigation.

---

## SECTION O1 — Idle background logging (recurring entries after ≥60 s idle)

### (a) Question (verbatim)

> After the server has been running for at least 60 seconds with no user requests, what are the exact recurring log entries that appear? Provide the actual log output as runtime evidence.

### (b) Runtime evidence (verbatim — server held idle with ZERO user requests, started 19:58:02)

The prominent guaranteed recurring INFO line — emitted on a **10-minute** cadence (proven by two consecutive ticks exactly 10 minutes apart):

```
logger=cleanup t=2026-06-26T20:08:04.908749806Z level=info msg="Completed cleanup jobs" duration=54.310109ms
logger=cleanup t=2026-06-26T20:18:04.911003261Z level=info msg="Completed cleanup jobs" duration=56.414094ms
```

At DEBUG level the cleanup tick is preceded by the full job list:

```
logger=cleanup t=2026-06-26T20:08:03.197573539Z level=debug msg="Starting cleanup jobs" jobs="[\"clean up temporary files\" \"delete expired snapshots\" \"delete expired dashboard versions\" \"delete expired images\" \"cleanup old annotations\" \"expire old user invites\" \"delete stale query history\" \"expire old email verifications\" \"cleanup trash dashboards\" \"delete stale short URLs\"]"
```

The alerting scheduler logs a one-time INFO at startup, then advances a 10-second ticker whose per-tick output is DEBUG (not INFO):

```
logger=ngalert.scheduler t=2026-06-26T19:58:04.854129512Z level=info msg="Starting scheduler" tickInterval=10s maxAttempts=3
logger=ngalert.scheduler t=2026-06-26T19:58:10.000605332Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-06-26T19:58:20.000587512Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
```

Other recurring DEBUG-level activity observed on a ~60-second cadence while idle:

```
logger=ngalert.multiorg.alertmanager t=2026-06-26T19:58:03.182636592Z level=debug msg="Synchronizing Alertmanagers for orgs"
logger=ngalert.sender.router t=2026-06-26T19:58:03.193115479Z level=debug msg="Attempting to sync admin configs" count=0
logger=secrets t=2026-06-26T19:59:03.197819856Z level=debug msg="Removing expired data keys from cache..."
logger=ssosettings.service t=2026-06-26T19:59:03.19787511Z level=debug msg="reloading SSO Settings for all providers"
```

### (c) Rationale

- Grafana runs long-lived background services as goroutines; idle-time recurrence comes from their periodic tickers, NOT from request handling.
- At the **default `level = info`**, a strict 60-second idle window is nearly silent: after the startup burst, the only post-startup INFO is a ONE-TIME `logger=infra.usagestats msg="Usage stats are ready to report"` (~+70 s) — it does not recur within minutes. Therefore, within 60 s you may see no NEW recurring INFO line; the first guaranteed RECURRING INFO line appears at the **10-minute** mark.
- The single prominent guaranteed recurring INFO entry is `logger=cleanup ... msg="Completed cleanup jobs"`, emitted once per 10-minute tick. The two captured ticks at `20:08:04` and `20:18:04` are exactly 10 minutes apart, proving the cadence matches the code's `time.NewTicker(time.Minute * 10)`.
- Shorter-cadence recurrence (scheduler every 10 s; secrets/alertmanager/SSO every ~60 s) is logged at DEBUG, which is why the run was also captured at `cfg:log.level=debug` to surface it. The remote-cache DB GC ticker also fires every 10 minutes, but its periodic loop (`internalRunGC`) emits a log line **only if the garbage-collect `DELETE` itself fails**, and that line is at **ERROR** level (line 51), not DEBUG. On a healthy idle instance the `DELETE` succeeds (deleting zero or more expired rows is still success), so the periodic GC loop is silent at every level. (The DEBUG `"Deletion of expired key failed"` line at line 74 lives in the cache `Get` path, not in the periodic GC loop.)
- Conclusion: **The exact recurring INFO log entry on an idle instance is `level=info msg="Completed cleanup jobs" duration=…` from `logger=cleanup`, recurring every 10 minutes.** Additional recurring entries exist only at DEBUG (scheduler 10 s; secrets/alertmanager/router/SSO ~60 s).

### (d) Responsible code

- `pkg/services/cleanup/cleanup.go`:
  - line 77 — `func (srv *CleanUpService) Run(ctx context.Context) error`
  - line 80 — `ticker := time.NewTicker(time.Minute * 10)` (the 10-minute cadence)
  - lines 82–86 — the `select` loop: `case <-ticker.C: srv.clean(ctx)` and `case <-ctx.Done(): return ctx.Err()`
  - line 116 — `logger.Debug("Starting cleanup jobs", …)` (DEBUG job list)
  - line 128 — `logger.Info("Completed cleanup jobs", "duration", time.Since(start))` (the recurring INFO line)
- `pkg/services/ngalert/schedule/schedule.go`:
  - line 157 — `sch.log.Info("Starting scheduler", "tickInterval", sch.baseInterval, "maxAttempts", sch.maxAttempts)`
  - line 158 — ticker advanced at `baseInterval` (per-tick output is DEBUG)
- `pkg/infra/usagestats/service/service.go` — line 76 `sendReportTicker := time.NewTicker(nextSendInterval)` (~24 h cadence), line 117 one-time INFO "Usage stats are ready to report"; gated by `reporting_enabled = true` (`conf/defaults.ini` line 258)
- `pkg/infra/remotecache/database_storage.go` — line 30 `ticker := time.NewTicker(time.Minute * 10)` (GC ticker) → line 36 `dc.internalRunGC()` per tick → `internalRunGC` (line 41). The periodic loop logs **only on GC failure**, and at **ERROR** level — line 51 `dc.log.Error("failed to run garbage collect", "error", err)`; it is silent on success. The DEBUG line 74 `dc.log.Debug("Deletion of expired key failed: %v", err)` is inside `Get` (expired-key deletion), unrelated to the periodic GC loop.

---


## SECTION O2 — Database migration check (schema version up to date)

### (a) Question (verbatim)

> I want you to give me the runtime evidence of the database migration check. When the server starts what is the specific output that confirms that the schema version is up to date.

### (b) Runtime evidence (verbatim)

All three captures below were produced by running `./bin/linux-amd64/grafana server` against a dedicated, throw-away data directory (`cfg:paths.data=/tmp/grafana-o2-fresh`) and reading the migrator output from the captured stdout log. These migration runs are deliberately separate from the idle-behavior run used for O1 (and carry their own, later timestamps), because demonstrating both the fresh `performed=N` case and the already-migrated `performed=0` case inherently requires two successive starts against the same database — which cannot come from the single idle run. Every fenced block contains only verbatim, consecutive log lines exactly as captured; where output is long, the omitted portion is described in prose **outside** the fence (no placeholder text appears inside any evidence block).

On an ALREADY-MIGRATED database (schema up to date) — INFO level — the migrator's entire output is the lock / start / complete / unlock envelope with `performed=0`, having executed NOTHING. The following is the complete, unedited INFO migrator output for both migrator instances (no lines omitted):

```
logger=migrator t=2026-06-26T22:28:44.013933351Z level=info msg="Locking database"
logger=migrator t=2026-06-26T22:28:44.013951433Z level=info msg="Starting DB migrations"
logger=migrator t=2026-06-26T22:28:44.020762918Z level=info msg="migrations completed" performed=0 skipped=626 duration=667.799µs
logger=migrator t=2026-06-26T22:28:44.020921724Z level=info msg="Unlocking database"
logger=resource-migrator t=2026-06-26T22:28:44.160555816Z level=info msg="Locking database"
logger=resource-migrator t=2026-06-26T22:28:44.160569193Z level=info msg="Starting DB migrations"
logger=resource-migrator t=2026-06-26T22:28:44.161006466Z level=info msg="migrations completed" performed=0 skipped=18 duration=91.386µs
logger=resource-migrator t=2026-06-26T22:28:44.16114054Z level=info msg="Unlocking database"
```

At DEBUG level the same already-migrated run additionally emits one `"Skipping migration: Already executed"` line per previously-applied migration. The following is a verbatim, consecutive slice of the core migrator's DEBUG output — the lock / start envelope followed by the first six skip lines exactly as captured:

```
logger=migrator t=2026-06-26T22:29:02.673122708Z level=info msg="Locking database"
logger=migrator t=2026-06-26T22:29:02.673140974Z level=info msg="Starting DB migrations"
logger=migrator t=2026-06-26T22:29:02.678938638Z level=debug msg="Skipping migration: Already executed" id="create migration_log table"
logger=migrator t=2026-06-26T22:29:02.678960009Z level=debug msg="Skipping migration: Already executed" id="create user table"
logger=migrator t=2026-06-26T22:29:02.678965515Z level=debug msg="Skipping migration: Already executed" id="add unique index user.login"
logger=migrator t=2026-06-26T22:29:02.678976534Z level=debug msg="Skipping migration: Already executed" id="add unique index user.email"
logger=migrator t=2026-06-26T22:29:02.678981237Z level=debug msg="Skipping migration: Already executed" id="drop index UQE_user_login - v1"
logger=migrator t=2026-06-26T22:29:02.67898648Z level=debug msg="Skipping migration: Already executed" id="drop index UQE_user_email - v1"
```

These `"Skipping migration: Already executed"` DEBUG lines continue for every previously-applied migration: the core `logger=migrator` emits 626 of them (one per registered core migration) and the `logger=resource-migrator` emits 18, for 644 skip lines in total (626 + 18 = 644). Each migrator then closes with its terminal INFO completion line — captured verbatim from the same DEBUG run:

```
logger=migrator t=2026-06-26T22:29:02.681816281Z level=info msg="migrations completed" performed=0 skipped=626 duration=2.878893ms
logger=resource-migrator t=2026-06-26T22:29:02.855240364Z level=info msg="migrations completed" performed=0 skipped=18 duration=106.523µs
```

For contrast, the FIRST run against a FRESH database actually applies migrations (`performed=626`), emitting an `"Executing migration"`/`"Migration successfully executed"` pair per applied migration. The following is the verbatim, consecutive opening slice of that fresh run (lock / start envelope followed by the first two applied-migration pairs, no lines omitted within this slice):

```
logger=migrator t=2026-06-26T22:24:57.400109453Z level=info msg="Locking database"
logger=migrator t=2026-06-26T22:24:57.400130087Z level=info msg="Starting DB migrations"
logger=migrator t=2026-06-26T22:24:57.400347075Z level=info msg="Executing migration" id="create migration_log table"
logger=migrator t=2026-06-26T22:24:57.400546287Z level=info msg="Migration successfully executed" id="create migration_log table" duration=198.948µs
logger=migrator t=2026-06-26T22:24:57.402793207Z level=info msg="Executing migration" id="create user table"
logger=migrator t=2026-06-26T22:24:57.402954664Z level=info msg="Migration successfully executed" id="create user table" duration=161.701µs
```

This `"Executing migration"`/`"Migration successfully executed"` sequence repeats for all 626 core migrations; the fresh run then terminates both migrators with their completion lines — captured verbatim:

```
logger=migrator t=2026-06-26T22:24:59.712862152Z level=info msg="migrations completed" performed=626 skipped=0 duration=2.312533577s
logger=resource-migrator t=2026-06-26T22:24:59.817560304Z level=info msg="Starting DB migrations"
logger=resource-migrator t=2026-06-26T22:24:59.873527946Z level=info msg="migrations completed" performed=18 skipped=0 duration=55.871442ms
```

### (c) Rationale

- The migrator compares each registered migration ID against the `migration_log` registry table. Already-applied migrations are skipped; only new ones execute.
- The **definitive "schema is up to date" evidence is the terminal INFO line `msg="migrations completed" performed=0 skipped=<n>`** — `performed=0` means zero migrations needed to run, i.e. every registered migration was already present in `migration_log`. The DEBUG `"Skipping migration: Already executed"` lines (one per registered migration) corroborate this at finer granularity.
- The difference between the fresh run (`performed=626 skipped=0`) and the subsequent run (`performed=0 skipped=626`) demonstrates the mechanism directly: the same 626 registered migrations move from "performed" to "skipped" once applied.
- Note there are two migrator instances: the main `logger=migrator` (core schema, 626 migrations) and `logger=resource-migrator` (18 migrations); both report `performed=0` when up to date.

### (d) Responsible code

- `pkg/services/sqlstore/migrator/migrator.go`:
  - line 97 — `mg.tableName = "migration_log"` (the schema-version registry table)
  - line 247 — `logger.Info("Starting DB migrations")`
  - lines 260–262 — `_, exists := mg.logMap[m.Id()]; if exists { logger.Debug("Skipping migration: Already executed", "id", m.Id()) … }`
  - line 287 — `logger.Info("migrations completed", "performed", migrationsPerformed, "skipped", migrationsSkipped, "duration", time.Since(start))`
  - lines 356 & 392 — per-applied `logger.Info("Executing migration", "id", …)` / `logger.Info("Migration successfully executed", …)` (seen only on the fresh run)
- `pkg/services/sqlstore/migrations/migrations.go` — the master orchestrator that registers all migration groups.

---


## SECTION O3 — Build information via API (exact `version` string)

### (a) Question (verbatim)

> Can you verify the current build information by querying the api endpoints of the running instance. What is the exact value of version string reported by the api. Give me runtime evidence to show that this value was reported by querying the api.

### (b) Runtime evidence (verbatim)

Authenticated query to the health endpoint (HTTP/1.1 200, `Content-Type: application/json`):

```
$ curl -s -u admin:admin http://localhost:3000/api/health
{
  "database": "ok",
  "version": "11.5.0-pre",
  "commit": "4550cfb5b7"
}
```

The same endpoint queried anonymously returns the identical payload (version-hiding is disabled by default, so the field is present without auth):

```
$ curl -s http://localhost:3000/api/health
{
  "database": "ok",
  "version": "11.5.0-pre",
  "commit": "4550cfb5b7"
}
```

Cross-check via the frontend settings `buildInfo` object (GET `/api/frontend/settings`):

```
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

### (c) Rationale

- **The exact `version` string reported by the API is `11.5.0-pre`.** Two independent API surfaces report it consistently: `/api/health` (`"version": "11.5.0-pre"`) and `/api/frontend/settings` `buildInfo` (`"version": "11.5.0-pre"`, and `versionString: "Grafana v11.5.0-pre (4550cfb5b7)"`).
- The value originates from `hs.Cfg.BuildVersion`, which is set from the binary's compiled-in `main.version`. Because the binary was built with `-X main.version=11.5.0-pre` (see Methodology), the API reports `11.5.0-pre` rather than the source-level fallback `"9.2.0"`. This is why the document records the exact build command alongside the API value — the runtime value is build-dependent and the running instance is the source of truth.
- The `version` field appears in `/api/health` only when `!hs.Cfg.Anonymous.HideVersion`. With version-hiding at its default (disabled), the field is present for both authenticated and anonymous callers, which the two captured `curl` responses confirm.

### (d) Responsible code

- `pkg/api/http_server.go`:
  - lines 694–699 — `type healthResponse struct { Database string \`json:"database"\`; Version string \`json:"version,omitempty"\`; Commit string \`json:"commit,omitempty"\`; … }`
  - line 710 — `func (hs *HTTPServer) apiHealthHandler(c *contextmodel.ReqContext)`
  - lines 716–718 — `data := healthResponse{Database: "ok"}`
  - line 719 — `if !hs.Cfg.Anonymous.HideVersion {`
  - line 720 — `data.Version = hs.Cfg.BuildVersion` (and line 721 `data.Commit = …`)
- `pkg/api/index.go` — line 128 — `BuildVersion: setting.BuildVersion` (feeds the frontend settings `buildInfo`)
- `pkg/build/cmd.go` — line 247 — `b.WriteString(fmt.Sprintf(" -X main.version=%s", opts.version))` (linker flag that injects the version)
- `pkg/cmd/grafana/main.go` — line 17 — `var version = "9.2.0"` (the compiled-in fallback used only when ldflags are absent); line 47 — `commands.ServerCommand(version, …)`

---


## SECTION O4 — Datasource picker auto-resolution (dashboard → panel editor, Scenes)

### (a) Question (verbatim)

> I also want to understand the dashboard scene architecture. Investigate its initialization logic during the transition from the dashboard view to the panel editor. Specifically, provide test script outputs to prove whether the picker automatically resolves to and displays the datasource already defined in the panel queries. Tell me which part of the codebase is responsible for this.

### (b) Runtime evidence (verbatim — existing Jest spec, run NON-interactively)

Command:

```
yarn jest public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx --watchAll=false --verbose
```

Result — the complete, unedited output of the command above (no lines omitted). The leading `jest-haste-map: duplicate manual mock found` blocks and the `punycode` `DeprecationWarning` are pre-existing Grafana-monorepo Jest warnings unrelated to this test; they are emitted on every Jest invocation in this repository and are reproduced here verbatim for fidelity:

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

(node:120999) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.
(Use `node --trace-deprecation ...` to show where the warning was created)
PASS public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx
  PanelDataQueriesTab
    Adding queries
      ✓ can add a new query (26 ms)
      ✓ Can add a new query when datasource is mixed (7 ms)
    PanelDataQueriesTab
      ✓ renders query group top section (135 ms)
      ✓ renders queries rows when queries are set (29 ms)
      ✓ allow to add a new query when user clicks on add new (119 ms)
      ✓ allow to remove a query when user clicks on remove (372 ms)
    query options
      activation
        ✓ should load data source (5 ms)
        ✓ should store loaded data source in local storage (5 ms)
        ✓ should load default datasource if the datasource passed is not found (6 ms)
      data source change
        ✓ should load new data source (5 ms)
        ✓ changing from one plugin to another (4 ms)
        ✓ changing from a plugin to a dashboard data source (4 ms)
        ✓ changing from dashboard data source to a plugin (4 ms)
      query options change
        time overrides
          ✓ should create PanelTimeRange object (5 ms)
          ✓ should update hoverHeader (4 ms)
          ✓ should update PanelTimeRange object on time options update (6 ms)
          ✓ should remove PanelTimeRange object on time options cleared (7 ms)
        max data points and interval
          ✓ should update max data points (7 ms)
          ✓ should update min interval (3 ms)
          ✓ should update min interval to undefined if empty input (4 ms)
        query caching
          ✓ updates cacheTimeout and queryCachingTTL (5 ms)
      query inspection
        ✓ allows query inspection from the tab (4 ms)
      change queries
        plugin queries
          ✓ should update queries (4 ms)
        dashboard queries
          ✓ should update queries (6 ms)
          ✓ should load last used data source if no data source specified for a panel (3 ms)

Test Suites: 1 passed, 1 total
Tests:       25 passed, 25 total
Snapshots:   0 total
Time:        4.675 s, estimated 87 s
Ran all test suites matching /public\/app\/features\/dashboard-scene\/panel-edit\/PanelDataPane\/PanelDataQueriesTab.test.tsx/i.
```

The decisive test body (`PanelDataQueriesTab.test.tsx` lines 361–366) — include verbatim:

```ts
it('should load data source', async () => {
  const { queriesTab } = await setupScene('panel-1');

  expect(queriesTab.state.datasource).toEqual(ds1Mock);
  expect(queriesTab.state.dsSettings).toEqual(instance1SettingsMock);
});
```

Supporting facts: the `testDashboard` fixture's panels define their queries with `datasource: { type: 'grafana-testdata-datasource', uid: 'gdev-testdata' }`; the mocked `getDataSourceSrv().get('gdev-testdata')` returns `ds1Mock` and `getInstanceSettings('gdev-testdata')` returns `instance1SettingsMock`. The fallback test `should load default datasource if the datasource passed is not found` (lines 377–388) asserts `config.defaultDatasource === 'gdev-testdata'` and that an unknown datasource resolves to `defaultDsMock`.

### (c) Rationale

- **Yes — when a panel's queries define a datasource, the picker auto-resolves to and displays it.** On activation, the tab reads the datasource directly from the panel's query runner state (`this.queryRunner.state.datasource`), resolves it through the datasource service, and commits the resolved `datasource` + `dsSettings` into its own state, which the rendered picker (`QueryGroupTopSection`) displays.
- The test proves this deterministically: activating the tab for `panel-1` (whose queries reference `gdev-testdata`) yields `queriesTab.state.datasource === ds1Mock` and `queriesTab.state.dsSettings === instance1SettingsMock` — i.e. the exact datasource defined in the panel's queries, resolved into displayed state. All 25 tests pass.
- Scope/edge cases (documented so the conclusion is correctly bounded): if the panel's queries do NOT specify a datasource, the code first tries the last-used datasource from local storage, and finally falls back to `config.defaultDatasource`. The "auto-resolves to the panel-query datasource" conclusion applies specifically to the case where the panel's queries define a datasource (the common case, and the one the user asked about).

### (d) Responsible code

- `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx`:
  - line 44 — `this.addActivationHandler(() => this.onActivate())`
  - lines 59–60 — `onActivate()` calls `this.loadDataSource()`
  - line 63 — `private async loadDataSource()`
  - line 71 — `let datasourceToLoad = this.queryRunner.state.datasource` (reads the datasource defined in the panel's queries)
  - lines 77–99 — fallback when no query datasource: last-used datasource from local storage
  - lines 100–103 — `datasource = await getDataSourceSrv().get(datasourceToLoad)` and `dsSettings = getDataSourceSrv().getInstanceSettings(datasourceToLoad)`
  - lines 105–106 — `if (datasource && dsSettings) { this.setState({ datasource, dsSettings }) }` (commits resolved values to displayed state)
  - lines 111–112 — final fallback `config.defaultDatasource`
  - lines 307 & 318–325 — the rendered tab reads `{ datasource, dsSettings } = model.useState()` and passes `dsSettings` to `<QueryGroupTopSection …>` (the picker shows the resolved datasource)
- Evidence harness (existing, unchanged): `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx` — `should load data source` (lines 361–366), `should load default datasource if the datasource passed is not found` (lines 377–388).

---


## SECTION O5 — Alerting rule query-state population (edit view open)

### (a) Question (verbatim)

> Investigate the alerting api's rule creation process at runtime to determine if the backend's rule definition populates the query state when the edit view is opened, show me test script output for this and identify the part of the codebase responsible for this behavior.

### (b) Runtime evidence (verbatim — TEMPORARY adjacent Jest spec, executed then DELETED)

A temporary spec `public/app/features/alerting/unified/utils/rule-form.o5tmp.test.ts` was created next to the existing `rule-form.test.ts`, run, and then DELETED (the repository was left unchanged — `git status` clean). It used the existing fixtures `mockRulerGrafanaRule()` and `mockRuleWithLocation()` and called the real `rulerRuleToFormValues` / `formValuesFromExistingRule`. Evidence was emitted via `process.stdout.write` because Grafana's Jest setup enables `jest-fail-on-console`.

Command:

```
yarn jest public/app/features/alerting/unified/utils/rule-form.o5tmp.test.ts --watchAll=false --verbose
```

Output — the complete, unedited output of the command above (no lines omitted). As in O4, the leading `jest-haste-map: duplicate manual mock found` blocks and the `punycode` `DeprecationWarning` are pre-existing Grafana-monorepo Jest warnings, reproduced here verbatim for fidelity. The five `O5-EVIDENCE …` lines are written by the spec itself via `process.stdout.write` (the spec source is reproduced immediately below this output):

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

O5-EVIDENCE INPUT  rule.grafana_alert.data = [{"datasourceUid":"123","refId":"A","queryType":"huh","model":{}}]
O5-EVIDENCE OUTPUT formValues.queries      = [{"datasourceUid":"123","refId":"A","queryType":"huh","model":{}}]
O5-EVIDENCE OUTPUT formValues.condition    = "A"
O5-EVIDENCE reference-identical(queries===grafana_alert.data) = true
O5-EVIDENCE formValuesFromExistingRule().queries = [{"datasourceUid":"123","refId":"A","queryType":"huh","model":{}}]
(node:123404) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.
(Use `node --trace-deprecation ...` to show where the warning was created)
PASS public/app/features/alerting/unified/utils/rule-form.o5tmp.test.ts
  O5: backend rule definition populates query state on edit-view open
    ✓ rulerRuleToFormValues sets queries from rule.grafana_alert.data (reference identity) (3 ms)
    ✓ formValuesFromExistingRule (edit-view entry point) populates queries from rule.grafana_alert.data (2 ms)

Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total
Snapshots:   0 total
Time:        4.489 s
Ran all test suites matching /public\/app\/features\/alerting\/unified\/utils\/rule-form.o5tmp.test.ts/i.
```

For transparency, the temporary spec's source is reproduced below (it was DELETED from the repository after the run; showing it documents exactly how the evidence was produced):

```ts
// TEMPORARY investigation spec (O5) — created only to capture runtime evidence, deleted after the run.
import { mockRulerGrafanaRule, mockRuleWithLocation } from '../mocks';
import { formValuesFromExistingRule, rulerRuleToFormValues } from './rule-form';

describe('O5: backend rule definition populates query state on edit-view open', () => {
  it('rulerRuleToFormValues sets queries from rule.grafana_alert.data (reference identity)', () => {
    const grafanaRule = mockRulerGrafanaRule();
    const ruleWithLocation = mockRuleWithLocation(grafanaRule);
    const formValues = rulerRuleToFormValues(ruleWithLocation);

    process.stdout.write(
      `O5-EVIDENCE INPUT  rule.grafana_alert.data = ${JSON.stringify(grafanaRule.grafana_alert.data)}\n`
    );
    process.stdout.write(`O5-EVIDENCE OUTPUT formValues.queries      = ${JSON.stringify(formValues.queries)}\n`);
    process.stdout.write(`O5-EVIDENCE OUTPUT formValues.condition    = ${JSON.stringify(formValues.condition)}\n`);
    process.stdout.write(
      `O5-EVIDENCE reference-identical(queries===grafana_alert.data) = ${formValues.queries === grafanaRule.grafana_alert.data}\n`
    );

    expect(formValues.queries).toBe(grafanaRule.grafana_alert.data);
    expect(formValues.queries).toEqual(grafanaRule.grafana_alert.data);
    expect(formValues.condition).toEqual(grafanaRule.grafana_alert.condition);
  });

  it('formValuesFromExistingRule (edit-view entry point) populates queries from rule.grafana_alert.data', () => {
    const grafanaRule = mockRulerGrafanaRule();
    const ruleWithLocation = mockRuleWithLocation(grafanaRule);
    const formValues = formValuesFromExistingRule(ruleWithLocation);

    process.stdout.write(
      `O5-EVIDENCE formValuesFromExistingRule().queries = ${JSON.stringify(formValues.queries)}\n`
    );

    expect(formValues.queries).toEqual(grafanaRule.grafana_alert.data);
    expect(formValues.condition).toEqual(grafanaRule.grafana_alert.condition);
  });
});
```

### (c) Rationale

- **Yes — the backend's rule definition populates the query state when the edit view opens.** The edit view computes its React-Hook-Form `defaultValues` by mapping the existing (backend) rule definition into form values; the form's `queries` field is populated directly from the rule definition's `data` array.
- The test proves it precisely: for a Grafana-managed rule whose `grafana_alert.data` is `[{datasourceUid:'123',refId:'A',queryType:'huh',model:{}}]`, `rulerRuleToFormValues(...).queries` is the **same array reference** (`queries === grafana_alert.data` → `true`), and `condition` is carried over (`"A"`). The edit-view entry point `formValuesFromExistingRule(...)` returns the same queries (deep-equal; it passes through `ignoreHiddenQueries`, which clones each query to strip `model.hide`). Both tests pass.
- This is the exact function the editor calls: `AlertRuleForm` computes `defaultValues = formValuesFromExistingRule(existing)` and hands them to `useForm`, so the query editor opens pre-populated with the backend rule's queries.

### (d) Responsible code

- `public/app/features/alerting/unified/utils/rule-form.ts`:
  - line 365 — `export function rulerRuleToFormValues(ruleWithLocation: RuleWithLocation): RuleFormValues`
  - line 402 — `queries: ga.data` (Grafana alerting rule branch; `ga = rule.grafana_alert`) and line 403 — `condition: ga.condition`; line 380 — `queries: ga.data` (Grafana recording-rule branch)
  - lines 909–913 — `export const ignoreHiddenQueries = (ruleDefinition) => ({ …, queries: ruleDefinition.queries?.map((q) => omit(q, 'model.hide')) })`
  - lines 916–917 — `export function formValuesFromExistingRule(rule) { return ignoreHiddenQueries(rulerRuleToFormValues(rule)) }`
- `public/app/features/alerting/unified/components/rule-editor/alert-rule-form/AlertRuleForm.tsx` — lines 103–105 `const defaultValues = useMemo(() => { if (existing) { return formValuesFromExistingRule(existing) } … })`; line 128 — passed as `useForm<RuleFormValues>({ …, defaultValues, … })`
- `pkg/services/ngalert/models/alert_rule.go` — line 743 `Condition string \`json:"condition"\``; line 746 `Data []AlertQuery \`json:"data"\`` (the backend rule definition fields that become the query state)
- Existing harness (unchanged): `public/app/features/alerting/unified/utils/rule-form.test.ts` (tests the reverse mapping only; the forward mapping was proven by the temporary spec above, now deleted).

---

## Methodology compliance & cleanup

- All runtime evidence above was captured from a locally built-and-run Grafana instance at HEAD `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`; no repository file was modified.
- The only temporary script created inside the repository during the investigation (the O5 spec `rule-form.o5tmp.test.ts`) was deleted immediately after capturing its output; `git status` was verified clean. The O1–O3 evidence was captured from the built binary, and the O4 evidence was produced by running the existing, committed `PanelDataQueriesTab.test.tsx` (no new file). Build/runtime artifacts (`bin/`, `pkg/server/wire_gen.go`, and the runtime `data/` directory created when the server starts) are git-ignored (`.gitignore` — e.g. `/data/*`) and not committed.
- This document (`blitzy/documentation/grafana_4550cfb5b728.md`) is the single committed artifact of the task.

