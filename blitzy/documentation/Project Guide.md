# Blitzy Project Guide

---

## 1. Executive Summary

### 1.1 Project Overview

This project creates a runtime-verified technical investigation report for the Grafana open-source observability platform. The deliverable is a single Markdown document (`blitzy/documentation/grafana_4550cfb5b728.md`) answering five investigation questions about Grafana's server idle behavior, database migration checks, API build information, dashboard-scene datasource picker resolution, and alerting rule query state population. The report targets Grafana developers and platform engineers who need evidence-backed understanding of internal runtime behavior. All claims are supported by actual log output, API responses, and Jest test results collected from a Grafana server built from the repository source.

### 1.2 Completion Status

```mermaid
pie title Project Completion
    "Completed (26h)" : 26
    "Remaining (3h)" : 3
```

| Metric | Value |
|--------|-------|
| **Total Project Hours** | 29 |
| **Completed Hours (AI)** | 26 |
| **Remaining Hours** | 3 |
| **Completion Percentage** | 89.7% |

**Calculation:** 26 completed hours / (26 + 3) total hours = 26 / 29 = **89.7% complete**

### 1.3 Key Accomplishments

- ✅ All 5 investigation questions fully answered with runtime-verified evidence
- ✅ 724-line technical investigation report created at `blitzy/documentation/grafana_4550cfb5b728.md`
- ✅ Grafana server built from source (Go wire generation + CGO-enabled binary compilation)
- ✅ 7 runtime evidence artifacts collected (startup logs, idle monitoring, API responses, alert rule CRUD)
- ✅ 4 Jest test suites executed — 56/56 tests passing (100% pass rate)
- ✅ 2 Mermaid diagrams created (datasource resolution sequence diagram, alerting query state flowchart)
- ✅ Consistent document structure: Question → Methodology → Runtime Evidence → Analysis → Codebase Reference
- ✅ Zero existing repository files modified (per AAP constraint)
- ✅ All temporary scripts and data files cleaned up
- ✅ Source code citations include exact file paths and line numbers

### 1.4 Critical Unresolved Issues

| Issue | Impact | Owner | ETA |
|-------|--------|-------|-----|
| Line number citations may drift if source code is modified on the base branch | Low — citations become stale but document logic remains valid | Human Reviewer | 1h to re-verify |
| Runtime evidence timestamps are point-in-time captures | Low — evidence demonstrates behavior patterns, exact timestamps are secondary | N/A | N/A |

### 1.5 Access Issues

No access issues identified. The deliverable is a standalone Markdown file that does not require any external service credentials, API keys, or special repository permissions beyond standard read/write access.

### 1.6 Recommended Next Steps

1. **[High]** Human peer review of technical claims — verify line number citations against current source code
2. **[Medium]** Verify Mermaid diagram rendering in target documentation viewer (GitHub, internal wiki, etc.)
3. **[Medium]** Confirm Markdown formatting renders correctly in the team's documentation platform
4. **[Low]** Consider linking the report from README.md or internal docs index for discoverability
5. **[Low]** Establish a cadence for re-verifying evidence if the referenced source files change significantly

---

## 2. Project Hours Breakdown

### 2.1 Completed Work Detail

| Component | Hours | Description |
|-----------|-------|-------------|
| Codebase Analysis & Discovery | 3 | Analyzed 10+ source files across server lifecycle (`pkg/server/`), migration system (`pkg/services/sqlstore/migrator/`), dashboard-scene panel editor, and alerting system modules |
| Environment Setup & Build | 4 | Go wire code generation, CGO-enabled binary compilation (grafana + grafana-server), Node.js/Yarn frontend setup, SQLite3 database initialization, server configuration |
| Investigation 1: Server Idle Behavior | 2 | Grafana server startup, two 90-second idle period monitoring windows, log diff analysis, `server.go` Run() method and background service architecture code analysis |
| Investigation 2: Database Migration Check | 2.5 | Fresh database startup (626 migrations executed), existing database startup (626 migrations skipped), `migrator.go` run() method analysis, migration log mechanism documentation |
| Investigation 3: Build Information | 1.5 | `/api/health` and `/api/frontend/settings` API queries, `main.go:17` version variable analysis, version propagation flow trace through CLI app → server options → API handlers |
| Investigation 4: Dashboard Datasource Picker | 4.5 | PanelEditor.test.ts execution (11 tests), PanelDataQueriesTab.test.tsx execution (25 tests), `loadDataSource()` resolution flow trace, Mermaid sequence diagram creation |
| Investigation 5: Alerting Rule Query State | 5 | Alert rule creation and retrieval via ruler API, query.test.ts execution (2 tests), reducer.test.tsx execution (18 tests), `alertRuleToQueries()` → `QueryAndExpressionsStep` → reducer flow trace, Mermaid flowchart creation |
| Document Assembly & Formatting | 2.5 | 724-line Markdown document with consistent section structure, fenced code blocks, JSON formatting, summary table, environment setup section, introduction |
| Validation & Bug Fix | 1 | Final Validator review, codebase reference line range correction (commit 2), test output cross-verification, temporary file cleanup confirmation |
| **Total Completed** | **26** | |

### 2.2 Remaining Work Detail

| Category | Hours | Priority |
|----------|-------|----------|
| Human Peer Review — Technical Accuracy | 2 | High |
| Markdown & Mermaid Rendering Verification | 0.5 | Medium |
| Line Number Accuracy Audit | 0.5 | Medium |
| **Total Remaining** | **3** | |

**Verification:** 26 (completed) + 3 (remaining) = 29 (total) ✓

---

## 3. Test Results

| Test Category | Framework | Total Tests | Passed | Failed | Coverage % | Notes |
|---------------|-----------|-------------|--------|--------|------------|-------|
| Unit — Panel Editor | Jest | 11 | 11 | 0 | N/A | `PanelEditor.test.ts`: initialization, discard, dirty state, repeated panels, library panels, data pane |
| Unit — Queries Tab | Jest | 25 | 25 | 0 | N/A | `PanelDataQueriesTab.test.tsx`: datasource activation, storage, fallback, switching, time range, inspector |
| Unit — Alert Query Conversion | Jest | 2 | 2 | 0 | N/A | `query.test.ts`: Grafana alert conversion, cloud alert conversion |
| Unit — Alert Reducer | Jest | 18 | 18 | 0 | N/A | `reducer.test.tsx`: add, duplicate, remove, update, rewire, optimize reduce expression |
| **Totals** | | **56** | **56** | **0** | **100%** | **4 suites, 100% pass rate** |

All tests originate from Blitzy's autonomous validation execution during the investigation process. Coverage was not collected (`--no-coverage` flag used per AAP instructions) to maximize test execution speed.

---

## 4. Runtime Validation & UI Verification

### Runtime Health

- ✅ **Grafana server built from source** — CGO-enabled Go binary compiled successfully with wire dependency injection
- ✅ **Server startup (fresh database)** — 626 core migrations + 18 resource migrations executed; server listening on port 3000
- ✅ **Server startup (existing database)** — 0 migrations performed, 626 skipped; startup completed in under 1ms for migration check
- ✅ **Server idle behavior** — Confirmed silent during 180+ seconds of idle monitoring (one periodic `infra.usagestats` entry)
- ✅ **API health endpoint** — `GET /api/health` returns `{"database":"ok","version":"9.2.0","commit":"NA"}`
- ✅ **API frontend settings** — `GET /api/frontend/settings` returns complete `buildInfo` with version `"9.2.0"`
- ✅ **Alerting ruler API** — Rule created (`POST`) and retrieved (`GET`) with complete `grafana_alert.data` array intact
- ✅ **All Jest test suites** — 56/56 tests passing across 4 suites

### API Integration Verification

- ✅ `GET /api/health` — Returns HTTP 200 with database status and version
- ✅ `GET /api/frontend/settings` — Returns HTTP 200 with full `buildInfo` object
- ✅ `POST /api/ruler/grafana/api/v1/rules/:namespace` — Rule creation returns success with UID
- ✅ `GET /api/ruler/grafana/api/v1/rules` — Rule retrieval returns complete query definitions

### UI Verification

- ⚠ **Not applicable** — This is a documentation-only project. No UI components were created or modified. The investigation verified behavior through test suites and API calls rather than visual UI testing.

---

## 5. Compliance & Quality Review

| Compliance Criterion | Status | Evidence |
|---------------------|--------|----------|
| All 5 investigation questions answered | ✅ Pass | Sections for each investigation in `grafana_4550cfb5b728.md` |
| Runtime evidence for every behavioral claim | ✅ Pass | Log output, API JSON responses, and test output in fenced code blocks |
| Thinking and rationale provided for all answers | ✅ Pass | "Analysis" subsection in each investigation with numbered reasoning |
| Code-as-truth principle (no assumptions) | ✅ Pass | All claims cite specific file paths and line numbers |
| No existing repository files modified | ✅ Pass | `git diff --name-status` shows only `A blitzy/documentation/grafana_4550cfb5b728.md` |
| Temporary scripts cleaned up | ✅ Pass | `git status` shows clean working tree; no data directory remains |
| Consistent structure (Q→M→E→A→CR) | ✅ Pass | All 5 investigations follow identical section pattern |
| Mermaid diagrams (2 required) | ✅ Pass | Sequence diagram (Investigation 4) + flowchart (Investigation 5) |
| Source file citations with line numbers | ✅ Pass | 15+ specific line range citations throughout document |
| Test suites executed as evidence | ✅ Pass | 4 suites, 56 tests, 56 passed |

### Fixes Applied During Autonomous Validation

| Fix | Description | Commit |
|-----|-------------|--------|
| Codebase reference line range correction | Corrected line range in Investigation 3 codebase reference section | `6466c292f9` |

---

## 6. Risk Assessment

| Risk | Category | Severity | Probability | Mitigation | Status |
|------|----------|----------|-------------|------------|--------|
| Line number citations become stale if source files are modified | Technical | Low | Medium | Human reviewer should spot-check line references against current code; consider using function name anchors instead of line numbers | Open |
| Runtime evidence timestamps are point-in-time | Technical | Low | Low | Timestamps demonstrate behavior patterns; re-execution would produce equivalent behavior with different timestamps | Accepted |
| Mermaid diagrams may not render in all Markdown viewers | Operational | Low | Medium | Test rendering in GitHub, GitLab, or target documentation platform before publishing | Open |
| Document not linked from any index or navigation | Integration | Low | High | Currently a standalone file; should be linked from README or internal docs for discoverability | Open |
| Grafana version constant changes in future commits | Technical | Low | Medium | Document states the version at time of investigation (`9.2.0` from `main.go:17`); future changes would need re-verification | Accepted |
| Default admin credentials used for API testing | Security | Low | Low | `admin:admin` is the Grafana default for development instances; not a production concern | Accepted |

---

## 7. Visual Project Status

```mermaid
pie title Project Hours Breakdown
    "Completed Work" : 26
    "Remaining Work" : 3
```

### Remaining Work by Priority

| Priority | Hours | Items |
|----------|-------|-------|
| High | 2 | Human peer review of technical accuracy |
| Medium | 1 | Markdown/Mermaid rendering verification, line number audit |
| **Total** | **3** | |

---

## 8. Summary & Recommendations

### Achievements

The project has successfully delivered a 724-line technical investigation report answering all five AAP-scoped questions with runtime-verified evidence. The Grafana server was built from source, started against both fresh and existing databases, monitored during idle, queried via API, and tested via four Jest test suites (56/56 passing). Two Mermaid diagrams illustrate the datasource resolution and alerting query state population flows. The document follows a consistent Question → Methodology → Runtime Evidence → Analysis → Codebase Reference structure with exact file path and line number citations throughout.

### Remaining Gaps

The project is **89.7% complete** (26 of 29 total hours). The remaining 3 hours consist entirely of human review and verification tasks:

- **Technical accuracy review** (2h) — A human reviewer should verify that the cited line numbers still correspond to the correct code in the current branch state, and confirm the analysis logic is sound.
- **Rendering verification** (0.5h) — The Mermaid diagrams and Markdown formatting should be verified in the target documentation platform.
- **Line number audit** (0.5h) — If any referenced source files have changed since the investigation, line number citations should be updated.

### Critical Path to Production

1. Human reviewer verifies technical claims and line number citations
2. Confirm Mermaid diagrams render in the team's documentation viewer
3. Merge PR to base branch

### Production Readiness Assessment

The documentation deliverable is production-ready for merge. The content is complete, all evidence is presented verbatim, and no existing repository files were modified. The only remaining work is standard human review before publishing.

---

## 9. Development Guide

### System Prerequisites

| Software | Version | Purpose |
|----------|---------|---------|
| Go | 1.23.1 | Build Grafana server binary |
| Node.js | 22.11.0 | Run Jest test suites |
| Yarn | 4.5.3 | Frontend package management |
| GCC | 13.3.0+ | CGO compilation for SQLite3 driver |
| curl | Any | API endpoint queries |

### Environment Setup

```bash
# Clone the repository and switch to the branch
git clone https://github.com/blitzy-research/grafana.git
cd grafana
git checkout grafana_4550cfb5b728

# Verify Go version
go version
# Expected: go version go1.23.1 linux/amd64

# Verify Node.js version
node --version
# Expected: v22.11.0

# Install frontend dependencies
yarn install
```

### Building Grafana from Source

```bash
# Step 1: Generate wire dependency injection code
CGO_ENABLED=1 go run ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server

# Step 2: Build the Grafana CLI binary
CGO_ENABLED=1 go build -tags "oss" -o ./bin/grafana ./pkg/cmd/grafana

# Step 3: Build the Grafana server binary
CGO_ENABLED=1 go build -tags "oss" -o ./bin/grafana-server ./pkg/cmd/grafana-server
```

### Starting the Grafana Server

```bash
# Set repository directory
export REPO_DIR=$(pwd)

# Start the server with default SQLite3 database
./bin/grafana server \
  --homepath="$REPO_DIR" \
  --config="$REPO_DIR/conf/defaults.ini" \
  cfg:default.paths.data="$REPO_DIR/data" \
  cfg:default.paths.logs="$REPO_DIR/data/log" \
  cfg:default.log.mode="console file" \
  cfg:default.log.level=info
```

### Verification Steps

```bash
# Verify server is running (in a separate terminal)
curl -s -u admin:admin http://localhost:3000/api/health
# Expected: {"database":"ok","version":"9.2.0","commit":"NA"}

# Verify frontend settings
curl -s -u admin:admin http://localhost:3000/api/frontend/settings | python3 -m json.tool | grep version
# Expected: "version": "9.2.0"
```

### Running the Test Suites

```bash
# Panel Editor tests (11 tests)
CI=true npx jest --watchAll=false --ci --maxWorkers=2 --verbose \
  --testPathPattern="public/app/features/dashboard-scene/panel-edit/PanelEditor.test.ts" --no-coverage

# Panel Data Queries Tab tests (25 tests)
CI=true npx jest --watchAll=false --ci --maxWorkers=2 --verbose \
  --testPathPattern="public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx" --no-coverage

# Alert Rule to Queries tests (2 tests)
CI=true npx jest --watchAll=false --ci --maxWorkers=2 --verbose \
  --testPathPattern="public/app/features/alerting/unified/utils/query.test.ts" --no-coverage

# Alert Reducer tests (18 tests)
CI=true npx jest --watchAll=false --ci --maxWorkers=2 --verbose \
  --testPathPattern="public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/reducer.test.tsx" --no-coverage
```

### Troubleshooting

| Issue | Resolution |
|-------|-----------|
| `CGO_ENABLED` build failures | Ensure GCC is installed: `sudo apt-get install -y build-essential` |
| Wire generation fails | Run `go mod download` first to ensure all Go dependencies are cached |
| Jest tests fail to start | Run `yarn install` to ensure frontend dependencies are installed |
| Server port 3000 already in use | Kill existing process: `lsof -ti :3000 \| xargs kill` |
| SQLite3 database locked | Remove stale data directory: `rm -rf data/` and restart |
| Default admin password rejected | Default credentials are `admin:admin` on first startup |

---

## 10. Appendices

### A. Command Reference

| Command | Purpose |
|---------|---------|
| `CGO_ENABLED=1 go run ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server` | Generate wire dependency injection code |
| `CGO_ENABLED=1 go build -tags "oss" -o ./bin/grafana ./pkg/cmd/grafana` | Build Grafana CLI binary |
| `CGO_ENABLED=1 go build -tags "oss" -o ./bin/grafana-server ./pkg/cmd/grafana-server` | Build Grafana server binary |
| `./bin/grafana server --homepath=... --config=...` | Start Grafana server |
| `curl -s -u admin:admin http://localhost:3000/api/health` | Query health endpoint |
| `curl -s -u admin:admin http://localhost:3000/api/frontend/settings` | Query frontend settings |
| `CI=true npx jest --watchAll=false --ci --maxWorkers=2 --verbose --testPathPattern="..." --no-coverage` | Run Jest test suite |

### B. Port Reference

| Port | Service | Protocol |
|------|---------|----------|
| 3000 | Grafana HTTP server | HTTP |

### C. Key File Locations

| File | Purpose |
|------|---------|
| `blitzy/documentation/grafana_4550cfb5b728.md` | The deliverable — technical investigation report (724 lines) |
| `pkg/cmd/grafana/main.go` | Entry point with `var version = "9.2.0"` at line 17 |
| `pkg/server/server.go` | Server lifecycle: `Init()`, `Run()`, `Shutdown()` |
| `pkg/server/service.go` | `coreService` wrapper with dskit BasicService |
| `pkg/services/sqlstore/migrator/migrator.go` | Database migration engine with `run()` method |
| `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx` | Datasource resolution via `loadDataSource()` |
| `public/app/features/alerting/unified/utils/query.ts` | `alertRuleToQueries()` conversion function |
| `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/reducer.ts` | `queriesAndExpressionsReducer` for query state management |
| `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/QueryAndExpressionsStep.tsx` | Step-2 UI component seeding reducer from form state |
| `conf/defaults.ini` | Default Grafana configuration (SQLite3 database, port 3000) |

### D. Technology Versions

| Technology | Version | Source |
|------------|---------|--------|
| Go | 1.23.1 | `go.mod` |
| Node.js | 22.11.0 | `.nvmrc` |
| Yarn | 4.5.3 | `package.json` engines |
| Grafana (source) | 11.5.0-pre | `package.json` version field |
| Grafana (runtime binary) | 9.2.0 | `pkg/cmd/grafana/main.go:17` default |
| Jest | Workspace-managed | `jest.config.js` |
| SQLite3 (CGO) | go-sqlite3 | `go.mod` dependency |

### E. Environment Variable Reference

| Variable | Purpose | Default |
|----------|---------|---------|
| `CGO_ENABLED` | Enable CGO for SQLite3 driver compilation | Must be set to `1` |
| `REPO_DIR` | Repository root path for `--homepath` flag | Current working directory |
| `CI` | Signals CI mode to Jest (prevents watch mode) | Set to `true` for test execution |

### F. Developer Tools Guide

| Tool | Usage |
|------|-------|
| `go build` | Compile Go binaries with `-tags "oss"` for open-source build |
| `npx jest` | Execute frontend unit tests with `--watchAll=false --ci` flags |
| `curl` | Query Grafana API endpoints with `-u admin:admin` for default auth |
| `python3 -m json.tool` | Pretty-print JSON API responses |
| `git diff --name-status` | Verify no existing repository files were modified |

### G. Glossary

| Term | Definition |
|------|------------|
| **AAP** | Agent Action Plan — the directive defining all project requirements |
| **CGO** | C-Go interop allowing Go to call C libraries (required for SQLite3 driver) |
| **Wire** | Google's compile-time dependency injection framework used by Grafana |
| **dskit** | Grafana's distributed systems toolkit providing `BasicService` lifecycle management |
| **SceneQueryRunner** | Grafana Scenes framework object managing panel query execution state |
| **Ruler API** | Grafana's alerting rule management API (`/api/ruler/grafana/api/v1/rules`) |
| **`alertRuleToQueries()`** | Function converting a stored alert rule into `AlertQuery[]` for the editor UI |
| **`loadDataSource()`** | Method in `PanelDataQueriesTab` resolving the active datasource when panel editor activates |
| **Migration log** | Database table (`migration_log`) tracking which schema migrations have been executed |