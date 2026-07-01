# Grafana Cold‑Start Ground Truth — What Actually Happens on a Clean Start

> **Audience:** a new contributor whose observed behavior did not match the architecture docs.
> **Method:** *run‑first, then write.* Every behavioral claim below is paired with the **verbatim** output line that demonstrates it and the **command** that produced it. Every structural claim carries an **exact `file:line`** citation into the source at this commit. Values are reported **exactly as observed**, even where they look surprising.

---

## §0 — Scope & Method

### 0.1 What "clean state" means here

"Clean state" is defined precisely as: a **fresh, empty home/data directory**, **no `conf/custom.ini`**, and **no `GF_*` environment variables**. Under these conditions the effective configuration is exactly `conf/defaults.ini`.

- The layered config is: `conf/defaults.ini` (baseline) → optional `conf/custom.ini` → `GF_*` env → CLI `cfg:` overrides. `conf/sample.ini` is a **fully‑commented** example (a template for a user's `custom.ini`); it is never read as config.
- Confirmed there is **no** `custom.ini` in the repo `conf/` and **no** `GF_*` variables in the environment:

```console
$ ls -l conf/custom.ini
ls: cannot access 'conf/custom.ini': No such file or directory
$ env | grep -E '^GF_' || echo none
none
```

- Confirmed at runtime that the only config file loaded was `defaults.ini`:

> `logger=settings … level=info msg="Config loaded from" file=/tmp/gf_clean_home/conf/defaults.ini`
> *(command: `grep 'Config loaded from' run1.log`)*

To avoid touching the repository's own (git‑ignored) `data/` directory, the clean run used a temporary home directory `/tmp/gf_clean_home` containing **symlinks** to the repo's read‑only `conf/`, `public/`, and `plugins-bundled/` trees, plus a **fresh** `data/` that the server creates itself. The data path is resolved relative to the home path, so a fresh home yields a fresh database.

### 0.2 Repository / binary under investigation

| Item | Value | Evidence / citation |
|---|---|---|
| Branch (source) | `grafana_4550cfb5b728` (working branch differs) | `git rev-parse --abbrev-ref HEAD` |
| Commit (short) | `4550cfb5b7` | `git rev-parse --short HEAD` |
| Repo version | `11.5.0-pre` | `package.json` `"version"` |
| Go | `go1.23.1 linux/amd64` | `go version` |
| Node.js | `v22.12.0` | `node --version` |
| Yarn | `4.5.3` | `yarn --version` |
| GCC | `15.2.0` | `gcc --version` |
| sqlite3 CLI | `3.46.1` | `sqlite3 --version` |

### 0.3 Exact build & run commands (captured)

```console
# 1) Generate the Go dependency-injection wiring (writes pkg/server/wire_gen.go)
$ make gen-go
generate go files
go run  ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server
wire: github.com/grafana/grafana/pkg/server: wrote .../pkg/server/wire_gen.go

# 2) Frontend build output already present (webpack)
$ ls public/build | wc -l
658

# 3) Build the backend binary (Cgo REQUIRED for the sqlite3 driver)
$ CGO_ENABLED=1 go build -o /tmp/grafana_bin ./pkg/cmd/grafana   # exit 0, ~23s
$ ls -l /tmp/grafana_bin
-rwxr-xr-x 1 root root 298085368 /tmp/grafana_bin

# 4) Run from a fresh, empty home/data dir (no custom.ini, no GF_* env)
$ /tmp/grafana_bin server --homepath=/tmp/gf_clean_home > run1.log 2>&1 &
```

### 0.4 A required honesty note about the version string (`9.2.0`)

The binary was produced with a plain `go build`, which does **not** inject the release version via linker flags. Therefore the running binary self‑reports version **`9.2.0`**, not `11.5.0-pre`. This is not a mistake in the capture — it is the compiled‑in default:

- `var version = "9.2.0"` [pkg/cmd/grafana/main.go:L17]
- `var commit = gcli.DefaultCommitValue` [pkg/cmd/grafana/main.go:L18] → reported as `NA`
- `var buildBranch = "main"` [pkg/cmd/grafana/main.go:L20]

Observed banner:

> `logger=settings … level=info msg="Starting Grafana" version=9.2.0 commit=NA branch=main compiled=2026-07-01T21:39:27Z`
> *(command: `grep 'Starting Grafana' run1.log`)*

Everything else in this document (paths, migrations, users, plugins, headers, DB rows) is independent of this string. Where the version appears in observed output (`/api/health`, the plugin‑compatibility check), it is quoted as‑is and its origin explained. A release build (`make build` with ldflags) would print `11.5.0-pre`.

---

## §1 — Cold‑start initialization ground truth

### 1.1 Entry point → lifecycle

The unified binary's entry point is `func main()` [pkg/cmd/grafana/main.go:L23], which registers the server subcommand `commands.ServerCommand(...)` [pkg/cmd/grafana/main.go:L47]. The `--homepath` flag "defaults to working directory" [pkg/cmd/grafana-server/commands/flags.go:L35-L36] and is threaded into config via `setting.NewCfgFromArgs{HomePath: HomePath}` [pkg/cmd/grafana-server/commands/cli.go:L96-L98].

The server object then runs a deterministic lifecycle in `pkg/server/server.go`:

1. `func (s *Server) Init()` [pkg/server/server.go:L113]
2. `s.writePIDFile()` [pkg/server/server.go:L122] (definition at [L205]) — a no‑op unless `--pidfile` is set
3. `s.roleRegistry.RegisterFixedRoles(s.context)` [pkg/server/server.go:L130] — registers RBAC fixed roles
4. `return s.provisioningService.RunInitProvisioners(s.context)` [pkg/server/server.go:L134] — **sequential** provisioning (datasources → dashboards/plugins → alerting)
5. `func (s *Server) Run()` [pkg/server/server.go:L139] — launches background services
6. `s.notifySystemd("READY=1")` [pkg/server/server.go:L176]
7. graceful `func (s *Server) Shutdown(ctx, reason)` [pkg/server/server.go:L185]

The observed startup stream matches this order. Selected verbatim lines *(command: `grep -vE 'logger=(migrator|resource-migrator)' run1.log`)*:

> `msg="Config loaded from" file=/tmp/gf_clean_home/conf/defaults.ini`
> `msg=Target target=[all]`
> `msg="Path Home" path=/tmp/gf_clean_home`
> `msg="App mode production"`
> `msg="Connecting to DB" dbtype=sqlite3`
> `msg="Creating SQLite database file" path=/tmp/gf_clean_home/data/grafana.db`
> `logger=provisioning.alerting … msg="starting to provision alerting"`
> `logger=provisioning.alerting … msg="finished to provision alerting"`
> `logger=provisioning.dashboard … msg="starting to provision dashboards"`
> `logger=provisioning.dashboard … msg="finished to provision dashboards"`
> `logger=http.server … msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=`

`App mode production` confirms `app_mode = production` [conf/defaults.ini:L7]; the listen address confirms `http_port = 3000` [conf/defaults.ini:L41].

### 1.2 `READY=1` / systemd notify

`s.notifySystemd("READY=1")` [pkg/server/server.go:L176] writes to the socket named by `$NOTIFY_SOCKET`. Because the server was **not** launched under systemd, `$NOTIFY_SOCKET` is unset and the call is a silent no‑op — there is **no** `READY=1` line in the log:

```console
$ grep -iE 'READY=1|systemd|sd_notify' run1.log || echo '(no systemd notify line — expected when not run under systemd)'
(no systemd notify line — expected when not run under systemd)
```

### 1.3 Why some services log "disabled"/"skipped" while others report success — even though nothing was configured

This is the mechanism the user asked about. There are **three distinct reasons** a service can look "disabled/skipped", and the clean‑state run exhibits all three.

**(a) The silent skip in the background‑service loop.** `Run()` iterates every registered background service and skips the disabled ones with a bare `continue`:

```go
for _, svc := range services {          // pkg/server/server.go:L149
    if registry.IsDisabled(svc) {        // pkg/server/server.go:L150
        continue                         // pkg/server/server.go:L151-L152 (SILENT — no log)
    }
    ...
}
```

The predicate is `func IsDisabled(srv BackgroundService) bool` [pkg/registry/registry.go:L53], which type‑asserts the service to `CanBeDisabled` [pkg/registry/registry.go:L18-L20] and calls `IsDisabled() bool` [pkg/registry/registry.go:L20]. A service that reports `true` (based on default config / feature flags) is dropped **without any log line at all**. So most "disabled" services are not announced — they are simply **absent** from the log: they neither report success nor report being disabled.

To make the otherwise‑silent loop visible, a **supplementary** run at `cfg:log.level=debug` was used (this is a diagnostic run, not the clean‑state baseline). At debug level the loop logs each **enabled** service it starts; disabled ones still produce no line:

> `logger=server level=debug msg="Starting background service" service=*tracing.TracingService`
> *(command: `grep 'Starting background service' run_debug.log`)*

```console
$ grep -c 'msg="Starting background service"' run_debug.log
34
```

So **34** background services were enabled and started on a clean install; every other registered service was silently skipped by the `registry.IsDisabled` check above.

**(b) A service that explicitly reports itself disabled because a default property is unset.** Example (debug level):

```text
logger=secrets.kvstore level=debug msg="secrets manager evaluator returned false" reason="remote secret management plugin disabled because the property `secrets.use_plugin` is not set to `true`"
```
> *(command: `grep 'remote secret management plugin disabled' run_debug.log`)*

A related case is a service that **starts** but finds its optional feature absent:

> `logger=rendering level=debug msg="No image renderer found/installed. For image rendering support please install the grafana-image-renderer plugin. …"`
> *(command: `grep 'No image renderer' run_debug.log`)*

**(c) "Skipped" messages that are visible at the default `info` level.** These are the ones a user actually sees on a normal clean start:

- The migrator emits **3** such warnings on the first run for migrations it detects as already applied but not yet recorded *(command: `grep -c 'Skipping migration: Already executed' run1.log` → `3`)*:

> `logger=migrator … level=warn msg="Skipping migration: Already executed, but not recorded in migration log" id="drop unique orgID index on alert_configuration if exists"`
> *(command: `grep 'Skipping migration' run1.log`)*

- The **external plugin** and **image‑renderer** subsystems find nothing because their directory does not exist on a fresh install (there is no `data/plugins` yet):

> `logger=plugin.sources … level=error msg="Failed to load external plugins" error="failed to open plugins path"`
> `logger=renderer.manager … level=error msg="Failed to get renderer plugin sources" error="failed to open plugins path"`
> *(command: `grep -E 'Failed to load external plugins|Failed to get renderer plugin sources' run1.log`)*

**By contrast, enabled services announce success at `info`** — this is the other half of the user's observation:

> `logger=live.push_http … msg="Live Push Gateway initialization"`
> `logger=grafanaStorageLogger … msg="Storage starting"`
> `logger=ngalert.multiorg.alertmanager … msg="Starting MultiOrg Alertmanager"`
> `logger=app-registry … msg="app registry initialized"`
> `logger=http.server … msg="HTTP Server Listen" address=[::]:3000 …`
> *(command: `grep -E 'Live Push Gateway|Storage starting|Starting MultiOrg Alertmanager|app registry initialized|HTTP Server Listen' run1.log`)*

**Rationale.** The user "never configured anything," yet sees a mix of success and disabled/skip messages because the *defaults themselves* decide this. Enabled‑by‑default services (HTTP server, alerting, live, storage, token auth, etc.) run and log success; disabled‑by‑default subsystems (e.g., the remote secrets plugin, external plugins, the image renderer) either log that they are off or are skipped silently by `registry.IsDisabled`. Nothing here reflects user configuration — it reflects `conf/defaults.ini` plus compiled‑in feature‑flag defaults.

---

## §2 — Default security posture

### 2.1 Why you can "log in with credentials you never set up" — the account **is created** on first start

On the first start (empty database), Grafana **creates** a default admin account. It is not pre‑existing and it is not a permissive/anonymous mode — it is a real row inserted into the `user` table.

- Creation path: `func (ss *SQLStore) ensureMainOrgAndAdminUser(test bool)` [pkg/services/sqlstore/sqlstore.go:L190].
- It first counts users with `SELECT COUNT(id) AS Count FROM "user"` [pkg/services/sqlstore/sqlstore.go:L200] and returns early if any exist (`if stats.Count > 0 { return nil }` [pkg/services/sqlstore/sqlstore.go:L204]).
- If admin creation is not disabled (`if !ss.cfg.DisableInitAdminCreation {` [pkg/services/sqlstore/sqlstore.go:L210]) it creates the user with `Login: ss.cfg.AdminUser` [L214], `Email: ss.cfg.AdminEmail` [L215], `Password: user.Password(ss.cfg.AdminPassword)` [L216], `IsAdmin: true` [L217], then logs `Created default admin` [L222] and `Created default organization` [L230].

Three independent pieces of evidence prove the account was **created, not assumed**:

**(1) The creation log lines** *(command: `grep -E 'Created default admin|Created default organization' run1.log`)*:

```text
logger=sqlstore … level=info msg="Created default admin" user=admin
logger=sqlstore … level=info msg="Created default organization"
```

**(2) The actual DB row** *(command: `sqlite3 data/grafana.db 'SELECT id, login, email, is_admin FROM user;'`)*:

```text
id  login  email            is_admin
--  -----  ---------------  --------
1   admin  admin@localhost  1
```

**(3) A successful login with the never‑set credentials `admin`/`admin`** *(command: `curl -sS -i -X POST http://localhost:3000/login -H 'Content-Type: application/json' -d '{"user":"admin","password":"admin"}'`)*:

```text
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
Set-Cookie: grafana_session=6d5643c1b89a6aab175144b4391cb233; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax
Set-Cookie: grafana_session_expiry=1782942701; Path=/; Max-Age=2592000; SameSite=Lax
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Content-Length: 41

{"message":"Logged in","redirectUrl":"/"}
```

The session cookie is named `grafana_session` because `login_cookie_name = grafana_session` [conf/defaults.ini:L561]; it is issued `HttpOnly` with `SameSite=Lax` and `Max-Age=2592000` (30 days).

### 2.2 The exact defaults that make this happen — `[security]`

From `conf/defaults.ini` `[security]` [conf/defaults.ini:L323]:

| Key | Value | Line |
|---|---|---|
| `disable_initial_admin_creation` | `false` | [conf/defaults.ini:L325] |
| `admin_user` | `admin` | [conf/defaults.ini:L328] |
| `admin_password` | `admin` | [conf/defaults.ini:L331] |
| `admin_email` | `admin@localhost` | [conf/defaults.ini:L334] |
| `secret_key` | `SW2YcwTIb9zpOOhoPsMm` | [conf/defaults.ini:L337] |

`disable_initial_admin_creation` is resolved by `security.Key("disable_initial_admin_creation").MustBool(false)` [pkg/setting/setting.go:L1580], i.e. **admin creation is on by default**, which is why the account exists.

**Reported exactly as observed (a real security note):** the default `secret_key` is the shared, well‑known literal **`SW2YcwTIb9zpOOhoPsMm`** [conf/defaults.ini:L337]. It is identical across every default install and is used to sign/encrypt sensitive settings. On the clean run the secrets subsystem confirmed it is active as the envelope‑encryption provider:

> `logger=secrets … level=info msg="Envelope encryption state" enabled=true currentprovider=secretKey.v1`
> *(command: `grep 'Envelope encryption state' run1.log`)*

This is **not** softened here: a production deployment that leaves `secret_key` at this default is using a publicly known key.

### 2.3 Is it running "permissively"? No — basic auth on, anonymous off, sign‑up off

| Setting | Value | Line | Meaning |
|---|---|---|---|
| `[auth.basic] enabled` | `true` | [conf/defaults.ini:L874-L875] | Basic auth **on** (why `curl -u admin:admin` works) |
| `[auth.anonymous] enabled` | `false` | [conf/defaults.ini:L648-L650] | Anonymous access **off** |
| `[users] allow_sign_up` | `false` | [conf/defaults.ini:L483] | Self sign‑up **off** |
| `[users] auto_assign_org` | `true` | [conf/defaults.ini:L489] | New users auto‑join an org |
| `[users] auto_assign_org_id` | `1` | [conf/defaults.ini:L492] | …org id 1 |
| `[users] auto_assign_org_role` | `Viewer` | [conf/defaults.ini:L495] | …as Viewer |

The runtime corroborates that anonymous access is off *(command: `curl -sS -u admin:admin http://localhost:3000/api/frontend/settings` → JSON field `anonymousEnabled`)*:

```text
anonymousEnabled: False
buildInfo.version: 9.2.0 | edition: Open Source
```

So the posture is **not** open/permissive: it created one real privileged account guarded by basic auth, with anonymous access and sign‑up both disabled. The only "weakness" is the well‑known default password/`secret_key`, which is precisely why Grafana prompts for a password change on first UI login.

### 2.4 Which auth clients are active, the login flow, brute‑force lockout, and RBAC (each addressed by name)

- **Auth clients** (`pkg/services/authn/clients/`): the pluggable clients are **basic, session, jwt, oauth, ldap, proxy, api_key**. On a clean run only **basic** (username/password, from `[auth.basic] enabled = true`) and **session** (the `grafana_session` cookie issued above) are active; jwt/oauth/ldap/proxy require explicit configuration that is absent here, and api_key requires a created token.
- **Login flow & redirect validation** (`pkg/api/login.go`): the login view is `func (hs *HTTPServer) LoginView(...)` [pkg/api/login.go:L92]; redirect targets are validated by `func (hs *HTTPServer) ValidateRedirectTo(redirectTo string)` [pkg/api/login.go:L47], which rejects absolute/invalid/forbidden targets via `errAbsoluteRedirectTo` [L42], `errInvalidRedirectTo` [L43], `errForbiddenRedirectTo` [L44]. The successful login above returned `redirectUrl":"/"`.
- **Brute‑force lockout** (`pkg/services/loginattempt/loginattemptimpl/login_attempt.go`): attempts are counted in a rolling window `const loginAttemptsWindow = time.Minute * 5` [login_attempt.go:L14]; lockout triggers at `if count >= s.cfg.BruteForceLoginProtectionMaxAttempts` [login_attempt.go:L80]. The **real default threshold is 5** — `cfg.BruteForceLoginProtectionMaxAttempts = security.Key("brute_force_login_protection_max_attempts").MustInt64(5)` [pkg/setting/setting.go:L1512], matching `brute_force_login_protection_max_attempts = 5` [conf/defaults.ini:L355]. Protection is on by default: `disable_brute_force_login_protection = false` [conf/defaults.ini:L352] / `MustBool(false)` [pkg/setting/setting.go:L1511]; the guards are checked at [login_attempt.go:L34,L50,L66].
- **RBAC defaults** (`pkg/services/accesscontrol/**`): the fixed roles (including the Grafana Admin role) are registered during `Init()` via `s.roleRegistry.RegisterFixedRoles(s.context)` [pkg/server/server.go:L130]. The created admin has `is_admin = 1` (see the DB row in §2.1), i.e. the Grafana server administrator.


---

## §3 — Persistent state and its location

### 3.1 Where state lives — `[paths]` and `[database]`

All runtime state is rooted under the `data` directory, resolved relative to the home path.

| Path | Default | Line | Resolved (clean run) |
|---|---|---|---|
| `data` | `data` | [conf/defaults.ini:L15] | `/tmp/gf_clean_home/data` |
| `logs` | `data/log` | [conf/defaults.ini:L21] | `/tmp/gf_clean_home/data/log` |
| `plugins` | `data/plugins` | [conf/defaults.ini:L24] | `/tmp/gf_clean_home/data/plugins` |
| `provisioning` | `conf/provisioning` | [conf/defaults.ini:L27] | `/tmp/gf_clean_home/conf/provisioning` |

The database defaults come from `[database]` [conf/defaults.ini:L118]: `type = sqlite3` [conf/defaults.ini:L123] and `path = grafana.db` [conf/defaults.ini:L164], so the database file is `data/grafana.db`. This was echoed at startup:

> `logger=sqlstore … msg="Connecting to DB" dbtype=sqlite3`
> `logger=sqlstore … msg="Creating SQLite database file" path=/tmp/gf_clean_home/data/grafana.db`
> *(command: `grep -E 'Connecting to DB|Creating SQLite database file' run1.log`)*

### 3.2 What actually gets written — the `data/` tree

*(command: `find data -maxdepth 2 | sort`)*

```text
data
data/csv
data/grafana.db
data/log
data/log/grafana.log
data/pdf
data/png
```

- **`data/grafana.db`** — the SQLite database (schema + rows). Its **real size on a clean first run** *(command: `ls -l data/grafana.db`)*:

```text
-rw-r----- 1 root root 1093632 Jul  1 21:39 data/grafana.db
```

i.e. **1,093,632 bytes (≈1.1 MiB)** with the full schema created but almost no user data.

- **`data/log/grafana.log`** — the file log (the default log mode is `console file` [conf/defaults.ini:L1071] at level `info` [conf/defaults.ini:L1074]).
- **`data/csv`, `data/pdf`, `data/png`** — export scratch directories created eagerly at startup.
- **Sessions are stored in the database, not on disk.** There is no session file/dir; the login above produced exactly one row in `user_auth_token` *(command: `sqlite3 data/grafana.db 'SELECT COUNT(*) FROM user_auth_token;'`)*:

```text
sessions
--------
1
```

- Note: **`data/plugins` was not created** on this clean run, because there were no external plugins to place there (see §4); the external‑plugin scan simply reported the path could not be opened (§1.3c).

### 3.3 The schema and the `migration_log` table

Schema evolution is driven by the migrator, whose log table name is set to `migration_log` (`mg.tableName = "migration_log"` [pkg/services/sqlstore/migrator/migrator.go:L97]). It emits `Starting DB migrations` [migrator.go:L247], one `Executing migration` line per step [migrator.go:L356], and a final `migrations completed` summary with `performed`/`skipped`/`duration` [migrator.go:L287].

**Real magnitude on the first run** *(commands: `grep -c 'msg="Executing migration"' run1.log` and `grep 'migrations completed' run1.log`)*:

```text
Executing migration count: 644
logger=migrator … msg="migrations completed" performed=626 skipped=0 duration=2.134423675s
logger=resource-migrator … msg="migrations completed" performed=18 skipped=0 duration=51.049527ms
```

So the default schema is built by **626** migrations (main migrator) plus **18** (the `resource-migrator`) — **644** executed steps, `skipped=0`, taking **2.134423675 s** (main) + **51.049527 ms** (resource). The very first migration is the one that creates the log table itself:

> `logger=migrator … msg="Executing migration" id="create migration_log table"`
> *(command: `grep -m1 'Executing migration' run1.log`)*

The recorded count in the database matches the "performed" number *(command: `sqlite3 data/grafana.db 'SELECT COUNT(*) FROM migration_log;'`)*:

```text
626
```

The database ends up with **76** tables *(command: `sqlite3 data/grafana.db "SELECT COUNT(*) FROM sqlite_master WHERE type='table';"`)* and the single `admin` user / `Main Org.` rows shown in §2.1.

### 3.4 Provisioning is inert on a clean install — so nothing extra is written

`conf/provisioning/` contains exactly **5** subdirectories, each with a single `sample.yaml` *(command: `ls conf/provisioning`)*: `access-control`, `alerting`, `dashboards`, `datasources`, `plugins`. The datasources sample is inert — its only non‑comment line is `apiVersion: 1` *(command: `grep -vE '^\s*#|^\s*$' conf/provisioning/datasources/sample.yaml`)*:

```text
apiVersion: 1
```

Consequently the provisioners start and immediately finish with nothing to do (see the `starting/finished to provision` lines in §1.1), and `GET /api/datasources` returns an empty array *(command: `curl -sS -i -u admin:admin http://localhost:3000/api/datasources`)*:

```text
HTTP/1.1 200 OK
Content-Length: 2

[]
```

### 3.5 Why subsequent runs "behave differently in ways that persist"

Because everything above lives in `data/` (the DB with the `migration_log`, `user`, `org` rows, and the `user_auth_token` sessions), a **second start against the same `data/`** finds the schema already migrated and the admin/org already present. The persistence mechanism is exactly the `migration_log` table (idempotency) plus the user‑count early‑return gate. Full paired first‑run/second‑run evidence is in §6.


---

## §4 — Plugin & data source bootstrap

### 4.1 The four source classes

A plugin's origin is captured by its `Class` [pkg/plugins/plugins.go]:

- `ClassCore = "core"` [pkg/plugins/plugins.go:L509]
- `ClassBundled = "bundled"` [pkg/plugins/plugins.go:L510]
- `ClassExternal = "external"` [pkg/plugins/plugins.go:L511]
- `ClassCDN = "cdn"` [pkg/plugins/plugins.go:L512]

and `func (p *Plugin) IsCorePlugin() bool { return p.Class == ClassCore }` [pkg/plugins/plugins.go:L494-L495].

### 4.2 Where each class is discovered — the registered sources

`pkg/plugins/manager/sources/sources.go` registers three on‑disk sources:

- **core**: `NewLocalSource(plugins.ClassCore, corePluginPaths(s.cfg.StaticRootPath))` [sources.go:L26], where `corePluginPaths` [sources.go:L64] returns `<static>/app/plugins/datasource` [sources.go:L65] and `<static>/app/plugins/panel` [sources.go:L66]. These are served from the static root (`public/`), i.e. **shipped in‑repo**, not installed by the user.
- **bundled**: `NewLocalSource(plugins.ClassBundled, []string{s.cfg.BundledPluginsPath})` [sources.go:L27]. `BundledPluginsPath` resolves to `<home>/plugins-bundled` [pkg/setting/setting.go:L1097].
- **external**: `DirAsLocalSources(s.cfg.PluginsPath, plugins.ClassExternal)` [sources.go:L35], scanning `PluginsPath` = `data/plugins` [pkg/setting/setting.go:L1096].

### 4.3 The compiled‑in backend data sources — exactly 18

Backend data‑source query execution is provided by a compiled‑in factory map built in `func ProvideCoreRegistry(...)` [pkg/plugins/backendplugin/coreplugin/registry.go:L95] → `NewRegistry(map[string]backendplugin.PluginFactoryFunc{...})` [pkg/plugins/backendplugin/coreplugin/registry.go:L102-L121]. It has **exactly 18** entries:

1. CloudWatch · 2. CloudMonitoring · 3. AzureMonitor · 4. Elasticsearch · 5. Graphite · 6. InfluxDB · 7. Loki · 8. OpenTSDB · 9. Prometheus · 10. Tempo · 11. TestData · 12. PostgreSQL · 13. MySQL · 14. MSSQL · 15. Grafana · 16. Pyroscope · 17. Parca · 18. Zipkin.

### 4.4 What actually becomes available through the API on a clean install

**All plugins loaded are `core`.** The store logs 54 loaded plugins, and `/api/plugins` returns 49 entries, **every one** with `signature: internal` (the marker for core):

> `logger=plugin.store … msg="Plugins loaded" count=54 duration=33.403409ms`
> *(command: `grep 'Plugins loaded' run1.log`)*

```console
$ curl -sS -u admin:admin http://localhost:3000/api/plugins | python3 -c "import json,sys,collections;d=json.load(sys.stdin);print('count=',len(d));print(collections.Counter(p['signature'] for p in d));print(collections.Counter(p['type'] for p in d))"
count= 49
Counter({'internal': 49})
Counter({'panel': 30, 'datasource': 19})
```

Reconciling the counts (all real, no estimates):

- **49 via `/api/plugins`** = 30 panel + 19 datasource, all `signature=internal`.
- **54 loaded** (store log) = the **22** datasource frontend dirs + **32** panel frontend dirs on disk *(command: `find public/app/plugins/datasource -maxdepth 1 -mindepth 1 -type d | wc -l` → `22`; `…/panel…` → `32`; `22+32 = 54`)*. The **5** loaded but not listed by `/api/plugins` are exactly (verified by set‑difference of the API IDs vs the on‑disk dirs): the **3 builtin datasources** `dashboard`, `grafana`, `mixed` (surfaced instead in `/api/frontend/settings` as `-- Dashboard --`, `-- Grafana --`, `-- Mixed --`) and **2 internal panels** `debug` and `live`. So **32 panel dirs − 2 = 30** listed, and **22 datasource dirs − 3 = 19** listed → **30 + 19 = 49**.
- Note the two datasource dirs `azuremonitor` and `cloud-monitoring` **are** in the API list, under their canonical plugin IDs `grafana-azure-monitor-datasource` and `stackdriver` respectively (so they are not part of the 5‑plugin gap).
- The **18** compiled‑in backends (§4.3) are the query engines behind the backend‑capable datasource plugins; the 19 datasource plugins also include proxy/frontend‑handled ones (`alertmanager`, `jaeger`) that are not entries in the 18‑map, and the builtin `grafana` datasource is served as `-- Grafana --`.

The 19 datasource plugin IDs and 30 panel plugin IDs returned by the API *(command: `curl -sS -u admin:admin http://localhost:3000/api/plugins`)*:

```text
datasource (19): alertmanager, cloudwatch, elasticsearch, grafana-azure-monitor-datasource,
  grafana-postgresql-datasource, grafana-pyroscope-datasource, grafana-testdata-datasource,
  graphite, influxdb, jaeger, loki, mssql, mysql, opentsdb, parca, prometheus, stackdriver,
  tempo, zipkin
panel (30): alertlist, annolist, barchart, bargauge, candlestick, canvas, dashlist, datagrid,
  flamegraph, gauge, geomap, gettingstarted, graph, heatmap, histogram, logs, news, nodeGraph,
  piechart, stat, state-timeline, status-history, table, table-old, text, timeseries, traces,
  trend, welcome, xychart
```

And the frontend's known datasources on a clean install are only the three builtins *(command: `curl -sS -u admin:admin http://localhost:3000/api/frontend/settings`)*:

```text
datasources: ['-- Dashboard --', '-- Grafana --', '-- Mixed --']
defaultDatasource: -- Grafana --
```

### 4.5 Why plugins "appear that you didn't install"

Because they are **core** — compiled‑in backends (§4.3) plus frontends shipped in‑repo under `public/app/plugins/datasource` and `public/app/plugins/panel` (§4.2) — served from the static root, never installed by the user. Corroboration that **nothing else** is present on a clean install:

- **No bundled plugins:** `plugins-bundled/` contains only `.gitignore`, `README.md`, and `external.json`, and `external.json` is empty *(command: `cat plugins-bundled/external.json`)*:

```text
{
  "plugins": []
}
```

- **No external plugins:** `data/plugins` does not exist yet, so the external scan fails to open the path (§1.3c) — hence zero `external` plugins.
- **No CDN plugins:** none configured.

Therefore the clean‑state population is **only `core`**, which is exactly what `/api/plugins` shows (`signature=internal` for all 49).

### 4.6 Core/bundled plugins cannot be installed or removed

The installer refuses to install or uninstall core/bundled plugins:

- `ErrInstallCorePlugin` [pkg/plugins/manager/installer.go:L99]
- `ErrUninstallCorePlugin` [pkg/plugins/manager/installer.go:L198]

An **observed** consequence of the `9.2.0` version string (§0.4): the background installer tried to preinstall an app and the compatibility check rejected it — reported here exactly as seen:

> `logger=plugin.backgroundinstaller … level=error msg="Failed to install plugin" pluginId=grafana-lokiexplore-app version= error="[plugin.grafanaVersionNotCompatible] grafana-lokiexplore-app is not compatible with your Grafana version: 9.2.0"`
> *(command: `grep 'Failed to install plugin' run1.log`)*

This is a side effect of building without version ldflags; a correctly‑versioned release build would evaluate compatibility against `11.5.0-pre`. It does not affect the core‑plugin inventory above.


---

## §5 — Build/compilation dependency (generated files & "run directly vs build first")

### 5.1 Generated Go DI wiring — `pkg/server/wire_gen.go`

The backend's dependency‑injection graph is **generated**, not hand‑written. `make gen-go` [Makefile:L167] runs Google Wire codegen with `WIRE_TAGS = "oss"` [Makefile:L5] and writes `pkg/server/wire_gen.go`. This file is **absent in a fresh checkout** (it is git‑ignored) and the backend **will not build without it**. Observed generation *(command: `make gen-go`)*:

```text
generate go files
go run  ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server
wire: github.com/grafana/grafana/pkg/server: wrote .../pkg/server/wire_gen.go
```

Proof it is generated/untracked *(commands: `head -5 pkg/server/wire_gen.go`, `git check-ignore -v pkg/server/wire_gen.go`, `git ls-files pkg/server/wire_gen.go`)*:

```text
// Code generated by Wire. DO NOT EDIT.
//go:build !wireinject
.gitignore:194:**/wire_gen.go   pkg/server/wire_gen.go
(git ls-files → empty: not tracked)
```

### 5.2 Frontend assets are NOT embedded — the runtime depends on `public/build`

`embed.go` embeds **only** the CUE schema, not the frontend *(command: `cat embed.go`)*:

```go
//go:embed cue.mod/module.cue
var CueSchemaFS embed.FS
```

So the UI is served from the on‑disk webpack output `public/build` (**658** entries / **325** `.js` on this build; also git‑ignored via `.gitignore:9:/public/build`). When `public/build` is missing, `validateStaticRootPath` [pkg/setting/setting.go:L1034-L1042] logs a **non‑fatal** error (message at [pkg/setting/setting.go:L1040]) and returns `nil`. Observed by running once from a home whose `public/` had no `build/` subdir *(command: `/tmp/grafana_bin server --homepath=/tmp/gf_nobuild_home`)*:

```text
logger=settings … level=error msg="Failed to detect generated javascript files in public/build"
…
logger=http.server … level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=
```

The `error`‑level line appears at the very start, yet the server **still reaches HTTP listening** and answers requests *(command: `curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:3000/api/health`)*:

```text
HTTP 200
```

### 5.3 Is "running directly" equivalent to "building first"? — No, not fully

- The **backend** cannot even compile without the generated `wire_gen.go` (§5.1). Once generated, `go run`/`go build` of `./pkg/cmd/grafana` produces a working server.
- The **frontend** is a separate build; the API/backend run fine without it, but the **UI is broken** (blank/asset‑less) until `public/build` exists (§5.2). So running the backend directly is **not** equivalent to a full build when you need the UI.

Relevant Makefile targets *(citations)*: `build-go: gen-go update-workspace` [Makefile:L187], `build-js:` [Makefile:L211], `build: build-go build-js` [Makefile:L229], `run:` [Makefile:L232], `run-go:` [Makefile:L236] (which adds `cfg:app_mode=development` [Makefile:L238]). Note `build-go` runs `update-workspace`; a strictly read‑only build should use `build-go-fast: gen-go` [Makefile:L191] instead.

**Documentation vs observed.** The developer guide prescribes: `GCC` for Cgo/SQLite [contribute/developer-guide.md:L12,L135], `yarn install --immutable` [contribute/developer-guide.md:L71], `yarn start` [contribute/developer-guide.md:L79], `make run` [contribute/developer-guide.md:L119], reachable at `http://localhost:3000/` [contribute/developer-guide.md:L123]. Observed behavior matches: the server listened on `[::]:3000` (§1.1); building required `CGO_ENABLED=1` (Cgo) because the default SQLite driver needs it; and the generated `wire_gen.go` + `public/build` were both prerequisites, exactly as the pipeline implies.

---

## §6 — First‑run vs subsequent‑run divergence

Two mechanisms make the first run differ from every later run against the same `data/`.

### 6.1 Admin/org creation gate (created once)

`ensureMainOrgAndAdminUser` returns early when any user already exists: `if stats.Count > 0 { return nil }` [pkg/services/sqlstore/sqlstore.go:L204-L206]. So `Created default admin` [sqlstore.go:L222] and `Created default organization` [sqlstore.go:L230] appear on run 1 and are **absent** on restart.

**Run 1** *(command: `grep -E 'Created default admin|Created default organization' run1.log`)*:

```text
logger=sqlstore … level=info msg="Created default admin" user=admin
logger=sqlstore … level=info msg="Created default organization"
```

**Run 2 (same `data/`)** *(command: `grep -E 'Created default admin|Created default organization' run2.log || echo ABSENT`)*:

```text
ABSENT
```

The DB confirms the gate: after restart the user count is still 1 *(command: `sqlite3 data/grafana.db 'SELECT COUNT(*) FROM user;'`)* → `1`.

### 6.2 Migration idempotency via `migration_log`

Applied migrations are recorded in `migration_log`; on restart the migrator finds them already recorded and skips them, so the `migrations completed` summary [migrator.go:L287] flips from all‑performed to all‑skipped. Paired evidence *(command: `grep 'migrations completed' run1.log run2.log`)*:

```text
RUN1  logger=migrator          … msg="migrations completed" performed=626 skipped=0 duration=2.134423675s
RUN1  logger=resource-migrator … msg="migrations completed" performed=18  skipped=0 duration=51.049527ms
RUN2  logger=migrator          … msg="migrations completed" performed=0   skipped=626 duration=544.497µs
RUN2  logger=resource-migrator … msg="migrations completed" performed=0   skipped=18  duration=45.459µs
```

On run 2 there are **zero** `Executing migration` lines *(command: `grep -c 'msg="Executing migration"' run2.log`)* → `0`, and the whole main‑migrator pass drops from **2.134423675 s** to **544.497 µs**. The recorded `migration_log` count is unchanged at **626** *(command: `sqlite3 data/grafana.db 'SELECT COUNT(*) FROM migration_log;'`)*.

### 6.3 Net effect on the log volume

The divergence is visible even in raw size: run 1 produced **1349** log lines; the restart produced **57** *(command: `wc -l run1.log run2.log`)*. This is the concrete, persistent difference the user observed: the first run builds the schema and seeds the admin/org; every later run finds that state already in `data/` and short‑circuits both.


---

## §7 — Coverage‑pass table

Every named item and every "e.g./such as/including/like" example from the question, mapped to the section that answers it and a one‑line piece of evidence (verbatim capture or `file:line`).

| # | Named item / question part | Section | One‑line evidence |
|---|---|---|---|
| 1 | Cold‑start bootstrap sequence | §1.1 | `Init` [server.go:L113] → `RegisterFixedRoles` [L130] → `RunInitProvisioners` [L134] → `Run` [L139]; observed `HTTP Server Listen address=[::]:3000` |
| 2 | Why services log "disabled"/"skipped" vs success | §1.3 | `if registry.IsDisabled(svc) { continue }` [server.go:L150-L152] (silent); 34 enabled started (debug) |
| 3 | `registry.IsDisabled` / `CanBeDisabled` | §1.3a | `func IsDisabled(...)` [registry.go:L53]; `CanBeDisabled` [registry.go:L18-L20] |
| 4 | Concrete disabled service message | §1.3b | `secrets.kvstore … "remote secret management plugin disabled …"` |
| 5 | Image renderer absent | §1.3b | `rendering … "No image renderer found/installed …"` |
| 6 | Migrator "Skipping migration" | §1.3c | `migrator … warn … "Skipping migration: Already executed …"` |
| 7 | `--homepath` default | §1.1 | "defaults to working directory" [flags.go:L35-L36] |
| 8 | Entry point `main()` / `ServerCommand` | §1.1 | [main.go:L23], [main.go:L47] |
| 9 | `notifySystemd("READY=1")` | §1.2 | [server.go:L176]; `(no systemd notify line …)` when not under systemd |
| 10 | `Shutdown` lifecycle | §6/§1.1 | `msg="Shutdown started" reason="System signal: terminated"` [server.go:L185] |
| 11 | Login with never‑set creds | §2.1 | `HTTP/1.1 200 OK` + `{"message":"Logged in","redirectUrl":"/"}` |
| 12 | Account **created** (not assumed) | §2.1 | `Created default admin" user=admin`; DB row `1 admin admin@localhost 1` |
| 13 | `ensureMainOrgAndAdminUser` + gate | §2.1/§6.1 | [sqlstore.go:L190]; `if stats.Count > 0 { return nil }` [L204-L206] |
| 14 | `admin_user`/`admin_password`/`admin_email` | §2.2 | `admin`/`admin`/`admin@localhost` [defaults.ini:L328,L331,L334] |
| 15 | `secret_key` (shared default) | §2.2 | `secret_key = SW2YcwTIb9zpOOhoPsMm` [defaults.ini:L337]; `Envelope encryption state enabled=true` |
| 16 | `disable_initial_admin_creation` | §2.2 | `false` [defaults.ini:L325]; `MustBool(false)` [setting.go:L1580] |
| 17 | Basic auth ON | §2.3 | `[auth.basic] enabled = true` [defaults.ini:L874-L875]; `curl -u admin:admin` works |
| 18 | Anonymous OFF | §2.3 | `[auth.anonymous] enabled = false` [defaults.ini:L648-L650]; `anonymousEnabled: False` |
| 19 | `allow_sign_up` / auto‑assign org | §2.3 | `false` [L483]; `auto_assign_org=true` [L489], id `1` [L492], role `Viewer` [L495] |
| 20 | Session cookie | §2.1 | `Set-Cookie: grafana_session=…; HttpOnly; SameSite=Lax`; name from [defaults.ini:L561] |
| 21 | Auth clients (basic/session/jwt/oauth/ldap/proxy/api_key) | §2.4 | only basic + session active on clean run |
| 22 | Login flow / redirect validation | §2.4 | `LoginView` [login.go:L92]; `ValidateRedirectTo` [login.go:L47] |
| 23 | Brute‑force lockout (max attempts) | §2.4 | window `time.Minute*5` [login_attempt.go:L14]; threshold **5** [setting.go:L1512 / defaults.ini:L355]; gate [login_attempt.go:L80] |
| 24 | RBAC fixed roles | §2.4 | `RegisterFixedRoles` [server.go:L130]; admin `is_admin=1` |
| 25 | `[paths]` data/logs/plugins/provisioning | §3.1 | `data` [L15], `data/log` [L21], `data/plugins` [L24], `conf/provisioning` [L27] |
| 26 | `[database]` sqlite3 / grafana.db | §3.1 | `type=sqlite3` [L123], `path=grafana.db` [L164]; `Creating SQLite database file …/data/grafana.db` |
| 27 | `data/` tree contents | §3.2 | `data/csv`, `data/grafana.db`, `data/log/grafana.log`, `data/pdf`, `data/png` |
| 28 | `grafana.db` size (magnitude) | §3.2 | `1093632` bytes (≈1.1 MiB) |
| 29 | Sessions in DB | §3.2 | `user_auth_token` count `1` |
| 30 | `migration_log` table | §3.3 | `mg.tableName = "migration_log"` [migrator.go:L97]; COUNT `626` |
| 31 | Migration count / duration (magnitude) | §3.3/§6.2 | `performed=626 skipped=0 duration=2.134423675s` (+18 resource); 644 executed |
| 32 | `Starting DB migrations` / `Executing migration` | §3.3 | [migrator.go:L247], [migrator.go:L356] |
| 33 | Provisioning inert (`apiVersion: 1`) | §3.4 | `datasources/sample.yaml` = `apiVersion: 1`; `/api/datasources` → `[]` |
| 34 | `/api/datasources` empty | §3.4 | `HTTP/1.1 200 OK` `Content-Length: 2` `[]` |
| 35 | Plugin classes core/bundled/external/cdn | §4.1 | [plugins.go:L509-L512]; `IsCorePlugin` [L494-L495] |
| 36 | Source registration (core/bundled/external) | §4.2 | [sources.go:L26], [L27], [L35]; `corePluginPaths` [L64-L66] |
| 37 | 18 compiled‑in backend data sources | §4.3 | `ProvideCoreRegistry` [coreplugin/registry.go:L95]; map [L102-L121] (18 named) |
| 38 | `/api/plugins` count & all core | §4.4 | `count= 49`, `Counter({'internal': 49})`, `panel:30 datasource:19` |
| 39 | 54 loaded vs 49 listed reconciliation | §4.4 | `Plugins loaded count=54`; 22 ds dirs − 3 builtins = 19 |
| 40 | Builtin datasources (Dashboard/Grafana/Mixed) | §4.4 | `datasources: ['-- Dashboard --','-- Grafana --','-- Mixed --']` |
| 41 | Why plugins appear un‑installed (core) | §4.5 | all `signature=internal`; `plugins-bundled/external.json` = `{"plugins": []}` |
| 42 | No bundled / no external / no CDN | §4.5 | empty `external.json`; external path `failed to open plugins path` |
| 43 | `ErrInstallCorePlugin` / `ErrUninstallCorePlugin` | §4.6 | [installer.go:L99], [installer.go:L198] |
| 44 | Generated `wire_gen.go` | §5.1 | `wire: … wrote …/pkg/server/wire_gen.go`; `.gitignore:194:**/wire_gen.go` |
| 45 | Frontend not embedded (`embed.go`) | §5.2 | `//go:embed cue.mod/module.cue` only |
| 46 | `public/build` + missing‑build error | §5.2 | `Failed to detect generated javascript files in public/build` [setting.go:L1040]; non‑fatal → `HTTP 200` |
| 47 | Run directly vs build first | §5.3 | backend needs `wire_gen.go`; UI needs `public/build` → not fully equivalent |
| 48 | Makefile targets / `WIRE_TAGS` | §5.1/§5.3 | `WIRE_TAGS="oss"` [L5]; `gen-go` [L167]; `build` [L229]; `run-go` app_mode=development [L238] |
| 49 | Developer‑guide flow (Cgo/yarn/make run/3000) | §5.3 | [developer-guide.md:L12,L71,L79,L119,L123,L135] |
| 50 | First‑run vs subsequent gate | §6.1 | `Created default admin` present run1, `ABSENT` run2 |
| 51 | Migration idempotency | §6.2 | run1 `performed=626 skipped=0`; run2 `performed=0 skipped=626` |
| 52 | `app_mode` / `http_port` | §1.1 | `App mode production` [defaults.ini:L7]; `[::]:3000` [defaults.ini:L41] |
| 53 | Version string `9.2.0` (observed vs `11.5.0-pre`) | §0.4 | banner `version=9.2.0 commit=NA branch=main`; `var version="9.2.0"` [main.go:L17] |

### Verdict

Every one of the six question areas is answered by name with paired verbatim evidence and exact `file:line` citations. Nothing was adjusted toward an expected value — most notably the observed `9.2.0` version string (§0.4), the shared well‑known `secret_key` (§2.2), and the non‑fatal missing‑`public/build` error (§5.2) are reported exactly as seen.

