# Stale Alert Instance Lifecycle in Grafana Unified Alerting (ngalert)

> **Repository:** `github.com/grafana/grafana` · **Commit:** `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` · **Branch:** `grafana_4550cfb5b728`
> **Subsystem:** Unified Alerting state management — `pkg/services/ngalert/state`
> **Method:** *Run‑first.* The behavioral claims below are backed by the **actual, complete, unedited output** of programs that exercised the **real** canonical entry point `Manager.ProcessEvalResults`. Every runtime artifact (raw command output, the transient test sources, the environment capture, the two‑run stability diff, and the cleanup proof) is archived **outside** the repository at **`/tmp/evidence/`** (`env/`, `scripts/`, `outputs/`) so each embedded block can be reconciled byte‑for‑byte with its source file.

**Label convention (used consistently below).**
- **[OBSERVED]** — confirmed by captured runtime output that is archived under `/tmp/evidence/outputs/` (the exact block is embedded here). Reserved *only* for facts a program actually produced at runtime.
- **[INFERRED]** — derived from reading source at the pinned commit (exact `file:line` given). Not a runtime observation.
- **[DOC‑CORROBORATED]** — stated by Grafana's official documentation / PR history and *consistent with* the observed code; explicitly not a runtime observation of this build.

This document answers eight questions about the lifecycle of *stale* alert instances — instances that appear to *linger* after the time series that produced them disappears — and precisely how the scheduler/state‑manager **detects, resolves, notifies, and eventually forgets** those series.

---

## Overview

**What a "stale" instance is.** An alert instance is a single time series (one label set) tracked by a `State` value in the state manager's in‑memory cache (`pkg/services/ngalert/state/cache.go`). A series is considered **stale** once it has been **absent from the evaluation results for at least two evaluation intervals** — precisely, once `evaluatedAt >= lastEval + 2*interval` (the predicate is **equality‑inclusive**; see Q3). When the stale sweep runs, the instance's `State` is set to `eval.Normal` with `StateReason = "MissingSeries"`; if it was previously `Alerting` it is additionally marked **Resolved** (`ResolvedAt` is set and an image may be captured); it is then **evicted** from the cache in the same cycle. **[INFERRED]** (source: `manager.go:586-625`; confirmed at runtime in Q1/Q3/Q6/Q7/Q8 below).

**The per‑evaluation pipeline.** Every evaluation calls `Manager.ProcessEvalResults` (`pkg/services/ngalert/state/manager.go:307`) — the exact method the scheduler invokes per tick — which performs the following steps **in this order**:

1. `states := st.setNextStateForRule(...)` — updates states for series **present** in the current results. `manager.go:326`
2. `staleStates := st.deleteStaleStatesFromCache(...)` — sweeps series that are **absent**. `manager.go:328`
3. `allChanges := StateTransitions(append(states, staleStates...))` — **merges** present + stale transitions. `manager.go:334`
4. `statesToSend = st.updateLastSentAt(allChanges, evaluatedAt)` — filters the merged set to the transitions that need sending (calls `NeedsSending`) and stamps `LastSentAt`. `manager.go:340` (func at `manager.go:359`)
5. `st.persister.Sync(...)` — flush to DB; stale states are **not** saved (they are deleted). `manager.go:343`
6. `send(ctx, statesToSend)` — dispatch the **filtered** subset to the notifier (optional callback). `manager.go:351`

Because absent series are simply **not updated** in step 1 (their `LastEvaluationTime` stays old), the staleness decision in step 2 is **purely time‑based** — there is no separate liveness probe. **[INFERRED]** (source: `manager.go:326-351`; confirmed at runtime in Q1/Q2 below).

**Lifecycle state diagram** — the **two resolution paths are distinct** and must not be conflated (boundary values annotated):

```mermaid
stateDiagram-v2
    [*] --> Pending: condition breached, for > 0
    Pending --> Alerting: elapsed >= for

    %% ---- NATURAL resolution: series STILL PRESENT, metric recovered ----
    Alerting --> NaturalResolved: metric recovers (present); ResolvedAt set, image via shouldTakeImage
    NaturalResolved --> NaturalResent: still cached; re-sent on first eval at/after ResendDelay since last send
    NaturalResent --> NaturalResent: while LastEvaluationTime - ResolvedAt <= ResolvedRetention
    NaturalResent --> NaturalStopped: LastEvaluationTime - ResolvedAt > ResolvedRetention (stop)

    %% ---- STALE resolution: series VANISHED (absent >= 2*interval) ----
    Alerting --> StaleSweep: series absent >= 2*interval
    Pending --> StaleSweep: series absent >= 2*interval
    Normal --> StaleSweep: series absent >= 2*interval
    StaleSweep --> StaleResolvedFiring: oldState == Alerting; NEW ResolvedAt set, takeImage, send-eligible
    StaleSweep --> StaleNoResolveNoSend: oldState == Pending OR Normal-never-resolved (ResolvedAt == nil); no ResolvedAt, no image, nothing sent
    StaleSweep --> StalePrevResolvedFinalSend: oldState == Normal-previously-resolved (ResolvedAt retained); no new image; final resolved send IF resend+retention gates allow
    StaleResolvedFiring --> Evicted: evicted SAME cycle (not re-sent later)
    StaleNoResolveNoSend --> Evicted
    StalePrevResolvedFinalSend --> Evicted: evicted SAME cycle (after the one final send)
    Evicted --> [*]
    Evicted --> FreshInstance: identical labels reappear -> new State (same CacheID)
%% Boundary values: staleness = evaluatedAt >= lastEval + 2*interval (equality-inclusive);
%% ResendDelay = 30s (minimum spacing); ResolvedRetention = 15m (default).
```

**The nuance that ties Q4/Q5/Q6 together.** A **naturally‑resolved** series (metric drops below threshold, series *still present*) stays in the cache and keeps **re‑sending** the resolved notification — on the first evaluation at or after each `ResendDelay` — until `ResolvedRetention` elapses, then stops. A **stale** series (series *vanished*) is swept and **evicted in the same cycle**, but *what it sends on the way out depends on its previous state*: (a) if it was **`Alerting`**, the sweep sets a **new** `ResolvedAt`, takes an image, and it is send‑eligible **once**; (b) if it was **`Pending`**, or **`Normal` that had never resolved** (`ResolvedAt == nil`), it sends **nothing** (`NeedsSending` returns `false` for a `Normal` state with `ResolvedAt == nil`); (c) if it was **`Normal` that had *previously* resolved** (a retained `ResolvedAt` from an earlier natural resolution), the sweep takes **no new image** but the retained `ResolvedAt` means it **can still emit one final resolved send** — *subject to the same resend‑delay and retention gates* — before eviction. Both the natural and the `Alerting`‑stale paths call the *same* `takeImage`, but through *different* guards. **[OBSERVED]** (runtime evidence for all three stale sub‑cases in Q4/Q5/Q6/Q7).

---

## Investigation Methodology & Build/Run Commands

**Evidence archive.** All raw runtime artifacts live at **`/tmp/evidence/`** (outside the repository): `env/` (toolchain capture + the `GOWORK=off` failure), `scripts/` (the two transient `*_test.go` observation files, copied before deletion), and `outputs/` (the four canonical test logs, `obs_*_run1.txt`/`obs_*_run2.txt` for the 13 observations, `stability_all.txt`, `cleanup_git_status.txt`, plus the version‑caveat and dependency captures). Each fenced block below is that file's exact content.

**Prerequisites (captured in this environment).**

Command that produced the toolchain capture (`/tmp/evidence/env/go_version.txt`, `env/go_env.txt`):

```bash
echo "# go version"; go version
go env GOVERSION GOWORK GOFLAGS CGO_ENABLED GOCACHE GOROOT   # (GOFLAGS shown blank = unset)
gcc --version | head -1
```

```
# go version
go version go1.23.1 linux/amd64
```

```
go1.23.1
/tmp/blitzy/grafana/blitzy-2bbcdb18-5993-43df-bb1f-72e8b75d8072_7a3f87/go.work

1
/tmp/gocache
/usr/local/go
gcc (Ubuntu 15.2.0-4ubuntu4) 15.2.0
```

- Go **1.23.1** — pinned by `go.mod:L3` (`go 1.23.1`); observed `go version go1.23.1 linux/amd64`. **[OBSERVED]**
- A working C toolchain for `CGO_ENABLED=1` — observed **`gcc (Ubuntu 15.2.0-4ubuntu4) 15.2.0`**. Any CGO‑capable gcc suffices; what matters is that CGO is enabled. **[OBSERVED]**
- `GOWORK` resolves to the repo's `go.work` (workspace **enabled**), `CGO_ENABLED=1`, `GOCACHE=/tmp/gocache`, `GOROOT=/usr/local/go`. **[OBSERVED]**

**Environment (from repo root):**

```bash
unset GOWORK                 # keep the multi-module workspace ENABLED (do NOT set GOWORK=off)
export GOCACHE=/tmp/gocache
export CGO_ENABLED=1
```

The multi‑module Go workspace (`go.work` + `go.work.sum` at the repo root) MUST remain **enabled**. Setting `GOWORK=off` pulls mismatched *published* sub‑modules and breaks the build. This was exercised and captured (`/tmp/evidence/env/gowork_off_failure.txt`):

```
=== Attempting build with GOWORK=off (expected to FAIL) ===
$ GOWORK=off go build ./pkg/services/ngalert/state/ 2>&1
exit=1
---- output (first 40 lines) ----
go: downloading github.com/grafana/grafana/pkg/apimachinery v0.0.0-20240821155123-6891eb1d35da
go: downloading github.com/grafana/grafana/pkg/util/xorm v0.0.1
go: downloading github.com/grafana/grafana/pkg/apiserver v0.0.0-20240821155123-6891eb1d35da
go: downloading github.com/getkin/kin-openapi v0.128.0
# github.com/grafana/grafana/pkg/apimachinery/identity
/root/go/pkg/mod/github.com/grafana/grafana/pkg/apimachinery@v0.0.0-20240821155123-6891eb1d35da/identity/static.go:10:19: cannot use &StaticRequester{} (value of type *StaticRequester) as Requester value in variable declaration: *StaticRequester does not implement Requester (missing method GetAudience)
/root/go/pkg/mod/github.com/grafana/grafana/pkg/apimachinery@v0.0.0-20240821155123-6891eb1d35da/identity/static.go:40:46: undefined: claims.AccessClaims
/root/go/pkg/mod/github.com/grafana/grafana/pkg/apimachinery@v0.0.0-20240821155123-6891eb1d35da/identity/static.go:41:34: cannot use u (variable of type *StaticRequester) as Requester value in struct literal: *StaticRequester does not implement Requester (missing method GetAudience)
/root/go/pkg/mod/github.com/grafana/grafana/pkg/apimachinery@v0.0.0-20240821155123-6891eb1d35da/identity/static.go:45:48: undefined: claims.IdentityClaims
/root/go/pkg/mod/github.com/grafana/grafana/pkg/apimachinery@v0.0.0-20240821155123-6891eb1d35da/identity/static.go:47:19: undefined: authnlib.NewIdentityClaims
/root/go/pkg/mod/github.com/grafana/grafana/pkg/apimachinery@v0.0.0-20240821155123-6891eb1d35da/identity/static.go:49:34: cannot use u (variable of type *StaticRequester) as Requester value in struct literal: *StaticRequester does not implement Requester (missing method GetAudience)
/root/go/pkg/mod/github.com/grafana/grafana/pkg/apimachinery@v0.0.0-20240821155123-6891eb1d35da/identity/wrapper.go:9:14: undefined: claims.IdentityClaims
/root/go/pkg/mod/github.com/grafana/grafana/pkg/apimachinery@v0.0.0-20240821155123-6891eb1d35da/identity/wrapper.go:10:14: undefined: claims.AccessClaims
# github.com/grafana/grafana/pkg/apis/featuretoggle/v0alpha1
pkg/apis/featuretoggle/v0alpha1/register.go:19:33: undefined: utils.NewResourceInfo
pkg/apis/featuretoggle/v0alpha1/register.go:44:33: undefined: utils.NewResourceInfo
# github.com/oapi-codegen/oapi-codegen/v2/pkg/util
/root/go/pkg/mod/github.com/oapi-codegen/oapi-codegen/v2@v2.3.0/pkg/util/loader.go:24:45: undefined: openapi3.CircularReferenceCounter
/root/go/pkg/mod/github.com/oapi-codegen/oapi-codegen/v2@v2.3.0/pkg/util/loader.go:26:12: undefined: openapi3.CircularReferenceCounter
/root/go/pkg/mod/github.com/oapi-codegen/oapi-codegen/v2@v2.3.0/pkg/util/loader.go:33:12: undefined: openapi3.CircularReferenceCounter
```

**[OBSERVED]** — `GOWORK=off go build ./pkg/services/ngalert/state/` exits **1**, failing to compile mismatched `pkg/apimachinery`, `pkg/apis/featuretoggle`, and `oapi-codegen` versions. The default (workspace‑enabled) build succeeds, so no `GOFLAGS` override is used or needed.

**Canonical run command (per observation):**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestName$' -v -count=1
```

**Canonical entry point exercised.** `Manager.ProcessEvalResults` at `pkg/services/ngalert/state/manager.go:307` — the exact method the scheduler calls per evaluation. Observations construct a **real** `Manager` via `state.NewManager(cfg, persister)` (`manager.go:88`) with a fake image service (`state.NoopImageService` / `state.NotAvailableImageService`, or a small counting/token capturer for Q6), a fake instance store (`state.FakeInstanceStore`), a fake historian (`state.FakeHistorian`), and a **mock clock** (`github.com/benbjohnson/clock` v1.3.5, starting at `time.Unix(0,0)` → `00:00:00` UTC) to cross the `2*interval` / `30s` / `15m` boundaries deterministically. This is the **canonical** path — **no debug hooks, no mock‑as‑bypass**; only the image service, instance store, historian, and clock are fakes, while the state machine itself is production code. **[OBSERVED]**

**Run‑first methodology.** Two **temporary** `*_test.go` observation scripts were placed in package `pkg/services/ngalert/state` (internal — to call the unexported `stateIsStale` and `(*State).NeedsSending` at the predicate level) and package `pkg/services/ngalert/state_test` (external — to drive `ProcessEvalResults`). They were compiled, executed, their output captured (run #1 and run #2), copied to `/tmp/evidence/scripts/`, and then **deleted** from the repo, so the source tree is left byte‑for‑byte unchanged (`git status --porcelain` reports only this document — see **Determinism & Stability**). Their complete sources are reproduced verbatim in the **Appendix**.

**Canonical existing tests confirmed to build & pass (the harness the temp scripts imitate).** Each was run with the canonical command and re‑run identically a second time. These prove the environment exercises the real production paths.

`TestStateIsStale` (`pkg/services/ngalert/state/manager_private_test.go:41`) — Q3 seed:

```
=== RUN   TestStateIsStale
=== RUN   TestStateIsStale/false_if_last_evaluation_is_now
=== RUN   TestStateIsStale/false_if_last_evaluation_is_1_interval_before_now
=== RUN   TestStateIsStale/false_if_last_evaluation_is_little_less_than_2_interval_before_now
=== RUN   TestStateIsStale/true_if_last_evaluation_is_2_intervals_from_now
=== RUN   TestStateIsStale/true_if_last_evaluation_is_3_intervals_from_now
--- PASS: TestStateIsStale (0.00s)
    --- PASS: TestStateIsStale/false_if_last_evaluation_is_now (0.00s)
    --- PASS: TestStateIsStale/false_if_last_evaluation_is_1_interval_before_now (0.00s)
    --- PASS: TestStateIsStale/false_if_last_evaluation_is_little_less_than_2_interval_before_now (0.00s)
    --- PASS: TestStateIsStale/true_if_last_evaluation_is_2_intervals_from_now (0.00s)
    --- PASS: TestStateIsStale/true_if_last_evaluation_is_3_intervals_from_now (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.041s
```

A precision note on this seed (relevant to Q3): its subtest *"false if last evaluation is 1 interval before now"* (`manager_private_test.go:56-58`) computes `now.Add(-time.Duration(intervalSeconds))` **without** `* time.Second`, i.e. it subtracts *nanoseconds*, not one interval. It therefore does **not** actually exercise the "1 interval before" case — it is effectively "now". We do **not** rely on it to establish the one‑interval behavior; that is established canonically through `ProcessEvalResults` in Q3 instead. **[OBSERVED]** (quirk visible in the cited source).

`TestNeedsSending` (`pkg/services/ngalert/state/state_test.go:351`) — Q4/Q5 seed, 14 subtests (includes the retention‑STOP case):

```
=== RUN   TestNeedsSending
=== RUN   TestNeedsSending/state:_alerting_and_LastSentAt_before_LastEvaluationTime_+_ResendDelay
=== RUN   TestNeedsSending/state:_alerting_and_LastSentAt_after_LastEvaluationTime_+_ResendDelay
=== RUN   TestNeedsSending/state:_alerting_and_LastSentAt_equals_LastEvaluationTime_+_ResendDelay
=== RUN   TestNeedsSending/state:_pending
=== RUN   TestNeedsSending/state:_alerting_and_ResendDelay_is_zero
=== RUN   TestNeedsSending/state:_normal_+_resolved_should_send_without_waiting_if_ResolvedAt_>_LastSentAt
=== RUN   TestNeedsSending/state:_normal_+_recently_resolved_should_send_with_wait
=== RUN   TestNeedsSending/state:_normal_+_recently_resolved_should_not_send_without_wait
=== RUN   TestNeedsSending/state:_normal_+_not_recently_resolved_should_not_send_even_with_wait
=== RUN   TestNeedsSending/state:_normal_but_not_resolved_does_not_send_after_a_minute
=== RUN   TestNeedsSending/state:_no-data,_needs_to_be_re-sent
=== RUN   TestNeedsSending/state:_no-data,_should_not_be_re-sent
=== RUN   TestNeedsSending/state:_error,_needs_to_be_re-sent
=== RUN   TestNeedsSending/state:_error,_should_not_be_re-sent
--- PASS: TestNeedsSending (0.00s)
    --- PASS: TestNeedsSending/state:_alerting_and_LastSentAt_before_LastEvaluationTime_+_ResendDelay (0.00s)
    --- PASS: TestNeedsSending/state:_alerting_and_LastSentAt_after_LastEvaluationTime_+_ResendDelay (0.00s)
    --- PASS: TestNeedsSending/state:_alerting_and_LastSentAt_equals_LastEvaluationTime_+_ResendDelay (0.00s)
    --- PASS: TestNeedsSending/state:_pending (0.00s)
    --- PASS: TestNeedsSending/state:_alerting_and_ResendDelay_is_zero (0.00s)
    --- PASS: TestNeedsSending/state:_normal_+_resolved_should_send_without_waiting_if_ResolvedAt_>_LastSentAt (0.00s)
    --- PASS: TestNeedsSending/state:_normal_+_recently_resolved_should_send_with_wait (0.00s)
    --- PASS: TestNeedsSending/state:_normal_+_recently_resolved_should_not_send_without_wait (0.00s)
    --- PASS: TestNeedsSending/state:_normal_+_not_recently_resolved_should_not_send_even_with_wait (0.00s)
    --- PASS: TestNeedsSending/state:_normal_but_not_resolved_does_not_send_after_a_minute (0.00s)
    --- PASS: TestNeedsSending/state:_no-data,_needs_to_be_re-sent (0.00s)
    --- PASS: TestNeedsSending/state:_no-data,_should_not_be_re-sent (0.00s)
    --- PASS: TestNeedsSending/state:_error,_needs_to_be_re-sent (0.00s)
    --- PASS: TestNeedsSending/state:_error,_should_not_be_re-sent (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.039s
```

`TestStaleResults` (`pkg/services/ngalert/state/manager_test.go:1846`) — Q1/Q6/Q7/Q8 seed:

```
=== RUN   TestStaleResults
=== RUN   TestStaleResults/should_mark_missing_states_as_stale
=== RUN   TestStaleResults/should_remove_stale_states_from_cache
=== RUN   TestStaleResults/should_delete_stale_states_from_the_database
--- PASS: TestStaleResults (0.00s)
    --- PASS: TestStaleResults/should_mark_missing_states_as_stale (0.00s)
    --- PASS: TestStaleResults/should_remove_stale_states_from_cache (0.00s)
    --- PASS: TestStaleResults/should_delete_stale_states_from_the_database (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.042s
```

`TestStaleResultsHandler` (`pkg/services/ngalert/state/manager_test.go:1695`) — end‑to‑end against a **real sqlite DB** (`tests.SetupTestEnv`):

```
=== RUN   TestStaleResultsHandler
    util.go:158: alert definition: {orgID: 1, UID: bfs0b2bput81vb} with title: "an alert definition afs0b2bput81ua" interval: 60 folder: namespace created
--- PASS: TestStaleResultsHandler (0.23s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.270s
```

**[OBSERVED]** — all four canonical tests build and pass under the canonical environment.

---

## Boundary Constants (summary)

The three magic numbers that govern the stale lifecycle, with exact anchors:

| Constant | Value | Where | Exact code |
|---|---|---|---|
| **Staleness threshold** | `2 * IntervalSeconds` (hard‑coded) | `pkg/services/ngalert/state/manager.go:627` (`stateIsStale`) | `return !lastEval.Add(2 * time.Duration(intervalSeconds) * time.Second).After(evaluatedAt)` |
| **Resend delay** | `30s` (package‑level `var`) | declared `pkg/services/ngalert/state/manager.go:23-25` (value on `:24`) | `var ( ResendDelay = 30 * time.Second )` — no comment on the declaration; the `// TODO: make this configurable` comment is at the `Manager` field initialization `manager.go:98` |
| **Resolved retention (default)** | `15m` | default parsed `pkg/setting/setting_unified_alerting.go:465` · field `ResolvedAlertRetention` at `:125` · `conf/defaults.ini:1365` · wired at `pkg/services/ngalert/ngalert.go:415` | `resolved_alert_retention = 15m`; `ResolvedRetention: ng.Cfg.UnifiedAlerting.ResolvedAlertRetention` |

Notes:
- The staleness threshold is **not configurable** at this commit — it is the literal `2 *` in `stateIsStale`. See the **Version Caveat** for the (absent) later `MissingSeriesEvalsToResolve` option. **[OBSERVED]** (Q3 + version‑caveat grep).
- `ResendDelay` is a package‑level **`var`** (not a `const`), declared at `manager.go:23-25`; the `Manager.ResendDelay` field is initialized from it — with the `// TODO: make this configurable` comment — at `manager.go:98`. **[INFERRED]** (source lines cited).
- `ResendDelay` is a **minimum spacing**, not an independent 30s timer: a resolved state re‑sends on the **first evaluation at or after** `LastSentAt + ResendDelay`. When the evaluation interval divides 30s (e.g. a 30s interval), the observed cadence is exactly 30s; with a 20s interval it lands on every second evaluation (40s). See Q5. **[OBSERVED]** (Q5 cadence test).
- `ResolvedRetention` is the only one of the three that is configurable; its default `15m` flows `conf/defaults.ini:1365` → `setting_unified_alerting.go:465` → `ngalert.go:415` into `ManagerCfg.ResolvedRetention`. **[INFERRED]** (source lines cited; effect observed in Q4/Q5).

---

## Cohesive End-to-End Lifecycle (single continuous trace)

The per-question sections (Q1–Q8) each isolate one facet of the lifecycle. To prove the facets connect — that the *same* series carries its state coherently from firing through staleness, resolution, retention, and reappearance — this section drives **one** `Manager` on **one** mock clock through **one** uninterrupted sequence of `ProcessEvalResults` calls, and prints the full state of every series at each step. Three series share a single rule (`interval = 60s`, `for = 0`): **A** survives and later resolves naturally (exercising the retention window), **B** vanishes → is swept stale → later reappears with identical labels, and **C** is temporarily *slow* (absent one interval) then returns (proving slow ≠ stopped).

**Observed evidence — command:**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyFixCohesiveLifecycleE2E$' -v -count=1
```

```
=== RUN   TestBlitzyFixCohesiveLifecycleE2E
[COHESIVE] === PHASE 1: FIRING @ t0=00:00:00 (interval=60s, For=0) ===
[COHESIVE] merged=3 dispatched=3 imgCount=3
    [P1] series=A CacheID=40ffcae87610efd1 prev=Normal->new=Alerting reason="" StartsAt=00:00:00 ResolvedAt=nil LastSentAt=00:00:00 LastEval=00:00:00 EndsAt=00:04:00 stale=false img=blitzy-img-1 cache=true sent=true
    [P1] series=B CacheID=40ffc9e87610ed84 prev=Normal->new=Alerting reason="" StartsAt=00:00:00 ResolvedAt=nil LastSentAt=00:00:00 LastEval=00:00:00 EndsAt=00:04:00 stale=false img=blitzy-img-2 cache=true sent=true
    [P1] series=C CacheID=40ffc8e87610eb37 prev=Normal->new=Alerting reason="" StartsAt=00:00:00 ResolvedAt=nil LastSentAt=00:00:00 LastEval=00:00:00 EndsAt=00:04:00 stale=false img=blitzy-img-3 cache=true sent=true
[COHESIVE] === PHASE 2: C SLOW (absent 1 interval) @ 00:01:00 ===
[COHESIVE] C cachePresent=true (SLOW, offset=1 interval < 2*interval -> NOT stale)
[COHESIVE] === PHASE 3: C RETURNS @ 00:02:00 ===
    [P3] series=C CacheID=40ffc8e87610eb37 prev=Alerting->new=Alerting reason="" StartsAt=00:00:00 ResolvedAt=nil LastSentAt=00:02:00 LastEval=00:02:00 EndsAt=00:06:00 stale=false img=blitzy-img-3 cache=true sent=true
[COHESIVE] === PHASE 4: A NATURAL RESOLVE @ 00:03:00 (B's last presence; C stays firing as control) ===
    [P4] series=A CacheID=40ffcae87610efd1 prev=Alerting->new=Normal reason="" StartsAt=00:03:00 ResolvedAt=00:03:00 LastSentAt=00:03:00 LastEval=00:03:00 EndsAt=00:03:00 stale=false img=blitzy-img-4 cache=true sent=true
    [P4] series=B CacheID=40ffc9e87610ed84 prev=Alerting->new=Alerting reason="" StartsAt=00:00:00 ResolvedAt=nil LastSentAt=00:03:00 LastEval=00:03:00 EndsAt=00:07:00 stale=false img=blitzy-img-2 cache=true sent=true
[COHESIVE] === PHASE 5: BOUNDARY-1s for B @ 00:04:59 (B offset=119s < 2*interval) ===
[COHESIVE] B cachePresent=true (still alive; boundary not crossed)
[COHESIVE] === PHASE 6: STALE SWEEP of B @ 00:05:00 (B offset=120s == 2*interval) ===
    [P6] series=A CacheID=40ffcae87610efd1 prev=Normal->new=Normal reason="" StartsAt=00:03:00 ResolvedAt=00:03:00 LastSentAt=00:04:59 LastEval=00:05:00 EndsAt=00:03:00 stale=false img=blitzy-img-4 cache=true sent=false
    [P6] series=B CacheID=40ffc9e87610ed84 prev=Alerting->new=Normal reason="MissingSeries" StartsAt=00:00:00 ResolvedAt=00:05:00 LastSentAt=00:05:00 LastEval=00:05:00 EndsAt=00:05:00 stale=true img=blitzy-img-5 cache=false sent=true
    [P6] series=C CacheID=40ffc8e87610eb37 prev=Alerting->new=Alerting reason="" StartsAt=00:00:00 ResolvedAt=nil LastSentAt=00:04:59 LastEval=00:05:00 EndsAt=00:09:00 stale=false img=blitzy-img-3 cache=true sent=false
[COHESIVE] imgCount 4->5 (B stale image taken); B dispatched=true
[COHESIVE] store DeleteAlertInstances ops recorded so far = 1 (>=1 for B)
[COHESIVE] === PHASE 7: A RETENTION @ 00:17:30 (sinceResolved=14.5m, re-send) ===
[COHESIVE] A sinceResolved=14.5m dispatched=true (still within retention)
[COHESIVE] === PHASE 7b: A RETENTION EQUALITY @ 00:18:00 (sinceResolved==15m) ===
[COHESIVE] A sinceResolved==15m dispatched=true (equality still SENDS; retention stop is strict >)
[COHESIVE] === PHASE 7c: A RETENTION +1ns @ 00:18:00 (sinceResolved=15m+1ns) ===
[COHESIVE] A sinceResolved=15m+1ns dispatched=false (FIRST suppression: retention exceeded)
[COHESIVE] === PHASE 8: B REAPPEARS (identical labels) @ 00:19:00 ===
    [P8] series=B CacheID=40ffc9e87610ed84 prev=Normal->new=Alerting reason="" StartsAt=00:19:00 ResolvedAt=nil LastSentAt=00:19:00 LastEval=00:19:00 EndsAt=00:23:00 stale=false img=blitzy-img-6 cache=true sent=true
[COHESIVE] B reappears: sameCacheID=true newStartsAt=00:19:00 reason="" (fresh identity, not the evicted one)
--- PASS: TestBlitzyFixCohesiveLifecycleE2E (0.01s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.051s
```

**Event-to-source mapping.** Each phase above is produced by a specific code path — the same paths the per-question sections dissect in isolation:

| Phase (trace) | Observed effect | Driving code (`file:line`) |
|---|---|---|
| P1 Firing | present series → `Alerting`; entering-`Alerting` image taken | `setNextStateForRule` `manager.go:326`; `shouldTakeImage` `state.go:581` |
| P2 Slow / P3 Return | C absent 1 interval survives, then refreshed on return | `stateIsStale` (time-based, no liveness probe) `manager.go:627`; present-series update `manager.go:326` |
| P4 Natural resolve (A) | `Alerting → Normal`, `ResolvedAt` set, resolve image, dispatched | `shouldTakeImage(resolved)` `state.go:581`; `NeedsSending` newly-resolved `state.go:507-509` |
| P5 Boundary-1s (B) | B at 119s (<2·interval) not yet stale | `stateIsStale` `manager.go:627-629` |
| P6 Stale sweep (B) | `Alerting → Normal(MissingSeries)`, `ResolvedAt`, stale image, **evicted**, DB delete, dispatched | sweep `manager.go:586`, fields `manager.go:599-602`, image guard `manager.go:604-606`; eviction `cache.go:255`→`cache.go:244-252`; `DeleteAlertInstances` `persister_sync.go:51-68` + skip-save `:82-84`; merge+filter `manager.go:334`,`:340`,`:359` |
| P7/7b/7c Retention (A) | re-send at 14.5m; **still sends at exactly 15m** (strict `>`); **first suppression at 15m+1ns** | `NeedsSending` retention hard-stop `state.go:513-515`, cadence `state.go:519` |
| P8 Reappearance (B) | identical labels → **same** `CacheID`, fresh `StartsAt`/`ResolvedAt=nil`/`reason=""` | `cache.create` fingerprint `cache.go:149`, fresh fields `cache.go:155-168` |

**Interpretation (observed).** The single trace shows the whole lifecycle holding together: B's `CacheID` (`40ffc9e87610ed84`) is identical at P1 (firing), P6 (stale sweep, `cache=false` = evicted), and P8 (reappearance) — yet at P8 its `StartsAt` has reset to `00:19:00` and its `reason` is empty, confirming the reappeared B is a **fresh instance** occupying the same deterministic key, not a revival of the evicted one. C proves *slow ≠ stopped*: absent for one interval (P2) it survives, and on return (P3) it is simply refreshed (`LastEval=00:02:00`). A demonstrates the natural-resolution retention window end-to-end: resolved at `00:03:00` (P4), re-sent at 14.5m (P7), **still** sent at exactly 15m (P7b, equality — the stop is strict `>`), and **suppressed** at 15m+1ns (P7c). The stale sweep of B (P6) simultaneously takes a stale image (`imgCount 4->5`), records a `DeleteAlertInstances` store op, evicts the cache entry, and dispatches the resolved notification — all in the one evaluation that crosses B's `2·interval` boundary. **[OBSERVED]** (single command output above; **[INFERRED]** items are the `file:line` attributions in the mapping table, confirmed by the printed field values). Byte-for-byte reproducible across two runs — see **Determinism & Stability of Evidence**.

---

## Q1 — Multi-series partial disappearance

**Question.** When an alert fires across multiple series and some series vanish while others keep firing, what happens to the alert states of the disappeared series?

**Answer.** The series that keep firing are updated in place by `setNextStateForRule` (e.g. `Alerting → Alerting`), while the vanished series are swept by `deleteStaleStatesFromCache` to `Normal` with `StateReason = "MissingSeries"`, and — because they were `Alerting` — are marked **Resolved** (`ResolvedAt` set). All transitions (present + stale) are **merged** into `allChanges`; then **only the `NeedsSending`‑eligible subset** is dispatched by the `send` callback (`updateLastSentAt` filters the merged set). The vanished series are then **evicted from the in‑memory cache** (`cachePresent=false` after the sweep) and their row is **deleted from the database** (verified below by a concrete sqlite read‑back going `rows=1 → rows=0`), while the surviving series remain. **[OBSERVED]** (evidence below).

**Mechanism.**
- `Manager.ProcessEvalResults` calls `setNextStateForRule` (present series, `manager.go:326`) then `deleteStaleStatesFromCache` (absent series, `manager.go:328`), then merges `allChanges := StateTransitions(append(states, staleStates...))` (`manager.go:334`). **[INFERRED]** (source).
- The sweep sets `s.State = eval.Normal`, `s.StateReason = ngModels.StateReasonMissingSeries`, `s.EndsAt = evaluatedAt`, `s.LastEvaluationTime = evaluatedAt`, and — only if the previous state was `Alerting` — `s.ResolvedAt = &evaluatedAt` (`manager.go:597-605`). **[INFERRED]** (source; confirmed by the transition rows below).
- Dispatch is filtered: `updateLastSentAt` sends a transition only if `NeedsSending` is true (`manager.go:359-363`). A stale‑resolved formerly‑`Alerting` series is **immediately** send‑eligible (newly resolved); a *surviving* `Alerting` series is only re‑sent if `ResendDelay` has elapsed since its last send (cadence‑gated). **[OBSERVED]** (send‑filtering evidence below).

**Observed evidence — command:**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyObsQ1PartialDisappearance$' -v -count=1
```

```
=== RUN   TestBlitzyObsQ1PartialDisappearance
[Q1] t0: 3 series fire Alerting; merged=3 dispatched=3 cacheCount=3
[Q1] t0+2*interval: only A present. total merged transitions(allChanges)=3 dispatched=3
    [Q1] series=A CacheID=40ffcae87610efd1 prev=Alerting -> new=Alerting reason="" resolvedSet=false
    [Q1] series=B CacheID=40ffc9e87610ed84 prev=Alerting -> new=Normal reason="MissingSeries" resolvedSet=true
    [Q1] series=C CacheID=40ffc8e87610eb37 prev=Alerting -> new=Normal reason="MissingSeries" resolvedSet=true
[Q1] cache contents after sweep (present series only):
    [Q1] after series=A CacheID=40ffcae87610efd1 State=Alerting Reason="" StartsAt=00:00:00 ResolvedAt=nil LastSentAt=00:02:00 EndsAt=00:06:00 Image=SET
--- PASS: TestBlitzyObsQ1PartialDisappearance (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.043s
```

**Interpretation.** Three series (A, B, C) fire `Alerting` at t0 (`merged=3`, `dispatched=3`, `cacheCount=3`). After the clock advances `2*interval` with **only A** present, A is updated in place (`Alerting → Alerting`, `resolvedSet=false`) while B and C are swept to `Normal`/`MissingSeries` with `ResolvedAt` set (`resolvedSet=true`). All three transitions merge into `allChanges` (`=3`). Only A remains in the cache afterward (`LastSentAt=00:02:00`, `EndsAt=00:06:00`, `Image=SET`). The deterministic label fingerprints are `A=40ffcae87610efd1`, `B=40ffc9e87610ed84`, `C=40ffc8e87610eb37`. **[OBSERVED]**

**Full disappeared-series field trace (before / after).** The transition rows above summarize state/reason/`resolvedSet`; the trace below records **every** lifecycle field for each series both *before* (t0, all firing) and *after* the sweep, so the exact effect on the disappeared series B and C is explicit — `StartsAt`, `ResolvedAt`, `LastSentAt`, `LastEvaluationTime`, `EndsAt`, the `IsStale()` marker, cache presence, the image token, and whether the transition is dispatched.

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyFixQ1DisappearedFields$' -v -count=1
```

```
=== RUN   TestBlitzyFixQ1DisappearedFields
[Q1-fields] BEFORE (t0, all firing):
    series=A CacheID=40ffcae87610efd1 State=Alerting reason="" StartsAt=00:00:00 ResolvedAt=nil LastSentAt=00:00:00 LastEval=00:00:00 EndsAt=00:04:00 img=blitzy-img-1
    series=B CacheID=40ffc9e87610ed84 State=Alerting reason="" StartsAt=00:00:00 ResolvedAt=nil LastSentAt=00:00:00 LastEval=00:00:00 EndsAt=00:04:00 img=blitzy-img-2
    series=C CacheID=40ffc8e87610eb37 State=Alerting reason="" StartsAt=00:00:00 ResolvedAt=nil LastSentAt=00:00:00 LastEval=00:00:00 EndsAt=00:04:00 img=blitzy-img-3
[Q1-fields] AFTER (t0+2*interval, B & C vanished; A keeps firing): imgCount 3->5
    series=A CacheID=40ffcae87610efd1 prev=Alerting->new=Alerting reason="" StartsAt=00:00:00 ResolvedAt=nil LastSentAt=00:02:00 LastEval=00:02:00 EndsAt=00:06:00 stale=false cachePresent=true img=blitzy-img-1 dispatched=true
    series=B CacheID=40ffc9e87610ed84 prev=Alerting->new=Normal reason="MissingSeries" StartsAt=00:00:00 ResolvedAt=00:02:00 LastSentAt=00:02:00 LastEval=00:02:00 EndsAt=00:02:00 stale=true cachePresent=false img=blitzy-img-4 dispatched=true
    series=C CacheID=40ffc8e87610eb37 prev=Alerting->new=Normal reason="MissingSeries" StartsAt=00:00:00 ResolvedAt=00:02:00 LastSentAt=00:02:00 LastEval=00:02:00 EndsAt=00:02:00 stale=true cachePresent=false img=blitzy-img-5 dispatched=true
--- PASS: TestBlitzyFixQ1DisappearedFields (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.048s
```

**Interpretation.** For the two **disappeared** series (B and C), the sweep changes precisely the following fields (comparing BEFORE→AFTER): `State` `Alerting → Normal`; `reason` `"" → "MissingSeries"`; `ResolvedAt` `nil → 00:02:00` (set because the previous state was `Alerting`); `EndsAt` `00:04:00 → 00:02:00` (collapsed to the evaluation instant); `LastEvaluationTime` advances to the sweep tick `00:02:00`; `IsStale()` becomes `true`; `cachePresent` becomes `false` (evicted); a stale image is taken (`imgCount 3->5`, tokens `blitzy-img-4`/`blitzy-img-5`); and each is `dispatched=true` (a resolved notification). `LastSentAt` is stamped `00:02:00` by `updateLastSentAt`. `StartsAt` is **preserved** at `00:00:00` (the original firing time is carried into the resolved transition). By contrast the **surviving** series A only advances its `LastEval`/`LastSentAt` to `00:02:00`, keeps `ResolvedAt=nil`, `stale=false`, `cachePresent=true`, and reuses its existing image `blitzy-img-1`. This is the complete field-level answer to "what happens to the alert states of the disappeared series." **[OBSERVED]** (fields above; the `ResolvedAt`-set-only-if-previously-`Alerting` rule is the `manager.go:604` guard, corroborated by the Q7 Pending-only case where `ResolvedAt` stays `nil`).

**Merged‑then‑filtered dispatch (Q1 + the M12 distinction) — command:**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyObsQ1SendFiltering$' -v -count=1
```

```
=== RUN   TestBlitzyObsQ1SendFiltering
[Q1-filter] t0: A,B Alerting dispatched=2 (both newly firing)
[Q1-filter] t0+2*interval(20s<30s ResendDelay): merged(allChanges)=2 dispatched(statesToSend)=1 dispatched=[B(Normal reason="MissingSeries")]
--- PASS: TestBlitzyObsQ1SendFiltering (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.040s
```

**Interpretation.** With `interval = 10s` (so `2*interval = 20s`, which is **less than** the `30s` `ResendDelay`), two series A and B fire at t0 (both dispatched). At `t0+20s`, only B has vanished. The merged `allChanges` contains **2** transitions (A maintained + B stale‑resolved), but the `send` callback receives **only 1** (`dispatched=1`): the stale‑resolved **B**. The surviving **A** is *not* dispatched, because it is a still‑`Alerting` state whose `ResendDelay` has not yet elapsed. This is the precise behavior: **all transitions are merged, then only the `NeedsSending`‑eligible ones are dispatched** — a stale resolution sends immediately, while a surviving firing series is cadence‑gated. **[OBSERVED]**

**Persistence — Part 1: store-interface calls (recorder fake).** This first run drives the **real** `SyncStatePersister` (`state.NewSyncStatePersisiter`, note the source‑code typo "Persisiter" at `persister_sync.go:24`) but wires it to `FakeInstanceStore`, which is a **recorder‑only** fake: `SaveAlertInstance` merely appends the instance to `recordedOps` (`testing.go:38-42`) and `DeleteAlertInstances` merely appends a `FakeInstanceStoreOp{Name:"DeleteAlertInstances", …}` (`testing.go:47-57`) — it maintains **no** real table. Consequently the tags printed below (`DB-DELETE`/`DB-SAVE`) are shorthand for the **store‑interface calls the persister makes**, observed at the interface boundary — *not* concrete row mutations. The concrete row effect is shown in **Part 2** below.

**Command:**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyObsQ1Q8Persistence$' -v -count=1
```

```
=== RUN   TestBlitzyObsQ1Q8Persistence
[Q1/Q8-persist] t0: A,B Alerting -> 2 store ops (predecessors persisted: 2 saves)
[Q1/Q8-persist] after B goes stale, NEW store ops this eval:
    DB-DELETE: DeleteAlertInstances (stale keys count=1)
    DB-SAVE: series=A state=Alerting reason=""
--- PASS: TestBlitzyObsQ1Q8Persistence (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.044s
```

**Interpretation.** At t0 the persister calls `SaveAlertInstance` for both A and B (`saveAlertStates` → `persister_sync.go:110`). When B goes stale, the persister calls `DeleteAlertInstances` for B's key (`deleteAlertStates` → `persister_sync.go:51-68`, the call at `:68`) and does **not** re‑save the stale transition (skip‑save at `persister_sync.go:82-84`: `// Do not save stale state to database.` / `if s.IsStale() { return nil }`), while the surviving A is re‑saved. **The observation here is exactly that these store‑interface calls occur** (recorded by the fake): the `DeleteAlertInstances` call for the stale key, the survivor re‑`SaveAlertInstance`, and the *absence* of a re‑save for the stale series. **[OBSERVED — store‑interface calls]** (recorder‑only fake; concrete rows verified in Part 2).

**Persistence — Part 2: concrete database read‑back (real sqlite store).** To close the gap that the recorder fake cannot show — that the row is *actually gone from a database* — this run wires the persister to the **real** `store.DBstore` from `tests.SetupTestEnv` (an in‑memory sqlite instance) and reads instances back via `dbstore.ListAlertInstances` before and after the stale sweep.

**Command:**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyFixConcreteDBReadback$' -v -count=1
```

```
=== RUN   TestBlitzyFixConcreteDBReadback
    util.go:158: alert definition: {orgID: 1, UID: afs0yqkqjmbr5c} with title: "an alert definition efs0yqkqjmbr4b" interval: 60 folder: namespace created
[Q1Q8-db] AFTER firing eval: dbstore.ListAlertInstances rows=1
    row: state=Alerting reason="" labels=map[series:A]
[Q1Q8-db] AFTER stale sweep: dbstore.ListAlertInstances rows=0 (concrete row deleted)
--- PASS: TestBlitzyFixConcreteDBReadback (0.21s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.256s
```

**Interpretation.** After the firing evaluation the persister has written the instance to the real sqlite store, and `dbstore.ListAlertInstances` returns **exactly one** row (`state=Alerting`, `labels=map[series:A]`). After the clock crosses `2·interval` and the stale sweep runs, the persister's `DeleteAlertInstances` executes against the real store, and the read‑back now returns **zero** rows — the concrete row is genuinely deleted, not merely a recorded interface call. This upgrades the DB‑delete claim from interface‑level to **concrete‑row** evidence. **[OBSERVED — concrete DB row]**. *Note:* the single `util.go:158` line is emitted by the `tests.CreateTestAlertRule` harness and contains a **randomly generated** rule UID (the sole non‑deterministic token in this block); the two `[Q1Q8-db]` observation lines (`rows=1` → `rows=0`) are identical across runs.

---

## Q2 — Stopped vs. slow

**Question.** How does the scheduler distinguish a series that has *stopped* reporting from one that is merely *slow* (temporarily late)?

**Answer.** It does **not** perform any per‑series liveness probe or "is it slow?" test. The distinction is **purely time‑based**: a series that returns within two evaluation intervals is simply updated (never considered stale), whereas a series absent for **at least two intervals** is swept. "Slow" and "stopped" are the same code path — the only difference is whether the series reappears before the `stateIsStale` cutoff. **[OBSERVED]** (evidence below).

**Mechanism.**
- Absent series are never touched by `setNextStateForRule`, so their `LastEvaluationTime` stays old; staleness is decided solely by `stateIsStale(evaluatedAt, s.LastEvaluationTime, alertRule.IntervalSeconds)` inside the `deleteStaleStatesFromCache` predicate (`manager.go:589-590`, formula at `manager.go:627`). **[INFERRED]** (source).
- A series that reappears within the window is updated normally via `setNextStateForRule` → `setNextState` (`manager.go:437`), refreshing `LastEvaluationTime` and resetting the staleness clock. **[INFERRED]** (source; confirmed below).

**Observed evidence — command:**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyObsQ2StoppedVsSlow$' -v -count=1
```

```
=== RUN   TestBlitzyObsQ2StoppedVsSlow
[Q2] t0: A,B Alerting; cacheCount=2
[Q2] t0+1*interval (B absent 1 interval = SLOW): cacheCount=2 (B still present? true)
[Q2] B returned within window: cacheCount=2 (B present? true)
[Q2] t+2*interval (B absent 2 intervals = STOPPED): cacheCount=1 (B present? false)
--- PASS: TestBlitzyObsQ2StoppedVsSlow (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.045s
```

**Interpretation.** Two series A, B fire at t0 (`cacheCount=2`). When B is absent for **one** interval it is treated as merely *slow* — it survives (`cacheCount=2`, `B present? true`) because `stateIsStale` is `false` at `< 2*interval`. B then *returns* and is refreshed normally. Only when B is absent for **two** intervals is it treated as *stopped* and swept (`cacheCount=1`, `B present? false`). There is no separate probe — the same time comparison decides both cases. **[OBSERVED]**

---

## Q3 — Staleness threshold and formula

**Question.** There is a staleness‑detection threshold in the evaluation loop — trace exactly *when* the boundary is crossed and *what formula* determines the cutoff.

**Answer.** The cutoff is a single expression in `stateIsStale`: a series is stale **iff `evaluatedAt >= lastEval + 2*interval`**, i.e. once it has not been evaluated for **at least two full evaluation intervals**. The boundary is crossed at **exactly `lastEval + 2*interval`** (equality counts as stale). At this commit the multiplier `2` is **hard‑coded**. **[OBSERVED]** (canonical evidence below).

**Mechanism — `stateIsStale` (`pkg/services/ngalert/state/manager.go:627`):**

```go
func stateIsStale(evaluatedAt time.Time, lastEval time.Time, intervalSeconds int64) bool {
	return !lastEval.Add(2 * time.Duration(intervalSeconds) * time.Second).After(evaluatedAt)
}
```

The predicate returns `true` when `lastEval + 2*interval` is **not after** `evaluatedAt` — i.e. when `evaluatedAt >= lastEval + 2*interval` (equality‑inclusive). It is invoked from the `deleteStaleStatesFromCache` predicate (`manager.go:589-590`) using each state's `LastEvaluationTime` and the rule's `IntervalSeconds`. **[INFERRED]** (source).

**Canonical observation — driven through `Manager.ProcessEvalResults` (command):**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyObsQ3StaleBoundaryCanonical$' -v -count=1
```

```
=== RUN   TestBlitzyObsQ3StaleBoundaryCanonical
[Q3-canonical] ProcessEvalResults +119s (=1.98 intervals) absent -> cacheCount=1 (survives, NOT stale)
[Q3-canonical] ProcessEvalResults +120s (=2.00 intervals) absent -> cacheCount=0 (swept, stale)
--- PASS: TestBlitzyObsQ3StaleBoundaryCanonical (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.045s
```

**Interpretation (canonical).** With `interval = 60s`, a series is fired `Alerting`, then an **empty** result set is fed through the real `ProcessEvalResults`. At `+119s` (`= 1.98 intervals`) the series **survives** the sweep (`cacheCount=1`); at `+120s` (`= 2.00 intervals`, a fresh manager) it is **swept** (`cacheCount=0`). The boundary is therefore crossed at exactly `+2*interval`, confirming `evaluatedAt >= lastEval + 2*interval`. This is the canonical path (the scheduler's own entry point), not a direct call to the unexported helper. **[OBSERVED]**

**Predicate‑level corroboration (HELPER, non‑canonical) — command:**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyObsQ3StaleBoundaryHelper$' -v -count=1
```

```
=== RUN   TestBlitzyObsQ3StaleBoundaryHelper
[Q3-helper] stateIsStale formula: !lastEval.Add(2*interval).After(evaluatedAt); interval=60s lastEval=2024-01-01T00:00:00Z
[Q3-helper] evaluatedAt = lastEval +   0s (=0.00 intervals) -> stateIsStale = false
[Q3-helper] evaluatedAt = lastEval +  60s (=1.00 intervals) -> stateIsStale = false
[Q3-helper] evaluatedAt = lastEval + 119s (=1.98 intervals) -> stateIsStale = false
[Q3-helper] evaluatedAt = lastEval + 120s (=2.00 intervals) -> stateIsStale = true
[Q3-helper] evaluatedAt = lastEval + 121s (=2.02 intervals) -> stateIsStale = true
[Q3-helper] evaluatedAt = lastEval + 180s (=3.00 intervals) -> stateIsStale = true
--- PASS: TestBlitzyObsQ3StaleBoundaryHelper (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.042s
```

**Interpretation (helper).** Calling the unexported `stateIsStale` directly across offsets confirms `0/60/119s → false` and `120/121/180s → true`. This is a **predicate‑level** view (it bypasses the scheduler) and is labeled **non‑canonical**; it merely corroborates the canonical `ProcessEvalResults` result above and the existing `TestStateIsStale`. **[OBSERVED]**

**Nanosecond boundary triad — canonical (`ProcessEvalResults`) and predicate.** The whole‑second observations above land the boundary between `119s` and `120s`; to pin it to the *nanosecond*, the next two runs bracket exactly `2·interval` with a `−1ns / equality / +1ns` triad. The first drives the **canonical** `ProcessEvalResults`; the second calls the predicate directly.

**Command (canonical, nanosecond):**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyFixStaleNanoCanonical$' -v -count=1
```

```
=== RUN   TestBlitzyFixStaleNanoCanonical
[Q3-canonical-nano] ProcessEvalResults +(2*interval - 1ns) absent -> cacheCount=1 (survives, NOT stale)
[Q3-canonical-nano] ProcessEvalResults +(2*interval)      absent -> cacheCount=0 (swept, stale)
--- PASS: TestBlitzyFixStaleNanoCanonical (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.045s
```

**Command (predicate, nanosecond triad):**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyFixStaleNanoTriad$' -v -count=1
```

```
=== RUN   TestBlitzyFixStaleNanoTriad
[Q3-nano] stateIsStale(evaluatedAt,lastEval,interval=60s): 2*interval=2m0s lastEval=2024-01-01T00:00:00Z
[Q3-nano] offset=1m59.999999999s  -> stateIsStale=false (2*interval - 1ns -> NOT stale)
[Q3-nano] offset=2m0s             -> stateIsStale=true  (2*interval (equality) -> stale)
[Q3-nano] offset=2m0.000000001s   -> stateIsStale=true  (2*interval + 1ns -> stale)
--- PASS: TestBlitzyFixStaleNanoTriad (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.039s
```

**Interpretation (nanosecond).** Canonically, at `2·interval − 1ns` the absent series **survives** (`cacheCount=1`) and at exactly `2·interval` it is **swept** (`cacheCount=0`). The predicate confirms the same edge to nanosecond precision: `1m59.999999999s → false`, `2m0s → true` (equality is stale, because the formula uses `!(…).After(…)`), `2m0.000000001s → true`. This is the exact `manager.go:627` boundary, `evaluatedAt >= lastEval + 2*interval`, resolved to the nanosecond. **[OBSERVED]**

---

## Q4 — Resolved-notification retention window

**Question.** Once a vanished series transitions to Resolved, notifications keep flowing downstream for a while — what controls that retention window, and when does the system finally *stop* sending resolved alerts to notification channels?

**Answer.** The retention window is controlled by **`ResolvedRetention`**, default **`15m`**. A **naturally‑resolved** series (still present, metric recovered) keeps re‑sending the resolved notification until `LastEvaluationTime − ResolvedAt` **exceeds** `ResolvedRetention`, at which point `NeedsSending` returns `false` and sending stops. A **stale‑resolved** series (the series vanished) is different: it is sent **once** at detection and **evicted the same cycle**, so it never reaches later cycles to be re‑sent. **[OBSERVED]** (evidence below).

**Mechanism.**
- `ResolvedRetention` config wiring: default `15m` parsed at `pkg/setting/setting_unified_alerting.go:465` (field `ResolvedAlertRetention` at `:125`), shipped default `resolved_alert_retention = 15m` at `conf/defaults.ini:1365`, wired into the state manager at `pkg/services/ngalert/ngalert.go:415` (`ResolvedRetention: ng.Cfg.UnifiedAlerting.ResolvedAlertRetention`). **[INFERRED]** (source lines).
- Send gating: `State.NeedsSending` suppresses a `Normal` state once `a.LastEvaluationTime.Sub(*a.ResolvedAt) > resolvedRetention` (`pkg/services/ngalert/state/state.go:513-515`). **[INFERRED]** (source; effect observed below).
- Stale‑resolved eviction: after the sweep sets the state `Normal`/`MissingSeries`, `IsStale()` (`state.go:574`) is true, so the persister **deletes** its row via `deleteAlertStates` (`persister_sync.go:51-68`, the `DeleteAlertInstances` call at `:68`) and **does not re‑save** the stale transition (skip‑save at `persister_sync.go:82-84`: `// Do not save stale state to database.` / `if s.IsStale() { return nil }`); it is also removed from the in‑memory cache (`cache.go:255` → `cache.go:244-252`) — so it cannot re‑send. **[INFERRED]** (source; observed in Part 2 below). *(Note: `:82-84` is the **skip‑save** guard, not the delete; the actual row deletion is `:51-68`.)*
- Downstream dispatch endpoint (named, not exercised over the wire here): in the scheduler, `ProcessEvalResults`' `send` callback (`pkg/services/ngalert/schedule/alert_rule.go:441-455`) builds `definitions.PostableAlerts` and calls the notifier via `send(...)` (`schedule/alert_rule.go:462-473`, `sender.Send` at `:470`); a *separate* `expireAndSend` (`schedule/alert_rule.go:476-480`, called on rule stop/reset at `:356` and `:490`) expires alerts. The state‑package observations here capture the **decision to send** (the `statesToSend` filtering), not the alertmanager wire call. **[INFERRED]** (source lines).

**Observed evidence — command (this run also grounds Q5's `cachedLastSentAt`):**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyObsQ4Q5SendLifecycle$' -v -count=1
```

```
=== RUN   TestBlitzyObsQ4Q5SendLifecycle
[Q4/Q5] Part 1 NATURAL resolution: interval=30s ResendDelay=30s ResolvedRetention=15m
[Q4/Q5] t= 0.0m Alerting         sent=1 cachedLastSentAt=00:00:00
[Q4/Q5] t= 0.5m Normal(resolved) sent=1 sinceResolved=0.0m cachedLastSentAt=00:00:30
[Q4/Q5] t= 1.0m Normal(resolved) sent=1 sinceResolved=0.5m cachedLastSentAt=00:01:00
[Q4/Q5] t= 1.5m Normal(resolved) sent=1 sinceResolved=1.0m cachedLastSentAt=00:01:30
[Q4/Q5] t= 2.0m Normal(resolved) sent=1 sinceResolved=1.5m cachedLastSentAt=00:02:00
[Q4/Q5] t= 2.5m Normal(resolved) sent=1 sinceResolved=2.0m cachedLastSentAt=00:02:30
[Q4/Q5] t= 3.0m Normal(resolved) sent=1 sinceResolved=2.5m cachedLastSentAt=00:03:00
[Q4/Q5] t= 3.5m Normal(resolved) sent=1 sinceResolved=3.0m cachedLastSentAt=00:03:30
[Q4/Q5] t= 4.0m Normal(resolved) sent=1 sinceResolved=3.5m cachedLastSentAt=00:04:00
[Q4/Q5] t= 4.5m Normal(resolved) sent=1 sinceResolved=4.0m cachedLastSentAt=00:04:30
[Q4/Q5] t= 5.0m Normal(resolved) sent=1 sinceResolved=4.5m cachedLastSentAt=00:05:00
[Q4/Q5] t= 5.5m Normal(resolved) sent=1 sinceResolved=5.0m cachedLastSentAt=00:05:30
[Q4/Q5] t= 6.0m Normal(resolved) sent=1 sinceResolved=5.5m cachedLastSentAt=00:06:00
[Q4/Q5] t= 6.5m Normal(resolved) sent=1 sinceResolved=6.0m cachedLastSentAt=00:06:30
[Q4/Q5] t= 7.0m Normal(resolved) sent=1 sinceResolved=6.5m cachedLastSentAt=00:07:00
[Q4/Q5] t= 7.5m Normal(resolved) sent=1 sinceResolved=7.0m cachedLastSentAt=00:07:30
[Q4/Q5] t= 8.0m Normal(resolved) sent=1 sinceResolved=7.5m cachedLastSentAt=00:08:00
[Q4/Q5] t= 8.5m Normal(resolved) sent=1 sinceResolved=8.0m cachedLastSentAt=00:08:30
[Q4/Q5] t= 9.0m Normal(resolved) sent=1 sinceResolved=8.5m cachedLastSentAt=00:09:00
[Q4/Q5] t= 9.5m Normal(resolved) sent=1 sinceResolved=9.0m cachedLastSentAt=00:09:30
[Q4/Q5] t=10.0m Normal(resolved) sent=1 sinceResolved=9.5m cachedLastSentAt=00:10:00
[Q4/Q5] t=10.5m Normal(resolved) sent=1 sinceResolved=10.0m cachedLastSentAt=00:10:30
[Q4/Q5] t=11.0m Normal(resolved) sent=1 sinceResolved=10.5m cachedLastSentAt=00:11:00
[Q4/Q5] t=11.5m Normal(resolved) sent=1 sinceResolved=11.0m cachedLastSentAt=00:11:30
[Q4/Q5] t=12.0m Normal(resolved) sent=1 sinceResolved=11.5m cachedLastSentAt=00:12:00
[Q4/Q5] t=12.5m Normal(resolved) sent=1 sinceResolved=12.0m cachedLastSentAt=00:12:30
[Q4/Q5] t=13.0m Normal(resolved) sent=1 sinceResolved=12.5m cachedLastSentAt=00:13:00
[Q4/Q5] t=13.5m Normal(resolved) sent=1 sinceResolved=13.0m cachedLastSentAt=00:13:30
[Q4/Q5] t=14.0m Normal(resolved) sent=1 sinceResolved=13.5m cachedLastSentAt=00:14:00
[Q4/Q5] t=14.5m Normal(resolved) sent=1 sinceResolved=14.0m cachedLastSentAt=00:14:30
[Q4/Q5] t=15.0m Normal(resolved) sent=1 sinceResolved=14.5m cachedLastSentAt=00:15:00
[Q4/Q5] t=15.5m Normal(resolved) sent=1 sinceResolved=15.0m cachedLastSentAt=00:15:30
[Q4/Q5] t=16.0m Normal(resolved) sent=0 sinceResolved=15.5m cachedLastSentAt=00:15:30
[Q4/Q5] t=16.5m Normal(resolved) sent=0 sinceResolved=16.0m cachedLastSentAt=00:15:30
[Q4/Q5] Part 1 resolved sends total=31 = 1 immediate + 30 re-sends; sending stopped at t=16.0m (ResolvedAt=00:00:30)
[Q4/Q5] Part 2 STALE resolution: interval=60s
[Q4/Q5] t=0 Alerting sent=1 cacheCount=1
[Q4/Q5] t=2*interval A vanished -> stale detection: sent=1 cacheCount=0
[Q4/Q5] t=3*interval A still absent (already evicted): sent=0 cacheCount=0
--- PASS: TestBlitzyObsQ4Q5SendLifecycle (0.04s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.084s
```

**Interpretation (Q4).** In **Part 1** (natural resolution, series stays present; `interval = 30s`), the series resolves at `t=0.5m` (`ResolvedAt` then set to `00:00:30`) and re‑sends while `sinceResolved = LastEvaluationTime − ResolvedAt ≤ 15m`. The last send is at `t=15.5m` (where `sinceResolved = 15.0m`); sending **stops at `t=16.0m`** — the first cycle where `sinceResolved = 15.5m` exceeds `15m` (`sent=0`, and `cachedLastSentAt` freezes at `00:15:30`). That is exactly the `state.go:513-515` cutoff. In **Part 2** (stale resolution, series vanished; `interval = 60s`), the series is `Alerting` at `t=0` (`sent=1`, `cacheCount=1`); at `t=2*interval` it is detected stale, resolved, sent **once** (`sent=1`) and **evicted** (`cacheCount=0`); by `t=3*interval` nothing remains (`sent=0`, `cacheCount=0`). So the retention window applies to **naturally‑resolved** series that remain present; a **vanished** series is resolved once and forgotten. **[OBSERVED]**

**Sender/compat mapping — how a send‑eligible stale transition becomes a `PostableAlert`.** The state‑package evidence above captures the *decision to send*; this sub‑block exercises the **exact mapping functions** the scheduler's `send` callback uses to turn that decision into an Alertmanager `PostableAlert`, so the annotations that reach the notifier are observed directly rather than inferred.

**Command:**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyFixSenderMapping$' -v -count=1
```

```
=== RUN   TestBlitzyFixSenderMapping
[Q4Q6-map] StateToPostableAlert(stale-resolved A):
    labels=map[series:A]
    annotation[__alertImageToken__]="blitzy-img-2"
    annotation[grafana_state_reason]="MissingSeries"
    StartsAt=1970-01-01T00:00:00.000Z EndsAt=1970-01-01T00:02:00.000Z generatorURL="http://localhost:3000"
[Q4Q6-map] FromAlertsStateToStoppedAlert(was-Alerting stale): produced 1 stopped alert(s); EndsAt=1970-01-01T00:02:00.000Z
[Q4Q6-map] FromAlertsStateToStoppedAlert(never-fired Normal stale): produced 0 stopped alert(s) (PreviousState==Normal skipped)
--- PASS: TestBlitzyFixSenderMapping (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.042s
```

**Interpretation.** `StateToPostableAlert` (`pkg/services/ngalert/state/compat.go:35`) maps a stale‑resolved transition into a `models.PostableAlert` carrying the series labels (`map[series:A]`) plus two annotations set by name: the screenshot token `__alertImageToken__` (`ImageTokenAnnotation`, set at `compat.go:51-53` from `alertState.Image.Token`, here `"blitzy-img-2"`) and `grafana_state_reason` (`StateReasonAnnotation`, set at `compat.go:55-57` from `alertState.StateReason`, here `"MissingSeries"`). The `EndsAt` reflects the resolved window (`00:02:00`) and `generatorURL` is the external URL. The companion `FromAlertsStateToStoppedAlert` (`compat.go:143`) — used by `expireAndSend` to *stop* alerts — produces **1** stopped alert for a formerly‑`Alerting` stale series but **0** for a never‑fired series whose `PreviousState == Normal` (skipped by the `if transition.PreviousState == eval.Normal || transition.PreviousState == eval.Pending { continue }` guard at `compat.go:147-149`; `EndsAt` set to `clock.Now()` at `compat.go:151`). This is exactly what the scheduler wires: the normal `send` callback maps via `StateToPostableAlert` and calls `sender.Send` (`pkg/services/ngalert/schedule/alert_rule.go:462-470`), while the reset/stop path calls `FromAlertsStateToStoppedAlert` then dispatches (`schedule/alert_rule.go:476-479`). So a stale‑resolved formerly‑firing series produces a resolved `PostableAlert` annotated `grafana_state_reason=MissingSeries` (and carrying its image token), whereas a never‑fired vanished series produces no stopped alert. **[OBSERVED — mapping output]**

---

## Q5 — Interplay of resend delay, resolved retention, and last-sent timestamp

**Question.** How do the **resend delay**, the **resolved retention period**, and the **last-sent timestamp** interact across repeated evaluation cycles?

**Answer.** Three fields cooperate inside `NeedsSending` + `updateLastSentAt`:
- **`ResendDelay` (30s)** sets the *cadence* — a resolved `Normal` state re‑sends on the first evaluation where `LastSentAt + ResendDelay <= LastEvaluationTime` (a **minimum spacing**, not an independent timer).
- **`LastSentAt`** is the *gate* — it is stamped to the current `evaluatedAt` on every send by `updateLastSentAt`, which is what enforces the spacing on subsequent cycles. It is stored **in the cached `State`** and read back from the cache (not assigned manually).
- **`ResolvedRetention` (15m)** is the *hard stop* — once `LastEvaluationTime − ResolvedAt > 15m`, `NeedsSending` returns `false` regardless of cadence.

Result: a resolved series re‑sends every `ResendDelay` (subject to the interval granularity) from resolution up to the retention limit, then stops. **[OBSERVED]** (evidence below).

**Mechanism.**
- `State.NeedsSending(resendDelay, resolvedRetention)` — `pkg/services/ngalert/state/state.go:500-519`:
  - `eval.Pending` → `false` (`state.go:501-504`).
  - Newly resolved → `true` when `a.ResolvedAt != nil && (a.LastSentAt == nil || a.ResolvedAt.After(*a.LastSentAt))` (`state.go:507-509`).
  - Retention hard‑stop → `false` when `a.State == eval.Normal && (a.ResolvedAt == nil || a.LastEvaluationTime.Sub(*a.ResolvedAt) > resolvedRetention)` (`state.go:513-515`).
  - Cadence re‑send → `return a.LastSentAt == nil || !a.LastSentAt.Add(resendDelay).After(a.LastEvaluationTime)` (`state.go:519`).
- `Manager.updateLastSentAt` — `pkg/services/ngalert/state/manager.go:359-363`: for each transition, `if t.NeedsSending(st.ResendDelay, st.ResolvedRetention) { t.LastSentAt = &evaluatedAt; result = append(result, t) }`. Its doc‑comment (`manager.go:358`) explicitly notes it is *not* idempotent. **[INFERRED]** (source).

**Manager‑observed `LastSentAt` (M11).** In the Q4 `TestBlitzyObsQ4Q5SendLifecycle` output above, the **`cachedLastSentAt`** column is read back from the cache via `GetStatesForRuleUID` **after each `ProcessEvalResults`** — it is the *actual* value the manager stamped, not a manually assigned field. It advances by one `ResendDelay` step per send (`00:00:30 → 00:01:00 → …`) and **freezes** at `00:15:30` once sending stops at `t=16.0m`. That is the canonical, manager‑observed interplay of the three values.

**Predicate‑level interplay (non‑canonical corroboration) — command:**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyObsQ5NeedsSendingPredicate$' -v -count=1
```

```
=== RUN   TestBlitzyObsQ5NeedsSendingPredicate
[Q5-pred] ResendDelay=30s ResolvedRetention=15m0s (State=Normal, resolved at t=0)
[Q5-pred] t=  0.0m sinceResolved= 0.00m LastSentAt(pre)=nil     NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t=  0.5m sinceResolved= 0.50m LastSentAt(pre)=0s      NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t=  1.0m sinceResolved= 1.00m LastSentAt(pre)=30s     NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t=  1.5m sinceResolved= 1.50m LastSentAt(pre)=1m0s    NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t=  2.0m sinceResolved= 2.00m LastSentAt(pre)=1m30s   NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t=  2.5m sinceResolved= 2.50m LastSentAt(pre)=2m0s    NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t=  3.0m sinceResolved= 3.00m LastSentAt(pre)=2m30s   NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t=  3.5m sinceResolved= 3.50m LastSentAt(pre)=3m0s    NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t=  4.0m sinceResolved= 4.00m LastSentAt(pre)=3m30s   NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t=  4.5m sinceResolved= 4.50m LastSentAt(pre)=4m0s    NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t=  5.0m sinceResolved= 5.00m LastSentAt(pre)=4m30s   NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t=  5.5m sinceResolved= 5.50m LastSentAt(pre)=5m0s    NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t=  6.0m sinceResolved= 6.00m LastSentAt(pre)=5m30s   NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t=  6.5m sinceResolved= 6.50m LastSentAt(pre)=6m0s    NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t=  7.0m sinceResolved= 7.00m LastSentAt(pre)=6m30s   NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t=  7.5m sinceResolved= 7.50m LastSentAt(pre)=7m0s    NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t=  8.0m sinceResolved= 8.00m LastSentAt(pre)=7m30s   NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t=  8.5m sinceResolved= 8.50m LastSentAt(pre)=8m0s    NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t=  9.0m sinceResolved= 9.00m LastSentAt(pre)=8m30s   NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t=  9.5m sinceResolved= 9.50m LastSentAt(pre)=9m0s    NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t= 10.0m sinceResolved=10.00m LastSentAt(pre)=9m30s   NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t= 10.5m sinceResolved=10.50m LastSentAt(pre)=10m0s   NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t= 11.0m sinceResolved=11.00m LastSentAt(pre)=10m30s  NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t= 11.5m sinceResolved=11.50m LastSentAt(pre)=11m0s   NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t= 12.0m sinceResolved=12.00m LastSentAt(pre)=11m30s  NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t= 12.5m sinceResolved=12.50m LastSentAt(pre)=12m0s   NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t= 13.0m sinceResolved=13.00m LastSentAt(pre)=12m30s  NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t= 13.5m sinceResolved=13.50m LastSentAt(pre)=13m0s   NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t= 14.0m sinceResolved=14.00m LastSentAt(pre)=13m30s  NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t= 14.5m sinceResolved=14.50m LastSentAt(pre)=14m0s   NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t= 15.0m sinceResolved=15.00m LastSentAt(pre)=14m30s  NeedsSending=true  SEND -> LastSentAt updated
[Q5-pred] t= 15.5m sinceResolved=15.50m LastSentAt(pre)=15m0s   NeedsSending=false -
[Q5-pred] t= 16.0m sinceResolved=16.00m LastSentAt(pre)=15m0s   NeedsSending=false -
[Q5-pred] t= 16.5m sinceResolved=16.50m LastSentAt(pre)=15m0s   NeedsSending=false -
[Q5-pred] total resolved sends across 0..16.5m = 31 (1 immediate + 30 re-sends); first stop at t=15.5m
--- PASS: TestBlitzyObsQ5NeedsSendingPredicate (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.040s
```

**Interpretation.** With `State=Normal`, `ResolvedAt=t0`, `ResendDelay=30s`, `ResolvedRetention=15m`, the state re‑sends on every 30s step from `t=0.0m` through `t=15.0m` — **31 total resolved sends = 1 immediate send (at `t=0`) + 30 re‑sends (`t=0.5m … 15.0m`)** (m13) — each send bumping `LastSentAt` (visible as `LastSentAt(pre)` trailing the current time by one 30s step). Sending then **STOPS** at `t=15.5m`, the first step where `sinceResolved = 15.50m` exceeds `15m`. This is a **predicate‑level** view (it drives `NeedsSending` directly and bumps `LastSentAt` exactly as `updateLastSentAt` does) and is labeled **non‑canonical**; the canonical manager‑observed equivalent is the `cachedLastSentAt` column in Q4. Note the predicate stop is `t=15.5m` (resolved at `t=0`) while the canonical natural‑resolution stop in Q4 is `t=16.0m` (resolved at `t=0.5m`) — the *same* rule measured from different `ResolvedAt` origins. **[OBSERVED]**

**Cadence qualification (m14) — command:**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyObsQ5CadenceQualification$' -v -count=1
```

```
=== RUN   TestBlitzyObsQ5CadenceQualification
[Q5-cadence] interval=20s ResendDelay=30s; t=0s Alerting sent=1
[Q5-cadence] t= 20s Normal(resolved) sent=1 cachedLastSentAt=00:00:20
[Q5-cadence] t= 40s Normal(resolved) sent=0 cachedLastSentAt=00:00:20
[Q5-cadence] t= 60s Normal(resolved) sent=1 cachedLastSentAt=00:01:00
[Q5-cadence] t= 80s Normal(resolved) sent=0 cachedLastSentAt=00:01:00
[Q5-cadence] t=100s Normal(resolved) sent=1 cachedLastSentAt=00:01:40
[Q5-cadence] t=120s Normal(resolved) sent=0 cachedLastSentAt=00:01:40
[Q5-cadence] t=140s Normal(resolved) sent=1 cachedLastSentAt=00:02:20
[Q5-cadence] t=160s Normal(resolved) sent=0 cachedLastSentAt=00:02:20
[Q5-cadence] resolved send times (s) = [20 60 100 140] (spaced 2 intervals=40s, NOT every 20s eval)
--- PASS: TestBlitzyObsQ5CadenceQualification (0.01s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.047s
```

**Interpretation.** With `interval = 20s` (**shorter** than the `30s` `ResendDelay`), the resolved series re‑sends at `t = 20s, 60s, 100s, 140s` — i.e. on **every second evaluation** (40s apart), **not** every 20s evaluation. This proves `ResendDelay` is a **minimum spacing** evaluated at evaluation boundaries (`state.go:519`), not an independent 30s timer: a send occurs on the *first* evaluation at or after `LastSentAt + 30s`. The exact‑30s cadence seen in Q4 is a consequence of that run using a 30s interval. **[OBSERVED]**

**Nanosecond boundary triads — `ResendDelay = 30s` and `ResolvedRetention = 15m`.** The step‑level runs above land each boundary between adjacent evaluation ticks; the next two runs pin the `NeedsSending` gates to the *nanosecond* with `−1ns / equality / +1ns` triads, exercising `state.go:519` (resend cadence) and `state.go:513-515` (retention hard‑stop) directly.

**Command (resend‑delay nanosecond triad):**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyFixResendNanoTriad$' -v -count=1
```

```
=== RUN   TestBlitzyFixResendNanoTriad
[Q5-resend-nano] ResendDelay=30s (State=Normal, ResolvedAt=t0, LastSentAt=t0)
[Q5-resend-nano] sinceLastSent=29.999999999s    -> NeedsSending=false -> 0 (LastSentAt+30s - 1ns -> NOT due (0))
[Q5-resend-nano] sinceLastSent=30s              -> NeedsSending=true  -> 1 (LastSentAt+30s (equality) -> due (1))
[Q5-resend-nano] sinceLastSent=30.000000001s    -> NeedsSending=true  -> 1 (LastSentAt+30s + 1ns -> due (1))
--- PASS: TestBlitzyFixResendNanoTriad (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.040s
```

**Command (resolved‑retention nanosecond triad):**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyFixRetentionNanoTriad$' -v -count=1
```

```
=== RUN   TestBlitzyFixRetentionNanoTriad
[Q5-retention-nano] ResolvedRetention=15m0s (State=Normal, ResolvedAt=t0, LastSentAt=t0)
[Q5-retention-nano] sinceResolved=14m59.999999999s -> NeedsSending=true  -> 1 (sinceResolved 15m - 1ns -> still sends (1))
[Q5-retention-nano] sinceResolved=15m0s            -> NeedsSending=true  -> 1 (sinceResolved 15m (equality, strict >) -> still sends (1))
[Q5-retention-nano] sinceResolved=15m0.000000001s  -> NeedsSending=false -> 0 (sinceResolved 15m + 1ns -> suppressed (0))
--- PASS: TestBlitzyFixRetentionNanoTriad (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.039s
```

**Interpretation (nanosecond).** The two gates have **opposite** equality behavior, which the triads make exact:
- **Resend cadence (`state.go:519`, `!a.LastSentAt.Add(resendDelay).After(a.LastEvaluationTime)`)** — at `LastSentAt + 30s − 1ns` a re‑send is **not** due (`0`); at exactly `+30s` it **is** due (`1`, because `!(…).After(…)` treats equality as "reached"); at `+30s + 1ns` due (`1`). So `30s` is an **inclusive floor**.
- **Retention hard‑stop (`state.go:513-515`, `a.LastEvaluationTime.Sub(*a.ResolvedAt) > resolvedRetention`)** — at `15m − 1ns` still sends (`1`); at exactly `15m` still sends (`1`, because the comparison is **strict `>`**, so equality does *not* suppress); at `15m + 1ns` suppressed (`0`). So `15m` is an **exclusive ceiling** (suppression begins strictly *after* 15m).

These are the two `state.go` comparisons resolved to nanosecond precision, and they explain the whole‑minute stop points seen in Q4/Q5 above. **[OBSERVED]**

**A previously‑resolved `Normal` series that goes stale emits one *final gated* send (command).** This is the runtime backing for the `StalePrevResolvedFinalSend` branch of the Overview diagram (which corrects an earlier lump that implied *all* old‑`Normal` stale entries send nothing). A series fires, **naturally resolves** (setting `ResolvedAt`/`LastSentAt`), then **vanishes** while still inside the retention window and past the resend floor — and the three gate values (`ResendDelay`, `ResolvedRetention`, `LastSentAt`) decide whether that stale transition is dispatched.

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyFixOldNormalStaleSend$' -v -count=1
```

```
=== RUN   TestBlitzyFixOldNormalStaleSend
[Q6-oldnormal] t0+60s NATURAL RESOLVE: state=Normal reason="" ResolvedAt=00:01:00 LastSentAt=00:01:00 dispatched=true
[Q6-oldnormal] t0+240s STALE (was previously-resolved Normal): prev=Normal->new=Normal reason="MissingSeries" ResolvedAt=00:01:00 LastSentAt=00:04:00 dispatched=true cachePresent=false
[Q6-oldnormal] predicate sweep of the stale-send gate NeedsSending(30s,15m):
    <resend (20s since last send)      -> NeedsSending=false -> 0
    ==resend (30s since last send)     -> NeedsSending=true -> 1
    >retention (16m since resolved)    -> NeedsSending=false -> 0
--- PASS: TestBlitzyFixOldNormalStaleSend (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.044s
```

**Interpretation.** At `t0+60s` the series resolves naturally (`ResolvedAt=00:01:00`, `LastSentAt=00:01:00`, `dispatched=true`). At `t0+240s` it has **vanished**; the stale sweep sets `prev=Normal → Normal` with `reason=MissingSeries` but — because `oldState != Alerting` — creates **no new** `ResolvedAt` (the earlier `00:01:00` is **retained**). Critically, the transition **is still dispatched** (`dispatched=true`): `LastSentAt` advances `00:01:00 → 00:04:00`, because the retained `ResolvedAt=00:01:00` is `3m` old (inside the `15m` retention) and the last send was `3m` ago (past the `30s` resend floor). The entry is then evicted (`cachePresent=false`), so this is a **single, final** send — it cannot re‑send on later cycles. The predicate sweep isolates the gate: `<resend (20s) → 0`, `==resend (30s) → 1`, `>retention (16m) → 0`. So a previously‑resolved `Normal` that goes stale is **not** unconditionally silent — it emits exactly one further resolved notification **iff** the resend/retention gates permit, then disappears. This is precisely the three‑value interplay of Q5 applied to the stale sweep, and it is what the `StalePrevResolvedFinalSend` diagram branch encodes. **[OBSERVED]**

---

## Q6 — Screenshot / image capture behavior

**Question.** Do stale‑series resolutions trigger the *same* screenshot/image capture behavior as alerts that resolve naturally (metric values dropping below threshold), or do disappearing series take a different path?

**Answer.** Both paths call the **same** function `takeImage` (`state.go:589`), but reach it through **different guards**. The natural‑resolution path uses `shouldTakeImage(...)` (`manager.go:513`); the stale path takes an image only when `oldState == eval.Alerting` (`manager.go:604`). Consequences, all confirmed at runtime with a **counting / unique‑token** image capturer (so an actual `NewImage` invocation is provable, unlike `NoopImageService` which returns a non‑nil empty image): (A) an `Alerting` series that vanishes gets a **new** image (invocation count increments) and `ResolvedAt`; (B) a series that was only `Pending`/`Normal` when it vanished gets **no** new image and **no** new `ResolvedAt`; (C–E) even an `Alerting`‑vanish gets **no** image when `takeImage` swallows a named error to `nil,nil`; (F) an unexpected image error is **swallowed** — the image is `nil` yet `ResolvedAt` is set and resolution still completes (the code *also* emits a `Warn` log at `manager.go:608-611`, which is **[INFERRED]** — the test's Nop logger does not surface it; see (F)); (G) a natural resolution gets an image via `shouldTakeImage`. **[OBSERVED]** (evidence below, except the log line as noted).

**Mechanism.**
- Natural path: `setNextState` sets `newlyResolved` when `oldState == eval.Alerting && currentState.State == eval.Normal` (`manager.go:505-509`), then `if shouldTakeImage(currentState.State, oldState, currentState.Image, newlyResolved)` (`manager.go:513`) → `takeImage(...)` (`manager.go:514`). For `Normal→Normal`/`Normal→Pending` the pre‑existing `ResolvedAt` is **retained** (`manager.go:509-510` comment). **[INFERRED]** (source).
- Stale path: inside `deleteStaleStatesFromCache`, `if oldState == eval.Alerting { s.ResolvedAt = &evaluatedAt; image, err := takeImage(...); ... }` (`manager.go:604-613`). When `oldState != eval.Alerting`, this block is skipped — the sweep neither creates a new image nor a new `ResolvedAt`, and (crucially) does **not clear** any pre‑existing ones (`SetNormal` at `state.go:162-168` touches only `State`/`StateReason`/`StartsAt`/`EndsAt`/`Error`). **[INFERRED]** (source; the retain‑vs‑no‑new distinction is confirmed in Q7's old‑Normal case).
- `shouldTakeImage` — `state.go:581`: `return resolved || (state == eval.Alerting && previousState != eval.Alerting) || (state == eval.Alerting && previousImage == nil)`. **[INFERRED]** (source).
- `takeImage` — `state.go:589-601`: calls `s.NewImage`, returning `(nil, nil)` on `screenshot.ErrScreenshotsUnavailable`, `models.ErrNoDashboard`, or `models.ErrNoPanel`; `(nil, err)` on any other error; else `(img, nil)`. **[INFERRED]** (source; each branch observed below).

**Observed evidence — command:**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyObsQ6Screenshot$' -v -count=1
```

```
=== RUN   TestBlitzyObsQ6Screenshot
[Q6][A Alerting-vanish COUNTING] preState=Alerting -> new=Normal reason="MissingSeries" NewImageCalls t0=1 afterSweep=2 ResolvedAtSet=true Image=true token="blitzy-img-2"
[Q6][B Pending-vanish COUNTING] preState=Pending -> new=Normal reason="MissingSeries" NewImageCalls t0=0 afterSweep=0 ResolvedAtSet=false Image=false
[Q6][C Alerting-vanish ErrScreenshotsUnavailable] preState=Alerting -> new=Normal reason="MissingSeries" ResolvedAtSet=true Image=false
[Q6][D Alerting-vanish ErrNoDashboard] preState=Alerting -> new=Normal reason="MissingSeries" ResolvedAtSet=true Image=false
[Q6][E Alerting-vanish ErrNoPanel] preState=Alerting -> new=Normal reason="MissingSeries" ResolvedAtSet=true Image=false
[Q6][F Alerting-vanish UNEXPECTED-error] preState=Alerting -> new=Normal reason="MissingSeries" NewImageCalls t0=1 afterSweep=2 ResolvedAtSet=true Image=false
[Q6][G natural Alerting->Normal shouldTakeImage COUNTING] new=Normal reason="" NewImageCalls t0=1 afterResolve=2 ResolvedAtSet=true Image=true token="blitzy-img-2"
--- PASS: TestBlitzyObsQ6Screenshot (0.01s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.052s
```

**Interpretation.** Seven paths, all exercised through the real `ProcessEvalResults`:
- **(A) Alerting‑vanish, counting capturer** → guard `oldState == Alerting` passes; `NewImage` calls go `1 → 2` (a **new** capture at the sweep, `Δ=1`), the resulting image token is `blitzy-img-2`, `ResolvedAtSet=true`, `Image=true`.
- **(B) Pending‑vanish, counting capturer** → guard fails (`oldState=Pending`); `NewImage` calls stay `0 → 0`, `ResolvedAtSet=false`, `Image=false`.
- **(C) Alerting‑vanish, `ErrScreenshotsUnavailable`** → guard passes so `ResolvedAt` is set, but `takeImage` swallows the error to `nil` → `Image=false`.
- **(D) Alerting‑vanish, `ErrNoDashboard`** → same swallow → `ResolvedAtSet=true`, `Image=false`.
- **(E) Alerting‑vanish, `ErrNoPanel`** → same swallow → `ResolvedAtSet=true`, `Image=false`.
- **(F) Alerting‑vanish, unexpected error (`"boom-unexpected"`)** → `takeImage` returns `(nil, err)`; the sweep swallows it (non‑fatal). **[OBSERVED]:** `NewImage` was invoked (`1 → 2`), yet `Image=false` while `ResolvedAtSet=true` and the transition still completes. **[INFERRED]:** on the `err != nil` branch the code also calls `logger.Warn("Failed to take an image", "dashboard", …, "panel", …, "error", err)` (`manager.go:608-611`); this warning is **not captured at runtime** because the manager is constructed with a Nop logger (`logtest.Fake.FromContext` → `log.NewNopLogger()`), so the log emission itself is code‑derived, not observed. What *is* observed is that the error does **not** abort the resolution.
- **(G) Natural resolution `Alerting→Normal`** (present, recovered) → `shouldTakeImage(...)=true` (because `resolved`); `reason=""` (**not** `MissingSeries`), `NewImage` `1 → 2`, `Image=true` (token `blitzy-img-2`), `ResolvedAtSet=true`.

So stale resolution and natural resolution converge on the **same** `takeImage`, but the stale path substitutes the simpler `oldState == Alerting` guard for `shouldTakeImage`; only firing series produce a resolved image, and screenshot‑layer errors are swallowed without blocking resolution. **[OBSERVED]**

**Downstream delivery of the captured image.** The image token produced here (`blitzy-img-2`) is exactly the value that reaches the notifier: `StateToPostableAlert` copies `alertState.Image.Token` into the `__alertImageToken__` annotation (`state/compat.go:51-53`) of the resolved `PostableAlert`. That mapping is exercised directly in the **Q4 "Sender/compat mapping" sub‑block**, where a stale‑resolved `Alerting` series yields `annotation[__alertImageToken__]="blitzy-img-2"` — confirming the screenshot captured on the stale path is delivered downstream by token, identically to a natural resolution. **[OBSERVED]** (cross‑referenced to Q4 mapping evidence)

**Which rule does `takeImage` pass to the screenshot service? (command).** `takeImage` calls `st.images.NewImage(ctx, alertRule)` (`state.go:589-601`) — the screenshot service receives the **rule** so it can locate the dashboard/panel. The counting/token capturers above prove *how many* images are taken but discard the rule argument; this recorder capturer instead **captures the `*models.AlertRule`** handed to `NewImage` on both the natural and the stale path and inspects its identity.

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyFixImageRuleArgument$' -v -count=1
```

```
=== RUN   TestBlitzyFixImageRuleArgument
[Q6-imgarg] entering-Alerting image calls=2
[Q6-imgarg] NATURAL resolution (A) NewImage rule: uid=blitzy-rule-uid dashboard=dash-blitzy-uid panel=42 pointer==rule:true
[Q6-imgarg] STALE resolution   (B) NewImage rule: uid=blitzy-rule-uid dashboard=dash-blitzy-uid panel=42 pointer==rule:true
--- PASS: TestBlitzyFixImageRuleArgument (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.043s
```

**Interpretation.** On **both** resolution paths — the **natural** resolution of series A (`shouldTakeImage`) and the **stale** resolution of the vanished series B (`oldState == Alerting` guard) — `NewImage` receives the **same rule instance**: `uid=blitzy-rule-uid`, `dashboard=dash-blitzy-uid`, `panel=42`, and `pointer==rule:true` (the captured pointer is identical to the rule pointer the test passed into `ProcessEvalResults`, obtained via `alertRule.GetDashboardUID()`/`GetPanelID()` — the same accessors `manager.go:609-610` uses when logging). So the stale path does **not** substitute a stripped‑down or `nil` rule; the screenshot service is invoked with the *real* alert rule identically to a natural resolution — which is exactly why both paths can produce an image bearing the rule's dashboard/panel and the token that flows to `__alertImageToken__`. This observation was byte‑identical across two runs (see the Determinism section's QA‑fix stability note). **[OBSERVED]**

---

## Q7 — Pending period (`for`) on the way out

**Question.** If a rule has a pending period (`for`) configured, do vanishing series honor that waiting time on the way out, or skip straight to Resolved?

**Answer.** They **skip straight** to `Normal`/`MissingSeries`. The stale path assigns `s.State = eval.Normal` **directly**, never running `resultAlerting` (the function that implements the `for`/pending transition logic). A series still `Pending` (its `for` never elapsed) when it vanishes is swept to `Normal` with **no** `ResolvedAt`, **no** image, and **nothing sent** — it does **not** wait out the pending period on the way out. **[OBSERVED]** (evidence below).

**Mechanism.**
- The stale sweep sets `s.State = eval.Normal` and `s.StateReason = ngModels.StateReasonMissingSeries` directly (`manager.go:597-600`), with no call to `resultAlerting`. **[INFERRED]** (source).
- `resultAlerting` (`pkg/services/ngalert/state/state.go:316`) is the bypassed pending logic: a `Pending` state (`case eval.Pending`, `state.go:328`) advances to `Alerting` only if `result.EvaluatedAt.Sub(state.StartsAt) >= rule.For`; otherwise the default branch calls `SetPending` (`state.go:356`). The stale path never enters this switch. **[INFERRED]** (source).
- Because `oldState != eval.Alerting`, the `manager.go:604` guard is false → no `ResolvedAt`, no image; and `NeedsSending` returns `false` for a `Normal` state with `ResolvedAt == nil` (`state.go:513-515`) → nothing sent. **[INFERRED]** (source; observed below).

**Observed evidence — command:**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyObsQ7PendingBypass$' -v -count=1
```

```
=== RUN   TestBlitzyObsQ7PendingBypass
[Q7] t0 (rule For=5m):  CacheID=40ffcae87610efd1 State=Pending Reason="" StartsAt=00:00:00 ResolvedAt=nil LastSentAt=nil EndsAt=00:04:00 Image=nil
[Q7] t0+2*interval (elapsed=2m < For=5m); A vanished. transitions=1 dispatched=0
    [Q7] prev=Pending -> new=Normal reason="MissingSeries" resolvedSet=false image=false (skipped Pending/for wait)
--- PASS: TestBlitzyObsQ7PendingBypass (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.041s
```

**Interpretation.** With a `for = 5m` rule (`interval = 60s`), series A is `Pending` at t0 (`ResolvedAt=nil`, `LastSentAt=nil`, `Image=nil` — a pending state is not sent and takes no image). When it vanishes after only `2*interval = 2m` (well under the 5‑minute `for`), the stale sweep sets `State = Normal`/`MissingSeries` **directly**: `resolvedSet=false`, `image=false`, and `dispatched=0`. The `for` period is **not** honored on the way out. **[OBSERVED]**

**Old‑state = Normal on vanish (M7 nuance) — command:**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyObsQ7OldNormalVanish$' -v -count=1
```

```
=== RUN   TestBlitzyObsQ7OldNormalVanish
[Q7-oldNormal][never-fired] prev=Normal -> new=Normal reason="MissingSeries" resolvedSet=false image=false
[Q7-oldNormal][prev-resolved] prev=Normal -> new=Normal reason="MissingSeries" resolvedSet=true resolvedAt=00:01:00 (retained-from-natural=true) image=true NewImageCalls beforeSweep=2 afterSweep=2
--- PASS: TestBlitzyObsQ7OldNormalVanish (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.043s
```

**Interpretation.** Two sub‑cases show that a series whose `oldState` is `Normal` (not `Alerting`) when it vanishes is handled by the *retain‑but‑don't‑create* rule:
- **Never‑fired `Normal`** → the sweep sets `MissingSeries` but there was no `ResolvedAt` to begin with, so `resolvedSet=false`, `image=false`.
- **Previously naturally‑resolved `Normal`** (it had fired, then recovered at `00:01:00` with an image) → on vanishing, the reason becomes `MissingSeries` but the pre‑existing `ResolvedAt` is **RETAINED** (`resolvedAt=00:01:00`, `retained-from-natural=true`) and the image is retained; the `NewImage` invocation count does **not** increase (`beforeSweep=2 == afterSweep=2`) — the sweep does **not** create a new image for a non‑`Alerting` series, and does **not** clear the old fields. This corrects the naive claim that a vanish always produces (or always suppresses) a resolution image: for `oldState == Normal`, the sweep neither creates new resolution artifacts nor erases existing ones. **[OBSERVED]**

**Post‑`Alerting` vanish — the `for` is honored on the way *in*, never on the way *out* (command).** The Pending‑vanish above shows a series that vanished *before* its `for` elapsed. This complementary run shows the other half of the cross‑product: a `for = 5m` series that **does** wait out the pending period on the way in (reaching `Alerting` at exactly `t0+300s`), then vanishes *after* firing — confirming that once `Alerting`, a vanish is an ordinary `Alerting`‑stale resolution.

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyFixPostAlertingForVanish$' -v -count=1
```

```
=== RUN   TestBlitzyFixPostAlertingForVanish
[Q7-for] t0+  0s elapsed= 0.0m state=Pending reason=""
[Q7-for] t0+ 60s elapsed= 1.0m state=Pending reason=""
[Q7-for] t0+120s elapsed= 2.0m state=Pending reason=""
[Q7-for] t0+180s elapsed= 3.0m state=Pending reason=""
[Q7-for] t0+240s elapsed= 4.0m state=Pending reason=""
[Q7-for] t0+300s elapsed= 5.0m state=Alerting reason=""
[Q7-for] reached Alerting at t0+300s (== For=5m)
[Q7-for] VANISH @ t0+420s: prev=Alerting->new=Normal reason="MissingSeries" resolved=true sent=true imgCount 1->2 cachePresent=false
--- PASS: TestBlitzyFixPostAlertingForVanish (0.01s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.049s
```

**Interpretation.** On the way **in**, the `for = 5m` pending period *is* honored: the series stays `Pending` from `t0+0s` through `t0+240s` (`elapsed = 4.0m < 5m`) and only advances to `Alerting` at `t0+300s` (`elapsed == 5.0m`), exactly the `resultAlerting` transition rule (`state.go:316`). On the way **out**, when the now‑`Alerting` series vanishes at `t0+420s`, the stale sweep takes the ordinary `Alerting`‑stale path: `prev=Alerting → Normal`, `reason=MissingSeries`, a **new** `ResolvedAt` is set (`resolved=true`), an image is captured (`imgCount 1→2`), the transition is send‑eligible (`sent=true`), and the entry is evicted (`cachePresent=false`). So the `for` gate governs *entry* into `Alerting`; the stale sweep never re‑runs that gate on exit — a vanished series (whether it was `Pending` or `Alerting`) skips straight out, and only its *previous* state decides whether a resolution is sent. **[OBSERVED]**

---

## Q8 — Reappearance identity

**Question.** When a series vanishes and later reappears with identical labels, is it recognized as the same entity or treated as a brand‑new alert instance?

**Answer.** Both, in different senses. Its **identity key** (`CacheID`) is a deterministic fingerprint of the label set, so an identical‑label reappearance computes the **same `CacheID`**. But because the stale sweep **evicted** the prior entry, no prior `State` survives — the reappearance is instantiated **fresh** by `cache.create`, with `StartsAt`, `LastSentAt`, and `ResolvedAt` reset and `StateReason` cleared. So it is the **same identity key** carrying a **brand‑new instance state**. **[OBSERVED]** (evidence below).

**Mechanism.**
- `CacheID` is the label fingerprint: `cacheID := lbs.Fingerprint()` (`pkg/services/ngalert/state/cache.go:149`), where `lbs` is built by `expandAnnotationsAndLabels` (`cache.go:74`) as the merge of extra labels + expanded rule labels + result labels. Identical labels ⇒ identical fingerprint. **[INFERRED]** (source; identity observed below).
- On reappearance, `cache.create` (`cache.go:146`) builds a new `State` with `State = eval.Normal`, `StateReason: ""`, `StartsAt: result.EvaluatedAt`, `EndsAt: result.EvaluatedAt`, `ResolvedAt: nil`, `LastSentAt: nil` (`cache.go:156-168`). **[INFERRED]** (source; reset fields observed below).
- **Persistence (M8).** The persisted predecessor is **deleted at stale detection** — the persister's `Sync` calls `deleteAlertStates` for the stale transitions (`persister_sync.go:51-68`, `DeleteAlertInstances` at `:68`) — and the stale transition itself is **not re‑saved** (skip‑save at `persister_sync.go:82-84`). Therefore **no persisted predecessor remains** when identical labels reappear; the in‑memory eviction happens via `cache.deleteRuleStates` (`cache.go:255`). (The predecessor *was* persisted while firing at `persister_sync.go:110`; it is the *stale* row that is removed and not rewritten — not "never persisted".) **[OBSERVED]** (persistence deltas in Q1's persistence run; identity below).

**Observed evidence — command:**

```bash
go test ./pkg/services/ngalert/state/ -run '^TestBlitzyObsQ8Reappearance$' -v -count=1
```

```
=== RUN   TestBlitzyObsQ8Reappearance
[Q8] t0 original instance:   CacheID=40ffcae87610efd1 State=Alerting Reason="" StartsAt=00:00:00 ResolvedAt=nil LastSentAt=00:00:00 EndsAt=00:04:00 Image=SET
[Q8] after vanish 2*interval: cacheCount=0 (evicted, not persisted)
[Q8] reappeared instance:   CacheID=40ffcae87610efd1 State=Alerting Reason="" StartsAt=00:05:00 ResolvedAt=nil LastSentAt=00:05:00 EndsAt=00:09:00 Image=SET
[Q8] CacheID identical to original? true (orig=40ffcae87610efd1 reappeared=40ffcae87610efd1)
[Q8] StartsAt reset to reappearance time? origStarts=00:00:00 newStarts=00:05:00 differ=true
--- PASS: TestBlitzyObsQ8Reappearance (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.042s
```

**Interpretation.** The original instance fires `Alerting` at `t0` (`CacheID=40ffcae87610efd1`, `StartsAt=00:00:00`, `LastSentAt=00:00:00`, `EndsAt=00:04:00`). After vanishing for `2*interval`, the cache is empty (`cacheCount=0`, evicted). When an identical‑label series reappears at `t=5m`, it gets the **same** `CacheID` (`40ffcae87610efd1`) but a **fresh** state: `StartsAt` reset from `00:00:00` to `00:05:00` (`differ=true`), `LastSentAt=00:05:00`, `ResolvedAt=nil`, `Reason=""`. Same identity key, brand‑new instance state. **[OBSERVED]**

---

## Version Caveat — `MissingSeriesEvalsToResolve` is out-of-version at 4550cfb5

**The staleness threshold is hard‑coded at `2 * IntervalSeconds` at this commit.** The later, configurable option `MissingSeriesEvalsToResolve` (introduced by Grafana **PR #101184**) is **absent** here. A **pinned** grep at the exact baseline commit confirms it (`/tmp/evidence/outputs/version_caveat_grep.txt`):

```
=== m17: pinned git grep for MissingSeriesEvalsToResolve at baseline commit ===
$ git grep -n MissingSeriesEvalsToResolve 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff -- "*.go"
exit=1 (nonzero = no matches)
match count: 0
(no output above this line = zero matches at the pinned commit)
```

**[OBSERVED]** — `git grep -n MissingSeriesEvalsToResolve 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff -- '*.go'` exits non‑zero with **0 matches** (the grep is pinned to the commit tree, so it is unaffected by this document containing the string). Therefore the number of intervals before staleness is the literal `2 *` in `stateIsStale` (`manager.go:627`), not a setting.

**Accuracy correction (code‑anchor location).** The constant `StateReasonMissingSeries = "MissingSeries"` is defined in **`pkg/services/ngalert/models/alert_rule.go:160`**, and its runtime *assignment* happens in `deleteStaleStatesFromCache` at `manager.go:600`. A grep of `pkg/services/ngalert/models/instance.go` returns **no match** — any reference placing it in `models/instance.go` is incorrect. **[INFERRED]** (source lines).

**Official documentation & PR history (corroboration; version/date‑scoped).** The following are Grafana's *current* published docs and the relevant PRs. The current docs describe the **configurable** form (`MissingSeriesEvalsToResolve`, default **2**) — a **superset** of the behavior at this pinned commit. Where they differ, the **pinned source and the runtime evidence above take precedence** for describing `4550cfb5`; the docs are cited for the *shape* of the behavior (which matches at the default value of 2):
- Stale alert instances (describes stale detection over consecutive evaluation intervals, resolve‑then‑evict, resolved notification only if previously firing; current docs, configurable form): <https://grafana.com/docs/grafana/latest/alerting/fundamentals/alert-rule-evaluation/stale-alert-instances/>
- Handling missing data (the `MissingSeries` reason; distinct from *No Data*): <https://grafana.com/docs/grafana/latest/alerting/guides/missing-data/>
- No Data and Error states (stale ≠ *No Data*): <https://grafana.com/docs/grafana/latest/alerting/fundamentals/alert-rule-evaluation/nodata-and-error-states/>
- **PR #49352** — "Alerting: Resolve stale state" (the origin mechanism this code implements — resolving stale `Alerting` series with `MissingSeries` instead of silently forgetting them; origin issue #49095): <https://github.com/grafana/grafana/pull/49352>
- **PR #101184** — "Alerting: Add `MissingSeriesEvalsToResolve` option" (**post‑`4550cfb5`**; makes the interval count configurable; its default of 2 matches the previously hard‑coded behavior — hence out‑of‑version here): <https://github.com/grafana/grafana/pull/101184>
- **PR #54793** — sending resolved notifications (incl. screenshot) for resolved alerts, supporting Q4/Q6: <https://github.com/grafana/grafana/pull/54793>

**[DOC‑CORROBORATED]** — these sources are consistent with the observed code; they are documentation/PR references, not runtime observations of this build. The newer configurable form is mentioned **only** as out‑of‑version documentation and must not be presented as live behavior at `4550cfb5`.

---

## Dependency Note — `prometheus/alertmanager` (required vs. effective)

The resolved‑alert dispatch path (Q4/Q5) uses `PostableAlert` types from `github.com/prometheus/alertmanager`. Two facts must be stated together (`/tmp/evidence/outputs/alertmanager_dep.txt`):

```
=== m18: alertmanager dependency (required vs effective replacement) ===
$ grep -n "prometheus/alertmanager" go.mod
140:	github.com/prometheus/alertmanager v0.27.0 // @grafana/alerting-backend
532:replace github.com/prometheus/alertmanager => github.com/grafana/prometheus-alertmanager v0.25.1-0.20240930132144-b5e64e81e8d3
$ grep -n "prometheus/alertmanager" go.work
29:replace github.com/prometheus/alertmanager => github.com/grafana/prometheus-alertmanager v0.25.1-0.20240930132144-b5e64e81e8d3
$ go list -m github.com/prometheus/alertmanager
github.com/prometheus/alertmanager v0.27.0 => github.com/grafana/prometheus-alertmanager v0.25.1-0.20240930132144-b5e64e81e8d3
```

- The module **requires** `github.com/prometheus/alertmanager v0.27.0` (`go.mod:140`). **[OBSERVED]**
- That import is **replaced** by the Grafana fork `github.com/grafana/prometheus-alertmanager v0.25.1-0.20240930132144-b5e64e81e8d3` (`go.mod:532` and `go.work:29`), so the **effective** package built and run is the fork — confirmed by `go list -m` (`v0.27.0 => github.com/grafana/prometheus-alertmanager v0.25.1-0.20240930132144-b5e64e81e8d3`). **[OBSERVED]**

---

## Determinism & Stability of Evidence

- **Every timing/magnitude observation was run at least twice** with `-count=1`. run #1 and run #2 were captured to `/tmp/evidence/outputs/obs_*_run1.txt` and `obs_*_run2.txt` and diffed; the evidence lines were **byte‑identical** across runs for all 13 observations. The only line that varies is the trailing `ok ... <wall-clock>s` timing line (and the per‑test `(0.0Xs)` elapsed marker) emitted by `go test`, which carries no evidence value. The stability summary (`/tmp/evidence/outputs/stability_all.txt`):

```
STABLE   TestBlitzyObsQ3StaleBoundaryHelper (run1==run2 byte-for-byte modulo timing)
STABLE   TestBlitzyObsQ5NeedsSendingPredicate (run1==run2 byte-for-byte modulo timing)
STABLE   TestBlitzyObsQ3StaleBoundaryCanonical (run1==run2 byte-for-byte modulo timing)
STABLE   TestBlitzyObsQ1PartialDisappearance (run1==run2 byte-for-byte modulo timing)
STABLE   TestBlitzyObsQ1SendFiltering (run1==run2 byte-for-byte modulo timing)
STABLE   TestBlitzyObsQ2StoppedVsSlow (run1==run2 byte-for-byte modulo timing)
STABLE   TestBlitzyObsQ6Screenshot (run1==run2 byte-for-byte modulo timing)
STABLE   TestBlitzyObsQ7PendingBypass (run1==run2 byte-for-byte modulo timing)
STABLE   TestBlitzyObsQ7OldNormalVanish (run1==run2 byte-for-byte modulo timing)
STABLE   TestBlitzyObsQ8Reappearance (run1==run2 byte-for-byte modulo timing)
STABLE   TestBlitzyObsQ1Q8Persistence (run1==run2 byte-for-byte modulo timing)
STABLE   TestBlitzyObsQ4Q5SendLifecycle (run1==run2 byte-for-byte modulo timing)
STABLE   TestBlitzyObsQ5CadenceQualification (run1==run2 byte-for-byte modulo timing)

SUMMARY: stable=13 unstable=0 (of 13)
```

**[OBSERVED]** — 13/13 stable.

- **QA‑fix transient tests — also two‑run byte‑stable.** The additional QA‑fix transient tests (`TestBlitzyFixCohesiveLifecycleE2E`, `TestBlitzyFixQ1DisappearedFields`, `TestBlitzyFixSenderMapping`, `TestBlitzyFixConcreteDBReadback`, `TestBlitzyFixPostAlertingForVanish`, `TestBlitzyFixOldNormalStaleSend`, `TestBlitzyFixImageRuleArgument`, and the nanosecond triads `TestBlitzyFixStaleNanoCanonical`/`TestBlitzyFixStaleNanoTriad`/`TestBlitzyFixResendNanoTriad`/`TestBlitzyFixRetentionNanoTriad`) were each run at least twice with `-count=1` and re‑verified with `-count=2`; every evidence line was **byte‑identical** across runs. The **only** non‑deterministic line anywhere is the single `util.go:158` harness line in `TestBlitzyFixConcreteDBReadback`, which carries a randomly generated rule UID (disclosed inline where that block is embedded); its two `[Q1Q8-db]` observation lines (`rows=1` → `rows=0`) are stable. **[OBSERVED]**
- **Deterministic `CacheID`.** To make the fingerprint reproducible, the temporary tests pinned **empty rule labels** (`gen.WithLabels(data.Labels{})`) and **fixed result labels** (`{"series":"A"}`, `{"series":"B"}`, `{"series":"C"}`). `CacheID = lbs.Fingerprint()` (`cache.go:149`), where `lbs` is the merge of extra + expanded rule + result labels (`expandAnnotationsAndLabels`, `cache.go:74`), so with those pins the fingerprint depends only on the fixed result labels. Observed values were stable: `A=40ffcae87610efd1`, `B=40ffc9e87610ed84`, `C=40ffc8e87610eb37`. **[OBSERVED]**
- **Mock clock.** `github.com/benbjohnson/clock` v1.3.5 (`clock.NewMock()`, starting at `time.Unix(0,0)` → `00:00:00` UTC) crossed the `2*interval`, `30s`, and `15m` boundaries with **no real waiting**, which is what makes the 15‑minute retention window observable in a millisecond‑scale unit test. **[OBSERVED]**
- **Cleanup.** All temporary `*_test.go` observation files were **deleted** after capture; `git status --porcelain` reports only this document (`/tmp/evidence/outputs/cleanup_git_status.txt`):

```
=== git status --porcelain (after deleting transient tests) ===
(end porcelain)
--- verify no zz_blitzy files remain anywhere in repo ---
(end find)
```

**[OBSERVED]** — the porcelain status is empty and no `zz_blitzy_obs*` file remains anywhere under `pkg/` (this document is committed separately; the source tree is otherwise unchanged).

---

## Final Coverage-Pass Checklist

Every question is answered **by name** with observed evidence and exact `file:line` anchors:

- [x] **Cohesive lifecycle (single trace)** — one `Manager`/one clock/one `ProcessEvalResults` sequence carries the same series coherently through firing → slow/return → exact stale boundary → stale sweep (image + `DeleteAlertInstances` + eviction + dispatch) → natural retention equality/+1ns → identical‑label reappearance (`TestBlitzyFixCohesiveLifecycleE2E`); event‑to‑source mapping table provided; two‑run byte‑stable.
- [x] **Q1** — present vs. absent series: `setNextStateForRule` (`manager.go:326`) updates present; `deleteStaleStatesFromCache` (`manager.go:328`) sweeps absent; **all merged** into `allChanges` (`manager.go:334`), then **only `NeedsSending`‑eligible dispatched** (`manager.go:359-363`); vanished formerly‑`Alerting` → `Normal`/`MissingSeries` + `ResolvedAt`; a surviving `Alerting` series is cadence‑gated (send‑filtering run: merged=2, dispatched=1). **Full disappeared‑series field trace** (`TestBlitzyFixQ1DisappearedFields`) records `StartsAt`/`ResolvedAt`/`LastSentAt`/`LastEvaluationTime`/`EndsAt`/`IsStale`/cache‑presence/image/dispatched for B and C before & after. Real‑persister run records the stale‑key store delete + survivor store save; **concrete sqlite row‑delete** additionally confirmed in Q1/Q8 persistence (`TestBlitzyFixConcreteDBReadback`).
- [x] **Q2** — no per‑series liveness probe; distinction is purely time‑based via `stateIsStale` (`manager.go:627`); slow (1 interval) survives, stopped (≥2 intervals) is swept.
- [x] **Q3** — formula `evaluatedAt >= lastEval + 2*interval` (`stateIsStale`, `manager.go:627`), equality‑inclusive; boundary confirmed **canonically through `ProcessEvalResults`** (119s survives, 120s swept), corroborated by a non‑canonical helper; **nanosecond triad** pins the edge to `2·interval − 1ns → false / = 2·interval → true / +1ns → true` both canonically (`TestBlitzyFixStaleNanoCanonical`) and at the predicate (`TestBlitzyFixStaleNanoTriad`); hard‑coded `2×`.
- [x] **Q4** — `ResolvedRetention` default `15m` (`conf/defaults.ini:1365` → `setting_unified_alerting.go:465` → `ngalert.go:415`); natural‑resolution re‑sends stop when `LastEvaluationTime − ResolvedAt > 15m` (`state.go:513-515`), observed stop at `t=16.0m`; stale‑resolved sent once then evicted (Part 2).
- [x] **Q5** — `ResendDelay` (30s `var`, `manager.go:23-25`; TODO at `:98`) × `ResolvedRetention` (15m) × `LastSentAt` interplay via `NeedsSending` (`state.go:500-519`, cadence at `:519`) + `updateLastSentAt` (`manager.go:359-363`); **manager‑observed `cachedLastSentAt`** advances then freezes; **31 sends = 1 immediate + 30 re‑sends**; cadence is a minimum spacing (20s‑interval run sends at 20/60/100/140s); **nanosecond triads** pin the two opposite‑equality gates — resend floor **inclusive** at `30s` (`TestBlitzyFixResendNanoTriad`, `state.go:519`) and retention ceiling **exclusive** at `15m` (strict `>`; `TestBlitzyFixRetentionNanoTriad`, `state.go:513-515`); a **previously‑resolved `Normal` that goes stale emits one final gated send** then is evicted (`TestBlitzyFixOldNormalStaleSend`, predicate `0/1/0`).
- [x] **Q6** — same `takeImage` (`state.go:589`), different guards: `shouldTakeImage` (`manager.go:513`) vs `oldState == eval.Alerting` (`manager.go:604`); counting/token capturer proves invocation deltas; Pending‑vanish → no new image/`ResolvedAt`; `ErrScreenshotsUnavailable`/`ErrNoDashboard`/`ErrNoPanel` swallowed to `nil,nil`; unexpected error swallowed (image `nil`, `ResolvedAt` set, resolution still occurs — **observed**; accompanying `Warn` at `manager.go:608-611` is **inferred**, Nop logger); natural resolution takes image via `shouldTakeImage`; **NewImage receives the real rule** (UID/dashboard/panel, same pointer for natural & stale — `TestBlitzyFixImageRuleArgument`).
- [x] **Q7** — stale path sets `State = eval.Normal` directly (`manager.go:597-600`), bypassing `resultAlerting`/`for` (`state.go:316`, Pending case `:328`, `for` transition `:330`, `SetPending` `:356`); a `Pending` vanish skips the wait (no `ResolvedAt`/image, dispatched=0); an old‑`Normal` vanish **retains** a prior natural `ResolvedAt`/image and takes **no** new image; a **post‑`Alerting` vanish** (`for = 5m` honored on the way in — `Pending` through `t0+240s`, `Alerting` at `t0+300s`) then takes the ordinary `Alerting`‑stale path on the way out (`TestBlitzyFixPostAlertingForVanish`: new `ResolvedAt`, image `1→2`, `sent=true`, evicted) — the `for` gate governs *entry*, never *exit*.
- [x] **Q8** — deterministic `CacheID` fingerprint (`cache.go:149`, labels via `expandAnnotationsAndLabels` `cache.go:74`); evicted (`cache.go:255`), predecessor **deleted at stale detection** (`persister_sync.go:51-68`) and stale transition **not re‑saved** (`persister_sync.go:82-84`); re‑created fresh by `cache.create` (`cache.go:146-168`) with `StartsAt`/`ResolvedAt`/`LastSentAt` reset and `StateReason=""`.
- [x] **Named edge/error paths exercised:** Pending‑only vanish (Q7, Q6‑B); post‑`Alerting` vanish after `for` elapsed (Q7, `TestBlitzyFixPostAlertingForVanish`); slow series within 2 intervals not stale (Q2); three swallowed screenshot errors + one unexpected error (Q6 C/D/E/F); old‑`Normal` retain vs no‑new (Q7 old‑Normal); **three‑way stale sweep split** — (a) `Alerting` → new `ResolvedAt`+image+send, (b) `Pending`/never‑resolved‑`Normal` → nothing sent, (c) previously‑resolved‑`Normal` → one final gated send then evicted (Overview diagram; `TestBlitzyFixOldNormalStaleSend`); stale‑resolved sent once then evicted vs. natural resolution re‑sent until retention (Q4 Part 1 vs Part 2); merged‑then‑filtered dispatch (Q1 send‑filtering).
- [x] **Boundary constants** tabulated (`2*interval`, `30s` `var`, `15m`); **build/run commands** stated; **`GOWORK=off` failure**, **two‑run byte‑stability**, and **cleanup proof** captured; **version caveat** (pinned grep, `MissingSeriesEvalsToResolve` absent, PR #101184 out‑of‑version) and **dependency note** (`alertmanager v0.27.0` ⇒ Grafana fork) included; official docs/PRs cited and version‑scoped.

---

## Appendix — Transient Observation Script Sources (removed after use)

> These Go test files were created under `pkg/services/ngalert/state/`, executed to produce the evidence above, copied to `/tmp/evidence/scripts/` (and `/tmp/blitzy_fix_outputs/` for the QA‑fix set), and then **DELETED** from the repository. They are **not** part of the repository — reproduced here verbatim (byte‑identical to the archived copies) so a reader can re‑create, re‑run, and then delete them (`git status --porcelain` must stay empty apart from this document). All lifecycle tests drive the real entry point `Manager.ProcessEvalResults`; only the image service, instance store, historian, and clock are fakes. Every test carries explicit `require`/`assert` checks.
>
> They come in **two independently‑authored pairs** — the original observation pair (`zz_blitzy_obs_internal_test.go` + `zz_blitzy_obs_lifecycle_test.go`) and the QA‑fix pair (`zz_blitzy_fix_internal_test.go` + `zz_blitzy_fix_test.go`) — each pair a `package state` (internal) file plus a `package state_test` (external) file. **Re‑create and run the two pairs as separate sessions** (delete one pair before creating the other): the two external files intentionally reuse the same helper names (`hhmmss`/`hhmmssP`), so placing all four in the package simultaneously produces a `redeclared in this block` compile error. Each pair compiles and passes on its own (verified: all 13 `TestBlitzyObs*` and all 11 `TestBlitzyFix*` produce the exact outputs embedded above).

### `pkg/services/ngalert/state/zz_blitzy_obs_internal_test.go` (package `state`, internal — transient/removed)

```go
// TRANSIENT OBSERVATION SCRIPT — created, run, then DELETED. Never committed.
// package state (internal): can call unexported stateIsStale and (via *State) NeedsSending.
package state

import (
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana/pkg/services/ngalert/eval"
	"github.com/grafana/grafana/pkg/util"
)

// Q3 (HELPER, non-canonical) — Staleness threshold and formula.
// Exercises the unexported stateIsStale directly. This is the HELPER-level view; the CANONICAL
// confirmation through Manager.ProcessEvalResults is TestBlitzyObsQ3StaleBoundaryCanonical.
func TestBlitzyObsQ3StaleBoundaryHelper(t *testing.T) {
	var interval int64 = 60
	lastEval, _ := time.Parse(time.RFC3339, "2024-01-01T00:00:00Z")
	fmt.Printf("[Q3-helper] stateIsStale formula: !lastEval.Add(2*interval).After(evaluatedAt); interval=%ds lastEval=%s\n",
		interval, lastEval.Format(time.RFC3339))
	cases := []struct {
		off  int64
		want bool
	}{
		{0, false}, {60, false}, {119, false},
		{120, true}, {121, true}, {180, true},
	}
	for _, c := range cases {
		evalAt := lastEval.Add(time.Duration(c.off) * time.Second)
		got := stateIsStale(evalAt, lastEval, interval)
		fmt.Printf("[Q3-helper] evaluatedAt = lastEval + %3ds (=%.2f intervals) -> stateIsStale = %v\n",
			c.off, float64(c.off)/float64(interval), got)
		require.Equalf(t, c.want, got, "offset %ds: stateIsStale mismatch", c.off)
	}
	// Boundary assertions: strictly < 2*interval is NOT stale; >= 2*interval IS stale (equality-inclusive).
	require.False(t, stateIsStale(lastEval.Add(119*time.Second), lastEval, interval), "119s (<2*interval) must be NOT stale")
	require.True(t, stateIsStale(lastEval.Add(120*time.Second), lastEval, interval), "120s (==2*interval) must be stale (equality-inclusive)")
}

// Q5 (predicate-level) — Interplay of ResendDelay (30s), ResolvedRetention (15m), and LastSentAt.
// Drives the unexported (*State).NeedsSending and bumps LastSentAt exactly as Manager.updateLastSentAt
// does (manager.go:359-368). NOTE: this is the PREDICATE-level view; the CANONICAL manager-observed
// LastSentAt (read back from the cache after ProcessEvalResults) is TestBlitzyObsQ4Q5SendLifecycle.
func TestBlitzyObsQ5NeedsSendingPredicate(t *testing.T) {
	resendDelay := 30 * time.Second
	resolvedRetention := 15 * time.Minute
	base, _ := time.Parse(time.RFC3339, "2024-01-01T00:00:00Z")
	st := &State{
		State:      eval.Normal,
		ResolvedAt: util.Pointer(base),
		LastSentAt: nil,
	}
	fmt.Printf("[Q5-pred] ResendDelay=%s ResolvedRetention=%s (State=Normal, resolved at t=0)\n",
		resendDelay, resolvedRetention)
	sends := 0
	firstStopMin := -1.0
	for i := 0; i <= 33; i++ {
		now := base.Add(time.Duration(i) * 30 * time.Second)
		st.LastEvaluationTime = now
		pre := "nil"
		if st.LastSentAt != nil {
			pre = st.LastSentAt.Sub(base).String()
		}
		need := st.NeedsSending(resendDelay, resolvedRetention)
		sinceResolved := now.Sub(*st.ResolvedAt)
		tag := "-"
		if need {
			// Exactly what Manager.updateLastSentAt does (manager.go:359-368).
			st.LastSentAt = util.Pointer(now)
			sends++
			tag = "SEND -> LastSentAt updated"
		} else if firstStopMin < 0 {
			firstStopMin = now.Sub(base).Minutes()
		}
		fmt.Printf("[Q5-pred] t=%5.1fm sinceResolved=%5.2fm LastSentAt(pre)=%-7s NeedsSending=%-5v %s\n",
			now.Sub(base).Minutes(), sinceResolved.Minutes(), pre, need, tag)
	}
	fmt.Printf("[Q5-pred] total resolved sends across 0..16.5m = %d (1 immediate + %d re-sends); first stop at t=%.1fm\n",
		sends, sends-1, firstStopMin)
	require.Equal(t, 31, sends, "expected 31 resolved sends = 1 immediate (t=0) + 30 re-sends (t=0.5m..15.0m)")
	require.InDelta(t, 15.5, firstStopMin, 0.001, "sending STOPS at t=15.5m (first cycle where sinceResolved>15m, ResolvedAt=0)")
}
```

### `pkg/services/ngalert/state/zz_blitzy_obs_lifecycle_test.go` (package `state_test`, external — transient/removed)

```go
// TRANSIENT OBSERVATION SCRIPT — created, run, then DELETED. Never committed.
// package state_test (external): drives the REAL canonical entry point Manager.ProcessEvalResults.
package state_test

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/benbjohnson/clock"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana/pkg/infra/log"
	"github.com/grafana/grafana/pkg/infra/tracing"
	"github.com/grafana/grafana/pkg/services/ngalert/eval"
	"github.com/grafana/grafana/pkg/services/ngalert/metrics"
	"github.com/grafana/grafana/pkg/services/ngalert/models"
	"github.com/grafana/grafana/pkg/services/ngalert/state"
)

// ---- harness helpers (fakes only for image/store/clock; the state machine is production code) ----

func blitzyCfg(clk clock.Clock, images state.ImageCapturer, store state.InstanceStore) state.ManagerCfg {
	return state.ManagerCfg{
		Metrics:           metrics.NewNGAlert(prometheus.NewPedanticRegistry()).GetStateMetrics(),
		ExternalURL:       nil,
		InstanceStore:     store,
		Images:            images,
		Clock:             clk,
		Historian:         &state.FakeHistorian{},
		Tracer:            tracing.InitializeTracerForTest(),
		Log:               log.New("ngalert.state.manager"),
		ResolvedRetention: 15 * time.Minute,
	}
}

func blitzyManager(clk clock.Clock, images state.ImageCapturer, store state.InstanceStore) *state.Manager {
	return state.NewManager(blitzyCfg(clk, images, store), state.NewNoopPersister())
}

func blitzyRule(forDur, interval time.Duration) *models.AlertRule {
	gen := models.RuleGen
	return gen.With(gen.WithFor(forDur), gen.WithInterval(interval), gen.WithLabels(data.Labels{})).GenerateRef()
}

func blitzyResult(st eval.State, labels data.Labels, at time.Time) eval.Result {
	return eval.ResultGen(eval.WithState(st), eval.WithLabels(labels), eval.WithEvaluatedAt(at))()
}

func blitzyFind(states []*state.State, series string) *state.State {
	for _, s := range states {
		if s.Labels["series"] == series {
			return s
		}
	}
	return nil
}

func blitzyFindTransition(all state.StateTransitions, series string) *state.StateTransition {
	for i := range all {
		if all[i].Labels["series"] == series {
			return &all[i]
		}
	}
	return nil
}

func hhmmss(t time.Time) string { return t.UTC().Format("15:04:05") }
func hhmmssP(t *time.Time) string {
	if t == nil {
		return "nil"
	}
	return t.UTC().Format("15:04:05")
}

// countingImageService counts NewImage invocations and returns a UNIQUE token each time,
// so a caller can prove takeImage was actually invoked (count delta) and which capture landed
// on a state (token identity). Unlike NoopImageService (which returns a non-nil EMPTY image),
// this makes "was an image really taken?" observable.
type countingImageService struct {
	count int
}

func (c *countingImageService) NewImage(_ context.Context, _ *models.AlertRule) (*models.Image, error) {
	c.count++
	return &models.Image{Token: fmt.Sprintf("blitzy-img-%d", c.count)}, nil
}

// errImageService counts invocations and returns a configurable error, to exercise the named
// error paths of takeImage (state.go:589-600): ErrNoDashboard / ErrNoPanel / ErrScreenshotsUnavailable
// (swallowed to nil,nil) and any other/unexpected error (returned to the caller and logged).
type errImageService struct {
	count int
	err   error
}

func (e *errImageService) NewImage(_ context.Context, _ *models.AlertRule) (*models.Image, error) {
	e.count++
	return nil, e.err
}

// Q3 (CANONICAL) — cross the staleness boundary through the REAL Manager.ProcessEvalResults.
func TestBlitzyObsQ3StaleBoundaryCanonical(t *testing.T) {
	ctx := context.Background()
	la := data.Labels{"series": "A"}

	// interval=60s. Fire Alerting at t0, advance +119s (=1.98 intervals), evaluate ABSENT.
	// stateIsStale(119s, lastEval=0, 60) = false -> series SURVIVES (not stale).
	clk := clock.NewMock()
	rule := blitzyRule(0, 60*time.Second)
	st := blitzyManager(clk, &state.NoopImageService{}, &state.FakeInstanceStore{})
	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Alerting, la, clk.Now())}, nil, state.NoopSender)
	clk.Add(119 * time.Second)
	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{}, nil, state.NoopSender)
	count119 := len(st.GetStatesForRuleUID(rule.OrgID, rule.UID))
	fmt.Printf("[Q3-canonical] ProcessEvalResults +119s (=1.98 intervals) absent -> cacheCount=%d (survives, NOT stale)\n", count119)

	// Fresh manager. Fire Alerting at t0, advance +120s (==2*interval), evaluate ABSENT.
	// stateIsStale(120s, lastEval=0, 60) = true -> series SWEPT (stale).
	clk2 := clock.NewMock()
	rule2 := blitzyRule(0, 60*time.Second)
	st2 := blitzyManager(clk2, &state.NoopImageService{}, &state.FakeInstanceStore{})
	st2.ProcessEvalResults(ctx, clk2.Now(), rule2, eval.Results{blitzyResult(eval.Alerting, la, clk2.Now())}, nil, state.NoopSender)
	clk2.Add(120 * time.Second)
	st2.ProcessEvalResults(ctx, clk2.Now(), rule2, eval.Results{}, nil, state.NoopSender)
	count120 := len(st2.GetStatesForRuleUID(rule2.OrgID, rule2.UID))
	fmt.Printf("[Q3-canonical] ProcessEvalResults +120s (=2.00 intervals) absent -> cacheCount=%d (swept, stale)\n", count120)

	require.Equal(t, 1, count119, "at +119s (<2*interval) the series must NOT be stale (survives in cache)")
	require.Equal(t, 0, count120, "at +120s (==2*interval, equality-inclusive) the series must be stale (swept)")
}

// Q1 — Multi-series partial disappearance. Captures merged transitions (return value = allChanges)
// vs dispatched transitions (statesToSend passed to the send callback).
func TestBlitzyObsQ1PartialDisappearance(t *testing.T) {
	ctx := context.Background()
	clk := clock.NewMock()
	rule := blitzyRule(0, 60*time.Second)
	st := blitzyManager(clk, &state.NoopImageService{}, &state.FakeInstanceStore{})
	la, lb, lc := data.Labels{"series": "A"}, data.Labels{"series": "B"}, data.Labels{"series": "C"}
	var dispatched state.StateTransitions
	send := func(_ context.Context, ss state.StateTransitions) { dispatched = ss }

	res0 := eval.Results{
		blitzyResult(eval.Alerting, la, clk.Now()),
		blitzyResult(eval.Alerting, lb, clk.Now()),
		blitzyResult(eval.Alerting, lc, clk.Now()),
	}
	all0 := st.ProcessEvalResults(ctx, clk.Now(), rule, res0, nil, send)
	cache := st.GetStatesForRuleUID(rule.OrgID, rule.UID)
	fmt.Printf("[Q1] t0: 3 series fire Alerting; merged=%d dispatched=%d cacheCount=%d\n", len(all0), len(dispatched), len(cache))
	require.Len(t, all0, 3, "t0: 3 merged transitions")
	require.Len(t, dispatched, 3, "t0: all 3 Alerting dispatched")
	require.Len(t, cache, 3, "t0: 3 states cached")

	clk.Add(2 * time.Duration(rule.IntervalSeconds) * time.Second)
	res1 := eval.Results{blitzyResult(eval.Alerting, la, clk.Now())}
	all := st.ProcessEvalResults(ctx, clk.Now(), rule, res1, nil, send)
	fmt.Printf("[Q1] t0+2*interval: only A present. total merged transitions(allChanges)=%d dispatched=%d\n", len(all), len(dispatched))
	require.Len(t, all, 3, "merged allChanges = A(maintained) + B,C(stale-resolved)")

	sort.Slice(all, func(i, j int) bool { return all[i].Labels["series"] < all[j].Labels["series"] })
	byName := map[string]state.StateTransition{}
	for _, tr := range all {
		byName[tr.Labels["series"]] = tr
		fmt.Printf("    [Q1] series=%s CacheID=%s prev=%s -> new=%s reason=%q resolvedSet=%v\n",
			tr.Labels["series"], tr.CacheID, tr.PreviousState, tr.State.State, tr.StateReason, tr.ResolvedAt != nil)
	}
	require.Equal(t, eval.Alerting, byName["A"].State.State, "A stays Alerting")
	require.Equal(t, "", byName["A"].StateReason, "A no reason")
	require.Nil(t, byName["A"].ResolvedAt, "A not resolved")
	for _, s := range []string{"B", "C"} {
		require.Equal(t, eval.Normal, byName[s].State.State, s+" swept to Normal")
		require.Equal(t, models.StateReasonMissingSeries, byName[s].StateReason, s+" reason MissingSeries")
		require.NotNil(t, byName[s].ResolvedAt, s+" ResolvedAt set")
	}

	fmt.Printf("[Q1] cache contents after sweep (present series only):\n")
	cache = st.GetStatesForRuleUID(rule.OrgID, rule.UID)
	sort.Slice(cache, func(i, j int) bool { return cache[i].Labels["series"] < cache[j].Labels["series"] })
	require.Len(t, cache, 1, "only A remains cached")
	require.Equal(t, "A", cache[0].Labels["series"], "the survivor is A")
	for _, s := range cache {
		img := "nil"
		if s.Image != nil {
			img = "SET"
		}
		fmt.Printf("    [Q1] after series=%s CacheID=%s State=%s Reason=%q StartsAt=%s ResolvedAt=%s LastSentAt=%s EndsAt=%s Image=%s\n",
			s.Labels["series"], s.CacheID, s.State, s.StateReason, hhmmss(s.StartsAt), hhmmssP(s.ResolvedAt), hhmmssP(s.LastSentAt), hhmmss(s.EndsAt), img)
	}
}

// Q1 (send filtering) — all merged transitions are considered, then ONLY NeedsSending-eligible ones
// are dispatched. interval=10s so 2*interval=20s < ResendDelay=30s: a surviving Alerting series is
// NOT yet due for a cadence re-send when the vanished series is swept.
func TestBlitzyObsQ1SendFiltering(t *testing.T) {
	ctx := context.Background()
	clk := clock.NewMock()
	rule := blitzyRule(0, 10*time.Second)
	st := blitzyManager(clk, &state.NoopImageService{}, &state.FakeInstanceStore{})
	la, lb := data.Labels{"series": "A"}, data.Labels{"series": "B"}
	var dispatched state.StateTransitions
	send := func(_ context.Context, ss state.StateTransitions) { dispatched = ss }

	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{
		blitzyResult(eval.Alerting, la, clk.Now()),
		blitzyResult(eval.Alerting, lb, clk.Now()),
	}, nil, send)
	fmt.Printf("[Q1-filter] t0: A,B Alerting dispatched=%d (both newly firing)\n", len(dispatched))
	require.Len(t, dispatched, 2)

	clk.Add(2 * time.Duration(rule.IntervalSeconds) * time.Second) // +20s
	all := st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Alerting, la, clk.Now())}, nil, send)
	names := []string{}
	for _, tr := range dispatched {
		names = append(names, fmt.Sprintf("%s(%s reason=%q)", tr.Labels["series"], tr.State.State, tr.StateReason))
	}
	sort.Strings(names)
	fmt.Printf("[Q1-filter] t0+2*interval(20s<30s ResendDelay): merged(allChanges)=%d dispatched(statesToSend)=%d dispatched=%v\n",
		len(all), len(dispatched), names)
	require.Len(t, all, 2, "both A(maintained) and B(stale-resolved) are MERGED into allChanges")
	require.Len(t, dispatched, 1, "only B (newly resolved) is dispatched; A is NOT due for a re-send yet")
	require.Equal(t, "B", dispatched[0].Labels["series"], "the dispatched one is the stale-resolved B")
	require.Equal(t, models.StateReasonMissingSeries, dispatched[0].StateReason)
}

// Q2 — Stopped vs. slow (no liveness probe; purely time-based).
func TestBlitzyObsQ2StoppedVsSlow(t *testing.T) {
	ctx := context.Background()
	clk := clock.NewMock()
	rule := blitzyRule(0, 60*time.Second)
	st := blitzyManager(clk, &state.NoopImageService{}, &state.FakeInstanceStore{})
	la, lb := data.Labels{"series": "A"}, data.Labels{"series": "B"}
	present := func(series string) bool {
		return blitzyFind(st.GetStatesForRuleUID(rule.OrgID, rule.UID), series) != nil
	}
	count := func() int { return len(st.GetStatesForRuleUID(rule.OrgID, rule.UID)) }

	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{
		blitzyResult(eval.Alerting, la, clk.Now()),
		blitzyResult(eval.Alerting, lb, clk.Now()),
	}, nil, state.NoopSender)
	fmt.Printf("[Q2] t0: A,B Alerting; cacheCount=%d\n", count())
	require.Equal(t, 2, count())

	clk.Add(1 * time.Duration(rule.IntervalSeconds) * time.Second) // B absent 1 interval
	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Alerting, la, clk.Now())}, nil, state.NoopSender)
	fmt.Printf("[Q2] t0+1*interval (B absent 1 interval = SLOW): cacheCount=%d (B still present? %v)\n", count(), present("B"))
	require.Equal(t, 2, count(), "B absent only 1 interval is NOT stale")
	require.True(t, present("B"), "slow B survives")

	clk.Add(30 * time.Second) // B returns within the window; its staleness clock resets
	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{
		blitzyResult(eval.Alerting, la, clk.Now()),
		blitzyResult(eval.Alerting, lb, clk.Now()),
	}, nil, state.NoopSender)
	fmt.Printf("[Q2] B returned within window: cacheCount=%d (B present? %v)\n", count(), present("B"))
	require.True(t, present("B"), "B refreshed on return")

	clk.Add(2 * time.Duration(rule.IntervalSeconds) * time.Second) // B now absent >= 2 intervals from its return
	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Alerting, la, clk.Now())}, nil, state.NoopSender)
	fmt.Printf("[Q2] t+2*interval (B absent 2 intervals = STOPPED): cacheCount=%d (B present? %v)\n", count(), present("B"))
	require.Equal(t, 1, count(), "B absent 2 intervals IS stale -> swept")
	require.False(t, present("B"), "stopped B evicted")
}

// Q6 — Screenshot / image capture behavior across every named path, using a COUNTING capturer to
// prove takeImage invocation deltas and the three named error paths + an unexpected error.
func TestBlitzyObsQ6Screenshot(t *testing.T) {
	ctx := context.Background()
	la := data.Labels{"series": "A"}

	// (A) Alerting-vanish, COUNTING capturer: proves takeImage is invoked at the stale sweep.
	func() {
		clk := clock.NewMock()
		rule := blitzyRule(0, 60*time.Second)
		img := &countingImageService{}
		st := blitzyManager(clk, img, &state.FakeInstanceStore{})
		st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Alerting, la, clk.Now())}, nil, state.NoopSender)
		countAfterT0 := img.count
		clk.Add(2 * time.Duration(rule.IntervalSeconds) * time.Second)
		all := st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{}, nil, state.NoopSender)
		require.Len(t, all, 1)
		tr := all[0]
		token := ""
		if tr.Image != nil {
			token = tr.Image.Token
		}
		fmt.Printf("[Q6][A Alerting-vanish COUNTING] preState=%s -> new=%s reason=%q NewImageCalls t0=%d afterSweep=%d ResolvedAtSet=%v Image=%v token=%q\n",
			tr.PreviousState, tr.State.State, tr.StateReason, countAfterT0, img.count, tr.ResolvedAt != nil, tr.Image != nil, token)
		require.Equal(t, 1, countAfterT0, "Alerting@t0 takes 1 image (shouldTakeImage)")
		require.Equal(t, 2, img.count, "stale sweep invokes takeImage again (delta 1) -> total 2")
		require.Equal(t, eval.Normal, tr.State.State)
		require.Equal(t, models.StateReasonMissingSeries, tr.StateReason)
		require.NotNil(t, tr.ResolvedAt, "Alerting-vanish sets ResolvedAt")
		require.NotNil(t, tr.Image, "Alerting-vanish captures an image")
		require.Equal(t, "blitzy-img-2", tr.Image.Token, "the stale image is the 2nd capture")
	}()

	// (B) Pending-vanish, COUNTING capturer: guard oldState!=Alerting => NO takeImage, NO ResolvedAt.
	func() {
		clk := clock.NewMock()
		rule := blitzyRule(5*time.Minute, 60*time.Second)
		img := &countingImageService{}
		st := blitzyManager(clk, img, &state.FakeInstanceStore{})
		st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Alerting, la, clk.Now())}, nil, state.NoopSender)
		countAfterT0 := img.count
		clk.Add(2 * time.Duration(rule.IntervalSeconds) * time.Second)
		all := st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{}, nil, state.NoopSender)
		require.Len(t, all, 1)
		tr := all[0]
		fmt.Printf("[Q6][B Pending-vanish COUNTING] preState=%s -> new=%s reason=%q NewImageCalls t0=%d afterSweep=%d ResolvedAtSet=%v Image=%v\n",
			tr.PreviousState, tr.State.State, tr.StateReason, countAfterT0, img.count, tr.ResolvedAt != nil, tr.Image != nil)
		require.Equal(t, eval.Pending, tr.PreviousState, "series was Pending on vanish")
		require.Equal(t, 0, countAfterT0, "Pending takes no image at t0")
		require.Equal(t, 0, img.count, "stale sweep of a Pending series does NOT invoke takeImage")
		require.Nil(t, tr.ResolvedAt, "Pending-vanish sets no ResolvedAt")
		require.Nil(t, tr.Image, "Pending-vanish captures no image")
	}()

	// (C)-(E) Alerting-vanish where takeImage's NAMED errors are swallowed to (nil,nil):
	//         guard passes so ResolvedAt is set, but no image results.
	runSwallowed := func(label string, svc state.ImageCapturer) {
		clk := clock.NewMock()
		rule := blitzyRule(0, 60*time.Second)
		st := blitzyManager(clk, svc, &state.FakeInstanceStore{})
		st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Alerting, la, clk.Now())}, nil, state.NoopSender)
		clk.Add(2 * time.Duration(rule.IntervalSeconds) * time.Second)
		all := st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{}, nil, state.NoopSender)
		require.Len(t, all, 1)
		tr := all[0]
		fmt.Printf("[Q6][%s] preState=%s -> new=%s reason=%q ResolvedAtSet=%v Image=%v\n",
			label, tr.PreviousState, tr.State.State, tr.StateReason, tr.ResolvedAt != nil, tr.Image != nil)
		require.Equal(t, models.StateReasonMissingSeries, tr.StateReason)
		require.NotNil(t, tr.ResolvedAt, label+": guard oldState==Alerting still sets ResolvedAt")
		require.Nil(t, tr.Image, label+": takeImage returns nil -> no image")
	}
	runSwallowed("C Alerting-vanish ErrScreenshotsUnavailable", &state.NotAvailableImageService{})
	runSwallowed("D Alerting-vanish ErrNoDashboard", &errImageService{err: models.ErrNoDashboard})
	runSwallowed("E Alerting-vanish ErrNoPanel", &errImageService{err: models.ErrNoPanel})

	// (F) Alerting-vanish, UNEXPECTED error: takeImage returns (nil,err) -> logged & swallowed by the
	//     caller; Image stays nil, ResolvedAt still set, transition still occurs (non-fatal).
	func() {
		clk := clock.NewMock()
		rule := blitzyRule(0, 60*time.Second)
		svc := &errImageService{err: errors.New("boom-unexpected")}
		st := blitzyManager(clk, svc, &state.FakeInstanceStore{})
		st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Alerting, la, clk.Now())}, nil, state.NoopSender)
		countAfterT0 := svc.count
		clk.Add(2 * time.Duration(rule.IntervalSeconds) * time.Second)
		all := st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{}, nil, state.NoopSender)
		require.Len(t, all, 1)
		tr := all[0]
		fmt.Printf("[Q6][F Alerting-vanish UNEXPECTED-error] preState=%s -> new=%s reason=%q NewImageCalls t0=%d afterSweep=%d ResolvedAtSet=%v Image=%v\n",
			tr.PreviousState, tr.State.State, tr.StateReason, countAfterT0, svc.count, tr.ResolvedAt != nil, tr.Image != nil)
		require.Greater(t, svc.count, countAfterT0, "takeImage WAS invoked during the stale sweep")
		require.Equal(t, models.StateReasonMissingSeries, tr.StateReason)
		require.NotNil(t, tr.ResolvedAt, "unexpected error does not prevent ResolvedAt")
		require.Nil(t, tr.Image, "unexpected error -> no image (logged & swallowed)")
	}()

	// (G) NATURAL resolution Alerting->Normal (series present, recovered) via shouldTakeImage(resolved).
	func() {
		clk := clock.NewMock()
		rule := blitzyRule(0, 60*time.Second)
		img := &countingImageService{}
		st := blitzyManager(clk, img, &state.FakeInstanceStore{})
		st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Alerting, la, clk.Now())}, nil, state.NoopSender)
		countAfterT0 := img.count
		clk.Add(1 * time.Duration(rule.IntervalSeconds) * time.Second)
		all := st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Normal, la, clk.Now())}, nil, state.NoopSender)
		tr := blitzyFindTransition(all, "A")
		require.NotNil(t, tr)
		token := ""
		if tr.Image != nil {
			token = tr.Image.Token
		}
		fmt.Printf("[Q6][G natural Alerting->Normal shouldTakeImage COUNTING] new=%s reason=%q NewImageCalls t0=%d afterResolve=%d ResolvedAtSet=%v Image=%v token=%q\n",
			tr.State.State, tr.StateReason, countAfterT0, img.count, tr.ResolvedAt != nil, tr.Image != nil, token)
		require.Equal(t, eval.Normal, tr.State.State)
		require.Equal(t, "", tr.StateReason, "natural resolution has empty reason (NOT MissingSeries)")
		require.NotNil(t, tr.ResolvedAt, "natural resolution sets ResolvedAt")
		require.NotNil(t, tr.Image, "natural resolution takes an image via shouldTakeImage(resolved)")
		require.Greater(t, img.count, countAfterT0, "takeImage invoked again at natural resolution")
	}()
}

// Q7 — Pending period (for) on the way out is BYPASSED.
func TestBlitzyObsQ7PendingBypass(t *testing.T) {
	ctx := context.Background()
	clk := clock.NewMock()
	rule := blitzyRule(5*time.Minute, 60*time.Second) // For=5m
	st := blitzyManager(clk, &state.NoopImageService{}, &state.FakeInstanceStore{})
	la := data.Labels{"series": "A"}
	var dispatched state.StateTransitions
	send := func(_ context.Context, ss state.StateTransitions) { dispatched = ss }

	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Alerting, la, clk.Now())}, nil, send)
	s := blitzyFind(st.GetStatesForRuleUID(rule.OrgID, rule.UID), "A")
	require.NotNil(t, s, "series A cached")
	require.Equal(t, eval.Pending, s.State, "with For=5m, the first Alerting result yields Pending")
	require.Nil(t, s.ResolvedAt)
	require.Nil(t, s.LastSentAt)
	require.Nil(t, s.Image)
	img := "nil"
	if s.Image != nil {
		img = "SET"
	}
	fmt.Printf("[Q7] t0 (rule For=5m):  CacheID=%s State=%s Reason=%q StartsAt=%s ResolvedAt=%s LastSentAt=%s EndsAt=%s Image=%s\n",
		s.CacheID, s.State, s.StateReason, hhmmss(s.StartsAt), hhmmssP(s.ResolvedAt), hhmmssP(s.LastSentAt), hhmmss(s.EndsAt), img)

	clk.Add(2 * time.Duration(rule.IntervalSeconds) * time.Second) // elapsed 2m < For 5m
	all := st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{}, nil, send)
	fmt.Printf("[Q7] t0+2*interval (elapsed=2m < For=5m); A vanished. transitions=%d dispatched=%d\n", len(all), len(dispatched))
	require.Len(t, all, 1, "one stale transition")
	tr := all[0]
	fmt.Printf("    [Q7] prev=%s -> new=%s reason=%q resolvedSet=%v image=%v (skipped Pending/for wait)\n",
		tr.PreviousState, tr.State.State, tr.StateReason, tr.ResolvedAt != nil, tr.Image != nil)
	require.Equal(t, eval.Pending, tr.PreviousState, "was Pending")
	require.Equal(t, eval.Normal, tr.State.State, "swept directly to Normal, bypassing resultAlerting/for")
	require.Equal(t, models.StateReasonMissingSeries, tr.StateReason)
	require.Nil(t, tr.ResolvedAt, "no ResolvedAt (was never Alerting)")
	require.Nil(t, tr.Image, "no image")
	require.Len(t, dispatched, 0, "nothing dispatched (Normal with nil ResolvedAt does not send)")
}

// Q7 (old-Normal nuance) — a series whose oldState was Normal (not Alerting) when it vanishes.
// Never-fired Normal => no ResolvedAt (there was none). Previously naturally-resolved Normal =>
// the pre-existing ResolvedAt/image are RETAINED (the sweep does not clear them, and does not create new ones).
func TestBlitzyObsQ7OldNormalVanish(t *testing.T) {
	ctx := context.Background()
	la := data.Labels{"series": "A"}

	// Case 1: NEVER-FIRED Normal.
	func() {
		clk := clock.NewMock()
		rule := blitzyRule(0, 60*time.Second)
		st := blitzyManager(clk, &state.NoopImageService{}, &state.FakeInstanceStore{})
		st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Normal, la, clk.Now())}, nil, state.NoopSender)
		pre := blitzyFind(st.GetStatesForRuleUID(rule.OrgID, rule.UID), "A")
		require.NotNil(t, pre, "never-fired Normal series is cached")
		require.Equal(t, eval.Normal, pre.State)
		require.Nil(t, pre.ResolvedAt, "never fired => no ResolvedAt")
		clk.Add(2 * time.Duration(rule.IntervalSeconds) * time.Second)
		all := st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{}, nil, state.NoopSender)
		require.Len(t, all, 1)
		tr := all[0]
		fmt.Printf("[Q7-oldNormal][never-fired] prev=%s -> new=%s reason=%q resolvedSet=%v image=%v\n",
			tr.PreviousState, tr.State.State, tr.StateReason, tr.ResolvedAt != nil, tr.Image != nil)
		require.Equal(t, eval.Normal, tr.PreviousState, "was Normal")
		require.Equal(t, eval.Normal, tr.State.State)
		require.Equal(t, models.StateReasonMissingSeries, tr.StateReason)
		require.Nil(t, tr.ResolvedAt, "never-fired Normal vanish: still no ResolvedAt")
		require.Nil(t, tr.Image, "no image")
	}()

	// Case 2: PREVIOUSLY NATURALLY-RESOLVED Normal.
	func() {
		clk := clock.NewMock()
		rule := blitzyRule(0, 60*time.Second)
		img := &countingImageService{}
		st := blitzyManager(clk, img, &state.FakeInstanceStore{})
		st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Alerting, la, clk.Now())}, nil, state.NoopSender)
		clk.Add(1 * time.Duration(rule.IntervalSeconds) * time.Second)
		resolveAt := clk.Now()
		st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Normal, la, clk.Now())}, nil, state.NoopSender)
		pre := blitzyFind(st.GetStatesForRuleUID(rule.OrgID, rule.UID), "A")
		require.NotNil(t, pre)
		require.Equal(t, eval.Normal, pre.State)
		require.NotNil(t, pre.ResolvedAt, "natural resolution set ResolvedAt")
		require.True(t, pre.ResolvedAt.Equal(resolveAt), "ResolvedAt == natural-resolution time")
		require.NotNil(t, pre.Image, "natural resolution captured an image")
		imgCountBeforeSweep := img.count
		clk.Add(2 * time.Duration(rule.IntervalSeconds) * time.Second) // vanish 2 intervals FROM resolution
		all := st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{}, nil, state.NoopSender)
		require.Len(t, all, 1)
		tr := all[0]
		retained := tr.ResolvedAt != nil && tr.ResolvedAt.Equal(resolveAt)
		fmt.Printf("[Q7-oldNormal][prev-resolved] prev=%s -> new=%s reason=%q resolvedSet=%v resolvedAt=%s (retained-from-natural=%v) image=%v NewImageCalls beforeSweep=%d afterSweep=%d\n",
			tr.PreviousState, tr.State.State, tr.StateReason, tr.ResolvedAt != nil, hhmmssP(tr.ResolvedAt), retained, tr.Image != nil, imgCountBeforeSweep, img.count)
		require.Equal(t, eval.Normal, tr.PreviousState)
		require.Equal(t, eval.Normal, tr.State.State)
		require.Equal(t, models.StateReasonMissingSeries, tr.StateReason, "reason becomes MissingSeries")
		require.NotNil(t, tr.ResolvedAt, "pre-existing ResolvedAt is RETAINED (not cleared by the sweep)")
		require.True(t, retained, "retained ResolvedAt equals the ORIGINAL natural-resolution time, not the sweep time")
		require.NotNil(t, tr.Image, "pre-existing image is retained")
		require.Equal(t, imgCountBeforeSweep, img.count, "sweep of a non-Alerting series does NOT take a new image")
	}()
}

// Q8 — Reappearance identity (same CacheID fingerprint, fresh instance state).
func TestBlitzyObsQ8Reappearance(t *testing.T) {
	ctx := context.Background()
	clk := clock.NewMock()
	rule := blitzyRule(0, 60*time.Second)
	st := blitzyManager(clk, &state.NoopImageService{}, &state.FakeInstanceStore{})
	la := data.Labels{"series": "A"}
	prState := func(prefix string, s *state.State) {
		img := "nil"
		if s.Image != nil {
			img = "SET"
		}
		fmt.Printf("[Q8] %s  CacheID=%s State=%s Reason=%q StartsAt=%s ResolvedAt=%s LastSentAt=%s EndsAt=%s Image=%s\n",
			prefix, s.CacheID, s.State, s.StateReason, hhmmss(s.StartsAt), hhmmssP(s.ResolvedAt), hhmmssP(s.LastSentAt), hhmmss(s.EndsAt), img)
	}

	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Alerting, la, clk.Now())}, nil, state.NoopSender)
	orig := blitzyFind(st.GetStatesForRuleUID(rule.OrgID, rule.UID), "A")
	require.NotNil(t, orig)
	origID, origStarts := orig.CacheID, orig.StartsAt
	prState("t0 original instance: ", orig)

	clk.Add(2 * time.Duration(rule.IntervalSeconds) * time.Second)
	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{}, nil, state.NoopSender)
	require.Len(t, st.GetStatesForRuleUID(rule.OrgID, rule.UID), 0, "evicted after stale sweep")
	fmt.Printf("[Q8] after vanish 2*interval: cacheCount=%d (evicted, not persisted)\n", len(st.GetStatesForRuleUID(rule.OrgID, rule.UID)))

	clk.Add(3 * time.Minute) // now at t=5m
	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Alerting, la, clk.Now())}, nil, state.NoopSender)
	re := blitzyFind(st.GetStatesForRuleUID(rule.OrgID, rule.UID), "A")
	require.NotNil(t, re)
	prState("reappeared instance: ", re)
	fmt.Printf("[Q8] CacheID identical to original? %v (orig=%s reappeared=%s)\n", origID == re.CacheID, origID, re.CacheID)
	fmt.Printf("[Q8] StartsAt reset to reappearance time? origStarts=%s newStarts=%s differ=%v\n",
		hhmmss(origStarts), hhmmss(re.StartsAt), !origStarts.Equal(re.StartsAt))
	require.Equal(t, origID, re.CacheID, "identical labels -> identical CacheID fingerprint")
	require.False(t, origStarts.Equal(re.StartsAt), "StartsAt reset to reappearance time (fresh instance)")
	require.Nil(t, re.ResolvedAt, "fresh instance: ResolvedAt reset to nil")
	require.Equal(t, "", re.StateReason, "fresh instance: StateReason cleared")
}

// Q1/Q8 persistence — REAL SyncStatePersister: the persisted predecessor is DELETED at stale
// detection, and the stale transition is NOT re-saved (skip-save). No persisted predecessor remains.
func TestBlitzyObsQ1Q8Persistence(t *testing.T) {
	ctx := context.Background()
	clk := clock.NewMock()
	rule := blitzyRule(0, 60*time.Second)
	store := &state.FakeInstanceStore{}
	cfg := blitzyCfg(clk, &state.NoopImageService{}, store)
	persister := state.NewSyncStatePersisiter(cfg.Log, cfg)
	st := state.NewManager(cfg, persister)
	la, lb := data.Labels{"series": "A"}, data.Labels{"series": "B"}

	res0 := eval.Results{
		blitzyResult(eval.Alerting, la, clk.Now()),
		blitzyResult(eval.Alerting, lb, clk.Now()),
	}
	st.ProcessEvalResults(ctx, clk.Now(), rule, res0, nil, state.NoopSender)
	base := len(store.RecordedOps())
	savedT0 := 0
	for _, op := range store.RecordedOps() {
		if _, ok := op.(models.AlertInstance); ok {
			savedT0++
		}
	}
	fmt.Printf("[Q1/Q8-persist] t0: A,B Alerting -> %d store ops (predecessors persisted: %d saves)\n", base, savedT0)
	require.Equal(t, 2, savedT0, "both A and B (predecessors) are SAVED at t0")

	clk.Add(2 * time.Duration(rule.IntervalSeconds) * time.Second)
	res1 := eval.Results{blitzyResult(eval.Alerting, la, clk.Now())}
	st.ProcessEvalResults(ctx, clk.Now(), rule, res1, nil, state.NoopSender)
	fmt.Printf("[Q1/Q8-persist] after B goes stale, NEW store ops this eval:\n")
	ops := store.RecordedOps()
	deletes, staleDeletedKeys := 0, 0
	savedThisEval := map[string]bool{}
	for _, op := range ops[base:] {
		switch v := op.(type) {
		case state.FakeInstanceStoreOp:
			if v.Name == "DeleteAlertInstances" {
				deletes++
				if keys, ok := v.Args[1].([]models.AlertInstanceKey); ok {
					staleDeletedKeys += len(keys)
					fmt.Printf("    DB-DELETE: DeleteAlertInstances (stale keys count=%d)\n", len(keys))
				}
			}
		case models.AlertInstance:
			savedThisEval[v.Labels["series"]] = true
			fmt.Printf("    DB-SAVE: series=%s state=%v reason=%q\n", v.Labels["series"], v.CurrentState, v.CurrentReason)
		}
	}
	require.Equal(t, 1, deletes, "exactly one DeleteAlertInstances call for the stale series")
	require.Equal(t, 1, staleDeletedKeys, "one stale key (B) deleted from the DB")
	require.True(t, savedThisEval["A"], "surviving A is re-saved")
	require.False(t, savedThisEval["B"], "stale B is NOT re-saved (skip-save at persister_sync.go:82-84)")
}

// Q4/Q5 — end-to-end send lifecycle: NATURAL resolution (re-sent until retention) vs STALE (sent
// once then evicted). LastSentAt is read from the CACHE (manager-observed), NOT assigned manually.
func TestBlitzyObsQ4Q5SendLifecycle(t *testing.T) {
	ctx := context.Background()
	epoch := time.Unix(0, 0)
	la := data.Labels{"series": "A"}

	// Part 1 — NATURAL resolution, interval=30s.
	fmt.Printf("[Q4/Q5] Part 1 NATURAL resolution: interval=30s ResendDelay=30s ResolvedRetention=15m\n")
	clk := clock.NewMock()
	rule := blitzyRule(0, 30*time.Second)
	st := blitzyManager(clk, &state.NoopImageService{}, &state.FakeInstanceStore{})
	var sent int
	send := func(_ context.Context, ss state.StateTransitions) { sent = len(ss) }

	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Alerting, la, clk.Now())}, nil, send)
	a0 := blitzyFind(st.GetStatesForRuleUID(rule.OrgID, rule.UID), "A")
	require.NotNil(t, a0)
	fmt.Printf("[Q4/Q5] t=%4.1fm %-16s sent=%d cachedLastSentAt=%s\n", clk.Now().Sub(epoch).Minutes(), "Alerting", sent, hhmmssP(a0.LastSentAt))
	require.Equal(t, 1, sent, "Alerting notification sent at t0")

	immediate, reSends := 0, 0
	firstStopMin := -1.0
	resolvedAt := ""
	for i := 1; i <= 33; i++ {
		clk.Add(30 * time.Second)
		st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Normal, la, clk.Now())}, nil, send)
		s := blitzyFind(st.GetStatesForRuleUID(rule.OrgID, rule.UID), "A")
		require.NotNil(t, s)
		since := 0.0
		if s.ResolvedAt != nil {
			since = s.LastEvaluationTime.Sub(*s.ResolvedAt).Minutes()
			if resolvedAt == "" {
				resolvedAt = hhmmssP(s.ResolvedAt)
			}
		}
		fmt.Printf("[Q4/Q5] t=%4.1fm %-16s sent=%d sinceResolved=%.1fm cachedLastSentAt=%s\n",
			clk.Now().Sub(epoch).Minutes(), "Normal(resolved)", sent, since, hhmmssP(s.LastSentAt))
		if sent > 0 {
			if i == 1 {
				immediate++
			} else {
				reSends++
			}
		} else if firstStopMin < 0 {
			firstStopMin = clk.Now().Sub(epoch).Minutes()
		}
	}
	total := immediate + reSends
	fmt.Printf("[Q4/Q5] Part 1 resolved sends total=%d = %d immediate + %d re-sends; sending stopped at t=%.1fm (ResolvedAt=%s)\n",
		total, immediate, reSends, firstStopMin, resolvedAt)
	require.Equal(t, 1, immediate, "exactly 1 immediate resolution send (t=0.5m)")
	require.Equal(t, 30, reSends, "exactly 30 re-sends (t=1.0m .. t=15.5m)")
	require.Equal(t, 31, total, "31 total resolved sends = 1 immediate + 30 re-sends")
	require.InDelta(t, 16.0, firstStopMin, 0.001, "natural-resolution sending stops at t=16.0m (ResolvedAt=0.5m, window 15m)")

	// Part 2 — STALE resolution, interval=60s.
	fmt.Printf("[Q4/Q5] Part 2 STALE resolution: interval=60s\n")
	clk2 := clock.NewMock()
	rule2 := blitzyRule(0, 60*time.Second)
	st2 := blitzyManager(clk2, &state.NoopImageService{}, &state.FakeInstanceStore{})
	st2.ProcessEvalResults(ctx, clk2.Now(), rule2, eval.Results{blitzyResult(eval.Alerting, la, clk2.Now())}, nil, send)
	c1 := len(st2.GetStatesForRuleUID(rule2.OrgID, rule2.UID))
	fmt.Printf("[Q4/Q5] t=0 Alerting sent=%d cacheCount=%d\n", sent, c1)
	require.Equal(t, 1, sent)
	require.Equal(t, 1, c1)
	clk2.Add(2 * time.Duration(rule2.IntervalSeconds) * time.Second)
	st2.ProcessEvalResults(ctx, clk2.Now(), rule2, eval.Results{}, nil, send)
	c2 := len(st2.GetStatesForRuleUID(rule2.OrgID, rule2.UID))
	fmt.Printf("[Q4/Q5] t=2*interval A vanished -> stale detection: sent=%d cacheCount=%d\n", sent, c2)
	require.Equal(t, 1, sent, "stale resolution sent ONCE at detection")
	require.Equal(t, 0, c2, "evicted immediately")
	clk2.Add(1 * time.Duration(rule2.IntervalSeconds) * time.Second)
	st2.ProcessEvalResults(ctx, clk2.Now(), rule2, eval.Results{}, nil, send)
	c3 := len(st2.GetStatesForRuleUID(rule2.OrgID, rule2.UID))
	fmt.Printf("[Q4/Q5] t=3*interval A still absent (already evicted): sent=%d cacheCount=%d\n", sent, c3)
	require.Equal(t, 0, sent, "nothing left to send")
	require.Equal(t, 0, c3)
}

// Q5 (cadence qualification) — ResendDelay is a MINIMUM spacing, not an independent 30s timer.
// interval=20s < ResendDelay=30s: a resolved series is re-sent only on the FIRST evaluation at/after
// ResendDelay since the last send (=> every 2 intervals = 40s), NOT on every evaluation.
func TestBlitzyObsQ5CadenceQualification(t *testing.T) {
	ctx := context.Background()
	epoch := time.Unix(0, 0)
	la := data.Labels{"series": "A"}
	clk := clock.NewMock()
	rule := blitzyRule(0, 20*time.Second)
	st := blitzyManager(clk, &state.NoopImageService{}, &state.FakeInstanceStore{})
	var sent int
	send := func(_ context.Context, ss state.StateTransitions) { sent = len(ss) }
	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Alerting, la, clk.Now())}, nil, send)
	fmt.Printf("[Q5-cadence] interval=20s ResendDelay=30s; t=0s Alerting sent=%d\n", sent)
	sendTimes := []int{}
	for i := 1; i <= 8; i++ {
		clk.Add(20 * time.Second)
		st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{blitzyResult(eval.Normal, la, clk.Now())}, nil, send)
		s := blitzyFind(st.GetStatesForRuleUID(rule.OrgID, rule.UID), "A")
		require.NotNil(t, s)
		secs := int(clk.Now().Sub(epoch).Seconds())
		fmt.Printf("[Q5-cadence] t=%3ds Normal(resolved) sent=%d cachedLastSentAt=%s\n", secs, sent, hhmmssP(s.LastSentAt))
		if sent > 0 {
			sendTimes = append(sendTimes, secs)
		}
	}
	fmt.Printf("[Q5-cadence] resolved send times (s) = %v (spaced 2 intervals=40s, NOT every 20s eval)\n", sendTimes)
	require.Equal(t, []int{20, 60, 100, 140}, sendTimes, "sends occur on the first eval at/after ResendDelay since last send, not every eval")
}
```

### `pkg/services/ngalert/state/zz_blitzy_fix_internal_test.go` (package `state`, internal — transient/removed)

Additional transient script authored to capture the QA-fix evidence (nanosecond timing triads via the unexported `stateIsStale` and `(*State).NeedsSending`).

```go
// TRANSIENT OBSERVATION SCRIPT — created, run, then DELETED. Never committed.
// package state (internal): can call the unexported stateIsStale and the (*State).NeedsSending
// predicate directly to probe the three timing boundaries at NANOSECOND precision (Issue 5).
package state

import (
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana/pkg/services/ngalert/eval"
)

func blitzyFixPtr(t time.Time) *time.Time { return &t }

// Issue 5 (a) — STALENESS boundary at nanosecond precision.
// Exercises the unexported stateIsStale (manager.go:627-629) at exactly 2*interval-1ns, ==2*interval,
// and +1ns, proving the boundary is equality-inclusive. The CANONICAL confirmation through
// Manager.ProcessEvalResults at nanosecond precision is TestBlitzyFixStaleNanoCanonical (external).
func TestBlitzyFixStaleNanoTriad(t *testing.T) {
	var interval int64 = 60 // 2*interval = 120s = 2m0s
	lastEval, _ := time.Parse(time.RFC3339, "2024-01-01T00:00:00Z")
	twoI := 2 * time.Duration(interval) * time.Second
	fmt.Printf("[Q3-nano] stateIsStale(evaluatedAt,lastEval,interval=%ds): 2*interval=%s lastEval=%s\n",
		interval, twoI, lastEval.Format(time.RFC3339))
	cases := []struct {
		off  time.Duration
		want bool
		note string
	}{
		{twoI - time.Nanosecond, false, "2*interval - 1ns -> NOT stale"},
		{twoI, true, "2*interval (equality) -> stale"},
		{twoI + time.Nanosecond, true, "2*interval + 1ns -> stale"},
	}
	for _, c := range cases {
		got := stateIsStale(lastEval.Add(c.off), lastEval, interval)
		fmt.Printf("[Q3-nano] offset=%-16s -> stateIsStale=%-5v (%s)\n", c.off, got, c.note)
		require.Equalf(t, c.want, got, "offset %s: stateIsStale mismatch", c.off)
	}
}

// Issue 5 (b) — RESEND cadence boundary at nanosecond precision.
// Isolates the cadence gate of (*State).NeedsSending (state.go:519): a resolved Normal with
// LastSentAt=t0 becomes due for re-send at exactly LastSentAt+ResendDelay (30s), equality-inclusive.
func TestBlitzyFixResendNanoTriad(t *testing.T) {
	resend := 30 * time.Second
	retention := 15 * time.Minute
	base, _ := time.Parse(time.RFC3339, "2024-01-01T00:00:00Z")
	fmt.Printf("[Q5-resend-nano] ResendDelay=%s (State=Normal, ResolvedAt=t0, LastSentAt=t0)\n", resend)
	cases := []struct {
		off  time.Duration
		want bool
		note string
	}{
		{resend - time.Nanosecond, false, "LastSentAt+30s - 1ns -> NOT due (0)"},
		{resend, true, "LastSentAt+30s (equality) -> due (1)"},
		{resend + time.Nanosecond, true, "LastSentAt+30s + 1ns -> due (1)"},
	}
	for _, c := range cases {
		s := &State{
			State:              eval.Normal,
			ResolvedAt:         blitzyFixPtr(base),
			LastSentAt:         blitzyFixPtr(base),
			LastEvaluationTime: base.Add(c.off),
		}
		got := s.NeedsSending(resend, retention)
		out := 0
		if got {
			out = 1
		}
		fmt.Printf("[Q5-resend-nano] sinceLastSent=%-16s -> NeedsSending=%-5v -> %d (%s)\n", c.off, got, out, c.note)
		require.Equalf(t, c.want, got, "sinceLastSent %s: NeedsSending mismatch", c.off)
	}
}

// Issue 5 (c) — RESOLVED-RETENTION boundary at nanosecond precision.
// Isolates the retention hard-stop of (*State).NeedsSending (state.go:513-515): a resolved Normal
// keeps re-sending until LastEvaluationTime-ResolvedAt EXCEEDS ResolvedRetention (15m); the stop is
// strict ">", so exactly 15m still sends and 15m+1ns is the first suppression.
func TestBlitzyFixRetentionNanoTriad(t *testing.T) {
	resend := 30 * time.Second
	retention := 15 * time.Minute
	base, _ := time.Parse(time.RFC3339, "2024-01-01T00:00:00Z")
	fmt.Printf("[Q5-retention-nano] ResolvedRetention=%s (State=Normal, ResolvedAt=t0, LastSentAt=t0)\n", retention)
	cases := []struct {
		off  time.Duration
		want bool
		note string
	}{
		{retention - time.Nanosecond, true, "sinceResolved 15m - 1ns -> still sends (1)"},
		{retention, true, "sinceResolved 15m (equality, strict >) -> still sends (1)"},
		{retention + time.Nanosecond, false, "sinceResolved 15m + 1ns -> suppressed (0)"},
	}
	for _, c := range cases {
		s := &State{
			State:              eval.Normal,
			ResolvedAt:         blitzyFixPtr(base),
			LastSentAt:         blitzyFixPtr(base), // long-ago send: cadence satisfied, so retention is the deciding gate
			LastEvaluationTime: base.Add(c.off),
		}
		got := s.NeedsSending(resend, retention)
		out := 0
		if got {
			out = 1
		}
		fmt.Printf("[Q5-retention-nano] sinceResolved=%-16s -> NeedsSending=%-5v -> %d (%s)\n", c.off, got, out, c.note)
		require.Equalf(t, c.want, got, "sinceResolved %s: NeedsSending mismatch", c.off)
	}
}
```

### `pkg/services/ngalert/state/zz_blitzy_fix_test.go` (package `state_test`, external — transient/removed)

Additional transient script authored to capture the QA-fix evidence through the real `Manager.ProcessEvalResults` entry point: the cohesive end-to-end lifecycle, the sender/image/reason wire-mapping, the concrete sqlite DB read-back, the post-`Alerting` `for`-vanish, the previously-resolved-Normal stale send, and the image rule-argument recorder.

```go
// TRANSIENT OBSERVATION SCRIPT — created, run, then DELETED. Never committed.
// package state_test (external): drives the REAL canonical entry point Manager.ProcessEvalResults
// to capture the runtime evidence demanded by QA Report 5 (Issues 1,2,3,4,5,6,7).
package state_test

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"testing"
	"time"

	"github.com/benbjohnson/clock"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana/pkg/infra/log"
	"github.com/grafana/grafana/pkg/infra/tracing"
	"github.com/grafana/grafana/pkg/services/ngalert/eval"
	"github.com/grafana/grafana/pkg/services/ngalert/metrics"
	"github.com/grafana/grafana/pkg/services/ngalert/models"
	"github.com/grafana/grafana/pkg/services/ngalert/state"
	"github.com/grafana/grafana/pkg/services/ngalert/tests"
)

// ---------------- harness helpers (fakes only for image/store/clock; the state machine is production code) ----------------

func fixCfg(clk clock.Clock, images state.ImageCapturer, store state.InstanceStore) state.ManagerCfg {
	return state.ManagerCfg{
		Metrics:                 metrics.NewNGAlert(prometheus.NewPedanticRegistry()).GetStateMetrics(),
		ExternalURL:             nil,
		InstanceStore:           store,
		Images:                  images,
		Clock:                   clk,
		Historian:               &state.FakeHistorian{},
		Tracer:                  tracing.InitializeTracerForTest(),
		Log:                     log.New("ngalert.state.manager"),
		ResolvedRetention:       15 * time.Minute,
		MaxStateSaveConcurrency: 1,
	}
}

// fixManager builds a Manager with a NO-OP persister (in-memory only).
func fixManager(clk clock.Clock, images state.ImageCapturer, store state.InstanceStore) *state.Manager {
	return state.NewManager(fixCfg(clk, images, store), state.NewNoopPersister())
}

// fixManagerSync builds a Manager with the REAL SyncStatePersister so DeleteAlertInstances /
// SaveAlertInstance calls reach the provided InstanceStore (interface-level persistence evidence).
func fixManagerSync(clk clock.Clock, images state.ImageCapturer, store state.InstanceStore) *state.Manager {
	cfg := fixCfg(clk, images, store)
	return state.NewManager(cfg, state.NewSyncStatePersisiter(log.New("ngalert.state.persister"), cfg))
}

func fixRule(forDur, interval time.Duration) *models.AlertRule {
	gen := models.RuleGen
	return gen.With(gen.WithFor(forDur), gen.WithInterval(interval), gen.WithLabels(data.Labels{})).GenerateRef()
}

func fixResult(st eval.State, labels data.Labels, at time.Time) eval.Result {
	return eval.ResultGen(eval.WithState(st), eval.WithLabels(labels), eval.WithEvaluatedAt(at))()
}

func fixFindTransition(all state.StateTransitions, series string) *state.StateTransition {
	for i := range all {
		if all[i].Labels["series"] == series {
			return &all[i]
		}
	}
	return nil
}

func fixInDispatched(dispatched state.StateTransitions, series string) bool {
	for i := range dispatched {
		if dispatched[i].Labels["series"] == series {
			return true
		}
	}
	return false
}

func hhmmss(t time.Time) string { return t.UTC().Format("15:04:05") }
func hhmmssP(t *time.Time) string {
	if t == nil {
		return "nil"
	}
	return t.UTC().Format("15:04:05")
}
func imgTok(s *state.State) string {
	if s == nil || s.Image == nil {
		return "nil"
	}
	return s.Image.Token
}
func cachePresent(m *state.Manager, rule *models.AlertRule, series string) bool {
	for _, s := range m.GetStatesForRuleUID(rule.OrgID, rule.UID) {
		if s.Labels["series"] == series {
			return true
		}
	}
	return false
}

// countingImageService counts NewImage invocations and returns a UNIQUE token each time, so a
// caller can prove takeImage was actually invoked (count delta) and which capture landed on a state.
type fixCountingImage struct{ count int }

func (c *fixCountingImage) NewImage(_ context.Context, _ *models.AlertRule) (*models.Image, error) {
	c.count++
	return &models.Image{Token: fmt.Sprintf("blitzy-img-%d", c.count)}, nil
}

// fixRecordingImage captures the *models.AlertRule argument of every NewImage call (Issue 7), so we
// can assert the SAME rule pointer and identity (UID/dashboard/panel) reaches both the natural and
// the stale image path.
type fixImgCall struct {
	rule  *models.AlertRule
	uid   string
	dash  string
	panel string
}
type fixRecordingImage struct {
	count int
	calls []fixImgCall
}

func (r *fixRecordingImage) NewImage(_ context.Context, rule *models.AlertRule) (*models.Image, error) {
	r.count++
	dash, panel := "nil", "nil"
	if rule.DashboardUID != nil {
		dash = *rule.DashboardUID
	}
	if rule.PanelID != nil {
		panel = fmt.Sprintf("%d", *rule.PanelID)
	}
	r.calls = append(r.calls, fixImgCall{rule: rule, uid: rule.UID, dash: dash, panel: panel})
	return &models.Image{Token: fmt.Sprintf("blitzy-img-%d", r.count)}, nil
}

// ============================================================================================
// Issue 5 (canonical cross-check) — STALENESS boundary through the REAL ProcessEvalResults at
// NANOSECOND precision: +2*interval-1ns survives (cacheCount=1), ==2*interval is swept (cacheCount=0).
// ============================================================================================
func TestBlitzyFixStaleNanoCanonical(t *testing.T) {
	ctx := context.Background()
	la := data.Labels{"series": "A"}
	twoI := 120 * time.Second

	clk := clock.NewMock()
	rule := fixRule(0, 60*time.Second)
	st := fixManager(clk, &state.NoopImageService{}, &state.FakeInstanceStore{})
	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{fixResult(eval.Alerting, la, clk.Now())}, nil, state.NoopSender)
	clk.Add(twoI - time.Nanosecond)
	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{}, nil, state.NoopSender)
	c1 := len(st.GetStatesForRuleUID(rule.OrgID, rule.UID))
	fmt.Printf("[Q3-canonical-nano] ProcessEvalResults +(2*interval - 1ns) absent -> cacheCount=%d (survives, NOT stale)\n", c1)

	clk2 := clock.NewMock()
	rule2 := fixRule(0, 60*time.Second)
	st2 := fixManager(clk2, &state.NoopImageService{}, &state.FakeInstanceStore{})
	st2.ProcessEvalResults(ctx, clk2.Now(), rule2, eval.Results{fixResult(eval.Alerting, la, clk2.Now())}, nil, state.NoopSender)
	clk2.Add(twoI)
	st2.ProcessEvalResults(ctx, clk2.Now(), rule2, eval.Results{}, nil, state.NoopSender)
	c2 := len(st2.GetStatesForRuleUID(rule2.OrgID, rule2.UID))
	fmt.Printf("[Q3-canonical-nano] ProcessEvalResults +(2*interval)      absent -> cacheCount=%d (swept, stale)\n", c2)

	require.Equal(t, 1, c1, "+2*interval-1ns must survive")
	require.Equal(t, 0, c2, "+2*interval (equality-inclusive) must be swept")
}

// ============================================================================================
// Issue 1 + Issue 4 — COHESIVE end-to-end lifecycle in ONE manager / ONE clock / ONE output:
// multi-series firing -> temporary absence & return (slow != stale) -> exact stale boundary ->
// stale sender/image/persistence/cache effects -> natural retention equality & +1ns suppression ->
// identical-label reappearance. interval=60s, For=0. Series A (survivor/natural-resolve), B (vanishes
// then reappears), C (temporarily slow then returns).
// ============================================================================================
func TestBlitzyFixCohesiveLifecycleE2E(t *testing.T) {
	ctx := context.Background()
	clk := clock.NewMock() // t0 = 1970-01-01T00:00:00Z (mock epoch)
	rule := fixRule(0, 60*time.Second)
	imgs := &fixCountingImage{}
	store := &state.FakeInstanceStore{}
	st := fixManagerSync(clk, imgs, store) // REAL SyncStatePersister -> store ops observable
	la, lb, lc := data.Labels{"series": "A"}, data.Labels{"series": "B"}, data.Labels{"series": "C"}

	var dispatched state.StateTransitions
	send := func(_ context.Context, ss state.StateTransitions) { dispatched = ss }

	dump := func(tag string, all state.StateTransitions, series ...string) {
		sort.Slice(all, func(i, j int) bool { return all[i].Labels["series"] < all[j].Labels["series"] })
		for _, name := range series {
			tr := fixFindTransition(all, name)
			if tr == nil {
				fmt.Printf("    [%s] series=%s (no transition this cycle)\n", tag, name)
				continue
			}
			fmt.Printf("    [%s] series=%s CacheID=%s prev=%s->new=%s reason=%q StartsAt=%s ResolvedAt=%s LastSentAt=%s LastEval=%s EndsAt=%s stale=%v img=%s cache=%v sent=%v\n",
				tag, name, tr.CacheID, tr.PreviousState, tr.State.State, tr.StateReason,
				hhmmss(tr.StartsAt), hhmmssP(tr.ResolvedAt), hhmmssP(tr.LastSentAt), hhmmss(tr.LastEvaluationTime), hhmmss(tr.EndsAt),
				tr.IsStale(), imgTok(tr.State), cachePresent(st, rule, name), fixInDispatched(dispatched, name))
		}
	}

	// ---- PHASE 1: FIRING (t0) — A,B,C all breach and fire Alerting.
	fmt.Printf("[COHESIVE] === PHASE 1: FIRING @ t0=%s (interval=60s, For=0) ===\n", hhmmss(clk.Now()))
	all := st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{
		fixResult(eval.Alerting, la, clk.Now()),
		fixResult(eval.Alerting, lb, clk.Now()),
		fixResult(eval.Alerting, lc, clk.Now()),
	}, nil, send)
	fmt.Printf("[COHESIVE] merged=%d dispatched=%d imgCount=%d\n", len(all), len(dispatched), imgs.count)
	dump("P1", all, "A", "B", "C")
	require.Len(t, all, 3)
	require.Len(t, dispatched, 3, "all 3 firing Alerting dispatched")

	// ---- PHASE 2: TEMPORARY ABSENCE (t0+60s = 1 interval) — C absent (SLOW), A,B present.
	clk.Add(60 * time.Second)
	fmt.Printf("[COHESIVE] === PHASE 2: C SLOW (absent 1 interval) @ %s ===\n", hhmmss(clk.Now()))
	all = st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{
		fixResult(eval.Alerting, la, clk.Now()),
		fixResult(eval.Alerting, lb, clk.Now()),
	}, nil, send)
	fmt.Printf("[COHESIVE] C cachePresent=%v (SLOW, offset=1 interval < 2*interval -> NOT stale)\n", cachePresent(st, rule, "C"))
	require.True(t, cachePresent(st, rule, "C"), "C absent only 1 interval survives (slow != stopped)")

	// ---- PHASE 3: C RETURNS (t0+120s) — proves slow != stale: a returning series is simply refreshed.
	clk.Add(60 * time.Second)
	fmt.Printf("[COHESIVE] === PHASE 3: C RETURNS @ %s ===\n", hhmmss(clk.Now()))
	all = st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{
		fixResult(eval.Alerting, la, clk.Now()),
		fixResult(eval.Alerting, lb, clk.Now()),
		fixResult(eval.Alerting, lc, clk.Now()),
	}, nil, send)
	dump("P3", all, "C")
	require.True(t, cachePresent(st, rule, "C"), "C returned -> refreshed and still cached")

	// ---- PHASE 4: A RECOVERS NATURALLY (t0+180s) — A metric drops below threshold -> Normal (natural
	// resolve, ResolvedAt set). B & C still present (this is B's LAST presence: B vanishes from here on).
	clk.Add(60 * time.Second)
	fmt.Printf("[COHESIVE] === PHASE 4: A NATURAL RESOLVE @ %s (B's last presence; C stays firing as control) ===\n", hhmmss(clk.Now()))
	all = st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{
		fixResult(eval.Normal, la, clk.Now()),
		fixResult(eval.Alerting, lb, clk.Now()),
		fixResult(eval.Alerting, lc, clk.Now()),
	}, nil, send)
	dump("P4", all, "A", "B")
	trA := fixFindTransition(all, "A")
	require.NotNil(t, trA.ResolvedAt, "A naturally resolved -> ResolvedAt set")
	require.Equal(t, "", trA.StateReason, "A natural resolve has NO MissingSeries reason")

	// ---- PHASE 5: BOUNDARY NOT YET CROSSED for B (t0+299s) — B last present at t0+180s, offset 119s<120s.
	clk.Add(119 * time.Second)
	fmt.Printf("[COHESIVE] === PHASE 5: BOUNDARY-1s for B @ %s (B offset=119s < 2*interval) ===\n", hhmmss(clk.Now()))
	all = st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{
		fixResult(eval.Normal, la, clk.Now()),
		fixResult(eval.Alerting, lc, clk.Now()),
	}, nil, send)
	fmt.Printf("[COHESIVE] B cachePresent=%v (still alive; boundary not crossed)\n", cachePresent(st, rule, "B"))
	require.True(t, cachePresent(st, rule, "B"), "B at 119s (<2*interval) not yet stale")

	// ---- PHASE 6: EXACT STALE BOUNDARY for B (t0+300s = B_lastEval+2*interval) — B swept.
	clk.Add(1 * time.Second)
	fmt.Printf("[COHESIVE] === PHASE 6: STALE SWEEP of B @ %s (B offset=120s == 2*interval) ===\n", hhmmss(clk.Now()))
	imgBefore := imgs.count
	all = st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{
		fixResult(eval.Normal, la, clk.Now()),
		fixResult(eval.Alerting, lc, clk.Now()),
	}, nil, send)
	dump("P6", all, "A", "B", "C")
	fmt.Printf("[COHESIVE] imgCount %d->%d (B stale image taken); B dispatched=%v\n", imgBefore, imgs.count, fixInDispatched(dispatched, "B"))
	trB := fixFindTransition(all, "B")
	require.Equal(t, eval.Normal, trB.State.State)
	require.Equal(t, models.StateReasonMissingSeries, trB.StateReason, "B swept -> Normal(MissingSeries)")
	require.NotNil(t, trB.ResolvedAt, "B (was Alerting) resolved on sweep")
	require.True(t, trB.IsStale(), "B IsStale() true")
	require.False(t, cachePresent(st, rule, "B"), "B evicted from cache")
	require.Equal(t, imgBefore+1, imgs.count, "B (oldState==Alerting) -> exactly one stale image")
	require.True(t, fixInDispatched(dispatched, "B"), "B resolved notification dispatched")
	// persistence effect (interface-level): DeleteAlertInstances recorded for the swept series.
	delCount := 0
	for _, op := range store.RecordedOps() {
		if o, ok := op.(state.FakeInstanceStoreOp); ok && o.Name == "DeleteAlertInstances" {
			delCount++
		}
	}
	fmt.Printf("[COHESIVE] store DeleteAlertInstances ops recorded so far = %d (>=1 for B)\n", delCount)
	require.GreaterOrEqual(t, delCount, 1, "stale B triggers a DeleteAlertInstances store op")

	// ---- PHASE 7: NATURAL-RESOLUTION RETENTION for A — A resolved at t0+180s; retention boundary =
	// 180s + 15m = 1080s. Re-send once just before, then observe equality (==15m still sends) and +1ns
	// (first suppression). C kept alive so it does not add stale noise.
	clk.Add(750 * time.Second) // t0+300s -> t0+1050s (A sinceResolved = 870s = 14.5m)
	fmt.Printf("[COHESIVE] === PHASE 7: A RETENTION @ %s (sinceResolved=14.5m, re-send) ===\n", hhmmss(clk.Now()))
	all = st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{
		fixResult(eval.Normal, la, clk.Now()),
		fixResult(eval.Alerting, lc, clk.Now()),
	}, nil, send)
	fmt.Printf("[COHESIVE] A sinceResolved=14.5m dispatched=%v (still within retention)\n", fixInDispatched(dispatched, "A"))
	require.True(t, fixInDispatched(dispatched, "A"), "A re-sent at 14.5m (< retention)")

	clk.Add(30 * time.Second) // -> t0+1080s (A sinceResolved = 900s = EXACTLY 15m)
	fmt.Printf("[COHESIVE] === PHASE 7b: A RETENTION EQUALITY @ %s (sinceResolved==15m) ===\n", hhmmss(clk.Now()))
	all = st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{
		fixResult(eval.Normal, la, clk.Now()),
		fixResult(eval.Alerting, lc, clk.Now()),
	}, nil, send)
	fmt.Printf("[COHESIVE] A sinceResolved==15m dispatched=%v (equality still SENDS; retention stop is strict >)\n", fixInDispatched(dispatched, "A"))
	require.True(t, fixInDispatched(dispatched, "A"), "A still sent at EXACTLY 15m (strict >)")

	clk.Add(1) // -> t0+1080s+1ns (A sinceResolved = 15m + 1ns)
	fmt.Printf("[COHESIVE] === PHASE 7c: A RETENTION +1ns @ %s (sinceResolved=15m+1ns) ===\n", hhmmss(clk.Now()))
	all = st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{
		fixResult(eval.Normal, la, clk.Now()),
		fixResult(eval.Alerting, lc, clk.Now()),
	}, nil, send)
	fmt.Printf("[COHESIVE] A sinceResolved=15m+1ns dispatched=%v (FIRST suppression: retention exceeded)\n", fixInDispatched(dispatched, "A"))
	require.False(t, fixInDispatched(dispatched, "A"), "A suppressed at 15m+1ns (retention exceeded)")

	// ---- PHASE 8: IDENTICAL-LABEL REAPPEARANCE of B — same labels {series:B} return; because B was
	// evicted, it is instantiated FRESH: same deterministic CacheID, reset StartsAt/ResolvedAt/reason.
	clk.Add(60 * time.Second) // -> t0+1140s+1ns
	fmt.Printf("[COHESIVE] === PHASE 8: B REAPPEARS (identical labels) @ %s ===\n", hhmmss(clk.Now()))
	all = st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{
		fixResult(eval.Normal, la, clk.Now()),
		fixResult(eval.Alerting, lb, clk.Now()), // B returns firing
		fixResult(eval.Alerting, lc, clk.Now()),
	}, nil, send)
	dump("P8", all, "B")
	trB2 := fixFindTransition(all, "B")
	require.Equal(t, trB.CacheID, trB2.CacheID, "reappearing B has the SAME deterministic CacheID (label fingerprint)")
	require.Equal(t, eval.Normal, trB2.PreviousState, "fresh instance: previous state is the zero/Normal baseline (not the old Normal(MissingSeries))")
	require.Equal(t, "", trB2.StateReason, "fresh instance: MissingSeries reason cleared")
	require.Equal(t, clk.Now().UTC(), trB2.StartsAt.UTC(), "fresh instance: StartsAt reset to reappearance time")
	fmt.Printf("[COHESIVE] B reappears: sameCacheID=%v newStartsAt=%s reason=%q (fresh identity, not the evicted one)\n",
		trB.CacheID == trB2.CacheID, hhmmss(trB2.StartsAt), trB2.StateReason)
}

// ============================================================================================
// Issue 4 (focused) — Q1 disappeared-series FULL field trace. 3 series fire; then B & C vanish while
// A keeps firing. Prints every lifecycle field for A (survivor), B and C (disappeared): prev/new
// state, reason, StartsAt, ResolvedAt (before/after), LastSentAt (before/after), LastEval, EndsAt,
// stale marker, cache presence (before/after), image token, dispatched.
// ============================================================================================
func TestBlitzyFixQ1DisappearedFields(t *testing.T) {
	ctx := context.Background()
	clk := clock.NewMock()
	rule := fixRule(0, 60*time.Second)
	imgs := &fixCountingImage{}
	st := fixManager(clk, imgs, &state.FakeInstanceStore{})
	la, lb, lc := data.Labels{"series": "A"}, data.Labels{"series": "B"}, data.Labels{"series": "C"}
	var dispatched state.StateTransitions
	send := func(_ context.Context, ss state.StateTransitions) { dispatched = ss }

	// t0: all three fire.
	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{
		fixResult(eval.Alerting, la, clk.Now()),
		fixResult(eval.Alerting, lb, clk.Now()),
		fixResult(eval.Alerting, lc, clk.Now()),
	}, nil, send)
	fmt.Printf("[Q1-fields] BEFORE (t0, all firing):\n")
	before := st.GetStatesForRuleUID(rule.OrgID, rule.UID)
	sort.Slice(before, func(i, j int) bool { return before[i].Labels["series"] < before[j].Labels["series"] })
	for _, s := range before {
		fmt.Printf("    series=%s CacheID=%s State=%s reason=%q StartsAt=%s ResolvedAt=%s LastSentAt=%s LastEval=%s EndsAt=%s img=%s\n",
			s.Labels["series"], s.CacheID, s.State, s.StateReason, hhmmss(s.StartsAt), hhmmssP(s.ResolvedAt), hhmmssP(s.LastSentAt), hhmmss(s.LastEvaluationTime), hhmmss(s.EndsAt), imgTok(s))
	}

	// t0+120s: only A present; B & C disappear (>=2*interval).
	clk.Add(120 * time.Second)
	imgBefore := imgs.count
	all := st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{
		fixResult(eval.Alerting, la, clk.Now()),
	}, nil, send)
	sort.Slice(all, func(i, j int) bool { return all[i].Labels["series"] < all[j].Labels["series"] })
	fmt.Printf("[Q1-fields] AFTER (t0+2*interval, B & C vanished; A keeps firing): imgCount %d->%d\n", imgBefore, imgs.count)
	for _, name := range []string{"A", "B", "C"} {
		tr := fixFindTransition(all, name)
		fmt.Printf("    series=%s CacheID=%s prev=%s->new=%s reason=%q StartsAt=%s ResolvedAt=%s LastSentAt=%s LastEval=%s EndsAt=%s stale=%v cachePresent=%v img=%s dispatched=%v\n",
			name, tr.CacheID, tr.PreviousState, tr.State.State, tr.StateReason,
			hhmmss(tr.StartsAt), hhmmssP(tr.ResolvedAt), hhmmssP(tr.LastSentAt), hhmmss(tr.LastEvaluationTime), hhmmss(tr.EndsAt),
			tr.IsStale(), cachePresent(st, rule, name), imgTok(tr.State), fixInDispatched(dispatched, name))
	}
	// A survivor unchanged-ish; B,C swept.
	require.True(t, cachePresent(st, rule, "A"))
	require.False(t, cachePresent(st, rule, "B"))
	require.False(t, cachePresent(st, rule, "C"))
	for _, name := range []string{"B", "C"} {
		tr := fixFindTransition(all, name)
		require.Equal(t, models.StateReasonMissingSeries, tr.StateReason)
		require.NotNil(t, tr.ResolvedAt)
		require.True(t, tr.IsStale())
	}
}

// ============================================================================================
// Issue 2 — downstream sender & image/reason mapping. Drives a stale-resolved Alerting series through
// ProcessEvalResults, then maps the dispatched StateTransition through the REAL wire-encoders:
//   state.StateToPostableAlert (compat.go:35-57)  -> shows __alertImageToken__ + grafana_state_reason
//   state.FromAlertsStateToStoppedAlert (compat.go:143-154) -> the expireAndSend path (EndsAt=now,
//   PreviousState Normal/Pending skipped) used by alertRule.expireAndSend (schedule/alert_rule.go:476-479).
// ============================================================================================
func TestBlitzyFixSenderMapping(t *testing.T) {
	ctx := context.Background()
	appURL, _ := url.Parse("http://localhost:3000")
	clk := clock.NewMock()
	rule := fixRule(0, 60*time.Second)
	imgs := &fixCountingImage{}
	st := fixManager(clk, imgs, &state.FakeInstanceStore{})
	la := data.Labels{"series": "A"}

	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{fixResult(eval.Alerting, la, clk.Now())}, nil, state.NoopSender)
	clk.Add(120 * time.Second)
	all := st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{}, nil, state.NoopSender)
	tr := fixFindTransition(all, "A")
	require.NotNil(t, tr, "stale-resolved transition for A")
	require.Equal(t, models.StateReasonMissingSeries, tr.StateReason)
	require.NotNil(t, tr.State.Image, "stale (was Alerting) attached an image")

	// --- normal send mapping (StateToPostableAlert) ---
	pa := state.StateToPostableAlert(*tr, appURL)
	fmt.Printf("[Q4Q6-map] StateToPostableAlert(stale-resolved A):\n")
	fmt.Printf("    labels=%v\n", pa.Labels)
	fmt.Printf("    annotation[__alertImageToken__]=%q\n", pa.Annotations["__alertImageToken__"])
	fmt.Printf("    annotation[grafana_state_reason]=%q\n", pa.Annotations["grafana_state_reason"])
	fmt.Printf("    StartsAt=%v EndsAt=%v generatorURL=%q\n", pa.StartsAt, pa.EndsAt, pa.GeneratorURL)
	require.Equal(t, tr.State.Image.Token, pa.Annotations["__alertImageToken__"], "image token surfaced to Alertmanager annotation")
	require.Equal(t, "MissingSeries", pa.Annotations["grafana_state_reason"], "state reason surfaced as grafana_state_reason")

	// --- expireAndSend mapping (FromAlertsStateToStoppedAlert): was-Alerting is expired; Normal/Pending skipped ---
	stopped := state.FromAlertsStateToStoppedAlert([]state.StateTransition{*tr}, appURL, clk)
	fmt.Printf("[Q4Q6-map] FromAlertsStateToStoppedAlert(was-Alerting stale): produced %d stopped alert(s); EndsAt=%v\n",
		len(stopped.PostableAlerts), func() interface{} {
			if len(stopped.PostableAlerts) == 1 {
				return stopped.PostableAlerts[0].EndsAt
			}
			return "-"
		}())
	require.Len(t, stopped.PostableAlerts, 1, "was-Alerting stale transition IS expired (PreviousState==Alerting)")

	// control: a Normal->Normal (never-fired) transition is SKIPPED by the expireAndSend mapping.
	clk2 := clock.NewMock()
	rule2 := fixRule(0, 60*time.Second)
	st2 := fixManager(clk2, &state.NoopImageService{}, &state.FakeInstanceStore{})
	st2.ProcessEvalResults(ctx, clk2.Now(), rule2, eval.Results{fixResult(eval.Normal, la, clk2.Now())}, nil, state.NoopSender)
	clk2.Add(120 * time.Second)
	all2 := st2.ProcessEvalResults(ctx, clk2.Now(), rule2, eval.Results{}, nil, state.NoopSender)
	trN := fixFindTransition(all2, "A")
	stoppedN := state.FromAlertsStateToStoppedAlert([]state.StateTransition{*trN}, appURL, clk2)
	fmt.Printf("[Q4Q6-map] FromAlertsStateToStoppedAlert(never-fired Normal stale): produced %d stopped alert(s) (PreviousState==Normal skipped)\n",
		len(stoppedN.PostableAlerts))
	require.Len(t, stoppedN.PostableAlerts, 0, "never-fired Normal stale transition is NOT expired")
}

// ============================================================================================
// Issue 3 — CONCRETE database effect using the REAL sqlite DBstore (tests.SetupTestEnv) wired to the
// REAL SyncStatePersister. A firing instance is persisted (row present via dbstore.ListAlertInstances),
// then the series vanishes and the stale sweep DELETES the row (row absent). This upgrades the DB
// claim from interface-level [OBSERVED] to concrete-row [OBSERVED].
// ============================================================================================
func TestBlitzyFixConcreteDBReadback(t *testing.T) {
	ctx := context.Background()
	_, dbstore := tests.SetupTestEnv(t, 1)
	const orgID int64 = 1
	rule := tests.CreateTestAlertRule(t, ctx, dbstore, 60, orgID)
	q := &models.ListAlertInstancesQuery{RuleUID: rule.UID, RuleOrgID: orgID}

	clk := clock.NewMock()
	cfg := fixCfg(clk, &state.NoopImageService{}, dbstore)
	mgr := state.NewManager(cfg, state.NewSyncStatePersisiter(log.New("ngalert.state.persister"), cfg))
	la := data.Labels{"series": "A"}

	// fire -> persisted
	mgr.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{fixResult(eval.Alerting, la, clk.Now())}, nil, state.NoopSender)
	before, err := dbstore.ListAlertInstances(ctx, q)
	require.NoError(t, err)
	fmt.Printf("[Q1Q8-db] AFTER firing eval: dbstore.ListAlertInstances rows=%d\n", len(before))
	for _, inst := range before {
		fmt.Printf("    row: state=%s reason=%q labels=%v\n", inst.CurrentState, inst.CurrentReason, inst.Labels)
	}
	require.Len(t, before, 1, "firing instance persisted as a concrete DB row")

	// vanish -> stale sweep -> DeleteAlertInstances on the real DB
	clk.Add(120 * time.Second)
	mgr.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{}, nil, state.NoopSender)
	after, err := dbstore.ListAlertInstances(ctx, q)
	require.NoError(t, err)
	fmt.Printf("[Q1Q8-db] AFTER stale sweep: dbstore.ListAlertInstances rows=%d (concrete row deleted)\n", len(after))
	require.Len(t, after, 0, "stale sweep deletes the concrete DB row (not merely a recorded interface op)")
}

// ============================================================================================
// Issue 5 (post-Alerting nonzero-for) — a rule with For=5m: the series climbs Pending->Alerting over
// the pending period, then VANISHES. The stale sweep resolves it (prev=Alerting) WITHOUT honoring any
// `for` wait on the way out. interval=60s.
// ============================================================================================
func TestBlitzyFixPostAlertingForVanish(t *testing.T) {
	ctx := context.Background()
	clk := clock.NewMock()
	rule := fixRule(5*time.Minute, 60*time.Second) // For=5m
	imgs := &fixCountingImage{}
	st := fixManager(clk, imgs, &state.FakeInstanceStore{})
	la := data.Labels{"series": "A"}
	var dispatched state.StateTransitions
	send := func(_ context.Context, ss state.StateTransitions) { dispatched = ss }

	// Feed Alerting every 60s; watch Pending -> Alerting when elapsed >= For(5m) at t0+300s.
	t0 := clk.Now()
	var reached time.Time
	for i := 0; i <= 5; i++ {
		at := clk.Now()
		all := st.ProcessEvalResults(ctx, at, rule, eval.Results{fixResult(eval.Alerting, la, at)}, nil, send)
		tr := fixFindTransition(all, "A")
		fmt.Printf("[Q7-for] t0+%3.0fs elapsed=%4.1fm state=%s reason=%q\n",
			at.Sub(t0).Seconds(), at.Sub(t0).Minutes(), tr.State.State, tr.StateReason)
		if tr.State.State == eval.Alerting && reached.IsZero() {
			reached = at
		}
		clk.Add(60 * time.Second)
	}
	require.False(t, reached.IsZero(), "series reached Alerting after the pending period")
	fmt.Printf("[Q7-for] reached Alerting at t0+%.0fs (== For=5m)\n", reached.Sub(t0).Seconds())

	// Now vanish. Last present at t0+300s; detected stale at t0+300s+120s = t0+420s.
	// The loop above advanced the clock to t0+360s; add 60s to reach t0+420s.
	clk.Add(60 * time.Second)
	imgBefore := imgs.count
	at := clk.Now()
	all := st.ProcessEvalResults(ctx, at, rule, eval.Results{}, nil, send)
	tr := fixFindTransition(all, "A")
	fmt.Printf("[Q7-for] VANISH @ t0+%.0fs: prev=%s->new=%s reason=%q resolved=%v sent=%v imgCount %d->%d cachePresent=%v\n",
		at.Sub(t0).Seconds(), tr.PreviousState, tr.State.State, tr.StateReason,
		tr.ResolvedAt != nil, fixInDispatched(dispatched, "A"), imgBefore, imgs.count, cachePresent(st, rule, "A"))
	require.Equal(t, eval.Alerting, tr.PreviousState, "vanished while Alerting (pending period already satisfied)")
	require.Equal(t, eval.Normal, tr.State.State)
	require.Equal(t, models.StateReasonMissingSeries, tr.StateReason)
	require.NotNil(t, tr.ResolvedAt, "resolved immediately on sweep; the `for` period is NOT re-applied on the way out")
	require.Equal(t, imgBefore+1, imgs.count, "one stale image (was Alerting)")
	require.True(t, fixInDispatched(dispatched, "A"))
	require.False(t, cachePresent(st, rule, "A"))
}

// ============================================================================================
// Issue 6 — a PREVIOUSLY-RESOLVED Normal series that later goes stale DOES send a (final) resolved
// notification, subject to the resend/retention gates — contradicting a diagram branch that implied
// "old-Normal stale => nothing sent". Canonical: series fires, recovers to Normal (resolved+sent),
// then vanishes within retention & past resend -> the stale transition is dispatched (sent=1), then
// evicted. Plus predicate-level 0/1/0 across <resend / ==resend / >retention.
// ============================================================================================
func TestBlitzyFixOldNormalStaleSend(t *testing.T) {
	ctx := context.Background()
	clk := clock.NewMock()
	rule := fixRule(0, 60*time.Second)
	imgs := &fixCountingImage{}
	st := fixManager(clk, imgs, &state.FakeInstanceStore{})
	la := data.Labels{"series": "A"}
	var dispatched state.StateTransitions
	send := func(_ context.Context, ss state.StateTransitions) { dispatched = ss }

	// t0: fire Alerting.
	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{fixResult(eval.Alerting, la, clk.Now())}, nil, send)
	// t0+60s: recover to Normal (natural resolve -> ResolvedAt=60s, dispatched, LastSentAt=60s).
	clk.Add(60 * time.Second)
	allR := st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{fixResult(eval.Normal, la, clk.Now())}, nil, send)
	trR := fixFindTransition(allR, "A")
	fmt.Printf("[Q6-oldnormal] t0+60s NATURAL RESOLVE: state=%s reason=%q ResolvedAt=%s LastSentAt=%s dispatched=%v\n",
		trR.State.State, trR.StateReason, hhmmssP(trR.ResolvedAt), hhmmssP(trR.LastSentAt), fixInDispatched(dispatched, "A"))
	require.NotNil(t, trR.ResolvedAt)
	// t0+120s: still Normal & present -> cadence re-send (LastSentAt -> 120s).
	clk.Add(60 * time.Second)
	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{fixResult(eval.Normal, la, clk.Now())}, nil, send)
	// t0+240s: VANISH. Last present t0+120s; detected stale at t0+120s+120s = t0+240s. Retained
	// ResolvedAt=60s (sinceResolved=180s=3m < 15m). cadence: LastSentAt(120s)+30s <= 240s -> due.
	clk.Add(120 * time.Second)
	allS := st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{}, nil, send)
	trS := fixFindTransition(allS, "A")
	fmt.Printf("[Q6-oldnormal] t0+240s STALE (was previously-resolved Normal): prev=%s->new=%s reason=%q ResolvedAt=%s LastSentAt=%s dispatched=%v cachePresent=%v\n",
		trS.PreviousState, trS.State.State, trS.StateReason, hhmmssP(trS.ResolvedAt), hhmmssP(trS.LastSentAt),
		fixInDispatched(dispatched, "A"), cachePresent(st, rule, "A"))
	require.Equal(t, eval.Normal, trS.PreviousState, "previously Normal (already resolved)")
	require.Equal(t, models.StateReasonMissingSeries, trS.StateReason)
	require.True(t, fixInDispatched(dispatched, "A"), "old-Normal stale STILL sends a final resolved notification (within retention, past resend)")
	require.False(t, cachePresent(st, rule, "A"), "then evicted")

	// predicate-level distribution: <resend -> 0, ==resend -> 1, >retention -> 0 (all then evicted).
	fmt.Printf("[Q6-oldnormal] predicate sweep of the stale-send gate NeedsSending(30s,15m):\n")
	base := time.Unix(0, 0).UTC()
	type c struct {
		name   string
		sent   *time.Time
		res    *time.Time
		eval   time.Time
		expect bool
	}
	p := func(d time.Duration) *time.Time { x := base.Add(d); return &x }
	for _, cse := range []c{
		{"<resend (20s since last send)", p(0), p(0), base.Add(20 * time.Second), false},
		{"==resend (30s since last send)", p(0), p(0), base.Add(30 * time.Second), true},
		{">retention (16m since resolved)", p(0), p(0), base.Add(16 * time.Minute), false},
	} {
		s := &state.State{State: eval.Normal, StateReason: models.StateReasonMissingSeries, ResolvedAt: cse.res, LastSentAt: cse.sent, LastEvaluationTime: cse.eval}
		got := s.NeedsSending(30*time.Second, 15*time.Minute)
		out := 0
		if got {
			out = 1
		}
		fmt.Printf("    %-34s -> NeedsSending=%v -> %d\n", cse.name, got, out)
		require.Equal(t, cse.expect, got, cse.name)
	}
}

// ============================================================================================
// Issue 7 — image fake now CAPTURES and ASSERTS the *models.AlertRule argument. Both the natural
// resolution (series A recovers) and the stale resolution (series B vanishes) call NewImage with the
// SAME rule pointer and identity (UID/dashboard/panel). interval=60s; rule has a dashboard+panel.
// ============================================================================================
func TestBlitzyFixImageRuleArgument(t *testing.T) {
	ctx := context.Background()
	clk := clock.NewMock()
	gen := models.RuleGen
	dash := "dash-blitzy-uid"
	var panel int64 = 42
	rule := gen.With(
		gen.WithFor(0),
		gen.WithInterval(60*time.Second),
		gen.WithLabels(data.Labels{}),
		gen.WithDashboardAndPanel(&dash, &panel),
	).GenerateRef()
	rule.UID = "blitzy-rule-uid" // pin for deterministic, byte-reproducible output (UID is otherwise random)
	rec := &fixRecordingImage{}
	st := fixManager(clk, rec, &state.FakeInstanceStore{})
	la, lb := data.Labels{"series": "A"}, data.Labels{"series": "B"}

	// t0: A,B fire Alerting (each entering Alerting takes an image).
	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{
		fixResult(eval.Alerting, la, clk.Now()),
		fixResult(eval.Alerting, lb, clk.Now()),
	}, nil, state.NoopSender)
	nEnter := rec.count
	fmt.Printf("[Q6-imgarg] entering-Alerting image calls=%d\n", nEnter)

	// t0+60s: A recovers to Normal (natural resolution image); B still present.
	clk.Add(60 * time.Second)
	beforeNat := rec.count
	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{
		fixResult(eval.Normal, la, clk.Now()),
		fixResult(eval.Alerting, lb, clk.Now()),
	}, nil, state.NoopSender)
	require.Equal(t, beforeNat+1, rec.count, "A natural resolution took exactly one image")
	natCall := rec.calls[len(rec.calls)-1]
	fmt.Printf("[Q6-imgarg] NATURAL resolution (A) NewImage rule: uid=%s dashboard=%s panel=%s pointer==rule:%v\n",
		natCall.uid, natCall.dash, natCall.panel, natCall.rule == rule)

	// t0+60s+120s = t0+180s: B vanishes; detected stale (was Alerting) -> stale resolution image.
	clk.Add(120 * time.Second)
	beforeStale := rec.count
	st.ProcessEvalResults(ctx, clk.Now(), rule, eval.Results{
		fixResult(eval.Normal, la, clk.Now()),
	}, nil, state.NoopSender)
	require.Equal(t, beforeStale+1, rec.count, "B stale resolution took exactly one image")
	staleCall := rec.calls[len(rec.calls)-1]
	fmt.Printf("[Q6-imgarg] STALE resolution   (B) NewImage rule: uid=%s dashboard=%s panel=%s pointer==rule:%v\n",
		staleCall.uid, staleCall.dash, staleCall.panel, staleCall.rule == rule)

	// Both paths received the SAME rule object (identity + pointer).
	require.Equal(t, rule.UID, natCall.uid)
	require.Equal(t, rule.UID, staleCall.uid)
	require.Equal(t, dash, natCall.dash)
	require.Equal(t, dash, staleCall.dash)
	require.Equal(t, "42", natCall.panel)
	require.Equal(t, "42", staleCall.panel)
	require.True(t, natCall.rule == rule, "natural path received the same *AlertRule pointer")
	require.True(t, staleCall.rule == rule, "stale path received the same *AlertRule pointer")
	require.True(t, natCall.rule == staleCall.rule, "natural and stale image calls share the identical rule pointer")
}
```
