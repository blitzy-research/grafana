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
```

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
./bin/linux-amd64/grafana server --homepath="$PWD" \
    cfg:paths.data=/tmp/investigation/<data-dir> \
    cfg:paths.logs=/tmp/investigation/<logs-dir> \
    cfg:paths.plugins=/tmp/investigation/<plugins-dir> \
    [cfg:server.http_port=3001]      # second, parallel instance only
```

Two idle instances were run in parallel to establish cadence stability for Q1:

| Run  | PID   | Port | Data dir | Started (UTC)          | Requests during idle                        |
| ---- | ----- | ---- | -------- | ---------------------- | ------------------------------------------- |
| run1 | 89477 | 3000 | migrated | `2026-07-08T04:24:37Z` | 3 deliberate Q3 curls at startup, then idle |
| run2 | 90826 | 3001 | migrated | `2026-07-08T04:26:02Z` | **zero** (pure idle reference)              |

**Methodology & honesty conventions**

- Backend questions (Q1–Q3) were answered from these running instances.
- Frontend questions (Q4–Q5) were answered by running the modules' own **Jest** tests through
  their real code paths (non-watch, `--ci`); Q5 additionally uses one temporary ad-hoc test
  (now deleted) that directly exercises the responsible functions.
- Byte-sensitive output (log lines, JSON) is quoted from the exact emitted bytes.
- Any claim that comes from **reading** code rather than observing it is explicitly labeled
  **(inferred)**.

---

## Q1 — "After the server has been running for at least 60 seconds with no user requests, what are the exact recurring log entries that appear? Provide the actual log output as runtime evidence."

### Direct answer

At the default **INFO** log level, an idle Grafana server is almost silent, and the answer has two
layers:

1. **Within a strict ≥ 60-second idle window there are essentially _no_ recurring log entries.**
   After the startup sequence settles (~1 second), the INFO stream emits nothing for the entire
   first 60 seconds (in the pure-idle run it stayed silent from `t=04:26:03` until the first periodic
   tick at `t=04:36:02` — about 10 minutes of silence).

2. **Over a longer idle window, exactly two INFO log entries recur, both on a 10-minute cadence:**
   - `msg="Completed cleanup jobs"` (`logger=cleanup`) — the background cleanup service.
   - `msg="Update check succeeded"` (`logger=plugins.update.checker`) — the plugin update checker.

The 10-minute cadence was **stable across two independent runs** (measured intervals `600.1 s` and
`599.9 s` for cleanup; `600.0 s` for the plugin update checker).

### Runtime evidence

Both servers were left idle. The pure-idle instance (run2, zero inbound requests) is the canonical
reference; run1 corroborates. The full idle log for run2 was only 63 lines — itself evidence of how
sparse an idle INFO stream is.

**Confirm the run was genuinely idle (zero inbound HTTP requests):**

```
$ grep -cE "logger=context|method=GET|method=POST|status=" /tmp/investigation/run2.log
0
```

**The complete set of INFO lines emitted by the pure-idle run2 (startup → silence → periodic ticks):**

```
$ grep "level=info" /tmp/investigation/run2.log | grep -E "HTTP Server Listen|Update check succeeded|Completed cleanup jobs|Usage stats are ready"
logger=http.server t=2026-07-08T04:26:02.624588459Z level=info msg="HTTP Server Listen" address=[::]:3001 protocol=http subUrl= socket=
logger=plugins.update.checker t=2026-07-08T04:26:02.656293168Z level=info msg="Update check succeeded" duration=33.749815ms
logger=grafana.update.checker t=2026-07-08T04:26:02.656677922Z level=info msg="Update check succeeded" duration=34.246376ms
logger=infra.usagestats t=2026-07-08T04:27:29.624800359Z level=info msg="Usage stats are ready to report"
logger=plugins.update.checker t=2026-07-08T04:36:02.700125604Z level=info msg="Update check succeeded" duration=43.16712ms
logger=cleanup t=2026-07-08T04:36:02.7312847Z level=info msg="Completed cleanup jobs" duration=108.301937ms
logger=cleanup t=2026-07-08T04:46:02.627035535Z level=info msg="Completed cleanup jobs" duration=3.999393ms
logger=plugins.update.checker t=2026-07-08T04:46:02.707800797Z level=info msg="Update check succeeded" duration=50.534564ms
```

**Isolating the recurring `"Completed cleanup jobs"` line and measuring its cadence in both runs:**

```
$ grep "Completed cleanup jobs" /tmp/investigation/run1.log
logger=cleanup t=2026-07-08T04:34:38.282526606Z level=info msg="Completed cleanup jobs" duration=3.23974ms
logger=cleanup t=2026-07-08T04:44:38.367390028Z level=info msg="Completed cleanup jobs" duration=88.336263ms

$ grep "Completed cleanup jobs" /tmp/investigation/run2.log
logger=cleanup t=2026-07-08T04:36:02.7312847Z level=info msg="Completed cleanup jobs" duration=108.301937ms
logger=cleanup t=2026-07-08T04:46:02.627035535Z level=info msg="Completed cleanup jobs" duration=3.999393ms
```

Interval between consecutive occurrences:

| Run              | 1st occurrence       | 2nd occurrence       | Interval                |
| ---------------- | -------------------- | -------------------- | ----------------------- |
| run1 (port 3000) | `04:34:38.282526606` | `04:44:38.367390028` | **600.1 s (10.00 min)** |
| run2 (port 3001) | `04:36:02.731284700` | `04:46:02.627035535` | **599.9 s (10.00 min)** |

The plugin update checker recurs on the same cadence (it additionally fires once at startup):

| Run  | occurrences of `plugins.update.checker "Update check succeeded"` | intervals        |
| ---- | ---------------------------------------------------------------- | ---------------- |
| run1 | `04:24:38.325`, `04:34:38.354`, `04:44:38.360`                   | 600.0 s, 600.0 s |
| run2 | `04:26:02.656`, `04:36:02.700`, `04:46:02.707`                   | 600.0 s, 600.0 s |

**Run durations used:** run1 ≈ 22 min, run2 ≈ 21 min. A ≥ 60 s window proves idleness; a > 10 min
window is required to witness the first cleanup tick, and > 20 min to measure the interval between
two consecutive ticks (done above).

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
- **Plugin update checker** — `pkg/services/updatechecker/plugins.go:L78` `time.NewTicker(...)`
  (10-minute interval), emitting `msg="Update check succeeded"` under `logger=plugins.update.checker`.
- Background services are launched as goroutines by **`Server.Run()`** —
  `pkg/server/server.go:L139` (`func (s *Server) Run() error`); the launch loop uses an `errgroup`
  and skips disabled services (`pkg/server/server.go:L150` `registry.IsDisabled(svc)`,
  `L156` `s.childRoutines.Go(...)`).
- Default INFO level: `conf/defaults.ini:L1074` `level = info`.

### Rationale

The idle INFO stream is sparse **by design**: the default log level is INFO, and most periodic
background services log their per-tick activity at **DEBUG** (invisible at INFO). The two lines that
do surface are the ones whose services log at INFO on a 10-minute ticker. The exact 10.00-minute
spacing follows directly from `time.NewTicker(time.Minute * 10)`, and the first cleanup occurrence
lands ~10 minutes after boot because the completion message is emitted only from the ticker branch.

### Secondary / edge conditions (enumerated and observed)

- **One-time startup INFO lines (NOT recurring)** — present once at boot, then never again:
  `msg="Starting Grafana"` (`logger=settings`, `pkg/setting/setting.go:L940`),
  `msg="App mode production"`, `msg=FeatureToggles …`, `msg="Connecting to DB"`, the migrator lines
  (see Q2), `msg="HTTP Server Listen"`, and the alerting scheduler start line:

  ```
  logger=ngalert.scheduler t=2026-07-08T04:26:02.622577462Z level=info msg="Starting scheduler" tickInterval=10s maxAttempts=3
  ```

  The scheduler ticks every 10 s, but its **per-tick** logging is DEBUG (`pkg/services/ngalert/schedule/schedule.go` ~`L374`), so at INFO you see only the single startup line — not a recurring entry.

- **Longer-cadence (24 h) INFO lines** that fire once in this ~20-minute window and would only recur
  after a day:
  - `logger=grafana.update.checker msg="Update check succeeded"` — 24 h ticker
    (`pkg/services/updatechecker/grafana.go:L63`); observed once at startup only.
  - `logger=infra.usagestats msg="Usage stats are ready to report"` — 24 h send loop
    (`pkg/infra/usagestats/service/service.go:L70`); observed once (run1 `04:26:14`, run2 `04:27:29`).
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
logger=migrator t=2026-07-08T04:24:37.895958142Z level=info msg="migrations completed" performed=0 skipped=626 duration=1.291347ms
```

`performed=0` (with `skipped=626`, i.e. every known migration was already applied) is the precise
"schema is up to date / nothing to do" signal. The migrator runs on **every** startup; when the
schema is current it performs zero migrations and skips them all.

### Runtime evidence — the before/after boundary

To make the signal unambiguous, both state transitions were captured: a **fresh** database (schema
built from scratch → `performed > 0`), then a **second start against the same, now-migrated**
database (`performed = 0`).

**(a) Fresh database — migrations are executed (`performed=626`):**

```
$ grep "logger=migrator\|logger=resource-migrator" /tmp/investigation/runA_freshdb.log
logger=migrator t=2026-07-08T04:21:01.383505874Z level=info msg="Locking database"
logger=migrator t=2026-07-08T04:21:01.383526287Z level=info msg="Starting DB migrations"
logger=migrator t=2026-07-08T04:21:01.383768967Z level=info msg="Executing migration" id="create migration_log table"
logger=migrator t=2026-07-08T04:21:01.384019666Z level=info msg="Migration successfully executed" id="create migration_log table" duration=250.311µs
logger=migrator t=2026-07-08T04:21:04.40529006Z level=info msg="Executing migration" id="create user table"
logger=migrator t=2026-07-08T04:21:04.405631136Z level=info msg="Migration successfully executed" id="create user table" duration=339.203µs
   [... 644 "Executing migration" + 641 "Migration successfully executed" INFO lines omitted here for length (1256 logger=migrator INFO lines total on the fresh run); the first two pairs are shown above and the terminal summary is shown below ...]
logger=migrator t=2026-07-08T04:23:23.400840629Z level=info msg="migrations completed" performed=626 skipped=0 duration=2m22.0170879s
logger=resource-migrator t=2026-07-08T04:23:23.758238583Z level=info msg="migrations completed" performed=18 skipped=0 duration=119.6495ms
```

**(b) Same database, second start — schema already up to date (`performed=0`):**

```
$ grep "logger=migrator" /tmp/investigation/run1.log
logger=migrator t=2026-07-08T04:24:37.885790301Z level=info msg="Locking database"
logger=migrator t=2026-07-08T04:24:37.885845906Z level=info msg="Starting DB migrations"
logger=migrator t=2026-07-08T04:24:37.895958142Z level=info msg="migrations completed" performed=0 skipped=626 duration=1.291347ms
logger=migrator t=2026-07-08T04:24:37.896320536Z level=info msg="Unlocking database"
```

The second (pure-idle) instance corroborates the identical up-to-date signal:

```
logger=migrator t=2026-07-08T04:26:02.428335349Z level=info msg="migrations completed" performed=0 skipped=626 duration=773.268µs
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
requires authentication; querying it anonymously returns `401` (itself an observed behavior):

```
$ curl -s -i http://localhost:3000/api/frontend/settings | head -8
HTTP/1.1 401 Unauthorized
Cache-Control: no-store
Content-Type: application/json; charset=UTF-8
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Wed, 08 Jul 2026 04:25:31 GMT
Content-Length: 102
```

Re-issued with the default `admin:admin` credentials, the `buildInfo` object is returned. The exact
bytes of the `buildInfo` object as emitted in the (compact) response are:

```
$ curl -s -u admin:admin http://localhost:3000/api/frontend/settings
… "buildInfo":{"hideVersion":false,"version":"11.5.0-pre","versionString":"Grafana v11.5.0-pre (4550cfb5b7)","commit":"4550cfb5b7","commitShort":"4550cfb5b7","buildstamp":1734099722,"edition":"Open Source","latestVersion":"","hasUpdate":false,"env":"production"} …
```

(The response is a single ~29.7 KB JSON document; the `buildInfo` object above was located within it.
`jq` is not present in this shell, so `buildInfo` was extracted with `python3` — the substring shown
is the exact emitted bytes.)

**Cross-check — startup banner in the server log matches the API:**

```
$ grep "Starting Grafana" /tmp/investigation/run1.log | head -1
logger=settings t=2026-07-08T04:24:37.882873119Z level=info msg="Starting Grafana" version=11.5.0-pre commit=4550cfb5b7 branch=blitzy-4620db6d-41d6-422c-ac3b-f1e9ae4830e1 compiled=2024-12-13T14:22:02Z
```

All three sources agree:

| Source                                     | `version`    | `commit`     | extra                                                                                                                        |
| ------------------------------------------ | ------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                          | `11.5.0-pre` | `4550cfb5b7` | `database: ok`                                                                                                               |
| `GET /api/frontend/settings` → `buildInfo` | `11.5.0-pre` | `4550cfb5b7` | `versionString: "Grafana v11.5.0-pre (4550cfb5b7)"`, `buildstamp: 1734099722`, `edition: "Open Source"`, `env: "production"` |
| startup banner (`logger=settings`)         | `11.5.0-pre` | `4550cfb5b7` | `compiled=2024-12-13T14:22:02Z` (= `buildstamp 1734099722`)                                                                  |

**Build and invocation commands used (canonical labeling, mandatory):**

- Build: `make build-backend` → `./bin/linux-amd64/grafana`, link-stamped `-X main.version=11.5.0-pre`.
  Verified directly: `./bin/linux-amd64/grafana --version` → `grafana version 11.5.0-pre`.
- Invocation: `./bin/linux-amd64/grafana server --homepath="$PWD" cfg:paths.data=… cfg:paths.logs=… cfg:paths.plugins=…`.
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
stores it in the tab's state as `datasource` / `dsSettings`; that `dsSettings` is then handed to
`QueryGroupTopSection`, which renders the datasource picker. The responsible part of the codebase is
`public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx`
(method `loadDataSource()`), with the picker hosted by
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
  - Rendered into the picker: `L318` `<QueryGroupTopSection … dsSettings={…} …>`.
- **Picker host** — `public/app/features/query/components/QueryGroup.tsx` (`QueryGroupTopSection`),
  which renders `DataSourcePicker` (`QueryGroup.tsx:L25`) using the `dsSettings` prop
  (`QueryGroup.tsx:L50`).

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
(form → DTO) direction, a **temporary** ad-hoc test (prefixed `blitzy_adhoc_test_`, since removed —
see cleanup) was written to invoke the actual edit-population functions and print the runtime values.
It uses `process.stdout.write` (the repository's Jest setup fails any test that calls `console.log`
via `jest-fail-on-console`):

```
$ yarn jest public/app/features/alerting/unified/utils/blitzy_adhoc_test_q5.test.ts --ci --watchAll=false --verbose
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

BACKEND grafana_alert.data = [{"datasourceUid":"123","refId":"A","queryType":"huh","model":{}}]
EDITOR  form.queries       = [{"datasourceUid":"123","refId":"A","queryType":"huh","model":{}}]
EDITOR  form.condition     = "A"
formValuesFromExistingRule queries = [{"refId":"A","datasourceUid":"ds-uid-A","queryType":"","model":{"refId":"A"}},{"refId":"B","datasourceUid":"__expr__","queryType":"","model":{"refId":"B"}}]
PASS public/app/features/alerting/unified/utils/blitzy_adhoc_test_q5.test.ts
  BLITZY ADHOC Q5: backend rule definition populates editor query state on edit
    ✓ rulerRuleToFormValues maps backend grafana_alert.data -> form queries (alerting rule) (6 ms)
    ✓ formValuesFromExistingRule (AlertRuleForm defaultValues source) populates queries and strips model.hide (2 ms)

Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total
Snapshots:   0 total
Time:        4.591 s, estimated 6 s
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

### Responsible code

- **`AlertRuleForm`** — `public/app/features/alerting/unified/components/rule-editor/alert-rule-form/AlertRuleForm.tsx`.
  - `L102` `const defaultValues: RuleFormValues = useMemo(() => {`; `L103` `if (existing) {`;
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
  expressions."), surfaced by the Ruler API `pkg/services/ngalert/api/api_ruler.go` (create:
  `RoutePostNameRulesConfig` at `L331`; get: `RouteGetRuleByUID` at `L309`).

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
  against the real functions. The backend `AlertRule.Data` → Ruler-API linkage
  (`pkg/services/ngalert/api/api_ruler.go`) is cited from code (**inferred** for the HTTP-transport
  step); the field that carries the queries, `AlertRule.Data`, is grounded at
  `pkg/services/ngalert/models/alert_rule.go:L746`.

---

## Coverage pass

Each question decomposed into every distinct thing and named item it asks for, with where it is
answered.

| #   | Distinct ask                                                                            | Answered? | Where / value                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Server running ≥ 60 s with no user requests                                             | ✅        | Idle proven; `grep` for request logs on run2 = `0`; first 60 s after startup is silent                                                                                                               |
| Q1  | The **exact recurring** log entries                                                     | ✅        | `msg="Completed cleanup jobs"` (10 min) **and** `msg="Update check succeeded"` (`plugins.update.checker`, 10 min)                                                                                    |
| Q1  | **Actual log output** as runtime evidence                                               | ✅        | Verbatim logfmt lines from run1 & run2 embedded                                                                                                                                                      |
| Q1  | Magnitude/timing observed & stable across ≥ 2 runs                                      | ✅        | Intervals 600.1 s / 599.9 s (cleanup), 600.0 s (plugin check); run durations ~22 / ~21 min                                                                                                           |
| Q1  | Which part of the codebase                                                              | ✅        | `CleanUpService.clean()`/`Run()` (`cleanup.go:L77,L80,L128`); `plugins.go:L78`; `Server.Run()` (`server.go:L139`)                                                                                    |
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
| Q5  | Alerting rule-creation process at runtime                                               | ✅        | Ruler API `api_ruler.go` (`RoutePostNameRulesConfig:L331`, `RouteGetRuleByUID:L309`); `AlertRule.Data` (`alert_rule.go:L746`)                                                                        |
| Q5  | Whether backend rule definition populates query state on edit                           | ✅        | Yes — `form.queries` == backend `grafana_alert.data` (direct ad-hoc test output)                                                                                                                     |
| Q5  | **Test script output**                                                                  | ✅        | `yarn jest rule-form.test.ts` (21/21 PASS) + ad-hoc test (2/2 PASS) embedded                                                                                                                         |
| Q5  | Which part of the codebase                                                              | ✅        | `formValuesFromExistingRule` & `rulerRuleToFormValues` (`rule-form.ts:L916-917,L365,L380,L402`), invoked by `AlertRuleForm` (`AlertRuleForm.tsx:L105,L126-128`); `ignoreHiddenQueries` (`L909,L912`) |

**"Which part of the codebase" — answered by name for every question:**
Q1 → `CleanUpService.clean()` (cleanup run loop) + `plugins.update.checker`;
Q2 → `Migrator.run()`;
Q3 → `HTTPServer.apiHealthHandler` and `getFrontendSettings` (both reading `setting.BuildVersion`);
Q4 → `PanelDataQueriesTab.loadDataSource()` (picker hosted by `QueryGroup.tsx`);
Q5 → `formValuesFromExistingRule` / `rulerRuleToFormValues`.

### Summary of direct answers

- **Q1:** At INFO, the idle stream is sparse; the recurring INFO entries are `"Completed cleanup jobs"`
  and `"Update check succeeded"`, both every **10 minutes** (stable across two runs); within a strict
  60 s window there are effectively none.
- **Q2:** `msg="migrations completed" … performed=0` (schema already up to date).
- **Q3:** `version = 11.5.0-pre` (canonical build), reported identically by `/api/health`,
  `/api/frontend/settings`, and the startup banner.
- **Q4:** **Yes** — the picker auto-resolves to and displays the query-defined datasource, via
  `PanelDataQueriesTab.loadDataSource()`.
- **Q5:** **Yes** — the backend rule definition populates the editor's query state, via
  `AlertRuleForm` → `formValuesFromExistingRule` → `rulerRuleToFormValues` (`queries: ga.data`).
