# Grafana Local Startup — What the Boot Sequence Reveals

> A first-time operator's guide to four things Grafana's local startup tells you: the HTTP readiness signal, what gets finalized when you sign in with `admin`/`admin`, what a healthy `/api/health` really means, and which background services are already running before the UI appears.

This document answers each sub-question from **direct observation of a running Grafana instance** — the code was **built and run first**, and every quoted value below is real output captured from that run, paired with the exact command that produced it and with an exact `file:line` citation into the source.

---

## Build & Run Context (how these observations were produced)

Everything below was captured from a locally built binary of this exact commit, run against an **isolated `/tmp` home/config** so the repository stayed byte-for-byte unchanged.

| Item            | Value                                                                                             | Source                                        |
| --------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Source branch   | `grafana_4550cfb5b728`                                                                            | (branch name = deliverable filename)          |
| HEAD commit     | `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`                                                        | `git rev-parse HEAD`                          |
| Product version | `11.5.0-pre`                                                                                      | `package.json:L6` — `"version": "11.5.0-pre"` |
| Go toolchain    | `go 1.23.1`                                                                                       | `go.mod:L3` — `go 1.23.1`                     |
| CGO             | `CGO_ENABLED=1` (required by the `mattn/go-sqlite3` driver backing the default dev DB)            | build step                                    |
| Log level       | `[log] level = debug` (required so the per-service `Starting background service` line is emitted) | isolated `/tmp` config                        |

**Build (Wire code is git-ignored and generated on the fly, then removed afterward):**

```text
export CGO_ENABLED=1
go run ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server
go build -tags "oss" -o /tmp/grafana-bin/grafana ./pkg/cmd/grafana
```

**Run (isolated home/config under `/tmp`; the repo is used only as `--homepath` for read-only assets and `conf/defaults.ini`):**

```text
/tmp/grafana-bin/grafana server --homepath=<repo> --config=/tmp/grafana-run/custom.ini > /tmp/grafana-run/boot.log 2>&1 &
```

The `/tmp/grafana-run/custom.ini` sets only `[paths]` (data/logs/plugins/provisioning under `/tmp`) and `[log] level = debug`. It deliberately does **not** touch `[server]`, so the exposure values observed in R1 are Grafana's **defaults**.

The very first banner line establishes the build identity (note the placeholder `version`/`commit`, explained in R3):

```text
logger=settings t=2026-07-01T04:09:19.655682196Z level=info msg="Starting Grafana" version=9.2.0 commit=NA branch=main compiled=2026-07-01T04:09:19Z
```

**Why the answers are quotable verbatim.** Grafana logs in a structured key/value format — `logger=<name> level=<lvl> msg="..." key=value ...` — so each answer can be lifted directly from the log stream and mapped field-by-field to the code that emitted it.

> **The single most important disambiguation for an operator:** Grafana exposes **two** health endpoints. `/api/health` is a JSON **readiness** probe that actually checks the database; `/healthz` is a plain-text **liveness** probe that returns `Ok` with no dependency checks. The question ("a health endpoint that returns JSON") is unambiguously **`/api/health`** — see R3.

---

## R1 — The log line that signals the HTTP server is listening, and what it reveals about exposure

**Observed (verbatim):**

```text
logger=http.server t=2026-07-01T04:09:21.804072259Z level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=
```

**Producing command:**

```text
grep 'HTTP Server Listen' /tmp/grafana-run/boot.log
```

**What it is and why it's the readiness signal.** This is the line that flips the server from "initializing" to "accepting connections." It is the last major startup line before the socket is served, emitted by:

```go
hs.log.Info("HTTP Server Listen", "address", listener.Addr().String(), "protocol",
    hs.Cfg.Protocol, "subUrl", hs.Cfg.AppSubURL, "socket", hs.Cfg.SocketPath)
```

at **`pkg/api/http_server.go:L434-L435`**. The `logger=http.server` name comes from `log.New("http.server")` at **`pkg/api/http_server.go:L323`**. The call fires from inside the HTTP server's `Run()` once its listener has been created, which is why it is the concrete "we are live" marker.

**Field-by-field decode (each value is an exact literal from the observed line):**

- **`address=[::]:3000`** — the server is bound to **all interfaces** on **port 3000**. `[::]` is the IPv6 _unspecified_ address (dual-stack: it also accepts IPv4 connections), and `:3000` is the port. It binds all interfaces because the bind address is **empty by default**: `http_addr =` at **`conf/defaults.ini:L38`**, whose comment at **`conf/defaults.ini:L37`** states the ip address to bind to, empty binds to all interfaces. The default port `3000` is `http_port = 3000` at **`conf/defaults.ini:L41`**, assigned in code by `cfg.HTTPPort = valueAsString(server, "http_port", "3000")` at **`pkg/setting/setting.go:L1862`**.
- **`protocol=http`** — plain HTTP (not HTTPS/h2/socket). This is the default `protocol = http` at **`conf/defaults.ini:L32`**, assigned as `cfg.Protocol = HTTPScheme` at **`pkg/setting/setting.go:L1830`**.
- **`subUrl=`** — empty. No URL sub-path is configured (no `[server] root_url` sub-path / `AppSubURL`), so Grafana is served from the root path `/`.
- **`socket=`** — empty. Only populated when `protocol = socket` (a Unix domain socket); since `protocol=http`, there is no socket path.

**Operator takeaway:** when you see `msg="HTTP Server Listen" address=[::]:3000 protocol=http`, Grafana is reachable at `http://localhost:3000` (and on every interface of the host, since the bind address is empty) over plain HTTP at the root path.

---

## R2 — What Grafana forces after `admin`/`admin` sign-in, and the internal state being finalized

The screen you hit immediately after signing in with the default credentials is the **"change your password"** prompt. The key insight — and the thing most operators conflate — is that **two different layers** are involved:

1. The **backend has already finalized your authenticated session** (and set its cookie) at sign-in, _before_ any password change.
2. The **forced password-change screen is a purely client-side (frontend) safeguard** that fires only because the password you submitted is still the literal default `'admin'`.

**Observed login response (verbatim — the session-token value is redacted for security, see note):**

```text
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
Set-Cookie: grafana_session=REDACTED_SESSION_TOKEN; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax
Set-Cookie: grafana_session_expiry=1782879575; Path=/; Max-Age=2592000; SameSite=Lax
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Wed, 01 Jul 2026 04:09:40 GMT
Content-Length: 41

{"message":"Logged in","redirectUrl":"/"}
```

> **Security note (redaction):** the real response contained `grafana_session=<32-hex-character session token>`. That value is a live credential, so it has been replaced above with `REDACTED_SESSION_TOKEN`. Every other byte of the response is quoted exactly as observed.

**Producing command:**

```text
curl -i -X POST -H 'Content-Type: application/json' -d '{"user":"admin","password":"admin"}' http://localhost:3000/login
```

**Corroborating boot log (the default admin is created on first boot):**

```text
logger=sqlstore t=2026-07-01T04:09:21.60550417Z level=info msg="Created default admin" user=admin
```

### The backend layer — what internal state is finalized

The internal state finalized at sign-in is the **server-side authenticated session and its `HttpOnly` auth cookie**. Notice what the response body does **and does not** contain: it is exactly `{"message":"Logged in","redirectUrl":"/"}` — there is **no** "must change password" flag anywhere in it. The backend considers you fully logged in.

- The POST `/login` handler is `LoginPost` at **`pkg/api/login.go:L230`**, which returns `authn.HandleLoginResponse(...)` at **`pkg/api/login.go:L241`**.
- The authoritative source of the observed body is `HandleLoginResponse` at **`pkg/services/authn/authn.go:L255-L259`**:

  ```go
  func HandleLoginResponse(r *http.Request, w http.ResponseWriter, cfg *setting.Cfg, identity *Identity, validator RedirectValidator, features featuremgmt.FeatureToggles) *response.NormalResponse {
      result := map[string]any{"message": "Logged in"}
      result["redirectUrl"] = handleLogin(r, w, cfg, identity, validator, features, "")
      return response.JSON(http.StatusOK, result)
  }
  ```

  This is why the body is `{"message":"Logged in","redirectUrl":"/"}` — `message` at **`:L256`** and `redirectUrl` at **`:L257`**.

- Its helper `handleLogin` (**`pkg/services/authn/authn.go:L272`**) is where the state is actually written: it calls `WriteSessionCookie(w, cfg, identity.SessionToken)` at **`:L273`** and computes `redirectURL := cfg.AppSubURL + "/"` at **`:L275`** — which is exactly why `redirectUrl` is `"/"` (there is no configured sub-path).
- `WriteSessionCookie` is defined at **`pkg/services/authn/authn.go:L313`**; it writes the cookie via `cookies.WriteCookie(w, cfg.LoginCookieName, ...)`. The cookie name `grafana_session` is the default `login_cookie_name` — `login_cookie_name = grafana_session` at **`conf/defaults.ini:L561`**, assigned as `cfg.LoginCookieName = valueAsString(auth, "login_cookie_name", "grafana_session")` at **`pkg/setting/setting.go:L1591`**. The observed `Max-Age=2592000` is 30 days (the default login lifetime).

Note the **two** `Set-Cookie` headers observed: the primary `grafana_session` cookie is `HttpOnly` (inaccessible to JavaScript — this is your actual auth token), while the companion `grafana_session_expiry` cookie is **not** `HttpOnly` (it carries only the expiry timestamp so the frontend can pre-emptively refresh). This matches `WriteSessionCookie`, which writes the expiry cookie with `NotHttpOnly = true`.

> **Important correction (surfaced by running the code, not just reading it):** there is a _different_ literal `{"message": "Logged in"}` at **`pkg/api/login.go:L224`**, but that belongs to `LoginAPIPing` (**`pkg/api/login.go:L222`**) — the **`/api/login/ping`** endpoint, which returns **no** `redirectUrl`. It is **not** the POST-`/login` response. The observed body with `redirectUrl` proves the true source is `authn.HandleLoginResponse` at **`pkg/services/authn/authn.go:L255-L259`**. Citing `login.go:L224` here would be misleading.

### The frontend layer — what you actually _see_ forced

The "change your password" screen is decided **entirely in the browser**, in the login controller. There is no backend flag driving it:

- The decision is at **`public/app/core/components/Login/LoginCtrl.tsx:L117-L122`**:

  ```tsx
  if (formModel.password !== 'admin' || config.ldapEnabled || config.authProxyEnabled) {
    this.toGrafana();
    return;
  } else {
    this.changeView(formModel.password === 'admin');
  }
  ```

  The prompt fires **only** when the submitted password is exactly the literal `'admin'` (and LDAP / auth-proxy are not in play). Any other password takes the `this.toGrafana()` branch and you proceed straight to the app.

- `changeView` sets the UI into the warning state — `isChangingPassword: true` and `showDefaultPasswordWarning` — at **`public/app/core/components/Login/LoginCtrl.tsx:L176-L181`**.
- If you proceed with the change, the frontend issues `PUT /api/user/password` with body `{ newPassword, confirmNew, oldPassword: 'admin' }` at **`public/app/core/components/Login/LoginCtrl.tsx:L78-L103`**.
- If you choose to skip, `skipPasswordChange: toGrafana` at **`public/app/core/components/Login/LoginCtrl.tsx:L220`** simply routes you into Grafana — the session was valid all along.

**Why `admin`/`admin` works at all:** the bundled defaults are `admin_user = admin` at **`conf/defaults.ini:L328`** and `admin_password = admin` at **`conf/defaults.ini:L331`**, and the `Created default admin user=admin` log line above confirms this account was created on first boot.

**Operator takeaway:** "the internal state being finalized" is the **server-side authenticated session and its `HttpOnly` `grafana_session` cookie** — established the moment the POST `/login` returns `200`. The password prompt you see is a **frontend default-password warning keyed on the still-default credential**, not a backend gate; you are already authenticated when it appears.

---

## R3 — What a healthy `/api/health` looks like, and what the `database` field really means

**Observed (verbatim):**

```text
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json; charset=UTF-8
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Wed, 01 Jul 2026 04:09:40 GMT
Content-Length: 62

{
  "database": "ok",
  "version": "9.2.0",
  "commit": "NA"
}
```

**Producing command:**

```text
curl -i http://localhost:3000/api/health
```

### How the response is built

The JSON is serialized from the `healthResponse` struct at **`pkg/api/http_server.go:L694-L699`**:

```go
type healthResponse struct {
    Database         string `json:"database"`
    Version          string `json:"version,omitempty"`
    Commit           string `json:"commit,omitempty"`
    EnterpriseCommit string `json:"enterpriseCommit,omitempty"`
}
```

It is produced by the handler `apiHealthHandler` at **`pkg/api/http_server.go:L710`**, registered as middleware via `m.Use(hs.apiHealthHandler)` at **`pkg/api/http_server.go:L634`**. The handler initializes `Database: "ok"`, then fills `Version`/`Commit` (gated by `if !hs.Cfg.Anonymous.HideVersion` at **`:L719`**, from `hs.Cfg.BuildVersion`/`hs.Cfg.BuildCommit` at **`:L720-L721`**), and finally serializes with `json.MarshalIndent(data, "", "  ")` at **`pkg/api/http_server.go:L736`** — the `"  "` indent is exactly why the body is pretty-printed with two-space indentation and why `Content-Length` is `62`.

### What the `database` field is really telling you

The `database` field is **not** a mere "the server answered" signal — it is the cached result of an actual **`SELECT 1`** connectivity probe against Grafana's database. See `databaseHealthy` at **`pkg/api/health.go:L10-L24`**:

```go
func (hs *HTTPServer) databaseHealthy(ctx context.Context) bool {
    const cacheKey = "db-healthy"

    if cached, found := hs.CacheService.Get(cacheKey); found {
        return cached.(bool)
    }

    err := hs.SQLStore.WithDbSession(ctx, func(session *db.Session) error {
        _, err := session.Exec("SELECT 1")
        return err
    })
    healthy := err == nil

    hs.CacheService.Set(cacheKey, healthy, time.Second*5)
    return healthy
}
```

- The probe query is `session.Exec("SELECT 1")` at **`pkg/api/health.go:L18`**.
- The boolean result is cached for 5 seconds via `hs.CacheService.Set(cacheKey, healthy, time.Second*5)` at **`pkg/api/health.go:L23`** — so the endpoint reflects DB reachability within the last 5 seconds without hammering the database on every call.

Therefore:

- **`"database": "ok"`** = Grafana successfully executed `SELECT 1` against its database within the last 5 seconds. This is a genuine **readiness** signal — the system is not just responsive, it can actually reach its data store.
- **`"database": "failing"`** = the probe failed. In that branch the handler sets `data.Database = "failing"` at **`pkg/api/http_server.go:L728`** and returns **HTTP `503` Service Unavailable** via `ctx.Resp.WriteHeader(http.StatusServiceUnavailable)` at **`pkg/api/http_server.go:L730`**. (This failure path was verified by reading the handler; the running instance's database was healthy, so the observed status was `200`.)

### `/api/health` (readiness) vs `/healthz` (liveness) — do not confuse them

The operator's "health endpoint that returns JSON" is unambiguously **`/api/health`**. Grafana also exposes a _separate_ liveness endpoint, `/healthz`, which does **no** dependency checks and returns plain text. Observed contrast:

```text
HTTP/1.1 200 OK
Cache-Control: no-store
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Wed, 01 Jul 2026 04:09:40 GMT
Content-Length: 2
Content-Type: text/plain; charset=utf-8

Ok
```

**Producing command:**

```text
curl -i http://localhost:3000/healthz
```

`/healthz` returns the literal two-byte string `Ok` (`Content-Length: 2`, `Content-Type: text/plain`). Its handler `healthzHandler` is at **`pkg/api/http_server.go:L680-L691`** — it writes `[]byte("Ok")` at **`pkg/api/http_server.go:L688`** — and is registered via `m.Use(hs.healthzHandler)` at **`pkg/api/http_server.go:L633`**. Use `/healthz` to answer "is the process alive?" and `/api/health` to answer "is the system ready, including its database?"

### Build-version caveat (why `version`/`commit` look wrong locally)

The observed `"version": "9.2.0"` and `"commit": "NA"` are **artifacts of a local build without version ldflags**, not a defect. `BuildVersion` and `BuildCommit` are package-level variables (declared at **`pkg/setting/setting.go:L65-L66`**) that are populated at link time and copied into the config by `cfg.BuildVersion = BuildVersion` / `cfg.BuildCommit = BuildCommit` at **`pkg/setting/setting.go:L1076-L1077`**. Without ldflags they retain their in-source defaults, which is also why the `Starting Grafana` banner showed `version=9.2.0 commit=NA`. The **real** product version of this checkout is `11.5.0-pre` per **`package.json:L6`**, so the official container build reports the true `11.5.x` version/commit.

**Crucially, this build artifact does not affect the meaning of the `database` field** — `"database": "ok"` still means the `SELECT 1` readiness probe succeeded, regardless of what the `version`/`commit` fields display.

**Operator takeaway:** a healthy readiness response is `HTTP/1.1 200 OK` with `"database": "ok"`; that `ok` is a live `SELECT 1` result (cached 5 s), and a DB problem would instead yield `"database": "failing"` with HTTP `503`. Target `/api/health` (JSON) for readiness, `/healthz` (plain `Ok`) for liveness, and ignore the placeholder `version`/`commit` on a local no-ldflags build.

---

## R4 — Which background services start at boot, and how much of Grafana is active before the UI

**Observed count (verbatim):**

```text
34
```

**Producing command:**

```text
grep 'Starting background service' /tmp/grafana-run/boot.log | wc -l
```

**Representative line (verbatim):**

```text
logger=server t=2026-07-01T04:09:21.802514522Z level=debug msg="Starting background service" service=*api.HTTPServer
```

### What emits these lines, and why they are Go type names

Each line is emitted by `s.log.Debug("Starting background service", "service", serviceName)` at **`pkg/server/server.go:L162`** (logger `server` from `log.New("server")` at **`pkg/server/server.go:L74`**). The `service=` value is `reflect.TypeOf(service).String()` computed at **`pkg/server/server.go:L155`**, which is why you see Go type names like `*api.HTTPServer` rather than friendly labels.

Because the log call is `s.log.Debug(...)`, **this line is only visible at `level = debug`** — the run above set `[log] level = debug` specifically to surface it. At the default `info` level you would instead see the individual services' own `info` startup logs, not these per-service `Starting background service` lines.

### They start concurrently as goroutines

The run loop at **`pkg/server/server.go:L148-L176`** launches **each** service as a concurrent goroutine via `s.childRoutines.Go(...)` (an `errgroup`), and **skips disabled** services with `if registry.IsDisabled(svc) { continue }` at **`pkg/server/server.go:L150-L152`**. This concurrency is visible in the capture: all 34 `Starting background service` lines share essentially the same timestamp (`~2026-07-01T04:09:21.8024xx`), i.e. they fire together rather than sequentially.

### The full set observed (all 34 distinct `service=` values, verbatim)

```text
*acimpl.Service
*angulardetectorsprovider.Dynamic
*anonimpl.AnonDeviceService
*api.HTTPServer
*apiserver.service
*appregistry.Service
*authimpl.UserAuthTokenService
*cleanup.CleanUpService
*dynamic.KeyRetriever
*live.GrafanaLive
*loginattemptimpl.Service
*manager.SecretsService
*manager.ServiceAccountsService
*metric.Service
*metrics.InternalMetricsService
*migrations.SecretMigrationProviderImpl
*ngalert.AlertNG
*notifications.NotificationService
*pluginexternal.Service
*plugininstaller.Service
*pluginstore.Service
*provisioning.ProvisioningServiceImpl
*pushhttp.Gateway
*remotecache.RemoteCache
*rendering.RenderingService
*service.UsageStats
*ssosettingsimpl.Service
*statscollector.Service
*store.dummyEntityEventsService
*store.standardStorageService
*supportbundlesimpl.Service
*tracing.TracingService
*updatechecker.GrafanaService
*updatechecker.PluginsService
```

**Producing command:**

```text
grep 'Starting background service' /tmp/grafana-run/boot.log | sed -E 's/.*service=//' | sort -u
```

These map directly to the registry assembled by `ProvideBackgroundServiceRegistry` at **`pkg/registry/backgroundsvcs/background_services.go:L53-L118`**, which registers its arguments through the `NewBackgroundServiceRegistry(...)` call at **`pkg/registry/backgroundsvcs/background_services.go:L80`**. That call lists **36** services; the run observed **34** started, and the difference is exactly the disabled services skipped by `registry.IsDisabled` (see above). What the components are:

- **`*api.HTTPServer`** — the HTTP server **is itself** one of the background services. The `HTTP Server Listen` line from R1 is emitted from _inside_ this service's goroutine. (In the boot log, `service=*api.HTTPServer` appears at line 2359 and its `HTTP Server Listen` at line 2404.)
- **`*ngalert.AlertNG`** — the unified alerting engine.
- **`*live.GrafanaLive`** — the live/streaming (WebSocket) subsystem.
- **`*notifications.NotificationService`** — email/notification dispatch.
- **`*rendering.RenderingService`** — image/PDF rendering coordinator.
- **`*pluginstore.Service`**, **`*plugininstaller.Service`**, **`*pluginexternal.Service`**, **`*angulardetectorsprovider.Dynamic`** — the plugin subsystem (store, installer, external plugins, Angular deprecation detection).
- **`*provisioning.ProvisioningServiceImpl`** — file-based provisioning of data sources/dashboards/etc.
- **`*authimpl.UserAuthTokenService`**, **`*acimpl.Service`**, **`*anonimpl.AnonDeviceService`**, **`*loginattemptimpl.Service`**, **`*ssosettingsimpl.Service`**, **`*manager.ServiceAccountsService`** — auth/session tokens, access control, anonymous-device tracking, login-attempt throttling, SSO settings, service accounts.
- **`*tracing.TracingService`** — distributed tracing.
- **`*remotecache.RemoteCache`**, **`*manager.SecretsService`**, **`*migrations.SecretMigrationProviderImpl`** — remote cache and secrets management/migration.
- **`*store.standardStorageService`**, **`*store.dummyEntityEventsService`**, **`*apiserver.service`**, **`*appregistry.Service`** — unified storage, entity events, and the Grafana API server / app registry (Kubernetes-style APIs).
- **`*service.UsageStats`**, **`*statscollector.Service`**, **`*metric.Service`**, **`*metrics.InternalMetricsService`**, **`*updatechecker.GrafanaService`**, **`*updatechecker.PluginsService`**, **`*supportbundlesimpl.Service`**, **`*dynamic.KeyRetriever`**, **`*cleanup.CleanUpService`**, **`*pushhttp.Gateway`** — usage/stats collection, internal metrics, update checkers (core + plugins), support bundles, key retrieval, periodic cleanup, and the Prometheus push gateway.

### How much of Grafana is active before the UI appears

Essentially the **entire backend**. Because these services all start (as goroutines) **before** the frontend static assets are served — and the HTTP server itself is one of them — by the time you can load the UI the backend is already fully up. The boot log corroborates that the data layer was fully prepared first:

```text
logger=migrator t=2026-07-01T04:09:21.599916382Z level=info msg="migrations completed" performed=626 skipped=0 duration=1.942299461s
logger=resource-migrator t=2026-07-01T04:09:21.799765648Z level=info msg="migrations completed" performed=18 skipped=0 duration=86.478082ms
```

**Producing command:**

```text
grep 'migrations completed' /tmp/grafana-run/boot.log
```

So on this fresh first boot, **626** core database migrations were applied (plus **18** resource migrations) _before_ the services started, and then alerting, live streaming, provisioning, plugins, auth, storage and the rest all came alive concurrently — after which `HTTP Server Listen` fired. The UI (static assets) is the _last_ thing to matter, served by an already-fully-initialized backend.

**Operator takeaway:** the `Starting background service` lines are Grafana enumerating its ~three-dozen concurrently-launched subsystems (34 started here of 36 registered, the rest disabled). The HTTP server is one of them, so "the server is listening" and "the backend is fully up" happen essentially together — the database is migrated and alerting/live/provisioning/plugins/auth are all running before the UI is ever rendered.

---

## Coverage Pass

Re-reading the original four-part question, each sub-part is explicitly answered above:

- **R1 — "Which log line signals the HTTP server is listening, and what does it say about where and how it's exposed?"** ✔ The line is `msg="HTTP Server Listen"` (`logger=http.server`, emitted at `pkg/api/http_server.go:L434-L435`). Exposure decoded from the observed fields: `address=[::]:3000` (all interfaces, port `3000`), `protocol=http`, empty `subUrl=` and `socket=` — with the defaults traced to `conf/defaults.ini:L32/L37/L38/L41` and `pkg/setting/setting.go:L1830/L1862`.
- **R2 — "After signing in with default admin credentials, Grafana asks for something; what internal state is being finalized?"** ✔ The forced screen is the **client-side** password-change prompt that fires only when the submitted password equals `'admin'` (`public/app/core/components/Login/LoginCtrl.tsx:L117-L122`). The **backend** state finalized is the authenticated **session + `HttpOnly` `grafana_session` cookie**, established before any change — observed body `{"message":"Logged in","redirectUrl":"/"}` from `authn.HandleLoginResponse` (`pkg/services/authn/authn.go:L255-L259`), with the note that `pkg/api/login.go:L224` is the unrelated `LoginAPIPing`.
- **R3 — "What does a healthy `/api/health` look like, and what is the `database` field really telling me?"** ✔ Healthy response is `HTTP/1.1 200 OK` with `{"database":"ok","version":"9.2.0","commit":"NA"}` (serialized from `pkg/api/http_server.go:L694-L699`). `database` is the cached **`SELECT 1`** readiness probe (`pkg/api/health.go:L10-L24`, query at `:L18`, 5 s cache at `:L23`); a DB failure yields `"failing"` + HTTP `503` (`pkg/api/http_server.go:L728/L730`). Disambiguated from `/healthz` (plain `Ok`, `pkg/api/http_server.go:L680-L691`), with the `version`/`commit` placeholder caveat (local no-ldflags build; real version `11.5.0-pre` per `package.json:L6`) that does **not** affect the `database` field's meaning.
- **R4 — "Which components are those background-service logs hinting at, and how much of Grafana is active before the UI appears?"** ✔ **34** `Starting background service` lines observed (`pkg/server/server.go:L162`), enumerated as concrete Go types (including `*api.HTTPServer` itself), launched concurrently as goroutines (`pkg/server/server.go:L148-L176`, disabled ones skipped at `:L150-L152`) from the 36-entry registry (`pkg/registry/backgroundsvcs/background_services.go:L53-L118`). Because the HTTP server is one of them and the DB is already migrated (`performed=626`), essentially the full backend is active before the UI is served.

---

## Appendix — Read-Only Methodology & Verification

This was a strict read-only investigation. All build/run artifacts were confined to `/tmp`:

- The binary was built to `/tmp/grafana-bin/grafana`; the runtime home/config/data lived under `/tmp/grafana-run/`.
- The generated Wire code (`pkg/server/wire_gen.go`) is git-ignored and was regenerated only to build, then removed afterward.
- All temporary observation captures (`/tmp/grafana-run/*.txt`, `boot.log`) live under `/tmp` and are not part of the repository.

After the investigation, the repository contained exactly one change — this document. Because the whole `blitzy/` tree is newly untracked, the bare porcelain output collapses it to the directory:

```text
$ git status --porcelain
?? blitzy/
```

Expanding untracked files confirms the single new file (the pre-existing `blitzy/screenshots/` and `blitzy/screen_recordings/` directories are empty, so git does not list them):

```text
$ git status --porcelain --untracked-files=all
?? blitzy/documentation/grafana_4550cfb5b728.md
```

No existing source, configuration, test, or documentation file was modified.

---

### Citation index (verified `file:line` references)

| Ref   | Location                                                                                          | What it is                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| R1    | `pkg/api/http_server.go:L434-L435`                                                                | `hs.log.Info("HTTP Server Listen", ...)`                                                           |
| R1    | `pkg/api/http_server.go:L323`                                                                     | `log.New("http.server")`                                                                           |
| R1    | `conf/defaults.ini:L32` / `:L37` / `:L38` / `:L41`                                                | `protocol = http` / bind-comment / `http_addr =` / `http_port = 3000`                              |
| R1    | `pkg/setting/setting.go:L1830` / `:L1862`                                                         | `cfg.Protocol = HTTPScheme` / `cfg.HTTPPort = valueAsString(server, "http_port", "3000")`          |
| R2    | `pkg/api/login.go:L230` / `:L241`                                                                 | `LoginPost` / returns `authn.HandleLoginResponse(...)`                                             |
| R2    | `pkg/api/login.go:L222` / `:L224`                                                                 | `LoginAPIPing` (`/api/login/ping`) / its unrelated `{"message":"Logged in"}`                       |
| R2    | `pkg/services/authn/authn.go:L255-L259`                                                           | `HandleLoginResponse` — true source of the observed body                                           |
| R2    | `pkg/services/authn/authn.go:L273` / `:L275` / `:L313`                                            | `WriteSessionCookie(...)` / `redirectURL := cfg.AppSubURL + "/"` / `func WriteSessionCookie`       |
| R2    | `public/app/core/components/Login/LoginCtrl.tsx:L117-L122` / `:L176-L181` / `:L78-L103` / `:L220` | password-change decision / `changeView` / `PUT /api/user/password` / skip                          |
| R2    | `conf/defaults.ini:L328` / `:L331` / `:L561`                                                      | `admin_user = admin` / `admin_password = admin` / `login_cookie_name = grafana_session`            |
| R2    | `pkg/setting/setting.go:L1591`                                                                    | `cfg.LoginCookieName = valueAsString(auth, "login_cookie_name", "grafana_session")`                |
| R3    | `pkg/api/http_server.go:L694-L699`                                                                | `healthResponse` struct                                                                            |
| R3    | `pkg/api/http_server.go:L710` / `:L634`                                                           | `apiHealthHandler` / `m.Use(hs.apiHealthHandler)`                                                  |
| R3    | `pkg/api/http_server.go:L728` / `:L730` / `:L736`                                                 | `"failing"` / HTTP `503` / `json.MarshalIndent(data, "", "  ")`                                    |
| R3    | `pkg/api/http_server.go:L680-L691` / `:L688` / `:L633`                                            | `healthzHandler` / writes `[]byte("Ok")` / `m.Use(hs.healthzHandler)`                              |
| R3    | `pkg/api/health.go:L10-L24` / `:L18` / `:L23`                                                     | `databaseHealthy` / `session.Exec("SELECT 1")` / 5 s cache                                         |
| R3    | `pkg/setting/setting.go:L65-L66` / `:L1076-L1077`                                                 | `BuildVersion`/`BuildCommit` package vars / copied into `cfg`                                      |
| R3    | `package.json:L6`                                                                                 | `"version": "11.5.0-pre"`                                                                          |
| R4    | `pkg/server/server.go:L162` / `:L74` / `:L155`                                                    | `Starting background service` Debug log / `log.New("server")` / `reflect.TypeOf(service).String()` |
| R4    | `pkg/server/server.go:L148-L176` / `:L150-L152`                                                   | run loop (`childRoutines.Go`) / `registry.IsDisabled` skip                                         |
| R4    | `pkg/registry/backgroundsvcs/background_services.go:L53-L118` / `:L80`                            | `ProvideBackgroundServiceRegistry` / `NewBackgroundServiceRegistry(...)`                           |
| Intro | `go.mod:L3`                                                                                       | `go 1.23.1`                                                                                        |
