# Grafana OSS — Clean-State Startup: Observed Ground Truth

> Branch `grafana_4550cfb5b728` · commit `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` · binary self-reports `grafana version 9.2.0`

This is an **observation-grounded** technical reference. It explains what the Grafana OSS backend *observably* does the **first** time it is started from a **completely clean state** — no prior configuration, no environment variables set — and how that behavior **changes on subsequent runs**. It is written for a new team member who read the `README.md` and `contribute/developer-guide.md`, started the server, and found the *observed* behavior unexplained by the docs. The goal is **ground truth**, not documentation paraphrase.

Every answer below **leads with the observed artifact** (a verbatim log line, HTTP response, or database value), **then** gives the exact `file:line` citation, **then** explains *why* it happens. Verbatim output is reproduced exactly as captured; identifiers, config keys, status codes, counts, timings, and file paths are quoted, never paraphrased. Where something could not be verified from these runs, it is called out explicitly.

The prompt decomposes into **six** sub-questions. Each has its own section:

| # | Sub-question | Answered in |
|---|--------------|-------------|
| Q1 | Initialization ground truth — what happens on clean startup, and why do some subsystems log "disabled"/"skipped"/ERROR while others succeed? | [Section B](#section-b--initialization-ground-truth-q1) |
| Q2 | Persistent state — what is created, and *where* on the filesystem? | [Section C](#section-c--persistent-state-q2) |
| Q3 | Security posture — why can I log in with credentials I never set up? | [Section D](#section-d--security-posture-q3) |
| Q4 | Plugin & data-source bootstrap — what is bundled vs. discovered vs. fetched remotely? | [Section E](#section-e--plugin-and-data-source-bootstrap-q4) |
| Q5 | Build / generated-files dependency — is running "directly" equivalent to building first? | [Section F](#section-f--build-and-generated-files-dependency-q5) |
| Q6 | First run vs. subsequent runs — how and why do they differ? | [Section G](#section-g--first-run-vs-subsequent-runs-q6) |

---

## Table of contents

- [Section A — How it was built and run](#section-a--how-it-was-built-and-run)
- [Section B — Initialization ground truth (Q1)](#section-b--initialization-ground-truth-q1)
- [Section C — Persistent state (Q2)](#section-c--persistent-state-q2)
- [Section D — Security posture (Q3)](#section-d--security-posture-q3)
- [Section E — Plugin and data-source bootstrap (Q4)](#section-e--plugin-and-data-source-bootstrap-q4)
- [Section F — Build and generated-files dependency (Q5)](#section-f--build-and-generated-files-dependency-q5)
- [Section G — First run vs subsequent runs (Q6)](#section-g--first-run-vs-subsequent-runs-q6)
- [Coverage pass](#coverage-pass)

---

## Section A — How it was built and run

### A.1 Method and read-only mandate

This investigation was conducted **run-first, write-second**: the backend was built and run from a clean state and the real output captured *before* any prose was written. It was governed by an explicit user directive, reproduced here verbatim:

> "Don't modify any files in the repository. If you need to create temporary scripts for testing, that's fine. but don't change the actual codebase files. And delete all those temporary scripts/files after task completion."

Accordingly, the investigation **modified no existing repository file**. It ran entirely **outside** the repository tree — the data directory lived under `/tmp` — and it used only a single temporary, *gitignored* generated file (`pkg/server/wire_gen.go`) that was deleted afterward. After cleanup, `git status --porcelain` was empty for all tracked files and `HEAD` was unchanged. The only artifact produced by the task is **this document**.

### A.2 Toolchain (installed in the investigation environment only — not a repository change)

- **Go `1.23.1`** — the pinned backend toolchain. The `go` directive is at `go.mod:L3` (`go 1.23.1`). Note that `go.mod:L1` is `module github.com/grafana/grafana`, *not* the version directive.
- **GCC (`build-essential`)** — required because the default datastore is SQLite via the CGO driver `github.com/mattn/go-sqlite3`. The exact compiler version is **environment-dependent** — any GCC / `build-essential` satisfies the requirement. The toolchain actually observed in this investigation environment was:

  ```
  $ gcc --version
  gcc (Ubuntu 15.2.0-4ubuntu4) 15.2.0
  ```

  `contribute/developer-guide.md:L135` states: "The Grafana backend includes SQLite, a database which requires GCC to compile." The CGO dependency is forced concretely by the reference to `sqlite3.ErrConstraintUnique` at `pkg/services/sqlstore/migrator/sqlite_dialect.go:L154`.
- **Node `v22.11.0`** — pinned by `.nvmrc`. The **frontend is out of scope**; it was neither built nor served. (Its absence is itself observable — see the static-asset ERROR in [Section B](#section-b--initialization-ground-truth-q1) and [Section F](#section-f--build-and-generated-files-dependency-q5).)

### A.3 Exact build and run sequence

```
# 1) Wire dependency-injection code is gitignored (.gitignore:L194 -> **/wire_gen.go),
#    so a clean checkout lacks it. Building without it fails (captured in Section F).
# 2) Generate it with Grafana's vendored Wire tool -- exactly what `make gen-go` runs
#    (Makefile:L167-169), using WIRE_TAGS = "oss" (Makefile:L5):
go run ./pkg/build/wire/cmd/wire/main.go gen -tags oss ./pkg/server

# 3) Build the unified backend binary with CGO on and the OSS build tag:
CGO_ENABLED=1 go build -tags oss -o /tmp/grafana-bin ./pkg/cmd/grafana

# 4) Run from a CLEAN data dir OUTSIDE the repo tree. conf/ and public/ were symlinked
#    read-only into /tmp/gf-clean so paths.data/logs/plugins resolve under /tmp and the
#    repository is never written to:
/tmp/grafana-bin server --homepath /tmp/gf-clean
```

The resulting binary self-reports its version:

```
$ /tmp/grafana-bin --version
grafana version 9.2.0
```

That `9.2.0` comes from `pkg/cmd/grafana/main.go:L17` (`var version = "9.2.0"`). The entry chain that leads from the binary to the run loop is: `pkg/cmd/grafana/main.go` → `pkg/cmd/grafana-server/commands/cli.go` (`func ServerCommand` at `L28` → `func RunServer` at `L46`) → the run loop in `pkg/server/server.go`.

### A.4 Why the docs did not explain the behavior

The setup docs the requester followed tell you *what* to do, not *why* the runtime behaves as it does. `contribute/developer-guide.md:L61-64` explains that Grafana consists of two components — the frontend and the backend; `L119` says to "Build and run the backend by running `make run`"; and `L127-129` gives the default login as `admin` / `admin`. None of these explain the automatic decisions, seeded state, or non-fatal errors observed at startup — which is exactly the gap the sections below fill.

### A.5 Cleanup performed afterward

The generated `pkg/server/wire_gen.go`, the built binary, the `/tmp/gf-clean` data directory, the SQLite database copies, and all captured log files were deleted. `git status --porcelain` was then verified empty and `HEAD` unchanged, restoring the checkout to its pristine state.

---

## Section B — Initialization ground truth (Q1)

**Q1 asks:** *What actually happens during startup from a clean state? What decisions does the system make automatically with no configuration provided? Why do some subsystems log that they are "disabled"/"skipped" or emit errors while others report success?*

### B.1 The observed first-run startup log (verbatim)

On start, the server first prints this warning to stderr:

```
Grafana server is running with elevated privileges. This is not recommended
```

It then emits the following structured (logfmt) log, in observed order. Timestamps are from the captured run and are run-specific:

```
logger=settings t=2026-07-01T02:51:34.319570632Z level=info msg="Starting Grafana" version=9.2.0 commit=NA branch=main compiled=2026-07-01T02:51:34Z
logger=settings level=error msg="Failed to detect generated javascript files in public/build"
logger=settings level=info msg="Config loaded from" file=/tmp/gf-clean/conf/defaults.ini
logger=settings level=info msg=Target target=[all]
logger=settings level=info msg="Path Home" path=/tmp/gf-clean
logger=settings level=info msg="Path Data" path=/tmp/gf-clean/data
logger=settings level=info msg="Path Logs" path=/tmp/gf-clean/data/log
logger=settings level=info msg="Path Plugins" path=/tmp/gf-clean/data/plugins
logger=settings level=info msg="Path Provisioning" path=/tmp/gf-clean/conf/provisioning
logger=settings level=info msg="App mode production"
logger=featuremgmt level=info msg=FeatureToggles cloudWatchCrossAccountQuerying=true correlations=true zipkinBackendMigration=true alertingSimplifiedRouting=true cloudWatchRoundUpEndTime=true accessActionSets=true preinstallAutoUpdate=true accessControlOnCall=true exploreMetrics=true awsAsyncQueryCaching=true logsExploreTableVisualisation=true newFiltersUI=true recoveryThreshold=true newDashboardSharingComponent=true formatString=true recordedQueriesMulti=true logsContextDatasourceUi=true tlsMemcached=true pinNavItems=true cloudwatchMetricInsightsCrossAccount=true azureMonitorEnableUserAuth=true dashboardSceneForViewers=true prometheusMetricEncyclopedia=true addFieldFromCalculationStatFunctions=true openSearchBackendFlowEnabled=true nestedFolders=true cloudWatchNewLabelParsing=true dashgpt=true alertingUIOptimizeReducer=true prometheusConfigOverhaulAuth=true dashboardSceneSolo=true singleTopNav=true logsInfiniteScrolling=true promQLScope=true lokiQuerySplitting=true lokiStructuredMetadata=true panelMonitoring=true dashboardScene=true kubernetesPlaylists=true unifiedRequestLog=true annotationPermissionUpdate=true logRowsPopoverMenu=true angularDeprecationUI=true dataplaneFrontendFallback=true influxdbBackendMigration=true prometheusAzureOverrideAudience=true managedPluginsInstall=true ssoSettingsApi=true transformationsVariableSupport=true lokiQueryHints=true alertingNoDataErrorExecution=true publicDashboardsScene=true groupToNestedTableTransformation=true transformationsRedesign=true notificationBanner=true alertingInsights=true
logger=sqlstore level=info msg="Connecting to DB" dbtype=sqlite3
logger=sqlstore level=info msg="Creating SQLite database file" path=/tmp/gf-clean/data/grafana.db
logger=migrator level=info msg="Locking database"
logger=migrator level=info msg="Starting DB migrations"
logger=migrator level=info msg="Executing migration" id="create migration_log table"
logger=migrator level=info msg="Migration successfully executed" id="create migration_log table" duration=189.396µs
... (626 migrations total) ...
logger=migrator level=info msg="migrations completed" performed=626 skipped=0 duration=1.594404517s
logger=migrator level=info msg="Unlocking database"
logger=sqlstore level=info msg="Created default admin" user=admin
logger=sqlstore level=info msg="Created default organization"
logger=plugin.store level=info msg="Loading plugins..."
logger=plugin.store level=info msg="Plugins loaded" count=54 duration=29.057697ms
logger=provisioning.alerting level=info msg="starting to provision alerting"
logger=provisioning.alerting level=info msg="finished to provision alerting"
logger=provisioning.dashboard level=info msg="starting to provision dashboards"
logger=provisioning.dashboard level=info msg="finished to provision dashboards"
logger=plugin.backgroundinstaller level=info msg="Installing plugin" pluginId=grafana-lokiexplore-app version=
logger=http.server level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=
logger=plugins.update.checker level=info msg="Update check succeeded" duration=43.556605ms
logger=grafana.update.checker level=info msg="Update check succeeded" duration=43.714714ms
logger=plugin.backgroundinstaller level=error msg="Failed to install plugin" pluginId=grafana-lokiexplore-app version= error="[plugin.grafanaVersionNotCompatible] grafana-lokiexplore-app is not compatible with your Grafana version: 9.2.0"
```

### B.2 Each milestone mapped to its source, and why it happens

- **`msg="Starting Grafana" version=9.2.0`** — the version literal is `var version = "9.2.0"` at `pkg/cmd/grafana/main.go:L17`. The run loop is in `pkg/server/server.go`: `Init()` (`L113`) calls `writePIDFile` (`L122`), `RegisterFixedRoles` (`L130`), then `RunInitProvisioners` (`L134`); the service loop `func (s *Server) Run()` is at `L139`.
- **`level=error msg="Failed to detect generated javascript files in public/build"`** — emitted by `validateStaticRootPath()` at `pkg/setting/setting.go:L1034`, with the error logged at `L1040`. It `os.Stat`s `public/build`, which is **absent because the frontend was not built**. This ERROR is **benign for a backend-only run**: the HTTP API works fine; only the HTML UI needs the built assets. This is the first example of the "error, but the server still starts" theme.
- **`msg="Config loaded from" file=.../conf/defaults.ini`** — with no `custom.ini` and no environment variables, all effective settings come from `conf/defaults.ini`. (The specific default values that matter for security are enumerated in [Section D](#section-d--security-posture-q3).)
- **`msg="Path Home"` / `"Path Data"` / `"Path Logs"` / `"Path Plugins"` / `"Path Provisioning"`** — these resolve from `conf/defaults.ini`: `data = data` (`L15`), `logs = data/log` (`L21`), `plugins = data/plugins` (`L24`), relative to the home path passed on the command line.
- **`msg=FeatureToggles ...`** — emitted by `pkg/services/featuremgmt/service.go:L70` (`mgmt.log.Info("FeatureToggles", logctx...)`). The flag *definitions* live in `pkg/services/featuremgmt/registry.go`, but the *log line* is in `service.go:L70`. **Exactly 56 toggles are default-ON** in this build. The full sorted set is:

  ```
  accessActionSets accessControlOnCall addFieldFromCalculationStatFunctions alertingInsights
  alertingNoDataErrorExecution alertingSimplifiedRouting alertingUIOptimizeReducer angularDeprecationUI
  annotationPermissionUpdate awsAsyncQueryCaching azureMonitorEnableUserAuth cloudWatchCrossAccountQuerying
  cloudWatchNewLabelParsing cloudWatchRoundUpEndTime cloudwatchMetricInsightsCrossAccount correlations
  dashboardScene dashboardSceneForViewers dashboardSceneSolo dashgpt dataplaneFrontendFallback exploreMetrics
  formatString groupToNestedTableTransformation influxdbBackendMigration kubernetesPlaylists logRowsPopoverMenu
  logsContextDatasourceUi logsExploreTableVisualisation logsInfiniteScrolling lokiQueryHints lokiQuerySplitting
  lokiStructuredMetadata managedPluginsInstall nestedFolders newDashboardSharingComponent newFiltersUI
  notificationBanner openSearchBackendFlowEnabled panelMonitoring pinNavItems preinstallAutoUpdate promQLScope
  prometheusAzureOverrideAudience prometheusConfigOverhaulAuth prometheusMetricEncyclopedia publicDashboardsScene
  recordedQueriesMulti recoveryThreshold singleTopNav ssoSettingsApi tlsMemcached transformationsRedesign
  transformationsVariableSupport unifiedRequestLog zipkinBackendMigration
  ```

  These are enabled with **no configuration** — they are the compiled-in default stage of the toggles in `registry.go`. This is the answer to "what decisions does the system make automatically": it turns on a fixed set of 56 features by default.
- **`msg="Connecting to DB" dbtype=sqlite3`** — `pkg/services/sqlstore/sqlstore.go:L255`. The type is SQLite by default because `conf/defaults.ini:L123` sets `type = sqlite3`.
- **`msg="Creating SQLite database file" path=.../grafana.db`** — `pkg/services/sqlstore/sqlstore.go:L265`. This line appears **only because the database file does not yet exist** (this is the first run). On subsequent runs it is absent — see [Section G](#section-g--first-run-vs-subsequent-runs-q6).
- **`msg="Locking database"` / `"Starting DB migrations"` / `"migrations completed" performed=626 skipped=0` / `"Unlocking database"`** — in `pkg/services/sqlstore/migrator/migrator.go` at `L216` / `L247` / `L287` / `L229` respectively. On a clean database all **626** migrations are *performed* (`skipped=0`) in `duration=1.594404517s`.
- **`msg="Created default admin" user=admin` + `msg="Created default organization"`** — from `ensureMainOrgAndAdminUser` in `pkg/services/sqlstore/sqlstore.go` (starts at `L190`). This seeding is what makes the "unexplained" login possible; it is dissected in [Section D](#section-d--security-posture-q3).
- **`provisioning.alerting` / `provisioning.dashboard` "starting/finished to provision" pairs`** — from `pkg/services/provisioning/provisioning.go` (`RunInitProvisioners` at `L169`, which invokes `ProvisionDatasources` at `L170`, `ProvisionPlugins` at `L176`, and `ProvisionAlerting` at `L182`). They **finish instantly having created nothing** because the provisioning inputs for these paths — `conf/provisioning/{datasources,plugins,alerting,dashboards}/sample.yaml` — each begin with an active `apiVersion: 1` (at `L2`) followed by an otherwise fully commented-out body, so there is nothing to apply. (The one remaining sample, `conf/provisioning/access-control/sample.yaml`, is **fully commented** — including its `# apiVersion: 2` line at `L3` — so it declares no active configuration at all.) This is precisely why several subsystems *log activity yet create no data*.
- **`msg="HTTP Server Listen" address=[::]:3000 protocol=http`** — `pkg/api/http_server.go:L434`. Port `3000` comes from `conf/defaults.ini:L41` (`http_port = 3000`) and `protocol=http` from `L32` (`protocol = http`).

### B.3 Why subsystems log "disabled"/"skipped"/ERROR yet the server still starts

The run loop registers a fixed set of background services in `pkg/registry/backgroundsvcs/background_services.go`. The provider `ProvideBackgroundServiceRegistry` is at `L53`, and the `NewBackgroundServiceRegistry(...)` call spans `L80-L117` with **exactly 36 service arguments** (not "60+"). Each service starts in parallel; a service whose feature is off or that has nothing configured simply logs that it is disabled/skipped and returns, and the registry does **not** treat that as fatal. The two ERROR lines observed at startup are likewise non-fatal:

- the static-asset ERROR (`validateStaticRootPath`, `pkg/setting/setting.go:L1040`) — the un-built frontend; and
- the plugin-preinstall ERROR (`[plugin.grafanaVersionNotCompatible]`, dissected in [Section E](#section-e--plugin-and-data-source-bootstrap-q4)).

Because none of these are fatal, the server proceeds all the way to `HTTP Server Listen address=[::]:3000`. That is the ground-truth answer to Q1: **on a clean start, Grafana auto-selects SQLite, creates and migrates a fresh database, seeds an admin user and a default org, loads its bundled plugins, runs (empty) provisioning, performs outbound update checks, and starts listening on `:3000` — treating "nothing configured" states and the two frontend/plugin errors as informational, not fatal.**


---

## Section C — Persistent state (Q2)

**Q2 asks:** *What state gets created, and where on the filesystem? Why do subsequent runs behave differently in ways that persist across stop/restart?*

### C.1 Files created under the data directory (verbatim inventory)

Running against the clean, out-of-repo data directory `/tmp/gf-clean/data` produced:

```
/tmp/gf-clean/data/grafana.db          (1,093,632 bytes  — the SQLite database)
/tmp/gf-clean/data/log/grafana.log     (206,676 bytes    — file log; mode "console file")
/tmp/gf-clean/data/csv/                 (empty — CSV export dir)
/tmp/gf-clean/data/pdf/                 (empty — PDF export dir)
/tmp/gf-clean/data/png/                 (empty — rendered-image dir)
```

**Citations.** The default paths come from `conf/defaults.ini`: `data = data` (`L15`), `logs = data/log` (`L21`), `plugins = data/plugins` (`L24`). The database is SQLite (`type = sqlite3`, `L123`) with file name `path = grafana.db` (`L164`). The log mode is `mode = console file` at `conf/defaults.ini:L1071` (under the `[log]` header at `L1068`), which writes **simultaneously** to the console *and* to `data/log/grafana.log` — the file's first line is the same `msg="Starting Grafana"` line shown in [Section B](#section-b--initialization-ground-truth-q1).

Note: although `data/plugins` is reported as `"Path Plugins"` in the startup log, that directory is **not created** when there are no external plugins to place in it.

### C.2 Contents of `grafana.db` (read observation-only)

The live server holds a write lock on `grafana.db` and the `sqlite3` CLI is not present, so the database was inspected by **copying** the file and opening the copy with Python's `sqlite3` module — an observation-only technique that does not touch the live database. The copy contained **76 tables**. The seeded rows on first run were:

```
migration_log          : 626 rows   (one per applied main migration;          equals migrator performed=626)
resource_migration_log :  18 rows   (one per applied resource-store migration; equals resource-migrator performed=18)
user          : 1 row  -> (id=1, login='admin', email='admin@localhost', is_admin=1, org_id=1)
org           : 1 row  -> (id=1, name='Main Org.')
org_user      : 1 row  -> (org_id=1, user_id=1, role='Admin')
data_source   : 0 rows
dashboard     : 0 rows
api_key       : 0 rows
user_auth     : 0 rows
star          : 0 rows
preferences   : 0 rows
team          : 0 rows
```

### C.3 Why subsequent runs differ — the persistent state that matters

The state that makes later runs behave differently is exactly four things, all captured above:

1. **The `grafana.db` file exists** — so the `"Creating SQLite database file"` line (from `pkg/services/sqlstore/sqlstore.go:L265`) does not recur.
2. **All 626 main migrations are recorded** in `migration_log` — so the main migrator flips from `performed=626 skipped=0` to `performed=0 skipped=626`.
3. **All 18 resource-store migrations are recorded** in the *separate* `resource_migration_log` table — so the `resource-migrator` flips from `performed=18 skipped=0` to `performed=0 skipped=18`. The two migrators keep **distinct** log tables: the main migrator uses `migration_log` and the scoped resource migrator uses `resource_migration_log` (`pkg/services/sqlstore/migrator/migrator.go:L97` vs. `L100`).
4. **The admin user and Main Org. are seeded** — so `ensureMainOrgAndAdminUser` (`pkg/services/sqlstore/sqlstore.go:L190`) has nothing to create and the `"Created default admin"` / `"Created default organization"` lines do not recur.

These persist across stop/restart because they live in `grafana.db` on disk, which is why the first-run-vs-subsequent-run divergence in [Section G](#section-g--first-run-vs-subsequent-runs-q6) is entirely explained by this section.


---

## Section D — Security posture (Q3)

**Q3 asks:** *What are the actual security defaults? Why can I log in with credentials I never explicitly set up? Did the system create accounts, or is it running in a permissive/anonymous mode?*

### D.1 Observed API behavior (lead with the evidence)

**Health check — public, no auth:**

```
$ curl -i http://localhost:3000/api/health
HTTP/1.1 200 OK
Content-Type: application/json; charset=UTF-8
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Content-Length: 62

{
  "database": "ok",
  "version": "9.2.0",
  "commit": "NA"
}
```

**Protected endpoints — anonymous requests are rejected:**

```
$ curl -o /dev/null -w "%{http_code}" http://localhost:3000/api/datasources      # anonymous
401
# body: {"extra":null,"message":"Unauthorized","messageId":"auth.unauthorized","statusCode":401,"traceID":""}

$ curl -o /dev/null -w "%{http_code}" http://localhost:3000/api/user             # anonymous
401
```

**Logging in with the default credentials — the JSON auth API:**

```
$ curl -i -X POST http://localhost:3000/login -H "Content-Type: application/json" -d '{"user":"admin","password":"admin"}'
HTTP/1.1 200 OK
Set-Cookie: grafana_session=b5d0de3e6207352472f2ba3183a0563d; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax
Set-Cookie: grafana_session_expiry=1782874944; Path=/; Max-Age=2592000; SameSite=Lax

{"message":"Logged in","redirectUrl":"/"}
```

**Same endpoints with the session cookie — now authorized:**

```
$ curl -b <session-cookie> http://localhost:3000/api/user            # authenticated
{"id":1,"uid":"bfqr89ecz9tdsd","email":"admin@localhost","name":"","login":"admin","theme":"","orgId":1,"isGrafanaAdmin":true,"isDisabled":false,...}   # HTTP 200

$ curl -b <session-cookie> http://localhost:3000/api/datasources     # authenticated
[]                                                                    # HTTP 200 (no datasources)
```

### D.2 The default literals in `conf/defaults.ini`

- `[security]` header at `L323`; `admin_user = admin` at `L328`; `admin_password = admin` at `L331`; `secret_key = SW2YcwTIb9zpOOhoPsMm` at `L337`; `disable_gravatar = false` at `L346`; `cookie_secure = false` at `L358`; `cookie_samesite = lax` at `L361`.
- `[users]` header at `L481`; `allow_sign_up = false` at `L483`; `auto_assign_org = true` at `L489`; `auto_assign_org_role = Viewer` at `L495`.
- `[auth.anonymous]` header at `L648` → `enabled = false` at `L650` (anonymous access is **OFF**). `[auth.basic]` header at `L874` → `enabled = true` at `L875` (basic auth is **ON**).

Note on `secret_key`: the value `SW2YcwTIb9zpOOhoPsMm` at `conf/defaults.ini:L337` is the **shipped default literal** in the repository (it is checked into the defaults file, not a real deployment secret). A *separate* blank `secret_key =` appears later at `conf/defaults.ini:L1688` in a different section.

### D.3 Why you can log in with credentials you never set up

**Grafana seeded a real admin account from the compiled-in defaults.** The login works because `ensureMainOrgAndAdminUser` (`pkg/services/sqlstore/sqlstore.go:L190`) created a genuine user row using `admin_user = admin` (`conf/defaults.ini:L328`) and `admin_password = admin` (`L331`) during the first run — the same `msg="Created default admin" user=admin` line seen in [Section B](#section-b--initialization-ground-truth-q1) and the same `user(id=1, login='admin', ..., is_admin=1)` row seen in [Section C](#section-c--persistent-state-q2).

Two pieces of observed evidence prove this is a **real seeded account and not anonymous/permissive mode**:

1. The authenticated `/api/user` response returns `"isGrafanaAdmin":true` for `"login":"admin"` (`id:1`) — a concrete, privileged account.
2. Anonymous requests to `/api/datasources` and `/api/user` return **`401`** — so the server is *not* letting unauthenticated callers through. This matches `[auth.anonymous] enabled = false` (`L650`), while basic auth is `enabled = true` (`L875`).

The session cookie `grafana_session` is `HttpOnly` and `SameSite=Lax` with `Max-Age=2592000` (30 days) and has **no `Secure` flag** — consistent with `cookie_secure = false` (`L358`) and `cookie_samesite = lax` (`L361`). The developer guide independently documents the `admin` / `admin` default at `contribute/developer-guide.md:L127-129`.

### D.4 Honest nuance: `GET /login` vs. `POST /login`

The `200 + Set-Cookie` above is from **`POST /login`, the JSON authentication API**, which works regardless of frontend assets. By contrast, **`GET /login` (the HTML login page) returns `HTTP/1.1 500 Internal Server Error`** in this backend-only run, because rendering that page requires the un-built frontend (`public/build`). This distinction is called out explicitly so the reader does not conclude that the HTML page is served here — it is not; only the JSON auth endpoint is exercised successfully.


---

## Section E — Plugin and data-source bootstrap (Q4)

**Q4 asks:** *How does the plugin/data-source ecosystem bootstrap? What is bundled (compiled-in/shipped) vs. discovered at runtime from disk vs. fetched remotely, and what ultimately becomes available through the API? Why do plugins I never installed appear in the UI?*

### E.1 Observed loading (lead with the evidence)

```
logger=plugin.store level=info msg="Loading plugins..."                        # pkg/services/pluginsintegration/pluginstore/store.go:L38
logger=plugin.store level=info msg="Plugins loaded" count=54 duration=29.057697ms   # store.go:L50
```

What ultimately becomes available through the API:

```
$ curl -b <session-cookie> http://localhost:3000/api/plugins   # HTTP 200
# 49 plugins total: 30 panel + 19 datasource (0 app)
# datasource ids (19): alertmanager, cloudwatch, elasticsearch, grafana-azure-monitor-datasource,
#   grafana-postgresql-datasource, grafana-pyroscope-datasource, grafana-testdata-datasource, graphite,
#   influxdb, jaeger, loki, mssql, mysql, opentsdb, parca, prometheus, stackdriver, tempo, zipkin
# panel ids (30): alertlist, annolist, barchart, bargauge, candlestick, canvas, dashlist, datagrid,
#   flamegraph, gauge, geomap, gettingstarted, graph, heatmap, histogram, logs, news, nodeGraph,
#   piechart, stat, state-timeline, status-history, table, table-old, text, timeseries, traces, trend,
#   welcome, xychart
```

### E.2 The three source tiers and their resolution order

Plugin sources are resolved by `pkg/plugins/manager/sources/sources.go` in `func (s *Service) List(...)` (`L24`), in this fixed order — **Core → Bundled → External**:

- **`[0]` `ClassCore`** = `corePluginPaths(s.cfg.StaticRootPath)` (`sources.go:L26`; `corePluginPaths` is defined at `L64` and returns `public/app/plugins/datasource` and `public/app/plugins/panel`).
- **`[1]` `ClassBundled`** = `BundledPluginsPath` (`sources.go:L27`).
- **`[2..]` `ClassExternal`** = external sources from `cfg.PluginsPath` (i.e. `data/plugins`) plus plugin-setting sources.

### E.3 Bundled vs. discovered vs. fetched-remotely (with counts)

- **Compiled-in (shipped inside the binary):** the datasource *backends* registered in `pkg/plugins/backendplugin/coreplugin/registry.go`. `func NewRegistry` is at `L89`, and `func ProvideCoreRegistry` builds the map at `L102-L121` containing **exactly 18** compiled-in datasource backends: CloudWatch, CloudMonitoring, AzureMonitor, Elasticsearch, Graphite, InfluxDB, Loki, OpenTSDB, Prometheus, Tempo, TestData, PostgreSQL, MySQL, MSSQL, Grafana, Pyroscope, Parca, Zipkin. (A `switch` re-enumerates these at `L212-L246`.)
- **Discovered on disk at runtime:** the core plugin directories under `public/app/plugins/{datasource,panel}` — `public/app/plugins/datasource` = **22 dirs** and `public/app/plugins/panel` = **32 dirs**, i.e. **54** on-disk core plugin definitions in total. These are the *frontend* plugin definitions loaded at startup.
- **Fetched remotely:** the background pre-installer. The default preinstall list is defined in code at `pkg/setting/setting_plugins.go:L32` — `"grafana-lokiexplore-app": {"grafana-lokiexplore-app", "", ""}` inside the `defaultPreinstallPlugins` map — and documented at `conf/defaults.ini:L1765` (with `preinstall =` blank at `L1766` and `preinstall_async = true` at `L1768`). The installer runs a generic loop in `pkg/services/pluginsintegration/plugininstaller/service.go` (`installPlugins` at `L137`, `Run` at `L187`).

### E.4 Reconciling the numbers honestly (54 loaded vs. 49 exposed)

The runtime log reports **`count=54`** plugins loaded (= 22 datasource + 32 panel core directories on disk), while **`/api/plugins` exposes 49** (30 panel + 19 datasource, 0 app). The **5-plugin difference is fully accounted for by two filters** in the `GET /api/plugins` handler in `pkg/api/plugins.go`:

- **3 built-in datasources are filtered out** by `if pluginDef.BuiltIn { continue }` at `pkg/api/plugins.go:L110`. These are exactly the three datasources whose `plugin.json` sets `"builtIn": true` — **`dashboard`, `grafana`, `mixed`** — so 22 datasource directories become 19 exposed.
- **2 alpha-state panels are filtered out** by `if pluginDef.State == plugins.ReleaseStateAlpha && !hs.Cfg.PluginsEnableAlpha { continue }` at `pkg/api/plugins.go:L105`. These are the two panels whose `plugin.json` sets `"state": "alpha"` — **`debug`** (`public/app/plugins/panel/debug/plugin.json:L6`) and **`live`** (`public/app/plugins/panel/live/plugin.json:L8`) — filtered because `PluginsEnableAlpha` is `false` by default, so 32 panel directories become 30 exposed.

That reconciles the numbers exactly: `54 − 3 (built-in datasources) − 2 (alpha panels) = 49`. Both figures are reported exactly as observed, and every one of the five non-exposed plugins is now accounted for.

### E.5 Why plugins you never installed appear

They are **bundled/compiled-in and discovered on disk at startup — not installed by the user.** Core plugins ship inside `public/app/plugins/` (discovered at runtime), and their datasource backends are compiled directly into the binary (the 18 in `coreplugin/registry.go`). No installation step ran; the ecosystem is present because it is shipped with Grafana itself.

### E.6 The observed remote-install failure (expected and non-fatal)

```
logger=plugin.backgroundinstaller level=info msg="Installing plugin" pluginId=grafana-lokiexplore-app version=
logger=plugin.backgroundinstaller level=error msg="Failed to install plugin" pluginId=grafana-lokiexplore-app version= error="[plugin.grafanaVersionNotCompatible] grafana-lokiexplore-app is not compatible with your Grafana version: 9.2.0"
```

The background pre-installer attempts to fetch `grafana-lokiexplore-app`, which requires a **newer** Grafana than `9.2.0`, so the install fails with `[plugin.grafanaVersionNotCompatible]`. This is **expected for this checkout and non-fatal** — it does not stop the server (see the "still starts" theme in [Section B](#section-b--initialization-ground-truth-q1)).

### E.7 Outbound phone-home (reported as observed findings, not actions taken)

On a clean default, the server makes outbound calls to grafana.com; both update checkers reported success:

```
logger=plugins.update.checker level=info msg="Update check succeeded" duration=43.556605ms   # pkg/services/updatechecker/plugins.go:L123
logger=grafana.update.checker level=info msg="Update check succeeded" duration=43.714714ms   # pkg/services/updatechecker/grafana.go:L89
```

The target URL is `grafanaStableVersionURL = "https://grafana.com/api/grafana/versions/stable"` at `pkg/services/updatechecker/grafana.go:L23`. These checks are enabled by the defaults `check_for_updates = true` (`conf/defaults.ini:L268`), `check_for_plugin_updates = true` (`L275`), and `reporting_enabled = true` (`L258`). This is reported strictly as an observed behavior of the default configuration.


---

## Section F — Build and generated-files dependency (Q5)

**Q5 asks:** *There appear to be generated files the runtime depends on. Is running the server "directly" equivalent to building first? Are there artifacts that must exist before certain code paths work correctly?*

### F.1 The observed compile failure before generation (the evidence)

A clean checkout does **not** compile. Building it directly — before generating any code — fails immediately:

```
$ CGO_ENABLED=1 go build -tags oss -o /tmp/grafana-bin ./pkg/cmd/grafana
# github.com/grafana/grafana/pkg/server
pkg/server/service.go:31:15: undefined: Initialize
```

Generating the Wire dependency-injection code then succeeds:

```
$ go run ./pkg/build/wire/cmd/wire/main.go gen -tags oss ./pkg/server
wire: github.com/grafana/grafana/pkg/server: wrote /.../pkg/server/wire_gen.go
```

After generation, the *same* build command succeeds. Measured on this run (with a warm Go module and build cache):

```
$ time CGO_ENABLED=1 go build -tags oss -o /tmp/grafana-bin ./pkg/cmd/grafana
real	0m21.670s
user	0m27.062s
sys	0m13.476s
$ ls -lh /tmp/grafana-bin
-rwxr-xr-x 1 root root 285M /tmp/grafana-bin
$ stat -c '%s bytes' /tmp/grafana-bin
298085016 bytes
```

(`ls -lh` reports `285M` in MiB; the exact size `298,085,016` bytes ≈ **298 MB** in decimal. The build duration depends on cache warmth — a cold first build is substantially slower.)

### F.2 Short answer

**No — running "directly" is not equivalent to a working build.** As the evidence above shows, a clean checkout will not even compile until the Wire dependency-injection code is generated, and it needs CGO for SQLite. There are two distinct "generated files" dependencies: **Wire code at compile time**, and **frontend assets at UI runtime** (detailed in F.5).

### F.3 Why the Wire code is required (and why it is missing from a clean checkout)

`Initialize` is only **declared as a stub** in `pkg/server/wire.go`, which carries the build tag `//go:build wireinject` (at `L1-2`); the stub `func Initialize(...)` is at `L444`. The **real** `Initialize` is *generated* into `pkg/server/wire_gen.go` (built with the opposite tag `//go:build !wireinject`). That generated file is **gitignored** — `.gitignore:L194` contains `**/wire_gen.go` — and is therefore **absent from a clean checkout**. Because `pkg/server/service.go:L31` calls `Initialize(s.cfg, s.opts, s.apiOpts)`, building without the generated file leaves the symbol `undefined`, exactly as the failure above shows.

### F.4 Why CGO is mandatory

The default datastore is SQLite via the CGO driver `github.com/mattn/go-sqlite3` (a C library). The SQLite dialect references `sqlite3.ErrConstraintUnique` at `pkg/services/sqlstore/migrator/sqlite_dialect.go:L154`, so the driver must be compiled with a C compiler. Building with `CGO_ENABLED=0` would fail to link the driver. `contribute/developer-guide.md:L135` states plainly that the bundled SQLite "requires GCC to compile."

### F.5 The second, runtime generated-files dependency (frontend assets)

Separately from the compile-time Wire dependency, `validateStaticRootPath` (`pkg/setting/setting.go:L1034`, error emitted at `L1040`) reveals a **runtime** generated-files dependency for the UI. Without a frontend build in `public/build`, the backend logs:

```
logger=settings level=error msg="Failed to detect generated javascript files in public/build"
```

The API still works, but the HTML UI does not — e.g. `GET /login` returns `500` (see [Section D](#section-d--security-posture-q3)). So "generated files" matter **twice**: Wire code at compile time, and frontend assets at UI runtime.

### F.6 Why `make run` hides all of this

`contribute/developer-guide.md:L119` tells the developer to "Build and run the backend by running `make run`." That command hides the Wire step because the Makefile's `gen-go` target (`Makefile:L167-169`) runs `go run ./pkg/build/wire/cmd/wire/main.go gen -tags $(WIRE_TAGS) ./pkg/server` — with `WIRE_TAGS = "oss"` (`Makefile:L5`) — as part of the build. So a developer using `make run` never sees the `undefined: Initialize` failure, which is precisely why the generated-files dependency is invisible from the docs alone.


---

## Section G — First run vs subsequent runs (Q6)

**Q6 asks:** *How and why does behavior differ between the first run and later runs?*

### G.1 The observed divergence (lead with the evidence)

The server was run **twice against the same data directory** and the startup logs were diffed:

```
# RUN 1 (first, clean data dir):
logger=sqlstore  msg="Creating SQLite database file" path=/tmp/gf-clean/data/grafana.db
logger=migrator  msg="migrations completed" performed=626 skipped=0 duration=1.594404517s
logger=resource-migrator msg="migrations completed" performed=18 skipped=0 duration=47.869996ms
logger=sqlstore  msg="Created default admin" user=admin
logger=sqlstore  msg="Created default organization"

# RUN 2 (subsequent, SAME data dir):
#   (no "Creating SQLite database file" line — the DB already exists)
logger=migrator  msg="migrations completed" performed=0 skipped=626 duration=580.623µs
logger=resource-migrator msg="migrations completed" performed=0 skipped=18 duration=29.12µs
#   (no "Created default admin" / "Created default organization" — already seeded)

# UNCHANGED across both runs:
logger=sqlstore   msg="Connecting to DB" dbtype=sqlite3
logger=plugin.store msg="Plugins loaded" count=54
logger=http.server msg="HTTP Server Listen" address=[::]:3000 protocol=http
```

### G.2 Why the runs diverge

The divergence is **entirely due to the persistent state described in [Section C](#section-c--persistent-state-q2)**:

- **The main migrator flips from `performed=626 skipped=0` to `performed=0 skipped=626`** because the `migration_log` table already records every applied migration; the migrator reads that log and skips already-applied migrations. **Separately, the `resource-migrator` flips from `performed=18 skipped=0` to `performed=0 skipped=18`** because it is a *scoped* migrator that keeps its own log in a **distinct** table, `resource_migration_log` — **not** `migration_log`. The scoped migrator sets its table to `scope + "_migration_log"` and its logger to `scope + "-migrator"` at `pkg/services/sqlstore/migrator/migrator.go:L100-L101`, with `scope = "resource"` supplied by `NewScopedMigrator(engine, cfg, "resource")` at `pkg/storage/unified/sql/db/migrations/migrator.go:L15`. Both migrators emit the same completion log line at `pkg/services/sqlstore/migrator/migrator.go:L287`.
- **The `"Creating SQLite database file"` line does not recur** because the file `/tmp/gf-clean/data/grafana.db` already exists (the create path in `pkg/services/sqlstore/sqlstore.go:L265` runs only when the file is absent).
- **Admin/org seeding does not repeat** because the rows already exist and `ensureMainOrgAndAdminUser` (`pkg/services/sqlstore/sqlstore.go:L190`) is idempotent — verified by re-reading the copied database after run 2: `user` = 1 row and `org` = 1 row, unchanged.
- **Plugin loading and HTTP listen are stateless and therefore identical** across both runs (`count=54`, `address=[::]:3000`).

Also note the dramatic duration drop for the main migration step, from `1.594404517s` on the first run to `580.623µs` on the second — because migration work is replaced by a cheap "already applied" check.

### G.3 Honesty note: the "Database locked" line was not observed

The log line `"Database locked, sleeping then retrying"` exists in the source at `pkg/services/sqlstore/transactions.go:L74`, but it was **not observed** in these runs (0 occurrences). These were clean, single-process runs; that line requires **concurrent write contention** on the SQLite file (multiple writers), which did not occur here. It is mentioned only to be explicit that it was *not* triggered — it is **not** presented as observed output from this investigation.

---

## Coverage pass

All six sub-questions are explicitly answered, each in its own section, and each answer leads with verbatim observed evidence, then the exact `file:line` citation, then the reason:

| Sub-question | Section | Key observed evidence |
|--------------|---------|-----------------------|
| **Q1** — Initialization ground truth | [Section B](#section-b--initialization-ground-truth-q1) | Full first-run startup log; 56 feature toggles; 36 non-fatal background services; `HTTP Server Listen address=[::]:3000` |
| **Q2** — Persistent state | [Section C](#section-c--persistent-state-q2) | `grafana.db` (1,093,632 bytes), 76 tables, 626 `migration_log` + 18 `resource_migration_log` rows, seeded `user`/`org`/`org_user` |
| **Q3** — Security posture | [Section D](#section-d--security-posture-q3) | `200` health, `401` anonymous, `POST /login` `200` + `grafana_session` cookie, `isGrafanaAdmin:true`; anon off / basic on |
| **Q4** — Plugin & data-source bootstrap | [Section E](#section-e--plugin-and-data-source-bootstrap-q4) | `Plugins loaded count=54`; `/api/plugins` = 49; 18 compiled-in backends; preinstall `[plugin.grafanaVersionNotCompatible]` |
| **Q5** — Build / generated-files dependency | [Section F](#section-f--build-and-generated-files-dependency-q5) | `pkg/server/service.go:31:15: undefined: Initialize`; gitignored `wire_gen.go`; CGO for SQLite |
| **Q6** — First run vs. subsequent runs | [Section G](#section-g--first-run-vs-subsequent-runs-q6) | Main migrations `performed=626 skipped=0` → `performed=0 skipped=626` (and `resource-migrator` `18` → `skipped=18`); no re-seed; `1.594404517s` → `580.623µs` |

Section A documents the read-only build/run method. Every value quoted above is reproduced exactly as captured, with its `file:line` source; where a value could not be verified from these runs (the "Database locked" line), that is stated explicitly rather than asserted.
