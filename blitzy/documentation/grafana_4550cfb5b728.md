# Grafana First-Run Experience: A Code-Grounded Onboarding Reference

## Introduction

This document answers four targeted onboarding questions about Grafana's first-run experience. Every answer is derived exclusively from the Grafana source code at commit `4550cfb5b728` — no assumptions, no external references. Each section includes the reasoning behind the answer, the relevant source file paths and line numbers, and verbatim code excerpts so that claims can be independently verified.

**Scope:** Local development environment running Grafana OSS with default configuration (`conf/defaults.ini`).

**Approach:** For each question, the answer traces execution from configuration defaults through initialization code to the runtime behavior observable by the developer.

---

## Q1: HTTP Server Readiness Signal

**Question:** Which log line signals that Grafana's HTTP server is listening, and what does it reveal about the address, protocol, and exposure method?

### The Log Line and Its Fields

The definitive readiness signal is a structured log message emitted by `HTTPServer.Run()` in `pkg/api/http_server.go` at line 434, immediately after the listener is successfully created:

```go
hs.log.Info("HTTP Server Listen", "address", listener.Addr().String(), "protocol",
    hs.Cfg.Protocol, "subUrl", hs.Cfg.AppSubURL, "socket", hs.Cfg.SocketPath)
```

Source: `pkg/api/http_server.go:434–435`

This single log line exposes four key-value fields:

| Field      | Value Source                   | What It Reveals |
|------------|-------------------------------|-----------------|
| `address`  | `listener.Addr().String()`    | The resolved network address the server is bound to (e.g., `0.0.0.0:3000`) |
| `protocol` | `hs.Cfg.Protocol`             | The transport protocol in use (`http`, `https`, `h2`, or `socket`) |
| `subUrl`   | `hs.Cfg.AppSubURL`            | The URL path prefix if Grafana is served under a subpath (empty by default) |
| `socket`   | `hs.Cfg.SocketPath`           | The Unix socket file path if `protocol = socket`; empty otherwise |

### What the Address Field Reveals

**Thinking:** The `address` field comes from `listener.Addr().String()`, which means it reflects the *actual* bound address after the OS resolves it — not just the configured value. This is important because the configuration default for `http_addr` is an empty string, which means "bind to all interfaces."

The listener is created in `HTTPServer.getListener()` at line 476. For TCP protocols (`http`, `https`, `h2`), it calls:

```go
listener, err := net.Listen("tcp", hs.httpSrv.Addr)
```

Source: `pkg/api/http_server.go:484`

The `hs.httpSrv.Addr` is constructed earlier in `Run()` at line 408:

```go
hs.httpSrv = &http.Server{
    Addr: net.JoinHostPort(host, hs.Cfg.HTTPPort),
    ...
}
```

Source: `pkg/api/http_server.go:408–411`

For the `socket` protocol, a Unix domain socket listener is created instead:

```go
listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: hs.Cfg.SocketPath, Net: "unix"})
```

Source: `pkg/api/http_server.go:489`

### Configuration Defaults

With a clean `conf/defaults.ini`, the relevant defaults are:

```ini
[server]
# Protocol (http, https, h2, socket)
protocol = http

# The ip address to bind to, empty will bind to all interfaces
http_addr =

# The http port to use
http_port = 3000
```

Source: `conf/defaults.ini:31–43`

**Rationale:** Because `http_addr` defaults to an empty string (all interfaces) and `http_port` defaults to `3000`, a developer running Grafana for the first time with no custom configuration will see a log line like:

```
INFO [mm-dd|hh:mm:ss] HTTP Server Listen address=0.0.0.0:3000 protocol=http subUrl= socket=
```

This tells you:
- **`address=0.0.0.0:3000`** — Grafana is bound to all network interfaces on port 3000. It is reachable from any IP address the host machine owns, not just `localhost`.
- **`protocol=http`** — Plain HTTP, no TLS.
- **`subUrl=`** — No path prefix; the UI is served at the root (`/`).
- **`socket=`** — Not using Unix socket mode.

### Important Distinction: HTTP-Level vs System-Level Readiness

The `"HTTP Server Listen"` log line is the **application-level** readiness signal — it means the HTTP server's listener is open and ready to accept connections. However, there is also a **system-level** readiness signal: after all background services have been launched, `Server.Run()` sends `READY=1` to systemd:

```go
s.notifySystemd("READY=1")
```

Source: `pkg/server/server.go:176`

The `notifySystemd` function (line 229) checks for the `NOTIFY_SOCKET` environment variable and sends the notification via a Unix datagram socket. In a local development environment without systemd, this call is a no-op (the environment variable will be empty and the function returns early). The HTTP log line is the signal you should watch for.

Source: `pkg/server/server.go:229–246`

---

## Q2: Post-Login Password Change Prompt

**Question:** After signing in with the default `admin`/`admin` credentials, Grafana immediately asks for something before allowing the user to proceed — what internal state is being finalized?

### The Short Answer

Grafana asks you to **change the default admin password**. The internal state being finalized is the transition of the admin account from its insecure bootstrap password (`"admin"`) to a user-chosen password, which is then hashed and persisted to the database via a `PUT /api/user/password` call.

### Default Admin User Bootstrap

**Thinking:** To understand *why* the prompt appears, we need to trace where the default `admin`/`admin` credentials come from.

The default admin account is created during database initialization by `SQLStore.ensureMainOrgAndAdminUser()` in `pkg/services/sqlstore/sqlstore.go` at line 190. This method:

1. Counts existing users in the database (line 204)
2. If zero users exist and `DisableInitAdminCreation` is `false`, creates the default admin (line 210):

```go
if !ss.cfg.DisableInitAdminCreation {
    ss.log.Debug("Creating default admin user")

    if _, err := ss.createUser(ctx, sess, user.CreateUserCommand{
        Login:    ss.cfg.AdminUser,
        Email:    ss.cfg.AdminEmail,
        Password: user.Password(ss.cfg.AdminPassword),
        IsAdmin:  true,
    }); err != nil {
        return fmt.Errorf("failed to create admin user: %s", err)
    }

    ss.log.Info("Created default admin", "user", ss.cfg.AdminUser)
}
```

Source: `pkg/services/sqlstore/sqlstore.go:210–223`

The values `ss.cfg.AdminUser`, `ss.cfg.AdminPassword`, and `ss.cfg.AdminEmail` are populated from `conf/defaults.ini`:

```ini
[security]
# disable creation of admin user on first start of grafana
disable_initial_admin_creation = false

# default admin user, created on startup
admin_user = admin

# default admin password, can be changed before first start of grafana, or in profile settings
admin_password = admin

# default admin email, created on startup
admin_email = admin@localhost
```

Source: `conf/defaults.ini:325–336`

### Client-Side Password Detection Logic

**Thinking:** The password change prompt is triggered **client-side**, not by the backend. After a successful `/login` POST, the frontend login controller inspects the password that was submitted and decides whether to redirect to the dashboard or show the change-password view.

The detection logic lives in `LoginCtrl.login()` at line 117 of `public/app/core/components/Login/LoginCtrl.tsx`:

```typescript
login = (formModel: FormModel) => {
    this.setState({
      loginErrorMessage: undefined,
      isLoggingIn: true,
    });

    getBackendSrv()
      .post<LoginDTO>('/login', formModel, { showErrorAlert: false })
      .then((result) => {
        this.result = result;
        if (formModel.password !== 'admin' || config.ldapEnabled || config.authProxyEnabled) {
          this.toGrafana();
          return;
        } else {
          this.changeView(formModel.password === 'admin');
        }
      })
      // ... error handling
  };
```

Source: `public/app/core/components/Login/LoginCtrl.tsx:107–131`

The conditional at line 117 has three parts:

| Condition                           | Effect if True |
|-------------------------------------|----------------|
| `formModel.password !== 'admin'`    | Password is not the default → skip to dashboard |
| `config.ldapEnabled`                | LDAP manages passwords → skip to dashboard |
| `config.authProxyEnabled`           | Auth proxy manages authentication → skip to dashboard |

Only when all three conditions are `false` — meaning the password is literally `"admin"`, LDAP is off, and auth proxy is off — does the `else` branch fire, calling `this.changeView(true)`.

### What the Change Password View Finalizes

The `changeView()` method (line 176) sets component state:

```typescript
changeView = (showDefaultPasswordWarning: boolean) => {
    this.setState({
      isChangingPassword: true,
      showDefaultPasswordWarning,
    });
  };
```

Source: `public/app/core/components/Login/LoginCtrl.tsx:176–180`

When `isChangingPassword` becomes `true`, `LoginPage.tsx` (line 90–96) renders the `ChangePassword` component instead of the login form:

```tsx
{isChangingPassword && !config.auth.passwordlessEnabled && (
    <InnerBox>
      <ChangePassword
        showDefaultPasswordWarning={showDefaultPasswordWarning}
        onSubmit={changePassword}
        onSkip={() => skipPasswordChange()}
      />
    </InnerBox>
  )}
```

Source: `public/app/core/components/Login/LoginPage.tsx:90–97`

When the user submits a new password, the `changePassword()` method (line 78) sends a `PUT /api/user/password` request with the old password (`"admin"`) and the new password:

```typescript
changePassword = (password: string) => {
    const pw = {
      newPassword: password,
      confirmNew: password,
      oldPassword: 'admin',
    };
    // ...
    getBackendSrv()
      .put('/api/user/password', pw)
      .then(() => {
        this.toGrafana();
      })
      // ...
  };
```

Source: `public/app/core/components/Login/LoginCtrl.tsx:78–103`

**Rationale:** The internal state being finalized is the admin account's password. The backend session is already established (the `/login` POST succeeded and set a session cookie), but the UI intercepts the navigation to force a password change before the user reaches the dashboard. This is a security safeguard: the well-known default password `"admin"` is a trivial attack vector, so Grafana ensures the operator replaces it on first use. The user can click "Skip" (`skipPasswordChange` maps to `toGrafana()`), but the warning will persist on subsequent logins until the password is changed.

---

## Q3: Health Endpoint Anatomy

**Question:** What does a healthy JSON response from the `/api/health` endpoint look like, and what is the `database` field really telling us about the system's readiness?

### The `/api/health` Response Schema

The response is defined by the `healthResponse` struct in `pkg/api/http_server.go` at lines 694–699:

```go
// swagger:model healthResponse
type healthResponse struct {
    Database         string `json:"database"`
    Version          string `json:"version,omitempty"`
    Commit           string `json:"commit,omitempty"`
    EnterpriseCommit string `json:"enterpriseCommit,omitempty"`
}
```

Source: `pkg/api/http_server.go:693–699`

The handler `apiHealthHandler` at line 710 constructs the response:

```go
func (hs *HTTPServer) apiHealthHandler(ctx *web.Context) {
    notHeadOrGet := ctx.Req.Method != http.MethodGet && ctx.Req.Method != http.MethodHead
    if notHeadOrGet || ctx.Req.URL.Path != "/api/health" {
        return
    }

    data := healthResponse{
        Database: "ok",
    }
    if !hs.Cfg.Anonymous.HideVersion {
        data.Version = hs.Cfg.BuildVersion
        data.Commit = hs.Cfg.BuildCommit
        if hs.Cfg.EnterpriseBuildCommit != "NA" && hs.Cfg.EnterpriseBuildCommit != "" {
            data.EnterpriseCommit = hs.Cfg.EnterpriseBuildCommit
        }
    }

    if !hs.databaseHealthy(ctx.Req.Context()) {
        data.Database = "failing"
        ctx.Resp.Header().Set("Content-Type", "application/json; charset=UTF-8")
        ctx.Resp.WriteHeader(http.StatusServiceUnavailable)
    } else {
        ctx.Resp.Header().Set("Content-Type", "application/json; charset=UTF-8")
        ctx.Resp.WriteHeader(http.StatusOK)
    }
    // ... marshal and write JSON
}
```

Source: `pkg/api/http_server.go:710–745`

### Healthy vs Unhealthy Responses

**A healthy response** (HTTP `200 OK`):

```json
{
  "database": "ok",
  "version": "7.4.0",
  "commit": "59906ab1bf"
}
```

Source: Test fixture in `pkg/api/health_test.go:30–34` (TestHealthAPI_Version)

**An unhealthy response** (HTTP `503 Service Unavailable`):

```json
{
  "database": "failing"
}
```

Source: Test fixture in `pkg/api/health_test.go:115–117` (TestHealthAPI_DatabaseUnhealthy)

**With `Anonymous.HideVersion = true`** (version fields omitted):

```json
{
  "database": "ok"
}
```

Source: Test fixture in `pkg/api/health_test.go:79–81` (TestHealthAPI_AnonymousHideVersion)

**With enterprise build commit** (extra field added):

```json
{
  "database": "ok",
  "enterpriseCommit": "22206ab1be",
  "version": "7.4.0",
  "commit": "59906ab1bf"
}
```

Source: Test fixture in `pkg/api/health_test.go:54–59` (TestHealthAPI_VersionEnterprise)

### The `database` Field and `SELECT 1`

**Thinking:** The `database` field has exactly two possible values: `"ok"` or `"failing"`. It reflects whether Grafana can execute a trivial SQL statement against its configured database.

The `databaseHealthy()` method in `pkg/api/health.go` (lines 10–25) performs the check:

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

Source: `pkg/api/health.go:10–25`

**What this tells you about readiness:**

1. **`"ok"` means the database connection pool can successfully execute `SELECT 1`.** This is a lightweight round-trip probe — it verifies that the connection is established, the database engine is responding, and authentication credentials are valid. It does *not* verify that schema migrations have run, that tables exist, or that data is consistent.

2. **`"failing"` means `SELECT 1` returned an error.** This could indicate a network partition, database crash, exhausted connection pool, revoked credentials, or any other condition that prevents even the simplest query from completing.

### Caching Behavior

**Critical operational detail:** The result of `databaseHealthy()` is **cached for 5 seconds** using `localcache`:

```go
hs.CacheService.Set(cacheKey, healthy, time.Second*5)
```

Source: `pkg/api/health.go:23`

This means:
- If you query `/api/health` twice within 5 seconds, the second call returns the **cached** result without hitting the database.
- If the database goes down and recovers within 5 seconds, the health endpoint may still report `"failing"` until the cache expires.
- Conversely, if the database goes down after a successful probe, the endpoint will continue reporting `"ok"` for up to 5 seconds.

The test `TestHealthAPI_DatabaseHealthCached` in `pkg/api/health_test.go` (lines 130–161) confirms this behavior: it injects a `false` cached value and verifies that the endpoint returns `503` even though the underlying database mock is healthy. Only after purging the cache does it return `200`.

Source: `pkg/api/health_test.go:130–161`

### The `/healthz` Liveness Probe — A Comparison

Grafana exposes a second health endpoint at `/healthz` that serves a different purpose. The handler at line 681:

```go
func (hs *HTTPServer) healthzHandler(ctx *web.Context) {
    notHeadOrGet := ctx.Req.Method != http.MethodGet && ctx.Req.Method != http.MethodHead
    if notHeadOrGet || ctx.Req.URL.Path != "/healthz" {
        return
    }

    ctx.Resp.WriteHeader(http.StatusOK)
    if _, err := ctx.Resp.Write([]byte("Ok")); err != nil {
        hs.log.Error("could not write to response", "err", err)
    }
}
```

Source: `pkg/api/http_server.go:681–691`

| Endpoint       | Purpose           | Response                    | Status Codes   | Checks Database? |
|----------------|-------------------|-----------------------------|----------------|-------------------|
| `/healthz`     | Liveness probe    | Plain text `Ok`             | Always `200`   | No                |
| `/api/health`  | Readiness probe   | JSON with `database` field  | `200` or `503` | Yes (`SELECT 1`)  |

Both endpoints are registered as middleware *before* the authentication layer (lines 633–634), so they are accessible without credentials:

```go
m.Use(hs.healthzHandler)
m.Use(hs.apiHealthHandler)
```

Source: `pkg/api/http_server.go:633–634`

**Rationale:** Use `/healthz` for Kubernetes liveness probes (is the process alive?) and `/api/health` for readiness probes (is the service ready to serve traffic?). The `database` field in `/api/health` is the key differentiator — it tells you whether the most critical dependency (the database) is reachable.

---

## Q4: Background Services at Boot

**Question:** Which background services start during the boot sequence, and how much of Grafana is already active before the UI appears?

### Boot Sequence Orchestration

**Thinking:** To understand what's running before the UI appears, we need to trace the server lifecycle. The sequence is:

1. `Server.Init()` (line 113 of `pkg/server/server.go`) runs synchronous initialization: setting up configuration, running database migrations, wiring dependency injection, registering fixed roles, and running initial provisioners.
2. `Server.Run()` (line 139) iterates over all registered background services, skipping any that are disabled, and launches each as a goroutine via an `errgroup.Group`.
3. After all services are launched, `notifySystemd("READY=1")` is sent (line 176).
4. The `HTTPServer` is one of those background services — its `Run()` method opens the listener and emits the `"HTTP Server Listen"` log.

```go
func (s *Server) Run() error {
    defer close(s.shutdownFinished)

    if err := s.Init(); err != nil {
        return err
    }

    services := s.backgroundServices

    // Start background services.
    for _, svc := range services {
        if registry.IsDisabled(svc) {
            continue
        }

        service := svc
        serviceName := reflect.TypeOf(service).String()
        s.childRoutines.Go(func() error {
            // ...
            s.log.Debug("Starting background service", "service", serviceName)
            err := service.Run(s.context)
            // ...
        })
    }

    s.notifySystemd("READY=1")

    s.log.Debug("Waiting on services...")
    return s.childRoutines.Wait()
}
```

Source: `pkg/server/server.go:139–180`

The disabled-service check uses the `IsDisabled` helper from `pkg/registry/registry.go` (line 55):

```go
func IsDisabled(srv BackgroundService) bool {
    canBeDisabled, ok := srv.(CanBeDisabled)
    return ok && canBeDisabled.IsDisabled()
}
```

Source: `pkg/registry/registry.go:55–58`

Services that implement the `CanBeDisabled` interface can opt out of starting (e.g., alerting can be disabled via configuration). Services that do not implement this interface are always started.

### Complete Service Enumeration

All background services are wired through `ProvideBackgroundServiceRegistry()` in `pkg/registry/backgroundsvcs/background_services.go` (lines 53–118). The function receives services via dependency injection and passes them to `NewBackgroundServiceRegistry()`:

The following **36 services** are registered, listed in the order they appear in the `NewBackgroundServiceRegistry(...)` call (lines 85–117):

| # | Service Variable | Type / Package | Functional Category |
|---|-----------------|----------------|---------------------|
| 1 | `httpServer` | `*api.HTTPServer` | **Core Infrastructure** — The HTTP server itself; serves the UI, API, and health endpoints |
| 2 | `ng` | `*ngalert.AlertNG` | **Alerting** — Unified alerting engine (alert rule evaluation, notification routing) |
| 3 | `cleanup` | `*cleanup.CleanUpService` | **Maintenance** — Periodic cleanup of expired dashboard versions, snapshots, API keys, etc. |
| 4 | `live` | `*live.GrafanaLive` | **Real-Time** — WebSocket-based live streaming (dashboard refresh, real-time events) |
| 5 | `pushGateway` | `*pushhttp.Gateway` | **Real-Time** — HTTP push gateway for Grafana Live (ingestion endpoint for streaming data) |
| 6 | `notifications` | `*notifications.NotificationService` | **Communication** — Email and webhook notification delivery |
| 7 | `rendering` | `*rendering.RenderingService` | **Rendering** — Server-side image rendering for alerts and sharing |
| 8 | `tokenService` | `auth.UserTokenBackgroundService` | **Authentication** — User session token rotation and cleanup |
| 9 | `provisioning` | `*provisioning.ProvisioningServiceImpl` | **Configuration** — File-based provisioning of dashboards, datasources, alerting, and plugins |
| 10 | `grafanaUpdateChecker` | `*updatechecker.GrafanaService` | **Updates** — Checks for new Grafana versions on a schedule |
| 11 | `pluginsUpdateChecker` | `*updatechecker.PluginsService` | **Updates** — Checks for plugin updates on a schedule |
| 12 | `metrics` | `*metrics.InternalMetricsService` | **Observability** — Exposes Prometheus metrics for internal Grafana performance |
| 13 | `usageStats` | `*uss.UsageStats` | **Telemetry** — Collects and reports anonymous usage statistics |
| 14 | `statsCollector` | `*statscollector.Service` | **Telemetry** — Gathers system-level statistics (user counts, dashboard counts, etc.) |
| 15 | `tracing` | `*tracing.TracingService` | **Observability** — Distributed tracing (OpenTelemetry/Jaeger integration) |
| 16 | `remoteCache` | `*remotecache.RemoteCache` | **Core Infrastructure** — Remote cache backend (Redis/Memcached/database) for session and query caching |
| 17 | `secretsService` | `*secretsManager.SecretsService` | **Security** — Envelope encryption for secrets (datasource passwords, API keys) |
| 18 | `StorageService` | `store.StorageService` | **Storage** — Unified object storage abstraction layer |
| 19 | `searchService` | `searchV2.SearchService` | **Search** — Dashboard search indexing and query engine (v2) |
| 20 | `entityEventsService` | `store.EntityEventsService` | **Storage** — Entity change event stream for reactive updates |
| 21 | `grpcServerProvider` | `grpcserver.Provider` | **Core Infrastructure** — gRPC server for inter-service communication |
| 22 | `saService` | `*samanager.ServiceAccountsService` | **Authentication** — Service account management and token lifecycle |
| 23 | `pluginStore` | `*pluginStore.Service` | **Plugins** — Plugin discovery, loading, and lifecycle management |
| 24 | `secretMigrationProvider` | `secretsMigrations.SecretMigrationProvider` | **Security** — Migrates secrets from legacy format to envelope encryption |
| 25 | `loginAttemptService` | `*loginattemptimpl.Service` | **Security** — Tracks and rate-limits failed login attempts |
| 26 | `bundleService` | `*supportbundlesimpl.Service` | **Diagnostics** — Generates support bundles for troubleshooting |
| 27 | `publicDashboardsMetric` | `*publicdashboardsmetric.Service` | **Observability** — Metrics collection for public dashboards feature |
| 28 | `keyRetriever` | `*dynamic.KeyRetriever` | **Plugins** — Dynamic retrieval of plugin signing keys |
| 29 | `dynamicAngularDetectorsProvider` | `*angulardetectorsprovider.Dynamic` | **Plugins** — Detects Angular-based plugins for deprecation warnings |
| 30 | `grafanaAPIServer` | `grafanaapiserver.Service` | **Core Infrastructure** — Kubernetes-style API server (aggregated API layer) |
| 31 | `anon` | `*anonimpl.AnonDeviceService` | **Analytics** — Anonymous device tracking for usage analytics |
| 32 | `ssoSettings` | `*ssosettingsimpl.Service` | **Authentication** — SSO settings management and synchronization |
| 33 | `pluginExternal` | `*pluginexternal.Service` | **Plugins** — External plugin management and integration |
| 34 | `pluginInstaller` | `*plugininstaller.Service` | **Plugins** — Automated plugin installation and updates |
| 35 | `accessControl` | `accesscontrol.Service` | **Authorization** — Role-based access control (RBAC) enforcement and permission evaluation |
| 36 | `appRegistry` | `*appregistry.Service` | **Plugins** — App plugin registry and lifecycle management |

Source: `pkg/registry/backgroundsvcs/background_services.go:53–118`

Additionally, several services are listed as dependency-injected parameters but are **not** passed to `NewBackgroundServiceRegistry`. These are initialized by Wire for their side effects (e.g., registering routes, HTTP handlers, or database migrations) but do not run as background goroutines:

```go
// Need to make sure these are initialized, is there a better place to put them?
_ dashboardsnapshots.Service,
_ serviceaccounts.Service, _ *guardian.Provider,
_ *plugindashboardsservice.DashboardUpdater, _ *sanitizer.Provider,
_ *grpcserver.HealthService, _ authz.Client, _ *grpcserver.ReflectionService,
_ *ldapapi.Service, _ *apiregistry.Service, _ auth.IDService, _ *teamapi.TeamAPI, _ ssosettings.Service,
_ cloudmigration.Service, _ authnimpl.Registration,
```

Source: `pkg/registry/backgroundsvcs/background_services.go:73–79`

### Service Category Breakdown

Grouping the 36 background services by functional area:

| Category | Count | Services |
|----------|-------|----------|
| **Core Infrastructure** | 4 | HTTPServer, RemoteCache, gRPC Server, Grafana API Server |
| **Plugins** | 6 | Plugin Store, Key Retriever, Angular Detectors, Plugin External, Plugin Installer, App Registry |
| **Authentication & Authorization** | 4 | Token Service, Service Accounts, SSO Settings, Access Control |
| **Security** | 3 | Secrets Service, Secret Migration, Login Attempt Rate Limiting |
| **Observability & Telemetry** | 5 | Metrics, Usage Stats, Stats Collector, Tracing, Public Dashboards Metrics |
| **Alerting** | 1 | AlertNG (Unified Alerting) |
| **Real-Time** | 2 | Grafana Live, Push Gateway |
| **Configuration & Provisioning** | 1 | Provisioning Service |
| **Rendering** | 1 | Rendering Service |
| **Search & Storage** | 3 | Search Service, Storage Service, Entity Events |
| **Maintenance** | 1 | Cleanup Service |
| **Communication** | 1 | Notification Service |
| **Updates** | 2 | Grafana Update Checker, Plugins Update Checker |
| **Diagnostics** | 1 | Support Bundles |
| **Analytics** | 1 | Anonymous Device Service |

### How Much of Grafana Is Active Before the UI Appears?

**Rationale:** By the time the `"HTTP Server Listen"` log line appears, *all* 36 background services (minus any that are disabled) have been launched as goroutines. Since the `HTTPServer` is just one of those 36 services, the other 35 are already running concurrently. This means:

- **Database migrations** have completed (during `Init()`)
- **Provisioning** has run its initial provisioners (during `Init()`)
- **Alerting** is evaluating rules
- **Grafana Live** WebSocket server is accepting connections
- **Plugin discovery** and loading are underway
- **Secret encryption** is operational
- **Metrics** are being collected
- **gRPC server** is listening for internal communication
- **Update checkers** are polling for new versions
- **Session token cleanup** is active

In short, nearly the **entire** Grafana backend is operational before the first pixel of the UI renders in your browser. The HTTP server merely provides the window through which you observe an already-running system.

---

## Summary

| Question | Key Finding | Primary Source |
|----------|-------------|----------------|
| **Q1: HTTP Readiness Signal** | `"HTTP Server Listen"` log at line 434 of `http_server.go`, exposing `address`, `protocol`, `subUrl`, and `socket`. Default: `0.0.0.0:3000` over plain HTTP. | `pkg/api/http_server.go:434` |
| **Q2: Password Change Prompt** | Client-side check in `LoginCtrl.tsx:117` detects `password === 'admin'`; triggers `ChangePassword` view. Finalizes admin password via `PUT /api/user/password`. | `public/app/core/components/Login/LoginCtrl.tsx:117` |
| **Q3: Health Endpoint** | `/api/health` returns JSON with `database` (`"ok"` / `"failing"`), `version`, and `commit`. Database check is a `SELECT 1` probe cached for 5 seconds. HTTP `200` = healthy, `503` = unhealthy. | `pkg/api/http_server.go:710`, `pkg/api/health.go:10` |
| **Q4: Background Services** | 36 services launched as goroutines by `Server.Run()` before systemd `READY=1`. Covers alerting, plugins, auth, rendering, search, live streaming, and more — essentially the entire backend. | `pkg/registry/backgroundsvcs/background_services.go:53`, `pkg/server/server.go:148` |
