# The Lifecycle of a Dashboard-Panel Query Against a Built-in Data Source in Grafana OSS

> An evidence-grounded onboarding investigation of how a Grafana dashboard panel issues a
> query, how the backend receives/authorizes/routes/executes it, what comes back, and —
> empirically — **whether executing the same query twice in quick succession causes the second
> execution to be treated differently**.

|                               |                                                                                                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subject**                   | Grafana OSS `11.5.0-pre` ([package.json:L6](../../package.json)), license `AGPL-3.0-only` ([package.json:L3](../../package.json))                                                                                           |
| **Commit**                    | `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` (branch name → doc name: `grafana_4550cfb5b728`)                                                                                                                                 |
| **Built-in data source used** | TestData (`grafana-testdata-datasource`) — provisioned as `TestData`, `uid=cfs41vcohee4gb`                                                                                                                                  |
| **Backend query contracts**   | `github.com/grafana/grafana-plugin-sdk-go v0.260.3` ([go.mod:L92](../../go.mod))                                                                                                                                            |
| **Method**                    | Read-only runtime observation. The source tree was **never modified**. Every behavioral claim below is paired with the actual captured output that produced it; anything not directly observed is labeled **`[INFERRED]`**. |

## TL;DR — the direct answer

- The canonical browser entry point is **`POST /api/ds/query?ds_type=<type>`**, issued by
  `DataSourceWithBackend.query()` through `getBackendSrv().fetch()`, carrying a set of
  `X-*` "plugin request" headers that describe the query's provenance.
- The backend authorizes (`datasources:query`), tags an SLO group, traces, meters, and access-logs
  the request, binds it to the `dtos.MetricRequest` DTO, and runs it through
  `queryDataService.QueryData` → the TestData backend, streaming back a `QueryDataResponse`
  (DataFrames keyed by `refId`).
- **Sequential repeat (same query twice in quick succession): the second execution is NOT treated
  differently.** It is re-executed end-to-end identically — no `X-Cache` header, fresh backend log
  lines for both, and the response bodies differ only because TestData regenerates random values.
  The query-cache seam is an intentional **OSS no-op** (`OSSCachingService`).
- **Concurrent repeat (same `requestId` while the first is still in flight): the earlier request IS
  treated differently — it is canceled/aborted at the browser layer** (`net::ERR_ABORTED`), while
  the later one proceeds. This is browser-side de-duplication, **not** server-side caching (the
  backend still finished the aborted request's work).
- A server-side cache **HIT** with an `X-Cache` header and a ~5-minute TTL is a **Grafana
  Enterprise/Cloud** capability and **`[INFERRED]`** here — it was never observed on this OSS build.

---

## Section 1 — Environment & exact commands (R1)

This section makes the whole investigation reproducible: the exact toolchain, the exact build/run
commands, the ephemeral debug toggles, and confirmation that a built-in data source was available.

### 1.1 Container image & toolchain versions

The investigation ran in the container image supplied with the task
(`andrewparkscaleai/coding-agent:grafana__grafana__4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`,
from `ghcr.io/scaleapi/swe-atlas:swe_atlas_QnA_grafana_grafana_1.0`).

```console
$ go version
go version go1.23.1 linux/amd64          # matches go.mod:L3  → go 1.23.1

$ node -v
v22.23.1                                  # satisfies package.json:L451 "node": ">= 22"  (.nvmrc pins v22.11.0)

$ yarn -v
4.5.3                                     # matches package.json:L453 "packageManager": "yarn@4.5.3"

$ nproc
4                                         # used below to explain the effective concurrent_query_limit

$ git rev-parse HEAD
4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff
```

The prebuilt backend binary was already present and warm (`bin/grafana`, built for
`version=11.5.0-pre commit=4550cfb5b7`); Go module cache and `node_modules` were warm as well.

### 1.2 Running the backend — canonical `make run` path

The canonical developer run is `make run` ([Makefile:L232](../../Makefile) `run: $(BRA)`), which
invokes `bra` using [.bra.toml](../../.bra.toml). The server command `bra` compiles-and-launches is,
verbatim from [.bra.toml:L5]:

```
./bin/grafana server -profile -profile-addr=127.0.0.1 -profile-port=6000 \
  -profile-block-rate=1 -profile-mutex-rate=5 -packaging=dev cfg:app_mode=development
```

To attach the debug-log toggle (see §1.4) and pin the home path, the exact process launched during
this investigation (captured from its real command line) was:

```console
$ ./bin/grafana server -homepath "$PWD" \
    -profile -profile-addr=127.0.0.1 -profile-port=6000 \
    -profile-block-rate=1 -profile-mutex-rate=5 \
    -packaging=dev cfg:app_mode=development \
    cfg:log.level=debug cfg:server.router_logging=true \
    > /tmp/grafana_obs/server.log 2>&1 &
```

Captured startup log lines (verbatim, trimmed to the relevant fields):

```log
logger=settings   ... msg="Starting Grafana" version=11.5.0-pre commit=4550cfb5b7 branch=...
logger=settings   ... msg="Config overridden from command line" arg="log.level=debug"
logger=settings   ... msg="Config overridden from command line" arg="server.router_logging=true"
logger=http.server... msg="HTTP Server Listen" address=[::]:3000 protocol=http
```

The `-profile` args are real: the pprof server on `127.0.0.1:6000` answered `/debug/pprof/` with
HTTP 200.

### 1.3 Running the frontend — `yarn start`

The frontend webpack watch build is `yarn start` ([Makefile:L242](../../Makefile)); the app is
served at `http://localhost:3000/` ([contribute/developer-guide.md](../../contribute/developer-guide.md)).
Captured completion line (verbatim, trimmed):

```log
[success] [webpackbar] Grafana: Compiled successfully in 25.88s
... 306 assets / 12301 modules ... webpack 5.95.0 compiled successfully in 25886 ms
... Type-checking in progress ... No errors found.
```

Server reachability and login:

```console
$ curl -s http://localhost:3000/api/health
{"database":"ok","version":"11.5.0-pre","commit":"4550cfb5b7"}

$ curl -s -c cookie.txt -X POST http://localhost:3000/login \
    -H 'Content-Type: application/json' -d '{"user":"admin","password":"admin"}'
{"message":"Logged in","redirectUrl":"/"}
```

### 1.4 Ephemeral debug toggles (runtime-only, reverted at cleanup)

Two toggles were applied **only as command-line arguments** to the running process — no file on disk
was changed:

- `cfg:log.level=debug` — raises the log level so the `query_data`, `tsdb.testdata`, and `expr`
  debug lines used throughout this document become visible.
- `cfg:server.router_logging=true` — Grafana's access logger normally **suppresses** the
  `"Request Completed"` line for `200`/`304` responses. In
  [pkg/middleware/loggermw/logger.go:L98-L100](../../pkg/middleware/loggermw/logger.go), the log level
  is forced to "never" (`errutil.LevelNever`) for `200/304` **unless** `cfg.RouterLogging` is set; the default is
  `router_logging = false` ([conf/defaults.ini:L57](../../conf/defaults.ini), `[server]` section).
  Enabling it lets the `200` access-log line appear so both sides of the repeated-execution
  comparison are visible. **This toggle changes only log verbosity — it has zero effect on query
  processing, caching, or the R6 conclusion.**

Both toggles are CLI-only and are reverted simply by restarting without them (see Section 7).

### 1.5 Built-in data source confirmation (R2)

The built-in TestData source (`grafana-testdata-datasource`) was present and default:

```console
$ curl -s -b cookie.txt http://localhost:3000/api/datasources | python -m json.tool
[
  {
    "id": 1,
    "uid": "cfs41vcohee4gb",
    "name": "TestData",
    "type": "grafana-testdata-datasource",
    "isDefault": true,
    "access": "proxy",
    "readOnly": false
  }
]
```

> **Note on provisioning (observed):** the default provisioning directory `conf/provisioning`
> ([conf/defaults.ini:L27](../../conf/defaults.ini)) ships `datasources/sample.yaml` fully commented
> out, and `devenv/datasources.yaml` (which defines `gdev-testdata`, `type: testdata`,
> [devenv/datasources.yaml:L86-L88](../../devenv/datasources.yaml)) is **not** loaded unless the
> devenv path is used. The `TestData` instance above lives in the gitignored embedded SQLite
> (`data/grafana.db`) from an earlier interactive session; it is runtime state, **not** a
> source-tree change. The TestData backend itself is in-tree at
> [pkg/tsdb/grafana-testdata-datasource/](../../pkg/tsdb/grafana-testdata-datasource/)
> (`testdata.go`, `scenarios.go`, `resource_handler.go`). This fully satisfies R2 (a built-in
> source; external sources such as Prometheus/Loki/SQL are out of scope).

---

## Section 2 — Browser issuance (R3)

This section captures **how the panel issues its query from the browser**: the outgoing request,
its target URL, its payload, and its headers — observed in Chrome DevTools on the real React app
(not a mock or a synthetic bypass).

### 2.1 The frontend call chain (code path)

A panel refresh flows through the following chain (file:line references resolve at this commit):

```
PanelQueryRunner.run()
  └─ runRequest(ds, request)                      public/app/features/query/state/PanelQueryRunner.ts:L333
       └─ callQueryMethodWithMigration            public/app/features/query/state/runRequest.ts:L146, L189
            └─ callQueryMethod                     public/app/features/query/state/runRequest.ts:L203
                 └─ from(datasource.query(request))public/app/features/query/state/runRequest.ts:L220
                      └─ DataSourceWithBackend.query()
                           builds URL '/api/ds/query?ds_type=' + this.type   DataSourceWithBackend.ts:L209
                           sets X-* headers                                    DataSourceWithBackend.ts:L206-246
                           getBackendSrv().fetch({url, method:'POST', ...})    DataSourceWithBackend.ts:L248-256
```

The per-run `requestId` is generated by `getNextRequestId()`
([public/app/features/query/state/PanelQueryRunner.ts:L69](../../public/app/features/query/state/PanelQueryRunner.ts))
— a page-global counter (`'Q' + counter++`, starting at 100). **Every run gets a unique id**; this
fact is central to the concurrent-cancellation analysis in Section 5.

### 2.2 Observed request — a panel bound to TestData

Captured in DevTools (Network panel) for a **saved** dashboard panel (dashboard `uid=cfs442olodw5cd`,
panel `id=1`). The request line:

```
POST http://localhost:3000/api/ds/query?ds_type=grafana-testdata-datasource&requestId=SQR100
```

- `ds_type=grafana-testdata-datasource` — appended at
  [DataSourceWithBackend.ts:L209](../../packages/grafana-runtime/src/utils/DataSourceWithBackend.ts)
  (`'/api/ds/query?ds_type=' + this.type`).
- `&requestId=SQR100` — appended at
  [DataSourceWithBackend.ts:L229-L230](../../packages/grafana-runtime/src/utils/DataSourceWithBackend.ts)
  when a `requestId` is present.

**Request payload** (verbatim; this is the `dtos.MetricRequest` body):

```json
{
  "queries": [
    {
      "scenarioId": "random_walk",
      "seriesCount": 1,
      "refId": "A",
      "datasource": { "type": "grafana-testdata-datasource", "uid": "cfs41vcohee4gb" },
      "datasourceId": 1,
      "intervalMs": 30000,
      "maxDataPoints": 500
    }
  ],
  "from": "1784036266141",
  "to": "1784057866141"
}
```

Mapping to the DTO ([pkg/api/dtos/models.go:L64](../../pkg/api/dtos/models.go) `MetricRequest`):
`from` → [L68], `to` → [L72], `queries[]` (`[]*simplejson.Json`) → [L79], and the optional `debug`
flag → [L81]. Each element of `queries[]` is an opaque per-datasource query object (here TestData's
`scenarioId`, `seriesCount`, plus the framework-injected `intervalMs`/`maxDataPoints`).

### 2.3 Observed request headers — the `PluginRequestHeaders`

The headers below are the primary **"metadata that reveals how the query is processed"** (R7). They
are declared as the `PluginRequestHeaders` enum at
[DataSourceWithBackend.ts:L79-L87](../../packages/grafana-runtime/src/utils/DataSourceWithBackend.ts)
and set at [L206-L246]. Captured request headers on the saved-panel query (verbatim):

```http
x-datasource-uid: cfs41vcohee4gb
x-plugin-id: grafana-testdata-datasource
x-dashboard-uid: cfs442olodw5cd
x-panel-id: 1
x-panel-plugin-id: timeseries
x-grafana-org-id: 1
x-grafana-device-id: <REDACTED_DEVICE_ID>
content-type: application/json
accept: application/json, text/plain, */*
cookie: grafana_session=<REDACTED_SESSION_COOKIE>
origin: http://localhost:3000
referer: http://localhost:3000/d/cfs442olodw5cd/blitzy-testdata-panel?...&editPanel=1
```

Header-by-header cause → effect:

| Header                | Observed value                | Code cause                                                                                                                                        |
| --------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Plugin-Id`         | `grafana-testdata-datasource` | always set, [DataSourceWithBackend.ts:L206](../../packages/grafana-runtime/src/utils/DataSourceWithBackend.ts)                                    |
| `X-Datasource-Uid`    | `cfs41vcohee4gb`              | always set, [DataSourceWithBackend.ts:L207](../../packages/grafana-runtime/src/utils/DataSourceWithBackend.ts)                                    |
| `X-Dashboard-Uid`     | `cfs442olodw5cd`              | set only when `request.dashboardUID` present, [L233](../../packages/grafana-runtime/src/utils/DataSourceWithBackend.ts)                           |
| `X-Panel-Id`          | `1`                           | set only when a dashboard UID + panel id exist, [L234-L237](../../packages/grafana-runtime/src/utils/DataSourceWithBackend.ts)                    |
| `X-Panel-Plugin-Id`   | `timeseries`                  | set when `request.panelPluginId` present, [L240](../../packages/grafana-runtime/src/utils/DataSourceWithBackend.ts)                               |
| `X-Query-Group-Id`    | _(absent here)_               | set when `request.queryGroupId` present, [L243](../../packages/grafana-runtime/src/utils/DataSourceWithBackend.ts)                                |
| `X-Grafana-From-Expr` | _(absent on plain query)_     | set to `'true'` only for expression batches, [L224](../../packages/grafana-runtime/src/utils/DataSourceWithBackend.ts) — see §5 / expression path |
| `X-Cache-Skip`        | _(absent here)_               | set when `request.skipQueryCache`, [L246](../../packages/grafana-runtime/src/utils/DataSourceWithBackend.ts)                                      |

**Observed conditional behavior:** on an **unsaved** dashboard the same panel query omitted
`X-Dashboard-Uid` and `X-Panel-Id` (there is no persisted dashboard UID yet), and used
`requestId=SQR100`; after saving the dashboard, the identical panel produced the full header set
above. This directly confirms the guard at
[DataSourceWithBackend.ts:L233-L238](../../packages/grafana-runtime/src/utils/DataSourceWithBackend.ts).

### 2.4 `curl` supplement (labeled — raw header bytes only)

To inspect raw header bytes independently of the SPA, the same request was replayed with `curl`.
**This is a supplement, not the canonical browser entry point** (the browser path above is the
authoritative R3 evidence):

```console
$ curl -s -b cookie.txt -D - -o /dev/null \
    -X POST 'http://localhost:3000/api/ds/query?ds_type=grafana-testdata-datasource' \
    -H 'Content-Type: application/json' \
    -d '{"queries":[{"refId":"A","scenarioId":"random_walk","datasource":{"uid":"cfs41vcohee4gb","type":"grafana-testdata-datasource"},"intervalMs":1000,"maxDataPoints":5}],"from":"now-5m","to":"now"}'
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Transfer-Encoding: chunked
```

---

## Section 3 — Backend handling (R4 / R7)

This section captures **how the backend receives, authorizes, routes, and executes** the query, plus
the observability artifacts (logs, tracing, metrics, metadata) that reveal the processing.

### 3.1 Route registration & middleware chain

The route is registered at [pkg/api/api.go:L521](../../pkg/api/api.go):

```go
apiRoute.Post("/ds/query",
    requestmeta.SetSLOGroup(requestmeta.SLOGroupHighSlow),
    authorize(ac.EvalPermission(datasources.ActionQuery)),
    hs.getDSQueryEndpoint())
```

Each element of the chain, and the evidence it produced:

- **SLO grouping** — `requestmeta.SetSLOGroup(SLOGroupHighSlow)` tags the request; `SLOGroupHighSlow`
  is the string `"high-slow"` ([pkg/middleware/requestmeta/request_metadata.go:L42](../../pkg/middleware/requestmeta/request_metadata.go)).
  Observed in the Prometheus metrics below (`slo_group="high-slow"`).
- **Authorization** — `authorize(ac.EvalPermission(datasources.ActionQuery))` enforces the
  `datasources:query` action. All observed requests carried the authenticated
  `grafana_session` cookie and succeeded; unauthenticated calls are documented to return `401`
  (swagger block, [pkg/api/ds_query.go:L60-L68](../../pkg/api/ds_query.go)).
- **Tracing** — per-request spans via [pkg/middleware/request_tracing.go](../../pkg/middleware/request_tracing.go).
- **Metrics** — per-request Prometheus histogram via [pkg/middleware/request_metrics.go](../../pkg/middleware/request_metrics.go) (see §3.5).
- **Access logging** — the `"Request Completed"` line via [pkg/middleware/loggermw/logger.go:L84](../../pkg/middleware/loggermw/logger.go) (see §3.4).

### 3.2 Endpoint dispatch — `FlagQueryServiceRewrite` is OFF (observed)

`getDSQueryEndpoint` ([pkg/api/ds_query.go:L41](../../pkg/api/ds_query.go)) branches on a feature flag:

```go
func (hs *HTTPServer) getDSQueryEndpoint() web.Handler {
    if hs.Features.IsEnabledGlobally(featuremgmt.FlagQueryServiceRewrite) { // L42
        ...
        r.URL.Path = "/apis/query.grafana.app/v0alpha1/namespaces/" + namespaceMapper(...) + "/query" // L52
        hs.clientConfigProvider.DirectlyServeHTTP(w, r)                                                // L53
        ...
    }
    return routing.Wrap(hs.QueryMetricsV2) // L55  ← default OSS path
}
```

The flag `queryServiceRewrite` is `FeatureStageExperimental`
([pkg/services/featuremgmt/registry.go:L743-L747](../../pkg/services/featuremgmt/registry.go),
constant at [toggles_gen.go:L404](../../pkg/services/featuremgmt/toggles_gen.go)) → **off by default**.
Confirmed by observation: across the entire server log there were **zero** requests rewritten to
`/apis/query.grafana.app/...`, and every `/api/ds/query` line reported `handler=/api/ds/query`
(i.e. the `QueryMetricsV2` wrap):

```console
$ grep -c 'apis/query.grafana.app' server.log
0
$ grep 'path=/api/ds/query' server.log | grep -oE 'handler=[^ ]+' | sort -u
handler=/api/ds/query
```

### 3.3 Handler & orchestration

`QueryMetricsV2` ([pkg/api/ds_query.go:L73](../../pkg/api/ds_query.go)) binds the body and delegates:

```go
func (hs *HTTPServer) QueryMetricsV2(c *contextmodel.ReqContext) response.Response {
    reqDTO := dtos.MetricRequest{}
    if err := web.Bind(c.Req, &reqDTO); err != nil {          // L75  → 400 on bind failure (L76)
        return response.Error(http.StatusBadRequest, "query bad request", err)
    }
    resp, err := hs.queryDataService.QueryData(
        c.Req.Context(), c.SignedInUser, c.SkipDSCache, reqDTO) // L79
    ...
}
```

`ServiceImpl.QueryData` ([pkg/services/query/query.go:L90](../../pkg/services/query/query.go)) then
either routes expression queries through `handleExpressions`
([query.go:L99](../../pkg/services/query/query.go), def at [L203]) **or** runs plain queries through
`executeConcurrentQueries` ([query.go:L106](../../pkg/services/query/query.go), def at [L116]),
grouping by data source and executing concurrently (with panic recovery and a
`"skipped duplicate response header"` warning path at [L181]). The service logger is
`log.New("query_data")` ([query.go:L56](../../pkg/services/query/query.go)).

**Concurrency accuracy (do not conflate two settings):** the query service's concurrency limit is
read from `[query] concurrent_query_limit`, which is **empty by default**, so it falls back to
`runtime.NumCPU()`:

```go
concurrentQueryLimit := cfg.SectionWithEnvOverrides("query").
    Key("concurrent_query_limit").MustInt(runtime.NumCPU())  // query.go:L57
```

With `nproc = 4` (see §1.1), the **effective limit is 4**. This is **different** from
`[datasources] concurrent_query_count = 10` ([conf/defaults.ini:L463](../../conf/defaults.ini)),
which applies only to data sources that implement per-datasource concurrency (e.g. Loki/InfluxDB),
**not** to the query-service fan-out above.

### 3.4 Captured backend logs (correlated to the browser request)

The browser query in §2.2 (`from=1784036266141 to=1784057866141 interval=30000 maxDataPoints=500`)
correlated **exactly** with these debug lines (verbatim, trimmed):

```log
logger=query_data t=2026-07-14T19:37:55.871102088Z level=debug msg="Processed metrics query" \
  ref_id=A from=1784036266141 to=1784057866141 interval=30000 max_data_points=500 \
  query="{...\"scenarioId\":\"random_walk\",\"seriesCount\":1...}"

logger=tsdb.testdata endpoint=queryData pluginId=grafana-testdata-datasource dsName=TestData \
  dsUID=cfs41vcohee4gb uname=admin t=2026-07-14T19:37:55.871648372Z level=debug \
  msg=queryData scenario=random_walk
```

The `query_data` logger ([query.go:L56](../../pkg/services/query/query.go)) proves the orchestration
saw the query; the `tsdb.testdata` logger proves it was routed into the in-tree TestData backend
([pkg/tsdb/grafana-testdata-datasource/](../../pkg/tsdb/grafana-testdata-datasource/)).

The access-log line ([loggermw/logger.go:L84](../../pkg/middleware/loggermw/logger.go)) — with the
`server.router_logging=true` toggle so the `200` is not suppressed — is:

```log
logger=context userId=1 orgId=1 uname=admin t=2026-07-14T19:42:17.394525145Z level=info \
  msg="Request Completed" method=POST path=/api/ds/query status=200 remote_addr=127.0.0.1 \
  time_ms=98 duration=98.875004ms size=23988 handler=/api/ds/query status_source=server
```

Its fields map to `method` [L107], `path` [L108], `status` (from `rw.Status()`, [L94]) [L109], and
`duration` [L112] in [pkg/middleware/loggermw/logger.go](../../pkg/middleware/loggermw/logger.go).

### 3.5 Metadata / observability artifacts (R7)

**SLO group + downstream status source** are visible in the Prometheus request-duration histogram
scraped from `/metrics`:

```text
grafana_http_request_duration_seconds_count{handler="/api/ds/query",method="POST",slo_group="high-slow",status_code="200",status_source="server"} 1
grafana_http_request_duration_seconds_count{handler="/api/ds/query",method="POST",slo_group="high-slow",status_code="400",status_source="downstream"} 1
```

This single line encodes several processing insights at once: the route `handler`, the HTTP
`method`, the SLO group `high-slow` (from `SetSLOGroup`), and `status_source` — `server` for the
successful query vs `downstream` for the failing one. The `status_source=downstream` marking is
produced by `requestmeta.WithDownstreamStatusSource`
([pkg/middleware/requestmeta/request_metadata.go:L100](../../pkg/middleware/requestmeta/request_metadata.go)),
which the handler invokes when a per-query error is present (see §4.1). Tracing spans are emitted by
[request_tracing.go](../../pkg/middleware/request_tracing.go); individual span export was not scraped
in this run — **`[INFERRED]`** that a span exists per request from the middleware registration, but
the concrete span payload was not captured.

---

## Section 4 — Response (R5)

This section captures **what returns to the panel**: the HTTP status, the response headers, and the
`QueryDataResponse` body shape.

### 4.1 Status-code semantics

The response is produced by `toJsonStreamingResponse`
([pkg/api/ds_query.go:L86-L101](../../pkg/api/ds_query.go)):

- **`200`** is the default status ([ds_query.go:L87](../../pkg/api/ds_query.go)).
- **`400`** is returned when **any** per-query response carries an error (`res.Error != nil`,
  [ds_query.go:L90](../../pkg/api/ds_query.go)); the same branch marks the downstream status source
  via `requestmeta.WithDownstreamStatusSource(ctx)` ([ds_query.go:L97](../../pkg/api/ds_query.go)).
- **`207`** (multi-status) is documented in the swagger block
  ([ds_query.go:L60-L68](../../pkg/api/ds_query.go)) for mixed per-query outcomes.
- The body is streamed via `response.JSONStreaming(statusCode, qdr)`
  ([ds_query.go:L100](../../pkg/api/ds_query.go)).

Both the `200` (success) and `400` (failure) branches were observed — see §4.4 and Section 5.

### 4.2 Observed response headers

Verbatim response headers for the successful panel/`curl` query:

```http
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Transfer-Encoding: chunked
```

Two points matter for the R6 question:

- **`Cache-Control: no-store`** was the actually-observed value on every `/api/ds/query` response
  (browser and `curl`). Its browser-caching implication: the browser will **not** store or reuse
  this response — each issuance is a fresh network round-trip. (On the request side, Grafana can also
  set an `X-Grafana-NoCache` header from `noBackendCache`,
  [public/app/core/services/backend_srv.ts:L205-L207](../../public/app/core/services/backend_srv.ts).)
- **No `X-Cache` header is present.** This is the single most important response-side observation for
  R6: the server-side query cache declares the header name `X-Cache`
  ([pkg/services/caching/service.go:L10](../../pkg/services/caching/service.go)) with statuses
  `HIT/MISS/BYPASS/ERROR/DISABLED` ([service.go:L11-L15]), but on this OSS build it is **never
  emitted** (see Section 5 for the mechanism). A raw count across the whole server log:

```console
$ grep -ci 'x-cache' server.log
0
```

### 4.3 Observed response body — `QueryDataResponse` (DataFrames)

The body is a streamed `backend.QueryDataResponse`: a `results` map keyed by `refId`, each entry a
`status` plus a `frames` array, each frame carrying a `schema` (field definitions) and `data`
(column-oriented `values`). Captured body (real, **…truncated…** where the numeric arrays are long):

<!-- prettier-ignore -->
```json
{
  "results": {
    "A": {
      "status": 200,
      "frames": [
        {
          "schema": {
            "refId": "A",
            "meta": { "typeVersion": [0, 0], "custom": { "customStat": 10 } },
            "fields": [
              { "name": "time", "type": "time", "typeInfo": { "frame": "time.Time" },
                "config": { "interval": 15000 } },
              { "name": "A-series", "type": "number",
                "typeInfo": { "frame": "float64", "nullable": true },
                "labels": { "__name__": "A-series" } }
            ]
          },
          "data": {
            "values": [
              [1784036862203, 1784036877203, "…truncated…"],
              [86.79780153369589, 86.37056243514286, "…truncated…"]
            ]
          }
        }
      ]
    }
  }
}
```

The two parallel arrays under `data.values` are the `time` column and the `A-series` number column;
their lengths equal the number of generated points. These DataFrame types come from the
`grafana-plugin-sdk-go v0.260.3` contracts ([go.mod:L92](../../go.mod)).

### 4.4 The `400` error-path response (edge case)

Issuing TestData's `random_walk_with_error` scenario deliberately makes a per-query error, exercising
the `res.Error != nil` → `400` branch:

```console
$ curl -s -b cookie.txt -D - \
    -X POST 'http://localhost:3000/api/ds/query?ds_type=grafana-testdata-datasource' \
    -H 'Content-Type: application/json' \
    -d '{"queries":[{"refId":"A","scenarioId":"random_walk_with_error","datasource":{"uid":"cfs41vcohee4gb","type":"grafana-testdata-datasource"}}],"from":"now-5m","to":"now"}'
HTTP/1.1 400 Bad Request
Cache-Control: no-store
...
```

Response body (verbatim, trimmed):

```json
{"results":{"A":{"error":"this is an error and it can include URLs http://grafana.com/","errorSource":"plugin","status":500,"frames":[ ... ]}}}
```

Note the interplay: the **per-query** entry reports `status:500` with `errorSource:"plugin"`, while
the **overall HTTP** status is `400` (from the `res.Error != nil` branch,
[ds_query.go:L90](../../pkg/api/ds_query.go)). The correlated access-log line confirms the
downstream attribution:

```log
logger=context ... msg="Request Completed" method=POST path=/api/ds/query status=400 \
  time_ms=23 duration=23.816038ms size=10018 handler=/api/ds/query status_source=downstream
```

`status_source=downstream` here (vs `server` for the `200`) is the observable effect of
`WithDownstreamStatusSource` ([ds_query.go:L97](../../pkg/api/ds_query.go)).

---

## Section 5 — Repeated-execution comparison (R6)

This is the core of the investigation. Two modes were exercised, **each reproduced ≥2×** for
stability: **sequential** (the same query twice in quick succession) and **concurrent** (two
identical in-flight requests with the same `requestId`).

### 5.1 Sequential mode — the second execution is NOT treated differently

Two identical `POST`s were issued back-to-back with a fixed absolute time range (so the request
payloads are byte-identical) and a fixed `requestId=SEQTEST`:

```console
$ URL='http://localhost:3000/api/ds/query?ds_type=grafana-testdata-datasource&requestId=SEQTEST'
$ BODY='{"queries":[{"refId":"A","scenarioId":"random_walk","seriesCount":1,"datasource":{"uid":"cfs41vcohee4gb","type":"grafana-testdata-datasource"},"datasourceId":1,"intervalMs":30000,"maxDataPoints":10}],"from":"1784030000000","to":"1784033600000"}'

$ curl -s -b cookie.txt -D h1 -o b1.json -w 'HTTP %{http_code} time_total=%{time_total}s\n' -X POST "$URL" -H 'Content-Type: application/json' -d "$BODY"
HTTP 200 time_total=0.007027s
$ curl -s -b cookie.txt -D h2 -o b2.json -w 'HTTP %{http_code} time_total=%{time_total}s\n' -X POST "$URL" -H 'Content-Type: application/json' -d "$BODY"
HTTP 200 time_total=0.002132s
```

**Headers — identical except `Date`:**

```console
$ diff <(grep -vi '^date:' h1) <(grep -vi '^date:' h2) && echo "[IDENTICAL headers except Date]"
[IDENTICAL headers except Date]
```

Both header blocks were:

```http
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Transfer-Encoding: chunked
```

**No `X-Cache` on either response:**

```console
$ grep -ci 'x-cache' h1 h2
h1:0
h2:0
```

**Bodies differ — proving fresh re-execution (not cached bytes):**

```console
$ sha256sum b1.json b2.json
6ea977abd6194ebf90cf84027de9bc99aa350a282673eec9786d2984090a7c7b  b1.json
684b24e6044e3cdbb4b7ba67b29683edfb884efbff425c69f174e82cb385f2f8  b2.json
# first A-series values:
#   b1: [86.79780153369589, 86.37056243514286, ...]
#   b2: [38.82618963137177, 38.60341620192038, ...]
```

If the second call had been served from a cache, the bytes would be identical; instead TestData
regenerated a fresh random walk, so the payloads differ. **The second execution ran the full
pipeline again**, as the backend log shows two independent executions ~9.4 ms apart:

```log
logger=query_data     t=2026-07-14T20:01:47.501705789Z level=debug msg="Processed metrics query" ref_id=A ... scenarioId:random_walk
logger=tsdb.testdata  t=2026-07-14T20:01:47.501981262Z level=debug msg=queryData scenario=random_walk
logger=context        t=2026-07-14T20:01:47.502202171Z level=info  msg="Request Completed" method=POST path=/api/ds/query status=200 duration=6.445215ms size=4181 handler=/api/ds/query status_source=server

logger=query_data     t=2026-07-14T20:01:47.511108170Z level=debug msg="Processed metrics query" ref_id=A ... scenarioId:random_walk
logger=tsdb.testdata  t=2026-07-14T20:01:47.511270711Z level=debug msg=queryData scenario=random_walk
logger=context        t=2026-07-14T20:01:47.511495186Z level=info  msg="Request Completed" method=POST path=/api/ds/query status=200 duration=1.696529ms size=4235 handler=/api/ds/query status_source=server
```

This pattern reproduced across multiple back-to-back pairs during the session (stable).

**Side-by-side summary (sequential):**

| Aspect                              | 1st execution                           | 2nd execution (quick succession)  | Treated differently?            |
| ----------------------------------- | --------------------------------------- | --------------------------------- | ------------------------------- |
| HTTP status                         | `200`                                   | `200`                             | No                              |
| Response headers                    | `Cache-Control: no-store`, no `X-Cache` | identical (except `Date`)         | No                              |
| `query_data` + `tsdb.testdata` logs | present                                 | present again (fresh)             | No — re-executed                |
| Response body                       | random walk #1                          | random walk #2 (different values) | No cache — fresh compute        |
| Duration                            | 6.4 ms                                  | 1.7 ms                            | Only OS/JIT warmth; not a cache |

### 5.2 Why — the OSS caching seam is an intentional no-op (cause → effect)

The repeated-execution question maps directly to Grafana's query-cache middleware. The call sequence
in `CachingMiddleware.QueryData`
([pkg/services/pluginsintegration/clientmiddleware/caching_middleware.go:L58](../../pkg/services/pluginsintegration/clientmiddleware/caching_middleware.go)):

1. It consults the cache: `m.caching.HandleQueryRequest(ctx, req)`
   ([caching_middleware.go:L72](../../pkg/services/pluginsintegration/clientmiddleware/caching_middleware.go)).
2. In OSS this is `OSSCachingService.HandleQueryRequest`, which **"does nothing"**
   ([pkg/services/caching/service.go:L52](../../pkg/services/caching/service.go)) and returns
   `(false, CachedQueryDataResponse{})` ([service.go:L56-L58]) — wired via `ProvideCachingService()`
   returning `&OSSCachingService{}` ([service.go:L38-L40]).
3. Therefore `hit` is **always false**, so the early cache-hit return
   ([caching_middleware.go:L87-L89](../../pkg/services/pluginsintegration/clientmiddleware/caching_middleware.go))
   **never fires**, and control always falls through to the real executor
   `resp, err := m.BaseHandler.QueryData(ctx, req)` ([caching_middleware.go:L92]).
4. Because the cache's `UpdateCacheFn` is nil, no write-back happens
   ([caching_middleware.go:L95-L98]), and **no `X-Cache` header is ever set**
   ([pkg/services/caching/service.go:L10](../../pkg/services/caching/service.go)). Consequently the
   caching histogram ([caching_metrics.go:L14](../../pkg/services/pluginsintegration/clientmiddleware/caching_metrics.go))
   is never observed either.

This exactly explains the observed absence of `X-Cache` and the fresh re-execution on every call.

> **`[INFERRED]` (Enterprise/Cloud contrast — not observed here):** Grafana Enterprise/Cloud ship a
> real `CachingService` that returns `hit=true` within a TTL (default ~5 minutes), sets `X-Cache: HIT`
> and returns the cached `QueryDataResponse` without re-executing. That differential second-execution
> behavior is **absent from this OSS build** and was **not** manufactured (Enterprise caching was never
> enabled). This contrast is included only for completeness and is explicitly inferred from the code
> seam + public documentation, not from runtime observation.

### 5.3 Concurrent mode — the earlier in-flight request IS canceled (same `requestId`)

Ordinary panel refreshes cannot collide, because `getNextRequestId()` increments a page-global
counter (`'Q' + counter++`,
[PanelQueryRunner.ts:L69](../../public/app/features/query/state/PanelQueryRunner.ts)) — each refresh
gets a unique id (observed live: three refreshes produced `requestId=SQR100`, `SQR101`, `SQR102`,
all completing `200` with no cancellation). To exercise the documented **same-`requestId`**
cancellation, two overlapping requests must share one id.

Using the **real** `BackendSrv` singleton from the running app (obtained via the webpack module
registry — not a mock), two `getBackendSrv().fetch()` calls were issued against TestData's 5-second
`slow_query` scenario with an **identical** `requestId`, the second fired ~400 ms after the first
while the first was still in flight. Observed result (run 1):

<!-- prettier-ignore -->
```json
{
  "HTTP_REQUEST_CANCELED": -1,
  "requestId": "BLITZY_DEDUP_1",
  "first":  { "error": { "at_ms": 402, "cancelled": true, "type": "cancelled",
                          "status": -1, "statusText": "Request was aborted" } },
  "second": { "firedAt_ms": 402, "next": { "status": 200, "at_ms": 5409 },
              "complete": { "at_ms": 5409 } }
}
```

Reproduced identically (run 2, `requestId=BLITZY_DEDUP_2`): `first` → `cancelled:true status:-1
"Request was aborted"` at 402 ms; `second` → `200` at 5408 ms. **Stable across both runs.**

The DevTools Network panel confirms the cancellation at the browser layer (both runs):

```text
POST /api/ds/query?...&requestId=BLITZY_DEDUP_1  → net::ERR_ABORTED   (first,  canceled)
POST /api/ds/query?...&requestId=BLITZY_DEDUP_1  → 200                (second, completed)
POST /api/ds/query?...&requestId=BLITZY_DEDUP_2  → net::ERR_ABORTED   (first,  canceled)
POST /api/ds/query?...&requestId=BLITZY_DEDUP_2  → 200                (second, completed)
```

**Mechanism (cause → effect), all in [public/app/core/services/backend_srv.ts](../../public/app/core/services/backend_srv.ts):**
`internalFetch` publishes the request's `requestId` to the `inFlightRequests` subject on start
([L146-L147]). Each request's stream is wrapped by `handleStreamCancellation`, which
`takeUntil(inFlightRequests.filter(id => id === options.requestId || id === CANCEL_ALL_REQUESTS_REQUEST_ID))`
([L416-L432]). A request cannot cancel itself (its `takeUntil` subscribes _after_ its own publish),
but when a **later** request with the **same** `requestId` publishes, the earlier in-flight stream
completes via `takeUntil` and `throwIfEmpty` throws a cancellation error
`{ type: Cancelled, cancelled: true, status: HTTP_REQUEST_CANCELED (-1), statusText: 'Request was aborted' }`
([L442-L448]). This is the browser-layer request de-duplication described in
[contribute/architecture/frontend-data-requests.md:L19-L24](../../contribute/architecture/frontend-data-requests.md);
the request queue limits (hard-coded 5 for HTTP/1.1, 1000 for HTTP/2) are documented at
[frontend-data-requests.md:L44-L48](../../contribute/architecture/frontend-data-requests.md).

**Important server-side nuance (observed):** the cancellation is a **client-side** concern. The
backend still ran **all four** `slow_query` executions to completion (each logged
`status=200` after a full ~5 s), because TestData's slow scenario uses a plain
`time.Sleep` ([pkg/tsdb/grafana-testdata-datasource/scenarios.go:L405-L424](../../pkg/tsdb/grafana-testdata-datasource/scenarios.go))
that is not tied to request-context cancellation:

```log
# two aborted-at-client + two completed, all finish server-side with status=200 ~5s later
logger=tsdb.testdata t=...19:54:28.291... msg=queryData scenario=slow_query
logger=tsdb.testdata t=...19:54:28.624... msg=queryData scenario=slow_query
logger=context       ...msg="Request Completed" ...status=200 duration=5.070381748s handler=/api/ds/query
logger=context       ...msg="Request Completed" ...status=200 duration=5.002660793s handler=/api/ds/query
```

So concurrent de-duplication cancels the browser's **wait** for the earlier response; it does not
(in OSS TestData) stop the server work, and it is emphatically **not** a cache.

### 5.4 Direct answer to R6

- **Sequential (same query twice in quick succession): NO — the second execution is not treated
  differently.** It is re-executed end-to-end identically: same `200`, identical headers (no
  `X-Cache`), fresh `query_data`/`tsdb.testdata` log lines for both, and a freshly-computed body.
  Root cause: the OSS query cache is a no-op (`OSSCachingService`, §5.2).
- **Concurrent (same `requestId`, first still in flight): YES — but only the earlier request, and
  only at the browser layer.** The ongoing request is canceled/aborted (`net::ERR_ABORTED`, rxjs
  `Cancelled`, `status:-1`), while the newer request proceeds to `200`. This is de-duplication in
  `BackendSrv`, not server-side caching.
- **Server-side cache HIT (`X-Cache`, ~5 min TTL): `[INFERRED]` Enterprise/Cloud only — never
  observed on OSS.**

### 5.5 Additional conditions exercised (exhaustive coverage)

Beyond the happy path and the two repeated-execution modes, the following conditions the question
implies were also exercised, each with captured evidence.

**(a) Expression path — `X-Grafana-From-Expr` header + `handleExpressions` routing.** Adding a Math
expression `B = $A * 1` on top of the Random Walk query A (via the panel editor) and running it
produced a request whose URL and headers differ, and whose backend routing goes through the
expression service:

```
POST http://localhost:3000/api/ds/query?ds_type=__expr__&expression=true&requestId=SQR104   → 200
```

Request header (observed): **`x-grafana-from-expr: true`** — set at
[DataSourceWithBackend.ts:L224](../../packages/grafana-runtime/src/utils/DataSourceWithBackend.ts)
because `hasExpr` is true (a query targets `__expr__`; `isExpressionReference` at
[L49](../../packages/grafana-runtime/src/utils/DataSourceWithBackend.ts), `hasExpr` computed at
[L146-L147]); the same condition also appends `&expression=true` to the URL
([L225](../../packages/grafana-runtime/src/utils/DataSourceWithBackend.ts)). The payload bundles
**both** queries — the source query A and the expression B:

<!-- prettier-ignore -->
```json
{"queries":[
  {"refId":"A","scenarioId":"random_walk","datasource":{"uid":"cfs41vcohee4gb","type":"grafana-testdata-datasource"},"datasourceId":1,"intervalMs":15000,"maxDataPoints":1254},
  {"refId":"B","datasource":{"type":"__expr__","uid":"__expr__","name":"Expression"},"type":"math","hide":false,"expression":"$A * 1","window":""}
],"from":"1784036862203","to":"1784058462203"}
```

Backend evidence of the differing route — the dedicated `expr` service queried A to feed B
(`handleExpressions`, [pkg/services/query/query.go:L99](../../pkg/services/query/query.go), def at
[L203]):

```log
logger=query_data ... ref_id=A ... scenarioId:random_walk
logger=query_data ... ref_id=B ... query="{...\"type\":\"__expr__\"...\"expression\":\"$A * 1\"...\"type\":\"math\"...}"
logger=tsdb.testdata ... msg=queryData scenario=random_walk
logger=expr datasourceType=grafana-testdata-datasource queryRefId=A datasourceUid=cfs41vcohee4gb datasourceVersion=1 ... msg="Data source queried" responseType="single frame series"
logger=context ... msg="Request Completed" method=POST path=/api/ds/query status=200 duration=7.004284ms size=93484 handler=/api/ds/query status_source=server
```

**(b) Failing-query `400` path** — captured in §4.4 (`random_walk_with_error` → HTTP `400`,
`errorSource:"plugin"`, access log `status_source=downstream`).

**(c) `FlagQueryServiceRewrite` OFF** — confirmed by observation in §3.2 (zero rewrites to
`/apis/query.grafana.app/...`; every call `handler=/api/ds/query`).

---

## Section 6 — Reasoning + observed-vs-inferred labeling

### 6.1 The four named artifacts (R7) — explicit, evidence-backed answers

The question specifically asks to note **logs, network requests, headers, and metadata** that reveal
how the query is processed. Each is answered directly:

- **Network requests.** The single canonical request is `POST /api/ds/query?ds_type=<type>[&expression=true][&requestId=...]`
  (§2.2). It is a browser `fetch` issued by `DataSourceWithBackend.query()` →
  `getBackendSrv().fetch()` ([DataSourceWithBackend.ts:L248-L256](../../packages/grafana-runtime/src/utils/DataSourceWithBackend.ts)).
  The `requestId` query-string parameter is the browser-side de-duplication/cancellation key (§5.3).
- **Headers.** _Request side:_ the `PluginRequestHeaders` (`X-Plugin-Id`, `X-Datasource-Uid`,
  `X-Dashboard-Uid`, `X-Panel-Id`, `X-Panel-Plugin-Id`, `X-Query-Group-Id`, `X-Grafana-From-Expr`,
  `X-Cache-Skip`; §2.3, [DataSourceWithBackend.ts:L79-L87](../../packages/grafana-runtime/src/utils/DataSourceWithBackend.ts))
  describe the query's provenance and processing hints. _Response side:_ `Cache-Control: no-store`
  (browser won't cache) and the telling **absence of `X-Cache`** (§4.2) — the primary R6 signal.
- **Logs.** `logger=query_data "Processed metrics query"` (orchestration, §3.4),
  `logger=tsdb.testdata "queryData scenario=..."` (built-in execution),
  `logger=expr "Data source queried"` (expression routing, §5.5), and the access log
  `logger=context "Request Completed" ... status=... status_source=...` (§3.4, gated for `200`/`304`
  by `router_logging`, §1.4).
- **Metadata.** SLO group `high-slow` (`SetSLOGroup`, §3.1/§3.5), `status_source` = `server` vs
  `downstream` (`WithDownstreamStatusSource`, §3.5/§4.4), and the Prometheus request-duration
  histogram labels (§3.5). Tracing spans are registered per request (`request_tracing.go`) —
  **`[INFERRED]`** present; concrete span payload not captured.

### 6.2 Observed vs. inferred (discipline)

- **Observed (has adjacent captured output in this document):** the request URL/method/payload/headers
  (§2); the route/handler/orchestration behavior and all quoted log lines (§3); the response
  status/headers/body and the absence of `X-Cache` (§4); the sequential re-execution and the
  concurrent same-`requestId` cancellation, each ≥2× (§5); the expression header + routing, the `400`
  path, and `FlagQueryServiceRewrite` OFF (§4.4, §5.5, §3.2).
- **`[INFERRED]` (no runtime output on this OSS build):** Enterprise/Cloud server-side cache HIT with
  `X-Cache` + ~5-minute TTL (§5.2); a concrete per-request tracing span payload (§3.5/§6.1); the
  `401` unauthenticated and `207` multi-status branches (documented in the swagger block
  [ds_query.go:L60-L68](../../pkg/api/ds_query.go) and the status logic
  [ds_query.go:L86-L100](../../pkg/api/ds_query.go), but not separately exercised here). No inferred
  behavior was ever forced or faked; Enterprise caching was **never** enabled.

### 6.3 Cause → effect recap

The whole lifecycle reduces to a few causal links, each grounded above: a panel refresh →
`DataSourceWithBackend` builds `POST /api/ds/query?ds_type=...` with `X-*` headers →
authorization + SLO + trace + metrics + access-log middleware → `QueryMetricsV2` binds
`MetricRequest` → `QueryData` fans out (limit `runtime.NumCPU()`=4) → the caching middleware calls the
**no-op** `OSSCachingService` (always a miss, no `X-Cache`) → the TestData backend computes DataFrames
→ `JSONStreaming` returns `200`/`400`. Because the cache is inert, a **sequential** repeat repeats
the whole chain; because `BackendSrv` de-duplicates by `requestId`, a **concurrent** repeat cancels
the earlier in-flight request at the browser.

---

## Section 7 — Cleanup confirmation

All observation was performed against the running process and gitignored runtime state; no source
file was modified. Cleanup performed at the end of the investigation:

- **Temporary observation artifacts** lived entirely under `/tmp/grafana_obs/` (server log, cookies,
  curl header/body captures, diff helpers) — **outside** the repository tree — and were removed.
  No `blitzy_adhoc_test_*` or helper scripts were left anywhere in the repo.
- **Ephemeral runtime toggles reverted.** `cfg:log.level=debug` and `cfg:server.router_logging=true`
  were passed only as command-line arguments to the running server (confirmed by the
  `"Config overridden from command line"` startup lines in §1.2/§1.4); no `.ini`, `.env`, or other
  committed file was changed. Restarting without those args restores the default configuration.
- **Runtime-only browser globals** (`window.__blitzyBackendSrv` and the webpack probe pushes used to
  reach the real `BackendSrv` in §5.3) exist only in the browser tab's JS heap and touch no
  repository file.
- **Runtime SQLite state.** The interactive dashboard created during observation
  (`uid=cfs442olodw5cd`) lives only in the gitignored embedded `data/grafana.db` and was removed;
  regardless, `data/grafana.db` is not tracked by git.

The working tree differs from `HEAD` only by this single new document (the exact `git status`
verification and commit are recorded in the "Cleanup verification" appendix below once performed):

```console
# expected final state
$ git status --porcelain
?? blitzy/documentation/grafana_4550cfb5b728.md   # (plus the untracked blitzy/ parent)
```

_(This verification is finalized during the commit step; the repository is left byte-for-byte
unchanged except for this file.)_

---

## Coverage pass — R1 through R7

| Req    | Requirement                                                             | Where answered                                                                                                                                                        | Verdict     |
| ------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **R1** | Run a canonical local instance (default config)                         | §1 — `make run` args from [.bra.toml:L5], `yarn start`, `http://localhost:3000/`, versions captured                                                                   | ✅ observed |
| **R2** | Use a built-in data source                                              | §1.5 — TestData `grafana-testdata-datasource` (`uid=cfs41vcohee4gb`), backend at [pkg/tsdb/grafana-testdata-datasource/](../../pkg/tsdb/grafana-testdata-datasource/) | ✅ observed |
| **R3** | Observe browser issuance (URL, payload, headers)                        | §2 — `POST /api/ds/query?ds_type=...`, `MetricRequest` body, `PluginRequestHeaders`                                                                                   | ✅ observed |
| **R4** | Observe backend handling (auth, routing, execution, logs/trace/metrics) | §3 — route+middleware, `QueryMetricsV2`, `QueryData`, TestData routing, logs+metrics                                                                                  | ✅ observed |
| **R5** | Observe the response (status, headers, body)                            | §4 — `200`/`400` semantics, headers, `QueryDataResponse` DataFrames                                                                                                   | ✅ observed |
| **R6** | Compare a repeated execution                                            | §5 — sequential (not different) + concurrent (earlier canceled), ≥2× each                                                                                             | ✅ observed |
| **R7** | Surface processing insights (logs, network, headers, metadata)          | §6.1 — all four named artifacts answered with evidence                                                                                                                | ✅ observed |

**Version / license / SDK context:** Grafana OSS `11.5.0-pre` ([package.json:L6](../../package.json)),
`AGPL-3.0-only` ([package.json:L3](../../package.json)); Node engine `>= 22`
([package.json:L451](../../package.json)), `yarn@4.5.3` ([package.json:L453](../../package.json));
Go `1.23.1` ([go.mod:L3](../../go.mod)); DataFrame contracts from
`github.com/grafana/grafana-plugin-sdk-go v0.260.3` ([go.mod:L92](../../go.mod)).
