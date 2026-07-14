# Grafana OSS — What a Fresh Instance *Actually* Does on a Clean-State Start

> **Scope of this document.** This is an **evidence-backed, observed-ground-truth** answer to a new engineer's question: *what does a fresh Grafana OSS instance actually do when it starts from a completely clean state* — a brand-new data directory, **no environment variables**, and the default configuration compiled in at `conf/defaults.ini`? Every behavioral claim below is paired with the **actual, unedited** command output that produced it and an inline `path:Lnn` source citation verified against commit `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` (source branch `grafana_4550cfb5b728`). Anything not directly observed is explicitly labeled **(inferred)**.

---

## TL;DR (the one-paragraph answer)

A fresh Grafana OSS backend, started from a clean state with default config, boots in **`app mode = production`** (`conf/defaults.ini:L7`), auto-creates a **single, known administrator** (`admin` / `admin`) and a single organization (`Main Org.`) — it is **not** anonymous and **not** a permissive/open mode. Its only persistent state is a **SQLite** database at `<data>/grafana.db` plus a few empty scratch directories (`png/`, `pdf/`, `csv/`) and a log file; on the **first run only** it creates that database and applies **626 schema migrations** (plus **18** "resource" migrations) and seeds the admin/org, whereas **every subsequent run against the same data dir connects only and skips all of that**. The API exposes **56 feature toggles enabled by default**; the plugin subsystem loads **54 compiled-in core plugins** (of which **49** are surfaced by `/api/plugins`), and **zero** data sources exist until you provision them. The backend cannot even be compiled until a **generated Google Wire file** (`pkg/server/wire_gen.go`) is produced first. Behavior is **deterministic** across runs; the single value that legitimately varies between fresh installs is the admin's random `uid`. The one thing that flips *all* first-run-vs-later behavior is a single fact: **does `grafana.db` already exist?**

> ⚠️ **Non-canonical version.** The running binary in this investigation reports **`version=9.2.0 commit=NA branch=main`**. That is a **NON-CANONICAL** artifact of a plain `go build` with no linker-flag stamping (`pkg/cmd/grafana/main.go:L17-L20`). The **canonical** version for this checkout is **`11.5.0-pre`** (`package.json:L6`). See the [Non-canonical version notice](#non-canonical-version-notice) below — this matters because it leaks into observed output (e.g. the plugin-preinstall failure message literally cites `9.2.0`).

---

## Methodology / Reproduction

### Environment (reproduction context)

- **Go toolchain `1.23.1`**, pinned by `go.mod:L3` (`go 1.23.1`), installed in an isolated location.
- **GCC** present — required because the default database is SQLite compiled via Cgo (`mattn/go-sqlite3`); the build therefore runs with `CGO_ENABLED=1`.
- The repository uses a **Go workspace** (`go.work` at the repo root), so builds must **not** pass `-mod=mod` (it conflicts with workspace mode; leave the default read-only resolution).
- Go build/module caches were isolated to a temp directory so the repository stayed pristine.
- **All writable runtime paths were redirected OUTSIDE the repository** via `cfg:paths.*` command-line overrides; `conf/defaults.ini` was still loaded normally by pointing `--homepath` at the repository root.

Placeholders used below: `<REPO_ROOT>` is the repository checkout; `<TMP>` is a scratch directory outside the repository holding the data/logs/plugins.

### How this was built and run (exact commands, verbatim)

**1. Build FAILS without the generated Wire code** — this proves the code-generation prerequisite:

```
$ CGO_ENABLED=1 go build -o grafana ./pkg/cmd/grafana
# github.com/grafana/grafana/pkg/server
pkg/server/service.go:31:15: undefined: Initialize
```

**2. Generate the Wire file** (equivalent to `make gen-go`):

```
$ go run ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server
wire: github.com/grafana/grafana/pkg/server: wrote .../pkg/server/wire_gen.go
```

**3. Build the canonical entry point** (a plain build → non-canonical version stamp):

```
$ CGO_ENABLED=1 go build -o grafana ./pkg/cmd/grafana        # exit 0
```

**4. Version reported by that plain build** (NON-CANONICAL — see the notice below):

```
$ ./grafana --version
grafana version 9.2.0
$ ./grafana server -v
Version 9.2.0 (commit: NA, branch: main)
```

**5. Run from a completely clean state** (fresh data dir, **no environment variables** via `env -i`, default config):

```
$ env -i HOME=<TMP>/home PATH=/usr/bin:/bin TERM=xterm \
    ./grafana server --homepath=<REPO_ROOT> \
      cfg:paths.data=<TMP>/data cfg:paths.logs=<TMP>/logs cfg:paths.plugins=<TMP>/plugins
```

**6. Probes against the running instance:**

```
$ curl -s http://localhost:3000/api/health
$ curl -s -i -c cookies.txt -H 'Content-Type: application/json' \
       -d '{"user":"admin","password":"admin"}' http://localhost:3000/login
$ curl -s -b cookies.txt http://localhost:3000/api/login/ping
$ curl -s -b cookies.txt http://localhost:3000/api/user
$ curl -s -u admin:admin http://localhost:3000/api/datasources
$ curl -s -u admin:admin http://localhost:3000/api/plugins
```

**7. Re-runs.** The server was run **three times** total: once from a fresh dir (Run 1 = first run), a second time against **the same** data dir (Run 2 = subsequent run), and a third time against a **brand-new** fresh dir (Run 3 = determinism check).

**8. Cleanup.** The generated `pkg/server/wire_gen.go` (git-ignored per `.gitignore:L194` = `**/wire_gen.go`) and the compiled binary were deleted afterward, leaving `git status` clean.

### Why `--homepath` is mandatory

`--homepath` must point at the repository root because configuration loading is **fail-fast**: `loadConfiguration` calls `os.Exit(1)` if `conf/defaults.ini` cannot be found under `HomePath` (`pkg/setting/setting.go:L881-L890`). Without a valid home path there is no run to observe at all.

---

## Non-canonical version notice

**Direct answer:** the version you see at runtime (`9.2.0` / `commit NA` / `branch main`) is **not** a real Grafana release — it is the **hardcoded fallback** compiled into a plain `go build` that did not stamp the real version via linker flags.

- The fallbacks live in the entry point: `pkg/cmd/grafana/main.go:L17` declares `var version = "9.2.0"`, `:L18` `var commit = gcli.DefaultCommitValue`, and `:L20` `var buildBranch = "main"`. The comment directly above them (`:L16`) notes these "cannot be constants, since they can be overridden through the -X link flag." The `DefaultCommitValue = "NA"` constant is defined in `pkg/cmd/grafana-cli/commands/cli.go:L14`.
- A canonical build supplies `-X main.version=...`, `-X main.commit=...`, etc. at link time. This plain build did not, so the fallbacks won.
- The **canonical** version for this checkout is **`11.5.0-pre`** (`package.json:L6`).

**Knock-on effect (observed):** because the binary believes it is `9.2.0`, the remote plugin-preinstall step rejects the `grafana-lokiexplore-app` plugin with a message that literally embeds `9.2.0` — see [§5](#5-plugin--data-source-bootstrap). This is the single most important reason to keep the non-canonical label in mind: the fake version is not cosmetic, it changes an observable downstream result.

Throughout this document, every appearance of `9.2.0` / `NA` is labeled **(non-canonical)**.

---

## §1 Initialization ground truth

**Direct answer:** on a clean start the backend makes a fixed set of automatic decisions — load `conf/defaults.ini`, run in **production** mode, resolve **56** default-on feature toggles, connect to (and, first time, create) a **SQLite** database, run migrations, seed the admin/org, load **54** compiled-in plugins, run init-provisioners, then start background services and listen on `:3000`. The reason "some services report success while others seem disabled or skipped" is **not** that some failed: disabled background services are skipped **silently** by a single gate in the start loop, so they emit *no* log line at all. What you perceive as "some succeed, some are silent" is the contrast between services that happen to log their own initialization and disabled ones that print nothing.

### The observed boot sequence (Run 1, first run)

The full first-run startup log was **1355 lines**. The key non-migrator lines, in order, were:

```
Grafana server is running with elevated privileges. This is not recommended
logger=settings level=info msg="Starting Grafana" version=9.2.0 commit=NA branch=main compiled=2026-07-14T18:32:37Z
logger=settings level=error msg="Failed to detect generated javascript files in public/build"
logger=settings level=info msg="Config loaded from" file=<REPO_ROOT>/conf/defaults.ini
logger=settings level=info msg="App mode production"
logger=featuremgmt level=info msg=FeatureToggles <56 toggles>=true ...
logger=sqlstore level=info msg="Connecting to DB" dbtype=sqlite3
logger=sqlstore level=info msg="Creating SQLite database file" path=<TMP>/data/grafana.db
logger=migrator level=info msg="Starting DB migrations"
logger=migrator level=info msg="migrations completed" performed=626 skipped=0 duration=1.610533539s
logger=sqlstore level=info msg="Created default admin" user=admin
logger=sqlstore level=info msg="Created default organization"
logger=secrets level=info msg="Envelope encryption state" enabled=true currentprovider=secretKey.v1
logger=plugin.store level=info msg="Loading plugins..."
logger=plugin.store level=info msg="Plugins loaded" count=54 duration=29.980896ms
logger=resource-migrator level=info msg="migrations completed" performed=18 skipped=0 duration=45.097449ms
logger=plugin.backgroundinstaller level=info msg="Installing plugin" pluginId=grafana-lokiexplore-app version=
logger=http.server level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=
logger=plugin.backgroundinstaller level=error msg="Failed to install plugin" pluginId=grafana-lokiexplore-app version= error="[plugin.grafanaVersionNotCompatible] grafana-lokiexplore-app is not compatible with your Grafana version: 9.2.0"
logger=resource-server level=warn msg="failed to register storage metrics" error="duplicate metrics collector registration attempted"   (emitted 3x)
logger=grafana-apiserver level=info msg="Adding GroupVersion dashboard.grafana.app v0alpha1 to ResourceManager"   (and featuretoggle/iam/playlist variants)
```

Mapping the sequence to the source:

1. **`App mode production`** — `conf/defaults.ini:L7` sets `app_mode = production`. This *overrides* the in-code default of `"development"` (`pkg/setting/setting.go:L1090`) because of `.ini` precedence; see [§7's mechanism note](#5-critical-implementation-details) and `pkg/setting/setting.go:L900-L929`.
2. **`Config loaded from ... conf/defaults.ini`** — loaded by `loadConfiguration` (`pkg/setting/setting.go:L881-L890`), the fail-fast loader described in the methodology.
3. **`Connecting to DB dbtype=sqlite3` → `Creating SQLite database file`** — the storage bootstrap; the create line appears **only** on the first run (see [§2](#2-persistent-state-what--where) and [§7](#7-first-run-vs-subsequent-runs)).
4. **`Created default admin` / `Created default organization`** — the seeding step (see [§3](#3-security-posture--authentication)).
5. **`Plugins loaded count=54`** — the plugin load (see [§5](#5-plugin--data-source-bootstrap)).
6. **`HTTP Server Listen address=[::]:3000`** — the server begins listening; `http_port = 3000` comes from `conf/defaults.ini:L41`.

### Confirming the server is up: `/api/health`

Once the server is listening, `/api/health` confirms it is up and — because version display is not hidden by default — reports the running version and commit:

```
$ curl -s http://localhost:3000/api/health
{
  "database": "ok",
  "version": "9.2.0",
  "commit": "NA"
}
```

**Mechanism (and a citation correction).** The health endpoint is served by `apiHealthHandler`, **defined at `pkg/api/http_server.go:L710`** (doc comment at `pkg/api/http_server.go:L703-L709`) and **registered as middleware** via `m.Use(hs.apiHealthHandler)` at `pkg/api/http_server.go:L634` — it is *not* a routed `m.Get`. The handler sets `Database: "ok"`, and because `HideVersion` defaults to `false` it adds `Version = BuildVersion` and `Commit = BuildCommit`; it returns **200** normally, or **503** with `"database":"failing"` if the DB check fails. That DB check is `databaseHealthy` (`pkg/api/health.go:L10`), which runs `SELECT 1` and caches the result for 5 seconds. Note: the `version`/`commit` fields above are the **(non-canonical)** `9.2.0` / `NA` stamp. (The `m.Get("/api/health", hs.apiHealthHandler)` you may find at `pkg/api/health_test.go:L187` is **test-only** wiring — it is not how the endpoint is registered in production.)

### Why "disabled / skipped" services are silent (the real mechanism)

Background services are started by a single loop in `Server.Run` (`pkg/server/server.go:L139`). Before starting each service the loop consults a disable gate at `pkg/server/server.go:L150-L151`:

```
for _, svc := range services {
    if registry.IsDisabled(svc) {
        continue
    }
    ...
```

`registry.IsDisabled` (`pkg/registry/registry.go:L53`) returns `true` **only** when a service implements the optional `CanBeDisabled` interface and reports itself disabled:

```
func IsDisabled(srv BackgroundService) bool {
    canBeDisabled, ok := srv.(CanBeDisabled)
    return ok && canBeDisabled.IsDisabled()
}
```

**Key consequence:** when a service is disabled, the loop simply `continue`s — it prints **nothing**. There is **no per-service "disabled" log line** at clean-state startup (this was *not* observed, and the code confirms none is emitted). So the requester's impression that "some services report they are 'disabled' or 'skipped'" is a misreading: disabled services are invisible, while enabled services that *choose* to log their own init (e.g. query service, live push gateway, the multi-org alertmanager) produce the "success"-looking lines. The asymmetry is in **who logs**, not in success-vs-failure.

Server initialization itself (before the background-service loop) runs in `Server.Init` (`pkg/server/server.go:L113`): it writes the PID file, sets environment metrics, registers fixed RBAC roles, and calls `RunInitProvisioners` (which provisions data sources, then plugins, then alerting) — after which `Run` enters the loop above.

### The genuinely observed anomalies (explained, not fixed)

These are real lines from the log and are the actual "not-success" reports — but each is expected for a backend-only clean-state run and **none is remediated here** (per task scope):

- **`Failed to detect generated javascript files in public/build`** (`logger=settings level=error`). Emitted because the **frontend was never built** — this is a backend-only run. It is an observed *data point*, not a defect to fix.
- **`failed to register storage metrics ... duplicate metrics collector registration attempted`** — a `warn`, emitted **3×** by `logger=resource-server`. It is a benign duplicate-registration warning from the unified resource server.
- **`Failed to install plugin pluginId=grafana-lokiexplore-app ... not compatible with your Grafana version: 9.2.0`** — the remote **preinstall** attempt fails the version-compatibility check. The version it cites (`9.2.0`) is the **(non-canonical)** stamp; a canonically-versioned build would present a different compatibility result. Full mechanism in [§5](#5-plugin--data-source-bootstrap).
- **`Config overridden from command line`** — appeared **3×**, one per `cfg:paths.*` override we passed (`paths.data`, `paths.logs`, `paths.plugins`).
- **`Update check succeeded`** — appeared **2×** (a Grafana core check and a plugins check). These succeeded because this environment had internet access. **(inferred)** In a fully offline environment those two checks would instead fail/time out; that offline outcome was **not** observed here and is labeled inferred.

### Honesty note — lines the original brief anticipated but that did NOT appear

The original task brief anticipated a **"missing image renderer"** line and an **"empty external-plugins path"** line at clean-state startup. **Neither was observed** in the captured log. They are therefore **not** claimed here. The actual observed startup anomalies are exactly the five bullets above.

---

## §2 Persistent state (what & where)

**Direct answer:** the only durable state a fresh instance creates is a **SQLite database file** at `<data>/grafana.db`, alongside three empty scratch directories (`png/`, `pdf/`, `csv/`) under the data dir and a `grafana.log` file under the logs dir. On the first run that database is *created* and populated by **626** schema migrations (plus **18** unified-resource migrations); it ends up with **76 tables** and the seeded admin/org rows. Nothing else in the run persists across restarts — the database file is the entirety of the durable state.

### What is written under the data dir (Run 1)

```
<TMP>/data/grafana.db          (1,093,632 bytes)
<TMP>/data/csv/                (empty dir)
<TMP>/data/pdf/                (empty dir)
<TMP>/data/png/                (empty dir)
<TMP>/logs/grafana.log         (198,432 bytes — file sink; log mode "console file")
```

- **`grafana.db`** — the SQLite database. Its type comes from the default config: `conf/defaults.ini` `[database] type = sqlite3`. The startup log's `Connecting to DB dbtype=sqlite3` and `Creating SQLite database file path=<TMP>/data/grafana.db` (Evidence in [§1](#1-initialization-ground-truth)) confirm both the engine and the path.
- **`csv/`, `pdf/`, `png/`** — scratch directories created empty (used later for rendered/exported artifacts; nothing exists on a fresh install).
- **`grafana.log`** — a file sink written *in addition* to the console, because the default log mode is **`console file`** (`conf/defaults.ini:L1071`, inside the `[log]` section at `conf/defaults.ini:L1068`). The paths themselves come from the `[paths]` block: `data = data` (`conf/defaults.ini:L15`), `logs = data/log` (`conf/defaults.ini:L21`) — both redirected outside the repo in this run via `cfg:` overrides.

### The database contents after the first run

```
migration_log rows : 626
total tables       : 76
user               : (id=1, login=admin, email=admin@localhost, is_admin=1, org_id=1)
org                : (id=1, name='Main Org.')
org_user           : (org_id=1, user_id=1, role='Admin')
data_source count  : 0
```

**Before / during / after (first run):**

- **Before:** no `grafana.db` exists (fresh data dir).
- **During:** the migrator emits `Starting DB migrations` then `migrations completed performed=626 skipped=0` — i.e. all 626 migrations were *performed*, none skipped, because the schema did not yet exist.
- **After:** `grafana.db` exists (1,093,632 bytes), `migration_log` has **626** rows, there are **76** tables, and the admin/org/org_user rows are seeded. `data_source` count is **0**.

**Mechanism.** The full OSS migration set is registered by `OSSMigrations.AddMigration` (`pkg/services/sqlstore/migrations/migrations.go:L31`) — this is the function that enqueues every migration (users, orgs, dashboards, data sources, alerting, access-control, and more). A **second, separate** migration phase for the unified resource store is reported by `logger=resource-migrator` (`migrations completed performed=18 skipped=0` in the [§1](#1-initialization-ground-truth) log). Both phases are idempotent — see [§7](#7-first-run-vs-subsequent-runs) for how they report on subsequent runs.

---

## §3 Security posture & authentication

**Direct answer:** the default instance is a **single-known-admin** system, **not** an anonymous or "permissive" one. On first boot it **auto-creates** one administrator with the compiled-in default credentials `admin` / `admin` and one organization; anonymous access is **disabled**, and self-service sign-up is off. The reason you "can log in with credentials you never set up" is simply that those credentials are **compiled-in defaults** that the server seeds into the database for you.

### Observed: logging in with the default credentials works

`POST /login` with `admin`/`admin` returns HTTP 200 and sets a session cookie:

```
$ curl -s -i -c cookies.txt -H 'Content-Type: application/json' -d '{"user":"admin","password":"admin"}' http://localhost:3000/login
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
Set-Cookie: grafana_session=42e531b5a4ebaee2debc49c165e70270; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax
Set-Cookie: grafana_session_expiry=1784054554; Path=/; Max-Age=2592000; SameSite=Lax
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Content-Length: 41

{"message":"Logged in","redirectUrl":"/"}
```

Reusing that cookie, the session is valid and resolves to the seeded admin:

```
$ curl -s -b cookies.txt http://localhost:3000/api/login/ping
{"message":"Logged in"}

$ curl -s -b cookies.txt http://localhost:3000/api/user
{"id":1,"uid":"dfs3y4ti3jls0b","email":"admin@localhost","name":"","login":"admin","theme":"","orgId":1,"isGrafanaAdmin":true,"isDisabled":false,"isExternal":false,"isExternallySynced":false,"isGrafanaAdminExternallySynced":false,"authLabels":[],"updatedAt":"2026-07-14T18:32:39Z","createdAt":"2026-07-14T18:32:39Z","avatarUrl":"/avatar/46d229b033af06a191ff2267bca9ae56"}
```

Note `"isGrafanaAdmin":true` and `"orgId":1` — a single super-admin in the single default org.

### Two different response bodies, two different handlers (do not conflate them)

The two "Logged in" bodies above come from **two distinct handlers**:

- **`POST /login`** is served by **`LoginPost`** (`pkg/api/login.go:L230`), which delegates to `hs.authnService.Login(c.Req.Context(), authn.ClientForm, ...)`. Its success body is `{"message":"Logged in","redirectUrl":"/"}` (note the `redirectUrl`).
- **`GET /api/login/ping`** is served by **`LoginAPIPing`** (`pkg/api/login.go:L222`), which returns `response.JSON(http.StatusOK, util.DynMap{"message": "Logged in"})` at `pkg/api/login.go:L224` — body `{"message":"Logged in"}` (no `redirectUrl`). It is a session *liveness* check, not the login itself.

### Mechanism: how the admin and org get created

The seeding runs during storage initialization: `pkg/services/sqlstore/sqlstore.go:L158` calls `ss.ensureMainOrgAndAdminUser(false)`, whose definition is at `pkg/services/sqlstore/sqlstore.go:L190`. Inside, the new admin's login is taken from config — `Login: ss.cfg.AdminUser` (`pkg/services/sqlstore/sqlstore.go:L214`) — and the two seed events are logged at `pkg/services/sqlstore/sqlstore.go:L222` (`"Created default admin"`) and `pkg/services/sqlstore/sqlstore.go:L230` (`"Created default organization"`). Those are exactly the two lines observed in the [§1](#1-initialization-ground-truth) startup log.

The values themselves are compiled-in defaults from the `[security]` block of `conf/defaults.ini` (section header at `conf/defaults.ini:L323`):

- `admin_user = admin` (`conf/defaults.ini:L328`)
- `admin_password = admin` (`conf/defaults.ini:L331`)
- `disable_initial_admin_creation = false` (`conf/defaults.ini:L325`), which is also the in-code default via `cfg.DisableInitAdminCreation = security.Key("disable_initial_admin_creation").MustBool(false)` at `pkg/setting/setting.go:L1580`. Because it is `false`, the initial admin **is** created.

### Why it is NOT anonymous / permissive

Anonymous access is off by default: the `[auth.anonymous]` section (`conf/defaults.ini:L648`) sets `enabled = false` (`conf/defaults.ini:L650`), and that section is read by `pkg/setting/setting_anonymous.go:L12` (`anonSection := cfg.Raw.Section("auth.anonymous")`). Combined with the single seeded admin, the posture is "one known administrator, everyone else must authenticate" — the opposite of an open/permissive instance.

### Corroboration and the first-login password prompt

The well-known default of `admin`/`admin` at `http://localhost:3000/`, with a forced password change on first successful UI login, is documented in `contribute/developer-guide.md:L125-L131` (URL at `:L123`). The **backend default credentials** are *observed* here (the `POST /login` above). The **browser first-login password-change prompt** itself was **not** exercised via the API in this investigation, so that prompt is reported as **(inferred)** from the developer guide — the credential defaults are observed; the UI prompt flow is documented, not observed.

---

## §4 API feature enablement

**Direct answer:** exactly **56** feature toggles are **enabled by default**; every other toggle in the registry is **opt-in** and requires explicit activation. "Default-on" is determined statically in the code: a flag is on by default if and only if its registry entry carries `Expression: "true"`.

### Observed: 56 toggles printed at startup

The startup log line `logger=featuremgmt level=info msg=FeatureToggles <56 toggles>=true ...` reports 56 enabled flags. The full default-on set (alphabetized) is:

| # | Feature toggle | # | Feature toggle |
|---|---|---|---|
| 1 | `accessActionSets` | 29 | `logsExploreTableVisualisation` |
| 2 | `accessControlOnCall` | 30 | `logsInfiniteScrolling` |
| 3 | `addFieldFromCalculationStatFunctions` | 31 | `lokiQueryHints` |
| 4 | `alertingInsights` | 32 | `lokiQuerySplitting` |
| 5 | `alertingNoDataErrorExecution` | 33 | `lokiStructuredMetadata` |
| 6 | `alertingSimplifiedRouting` | 34 | `managedPluginsInstall` |
| 7 | `alertingUIOptimizeReducer` | 35 | `nestedFolders` |
| 8 | `angularDeprecationUI` | 36 | `newDashboardSharingComponent` |
| 9 | `annotationPermissionUpdate` | 37 | `newFiltersUI` |
| 10 | `awsAsyncQueryCaching` | 38 | `notificationBanner` |
| 11 | `azureMonitorEnableUserAuth` | 39 | `openSearchBackendFlowEnabled` |
| 12 | `cloudWatchCrossAccountQuerying` | 40 | `panelMonitoring` |
| 13 | `cloudWatchNewLabelParsing` | 41 | `pinNavItems` |
| 14 | `cloudWatchRoundUpEndTime` | 42 | `preinstallAutoUpdate` |
| 15 | `cloudwatchMetricInsightsCrossAccount` | 43 | `promQLScope` |
| 16 | `correlations` | 44 | `prometheusAzureOverrideAudience` |
| 17 | `dashboardScene` | 45 | `prometheusConfigOverhaulAuth` |
| 18 | `dashboardSceneForViewers` | 46 | `prometheusMetricEncyclopedia` |
| 19 | `dashboardSceneSolo` | 47 | `publicDashboardsScene` |
| 20 | `dashgpt` | 48 | `recordedQueriesMulti` |
| 21 | `dataplaneFrontendFallback` | 49 | `recoveryThreshold` |
| 22 | `exploreMetrics` | 50 | `singleTopNav` |
| 23 | `formatString` | 51 | `ssoSettingsApi` |
| 24 | `groupToNestedTableTransformation` | 52 | `tlsMemcached` |
| 25 | `influxdbBackendMigration` | 53 | `transformationsRedesign` |
| 26 | `kubernetesPlaylists` | 54 | `transformationsVariableSupport` |
| 27 | `logRowsPopoverMenu` | 55 | `unifiedRequestLog` |
| 28 | `logsContextDatasourceUi` | 56 | `zipkinBackendMigration` |

### Mechanism: default-on vs. opt-in

The registry is `standardFeatureFlags = []FeatureFlag{ ... }` at `pkg/services/featuremgmt/registry.go:L20`. A toggle is enabled by default when its entry sets `Expression: "true"`; a static scan of the registry at the pinned commit finds **exactly 56** such entries — matching the 56 observed at startup. Toggles **without** `Expression: "true"` (the large majority of the registry) are **opt-in**: they stay off until explicitly enabled (e.g. via config `[feature_toggles]` or environment). So "certain features are enabled by default while others require explicit activation" reduces to a single source-of-truth predicate in the registry.

### Honesty note — cosmetic print-order variance

Across the three runs, the `FeatureToggles` log line printed the 56 flags in a **different order each time**. This is a cosmetic artifact of Go **map-iteration order** and is **not** behavioral — the *set* of 56 is identical every run. It is called out here explicitly because it is one of the "apparent run-to-run inconsistencies" a reader might worry about; it has no functional effect.

---

## §5 Plugin & data source bootstrap

**Direct answer:** the plugins that "appear even though you didn't install them" are **compiled-in core plugins** — they ship inside the binary/tree, not on disk and not fetched remotely. On a fresh install the loader reports **54** core plugins loaded; `/api/plugins` surfaces **49** of them (the other 5 are intentionally hidden). **Zero external plugins** are discovered from disk (the plugins dir is empty), and the single **remote preinstall** attempt (`grafana-lokiexplore-app`) **fails** the version check. Data sources are **empty** (`[]`) because none are provisioned on a fresh install.

### Observed: the plugin and data-source API responses

```
$ curl -s -u admin:admin http://localhost:3000/api/datasources
[]
```

```
$ curl -s -u admin:admin http://localhost:3000/api/plugins   # summarized
TOTAL PLUGINS: 49
by type: {'panel': 30, 'datasource': 19}
by signature: {'internal': 49}

$ curl -s -u admin:admin 'http://localhost:3000/api/plugins?type=app'
[]     # total=0

$ curl -s -u admin:admin 'http://localhost:3000/api/plugins?core=1'
# total=49, types {'panel': 30, 'datasource': 19}
```

All 49 report `signature: internal` — i.e. compiled-in/core, **not** on-disk external and **not** remotely fetched.

### The three tiers of the plugin ecosystem

1. **Compiled-in / core (what you see).** These are loaded by the plugin store, which logs `"Loading plugins..."` at `pkg/services/pluginsintegration/pluginstore/store.go:L38` and `"Plugins loaded"` with `count`/`duration` at `pkg/services/pluginsintegration/pluginstore/store.go:L50` — observed as `Plugins loaded count=54`. Their sources are registered in `pkg/plugins/manager/sources/sources.go` (`List()` registers `ClassCore` from `corePluginPaths(StaticRootPath)`, `ClassBundled` from `BundledPluginsPath`, and `ClassExternal` from `DirAsLocalSources(PluginsPath)`).
2. **Disk-discovered external.** The external (on-disk) source is `pkg/plugins/manager/sources/source_local_disk.go`. On this fresh install the plugins directory (`cfg:paths.plugins=<TMP>/plugins`) is **empty**, so **no** external plugins are discovered.
3. **Remote preinstall.** A background installer attempts to fetch a preinstalled plugin from the remote catalog — driven by `pkg/services/pluginsintegration/plugininstaller/service.go`. On a fresh install it tries `grafana-lokiexplore-app` and **fails** the compatibility check (see below).

### Where the `grafana-lokiexplore-app` preinstall actually comes from

This is a **correction** to the naive assumption that it comes from the config file. The `preinstall =` key in `conf/defaults.ini` (`conf/defaults.ini:L1766`) is **EMPTY**. The plugin id is instead a **hardcoded Go default**: `pkg/setting/setting_plugins.go:L30` declares `defaultPreinstallPlugins = map[string]InstallPlugin{`, and `pkg/setting/setting_plugins.go:L32` contains `"grafana-lokiexplore-app": {"grafana-lokiexplore-app", "", ""}`. That map is merged into `cfg.PreinstallPlugins` at `pkg/setting/setting_plugins.go:L77`. The observed failure:

```
logger=plugin.backgroundinstaller level=error msg="Failed to install plugin" pluginId=grafana-lokiexplore-app version= error="[plugin.grafanaVersionNotCompatible] grafana-lokiexplore-app is not compatible with your Grafana version: 9.2.0"
```

The `9.2.0` in that message is the **(non-canonical)** version stamp; the failure is thus partly an artifact of the plain build (see the [Non-canonical version notice](#non-canonical-version-notice)).

### Reconciling 54 (loaded) vs. 49 (API) — the exact math

- **Core plugin directories:** **32 panels** (`public/app/plugins/panel/`) + **22 datasources** (`public/app/plugins/datasource/`) = **54** → matches the `Plugins loaded count=54` log line.
- **`/api/plugins` returns 49** = **30 panel** + **19 datasource**.
- **The 5 hidden ones** are:
  - **3 built-in datasources** — `grafana`, `mixed`, `dashboard` (each has `"builtIn": true` in its `plugin.json`), and
  - **2 alpha-state panels** — `debug`, `live` (each has `"state": "alpha"` in its `plugin.json`).
- **Two datasource dirs are remapped** (not hidden — they *are* in the 19): `azuremonitor` → id `grafana-azure-monitor-datasource`, and `cloud-monitoring` → id `stackdriver`.
- The **19 datasource ids** returned: `alertmanager, cloudwatch, elasticsearch, grafana-azure-monitor-datasource, grafana-postgresql-datasource, grafana-pyroscope-datasource, grafana-testdata-datasource, graphite, influxdb, jaeger, loki, mssql, mysql, opentsdb, parca, prometheus, stackdriver, tempo, zipkin`.

So: `54 loaded − 3 builtin datasources − 2 alpha panels = 49 shown`. The `?type=app` query returns `[]` because there are **no** app-type plugins in the compiled-in core set on a fresh install.

### Why data sources are empty

`/api/datasources` returns `[]` because a fresh instance provisions nothing: `RunInitProvisioners` (called from `Server.Init`, `pkg/server/server.go:L113`) has no provisioning files to read under the default `provisioning = conf/provisioning` path (`conf/defaults.ini:L27`) that would create a data source. Data sources only appear once you create or provision them.

---

## §6 Build & compilation

**Direct answer:** the runtime depends on a **generated file that is not in version control** — `pkg/server/wire_gen.go`. Until you generate it, the canonical entry point **does not compile**; the build fails with `undefined: Initialize`. So "running the server directly vs. building first" is a false dichotomy: **both** paths require the Wire artifact to exist first. Once it is generated, `go run` and a built binary behave equivalently.

### Observed: the build fails without the generated Wire file

```
$ CGO_ENABLED=1 go build -o grafana ./pkg/cmd/grafana
# github.com/grafana/grafana/pkg/server
pkg/server/service.go:31:15: undefined: Initialize
```

The undefined symbol is at `pkg/server/service.go:L31`:

```
serv, err := Initialize(s.cfg, s.opts, s.apiOpts)
```

`Initialize` is the Google Wire *injector* — its body is generated into `pkg/server/wire_gen.go`, which does not exist in a clean checkout.

### Observed: generating it, then building successfully

```
$ go run ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server
wire: github.com/grafana/grafana/pkg/server: wrote .../pkg/server/wire_gen.go

$ CGO_ENABLED=1 go build -o grafana ./pkg/cmd/grafana        # exit 0
```

### Mechanism and why the file is absent from git

- `pkg/server/wire_gen.go` is **git-ignored** by the pattern `**/wire_gen.go` at `.gitignore:L194` — it is a build artifact, regenerated on demand, deliberately never committed.
- The canonical way to generate it is `make gen-go`: the `gen-go` target (`Makefile:L167-L169`) runs `$(GO) run ... ./pkg/build/wire/cmd/wire/main.go gen -tags $(WIRE_TAGS) ./pkg/server`, where `WIRE_TAGS = "oss"` (`Makefile:L5`). The command we ran by hand is exactly that recipe expanded.
- The build targets depend on codegen: `build-go: gen-go ...` (`Makefile:L187`) and `build-go-fast: gen-go` (`Makefile:L191`). So the official build path always generates Wire first — our manual sequence just reproduces that ordering.

### Answering "run directly vs. build first"

There is **no** equivalent behavior *without* the generated artifact — neither `go run ./pkg/cmd/grafana` nor `go build ./pkg/cmd/grafana` can succeed until `pkg/server/wire_gen.go` exists, because `Initialize` (`pkg/server/service.go:L31`) is undefined without it. After generation, the two approaches are equivalent: they compile the same wired `Server` and exhibit identical runtime behavior. (The version-stamp caveat from the [Non-canonical version notice](#non-canonical-version-notice) is orthogonal — it depends on linker flags, not on run-vs-build.)

---

## §7 First run vs. subsequent runs

**Direct answer:** the difference between the first run and later runs is gated by **one fact only — whether `grafana.db` already exists.** The first run against a fresh dir **creates** the database, runs **626** schema migrations + **18** resource migrations, and **seeds** the admin/org. Every subsequent run against the same dir **connects only**: it reports `performed=0 skipped=626` (and `skipped=18`), does **not** re-create the file, and does **not** re-seed. The persisted database is what makes "subsequent runs behave differently and the difference survives a stop/restart."

### The delta table

| Aspect | First run (fresh dir) | Subsequent run (same dir) |
|---|---|---|
| SQLite file | `Creating SQLite database file` | connect only (no create) |
| main migrations | `performed=626 skipped=0` | `performed=0 skipped=626` |
| resource migrations | `performed=18 skipped=0` | `performed=0 skipped=18` |
| admin/org seed | `Created default admin` + `Created default organization` | (none) |
| plugins loaded | `count=54` | `count=54` |
| version | `9.2.0` / `NA` **(non-canonical)** | `9.2.0` / `NA` **(non-canonical)** |
| startup log size | 1355 lines | 62 lines |

### Observed: the subsequent run (Run 2, SAME data dir)

The second run's startup log dropped from 1355 lines to **62 lines**. Key lines:

```
grafana.db present BEFORE run : yes (1,093,632 bytes);  migration_log BEFORE : 626
logger=sqlstore level=info msg="Connecting to DB" dbtype=sqlite3          # NOTE: no "Creating SQLite database file"
logger=migrator level=info msg="migrations completed" performed=0 skipped=626 duration=750.411µs
logger=resource-migrator level=info msg="migrations completed" performed=0 skipped=18 duration=33.699µs
logger=plugin.store level=info msg="Plugins loaded" count=54 duration=27.94127ms
logger=http.server level=info msg="HTTP Server Listen" address=[::]:3000 ...
# (NO "Created default admin"; NO "Created default organization")
migration_log AFTER : 626 ;  user/org rows unchanged
```

Run 2's API results were **identical** to Run 1: health `9.2.0/NA` **(non-canonical)**; `POST /login` → `{"message":"Logged in","redirectUrl":"/"}`; `/api/user` returned the **same** admin with the **same** `uid` `dfs3y4ti3jls0b` and the **same** `createdAt` (proving the row *persisted* and was not recreated); `/api/datasources` → `[]`.

### Mechanism

The presence of `grafana.db` is the switch. On first run the file does not exist, so the storage layer emits `Creating SQLite database file` and the migrator finds an empty schema → all 626 migrations are *performed*. On later runs the file (and its `migration_log`) already exist, so the migrator marks all 626 as *skipped* and the create line is never printed. Seeding is likewise idempotent: `ensureMainOrgAndAdminUser` (`pkg/services/sqlstore/sqlstore.go:L190`) finds the existing admin/org and does **not** re-create them (hence no `Created default admin`/`Created default organization` lines on Run 2). This is why the behavior "persists even after you stop and restart" — the durable SQLite state is what later runs read.

### Determinism (Run 3, brand-new fresh dir)

A third run against a brand-new fresh dir reproduced Run 1's first-run behavior exactly:

```
msg="Creating SQLite database file" ; performed=626 skipped=0 ; "Created default admin" ; "Created default organization" ; Plugins loaded count=54 ; FeatureToggles = 56 ; grafana.db = 1,093,632 bytes (byte-identical size to Run 1)
```

**The only value that differed across fresh installs was the admin `uid`** — Run 1/2 had `dfs3y4ti3jls0b`, Run 3 had `efs3yrvo19kaod`. The `uid` is **randomly generated per install**; `id` (`1`), `login` (`admin`), `email` (`admin@localhost`), and `isGrafanaAdmin` (`true`) were identical every time. The other apparent variance — the `FeatureToggles` **print order** — is the cosmetic Go map-iteration artifact from [§4](#4-api-feature-enablement). Both are **apparent inconsistencies that are not behavioral**: the durable outcome is deterministic.

---

## Appendix A — Evidence index / commands

The probe and inspection commands used to gather the evidence in this document:

| Purpose | Command |
|---|---|
| Build without Wire (fails) | `CGO_ENABLED=1 go build -o grafana ./pkg/cmd/grafana` |
| Generate Wire file | `go run ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server` |
| Build (succeeds) | `CGO_ENABLED=1 go build -o grafana ./pkg/cmd/grafana` |
| Version (non-canonical) | `./grafana --version` ; `./grafana server -v` |
| Clean-state run | `env -i HOME=<TMP>/home PATH=/usr/bin:/bin TERM=xterm ./grafana server --homepath=<REPO_ROOT> cfg:paths.data=<TMP>/data cfg:paths.logs=<TMP>/logs cfg:paths.plugins=<TMP>/plugins` |
| Health | `curl -s http://localhost:3000/api/health` |
| Login (POST) | `curl -s -i -c cookies.txt -H 'Content-Type: application/json' -d '{"user":"admin","password":"admin"}' http://localhost:3000/login` |
| Session ping | `curl -s -b cookies.txt http://localhost:3000/api/login/ping` |
| Current user | `curl -s -b cookies.txt http://localhost:3000/api/user` |
| Data sources | `curl -s -u admin:admin http://localhost:3000/api/datasources` |
| Plugins | `curl -s -u admin:admin http://localhost:3000/api/plugins` |
| Cleanup | delete generated `pkg/server/wire_gen.go` (git-ignored) + binary; `git status` clean |

## Appendix B — Observed-vs-inferred ledger

**Observed (backed by captured output in this document):**

- The full boot sequence and its key log lines (Evidence in [§1](#1-initialization-ground-truth)).
- `app mode = production`; config loaded from `conf/defaults.ini`.
- 56 default-on feature toggles (count observed; matches static registry).
- SQLite `grafana.db` created on first run; 626 migrations performed; 18 resource migrations; 76 tables; seeded admin/org rows; `data/{png,pdf,csv}` dirs; `logs/grafana.log`.
- `POST /login` success (200 + session cookie), `/api/login/ping`, `/api/user` (single super-admin, org 1).
- `/api/datasources` = `[]`; `/api/plugins` = 49 (30 panel + 19 datasource, all `internal`); `?type=app` = `[]`.
- 54 core plugins loaded; the `grafana-lokiexplore-app` remote preinstall failing the version check.
- Build fails with `undefined: Initialize` without Wire; succeeds after `wire_gen.go` is generated.
- First-vs-subsequent deltas (Run 2) and determinism (Run 3), including the byte-identical `grafana.db` size and the varying admin `uid`.

**Inferred / documented-but-not-observed (explicitly labeled):**

- **Offline update-checker behavior.** The two `Update check succeeded` lines occurred because this environment had internet. In a fully offline environment those checks would fail/time out — **(inferred)**, not observed here.
- **Browser first-login password-change prompt.** The forced password change on first UI login is documented at `contribute/developer-guide.md:L125-L131`; it was **not** exercised via the API here — **(inferred)** from the docs. The backend credential defaults *are* observed.
- **Lines the original brief anticipated but that did NOT appear:** a "missing image renderer" line and an "empty external-plugins path" line were **not** observed at clean-state startup and are therefore **not** claimed.

## Appendix C — Citation map (condensed)

| Topic | Citation(s) |
|---|---|
| Version fallbacks (non-canonical) | `pkg/cmd/grafana/main.go:L17` (`9.2.0`), `:L18` (commit), `:L20` (`main`); `pkg/cmd/grafana-cli/commands/cli.go:L14` (`DefaultCommitValue = "NA"`) |
| Canonical version | `package.json:L6` (`11.5.0-pre`) |
| Config load (fail-fast) | `pkg/setting/setting.go:L881-L890` |
| `.ini` precedence | `pkg/setting/setting.go:L900-L929` |
| `app_mode` (prod vs dev default) | `conf/defaults.ini:L7`; `pkg/setting/setting.go:L1090` |
| Server lifecycle | `pkg/server/server.go:L113` (`Init`), `:L139` (`Run`) |
| Disable gate (silent skip) | `pkg/server/server.go:L150-L151`; `pkg/registry/registry.go:L53` |
| Wire injector symbol | `pkg/server/service.go:L31` (`Initialize`) |
| Wire git-ignore + build | `.gitignore:L194`; `Makefile:L5`, `:L167-L169` (`gen-go`), `:L187` (`build-go`), `:L191` (`build-go-fast`) |
| SQLite / paths / log | `conf/defaults.ini` `[database] type = sqlite3`; `[paths]` `:L15`/`:L21`/`:L24`/`:L27`; `[log]` `:L1068`, `mode` `:L1071`; `http_port` `:L41` |
| Migrations | `pkg/services/sqlstore/migrations/migrations.go:L31` |
| Admin/org seeding | `pkg/services/sqlstore/sqlstore.go:L158`, `:L190`, `:L214`, `:L222`, `:L230` |
| Security defaults | `conf/defaults.ini:L323` (`[security]`), `:L325`, `:L328`, `:L331`; `pkg/setting/setting.go:L1580` |
| Anonymous disabled | `conf/defaults.ini:L648`, `:L650`; `pkg/setting/setting_anonymous.go:L12` |
| Login handlers | `pkg/api/login.go:L222` (`LoginAPIPing`), `:L224` (ping body), `:L230` (`LoginPost`) |
| Health handler | `pkg/api/http_server.go:L634` (`m.Use`), `:L703-L709` (doc), `:L710` (`apiHealthHandler`); `pkg/api/health.go:L10` (`databaseHealthy`); `pkg/api/health_test.go:L187` (test-only) |
| Feature toggles | `pkg/services/featuremgmt/registry.go:L20` (56 `Expression:"true"`) |
| Plugin load logs | `pkg/services/pluginsintegration/pluginstore/store.go:L38`, `:L50` |
| Plugin sources | `pkg/plugins/manager/sources/sources.go`; `pkg/plugins/manager/sources/source_local_disk.go` |
| Preinstall origin | `pkg/setting/setting_plugins.go:L30`, `:L32`, `:L77`; `conf/defaults.ini:L1766` (empty `preinstall =`); `pkg/services/pluginsintegration/plugininstaller/service.go` |
| Toolchain | `go.mod:L3` (`go 1.23.1`); `.nvmrc` (`v22.11.0`); `package.json` (`engines.node ">= 22"`, `packageManager yarn@4.5.3`) |
| Reference docs | `contribute/developer-guide.md:L9-L12`, `:L123`, `:L125-L131`; `README.md:L34-L35`; `CONTRIBUTING.md:L74` |

---

*Every behavioral claim in this document is paired with the actual, unedited command output that produced it and a source citation verified against commit `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`. Values that depend on how the binary was built (notably `9.2.0` / `NA`) are labeled non-canonical; values that were documented but not directly exercised are labeled (inferred).*
