# Grafana Unified Alerting under stress vs. normal load — a runtime investigation

**Subject.** The Grafana Unified Alerting **scheduler** (`pkg/services/ngalert/schedule`), its per‑rule **evaluation routine**, and the **state manager** (`pkg/services/ngalert/state`). This document answers, from *live runtime observation* of a canonically‑built `grafana-server`, how alert evaluation and notification behave when the system is under stress versus normal load.

**Commit under test.** `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`. Every `file:line` citation corresponds to that commit. The binary was built from a **separate, detached `git worktree` checked out at that exact commit** (see *Investigation setup → Canonical build*), so all observed behavior is directly attributable to `4550cfb` and the repository under test is never written to. **[OBSERVED]**

---

## How to read this document

Every *substantive* claim — every statement about runtime behavior, build identity, configuration, code structure, arithmetic, or repository integrity — is tagged at the point of use with **[OBSERVED]** or **[INFERRED]**. Structural text that carries no standalone claim of its own — the title and the *Subject* framing line, section headings, and captions that merely introduce a code listing or table shown immediately below — is not individually tagged; the claim such a caption supports is tagged either in the adjacent prose or within the block's own discussion.

- **[OBSERVED]** — captured from runtime output (a server log line, a `/metrics` sample, a SQLite row count, a measured timestamp). The command that produced it is shown, and its output is reproduced **unedited** — in full where practical, or, where a run emits hundreds of near‑identical lines, as a clearly‑labeled **representative excerpt** or a **derived summary** whose producing `grep`/`awk`/parser (or embedded analyzer script) is given alongside. Magnitude and timing claims were confirmed across **two** unchanged runs: run 1 is shown and run 2's key values are reported inline, with the raw run files for **both** runs retained under the scratch dir (enumerated in the *Appendix*).
- **[INFERRED]** — derived from reading the source at the pinned commit, cited by `file:line`. Wherever an inference could be exercised, it was, and the confirming observation is shown alongside.

Nothing here is asserted from code reading alone unless explicitly tagged **[INFERRED]**. Where the runtime contradicted a plausible code‑reading, the observation wins and the correction is called out.

---

## TL;DR — direct answers

- **Q1 (what does the scheduler work on next under backpressure?)** Every tick (a fixed 10 s heartbeat) the scheduler re‑reads the rule set from the database, orders the due rules deterministically by rule UID, and hands each due rule's tick to that rule's own goroutine. If a rule's routine is still busy, the **newer tick supersedes the older un‑consumed one** (drop‑oldest, keep‑newest). The choice first becomes visible as the per‑rule warning **`Tick dropped because alert rule evaluation is too slow`** and the counter **`grafana_alerting_schedule_rule_evaluations_missed_total`**. **[OBSERVED]**
- **Q2 (does a canceled evaluation or a removed rule leave anything behind?)** They are **different** and the runtime tells them apart. A **deletion** cleans up (state reset, resolve notifications sent, DB rows removed, routine stopped); a **context cancellation** (server shutdown mid‑evaluation) **preserves** existing state and simply stops the routine without cleanup; a **restart** (rule type change) starts a new routine for the same UID **first** and stops the old one at the end of the tick (start‑before‑stop, not atomic), **without** resetting state. One caveat on deletion: the rule's live footprint is fully removed, but its *cumulative* `…missed_total{name,org}` counter series persists by design. **[OBSERVED]**
- **Q3 (do results ever appear out of order?)** **No.** Per rule, both the start (`Processing tick`) and completion (`Tick processed`) streams are strictly monotonic in `scheduledAt`; across two stressed runs there were **0 inversions and 0 duplicates** over all 30 rules. Dropped ticks appear as **forward gaps**, never reorderings. **[OBSERVED]**
- **Q6 (what changes under normal load?)** Same 10 s heartbeat and same 18 ticks per 180 s window, but ~**9× the evaluation volume** (541 vs 60), **zero** drops, **zero** failures, and average evaluation time **6.6 ms vs 28.2 s**. Recovery was shown **in the same process**: the cumulative drop/failure counters **freeze at their peak** (they do not reset) while evaluation throughput resumes. **[OBSERVED]**
- **Q4/Q5/Q7** — live evidence + rationale, the exact identifiers/counters/timing that stand out, and repository‑integrity accounting are given their own sections below.

---

## The timing model, stated correctly

Two different 10‑second quantities exist and must not be conflated (both are read directly from the source at the pinned commit): **[INFERRED]**

- **The scheduler heartbeat (base interval).** `SchedulerBaseInterval = 10 * time.Second` — *"base interval of the scheduler. Controls how often the scheduler fetches database for new changes as well as schedules evaluation of a rule"* — at `pkg/setting/setting_unified_alerting.go:62`, overridable by the config key `scheduler_tick_interval` (`pkg/setting/setting_unified_alerting.go:335`). This is the tick cadence the whole investigation turns on. **[INFERRED]**
- **The minimum *rule* interval.** `min_interval = 10s` at `conf/defaults.ini:1346` is the smallest interval a *rule* may be configured to evaluate at — not the heartbeat. **[INFERRED]**

Both default to 10 s, which is why they are easy to confuse; they are distinct settings. **[INFERRED]** The heartbeat is directly observable as a metric, `grafana_alerting_ticker_interval_seconds` (`pkg/util/ticker/metrics.go:31`), confirmed by the running server below. **[OBSERVED]**

```
$ grep '^grafana_alerting_ticker_interval_seconds ' metrics_final.txt
grafana_alerting_ticker_interval_seconds 10
```
**[OBSERVED]** — the running server reports a 10 s tick. The per‑rule evaluation timeout is `evaluatorDefaultEvaluationTimeout = 30s` (`pkg/setting/setting_unified_alerting.go:49`; `conf/defaults.ini` `evaluation_timeout = 30s`), and retries are bounded by `max_attempts = 3` (`conf/defaults.ini:1342`). These three numbers — **10 s tick, 30 s eval timeout, 3 attempts** — are confirmed at startup:

```
logger=ngalert.scheduler t=2026-07-14T04:42:06.788335247Z level=info msg="Starting scheduler" tickInterval=10s maxAttempts=3
```
**[OBSERVED]** (`pkg/services/ngalert/schedule/schedule.go:157`).

---

## Investigation setup

### Canonical build

The server was built from the pinned commit with the repository's own Go toolchain — no prebuilt binary, no debug hooks. To guarantee the repository under test is never written to, the build is performed from a **separate, detached `git worktree` checked out at the pinned commit** (`4550cfb`); the gitignored code generator `make gen-go` therefore writes `pkg/server/wire_gen.go` into that external worktree, never into the working tree. These are the exact commands the bootstrap block above runs: **[OBSERVED]**

```
$ go version
go version go1.23.1 linux/amd64
$ git -C "$REPO" worktree add --detach "$REPO_SRC" 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff
$ ( cd "$REPO_SRC" && make gen-go && CGO_ENABLED=1 CC=gcc go build -o "$GF_BIN" ./pkg/cmd/grafana )
# GF_BIN = $GFPROBE/grafana (a scratch path); the binary never lands in the repository tree.
```

Build identity (the exact binary all observations came from):

```
$ git -C "$REPO_SRC" rev-parse HEAD
4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff
$ stat -c '%s bytes' "$GF_BIN" && sha256sum "$GF_BIN" | awk '{print $1}'
297972032 bytes
7769b61619e570f13e7a5a2c571e5f335e32b80d216fee19169c81bd1543b4e9
$ "$GF_BIN" --version
grafana version 9.2.0
```
**[OBSERVED].** The build source is the pinned commit **exactly** — `git rev-parse HEAD` in the worktree equals `4550cfb` — so all observed behavior is attributable to `4550cfb` with no intervening diff. Because the binary is a plain `go build` (no `-ldflags` version stamping), `grafana --version` and `/api/health` report the hardcoded fallback `9.2.0` / commit `NA`; the authoritative build attribution is the worktree's commit hash above, not the reported version string. Independently, in the working tree `git diff --name-status 4550cfb HEAD` reports exactly one changed path — `A blitzy/documentation/grafana_4550cfb5b728.md` — so no `.go`, `conf`, or `Makefile` differs from the pinned commit there either. **[OBSERVED]**

**Environment provenance.** The user‑specified build container (`andrewparkscaleai/coding-agent:grafana__grafana__4550cfb…`) was **not available** here — the image was absent locally and a bounded pull was denied — so the canonical runtime was reproduced directly on the attached host instead. That host provides the **same toolchain the image pins**: the `go.mod`‑declared **Go 1.23.1** (`go version go1.23.1 linux/amd64`, shown above) with **CGO enabled** and a C compiler (`gcc`), the combination the default SQLite store requires. **[OBSERVED]** Because the binary is built from the pinned commit's own `go.mod` toolchain via `make gen-go` + `go build` (no prebuilt binary, no debug hooks), the build is canonical whether it runs inside the image or on a host with that identical toolchain; the image's absence therefore changed nothing about the observed behavior and blocked no scenario. **[INFERRED]**

### Secure runtime harness

The server was run in its **default, canonical** unified‑alerting configuration, hardened for a shared host: **[OBSERVED]**

- **Loopback only.** `GF_SERVER_HTTP_ADDR=127.0.0.1` — nothing bound to a public interface.
- **No secret on the command line or in logs.** The admin password is generated once into a `600` capability file and passed via `GF_SECURITY_ADMIN_PASSWORD`; `curl` reads credentials from a `600` config file with `-K`, never on `argv`. A post‑run `grep` for the password value across all logs found **zero** occurrences.
- **All writable state under a private `mktemp -d` scratch dir** (`0700`): `data/`, `logs/`, `plugins/`, `prov/`, `caps/`. The repository tree is never written to.
- **Bounded, fail‑fast shell.** The boot and scenario scripts (`env.sh`, `start.sh`, `api.sh`, `run_scenario.sh`, `recovery_scenario.sh`) use `set -euo pipefail`; the teardown script `stop.sh` deliberately uses `set -uo pipefail` (it omits `-e` so a best-effort teardown continues past a non-fatal `kill`/`rm`). Every `curl` uses `--fail --show-error --connect-timeout --max-time`; the server is started with a captured PID and a readiness loop on `/api/health`; teardown kills **only the captured PIDs** (never `pkill`/`killall`). **[OBSERVED]**

### The mock data source, provisioning, and API contract

To induce a data source that "begins to time out" without any non‑canonical hook, a tiny local HTTP server emulates the Prometheus HTTP API on `127.0.0.1:9199`. It reads a **mode file** on every request: **[OBSERVED]**

- **`fast`** — returns an instant vector value `100` immediately (`> 10` threshold → the rule fires).
- **`slow`** — sleeps 35 s (`> 30 s` evaluation timeout) so the evaluation times out. **[OBSERVED]**

Flipping one file (`echo slow > mode` / `echo fast > mode`) toggles data‑source health **in the same server process**, which is what makes the same‑process recovery demonstration (Q6) possible. A mode‑independent `/blitzy/health` endpoint lets the launch script's readiness probe succeed even while the query path is slow. **[OBSERVED]**

Rules are **Grafana‑managed alert rules**, provisioned from files for deterministic, no‑auth setup; dynamic changes (create/update/delete/type‑change) during a run go through the **authenticated HTTP API**. Each rule is a three‑node pipeline: `A` = Prometheus query (`expr: blitzy_probe`, instant) against the mock; `B` = reduce `last(A)`; `C` = threshold `B > 10`; `condition = C`. The group is `blitzy-stress-group` in folder `blitzy-folder`, org 1, interval 10 s, with stable UIDs `blitzyrule000..029` and titles `blitzy-rule-000..029`. **[OBSERVED]**

Relevant API routes exercised (all authenticated, loopback): **[OBSERVED]**

- `POST /api/v1/provisioning/alert-rules` → `201` (creates an API‑provenance rule; response carries the rule `uid`).
- `DELETE /api/v1/provisioning/alert-rules/{uid}` → `204` (deletes an API‑provenance rule).
- `POST /api/admin/provisioning/alerting/reload` → `200 {"message":"Alerting config reloaded"}` (re‑reads the provisioning files; the canonical way to change a *file*‑provenance rule — a single‑rule `PUT` on a file rule is refused (`provisioning/alert_rules.go:588`) with `500 "cannot change provenance from 'file' to ''"`). **[OBSERVED]**

### Embedded harness source (complete)

Everything below lives outside the repository (under a scratch dir) and is removed afterward (see *Q7*). It is reproduced in full so the investigation is reproducible. **[OBSERVED]**

**Scaffolding — create the private scratch dir, materialise every script into it, generate provisioning, and build the canonical server into the scratch (nothing is ever written to the repository tree):**

```bash
# ==========================================================================
# BOOTSTRAP — run ONCE. Everything lives OUTSIDE the repository under a private
# scratch dir and is removed in Q7. NOTHING is ever written into the repository
# under test: the canonical server is built from a SEPARATE, read-only checkout
# of the pinned commit (a detached `git worktree`), so even the gitignored
# artefact `pkg/server/wire_gen.go` that `make gen-go` generates lands in that
# external checkout — never in your working tree. Fail-fast throughout.
# ==========================================================================
set -euo pipefail

# 1) Private 0700 scratch dir (mktemp -d) that holds every writable artefact.
export GFPROBE="$(mktemp -d /tmp/gf-probe.XXXXXX)"
mkdir -p "$GFPROBE"/{caps,data,logs,plugins,prov/alerting,prov/datasources,runs}
chmod 700 "$GFPROBE"
case "$GFPROBE" in /tmp/*) : ;; *) echo "refusing to run outside /tmp" >&2; exit 2 ;; esac

# 2) Materialise the harness. Save each fenced block below to $GFPROBE/<basename>
#    verbatim (a quoted heredoc — cat > "$GFPROBE/env.sh" <<'EOF' … EOF — keeps
#    every block un-expanded). The blocks, by basename, are:
#        env.sh  start.sh  stop.sh  api.sh  run_scenario.sh  recovery_scenario.sh
#        mock_prom_ds.py  gen_rules.py  analyze_ordering.py  analyze_results_order.py
#    and the datasource block to prov/datasources/mock.yaml . Then:
chmod +x "$GFPROBE"/*.sh
for f in env.sh start.sh stop.sh api.sh run_scenario.sh recovery_scenario.sh \
         mock_prom_ds.py gen_rules.py analyze_ordering.py analyze_results_order.py; do
    [ -s "$GFPROBE/$f" ] || { echo "materialise $f into \$GFPROBE first" >&2; exit 2; }
done

# 3) EXTERNAL, read-only checkout of the pinned commit (keeps the repo untouched).
#    REPO is YOUR checkout, used ONLY to source the commit into a separate worktree.
export REPO="/tmp/blitzy/grafana/blitzy-66f97028-90f7-4422-856a-ba725e0a16f4_b13e0c"
export PINNED="4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff"
export REPO_SRC="/tmp/gf-src-$PINNED"
[ -d "$REPO_SRC" ] || git -C "$REPO" worktree add --detach "$REPO_SRC" "$PINNED"

# 4) Build the canonical server INTO the scratch, from the EXTERNAL worktree.
#    make gen-go writes the gitignored pkg/server/wire_gen.go into $REPO_SRC, NOT $REPO.
export GF_BIN="$GFPROBE/grafana"
( cd "$REPO_SRC" && make gen-go && CGO_ENABLED=1 CC=gcc go build -o "$GF_BIN" ./pkg/cmd/grafana )
[ -x "$GF_BIN" ] || { echo "build failed: $GF_BIN" >&2; exit 1; }

# 5) Provisioning: 30 deterministic rules (byte-identical every run).
python3 "$GFPROBE/gen_rules.py" "$GFPROBE/prov/alerting/rules.yaml" 30   # writes 1207-line rules.yaml

# 6) Run the scenarios (boot -> warm -> flip -> capture) and the Q3 analysis.
#    Outputs land under $GFPROBE/runs/<label>/ (server_full.out, window.txt,
#    metrics_*.txt, timeline.tsv). REPO_SRC/GF_BIN/GFPROBE are exported for children.
export GFPROBE REPO_SRC GF_BIN
"$GFPROBE/run_scenario.sh" stress_run1 slow 180 15 25
"$GFPROBE/run_scenario.sh" stress_run2 slow 180 15 25
"$GFPROBE/run_scenario.sh" normal_run1 fast 180 15 25
"$GFPROBE/run_scenario.sh" normal_run2 fast 180 15 25
python3 "$GFPROBE/analyze_results_order.py"                                   # both stress runs
python3 "$GFPROBE/analyze_ordering.py" "$GFPROBE/runs/stress_run1/server_full.out" "STRESS RUN 1"
```

**`mock_prom_ds.py`** — the switchable Prometheus mock:

```python
#!/usr/bin/env python3
# mock_prom_ds.py - a minimal Prometheus-HTTP-API stand-in used ONLY as the
# alert rules' data source during this runtime investigation. It is NOT part of
# Grafana and NOT the code under observation; it exists solely to make the
# canonical Grafana evaluator either succeed quickly (healthy) or block past the
# 30s evaluation_timeout (timing out), on demand, so the real scheduler/state
# code can be observed under stress and under normal load.
#
# Behaviour is controlled by a MODE FILE whose contents are read on EVERY
# request (so the mode can be flipped WITHOUT restarting Grafana, enabling a
# same-process recovery observation):
#   "slow"  -> sleep SLOW_SLEEP seconds (> evaluation_timeout) then answer;
#              the caller (Grafana) cancels first -> the data source "times out".
#   "fast"  -> answer immediately with a single series whose value is FIRE_VALUE
#              (100), so the rule's `$B > 10` threshold fires (state=Alerting).
#
# Usage: mock_prom_ds.py <listen_port> <mode_file> <request_log>
import sys, time, json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# --- strict argument validation (fail-fast, nonzero) ---
if len(sys.argv) != 4:
    sys.stderr.write("usage: mock_prom_ds.py <listen_port> <mode_file> <request_log>\n")
    sys.exit(2)
try:
    PORT = int(sys.argv[1])
except ValueError:
    sys.stderr.write("mock_prom_ds.py: listen_port must be an integer\n")
    sys.exit(2)
if not (1 <= PORT <= 65535):
    sys.stderr.write("mock_prom_ds.py: listen_port out of range 1..65535\n")
    sys.exit(2)
MODE_FILE = sys.argv[2]
REQ_LOG = sys.argv[3]
SLOW_SLEEP = 35.0        # > 30s evaluation_timeout (conf/defaults.ini:1339)
FIRE_VALUE = "100"       # > threshold 10 -> rule fires

def current_mode():
    try:
        with open(MODE_FILE) as f:
            return f.read().strip()
    except FileNotFoundError:
        return "fast"

def log_req(path, mode, waited):
    line = "%s path=%s mode=%s waited=%.3fs\n" % (
        time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()), path, mode, waited)
    with open(REQ_LOG, "a") as f:
        f.write(line)

def prom_body(path):
    now = time.time()
    if "query_range" in path:
        return {"status": "success",
                "data": {"resultType": "matrix",
                         "result": [{"metric": {"__name__": "blitzy_probe"},
                                     "values": [[now - 10, FIRE_VALUE], [now, FIRE_VALUE]]}]}}
    return {"status": "success",
            "data": {"resultType": "vector",
                     "result": [{"metric": {"__name__": "blitzy_probe"},
                                 "value": [now, FIRE_VALUE]}]}}

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def _serve(self):
        path = urlparse(self.path).path
        # mode-independent readiness probe: ALWAYS answers instantly so the
        # launcher can confirm the mock process is up even while mode=slow.
        if path == "/blitzy/health":
            body = b'{"status":"ok"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        cl = int(self.headers.get("Content-Length", 0) or 0)
        if cl:
            self.rfile.read(cl)
        mode = current_mode()
        start = time.time()
        if mode == "slow":
            slept = 0.0
            while slept < SLOW_SLEEP:
                time.sleep(0.5)
                slept += 0.5
        waited = time.time() - start
        body = json.dumps(prom_body(path)).encode()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass
        log_req(path, mode, waited)
    def do_GET(self):
        self._serve()
    def do_POST(self):
        self._serve()
    def log_message(self, *a):
        pass

if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    srv.serve_forever()
```

**`gen_rules.py`** — deterministic generator for the 30‑rule provisioning file (`prov/alerting/rules.yaml`, 1207 lines, regenerable from this script):

```python
#!/usr/bin/env python3
# gen_rules.py - deterministically generate a provisioning file with N Grafana-
# managed alert rules in ONE 10s evaluation group, all querying the mock data
# source (uid=blitzymockds01) and firing when the returned value (100) exceeds
# the threshold 10. Rule UIDs/titles are STABLE across runs (blitzyrule000..)
# so every run uses byte-identical rule definitions. argv[1]=out, argv[2]=count.
import sys

# --- strict argument/domain validation (fail-fast, nonzero) ---
if len(sys.argv) < 2 or len(sys.argv) > 3:
    sys.stderr.write("usage: gen_rules.py <out_path> [count>0]\n")
    sys.exit(2)
OUT = sys.argv[1]
if not OUT:
    sys.stderr.write("gen_rules.py: out_path must be non-empty\n")
    sys.exit(2)
if len(sys.argv) == 3:
    try:
        N = int(sys.argv[2])
    except ValueError:
        sys.stderr.write("gen_rules.py: count must be an integer\n")
        sys.exit(2)
else:
    N = 30
if N <= 0:
    sys.stderr.write("gen_rules.py: count must be a positive integer (got %d)\n" % N)
    sys.exit(2)

rules = []
for i in range(N):
    uid = "blitzyrule%03d" % i
    title = "blitzy-rule-%03d" % i
    rules.append(f"""        - uid: {uid}
          title: {title}
          condition: C
          for: 0s
          noDataState: NoData
          execErrState: Error
          isPaused: false
          data:
            - refId: A
              relativeTimeRange:
                from: 600
                to: 0
              datasourceUid: blitzymockds01
              model:
                refId: A
                expr: blitzy_probe
                instant: true
                intervalMs: 1000
                maxDataPoints: 43200
            - refId: B
              datasourceUid: __expr__
              model:
                refId: B
                type: reduce
                reducer: last
                expression: A
                intervalMs: 1000
                maxDataPoints: 43200
            - refId: C
              datasourceUid: __expr__
              model:
                refId: C
                type: threshold
                expression: B
                conditions:
                  - evaluator:
                      type: gt
                      params: [10]
                intervalMs: 1000
                maxDataPoints: 43200""")

doc = "apiVersion: 1\ngroups:\n" + \
      "  - orgId: 1\n    name: blitzy-stress-group\n    folder: blitzy-folder\n    interval: 10s\n    rules:\n" + \
      "\n".join(rules) + "\n"

with open(OUT, "w") as f:
    f.write(doc)
print("wrote %d rules to %s" % (N, OUT))
```

**`prov/datasources/mock.yaml`** — the Prometheus data source pointing at the mock:

```yaml
apiVersion: 1
datasources:
  - name: blitzy-mock-prom
    type: prometheus
    access: proxy
    uid: blitzymockds01
    orgId: 1
    url: http://127.0.0.1:9199
    isDefault: true
    editable: false
    jsonData:
      httpMethod: POST
      timeInterval: 10s
```

One generated rule (rule 007) as it appears in `prov/alerting/rules.yaml`:

```yaml
apiVersion: 1
groups:
- orgId: 1
  name: blitzy-stress-group
  folder: blitzy-folder
  interval: 10s
  rules:
  - uid: blitzyrule007
    title: blitzy-rule-007
    condition: C
    for: 0s
    noDataState: NoData
    execErrState: Error
    isPaused: false
    data:
    - refId: A
      relativeTimeRange:
        from: 600
        to: 0
      datasourceUid: blitzymockds01
      model:
        refId: A
        expr: blitzy_probe
        instant: true
        intervalMs: 1000
        maxDataPoints: 43200
    - refId: B
      datasourceUid: __expr__
      model:
        refId: B
        type: reduce
        reducer: last
        expression: A
        intervalMs: 1000
        maxDataPoints: 43200
    - refId: C
      datasourceUid: __expr__
      model:
        refId: C
        type: threshold
        expression: B
        conditions:
        - evaluator:
            type: gt
            params:
            - 10
        intervalMs: 1000
        maxDataPoints: 43200
```

**`env.sh`** — environment + secure config (loopback bind, generated admin password via env, all paths under scratch):

```bash
#!/usr/bin/env bash
# env.sh - shared, secure environment for the Grafana runtime investigation.
# Sourced by start.sh / stop.sh / api.sh / scenario drivers. Binds to loopback
# only, keeps every writable path inside the private scratch dir, runs at DEBUG
# log level, and supplies the admin password via env (generated once, never
# printed). Fail-fast; validates its own prerequisites.
set -euo pipefail

# GFPROBE defaults to the directory THIS file was materialised into, so the
# harness is self-locating in both inherited and fresh-shell invocations.
export GFPROBE="${GFPROBE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# REPO_SRC is the EXTERNAL pinned checkout used ONLY as --homepath (never written
# to except the gitignored build outputs, which live in that external tree, not
# the assigned repository). Override by exporting REPO_SRC before sourcing.
export REPO_SRC="${REPO_SRC:-$GFPROBE/gf-src}"
export GF_BIN="${GF_BIN:-$GFPROBE/grafana}"

# --- validate prerequisites (fail-fast, no silent fallback) ---
[ -d "$GFPROBE" ] || { echo "env.sh: GFPROBE dir missing: $GFPROBE" >&2; exit 2; }
case "$GFPROBE" in /tmp/*) : ;; *) echo "env.sh: refusing to run outside /tmp (GFPROBE=$GFPROBE)" >&2; exit 2 ;; esac

# --- network: loopback only ---
export GF_HTTP_ADDR="127.0.0.1"
export GF_HTTP_PORT="${GF_HTTP_PORT:-3000}"
export MOCK_PORT="${MOCK_PORT:-9199}"

# --- Grafana configuration via GF_<SECTION>_<KEY> env (canonical mechanism) ---
export GF_SERVER_PROTOCOL="http"
export GF_SERVER_HTTP_ADDR="$GF_HTTP_ADDR"
export GF_SERVER_HTTP_PORT="$GF_HTTP_PORT"
export GF_SERVER_ENABLE_GZIP="false"
export GF_PATHS_DATA="$GFPROBE/data"
export GF_PATHS_LOGS="$GFPROBE/logs"
export GF_PATHS_PLUGINS="$GFPROBE/plugins"
export GF_PATHS_PROVISIONING="${PROVDIR:-$GFPROBE/prov}"
export GF_LOG_MODE="console"
export GF_LOG_LEVEL="debug"
export GF_ANALYTICS_REPORTING_ENABLED="false"
export GF_ANALYTICS_CHECK_FOR_UPDATES="false"
# unified_alerting defaults are canonical (execute_alerts=true, min_interval=10s,
# max_attempts=3, evaluation_timeout=30s) - NOT overridden.

# --- admin password: generated once, stored 600 inside scratch, never echoed ---
PW_FILE="$GFPROBE/caps/admin_pw"
CURL_CFG="$GFPROBE/caps/curl.cfg"
mkdir -p "$GFPROBE/caps"
if [ ! -s "$PW_FILE" ]; then
    umask 177
    head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20 > "$PW_FILE"
    printf 'user = "admin:%s"\n' "$(cat "$PW_FILE")" > "$CURL_CFG"
    umask 022
fi
export GF_SECURITY_ADMIN_USER="admin"
export GF_SECURITY_ADMIN_PASSWORD="$(cat "$PW_FILE")"
export CURL_CFG

# files used to coordinate the mock + server lifecycle
export MODE_FILE="$GFPROBE/mode"
export MOCK_REQLOG="$GFPROBE/logs/mock_requests.log"
export MOCK_PIDFILE="$GFPROBE/caps/mock.pid"
export GF_PIDFILE="$GFPROBE/caps/grafana.pid"
export SERVER_OUT="$GFPROBE/logs/server.out"
```

**`start.sh`** — boot the mock then the canonical server with a bounded readiness loop (supports WIPE_DB for identical provisioning per run):

```bash
#!/usr/bin/env bash
# start.sh - boot the mock data source + canonical grafana-server for the
# investigation. Idempotent-ish: refuses to start if a live PID file exists.
# Usage: start.sh [initial_mode]   (initial_mode = fast|slow, default fast)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/env.sh"

INIT_MODE="${1:-fast}"
# --- domain validation (fail-fast) ---
case "$INIT_MODE" in
    fast|slow) : ;;
    *) echo "start.sh: initial_mode must be 'fast' or 'slow' (got '$INIT_MODE')" >&2; exit 2 ;;
esac
[ -x "$GF_BIN" ] || { echo "start.sh: GF_BIN not executable: '$GF_BIN' (build first)" >&2; exit 2; }
[ -d "$REPO_SRC" ] || { echo "start.sh: REPO_SRC (--homepath) missing: '$REPO_SRC'" >&2; exit 2; }
echo "$INIT_MODE" > "$MODE_FILE"

# --- 1) mock data source ---
if [ -f "$MOCK_PIDFILE" ] && kill -0 "$(cat "$MOCK_PIDFILE")" 2>/dev/null; then
    echo "mock already running pid=$(cat "$MOCK_PIDFILE")"
else
    : > "$MOCK_REQLOG"
    nohup python3 "$HERE/mock_prom_ds.py" "$MOCK_PORT" "$MODE_FILE" "$MOCK_REQLOG" \
        > "$GFPROBE/logs/mock.out" 2>&1 &
    echo $! > "$MOCK_PIDFILE"
    echo "mock started pid=$(cat "$MOCK_PIDFILE") port=$MOCK_PORT mode=$INIT_MODE"
fi

# verify mock answers before starting grafana
for i in $(seq 1 20); do
    if curl -sS --fail --connect-timeout 2 --max-time 5 \
        "http://127.0.0.1:${MOCK_PORT}/blitzy/health" >/dev/null 2>&1; then
        echo "mock ready (attempt $i)"; break
    fi
    sleep 0.5
    if [ "$i" = 20 ]; then echo "ERROR: mock not ready" >&2; exit 1; fi
done

# optional clean-slate: wipe the SQLite store so only current provisioning applies
if [ "${WIPE_DB:-0}" = "1" ]; then
    rm -f "$GF_PATHS_DATA"/grafana.db "$GF_PATHS_DATA"/grafana.db-wal "$GF_PATHS_DATA"/grafana.db-shm
    echo "wiped grafana.db (clean slate)"
fi

# --- 2) grafana server ---
if [ -f "$GF_PIDFILE" ] && kill -0 "$(cat "$GF_PIDFILE")" 2>/dev/null; then
    echo "grafana already running pid=$(cat "$GF_PIDFILE")"
else
    : > "$SERVER_OUT"
    nohup "$GF_BIN" server --homepath "$REPO_SRC" --pidfile "$GF_PIDFILE" \
        > "$SERVER_OUT" 2>&1 &
    GF_SHELL_PID=$!
    sleep 1
    if [ ! -s "$GF_PIDFILE" ]; then echo "$GF_SHELL_PID" > "$GF_PIDFILE"; fi
    echo "grafana started pid=$(cat "$GF_PIDFILE") addr=${GF_HTTP_ADDR}:${GF_HTTP_PORT} loglevel=${GF_LOG_LEVEL}"
fi

# --- 3) readiness loop on /api/health (bounded) ---
READY=0
for i in $(seq 1 60); do
    if curl -sS --fail --show-error --connect-timeout 2 --max-time 5 \
        "http://127.0.0.1:${GF_HTTP_PORT}/api/health" > "$GFPROBE/logs/health.json" 2>/dev/null; then
        READY=1; echo "grafana health OK (attempt $i): $(cat "$GFPROBE/logs/health.json")"; break
    fi
    sleep 1
done
if [ "$READY" != 1 ]; then
    echo "ERROR: grafana did not become healthy in time; tail of server.out:" >&2
    tail -40 "$SERVER_OUT" >&2
    exit 1
fi
echo "START_OK"
```

**`stop.sh`** — teardown by captured PID only — never pkill/killall:

```bash
#!/usr/bin/env bash
# stop.sh - stop grafana + mock by their captured PIDs ONLY (never pkill/killall,
# which on this shared host could hit the orchestrator). Safe to run repeatedly.
# Omits -e so a best-effort teardown continues past a non-fatal kill/rm.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/env.sh"

stop_one() {
    local name="$1" pidfile="$2"
    if [ -f "$pidfile" ]; then
        local pid; pid="$(cat "$pidfile")"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            for i in $(seq 1 20); do
                if kill -0 "$pid" 2>/dev/null; then sleep 0.5; else break; fi
            done
            if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
            echo "stopped $name pid=$pid"
        else
            echo "$name pid=$pid not running"
        fi
        rm -f "$pidfile"
    else
        echo "$name no pidfile"
    fi
}
stop_one grafana "$GF_PIDFILE"
stop_one mock "$MOCK_PIDFILE"
echo "STOP_OK"
```

**`api.sh`** — authenticated curl wrapper (credentials via -K config file, never on argv):

```bash
#!/usr/bin/env bash
# api.sh - thin authenticated curl wrapper for the Grafana HTTP API. The admin
# credential is supplied via a 600-perm curl config file (-K), so the password
# never appears in argv / process listings / logs. All calls are bounded.
#
# Usage:
#   api.sh [METHOD] <path-or-url> [extra curl args...]
# If the first argument is an HTTP method (GET/POST/PUT/PATCH/DELETE/HEAD) it is
# passed via -X and consumed. A leading-'/' target is expanded to the loopback
# base URL http://127.0.0.1:$GF_HTTP_PORT. This makes the documented examples
# (e.g. `api.sh POST /api/admin/provisioning/alerting/reload`) work directly
# instead of curl mis-parsing "POST" as a malformed URL (previous exit 3).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/env.sh"

METHOD_ARGS=()
case "${1:-}" in
    GET|POST|PUT|PATCH|DELETE|HEAD) METHOD_ARGS=(-X "$1"); shift ;;
esac
if [ "$#" -lt 1 ]; then
    echo "usage: api.sh [METHOD] <path-or-url> [curl args...]" >&2
    exit 2
fi
TARGET="$1"; shift
case "$TARGET" in
    /*) TARGET="http://127.0.0.1:${GF_HTTP_PORT}${TARGET}" ;;
    http://*|https://*) : ;;
    *) echo "api.sh: target must be an absolute path (/...) or http(s) URL: $TARGET" >&2; exit 2 ;;
esac
exec curl -sS --fail --show-error --connect-timeout 2 --max-time 15 \
    -K "$CURL_CFG" "${METHOD_ARGS[@]}" "$@" "$TARGET"
```

**`run_scenario.sh`** — warm-then-flip scenario driver: boot healthy, warm, snapshot BASELINE, flip data-source mode, then capture COMPLETE /metrics + a parsed timeline for a fixed window (deltas vs baseline => arithmetic-consistent):

```bash
#!/usr/bin/env bash
# run_scenario.sh - boot a fresh canonical grafana-server HEALTHY (fast mock),
# warm to firing steady-state, snapshot a BASELINE, then flip the data source to
# TARGET_MODE (e.g. slow => "a data source begins to time out"), and capture
# COMPLETE /metrics snapshots + a parsed timeline (exact wall-clock timestamps and
# tick counts) at a fixed cadence for DURATION seconds. Deltas are computed against
# the baseline snapshot so all magnitude/rate math is arithmetic-consistent.
#   Usage: run_scenario.sh <label> <target_mode:slow|fast> <duration_sec> <snap_interval_sec> [warm_sec]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/env.sh"

# --- strict argument/domain validation (fail-fast, nonzero) ---
if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
    echo "usage: run_scenario.sh <label> <slow|fast> <duration_sec> <snap_interval_sec> [warm_sec]" >&2
    exit 2
fi
LABEL="$1"; TARGET_MODE="$2"; DURATION="$3"; SNAP="$4"; WARM="${5:-25}"
is_posint() { case "$1" in ''|*[!0-9]*) return 1;; *) [ "$1" -gt 0 ];; esac; }
is_nonneg() { case "$1" in ''|*[!0-9]*) return 1;; *) return 0;; esac; }
[ -n "$LABEL" ] || { echo "run_scenario.sh: label must be non-empty" >&2; exit 2; }
case "$TARGET_MODE" in slow|fast) : ;; *) echo "run_scenario.sh: target_mode must be slow|fast (got '$TARGET_MODE')" >&2; exit 2 ;; esac
is_posint "$DURATION" || { echo "run_scenario.sh: duration_sec must be a positive integer (got '$DURATION')" >&2; exit 2; }
is_posint "$SNAP"     || { echo "run_scenario.sh: snap_interval_sec must be a positive integer (got '$SNAP')" >&2; exit 2; }
is_nonneg "$WARM"     || { echo "run_scenario.sh: warm_sec must be a non-negative integer (got '$WARM')" >&2; exit 2; }

# --- cleanup trap: stop children on ANY exit (success, error, or signal) so an
#     invalid/interrupted run can never leave the server/mock running (F9) ---
cleanup() { "$HERE/stop.sh" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

OUT="$GFPROBE/runs/$LABEL"
rm -rf "$OUT"; mkdir -p "$OUT"

scalar() { { grep -E "^$2( |\{)" "$1" 2>/dev/null || true; } | tail -1 | awk '{print $NF}'; }
sum_vec() { { grep -E "^$2\{" "$1" 2>/dev/null || true; } | awk '{s+=$NF} END{printf "%d", s+0}'; }

# fresh process, HEALTHY (fast) for a clean firing baseline
"$HERE/stop.sh" >/dev/null 2>&1 || true
WIPE_DB=1 "$HERE/start.sh" fast > "$OUT/start.log" 2>&1

# warm to steady-state (rules firing)
sleep "$WARM"

# ---- BASELINE snapshot at flip moment ----
TBASE=$(date -u +%s.%N); TBASEISO=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
curl -sS --fail --max-time 8 "http://127.0.0.1:${GF_HTTP_PORT}/metrics" -o "$OUT/metrics_baseline.txt" || true
B_TC=$(scalar "$OUT/metrics_baseline.txt" grafana_alerting_schedule_periodic_duration_seconds_count)
B_EV=$(sum_vec "$OUT/metrics_baseline.txt" grafana_alerting_rule_evaluations_total)
B_AT=$(sum_vec "$OUT/metrics_baseline.txt" grafana_alerting_rule_evaluation_attempts_total)
B_FA=$(sum_vec "$OUT/metrics_baseline.txt" grafana_alerting_rule_evaluation_failures_total)
B_MI=$(sum_vec "$OUT/metrics_baseline.txt" grafana_alerting_schedule_rule_evaluations_missed_total)

# FLIP the data-source health
echo "$TARGET_MODE" > "$MODE_FILE"

{
  echo "LABEL=$LABEL"
  echo "TARGET_MODE=$TARGET_MODE DURATION=$DURATION SNAP=$SNAP WARM=$WARM"
  echo "T_FLIP_EPOCH=$TBASE"
  echo "T_FLIP_ISO=$TBASEISO"
  echo "BASELINE tick_count=$B_TC evals=$B_EV attempts=$B_AT failures=$B_FA misses=$B_MI"
} > "$OUT/window.txt"

printf "epoch\tiso\ttick_count\td_ticks\td_evals\td_attempts\td_failures\td_misses\tbehind_seconds\tperiodic_sum\n" > "$OUT/timeline.tsv"

T0INT=$(date -u +%s); ENDINT=$((T0INT + DURATION))
i=0
while :; do
    NOWINT=$(date -u +%s)
    [ "$NOWINT" -ge "$ENDINT" ] && break
    i=$((i+1))
    NOW=$(date -u +%s.%N); ISO=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
    SNAPF="$OUT/metrics_$(printf '%03d' "$i").txt"
    curl -sS --fail --max-time 8 "http://127.0.0.1:${GF_HTTP_PORT}/metrics" -o "$SNAPF" || true
    TC=$(scalar "$SNAPF" grafana_alerting_schedule_periodic_duration_seconds_count)
    EV=$(sum_vec "$SNAPF" grafana_alerting_rule_evaluations_total)
    AT=$(sum_vec "$SNAPF" grafana_alerting_rule_evaluation_attempts_total)
    FA=$(sum_vec "$SNAPF" grafana_alerting_rule_evaluation_failures_total)
    MI=$(sum_vec "$SNAPF" grafana_alerting_schedule_rule_evaluations_missed_total)
    BH=$(scalar "$SNAPF" grafana_alerting_scheduler_behind_seconds)
    PS=$(scalar "$SNAPF" grafana_alerting_schedule_periodic_duration_seconds_sum)
    printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
        "$NOW" "$ISO" "${TC:-NA}" "$(( ${TC:-0} - ${B_TC:-0} ))" "$(( ${EV:-0} - ${B_EV:-0} ))" \
        "$(( ${AT:-0} - ${B_AT:-0} ))" "$(( ${FA:-0} - ${B_FA:-0} ))" "$(( ${MI:-0} - ${B_MI:-0} ))" \
        "${BH:-NA}" "${PS:-NA}" >> "$OUT/timeline.tsv"
    sleep "$SNAP"
done

TEND=$(date -u +%s.%N); TENDISO=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
curl -sS --fail --max-time 8 "http://127.0.0.1:${GF_HTTP_PORT}/metrics" -o "$OUT/metrics_final.txt" || true
{
  echo "T_END_EPOCH=$TEND"
  echo "T_END_ISO=$TENDISO"
  echo "WINDOW_WALL_SECONDS=$(awk -v a="$TEND" -v b="$TBASE" 'BEGIN{printf "%.3f", a-b}')"
  echo "FINAL tick_count=$(scalar "$OUT/metrics_final.txt" grafana_alerting_schedule_periodic_duration_seconds_count) evals=$(sum_vec "$OUT/metrics_final.txt" grafana_alerting_rule_evaluations_total) attempts=$(sum_vec "$OUT/metrics_final.txt" grafana_alerting_rule_evaluation_attempts_total) failures=$(sum_vec "$OUT/metrics_final.txt" grafana_alerting_rule_evaluation_failures_total) misses=$(sum_vec "$OUT/metrics_final.txt" grafana_alerting_schedule_rule_evaluations_missed_total)"
} >> "$OUT/window.txt"

# scheduler log signals (complete, unedited)
grep -a 'msg="Starting scheduler"' "$SERVER_OUT" > "$OUT/starting_scheduler.log" 2>/dev/null || true
grep -a 'msg="Alert rules fetched"' "$SERVER_OUT" > "$OUT/alert_rules_fetched.log" 2>/dev/null || true
grep -a 'Tick dropped because alert rule evaluation is too slow' "$SERVER_OUT" > "$OUT/tick_dropped.log" 2>/dev/null || true
grep -a 'msg="Failed to evaluate rule"' "$SERVER_OUT" > "$OUT/failed_to_evaluate.log" 2>/dev/null || true
cp "$SERVER_OUT" "$OUT/server_full.out" 2>/dev/null || true

echo "=== $LABEL DONE (target_mode=$TARGET_MODE dur=${DURATION}s warm=${WARM}s) ==="
cat "$OUT/window.txt"
echo "--- timeline ---"; cat "$OUT/timeline.tsv"
echo "tick_dropped warnings total: $(wc -l < "$OUT/tick_dropped.log")"
echo "failed_to_evaluate lines total: $(wc -l < "$OUT/failed_to_evaluate.log")"
# stop happens via the EXIT trap (cleanup)
```

**`recovery_scenario.sh`** — same-process recovery driver: baseline(fast) -> slow -> back to fast, logging absolute cumulative counters across both phases:

```bash
#!/usr/bin/env bash
# recovery_scenario.sh - SAME-PROCESS recovery demonstration.
# Within ONE canonical grafana-server process: boot HEALTHY(fast) -> warm -> BASELINE
# -> flip data source SLOW (backpressure builds: drops+failures) -> flip data source
# back FAST (recovery). Snapshots COMPLETE /metrics throughout with a phase column and
# BOTH absolute-cumulative and delta-vs-baseline counter values, so we can show the
# cumulative CounterVecs PERSIST (freeze at peak, never reset) across recovery while
# the drop cadence stops and evaluations_total resumes rising and behind returns ~0.
#   Usage: recovery_scenario.sh <label> <stress_dur> <recover_dur> <snap> [warm]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/env.sh"

# --- strict argument/domain validation (fail-fast, nonzero) ---
if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
    echo "usage: recovery_scenario.sh <label> <stress_dur> <recover_dur> <snap> [warm]" >&2
    exit 2
fi
LABEL="$1"; STRESS_DUR="$2"; RECOVER_DUR="$3"; SNAP="$4"; WARM="${5:-25}"
is_posint() { case "$1" in ''|*[!0-9]*) return 1;; *) [ "$1" -gt 0 ];; esac; }
is_nonneg() { case "$1" in ''|*[!0-9]*) return 1;; *) return 0;; esac; }
[ -n "$LABEL" ] || { echo "recovery_scenario.sh: label must be non-empty" >&2; exit 2; }
is_posint "$STRESS_DUR"  || { echo "recovery_scenario.sh: stress_dur must be a positive integer" >&2; exit 2; }
is_posint "$RECOVER_DUR" || { echo "recovery_scenario.sh: recover_dur must be a positive integer" >&2; exit 2; }
is_posint "$SNAP"        || { echo "recovery_scenario.sh: snap must be a positive integer" >&2; exit 2; }
is_nonneg "$WARM"        || { echo "recovery_scenario.sh: warm must be a non-negative integer" >&2; exit 2; }

cleanup() { "$HERE/stop.sh" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

OUT="$GFPROBE/runs/$LABEL"; rm -rf "$OUT"; mkdir -p "$OUT"

scalar() { { grep -E "^$2( |\{)" "$1" 2>/dev/null || true; } | tail -1 | awk '{print $NF}'; }
sum_vec() { { grep -E "^$2\{" "$1" 2>/dev/null || true; } | awk '{s+=$NF} END{printf "%d", s+0}'; }

"$HERE/stop.sh" >/dev/null 2>&1 || true
WIPE_DB=1 "$HERE/start.sh" fast > "$OUT/start.log" 2>&1
sleep "$WARM"

TBASE=$(date -u +%s.%N); TBASEISO=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
curl -sS --fail --max-time 8 "http://127.0.0.1:${GF_HTTP_PORT}/metrics" -o "$OUT/metrics_baseline.txt" || true
B_TC=$(scalar "$OUT/metrics_baseline.txt" grafana_alerting_schedule_periodic_duration_seconds_count)
B_EV=$(sum_vec "$OUT/metrics_baseline.txt" grafana_alerting_rule_evaluations_total)
B_FA=$(sum_vec "$OUT/metrics_baseline.txt" grafana_alerting_rule_evaluation_failures_total)
B_MI=$(sum_vec "$OUT/metrics_baseline.txt" grafana_alerting_schedule_rule_evaluations_missed_total)

printf "epoch\tiso\tphase\ttick_count\tabs_evals\tabs_failures\tabs_misses\td_evals\td_failures\td_misses\tbehind\tperiodic_sum\n" > "$OUT/timeline.tsv"

snap_loop() {
  local phase="$1" dur="$2"
  local end=$(( $(date -u +%s) + dur ))
  while :; do
    [ "$(date -u +%s)" -ge "$end" ] && break
    local NOW ISO SNAPF TC EV FA MI BH PS
    NOW=$(date -u +%s.%N); ISO=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
    SNAPF="$OUT/metrics_${phase}_$(date -u +%s).txt"
    curl -sS --fail --max-time 8 "http://127.0.0.1:${GF_HTTP_PORT}/metrics" -o "$SNAPF" || true
    TC=$(scalar "$SNAPF" grafana_alerting_schedule_periodic_duration_seconds_count)
    EV=$(sum_vec "$SNAPF" grafana_alerting_rule_evaluations_total)
    FA=$(sum_vec "$SNAPF" grafana_alerting_rule_evaluation_failures_total)
    MI=$(sum_vec "$SNAPF" grafana_alerting_schedule_rule_evaluations_missed_total)
    BH=$(scalar "$SNAPF" grafana_alerting_scheduler_behind_seconds)
    PS=$(scalar "$SNAPF" grafana_alerting_schedule_periodic_duration_seconds_sum)
    printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
      "$NOW" "$ISO" "$phase" "${TC:-NA}" "${EV:-0}" "${FA:-0}" "${MI:-0}" \
      "$(( ${EV:-0} - ${B_EV:-0} ))" "$(( ${FA:-0} - ${B_FA:-0} ))" "$(( ${MI:-0} - ${B_MI:-0} ))" \
      "${BH:-NA}" "${PS:-NA}" >> "$OUT/timeline.tsv"
    sleep "$SNAP"
  done
}

# PHASE 1: STRESS (data source begins to time out)
T_STRESS=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ); echo slow > "$MODE_FILE"
snap_loop stress "$STRESS_DUR"
curl -sS --fail --max-time 8 "http://127.0.0.1:${GF_HTTP_PORT}/metrics" -o "$OUT/metrics_end_stress.txt" || true
S_MI=$(sum_vec "$OUT/metrics_end_stress.txt" grafana_alerting_schedule_rule_evaluations_missed_total)
S_FA=$(sum_vec "$OUT/metrics_end_stress.txt" grafana_alerting_rule_evaluation_failures_total)
S_EV=$(sum_vec "$OUT/metrics_end_stress.txt" grafana_alerting_rule_evaluations_total)

# PHASE 2: RECOVERY (data source healthy again) -- SAME process
T_RECOVER=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ); echo fast > "$MODE_FILE"
snap_loop recovery "$RECOVER_DUR"

TEND=$(date -u +%s.%N); TENDISO=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
curl -sS --fail --max-time 8 "http://127.0.0.1:${GF_HTTP_PORT}/metrics" -o "$OUT/metrics_final.txt" || true
F_MI=$(sum_vec "$OUT/metrics_final.txt" grafana_alerting_schedule_rule_evaluations_missed_total)
F_FA=$(sum_vec "$OUT/metrics_final.txt" grafana_alerting_rule_evaluation_failures_total)
F_EV=$(sum_vec "$OUT/metrics_final.txt" grafana_alerting_rule_evaluations_total)

{
  echo "LABEL=$LABEL STRESS_DUR=$STRESS_DUR RECOVER_DUR=$RECOVER_DUR SNAP=$SNAP WARM=$WARM"
  echo "T_BASELINE_ISO=$TBASEISO   (mode=fast)"
  echo "T_STRESS_FLIP_ISO=$T_STRESS  (mode=slow)"
  echo "T_RECOVER_FLIP_ISO=$T_RECOVER (mode=fast)"
  echo "T_END_ISO=$TENDISO"
  echo "BASELINE     evals=$B_EV failures=$B_FA misses=$B_MI (tick_count=$B_TC)"
  echo "END_STRESS   evals=$S_EV failures=$S_FA misses=$S_MI"
  echo "END_RECOVERY evals=$F_EV failures=$F_FA misses=$F_MI"
  echo "--- PERSISTENCE CHECK (cumulative CounterVecs must NOT reset across recovery) ---"
  echo "misses:   stress_end=$S_MI -> recovery_end=$F_MI  (delta_in_recovery=$(( F_MI - S_MI )))  [expect small => frozen/persisted]"
  echo "failures: stress_end=$S_FA -> recovery_end=$F_FA  (delta_in_recovery=$(( F_FA - S_FA )))  [expect ~0 => frozen/persisted]"
  echo "evals:    stress_end=$S_EV -> recovery_end=$F_EV  (delta_in_recovery=$(( F_EV - S_EV )))  [expect >0 => resumed rising]"
} > "$OUT/window.txt"

grep -a 'Tick dropped because alert rule evaluation is too slow' "$SERVER_OUT" > "$OUT/tick_dropped.log" 2>/dev/null || true
grep -a 'msg="Failed to evaluate rule"' "$SERVER_OUT" > "$OUT/failed_to_evaluate.log" 2>/dev/null || true
cp "$SERVER_OUT" "$OUT/server_full.out" 2>/dev/null || true

echo "=== $LABEL DONE ==="
cat "$OUT/window.txt"
echo "--- timeline.tsv ---"; cat "$OUT/timeline.tsv"
```

**`analyze_ordering.py`** — per‑rule ordering probe (Q3): reconstructs each rule's `Processing tick` stream in emission order and reports, per rule, inversions (a `now=`/`scheduledAt` earlier than its predecessor) and gaps (a jump of more than one 10 s tick). Dropped ticks surface as a **forward** gap — the routine jumps ahead to the newest pending tick and never replays an older one — so `inv=0, gap≥1` per busy rule is the ordering‑preserved signature. Two representative rules are printed in full, then the whole per‑rule `(n, inv, gap)` table with a `TOTAL`:

```python
#!/usr/bin/env python3
# analyze_ordering.py - per-rule ordering probe over one captured grafana server
# log (server_full.out). For a single run it reconstructs each rule's
# 'Processing tick' stream IN EMISSION ORDER and checks that the scheduledAt
# (now=) values increase monotonically per rule. It counts, per rule:
#   inversions - a now= earlier than its predecessor (a genuine out-of-order/backwards step)
#   gaps       - a jump of MORE THAN one 10s tick (dropped ticks show up as a
#                FORWARD gap, i.e. the routine jumps ahead to the newest pending
#                tick; it never replays an older one).
# Two representative rules are printed in full (with the +Ns GAP annotation) and
# then the whole per-rule (n, inversions, gaps) table with a TOTAL line.
#
# Exit status (F4 - published reproducer must be self-validating):
#   0  = evidence present AND zero inversions (ordering preserved)
#   1  = a violation was found (>=1 inversion) OR no evidence (0 events parsed)
#   2  = usage / missing input file
#
# Usage: analyze_ordering.py <server_full.out> [label]
#   If <server_full.out> is omitted it defaults to
#   $GFPROBE/runs/stress_run1/server_full.out so the published command resolves
#   inside the harness context.
import sys, os, re
from datetime import datetime, timezone

def default_path():
    gp = os.environ.get("GFPROBE")
    if gp:
        return os.path.join(gp, "runs", "stress_run1", "server_full.out")
    return None

PATH  = sys.argv[1] if len(sys.argv) > 1 else default_path()
LABEL = sys.argv[2] if len(sys.argv) > 2 else "RUN"
if not PATH:
    sys.stderr.write("usage: analyze_ordering.py <server_full.out> [label] "
                     "(or set GFPROBE)\n")
    sys.exit(2)
if not os.path.isfile(PATH):
    sys.stderr.write("analyze_ordering.py: input file not found: %s\n" % PATH)
    sys.exit(2)

TICK  = 10  # baseInterval seconds (conf/defaults.ini min_interval=10s / SchedulerBaseInterval)
SAMPLES = ("blitzyrule000", "blitzyrule015")

_kv = re.compile(r'(\w+)=("[^"]*"|\S+)')

def fields(line):
    return {k: v.strip('"') for k, v in _kv.findall(line)}

def parse_now(s):
    # now= is the tick-aligned scheduledAt (whole seconds), rendered UTC with a
    # trailing Z, e.g. 2026-07-14T00:15:20Z. Strip Z and any fractional part.
    s = s.rstrip("Z")
    if "." in s:
        s = s.split(".", 1)[0]
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)

# collect each rule's 'Processing tick' sequence in file (emission) order
seq = {}
with open(PATH, encoding="utf-8", errors="replace") as f:
    for line in f:
        if 'msg="Processing tick"' not in line:
            continue
        d = fields(line)
        uid, now, t = d.get("rule_uid"), d.get("now"), d.get("t")
        if not (uid and now and t):
            continue
        seq.setdefault(uid, []).append((t, now.rstrip("Z"), parse_now(now)))

print("################ %s ################" % LABEL)
for uid in SAMPLES:
    if uid not in seq:
        continue
    print("-- %s: 'Processing tick' (t_emit -> now=scheduledAt) --" % uid)
    prev = None
    for (t, nows, nowd) in seq[uid]:
        line = "   t=%s  now=%s" % (t, nows)
        if prev is not None:
            delta = int((nowd - prev).total_seconds())
            if delta > TICK:
                line += "  <== GAP +%ds (%d dropped)" % (delta, delta // TICK - 1)
        print(line)
        prev = nowd
    print()

print("-- per-rule: (n_processing, inversions, gaps) --")
tot_inv = tot_gap = tot_events = 0
for uid in sorted(seq):
    s = seq[uid]
    tot_events += len(s)
    inv = gap = 0
    for i in range(1, len(s)):
        delta = (s[i][2] - s[i - 1][2]).total_seconds()
        if delta < 0:
            inv += 1
        elif delta > TICK:
            gap += 1
    tot_inv += inv
    tot_gap += gap
    print("   %s: n=%2d inv=%d gap=%d" % (uid, len(s), inv, gap))
print("   TOTAL inversions=%d  gaps=%d  (events=%d, rules=%d)"
      % (tot_inv, tot_gap, tot_events, len(seq)))

# --- self-validation: fail nonzero on missing evidence or any inversion ---
if len(seq) == 0 or tot_events == 0:
    print("FAIL: no 'Processing tick' evidence parsed from %s" % PATH)
    sys.exit(1)
if tot_inv != 0:
    print("FAIL: %d ordering inversion(s) detected" % tot_inv)
    sys.exit(1)
print("PASS: ordering preserved (0 inversions across %d rules, %d events; "
      "gaps=%d are forward drops, not reorderings)" % (len(seq), tot_events, tot_gap))
sys.exit(0)
```

**`analyze_results_order.py`** — cross‑run **results**‑ordering summary (Q3): for each stressed run it checks **both** streams — `Processing tick` (dispatch/start order) and `Tick processed` (completion/**results** order) — and aggregates, across all rules, inversions (a `now=` earlier than its predecessor) and duplicates (the same tick processed twice). Zero of both in the `Tick processed` stream means results are strictly per‑rule monotonic (never out of order):

```python
#!/usr/bin/env python3
# analyze_results_order.py - cross-run RESULTS-ordering summary. For each stressed
# run it checks BOTH streams: 'Processing tick' (dispatch/start order) and
# 'Tick processed' (completion/results order - the stream that actually answers
# "do evaluation RESULTS appear out of order"). For every rule it walks the now=
# (scheduledAt) values in emission order and aggregates, across all rules:
#   inversions - a now= earlier than its predecessor (a backwards/out-of-order result)
#   duplicates - a now= equal to its predecessor (the same tick processed twice)
# Zero of both, in the 'Tick processed' stream, means results are strictly
# per-rule monotonic (never out of order).
#
# Exit status (F4 - published reproducer must be self-validating):
#   0  = every run had evidence AND 0 inversions AND 0 duplicates in BOTH streams
#   1  = a violation (inversion/duplicate) OR missing evidence in any run
#   2  = usage / a named run's server_full.out is missing
#
# Usage: analyze_results_order.py [run_dir ...]
#   A run_dir may be an absolute path or a label resolved under $GFPROBE/runs.
#   With no args it defaults to $GFPROBE/runs/stress_run1 and .../stress_run2.
import sys, os, re
from datetime import datetime, timezone

def resolve(run):
    # absolute/relative path to a run directory, or a bare label under $GFPROBE/runs
    if os.path.isdir(run):
        return run
    gp = os.environ.get("GFPROBE")
    if gp:
        cand = os.path.join(gp, "runs", run)
        if os.path.isdir(cand):
            return cand
    return run  # let the file check below report the precise missing path

if len(sys.argv) > 1:
    RUNS = sys.argv[1:]
else:
    RUNS = ["stress_run1", "stress_run2"]

_kv  = re.compile(r'(\w+)=("[^"]*"|\S+)')

def parse_now(s):
    s = s.rstrip("Z")
    if "." in s:
        s = s.split(".", 1)[0]
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)

def analyze(path, msg):
    seq = {}
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if ('msg="%s"' % msg) not in line:
                continue
            d = {k: v.strip('"') for k, v in _kv.findall(line)}
            uid, now = d.get("rule_uid"), d.get("now")
            if not (uid and now):
                continue
            seq.setdefault(uid, []).append(parse_now(now))
    inv = dup = events = 0
    for xs in seq.values():
        events += len(xs)
        for i in range(1, len(xs)):
            delta = (xs[i] - xs[i - 1]).total_seconds()
            if delta < 0:
                inv += 1
            elif delta == 0:
                dup += 1
    return len(seq), events, inv, dup

overall_ok = True
for run in RUNS:
    d = resolve(run)
    path = os.path.join(d, "server_full.out")
    label = os.path.basename(os.path.normpath(d)) or run
    print("=== %s ===" % label)
    if not os.path.isfile(path):
        sys.stderr.write("analyze_results_order.py: missing %s\n" % path)
        sys.exit(2)
    n1, e1, i1, d1 = analyze(path, "Processing tick")
    n2, e2, i2, d2 = analyze(path, "Tick processed")
    print("  'Processing tick' order: inversions=%d duplicates=%d  (across %d rules, %d events)" % (i1, d1, n1, e1))
    print("  'Tick processed'  order: inversions=%d duplicates=%d  (across %d rules, %d events)  <-- RESULTS ordering" % (i2, d2, n2, e2))
    print("  ALL %d rules: %d result inversions, %d result duplicates (per-rule monotonic)" % (n2, i2, d2))
    # self-validation per run
    if e2 == 0 or n2 == 0:
        print("  FAIL: no 'Tick processed' (results) evidence in %s" % path)
        overall_ok = False
    if i1 or d1 or i2 or d2:
        print("  FAIL: ordering violation (inv/dup) detected in %s" % label)
        overall_ok = False
    print()

if not overall_ok:
    print("OVERALL: FAIL")
    sys.exit(1)
print("OVERALL: PASS - results strictly per-rule monotonic in every run (0 inversions, 0 duplicates)")
sys.exit(0)
```

---

## Q1 — What does the scheduler work on next, and where does the choice first become visible?

**Direct answer.** On every 10 s tick the scheduler re‑synchronises the rule set from the database, computes which rules are *due* this tick, sorts them deterministically by rule UID, spreads them evenly across the interval, and dispatches each due rule's tick to that rule's own goroutine. When a rule's routine is **still busy** with a previous tick, the scheduler does **not** queue the new tick behind the old one — it **drops the older un‑consumed tick and keeps the newest** (drop‑oldest / keep‑newest). The decision *first becomes visible* as the per‑rule warning **`Tick dropped because alert rule evaluation is too slow`** and the increment of the counter **`grafana_alerting_schedule_rule_evaluations_missed_total{org,name}`**. A timing‑out data source additionally surfaces as evaluation retries and, once `max_attempts` is exhausted, as **`grafana_alerting_rule_evaluation_failures_total`**. **[OBSERVED]**

### The mechanism (source), then the observation

Each tick runs `processTick` (`pkg/services/ngalert/schedule/schedule.go:235`): it calls `updateSchedulableAlertRules` to re‑read the DB (`pkg/services/ngalert/schedule/schedule.go:239`; fetch in `fetcher.go`), decides readiness per rule, then for the due set computes `step = baseInterval / len(readyToRun)` (`schedule.go:361`), sorts by UID (`slices.SortFunc`, `schedule.go:364`), and dispatches each rule via `time.AfterFunc(i*step, …)` (`schedule.go:370`). Dispatch calls the rule routine's `Eval` (`pkg/services/ngalert/schedule/alert_rule.go:196`), which sends the tick over the rule's **unbuffered** `evalCh` (`alert_rule.go:161`). If the routine is mid‑evaluation and therefore not receiving, `Eval` first performs a **non‑blocking drain** of the older, still‑blocked sender (`case droppedMsg = <-a.evalCh`, `alert_rule.go:205`) and only then sends the newest tick (`case a.evalCh <- eval`, `alert_rule.go:210`). The scheduler logs the warning (`schedule.go:378`) and increments the missed counter (`schedule.go:380`) **inside the `AfterFunc` callback, only after `Eval` returns**. **[INFERRED]**

### Stressed scenario

Boot healthy (mock `fast`), warm 25 s to a firing steady state, snapshot a **baseline**, then flip the mock to `slow` (the data source "begins to time out") and measure a 180 s window, scraping complete `/metrics` every 15 s. Command: **[OBSERVED]**

```
$ ./run_scenario.sh stress_run1 slow 180 15 25
```

**Headline (two unchanged runs, for stability — Q6/repetition):** **[OBSERVED]**

| window delta (180 s)                | stress_run1 | stress_run2 |
|-------------------------------------|-------------|-------------|
| wall seconds                        | 180.540     | 180.526     |
| ticks (heartbeat)                   | 18          | 18          |
| `rule_evaluations_total`            | 60          | 60          |
| `rule_evaluation_attempts_total`    | 150         | 150         |
| `rule_evaluation_failures_total`    | 30          | 30          |
| `schedule_rule_evaluations_missed_total` | 421    | 422         |
| `Tick dropped` log lines            | 421         | 422         |

**[OBSERVED].** The two runs agree to within one drop (421 vs 422, 0.24 %) on an unchanged input — the signal is stable.

### The arithmetic is consistent (Q‑performance discipline)

For run 1, with 30 rules all due every tick (`itemFrequency = 10s/10s = 1`): **[OBSERVED]**

- **18 ticks / 180.540 s = 10.03 s per tick** — the 10 s base heartbeat. ✓
- **`Tick dropped` log lines = 421 = exactly** the `missed_total` delta (each warning corresponds to one `EvaluationMissed.Inc()`). ✓
- **misses 421 ≤ 30 rules × 18 ticks = 540** upper bound. ✓
- **attempts 150 = 30 fully‑failed × 3 + 30 in‑flight × 2**, and **failures 30** = the rules that exhausted `max_attempts = 3`. ✓
- **measured slow‑eval duration = 1 m 32.008 s = 3 × 30 s eval‑timeout + 2 × 1 s `retryDelay`** (`retryDelay` const, `schedule.go`). ✓ **[OBSERVED]**

### An honest correction: `scheduler_behind_seconds` does *not* rise here

A natural guess is that backpressure shows up as a rising `grafana_alerting_scheduler_behind_seconds`. **It does not.** Across the whole stressed window it stayed near zero (~0.0002–0.0010), the same as under normal load. **[OBSERVED].** The reason **[INFERRED]**: `BehindSeconds.Set(start.Sub(tick))` (`schedule.go:215`) measures how late the *scheduler loop* is to *consume* a tick, set **before** `processTick` runs; because `processTick` only *dispatches* (via non‑blocking `time.AfterFunc`) and the slow evaluations run in separate per‑rule goroutines, the loop itself never blocks. So `schedule_periodic_duration_seconds` also stays sub‑millisecond. The true, observable backpressure signal under a slow data source is the per‑rule **`missed_total` counter + `Tick dropped` warnings**, not `behind_seconds`. (`behind_seconds` would rise only if `processTick` itself blocked — e.g. a slow rule *fetch*.)

### Where the choice first becomes visible — and the chronology

The warning and counter **lag** the internal supersede; they are emitted by the scheduler only after the busy routine's `Eval` returns. **[INFERRED]** The complete per‑rule trace for `blitzyrule000` around the flip (unedited) is shown next. **[OBSERVED]**

```
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=f19a10c3670f913a now=2026-07-14T04:42:10Z t=2026-07-14T04:42:10.00397595Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=f19a10c3670f913a now=2026-07-14T04:42:10Z t=2026-07-14T04:42:10.006323824Z level=debug msg="Alert rule evaluated" results=1 duration=2.285056ms
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=f19a10c3670f913a now=2026-07-14T04:42:10Z t=2026-07-14T04:42:10.051384593Z level=debug msg="Tick processed" attempt=1 duration=47.364783ms
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=f19a10c3670f913a now=2026-07-14T04:42:20Z t=2026-07-14T04:42:20.001415567Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=f19a10c3670f913a now=2026-07-14T04:42:20Z t=2026-07-14T04:42:20.002662561Z level=debug msg="Alert rule evaluated" results=1 duration=1.213648ms
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=f19a10c3670f913a now=2026-07-14T04:42:20Z t=2026-07-14T04:42:20.006458201Z level=debug msg="Tick processed" attempt=1 duration=5.0173ms
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=f19a10c3670f913a now=2026-07-14T04:42:30Z t=2026-07-14T04:42:30.000956055Z level=debug msg="Processing tick"
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=f19a10c3670f913a now=2026-07-14T04:42:30Z t=2026-07-14T04:42:30.002275979Z level=debug msg="Alert rule evaluated" results=1 duration=1.279786ms
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=f19a10c3670f913a now=2026-07-14T04:42:30Z t=2026-07-14T04:42:30.005714837Z level=debug msg="Tick processed" attempt=1 duration=4.725658ms
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=f19a10c3670f913a now=2026-07-14T04:42:40Z t=2026-07-14T04:42:40.001768509Z level=debug msg="Processing tick"
logger=ngalert.scheduler t=2026-07-14T04:43:10.001332803Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=blitzyrule000 org_id=1 time=2026-07-14T04:43:00Z droppedTick=2026-07-14T04:42:50Z
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=f19a10c3670f913a now=2026-07-14T04:42:40Z t=2026-07-14T04:43:10.002641062Z level=error msg="Failed to evaluate rule" attempt=1 error="the result-set has errors that can be retried: [sse.dataQueryError] failed to execute query [A]: Post \"http://127.0.0.1:9199/api/v1/query\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)"
logger=ngalert.scheduler t=2026-07-14T04:43:20.000754535Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=blitzyrule000 org_id=1 time=2026-07-14T04:43:10Z droppedTick=2026-07-14T04:43:00Z
logger=ngalert.scheduler t=2026-07-14T04:43:30.000963633Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=blitzyrule000 org_id=1 time=2026-07-14T04:43:20Z droppedTick=2026-07-14T04:43:10Z
logger=ngalert.scheduler t=2026-07-14T04:43:40.001058577Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=blitzyrule000 org_id=1 time=2026-07-14T04:43:30Z droppedTick=2026-07-14T04:43:20Z
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=f19a10c3670f913a now=2026-07-14T04:42:40Z t=2026-07-14T04:43:41.003873199Z level=error msg="Failed to evaluate rule" attempt=2 error="the result-set has errors that can be retried: [sse.dataQueryError] failed to execute query [A]: Post \"http://127.0.0.1:9199/api/v1/query\": net/http: timeout awaiting response headers (Client.Timeout exceeded while awaiting headers)"
logger=ngalert.scheduler t=2026-07-14T04:43:50.000777908Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=blitzyrule000 org_id=1 time=2026-07-14T04:43:40Z droppedTick=2026-07-14T04:43:30Z
logger=ngalert.scheduler t=2026-07-14T04:44:00.001540454Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=blitzyrule000 org_id=1 time=2026-07-14T04:43:50Z droppedTick=2026-07-14T04:43:40Z
logger=ngalert.scheduler t=2026-07-14T04:44:10.001496209Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=blitzyrule000 org_id=1 time=2026-07-14T04:44:00Z droppedTick=2026-07-14T04:43:50Z
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=f19a10c3670f913a now=2026-07-14T04:42:40Z t=2026-07-14T04:44:12.005172112Z level=debug msg="Alert rule evaluated" error="[sse.dataQueryError] failed to execute query [A]: Post \"http://127.0.0.1:9199/api/v1/query\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)" duration=30.000642358s
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=f19a10c3670f913a now=2026-07-14T04:42:40Z t=2026-07-14T04:44:12.008758995Z level=debug msg="Tick processed" attempt=3 duration=1m32.006977302s
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=f19a10c3670f913a now=2026-07-14T04:44:10Z t=2026-07-14T04:44:12.00877754Z level=debug msg="Processing tick"
logger=ngalert.scheduler t=2026-07-14T04:44:12.00891392Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=blitzyrule000 org_id=1 time=2026-07-14T04:44:10Z droppedTick=2026-07-14T04:44:00Z
logger=ngalert.scheduler t=2026-07-14T04:44:40.001642566Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=blitzyrule000 org_id=1 time=2026-07-14T04:44:30Z droppedTick=2026-07-14T04:44:20Z
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=f19a10c3670f913a now=2026-07-14T04:44:10Z t=2026-07-14T04:44:42.009475075Z level=error msg="Failed to evaluate rule" attempt=1 error="the result-set has errors that can be retried: [sse.dataQueryError] failed to execute query [A]: Post \"http://127.0.0.1:9199/api/v1/query\": net/http: request canceled (Client.Timeout exceeded while awaiting headers)"
logger=ngalert.scheduler t=2026-07-14T04:44:50.001340296Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=blitzyrule000 org_id=1 time=2026-07-14T04:44:40Z droppedTick=2026-07-14T04:44:30Z
logger=ngalert.scheduler t=2026-07-14T04:45:00.001515074Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=blitzyrule000 org_id=1 time=2026-07-14T04:44:50Z droppedTick=2026-07-14T04:44:40Z
logger=ngalert.scheduler t=2026-07-14T04:45:10.001414491Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=blitzyrule000 org_id=1 time=2026-07-14T04:45:00Z droppedTick=2026-07-14T04:44:50Z
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=f19a10c3670f913a now=2026-07-14T04:44:10Z t=2026-07-14T04:45:13.010559164Z level=error msg="Failed to evaluate rule" attempt=2 error="the result-set has errors that can be retried: [sse.dataQueryError] failed to execute query [A]: Post \"http://127.0.0.1:9199/api/v1/query\": net/http: request canceled (Client.Timeout exceeded while awaiting headers)"
logger=ngalert.scheduler t=2026-07-14T04:45:20.001006167Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=blitzyrule000 org_id=1 time=2026-07-14T04:45:10Z droppedTick=2026-07-14T04:45:00Z
logger=ngalert.scheduler t=2026-07-14T04:45:30.001713553Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=blitzyrule000 org_id=1 time=2026-07-14T04:45:20Z droppedTick=2026-07-14T04:45:10Z
```
**[OBSERVED].** Read this top‑to‑bottom: three healthy ticks (`Processing tick` → `Alert rule evaluated` → `Tick processed`, each ~1–47 ms) at `now=04:42:10/20/30`; then the `04:42:40` tick blocks on the now‑slow data source. The first drop warnings for this rule:

```
logger=ngalert.scheduler t=2026-07-14T04:43:10.001332803Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=blitzyrule000 org_id=1 time=2026-07-14T04:43:00Z droppedTick=2026-07-14T04:42:50Z
logger=ngalert.scheduler t=2026-07-14T04:43:20.000754535Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=blitzyrule000 org_id=1 time=2026-07-14T04:43:10Z droppedTick=2026-07-14T04:43:00Z
logger=ngalert.scheduler t=2026-07-14T04:43:30.000963633Z level=warn msg="Tick dropped because alert rule evaluation is too slow" rule_uid=blitzyrule000 org_id=1 time=2026-07-14T04:43:20Z droppedTick=2026-07-14T04:43:10Z
```
**[OBSERVED].** Note the timestamps: the warning is *emitted* at `t=04:43:10.001` but reports `time=04:43:00` and `droppedTick=04:42:50` — the emitted time trails the dropped tick's `scheduledAt` by ~20 s. This is the visible fingerprint of drop‑oldest/keep‑newest: the scheduler announces the drop of an *earlier* tick only once a *later* dispatch drains the busy routine's blocked send. The choice ("work on the newest, discard the stale") is made internally at the `Eval` drain; the log/counter are its downstream, slightly‑delayed shadow.

### Rule *changes* arriving while evaluations are already behind

The question specifically asks about many rule *changes* arriving *while* the system is behind. The scheduler re‑reads the database **every tick**, so new/changed/removed rules are picked up at the very next tick even mid‑backlog. During a window with 30 `Tick dropped` warnings in flight, rules were changed and added through the real API. The per‑tick re‑sync is visible in `Alert rules fetched` (`fetcher.go`): **[OBSERVED]**

```
logger=ngalert.scheduler t=2026-07-14T07:15:20.003207637Z level=debug msg="Alert rules fetched" rulesCount=31 foldersCount=1 updatedRules=0
logger=ngalert.scheduler t=2026-07-14T07:16:30.003862265Z level=debug msg="Alert rules fetched" rulesCount=34 foldersCount=1 updatedRules=31
```
**[OBSERVED].** Between these two ticks the rule set grew (`rulesCount 31 → 34`) and `updatedRules=31` — the scheduler re‑decided "what to consider" while already dropping ticks. A *file*‑provisioned change is applied via reload (the canonical path):

```
$ ./api.sh POST /api/admin/provisioning/alerting/reload
{"message":"Alerting config reloaded"}
```
**[OBSERVED].** A rule that is updated but **not due** on the current tick is notified through the routine's **update mailbox** (`schedule.go:337`, the `isUpdated && !isReadyToRun` branch → `Update()` → `updateCh`, `alert_rule.go:218/251`), which clears the rule's in‑memory state so the next evaluation uses the new definition:

```
logger=ngalert.scheduler rule_uid=blitzylong0 org_id=1 t=2026-07-14T07:23:50.003727191Z level=debug msg="Rule has been updated. Notifying evaluation routine"
logger=ngalert.scheduler rule_uid=blitzylong0 org_id=1 t=2026-07-14T07:23:50.003814664Z level=info msg="Clearing the state of the rule because it was updated" isPaused=false fingerprint=3865e55eb1fbab71
```
**[OBSERVED]** (`Rule has been updated. Notifying evaluation routine` → `Clearing the state of the rule because it was updated`). Newly **added** rules get a brand‑new goroutine via the registry (`alert_rule.go:244`, `Alert rule routine started`):

```
logger=ngalert.scheduler rule_uid=blitzynew90 org_id=1 t=2026-07-14T07:16:30.004211371Z level=debug msg="Alert rule routine started"
logger=ngalert.scheduler rule_uid=blitzynew91 org_id=1 t=2026-07-14T07:16:30.004193984Z level=debug msg="Alert rule routine started"
logger=ngalert.scheduler rule_uid=blitzynew92 org_id=1 t=2026-07-14T07:16:30.004220206Z level=debug msg="Alert rule routine started"
```
**[OBSERVED].** (Rules that *are* due every tick — the 10 s rules — simply absorb the newer version through `evalCh` on their next tick and need no `updateCh` message.)

---

## Q2 — Cancellation vs. deletion vs. restart: does anything get left behind?

**Direct answer.** They are three *distinct* outcomes and the runtime tells them apart: **[OBSERVED]**

1. **Rule deleted mid‑flight** → the system **cleans up the rule's live footprint**: in‑memory state reset, resolve notifications sent, **database rows removed**, routine stopped. The one thing **deliberately left behind** is the rule's *cumulative* Prometheus counter series `grafana_alerting_schedule_rule_evaluations_missed_total{name=<title>,org=<id>}` — a `CounterVec` label series that is only ever `.Inc()`'d (`schedule.go:380`) and never deleted, so it keeps its last value after the rule is gone (proven below). So the honest answer is *"the live footprint is fully cleaned; one cumulative metric label series persists by design."*
2. **Evaluation context cancelled** (e.g. server shutdown mid‑evaluation) → the in‑flight result is **discarded**, **existing state is preserved** (not reset), and the routine simply exits — no cleanup, no resolve.
3. **Rule restarted** (its *type* changed) → a **new routine for the same UID** is started **first** and the old routine is stopped at the end of the same tick (start‑before‑stop, not atomic); state is **not** reset (it is retained, though the new routine does not consume the old alert state). **[OBSERVED]**

Each has a different, observable log/DB signature, shown below. All three were run at least twice; the signatures were identical across runs. **[OBSERVED]**

### (1) Deletion — `errRuleDeleted`

An API‑provenance rule `blitzydel0` (title `blitzy-del-0`) was created and put on the 10 s cadence — `POST /api/v1/provisioning/alert-rules → 201`, then `PUT …/folder/blitzydelfold/rule-groups/blitzy-del-grp {"interval":10} → 200` (the interval is a *group* property; a fresh group otherwise defaults to 60 s, which is why the group `PUT` is required). It was warmed under the healthy mock so it fires (one `Alerting` row), the mock was then flipped to `slow` so the rule drops a few ticks (its `missed_total` climbs), and finally it was deleted (`DELETE /api/v1/provisioning/alert-rules/blitzydel0 → 204`). **[OBSERVED]** Two things were captured **before** and **after** the delete: the rule's cumulative drop counter (scraped from `/metrics`) and the **real SQLite store** (queried read‑only via Python's `sqlite3`, since the `sqlite3` CLI is absent on the host). The `q2_delete.sh` driver composes the embedded `api.sh`, `start.sh`, mode‑flip, and `db_state.py` primitives; the two producing commands were:

```
# cumulative drop counter for the rule (scraped from /metrics)
curl -sS "http://127.0.0.1:${GF_HTTP_PORT}/metrics" \
  | grep '^grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-del-0"'
# real SQLite store, read-only (sqlite3 CLI absent on host, so Python's sqlite3);
# db_state.py runs: SELECT count(*), current_state, max(last_eval_time)
#                   FROM alert_instance WHERE rule_uid='blitzydel0'
python3 db_state.py "${GF_PATHS_DATA}/grafana.db" blitzydel0
```

Their combined **before/after** output (run 1): **[OBSERVED]**

```
== BEFORE delete ==
-- missed_total{name=blitzy-del-0} (expect >0) --
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-del-0",org="1"} 2
-- DB (expect Alerting rows>=1) --
rule_uid=blitzydel0 rows=1 by_state=[('Alerting', 1)] last_eval_time=1784006150 total_alert_instance=31
== AFTER delete (submitted 2026-07-14T05:16:44.846407132Z) ==
-- missed_total{name=blitzy-del-0} (expect SAME value; cumulative CounterVec) --
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-del-0",org="1"} 2
-- DB (expect rows=0) --
rule_uid=blitzydel0 rows=0 by_state=[] last_eval_time=None total_alert_instance=30
```
**[OBSERVED].** Two distinct outcomes in the *same* delete: the **live footprint is gone** — `blitzydel0` went from **1 `Alerting` row → 0 rows** (`total_alert_instance 31 → 30`) — **but the cumulative counter series `…missed_total{name="blitzy-del-0",org="1"}` is unchanged at `2`**; it survives the deletion. Run 2 behaved identically with `missed_total = 3 → 3`. The absolute count differs run‑to‑run (2 vs 3) because it depends on how many ticks were dropped before the delete, but the *persistence across the delete* is invariant across both runs. The delete path emits, all within the single delete tick:

```
logger=ngalert.state.manager rule_uid=blitzydel0 org_id=1 t=2026-07-14T05:16:50.003358149Z level=debug msg="Resetting state of the rule"
logger=ngalert.state.manager rule_uid=blitzydel0 org_id=1 t=2026-07-14T05:16:50.003441031Z level=info msg="Rules state was reset" states=1
logger=ngalert.sender.router rule_uid=blitzydel0 org_id=1 t=2026-07-14T05:16:50.003454865Z level=info msg="Sending alerts to local notifier" count=1
logger=ngalert.scheduler rule_uid=blitzydel0 org_id=1 t=2026-07-14T05:16:50.003488121Z level=debug msg="Stopping alert rule routine"
```
**[OBSERVED].** Reading the four lines in order: `Resetting state of the rule` (`state/manager.go:238`, inside `DeleteStateByRuleUID` declared at `state/manager.go:236`) → `Rules state was reset states=1` (`state/manager.go:278`) → `Sending alerts to local notifier count=1` (the **resolve** notification for the one firing instance) → `Stopping alert rule routine` (`alert_rule.go:358`). The stop is triggered by `deleteAlertRule` (`schedule.go:183`) calling `ruleRoutine.Stop(errRuleDeleted)` (`schedule.go:198`, sentinel `registry.go:19`); the routine's `errRuleDeleted` branch (`alert_rule.go:349`) runs `DeleteStateByRuleUID(…, StateReasonRuleDeleted)` (`alert_rule.go:355`) under a bounded 1‑minute context. **[INFERRED]** the underlying SQL is a `DELETE FROM alert_instance WHERE rule_org_id=? AND rule_uid=?`; **[OBSERVED]** is the row‑count change `1 → 0`. Why the counter persists: `EvaluationMissed` is a `*prometheus.CounterVec` whose only mutation anywhere in the source is `.Inc()` at `schedule.go:380` — there is no `.Delete`/`.Reset` of the label series on the delete path (or anywhere), so once a `{name,org}` series exists it lingers at its last value for the process lifetime. That cumulative series is the one artifact "left behind."

### (2) Context cancellation — state preserved, routine exits

With 30 rules firing (30 `Alerting` rows) and evaluations in flight against the slow data source, the server was stopped with `SIGTERM` (graceful shutdown → the parent `grafanaCtx` is cancelled) sent to its **captured PID** (never `pkill`). The **real SQLite store** was read from the file before the shutdown and again after the process had exited: **[OBSERVED]**

```
== BEFORE shutdown (fast warm) ==
by_state=[('Alerting', 30)] total=30
== AFTER shutdown (DB read from file) ==
by_state=[('Alerting', 30)] total=30
```
**[OBSERVED].** **30 `Alerting` → 30 `Alerting`, total 30 → 30 — nothing was reset or removed.** Mid‑evaluation routines logged (one representative line of 30):

```
logger=ngalert.scheduler rule_uid=blitzyrule014 org_id=1 version=2 fingerprint=3f78a517e0534f84 now=2026-07-14T05:42:40Z t=2026-07-14T05:42:51.291485081Z level=debug msg="Skip updating the state because the context has been cancelled"
```
**[OBSERVED]** — `Skip updating the state because the context has been cancelled` (`alert_rule.go:393`). Signature counts for this run: **30** `Skip updating…` lines, **30** `Stopping alert rule routine`, and **0** `Rules state was reset` (run 2 identical: `30 / 30 / 0`). This is the crucial contrast with deletion: a plain parent‑context cancel **exits the routines without any state cleanup or resolve** — the in‑flight evaluation result is discarded and the previously persisted state stands. 

### (2b) Child evaluation‑timeout — retry, survive, recover (NOT a cancellation of the routine)

There is a *third* "cancellation‑looking" event that is easy to conflate with the parent cancel above but is fundamentally different: the **child** evaluation‑timeout context. Each evaluation is wrapped in its own `context.WithTimeout(ctx, r.evalTimeout)` (`eval/eval.go:74`, default `evaluation_timeout = 30s`, `conf/defaults.ini:1339`). When the data source is slow, *that child* deadline fires — but it does **not** cancel the rule's parent context, so the routine does not take the "Skip updating…" exit; instead the data‑source query returns a **retryable** error, the routine logs `Failed to evaluate rule` and **retries** (up to `max_attempts = 3`, `conf/defaults.ini:1342`), and the routine **survives**. This was exercised as its own scenario: track the provisioned rule `blitzyrule000`, snapshot it while healthy (**before**), flip the mock to `slow` (**during**), then flip back to healthy and poll until it re‑evaluates (**after**). Run 1: **[OBSERVED]**

```
== BEFORE (fast, healthy) ==
rule_uid=blitzyrule000 rows=1 by_state=[('Alerting', 1)] last_eval_time=1784006770 total_alert_instance=30
reset=0 stop=0 cancel=0            # counts of "Rules state was reset" / "Stopping alert rule routine" / "Skip updating…"
== DURING (slow: child eval-timeout) ==
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=29c3ef4e3f408e0c now=2026-07-14T05:26:20Z t=2026-07-14T05:26:50.002851603Z level=error msg="Failed to evaluate rule" attempt=1 error="the result-set has errors that can be retried: [sse.dataQueryError] failed to execute query [A]: Post \"http://127.0.0.1:9199/api/v1/query\": net/http: timeout awaiting response headers (Client.Timeout exceeded while awaiting headers)"
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=29c3ef4e3f408e0c now=2026-07-14T05:26:20Z t=2026-07-14T05:27:21.004915279Z level=error msg="Failed to evaluate rule" attempt=2 error="the result-set has errors that can be retried: [sse.dataQueryError] failed to execute query [A]: Post \"http://127.0.0.1:9199/api/v1/query\": net/http: timeout awaiting response headers (Client.Timeout exceeded while awaiting headers)"
'Rule is ready to run' AFTER slow began (count) = 8      # routine still taking ticks
reset=0 stop=0 cancel=0                                   # NOT a delete, NOT a parent-cancel
rule_uid=blitzyrule000 rows=1 by_state=[('Alerting', 1)] last_eval_time=1784006770   # state preserved (unchanged)
== AFTER (fast again: recovery) ==
rule_uid=blitzyrule000 rows=1 by_state=[('Alerting', 1)] last_eval_time=1784006870
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=29c3ef4e3f408e0c now=2026-07-14T05:26:20Z t=2026-07-14T05:27:52.009434806Z level=debug msg="Tick processed" attempt=3 duration=1m32.007750605s
logger=ngalert.scheduler rule_uid=blitzyrule000 org_id=1 version=2 fingerprint=29c3ef4e3f408e0c now=2026-07-14T05:27:50Z t=2026-07-14T05:27:52.021045605Z level=debug msg="Tick processed" attempt=1 duration=11.569257ms
T1(last_eval_time before)=1784006770   T3(last_eval_time after)=1784006870   # advanced -> re-evaluated
```
**[OBSERVED].** The child timeout produces two `Failed to evaluate rule` errors — `attempt=1` then `attempt=2`, each `net/http: timeout awaiting response headers (Client.Timeout exceeded while awaiting headers)` (the exact wording of the wrapped error varies run‑to‑run between `context deadline exceeded`, `timeout awaiting response headers`, and `request canceled` depending on where the 30 s deadline lands relative to the HTTP client's own read; all three are the same retryable data‑source timeout) — a **retryable** error, not the `Skip updating…` path. Throughout the slow window the routine keeps taking ticks (**8** `Rule is ready to run` lines after `slow` began) and the three "termination" counters stay at **`reset=0 stop=0 cancel=0`**: no state reset, no routine stop, no parent‑context cancel. The `Alerting` row and `last_eval_time` are **unchanged during** the outage (the failing attempts do not overwrite the last good state until the retry budget is exhausted). Once healthy again, `Tick processed attempt=3 duration=1m32s` shows the exhausted 3×~30 s retry cycle finally completing (writing an `Error` result), immediately followed by `Tick processed attempt=1 duration=11.6 ms` — a fresh, first‑attempt **success** — and `last_eval_time` advances `1784006770 → 1784006870`. Run 2 was identical (`8`/`7` ready ticks, `reset=0 stop=0 cancel=0`, recovery `attempt=3 1m32s` then `attempt=1 ~10 ms`, `last_eval_time 1784006910 → 1784007010`). So the three flavors are cleanly distinguishable at runtime: **child eval‑timeout ⇒ retry + survive + recover** (`Failed to evaluate rule`, `eval/eval.go:74`); **parent cancel ⇒ discard + exit, state preserved** (`Skip updating the state because the context has been cancelled`, `alert_rule.go:393`); **deletion ⇒ cleanup + exit** (`Rules state was reset` + `Stopping alert rule routine`, cause `errRuleDeleted`).

### (3) Restart — `errRuleRestarted` (rule type changed)

`errRuleRestarted` (`registry.go:20`) is triggered when a rule's *type* changes (alerting ↔ recording). The mechanism is deliberate and **not atomic** — the source comment states it outright: `processTick` detects `item.Type() != ruleRoutine.Type()` (`schedule.go:293`), logs `Rule restarted because type changed` (`schedule.go:295`), removes the old registry entry (`sch.registry.del`, `schedule.go:297`) and creates the replacement (`sch.registry.getOrCreate`, `schedule.go:298`), then **starts the new routine immediately** (`dispatcherGroup.Go(func() error { return ruleRoutine.Run() })`, `schedule.go:302–303`, guarded by `if newRoutine` at `:301`). The old routine is **not** stopped here; per the comment at `schedule.go:294` — *"For now we just replace them, we'll shut them down at the end of the tick"* — it is stopped only after the whole dispatch loop finishes, in `for _, oldRoutine := range restartedRules { oldRoutine.Stop(errRuleRestarted) }` (`schedule.go:387`). So the order is **start‑the‑new‑then‑stop‑the‑old**, with a brief window in which both coexist. **[INFERRED]**

To observe it, the recording‑rules subsystem was enabled the canonical way (config, not a bypass): `GF_FEATURE_TOGGLES_ENABLE=grafanaManagedRecordingRules`, `GF_RECORDING_RULES_ENABLED=true`, `GF_RECORDING_RULES_URL=http://127.0.0.1:9199/api/prom/push` (the mock accepts the POST; the remote‑write writer's success is irrelevant to the *routine lifecycle* being observed, and `ngalert.go:366–368` force‑disables the feature only when the toggle is off — with it on, `RecordingRules.Enabled=true` stands). Startup confirms it: **[OBSERVED]**

```
logger=settings level=info msg="Config overridden from Environment variable" var="GF_FEATURE_TOGGLES_ENABLE=grafanaManagedRecordingRules"
logger=featuremgmt level=info msg=FeatureToggles grafanaManagedRecordingRules=true …
```

A rule `blitzyrestart0` was provisioned as *alerting* (fires → one `Alerting` row), then reloaded as a *recording* rule (same UID, gains a `record{metric,from}`, drops the threshold condition → its `Type()` changes). Its lifecycle, sorted by the emitted timestamp (run 1): **[OBSERVED]**

```
logger=ngalert.scheduler rule_uid=blitzyrestart0 org_id=1 t=2026-07-14T05:32:50.003316565Z level=debug msg="Rule restarted because type changed" old=alerting new=recording
logger=ngalert.scheduler rule_uid=blitzyrestart0 org_id=1 t=2026-07-14T05:32:50.003419393Z level=debug msg="Recording rule routine started"
logger=ngalert.scheduler rule_uid=blitzyrestart0 org_id=1 t=2026-07-14T05:32:50.003457066Z level=debug msg="Stopping alert rule routine"
```
**[OBSERVED].** Within one `processTick` the scheduler logs, in this exact time order: `Rule restarted because type changed old=alerting new=recording` (`schedule.go:295`) → `Recording rule routine started` (the **new** routine, `recording_rule.go:124`, started at `schedule.go:302–303`) → `Stopping alert rule routine` (the **old** routine, `alert_rule.go:358`, stopped by `Stop(errRuleRestarted)` at `schedule.go:387`). The new routine's start therefore **precedes** the old routine's stop — measured gap `rec_start → alert_stop` = **38.0 µs** in run 1 and **177.0 µs** in run 2 (both sub‑millisecond, but a real, ordered, *non‑atomic* interval, not a single indivisible swap; the exact width varies with how much dispatch work remains in the tick after the replacement). The new routine takes over the **same UID** (registry replacement) on the 10 s cadence. Critically, `Rules state was reset` count for this rule was **0** in **both** runs — **restart does not clean state** (the `DeleteStateByRuleUID` cleanup is gated on `errRuleDeleted`, `alert_rule.go:349/:355`, and the restart cause is `errRuleRestarted`), which is the sharp contrast with deletion. Because the replacement is a *recording* routine it does not consume the retained alert state — the state is **retained‑but‑not‑consumed**.

---

## Q3 — Do evaluation results ever appear out of order?

**Direct answer.** **No.** For each rule, evaluations are processed and completed in strict `scheduledAt` order. Across two independent stressed runs there were **0 inversions and 0 duplicates** over all 30 rules, in both the start stream (`Processing tick`) and — the one that actually answers "results out of order" — the completion stream (`Tick processed`). When the system falls behind, skipped ticks show up as **forward gaps** (the routine jumps to the newest pending tick), never as a backwards step. **[OBSERVED]**

### Why ordering holds (source), then the observation

Each rule owns **one** goroutine reading its **own unbuffered** `evalCh` (`alert_rule.go:161`). `Eval` keeps at most one pending tick by draining any superseded older tick before sending the newest (`alert_rule.go:205/210`). So a rule can never have two ticks queued out of order — it processes them strictly serially, always newest‑wins, and a dropped tick is simply never processed. The recording‑rule routine uses the *same* mailbox pattern (`recording_rule.go:100/105`), so the guarantee is uniform across rule types. **[INFERRED]**

### The measurement (both stressed runs, at DEBUG, stable UIDs)

Command (per run):

```
$ python3 analyze_ordering.py stress_run1/server_full.out "STRESS RUN 1"
$ python3 analyze_results_order.py    # both runs, both streams
```

Result across both runs and both streams (complete output):

```
=== stress_run1 ===
  'Processing tick' order: inversions=0 duplicates=0  (across 30 rules, 128 events)
  'Tick processed'  order: inversions=0 duplicates=0  (across 30 rules, 98 events)  <-- RESULTS ordering
  ALL 30 rules: 0 result inversions, 0 result duplicates (per-rule monotonic)

=== stress_run2 ===
  'Processing tick' order: inversions=0 duplicates=0  (across 30 rules, 130 events)
  'Tick processed'  order: inversions=0 duplicates=0  (across 30 rules, 100 events)  <-- RESULTS ordering
  ALL 30 rules: 0 result inversions, 0 result duplicates (per-rule monotonic)

OVERALL: PASS - results strictly per-rule monotonic in every run (0 inversions, 0 duplicates)
```
**[OBSERVED].** Zero inversions and zero duplicates in the **`Tick processed`** (results) stream for all 30 rules in both runs — results never appear out of order.

### What a dropped tick looks like (a gap, not a reordering)

The per‑rule `Processing tick` sequence for `blitzyrule000` and `blitzyrule015` (run 1), and the full per‑rule inversion/gap table:

```
################ STRESS RUN 1 ################
-- blitzyrule000: 'Processing tick' (t_emit -> now=scheduledAt) --
   t=2026-07-14T04:42:10.00397595Z  now=2026-07-14T04:42:10
   t=2026-07-14T04:42:20.001415567Z  now=2026-07-14T04:42:20
   t=2026-07-14T04:42:30.000956055Z  now=2026-07-14T04:42:30
   t=2026-07-14T04:42:40.001768509Z  now=2026-07-14T04:42:40
   t=2026-07-14T04:44:12.00877754Z  now=2026-07-14T04:44:10  <== GAP +90s (8 dropped)

-- blitzyrule015: 'Processing tick' (t_emit -> now=scheduledAt) --
   t=2026-07-14T04:42:15.00471967Z  now=2026-07-14T04:42:10
   t=2026-07-14T04:42:25.001611762Z  now=2026-07-14T04:42:20
   t=2026-07-14T04:42:35.001657897Z  now=2026-07-14T04:42:30
   t=2026-07-14T04:44:07.049756348Z  now=2026-07-14T04:44:00  <== GAP +90s (8 dropped)

-- per-rule: (n_processing, inversions, gaps) --
   blitzyrule000: n= 5 inv=0 gap=1
   blitzyrule001: n= 5 inv=0 gap=1
   blitzyrule002: n= 5 inv=0 gap=1
   blitzyrule003: n= 5 inv=0 gap=1
   blitzyrule004: n= 5 inv=0 gap=1
   blitzyrule005: n= 5 inv=0 gap=1
   blitzyrule006: n= 5 inv=0 gap=1
   blitzyrule007: n= 5 inv=0 gap=1
   blitzyrule008: n= 4 inv=0 gap=1
   blitzyrule009: n= 4 inv=0 gap=1
   blitzyrule010: n= 4 inv=0 gap=1
   blitzyrule011: n= 4 inv=0 gap=1
   blitzyrule012: n= 4 inv=0 gap=1
   blitzyrule013: n= 4 inv=0 gap=1
   blitzyrule014: n= 4 inv=0 gap=1
   blitzyrule015: n= 4 inv=0 gap=1
   blitzyrule016: n= 4 inv=0 gap=1
   blitzyrule017: n= 4 inv=0 gap=1
   blitzyrule018: n= 4 inv=0 gap=1
   blitzyrule019: n= 4 inv=0 gap=1
   blitzyrule020: n= 4 inv=0 gap=1
   blitzyrule021: n= 4 inv=0 gap=1
   blitzyrule022: n= 4 inv=0 gap=1
   blitzyrule023: n= 4 inv=0 gap=1
   blitzyrule024: n= 4 inv=0 gap=1
   blitzyrule025: n= 4 inv=0 gap=1
   blitzyrule026: n= 4 inv=0 gap=1
   blitzyrule027: n= 4 inv=0 gap=1
   blitzyrule028: n= 4 inv=0 gap=1
   blitzyrule029: n= 4 inv=0 gap=1
   TOTAL inversions=0  gaps=30  (events=128, rules=30)
PASS: ordering preserved (0 inversions across 30 rules, 128 events; gaps=30 are forward drops, not reorderings)
```
**[OBSERVED].** `blitzyrule000` runs `now=04:42:10 → 20 → 30` at exactly +10 s each (healthy), then its `04:42:40` evaluation blocks ~92 s on the slow data source; when it returns, the routine processes the **newest pending** tick `now=04:44:10` — a **forward gap of +90 s (8 ticks dropped)**, never a step backwards. Every one of the 30 rules shows `inv=0` with exactly one gap (**TOTAL inversions=0, gaps=30**). `blitzyrule015` shows the identical shape offset by ~5 s — that offset is the scheduler's intra‑tick *step* spreading (see Q5), not a reordering.

**Scope of the claim.** The guarantee is **per‑rule**: each rule's own results are strictly ordered. Across *different* rules, evaluations interleave by design (the step spread) — that is intentional staggering, not an ordering violation. **[INFERRED]** The observable behavior that demonstrates preserved ordering is exactly the monotonic `now=` progression above, with drops appearing only as forward gaps. **[OBSERVED]**

---

## Q6 — What visibly changes under normal load (and during recovery)?

**Direct answer.** The **heartbeat is unchanged** — the same 10 s tick, the same 18 ticks in a 180 s window — but under normal load the system does **~9× the evaluation work with none of the loss**: **541 vs 60** evaluations, **0 vs 421** drops, **0 vs 30** failures, and an average evaluation time of **6.6 ms vs 28.2 s**. Recovery was demonstrated **within a single process**: when the data source becomes healthy again, the cumulative drop/failure counters **freeze at their peak (they do not reset)** while evaluation throughput resumes and the drop cadence stops. **[OBSERVED]**

### Normal baseline — two unchanged runs, identical provisioning

```
$ ./run_scenario.sh normal_run1 fast 180 15 25
```

| window delta (180 s)                | normal_run1 | normal_run2 | (stress_run1) |
|-------------------------------------|-------------|-------------|---------------|
| wall seconds                        | 180.526     | 180.532     | 180.540       |
| ticks (heartbeat)                   | 18          | 18          | 18            |
| `rule_evaluations_total`            | 541         | 541         | 60            |
| `rule_evaluation_attempts_total`    | 541         | 541         | 150           |
| `rule_evaluation_failures_total`    | 0           | 0           | 30            |
| `schedule_rule_evaluations_missed_total` | 0      | 0           | 421           |
| `Tick dropped` log lines            | 0           | 0           | 421           |
| avg `rule_evaluation_duration_seconds` | 0.0066 s | 0.0061 s    | 28.17 s       |

**[OBSERVED].** The two normal runs are identical on every counter (541/541/0/0), confirming stability. Same tick count as stressed (18) — the scheduler heartbeat is load‑independent — but every rule evaluates every tick (30 × 18 = 540 ≈ 541) instead of a handful. (Window deltas are computed against the flip‑moment baseline; the absolute cumulative `rule_evaluations_total` at end of run — 610 for `normal_run1` — includes the ~69 warm‑up evaluations before the window opened, which is why the duration‑histogram count above is 610 while the window delta is 541.)

### The evaluation‑duration histogram makes the contrast concrete

Parsed (`le` bucket + cumulative count) from the end‑of‑run `metrics_final.txt` of each scenario; the raw, byte‑for‑byte exposition of the normal histogram is in the Q5 "complete metric exposition" block above. **[OBSERVED]**

```
# NORMAL run1 (normal_run1) — rule_evaluation_duration_seconds
le=  0.01  582
le=   0.1  609
le=   0.5  610
le=     1  610
le=     5  610
le=    10  610
le=    15  610
le=    30  610
le=    60  610
le=   120  610
le=   180  610
le=   240  610
le=   300  610
le=  +Inf  610
count=610  sum=4.018300783s  avg=0.006587s

# STRESSED run1 (stress_run1) — rule_evaluation_duration_seconds
le=  0.01  61
le=   0.1  68
le=   0.5  68
le=     1  68
le=     5  68
le=    10  68
le=    15  68
le=    30  68
le=    60  68
le=   120  98
le=   180  98
le=   240  98
le=   300  98
le=  +Inf  98
count=98  sum=2760.9129508s  avg=28.172581s
```
**[OBSERVED].** Read these with Prometheus **`le` (≤, cumulative)** bucket semantics: `le="0.5"` is the number of evaluations whose duration was **≤ 0.5 s**, and the number that **exceeded** 0.5 s is `count − bucket(le=0.5)`. Under normal load in `normal_run1` that is `610 − 610 = 0` — **all 610 evaluations finished in ≤ 0.5 s**, and **582 of 610 finished in ≤ 10 ms** (`le="0.01"`); the average is `sum/count = 4.0183 / 610 = 6.6 ms`. This held across **all four unchanged normal runs** — `le="0.5"` equalled the count in every one (610/610, 612/612, 599/599, 617/617), so **0 of the 2 438 normal‑load evaluations exceeded 0.5 s**. The `le` semantics matter precisely because a *single* straggler — which host GC/scheduling jitter can produce — surfaces as `le="0.5" = count − 1` (for example `616` against a count of `617`), and that **must** be read as "616 finished ≤ 0.5 s, one landed in (0.5, 1.0]", **never** as "all 617 finished under 0.5 s". **[OBSERVED for the four‑run distribution; the straggler reading is the correct arithmetic interpretation of the `le` buckets, which none of my four runs exhibited.]** Under stress the 68 warm evaluations stay fast (≤ 0.1 s) while the 30 slow ones each land in the `le="120"` bucket (`98 − 68 = 30`) at ~92 s; the sum is arithmetically consistent — **2760.91 s ≈ 30 × 92 s** — and 92 s = 3 × 30 s eval‑timeout + 2 × 1 s retry, i.e. exactly `max_attempts = 3`. (The stressed `avg = sum/count = 28.2 s` depends on how many warm evaluations are already recorded at snapshot time; the stable signal is the 30 slow evaluations at ~92 s, not the average.)

### Same‑process recovery (the counters persist — they do not reset)

Within **one** server process: baseline healthy → flip `slow` (stress) → flip back `fast` (recovery), logging the **absolute cumulative** counters throughout. **[OBSERVED]**

```
$ ./recovery_scenario.sh recovery_run1 120 120 10 25
```

Window summary (run 1; run 2 nearly identical):

```
LABEL=recovery_run1 STRESS_DUR=120 RECOVER_DUR=120 SNAP=10 WARM=25
T_BASELINE_ISO=2026-07-14T07:03:36.265390257Z   (mode=fast)
T_STRESS_FLIP_ISO=2026-07-14T07:03:36.290777037Z  (mode=slow)
T_RECOVER_FLIP_ISO=2026-07-14T07:05:36.812886355Z (mode=fast)
T_END_ISO=2026-07-14T07:07:37.314652826Z
BASELINE     evals=49 failures=0 misses=0 (tick_count=2)
END_STRESS   evals=109 failures=30 misses=242
END_RECOVERY evals=472 failures=30 misses=300
--- PERSISTENCE CHECK (cumulative CounterVecs must NOT reset across recovery) ---
misses:   stress_end=242 -> recovery_end=300  (delta_in_recovery=58)  [expect small => frozen/persisted]
failures: stress_end=30 -> recovery_end=30  (delta_in_recovery=0)  [expect ~0 => frozen/persisted]
evals:    stress_end=109 -> recovery_end=472  (delta_in_recovery=363)  [expect >0 => resumed rising]
```
**[OBSERVED].** Across the recovery flip, `failures` **freeze at 30** immediately (`delta_in_recovery = 0`), and `misses` climb for a brief ~2 tick transition (`delta_in_recovery = 58`, as the last in‑flight slow requests drain) before **freezing at 300**, while `evals` resume rising (`delta_in_recovery = +363`). The full timeline shows the transition — `misses` climbs during `stress`, then flattens in `recovery` while `abs_evals` accelerates:

```
epoch	iso	phase	tick_count	abs_evals	abs_failures	abs_misses	d_evals	d_failures	d_misses	behind	periodic_sum
1784012616.298013371	2026-07-14T07:03:36.300817519Z	stress	2	49	0	0	0	0	0	0.000353077	0.003481889
1784012626.339288629	2026-07-14T07:03:46.342296970Z	stress	3	79	0	0	30	0	0	0.000931183	0.004195104
1784012636.382557686	2026-07-14T07:03:56.384780967Z	stress	4	79	0	0	30	0	0	0.00100107	0.004884438
1784012646.422281152	2026-07-14T07:04:06.424550462Z	stress	5	79	0	1	30	0	1	0.001035909	0.0055407849999999995
1784012656.462628255	2026-07-14T07:04:16.464885948Z	stress	6	79	0	31	30	0	31	0.000338409	0.006185535999999999
1784012666.504198383	2026-07-14T07:04:26.506675033Z	stress	7	79	0	61	30	0	61	0.000462399	0.0070683809999999994
1784012676.544423715	2026-07-14T07:04:36.546843304Z	stress	8	79	0	91	30	0	91	0.000265234	0.007758540999999999
1784012686.584934577	2026-07-14T07:04:46.587207821Z	stress	9	79	0	121	30	0	121	0.000314387	0.00840758
1784012696.627149764	2026-07-14T07:04:56.629415595Z	stress	10	79	0	151	30	0	151	0.000337027	0.009024853999999999
1784012706.667368835	2026-07-14T07:05:06.669796834Z	stress	11	79	0	182	30	0	182	0.000521064	0.009953044
1784012716.707952930	2026-07-14T07:05:16.710359063Z	stress	12	105	26	236	56	26	236	0.000188598	0.010614759999999999
1784012726.746927824	2026-07-14T07:05:26.749829478Z	stress	13	109	30	240	60	30	240	0.000505881	0.011369471999999999
1784012736.820775291	2026-07-14T07:05:36.823193145Z	recovery	14	109	30	242	60	30	242	0.000846323	0.012052903999999998
1784012746.859890776	2026-07-14T07:05:46.862329828Z	recovery	15	134	30	293	85	30	293	0.001082932	0.012665272999999998
1784012756.900461817	2026-07-14T07:05:56.902756290Z	recovery	16	171	30	300	122	30	300	0.000359178	0.013370851999999997
1784012766.941393489	2026-07-14T07:06:06.943846469Z	recovery	17	201	30	300	152	30	300	0.000639164	0.014040274999999998
1784012776.983590985	2026-07-14T07:06:16.986038791Z	recovery	18	231	30	300	182	30	300	0.000617051	0.016339351
1784012787.023324966	2026-07-14T07:06:27.025724384Z	recovery	19	262	30	300	213	30	300	0.000453174	0.016998673
1784012797.062760252	2026-07-14T07:06:37.065496027Z	recovery	20	292	30	300	243	30	300	0.000243108	0.017667123
1784012807.104088484	2026-07-14T07:06:47.106390344Z	recovery	21	322	30	300	273	30	300	0.000317109	0.018313986
1784012817.144755346	2026-07-14T07:06:57.147197255Z	recovery	22	352	30	300	303	30	300	0.000255873	0.018994402
1784012827.186514438	2026-07-14T07:07:07.188961054Z	recovery	23	382	30	300	333	30	300	0.000241448	0.019765674
1784012837.229126516	2026-07-14T07:07:17.231785906Z	recovery	24	412	30	300	363	30	300	0.000748078	0.020430041
1784012847.272316621	2026-07-14T07:07:27.274733415Z	recovery	25	442	30	300	393	30	300	0.000650806	0.021028602
```
**[OBSERVED].** Two things stand out. First, the cumulative counters **persist at their peak in the same process** — this is genuine recovery, not a fresh process zeroing its counters. Second, there is a brief **transition lag**: `misses` keeps climbing (242 → 300) for ~2 ticks after the flip, because in‑flight 35 s‑slow requests must drain before the cadence fully normalises; then the drop cadence stops entirely and `abs_evals` climbs +30/tick (all 30 rules every tick) — full normal throughput restored. `behind_seconds` stayed ~0 throughout, consistent with Q1. Run 2 reproduced the freeze exactly (`END_STRESS misses=241`, `END_RECOVERY misses=300`, `failures 30→30`).

---

## Q4 — Live evidence with rationale

**Direct answer.** Every behavioral claim in this document was **exercised live** against the canonically‑built server and is backed by its **unedited** runtime output with the producing command shown — reproduced in full where practical, and otherwise as a clearly‑labeled **representative excerpt** or a **derived summary** whose producing command/parser is given (never silently trimmed). Magnitude/timing claims were confirmed across **two** unchanged runs (run 1 shown, run 2's key values reported inline; the raw run files for both runs are retained under the scratch dir). The method, in one place: **[OBSERVED]**

- **Canonical path only.** The real `grafana-server` built with `make`/`go build`; the real scheduler, evaluation routine, and state manager; the real Prometheus‑API query path (to a mock data source, which is a legitimate external dependency, not a debug hook); the real HTTP API and the real SQLite store. No debug endpoints, no fallbacks, no synthetic stand‑ins.
- **Observe first.** Each scenario boots the server, drives it (provisioning + authenticated API), scrapes `/metrics` and tails the structured log, and only then is the behavior described.
- **Repeat and reconcile.** Every magnitude/timing claim was run **≥ 2×** on unchanged input (stress ×2, normal ×2, recovery ×2, delete ×2, cancel ×2, restart ×2); the reported values agree across runs (e.g. drops 421 vs 422; recovery freeze 300 vs 300). Every derived rate is checked against captured timestamps and counters so the arithmetic closes (Q1's math box; Q6's histogram sum).
- **Labelled.** Each claim is **[OBSERVED]** or **[INFERRED]**; inferences are cited by `file:line` and, wherever possible, confirmed by a matching observation.

The *rationale* linking evidence to conclusion is given inline in each Q‑section (e.g. why `behind_seconds ≈ 0` yet the system is demonstrably behind; why the drop warning's timestamp trails its `droppedTick`; why deletion resets state but cancellation does not). The per‑finding coverage matrix at the end maps every sub‑question and named mechanism to where it is answered. **[OBSERVED]**

---

## Q5 — The signals, identifiers, and timing that stand out

**Direct answer.** Under load the signals that matter are: the **`Tick dropped …` warning** and its counter **`grafana_alerting_schedule_rule_evaluations_missed_total{org,name}`** (the true backpressure signal), the **`rule_evaluation_failures_total{org}`** counter (data‑source timeouts exhausting retries), and the **`rule_evaluation_duration_seconds`** histogram (evaluations piling into the ~92 s bucket). The identifiers that tie everything together are the **rule UID** (`rule_uid` in logs), the **org id** (`org_id` in logs, `org` label in metrics), and the **rule title** (`name` label in metrics). The rhythm is a **10 s heartbeat** with an intra‑tick **~0.333 s step** between rules; jitter is **0** for these rules. **[OBSERVED]**

### One rule, three surfaces — the identifier join

```
# (1) provisioning definition (prov/alerting/rules.yaml), rule blitzyrule007
group=blitzy-stress-group folder=blitzy-folder interval=10s orgId=1
uid=blitzyrule007 title=blitzy-rule-007 condition=C
# (2) log lines (carry rule_uid + org_id)
logger=ngalert.scheduler rule_uid=blitzyrule007 org_id=1 t=2026-07-14T04:42:10.003551308Z level=debug msg="Rule is ready to run on the current tick" tick=2026-07-14T04:42:10Z frequency=1 offset=0
logger=ngalert.scheduler rule_uid=blitzyrule007 org_id=1 t=2026-07-14T04:42:10.003625184Z level=debug msg="Alert rule routine started"
# (3) metric series (carry name=title + org)
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-007",org="1"} 14
```
**[OBSERVED].** Provisioning `uid=blitzyrule007` → log `rule_uid=blitzyrule007`; provisioning `title=blitzy-rule-007` → metric label `name="blitzy-rule-007"`; `orgId=1` → log `org_id=1` = metric label `org="1"`. The log context is built by `AlertRuleKey.LogContext()` → `{"rule_uid", UID, "org_id", OrgID}` (`pkg/services/ngalert/models/alert_rule.go:460-461`). **[INFERRED for the source of the fields; OBSERVED for the values.]**

### Complete metric exposition (HELP/TYPE) of every series used

This is the **complete** exposition (full `# HELP`, `# TYPE`, and **every** sample line — all histogram buckets plus `_sum`/`_count`) of each `grafana_alerting_*` family this investigation uses. It is the verbatim end‑of‑run scrape from `normal_run1` (`runs/normal_run1/metrics_final.txt`), extracted with: **[OBSERVED]**

```
$ for fam in scheduler_behind_seconds rule_evaluations_total \
      rule_evaluation_failures_total rule_evaluation_attempts_total \
      rule_evaluation_duration_seconds schedule_periodic_duration_seconds \
      schedule_alert_rules ticker_interval_seconds \
      ticker_last_consumed_tick_timestamp_seconds ticker_next_tick_timestamp_seconds; do
    awk -v f="grafana_alerting_$fam" '
      $0 ~ "^# (HELP|TYPE) "f" " {print; next}
      $0 ~ "^"f"(_bucket|_sum|_count)?(\\{| )" {print}
    ' runs/normal_run1/metrics_final.txt
  done
```

```
--- grafana_alerting_scheduler_behind_seconds ---
# HELP grafana_alerting_scheduler_behind_seconds The total number of seconds the scheduler is behind.
# TYPE grafana_alerting_scheduler_behind_seconds gauge
grafana_alerting_scheduler_behind_seconds 0.000729809

--- grafana_alerting_rule_evaluations_total ---
# HELP grafana_alerting_rule_evaluations_total The total number of rule evaluations.
# TYPE grafana_alerting_rule_evaluations_total counter
grafana_alerting_rule_evaluations_total{org="1"} 610

--- grafana_alerting_rule_evaluation_failures_total ---
# HELP grafana_alerting_rule_evaluation_failures_total The total number of rule evaluation failures.
# TYPE grafana_alerting_rule_evaluation_failures_total counter
grafana_alerting_rule_evaluation_failures_total{org="1"} 0

--- grafana_alerting_rule_evaluation_attempts_total ---
# HELP grafana_alerting_rule_evaluation_attempts_total The total number of rule evaluation attempts.
# TYPE grafana_alerting_rule_evaluation_attempts_total counter
grafana_alerting_rule_evaluation_attempts_total{org="1"} 610

--- grafana_alerting_rule_evaluation_duration_seconds ---
# HELP grafana_alerting_rule_evaluation_duration_seconds The time to evaluate a rule.
# TYPE grafana_alerting_rule_evaluation_duration_seconds histogram
grafana_alerting_rule_evaluation_duration_seconds_bucket{org="1",le="0.01"} 582
grafana_alerting_rule_evaluation_duration_seconds_bucket{org="1",le="0.1"} 609
grafana_alerting_rule_evaluation_duration_seconds_bucket{org="1",le="0.5"} 610
grafana_alerting_rule_evaluation_duration_seconds_bucket{org="1",le="1"} 610
grafana_alerting_rule_evaluation_duration_seconds_bucket{org="1",le="5"} 610
grafana_alerting_rule_evaluation_duration_seconds_bucket{org="1",le="10"} 610
grafana_alerting_rule_evaluation_duration_seconds_bucket{org="1",le="15"} 610
grafana_alerting_rule_evaluation_duration_seconds_bucket{org="1",le="30"} 610
grafana_alerting_rule_evaluation_duration_seconds_bucket{org="1",le="60"} 610
grafana_alerting_rule_evaluation_duration_seconds_bucket{org="1",le="120"} 610
grafana_alerting_rule_evaluation_duration_seconds_bucket{org="1",le="180"} 610
grafana_alerting_rule_evaluation_duration_seconds_bucket{org="1",le="240"} 610
grafana_alerting_rule_evaluation_duration_seconds_bucket{org="1",le="300"} 610
grafana_alerting_rule_evaluation_duration_seconds_bucket{org="1",le="+Inf"} 610
grafana_alerting_rule_evaluation_duration_seconds_sum{org="1"} 4.018300783000003
grafana_alerting_rule_evaluation_duration_seconds_count{org="1"} 610

--- grafana_alerting_schedule_periodic_duration_seconds ---
# HELP grafana_alerting_schedule_periodic_duration_seconds The time taken to run the scheduler.
# TYPE grafana_alerting_schedule_periodic_duration_seconds histogram
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="0.1"} 21
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="0.25"} 21
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="0.5"} 21
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="1"} 21
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="2"} 21
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="5"} 21
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="10"} 21
grafana_alerting_schedule_periodic_duration_seconds_bucket{le="+Inf"} 21
grafana_alerting_schedule_periodic_duration_seconds_sum 0.016200402000000003
grafana_alerting_schedule_periodic_duration_seconds_count 21

--- grafana_alerting_schedule_alert_rules ---
# HELP grafana_alerting_schedule_alert_rules The number of alert rules that could be considered for evaluation at the next tick.
# TYPE grafana_alerting_schedule_alert_rules gauge
grafana_alerting_schedule_alert_rules 30

--- grafana_alerting_ticker_interval_seconds ---
# HELP grafana_alerting_ticker_interval_seconds Interval at which the ticker is meant to tick.
# TYPE grafana_alerting_ticker_interval_seconds gauge
grafana_alerting_ticker_interval_seconds 10

--- grafana_alerting_ticker_last_consumed_tick_timestamp_seconds ---
# HELP grafana_alerting_ticker_last_consumed_tick_timestamp_seconds Timestamp of the last consumed tick in seconds.
# TYPE grafana_alerting_ticker_last_consumed_tick_timestamp_seconds gauge
grafana_alerting_ticker_last_consumed_tick_timestamp_seconds 1.78400855e+09

--- grafana_alerting_ticker_next_tick_timestamp_seconds ---
# HELP grafana_alerting_ticker_next_tick_timestamp_seconds Timestamp of the next tick in seconds before it is consumed.
# TYPE grafana_alerting_ticker_next_tick_timestamp_seconds gauge
grafana_alerting_ticker_next_tick_timestamp_seconds 1.78400856e+09
```
**[OBSERVED].** (The `missed_total` series is per‑rule with labels `{name,org}` and only appears once a rule has missed at least one tick — under normal load it is absent because there are no misses.) The scheduler histogram's buckets are `{0.1,0.25,0.5,1,2,5,10}` (`pkg/services/ngalert/metrics/scheduler.go:149`); the evaluation histogram's are `{.01,.1,.5,1,5,10,15,30,60,120,180,240,300}` (`:74`); the missed counter is defined at `:181` with labels `{org,name}` at `:184`.

**Under stress the `missed_total` family is populated** — one series per rule that has skipped a tick. Here is its **complete** block from the stressed scrape (`runs/stress_run1/metrics_final.txt`), extracted with `grep '^grafana_alerting_schedule_rule_evaluations_missed_total' runs/stress_run1/metrics_final.txt | sort`: **[OBSERVED]**

```
# HELP grafana_alerting_schedule_rule_evaluations_missed_total The total number of rule evaluations missed due to a slow rule evaluation.
# TYPE grafana_alerting_schedule_rule_evaluations_missed_total counter
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-000",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-001",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-002",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-003",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-004",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-005",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-006",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-007",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-008",org="1"} 15
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-009",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-010",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-011",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-012",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-013",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-014",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-015",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-016",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-017",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-018",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-019",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-020",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-021",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-022",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-023",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-024",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-025",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-026",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-027",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-028",org="1"} 14
grafana_alerting_schedule_rule_evaluations_missed_total{name="blitzy-rule-029",org="1"} 14
```
**[OBSERVED].** 30 series (one per rule), 29 at `14` and one (`blitzy-rule-008`) at `15`, summing to **421** — exactly the `Tick dropped` warning count for `stress_run1` (Section Q1). This is the `{name,org}` cumulative `CounterVec` whose per‑label series persist for the process lifetime — the same series that, per Q2, is **not** removed when a rule is deleted.

### Timing / rhythm — the 10 s heartbeat, the step spread, and jitter = 0

The heartbeat is directly reported (`grafana_alerting_ticker_interval_seconds 10`) and visible as `Processing tick now=` boundaries exactly 10 s apart. Within a tick, the 30 due rules are dispatched ~0.333 s apart — this is the scheduler **step**, `step = baseInterval / len(readyToRun) = 10 s / 30 = 0.333 s` (`schedule.go:361`, dispatched via `time.AfterFunc(i*step)` `:370`), **not** jitter: **[OBSERVED]**

```
tick now=2026-07-14T04:42:10 (30 rules, sorted by UID)
  blitzyrule000 t=2026-07-14T04:42:10.00397595Z offset=0.004s
  blitzyrule001 t=2026-07-14T04:42:10.337407684Z offset=0.337s step=0.333s
  blitzyrule002 t=2026-07-14T04:42:10.671343785Z offset=0.671s step=0.334s
  blitzyrule003 t=2026-07-14T04:42:11.004854938Z offset=1.005s step=0.334s
  blitzyrule004 t=2026-07-14T04:42:11.337737195Z offset=1.338s step=0.333s
  blitzyrule005 t=2026-07-14T04:42:11.671307414Z offset=1.671s step=0.334s
  blitzyrule006 t=2026-07-14T04:42:12.004778025Z offset=2.005s step=0.333s
  blitzyrule007 t=2026-07-14T04:42:12.337753529Z offset=2.338s step=0.333s
  blitzyrule008 t=2026-07-14T04:42:12.671528813Z offset=2.672s step=0.334s
  blitzyrule009 t=2026-07-14T04:42:13.005013912Z offset=3.005s step=0.333s
  blitzyrule010 t=2026-07-14T04:42:13.337564973Z offset=3.338s step=0.333s
  blitzyrule011 t=2026-07-14T04:42:13.671203726Z offset=3.671s step=0.334s
  blitzyrule012 t=2026-07-14T04:42:14.004692122Z offset=4.005s step=0.333s
  blitzyrule013 t=2026-07-14T04:42:14.337566358Z offset=4.338s step=0.333s
  blitzyrule014 t=2026-07-14T04:42:14.671473934Z offset=4.671s step=0.334s
  blitzyrule015 t=2026-07-14T04:42:15.00471967Z offset=5.005s step=0.333s
  blitzyrule016 t=2026-07-14T04:42:15.337806839Z offset=5.338s step=0.333s
  blitzyrule017 t=2026-07-14T04:42:15.671299447Z offset=5.671s step=0.333s
  blitzyrule018 t=2026-07-14T04:42:16.004765913Z offset=6.005s step=0.333s
  blitzyrule019 t=2026-07-14T04:42:16.337642267Z offset=6.338s step=0.333s
  blitzyrule020 t=2026-07-14T04:42:16.671153393Z offset=6.671s step=0.334s
  blitzyrule021 t=2026-07-14T04:42:17.003988666Z offset=7.004s step=0.333s
  blitzyrule022 t=2026-07-14T04:42:17.337496766Z offset=7.337s step=0.334s
  blitzyrule023 t=2026-07-14T04:42:17.67152141Z offset=7.672s step=0.334s
  blitzyrule024 t=2026-07-14T04:42:18.004266711Z offset=8.004s step=0.333s
  blitzyrule025 t=2026-07-14T04:42:18.33773449Z offset=8.338s step=0.333s
  blitzyrule026 t=2026-07-14T04:42:18.671135023Z offset=8.671s step=0.333s
  blitzyrule027 t=2026-07-14T04:42:19.004869359Z offset=9.005s step=0.334s
  blitzyrule028 t=2026-07-14T04:42:19.338378951Z offset=9.338s step=0.334s
  blitzyrule029 t=2026-07-14T04:42:19.67115839Z offset=9.671s step=0.333s
span first->last = 9.667s across 30 rules => step ~= 0.333s (= 10s / 30)
```
**[OBSERVED].** Measured mean step = **0.3334 s** (theory 0.3333 s); total spread first→last = **9.667 s** (theory 29 × 0.333). And **jitter is 0** for these rules — every rule shares the same `now=` (all due every tick) and the server logs `frequency=1 offset=0` on all 630 `Rule is ready to run on the current tick` lines, exactly as `jitterOffsetInTicks` predicts: `itemFrequency = IntervalSeconds / baseInterval = 10/10 = 1`, so `offset = hash % 1 = 0` (`pkg/services/ngalert/schedule/jitter.go:44-45`). **[OBSERVED]**, confirming the **[INFERRED]** source.

**Pauses and rhythm changes.** As the data source slows, each rule's `Tick processed` stops appearing for ~92 s (the evaluation is blocked), and `Tick dropped` warnings accumulate on the 10 s beat — the visible "pause." On recovery there is a brief transition lag (~2 ticks) while slow requests drain, after which the even 10 s / 0.333 s‑step cadence returns (Q6 timeline). **[OBSERVED]**

---

## Q7 — Repository integrity

**Direct answer.** The repository is left **byte‑for‑byte unchanged except this one document.** Everything the investigation created — the built binary, the mock, the provisioning, the scenario scripts, all captured logs/metrics/SQLite data — lives under a single private scratch directory **outside** the repository tree and is removed at the end. Servers were stopped by their **captured PID only** (never `pkill`/`killall`, which on this shared host could hit unrelated processes). **[OBSERVED]**

Throughout the investigation the **only** path that ever appears in `git status --porcelain` for the repository under test is this one document — `blitzy/documentation/grafana_4550cfb5b728.md`. No build product ever appears there, because the canonical build ran in a **separate, external `git worktree`** (`/tmp/gf-src-4550cfb`, detached at `4550cfb`): `make gen-go`'s one generated *source* file, `pkg/server/wire_gen.go` (94 781 bytes), and the compiled binary both landed **outside** the repository under test, and are removed with the external worktree at teardown. The scratch directory (mock, provisioning, logs, SQLite data, scripts) likewise lives under a private `mktemp -d` path outside the tree. So the single transient write to a *source* path happened only in the external worktree — never in the repository under test. The teardown transcript below — PID‑stops, an inventory that distinguishes the external build products from the (empty) in‑tree ones, the exact removal commands, and the resulting `git status` — was captured live at completion: **[OBSERVED]**

**[OBSERVED]** — captured live during teardown:

```text
# ================================================================
# Teardown transcript - Grafana unified-alerting runtime investigation
# Captured live at completion, AFTER all runs and re-verification.
# The repository UNDER TEST is left byte-for-byte unchanged except
# blitzy/documentation/grafana_4550cfb5b728.md. The canonical build ran
# in a SEPARATE external git worktree, so NO build product exists in the
# repository under test at any point.
#   REPO      = <repository under test>          (branch blitzy-66f97028-...)
#   REPO_SRC  = /tmp/gf-src-4550cfb               (external worktree, detached @ 4550cfb)
#   GFPROBE   = <private mktemp -d scratch dir>   (mock, provisioning, logs, built binary)
# ================================================================

## 1. Stop confirmation (servers stopped by CAPTURED PID via stop.sh; never pkill/killall)
$ ss -ltnH | grep -E ':(3000|9199)\b' || echo 'OK: neither 3000 nor 9199 listening'
OK: neither 3000 nor 9199 listening
$ for pf in caps/grafana.pid caps/mock.pid; do test -f "$GFPROBE/$pf" && echo present || echo "$pf: ABSENT (removed by stop.sh)"; done
caps/grafana.pid: ABSENT (removed by stop.sh)
caps/mock.pid: ABSENT (removed by stop.sh)

## 2. Inventory BEFORE removal - external build products vs the (empty) in-tree ones
$ stat -c '%s bytes' "$GFPROBE/grafana"   # investigation-built server (matches Build identity: 297972032 bytes, sha256 7769b6...)
297972032 bytes
$ stat -c '%n  %s bytes' "$REPO_SRC/pkg/server/wire_gen.go"   # the ONLY generated Go source; lives in the EXTERNAL worktree, not REPO
/tmp/gf-src-4550cfb/pkg/server/wire_gen.go  94781 bytes
$ ( cd "$REPO" && { test -e bin && echo 'bin PRESENT' || echo 'repo bin/: ABSENT'; test -e pkg/server/wire_gen.go && echo 'wire_gen PRESENT' || echo 'repo pkg/server/wire_gen.go: ABSENT'; } )   # repo under test has NO build products
repo bin/: ABSENT
repo pkg/server/wire_gen.go: ABSENT
$ ls -l --time-style=+%Y-%m-%dT%H:%M /tmp/grafana_bin/grafana   # SETUP-PROVIDED (pre-existing, 298085224 bytes; NOT ours; left intact)
-rwxr-xr-x 1 root root 298085224 2026-07-13T16:12 /tmp/grafana_bin/grafana

## 3. Removal (exact commands + exit status)
$ rm -rf "$GFPROBE"   # scratch dir incl. built binary, mock, provisioning, logs, SQLite data, scripts
exit=0
$ git -C "$REPO" worktree remove --force "$REPO_SRC" && git -C "$REPO" worktree prune   # external worktree incl. its generated wire_gen.go
exit=0

## 4. Verification AFTER removal
$ test -e "$GFPROBE" && echo PRESENT || echo 'scratch: REMOVED'
scratch: REMOVED
$ test -e "$REPO_SRC" && echo PRESENT || echo 'external worktree: REMOVED'
external worktree: REMOVED
$ ls -l --time-style=+%Y-%m-%dT%H:%M /tmp/grafana_bin/grafana   # setup binary still present, untouched
-rwxr-xr-x 1 root root 298085224 2026-07-13T16:12 /tmp/grafana_bin/grafana
$ ( cd "$REPO" && git status --porcelain )   # tracked + untracked non-ignored: ONLY this document
 M blitzy/documentation/grafana_4550cfb5b728.md
$ ( cd "$REPO" && git status --porcelain --ignored )   # include IGNORED too: no bin/ and no wire_gen.go exist in REPO
 M blitzy/documentation/grafana_4550cfb5b728.md
$ ( cd "$REPO" && git diff --name-status 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff HEAD )   # vs the pinned base commit
A	blitzy/documentation/grafana_4550cfb5b728.md

# Result: the repository under test is byte-for-byte unchanged except the single
# answer document. Committing this document is the FINAL step; after that commit,
# `git status --porcelain` is empty and `git diff --name-status 4550cfb..HEAD` is
# exactly this one file (M while being finalized above, A once committed fresh).
```

---

## Coverage matrix

### Every part of Q1–Q7, answered by name

| Question sub‑part | Where answered | Verdict |
|---|---|---|
| Q1 what to work on next (many changes + falling behind + ds timing out) | Q1 mechanism + stressed run | drop‑oldest/keep‑newest; re‑sync each tick |
| Q1 where the choice first becomes visible | Q1 chronology | `Tick dropped` warn + `missed_total` counter (lagging the internal drain) |
| Q1 rule *changes* arriving while behind | Q1 §"Rule changes arriving…" | `Alert rules fetched` re‑sync; update mailbox; new routines |
| Q1 data source begins to time out | Q1 + Q2(2) | retries → `failures_total`; child eval‑timeout |
| Q2 canceled evaluation — left behind? | Q2(2) | no cleanup; **state preserved**; routine exits |
| Q2 rule removed partway — left behind? | Q2(1) | live footprint cleaned (**DB rows 1→0**, state reset, resolve sent, routine stopped); cumulative `missed_total{name,org}` series **persists** |
| Q2 which sign tells them apart | Q2(1)(2)(3) | distinct log/DB signatures (table) |
| Q2 restart (rule type change) | Q2(3) | new start **then** old stop (start‑before‑stop, ~38–177 µs), same UID; no reset |
| Q3 results out of order? | Q3 | **No** — 0 inversions, both streams, both runs |
| Q3 observable proof of preserved order | Q3 | monotonic `now=`; drops = forward gaps |
| Q4 exercised live + rationale | Q4 + inline | unedited output (full or labeled excerpt) + producing commands + reasoning |
| Q5 messages/counters/identifiers/timing | Q5 | join + exposition + step/jitter/cadence |
| Q6 normal‑load comparison (timing + volume) | Q6 | 18 ticks both; 541 vs 60; 6.6 ms vs 28.2 s |
| Q6 pauses / rhythm changes / recovery | Q6 + Q5 | same‑process recovery; freeze + resume; transition lag |
| Q7 repo unchanged; temp cleaned up | Q7 | scratch external + removed; git clean |

### How each prior review finding is addressed

| # | Sev | Finding (abridged) | Where addressed in this document |
|---|-----|--------------------|----------------------------------|
| 1 | CRIT | Secret on cmdline; no loopback bind | Setup → *Secure runtime harness* (loopback, password via env, zero leaks) |
| 2 | CRIT | Non‑canonical prebuilt binary | Setup → *Canonical build* (make/go build, checksum, startup log) |
| 3 | CRIT | Temp harness not embedded | Setup → *Embedded harness source* (all scripts + generator, in full) |
| 4 | CRIT | Elided/edited output | No output is silently trimmed: each block is **unedited** — shown in full, or a clearly‑labeled representative excerpt / derived summary with its producing `grep`/`awk`/parser — cat‑extracted from the retained run files |
| 5 | CRIT | Inconsistent magnitude math | Q1 §"arithmetic is consistent"; Q6 histogram sum |
| 6 | CRIT | Insufficient repetition | ≥2 unchanged runs each (stress/normal/recovery/delete/cancel/restart) |
| 7 | CRIT | Q1 rule‑changes‑while‑behind missing | Q1 §"Rule changes arriving while behind" |
| 8 | CRIT | Drop chronology wrong | Q1 §"chronology" (warning/counter lag the internal drain) |
| 9 | CRIT | Q2 deletion not proven on real DB | Q2(1) real SQLite rows 1→0; resolve; cumulative counter noted |
| 10 | CRIT | Q2 cancellation semantics wrong | Q2(2) three contexts: child‑timeout/parent‑cancel/deletion |
| 11 | CRIT | Q3 ordering not exercised under stress | Q3 two DEBUG runs, per‑rule inversion counts, gaps |
| 12 | CRIT | Q6 recovery was a process reset | Q6 §"Same‑process recovery" (counters freeze, not reset) |
| 13 | MAJOR | No direct‑answer Q4/Q5/Q7; tags | Dedicated Q4/Q5/Q7 sections; [OBSERVED]/[INFERRED] throughout |
| 14 | MAJOR | Config model conflated | §"The timing model, stated correctly" (SchedulerBaseInterval vs min_interval) |
| 15 | MAJOR | Q5 join/step‑vs‑jitter | Q5 identifier join; step 0.333 s vs jitter 0 |
| 16 | MAJOR | API/datasource contract absent | Setup → *mock, provisioning, API contract* |
| 17 | MAJOR | Restart replacement not proven | Q2(3) new‑start‑before‑old‑stop, same UID; retained‑not‑consumed |
| 18 | MAJOR | Unsafe shell | Setup → harness (set ‑euo pipefail, bounded curl, PID capture) |
| 19 | MAJOR | Q7 external cleanup unproven | Q7 + genuine post‑cleanup teardown transcript: scratch dir removed, the external build worktree (holding the only generated `pkg/server/wire_gen.go`) removed, repo under test has no build products, and `git status --porcelain --ignored` lists only this document |
| 20 | MINOR | Citation inaccuracies | Full paths throughout; buckets at scheduler.go:149; ticker at pkg/util/ticker/metrics.go |

---

## Appendix — raw evidence index

All captures were saved under the scratch directory during the investigation (removed at completion per Q7). The commands that produced them are shown in each section. Key files: **[OBSERVED]**

- Stressed: `runs/stress_run1/`, `runs/stress_run2/` — `window.txt`, `timeline.tsv`, complete `metrics_*.txt`, `server_full.out`, `tick_dropped.log`, `rule000_trace.log`.
- Normal: `runs/normal_run1/`, `runs/normal_run2/` — same layout, fast data source.
- Recovery: `runs/recovery_run1/`, `runs/recovery_run2/` — `window.txt` (persistence check), `timeline.tsv` (phase column, absolute counters).
- Q2 deletion: `runs/del_run{1,2}/` (`before.txt`, `after.txt` — `missed_total` + DB rows, `delete_logs.txt`, `server_full.out`). Q2 child eval‑timeout: `runs/ct_run{1,2}/` (`before.txt`, `during.txt`, `after.txt`, `server_full.out`). Q2 restart: `runs/rs_run{1,2}/` (`subsystem.txt`, `lifecycle.txt`, `after.txt`, `server_full.out`).
- Analyses: `runs/q3_analysis/` (ordering, inversions), `runs/q6_analysis/` (comparison, step spread), `runs/q5_analysis/` (metric exposition, citations). **[OBSERVED]**

*End of document.*
