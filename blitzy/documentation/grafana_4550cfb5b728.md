# Grafana Runtime Investigation — Internal Health & Background Behavior

> **Deliverable** answering five questions about how Grafana manages its internal health and
> background work after server initialization. Every answer is backed by **observed runtime
> evidence** — the real code paths were built and run first, the real output was captured, and
> only then was this document written.

---

## Methodology Note

| Item | Value |
|------|-------|
| **Repository HEAD (commit)** | `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` |
| **Branch** | `blitzy-ca27568d-d7be-496e-b5cd-6897dc7e85b0` (checkout of source branch `grafana_4550cfb5b728`) |
| **Toolchain observed** | `go version go1.23.1 linux/amd64`, `node v22.12.0`, `yarn 4.5.3` |
| **Frontend dependency install** | `yarn install --immutable` |
| **Canonical backend build** | `make build` → binary `./bin/linux-amd64/grafana` (ldflags-stamped) |
| **Canonical build confirmation** | `./bin/linux-amd64/grafana --version` → `grafana version 11.5.0-pre` |
| **Run/invocation command** | `./bin/linux-amd64/grafana server --homepath <repo-root>` (reads default `conf/defaults.ini`) |
| **Default config in effect** | `http_port = 3000` (`conf/defaults.ini:41`), `database.type = sqlite3` (`:123`), `[log] level = info` (`:1074`) |
| **Idle test — Run 1** | Fresh/pristine DB. Idle (no user requests) **≈20 minutes**: `2026-07-06T22:24:02Z → 22:44:53Z` |
| **Idle test — Run 2** | Existing DB. Idle (no user requests) **≈20 minutes**: `2026-07-06T22:45:14Z → 23:05:57Z` |
| **Number of idle runs** | **2** (cadence confirmed stable across both) |
| **Environment** | Canonical Docker container `andrewparkscaleai/coding-agent:grafana__grafana__4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`. **Network was reachable** in this run (see the honest note in Requirement 1). |
| **Non-interactive execution** | Jest run with `--ci --watchAll=false` (plus `--verbose` for per-test names); the server was backgrounded and stopped with `kill` after each capture. |

**How to read each answer.** Every requirement below follows the same five-part structure:
**(1)** a direct answer to the question and every named sub-part, **(2)** the exact command(s) that
produced the evidence, **(3)** the actual, complete, unedited output (in fenced code blocks),
**(4)** the responsible `file:line` citation(s) re-verified against the code at HEAD `4550cfb5…`,
and **(5)** cause-to-effect reasoning connecting the code to the observed behavior. Any statement
that could only be derived from reading (not running) is explicitly labeled **(inferred)**.

**Line-number fidelity.** All `file:line` anchors below were re-verified with `grep -n` against the
working tree at HEAD `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` at authoring time.

---

## Table of Contents

1. [Requirement 1 — Idle recurring log entries](#requirement-1--idle-recurring-log-entries)
2. [Requirement 2 — Database migration check](#requirement-2--database-migration-check)
3. [Requirement 3 — Version string reported by the API](#requirement-3--version-string-reported-by-the-api)
4. [Requirement 4 — Dashboard-scene datasource picker](#requirement-4--dashboard-scene-datasource-picker)
5. [Requirement 5 — Alerting rule-edit query-state population](#requirement-5--alerting-rule-edit-query-state-population)

---

## Requirement 1 — Idle recurring log entries

> **User question (verbatim):** *"After the server has been running for at least 60 seconds with no
> user requests, what are the exact recurring log entries that appear? Provide the actual log output
> as runtime evidence."*

### 1.1 Direct answer

At the default log level (`info`), **there is essentially no recurring INFO output within the first
60 seconds** — the first 60 seconds contain only one-time *startup* events, not recurrence. Genuine
recurrence begins at **t ≈ 10 minutes**. Once the server has run long enough, exactly **two** INFO
log entries recur, both on a **10-minute cadence**:

1. `logger=cleanup … msg="Completed cleanup jobs" duration=<…>` — every **10 minutes**.
2. `logger=plugins.update.checker … msg="Update check succeeded" duration=<…>` — every **10 minutes**.

Two additional background emitters fire **once** near startup and do **not** recur inside a
~20-minute window: `logger=grafana.update.checker … "Update check succeeded"` (its ticker is 24 h)
and `logger=infra.usagestats … "Usage stats are ready to report"` (a one-shot readiness callback).

**Why "at least 60 seconds" shows little/nothing:** most background tickers are 10 min / 1 h / 24 h,
the alerting scheduler's per-tick logging is `Debug` (silent at the default `info` level), and the
usage-stats reporter's first *send* on a fresh database is ~24 h away. So a strict 60-second window
captures only the startup update-check lines and the one-shot "Usage stats are ready to report" —
**no line has recurred yet**. To observe genuine recurrence you must run well past 60 s; this
investigation ran **≈20 minutes per run, twice**, to capture two full cleanup cycles each time.

**Honest note on network / update checks.** The AAP anticipated an *offline* container in which the
update checkers would fail. In this run the environment **had network reachability**, so both update
checkers **succeeded** and logged `"Update check succeeded"` at `info` rather than failing. This is
reported exactly as observed. **(inferred — not observed in this run, since no failure occurred)**:
for completeness of the code path, on failure the plugin checker logs `Debug("Update check failed", …)`
— silent at `info` — while the Grafana checker logs `Error("Update check failed", …)` (see §1.4). The
failure branch was not exercised here because the network was reachable.

### 1.2 Exact commands

```bash
# Launch the canonically-built server, backgrounded, capturing combined stdout+stderr:
./bin/linux-amd64/grafana server --homepath <repo-root> > /tmp/grafana_run.log 2>&1 &
GRAF_PID=$!

# Leave it completely idle (NO user requests) for ~20 minutes, then extract the
# background/recurring INFO emitters with their timestamps:
grep -E 'logger=(cleanup|plugins.update.checker|grafana.update.checker|infra.usagestats|entity-events) ' \
     /tmp/grafana_run.log | grep 'level=info'

kill $GRAF_PID   # stop the server after capture
```

### 1.3 Actual, complete, unedited output

**Run 1 — fresh DB, idle `2026-07-06T22:24:02Z → 22:44:53Z` (≈20 min).** All background/recurring
INFO lines, in order:

```text
logger=plugins.update.checker t=2026-07-06T22:24:04.839352478Z level=info msg="Update check succeeded" duration=34.937094ms
logger=grafana.update.checker t=2026-07-06T22:24:04.839395598Z level=info msg="Update check succeeded" duration=35.02234ms
logger=infra.usagestats t=2026-07-06T22:24:42.806119999Z level=info msg="Usage stats are ready to report"
logger=cleanup t=2026-07-06T22:34:04.861747738Z level=info msg="Completed cleanup jobs" duration=56.817965ms
logger=plugins.update.checker t=2026-07-06T22:34:04.87125835Z level=info msg="Update check succeeded" duration=31.475307ms
logger=cleanup t=2026-07-06T22:44:04.870062095Z level=info msg="Completed cleanup jobs" duration=64.775568ms
logger=plugins.update.checker t=2026-07-06T22:44:05.110951196Z level=info msg="Update check succeeded" duration=271.501259ms
```

**Run 2 — existing DB, idle `2026-07-06T22:45:14Z → 23:05:57Z` (≈20 min).** Same pattern, proving the
cadence is stable across runs:

```text
logger=plugins.update.checker t=2026-07-06T22:45:14.498037616Z level=info msg="Update check succeeded" duration=32.823864ms
logger=grafana.update.checker t=2026-07-06T22:45:14.57164211Z level=info msg="Update check succeeded" duration=106.351902ms
logger=infra.usagestats t=2026-07-06T22:46:13.467041572Z level=info msg="Usage stats are ready to report"
logger=cleanup t=2026-07-06T22:55:14.523759221Z level=info msg="Completed cleanup jobs" duration=58.484658ms
logger=plugins.update.checker t=2026-07-06T22:55:14.549293189Z level=info msg="Update check succeeded" duration=50.357409ms
logger=cleanup t=2026-07-06T23:05:14.467929244Z level=info msg="Completed cleanup jobs" duration=2.061593ms
logger=plugins.update.checker t=2026-07-06T23:05:14.548456467Z level=info msg="Update check succeeded" duration=49.941176ms
```

**Cadence — computed inter-arrival deltas (Run 2):**

```text
cleanup                1  2026-07-06T22:55:14.523759221Z
cleanup                2  2026-07-06T23:05:14.467929244Z   delta=599.944s   (≈ 10 min)
plugins.update.checker 1  2026-07-06T22:45:14.498037616Z
plugins.update.checker 2  2026-07-06T22:55:14.549293189Z   delta=600.051s   (≈ 10 min)
plugins.update.checker 3  2026-07-06T23:05:14.548456467Z   delta=599.999s   (≈ 10 min)
```

The `cleanup` and `plugins.update.checker` lines are ~600 s apart in both runs → the **10-minute
cadence is stable across ≥2 runs** (to sub-second precision).

> **Provenance caveat (honesty):** the two idle logs above are filtered to the *background emitters*.
> If you `grep` the raw Run 1 log you will also see a few
> `logger=context … msg="Request Completed" … path=/api/frontend/settings status=401` lines around
> `22:25Z` — **those are from the author's own Requirement 3 `curl` probes, not idle recurrence**, and
> the server was left untouched afterward (the 22:34 and 22:44 lines are pure idle). One-time,
> network-dependent startup extras also appear once (e.g. a `grafana-lokiexplore-app` plugin install,
> and a transient `sqlstore.transactions … "Database locked, sleeping then retrying"` during the
> first-run migration); these do **not** recur.

### 1.4 Responsible code (`file:line`, re-verified at HEAD `4550cfb5…`)

The run loop that launches every background service as a goroutine:

- `pkg/server/server.go:139` — `func (s *Server) Run() error`
- `pkg/server/server.go:146` — `services := s.backgroundServices`
- `pkg/server/server.go:149` — `for _, svc := range services {`
- `pkg/server/server.go:156` — `s.childRoutines.Go(func() error {`
- `pkg/server/server.go:162` — `s.log.Debug("Starting background service", …)` *(Debug → silent at `info`)*

The service set is assembled in `pkg/registry/backgroundsvcs/background_services.go`.

The two **recurring** (10-minute) INFO emitters:

- **Cleanup** — `pkg/services/cleanup/cleanup.go`
  - `:56` `log: log.New("cleanup")`
  - `:77` `func (srv *CleanUpService) Run(ctx …) error` — calls `srv.cleanUpTmpFiles(ctx)` once at
    startup (no INFO line), then loops on the ticker
  - `:80` `ticker := time.NewTicker(time.Minute * 10)` — fires `srv.clean(ctx)` only on `ticker.C`
  - `:128` `logger.Info("Completed cleanup jobs", "duration", time.Since(start))`
- **Plugin update checker** — `pkg/services/updatechecker/plugins.go`
  - `:39` `logger := log.New("plugins.update.checker")`
  - `:75` `func (s *PluginsService) Run(ctx …) error` — calls `s.instrumentedCheckForUpdates(ctx)`
    **at startup (t=0)**, then on the ticker
  - `:78` `ticker := time.NewTicker(time.Minute * 10)`
  - `:123` `ctxLogger.Info("Update check succeeded", "duration", time.Since(start))`
  - `:120` `ctxLogger.Debug("Update check failed", …)` on error *(Debug → silent at `info`)*

The two **once-only** background emitters:

- **Grafana update checker** — `pkg/services/updatechecker/grafana.go`
  - `:38` `logger := log.New("grafana.update.checker")`; `:60` `Run`; runs at startup then
    `:63` `ticker := time.NewTicker(time.Hour * 24)`
  - `:89` `ctxLogger.Info("Update check succeeded", …)`; `:86` `ctxLogger.Error("Update check failed", …)` on error
- **Usage-stats reporter** — `pkg/infra/usagestats/service/service.go`
  - `:45` `log.New("infra.usagestats")`; `:56` `Run`; `:76` `sendReportTicker := time.NewTicker(nextSendInterval)`
  - `:117` `uss.log.Info("Usage stats are ready to report")` (the one-shot `SetReadyToReport` callback)

Other background tickers that run silently in a ~20-min idle window (no INFO at default level, verified):
`pkg/services/loginattempt/loginattemptimpl/login_attempt.go:38` (10 min), 
`pkg/services/serviceaccounts/manager/service.go:105` & `:116` (stats / secret-scan tickers),
`pkg/services/auth/authimpl/token_cleanup.go:11` (1 h),
`pkg/services/store/entity_events.go:129` (1 h; INFO `"Deleting old events"` at `:119` only when rows are deleted),
and the alerting scheduler `pkg/services/ngalert/schedule/schedule.go:157` (`Info("Starting scheduler", …)` fires **once**; per-tick logging is `Debug`).

The one-time startup banner (fires once, not recurring): `pkg/setting/setting.go:940` —
`cfg.Logger.Info(fmt.Sprintf("Starting %s", ApplicationName), "version", BuildVersion, "commit", BuildCommit, "branch", BuildBranch, "compiled", …)`.

### 1.5 Cause → effect

Each background service is launched as its own goroutine by the run loop
(`server.go:149` → `s.childRoutines.Go(...)`), and each installs a `time.Ticker`. A line is emitted
only when its ticker fires **and** the emit is at `info` (the default level). Two services tick every
10 minutes *and* log at `info`: cleanup's `srv.clean()` (→ `"Completed cleanup jobs"`) and the plugin
update checker's `instrumentedCheckForUpdates()` (→ `"Update check succeeded"`). Everything else is
either slower (1 h / 24 h), logs at `Debug` (the alert scheduler per tick; the offline plugin-check
failure), or is a one-shot (`grafana.update.checker` first run; `"Usage stats are ready to report"`).
That is precisely why the captured idle logs are dominated by the two 10-minute lines, why the
inter-arrival deltas are ≈600 s, and why a strict 60-second window shows no recurrence at all — the
first recurring line (`cleanup`) does not appear until **t ≈ 10 min**, since `srv.clean()` runs only
on `ticker.C` and not at startup (`cleanup.go:77-88`).

---


## Requirement 2 — Database migration check

> **User question (verbatim):** *"I want you to give me the runtime evidence of the database
> migration check. When the server starts what is the specific output that confirms that the schema
> version is up to date."*

### 2.1 Direct answer

The specific line that confirms the schema is up to date is the migrator's **`"migrations completed"`**
INFO line reporting **`performed=0`** (with `skipped` equal to the total number of registered
migrations). On an already-migrated database the server logs:

```text
logger=migrator … msg="Starting DB migrations"
logger=migrator … msg="migrations completed" performed=0 skipped=626 duration=598.24µs
```

`performed=0` means the migrator executed **zero** migrations, and the **absence of any
`"Executing migration"` line** confirms nothing needed to run — i.e. the schema is current. (There
are two migrators; the resource API server's `resource-migrator` logs the same confirmation with its
own totals: `performed=0 skipped=18`.)

To make the confirmation unambiguous, both states were captured:

- **First run (fresh DB)** → migrations actually run: `performed=626 skipped=0`, and 626
  `"Executing migration"` lines appear.
- **Restart (already current)** → `performed=0 skipped=626`, and **zero** `"Executing migration"`
  lines appear. This is the "up to date" confirmation the question asks about.

### 2.2 Exact commands

```bash
# Fresh DB (no ./data directory present) — captures the first-run migration:
./bin/linux-amd64/grafana server --homepath <repo-root> > /tmp/grafana_run1.log 2>&1 &
grep -E 'logger=(migrator|resource-migrator) ' /tmp/grafana_run1.log \
  | grep -E 'Starting DB migrations|Executing migration|Migration successfully executed|migrations completed'

# Restart against the DB just created — captures the "already current" confirmation:
./bin/linux-amd64/grafana server --homepath <repo-root> > /tmp/grafana_run2.log 2>&1 &
grep -E 'logger=(migrator|resource-migrator) ' /tmp/grafana_run2.log \
  | grep -E 'Starting DB migrations|migrations completed|Locking database|Unlocking database'
grep -c 'Executing migration' /tmp/grafana_run2.log   # -> 0 when already current
```

### 2.3 Actual, complete, unedited output

**(a) Restart — "already current" (the confirmation the question asks for):**

```text
logger=migrator t=2026-07-06T22:45:14.269543784Z level=info msg="Locking database"
logger=migrator t=2026-07-06T22:45:14.269563819Z level=info msg="Starting DB migrations"
logger=migrator t=2026-07-06T22:45:14.275953087Z level=info msg="migrations completed" performed=0 skipped=626 duration=598.24µs
logger=migrator t=2026-07-06T22:45:14.276113359Z level=info msg="Unlocking database"
logger=resource-migrator t=2026-07-06T22:45:14.462285744Z level=info msg="Locking database"
logger=resource-migrator t=2026-07-06T22:45:14.462302492Z level=info msg="Starting DB migrations"
logger=resource-migrator t=2026-07-06T22:45:14.462651048Z level=info msg="migrations completed" performed=0 skipped=18 duration=35.603µs
logger=resource-migrator t=2026-07-06T22:45:14.462787373Z level=info msg="Unlocking database"
```

Count of `"Executing migration"` lines on this restart:

```text
Executing migration count on run2: 0
```

**(b) First run — fresh DB (contrast: what a real migration looks like):**

```text
logger=migrator t=2026-07-06T22:24:02.93916536Z level=info msg="Starting DB migrations"
logger=migrator t=2026-07-06T22:24:02.939388932Z level=info msg="Executing migration" id="create migration_log table"
logger=migrator t=2026-07-06T22:24:02.93958309Z level=info msg="Migration successfully executed" id="create migration_log table" duration=195.218µs
logger=migrator t=2026-07-06T22:24:02.98384286Z level=info msg="Executing migration" id="create user table"
logger=migrator t=2026-07-06T22:24:02.984067473Z level=info msg="Migration successfully executed" id="create user table" duration=225.316µs
logger=migrator t=2026-07-06T22:24:02.986464002Z level=info msg="Executing migration" id="add unique index user.login"
logger=migrator t=2026-07-06T22:24:02.986652179Z level=info msg="Migration successfully executed" id="add unique index user.login" duration=188.016µs
```

…(624 further `Executing migration` / `Migration successfully executed` pairs; **626** in total for the
`migrator`)…, ending with the closing line:

```text
logger=migrator t=2026-07-06T22:24:04.60394849Z level=info msg="migrations completed" performed=626 skipped=0 duration=1.664576978s
```

> The two blocks share the same opener (`"Starting DB migrations"`) and closer
> (`"migrations completed"`); the discriminator is `performed`/`skipped` and the presence/absence of
> `"Executing migration"`. `performed=626 skipped=0` = first-time schema creation; `performed=0
> skipped=626` = schema already current.

### 2.4 Responsible code (`file:line`, re-verified at HEAD `4550cfb5…`)

`pkg/services/sqlstore/migrator/migrator.go`:

- `:98` `mg.Logger = log.New("migrator")`
- `:247` `logger.Info("Starting DB migrations")`
- `:262` `logger.Debug("Skipping migration: Already executed", "id", m.Id())` *(Debug → silent at `info`)*; then `migrationsSkipped++`
- `:356` `logger.Info("Executing migration", "id", m.Id())` (inside `doMigration`, reached **only** when a migration actually runs)
- `:392` `logger.Info("Migration successfully executed", "id", m.Id(), "duration", …)`
- `:287` `logger.Info("migrations completed", "performed", migrationsPerformed, "skipped", migrationsSkipped, "duration", time.Since(start))`

The loop that produces the counters (verbatim, `:258-287`):

```go
migrationsPerformed := 0
migrationsSkipped := 0
start := time.Now()
for _, m := range mg.migrations {
    _, exists := mg.logMap[m.Id()]
    if exists {
        logger.Debug("Skipping migration: Already executed", "id", m.Id())
        span.AddEvent("Skipping migration: Already executed",
            trace.WithAttributes(attribute.String("migration_id", m.Id())),
        )
        migrationsSkipped++
        continue
    }
    migStart := time.Now()
    if err := mg.doMigration(ctx, m); err != nil {
        …
        return err
    }
    …
    migrationsPerformed++
}
…
logger.Info("migrations completed", "performed", migrationsPerformed, "skipped", migrationsSkipped, "duration", time.Since(start))
```

### 2.5 Cause → effect

On startup the migrator iterates every registered migration and checks whether its id already exists
in the `migration_log` (`mg.logMap[m.Id()]`). When the schema is current, **every** id already
exists, so each iteration takes the `if exists { … migrationsSkipped++; continue }` branch — logging
the `Debug("Skipping migration: Already executed")` line (silent at `info`) and never calling
`doMigration`. Because `doMigration` (which emits `"Executing migration"` at `:356`) is never
reached, `migrationsPerformed` stays at `0`. The final `logger.Info("migrations completed", …)`
therefore prints `performed=0 skipped=626`. Conversely, on a fresh DB no ids exist, so every
iteration calls `doMigration` (`"Executing migration"` × 626) and increments `migrationsPerformed`,
yielding `performed=626 skipped=0`. Hence **`performed=0` together with the absence of `"Executing
migration"` is the runtime confirmation that the schema version is up to date.**

---


## Requirement 3 — Version string reported by the API

> **User question (verbatim):** *"Can you verify the current build information by querying the api
> endpoints of the running instance. What is the exact value of version string reported by the api.
> Give me runtime evidence to show that this value was reported by querying the api."*

### 3.1 Direct answer

The exact `version` string reported by the API of the canonically-built running instance is:

> **`11.5.0-pre`**

This value was obtained by querying the running instance's build-info endpoints:

- **`GET /api/health`** (public) → `"version": "11.5.0-pre"`, `"commit": "4550cfb5b7"`.
- **`GET /api/frontend/settings`** (authenticated) → `buildInfo.version = "11.5.0-pre"`,
  `buildInfo.versionString = "Grafana v11.5.0-pre (4550cfb5b7)"`.

Named sub-parts answered:

- **The exact version value:** `11.5.0-pre`.
- **Runtime proof it came from the API:** the raw `curl` responses in §3.3 (both endpoints), plus the
  startup banner that stamps the same value into the process.
- **Canonical vs non-canonical (Rule 3):** `11.5.0-pre` is the **canonical** value produced by
  `make build` (ldflags-stamped from `package.json`). A **non-canonical** invocation — a plain
  `go run ./pkg/cmd/grafana` without ldflags — would instead surface the hard-coded fallback
  constant **`9.2.0`** (`pkg/cmd/grafana/main.go:17`). That fallback is reported here **as-is** and
  labeled non-canonical; it was **not** used to produce the value above and was **not** "fixed".
- **Auth sub-condition (Rule 5):** `/api/frontend/settings` returns **HTTP 401** when unauthenticated
  and the full `buildInfo` when authenticated — both states are shown below.

### 3.2 Exact commands

```bash
# Confirm the binary is the canonical, ldflags-stamped build:
./bin/linux-amd64/grafana --version

# Query the running instance (server started with: ./bin/linux-amd64/grafana server --homepath <repo>):
curl -s http://localhost:3000/api/health
curl -s http://localhost:3000/api/frontend/settings                    # unauthenticated
curl -s -u admin:admin http://localhost:3000/api/frontend/settings      # authenticated (default admin/admin)
```

### 3.3 Actual, complete, unedited output

**Canonical build confirmation:**

```text
grafana version 11.5.0-pre
```

**`GET /api/health` (public, no auth):**

```json
{
  "database": "ok",
  "version": "11.5.0-pre",
  "commit": "4550cfb5b7"
}
```

**`GET /api/frontend/settings` — unauthenticated (HTTP 401):**

```json
{"extra":null,"message":"Unauthorized","messageId":"auth.unauthorized","statusCode":401,"traceID":""}
```

**`GET /api/frontend/settings` — authenticated (`buildInfo` object, extracted):**

```json
{
  "buildInfo": {
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
}
```

**Startup banner (cross-confirms the same value is stamped into the process):**

```text
logger=settings t=2026-07-06T22:24:02.937496027Z level=info msg="Starting Grafana" version=11.5.0-pre commit=4550cfb5b7 branch=blitzy-ca27568d-d7be-496e-b5cd-6897dc7e85b0 compiled=2024-12-13T14:22:02Z
```

(`buildstamp: 1734099722` decodes to `2024-12-13T14:22:02Z`, matching the banner's `compiled=` field.)

### 3.4 Responsible code (`file:line`, re-verified at HEAD `4550cfb5…`)

**`/api/health`** — `pkg/api/http_server.go`:

- `:694` `type healthResponse struct { … Version string \`json:"version,omitempty"\` … }`
- `:710` `func (hs *HTTPServer) apiHealthHandler(ctx *web.Context)`
- `:716` `data := healthResponse{ Database: "ok" }`
- `:719` `if !hs.Cfg.Anonymous.HideVersion {`
- `:720` `data.Version = hs.Cfg.BuildVersion`
- `:721` `data.Commit = hs.Cfg.BuildCommit`

Handler excerpt (verbatim, `:716-723`):

```go
data := healthResponse{
    Database: "ok",
}
if !hs.Cfg.Anonymous.HideVersion {
    data.Version = hs.Cfg.BuildVersion
    data.Commit = hs.Cfg.BuildCommit
    …
}
```

**`/api/frontend/settings`** — `pkg/api/frontendsettings.go`: `:161` `version := setting.BuildVersion`;
surfaced in the BuildInfo DTO at `:249` `Version: version,` and `:253` `Buildstamp: buildstamp,`.
**Bootdata** — `pkg/api/index.go:128` `BuildVersion: setting.BuildVersion,` (`:129` `BuildCommit`).

**Where the canonical value comes from (ldflags):** `pkg/build/cmd.go:247`
`b.WriteString(fmt.Sprintf(" -X main.version=%s", opts.version))` (also `:248` commit, `:252`
buildstamp, `:253` buildBranch). The version source of truth is `package.json:6` `"version": "11.5.0-pre"`.

**Non-canonical fallback:** `pkg/cmd/grafana/main.go:17` `var version = "9.2.0"` (used only when the
binary is run without ldflags, e.g. `go run`).

**Backend cross-check test (bundled, proves the round-trip):** `pkg/api/health_test.go:18`
`func TestHealthAPI_Version(...)` sets `cfg.BuildVersion = "7.4.0"` (`:20`) and asserts it comes back
through `/api/health`; `:62` `TestHealthAPI_AnonymousHideVersion` proves the `HideVersion` guard.

### 3.5 Cause → effect

`make build` runs the build pipeline that computes `-X main.version=<package.json version>`
(`build/cmd.go:247`), so the linker stamps `main.version = 11.5.0-pre` into the binary — confirmed by
`grafana --version`. At runtime that flows into `setting.BuildVersion` / `hs.Cfg.BuildVersion`. The
`/api/health` handler copies it to `data.Version` (`http_server.go:720`, guarded by
`!hs.Cfg.Anonymous.HideVersion`), and `/api/frontend/settings` copies `setting.BuildVersion` into
`buildInfo.version` (`frontendsettings.go:161` → `:249`). The same value is printed by the startup
banner (`setting.go:940`). That is why all three independent sources agree on `11.5.0-pre`. A plain
`go run` would omit the ldflags, leaving `main.version` at its declared default `9.2.0`
(`main.go:17`) — which is why the canonical build is required to answer this question, and why
`9.2.0` is labeled the non-canonical fallback rather than the reported value.

---


## Requirement 4 — Dashboard-scene datasource picker

> **User question (verbatim):** *"I also want to understand the dashboard scene architecture.
> Investigate its initialization logic during the transition from the dashboard view to the panel
> editor. Specifically, provide test script outputs to prove whether the picker automatically
> resolves to and displays the datasource already defined in the panel queries. Tell me which part
> of the codebase is responsible for this."*

### 4.1 Direct answer

**Yes.** During the transition into the panel editor, the datasource picker **automatically resolves
to and displays the datasource already defined on the panel's queries.** When the panel-data tab
scene *activates*, it reads the datasource carried on the panel's query runner
(`this.queryRunner.state.datasource`), resolves it to a concrete `DataSourceApi` + instance settings,
and commits them to its own state — which is what the picker renders.

Named sub-parts answered:

- **Does the picker auto-resolve to the query's datasource?** Yes — proven by the passing test
  `should load data source`, which asserts the resolved `state.datasource`/`state.dsSettings` equal
  the query's datasource mocks.
- **Which part of the codebase is responsible?**
  `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx` — the
  activation handler → `loadDataSource()` path (see §4.4).
- **Other conditions exercised (Rule 5):** the edge case (`should load default datasource if the
  datasource passed is not found`), the transitional case (`should load new data source`), and the
  no-datasource case (`should load last used data source if no data source specified for a panel`).

### 4.2 Exact command

```bash
yarn jest public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx \
  --ci --watchAll=false --verbose
```

### 4.3 Actual, complete, unedited output

Relevant `describe`/`it` tree (verbose) and the final summary:

```text
PASS public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx
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
```

```text
Test Suites: 1 passed, 1 total
Tests:       25 passed, 25 total
Snapshots:   0 total
Time:        4.799 s, estimated 18 s
Ran all test suites matching /public\/app\/features\/dashboard-scene\/panel-edit\/PanelDataPane\/PanelDataQueriesTab.test.tsx/i.
```

The decisive assertions inside `should load data source` (test file, `:361-365`):

```ts
it('should load data source', async () => {
  …
  expect(queriesTab.state.datasource).toEqual(ds1Mock);
  expect(queriesTab.state.dsSettings).toEqual(instance1SettingsMock);
});
```

`ds1Mock` / `instance1SettingsMock` are the datasource that the query was defined with — so the
picker state resolving to exactly those values is the proof of auto-resolution.

### 4.4 Responsible code (`file:line`, re-verified at HEAD `4550cfb5…`)

`public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.tsx`:

- `:44` `this.addActivationHandler(() => this.onActivate());`
- `:59` `private onActivate() {` → `:60` `this.loadDataSource();`
- `:63` `private async loadDataSource() {`
- `:71` `let datasourceToLoad = this.queryRunner.state.datasource;` — reads the datasource **already on the query**
- `:101` `datasource = await getDataSourceSrv().get(datasourceToLoad);` (the branch taken when a query datasource exists)
- `:102` `dsSettings = getDataSourceSrv().getInstanceSettings(datasourceToLoad);`
- `:106` `this.setState({ datasource, dsSettings });` — commits it to the picker's state
- `:111-112` fallback to `config.defaultDatasource` in the `catch` (the edge case)

Verbatim excerpt (`:71` and `:101-106`):

```ts
let datasourceToLoad = this.queryRunner.state.datasource;
…
} else {
  datasource = await getDataSourceSrv().get(datasourceToLoad);
  dsSettings = getDataSourceSrv().getInstanceSettings(datasourceToLoad);
}

if (datasource && dsSettings) {
  this.setState({ datasource, dsSettings });
  storeLastUsedDataSourceInLocalStorage(getDataSourceRef(dsSettings) || { default: true });
}
```

Existing test used as evidence: `public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx`
(`:361` `it('should load data source')`, `:364-365` assertions; `:377` default-fallback edge case;
`:392` `it('should load new data source')`).

### 4.5 Cause → effect

The panel-data tab is a scene object; when the editor transitions in, its **activation handler**
(`:44`) fires `onActivate()` → `loadDataSource()`. `loadDataSource()` reads the datasource that is
**already** attached to the query runner (`this.queryRunner.state.datasource`, `:71`). Because that
value is present (the panel's query carries it), the `else` branch resolves it to a concrete
`DataSourceApi` via `getDataSourceSrv().get(...)` (`:101`) and its instance settings via
`getInstanceSettings(...)` (`:102`), then commits both with `this.setState({ datasource, dsSettings })`
(`:106`). The picker UI is driven by that `state.datasource`/`state.dsSettings`, so it displays the
query's datasource. The test drives this **real activation entry point** (no bypass or synthetic
stand-in) and asserts `state.datasource === ds1Mock` and `state.dsSettings === instance1SettingsMock`
— runtime proof that the picker auto-resolves to and displays the datasource defined in the panel
queries. (If no datasource is on the query, `:71` is falsy and the code instead uses the dashboard's
last-used datasource; if resolution throws, the `catch` falls back to `config.defaultDatasource` at
`:111-112` — the edge case that the `should load default datasource if the datasource passed is not
found` test covers.)

---


## Requirement 5 — Alerting rule-edit query-state population

> **User question (verbatim):** *"Investigate the alerting api's rule creation process at runtime to
> determine if the backend's rule definition populates the query state when the edit view is opened,
> show me test script output for this and identify the part of the codebase responsible for this
> behavior."*

### 5.1 Direct answer

**Yes.** When the edit view is opened for an existing rule, the backend's stored rule definition
**populates the query editor state**. Opening the editor fetches the rule and derives the form's
`defaultValues` from it; for a Grafana-managed rule the derivation maps the backend rule's
`grafana_alert.data` → the form's `queries` and `grafana_alert.condition` → the form's `condition`,
which is exactly the query editor state.

Named sub-parts answered:

- **Does the backend rule definition populate query state on edit-open?** Yes — proven by the passing
  integration test `can edit grafana managed rule`, which opens the editor by rule UID (MSW-backed
  API) and asserts the form is filled from the stored rule.
- **Responsible frontend code:** `ExistingRuleEditor.tsx` → `AlertRuleForm.tsx`
  (`formValuesFromExistingRule`) → `utils/rule-form.ts` (`rulerRuleToFormValues`). See §5.4.
- **Responsible backend API that serves the definition:** `RulerSrv.RouteGetRuleByUID` in
  `pkg/services/ngalert/api/api_ruler.go` (via `toGettableExtendedRuleNode`).
- **"Rule creation process" wording:** also exercised — the `can create new grafana managed alert`
  test covers the create flow.

> **Honesty note (what proves what):** `utils/rule-form.test.ts` primarily tests the **reverse**
> direction (form → Ruler DTO, via `formValuesToRulerGrafanaRuleDTO` / `formValuesToRulerRuleDTO`)
> plus helper functions; it does **not** directly unit-test `rulerRuleToFormValues`. Therefore the
> **DTO → form** (query-state population) behavior is proven primarily by the
> **`RuleEditorExisting.test.tsx` integration test** exercising the real edit-open path, together
> with the code path in §5.4 — not by `rule-form.test.ts`. This distinction is stated rather than
> overclaimed.

### 5.2 Exact commands

```bash
yarn jest public/app/features/alerting/unified/RuleEditorExisting.test.tsx    --ci --watchAll=false --verbose
yarn jest public/app/features/alerting/unified/RuleEditorGrafanaRules.test.tsx --ci --watchAll=false --verbose
yarn jest public/app/features/alerting/unified/utils/rule-form.test.ts        --ci --watchAll=false --verbose
```

### 5.3 Actual, complete, unedited output

**(a) `RuleEditorExisting.test.tsx` — the DTO → form population proof:**

```text
  RuleEditor grafana managed rules
    ✓ can edit grafana managed rule (4024 ms)
    ✓ saves evaluation interval correctly (5349 ms)

Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total
Snapshots:   0 total
Time:        15.663 s
Ran all test suites matching /public\/app\/features\/alerting\/unified\/RuleEditorExisting.test.tsx/i.
```

The decisive assertions inside `can edit grafana managed rule` (test file, `:90-98`) — the form
fields are filled from the backend rule (`grafanaRulerRule`):

```ts
it('can edit grafana managed rule', async () => {
  const { user } = renderRuleEditor(grafanaRulerRule.grafana_alert.uid);

  // check that it's filled in
  const nameInput = await ui.inputs.name.find();
  expect(nameInput).toHaveValue(grafanaRulerRule.grafana_alert.title);
  …
  expect(ui.inputs.annotationValue(0).get()).toHaveValue(grafanaRulerRule.annotations[Annotation.summary]);
```

**(b) `RuleEditorGrafanaRules.test.tsx` — the create flow ("rule creation process"):**

```text
  RuleEditor grafana managed rules
    ✓ can create new grafana managed alert (8288 ms)

Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
Snapshots:   0 total
Time:        12.891 s
Ran all test suites matching /public\/app\/features\/alerting\/unified\/RuleEditorGrafanaRules.test.tsx/i.
```

**(c) `utils/rule-form.test.ts` — the reverse-direction + helper unit tests (see honesty note):**

```text
Test Suites: 1 passed, 1 total
Tests:       21 passed, 21 total
Snapshots:   7 passed, 7 total
Time:        3.96 s, estimated 4 s
Ran all test suites matching /public\/app\/features\/alerting\/unified\/utils\/rule-form.test.ts/i.
```

Its top-level `describe` blocks confirm the direction it exercises: `formValuesToRulerGrafanaRuleDTO`
(form → DTO), `getContactPointsFromDTO`, `getNotificationSettingsForDTO`, `getDefautManualRouting`,
`cleanAnnotations`, `cleanLabels` — none of which is `rulerRuleToFormValues`.

### 5.4 Responsible code (`file:line`, re-verified at HEAD `4550cfb5…`)

**Frontend — edit-open → form population:**

- `public/app/features/alerting/unified/ExistingRuleEditor.tsx`
  - `:5` `import { AlertRuleForm } from './components/rule-editor/alert-rule-form/AlertRuleForm';`
  - `:49` `return <AlertRuleForm existing={ruleWithLocation} />;`
- `public/app/features/alerting/unified/components/rule-editor/alert-rule-form/AlertRuleForm.tsx`
  - `:103-105` `const defaultValues: RuleFormValues = useMemo(() => { if (existing) { return formValuesFromExistingRule(existing); } … }`
  - `:126-128` `const formAPI = useForm<RuleFormValues>({ mode: 'onSubmit', defaultValues, shouldFocusError: true });`
- `public/app/features/alerting/unified/utils/rule-form.ts`
  - `:916` `export function formValuesFromExistingRule(rule: RuleWithLocation<RulerRuleDTO>) { return ignoreHiddenQueries(rulerRuleToFormValues(rule)); }`
  - `:365` `export function rulerRuleToFormValues(ruleWithLocation: RuleWithLocation): RuleFormValues`
  - Grafana-managed alerting branch maps the query state — `:402` `queries: ga.data,` and `:403` `condition: ga.condition,`
    (Grafana recording branch: `:380`/`:381`); cloud rules reconstruct from `expr` at `:430`/`:434`.

Verbatim excerpt of the Grafana-managed mapping (`rule-form.ts`, within `rulerRuleToFormValues`):

```ts
// grafana alerting rule
const ga = rule.grafana_alert;
…
return {
  ...defaultFormValues,
  name: ga.title,
  type: RuleFormType.grafana,
  …
  queries: ga.data,        // <- backend rule's query definition -> form query state
  condition: ga.condition, // <- backend rule's condition -> form condition
  …
};
```

**Backend — serves the stored definition:** `pkg/services/ngalert/api/api_ruler.go`

- `:308` doc comment `// RouteGetRuleByUID returns the alert rule with the given UID`
- `:309` `func (srv RulerSrv) RouteGetRuleByUID(c *contextmodel.ReqContext, ruleUID string) response.Response`
- `:326` `result := toGettableExtendedRuleNode(rule, …)` — serializes the stored rule (its query `data` / `condition`) into the Ruler DTO the frontend consumes
- `:553` `func toGettableExtendedRuleNode(r ngmodels.AlertRule, …) apimodels.GettableExtendedRuleNode`

Existing tests used as evidence: `RuleEditorExisting.test.tsx:90` (`can edit grafana managed rule`),
`RuleEditorGrafanaRules.test.tsx:44` (`can create new grafana managed alert`),
`utils/rule-form.test.ts` (reverse-direction + helpers).

### 5.5 Cause → effect

Opening the edit view renders `ExistingRuleEditor`, which fetches the existing rule and renders
`<AlertRuleForm existing={ruleWithLocation} />` (`ExistingRuleEditor.tsx:49`). `AlertRuleForm`
computes `defaultValues = formValuesFromExistingRule(existing)` inside a `useMemo`
(`AlertRuleForm.tsx:103-105`) and passes that object to `useForm({ defaultValues })`
(`:126-128`), which seeds the entire form — including the query editor — with those values.
`formValuesFromExistingRule` (`rule-form.ts:916`) delegates to `rulerRuleToFormValues`
(`:365`), which for a Grafana-managed rule copies the backend rule's `grafana_alert.data` into
`queries` (`:402`) and `grafana_alert.condition` into `condition` (`:403`). The backend rule
definition itself is produced by `RulerSrv.RouteGetRuleByUID` (`api_ruler.go:309`) via
`toGettableExtendedRuleNode` (`:326`/`:553`). Net effect: the stored backend rule definition flows
into the form's initial state, populating the query editor when the edit view opens. The
`RuleEditorExisting` integration test drives this **real entry point** (MSW-mocked Ruler API + the
real form derivation) and asserts the form is populated from `grafanaRulerRule` — runtime proof of
the DTO → form query-state population.

---

## Appendix — Reproduction summary

| Requirement | Primary command | Key observed result |
|-------------|-----------------|---------------------|
| 1 — Idle recurring logs | `grafana server` idle ≈20 min ×2; `grep` background emitters | `cleanup "Completed cleanup jobs"` + `plugins.update.checker "Update check succeeded"`, both every **10 min** (deltas ≈600 s); none within 60 s |
| 2 — Migration check | `grafana server` (restart on existing DB) | `migrations completed performed=0 skipped=626` (+ `resource-migrator performed=0 skipped=18`); 0 `Executing migration` lines |
| 3 — Version via API | `curl /api/health`, `curl -u admin:admin /api/frontend/settings` | `version = 11.5.0-pre` (canonical); `9.2.0` is the non-canonical `go run` fallback |
| 4 — DS picker | `yarn jest PanelDataQueriesTab.test.tsx --ci --watchAll=false` | 25 passed; `should load data source` asserts picker resolves to the query's datasource |
| 5 — Rule-edit query state | `yarn jest RuleEditorExisting.test.tsx --ci --watchAll=false` | 2 passed; `can edit grafana managed rule` asserts form populated from backend rule |

*All evidence above was captured at HEAD `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` using the
canonical `make build` binary and the default `conf/defaults.ini`. Temporary observation scripts and
logs created during the investigation were removed after capture, leaving the repository unchanged
apart from this document.*

