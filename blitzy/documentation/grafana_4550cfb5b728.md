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
# 2) compile the server to a path OUTSIDE the repo tree (workspace ON, CGO ON for the SQLite driver)
CGO_ENABLED=1 go build -o /tmp/grafana-blitzy/bin/grafana ./pkg/cmd/grafana
```

The binary is written to **`/tmp/grafana-blitzy/bin/grafana`, outside the repository tree**, and `pkg/server/wire_gen.go` is git‑ignored (`.gitignore:194`) and is removed after capture — so neither dirties the working tree. (Compiling instead to `./bin/grafana` would also be clean, since `/bin/*` is git‑ignored at `.gitignore:73`; the `/tmp` location is used here so that *nothing whatsoever* is written inside the repository tree.)

### Backend run (isolated — the repository is never written to)

All writable paths are redirected outside the repository, the port is fixed to `3010`, and logs go to stdout. These are the **exact commands run** (no placeholders). The binary path and the `--homepath` value are the concrete paths used in this investigation:

- `BIN  = /tmp/grafana-blitzy/bin/grafana` (the binary compiled above, outside the tree)
- `REPO = /tmp/blitzy/grafana/blitzy-202fc7b9-dc8a-44db-8cd4-0a229a947c6a_42d862` (the repository root, i.e. `$(pwd)`, passed verbatim as `--homepath`)

```bash
# Run A — FRESH (empty) database, DEBUG level, idle 130 s, ZERO requests:
env GF_PATHS_DATA=/tmp/grafana-blitzy/data \
    GF_PATHS_LOGS=/tmp/grafana-blitzy/logs \
    GF_PATHS_PLUGINS=/tmp/grafana-blitzy/plugins \
    GF_PATHS_PROVISIONING=/tmp/grafana-blitzy/prov \
    GF_SERVER_HTTP_PORT=3010 GF_LOG_MODE=console GF_LOG_LEVEL=debug \
    /tmp/grafana-blitzy/bin/grafana server \
    --homepath /tmp/blitzy/grafana/blitzy-202fc7b9-dc8a-44db-8cd4-0a229a947c6a_42d862 \
    > /tmp/grafana-blitzy/runA_debug.log 2>&1 &

# Run B — WARM (already-migrated) database reused, INFO level, idle 130 s, then curl:
env GF_PATHS_DATA=/tmp/grafana-blitzy/data \
    GF_PATHS_LOGS=/tmp/grafana-blitzy/logs \
    GF_PATHS_PLUGINS=/tmp/grafana-blitzy/plugins \
    GF_PATHS_PROVISIONING=/tmp/grafana-blitzy/prov \
    GF_SERVER_HTTP_PORT=3010 GF_LOG_MODE=console GF_LOG_LEVEL=info \
    /tmp/grafana-blitzy/bin/grafana server \
    --homepath /tmp/blitzy/grafana/blitzy-202fc7b9-dc8a-44db-8cd4-0a229a947c6a_42d862 \
    > /tmp/grafana-blitzy/runB_info.log 2>&1 &
```

Two runs were used to gather all backend evidence:

- **Run A** — a **fresh** (empty) SQLite database, `GF_LOG_LEVEL=debug`, left completely idle for **130 s** with **zero** user/API requests. It became ready ~4 s after launch (`HTTP Server Listen` at `t=2026-07-01T05:20:09.814Z`).
- **Run B** — the **already‑migrated** database from Run A reused, `GF_LOG_LEVEL=info`, left idle for **130 s** with zero requests, after which `curl -i /api/health` and `curl /api/frontend/settings` were issued.

Both idle windows comfortably exceed the ≥ 60 s the questions specify; 130 s was chosen so each window also spans the usage‑stats readiness delay (a random 30–120 s, see Q1) and captures that one‑time line.

### Frontend tests

The **generic** jest invocation is shown below as a template; the **concrete, evidence‑producing** commands (with the real spec paths and their full output) appear in Q4 and Q5:

```bash
CI=true yarn jest <specPath> --ci --watchAll=false [--verbose]
```

### Read‑only guarantee

The **only** repository write is this document. The compiled binary (`/tmp/grafana-blitzy/bin/grafana`), the isolated SQLite data directory, and all captured logs live under `/tmp` (outside the tree); the generated `pkg/server/wire_gen.go` is git‑ignored (`.gitignore:194`) and was removed after capture; the one temporary observation script (the Q5 forward‑mapping spec, below) was deleted immediately after capture. At completion `git status --porcelain` shows only `blitzy/documentation/grafana_4550cfb5b728.md`.

### Known, harmless output noise (so the captured output is read correctly)

- A startup line **`logger=settings … level=error msg="Failed to detect generated javascript files in public/build"`** appears because the frontend assets were not built; it does **not** affect `/api/health` or backend logging. Likewise, with empty provisioning directories the server logs harmless `can't read … provisioning files from directory` errors, and a bundled plugin logs `Failed to install plugin … not compatible with your Grafana version: 9.2.0` — all expected noise in this isolated run.
- jest prints **`jest-haste-map: duplicate manual mock found: …`** warnings and a Node **`punycode` DeprecationWarning** — these are noise, not failures.
- `/api/frontend/settings` requires authentication (returns `401`); `/api/health` is the canonical **unauthenticated** version/build endpoint.

---

## Q1 — Idle server recurring logs

> **Question (verbatim):** *"After the server has been running for at least 60 seconds with no user requests, what are the exact recurring log entries that appear? Provide the actual log output as runtime evidence."*

### (a) Command that produced the evidence

```bash
# Run A: fresh DB, DEBUG, idle 130s (>=60s), ZERO requests, then stopped by pid (see the exact command in Environment above)
env GF_PATHS_DATA=/tmp/grafana-blitzy/data GF_PATHS_LOGS=/tmp/grafana-blitzy/logs \
    GF_PATHS_PLUGINS=/tmp/grafana-blitzy/plugins GF_PATHS_PROVISIONING=/tmp/grafana-blitzy/prov \
    GF_SERVER_HTTP_PORT=3010 GF_LOG_MODE=console GF_LOG_LEVEL=debug \
    /tmp/grafana-blitzy/bin/grafana server \
    --homepath /tmp/blitzy/grafana/blitzy-202fc7b9-dc8a-44db-8cd4-0a229a947c6a_42d862 \
    > /tmp/grafana-blitzy/runA_debug.log 2>&1 &   # left idle 130s, no user requests
# extract the recurring line:
grep "Alert rules fetched" /tmp/grafana-blitzy/runA_debug.log
```

### (b) Verbatim captured output

Two distinct recurring cadences appear while the server is idle (the steady state between `HTTP Server Listen` at `t=…05:20:09.814` and `Shutdown started` at `t=…05:22:20.786`, ≈ 131 s). Both are DEBUG-level.

**Primary — every 10 s: the alerting scheduler's rule-fetch line.** All 14 occurrences captured in the ≥ 60 s idle window (Run A, `GF_LOG_LEVEL=debug`):

```text
logger=ngalert.scheduler t=2026-07-01T05:20:10.129229957Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T05:20:20.001345845Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T05:20:30.00084328Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T05:20:40.00057025Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T05:20:50.000907967Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T05:21:00.000495509Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T05:21:10.000705857Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T05:21:20.000589842Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T05:21:30.000529674Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T05:21:40.000276929Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T05:21:50.000289182Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T05:22:00.001111095Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T05:22:10.000703814Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
logger=ngalert.scheduler t=2026-07-01T05:22:20.001220897Z level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
```

**Measured cadence** (deltas between consecutive timestamps): the first interval is `9.872 s` (the scheduler aligns its first tick to the wall-clock 10 s boundary), and every subsequent interval is `10.000 s` (±0.001 s) — i.e. **exactly every 10 seconds**, 14 lines across the ≥ 60 s idle window.

**Secondary — every 60 s: an aligned burst of maintenance ticks.** A cluster of background services shares a 1-minute cadence and fires together as one burst. In the idle window the cluster fired at `t=…05:21:09.813` and again at `t=…05:22:09.813` — exactly `60.000 s` apart. One complete burst, verbatim:

```text
logger=ssosettings.service t=2026-07-01T05:21:09.813411483Z level=debug msg="reloading SSO Settings for all providers"
logger=ngalert.multiorg.alertmanager t=2026-07-01T05:21:09.81341605Z level=debug msg="Synchronizing Alertmanagers for orgs"
logger=ngalert.sender.router t=2026-07-01T05:21:09.813575312Z level=debug msg="Attempting to sync admin configs" count=0
logger=ngalert.sender.router t=2026-07-01T05:21:09.813599364Z level=debug msg="Finish of admin configuration sync"
logger=ngalert.notifier.alertmanager org=1 t=2026-07-01T05:21:09.814077444Z level=debug msg="Config hasn't changed, skipping configuration sync."
logger=ngalert.multiorg.alertmanager t=2026-07-01T05:21:09.814233249Z level=debug msg="Done synchronizing Alertmanagers for orgs"
logger=ssosettings.service t=2026-07-01T05:21:09.814690179Z level=debug msg="No SSO Settings found in the database, using system settings"
logger=ssosettings.service t=2026-07-01T05:21:09.814709958Z level=debug msg="No SSO Settings found in the database, using system settings"
logger=ssosettings.service t=2026-07-01T05:21:09.81471732Z level=debug msg="No SSO Settings found in the database, using system settings"
logger=ssosettings.service t=2026-07-01T05:21:09.814732567Z level=debug msg="No SSO Settings found in the database, using system settings"
logger=ssosettings.service t=2026-07-01T05:21:09.814739292Z level=debug msg="No SSO Settings found in the database, using system settings"
logger=ssosettings.service t=2026-07-01T05:21:09.814745645Z level=debug msg="No SSO Settings found in the database, using system settings"
logger=ssosettings.service t=2026-07-01T05:21:09.814761702Z level=debug msg="No SSO Settings found in the database, using system settings"
```

Each cluster member therefore appears **twice** in the window (the SSO `"No SSO Settings found…"` line appears `2 × 7 = 14` times — one per configured provider, per burst). Grouping the recurring 60 s cluster by `(logger, msg)`:

```text
  2  logger=ssosettings.service           msg="reloading SSO Settings for all providers"
 14  logger=ssosettings.service           msg="No SSO Settings found in the database, using system settings"
  2  logger=ngalert.multiorg.alertmanager msg="Synchronizing Alertmanagers for orgs"
  2  logger=ngalert.multiorg.alertmanager msg="Done synchronizing Alertmanagers for orgs"
  2  logger=ngalert.sender.router         msg="Attempting to sync admin configs"
  2  logger=ngalert.sender.router         msg="Finish of admin configuration sync"
  2  logger=ngalert.notifier.alertmanager msg="Config hasn't changed, skipping configuration sync."
  2  logger=secrets                       msg="Removing expired data keys from cache..."
  2  logger=secrets                       msg="Removing expired data keys from cache finished successfully"
```

**One-time (not recurring): usage-stats readiness.** A single INFO readiness line appeared once:

```text
logger=infra.usagestats t=2026-07-01T05:21:47.814013990Z level=info msg="Usage stats are ready to report"
```

It appeared `+98.0 s` after `HTTP Server Listen`. This is **not** a fixed ~60 s signal: it is emitted once by `SetReadyToReport` after a randomised 30–120 s startup delay, so its offset varies run to run (Run B observed it at +34 s). It does not recur.

**Cleanup ticker does NOT recur in a 60 s window (F4).** The cleanup service's periodic job runs on a `time.NewTicker(time.Minute * 10)` — a **10-minute** period — so it cannot fire within a 60 s idle window. Confirmed empirically: across the entire 131 s run there were **zero** `"cleanup background job"` spans (`grep -c 'cleanup background job' → 0`). The only `logger=cleanup` output is three one-time startup lines from `cleanUpTmpFiles` (run once, before the ticker loop):

```text
logger=cleanup t=2026-07-01T05:20:09.812620715Z level=debug msg="Found old rendered file to delete" folder=/tmp/grafana-blitzy/data/png deleted=0 kept=0
logger=cleanup t=2026-07-01T05:20:09.812648193Z level=debug msg="Found old rendered file to delete" folder=/tmp/grafana-blitzy/data/csv deleted=0 kept=0
logger=cleanup t=2026-07-01T05:20:09.812672014Z level=debug msg="Found old rendered file to delete" folder=/tmp/grafana-blitzy/data/pdf deleted=0 kept=0
```

**At `GF_LOG_LEVEL=info` (Run B) the idle window is effectively silent.** Every recurring entry above is DEBUG, so at INFO none of them appear. After the startup-tail INFO lines settle (all within +0.5 s of `HTTP Server Listen`), nothing is logged until the one-time `"Usage stats are ready to report"` readiness line, after which the window stays silent through to shutdown. So at INFO an idle server produces no recurring lines.

### (c) Exact recurring entries (the values the question asks for)

Every **10 seconds** (primary; 14 lines in the window):

```text
logger=ngalert.scheduler … level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0
```

Every **60 seconds** (a single aligned burst of maintenance ticks), most prominently:

```text
logger=ssosettings.service           … level=debug msg="reloading SSO Settings for all providers"
logger=ngalert.sender.router         … level=debug msg="Attempting to sync admin configs" count=0
logger=ngalert.multiorg.alertmanager … level=debug msg="Synchronizing Alertmanagers for orgs"
logger=secrets                       … level=debug msg="Removing expired data keys from cache..."
```

At `GF_LOG_LEVEL=info` the idle window is silent apart from the one-time `"Usage stats are ready to report"` readiness line.

### (d) Responsible code (`file:line`)

- **Primary 10 s line** — `pkg/services/ngalert/schedule/fetcher.go:39`: `sch.log.Debug("Alert rules fetched", "rulesCount", len(q.ResultRules), "foldersCount", len(q.ResultFoldersTitles), "updatedRules", len(d.updated))`. Cadence from `pkg/setting/setting_unified_alerting.go:62` — `SchedulerBaseInterval = 10 * time.Second`.
- **60 s SSO reload burst** — interval `pkg/setting/setting.go:1662`: `cfg.SSOSettingsReloadInterval = ssoSettings.Key("reload_interval").MustDuration(1 * time.Minute)`; ticker `pkg/services/ssosettings/ssosettingsimpl/service.go:368` (`time.NewTicker(interval)`); log lines `:384` (`"reloading SSO Settings for all providers"`) and `:414` (`"No SSO Settings found in the database, using system settings"`, one per provider).
- **60 s admin-config sync** — default interval `pkg/setting/setting_unified_alerting.go:50` (`schedulerDefaultAdminConfigPollInterval = time.Minute`); log `pkg/services/ngalert/sender/router.go:90` (`"Attempting to sync admin configs"`); ticker `pkg/services/ngalert/sender/router.go:384` (`case <-time.After(d.adminConfigPollInterval)`).
- **60 s Alertmanager sync** — default interval `pkg/setting/setting_unified_alerting.go:24` (`alertmanagerDefaultConfigPollInterval = time.Minute`); log `pkg/services/ngalert/notifier/multiorg_alertmanager.go:255` (`"Synchronizing Alertmanagers for orgs"`); ticker `pkg/services/ngalert/notifier/multiorg_alertmanager.go:246` (`case <-time.After(moa.settings.UnifiedAlerting.AlertmanagerConfigPollInterval)`).
- **One-time readiness INFO line** — `pkg/infra/usagestats/service/service.go:117`: `uss.log.Info("Usage stats are ready to report")` (inside `SetReadyToReport`, `:116`); the report send-interval is separately clamped to ≥ 1 minute at `:72-73`, and the randomised 30–120 s readiness delay is set in the stats collector.
- **Cleanup ticker (does not recur in 60 s) — F4** — `pkg/services/cleanup/cleanup.go:80`: `ticker := time.NewTicker(time.Minute * 10)` inside `Run` (`:77`); the periodic job `srv.clean(ctx)` (`:84`) opens the `"cleanup background job"` span (`:94`). The three one-time startup lines come from `srv.cleanUpTmpFiles(ctx)` (`:78`), called once before the loop. A 10-minute period cannot elapse within a 60 s idle window.
- **Origin of all idle background activity** — `pkg/server/server.go` — `func (s *Server) Run()` launches the 60+ background services via an `errgroup`; the recurring tickers above live inside those services.

### (e) Reasoning

With no alert rules configured and no user traffic, an idle Grafana server still runs its periodic background tickers, which produce two DEBUG cadences. The **10-second** cadence is the ngalert scheduler: on every `SchedulerBaseInterval` tick the rule fetcher logs `"Alert rules fetched"` with `rulesCount=0`; the measured 10.000 s spacing across 14 consecutive lines matches that constant exactly, making it the most frequent recurring idle entry. A **60-second** cadence is produced by a cluster of maintenance services that each default to a 1-minute interval (SSO settings reload, ngalert admin-config sync, multi-org Alertmanager sync, and the secrets key-cache sweep); because they were all started together at boot, they fire as a single aligned burst every 60 s (observed at `05:21:09.813` and `05:22:09.813`, exactly 60.000 s apart). Everything else in the window is one-time startup/readiness output — notably `"Usage stats are ready to report"`, which fires once after a randomised 30–120 s delay and does not recur. The cleanup service's 10-minute ticker (F4) never fires inside a 60 s window, which is why only its three one-time startup `cleanUpTmpFiles` lines appear. At `GF_LOG_LEVEL=info` every one of these recurring lines is suppressed (they are all DEBUG), so the idle INFO window is silent apart from the single usage-stats readiness line.

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
logger=migrator t=2026-07-01T05:20:07.843033056Z level=info msg="Starting DB migrations"
logger=migrator t=2026-07-01T05:20:07.843283063Z level=info msg="Executing migration" id="create migration_log table"
logger=migrator t=2026-07-01T05:20:07.843499743Z level=info msg="Migration successfully executed" id="create migration_log table" duration=216.58µs
... (further "Executing migration" / "Migration successfully executed" INFO lines — see the exact counts below) ...
logger=migrator t=2026-07-01T05:20:09.601882192Z level=info msg="migrations completed" performed=626 skipped=0 duration=1.758618574s
logger=resource-migrator t=2026-07-01T05:20:09.809716948Z level=info msg="migrations completed" performed=18 skipped=0 duration=48.329915ms
```

(The fresh run logged **644** `Executing migration` and **641** `Migration successfully executed` INFO lines across the `migrator` and `resource-migrator` combined — `migrator` alone: 626 `Executing migration`, 623 `Migration successfully executed`. The 3‑line gap is exactly 3 condition‑skipped migrations that instead log `Skipping migration: Already executed, but not recorded in migration log` at `migrator.go:371`; `migrationsPerformed` is still incremented for them at `migrator.go:282`, so `performed=626` holds.)

**Pass 2 (warm DB — schema already up to date).** Re‑running against the same data directory, the migrator performs **zero** migrations — no `Executing migration` lines at all — and the summary reports `performed=0`:

```text
logger=migrator t=2026-07-01T05:24:21.989874886Z level=info msg="migrations completed" performed=0 skipped=626 duration=711.216µs
logger=resource-migrator t=2026-07-01T05:24:22.207935943Z level=info msg="migrations completed" performed=0 skipped=18 duration=43.474µs
```

Side‑by‑side, the contrast is the signal:

| Run | `migrations completed` (migrator) |
|-----|-----------------------------------|
| Fresh DB | `performed=626 skipped=0 duration=1.758618574s` |
| **Warm DB (up to date)** | **`performed=0 skipped=626 duration=711.216µs`** |

### (c) Exact confirming output (the value the question asks for)

```text
logger=migrator … level=info msg="migrations completed" performed=0 skipped=626 duration=711.216µs
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
curl -sS -i http://localhost:3010/api/health
```

### (b) Verbatim captured output (status line + headers + body)

```http
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json; charset=UTF-8
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Wed, 01 Jul 2026 05:26:32 GMT
Content-Length: 62

{
  "database": "ok",
  "version": "9.2.0",
  "commit": "NA"
}
```

Corroborating startup log line (both runs carry the same version attribute; shown from Run B):

```text
logger=settings t=2026-07-01T05:24:21.980766442Z level=info msg="Starting Grafana" version=9.2.0 commit=NA branch=main compiled=2026-07-01T05:24:21Z
```

And the binary's own report:

```text
$ /tmp/grafana-blitzy/bin/grafana --version
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

`apiHealthHandler` builds a `healthResponse`, and — because version display is not hidden — sets `data.Version = hs.Cfg.BuildVersion` (`http_server.go:720`) before serializing with `json.MarshalIndent` (`:736`). `hs.Cfg.BuildVersion` traces back to the compiled‑in constant `var version = "9.2.0"` (`main.go:17`). This checkout is Grafana **`11.5.0-pre`** per `package.json`, but because the binary was produced by a plain `go build` with **no** ldflags, the source default `9.2.0` is what is compiled in — hence the API, the startup log, and `/tmp/grafana-blitzy/bin/grafana --version` all agree on **`9.2.0`**. An official release build would inject `11.5.0-pre` via the ldflags at `build/cmd.go:247`. The reported value therefore reflects *this specific build*, exactly as required.

---


## Q4 — Dashboard‑scene datasource picker (view → panel‑editor transition)

> **Question (verbatim):** *"Investigate its initialization logic during the transition from the dashboard view to the panel editor. Specifically, provide test script outputs to prove whether the picker automatically resolves to and displays the datasource already defined in the panel queries. Tell me which part of the codebase is responsible for this."*

### (a) Command that produced the evidence

```bash
CI=true yarn jest public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx \
  --ci --watchAll=false --verbose
```

### (b) Verbatim captured output (jest)

```text
... (leading jest-haste-map "duplicate manual mock" warnings and a Node punycode DeprecationWarning omitted — see "Known, harmless output noise" above; no failures) ...
PASS public/app/features/dashboard-scene/panel-edit/PanelDataPane/PanelDataQueriesTab.test.tsx
  PanelDataQueriesTab
    Adding queries
      ✓ can add a new query (28 ms)
      ✓ Can add a new query when datasource is mixed (7 ms)
    PanelDataQueriesTab
      ✓ renders query group top section (100 ms)
      ✓ renders queries rows when queries are set (65 ms)
      ✓ allow to add a new query when user clicks on add new (129 ms)
      ✓ allow to remove a query when user clicks on remove (418 ms)
    query options
      activation
        ✓ should load data source (5 ms)
        ✓ should store loaded data source in local storage (5 ms)
        ✓ should load default datasource if the datasource passed is not found (7 ms)
      data source change
        ✓ should load new data source (6 ms)
        ✓ changing from one plugin to another (4 ms)
        ✓ changing from a plugin to a dashboard data source (4 ms)
        ✓ changing from dashboard data source to a plugin (5 ms)
      query options change
        time overrides
          ✓ should create PanelTimeRange object (5 ms)
          ✓ should update hoverHeader (4 ms)
          ✓ should update PanelTimeRange object on time options update (5 ms)
          ✓ should remove PanelTimeRange object on time options cleared (5 ms)
        max data points and interval
          ✓ should update max data points (6 ms)
          ✓ should update min interval (5 ms)
          ✓ should update min interval to undefined if empty input (4 ms)
        query caching
          ✓ updates cacheTimeout and queryCachingTTL (8 ms)
      query inspection
        ✓ allows query inspection from the tab (5 ms)
      change queries
        plugin queries
          ✓ should update queries (4 ms)
        dashboard queries
          ✓ should update queries (4 ms)
          ✓ should load last used data source if no data source specified for a panel (4 ms)

Test Suites: 1 passed, 1 total
Tests:       25 passed, 25 total
Snapshots:   0 total
Time:        4.869 s
Ran all test suites matching /public\/app\/features\/dashboard-scene\/panel-edit\/PanelDataPane\/PanelDataQueriesTab.test.tsx/i.
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

**(1) Committed spec — _supporting_ module/runtime evidence.** The committed `rule-form.test.ts` does **not** itself call `formValuesFromExistingRule` or `rulerRuleToFormValues` (confirmed: neither identifier appears in the spec). It imports and exercises the *reverse* mapping `formValuesToRulerGrafanaRuleDTO` and sibling helpers (`getContactPointsFromDTO`, `getNotificationSettingsForDTO`, `getDefautManualRouting`, `cleanAnnotations`, `cleanLabels`). It therefore proves the mapping **module compiles, loads, and passes at runtime**, but it is *supporting* evidence — **not** the direct proof of the edit‑view query‑state behavior:

```bash
CI=true yarn jest public/app/features/alerting/unified/utils/rule-form.test.ts --ci --watchAll=false
```

**(2) Temporary observation spec — the _direct_ behavior proof.** Because the committed spec does not cover it, this temporary spec directly exercises the *forward* mapping (backend rule → form values) — i.e. it actually calls `formValuesFromExistingRule`/`rulerRuleToFormValues` and asserts the query state is carried through. It was **deleted** afterward (read‑only guarantee). It was written to `public/app/features/alerting/unified/utils/blitzy_adhoc_test_ruleFormEdit.test.ts`:

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
Snapshots:   7 passed, 7 total
Time:        4.199 s, estimated 17 s
Ran all test suites matching /public\/app\/features\/alerting\/unified\/utils\/rule-form.test.ts/i.
```

**Temporary forward‑mapping spec (direct proof):**

```text
PASS public/app/features/alerting/unified/utils/blitzy_adhoc_test_ruleFormEdit.test.ts
  Q5 — edit view populates query state from backend rule definition
    ✓ rulerRuleToFormValues maps queries<-grafana_alert.data and condition<-grafana_alert.condition (rule-form.ts:402-403) (4 ms)
    ✓ formValuesFromExistingRule (edit entry used by AlertRuleForm.tsx:105) carries the query state through (2 ms)

Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total
Snapshots:   0 total
Time:        4.179 s
Ran all test suites matching /public\/app\/features\/alerting\/unified\/utils\/blitzy_adhoc_test_ruleFormEdit.test.ts/i.
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
| Q1 | Idle recurring log entries (≥60 s) | Primary: `logger=ngalert.scheduler … level=debug msg="Alert rules fetched" rulesCount=0 foldersCount=0 updatedRules=0`, **every 10.000 s** (14× in ~131 s). Secondary: a **60 s** DEBUG maintenance burst (SSO reload, admin‑config sync, Alertmanager sync, secrets cache sweep). The cleanup ticker (10‑min) does **not** recur in a 60 s window. At INFO the idle window is silent apart from the one‑time `"Usage stats are ready to report"`. | `fetcher.go:39`; cadence `setting_unified_alerting.go:62`; 60 s: `setting.go:1662`, `setting_unified_alerting.go:50/24`; cleanup `cleanup.go:80` |
| Q2 | Output confirming schema up to date | `msg="migrations completed" performed=0 skipped=626 duration=711.216µs` — **`performed=0`** | `migrator.go:287` |
| Q3 | Exact `version` from the API | `"version": "9.2.0"` (from `GET /api/health`, `HTTP/1.1 200 OK`) | `http_server.go:720` (`data.Version = hs.Cfg.BuildVersion`); default `main.go:17` |
| Q4 | Does the picker auto‑resolve to the panel‑query datasource? | **YES** — proven by `✓ should load data source` (25/25 passed) | `PanelDataQueriesTab.loadDataSource()` `PanelDataQueriesTab.tsx:63/71/106`, reached via `PanelEditor.tsx:205` → `PanelDataPane.tsx:35` |
| Q5 | Does the backend rule definition populate edit‑view query state? | **YES** — `queries ← grafana_alert.data`, `condition ← grafana_alert.condition` (2/2 direct proof; committed 21/21) | `formValuesFromExistingRule` `rule-form.ts:916` → `rulerRuleToFormValues` `:365` (`:402-403`), via `AlertRuleForm.tsx:103-105` |

---

## Coverage pass (every sub‑part addressed)

| Q | Distinct sub‑part the question asks for | Where answered | Verdict |
|---|------------------------------------------|----------------|---------|
| **Q1** | (i) the *exact* recurring log entries | Q1 (b)/(c): primary `ngalert.scheduler "Alert rules fetched"` (10 s) + the 60 s maintenance burst, both verbatim | ✔ |
| | (ii) actual runtime log output as evidence | Q1 (b): 14 verbatim timestamped `Alert rules fetched` lines + a full 60 s burst from `runA_debug.log` | ✔ |
| | (iii) the ≥60 s idle, "no user requests" condition honored | Environment + Q1 (a): fresh run idled **~131 s** (≥ 60 s), zero requests | ✔ |
| | (iv) cadence + responsible code | Q1 (b) measured **10.000 s** (primary) and **60.000 s** (secondary cluster); (d) `fetcher.go:39`, `setting_unified_alerting.go:62`, plus 60 s + cleanup refs | ✔ |
| | (v) cleanup ticker note (F4) | Q1 (b)/(d): `cleanup.go:80` `time.NewTicker(time.Minute * 10)` — 10‑min period, 0 `"cleanup background job"` spans in 131 s | ✔ |
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
- Q1's `"Usage stats are ready to report"` timing (observed **+98 s** in Run A, **+34 s** in Run B, relative to `HTTP Server Listen`) is a one‑time readiness signal (`service.go:117`, `SetReadyToReport`) fired after a **randomised 30–120 s** startup delay, **not** a fixed‑cadence recurrence, so its exact offset varies between runs.
- Q4/Q5 behaviors are proven with jest (the "test script output" the questions request), which exercises the responsible modules directly; they were not additionally reproduced through a live browser session.

---

*End of document. This file (`blitzy/documentation/grafana_4550cfb5b728.md`) is the sole repository change; all build/run/test artifacts and temporary scripts were kept outside the tree or removed.*

