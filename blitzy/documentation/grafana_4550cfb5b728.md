# Grafana OSS — What a Fresh Instance *Actually* Does on a Clean-State Start

> **Scope of this document.** This is an **evidence-backed, observed-ground-truth** answer to a new engineer's question: *what does a fresh Grafana OSS instance actually do when it starts from a completely clean state* — a brand-new data directory, **no environment variables**, and the default configuration Grafana loads on disk from `conf/defaults.ini`? Every behavioral claim below is paired with the **actual, unedited** command output that produced it (including the exact command — and any `python3`/processing step — that generated a summary), and an inline `path:Lnn` source citation verified against commit `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` (source branch `grafana_4550cfb5b728`). Anything not directly observed is explicitly labeled **(inferred)**. Where a block is a curated excerpt of a larger captured artifact, it is labeled as an **excerpt** and the raw source is named.

---

## TL;DR

A fresh Grafana OSS backend, started from a clean state with the default config, boots in **`app mode = production`** (`conf/defaults.ini:L7`), auto-creates a **single, known administrator** (`admin` / `admin`) and a single organization (`Main Org.`) — it is **not** anonymous and **not** an open/permissive mode. Its durable state is a **SQLite** database at `<data>/grafana.db`; on the **first run only** it *creates* that file, applies **626 schema migrations** (plus **18** unified-resource migrations), and seeds the admin/org, while it also creates empty scratch directories (`png/`, `pdf/`, `csv/`) and a `grafana.log` file sink. **Every subsequent run against the same data directory connects only and skips all of that** (`performed=0 skipped=626`). The API exposes **56 feature toggles enabled by default**; the plugin subsystem loads **54 shipped core plugins from the static-root filesystem** (of which **49** are surfaced by `/api/plugins`), and **zero** data sources exist until you provision them. The backend cannot even be *compiled* until a **generated Google Wire file** (`pkg/server/wire_gen.go`) is produced first — this is a **build-time** prerequisite, not a runtime one. Behavior is **deterministic** across runs: the durable outcome — schema, migration counts, seeded identity, the enabled feature-toggle set, and the loaded plugin set — is identical every time. The only *semantically meaningful* value that varies between fresh installs is the admin's random `uid`; a few incidental, non-behavioral values also differ per run (the seeded rows' timestamps, the SQLite header change-counter and therefore the file's `md5`, the feature-toggle print order, and session cookies), so two fresh `grafana.db` files are identical in **size** but **not** byte-for-byte identical (see [§7](#7-first-run-vs-subsequent-runs)). The switch that flips first-run-vs-later behavior is durable database state: whether `grafana.db` (and its `migration_log` / seeded rows) already exists.

> ⚠️ **Non-canonical version.** The binary built and run in this investigation reports **`version=9.2.0 commit=NA branch=main`**. That is a **NON-CANONICAL** artifact of a plain `go build` with no linker-flag stamping (`pkg/cmd/grafana/main.go:L17-L20`). The **canonical** version for this checkout is **`11.5.0-pre`** (`package.json:L6`). See the [Non-canonical version notice](#non-canonical-version-notice). This matters because the fake version leaks into observed output — the plugin-preinstall failure message literally cites `9.2.0`.

---

## Methodology and reproduction

Everything below was produced by **building and running the real backend** and capturing what it did. The investigation ran the server **three times**: Run 1 (fresh data dir = first run), Run 2 (the **same** data dir = subsequent run), and Run 3 (a **brand-new** data dir = determinism check).

### Environment (exact reproduction context)

- **Go toolchain `1.23.1`**, pinned by `go.mod:L3` (`go 1.23.1`), on PATH at `/usr/local/go/bin`.
- **GCC `15.2.0`** (`gcc (Ubuntu 15.2.0-4ubuntu4) 15.2.0`) — required because the default database is SQLite compiled via Cgo (`mattn/go-sqlite3`); the build therefore runs with `CGO_ENABLED=1`.
- The repository uses a **Go workspace** (`go.work` at the repo root), so builds must **not** pass `-mod=mod` (it conflicts with workspace mode; the default read-only module resolution is left in place).
- The Go build/module caches were isolated to a temp directory so the repository stayed pristine, via these exact exports:

```
$ go version
go version go1.23.1 linux/amd64
$ gcc --version | head -1
gcc (Ubuntu 15.2.0-4ubuntu4) 15.2.0
$ export GOCACHE=/tmp/gohome/gocache
$ export GOMODCACHE=/tmp/gohome/gomodcache
$ export CGO_ENABLED=1
```

- **All writable runtime paths were redirected OUTSIDE the repository** via `cfg:paths.*` command-line overrides; `conf/defaults.ini` was still loaded normally by pointing `--homepath` at the repository root. Placeholders below: `<REPO_ROOT>` = the repository checkout (`/tmp/blitzy/grafana/blitzy-…`); `<TMP>` = a scratch directory outside the repository (the investigation used `/tmp/gf_investigation`, with `state_A/` for Runs 1–2 and `state_B/` for Run 3).

### Directory setup (fresh, outside the repo)

```
$ mkdir -p /tmp/gf_investigation/state_A/data /tmp/gf_investigation/state_A/logs /tmp/gf_investigation/state_A/plugins
$ mkdir -p /tmp/gf_investigation/state_B/data /tmp/gf_investigation/state_B/logs /tmp/gf_investigation/state_B/plugins
$ mkdir -p /tmp/gf_investigation/home
```

### How this was built and run (exact commands, verbatim)

**1. Build FAILS without the generated Wire code** — this proves the code-generation prerequisite (see [§6](#6-build-and-compilation)):

```
$ CGO_ENABLED=1 go build -o /tmp/gf_investigation/grafana_bin ./pkg/cmd/grafana
# github.com/grafana/grafana/pkg/server
pkg/server/service.go:31:15: undefined: Initialize
```

**2. Generate the Wire file** (equivalent to `make gen-go`):

```
$ go run ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server
wire: github.com/grafana/grafana/pkg/server: wrote /tmp/blitzy/grafana/blitzy-…/pkg/server/wire_gen.go
```

**3. Build the canonical entry point** (a plain build → non-canonical version stamp):

```
$ CGO_ENABLED=1 go build -o /tmp/gf_investigation/grafana_bin ./pkg/cmd/grafana        # exit 0
```

**4. Version reported by that plain build** (NON-CANONICAL — see the [notice](#non-canonical-version-notice)):

```
$ /tmp/gf_investigation/grafana_bin --version
grafana version 9.2.0
$ /tmp/gf_investigation/grafana_bin server -v
Version 9.2.0 (commit: NA, branch: main)
```

**5. Run from a completely clean state** (fresh data dir, **no environment variables** via `env -i`, default config). The server was started in the background so its console log could be captured; it was stopped by signalling exactly the PID that was spawned (`kill "$SRV_PID"`), never with a broad `pkill`/`killall`:

```
$ env -i HOME=/tmp/gf_investigation/home PATH=/usr/bin:/bin TERM=xterm \
    /tmp/gf_investigation/grafana_bin server --homepath=<REPO_ROOT> \
      cfg:paths.data=<TMP>/state_A/data \
      cfg:paths.logs=<TMP>/state_A/logs \
      cfg:paths.plugins=<TMP>/state_A/plugins  > run1_console.log 2>&1 &
$ SRV_PID=$!
# ... wait for /api/health to answer, allow background services ~20s to settle, run probes ...
$ kill "$SRV_PID"          # graceful stop of the exact spawned process
```

> **Why the ~20s settle matters (observed).** If the server is stopped within ~2s of `HTTP Server Listen`, the API-server registration service is cut off mid-init and logs `*appregistry.Service run error: rest config is nil`, and the `Adding GroupVersion` / `duplicate metrics collector` lines never appear. Allowing the background services to settle produces the complete, stable log used throughout this document. This is called out so the reader does not mistake a premature-shutdown artifact for real behavior.

**6. Probes against the running instance** (cookie jar kept **outside** the repo at `<TMP>/cookies.txt`):

```
$ curl -s http://localhost:3000/api/health
$ curl -s -i -c <TMP>/cookies.txt -H 'Content-Type: application/json' \
       -d '{"user":"admin","password":"admin"}' http://localhost:3000/login
$ curl -s -b <TMP>/cookies.txt http://localhost:3000/api/login/ping
$ curl -s -b <TMP>/cookies.txt http://localhost:3000/api/user
$ curl -s -u admin:admin http://localhost:3000/api/datasources
$ curl -s -u admin:admin http://localhost:3000/api/plugins        # raw JSON; summarized separately (below)
```

**7. Re-runs.** Run 2 reused `<TMP>/state_A` (same data dir → subsequent run). Run 3 used the brand-new `<TMP>/state_B` (determinism). Both were started/stopped with the identical command form as step 5 (only the `cfg:paths.*` targets differ).

**8. Cleanup** (idempotent; full output in [Appendix A](#appendix-a-evidence-index-and-commands)):

```
$ rm -f <REPO_ROOT>/pkg/server/wire_gen.go     # git-ignored generated Wire file (.gitignore:L194)
$ rm -rf /tmp/gf_investigation                 # binary + data/logs/plugins + temp scripts (all outside the repo)
$ git -C <REPO_ROOT> status --porcelain        # empty → tracked tree clean
$ git -C <REPO_ROOT> status --ignored --short  # empty → no stray ignored runtime artifacts
```

### Why `--homepath` is mandatory

`--homepath` must point at the repository root because configuration loading is **fail-fast**: `loadConfiguration` calls `os.Exit(1)` if `conf/defaults.ini` cannot be found under `HomePath` (`pkg/setting/setting.go:L881-L890`). Without a valid home path there is no run to observe at all.

---

## Non-canonical version notice

**Direct answer:** the version seen at runtime (`9.2.0` / `commit NA` / `branch main`) is **not** a real Grafana release — it is the **hardcoded Go fallback** compiled into a plain `go build` that did not stamp the real version via linker flags.

- The fallbacks live in the entry point: `pkg/cmd/grafana/main.go:L17` declares `var version = "9.2.0"`, `:L18` `var commit = gcli.DefaultCommitValue`, and `:L20` `var buildBranch = "main"`. The comment directly above them (`:L16`) notes these "cannot be constants, since they can be overridden through the -X link flag." The `DefaultCommitValue = "NA"` constant is defined in `pkg/cmd/grafana-cli/commands/cli.go:L14`.
- A canonical release build supplies `-X main.version=…`, `-X main.commit=…`, etc. at link time. This plain build did not, so the fallbacks won.
- The **canonical** version for this checkout is **`11.5.0-pre`** (`package.json:L6`).

**Knock-on effect (observed).** Because the binary believes it is `9.2.0`, the remote plugin-preinstall step rejects `grafana-lokiexplore-app` with a message that literally embeds `9.2.0` (see [§5](#5-plugin-and-data-source-bootstrap)). What is *observed* is that the reported `BuildVersion` (`9.2.0`) is the value fed into the compatibility check and echoed in the failure message. Whether a canonically-versioned (`11.5.0-pre`) build would *pass* that check was **not** exercised here and is **(inferred/untested)** — a canonical build might still fail for an unrelated reason. Throughout this document, every appearance of `9.2.0` / `NA` is labeled **(non-canonical)**.

---

## 1. Initialization ground truth

**Direct answer:** on a clean start the backend makes a fixed sequence of automatic decisions — load `conf/defaults.ini`, run in **production** mode, resolve **56** default-on feature toggles, connect to (and, first time, create) a **SQLite** database, run migrations, seed the admin/org, load **54** shipped core plugins, run init-provisioners, then start background services and listen on `:3000`. The reason "some services report success while others seem disabled or skipped" is **not** that some failed: disabled background services are skipped **silently** by a single gate in the start loop, so they emit *no* log line at all. What looks like "some succeed, some are silent" is the contrast between services that happen to log their own initialization and disabled ones that print nothing.

### The observed boot sequence (Run 1, first run) — raw head, verbatim

This is the unedited head of the captured `run1_console.log` (≈1354 lines total — a **run-specific** count that varies slightly with async background-service timing; see the [run-specific note in §7](#7-first-run-vs-subsequent-runs)), shown with timestamps intact to demonstrate it is real output:

```
Grafana server is running with elevated privileges. This is not recommended
logger=settings t=2026-07-14T20:31:41.844859563Z level=info msg="Starting Grafana" version=9.2.0 commit=NA branch=main compiled=2026-07-14T20:31:41Z
logger=settings t=2026-07-14T20:31:41.844916189Z level=error msg="Failed to detect generated javascript files in public/build"
logger=settings t=2026-07-14T20:31:41.845128848Z level=info msg="Config loaded from" file=<REPO_ROOT>/conf/defaults.ini
logger=settings t=2026-07-14T20:31:41.845136622Z level=info msg="Config overridden from command line" arg="paths.data=<TMP>/state_A/data"
logger=settings t=2026-07-14T20:31:41.845142007Z level=info msg="Config overridden from command line" arg="paths.logs=<TMP>/state_A/logs"
logger=settings t=2026-07-14T20:31:41.845146859Z level=info msg="Config overridden from command line" arg="paths.plugins=<TMP>/state_A/plugins"
logger=settings t=2026-07-14T20:31:41.845151599Z level=info msg=Target target=[all]
logger=settings t=2026-07-14T20:31:41.845159458Z level=info msg="Path Home" path=<REPO_ROOT>
logger=settings t=2026-07-14T20:31:41.84516389Z level=info msg="Path Data" path=<TMP>/state_A/data
logger=settings t=2026-07-14T20:31:41.845168049Z level=info msg="Path Logs" path=<TMP>/state_A/logs
logger=settings t=2026-07-14T20:31:41.845172062Z level=info msg="Path Plugins" path=<TMP>/state_A/plugins
logger=settings t=2026-07-14T20:31:41.845176338Z level=info msg="Path Provisioning" path=<REPO_ROOT>/conf/provisioning
logger=settings t=2026-07-14T20:31:41.84518107Z level=info msg="App mode production"
```

### Key non-migrator lines, in order (curated **excerpt** of `run1_console.log`; timestamps elided with `t=…` for readability)

```
Grafana server is running with elevated privileges. This is not recommended
logger=settings level=info msg="Starting Grafana" version=9.2.0 commit=NA branch=main compiled=2026-07-14T20:31:41Z
logger=settings level=error msg="Failed to detect generated javascript files in public/build"
logger=settings level=info msg="Config loaded from" file=<REPO_ROOT>/conf/defaults.ini
logger=settings level=info msg="Config overridden from command line" arg="paths.data=<TMP>/state_A/data"    (x3: data, logs, plugins)
logger=settings level=info msg="App mode production"
logger=featuremgmt level=info msg=FeatureToggles logsExploreTableVisualisation=true newDashboardSharingComponent=true … [line truncated here for sequencing; ALL 56 flags shown verbatim, uncut, in §4]
logger=sqlstore level=info msg="Connecting to DB" dbtype=sqlite3
logger=sqlstore level=info msg="Creating SQLite database file" path=<TMP>/state_A/data/grafana.db
logger=migrator level=info msg="Starting DB migrations"
logger=migrator level=info msg="migrations completed" performed=626 skipped=0 duration=1.693328639s
logger=sqlstore level=info msg="Created default admin" user=admin
logger=sqlstore level=info msg="Created default organization"
logger=secrets level=info msg="Envelope encryption state" enabled=true currentprovider=secretKey.v1
logger=plugin.store level=info msg="Loading plugins..."
logger=plugin.store level=info msg="Plugins loaded" count=54 duration=31.775008ms
logger=resource-migrator level=info msg="migrations completed" performed=18 skipped=0 duration=48.258778ms
logger=ngalert.multiorg.alertmanager level=info msg="Starting MultiOrg Alertmanager"
logger=http.server level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=
logger=grafana.update.checker level=info msg="Update check succeeded" duration=49.728707ms          (x2: grafana + plugins checkers)
logger=plugin.backgroundinstaller level=error msg="Failed to install plugin" pluginId=grafana-lokiexplore-app version= error="[plugin.grafanaVersionNotCompatible] grafana-lokiexplore-app is not compatible with your Grafana version: 9.2.0"
logger=provisioning.dashboard level=info msg="starting to provision dashboards"
logger=provisioning.dashboard level=info msg="finished to provision dashboards"
```

The raw migration/seed/plugin transition (lines 1272–1279 of `run1_console.log`), verbatim, showing the last migration then the seed and plugin load:

```
logger=migrator t=2026-07-14T20:31:43.540117143Z level=info msg="migrations completed" performed=626 skipped=0 duration=1.693328639s
logger=migrator t=2026-07-14T20:31:43.540279655Z level=info msg="Unlocking database"
logger=sqlstore t=2026-07-14T20:31:43.545560078Z level=info msg="Created default admin" user=admin
logger=sqlstore t=2026-07-14T20:31:43.545644976Z level=info msg="Created default organization"
logger=secrets t=2026-07-14T20:31:43.54833308Z level=info msg="Envelope encryption state" enabled=true currentprovider=secretKey.v1
logger=plugin.store t=2026-07-14T20:31:43.60294294Z level=info msg="Loading plugins..."
logger=plugin.store t=2026-07-14T20:31:43.634716898Z level=info msg="Plugins loaded" count=54 duration=31.775008ms
```

Mapping the sequence to the source:

1. **`App mode production`** — `conf/defaults.ini:L7` sets `app_mode = production`. This *overrides* the in-code Go default of `"development"` (`pkg/setting/setting.go:L1090`) because of `.ini` precedence (`pkg/setting/setting.go:L900-L929`); see the [precedence note in §7](#7-first-run-vs-subsequent-runs).
2. **`Config loaded from … conf/defaults.ini`** — loaded by `loadConfiguration` (`pkg/setting/setting.go:L881-L890`), the fail-fast loader described in the methodology.
3. **`Connecting to DB dbtype=sqlite3` → `Creating SQLite database file`** — the storage bootstrap; the *create* line appears **only** on the first run (see [§2](#2-persistent-state-what-and-where) and [§7](#7-first-run-vs-subsequent-runs)).
4. **`Created default admin` / `Created default organization`** — the seeding step (see [§3](#3-security-posture-and-authentication)).
5. **`Plugins loaded count=54`** — the plugin load (see [§5](#5-plugin-and-data-source-bootstrap)).
6. **`Envelope encryption state enabled=true`** — logged by the secrets manager at `pkg/services/secrets/manager/manager.go:L103`.
7. **`HTTP Server Listen address=[::]:3000`** — the server begins listening; `http_port = 3000` comes from `conf/defaults.ini:L41`.

### The API server (`grafana-apiserver`) registration — what those `GroupVersion` lines are

Asynchronously, **after** `HTTP Server Listen`, the app-registry background service registers the built-in Kubernetes-style API groups. This is the raw tail of `run1_console.log` (lines 1341–1350), verbatim:

```
logger=resource-server t=2026-07-14T20:31:44.10072477Z level=warn msg="failed to register storage metrics" error="duplicate metrics collector registration attempted"
logger=resource-server t=2026-07-14T20:31:44.100859879Z level=warn msg="failed to register storage metrics" error="duplicate metrics collector registration attempted"
logger=resource-server t=2026-07-14T20:31:44.100900644Z level=warn msg="failed to register storage metrics" error="duplicate metrics collector registration attempted"
logger=grafana-apiserver t=2026-07-14T20:31:44.102269286Z level=info msg="Adding GroupVersion dashboard.grafana.app v0alpha1 to ResourceManager"
logger=grafana-apiserver t=2026-07-14T20:31:44.102798326Z level=info msg="Adding GroupVersion dashboard.grafana.app v1alpha1 to ResourceManager"
logger=grafana-apiserver t=2026-07-14T20:31:44.103337914Z level=info msg="Adding GroupVersion dashboard.grafana.app v2alpha1 to ResourceManager"
logger=grafana-apiserver t=2026-07-14T20:31:44.103740969Z level=info msg="Adding GroupVersion featuretoggle.grafana.app v0alpha1 to ResourceManager"
logger=grafana-apiserver t=2026-07-14T20:31:44.104892337Z level=info msg="Adding GroupVersion iam.grafana.app v0alpha1 to ResourceManager"
logger=grafana-apiserver t=2026-07-14T20:31:44.105415062Z level=info msg="Adding GroupVersion playlist.grafana.app v0alpha1 to ResourceManager"
logger=app-registry t=2026-07-14T20:31:44.127822401Z level=info msg="app registry initialized"
```

**Mechanism.** These six `Adding GroupVersion` lines come from the in-process Grafana API server (the `grafana.app` API groups), and they arrive via **two distinct registration paths**:

- **Five come from the `apis` Wire provider set** `WireSet` (`pkg/registry/apis/wireset.go:L24`, `var WireSet = wire.NewSet(`). Its `RegisterAPIService` entries map to the observed lines: the dashboard API's three versioned groups `v0alpha1`/`v1alpha1`/`v2alpha1` (`pkg/registry/apis/wireset.go:L34-L36`; the internal, unversioned registration is `dashboardinternal` at `:L33`), `featuretoggle` (`:L38`), and `iam` (`:L41`). The **same** WireSet also registers further groups — `dashboardsnapshot` (`:L37`), `datasource` (`:L39`), `folders` (`:L40`), and others through `:L47` — that did **not** emit this particular `Adding GroupVersion` line within the captured window, so they are not among the six observed.
- **The sixth line, `playlist.grafana.app v0alpha1`, comes from a different path** — the newer App-SDK **apps** registry (`pkg/registry/apps/apps.go`, package `appregistry`), which wires the playlist app provider (imported at `pkg/registry/apps/apps.go:L8`, taken as a constructor argument at `:L28`, and run via `NewAPIGroupRunner(cfg, playlistAppProvider)` at `:L43`). That same background service is the one that logs `app registry initialized` (`pkg/registry/apps/apps.go:L55`, `logger=app-registry` from `log.New("app-registry")` at `:L47`) — the last line of the tail above.

On a clean OSS start both paths register into the in-process ResourceManager (hence the log lines) rather than being served by an external Kubernetes apiserver. Note the timing: they appear at `t=…:44`, **after** the `:43` HTTP listen — i.e. API-group registration is a background step that completes shortly after the port is open.

### Why "disabled / skipped" services are silent (the real mechanism)

Background services are started by a single loop in `Server.Run` (`pkg/server/server.go:L139`). Before starting each service the loop consults a disable gate at `pkg/server/server.go:L149-L150`:

```
for _, svc := range services {
    if registry.IsDisabled(svc) {
        continue
    }
    ...
```

`registry.IsDisabled` (`pkg/registry/registry.go:L53`) returns `true` **only** when a service implements the optional `CanBeDisabled` interface and reports itself disabled:

```
func IsDisabled(srv BackgroundService) bool {
    canBeDisabled, ok := srv.(CanBeDisabled)
    return ok && canBeDisabled.IsDisabled()
}
```

**Key consequence:** when a service is disabled, the loop simply `continue`s — it prints **nothing**. There is **no per-service "disabled" log line** at clean-state startup (this was *not* observed, and the code confirms none is emitted). So the impression that "some services report they are 'disabled' or 'skipped'" is a misreading: disabled services are invisible, while enabled services that *choose* to log their own init (e.g. the MultiOrg Alertmanager, the alerting scheduler, the update checkers) produce the "success"-looking lines. The asymmetry is in **who logs**, not in success-vs-failure.

Concretely, several *enabled* background services logged their own initialization in the captured run — these are the "success"-looking lines, not disable reports. Observed examples (from `run1_console.log`, timestamps elided):

```
logger=live.push_http level=info msg="Live Push Gateway initialization"
logger=infra.usagestats.collector level=info msg="registering usage stat providers" usageStatsProvidersLen=2
logger=infra.usagestats level=info msg="Usage stats are ready to report"
logger=plugin.angulardetectorsprovider.dynamic level=info msg="Restored cache from database" duration=197.112µs
```

Each is an enabled service announcing itself; none is a disabled service, and none prints a "disabled"/"skipping service" line — consistent with the silent-skip mechanism above.

Server initialization itself (before the background-service loop) runs in `Server.Init` (`pkg/server/server.go:L113`): it writes the PID file, registers fixed RBAC roles, and calls `RunInitProvisioners` at `pkg/server/server.go:L134`. That provisioner (`pkg/services/provisioning/provisioning.go:L169`) runs in a fixed order — **data sources first** (`ProvisionDatasources`, `:L170`), **then plugins** (`ProvisionPlugins`, `:L176`), **then alerting** (`ProvisionAlerting`, `:L182`) — after which `Run` enters the loop above.

### The genuinely observed anomalies (explained, not fixed)

These are real lines from the log and are the actual "not-success" reports — each is expected for a backend-only clean-state run and **none is remediated here** (per task scope):

- **`Failed to detect generated javascript files in public/build`** (`logger=settings level=error`). Emitted because the **frontend was never built** — this is a backend-only run. It is an observed *data point*, not a defect to fix.
- **`failed to register storage metrics … duplicate metrics collector registration attempted`** — a `warn`, emitted **3×** by `logger=resource-server` (raw lines 1341–1343 above). In the observed run it was **non-fatal**: the server continued, `app registry initialized` was logged immediately afterward, and all API probes succeeded. Whether any individual collector/metric was *dropped* by the duplicate registration was not separately measured, so the stronger claim "benign, nothing lost" would be **(inferred)**; what is *observed* is that it did not stop startup.
- **`Failed to install plugin pluginId=grafana-lokiexplore-app … not compatible with your Grafana version: 9.2.0`** — the remote **preinstall** attempt fails the version-compatibility check. The version it cites (`9.2.0`) is the **(non-canonical)** stamp. Full mechanism in [§5](#5-plugin-and-data-source-bootstrap).
- **`Config overridden from command line`** — appeared **3×**, one per `cfg:paths.*` override passed (`paths.data`, `paths.logs`, `paths.plugins`).
- **`Update check succeeded`** — appeared **2×**, from **two distinct loggers**: `logger=grafana.update.checker` (the Grafana core check, `pkg/services/updatechecker/grafana.go:L38`) and `logger=plugins.update.checker` (the plugins check, `pkg/services/updatechecker/plugins.go:L39`). These succeeded because this environment had internet access. **(inferred)** In a fully offline environment those two checks would instead fail/time out; that offline outcome was **not** observed here.
- **`Skipping migration: Already executed, but not recorded in migration log`** (`logger=migrator level=warn`) — appeared **3×** on the first run, in **both** the console and the `grafana.log` file sink. This is a genuine *"skipped"*-style report — precisely the kind of line the original question was about — so it is called out explicitly rather than folded into the migration summary. It is emitted by the conditional-migration path in the migrator (`pkg/services/sqlstore/migrator/migrator.go:L371`): a migration that carries a `MigrationCondition` runs its condition SQL first, and if the condition is **not** fulfilled the migrator logs this warn and skips that migration's DDL (`return nil`). The three migrations that trip it on a fresh DB are all conditional "drop index if exists" migrations built by `NewDropIndexMigration` (`pkg/services/sqlstore/migrator/migrations.go:L173-L175`), which attaches an `IfIndexExistsCondition` (`pkg/services/sqlstore/migrator/conditions.go:L20-L26`) — on a brand-new database the target index was never created, so there is nothing to drop and the DDL is skipped. Observed verbatim (timestamps elided):

```
logger=migrator level=warn msg="Skipping migration: Already executed, but not recorded in migration log" id="drop unique orgID index on alert_configuration if exists"
logger=migrator level=warn msg="Skipping migration: Already executed, but not recorded in migration log" id="drop index UQE_dashboard_public_config_uid - v1"
logger=migrator level=warn msg="Skipping migration: Already executed, but not recorded in migration log" id="drop index IDX_dashboard_public_config_org_id_dashboard_uid - v1"
```

  Despite the wording, this warn does **not** contradict the `migrations completed performed=626 skipped=0` line and is **not** a re-run signal: each of these three migrations is still *counted as performed* and **is** recorded in `migration_log` (verified by querying the seeded database — all three `migration_id`s are present). Only the individual DDL statement *inside* the migration is skipped, because the index it would drop does not exist on a fresh install. Consistently, this warn appears **only on the first run** — on a subsequent run against the same data dir the migrator reports `performed=0 skipped=626` and does not re-execute these conditionals, so the warn does **not** reappear (see [§7](#7-first-run-vs-subsequent-runs)). The first example `id` maps to `pkg/services/sqlstore/migrations/ualert/tables.go:L502` (`NewDropIndexMigration` on `alert_configuration`).

### Honesty note — lines the original brief anticipated but that did NOT appear

The original task brief anticipated a **"missing image renderer"** line and an **"empty external-plugins path"** line at clean-state startup. **Neither was observed** in the captured log (a full-text search of `run1_console.log` returns no such lines). They are therefore **not** claimed here. The actual observed startup anomalies are the six bullets above — the five `error`/`warn`/override reports plus the migrator conditional-DDL "Skipping migration" warn (the last is benign and first-run-only, as explained). Aside from these, an exhaustive scan of the first-run log for `level=error`/`level=warn` messages surfaced no other distinct anomaly types.

---

## 2. Persistent state (what and where)

**Direct answer:** a fresh instance writes several artifacts under the paths it is given, but only **one of them drives behavior**: the **SQLite database** at `<data>/grafana.db`. On the first run that file is *created* and populated by **626** schema migrations (plus **18** unified-resource migrations); it ends up with **76 tables** and the seeded admin/org rows. Alongside it, the run also writes **non-behavioral** artifacts: three empty scratch directories (`png/`, `pdf/`, `csv/`) under the data dir and a `grafana.log` file under the logs dir. Those extra files persist on disk too, but they do **not** change how a later run behaves — only the database (its presence, its `migration_log`, and its seeded rows) does.

### What is written under the data/logs dirs (Run 1) — exact commands + output

```
$ find /tmp/gf_investigation/state_A/data -maxdepth 2 | sort
/tmp/gf_investigation/state_A/data
/tmp/gf_investigation/state_A/data/csv
/tmp/gf_investigation/state_A/data/grafana.db
/tmp/gf_investigation/state_A/data/pdf
/tmp/gf_investigation/state_A/data/png

$ ls -la /tmp/gf_investigation/state_A/data/
total 1092
drwxr-xr-x 5 root root    4096 Jul 14 20:32 .
drwxr-xr-x 5 root root    4096 Jul 14 20:31 ..
drwx------ 2 root root    4096 Jul 14 20:31 csv
-rw-r----- 1 root root 1093632 Jul 14 20:32 grafana.db
drwx------ 2 root root    4096 Jul 14 20:31 pdf
drwx------ 2 root root    4096 Jul 14 20:31 png

$ stat -c "%s bytes  %n" /tmp/gf_investigation/state_A/data/grafana.db
1093632 bytes  /tmp/gf_investigation/state_A/data/grafana.db

$ ls -la /tmp/gf_investigation/state_A/logs/
total 204
-rw-r--r-- 1 root root 198321 Jul 14 20:32 grafana.log

$ ls -la /tmp/gf_investigation/state_A/plugins/
total 8
drwxr-xr-x 2 root root 4096 Jul 14 20:31 .
drwxr-xr-x 5 root root 4096 Jul 14 20:31 ..      # empty — no external plugins discovered
```

- **`grafana.db`** (1,093,632 bytes) — the SQLite database and the **only behavior-driving** state. Its engine comes from the default config: `conf/defaults.ini` `[database] type = sqlite3`. The startup log's `Connecting to DB dbtype=sqlite3` and `Creating SQLite database file path=…/grafana.db` (see [§1](#1-initialization-ground-truth)) confirm both engine and path.
- **`csv/`, `pdf/`, `png/`** — scratch directories created empty (used later for rendered/exported artifacts; nothing exists on a fresh install). Persisted, but non-behavioral.
- **`grafana.log`** (198,321 bytes *in this run* — a **run-specific** snapshot; the exact size grows with log verbosity and how long the process ran before it was stopped, so independent runs differ by a few hundred bytes) — a file sink written *in addition* to the console, because the default log mode is **`console file`** (`conf/defaults.ini:L1071`, inside the `[log]` section at `conf/defaults.ini:L1068`). The default path roots come from the `[paths]` block: `data = data` (`conf/defaults.ini:L15`) and `logs = data/log` (`conf/defaults.ini:L21`) — both redirected outside the repo in this run via `cfg:` overrides. Persisted, but non-behavioral.
- **`plugins/`** — empty; on a fresh install nothing is discovered here (see [§5](#5-plugin-and-data-source-bootstrap)).

### The database contents after the first run — exact command + output (Python `sqlite3`, since the `sqlite3` CLI is not installed)

```
$ python3 db_inspect.py /tmp/gf_investigation/state_A/data/grafana.db
migration_log rows : 626
total tables       : 76
user               : id=1 uid=efs48r6smhse8e login=admin email=admin@localhost is_admin=1 org_id=1
org                : id=1 name='Main Org.'
org_user           : org_id=1 user_id=1 role=Admin
data_source count  : 0
user row count     : 1
org row count      : 1
```

The `db_inspect.py` used above is a throwaway read-only script (removed at completion; see [Appendix A](#appendix-a-evidence-index-and-commands)); its core queries are `SELECT COUNT(*) FROM migration_log`, `SELECT COUNT(*) FROM sqlite_master WHERE type='table'`, and `SELECT … FROM user/org/org_user/data_source`.

**Before / during / after (first run):**

- **Before:** no `grafana.db` exists (fresh data dir).
- **During:** the migrator emits `Starting DB migrations` then `migrations completed performed=626 skipped=0` — all 626 migrations were *performed*, none skipped, because the schema did not yet exist.
- **After:** `grafana.db` exists (1,093,632 bytes), `migration_log` has **626** rows, there are **76** tables, and the admin/org/org_user rows are seeded; `data_source` count is **0**.

**Mechanism.** The full OSS migration set is registered by `OSSMigrations.AddMigration` (`pkg/services/sqlstore/migrations/migrations.go:L31`) — the function that enqueues every migration (users, orgs, dashboards, data sources, alerting, access-control, and more). A **second, separate** migration phase for the unified resource store is reported by `logger=resource-migrator` (`migrations completed performed=18 skipped=0` in the [§1](#1-initialization-ground-truth) log). Both phases are idempotent — see [§7](#7-first-run-vs-subsequent-runs) for how they report on subsequent runs.

---

## 3. Security posture and authentication

**Direct answer:** the default instance is a **single-known-admin** system, **not** an anonymous or open/permissive one. On first boot it **auto-creates** one administrator with the shipped default credentials `admin` / `admin` and one organization; **anonymous access is disabled**, and self-service sign-up is off. The reason you "can log in with credentials you never set up" is simply that those credentials are **shipped defaults** (from the on-disk `conf/defaults.ini`) that the server seeds into the database for you. Nuance: "not permissive" does **not** mean *every* route is authenticated — a small set of endpoints is intentionally public (health, the login page/POST, and static assets); it means **anonymous dashboard/UI access is off and protected operations require authentication**.

### Observed: logging in with the default credentials works

`POST /login` with `admin`/`admin` returns HTTP 200 and sets a session cookie (full headers + body, verbatim from `run1_login.txt`):

```
$ curl -s -i -c cookies.txt -H 'Content-Type: application/json' -d '{"user":"admin","password":"admin"}' http://localhost:3000/login
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
Set-Cookie: grafana_session=60cb93cd47506cb6895de3d74fca1b5f; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax
Set-Cookie: grafana_session_expiry=1784061718; Path=/; Max-Age=2592000; SameSite=Lax
X-Content-Type-Options: nosniff
X-Frame-Options: deny
X-Xss-Protection: 1; mode=block
Date: Tue, 14 Jul 2026 20:32:03 GMT
Content-Length: 41

{"message":"Logged in","redirectUrl":"/"}
```

> **Throwaway-evidence note.** The `grafana_session=60cb93cd47506cb6895de3d74fca1b5f` value above belongs to a **disposable, localhost-only Grafana instance that was destroyed at the end of the investigation** — its SQLite database (which stores the session) was deleted with `rm -rf /tmp/gf_investigation` (see [Appendix A](#appendix-a-evidence-index-and-commands)). It is **non-reusable**: there is no running server and no database to validate it against. It is shown only to demonstrate the real `Set-Cookie` shape.

Reusing that cookie, the session is valid and resolves to the seeded admin (verbatim from `run1_user.txt`):

```
$ curl -s -b cookies.txt http://localhost:3000/api/login/ping
{"message":"Logged in"}

$ curl -s -b cookies.txt http://localhost:3000/api/user
{"id":1,"uid":"efs48r6smhse8e","email":"admin@localhost","name":"","login":"admin","theme":"","orgId":1,"isGrafanaAdmin":true,"isDisabled":false,"isExternal":false,"isExternallySynced":false,"isGrafanaAdminExternallySynced":false,"authLabels":[],"updatedAt":"2026-07-14T20:31:43Z","createdAt":"2026-07-14T20:31:43Z","avatarUrl":"/avatar/46d229b033af06a191ff2267bca9ae56"}
```

Note `"isGrafanaAdmin":true` and `"orgId":1` — a single super-admin in the single default org. The `uid` `efs48r6smhse8e` is **the same value stored in the database** (`user` row in [§2](#2-persistent-state-what-and-where)), confirming the API reads the seeded row.

### Two different response bodies, two different handlers (do not conflate them)

The two "Logged in" bodies above come from **two distinct handlers**:

- **`POST /login`** is served by **`LoginPost`** (`pkg/api/login.go:L230`), which delegates to `hs.authnService.Login(c.Req.Context(), authn.ClientForm, …)`. Its success body is `{"message":"Logged in","redirectUrl":"/"}` (note the `redirectUrl`).
- **`GET /api/login/ping`** is served by **`LoginAPIPing`** (`pkg/api/login.go:L222`), which returns `response.JSON(http.StatusOK, util.DynMap{"message": "Logged in"})` at `pkg/api/login.go:L224` — body `{"message":"Logged in"}` (no `redirectUrl`). It is a session *liveness* check, not the login itself.

### Mechanism: how the admin and org get created

The seeding runs during storage initialization: `pkg/services/sqlstore/sqlstore.go:L158` calls `ss.ensureMainOrgAndAdminUser(false)`, whose definition is at `pkg/services/sqlstore/sqlstore.go:L190`. Inside, the new admin's login is taken from config — `Login: ss.cfg.AdminUser` (`pkg/services/sqlstore/sqlstore.go:L214`) — and the two seed events are logged at `pkg/services/sqlstore/sqlstore.go:L222` (`"Created default admin"`) and `pkg/services/sqlstore/sqlstore.go:L230` (`"Created default organization"`). Those are exactly the two lines observed in the [§1](#1-initialization-ground-truth) startup log. The admin's `uid` is **randomly generated** at creation time — `UID: util.GenerateShortUID()` (`pkg/services/sqlstore/user.go:L67`) — which is why the `uid` is the only *seeded identity field* that varies between fresh installs (see [§7](#7-first-run-vs-subsequent-runs)); the `login`/`email`/`id` are fixed. (Incidental non-identity values — the seeded row's `created`/`updated` timestamps and SQLite's own header change-counter — also differ per install, so two fresh databases are size-identical but not byte-for-byte identical; see [§7](#7-first-run-vs-subsequent-runs).)

The credential values themselves are **shipped defaults** from the `[security]` block of the on-disk `conf/defaults.ini` (section header at `conf/defaults.ini:L323`):

- `admin_user = admin` (`conf/defaults.ini:L328`)
- `admin_password = admin` (`conf/defaults.ini:L331`)
- `disable_initial_admin_creation = false` (`conf/defaults.ini:L325`), which is also the in-code Go default via `cfg.DisableInitAdminCreation = security.Key("disable_initial_admin_creation").MustBool(false)` at `pkg/setting/setting.go:L1580`. Because it is `false`, the initial admin **is** created.

### Why it is NOT anonymous / permissive (with the exact public endpoints named)

Anonymous access is off by default: the `[auth.anonymous]` section (`conf/defaults.ini:L648`) sets `enabled = false` (`conf/defaults.ini:L650`), and that section is read by `pkg/setting/setting_anonymous.go:L12` (`anonSection := cfg.Raw.Section("auth.anonymous")`). Self-service sign-up is also off: the `[users]` section (`conf/defaults.ini:L481`) sets `allow_sign_up = false` (`conf/defaults.ini:L483`) and `allow_org_create = false` (`conf/defaults.ini:L486`). So no account was auto-created *for you*; the single admin was seeded from the shipped credentials.

"Not permissive" is precise, not absolute: a handful of endpoints are **intentionally public** and were exercised without a session in this investigation — `GET /api/health` (returned data without auth), the **login page and `POST /login`** themselves, and static assets. Everything that touches user/org data (`/api/user`, `/api/datasources`, `/api/plugins` in this run) required the admin session or basic auth. So the accurate statement is: **anonymous dashboard/UI access is disabled and protected operations require authentication, while a small set of public endpoints (health, login, static) remain open** — the opposite of an open/anonymous instance.

### Corroboration and the first-login password prompt

The well-known default of `admin`/`admin` at `http://localhost:3000/`, with a password-change prompt on first successful UI login, is documented in `contribute/developer-guide.md:L125-L131` (URL at `:L123`). The **backend default credentials** are *observed* here (the `POST /login` above). The **browser first-login password-change prompt** itself was **not** exercised via the API in this investigation, so it is reported as **(inferred)** from the developer guide — the guide states Grafana *asks* the user to change the password (a prompt), which is a UI flow, not a hard API-level block. The credential defaults are observed; the UI prompt is documented, not observed.

---

## 4. API feature enablement

**Direct answer:** exactly **56** feature toggles are **enabled by default**; every other toggle in the registry is **opt-in** and requires explicit activation. "Default-on" is decided statically in code: a flag is on by default if and only if its registry entry carries `Expression: "true"`.

### Observed: the full 56-toggle startup line, verbatim

The startup line `logger=featuremgmt … msg=FeatureToggles …=true …` reports 56 enabled flags. This is the **complete, unedited** line from `run1_console.log` (only the `t=…` timestamp is elided); counting the `=true` tokens yields exactly **56**:

```
logger=featuremgmt level=info msg=FeatureToggles logsExploreTableVisualisation=true newDashboardSharingComponent=true lokiStructuredMetadata=true cloudWatchCrossAccountQuerying=true dataplaneFrontendFallback=true formatString=true angularDeprecationUI=true panelMonitoring=true alertingUIOptimizeReducer=true cloudWatchRoundUpEndTime=true unifiedRequestLog=true notificationBanner=true openSearchBackendFlowEnabled=true transformationsRedesign=true preinstallAutoUpdate=true addFieldFromCalculationStatFunctions=true ssoSettingsApi=true alertingSimplifiedRouting=true correlations=true zipkinBackendMigration=true cloudwatchMetricInsightsCrossAccount=true recordedQueriesMulti=true lokiQuerySplitting=true alertingInsights=true newFiltersUI=true accessActionSets=true kubernetesPlaylists=true nestedFolders=true promQLScope=true logRowsPopoverMenu=true prometheusConfigOverhaulAuth=true publicDashboardsScene=true dashboardSceneSolo=true transformationsVariableSupport=true dashboardScene=true dashgpt=true cloudWatchNewLabelParsing=true awsAsyncQueryCaching=true dashboardSceneForViewers=true prometheusMetricEncyclopedia=true logsContextDatasourceUi=true recoveryThreshold=true azureMonitorEnableUserAuth=true lokiQueryHints=true prometheusAzureOverrideAudience=true influxdbBackendMigration=true annotationPermissionUpdate=true exploreMetrics=true accessControlOnCall=true groupToNestedTableTransformation=true alertingNoDataErrorExecution=true logsInfiniteScrolling=true tlsMemcached=true singleTopNav=true managedPluginsInstall=true pinNavItems=true
```

The producing/counting command and its output:

```
$ grep 'msg=FeatureToggles' run1_console.log | grep -oE '[a-zA-Z0-9]+=true' | wc -l
56
```

The same 56 flags, **sorted alphabetically** for readability (`… | sed 's/=true//' | sort`):

| # | Feature toggle | # | Feature toggle |
|---|---|---|---|
| 1 | `accessActionSets` | 29 | `logsExploreTableVisualisation` |
| 2 | `accessControlOnCall` | 30 | `logsInfiniteScrolling` |
| 3 | `addFieldFromCalculationStatFunctions` | 31 | `lokiQueryHints` |
| 4 | `alertingInsights` | 32 | `lokiQuerySplitting` |
| 5 | `alertingNoDataErrorExecution` | 33 | `lokiStructuredMetadata` |
| 6 | `alertingSimplifiedRouting` | 34 | `managedPluginsInstall` |
| 7 | `alertingUIOptimizeReducer` | 35 | `nestedFolders` |
| 8 | `angularDeprecationUI` | 36 | `newDashboardSharingComponent` |
| 9 | `annotationPermissionUpdate` | 37 | `newFiltersUI` |
| 10 | `awsAsyncQueryCaching` | 38 | `notificationBanner` |
| 11 | `azureMonitorEnableUserAuth` | 39 | `openSearchBackendFlowEnabled` |
| 12 | `cloudWatchCrossAccountQuerying` | 40 | `panelMonitoring` |
| 13 | `cloudWatchNewLabelParsing` | 41 | `pinNavItems` |
| 14 | `cloudWatchRoundUpEndTime` | 42 | `preinstallAutoUpdate` |
| 15 | `cloudwatchMetricInsightsCrossAccount` | 43 | `promQLScope` |
| 16 | `correlations` | 44 | `prometheusAzureOverrideAudience` |
| 17 | `dashboardScene` | 45 | `prometheusConfigOverhaulAuth` |
| 18 | `dashboardSceneForViewers` | 46 | `prometheusMetricEncyclopedia` |
| 19 | `dashboardSceneSolo` | 47 | `publicDashboardsScene` |
| 20 | `dashgpt` | 48 | `recordedQueriesMulti` |
| 21 | `dataplaneFrontendFallback` | 49 | `recoveryThreshold` |
| 22 | `exploreMetrics` | 50 | `singleTopNav` |
| 23 | `formatString` | 51 | `ssoSettingsApi` |
| 24 | `groupToNestedTableTransformation` | 52 | `tlsMemcached` |
| 25 | `influxdbBackendMigration` | 53 | `transformationsRedesign` |
| 26 | `kubernetesPlaylists` | 54 | `transformationsVariableSupport` |
| 27 | `logRowsPopoverMenu` | 55 | `unifiedRequestLog` |
| 28 | `logsContextDatasourceUi` | 56 | `zipkinBackendMigration` |

### Mechanism: default-on vs. opt-in

The registry is `standardFeatureFlags = []FeatureFlag{ … }` at `pkg/services/featuremgmt/registry.go:L20`. A toggle is enabled by default when its entry sets `Expression: "true"`; a static scan of the registry at the pinned commit finds **exactly 56** such entries — matching the 56 observed at startup. Toggles **without** `Expression: "true"` (the large majority of the registry) are **opt-in**: they stay off until explicitly enabled (e.g. via `[feature_toggles]` config or environment). So "certain features are enabled by default while others require explicit activation" reduces to a single source-of-truth predicate in the registry.

### Honesty note — cosmetic print-order variance

Across the runs, the `FeatureToggles` log line printed the 56 flags in a **different order each time** (Run 1 began `logsExploreTableVisualisation=true …`; Run 3 began `ssoSettingsApi=true …`). This is a cosmetic artifact of Go **map-iteration order** and is **not** behavioral — the *set* of 56 is identical every run (a sorted `diff` of the two runs' toggle names is empty; see [§7](#7-first-run-vs-subsequent-runs)). It is called out because it is one of the "apparent run-to-run inconsistencies" a reader might worry about; it has no functional effect.


---

## 5. Plugin and data source bootstrap

**Direct answer:** the plugins that "appear even though you didn't install them" are **shipped core plugins** — they are part of the Grafana distribution and are **loaded from the static-root filesystem** (`<StaticRootPath>/app/plugins/{datasource,panel}`), *not* compiled/embedded into the binary and *not* fetched remotely. On a fresh install the loader reports **54** core plugins loaded; `/api/plugins` surfaces **49** of them (the other 5 are intentionally filtered from the list). **Zero external plugins** are discovered from disk (the plugins dir is empty), and the single **remote preinstall** attempt (`grafana-lokiexplore-app`) **fails** the version check. Data sources are **empty** (`[]`) because none are provisioned on a fresh install.

### Observed: the plugin and data-source API responses

```
$ curl -s -u admin:admin http://localhost:3000/api/datasources
[]
```

The `/api/plugins` endpoint returns a large JSON array; here is one element, pretty-printed, to show the real shape (from `run1_plugins_raw.json`):

```
$ python3 -c "import json; d=json.load(open('run1_plugins_raw.json')); print(json.dumps(d[0], indent=2))"
{
  "name": "Alert list",
  "type": "panel",
  "id": "alertlist",
  "enabled": true,
  "pinned": false,
  ...
  "signature": "internal",
  "signatureType": "",
  "signatureOrg": "",
  "angularDetected": false
}
```

The summary counts were produced by an explicit throwaway processor `plugins_summary.py` (removed at completion), whose exact command and unedited output are:

```
$ python3 plugins_summary.py run1_plugins_raw.json
TOTAL PLUGINS: 49
by type: {'panel': 30, 'datasource': 19}
by signature: {'internal': 49}
datasource ids (19):
alertmanager, cloudwatch, elasticsearch, grafana-azure-monitor-datasource, grafana-postgresql-datasource, grafana-pyroscope-datasource, grafana-testdata-datasource, graphite, influxdb, jaeger, loki, mssql, mysql, opentsdb, parca, prometheus, stackdriver, tempo, zipkin

$ curl -s -u admin:admin 'http://localhost:3000/api/plugins?type=app'
[]
```

(`plugins_summary.py` does: `data=json.load(...)`, `len(data)`, `collections.Counter(p["type"])`, `collections.Counter(p["signature"])`, and a sorted list of datasource `id`s.) All 49 report `signature: internal` — the trust/class marker for a **core** plugin, which is why they are surfaced without an on-disk or remote origin.

### The three tiers of the plugin ecosystem (and where each is loaded from)

The plugin sources are registered by `Service.List()` at `pkg/plugins/manager/sources/sources.go:L24`, which produces sources in **three plugin classes** — `ClassCore`, `ClassBundled`, and `ClassExternal`. (Mechanically it makes *four* builder calls: two inline `NewLocalSource(...)` for core/bundled at `:L26`/`:L27`, then it appends `externalPluginSources()` at `:L29` and `pluginSettingSources()` at `:L30`; the last two both yield the **same** `ClassExternal` class, so there are still only three classes — see the note under item 3.)

1. **Shipped core (what you see).** `NewLocalSource(plugins.ClassCore, corePluginPaths(s.cfg.StaticRootPath))` at `pkg/plugins/manager/sources/sources.go:L26`. `corePluginPaths` (`:L63-L67`) resolves to two **filesystem** directories — `<StaticRootPath>/app/plugins/datasource` and `<StaticRootPath>/app/plugins/panel`. `StaticRootPath` is a config-derived filesystem path (`pkg/setting/setting.go:L103`, set at `:L1868` via `makeAbsolute(staticRoot, cfg.HomePath)`). So core plugins are **read from disk under the static root**, not embedded in the binary; `signature: internal` denotes their *core trust class*, not binary embedding. They are loaded by the plugin store, which logs `"Loading plugins..."` at `pkg/services/pluginsintegration/pluginstore/store.go:L38` and `"Plugins loaded"` with `count`/`duration` at `:L50` — observed as `Plugins loaded count=54`.
2. **Bundled (a distinct path).** `NewLocalSource(plugins.ClassBundled, []string{s.cfg.BundledPluginsPath})` at `pkg/plugins/manager/sources/sources.go:L27` — the `BundledPluginsPath`. This is separate from both the core static-root path and the external plugins path. None were present in this run.
3. **External (`ClassExternal`).** This class is built by **two** appended builders, both of which produce `ClassExternal` sources:
   - **Disk-discovered.** `externalPluginSources()` (`pkg/plugins/manager/sources/sources.go:L29`) calls `DirAsLocalSources(s.cfg.PluginsPath, plugins.ClassExternal)` at `:L35`; the discovery routine is `DirAsLocalSources` at `pkg/plugins/manager/sources/source_local_disk.go:L44-L70` (it returns an error if the path is unset, else scans the directory). On this fresh install the plugins directory (`cfg:paths.plugins=<TMP>/state_A/plugins`) is **empty**, so **no** external plugins are discovered.
   - **Plugin-settings paths.** `pluginSettingSources()` (`pkg/plugins/manager/sources/sources.go:L30`, defined at `:L49-L57`) turns any `[plugin.<id>] path = …` settings into additional `ClassExternal` sources. On a clean install there are **no** `PluginSettings` configured, so this builder returns an **empty** list and contributes nothing. It is called out here for completeness; because it maps to the already-counted `ClassExternal` class and yields zero on a fresh instance, it does **not** change the 54-loaded / 49-API counts.
4. **Remote preinstall** (a fourth, network path). A background installer attempts to fetch a preinstalled plugin from the remote catalog — `pkg/services/pluginsintegration/plugininstaller/service.go` (`installPlugins` at `:L137`, logging `"Installing plugin"` at `:L160` and `"Failed to install plugin"` at `:L175`, driven from `Run` at `:L187`). On a fresh install it tries `grafana-lokiexplore-app` and **fails** the compatibility check (below).

### Where the `grafana-lokiexplore-app` preinstall actually comes from

This is a **correction** to the naive assumption that it comes from the config file. The `preinstall =` key in `conf/defaults.ini` (`conf/defaults.ini:L1766`) is **EMPTY**. The plugin id is instead a **hardcoded Go default**: `pkg/setting/setting_plugins.go:L30` declares `defaultPreinstallPlugins = map[string]InstallPlugin{`, and `pkg/setting/setting_plugins.go:L32` contains the `grafana-lokiexplore-app` entry. That map is merged into `cfg.PreinstallPlugins` at `pkg/setting/setting_plugins.go:L77`. The observed failure (verbatim from `run1_console.log`, timestamp elided):

```
logger=plugin.backgroundinstaller level=error msg="Failed to install plugin" pluginId=grafana-lokiexplore-app version= error="[plugin.grafanaVersionNotCompatible] grafana-lokiexplore-app is not compatible with your Grafana version: 9.2.0"
```

The `9.2.0` in that message is the **(non-canonical)** version stamp; what is *observed* is that the reported `BuildVersion` is echoed into this compatibility check. Whether a canonical `11.5.0-pre` build would pass is **(inferred/untested)** — see the [Non-canonical version notice](#non-canonical-version-notice).

### Reconciling 54 (loaded) vs. 49 (API) — the exact math and the exact filter

- **Core plugin directories on disk:** **32 panels** (`public/app/plugins/panel/`) + **22 datasources** (`public/app/plugins/datasource/`) = **54** → matches the `Plugins loaded count=54` log line. (Counted via `find public/app/plugins/{panel,datasource} -maxdepth 2 -name plugin.json | wc -l` → 32 and 22.)
- **`/api/plugins` returns 49** = **30 panel** + **19 datasource**.
- **The 5 that are filtered out of the API list** are removed by explicit checks in the list handler `GetPluginList` (`pkg/api/plugins.go:L49`):
  - **2 alpha-state panels** — `debug`, `live` (each `plugin.json` has `"state": "alpha"`), removed at `pkg/api/plugins.go:L105` (`if pluginDef.State == plugins.ReleaseStateAlpha && !hs.Cfg.PluginsEnableAlpha { continue }`).
  - **3 built-in datasources** — `grafana`, `mixed`, `dashboard` (each `plugin.json` has `"builtIn": true`), removed at `pkg/api/plugins.go:L109-L110` (`if pluginDef.BuiltIn { continue }`).
- **Two datasource dirs are remapped** (not hidden — they *are* in the 19): `azuremonitor` → id `grafana-azure-monitor-datasource`, and `cloud-monitoring` → id `stackdriver`.

So: `54 loaded − 2 alpha panels − 3 built-in datasources = 49 shown`. The `?type=app` query returns `[]` because there are **no** app-type plugins in the shipped core set on a fresh install.

### Why data sources are empty (and the provisioning sample file)

`/api/datasources` returns `[]` because a fresh instance provisions nothing. `RunInitProvisioners` (`pkg/services/provisioning/provisioning.go:L169`, called from `pkg/server/server.go:L134`) reads the default provisioning path `provisioning = conf/provisioning` (`conf/defaults.ini:L27`). That path is **not** empty — it ships `conf/provisioning/datasources/sample.yaml` — but the sample file's only *active* line is `apiVersion: 1`; **every `datasources:` and `deleteDatasources:` entry in it is commented out**. So provisioning parses the file and creates **no** data sources. Data sources only appear once you add an active provisioning entry or create one via the API/UI.

---

## 6. Build and compilation

**Direct answer:** compiling the backend requires a **generated Google Wire source file that is not in version control** — `pkg/server/wire_gen.go`. This is a **build-time** dependency: until the file is generated, the canonical entry point **does not compile** (`undefined: Initialize`). It is **not** a *runtime* dependency — once compiled, the resulting binary contains the wiring and does not read `wire_gen.go` at run time. "Running the server directly vs. building first" is therefore a false dichotomy: **both `go run` and `go build`** of `./pkg/cmd/grafana` compile the `pkg/server` package and so **both require the generated Wire source to exist first**; once it exists, the two paths behave equivalently (observed below).

### Observed: compilation fails without the generated Wire file — for BOTH `go build` and `go run`

```
$ CGO_ENABLED=1 go build -o /tmp/gf_investigation/grafana_bin ./pkg/cmd/grafana
# github.com/grafana/grafana/pkg/server
pkg/server/service.go:31:15: undefined: Initialize

$ go run ./pkg/cmd/grafana --version
# github.com/grafana/grafana/pkg/server
pkg/server/service.go:31:15: undefined: Initialize
```

The undefined symbol is at `pkg/server/service.go:L31`:

```
serv, err := Initialize(s.cfg, s.opts, s.apiOpts)
```

`Initialize` is the Google Wire *injector* — its body is generated into `pkg/server/wire_gen.go`, which does not exist in a clean checkout. Because this is a **compile-time** symbol, `go run` (which compiles then runs) fails at exactly the same point as `go build`.

### Observed: generating it, then building/running successfully — equivalent behavior

```
$ go run ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server
wire: github.com/grafana/grafana/pkg/server: wrote /tmp/blitzy/grafana/blitzy-…/pkg/server/wire_gen.go

$ CGO_ENABLED=1 go build -o /tmp/gf_investigation/grafana_bin ./pkg/cmd/grafana   # exit 0
$ /tmp/gf_investigation/grafana_bin --version
grafana version 9.2.0

$ go run ./pkg/cmd/grafana --version
grafana version 9.2.0
```

Both the built binary and `go run` report the same `grafana version 9.2.0` — the run-vs-build equivalence is **observed**, not merely asserted. (The version string itself is the **(non-canonical)** stamp; that depends on linker flags, not on run-vs-build — see the [Non-canonical version notice](#non-canonical-version-notice).)

### Mechanism and why the file is absent from git

- `pkg/server/wire_gen.go` is **git-ignored** by the pattern `**/wire_gen.go` at `.gitignore:L194` — it is a build artifact, regenerated on demand, deliberately never committed. The compiled binary embeds the wiring, so nothing at runtime reads the `.go` source; its role is purely to be *compiled*.
- The canonical way to generate it is `make gen-go`: the `gen-go` target (`Makefile:L166-L169`) runs `$(GO) run … ./pkg/build/wire/cmd/wire/main.go gen -tags $(WIRE_TAGS) ./pkg/server`, where `WIRE_TAGS = "oss"` (`Makefile:L5`). The command run by hand here is exactly that recipe expanded.
- The build targets depend on codegen: `build-go: gen-go …` (`Makefile:L187`) and `build-go-fast: gen-go` (`Makefile:L191`). So the official build path always generates Wire first — the manual sequence just reproduces that ordering.

---

## 7. First run vs. subsequent runs

**Direct answer:** the difference between the first run and later runs is gated by **durable database state**, not by the pathname alone. Concretely: file existence controls whether the SQLite file is *created*; the contents of the DB's `migration_log`/schema control whether migrations are *performed or skipped*; and the presence of the seeded `user`/`org` rows controls whether seeding runs. On a fresh dir all three fire: the first run **creates** `grafana.db`, runs **626** schema migrations + **18** resource migrations, and **seeds** the admin/org. On a re-run **against the same data dir**, none fire: it **connects only**, reports `performed=0 skipped=626` (and `skipped=18`), does **not** re-create the file, and does **not** re-seed. That durable database is what makes "subsequent runs behave differently and the difference survives a stop/restart." (Scope: this comparison is the observed **same-state rerun**; a partially-migrated, empty, or corrupt DB would gate differently — those states were not exercised here.)

### The delta table

| Aspect | First run (fresh dir) | Subsequent run (same dir) |
|---|---|---|
| SQLite file | `Creating SQLite database file` | connect only (no create) |
| main migrations | `performed=626 skipped=0` | `performed=0 skipped=626` |
| resource migrations | `performed=18 skipped=0` | `performed=0 skipped=18` |
| admin/org seed | `Created default admin` + `Created default organization` | (none) |
| plugins loaded | `count=54` | `count=54` |
| version | `9.2.0` / `NA` **(non-canonical)** | `9.2.0` / `NA` **(non-canonical)** |
| startup log line count *(run-specific — see note)* | ≈1354 lines | ≈62 lines |

> **Note (run-specific value).** The startup **log line count** is **not** a deterministic constant — it varies run-to-run because several background services log asynchronously, and the total also depends on exactly when the process is stopped (a graceful shutdown flushes a few extra lines). The captured sample here was **1354** (first run) / **62** (subsequent run); independent re-runs of the identical command clustered around **≈1,350–1,360** (first run) and **≈58–62** (subsequent), varying by a handful of lines. What **is** stable and behavioral is the **order-of-magnitude difference** — a first run produces ~20×+ more log lines than a subsequent run, because the first run additionally logs database creation, all 626 (+18) migrations, and admin/org seeding. Treat the exact counts as illustrative, not as fixed invariants.

### Observed: the subsequent run (Run 2, SAME data dir) — before/after + key lines

Before/after state captured around Run 2 (from `run2_beforeafter.txt`, via Python `sqlite3`):

```
=== BEFORE Run 2 (same data dir) ===
grafana.db present BEFORE : yes (1093632 bytes)
migration_log rows BEFORE : 626
user uid BEFORE : efs48r6smhse8e
=== AFTER Run 2 ===
grafana.db size AFTER : 1093632
migration_log rows AFTER : 626
user row count AFTER : 1
run2_console_lines=62
```

Key lines from `run2_console.log` (62 lines total; timestamps elided), showing the skips and the *absence* of create/seed:

```
logger=settings level=info msg="Starting Grafana" version=9.2.0 commit=NA branch=main compiled=2026-07-14T20:33:56Z
logger=sqlstore level=info msg="Connecting to DB" dbtype=sqlite3          # NOTE: no "Creating SQLite database file"
logger=migrator level=info msg="migrations completed" performed=0 skipped=626 duration=694.989µs
logger=resource-migrator level=info msg="migrations completed" performed=0 skipped=18 duration=60.659µs
logger=plugin.store level=info msg="Plugins loaded" count=54 duration=29.047489ms
logger=http.server level=info msg="HTTP Server Listen" address=[::]:3000 protocol=http subUrl= socket=
# (NO "Created default admin"; NO "Created default organization")
```

Verification of the absences (exact commands + output):

```
$ grep -c "Creating SQLite database file" run2_console.log
0
$ grep -c "Created default admin\|Created default organization" run2_console.log
0
```

Run 2's `/api/user` returned the **same** admin with the **same** `uid` `efs48r6smhse8e` and the **same** `createdAt` `2026-07-14T20:31:43Z` (the Run 1 timestamp — proving the row *persisted* and was not recreated); `/api/datasources` → `[]`. The Run 1 session cookie still worked in Run 2 because the session itself is stored in the persisted database.

### Mechanism

The presence of `grafana.db` **and its contents** is the switch. On first run the file does not exist, so the storage layer emits `Creating SQLite database file` and the migrator finds an empty schema → all 626 migrations are *performed*. On later runs the file (and its `migration_log`) already exist, so the migrator marks all 626 as *skipped* and the create line is never printed. Seeding is likewise guarded by state rather than by the filename: `ensureMainOrgAndAdminUser` (`pkg/services/sqlstore/sqlstore.go:L190`) finds the existing admin/org rows and does **not** re-create them (hence no `Created default admin`/`Created default organization` on Run 2). This is why the behavior "persists even after you stop and restart" — later runs read the durable SQLite state.

### Determinism (Run 3, brand-new fresh dir)

A third run against a brand-new fresh dir reproduced Run 1's first-run behavior exactly (from `run3_console.log`, verified by counts):

```
$ grep -c "Creating SQLite database file" run3_console.log ; grep -c "Created default admin\|Created default organization" run3_console.log
1
2
$ grep "migrations completed" run3_console.log
… performed=626 skipped=0 …
… performed=18 skipped=0 …
$ grep 'msg=FeatureToggles' run3_console.log | grep -oE '[a-zA-Z0-9]+=true' | wc -l
56
$ stat -c%s /tmp/gf_investigation/state_B/data/grafana.db
1093632
```

**The only *semantically meaningful* seeded-identity value that differed across fresh installs was the admin `uid`** — Run 1/2 had `efs48r6smhse8e`, Run 3 had `ffs491gt1uiv4e`. (Incidental, non-behavioral values also differ per install — see below — but no other *seeded identity* field does.) The `uid` is **randomly generated per install** (`util.GenerateShortUID()`, `pkg/services/sqlstore/user.go:L67`); `id` (`1`), `login` (`admin`), `email` (`admin@localhost`), and `isGrafanaAdmin` (`true`) were identical every time. The two fresh databases were **identical in size (1,093,632 bytes)** — same schema (**76** tables), same migration counts (**626** + **18**), and same seeded identity — but they were **not byte-for-byte identical**. The one *meaningful* difference is the random `uid`; on top of that, incidental per-install bytes are persisted — the seeded `user` row's `created`/`updated` timestamps (`Created: time.Now()`, `pkg/services/sqlstore/user.go:L72`) and SQLite's own 4-byte header **change-counter** (file offset 24, which tracks write transactions). Because those bytes are written into the file, a `cmp` of two fresh installs reports a difference and their `md5` sums differ even though the byte **size** is identical. (The exact first-differing byte is itself install-dependent — it can fall in the header change-counter region near byte 28 or, when the change-counters happen to match, deeper in the seeded-`user` data page.) A byte-level comparison of two fresh installs confirms this (a fresh confirmation pair; all such temporary databases are removed at completion):

```
$ stat -c%s freshA/data/grafana.db freshB/data/grafana.db      # two fresh installs
1093632
1093632
$ cmp freshA/data/grafana.db freshB/data/grafana.db ; echo "exit=$?"
freshA/data/grafana.db freshB/data/grafana.db differ: char 4368, line 62
exit=1
$ md5sum freshA/data/grafana.db freshB/data/grafana.db
48c24a77b3ad241a7e607faa6203d6b1  freshA/data/grafana.db
aaf6578ae4825e7b6f13645f3cd04915  freshB/data/grafana.db
```

So the durable outcome is deterministic (identical size, schema, migrations, and seeded identity), while the file is *not* a byte-for-byte clone. Confirming the two runs enable the same 56 toggles (only the print order differs):

```
$ diff <(grep FeatureToggles run1_console.log | grep -oE '[a-zA-Z0-9]+=true' | sed 's/=true//' | sort) \
       <(grep FeatureToggles run3_console.log | grep -oE '[a-zA-Z0-9]+=true' | sed 's/=true//' | sort)
$ echo "exit=$?"
exit=0
```

Both apparent inconsistencies — the varying `uid` and the `FeatureToggles` print order — are **not behavioral**: the durable outcome is deterministic.


---

## Appendix A: Evidence index and commands

Every probe/inspection command used, and (where applicable) the throwaway processor that turned raw output into a summary. All temporary scripts (`plugins_summary.py`, `db_inspect.py`, the `run{1,2,3}.sh` drivers) and all data/log/plugin directories lived under `<TMP>` (`/tmp/gf_investigation`) outside the repository and were removed at completion.

| Purpose | Command | Raw artifact |
|---|---|---|
| Tool versions | `go version` ; `gcc --version` | `evidence/00_versions.txt` |
| Build without Wire (fails) | `CGO_ENABLED=1 go build -o <TMP>/grafana_bin ./pkg/cmd/grafana` | `evidence/01_build_fail.txt` |
| `go run` without Wire (fails) | `go run ./pkg/cmd/grafana --version` | `evidence/04c_go_run_fail.txt` |
| Generate Wire file | `go run ./pkg/build/wire/cmd/wire/main.go gen -tags "oss" ./pkg/server` | `evidence/02_wire_gen.txt` |
| Build (succeeds) | `CGO_ENABLED=1 go build -o <TMP>/grafana_bin ./pkg/cmd/grafana` | `evidence/03_build_ok.txt` |
| Version (non-canonical) | `<TMP>/grafana_bin --version` ; `<TMP>/grafana_bin server -v` | `evidence/04_version.txt` |
| Clean-state run | `env -i HOME=<TMP>/home PATH=/usr/bin:/bin TERM=xterm <TMP>/grafana_bin server --homepath=<REPO_ROOT> cfg:paths.data=<TMP>/state_A/data cfg:paths.logs=<TMP>/state_A/logs cfg:paths.plugins=<TMP>/state_A/plugins` | `evidence/run1_console.log` |
| Health | `curl -s http://localhost:3000/api/health` | `evidence/run1_health.txt` |
| Login (POST) | `curl -s -i -c <TMP>/cookies.txt -H 'Content-Type: application/json' -d '{"user":"admin","password":"admin"}' http://localhost:3000/login` | `evidence/run1_login.txt` |
| Session ping / current user | `curl -s -b <TMP>/cookies.txt http://localhost:3000/api/login/ping` ; `… /api/user` | `evidence/run1_user.txt` |
| Data sources | `curl -s -u admin:admin http://localhost:3000/api/datasources` | `evidence/run1_datasources.txt` |
| Plugins (raw) | `curl -s -u admin:admin http://localhost:3000/api/plugins` | `evidence/run1_plugins_raw.json` |
| Plugins (summary) | `python3 plugins_summary.py run1_plugins_raw.json` | `evidence/run1_plugins_summary.txt` |
| Filesystem enumeration | `find <TMP>/state_A/data -maxdepth 2 \| sort` ; `ls -la …` ; `stat -c '%s bytes %n' …` | `evidence/run1_filesystem.txt` |
| SQLite inspection | `python3 db_inspect.py <TMP>/state_A/data/grafana.db` | `evidence/run1_db_inspect.txt` |
| Subsequent run (same dir) | same run command, `cfg:paths.*=<TMP>/state_A/*` | `evidence/run2_console.log`, `run2_beforeafter.txt` |
| Determinism run (fresh dir) | same run command, `cfg:paths.*=<TMP>/state_B/*` | `evidence/run3_console.log`, `run3_user.txt` |

### Cleanup — exact commands and unedited output

```
$ rm -f pkg/server/wire_gen.go
$ ls pkg/server/wire_gen.go
ls: cannot access 'pkg/server/wire_gen.go': No such file or directory

$ rm -rf /tmp/gf_investigation          # binary, data/logs/plugins, cookies, temp scripts (all outside the repo)

$ git status --ignored --short
 M blitzy/documentation/grafana_4550cfb5b728.md

$ git status --porcelain
 M blitzy/documentation/grafana_4550cfb5b728.md
```

The only change reported (tracked or ignored) is this documentation file; the generated Wire file is gone, and there is **no** stray ignored runtime artifact (no `data/`, no binary, no cookie jar in the repo). (After the deliverable is committed, both commands report an empty tree.)

## Appendix B: Observed vs. inferred ledger

**Observed (backed by captured output in this document):**

- The full boot sequence and its key log lines (raw excerpts in [§1](#1-initialization-ground-truth)); `app mode = production`; config loaded from `conf/defaults.ini`.
- The 6 `Adding GroupVersion` API-group registrations and the 3× duplicate-metrics warning (raw tail in [§1](#1-initialization-ground-truth)); the run continued and `app registry initialized` was logged.
- The migrator `Skipping migration: Already executed, but not recorded in migration log` warn — **3×** on the first run in **both** sinks, from conditional "drop index if exists" migrations on a fresh DB; each such migration is still recorded in `migration_log` (so `performed=626 skipped=0` is unaffected), and the warn does not reappear on a subsequent run ([§1](#1-initialization-ground-truth)).
- 56 default-on feature toggles (full line + `wc -l` count in [§4](#4-api-feature-enablement)); identical 56-set across runs, differing only in print order.
- SQLite `grafana.db` created on first run; 626 migrations performed; 18 resource migrations; 76 tables; seeded admin/org rows; empty `data/{png,pdf,csv}` dirs; `logs/grafana.log` (file sizes shown in [§2](#2-persistent-state-what-and-where)).
- `POST /login` success (200 + session cookie), `/api/login/ping`, `/api/user` (single super-admin, org 1, `uid` matches DB).
- `/api/datasources` = `[]`; `/api/plugins` = 49 (30 panel + 19 datasource, all `internal`); `?type=app` = `[]`.
- 54 core plugins loaded from the static-root filesystem; the `grafana-lokiexplore-app` remote preinstall failing the version check.
- Compilation fails with `undefined: Initialize` without Wire — for **both** `go build` and `go run`; both succeed and report the same version after `wire_gen.go` is generated.
- First-vs-subsequent deltas (Run 2, `performed=0 skipped=626/18`, same persisted `uid`) and determinism (Run 3, **size-identical** `grafana.db` — 1,093,632 bytes, same schema/migrations/seeded identity — but **not** byte-for-byte identical, due to the differing random `uid`, row timestamps, and SQLite header change-counter; `cmp` differs and `md5` sums differ).
- Cleanup left the repository tree with no stray or ignored runtime artifacts ([Appendix A](#appendix-a-evidence-index-and-commands)).

**Inferred / documented-but-not-observed (explicitly labeled):**

- **Canonical-build plugin compatibility.** Only the non-canonical `9.2.0` build was run; the reported `BuildVersion` is *observed* to be echoed into the `grafana-lokiexplore-app` compatibility failure. Whether a canonical `11.5.0-pre` build would *pass* that check is **(inferred/untested)** — it might fail for another reason.
- **Offline update-checker behavior.** The two `Update check succeeded` lines occurred because this environment had internet. In a fully offline environment those checks would fail/time out — **(inferred)**, not observed here.
- **Browser first-login password-change prompt.** The password-change prompt on first UI login is documented at `contribute/developer-guide.md:L125-L131`; it was **not** exercised via the API here — **(inferred)** from the docs. The backend credential defaults *are* observed.
- **Duplicate-metrics "nothing lost".** The duplicate-collector warning is *observed* to be non-fatal (startup continued); the stronger claim that no metric/collector was dropped is **(inferred)**.
- **Lines the original brief anticipated but that did NOT appear:** a "missing image renderer" line and an "empty external-plugins path" line were **not** observed at clean-state startup and are therefore **not** claimed.

## Appendix C: Citation map

| Topic | Citation(s) |
|---|---|
| Version fallbacks (non-canonical) | `pkg/cmd/grafana/main.go:L17` (`9.2.0`), `:L18` (commit), `:L20` (`main`); `pkg/cmd/grafana-cli/commands/cli.go:L14` (`DefaultCommitValue = "NA"`) |
| Canonical version | `package.json:L6` (`11.5.0-pre`) |
| Config load (fail-fast) | `pkg/setting/setting.go:L881-L890` |
| `.ini` precedence | `pkg/setting/setting.go:L900-L929` |
| `app_mode` (prod vs dev default) | `conf/defaults.ini:L7`; `pkg/setting/setting.go:L1090` |
| Server lifecycle | `pkg/server/server.go:L113` (`Init`), `:L134` (`RunInitProvisioners`), `:L139` (`Run`) |
| Disable gate (silent skip) | `pkg/server/server.go:L149-L150`; `pkg/registry/registry.go:L53` |
| Provisioner order | `pkg/services/provisioning/provisioning.go:L169` (`RunInitProvisioners`), `:L170` (datasources), `:L176` (plugins), `:L182` (alerting) |
| API-server group registration (`apis` path) | `pkg/registry/apis/wireset.go:L24` (`WireSet`), `:L33-L47` (`RegisterAPIService` entries: dashboard internal+versioned `:L33-L36`, dashboardsnapshot `:L37`, featuretoggle `:L38`, iam `:L41`), imports `:L7-L20` |
| API-group registration (`apps` path) + `app registry initialized` | `pkg/registry/apps/apps.go:L8` (playlist import), `:L28` (`playlistAppProvider`), `:L43` (`NewAPIGroupRunner`), `:L47` (`log.New("app-registry")`), `:L55` (`"app registry initialized"`) |
| Wire injector symbol | `pkg/server/service.go:L31` (`Initialize`) |
| Wire git-ignore + build | `.gitignore:L194`; `Makefile:L5`, `:L166-L169` (`gen-go`), `:L187` (`build-go`), `:L191` (`build-go-fast`) |
| SQLite / paths / log | `conf/defaults.ini` `[database] type = sqlite3`; `[paths]` data `:L15` / logs `:L21` / plugins `:L24` / provisioning `:L27`; `[log]` `:L1068`, `mode` `:L1071`; `http_port` `:L41` |
| Migrations | `pkg/services/sqlstore/migrations/migrations.go:L31` |
| Migrator conditional-DDL "Skipping migration" warn | `pkg/services/sqlstore/migrator/migrator.go:L371` (warn), `:L358-L372` (condition path); `pkg/services/sqlstore/migrator/migrations.go:L173-L175` (`NewDropIndexMigration`); `pkg/services/sqlstore/migrator/conditions.go:L20-L26` (`IfIndexExistsCondition`); example id `pkg/services/sqlstore/migrations/ualert/tables.go:L502` |
| Update checkers (2 loggers) | `pkg/services/updatechecker/grafana.go:L38` (`grafana.update.checker`), `pkg/services/updatechecker/plugins.go:L39` (`plugins.update.checker`) |
| Admin/org seeding | `pkg/services/sqlstore/sqlstore.go:L158`, `:L190`, `:L214`, `:L222`, `:L230` |
| Random admin `uid` | `pkg/services/sqlstore/user.go:L67` (`util.GenerateShortUID()`) |
| Envelope encryption log | `pkg/services/secrets/manager/manager.go:L103` |
| Security defaults | `conf/defaults.ini:L323` (`[security]`), `:L325`, `:L328`, `:L331`; `pkg/setting/setting.go:L1580` |
| Anonymous disabled | `conf/defaults.ini:L648`, `:L650`; `pkg/setting/setting_anonymous.go:L12` |
| Sign-up / org-create disabled | `conf/defaults.ini:L481` (`[users]`), `:L483` (`allow_sign_up = false`), `:L486` (`allow_org_create = false`) |
| Login handlers | `pkg/api/login.go:L222` (`LoginAPIPing`), `:L224` (ping body), `:L230` (`LoginPost`) |
| Health handler | `pkg/api/http_server.go:L634` (`m.Use`), `:L703-L709` (doc), `:L710` (`apiHealthHandler`), `:L717` (`Database:"ok"`), `:L719` (`HideVersion`); `pkg/api/health.go:L10` (`databaseHealthy`) |
| Feature toggles | `pkg/services/featuremgmt/registry.go:L20` (56 `Expression:"true"`) |
| Plugin load logs | `pkg/services/pluginsintegration/pluginstore/store.go:L38`, `:L50` |
| Plugin sources (core/bundled/external) | `pkg/plugins/manager/sources/sources.go:L24` (`List`), `:L26` (core), `:L27` (bundled), `:L29` (`externalPluginSources`), `:L30` (`pluginSettingSources` call), `:L35` (disk `DirAsLocalSources`), `:L49-L57` (`pluginSettingSources` def), `:L63-L67` (`corePluginPaths`) |
| Core static-root path | `pkg/setting/setting.go:L103` (`StaticRootPath`), `:L1868` (resolved) |
| External disk discovery | `pkg/plugins/manager/sources/source_local_disk.go:L44-L70` (`DirAsLocalSources`) |
| Remote preinstall | `pkg/services/pluginsintegration/plugininstaller/service.go:L137` (`installPlugins`), `:L160`, `:L175`, `:L187`; origin `pkg/setting/setting_plugins.go:L30`, `:L32`, `:L77`; empty ini key `conf/defaults.ini:L1766` |
| Plugin API list filter | `pkg/api/plugins.go:L49` (`GetPluginList`), `:L105` (alpha filter), `:L109-L110` (built-in filter) |
| Provisioning sample (no active entries) | `conf/provisioning/datasources/sample.yaml`; `conf/defaults.ini:L27` (`provisioning = conf/provisioning`) |
| Toolchain | `go.mod:L3` (`go 1.23.1`); `.nvmrc` (`v22.11.0`); `package.json` (`engines.node ">= 22"`, `packageManager yarn@4.5.3`) |
| Reference docs | `contribute/developer-guide.md:L9-L12`, `:L123`, `:L125-L131`; `README.md:L34-L35`; `CONTRIBUTING.md:L74` |

---

*Every behavioral claim in this document is paired with the actual, unedited command output that produced it (including any `python3` processing step) and a source citation verified against commit `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`. Values that depend on how the binary was built (notably `9.2.0` / `NA`) are labeled non-canonical; values that were documented but not directly exercised are labeled (inferred).*

