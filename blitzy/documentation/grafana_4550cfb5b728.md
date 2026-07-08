# Grafana Clean-Start Ground Truth — What Really Happens on the First Launch

> A runtime-observed reference that explains exactly what Grafana does when it is started for the
> first time from a completely clean checkout — with **no `custom.ini`, no environment variables, and
> no manual setup** — and why later runs behave differently. Every behavioral claim below was produced
> by **building and running the real `grafana server` entry point** and capturing its actual output;
> nothing here is inferred from reading code alone unless it is explicitly labeled **(inferred)**.

## Provenance & how this was produced

| Field | Value |
|-------|-------|
| Repository HEAD (commit) | `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` |
| Source branch (origin of this file's name) | `grafana_4550cfb5b728` |
| Observed build identity | `version=9.2.0 commit=NA branch=main` — **default-build value**, see Q5 |
| Toolchain used | Go `1.23.1` (`go.mod:3`), GCC `15.2.0` (Cgo for the SQLite driver), Node `v22.23.1` (observed container runtime; repo pins `.nvmrc` = `v22.11.0` — reconciled in Q5b), Yarn `4.5.3` |
| HTTP port observed | `3000` (`conf/defaults.ini:41`) |
| Database observed | SQLite at `data/grafana.db` (`conf/defaults.ini:123,164`) |

**Exact build commands used** (from the repository root):

```bash
# 1) Generate the Google Wire dependency-injection code (REQUIRED before the backend compiles).
#    Makefile target `gen-go` at Makefile:167, recipe at Makefile:169, WIRE_TAGS="oss" at Makefile:5.
make gen-go

# 2) Build the single self-contained server binary (Cgo on for the SQLite driver).
CGO_ENABLED=1 GOFLAGS=-mod=readonly go build -tags oss -o /tmp/grafana ./pkg/cmd/grafana
```

**Exact run command used** (the real, canonical entry point — no config file, no `GF_*` env vars):

```bash
# `grafana` is the binary; `server` is the subcommand; --homepath points at the repo root so
# conf/defaults.ini is discovered. This is the exact command for BOTH run 1 and run 2.
/tmp/grafana server --homepath="$(pwd)"
```

`go run` was also exercised and is equivalent to the built binary for the code path under test (see Q5b):

```bash
go run -tags oss ./pkg/cmd/grafana -v      # -> "grafana version 9.2.0" (identical to the built binary)
```

**Toolchain versions actually observed** (each value is the verbatim output of the command shown, in this
container; the two Node values — observed runtime vs. repo-pinned `.nvmrc` — are reconciled in Q5b):

```bash
go version        # -> go version go1.23.1 linux/amd64
gcc --version     # -> gcc (Ubuntu 15.2.0-4ubuntu4) 15.2.0   (first line)
node --version    # -> v22.23.1     (container runtime actually used for this run)
cat .nvmrc        # -> v22.11.0     (the Node version the repository pins)
yarn --version    # -> 4.5.3        (matches package.json:453 packageManager yarn@4.5.3)
```

The default configuration source is `conf/defaults.ini` — its header says
`# Do not modify this file in grafana installs` (`conf/defaults.ini:3`) and overrides are meant to go in
`custom.ini`/environment variables. For this investigation **no `custom.ini` and no `GF_*` variables were
supplied**, so `defaults.ini` is the effective configuration a normal first-run user gets. Any mention of
`custom.ini`/env below is clearly labeled **illustrative contrast** and is never the primary answer.

---

## TL;DR — the puzzle solved in one paragraph

On the very first launch, Grafana **bootstraps itself entirely from built-in defaults**: it loads
`conf/defaults.ini`, chooses SQLite, **creates `data/grafana.db`**, runs **626 schema migrations**,
**creates a real `admin` user** (login `admin`, password `admin`), loads **54 compiled-in core plugins**,
and starts the HTTP server on `:3000`. It "just works" because none of that requires configuration — the
defaults are compiled in. It **behaves differently on later runs** because that first run wrote persistent
state to disk under `data/`: the second run finds the 626 migrations already recorded and the `admin` user
already present, so it **skips** both (`performed=0 skipped=626`, no "Created default admin" line) and its
log shrinks from **1357 lines to 62 lines**. You can log in with credentials you "never set up" because
`admin`/`admin` are the **built-in security defaults** (`conf/defaults.ini:328,331`) and Grafana seeds that
account on first run — it is a **real account**, not anonymous mode (anonymous auth is **disabled** by
default, `conf/defaults.ini:650`). Plugins "appear that you never installed" because they are **compiled
into the binary** (core plugins), not downloaded — `/api/plugins` returns **49** of them, every one with
`signature=internal`, and **nothing is fetched remotely** on a default start (the one background
install attempt, for `grafana-lokiexplore-app`, fails explicitly as version-incompatible). Finally, the
runtime depends on one **generated** file — `pkg/server/wire_gen.go` (produced by `make gen-go`) — without
which the backend does not compile; `go run` and a pre-built binary are equivalent because both compile
that same generated file into the program.

---

## Q1 — Automatic initialization, and why some subsystems log "disabled/skipped" while others succeed with nothing configured

### Q1a — What automatic decisions does the system make on a fresh environment?

**Direct answer.** With nothing configured, Grafana makes every decision from compiled-in defaults, in this
order: (1) it loads configuration from `conf/defaults.ini`; (2) it selects **operating mode `production`**
and **target `[all]`**; (3) it resolves all on-disk paths relative to `--homepath`; (4) it turns on a fixed
set of **56 feature toggles**; (5) it connects to SQLite, **creating `data/grafana.db`** because it does not
exist; (6) it runs the full **626-migration** schema build; (7) it **seeds the default `admin` account**;
(8) it loads **54 core plugins**; and (9) it starts the HTTP listener on `:3000`. The lifecycle is driven by
`Server.Init()` (`pkg/server/server.go:113`) followed by `Server.Run()` (`pkg/server/server.go:139`).

`Server.Init()` performs the one-time setup steps: it calls `s.writePIDFile()`
(`pkg/server/server.go:122`) — which on a canonical start writes **nothing**, because
`func (s *Server) writePIDFile()` returns early at its first statement (`if s.pidFile == "" { return nil }`,
`pkg/server/server.go:206`) and `s.pidFile` is populated only from the **optional** `--pidfile` CLI flag
(`Name: "pidfile"`, `pkg/cmd/grafana-server/commands/flags.go:40`, wired into `server.Options` at
`pkg/cmd/grafana-server/commands/cli.go:111`), which the default invocation does not supply. It then
registers fixed RBAC roles via `s.roleRegistry.RegisterFixedRoles(...)` (`pkg/server/server.go:130`), and
runs initial provisioners via `s.provisioningService.RunInitProvisioners(...)` (`pkg/server/server.go:134`).

**Command & captured evidence** (first clean start; the salient banner/init lines, verbatim):

```bash
/tmp/grafana server --homepath="$(pwd)" > /tmp/run1.log 2>&1 &
run1_pid=$!                              # capture the exact PID (so shutdown can target this process only)
sleep 8                                  # allow the first-run bootstrap (DB create + 626 migrations) to finish
grep -E 'Starting Grafana|Config loaded from|msg=Target|Path (Home|Data|Logs|Plugins|Provisioning)|App mode|FeatureToggles|Connecting to DB' /tmp/run1.log
# run 1 stays up to serve the Q3/Q4 API probes; when finished, stop exactly this process with:
#   kill "$run1_pid"; wait "$run1_pid" 2>/dev/null || true   (never pkill — that could hit other processes)
```

```text
logger=settings level=info msg="Starting Grafana" version=9.2.0 commit=NA branch=main compiled=2026-07-08T04:35:14Z
logger=settings level=info msg="Config loaded from" file=/tmp/blitzy/grafana/blitzy-be62cb50-4773-4f3d-9f1d-158ac43cc059_07eb51/conf/defaults.ini
logger=settings level=info msg=Target target=[all]
logger=settings level=info msg="Path Home" path=/tmp/blitzy/grafana/blitzy-be62cb50-4773-4f3d-9f1d-158ac43cc059_07eb51
logger=settings level=info msg="Path Data" path=/tmp/blitzy/grafana/blitzy-be62cb50-4773-4f3d-9f1d-158ac43cc059_07eb51/data
logger=settings level=info msg="Path Logs" path=/tmp/blitzy/grafana/blitzy-be62cb50-4773-4f3d-9f1d-158ac43cc059_07eb51/data/log
logger=settings level=info msg="Path Plugins" path=/tmp/blitzy/grafana/blitzy-be62cb50-4773-4f3d-9f1d-158ac43cc059_07eb51/data/plugins
logger=settings level=info msg="Path Provisioning" path=/tmp/blitzy/grafana/blitzy-be62cb50-4773-4f3d-9f1d-158ac43cc059_07eb51/conf/provisioning
logger=settings level=info msg="App mode production"
logger=featuremgmt level=info msg=FeatureToggles logRowsPopoverMenu=true openSearchBackendFlowEnabled=true managedPluginsInstall=true ... preinstallAutoUpdate=true ... prometheusConfigOverhaulAuth=true
logger=sqlstore level=info msg="Connecting to DB" dbtype=sqlite3
```

**Cause → effect.**
- `msg="Config loaded from" file=.../conf/defaults.ini` — because no `custom.ini`/env override was given,
  the effective configuration is `conf/defaults.ini`. `app_mode = production` comes from
  `conf/defaults.ini:7`.
- The `Path *` lines are the `[paths]` defaults resolved against `--homepath`: `data = data`
  (`conf/defaults.ini:15`), `logs = data/log` (`conf/defaults.ini:21`), `plugins = data/plugins`
  (`conf/defaults.ini:24`), `provisioning = conf/provisioning` (`conf/defaults.ini:27`).
- `msg=Target target=[all]` means every server target runs in a single process (the monolith).
- The `FeatureToggles` line lists **56** flags reported `=true` — these are the compiled-in default-on
  toggles (e.g., `dashboardScene`, `nestedFolders`, `managedPluginsInstall`, `preinstallAutoUpdate`); the
  last two directly cause the background plugin-install attempt discussed in Q4.
- `msg="Connecting to DB" dbtype=sqlite3` follows from `[database] type = sqlite3`
  (`conf/defaults.ini:123`).

### Q1b — Why do some subsystems log "disabled"/"skipped" while others report success, with nothing configured?

**Direct answer.** Because "disabled" is a **normal default state, not an error**. `Server.Run()` iterates
the background-service registry and, for each service, calls `registry.IsDisabled(svc)`
(`pkg/server/server.go:150`). A service is skipped **only** if it implements the `CanBeDisabled` interface
**and** reports itself disabled; the skip is **silent** (the loop simply `continue`s). Services that do not
implement `CanBeDisabled`, or that are enabled by default, are started normally in an errgroup goroutine.
Nothing has to be configured for this to happen — the enabled/disabled decision is baked into each service
and the default feature-toggle set.

The gate is tiny and worth quoting in full — `func IsDisabled` in `pkg/registry/registry.go:53-56`:

```go
func IsDisabled(srv BackgroundService) bool {
	canBeDisabled, ok := srv.(CanBeDisabled)
	return ok && canBeDisabled.IsDisabled()
}
```

And the loop that consumes it, in `func (s *Server) Run()` (`pkg/server/server.go:139`, loop body around
`pkg/server/server.go:149-150`):

```go
services := s.backgroundServices          // pkg/server/server.go:146
// ...
for _, svc := range services {            // pkg/server/server.go:149
	if registry.IsDisabled(svc) {         // pkg/server/server.go:150
		continue                          // silently skip a disabled service
	}
	// ... started via s.childRoutines.Go(func() error { ... }) with
	//     serviceName := reflect.TypeOf(service).String()
}
```

**Command & captured evidence.** The categories are observable in the startup log. Examples of services
**reporting success** vs. a subsystem announcing its enabled/disabled state:

```bash
grep -E 'Envelope encryption state|migrations completed|Plugins loaded|HTTP Server Listen' /tmp/run1.log
```

```text
logger=secrets level=info msg="Envelope encryption state" enabled=true currentprovider=secretKey.v1
logger=migrator level=info msg="migrations completed" performed=626 skipped=0 duration=7.101739554s
logger=plugin.store level=info msg="Plugins loaded" count=54 duration=33.910759ms
logger=http.server level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=
```

**Cause → effect and the three categories observed.**
- **Always-on services** (no `CanBeDisabled`, or enabled by default) start and log success — e.g. the
  `migrator`, `plugin.store`, `secrets`, and `http.server` lines above. `secrets` explicitly reports its
  state as `enabled=true`.
- **Feature-toggle-gated behavior** — the 56 `=true` toggles on the `FeatureToggles` line switch specific
  code paths on; a toggle that is off (absent from the `=true` list) leaves its feature dormant. This is a
  default decision, not a failure.
- **Config-gated / interface-gated services** — any service implementing `CanBeDisabled` that returns
  `true` from `IsDisabled()` is skipped **without a log line** by `pkg/server/server.go:150`. That silence
  is by design: the loop `continue`s. **(inferred, from code)** the *absence* of certain service log lines
  on a default start is the observable signature of this skip, since the skip itself emits nothing.

The reason a fresh, unconfigured instance shows a healthy mix of "started" messages and *no* fatal errors
is that every default is self-contained: the database is embedded (SQLite), the plugins are compiled in,
and disabled optional subsystems are simply passed over rather than erroring out.

---

## Q2 — What persistent state is created, where it lives, and why subsequent runs differ

### Q2a — What state gets created, and where on disk does it live?

**Direct answer.** The first run creates a **SQLite database at `data/grafana.db`** plus the runtime
sub-directories `data/log/` (with `grafana.log`), `data/csv/`, `data/pdf/`, and `data/png/`. All of it lives
under the `data/` directory (relative to `--homepath`). **No PID file is written on a canonical start** —
`writePIDFile()` returns early unless the optional `--pidfile` flag is supplied (see Q1a), which is exactly
why the `find data` listing below contains no PID file. The database is where the durable state lives: the
`migration_log`, `user`, `org`, and `org_user` tables are all populated on first run; `data_source` is
created but left empty.

The locations come straight from `conf/defaults.ini`: `[paths] data = data` (`conf/defaults.ini:15`) and
`logs = data/log` (`conf/defaults.ini:21`); `[database] type = sqlite3` (`conf/defaults.ini:123`) with
`path = grafana.db` (`conf/defaults.ini:164`) — combined, the SQLite file is `data/grafana.db`. These keys
are bound into the runtime `Cfg` by `pkg/setting/setting.go`, and the SQLite file is created by the
`*SQLStore` in `pkg/services/sqlstore/sqlstore.go`.

**Command & captured evidence — the "creating the DB" line and the on-disk tree:**

```bash
grep "Creating SQLite database file" /tmp/run1.log
find data | sort
```

```text
logger=sqlstore level=info msg="Creating SQLite database file" path=/tmp/blitzy/grafana/blitzy-be62cb50-4773-4f3d-9f1d-158ac43cc059_07eb51/data/grafana.db
```

```text
data
data/csv
data/grafana.db
data/log
data/log/grafana.log
data/pdf
data/png
```

> **Observed vs. expected note.** `data/plugins/` is **not** created on this default start even though
> `[paths] plugins = data/plugins` (`conf/defaults.ini:24`) points there — the directory simply does not
> exist because no external plugins are installed, which is exactly why the `plugin.sources` and
> `renderer.manager` subsystems log `failed to open plugins path` (reported as-observed in Q4/edge states).

**Command & captured evidence — the durable tables (read with the SQLite file after the run):**

```bash
python3 - <<'PY'
import sqlite3
c = sqlite3.connect("data/grafana.db")
print("migration_log      :", c.execute("SELECT COUNT(*) FROM migration_log").fetchone()[0])
print("migration_log ok=1 :", c.execute("SELECT COUNT(*) FROM migration_log WHERE success=1").fetchone()[0])
print("user               :", c.execute("SELECT id, login, email, is_admin FROM user").fetchall())
print("org                :", c.execute("SELECT id, name FROM org").fetchall())
print("org_user           :", c.execute("SELECT org_id, user_id, role FROM org_user").fetchall())
print("data_source        :", c.execute("SELECT COUNT(*) FROM data_source").fetchone()[0])
PY
```

```text
migration_log      : 626
migration_log ok=1 : 626
user               : [(1, 'admin', 'admin@localhost', 1)]
org                : [(1, 'Main Org.')]
org_user           : [(1, 1, 'Admin')]
data_source        : 0
```

**Cause → effect.** The schema is built by the migration engine
(`github.com/golang-migrate/migrate/v4 v4.7.0`, `go.mod:66`), which records **one row per applied migration**
in `migration_log` — hence 626 rows, all `success=1`, matching the `performed=626` log line. The single
`user` row and the `Main Org.` row are produced by the admin-seed path (Q3). `data_source` is empty because
nothing provisions one by default (Q4).

### Q2b — Why do subsequent runs behave differently, and why does the difference persist across stop/restart?

**Direct answer.** Because the first run **wrote persistent state to disk under `data/`**, and every later
run finds and reuses it. Two concrete mechanisms produce the visible difference: **(1)** the migrator sees
the 626 migrations already recorded in `migration_log` and **skips all of them** (`performed=0 skipped=626`)
instead of executing them; **(2)** the admin seed is **idempotent** — `ensureMainOrgAndAdminUser`
(`pkg/services/sqlstore/sqlstore.go:190`) counts existing users and **returns early** when the count is
greater than zero, so no "Created default admin" line is emitted on run 2. The difference survives stop and
restart because the state lives in the on-disk SQLite file `data/grafana.db`, **not** in memory.

The idempotency guard is in `func (ss *SQLStore) ensureMainOrgAndAdminUser(test bool) error`
(`pkg/services/sqlstore/sqlstore.go:190`): it runs `SELECT COUNT(id) AS Count FROM "user"`, and

```go
if stats.Count > 0 {
	return nil            // users already exist -> do NOT seed again (no "Created default admin")
}
```

so on run 2, with one `admin` user already present, it short-circuits before the create path.

**Command & captured evidence — run the identical command a second time and diff the two logs:**

```bash
# Precondition: run 1 has already served its Q3/Q4 API probes and been stopped with its OWN targeted
# shutdown — kill "$run1_pid"; wait "$run1_pid" 2>/dev/null || true — so port :3000 is free (never pkill).
# Run 2: IDENTICAL command, but data/ now holds run 1's state.
/tmp/grafana server --homepath="$(pwd)" > /tmp/run2.log 2>&1 &
run2_pid=$!                              # capture run 2's PID for a clean, targeted shutdown
sleep 8                                  # run 2's startup is much shorter (migrations already applied)
kill "$run2_pid"; wait "$run2_pid" 2>/dev/null || true   # stop run 2; both logs are now complete
# Compare volumes and the decisive lines:
echo "run1 lines: $(wc -l < /tmp/run1.log)   run2 lines: $(wc -l < /tmp/run2.log)"
grep -c "Executing migration"            /tmp/run1.log /tmp/run2.log
grep    "migrations completed"           /tmp/run1.log /tmp/run2.log | grep -v resource-migrator
grep -c "Creating SQLite database file"  /tmp/run1.log /tmp/run2.log
grep -c "Created default admin"          /tmp/run1.log /tmp/run2.log
```

```text
run1 lines: 1357   run2 lines: 62
/tmp/run1.log:644
/tmp/run2.log:0
/tmp/run1.log:logger=migrator level=info msg="migrations completed" performed=626 skipped=0 duration=7.101739554s
/tmp/run2.log:logger=migrator level=info msg="migrations completed" performed=0 skipped=626 duration=729.45µs
/tmp/run1.log:1
/tmp/run2.log:0
/tmp/run1.log:1
/tmp/run2.log:0
```

**Command & captured evidence — the DB is unchanged after run 2 (admin is not duplicated):**

```bash
python3 - <<'PY'
import sqlite3
c = sqlite3.connect("data/grafana.db")
print("migration_log:", c.execute("SELECT COUNT(*) FROM migration_log").fetchone()[0])
print("user         :", c.execute("SELECT id, login, email, is_admin FROM user").fetchall())
PY
```

```text
migration_log: 626
user         : [(1, 'admin', 'admin@localhost', 1)]
```

**Cause → effect — the run-to-run difference, fully accounted for.**
- The entire log-volume gap (1357 → 62 lines) is dominated by the **644 `Executing migration` lines** that
  appear on run 1 and are completely absent on run 2 (626 from the main `migrator` + 18 from the unified
  `resource-migrator`). On run 2 the migrator still runs — both runs show `Locking database` / `Starting DB
  migrations` twice — but it finds all 626 recorded and reports `performed=0 skipped=626` in 729 µs versus
  7.10 s on run 1.
- No `Creating SQLite database file` line on run 2 because `data/grafana.db` already exists.
- No `Created default admin` line on run 2 because of the `stats.Count > 0` early return
  (`pkg/services/sqlstore/sqlstore.go:190`).

> **Run-to-run distribution note (magnitude is stable in its *deterministic* part; the total jitters ±1–2
> lines).** Repeating the identical clean start multiple times, the **decisive counts are perfectly stable**
> across runs — run 1 always shows `performed=626 skipped=0` with exactly **644** `Executing migration` lines,
> and run 2 always shows `performed=0 skipped=626` with **0** — which is what makes run 1's log more than 20×
> larger than run 2's. The **grand total** line count, however, is not bit-stable: across repeated runs the
> run-1 total was observed at **1355–1357** and the run-2 total at **62–63**. The wobble comes entirely from
> the asynchronous, post-`HTTP Server Listen` region (the update-checker, `grafana-apiserver` GroupVersion
> registrations, `resource-server` metric-collector warnings, the background plugin-install attempt, and the
> shutdown sequence) plus the number of `/api/*` probes issued during the run (each request emits its own log
> lines) — none of which is part of the first-run/second-run *state* difference. The `1357 → 62` figures
> quoted above are therefore a representative, reproduced sample of that small band, not a fixed constant; the
> stable, causal signal is the 644-vs-0 migration execution.

**State transitions (before → during → after), observed:**

| Phase | `data/` | `migration_log` | `user` |
|-------|---------|-----------------|--------|
| Before run 1 | absent (`ls data` → *No such file or directory*) | — | — |
| During run 1 | `grafana.db` created; migrations executing | filling to 626 | admin being created |
| After run 1 | `grafana.db` (1,093,632 bytes) + `log/csv/pdf/png` | 626 (all `success=1`) | 1 (`admin`) |
| After run 2 | unchanged | 626 (unchanged) | 1 (not duplicated) |


---

## Q3 — How you can log in with credentials you never set up; the real security defaults; account vs. anonymous

### Q3a — How can you log in, and what are the actual security defaults?

**Direct answer.** You log in with **`admin` / `admin`** because those are the **built-in security defaults**
compiled into the binary via `conf/defaults.ini`, and the first run turns them into a real account. The
default security posture is: initial admin creation **enabled** (`disable_initial_admin_creation = false`),
self-service sign-up **disabled** (`allow_sign_up = false`), anonymous access **disabled**
(`[auth.anonymous] enabled = false`), and password-based basic auth **enabled** (`[auth.basic] enabled =
true`). On first successful login Grafana forces a password change.

The default values, verbatim from `conf/defaults.ini`:

| Setting | Value | Location |
|---------|-------|----------|
| `admin_user` | `admin` | `conf/defaults.ini:328` |
| `admin_password` | `admin` | `conf/defaults.ini:331` |
| `admin_email` | `admin@localhost` | `conf/defaults.ini:334` |
| `disable_initial_admin_creation` | `false` | `conf/defaults.ini:325` |
| `[users] allow_sign_up` | `false` | `conf/defaults.ini:483` |
| `[auth.anonymous] enabled` | `false` | `conf/defaults.ini:650` |
| `[auth.basic] enabled` | `true` | `conf/defaults.ini:875` |

These keys are bound into the runtime `*setting.Cfg` in `pkg/setting/setting.go`:

```go
cfg.DisableInitAdminCreation = security.Key("disable_initial_admin_creation").MustBool(false) // setting.go:1580
cfg.AdminUser     = valueAsString(security, "admin_user", "")                                  // setting.go:1581
cfg.AdminPassword = valueAsString(security, "admin_password", "")                              // setting.go:1582
cfg.AdminEmail    = valueAsString(security, "admin_email", fmt.Sprintf("%s@localhost", cfg.AdminUser)) // setting.go:1583
```

(The corresponding `Cfg` fields are declared at `pkg/setting/setting.go:157` `DisableInitAdminCreation`,
`:237` `AdminUser`, `:238` `AdminPassword`, `:240` `AdminEmail`.)

**Command & captured evidence — basic auth with the never-configured credentials works, anonymous does not:**

```bash
# Unauthenticated request to a protected endpoint:
curl -s http://localhost:3000/api/plugins
# Same request WITH the default credentials:
curl -s -u admin:admin http://localhost:3000/api/plugins | python3 -c "import sys,json;print('plugins returned:',len(json.load(sys.stdin)))"
```

```text
{"extra":null,"message":"Unauthorized","messageId":"auth.unauthorized","statusCode":401,"traceID":""}
plugins returned: 49
```

The `401` on the unauthenticated call is the direct, observable consequence of `[auth.anonymous] enabled =
false` (`conf/defaults.ini:650`): with anonymous access off, a protected endpoint rejects the request; the
same endpoint succeeds once the built-in `admin`/`admin` basic-auth credentials are supplied
(`[auth.basic] enabled = true`, `conf/defaults.ini:875`).

The forced first-login password change is documented in `contribute/developer-guide.md:131` ("When you log
in for the first time, Grafana asks you to change your password.").

### Q3b — Did the system create an account, or is it running in a permissive/anonymous mode?

**Direct answer.** A **real `admin` account is created** on the first run — this is **not** anonymous or
permissive mode. The account is seeded by `ensureMainOrgAndAdminUser`
(`pkg/services/sqlstore/sqlstore.go:190`), which (when no users exist yet and
`DisableInitAdminCreation` is false) calls `ss.createUser(...)` with
`user.CreateUserCommand{Login: ss.cfg.AdminUser, Email: ss.cfg.AdminEmail,
Password: user.Password(ss.cfg.AdminPassword), IsAdmin: true}` and then logs the event at
`pkg/services/sqlstore/sqlstore.go:222`.

**Command & captured evidence — the creation event and the resulting real row:**

```bash
grep "Created default admin" /tmp/run1.log
python3 -c "import sqlite3;print(sqlite3.connect('data/grafana.db').execute('SELECT id,login,email,is_admin,is_disabled FROM user').fetchall())"
```

```text
logger=sqlstore level=info msg="Created default admin" user=admin
[(1, 'admin', 'admin@localhost', 1, 0)]
```

**Cause → effect.** The `user` table holds a genuine row (`id=1`, `login=admin`, `email=admin@localhost`,
`is_admin=1`, `is_disabled=0`) linked to `Main Org.` as an `Admin` (`org_user` row `(1, 1, 'Admin')`, shown
in Q2). Access therefore requires *these created credentials* — there is no anonymous fall-through, because
`[auth.anonymous] enabled = false` (`conf/defaults.ini:650`), which we confirmed via the `401` above. On run
2 the same `ensureMainOrgAndAdminUser` path takes its `stats.Count > 0` early return, so the account is not
re-created (see Q2b).

**Canonical-defaults cross-check (web).** External documentation confirms these are the *canonical* Grafana
defaults, not an artifact of this checkout. Each upstream source is cited below, and every observed value
matches it:

- **Default login `admin`/`admin`, with a forced password change on first login** — Grafana's official
  "Sign in to Grafana" guide instructs you to enter `admin` for both username and password and states that a
  successful sign-in shows a prompt to change the password:
  <https://grafana.com/docs/grafana/latest/setup-grafana/sign-in-to-grafana/>. This matches the seeded
  `admin` / `admin@localhost` row observed above and `contribute/developer-guide.md:131`.
- **`admin_user` defaults to `admin` and `admin_email` to `admin@localhost`** — Grafana's "Configure
  Grafana" reference documents both as the built-in defaults, created on startup:
  <https://grafana.com/docs/grafana/latest/administration/configuration/>. This matches
  `conf/defaults.ini:328` (`admin_user = admin`) and `conf/defaults.ini:334` (`admin_email = admin@localhost`).
- **Anonymous access is disabled by default** — Grafana's "Configure anonymous access" page shows that you
  must explicitly set `[auth.anonymous] enabled = true` to turn it on (i.e., it is off unless enabled):
  <https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/anonymous-auth/>.
  This matches `conf/defaults.ini:650` (`enabled = false`) and the `401` observed above.
- **Basic (password) authentication is enabled by default** — Grafana's "Configure basic authentication"
  page describes it as providing "password authentication enabled by default":
  <https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/grafana/>.
  This matches `conf/defaults.ini:875` (`[auth.basic] enabled = true`).


---

## Q4 — Compiled-in vs. disk-discovered vs. remote-fetched plugins; what the API exposes; why plugins "appear"

### Q4a — The three plugin sources and their relationship

**Direct answer.** On a default start there are effectively three *potential* sources, but only the first two
supply anything: **(1) compiled-in core** plugins (their backends are registered from a Go map that is part
of the binary), **(2) on-disk core front-ends** read from `public/app/plugins/`, and **(3) remote fetch** —
which contributes **nothing** on a default start. Every plugin that becomes available is **core**; nothing is
successfully downloaded.

**(1) Compiled-in core backends.** The backend datasource factories are registered by
`func ProvideCoreRegistry(...)` (`pkg/plugins/backendplugin/coreplugin/registry.go:95`), which calls
`func NewRegistry(store map[string]backendplugin.PluginFactoryFunc)`
(`pkg/plugins/backendplugin/coreplugin/registry.go:89`). The map contains **exactly 18** backend
datasource factories (map keys, verbatim):

```
CloudWatch, CloudMonitoring, AzureMonitor, Elasticsearch, Graphite, InfluxDB, Loki, OpenTSDB,
Prometheus, Tempo, TestData, PostgreSQL, MySQL, MSSQL, Grafana, Pyroscope, Parca, Zipkin
```

Only core plugins get a backend factory: `BackendFactoryProvider()` gates with
`if !p.IsCorePlugin() { return nil }` in the same file.

**(2) On-disk core front-ends.** The front-end assets for core plugins live under `public/app/plugins/`,
which contains **only** the subdirectories `datasource/` and `panel/` (plus `gen.go` and `sdk.ts`).
**There is no `app/` subdirectory** in this checkout. These are loaded at startup by the plugin loader.

**(3) Remote fetch — not exercised successfully.** The classification that separates core from external is
`if cl == plugins.ClassCore {` (`pkg/services/pluginsintegration/pipeline/steps.go:231`); the class of a
source is reported by `PluginSource.PluginClass(ctx) Class` (`pkg/plugins/ifaces.go:20-21`). A remote
install would go through the `Installer` interface — `Add(ctx, pluginID, version string, opts AddOpts)
error` (`pkg/plugins/ifaces.go:13-15`) — but on a default start the only invocation of that path is an
automatic background pre-install that **fails** (below).

**Command & captured evidence — what the loader reports, and the absence of any successful remote fetch:**

```bash
grep -E 'Plugins loaded|Failed to load external plugins|Failed to get renderer plugin sources|Installing plugin|Failed to install plugin|Update check succeeded' /tmp/run1.log
```

```text
logger=plugin.store level=info msg="Plugins loaded" count=54 duration=33.910759ms
logger=plugin.sources level=error msg="Failed to load external plugins" error="failed to open plugins path"
logger=renderer.manager level=error msg="Failed to get renderer plugin sources" error="failed to open plugins path"
logger=plugin.backgroundinstaller level=info msg="Installing plugin" pluginId=grafana-lokiexplore-app version=
logger=grafana.update.checker level=info msg="Update check succeeded" duration=38.937966ms
logger=plugins.update.checker level=info msg="Update check succeeded" duration=41.307876ms
logger=plugin.backgroundinstaller level=error msg="Failed to install plugin" pluginId=grafana-lokiexplore-app version= error="[plugin.grafanaVersionNotCompatible] grafana-lokiexplore-app is not compatible with your Grafana version: 9.2.0"
```

**Cause → effect.**
- `Plugins loaded count=54` — the loader found and loaded 54 **core** plugins (compiled-in backends + the
  on-disk `public/app/plugins/{datasource,panel}` front-ends). See the count reconciliation in Q4b.
- `Failed to load external plugins ... failed to open plugins path` and the two `renderer.manager` errors —
  the external-plugin directory `data/plugins/` does not exist (nothing installed), so the external and
  renderer sources have nothing to open. Reported **as-observed**; not fixed.
- The two `Update check succeeded` lines are outbound *checks* that install nothing. The single
  `Installing plugin pluginId=grafana-lokiexplore-app` attempt (triggered by the default-on toggles
  `preinstallAutoUpdate=true` and `managedPluginsInstall=true` from Q1) **fails explicitly** with
  `[plugin.grafanaVersionNotCompatible] ... is not compatible with your Grafana version: 9.2.0`. So nothing
  is silently fetched — the one attempt errors out. This is why, on a default build, the plugin set is
  entirely compiled-in core.

### Q4b — What actually becomes available via the API, and why plugins appear that the user never installed

**Direct answer.** `/api/plugins` returns **49** plugins — **30 panels and 19 datasources** — and **every
one has `signature=internal`**. The `data_source` table is **empty (0 rows)**. Plugins "appear that you never
installed" because they are **shipped compiled into the binary as core plugins**; but a plugin being
*available* is not the same as a *data source existing* — no data source exists until one is provisioned or
created, hence the empty `data_source` table.

**Command & captured evidence — the API result, the exact count, and that all are `internal`:**

```bash
curl -s -u admin:admin http://localhost:3000/api/plugins > /tmp/plugins.json
python3 - <<'PY'
import json, collections
d = json.load(open("/tmp/plugins.json"))
print("total          :", len(d))
print("by type        :", dict(collections.Counter(p["type"] for p in d)))
print("by signature   :", dict(collections.Counter(p["signature"] for p in d)))
PY
```

```text
total          : 49
by type        : {'panel': 30, 'datasource': 19}
by signature   : {'internal': 49}
```

The 19 datasources returned by the API (ids): `alertmanager, cloudwatch, elasticsearch,
grafana-azure-monitor-datasource, grafana-postgresql-datasource, grafana-pyroscope-datasource,
grafana-testdata-datasource, graphite, influxdb, jaeger, loki, mssql, mysql, opentsdb, parca, prometheus,
stackdriver, tempo, zipkin`.

**Command & captured evidence — no data source exists, and the health endpoint:**

```bash
python3 -c "import sqlite3;print('data_source rows:',sqlite3.connect('data/grafana.db').execute('SELECT COUNT(*) FROM data_source').fetchone()[0])"
curl -s http://localhost:3000/api/health
```

```text
data_source rows: 0
{"database": "ok","version": "9.2.0","commit": "NA"}
```

**Reconciling the two counts (54 loaded vs. 49 in the API) — grounded, not papered over.** The loader logs
`count=54`, but `/api/plugins` returns 49. The difference is 5 internal plugins that the loader counts but
`/api/plugins` does not surface: the datasources **`dashboard`, `grafana`, `mixed`** (the three built-in
"utility" datasources that appear in `/api/frontend/settings` as `-- Dashboard --`, `-- Grafana --`,
`-- Mixed --`) and the panels **`debug`, `live`**. On disk, `public/app/plugins/` holds **22** datasource
directories and **32** panel directories = **54** (matching the loader); subtracting those 5 yields the
**49** the API returns. Both numbers are therefore correct and consistent — they measure different things
(everything loaded vs. everything listed by the plugins API).

**Why nothing is auto-provisioned (grounded on the empty table, not just on comments).** The default
provisioning samples under `conf/provisioning/{access-control,alerting,dashboards,datasources,plugins}/`
are inert: `access-control/sample.yaml` has zero uncommented lines, and the other four contain only
`apiVersion: 1` (a schema-version header, not a resource). The decisive evidence, however, is the
runtime-observed **`data_source` = 0 rows** above — the provisioner ran (`provisioning.dashboard` and
`provisioning.alerting` both logged "starting"/"finished") and created nothing.


---

## Q5 — Generated files the runtime depends on; is `go run` equivalent to building first; artifacts that must exist

### Q5a — Which generated files does the runtime depend on?

**Direct answer.** The backend depends on **one generated Go source file — `pkg/server/wire_gen.go`** —
produced by Google Wire via `make gen-go`. Without it, the `pkg/server` package (and therefore
`./pkg/cmd/grafana`) **does not compile**. Separately, the front-end build output `public/build` is a
runtime asset: when it is missing, the server logs a **non-fatal** error and keeps serving the API. A minor
embedded asset (`cue.mod/module.cue`, via `embed.go`) is compiled into the binary.

**Command & captured evidence — compile FAILS without `wire_gen.go`:**

```bash
# Move the generated file ASIDE to reproduce a genuine clean checkout, build (which fails), then RESTORE
# it immediately and verify the working tree is byte-for-byte unchanged. `wire_gen.go` is gitignored
# (`.gitignore:194`), so this whole sequence leaves the repository clean.
sha_before=$(sha256sum pkg/server/wire_gen.go | cut -d' ' -f1)
mv pkg/server/wire_gen.go /tmp/wire_gen.go.moved                                    # move aside
CGO_ENABLED=1 GOFLAGS=-mod=readonly go build -tags oss -o /tmp/grafana ./pkg/cmd/grafana; echo "EXIT_CODE=$?"
mv /tmp/wire_gen.go.moved pkg/server/wire_gen.go                                    # RESTORE immediately
sha_after=$(sha256sum pkg/server/wire_gen.go | cut -d' ' -f1)
[ "$sha_before" = "$sha_after" ] && echo "RESTORED: byte-identical ($sha_after)"
```

```text
# github.com/grafana/grafana/pkg/server
pkg/server/service.go:31:15: undefined: Initialize
EXIT_CODE=1
RESTORED: byte-identical (87899e3ddd41801a8ea6815a48bd31d092777f4fa1d04bb34cef162a34aa6e79)
```

**Cause → effect.** `pkg/server/service.go:31` calls `Initialize(s.cfg, s.opts, s.apiOpts)` — but
`Initialize` is the **Wire-generated** constructor emitted into `pkg/server/wire_gen.go` (function
`func Initialize(cfg *setting.Cfg, opts Options, apiOpts api.ServerOptions) (*Server, error)`). The
hand-written provider set lives in `pkg/server/wire.go` (build tag `//go:build wireinject`, importing
`github.com/google/wire`); Wire reads it and writes the concrete `wire_gen.go` (tagged `//go:build
!wireinject`, header `// Code generated by Wire. DO NOT EDIT.`). With the generated file removed, the
`Initialize` symbol is undefined and the package fails to build.

**Command & captured evidence — generate the file, then the build SUCCEEDS:**

```bash
make gen-go                                            # Makefile:167 target, recipe at Makefile:169, WIRE_TAGS="oss" (Makefile:5)
ls -l pkg/server/wire_gen.go
CGO_ENABLED=1 GOFLAGS=-mod=readonly go build -tags oss -o /tmp/grafana ./pkg/cmd/grafana; echo "EXIT_CODE=$?"
```

```text
generate go files
go run  ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server
wire: github.com/grafana/grafana/pkg/server: wrote /tmp/blitzy/grafana/blitzy-be62cb50-4773-4f3d-9f1d-158ac43cc059_07eb51/pkg/server/wire_gen.go
EXIT_CODE=0
```

(The built binary is ~285 MB, a single self-contained ELF executable serving both the API and the
front-end.)

**Command & captured evidence — the missing `public/build` is NON-FATAL:**

```bash
# With public/build absent (the genuine clean-checkout state, .gitignore:9), the server still starts:
grep "public/build" /tmp/run1.log
grep "HTTP Server Listen" /tmp/run1.log
curl -s http://localhost:3000/api/health
```

```text
logger=settings level=error msg="Failed to detect generated javascript files in public/build"
logger=http.server level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=
{"database": "ok","version": "9.2.0","commit": "NA"}
```

**Cause → effect.** `func (cfg *Cfg) validateStaticRootPath()` (`pkg/setting/setting.go:1034`) calls
`os.Stat(path.Join(cfg.StaticRootPath, "build"))` (`pkg/setting/setting.go:1039`); when that directory is
absent it logs `cfg.Logger.Error("Failed to detect generated javascript files in public/build")`
(`pkg/setting/setting.go:1040`) and then **`return nil`** — i.e. it does not propagate an error. That is why
a backend-only build (no front-end assets) still boots and serves the API: the missing `public/build`
produces an error-level log line only, not a fatal failure. This is exactly why a new team member sees the
server "just work" even without ever building the front-end.

**Why a fresh checkout is missing these files.** `.gitignore` marks all of these outputs untracked:
`/public/build` (`.gitignore:9`), `/data/*` (`.gitignore:72`), `/bin/*` (`.gitignore:73`), and
`**/wire_gen.go` (`.gitignore:194`). So a clean clone intentionally has neither `wire_gen.go` nor
`public/build` nor `data/` — they are produced by the build/run, which is precisely what makes the first
launch observably different from a checkout at rest.

### Q5b — Is `go run` equivalent to building first? Which artifacts must exist?

**Direct answer.** **Yes** — `go run` uses the **identical entry point and code path** as a pre-built
binary; both compile the same package set (including the generated `pkg/server/wire_gen.go`) and both need
that generated file to exist first. The only difference is that `go run` compiles a **throwaway** binary on
each invocation instead of reusing a persisted one. The **must-exist-for-compilation** artifact is
`pkg/server/wire_gen.go`; the **nice-to-have-at-runtime** artifact is `public/build` (its absence is
non-fatal).

**Command & captured evidence — `go run` yields the identical build identity as the binary:**

```bash
go run -tags oss ./pkg/cmd/grafana -v ; echo "GORUN_EXIT=$?"
/tmp/grafana -v
```

```text
grafana version 9.2.0
GORUN_EXIT=0
grafana version 9.2.0
```

**Cause → effect and the build identity.** Both invocations enter `func main()` in
`pkg/cmd/grafana/main.go`, which hands the build variables to `commands.ServerCommand(version, commit,
enterpriseCommit, buildBranch, buildstamp)`. Those variables are the hardcoded source defaults:
`var version = "9.2.0"` (`pkg/cmd/grafana/main.go:17`), `var commit = gcli.DefaultCommitValue`
(`pkg/cmd/grafana/main.go:18`), and `var buildBranch = "main"` (`pkg/cmd/grafana/main.go:20`). The comment
above them (`pkg/cmd/grafana/main.go:16`) notes they are overridable via `-X` linker flags; a plain
`go build`/`go run` supplies **no** `-X` ldflags, so the banner reports these defaults — hence the observed
`version=9.2.0 commit=NA branch=main`. **This is the default-build value, not a release version**, and it is
reported here exactly as produced rather than adjusted toward any expected release number.

**Toolchain that must be present.** Go `1.23.1` (`go.mod:3`) and GCC (for the Cgo SQLite driver,
`github.com/mattn/go-sqlite3`; see `contribute/developer-guide.md:12,135`) are required to build and run the
backend. A full front-end additionally requires Node and Yarn `4.5.3` (`package.json:453`) to produce
`public/build` — but, per Q5a, the backend serves without it. **Node version — observed vs. pinned (why the
header and this section differ):** the repository pins `.nvmrc` = `v22.11.0`, while the constraint in
`package.json:451` is only `"node": ">= 22"`. The container this run used actually reports
`node --version` = `v22.23.1` (captured in the Provenance "Toolchain versions actually observed" block).
Both `v22.11.0` and `v22.23.1` satisfy the `>= 22` engine constraint, so the two figures are **consistent,
not contradictory**: the header reports the version that was actually run, and `.nvmrc` reports the version
the repository recommends. Key generated/ORM/migration dependencies: `github.com/google/wire v0.6.0`
(`go.mod:72`, the codegen tool), `github.com/golang-migrate/migrate/v4 v4.7.0` (`go.mod:66`, drives
`migration_log`), and `xorm.io/xorm v0.8.2` (`go.mod:202`) replaced by the in-repo fork
`github.com/grafana/grafana/pkg/util/xorm v0.0.1` (`go.mod:537`).


---

## Edge, error, and transitional states (reported as-observed, not remediated)

Per the "exercise more than the happy path" requirement, the following boundary conditions were observed.
None were fixed; they are reported exactly as they appeared.

**1. Non-fatal `public/build` error (both runs).** As covered in Q5a, `validateStaticRootPath`
(`pkg/setting/setting.go:1034`) logs an error and returns `nil`; the server serves the API regardless.

**2. Missing plugins path — recurs on every run (not first-run-only).** Because `data/plugins/` is never
created on a default start, the following errors appear on **both** run 1 and run 2 (identical counts),
i.e. they are per-run conditions, **not** a first-run-only artifact:

```bash
for f in /tmp/run1.log /tmp/run2.log; do
  echo "== $f =="
  echo "renderer  : $(grep -c 'Failed to get renderer plugin sources' $f)"
  echo "external  : $(grep -c 'Failed to load external plugins' $f)"
  echo "installFail: $(grep -c 'Failed to install plugin' $f)"
  echo "updateCheck: $(grep -c 'Update check succeeded' $f)"
done
```

```text
== /tmp/run1.log ==
renderer  : 2
external  : 1
installFail: 1
updateCheck: 2
== /tmp/run2.log ==
renderer  : 2
external  : 1
installFail: 1
updateCheck: 2
```

**3. Incompatible background plugin install (both runs).** The default-on toggles `preinstallAutoUpdate` and
`managedPluginsInstall` trigger a background attempt to install `grafana-lokiexplore-app`, which fails with
`[plugin.grafanaVersionNotCompatible] ... is not compatible with your Grafana version: 9.2.0` (see Q4a).
This demonstrates nothing is *silently* fetched — the one remote attempt errors out loudly.

**4. First-run-only migration warnings.** Run 1's migrator emitted three
`level=warn msg="Skipping migration: Already executed, but not recorded in migration log"` lines (ids: `drop
unique orgID index on alert_configuration if exists`; `drop index UQE_dashboard_public_config_uid - v1`;
`drop index IDX_dashboard_public_config_org_id_dashboard_uid - v1`). These are warnings within the migration
engine and do not stop startup.

**5. Duplicate metrics-collector warnings (both runs).** `logger=resource-server level=warn msg="failed to
register storage metrics" error="duplicate metrics collector registration attempted"` appears three times
per run; non-fatal.

**Genuinely first-run-only events** (present in run 1, absent in run 2): `Creating SQLite database file`,
`Created default admin`, and the 644 `Executing migration` lines. Everything else — including the errors
above — recurs on every boot.

---

## Documentation vs. runtime reality

The onboarding docs frame the expected experience; the runtime confirms most of it and **extends** it with
details the docs do not mention. `README.md:35` and `CONTRIBUTING.md:74,84` both point contributors to
`contribute/developer-guide.md`, which documents:

| Doc claim | Location | Runtime observation |
|-----------|----------|---------------------|
| Backend built & run via `make run`; served at `http://localhost:3000/` | `developer-guide.md:119,123` | **Matches.** HTTP listener on `:3000` (`HTTP Server Listen address=[::]:3000`). (Note: `make run-go` adds dev/profile flags — `-profile -packaging=dev cfg:app_mode=development`, `Makefile:236` — so this doc used the minimal `grafana server` invocation instead, stated verbatim in the header.) |
| Default credentials `admin` / `admin` | `developer-guide.md:127-129` | **Matches.** Seeded `admin`/`admin@localhost`; login works via basic auth. |
| Forced password change on first login | `developer-guide.md:131` | **Matches** the documented behavior; the seed creates the account that the first login then forces to rotate. |
| SQLite is the default DB; GCC needed for Cgo | `developer-guide.md:12,135` | **Matches.** `dbtype=sqlite3`, `data/grafana.db` created; built with `CGO_ENABLED=1`. |
| Wire codegen step (`wire ... gen`) | `developer-guide.md:139-144` | **Matches & extends.** Confirmed that **without** `wire_gen.go` the backend does not compile (Q5a) — the docs mention the step; the runtime proves it is mandatory. |
| `defaults.ini` in `conf/`; `custom.ini` overrides | `developer-guide.md:261-263` | **Matches.** `Config loaded from .../conf/defaults.ini`; no `custom.ini` present, so defaults are effective. |

**Where the runtime extends the docs (things the onboarding docs do not tell you):** the **non-fatal
`public/build` error** that lets a backend-only build serve the API; the exact **626 migrations** and the
**`performed=0 skipped=626`** run-to-run difference; the **default-build banner** `version=9.2.0 commit=NA
branch=main`; the **54 loaded / 49 API** plugin counts (all `signature=internal`); the empty `data_source`
table; and the automatic, **failing** `grafana-lokiexplore-app` pre-install. These are the specifics that
explain *why* the server "just works," *why* later runs differ, *why* you can log in with credentials you
never set, and *why* plugins appear that you never installed.

---

## Appendix — reproduction summary

```bash
# From the repository root, on a clean checkout (no data/, no public/build, no wire_gen.go):
make gen-go                                                                 # -> pkg/server/wire_gen.go
CGO_ENABLED=1 GOFLAGS=-mod=readonly go build -tags oss -o /tmp/grafana ./pkg/cmd/grafana

# Run 1 (first clean start) — captures DB creation, 626 migrations, admin seed, plugin load, :3000 listen
/tmp/grafana server --homepath="$(pwd)" > /tmp/run1.log 2>&1 &
run1_pid=$!                                                                 # capture PID for targeted shutdown
sleep 8                                                                      # wait for bootstrap + HTTP listener
curl -s http://localhost:3000/api/health
curl -s -u admin:admin http://localhost:3000/api/plugins > /tmp/plugins.json
kill "$run1_pid"; wait "$run1_pid" 2>/dev/null || true                       # stop EXACTLY run 1 (never pkill)

# Run 2 (identical command, existing state) — migrations skipped, no admin re-seed
/tmp/grafana server --homepath="$(pwd)" > /tmp/run2.log 2>&1 &
run2_pid=$!
sleep 8
kill "$run2_pid"; wait "$run2_pid" 2>/dev/null || true                       # stop EXACTLY run 2

diff <(sed 's/t=[^ ]* //' /tmp/run1.log) <(sed 's/t=[^ ]* //' /tmp/run2.log)   # 1357 vs 62 lines
```

**Key observed numbers (this build/run):** build identity `version=9.2.0 commit=NA branch=main`;
HTTP port `3000`; migrations `performed=626 skipped=0` (run 1) / `performed=0 skipped=626` (run 2);
resource-migrator `18`; plugins loaded `54`; `/api/plugins` entries `49` (30 panel + 19 datasource, all
`signature=internal`); `data_source` rows `0`; feature toggles reported `=true`: `56`; log lines
`1357` (run 1) vs `62` (run 2) — a representative sample of the observed `1355–1357` / `62–63` band, since
the total jitters ±1–2 lines in the async region (see the run-to-run distribution note in Q2b), while the
deterministic `644`-vs-`0` migration count does not; SQLite file `data/grafana.db` (`1,093,632` bytes after
run 1).

*All values above were produced by the commands shown next to each claim and were confirmed stable across
the two runs where applicable. Statements labeled **(inferred)** were reasoned from code rather than
directly observed; every other claim is backed by captured runtime output.*

---

## Read-only & cleanup verification

This investigation was **strictly read-only**: no existing repository file was modified, and the only file
added is this document. Every artifact produced while building and running Grafana — the Wire-generated
`pkg/server/wire_gen.go`, the front-end `public/build` output, the runtime `data/` directory, any built
binary under `bin/`, and all throwaway `/tmp` logs and scripts — was **removed after evidence capture**, so
the working tree contains nothing but this single Markdown deliverable.

**Command & captured evidence — generated/runtime artifacts are absent:**

```bash
ls pkg/server/wire_gen.go public/build data bin 2>&1
```

```text
ls: cannot access 'pkg/server/wire_gen.go': No such file or directory
ls: cannot access 'public/build': No such file or directory
ls: cannot access 'data': No such file or directory
ls: cannot access 'bin': No such file or directory
```

**Command & captured evidence — the working tree's only change is this document:**

```bash
git status --porcelain
```

```text
 M blitzy/documentation/grafana_4550cfb5b728.md
```

The single ` M` entry is this document being delivered; once it is committed, a fresh `git status` reports a
clean tree. `pkg/server/wire_gen.go` (`.gitignore:194`) and `public/build` (`.gitignore:9`) are gitignored,
so they never show as tracked changes even when present — they were nonetheless removed to satisfy the
clean-tree requirement. There are no PID files and no throwaway scripts in the tree, and no reference file
cited in this document was edited: each was opened read-only and its code path executed for observation only.

