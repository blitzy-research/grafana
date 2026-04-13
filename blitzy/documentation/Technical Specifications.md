# Technical Specification

# 0. Agent Action Plan

## 0.1 Intent Clarification


### 0.1.1 Core Feature Objective

Based on the prompt, the Blitzy platform understands that the new feature requirement is to produce a comprehensive, code-evidenced reference document (`grafana_4550cfb5b728.md`) answering a new contributor's questions about the observable ground-truth behavior of a Grafana server when started from a completely clean state. Specifically, the document must address:

- **Initialization sequence ground truth** — What actually happens during `grafana-server` startup, based on the code in `pkg/server/server.go`, `pkg/cmd/grafana-server/commands/cli.go`, and `pkg/services/sqlstore/sqlstore.go`, rather than what the architecture documentation states in the abstract.
- **Default configuration resolution** — How `conf/defaults.ini` is loaded as the baseline, merged with optional `custom.ini` overrides and environment variables, and how the system determines data paths, database type, and subsystem states when no user configuration is provided (as implemented in `pkg/setting/setting.go`).
- **Automatic database creation and migration** — The fact that Grafana creates a SQLite database file (`data/grafana.db`) on first run, executes 40+ migration groups from `pkg/services/sqlstore/migrations/migrations.go`, and persists a `migration_log` table that alters subsequent-run behavior.
- **Default admin account provisioning** — That the `ensureMainOrgAndAdminUser` function in `pkg/services/sqlstore/sqlstore.go` (line 190+) creates an admin user with credentials `admin`/`admin` and a default organization named "Main Org." on first run, unless `disable_initial_admin_creation` is set.
- **Security posture of defaults** — That anonymous access is disabled (`[auth.anonymous] enabled = false`), built-in login is active, brute-force protection is enabled with a 5-attempt threshold, and HSTS/CSP are disabled by default.
- **Plugin discovery and classification** — How core plugins (compiled into `public/app/plugins/`), bundled plugins (from `plugins-bundled/`), and external plugins (from `data/plugins/`) are discovered via `pkg/plugins/manager/sources/sources.go` and loaded through the multi-stage pipeline in `pkg/plugins/manager/loader/`.
- **Background service lifecycle** — How enabled services launch as concurrent goroutines while disabled services are silently skipped via the `registry.IsDisabled` check in `pkg/server/server.go` (line 150).
- **First-run versus subsequent-run behavioral differences** — That the migration log and the user-count check in `ensureMainOrgAndAdminUser` cause the system to skip database initialization and admin creation on subsequent runs.
- **Build artifact dependencies** — That the Go binary must be compiled (`make build-go`), the frontend must be built or watched (`yarn start`), and certain runtime paths depend on generated files in `public/`.

### 0.1.2 Special Instructions and Constraints

- **CRITICAL: No file modifications** — The user explicitly states: "Don't modify any files in the repository." The implementation rule reinforces: "Do not modify any existing files in the source repository."
- **Output artifact** — Per the `SWE-AtlasQnA-Repo` rule, a single markdown document named `grafana_4550cfb5b728.md` must be created in the `blitzy/documentation` directory.
- **Evidence-based answers only** — The user requests factual explanations "based on real execution," not documentation summaries. All claims must trace to specific source files.
- **Temporary files permitted** — Temporary scripts for testing are allowed but must be deleted after task completion.
- **Thinking and rationale required** — The implementation rules require providing thinking/rationale behind the answers.

### 0.1.3 Technical Interpretation

These feature requirements translate to the following technical implementation strategy:

- To **answer the initialization question**, we will trace the call chain from `pkg/cmd/grafana-server/main.go` → `pkg/cmd/grafana-server/commands/cli.go` (`RunServer`) → `setting.NewCfgFromArgs` → `server.Initialize` → `Server.Init` → `Server.Run`, documenting each step with file paths and line references.
- To **explain the default configuration**, we will document the loading order in `pkg/setting/setting.go`: `conf/defaults.ini` → optional `custom.ini` → environment variable overrides → command-line overrides → placeholder expansion.
- To **explain database initialization**, we will trace `ProvideService` in `pkg/services/sqlstore/sqlstore.go` → `initEngine` (SQLite file creation) → `Migrate` (40+ migration groups) → `Reset` → `ensureMainOrgAndAdminUser`.
- To **clarify authentication defaults**, we will reference the `[security]` and `[auth]` sections of `conf/defaults.ini` and the admin user creation in `sqlstore.go`.
- To **explain the plugin ecosystem**, we will trace `pkg/plugins/manager/sources/sources.go` (`List` method) → discovery → bootstrap → validation → initialization pipeline.
- To **describe first-run vs. subsequent-run differences**, we will explain the user-count check (`SELECT COUNT(id) FROM user`) in `ensureMainOrgAndAdminUser` and the migration deduplication via `migration_log`.
- To **create the output document**, we will write `blitzy/documentation/grafana_4550cfb5b728.md` with comprehensive, cited answers.


## 0.2 Repository Scope Discovery


### 0.2.1 Comprehensive File Analysis

The following files and folders were examined to derive the answers for this Q&A documentation task. Since no source files are modified, this section catalogs the **read-only investigation scope** — every file whose contents informed the conclusions in the output document.

**Server Lifecycle and Startup Chain:**

| File / Folder | Purpose | Relevance |
|---|---|---|
| `pkg/cmd/grafana-server/main.go` | Executable entrypoint for the `grafana-server` binary | First code executed; delegates to command runner |
| `pkg/cmd/grafana-server/commands/cli.go` | `RunServer` function — startup orchestration, config loading, signal handling | Central startup path with logging, profiling, config creation |
| `pkg/cmd/grafana-server/commands/flags.go` | CLI flag definitions (config path, home path, PID file, version flags) | Determines how config overrides enter the system |
| `pkg/cmd/grafana/main.go` | Unified `grafana` binary entrypoint | Assembles CLI app with server + CLI commands |
| `pkg/server/server.go` | `Server` struct, `Init()`, `Run()`, `Shutdown()` lifecycle methods | Core initialization: PID file, metrics, RBAC roles, provisioners |
| `pkg/server/service.go` | `coreService` adapter wrapping `Server` in dskit `BasicService` | Bridges server to managed service framework |
| `pkg/server/module_server.go` | `ModuleServer` for target-specific launches | Alternative startup path for module-based deployments |
| `pkg/server/wire.go` | Google Wire dependency injection declarations | Assembles the full dependency graph for OSS builds |
| `pkg/registry/registry.go` | `BackgroundService`, `CanBeDisabled`, `IsDisabled` interfaces | Determines which services get started vs. skipped |

**Configuration Loading:**

| File / Folder | Purpose | Relevance |
|---|---|---|
| `conf/defaults.ini` | Canonical baseline configuration (1900+ lines) | The single source of truth for all default values |
| `conf/sample.ini` | Human-readable configuration reference | Documents available options |
| `conf/ldap.toml` | LDAP authentication template | Shows LDAP defaults (disabled by default) |
| `conf/provisioning/` | Provisioning sample YAML files (access-control, alerting, dashboards, datasources, plugins) | Shows provisioning structure; all samples are commented-out |
| `pkg/setting/setting.go` | `Cfg` type, `Load()`, `loadConfiguration()`, `parseINIFile()` | Config loading pipeline: defaults → custom → env → CLI → expand |
| `pkg/setting/setting_plugins.go` | Plugin settings reader, `defaultPreinstallPlugins` | Shows `grafana-lokiexplore-app` as only preinstall default |
| `pkg/setting/setting_unified_alerting.go` | Unified alerting settings, `IsEnabled()` | Shows alerting defaults to enabled when unset |
| `pkg/setting/setting_remote_cache.go` | Remote cache settings reader | Shows default cache type is "database" |
| `pkg/setting/setting_anonymous.go` | Anonymous auth settings | Shows anonymous access disabled by default |

**Database Initialization and Migration:**

| File / Folder | Purpose | Relevance |
|---|---|---|
| `pkg/services/sqlstore/sqlstore.go` | `SQLStore`, `ProvideService`, `initEngine`, `Migrate`, `Reset`, `ensureMainOrgAndAdminUser` | The complete database lifecycle from creation to admin user provisioning |
| `pkg/services/sqlstore/database_config.go` | `DatabaseConfig`, `readConfig`, `buildConnectionString` | Default: `type=sqlite3`, `path=data/grafana.db`, `cache_mode=private`, `WAL=false` |
| `pkg/services/sqlstore/user.go` | `createUser`, `getOrCreateOrg` helpers | Creates admin user and "Main Org." during first-run bootstrap |
| `pkg/services/sqlstore/migrations/migrations.go` | Master migration registration (40+ groups) | Shows exact ordering of schema creation phases |

**Authentication and Security:**

| File / Folder | Purpose | Relevance |
|---|---|---|
| `conf/defaults.ini` `[security]` section | Admin credentials, brute-force, CSP defaults | `admin_user=admin`, `admin_password=admin`, brute-force limit 5 |
| `conf/defaults.ini` `[auth]` section | Login cookie, session, OAuth defaults | Built-in login enabled, anonymous disabled |
| `conf/defaults.ini` `[auth.anonymous]` section | Anonymous access settings | `enabled = false`, `org_name = Main Org.`, `org_role = Viewer` |
| `pkg/services/authn/` | Pluggable authentication client architecture | Client selection: basic, API key, JWT, OAuth, session, LDAP, proxy |

**Plugin Ecosystem:**

| File / Folder | Purpose | Relevance |
|---|---|---|
| `pkg/plugins/manager/sources/sources.go` | Plugin source assembly: core, bundled, external, plugin-settings | Shows the four source categories and their filesystem paths |
| `pkg/plugins/manager/loader/loader.go` | Multi-stage loading: discovery → bootstrap → validation → initialization | Pipeline that processes every discovered plugin |
| `pkg/plugins/manager/pipeline/discovery/` | Plugin discovery and filtering | Finds plugins on filesystem, filters by type and duplicates |
| `pkg/plugins/manager/pipeline/bootstrap/` | Plugin construction from discovered bundles | Creates runtime plugin objects, resolves asset paths |
| `pkg/services/pluginsintegration/pluginstore/store.go` | Plugin store service, `ProvideService` | Eagerly loads all plugin sources at startup |
| `public/app/plugins/datasource/` | Core datasource plugins (22 plugins) | Built into `public/` static root, always available |
| `public/app/plugins/panel/` | Core panel plugins (30+ plugins) | Built into `public/` static root, always available |
| `plugins-bundled/external.json` | Bundled plugins manifest | Currently empty (`{"plugins": []}`) |

**Provisioning:**

| File / Folder | Purpose | Relevance |
|---|---|---|
| `pkg/services/provisioning/provisioning.go` | `ProvisioningServiceImpl`, `RunInitProvisioners` | Runs in order: datasources → plugins → alerting |
| `conf/provisioning/datasources/sample.yaml` | Sample datasource provisioning | All entries are commented-out by default |
| `conf/provisioning/dashboards/sample.yaml` | Sample dashboard provisioning | All entries are commented-out by default |
| `conf/provisioning/plugins/sample.yaml` | Sample plugin provisioning | All entries are commented-out by default |
| `conf/provisioning/alerting/sample.yaml` | Sample alerting provisioning | All entries are commented-out by default |

**Build and Development:**

| File / Folder | Purpose | Relevance |
|---|---|---|
| `Makefile` | Build orchestration: `build-go`, `build-go-fast`, `run` | Shows how Go binary is compiled |
| `.bra.toml` | Bra dev runner configuration | Dev mode: builds Go, runs with `app_mode=development` |
| `package.json` | Frontend build scripts: `start`, `build`, `dev` | Webpack-based frontend build |
| `contribute/developer-guide.md` | Developer setup instructions | Documents default credentials `admin`/`admin`, port 3000 |
| `go.mod` | Go module definition (Go 1.23.1) | Grafana version 11.5.0-pre |

### 0.2.2 Web Search Research Conducted

No web searches were required for this task. All answers are derivable directly from the source code in the repository, which the user explicitly requested ("what observably occurs based on real execution").

### 0.2.3 New File Requirements

- **CREATE:** `blitzy/documentation/grafana_4550cfb5b728.md` — Comprehensive Q&A document answering all user questions about Grafana's startup behavior, default security posture, persistent state creation, plugin ecosystem bootstrapping, and first-run vs. subsequent-run differences. This is the sole output artifact.


## 0.3 Dependency Inventory


### 0.3.1 Key Packages Relevant to This Task

Since this task produces only a documentation artifact (a markdown file), no packages are added or modified. However, the following packages are referenced in the analysis and cited in the output document:

| Registry | Package Name | Version | Purpose in Analysis |
|---|---|---|---|
| Go module | `github.com/grafana/grafana` | v11.5.0-pre | The Grafana monorepo itself |
| Go stdlib | `go` | 1.23.1 | Go runtime version per `go.mod` |
| Go module | `xorm.io/xorm` | 0.8.2 | ORM layer used by SQLStore for database operations |
| Go module | `mattn/go-sqlite3` | 1.14.22 | SQLite3 driver — default embedded database |
| Go module | `gopkg.in/ini.v1` | (bundled) | INI file parser used by `pkg/setting/` for config loading |
| Go module | `github.com/urfave/cli/v2` | (bundled) | CLI framework for `grafana-server` command parsing |
| Go module | `google.golang.org/wire` | (build-time) | Dependency injection code generator for `pkg/server/wire.go` |
| Go module | `github.com/hashicorp/go-plugin` | 1.6.2 | Plugin subprocess management via gRPC |
| Go module | `github.com/prometheus/client_golang` | (bundled) | Prometheus metrics registration during startup |
| npm | `grafana` (workspace) | 11.5.0-pre | Frontend monorepo root per `package.json` |

### 0.3.2 Dependency Updates

No dependency updates are required. This task is read-only analysis producing a single markdown document. No imports, build files, CI/CD configurations, or external references require modification.


## 0.4 Integration Analysis


### 0.4.1 Existing Code Touchpoints

This task does not modify any existing code. The integration analysis below documents the **code paths that were traced and analyzed** to produce the documentation, organized by the user's five question domains.

**Domain 1: Server Initialization Chain**

The startup call chain was traced through these touchpoints:

- `pkg/cmd/grafana-server/main.go` → `cmd.RunGrafanaCmd("server")` — Binary entrypoint
- `pkg/cmd/grafana-server/commands/cli.go` → `RunServer()` — Config loading, privilege check, `setting.NewCfgFromArgs()`, `server.Initialize()`, signal listener, `s.Run()`
- `pkg/setting/setting.go` → `Load()` → `loadConfiguration()` — Layered config: `conf/defaults.ini` → custom INI → env vars → CLI args → placeholder expansion
- `pkg/services/sqlstore/sqlstore.go` → `ProvideService()` — Creates SQLStore, runs migrations, creates admin user/org
- `pkg/server/server.go` → `Init()` — PID file, Prometheus env info, RBAC roles, init provisioners
- `pkg/server/server.go` → `Run()` — Iterates `backgroundServices`, skips disabled, starts goroutines, sends `READY=1`

**Domain 2: Default Security Posture**

The authentication and security defaults were traced through:

- `conf/defaults.ini` `[security]` — `admin_user=admin`, `admin_password=admin`, `admin_email=admin@localhost`, `disable_initial_admin_creation=false`
- `conf/defaults.ini` `[auth]` — `disable_login=false`, `disable_login_form=false`, `login_cookie_name=grafana_session`
- `conf/defaults.ini` `[auth.anonymous]` — `enabled=false`
- `pkg/services/sqlstore/sqlstore.go` `ensureMainOrgAndAdminUser()` — Checks user count; if zero, creates admin with configured credentials
- `pkg/services/sqlstore/user.go` `createUser()` — Encodes password with `util.EncodePassword`, creates org membership with `RoleAdmin`

**Domain 3: Persistent State Creation**

The state creation paths were traced through:

- `pkg/services/sqlstore/sqlstore.go` `initEngine()` — Creates `data/grafana.db` SQLite file if not exists (permission 0640)
- `pkg/services/sqlstore/sqlstore.go` `Migrate()` — Runs `migrator.RunMigrations()` which creates 40+ table groups and writes `migration_log` entries
- `pkg/services/sqlstore/sqlstore.go` `Reset()` → `ensureMainOrgAndAdminUser()` — Creates `user` row (admin), `org` row (Main Org.), `org_user` row (membership)
- `pkg/setting/setting.go` `DataPath` — `data/` directory relative to HomePath; stores the SQLite DB, logs, plugins, and CSV/PNG/PDF exports

**Domain 4: Plugin/Datasource Ecosystem Bootstrap**

The plugin discovery pipeline was traced through:

- `pkg/plugins/manager/sources/sources.go` `List()` — Assembles four source categories:
  - Core: `public/app/plugins/datasource/` + `public/app/plugins/panel/` (52+ plugins)
  - Bundled: `plugins-bundled/` (currently empty `external.json`)
  - External: `data/plugins/` (user-installed, empty on first run)
  - Plugin settings: paths from `[plugin.*]` config sections
- `pkg/services/pluginsintegration/pluginstore/store.go` `ProvideService()` — Iterates all sources, calls `pluginLoader.Load()` for each
- `pkg/plugins/manager/loader/loader.go` `Load()` — Executes discovery → bootstrap → validation → initialization pipeline
- `pkg/services/provisioning/provisioning.go` `RunInitProvisioners()` — Provisions datasources, plugins, alerting from YAML (all commented-out by default)

**Domain 5: First-Run vs. Subsequent-Run Differences**

The behavioral divergence was traced through:

- `pkg/services/sqlstore/sqlstore.go` `ensureMainOrgAndAdminUser()` line ~202 — `SELECT COUNT(id) FROM user`; if count > 0, returns immediately without creating admin
- `pkg/services/sqlstore/migrator/migrator.go` — `migration_log` table tracks applied migrations; subsequent runs skip already-applied migrations
- `pkg/services/sqlstore/sqlstore.go` `initEngine()` — On subsequent runs, the SQLite file already exists, so the creation path is skipped and permissions are verified instead

### 0.4.2 No Schema or Database Changes

No database migrations, schema additions, or data source modifications are required. The output is a read-only documentation file.


## 0.5 Technical Implementation


### 0.5.1 File-by-File Execution Plan

This task produces exactly one file. No existing files are modified.

**Group 1 — Output Document:**

- **CREATE:** `blitzy/documentation/grafana_4550cfb5b728.md`
  - A comprehensive markdown document structured into the following major sections, each answering a specific question domain from the user:
    - **Section 1: Server Initialization Ground Truth** — The exact call chain from process start to "READY=1", with file paths and code references. Documents the config loading order (`conf/defaults.ini` → custom INI → env vars → CLI overrides → expansion), database engine initialization, migration execution, admin user creation, RBAC role registration, provisioner execution, and background service launch.
    - **Section 2: Default Security Posture** — Documents the admin account (`admin`/`admin`), that anonymous access is disabled, that built-in login is the only active auth method, brute-force protection (5 attempts), and which security headers (HSTS, CSP) are off by default.
    - **Section 3: Persistent State Created on First Run** — Lists every artifact written to disk: `data/grafana.db` (SQLite file), `data/log/` (log files), `data/plugins/` (external plugin directory), and documents the 40+ migration groups that create database tables, the admin user record, the "Main Org." organization, and the `migration_log` entries.
    - **Section 4: Plugin and Data Source Ecosystem Bootstrap** — Explains the four plugin source categories (core, bundled, external, plugin-settings), the multi-stage loader pipeline, which 52+ core plugins are discovered from `public/app/plugins/`, that `plugins-bundled/external.json` is empty, and that the `grafana-lokiexplore-app` is the only default preinstall target.
    - **Section 5: First-Run vs. Subsequent-Run Behavioral Differences** — Explains that the user-count check skips admin creation on subsequent runs, migrations are deduplicated via `migration_log`, and the SQLite file existence check changes the initialization log output.
    - **Section 6: Build Artifacts and Compilation Dependencies** — Documents that `make build-go` produces the Go binary, `yarn start` produces the frontend webpack bundle, and running the server without building the frontend results in missing assets. Explains the `.bra.toml` dev-runner configuration and the `app_mode=development` behavior.

### 0.5.2 Implementation Approach

The implementation follows a documentation-generation approach:

- **Establish the factual foundation** by tracing every code path relevant to the user's questions through the source repository, citing specific files, functions, and line ranges
- **Structure the answers** into clearly delineated sections matching the user's question domains, with each claim backed by a code reference
- **Provide thinking and rationale** behind each answer, as required by the `SWE-AtlasQnA-Repo` implementation rule
- **Include configuration tables** showing default values from `conf/defaults.ini` with their section, key, default value, and behavioral impact
- **Include the startup sequence** as a step-by-step narrative with file path citations
- **Document the complete list of core plugins** discovered from `public/app/plugins/datasource/` and `public/app/plugins/panel/`

### 0.5.3 User Interface Design

Not applicable. This task produces a markdown documentation file only.


## 0.6 Scope Boundaries


### 0.6.1 Exhaustively In Scope

- **Output document:** `blitzy/documentation/grafana_4550cfb5b728.md` — the sole deliverable
- **Read-only analysis of all files listed in Section 0.2** — every file and folder cited in the Repository Scope Discovery was examined to produce the answers
- **The five question domains:**
  - Server initialization ground truth (startup call chain, config loading, service orchestration)
  - Default security posture (admin credentials, auth methods, brute-force protection, security headers)
  - Persistent state creation (SQLite database, migration tables, admin user/org, log files)
  - Plugin and data source ecosystem bootstrap (source categories, discovery pipeline, core plugins list)
  - First-run vs. subsequent-run behavioral differences (user-count check, migration deduplication, file existence)
- **Build/compilation artifact analysis:**
  - Go binary compilation (`make build-go`)
  - Frontend webpack bundle (`yarn start` / `yarn build`)
  - Bra dev-runner configuration (`.bra.toml`)

### 0.6.2 Explicitly Out of Scope

- **No modifications to any existing repository files** — per the user's explicit directive and the `SWE-AtlasQnA-Repo` implementation rule
- **No code changes** — no Go files, TypeScript files, configuration files, or build files are altered
- **No dependency additions or upgrades** — no packages are installed or modified
- **No test file creation** — the output is documentation only, not test code
- **Enterprise-specific behavior** — the analysis covers OSS Grafana only; enterprise Wire extensions (`wireexts_oss.go` build tag `oss`) are not explored
- **External data source behavior** — how external backends (Prometheus, Loki, etc.) respond to queries is not covered
- **HA/clustered deployment behavior** — the analysis covers single-instance startup from a clean state only
- **Performance benchmarking** — no runtime profiling or performance analysis is performed
- **Docker/container startup** — only bare-metal / local development startup is analyzed


## 0.7 Rules for Feature Addition


### 0.7.1 User-Specified Rules

The following rules are explicitly emphasized by the user and must be strictly observed:

- **Do not modify any files in the repository.** No existing source file, configuration file, build file, or documentation file may be altered. The repository must remain in its exact original state after task completion.
- **Temporary scripts are permitted for testing** but must be deleted after task completion. Any temporary scripts created during analysis must be cleaned up.
- **Create a markdown document named `grafana_4550cfb5b728.md`** that comprehensively answers the questions posed in the prompt. This is the sole output artifact.
- **Provide thinking / rationale behind the answers.** Do not just state conclusions; explain the code-path reasoning that supports each claim.
- **Do not make assumptions; base answers on the code as the truth.** Every factual claim must be traceable to a specific file and function in the repository.
- **Place the generated document in the `blitzy/documentation` directory** in the destination repo.
- **Do not add any other code** in the source repository besides the requested document.

### 0.7.2 Derived Constraints

- All configuration defaults cited in the document must be verified against `conf/defaults.ini` — not inferred from documentation or architecture specs
- All code paths described must reference actual function names and file paths — not abstracted descriptions
- The document must distinguish between what the code does and what the documentation says when there are differences
- Plugin lists must be derived from actual directory listings of `public/app/plugins/datasource/` and `public/app/plugins/panel/` — not from plugin catalog documentation


## 0.8 References


### 0.8.1 Repository Files and Folders Searched

The following is a comprehensive catalog of every file and folder retrieved or inspected during the analysis:

**Root-Level Files:**
- `package.json` — Frontend monorepo identity, scripts, version (11.5.0-pre)
- `go.mod` — Go module definition, Go 1.23.1
- `Makefile` — Build targets: `build-go`, `build-go-fast`, `run`, `deps-go`, `deps-js`
- `.bra.toml` — Bra dev runner configuration: build + server launch with `app_mode=development`
- `Dockerfile` — Container build definition
- `README.md` — Project overview and quick-start pointers
- `CONTRIBUTING.md` — Contribution guidelines

**Configuration (`conf/`):**
- `conf/defaults.ini` — Canonical baseline configuration (1900+ lines), every default value for every subsystem
- `conf/sample.ini` — Human-readable configuration reference
- `conf/ldap.toml` — Single-server LDAP template
- `conf/ldap_multiple.toml` — Multi-server LDAP example
- `conf/provisioning/access-control/sample.yaml` — Access control provisioning sample (commented-out)
- `conf/provisioning/alerting/sample.yaml` — Alerting provisioning sample (commented-out)
- `conf/provisioning/dashboards/sample.yaml` — Dashboard provisioning sample (commented-out)
- `conf/provisioning/datasources/sample.yaml` — Datasource provisioning sample (commented-out)
- `conf/provisioning/plugins/sample.yaml` — Plugin provisioning sample (commented-out)

**Server Lifecycle (`pkg/server/`):**
- `pkg/server/server.go` — Server struct, Init, Run, Shutdown, writePIDFile, notifySystemd
- `pkg/server/service.go` — coreService adapter for dskit BasicService
- `pkg/server/module_server.go` — ModuleServer for target-specific launches
- `pkg/server/wire.go` — Wire DI declarations
- `pkg/server/wireexts_oss.go` — OSS Wire extension sets

**Command Entrypoints (`pkg/cmd/`):**
- `pkg/cmd/grafana-server/main.go` — Server binary entrypoint
- `pkg/cmd/grafana-server/commands/cli.go` — RunServer function
- `pkg/cmd/grafana-server/commands/flags.go` — CLI flag definitions
- `pkg/cmd/grafana/main.go` — Unified binary entrypoint

**Settings (`pkg/setting/`):**
- `pkg/setting/setting.go` — Cfg type, Load, loadConfiguration, parseINIFile
- `pkg/setting/setting_plugins.go` — Plugin settings, defaultPreinstallPlugins
- `pkg/setting/setting_unified_alerting.go` — Unified alerting settings, IsEnabled
- `pkg/setting/setting_remote_cache.go` — Remote cache settings
- `pkg/setting/setting_anonymous.go` — Anonymous auth settings

**Database (`pkg/services/sqlstore/`):**
- `pkg/services/sqlstore/sqlstore.go` — SQLStore, ProvideService, initEngine, Migrate, Reset, ensureMainOrgAndAdminUser
- `pkg/services/sqlstore/database_config.go` — DatabaseConfig, readConfig, buildConnectionString
- `pkg/services/sqlstore/user.go` — createUser, getOrCreateOrg helpers
- `pkg/services/sqlstore/migrations/migrations.go` — Master migration orchestrator (40+ groups)

**Plugin System (`pkg/plugins/`):**
- `pkg/plugins/manager/sources/sources.go` — Plugin source assembly (core, bundled, external, plugin-settings)
- `pkg/plugins/manager/loader/loader.go` — Multi-stage loader pipeline
- `pkg/plugins/manager/pipeline/discovery/discovery.go` — Discovery stage
- `pkg/plugins/manager/pipeline/bootstrap/bootstrap.go` — Bootstrap stage
- `pkg/plugins/manager/pipeline/initialization/initialization.go` — Initialization stage
- `pkg/services/pluginsintegration/pluginstore/store.go` — Plugin store ProvideService
- `pkg/services/pluginsintegration/pipeline/pipeline.go` — Pipeline stage providers

**Frontend Plugin Directories:**
- `public/app/plugins/datasource/` — 22 core datasource plugins
- `public/app/plugins/panel/` — 30+ core panel plugins
- `plugins-bundled/external.json` — Bundled plugins manifest (empty)
- `plugins-bundled/README.md` — Bundled plugins documentation

**Provisioning:**
- `pkg/services/provisioning/provisioning.go` — ProvisioningServiceImpl, RunInitProvisioners

**Feature Management:**
- `pkg/services/featuremgmt/registry.go` — Feature flag registry with default-enabled flags
- `pkg/services/featuremgmt/manager.go` — Feature toggle evaluation logic

**Registry:**
- `pkg/registry/registry.go` — BackgroundService, CanBeDisabled, IsDisabled interfaces

**Documentation:**
- `contribute/developer-guide.md` — Developer setup instructions, default credentials

### 0.8.2 Attachments

No attachments were provided by the user for this task.

### 0.8.3 Technical Specification Sections Referenced

The following tech spec sections were retrieved and cross-referenced during analysis:
- **4.2 SERVER STARTUP AND LIFECYCLE** — Initialization sequence, background service orchestration, shutdown
- **4.4 AUTHENTICATION AND AUTHORIZATION FLOW** — Auth client selection, login/session management, RBAC
- **4.9 PLUGIN LIFECYCLE MANAGEMENT** — Plugin installation, loading, runtime communication
- **4.13 STATE MANAGEMENT AND PERSISTENCE** — State storage architecture, transaction boundaries, caching
- **6.2 Database Design** — Schema design, migration framework, data management, HA architecture


