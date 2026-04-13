# Grafana Server: Clean-State Startup Ground Truth Reference

## Introduction

This document answers new-contributor questions about what **observably occurs** when `grafana-server` is launched from a completely clean state (no prior database, no custom configuration, no installed plugins). Every factual claim is traced to specific source files, function names, and line numbers within the Grafana repository (v11.5.0-pre, Go 1.23.1 per `go.mod`).

**This document is based entirely on source-code evidence — not on architecture documentation or external references.** Where code behavior differs from documentation abstractions, the code is treated as the single source of truth.

### Topics Covered

1. **Server Initialization Ground Truth** — The exact call chain from process start to `READY=1`
2. **Default Configuration Resolution** — How `conf/defaults.ini` is loaded and merged
3. **Automatic Database Creation and Migration** — SQLite file creation and 79 migration groups
4. **Default Admin Account Provisioning** — The `admin`/`admin` user and "Main Org." creation
5. **Security Posture of Defaults** — What is enabled, disabled, and exposed out of the box
6. **Plugin Discovery and Classification** — Core, bundled, and external plugin ecosystems
7. **Background Service Lifecycle** — How services launch as concurrent goroutines
8. **First-Run vs. Subsequent-Run Behavioral Differences** — What changes after the first startup
9. **Build Artifact Dependencies** — What must be compiled before the server can run

---

## 1. Server Initialization Ground Truth

### 1.1 Binary Entrypoint

> **Source:** `pkg/cmd/grafana-server/main.go` (11 lines total)

The server binary's `main()` function is minimal — it delegates immediately to the command framework:

```go
// pkg/cmd/grafana-server/main.go, line 9-11
func main() {
    os.Exit(cmd.RunGrafanaCmd("server"))
}
```

**Rationale:** The `cmd.RunGrafanaCmd("server")` call (from `pkg/util/cmd`) assembles a `urfave/cli/v2` application with the `"server"` command registered. The entire CLI framework, flag parsing, and command dispatching is handled by this single entry point. The `os.Exit()` wrapper ensures the process exits with the correct status code.

### 1.2 RunServer Orchestration

> **Source:** `pkg/cmd/grafana-server/commands/cli.go`

The `ServerCommand()` function (lines 28–44) creates the `cli.Command` for the `"server"` subcommand. When invoked, it calls `RunServer()`.

`RunServer()` (lines 46–125) is the startup orchestrator. Here is the exact sequence:

| Step | Lines | Action | Detail |
|------|-------|--------|--------|
| 1 | 47–62 | Version check | If `--version` or `--vv` flags are set, prints version info and exits |
| 2 | 64–69 | Logger init | Creates logger, sets up deferred `log.Close()` |
| 3 | 71–76 | Profiling/tracing | Calls `setupProfiling()` and `setupTracing()` from CLI flags |
| 4 | 78–90 | Panic recovery | Installs a `defer recover()` that logs panics before re-panicking |
| 5 | 92 | Build info | `SetBuildInfo(opts)` records version/commit/branch metadata |
| 6 | 93 | Privilege check | `checkPrivileges()` — prints a warning to stdout if running as root (line 166–174) |
| 7 | 95 | Config overrides | Splits `ConfigOverrides` string into separate args |
| 8 | 96–104 | **Config loading** | `setting.NewCfgFromArgs(CommandLineArgs{Config, HomePath, Args})` — **this is where the entire layered configuration pipeline runs** |
| 9 | 106 | Metrics | `metrics.SetBuildInformation(...)` registers Prometheus build info gauge |
| 10 | 108–120 | **Server init** | `server.Initialize(cfg, Options{...}, api.ServerOptions{})` — **Wire dependency injection builds the full server object graph** |
| 11 | 122–123 | Signal handler | Goroutine: `listenToSystemSignals(ctx, s)` — SIGTERM/SIGINT → graceful shutdown, SIGHUP → log reload |
| 12 | 124 | **Run** | `s.Run()` — blocks until shutdown |

**Rationale:** The startup is deliberately sequential. Configuration must load first because Wire injection at step 10 depends on the `*setting.Cfg` object. The signal handler runs in a separate goroutine because `s.Run()` blocks the main goroutine.

### 1.3 CLI Flags

> **Source:** `pkg/cmd/grafana-server/commands/flags.go` (lines 28–109)

All available flags for `grafana-server server`:

| Flag | Type | Default | Purpose |
|------|------|---------|---------|
| `--config` | string | `""` (falls back to `conf/custom.ini`) | Path to config file |
| `--homepath` | string | working directory | Path to Grafana install directory |
| `--pidfile` | string | `""` | Path to PID file |
| `--packaging` | string | `"unknown"` | Installation type descriptor |
| `--configOverrides` | string | `""` | Space-separated overrides, e.g. `cfg:default.paths.log=/dev/null` |
| `--version` / `-v` | bool | `false` | Print version and exit |
| `--vv` | bool | `false` | Print version with all dependencies and exit |
| `--profile` | bool | `false` | Enable pprof profiling |
| `--profile-addr` | string | `"localhost"` | Profiling listen address |
| `--profile-port` | uint64 | `6060` | Profiling listen port |
| `--profile-block-rate` | int | `1` | Goroutine blocking event sampling rate |
| `--profile-mutex-rate` | int | (current value) | Mutex contention event sampling rate |
| `--tracing` | bool | `false` | Enable execution tracing |
| `--tracing-file` | string | `"trace.out"` | Execution trace output file |

### 1.4 Server.Init() and Server.Run()

> **Source:** `pkg/server/server.go`

#### Server Construction

`New()` (lines 40–56) creates the `Server` by calling `newServer()` then `s.Init()`.

`newServer()` (lines 58–84) constructs the `Server` struct. Key fields populated:

- `context` / `childRoutines` — errgroup-based goroutine management (line 62–63)
- `HTTPServer` — the API HTTP server instance (line 69)
- `provisioningService` — provisions datasources, plugins, alerting (line 70)
- `roleRegistry` — RBAC fixed role registration (line 71)
- `backgroundServices` — from `backgroundServiceProvider.GetServices()` (line 80)

#### Init() — Lines 113–135

The `Init()` method is **idempotent** — guarded by a mutex and `isInitialized` flag (lines 114–120):

1. **Write PID file** (line 122–124): `writePIDFile()` creates the PID file if `--pidfile` was specified. File permission is `0644` (line 219).
2. **Prometheus environment info** (line 126–128): `metrics.SetEnvironmentInformation()` registers environment info metrics from config.
3. **Register RBAC roles** (line 130–132): `s.roleRegistry.RegisterFixedRoles(s.context)` registers all built-in access control roles.
4. **Run init provisioners** (line 134): `s.provisioningService.RunInitProvisioners(s.context)` — provisions datasources, then plugins, then alerting (in that exact order, per `pkg/services/provisioning/provisioning.go` line 169–189).

#### Run() — Lines 139–179

1. **Init()** (line 142–144): Called again, but idempotent due to the `isInitialized` guard.
2. **Service iteration** (line 146–174): Iterates `s.backgroundServices` and for each:
   - Checks `registry.IsDisabled(svc)` (line 150) — **if disabled, silently `continue`** (line 151)
   - If enabled, launches in a goroutine via `s.childRoutines.Go(...)` (line 156)
   - Goroutine logs `"Starting background service"` with the service type name (line 162)
   - Calls `service.Run(s.context)` (line 163) — blocks until service exits
   - On error (non-context.Canceled): logs `"Stopped background service"` with error (line 168)
3. **Systemd notification** (line 176): `s.notifySystemd("READY=1")` — sends readiness signal
4. **Wait** (line 179): `s.childRoutines.Wait()` — blocks until all service goroutines exit

### 1.5 Background Service Disable Check

> **Source:** `pkg/registry/registry.go`

```go
// Line 52-56
func IsDisabled(srv BackgroundService) bool {
    canBeDisabled, ok := srv.(CanBeDisabled)
    return ok && canBeDisabled.IsDisabled()
}
```

**Rationale:** The `IsDisabled` function performs a type assertion to check if a `BackgroundService` implements the `CanBeDisabled` interface (lines 18–21). Only if the service **both** implements the interface **and** its `IsDisabled()` method returns `true` is it considered disabled. Services that do not implement `CanBeDisabled` are **always started**.

The `BackgroundService` interface (lines 25–30) requires only a `Run(ctx context.Context) error` method. The `CanBeDisabled` interface (lines 18–21) adds `IsDisabled() bool`. This two-interface design means services opt into disable-ability.

---

## 2. Default Configuration Resolution

### 2.1 Configuration Loading Pipeline

> **Source:** `pkg/setting/setting.go`

#### Entry Point

`NewCfgFromArgs(args)` (lines 1004–1011) creates a new `Cfg` struct and calls `cfg.Load(args)`.

`Load(args)` (line 1046+):
1. Sets `HomePath` via `setHomePath(args)` (line 1047)
2. Sets `ZONEINFO` env var for timezone database (lines 1050–1055)
3. Calls `loadConfiguration(args)` — **the core pipeline** (line 1057)
4. Calls `parseINIFile(iniFile)` to extract all settings into struct fields (line 1062)

#### The Core Config Pipeline: `loadConfiguration()` — Lines 881–943

This is the **exact loading order**, from lowest to highest priority:

| Step | Lines | Operation | Detail |
|------|-------|-----------|--------|
| 1 | 883–890 | **Load defaults** | Loads `conf/defaults.ini` from `HomePath`. **Fatal exit** if file not found. |
| 2 | 893–898 | **Parse defaults** | `ini.Load(defaultConfigFile)` parses the INI file |
| 3 | 901–903 | **CLI default overrides** | Applies `cfg:default.*` overrides from `--configOverrides` |
| 4 | 906–914 | **Custom config file** | `loadSpecifiedConfigFile(args.Config, parsedFile)` — loads user-specified config or `conf/custom.ini` (from `customInitPath = "conf/custom.ini"` defined at line 57) |
| 5 | 917–920 | **Environment variables** | `applyEnvVariableOverrides(parsedFile)` — pattern: `GF_<SECTION>_<KEY>` (e.g., `GF_DATABASE_TYPE=postgres`) |
| 6 | 923 | **CLI command overrides** | `applyCommandLineProperties(commandLineProps, parsedFile)` |
| 7 | 926–929 | **Placeholder expansion** | `expandConfig(parsedFile)` — resolves `${VAR}` references |
| 8 | 932–938 | **Data path + logging** | Sets `DataPath` from `[paths].data`, initializes logging |

**Loading priority (highest to lowest):**
1. CLI command-line overrides (`cfg:section.key=value`)
2. Environment variables (`GF_SECTION_KEY=value`)
3. Custom INI file (`conf/custom.ini` or `--config` path)
4. Defaults INI file (`conf/defaults.ini`)

**Rationale:** Each subsequent step in the pipeline can override values from previous steps. The `ini.File` object accumulates all changes, and `parseINIFile()` reads the final merged state. This layered approach allows zero-config operation (defaults only) while supporting full customization.

### 2.2 Key Default Values from `conf/defaults.ini`

All values below are verified directly from `conf/defaults.ini`:

| Section | Key | Default Value | Impact |
|---------|-----|---------------|--------|
| `[paths]` (line 15) | `data` | `data` | Data directory relative to HomePath |
| `[paths]` (line 21) | `logs` | `data/log` | Log directory |
| `[paths]` (line 24) | `plugins` | `data/plugins` | External plugins directory |
| `[paths]` (line 27) | `provisioning` | `conf/provisioning` | Provisioning config directory |
| `[server]` (line 32) | `protocol` | `http` | HTTP protocol (not HTTPS) |
| `[server]` (line 38) | `http_addr` | _(empty)_ | Binds to all interfaces (0.0.0.0) |
| `[server]` (line 41) | `http_port` | `3000` | Default listening port |
| `[server]` (line 44) | `domain` | `localhost` | Public-facing domain |
| `[server]` (line 51) | `root_url` | `%(protocol)s://%(domain)s:%(http_port)s/` | Base URL with INI variable interpolation |
| `[database]` (line 123) | `type` | `sqlite3` | Default database engine |
| `[database]` (line 124) | `host` | `127.0.0.1:3306` | Database host (unused for SQLite) |
| `[database]` (line 125) | `name` | `grafana` | Database name (unused for SQLite) |
| `[database]` | `path` | `grafana.db` | SQLite file name (see `database_config.go` line 111) |
| `[security]` (line 328) | `admin_user` | `admin` | Default admin username |
| `[security]` (line 331) | `admin_password` | `admin` | Default admin password |
| `[security]` (line 334) | `admin_email` | `admin@localhost` | Default admin email |
| `[security]` (line 325) | `disable_initial_admin_creation` | `false` | Admin user IS created on first run |
| `[auth]` (line 564) | `disable_login` | `false` | Built-in login enabled |
| `[auth]` (line 576) | `disable_login_form` | `false` | Login form shown |
| `[auth]` (line 561) | `login_cookie_name` | `grafana_session` | Session cookie name |
| `[auth.anonymous]` (line 650) | `enabled` | `false` | Anonymous access disabled |
| `[auth.anonymous]` | `org_name` | `Main Org.` | Default org for anonymous users |
| `[auth.anonymous]` | `org_role` | `Viewer` | Default role for anonymous users |
| `[remote_cache]` (line 190) | `type` | `database` | Cache type defaults to database |

---

## 3. Automatic Database Creation and Migration

### 3.1 SQLStore Initialization

> **Source:** `pkg/services/sqlstore/sqlstore.go`

`ProvideService()` (lines 56–79) is called by Wire during dependency injection assembly. Here is the exact sequence:

```
ProvideService()
├── line 63: xorm.DefaultPostgresSchema = ""  (compatibility fix)
├── line 64: newSQLStore(cfg, nil, features, migrations, bus, tracer)
│   ├── line 95-103: Creates SQLStore struct
│   ├── line 110: ss.initEngine(engine)          ← DATABASE FILE CREATION
│   └── line 114: ss.dialect = NewDialect(...)
├── line 69: s.Migrate(s.dbCfg.MigrationLock)   ← ALL MIGRATIONS RUN
├── line 73: s.Reset()
│   └── line 158: ensureMainOrgAndAdminUser(false) ← ADMIN USER CREATED
└── line 76-78: Set tracer, return
```

**Rationale:** The three phases — engine initialization, migration, and user/org creation — are deliberately separated. Migration cannot run until the database engine exists. Admin user creation cannot run until the schema tables exist (created by migrations).

### 3.2 Database Engine Initialization

> **Source:** `pkg/services/sqlstore/sqlstore.go`, `initEngine()` — lines 238–340

For **SQLite** (the default database type):

1. **Engine existence check** (lines 239–242): If engine already exists, returns early.
2. **Config reading** (line 244): `NewDatabaseConfig(cfg, features)` reads `[database]` section.
3. **File existence check** (lines 256–283): For SQLite with a file path (not `:memory:`):
   - **First run — file does NOT exist** (lines 264–272):
     ```go
     const perms = 0640
     ss.log.Info("Creating SQLite database file", "path", ss.dbCfg.Path)
     f, err := os.OpenFile(ss.dbCfg.Path, os.O_CREATE|os.O_RDWR, perms)
     ```
     Creates `data/grafana.db` with permission **0640** (owner read/write, group read, others none).
   - **Subsequent run — file exists** (lines 273–283):
     Stats the file, checks permissions. Warns if permissions are broader than 0640.
4. **Engine creation** (line 296): `xorm.NewEngine(type, connectionString)` creates the ORM engine.
5. **Connection pool** (lines 310–312): Sets `MaxOpenConns`, `MaxIdleConns` (default 2), `ConnMaxLifetime` (default 14400 seconds).
6. **Metrics** (lines 329–336): Registers `sqlstats` and legacy SQL store Prometheus metrics collectors.

#### Database Config Defaults

> **Source:** `pkg/services/sqlstore/database_config.go`

`readConfig()` (lines 68–126) reads from the `[database]` INI section:

| Setting | Default | Line |
|---------|---------|------|
| `path` | `data/grafana.db` | 111: `sec.Key("path").MustString("data/grafana.db")` |
| `cache_mode` | `private` | 114: `sec.Key("cache_mode").MustString("private")` |
| `wal` | `false` | 115: `sec.Key("wal").MustBool(false)` |
| `max_idle_conn` | `2` | 102 |
| `conn_max_lifetime` | `14400` | 103 |
| `migration_locking` | `true` | 117 |
| `transaction_retries` | `5` | 121 |

For SQLite, `buildConnectionString()` (lines 190–205) constructs:
```
file:<absolute_path>/data/grafana.db?cache=private&mode=rwc
```

The path is made absolute relative to `cfg.DataPath` (line 192–193).

### 3.3 Migration Execution

> **Source:** `pkg/services/sqlstore/sqlstore.go`, `Migrate()` — lines 133–149

1. **Skip check** (line 134): If `SkipMigrations` is true or migrations object is nil, returns immediately.
2. **Migrator creation** (line 138): `migrator.NewMigrator(ss.engine, ss.cfg)` creates the migration runner.
3. **Migration registration** (line 139): `ss.migrations.AddMigration(migrator)` — invokes the master migration registration function.
4. **Prometheus metrics** (line 141): Registers migrator as a metrics collector.
5. **Execution** (line 148): `migrator.RunMigrations(ctx, isDatabaseLockingEnabled, timeout)` — runs all pending migrations in order.

#### Master Migration Registration

> **Source:** `pkg/services/sqlstore/migrations/migrations.go`, `AddMigration()` — lines 31–144

The `OSSMigrations.AddMigration()` method registers **79 distinct migration function calls** (each of which may register multiple individual SQL operations). Here is the **complete, ordered list** as it appears in the source:

| # | Line | Function Call | Primary Tables Created/Modified |
|---|------|--------------|--------------------------------|
| 1 | 32 | `mg.AddCreateMigration()` | `migration_log` (tracks all applied migrations) |
| 2 | 33 | `addUserMigrations(mg)` | `user` |
| 3 | 34 | `addTempUserMigrations(mg)` | `temp_user` |
| 4 | 35 | `addStarMigrations(mg)` | `star` |
| 5 | 36 | `addOrgMigrations(mg)` | `org`, `org_user` |
| 6 | 37 | `addDashboardMigration(mg)` | `dashboard` |
| 7 | 38 | `addDashboardUIDStarMigrations(mg)` | star UID index |
| 8 | 39 | `addDataSourceMigration(mg)` | `data_source` |
| 9 | 40 | `addApiKeyMigrations(mg)` | `api_key` |
| 10 | 41 | `addDashboardSnapshotMigrations(mg)` | `dashboard_snapshot` |
| 11 | 42 | `addQuotaMigration(mg)` | `quota` |
| 12 | 43 | `addAppSettingsMigration(mg)` | `plugin_setting` |
| 13 | 44 | `addSessionMigration(mg)` | `session` |
| 14 | 45 | `addPlaylistMigrations(mg)` | `playlist`, `playlist_item` |
| 15 | 46 | `addPreferencesMigrations(mg)` | `preferences` |
| 16 | 47 | `addAlertMigrations(mg)` | `alert`, `alert_notification` |
| 17 | 48 | `addAnnotationMig(mg)` | `annotation`, `annotation_tag` |
| 18 | 49 | `addTestDataMigrations(mg)` | `test_data` |
| 19 | 50 | `addDashboardVersionMigration(mg)` | `dashboard_version` |
| 20 | 51 | `addTeamMigrations(mg)` | `team`, `team_member` |
| 21 | 52 | `addDashboardACLMigrations(mg)` | `dashboard_acl` |
| 22 | 53 | `addTagMigration(mg)` | `tag` |
| 23 | 54 | `addLoginAttemptMigrations(mg)` | `login_attempt` |
| 24 | 55 | `addUserAuthMigrations(mg)` | `user_auth` |
| 25 | 56 | `addServerlockMigrations(mg)` | `server_lock` |
| 26 | 57 | `addUserAuthTokenMigrations(mg)` | `user_auth_token` |
| 27 | 58 | `addCacheMigration(mg)` | `cache_data` |
| 28 | 59 | `addShortURLMigrations(mg)` | `short_url` |
| 29 | 60 | `ualert.AddTablesMigrations(mg)` | Unified alerting tables |
| 30 | 61 | `addLibraryElementsMigrations(mg)` | `library_element`, `library_element_connection` |
| 31 | 63 | `ualert.FixEarlyMigration(mg)` | Fixes for early alert migrations |
| 32 | 64 | `addSecretsMigration(mg)` | `secrets` |
| 33 | 65 | `addKVStoreMigrations(mg)` | `kv_store` |
| 34 | 66 | `ualert.AddDashboardUIDPanelIDMigration(mg)` | Alert rule dashboard UID/panel ID |
| 35 | 67 | `accesscontrol.AddMigration(mg)` | RBAC `permission`, `role` tables |
| 36 | 68 | `addQueryHistoryMigrations(mg)` | `query_history` |
| 37 | 70 | `accesscontrol.AddDisabledMigrator(mg)` | AC disabled state |
| 38 | 71 | `accesscontrol.AddTeamMembershipMigrations(mg)` | Team membership AC |
| 39 | 72 | `accesscontrol.AddDashboardPermissionsMigrator(mg)` | Dashboard permissions AC |
| 40 | 73 | `accesscontrol.AddAlertingPermissionsMigrator(mg)` | Alerting permissions AC |
| 41 | 75 | `addQueryHistoryStarMigrations(mg)` | `query_history_star` |
| 42 | 77 | `addCorrelationsMigrations(mg)` | `correlation` |
| 43 | 79 | `addEntityEventsTableMigration(mg)` | `entity_event` |
| 44 | 81 | `addPublicDashboardMigration(mg)` | `dashboard_public` |
| 45 | 82 | `addDbFileStorageMigration(mg)` | `file`, `file_meta` |
| 46 | 84 | `accesscontrol.AddManagedPermissionsMigration(mg, ...)` | Managed permissions |
| 47 | 85 | `accesscontrol.AddManagedFolderAlertActionsMigration(mg)` | Folder alert actions |
| 48 | 86 | `accesscontrol.AddActionNameMigrator(mg)` | Action name normalization |
| 49 | 87 | `addPlaylistUIDMigration(mg)` | Playlist UID column |
| 50 | 89 | `ualert.UpdateRuleGroupIndexMigration(mg)` | Rule group index |
| 51 | 90 | `accesscontrol.AddManagedFolderAlertActionsRepeatMigration(mg)` | Folder alert repeat |
| 52 | 91 | `accesscontrol.AddAdminOnlyMigration(mg)` | Admin-only permissions |
| 53 | 92 | `accesscontrol.AddSeedAssignmentMigrations(mg)` | Seed assignments |
| 54 | 93 | `accesscontrol.AddManagedFolderAlertActionsRepeatFixedMigration(mg)` | Folder alert repeat fix |
| 55 | 94 | `accesscontrol.AddManagedFolderLibraryPanelActionsMigration(mg)` | Library panel actions |
| 56 | 96 | `AddExternalAlertmanagerToDatasourceMigration(mg)` | External alertmanager |
| 57 | 98 | `addFolderMigrations(mg)` | `folder` |
| 58 | 100 | `anonservice.AddMigration(mg)` | `anon_device` |
| 59 | 101 | `signingkeys.AddMigration(mg)` | `signing_key` |
| 60 | 103 | `ualert.MigrationServiceMigration(mg)` | Alert migration service state |
| 61 | 104 | `ualert.CreatedFoldersMigration(mg)` | Created folders tracking |
| 62 | 106 | `dashboardFolderMigrations.AddDashboardFolderMigrations(mg)` | Dashboard-folder relations |
| 63 | 108 | `ssosettings.AddMigration(mg)` | `sso_setting` |
| 64 | 110 | `ualert.CreateOrgMigratedKVStoreEntries(mg)` | Org migration KV entries |
| 65 | 113–115 | `accesscontrol.AddManagedDashboardAnnotationActionsMigration(mg)` | Dashboard annotation actions *(conditional: behind `FlagAnnotationPermissionUpdate`)* |
| 66 | 117 | `addCloudMigrationsMigrations(mg)` | Cloud migrations |
| 67 | 119 | `addKVStoreMySQLValueTypeLongTextMigration(mg)` | KV store value type fix |
| 68 | 121 | `ualert.AddRuleNotificationSettingsColumns(mg)` | Rule notification settings |
| 69 | 123 | `accesscontrol.AddAlertingScopeRemovalMigration(mg)` | Alerting scope removal |
| 70 | 125 | `accesscontrol.AddManagedFolderAlertingSilencesActionsMigrator(mg)` | Alerting silences |
| 71 | 127 | `ualert.AddRecordingRuleColumns(mg)` | Recording rule columns |
| 72 | 129 | `ualert.AddStateResolvedAtColumns(mg)` | State resolved_at columns |
| 73 | 131 | `enableTraceQLStreaming(mg, ...)` | TraceQL streaming |
| 74 | 133 | `ualert.AddReceiverActionScopesMigration(mg)` | Receiver action scopes |
| 75 | 135 | `ualert.AddRuleMetadata(mg)` | Rule metadata |
| 76 | 137 | `accesscontrol.AddOrphanedMigrations(mg)` | Orphaned permission cleanup |
| 77 | 139 | `accesscontrol.AddActionSetPermissionsMigrator(mg)` | Action set permissions |
| 78 | 141 | `externalsession.AddMigration(mg)` | `external_session` |
| 79 | 143 | `accesscontrol.AddReceiverCreateScopeMigration(mg)` | Receiver create scope |

**Each function call may register multiple individual SQL migrations.** For example, `addUserMigrations` creates the user table and adds multiple index and column-addition migrations. The actual number of individual SQL operations is significantly higher than 79.

The `migration_log` table (created by step 1 — `mg.AddCreateMigration()`) stores every applied migration by its unique ID. On subsequent runs, the migrator reads this table and **skips** already-applied migrations.

---

## 4. Default Admin Account Provisioning

### 4.1 Admin User Creation Path

> **Source:** `pkg/services/sqlstore/sqlstore.go`, `ensureMainOrgAndAdminUser()` — lines 190–235

This function is called from `Reset()` (line 158), which is called by `ProvideService()` (line 73) during Wire initialization.

```
ensureMainOrgAndAdminUser(test=false)
├── line 192: Opens transactional DB session
├── lines 196-207: USER COUNT CHECK
│   ├── line 200: SELECT COUNT(id) AS Count FROM "user"
│   ├── line 204: if stats.Count > 0 → return nil  ← SUBSEQUENT-RUN EXIT
│   └── (count == 0 → continue to creation)
├── lines 209-223: ADMIN USER CREATION (if !DisableInitAdminCreation)
│   ├── line 213: ss.createUser(ctx, sess, CreateUserCommand{
│   │     Login: ss.cfg.AdminUser,        // default: "admin"
│   │     Email: ss.cfg.AdminEmail,        // default: "admin@localhost"
│   │     Password: ss.cfg.AdminPassword,  // default: "admin"
│   │     IsAdmin: true,
│   │   })
│   └── line 222: logs "Created default admin"
└── lines 225-228: DEFAULT ORG CREATION
    ├── line 226: ss.getOrCreateOrg(sess, mainOrgName)  // mainOrgName = "Main Org."
    └── line 230: logs "Created default organization"
```

**Rationale:** The **user count check at line 204** is the critical gate that distinguishes first-run from subsequent-run behavior. On first run, `COUNT(id)` returns 0 → creation proceeds. On any subsequent run where at least one user exists, the function returns immediately without creating anything.

### 4.2 createUser() Detail

> **Source:** `pkg/services/sqlstore/user.go`, lines 42–131

The `createUser()` function performs these steps:

1. **Get or create org** (line 44): `ss.getOrgIDForNewUser(sess, args)` — for the admin user with `AutoAssignOrg=true` (default), this resolves to org ID 1.
2. **Duplicate check** (lines 53–63): `LOWER(email)=LOWER(?) OR LOWER(login)=LOWER(?)` — prevents duplicate users.
3. **User struct creation** (lines 66–75):
   - `UID`: generated via `util.GenerateShortUID()` (line 67)
   - `Email`: `admin@localhost` (lowercased)
   - `Login`: `admin` (lowercased)
   - `IsAdmin`: `true`
   - `OrgID`: `1`
4. **Password hashing** (lines 77–94):
   - `salt`: 10 random characters via `util.GetRandomString(10)` (line 77)
   - `rands`: 10 random characters (line 82)
   - `password`: `util.EncodePassword("admin", salt)` (line 89) — PBKDF2-based hashing
5. **Insert user** (line 98): `sess.Insert(&usr)` — writes to `user` table
6. **Org membership** (lines 110–128): Creates `org.OrgUser` with:
   - `OrgID`: 1
   - `UserID`: the new user's ID
   - `Role`: `org.RoleAdmin` (line 113)

### 4.3 getOrCreateOrg() Detail

> **Source:** `pkg/services/sqlstore/user.go`, lines 145–193

The constant `mainOrgName` is defined at line 16: `const mainOrgName = "Main Org."`

With `AutoAssignOrg` enabled (default `true`) and `AutoAssignOrgId` = 1 (default):

1. Checks if org with `ID=1` exists (line 149)
2. If not found (first run): Creates org with `Name: "Main Org."`, `ID: 1` (lines 165–176)
3. If found (subsequent run): Returns existing org ID (line 154)

---

## 5. Security Posture of Defaults

### 5.1 Security-Relevant Default Settings

All values verified directly from `conf/defaults.ini` with line numbers:

| Feature | INI Setting | Default | Line | Security Impact |
|---------|------------|---------|------|-----------------|
| Admin username | `[security] admin_user` | `admin` | 328 | **Well-known** default credential |
| Admin password | `[security] admin_password` | `admin` | 331 | **Well-known** default credential — must be changed |
| Admin email | `[security] admin_email` | `admin@localhost` | 334 | Default placeholder email |
| Initial admin creation | `[security] disable_initial_admin_creation` | `false` | 325 | Admin user **IS** created automatically |
| Anonymous access | `[auth.anonymous] enabled` | `false` | 650 | Anonymous access is **DISABLED** |
| Built-in login | `[auth] disable_login` | `false` | 564 | Built-in login is **ENABLED** |
| Login form | `[auth] disable_login_form` | `false` | 576 | Login form is **SHOWN** |
| Brute-force protection | `[security] disable_brute_force_login_protection` | `false` | 352 | Brute-force protection is **ENABLED** |
| Brute-force threshold | `[security] brute_force_login_protection_max_attempts` | `5` | 355 | 5 failed attempts triggers lockout |
| HSTS | `[security] strict_transport_security` | `false` | 368 | HSTS is **DISABLED** |
| CSP | `[security] content_security_policy` | `false` | 390 | CSP is **DISABLED** |
| CSP Report-Only | `[security] content_security_policy_report_only` | `false` | 399 | CSP report-only is **DISABLED** |
| X-Content-Type-Options | `[security] x_content_type_options` | `true` | 382 | **ENABLED** — prevents MIME sniffing |
| X-XSS-Protection | `[security] x_xss_protection` | `true` | 386 | **ENABLED** — XSS filter |
| Cookie Secure flag | `[security] cookie_secure` | `false` | 358 | Not set (appropriate for HTTP default) |
| Cookie SameSite | `[security] cookie_samesite` | `lax` | 361 | Lax SameSite policy |
| Allow embedding | `[security] allow_embedding` | `false` | 364 | iframe embedding **BLOCKED** (X-Frame-Options: deny) |
| Angular support | `[security] angular_support_enabled` | `false` | 407 | Legacy Angular plugins **DISABLED** |
| CSRF always check | `[security] csrf_always_check` | `false` | 410 | CSRF check only when login cookie present |
| Gravatar | `[security] disable_gravatar` | `false` | 346 | Gravatar **ENABLED** (external image requests) |

### 5.2 Authentication Methods Active by Default

On a clean install, the **ONLY active authentication method** is built-in username/password login. The following are all **disabled** by default:

- **OAuth** (GitHub, GitLab, Google, Azure AD, Okta, Generic OAuth) — each requires explicit `enabled = true` in its `[auth.*]` section
- **LDAP** — requires `[auth.ldap] enabled = true` and a valid `ldap.toml`
- **JWT** — requires `[auth.jwt] enabled = true`
- **Auth Proxy** — requires `[auth.proxy] enabled = true`
- **SAML** — enterprise-only, requires explicit configuration
- **Anonymous access** — `[auth.anonymous] enabled = false` (line 650)

**Rationale:** The security defaults favor a "secure by default" posture for authentication. A clean install exposes only the login form with username/password authentication. However, the default admin credentials (`admin`/`admin`) represent a known weakness that must be changed immediately in production.

---

## 6. Plugin Discovery and Classification

### 6.1 Plugin Source Assembly

> **Source:** `pkg/plugins/manager/sources/sources.go`

The `List()` method (lines 24–32) assembles plugin sources in this exact order:

```go
func (s *Service) List(_ context.Context) []plugins.PluginSource {
    r := []plugins.PluginSource{
        NewLocalSource(plugins.ClassCore, corePluginPaths(s.cfg.StaticRootPath)),     // 1. Core
        NewLocalSource(plugins.ClassBundled, []string{s.cfg.BundledPluginsPath}),      // 2. Bundled
    }
    r = append(r, s.externalPluginSources()...)  // 3. External
    r = append(r, s.pluginSettingSources()...)    // 4. Plugin settings
    return r
}
```

**Source categories:**

| # | Class | Source | Default Path | Contents on Clean State |
|---|-------|--------|-------------|------------------------|
| 1 | `ClassCore` | `corePluginPaths()` (line 64–68) | `public/app/plugins/datasource/` + `public/app/plugins/panel/` | 54 core plugins |
| 2 | `ClassBundled` | `BundledPluginsPath` | `plugins-bundled/` | **Empty** (`external.json` has `{"plugins": []}`) |
| 3 | `ClassExternal` | `externalPluginSources()` (line 34–47) | `data/plugins/` | **Empty** (no external plugins installed) |
| 4 | Plugin settings | `pluginSettingSources()` (line 49–61) | `[plugin.*]` INI sections with `path` keys | **None** (no plugin settings configured) |

The `corePluginPaths()` function (lines 64–68) returns:
```go
func corePluginPaths(staticRootPath string) []string {
    datasourcePaths := filepath.Join(staticRootPath, "app/plugins/datasource")
    panelsPath := filepath.Join(staticRootPath, "app/plugins/panel")
    return []string{datasourcePaths, panelsPath}
}
```

### 6.2 Core Plugins List

#### Core Datasource Plugins (22 plugins)

From `public/app/plugins/datasource/` directory:

| # | Plugin ID |
|---|-----------|
| 1 | `alertmanager` |
| 2 | `azuremonitor` |
| 3 | `cloud-monitoring` |
| 4 | `cloudwatch` |
| 5 | `dashboard` |
| 6 | `elasticsearch` |
| 7 | `grafana` |
| 8 | `grafana-postgresql-datasource` |
| 9 | `grafana-pyroscope-datasource` |
| 10 | `grafana-testdata-datasource` |
| 11 | `graphite` |
| 12 | `influxdb` |
| 13 | `jaeger` |
| 14 | `loki` |
| 15 | `mixed` |
| 16 | `mssql` |
| 17 | `mysql` |
| 18 | `opentsdb` |
| 19 | `parca` |
| 20 | `prometheus` |
| 21 | `tempo` |
| 22 | `zipkin` |

#### Core Panel Plugins (32 plugins)

From `public/app/plugins/panel/` directory:

| # | Plugin ID |
|---|-----------|
| 1 | `alertlist` |
| 2 | `annolist` |
| 3 | `barchart` |
| 4 | `bargauge` |
| 5 | `candlestick` |
| 6 | `canvas` |
| 7 | `dashlist` |
| 8 | `datagrid` |
| 9 | `debug` |
| 10 | `flamegraph` |
| 11 | `gauge` |
| 12 | `geomap` |
| 13 | `gettingstarted` |
| 14 | `graph` |
| 15 | `heatmap` |
| 16 | `histogram` |
| 17 | `live` |
| 18 | `logs` |
| 19 | `news` |
| 20 | `nodeGraph` |
| 21 | `piechart` |
| 22 | `stat` |
| 23 | `state-timeline` |
| 24 | `status-history` |
| 25 | `table` |
| 26 | `table-old` |
| 27 | `text` |
| 28 | `timeseries` |
| 29 | `traces` |
| 30 | `trend` |
| 31 | `welcome` |
| 32 | `xychart` |

**Total: 54 core plugins** (22 datasource + 32 panel).

### 6.3 Bundled Plugins

> **Source:** `plugins-bundled/external.json`

```json
{
  "plugins": []
}
```

The bundled plugins manifest is **empty**. No bundled plugins are shipped.

### 6.4 External Plugins

On first run, the `data/plugins/` directory either does not exist or is empty. No external plugins are present.

### 6.5 Preinstall Plugins

> **Source:** `pkg/setting/setting_plugins.go`, lines 29–33

```go
var defaultPreinstallPlugins = map[string]InstallPlugin{
    "grafana-lokiexplore-app": {"grafana-lokiexplore-app", "", ""},
}
```

The only default preinstall plugin is **`grafana-lokiexplore-app`** (the Loki Explore app). Unless `[plugins] preinstall_disabled = true` is set, Grafana will attempt to install this plugin at startup. This is **network-dependent** — if the instance has no internet access, the preinstall will fail but the server will continue starting.

The preinstall behavior is controlled in `readPluginSettings()` (lines 36–95): if `preinstall_disabled` is `false` (default), the `defaultPreinstallPlugins` map is merged with any user-configured preinstall plugins, and disabled plugins are removed from the list.

### 6.6 Plugin Loading Pipeline

> **Source:** `pkg/plugins/manager/loader/loader.go`

The `Load()` method (lines 55–104) processes plugins through a four-stage pipeline:

```
Load(ctx, src)
├── 1. DISCOVERY: l.discovery.Discover(ctx, src)          → []FoundBundle
│   Finds plugin.json files on the filesystem
├── 2. BOOTSTRAP: l.bootstrap.Bootstrap(ctx, src, bundle)  → []*Plugin
│   Constructs runtime plugin objects from discovered bundles
├── 3. VALIDATION: l.validation.Validate(ctx, plugin)      → error
│   Validates plugin signatures and compatibility
└── 4. INITIALIZATION: l.initializer.Initialize(ctx, plugin) → *Plugin
    Finalizes plugin loading and registers them
```

Errors at any stage cause the individual plugin to be skipped (recorded in the error tracker) while other plugins continue loading.

The `pluginstore.ProvideService()` (from `pkg/services/pluginsintegration/pluginstore/store.go`, lines 32–53) orchestrates this by iterating all sources from `pluginSources.List(ctx)` and calling `pluginLoader.Load(ctx, ps)` for each source.

**Rationale:** The plugin architecture uses a multi-source, multi-stage design so that core plugins (compiled into the frontend static assets), bundled plugins (shipped alongside but separately from the core), and external plugins (installed by users) all flow through the same discovery-bootstrap-validation-initialization pipeline. This uniform pipeline ensures that all plugins — regardless of origin — undergo the same signature verification and compatibility checks. The `List()` method in `sources.go` establishes a fixed evaluation order (core → bundled → external → plugin-settings) so that core plugins are always discovered first and cannot be overridden by external plugins with conflicting IDs. On a clean first run, only the 54 core plugins are discovered since the bundled manifest is empty and no external plugins have been installed.

---

## 7. Background Service Lifecycle

> **Source:** `pkg/server/server.go`, `Run()` — lines 146–179

The `backgroundServices` list is populated during `newServer()` (line 80):
```go
backgroundServices: backgroundServiceProvider.GetServices(),
```

The service launch loop (lines 148–174):

```go
for _, svc := range services {
    if registry.IsDisabled(svc) {
        continue                           // Line 151: SILENTLY SKIPPED
    }

    service := svc
    serviceName := reflect.TypeOf(service).String()
    s.childRoutines.Go(func() error {
        select {
        case <-s.context.Done():
            return s.context.Err()
        default:
        }
        s.log.Debug("Starting background service", "service", serviceName)  // Line 162
        err := service.Run(s.context)                                       // Line 163
        if err != nil && !errors.Is(err, context.Canceled) {
            s.log.Error("Stopped background service", "service", serviceName, "reason", err)
            return fmt.Errorf("%s run error: %w", serviceName, err)
        }
        s.log.Debug("Stopped background service", "service", serviceName, "reason", err)
        return nil
    })
}
```

**Key behaviors:**
1. **Disabled services are silently skipped** — no log output is generated for disabled services at this level (line 150–151).
2. **Each enabled service runs in its own goroutine** via the errgroup (line 156).
3. **Context cancellation is checked first** (lines 157–160) — if the context is already done (e.g., during rapid shutdown), the goroutine exits immediately.
4. **Errors are selective** — `context.Canceled` errors are explicitly ignored (line 167) to prevent masking more interesting errors from other services.
5. **After all services launch**, the `READY=1` systemd notification is sent (line 176).
6. **`Wait()`** blocks until all goroutines exit (line 179) — returns the first non-nil error from any service.

**Rationale:** The errgroup pattern ensures that if any background service returns a non-nil, non-canceled error, the entire server eventually shuts down. The first error is propagated to the caller of `Run()`, which is the main goroutine in `RunServer()`.

---

## 8. First-Run vs. Subsequent-Run Behavioral Differences

### 8.1 Database File Creation

> **Source:** `pkg/services/sqlstore/sqlstore.go`, `initEngine()` — lines 256–283

| Aspect | First Run | Subsequent Run |
|--------|-----------|----------------|
| **File check** | `fs.Exists(ss.dbCfg.Path)` returns `false` (line 258) | Returns `true` |
| **Action** | `os.OpenFile(path, os.O_CREATE\|os.O_RDWR, 0640)` (line 266) | `os.Lstat(path)` + permission check (line 274) |
| **Log output** | `"Creating SQLite database file"` (line 265) | No creation log; may warn if permissions are too broad (line 280) |
| **Permissions** | File created with **0640** | Existing permissions checked against 0640 |

### 8.2 Migration Deduplication

> **Source:** `pkg/services/sqlstore/migrations/migrations.go` and `pkg/services/sqlstore/migrator/`

| Aspect | First Run | Subsequent Run |
|--------|-----------|----------------|
| **migration_log table** | Created by `mg.AddCreateMigration()` (first migration) | Already exists |
| **Migration check** | Up to 79 migration groups execute (78 unconditional + 1 conditional on `FlagAnnotationPermissionUpdate`); each records its ID in `migration_log` | Migrator reads `migration_log`, finds all previously applied migrations, **skips them** |
| **New migrations** | N/A | Only newly added migrations (from version upgrades) execute |
| **Table creation** | All tables created from scratch | Tables already exist, skipped |

### 8.3 Admin User Creation Gate

> **Source:** `pkg/services/sqlstore/sqlstore.go`, `ensureMainOrgAndAdminUser()` — lines 190–235

| Aspect | First Run | Subsequent Run |
|--------|-----------|----------------|
| **User count query** | `SELECT COUNT(id) FROM "user"` returns **0** (line 200–201) | Returns **> 0** |
| **Gate result** | `stats.Count == 0` → creation proceeds (line 204) | `stats.Count > 0` → **returns immediately** (line 204–206) |
| **Admin user** | Created: `admin`/`admin`/`admin@localhost`, `IsAdmin=true` | **Not created** — function exits early |
| **Main Org.** | Created: `"Main Org."`, `ID=1` | **Not created** — function exits early |
| **Org membership** | `org_user` row: admin → Main Org. with `RoleAdmin` | **Not created** |

### 8.4 Summary Table

| Behavior | First Run | Subsequent Run |
|----------|-----------|----------------|
| SQLite file `data/grafana.db` | **Created** with permission 0640 | Verified; permissions checked |
| Database migrations | **Up to 79 groups execute** (78 unconditional + 1 conditional on `FlagAnnotationPermissionUpdate`); tables created | Only new migrations run; `migration_log` consulted |
| Admin user (`admin`/`admin`) | **Created** with hashed password | **Skipped** (user count > 0) |
| Main Org. (`"Main Org."`, ID=1) | **Created** | **Skipped** |
| `migration_log` entries | **Populated** with all migration IDs | Consulted; updated only for new migrations |
| Provisioning | Scans `conf/provisioning/` YAML files (all commented-out samples) | Same behavior — re-scans provisioning files |
| Plugin discovery | Discovers 54 core plugins + empty bundled/external | Same behavior — re-discovers all plugins |

**Rationale:** The behavioral differences between first-run and subsequent-run are deliberately minimal — Grafana is designed so that restart is safe and idempotent. The three key idempotency mechanisms are: (1) the user-count check in `ensureMainOrgAndAdminUser()` (line 200–204 of `sqlstore.go`), which gates admin/org creation on whether any user already exists; (2) the `migration_log` table, which records every applied migration by its unique string ID so that already-applied migrations are skipped on subsequent runs; and (3) the SQLite file-existence check in `initEngine()` (line 258), which switches from creation mode to verification mode. These three gates ensure that a restart never duplicates users, re-applies migrations, or overwrites the database file — making the startup sequence safe to repeat without data corruption or side effects.

---

## 9. Build Artifact Dependencies

### 9.1 Go Binary Compilation

> **Source:** `Makefile` (lines 186–193)

```makefile
build-go: gen-go update-workspace ## Build all Go binaries.
	@echo "build go files with updated workspace"
	$(GO) run build.go $(GO_BUILD_FLAGS) build

build-go-fast: gen-go ## Build all Go binaries.
	@echo "build go files"
	$(GO) run build.go $(GO_BUILD_FLAGS) build
```

- `make build-go` runs `go run build.go build` — produces binaries in `./bin/` (including `grafana` and `grafana-server`).
- `make build-go-fast` — same but skips workspace update.
- Wire dependency injection tags: `WIRE_TAGS = "oss"` (Makefile line 5).
- Go version: **1.23.1** (per `go.mod`).
- Wire generation **must run before** Go compilation: `go run ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server` (Makefile line 169) produces `pkg/server/wire_gen.go`.

### 9.2 Frontend Build

> **Source:** `package.json` (lines 9, 43)

```json
"build": "NODE_ENV=production nx exec --verbose -- webpack --config scripts/webpack/webpack.prod.js --progress"
"start": "NODE_ENV=dev nx exec -- webpack --config scripts/webpack/webpack.dev.js --watch"
```

- `yarn build` — production frontend build, output to `public/build/`.
- `yarn start` — development webpack server with watch mode and hot reload.

**Critical dependency:** `pkg/setting/setting.go` `validateStaticRootPath()` (lines 1034–1044) checks for the `public/build` directory at startup:

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

**Rationale:** The server **will still start** without built frontend assets, but the UI will be broken — all pages will fail to render JavaScript. The `validateStaticRootPath()` function only logs an error, it does not prevent startup.

### 9.3 Development Runner (Bra)

> **Source:** `.bra.toml`

Bra is the development hot-reload runner. Its configuration:

**Initial commands** (lines 2–6):
1. `GO_BUILD_DEV=1 make build-go` — compile Go binary with dev flag
2. `make gen-jsonnet` — generate Jsonnet dashboards
3. `./bin/grafana server -profile -profile-addr=127.0.0.1 -profile-port=6000 -profile-block-rate=1 -profile-mutex-rate=5 -packaging=dev cfg:app_mode=development`

**Watch directories** (lines 9–14):
- `$WORKDIR/pkg` — all Go source files
- `$WORKDIR/public/views` — HTML templates
- `$WORKDIR/conf` — configuration files
- `$WORKDIR/devenv/dev-dashboards` — development dashboards

**Watch extensions** (line 15): `.go`, `.ini`, `.toml`, `.template.html`

**On file change** (lines 18–22):
1. `GO_BUILD_DEV=1 make build-go-fast` — fast rebuild
2. `make gen-jsonnet`
3. Re-launch server with same flags

**`app_mode=development`** enables development-specific features such as more verbose logging, development-only API endpoints, and relaxed security checks.

---

## Appendix: File Reference Index

All source files cited in this document, organized by topic:

| Topic | File | Key Functions/Sections |
|-------|------|----------------------|
| Binary entrypoint | `pkg/cmd/grafana-server/main.go` | `main()` |
| Startup orchestration | `pkg/cmd/grafana-server/commands/cli.go` | `ServerCommand()`, `RunServer()` |
| CLI flags | `pkg/cmd/grafana-server/commands/flags.go` | `commonFlags` |
| Server lifecycle | `pkg/server/server.go` | `New()`, `newServer()`, `Init()`, `Run()`, `Shutdown()` |
| Service registry | `pkg/registry/registry.go` | `IsDisabled()`, `CanBeDisabled`, `BackgroundService` |
| Config loading | `pkg/setting/setting.go` | `NewCfgFromArgs()`, `Load()`, `loadConfiguration()` |
| Plugin settings | `pkg/setting/setting_plugins.go` | `defaultPreinstallPlugins`, `readPluginSettings()` |
| Default config | `conf/defaults.ini` | All default values |
| SQLStore lifecycle | `pkg/services/sqlstore/sqlstore.go` | `ProvideService()`, `initEngine()`, `Migrate()`, `ensureMainOrgAndAdminUser()` |
| Database config | `pkg/services/sqlstore/database_config.go` | `readConfig()`, `buildConnectionString()` |
| User/org creation | `pkg/services/sqlstore/user.go` | `createUser()`, `getOrCreateOrg()`, `mainOrgName` |
| Migrations | `pkg/services/sqlstore/migrations/migrations.go` | `AddMigration()` (79 migration groups) |
| Plugin sources | `pkg/plugins/manager/sources/sources.go` | `List()`, `corePluginPaths()` |
| Plugin loader | `pkg/plugins/manager/loader/loader.go` | `Load()` pipeline |
| Plugin store | `pkg/services/pluginsintegration/pluginstore/store.go` | `ProvideService()` |
| Provisioning | `pkg/services/provisioning/provisioning.go` | `RunInitProvisioners()` |
| Bundled plugins | `plugins-bundled/external.json` | Empty plugins array |
| Build system | `Makefile` | `build-go`, `build-go-fast` |
| Dev runner | `.bra.toml` | Init commands, watch dirs |
| Frontend build | `package.json` | `build`, `start` scripts |
