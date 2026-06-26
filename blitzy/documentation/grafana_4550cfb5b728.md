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
**Answer** (the direct conclusion), **Citations** (exact source locators in `path:line`
form, with short quoted snippets), and **Reasoning / Why** (the rationale that connects the
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
logger named **`http.server`** _immediately after_ the network listener has been opened
successfully. It is not a generic "starting" message — it is logged only once the socket
is actually bound and ready to accept connections.

The line carries four fields that describe exactly _where_ and _how_ Grafana is exposed:

| Field      | Source expression          | Meaning                                                                |
| ---------- | -------------------------- | ---------------------------------------------------------------------- |
| `address`  | `listener.Addr().String()` | The bound socket address (host:port) the listener is actually on       |
| `protocol` | `hs.Cfg.Protocol`          | The wire protocol: one of `http`, `https`, `h2` (HTTP/2), or `socket`  |
| `subUrl`   | `hs.Cfg.AppSubURL`         | The sub-path Grafana is served under (empty by default)                |
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

- `conf/defaults.ini` `[server]` block — the defaults that populate those fields (header at [conf/defaults.ini:L30]; `protocol` [conf/defaults.ini:L32], `http_addr` [conf/defaults.ini:L38], `http_port` [conf/defaults.ini:L41], `domain` [conf/defaults.ini:L44], `root_url` [conf/defaults.ini:L51], `socket` [conf/defaults.ini:L83]). The excerpt below quotes the relevant lines verbatim:

  ```ini
  [server]
  # Protocol (http, https, h2, socket)
  protocol = http
  # The ip address to bind to, empty will bind to all interfaces
  http_addr =
  # The http port to use
  http_port = 3000
  # The public facing domain name used to access grafana from a browser
  domain = localhost
  # The full public facing url
  root_url = %(protocol)s://%(domain)s:%(http_port)s/
  # Unix socket path
  socket = /tmp/grafana.sock
  ```

### Reasoning / Why

The ordering in the code is what makes this line meaningful. `getListener()` is called
at [pkg/api/http_server.go:L429], and the function returns early on any error, so control
only reaches the `hs.log.Info("HTTP Server Listen", …)` call at
[pkg/api/http_server.go:L434-L435] _after_ the socket is open and accepting connections.
That is precisely why this line — and not an earlier "starting" message — is the honest
"the server is now listening" signal.

The four fields are read straight from the resolved `hs.Cfg`, so the line is a faithful
echo of the effective `[server]` configuration rather than a hard-coded string. The
`address` comes from the live listener (`listener.Addr().String()`), so it reflects what
the OS actually bound. Since the default `http_addr` is empty — and the inline comment in
`conf/defaults.ini` at [conf/defaults.ini:L37] states "empty will bind to all interfaces"
— the kernel binds the wildcard address, which is why the rendered value is commonly
`[::]:3000` rather than a single concrete host. The `protocol` and `socket` fields tell you
_how_ traffic reaches Grafana: plain HTTP, TLS (`https`), HTTP/2 (`h2`), or a Unix domain
socket at `hs.Cfg.SocketPath`. Combined with `subUrl` (empty by default, so Grafana is at
the root path) and the `root_url` template at [conf/defaults.ini:L51], the single line tells
you the bind address, the transport, the serving sub-path, and — by reference to the
defaults — the browser-facing URL `http://localhost:3000/`.

---

## Q2 — After signing in with the default admin credentials, Grafana immediately asks for something before letting me proceed, which makes me wonder what internal state is being finalized at that point.

> After "signing in with the default admin credentials, Grafana immediately asks for something before letting me proceed, which makes me wonder what internal state is being finalized at that point."

### Answer

Nothing about _authentication_ is being finalized at that point — by the time the prompt
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

- Default admin is created at startup by the SQL store. `ensureMainOrgAndAdminUser` is defined at [pkg/services/sqlstore/sqlstore.go:L190]; when no user yet exists it creates the admin from the configured `[security]` values and logs `Created default admin` at [pkg/services/sqlstore/sqlstore.go:L222]. The admin-creation block ([pkg/services/sqlstore/sqlstore.go:L209-L223]) is:

  ```go
  // ensure admin user
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

- The seeded values come from `conf/defaults.ini` `[security]` (header at [conf/defaults.ini:L323]; `admin_user` [conf/defaults.ini:L328], `admin_password` [conf/defaults.ini:L331], `admin_email` [conf/defaults.ini:L334]). The relevant lines, quoted verbatim, are:

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

- The client gate lives in `public/app/core/components/Login/LoginCtrl.tsx`. The sign-in request it issues is at [public/app/core/components/Login/LoginCtrl.tsx:L113-L114]:

  <!-- prettier-ignore -->
  ```ts
  getBackendSrv()
    .post<LoginDTO>('/login', formModel, { showErrorAlert: false })
  ```

  That `POST /login` is handled **server-side**, and it is the backend — not the client — that actually establishes the session by writing the login cookie. The route is registered in `pkg/api/api.go` at [pkg/api/api.go:L81]:

  ```go
  r.Post("/login", requestmeta.SetOwner(requestmeta.TeamAuth), quota(string(auth.QuotaTargetSrv)), routing.Wrap(hs.LoginPost))
  ```

  `hs.LoginPost` performs the login and returns through `authn.HandleLoginResponse` — `pkg/api/login.go` [pkg/api/login.go:L230-L242]:

  ```go
  func (hs *HTTPServer) LoginPost(c *contextmodel.ReqContext) response.Response {
      identity, err := hs.authnService.Login(c.Req.Context(), authn.ClientForm, &authn.Request{HTTPRequest: c.Req})
      if err != nil {
          tokenErr := &auth.CreateTokenErr{}
          if errors.As(err, &tokenErr) {
              return response.Error(tokenErr.StatusCode, tokenErr.ExternalErr, tokenErr.InternalErr)
          }
          return response.Err(err)
      }

      metrics.MApiLoginPost.Inc()
      return authn.HandleLoginResponse(c.Req, c.Resp, hs.Cfg, identity, hs.ValidateRedirectTo, hs.Features)
  }
  ```

  `HandleLoginResponse` delegates to `handleLogin`, whose very first action is to write the session cookie — `pkg/services/authn/authn.go` [pkg/services/authn/authn.go:L254-L259] and [pkg/services/authn/authn.go:L272-L273]:

  ```go
  // HandleLoginResponse is a utility function to perform common operations after a successful login and returns response.NormalResponse
  func HandleLoginResponse(r *http.Request, w http.ResponseWriter, cfg *setting.Cfg, identity *Identity, validator RedirectValidator, features featuremgmt.FeatureToggles) *response.NormalResponse {
      result := map[string]any{"message": "Logged in"}
      result["redirectUrl"] = handleLogin(r, w, cfg, identity, validator, features, "")
      return response.JSON(http.StatusOK, result)
  }
  ```

  ```go
  func handleLogin(r *http.Request, w http.ResponseWriter, cfg *setting.Cfg, identity *Identity, validator RedirectValidator, features featuremgmt.FeatureToggles, redirectToCookieName string) string {
      WriteSessionCookie(w, cfg, identity.SessionToken)
  ```

  `WriteSessionCookie` sets the actual login cookie (`cfg.LoginCookieName`) on the HTTP response — `pkg/services/authn/authn.go` [pkg/services/authn/authn.go:L313-L319]:

  ```go
  func WriteSessionCookie(w http.ResponseWriter, cfg *setting.Cfg, token *usertoken.UserToken) {
      maxAge := int(cfg.LoginMaxLifetime.Seconds())
      if cfg.LoginMaxLifetime <= 0 {
          maxAge = -1
      }

      cookies.WriteCookie(w, cfg.LoginCookieName, url.QueryEscape(token.UnhashedToken), maxAge, nil)
  ```

  Only after this `200` response (with the cookie set) does the frontend promise resolve into its `.then((result) => …)` block — which is why, by the time any prompt appears, the session is already established.

  The decision of whether to prompt is at [public/app/core/components/Login/LoginCtrl.tsx:L117], [public/app/core/components/Login/LoginCtrl.tsx:L118] and [public/app/core/components/Login/LoginCtrl.tsx:L121]:

  ```ts
  if (formModel.password !== 'admin' || config.ldapEnabled || config.authProxyEnabled) {
    this.toGrafana();
    return;
  } else {
    this.changeView(formModel.password === 'admin');
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

- If the user does change the password, the **frontend** submits it via `PUT /api/user/password` from the `changePassword` handler — `public/app/core/components/Login/LoginCtrl.tsx` [public/app/core/components/Login/LoginCtrl.tsx:L78-L105] (the `else` branch issues the `put`; note the `oldPassword: 'admin'` payload):

  ```ts
  changePassword = (password: string) => {
    const pw = {
      newPassword: password,
      confirmNew: password,
      oldPassword: 'admin',
    };

    if (this.props.resetCode) {
      const resetModel = {
        code: this.props.resetCode,
        newPassword: password,
        confirmPassword: password,
      };

      getBackendSrv()
        .post('/api/user/password/reset', resetModel)
        .then(() => {
          this.toGrafana();
        });
    } else {
      getBackendSrv()
        .put('/api/user/password', pw)
        .then(() => {
          this.toGrafana();
        })
        .catch((err) => console.error(err));
    }
  };
  ```

- That `PUT /api/user/password` request is **served** by the `ChangeUserPassword` handler — `pkg/api/user.go` [pkg/api/user.go:L546] — which is bound to the route in `pkg/api/api.go` [pkg/api/api.go:L277]:

  ```go
  func (hs *HTTPServer) ChangeUserPassword(c *contextmodel.ReqContext) response.Response {
  ```

  ```go
  userRoute.Put("/password", routing.Wrap(hs.ChangeUserPassword))
  ```

### Reasoning / Why

The key insight is that the prompt is _not_ an authentication step. Authentication is
already complete the moment the **server-side** `POST /login` handler returns success:
`hs.LoginPost` ([pkg/api/login.go:L230-L242]) finishes by calling `authn.HandleLoginResponse`,
whose `handleLogin` writes the session cookie via `WriteSessionCookie`
([pkg/services/authn/authn.go:L254-L259], [pkg/services/authn/authn.go:L272-L273],
[pkg/services/authn/authn.go:L313-L319]). The frontend call that triggers this is issued at
[public/app/core/components/Login/LoginCtrl.tsx:L113-L114], and its `.then((result) => …)` only
runs _after_ that `200`-with-cookie response — so by the time the controller holds the
authenticated `result`, the cookie is already set. Everything that follows is a
**client-side UX decision**, not a server gate.

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

## Q3 — There's a health endpoint that returns JSON, but what does a healthy response actually look like, and what is the database field really telling me about the system's readiness?

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

- The readiness handler builds the body, chooses the status code, and serializes it. The status code is `503` when the DB probe fails ([pkg/api/http_server.go:L727-L730]) and `200` otherwise ([pkg/api/http_server.go:L731-L733]); the body is pretty-printed via `json.MarshalIndent` ([pkg/api/http_server.go:L736]) — `pkg/api/http_server.go` [pkg/api/http_server.go:L710-L736]:

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
  ```

- The `database` value comes from a cached `SELECT 1` probe — `pkg/api/health.go` [pkg/api/health.go:L10-L25] (the result is cached for five seconds at [pkg/api/health.go:L23]):

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
reachability _within the last 5 seconds_ rather than firing a brand-new query on every hit —
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

## Q4 — I also noticed several background services starting during boot, and I'm curious which components those logs are hinting at and how much of Grafana is already active before the UI appears.

> "I also noticed several background services starting during boot, and I'm curious which components those logs are hinting at and how much of Grafana is already active before the UI appears."

### Answer

`Server.Run()` starts every **enabled** background service as a **goroutine inside an
`errgroup`** (`s.childRoutines`). The consequences are:

- **Concurrent, not sequential.** All services are dispatched in one loop and run in
  parallel; the loop does not start one and wait for it before starting the next.
- **Fail-fast.** Because the group is an `errgroup`, the first non-context error tears the
  rest down, and only that first error is returned to the caller.
- **The logs only "hint."** The generic per-service message `Starting background service` is
  emitted at **DEBUG** level, so at the default **INFO** log level ([conf/defaults.ini:L1073-L1074])
  it is **hidden** — which is exactly why boot logs only _hint_ at these services rather than
  announcing each one.
- **The HTTP server is itself a background service — the _first_ one registered.** So the
  UI/API server comes up as a _peer_ alongside the others, not strictly before them.
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

- The run loop launches each enabled service as a goroutine in an `errgroup` (`s.childRoutines`) — `pkg/server/server.go` [pkg/server/server.go:L139-L180]. Note the disabled-service skip ([pkg/server/server.go:L150]), the concurrent dispatch ([pkg/server/server.go:L156]), the per-service DEBUG log ([pkg/server/server.go:L162]), the fail-fast comment ([pkg/server/server.go:L164-L166]), the systemd `READY=1` ([pkg/server/server.go:L176]), and the blocking `Wait()` ([pkg/server/server.go:L179]):

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
              // Do not return context.Canceled error since errgroup.Group only
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

      s.notifySystemd("READY=1")

      s.log.Debug("Waiting on services...")
      return s.childRoutines.Wait()
  }
  ```

- The registry enumerates exactly 36 services with `httpServer` first. They are constructed in `ProvideBackgroundServiceRegistry` ([pkg/registry/backgroundsvcs/background_services.go:L53]); the `NewBackgroundServiceRegistry(...)` call passes all 36 in order — `httpServer` first ([pkg/registry/backgroundsvcs/background_services.go:L81]) through `appRegistry` 36th ([pkg/registry/backgroundsvcs/background_services.go:L116]) — `pkg/registry/backgroundsvcs/background_services.go` [pkg/registry/backgroundsvcs/background_services.go:L80-L117]:

  ```go
  return NewBackgroundServiceRegistry(
      httpServer,
      ng,
      cleanup,
      live,
      pushGateway,
      notifications,
      rendering,
      tokenService,
      provisioning,
      grafanaUpdateChecker,
      pluginsUpdateChecker,
      metrics,
      usageStats,
      statsCollector,
      tracing,
      remoteCache,
      secretsService,
      StorageService,
      searchService,
      entityEventsService,
      grpcServerProvider,
      saService,
      pluginStore,
      secretMigrationProvider,
      loginAttemptService,
      bundleService,
      publicDashboardsMetric,
      keyRetriever,
      dynamicAngularDetectorsProvider,
      grafanaAPIServer,
      anon,
      ssoSettings,
      pluginExternal,
      pluginInstaller,
      accessControl,
      appRegistry,
  )
  ```

- The default log level is `info`, which is why the per-service DEBUG line is suppressed unless the level is lowered — `conf/defaults.ini` `[log]` [conf/defaults.ini:L1073-L1074]:

  ```ini
  # Either "debug", "info", "warn", "error", "critical", default is "info"
  level = info
  ```

### Reasoning / Why

The concurrency model is the whole answer to "several background services starting during
boot." The `Run()` loop ([pkg/server/server.go:L149] onward) does not start a service and
block until it finishes; it hands each one to `s.childRoutines.Go(...)`
([pkg/server/server.go:L156]) — an `errgroup` that runs the closures as concurrent goroutines.
The inline comment at [pkg/server/server.go:L164-L166] confirms the fail-fast semantics: the
group returns only the first real error to the caller, so a single failing service can tear
the rest down. That is the mechanism behind the "several services starting" you observed.

The reason the boot logs only _hint_ at the services — rather than announcing each by name —
is the log level. The per-service "Starting background service" message is emitted with
`s.log.Debug(...)` at [pkg/server/server.go:L162], and the default log level is `info`
([conf/defaults.ini:L1073-L1074]), at which DEBUG lines are suppressed. So you infer the
services from surrounding signals (and from the registry) rather than seeing a clean
"started X" line for each.

The most important structural fact is that `httpServer` is the **first entry** in the
registry ([pkg/registry/backgroundsvcs/background_services.go:L81]) — it is one of the 36
services started in the same concurrent loop, not a privileged step that runs before the
others. That directly answers "how much of Grafana is already active before the UI appears":
essentially the entire background-service set is _coming up concurrently with_ the UI, not
before it. Finally, `notifySystemd("READY=1")` at [pkg/server/server.go:L176] is sent once the
loop has dispatched all the services (and then `childRoutines.Wait()` at
[pkg/server/server.go:L179] blocks for their lifetime), which is how the process advertises
readiness to an init system such as systemd.

---

## Notes

**Basis of these answers.** Every conclusion above is derived from **static source
analysis** of the cited files at commit `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`. The code
is authoritative; a runtime build/run is **optional and confirmatory only** — it is not
required to establish any of the answers, all of which are grounded in exact `path:line`
source citations.

**Optional, reproducible runtime-verification procedure.** If you want to observe the
behavior live, the repository ships canonical build/run targets:

- Build the server: `make build-server` (`go run build.go … build-server`,
  `Makefile` [Makefile:L201]).
- Build-and-run with file watching: `make run` (`bra run`, `Makefile` [Makefile:L232]).

The pinned toolchain for such a build is:

| Tool | Version  | Source                                              |
| ---- | -------- | --------------------------------------------------- |
| Go   | 1.23.1   | `go.mod` [go.mod:L3]                                |
| Node | v22.11.0 | `.nvmrc` [.nvmrc:L1]                                |
| Yarn | 4.5.3    | `package.json` `packageManager` [package.json:L453] |

What to observe once it is running at `http://localhost:3000`:

- The real `HTTP Server Listen` INFO line in the startup logs (Q1).
- The live health JSON, e.g. `curl -s http://localhost:3000/api/health` (Q3).
- The DEBUG `Starting background service` lines (Q4) — visible only after raising the log
  level to `debug` (for example `cfg:log.level=debug`), since they are suppressed at the
  default INFO level ([conf/defaults.ini:L1073-L1074]).
- The post-login change-password prompt after signing in with `admin`/`admin` (Q2).

**Mandatory cleanup / repository immutability.** Any such runtime verification **must** be
performed **outside** the repository — use a working directory and data/logs/plugins paths
under `/tmp` (for example
`cfg:paths.data=/tmp/gf-data cfg:paths.logs=/tmp/gf-logs cfg:paths.plugins=/tmp/gf-plugins`).
Afterward, **all** transient artifacts must be removed — the SQLite `grafana.db`, any `data/`
directory, log files, and compiled binaries — so the repository stays pristine. Performing
this verification is **optional**, and **no repository file other than this document is
created, modified, or deleted** as part of answering these questions.
