# What Grafana Does on a Clean-State Startup — A Run-First, Evidence-Grounded Investigation

> **Scope of this document.** This is a factual, *observed-behavior* account of what Grafana (`grafana/grafana`, product version `11.5.0-pre`, commit `4550cfb5b7`, source branch `grafana_4550cfb5b728`) actually does when it boots from a **completely clean state**: no `conf/custom.ini`, no `GF_*` environment variables, and an empty/absent data directory. Every behavioral claim below was produced by **building and running the real server first**, capturing complete unedited output, and only *then* grounding the explanation in the source with `file:line` references. Values that depend on how the binary is built (version banner, app mode) are reported for the **canonical default** invocation, with non-canonical values explicitly labeled. Anything that could not be produced at runtime is explicitly labeled **inferred**.

---

## Executive Summary / TL;DR

- **Area 1 — Initialization.** The process entry point `pkg/cmd/grafana/main.go` registers a `server` subcommand that assembles a `*server.Server` through **Google Wire** (`Initialize`, generated into `pkg/server/wire_gen.go`) and runs it via `Server.New → Server.Init → Server.Run`. The default database backend, **SQLite3**, is chosen automatically from `conf/defaults.ini` (`type = sqlite3`, L123) — no decision by the user. The `"disabled"/"skipped"` lines are **not** printed by the run loop; the `registry.IsDisabled` gate at `pkg/server/server.go:150` is *silent* (`continue` with no log). The visible text is emitted by individual subsystems (e.g. `local.finder`, `secrets.kvstore`, `migrator`) during their own construction.
- **Area 2 — Persistent state.** The **first** run creates `data/grafana.db`, applies **626** schema migrations (`performed=626 skipped=0`, ~54 s), and bootstraps the **Main Org.** and the **admin** user *once* (`Created default admin`, `Created default organization`). A **subsequent** run against the *same* data directory finds everything present and skips creation (`performed=0 skipped=626` in ~0.7 ms; both `Created default …` lines absent). This is the persistent behavior change that survives stop/restart.
- **Area 3 — Security posture.** This is **not** a permissive/anonymous mode. Grafana *creates* an `admin`/`admin` account (`conf/defaults.ini:328,331`) and the frontend **forces a password change** when you log in with the password `admin`. Anonymous access is **disabled** (unauthenticated `/api/user` → **HTTP 401**), self-service sign-up is **disabled** (`allow_sign_up = false`), and feature toggles split into **56** enabled-by-default (`Expression: "true"`) vs **12** explicit opt-in (`Expression: "false"`).
- **Area 4 — Plugins vs data sources.** Core data-source and panel plugins are **compiled into the binary** and **bundled in-tree** (`public/app/plugins`), so `/api/plugins` returns **50** plugins (**49 `internal` + 1 `valid`**) with zero user action, while `/api/datasources` returns an **empty `[]`**. A plugin ≠ a configured data source; no data source is provisioned because the `conf/provisioning` samples ship commented out.
- **Area 5 — Build dependency.** `pkg/server/wire_gen.go` is **git-ignored** (`.gitignore:194`) and produced by `make gen-go`. Without it the backend **does not compile** (`pkg/server/service.go:31:15: undefined: Initialize`). Running directly with `go run` still requires it. A plain `go run` also skips ldflags, so it reports a **non-canonical** `9.2.0` banner; the canonically-built binary reports `11.5.0-pre`. The full UI additionally needs `public/build/*` from `yarn build`.
- **Read-only guarantee.** The only repository artifact created is *this* document. `git status --porcelain` at the end shows only the new file under `blitzy/`. Zero tracked source files were modified; all runtime state and scratch artifacts live outside the repo tree under `/tmp`.

---

## Canonical Build & Run Baseline

Everything in the five answer sections was produced with the commands and environment recorded here. **Disclose-everything** is the rule: where a value depends on the build, both the canonical and non-canonical forms are shown and labeled.

### Repository identity & read-only starting state

```console
$ git rev-parse --abbrev-ref HEAD
blitzy-d319eda3-6a4f-4f3c-a8c4-70f4da2bbc81
$ git rev-parse HEAD
4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff
$ git status --porcelain
?? blitzy/
```

The working branch is the destination branch; the **source branch** from which this file's name derives is `grafana_4550cfb5b728`, corresponding one-to-one to HEAD commit `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` (the short form `4550cfb5b7` is what the version banner stamps). The only untracked entry is `blitzy/` (this document); **no tracked file is modified**.

### Toolchain (consumed, never changed)

```console
$ go version
go version go1.23.1 linux/amd64
$ node --version
v22.23.1
$ yarn --version
4.5.3
$ gcc --version | head -1
gcc (Ubuntu 15.2.0-4ubuntu4) 15.2.0
```

| Component | Observed | Pinned by | Purpose |
|-----------|----------|-----------|---------|
| Go | `go1.23.1` | `go.mod:3` (`go 1.23.1`) | Compile/run backend; Wire codegen |
| Node.js | `v22.23.1` | `.nvmrc` (`v22.11.0`); `package.json:451` engines `"node": ">= 22"` | Frontend build/tooling |
| Yarn | `4.5.3` | `package.json:453` (`packageManager: yarn@4.5.3`) | JS dependency mgmt / frontend build |
| Grafana | `11.5.0-pre` | `package.json:6` (`version`) | Product version under investigation |
| GCC | `15.2.0` | container | CGO compile of embedded SQLite (`mattn/go-sqlite3`) |

> Note: the container sets `GOFLAGS=-mod=readonly`, which guards `go.mod`/`go.sum`/`go.work.sum` against mutation. Consequently `make build-go` (which chains `update-workspace` → `go mod tidy` + `go work sync`) is **avoided**; the backend is built with `make gen-go` + a direct `go build`.

### Step 1 — Generate the Wire dependency-injection code (required before the backend compiles)

```console
$ make gen-go
generate go files
go run  ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server
wire: github.com/grafana/grafana/pkg/server: wrote /tmp/blitzy/grafana/blitzy-d319eda3-6a4f-4f3c-a8c4-70f4da2bbc81_ea68e0/pkg/server/wire_gen.go
```

`pkg/server/wire_gen.go` (94781 bytes) is produced. It is **git-ignored** (`.gitignore:194` = `**/wire_gen.go`), so generating it does **not** dirty the tree:

```console
$ git check-ignore pkg/server/wire_gen.go
pkg/server/wire_gen.go
$ git status --porcelain
?? blitzy/
```

### Step 2 — Build the backend canonically (real version stamped via ldflags)

```console
$ PRODVER=$(node -p "require('./package.json').version")   # => 11.5.0-pre
$ GITSHA=$(git rev-parse --short HEAD)                       # => 4550cfb5b7
$ go build -ldflags "-X main.version=${PRODVER} -X main.commit=${GITSHA} \
    -X main.buildBranch=grafana_4550cfb5b728 -X main.buildstamp=$(date +%s)" \
    -o /tmp/gf-build/grafana ./pkg/cmd/grafana
# exit=0, ~23s, binary 298085416 bytes
```

The `-X main.*` flags mirror how the project's own build assembles ldflags in `pkg/build/cmd.go` (version at L247, commit at L248, buildstamp at L252, buildBranch at L253).

### Version banner — reported BOTH ways (canonical vs non-canonical)

```console
# NON-CANONICAL — plain build with NO ldflags (falls back to compile-time defaults)
$ /tmp/grafana-bin/grafana --version
grafana version 9.2.0
$ go run ./pkg/cmd/grafana server -v
Version 9.2.0 (commit: NA, branch: main)

# CANONICAL — the ldflags-stamped binary
$ /tmp/gf-build/grafana --version
grafana version 11.5.0-pre
$ /tmp/gf-build/grafana server -v
Version 11.5.0-pre (commit: 4550cfb5b7, branch: grafana_4550cfb5b728)
```

**The `9.2.0` banner is misleading and non-canonical.** It is the compile-time fallback in `pkg/cmd/grafana/main.go` (`var version = "9.2.0"` L17; `var commit = gcli.DefaultCommitValue` L18 where `DefaultCommitValue = "NA"` at `pkg/cmd/grafana-cli/commands/cli.go:14`; `var buildBranch = "main"` L20). A plain `go run` applies no ldflags, so these fallbacks show through. The **canonical** value a normal user gets from a built binary is `11.5.0-pre`.

### Clean-state engineering (fully outside the repo tree)

The definitive run-pair uses a self-contained temp homepath so that **all** state (DB, logs, plugins) lands outside the repository — not just the database:

```console
$ ls -la /tmp/gf-home
conf -> /tmp/blitzy/.../conf          # symlink to the repo's read-only conf/
public -> /tmp/blitzy/.../public      # symlink to the repo's read-only public/
data/                                 # fresh, empty on first run
$ env | grep ^GF_        # (empty — no GF_* overrides)
$ ls conf/custom.ini     # ls: cannot access 'conf/custom.ini': No such file or directory
```

Canonical invocation (no `cfg:` overrides, default port 3000):

```console
$ /tmp/gf-build/grafana server --homepath=/tmp/gf-home
```

This loads `conf/defaults.ini` **read-only** through the symlink and routes `data/`, `data/log/`, and `data/plugins/` under `/tmp/gf-home` — mutating **no** tracked file. First-run vs subsequent-run is produced by re-running against the **same** `/tmp/gf-home/data`.

---

## Area 1 — Initialization from a Clean State

### Direct answer

On startup Grafana assembles a single `*server.Server` object through **Google Wire** and then runs a set of registered **background services**. The database backend is **not** something the user picks — **SQLite3** is selected automatically because `conf/defaults.ini` declares `type = sqlite3` and no `custom.ini`/`GF_*` override exists. The `"disabled"/"skipped"` lines you see are **not** emitted by the run loop: the `registry.IsDisabled` gate in `Server.Run` simply `continue`s (silently) past any service that opts out, so the visible text originates in the individual subsystems themselves. Enabled services log a Debug `"Starting background service"` line and then report their own success.

### Observed evidence

The cleanest complete stream is a **subsequent** run (first-run migration spam omitted by the system itself, not by us), captured start-to-finish:

```console
$ /tmp/gf-build/grafana server --homepath=/tmp/gf-home > /tmp/gf-home/subsequent.log 2>&1 &
$ cat -n /tmp/gf-home/subsequent.log
     1	Grafana server is running with elevated privileges. This is not recommended
     2	logger=settings t=2026-07-13T16:55:08.359918683Z level=info msg="Starting Grafana" version=11.5.0-pre commit=4550cfb5b7 branch=grafana_4550cfb5b728 compiled=2026-07-13T16:36:31Z
     3	logger=settings t=2026-07-13T16:55:08.360205918Z level=info msg="Config loaded from" file=/tmp/gf-home/conf/defaults.ini
     4	logger=settings t=2026-07-13T16:55:08.360216025Z level=info msg=Target target=[all]
     5	logger=settings t=2026-07-13T16:55:08.360225757Z level=info msg="Path Home" path=/tmp/gf-home
     6	logger=settings t=2026-07-13T16:55:08.360231064Z level=info msg="Path Data" path=/tmp/gf-home/data
     7	logger=settings t=2026-07-13T16:55:08.360235973Z level=info msg="Path Logs" path=/tmp/gf-home/data/log
     8	logger=settings t=2026-07-13T16:55:08.360241044Z level=info msg="Path Plugins" path=/tmp/gf-home/data/plugins
     9	logger=settings t=2026-07-13T16:55:08.360245947Z level=info msg="Path Provisioning" path=/tmp/gf-home/conf/provisioning
    10	logger=settings t=2026-07-13T16:55:08.360250753Z level=info msg="App mode production"
    11	logger=featuremgmt t=2026-07-13T16:55:08.360561211Z level=info msg=FeatureToggles alertingSimplifiedRouting=true newFiltersUI=true newDashboardSharingComponent=true alertingInsights=true kubernetesPlaylists=true dashboardScene=true accessControlOnCall=true influxdbBackendMigration=true awsAsyncQueryCaching=true prometheusMetricEncyclopedia=true zipkinBackendMigration=true recoveryThreshold=true panelMonitoring=true tlsMemcached=true logsExploreTableVisualisation=true managedPluginsInstall=true preinstallAutoUpdate=true openSearchBackendFlowEnabled=true dashboardSceneSolo=true publicDashboardsScene=true singleTopNav=true dataplaneFrontendFallback=true prometheusAzureOverrideAudience=true ssoSettingsApi=true lokiStructuredMetadata=true dashgpt=true logsContextDatasourceUi=true groupToNestedTableTransformation=true cloudWatchNewLabelParsing=true lokiQuerySplitting=true cloudWatchCrossAccountQuerying=true correlations=true alertingNoDataErrorExecution=true notificationBanner=true lokiQueryHints=true dashboardSceneForViewers=true transformationsVariableSupport=true addFieldFromCalculationStatFunctions=true annotationPermissionUpdate=true nestedFolders=true prometheusConfigOverhaulAuth=true alertingUIOptimizeReducer=true logsInfiniteScrolling=true angularDeprecationUI=true logRowsPopoverMenu=true exploreMetrics=true formatString=true cloudwatchMetricInsightsCrossAccount=true azureMonitorEnableUserAuth=true pinNavItems=true unifiedRequestLog=true recordedQueriesMulti=true cloudWatchRoundUpEndTime=true accessActionSets=true promQLScope=true transformationsRedesign=true
    12	logger=sqlstore t=2026-07-13T16:55:08.360629167Z level=info msg="Connecting to DB" dbtype=sqlite3
    13	logger=migrator t=2026-07-13T16:55:08.362323876Z level=info msg="Locking database"
    14	logger=migrator t=2026-07-13T16:55:08.362343552Z level=info msg="Starting DB migrations"
    15	logger=migrator t=2026-07-13T16:55:08.369384625Z level=info msg="migrations completed" performed=0 skipped=626 duration=743.836µs
    16	logger=migrator t=2026-07-13T16:55:08.369558027Z level=info msg="Unlocking database"
    17	logger=secrets t=2026-07-13T16:55:08.36970221Z level=info msg="Envelope encryption state" enabled=true currentprovider=secretKey.v1
    18	logger=plugin.angulardetectorsprovider.dynamic t=2026-07-13T16:55:08.429370094Z level=info msg="Restored cache from database" duration=274.895µs
    19	logger=plugin.store t=2026-07-13T16:55:08.430162687Z level=info msg="Loading plugins..."
    20	logger=local.finder t=2026-07-13T16:55:08.463285005Z level=warn msg="Skipping finding plugins as directory does not exist" path=/tmp/gf-home/plugins-bundled
    21	logger=plugins.registration t=2026-07-13T16:55:08.494537258Z level=info msg="Plugin registered" pluginId=grafana-lokiexplore-app
    22	logger=plugin.store t=2026-07-13T16:55:08.494569509Z level=info msg="Plugins loaded" count=55 duration=64.407629ms
    23	logger=query_data t=2026-07-13T16:55:08.498376559Z level=info msg="Query Service initialization"
    24	logger=live.push_http t=2026-07-13T16:55:08.505039704Z level=info msg="Live Push Gateway initialization"
    25	logger=ngalert.notifier.alertmanager org=1 t=2026-07-13T16:55:08.508581722Z level=info msg="Applying new configuration to Alertmanager" configHash=d2c56faca6af2a5772ff4253222f7386
    26	logger=ngalert.state.manager t=2026-07-13T16:55:08.557480025Z level=info msg="Running in alternative execution of Error/NoData mode"
    27	logger=resource-migrator t=2026-07-13T16:55:08.558646479Z level=info msg="Locking database"
    28	logger=resource-migrator t=2026-07-13T16:55:08.558668477Z level=info msg="Starting DB migrations"
    29	logger=resource-migrator t=2026-07-13T16:55:08.559121241Z level=info msg="migrations completed" performed=0 skipped=18 duration=41.573µs
    30	logger=resource-migrator t=2026-07-13T16:55:08.559266959Z level=info msg="Unlocking database"
    31	logger=infra.usagestats.collector t=2026-07-13T16:55:08.560801789Z level=info msg="registering usage stat providers" usageStatsProvidersLen=2
    32	logger=provisioning.alerting t=2026-07-13T16:55:08.561661173Z level=info msg="starting to provision alerting"
    33	logger=provisioning.alerting t=2026-07-13T16:55:08.561689602Z level=info msg="finished to provision alerting"
    34	logger=ngalert.state.manager t=2026-07-13T16:55:08.562027799Z level=info msg="Warming state cache for startup"
    35	logger=ngalert.state.manager t=2026-07-13T16:55:08.56222557Z level=info msg="State cache has been initialized" states=0 duration=197.992µs
    36	logger=ngalert.multiorg.alertmanager t=2026-07-13T16:55:08.562234979Z level=info msg="Starting MultiOrg Alertmanager"
    37	logger=ngalert.scheduler t=2026-07-13T16:55:08.562253953Z level=info msg="Starting scheduler" tickInterval=10s maxAttempts=3
    38	logger=grafanaStorageLogger t=2026-07-13T16:55:08.56226486Z level=info msg="Storage starting"
    39	logger=ticker t=2026-07-13T16:55:08.56229853Z level=info msg=starting first_tick=2026-07-13T16:55:10Z
    40	logger=http.server t=2026-07-13T16:55:08.564959331Z level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=
    41	logger=provisioning.dashboard t=2026-07-13T16:55:08.577272945Z level=info msg="starting to provision dashboards"
    42	logger=provisioning.dashboard t=2026-07-13T16:55:08.577309368Z level=info msg="finished to provision dashboards"
    43	logger=plugins.update.checker t=2026-07-13T16:55:08.599680589Z level=info msg="Update check succeeded" duration=37.649885ms
    44	logger=grafana.update.checker t=2026-07-13T16:55:08.600171294Z level=info msg="Update check succeeded" duration=38.175187ms
    45	logger=resource-server t=2026-07-13T16:55:08.703895959Z level=warn msg="failed to register storage metrics" error="duplicate metrics collector registration attempted"
    46	logger=resource-server t=2026-07-13T16:55:08.70402377Z level=warn msg="failed to register storage metrics" error="duplicate metrics collector registration attempted"
    47	logger=resource-server t=2026-07-13T16:55:08.70407048Z level=warn msg="failed to register storage metrics" error="duplicate metrics collector registration attempted"
    48	logger=grafana-apiserver t=2026-07-13T16:55:08.707436678Z level=info msg="Adding GroupVersion dashboard.grafana.app v0alpha1 to ResourceManager"
    49	logger=grafana-apiserver t=2026-07-13T16:55:08.708328493Z level=info msg="Adding GroupVersion dashboard.grafana.app v1alpha1 to ResourceManager"
    50	logger=grafana-apiserver t=2026-07-13T16:55:08.709258394Z level=info msg="Adding GroupVersion dashboard.grafana.app v2alpha1 to ResourceManager"
    51	logger=grafana-apiserver t=2026-07-13T16:55:08.709952401Z level=info msg="Adding GroupVersion featuretoggle.grafana.app v0alpha1 to ResourceManager"
    52	logger=grafana-apiserver t=2026-07-13T16:55:08.71144071Z level=info msg="Adding GroupVersion iam.grafana.app v0alpha1 to ResourceManager"
    53	logger=grafana-apiserver t=2026-07-13T16:55:08.712106031Z level=info msg="Adding GroupVersion playlist.grafana.app v0alpha1 to ResourceManager"
    54	logger=app-registry t=2026-07-13T16:55:08.735715828Z level=info msg="app registry initialized"
    55	logger=server t=2026-07-13T16:55:35.973962435Z level=info msg="Shutdown started" reason="System signal: terminated"
    56	logger=tracing t=2026-07-13T16:55:35.974109811Z level=info msg="Closing tracing"
    57	logger=grafana-apiserver t=2026-07-13T16:55:35.97412421Z level=info msg="StorageObjectCountTracker pruner is exiting"
    58	logger=ticker t=2026-07-13T16:55:35.974148984Z level=info msg=stopped last_tick=2026-07-13T16:55:30Z
```

Reading the stream in lifecycle order: the **version banner** (line 2) and **paths/app-mode** (lines 3–10) come from settings load; **SQLite auto-selection** at line 12 (`Connecting to DB dbtype=sqlite3`); the **migrator** (13–16); **plugin loading** (18–22); background services (23–39); and finally **server ready** at line 40 (`HTTP Server Listen address=[::]:3000`).

**The disabled/skipped mechanism is silent in the run loop — proven by two observations.** First, enabling debug logging (`cfg:log.level=debug`) shows **34** background services *started*:

```console
$ /tmp/gf-build/grafana server --homepath=/tmp/gf-home cfg:log.level=debug 2>&1 | grep -c "Starting background service"
34
```

Second, the actual `"disabled"/"skipping"` text comes from individual subsystems, each with its own emitter (grepped to source):

```console
# emitted by the plugin finder, NOT by server.go:150
logger=local.finder level=warn msg="Skipping finding plugins as directory does not exist" path=/tmp/gf-home/plugins-bundled
# emitted by the secrets kvstore plugin gate (debug level)
logger=secrets.kvstore level=debug msg="secrets manager evaluator returned false" \
  reason="remote secret management plugin disabled because the property secrets.use_plugin is not set to true"
```

### `file:line` grounding

- **Entry chain.** `pkg/cmd/grafana/main.go` → `func MainApp()` at **L34** registers `commands.ServerCommand(...)` at **L47**; `pkg/cmd/grafana-server/commands/cli.go` → `func ServerCommand(...)` at **L28**, `Name: "server"` at **L30**, `func RunServer(...)` at **L46**. `RunServer` triggers the Wire assembly (`Initialize`, generated into `pkg/server/wire_gen.go`; hand-written provider set at `pkg/server/wire.go`).
- **Lifecycle.** `pkg/server/server.go` → `New` at **L40** (calls `s.Init()` at **L51**), `Init` at **L113**, `Run` at **L139**. The run loop and the *silent* gate, verbatim:

```go
// pkg/server/server.go  (Run, L139..)
	services := s.backgroundServices

	// Start background services.
	for _, svc := range services {
		if registry.IsDisabled(svc) {   // L150 — SILENT: no log line here
			continue
		}

		service := svc
		serviceName := reflect.TypeOf(service).String()
		s.childRoutines.Go(func() error {
			...
			s.log.Debug("Starting background service", "service", serviceName)  // L162
```

- **The disable mechanism.** `pkg/registry/registry.go` → interface `CanBeDisabled` at **L18** with method `IsDisabled() bool` at **L20**; and the helper consulted by the run loop:

```go
// pkg/registry/registry.go  (L53)
// IsDisabled returns whether a background service is disabled.
func IsDisabled(srv BackgroundService) bool {
	canBeDisabled, ok := srv.(CanBeDisabled)
	return ok && canBeDisabled.IsDisabled()
}
```

- **SQLite default.** `conf/defaults.ini:123` → `type = sqlite3`. **Server ready port.** `conf/defaults.ini:41` → `http_port = 3000`.
- **Emitters of the visible skip lines.** `pkg/plugins/manager/loader/finder/local.go:55` (`"Skipping finding plugins as directory does not exist"`); `pkg/services/secrets/kvstore/plugin.go:22` (`errPluginDisabledByConfig`, surfaced via `kvstore.go:36`). Other services that return `IsDisabled()==true` by default include `searchV2` (`pkg/services/searchV2/service.go:120` → `return !features.IsEnabledGlobally(FlagPanelTitleSearch)`) and `grpcserver` (`pkg/services/grpcserver/service.go:136` → `return !s.enabled`).

### Causal reasoning

`Server.Run` iterates a slice of `BackgroundService` values and, for each, asks `registry.IsDisabled(svc)`. That helper type-asserts the optional `CanBeDisabled` interface; a service that both implements it and returns `true` is *skipped with a bare `continue`* — **no log is written at the gate**. That is why the run loop cannot be the source of "disabled"/"skipped" text. The words the user actually sees are written earlier, by each subsystem while it decides whether it is active (e.g. the plugin finder warns that a bundled-plugins directory is absent; the secrets kvstore debug-logs that the remote plugin is off because `secrets.use_plugin` is unset). Meanwhile the "success" lines (`migrations completed`, `Update check succeeded`, `app registry initialized`, `HTTP Server Listen`) are ordinary info logs from services that *are* enabled. SQLite is chosen with no user input purely because it is the compiled default in `conf/defaults.ini` and nothing overrides it in a clean state.


---

## Area 2 — Persistent State: First-Run vs Subsequent-Run

### Direct answer

The **first** run creates the SQLite database file `data/grafana.db`, applies the full schema by running **626** migrations, and bootstraps the **Main Org.** plus the **admin** user exactly once. Everything is written to `data/grafana.db`. A **subsequent** run pointed at the *same* data directory finds the schema and user already present, so it **skips** all migrations and does **not** recreate the org/admin. This is precisely why behavior differs after the first launch and why the difference survives a stop/restart: the state is on disk in the database, and specific code paths branch on whether that state already exists.

### Observed evidence

**Before run 1** the data directory is empty; **after run 1** the database file exists:

```console
$ ls -la /tmp/gf-home/data          # BEFORE first run
total 8
drwxr-xr-x 2 root root 4096 ...      # (empty)
$ /tmp/gf-build/grafana server --homepath=/tmp/gf-home > /tmp/gf-home/first.log 2>&1 &   # run 1
$ ls -la /tmp/gf-home/data          # AFTER first run
grafana.db   csv/   log/   pdf/   plugins/   png/
```

**First-run log** — the DB file is created, 626 migrations are *performed*, and the org/admin are created (note the ~54 s migration duration):

```console
$ sed -n '2p;13p;14,15p;1268p;1270,1271p;1331p' /tmp/gf-home/first.log
logger=settings  level=info msg="Starting Grafana" version=11.5.0-pre commit=4550cfb5b7 branch=grafana_4550cfb5b728 compiled=2026-07-13T16:36:31Z
logger=sqlstore  level=info msg="Creating SQLite database file" path=/tmp/gf-home/data/grafana.db
logger=migrator  level=info msg="Locking database"
logger=migrator  level=info msg="Starting DB migrations"
logger=migrator  level=info msg="migrations completed" performed=626 skipped=0 duration=54.082011093s
logger=sqlstore  level=info msg="Created default admin" user=admin
logger=sqlstore  level=info msg="Created default organization"
logger=http.server level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=
```

**Database contents after run 1** (queried with Python's `sqlite3`, because the `sqlite3` CLI is not installed in this environment):

```console
$ python3 - <<'PY'
import sqlite3; c=sqlite3.connect('/tmp/gf-home/data/grafana.db'); cur=c.cursor()
print(list(cur.execute("SELECT id,login,email,is_admin FROM user;")))
print(list(cur.execute("SELECT id,name FROM org;")))
print(list(cur.execute("SELECT org_id,user_id,role FROM org_user;")))
print("migration_log:", cur.execute("SELECT COUNT(*) FROM migration_log;").fetchone())
print("data_source:", cur.execute("SELECT COUNT(*) FROM data_source;").fetchone())
print(list(cur.execute("SELECT migration_id FROM migration_log ORDER BY id LIMIT 5;")))
PY
[(1, 'admin', 'admin@localhost', 1)]
[(1, 'Main Org.')]
[(1, 1, 'Admin')]
migration_log: (626,)
data_source: (0,)
[('create migration_log table',), ('create user table',), ('add unique index user.login',), ('add unique index user.email',), ('drop index UQE_user_login - v1',)]
```

**Run 2 against the SAME data directory** — the migrator now reports `performed=0 skipped=626` (in **743 µs**, versus 54 s on run 1), and the `Created default …` lines are **absent**:

```console
$ /tmp/gf-build/grafana server --homepath=/tmp/gf-home > /tmp/gf-home/subsequent.log 2>&1 &   # run 2, same data dir
$ sed -n '15p' /tmp/gf-home/subsequent.log
logger=migrator level=info msg="migrations completed" performed=0 skipped=626 duration=743.836µs
$ grep -c "Created default admin" /tmp/gf-home/subsequent.log
0
$ grep -c "Created default organization" /tmp/gf-home/subsequent.log
0
```

Re-querying the database after run 2 yields **identical** rows (still one admin, one org, 626 migrations, zero data sources) — the state was neither duplicated nor recreated.

### `file:line` grounding

- **Migration gate.** `pkg/services/sqlstore/sqlstore.go` → `func (ss *SQLStore) Migrate(...)` at **L133**; the early-exit gate at **L134**:

```go
// pkg/services/sqlstore/sqlstore.go:133
func (ss *SQLStore) Migrate(isDatabaseLockingEnabled bool) error {
	if ss.dbCfg.SkipMigrations || ss.migrations == nil {
		return nil
	}
```

- **Org/admin bootstrap.** `func (ss *SQLStore) ensureMainOrgAndAdminUser(test bool)` at **L190**. The count-based branch is the crux — verbatim:

```go
// pkg/services/sqlstore/sqlstore.go:190
func (ss *SQLStore) ensureMainOrgAndAdminUser(test bool) error {
	...
		if !test {
			var stats stats.SystemUserCountStats
			rawSQL := `SELECT COUNT(id) AS Count FROM ` + ss.dialect.Quote("user")
			if _, err := sess.SQL(rawSQL).Get(&stats); err != nil {
				return fmt.Errorf("could not determine if admin user exists: %w", err)
			}
			if stats.Count > 0 {          // L204 — SUBSEQUENT-RUN short-circuit
				return nil
			}
		}
		// ensure admin user
		if !ss.cfg.DisableInitAdminCreation {
			...
			if _, err := ss.createUser(ctx, sess, user.CreateUserCommand{
				Login:    ss.cfg.AdminUser,
				Email:    ss.cfg.AdminEmail,
				Password: user.Password(ss.cfg.AdminPassword),
				IsAdmin:  true,
			}); err != nil { ... }
			ss.log.Info("Created default admin", "user", ss.cfg.AdminUser)   // L222 — first run only
		}
		...
		ss.log.Info("Created default organization")   // L230 — first run only
```

- **DB path resolution.** `conf/defaults.ini` → `[paths] data = data` (**L15**) + `[database] name = grafana` (**L125**) + `path = grafana.db` (**L164**) ⇒ `data/grafana.db`.
- **Config precedence (why defaults win).** `pkg/setting/setting.go` → `func (cfg *Cfg) Load(...)` at **L1046**; `customInitPath = "conf/custom.ini"` at **L57** (absent in a clean state). Order is `defaults.ini` → `custom.ini` → env/CLI; the log line `Config loaded from file=/tmp/gf-home/conf/defaults.ini` confirms only defaults were consulted.

### Causal reasoning

The migrator records each applied migration as a row in the `migration_log` table. On the first run that table is empty, so all **626** migrations are *performed* and logged (`performed=626 skipped=0`); the process takes tens of seconds because it is creating the entire schema. On any later run the migrator reads `migration_log`, sees all 626 already recorded, and reports `performed=0 skipped=626` in microseconds. Independently, `ensureMainOrgAndAdminUser` runs `SELECT COUNT(id) FROM "user"`: on run 1 the count is `0`, so it creates the admin (from `cfg.AdminUser`/`cfg.AdminPassword`) and the Main Org., emitting the two `Created default …` info lines; on run 2 the count is `> 0`, so it returns early (`return nil`) and neither line is logged. Because the deciding state lives in `data/grafana.db`, it persists across restarts — which is exactly the run-to-run difference the question is about.


---

## Area 3 — Security Posture of the Default Configuration

### Direct answer

Grafana is **not** running in a permissive or anonymous mode. It **creates a real account** — login `admin`, password `admin` — from `conf/defaults.ini`, and the frontend **forces a password change** the moment you sign in with the password `admin`. Anonymous access is **disabled** (an unauthenticated request to an authenticated endpoint returns **HTTP 401**), and self-service sign-up is **disabled** (`allow_sign_up = false`). Features are governed by feature toggles that split into **56 enabled-by-default** (`Expression: "true"`) and **12 explicit opt-in** (`Expression: "false"`).

### Observed evidence

**Anonymous access is off — unauthenticated calls are rejected with 401:**

```console
$ curl -sS -i http://localhost:3000/api/user
HTTP/1.1 401 Unauthorized
Cache-Control: no-store
Content-Type: application/json; charset=UTF-8
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Mon, 13 Jul 2026 16:54:25 GMT
Content-Length: 102

{"extra":null,"message":"Unauthorized","messageId":"auth.unauthorized","statusCode":401,"traceID":""}
```

`/api/org` returns the identical 401 body. **Logging in with the default credentials succeeds and issues a session cookie:**

```console
$ curl -sS -i -c gf.cookies -H 'Content-Type: application/json' \
    -d '{"user":"admin","password":"admin"}' http://localhost:3000/login
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
Set-Cookie: grafana_session=<REDACTED_SESSION_ID>; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax
Set-Cookie: grafana_session_expiry=<REDACTED_EXPIRY>; Path=/; Max-Age=2592000; SameSite=Lax
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Mon, 13 Jul 2026 16:54:25 GMT
Content-Length: 41

{"message":"Logged in","redirectUrl":"/"}
```

> The `grafana_session` token value and its expiry are shown as `<REDACTED_SESSION_ID>`/`<REDACTED_EXPIRY>`; the raw values were an ephemeral session ID from a throwaway local instance that has since been destroyed, redacted per the secret-sanitization rule. Every security-relevant attribute of the response is preserved verbatim (status `200`, cookie name `grafana_session`, `HttpOnly`, `SameSite=Lax`, `Max-Age`).

**Reusing that cookie returns the admin identity** (`isGrafanaAdmin: true`):

```console
$ curl -sS -i -b gf.cookies http://localhost:3000/api/user
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
...
Content-Length: 371

{"id":1,"uid":"afs04vyjy3lz4b","email":"admin@localhost","name":"","login":"admin","theme":"","orgId":1,"isGrafanaAdmin":true,"isDisabled":false,"isExternal":false,"isExternallySynced":false,"isGrafanaAdminExternallySynced":false,"authLabels":[],"updatedAt":"2026-07-13T16:54:07Z","createdAt":"2026-07-13T16:54:07Z","avatarUrl":"/avatar/46d229b033af06a191ff2267bca9ae56"}
```

**Forced password change — observed in the browser.** Navigating to `http://localhost:3000/` redirects to `/login` (anonymous disabled). After entering `admin`/`admin` and clicking **Log in**, the UI does not proceed to the dashboards; it switches to an **"Update your password"** screen with the banner *"Continuing to use the default password exposes you to security risks."* and **New password / Confirm new password** fields plus **Submit** and **Skip** buttons. Two screenshots were captured as working evidence during the investigation (the login page showing the `Grafana v11.5.0-pre (4550cfb5b7)` footer, and the forced-change screen); per the read-only mandate they were kept *outside* the committed tree (never added to the repository), and their full visual content is transcribed in the prose above.

> **Labeling note (canonical vs interface):** the *backend* `POST /login` itself returns `200` and does **not** force the change server-side; the forced-change prompt is a **frontend gate** (see grounding). This is stated explicitly so the mechanism is not misattributed to the API.

**The default security values loaded from `conf/defaults.ini`** (verified line-by-line; all active because no `custom.ini`/`GF_*` exists):

```console
$ for L in 328 331 337 358 390 483 495 648 650; do printf "L%s: " "$L"; sed -n "${L}p" conf/defaults.ini; done
L328: admin_user = admin
L331: admin_password = admin
L337: secret_key = SW2YcwTIb9zpOOhoPsMm
L358: cookie_secure = false
L390: content_security_policy = false
L483: allow_sign_up = false
L495: auto_assign_org_role = Viewer
L648: [auth.anonymous]
L650: enabled = false
```

**Feature-toggle split** (default-enabled vs opt-in), counted directly in the registry:

```console
$ grep -c 'Expression:[[:space:]]*"true"'  pkg/services/featuremgmt/registry.go
56
$ grep -c 'Expression:[[:space:]]*"false"' pkg/services/featuremgmt/registry.go
12
```

The startup `FeatureToggles` line (Area 1, line 11) is the runtime confirmation: every default-enabled toggle appears with `=true` (e.g. `nestedFolders`, `correlations`, `publicDashboardsScene`, `cloudWatchCrossAccountQuerying`, `accessControlOnCall`, `prometheusMetricEncyclopedia`, `lokiQuerySplitting`, `logsContextDatasourceUi`), while opt-in toggles (e.g. `disableEnvelopeEncryption`, `featureHighlights`, `traceQLStreaming`, `alertingQueryOptimization`, `onPremToCloudMigrations`, `scopeApi`) are absent.

### `file:line` grounding

- **Created account & defaults.** `conf/defaults.ini`: `admin_user = admin` (**L328**), `admin_password = admin` (**L331**), `secret_key = SW2YcwTIb9zpOOhoPsMm` (**L337** — a well-known public default that should be changed in production), `cookie_secure = false` (**L358**), `content_security_policy = false` (**L390**), `[users] allow_sign_up = false` (**L483**), `auto_assign_org_role = Viewer` (**L495**), `[auth.anonymous]` (**L648**) with `enabled = false` (**L650**).
- **Login workflow.** `pkg/api/login.go` → `LoginView` at **L92**, `LoginPost` at **L230** (delegates to the `authn` service with a form client).
- **Forced-password-change is a frontend gate.** `public/app/core/components/Login/LoginCtrl.tsx` (**L116–121**), verbatim:

```tsx
      .post<LoginDTO>('/login', formModel, { showErrorAlert: false })
      .then((result) => {
        this.result = result;
        if (formModel.password !== 'admin' || config.ldapEnabled || config.authProxyEnabled) {
          this.toGrafana();
          return;
        } else {
          this.changeView(formModel.password === 'admin');
        }
```

  When the submitted password equals `admin` (and neither LDAP nor auth-proxy is active), `changeView(true)` flips the view to the change-password screen. There is also a server-side redirect for the well-known change-password URL at `pkg/api/user.go:570` (`c.Redirect("/profile/password", 302)`).
- **Feature-toggle registry.** `pkg/services/featuremgmt/registry.go` → first default-enabled toggle at **L65** (`Expression: "true", // enabled by default`); opt-in toggles carry `Expression: "false"` (first at **L28**).
- **Auth clients & RBAC.** Pluggable authn clients live under `pkg/services/authn/clients/` (`basic.go`, `password.go`, `session.go`, `form.go`, `grafana.go`, `api_key.go`, `passwordless.go`, `ext_jwt.go`); RBAC's HTTP 403 path is `pkg/services/accesscontrol/middleware.go:120`.

### Causal reasoning

The `admin` account exists because `ensureMainOrgAndAdminUser` (Area 2) seeds it from the `[security]` defaults on first run. Unauthenticated requests fail with 401 because the anonymous authn client is not registered — `[auth.anonymous] enabled = false` — so there is no fallback identity, and the `authn` middleware rejects the request. Logging in with `admin`/`admin` is validated by the form/password/session clients, which issue the `grafana_session` cookie seen in the response. The forced password change is deliberately a *frontend* decision: the backend authenticates the credentials normally (HTTP 200), but the React login controller detects the literal password `admin` and routes the user to the "Update your password" view rather than the dashboards.

**Web cross-check (documented vs observed).** Independent sources confirm this posture. Grafana's own anonymous-access documentation states that anonymous access must be *enabled* explicitly via `[auth.anonymous] enabled = true` — i.e. it is off by default — matching the observed 401. Multiple references (AccessChecker; Last9; SigNoz; the IOTstack guide) confirm the default `admin`/`admin` login and that Grafana forces a password change on first login when the password is still `admin`; DevGex confirms the `conf/defaults.ini` `[security] admin_user = admin`/`admin_password = admin` keys. The contributor guide corroborates in-repo: `contribute/developer-guide.md` shows the `| admin | admin |` credential table (L127–129) and states, at L131, *"When you log in for the first time, Grafana asks you to change your password."* All documented claims match the runtime behavior captured above.


---

## Area 4 — Plugin and Data Source Bootstrap

### Direct answer

The plugins that "appear without being installed" are **core plugins**: they are **compiled into the Grafana binary** (backend datasource clients) and **bundled in the source tree** under `public/app/plugins` (frontend). On a clean instance `/api/plugins` returns **50** plugins — **49 with signature `internal`** (core, no signature required) plus **1 `valid`** — with **zero** user action. External plugins would instead load from `data/plugins/`. Crucially, **no data source exists by default**: `/api/datasources` returns an empty `[]`, because a *plugin is not the same as a configured data source instance* and the provisioning samples ship commented out.

### Observed evidence

**`/api/datasources` is empty on the clean instance** (`Content-Length: 2`, body `[]`):

```console
$ curl -sS -i -b gf.cookies http://localhost:3000/api/datasources
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Mon, 13 Jul 2026 16:54:36 GMT
Content-Length: 2

[]
```

**`/api/plugins` is fully populated** — 50 plugins, 49 `internal` + 1 `valid`:

```console
$ curl -sS -b gf.cookies http://localhost:3000/api/plugins > /tmp/gf-home/probe_plugins.json
$ python3 - <<'PY'
import json; from collections import Counter
d=json.load(open('/tmp/gf-home/probe_plugins.json'))
print("total plugins:", len(d))
print("by type:", dict(Counter(p['type'] for p in d)))
print("by signature:", dict(Counter(p.get('signature') for p in d)))
print("datasource ids:", sorted(p['id'] for p in d if p['type']=='datasource'))
print("app:", [(p['id'],p.get('signature'),p.get('signatureType')) for p in d if p['type']=='app'])
PY
total plugins: 50
by type: {'panel': 30, 'datasource': 19, 'app': 1}
by signature: {'internal': 49, 'valid': 1}
datasource ids: ['alertmanager', 'cloudwatch', 'elasticsearch', 'grafana-azure-monitor-datasource', 'grafana-postgresql-datasource', 'grafana-pyroscope-datasource', 'grafana-testdata-datasource', 'graphite', 'influxdb', 'jaeger', 'loki', 'mssql', 'mysql', 'opentsdb', 'parca', 'prometheus', 'stackdriver', 'tempo', 'zipkin']
app: [('grafana-lokiexplore-app', 'valid', 'grafana')]
```

**In-tree bundled front-end plugin directories** — 22 data sources, 32 panels:

```console
$ ls -d public/app/plugins/datasource/*/ | wc -l
22
$ ls -d public/app/plugins/panel/*/ | wc -l
32
```

**Reconciling the API counts against the in-tree directories:**

- *Data sources:* 22 directories = **19** API-listed + **3** built-in utility data sources that are not surfaced as standalone catalog plugins: `dashboard`, `grafana`, `mixed`. (Two directory names also differ from their plugin IDs: `azuremonitor` → `grafana-azure-monitor-datasource`; `cloud-monitoring` → `stackdriver`.) `22 − 3 = 19`.
- *Panels:* 32 directories = **30** API-listed + **2** built-in utility panels not in the API list: `debug`, `live`. `32 − 2 = 30`.
- The single `app` (`grafana-lokiexplore-app`, signature `valid`) is **not** in-tree; it is auto-installed at runtime by the `preinstallAutoUpdate` feature (visible in the first-run log: `Downloaded and extracted grafana-lokiexplore-app v1.0.10 …`), which is why the loader's `count` is 54 (in-tree) then 55 after registration, while the catalog API reports 50 user-visible entries.

**Plugin loader pipeline log lines** (from the first-run stream) show the discovery→load→register progression:

```console
$ grep -nE 'Restored cache|Loading plugins|Skipping finding plugins|Plugins loaded|Plugin registered' /tmp/gf-home/first.log
1274:logger=plugin.angulardetectorsprovider.dynamic level=info msg="Restored cache from database" duration=212.556µs
1275:logger=plugin.store level=info msg="Loading plugins..."
1277:logger=local.finder level=warn msg="Skipping finding plugins as directory does not exist" path=/tmp/gf-home/plugins-bundled
1278:logger=plugin.store level=info msg="Plugins loaded" count=54 duration=28.702466ms
1352:logger=plugins.registration level=info msg="Plugin registered" pluginId=grafana-lokiexplore-app
```

**No data source is provisioned by default** — the samples are commented out:

```console
$ grep -vE '^\s*#|^\s*$' conf/provisioning/datasources/sample.yaml
apiVersion: 1
```

The only active (non-comment) line is `apiVersion: 1`; every `datasources:` entry is commented. The sibling provisioning dirs (`dashboards/`, `alerting/`, `plugins/`) likewise contain only `apiVersion: 1`, and `access-control/sample.yaml` has no active lines at all.

### `file:line` grounding

- **Compiled-in core datasource IDs.** `pkg/plugins/backendplugin/coreplugin/registry.go` — the const block (L40–L60), verbatim:

```go
const (
	CloudWatch      = "cloudwatch"                          // L41
	CloudMonitoring = "stackdriver"                         // L42
	AzureMonitor    = "grafana-azure-monitor-datasource"    // L43
	Elasticsearch   = "elasticsearch"                       // L44
	Graphite        = "graphite"                            // L45
	InfluxDB        = "influxdb"                             // L46
	Loki            = "loki"                                 // L47
	OpenTSDB        = "opentsdb"                             // L48
	Prometheus      = "prometheus"                           // L49
	Tempo           = "tempo"                                // L50
	TestData        = "grafana-testdata-datasource"          // L51
	TestDataAlias   = "testdata"                             // L52
	PostgreSQL      = "grafana-postgresql-datasource"        // L53
	MySQL           = "mysql"                                // L54
	MSSQL           = "mssql"                                // L55
	Grafana         = "grafana"                              // L56
	Pyroscope       = "grafana-pyroscope-datasource"         // L57
	Parca           = "parca"                                // L58
	Zipkin          = "zipkin"                               // L59
)
```

  These backend clients are registered via `p.RegisterClient(bp)` at **L267**.
- **Bundled front-end plugins.** `public/app/plugins/datasource/*` (22 dirs) and `public/app/plugins/panel/*` (32 dirs).
- **Loader pipeline.** `pkg/plugins/manager/loader/loader.go` → `Load` at **L55**, discovery call at **L58** (stages: discovery → bootstrap → validation → initialization → termination). The finder warning is emitted at `pkg/plugins/manager/loader/finder/local.go:55`.
- **Provisioning is opt-in.** `conf/provisioning/datasources/sample.yaml` — only `apiVersion: 1` active; all data source entries commented.

### Causal reasoning

Core plugins are baked into the product: their backend clients are compiled in via the `coreplugin` registry, and their frontend assets ship in `public/app/plugins`. Because they are core, the loader assigns them the `internal` signature status (no signature required) and they show up in `/api/plugins` immediately, without the user installing anything. External plugins are different — they are discovered from the on-disk `data/plugins/` directory, which is absent on a clean instance (hence the `local.finder` "Skipping finding plugins…" warning). The data source **list** is empty for an orthogonal reason: as Grafana's own documentation puts it, "every data source is powered by a plugin — you install a plugin, then configure a data source." A clean instance has all the *plugins* but has *configured* no data source, and the provisioning YAMLs that could auto-create one are shipped commented out. Hence the populated plugin catalog alongside an empty `/api/datasources`.

**Web cross-check (documented vs observed).** Grafana's developer documentation classifies plugins as **Core (`ClassCore`)** — "Built-in plugins shipped with Grafana (e.g., Prometheus, Loki, Time Series panel)", located under `public/app/plugins/` — versus **External (`ClassExternal`)**, and lists the signature status `internal: Core plugin, no signature required`. AWS's Managed Grafana docs add that core plugins are "installed by default and cannot be removed." Grafana's data-source concepts page states core data source plugins "like Prometheus, Loki, and MySQL come bundled" and that "every data source is powered by a plugin." The loader's four-stage pipeline (discovery → bootstrap → validation → initialization) under `pkg/plugins/manager/loader/` is documented verbatim in Grafana's plugin-development overview. All of this matches the observed 49-`internal`/1-`valid` plugin set and the empty data source list.


---

## Area 5 — Build and Compilation Dependency

### Direct answer

The runtime depends on a **generated** file, `pkg/server/wire_gen.go`, which is **git-ignored** (`.gitignore:194`) and produced by `make gen-go`. Until it exists the backend **does not compile** — the build fails with `pkg/server/service.go:31:15: undefined: Initialize`. Running the server directly with `go run ./pkg/cmd/grafana server` is **not** a way around this: it still requires the generated file. A plain `go run` additionally skips the version ldflags, so it prints a **non-canonical `9.2.0`** banner, whereas a properly built binary prints the real `11.5.0-pre`. Finally, the *full UI* depends on the webpack bundles in `public/build/*`, produced by `yarn build`.

### Observed evidence

**Compile WITHOUT the generated Wire file fails.** Using a throwaway copy of the tracked tree (`git archive`, which excludes git-ignored files, so `wire_gen.go` is absent):

```console
$ cd /tmp/gf-copy && rm -f pkg/server/wire_gen.go
$ go build ./pkg/server 2>&1; echo "exit=$?"
# github.com/grafana/grafana/pkg/server
pkg/server/service.go:31:15: undefined: Initialize
exit=1
```

**Generate it, then the same build succeeds:**

```console
$ make gen-go
generate go files
go run  ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server
wire: github.com/grafana/grafana/pkg/server: wrote /tmp/gf-copy/pkg/server/wire_gen.go
$ ls -l pkg/server/wire_gen.go | awk '{print $5" bytes"}'
94781 bytes
$ go build ./pkg/server 2>&1; echo "build-after-gen exit=$?"
build-after-gen exit=0
```

**`wire_gen.go` is git-ignored** (generating it does not dirty the tree):

```console
$ sed -n '194p' .gitignore
**/wire_gen.go
$ git check-ignore pkg/server/wire_gen.go
pkg/server/wire_gen.go
```

**The version-banner difference between `go run` and a built binary** (repeated from the baseline for the Area-5 contrast):

```console
$ go run ./pkg/cmd/grafana server -v          # plain go run — NO ldflags
Version 9.2.0 (commit: NA, branch: main)
$ /tmp/gf-build/grafana server -v             # built binary WITH ldflags
Version 11.5.0-pre (commit: 4550cfb5b7, branch: grafana_4550cfb5b728)
```

**The frontend bundles exist in this environment** (pre-built), which is why the UI rendered in the Area-3 browser check:

```console
$ ls public/build/ | wc -l
658
```

### `file:line` grounding

- **Generated, git-ignored artifact.** `.gitignore:194` = `**/wire_gen.go`. The consumer that fails without it: `pkg/server/service.go:31` calls `Initialize(...)`:

```go
// pkg/server/service.go:30
func (s *coreService) start(_ context.Context) error {
	serv, err := Initialize(s.cfg, s.opts, s.apiOpts)   // L31 — undefined until wire_gen.go is generated
```

  `Initialize` is the Wire-generated assembly function written into `pkg/server/wire_gen.go` (from the hand-written provider set `pkg/server/wire.go`, which carries the `//go:build wireinject` tag so it is excluded from normal builds).
- **The generator.** `Makefile` `gen-go` target (**L167**), body at **L169**:

```make
gen-go:
	@echo "generate go files"
	$(GO) run $(GO_RACE_FLAG) ./pkg/build/wire/cmd/wire/main.go gen -tags $(WIRE_TAGS) ./pkg/server
```

  `WIRE_TAGS` resolves to `oss` (observed in the command echo). `build-go` explicitly depends on `gen-go` — `Makefile:187` = `build-go: gen-go update-workspace` — which proves generation precedes any canonical build.
- **Dev-flag disclosure (non-canonical run path).** `Makefile` `run-go` target (**L236**), body at **L237–238**:

```make
run-go: ## Build and run web server immediately.
	$(GO) run -race $(if $(GO_BUILD_TAGS),-build-tags=$(GO_BUILD_TAGS)) \
		./pkg/cmd/grafana -- server -profile -profile-addr=127.0.0.1 -profile-port=6000 -packaging=dev cfg:app_mode=development
```

  These flags (`-packaging=dev`, `cfg:app_mode=development`) switch the app mode to **development** and are therefore **non-canonical** — unlike the plain `./pkg/cmd/grafana server` used throughout this document, which logs `App mode production`. (`make run` at `Makefile:232` is the filesystem-watch variant that wraps this.)
- **ldflags version stamping.** `pkg/build/cmd.go` assembles `-X main.version` (**L247**), `-X main.commit` (**L248**), `-X main.buildstamp` (**L252**), `-X main.buildBranch` (**L253**). With no ldflags, the compile-time fallbacks in `pkg/cmd/grafana/main.go` show through (`version = "9.2.0"` L17; `commit = DefaultCommitValue = "NA"`; `buildBranch = "main"` L20).
- **Toolchain.** `go.mod:3` (`go 1.23.1`); `.nvmrc` (`v22.11.0`) and `package.json:451` engines `">= 22"`; `package.json:453` (`yarn@4.5.3`); `package.json:6` (`11.5.0-pre`); GCC for the CGO SQLite driver.

### Causal reasoning

Grafana wires its dependency graph with **Google Wire**. The hand-authored `pkg/server/wire.go` only declares provider sets and is excluded from normal compilation by its `wireinject` build tag; the concrete constructor `Initialize` is *code-generated* into `pkg/server/wire_gen.go`. Because that generated file is deliberately git-ignored, a fresh checkout contains a *reference* to `Initialize` (at `service.go:31`) but not its *definition* — so the compiler reports `undefined: Initialize` and the build (or `go run`) fails until `make gen-go` regenerates it. "Running directly" and "building first" are therefore equivalent on this point: both compile the `pkg/server` package and both need `wire_gen.go`. The separate `9.2.0`-vs-`11.5.0-pre` discrepancy is unrelated to Wire; it is purely a link-time matter — `go run` applies no `-X main.*` ldflags, so the version/commit/branch fall back to the hardcoded placeholders. And whether the browser shows a full UI depends on `public/build/*`: those webpack bundles are generated by `yarn build`; here they were pre-built (658 files), so the login and password-change screens rendered. *(Inferred, not exercised: were `public/build` absent, the backend would still start and serve the API, but the browser would receive missing/404 frontend assets — grounded in the fact that the UI is served entirely from `public/build`.)*

**Web cross-check.** The contributor guide `contribute/developer-guide.md` documents the canonical developer workflow: build & run the backend with `make run` (L119) and reach it at `http://localhost:3000/` (L123) — consistent with the `make`-based Wire-then-build sequence exercised here.


---

## Coverage Pass — Every Named Item, Answered

The table below enumerates every mechanism, function, condition, file, flag, and "e.g./such as/including" example implied by the five questions, with a pointer to where it is answered above.

| Named item | Where answered / value |
|------------|------------------------|
| `pkg/cmd/grafana/main.go` `MainApp()` (L34) | Area 1 grounding — entry chain |
| `server` subcommand — `ServerCommand`/`RunServer` (`cli.go` L28/L30/L46) | Area 1 grounding |
| Google Wire assembly — `Initialize` / `wire.go` / `wire_gen.go` | Area 1 + Area 5 |
| `Server.New` (server.go **L40**), `Server.Init` (**L113**), `Server.Run` (**L139**) | Area 1 grounding |
| `registry.IsDisabled` (**L53**), `CanBeDisabled` iface (**L18**), `IsDisabled() bool` (**L20**) | Area 1 grounding |
| `server.go:150` silent `continue` gate (no log) | Area 1 evidence + grounding |
| `"Starting background service"` Debug (server.go **L162**); 34 services started | Area 1 evidence |
| Emitters of "disabled"/"skipped" (`local.finder` local.go:55; `secrets.kvstore` plugin.go:22; `searchV2` service.go:120; `grpcserver` service.go:136) | Area 1 evidence + grounding |
| SQLite auto-selection (`conf/defaults.ini:123` `type = sqlite3`); `Connecting to DB dbtype=sqlite3` | Area 1 (line 12) |
| Server ready `HTTP Server Listen [::]:3000` (`conf/defaults.ini:41`) | Area 1 (line 40) |
| `data/grafana.db` path (`defaults.ini` L15 + L125 + L164) | Area 2 grounding |
| First-run migrations `performed=626 skipped=0` (~54 s) | Area 2 evidence |
| Subsequent-run migrations `performed=0 skipped=626` (743 µs) | Area 1 (line 15) + Area 2 evidence |
| `ensureMainOrgAndAdminUser` (sqlstore.go **L190**); `SELECT COUNT(id) FROM user`; `if stats.Count > 0 { return nil }` (**L204**) | Area 2 grounding |
| `"Created default admin"` (**L222**) present run 1 / absent run 2 | Area 2 evidence |
| `"Created default organization"` (**L230**) present run 1 / absent run 2 | Area 2 evidence |
| Migration gate `SkipMigrations \|\| migrations == nil` (`Migrate` L133/L134) | Area 2 grounding |
| `migration_log` = 626 rows; `data_source` = 0; sample migration_ids | Area 2 evidence |
| `Cfg.Load` (setting.go **L1046**); `customInitPath = "conf/custom.ini"` (**L57**) | Area 2 grounding |
| Config precedence defaults→custom→env/CLI; `Config loaded from … defaults.ini` | Area 2 evidence + reasoning |
| admin/admin created (`defaults.ini` L328/L331); identity `isGrafanaAdmin:true` | Area 3 evidence + grounding |
| Forced password change (frontend gate `LoginCtrl.tsx` L116–121; `user.go:570` redirect) | Area 3 evidence + grounding |
| Anonymous disabled → HTTP 401 (`[auth.anonymous] enabled=false` L648/L650) | Area 3 evidence |
| `allow_sign_up = false` (**L483**) | Area 3 grounding |
| `auto_assign_org_role = Viewer` (**L495**) | Area 3 grounding |
| `secret_key = SW2YcwTIb9zpOOhoPsMm` (**L337**, public default) | Area 3 grounding |
| `cookie_secure = false` (**L358**) | Area 3 grounding |
| `content_security_policy = false` (**L390**) | Area 3 grounding |
| Feature toggles: **56** enabled (`Expression:"true"`, first L65) vs **12** opt-in (`"false"`) + examples | Area 3 evidence + grounding |
| `LoginView` (login.go L92), `LoginPost` (L230); authn clients; accesscontrol 403 (middleware.go:120) | Area 3 grounding |
| `/api/plugins` populated (50: 30 panel + 19 datasource + 1 app; 49 internal + 1 valid) | Area 4 evidence |
| `/api/datasources` empty `[]` | Area 4 evidence |
| Core datasource IDs — CloudWatch/CloudMonitoring(stackdriver)/AzureMonitor/Elasticsearch/Graphite/InfluxDB/Loki/OpenTSDB/Prometheus/Tempo/TestData/TestDataAlias/PostgreSQL/MySQL/MSSQL/Grafana/Pyroscope/Parca/Zipkin (registry.go L41–L59); `RegisterClient` L267 | Area 4 grounding |
| 22 bundled datasource dirs + 32 panel dirs (`public/app/plugins/*`) | Area 4 evidence |
| Reconciliation: 3 built-in datasources (`dashboard`,`grafana`,`mixed`); 2 built-in panels (`debug`,`live`) | Area 4 evidence |
| Loader pipeline discovery→bootstrap→validation→initialization (loader.go L55/L58) + log lines | Area 4 evidence + grounding |
| Provisioning samples commented (`conf/provisioning/**`, only `apiVersion: 1`) | Area 4 evidence |
| `grafana-lokiexplore-app` preinstalled via `preinstallAutoUpdate` (runtime download v1.0.10) | Area 4 evidence |
| `pkg/server/wire_gen.go` git-ignored (`.gitignore:194`) | Area 5 evidence + grounding |
| Compile failure without it: `service.go:31:15: undefined: Initialize` | Area 5 evidence |
| `make gen-go` (Makefile L167/L169) via `pkg/build/wire/cmd/wire/main.go` | Area 5 grounding |
| `build-go: gen-go` (Makefile L187) — generation precedes build | Area 5 grounding |
| `run-go` dev flags `-packaging=dev cfg:app_mode=development` (Makefile L236/L237-238) | Area 5 grounding |
| ldflags version stamping (`pkg/build/cmd.go` L247-253); plain `go run` → 9.2.0/NA/main | Baseline + Area 5 |
| `public/build/*` from `yarn build` (658 files) → full UI | Area 5 evidence |
| Toolchain: Go 1.23.1, Node v22.23.1 (.nvmrc v22.11.0), Yarn 4.5.3, product 11.5.0-pre, GCC 15.2.0 | Baseline + Area 5 |
| Web cross-check (admin/admin + forced change; anonymous off; core vs external + internal signature; loader pipeline) | Area 3 & Area 4 cross-check subsections |

---

## Appendix — Environment, Cleanup, and Read-Only Verification

### Methodology notes & caveats

- **Canonical entry point.** All runtime values come from the real `server` subcommand of a properly built binary (`/tmp/gf-build/grafana server`), invoked as a normal user would. The `9.2.0` banner from a plain `go run` and the `run-go` dev flags are labeled **non-canonical** wherever they appear.
- **Two-run stability.** Each observation was produced at least twice. Area 3/Area 4 HTTP results were identical across the partial-isolation run pair *and* the fully-isolated `/tmp/gf-home` run pair; the first-run vs subsequent-run distinction was produced against the **same** `/tmp/gf-home/data` directory (not two unrelated invocations).
- **`sqlite3` CLI absent.** Database inspection used Python's `sqlite3` module (`python3 -c "import sqlite3…"`); this queries the same on-disk `data/grafana.db` file the server writes.
- **Inferred content.** Exactly one statement is labeled inferred: the behavior of the UI if `public/build` were absent (Area 5) — grounded in the fact that the frontend is served entirely from `public/build`. Everything else is observed.

### Final read-only verification

The only repository change is this document. Verified at authoring time:

```console
$ git rev-parse --abbrev-ref HEAD
blitzy-d319eda3-6a4f-4f3c-a8c4-70f4da2bbc81
$ git check-ignore pkg/server/wire_gen.go   # generated file stays ignored
pkg/server/wire_gen.go
$ git status --porcelain
?? blitzy/
```

`?? blitzy/` is the only entry — the new `blitzy/documentation/grafana_4550cfb5b728.md`, and nothing else. **No tracked source file was modified, renamed, or deleted.** All runtime state and scratch artifacts (`/tmp/gf-home`, `/tmp/gf-build`, `/tmp/gf-clean`, `/tmp/gf-copy`, cookie files, screenshot captures) live outside the repository tree and are removed on completion.

### Web references consulted (documented-posture cross-check)

- Grafana documentation — *Configure anonymous access* (anonymous access is enabled only by explicitly setting `[auth.anonymous] enabled = true`; off by default).
- Grafana documentation — *Data sources, plugins, and integrations* ("every data source is powered by a plugin"; core data sources such as Prometheus, Loki, MySQL come bundled).
- Grafana developer documentation / *Plugin Development Overview* (core `ClassCore` vs external `ClassExternal`; core under `public/app/plugins/`; signature status `internal`; loader pipeline discovery→bootstrap→validation→initialization).
- Grafana *Plugin lifecycle* docs (phases run on every server start; discovery scans the filesystem for `plugin.json`).
- AWS Managed Grafana docs (core plugins installed by default and cannot be removed).
- AccessChecker, Last9, SigNoz, IOTstack guides, DevGex analysis (default `admin`/`admin` login and forced password change on first login; `conf/defaults.ini` `[security]` keys).
- In-repo: `contribute/developer-guide.md` (L119 `make run`, L123 `localhost:3000`, L127–129 admin/admin table, L131 forced password change on first login).

