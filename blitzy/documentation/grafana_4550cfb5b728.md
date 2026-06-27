# Grafana Dashboard-Panel Query Lifecycle — Runtime Investigation (OSS)

> **Purpose (onboarding Q&A).** This document answers, at a practical and runtime-observed level, *what happens when a Grafana dashboard panel executes a query against a built-in data source*, and — the key question — *whether the second of two quick, identical executions is treated any differently than the first.* Every conclusion is grounded in the source code (the source of truth) **and** corroborated by signals captured from a live instance.

## Instance under test

| Property | Value |
|---|---|
| **Edition** | **Grafana OSS** (open source) — *not* Enterprise/Cloud |
| **Commit (git HEAD)** | `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` (branch `grafana_4550cfb5b728`) |
| **Version** | `11.5.0-pre` (`/api/health` reported `"version":"11.5.0-pre","commit":"4550cfb5b7"`) |
| **URL** | `http://localhost:3000` |
| **Login** | `admin` / `admin` |
| **Built-in data source** | **TestData DB** (`grafana-testdata-datasource`) — generates synthetic data in-process, **zero external dependencies** |

> ⚠️ **Edition matters for the answer.** The query *result* cache is an **Enterprise/Cloud-only** feature. In the OSS build under test, the caching service is wired to a **no-op** implementation (`OSSCachingService`). The second-execution conclusion below is therefore **OSS behavior** and must **not** be mistaken for Enterprise/Cloud, which *does* cache query results (see [Section 5](#5-second-execution-analysis--the-key-answer) and the web corroboration there).

## Methodology

1. **Build & run** OSS Grafana from source (prebuilt `bin/linux-amd64/grafana` backend + `public/build` frontend assets) on port 3000.
2. **Raise log verbosity transiently** via a *gitignored* `conf/custom.ini` (`router_logging = true`, `[log] level = debug`) — a build-tree artifact, **never** a tracked source edit.
3. **Configure** the bundled TestData DB data source and author a **deterministic** query (Predictable CSV Wave / CSV Content) so repeats are byte-identical.
4. **Fire once**, then **fire twice in quick succession**, capturing **four** signal sources for each run: (a) browser DevTools **Network** entries, (b) the **Panel Inspector** (Query/Stats/Data tabs), (c) **backend logs**, and (d) the Prometheus **`/metrics`** endpoint.
5. **Reconcile** every observation against the responsible source code, then write this document. Finally, **clean up** all transient artifacts so the tracked source tree is byte-unchanged.

## 🧭 Headline answer

> **In OSS Grafana, the second identical execution is _not_ served from any query-result cache — both runs reach the data-source backend and return freshly generated data, with _no_ `X-Cache` response header.** The only observable differences between run&nbsp;1 and run&nbsp;2 are:
> - **(b) a data-source-_config_ cache hit on the backend** — the second resolution within a **5-second** TTL is served from memory, suppressing one SQL lookup and one `datasources` debug log line; and
> - **(c) frontend in-flight request cancellation** — if the second run starts while the first is still pending, the earlier request is cancelled (visible as a `(canceled)`/`ERR_ABORTED` network entry).
>
> There is **no backend request de-duplication**: two genuinely independent executions produce **two** backend requests (confirmed via `/metrics`).

## Table of contents

1. [Overview & end-to-end flow](#1-overview--end-to-end-flow)
2. [Frontend issuance — how the browser issues the query](#2-frontend-issuance--how-the-browser-issues-the-query)
3. [Backend handling — how the server processes the request](#3-backend-handling--how-the-server-processes-the-request)
4. [Response shape — what returns to the panel](#4-response-shape--what-returns-to-the-panel)
5. [Second-execution analysis — THE KEY ANSWER](#5-second-execution-analysis--the-key-answer)
6. [Appendix — logs, headers & metadata](#6-appendix--logs-headers--metadata)
7. [Reproduction steps & cleanup](#7-reproduction-steps--cleanup)

---

## 1. Overview & end-to-end flow

When a dashboard panel (or an Explore pane) needs data, a **React** component asks a `DataSourceWithBackend`-derived data source to run a batch of queries. That client builds a single HTTP request and hands it to `backend_srv`, which issues **`POST /api/ds/query`**. The request flows through Grafana's HTTP middleware chain to the `QueryMetricsV2` handler, into the query coordination service, through data-source resolution (which consults an in-memory **config** cache), then into the plugin client middleware stack — including a **caching middleware** that, in OSS, calls a **no-op** caching service. The request finally reaches the **TestData** backend plugin, which generates synthetic **DataFrames** in-process. The handler streams a JSON **`QueryDataResponse`** back, with results **keyed by `refId`**; the frontend parses that payload into a `DataQueryResponse` of DataFrames for the panel to render.

A crucial architectural fact: **the only boundary the browser sees is `/api/ds/query`.** Data-source credentials are never exposed to the browser — queries are proxied server-side.

> **Both a dashboard panel and Explore converge on the same `/api/ds/query` endpoint.** The request is constructed by the same `DataSourceWithBackend.query()` code path in both cases (`packages/grafana-runtime/src/utils/DataSourceWithBackend.ts:L209`). The only differences observed at runtime were the `requestId` scheme and a few context headers (e.g., Explore sets `X-Cache-Skip`; a panel sets `X-Dashboard-Uid`/`X-Panel-Id`).

### End-to-end sequence

The diagram below traces the full path and annotates the **three** places where the *second* of two quick identical runs can differ in OSS.

```mermaid
sequenceDiagram
    autonumber
    participant P as Panel (React)
    participant BS as backend_srv.ts
    participant MW as HTTP Middleware
    participant H as QueryMetricsV2 (ds_query.go)
    participant QS as Query Service (query.go)
    participant DC as DS Config Cache (cache.go, TTL 5s)
    participant CM as Caching Middleware
    participant CS as OSSCachingService (no-op)
    participant TS as TestData Backend (tsdb)

    P->>BS: query() builds POST /api/ds/query?ds_type=...&requestId=...
    Note over BS: emits requestId on inFlightRequests;<br/>re-run cancels the prior in-flight request (diff #3, frontend)
    BS->>MW: HTTP POST (X-Datasource-Uid, X-Plugin-Id, X-Panel-Id, ...)
    MW->>H: route POST /api/ds/query (perm: datasources:query)
    H->>QS: QueryData(ctx, user, skipDSCache, reqDTO)
    QS->>DC: GetDatasourceByUID(uid, skipDSCache)
    Note over DC: 1st call within 5s -> SQL lookup + debug log;<br/>2nd call within 5s -> cache HIT, no SQL, no log (diff #2, backend)
    QS->>CM: plugin client QueryData
    CM->>CS: HandleQueryRequest(ctx, req)
    Note over CS: OSS no-op: ALWAYS returns hit=false;<br/>no X-Cache header set (diff #1: result cache is a no-op)
    CS-->>CM: hit=false, empty CachedQueryDataResponse
    CM->>TS: BaseHandler.QueryData(ctx, req)
    TS-->>H: DataFrames (synthetic, in-process)
    H-->>P: streamed JSON QueryDataResponse (results keyed by refId)
```

**The three differentiators, summarized:**

- **#1 — Query-result cache (no-op in OSS):** `CS.HandleQueryRequest` always reports *no hit* and never sets `X-Cache`, so **both** runs reach `TS`. This is the headline answer.
- **#2 — Data-source *config* cache (backend):** the second resolution within the 5-second TTL is a cache **hit**, suppressing one SQL lookup and one debug log line.
- **#3 — Frontend in-flight cancellation:** a re-run while a request is pending cancels the earlier request.

---

## 2. Frontend issuance — how the browser issues the query

The browser-side request is fully assembled by **`DataSourceWithBackend.query()`** and dispatched by **`backend_srv`**. The TestData frontend plugin (`public/app/plugins/datasource/grafana-testdata-datasource/datasource.ts:L30`, `TestDataDataSource extends DataSourceWithBackend<TestDataDataQuery>`) is only the *editor* used to author the query — it does not change the issuance mechanics described here.

### 2.1 Request construction — `DataSourceWithBackend.ts`

The full header vocabulary the browser may attach is the `PluginRequestHeaders` enum (`packages/grafana-runtime/src/utils/DataSourceWithBackend.ts:L79-L87`):

| Member | Header value | Line |
|---|---|---|
| `PluginID` | `X-Plugin-Id` | L80 |
| `DatasourceUID` | `X-Datasource-Uid` | L81 |
| `DashboardUID` | `X-Dashboard-Uid` | L82 |
| `PanelID` | `X-Panel-Id` | L83 |
| `PanelPluginId` | `X-Panel-Plugin-Id` | L84 |
| `QueryGroupID` | `X-Query-Group-Id` | L85 |
| `FromExpression` | `X-Grafana-From-Expr` | L86 |
| `SkipQueryCache` | `X-Cache-Skip` | **L87** |

> **Verified line-number note:** `SkipQueryCache = 'X-Cache-Skip'` is at **L87** (the closing brace of the enum is L88). The in-code comment reads "used by datasources to skip the query cache."

The `query()` method begins at **L130**. The key steps:

- **Request body** (`packages/grafana-runtime/src/utils/DataSourceWithBackend.ts:L192-L196`):
  ```ts
  const body = {
    queries,
    from: range?.from.valueOf().toString(),
    to: range?.to.valueOf().toString(),
  };
  ```
  i.e., `{ queries, from, to }`, where `from`/`to` are epoch-millis strings produced via optional chaining on `range` (`range?.from`/`range?.to`).

- **URL** (`...:L209`): `let url = '/api/ds/query?ds_type=' + this.type;`
  - `'&expression=true'` is appended when the batch contains expressions (`...:L225`).
  - `'&requestId=${requestId}'` is appended (`...:L230`).

- **Headers** are attached to a per-request `headers` object across `...:L206-L247`: `PluginID` (L206), `DatasourceUID` (L207), `FromExpression` (L224), `DashboardUID` (L234), `PanelID` (L236), `PanelPluginId` (L240), `QueryGroupID` (L243). The `X-Cache-Skip` header is attached **only when `request.skipQueryCache`** is set (guard `if (request.skipQueryCache)` at **L245**, set at **L246**).

- **Dispatch** (`...:L248-L256`):
  ```ts
  return getBackendSrv()
    .fetch<BackendDataSourceResponse>({
      url,
      method: 'POST',
      data: body,
      requestId,
      hideFromInspector,
      headers,
    })
  ```
  The raw response is then converted with `toDataQueryResponse(...)` (`...:L259`; see [Section 4](#4-response-shape--what-returns-to-the-panel)).

> **Feature-toggle rewrite (not the OSS default).** When the `queryServiceFromUI`/`queryService` toggle is on, the URL is rewritten to `/apis/query.grafana.app/v0alpha1/namespaces/${config.namespace}/query` (`...:L212-L220`, target at L219). **The default OSS path is `/api/ds/query`** — and that is exactly what was observed at runtime.

#### Captured evidence — a real frontend request (dashboard panel)

A live `POST` captured from the **dashboard panel** (DevTools Network, request id `206`):

```text
POST /api/ds/query?ds_type=grafana-testdata-datasource&requestId=SQR100   [200]
```
Request headers (note the panel-context `X-*` headers, all matching the enum above):
```text
x-dashboard-uid:    blitzyqlc01          # PluginRequestHeaders.DashboardUID (L82)
x-panel-id:         1                    # PluginRequestHeaders.PanelID      (L83)
x-panel-plugin-id:  timeseries           # PluginRequestHeaders.PanelPluginId(L84)
x-datasource-uid:   afqc42i8oitxcb       # PluginRequestHeaders.DatasourceUID(L81)
x-plugin-id:        grafana-testdata-datasource   # PluginRequestHeaders.PluginID (L80)
content-type:       application/json
```
Request body (the `{ queries, from, to }` shape — `from`/`to` are epoch-millis strings exactly as built at L192-L196):
```json
{"queries":[{"csvWave":[{"timeStep":60,"valuesCSV":"0,10,20,30,20,10"}],
  "datasource":{"type":"grafana-testdata-datasource","uid":"afqc42i8oitxcb"},
  "refId":"A","scenarioId":"predictable_csv_wave","datasourceId":1,
  "intervalMs":1000,"maxDataPoints":783}],
 "from":"1782507700796","to":"1782508600796"}
```

A live `POST` captured from **Explore** (request id `148`) shows the **`X-Cache-Skip`** header set (Explore sets `request.skipQueryCache`, triggering the L245-L246 guard) — a panel does **not** set it:
```text
POST /api/ds/query?ds_type=grafana-testdata-datasource&requestId=explore_69d   [200]
x-cache-skip:      true        # only set by Explore (skipQueryCache) -> attached at L246
x-datasource-uid:  afqc42i8oitxcb
x-plugin-id:       grafana-testdata-datasource
content-type:      application/json
```

### 2.2 Dispatch & cancellation — `backend_srv.ts`

`BackendSrv` performs the actual fetch and tracks in-flight requests:

- `private inFlightRequests: Subject<string>` (`public/app/core/services/backend_srv.ts:L60`).
- In `internalFetch`, the active id is emitted: `if (options.requestId) { this.inFlightRequests.next(options.requestId); }` (`...:L145-L147`).
- `handleStreamCancellation` (`...:L416+`) pipes `takeUntil(this.inFlightRequests.pipe(filter(...)))` (`...:L419`). When a **new request reuses the same `requestId`** while a prior one is still in flight, the filter matches (`options.requestId === requestId` → `cancelRequest = true`, `...:L422-L428`) and the earlier request is cancelled. The sentinel `CANCEL_ALL_REQUESTS_REQUEST_ID` (`...:L39`) cancels all in-flight requests (`...:L431-L432`).

### 2.3 RxJS run pipeline — `runRequest.ts`

`runRequest` wraps the data-source call in an RxJS pipeline (`public/app/features/query/state/runRequest.ts`):

- On `finalize`, it registers `cancelNetworkRequestsOnUnsubscribe(backendSrv, request.requestId)` (`...:L178`), then `share()`s the stream (`...:L180`).
- A loading-state timer is merged in (`...:L186`):
  ```ts
  return merge(timer(200).pipe(mapTo(state.panelData), takeUntil(dataObservable)), dataObservable);
  ```
  i.e., if the query has not resolved within **200&nbsp;ms**, a loading state is emitted.

> **Trust the code over the comment.** There are stale comments saying "50ms" near `...:L121` and `...:L183`, but the executing code is **`timer(200)` = 200&nbsp;ms**. The 200&nbsp;ms value is authoritative.

### 2.4 The cancellation helper — `canceler.ts`

`public/app/features/query/state/processing/canceler.ts` (L6-L15) declares the finalize hook used above:

```ts
export function cancelNetworkRequestsOnUnsubscribe(backendSrv: BackendSrv, requestId?: string) {
  return finalize(() => {
    if (requestId) {
      backendSrv.resolveCancelerIfExists(requestId);
    }
  });
}
```
When the RxJS pipeline is unsubscribed/finalized, the in-flight request for that `requestId` is cancelled.

### 2.5 The cancellation NUANCE — `PanelQueryRunner.ts` (two paths, do not overstate)

`public/app/features/query/state/PanelQueryRunner.ts` reveals that **every run gets a *distinct* incrementing id**:

- `let counter = 100;` (`...:L67`) and `getNextRequestId() { return 'Q' + counter++; }` (`...:L69-L71`) → `Q101`, `Q102`, …
- `run()` sets `requestId: getNextRequestId()` (`...:L283`).
- `pipeToSubject()` (`...:L347`) **unsubscribes the prior subscription first** (`if (this.subscription) { this.subscription.unsubscribe(); }`, `...:L353-L354`) **before** subscribing to the new one (`this.subscription = panelData.subscribe(...)`, `...:L365`).

Therefore there are **two** frontend cancellation paths, and they must not be conflated:

- **(i) Unsubscribe-driven (dominant for a single panel re-running).** Because each `run()` produces a *new* `requestId` and first unsubscribes the previous subscription, the previous pipeline's `finalize` fires → `resolveCancelerIfExists(prevRequestId)` cancels the prior still-in-flight request — **even though the two `requestId`s differ.**
- **(ii) Same-`requestId` `takeUntil` (in `backend_srv`).** This fires only when an identical `requestId` is *reused* while the prior request is in flight (observed with Explore, which uses a *stable* `requestId` such as `explore_69d`).

Because ids are distinct per run, **two genuinely independent executions** (two different panels, or two sequential fully-completed runs) reach the backend as **two independent requests** — corroborated by `/metrics` (see [Section 6](#6-appendix--logs-headers--metadata)).

> **Observed `requestId` schemes (runtime):**
> - **Explore** reuses a *stable* id `explore_<paneId>` (e.g., `explore_69d`) → the **same-`requestId` `takeUntil`** path (2.2) cancels a prior run.
> - **Scenes dashboard** uses *incrementing* ids `SQR<n>` (initial load `SQR100`, a Panel-Inspector refresh `SQR101`) → the **unsubscribe-driven** path (2.5(i)) dominates.

### 2.6 Response parsing — `queryResponse.ts`

`toDataQueryResponse(...)` is exported at `packages/grafana-runtime/src/utils/queryResponse.ts:L60`. It:
- seeds `const rsp: DataQueryResponse = { data: [], state: LoadingState.Done };` (`...:L67`);
- reads `results = fetchResponse.data.results` (`...:L78`) and orders by `refId` (`...:L79`, iterating `for (const refId of refIDs)` at `...:L83`, setting `dr.refId = refId` at `...:L88`);
- converts each frame via `dataFrameFromJSON(js)` (`...:L118`).

The net result: the raw `/api/ds/query` payload (results keyed by `refId`) becomes the panel's `DataQueryResponse` of typed **DataFrames**.

---


## 3. Backend handling — how the server processes the request

### 3.1 Route registration — `pkg/api/api.go`

The endpoint is registered at **`pkg/api/api.go:L521`**:

```go
apiRoute.Post("/ds/query",
    requestmeta.SetSLOGroup(requestmeta.SLOGroupHighSlow),
    authorize(ac.EvalPermission(datasources.ActionQuery)),
    hs.getDSQueryEndpoint())
```

Reading it left to right:
- The route lives inside the `/api` group, so the full path is **`POST /api/ds/query`**.
- `SetSLOGroup(SLOGroupHighSlow)` places it in the **high-SLO-slow** bucket — this is exactly the `slo_group="high-slow"` label seen later on the `/metrics` counters.
- `authorize(ac.EvalPermission(datasources.ActionQuery))` enforces the **`datasources:query`** permission.
- `hs.getDSQueryEndpoint()` selects the handler.

### 3.2 Handler selection & binding — `pkg/api/ds_query.go`

`getDSQueryEndpoint()` (`pkg/api/ds_query.go:L41-L56`) chooses the handler based on a feature toggle:
- If `FlagQueryServiceRewrite` is enabled (`...:L42`), the request is rewritten to `/apis/query.grafana.app/v0alpha1/namespaces/.../query` (`...:L51`) and served via `clientConfigProvider.DirectlyServeHTTP` (`...:L52`).
- Otherwise (the **OSS default**), it returns `routing.Wrap(hs.QueryMetricsV2)` (`...:L55`).

`QueryMetricsV2` (`...:L73-L84`) is the OSS workhorse:
```go
func (hs *HTTPServer) QueryMetricsV2(c *contextmodel.ReqContext) response.Response {
    reqDTO := dtos.MetricRequest{}
    if err := web.Bind(c.Req, &reqDTO); err != nil {       // 400 on bind error (L76)
        return response.Error(http.StatusBadRequest, "bad request data", err)
    }
    resp, err := hs.queryDataService.QueryData(c.Req.Context(), c.SignedInUser, c.SkipDSCache, reqDTO) // L79
    if err != nil {
        return hs.handleQueryMetricsError(err)             // L81
    }
    return hs.toJsonStreamingResponse(c.Req.Context(), resp) // L83
}
```
Note that `c.SkipDSCache` (set from the `X-Grafana-NoCache` header — see [Section 5](#5-second-execution-analysis--the-key-answer)) is threaded into `QueryData` at **L79**. The Swagger annotations enumerate `200/207/400/401/403/500` (`...:L66-L72`).

Error mapping — `handleQueryMetricsError` (`...:L24-L38`):
- **403** "Access denied to data source" (`...:L26`),
- **404** "Data source not found" (`...:L29`),
- **500** "Secrets Plugin error" (`...:L34`),
- fallback **500** "Query data error" (`...:L37`).

### 3.3 Query coordination — `pkg/services/query/query.go`

`QueryData` (`pkg/services/query/query.go:L90`) has signature `(ctx, user identity.Requester, skipDSCache bool, reqDTO dtos.MetricRequest)`. It:
- parses the batch with `parseMetricRequest` (`...:L92`);
- if expressions are present, dispatches to `handleExpressions` (`...:L99`);
- if `len(parsedReq.parsedQueries) == 1` (`...:L102`), takes the single-datasource fast path `handleQuerySingleDatasource` (`...:L103`);
- otherwise runs `executeConcurrentQueries` for multiple data sources (`...:L106`).

Data-source resolution happens in `getDataSourceFromQuery` (`...:L344`):
- a per-request `history` map short-circuits repeated lookups within the same batch (`...:L354-L357`);
- the special `grafanads.DatasourceUID` case is handled (`...:L363-L365`);
- otherwise it resolves **by uid** via `s.dataSourceCache.GetDatasourceByUID(ctx, uid, user, skipDSCache)` (**`...:L368`**) or **by id** via `GetDatasource(...)` (**`...:L378`**).

`dataSourceCache` is a `datasources.CacheService` struct field (`...:L74`), injected via the `ProvideService` constructor parameter (`...:L43`). This is the **data-source-config** cache examined in [Section 5(b)](#5b-data-source-config-caching--the-real-observable-backend-difference) — the source of the only observable *backend* difference between the two runs. After resolution, the request is routed into the plugin client, which passes through the **caching middleware** ([Section 5(a)](#5a-query-result-caching--no-op-in-oss-the-headline)) before reaching the TestData backend.

### 3.4 The TestData backend — `pkg/tsdb/grafana-testdata-datasource/`

The TestData backend generates synthetic data **in-process, with zero external dependencies**, which is exactly why the two executions can run with no external system and produce byte-identical output:
- `scenarios.go` — `registerScenarios` (`...:L34`) registers the scenarios, including **Random Walk** (`handleRandomWalkScenario`, `...:L293`), **Predictable CSV Wave** (`handlePredictableCSVWaveScenario`, `...:L66`), and **Slow Query** (`StringInput: "5s"`, registered at `...:L75-L80`, handler `handleRandomWalkSlowScenario` at `...:L405`).
- `csv_data.go` — `handleCsvContentScenario` (`...:L20`), `handleCsvFileScenario` (`...:L57`), `LoadCsvContent` (`...:L122`).
- `resource_handler.go` — `registerRoutes` (`...:L17`) exposes `/scenarios`, `/stream`, etc.

All of these build DataFrames directly in Go; no network or database call leaves the process.

---


## 4. Response shape — what returns to the panel

### 4.1 Structure & status code

The response is a **streamed JSON `backend.QueryDataResponse`** whose results are **keyed by `refId`**; each result carries one or more **DataFrames** and a per-query `status`/`error`. This is assembled by `toJsonStreamingResponse` (`pkg/api/ds_query.go:L86-L100`):

```go
func (hs *HTTPServer) toJsonStreamingResponse(ctx context.Context, qdr *backend.QueryDataResponse) response.Response {
    statusCode := http.StatusOK                 // 200 (L87)
    for _, res := range qdr.Responses {
        if res.Error != nil {
            statusCode = http.StatusBadRequest   // 400 if ANY per-query error (L90)
            break                                // (L91)
        }
    }
    if statusCode == http.StatusBadRequest {
        requestmeta.WithDownstreamStatusSource(ctx)  // mark downstream source (L97)
    }
    return response.JSONStreaming(statusCode, qdr)   // (L100)
}
```

- **200** is returned normally.
- **400** is returned when *any* per-query `res.Error != nil`, and the request is marked with a **downstream status source** (`...:L97`).
- The Swagger block (`...:L66-L72`) additionally documents `207`, `401`, `403`, and `500` for other conditions (see `handleQueryMetricsError`, [Section 3.2](#32-handler-selection--binding--pkgapids_querygo)).

> **Verified line-number note:** the final `return response.JSONStreaming(statusCode, qdr)` is at **L100** (the plan's "L98" was stale; the code is authoritative).

### 4.2 Captured response (live)

A representative response captured from the **dashboard panel** run (`predictable_csv_wave`), HTTP **200**, `content-length: 563`:

```json
{
  "results": {
    "A": {
      "status": 200,
      "frames": [
        {
          "schema": {
            "refId": "A",
            "name": "A-series",
            "fields": [
              { "name": "Time",  "type": "time",   "typeInfo": { "frame": "time.Time", "nullable": true } },
              { "name": "Value", "type": "number", "typeInfo": { "frame": "float64" } }
            ]
          },
          "data": {
            "values": [
              [ 1782507700000, 1782507760000, 1782507820000, "…" ],
              [ 10, 20, 30, 20, 10, 0, 10, 20, 30, 20, "…" ]
            ]
          }
        }
      ]
    }
  }
}
```

Key structural points observed:
- The top-level object is **`results`**, an object **keyed by `refId`** (here `"A"`).
- Each entry has a per-query **`status`** (200) and a **`frames`** array.
- Each frame = a **`schema`** (its `refId`, optional `name`, and typed `fields`) plus a **`data.values`** column-oriented array (here a `Time` column and a `Value` column that traces the deterministic triangular wave `…10,20,30,20,10,0,10,20,30,20…`).

This is precisely the payload that `queryResponse.ts:toDataQueryResponse` (`...:L60`) walks — reading `fetchResponse.data.results` (`...:L78`), iterating by `refId` (`...:L83-L88`), and converting each frame with `dataFrameFromJSON` (`...:L118`) into the panel's `DataQueryResponse` of DataFrames ([Section 2.6](#26-response-parsing--queryresponsets)).

### 4.3 As seen in the Panel Inspector

The same payload is visible in **Panel Inspector → Query tab**. A live capture showed the inspector tree with:
```text
request.url:    api/ds/query?ds_type=grafana-testdata-datasource&requestId=SQR101
request.method: POST
request.data:   { queries: Array[1], from: "1782507739593", to: "1782508639593" }
response.results.A: { status: 200, frames: [ … ] }
```
Note `requestId=SQR101` here (a Panel-Inspector refresh) versus `SQR100` on the initial load — confirming the **distinct, incrementing `requestId` per run** described in [Section 2.5](#25-the-cancellation-nuance--panelqueryrunnerts-two-paths-do-not-overstate).

---


## 5. Second-execution analysis — THE KEY ANSWER

> **Question:** *When the same query is executed twice in quick succession, is the second execution treated differently in any way?*
>
> **Answer (OSS):** With respect to the query **result**, **no** — there is **no result cache** in OSS, so both runs execute against the TestData backend and return freshly generated data with **no `X-Cache` header**. The only differences are **(b)** a data-source-*config* cache hit on the backend (silently suppressing one SQL lookup + one debug log within a 5-second window) and **(c)** frontend cancellation of the earlier in-flight request if the second run starts before the first finishes. **There is no backend request de-duplication.**

To make this precise, three independent mechanisms must be distinguished. Each is grounded in the code **and** confirmed by a captured runtime signal.

### 5(a) Query-result caching — NO-OP in OSS (the headline)

**Code.** The caching contract and the OSS implementation live in `pkg/services/caching/service.go`:
- `XCacheHeader = "X-Cache"` (`...:L10`) and the status constants `StatusHit`/`StatusMiss`/`StatusBypass`/`StatusError`/`StatusDisabled` (`...:L11-L15`).
- `ProvideCachingService()` returns `&OSSCachingService{}` (`...:L38-L40`).
- The linchpin — `OSSCachingService.HandleQueryRequest` (`...:L56-L58`):
  ```go
  func (s *OSSCachingService) HandleQueryRequest(ctx context.Context, req *backend.QueryDataRequest) (bool, CachedQueryDataResponse) {
      return false, CachedQueryDataResponse{}
  }
  ```
  It **always reports no hit** and **never sets the `X-Cache` header**. `HandleResourceRequest` (`...:L60-L62`) is the identical no-op, and a compile-time check `var _ CachingService = &OSSCachingService{}` (`...:L64`) binds it to the interface.

The OSS build is wired to this no-op in `pkg/server/wireexts_oss.go:L101-L102`:
```go
caching.ProvideCachingService,
wire.Bind(new(caching.CachingService), new(*caching.OSSCachingService)),
```

The **only call-site** of the result cache is the caching middleware, `pkg/services/pluginsintegration/clientmiddleware/caching_middleware.go`:
```go
func (m *CachingMiddleware) QueryData(ctx context.Context, req *backend.QueryDataRequest) (...) {  // L58
    // ... nil guards return BaseHandler directly (L60/L65) ...
    start := time.Now()                                         // L69
    hit, cr := m.caching.HandleQueryRequest(ctx, req)           // L72
    ch := reqCtx.Resp.Header().Get(caching.XCacheHeader)        // L75
    if ch != "" {                                               // histogram only if header present (L76-L84)
        // record cache-status histogram
    }
    if hit {                                                    // L87
        return cr.Response, nil                                 // L88-L89  (never taken in OSS)
    }
    resp, err := m.BaseHandler.QueryData(ctx, req)              // L92  (ALWAYS taken in OSS)
    // ...
}
```
In OSS, `hit` is **always false** ⇒ **both** executions reach `m.BaseHandler.QueryData` (the TestData backend); **no `X-Cache` header is set**, and the cache-status histogram is **never** recorded (the `ch != ""` guard at L76 is never satisfied).

**Runtime proof.**
1. **`X-Cache` absent on every response.** Across all three curl runs (Q1, Q2a, Q2b) *and* both browser runs, **no `X-Cache` response header was present** — exactly as predicted by the no-op service. (Response headers always carried `Cache-Control: no-store` and `Content-Type: application/json`; see [Section 6](#6-appendix--logs-headers--metadata).)
2. **The decisive timing test.** Using the **Slow Query (5 s)** scenario, the *same* slow query was run a **second** time. The backend router log shows it again took ~5 seconds:
   ```text
   ...msg="Request Completed" ... path=/api/ds/query ... duration=5.002567245s   # run 1
   ...msg="Request Completed" ... path=/api/ds/query ... duration=5.003339029s   # run 2 (repeat)
   ```
   If a result cache existed, the repeat would have returned near-instantly. It did not — proving the result is **not** cached in OSS.

**Conclusion (a).** In OSS, the second execution's **result is not served from any cache** — both runs execute against the data source.

> **Enterprise/Cloud differs (corroboration).** Grafana's query/result caching is an Enterprise/Cloud feature. The Grafana data-source-management docs list it as <q>Available in Grafana Enterprise and Grafana Cloud</q> (grafana.com/docs/grafana/latest/administration/data-source-management/), and a community maintainer notes the plugin <q>supports the grafana enterprise query caching</q> only for Enterprise/Cloud (github.com/grafana/grafana-infinity-datasource discussion #799). Where enabled, the cache key is built from the **data source instance + query + time range**, the first load executes and stores while subsequent identical loads within the TTL return from cache, and the **default TTL is 5 minutes** (300000 ms) (grafana.com/blog query-caching-in-grafana-cloud 2021-09-02; AWS/Grafana co-authored post, aws.amazon.com/blogs/database). The **absence of a `[caching]` section** in OSS `conf/defaults.ini` independently corroborates that result caching ships only in Enterprise/Cloud. **Do not conflate that 5-*minute* result-cache TTL with the OSS 5-*second* data-source-config cache below.**

### 5(b) Data-source-config caching — the real observable BACKEND difference

**Code.** `pkg/services/datasources/service/cache.go` is an in-memory cache of **data-source configuration** (not query results):
- `DefaultCacheTTL = 5 * time.Second` (**`...:L17`**); logger `log.New("datasources")` (`...:L22`).
- `GetDatasource` (id) checks the cache when `!skipCache` (`...:L46-L47`); on a **miss** it logs `Debug("Querying for data source via SQL store", "id", …)` (**`...:L58`**), runs the SQL lookup, then `Set(...)`s the entry with the 5 s TTL.
- `GetDatasourceByUID` (uid) mirrors this: `!skipCache` check (`...:L93-L94`), and on a **miss** logs `Debug("Querying for data source via SQL store", "uid", …)` (**`...:L105`**).

**Runtime proof.** After letting the entry expire (waiting > 5 s), the two runs Q2a + Q2b were fired back-to-back. The `datasources` debug line appeared **exactly once** across the two runs:
```text
logger=datasources level=debug msg="Querying for data source via SQL store" uid=afqc42i8oitxcb orgId=1
```
- **Run 1:** cache **miss** → SQL lookup + the debug line above.
- **Run 2 (within 5 s):** cache **hit** → **no SQL, no debug line.**

This empirically confirms `DefaultCacheTTL = 5 * time.Second`.

**Conclusion (b).** The **first** call logs the `datasources` debug line and performs a SQL lookup; the **second** identical call **within 5 seconds** is a config-cache hit, so it performs **no SQL and emits no log**. This is the concrete, observable **backend** difference between run 1 and run 2. (Because the line is at *Debug* level, it is visible only with `[log] level = debug` or `filters = datasources:debug`.)

> **Corroboration.** Grafana issue #10816 ("Caching Service") notes that historically the only cache present was a 5-second cache for data source settings — independently matching `cache.go`'s `DefaultCacheTTL = 5 * time.Second`.

### 5(c) Frontend in-flight cancellation — the real observable FRONTEND difference

**Code.** As detailed in [Section 2.2](#22-dispatch--cancellation--backend_srvts) and [Section 2.5](#25-the-cancellation-nuance--panelqueryrunnerts-two-paths-do-not-overstate), `backend_srv` cancels a prior in-flight request via `inFlightRequests` + `takeUntil` (same-`requestId` path, `backend_srv.ts:L416-L432`), while `PanelQueryRunner` unsubscribes the previous subscription on each re-run (`PanelQueryRunner.ts:L353-L354`), firing `canceler.ts`'s `finalize` → `resolveCancelerIfExists(prevRequestId)` even when ids differ.

**Runtime proof.** With the **Slow Query (5 s)** scenario in Explore, clicking **Run query** twice quickly produced a cancelled prior request:
```text
reqid=304  POST /api/ds/query?...&requestId=explore_slo   [net::ERR_ABORTED]
```
Explore reuses the *stable* id `explore_slo`, so the **same-`requestId` `takeUntil`** path cancelled the earlier run. This is directly observable as a `(canceled)`/`ERR_ABORTED` entry in the DevTools Network tab.

**Conclusion (c).** If a panel/Explore re-runs while a prior request is still pending, the **prior request is cancelled**. Two fully-completed, sequential runs instead produce **two independent requests**.

### 5(d) No backend de-duplication

**Runtime proof.** The `/metrics` counter for the endpoint incremented **once per execution**:
```text
grafana_http_request_duration_seconds_count{handler="/api/ds/query",method="POST",
    slo_group="high-slow",status_code="200",status_source="server"}
```
went **1 → 3** across Q1 + Q2a + Q2b (and reached 8 over the whole session) — i.e., each execution produced exactly one backend request. There is **no** server-side de-duplication of concurrent identical queries in OSS; the only de-duplication present is the *frontend* cancellation of 5(c).

> **Corroboration.** Grafana/AWS materials describe a "cache stampede" caveat — simultaneous identical uncached queries are sent to the data source in parallel rather than de-duplicated — which matches the observed behavior; the in-flight gauge `grafana_http_request_in_flight` can be monitored to watch concurrency.

### 5(e) Two DISTINCT skip headers — do not conflate

`pkg/middleware/middleware.go` translates two *different* request headers into two *different* skip flags (`HandleNoCacheHeaders`, `...:L25-L30`):

| Request header | Sets flag | Skips… | Code |
|---|---|---|---|
| `X-Grafana-NoCache: true` | `ctx.SkipDSCache` | the data-source **config** cache (5(b)) | `...:L27` |
| `X-Cache-Skip: true` | `ctx.SkipQueryCache` | the **Enterprise** query/resource result cache (5(a)) | `...:L29` |

The in-code comments make the distinction explicit: L26 — skip cache for *datasource instance metadata* (the config cache); L28 — skip the *Enterprise query/resource cache*. Additionally, `addNoCacheHeaders` (`...:L93`) sets `Cache-Control: no-store` on responses (`...:L94`, invoked when a response is not cacheable, `...:L57`); `allowCacheControl` (`...:L121`) and the `X-Grafana-Cache` check (`...:L140`) govern cacheability.

> **Observed at runtime:** Explore sets **`X-Cache-Skip: true`** on its request (`SkipQueryCache`) — which in OSS is moot because the result cache is already a no-op. A dashboard panel sets **neither** skip header. The corroborating docs state that with an `X-Cache-Skip` header <q>Grafana skips the caching middleware</q> and does not search the cache — described as useful for cURL debugging (grafana.com data-source-management docs; Grafana issue #44437 — Explore sends `X-Cache-Skip`). This maps directly to `middleware.go:L29`.

### 5(f) Final KEY verdict

In **OSS** Grafana, the second of two quick identical panel queries is **NOT** treated differently with respect to the query **result** — there is **no result cache** (the caching service is a no-op, `caching/service.go:L56-L58`), so **both** executions run against the TestData backend and return freshly generated data with **no `X-Cache` header**. The only differences are:

1. **a data-source-_config_ cache hit on the backend** (`cache.go:L17`), which silently suppresses one SQL lookup and one `datasources` debug log line within a **5-second** window; and
2. **frontend cancellation** of the earlier in-flight request **if** the second run starts before the first finishes (`backend_srv.ts:L416-L432`, `PanelQueryRunner.ts:L353-L354`, `canceler.ts:L6-L15`).

There is **no backend request de-duplication** — `/metrics` confirms two executions produce two backend requests. Every clause above is tied to cited code **and** a captured runtime signal.

---


## 6. Appendix — logs, headers & metadata

This appendix collects the raw signals captured during the investigation, correlated with the code that produces them.

### 6.1 Backend logs

**Data-source-config cache debug line** (visible only with `[log] level = debug`) — present on run 1, absent on run 2 within 5 s (`cache.go:L105`):
```text
logger=datasources level=debug msg="Querying for data source via SQL store" uid=afqc42i8oitxcb orgId=1
```

**HTTP access log line** (visible only with `router_logging = true`) — one line per execution:
```text
logger=context userId=1 orgId=1 uname=admin level=info msg="Request Completed" \
  method=POST path=/api/ds/query status=200 remote_addr=127.0.0.1 \
  time_ms=10 duration=10.557467ms size=312 referer= handler=/api/ds/query status_source=server
```
The `handler=/api/ds/query` and `status_source=server` labels here line up with the `/metrics` series in 6.4.

### 6.2 Network entries (DevTools)

Two `POST /api/ds/query?ds_type=grafana-testdata-datasource&requestId=<id>` requests were recorded for two executions (no de-duplication). The captured headers:

**Request headers** (panel run):

| Header | Value | Defined at |
|---|---|---|
| `x-datasource-uid` | `afqc42i8oitxcb` | `DataSourceWithBackend.ts:L81` |
| `x-plugin-id` | `grafana-testdata-datasource` | `...:L80` |
| `x-dashboard-uid` | `blitzyqlc01` | `...:L82` |
| `x-panel-id` | `1` | `...:L83` |
| `x-panel-plugin-id` | `timeseries` | `...:L84` |
| `content-type` | `application/json` | (fetch default) |

> Explore additionally sends **`x-cache-skip: true`** (`...:L87`, attached at L246 when `skipQueryCache`); a panel sends neither skip header. `x-query-group-id` (`...:L85`) appears only when a query is split into groups (not in these runs).

**Response headers** (every run, both curl and browser):

| Header | Value | Significance |
|---|---|---|
| `Cache-Control` | `no-store` | set by `middleware.go:addNoCacheHeaders` (`...:L94`) |
| **`X-Cache`** | **(absent)** | **OSS no-op caching service — the directly-observable proof (`caching/service.go:L56-L58`)** |
| `Content-Type` | `application/json` | streamed JSON body |
| `Transfer-Encoding` | `chunked` (Explore) | `response.JSONStreaming` streaming (`ds_query.go:L100`) |
| `X-Content-Type-Options` | `nosniff` | standard security header |
| `X-Frame-Options` | `deny` | standard security header |

The **absence of `X-Cache`** on every response is the single most direct runtime proof that the result cache is a no-op in OSS.

### 6.3 Panel Inspector

The Panel Inspector (opened from a panel's menu → *Inspect*) exposes three relevant tabs:

- **Query tab** — shows the outgoing request and the raw response JSON. Captured live: `request.url = api/ds/query?ds_type=grafana-testdata-datasource&requestId=SQR101`, `request.method = POST`, `request.data = { queries: Array[1], from: "1782507739593", to: "1782508639593" }`, and `response.results.A` with the frame schema + values.
- **Stats tab** — shows timing/size. Captured live: **Total request time: 13 ms**, **Number of queries: 1**, **Total number rows: 16**.
- **Data tab** — renders the returned DataFrame as a table (the deterministic CSV-wave values).

### 6.4 `/metrics` (Prometheus)

The Prometheus endpoint at `http://localhost:3000/metrics` confirms that **two executions produce two backend requests** (no de-duplication). The relevant series:

- **Request counter** — incremented once per execution:
  ```text
  grafana_http_request_duration_seconds_count{handler="/api/ds/query",method="POST",
      slo_group="high-slow",status_code="200",status_source="server"}
  ```
  observed delta **1 → 3** across Q1 + Q2a + Q2b (and 8 cumulatively over the session). The `slo_group="high-slow"` label confirms the route's SLO grouping from `api.go:L521`.

- **In-flight gauge** — `grafana_http_request_in_flight`, HELP: *"A gauge of requests currently being served by Grafana."*

> **Verified metric-name note:** the in-flight gauge is **singular** — **`grafana_http_request_in_flight`** — *not* the plural `grafana_http_requests_in_flight` that appears in some plans/docs. Use the singular name when querying this instance.

### 6.5 Observation-surface console/accessibility notes (pre-existing Grafana UI; out of scope)

While the **Explore** screen and the **TestData query editor** were used purely as *observation tooling* for this investigation, the browser console surfaces a few **pre-existing Grafana UI warnings** that are unrelated to the `/api/ds/query` lifecycle. They are recorded here for completeness and to pre-empt confusion for a future reader. **None of them originates in this deliverable, none touches the query path, and none changes any conclusion in this document.** All three live in **stock Grafana source that is byte-identical to commit `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`** (verified via `git diff 4550cfb5b728..HEAD` showing this Markdown file as the *only* added file and no modified source). Fixing any of them would require editing existing source files, which is **explicitly out of scope** — the user directive *"Do not modify the source code; use runtime observation only"* and the project rules forbid modifying any existing repository file (the only permitted write is this document).

| Console signal (DevTools) | Root cause in stock Grafana source | Build dependence | On the query path? | Disposition |
|---|---|---|---|---|
| `Warning: Each child in a list should have a unique "key" prop … Check the render method of AppChrome. It was passed a child from ExploreToolbar.` | `public/app/features/explore/ExploreToolbar.tsx` builds the `navBarActions` array (`L208`/`L212`/`L227` carry `key`s) but the **query-history `ToolbarButton`** unshifted at **`L214-L224`** (the `else` branch when `isSingleTopNav && !queryLibraryAvailable`) has **no `key`**; the array is handed to `<AppChromeUpdate actions={navBarActions}/>` (`L233`) → `chrome.update({ actions })` and rendered as a list by `AppChrome.tsx` (`L113`/`L122`), so React attributes the warning to *AppChrome … from ExploreToolbar*. | **React *development*-mode warning.** It surfaces under a dev frontend build (`yarn start`, the path the QA run used). Under the **production** asset build observed here (`grafanaBootData.settings.buildInfo.env = "production"`), React suppresses dev-only warnings, so the console showed it **not at all** even though the triggering toggle `singleTopNav` was enabled and the keyless child rendered. | No — chrome/toolbar only. | Pre-existing; out of scope (would require editing `ExploreToolbar.tsx`). |
| `No label associated with a form field (count: 4)` | TestData query-editor inputs, e.g. `public/app/plugins/datasource/grafana-testdata-datasource/components/CSVWaveEditor.tsx`, render four `@grafana/ui` `<Input>` fields (**Values, Step, Name, Labels**) inside `<InlineField label=…>`; the visual label is present but no explicit `id`/`htmlFor` association is wired to the `<input>`. | Chrome accessibility audit; **reproduces in both dev and production builds**. Re-observed live at runtime on the Predictable CSV Wave editor — exactly **count 4** (one per field). | No — query-editor form only. | Pre-existing; out of scope (would require editing the TestData editor and/or `@grafana/ui`). |
| `A form field element should have an id or name attribute (count: 4)` | Same four `@grafana/ui` `<Input>` fields as above carry neither an explicit `id` nor a `name` attribute. | Chrome accessibility audit; reproduces in both dev and production builds. Re-observed live at runtime — exactly **count 4**. | No — query-editor form only. | Pre-existing; out of scope (same files as above). |

> **Why these are not "fixed" here.** Per the precedence that governs this work, an explicit project/AAP exclusion outranks generic accessibility heuristics and framework-default lint warnings. These three signals are characteristics of **pre-existing stock Grafana UI** that this read-only investigation merely *used* to observe the query; remediating them would mean editing tracked source files, which the user's *"do not modify the source code"* constraint and the single-document project rule prohibit. They are therefore documented (root cause + runtime confirmation) rather than altered, leaving the source tree byte-unchanged. They have **zero bearing** on the browser issuance, backend handling, response shape, or the second-execution conclusion established above.

---

## 7. Reproduction steps & cleanup

### 7.1 Build & run OSS Grafana

Per `contribute/developer-guide.md` and the `Makefile`:

- **Frontend deps & dev server:** `yarn install --immutable` (developer-guide `L71`), then `yarn start` (`L79`; `make run-frontend` → `yarn start`, `Makefile:L241-L242`).
- **Backend:** `make run` (`Makefile:L232-L233`, runs `$(BRA) run`) **or** `make run-go` (`Makefile:L236-L238`):
  ```text
  go run -race ./pkg/cmd/grafana -- server -profile -profile-addr=127.0.0.1 \
      -profile-port=6000 -packaging=dev cfg:app_mode=development
  ```
- Grafana serves `http://localhost:3000/` (developer-guide `L123`), default login **`admin`/`admin`** (`L125-L129`).

For this investigation the **prebuilt** binary was used directly (equivalent, faster):
```bash
source /tmp/grafana_env.sh
nohup ./bin/linux-amd64/grafana server --homepath "$(pwd)" \
    cfg:default.paths.data=/tmp/grafana-data > /tmp/grafana-run.log 2>&1 &
# health:
curl -s http://localhost:3000/api/health
# -> {"database":"ok","version":"11.5.0-pre","commit":"4550cfb5b7"}
```

### 7.2 Transient verbose logging (a build-tree, untracked artifact — NOT a source edit)

To surface the access log and the data-source-config debug line, create a **gitignored** `conf/custom.ini`:
```ini
[server]
router_logging = true

[log]
level = debug
```
- `router_logging` defaults to `false` under the `[server]` section in `conf/defaults.ini` (`...:L57`); it **must** be placed under `[server]`, not the global section.
- `[log]` (`conf/defaults.ini:L1068`) defaults to `level = info` (`...:L1074`) with empty `filters` (`...:L1077`).
- **There is no `[caching]` section anywhere in OSS `conf/defaults.ini`** — itself corroborating that result caching is Enterprise-only.

> `conf/custom.ini` is matched by Grafana's `.gitignore` (verified with `git check-ignore`), so it never appears as a tracked change. It is removed during cleanup (7.5).

### 7.3 Deterministic query against the built-in TestData DB

Add the bundled **`grafana-testdata-datasource`** via **Connections → Data sources** (in this run it was created via `POST /api/datasources`, yielding `uid=afqc42i8oitxcb`, `id=1`). Then author a query using a **fixed scenario** so both runs are byte-identical:
- **CSV Content / Predictable CSV Wave** → byte-identical output (recommended for the determinism check). `csv_data.go` implements the CSV scenarios in-process (`handleCsvContentScenario` `...:L20`, `LoadCsvContent` `...:L122`).
- **Slow Query (5 s)** → best for demonstrating the 200 ms loading timer and in-flight cancellation (`scenarios.go` `handleRandomWalkSlowScenario` `...:L405`, `StringInput: "5s"` registered at `...:L75-L80`).

Both a **dashboard panel** and **Explore** were used; both issued `POST /api/ds/query` as expected.

> **Determinism confirmed:** the SHA-256 of the response bodies for Q1, Q2a, and Q2b (CSV-content scenario) were identical (`09b3b801a91f…9435`), proving byte-identical repeats.

### 7.4 Fire once, then twice in quick succession

For each run, all **four** signal sources were captured:
1. **Network** — `POST /api/ds/query` entry, request/response headers, response JSON.
2. **Panel Inspector** — Query/Stats/Data tabs.
3. **Backend logs** — `/tmp/grafana-run.log` (access line + `datasources` debug line).
4. **`/metrics`** — before/after counter deltas.

The decisive captures are summarized in [Section 5](#5-second-execution-analysis--the-key-answer) (no `X-Cache`; slow query re-ran in ~5 s; one debug line across two runs within 5 s; counter 1→3).

### 7.5 Cleanup checklist (source tree left byte-unchanged)

The following transient artifacts were created and then removed so that `git status --porcelain` reports no tracked-file changes:
- [x] Deleted the test data source (`BlitzyTestData`, `uid=afqc42i8oitxcb`).
- [x] Deleted the test dashboard/panel (`uid=blitzyqlc01`).
- [x] Removed the temporary `conf/custom.ini` (gitignored build-tree artifact).
- [x] Stopped the Grafana server and removed `/tmp/grafana-data` and `/tmp/grafana-run.log`.
- [x] Removed temporary capture files under `/tmp` (`blitzy_q1_*`, `blitzy_q2a_*`, `blitzy_q2b_*`, `blitzy_panel_resp.*`).
- [x] Verified `git status --porcelain` is clean (no tracked-file changes in the working tree), and `git diff 4550cfb5b728 --name-status` shows **only** `blitzy/documentation/grafana_4550cfb5b728.md` added, with **no** modified Grafana source files.

> The data source and dashboard were temporary runtime objects stored in the embedded SQLite under `/tmp/grafana-data`; deleting that directory removes them. No tracked repository file was modified at any point in this investigation.

---

### Source-of-truth index (files cited; all READ-ONLY)

| Area | File | Key lines |
|---|---|---|
| Frontend request build | `packages/grafana-runtime/src/utils/DataSourceWithBackend.ts` | L79-L87, L130, L192-L196, L206-L256 |
| Response parse | `packages/grafana-runtime/src/utils/queryResponse.ts` | L60, L78-L88, L118 |
| Fetch + cancellation | `public/app/core/services/backend_srv.ts` | L39, L60, L145-L147, L416-L432 |
| RxJS pipeline | `public/app/features/query/state/runRequest.ts` | L178, L180, L186 |
| Cancel helper | `public/app/features/query/state/processing/canceler.ts` | L6-L15 |
| Panel orchestration | `public/app/features/query/state/PanelQueryRunner.ts` | L67-L71, L283, L347, L353-L354, L365 |
| Route | `pkg/api/api.go` | L521 |
| Handler / streaming / errors | `pkg/api/ds_query.go` | L24-L38, L41-L56, L73-L84, L86-L100 |
| Query service | `pkg/services/query/query.go` | L90, L92, L99, L102-L106, L344, L368, L378 |
| DS config cache (5 s) | `pkg/services/datasources/service/cache.go` | L17, L22, L46-L58, L93-L105 |
| Caching middleware | `pkg/services/pluginsintegration/clientmiddleware/caching_middleware.go` | L58, L72, L75-L92 |
| OSS no-op cache | `pkg/services/caching/service.go` | L10-L15, L38-L40, L56-L64 |
| OSS wiring | `pkg/server/wireexts_oss.go` | L101-L102 |
| Skip headers | `pkg/middleware/middleware.go` | L25-L30, L57, L93-L94, L121, L140 |
| TestData backend | `pkg/tsdb/grafana-testdata-datasource/{scenarios,csv_data,resource_handler}.go` | scenarios L34/L66/L75-L80/L293/L405; csv L20/L57/L122; resource L17 |
| Build/run | `contribute/developer-guide.md`, `Makefile` | guide L71/L79/L119/L123/L125-L129; Makefile L232-L242 |
| Config defaults | `conf/defaults.ini` | L57 (`router_logging`), L1068-L1077 (`[log]`); no `[caching]` section |

*Investigation performed against OSS Grafana at commit `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`. All conclusions are grounded in the cited code and corroborated by captured runtime signals (network, Panel Inspector, backend logs, `/metrics`). The source tree was left byte-unchanged.*

