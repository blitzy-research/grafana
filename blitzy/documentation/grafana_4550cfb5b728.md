# Grafana First-Run Experience: Onboarding Q&A Reference

This document answers four targeted onboarding questions about Grafana's first-run experience for engineers setting up a local development environment. All answers are grounded in source code analysis of the Grafana repository at commit `4550cfb5b728` — every claim cites specific file paths and line numbers from the codebase as the source of truth.

**Topics covered:**

1. HTTP server readiness — the log line that signals Grafana is listening
2. Initial authentication — the password change prompt after first login
3. Health verification — the anatomy of the `/api/health` endpoint
4. Background service discovery — what starts during the boot sequence

## Methodology

All answers in this document are derived exclusively from direct inspection of the Grafana source code. No assumptions are made. File paths and line numbers are cited throughout using the format `Source: path/to/file:LineNumber`. Code excerpts are based on the actual repository source, with some inline comments trimmed for clarity and selective omissions marked explicitly. JSON response examples are verified against test fixtures in the codebase.

---

## Table of Contents

- [Q1: Which Log Line Signals That Grafana's HTTP Server Is Listening?](#q1-which-log-line-signals-that-grafanas-http-server-is-listening)
- [Q2: After Signing In with Default Credentials, What Does Grafana Ask For?](#q2-after-signing-in-with-default-credentials-what-does-grafana-ask-for)
- [Q3: What Does a Healthy Response from /api/health Look Like?](#q3-what-does-a-healthy-response-from-apihealth-look-like)
- [Q4: Which Background Services Start During the Boot Sequence?](#q4-which-background-services-start-during-the-boot-sequence)
- [Summary](#summary)

---

## Q1: Which Log Line Signals That Grafana's HTTP Server Is Listening?

**Answer:** The log line is `"HTTP Server Listen"`, emitted at `pkg/api/http_server.go:434-435`. It is an `INFO`-level structured log message that exposes four key-value fields: the resolved bind address, the protocol scheme, the sub-URL prefix, and the Unix socket path.

### The Log Line and Its Fields

The exact source code that emits this log line is:

```go
hs.log.Info("HTTP Server Listen", "address", listener.Addr().String(), "protocol",
    hs.Cfg.Protocol, "subUrl", hs.Cfg.AppSubURL, "socket", hs.Cfg.SocketPath)
```

`Source: pkg/api/http_server.go:434-435`

This produces a structured log entry with the following four fields:

| Field | Value Source | What It Reveals |
|---|---|---|
| `address` | `listener.Addr().String()` | The resolved IP:port the server is bound to (e.g., `0.0.0.0:3000`) |
| `protocol` | `hs.Cfg.Protocol` | The protocol scheme: `http`, `https`, `h2`, or `socket` |
| `subUrl` | `hs.Cfg.AppSubURL` | The sub-path prefix if Grafana is served behind a reverse proxy (e.g., `/grafana`) |
| `socket` | `hs.Cfg.SocketPath` | The Unix socket file path (only relevant when `protocol = socket`) |

### What the Address Field Reveals

The `address` field comes from `listener.Addr().String()`, which returns the *resolved* address the operating system assigned to the listener. When `http_addr` is empty (the default), the OS binds to all interfaces, so the address will typically display as `0.0.0.0:3000`. If a specific IP is configured, that IP will appear instead.

### Configuration Defaults

The default values for the server configuration are declared in `conf/defaults.ini`:

```ini
[server]
# Protocol (http, https, h2, socket)
protocol = http

# The ip address to bind to, empty will bind to all interfaces
http_addr =

# The http port to use
http_port = 3000
```

`Source: conf/defaults.ini:30-41`

With these defaults, a fresh Grafana instance will bind to all network interfaces on port 3000 using plain HTTP.

### Example Log Output

With default configuration, the log output looks like:

```text
INFO[XX-XX|XX:XX:XX] HTTP Server Listen address=0.0.0.0:3000 protocol=http subUrl= socket=
```

The empty `subUrl=` and `socket=` fields indicate no sub-URL prefix is configured and the server is not using a Unix socket.

### Thinking and Rationale

The `Run()` method at `pkg/api/http_server.go:400` is the entry point for the HTTP server's background service lifecycle. It is one of the 36 background services launched by `Server.Run()` in `pkg/server/server.go:149-174`. Here is the sequence of events within `Run()`:

1. **Route application** (line 403): `hs.applyRoutes()` registers all HTTP routes.
2. **HTTP server creation** (lines 407-411): A `net/http.Server` is created with the configured address and read timeout.
3. **TLS configuration** (lines 412-427): If the protocol is `https` or `h2`, TLS certificates are loaded.
4. **Listener acquisition** (line 429): `hs.getListener()` creates or reuses a network listener. This is where the address is resolved and the socket is opened.
5. **Log emission** (lines 434-435): The `"HTTP Server Listen"` log is emitted. At this point, the address is resolved and the socket is open.
6. **Serve** (lines 450-468): `Serve()` or `ServeTLS()` is called to start accepting connections.

The log is emitted *after* `getListener()` succeeds but *before* `Serve()` or `ServeTLS()` is called. This means the address is resolved and the socket is open, but the server may not yet be actively accepting connections at the moment the log appears.

`Source: pkg/api/http_server.go:400-474`

### Note: Systemd READY=1 Signal

After ALL background services (including the HTTPServer) are launched as goroutines, `Server.Run()` sends `READY=1` to systemd:

```go
s.notifySystemd("READY=1")
```

`Source: pkg/server/server.go:176`

This is the *system-level* readiness signal, distinct from the HTTP-level log line. The `READY=1` notification fires after all 36 background service goroutines have been dispatched, but before they necessarily finish initializing. The `notifySystemd` method (line 229) sends a datagram to the `NOTIFY_SOCKET` Unix socket if the environment variable is set.

`Source: pkg/server/server.go:176, 228-240`

---

## Q2: After Signing In with Default Credentials, What Does Grafana Ask For?

**Answer:** Grafana immediately prompts the user to change the default admin password. The internal state being finalized is the replacement of the insecure default `"admin"` password with a user-chosen password. This is a client-side check — the backend does not enforce the prompt.

### Default Admin User Bootstrap

The journey begins in `conf/defaults.ini`, where the default admin credentials are declared:

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

`Source: conf/defaults.ini:323-334`

During database initialization, the `ensureMainOrgAndAdminUser()` method in `pkg/services/sqlstore/sqlstore.go` reads these configuration values and creates the admin user:

```go
func (ss *SQLStore) ensureMainOrgAndAdminUser(test bool) error {
    ctx := context.Background()
    err := ss.WithTransactionalDbSession(ctx, func(sess *DBSession) error {
        ss.log.Debug("Ensuring main org and admin user exist")

        if !test {
            var stats stats.SystemUserCountStats
            rawSQL := `SELECT COUNT(id) AS Count FROM ` + ss.dialect.Quote("user")
            if _, err := sess.SQL(rawSQL).Get(&stats); err != nil {
                return fmt.Errorf("could not determine if admin user exists: %w", err)
            }
            if stats.Count > 0 {
                return nil
            }
        }

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

        ss.log.Debug("Creating default org", "name", mainOrgName)
        if _, err := ss.getOrCreateOrg(sess, mainOrgName); err != nil {
            return fmt.Errorf("failed to create default organization: %w", err)
        }

        ss.log.Info("Created default organization")
        return nil
    })

    return err
}
```

`Source: pkg/services/sqlstore/sqlstore.go:190-235`

Key details:
- If any users already exist in the database (line 204: `stats.Count > 0`), the method returns early — the admin user is only created on a truly fresh database.
- The `DisableInitAdminCreation` toggle (line 210) allows operators to skip admin creation entirely by setting `disable_initial_admin_creation = true` in configuration.
- The password is stored as a hash, not in plaintext.

### Client-Side Password Detection Logic

After a successful login POST to `/login`, the frontend login controller checks whether the user should be prompted to change their password. This logic is in the `login()` method of `LoginCtrl`:

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
      .catch((err) => {
        const fetchErrorMessage = isFetchError(err) ? getErrorMessage(err) : undefined;
        this.setState({
          isLoggingIn: false,
          loginErrorMessage: fetchErrorMessage || t('login.error.unknown', 'Unknown error occurred'),
        });
      });
  };
```

`Source: public/app/core/components/Login/LoginCtrl.tsx:107-131`

**The critical conditional is at line 117:**

```typescript
if (formModel.password !== 'admin' || config.ldapEnabled || config.authProxyEnabled) {
```

This means: **skip the password change prompt** if ANY of these conditions is true:
1. The submitted password is NOT `'admin'` (i.e., the user already changed it before)
2. LDAP authentication is enabled (external auth manages passwords)
3. Auth proxy is enabled (external auth manages passwords)

If none of these conditions is met — meaning the password IS `'admin'` AND no external auth is configured — then `changeView(true)` is called, which triggers the password change UI.

The `changeView()` method sets the component state:

```typescript
changeView = (showDefaultPasswordWarning: boolean) => {
    this.setState({
      isChangingPassword: true,
      showDefaultPasswordWarning,
    });
  };
```

`Source: public/app/core/components/Login/LoginCtrl.tsx:176-181`

### The ChangePassword Component Rendering

When `isChangingPassword` is `true`, the `LoginPage` component renders the `ChangePassword` form:

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

`Source: public/app/core/components/Login/LoginPage.tsx:84-92`

The user sees a password change form with two options:
- **Submit a new password:** Calls the `changePassword` method
- **Skip:** Calls `skipPasswordChange()`, which maps to `toGrafana()` — the user proceeds with the default password unchanged

### The changePassword Method

When the user submits a new password, the `changePassword` method sends the update to the backend:

```typescript
changePassword = (password: string) => {
    const pw = {
      newPassword: password,
      confirmNew: password,
      oldPassword: 'admin',
    };

    // ... (resetCode handling omitted for clarity)

    getBackendSrv()
      .put('/api/user/password', pw)
      .then(() => {
        this.toGrafana();
      })
      .catch((err) => console.error(err));
  };
```

`Source: public/app/core/components/Login/LoginCtrl.tsx:78-105`

Note that `oldPassword: 'admin'` is **hardcoded** at line 82. The method sends a PUT to `/api/user/password` with the old password set to `'admin'` — this is the server-side password update that replaces the default credential.

### Thinking and Rationale

The password change check is **entirely client-side** — the backend does not enforce this prompt. The comparison `formModel.password !== 'admin'` at line 117 is a simple string equality check against the literal `'admin'`. This has several implications:

1. **No server-side enforcement:** The backend `/login` endpoint does not return any flag indicating the password should be changed. The frontend makes the decision purely based on what the user typed.
2. **LDAP/AuthProxy bypass:** If LDAP or auth proxy is enabled, the prompt is skipped because external authentication systems manage their own password policies.
3. **Skip option exists:** The `onSkip` handler on the `ChangePassword` component (line 89) calls `skipPasswordChange()`, which maps to `toGrafana()`. This means the user **CAN** skip and continue with the default password — Grafana only strongly encourages but does not force the change.
4. **showDefaultPasswordWarning flag:** When `formModel.password === 'admin'` evaluates to `true` (line 121), the `showDefaultPasswordWarning` flag is passed to the `ChangePassword` component, which displays a warning about using default credentials.

`Source: conf/defaults.ini:323-334, pkg/services/sqlstore/sqlstore.go:190-235, public/app/core/components/Login/LoginCtrl.tsx:107-131, public/app/core/components/Login/LoginPage.tsx:84-92`

---

## Q3: What Does a Healthy Response from /api/health Look Like?

**Answer:** A healthy response is HTTP 200 with a JSON body containing `"database": "ok"` along with version information (unless version hiding is enabled). An unhealthy response is HTTP 503 with `"database": "failing"`. The `database` field reflects the result of a `SELECT 1` probe against the underlying database, cached for 5 seconds.

### The healthResponse Struct

The JSON response shape is defined by the `healthResponse` struct:

```go
type healthResponse struct {
    Database         string `json:"database"`
    Version          string `json:"version,omitempty"`
    Commit           string `json:"commit,omitempty"`
    EnterpriseCommit string `json:"enterpriseCommit,omitempty"`
}
```

`Source: pkg/api/http_server.go:694-699`

The `omitempty` tags on `Version`, `Commit`, and `EnterpriseCommit` mean these fields are only included in the JSON output when they have non-empty values.

### The apiHealthHandler

The handler logic at `pkg/api/http_server.go:710-745`:

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

    dataBytes, err := json.MarshalIndent(data, "", "  ")
    if err != nil {
        hs.log.Error("Failed to encode data", "err", err)
        return
    }

    if _, err := ctx.Resp.Write(dataBytes); err != nil {
        hs.log.Error("Failed to write to response", "err", err)
    }
}
```

`Source: pkg/api/http_server.go:710-745`

The handler works as follows:
1. **Initialize with optimistic state:** `Database` is set to `"ok"` (line 717).
2. **Version population:** If `HideVersion` is `false`, `Version` and `Commit` are populated (lines 719-725). The `EnterpriseCommit` field is only included if it is not `"NA"` or empty (lines 722-724).
3. **Database health check:** If `databaseHealthy()` returns `false`, set `Database` to `"failing"` and return HTTP 503 (lines 727-730).
4. **Healthy response:** Otherwise return HTTP 200 (lines 731-733).
5. **JSON serialization:** The response is marshaled with indentation via `json.MarshalIndent` (line 736).

### Exact JSON Response Examples

These examples are verified against the test fixtures in `pkg/api/health_test.go`:

**Healthy (OSS, version visible)** — `TestHealthAPI_Version` (lines 18-37):

```json
{
  "database": "ok",
  "version": "7.4.0",
  "commit": "59906ab1bf"
}
```

HTTP status: `200`

**Healthy (Enterprise, version visible)** — `TestHealthAPI_VersionEnterprise` (lines 39-60):

```json
{
  "database": "ok",
  "enterpriseCommit": "22206ab1be",
  "version": "7.4.0",
  "commit": "59906ab1bf"
}
```

HTTP status: `200`

**Healthy (version hidden)** — `TestHealthAPI_AnonymousHideVersion` (lines 62-77):

```json
{
  "database": "ok"
}
```

HTTP status: `200`

**Unhealthy (database unreachable)** — `TestHealthAPI_DatabaseUnhealthy` (lines 106-132):

```json
{
  "database": "failing"
}
```

HTTP status: `503`

`Source: pkg/api/health_test.go:18-171`

### The `database` Field: SELECT 1 and the 5-Second Cache

The `database` field reflects the result of the `databaseHealthy()` method:

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

`Source: pkg/api/health.go:10-25`

**What this does:**

1. **Cache lookup** (lines 13-15): First checks `localcache` for a cached result under the key `"db-healthy"`. If found, returns the cached boolean immediately without hitting the database.
2. **Database probe** (lines 17-20): If no cached value exists, executes `SELECT 1` against the underlying database. This is a lightweight connectivity check — it verifies the database connection is alive, not that all tables or migrations are healthy.
3. **Result caching** (line 23): The result (`true` or `false`) is cached with a TTL of **5 seconds**.

**Critical: The 5-second cache behavior** means:

- A momentary database blip may not appear in the health response until the cache expires (up to 5 seconds after the actual failure).
- A recovered database may still show `"database": "failing"` for up to 5 seconds after recovery.
- Rapid successive health checks within the 5-second window will all return the same cached value, regardless of actual database state.

This caching behavior is verified by the test `TestHealthAPI_DatabaseHealthCached` at `pkg/api/health_test.go:134-171`, which explicitly tests that a cached unhealthy state persists until the cache is purged.

### Two Health Endpoints: /healthz vs /api/health

Grafana exposes **two** distinct health endpoints:

| Endpoint | Handler | Response | Checks Database? | Use Case |
|---|---|---|---|---|
| `/healthz` | `healthzHandler` (lines 681-691) | HTTP 200 with body `"Ok"` | **No** | Liveness probe — is the process alive? |
| `/api/health` | `apiHealthHandler` (lines 710-745) | HTTP 200/503 with JSON body | **Yes** | Readiness probe — can it serve DB-dependent traffic? |

The `/healthz` handler is simple:

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

`Source: pkg/api/http_server.go:681-691`

It always returns HTTP 200 with body `"Ok"` if the web server process is running. It does NOT check the database.

Both endpoints are registered as middleware **before** the authentication context handler, meaning they run pre-auth and require no authentication:

```go
m.Use(hs.healthzHandler)
m.Use(hs.apiHealthHandler)
```

`Source: pkg/api/http_server.go:633-634`

These lines appear before `m.UseMiddleware(hs.ContextHandler.Middleware)` at line 639, which is where authentication/context processing begins.

### Thinking and Rationale

The `database` field is not a deep application health check — it is a bare-minimum connectivity test (`SELECT 1`). It does not verify that migrations have run, that tables exist, or that the schema is correct. The 5-second caching is a deliberate design choice to avoid hammering the database on every health poll from load balancers or monitoring systems.

For Kubernetes or load balancer health checks, the practical recommendation is:
- Use `/healthz` for **liveness probes** (is the process alive?)
- Use `/api/health` for **readiness probes** (can it serve traffic that depends on the database?)

`Source: pkg/api/http_server.go:631-634, 681-745, pkg/api/health.go:10-25, pkg/api/health_test.go:18-171`

---

## Q4: Which Background Services Start During the Boot Sequence?

**Answer:** Grafana launches **36 background services** during boot via the `ProvideBackgroundServiceRegistry` function in `pkg/registry/backgroundsvcs/background_services.go`. These services are started as concurrent goroutines before the HTTP server begins accepting external requests, meaning a large portion of Grafana's functionality is already active before the UI appears.

### Boot Sequence Orchestration

The boot sequence is orchestrated by `Server.Run()` in `pkg/server/server.go:139-180`:

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
            select {
            case <-s.context.Done():
                return s.context.Err()
            default:
            }
            s.log.Debug("Starting background service", "service", serviceName)
            err := service.Run(s.context)
            if err != nil && !errors.Is(err, context.Canceled) {
                s.log.Error("Stopped background service", "service", serviceName, "reason", err)
                return fmt.Errorf("%s run error: %w", serviceName, err)
            }
            s.log.Debug("Stopped background service", "service", serviceName, "reason", err)
            return nil
        })
    }

    s.notifySystemd("READY=1")

    s.log.Debug("Waiting on services...")
    return s.childRoutines.Wait()
}
```

`Source: pkg/server/server.go:139-180`

The sequence is:

1. **Init** (line 142): `Server.Init()` writes the PID file, registers Prometheus metrics, registers fixed RBAC roles, and runs initial provisioners.
2. **Service iteration** (lines 149-174): For each registered background service:
   - Check if the service is disabled via `registry.IsDisabled(svc)` (line 150) — if so, skip it.
   - Launch the service as a goroutine via `s.childRoutines.Go()` (line 156), using an `errgroup.Group` from `golang.org/x/sync/errgroup`.
3. **Systemd notification** (line 176): After all goroutines are dispatched, send `READY=1` to systemd.
4. **Wait** (line 179): Block until all services complete via `s.childRoutines.Wait()`.

### The IsDisabled Mechanism

Services can opt out of starting by implementing the `CanBeDisabled` interface:

```go
// CanBeDisabled allows the services to decide if it should
// be started or not by itself.
type CanBeDisabled interface {
    IsDisabled() bool
}

func IsDisabled(srv BackgroundService) bool {
    canBeDisabled, ok := srv.(CanBeDisabled)
    return ok && canBeDisabled.IsDisabled()
}
```

`Source: pkg/registry/registry.go:14-21, 52-56`

If a service implements `CanBeDisabled` and its `IsDisabled()` returns `true`, `Server.Run()` skips launching it. Services that do NOT implement this interface are always started.

### Complete Service Enumeration

All 36 background services passed to `NewBackgroundServiceRegistry` at `pkg/registry/backgroundsvcs/background_services.go:80-117`, in exact source order:

| # | Service Variable | Type / Package | Category |
|---|---|---|---|
| 1 | `httpServer` | `*api.HTTPServer` | Core / HTTP |
| 2 | `ng` | `*ngalert.AlertNG` | Alerting |
| 3 | `cleanup` | `*cleanup.CleanUpService` | Maintenance |
| 4 | `live` | `*live.GrafanaLive` | Real-time / WebSocket |
| 5 | `pushGateway` | `*pushhttp.Gateway` | Real-time / Push |
| 6 | `notifications` | `*notifications.NotificationService` | Notifications |
| 7 | `rendering` | `*rendering.RenderingService` | Rendering |
| 8 | `tokenService` | `auth.UserTokenBackgroundService` | Authentication |
| 9 | `provisioning` | `*provisioning.ProvisioningServiceImpl` | Provisioning |
| 10 | `grafanaUpdateChecker` | `*updatechecker.GrafanaService` | Update Checking |
| 11 | `pluginsUpdateChecker` | `*updatechecker.PluginsService` | Update Checking |
| 12 | `metrics` | `*metrics.InternalMetricsService` | Observability |
| 13 | `usageStats` | `*uss.UsageStats` | Telemetry |
| 14 | `statsCollector` | `*statscollector.Service` | Telemetry |
| 15 | `tracing` | `*tracing.TracingService` | Observability |
| 16 | `remoteCache` | `*remotecache.RemoteCache` | Caching |
| 17 | `secretsService` | `*secretsManager.SecretsService` | Secrets |
| 18 | `StorageService` | `store.StorageService` | Storage |
| 19 | `searchService` | `searchV2.SearchService` | Search |
| 20 | `entityEventsService` | `store.EntityEventsService` | Storage / Events |
| 21 | `grpcServerProvider` | `grpcserver.Provider` | gRPC |
| 22 | `saService` | `*samanager.ServiceAccountsService` | Service Accounts |
| 23 | `pluginStore` | `*pluginStore.Service` | Plugins |
| 24 | `secretMigrationProvider` | `secretsMigrations.SecretMigrationProvider` | Secrets / Migration |
| 25 | `loginAttemptService` | `*loginattemptimpl.Service` | Security |
| 26 | `bundleService` | `*supportbundlesimpl.Service` | Diagnostics |
| 27 | `publicDashboardsMetric` | `*publicdashboardsmetric.Service` | Public Dashboards |
| 28 | `keyRetriever` | `*dynamic.KeyRetriever` | Plugins / Security |
| 29 | `dynamicAngularDetectorsProvider` | `*angulardetectorsprovider.Dynamic` | Plugins / Angular |
| 30 | `grafanaAPIServer` | `grafanaapiserver.Service` | API Server |
| 31 | `anon` | `*anonimpl.AnonDeviceService` | Anonymous Access |
| 32 | `ssoSettings` | `*ssosettingsimpl.Service` | SSO |
| 33 | `pluginExternal` | `*pluginexternal.Service` | Plugins |
| 34 | `pluginInstaller` | `*plugininstaller.Service` | Plugins |
| 35 | `accessControl` | `accesscontrol.Service` | Authorization / RBAC |
| 36 | `appRegistry` | `*appregistry.Service` | App Registry |

`Source: pkg/registry/backgroundsvcs/background_services.go:80-117`

### Service Category Breakdown

The 36 services group into the following functional categories:

**Core Infrastructure (4 services):**
- HTTPServer — the web server serving the UI and API
- gRPC Server Provider — internal gRPC communication
- Grafana API Server — Kubernetes-style API server
- App Registry — application plugin registry

**Alerting (1 service):**
- AlertNG — the unified alerting engine

**Authentication & Authorization (5 services):**
- Token Service — user session token management and cleanup
- Login Attempt Service — brute-force login attempt tracking
- Access Control — RBAC permission enforcement
- SSO Settings — single sign-on configuration management
- Anonymous Device Service — anonymous access device tracking

**Plugins (5 services):**
- Plugin Store — plugin discovery and lifecycle
- Plugin External — external plugin management
- Plugin Installer — plugin installation automation
- Key Retriever — plugin signature key retrieval
- Angular Detectors Provider — legacy Angular plugin detection

**Data & Storage (4 services):**
- Storage Service — file-based storage backend
- Search Service (v2) — dashboard and resource search indexing
- Entity Events Service — storage entity event processing
- Remote Cache — distributed caching (Redis, Memcached, or database-backed)

**Secrets (2 services):**
- Secrets Service — encryption and secrets management
- Secret Migration Provider — secrets storage migration between backends

**Observability (4 services):**
- Metrics — internal Prometheus metrics collection
- Tracing — distributed tracing (OpenTelemetry)
- Usage Stats — anonymous usage statistics collection
- Stats Collector — system statistics aggregation

**Real-time (2 services):**
- Grafana Live — WebSocket-based real-time data streaming
- Push Gateway — HTTP push endpoint for live data

**Maintenance & Operations (9 services):**
- Cleanup — periodic cleanup of expired sessions, temporary files, and old data
- Provisioning — file-based provisioning of dashboards, datasources, and alert rules
- Rendering — server-side image rendering for alerts and reports
- Notifications — email and webhook notification delivery
- Grafana Update Checker — checks for new Grafana releases
- Plugins Update Checker — checks for plugin updates
- Support Bundles — diagnostic data collection
- Public Dashboards Metric — public dashboard usage metrics
- Service Accounts Service — service account lifecycle management

### Dependency-Injected (Non-Background) Services

In addition to the 36 background services, `ProvideBackgroundServiceRegistry` also accepts 15 services via the blank identifier `_` (lines 73-78). These are present only to ensure Go's Wire dependency injection framework initializes them — they are NOT registered as background services:

- `dashboardsnapshots.Service`
- `serviceaccounts.Service`
- `*guardian.Provider`
- `*plugindashboardsservice.DashboardUpdater`
- `*sanitizer.Provider`
- `*grpcserver.HealthService`
- `authz.Client`
- `*grpcserver.ReflectionService`
- `*ldapapi.Service`
- `*apiregistry.Service`
- `auth.IDService`
- `*teamapi.TeamAPI`
- `ssosettings.Service`
- `cloudmigration.Service`
- `authnimpl.Registration`

`Source: pkg/registry/backgroundsvcs/background_services.go:72-78`

### Thinking and Rationale

The key insight is that **HTTPServer itself is one of these 36 background services** — it is the **first** one passed to `NewBackgroundServiceRegistry` at line 81. This means the HTTP listener (which serves the UI and API) starts as a *peer* to all other services, not as a separate bootstrap phase.

The boot timeline looks like this:

1. `Server.Run()` calls `Server.Init()` — PID file, metrics, fixed roles, initial provisioners.
2. `Server.Run()` iterates over all 36 services and launches each as a goroutine. This happens in a tight loop — all goroutines are dispatched nearly simultaneously.
3. `notifySystemd("READY=1")` fires at line 176 — this is after all goroutines are **dispatched** but before they necessarily finish initializing internally.
4. `childRoutines.Wait()` blocks until all services either complete or error.

By the time the `"HTTP Server Listen"` log line appears (emitted from within the HTTPServer goroutine), ALL 36 services have been launched as goroutines (though they may still be initializing internally). This means the UI can appear while background services like AlertNG, provisioning, or plugin loading are still spinning up internally.

How much of Grafana is active before the UI appears? In terms of goroutines dispatched: **all of it**. All 36 services are launched before any single service's `Run()` method necessarily completes its initialization. However, the actual readiness of individual services (e.g., alerting rules loaded, plugins indexed, search index built) depends on each service's internal initialization time. The HTTP server may start accepting connections before all background services are fully ready.

`Source: pkg/registry/backgroundsvcs/background_services.go:53-117, pkg/server/server.go:139-180, pkg/registry/registry.go:10-56`

---

## Summary

| Question | Key Finding | Primary Source |
|---|---|---|
| Q1: HTTP Readiness | `"HTTP Server Listen"` log with `address`, `protocol`, `subUrl`, `socket` fields | `pkg/api/http_server.go:434` |
| Q2: Password Change | Client-side `password === 'admin'` check triggers `ChangePassword` view; skippable | `public/app/core/components/Login/LoginCtrl.tsx:117` |
| Q3: Health Endpoint | JSON with `"database": "ok"` (HTTP 200) or `"failing"` (HTTP 503); `SELECT 1` probe cached 5s | `pkg/api/health.go:10-25` |
| Q4: Boot Services | 36 background services launched as goroutines; `READY=1` sent after dispatch | `pkg/registry/backgroundsvcs/background_services.go:80-117` |

All answers are derived from source code analysis of the Grafana repository at commit `4550cfb5b728`. No repository files were modified in the production of this document.
