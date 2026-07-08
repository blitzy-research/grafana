# Stale‑Series Detection & Resolution in Grafana Unified Alerting — An Evidence‑Backed Investigation

> **Scope of this document.** This is a **read‑only investigation**. It answers eight specific questions (Q1–Q8) about how Grafana's unified‑alerting subsystem (`pkg/services/ngalert/`) detects and resolves **stale series** — the machinery behind the real‑world symptom in which an alert appears to *"linger"* after the time series it fired on disappears. Every factual claim is grounded in a specific `file:line` reference **and** in the **real, unedited runtime output** of the code path, captured by driving the genuine entry point `Manager.ProcessEvalResults` before a single word of the answers was written.

---

## 0. Context, commit, and the "lingering alert" problem

**What "stale series" / "lingering alert" means.** An alert rule can fire on *many* time series at once (one alert instance per label set). When some of those series simply **stop being returned** by the datasource (the metric disappears — a pod is deleted, a target goes away), the corresponding alert *instances* have no fresh evaluation result. Grafana must decide: is that series merely **slow** this cycle, or has it **stopped**? If stopped, the instance is declared **stale**, resolved with reason `MissingSeries`, and its resolved notification is sent downstream. If that resolution or its follow‑up notifications behave unexpectedly, operators perceive the alert as "lingering."

**Commit / branch / toolchain under investigation** (verified live):

| Fact | Value | How verified |
|---|---|---|
| Branch (destination checkout) | `blitzy-782c3615-9850-4f68-bace-4e7e589b5510` | `git rev-parse --abbrev-ref HEAD` |
| Source branch (⇒ file name) | `grafana_4550cfb5b728` | given; ⇒ this file is `blitzy/documentation/grafana_4550cfb5b728.md` |
| HEAD commit | `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` | `git rev-parse HEAD` |
| Go toolchain | `go1.23.1 linux/amd64` | `go version` (canonical, from `go.mod`) |
| Module mode | Go **workspace** (`go.work`), module‑mode (not vendored) | `head go.work` |

**Exact build & invocation commands used** (canonical, default configuration — the package altitude a normal contributor uses for this subsystem):

```
$ go version
go version go1.23.1 linux/amd64

$ go build ./pkg/services/ngalert/state/
exit=0 (SUCCESS)
```

> Workspace note: do **not** set `GOFLAGS=-mod=mod` (it errors under workspace mode). Plain `go build`/`go test` is the canonical vehicle. No external infrastructure (DB/services) is needed — the state‑machine path runs entirely on in‑memory collaborators plus a **mockable clock**.

**Methodology — RUN FIRST, THEN WRITE.** The behavior was reached through its **real entry point** `Manager.ProcessEvalResults` [pkg/services/ngalert/state/manager.go:307] with genuine collaborators (in‑memory cache, `NoopPersister`, `FakeHistorian`, an `ImageCapturer`, and a real `Sender` callback), driven across successive evaluation ticks with a `clock.NewMock()` so the 2×interval, 30s, and 15m boundaries are hit deterministically. Two temporary harness files were used and **removed afterward** (see §12): `pkg/services/ngalert/state/blitzy_adhoc_test_stale_test.go` (package `state`, so private helpers are reachable) and `pkg/setting/blitzy_adhoc_test_retention_test.go` (canonical config‑default parse). The harness fixes `interval = 10s`, so the staleness window `2×interval = 20s`, and `ResolvedRetention = 15m` (the wired default). Values labeled **non‑canonical** were obtained by calling a private helper (`stateIsStale`, `NeedsSending`) in isolation; the **canonical** value in each case is the one produced by driving `ProcessEvalResults`.

**Reproducing the smoke tests (existing tests, real path):**

```
$ go test ./pkg/services/ngalert/state/ -run 'TestStateIsStale|TestStaleResults$|TestStaleResultsHandler' -v
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
=== RUN   TestStaleResultsHandler
    util.go:158: alert definition: {orgID: 1, UID: bfrgfr3ty8x6rf} with title: "an alert definition ffrgfr3ty8x6qd" interval: 60 folder: namespace created
--- PASS: TestStaleResultsHandler (0.27s)
=== RUN   TestStaleResults
=== RUN   TestStaleResults/should_mark_missing_states_as_stale
=== RUN   TestStaleResults/should_remove_stale_states_from_cache
=== RUN   TestStaleResults/should_delete_stale_states_from_the_database
--- PASS: TestStaleResults (0.00s)
    --- PASS: TestStaleResults/should_mark_missing_states_as_stale (0.00s)
    --- PASS: TestStaleResults/should_remove_stale_states_from_cache (0.00s)
    --- PASS: TestStaleResults/should_delete_stale_states_from_the_database (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.314s
```

### 0.1 Citation drift note (re‑derived from the running tree)

The line numbers below were **re‑derived at commit `4550cfb`** and differ slightly from the numbers passed in during scoping. In particular the body of `deleteStaleStatesFromCache` sits ~3 lines earlier than originally cited: `s.State = eval.Normal` is at **manager.go:599** (not :602), the `if oldState == eval.Alerting` guard at **:604** (not :607), and the `func` declaration itself at **:586** (there is *no* doc comment above it; the "share the resolved image" comment is *inside* the body at :587–588). The `updateLastSentAt` **call** is at **:340**. All citations in this document use the re‑derived values.

### 0.2 Two run‑first corrections to the naive model (both proven below)

Running the real path surfaced two facts that a read‑only skim would get wrong; both are documented honestly with evidence:

1. **A vanished (stale) series is a ONE‑SHOT resolved notification, not a 15‑minute resend.** `deleteStaleStatesFromCache` **evicts** the instance from the in‑memory cache at the moment it goes stale (§Q1/§Q8). It is therefore sent exactly **once** (the tick it crosses the boundary) and then it is gone. The **30s‑resend‑for‑15m** retention behavior belongs to the **natural‑resolution** path — a series that stays present and reports `Normal`, remaining in the cache (§Q4/§Q5). This document proves *both* behaviors and is careful to attribute each to the correct path.
2. **The stale path takes one screenshot PER alerting stale series, not a single shared image** at the `ImageCapturer` layer (§Q6). Both paths call the *same* `takeImage` function, but the stale loop calls it once for each `Alerting` series it resolves.

---

## Q1 — What happens to the alert *states* of series that vanish while others keep firing?

**Direct answer.** Each vanished series is reclassified by **`deleteStaleStatesFromCache`** [pkg/services/ngalert/state/manager.go:586] to `State = eval.Normal` [manager.go:599] with `StateReason = MissingSeries` [manager.go:600] (`StateReasonMissingSeries = "MissingSeries"` [pkg/services/ngalert/models/alert_rule.go:160]), and its `EndsAt` and `LastEvaluationTime` are both stamped to the evaluation time [manager.go:601–602]. **Only if the series was `Alerting`** does the code additionally set `ResolvedAt = evaluatedAt` and capture an image, under the `if oldState == eval.Alerting` guard [manager.go:604–606]. Series that are **still present keep firing and are untouched**. Each stale transition is appended to `allChanges` [manager.go:334] and flows to the notifier as a resolved alert; the stale state is then **evicted** from the cache map.

**Mechanism (cause → effect).** `ProcessEvalResults` [manager.go:307] first calls `setNextStateForRule` [manager.go:326] to advance the series that *are* present, then calls `deleteStaleStatesFromCache` [manager.go:328]. The latter asks the cache to delete every state whose `stateIsStale(evaluatedAt, s.LastEvaluationTime, IntervalSeconds)` is true [manager.go:590], and for each returned (evicted) state it performs the Normal/MissingSeries relabeling. Because the reclassification writes `eval.Normal` **directly**, the survivor's independent state object is never involved — its firing state simply carries forward unchanged.

**Command & full unedited output.**

```
$ go test ./pkg/services/ngalert/state/ -run '^TestBlitzyQ1$' -v -count=1
=== RUN   TestBlitzyQ1
===== Q1 ===== interval=10s  2xinterval(staleness window)=20s
[BEFORE t1=10s] both series present & Alerting:
   A: State=Alerting Reason=""            StartsAt=10s   EndsAt=130s   ResolvedAt=<nil>  LastSentAt=10s    LastEval=10s    CacheID=4346866639676213545 image=present(tok=7103200163914009766)
   B: State=Alerting Reason=""            StartsAt=10s   EndsAt=130s   ResolvedAt=<nil>  LastSentAt=10s    LastEval=10s    CacheID=4346865540164585692 image=present(tok=4765013811919170662)
   transitions=2 sent=2 imageCalls=2
[DURING t2=20s] B dropped (gap=1 interval, still within 2x grace):
   A: State=Alerting Reason=""            StartsAt=10s   EndsAt=140s   ResolvedAt=<nil>  LastSentAt=10s    LastEval=20s    CacheID=4346866639676213545 image=present(tok=7103200163914009766)
   B: State=Alerting Reason=""            StartsAt=10s   EndsAt=130s   ResolvedAt=<nil>  LastSentAt=10s    LastEval=10s    CacheID=4346865540164585692 image=present(tok=4765013811919170662)
   transitions=1 sent=0 imageCalls=2
[AFTER t3=30s] B absent 2 intervals (evaluatedAt=30s >= lastEval(10s)+2x(20s)=30s) => STALE:
   A: State=Alerting Reason=""            StartsAt=10s   EndsAt=150s   ResolvedAt=<nil>  LastSentAt=10s    LastEval=30s    CacheID=4346866639676213545 image=present(tok=7103200163914009766)
   B: <absent from cache>
   B transition: Alerting->Normal reason="MissingSeries" ResolvedAt=30s image=present(tok=5291348696210819831)
   transitions=2 sent=1 imageCalls=3 (B's stale resolution took 1 image because it was Alerting)
--- PASS: TestBlitzyQ1 (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.047s
```

> The `image=present(tok=…)` token strings are produced by the test's `CountingImageService` (a `rand.Int()` token) and therefore differ run‑to‑run; the **behavioral** facts (image present / `imageCalls` counts / states / CacheIDs) are stable. Survivor **A** keeps a stable `CacheID=4346866639676213545` throughout; only its `LastEval`/`EndsAt` advance because it is re‑evaluated each tick.

**Before / during / after — vanished series B (the one that disappears):**

| Field | BEFORE (t1, present) | DURING (t2, absent 1 cycle) | AFTER (t3, stale) |
|---|---|---|---|
| `State` | `Alerting` | `Alerting` (frozen in cache) | `Normal` |
| `StateReason` | `""` | `""` | `"MissingSeries"` |
| `StartsAt` | 10s | 10s | (state evicted) |
| `EndsAt` | 130s | 130s (not refreshed) | `30s` (= evaluatedAt) |
| `ResolvedAt` | `<nil>` | `<nil>` | `30s` (was `Alerting`) |
| `LastEvaluationTime` | 10s | 10s (frozen) | `30s` |
| image taken? | on entry only | no | **yes** (1 image) |
| in `allChanges` / sent? | firing txn (sent) | no txn / not sent | **resolved txn, sent once** |
| present in cache? | yes | yes | **no — evicted** |

Survivor **A** across the same ticks stays `Alerting`, `StateReason=""`, `ResolvedAt=<nil>`, with `LastEval` advancing 10s → 20s → 30s — i.e. **entirely unaffected** by B's disappearance.

---

## Q2 — How does the scheduler distinguish a series that has *stopped* from one that is merely *slow*?

**Direct answer.** The distinction is made purely by **`LastEvaluationTime`** freshness measured against the **2×interval grace window**. On each tick, `setNextStateForRule` refreshes `LastEvaluationTime` **only for the series that are present** in that tick's `eval.Results`; an **absent** series keeps its *old* `LastEvaluationTime` frozen. A series that misses a **single** cycle is treated as merely **slow** and is tolerated, because `stateIsStale` only fires once `evaluatedAt >= lastEval + 2×IntervalSeconds` [pkg/services/ngalert/state/manager.go:627–628]. A series that misses **two** cycles crosses that window and is declared **stopped** → stale → evicted. So: *"slow" = one missed tick still inside the 2×interval window; "stopped" = the window has been crossed.* The per‑rule tick that drives this in production is `ProcessEvalResults` at [pkg/services/ngalert/schedule/alert_rule.go:441].

**Mechanism (cause → effect).** There is no separate "is it slow?" flag. The only signal is the timestamp gap. Because an absent series' `LastEvaluationTime` is *not* advanced, its gap to `evaluatedAt` grows by one interval per missed tick; the moment that gap reaches `2×interval`, `deleteStaleStatesFromCache` reclassifies and evicts it. A returning series has its `LastEvaluationTime` refreshed on the tick it reappears (evaluated *before* the staleness sweep in the same `ProcessEvalResults` call), so it can never be marked stale on a tick in which it is present.

**Command & full unedited output.**

```
$ go test ./pkg/services/ngalert/state/ -run '^TestBlitzyQ2$' -v -count=1
=== RUN   TestBlitzyQ2
===== Q2 ===== interval=10s  staleness window=2x=20s
   [t1=10s] both present
      A(present): LastEval=10s State=Alerting
      B         : LastEval=10s State=Alerting
   [t2=20s] B missing 1 cycle (SLOW: B.LastEval frozen at 10s, A advances to 20s; gap<2x => NOT stale)
      A(present): LastEval=20s State=Alerting
      B         : LastEval=10s State=Alerting
   [t3=30s] B returned => confirmed merely SLOW; B.LastEval refreshes to 30s, survives
      A(present): LastEval=30s State=Alerting
      B         : LastEval=30s State=Alerting
   [t4=40s] B missing again 1 cycle (gap=10s<2x => still NOT stale)
      A(present): LastEval=40s State=Alerting
      B         : LastEval=30s State=Alerting
   [t5=50s] B missing 2 cycles (evaluatedAt=50s >= lastEval(30s)+20s=50s) => STOPPED => stale+evicted
      A(present): LastEval=50s State=Alerting
      B         : <evicted from cache>
--- PASS: TestBlitzyQ2 (0.01s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.046s
```

**Before / during / after — the "slow" vs "stopped" transition for series B:**

| Tick | Present? | A `LastEval` (control) | B `LastEval` | B verdict |
|---|---|---|---|---|
| t1 (10s) | both | 10s | 10s | firing |
| t2 (20s) | A only | 20s | **10s (frozen)** | **slow** — gap=10s < 20s, tolerated |
| t3 (30s) | both | 30s | **30s (refreshed)** | recovered — was merely slow |
| t4 (40s) | A only | 40s | **30s (frozen)** | slow again — gap=10s < 20s |
| t5 (50s) | A only | 50s | — (evicted) | **stopped** — gap=20s ⇒ stale |

The control series **A** advances its `LastEval` every tick (present each time) and never goes stale, isolating the timestamp‑freshness mechanism.

---

## Q3 — When is the staleness boundary crossed, and what formula defines the cutoff?

**Direct answer.** The cutoff is computed by **`stateIsStale`** [pkg/services/ngalert/state/manager.go:627–628]:

```go
func stateIsStale(evaluatedAt time.Time, lastEval time.Time, intervalSeconds int64) bool {
	return !lastEval.Add(2 * time.Duration(intervalSeconds) * time.Second).After(evaluatedAt)
}
```

A series becomes stale **exactly when `evaluatedAt >= lastEval + 2×IntervalSeconds`**, and the boundary is **inclusive** (equality counts as stale, because the code negates `.After`, and `x.After(x)` is `false`). The `2×` factor is **hardcoded** at this commit (see §10, Caveat 1). This helper is invoked from inside `deleteStaleStatesFromCache` [manager.go:590] as the eviction predicate.

**Mechanism (cause → effect).** `lastEval.Add(2×interval)` is the deadline. `.After(evaluatedAt)` is true while the deadline is *strictly later* than the current evaluation time (⇒ not yet stale). Negating it means the instant `evaluatedAt` catches up to (or passes) the deadline, the predicate flips to `true` and the state is swept. Placing one tick at `deadline − 1ns` and the next at `deadline` demonstrates the flip.

**Command & full unedited output** (canonical via `ProcessEvalResults`, then the non‑canonical direct call):

```
$ go test ./pkg/services/ngalert/state/ -run '^TestBlitzyQ3$' -v -count=1
=== RUN   TestBlitzyQ3
===== Q3 ===== formula stateIsStale: evaluatedAt >= lastEval + 2*IntervalSeconds (interval=10s, 2x=20s)
--- CANONICAL: driven through ProcessEvalResults ---
   just-inside (20s-1ns)      evaluatedAt=lastEval+19.999999999s presentInCache=true  staleTransitionEmitted=false
   exactly-boundary (20s)     evaluatedAt=lastEval+20s         presentInCache=false staleTransitionEmitted=true
   just-outside (20s+1ns)     evaluatedAt=lastEval+20.000000001s presentInCache=false staleTransitionEmitted=true
   3x-interval (30s)          evaluatedAt=lastEval+30s         presentInCache=false staleTransitionEmitted=true
--- NON-CANONICAL: direct stateIsStale() call (no ProcessEvalResults call graph) ---
   [non-canonical] lastEval+0s           => stateIsStale=false
   [non-canonical] lastEval+10s          => stateIsStale=false
   [non-canonical] lastEval+19.9s        => stateIsStale=false
   [non-canonical] lastEval+20s          => stateIsStale=true
   [non-canonical] lastEval+30s          => stateIsStale=true
--- PASS: TestBlitzyQ3 (0.01s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.055s
```

**Boundary table (before → at → after), interval = 10s so 2×interval = 20s:**

| Gap `evaluatedAt − lastEval` | Canonical (via `ProcessEvalResults`) | Non‑canonical (`stateIsStale` direct) |
|---|---|---|
| `0s` (now) | — | `false` |
| `1×interval` (10s) | — | `false` |
| `2×interval − 100ms` (19.9s) | — | `false` |
| `2×interval − 1ns` (19.999999999s) | present in cache, **not stale** | — |
| **`2×interval` exactly (20s)** | **evicted, stale txn emitted** | **`true`** |
| `2×interval + 1ns` (20.000000001s) | evicted, stale | — |
| `3×interval` (30s) | evicted, stale | `true` |

The canonical result (driven through the real call graph) and the non‑canonical direct helper call **agree** on the inclusive boundary at exactly `2×interval`. The non‑canonical rows reproduce the cases asserted by the existing `TestStateIsStale` (now / 1×interval / 2×interval−100ms → false; 2×interval / 3×interval → true).

---

## Q4 — What controls the resolved‑retention window, and when does the system stop sending resolved alerts?

**Direct answer.** The retention window is governed by **`NeedsSending` branch (c)** [pkg/services/ngalert/state/state.go:513–515]: a `Normal` state **stops** being sent once `LastEvaluationTime.Sub(*ResolvedAt) > resolvedRetention`, **or** when `ResolvedAt == nil`. The `resolvedRetention` value is `ResolvedAlertRetention`, whose **canonical default is `15m`** — parsed at [pkg/setting/setting_unified_alerting.go:465] from `(15 * time.Minute).String()` and wired into the state manager at [pkg/services/ngalert/ngalert.go:415] (into `ManagerCfg.ResolvedRetention`, field `ResolvedAlertRetention` [setting_unified_alerting.go:125]). With defaults the system emits the **last** resolved (re)send when `LastEvaluationTime − ResolvedAt == 15m0s` **exactly** (the comparison is a strict `>`), and the **first** cycle it *stops* is when that difference first exceeds `15m`. Downstream, each sent transition is serialized by **`StateToPostableAlert`** [pkg/services/ngalert/state/compat.go:35], which stamps the alert's `EndsAt = alertState.EndsAt` [compat.go:93]; the per‑rule sender callback in `ProcessEvalResults` hands these `PostableAlert`s to `send()` [schedule/alert_rule.go:441+] → the internal `MultiOrgAlertmanager` / external sender.

> **Important attribution (run‑first correction).** This 15‑minute retention + resend behavior applies to states that **remain in the cache resolved** — i.e. the **natural‑resolution** path where a series *stays present and reports `Normal`*. A **vanished/stale** series is different: it is **evicted** at staleness detection and its resolved notification is a **one‑shot** (see the dedicated evidence at the end of Q5). The trace below therefore drives the natural‑resolution path — the only path on which the retention window is actually exercised across many cycles.

**Mechanism (cause → effect).** On the tick a series resolves (`Alerting → Normal`), `setNextState` sets `ResolvedAt = evaluatedAt` [manager.go:506]. Thereafter `ResolvedAt` is *retained* across `Normal→Normal` ticks, so `LastEvaluationTime − ResolvedAt` grows by one interval each cycle. Branch (c) uses that growing difference as the stop condition; until it exceeds `resolvedRetention`, branch (d) (Q5) governs *whether* this particular cycle re‑sends.

**Command & full unedited output — the config default (canonical parse):**

```
$ go test ./pkg/setting/ -run '^TestBlitzyResolvedRetentionDefault$' -v -count=1
=== RUN   TestBlitzyResolvedRetentionDefault
===== CONFIG-DEFAULT ===== canonical default (no 'resolved_alert_retention' key set):
   cfg.UnifiedAlerting.ResolvedAlertRetention = 15m0s
   (15 * time.Minute).String() baseline = 15m0s ; match=true
--- PASS: TestBlitzyResolvedRetentionDefault (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/setting	0.022s
```

**Command & full unedited output — the retention boundary (default 15m, ResendDelay 30s, interval 10s):**

```
$ go test ./pkg/services/ngalert/state/ -run '^TestBlitzyQ4$' -v -count=1
=== RUN   TestBlitzyQ4
===== Q4 ===== ResolvedRetention=15m ResendDelay=30s interval=10s (natural-resolution path)
[boundary trace around 15m] (sinceResolved = LastEval - ResolvedAt):
   t89(890s) sinceResolved=14m30s branch(c)stop(sinceResolved>15m)=false => SENT LastSentAt=890s
   t90(900s) sinceResolved=14m40s branch(c)stop(sinceResolved>15m)=false => not-sent LastSentAt=890s
   t91(910s) sinceResolved=14m50s branch(c)stop(sinceResolved>15m)=false => not-sent LastSentAt=890s
   t92(920s) sinceResolved=15m0s  branch(c)stop(sinceResolved>15m)=false => SENT LastSentAt=920s
   t93(930s) sinceResolved=15m10s branch(c)stop(sinceResolved>15m)=true  => not-sent LastSentAt=920s
   t94(940s) sinceResolved=15m20s branch(c)stop(sinceResolved>15m)=true  => not-sent LastSentAt=920s
   t95(950s) sinceResolved=15m30s branch(c)stop(sinceResolved>15m)=true  => not-sent LastSentAt=920s
   t96(960s) sinceResolved=15m40s branch(c)stop(sinceResolved>15m)=true  => not-sent LastSentAt=920s
SUMMARY: lastSentTick=t92 firstNotSentTick(after 15m)=t93
--- PASS: TestBlitzyQ4 (0.22s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.266s
```

**Before / during / after — the 15‑minute stop boundary:**

| Tick | `sinceResolved` (= LastEval − ResolvedAt) | branch (c) stop? | Sent this cycle? | `LastSentAt` |
|---|---|---|---|---|
| t89 (890s) | 14m30s | false | **SENT** | 890s |
| t90–t91 | 14m40s / 14m50s | false | not sent (inside 30s resend gap) | 890s |
| **t92 (920s)** | **15m0s** (exactly) | **false** | **SENT (last)** | **920s** |
| **t93 (930s)** | **15m10s** | **true** | **not sent (first stop)** | 920s |
| t94–t96 | 15m20s … 15m40s | true | not sent (stopped) | 920s |

The window is **15 minutes**: the last resolved (re)send happens at `sinceResolved == 15m0s`, and sending **stops** on the first tick where `sinceResolved > 15m`.

---

## Q5 — How do the resend delay, resolved‑retention period, and last‑sent timestamp interact across cycles?

**Direct answer.** `ResendDelay = 30 * time.Second` [pkg/services/ngalert/state/manager.go:24]. Every cycle, `ProcessEvalResults` calls **`updateLastSentAt`** [manager.go:340 → func at :359], whose body [manager.go:360–364] calls `t.NeedsSending(st.ResendDelay, st.ResolvedRetention)` and, when it returns true, stamps `LastSentAt = evaluatedAt` and includes the transition in the batch that goes to the sender. Resend is branch (d) [state.go:519]: `return a.LastSentAt == nil || !a.LastSentAt.Add(resendDelay).After(a.LastEvaluationTime)` — i.e. it re‑sends when `LastSentAt + 30s <= LastEvaluationTime`. The net cadence for a resolved series that stays present is **one send every 30s** (= 3 ticks at interval 10s), continuing **until the 15m retention (Q4) halts it**. `updateLastSentAt` is explicitly **non‑idempotent** (its doc comment at manager.go:357–358) because it mutates `LastSentAt` as a side effect. The related helper `nextEndsTime` [state.go:534, returning `evaluatedAt.Add(4 * ends)` at :543, where `ends = max(ResendDelay, interval)`] shapes a *firing* state's `EndsAt` (two‑evaluation‑cycle cushion) and is not the resend gate itself.

**Mechanism (cause → effect).** The three quantities interlock like this per cycle: **(1)** branch (b) [state.go:507–509] force‑sends the very first resolved notification (because `ResolvedAt` is newer than `LastSentAt`); **(2)** branch (c) [state.go:513–515] is the retention gate — while `sinceResolved <= 15m` it does *not* veto; **(3)** branch (d) [state.go:519] is the resend clock — it re‑sends only once `LastSentAt + 30s` has been reached. Since `LastSentAt` is only advanced on cycles that actually send, the effective spacing settles to exactly 30s.

**Command & full unedited output** (CANONICAL: `ProcessEvalResults → updateLastSentAt → NeedsSending`; run scale: **99 ticks × 10s = 990s ≈ 16.5 min** of simulated time):

```
$ go test ./pkg/services/ngalert/state/ -run '^TestBlitzyQ5$' -v -count=1
=== RUN   TestBlitzyQ5
===== Q5 ===== ResendDelay=30s ResolvedRetention=15m interval=10s (CANONICAL via ProcessEvalResults->updateLastSentAt->NeedsSending)
   t2(20s) SENT  LastSentAt=20s LastEval=20s ResolvedAt=20s sinceResolved=0s
   t5(50s) SENT  LastSentAt=50s LastEval=50s ResolvedAt=20s sinceResolved=30s gap=30s
   t8(80s) SENT  LastSentAt=80s LastEval=80s ResolvedAt=20s sinceResolved=1m0s gap=30s
   t11(110s) SENT  LastSentAt=110s LastEval=110s ResolvedAt=20s sinceResolved=1m30s gap=30s
   t14(140s) SENT  LastSentAt=140s LastEval=140s ResolvedAt=20s sinceResolved=2m0s gap=30s
   t17(170s) SENT  LastSentAt=170s LastEval=170s ResolvedAt=20s sinceResolved=2m30s gap=30s
   t20(200s) SENT  LastSentAt=200s LastEval=200s ResolvedAt=20s sinceResolved=3m0s gap=30s
   t23(230s) SENT  LastSentAt=230s LastEval=230s ResolvedAt=20s sinceResolved=3m30s gap=30s
   t26(260s) SENT  LastSentAt=260s LastEval=260s ResolvedAt=20s sinceResolved=4m0s gap=30s
   t29(290s) SENT  LastSentAt=290s LastEval=290s ResolvedAt=20s sinceResolved=4m30s gap=30s
   t32(320s) SENT  LastSentAt=320s LastEval=320s ResolvedAt=20s sinceResolved=5m0s gap=30s
   t35(350s) SENT  LastSentAt=350s LastEval=350s ResolvedAt=20s sinceResolved=5m30s gap=30s
   t38(380s) SENT  LastSentAt=380s LastEval=380s ResolvedAt=20s sinceResolved=6m0s gap=30s
   t41(410s) SENT  LastSentAt=410s LastEval=410s ResolvedAt=20s sinceResolved=6m30s gap=30s
   t44(440s) SENT  LastSentAt=440s LastEval=440s ResolvedAt=20s sinceResolved=7m0s gap=30s
   t47(470s) SENT  LastSentAt=470s LastEval=470s ResolvedAt=20s sinceResolved=7m30s gap=30s
   t50(500s) SENT  LastSentAt=500s LastEval=500s ResolvedAt=20s sinceResolved=8m0s gap=30s
   t53(530s) SENT  LastSentAt=530s LastEval=530s ResolvedAt=20s sinceResolved=8m30s gap=30s
   t56(560s) SENT  LastSentAt=560s LastEval=560s ResolvedAt=20s sinceResolved=9m0s gap=30s
   t59(590s) SENT  LastSentAt=590s LastEval=590s ResolvedAt=20s sinceResolved=9m30s gap=30s
   t62(620s) SENT  LastSentAt=620s LastEval=620s ResolvedAt=20s sinceResolved=10m0s gap=30s
   t65(650s) SENT  LastSentAt=650s LastEval=650s ResolvedAt=20s sinceResolved=10m30s gap=30s
   t68(680s) SENT  LastSentAt=680s LastEval=680s ResolvedAt=20s sinceResolved=11m0s gap=30s
   t71(710s) SENT  LastSentAt=710s LastEval=710s ResolvedAt=20s sinceResolved=11m30s gap=30s
   t74(740s) SENT  LastSentAt=740s LastEval=740s ResolvedAt=20s sinceResolved=12m0s gap=30s
   t77(770s) SENT  LastSentAt=770s LastEval=770s ResolvedAt=20s sinceResolved=12m30s gap=30s
   t80(800s) SENT  LastSentAt=800s LastEval=800s ResolvedAt=20s sinceResolved=13m0s gap=30s
   t83(830s) SENT  LastSentAt=830s LastEval=830s ResolvedAt=20s sinceResolved=13m30s gap=30s
   t86(860s) SENT  LastSentAt=860s LastEval=860s ResolvedAt=20s sinceResolved=14m0s gap=30s
   t89(890s) SENT  LastSentAt=890s LastEval=890s ResolvedAt=20s sinceResolved=14m30s gap=30s
   t92(920s) SENT  LastSentAt=920s LastEval=920s ResolvedAt=20s sinceResolved=15m0s gap=30s
SUMMARY: totalSends=31 firstSend=t2 lastSend=t92 cadence=30s(=3 intervals) retention=15m
--- NON-CANONICAL: bare NeedsSending() branch enumeration (isolated, no ProcessEvalResults) ---
   [non-canonical] (a) Pending => false                       NeedsSending(30s,15m)=false
   [non-canonical] (b) resolved & never sent => true          NeedsSending(30s,15m)=true
   [non-canonical] (b) resolved after lastSent => true        NeedsSending(30s,15m)=true
   [non-canonical] (c) Normal, no ResolvedAt => false         NeedsSending(30s,15m)=false
   [non-canonical] (c) Normal, sinceResolved>15m => false     NeedsSending(30s,15m)=false
   [non-canonical] (d) resend: lastSent 40s ago (>30s) => true NeedsSending(30s,15m)=true
   [non-canonical] (d) no resend: lastSent 20s ago (<30s) => false NeedsSending(30s,15m)=false
```

```
--- PASS: TestBlitzyQ5 (0.11s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.159s
```

**Interplay table (canonical trace excerpt):**

| Cycle | `LastEval` | `ResolvedAt` | `LastSentAt` after tick | `sinceResolved` | Sent? | Why (branch) |
|---|---|---|---|---|---|---|
| t2 | 20s | 20s | 20s | 0s | **yes** | (b) resolved since last notify |
| t3–t4 | 30s/40s | 20s | 20s | 10s/20s | no | (d) `20s+30s=50s > LastEval` |
| t5 | 50s | 20s | 50s | 30s | **yes** | (d) `20s+30s=50s <= 50s` |
| … every 3rd tick … | | | advances by 30s | +30s each send | **yes** | (d) resend clock |
| t92 | 920s | 20s | 920s | 15m0s | **yes (last)** | (c) not yet `>15m`, (d) fires |
| t93+ | 930s+ | 20s | 920s | >15m | no | (c) retention exceeded ⇒ stop |

**All four `NeedsSending` branches, enumerated (non‑canonical, isolated helper):** (a) `Pending` → `false`; (b) resolved‑since‑last → `true`; (c) `Normal` with no `ResolvedAt` **or** `sinceResolved>15m` → `false`; (d) resend when `LastSentAt+30s <= LastEvaluationTime` → `true`, else `false`. These isolated values are labeled **non‑canonical**; the canonical cadence (30s) and window (15m) are the ones produced above by the real `ProcessEvalResults → updateLastSentAt → NeedsSending` path.

### Q4/Q5 — the vanished‑series path is a ONE‑SHOT (evicted), *not* a 15‑minute resend

Because Q4/Q5 are framed around a *vanished* series, the following experiment drives the **stale** path directly (series absent every tick after t1) and shows that the resolved notification fires **exactly once** — at the staleness boundary (t3) — after which the state is **evicted** and nothing further is sent. Contrast this with the natural‑resolution cadence above.

```
$ go test ./pkg/services/ngalert/state/ -run '^TestBlitzyStaleOneShot$' -v -count=1
=== RUN   TestBlitzyStaleOneShot
===== STALE-ONE-SHOT ===== vanished series: resolved notification sent ONCE at staleness, then evicted
   t1(10s) Alerting: sent=1 statesInCache=1
   t2(20s) absent: sent=0 statesInCache=1
   t3(30s) absent: sent=1 statesInCache=0
   t4(40s) absent: sent=0 statesInCache=0
   t5(50s) absent: sent=0 statesInCache=0
   t6(60s) absent: sent=0 statesInCache=0
   t7(70s) absent: sent=0 statesInCache=0
   t8(80s) absent: sent=0 statesInCache=0
   => resolved notification for the vanished series fires exactly once (t3), then the state is evicted; NOT resent for 15m.
--- PASS: TestBlitzyStaleOneShot (0.01s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.057s
```

| Tick | Present? | `sent` (batch size) | states in cache | interpretation |
|---|---|---|---|---|
| t1 | yes (Alerting) | 1 | 1 | firing notification |
| t2 | no (1 cycle) | 0 | 1 | within grace, still cached |
| **t3** | no (2 cycles) | **1** | **0** | **stale → resolved once → evicted** |
| t4–t8 | no | 0 | 0 | nothing left to resend |

**Conclusion for the "lingering alert" symptom:** a genuinely *vanished* series sends **one** resolved alert and disappears from state; the *repeated* resolved notifications over ~15 min that operators sometimes observe come from the **natural‑resolution** path (a series that keeps reporting `Normal`), governed by the 30s/15m interplay above.

---

## Q6 — Do stale‑series resolutions trigger the *same* screenshot behavior as natural resolutions?

**Direct answer — same function, different trigger (and different multiplicity).** Both paths ultimately call the **same** `takeImage` function [pkg/services/ngalert/state/state.go:588 → `s.NewImage(...)` at :590]. They differ only in *how* they trigger it:

- **Natural resolution** triggers it through `shouldTakeImage(state, previousState, previousImage, resolved)` [state.go:581–585], which returns `true` on `resolved`; the call site is guarded `if shouldTakeImage(...) { takeImage(...) }` [manager.go:513–514], and `resolved` (`newlyResolved`) is set when `oldState == eval.Alerting && currentState.State == eval.Normal` [manager.go:506].
- **Stale resolution** calls `takeImage` **directly**, unconditionally, inside the `if oldState == eval.Alerting` guard of the `deleteStaleStatesFromCache` loop [manager.go:604–606] — it does *not* consult `shouldTakeImage`.

**Run‑first correction on "one shared image".** There is a comment at [manager.go:587–588] saying it "makes sense to share the resolved image as the alert rule is the same," but the **observed** behavior at this commit is that `takeImage` is called **once per `Alerting` stale series** inside the loop — i.e. **2 `NewImage` calls for 2 stale alerting series**, *not* a single shared call at the `ImageCapturer` layer. Any de‑duplication would have to happen inside the screenshot backend (`ScreenshotImageService` [pkg/services/ngalert/image/service.go:49], `NewScreenshotImageService` [service.go:61]) via its screenshot cache, which is *not* exercised by the counting image service used here.

**Mechanism (cause → effect).** `NewImage` is the single `ImageCapturer` interface method both paths funnel through, so the *capture function* is identical. The natural path is *state‑transition gated* (image only on the resolving transition, or on entering `Alerting` without an existing image). The stale path is *per‑evicted‑alerting‑series gated* — it iterates the stale set and, for every one that was `Alerting`, takes an image while also setting `ResolvedAt`.

**Command & full unedited output** (counting `NewImage` calls with the in‑package `CountingImageService`):

```
$ go test ./pkg/services/ngalert/state/ -run '^TestBlitzyQ6$' -v -count=1
=== RUN   TestBlitzyQ6
===== Q6 ===== both paths call the SAME takeImage->NewImage; different trigger
   (a) NATURAL: 1 series Alerting->Normal. images at Alerting-entry=1, images at resolution=1 (via shouldTakeImage resolved=true)
   (b) STALE: 2 Alerting series dropped. images at Alerting-entry=2, stale series resolved=2, images at stale-resolution=2
   OBSERVED: stale path calls takeImage once PER Alerting stale series (loop body, manager.go:604-606); NOT a single shared NewImage call at this layer.
--- PASS: TestBlitzyQ6 (0.01s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.047s
```

**Comparison table — screenshot behavior on each path:**

| Aspect | Natural resolution (`Alerting→Normal`, present) | Stale resolution (vanished `Alerting` series) |
|---|---|---|
| Capture function | `takeImage` → `NewImage` | **same** `takeImage` → `NewImage` |
| Trigger | `shouldTakeImage(...)==true` on `resolved` [manager.go:513–514] | direct call under `oldState==eval.Alerting` [manager.go:604–606] |
| Consults `shouldTakeImage`? | yes [state.go:581–585] | no |
| `NewImage` calls observed | 1 (per resolving series) | **2 for 2 alerting series** (once each) |
| Sets `ResolvedAt`? | yes ([manager.go:506]) | yes, in the same guard ([manager.go:605]) |

So there **is** parity in the *capture function*, but **not** a single‑shared‑image on the stale path at the observed layer, and the *trigger* differs (transition‑gated vs per‑series‑in‑loop).

---

## Q7 — Does a vanishing series honor a configured *pending period* (`For`) on the way out?

**Direct answer — no.** A vanishing series does **not** honor `For`/pending on the way out; it goes **straight to `Normal`/`MissingSeries`**. The reason is structural: the `For`/pending logic lives **only** in `resultAlerting` [pkg/services/ngalert/state/state.go:316–357] (the `Pending`/`SetPending`/`SetAlerting` branch that checks `result.EvaluatedAt.Sub(state.StartsAt) >= rule.For`), but `deleteStaleStatesFromCache` sets `s.State = eval.Normal` **directly** [manager.go:599] and never routes through `resultAlerting`. **Edge case (triggered below):** a series that vanishes **while still in `Pending`** becomes `Normal`/`MissingSeries` **without `ResolvedAt` and without an image**, because that resolve/image work is guarded by `if oldState == eval.Alerting` [manager.go:604], and `Pending != Alerting`.

**Mechanism (cause → effect).** On the way *in*, a first `Alerting` result with `rule.For > 0` lands in the `default` branch of `resultAlerting`, which calls `SetPending` — the series waits out `For`. On the way *out* (vanishing), the staleness sweep bypasses `resultAlerting` entirely; the `oldState == eval.Alerting` guard is `false` for a `Pending` series, so no `ResolvedAt`, no `takeImage`. The result is an immediate `Pending → Normal/MissingSeries` with the resolve side effects suppressed.

**Command & full unedited output** (`rule.For = 60s`; series held in `Pending`, then dropped):

```
$ go test ./pkg/services/ngalert/state/ -run '^TestBlitzyQ7$' -v -count=1
=== RUN   TestBlitzyQ7
===== Q7 ===== rule.For=1m0s; series vanishes WHILE Pending
[BEFORE t1=10s] Alerting result but For=60s not met => Pending:
   P: State=Pending  Reason=""            StartsAt=10s   EndsAt=130s   ResolvedAt=<nil>  LastSentAt=<nil>  LastEval=10s    CacheID=4346850147001790630 image=none(nil)
[DURING t2=20s] P dropped (gap=1 interval): still Pending in cache:
   P: State=Pending  Reason=""            StartsAt=10s   EndsAt=130s   ResolvedAt=<nil>  LastSentAt=<nil>  LastEval=10s    CacheID=4346850147001790630 image=none(nil)
[AFTER t3=30s] P stale WHILE Pending => straight to Normal/MissingSeries:
   P: <absent from cache>
   P transition: Pending->Normal reason="MissingSeries" ResolvedAt=<nil> image=none(nil)
   imageCalls before=0 after=0 delta=0 (EXPECT delta=0 & ResolvedAt=nil: oldState!=Alerting guard, manager.go:604)
--- PASS: TestBlitzyQ7 (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.126s
```

**Before / during / after — series vanishing while `Pending`:**

| Field | BEFORE (t1, Pending) | DURING (t2, absent 1 cycle) | AFTER (t3, stale) |
|---|---|---|---|
| `State` | `Pending` | `Pending` (frozen) | `Normal` |
| `StateReason` | `""` | `""` | `"MissingSeries"` |
| `ResolvedAt` | `<nil>` | `<nil>` | **`<nil>` (still! not resolved)** |
| `LastSentAt` | `<nil>` (Pending never sends — branch (a)) | `<nil>` | `<nil>` |
| image taken? | no | no | **no (delta=0)** |
| honored `For` on exit? | — | — | **no — skipped straight to Normal** |

Contrast with **Q1** (a series that vanishes while **`Alerting`**): there `ResolvedAt` **is** set and an image **is** taken. The `oldState == eval.Alerting` guard is the single line that distinguishes the two exits.

---

## Q8 — When a vanished series reappears with identical labels, is it the same entity or a new instance?

**Direct answer — "same identity, new instance."** States are keyed by the label **`Fingerprint`**, i.e. `CacheID` [pkg/services/ngalert/state/cache.go:146,149: `cacheID := lbs.Fingerprint()`]. When a series goes stale, the entry is **evicted** from the cache map via `deleteRuleStates` [cache.go:255] → `deleteStates` (`delete(rs.states, id)`) [cache.go:244–248]. When the series **reappears with identical labels**, its `CacheID` is **identical** (same fingerprint), but because the prior state was evicted, `create()` [cache.go:146] builds a **brand‑new `State` with a fresh `StartsAt`**. So it is recognized as the same *fingerprint/identity* but is a *new instance* (a fresh lifecycle), **not** a continuation of the old one.

**Mechanism (cause → effect).** The fingerprint is a pure function of the label set, so identical labels ⇒ identical `CacheID` — that is what makes it "the same" series by identity. But the lifecycle timestamps (`StartsAt`) live on the *state object*, which was deleted at eviction. On reappearance the cache has no entry for that `CacheID`, so `create()` allocates a fresh `State` (with `StartsAt = EndsAt = EvaluatedAt` for the new `Normal` seed, then advanced by the incoming result). Hence identical key, new `StartsAt`.

**Command & full unedited output.**

```
$ go test ./pkg/services/ngalert/state/ -run '^TestBlitzyQ8$' -v -count=1
=== RUN   TestBlitzyQ8
===== Q8 ===== vanish then reappear with identical labels
[BEFORE t1=10s] R present & Alerting:
   R: State=Alerting Reason=""            StartsAt=10s   EndsAt=130s   ResolvedAt=<nil>  LastSentAt=10s    LastEval=10s    CacheID=4346847947978533900 image=present(empty-token)
[DURING t3=30s] R stale => evicted:
   R: <absent from cache>
[AFTER t5=50s] R reappears with identical labels:
   R: State=Alerting Reason=""            StartsAt=50s   EndsAt=170s   ResolvedAt=<nil>  LastSentAt=50s    LastEval=50s    CacheID=4346847947978533900 image=present(empty-token)
   CacheID: t1=4346847947978533900  t5=4346847947978533900  identical=true
   StartsAt: t1=10s  t5=50s  fresh(new lifecycle)=true
--- PASS: TestBlitzyQ8 (0.01s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.050s
```

**Before / during / after — identity vs lifecycle across a vanish→reappear:**

| Field | BEFORE (t1, first appearance) | DURING (t3, stale) | AFTER (t5, reappears identical labels) |
|---|---|---|---|
| present in cache? | yes | **no — evicted** | yes (rebuilt) |
| `CacheID` (fingerprint) | `4346847947978533900` | — | `4346847947978533900` (**identical**) |
| `StartsAt` | `10s` | — | **`50s` (fresh)** |
| lifecycle | original | ended | **new instance** |

**Same `CacheID`, new `StartsAt`** makes the distinction concrete: Grafana treats the reappearing series as the *same fingerprint* re‑entering, but as a *freshly created* state object with a new start time — not a resumed continuation of the pre‑eviction instance.

---

## 10. Version caveats (commit `4550cfb`), confirmed at runtime

Both caveats were verified by running the code, not merely by reading:

**Caveat 1 — the `2×interval` factor is HARDCODED.** There is no configurable "Missing series evaluations to resolve" knob at this commit. A repository search returns nothing:

```
$ grep -rn "Missing series evaluations\|missing_series_evaluations\|MissingSeriesEvaluations" pkg/services/ngalert/ pkg/setting/
(no matches — exit 1)
```

The only staleness factor is the literal `2 *` in `stateIsStale` [manager.go:628], and the runtime check confirms the fixed factor:

```
   hardcoded-2x check: gap=1x interval => stateIsStale=false
   hardcoded-2x check: gap=2x interval => stateIsStale=true
   hardcoded-2x check: gap=3x interval => stateIsStale=true
```

**Caveat 2 — there is NO `Recovering` / "Keep firing for" state.** The `eval.State` enum [pkg/services/ngalert/eval/eval.go:275+] has **exactly five** values, and a grep for `Recovering` in `eval/` and `state/*.go` returns nothing:

```
$ grep -rn "Recovering" pkg/services/ngalert/eval/ pkg/services/ngalert/state/*.go
(no matches — exit 1)
```

Runtime confirmation of the enum:

```
$ go test ./pkg/services/ngalert/state/ -run '^TestBlitzyCaveats$' -v -count=1
=== RUN   TestBlitzyCaveats
===== CAVEATS =====
eval.State enum count: Normal=0 Alerting=1 Pending=2 NoData=3 Error=4
eval.State.String() values: [Normal Alerting Pending NoData Error]  (exactly 5, NO Recovering state)
Error is the max valid state (IsValid boundary): Error.IsValid()=true, (Error+1).IsValid()=false
   hardcoded-2x check: gap=1x interval => stateIsStale=false
   hardcoded-2x check: gap=2x interval => stateIsStale=true
   hardcoded-2x check: gap=3x interval => stateIsStale=true
ResendDelay constant = 30s (manager.go:24)
--- PASS: TestBlitzyCaveats (0.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/ngalert/state	0.043s
```

Consequence: resolution here is **immediate**, and a vanishing series **skips `Pending`** on the way out (ties directly to Q7). Newer Grafana versions introduced a configurable resolve‑after count and a `Recovering` state; **neither exists at this commit.**

---

## 11. Timing / magnitude confirmation (run scale + ≥2‑run stability)

Every magnitude/timing value was run long enough to observe the true value and **confirmed stable across ≥2 runs**, in both same‑process (`-count=2`) and separate‑process reruns.

| Value | Observed | Run scale / how driven | Stability evidence |
|---|---|---|---|
| Staleness window | **2×interval** (inclusive; interval 10s ⇒ 20s) | boundary ticks at `+20s−1ns` / `+20s` / `+20s+1ns` / `+30s` via `ProcessEvalResults` | identical across `-count=2` and separate runs |
| Resend cadence | **30s** (= 3 ticks at 10s) | 99 ticks × 10s = **990s ≈ 16.5 min** simulated, natural‑resolution path | `totalSends=31 firstSend=t2 lastSend=t92 cadence=30s` reproduced identically twice |
| Resolved retention | **15m** (last send at `sinceResolved=15m0s`; stop when `>15m`) | same 99‑tick run; boundary trace t89–t96 | `lastSentTick=t92 firstNotSentTick=t93` reproduced identically twice |
| Resend delay constant | **30s** | `ResendDelay` printed | `manager.go:24` |
| Config default retention | **15m0s** | canonical `ReadUnifiedAlertingSettings` on empty ini | `match=true` |
| Stale one‑shot | resolved sent **once** (t3), then evicted | 8 ticks, series absent after t1 | `t3 sent=1 cache=0`, reproduced identically twice |

Stability run (same process, two iterations of the timing‑sensitive tests) — the key summary lines each appear exactly twice, byte‑identical:

```
$ go test ./pkg/services/ngalert/state/ -run 'TestBlitzyQ3$|TestBlitzyQ4$|TestBlitzyQ5$|TestBlitzyStaleOneShot$' -v -count=2 \
    | grep -E "SUMMARY:|exactly-boundary|just-inside|lastSentTick|fires exactly once|t3\(30s\) absent: sent=1" | sort | uniq -c
      2    => resolved notification for the vanished series fires exactly once (t3), then the state is evicted; NOT resent for 15m.
      2    exactly-boundary (20s)     evaluatedAt=lastEval+20s         presentInCache=false staleTransitionEmitted=true
      2    just-inside (20s-1ns)      evaluatedAt=lastEval+19.999999999s presentInCache=true  staleTransitionEmitted=false
      2    t3(30s) absent: sent=1 statesInCache=0
      2 SUMMARY: lastSentTick=t92 firstNotSentTick(after 15m)=t93
      2 SUMMARY: totalSends=31 firstSend=t2 lastSend=t92 cadence=30s(=3 intervals) retention=15m
```

Separate‑process reruns produced identical `SUMMARY:` lines for Q4 and Q5 on both run 1 and run 2 (`totalSends=31 … lastSend=t92 … retention=15m`; `lastSentTick=t92 firstNotSentTick(after 15m)=t93`).

---

## 12. Final coverage checklist

Every named item from the eight questions and every function named in the grounding rule is answered by name, with a concrete value, a `file:line` (re‑derived at `4550cfb`), and observed evidence.

| Named item / function | Where answered | Concrete value / behavior | `file:line` | Evidence |
|---|---|---|---|---|
| Fate of vanished states | Q1 | → `Normal`/`MissingSeries`, `EndsAt`+`LastEval` stamped; `ResolvedAt`+image iff was `Alerting`; evicted | manager.go:586,599–606 | `TestBlitzyQ1` |
| Stopped vs. slow | Q2 | freshness of `LastEvaluationTime` vs 2×interval grace | schedule/alert_rule.go:441; manager.go:627 | `TestBlitzyQ2` |
| **Staleness threshold & formula** | Q3 | `evaluatedAt >= lastEval + 2×IntervalSeconds` (inclusive) | manager.go:627–628 | `TestBlitzyQ3` + `TestStateIsStale` |
| **Resolved retention period** | Q4 | **15m** default; stop when `LastEval−ResolvedAt > 15m` | state.go:513–515; setting_unified_alerting.go:465; ngalert.go:415 | `TestBlitzyQ4`, config default |
| **Resend delay** | Q5 | **30s**; resend when `LastSentAt+30s <= LastEval` | manager.go:24; state.go:519 | `TestBlitzyQ5` |
| **Last‑sent timestamp** | Q5 | `updateLastSentAt` stamps `LastSentAt=evaluatedAt` (non‑idempotent) | manager.go:340,357–364 | `TestBlitzyQ5` |
| **Screenshots** | Q6 | same `takeImage`/`NewImage`; different trigger; **per‑series** on stale path | manager.go:513–514,604–606; state.go:581–585,588 | `TestBlitzyQ6` |
| **Pending period** (`For`) | Q7 | not honored on exit; vanish‑while‑Pending ⇒ no `ResolvedAt`, no image | state.go:316–357; manager.go:599,604 | `TestBlitzyQ7` |
| **Reappearing series** | Q8 | same `CacheID`/fingerprint, fresh `StartsAt` (new instance) | cache.go:146,149,244–248,255 | `TestBlitzyQ8` |
| `ProcessEvalResults` | all | real entry point driven each tick | manager.go:307 | all harnesses |
| `deleteStaleStatesFromCache` | Q1,Q3,Q7 | performs the stale relabel + eviction | manager.go:586 | `TestBlitzyQ1/Q3/Q7` |
| `stateIsStale` | Q2,Q3 | the 2×interval predicate | manager.go:627–628 | `TestBlitzyQ3`, caveats |
| `NeedsSending` | Q4,Q5 | 4 branches (Pending/resolved/retention‑stop/resend) | state.go:500,501–519 | `TestBlitzyQ5` |
| `updateLastSentAt` | Q5 | applies `NeedsSending`, stamps `LastSentAt` | manager.go:359–364 | `TestBlitzyQ5` |
| `shouldTakeImage` | Q6 | natural‑path image gate (`resolved`) | state.go:581–585 | `TestBlitzyQ6` |
| `takeImage` | Q6 | shared capture function (both paths) | state.go:588 | `TestBlitzyQ6` |
| `resultAlerting` | Q7 | sole home of `For`/pending logic; bypassed on stale exit | state.go:316–357 | `TestBlitzyQ7` |
| `create` | Q8 | rebuilds fresh state on reappearance | cache.go:146 | `TestBlitzyQ8` |
| `deleteStates` / `deleteRuleStates` | Q8 | evict the stale entry from the cache map | cache.go:244–248,255 | `TestBlitzyQ8`, `TestBlitzyStaleOneShot` |
| `StateReasonMissingSeries` | Q1 | `"MissingSeries"` | models/alert_rule.go:160 | `TestBlitzyQ1/Q7` |
| `StateToPostableAlert` / `EndsAt` | Q4 | shapes downstream `PostableAlert.EndsAt` | compat.go:35,93 | code + schedule/alert_rule.go:441+ |
| Caveat: hardcoded 2× | §10 | no config knob | manager.go:628 | grep + `TestBlitzyCaveats` |
| Caveat: no `Recovering` | §10 | enum has exactly 5 states | eval.go:275+ | grep + `TestBlitzyCaveats` |

**Cross‑product coverage.** The paired variables were exercised jointly: *old state × exit path* (Alerting‑vanish in Q1 vs Pending‑vanish in Q7, both driven), *series count × screenshot path* (1 natural vs 2 stale in Q6), and *tick position × boundary* (inside/at/outside 2×interval in Q3; inside/at/after 15m in Q4).

---

## 13. Cleanup note (repository left unchanged)

This investigation used two temporary harness files — `pkg/services/ngalert/state/blitzy_adhoc_test_stale_test.go` and `pkg/setting/blitzy_adhoc_test_retention_test.go` — plus scratch output under `/tmp` (outside the repository). **All temporary harnesses are removed** before completion. The Grafana source tree is left **byte‑for‑byte unchanged**: no `.go` file, no `go.mod`/`go.sum`, no CI or Dockerfile was modified. After cleanup, `git status --porcelain` shows exactly one untracked entry — the single deliverable:

```
?? blitzy/documentation/grafana_4550cfb5b728.md
```

*All values, timings, and transitions above were produced by building and running the real `ProcessEvalResults` code path at commit `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` with Go 1.23.1, and confirmed stable across at least two runs. Isolated‑helper values are labeled non‑canonical; nothing in this document is inferred‑from‑reading without being so labeled.*
