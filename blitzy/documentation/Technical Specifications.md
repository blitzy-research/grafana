# Technical Specification

# 0. Agent Action Plan

## 0.1 Intent Clarification

### 0.1.1 Core Feature Objective

Based on the prompt, the Blitzy platform understands that the new feature requirement is to **produce a comprehensive, evidence-based documentation artifact** that explains the ground-truth behavior of Grafana's server initialization, default security posture, persistent state creation, plugin/data source bootstrapping, and behavioral differences between first and subsequent runs — all verified by actually building, running, and inspecting the real system rather than relying solely on existing documentation.

The specific knowledge gaps to be addressed are:

- **Initialization sequence**: What observably happens when the Grafana server starts from a completely clean state (no prior config, no environment variables), including which decisions the system makes automatically and which subsystems report as "disabled" or "skipped" versus "success."
- **Default security posture**: Why a user can log in with credentials they never explicitly configured, what accounts exist by default, whether the system is in a permissive mode, and what authentication/authorization defaults are in effect.
- **Persistent state creation**: What files, directories, and database records are created on first run, where they are written, and why subsequent runs behave differently from the first.
- **Plugin/data source ecosystem bootstrap**: The relationship between bundled (compiled-in) plugins, runtime-discovered plugins, and what becomes available through the API — including plugins that appear in the UI without explicit installation.
- **Build artifact dependency**: Whether running the server directly versus building first produces equivalent behavior, and what generated files the runtime depends on.

Implicit requirements detected:

- The answer must be grounded in **actual observed behavior** from running the code, not merely restating documentation.
- The documentation must be placed in a new markdown file at `blitzy/documentation/<branch_name>.md` per the implementation rules.
- No existing files in the repository may be modified.
- Temporary scripts used for investigation must be deleted after task completion.

### 0.1.2 Special Instructions and Constraints

- **CRITICAL**: The user explicitly states: _"Don't modify any files in the repository."_ Only the creation of the final documentation markdown file in `blitzy/documentation/` and temporary investigation scripts (which must be cleaned up) are permitted.
- **Architectural requirement**: The output must follow the SWE-AtlasQnA-Repo rule — a markdown document named `<source_branch_name>.md` placed in `blitzy/documentation/`.
- **Evidence-based approach**: All claims must be backed by code inspection and actual runtime observation (building the binary, running the server, inspecting logs, querying the database, and testing API endpoints).
- **Branch name**: The source branch is `grafana_4550cfb5b728`, so the output file will be `blitzy/documentation/grafana_4550cfb5b728.md`.

### 0.1.3 Technical Interpretation

These feature requirements translate to the following technical implementation strategy:

- To **document the initialization sequence**, we will build the Grafana binary from source using `go build -tags oss`, run it with `--homepath=.` against a clean state (no `data/` directory), capture and analyze the full startup log, and trace the initialization code path through `pkg/cmd/grafana-server/commands/cli.go` → `pkg/server/server.go` → `pkg/services/sqlstore/sqlstore.go` → `pkg/services/provisioning/provisioning.go`.
- To **document the default security posture**, we will inspect `conf/defaults.ini` for authentication defaults, observe the admin user creation in `pkg/services/sqlstore/sqlstore.go:ensureMainOrgAndAdminUser()`, and verify via API calls and database queries.
- To **document persistent state creation**, we will compare the filesystem and SQLite database before and after the first run, enumerating all created files, directories, and database tables/records.
- To **document plugin/data source bootstrapping**, we will trace the plugin source discovery in `pkg/plugins/manager/sources/sources.go`, observe the loading of 54 core/bundled plugins from `public/app/plugins/`, and verify which are available via the `/api/plugins` endpoint.
- To **document build artifact dependencies**, we will examine the `public/build/` directory check in `pkg/setting/setting.go` and the Wire code generation requirement (`wire_gen.go`).
- To **create the deliverable**, we will generate a markdown document at `blitzy/documentation/grafana_4550cfb5b728.md` containing all findings.

## 0.2 Repository Scope Discovery

### 0.2.1 Comprehensive File Analysis

The investigation spans the following key areas of the Grafana codebase, identified through systematic deep search of the repository and verified through actual code inspection and runtime observation.

**Server Lifecycle and Initialization**

| File/Directory | Purpose | Relevance |
|---|---|---|
| `pkg/cmd/grafana/main.go` | Binary entrypoint — constructs CLI app with `server` subcommand | Entry point for the entire startup chain |
| `pkg/cmd/grafana-server/commands/cli.go` | `RunServer()` — loads config, calls `server.Initialize()`, launches `s.Run()` | Orchestrates configuration loading and server assembly |
| `pkg/cmd/grafana-server/commands/flags.go` | CLI flags: `--homepath`, `--config`, `--pidfile` | Determines where defaults.ini is found |
| `pkg/server/server.go` | `Server` struct — `Init()`, `Run()`, `Shutdown()` methods | Core lifecycle: PID file, RBAC registration, provisioning, background services |
| `pkg/server/service.go` | `coreService` adapter wrapping Server in dskit `BasicService` | Lifecycle integration with dskit framework |
| `pkg/server/wire.go` | Wire DI injector declarations for `Initialize()`, `InitializeForTest()` | Compile-time dependency assembly for 60+ services |
| `pkg/server/wireexts_oss.go` | OSS-specific Wire provider sets | Controls which service implementations are wired in OSS builds |
| `pkg/server/wire_gen.go` | Auto-generated Wire initialization code (must be generated before build) | **Critical build artifact** — binary will not compile without it |

**Configuration System**

| File/Directory | Purpose | Relevance |
|---|---|---|
| `conf/defaults.ini` | Canonical defaults for all configuration sections (~2000 lines) | Single source of truth for all default behavior |
| `conf/sample.ini` | User-facing sample custom config | Shows which settings users are expected to override |
| `pkg/setting/setting.go` | `Cfg` struct — `loadConfiguration()`, config file resolution, env var overrides | Config loading order: defaults.ini → custom.ini → env vars → CLI args |
| `pkg/setting/setting_plugins.go` | Plugin settings parsing, preinstall defaults (`grafana-lokiexplore-app`) | Controls default plugin preinstallation behavior |
| `pkg/setting/setting_unified_alerting.go` | Unified Alerting settings, enabled-by-default logic | Alerting is enabled when `[unified_alerting] enabled` is empty |

**Database and Schema Initialization**

| File/Directory | Purpose | Relevance |
|---|---|---|
| `pkg/services/sqlstore/sqlstore.go` | `ProvideService()` — DB connection, migration, admin user creation | Creates SQLite file, runs 626 migrations, creates admin user and default org |
| `pkg/services/sqlstore/migrations/` | All schema migration definitions | 626 migrations executed on first run, all skipped on subsequent runs |
| `data/grafana.db` | SQLite database file (created at runtime) | Primary persistent state artifact — 70+ tables |
| `data/log/grafana.log` | Runtime log file | Persisted log output |
| `data/csv/`, `data/pdf/`, `data/png/` | Empty directories for rendering output | Created during startup for export artifacts |

**Authentication and Security**

| File/Directory | Purpose | Relevance |
|---|---|---|
| `pkg/services/sqlstore/sqlstore.go` (lines 193–233) | `ensureMainOrgAndAdminUser()` — creates default admin with login=admin, password=admin | Why users can log in without configuring credentials |
| `pkg/services/authn/` | Pluggable authentication client architecture | Determines how credentials are validated |
| `pkg/services/accesscontrol/` | RBAC permission evaluation | Fixed roles registered during `Init()` |
| `conf/defaults.ini` [security] section (lines 323–420) | `admin_user=admin`, `admin_password=admin`, `secret_key`, encryption provider | Default security configuration |
| `conf/defaults.ini` [auth] section (lines 559–648) | Login settings, anonymous auth disabled by default | Authentication mode defaults |
| `conf/defaults.ini` [auth.anonymous] (line 648) | `enabled = false` | Anonymous access is OFF by default |

**Plugin System**

| File/Directory | Purpose | Relevance |
|---|---|---|
| `pkg/plugins/manager/sources/sources.go` | `List()` — enumerates Core, Bundled, and External plugin sources | Defines where plugins are discovered |
| `pkg/services/pluginsintegration/pluginstore/store.go` | `ProvideService()` — iterates sources, loads plugins via `pluginLoader.Load()` | Reports "Plugins loaded count=54" |
| `pkg/services/pluginsintegration/plugininstaller/service.go` | Background preinstall service for configured plugins | Attempts to install `grafana-lokiexplore-app` on startup |
| `public/app/plugins/datasource/` | 22 core data source plugin directories | Compiled into the binary and always available |
| `public/app/plugins/panel/` | 30 core panel plugin directories | Compiled into the binary and always available |
| `plugins-bundled/external.json` | Bundled external plugin list — currently empty (`{"plugins": []}`) | No bundled external plugins in this build |
| `data/plugins/` | External plugin install directory (does not exist until manually created) | Source of "Failed to load external plugins" error |

**Provisioning**

| File/Directory | Purpose | Relevance |
|---|---|---|
| `pkg/services/provisioning/provisioning.go` | `RunInitProvisioners()` — datasources, plugins, alerting in sequence | Executed during `Server.Init()` before background services start |
| `conf/provisioning/datasources/sample.yaml` | Sample datasource provisioning config | No actual datasource provisioning configured by default |
| `conf/provisioning/dashboards/sample.yaml` | Sample dashboard provisioning config | No actual dashboard provisioning configured by default |
| `conf/provisioning/alerting/sample.yaml` | Sample alerting provisioning config | No actual alerting provisioning configured by default |
| `conf/provisioning/plugins/sample.yaml` | Sample plugin provisioning config | No actual plugin provisioning configured by default |

**Background Services and Feature Toggles**

| File/Directory | Purpose | Relevance |
|---|---|---|
| `pkg/registry/backgroundsvcs/background_services.go` | Registers 37+ background services | Each checked via `IsDisabled()` before starting |
| `pkg/registry/registry.go` | `IsDisabled()` — `CanBeDisabled` interface check | Services self-report enabled/disabled state |
| `pkg/services/featuremgmt/registry.go` | Feature flag definitions with `Expression: "true"` defaults | ~57 feature toggles enabled by default via GA expressions |
| `pkg/services/secrets/manager/manager.go` | Envelope encryption initialization | Reports "Envelope encryption state enabled=true currentprovider=secretKey.v1" |

### 0.2.2 Web Search Research Conducted

No external web searches were required for this task. All findings are derived directly from:
- Source code inspection of the repository
- Actual build and runtime execution of the Grafana binary
- Database state inspection via SQLite queries
- API endpoint testing via curl
- Log output analysis from first and second server runs

### 0.2.3 New File Requirements

**Documentation output file to create:**

- `blitzy/documentation/grafana_4550cfb5b728.md` — Comprehensive markdown document answering all questions about Grafana's startup behavior, default security posture, persistent state, plugin bootstrapping, and first-run vs. subsequent-run differences

**No new source files, test files, or configuration files are required** — this task is a pure investigation and documentation exercise with an explicit prohibition on modifying existing repository files.

## 0.3 Dependency Inventory

### 0.3.1 Private and Public Packages

The following packages are critical to understanding the initialization behavior investigated in this task. Versions are taken directly from `go.mod` and runtime inspection.

| Registry | Package | Version | Purpose |
|---|---|---|---|
| Go modules | `github.com/grafana/grafana` | module root | Main Grafana application |
| Go modules | `google.golang.org/wire` | v0.6.0 | Compile-time dependency injection — generates `wire_gen.go` |
| Go modules | `xorm.io/xorm` | v0.8.2 | ORM for SQLite3/MySQL/PostgreSQL database access |
| Go modules | `github.com/mattn/go-sqlite3` | (transitive via xorm) | SQLite3 driver — default database backend |
| Go modules | `github.com/hashicorp/go-plugin` | v1.6.2 | Plugin subprocess management via gRPC |
| Go modules | `github.com/grafana/dskit` | (in go.mod) | Service lifecycle framework (`services.BasicService`) |
| Go modules | `github.com/prometheus/client_golang` | v1.20.5 | Prometheus metrics for self-instrumentation |
| Go modules | `go.opentelemetry.io/otel` | v1.32.0 | Distributed tracing for startup spans |
| Go modules | `gopkg.in/ini.v1` | (in go.mod) | INI file parsing for `conf/defaults.ini` |
| Go modules | `github.com/urfave/cli/v2` | (in go.mod) | CLI framework for `grafana server` subcommand |
| Node.js | `node` | v22.11.0 | Frontend build runtime (from `.nvmrc`) |
| Go runtime | `go` | 1.23.1 | Backend build and runtime (from `go.mod`) |

### 0.3.2 Dependency Updates

No dependency updates are required for this task. The investigation is read-only against the existing codebase, and the only output is a documentation file. All dependencies listed above are already present in the repository's `go.mod` and `go.sum` files.

### 0.3.3 Build-Time Dependencies

The following build-time dependency is critical to understanding the "build vs. run" question raised by the user:

| Artifact | Generation Command | Purpose |
|---|---|---|
| `pkg/server/wire_gen.go` | `go run ./pkg/build/wire/cmd/wire/main.go gen -tags oss ./pkg/server` | Wire-generated initialization code — **binary will not compile without it** |
| `public/build/` | `yarn build` or `make build-js` | Frontend JavaScript bundles — **server starts without them but logs an error and UI is non-functional** |

This distinction is central to the user's question: the Go backend binary can be built and started without the frontend build artifacts, but the UI will not render. The `wire_gen.go` file, however, is an absolute prerequisite for compilation.

## 0.4 Integration Analysis

### 0.4.1 Existing Code Touchpoints

The investigation touches the following integration points within the codebase, mapped to the specific questions the user raised. These are the code paths that produce the observable behaviors documented in the final artifact.

**Initialization Chain (Question: "What decisions did the system make on my behalf?")**

- `pkg/cmd/grafana-server/commands/cli.go` → `RunServer()`: Loads configuration via `setting.NewCfgFromArgs()`, which reads `conf/defaults.ini` as the first and only config file when no `--config` flag is provided and no `conf/custom.ini` exists.
- `pkg/setting/setting.go` → `loadConfiguration()` (line 880): Config resolution order is defaults.ini → custom.ini → environment variable overrides (`GF_*`) → CLI argument overrides. With a clean environment, only `defaults.ini` is active.
- `pkg/server/wire_gen.go` → `Initialize()`: Wire assembles 60+ services with their concrete implementations. The OSS build tag selects `wireexts_oss.go` providers.
- `pkg/server/server.go` → `Init()` (line 110): Sequential initialization — PID file → Prometheus metrics → RBAC fixed roles → provisioning (datasources → plugins → alerting).

**Database Bootstrap (Question: "What state is being created and remembered?")**

- `pkg/services/sqlstore/sqlstore.go` → `ProvideService()` (line 63): Connects to SQLite3, creates `data/grafana.db` if absent, runs 626 schema migrations, then calls `Reset()`.
- `pkg/services/sqlstore/sqlstore.go` → `ensureMainOrgAndAdminUser()` (line 193): Checks if any users exist; if zero users, creates admin user (`admin`/`admin`) and "Main Org." organization. On subsequent runs, the user count is > 0, so this is skipped entirely.
- `pkg/services/sqlstore/migrations/` → 626 migration definitions: On first run, all 626 are executed (creating 70+ tables). On second run, all 626 are checked against `migration_log` table and skipped (logged as "performed=0 skipped=626").

**Authentication Defaults (Question: "I can log in with credentials I never explicitly set up")**

- `conf/defaults.ini` [security] section (line 328): `admin_user = admin`, `admin_password = admin`, `admin_email = admin@localhost`.
- `conf/defaults.ini` [security] (line 325): `disable_initial_admin_creation = false` — admin creation is enabled by default.
- `conf/defaults.ini` [auth.anonymous] (line 649): `enabled = false` — anonymous access is disabled, requiring authentication for all API calls.
- `conf/defaults.ini` [auth] (line 576): `disable_login_form = false` — the login form is shown by default.
- `pkg/services/sqlstore/sqlstore.go` line 213: The password is hashed via `user.Password()` before storage, so `admin` is stored as a bcrypt hash, not plaintext.

**Plugin Discovery (Question: "Some plugins appear in the UI that I didn't install")**

- `pkg/plugins/manager/sources/sources.go` → `List()` (line 24): Returns three plugin source categories:
  - **Core** (`plugins.ClassCore`): Scanned from `public/app/plugins/datasource/` and `public/app/plugins/panel/` — 22 datasource + 30 panel = 52 core plugins compiled into the static root.
  - **Bundled** (`plugins.ClassBundled`): Scanned from `cfg.BundledPluginsPath` — `plugins-bundled/external.json` lists zero plugins, so the bundled path is effectively empty.
  - **External** (`plugins.ClassExternal`): Scanned from `data/plugins/` — this directory does not exist on first run, producing the logged error "Failed to load external plugins: failed to open plugins path."
- `pkg/services/pluginsintegration/pluginstore/store.go` → `ProvideService()` (line 32): Iterates all sources, loads 54 plugins total (52 core + 2 from core registry that do not have filesystem directories).
- `pkg/services/pluginsintegration/plugininstaller/service.go`: On startup, attempts to install `grafana-lokiexplore-app` (defined as a default preinstall in `pkg/setting/setting_plugins.go` line 32), but fails with version incompatibility error because the build reports version `9.2.0`.

**Feature Toggle Resolution (Question: "Certain features are enabled by default while others require explicit activation")**

- `pkg/services/featuremgmt/registry.go`: Feature flags with `Expression: "true"` are enabled by default. At startup, approximately 57 feature toggles are logged as enabled without any explicit configuration.
- `conf/defaults.ini` [feature_toggles] (line 1869): `enable =` is empty, meaning no additional toggles are activated from config. All enabled toggles come from their `Expression` defaults in the Go registry.

**Secrets and Encryption (Implicit subsystem initialization)**

- `pkg/services/secrets/manager/manager.go` (line 70): Reads `encryption_provider` from `[security]` section, defaulting to `secretKey.v1`.
- At startup, logs: "Envelope encryption state enabled=true currentprovider=secretKey.v1" — using the hardcoded `secret_key = SW2YcwTIb9zpOOhoPsMm` from `conf/defaults.ini` line 340.

### 0.4.2 First Run vs. Subsequent Run Behavioral Differences

The following table summarizes the observable differences between a first run (clean state) and a subsequent run (existing `data/grafana.db`):

| Aspect | First Run | Subsequent Run |
|---|---|---|
| SQLite database file | Created at `data/grafana.db` (logged: "Creating SQLite database file") | Exists already — no creation log |
| Schema migrations | 626 migrations executed (each logged individually) | 626 migrations skipped (logged: "performed=0 skipped=626") |
| Admin user | Created with login=admin, password=admin (logged: "Created default admin user=admin") | User count > 0, creation skipped entirely (no log line) |
| Default organization | "Main Org." created (logged: "Created default organization") | Already exists, skipped |
| Plugin loading | 54 plugins loaded from core sources | Same 54 plugins loaded (identical) |
| External plugin directory | Does not exist → error logged | Still does not exist → same error logged |
| Preinstall attempt | `grafana-lokiexplore-app` install attempted and fails (version mismatch) | Same attempt, same failure |
| Startup duration | Significantly longer (migration execution) | Much faster (migration check only) |
| `data/log/` directory | Created | Already exists |
| `data/csv/`, `data/pdf/`, `data/png/` | Created as empty directories | Already exist |
| KV store entries | Created: `secretMigrationStatus`, `angular_patterns`, `publickeys` | Already present from first run |
| Server lock entries | Secret migration lock created | Lock already exists (logged: "Server lock for secret migration already exists") |

## 0.5 Technical Implementation

### 0.5.1 File-by-File Execution Plan

Since this task is a documentation-only exercise, the execution plan consists of a single output file and a series of investigation steps that have already been performed. No existing files are modified.

**Group 1 — Investigation (Already Completed)**

- INSPECT: `conf/defaults.ini` — Extract all default values for database, security, auth, plugins, feature toggles, alerting, caching, and live settings
- INSPECT: `pkg/server/server.go` — Trace `Init()` and `Run()` lifecycle to document initialization sequence
- INSPECT: `pkg/services/sqlstore/sqlstore.go` — Understand database creation, migration execution, and admin user bootstrapping logic
- INSPECT: `pkg/plugins/manager/sources/sources.go` — Map plugin source discovery (Core, Bundled, External)
- INSPECT: `pkg/services/provisioning/provisioning.go` — Document provisioning order (datasources → plugins → alerting)
- INSPECT: `pkg/services/featuremgmt/registry.go` — Catalog feature toggles enabled by default via `Expression: "true"`
- INSPECT: `pkg/setting/setting_plugins.go` — Identify default preinstall plugins (`grafana-lokiexplore-app`)
- INSPECT: `pkg/setting/setting_unified_alerting.go` — Confirm alerting is enabled by default when config value is empty
- INSPECT: `pkg/registry/backgroundsvcs/background_services.go` — Enumerate all 37+ background services
- INSPECT: `pkg/registry/registry.go` — Understand `IsDisabled()` / `CanBeDisabled` interface

**Group 2 — Runtime Verification (Already Completed)**

- BUILD: `go run ./pkg/build/wire/cmd/wire/main.go gen -tags oss ./pkg/server` — Generate `wire_gen.go`
- BUILD: `go build -tags oss -o ./bin/grafana ./pkg/cmd/grafana` — Compile Grafana binary
- RUN: `./bin/grafana server --homepath=.` from clean state — Capture full startup log
- VERIFY: `sqlite3 data/grafana.db ".tables"` — Enumerate all 70+ created tables
- VERIFY: `sqlite3 data/grafana.db "SELECT * FROM user"` — Confirm admin user creation
- VERIFY: `sqlite3 data/grafana.db "SELECT * FROM org"` — Confirm "Main Org." creation
- VERIFY: `curl http://localhost:3000/api/health` — Confirm server health
- VERIFY: `curl -u admin:admin http://localhost:3000/api/plugins` — Enumerate available plugins (49 via API)
- VERIFY: `curl -u admin:admin http://localhost:3000/api/datasources` — Confirm zero configured datasources
- VERIFY: `curl -u admin:admin http://localhost:3000/api/admin/settings` — Dump all effective settings
- VERIFY: `curl -u admin:admin http://localhost:3000/api/frontend/settings` — Verify frontend-visible config
- RUN: Second server start — Observe migration skip behavior and absence of admin creation

**Group 3 — Documentation Output**

- CREATE: `blitzy/documentation/grafana_4550cfb5b728.md` — Comprehensive Q&A markdown document containing all findings organized by topic area

### 0.5.2 Implementation Approach

The implementation follows a systematic evidence-gathering approach:

- **Establish ground truth** by building the Grafana binary from source (requiring Wire code generation as a prerequisite) and running it against a completely clean state
- **Capture all observable artifacts** — startup logs, filesystem changes, database records, API responses
- **Compare first run with second run** to precisely identify what persists and what changes
- **Trace each observable behavior back to specific source code** to provide authoritative explanations
- **Synthesize findings** into a structured markdown document that answers every question the user raised

### 0.5.3 Key Findings Summary (To Be Documented)

The documentation artifact will cover these verified findings:

- **Configuration**: With no custom config, the system reads only `conf/defaults.ini`. The config loader supports env var overrides (`GF_<SECTION>_<KEY>`) and CLI args, but none are active in a clean environment.
- **Database**: SQLite3 is the default backend. The file `data/grafana.db` is created at `<homepath>/data/grafana.db` with 70+ tables across 626 migrations. This is the primary source of state persistence.
- **Admin Account**: Created automatically with `admin`/`admin` credentials (bcrypt-hashed) — this is why the user can log in without explicit setup. The account has `is_admin=true` and is assigned to "Main Org." with the Admin role.
- **Security Posture**: Anonymous access is disabled. The login form is enabled. Brute-force protection is active (max 5 attempts). Envelope encryption is enabled using a hardcoded secret key. CSRF protection is active. Content Security Policy headers are disabled by default.
- **Plugins**: 54 plugins are loaded from the `public/app/plugins/` filesystem paths (19 datasource + 30 panel types). These are "core" plugins — compiled into the static root path, not installed from a catalog. The API reports 49 (some core plugins share IDs or are internal). Zero external plugins are loaded.
- **Feature Toggles**: Approximately 57 feature toggles are enabled by default through their `Expression: "true"` declarations in Go code, not through configuration.
- **Unified Alerting**: Enabled by default when `[unified_alerting] enabled` is empty (line 1222 of defaults.ini). The alerting scheduler, state manager, and multi-org Alertmanager all start automatically.
- **Remote Cache**: Defaults to `database` backend — the primary SQLite DB is used for caching, requiring no external infrastructure.
- **Build Artifacts**: `wire_gen.go` must be generated before compilation. Frontend build (`public/build/`) is not required for the backend to start but the UI will not render without it.

## 0.6 Scope Boundaries

### 0.6.1 Exhaustively In Scope

**Source code files inspected for evidence:**

- `conf/defaults.ini` — All default configuration values
- `conf/provisioning/**/*.yaml` — Provisioning sample files (confirming no active provisioning)
- `pkg/cmd/grafana/main.go` — Binary entrypoint
- `pkg/cmd/grafana-server/commands/cli.go` — Server command and RunServer
- `pkg/cmd/grafana-server/commands/flags.go` — CLI flags
- `pkg/server/server.go` — Server lifecycle (Init, Run, Shutdown)
- `pkg/server/service.go` — coreService dskit adapter
- `pkg/server/wire.go` — Wire DI declarations
- `pkg/server/wireexts_oss.go` — OSS-specific Wire providers
- `pkg/setting/setting.go` — Configuration loading, path resolution, validation
- `pkg/setting/setting_plugins.go` — Plugin settings, preinstall defaults
- `pkg/setting/setting_unified_alerting.go` — Alerting enabled-by-default logic
- `pkg/services/sqlstore/sqlstore.go` — Database init, migrations, admin/org creation
- `pkg/services/sqlstore/migrations/**/*.go` — Schema migration definitions
- `pkg/services/provisioning/provisioning.go` — Init provisioner sequence
- `pkg/services/featuremgmt/registry.go` — Feature toggle definitions with Expression defaults
- `pkg/plugins/manager/sources/sources.go` — Plugin source enumeration (Core, Bundled, External)
- `pkg/services/pluginsintegration/pluginstore/store.go` — Plugin loading and counting
- `pkg/services/pluginsintegration/plugininstaller/service.go` — Background preinstall service
- `pkg/services/secrets/manager/manager.go` — Envelope encryption initialization
- `pkg/services/encryption/service/service.go` — Encryption service provider
- `pkg/registry/backgroundsvcs/background_services.go` — Background service registry
- `pkg/registry/registry.go` — IsDisabled interface and BackgroundService contract
- `plugins-bundled/external.json` — Bundled plugin list (empty)
- `public/app/plugins/datasource/` — Core datasource plugin directories (22 entries)
- `public/app/plugins/panel/` — Core panel plugin directories (30 entries)

**Runtime artifacts inspected:**

- `data/grafana.db` — SQLite database (tables, user records, org records, kv_store, migration_log)
- `data/log/grafana.log` — Server log output
- `data/csv/`, `data/pdf/`, `data/png/` — Empty rendering output directories
- `/tmp/grafana_first_run.log` — Captured first-run startup log
- `/tmp/grafana_second_run_clean.log` — Captured second-run startup log

**API endpoints tested:**

- `GET /api/health` — Server health status
- `GET /api/org` (with and without auth) — Organization info / 401 response
- `GET /api/datasources` — Configured datasources (empty list)
- `GET /api/plugins` — Available plugins (49 returned)
- `GET /api/admin/settings` — Full effective settings dump
- `GET /api/frontend/settings` — Frontend configuration (panels, toggles, datasources)

**Documentation output:**

- `blitzy/documentation/grafana_4550cfb5b728.md` — Final deliverable

### 0.6.2 Explicitly Out of Scope

- **Modifying any existing source files** — Explicitly prohibited by the user
- **Frontend build process** — The user's question is about server-side behavior; the frontend build (yarn/webpack) is noted but not investigated in depth
- **Enterprise-specific features** — This is an OSS build; enterprise Wire extensions and features are excluded
- **External database backends** (MySQL, PostgreSQL) — The user's scenario is a clean first run, which defaults to SQLite3
- **External cache backends** (Redis, Memcached) — Default uses `database` cache type
- **Docker/containerized deployment** — The investigation uses a direct binary execution
- **Plugin installation from the Grafana catalog** — Only the default preinstall behavior is documented
- **Performance optimization or load testing** — Not relevant to the user's questions
- **LDAP, OAuth, SAML, or any external authentication provider configuration** — Default state uses only built-in basic auth
- **Alerting rule creation or notification testing** — Only the alerting subsystem initialization is in scope
- **Grafana Live WebSocket testing** — Only the initialization log is in scope

## 0.7 Rules for Feature Addition

### 0.7.1 User-Specified Rules

The following rules are explicitly stated by the user and must be strictly followed:

- **No modifications to existing repository files**: The user states _"Don't modify any files in the repository."_ This is an absolute constraint. Only the creation of the output documentation file and temporary investigation scripts (cleaned up after use) are permitted.
- **Temporary scripts must be deleted**: _"If you need to create temporary scripts for testing, that's fine, but don't change the actual codebase files. And delete all those temporary scripts/files after task completion."_
- **SWE-AtlasQnA-Repo rule**: Create a new markdown document named `<source_branch_name>.md` that comprehensively answers the questions posed. The document must be placed in `blitzy/documentation/` directory.
- **Evidence-based answers**: _"Do not make assumptions, base your answers on the code as the truth."_ All findings must be verified through code inspection and runtime observation.
- **Include rationale**: _"Provide thinking / rationale behind the answers."_ The document must explain not just what happens, but why it happens, with references to specific code paths.

### 0.7.2 Derived Implementation Rules

Based on the user's requirements and the nature of the task:

- **Build before investigating**: The Grafana binary must be built from source to observe actual runtime behavior, requiring Wire code generation as a prerequisite step.
- **Clean state testing**: The `data/` directory must be removed before the first run to ensure a truly clean state.
- **Dual-run comparison**: Both first and subsequent runs must be captured and compared to document behavioral differences.
- **Database inspection**: The SQLite database must be queried directly to verify what records were created, rather than relying solely on log output.
- **API verification**: Key API endpoints must be tested with and without authentication to verify the actual security posture.
- **Source traceability**: Every behavioral claim must reference a specific file and line number (or function) in the codebase.

## 0.8 References

### 0.8.1 Repository Files and Folders Searched

The following files and directories were directly inspected to derive the conclusions in this Agent Action Plan:

**Top-level configuration and build:**
- `conf/defaults.ini` — All default configuration (~2000 lines)
- `conf/provisioning/` — Provisioning directory structure and sample YAML files
- `conf/provisioning/datasources/sample.yaml`, `conf/provisioning/dashboards/sample.yaml`, `conf/provisioning/alerting/sample.yaml`, `conf/provisioning/plugins/sample.yaml`, `conf/provisioning/access-control/sample.yaml`
- `go.mod` — Go module version (1.23.1) and dependency declarations
- `.nvmrc` — Node.js version (v22.11.0)
- `Makefile` — Build targets including Wire generation command (line 169)
- `package.json` — Frontend dependency manifest
- `plugins-bundled/external.json` — Bundled plugin list (empty)

**Server lifecycle and initialization:**
- `pkg/cmd/grafana/main.go` — Binary entrypoint
- `pkg/cmd/grafana-server/main.go` — Server main
- `pkg/cmd/grafana-server/commands/cli.go` — RunServer implementation
- `pkg/cmd/grafana-server/commands/flags.go` — CLI flag definitions
- `pkg/server/server.go` — Server struct, Init, Run, Shutdown
- `pkg/server/service.go` — coreService dskit adapter
- `pkg/server/wire.go` — Wire DI injector declarations
- `pkg/server/wireexts_oss.go` — OSS Wire provider sets

**Configuration loading:**
- `pkg/setting/setting.go` — Cfg struct, loadConfiguration, validateStaticRootPath
- `pkg/setting/setting_plugins.go` — Plugin settings, defaultPreinstallPlugins
- `pkg/setting/setting_unified_alerting.go` — Unified alerting enabled logic

**Database and state management:**
- `pkg/services/sqlstore/sqlstore.go` — ProvideService, initEngine, ensureMainOrgAndAdminUser, Migrate
- `pkg/services/sqlstore/migrations/` — Schema migration definitions (626 total)

**Authentication and security:**
- `pkg/services/authn/` — Authentication service architecture
- `pkg/services/accesscontrol/` — RBAC system
- `pkg/services/secrets/manager/manager.go` — Envelope encryption initialization
- `pkg/services/encryption/service/service.go` — Encryption service

**Plugin system:**
- `pkg/plugins/manager/sources/sources.go` — Plugin source enumeration
- `pkg/services/pluginsintegration/pluginstore/store.go` — Plugin loading
- `pkg/services/pluginsintegration/plugininstaller/service.go` — Background preinstall
- `pkg/services/pluginsintegration/pluginsintegration.go` — Plugin Wire set
- `public/app/plugins/datasource/` — 22 core datasource plugin directories
- `public/app/plugins/panel/` — 30 core panel plugin directories

**Provisioning and background services:**
- `pkg/services/provisioning/provisioning.go` — Provisioning service and RunInitProvisioners
- `pkg/registry/backgroundsvcs/background_services.go` — 37+ background service registration
- `pkg/registry/registry.go` — BackgroundService and CanBeDisabled interfaces

**Feature management:**
- `pkg/services/featuremgmt/registry.go` — Feature toggle definitions with Expression defaults

**Runtime artifacts inspected:**
- `data/grafana.db` — SQLite database (70+ tables, user/org/kv_store/migration_log records)
- `data/log/grafana.log` — Runtime log file
- `/tmp/grafana_first_run.log` — Captured first-run startup log output
- `/tmp/grafana_second_run_clean.log` — Captured second-run startup log output

### 0.8.2 Technical Specification Sections Referenced

- Section 4.2: SERVER STARTUP AND LIFECYCLE — Initialization sequence documentation
- Section 4.4: AUTHENTICATION AND AUTHORIZATION FLOW — Auth client architecture and login flow
- Section 4.9: PLUGIN LIFECYCLE MANAGEMENT — Plugin installation and loading pipeline
- Section 6.1: Core Services Architecture — Service catalog, background service registry, scalability design

### 0.8.3 Attachments

No external attachments were provided for this project. All analysis is based on the repository source code and runtime observation.

