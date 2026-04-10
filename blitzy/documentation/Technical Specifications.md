# Technical Specification

# 0. Agent Action Plan

## 0.1 Intent Clarification

### 0.1.1 Core Documentation Objective

Based on the provided requirements, the Blitzy platform understands that the documentation objective is to **create new documentation** that comprehensively answers a practical question about Grafana's internal panel-query execution lifecycle, based entirely on source-code analysis and runtime-observable behavior.

- **Category**: Create new documentation
- **Documentation type**: Technical investigation / Q&A document
- **Target artifact**: `blitzy/documentation/grafana_4550cfb5b728.md` (per the `SWE-AtlasQnA-Repo` implementation rule, the file is named after the source branch `grafana_4550cfb5b728`)

The user's request distils into six concrete documentation objectives:

- **Objective 1 — End-to-end query flow**: Describe, at the code level, the complete path a panel query takes from browser initiation to rendered response, covering both the frontend observable pipeline and the backend HTTP handler chain.
- **Objective 2 — Browser-side request issuance**: Document how `PanelQueryRunner` and `runRequest()` construct a `DataQueryRequest`, how `DataSourceWithBackend.query()` serialises and dispatches it via `BackendSrv.fetch()`, and the network request that reaches the server.
- **Objective 3 — Backend handling**: Explain how the `POST /api/ds/query` endpoint (or the K8s rewrite path) receives the request, resolves the data source, routes to the `pkg/tsdb/` backend, and returns a `QueryDataResponse`.
- **Objective 4 — Response path**: Show how the JSON streaming response is converted by `toDataQueryResponse()`, merged by `processResponsePacket()`, wrapped in `PanelData`, and delivered to the panel visualisation.
- **Objective 5 — Repeated-query comparison**: Analyse the observable differences when the same query is executed twice in quick succession — covering request cancellation via `requestId` / `inFlightRequests`, the OSS no-op caching service, `structureRev` de-duplication, and any HTTP header evidence of caching.
- **Objective 6 — Observable artefacts**: Catalogue all logs, network requests, headers, and metadata that an operator can inspect at runtime to trace query processing, including `grafana-trace-id`, `X-Cache`, `X-Plugin-Id`, `X-Datasource-Uid`, and backend debug logs.

### 0.1.2 Special Instructions and Constraints

- **No source-code modifications**: The user explicitly states "Do not modify the source code; use runtime observation only." All documentation must be derived from reading the existing codebase and describing what would be observable at runtime, not from instrumenting or patching it.
- **Clean up temporary artefacts**: Any artefacts (e.g., provisioned dashboards, data-source records) described in the document that would be created during observation should include teardown instructions.
- **Built-in data source**: The investigation targets a built-in data source. The TestData data source (`grafana-testdata-datasource`) is the canonical built-in source for this purpose, as it ships with Grafana, requires no external backend, and supports backend-executed query scenarios.
- **Implementation rule — SWE-AtlasQnA-Repo**: The output is a single Markdown document placed at `blitzy/documentation/grafana_4550cfb5b728.md`. No existing files may be modified.
- **Thinking / rationale required**: The document must include reasoning and rationale behind each answer, grounded in the code.

### 0.1.3 Technical Interpretation

These documentation requirements translate to the following technical documentation strategy:

- To **document the end-to-end query flow**, we will create a new Markdown file that traces the lifecycle from the frontend `PanelQueryRunner.run()` through the HTTP layer to `pkg/api/ds_query.go` and back, citing specific source files and functions at each stage.
- To **explain browser-side request issuance**, we will describe the `DataQueryRequest` construction in `PanelQueryRunner.ts`, the dispatch through `DataSourceWithBackend.query()` in `packages/grafana-runtime/src/utils/DataSourceWithBackend.ts`, and the actual `POST /api/ds/query` fetch in `BackendSrv`.
- To **explain backend handling**, we will document the handler chain: `ds_query.go → queryDataService.QueryData → parsedRequest → plugin client.QueryData → TestData service.QueryData`, citing the Go source files.
- To **explain the response path**, we will trace from the backend `QueryDataResponse` through JSON streaming, the frontend `toDataQueryResponse()`, `processResponsePacket()`, and `preProcessPanelData()`.
- To **compare repeated-query behaviour**, we will describe the `requestId`-based cancellation in `BackendSrv`, the OSS no-op cache service, the `X-Cache` header pipeline, the `structureRev` de-duplication in `PanelQueryRunner`, and the Prometheus `QueryCache` (for Prometheus-type sources).
- To **catalogue observable artefacts**, we will list all relevant HTTP headers, server logs, tracing spans, and Chrome DevTools network observations.

### 0.1.4 Inferred Documentation Needs

Based on code analysis, the following implicit documentation needs have been identified:

- **Middleware chain context**: The document should briefly describe the middleware stages (tracing, auth, CSRF) that every query request passes through before reaching the handler, since these produce observable artefacts (e.g., `grafana-trace-id` header).
- **Expression engine boundary**: When query targets include expressions (`__expr__`), the backend routes through `pkg/expr/`. The document should clarify where this branching occurs even though the primary investigation uses a simple TestData query.
- **Feature-flag awareness**: The `FlagQueryServiceRewrite` feature flag can redirect queries to the K8s API path. The document should note this variant path.
- **Request cancellation lifecycle**: The frontend `inFlightRequests` subject and `cancelNetworkRequestsOnUnsubscribe` operator are critical to understanding repeated-query behaviour and must be documented.
- **Prometheus QueryCache**: Although the primary investigation uses TestData, the document should note that the Prometheus datasource has a frontend-side `QueryCache` (`packages/grafana-prometheus/src/querycache/QueryCache.ts`) that performs incremental backfill — a qualitatively different caching strategy not present for TestData.


## 0.2 Documentation Discovery and Analysis

### 0.2.1 Existing Documentation Infrastructure Assessment

Repository analysis reveals a Hugo-based documentation site with source files under `docs/sources/` and a contributor handbook under `contribute/`. The project does not use MkDocs, Docusaurus, or Sphinx; the docs build is driven by a Makefile in `docs/` with Hugo-style front matter (YAML) in Markdown source files.

- **Documentation framework**: Hugo (via the Grafana docs pipeline), driven by `docs/Makefile` and `docs/docs.mk`
- **Documentation generator configuration location**: `docs/Makefile`, `docs/docs.mk`, `docs/variables.mk`
- **API documentation tools in use**: Swagger/go-swagger annotations in Go source files (e.g., `pkg/api/dataproxy.go`, `pkg/api/ds_query.go`); no JSDoc or TypeDoc generation detected for frontend code
- **Diagram tools detected**: Mermaid (used extensively in tech spec and contributor docs)
- **Documentation hosting/deployment**: Grafana docs site (grafana.com/docs)

Relevant existing documentation discovered:

| File | Content | Relevance |
|------|---------|-----------|
| `contribute/architecture/frontend-data-requests.md` | Describes `BackendSrv` request cancellation and the request queue | Directly relevant — covers cancellation semantics for repeated queries |
| `docs/sources/developers/http_api/query_and_resource_caching.md` | Enterprise caching API endpoints (enable/disable/clean/configure cache) | Tangentially relevant — describes cache management, not query-level caching behaviour |
| `docs/sources/datasources/testdata/_index.md` | TestData data source user guide: setup, scenarios, dashboard import | Relevant — confirms TestData as the built-in observation target |
| `docs/sources/developers/http_api/query_history.md` | Query history API | Low relevance |
| `contribute/architecture/README.md` | Architecture contributor guide index | Index only |

### 0.2.2 Repository Code Analysis for Documentation

Search patterns used for code under investigation:

- **Frontend query execution pipeline**: `public/app/features/query/state/PanelQueryRunner.ts`, `runRequest.ts`, `QueryRunner.ts`, `processing/canceler.ts`, `processing/revision.ts`
- **Frontend backend service**: `public/app/core/services/backend_srv.ts`
- **Frontend datasource base class**: `packages/grafana-runtime/src/utils/DataSourceWithBackend.ts`
- **Frontend query runner contract**: `packages/grafana-data/src/types/queryRunner.ts`
- **Frontend runtime service bootstrap**: `packages/grafana-runtime/src/services/QueryRunner.ts`
- **Frontend TestData datasource**: `public/app/plugins/datasource/grafana-testdata-datasource/datasource.ts`
- **Frontend Prometheus query cache**: `packages/grafana-prometheus/src/querycache/QueryCache.ts`
- **Backend query API handler**: `pkg/api/ds_query.go`
- **Backend query service**: `pkg/services/query/query.go`
- **Backend K8s query endpoint**: `pkg/registry/apis/query/query.go`
- **Backend datasource sub-query adapter**: `pkg/registry/apis/datasource/sub_query.go`
- **Backend caching service interface**: `pkg/services/caching/service.go`
- **Backend caching middleware**: `pkg/services/pluginsintegration/clientmiddleware/caching_middleware.go`
- **Backend middleware (no-cache headers)**: `pkg/middleware/middleware.go`
- **Backend TestData service**: `pkg/tsdb/grafana-testdata-datasource/testdata.go`, `scenarios.go`
- **Backend Prometheus query handler**: `pkg/promlib/querydata/request.go`

Key directories examined:

- `public/app/features/query/state/` — Frontend query state management
- `public/app/plugins/datasource/grafana-testdata-datasource/` — TestData plugin
- `packages/grafana-runtime/src/` — Runtime utilities, services, `DataSourceWithBackend`
- `packages/grafana-data/src/types/` — Shared type contracts
- `pkg/api/` — Backend HTTP API handlers
- `pkg/services/query/` — Backend query orchestration service
- `pkg/services/caching/` — Caching service interface and OSS no-op
- `pkg/services/pluginsintegration/clientmiddleware/` — Plugin client middleware (caching, etc.)
- `pkg/middleware/` — HTTP middleware (auth, headers, caching flags)
- `pkg/tsdb/grafana-testdata-datasource/` — TestData Go backend
- `pkg/registry/apis/query/` — K8s-style query API
- `contribute/architecture/` — Contributor architecture docs

### 0.2.3 Web Search Research Conducted

No external web research was required for this task. The codebase itself is the authoritative source of truth for documenting runtime behaviour, and the user explicitly requested code-based analysis ("Do not modify the source code; use runtime observation only"). All answers must be grounded in the repository.


## 0.3 Documentation Scope Analysis

### 0.3.1 Code-to-Documentation Mapping

The documentation must trace the panel-query lifecycle through every layer of the Grafana stack. The modules requiring documentation coverage are mapped below:

- **Module**: `public/app/features/query/state/PanelQueryRunner.ts`
  - Public APIs: `PanelQueryRunner.run()`, `PanelQueryRunner.getData()`, `getNextRequestId()`
  - Current documentation: No dedicated docs; partial coverage in `contribute/architecture/frontend-data-requests.md` (cancellation only)
  - Documentation needed: Lifecycle narrative — how `run()` builds a `DataQueryRequest`, resolves the datasource, computes intervals, and dispatches via `runRequest()`

- **Module**: `public/app/features/query/state/runRequest.ts`
  - Public APIs: `runRequest()`, `processResponsePacket()`, `callQueryMethod()`
  - Current documentation: None
  - Documentation needed: Observable pipeline description — timer-based loading state, packet merging, error handling, cancellation teardown

- **Module**: `packages/grafana-runtime/src/utils/DataSourceWithBackend.ts`
  - Public APIs: `DataSourceWithBackend.query()`, header construction, endpoint routing
  - Current documentation: None (internal API)
  - Documentation needed: Request serialisation, header attachment (`X-Plugin-Id`, `X-Datasource-Uid`), endpoint selection (`/api/ds/query` vs. query service)

- **Module**: `public/app/core/services/backend_srv.ts`
  - Public APIs: `BackendSrv.fetch()`, `internalFetch()`, request cancellation via `inFlightRequests`
  - Current documentation: Partial in `contribute/architecture/frontend-data-requests.md`
  - Documentation needed: The actual HTTP dispatch mechanics, `requestId` cancellation behaviour, device-ID header injection

- **Module**: `pkg/api/ds_query.go`
  - Public APIs: `QueryMetricsV2` handler, `getDSQueryEndpoint()`, `handleQueryMetricsError()`
  - Current documentation: Swagger annotations in source; tech spec section 4.6
  - Documentation needed: Narrative of how the handler receives the `MetricRequest`, delegates to `queryDataService`, and streams the response

- **Module**: `pkg/services/query/query.go`
  - Public APIs: `ServiceImpl.QueryData()`, `parseMetricRequest()`, `handleQuerySingleDatasource()`
  - Current documentation: None
  - Documentation needed: Query routing logic — single vs. multi-datasource, expression detection, concurrent execution

- **Module**: `pkg/services/caching/service.go` and `pkg/services/pluginsintegration/clientmiddleware/caching_middleware.go`
  - Public APIs: `CachingService` interface, `HandleQueryRequest()`, `CachingMiddleware.QueryData()`
  - Current documentation: Enterprise caching HTTP API docs only
  - Documentation needed: Explanation that OSS uses a no-op cache service; the middleware still runs but always returns cache-miss; Enterprise provides real caching

- **Module**: `pkg/middleware/middleware.go`
  - Public APIs: `HandleNoCacheHeaders()`, `AddDefaultResponseHeaders()`
  - Current documentation: None
  - Documentation needed: How `X-Grafana-NoCache` and `X-Cache-Skip` headers are read, how `grafana-trace-id` and `Cache-Control: no-store` are set on responses

- **Module**: `pkg/tsdb/grafana-testdata-datasource/testdata.go` and `scenarios.go`
  - Public APIs: `Service.QueryData()`, scenario registration, `handleRandomWalk()`
  - Current documentation: User-facing docs at `docs/sources/datasources/testdata/_index.md`
  - Documentation needed: Backend execution trace — how the query mux routes a `scenarioId` to a handler and produces a `backend.QueryDataResponse`

### 0.3.2 Documentation Gap Analysis

Given the requirements and repository analysis, documentation gaps include:

- **Undocumented end-to-end query lifecycle**: No existing document traces a single panel query from browser click to panel render across both frontend and backend. The contributor guide covers only cancellation.
- **Missing backend query-handler narrative**: The tech spec (section 4.6) provides a high-level flow diagram but does not explain the per-function trace that would answer "what happens when I click refresh."
- **Missing caching-at-runtime explanation**: The Enterprise caching HTTP API is documented, but there is no documentation explaining what an OSS user would observe in cache-related headers and logs.
- **Missing repeated-query behaviour documentation**: No existing documentation describes what happens when the same query is re-issued: whether `requestId` cancellation fires, whether `structureRev` suppresses duplicate emissions, or whether any server-side caching applies.
- **Missing observable-artefacts catalogue**: No reference document lists all the HTTP headers, server logs, and tracing metadata that an operator can use to trace a query through the system.


## 0.4 Documentation Implementation Design

### 0.4.1 Documentation Structure Planning

The output is a single comprehensive Markdown document. Per the `SWE-AtlasQnA-Repo` rule, it is placed at:

```
blitzy/
└── documentation/
    └── grafana_4550cfb5b728.md
```

The internal structure of the document follows a logical progression through the query lifecycle:

```
grafana_4550cfb5b728.md
├── Introduction (purpose, scope, methodology)
├── Prerequisites & Setup (enabling TestData, creating a panel)
├── The End-to-End Query Flow
│   ├── Frontend: Panel Refresh Trigger
│   ├── Frontend: DataQueryRequest Construction (PanelQueryRunner)
│   ├── Frontend: Datasource Dispatch (DataSourceWithBackend.query)
│   ├── Frontend: HTTP Transport (BackendSrv.fetch → POST /api/ds/query)
│   ├── Backend: Middleware Chain (tracing, auth, RBAC, no-cache headers)
│   ├── Backend: Query Handler (ds_query.go → QueryDataService)
│   ├── Backend: Datasource Routing (query.go → plugin client → TestData)
│   ├── Backend: TestData Execution (testdata.go → scenarios.go)
│   ├── Backend: Response Assembly (QueryDataResponse, JSON streaming)
│   ├── Frontend: Response Processing (toDataQueryResponse, processResponsePacket)
│   └── Frontend: Panel Rendering (PanelData emission via ReplaySubject)
├── Repeated Query Execution
│   ├── Request Cancellation via requestId (inFlightRequests subject)
│   ├── OSS Caching Behaviour (no-op CachingService, X-Cache header absence)
│   ├── structureRev De-duplication
│   └── Prometheus QueryCache Contrast (incremental backfill, not applicable to TestData)
├── Observable Artefacts Catalogue
│   ├── Network Requests (URL, method, headers, body shape)
│   ├── Response Headers (grafana-trace-id, Cache-Control, X-Cache)
│   ├── Backend Logs (query debug logging, tracing spans)
│   └── Chrome DevTools Observations
├── Cleanup Instructions
└── Summary / Rationale
```

### 0.4.2 Content Generation Strategy

**Information Extraction Approach**:

- Extract the `DataQueryRequest` construction from `PanelQueryRunner.ts` lines 275–310 (the `run()` method)
- Extract the HTTP dispatch from `DataSourceWithBackend.ts` — the `query()` method that routes through `/api/ds/query`
- Extract the backend handler chain from `pkg/api/ds_query.go` (the `QueryMetricsV2` handler)
- Extract query service routing from `pkg/services/query/query.go` (the `QueryData` method)
- Extract TestData execution from `pkg/tsdb/grafana-testdata-datasource/testdata.go` (the `QueryData` → mux dispatch)
- Extract caching evidence from `pkg/services/caching/service.go` (the OSS no-op) and `pkg/services/pluginsintegration/clientmiddleware/caching_middleware.go`
- Extract cancellation behaviour from `public/app/core/services/backend_srv.ts` (the `inFlightRequests` subject and `resolveCancelerIfExists`)

**Documentation Standards**:

- Markdown with `#` / `##` / `###` headers
- Mermaid sequence and flow diagrams for the query lifecycle
- Short inline code snippets citing `Source: /path/to/file.ts:LineNumber`
- Tables for header catalogues and comparison matrices
- Consistent terminology: "panel query", "data query request", "query data response"

### 0.4.3 Diagram and Visual Strategy

Mermaid diagrams to create within the output document:

- **Sequence diagram**: Browser → BackendSrv → Grafana Server → TestData backend → Response, showing each hop with message names
- **Flowchart**: Backend handler chain from `POST /api/ds/query` through middleware, query service, plugin client, and TestData service
- **Sequence diagram**: Two rapid queries showing cancellation of the first request via `inFlightRequests`
- **Component diagram**: Observable artefacts mapped to the pipeline stage where they are produced (headers, logs, tracing spans)

No screenshots are required — all observations are described textually with exact header names, log messages, and code paths.


## 0.5 Documentation File Transformation Mapping

### 0.5.1 File-by-File Documentation Plan

| Target Documentation File | Transformation | Source Code/Docs | Content/Changes |
|---------------------------|----------------|------------------|-----------------|
| `blitzy/documentation/grafana_4550cfb5b728.md` | CREATE | `public/app/features/query/state/PanelQueryRunner.ts`, `public/app/features/query/state/runRequest.ts`, `packages/grafana-runtime/src/utils/DataSourceWithBackend.ts`, `public/app/core/services/backend_srv.ts`, `pkg/api/ds_query.go`, `pkg/services/query/query.go`, `pkg/tsdb/grafana-testdata-datasource/testdata.go`, `pkg/tsdb/grafana-testdata-datasource/scenarios.go`, `pkg/services/caching/service.go`, `pkg/services/pluginsintegration/clientmiddleware/caching_middleware.go`, `pkg/middleware/middleware.go`, `public/app/features/query/state/processing/canceler.ts`, `public/app/features/query/state/processing/revision.ts`, `packages/grafana-prometheus/src/querycache/QueryCache.ts`, `contribute/architecture/frontend-data-requests.md` | Complete Q&A document tracing the panel-query lifecycle end-to-end, comparing repeated-query behaviour, and cataloguing observable artefacts. Includes Mermaid diagrams, header tables, and code-grounded rationale. |

### 0.5.2 New Documentation File Detail

```
File: blitzy/documentation/grafana_4550cfb5b728.md
Type: Technical Investigation / Q&A Document
Source Code:
  - public/app/features/query/state/PanelQueryRunner.ts (frontend query orchestrator)
  - public/app/features/query/state/runRequest.ts (observable query pipeline)
  - packages/grafana-runtime/src/utils/DataSourceWithBackend.ts (datasource base class)
  - public/app/core/services/backend_srv.ts (HTTP transport layer)
  - public/app/features/query/state/processing/canceler.ts (request cancellation)
  - public/app/features/query/state/processing/revision.ts (structureRev tracking)
  - pkg/api/ds_query.go (backend query HTTP handler)
  - pkg/services/query/query.go (backend query orchestration service)
  - pkg/services/caching/service.go (caching service interface + OSS no-op)
  - pkg/services/pluginsintegration/clientmiddleware/caching_middleware.go (caching middleware)
  - pkg/middleware/middleware.go (HTTP middleware: cache headers, trace-id, security)
  - pkg/tsdb/grafana-testdata-datasource/testdata.go (TestData service entry point)
  - pkg/tsdb/grafana-testdata-datasource/scenarios.go (TestData scenario handlers)
  - packages/grafana-prometheus/src/querycache/QueryCache.ts (Prometheus frontend cache)
  - contribute/architecture/frontend-data-requests.md (existing cancellation docs)
Sections:
  - Introduction: Purpose, scope, methodology, and prerequisites
  - End-to-End Query Flow: Step-by-step trace from browser to backend and back
  - Repeated Query Execution: Comparison of two rapid queries with artefact analysis
  - Observable Artefacts Catalogue: Headers, logs, tracing, and DevTools observations
  - Cleanup Instructions: Teardown of any temporary dashboards or datasources
  - Summary and Rationale: Synthesis of findings with code-grounded reasoning
Diagrams:
  - Sequence diagram: Full query lifecycle (browser → server → datasource → response)
  - Flowchart: Backend handler chain from POST /api/ds/query to TestData
  - Sequence diagram: Repeated query cancellation via inFlightRequests
  - Table: Observable HTTP headers and their pipeline-stage origins
Key Citations:
  - public/app/features/query/state/PanelQueryRunner.ts
  - public/app/features/query/state/runRequest.ts
  - packages/grafana-runtime/src/utils/DataSourceWithBackend.ts
  - public/app/core/services/backend_srv.ts
  - pkg/api/ds_query.go
  - pkg/services/query/query.go
  - pkg/services/caching/service.go
  - pkg/services/pluginsintegration/clientmiddleware/caching_middleware.go
  - pkg/middleware/middleware.go
  - pkg/tsdb/grafana-testdata-datasource/testdata.go
  - pkg/tsdb/grafana-testdata-datasource/scenarios.go
```

### 0.5.3 Documentation Files to Update

No existing documentation files are modified. The `SWE-AtlasQnA-Repo` implementation rule explicitly states: "Do not modify any existing files in the source repository."

### 0.5.4 Documentation Configuration Updates

No configuration updates are required. The new file resides in `blitzy/documentation/`, which is outside the Hugo docs pipeline (`docs/sources/`) and does not need navigation, sidebar, or build-script changes.

### 0.5.5 Cross-Documentation Dependencies

- The new document references concepts described in `contribute/architecture/frontend-data-requests.md` (request cancellation, request queue). It includes inline cross-references but does not modify that file.
- No table-of-contents, index, or glossary updates are required since the target directory (`blitzy/documentation/`) is an independent output location.


## 0.6 Dependency Inventory

### 0.6.1 Documentation Dependencies

This documentation task produces a standalone Markdown file and does not require any documentation generation tools, build systems, or rendering pipelines. The file is authored directly in Markdown with embedded Mermaid diagram blocks.

No external documentation packages are needed. For reference, the key runtime dependencies whose behaviour is documented are:

| Registry | Package Name | Version | Purpose (in context of documentation) |
|----------|-------------|---------|---------------------------------------|
| npm | `@grafana/data` | workspace:* | Defines `DataQueryRequest`, `PanelData`, `DataQueryResponse` types traced in the document |
| npm | `@grafana/runtime` | workspace:* | Provides `DataSourceWithBackend`, `BackendSrv`, `getBackendSrv()` — the frontend transport layer |
| npm | `rxjs` | 7.8.1 | Powers the observable query pipeline (`runRequest`, `ReplaySubject`, `finalize`) |
| go | `github.com/grafana/grafana-plugin-sdk-go` | (per go.mod) | Defines `backend.QueryDataRequest`, `backend.QueryDataResponse` on the Go side |
| go | `github.com/grafana/grafana` | v11.5.0-pre | The Grafana backend itself — `pkg/api/`, `pkg/services/query/`, `pkg/tsdb/` |

### 0.6.2 Documentation Reference Updates

No link updates are required. The new document is self-contained in `blitzy/documentation/` and does not modify or require updates to any existing documentation links, navigation trees, or cross-references.


## 0.7 Coverage and Quality Targets

### 0.7.1 Documentation Coverage Metrics

The document must comprehensively answer every sub-question in the user's prompt. Current coverage analysis against the six objectives:

| Objective | Status Before | Target After | Source Files |
|-----------|--------------|-------------|-------------|
| End-to-end query flow | 0% (no existing narrative doc) | 100% | `PanelQueryRunner.ts`, `runRequest.ts`, `DataSourceWithBackend.ts`, `backend_srv.ts`, `ds_query.go`, `query.go`, `testdata.go`, `scenarios.go` |
| Browser-side request issuance | ~15% (partial in `frontend-data-requests.md`) | 100% | `PanelQueryRunner.ts`, `DataSourceWithBackend.ts`, `backend_srv.ts` |
| Backend handling | ~30% (tech spec 4.6 flow diagram) | 100% | `ds_query.go`, `query.go`, `testdata.go`, `scenarios.go`, `middleware.go` |
| Response path | 0% | 100% | `runRequest.ts`, `PanelQueryRunner.ts`, `revision.ts` |
| Repeated-query comparison | ~10% (cancellation only in `frontend-data-requests.md`) | 100% | `backend_srv.ts`, `canceler.ts`, `caching/service.go`, `caching_middleware.go`, `revision.ts`, `QueryCache.ts` |
| Observable artefacts catalogue | 0% | 100% | `middleware.go`, `DataSourceWithBackend.ts`, `backend_srv.ts`, `caching_middleware.go` |

Target coverage: **100%** of the user's stated questions answered with code-grounded evidence.

### 0.7.2 Documentation Quality Criteria

**Completeness requirements**:
- Every stage of the query lifecycle must be described with at least one source-file citation
- Every observable artefact (header, log, span) must cite the code that produces it
- The repeated-query analysis must cover cancellation, caching, and de-duplication, with explicit statements about what does and does not change between the two executions

**Accuracy validation**:
- All function names, file paths, and variable names cited must exist in the repository at the current commit
- All HTTP endpoint paths cited (e.g., `/api/ds/query`) must match the actual route registration in `pkg/api/api.go`
- Header names (e.g., `X-Plugin-Id`, `grafana-trace-id`) must match the exact string constants in source

**Clarity standards**:
- Technical detail is presented in progressive depth: overview → flow diagram → per-stage narrative → code citations
- Consistent terminology: the document uses "panel query", "data query request", "query data response" throughout
- All Mermaid diagrams have labels on every edge and node

**Maintainability**:
- Every technical claim includes a `Source: <file-path>` citation so future maintainers can verify accuracy against code changes
- The document does not depend on external URLs that may change; all references are to repository-relative paths

### 0.7.3 Example and Diagram Requirements

- Minimum diagrams: 3 (end-to-end sequence, backend flowchart, repeated-query cancellation sequence)
- Header/artefact tables: At least 2 (request headers, response headers)
- Code snippets: Short inline references (1–3 lines) citing specific functions; no full-file reproductions
- Verification method: All claims cross-referenced against source files retrieved during context gathering


## 0.8 Scope Boundaries

### 0.8.1 Exhaustively In Scope

- **New documentation file**:
  - `blitzy/documentation/grafana_4550cfb5b728.md` — the sole deliverable

- **Code areas to document** (read-only analysis; no modifications):
  - `public/app/features/query/state/**` — PanelQueryRunner, runRequest, processing helpers
  - `public/app/core/services/backend_srv.ts` — HTTP transport and cancellation
  - `packages/grafana-runtime/src/utils/DataSourceWithBackend.ts` — Datasource dispatch
  - `packages/grafana-runtime/src/services/QueryRunner.ts` — Runtime bootstrap
  - `packages/grafana-data/src/types/queryRunner.ts` — Type contracts
  - `packages/grafana-prometheus/src/querycache/QueryCache.ts` — Frontend cache (for comparison)
  - `pkg/api/ds_query.go` — Backend HTTP handler
  - `pkg/services/query/query.go` — Query orchestration service
  - `pkg/services/caching/service.go` — Caching interface and OSS no-op
  - `pkg/services/pluginsintegration/clientmiddleware/caching_middleware.go` — Caching middleware
  - `pkg/middleware/middleware.go` — HTTP middleware (headers, tracing, cache flags)
  - `pkg/tsdb/grafana-testdata-datasource/testdata.go` — TestData service
  - `pkg/tsdb/grafana-testdata-datasource/scenarios.go` — TestData scenario registry
  - `pkg/registry/apis/query/query.go` — K8s query API (alternate path)
  - `contribute/architecture/frontend-data-requests.md` — Existing contributor docs (reference)

- **Topics to cover in the document**:
  - Frontend query construction and dispatch
  - Backend query handling, routing, and execution
  - Response serialisation and frontend processing
  - Repeated-query cancellation, caching, and de-duplication
  - Observable artefacts (headers, logs, tracing spans)
  - Setup and cleanup instructions for runtime observation

### 0.8.2 Explicitly Out of Scope

- **Source code modifications**: No files in the repository are modified. The user's instruction is explicit: "Do not modify the source code."
- **Test file modifications**: No test files are created or modified.
- **Feature additions or code refactoring**: The task is documentation only.
- **Enterprise caching analysis**: The Enterprise caching implementation is proprietary and not present in the OSS repository. The document notes where Enterprise caching would differ but does not attempt to document its internals.
- **Non-TestData data sources**: The deep trace uses the built-in TestData data source only. Other data sources (Prometheus, Loki, Elasticsearch) are mentioned only for comparative context (e.g., Prometheus QueryCache).
- **Alerting query paths**: Alert rule evaluation queries follow a different code path (`pkg/services/ngalert/`) and are excluded.
- **Streaming / Grafana Live query paths**: Live-streaming queries bypass the standard `POST /api/ds/query` path and are excluded.
- **Deployment, infrastructure, or CI/CD changes**: Not applicable.
- **Documentation build pipeline changes**: The output file is placed outside the Hugo docs tree and requires no build configuration updates.
- **All items not explicitly mentioned in the user's prompt**: The scope is limited to the six objectives enumerated in section 0.1.


## 0.9 Execution Parameters

### 0.9.1 Documentation-Specific Instructions

- **Documentation build command**: Not applicable — the output is a standalone Markdown file that does not participate in any build pipeline
- **Documentation preview command**: Any Markdown viewer or `cat blitzy/documentation/grafana_4550cfb5b728.md`; Mermaid diagrams can be previewed in any Mermaid-compatible renderer (GitHub, VS Code with Mermaid extension)
- **Diagram generation command**: Diagrams are embedded as Mermaid code blocks within the Markdown file; no external generation step is required
- **Documentation deployment command**: Not applicable — the file is committed to the repository at `blitzy/documentation/grafana_4550cfb5b728.md`
- **Default format**: Markdown with embedded Mermaid diagrams
- **Citation requirement**: Every technical claim must reference the source file path and, where practical, the function or line range
- **Style guide**: The document should follow clear, explanatory prose appropriate for an engineer onboarding to Grafana. Code references use inline backticks. Diagrams use Mermaid `sequenceDiagram` and `flowchart` types.
- **Documentation validation**: Manual review — confirm every cited file path exists in the repository; confirm every cited function name matches the codebase


## 0.10 Rules for Documentation

The following rules apply to this documentation task, derived from the user's instructions and the `SWE-AtlasQnA-Repo` implementation rule:

- **Do not modify any existing files in the source repository.** The only write operation is creating the new file `blitzy/documentation/grafana_4550cfb5b728.md`.
- **Base all answers on the code as the truth.** Do not make assumptions. Every assertion in the document must be traceable to a specific file, function, or constant in the repository.
- **Provide thinking / rationale behind the answers.** The document is not a bare reference — it must explain *why* each stage works the way it does, grounded in the code structure.
- **Place the generated document in the `blitzy/documentation` directory.** The file name is `grafana_4550cfb5b728.md`, matching the source branch name `grafana_4550cfb5b728`.
- **Use runtime observation only.** Describe what an operator would see (logs, headers, network traffic) when running a local Grafana instance — do not propose code changes or instrumentation patches.
- **Clean up any temporary artefacts afterward.** The document must include cleanup instructions for any dashboards, data sources, or configuration created during the observation procedure.
- **Use the built-in TestData data source** as the observation target, since it is shipped with Grafana and requires no external backend or credentials.
- **Include Mermaid diagrams** for all major workflows (end-to-end flow, backend handler chain, repeated-query cancellation).
- **Add source code citations** for all technical details, using the format `Source: /path/to/file.ext` or `Source: /path/to/file.ext:FunctionName`.


## 0.11 References

### 0.11.1 Files and Folders Searched

The following files and folders were retrieved and analysed to derive the conclusions in this Agent Action Plan:

**Frontend — Query Execution Pipeline**
- `public/app/features/query/state/PanelQueryRunner.ts` — Panel query runner: request construction, datasource resolution, interval computation, subscription management
- `public/app/features/query/state/runRequest.ts` — Observable pipeline: `runRequest()`, `processResponsePacket()`, `callQueryMethod()`, timer-based loading state, cancellation teardown
- `public/app/features/query/state/QueryRunner.ts` — Concrete `QueryRunner` class: `run()`, `cancel()`, `destroy()`, `getDataSource()`
- `public/app/features/query/state/processing/canceler.ts` — `cancelNetworkRequestsOnUnsubscribe` operator
- `public/app/features/query/state/processing/revision.ts` — `setStructureRevision` helper for de-duplication
- `public/app/features/query/state/runRequest.test.ts` — Test suite validating pipeline behaviour
- `public/app/features/query/state/PanelQueryRunner.test.ts` — Test suite for PanelQueryRunner

**Frontend — Transport and Runtime**
- `public/app/core/services/backend_srv.ts` — `BackendSrv` HTTP transport: fetch queue, cancellation via `inFlightRequests`, device-ID header, token rotation
- `packages/grafana-runtime/src/utils/DataSourceWithBackend.ts` — `DataSourceWithBackend.query()`: target normalisation, header attachment (`X-Plugin-Id`, `X-Datasource-Uid`), endpoint routing
- `packages/grafana-runtime/src/services/QueryRunner.ts` — Runtime service bootstrap: `setQueryRunnerFactory`, `setRunRequest`
- `packages/grafana-data/src/types/queryRunner.ts` — Type definitions: `QueryRunnerOptions`, `QueryRunner` interface
- `packages/grafana-runtime/src/utils/publicDashboardQueryHandler.ts` — Public dashboard query handler (contrast path)

**Frontend — TestData Datasource**
- `public/app/plugins/datasource/grafana-testdata-datasource/datasource.ts` — `TestDataDataSource` class: scenario routing, backend delegation
- `public/app/plugins/datasource/grafana-testdata-datasource/plugin.json` — Plugin manifest: capabilities, backend executable
- `public/app/plugins/datasource/grafana-testdata-datasource/dataquery.ts` — Query type definitions and scenario enum
- `public/app/plugins/datasource/grafana-testdata-datasource/constants.ts` — Default query constants

**Frontend — Prometheus Query Cache (Comparison)**
- `packages/grafana-prometheus/src/querycache/QueryCache.ts` — Overlap-aware incremental backfill cache

**Backend — Query HTTP Handler**
- `pkg/api/ds_query.go` — `QueryMetricsV2` handler, feature-flag rewrite path, error mapping
- `pkg/api/ds_query_test.go` — Test coverage for query endpoint

**Backend — Query Orchestration Service**
- `pkg/services/query/query.go` — `ServiceImpl.QueryData()`: request parsing, datasource resolution, single/multi-datasource routing, expression handling, concurrent execution

**Backend — Caching**
- `pkg/services/caching/service.go` — `CachingService` interface, `OSSCachingService` (no-op), `X-Cache` header constants
- `pkg/services/pluginsintegration/clientmiddleware/caching_middleware.go` — `CachingMiddleware.QueryData()`: cache lookup/update wrapper
- `pkg/services/pluginsintegration/clientmiddleware/caching_middleware_test.go` — Caching middleware tests
- `pkg/services/pluginsintegration/clientmiddleware/caching_metrics.go` — Prometheus metrics for caching

**Backend — Middleware**
- `pkg/middleware/middleware.go` — `HandleNoCacheHeaders()`, `AddDefaultResponseHeaders()`: `X-Grafana-NoCache`, `X-Cache-Skip`, `grafana-trace-id`, `Cache-Control`

**Backend — TestData Datasource**
- `pkg/tsdb/grafana-testdata-datasource/testdata.go` — `Service` struct, `ProvideService()`, `QueryData()` mux dispatch
- `pkg/tsdb/grafana-testdata-datasource/scenarios.go` — Scenario registry: `registerScenarios()`, `RandomWalk`, `instrumentScenarioHandler`

**Backend — K8s Query API (Alternate Path)**
- `pkg/registry/apis/query/query.go` — Kubernetes-style query endpoint: `Connect()`, `execute()`, `handleQuerySingleDatasource()`
- `pkg/registry/apis/datasource/sub_query.go` — Datasource sub-query REST adapter

**Existing Documentation**
- `contribute/architecture/frontend-data-requests.md` — Contributor docs: request cancellation, request queue
- `docs/sources/developers/http_api/query_and_resource_caching.md` — Enterprise caching HTTP API reference
- `docs/sources/datasources/testdata/_index.md` — TestData data source user guide

**Tech Spec Sections Retrieved**
- Section 4.3 — HTTP Request Processing Pipeline
- Section 4.5 — Dashboard Lifecycle Workflow
- Section 4.6 — Data Source Query Execution
- Section 5.2 — Component Details

### 0.11.2 Attachments

No attachments were provided by the user. No Figma screens were referenced.


