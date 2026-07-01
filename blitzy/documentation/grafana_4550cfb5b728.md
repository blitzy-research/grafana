# Grafana Cold‑Start Ground Truth — What Actually Happens on a Clean Start

> **Audience:** a new contributor whose observed behavior did not match the architecture docs.
> **Method:** *run‑first, then write.* Every behavioral claim below is paired with the **verbatim** output line that demonstrates it and the **command** that produced it. Every structural claim carries an **exact `file:line`** citation into the source at this commit. Values are reported **exactly as observed**, even where they look surprising.

---

## §0 — Scope & Method

### 0.1 What "clean state" means here

"Clean state" is defined precisely as: a **fresh, empty home/data directory**, **no `conf/custom.ini`**, and **no `GF_*` environment variables**. Under these conditions the effective configuration is exactly `conf/defaults.ini`.

- The layered config is: `conf/defaults.ini` (baseline) → optional `conf/custom.ini` → `GF_*` env → CLI `cfg:` overrides. `conf/sample.ini` is a **sample/override template** (the basis for a user's `custom.ini`) and is **never read as config**; note it is **not** literally fully commented — it contains uncommented section headers and at least one uncommented key, e.g. `[unified_alerting.reserved_labels]` [conf/sample.ini:L1379] with `disabled_labels =` [conf/sample.ini:L1382] *(command: `grep -cvE '^\s*[#;]|^\s*$' conf/sample.ini` → `101` uncommented non‑blank lines)*.
- Confirmed there is **no** `custom.ini` in the repo `conf/` and **no** `GF_*` variables in the environment:

```console
$ ls -l conf/custom.ini
ls: cannot access 'conf/custom.ini': No such file or directory
$ env | grep -E '^GF_' || echo none
none
```

- Confirmed at runtime that the only config file loaded was `defaults.ini`:

> `logger=settings t=2026-07-01T22:40:52.007973438Z level=info msg="Config loaded from" file=/tmp/gf_clean_home/conf/defaults.ini`
> *(command: `grep 'Config loaded from' run1.log`)*

To avoid touching the repository's own (git‑ignored) `data/` directory, the clean run used a temporary home directory `/tmp/gf_clean_home` containing **symlinks** to the repo's read‑only `conf/`, `public/`, and `plugins-bundled/` trees, plus a **fresh** `data/` that the server creates itself. The data path is resolved relative to the home path, so a fresh home yields a fresh database.

### 0.2 Repository / binary under investigation

| Item | Value | Evidence / citation |
|---|---|---|
| Source commit under investigation | `4550cfb5b7` | `git log --oneline -1 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` → `4550cfb5b7 Upgrade scenes to v5.32.0 (#97944)` |
| Source branch (name only) | `grafana_4550cfb5b728` | Derived from the source branch name; this is the identity the document answers for. The **delivery/working branch of this tree differs** — see next row. |
| Delivery / working branch (this tree) | `blitzy-675536c4-a297-4fe3-88d1-6213344dc49c` @ `41bc342961` | `git rev-parse --abbrev-ref HEAD` → `blitzy-675536c4-a297-4fe3-88d1-6213344dc49c`; `git rev-parse --short HEAD` → `41bc342961` (these commands report the delivery branch/commit, **not** the source commit above) |
| Repo version | `11.5.0-pre` | `grep '"version"' package.json` → `  "version": "11.5.0-pre",` |
| Go | `go1.23.1 linux/amd64` | `go version` |
| Node.js | `v22.12.0` | `node --version` |
| Yarn | `4.5.3` | `yarn --version` |
| GCC | `15.2.0` | `gcc --version` |
| sqlite3 CLI | `3.46.1` | `sqlite3 --version` |

### 0.3 Exact build & run commands (captured)

```console
# 1) Install frontend dependencies (immutable: lockfile must not change)
$ yarn install --immutable
➤ YN0000: · Yarn 4.5.3
➤ YN0000: ┌ Resolution step
➤ YN0000: └ Completed in 0s 588ms
➤ YN0000: ┌ Fetch step
➤ YN0000: └ Completed in 0s 747ms
➤ YN0000: ┌ Link step
➤ YN0000: └ Completed in 0s 766ms
➤ YN0000: · Done with warnings in 2s 527ms
$ echo "exit=$?"
exit=0
$ git status --porcelain yarn.lock package.json   # (empty output = lockfile/manifest unchanged)

# 2) Build the frontend (production webpack via Nx -> writes public/build)
$ CI=true yarn build
webpack 5.95.0 compiled with 2 warnings in 15005 ms
 NX   Successfully ran target build for project grafana and 12 tasks it depends on
Nx read the output from the cache instead of running the command for 11 out of 13 tasks.
$ ls public/build | wc -l
658
$ ls public/build/*.js | wc -l
325
$ du -sh public/build
156M	public/build

# 3) Generate the Go dependency-injection wiring (writes pkg/server/wire_gen.go)
$ make gen-go
generate go files
go run  ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server
wire: github.com/grafana/grafana/pkg/server: wrote /tmp/blitzy/grafana/blitzy-675536c4-a297-4fe3-88d1-6213344dc49c_05d19e/pkg/server/wire_gen.go

# 4) Build the backend binary (Cgo REQUIRED for the sqlite3 driver)
$ CGO_ENABLED=1 go build -o /tmp/grafana_bin ./pkg/cmd/grafana   # exit 0, ~22s
$ ls -l /tmp/grafana_bin
-rwxr-xr-x 1 root root 298085368 /tmp/grafana_bin

# 5) Run from a fresh, empty home/data dir (no custom.ini, no GF_* env)
$ /tmp/grafana_bin server --homepath=/tmp/gf_clean_home > run1.log 2>&1 &
```

Both `yarn.lock` and `package.json` were left unchanged by the immutable install (the `git status --porcelain` above prints nothing), and both `public/build` and `pkg/server/wire_gen.go` are git‑ignored generated artifacts (`.gitignore:9:/public/build`, `.gitignore:194:**/wire_gen.go`), so the build produced **no tracked repository change**.

### 0.4 A required honesty note about the version string (`9.2.0`)

The binary was produced with a plain `go build`, which does **not** inject the release version via linker flags. Therefore the running binary self‑reports version **`9.2.0`**, not `11.5.0-pre`. This is not a mistake in the capture — it is the compiled‑in default:

- `var version = "9.2.0"` [pkg/cmd/grafana/main.go:L17]
- `var commit = gcli.DefaultCommitValue` [pkg/cmd/grafana/main.go:L18] → reported as `NA`
- `var buildBranch = "main"` [pkg/cmd/grafana/main.go:L20]

Observed banner:

> `logger=settings t=2026-07-01T22:40:52.007691468Z level=info msg="Starting Grafana" version=9.2.0 commit=NA branch=main compiled=2026-07-01T22:40:52Z`
> *(command: `grep 'Starting Grafana' run1.log`)*

The same `version`/`commit` — and that the database came up healthy — is independently confirmed at runtime by the **clean‑state** health endpoint, which returned `HTTP/1.1 200 OK` with a JSON body reporting `database: ok`, `version: 9.2.0`, `commit: NA` *(command: `curl -sS -i http://localhost:3000/api/health`)*:

```text
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json; charset=UTF-8
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Wed, 01 Jul 2026 22:40:57 GMT
Content-Length: 62

{
  "database": "ok",
  "version": "9.2.0",
  "commit": "NA"
}
```

Everything else in this document (paths, migrations, users, plugins, headers, DB rows) is independent of this string. Where the version appears in observed output (`/api/health`, the plugin‑compatibility check), it is quoted as‑is and its origin explained. A release build (`make build` with ldflags) would print `11.5.0-pre`.

---

## §1 — Cold‑start initialization ground truth

### 1.1 Entry point → lifecycle

The unified binary's entry point is `func main()` [pkg/cmd/grafana/main.go:L23], which registers the server subcommand `commands.ServerCommand(...)` [pkg/cmd/grafana/main.go:L47]. The `--homepath` flag "defaults to working directory" [pkg/cmd/grafana-server/commands/flags.go:L35-L36] and is threaded into config via `setting.NewCfgFromArgs{HomePath: HomePath}` [pkg/cmd/grafana-server/commands/cli.go:L96-L98].

The server object then runs a deterministic lifecycle in `pkg/server/server.go`:

1. `func (s *Server) Init()` [pkg/server/server.go:L113]
2. `s.writePIDFile()` [pkg/server/server.go:L122] (definition at [pkg/server/server.go:L205]) — a no‑op unless `--pidfile` is set
3. `s.roleRegistry.RegisterFixedRoles(s.context)` [pkg/server/server.go:L130] — registers RBAC fixed roles
4. `return s.provisioningService.RunInitProvisioners(s.context)` [pkg/server/server.go:L134] — **sequential** provisioning in a fixed order: `ProvisionDatasources` [pkg/services/provisioning/provisioning.go:L170] → `ProvisionPlugins` [pkg/services/provisioning/provisioning.go:L176] → `ProvisionAlerting` [pkg/services/provisioning/provisioning.go:L182]. **Dashboards are NOT provisioned here** — `ProvisionDashboards` [pkg/services/provisioning/provisioning.go:L192] runs later inside the provisioning **background service** `Run()` [pkg/services/provisioning/provisioning.go:L191].
5. `func (s *Server) Run()` [pkg/server/server.go:L139] — launches background services (including the provisioning service whose `Run()` performs dashboard provisioning)
6. `s.notifySystemd("READY=1")` [pkg/server/server.go:L176]
7. graceful `func (s *Server) Shutdown(ctx, reason)` [pkg/server/server.go:L185]

The observed startup stream matches this order. Verbatim early‑init lines *(command: `grep -E 'Config loaded from|msg=Target|Path Home|App mode|Connecting to DB|Creating SQLite database file' run1.log`)*:

```text
logger=settings t=2026-07-01T22:40:52.007973438Z level=info msg="Config loaded from" file=/tmp/gf_clean_home/conf/defaults.ini
logger=settings t=2026-07-01T22:40:52.007984323Z level=info msg=Target target=[all]
logger=settings t=2026-07-01T22:40:52.007992799Z level=info msg="Path Home" path=/tmp/gf_clean_home
logger=settings t=2026-07-01T22:40:52.008014674Z level=info msg="App mode production"
logger=sqlstore t=2026-07-01T22:40:52.008398854Z level=info msg="Connecting to DB" dbtype=sqlite3
logger=sqlstore t=2026-07-01T22:40:52.008409882Z level=info msg="Creating SQLite database file" path=/tmp/gf_clean_home/data/grafana.db
```

The only provisioning subsystems that emit info‑level `starting/finished to provision` lines on a clean run are **alerting** (the tail of `RunInitProvisioners`) and **dashboards** (from the provisioning background‑service `Run()`); **datasources** and **plugins** provision successfully but emit **no** info‑level start/finish line because nothing is configured to provision. The alerting lines therefore appear **before** the dashboard lines, and the dashboard lines appear only after `RunInitProvisioners` has returned and the background services have started — the timestamps confirm this ordering *(command: `grep -E 'starting to provision|finished to provision' run1.log`)*:

```text
logger=provisioning.alerting t=2026-07-01T22:40:54.280997125Z level=info msg="starting to provision alerting"
logger=provisioning.alerting t=2026-07-01T22:40:54.28101427Z level=info msg="finished to provision alerting"
logger=provisioning.dashboard t=2026-07-01T22:40:54.315038358Z level=info msg="starting to provision dashboards"
logger=provisioning.dashboard t=2026-07-01T22:40:54.315067991Z level=info msg="finished to provision dashboards"
```

The server then reaches HTTP listen *(command: `grep 'HTTP Server Listen' run1.log`)*:

```text
logger=http.server t=2026-07-01T22:40:54.282988857Z level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=
```

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

> `logger=server t=2026-07-01T22:43:08.929039803Z level=debug msg="Starting background service" service=*tracing.TracingService`
> *(command: `grep 'Starting background service' run_debug.log`)*

```console
$ grep -c 'msg="Starting background service"' run_debug.log
34
```

So **34** background services were enabled and started on a clean install; every other registered service was silently skipped by the `registry.IsDisabled` check above.

**(b) A service that explicitly reports itself disabled because a default property is unset.** Example (debug level):

```text
logger=secrets.kvstore t=2026-07-01T22:43:08.822441143Z level=debug msg="secrets manager evaluator returned false" reason="remote secret management plugin disabled because the property `secrets.use_plugin` is not set to `true`"
```
> *(command: `grep 'remote secret management plugin disabled' run_debug.log`)*

A related case is a service that **starts** but finds its optional feature absent:

> `logger=rendering t=2026-07-01T22:43:08.929145317Z level=debug msg="No image renderer found/installed. For image rendering support please install the grafana-image-renderer plugin. Read more at https://grafana.com/docs/grafana/latest/administration/image_rendering/"`
> *(command: `grep 'No image renderer' run_debug.log`)*

**(c) "Skipped" messages that are visible at the default `info` level.** These are the ones a user actually sees on a normal clean start:

- The migrator emits **3** such warnings on the first run for migrations it detects as already applied but not yet recorded *(command: `grep -c 'Skipping migration: Already executed' run1.log` → `3`)*:

> `logger=migrator t=2026-07-01T22:40:53.405981184Z level=warn msg="Skipping migration: Already executed, but not recorded in migration log" id="drop unique orgID index on alert_configuration if exists"`
> *(command: `grep 'Skipping migration' run1.log`)*

- The **external plugin** and **image‑renderer** subsystems find nothing because their directory does not exist on a fresh install (there is no `data/plugins` yet):

> `logger=plugin.sources t=2026-07-01T22:40:54.14212263Z level=error msg="Failed to load external plugins" error="failed to open plugins path"`
> `logger=renderer.manager t=2026-07-01T22:40:54.14112757Z level=error msg="Failed to get renderer plugin sources" error="failed to open plugins path"`
> *(command: `grep -E 'Failed to load external plugins|Failed to get renderer plugin sources' run1.log`)*

**By contrast, enabled services announce success at `info`** — this is the other half of the user's observation:

> `logger=live.push_http t=2026-07-01T22:40:54.178302748Z level=info msg="Live Push Gateway initialization"`
> `logger=grafanaStorageLogger t=2026-07-01T22:40:54.281165125Z level=info msg="Storage starting"`
> `logger=ngalert.multiorg.alertmanager t=2026-07-01T22:40:54.281495465Z level=info msg="Starting MultiOrg Alertmanager"`
> `logger=app-registry t=2026-07-01T22:40:54.621394757Z level=info msg="app registry initialized"`
> `logger=http.server t=2026-07-01T22:40:54.282988857Z level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=`
> *(command: `grep -E 'Live Push Gateway|Storage starting|Starting MultiOrg Alertmanager|app registry initialized|HTTP Server Listen' run1.log`)*

**Rationale.** The user "never configured anything," yet sees a mix of success and disabled/skip messages because the *defaults themselves* decide this. Enabled‑by‑default services (HTTP server, alerting, live, storage, token auth, etc.) run and log success; disabled‑by‑default subsystems (e.g., the remote secrets plugin, external plugins, the image renderer) either log that they are off or are skipped silently by `registry.IsDisabled`. Nothing here reflects user configuration — it reflects `conf/defaults.ini` plus compiled‑in feature‑flag defaults.

---

## §2 — Default security posture

### 2.1 Why you can "log in with credentials you never set up" — the account **is created** on first start

On the first start (empty database), Grafana **creates** a default admin account. It is not pre‑existing and it is not a permissive/anonymous mode — it is a real row inserted into the `user` table.

- Creation path: `func (ss *SQLStore) ensureMainOrgAndAdminUser(test bool)` [pkg/services/sqlstore/sqlstore.go:L190].
- It first counts users with `SELECT COUNT(id) AS Count FROM "user"` [pkg/services/sqlstore/sqlstore.go:L200] and returns early if any exist (`if stats.Count > 0 { return nil }` [pkg/services/sqlstore/sqlstore.go:L204]).
- If admin creation is not disabled (`if !ss.cfg.DisableInitAdminCreation {` [pkg/services/sqlstore/sqlstore.go:L210]) it creates the user with `Login: ss.cfg.AdminUser` [pkg/services/sqlstore/sqlstore.go:L214], `Email: ss.cfg.AdminEmail` [pkg/services/sqlstore/sqlstore.go:L215], `Password: user.Password(ss.cfg.AdminPassword)` [pkg/services/sqlstore/sqlstore.go:L216], `IsAdmin: true` [pkg/services/sqlstore/sqlstore.go:L217], then logs `Created default admin` [pkg/services/sqlstore/sqlstore.go:L222] and `Created default organization` [pkg/services/sqlstore/sqlstore.go:L230].

Three independent pieces of evidence prove the account was **created, not assumed**:

**(1) The creation log lines** *(command: `grep -E 'Created default admin|Created default organization' run1.log`)*:

```text
logger=sqlstore t=2026-07-01T22:40:54.078602062Z level=info msg="Created default admin" user=admin
logger=sqlstore t=2026-07-01T22:40:54.078698516Z level=info msg="Created default organization"
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
Set-Cookie: grafana_session=<REDACTED-32-hex-session-token>; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax
Set-Cookie: grafana_session_expiry=<REDACTED-epoch>; Path=/; Max-Age=2592000; SameSite=Lax
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Wed, 01 Jul 2026 22:40:58 GMT
Content-Length: 41

{"message":"Logged in","redirectUrl":"/"}
```

> Note on the redaction: only the two **dynamic values** are redacted — the 32‑hex `grafana_session` token and the `grafana_session_expiry` epoch. All header **names and attributes** are shown verbatim (`Path=/`, `Max-Age=2592000`, `HttpOnly`, `SameSite=Lax`). The values came from an **ephemeral local clean‑run instance** (`/tmp/gf_clean_home`) that has since been **stopped and its data directory deleted**, so the token is no longer valid.

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

> `logger=secrets t=2026-07-01T22:40:54.08097988Z level=info msg="Envelope encryption state" enabled=true currentprovider=secretKey.v1`
> *(command: `grep 'Envelope encryption state' run1.log`)*

This is **not** softened here: a production deployment that leaves `secret_key` at this default is using a publicly known key.

### 2.3 Is it running "permissively"? No — basic auth on, anonymous off, sign‑up off

| Setting | Value | Line | Meaning |
|---|---|---|---|
| `[auth.basic] enabled` | `true` | [conf/defaults.ini:L874-L875] | Basic auth **on** (why `curl -u admin:admin` works) |
| `[auth.anonymous] enabled` | `false` | [conf/defaults.ini:L648-L650] | Anonymous access **off** |
| `[users] allow_sign_up` | `false` | [conf/defaults.ini:L483] | Self sign‑up **off** |
| `[users] auto_assign_org` | `true` | [conf/defaults.ini:L489] | New users auto‑join an org |
| `[users] auto_assign_org_id` | `1` | [conf/defaults.ini:L492] | New users auto‑join org id 1 |
| `[users] auto_assign_org_role` | `Viewer` | [conf/defaults.ini:L495] | New users join as Viewer |

The runtime corroborates that anonymous access is off *(command: `curl -sS -u admin:admin http://localhost:3000/api/frontend/settings` → JSON field `anonymousEnabled`)*:

```text
anonymousEnabled: False
buildInfo.version: 9.2.0 | edition: Open Source
```

So the posture is **not** open/permissive: it created one real privileged account guarded by basic auth, with anonymous access and sign‑up both disabled. The only "weakness" is the well‑known default password/`secret_key`, which is precisely why Grafana prompts for a password change on first UI login.

### 2.4 Which auth clients are active, the login flow, brute‑force lockout, and RBAC (each addressed by name)

- **Auth clients** (`pkg/services/authn/authnimpl/registration.go`): it is important to distinguish **registered clients** (wired up at startup) from **login methods usable with no extra configuration**. On a clean run the clients that are unconditionally or by‑default **registered** are: **render** `clients.ProvideRender` [pkg/services/authn/authnimpl/registration.go:L47], **api_key** `clients.ProvideAPIKey` [pkg/services/authn/authnimpl/registration.go:L48], **session** `clients.ProvideSession` (registered because `LoginCookieName != ""`) [pkg/services/authn/authnimpl/registration.go:L50-L51], the **Grafana password** client `clients.ProvideGrafana` (registered because `!cfg.DisableLogin`) [pkg/services/authn/authnimpl/registration.go:L65-L66], **basic** `clients.ProvideBasic` (because `cfg.BasicAuthEnabled`) [pkg/services/authn/authnimpl/registration.go:L74-L75], and **form** `clients.ProvideForm` (because `!cfg.DisableLoginForm`) [pkg/services/authn/authnimpl/registration.go:L78-L79]. Of these, the methods that let the **default admin log in with no additional setup** are **basic auth** and the **login form**, both backed by the **Grafana password** client, plus the **session** cookie that carries the authenticated session forward (the `grafana_session` cookie issued above). **api_key** and **render** are registered but require, respectively, a created API token and a render‑service context to be exercised. The remaining clients require configuration that is absent on a clean run: **LDAP** only when `cfg.LDAPAuthEnabled` (or the SSO‑settings LDAP flag) [pkg/services/authn/authnimpl/registration.go:L59], **proxy** only when `cfg.AuthProxy.Enabled` [pkg/services/authn/authnimpl/registration.go:L88], **JWT** only when `cfg.JWTAuth.Enabled` [pkg/services/authn/authnimpl/registration.go:L97], and **OAuth** one client **per configured provider** [pkg/services/authn/authnimpl/registration.go:L107].
- **Login flow & redirect validation** (`pkg/api/login.go`): the login view is `func (hs *HTTPServer) LoginView(...)` [pkg/api/login.go:L92]; redirect targets are validated by `func (hs *HTTPServer) ValidateRedirectTo(redirectTo string)` [pkg/api/login.go:L47], which rejects absolute/invalid/forbidden targets via `errAbsoluteRedirectTo` [pkg/api/login.go:L42], `errInvalidRedirectTo` [pkg/api/login.go:L43], `errForbiddenRedirectTo` [pkg/api/login.go:L44]. The successful login above returned `redirectUrl":"/"`.
- **Brute‑force lockout** (`pkg/services/loginattempt/loginattemptimpl/login_attempt.go`): attempts are counted in a rolling window `const loginAttemptsWindow = time.Minute * 5` [pkg/services/loginattempt/loginattemptimpl/login_attempt.go:L14]; lockout triggers at `if count >= s.cfg.BruteForceLoginProtectionMaxAttempts` [pkg/services/loginattempt/loginattemptimpl/login_attempt.go:L80]. The **real default threshold is 5** — `cfg.BruteForceLoginProtectionMaxAttempts = security.Key("brute_force_login_protection_max_attempts").MustInt64(5)` [pkg/setting/setting.go:L1512], matching `brute_force_login_protection_max_attempts = 5` [conf/defaults.ini:L355]. Protection is on by default: `disable_brute_force_login_protection = false` [conf/defaults.ini:L352] / `MustBool(false)` [pkg/setting/setting.go:L1511]; the guards are checked at [pkg/services/loginattempt/loginattemptimpl/login_attempt.go:L34,L50,L66].
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

> `logger=sqlstore t=2026-07-01T22:40:52.008398854Z level=info msg="Connecting to DB" dbtype=sqlite3`
> `logger=sqlstore t=2026-07-01T22:40:52.008409882Z level=info msg="Creating SQLite database file" path=/tmp/gf_clean_home/data/grafana.db`
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
-rw-r----- 1 root root 1093632 Jul  1 22:40 data/grafana.db
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

Schema evolution is driven by the migrator, whose log table name is set to `migration_log` (`mg.tableName = "migration_log"` [pkg/services/sqlstore/migrator/migrator.go:L97]). It emits `Starting DB migrations` [pkg/services/sqlstore/migrator/migrator.go:L247], one `Executing migration` line per step [pkg/services/sqlstore/migrator/migrator.go:L356], and a final `migrations completed` summary with `performed`/`skipped`/`duration` [pkg/services/sqlstore/migrator/migrator.go:L287].

**Real magnitude on the first run** *(commands: `grep -c 'msg="Executing migration"' run1.log` and `grep 'migrations completed' run1.log`)*:

```text
Executing migration count: 644
logger=migrator t=2026-07-01T22:40:54.073174608Z level=info msg="migrations completed" performed=626 skipped=0 duration=2.063478193s
logger=resource-migrator t=2026-07-01T22:40:54.278019273Z level=info msg="migrations completed" performed=18 skipped=0 duration=50.764561ms
```

So the default schema is built by **626** migrations (main migrator) plus **18** (the `resource-migrator`) — **644** executed steps, `skipped=0`, taking **2.063478193 s** (main) + **50.764561 ms** (resource). The very first migration is the one that creates the log table itself:

> `logger=migrator t=2026-07-01T22:40:52.009717718Z level=info msg="Executing migration" id="create migration_log table"`
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
Cache-Control: no-store
Content-Type: application/json
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Wed, 01 Jul 2026 22:40:58 GMT
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

> `logger=plugin.store t=2026-07-01T22:40:54.167974608Z level=info msg="Plugins loaded" count=54 duration=25.882743ms`
> *(command: `grep 'Plugins loaded' run1.log`)*

```console
$ curl -sS -u admin:admin http://localhost:3000/api/plugins | python3 -c "import json,sys,collections;d=json.load(sys.stdin);print('count=',len(d));print(collections.Counter(p['signature'] for p in d));print(collections.Counter(p['type'] for p in d))"
count= 49
Counter({'internal': 49})
Counter({'panel': 30, 'datasource': 19})
```

Reconciling the counts (all real, no estimates):

- **49 via `/api/plugins`** = 30 panel + 19 datasource, all `signature=internal`.
- **54 loaded** (store log) = the **22** datasource frontend dirs + **32** panel frontend dirs on disk *(commands: `find public/app/plugins/datasource -maxdepth 1 -mindepth 1 -type d | wc -l` → `22`; `find public/app/plugins/panel -maxdepth 1 -mindepth 1 -type d | wc -l` → `32`; so `22 + 32 = 54`)*.
- The **5** loaded but **not** listed by `/api/plugins` are removed by two explicit filters in the API handler: (a) the **built‑in filter** `if pluginDef.BuiltIn { continue }` [pkg/api/plugins.go:L109-L111] drops the **3 built‑in datasources** `dashboard`, `grafana`, `mixed` (each has `builtIn: true` in its `plugin.json`; they are surfaced instead in `/api/frontend/settings` as `-- Dashboard --`, `-- Grafana --`, `-- Mixed --`); and (b) the **alpha filter** `if pluginDef.State == plugins.ReleaseStateAlpha && !hs.Cfg.PluginsEnableAlpha { continue }` [pkg/api/plugins.go:L105-L107] drops the **2 alpha panels** `debug` and `live` (each has `state: alpha`, and `PluginsEnableAlpha` is `false` by default — `enable_alpha = false` [conf/defaults.ini:L1741], read via `pluginsSection.Key("enable_alpha").MustBool(false)` [pkg/setting/setting_plugins.go:L39]). So **32 panel dirs − 2 alpha = 30** listed, and **22 datasource dirs − 3 built‑in = 19** listed → **30 + 19 = 49**.
- Note the two datasource dirs `azuremonitor` and `cloud-monitoring` **are** in the API list, under their canonical plugin IDs `grafana-azure-monitor-datasource` and `stackdriver` respectively (so they are not part of the 5‑plugin gap).
- **Reconciling the 19 API datasource plugins with the 18 compiled‑in backend map** (§4.3, `NewRegistry(map[...])` [pkg/plugins/backendplugin/coreplugin/registry.go:L102-L121]): a set‑difference of the two lists shows **17** IDs are in **both**. The one backend‑map entry that is **absent** from the API list is `grafana` [pkg/plugins/backendplugin/coreplugin/registry.go:L117] — because the built‑in filter [pkg/api/plugins.go:L109-L111] removes the built‑in `grafana` datasource from `/api/plugins` (it is served as `-- Grafana --` in `/api/frontend/settings`). The two API datasource IDs that are **not** in the 18‑map are `alertmanager` and `jaeger` — proxy/frontend‑handled datasource plugins that have no entry in the compiled‑in backend factory map. Hence `17 (in both) + 2 (alertmanager, jaeger, API‑only) = 19` API datasource plugins, and `17 (in both) + 1 (grafana, backend‑map‑only, filtered) = 18` backend‑map entries *(command: set‑difference of the `/api/plugins` datasource IDs vs the 18 map keys)*.

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

> `logger=plugin.backgroundinstaller t=2026-07-01T22:40:54.440740069Z level=error msg="Failed to install plugin" pluginId=grafana-lokiexplore-app version= error="[plugin.grafanaVersionNotCompatible] grafana-lokiexplore-app is not compatible with your Grafana version: 9.2.0"`
> *(command: `grep 'Failed to install plugin' run1.log`)*

This is a side effect of building without version ldflags; a correctly‑versioned release build would evaluate compatibility against `11.5.0-pre`. It does not affect the core‑plugin inventory above.


---

## §5 — Build/compilation dependency (generated files & "run directly vs build first")

### 5.1 Generated Go DI wiring — `pkg/server/wire_gen.go`

The backend's dependency‑injection graph is **generated**, not hand‑written. `make gen-go` [Makefile:L167] runs Google Wire codegen with `WIRE_TAGS = "oss"` [Makefile:L5] and writes `pkg/server/wire_gen.go`. This file is **absent in a fresh checkout** (it is git‑ignored) and the backend **will not build without it**. Observed generation *(command: `make gen-go`)*:

```text
generate go files
go run  ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server
wire: github.com/grafana/grafana/pkg/server: wrote /tmp/blitzy/grafana/blitzy-675536c4-a297-4fe3-88d1-6213344dc49c_05d19e/pkg/server/wire_gen.go
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

So the UI is served from the on‑disk webpack output `public/build` (**658** entries / **325** `.js` on this build; also git‑ignored via `.gitignore:9:/public/build`). When `public/build` is missing, `validateStaticRootPath` [pkg/setting/setting.go:L1034-L1042] logs a **non‑fatal** error (message at [pkg/setting/setting.go:L1040]) and returns `nil`. Observed by running once from a home whose `public/` had no `build/` subdir *(command: `/tmp/grafana_bin server --homepath=/tmp/gf_nobuild_home`)*. The `error`‑level line is emitted at the very start of settings resolution *(command: `grep 'Failed to detect generated javascript' nobuild.log`)*:

```text
logger=settings t=2026-07-01T22:42:30.238088306Z level=error msg="Failed to detect generated javascript files in public/build"
```

Yet roughly two seconds later — after the normal init sequence — the same run **still reaches HTTP listening** *(command: `grep 'HTTP Server Listen' nobuild.log`)*:

```text
logger=http.server t=2026-07-01T22:42:32.15571547Z level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=
```

and answers requests with a full `HTTP/1.1 200 OK`, proving the missing frontend build is non‑fatal to the backend *(command: `curl -sS -i http://localhost:3000/api/health`)*:

```text
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json; charset=UTF-8
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Wed, 01 Jul 2026 22:42:35 GMT
Content-Length: 62

{
  "database": "ok",
  "version": "9.2.0",
  "commit": "NA"
}
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

`ensureMainOrgAndAdminUser` returns early when any user already exists: `if stats.Count > 0 { return nil }` [pkg/services/sqlstore/sqlstore.go:L204-L206]. So `Created default admin` [pkg/services/sqlstore/sqlstore.go:L222] and `Created default organization` [pkg/services/sqlstore/sqlstore.go:L230] appear on run 1 and are **absent** on restart.

**Run 1** *(command: `grep -E 'Created default admin|Created default organization' run1.log`)*:

```text
logger=sqlstore t=2026-07-01T22:40:54.078602062Z level=info msg="Created default admin" user=admin
logger=sqlstore t=2026-07-01T22:40:54.078698516Z level=info msg="Created default organization"
```

**Run 2 (same `data/`)** *(command: `grep -E 'Created default admin|Created default organization' run2.log || echo ABSENT`)*:

```text
ABSENT
```

The DB confirms the gate: after restart the user count is still 1 *(command: `sqlite3 data/grafana.db 'SELECT COUNT(*) FROM user;'`)* → `1`.

### 6.2 Migration idempotency via `migration_log`

Applied migrations are recorded in `migration_log`; on restart the migrator finds them already recorded and skips them, so the `migrations completed` summary [pkg/services/sqlstore/migrator/migrator.go:L287] flips from all‑performed to all‑skipped. Paired evidence *(command: `grep 'migrations completed' run1.log run2.log`)*:

```text
run1.log:logger=migrator t=2026-07-01T22:40:54.073174608Z level=info msg="migrations completed" performed=626 skipped=0 duration=2.063478193s
run1.log:logger=resource-migrator t=2026-07-01T22:40:54.278019273Z level=info msg="migrations completed" performed=18 skipped=0 duration=50.764561ms
run2.log:logger=migrator t=2026-07-01T22:41:01.186494675Z level=info msg="migrations completed" performed=0 skipped=626 duration=686.608µs
run2.log:logger=resource-migrator t=2026-07-01T22:41:01.326001091Z level=info msg="migrations completed" performed=0 skipped=18 duration=33.025µs
```

On run 2 there are **zero** `Executing migration` lines *(command: `grep -c 'msg="Executing migration"' run2.log`)* → `0`, and the whole main‑migrator pass drops from **2.063478193 s** to **686.608 µs**. The recorded `migration_log` count is unchanged at **626** *(command: `sqlite3 data/grafana.db 'SELECT COUNT(*) FROM migration_log;'`)*.

### 6.3 Net effect on the log volume

The divergence is visible even in raw size: run 1 produced **1354** log lines; the restart produced **61** *(command: `wc -l run1.log run2.log`)*:

```text
  1354 run1.log
    61 run2.log
  1415 total
```

This is the concrete, persistent difference the user observed: the first run builds the schema and seeds the admin/org; every later run finds that state already in `data/` and short‑circuits both.


---

## §7 — Coverage‑pass table

Every named item and every "e.g./such as/including/like" example from the question, mapped to the section that answers it and a one‑line piece of evidence (verbatim capture or `file:line`).

| # | Named item / question part | Section | One‑line evidence |
|---|---|---|---|
| 1 | Cold‑start bootstrap sequence | §1.1 | `Init` [pkg/server/server.go:L113] → `RegisterFixedRoles` [pkg/server/server.go:L130] → `RunInitProvisioners` [pkg/server/server.go:L134] → `Run` [pkg/server/server.go:L139]; observed `HTTP Server Listen address=[::]:3000` |
| 2 | Why services log "disabled"/"skipped" vs success | §1.3 | `if registry.IsDisabled(svc) { continue }` [pkg/server/server.go:L150-L152] (silent); 34 enabled started (debug) |
| 3 | `registry.IsDisabled` / `CanBeDisabled` | §1.3a | `func IsDisabled(...)` [pkg/registry/registry.go:L53]; `CanBeDisabled` [pkg/registry/registry.go:L18-L20] |
| 4 | Concrete disabled service message | §1.3b | `msg="secrets manager evaluator returned false"` — reason "remote secret management plugin disabled because the property secrets.use_plugin is not set to true" (full verbatim line, with backticks, in §1.3b) |
| 5 | Image renderer absent | §1.3b | `msg="No image renderer found/installed. For image rendering support please install the grafana-image-renderer plugin. Read more at https://grafana.com/docs/grafana/latest/administration/image_rendering/"` |
| 6 | Migrator "Skipping migration" | §1.3c | `msg="Skipping migration: Already executed, but not recorded in migration log"` (level=warn; full verbatim line in §1.3c) |
| 7 | `--homepath` default | §1.1 | "defaults to working directory" [pkg/cmd/grafana-server/commands/flags.go:L35-L36] |
| 8 | Entry point `main()` / `ServerCommand` | §1.1 | [pkg/cmd/grafana/main.go:L23], [pkg/cmd/grafana/main.go:L47] |
| 9 | `notifySystemd("READY=1")` | §1.2 | [pkg/server/server.go:L176]; no `READY=1` notification line observed (process not started under systemd) |
| 10 | `Shutdown` lifecycle | §6/§1.1 | `msg="Shutdown started" reason="System signal: terminated"` [pkg/server/server.go:L185] |
| 11 | Login with never‑set creds | §2.1 | `HTTP/1.1 200 OK` + `{"message":"Logged in","redirectUrl":"/"}` |
| 12 | Account **created** (not assumed) | §2.1 | `msg="Created default admin" user=admin`; DB row `1 admin admin@localhost 1` |
| 13 | `ensureMainOrgAndAdminUser` + gate | §2.1/§6.1 | [pkg/services/sqlstore/sqlstore.go:L190]; `if stats.Count > 0 { return nil }` [pkg/services/sqlstore/sqlstore.go:L204-L206] |
| 14 | `admin_user`/`admin_password`/`admin_email` | §2.2 | `admin`/`admin`/`admin@localhost` [defaults.ini:L328,L331,L334] |
| 15 | `secret_key` (shared default) | §2.2 | `secret_key = SW2YcwTIb9zpOOhoPsMm` [defaults.ini:L337]; `Envelope encryption state enabled=true` |
| 16 | `disable_initial_admin_creation` | §2.2 | `false` [defaults.ini:L325]; `MustBool(false)` [setting.go:L1580] |
| 17 | Basic auth ON | §2.3 | `[auth.basic] enabled = true` [defaults.ini:L874-L875]; `curl -u admin:admin` works |
| 18 | Anonymous OFF | §2.3 | `[auth.anonymous] enabled = false` [defaults.ini:L648-L650]; `anonymousEnabled: False` |
| 19 | `allow_sign_up` / auto‑assign org | §2.3 | `allow_sign_up = false` [conf/defaults.ini:L483]; `auto_assign_org = true` [conf/defaults.ini:L489], id `1` [conf/defaults.ini:L492], role `Viewer` [conf/defaults.ini:L495] |
| 20 | Session cookie | §2.1 | `Set-Cookie: grafana_session=<REDACTED>; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`; name from [defaults.ini:L561] |
| 21 | Auth clients (basic/session/jwt/oauth/ldap/proxy/api_key) | §2.4 | registered by default: render/api_key/session/Grafana‑password/basic/form [registration.go:L47-L79]; usable for default admin with no extra config: basic + form (+ Grafana‑password) + session; jwt/ldap/proxy/oauth require config |
| 22 | Login flow / redirect validation | §2.4 | `LoginView` [login.go:L92]; `ValidateRedirectTo` [login.go:L47] |
| 23 | Brute‑force lockout (max attempts) | §2.4 | window `time.Minute*5` [pkg/services/loginattempt/loginattemptimpl/login_attempt.go:L14]; threshold **5** [pkg/setting/setting.go:L1512 / conf/defaults.ini:L355]; gate `count >= s.cfg.BruteForceLoginProtectionMaxAttempts` [pkg/services/loginattempt/loginattemptimpl/login_attempt.go:L80] |
| 24 | RBAC fixed roles | §2.4 | `RegisterFixedRoles` [pkg/server/server.go:L130]; admin `is_admin=1` |
| 25 | `[paths]` data/logs/plugins/provisioning | §3.1 | `data = data` [conf/defaults.ini:L15], `logs = data/log` [conf/defaults.ini:L21], `plugins = data/plugins` [conf/defaults.ini:L24], `provisioning = conf/provisioning` [conf/defaults.ini:L27] |
| 26 | `[database]` sqlite3 / grafana.db | §3.1 | `type = sqlite3` [conf/defaults.ini:L123], `path = grafana.db` [conf/defaults.ini:L164]; `msg="Creating SQLite database file" path=/tmp/gf_clean_home/data/grafana.db` |
| 27 | `data/` tree contents | §3.2 | `data/csv`, `data/grafana.db`, `data/log/grafana.log`, `data/pdf`, `data/png` |
| 28 | `grafana.db` size (magnitude) | §3.2 | `1093632` bytes (≈1.1 MiB) |
| 29 | Sessions in DB | §3.2 | `user_auth_token` count `1` |
| 30 | `migration_log` table | §3.3 | `mg.tableName = "migration_log"` [pkg/services/sqlstore/migrator/migrator.go:L97]; COUNT `626` |
| 31 | Migration count / duration (magnitude) | §3.3/§6.2 | `performed=626 skipped=0 duration=2.063478193s` (+18 resource); 644 executed |
| 32 | `Starting DB migrations` / `Executing migration` | §3.3 | [pkg/services/sqlstore/migrator/migrator.go:L247], [pkg/services/sqlstore/migrator/migrator.go:L356] |
| 33 | Provisioning inert (`apiVersion: 1`) | §3.4 | `datasources/sample.yaml` = `apiVersion: 1`; `/api/datasources` → `[]` |
| 34 | `/api/datasources` empty | §3.4 | `HTTP/1.1 200 OK` `Content-Length: 2` `[]` |
| 35 | Plugin classes core/bundled/external/cdn | §4.1 | [pkg/plugins/plugins.go:L509-L512]; `IsCorePlugin` [pkg/plugins/plugins.go:L494-L495] |
| 36 | Source registration (core/bundled/external) | §4.2 | [sources.go:L26], [sources.go:L27], [sources.go:L35]; `corePluginPaths` [sources.go:L64-L66] |
| 37 | 18 compiled‑in backend data sources | §4.3 | `ProvideCoreRegistry` [coreplugin/registry.go:L95]; map [coreplugin/registry.go:L102-L121] (18 named) |
| 38 | `/api/plugins` count & all core | §4.4 | `count= 49`, `Counter({'internal': 49})`, `panel:30 datasource:19` |
| 39 | 54 loaded vs 49 listed reconciliation | §4.4 | `Plugins loaded count=54`; 22 ds dirs − 3 builtins = 19 |
| 40 | Builtin datasources (Dashboard/Grafana/Mixed) | §4.4 | `datasources: ['-- Dashboard --','-- Grafana --','-- Mixed --']` |
| 41 | Why plugins appear un‑installed (core) | §4.5 | all `signature=internal`; `plugins-bundled/external.json` = `{"plugins": []}` |
| 42 | No bundled / no external / no CDN | §4.5 | empty `external.json`; external path `failed to open plugins path` |
| 43 | `ErrInstallCorePlugin` / `ErrUninstallCorePlugin` | §4.6 | [installer.go:L99], [installer.go:L198] |
| 44 | Generated `wire_gen.go` | §5.1 | `make gen-go` writes `pkg/server/wire_gen.go` [Makefile:L167] (full verbatim wire output shown in §5.1); git‑ignored `.gitignore:194:**/wire_gen.go` |
| 45 | Frontend not embedded (`embed.go`) | §5.2 | `//go:embed cue.mod/module.cue` only |
| 46 | `public/build` + missing‑build error | §5.2 | `Failed to detect generated javascript files in public/build` [setting.go:L1040]; non‑fatal → `HTTP 200` |
| 47 | Run directly vs build first | §5.3 | backend needs `wire_gen.go`; UI needs `public/build` → not fully equivalent |
| 48 | Makefile targets / `WIRE_TAGS` | §5.1/§5.3 | `WIRE_TAGS="oss"` [Makefile:L5]; `gen-go` [Makefile:L167]; `build` [Makefile:L229]; `run-go` app_mode=development [Makefile:L238] |
| 49 | Developer‑guide flow (Cgo/yarn/make run/3000) | §5.3 | [developer-guide.md:L12,L71,L79,L119,L123,L135] |
| 50 | First‑run vs subsequent gate | §6.1 | `Created default admin` present run1, `ABSENT` run2 |
| 51 | Migration idempotency | §6.2 | run1 `performed=626 skipped=0`; run2 `performed=0 skipped=626` |
| 52 | `app_mode` / `http_port` | §1.1 | `App mode production` [defaults.ini:L7]; `[::]:3000` [defaults.ini:L41] |
| 53 | Version string `9.2.0` (observed vs `11.5.0-pre`) | §0.4 | banner `version=9.2.0 commit=NA branch=main`; `var version="9.2.0"` [pkg/cmd/grafana/main.go:L17] |

### Verdict

Every one of the six question areas is answered by name with paired verbatim evidence and exact `file:line` citations. Nothing was adjusted toward an expected value — most notably the observed `9.2.0` version string (§0.4), the shared well‑known `secret_key` (§2.2), and the non‑fatal missing‑`public/build` error (§5.2) are reported exactly as seen.

