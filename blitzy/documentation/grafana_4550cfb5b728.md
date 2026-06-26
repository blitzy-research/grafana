# Grafana First-Run Startup & Lifecycle — Code-Grounded Q&A

This document answers four questions about what Grafana does when it is launched
locally for the first time. It is an onboarding explainer aimed at a developer who
noticed that the startup sequence is "more revealing than expected" and wanted the
boot/lifecycle behavior explained directly from the source.

**Commit anchor.** Every citation below is valid as of commit
`4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` on branch `grafana_4550cfb5b728`. Line
numbers refer to the files exactly as they exist at that commit.

**Run context.** The answers assume the default local-run configuration, where
Grafana serves its UI/API at `http://localhost:3000`. Unless a value is overridden
in `conf/custom.ini` or via `cfg:` arguments, the effective settings are the ones in
`conf/defaults.ini`.

**Method.** The code is authoritative. Each question is answered in three parts —
**Answer** (the direct conclusion), **Citations** (exact `[path:locator]` references,
with short quoted snippets), and **Reasoning / Why** (the rationale that connects the
cited code to the observed behavior). No claim about runtime behavior is made without
a citation; a runtime build/run is treated as optional confirmation only (see
[Notes](#notes)).

**Repository layout (orientation).** The Go backend lives under `pkg/`, the
React/TypeScript frontend under `public/`, and the layered INI configuration under
`conf/`. The server is assembled with Google Wire dependency injection and its
lifecycle is orchestrated by the `Server` struct in `pkg/server/server.go`.

---

## Q1 — Which log line really signals that the HTTP server is listening, and what does it say about where and how it's exposed?

> "Which log line really signals that the HTTP server is listening, and what does it say about where and how it's exposed?"

### Answer

The true readiness signal is the **INFO** line **`HTTP Server Listen`**, emitted by the
logger named **`http.server`** *immediately after* the network listener has been opened
successfully. It is not a generic "starting" message — it is logged only once the socket
is actually bound and ready to accept connections.

The line carries four fields that describe exactly *where* and *how* Grafana is exposed:

| Field      | Source expression          | Meaning |
|------------|----------------------------|---------|
| `address`  | `listener.Addr().String()` | The bound socket address (host:port) the listener is actually on |
| `protocol` | `hs.Cfg.Protocol`          | The wire protocol: one of `http`, `https`, `h2` (HTTP/2), or `socket` |
| `subUrl`   | `hs.Cfg.AppSubURL`         | The sub-path Grafana is served under (empty by default) |
| `socket`   | `hs.Cfg.SocketPath`        | The Unix-domain-socket path (only meaningful when `protocol = socket`) |

Because the default `http_addr` is **empty**, Grafana binds **all interfaces**, so
`listener.Addr().String()` typically renders as **`[::]:3000`** (the IPv6 wildcard) against
the default `http_port = 3000`. With the shipped defaults, the externally advertised
`root_url` resolves to `http://localhost:3000/`.

### Citations

- `pkg/api/http_server.go` [pkg/api/http_server.go:L323] — the component logger is named `http.server`, so every line this server emits is attributable to that component:

  ```go
  log:                          log.New("http.server"),
  ```

- `pkg/api/http_server.go` [pkg/api/http_server.go:L429] — the listener is opened first, and only a successful return proceeds to the log line:

  ```go
  listener, err := hs.getListener()
  if err != nil {
      return err
  }
  ```

- `pkg/api/http_server.go` [pkg/api/http_server.go:L434-L435] — the readiness line itself, echoing the resolved configuration:

  ```go
  hs.log.Info("HTTP Server Listen", "address", listener.Addr().String(), "protocol",
      hs.Cfg.Protocol, "subUrl", hs.Cfg.AppSubURL, "socket", hs.Cfg.SocketPath)
  ```

- `conf/defaults.ini` `[server]` block — the defaults that populate those fields:

  ```ini
  [server]                                                  # [conf/defaults.ini:L30]
  # Protocol (http, https, h2, socket)
  protocol = http                                           # [conf/defaults.ini:L32]
  # The ip address to bind to, empty will bind to all interfaces
                                                            # [conf/defaults.ini:L37]
  http_addr =                                               # [conf/defaults.ini:L38] (empty)
  # The http port to use
  http_port = 3000                                          # [conf/defaults.ini:L41]
  # The public facing domain name used to access grafana from a browser
  domain = localhost                                        # [conf/defaults.ini:L44]
  # The full public facing url
  root_url = %(protocol)s://%(domain)s:%(http_port)s/       # [conf/defaults.ini:L51]
  socket = /tmp/grafana.sock                                # [conf/defaults.ini:L83]
  ```

### Reasoning / Why

The ordering in the code is what makes this line meaningful. `getListener()` is called
at [pkg/api/http_server.go:L429], and the function returns early on any error, so control
only reaches the `hs.log.Info("HTTP Server Listen", …)` call at
[pkg/api/http_server.go:L434-L435] *after* the socket is open and accepting connections.
That is precisely why this line — and not an earlier "starting" message — is the honest
"the server is now listening" signal.

The four fields are read straight from the resolved `hs.Cfg`, so the line is a faithful
echo of the effective `[server]` configuration rather than a hard-coded string. The
`address` comes from the live listener (`listener.Addr().String()`), so it reflects what
the OS actually bound. Since the default `http_addr` is empty — and the inline comment in
`conf/defaults.ini` at [conf/defaults.ini:L37] states "empty will bind to all interfaces"
— the kernel binds the wildcard address, which is why the rendered value is commonly
`[::]:3000` rather than a single concrete host. The `protocol` and `socket` fields tell you
*how* traffic reaches Grafana: plain HTTP, TLS (`https`), HTTP/2 (`h2`), or a Unix domain
socket at `hs.Cfg.SocketPath`. Combined with `subUrl` (empty by default, so Grafana is at
the root path) and the `root_url` template at [conf/defaults.ini:L51], the single line tells
you the bind address, the transport, the serving sub-path, and — by reference to the
defaults — the browser-facing URL `http://localhost:3000/`.

---

## Q2 — After signing in with the default admin credentials, Grafana immediately asks for something before letting me proceed. What internal state is being finalized at that point?

> After "signing in with the default admin credentials, Grafana immediately asks for something before letting me proceed, which makes me wonder what internal state is being finalized at that point."

### Answer

Nothing about *authentication* is being finalized at that point — by the time the prompt
appears, you are **already authenticated**. The successful `POST /login` has already
established the session/cookie. The thing Grafana then asks for is a **client-side,
skippable** request to **rotate the default `admin` password**. It is **not** a
server-enforced "you must change your password" block.

The change-password view is triggered **only** when the password you just submitted is
literally `admin` **and** neither LDAP nor auth-proxy authentication is enabled. If either
of those conditions fails (your password isn't `admin`, or delegated auth is on), the client
takes you straight into the app. When the prompt does appear, you can either submit a new
password — which is sent via **`PUT /api/user/password`** to the `ChangeUserPassword`
handler — or **skip** it entirely.

The reason the default credential is `admin`/`admin` in the first place is the startup
bootstrap: the SQL store seeds a default admin user on first run, reading the `[security]`
defaults. So the "internal state being finalized" is really the **optional rotation of a
seeded default credential**, layered on top of an already-authenticated session.

### Citations

- Default admin is created at startup by the SQL store — `pkg/services/sqlstore/sqlstore.go` [pkg/services/sqlstore/sqlstore.go:L190] and [pkg/services/sqlstore/sqlstore.go:L222]:

  ```go
  func (ss *SQLStore) ensureMainOrgAndAdminUser(test bool) error {   // [L190]
      // …seeds the admin user from cfg when no users exist…
      ss.log.Info("Created default admin", "user", ss.cfg.AdminUser)  // [L222]
  ```

- The seeded values come from `conf/defaults.ini` `[security]`:

  ```ini
  [security]                                # [conf/defaults.ini:L323]
  disable_initial_admin_creation = false    # [conf/defaults.ini:L325]
  admin_user = admin                        # [conf/defaults.ini:L328]
  admin_password = admin                    # [conf/defaults.ini:L331]
  admin_email = admin@localhost             # [conf/defaults.ini:L334]
  ```

- The client gate lives in `public/app/core/components/Login/LoginCtrl.tsx`. The sign-in call that establishes the session is at [public/app/core/components/Login/LoginCtrl.tsx:L113-L114]:

  ```ts
  getBackendSrv()
    .post<LoginDTO>('/login', formModel, { showErrorAlert: false })
  ```

  The decision of whether to prompt is at [public/app/core/components/Login/LoginCtrl.tsx:L117], [public/app/core/components/Login/LoginCtrl.tsx:L118] and [public/app/core/components/Login/LoginCtrl.tsx:L121]:

  ```ts
  if (formModel.password !== 'admin' || config.ldapEnabled || config.authProxyEnabled) {
    this.toGrafana();                                // go straight in — no prompt
    return;
  } else {
    this.changeView(formModel.password === 'admin'); // open the change-password view
  }
  ```

  `changeView` flips the controller into the change-password state at [public/app/core/components/Login/LoginCtrl.tsx:L176], [public/app/core/components/Login/LoginCtrl.tsx:L178-L179]:

  ```ts
  changeView = (showDefaultPasswordWarning: boolean) => {
    this.setState({
      isChangingPassword: true,
      showDefaultPasswordWarning,
    });
  };
  ```

  That the step is **skippable** is proven by [public/app/core/components/Login/LoginCtrl.tsx:L220], where the "skip" action is wired directly to `toGrafana` (i.e., it passes the user straight through to the app):

  ```ts
  skipPasswordChange: toGrafana,
  ```

  Supporting prop/state declarations: `isChangingPassword` at [public/app/core/components/Login/LoginCtrl.tsx:L41], `skipPasswordChange: Function` at [public/app/core/components/Login/LoginCtrl.tsx:L42], and `showDefaultPasswordWarning` at [public/app/core/components/Login/LoginCtrl.tsx:L52] and [public/app/core/components/Login/LoginCtrl.tsx:L60].

- If the user does change the password, the form submits to the server handler and route — `pkg/api/user.go` [pkg/api/user.go:L546] and `pkg/api/api.go` [pkg/api/api.go:L277]:

  ```go
  func (hs *HTTPServer) ChangeUserPassword(c *contextmodel.ReqContext) response.Response {   // user.go [L546]
  ```

  ```go
  userRoute.Put("/password", routing.Wrap(hs.ChangeUserPassword))                            // api.go [L277]
  ```

### Reasoning / Why

The key insight is that the prompt is *not* an authentication step. Authentication is
already complete the moment `POST /login` returns success and the session cookie is set —
that call is issued at [public/app/core/components/Login/LoginCtrl.tsx:L113-L114], inside the
`.then(...)` of which the controller has the authenticated `result` in hand. Everything that
follows is a **client-side UX decision**, not a server gate.

That decision is the conditional at [public/app/core/components/Login/LoginCtrl.tsx:L117]: the
React controller inspects the password you just typed. Only if it is still the literal default
`admin` — and you are not using LDAP or auth-proxy (where local password rotation would be
meaningless) — does it route you to the change-password view via `changeView`
([public/app/core/components/Login/LoginCtrl.tsx:L121] → [public/app/core/components/Login/LoginCtrl.tsx:L176]).
Otherwise it calls `this.toGrafana()` at [public/app/core/components/Login/LoginCtrl.tsx:L118]
and you go straight in.

Crucially, the step is advisory rather than enforced: the `skipPasswordChange` action maps
to `toGrafana` at [public/app/core/components/Login/LoginCtrl.tsx:L220], so the user can
bypass it and still reach the application. The reason this scenario exists at all is the
startup bootstrap — `ensureMainOrgAndAdminUser` at [pkg/services/sqlstore/sqlstore.go:L190]
seeds a default admin (logging `Created default admin` at
[pkg/services/sqlstore/sqlstore.go:L222]) using the `[security]` defaults
`admin_user = admin` / `admin_password = admin`
([conf/defaults.ini:L328], [conf/defaults.ini:L331]). If the user does proceed with the
change, the new password travels over `PUT /api/user/password`
([pkg/api/api.go:L277]) to `ChangeUserPassword` ([pkg/api/user.go:L546]). So the "internal
state finalized at that point" is best described as the **optional rotation of the seeded
default credential** — an advisory hardening prompt sitting on top of a session that is
already fully authenticated.

---

## Q3 — There's a health endpoint that returns JSON. What does a healthy response actually look like, and what is the `database` field really telling me about the system's readiness?

> "There's a health endpoint that returns JSON, but what does a healthy response actually look like, and what is the database field really telling me about the system's readiness?"

### Answer

The JSON health endpoint is **`GET /api/health`**. A **healthy** response is **HTTP 200**
with a body whose `database` field is `"ok"`; if the database probe fails, the same endpoint
returns **HTTP 503** with `"database":"failing"`.

The response shape (`healthResponse`) is:

```json
{
  "database": "ok",
  "version": "<build version>",
  "commit": "<build commit>"
}
```

Notes on the shape:

- `version` and `commit` are **omitted** (suppressed) when version hiding is configured
  (`hs.Cfg.Anonymous.HideVersion`), so a hardened instance's health JSON may contain only
  `database`.
- `enterpriseCommit` is present **only** on enterprise builds where the value is neither
  `"NA"` nor empty.
- The body is **pretty-printed** JSON (`json.MarshalIndent` with a two-space indent) and is
  served with `Content-Type: application/json; charset=UTF-8`.

The `database` field is the result of a **cached (5-second) `SELECT 1`** probe against the
configured database. That makes `/api/health` a **readiness** check — it answers "can Grafana
actually reach its backing store right now?" This is distinct from **`/healthz`**, which is a
**liveness-only** endpoint: it always returns `200 "Ok"` if the web server process is up and
never touches the database.

### Citations

- Both health endpoints are wired as middleware on the root mux — `pkg/api/http_server.go` [pkg/api/http_server.go:L633-L634]:

  ```go
  m.Use(hs.healthzHandler)
  m.Use(hs.apiHealthHandler)
  ```

- The liveness endpoint `/healthz` writes `200 "Ok"` and never accesses the database — `pkg/api/http_server.go` [pkg/api/http_server.go:L680-L691]:

  ```go
  // healthzHandler always return 200 - Ok if Grafana's web server is running
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

- The JSON response model — `pkg/api/http_server.go` [pkg/api/http_server.go:L693-L699]:

  ```go
  // swagger:model healthResponse
  type healthResponse struct {
      Database         string `json:"database"`
      Version          string `json:"version,omitempty"`
      Commit           string `json:"commit,omitempty"`
      EnterpriseCommit string `json:"enterpriseCommit,omitempty"`
  }
  ```

- The readiness handler builds the body, chooses the status code, and serializes it — `pkg/api/http_server.go` [pkg/api/http_server.go:L710], [pkg/api/http_server.go:L716-L736]:

  ```go
  func (hs *HTTPServer) apiHealthHandler(ctx *web.Context) {                 // [L710]
      // …
      data := healthResponse{                                               // [L716]
          Database: "ok",                                                   // [L717]
      }
      if !hs.Cfg.Anonymous.HideVersion {                                    // [L719]
          data.Version = hs.Cfg.BuildVersion
          data.Commit = hs.Cfg.BuildCommit
          if hs.Cfg.EnterpriseBuildCommit != "NA" && hs.Cfg.EnterpriseBuildCommit != "" {
              data.EnterpriseCommit = hs.Cfg.EnterpriseBuildCommit
          }
      }
      if !hs.databaseHealthy(ctx.Req.Context()) {                           // [L727]
          data.Database = "failing"                                         // [L728]
          ctx.Resp.Header().Set("Content-Type", "application/json; charset=UTF-8")  // [L729]
          ctx.Resp.WriteHeader(http.StatusServiceUnavailable)               // [L730] -> 503
      } else {
          ctx.Resp.Header().Set("Content-Type", "application/json; charset=UTF-8")  // [L732]
          ctx.Resp.WriteHeader(http.StatusOK)                               // [L733] -> 200
      }
      dataBytes, err := json.MarshalIndent(data, "", "  ")                  // [L736]
  ```

- The `database` value comes from a cached `SELECT 1` probe — `pkg/api/health.go` [pkg/api/health.go:L10], [pkg/api/health.go:L13-L23]:

  ```go
  func (hs *HTTPServer) databaseHealthy(ctx context.Context) bool {   // [L10]
      const cacheKey = "db-healthy"
      if cached, found := hs.CacheService.Get(cacheKey); found {       // [L13-L15] cache hit
          return cached.(bool)
      }
      err := hs.SQLStore.WithDbSession(ctx, func(session *db.Session) error {  // [L17-L20]
          _, err := session.Exec("SELECT 1")
          return err
      })
      healthy := err == nil                                            // [L21]
      hs.CacheService.Set(cacheKey, healthy, time.Second*5)            // [L23] 5-second cache
      return healthy
  }
  ```

### Reasoning / Why

A healthy `/api/health` response means more than "the web server answered." The handler
`apiHealthHandler` ([pkg/api/http_server.go:L710]) explicitly calls `databaseHealthy`
([pkg/api/http_server.go:L727]), which runs `SELECT 1` against the configured database
([pkg/api/health.go:L17-L20]). That is why this endpoint is a genuine **readiness** probe:
the `database` field directly reports whether Grafana can reach its backing store. `"ok"`
means the probe succeeded and the handler writes `http.StatusOK` (200)
([pkg/api/http_server.go:L733]); `"failing"` means the probe errored and the handler writes
`http.StatusServiceUnavailable` (503) ([pkg/api/http_server.go:L728-L730]).

The value is cached for five seconds ([pkg/api/health.go:L23]), so the field reflects DB
reachability *within the last 5 seconds* rather than firing a brand-new query on every hit —
a deliberate trade-off so that frequent health polling (for example from a load balancer or
orchestrator) does not hammer the database. Contrast this with `/healthz`
([pkg/api/http_server.go:L680-L691]), which never touches the database and only confirms the
process is alive — that is the **liveness vs. readiness** distinction in concrete terms.

Finally, the `omitempty` tags on the struct ([pkg/api/http_server.go:L693-L699]) together
with the `HideVersion` guard ([pkg/api/http_server.go:L719]) explain why a hardened
instance's health JSON can legitimately contain only the `database` field: when version
hiding is on, `Version`/`Commit` are never populated, and `omitempty` drops them from the
serialized output. `EnterpriseCommit` is only ever set when it is neither `"NA"` nor empty,
so it appears only on enterprise builds.

---

## Q4 — I noticed several background services starting during boot. Which components are those logs hinting at, and how much of Grafana is already active before the UI appears?

> "I also noticed several background services starting during boot, and I'm curious which components those logs are hinting at and how much of Grafana is already active before the UI appears."

### Answer

`Server.Run()` starts every **enabled** background service as a **goroutine inside an
`errgroup`** (`s.childRoutines`). The consequences are:

- **Concurrent, not sequential.** All services are dispatched in one loop and run in
  parallel; the loop does not start one and wait for it before starting the next.
- **Fail-fast.** Because the group is an `errgroup`, the first non-context error tears the
  rest down, and only that first error is returned to the caller.
- **The logs only "hint."** The generic per-service message `Starting background service` is
  emitted at **DEBUG** level, so at the default **INFO** log level it is **hidden** — which is
  exactly why boot logs only *hint* at these services rather than announcing each one.
- **The HTTP server is itself a background service — the *first* one registered.** So the
  UI/API server comes up as a *peer* alongside the others, not strictly before them.
- After the loop has dispatched the services, Grafana signals readiness to systemd via
  `READY=1`.

The registry enumerates **exactly 36** background services. In registry order (with
`httpServer` first), they are:

1. `httpServer` — the HTTP/API/UI server itself
2. `ng` — alerting (`ngalert` / Alertmanager)
3. `cleanup` — periodic cleanup service
4. `live` — Grafana Live (WebSocket/streaming)
5. `pushGateway` — Live push HTTP gateway
6. `notifications` — notifications service
7. `rendering` — image-rendering service
8. `tokenService` — user auth-token background service
9. `provisioning` — dashboards/datasources provisioning
10. `grafanaUpdateChecker` — Grafana update checker
11. `pluginsUpdateChecker` — plugins update checker
12. `metrics` — internal metrics service
13. `usageStats` — usage statistics
14. `statsCollector` — stats collector
15. `tracing` — distributed tracing
16. `remoteCache` — remote cache
17. `secretsService` — secrets manager
18. `StorageService` — storage service
19. `searchService` — search (v2)
20. `entityEventsService` — entity events
21. `grpcServerProvider` — gRPC server
22. `saService` — service accounts
23. `pluginStore` — plugin store
24. `secretMigrationProvider` — secret migrations
25. `loginAttemptService` — login-attempt tracking
26. `bundleService` — support bundles
27. `publicDashboardsMetric` — public-dashboards metrics
28. `keyRetriever` — (dynamic) key retriever
29. `dynamicAngularDetectorsProvider` — dynamic Angular detectors
30. `grafanaAPIServer` — Grafana API server (aggregated/k8s-style API)
31. `anon` — anonymous-device service
32. `ssoSettings` — SSO settings
33. `pluginExternal` — external plugins
34. `pluginInstaller` — plugin installer
35. `accessControl` — RBAC / access control
36. `appRegistry` — app registry

**Conclusion.** A large portion of Grafana — alerting, Live, provisioning, plugins, search,
secrets, metrics, RBAC/access-control, tracing, and the rest — is already starting
**concurrently with** the UI by the time the HTTP listener becomes reachable. The UI is not a
gate that the rest waits behind; it is one of 36 services coming up together.

### Citations

- The run loop launches each enabled service as a goroutine in an `errgroup` — `pkg/server/server.go` [pkg/server/server.go:L139], [pkg/server/server.go:L146], [pkg/server/server.go:L150], [pkg/server/server.go:L155-L156], [pkg/server/server.go:L162-L163], [pkg/server/server.go:L176], [pkg/server/server.go:L179]:

  ```go
  func (s *Server) Run() error {                                   // [L139]
      // …
      services := s.backgroundServices                             // [L146]
      // Start background services.
      for _, svc := range services {
          if registry.IsDisabled(svc) {                            // [L150] skip disabled
              continue
          }
          service := svc
          serviceName := reflect.TypeOf(service).String()          // [L155]
          s.childRoutines.Go(func() error {                        // [L156] concurrent goroutine
              select {
              case <-s.context.Done():
                  return s.context.Err()
              default:
              }
              s.log.Debug("Starting background service", "service", serviceName)  // [L162] DEBUG
              err := service.Run(s.context)                        // [L163]
              // Do not return context.Canceled error since errgroup.Group only   // [L164-L166]
              // returns the first error to the caller - thus we can miss a more
              // interesting error.
              if err != nil && !errors.Is(err, context.Canceled) {
                  s.log.Error("Stopped background service", "service", serviceName, "reason", err)
                  return fmt.Errorf("%s run error: %w", serviceName, err)
              }
              s.log.Debug("Stopped background service", "service", serviceName, "reason", err)
              return nil
          })
      }
      s.notifySystemd("READY=1")                                   // [L176]
      s.log.Debug("Waiting on services...")                        // [L178]
      return s.childRoutines.Wait()                                // [L179]
  }
  ```

- The registry enumerates exactly 36 services with `httpServer` first — `pkg/registry/backgroundsvcs/background_services.go` [pkg/registry/backgroundsvcs/background_services.go:L53], [pkg/registry/backgroundsvcs/background_services.go:L80-L116]:

  ```go
  func ProvideBackgroundServiceRegistry(            // [L53]
      // …injected services…
  ) *BackgroundServiceRegistry {
      return NewBackgroundServiceRegistry(          // [L80]
          httpServer,                               // [L81] — first entry
          ng,
          cleanup,
          live,
          // …32 more, in the order listed above…
          accessControl,
          appRegistry,                              // [L116] — 36th entry
      )
  }
  ```

### Reasoning / Why

The concurrency model is the whole answer to "several background services starting during
boot." The `Run()` loop ([pkg/server/server.go:L149] onward) does not start a service and
block until it finishes; it hands each one to `s.childRoutines.Go(...)`
([pkg/server/server.go:L156]) — an `errgroup` that runs the closures as concurrent goroutines.
The inline comment at [pkg/server/server.go:L164-L166] confirms the fail-fast semantics: the
group returns only the first real error to the caller, so a single failing service can tear
the rest down. That is the mechanism behind the "several services starting" you observed.

The reason the boot logs only *hint* at the services — rather than announcing each by name —
is the log level. The per-service "Starting background service" message is emitted with
`s.log.Debug(...)` at [pkg/server/server.go:L162], and at the default INFO level DEBUG lines
are suppressed. So you infer the services from surrounding signals (and from the registry)
rather than seeing a clean "started X" line for each.

The most important structural fact is that `httpServer` is the **first entry** in the
registry ([pkg/registry/backgroundsvcs/background_services.go:L81]) — it is one of the 36
services started in the same concurrent loop, not a privileged step that runs before the
others. That directly answers "how much of Grafana is already active before the UI appears":
essentially the entire background-service set is *coming up concurrently with* the UI, not
before it. Finally, `notifySystemd("READY=1")` at [pkg/server/server.go:L176] is sent once the
loop has dispatched all the services (and then `childRoutines.Wait()` at
[pkg/server/server.go:L179] blocks for their lifetime), which is how the process advertises
readiness to an init system such as systemd.

---

## Notes

**Basis of these answers.** Every conclusion above is derived from **static source
analysis** of the cited files at commit `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`. The code
is authoritative; a runtime build/run is **optional and confirmatory only** — it is not
required to establish any of the answers, all of which are grounded in exact `[path:locator]`
citations.

**Optional, reproducible runtime-verification procedure.** If you want to observe the
behavior live, the repository ships canonical build/run targets:

- Build the server: `make build-server` (`go run build.go … build-server`,
  `Makefile` [Makefile:L201]).
- Build-and-run with file watching: `make run` (`bra run`, `Makefile` [Makefile:L232]).

The pinned toolchain for such a build is:

| Tool | Version | Source |
|------|---------|--------|
| Go   | 1.23.1   | `go.mod` [go.mod:L3] |
| Node | v22.11.0 | `.nvmrc` [.nvmrc:L1] |
| Yarn | 4.5.3    | `package.json` `packageManager` [package.json:L453] |

What to observe once it is running at `http://localhost:3000`:

- The real `HTTP Server Listen` INFO line in the startup logs (Q1).
- The live health JSON, e.g. `curl -s http://localhost:3000/api/health` (Q3).
- The DEBUG `Starting background service` lines (Q4) — visible only after raising the log
  level to `debug` (for example `cfg:log.level=debug`), since they are suppressed at the
  default INFO level.
- The post-login change-password prompt after signing in with `admin`/`admin` (Q2).

**Mandatory cleanup / repository immutability.** Any such runtime verification **must** be
performed **outside** the repository — use a working directory and data/logs/plugins paths
under `/tmp` (for example
`cfg:paths.data=/tmp/gf-data cfg:paths.logs=/tmp/gf-logs cfg:paths.plugins=/tmp/gf-plugins`).
Afterward, **all** transient artifacts must be removed — the SQLite `grafana.db`, any `data/`
directory, log files, and compiled binaries — so the repository stays pristine. Performing
this verification is **optional**, and **no repository file other than this document is
created, modified, or deleted** as part of answering these questions.

