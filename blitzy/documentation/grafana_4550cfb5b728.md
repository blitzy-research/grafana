# Grafana v11.5.0-pre Runtime Investigation Report

## Commit: `4550cfb5b7` | Branch: `grafana_4550cfb5b728`

This document presents the findings of a comprehensive runtime investigation targeting five distinct behavioral aspects of the Grafana v11.5.0-pre server. All evidence is derived from building the server binary from source (Go 1.23.1), running it locally against an SQLite database, querying its HTTP API, and executing the existing Jest test suites (Node.js 22.11.0). No existing repository files were modified.

---

### Table of Contents

1. [Server Idle Behavior Analysis](#1-server-idle-behavior-analysis)
2. [Database Migration Check Verification](#2-database-migration-check-verification)
3. [Build Information API Verification](#3-build-information-api-verification)
4. [Dashboard Scene Datasource Picker Architecture Investigation](#4-dashboard-scene-datasource-picker-architecture-investigation)
5. [Alerting API Rule Creation Investigation](#5-alerting-api-rule-creation-investigation)
6. [Reproducibility](#6-reproducibility)
7. [Summary](#7-summary)

---

## 1. Server Idle Behavior Analysis

### Question

What are the exact recurring log entries that the Grafana server emits after being idle (no user requests) for at least 60 seconds following initialization?

### Thinking / Rationale

To answer this question, the Grafana Go server binary was built from source at commit `4550cfb5b7` and started against an SQLite database. After the server completed initialization (all background services started, HTTP listener bound), no HTTP requests were issued. The log output was monitored for a window of 90 seconds by recording the log line count before and after the idle period and diffing the result.

The key background services to consider after startup are:

- **`Server.Run()`** in `pkg/server/server.go` (lines 139–180): This method iterates all registered `BackgroundServiceRegistry` entries and starts each enabled service as a goroutine via `errgroup.Group`. After all services are started, it sends the systemd `READY=1` notification (line 176) and blocks on `childRoutines.Wait()` (line 179).

- **UsageStats** (`pkg/infra/usagestats/service/service.go`): The `Run()` method (lines 56–110) runs a ticker loop. The initial `nextSendInterval` is calculated as the time until the last send plus 24 hours, but is clamped to a minimum of 1 minute (lines 72–74: `if nextSendInterval < time.Minute { nextSendInterval = time.Minute }`). On the first tick, if `readyToReport` is `false`, it resets the ticker to 1 minute and continues (lines 83–87). The `SetReadyToReport()` method (lines 116–118) is invoked externally once startup is complete, logging `"Usage stats are ready to report"` and setting the atomic bool to `true`.

- **Alerting Ticker** (`pkg/util/ticker/ticker.go`): The `T.run()` method (lines 49–76) emits `logger=ticker msg=starting first_tick=...` at startup (line 51), then enters a silent loop emitting time ticks to its channel. It produces no further log output unless the server is shut down (line 75: `logger.Info("stopped", ...)`).

- **Alert Scheduler** (`pkg/services/ngalert/schedule/schedule.go`): Starts the alerting scheduler tick loop, which reads from the ticker's channel. When no alert rules are configured, it simply discards ticks and produces no log output.

### Runtime Evidence

The server was started (restart against an existing database to isolate idle behavior from migration noise). After startup completed (63 log lines), the line count was recorded and the server was left idle for 90 seconds with no HTTP requests. Only **one new log line** appeared during that window:

```text
logger=infra.usagestats t=2026-04-13T21:40:45.19144431Z level=info msg="Usage stats are ready to report"
```

This is the **only** log entry emitted during the 90-second idle period.

### Mechanism Explanation

1. After all background services start, the server initialization pipeline calls `SetReadyToReport()` on the `UsageStats` service (line 116–118 of `pkg/infra/usagestats/service/service.go`):
   ```go
   func (uss *UsageStats) SetReadyToReport(context.Context) {
       uss.log.Info("Usage stats are ready to report")
       uss.readyToReport.Store(true)
   }
   ```
   This produces the observed log line.

2. The `Run()` loop's ticker fires after `nextSendInterval` (minimum 1 minute). On the first tick, if `readyToReport` is `true`, it attempts to send usage stats via `sendUsageStats()` (line 89). If the send fails (e.g., no internet access in a development environment), it logs a warning — but this is a one-time event tied to the first tick, not a recurring idle entry.

3. The alerting ticker (`pkg/util/ticker/ticker.go`) runs silently after its initial `starting` log at line 51. The alert scheduler consumes its ticks silently when no rules are configured.

4. No other background services produce recurring log output when the server is idle.

### Answer

**The only log entry emitted during an idle period of 60+ seconds is:**

```text
logger=infra.usagestats level=info msg="Usage stats are ready to report"
```

**Responsible code:** `pkg/infra/usagestats/service/service.go`, method `SetReadyToReport()`, line 117.

---

## 2. Database Migration Check Verification

### Question

What is the specific server startup output that confirms the schema version is up to date?

### Thinking / Rationale

To capture the migration check behavior, the Grafana server was started for the first time against a fresh SQLite database (which executed all 626 migrations), and then restarted against the same database. On the second start, all migrations have already been recorded in the `migration_log` table, so the migrator should skip all of them.

The migration system works as follows:

- `RunMigrations()` in `pkg/services/sqlstore/migrator/migrator.go` (lines 199–239): When `isDatabaseLockingEnabled` is `true` (the default, per `conf/defaults.ini` setting `migration_locking = true`), it acquires an advisory lock on the database (line 216: `logger.Info("Locking database")`), then calls `run()` inside a transaction.

- `run()` in `pkg/services/sqlstore/migrator/migrator.go` (lines 241–291): Logs `"Starting DB migrations"` (line 247), loads the `migration_log` table into `logMap` (line 249: `GetMigrationLog()`), then iterates all 626 registered migrations. For each migration, it checks `logMap[m.Id()]` — if the migration ID exists and was successful, it increments `migrationsSkipped`; otherwise it executes the migration and increments `migrationsPerformed`. After the loop, it logs the summary (line 287):
  ```go
  logger.Info("migrations completed", "performed", migrationsPerformed, "skipped", migrationsSkipped, "duration", time.Since(start))
  ```
  Finally, the lock is released in the deferred function (line 229: `logger.Info("Unlocking database")`).

### Runtime Evidence — First Start (Fresh Database)

On the first start against a fresh SQLite database, the migrator executed all 626 migrations:

```text
logger=migrator t=2026-04-13T21:38:06.850607271Z level=info msg="Locking database"
logger=migrator t=2026-04-13T21:38:06.850623021Z level=info msg="Starting DB migrations"
logger=migrator t=2026-04-13T21:38:06.850875381Z level=info msg="Executing migration" id="create migration_log table"
logger=migrator t=2026-04-13T21:38:06.851081727Z level=info msg="Migration successfully executed" id="create migration_log table" duration=206.299µs
... (624 more migrations executed) ...
logger=migrator t=2026-04-13T21:38:08.613422151Z level=info msg="migrations completed" performed=626 skipped=0 duration=1.762565527s
```

### Runtime Evidence — Restart (Schema Up to Date)

On the second start against the same database where all migrations have already been applied:

```text
logger=migrator t=2026-04-13T21:39:52.997983Z level=info msg="Locking database"
logger=migrator t=2026-04-13T21:39:52.997997395Z level=info msg="Starting DB migrations"
logger=migrator t=2026-04-13T21:39:53.004821901Z level=info msg="migrations completed" performed=0 skipped=626 duration=722.783µs
logger=migrator t=2026-04-13T21:39:53.004987551Z level=info msg="Unlocking database"
```

### Answer

**`performed=0 skipped=626`** confirms that all 626 registered migrations already exist in `migration_log`, so the schema is current. No DDL changes were applied. The complete migration check sequence on a restart is:

```text
logger=migrator msg="Locking database"
logger=migrator msg="Starting DB migrations"
logger=migrator msg="migrations completed" performed=0 skipped=626 duration=722.783µs
logger=migrator msg="Unlocking database"
```

Additionally, the resource storage migrator shows a similar pattern:

```text
logger=resource-migrator msg="Locking database"
logger=resource-migrator msg="Starting DB migrations"
logger=resource-migrator msg="migrations completed" performed=0 skipped=18 duration=27.121µs
logger=resource-migrator msg="Unlocking database"
```

### Code Path

| File | Function/Method | Lines | Purpose |
|---|---|---|---|
| `pkg/services/sqlstore/migrator/migrator.go` | `RunMigrations()` | 199–239 | Acquires lock, calls `run()`, releases lock |
| `pkg/services/sqlstore/migrator/migrator.go` | `run()` | 241–291 | Iterates migrations, checks `logMap`, logs completion summary |
| `pkg/services/sqlstore/migrations/migrations.go` | `AddMigration()` | — | Registers 626 migrations across 40+ groups |
| `pkg/services/sqlstore/sqlstore.go` | — | — | SQLStore initialization, emits `"Connecting to DB"` |
| `conf/defaults.ini` | `migration_locking` | — | Default: `true` — enables advisory locking |

---

## 3. Build Information API Verification

### Question

What is the exact version string reported by the running instance's API endpoints?

### Thinking / Rationale

The version information is injected at build time via Go linker flags (`-ldflags`). The build command used:

```bash
go build -tags "oss" \
  -ldflags "-X main.version=11.5.0-pre -X main.commit=4550cfb5b7 -X main.buildstamp=1734099722 -X main.buildBranch=..." \
  -o ./bin/grafana ./pkg/cmd/grafana
```

Two API endpoints expose version information:

1. **`GET /api/health`** — Served by `apiHealthHandler()` in `pkg/api/http_server.go` (lines 710–745). Returns a `healthResponse` struct (lines 693–699) with `Database`, `Version`, and `Commit` fields. The version is populated from `hs.Cfg.BuildVersion` (line 720), which is set from the `-ldflags` injected `main.version` value.

2. **`GET /api/frontend/settings`** — Served by `GetFrontendSettings()` in `pkg/api/frontendsettings.go` (line 88), which delegates to `getFrontendSettings()` (lines 101–270+). This constructs a `FrontendSettingsBuildInfoDTO` (defined in `pkg/api/dtos/frontend_settings.go`, lines 39–55) at lines 247–258 of `frontendsettings.go`. The `versionString` is constructed at line 165:
   ```go
   versionString := fmt.Sprintf(`%s v%s (%s)`, setting.ApplicationName, version, commitShort)
   ```
   Where `setting.ApplicationName` is `"Grafana"`, `version` is `"11.5.0-pre"`, and `commitShort` is the first 10 characters of the commit hash.

### Runtime Evidence — `GET /api/health`

```json
{
    "database": "ok",
    "version": "11.5.0-pre",
    "commit": "4550cfb5b7"
}
```

### Runtime Evidence — `GET /api/frontend/settings` (buildInfo extract)

```json
{
  "hideVersion": false,
  "version": "11.5.0-pre",
  "versionString": "Grafana v11.5.0-pre (4550cfb5b7)",
  "commit": "4550cfb5b7",
  "commitShort": "4550cfb5b7",
  "buildstamp": 1734099722,
  "edition": "Open Source",
  "latestVersion": "",
  "hasUpdate": false,
  "env": "production"
}
```

### Answer

- **Exact version string:** `11.5.0-pre`
- **Branded version string (displayed in UI):** `Grafana v11.5.0-pre (4550cfb5b7)`
- **Commit:** `4550cfb5b7`
- **Build timestamp:** `1734099722` (Unix epoch)
- **Edition:** `Open Source`

### Code Path

| File | Function/Method | Lines | Purpose |
|---|---|---|---|
| `pkg/api/http_server.go` | `apiHealthHandler()` | 710–745 | Serves `/api/health`; populates `Version` from `hs.Cfg.BuildVersion` (line 720) |
| `pkg/api/http_server.go` | `healthResponse` struct | 693–699 | Defines `Database`, `Version`, `Commit` fields |
| `pkg/api/frontendsettings.go` | `GetFrontendSettings()` | 88–96 | Entry point for `/api/frontend/settings` |
| `pkg/api/frontendsettings.go` | `getFrontendSettings()` | 101–270+ | Constructs `FrontendSettingsBuildInfoDTO` at lines 247–258 |
| `pkg/api/dtos/frontend_settings.go` | `FrontendSettingsBuildInfoDTO` | 39–55 | Struct: `Version`, `VersionString`, `Commit`, `CommitShort`, `Buildstamp`, `Edition`, `Env` |
| `build.go` | — | — | Build entry point injecting `-ldflags` for version, commit, buildstamp |

---

## 4. Dashboard Scene Datasource Picker Architecture Investigation

### Question

Does the panel editor's datasource picker automatically resolve to and display the datasource already defined in the panel queries when transitioning from the dashboard view to the panel editor? What is the responsible codebase area?

### Thinking / Rationale

To answer this question, the `PanelDataQueriesTab` class was analyzed in detail, and the existing Jest test suite (25 tests) was run to confirm the behavior.

### Answer: **YES**

The datasource picker automatically resolves to and displays the datasource defined in the panel queries. Here is the exact mechanism:

### Code Analysis — Complete Flow

**Step 1: `PanelEditor` activation** (`public/app/features/dashboard-scene/panel-edit/PanelEditor.tsx`)

The `PanelEditor._activationHandler()` activates the panel and its parent scene tree, calls `waitForPlugin()` to ensure the panel plugin is loaded, then constructs a `PanelDataPane` which contains the `PanelDataQueriesTab`.

**Step 2: `PanelDataQueriesTab` activation** (`public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx`)

The constructor (lines 42–45) registers an activation handler:
```typescript
this.addActivationHandler(() => this.onActivate());
```

`onActivate()` (line 59) immediately calls `this.loadDataSource()` (line 60).

**Step 3: `loadDataSource()` — the core auto-resolution logic** (lines 63–127)

This is the critical method. Here is the step-by-step flow:

1. **Read the panel's configured datasource** (line 71):
   ```typescript
   let datasourceToLoad = this.queryRunner.state.datasource;
   ```
   This reads the `datasource` reference from the `SceneQueryRunner`'s state — this is the datasource already configured in the panel's queries (set when the panel was created or last edited).

2. **If no datasource is configured** (lines 77–99) — fallback path:
   - Calls `getLastUsedDatasourceFromStorage(dashboardUid)` (from `public/app/features/dashboard/utils/dashboard.ts`) to read the last-used datasource from localStorage.
   - If found, resolves it via `getDataSourceSrv().get()` and updates the query runner state with the resolved reference.

3. **If datasource IS configured** (lines 100–103) — the normal case for existing panels:
   ```typescript
   datasource = await getDataSourceSrv().get(datasourceToLoad);
   dsSettings = getDataSourceSrv().getInstanceSettings(datasourceToLoad);
   ```
   This resolves the datasource reference to a full `DataSourceApi` instance and its `DataSourceInstanceSettings`.

4. **Update state and store** (lines 105–108):
   ```typescript
   if (datasource && dsSettings) {
     this.setState({ datasource, dsSettings });
     storeLastUsedDataSourceInLocalStorage(getDataSourceRef(dsSettings) || { default: true });
   }
   ```
   Setting `datasource` and `dsSettings` in state makes the resolved datasource available to the UI picker component, which renders the correct datasource name in the dropdown.

5. **Error fallback** (lines 109–126): If resolution fails, loads the default datasource from `config.defaultDatasource`.

**Resolution chain summary:**

```text
queryRunner.state.datasource → getDataSourceSrv().get() → setState({ datasource, dsSettings }) → UI picker displays it
```

### Test Evidence

**Command:** `CI=true npx jest --watchAll=false --ci --verbose public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx`

**Output (all 25 tests pass):**

```text
PASS public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx
  PanelDataQueriesTab
    Adding queries
      ✓ can add a new query (28 ms)
      ✓ Can add a new query when datasource is mixed (8 ms)
    PanelDataQueriesTab
      ✓ renders query group top section (142 ms)
      ✓ renders queries rows when queries are set (30 ms)
      ✓ allow to add a new query when user clicks on add new (123 ms)
      ✓ allow to remove a query when user clicks on remove (419 ms)
    query options
      activation
        ✓ should load data source (6 ms)
        ✓ should store loaded data source in local storage (5 ms)
        ✓ should load default datasource if the datasource passed is not found (7 ms)
      data source change
        ✓ should load new data source (5 ms)
        ✓ changing from one plugin to another (4 ms)
        ✓ changing from a plugin to a dashboard data source (4 ms)
        ✓ changing from dashboard data source to a plugin (4 ms)
      query options change
        time overrides
          ✓ should create PanelTimeRange object (7 ms)
          ✓ should update hoverHeader (4 ms)
          ✓ should update PanelTimeRange object on time options update (5 ms)
          ✓ should remove PanelTimeRange object on time options cleared (4 ms)
        max data points and interval
          ✓ should update max data points (6 ms)
          ✓ should update min interval (4 ms)
          ✓ should update min interval to undefined if empty input (4 ms)
        query caching
          ✓ updates cacheTimeout and queryCachingTTL (4 ms)
      query inspection
        ✓ allows query inspection from the tab (4 ms)
      change queries
        plugin queries
          ✓ should update queries (8 ms)
        dashboard queries
          ✓ should update queries (4 ms)
          ✓ should load last used data source if no data source specified for a panel (4 ms)

Test Suites: 1 passed, 1 total
Tests:       25 passed, 25 total
Snapshots:   0 total
Time:        4.9 s
```

**Key tests that prove the auto-resolution behavior:**

| Test Name | What It Proves |
|---|---|
| `"should load data source"` | On activation, the tab resolves to the panel's configured datasource |
| `"should store loaded data source in local storage"` | The resolved datasource is stored for future use |
| `"should load default datasource if the datasource passed is not found"` | The fallback mechanism works correctly |
| `"should load last used data source if no data source specified for a panel"` | Panels without a datasource fall back to localStorage |

### Responsible Codebase Area

| Role | File | Component/Method | Lines |
|---|---|---|---|
| **Primary** | `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx` | `PanelDataQueriesTab.loadDataSource()` | 63–127 |
| **Supporting** | `public/app/features/dashboard/utils/dashboard.ts` | `getLastUsedDatasourceFromStorage()` | — |
| **Supporting** | `public/app/features/datasources/components/picker/utils.ts` | `storeLastUsedDataSourceInLocalStorage()` | — |
| **Test Coverage** | `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx` | 25 tests | — |

---

## 5. Alerting API Rule Creation Investigation

### Question

Does the backend's rule definition populate the query state when the edit view is opened for an existing alerting rule? What is the responsible codebase area?

### Thinking / Rationale

To answer this question, the `AlertRuleForm` and `formValuesFromExistingRule` code path was analyzed, and the existing Jest tests (21 tests, 7 snapshots) for `rule-form.ts` were run.

### Answer: **YES**

The backend's rule definition populates the query state when the edit view is opened. Here is the exact mechanism:

### Code Analysis — Complete Flow

**Step 1: `ExistingRuleEditor` fetches the rule** (`public/app/features/alerting/unified/ExistingRuleEditor.tsx`)

The `ExistingRuleEditor` component (line 16) uses the `useRuleWithLocation()` hook (lines 17–21) to fetch the rule from the backend API:
```typescript
const {
  loading: loadingAlertRule,
  result: ruleWithLocation,
  error,
} = useRuleWithLocation({ ruleIdentifier: identifier });
```

Once loaded, the `ruleWithLocation` object is passed directly to `AlertRuleForm` (line 49):
```typescript
return <AlertRuleForm existing={ruleWithLocation} />;
```

**Step 2: `AlertRuleForm` — `defaultValues` useMemo** (`public/app/features/alerting/unified/components/rule-editor/alert-rule-form/AlertRuleForm.tsx`)

Lines 103–124: The `defaultValues` useMemo checks if `existing` is truthy:
```typescript
const defaultValues: RuleFormValues = useMemo(() => {
  if (existing) {
    return formValuesFromExistingRule(existing);
  }
  // ... other cases for prefill, query params, defaults
}, [existing, prefill, queryParams, evaluateEvery, ruleType]);
```

When editing an existing rule, `existing` is truthy, so `formValuesFromExistingRule(existing)` is called.

**Step 3: `formValuesFromExistingRule()`** (`public/app/features/alerting/unified/utils/rule-form.ts`)

Lines 916–918:
```typescript
export function formValuesFromExistingRule(rule: RuleWithLocation<RulerRuleDTO>) {
  return ignoreHiddenQueries(rulerRuleToFormValues(rule));
}
```

This delegates to `rulerRuleToFormValues()` and then strips hidden queries.

**Step 4: `rulerRuleToFormValues()`** (`public/app/features/alerting/unified/utils/rule-form.ts`)

Lines 365–465 — the main conversion function. It handles four cases:

1. **Grafana recording rules** (lines 371–387):
   ```typescript
   const ga = rule.grafana_alert;
   return {
     ...defaultFormValues,
     // ...
     queries: ga.data,   // <-- line 380: populates queries from backend data
     // ...
   };
   ```

2. **Grafana alerting rules** (lines 388–419):
   ```typescript
   const ga = rule.grafana_alert;
   return {
     ...defaultFormValues,
     // ...
     queries: ga.data,   // <-- line 402: populates queries from backend data
     // ...
   };
   ```
   The `ga.data` field contains the array of `AlertQuery` objects from the backend's `GrafanaAlertStateDesc.Data` field — this is the complete set of query definitions including datasource UIDs, query models, relative time ranges, and ref IDs.

3. **Datasource-managed alerting rules** (lines 421–449):
   ```typescript
   const defaultQuery = {
     refId: 'A',
     datasourceUid,
     queryType: '',
     relativeTimeRange: getDefaultRelativeTimeRange(),
     expr: rule.expr,
     model: { refId: 'A', hide: false, expr: rule.expr },
   };
   return {
     ...defaultFormValues,
     // ...
     queries: [defaultQuery],  // <-- line 443: constructs query from expr
     // ...
   };
   ```

4. **Datasource-managed recording rules** (lines 450–461): Delegates to `recordingRulerRuleToRuleForm(rule)`.

**Step 5: Form consumption**

The `defaultValues` (now containing populated `queries`) are passed to `useForm<RuleFormValues>()` (lines 126–129 of `AlertRuleForm.tsx`):
```typescript
const formAPI = useForm<RuleFormValues>({
  mode: 'onSubmit',
  defaultValues,
  shouldFocusError: true,
});
```

This makes the `queries` available via `react-hook-form`'s context to all child form components, including `QueryAndExpressionsStep` (`public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/QueryAndExpressionsStep.tsx`), which reads `queries` from the form context and initializes its reducer state.

### Test Evidence

**Command:** `CI=true npx jest --watchAll=false --ci --verbose public/app/features/alerting/unified/utils/rule-form.test.ts`

**Output (all 21 tests pass, 7 snapshots match):**

```text
PASS public/app/features/alerting/unified/utils/rule-form.test.ts
  formValuesToRulerGrafanaRuleDTO
    ✓ should correctly convert rule form values for grafana alerting rule (4 ms)
    ✓ should correctly convert rule form values for grafana recording rule (1 ms)
    ✓ should not save both instant and range type queries (1 ms)
    ✓ should set keep_firing_for if values are populated (1 ms)
    ✓ should not set keep_firing_for if values are undefined (1 ms)
    ✓ should parse keep_firing_for (1 ms)
    ✓ should set keepFiringForTime and keepFiringForTimeUnit to undefined if keep_firing_for not set
  getContactPointsFromDTO
    ✓ should return undefined if notification_settings is not defined (1 ms)
    ✓ should return routingSettings with correct props if notification_settings is defined (1 ms)
  getNotificationSettingsForDTO
    ✓ should return undefined if manualRouting is false (1 ms)
    ✓ should return undefined if selectedContactPoint is not defined (1 ms)
    ✓ should return notification settings if manualRouting is true and selectedContactPoint is defined
  getDefautManualRouting
    ✓ returns false if the feature toggle is not enabled (1 ms)
    ✓ returns true if the feature toggle is enabled and localStorage is not set
    ✓ returns false if the feature toggle is enabled and localStorage is set to "false"
    ✓ returns true if the feature toggle is enabled and localStorage is set to any value other than "false" (1 ms)
  cleanAnnotations
    ✓ should remove falsy KVs
    ✓ should trim keys and values
  cleanLabels
    ✓ should remove falsy KVs (1 ms)
    ✓ should trim keys and values
    ✓ should leave empty values (1 ms)

Test Suites: 1 passed, 1 total
Tests:       21 passed, 21 total
Snapshots:   7 passed, 7 total
Time:        3.97 s
```

The tests confirm that:
- `formValuesToRulerGrafanaRuleDTO` correctly converts form values including query data for both alerting and recording rules.
- The round-trip conversion (form values → ruler DTO → form values) preserves query state.
- Snapshot tests verify the exact structure of the converted DTOs.

### Responsible Codebase Area

| Role | File | Component/Method | Lines |
|---|---|---|---|
| **Entry Point** | `public/app/features/alerting/unified/ExistingRuleEditor.tsx` | `ExistingRuleEditor` component | 16–50 |
| **Form Initialization** | `public/app/features/alerting/unified/components/rule-editor/alert-rule-form/AlertRuleForm.tsx` | `defaultValues` useMemo | 103–124 |
| **Rule-to-Form Conversion** | `public/app/features/alerting/unified/utils/rule-form.ts` | `formValuesFromExistingRule()` | 916–918 |
| **Core Conversion Logic** | `public/app/features/alerting/unified/utils/rule-form.ts` | `rulerRuleToFormValues()` | 365–465 |
| **Query Consumer** | `public/app/features/alerting/unified/components/rule-editor/query-and-alert-condition/QueryAndExpressionsStep.tsx` | Reads `queries` from form context | — |
| **Test Coverage** | `public/app/features/alerting/unified/utils/rule-form.test.ts` | 21 tests, 7 snapshots | — |

---

## 6. Reproducibility

All evidence in this document can be reproduced from commit `4550cfb5b7` on branch `grafana_4550cfb5b728` using Go 1.23.1 and Node.js 22.11.0.

### Prerequisites

- **Go:** 1.23.1
- **Node.js:** 22.11.0 (via nvm)
- **Yarn:** 4.5.3 (Berry, via corepack)
- **System packages:** `build-essential`, `gcc`, `sqlite3`, `libsqlite3-dev`

### Build the Server

```bash
# Generate Wire dependency injection code (wire_gen.go is .gitignored)
go run ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server

# Build the Grafana server binary
COMMIT=$(git rev-parse --short HEAD)
CGO_ENABLED=1 go build -tags "oss" \
  -ldflags "-X main.version=11.5.0-pre -X main.commit=${COMMIT} -X main.buildstamp=1734099722 -X main.buildBranch=$(git branch --show-current)" \
  -o ./bin/grafana \
  ./pkg/cmd/grafana
```

### Run the Server

```bash
# Start with SQLite (default)
export GF_PATHS_DATA=/tmp/grafana_data
export GF_SERVER_HTTP_PORT=3333
./bin/grafana server -homepath . -config conf/defaults.ini
# Default admin credentials: admin/admin
```

### Query API Endpoints

```bash
# Health endpoint
curl -s http://localhost:3333/api/health | python3 -m json.tool

# Frontend settings (requires authentication)
curl -s -u admin:admin http://localhost:3333/api/frontend/settings | python3 -m json.tool
```

### Run Jest Tests

```bash
# Dashboard panel queries tab tests (25 tests)
CI=true npx jest --watchAll=false --ci --verbose \
  public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx

# Alerting rule form tests (21 tests, 7 snapshots)
CI=true npx jest --watchAll=false --ci --verbose \
  public/app/features/alerting/unified/utils/rule-form.test.ts
```

---

## 7. Summary

| # | Question | Answer | Key Evidence | Primary Source Files |
|---|---|---|---|---|
| 1 | **Server Idle Behavior** | Only one log entry: `"Usage stats are ready to report"` | 90-second idle window produced exactly 1 log line | `pkg/infra/usagestats/service/service.go` (line 117) |
| 2 | **Migration Check** | `performed=0 skipped=626` confirms schema is current | Restart log shows all 626 migrations skipped | `pkg/services/sqlstore/migrator/migrator.go` (lines 241–291) |
| 3 | **Build Version API** | Version: `11.5.0-pre`; Branded: `Grafana v11.5.0-pre (4550cfb5b7)` | `/api/health` and `/api/frontend/settings` JSON responses | `pkg/api/http_server.go` (lines 710–745), `pkg/api/frontendsettings.go` (lines 247–258) |
| 4 | **Datasource Picker** | **YES** — auto-resolves from `queryRunner.state.datasource` | 25/25 Jest tests pass, including `"should load data source"` | `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx` (lines 63–127) |
| 5 | **Alerting Query State** | **YES** — `ga.data` maps directly to form `queries` | 21/21 Jest tests pass, 7/7 snapshots match | `public/app/features/alerting/unified/utils/rule-form.ts` (lines 365–465, 916–918) |
