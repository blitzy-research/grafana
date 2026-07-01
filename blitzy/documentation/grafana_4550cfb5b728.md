# Grafana Runtime‑Evidence Q&A — Five Investigations

> **Repository:** `github.com/grafana/grafana`
> **Branch under study:** `grafana_4550cfb5b728`  ·  **HEAD:** `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`
> **Governing rule:** `SWE-AtlasQnA-Repo` — *investigate by running the code first, then write; quote observed output verbatim; answer every part; be exact and grounded with `file:line` citations; keep the repository read‑only.*

This document answers five questions about Grafana's runtime behavior and frontend internals. **Every answer is grounded in output that was actually produced by building and running the system** (Go backend for Q1–Q3, jest for Q4–Q5), not by reading source alone. Each quoted block is paired with the exact command that produced it, and every claim carries a `file:line` citation.

---

## Environment & Methodology

### Toolchain (verbatim)

```text
$ go version
go version go1.23.1 linux/amd64

$ gcc --version | head -1
gcc (Ubuntu 15.2.0-4ubuntu4) 15.2.0

$ node --version
v22.12.0

$ yarn --version
4.5.3
```

The Go version is pinned at `go.mod:3` (`go 1.23.1`) and reaffirmed by `Makefile:11` (`GO_VERSION = 1.23.1`). CGO requires a C compiler because the default database driver `github.com/mattn/go-sqlite3` is CGO‑based.

### Backend build (the working recipe)

The module workspace is **enabled** (`go.work` is present at the repo root), the git‑ignored Wire file is generated first, and the binary is compiled with `CGO_ENABLED=1`:

```bash
# 1) generate the git-ignored dependency-injection file  (.gitignore:194 = **/wire_gen.go)
go run ./pkg/build/wire/cmd/wire/main.go gen -tags oss ./pkg/server   # writes pkg/server/wire_gen.go
# 2) compile the server (workspace ON, CGO ON for the SQLite driver)
CGO_ENABLED=1 go build -o ./bin/grafana ./pkg/cmd/grafana
```

`bin/grafana` is git‑ignored (`.gitignore:73` = `/bin/*`) and `pkg/server/wire_gen.go` is git‑ignored (`.gitignore:194`), so neither dirties the working tree.

### Backend run (isolated — the repository is never written to)

All writable paths are redirected outside the repository, the port is fixed to `3010`, and logs go to stdout:

```bash
env GF_PATHS_DATA=/tmp/grafana-blitzy/data \
    GF_PATHS_LOGS=/tmp/grafana-blitzy/logs \
    GF_PATHS_PLUGINS=/tmp/grafana-blitzy/plugins \
    GF_PATHS_PROVISIONING=/tmp/grafana-blitzy/prov \
    GF_SERVER_HTTP_PORT=3010 GF_LOG_MODE=console GF_LOG_LEVEL=<info|debug> \
    ./bin/grafana server --homepath <repo-root>
```

Two runs were used to gather all backend evidence:

- **Run A** — a **fresh** (empty) SQLite database, `GF_LOG_LEVEL=debug`, left completely idle for **75 s** with **zero** user/API requests. It became ready ~5 s after launch (`HTTP Server Listen`).
- **Run B** — the **already‑migrated** database from Run A reused, `GF_LOG_LEVEL=info`, left idle for **70 s** with zero requests, after which a single `curl -i /api/health` was issued.

### Frontend tests

```bash
CI=true yarn jest <specPath> --ci --watchAll=false [--verbose]
```

### Read‑only guarantee

The **only** repository write is this document. The compiled binary, the isolated SQLite data directory, and all captured logs live under `/tmp` (outside the tree); the generated `pkg/server/wire_gen.go` is git‑ignored; every temporary observation script was deleted after capture. At completion `git status --porcelain` shows only `blitzy/documentation/grafana_4550cfb5b728.md`.

### Known, harmless output noise (so the captured output is read correctly)

- A startup **`WARNING: A UI theme could not be found` / missing generated JavaScript under `public/build`** can appear because the frontend assets were not built; it does **not** affect `/api/health` or backend logging.
- jest prints **`jest-haste-map: duplicate manual mock found: …`** warnings and a Node **`punycode` DeprecationWarning** — these are noise, not failures.
- `/api/frontend/settings` requires authentication (returns `401`); `/api/health` is the canonical **unauthenticated** version/build endpoint.

---

## Q1 — Idle server recurring logs

> **Question (verbatim):** *"After the server has been running for at least 60 seconds with no user requests, what are the exact recurring log entries that appear? Provide the actual log output as runtime evidence."*

### (a) Command that produced the evidence

```bash
# Run A: fresh DB, DEBUG, idle 75s (>=60s), ZERO requests, then stopped by pid
env GF_PATHS_DATA=/tmp/grafana-blitzy/data GF_PATHS_LOGS=/tmp/grafana-blitzy/logs \
    GF_PATHS_PLUGINS=/tmp/grafana-blitzy/plugins GF_PATHS_PROVISIONING=/tmp/grafana-blitzy/prov \
    GF_SERVER_HTTP_PORT=3010 GF_LOG_MODE=console GF_LOG_LEVEL=debug \
    ./bin/grafana server --homepath <repo-root>   # left idle 75s, no user requests
# extract the recurring line:
grep "Alert rules fetched" /tmp/grafana-blitzy/runA_debug.log
```

### (b) Verbatim captured output

The **one** log entry that recurs on a fixed short cadence while the server is idle is the alerting scheduler's rule‑fetch DEBUG line. All eight occurrences from the 75‑second idle window:

```text
logger=ngalert.scheduler t=2026-07-01T04:03:50.000641679Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T04:04:00.000256245Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T04:04:10.000846645Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T04:04:20.001125725Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T04:04:30.000848719Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T04:04:40.00104702Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T04:04:50.000778553Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T04:05:00.000472397Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
```

**Measured cadence** (deltas between consecutive timestamps): `10.000s, 10.001s, 10.000s, 10.000s, 10.000s, 10.000s, 10.000s` — i.e. **exactly every 10 seconds**, 8 lines across the ≥60 s idle window.

A complete grouping of *every* distinct `(level, logger, msg)` seen in the idle steady‑state window (between `HTTP Server Listen` and shutdown, 24 lines total) confirms nothing else recurs on a short timer:

```text
  8  [debug] logger=ngalert.scheduler        msg="Alert rules fetched"
  7  [debug] logger=ssosettings.service      msg="No SSO Settings found in the database, using system settings"
  1  [info]  logger=infra.usagestats         msg="Usage stats are ready to report"
  1  [debug] logger=ssosettings.service      msg="reloading SSO Settings for all providers"
  1  [debug] logger=secrets                  msg="Removing expired data keys from cache..."
  1  [debug] logger=secrets                  msg="Removing expired data keys from cache finished successfully"
  1  [debug] logger=ngalert.sender.router    msg="Attempting to sync admin configs"
  1  [debug] logger=ngalert.sender.router    msg="Finish of admin configuration sync"
  1  [debug] logger=ngalert.multiorg.alertmanager  msg="Synchronizing Alertmanagers for orgs"
  1  [debug] logger=ngalert.notifier.alertmanager  msg="Config hasn't changed, skipping configuration sync."
  1  [debug] logger=ngalert.multiorg.alertmanager  msg="Done synchronizing Alertmanagers for orgs"
```

Two important qualifications drawn from the data (not assumptions):

- The 7 `ssosettings.service` `"No SSO Settings found in the database, using system settings"` lines are **not** a 10‑second recurrence — they are a single **burst** emitted at one instant (all timestamped `2026-07-01T04:04:48.4839…`, Δ = 0.000 s between them), one per configured OAuth provider, immediately after a single `"reloading SSO Settings for all providers"` event. It is a periodic *reload* whose interval is longer than this window (it fired once in 75 s).
- `"Usage stats are ready to report"` is a **one‑time** INFO readiness line, observed once:

```text
logger=infra.usagestats t=2026-07-01T04:04:29.489195945Z level=info msg="Usage stats are ready to report"
```

  It appeared at **+44.689 s** after `Starting Grafana` (`t=2026-07-01T04:03:44.799…`), i.e. **not** at ~60 s. It is emitted by `SetReadyToReport`, not by the send‑ticker, so it is a startup readiness signal rather than a recurring entry.

At `GF_LOG_LEVEL=info` (Run B) the idle window is effectively **silent**: after the startup‑tail INFO lines settle (all within +0.6 s of `HTTP Server Listen`), **nothing** is logged from +0.6 s until +70.7 s, when the closing `curl` produced a single `logger=context … msg="Request Completed"`. So at INFO an idle server produces no recurring lines in a 60–70 s window.

### (c) Exact recurring entry (the value the question asks for)

```text
logger=ngalert.scheduler … level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
```
emitted **every 10.000 seconds** (8 times in 75 s). At INFO the idle window is silent apart from the one‑time `"Usage stats are ready to report"` readiness line.

### (d) Responsible code (`file:line`)

- The recurring line: `pkg/services/ngalert/schedule/fetcher.go:39` —
  `sch.log.Debug("Alert rules fetched", "rulesCount", len(q.ResultRules), "foldersCount", len(q.ResultFoldersTitles), "updatedRules", len(d.updated))`.
- The 10‑second cadence: `pkg/setting/setting_unified_alerting.go:62` — `SchedulerBaseInterval = 10 * time.Second` (and `:64` `DefaultRuleEvaluationInterval = SchedulerBaseInterval * 6 // == 60 seconds`).
- The one‑time readiness INFO line: `pkg/infra/usagestats/service/service.go:117` — `uss.log.Info("Usage stats are ready to report")` (inside `SetReadyToReport`); the send interval is separately clamped to ≥ 1 minute at `:72-73`.
- The SSO reload burst: `pkg/services/ssosettings/ssosettingsimpl/service.go:414` (`"No SSO Settings found in the database, using system settings"`) preceded by `:384` (`"reloading SSO Settings for all providers"`).
- Origin of all idle background activity: `pkg/server/server.go:139` — `func (s *Server) Run() error` launches the background services via an `errgroup` created at `pkg/server/server.go:63`.

### (e) Reasoning

With no alert rules configured, the ngalert scheduler still ticks on its base interval (`SchedulerBaseInterval = 10 * time.Second`), and on each tick the rule fetcher logs `"Alert rules fetched"` with `rulesCount=0`. The measured 10.000 s spacing across 8 consecutive lines matches that constant exactly, which is why this is *the* recurring idle log entry. Everything else observed in the window is either a one‑time readiness/init message or a longer‑interval reload that merely happened to fire once — none of them recur every few seconds. At INFO the scheduler's fetch line is suppressed (it is DEBUG), leaving the idle window quiet.

---

## Q2 — Database migration check ("schema version is up to date")

> **Question (verbatim):** *"When the server starts what is the specific output that confirms that the schema version is up to date."*

### (a) Commands that produced the evidence (two‑pass)

```bash
# Pass 1 — FRESH (empty) database: the migrator executes migrations
grep -E "Starting DB migrations|Executing migration|Migration successfully executed|migrations completed" \
     /tmp/grafana-blitzy/runA_debug.log

# Pass 2 — WARM (already-migrated) database reused: the migrator finds nothing to do
grep "migrations completed" /tmp/grafana-blitzy/runB_info.log
```

### (b) Verbatim captured output

**Pass 1 (fresh DB — migrations run).** The migrator opens with `Starting DB migrations`, executes each migration, and finishes with a summary whose `performed` count is > 0:

```text
logger=migrator t=2026-07-01T04:03:44.801519367Z level=info msg="Starting DB migrations"
logger=migrator t=2026-07-01T04:03:44.801740173Z level=info msg="Executing migration" id="create migration_log table"
logger=migrator t=2026-07-01T04:03:44.801939786Z level=info msg="Migration successfully executed" id="create migration_log table" duration=199.203µs
... (625 more "Executing migration" / "Migration successfully executed" pairs) ...
logger=migrator t=2026-07-01T04:03:47.299991984Z level=info msg="migrations completed" performed=626 skipped=0 duration=2.498268052s
logger=resource-migrator t=2026-07-01T04:03:48.480442611Z level=info msg="migrations completed" performed=18 skipped=0 duration=906.508521ms
```

(The fresh run logged **644** `Executing migration` and **641** `Migration successfully executed` lines.)

**Pass 2 (warm DB — schema already up to date).** Re‑running against the same data directory, the migrator performs **zero** migrations — no `Executing migration` lines at all — and the summary reports `performed=0`:

```text
logger=migrator t=2026-07-01T04:07:55.384571861Z level=info msg="migrations completed" performed=0 skipped=626 duration=733.757µs
logger=resource-migrator t=2026-07-01T04:07:55.583377482Z level=info msg="migrations completed" performed=0 skipped=18 duration=29.8µs
```

Side‑by‑side, the contrast is the signal:

| Run | `migrations completed` (migrator) |
|-----|-----------------------------------|
| Fresh DB | `performed=626 skipped=0 duration=2.498268052s` |
| **Warm DB (up to date)** | **`performed=0 skipped=626 duration=733.757µs`** |

### (c) Exact confirming output (the value the question asks for)

```text
logger=migrator … level=info msg="migrations completed" performed=0 skipped=626 duration=733.757µs
```

**`performed=0`** is the exact "schema version is up to date" signal: on startup the migrator found every one of the 626 migrations already applied, so it **skipped** all of them and **performed** none. (A companion `resource-migrator` line likewise reports `performed=0 skipped=18`.)

### (d) Responsible code (`file:line`)

`pkg/services/sqlstore/migrator/migrator.go`:
- `:247` — `logger.Info("Starting DB migrations")`
- `:356` — `logger.Info("Executing migration", "id", m.Id())`
- `:392` — `logger.Info("Migration successfully executed", "id", m.Id(), "duration", time.Since(start))`
- `:287` — `logger.Info("migrations completed", "performed", migrationsPerformed, "skipped", migrationsSkipped, "duration", time.Since(start))`

### (e) Reasoning

The migrator iterates every registered migration; each one already recorded in the `migration_log` table is counted as *skipped* rather than *performed*. On a database that is fully migrated, no migration executes, so `migrationsPerformed == 0` and the summary at `migrator.go:287` prints `performed=0 skipped=<N>`. The fresh‑vs‑warm contrast (`performed=626` → `performed=0`) demonstrates that `performed=0` is precisely the steady‑state "nothing to migrate / schema up to date" confirmation.

---

## Q3 — Build/version via the running API

> **Question (verbatim):** *"Can you verify the current build information by querying the api endpoints of the running instance. What is the exact value of version string reported by the api."*

### (a) Command that produced the evidence

```bash
curl -i http://localhost:3010/api/health
```

### (b) Verbatim captured output (status line + headers + body)

```http
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json; charset=UTF-8
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Wed, 01 Jul 2026 04:09:06 GMT
Content-Length: 62

{
  "database": "ok",
  "version": "9.2.0",
  "commit": "NA"
}
```

Corroborating startup log line (both runs), which carries the same version attribute:

```text
logger=settings t=2026-07-01T04:03:44.799840822Z level=info msg="Starting Grafana" version=9.2.0 commit=NA branch=main compiled=2026-07-01T04:03:44Z
```

And the binary's own report:

```text
$ ./bin/grafana --version
grafana version 9.2.0
```

The alternate version surface is authentication‑gated, confirming `/api/health` is the canonical unauthenticated endpoint:

```bash
$ curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3010/api/frontend/settings
HTTP 401
```

### (c) Exact value the question asks for

```json
"version": "9.2.0"
```

The `/api/health` endpoint reports the version string **`9.2.0`** (with `"database": "ok"` and `"commit": "NA"`), returned as `HTTP/1.1 200 OK` with `Content-Type: application/json; charset=UTF-8`.

### (d) Responsible code (`file:line`)

`pkg/api/http_server.go`:
- `:694` — the response shape:
  ```go
  type healthResponse struct {
      Database         string `json:"database"`
      Version          string `json:"version,omitempty"`
      Commit           string `json:"commit,omitempty"`
      EnterpriseCommit string `json:"enterpriseCommit,omitempty"`
  }
  ```
- `:710` — `func (hs *HTTPServer) apiHealthHandler(ctx *web.Context)`
- `:716` — `data := healthResponse{ Database: "ok" }`
- `:719` — `if !hs.Cfg.Anonymous.HideVersion {`
- **`:720` — `data.Version = hs.Cfg.BuildVersion`**  ← the version value the API returns
- `:721` — `data.Commit = hs.Cfg.BuildCommit`
- `:729` / `:732` — `ctx.Resp.Header().Set("Content-Type", "application/json; charset=UTF-8")` (200 when the DB is healthy, 503 otherwise)
- `:736` — `dataBytes, err := json.MarshalIndent(data, "", "  ")` (why the body is pretty‑printed)

**Version provenance chain (why the value is `9.2.0` and not `11.5.0-pre`):**
- `pkg/cmd/grafana/main.go:17` — `var version = "9.2.0"` (the compiled‑in default; the comment at `:16` notes it "can be overridden through the -X link flag").
- `pkg/cmd/grafana-server/commands/buildinfo.go:20-21` — `func SetBuildInfo(opts standalone.BuildInfo)` → `setting.BuildVersion = opts.Version`.
- `pkg/setting/setting.go:1076` — `cfg.BuildVersion = BuildVersion`, surfaced by the handler at `http_server.go:720`.
- `pkg/setting/setting.go:940` — the startup line is built via `fmt.Sprintf("Starting %s", ApplicationName)` with `ApplicationName = "Grafana"` at `pkg/setting/setting.go:50` (so the literal `"Starting Grafana"` is composed at runtime, matching the captured log).
- `pkg/build/cmd.go:247` — official release builds inject the version via `-X main.version=%s` ldflags.
- Alternate surface: `pkg/api/frontendsettings.go:161` — `version := setting.BuildVersion`, exposed in the `BuildInfo` DTO at `:247` (auth‑gated, per the `401` above).

### (e) Reasoning

`apiHealthHandler` builds a `healthResponse`, and — because version display is not hidden — sets `data.Version = hs.Cfg.BuildVersion` (`http_server.go:720`) before serializing with `json.MarshalIndent` (`:736`). `hs.Cfg.BuildVersion` traces back to the compiled‑in constant `var version = "9.2.0"` (`main.go:17`). This checkout is Grafana **`11.5.0-pre`** per `package.json`, but because the binary was produced by a plain `go build` with **no** ldflags, the source default `9.2.0` is what is compiled in — hence the API, the startup log, and `./bin/grafana --version` all agree on **`9.2.0`**. An official release build would inject `11.5.0-pre` via the ldflags at `build/cmd.go:247`. The reported value therefore reflects *this specific build*, exactly as required.

---


## Q4 — Dashboard‑scene datasource picker (view → panel‑editor transition)

> **Question (verbatim):** *"Investigate its initialization logic during the transition from the dashboard view to the panel editor… provide test script outputs to prove whether the picker automatically resolves to and displays the datasource already defined in the panel queries. Tell me which part of the codebase is responsible for this."*

### (a) Command that produced the evidence

```bash
CI=true yarn jest public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx \
  --ci --watchAll=false --verbose
```

### (b) Verbatim captured output (jest)

```text
PASS public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx
  PanelDataQueriesTab
    Adding queries
      ✓ can add a new query (26 ms)
      ✓ Can add a new query when datasource is mixed (7 ms)
    PanelDataQueriesTab
      ✓ renders query group top section (99 ms)
      ✓ renders queries rows when queries are set (64 ms)
      ✓ allow to add a new query when user clicks on add new (122 ms)
      ✓ allow to remove a query when user clicks on remove (388 ms)
    query options
      activation
        ✓ should load data source (5 ms)
        ✓ should store loaded data source in local storage (5 ms)
        ✓ should load default datasource if the datasource passed is not found (6 ms)
      data source change
        ✓ should load new data source (5 ms)
        ✓ changing from one plugin to another (4 ms)
        ✓ changing from a plugin to a dashboard data source (4 ms)
        ✓ changing from dashboard data source to a plugin (4 ms)
      ...

Test Suites: 1 passed, 1 total
Tests:       25 passed, 25 total
Snapshots:   0 total
Time:        4.787 s, estimated 19 s
```

The decisive test is `query options › activation › should load data source`. Its body (`PanelDataQueriesTab.test.tsx:361-365`) is:

```ts
it('should load data source', async () => {
  const { queriesTab } = await setupScene('panel-1');

  expect(queriesTab.state.datasource).toEqual(ds1Mock);
  expect(queriesTab.state.dsSettings).toEqual(instance1SettingsMock);
});
```

`setupScene` runs the real view→edit path (`transformSaveModelToScene` → `buildPanelEditScene`, imported at the top of the spec). After activation, `queriesTab.state.datasource` has been resolved to the datasource declared by the panel's queries — proving the picker auto‑resolves. (The companion test `should load default datasource if the datasource passed is not found` shows the fallback when the panel's datasource cannot be resolved.)

### (c) Exact answer the question asks for

**YES — the picker automatically resolves to and displays the datasource already defined in the panel queries.** Runtime proof: `Tests: 25 passed, 25 total`, including `✓ should load data source`, which asserts `queriesTab.state.datasource` equals the datasource defined in the panel's query state.

### (d) Responsible code (`file:line`)

- View→edit transition creates the data pane: `public/app/features/dashboard-scene/panel-edit/PanelEditor.tsx:204` (`if (!this.state.dataPane)`) → `:205` `this.setState({ dataPane: PanelDataPane.createFor(this.getPanel()) })`; the edit scene itself is built by `buildPanelEditScene` at `PanelEditor.tsx:326`.
- `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataPane.tsx:35` `public static createFor(panel: VizPanel)` → `:38` `new PanelDataQueriesTab({ panelRef })`.
- **The responsible logic:** `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx`:
  - `:60` `this.loadDataSource();` (called from `onActivate`)
  - `:63` `private async loadDataSource()`
  - `:71` `let datasourceToLoad = this.queryRunner.state.datasource;`  ← reads the datasource from the panel's query runner (the panel's query definition)
  - `:100-102` the `else` branch (taken when that datasource **is** defined): `datasource = await getDataSourceSrv().get(datasourceToLoad)` and `dsSettings = getDataSourceSrv().getInstanceSettings(datasourceToLoad)`
  - `:106` `this.setState({ datasource, dsSettings });`  ← the resolved datasource is stored on the tab state, which is what the picker displays
- Runnable evidence file: `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx`.

### (e) Reasoning

Opening the panel editor activates `PanelEditor`, which creates a `PanelDataPane` via `PanelDataPane.createFor(...)` (`PanelEditor.tsx:205`), constructing a `PanelDataQueriesTab` (`PanelDataPane.tsx:38`). On activation, `PanelDataQueriesTab.loadDataSource()` reads `this.queryRunner.state.datasource` (`PanelDataQueriesTab.tsx:71`) — that value comes straight from the panel's existing query definition. When it is present, the `else` branch resolves it with `getDataSourceSrv().get(...)`/`.getInstanceSettings(...)` and commits it with `this.setState({ datasource, dsSettings })` (`:106`). The passing `should load data source` test asserts exactly this: `state.datasource` ends up equal to the datasource defined in the panel's queries. Hence the picker auto‑resolves to and displays the panel‑query datasource.

---

## Q5 — Alerting rule EDIT view: query‑state population from the backend rule definition

> **Question (verbatim):** *"Investigate the alerting api's rule creation process at runtime to determine if the backend's rule definition populates the query state when the edit view is opened, show me test script output for this and identify the part of the codebase responsible for this behavior."*

**Interpretation (stated explicitly, per the rule to answer every part):** the question says *"rule creation process,"* but the behavior it describes — *a backend rule definition populating the query state **when the edit view is opened*** — is the rule **EDIT** initialization path. This investigation therefore targets the edit‑view form‑initialization mapping (`formValuesFromExistingRule` → `rulerRuleToFormValues`), which is where an **existing** backend definition is converted into form/query state.

### (a) Commands / code that produced the evidence

**(1) Committed spec** (proves the mapping module loads and passes at runtime):

```bash
CI=true yarn jest public/app/features/alerting/unified/utils/rule-form.test.ts --ci --watchAll=false
```

**(2) Temporary observation spec** — created to directly exercise the *forward* mapping (backend rule → form values) that the committed spec does not cover, then **deleted** afterward (read‑only guarantee). It was written to `public/app/features/alerting/unified/utils/blitzy_adhoc_test_ruleFormEdit.test.ts`:

```ts
import { GrafanaAlertStateDecision } from 'app/types/unified-alerting-dto';
import { formValuesFromExistingRule, rulerRuleToFormValues } from './rule-form';

describe('Q5 — edit view populates query state from backend rule definition', () => {
  const backendQueries = [
    { refId: 'A', datasourceUid: 'gdev-prometheus', queryType: 'range',
      relativeTimeRange: { from: 600, to: 0 },
      model: { refId: 'A', expr: 'up', datasource: { type: 'prometheus', uid: 'gdev-prometheus' } } },
    { refId: 'B', datasourceUid: '__expr__', queryType: '',
      model: { refId: 'B', type: 'classic_conditions', datasource: { type: '__expr__', uid: '__expr__' }, conditions: [] } },
  ];
  const grafanaAlert = {
    uid: 'rule-uid-123', title: 'my-existing-alert', namespace_uid: 'folder-uid-abc', rule_group: 'my-group',
    condition: 'B', no_data_state: GrafanaAlertStateDecision.NoData, exec_err_state: GrafanaAlertStateDecision.Error,
    data: backendQueries, is_paused: false,
  };
  const ruleWithLocation = {
    ruleSourceName: 'grafana', namespace: 'my-folder',
    group: { name: 'my-group', interval: '1m', rules: [] },
    rule: { grafana_alert: grafanaAlert, for: '5m', annotations: {}, labels: {} },
  } as any;

  it('rulerRuleToFormValues maps queries<-grafana_alert.data and condition<-grafana_alert.condition (rule-form.ts:402-403)', () => {
    const formValues = rulerRuleToFormValues(ruleWithLocation);
    expect(formValues.queries).toBe(grafanaAlert.data);
    expect(formValues.queries).toHaveLength(2);
    expect(formValues.queries[0].refId).toBe('A');
    expect(formValues.queries[1].refId).toBe('B');
    expect(formValues.condition).toBe('B');
  });

  it('formValuesFromExistingRule (edit entry used by AlertRuleForm.tsx:105) carries the query state through', () => {
    const formValues = formValuesFromExistingRule(ruleWithLocation);
    expect(formValues.condition).toBe('B');
    expect(formValues.queries).toHaveLength(2);
    expect(formValues.queries?.map((q: any) => q.refId)).toEqual(['A', 'B']);
    expect(formValues.queries?.[0].datasourceUid).toBe('gdev-prometheus');
    expect(formValues.queries?.[1].datasourceUid).toBe('__expr__');
  });
});
```

```bash
CI=true yarn jest public/app/features/alerting/unified/utils/blitzy_adhoc_test_ruleFormEdit.test.ts --ci --watchAll=false --verbose
```

### (b) Verbatim captured output (jest)

**Committed spec:**

```text
PASS public/app/features/alerting/unified/utils/rule-form.test.ts
Test Suites: 1 passed, 1 total
Tests:       21 passed, 21 total
Time:        3.921 s, estimated 4 s
```

**Temporary forward‑mapping spec (direct proof):**

```text
PASS public/app/features/alerting/unified/utils/blitzy_adhoc_test_ruleFormEdit.test.ts
  Q5 — edit view populates query state from backend rule definition
    ✓ rulerRuleToFormValues maps queries<-grafana_alert.data and condition<-grafana_alert.condition (rule-form.ts:402-403) (3 ms)
    ✓ formValuesFromExistingRule (edit entry used by AlertRuleForm.tsx:105) carries the query state through (3 ms)

Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total
Time:        4.032 s
```

### (c) Exact answer the question asks for

**YES — the backend's rule definition populates the rule‑editor form's query state when the edit view is opened.** The `queries` state is taken directly from the backend definition's `grafana_alert.data`, and the `condition` from `grafana_alert.condition`. Runtime proof: `Tests: 2 passed, 2 total` in the direct forward‑mapping spec (plus the committed `rule-form.test.ts` `Tests: 21 passed, 21 total` establishing the module is exercised at runtime). The passing assertions show `formValues.queries === grafana_alert.data` (2 queries, refIds `A`,`B`) and `formValues.condition === "B"`.

### (d) Responsible code (`file:line`)

- Edit entry point: `public/app/features/alerting/unified/components/rule-editor/alert-rule-form/AlertRuleForm.tsx`:
  - `:49` imports `formValuesFromExistingRule`
  - `:84` `export const AlertRuleForm = ({ existing, prefill }: Props) => {`
  - `:103` `const defaultValues: RuleFormValues = useMemo(() => {`
  - `:104` `if (existing) {`
  - `:105` `return formValuesFromExistingRule(existing);`  ← when an existing backend rule is supplied, the form's default values (including query state) are computed from it
- The mapping: `public/app/features/alerting/unified/utils/rule-form.ts`:
  - `:916` `export function formValuesFromExistingRule(rule: RuleWithLocation<RulerRuleDTO>)` → returns `ignoreHiddenQueries(rulerRuleToFormValues(rule))` (`:909-914`, `:917`)
  - `:365` `export function rulerRuleToFormValues(ruleWithLocation: RuleWithLocation): RuleFormValues`
  - grafana‑alerting branch: **`:402` `queries: ga.data,`** and **`:403` `condition: ga.condition,`** (the grafana‑recording branch does the same at `:380-381`)
- Runnable evidence file: `public/app/features/alerting/unified/utils/rule-form.test.ts` (committed, supporting); the direct forward‑mapping spec above (temporary, deleted).

### (e) Reasoning

When the alert‑rule editor opens for an existing rule, `AlertRuleForm` receives that backend rule as its `existing` prop and computes the form's default values via `formValuesFromExistingRule(existing)` (`AlertRuleForm.tsx:105`). That function delegates to `rulerRuleToFormValues` (`rule-form.ts:916 → :365`), whose grafana‑alerting branch sets `queries: ga.data` and `condition: ga.condition` (`:402-403`) — i.e. it copies the query array and condition **straight from the backend definition** (`grafana_alert.data` / `grafana_alert.condition`). The temporary spec confirms this at runtime: `rulerRuleToFormValues(...).queries` is the very `grafana_alert.data` array (reference‑equal), with two queries `A`/`B`, and `condition === "B"`; `formValuesFromExistingRule(...)` carries the same queries and condition through (its only transform, `ignoreHiddenQueries`, merely omits `model.hide`). Therefore the backend rule definition does populate the edit view's query state.

---


## Answers at a glance

| # | Question (short) | Exact answer / value | Responsible code |
|---|------------------|----------------------|------------------|
| Q1 | Idle recurring log entries (≥60 s) | `logger=ngalert.scheduler … level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0`, **every 10.000 s** (8× in 75 s). At INFO the idle window is silent apart from the one‑time `"Usage stats are ready to report"`. | `fetcher.go:39`; cadence `setting_unified_alerting.go:62` |
| Q2 | Output confirming schema up to date | `msg="migrations completed" performed=0 skipped=626 duration=733.757µs` — **`performed=0`** | `migrator.go:287` |
| Q3 | Exact `version` from the API | `"version": "9.2.0"` (from `GET /api/health`, `HTTP/1.1 200 OK`) | `http_server.go:720` (`data.Version = hs.Cfg.BuildVersion`); default `main.go:17` |
| Q4 | Does the picker auto‑resolve to the panel‑query datasource? | **YES** — proven by `✓ should load data source` (25/25 passed) | `PanelDataQueriesTab.loadDataSource()` `PanelDataQueriesTab.tsx:63/71/106`, reached via `PanelEditor.tsx:205` → `PanelDataPane.tsx:35` |
| Q5 | Does the backend rule definition populate edit‑view query state? | **YES** — `queries ← grafana_alert.data`, `condition ← grafana_alert.condition` (2/2 direct proof; committed 21/21) | `formValuesFromExistingRule` `rule-form.ts:916` → `rulerRuleToFormValues` `:365` (`:402-403`), via `AlertRuleForm.tsx:103-105` |

---

## Coverage pass (every sub‑part addressed)

| Q | Distinct sub‑part the question asks for | Where answered | Verdict |
|---|------------------------------------------|----------------|---------|
| **Q1** | (i) the *exact* recurring log entries | Q1 (b)/(c): `ngalert.scheduler "Alert rules fetched"` verbatim | ✔ |
| | (ii) actual runtime log output as evidence | Q1 (b): 8 verbatim timestamped lines from `runA_debug.log` | ✔ |
| | (iii) the ≥60 s idle, "no user requests" condition honored | Environment + Q1 (a): fresh run idled **75 s**, zero requests | ✔ |
| | (iv) cadence + responsible code | Q1 (b) measured **10.000 s**; (d) `fetcher.go:39`, `setting_unified_alerting.go:62` | ✔ |
| **Q2** | (i) the *specific* confirming output | Q2 (b)/(c): `migrations completed … performed=0 …` verbatim | ✔ |
| | (ii) that it means the schema is up to date (`performed=0`) | Q2 (c)/(e): fresh `performed=626` vs warm `performed=0`; `migrator.go:287` | ✔ |
| **Q3** | (i) verify build info via the running API (raw request/response) | Q3 (a)/(b): `curl -i /api/health`, full status + headers + JSON | ✔ |
| | (ii) the *exact* `version` string value | Q3 (c): `"version": "9.2.0"` (+ provenance vs `package.json` `11.5.0-pre`) | ✔ |
| **Q4** | (i) initialization logic during view→edit transition | Q4 (d)/(e): `PanelEditor.tsx:204-205` → `PanelDataPane.createFor` → `loadDataSource()` | ✔ |
| | (ii) test‑script output | Q4 (b): jest `25 passed, 25 total`, incl. `✓ should load data source` | ✔ |
| | (iii) whether it auto‑resolves/displays the panel‑query datasource | Q4 (c): **YES** | ✔ |
| | (iv) responsible code | Q4 (d): `PanelDataQueriesTab.tsx:63/71/106` | ✔ |
| **Q5** | (i) runtime investigation of the rule definition | Q5 (a)/(b): committed spec + temporary forward‑mapping spec, both PASS | ✔ |
| | (ii) whether it populates query state when the edit view opens | Q5 (c): **YES** (`queries ← ga.data`, `condition ← ga.condition`) | ✔ |
| | (iii) test‑script output | Q5 (b): `2 passed, 2 total` (direct) + `21 passed, 21 total` (committed) | ✔ |
| | (iv) responsible code | Q5 (d): `rule-form.ts:916/365/402-403`, `AlertRuleForm.tsx:103-105` | ✔ |
| | (v) the "creation" vs "edit" interpretation | Q5 interpretation note | ✔ |

### Verification limits (stated explicitly)

- The `/api/health` `version` reflects **this locally built binary** (a plain `go build`, no ldflags), so it is the compiled‑in default `9.2.0` (`main.go:17`), not the checkout's `package.json` release version `11.5.0-pre`; an official ldflags build would report the latter (`build/cmd.go:247`). This is provenance, not a discrepancy.
- Q1's `"Usage stats are ready to report"` timing (`+44.689 s`) is what was **observed** in this run; it is a one‑time readiness signal (`service.go:117`, `SetReadyToReport`), not a fixed‑cadence recurrence, so its exact offset can vary between runs.
- Q4/Q5 behaviors are proven with jest (the "test script output" the questions request), which exercises the responsible modules directly; they were not additionally reproduced through a live browser session.

---

*End of document. This file (`blitzy/documentation/grafana_4550cfb5b728.md`) is the sole repository change; all build/run/test artifacts and temporary scripts were kept outside the tree or removed.*

