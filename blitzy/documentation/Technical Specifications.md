# Technical Specification

# 0. Agent Action Plan

## 0.1 Intent Clarification


### 0.1.1 Core Documentation Objective

Based on the provided requirements, the Blitzy platform understands that the documentation objective is to **create new documentation** that provides runtime-verified, evidence-backed answers to five distinct investigation questions about Grafana's internal server behavior, dashboard-scene architecture, and alerting API rule creation process. The documentation type is a **technical investigation report** combining runtime evidence (log output, API responses, test script output) with codebase analysis.

The specific documentation requirements are:

- **Server idle behavior analysis**: After the Grafana server has been running for at least 60 seconds with no user requests, document the exact recurring log entries that appear, providing the actual log output as runtime evidence.
- **Database migration check verification**: Document the specific output that confirms the schema version is up to date when the server starts, providing the runtime evidence of the database migration check.
- **Build information verification**: Query the API endpoints of a running Grafana instance and document the exact version string reported by the API, providing runtime evidence of the API response.
- **Dashboard scene architecture investigation**: Investigate the panel editor initialization logic during the transition from dashboard view to panel editor. Provide test script outputs proving whether the datasource picker automatically resolves to and displays the datasource already defined in the panel queries, and identify the responsible codebase location.
- **Alerting API rule creation investigation**: Investigate the alerting API's rule creation process at runtime to determine if the backend's rule definition populates the query state when the edit view is opened. Provide test script output for this behavior and identify the responsible codebase location.

**Category**: Create new documentation
**Documentation Type**: Technical investigation report with runtime evidence

### 0.1.2 Special Instructions and Constraints

- **CRITICAL**: Do not modify any existing repository files. Only temporary scripts may be created during testing, and they must be cleaned up when done.
- **Implementation Rule**: Create a new markdown document named `grafana_4550cfb5b728.md` in the `blitzy/documentation` directory.
- **Evidence requirement**: Every claim about runtime behavior must be backed by actual log output, API response, or test script output.
- **Rationale**: Provide thinking and rationale behind all answers.
- **Truth source**: Base all answers on the code as the truth; do not make assumptions.

### 0.1.3 Technical Interpretation

These documentation requirements translate to the following technical documentation strategy:

- To document idle server behavior, we will **run the Grafana server, wait 60+ seconds with no HTTP requests, and capture the log diff** to determine what recurring entries appear during idle.
- To document the database migration check, we will **start Grafana twice** — first against a fresh database (which triggers full migration) and then against an already-migrated database (which triggers the "skipped" check) — and capture both migration log outputs.
- To verify build information, we will **query `GET /api/health` and `GET /api/frontend/settings`** on the running instance and capture the exact JSON responses containing the version string.
- To investigate the dashboard scene datasource picker resolution, we will **run the existing Jest test suites** for `PanelEditor.test.ts` and `PanelDataQueriesTab.test.tsx` and trace the datasource resolution logic in the source code.
- To investigate alerting rule query state population, we will **create a rule via the ruler API, retrieve it, and run the `alertRuleToQueries` test suite** while tracing the query-state population code path.

### 0.1.4 Inferred Documentation Needs

Based on code analysis:

- The `PanelDataQueriesTab` class in `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx` contains the `loadDataSource()` method responsible for resolving the datasource when the panel editor activates — this is the central code path for the datasource picker question.
- The `alertRuleToQueries` function in `public/app/features/alerting/unified/utils/query.ts` converts stored ruler rule data into `AlertQuery[]` objects for the edit view — this is the central code path for the alerting query state population question.
- The `QueryAndExpressionsStep` component in `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/QueryAndExpressionsStep.tsx` seeds its local reducer state from the current `queries` form value, which itself derives from the rule's `grafana_alert.data` array.
- The Grafana server version string is hardcoded in `pkg/cmd/grafana/main.go` (line 17) as `var version = "9.2.0"` and is overridden at build time via linker flags for release builds.


## 0.2 Documentation Discovery and Analysis


### 0.2.1 Existing Documentation Infrastructure Assessment

Repository analysis reveals a mature documentation infrastructure within the `docs/` directory, managed via a Makefile-based Hugo documentation build system. The docs site workspace is located at `docs/` with source content under `docs/sources/`. The repository also contains comprehensive governance and contributor documentation at the root level (`README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `WORKFLOW.md`, `GOVERNANCE.md`, `MAINTAINERS.md`, etc.).

- **Current documentation framework**: Hugo (doc-site build via `docs/Makefile` and `docs/make-docs`)
- **Documentation generator configuration**: `docs/Makefile`, `docs/docs.mk`, `docs/variables.mk`
- **API documentation tools in use**: OpenAPI specifications in `public/api-merged.json` and `public/openapi3.json`; Go source-level documentation
- **Diagram tools detected**: Mermaid (referenced in `mermaid` blocks within existing tech spec sections)
- **Documentation hosting/deployment**: External Hugo-based docs site (managed via `docs/make-docs` script)
- **Output target for this task**: `blitzy/documentation/grafana_4550cfb5b728.md` — a standalone investigation document, not part of the Hugo site

### 0.2.2 Repository Code Analysis for Documentation

Search patterns used for code to document:

- **Server startup and lifecycle**: `pkg/server/server.go`, `pkg/server/service.go`, `pkg/server/wire.go`, `pkg/cmd/grafana/main.go`
- **Database migration system**: `pkg/services/sqlstore/migrator/migrator.go`, `pkg/services/sqlstore/database_wrapper.go`
- **API health endpoints**: `pkg/api/` (health endpoint handlers), `pkg/setting/setting.go` (build version)
- **Dashboard scene panel editor**: `public/app/features/dashboard-scene/panel-edit/PanelEditor.tsx`, `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx`, `public/app/features/dashboard-scene/panel-edit/PanelEditor.test.ts`
- **Datasource picker resolution**: `public/app/features/dashboard/utils/dashboard.ts` (last-used datasource storage), `public/app/features/datasources/components/picker/utils.ts` (storage persistence)
- **Alerting rule creation API**: `pkg/services/ngalert/api/` (ruler HTTP handlers), `pkg/services/ngalert/store/` (rule persistence)
- **Alerting query state population**: `public/app/features/alerting/unified/utils/query.ts`, `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/QueryAndExpressionsStep.tsx`, `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/reducer.ts`

Key directories examined:

- `pkg/server/` — Server lifecycle and dependency injection
- `pkg/services/sqlstore/migrator/` — Database migration engine
- `pkg/cmd/grafana/` — Main entry point with version constant
- `public/app/features/dashboard-scene/panel-edit/` — Panel editor scene architecture
- `public/app/features/alerting/unified/` — Unified alerting rule editor and utilities
- `conf/` — Default configuration (defaults.ini)

### 0.2.3 Web Search Research Conducted

No external web search was required for this task. All investigation is grounded in the codebase and runtime evidence collected from building and running the Grafana server binary compiled from the repository source.


## 0.3 Documentation Scope Analysis


### 0.3.1 Code-to-Documentation Mapping

- **Module: `pkg/server/server.go` + `pkg/server/service.go`**
  - Public APIs: `Server.Init()`, `Server.Run()`, `Server.Shutdown()`, `coreService.start()`, `coreService.running()`, `coreService.stop()`
  - Current documentation: Covered in tech spec section 4.2 but no runtime evidence documentation
  - Documentation needed: Runtime log analysis of idle behavior and startup sequence

- **Module: `pkg/services/sqlstore/migrator/migrator.go`**
  - Public APIs: `Migrator.Start()`, `Migrator.exec()`, `Migrator.GetMigrationLog()`
  - Current documentation: Architecture overview in tech spec
  - Documentation needed: Runtime evidence of migration check output (fresh vs. already-migrated database)

- **Module: `pkg/cmd/grafana/main.go`**
  - Key variable: `var version = "9.2.0"` (line 17)
  - Current documentation: None specific to build version verification
  - Documentation needed: API endpoint responses confirming the version string at runtime

- **Module: `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx`**
  - Public APIs: `PanelDataQueriesTab` class, `loadDataSource()` method, `onActivate()` handler
  - Current documentation: File-level summary in index
  - Documentation needed: Analysis of datasource resolution flow from panel query state to picker display, with test evidence

- **Module: `public/app/features/alerting/unified/utils/query.ts`**
  - Public APIs: `alertRuleToQueries()`, `widenRelativeTimeRanges()`, `dataQueryToAlertQuery()`
  - Current documentation: None specific
  - Documentation needed: Evidence that the backend's rule definition (via `grafana_alert.data`) populates query state in the edit view

- **Module: `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/QueryAndExpressionsStep.tsx`**
  - Public APIs: `QueryAndExpressionsStep` component, `areQueriesTransformableToSimpleCondition()`
  - Current documentation: None specific
  - Documentation needed: Trace of how the rule's stored query data seeds the reducer state

- **Module: `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/reducer.ts`**
  - Public APIs: `queriesAndExpressionsReducer`, action creators for query management
  - Current documentation: None specific
  - Documentation needed: Test evidence of reducer behavior when seeded with rule query data

### 0.3.2 Documentation Gap Analysis

Given the requirements and repository analysis, documentation gaps include:

- **No runtime evidence documentation exists** for any of the five investigation areas — all investigation results must be newly created.
- **Server idle behavior** has no existing documentation; the tech spec covers startup sequence but not idle-state log patterns.
- **Migration schema-up-to-date verification** has no existing documentation showing the exact log output when migrations are already applied.
- **Build version API verification** has no existing runtime evidence documentation.
- **Dashboard scene datasource resolution** has test coverage but no documentation explaining the flow and providing runtime evidence.
- **Alerting rule query state population** has code-level comments but no consolidated documentation with test evidence.


## 0.4 Documentation Implementation Design


### 0.4.1 Documentation Structure Planning

The output will be a single comprehensive markdown document placed at `blitzy/documentation/grafana_4550cfb5b728.md` following the project rule specifying the branch name as the file name. The document structure:

```
blitzy/documentation/
└── grafana_4550cfb5b728.md
    ├── Introduction
    ├── Environment Setup
    ├── Investigation 1: Server Idle Behavior
    │   ├── Question
    │   ├── Methodology
    │   ├── Runtime Evidence (log output)
    │   ├── Analysis
    │   └── Codebase Reference
    ├── Investigation 2: Database Migration Check
    │   ├── Question
    │   ├── Methodology
    │   ├── Runtime Evidence — Fresh Database (first startup)
    │   ├── Runtime Evidence — Existing Database (second startup)
    │   ├── Analysis
    │   └── Codebase Reference
    ├── Investigation 3: Build Information / API Version String
    │   ├── Question
    │   ├── Methodology
    │   ├── Runtime Evidence — /api/health response
    │   ├── Runtime Evidence — /api/frontend/settings buildInfo
    │   ├── Analysis
    │   └── Codebase Reference
    ├── Investigation 4: Dashboard Scene Datasource Picker Resolution
    │   ├── Question
    │   ├── Methodology
    │   ├── Test Script Output — PanelEditor.test.ts
    │   ├── Test Script Output — PanelDataQueriesTab.test.tsx
    │   ├── Codebase Analysis (datasource resolution flow)
    │   └── Codebase Reference
    ├── Investigation 5: Alerting API Rule Query State Population
    │   ├── Question
    │   ├── Methodology
    │   ├── Runtime Evidence — Rule creation via API
    │   ├── Runtime Evidence — Rule retrieval (query data verification)
    │   ├── Test Script Output — alertRuleToQueries tests
    │   ├── Test Script Output — reducer tests
    │   ├── Codebase Analysis (query state population flow)
    │   └── Codebase Reference
    └── Summary
```

### 0.4.2 Content Generation Strategy

- **Information Extraction Approach**
  - Extract server lifecycle behavior from `pkg/server/server.go` and runtime log output
  - Extract migration behavior from `pkg/services/sqlstore/migrator/migrator.go` and runtime log output
  - Extract build version from `pkg/cmd/grafana/main.go` and API response
  - Extract datasource resolution logic from `PanelDataQueriesTab.tsx` and `PanelEditor.tsx` test output
  - Extract alerting query state flow from `query.ts`, `QueryAndExpressionsStep.tsx`, and `reducer.ts` test output

- **Documentation Standards**
  - All runtime evidence presented in fenced code blocks with appropriate language tags
  - API responses in JSON code blocks
  - Log output in plain code blocks
  - Source code references cite exact file paths and line numbers
  - Mermaid diagrams for complex flows (datasource resolution, alerting query population)

### 0.4.3 Diagram and Visual Strategy

- **Sequence diagram**: Datasource resolution flow during panel editor transition (dashboard view → panel editor → datasource picker)
- **Flowchart**: Alerting rule query state population from backend storage to frontend edit view
- **No screenshots required**: All evidence is textual (log output, API responses, test output)


## 0.5 Documentation File Transformation Mapping


### 0.5.1 File-by-File Documentation Plan

| Target Documentation File | Transformation | Source Code/Docs | Content/Changes |
|---------------------------|----------------|------------------|-----------------|
| `blitzy/documentation/grafana_4550cfb5b728.md` | CREATE | `pkg/server/server.go`, `pkg/server/service.go`, `pkg/services/sqlstore/migrator/migrator.go`, `pkg/cmd/grafana/main.go`, `public/app/features/dashboard-scene/panel-edit/PanelEditor.tsx`, `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx`, `public/app/features/alerting/unified/utils/query.ts`, `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/QueryAndExpressionsStep.tsx`, `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/reducer.ts` | Complete investigation report answering all five questions with runtime evidence, test outputs, codebase analysis, and Mermaid diagrams |

### 0.5.2 New Documentation File Detail

```
File: blitzy/documentation/grafana_4550cfb5b728.md
Type: Technical Investigation Report
Source Code:
  - pkg/server/server.go (server lifecycle, background services)
  - pkg/server/service.go (coreService wrapping with dskit BasicService)
  - pkg/services/sqlstore/migrator/migrator.go (migration engine)
  - pkg/cmd/grafana/main.go:17 (version constant "9.2.0")
  - public/app/features/dashboard-scene/panel-edit/PanelEditor.tsx (panel editor scene factory)
  - public/app/features/dashboard-scene/panel-edit/PanelEditor.test.ts (11 test cases)
  - public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx (datasource resolution)
  - public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx (25 test cases)
  - public/app/features/alerting/unified/utils/query.ts (alertRuleToQueries function)
  - public/app/features/alerting/unified/utils/query.test.ts (2 test cases)
  - public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/QueryAndExpressionsStep.tsx (query/expression step)
  - public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/reducer.ts (query state reducer)
  - public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/reducer.test.tsx (18 test cases)
Runtime Evidence Sources:
  - Grafana server startup logs (first run — fresh DB, 626 migrations executed)
  - Grafana server startup logs (second run — existing DB, 626 migrations skipped)
  - Idle server log capture (90+ seconds, two idle periods)
  - GET /api/health response
  - GET /api/frontend/settings buildInfo response
  - POST ruler API rule creation response
  - GET ruler API rule retrieval response
Diagrams:
  - Datasource resolution flow (Mermaid sequence diagram)
  - Alerting query state population flow (Mermaid flowchart)
Key Citations:
  - pkg/cmd/grafana/main.go:17
  - pkg/services/sqlstore/migrator/migrator.go
  - public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx
  - public/app/features/alerting/unified/utils/query.ts
  - public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/reducer.ts
```

### 0.5.3 Documentation Configuration Updates

No documentation configuration updates are required. This task creates a standalone investigation document in the `blitzy/documentation/` directory and does not integrate into the Hugo docs site or any other documentation framework.


## 0.6 Dependency Inventory


### 0.6.1 Documentation Dependencies

| Registry | Package Name | Version | Purpose |
|----------|--------------|---------|---------|
| Go | go | 1.23.1 | Go runtime for building and running Grafana server binary |
| npm | node | 22.11.0 | Node.js runtime for executing Jest test suites |
| npm | yarn | 4.5.3 | Package manager for frontend dependency management |
| npm | jest | (workspace) | Test runner for frontend unit tests producing evidence |
| Go | github.com/mattn/go-sqlite3 | (go.mod) | SQLite3 driver required for Grafana's default database backend |
| Go | github.com/google/wire | (workspace) | Dependency injection code generation for server initialization |
| npm | @grafana/scenes | (workspace) | Scene framework powering the dashboard-scene panel editor |
| npm | @grafana/data | (workspace) | Core data types including DataSourceApi and PanelData |
| npm | @grafana/runtime | (workspace) | Runtime utilities including getDataSourceSrv and locationService |
| system | gcc | 13.3.0 | C compiler required for CGO-enabled SQLite3 build |
| system | curl | (system) | HTTP client for querying running Grafana API endpoints |

### 0.6.2 Documentation Reference Updates

No link updates are required. The output document is self-contained and does not reference or modify any existing documentation files.


## 0.7 Coverage and Quality Targets


### 0.7.1 Documentation Coverage Metrics

- **Investigation questions answered**: 5/5 (100%)
  - Server idle behavior: Covered with runtime log evidence from two separate 90-second idle periods
  - Database migration check: Covered with log evidence from both fresh-database and existing-database startups
  - Build version API verification: Covered with `/api/health` and `/api/frontend/settings` JSON responses
  - Dashboard scene datasource picker: Covered with test output (11 PanelEditor tests + 25 PanelDataQueriesTab tests all passing) and codebase trace
  - Alerting rule query state population: Covered with API-created rule retrieval, `alertRuleToQueries` tests (2 passing), and reducer tests (18 passing)

- **Runtime evidence artifacts collected**: 7
  - First-run startup log (626 migrations performed, 0 skipped)
  - Second-run startup log (0 migrations performed, 626 skipped)
  - Idle period log (first 90-second window — 0 new entries)
  - Idle period log (second 90-second window — 1 entry: `Usage stats are ready to report`)
  - `/api/health` JSON response
  - `/api/frontend/settings` buildInfo JSON response
  - Alerting ruler API create + retrieve JSON responses

- **Test suites executed**: 4 suites, 56 tests total, 56 passed

### 0.7.2 Documentation Quality Criteria

- **Completeness**: Every question in the user's prompt is addressed with direct runtime evidence and code-level analysis.
- **Accuracy validation**: All runtime evidence was collected from a Grafana server built from the repository source at commit `4550cfb5b7`. API responses and log outputs are verbatim captures.
- **Clarity standards**: Each investigation section follows a consistent structure: Question → Methodology → Runtime Evidence → Analysis → Codebase Reference.
- **Maintainability**: Source file paths and line numbers are cited for all code references, enabling future re-verification.

### 0.7.3 Example and Diagram Requirements

- **Minimum examples per investigation**: 1 runtime evidence block + 1 code reference
- **Diagram types required**: 2 Mermaid diagrams (datasource resolution sequence, alerting query state flowchart)
- **Code example testing**: All code-level claims verified by running test suites
- **Visual content freshness**: All evidence collected from the current repository state (commit `4550cfb5b7`)


## 0.8 Scope Boundaries


### 0.8.1 Exhaustively In Scope

- **New documentation files**:
  - `blitzy/documentation/grafana_4550cfb5b728.md` — the sole output document
- **Runtime evidence collection** (read-only, no repository modifications):
  - Grafana server startup log capture (first run and second run)
  - Idle server log monitoring (90+ seconds per window)
  - API endpoint querying (`/api/health`, `/api/frontend/settings`)
  - Alert rule creation and retrieval via ruler API
- **Test suite execution** (read-only, no repository modifications):
  - `public/app/features/dashboard-scene/panel-edit/PanelEditor.test.ts`
  - `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx`
  - `public/app/features/alerting/unified/utils/query.test.ts`
  - `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/reducer.test.tsx`
- **Codebase analysis** (read-only):
  - `pkg/server/server.go`, `pkg/server/service.go`
  - `pkg/services/sqlstore/migrator/migrator.go`
  - `pkg/cmd/grafana/main.go`
  - `public/app/features/dashboard-scene/panel-edit/PanelEditor.tsx`
  - `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx`
  - `public/app/features/alerting/unified/utils/query.ts`
  - `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/QueryAndExpressionsStep.tsx`
  - `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/reducer.ts`
  - `conf/defaults.ini`

### 0.8.2 Explicitly Out of Scope

- Source code modifications of any kind (per user instruction: "Don't modify any of the repository files")
- Test file modifications
- Feature additions or code refactoring
- Deployment configuration changes
- Documentation outside the five specific investigation questions
- Integration into the Hugo docs site
- Any changes to `docs/`, `README.md`, `CONTRIBUTING.md`, or any other existing documentation files
- Performance benchmarking or load testing
- Security analysis beyond what is directly relevant to the investigation questions


## 0.9 Execution Parameters


### 0.9.1 Documentation-Specific Instructions

- **Grafana server build command**:
  ```
  CGO_ENABLED=1 go run ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server
  CGO_ENABLED=1 go build -tags "oss" -o ./bin/grafana ./pkg/cmd/grafana
  CGO_ENABLED=1 go build -tags "oss" -o ./bin/grafana-server ./pkg/cmd/grafana-server
  ```
- **Grafana server start command**:
  ```
  ./bin/grafana server --homepath="$REPO_DIR" --config="$REPO_DIR/conf/defaults.ini" \
    cfg:default.paths.data="$REPO_DIR/data" cfg:default.paths.logs="$REPO_DIR/data/log" \
    cfg:default.log.mode="console file" cfg:default.log.level=info
  ```
- **Frontend test execution command**:
  ```
  CI=true npx jest --watchAll=false --ci --maxWorkers=2 --verbose \
    --testPathPattern="<test-file-path>" --no-coverage
  ```
- **API query command**:
  ```
  curl -s -u admin:admin http://localhost:3000/api/health
  curl -s -u admin:admin http://localhost:3000/api/frontend/settings
  ```
- **Default format**: Markdown with Mermaid diagrams
- **Citation requirement**: Every section must reference source files with exact paths
- **Style guide**: Each investigation follows Question → Methodology → Runtime Evidence → Analysis → Codebase Reference structure
- **Cleanup requirement**: Any temporary scripts or data files created during testing must be removed before completion


## 0.10 Rules for Documentation


The following rules are explicitly specified by the user and must be strictly observed:

- **Do not modify any existing files in the source repository** — this is a read-only investigation. No repository files may be changed, added, or deleted.
- **If temporary scripts are created for testing, clean them up when done** — any helper scripts written to the filesystem during the investigation process must be deleted before completion.
- **Create a new markdown document named `grafana_4550cfb5b728.md`** — the output file name is derived from the source branch name (`grafana_4550cfb5b728`) and must be placed in the `blitzy/documentation/` directory.
- **Provide thinking and rationale behind all answers** — every conclusion must include the reasoning that led to it, not just the raw evidence.
- **Do not make assumptions; base answers on the code as the truth** — all claims about behavior must be grounded in actual code analysis, log output, API responses, or test results.
- **Provide actual runtime evidence** — log output, API responses, and test script output must be captured and presented verbatim as proof for each investigation question.


## 0.11 References


### 0.11.1 Files and Folders Searched

The following files and folders were inspected to derive the conclusions in this Agent Action Plan:

**Server Lifecycle and Startup**
- `pkg/server/server.go` — Server struct with Init(), Run(), Shutdown() methods and background service orchestration
- `pkg/server/service.go` — coreService wrapper using dskit BasicService for lifecycle management
- `pkg/server/wire.go` — Wire dependency injection declarations
- `pkg/server/wire_gen.go` — Generated wire injection code (generated at build time)
- `pkg/cmd/grafana/main.go` — Entry point containing `var version = "9.2.0"` at line 17
- `pkg/cmd/grafana-server/main.go` — Legacy server entry point delegating to `cmd.RunGrafanaCmd("server")`
- `conf/defaults.ini` — Default configuration including database type (sqlite3), paths, and server port

**Database Migration**
- `pkg/services/sqlstore/migrator/migrator.go` — Migration engine with Locking, Starting, Executing, and Unlocking phases
- `pkg/services/sqlstore/migrator/sqlite_dialect.go` — SQLite-specific dialect implementation
- `pkg/services/sqlstore/database_wrapper.go` — Database driver registration including go-sqlite3

**Dashboard Scene Panel Editor**
- `public/app/features/dashboard-scene/panel-edit/PanelEditor.tsx` — PanelEditor class with buildPanelEditScene() factory, plugin polling, data pane setup, and datasource assignment via `getLastUsedDatasourceFromStorage()`
- `public/app/features/dashboard-scene/panel-edit/PanelEditor.test.ts` — 11 test cases covering initialization, discard, dirty state, repeated panels, library panels, and data pane existence
- `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx` — PanelDataQueriesTab with `loadDataSource()` that reads panel's `queryRunner.state.datasource`, falls back to last-used storage, then falls back to default datasource
- `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx` — 25 test cases covering datasource activation, storage persistence, fallback, switching, time range overrides, query inspection, and dashboard datasource handling
- `public/app/features/dashboard-scene/panel-edit/testfiles/testDashboard.ts` — Test fixture with multiple panel configurations including different datasource scenarios
- `public/app/features/dashboard-scene/serialization/transformSaveModelToScene.ts` — Dashboard-to-scene transformation pipeline
- `public/app/features/dashboard-scene/utils/createPanelDataProvider.ts` — Factory for creating SceneQueryRunner from PanelModel
- `public/app/features/dashboard/utils/dashboard.ts` — `getLastUsedDatasourceFromStorage()` utility
- `public/app/features/query/state/updateQueries.ts` — Query reconciliation during datasource changes

**Alerting Rule Creation and Query State**
- `public/app/features/alerting/unified/utils/query.ts` — `alertRuleToQueries()` converting CombinedRule to AlertQuery[]
- `public/app/features/alerting/unified/utils/query.test.ts` — 2 test cases for Grafana and cloud alert conversion
- `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/QueryAndExpressionsStep.tsx` — Step-2 UI coordinating form state, reducer, and query preview
- `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/reducer.ts` — `queriesAndExpressionsReducer` with actions for query management
- `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/reducer.test.tsx` — 18 test cases for reducer behavior including add, duplicate, remove, update, rewire, and optimize
- `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/useAdvancedMode.ts` — Hook determining advanced vs simplified mode
- `public/app/features/alerting/unified/components/rule-editor/QueryWrapper.tsx` — Per-query row wrapper normalizing datasource metadata
- `public/app/features/alerting/unified/components/rule-viewer/tabs/Query.tsx` — Query tab in rule viewer executing `alertRuleToQueries()`
- `pkg/services/ngalert/api/test-data/post-rulegroup-42.json` — Test fixture for rule group POST payloads
- `pkg/services/ngalert/api/` — Ruler API handlers for rule CRUD

**Configuration**
- `package.json` — Monorepo identity, version `11.5.0-pre`, Node.js engine requirement `>= 22`
- `go.mod` — Go module identity, Go version `1.23.1`
- `.nvmrc` — Node.js version `v22.11.0`
- `jest.config.js` — Jest test runner configuration

**Tech Spec Sections Referenced**
- Section 4.2: SERVER STARTUP AND LIFECYCLE — Initialization bootstrap sequence, background service orchestration, shutdown
- Section 4.5: DASHBOARD LIFECYCLE WORKFLOW — Dashboard retrieval flow, persistence flow, version management
- Section 4.7: UNIFIED ALERTING PIPELINE — Rule scheduling, evaluation, state management, notification delivery

### 0.11.2 Attachments

No attachments were provided for this project.

### 0.11.3 Figma Screens

No Figma screens were provided for this project.

### 0.11.4 Runtime Evidence Artifacts Collected

| Artifact | Description |
|----------|-------------|
| First-run startup log | 1356-line log from fresh database startup with 626 migrations executed and 18 resource migrations |
| Second-run startup log | 62-line log from existing database startup with 0 migrations performed, 626 skipped, and 18 resource migrations skipped |
| First idle period (90s) | 0 new log entries — no recurring log output during idle |
| Second idle period (90s) | 1 new log entry: `logger=infra.usagestats msg="Usage stats are ready to report"` |
| `/api/health` response | `{"database":"ok","version":"9.2.0","commit":"NA"}` |
| `/api/frontend/settings` buildInfo | `{"version":"9.2.0","versionString":"Grafana v9.2.0 (NA)","commit":"NA","edition":"Open Source","latestVersion":"12.4.2","hasUpdate":true,"env":"production"}` |
| Alerting rule creation | Rule `bfilryn01jb40d` created in folder `test-alert-folder` with 3-query pipeline (math → reduce → threshold) |
| Alerting rule retrieval | Full `grafana_alert.data` array returned with all 3 queries including `intervalMs`, `maxDataPoints`, `refId`, `type`, and `expression` fields preserved |
| PanelEditor.test.ts | 11/11 tests passed (initialization, discard, dirty state, repeated panels, library panels, data pane) |
| PanelDataQueriesTab.test.tsx | 25/25 tests passed (datasource load, storage, fallback, switching, time range, inspector, dashboard queries) |
| alertRuleToQueries test | 2/2 tests passed (Grafana alert conversion, cloud alert conversion) |
| reducer test | 18/18 tests passed (add, duplicate, remove, update, rewire, optimize reduce expression) |


