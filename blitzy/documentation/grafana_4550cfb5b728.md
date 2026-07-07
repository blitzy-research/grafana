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
  cfg:paths.data=/tmp/gf-cap/A/data \
  cfg:paths.logs=/tmp/gf-cap/A/log
```

> The only CLI arguments used are `--homepath` (so `conf/defaults.ini` resolves) and a
> **redirection of `paths.data`/`paths.logs` into `/tmp`** to keep the repository working tree
> byte‑for‑byte unchanged. Those two keys hold the **same default *values*** as
> `conf/defaults.ini`, just rooted under a throwaway `/tmp` directory. **No** `custom.ini`,
> **no** `GF_*` variables, and **no** change to `app_mode` were used. This is the default,
> canonical OSS configuration. The three runs referenced throughout this document all use this
> exact command, varying only the data directory: **run 1** (first run) and **run 2** (subsequent
> run) share `/tmp/gf-cap/A`, while **run 3** (a second, independent first run used for the
> stability check) uses a fresh `/tmp/gf-cap/B`.

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
logger=settings t=2026-07-06T23:22:41.791665161Z level=info msg="Starting Grafana" version=9.2.0 commit=NA branch=main compiled=2026-07-06T23:22:41Z
logger=settings t=2026-07-06T23:22:41.791972398Z level=info msg="Config loaded from" file=/tmp/blitzy/grafana/blitzy-dc74cc50-4c41-4fe8-8bd2-75a8df865634_4216d2/conf/defaults.ini
logger=settings t=2026-07-06T23:22:41.791983742Z level=info msg="Config overridden from command line" arg="paths.data=/tmp/gf-cap/A/data"
logger=settings t=2026-07-06T23:22:41.791988343Z level=info msg="Config overridden from command line" arg="paths.logs=/tmp/gf-cap/A/log"
logger=settings t=2026-07-06T23:22:41.791995738Z level=info msg=Target target=[all]
logger=settings t=2026-07-06T23:22:41.792003224Z level=info msg="Path Home" path=/tmp/blitzy/grafana/blitzy-dc74cc50-4c41-4fe8-8bd2-75a8df865634_4216d2
logger=settings t=2026-07-06T23:22:41.792007934Z level=info msg="Path Data" path=/tmp/gf-cap/A/data
logger=settings t=2026-07-06T23:22:41.792011961Z level=info msg="Path Logs" path=/tmp/gf-cap/A/log
logger=settings t=2026-07-06T23:22:41.792015965Z level=info msg="Path Plugins" path=/tmp/blitzy/grafana/blitzy-dc74cc50-4c41-4fe8-8bd2-75a8df865634_4216d2/data/plugins
logger=settings t=2026-07-06T23:22:41.792025253Z level=info msg="Path Provisioning" path=/tmp/blitzy/grafana/blitzy-dc74cc50-4c41-4fe8-8bd2-75a8df865634_4216d2/conf/provisioning
logger=settings t=2026-07-06T23:22:41.792029782Z level=info msg="App mode production"
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
Date: Mon, 06 Jul 2026 23:22:47 GMT
Content-Length: 62

{
  "database": "ok",
  "version": "9.2.0",
  "commit": "NA"
}
```

The `[database]` defaults are confirmed by the DB actually created (SQLite, file `grafana.db`):

```text
logger=sqlstore t=2026-07-06T23:22:41.792495101Z level=info msg="Connecting to DB" dbtype=sqlite3
logger=sqlstore t=2026-07-06T23:22:41.792504024Z level=info msg="Creating SQLite database file" path=/tmp/gf-cap/A/data/grafana.db
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
- The override steps are sequenced inside `loadConfiguration` (`pkg/setting/setting.go:L881`),
  which `Cfg.Load` (`pkg/setting/setting.go:L1046`) invokes. Reading that function top-to-bottom
  gives the exact precedence, with two **distinct** command-line handlers that must not be
  conflated:
  1. `cfg:default.*` arguments via `applyCommandLineDefaultProperties`
     (called at `pkg/setting/setting.go:L903`; defined at `pkg/setting/setting.go:L781`). This
     handler builds its lookup key as `default.<section>.<key>`
     (`pkg/setting/setting.go:L785`), so it matches **only** `cfg:default.*` arguments. It runs
     **before** `custom.ini`, seeding *defaults* that every later tier may still override.
  2. `conf/custom.ini` via `loadSpecifiedConfigFile` (called at `pkg/setting/setting.go:L906`).
  3. `GF_*` environment variables via `applyEnvVariableOverrides`
     (called at `pkg/setting/setting.go:L917`; defined at `pkg/setting/setting.go:L666`).
  4. Ordinary `cfg:` command-line properties via `applyCommandLineProperties`
     (called at `pkg/setting/setting.go:L923`; defined at `pkg/setting/setting.go:L796`) —
     applied **last**, so `cfg:` wins. Unlike step 1, it keys on the bare `<section>.<key>`
     (`pkg/setting/setting.go:L803`), and it is this handler — **not**
     `applyCommandLineDefaultProperties` — that consumes my `cfg:paths.data=…` /
     `cfg:paths.logs=…` arguments. The observed startup lines
     `msg="Config overridden from command line" arg="paths.data=/tmp/gf-cap/A/data"` are emitted
     at `pkg/setting/setting.go:L1441` while iterating `cfg.appliedCommandLineProperties`, the
     slice this handler appends to (`pkg/setting/setting.go:L806`) — direct proof the ordinary
     `cfg:` path, not the `cfg:default.*` path, was exercised.
  So the full precedence is `defaults.ini < cfg:default.* < custom.ini < GF_* < cfg:` — each tier
  overrides the ones before it. The common four-tier summary
  `defaults.ini < custom.ini < GF_* < cfg:` is this same ordering with the rarely-used
  `cfg:default.*` seeding tier omitted.
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

The complete first‑run startup log was captured by redirecting the real `server` subcommand to a
file. The exact command (from the reusable capture harness `start_server` in `/tmp/gf-scripts/lib.sh`)
was:

```text
$ setsid bash -c "exec go run ./pkg/cmd/grafana server \\
    --homepath '/tmp/blitzy/grafana/blitzy-dc74cc50-4c41-4fe8-8bd2-75a8df865634_4216d2' \\
    cfg:paths.data='/tmp/gf-cap/A/data' cfg:paths.logs='/tmp/gf-cap/A/log' \\
    > /tmp/gf-scripts/out/run1_startup.log 2>&1" &
```

The captured log is **1357 lines**. The overwhelming majority are the schema migrator's
per‑migration output (which belongs to O3); the two migration loggers alone account for 1296 of
the 1357 lines:

```text
$ wc -l < run1_startup.log
1357
$ grep -c "logger=migrator " run1_startup.log
1256
$ grep -c "logger=resource-migrator " run1_startup.log
40
```

Filtering out only those two migration loggers, the **complete** background‑service startup
region — from the first service line after the database is created (`logger=secrets`, line 1274)
through the last autonomous startup line (`logger=plugin.backgroundinstaller`, line 1351,
immediately before my own API probe at line 1352) — is reproduced below **unedited**:

```text
$ sed -n '1274,1351p' run1_startup.log | grep -vE "logger=(migrator|resource-migrator)"
logger=secrets t=2026-07-06T23:22:43.561678769Z level=info msg="Envelope encryption state" enabled=true currentprovider=secretKey.v1
logger=renderer.manager t=2026-07-06T23:22:43.613364688Z level=error msg="Failed to get renderer plugin sources" error="failed to open plugins path"
logger=plugin.angulardetectorsprovider.dynamic t=2026-07-06T23:22:43.613705178Z level=info msg="Restored cache from database" duration=255.892µs
logger=plugin.store t=2026-07-06T23:22:43.614353607Z level=info msg="Loading plugins..."
logger=plugin.sources t=2026-07-06T23:22:43.614385858Z level=error msg="Failed to load external plugins" error="failed to open plugins path"
logger=plugin.store t=2026-07-06T23:22:43.644695236Z level=info msg="Plugins loaded" count=54 duration=30.342072ms
logger=query_data t=2026-07-06T23:22:43.648396803Z level=info msg="Query Service initialization"
logger=live.push_http t=2026-07-06T23:22:43.652337695Z level=info msg="Live Push Gateway initialization"
logger=ngalert.notifier.alertmanager org=1 t=2026-07-06T23:22:43.65473479Z level=info msg="Applying new configuration to Alertmanager" configHash=d2c56faca6af2a5772ff4253222f7386
logger=ngalert.state.manager t=2026-07-06T23:22:43.69971704Z level=info msg="Running in alternative execution of Error/NoData mode"
logger=infra.usagestats.collector t=2026-07-06T23:22:43.753374853Z level=info msg="registering usage stat providers" usageStatsProvidersLen=2
logger=provisioning.alerting t=2026-07-06T23:22:43.754192561Z level=info msg="starting to provision alerting"
logger=provisioning.alerting t=2026-07-06T23:22:43.754210038Z level=info msg="finished to provision alerting"
logger=grafanaStorageLogger t=2026-07-06T23:22:43.754451136Z level=info msg="Storage starting"
logger=renderer.manager t=2026-07-06T23:22:43.754541887Z level=error msg="Failed to get renderer plugin sources" error="failed to open plugins path"
logger=plugin.backgroundinstaller t=2026-07-06T23:22:43.754545313Z level=info msg="Installing plugin" pluginId=grafana-lokiexplore-app version=
logger=ngalert.state.manager t=2026-07-06T23:22:43.75453455Z level=info msg="Warming state cache for startup"
logger=ngalert.multiorg.alertmanager t=2026-07-06T23:22:43.754599489Z level=info msg="Starting MultiOrg Alertmanager"
logger=http.server t=2026-07-06T23:22:43.756076886Z level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=
logger=plugins.update.checker t=2026-07-06T23:22:43.790866819Z level=info msg="Update check succeeded" duration=36.331011ms
logger=provisioning.dashboard t=2026-07-06T23:22:43.793193341Z level=info msg="starting to provision dashboards"
logger=provisioning.dashboard t=2026-07-06T23:22:43.793213225Z level=info msg="finished to provision dashboards"
logger=ngalert.state.manager t=2026-07-06T23:22:43.793728118Z level=info msg="State cache has been initialized" states=0 duration=39.192072ms
logger=ngalert.scheduler t=2026-07-06T23:22:43.793761273Z level=info msg="Starting scheduler" tickInterval=10s maxAttempts=3
logger=ticker t=2026-07-06T23:22:43.793805171Z level=info msg=starting first_tick=2026-07-06T23:22:50Z
logger=grafana.update.checker t=2026-07-06T23:22:43.795651418Z level=info msg="Update check succeeded" duration=41.138291ms
logger=plugin.angulardetectorsprovider.dynamic t=2026-07-06T23:22:43.803754889Z level=info msg="Patterns update finished" duration=48.861175ms
logger=grafana-apiserver t=2026-07-06T23:22:44.097915212Z level=info msg="Adding GroupVersion playlist.grafana.app v0alpha1 to ResourceManager"
logger=resource-server t=2026-07-06T23:22:44.098038089Z level=warn msg="failed to register storage metrics" error="duplicate metrics collector registration attempted"
logger=resource-server t=2026-07-06T23:22:44.098130947Z level=warn msg="failed to register storage metrics" error="duplicate metrics collector registration attempted"
logger=resource-server t=2026-07-06T23:22:44.098165555Z level=warn msg="failed to register storage metrics" error="duplicate metrics collector registration attempted"
logger=grafana-apiserver t=2026-07-06T23:22:44.099661497Z level=info msg="Adding GroupVersion dashboard.grafana.app v0alpha1 to ResourceManager"
logger=grafana-apiserver t=2026-07-06T23:22:44.100248651Z level=info msg="Adding GroupVersion dashboard.grafana.app v1alpha1 to ResourceManager"
logger=grafana-apiserver t=2026-07-06T23:22:44.100788996Z level=info msg="Adding GroupVersion dashboard.grafana.app v2alpha1 to ResourceManager"
logger=grafana-apiserver t=2026-07-06T23:22:44.101258646Z level=info msg="Adding GroupVersion featuretoggle.grafana.app v0alpha1 to ResourceManager"
logger=grafana-apiserver t=2026-07-06T23:22:44.102719855Z level=info msg="Adding GroupVersion iam.grafana.app v0alpha1 to ResourceManager"
logger=app-registry t=2026-07-06T23:22:44.125152692Z level=info msg="app registry initialized"
logger=plugin.backgroundinstaller t=2026-07-06T23:22:44.166771409Z level=error msg="Failed to install plugin" pluginId=grafana-lokiexplore-app version= error="[plugin.grafanaVersionNotCompatible] grafana-lokiexplore-app is not compatible with your Grafana version: 9.2.0"
```

Every line above is a service that **was started** and logged its own status: readiness lines
(`Envelope encryption state ... enabled=true`, `Plugins loaded count=54`,
`HTTP Server Listen address=[::]:3000`, `app registry initialized`, `Starting scheduler`,
`Starting MultiOrg Alertmanager`) **and** error/warn lines from services that started but found
nothing on disk to act on (`renderer.manager ... Failed to get renderer plugin sources`,
`plugin.sources ... Failed to load external plugins`, `resource-server ... failed to register
storage metrics`). None of these needed any configuration from the user — they are the
default‑enabled services launching themselves.

Now the other half of the asymmetry — the services that were **disabled**. Searching the entire
log for any disabled/skip wording (excluding the migrator's own per‑migration `skipped=`
counters) returns **zero** matches:

```text
$ grep -niE "disabled|skipping|skipped|not enabled" run1_startup.log | grep -vE "logger=(migrator|resource-migrator)"
$
```

That empty result is the whole point: **a background service that is disabled emits no log line
at all.** That is precisely why the new team member saw explicit “success/started” lines for
some subsystems and complete silence for others — not randomness, but the registry gating each
service on whether it is enabled.

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

**Before the first run** the target data directory does not yet exist, so it contains zero files. Demonstrated on a freshly‑created directory (the state `/tmp/gf-cap/A` was in before its first run — the `find` prints nothing and the count is `0`):

```text
$ find /tmp/gf-cap/FRESH -type f | sort
$ find /tmp/gf-cap/FRESH -type f | wc -l
0
```

**After the first run**, exactly two files exist — the SQLite database and the log file (no PID file, since `--pidfile` was not given). Grafana also created the empty `csv/`, `pdf/`, and `png/` sub‑directories for its CSV/PDF/PNG export features:

```text
$ find /tmp/gf-cap/A -type f | sort
/tmp/gf-cap/A/data/grafana.db
/tmp/gf-cap/A/log/grafana.log
$ ls -la /tmp/gf-cap/A/data
total 1092
drwxr-x--- 5 root root    4096 Jul  6 23:22 .
drwxr-xr-x 4 root root    4096 Jul  6 23:22 ..
drwx------ 2 root root    4096 Jul  6 23:22 csv
-rw-r----- 1 root root 1093632 Jul  6 23:22 grafana.db
drwx------ 2 root root    4096 Jul  6 23:22 pdf
drwx------ 2 root root    4096 Jul  6 23:22 png
```

Querying the fresh database directly with `sqlite3` (run from the data directory) shows the full schema, the single created admin user, and the single created organization:

```text
$ sqlite3 grafana.db ".tables"
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

```text
$ sqlite3 grafana.db -header -column "SELECT id,login,email,is_admin FROM user;"
id  login  email            is_admin
--  -----  ---------------  --------
1   admin  admin@localhost  1       
```

```text
$ sqlite3 grafana.db -header -column "SELECT id,name FROM org;"
id  name     
--  ---------
1   Main Org.
```

```text
$ sqlite3 grafana.db "SELECT COUNT(*) FROM user;"
1
$ sqlite3 grafana.db "SELECT COUNT(*) FROM migration_log;"
626
```

The 626 `migration_log` rows match the startup line `migrations completed performed=626 skipped=0`. A sample of the earliest migrations:

```text
$ sqlite3 grafana.db -header -column "SELECT migration_id FROM migration_log ORDER BY id LIMIT 6;"
migration_id                  
------------------------------
create migration_log table    
create user table             
add unique index user.login   
add unique index user.email   
drop index UQE_user_login - v1
drop index UQE_user_email - v1
```

**Second run against the SAME data directory** — the differences are decisive. First, the database file is **not** re‑created: the `Creating SQLite database file` line is present on run 1 (line 15) but absent on run 2 (grep prints nothing):

```text
$ grep -n "Creating SQLite database file" run1_startup.log
15:logger=sqlstore t=2026-07-06T23:22:41.792504024Z level=info msg="Creating SQLite database file" path=/tmp/gf-cap/A/data/grafana.db
$ grep -n "Creating SQLite database file" run2_startup.log
```

Second, the migrator finds every migration already applied and performs none (`performed=0 skipped=626`):

```text
17:logger=migrator t=2026-07-06T23:23:34.116486736Z level=info msg="migrations completed" performed=0 skipped=626 duration=744.053µs
31:logger=resource-migrator t=2026-07-06T23:23:34.315846007Z level=info msg="migrations completed" performed=0 skipped=18 duration=56.901µs
```

Third, **neither** `Created default admin` **nor** `Created default organization` is logged — `grep -c` returns `0` and `grep -n` prints no lines at all:

```text
$ grep -c "Created default admin\|Created default organization" run2_startup.log
0
$ grep -n "Created default admin\|Created default organization" run2_startup.log
```

The server nevertheless starts and listens exactly as before:

```text
$ grep -n "HTTP Server Listen" run2_startup.log
44:logger=http.server t=2026-07-06T23:23:34.320303837Z level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=
```

The filesystem is unchanged — the same two files, nothing added:

```text
$ find /tmp/gf-cap/A -type f | sort
/tmp/gf-cap/A/data/grafana.db
/tmp/gf-cap/A/log/grafana.log
```

And the database is unchanged: still exactly one user, whose `created` timestamp is **identical** to the first run (`2026-07-06 23:22:43`), proving the admin row was **not** re‑created:

```text
$ sqlite3 grafana.db -header -column "SELECT id,login,email,is_admin,created FROM user;"
id  login  email            is_admin  created            
--  -----  ---------------  --------  -------------------
1   admin  admin@localhost  1         2026-07-06 23:22:43
```

**Stability across independent fresh runs** — repeating the first‑run scenario in a **different** empty directory (`/tmp/gf-cap/B`) reproduces the creation deterministically. The creation lines appear again:

```text
$ grep -n "Created default admin\|Created default organization" run3_startup.log
1272:logger=sqlstore t=2026-07-06T23:24:12.783717708Z level=info msg="Created default admin" user=admin
1273:logger=sqlstore t=2026-07-06T23:24:12.78381621Z level=info msg="Created default organization"
```

The migrator performs all 626 migrations again against the fresh database (`performed=626 skipped=0`):

```text
1270:logger=migrator t=2026-07-06T23:24:12.778255349Z level=info msg="migrations completed" performed=626 skipped=0 duration=1.706232879s
1322:logger=resource-migrator t=2026-07-06T23:24:12.970477204Z level=info msg="migrations completed" performed=18 skipped=0 duration=46.399837ms
```

And the new admin row carries a **new, distinct** `created` timestamp (`2026-07-06 23:24:12`) — different from the first run's `23:22:43` — confirming a genuine fresh creation rather than reuse of the earlier row:

```text
$ sqlite3 grafana.db -header -column "SELECT id,login,email,is_admin,created FROM user;"
id  login  email            is_admin  created            
--  -----  ---------------  --------  -------------------
1   admin  admin@localhost  1         2026-07-06 23:24:12
```

```text
$ sqlite3 grafana.db -header -column "SELECT id,name FROM org;"
id  name     
--  ---------
1   Main Org.
```

This confirms the behavior is stable across at least two independent fresh‑start runs (directory `A` created its admin at `23:22:43`; directory `B` at `23:24:12`): a clean data directory **always** yields the admin/org creation, while a populated one **never** does.

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
| `[auth] disable_login_form` | `false` | `:L576` |
| `[auth.anonymous] enabled` | `false` | `:L648` / `:L650` |

### O4 · Evidence

**(1) The admin account is created on first run** — captured directly from the startup log:

```text
logger=sqlstore t=2026-07-06T23:22:43.559037609Z level=info msg="Created default admin" user=admin
logger=sqlstore t=2026-07-06T23:22:43.559145667Z level=info msg="Created default organization"
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
Date: Mon, 06 Jul 2026 23:22:47 GMT
Content-Length: 102

{"extra":null,"message":"Unauthorized","messageId":"auth.unauthorized","statusCode":401,"traceID":""}
```

The server’s own request log confirms the rejection reason:

```text
logger=context userId=0 orgId=0 uname= t=2026-07-06T23:22:47.674561777Z level=info msg="Request Completed" method=GET path=/api/user status=401 remote_addr=127.0.0.1 time_ms=0 duration=82µs size=102 referer= handler=/api/user/ status_source=server errorReason=Unauthorized errorMessageID=auth.unauthorized error="cannot authenticate request"
```

**(3) The default credentials really work** — logging in with `admin`/`admin` succeeds and
yields a session, and the authenticated call returns the admin identity:

```bash
$ curl -sS -i -c /tmp/gf-scripts/cookies.txt -H 'Content-Type: application/json' -d '{"user":"admin","password":"admin"}' http://localhost:3000/login
```

```text
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
Set-Cookie: grafana_session=fa0d6c3ae600c720db307604c7ad0fce; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax
Set-Cookie: grafana_session_expiry=1783380762; Path=/; Max-Age=2592000; SameSite=Lax
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Mon, 06 Jul 2026 23:22:47 GMT
Content-Length: 41

{"message":"Logged in","redirectUrl":"/"}
```

> **On the `grafana_session` cookie (observed above).** The cookie jar is written to the throwaway
> path `/tmp/gf-scripts/cookies.txt` (deleted at the end of the investigation — the repository
> working tree is never touched). The `grafana_session` value
> (`fa0d6c3ae600c720db307604c7ad0fce` here) is an **ephemeral, per-session token** minted fresh on
> each successful login, so its exact bytes differ from run to run and carry no meaning across
> runs; it is **not** a stored credential. The only stored credential is the `admin`/`admin`
> password hash seeded in the `user` table. The `HttpOnly`/`SameSite=Lax` flags and the
> `Max-Age=2592000` (30-day) lifetime are the defaults for the session token.

```bash
$ curl -sS -i -b /tmp/gf-scripts/cookies.txt http://localhost:3000/api/user
```

```text
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Mon, 06 Jul 2026 23:22:47 GMT
Content-Length: 371

{"id":1,"uid":"ffrc4d2o068e8d","email":"admin@localhost","name":"","login":"admin","theme":"","orgId":1,"isGrafanaAdmin":true,"isDisabled":false,"isExternal":false,"isExternallySynced":false,"isGrafanaAdminExternallySynced":false,"authLabels":[],"updatedAt":"2026-07-06T23:22:43Z","createdAt":"2026-07-06T23:22:43Z","avatarUrl":"/avatar/46d229b033af06a191ff2267bca9ae56"}
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
  (`pkg/services/authn/authnimpl/registration.go:L74-L75`), and the form (login-page) client is
  registered unless the login form is disabled — `if !cfg.DisableLoginForm { … ProvideForm(…) }`
  (`pkg/services/authn/authnimpl/registration.go:L78-L79`). The login form is **on by default**
  because `disable_login_form = false` sits in the `[auth]` section (`conf/defaults.ini:L576`),
  bound as `cfg.DisableLoginForm = auth.Key("disable_login_form").MustBool(false)`
  (`pkg/setting/setting.go:L1615`). `cfg.BasicAuthEnabled` binds from `[auth.basic] enabled` with a
  default of `true` (`cfg.BasicAuthEnabled = authBasic.Key("enabled").MustBool(true)`,
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
   default toggle states are compiled from a **generated, embedded manifest** `toggles_gen.json`
   (**253** flags in total). On a clean start, **56 toggles are enabled at runtime** — the exact
   set printed on the single `FeatureToggles` startup line, equal to the 56 flags whose
   `Expression` is `"true"` in the compiled `standardFeatureFlags`. The frontend is handed
   **57** of them: those 56 **plus `topnav`**, which the settings handler force‑adds. Every other
   flag is **opt‑in (default OFF)**. (The generated manifest separately marks **62** flags
   `spec.expression: "true"`; the 56 runtime‑enabled flags are a strict subset of those 62 — the
   exact reconciliation is shown in the Evidence below.)

Two analytics/update behaviors are **on by default** and were observed running:
`reporting_enabled = true` (`conf/defaults.ini:L258`) and `check_for_updates = true`
(`conf/defaults.ini:L268`).

### O5 · Evidence

The **runtime‑enabled** feature set is the single `FeatureToggles` line emitted at startup (`pkg/services/featuremgmt/service.go:L70`). It lists **56** toggles, all `=true` — this is the complete, unedited line (line 13 of the first‑run log):

```text
$ grep -n "msg=FeatureToggles " run1_startup.log
13:logger=featuremgmt t=2026-07-06T23:22:41.792393105Z level=info msg=FeatureToggles annotationPermissionUpdate=true managedPluginsInstall=true dashboardSceneForViewers=true panelMonitoring=true publicDashboardsScene=true influxdbBackendMigration=true prometheusConfigOverhaulAuth=true recoveryThreshold=true zipkinBackendMigration=true newDashboardSharingComponent=true logsExploreTableVisualisation=true dashboardSceneSolo=true cloudWatchRoundUpEndTime=true logsContextDatasourceUi=true unifiedRequestLog=true preinstallAutoUpdate=true ssoSettingsApi=true exploreMetrics=true accessControlOnCall=true accessActionSets=true alertingNoDataErrorExecution=true angularDeprecationUI=true cloudwatchMetricInsightsCrossAccount=true groupToNestedTableTransformation=true dashgpt=true cloudWatchCrossAccountQuerying=true azureMonitorEnableUserAuth=true promQLScope=true tlsMemcached=true openSearchBackendFlowEnabled=true alertingInsights=true recordedQueriesMulti=true singleTopNav=true transformationsVariableSupport=true alertingUIOptimizeReducer=true lokiQueryHints=true logRowsPopoverMenu=true dataplaneFrontendFallback=true notificationBanner=true logsInfiniteScrolling=true nestedFolders=true alertingSimplifiedRouting=true dashboardScene=true kubernetesPlaylists=true pinNavItems=true lokiStructuredMetadata=true newFiltersUI=true correlations=true addFieldFromCalculationStatFunctions=true transformationsRedesign=true formatString=true prometheusMetricEncyclopedia=true lokiQuerySplitting=true awsAsyncQueryCaching=true prometheusAzureOverrideAudience=true cloudWatchNewLabelParsing=true
```

Counting the `=true` tokens on that line confirms **56**:

```text
$ grep -oE 'msg=FeatureToggles .*' run1_startup.log | grep -oE '[A-Za-z0-9]+=true' | wc -l
56
```

The **frontend‑exposed** set, taken directly from the 28,641‑byte `/api/frontend/settings` response, is **57** — exactly the 56 runtime toggles **plus `topnav`**. The full, sorted key list (extracted deterministically with `python3`) is reproduced complete below:

```text
$ python3 -c "import json; ft=json.load(open('run1_frontend_settings.json'))['featureToggles']; print('featureToggles_count=%d all_true=%s'%(len(ft),all(ft.values())))"
featureToggles_count=57 all_true=True
$ python3 -c "import json; ft=json.load(open('run1_frontend_settings.json'))['featureToggles']; [print(k) for k in sorted(ft)]"
accessActionSets
accessControlOnCall
addFieldFromCalculationStatFunctions
alertingInsights
alertingNoDataErrorExecution
alertingSimplifiedRouting
alertingUIOptimizeReducer
angularDeprecationUI
annotationPermissionUpdate
awsAsyncQueryCaching
azureMonitorEnableUserAuth
cloudWatchCrossAccountQuerying
cloudWatchNewLabelParsing
cloudWatchRoundUpEndTime
cloudwatchMetricInsightsCrossAccount
correlations
dashboardScene
dashboardSceneForViewers
dashboardSceneSolo
dashgpt
dataplaneFrontendFallback
exploreMetrics
formatString
groupToNestedTableTransformation
influxdbBackendMigration
kubernetesPlaylists
logRowsPopoverMenu
logsContextDatasourceUi
logsExploreTableVisualisation
logsInfiniteScrolling
lokiQueryHints
lokiQuerySplitting
lokiStructuredMetadata
managedPluginsInstall
nestedFolders
newDashboardSharingComponent
newFiltersUI
notificationBanner
openSearchBackendFlowEnabled
panelMonitoring
pinNavItems
preinstallAutoUpdate
promQLScope
prometheusAzureOverrideAudience
prometheusConfigOverhaulAuth
prometheusMetricEncyclopedia
publicDashboardsScene
recordedQueriesMulti
recoveryThreshold
singleTopNav
ssoSettingsApi
tlsMemcached
topnav
transformationsRedesign
transformationsVariableSupport
unifiedRequestLog
zipkinBackendMigration
```

The same response carries the build/analytics state — `version=9.2.0`, `commit=NA`, `env=production`, `edition=Open Source`, and both `reporting` and `analytics` with `enabled=true`:

```text
$ python3 -c "import json; d=json.load(open('run1_frontend_settings.json')); b=d['buildInfo']; print('version=%s commit=%s env=%s edition=%s'%(b['version'],b['commit'],b['env'],b['edition'])); print('reporting=',d['reporting']); print('analytics=',d['analytics'])"
version=9.2.0 commit=NA env=production edition=Open Source
reporting= {'enabled': True}
analytics= {'enabled': True}
```

**Reconciling all counts** against the run‑1 captures and the repository sources (`registry.go`, `toggles_gen.json`) — the numbers close exactly. The 56 runtime toggles equal the 56 `Expression: "true"` entries in the compiled `standardFeatureFlags`; the frontend adds only `topnav` (57); and the 56 runtime toggles are a **strict subset** of the 62 flags the generated manifest marks `expression: "true"` — the 6 remaining manifest flags (5 GA flags plus the deprecated `topnav`) are simply not emitted in the runtime‑enabled set:

```text
$ python3 o5_recon.py   # reads run1 captures + repo registry.go/toggles_gen.json
startup_enabled   = 56
frontend_exposed  = 57
frontend - startup = ['topnav']
startup - frontend = []
manifest_total     = 253
manifest_expr_true = 62
registry_expr_true = 56
startup subset of manifest_expr_true : True
manifest_expr_true - startup = ['autoMigrateXYChartPanel', 'awsDatasourcesNewFormStyling', 'lokiMetricDataplane', 'prometheusDataplane', 'publicDashboards', 'topnav']
```

**Analytics/update‑check defaults are live** — both update checkers ran on startup (the observed effect of `check_for_updates = true`):

```text
$ grep -nE 'logger=(plugins|grafana)\.update\.checker' run1_startup.log
1333:logger=plugins.update.checker t=2026-07-06T23:22:43.790866819Z level=info msg="Update check succeeded" duration=36.331011ms
1339:logger=grafana.update.checker t=2026-07-06T23:22:43.795651418Z level=info msg="Update check succeeded" duration=41.138291ms
```

### O5 · Causal explanation

- The default feature‑toggle state is not hand‑written at runtime; the runtime set comes from the
  compiled Go slice `standardFeatureFlags`, and a parallel **generated manifest is embedded into
  the binary**. In `pkg/services/featuremgmt/registry.go` the manifest is embedded with
  `//go:embed toggles_gen.json` (`pkg/services/featuremgmt/registry.go:L1695`) into
  `var f embed.FS` (`pkg/services/featuremgmt/registry.go:L1696`), and read via
  `f.ReadFile("toggles_gen.json")` (`pkg/services/featuremgmt/registry.go:L1701`). At runtime a
  flag is enabled when its `Expression` is `"true"`; there are exactly **56** such entries in
  `standardFeatureFlags`, which is why the single `FeatureToggles` line — emitted by
  `mgmt.log.Info("FeatureToggles", …)` at `pkg/services/featuremgmt/service.go:L70` — lists 56
  toggles, and every other flag is opt‑in.
- The frontend receives **one extra** toggle: `pkg/api/frontendsettings.go:L182` unconditionally
  sets `featureToggles["topnav"] = true`, so `/api/frontend/settings` reports **57**. The
  generated `toggles_gen.json` separately marks **62** flags `spec.expression: "true"`; the 56
  runtime‑enabled flags are a **strict subset** of those 62 — the 6 extra manifest flags (5 GA
  flags plus the deprecated `topnav`) are not part of the compiled runtime‑enabled set, so they
  never appear on the startup line.
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
backend data sources**. The plugins the new team member sees “without installing anything” are
**core plugins compiled and shipped inside the binary/`public` tree**, not downloads — so
**nothing the user sees was fetched remotely**. That is *not*, however, the same as “no network
activity on startup”: on a clean start Grafana still contacts `grafana.com` for **two update
checks** and for a background **preinstall attempt** of `grafana-lokiexplore-app` (a
default‑preinstall plugin), which **fails** on this unstamped `9.2.0` build — both observed in
the Evidence below. The three source classes that populate the *visible* plugin set are:

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

**Core plugins present without any install** — the authenticated `/api/plugins` call returns HTTP 200 with a 38,720‑byte body (sent chunked):

```text
$ curl -sS -i -b /tmp/gf-scripts/cookies.txt http://localhost:3000/api/plugins | sed -n "1,9p"
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Mon, 06 Jul 2026 23:22:47 GMT
Transfer-Encoding: chunked

```

Extracting every entry from that captured body deterministically shows **49** plugins (30 panel + 19 datasource), and **every one** is signed `internal` (complete enumeration):

```text
$ python3 o6_enum.py   # run from /tmp/gf-scripts/out (dir holding the captured body)
49 plugins total
datasource alertmanager                             internal
datasource cloudwatch                               internal
datasource elasticsearch                            internal
datasource grafana-azure-monitor-datasource         internal
datasource grafana-postgresql-datasource            internal
datasource grafana-pyroscope-datasource             internal
datasource grafana-testdata-datasource              internal
datasource graphite                                 internal
datasource influxdb                                 internal
datasource jaeger                                   internal
datasource loki                                     internal
datasource mssql                                    internal
datasource mysql                                    internal
datasource opentsdb                                 internal
datasource parca                                    internal
datasource prometheus                               internal
datasource stackdriver                              internal
datasource tempo                                    internal
datasource zipkin                                   internal
panel      alertlist                                internal
panel      annolist                                 internal
panel      barchart                                 internal
panel      bargauge                                 internal
panel      candlestick                              internal
panel      canvas                                   internal
panel      dashlist                                 internal
panel      datagrid                                 internal
panel      flamegraph                               internal
panel      gauge                                    internal
panel      geomap                                   internal
panel      gettingstarted                           internal
panel      graph                                    internal
panel      heatmap                                  internal
panel      histogram                                internal
panel      logs                                     internal
panel      news                                     internal
panel      nodeGraph                                internal
panel      piechart                                 internal
panel      stat                                     internal
panel      state-timeline                           internal
panel      status-history                           internal
panel      table                                    internal
panel      table-old                                internal
panel      text                                     internal
panel      timeseries                               internal
panel      traces                                   internal
panel      trend                                    internal
panel      welcome                                  internal
panel      xychart                                  internal
```

One complete, unedited element from the returned array (the `prometheus` data source) shows the actual object shape, including `"signature": "internal"` and `"type": "datasource"`:

```text
$ python3 o6_one.py   # one complete /api/plugins element, unedited
{
  "angularDetected": false,
  "category": "tsdb",
  "defaultNavUrl": "/plugins/prometheus/",
  "dependencies": {
    "extensions": {
      "exposedComponents": []
    },
    "grafanaDependency": "",
    "grafanaVersion": "*",
    "plugins": []
  },
  "enabled": true,
  "hasUpdate": false,
  "id": "prometheus",
  "info": {
    "author": {
      "name": "Grafana Labs",
      "url": "https://grafana.com"
    },
    "build": {},
    "description": "Open source time series database & alerting",
    "keywords": null,
    "links": [
      {
        "name": "Learn more",
        "url": "https://prometheus.io/"
      }
    ],
    "logos": {
      "large": "public/app/plugins/datasource/prometheus/img/prometheus_logo.svg",
      "small": "public/app/plugins/datasource/prometheus/img/prometheus_logo.svg"
    },
    "screenshots": null,
    "updated": "",
    "version": ""
  },
  "latestVersion": "",
  "name": "Prometheus",
  "pinned": false,
  "signature": "internal",
  "signatureOrg": "",
  "signatureType": "",
  "state": "",
  "type": "datasource"
}
```

**No data sources are provisioned** — `/api/datasources` is an empty array (`Content-Length: 2`):

```text
$ curl -sS -i -b /tmp/gf-scripts/cookies.txt http://localhost:3000/api/datasources
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Mon, 06 Jul 2026 23:22:47 GMT
Content-Length: 2

[]
```

**Startup plugin lifecycle** — the store loads plugins in‑memory; external discovery fails because `<data>/plugins` does not exist; and the loaded count (**54**) exceeds the 49 the default `/api/plugins` listing returns (the 5‑plugin delta is the alpha‑state and built‑in plugins the default listing filters out):

```text
$ grep -nE "logger=plugin\.(store|sources) " run1_startup.log
1277:logger=plugin.store t=2026-07-06T23:22:43.614353607Z level=info msg="Loading plugins..."
1278:logger=plugin.sources t=2026-07-06T23:22:43.614385858Z level=error msg="Failed to load external plugins" error="failed to open plugins path"
1279:logger=plugin.store t=2026-07-06T23:22:43.644695236Z level=info msg="Plugins loaded" count=54 duration=30.342072ms
```

**Remote calls DO happen on a clean start.** This is the key correction to the naive “nothing is fetched remotely” reading: although every *registered/visible* plugin is compiled‑in (never downloaded), the server still reaches out to `grafana.com` on startup for **(a)** two update checks (`grafana.update.checker`, `plugins.update.checker`) and **(b)** a background **preinstall attempt** of `grafana-lokiexplore-app` (a default‑preinstall plugin) — which here **fails** because the unstamped `9.2.0` build is not compatible:

```text
$ grep -nE "Installing plugin|Update check succeeded|Failed to install plugin" run1_startup.log
1329:logger=plugin.backgroundinstaller t=2026-07-06T23:22:43.754545313Z level=info msg="Installing plugin" pluginId=grafana-lokiexplore-app version=
1333:logger=plugins.update.checker t=2026-07-06T23:22:43.790866819Z level=info msg="Update check succeeded" duration=36.331011ms
1339:logger=grafana.update.checker t=2026-07-06T23:22:43.795651418Z level=info msg="Update check succeeded" duration=41.138291ms
1351:logger=plugin.backgroundinstaller t=2026-07-06T23:22:44.166771409Z level=error msg="Failed to install plugin" pluginId=grafana-lokiexplore-app version= error="[plugin.grafanaVersionNotCompatible] grafana-lokiexplore-app is not compatible with your Grafana version: 9.2.0"
```

**Provisioning is a no‑op** — the provisioning directories ship only commented `sample.yaml` files, so alerting and dashboard provisioning start and finish instantly with nothing to load:

```text
$ grep -nE "logger=provisioning\.(alerting|dashboard) " run1_startup.log
1325:logger=provisioning.alerting t=2026-07-06T23:22:43.754192561Z level=info msg="starting to provision alerting"
1326:logger=provisioning.alerting t=2026-07-06T23:22:43.754210038Z level=info msg="finished to provision alerting"
1334:logger=provisioning.dashboard t=2026-07-06T23:22:43.793193341Z level=info msg="starting to provision dashboards"
1335:logger=provisioning.dashboard t=2026-07-06T23:22:43.793213225Z level=info msg="finished to provision dashboards"
```

The provisioning tree indeed contains only sample files (from the repository):

```text
$ find conf/provisioning -name "*.yaml" | sort
conf/provisioning/access-control/sample.yaml
conf/provisioning/alerting/sample.yaml
conf/provisioning/dashboards/sample.yaml
conf/provisioning/datasources/sample.yaml
conf/provisioning/plugins/sample.yaml
```

**The compiled core backend data sources** live in `pkg/tsdb/*` — exactly **19** directories (the `Magefile.go` build file is not a data source):

```text
$ find pkg/tsdb -maxdepth 1 -mindepth 1 -type d | sort
pkg/tsdb/azuremonitor
pkg/tsdb/cloud-monitoring
pkg/tsdb/cloudwatch
pkg/tsdb/elasticsearch
pkg/tsdb/grafana-postgresql-datasource
pkg/tsdb/grafana-pyroscope-datasource
pkg/tsdb/grafana-testdata-datasource
pkg/tsdb/grafanads
pkg/tsdb/graphite
pkg/tsdb/influxdb
pkg/tsdb/jaeger
pkg/tsdb/loki
pkg/tsdb/mssql
pkg/tsdb/mysql
pkg/tsdb/opentsdb
pkg/tsdb/parca
pkg/tsdb/prometheus
pkg/tsdb/tempo
pkg/tsdb/zipkin
$ find pkg/tsdb -maxdepth 1 -mindepth 1 -type d | wc -l
19
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
  plugins. **Every plugin the user sees is compiled‑in** — resolved from `ClassCore`/`ClassBundled`
  local sources above, never downloaded — which is why the catalog is populated on a clean start
  with an empty `data/plugins` directory.
- **However, "no plugin was downloaded" does not mean "no network I/O occurred."** Two subsystems
  reach out to `grafana.com` on a clean start, and both are observed in the RUN1 startup log above:
  - **Update checks** (`conf/defaults.ini:L268`, `check_for_updates = true`): the plugin and core
    update checkers each log `Update check succeeded` (RUN1 `run1_startup.log:L1333` and `L1339`).
    These are read‑only version queries; they install nothing.
  - **A background pre‑install attempt.** Grafana ships a default pre‑install list:
    `defaultPreinstallPlugins` (`pkg/setting/setting_plugins.go:L30`) contains a single entry,
    `"grafana-lokiexplore-app"` (`pkg/setting/setting_plugins.go:L32`). Pre‑install is enabled by
    default because `disablePreinstall` reads `MustBool(false)`
    (`pkg/setting/setting_plugins.go:L49`); the default entries are merged into the config in the
    loop at `pkg/setting/setting_plugins.go:L54-L56` and appended via
    `cfg.PreinstallPlugins = append(...)` (`pkg/setting/setting_plugins.go:L76-L78`). At startup the
    background‑installer service (`log.New("plugin.backgroundinstaller")`,
    `pkg/services/pluginsintegration/plugininstaller/service.go:L62`) drives `installPlugins`
    (`pkg/services/pluginsintegration/plugininstaller/service.go:L137`), which iterates
    `s.cfg.PreinstallPlugins`, logs `Installing plugin`
    (`pkg/services/pluginsintegration/plugininstaller/service.go:L160`), tags the request origin
    `ctx = repo.WithRequestOrigin(ctx, "preinstall")`
    (`pkg/services/pluginsintegration/plugininstaller/service.go:L162`), and calls
    `s.pluginInstaller.Add(ctx, installPlugin.ID, installPlugin.Version, compatOpts)`
    (`pkg/services/pluginsintegration/plugininstaller/service.go:L164`) — a **real fetch from the
    plugin repository**. On this unstamped `9.2.0` build the fetch is rejected as
    version‑incompatible, so the installer logs `Failed to install plugin`
    (`pkg/services/pluginsintegration/plugininstaller/service.go:L175`); RUN1 shows both the
    `Installing plugin pluginId=grafana-lokiexplore-app` line (`run1_startup.log:L1329`) and the
    terminal `Failed to install plugin … grafanaVersionNotCompatible … 9.2.0`
    (`run1_startup.log:L1351`).
  - **Net effect for the new team member:** the *populated plugin catalog* is 100% compiled‑in and
    involves no download, but a *clean default start is not network‑silent* — it performs two update
    checks and one (failed) pre‑install fetch against `grafana.com`. The earlier claim that the
    catalog is local is correct; the blanket phrase "nothing fetched remotely" would be wrong, and
    the observed remote calls above are the reason.


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

Both build artifacts are **generated and git‑ignored**, so a fresh checkout must produce them
before the server will build/serve correctly. Each is demonstrated below by moving it aside and
observing the failure, then restoring it (the working tree is left unchanged — see the
repo‑integrity check in the coverage summary).

**1. `wire_gen.go` (the generated Wire injector) — without it, `pkg/server` does not compile.**
`git check-ignore` confirms it is git‑ignored (build‑generated, not committed); with the file
moved aside `go build` fails with `undefined: Initialize`; `make gen-go` regenerates a
byte‑identical file (identical SHA‑256, empty `diff`), after which the build succeeds:

```text
$ git check-ignore pkg/server/wire_gen.go; echo "exit=$?"
pkg/server/wire_gen.go
exit=0
$ sha256sum pkg/server/wire_gen.go
87899e3ddd41801a8ea6815a48bd31d092777f4fa1d04bb34cef162a34aa6e79  pkg/server/wire_gen.go
$ mv pkg/server/wire_gen.go /tmp/gf-scripts/wire_gen.go.orig
$ ls pkg/server/wire_gen.go 2>&1; echo "exit=$?"
ls: cannot access 'pkg/server/wire_gen.go': No such file or directory
exit=2
$ go build -o /tmp/gf-scripts/grafana-nowire ./pkg/cmd/grafana 2>&1; echo "exit=$?"
# github.com/grafana/grafana/pkg/server
pkg/server/service.go:31:15: undefined: Initialize
exit=1
$ make gen-go 2>&1; echo "exit=$?"
generate go files
go run  ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server
wire: github.com/grafana/grafana/pkg/server: wrote /tmp/blitzy/grafana/blitzy-dc74cc50-4c41-4fe8-8bd2-75a8df865634_4216d2/pkg/server/wire_gen.go
exit=0
$ sha256sum pkg/server/wire_gen.go
87899e3ddd41801a8ea6815a48bd31d092777f4fa1d04bb34cef162a34aa6e79  pkg/server/wire_gen.go
$ diff /tmp/gf-scripts/wire_gen.go.orig pkg/server/wire_gen.go; echo "exit=$?"
exit=0
$ go build -o /tmp/gf-scripts/grafana-rewire ./pkg/cmd/grafana 2>&1; echo "exit=$?"
exit=0
```

**2. `public/build` (the built frontend assets) — without it, startup logs a validation error
but the server still listens (the check is non‑fatal).**
Moving `public/build` aside and starting the canonical `server` subcommand shows the
`Failed to detect generated javascript files in public/build` error near the top of the log,
yet `HTTP Server Listen` still appears and `/api/health` responds — proving a direct run without
a frontend build still starts (it simply serves no UI assets):

```text
$ git check-ignore public/build; echo "exit=$?"
public/build
exit=0
$ ls -d public/build && ls public/build | head -3
public/build
1085.a61b9c0e94a2dc6747cf.js
1085.a61b9c0e94a2dc6747cf.js.map
1100.d70d5d985a12c10474f2.js
$ mv public/build /tmp/gf-scripts/public_build_aside; echo "exit=$?"
exit=0
$ ls -d public/build 2>&1; echo "exit=$?"
ls: cannot access 'public/build': No such file or directory
exit=2
$ go run ./pkg/cmd/grafana server --homepath "$PWD" cfg:paths.data=/tmp/gf-cap/C/data cfg:paths.logs=/tmp/gf-cap/C/logs > o7_pb_startup_raw.log 2>&1 &
$ sed -n "2,3p" o7_pb_startup_raw.log
logger=settings t=2026-07-07T00:26:51.140092955Z level=info msg="Starting Grafana" version=9.2.0 commit=NA branch=main compiled=2026-07-07T00:26:51Z
logger=settings t=2026-07-07T00:26:51.140152165Z level=error msg="Failed to detect generated javascript files in public/build"
$ grep -n "HTTP Server Listen" o7_pb_startup_raw.log
1333:logger=http.server t=2026-07-07T00:26:53.149379203Z level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=
$ curl -s http://localhost:3000/api/health
{
  "database": "ok",
  "version": "9.2.0",
  "commit": "NA"
}
$ mv /tmp/gf-scripts/public_build_aside public/build; ls -d public/build
public/build
```

The same `public/build` directory is **produced by the frontend build** (`yarn build`, which
runs `webpack --config scripts/webpack/webpack.prod.js`, `package.json` `scripts.build`). Moving
it aside and rebuilding restores all 658 asset files — direct proof it is a build artifact, not
a committed one (the full log is 904 lines of webpack progress; the compile‑summary tail is
shown). This build was served largely from the warm NX/webpack cache, as the raw output states:

```text
$ mv public/build /tmp/gf-scripts/public_build_orig
$ ls -la public/build 2>&1; echo "exit=$?"
ls: cannot access 'public/build': No such file or directory
exit=2
$ NODE_ENV=production yarn build      # showing the tail; full log = 904 lines of webpack progress (ANSI stripped)
      app.f832742221a6bf16724b.js
  swagger (3.43 MiB)
      runtime.9037dc56b68a58593304.js
      6029.0549a3fcb50e73c4b256.js
      5001.5539502adf38f608859e.js
      1100.d70d5d985a12c10474f2.js
      7836.f17b7c631c5c78bd0765.js
      grafana.swagger.2733d417270d5dd49373.css
      swagger.0700b85beeebf6981fab.js

webpack 5.95.0 compiled with 2 warnings in 15339 ms



 NX   Successfully ran target build for project grafana and 12 tasks it depends on

Nx read the output from the cache instead of running the command for 11 out of 13 tasks.

$ ls public/build | wc -l
658
```

**3. Version stamping — an unstamped `go run` reports the fallback `9.2.0` (NON‑CANONICAL).**

```text
$ go run ./pkg/cmd/grafana --version
grafana version 9.2.0
```

The canonical first‑run startup banner shows the same unstamped identifiers
`commit=NA branch=main` (`commit=NA` is the compiled‑in fallback
`DefaultCommitValue = "NA"`, `pkg/cmd/grafana-cli/commands/cli.go:L14`):

```text
logger=settings t=2026-07-06T23:22:41.791665161Z level=info msg="Starting Grafana" version=9.2.0 commit=NA branch=main compiled=2026-07-06T23:22:41Z
```

**4. Runtime consequence of the unstamped version.** Because the reported version is the
fallback `9.2.0`, the default background pre‑install of `grafana-lokiexplore-app` is rejected by
the remote registry as version‑incompatible — observed verbatim in the canonical first run (the
same lines cited in O6):

```text
logger=plugin.backgroundinstaller t=2026-07-06T23:22:43.754545313Z level=info msg="Installing plugin" pluginId=grafana-lokiexplore-app version=
logger=plugin.backgroundinstaller t=2026-07-06T23:22:44.166771409Z level=error msg="Failed to install plugin" pluginId=grafana-lokiexplore-app version= error="[plugin.grafanaVersionNotCompatible] grafana-lokiexplore-app is not compatible with your Grafana version: 9.2.0"
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
| **O2** | Disabled services are silently skipped; enabled ones run as goroutines | full service‑startup log region (`sed -n '1274,1351p'`); disabled‑proof grep (0 matches) | `pkg/server/server.go:L149-L156` |
| **O3** | First run writes `grafana.db` + logs and seeds admin/org; later runs skip via a user‑count guard | before/after `find`; `sqlite3` rows; 2nd run has no creation lines | `pkg/services/sqlstore/sqlstore.go:L200-L206` |
| **O4** | A real `admin`/`admin` DB account is created; basic auth on, anonymous off (not permissive) | `401` anon; `admin`/`admin` login; `user` row `is_admin=1` | `pkg/services/sqlstore/sqlstore.go:L210-L222`; `pkg/services/anonymous/anonimpl/impl.go:L63-L64` |
| **O5** | Always‑on API vs 253 toggles (56 ON at runtime, 57 handed to frontend); analytics/update‑check on | `/api/frontend/settings`; manifest parse; update‑check ran | `pkg/services/featuremgmt/registry.go:L1695-L1701`; `conf/defaults.ini:L258,L268` |
| **O6** | 3 source classes + 19 compiled `tsdb` backends; catalog is local (nothing downloaded), but default update/preinstall checks DO contact grafana.com; 49 core plugins, 0 datasources | `/api/plugins`=49; `/api/datasources`=`[]`; external load fails; preinstall of `grafana-lokiexplore-app` fails | `pkg/plugins/manager/sources/sources.go:L24-L35` |
| **O7** | Runtime needs generated `wire_gen.go` + built `public/build`; unstamped build → `9.2.0` | git‑ignore proof; `make gen-go`; missing‑build warning; plugin‑version rejection | `pkg/server/wire.go:L1-L2`; `pkg/setting/setting.go:L1034-L1040`; `pkg/cmd/grafana/main.go:L16-L20` |

**Stability.** Each observation was reproduced. A second run against the same data directory
showed `migrations completed performed=0 skipped=626` and **no** admin/org creation; a third run
in a fresh data directory reproduced the first run exactly (same `Created default admin
user=admin`, `Created default organization`, and `HTTP Server Listen address=[::]:3000`), and
the DB again held a single `admin`/`admin@localhost` user and `Main Org.` The observed values
were stable across runs.

