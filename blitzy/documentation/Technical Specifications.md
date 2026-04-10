# Technical Specification

# 0. Agent Action Plan

## 0.1 Intent Clarification

### 0.1.1 Core Documentation Objective

Based on the provided requirements, the Blitzy platform understands that the documentation objective is to **create new documentation** that provides a comprehensive, evidence-based explanation of Grafana's actual runtime behavior when starting from a completely clean state — bridging the gap between existing architectural documentation and observable first-run behavior.

**Documentation Category:** Create new documentation
**Documentation Type:** Technical deep-dive / Developer onboarding guide

The user, a new team member, has identified several critical documentation gaps where the existing README, contributing guides, and architecture documentation fail to explain the actual observable behavior of the system. Specifically, the documentation must cover:

- **Initialization Ground Truth**: What observably occurs during Grafana server startup from a completely clean environment — not what documentation says should happen, but what the code actually does. The startup sequence is orchestrated by `pkg/server/server.go` via Wire dependency injection declared in `pkg/server/wire.go`, proceeding through construction, initialization, and execution phases.
- **Default Security Posture**: The actual authentication defaults in effect when no configuration is provided. According to `conf/defaults.ini` lines 324–334, the system creates a default admin account with credentials `admin`/`admin` and email `admin@localhost` — controlled by `disable_initial_admin_creation = false`, `admin_user = admin`, and `admin_password = admin`.
- **Persistent State Creation**: What files and databases are created on the filesystem during first run and how subsequent runs differ. The `[paths]` section of `conf/defaults.ini` defines `data = data` as the base directory, `logs = data/log`, `plugins = data/plugins`, and the SQLite database at `data/grafana.db`.
- **Plugin and Data Source Bootstrapping**: How core, bundled, and external plugins are discovered and loaded. The `pkg/plugins/manager/sources/sources.go` assembles plugin sources from three locations: core plugins at `public/app/plugins/datasource` and `public/app/plugins/panel`, bundled plugins from `cfg.BundledPluginsPath`, and external plugins from `data/plugins/`.
- **First Run vs. Subsequent Run Differences**: What state persists between restarts and how it changes behavior. The SQLite database (`data/grafana.db`) retains all schema migrations, user accounts, organizations, and configuration state, causing different code paths on subsequent starts.

### 0.1.2 Special Instructions and Constraints

**CRITICAL Directives Captured:**
- **No file modifications**: The user explicitly states: "Don't modify any files in the repository." All existing repository files must remain untouched. Documentation output must be a new standalone Markdown file.
- **Implementation Rule**: Per the `SWE-AtlasQnA-Repo` rule, a new markdown document named `grafana_4550cfb5b728.md` must be created in the `blitzy/documentation` directory, providing comprehensive answers with rationale grounded in code evidence.
- **Evidence-based approach**: Answers must be based on the code as the source of truth, not assumptions or paraphrasing of existing documentation.
- **Temporary scripts allowed**: If temporary scripts are needed for testing, they must be deleted after task completion.

**Style Preferences:**
- Factual, code-referenced explanations with citations to specific source files and line numbers
- Clear separation between "what the code does" and "what the documentation says"
- Progressive disclosure from high-level overview to implementation specifics
- Mermaid diagrams for complex initialization flows
- Tables for configuration defaults and state mappings

### 0.1.3 Technical Interpretation

These documentation requirements translate to the following technical documentation strategy:

- To document initialization behavior, we will **create** `blitzy/documentation/grafana_4550cfb5b728.md` with a detailed walkthrough of the startup sequence traced through `pkg/server/server.go`, `pkg/services/provisioning/provisioning.go`, and `pkg/services/sqlstore/sqlstore.go`.
- To document default security posture, we will **extract** all authentication-relevant defaults from `conf/defaults.ini` (sections `[security]`, `[auth]`, `[auth.anonymous]`, `[users]`) and correlate them with the admin user creation logic in `pkg/services/sqlstore/user.go`.
- To document persistent state, we will **catalog** every file and directory created under the `data/` path during first run, with emphasis on the SQLite3 database (`grafana.db`), its migration state, and the log directory.
- To document plugin bootstrapping, we will **trace** the plugin source assembly in `pkg/plugins/manager/sources/sources.go`, the built-in plugin registry in `public/app/features/plugins/built_in_plugins.ts`, and the plugin lifecycle pipeline in `pkg/plugins/manager/pipeline/`.
- To document first-run vs. subsequent-run differences, we will **analyze** the database migration logic in `pkg/services/sqlstore/sqlstore.go` and the admin creation guard in `pkg/services/sqlstore/user.go` (which checks for existing users before creating defaults).

### 0.1.4 Inferred Documentation Needs

Based on code analysis, the following implicit documentation needs have been identified:

- **Configuration loading chain**: The `pkg/setting/setting.go` configuration pipeline — loading `conf/defaults.ini` first, then overlaying `conf/custom.ini` if present, then applying environment variable overrides — is not explained in a way that helps a developer understand why the server "just works" without configuration.
- **Database auto-migration**: The SQL store initialization in `pkg/services/sqlstore/sqlstore.go` automatically runs all schema migrations on startup, creating tables for users, organizations, dashboards, data sources, plugins, alerts, and many more — this is the key mechanism that makes the first-run "just work" behavior possible.
- **Default organization creation**: The code in `pkg/services/sqlstore/user.go` and `pkg/services/org/orgimpl/org.go` automatically creates a "Main Org." (ID: 1) and assigns the admin user to it — explaining why the user can log in without configuring anything.
- **Remote cache defaulting to database**: `conf/defaults.ini` line 189 sets `[remote_cache] type = database`, meaning the caching layer falls back to the same SQLite database rather than requiring Redis or Memcached.
- **Feature toggle defaults**: The `[feature_toggles]` section in `conf/defaults.ini` ships with an empty `enable =` line, with some features enabled by default through the registry in `pkg/services/featuremgmt/registry.go`.
- **Build vs. runtime artifacts**: The `.bra.toml` configuration shows that `make run` triggers a Go build step before launching the server, producing the `./bin/grafana` binary — meaning certain compiled-in plugin registrations and Wire-generated dependency graphs must exist for the server to function.


## 0.2 Documentation Discovery and Analysis

### 0.2.1 Existing Documentation Infrastructure Assessment

Repository analysis reveals a multi-layered documentation structure with significant coverage gaps around runtime initialization behavior, default security posture, and state management.

**Documentation Framework:** Hugo-based docs site via `docs/` workspace, supplemented by contributor-facing Markdown in `contribute/`. The docs build system uses the Grafana Writers' Toolkit with Makefile-driven workflows (`docs/Makefile`, `docs/docs.mk`).

**Documentation Generator Configuration:**
- Hugo content root: `docs/sources/`
- Build orchestration: `docs/docs.mk` with `make docs` and `make docs-local-static` targets
- Validator: `grafana/doc-validator` container image, configured in `docs/variables.mk`
- API docs: Swagger/OpenAPI specs at `public/api-merged.json` (Swagger 2.0) and `public/openapi3.json` (OpenAPI 3.0.3)

**Diagram Tools Detected:** Mermaid is used extensively in the tech spec and contributor docs. No PlantUML or other diagram tools detected.

**Key Documentation Files Examined:**

| Document | Path | Coverage Status |
|----------|------|----------------|
| Project README | `README.md` | High-level only — links to external docs, no initialization detail |
| Contributing guide | `CONTRIBUTING.md` | Process-focused — how to contribute, not how the system works |
| Developer guide | `contribute/developer-guide.md` | Build and run instructions — mentions `admin`/`admin` login but no deeper explanation |
| Architecture landing | `contribute/architecture/README.md` | Minimal — routes to frontend and backend subpages |
| Backend services guide | `contribute/backend/services.md` | Wire DI patterns and service lifecycle — no startup sequence |
| Backend database guide | `contribute/backend/database.md` | SQL store abstraction — mentions SQLite3 default but no migration detail |
| Configuration defaults | `conf/defaults.ini` | Comprehensive but raw INI — not narrative documentation |
| Sample config | `conf/sample.ini` | Operator reference — not developer explanation |
| Provisioning samples | `conf/provisioning/*/sample.yaml` | Example-only — no explanation of default behavior |

### 0.2.2 Repository Code Analysis for Documentation

**Search patterns used for code to document:**

- Server initialization: `pkg/server/server.go` — `Init()`, `Run()`, `Shutdown()` methods
- Configuration loading: `pkg/setting/setting.go` — `Cfg` type and config-loading pipeline
- Database bootstrap: `pkg/services/sqlstore/sqlstore.go` — `ProvideService`, `Migrate`, schema initialization
- Admin user creation: `pkg/services/sqlstore/user.go` — `createUser`, `getOrCreateOrg`
- Organization seeding: `pkg/services/org/orgimpl/org.go` — `GetIDForNewUser`, `GetOrCreate`
- Plugin source assembly: `pkg/plugins/manager/sources/sources.go` — `List()`, `corePluginPaths()`, `externalPluginSources()`
- Plugin loading pipeline: `pkg/plugins/manager/pipeline/` — discovery, bootstrap, validation, initialization, termination stages
- Built-in plugin registry: `public/app/features/plugins/built_in_plugins.ts` — lazy-loaded core datasources and panels
- Provisioning orchestration: `pkg/services/provisioning/provisioning.go` — `RunInitProvisioners`, domain-specific provisioners
- Authentication defaults: `conf/defaults.ini` sections `[security]`, `[auth]`, `[auth.anonymous]`, `[users]`
- Feature toggles: `conf/defaults.ini` section `[feature_toggles]`, `pkg/services/featuremgmt/` registry

**Key Directories Examined:**

| Directory | Purpose | Relevance |
|-----------|---------|-----------|
| `pkg/server/` | Server lifecycle orchestration | Core startup sequence |
| `pkg/setting/` | Configuration loading and parsing | How defaults are applied |
| `pkg/services/sqlstore/` | SQL database layer with migrations | First-run database creation |
| `pkg/services/provisioning/` | File-based provisioning | Default resource creation |
| `pkg/plugins/` | Plugin architecture hub | Plugin discovery and loading |
| `pkg/plugins/manager/sources/` | Plugin source enumeration | Where plugins come from |
| `pkg/services/authn/` | Authentication subsystem | Login behavior |
| `pkg/services/accesscontrol/` | RBAC authorization | Permission defaults |
| `pkg/services/featuremgmt/` | Feature toggle management | Default feature state |
| `conf/` | Configuration defaults and samples | All default values |
| `conf/provisioning/` | Provisioning YAML templates | Default provisioned resources |
| `contribute/` | Contributor documentation | Existing developer onboarding |
| `public/app/plugins/` | Frontend core plugin implementations | Built-in panel and datasource code |
| `plugins-bundled/` | Bundled plugin packaging | Bundled plugin manifest |

### 0.2.3 Documentation Gap Analysis

**Critical gaps identified between existing documentation and user questions:**

- **No "what actually happens on first run" document exists** — The developer guide (`contribute/developer-guide.md`) tells you to run `make run` and log in with `admin`/`admin`, but does not explain the cascade of automatic initialization: SQLite creation, schema migration, organization seeding, admin user creation, plugin discovery, and provisioning.
- **Security defaults not explained** — The fact that `admin`/`admin` credentials are hardcoded in `conf/defaults.ini` and that anonymous access is disabled by default (`[auth.anonymous] enabled = false`) is documented as raw configuration, not as an explanatory narrative.
- **Plugin taxonomy undocumented for developers** — The distinction between core plugins (compiled into `public/app/plugins/`), bundled plugins (from `plugins-bundled/`), and external plugins (from `data/plugins/`) is only visible in the code.
- **State persistence not mapped** — No documentation catalogs what files and directories the server creates under `data/` and how they evolve across restarts.
- **Build-time vs. runtime plugin behavior** — The relationship between webpack-bundled frontend plugins, compiled-in Go backend plugins, and runtime-discovered external plugins is not documented.


## 0.3 Documentation Scope Analysis

### 0.3.1 Code-to-Documentation Mapping

**Modules requiring documentation:**

- **Module: `pkg/server/server.go`**
  - Public APIs: `New()`, `Init()`, `Run()`, `Shutdown()`, `writePIDFile()`, `notifySystemd()`
  - Current documentation: Exists as code comments and tech spec section 4.2, but not as standalone developer documentation
  - Documentation needed: Narrative explanation of the startup sequence with flow diagrams, linked to observable log output

- **Module: `conf/defaults.ini`**
  - Configuration sections: `[paths]`, `[server]`, `[database]`, `[security]`, `[auth]`, `[auth.anonymous]`, `[users]`, `[remote_cache]`, `[plugins]`, `[feature_toggles]`, `[unified_alerting]`
  - Current documentation: Raw INI comments inline only
  - Documentation needed: Curated table of security-relevant defaults with implications, explanation of the configuration loading chain

- **Module: `pkg/services/sqlstore/sqlstore.go`**
  - Public APIs: `ProvideService()`, `Migrate()`, `Reset()`
  - Current documentation: Backend database guide mentions SQLite3 default but not migration mechanics
  - Documentation needed: What the database migration does on first run, what tables are created, and how the migration state is tracked

- **Module: `pkg/services/sqlstore/user.go`**
  - Key functions: `createUser()`, `getOrCreateOrg()`, `verifyExistingOrg()`
  - Current documentation: Missing entirely from developer-facing docs
  - Documentation needed: How the default admin user and "Main Org." are bootstrapped

- **Module: `pkg/plugins/manager/sources/sources.go`**
  - Public APIs: `ProvideService()`, `List()`, `corePluginPaths()`, `externalPluginSources()`, `pluginSettingSources()`
  - Current documentation: Missing from developer-facing docs
  - Documentation needed: The three-tier plugin source hierarchy and how each source is resolved

- **Module: `pkg/services/provisioning/provisioning.go`**
  - Public APIs: `ProvideService()`, `RunInitProvisioners()`, `Run()`
  - Current documentation: Tech spec section 4.8, but no standalone developer guide
  - Documentation needed: What the provisioning system does by default when `conf/provisioning/` contains only sample.yaml files

- **Module: `pkg/setting/setting.go`**
  - Key behavior: Configuration loading pipeline — `defaults.ini` → `custom.ini` → environment variables → CLI flags
  - Current documentation: Referenced in developer guide but not explained
  - Documentation needed: How the configuration cascade works and why "zero config" starts successfully

### 0.3.2 Configuration Options Requiring Documentation

| Config Section | Key Setting | Default Value | Documentation Status |
|----------------|------------|---------------|---------------------|
| `[database]` | `type` | `sqlite3` | Mentioned in backend docs, not explained |
| `[database]` | `path` | `grafana.db` | Not documented for developers |
| `[paths]` | `data` | `data` | Referenced but not cataloged |
| `[paths]` | `plugins` | `data/plugins` | Not explained |
| `[paths]` | `provisioning` | `conf/provisioning` | Not explained |
| `[security]` | `admin_user` | `admin` | In developer guide as login hint only |
| `[security]` | `admin_password` | `admin` | In developer guide as login hint only |
| `[security]` | `disable_initial_admin_creation` | `false` | Not documented |
| `[security]` | `secret_key` | `SW2YcwTIb9zpOOhoPsMm` | Not flagged as development-only |
| `[auth.anonymous]` | `enabled` | `false` | Not explained |
| `[remote_cache]` | `type` | `database` | Not explained |
| `[users]` | `auto_assign_org` | `true` | Not explained |
| `[users]` | `auto_assign_org_id` | `1` | Not explained |
| `[users]` | `allow_sign_up` | `false` | Not documented |
| `[plugins]` | `preinstall` | (empty, defaults to `grafana-lokiexplore-app`) | Not explained |
| `[analytics]` | `reporting_enabled` | `true` | Not flagged |
| `[analytics]` | `check_for_updates` | `true` | Not flagged |

### 0.3.3 Features Requiring User Guides

| Feature Area | Current Coverage | Documentation Gaps |
|-------------|-----------------|-------------------|
| First-run initialization | Zero coverage | Entire lifecycle from binary launch to UI-ready state |
| Default security posture | Login credentials only | Full security defaults analysis, brute-force protection state, CSRF, cookie settings |
| Plugin discovery taxonomy | Zero coverage | Core vs. bundled vs. external distinction, source resolution order |
| State persistence map | Zero coverage | Filesystem artifacts, database tables, log files |
| Configuration cascade | Mentioned in developer guide | Full chain: defaults.ini → custom.ini → env vars → CLI args |
| Build artifacts | Mentioned as `make run` | Wire-generated code, webpack bundles, Go binary relationship |
| Provisioning defaults | Sample files exist | What happens when samples are inert (commented out) |


## 0.4 Documentation Implementation Design

### 0.4.1 Documentation Structure Planning

The deliverable is a single comprehensive Markdown document placed at `blitzy/documentation/grafana_4550cfb5b728.md` in the destination repository, as required by the `SWE-AtlasQnA-Repo` implementation rule. The document follows a progressive-disclosure structure organized around the user's five core questions:

```
blitzy/documentation/grafana_4550cfb5b728.md
├── Title and Scope
├── 1. Configuration Loading Chain
│   ├── How defaults.ini is loaded
│   ├── Custom.ini overlay behavior
│   └── Environment variable and CLI overrides
├── 2. First-Run Initialization Sequence
│   ├── Server construction via Wire DI
│   ├── Database creation and migration
│   ├── Admin user and organization bootstrap
│   ├── Provisioning execution (with default inert samples)
│   ├── Plugin discovery and loading
│   └── Background service startup
├── 3. Default Security Posture
│   ├── Admin credentials and creation logic
│   ├── Authentication mechanisms active by default
│   ├── Anonymous access state
│   ├── CSRF, cookie, and session defaults
│   ├── Secret key and encryption defaults
│   └── Brute-force protection state
├── 4. Persistent State Map
│   ├── Filesystem artifacts (data/, data/log/, data/plugins/)
│   ├── SQLite database (data/grafana.db) contents
│   ├── Migration state tracking
│   └── How state affects subsequent runs
├── 5. Plugin and Data Source Ecosystem
│   ├── Plugin source hierarchy (core / bundled / external)
│   ├── Core plugin discovery from public/app/plugins/
│   ├── Built-in plugin registry (frontend)
│   ├── Plugin signature verification
│   └── What appears in the UI without installation
├── 6. Build vs. Runtime Behavior
│   ├── make run / bra workflow
│   ├── Wire-generated dependency injection
│   ├── Webpack-bundled frontend assets
│   └── When compilation is required vs. optional
├── 7. First Run vs. Subsequent Run Differences
│   ├── Migration idempotency
│   ├── Admin creation guard
│   └── Provisioning reconciliation
└── Source Citations
```

### 0.4.2 Content Generation Strategy

**Information Extraction Approach:**
- Extract startup sequence from `pkg/server/server.go` — `New()` → `Init()` → `Run()` method chain
- Extract database initialization from `pkg/services/sqlstore/sqlstore.go` — `ProvideService()` triggers engine creation and `Migrate()`
- Extract admin user bootstrap from `pkg/services/sqlstore/user.go` — `createUser()` with org assignment
- Extract plugin sources from `pkg/plugins/manager/sources/sources.go` — `List()` assembling core, bundled, and external sources
- Extract configuration defaults from `conf/defaults.ini` — all security, auth, database, paths, plugin, and feature-toggle sections
- Extract provisioning behavior from `pkg/services/provisioning/provisioning.go` — `RunInitProvisioners()` executing datasource, plugin, and alerting provisioners in sequence
- Extract build workflow from `Makefile` (line 232: `run: $(BRA)`) and `.bra.toml` (init commands: `make build-go`, then launch `./bin/grafana server`)

**Documentation Standards:**
- Markdown formatting with proper heading hierarchy (`#`, `##`, `###`)
- Mermaid diagrams for initialization flows and plugin discovery
- Code citations using `Source: /path/to/file.go:LineNumber` format
- Tables for configuration defaults, state mappings, and plugin taxonomies
- Every claim grounded in a specific source file reference

### 0.4.3 Diagram and Visual Strategy

**Mermaid diagrams to create within the output document:**

- **Server Initialization Flow**: Flowchart showing the complete path from binary launch through Wire DI → `Server.New()` → `Server.Init()` → provisioning → `Server.Run()` → background services → `READY=1`
- **Configuration Loading Chain**: Flowchart showing `defaults.ini` → `custom.ini` (if exists) → environment variable overrides → CLI argument overrides
- **Plugin Source Hierarchy**: Flowchart showing how core plugins (from `public/app/plugins/`), bundled plugins (from `plugins-bundled/`), and external plugins (from `data/plugins/`) are assembled into the unified plugin registry
- **State Persistence Map**: Diagram showing the filesystem layout of `data/` with all created artifacts
- **First Run vs. Subsequent Run**: Comparison diagram showing which code paths diverge based on existing database state


## 0.5 Documentation File Transformation Mapping

### 0.5.1 File-by-File Documentation Plan

Per the `SWE-AtlasQnA-Repo` implementation rule, the output is a single new Markdown document. No existing files are modified. Existing repository files serve as evidence sources for content generation.

**Documentation Transformation Modes:**
- **CREATE** — Create a new documentation file
- **REFERENCE** — Use as a source of factual evidence or structural template (read-only)

| Target Documentation File | Transformation | Source Code/Docs | Content/Changes |
|---------------------------|----------------|------------------|-----------------|
| `blitzy/documentation/grafana_4550cfb5b728.md` | CREATE | Multiple source files (see below) | Comprehensive Q&A document covering Grafana initialization, defaults, security, plugins, and state persistence |
| `conf/defaults.ini` | REFERENCE | — | Primary evidence for all default configuration values: database, security, auth, paths, plugins |
| `pkg/server/server.go` | REFERENCE | — | Evidence for server lifecycle: `Init()`, `Run()`, `Shutdown()` methods, PID file, background services |
| `pkg/services/sqlstore/sqlstore.go` | REFERENCE | — | Evidence for database engine creation, SQLite3 initialization, `Migrate()` call at startup |
| `pkg/services/sqlstore/user.go` | REFERENCE | — | Evidence for admin user bootstrap: `createUser()`, org creation, role assignment |
| `pkg/plugins/manager/sources/sources.go` | REFERENCE | — | Evidence for plugin source hierarchy: core, bundled, external discovery |
| `pkg/services/provisioning/provisioning.go` | REFERENCE | — | Evidence for provisioning lifecycle: datasources → plugins → alerting sequence |
| `pkg/setting/setting.go` | REFERENCE | — | Evidence for configuration loading chain: INI files → env vars → CLI flags |
| `public/app/features/plugins/built_in_plugins.ts` | REFERENCE | — | Evidence for frontend built-in plugin registry and lazy-loading |
| `Makefile` | REFERENCE | — | Evidence for build targets: `build-go`, `run`, `run-go` |
| `.bra.toml` | REFERENCE | — | Evidence for dev runner workflow: `make build-go` then `./bin/grafana server` |
| `contribute/architecture/backend/` | REFERENCE | — | Structural template for backend documentation style |
| `contribute/ARCHITECTURE.md` | REFERENCE | — | Architecture overview context for aligning with existing docs |
| `conf/provisioning/` | REFERENCE | — | Evidence for provisioning sample configs (datasources, dashboards, alerting, plugins, access-control) |
| `pkg/services/org/orgimpl/org.go` | REFERENCE | — | Evidence for organization service: `GetOrCreate`, default org creation |
| `pkg/services/sqlstore/migrations/` | REFERENCE | — | Evidence for database migration system and schema versioning |
| `go.mod` | REFERENCE | — | Evidence for Go version (1.23.1) and dependency tree |
| `.nvmrc` | REFERENCE | — | Evidence for Node.js version (v22.11.0) |
| `package.json` | REFERENCE | — | Evidence for Grafana version (11.5.0-pre), build scripts |
| `plugins-bundled/external.json` | REFERENCE | — | Evidence that bundled external plugin list is empty by default |

### 0.5.2 New Documentation File Detail

```
File: blitzy/documentation/grafana_4550cfb5b728.md
Type: Technical Q&A / Investigation Document
Purpose: Answer the user's questions about Grafana startup, defaults, security, plugins, and state

Sections:
  - Title and Introduction (scope, constraints, environment)
  - Section 1: Configuration Loading Chain
      Source: pkg/setting/setting.go, conf/defaults.ini
  - Section 2: First-Run Initialization Sequence
      Source: pkg/server/server.go:70-115, pkg/services/sqlstore/sqlstore.go
  - Section 3: Default Security Posture
      Source: conf/defaults.ini:270-380, pkg/services/sqlstore/user.go
  - Section 4: Persistent State Map
      Source: conf/defaults.ini:1-30, pkg/services/sqlstore/migrations/
  - Section 5: Plugin and Data Source Ecosystem
      Source: pkg/plugins/manager/sources/sources.go, public/app/features/plugins/built_in_plugins.ts
  - Section 6: Build vs. Runtime Behavior
      Source: Makefile:185-245, .bra.toml, package.json
  - Section 7: First Run vs. Subsequent Run Differences
      Source: pkg/services/sqlstore/user.go, pkg/services/provisioning/provisioning.go
  - Source Citations (comprehensive list of all referenced files)

Diagrams:
  - Initialization sequence flowchart (Mermaid)
  - Configuration loading pipeline (Mermaid)
  - Plugin source hierarchy (Mermaid)
  - Filesystem state map (Mermaid)

Key Citations:
  conf/defaults.ini, pkg/server/server.go, pkg/services/sqlstore/sqlstore.go,
  pkg/services/sqlstore/user.go, pkg/plugins/manager/sources/sources.go,
  pkg/services/provisioning/provisioning.go, pkg/setting/setting.go,
  public/app/features/plugins/built_in_plugins.ts
```

### 0.5.3 Documentation Configuration Updates

No documentation generator configuration changes are required. The output is a standalone Markdown file placed at `blitzy/documentation/grafana_4550cfb5b728.md`. This path is outside any existing docs build pipeline (`docs/` using Hugo, `contribute/` as developer guides), so no `mkdocs.yml`, `docusaurus.config.js`, or Hugo configuration changes apply.

### 0.5.4 Cross-Documentation Dependencies

- **No shared includes or navigation links** need updating — the output document is a self-contained artifact in the `blitzy/documentation/` directory, independent of the repository's existing documentation structure.
- **Internal cross-references** within the generated document use relative anchors between sections (e.g., "See Section 3: Default Security Posture" links to its own heading).
- **Source citations** throughout the document reference repository file paths using a consistent `Source: path/to/file.go:LineNumber` format for traceability back to the codebase.


## 0.6 Dependency Inventory

### 0.6.1 Documentation Dependencies

This documentation task produces a standalone Markdown file and does not require a documentation build pipeline. The tools and packages below are those relevant to the Grafana project environment whose behavior is being documented, not documentation generators to install.

| Registry | Package Name | Version | Purpose |
|----------|--------------|---------|---------|
| go | go | 1.23.1 | Go runtime — the language Grafana's backend is written in; version from `go.mod` |
| nvm | node | v22.11.0 | Node.js runtime — required for frontend build tooling; version from `.nvmrc` |
| npm | grafana (workspace root) | 11.5.0-pre | Grafana project version from `package.json` |
| go module | github.com/grafana/grafana | v11.5.0-pre | Grafana Go module from `go.mod` |

No documentation-specific tooling (MkDocs, Sphinx, Docusaurus, Mermaid CLI) needs to be installed or configured. The output document uses standard GitHub-flavored Markdown with inline Mermaid diagram blocks, which render natively on GitHub and most Markdown viewers without external tools.

### 0.6.2 Documentation Reference Updates

No link updates are required. The output file (`blitzy/documentation/grafana_4550cfb5b728.md`) is a new standalone document that does not replace or supersede any existing documentation in the repository. No existing files contain links that need to point to this new document, and the document itself contains only source citations to existing repository files — not hyperlinks requiring URL transformation.


## 0.7 Coverage and Quality Targets

### 0.7.1 Documentation Coverage Metrics

The user's request contains five distinct knowledge areas, each with specific sub-topics that the output document must cover. Current repository documentation coverage for these areas is assessed below.

**Current coverage analysis (based on repository documentation discovery):**

| Knowledge Area | Sub-Topics Identified | Covered by Existing Docs | Uncovered | Coverage |
|----------------|----------------------|--------------------------|-----------|----------|
| Initialization Sequence | Wire DI, Init(), provisioning, background services, systemd ready | Partial (contribute/ARCHITECTURE.md mentions backend lifecycle) | Detailed step-by-step with observable log behavior | 20% |
| Default Security Posture | Admin credentials, auth mechanisms, anonymous access, CSRF, secret key, brute-force | None in developer guides | All sub-topics | 0% |
| Persistent State Map | data/ directory layout, SQLite DB contents, migration tracking, log files | Partial (conf/defaults.ini documents paths) | Comprehensive artifact inventory with first-run vs. subsequent | 15% |
| Plugin/Data Source Ecosystem | Core plugins, bundled plugins, external plugins, signature verification, frontend registry | Partial (plugin development docs exist, but not discovery/loading) | Full bootstrap lifecycle from clean state | 10% |
| Build vs. Runtime Behavior | make run workflow, Wire codegen, webpack bundles, compilation requirements | Partial (contribute/ has build instructions) | When compilation is required vs. optional, artifact dependencies | 25% |

**Overall target coverage:** 100% of user-identified sub-topics must be addressed with code-backed evidence.

**Coverage gaps to address:**
- Default security posture: Currently 0% documented for new developers — the output document fills this entirely
- Initialization sequence: Existing docs describe architecture but not the observable first-run behavior — the output document provides step-by-step ground truth
- Plugin ecosystem bootstrap: Plugin development is documented but the discovery-to-UI pipeline from clean state is not — the output document traces the complete path
- State persistence: File paths are configured in `defaults.ini` but what actually gets created and when is undocumented — the output document inventories all artifacts

### 0.7.2 Documentation Quality Criteria

**Completeness requirements:**
- Every section must answer the specific question the user asked, not provide general information
- All configuration defaults cited must include the exact value from `conf/defaults.ini` with line references
- All code behavior described must reference the specific Go source file and function
- Every claim about "what happens" must be traceable to either a code path or a configuration value

**Accuracy validation:**
- Configuration values must match `conf/defaults.ini` exactly (e.g., `admin_user = admin`, not "the default admin username")
- Code flow descriptions must follow actual method calls (e.g., `Server.Init()` calls `s.roleRegistry.RegisterFixedRoles()` before `s.provisioningService.RunInitProvisioners()`)
- Plugin source hierarchy must match the `sources.go` implementation (core from `public/app/plugins/`, bundled from `cfg.BundledPluginsPath`, external from `cfg.PluginsPath`)
- Admin bootstrap logic must match `user.go` — org creation, user creation, role assignment

**Clarity standards:**
- Progressive disclosure: Start with the high-level answer, then drill into evidence
- Each section answers a "What?" question first, then explains "Why?" and "How?"
- Technical terms are defined on first use (e.g., "Wire DI — compile-time dependency injection code generation")
- Diagrams precede detailed prose to provide visual orientation

**Maintainability:**
- Every factual claim includes a `Source:` citation with file path and line number
- The document header states the Grafana version (11.5.0-pre) it applies to
- Section headings match the user's original questions for easy navigation

### 0.7.3 Example and Diagram Requirements

| Diagram | Type | Purpose | Source Files |
|---------|------|---------|-------------|
| Server Initialization Flow | Mermaid flowchart | Show complete startup sequence from binary launch to READY signal | `pkg/server/server.go` |
| Configuration Loading Pipeline | Mermaid flowchart | Show defaults.ini → custom.ini → env vars → CLI flags layering | `pkg/setting/setting.go` |
| Plugin Source Hierarchy | Mermaid flowchart | Show how core, bundled, and external plugins are assembled | `pkg/plugins/manager/sources/sources.go` |
| State Persistence Map | Mermaid graph | Show `data/` directory layout with all created artifacts | `conf/defaults.ini` lines 7-30 |
| First Run vs. Subsequent Run | Mermaid flowchart | Show diverging code paths based on existing database/state | `pkg/services/sqlstore/user.go`, `pkg/services/sqlstore/migrations/` |

**Minimum code-evidence citations per section:** 3 source file references per major section, ensuring every factual claim is grounded in the codebase.


## 0.8 Scope Boundaries

### 0.8.1 Exhaustively In Scope (with trailing patterns)

**New documentation files:**
- `blitzy/documentation/grafana_4550cfb5b728.md` — the sole output artifact containing all answers

**Source files read for evidence (read-only, never modified):**
- `conf/defaults.ini` — all default configuration values
- `conf/provisioning/**/*` — provisioning sample directory structure
- `pkg/server/server.go` — server lifecycle (Init, Run, Shutdown)
- `pkg/services/sqlstore/sqlstore.go` — database engine creation and migration
- `pkg/services/sqlstore/user.go` — admin user bootstrap
- `pkg/services/sqlstore/migrations/**` — migration system and schema versioning
- `pkg/services/provisioning/provisioning.go` — provisioning orchestration
- `pkg/services/provisioning/datasources/**` — datasource provisioning
- `pkg/services/provisioning/plugins/**` — plugin provisioning
- `pkg/services/provisioning/alerting/**` — alerting provisioning
- `pkg/services/org/orgimpl/org.go` — organization service
- `pkg/plugins/manager/sources/sources.go` — plugin source hierarchy
- `pkg/setting/setting.go` — configuration loading chain
- `public/app/features/plugins/built_in_plugins.ts` — frontend plugin registry
- `Makefile` — build targets and dev workflow
- `.bra.toml` — dev runner configuration
- `go.mod` — Go version
- `.nvmrc` — Node.js version
- `package.json` — project version and build scripts
- `plugins-bundled/external.json` — bundled external plugin manifest
- `contribute/**/*.md` — existing developer documentation for style reference
- `README.md` — project overview
- `CONTRIBUTING.md` — contribution process

**Documentation content topics:**
- Server initialization sequence from clean state
- Configuration loading chain (defaults → custom → env → CLI)
- Default security posture (admin credentials, auth modes, CSRF, encryption)
- Persistent state creation (filesystem artifacts, SQLite database contents)
- Plugin and data source discovery and loading pipeline
- Build vs. runtime behavior differences
- First run vs. subsequent run behavioral divergence

### 0.8.2 Explicitly Out of Scope

- **Source code modifications** — the user explicitly stated: "Don't modify any files in the repository"
- **Test file modifications** — no test files are created, modified, or executed
- **Feature additions or code refactoring** — no functional changes to Grafana
- **Deployment configuration changes** — no Docker, Kubernetes, or CI/CD changes
- **Frontend code analysis beyond plugin registry** — UI component internals, React rendering, state management within the browser are not investigated
- **Enterprise-only features** — enterprise licensing, SAML, team sync, and other enterprise features are excluded as the user operates the open-source distribution
- **External plugin development documentation** — the document covers plugin discovery/loading, not how to develop plugins
- **Performance benchmarking** — the document describes what happens, not how fast it happens
- **Multi-instance or clustered deployment** — the user is running a single local instance
- **Database backends other than SQLite3** — MySQL and PostgreSQL configuration is noted as available but the default SQLite3 path is the focus
- **Historical version differences** — the document covers v11.5.0-pre behavior only
- **Temporary test scripts** — any scripts created for investigation must be deleted before task completion per user instruction


## 0.9 Execution Parameters

### 0.9.1 Documentation-Specific Instructions

- **Documentation build command:** Not applicable — the output is a standalone Markdown file (`blitzy/documentation/grafana_4550cfb5b728.md`) that does not require a build pipeline
- **Documentation preview command:** Any Markdown viewer or `cat blitzy/documentation/grafana_4550cfb5b728.md` — Mermaid diagrams render natively on GitHub
- **Diagram generation command:** Not applicable — Mermaid diagrams are embedded inline in the Markdown and rendered client-side by compatible viewers
- **Documentation deployment command:** Not applicable — the file is committed to the destination repository via standard Git workflow
- **Default format:** GitHub-flavored Markdown with inline Mermaid diagram blocks
- **Citation requirement:** Every section must include `Source:` references to the specific repository files and line numbers that support each claim
- **Style guide:** Follow the conversational-yet-technical tone of Grafana's existing `contribute/` developer documentation, using progressive disclosure (overview → detail → evidence)
- **Documentation validation:** Verify all cited file paths exist in the repository; verify all configuration values match `conf/defaults.ini` verbatim; verify all code flow descriptions match the source files

### 0.9.2 Output Placement and Naming

Per the `SWE-AtlasQnA-Repo` implementation rule:
- **Directory:** `blitzy/documentation/`
- **Filename:** `grafana_4550cfb5b728.md` (derived from the source branch name `grafana_4550cfb5b728`)
- **Full path:** `blitzy/documentation/grafana_4550cfb5b728.md`
- **Content:** Comprehensive answers to all questions posed in the user's prompt, with thinking and rationale behind each answer, grounded in code evidence rather than assumptions


## 0.10 Rules for Documentation

### 0.10.1 User-Specified Directives

The following rules are derived directly from the user's instructions and the `SWE-AtlasQnA-Repo` implementation rule:

- **Do not modify any existing files in the repository** — the user explicitly stated: "Don't modify any files in the repository." All analysis is read-only; the only write operation is creating `blitzy/documentation/grafana_4550cfb5b728.md` in the destination repository.
- **Temporary scripts must be deleted** — the user allows creating temporary scripts for testing but requires they be deleted after task completion: "If you need to create temporary scripts for testing, that's fine, but don't change the actual codebase files. And delete all those temporary scripts/files after task completion."
- **Base answers on code as truth, not documentation** — the user explicitly wants "what observably occurs based on real execution" and "not what the docs say should happen." Per the `SWE-AtlasQnA-Repo` rule: "Do not make assumptions, base your answers on the code as the truth."
- **Provide thinking and rationale** — per the `SWE-AtlasQnA-Repo` rule: "Provide thinking / rationale behind the answers."
- **Create output as a new Markdown document** — per the `SWE-AtlasQnA-Repo` rule: "Create a new markdown document named `<source_branch_name>.md`" placed in `blitzy/documentation/`.

### 0.10.2 Documentation Quality Rules

- **Every factual claim requires a source citation** — no statement about Grafana's behavior may appear without a reference to the specific file and, where applicable, line number that supports it
- **Use exact configuration values** — when citing defaults from `conf/defaults.ini`, reproduce the exact key-value pair (e.g., `admin_user = admin`) rather than paraphrasing
- **Distinguish between "configured" and "observable"** — when a default is set in `defaults.ini` but the runtime behavior depends on additional logic (e.g., admin user creation is conditional on no existing admin), document both the configuration and the code-path logic
- **No assumptions about runtime state** — describe only what the code provably does; if a behavior depends on an external condition (e.g., filesystem permissions, network availability), note the dependency rather than assuming the outcome
- **Progressive disclosure structure** — each section begins with the direct answer to the user's question, then provides supporting evidence, then offers deeper technical detail for readers who want it


## 0.11 References

### 0.11.1 Repository Files and Folders Searched

The following files and folders were systematically inspected to derive the conclusions documented in this Agent Action Plan:

**Configuration Files:**
- `conf/defaults.ini` (lines 1-120, 117-250, 250-500, 500-750, 1100-1350, 1540-1950) — complete default configuration covering paths, database, security, auth, plugins, logging, analytics
- `conf/provisioning/` — provisioning sample directory structure with subdirectories for datasources, dashboards, alerting, plugins, access-control

**Server Lifecycle:**
- `pkg/server/server.go` (full file, 257 lines) — Server struct, Init(), Run(), Shutdown() methods, PID file writing, background service orchestration

**Database and State:**
- `pkg/services/sqlstore/sqlstore.go` — database engine creation, SQLite3 initialization, Migrate() invocation at startup
- `pkg/services/sqlstore/user.go` — admin user bootstrap: createUser(), getOrCreateOrg(), role assignment, event publishing
- `pkg/services/sqlstore/migrations/` — migration system folder structure
- `pkg/services/org/orgimpl/org.go` — organization service: GetIDForNewUser(), GetOrCreate()

**Plugin System:**
- `pkg/plugins/` — plugin package root and subpackage structure
- `pkg/plugins/manager/` — plugin manager folder structure
- `pkg/plugins/manager/sources/sources.go` (full file, 69 lines) — plugin source hierarchy: core, bundled, external
- `public/app/features/plugins/built_in_plugins.ts` — frontend built-in plugin registry with lazy-loaded webpack chunks
- `plugins-bundled/external.json` — bundled external plugin manifest (empty array)

**Provisioning:**
- `pkg/services/provisioning/provisioning.go` — provisioning orchestration: RunInitProvisioners() executing datasources → plugins → alerting
- `pkg/services/provisioning/datasources/` — datasource provisioner subpackage
- `pkg/services/provisioning/plugins/` — plugin provisioner subpackage
- `pkg/services/provisioning/alerting/` — alerting provisioner subpackage

**Settings:**
- `pkg/setting/setting.go` — configuration loading chain: INI file parsing, environment variable expansion, CLI flag processing

**Build and Development:**
- `Makefile` (lines 185-245) — build-go, run, run-go targets
- `.bra.toml` — dev runner: init commands (make build-go), binary launch (./bin/grafana server)
- `go.mod` — Go 1.23.1
- `.nvmrc` — Node v22.11.0
- `package.json` — version 11.5.0-pre, build/dev/test scripts

**Documentation Infrastructure:**
- `README.md` — project overview, links to documentation and contributing
- `CONTRIBUTING.md` — contribution process guide
- `contribute/` — developer documentation root (architecture, backend guides, style guides)
- `contribute/ARCHITECTURE.md` — architecture overview
- `contribute/backend/` — backend developer guides (services, communication, database, errors, instrumentation)
- `docs/` — Hugo-based user documentation root with Makefile-driven builds

**Root Structure:**
- Repository root (via `get_source_folder_contents("")`) — full Grafana monorepo structure with `pkg/`, `public/`, `conf/`, `contribute/`, `docs/`, `plugins-bundled/`, `devenv/`, `scripts/`, `packages/`

### 0.11.2 Tech Spec Sections Retrieved

| Section | Key Information Extracted |
|---------|-------------------------|
| 1.1 Executive Summary | Project version (v11.5.0-pre), Go 1.23.1, core business problem, stakeholders |
| 4.2 Server Startup and Lifecycle | Full initialization sequence: Wire DI → Init → PID → Prometheus → RBAC → Provisioning → Run → Background Services → systemd READY |
| 4.4 Authentication and Authorization Flow | Pluggable client architecture (11+ auth clients), login/session management, RBAC permission evaluation |
| 4.8 Provisioning Workflow | Sequential provisioning order (datasources → plugins → alerting), dashboard continuous polling, error recovery |
| 4.9 Plugin Lifecycle Management | Installation/loading pipeline (download → extract → parse → signature verify → license → register → backend subprocess), gRPC communication |
| 4.13 State Management and Persistence | State storage architecture (sessions, dashboards, alerts, streams, feature flags, plugins, cache, provisioning), transaction boundaries, caching |
| 6.4 Security Architecture | Authentication framework, authorization system, data protection, encryption, plugin security model |

### 0.11.3 Attachments and External Resources

- **Attachments provided:** None (0 attachments)
- **Figma URLs provided:** None
- **Environment files provided:** None (no files in `/tmp/environments_files`)
- **Environment variables provided:** None
- **Secrets provided:** None
- **Source branch:** `grafana_4550cfb5b728` (repository at `/tmp/blitzy/grafana/grafana_4550cfb5b728_aba978`)


