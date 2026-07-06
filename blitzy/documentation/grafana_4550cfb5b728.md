# Grafana Clean‑Start Behavior — An Execution‑Grounded Investigation

## What this document answers

A new team member ran the Grafana server for the first time from a **completely clean
state** — no `conf/custom.ini`, no `GF_*` environment variables, no CLI overrides — and was
surprised by automatic, unexplained startup behavior that the `README.md` and
`contribute/developer-guide.md` did not lead them to expect (credentials that “appeared”,
subsystems that logged *disabled*/*skipped* while others reported *success*, plugins that were
present without being installed, and state written to disk on its own).

This document explains **what Grafana actually does on that first launch, and why**, answering
seven objectives explicitly and by name:

- **O1** — Fresh‑start defaults & config precedence
- **O2** — “disabled/skipped” vs “success” logs
- **O3** — Persistent state, its location, and first‑run vs subsequent‑run
- **O4** — Actual security posture (the “credentials I never set up” puzzle)
- **O5** — Default‑enabled vs opt‑in API features
- **O6** — Plugin/data‑source bootstrap (bundled vs disk‑discovered vs remote)
- **O7** — Build/generated‑file dependency

Every claim below is backed by **real, unedited output** captured by actually building and
running Grafana, followed by a **`file:line` citation** to the code that produces the behavior.
Anything not directly observed is explicitly labeled **inferred**.

---

## Exact commit, branch, build, and invocation

| Item | Value |
|------|-------|
| Repository | `github.com/grafana/grafana` (monorepo: Go backend + TS/React frontend) |
| Commit (HEAD) | `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` |
| Source branch (deliverable name) | `grafana_4550cfb5b728` |
| Toolchain | Go `1.23.1` (`go.mod:L3`), Node `v22.16.0`, Yarn `4.5.3`, GCC `15.2.0`, `sqlite3` `3.46.1`, `CGO_ENABLED=1` |

**Build foundation (generated file + frontend assets — themselves O7 evidence):**

```bash
make gen-go          # generates pkg/server/wire_gen.go (Google Wire DI graph)
yarn install --immutable && yarn build   # produces public/build (frontend assets)
```

**Canonical clean invocation actually exercised (the real entry point):**

```bash
export CGO_ENABLED=1
go run ./pkg/cmd/grafana server \
  --homepath "$PWD" \
  cfg:paths.data=/tmp/gf-clean-home/data \
  cfg:paths.logs=/tmp/gf-clean-home/log
```

> The only CLI arguments used are `--homepath` (so `conf/defaults.ini` resolves) and a
> **redirection of `paths.data`/`paths.logs` into `/tmp`** to keep the repository working tree
> byte‑for‑byte unchanged. Those two keys hold the **same default *values*** as
> `conf/defaults.ini`, just rooted under a throwaway `/tmp` directory. **No** `custom.ini`,
> **no** `GF_*` variables, and **no** change to `app_mode` were used. This is the default,
> canonical OSS configuration.

**Reported version banner (observed):**

```text
grafana version 9.2.0
```

> ⚠️ **`9.2.0` is NON‑CANONICAL (unstamped dev build).** It is the hard‑coded fallback in
> `pkg/cmd/grafana/main.go:L17` (`var version = "9.2.0"`), which the comment at
> `pkg/cmd/grafana/main.go:L16` says is meant to be overridden at real build time via `-X`
> linker flags. A `go run` (or a plain `go build`) that does not pass those flags leaves the
> fallback in place, so `9.2.0` is **not** the release version — it is the placeholder emitted
> by an unstamped build. The startup banner likewise shows `commit=NA branch=main`.

**Execution note.** All values in this document were captured by real execution inside the
provided environment (Go 1.23.1 + GCC, equivalent to the Docker image
`andrewparkscaleai/coding-agent:grafana__grafana__4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`).
Each observation was re‑run at least twice (a second run against the same data directory, and a
third run against a fresh data directory) and the values were **stable** across runs. Temporary
scripts and throwaway data directories lived only under `/tmp` and were deleted afterward,
leaving the repository unchanged.

---

## O1 — Fresh‑start defaults & config precedence

### O1 · Direct answer

With **zero** user configuration, Grafana resolves every setting from a single shipped baseline
file, `conf/defaults.ini`, and then applies overrides in a fixed precedence order. Because that
baseline is complete, the server starts successfully with nothing configured. The concrete
resolved defaults include:

| Setting | Default value | `conf/defaults.ini` |
|---------|---------------|---------------------|
| `app_mode` | `production` | `:L7` |
| `[paths] data` | `data` | `:L15` |
| `[paths] logs` | `data/log` | `:L21` |
| `[paths] plugins` | `data/plugins` | `:L24` |
| `[paths] provisioning` | `conf/provisioning` | `:L27` |
| `[server] protocol` | `http` | `:L32` |
| `[server] http_port` | `3000` | `:L41` |
| `[server] domain` | `localhost` | `:L44` |
| `[server] static_root_path` | `public` | `:L60` |
| `[database] type` | `sqlite3` | `:L123` |
| `[database] path` | `grafana.db` | `:L164` |

The **config‑resolution precedence** (lowest → highest) is:

1. `conf/defaults.ini` (the shipped baseline; always loaded)
2. `conf/custom.ini` (absent on a clean start → silently skipped)
3. `GF_*` environment variables (none set)
4. CLI `cfg:` properties (only my two `paths.*` redirections)

### O1 · Evidence

The startup log proves the baseline is loaded from `conf/defaults.ini`, that the **only** two
overrides are my `paths.*` redirections, and that the effective mode is `production`:

```text
Grafana server is running with elevated privileges. This is not recommended
logger=settings t=2026-07-06T22:18:22.680780619Z level=info msg="Starting Grafana" version=9.2.0 commit=NA branch=main compiled=2026-07-06T22:18:22Z
logger=settings t=2026-07-06T22:18:22.681076704Z level=info msg="Config loaded from" file=/tmp/blitzy/grafana/blitzy-dc74cc50-4c41-4fe8-8bd2-75a8df865634_4216d2/conf/defaults.ini
logger=settings t=2026-07-06T22:18:22.68108558Z level=info msg="Config overridden from command line" arg="paths.data=/tmp/gf-clean-home/data"
logger=settings t=2026-07-06T22:18:22.681090264Z level=info msg="Config overridden from command line" arg="paths.logs=/tmp/gf-clean-home/log"
logger=settings t=2026-07-06T22:18:22.681094689Z level=info msg=Target target=[all]
logger=settings t=2026-07-06T22:18:22.681104534Z level=info msg="Path Home" path=/tmp/blitzy/grafana/blitzy-dc74cc50-4c41-4fe8-8bd2-75a8df865634_4216d2
logger=settings t=2026-07-06T22:18:22.681109411Z level=info msg="Path Data" path=/tmp/gf-clean-home/data
logger=settings t=2026-07-06T22:18:22.681113818Z level=info msg="Path Logs" path=/tmp/gf-clean-home/log
logger=settings t=2026-07-06T22:18:22.681117888Z level=info msg="Path Plugins" path=/tmp/blitzy/grafana/blitzy-dc74cc50-4c41-4fe8-8bd2-75a8df865634_4216d2/data/plugins
logger=settings t=2026-07-06T22:18:22.681122461Z level=info msg="Path Provisioning" path=/tmp/blitzy/grafana/blitzy-dc74cc50-4c41-4fe8-8bd2-75a8df865634_4216d2/conf/provisioning
logger=settings t=2026-07-06T22:18:22.681127108Z level=info msg="App mode production"
```

Note there is **no** “Config loaded from …/custom.ini” line — because `conf/custom.ini` does not
exist, the loader returns silently. The effective values are also visible over the API:

```bash
$ curl -sS -i http://localhost:3000/api/health
```

```text
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json; charset=UTF-8
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Mon, 06 Jul 2026 22:18:44 GMT
Content-Length: 62

{
  "database": "ok",
  "version": "9.2.0",
  "commit": "NA"
}
```

The `[database]` defaults are confirmed by the DB actually created (SQLite, file `grafana.db`):

```text
logger=sqlstore t=2026-07-06T22:18:22.681553024Z level=info msg="Connecting to DB" dbtype=sqlite3
logger=sqlstore t=2026-07-06T22:18:22.681562722Z level=info msg="Creating SQLite database file" path=/tmp/gf-clean-home/data/grafana.db
```

### O1 · Causal explanation

- The shipped baseline is loaded first in `loadConfiguration` at `pkg/setting/setting.go:L881`,
  which computes `defaultConfigFile := path.Join(cfg.HomePath, "conf/defaults.ini")`
  (`pkg/setting/setting.go:L883`) and parses it with `ini.Load(defaultConfigFile)`
  (`pkg/setting/setting.go:L893`). This is why zero user config still yields a complete config —
  `conf/defaults.ini` carries every value (its header even warns operators
  `# Do not modify this file in grafana installs`, `conf/defaults.ini:L3`).
- `conf/custom.ini` is applied by `loadSpecifiedConfigFile` (`pkg/setting/setting.go:L840`).
  When no explicit `--config` is given, it defaults the path to
  `filepath.Join(cfg.HomePath, customInitPath)` (`pkg/setting/setting.go:L842`, with
  `customInitPath = "conf/custom.ini"` at `pkg/setting/setting.go:L57`) and, crucially,
  **returns `nil` without error if the file is absent** (`pkg/setting/setting.go:L843-L846`) —
  exactly the clean‑start case.
- Environment overrides are applied by `applyEnvVariableOverrides`
  (`pkg/setting/setting.go:L666`); CLI `cfg:` properties by `applyCommandLineDefaultProperties`
  (`pkg/setting/setting.go:L781`). The whole sequence is orchestrated by `Cfg.Load`
  (`pkg/setting/setting.go:L1046`). This ordering is what makes the precedence
  `defaults.ini < custom.ini < GF_* < cfg:` hold.
- `app_mode = production` (`conf/defaults.ini:L7`) is preserved because I did **not** pass
  `cfg:app_mode=development`; the log line `App mode production` confirms the default survived.

---

## O2 — “disabled/skipped” vs “success” logs

### O2 · Direct answer

Grafana starts a **background‑service registry** of 60+ services. Each service is checked for
enablement; **disabled services are silently skipped** (they produce *no* log line at all),
while **enabled services launch as concurrent goroutines** and log their own readiness. So the
asymmetry the new team member saw is not random: it is the registry gating each service on
whether it is enabled. A few subsystems that *are* started but find nothing to act on also emit
their own `disabled`/`error`/`skipped` messages (for example, the image renderer and the
migrator).

### O2 · Evidence

The services that **did** start each logged readiness (representative lines from the first‑run
log):

```text
logger=live.push_http t=2026-07-06T22:18:28.923176241Z level=info msg="Live Push Gateway initialization"
logger=grafanaStorageLogger t=2026-07-06T22:18:29.083537527Z level=info msg="Storage starting"
logger=ngalert.multiorg.alertmanager t=2026-07-06T22:18:29.083737486Z level=info msg="Starting MultiOrg Alertmanager"
logger=ngalert.scheduler t=2026-07-06T22:18:29.107050964Z level=info msg="Starting scheduler" tickInterval=10s maxAttempts=3
logger=ticker t=2026-07-06T22:18:29.107090071Z level=info msg=starting first_tick=2026-07-06T22:18:30Z
logger=app-registry t=2026-07-06T22:18:29.364533208Z level=info msg="app registry initialized"
```

A subsystem that was *started* but had nothing to work with logged an **error** rather than
silently skipping — the image renderer, because the on‑disk plugins directory does not exist on
a clean start:

```text
logger=renderer.manager t=2026-07-06T22:18:28.880209649Z level=error msg="Failed to get renderer plugin sources" error="failed to open plugins path"
```

The migrator emits its own `Skipping` lines when a migration was already applied but not
recorded, and reports a per‑phase `skipped=` counter (first run vs. second run differ — see O3):

```text
logger=migrator t=2026-07-06T22:18:28.816715556Z level=info msg="migrations completed" performed=626 skipped=0 duration=6.133806936s
```

The set of loggers that actually emitted lines (i.e., the services that were active) — counted
from the full startup log — was, most‑frequent first:

```text
   1256 logger=migrator
     40 logger=resource-migrator
     11 logger=settings
      6 logger=grafana-apiserver
      4 logger=sqlstore
      3 logger=resource-server
      3 logger=ngalert.state.manager
      2 logger=renderer.manager
      2 logger=provisioning.dashboard
      2 logger=provisioning.alerting
      2 logger=plugin.store
      2 logger=plugin.backgroundinstaller
      2 logger=plugin.angulardetectorsprovider.dynamic
      1 logger=ticker
      1 logger=secrets
      1 logger=query_data
      1 logger=plugins.update.checker
      1 logger=plugin.sources
      1 logger=ngalert.scheduler
      1 logger=ngalert.notifier.alertmanager
      1 logger=ngalert.multiorg.alertmanager
      1 logger=live.push_http
      1 logger=infra.usagestats.collector
      1 logger=infra.usagestats
      1 logger=http.server
      1 logger=grafanaStorageLogger
      1 logger=grafana.update.checker
      1 logger=featuremgmt
      1 logger=context
      1 logger=app-registry
```

Services that are **disabled by default produced no line at all** — which is precisely why the
new team member saw “success” for some subsystems and nothing (or a skip) for others.

### O2 · Causal explanation

The gating happens in `Server.Run` (`pkg/server/server.go:L139`). The method snapshots the
registry (`services := s.backgroundServices`, `pkg/server/server.go:L146`) and iterates it
(`for _, svc := range services {`, `pkg/server/server.go:L149`). For each service it calls the
registry’s enablement check and **silently continues** past disabled ones — this is the “no log
line” behavior:

```go
	for _, svc := range services {
		if registry.IsDisabled(svc) {
			continue
		}

		service := svc
		serviceName := reflect.TypeOf(service).String()
		s.childRoutines.Go(func() error {
```

- The `if registry.IsDisabled(svc) { continue }` at `pkg/server/server.go:L150-L152` is the
  reason disabled services never appear in the log.
- Enabled services are launched as concurrent goroutines via `s.childRoutines.Go(func() error {`
  at `pkg/server/server.go:L156`; each service’s own `Run`/`Init` then logs its readiness (the
  “started/initialized/Starting …” lines above).
- Subsystems such as `renderer.manager` are *started* but log an **error** because the
  configured plugins path (`<data>/plugins`, `conf/defaults.ini:L24`) does not exist on a clean
  start — an *observed* behavior, not a silent skip.


---

## O3 — Persistent state, its location, and first‑run vs subsequent‑run

### O3 · Direct answer

On the **first** run Grafana writes a **SQLite database** named `grafana.db` under the data
directory, plus a **log file** under the logs directory (and would write a PID file if
`--pidfile` were given — it was not, so none appears). It schema‑migrates the database on
startup and then **creates the default admin user and the default organization**. On **every
subsequent** run against the same data directory, the database and logs are reused, the
migrations are all already applied (so they are skipped), and the admin/org are **not**
re‑created. The plugin registry is **in‑memory only** — no plugin state is persisted (inferred;
see O6 for the in‑memory load path).

Locations (default values, rooted under my `/tmp` data dir for cleanliness):

- Database: `<data>/grafana.db` — name `grafana.db` (`conf/defaults.ini:L164`) under `data`
  (`conf/defaults.ini:L15`).
- Logs: `<data>/log/grafana.log` — logs dir `data/log` (`conf/defaults.ini:L21`).

### O3 · Evidence

**Before the first run** the data directory is empty:

```bash
$ find /tmp/gf-clean-home -type f | sort
```

```text
[file count: 0]
```

**After the first run**, the SQLite DB and log file exist (no PID file, since none was
requested):

```bash
$ find /tmp/gf-clean-home -type f | sort
```

```text
/tmp/gf-clean-home/data/grafana.db
/tmp/gf-clean-home/log/grafana.log
```

```bash
$ ls -la /tmp/gf-clean-home/data
```

```text
total 1092
drwxr-x--- 5 root root    4096 Jul  6 22:22 .
drwxr-xr-x 4 root root    4096 Jul  6 22:18 ..
drwx------ 2 root root    4096 Jul  6 22:18 csv
-rw-r----- 1 root root 1093632 Jul  6 22:22 grafana.db
drwx------ 2 root root    4096 Jul  6 22:18 pdf
drwx------ 2 root root    4096 Jul  6 22:18 png
```

Querying the fresh database directly with `sqlite3`:

```bash
$ sqlite3 grafana.db ".tables"
```

```text
alert                        ngalert_configuration
alert_configuration          org
alert_configuration_history  org_user
alert_image                  permission
alert_instance               playlist
alert_notification           playlist_item
alert_notification_state     plugin_setting
alert_rule                   preferences
alert_rule_tag               provenance_type
alert_rule_version           query_history
annotation                   query_history_details
annotation_tag               query_history_star
anon_device                  quota
api_key                      resource
builtin_role                 resource_history
cache_data                   resource_migration_log
cloud_migration_resource     resource_version
cloud_migration_session      role
cloud_migration_snapshot     secrets
correlation                  seed_assignment
dashboard                    server_lock
dashboard_acl                session
dashboard_provisioning       short_url
dashboard_public             signing_key
dashboard_snapshot           sso_setting
dashboard_tag                star
dashboard_version            tag
data_keys                    team
data_source                  team_member
entity_event                 team_role
file                         temp_user
file_meta                    test_data
folder                       user
kv_store                     user_auth
library_element              user_auth_token
library_element_connection   user_external_session
login_attempt                user_role
migration_log
```

```bash
$ sqlite3 grafana.db "SELECT id,login,email,is_admin FROM user;"
```

```text
id  login  email            is_admin
--  -----  ---------------  --------
1   admin  admin@localhost  1
```

```bash
$ sqlite3 grafana.db "SELECT id,name FROM org;"
```

```text
id  name
--  ---------
1   Main Org.
```

```bash
$ sqlite3 grafana.db "SELECT COUNT(*) AS user_count FROM user;"
$ sqlite3 grafana.db "SELECT COUNT(*) AS migration_count FROM migration_log;"
```

```text
user_count
----------
1
migration_count
---------------
626
```

The 626 `migration_log` rows match the startup line `migrations completed performed=626
skipped=0`. A sample of the earliest migrations:

```bash
$ sqlite3 grafana.db "SELECT migration_id, substr(sql,1,40) AS sql_snippet FROM migration_log ORDER BY id LIMIT 6;"
```

```text
migration_id                    sql_snippet
------------------------------  ----------------------------------------
create migration_log table      CREATE TABLE IF NOT EXISTS `migration_lo
create user table               CREATE TABLE IF NOT EXISTS `user` (
add unique index user.login     CREATE UNIQUE INDEX `UQE_user_login` ON
add unique index user.email     CREATE UNIQUE INDEX `UQE_user_email` ON
drop index UQE_user_login - v1  DROP INDEX `UQE_user_login`
drop index UQE_user_email - v1  DROP INDEX `UQE_user_email`
```

**Second run against the SAME data directory** — the differences are decisive. There is **no**
`Creating SQLite database file` line (the DB already exists), the migrator reports
`performed=0 skipped=626`, and **neither `Created default admin` nor `Created default
organization` appears**:

```text
logger=settings t=2026-07-06T22:23:17.304117143Z level=info msg="Starting Grafana" version=9.2.0 commit=NA branch=main compiled=2026-07-06T22:23:17Z
logger=settings t=2026-07-06T22:23:17.304400146Z level=info msg="Config loaded from" file=/tmp/blitzy/grafana/blitzy-dc74cc50-4c41-4fe8-8bd2-75a8df865634_4216d2/conf/defaults.ini
logger=sqlstore t=2026-07-06T22:23:17.304876964Z level=info msg="Connecting to DB" dbtype=sqlite3
logger=migrator t=2026-07-06T22:23:17.313457991Z level=info msg="migrations completed" performed=0 skipped=626 duration=738.253µs
logger=resource-migrator t=2026-07-06T22:23:17.41862741Z level=info msg="migrations completed" performed=0 skipped=18 duration=34.87µs
logger=http.server t=2026-07-06T22:23:17.422854945Z level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=
```

```text
>>> CONFIRMED: NO 'Created default admin' / 'Created default organization' on the second run
```

The DB is unchanged after the second run — still exactly one user, and the admin’s `created`
timestamp is identical to the first run (proving it was **not** recreated):

```bash
$ sqlite3 grafana.db "SELECT id,login,email,is_admin,created FROM user;"
```

```text
id  login  email            is_admin  created
--  -----  ---------------  --------  -------------------
1   admin  admin@localhost  1         2026-07-06 22:18:28
```

### O3 · Causal explanation

- The database is opened/created and migrated by the SQL store on startup; the SQLite file name
  and location come from `[database] path = grafana.db` (`conf/defaults.ini:L164`) under
  `[paths] data` (`conf/defaults.ini:L15`).
- The first‑vs‑subsequent difference is driven by a **user‑count guard** inside
  `ensureMainOrgAndAdminUser` (`pkg/services/sqlstore/sqlstore.go:L190`). It runs a raw count:

  ```go
			rawSQL := `SELECT COUNT(id) AS Count FROM ` + ss.dialect.Quote("user")
			if _, err := sess.SQL(rawSQL).Get(&stats); err != nil {
				return fmt.Errorf("could not determine if admin user exists: %w", err)
			}
			if stats.Count > 0 {
				return nil
			}
  ```

  The count query is at `pkg/services/sqlstore/sqlstore.go:L200`; the early return
  `if stats.Count > 0 { return nil }` is at `pkg/services/sqlstore/sqlstore.go:L204-L206`. On a
  fresh DB the count is `0`, so creation proceeds; on any later run the count is `≥ 1`, so the
  function returns immediately — which is exactly why `Created default admin`/`Created default
  organization` appear **only** on the first run.
- The log file location follows `[paths] logs = data/log` (`conf/defaults.ini:L21`). No PID file
  was written because `--pidfile` was not supplied (the `server` command exposes `--pidfile` but
  it is empty by default — *observed* via `grafana server --help`).


---

## O4 — Actual security posture (the “credentials I never set up” puzzle)

### O4 · Direct answer

On first startup Grafana **creates a real local administrator account in the database** —
username `admin`, password `admin`, email `admin@localhost` — because
`disable_initial_admin_creation = false` by default. **Basic auth and the login form are enabled
by default**, and **anonymous access is disabled by default**. So this is **NOT** a permissive
or “no‑auth” mode: the “credentials I never set up” are a genuine DB row seeded on first run, and
unauthenticated requests are rejected with `401`.

Config anchors:

| Key | Default | `conf/defaults.ini` |
|-----|---------|---------------------|
| `[security]` section | — | `:L323` |
| `disable_initial_admin_creation` | `false` | `:L325` |
| `admin_user` | `admin` | `:L328` |
| `admin_password` | `admin` | `:L331` |
| `admin_email` | `admin@localhost` | `:L334` |
| `[auth.basic] enabled` | `true` | `:L874` / `:L875` |
| `[auth.anonymous] enabled` | `false` | `:L648` / `:L650` |

### O4 · Evidence

**(1) The admin account is created on first run** — captured directly from the startup log:

```text
logger=sqlstore t=2026-07-06T22:18:28.822467531Z level=info msg="Created default admin" user=admin
logger=sqlstore t=2026-07-06T22:18:28.822559874Z level=info msg="Created default organization"
```

and it is a real row in the `user` table (`is_admin = 1`):

```text
id  login  email            is_admin
--  -----  ---------------  --------
1   admin  admin@localhost  1
```

**(2) Anonymous access is rejected** — an unauthenticated request returns `401`:

```bash
$ curl -sS -i http://localhost:3000/api/user
```

```text
HTTP/1.1 401 Unauthorized
Cache-Control: no-store
Content-Type: application/json; charset=UTF-8
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Mon, 06 Jul 2026 22:18:44 GMT
Content-Length: 102

{"extra":null,"message":"Unauthorized","messageId":"auth.unauthorized","statusCode":401,"traceID":""}
```

The server’s own request log confirms the rejection reason:

```text
logger=context userId=0 orgId=0 uname= t=2026-07-06T22:18:44.121238372Z level=info msg="Request Completed" method=GET path=/api/user status=401 remote_addr=127.0.0.1 time_ms=0 duration=110.223µs size=102 referer= handler=/api/user/ status_source=server errorReason=Unauthorized errorMessageID=auth.unauthorized error="cannot authenticate request"
```

**(3) The default credentials really work** — logging in with `admin`/`admin` succeeds and
yields a session, and the authenticated call returns the admin identity:

```bash
$ curl -sS -i -c cookies.txt -H 'Content-Type: application/json' -d '{"user":"admin","password":"admin"}' http://localhost:3000/login
```

```text
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
Set-Cookie: grafana_session=b2d0d20fc355acfbfde6018429236def; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax
Set-Cookie: grafana_session_expiry=1783376930; Path=/; Max-Age=2592000; SameSite=Lax
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Mon, 06 Jul 2026 22:18:55 GMT
Content-Length: 41

{"message":"Logged in","redirectUrl":"/"}
```

```bash
$ curl -sS -i -b cookies.txt http://localhost:3000/api/user
```

```text
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Mon, 06 Jul 2026 22:18:55 GMT
Content-Length: 371

{"id":1,"uid":"afrbymr7vsqgwc","email":"admin@localhost","name":"","login":"admin","theme":"","orgId":1,"isGrafanaAdmin":true,"isDisabled":false,"isExternal":false,"isExternallySynced":false,"isGrafanaAdminExternallySynced":false,"authLabels":[],"updatedAt":"2026-07-06T22:18:28Z","createdAt":"2026-07-06T22:18:28Z","avatarUrl":"/avatar/46d229b033af06a191ff2267bca9ae56"}
```

### O4 · Causal explanation

- **Account creation.** `ensureMainOrgAndAdminUser` (`pkg/services/sqlstore/sqlstore.go:L190`)
  gates creation on `if !ss.cfg.DisableInitAdminCreation {` (`pkg/services/sqlstore/sqlstore.go:L210`),
  then calls `createUser` with the configured admin identity and `IsAdmin: true`
  (`pkg/services/sqlstore/sqlstore.go:L213-L218`) and logs `Created default admin`
  (`pkg/services/sqlstore/sqlstore.go:L222`); the org is created just after and logs
  `Created default organization` (`pkg/services/sqlstore/sqlstore.go:L230`). The config values
  are bound in `pkg/setting/setting.go`:
  `cfg.DisableInitAdminCreation = security.Key("disable_initial_admin_creation").MustBool(false)`
  (`pkg/setting/setting.go:L1580`),
  `cfg.AdminUser = valueAsString(security, "admin_user", "")` (`pkg/setting/setting.go:L1581`),
  `cfg.AdminPassword = valueAsString(security, "admin_password", "")`
  (`pkg/setting/setting.go:L1582`).
- **Basic auth / login form enabled.** The Basic auth client is always‑on:
  `func (c *Basic) IsEnabled() bool { return true }`
  (`pkg/services/authn/clients/basic.go:L39-L40`) and its `Name()` returns `authn.ClientBasic`
  (`pkg/services/authn/clients/basic.go:L26-L27`; the constant `ClientBasic = "auth.client.basic"`
  is at `pkg/services/authn/authn.go:L24`). It is registered when basic auth is enabled —
  `if cfg.BasicAuthEnabled { authnSvc.RegisterClient(clients.ProvideBasic(passwordClient)) }`
  (`pkg/services/authn/authnimpl/registration.go:L74-L75`), and the form client is registered
  unless the login form is disabled (`pkg/services/authn/authnimpl/registration.go:L78-L79`).
  `cfg.BasicAuthEnabled` binds from `[auth.basic] enabled` with a default of `true`
  (`cfg.BasicAuthEnabled = authBasic.Key("enabled").MustBool(true)`,
  `pkg/setting/setting.go:L1657`). The login workflow itself is `HTTPServer.LoginView`
  (`pkg/api/login.go:L92`) and `HTTPServer.LoginPost` (`pkg/api/login.go:L230`).
- **Anonymous disabled → no anonymous client registered.** There is **no**
  `pkg/services/authn/clients/anonymous.go` file. The anonymous client is the `Anonymous` struct
  built in `ProvideAnonymousDeviceService` (`pkg/services/anonymous/anonimpl/impl.go:L40`), where
  `anonClient := &Anonymous{…}` is created (`pkg/services/anonymous/anonimpl/impl.go:L56`) and
  registered **only** when anonymous is enabled:

  ```go
	if cfg.Anonymous.Enabled {
		authBroker.RegisterClient(anonClient)
		authBroker.RegisterPostLoginHook(a.untagDevice, 100)
	}
  ```

  This conditional is at `pkg/services/anonymous/anonimpl/impl.go:L63-L66`. Because
  `cfg.Anonymous.Enabled` defaults to `false` — bound at
  `anonSettings.Enabled = anonSection.Key("enabled").MustBool(false)`
  (`pkg/setting/setting_anonymous.go:L15`), matching `[auth.anonymous] enabled = false`
  (`conf/defaults.ini:L650`) — the anonymous client is **not** registered on a clean start, and
  the identifier `ClientAnonymous = "auth.client.anonymous"` (`pkg/services/authn/authn.go:L23`)
  never enters the active auth chain. That is why the unauthenticated `/api/user` returns
  `401 auth.unauthorized` rather than being served as an anonymous user.


---

## O5 — Default‑enabled vs opt‑in API features

### O5 · Direct answer

There are two distinct categories on a clean start:

1. **Always‑on API surface** — endpoints like `/api/health`, `/login`, `/api/user`,
   `/api/plugins`, `/api/datasources`, `/api/frontend/settings` are served regardless of
   feature toggles (they are wired unconditionally into the HTTP router).
2. **Feature‑toggle / config‑gated features** — governed by `pkg/services/featuremgmt`. The
   default toggle states are compiled from a **generated, embedded manifest**
   `toggles_gen.json`. Of **253** total feature flags, **62 are ON by default** (their
   `spec.expression` is `"true"`) and the remaining **191 are opt‑in (default OFF)**; **57** of
   the default‑ON flags are surfaced to the frontend (the other 5 are backend‑only).

Two analytics/update behaviors are **on by default** and were observed running:
`reporting_enabled = true` (`conf/defaults.ini:L258`) and `check_for_updates = true`
(`conf/defaults.ini:L268`).

### O5 · Evidence

**Effective build/feature/analytics state** from `/api/frontend/settings` (summarized from the
28,641‑byte response):

```text
buildInfo: version='9.2.0' commit='NA' env='production' edition='Open Source'
reporting/analytics: {'enabled': True}

featureToggles: total=57  ON(true)=57
```

The raw `FeatureToggles` line emitted at startup (all values `=true`) — this is the complete,
unedited list of the default‑ON, frontend‑visible toggles:

```text
logger=featuremgmt t=2026-07-06T22:18:22.681454724Z level=info msg=FeatureToggles logsContextDatasourceUi=true prometheusConfigOverhaulAuth=true lokiStructuredMetadata=true recoveryThreshold=true dashboardSceneSolo=true prometheusAzureOverrideAudience=true preinstallAutoUpdate=true alertingNoDataErrorExecution=true singleTopNav=true transformationsVariableSupport=true formatString=true alertingSimplifiedRouting=true dashboardSceneForViewers=true dataplaneFrontendFallback=true annotationPermissionUpdate=true managedPluginsInstall=true notificationBanner=true panelMonitoring=true kubernetesPlaylists=true logsInfiniteScrolling=true cloudWatchCrossAccountQuerying=true accessControlOnCall=true dashboardScene=true logsExploreTableVisualisation=true correlations=true cloudWatchNewLabelParsing=true awsAsyncQueryCaching=true unifiedRequestLog=true lokiQuerySplitting=true accessActionSets=true groupToNestedTableTransformation=true cloudWatchRoundUpEndTime=true newFiltersUI=true promQLScope=true addFieldFromCalculationStatFunctions=true pinNavItems=true angularDeprecationUI=true logRowsPopoverMenu=true zipkinBackendMigration=true transformationsRedesign=true newDashboardSharingComponent=true recordedQueriesMulti=true azureMonitorEnableUserAuth=true exploreMetrics=true dashgpt=true alertingInsights=true nestedFolders=true ssoSettingsApi=true alertingUIOptimizeReducer=true cloudwatchMetricInsightsCrossAccount=true lokiQueryHints=true influxdbBackendMigration=true publicDashboardsScene=true tlsMemcached=true prometheusMetricEncyclopedia=true openSearchBackendFlowEnabled=true
```

**Reconciliation against the embedded manifest** `pkg/services/featuremgmt/toggles_gen.json`
(size **118,329 bytes**), parsed directly from the repository file:

```text
manifest kind=FeatureList apiVersion=featuretoggle.grafana.app/v0alpha1  total items(flags)=253
flags with spec.expression=='true' (default ON): 62
by stage: {'GA': 69, 'experimental': 141, 'preview': 35, 'privatePreview': 6, 'deprecated': 2}
frontend ON count: 57
in-frontend-ON but not expr_true (i.e., GA/enabled another way): 0
expr_true but not exposed to frontend: 5
```

**Analytics/update‑check defaults are live** — both update checkers ran on startup (a direct
consequence of `check_for_updates = true`):

```text
logger=plugins.update.checker t=2026-07-06T22:18:29.142651852Z level=info msg="Update check succeeded" duration=59.103909ms
logger=grafana.update.checker t=2026-07-06T22:18:29.146962506Z level=info msg="Update check succeeded" duration=63.39228ms
```

### O5 · Causal explanation

- The default feature‑toggle state is not hand‑written at runtime; it is **compiled from a
  generated manifest embedded into the binary**. In `pkg/services/featuremgmt/registry.go` the
  manifest is embedded with `//go:embed toggles_gen.json`
  (`pkg/services/featuremgmt/registry.go:L1695`) into `var f embed.FS`
  (`pkg/services/featuremgmt/registry.go:L1696`), and read at startup via
  `f.ReadFile("toggles_gen.json")` (`pkg/services/featuremgmt/registry.go:L1701`). A flag is ON
  by default when its `spec.expression` is `"true"` — which is why exactly 62 of the 253 flags
  are enabled without any configuration, and the other 191 are opt‑in.
- Because the manifest is a **generated + embedded** artifact, it is also an O7 dependency: the
  runtime’s default feature set is baked in at build time.
- `reporting_enabled = true` (`conf/defaults.ini:L258`) and `check_for_updates = true`
  (`conf/defaults.ini:L268`) are what cause the update‑check goroutines to phone
  `https://grafana.com` on startup; the `Update check succeeded` lines above are the observed
  effect. The frontend `buildInfo` reporting `env='production'` and `edition='Open Source'`
  confirms the default `app_mode = production` (`conf/defaults.ini:L7`) OSS build.


---

## O6 — Plugin/data‑source bootstrap (bundled vs disk‑discovered vs remote)

### O6 · Direct answer

At startup Grafana resolves **three plugin source classes**, plus a set of **compiled‑in core
backend data sources**. On a clean start **nothing is fetched remotely**: the plugins the new
team member sees “without installing anything” are **core plugins compiled and shipped inside
the binary/`public` tree**, not downloads. The three classes are:

- **`ClassCore`** — compiled/shipped, loaded from the `public` static root.
- **`ClassBundled`** — bundled plugins from the configured bundled‑plugins path.
- **`ClassExternal`** — discovered on disk under `<data>/plugins`, which does **not** exist on a
  clean start (so zero external plugins are found).

The API confirms **49 core plugins** are registered without any install (30 panels + 19 data
sources), all with signature `internal`, while **`/api/datasources` is empty** because no data
source was *provisioned*.

The compiled core backend data sources live in `pkg/tsdb/*` — there are **exactly 19**
directories: `azuremonitor`, `cloud-monitoring`, `cloudwatch`, `elasticsearch`,
`grafana-postgresql-datasource`, `grafana-pyroscope-datasource`, `grafana-testdata-datasource`,
`grafanads`, `graphite`, `influxdb`, `jaeger`, `loki`, `mssql`, `mysql`, `opentsdb`, `parca`,
`prometheus`, `tempo`, `zipkin`. Bundled frontend plugins live under
`public/app/plugins/{datasource,panel}` (**observed 22 datasource + 32 panel** source
directories).

### O6 · Evidence

**Core plugins present without any install** — `/api/plugins` returned 49 entries (30 panel +
19 datasource), every one signed `internal`:

```text
DATASOURCE plugins (19):
   alertmanager
   cloudwatch
   elasticsearch
   grafana-azure-monitor-datasource
   grafana-postgresql-datasource
   grafana-pyroscope-datasource
   grafana-testdata-datasource
   graphite
   influxdb
   jaeger
   loki
   mssql
   mysql
   opentsdb
   parca
   prometheus
   stackdriver
   tempo
   zipkin
PANEL plugins (30):
  alertlist, annolist, barchart, bargauge, candlestick, canvas, dashlist, datagrid, flamegraph, gauge, geomap, gettingstarted, graph, heatmap, histogram, logs, news, nodeGraph, piechart, stat, state-timeline, status-history, table, table-old, text, timeseries, traces, trend, welcome, xychart

SAMPLE record (prometheus): signature=internal type=datasource name=Prometheus
```

**No data sources are provisioned** — `/api/datasources` is an empty array (`Content-Length: 2`):

```bash
$ curl -sS -i -b cookies.txt http://localhost:3000/api/datasources
```

```text
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Mon, 06 Jul 2026 22:19:09 GMT
Content-Length: 2

[]
```

**Startup plugin lifecycle** — the store loads plugins in‑memory, external discovery fails
because `<data>/plugins` does not exist, and the loaded count (54) exceeds the 49 the default
`/api/plugins` query lists (the delta is app‑class/builtin plugins the default listing filters
out):

```text
logger=plugin.store t=2026-07-06T22:18:28.881143912Z level=info msg="Loading plugins..."
logger=plugin.sources t=2026-07-06T22:18:28.881176198Z level=error msg="Failed to load external plugins" error="failed to open plugins path"
logger=plugin.store t=2026-07-06T22:18:28.914533932Z level=info msg="Plugins loaded" count=54 duration=33.390554ms
```

**Provisioning is a no‑op** — the provisioning directories ship only commented `sample.yaml`
files, so alerting and dashboard provisioning start and finish instantly with nothing to load:

```text
logger=provisioning.alerting t=2026-07-06T22:18:29.083266614Z level=info msg="starting to provision alerting"
logger=provisioning.alerting t=2026-07-06T22:18:29.083287856Z level=info msg="finished to provision alerting"
logger=provisioning.dashboard t=2026-07-06T22:18:29.117259714Z level=info msg="starting to provision dashboards"
logger=provisioning.dashboard t=2026-07-06T22:18:29.117291371Z level=info msg="finished to provision dashboards"
```

The provisioning tree indeed contains only sample files (from the repository):

```text
conf/provisioning/access-control/sample.yaml
conf/provisioning/alerting/sample.yaml
conf/provisioning/dashboards/sample.yaml
conf/provisioning/datasources/sample.yaml
conf/provisioning/plugins/sample.yaml
```

### O6 · Causal explanation

- The three source classes are assembled in `Service.List`
  (`pkg/plugins/manager/sources/sources.go:L24`):

  ```go
	r := []plugins.PluginSource{
		NewLocalSource(plugins.ClassCore, corePluginPaths(s.cfg.StaticRootPath)),
		NewLocalSource(plugins.ClassBundled, []string{s.cfg.BundledPluginsPath}),
	}
	r = append(r, s.externalPluginSources()...)
  ```

  `ClassCore` is loaded from the `public` static root
  (`pkg/plugins/manager/sources/sources.go:L26`), `ClassBundled` from the bundled‑plugins path
  (`pkg/plugins/manager/sources/sources.go:L27`), and `ClassExternal` from disk via
  `externalPluginSources()` (`pkg/plugins/manager/sources/sources.go:L34`) which calls
  `DirAsLocalSources(s.cfg.PluginsPath, plugins.ClassExternal)`
  (`pkg/plugins/manager/sources/sources.go:L35`). On a clean start `s.cfg.PluginsPath`
  (`<data>/plugins`, `conf/defaults.ini:L24`) does not exist, so external discovery yields the
  observed `Failed to load external plugins error="failed to open plugins path"`.
- The reason every core plugin is reported with **`signature: internal`** is the class‑specific
  signature policy in `LocalSource.DefaultSignature`
  (`pkg/plugins/manager/sources/source_local_disk.go:L33`): for `ClassCore` it returns
  `Signature{Status: plugins.SignatureStatusInternal}` (`pkg/plugins/manager/sources/source_local_disk.go:L35-L38`).
  Actual loading/discovery is performed by `Loader.Load`
  (`pkg/plugins/manager/loader/loader.go:L55`) and `Local.Find`
  (`pkg/plugins/manager/loader/finder/local.go:L41`).
- `/api/datasources` is empty because **no provisioning** occurred: the default provisioning
  directory `conf/provisioning` (`conf/defaults.ini:L27`) ships only `sample.yaml` files. Core
  data‑source *plugins* are registered (they are compiled in), but no data‑source *instances*
  are created — which is exactly the distinction the new team member needs: “plugin available”
  ≠ “data source configured”.
- The 19 `pkg/tsdb/*` backends are the compiled Go implementations behind those core data‑source
  plugins; nothing is downloaded on startup, confirming the **“nothing fetched remotely”**
  answer.


---

## O7 — Build/generated‑file dependency

### O7 · Direct answer

The Grafana runtime depends on **artifacts produced by the build, not committed to the
repository**: the generated Google Wire dependency‑injection graph
`pkg/server/wire_gen.go`, and the built frontend assets under `public/build`. Therefore
**running the code directly can differ from building first**:

- If `pkg/server/wire_gen.go` has not been generated (`make gen-go`), the `pkg/server` package
  does not even compile (the hand‑written `wire.go` is excluded from normal builds by a build
  tag).
- If `public/build` is missing, startup validation logs an error
  (`Failed to detect generated javascript files in public/build`).
- A build that is not **version‑stamped** reports the fallback version `9.2.0` — which is
  **NON‑CANONICAL**, not the release version.

Additionally the feature‑toggle manifest is generated + embedded (see O5), and the root
`embed.go` embeds a CUE schema — both are generated/embedded build dependencies.

### O7 · Evidence

**`wire_gen.go` and `public/build` are NOT committed** (they are generated and git‑ignored),
while the *source* `wire.go` *is* tracked:

```text
--- git ls-files pkg/server/wire_gen.go (empty output = NOT tracked) ---
[exit=0]
--- git ls-files public/build (empty output = NOT tracked) ---
[count tracked under public/build: 0]
--- git check-ignore -v (shows .gitignore rule that ignores them) ---
.gitignore:194:**/wire_gen.go	pkg/server/wire_gen.go
.gitignore:9:/public/build	public/build
--- but wire.go (the SOURCE) IS tracked ---
pkg/server/wire.go
```

The **committed tree at HEAD** contains the Wire *source* files but not the generated one, and
zero `public/build` entries:

```text
--- wire*.go files present in the COMMITTED tree at HEAD ---
pkg/server/wire.go
pkg/server/wireexts_oss.go
--- public/build entries in committed tree at HEAD (expect none) ---
[public/build committed entries: 0]
```

**`make gen-go` produces `wire_gen.go`** (idempotent here; regenerating yields a byte‑identical
94,781‑byte file and leaves git clean):

```bash
$ make gen-go
```

```text
generate go files
go run  ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server
wire: github.com/grafana/grafana/pkg/server: wrote /tmp/blitzy/grafana/blitzy-dc74cc50-4c41-4fe8-8bd2-75a8df865634_4216d2/pkg/server/wire_gen.go
[make gen-go exit=0]
--- wire_gen.go now present: ---
-rw-r--r-- 1 root root 94781 Jul  6 22:14 pkg/server/wire_gen.go
--- diff vs before regeneration (empty = identical) ---
IDENTICAL
--- git status after gen-go (must stay clean; wire_gen.go is gitignored) ---
[git porcelain line count: 0]
```

**Missing `public/build` triggers the startup validation error** (edge‑path demonstration; this
run used a deliberately **non‑canonical** `static_root_path` pointing at a directory with no
`build/` subdirectory):

```bash
$ go run ./pkg/cmd/grafana server --homepath "$PWD" \
    cfg:server.static_root_path=/tmp/gf-o7demo/emptystatic ...
```

```text
logger=settings t=2026-07-06T22:16:08.67611027Z level=error msg="Failed to detect generated javascript files in public/build"
```

**Version stamping** — an unstamped `go run` reports `9.2.0`:

```bash
$ go run ./pkg/cmd/grafana --version
```

```text
grafana version 9.2.0
```

and the startup banner shows the unstamped identifiers `commit=NA branch=main`:

```text
logger=settings ... msg="Starting Grafana" version=9.2.0 commit=NA branch=main compiled=2026-07-06T22:18:22Z
```

A striking **runtime consequence** of the unstamped `9.2.0`: the default `preinstallAutoUpdate`
feature tries to preinstall a plugin, and the remote registry rejects it *because the reported
version is too old* — observed in the first‑run log:

```text
logger=plugin.backgroundinstaller t=2026-07-06T22:18:29.083548903Z level=info msg="Installing plugin" pluginId=grafana-lokiexplore-app version=
logger=plugin.backgroundinstaller t=2026-07-06T22:18:29.26298276Z level=error msg="Failed to install plugin" pluginId=grafana-lokiexplore-app version= error="[plugin.grafanaVersionNotCompatible] grafana-lokiexplore-app is not compatible with your Grafana version: 9.2.0"
```

This is direct proof that *how the software is built* (stamped vs unstamped) changes observable
behavior — exactly the O7 point.

### O7 · Causal explanation

- **Wire graph.** `pkg/server/wire.go` is tagged for the Wire code generator and excluded from
  ordinary builds: its first two lines are `//go:build wireinject` (`pkg/server/wire.go:L1`) and
  `// +build wireinject` (`pkg/server/wire.go:L2`). The concrete injector that ordinary builds
  compile — `wire_gen.go` — is produced by `make gen-go`, whose recipe is
  `$(GO) run … ./pkg/build/wire/cmd/wire/main.go gen -tags $(WIRE_TAGS) ./pkg/server`
  (`Makefile:L166-L169`). Because `wire_gen.go` is git‑ignored (`.gitignore:194`), a fresh
  checkout must run codegen before `go build`/`go run` of the server will succeed.
- **Frontend assets.** Startup calls `validateStaticRootPath` (`pkg/setting/setting.go:L1034`),
  which does `os.Stat(path.Join(cfg.StaticRootPath, "build"))` (`pkg/setting/setting.go:L1039`)
  and logs `Failed to detect generated javascript files in public/build`
  (`pkg/setting/setting.go:L1040`) when the directory is absent; it is invoked from the config
  load at `pkg/setting/setting.go:L1870`. The static root defaults to `public`
  (`conf/defaults.ini:L60`), read at `pkg/setting/setting.go:L1867-L1868`. `public/build` is
  git‑ignored (`.gitignore:9`) and produced by `yarn build`, so a fresh checkout must build the
  frontend for the assets to exist.
- **Version stamping.** The version identifiers are *variables*, not constants, precisely so the
  linker can override them: the comment `// The following variables cannot be constants, since
  they can be overridden through the -X link flag` (`pkg/cmd/grafana/main.go:L16`) precedes
  `var version = "9.2.0"` (`pkg/cmd/grafana/main.go:L17`) and `var buildBranch = "main"`
  (`pkg/cmd/grafana/main.go:L20`). An unstamped `go run` leaves these fallbacks in place, so
  `9.2.0`/`main`/`NA` are emitted — **non‑canonical** placeholder values.
- **Entry point.** The `server` subcommand is registered in `MainApp` via
  `commands.ServerCommand(version, commit, enterpriseCommit, buildBranch, buildstamp)`
  (`pkg/cmd/grafana/main.go:L47`, inside the command list at `pkg/cmd/grafana/main.go:L45-L48`).
  The command is defined by `func ServerCommand(...)`
  (`pkg/cmd/grafana-server/commands/cli.go:L28`, `Name: "server"` at `:L30`, `Action` at `:L33`
  → `RunServer` at `:L46` → `server.Initialize(...)` at `:L108`).
- **Other generated/embedded artifacts.** The feature‑toggle manifest is generated and embedded
  (`pkg/services/featuremgmt/registry.go:L1695`, see O5), and the repository root `embed.go`
  embeds a CUE schema: `//go:embed cue.mod/module.cue` (`embed.go:L9`) into
  `var CueSchemaFS embed.FS` (`embed.go:L10`). These are additional build‑time dependencies the
  runtime relies on.

> **Canonical vs non‑canonical run (accuracy note).** The canonical clean invocation is the bare
> `go run ./pkg/cmd/grafana server` (or the equivalent prebuilt `./bin/grafana server`), which
> preserves `app_mode = production`. Do **not** treat `make run` / `make run-go` as the clean
> default: per `.bra.toml` (`.bra.toml:L5`, `.bra.toml:L21`) they run
> `./bin/grafana server … -packaging=dev cfg:app_mode=development`, i.e., they **inject**
> `cfg:app_mode=development` and `-packaging=dev`, which override the default `production` mode.
> Those are non‑canonical overrides and were **not** used for the observations in this document.

---

## Coverage summary

| Objective | Direct answer (one line) | Key observed evidence | Primary `file:line` |
|-----------|--------------------------|-----------------------|---------------------|
| **O1** | All defaults come from `conf/defaults.ini`; precedence `defaults < custom.ini < GF_* < cfg:` | `Config loaded from …/conf/defaults.ini`; `App mode production` | `pkg/setting/setting.go:L881-L893`, `:L1046`; `conf/defaults.ini:L7` |
| **O2** | Disabled services are silently skipped; enabled ones run as goroutines | active‑logger census; `renderer.manager` error | `pkg/server/server.go:L149-L156` |
| **O3** | First run writes `grafana.db` + logs and seeds admin/org; later runs skip via a user‑count guard | before/after `find`; `sqlite3` rows; 2nd run has no creation lines | `pkg/services/sqlstore/sqlstore.go:L200-L206` |
| **O4** | A real `admin`/`admin` DB account is created; basic auth on, anonymous off (not permissive) | `401` anon; `admin`/`admin` login; `user` row `is_admin=1` | `pkg/services/sqlstore/sqlstore.go:L210-L222`; `pkg/services/anonymous/anonimpl/impl.go:L63-L64` |
| **O5** | Always‑on API vs 253 toggles (62 ON by default); analytics/update‑check on | `/api/frontend/settings`; manifest parse; update‑check ran | `pkg/services/featuremgmt/registry.go:L1695-L1701`; `conf/defaults.ini:L258,L268` |
| **O6** | 3 source classes + 19 compiled `tsdb` backends; nothing remote; 49 core plugins, 0 datasources | `/api/plugins`=49; `/api/datasources`=`[]`; external load fails | `pkg/plugins/manager/sources/sources.go:L24-L35` |
| **O7** | Runtime needs generated `wire_gen.go` + built `public/build`; unstamped build → `9.2.0` | git‑ignore proof; `make gen-go`; missing‑build warning; plugin‑version rejection | `pkg/server/wire.go:L1-L2`; `pkg/setting/setting.go:L1034-L1040`; `pkg/cmd/grafana/main.go:L16-L20` |

**Stability.** Each observation was reproduced. A second run against the same data directory
showed `migrations completed performed=0 skipped=626` and **no** admin/org creation; a third run
in a fresh data directory reproduced the first run exactly (same `Created default admin
user=admin`, `Created default organization`, and `HTTP Server Listen address=[::]:3000`), and
the DB again held a single `admin`/`admin@localhost` user and `Main Org.` The observed values
were stable across runs.

