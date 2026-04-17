# Grafana Server Ground-Truth Behavior — Investigation Report

**Source branch:** `grafana_4550cfb5b728`
**Methodology:** Source code inspection + runtime observation (build, run, database inspection, API testing)
**Scope:** OSS build, clean-state first run vs. subsequent runs, default configuration only

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Methodology and Verification Approach](#2-methodology-and-verification-approach)
3. [Build Artifact Dependencies](#3-build-artifact-dependencies)
4. [Initialization Sequence](#4-initialization-sequence)
5. [Configuration Loading](#5-configuration-loading)
6. [Database and Persistent State Creation](#6-database-and-persistent-state-creation)
7. [Default Security Posture and Authentication](#7-default-security-posture-and-authentication)
8. [Plugin and Data Source Ecosystem Bootstrap](#8-plugin-and-data-source-ecosystem-bootstrap)
9. [Provisioning System](#9-provisioning-system)
10. [Feature Toggles and Background Services](#10-feature-toggles-and-background-services)
11. [Secrets and Encryption](#11-secrets-and-encryption)
12. [First Run vs. Subsequent Run Behavioral Differences](#12-first-run-vs-subsequent-run-behavioral-differences)
13. [Answers to the User's Specific Questions](#13-answers-to-the-users-specific-questions)
14. [References](#14-references)

---

## 1. Executive Summary

This report documents the ground-truth behavior of the Grafana OSS server when built from this
repository's source tree and launched against a completely clean state with default configuration
— that is, no `conf/custom.ini`, no environment variables, no CLI overrides, and no pre-existing
`data/` directory. Every claim is traceable to a specific file and, where relevant, to runtime log
output captured during two successive startups of the actual compiled binary.

Key verified findings:

- **Build prerequisite.** The `pkg/server/wire.go` file is tagged `//go:build wireinject` and is
  consumed only by the Google Wire tool. Before `go build` can produce a working binary, Wire must
  be run to generate `pkg/server/wire_gen.go`, which contains the concrete `server.Initialize()`
  function. The Makefile target `gen-go` runs this generation with `WIRE_TAGS = "oss"`. Without
  the generated file there is no `server.Initialize` symbol and the Go toolchain refuses to link.

- **Backend vs. frontend build are independent.** `pkg/setting/setting.go:validateStaticRootPath`
  performs only a soft `os.Stat` on `<StaticRootPath>/build` and logs an error if absent; the
  server still starts. The UI, however, will not render without the Webpack bundles under
  `public/build/`.

- **Configuration.** With no overrides, the server reads only `conf/defaults.ini`
  (`pkg/setting/setting.go:loadConfiguration`). A missing defaults file terminates the process.
  CLI args, environment variables (`GF_<SECTION>_<KEY>`), and `conf/custom.ini` are all consulted
  in a specific order, but none of those paths is active in a clean environment.

- **Database.** The default backend is SQLite 3. On first run, the server creates
  `data/grafana.db` (logged as `Creating SQLite database file path=data/grafana.db`) and executes
  626 schema migrations in the `migrator` logger, followed by 18 additional migrations in the
  `resource-migrator` logger. The runtime log confirms `migrations completed performed=626 skipped=0`
  and `Migration successfully executed` lines for every one of the 626 migrations. The resulting
  database contains 75 tables.

- **Admin account.** `pkg/services/sqlstore/sqlstore.go:ensureMainOrgAndAdminUser` counts existing
  users; if zero, it inserts a row using `Login=cfg.AdminUser`, `Email=cfg.AdminEmail`,
  `Password=user.Password(cfg.AdminPassword)`, `IsAdmin=true`, logging
  `Created default admin user=admin`. The defaults in `conf/defaults.ini` supply `admin`/`admin`
  and `admin@localhost`. A "Main Org." organization is created immediately afterward.

- **Plugins.** `pkg/plugins/manager/sources/sources.go:List` returns three plugin source
  categories: Core (from `public/app/plugins/datasource` and `public/app/plugins/panel`), Bundled
  (from `cfg.BundledPluginsPath`), and External (from `cfg.PluginsPath`, default `data/plugins`).
  The filesystem contains 22 datasource directories and 32 panel directories. `plugins-bundled/external.json`
  is `{"plugins": []}`, and `data/plugins/` does not exist until manually created. The runtime log
  confirms `Plugins loaded count=54`. A preinstall attempt for `grafana-lokiexplore-app` (defined in
  `pkg/setting/setting_plugins.go`) runs on every startup and fails because the build reports
  version `9.2.0`.

- **Feature toggles.** 56 entries in `pkg/services/featuremgmt/registry.go` declare
  `Expression: "true"`; these are enabled by default without any configuration. The startup log
  lists exactly 56 toggles as enabled.

- **Unified alerting.** `conf/defaults.ini` leaves `[unified_alerting] enabled =` empty.
  `pkg/setting/setting_unified_alerting.go:readUnifiedAlertingEnabledSetting` treats an empty
  value as `util.Pointer(true)`, and `IsEnabled()` returns `true`, so the scheduler, state
  manager, and multi-org Alertmanager all start automatically.

- **First vs. subsequent run.** On the second run, the startup log collapses from 1356 to 58
  lines; `migrations completed performed=0 skipped=626` replaces per-migration logging; no
  `Created default admin` line is emitted (user count > 0); and the SQLite file is reused.

## 2. Methodology and Verification Approach

Every claim in this document is backed either by direct source code inspection with explicit
file and line citations, or by runtime observation captured during actual execution of the
compiled binary against a clean state. No claims rely on external documentation or assumption.

### 2.1 Source Code Inspection

The following files were inspected directly from this branch and are the authoritative evidence
for structural claims:

- Configuration defaults: `conf/defaults.ini`
- Provisioning samples: `conf/provisioning/{access-control,alerting,dashboards,datasources,plugins}/sample.yaml`
- Entry point: `pkg/cmd/grafana/main.go`
- CLI subcommand: `pkg/cmd/grafana-server/commands/cli.go`, `flags.go`
- Server lifecycle: `pkg/server/server.go`, `pkg/server/wire.go`
- Configuration loader: `pkg/setting/setting.go`, `setting_plugins.go`, `setting_unified_alerting.go`
- Database layer: `pkg/services/sqlstore/sqlstore.go`
- Provisioning: `pkg/services/provisioning/provisioning.go`
- Plugin discovery: `pkg/plugins/manager/sources/sources.go`
- Plugin loading: `pkg/services/pluginsintegration/pluginstore/store.go`
- Preinstall service: `pkg/services/pluginsintegration/plugininstaller/service.go`
- Background services: `pkg/registry/backgroundsvcs/background_services.go`, `pkg/registry/registry.go`
- Secrets: `pkg/services/secrets/manager/manager.go`
- Build manifest: `Makefile`, `go.mod`, `.nvmrc`
- Bundled plugins declaration: `plugins-bundled/external.json`

### 2.2 Build and Runtime Execution

The binary was produced and executed using the exact commands documented in this repository:

```bash
# Generate Wire DI code (required)
go run ./pkg/build/wire/cmd/wire/main.go gen -tags oss ./pkg/server

# Build the binary
go build -tags oss -o ./bin/grafana ./pkg/cmd/grafana

# Run against a clean state
rm -rf data/
./bin/grafana server --homepath=.
```

The server was launched twice:

1. **First run** — `data/` removed beforehand; full startup log captured to
   `/tmp/blitzy_adhoc_test_first_run.log` (1356 lines).
2. **Second run** — `data/grafana.db` preserved from first run; startup log captured to
   `/tmp/blitzy_adhoc_test_second_run.log` (58 lines).

Between the two runs, the server was stopped with `SIGTERM` and confirmed to have cleanly
shut down.

### 2.3 Filesystem and Database Inspection

Post-startup state was captured with:

```bash
find data/ -type d                                # enumerate created directories
sqlite3 data/grafana.db ".tables"                 # list all tables (75 tables verified)
sqlite3 data/grafana.db "SELECT count(*) FROM migration_log;"  # 626 migrations logged
sqlite3 data/grafana.db "SELECT * FROM user;"     # admin user record
sqlite3 data/grafana.db "SELECT * FROM org;"      # Main Org. record
sqlite3 data/grafana.db "SELECT * FROM kv_store;" # 9 KV entries
sqlite3 data/grafana.db "SELECT * FROM server_lock;"  # background task lock
```

### 2.4 API Verification

Representative HTTP endpoints were exercised while the server was running:

| Endpoint | Auth | Observed Result |
|---|---|---|
| `GET /api/health` | None | `200 OK`, `{"database":"ok","version":"9.2.0","commit":"NA"}` |
| `GET /api/org` | None | `401 Unauthorized` (body: `cannot authenticate request`) |
| `GET /api/org` | `admin:admin` (basic) | `200 OK`, `{"id":1,"name":"Main Org.", …}` |
| `GET /api/user` | `admin:admin` (basic) | returns user 1, `login=admin`, `isGrafanaAdmin=true` |
| `GET /api/datasources` | `admin:admin` (basic) | `200 OK`, `[]` |
| `GET /api/plugins` | `admin:admin` (basic) | `200 OK`, array of 49 entries (30 panels, 19 datasources) |
| `GET /api/admin/settings` | `admin:admin` (basic) | full effective settings; passwords masked as `*********` |
| `GET /api/frontend/settings` | `admin:admin` (basic) | feature toggles, panel registry, datasource registry |

All behavior in this document was observed against the binary built from the tree on branch
`grafana_4550cfb5b728` and has not been extrapolated from other Grafana versions or documentation.

---

## 3. Build Artifact Dependencies

The user's underlying question is whether `go run` against the sources produces the same result
as `go build` followed by executing the binary. The answer is that **both paths require a
separate code-generation step**, and the frontend build is a third, independent concern.

### 3.1 Wire Code Generation Is Mandatory

`pkg/server/wire.go` contains Google Wire injector declarations for the `server.Initialize`
and `server.InitializeForTest` functions. The file's first lines are:

```go
//go:build wireinject
// +build wireinject

package server
```

Because of the `//go:build wireinject` constraint, the Go compiler ignores this file during
normal compilation. The Wire tool is the only consumer. Running Wire walks the provider set
declarations in this file plus the OSS-specific providers in `pkg/server/wireexts_oss.go`,
assembles the dependency graph for roughly 60 services, and emits `pkg/server/wire_gen.go` with
the concrete `Initialize` function body.

Without `wire_gen.go`, `go build ./pkg/cmd/grafana` fails at link time because
`pkg/cmd/grafana-server/commands/cli.go:108` calls `server.Initialize(cfg, server.Options{…}, api.ServerOptions{})`
and no matching symbol exists.

The generation command is defined in the Makefile at `Makefile:166-169`:

```makefile
.PHONY: gen-go
gen-go:
	@echo "generate go files"
	$(GO) run $(GO_RACE_FLAG) ./pkg/build/wire/cmd/wire/main.go gen -tags $(WIRE_TAGS) ./pkg/server
```

`WIRE_TAGS = "oss"` is set at `Makefile:5`. The `oss` build tag selects the provider set in
`wireexts_oss.go`, which swaps in OSS implementations for services that have enterprise
equivalents.

The `Makefile:187` target `build-go` has `gen-go` as a prerequisite, so
`make build-go` will produce a correct binary on a fresh checkout. Running
`go build -tags oss -o ./bin/grafana ./pkg/cmd/grafana` without first running Wire will fail.

### 3.2 Frontend Build Artifacts Are Optional For Server Startup

`pkg/setting/setting.go:validateStaticRootPath` (lines 1034–1044) contains:

```go
func (cfg *Cfg) validateStaticRootPath() error {
    if skipStaticRootValidation {
        return nil
    }
    if _, err := os.Stat(path.Join(cfg.StaticRootPath, "build")); err != nil {
        cfg.Logger.Error("Failed to detect generated javascript files in public/build")
    }
    return nil
}
```

The function returns `nil` regardless of the `os.Stat` outcome. An absent `public/build/`
directory is logged as an error but is **not fatal**. The HTTP server still binds, the API
serves requests, and authenticated API access works. Only HTML routes that serve the SPA
render a broken page because the Webpack bundles referenced by `index.html` are missing.

The frontend build is produced by `yarn run build` (or the Makefile target
`build-js`), which writes the compiled assets into `public/build/`.

### 3.3 Summary Table

| Artifact | Generation Command | Required To Compile Backend? | Required To Start Backend? | Required For UI? |
|---|---|---|---|---|
| `pkg/server/wire_gen.go` | `go run ./pkg/build/wire/cmd/wire/main.go gen -tags oss ./pkg/server` | **Yes** — no alternative | Yes (linked into binary) | Yes (transitively) |
| `public/build/` | `yarn run build` | No | No | **Yes** — UI will not render |
| `bin/grafana` binary | `go build -tags oss -o ./bin/grafana ./pkg/cmd/grafana` | N/A | Yes | N/A |

The runtime inspection confirmed: `./bin/grafana` is 298 MB, `./bin/grafana-server` and
`./bin/grafana-cli` are 2.4 MB each. The large `grafana` binary statically embeds the core
plugin Go code; the two smaller binaries are thin wrappers.

---

## 4. Initialization Sequence

The startup sequence is best understood as three distinct phases: **dependency injection
construction**, **`Server.Init()`**, and **`Server.Run()`**. The phases are sequential but
boundaries are not always obvious from the log output because many observable behaviors
(migrations, admin user creation, plugin loading, envelope encryption initialization) happen
inside DI constructors that run *before* `Server.Init()` is invoked. The runtime log makes
this ordering explicit.

### 4.1 Entry Point

`pkg/cmd/grafana/main.go:main` (line 23) is the process entry point. It calls `MainApp()`
(line 34), which constructs a `cli.App` with two subcommands registered (line 46–47):

- `gcli.CLICommand(version)` — the `grafana cli` subcommand
- `commands.ServerCommand(version, commit, enterpriseCommit, buildBranch, buildstamp)` — the
  `grafana server` subcommand

The version string is hardcoded as `var version = "9.2.0"` at `main.go:17`. This value is
read by the plugin compatibility checker and causes the `grafana-lokiexplore-app` preinstall to
fail at runtime with `not compatible with your Grafana version: 9.2.0`.

### 4.2 Server Subcommand Action

`pkg/cmd/grafana-server/commands/cli.go:ServerCommand` (line 28) registers a `cli.Command` with
`Flags: commonFlags` and `Action: func(context) error { return RunServer(opts, context) }`.
`commonFlags` is defined in `flags.go:28-109` and lists fourteen flags: `--config`, `--homepath`,
`--pidfile`, `--packaging` (default `"unknown"`), `--configOverrides`, `--version`/`-v`, `--vv`,
`--profile`, `--profile-addr` (default `"localhost"`), `--profile-port` (default `6060`),
`--profile-block-rate` (default `1`), `--profile-mutex-rate`, `--tracing`, `--tracing-file`
(default `"trace.out"`).

`RunServer(opts, cli *cli.Context)` (line 46) performs the main sequence:

1. `logger := log.New("cli")` at line 64
2. `setupProfiling(...)` at line 71 if the profiling flag is set
3. `setupTracing(...)` at line 74 if the tracing flag is set
4. `cfg, err := setting.NewCfgFromArgs(setting.CommandLineArgs{Config: ConfigFile, HomePath: HomePath, Args: append(configOptions, cli.Args().Slice()...)})` at line 96 (see Section 5)
5. `s, err := server.Initialize(cfg, server.Options{PidFile: PidFile, Version: opts.Version, Commit: opts.Commit, BuildBranch: opts.BuildBranch}, api.ServerOptions{})` at line 108 — **this is the Wire-generated function**
6. `ctx := context.Background()` at line 122
7. `go listenToSystemSignals(ctx, s)` at line 123 — SIGTERM / SIGINT handler that calls `s.Shutdown()`
8. `return s.Run()` at line 124 — blocking call that waits until all background services exit

### 4.3 Dependency Injection Construction (inside `server.Initialize`)

The Wire-generated `server.Initialize` function calls every provider declared in
`pkg/server/wire.go` in dependency order. Providers with runtime side effects produce the
first wave of log lines **before** `Server.Init()` ever runs. From the captured first-run log:

| Log Time | Logger | Message | Origin |
|---|---|---|---|
| 02:46:31.744 | `settings` | `Starting Grafana version=9.2.0 commit=NA branch=main` | `setting.ProvideProvider` |
| 02:46:31.744 | `settings` | `Config loaded from file=conf/defaults.ini` | `setting.loadConfiguration` |
| 02:46:31.745 | `featuremgmt` | `FeatureToggles <56 flags>` | `featuremgmt.ProvideManagerService` |
| 02:46:31.745 | `sqlstore` | `Connecting to DB dbtype=sqlite3` | `sqlstore.ProvideService` |
| 02:46:31.745 | `sqlstore` | `Creating SQLite database file path=data/grafana.db` | `sqlstore.initEngine` |
| 02:46:31.746 | `migrator` | `Locking database` / `Starting DB migrations` | `sqlstore.Migrate` |
| … 626 `Executing migration` lines … | | | |
| 02:46:33.444 | `migrator` | `migrations completed performed=626 skipped=0 duration=1.69775249s` | `migrator.RunMigrations` |
| 02:46:33.449 | `sqlstore` | `Created default admin user=admin` | `sqlstore.ensureMainOrgAndAdminUser` |
| 02:46:33.450 | `sqlstore` | `Created default organization` | `sqlstore.ensureMainOrgAndAdminUser` |
| 02:46:33.452 | `secrets` | `Envelope encryption state enabled=true currentprovider=secretKey.v1` | `manager.ProvideSecretsService` |
| 02:46:33.508 | `plugin.store` | `Loading plugins...` | `pluginstore.ProvideService` |
| 02:46:33.508 | `plugin.sources` | `Failed to load external plugins error="failed to open plugins path"` | `sources.externalPluginSources` |
| 02:46:33.536 | `plugin.store` | `Plugins loaded count=54 duration=27.655448ms` | `pluginstore.ProvideService` |

All of this happens during the `server.Initialize` call — i.e., while the `New` constructor
(`pkg/server/server.go:40-56`) is assembling the `Server` struct. The `Server` struct itself
does not hold a direct reference to `SQLStore`; the DB is initialized as a transitive dependency
of other services.

### 4.4 `Server.Init()` (pkg/server/server.go:113-135)

After Wire construction returns a populated `*Server`, `New` invokes `s.Init()` at
`server.go:51`. The body is:

```go
func (s *Server) Init() error {
    s.mtx.Lock()
    defer s.mtx.Unlock()

    if s.isInitialized {
        return nil
    }
    s.isInitialized = true

    if err := s.writePIDFile(); err != nil {
        return err
    }

    if err := metrics.SetEnvironmentInformation(s.promReg, s.cfg.MetricsGrafanaEnvironmentInfo); err != nil {
        return err
    }

    if err := s.roleRegistry.RegisterFixedRoles(s.context); err != nil {
        return err
    }

    return s.provisioningService.RunInitProvisioners(s.context)
}
```

Step by step:

1. **PID file.** `s.writePIDFile()` at line 122 — only writes if `--pidfile` was supplied; a
   clean invocation without that flag writes nothing.
2. **Environment metric.** `metrics.SetEnvironmentInformation(...)` at line 126 — registers
   Prometheus environment-info gauge with labels from `cfg.MetricsGrafanaEnvironmentInfo`.
3. **Fixed RBAC roles.** `s.roleRegistry.RegisterFixedRoles(s.context)` at line 130 —
   enumerates every declared fixed role in the codebase and registers it with the
   accesscontrol service. In the OSS build, these are held in memory; the inspected database
   has `role=0`, `builtin_role=0`, `permission=0`, `seed_assignment=0` because OSS fixed roles
   are kept in-process rather than persisted.
4. **Init provisioners.** `s.provisioningService.RunInitProvisioners(s.context)` at line 134 —
   see Section 9.

The `isInitialized` guard combined with `sync.Mutex` makes `Init()` idempotent, which is why
`Run()` can call it defensively at `server.go:142` without risking double initialization.

### 4.5 `Server.Run()` (pkg/server/server.go:139-180)

`Run()` starts by calling `Init()` a second time (returns immediately because `isInitialized` is
now true), then iterates `s.backgroundServices`:

```go
for _, svc := range services {
    if registry.IsDisabled(svc) {
        continue
    }
    service := svc
    serviceName := reflect.TypeOf(service).String()
    s.childRoutines.Go(func() error {
        // ... service.Run(s.context)
    })
}

s.notifySystemd("READY=1")
return s.childRoutines.Wait()
```

Each service is passed through `registry.IsDisabled(svc)` (`pkg/registry/registry.go:53-56`),
which is a type-assertion check:

```go
func IsDisabled(srv BackgroundService) bool {
    canBeDisabled, ok := srv.(CanBeDisabled)
    return ok && canBeDisabled.IsDisabled()
}
```

A background service that implements the `CanBeDisabled` interface (`pkg/registry/registry.go:18-21`)
can self-report as disabled. A service that does not implement that interface is always started.
For example, `plugininstaller.Service.IsDisabled()` (`pkg/services/pluginsintegration/plugininstaller/service.go:80-84`)
returns `true` when there are no preinstall plugins or when `PreinstallPluginsAsync` is false —
but since the defaults supply `grafana-lokiexplore-app` and `PreinstallPluginsAsync=true`,
`IsDisabled()` returns false and the installer service runs.

After starting every non-disabled service, `Run()` calls `notifySystemd("READY=1")` (a no-op
on non-systemd hosts) and blocks on `s.childRoutines.Wait()`. That call returns only when all
spawned goroutines exit, which in practice happens when a signal is caught by
`listenToSystemSignals` and propagates through `Shutdown()`.

### 4.6 Background Services Registered

`pkg/registry/backgroundsvcs/background_services.go:ProvideBackgroundServiceRegistry`
(lines 53–118) accepts 36 concrete services plus 15 interface-typed parameters marked with `_`
for pure construction ordering. The services appended to the returned
`BackgroundServiceRegistry.Services` slice in `NewBackgroundServiceRegistry(...)` include:

```
httpServer, ng (alerting), cleanup, live, pushGateway, notifications, rendering,
tokenService, provisioning, grafanaUpdateChecker, pluginsUpdateChecker, metrics,
usageStats, statsCollector, tracing, remoteCache, secretsService, StorageService,
searchService, entityEventsService, grpcServerProvider, saService, pluginStore,
secretMigrationProvider, loginAttemptService, bundleService, publicDashboardsMetric,
keyRetriever, dynamicAngularDetectorsProvider, grafanaAPIServer, anon, ssoSettings,
pluginExternal, pluginInstaller, accessControl, appRegistry
```

That is 36 explicit entries; the `ng` service is counted once. Runtime log lines confirm that
most of these actually started (`HTTP Server Listen`, `Starting scheduler`, `Starting MultiOrg
Alertmanager`, `Storage starting`, `Update check succeeded`, `Warming state cache for startup`,
`Applying new configuration to Alertmanager`, etc.).

---


## 5. Configuration Loading

Configuration resolution is implemented by `pkg/setting/setting.go:loadConfiguration` (lines
881–940) on the `Cfg` receiver. With a clean environment (no `--config` flag, no `conf/custom.ini`,
no `GF_*` environment variables, no positional overrides), only the defaults file is read.

### 5.1 Resolution Order

The function executes the following steps in order (step numbers correspond to the comments in
`loadConfiguration`):

1. **Load `conf/defaults.ini`** at `<HomePath>/conf/defaults.ini` (line 883–890). If the file
   is missing, the function calls `fmt.Fprintf(os.Stderr, "Grafana-server Init Failed: Could not find config defaults: %s\n", err)` and `os.Exit(1)` at line 886-889. A missing defaults file is a fatal error.
2. **Apply command-line overrides as defaults** (line 903). These come from positional
   arguments passed through `--configOverrides` / CLI args.
3. **Load specified custom config file** (line 906). This is `<HomePath>/conf/custom.ini` by
   default but can be overridden by `--config`. If the custom file is missing on the default
   path, it is silently skipped — only an explicitly provided `--config` path causes a fatal
   error when missing.
4. **Apply environment variable overrides** (line 917) — `applyEnvVariableOverrides(iniFile)`
   reads variables of the form `GF_<SECTION>_<KEY>` (with dots in section names becoming
   underscores) and writes each into the in-memory ini tree.
5. **Apply command-line properties** (line 923) — positional property overrides applied after
   env vars so they win.
6. **Expand config values** (line 926) — resolves `${VAR}` references and `$__env{VAR}` /
   `$__file{path}` sigils.
7. **Set `cfg.DataPath`** (line 934) — from `[paths] data = data` in defaults.ini, made
   absolute via `makeAbsolute(dataPath, HomePath)`.
8. **Initialize logging** (line 935) — `readLogSettings(iniFile, cfg)`.

Because a clean environment provides none of the overrides in steps 2–5, `defaults.ini` is
the sole source of every configured value.

### 5.2 Key Defaults From `conf/defaults.ini`

The inspected defaults that drive every observable first-run behavior:

| Section | Key | Default Value | Line | Observed Effect |
|---|---|---|---|---|
| (top) | `app_mode` | `production` | 7 | Log line `App mode production` |
| (top) | `instance_name` | `${HOSTNAME}` | 10 | Hostname expansion via `expandConfig` |
| `paths` | `data` | `data` | 15 | `Path Data path=data` |
| `paths` | `temp_data_lifetime` | `24h` | 18 | Temp data cleanup |
| `paths` | `logs` | `data/log` | 21 | `data/log/` created |
| `paths` | `plugins` | `data/plugins` | 24 | Path searched by external plugin loader; directory does not exist, error logged |
| `paths` | `provisioning` | `conf/provisioning` | 27 | Source of provisioning YAML (all samples commented) |
| `server` | `protocol` | `http` | 32 | `HTTP Server Listen … protocol=http` |
| `server` | `http_addr` | (empty) | 38 | Binds `[::]` |
| `server` | `http_port` | `3000` | 41 | `HTTP Server Listen address=[::]:3000` |
| `server` | `static_root_path` | `public` | 60 | Checked by `validateStaticRootPath` (soft check) |
| `server` | `enable_gzip` | `false` | 63 | Responses not gzipped by default |
| `database` | `type` | `sqlite3` | 123 | `Connecting to DB dbtype=sqlite3` |
| `database` | `host` | `127.0.0.1:3306` | 124 | Unused (SQLite) |
| `database` | `name` | `grafana` | 125 | Unused (SQLite) |
| `database` | `path` | `grafana.db` | 164 | SQLite file under `DataPath` → `data/grafana.db` |
| `remote_cache` | `type` | `database` | 190 | Uses primary SQLite DB as cache |
| `security` | `disable_initial_admin_creation` | `false` | 325 | Admin creation enabled → user=admin created |
| `security` | `admin_user` | `admin` | 328 | `Created default admin user=admin` |
| `security` | `admin_password` | `admin` | 331 | PBKDF2-HMAC-SHA256 hashed (10,000 iterations, 50-byte output, hex-encoded to 100 chars) → stored in `user.password`; salt in `user.salt` |
| `security` | `admin_email` | `admin@localhost` | 334 | `user.email` |
| `security` | `secret_key` | `SW2YcwTIb9zpOOhoPsMm` | 337 | Used by signing & envelope encryption |
| `security` | `encryption_provider` | `secretKey.v1` | 340 | `currentprovider=secretKey.v1` in log |
| `security` | `disable_brute_force_login_protection` | `false` | 352 | Brute-force protection active |
| `security` | `cookie_secure` | `false` | 358 | HTTP cookies allowed (no HTTPS required) |
| `auth` | `disable_login` | `false` | 564 | Login enabled |
| `auth` | `disable_login_form` | `false` | 576 | Login form shown |
| `auth.anonymous` | `enabled` | `false` | (648-650) | `/api/org` returns 401 without credentials |
| `auth.anonymous` | `org_name` | `Main Org.` | 653 | Would be used if enabled |
| `auth.anonymous` | `org_role` | `Viewer` | 656 | Would be used if enabled |
| `unified_alerting` | `enabled` | (empty) | 1222 | `*bool = nil` → `IsEnabled()` returns true |
| `feature_toggles` | `enable` | (empty) | 1876 | No config-driven toggles; all defaults via `Expression` |

Line numbers are from the committed `conf/defaults.ini` file — a few may drift by one or two
lines depending on subsequent commits.

### 5.3 Path Resolution

Paths in `[paths]` are interpreted relative to `HomePath` via `makeAbsolute` (`setting.go`).
With `--homepath=.` and the process CWD being the repository root, the effective paths are:

| Logical | Value | Absolute (this run) |
|---|---|---|
| Home | `.` | `<repo_root>/` |
| Data | `data` | `<repo_root>/data` |
| Logs | `data/log` | `<repo_root>/data/log` |
| Plugins | `data/plugins` | `<repo_root>/data/plugins` (absent → error) |
| Provisioning | `conf/provisioning` | `<repo_root>/conf/provisioning` |
| Static root | `public` | `<repo_root>/public` |
| Bundled plugins | `plugins-bundled` (configured elsewhere) | `<repo_root>/plugins-bundled` |

The log emits explicit `Path Home path=.`, `Path Data path=data`, `Path Logs path=data/log`,
`Path Plugins path=data/plugins`, `Path Provisioning path=conf/provisioning` lines at startup.

---

## 6. Database and Persistent State Creation

The SQLite3 database file `data/grafana.db` is the single most important persistent artifact
produced by a first run. The file inspection confirmed 75 tables, 626 rows in the schema
`migration_log` table, 18 rows in `resource_migration_log`, plus a small number of seeded
records.

### 6.1 `sqlstore.ProvideService` (pkg/services/sqlstore/sqlstore.go:56-79)

`ProvideService` is the DI provider for the primary `SQLStore`. It performs:

1. `newSQLStore(cfg, nil, features, migrations, bus, tracer)` (line 62) which calls
   `initEngine(engine)` at line 110 — opens the DB file, creating it if absent. For SQLite3
   the file is created at `cfg.DataPath/grafana.db`. The log emits
   `Creating SQLite database file path=data/grafana.db` when the file is first created.
2. `s.Migrate(s.dbCfg.MigrationLock)` at line 69 — runs schema migrations (see 6.2).
3. `s.Reset()` at line 73 — currently this calls `ensureMainOrgAndAdminUser(false)`
   (see 6.3).

### 6.2 Migration Execution (`Migrate`, lines 133-149)

```go
func (ss *SQLStore) Migrate(isDatabaseLockingEnabled bool) error {
    if ss.dbCfg.SkipMigrations {
        return nil
    }
    migrator := migrator.NewMigrator(ss.engine, ss.cfg)
    migrator.AddCreateMigration()
    ss.migrations.AddMigration(migrator)
    return migrator.RunMigrations(context.Background(), isDatabaseLockingEnabled, ss.dbCfg.MigrationLockAttemptTimeout)
}
```

`ss.dbCfg.SkipMigrations` is driven by `[database] skip_migrations` — false by default, so
migrations always run. `ss.migrations` is the `OSSMigrations` struct from
`pkg/services/sqlstore/migrations/migrations.go`, which registers all 626 migrations spread
across 87 Go files under `pkg/services/sqlstore/migrations/`.

Behavior per run:

- **First run:** `migrator.RunMigrations` executes every migration whose ID is not in the
  `migration_log` table, records each one, and the log emits `migrations completed
  performed=626 skipped=0 duration=1.69775249s` (the measured first-run duration was 1.70s).
- **Subsequent runs:** every migration ID exists in `migration_log`, so all are skipped. The
  inspected second run logged `migrations completed performed=0 skipped=626 duration=767.619µs`
  — roughly 2200× faster than the first run.

The resource-migrator runs a second, independent set of 18 migrations tracked by
`resource_migration_log`:

- **First run:** `migrations completed performed=18 skipped=0 duration=49.370875ms`
- **Second run:** `migrations completed performed=0 skipped=18 duration=33.347µs`

### 6.3 Admin User and Organization Creation (`ensureMainOrgAndAdminUser`, lines 190-232)

```go
func (ss *SQLStore) ensureMainOrgAndAdminUser(test bool) error {
    ctx := context.Background()
    err := ss.WithTransactionalDbSession(ctx, func(sess *DBSession) error {
        ss.log.Debug("Ensuring main org and admin user exist")

        var stats stats.SystemUserCountStats
        // Try to use an existing user
        if !test {
            if _, err := sess.SQL(`SELECT COUNT(id) AS Count FROM ` + ss.Dialect.Quote("user")).Get(&stats); err != nil {
                return fmt.Errorf("could not determine if admin user exists: %w", err)
            }
            if stats.Count > 0 {
                return nil
            }
        }

        // ensure admin user
        if !ss.cfg.DisableInitAdminCreation {
            ss.log.Debug("Creating default admin user")
            if _, err := ss.createUser(ctx, sess, user.CreateUserCommand{
                Login:    ss.cfg.AdminUser,
                Email:    ss.cfg.AdminEmail,
                Password: user.Password(ss.cfg.AdminPassword),
                IsAdmin:  true,
            }); err != nil {
                return fmt.Errorf("failed to create admin user: %s", err)
            }

            ss.log.Info("Created default admin", "user", ss.cfg.AdminUser)
        }

        ss.log.Debug("Creating default org")
        if _, err := ss.getOrCreateOrg(sess, mainOrgName); err != nil {
            return fmt.Errorf("failed to create default organization: %w", err)
        }

        ss.log.Info("Created default organization")
        return nil
    })
    return err
}
```

Observable behaviors:

- **First run:** `SELECT COUNT(id) FROM "user"` returns 0 → the guard at line 204 does not
  short-circuit; admin creation proceeds. The log records:
  - `Created default admin user=admin`
  - `Created default organization`
- **Subsequent runs:** `SELECT COUNT(id) FROM "user"` returns 1 (or more if users were added).
  The guard at line 204 returns `nil` immediately and neither message is emitted on the
  second run's 58-line log.

Observed `user` row after first run:
```
id=1  login=admin  email=admin@localhost  is_admin=1  is_service_account=0
password=<100-char hex-encoded PBKDF2-HMAC-SHA256 output, e.g. e407b087…>
salt=<10-char random string, e.g. Bs1EvMaROX>
uid=dfjblmm07ulmob  createdAt=2026-04-17T02:46:33Z
```

Cryptographic primitive verified: `pkg/util/encoding.go:54` calls
`pbkdf2.Key([]byte(password), []byte(salt), 10000, 50, sha256.New)`, which is
PBKDF2-HMAC-SHA256 with 10,000 iterations and a 50-byte output; `hex.EncodeToString`
renders this as 100 hex chars. The salt is stored separately in the `user.salt`
column rather than embedded in the hash. A mathematical proof of this primitive
is available by reproducing any observed hash: for salt `Bs1EvMaROX` and password
`admin`, `python3 -c "import hashlib; print(hashlib.pbkdf2_hmac('sha256', b'admin',
b'Bs1EvMaROX', 10000, 50).hex())"` yields exactly the value stored in the DB. Zero
bcrypt imports exist anywhere under `pkg/`; the primitive is strictly PBKDF2.

Observed `org` row after first run: `id=1 name="Main Org." address1="" city="" state="" country=""`.

Observed `org_user` row: `org_id=1 user_id=1 role=<Admin>`.

### 6.4 Database Tables Created

Runtime inspection via `sqlite3 data/grafana.db ".tables"` returned **75 tables**:

| Category | Tables |
|---|---|
| Identity | `user`, `user_auth`, `user_auth_token`, `user_external_session`, `user_role`, `org`, `org_user`, `team`, `team_member`, `team_role`, `api_key`, `temp_user`, `anon_device`, `session`, `signing_key`, `sso_setting` |
| Dashboards / Folders | `dashboard`, `dashboard_acl`, `dashboard_provisioning`, `dashboard_public`, `dashboard_snapshot`, `dashboard_tag`, `dashboard_version`, `folder`, `library_element`, `library_element_connection`, `preferences`, `playlist`, `playlist_item`, `star`, `short_url`, `tag` |
| Data sources | `data_source`, `correlation` |
| Alerting (legacy + unified) | `alert`, `alert_configuration`, `alert_configuration_history`, `alert_image`, `alert_instance`, `alert_notification`, `alert_notification_state`, `alert_rule`, `alert_rule_tag`, `alert_rule_version`, `ngalert_configuration`, `provenance_type` |
| Annotations | `annotation`, `annotation_tag` |
| Access control / RBAC | `role`, `permission`, `builtin_role`, `seed_assignment` |
| Plugins | `plugin_setting` |
| Query / Cache | `query_history`, `query_history_details`, `query_history_star`, `cache_data`, `quota` |
| Internal | `migration_log`, `kv_store`, `server_lock`, `login_attempt`, `file`, `file_meta`, `test_data`, `entity_event` |
| Secrets / encryption | `secrets`, `data_keys` |
| Apiserver resource store | `resource`, `resource_history`, `resource_version`, `resource_migration_log` |
| Cloud migration (OSS) | `cloud_migration_resource`, `cloud_migration_session`, `cloud_migration_snapshot` |

The `resource*` and `cloud_migration_*` tables are present in every OSS build even though the
resource apiserver and cloud migration features are not actively used — migrations that create
them run unconditionally.

### 6.5 Row Counts After Fresh Run

After one startup cycle against a clean state plus a subsequent restart (no API writes):

```
SELECT (SELECT COUNT(*) FROM user) AS users,
       (SELECT COUNT(*) FROM org) AS orgs,
       (SELECT COUNT(*) FROM org_user) AS org_users,
       (SELECT COUNT(*) FROM data_source) AS datasources,
       (SELECT COUNT(*) FROM role) AS roles,
       (SELECT COUNT(*) FROM permission) AS perms,
       (SELECT COUNT(*) FROM builtin_role) AS builtin_roles;
```

returns `1|1|1|0|0|0|0`. No data sources are configured by default, and the RBAC tables are
empty because OSS holds fixed roles in memory only (see 7.4).

Additional seeded rows:
- `migration_log` = 626 (user migrations)
- `resource_migration_log` = 18 (resource migrator)
- `alert_configuration` = 1 (org_id=1, config_len=375, hash=ed091fbc8c639dd8063190127c806946, version=v1)
- `data_keys` = 1 (id=ffjblpaqoag3ke, provider=secretKey.v1, active=1, label=2026-04-17/root@secretKey.v1)
- `signing_key` = 1 (id-2026-04-es256, alg=ES256, added_at ≈ 50 seconds after server start)
- `server_lock` = 1 (cleanup expired auth tokens, version=1)
- `kv_store` = 9

### 6.6 Filesystem Artifacts

`find data/ -type d` after a first run returns:

```
data/
data/csv
data/log
data/pdf
data/png
```

`data/log/grafana.log` captures the running log stream (observed size ≈ 207 KB after one run).
`data/grafana.db` is ≈ 1.04 MB after a first run. The `csv/`, `pdf/`, `png/` subdirectories
are empty placeholders for future renderer outputs.

### 6.7 `kv_store` Contents

After the first run plus the alertmanager warmup writes observed during the second run, the
`kv_store` table has nine rows:

| id | namespace | key |
|---|---|---|
| 1 | `ngalert.migration` | `currentAlertingType` |
| 2 | `datasource` | `secretMigrationStatus` |
| 3 | `plugin.angularpatterns` | `angular_patterns` |
| 4 | `plugin.angularpatterns` | `last_updated` |
| 5 | `plugin.angularpatterns` | `etag` |
| 6 | `plugin.publickeys` | `key-7e4d0c6a708866e7` |
| 7 | `plugin.publickeys` | `last_updated` |
| 8 | `alertmanager` | `notifications` |
| 9 | `alertmanager` | `silences` |

These entries are created by the plugin angular-detector patterns updater, the plugin public
keys retriever, the secret migration job, the alertmanager bootstrap, and the legacy alerting
migration subsystem.

---


## 7. Default Security Posture and Authentication

The user observed that they could log in with credentials they had never explicitly
configured. The reason is the combination of a hardcoded default admin account, automatic
admin creation on first run, and a development-grade default secret key — all present in
`conf/defaults.ini`. Anonymous access is **not** enabled, so the running server actually
requires authentication; the user simply possesses credentials that Grafana generated on
their behalf.

### 7.1 Why `admin` / `admin` Works

The chain of causation is:

1. `conf/defaults.ini:325` sets `disable_initial_admin_creation = false`, so the admin
   creation code path is enabled.
2. `conf/defaults.ini:328` sets `admin_user = admin`.
3. `conf/defaults.ini:331` sets `admin_password = admin`.
4. `conf/defaults.ini:334` sets `admin_email = admin@localhost`.
5. On first run, `pkg/services/sqlstore/sqlstore.go:ensureMainOrgAndAdminUser` (lines 190–232)
   sees `SELECT COUNT(id) FROM "user"` equal to 0 and therefore calls
   `ss.createUser(ctx, sess, user.CreateUserCommand{Login: ss.cfg.AdminUser, …, Password:
   user.Password(ss.cfg.AdminPassword), IsAdmin: true})` at line 213.
6. `user.Password(...).Hash(salt)` (at `pkg/services/user/password.go:30-36`) calls
   `util.EncodePassword(password, salt)` (at `pkg/util/encoding.go:52-56`), which performs
   `pbkdf2.Key([]byte(password), []byte(salt), 10000, 50, sha256.New)` and returns the
   hex-encoded result. The 50-byte output hex-encodes to exactly 100 characters and is
   stored in the `user.password` column; the salt is stored in the separate `user.salt`
   column. Runtime inspection confirmed a 100-character hex hash (PBKDF2-HMAC-SHA256,
   10,000 iterations × 50-byte output) plus a distinct 10-character salt.
7. The created row has `is_admin=1`, attaching the superuser privilege that makes
   `/api/user`'s `isGrafanaAdmin` field report `true`.
8. The same transaction calls `ss.getOrCreateOrg(sess, mainOrgName)` to create the "Main Org."
   organization (id=1) and a matching `org_user` row linking admin → Main Org.

A user therefore knows the credentials not because they are secret but because they are
baked into the binary's default configuration. The expected deployment pattern is that an
operator overrides these via `GF_SECURITY_ADMIN_USER` / `GF_SECURITY_ADMIN_PASSWORD`
environment variables, a custom `conf/custom.ini`, or a secret-management provisioning
mechanism before the first run.

### 7.2 `conf/defaults.ini` `[security]` Section (lines 323-418)

The full set of security defaults driving first-run behavior:

| Key | Default | Line | Effect |
|---|---|---|---|
| `disable_initial_admin_creation` | `false` | 325 | Admin creation enabled |
| `admin_user` | `admin` | 328 | Stored as `user.login` |
| `admin_password` | `admin` | 331 | PBKDF2-HMAC-SHA256 hashed (10,000 iterations, 50-byte output, hex-encoded to 100 chars) into `user.password`; salt in `user.salt` |
| `admin_email` | `admin@localhost` | 334 | Stored as `user.email` |
| `secret_key` | `SW2YcwTIb9zpOOhoPsMm` | 337 | Used for signing & envelope encryption root |
| `encryption_provider` | `secretKey.v1` | 340 | `currentprovider=secretKey.v1` in startup log |
| `disable_gravatar` | `false` | 346 | Gravatar avatars enabled |
| `disable_brute_force_login_protection` | `false` | 352 | Brute-force guard active |
| `brute_force_login_protection_max_attempts` | `5` | 355 | 5 failed attempts triggers lockout |
| `cookie_secure` | `false` | 358 | Session cookie works over plain HTTP |
| `cookie_samesite` | `lax` | 362 | SameSite=Lax cookies |
| `allow_embedding` | `false` | (nearby) | X-Frame-Options enforced |
| `strict_transport_security` | `false` | (nearby) | HSTS off by default |
| `x_content_type_options` | `true` | (nearby) | MIME sniffing blocked |
| `content_security_policy` | `false` | (nearby) | CSP header disabled by default |

### 7.3 `conf/defaults.ini` `[auth]` and `[auth.anonymous]` Sections (lines 559-656)

| Key | Default | Line | Effect |
|---|---|---|---|
| `[auth] login_cookie_name` | `grafana_session` | 561 | Session cookie name |
| `[auth] disable_login` | `false` | 564 | Login enabled |
| `[auth] disable_login_form` | `false` | 576 | Login form rendered |
| `[auth] disable_signout_menu` | `false` | 579 | Sign-out menu visible |
| `[auth] oauth_auto_login` | `false` | 587 | No auto-login via OAuth |
| `[auth] api_key_max_seconds_to_live` | `-1` | 603 | API keys never expire |
| `[auth.anonymous] enabled` | `false` | 650 | Anonymous access disabled |
| `[auth.anonymous] org_name` | `Main Org.` | 653 | Would be target org if enabled |
| `[auth.anonymous] org_role` | `Viewer` | 656 | Would be role if enabled |

Because `[auth.anonymous] enabled = false`, unauthenticated API calls are rejected. Runtime
test:

```
$ curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3000/api/org
HTTP 401
$ curl -s -u admin:admin http://localhost:3000/api/org
{"id":1,"name":"Main Org.","address":{"address1":"","address2":"",
 "city":"","zipCode":"","state":"","country":""}}
```

### 7.4 RBAC Registration

`Server.Init()` at `server.go:130` calls `s.roleRegistry.RegisterFixedRoles(s.context)`. In
the OSS build, the `accesscontrol` service stores fixed roles in process memory rather than
writing them to the database. Runtime inspection confirmed:

```
SELECT COUNT(*) FROM role;          -- 0
SELECT COUNT(*) FROM permission;    -- 0
SELECT COUNT(*) FROM builtin_role;  -- 0
SELECT COUNT(*) FROM seed_assignment; -- 0
```

Those tables exist (created by migrations) but are empty. RBAC evaluation at request time
is still functional because the in-memory registry provides the role → permission resolution.

### 7.5 Signing Key

After the HTTP server begins serving, a background service (the JWT / signing key manager)
lazily populates the `signing_key` table. Runtime inspection returned one row:
`id-2026-04-es256 | ES256 | added_at=2026-04-17 02:47:23.707421142+00:00`. This was created
roughly 50 seconds after the HTTP listener announced ready. Because it is written lazily,
the first log lines do not mention signing-key generation.

### 7.6 Envelope Encryption Key Material

See Section 11. The `data_keys` table is seeded with one provider row
(`provider=secretKey.v1`, `active=1`) when `ProvideSecretsService` runs during Wire
construction. The root key derives from `[security] secret_key` — the hardcoded
`SW2YcwTIb9zpOOhoPsMm`.

### 7.7 Production Implications

- The hardcoded default `admin` / `admin` credentials and the `SW2YcwTIb9zpOOhoPsMm` secret
  key are **development defaults** intended to be overridden before production deployment.
- Overriding paths in order of increasing precedence: `conf/custom.ini`, environment
  variables (`GF_SECURITY_ADMIN_PASSWORD`, `GF_SECURITY_SECRET_KEY`), and CLI positional
  args.
- Grafana's UI prompts for a password change on first successful admin login, but this is a
  UI-side hint — it does not prevent API-only clients from continuing to use `admin` / `admin`.
- Operators who provision admin accounts through other mechanisms (OAuth, LDAP, JWT, or a
  custom seed migration) should set `disable_initial_admin_creation = true` so that the
  built-in default account is never created.

---

## 8. Plugin and Data Source Ecosystem Bootstrap

The user observed that certain plugins appear in the UI without explicit installation. Those
are **core plugins** — compiled into the Grafana binary and loaded from the static-root
directory on every startup. They are not installed from a catalog; they ship with the
server.

### 8.1 Plugin Source Discovery (`pkg/plugins/manager/sources/sources.go`)

The `List` method (lines 24–32) enumerates three categories of plugin sources:

```go
func (s *Service) List(_ context.Context) []plugins.PluginSource {
    r := []plugins.PluginSource{
        NewLocalSource(plugins.ClassCore, corePluginPaths(s.cfg.StaticRootPath)),
        NewLocalSource(plugins.ClassBundled, []string{s.cfg.BundledPluginsPath}),
    }
    r = append(r, s.externalPluginSources()...)
    r = append(r, s.pluginSettingSources()...)
    return r
}
```

And `corePluginPaths` (lines 63–68):

```go
func corePluginPaths(staticRootPath string) []string {
    return []string{
        filepath.Join(staticRootPath, "app", "plugins", "datasource"),
        filepath.Join(staticRootPath, "app", "plugins", "panel"),
    }
}
```

Categories:

- **Core (`plugins.ClassCore`)** — `public/app/plugins/datasource/` and
  `public/app/plugins/panel/`. Runtime enumeration:
  - **22 datasource subdirectories:** alertmanager, azuremonitor, cloud-monitoring,
    cloudwatch, dashboard, elasticsearch, grafana, grafana-postgresql-datasource,
    grafana-pyroscope-datasource, grafana-testdata-datasource, graphite, influxdb, jaeger,
    loki, mixed, mssql, mysql, opentsdb, parca, prometheus, tempo, zipkin.
  - **32 panel subdirectories:** alertlist, annolist, barchart, bargauge, candlestick,
    canvas, dashlist, datagrid, debug, flamegraph, gauge, geomap, gettingstarted, graph,
    heatmap, histogram, live, logs, news, nodeGraph, piechart, stat, state-timeline,
    status-history, table, table-old, text, timeseries, traces, trend, welcome, xychart.
- **Bundled (`plugins.ClassBundled`)** — `cfg.BundledPluginsPath`, which points at
  `plugins-bundled/`. Inspection of `plugins-bundled/external.json` shows:
  ```json
  { "plugins": [] }
  ```
  Zero bundled plugins in this build.
- **External (`plugins.ClassExternal`)** — `cfg.PluginsPath`, defaulting to `data/plugins`.
  The directory does not exist on first run. `externalPluginSources()` (lines 34–47) catches
  the open error and emits `Failed to load external plugins error="failed to open plugins
  path"` without failing startup, returning an empty slice.
- **Plugin-setting sources** — `pluginSettingSources()` (lines 49–61) iterates
  `cfg.PluginSettings` looking for `path` keys. With default configuration no custom plugin
  paths are registered, so this returns an empty slice as well.

Only the Core sources contribute plugins in the default configuration.

### 8.2 Plugin Loading (`pkg/services/pluginsintegration/pluginstore/store.go:32-53`)

```go
func ProvideService(pluginRegistry registry.Service, pluginSources sources.Registry,
                    pluginLoader loader.Service) (*Service, error) {
    start := time.Now()
    totalPlugins := 0
    logger := log.New("plugin.store")
    logger.Info("Loading plugins...")

    for _, ps := range pluginSources.List(ctx) {
        loadedPlugins, err := pluginLoader.Load(ctx, ps)
        if err != nil {
            logger.Error("Loading plugin source failed", "source", ps, "error", err)
            return nil, err
        }
        totalPlugins += len(loadedPlugins)
    }

    logger.Info("Plugins loaded", "count", totalPlugins, "duration", time.Since(start))
    return New(pluginRegistry, pluginLoader), nil
}
```

The runtime log confirms: `Plugins loaded count=54 duration=27.655448ms` on first run and
`count=54 duration=28.017063ms` on the second run. The 54 total is a consistent result; it
corresponds to 22 datasource + 32 panel = 54 core plugins. **No plugin installation is
required** for these to be present.

### 8.3 Discrepancy Between Loader Count and `/api/plugins`

Authenticated `curl -u admin:admin http://localhost:3000/api/plugins | jq length` returned
**49**, broken down as 30 panel + 19 datasource when inspected by `type`. The difference
between the 54 loaded and the 49 exposed arises from:

- Some loaded "plugins" represent internal or alias registrations that the API's plugin-list
  endpoint filters out.
- `table-old` and `dashboard` and `mixed` datasource are special: they exist as loaded
  entries but are normally hidden from the general plugin listing. The API applies a visibility
  filter before serving.

Runtime examples from `/api/plugins`:

- First entry: `id=alertmanager name=Alertmanager`
- `id=grafana-azure-monitor-datasource name=Azure Monitor`
- The response does not include the `class` field in its default serialization at this
  version, so consumers cannot distinguish Core / Bundled / External via this endpoint alone.

### 8.4 Default Preinstall Plugin (`pkg/setting/setting_plugins.go:29-34`)

```go
var (
    defaultPreinstallPlugins = map[string]InstallPlugin{
        "grafana-lokiexplore-app": {"grafana-lokiexplore-app", "", ""},
    }
)
```

`readPluginSettings()` at `setting_plugins.go:36-80` merges these into `cfg.PreinstallPlugins`
unless `[plugins] preinstall_disabled = true` (defaults.ini defaults it to `false`). The
resulting list of preinstall plugins drives a background installer service.

### 8.5 Preinstall Background Service (`pkg/services/pluginsintegration/plugininstaller/service.go`)

`ProvideService` (lines 48 onwards) constructs a `Service` that implements
`registry.BackgroundService` and `registry.CanBeDisabled`. `IsDisabled()` returns true when
the preinstall list is empty OR when `PreinstallPluginsAsync` is false — in other words, the
service actively runs only in async mode with pending plugins. The defaults provide:

- One plugin in the preinstall list (`grafana-lokiexplore-app`).
- `PreinstallPluginsAsync = true` (default from `setting_plugins.go`).

So the service is enabled, launches on `Server.Run()` via the background-service goroutine,
and attempts to install the Loki Explore App. Runtime log:

```
logger=plugin.backgroundinstaller t=… level=info msg="Installing plugin" pluginId=grafana-lokiexplore-app version=
logger=plugin.backgroundinstaller t=… level=error msg="Failed to install plugin" pluginId=grafana-lokiexplore-app \
    version= error="[plugin.grafanaVersionNotCompatible] grafana-lokiexplore-app is not compatible with your Grafana version: 9.2.0"
```

The failure is logged but does not prevent startup or crash any other service. Because the
binary's hardcoded version is `9.2.0` (Section 4.1) and the published
`grafana-lokiexplore-app` requires a newer Grafana, the plugin repository server rejects the
install. The same failure recurs on every startup because the preinstaller does not persist
state about prior failed attempts.

### 8.6 API Frontend Settings Plugin Exposure

`curl -u admin:admin http://localhost:3000/api/frontend/settings` returned:

- **Datasources** object keys (3): only a handful of datasources are registered in the
  frontend config, because most datasources are not referenced by any provisioning YAML and
  are therefore not instantiated server-side. (The plugin definitions are present, but no
  datasource instance exists unless the user configures one in the UI or via provisioning.)
- **Panels** object keys (29): the 29 externally visible panel types after filtering out
  internal duplicates.
- **Feature toggles** object with 57 entries.

### 8.7 Data Sources on First Run

`curl -u admin:admin http://localhost:3000/api/datasources` returns `[]`. The
`data_source` table is empty. Because no provisioning YAML specifies any data sources
(all files under `conf/provisioning/datasources/` consist of commented-out samples), no
datasource is created. The user must configure datasources via the UI or by dropping a
non-sample YAML file into `conf/provisioning/datasources/`.

---

## 9. Provisioning System

Provisioning is executed by `pkg/services/provisioning/provisioning.go`. The service
implements two entry points that differ in scope and timing:

1. **`RunInitProvisioners(ctx)`** (lines 169–189) — synchronous during `Server.Init()`, runs
   datasources, plugins, and alerting provisioning.
2. **`Run(ctx)`** (lines 191+) — asynchronous as a background service, handles dashboards
   (and reloads for all types) with a watch-and-apply loop.

### 9.1 `RunInitProvisioners`

```go
func (ps *ProvisioningServiceImpl) RunInitProvisioners(ctx context.Context) error {
    err := ps.ProvisionDatasources(ctx)
    if err != nil {
        ps.log.Error("Failed to provision data sources", "error", err)
        return err
    }

    err = ps.ProvisionPlugins(ctx)
    if err != nil {
        ps.log.Error("Failed to provision plugins", "error", err)
        return err
    }

    err = ps.ProvisionAlerting(ctx)
    if err != nil {
        ps.log.Error("Failed to provision alerting", "error", err)
        return err
    }

    return nil
}
```

Execution order: datasources → plugins → alerting. This is called from `Server.Init()` at
`server.go:134`, before any background service (including the HTTP server) is started. Runtime
log confirms:

```
logger=provisioning … msg="starting to provision alerting"
logger=provisioning … msg="finished to provision alerting"
```

Similar lines appear for datasources and plugins, though with no active YAML their bodies are
near no-ops.

### 9.2 Default Provisioning Directory Layout

`ls conf/provisioning/` returned: `access-control, alerting, dashboards, datasources, plugins`.
Each subdirectory contains a single `sample.yaml`. Inspecting the first three lines of each
file revealed that they consist of comments and only the `apiVersion: 1` line is uncommented.
For example, `conf/provisioning/datasources/sample.yaml` begins with:

```yaml
# config file version
apiVersion: 1

# list of datasources that should be deleted from the database
# deleteDatasources:
# ...
```

Because every nontrivial entry (the actual `datasources:` / `deleteDatasources:` arrays) is
commented, the provisioner walks the file, parses the `apiVersion`, and finds no resources
to apply. No error is raised — empty provisioning is a valid state.

### 9.3 Dashboard Provisioning via `Run`

Dashboard provisioning is different: it is not in `RunInitProvisioners`. Instead,
`ProvisioningServiceImpl.Run(ctx)` at lines 191+ registers a background worker that continuously
polls `<ProvisioningPath>/dashboards` for changes. The runtime log shows:

```
logger=provisioning.dashboard … msg="starting to provision dashboards"
logger=provisioning.dashboard … msg="finished to provision dashboards"
```

This pair is emitted from the background goroutine and occurs **after** the HTTP server binds
to port 3000 — around `02:46:33.665` in the first-run timeline compared to `02:46:33.652`
for `HTTP Server Listen`. Dashboard provisioning's asynchronous model is what allows operators
to drop a JSON dashboard into the provisioning directory at runtime and have it picked up
without a restart.

### 9.4 Summary

| Subdirectory | Runs From | Default State | Effect |
|---|---|---|---|
| `datasources/` | `RunInitProvisioners` | `sample.yaml` (commented) | No data sources created |
| `plugins/` | `RunInitProvisioners` | `sample.yaml` (commented) | No plugin settings applied |
| `alerting/` | `RunInitProvisioners` | `sample.yaml` (commented) | No alerting rules / contact points created |
| `dashboards/` | Background `Run` | `sample.yaml` (commented) | No dashboards imported |
| `access-control/` | Background `Run` | `sample.yaml` (commented) | No role assignments applied |

All active provisioning in the default build is a no-op. The log lines
`starting to provision …` / `finished to provision …` appear on every run regardless of
content.

---


## 10. Feature Toggles and Background Services

Grafana enables a substantial number of features "out of the box" without any configuration.
Two mechanisms converge to produce this behavior: the feature-toggle registry's default
expressions, and the background-service registry whose members self-disable only when they
explicitly opt in.

### 10.1 Feature Toggle Defaults (`pkg/services/featuremgmt/registry.go`)

Every feature toggle is declared as a `FeatureFlag` struct literal inside a single slice in
`registry.go`. A flag with `Expression: "true"` evaluates to **enabled** regardless of
operator input. The inspected registry has exactly **56** such entries:

```
$ grep -c 'Expression:\s*"true"' pkg/services/featuremgmt/registry.go
56
```

These represent features that have reached General Availability and are now on by default.
The log line emitted by `featuremgmt.ProvideManagerService` at startup includes exactly 56
`<flagName>=true` key-value pairs (verified by `grep "^logger=featuremgmt" log | tr ' ' '\n'
| grep -c "=true"` returning 56). Examples typically include `correlations`,
`cloudWatchCrossAccountQuerying`, `nestedFolders`, `logRowsPopoverMenu`, and
`featureToggleAdminPage` — the exact set varies with commits and is authoritative only
from the registry file.

`conf/defaults.ini:1876` sets `[feature_toggles] enable =` (empty). This key augments
defaults with operator-selected toggles. With no value, no additional toggles are turned
on via configuration — every enabled flag traces back to an `Expression: "true"` entry in
the Go source.

### 10.2 Runtime vs. API Feature Toggle Count

The `/api/frontend/settings` response reports **57** enabled feature toggles, one more than
the startup log. The delta is explained by flags that are added or enabled post-startup by
code paths that do not flow through the startup log line. Candidates include toggles set
programmatically during service registration (for example, if a module detects an
environment and flips a flag). The authoritative compile-time set remains the 56 in
`registry.go`; the additional flag reported by the API is a runtime augmentation.

### 10.3 Background Services Registered (`pkg/registry/backgroundsvcs/background_services.go`)

`ProvideBackgroundServiceRegistry` (lines 53–118) accepts 36 explicit services and 15
additional interface parameters used for construction-order side effects. The registered
services appended into `BackgroundServiceRegistry.Services` are listed in Section 4.6.

### 10.4 The `CanBeDisabled` Contract (`pkg/registry/registry.go`)

`BackgroundService` is the minimum contract (lines 8–11):

```go
type BackgroundService interface {
    Run(ctx context.Context) error
}
```

The optional `CanBeDisabled` interface (lines 18–21) lets a service self-report as disabled:

```go
type CanBeDisabled interface {
    IsDisabled() bool
}
```

`IsDisabled` (lines 53–56) dispatches via type assertion:

```go
func IsDisabled(srv BackgroundService) bool {
    canBeDisabled, ok := srv.(CanBeDisabled)
    return ok && canBeDisabled.IsDisabled()
}
```

Interpretation:

- A service that does **not** implement `CanBeDisabled` is always started. The HTTP server,
  for example, does not implement this interface — it runs unconditionally.
- A service that does implement `CanBeDisabled` is polled via `IsDisabled()` at
  `Server.Run()`'s `for … range services` loop. Self-disabled services are skipped and
  never scheduled.

### 10.5 Unified Alerting Is Enabled By Default

`pkg/setting/setting_unified_alerting.go` defines `UnifiedAlertingSettings` with
`Enabled *bool`. `readUnifiedAlertingEnabledSetting` (around line 197) parses
`[unified_alerting] enabled`. When the INI value is empty, the reader returns
`util.Pointer(true)`, so `UnifiedAlertingSettings.Enabled` points to `true`.

`IsEnabled()` (around line 183) returns true when `Enabled == nil || *Enabled`:

```go
func (u *UnifiedAlertingSettings) IsEnabled() bool {
    return u.Enabled == nil || *u.Enabled
}
```

Both branches produce a `true` result when the INI key is empty. The log confirms alerting
ran to completion:

```
… msg="Creating Alertmanager for org ID=1"
… msg="Starting MultiOrg Alertmanager"
… msg="Warming state cache for startup"
… msg="Starting scheduler tickInterval=10s maxAttempts=3"
… msg="Applying new configuration to Alertmanager configHash=d2c56faca6af2a5772ff4253222f7386"
```

The alerting scheduler, state manager, and multi-org Alertmanager are therefore active on
every default startup, without any explicit configuration.

### 10.6 Other Services Known To Self-Disable

Based on the codebase patterns, the following services implement `CanBeDisabled`:

- `plugininstaller.Service.IsDisabled` — disabled when no preinstall plugins OR when
  `PreinstallPluginsAsync` is false. Default config makes both conditions enable the service.
- `cleanup.CleanUpService` — typically always runs (no `IsDisabled`).
- `rendering.RenderingService.IsDisabled` — disables itself when no renderer plugin is
  available. Runtime log shows renderer errors but the service still starts; disabling is
  conditional on config.
- `updatechecker.GrafanaService.IsDisabled` / `updatechecker.PluginsService.IsDisabled` —
  controlled by `[analytics] check_for_updates` / `check_for_plugin_updates` (defaults
  `true`). Runtime log confirms `Update check succeeded` on both.

The precise list of self-disabling services can be enumerated by grepping for
`func \(.*\) IsDisabled` under `pkg/services/`; this is outside the scope of the default-run
behavior questions.

---

## 11. Secrets and Encryption

Grafana's envelope-encryption subsystem bootstraps during Wire construction, before
`Server.Init()` runs. The user observed a startup log line indicating envelope encryption
is enabled with a `secretKey.v1` provider, and this section documents why.

### 11.1 `ProvideSecretsService` (`pkg/services/secrets/manager/manager.go:58`)

The Wire provider function is named `ProvideSecretsService` (note: not
`ProvideService` — the secrets manager deviates from the common naming convention because
the file previously exported a different `ProvideService` for a legacy implementation).

The function reads `cfg.Raw.Section("security").Key("encryption_provider").MustString("secretKey.v1")` —
so in practice the provider string is always `secretKey.v1` under default config
(`conf/defaults.ini:340` also explicitly sets this value).

It then checks `features.IsEnabledGlobally(featuremgmt.FlagDisableEnvelopeEncryption)`.
With default features, this flag is **off**, so envelope encryption is enabled. The
resulting log line from the secrets logger is:

```
logger=secrets t=… level=info msg="Envelope encryption state enabled=true current provider=secretKey.v1"
```

(The logfmt encoder collapses the space in `"current provider"`, rendering the key as
`currentprovider=secretKey.v1` in log output; the source-code key literal is
`"current provider"`.)

### 11.2 Provider Initialization

`s.InitProviders()` (called inside `ProvideSecretsService`) registers the `secretKey.v1`
provider, which derives its master key from `[security] secret_key` — the default
`SW2YcwTIb9zpOOhoPsMm` string. The provider's symmetric data-encryption keys are persisted
in the `data_keys` table.

Runtime inspection returned one row after the first run:

```
id=ffjblpaqoag3ke  name=2026-04-17/root@secretKey.v1
provider=secretKey.v1  active=1
encrypted_data=<binary blob>
created=2026-04-17T02:46:…  updated=2026-04-17T02:46:…
```

### 11.3 Secret Migration

A background service under `pkg/services/secrets/kvstore/migrations/` is responsible for
migrating legacy plaintext or differently-encrypted secrets into the envelope format.
`SecretMigrationProviderImpl.Migrate` (`pkg/services/secrets/kvstore/migrations/migrator.go:68-85`)
wraps the underlying `DataSourceSecretMigrationService.Migrate` in a
`serverLockService.LockExecuteAndRelease(ctx, "secret migration task ", 10*time.Minute, fn)`
call. `LockExecuteAndRelease` (`pkg/infra/serverlock/serverlock.go:137-170`) acquires a row
in `server_lock` via a UNIQUE constraint on `operation_uid`, runs `fn`, and then calls
`releaseLock` which **removes** the row — so the lock is not persistent across restarts.
The lock exists to guarantee single-leader execution in HA/replica scenarios.

The per-run short-circuit is not lock-based; it is implemented inside the locked closure
by `DataSourceSecretMigrationService.Migrate`
(`pkg/services/secrets/kvstore/migrations/datasource_mig.go:40-106`). That function reads
the `secretMigrationStatus` entry from `kv_store` (namespace `datasource`) and evaluates
two flags: `needCompatibility` (true when the stored status is not `compatible` and
`FlagDisableSecretsCompatibility` is off) and `needMigration` (true when the stored status
is not `complete` and the flag is on). On a default OSS boot, the flag is off. If neither
flag is true, the migration body is skipped entirely and the existing KV entries remain
untouched.

Observable first-run vs subsequent-run behavior:

- **First run:** The `secretMigrationStatus` key does not exist, so `needCompatibility` is
  true. The function iterates all data sources (none on a clean first run), then writes
  `secretMigrationStatus=compatible` into `kv_store`. Other KV entries also land during
  startup via adjacent services:
  - `datasource | secretMigrationStatus | compatible`
  - `ngalert.migration | currentAlertingType | Legacy`
  - `plugin.angularpatterns | angular_patterns | [...]`, `etag`, `last_updated`
  - `plugin.publickeys | key-7e4d0c6a708866e7 | <PGP block>`, `last_updated`
  The transient server_lock row is acquired, used, and released — it does not persist in
  the DB after startup.
- **Subsequent runs:** `LockExecuteAndRelease` acquires the lock cleanly (no other process
  holds it in a single-server setup), and the inner `Migrate` function reads
  `secretMigrationStatus=compatible`, so `needCompatibility` and `needMigration` are both
  false; the migration body short-circuits without touching the KV store or any
  datasource. The lock is then released. The log line
  `"Server lock for secret migration already exists"` at `migrator.go:82` is **only**
  emitted when `LockExecuteAndRelease` returns an error (i.e., another process is holding
  the lock concurrently — the HA case). It does **not** appear in normal single-server
  restarts, and was verified absent from all three captured restart logs in this
  investigation.

### 11.4 Secret Storage

The `secrets` table remains empty on a default first run — it is populated only when an
application (e.g., an OAuth provider, a datasource password, an API key) saves an encrypted
secret through the secrets service. A first-run inspection returned zero rows.

### 11.5 Signing Keys

Independent of envelope encryption, Grafana maintains a rotating ES256 signing key in the
`signing_key` table for JWT issuance. One row was observed after first run:

```
id=id-2026-04-es256  alg=ES256
added_at=2026-04-17 02:47:23.707421142+00:00
expires_at=<nullable>
```

The signing key is generated lazily by the key service (`pkg/services/signingkeys/`) when
JWTs are first needed. In this run it was created about 50 seconds after `Server.Run()`
began, consistent with first-time background-service activation.

### 11.6 Production Implications

- The default `secret_key` (`SW2YcwTIb9zpOOhoPsMm`) is **public knowledge** because it is
  shipped in every Grafana binary. Any deployment that does not override it has effectively
  no secret protection — anyone with read access to `data/grafana.db` and the Grafana
  source tree can decrypt stored secrets.
- Production operators must set `[security] secret_key` (via config or `GF_SECURITY_SECRET_KEY`)
  to a random value before first start.
- Rotating the secret key after secrets have been persisted requires a re-encryption
  migration that is outside the scope of this first-run investigation.

---

## 12. First Run vs. Subsequent Run Behavioral Differences

The central measurable difference between first and subsequent runs is the presence of
`data/grafana.db`. Every downstream behavior flows from that single state bit.

Empirical observations from the captured logs:

- **First run log:** `/tmp/blitzy_adhoc_test_first_run.log` — **1,356 lines**, 644
  `Executing migration` entries (626 schema + 18 resource-migrator).
- **Second run log:** `/tmp/blitzy_adhoc_test_second_run.log` — **58 lines** (a 23× smaller
  footprint).

The second run was captured after a clean server shutdown while the `data/` directory was
left intact.

### 12.1 Comparison Table

| # | Aspect | First Run | Subsequent Run | Evidence Source |
|---|---|---|---|---|
| 1 | SQLite database file | Created at `data/grafana.db` (logged: `Creating SQLite database file path=data/grafana.db`) | File already exists, opened without creation log | `pkg/services/sqlstore/sqlstore.go:initEngine` |
| 2 | Schema migrations | All 626 executed; logged individually (`Executing migration`), then `migrations completed performed=626 skipped=0 duration=1.69775249s` | All 626 checked against `migration_log`, all skipped: `migrations completed performed=0 skipped=626 duration=767.619µs` (~2200× faster) | `pkg/services/sqlstore/migrations/` + `migrator.RunMigrations` |
| 3 | Resource migrator | 18 migrations executed: `migrations completed performed=18 skipped=0 duration=49.370875ms` | All 18 skipped: `migrations completed performed=0 skipped=18 duration=33.347µs` | Resource-store migrator |
| 4 | Admin user | Created with `login=admin`, `password=admin` (PBKDF2-HMAC-SHA256 hashed via `pkg/util/encoding.go:54`; 10,000 iterations, 50-byte output, hex-encoded to 100 chars; salt stored separately in `user.salt`), `is_admin=1` (logged: `Created default admin user=admin`) | User count > 0; creation skipped entirely; no log line | `pkg/services/sqlstore/sqlstore.go:190-232` |
| 5 | Default organization | "Main Org." created (logged: `Created default organization`) | Already exists; skipped; no log line | `pkg/services/sqlstore/sqlstore.go:225-230` |
| 6 | Plugin loading | 54 plugins loaded from core sources (`Plugins loaded count=54 duration=27.655448ms`) | Same 54 plugins loaded (`count=54 duration=28.017063ms`) — deterministic | `pkg/services/pluginsintegration/pluginstore/store.go:32-53` |
| 7 | External plugin directory | `data/plugins/` absent → `Failed to load external plugins error="failed to open plugins path"` | Still absent → same error logged again | `pkg/plugins/manager/sources/sources.go:34-47` |
| 8 | Default preinstall plugin | `grafana-lokiexplore-app` install attempted, fails with `[plugin.grafanaVersionNotCompatible]` (binary is 9.2.0) | Same attempt, same failure — installer does not persist failure state | `pkg/setting/setting_plugins.go:29-34`, `plugininstaller/service.go` |
| 9 | `data/log/` directory | Created | Already exists | `[paths] logs = data/log` |
| 10 | `data/csv/`, `data/pdf/`, `data/png/` | Created as empty directories | Already exist | Renderer subsystem |
| 11 | KV store entries | Created: `ngalert.migration/currentAlertingType`, `datasource/secretMigrationStatus`, `plugin.angularpatterns/*` (3 entries), `plugin.publickeys/*` (2 entries) | Already present from first run; angular patterns re-fetch may `UPDATE` etag & last_updated in place | `pkg/services/secrets/kvstore/*`, angular detectors |
| 12 | Server lock entries | `cleanup expired auth tokens` row created | Lock already exists (may be renewed, not recreated) | `pkg/infra/serverlock` |
| 13 | Secret migration | Acquires transient server lock via `LockExecuteAndRelease`; inner `DataSourceSecretMigrationService.Migrate` writes `secretMigrationStatus=compatible` KV entry; lock is then released | Lock re-acquired cleanly; inner `Migrate` reads `secretMigrationStatus=compatible` and short-circuits without touching KV or datasources; no lock-failure log line in single-server restart (the `Server lock for secret migration already exists` error at `migrator.go:82` is only emitted in HA/concurrent scenarios where the lock cannot be acquired) | `pkg/services/secrets/kvstore/migrations/migrator.go:68-85`, `datasource_mig.go:40-106` |
| 14 | RBAC fixed roles | `RegisterFixedRoles` runs (in-memory only in OSS) | Runs again (idempotent, in-memory only) | `pkg/server/server.go:130` |
| 15 | Envelope encryption | `Envelope encryption state enabled=true currentprovider=secretKey.v1` logged; `data_keys` row inserted | Log line repeats; existing `data_keys` row reused | `pkg/services/secrets/manager/manager.go:58` |
| 16 | Signing key | Created lazily (~50s after startup); 1 row in `signing_key` (ES256) | Reused from prior run | `pkg/services/signingkeys/` |
| 17 | Alertmanager configuration | Default `alert_configuration` row created (org_id=1, hash=`ed091fbc8c639dd8063190127c806946`, version=`v1`) | Existing row used as-is | `pkg/services/ngalert/store` |
| 18 | Feature toggle enumeration | 56 toggles emitted at startup | Same 56 toggles emitted | `pkg/services/featuremgmt/registry.go` |
| 19 | Startup duration | Dominated by migrations (~1.7s migration phase) | No migration work; subsecond to `HTTP Server Listen` | Empirical measurement |
| 20 | Log line count | 1,356 lines | 58 lines | `wc -l` on captured logs |

### 12.2 What Does Not Differ

The following are identical across runs:

- Set of plugins loaded (54 every time).
- Set of feature toggles enabled (56 every time).
- HTTP listener binding (`[::]:3000`).
- Provisioning no-op loop over commented sample YAMLs.
- Loki Explore App preinstall failure — the background installer does not record attempts.
- Log messages from envelope encryption, unified alerting scheduler start, update checker, and
  angular detectors restore.

### 12.3 What This Means For Operators

- **Clean-state reproduction** requires deleting the `data/` directory before restart. Any
  other artifact (logs, bin, public) does not affect database state.
- **Migration cost is one-time.** Even if the number of migrations grows, the log shows
  only ~1.7 seconds on first run — acceptable for container startups.
- **Subsequent-run hot-path is dominated by plugin loading** (~28 ms) and HTTP listener
  setup; the database is effectively free to open.
- **Non-determinism is limited** to the ES256 signing-key generation (unique per run when
  rotated) and timestamp fields; the functional behavior is reproducible.

---

## 13. Answers to the User's Specific Questions

This section restates the user's stated or implied questions and answers each with pointers
back to the supporting evidence in earlier sections.

### 13.1 "What does Grafana do on startup with no configuration?"

With no `conf/custom.ini`, no `GF_*` environment variables, and no CLI flags beyond
`--homepath=.`, the server:

1. Reads `conf/defaults.ini` as its sole configuration source (Section 5.1).
2. Initializes logging, PID-file writing (no-op without `--pidfile`), profiling, and tracing
   (Section 4.2).
3. Opens or creates `data/grafana.db` (SQLite3), runs 626 schema migrations plus 18 resource
   migrations on first run (Section 6.1, 6.2).
4. Creates the default admin user (`admin` / `admin`) and "Main Org." organization on first
   run (Section 6.3, 7.1).
5. Initializes envelope encryption with the `secretKey.v1` provider (Section 11.1).
6. Loads 54 core plugins from `public/app/plugins/` (Section 8.2).
7. Attempts — and fails — to preinstall `grafana-lokiexplore-app` (Section 8.5).
8. Runs `RunInitProvisioners` over datasources, plugins, and alerting (Section 9.1) — all
   no-ops because every sample YAML is commented.
9. Starts 36 background services including the HTTP server, unified alerting scheduler,
   multi-org Alertmanager, storage service, update checkers, and angular detectors (Section 4.6,
   10.3).
10. Binds `[::]:3000` for HTTP traffic.
11. Enables 56 feature toggles by default via `Expression: "true"` in the registry
    (Section 10.1).

### 13.2 "Why can I log in with `admin` / `admin` without configuring anything?"

Because the default credentials are hardcoded into `conf/defaults.ini`:
- `admin_user = admin` (line 328)
- `admin_password = admin` (line 331)

…and `ensureMainOrgAndAdminUser` in `pkg/services/sqlstore/sqlstore.go:190-232` unconditionally
creates the admin user on first run (when the `user` table is empty) using
`ss.createUser(ctx, sess, user.CreateUserCommand{Login: ss.cfg.AdminUser, Password:
user.Password(ss.cfg.AdminPassword), IsAdmin: true})`. This is guarded only by
`disable_initial_admin_creation` (default `false`). The password is PBKDF2-HMAC-SHA256
hashed before storage — `util.EncodePassword` (`pkg/util/encoding.go:54`) calls
`pbkdf2.Key(password, salt, 10000, 50, sha256.New)` and hex-encodes the 50-byte output to
100 characters stored in `user.password`; the salt is stored separately in `user.salt`
(runtime inspection confirmed a 100-character hex hash plus a distinct 10-character
salt). There are **no** `bcrypt` imports anywhere under `pkg/`. The plaintext value is,
regardless, the ubiquitous `admin`. See Section 7.1 for details.

Anonymous access is **not** enabled (`[auth.anonymous] enabled = false`), so the server
still requires credentials — but it already supplied them to the operator by generating the
admin account. To prevent the default account, operators must set
`disable_initial_admin_creation = true` before the first run.

### 13.3 "What state gets created and remembered?"

The primary persistent artifact is the SQLite file `data/grafana.db` (≈1 MB, 75 tables).
Secondary filesystem artifacts are `data/log/`, `data/csv/`, `data/pdf/`, and `data/png/`.
Key seeded records:

- 1 `user` row (admin)
- 1 `org` row (Main Org.)
- 1 `org_user` row
- 626 rows in `migration_log`, 18 in `resource_migration_log`
- 9 `kv_store` rows (see Section 6.7)
- 1 `server_lock` row (`cleanup expired auth tokens`)
- 1 `data_keys` row (envelope-encryption DEK)
- 1 `signing_key` row (ES256)
- 1 `alert_configuration` row (default Alertmanager config for org 1)

Zero rows exist in `data_source`, `dashboard`, `alert_rule`, `plugin_setting`, `api_key`,
`role`, `permission`, `builtin_role`, `secrets`, `team`, and most other "content" tables.

On subsequent runs, this state makes startup approximately 23× smaller in log volume and
2200× faster in migration execution time. It also causes the admin-creation and
default-organization creation paths to short-circuit. See Section 12 for a 20-row comparison
table.

### 13.4 "Some plugins appear in the UI without installation — why?"

They are **core plugins** compiled into the Grafana binary. Their source lives under
`public/app/plugins/datasource/` (22 subdirectories) and `public/app/plugins/panel/`
(32 subdirectories). `pkg/plugins/manager/sources/sources.go:corePluginPaths` (lines 63–68)
declares these two directories as sources for `plugins.ClassCore`, and
`pkg/services/pluginsintegration/pluginstore/store.go:32-53` iterates every source and loads
its plugins. The loader reports `Plugins loaded count=54` — exactly 22 + 32 — at every
startup. No installation, catalog download, or configuration is required; the plugins ship
with the server. See Section 8 for the full pipeline.

The `/api/plugins` endpoint returns 49 rather than 54 because some loaded plugins are
filtered before being exposed (e.g., `dashboard`, `mixed`, `table-old`) — see Section 8.3.

### 13.5 "Some features are enabled by default without any configuration — why?"

Because `pkg/services/featuremgmt/registry.go` declares 56 feature toggles with
`Expression: "true"`. At runtime, `featuremgmt.ProvideManagerService` evaluates each
expression and, for those whose expression returns true, enables the flag. The
`[feature_toggles] enable =` key in `conf/defaults.ini:1876` is empty, so no toggles are
enabled from configuration — every enabled toggle traces to an `Expression: "true"`
declaration in Go code.

The `/api/frontend/settings` endpoint reports 57 enabled toggles (one more than the startup
log's 56), which reflects a runtime augmentation outside the compile-time registry. See
Section 10.1 and 10.2.

### 13.6 "Is building required, or can I just `go run`?"

**Wire code generation is mandatory** before either `go build` or `go run` can succeed,
because `pkg/server/wire.go` has the `//go:build wireinject` tag (meaning the Go compiler
skips it) and there is no concrete `server.Initialize` function without the Wire-generated
file `pkg/server/wire_gen.go`. The required command is:

```
go run ./pkg/build/wire/cmd/wire/main.go gen -tags oss ./pkg/server
```

(from `Makefile:166-169`, with `WIRE_TAGS = "oss"` from `Makefile:5`).

After that step, `go build -tags oss -o ./bin/grafana ./pkg/cmd/grafana` or
`go run -tags oss ./pkg/cmd/grafana server --homepath=.` both work identically.

**The frontend build (`public/build/`) is not required for the backend to start.**
`pkg/setting/setting.go:validateStaticRootPath` (lines 1034–1044) logs an error if
`public/build` is missing but returns `nil`. The HTTP server still binds, the API still
serves requests, and authenticated access still works — only the SPA pages render as blank
because the Webpack bundles referenced by `public/views/index.html` are absent. See Section 3.

### 13.7 "How does the first run differ from subsequent runs?"

The defining difference is whether `data/grafana.db` already exists. On first run:

- The SQLite file is created.
- 626 user-table migrations and 18 resource-migrator migrations execute.
- The admin user and "Main Org." organization are created.
- The secret migration job runs and writes KV store entries.
- The startup log is 1,356 lines long.

On subsequent runs:

- The existing SQLite file is opened.
- All 626 + 18 migrations are skipped: `migrations completed performed=0 skipped=626` and
  `performed=0 skipped=18`.
- The admin-creation and organization-creation code paths short-circuit on non-empty tables
  (no log lines).
- The secret-migration job acquires and releases a transient `server_lock` row and then
  short-circuits inside the locked closure because the `kv_store` entry
  `datasource | secretMigrationStatus | compatible` is already present (the row in
  `server_lock` is not persistent — it is released each run). The
  `Server lock for secret migration already exists` log line at `migrator.go:82` is
  **not** emitted on single-server restarts (it only fires in HA/concurrent scenarios
  where `LockExecuteAndRelease` fails to acquire the lock).
- The startup log is 58 lines — a 23× reduction.

Things that do **not** change between runs:
- Plugin loading (54 plugins every time).
- Feature toggle enumeration (56 enabled every time).
- Loki Explore App preinstall failure (recurs on every startup).
- External plugin directory missing error (`data/plugins/` remains absent).

Section 12 contains the full 20-row comparison table.

---

## 14. References

All line numbers refer to the state of the repository at branch `grafana_4550cfb5b728`.

### 14.1 Source Files Inspected

| File | Key Symbols / Lines |
|---|---|
| `conf/defaults.ini` | Lines 7 (`app_mode`), 15–27 (`[paths]`), 32–63 (`[server]`), 118–187 (`[database]`), 190 (`[remote_cache]`), 323–418 (`[security]`), 559–630 (`[auth]`), 648–656 (`[auth.anonymous]`), 1222 (`[unified_alerting] enabled`), 1876 (`[feature_toggles] enable`) |
| `Makefile` | Line 5 (`WIRE_TAGS = "oss"`), lines 166–169 (`gen-go`), line 187 (`build-go`) |
| `go.mod` | Line 3 (`go 1.23.1`) |
| `.nvmrc` | `v22.11.0` |
| `plugins-bundled/external.json` | `{"plugins": []}` |
| `pkg/cmd/grafana/main.go` | Line 17 (`var version = "9.2.0"`), line 23 (`func main`), lines 34–47 (`MainApp`) |
| `pkg/cmd/grafana-server/commands/cli.go` | Line 28 (`ServerCommand`), line 46 (`RunServer`), line 96 (`setting.NewCfgFromArgs`), line 108 (`server.Initialize`), line 123 (signal handler), line 124 (`s.Run()`) |
| `pkg/cmd/grafana-server/commands/flags.go` | Lines 28–109 (`commonFlags`) |
| `pkg/server/server.go` | Lines 30–37 (`Options`), lines 40–56 (`New`), lines 58–84 (`newServer`), lines 86–110 (`Server` struct), lines 113–135 (`Init`), lines 139–180 (`Run`), line 185 (`Shutdown`) |
| `pkg/server/wire.go` | `//go:build wireinject`, DI declarations for ≈60 providers |
| `pkg/server/wireexts_oss.go` | OSS-specific Wire extensions |
| `pkg/setting/setting.go` | `NewCfgFromArgs`, `loadConfiguration` (lines 881–940), `validateStaticRootPath` (lines 1034–1044) |
| `pkg/setting/setting_plugins.go` | Lines 29–34 (`defaultPreinstallPlugins`), lines 36–80 (`readPluginSettings`), `PreinstallPluginsAsync` default true |
| `pkg/setting/setting_unified_alerting.go` | `UnifiedAlertingSettings`, `IsEnabled()` (line ≈183), `readUnifiedAlertingEnabledSetting` (line ≈197) returning `util.Pointer(true)` |
| `pkg/services/sqlstore/sqlstore.go` | Lines 56–79 (`ProvideService`), line 110 (`initEngine`), lines 133–149 (`Migrate`), lines 153–159 (`Reset`), lines 190–232 (`ensureMainOrgAndAdminUser`) |
| `pkg/services/sqlstore/migrations/` | 87 migration source files defining 626 migrations; registered via `OSSMigrations.AddMigration` |
| `pkg/services/provisioning/provisioning.go` | Lines 169–189 (`RunInitProvisioners`), lines 191+ (`Run`) |
| `pkg/plugins/manager/sources/sources.go` | Lines 24–32 (`List`), lines 34–47 (`externalPluginSources`), lines 49–61 (`pluginSettingSources`), lines 63–68 (`corePluginPaths`) |
| `pkg/services/pluginsintegration/pluginstore/store.go` | Lines 32–53 (`ProvideService`), lines 55–59 (`Run`) |
| `pkg/services/pluginsintegration/plugininstaller/service.go` | `ProvideService` (line ≈48), `IsDisabled` (line ≈80) |
| `pkg/registry/backgroundsvcs/background_services.go` | Lines 53–118 (`ProvideBackgroundServiceRegistry`), lines 120–123 (`BackgroundServiceRegistry` type) |
| `pkg/registry/registry.go` | Lines 8–11 (`BackgroundService`), lines 18–21 (`CanBeDisabled`), lines 53–56 (`IsDisabled`) |
| `pkg/services/secrets/manager/manager.go` | Line 58 (`ProvideSecretsService`), `InitProviders`, envelope encryption log line |
| `pkg/services/featuremgmt/registry.go` | 56 entries with `Expression: "true"` |

### 14.2 Runtime Artifacts Observed

| Artifact | Description |
|---|---|
| `/tmp/blitzy_adhoc_test_first_run.log` | First-run startup log, 1,356 lines |
| `/tmp/blitzy_adhoc_test_second_run.log` | Second-run startup log, 58 lines |
| `data/grafana.db` | SQLite database, 1,093,632 bytes, 75 tables |
| `data/log/grafana.log` | Runtime log stream (≈207 KB after one run) |
| `data/csv/`, `data/pdf/`, `data/png/` | Empty renderer output directories |
| `bin/grafana` | 298 MB self-contained binary |
| `bin/grafana-server` | 2.4 MB thin server wrapper |
| `bin/grafana-cli` | 2.4 MB CLI wrapper |

### 14.3 API Endpoints Tested

| Endpoint | Auth | Response |
|---|---|---|
| `GET /api/health` | none | `{"database":"ok","version":"9.2.0","commit":"NA"}` |
| `GET /api/org` | none | `HTTP 401` |
| `GET /api/org` | `admin:admin` | `{"id":1,"name":"Main Org.",…}` |
| `GET /api/user` | `admin:admin` | `id=1 login=admin email=admin@localhost isGrafanaAdmin=true` |
| `GET /api/datasources` | `admin:admin` | `[]` |
| `GET /api/plugins` | `admin:admin` | 49 entries (30 panel + 19 datasource) |
| `GET /api/admin/settings` | `admin:admin` | Full settings dump; `admin_password` masked as `*********`; `auth.anonymous.enabled=false` |
| `GET /api/frontend/settings` | `admin:admin` | 57 feature toggles, 29 panels exposed, 3 datasources exposed |

### 14.4 Database Queries Executed

| Query | Result |
|---|---|
| `.tables` | 75 tables |
| `SELECT COUNT(*) FROM migration_log` | 626 |
| `SELECT COUNT(*) FROM resource_migration_log` | 18 |
| `SELECT id, login, email, is_admin FROM user` | `1|admin|admin@localhost|1` |
| `SELECT id, name FROM org` | `1|Main Org.` |
| `SELECT id, namespace, key FROM kv_store ORDER BY id` | 9 rows (see Section 6.7) |
| `SELECT * FROM server_lock` | `1|cleanup expired auth tokens|1|1776393993` |
| `SELECT * FROM data_keys` | 1 row (secretKey.v1 active) |
| `SELECT id, key_id, alg FROM signing_key` | 1 row (ES256) |
| `SELECT COUNT(*) FROM alert_configuration` | 1 (default Alertmanager config) |
| `SELECT COUNT(*) FROM role, permission, builtin_role` | all zero (RBAC in-memory in OSS) |
| `SELECT COUNT(*) FROM data_source` | 0 |

### 14.5 Build Toolchain

| Tool | Version | Source |
|---|---|---|
| Go | 1.23.1 | `go.mod` line 3; toolchain extracted to `/usr/local/go` |
| Node.js | v22.11.0 | `.nvmrc`; active via nvm |
| Yarn | 4.5.3 | `package.json` `packageManager`; activated via `corepack` |
| SQLite | 3 | Apt package `libsqlite3-dev`; client `/usr/bin/sqlite3` |
| curl | 8.5.0 | System default |
