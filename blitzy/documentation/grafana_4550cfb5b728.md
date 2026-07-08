# How Grafana Live's Streaming Routing Layer Stays Coherent Under Concurrent Refresh + Subscriber Traffic

> **Scope:** read‑only investigative code Q&A. The routing layer in question is the channel‑rule cache **`CacheSegmentedTree`** in `pkg/services/live/pipeline/rule_cache_segmented.go` — a per‑organization radix route tree guarded by a single `sync.RWMutex` and rebuilt on a fixed interval.
>
> **Methodology:** run‑first. Every behavioral claim below is backed by (1) the exact command run, (2) the complete, unedited runtime output, and (3) a `file:line` reference plus the specific function/struct/method that performs the work. Numbers labeled *observed* were captured on this host; anything I did not directly execute is labeled *inferred*.

---

## 1. TL;DR — the one‑paragraph direct answer

Grafana Live's routing layer is **`CacheSegmentedTree`** (`pkg/services/live/pipeline/rule_cache_segmented.go:13-17`): a `map[int64]*tree.Node` (one radix route tree per organization) guarded by a single `sync.RWMutex` named `radixMu` (`rule_cache_segmented.go:14`). It is kept internally coherent by a **rebuild‑and‑swap performed under one write‑lock hold**: the method `fillOrg` (`rule_cache_segmented.go:46-60`) builds the new rule set *off‑lock*, then takes `radixMu.Lock()` and, in a single locked critical section, assigns a **brand‑new empty tree** (`s.radix[orgID] = tree.New()`, `rule_cache_segmented.go:55`) and repopulates it via `AddRoute` (`rule_cache_segmented.go:56-58`). Because the empty‑assign and the repopulation happen under the *same* lock hold, a concurrent reader in `Get` (`rule_cache_segmented.go:62-83`) — which takes `radixMu.RLock()` — can only ever observe a **fully‑populated tree, never a half‑built one**. The authoritative view at any instant is simply *whatever `radix[orgID]` points to when observed under the mutex*; handover is a single atomic map‑entry reassignment. The only inconsistency a consumer can observe is **bounded staleness** — routes up to one refresh interval old, because the background writer `updatePeriodically` (`rule_cache_segmented.go:28-43`) sleeps `20 * time.Second` (`rule_cache_segmented.go:42`) between refreshes. This design (map + `RWMutex`, heavy work off‑lock, whole‑structure swap) is an idiomatic Go read‑heavy‑cache pattern (see §7), and its atomicity is demonstrated below both by an invariant probe (`missCommon=0` across ~4M reads racing ~320k rebuilds) and by a clean `-race` run.

---

## 2. Environment / How to reproduce

All observations were captured against the following fixed context:

| Item | Value |
|------|-------|
| Module | `github.com/grafana/grafana` (`go.mod:1`) |
| Go directive | `go 1.23.1` (`go.mod:3`) |
| Source branch (deliverable name) | `grafana_4550cfb5b728` |
| HEAD commit | `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff` |
| Toolchain | `go version go1.23.1 linux/amd64` (exact match to `go.mod:3`) |
| Workspace | a Go workspace (`go.work`) is active — do **not** pass `-mod=mod` (it errors in workspace mode) |
| C toolchain | `gcc (Ubuntu 15.2.0-4ubuntu4) 15.2.0` present at `/usr/bin/gcc`; `CGO_ENABLED=1`, `CC=gcc` → the `-race` detector **runs** here (see §4 and honesty note §8) |

**Canonical default build** of the routing packages (state this command + result):

```
go build ./pkg/services/live/pipeline/ ./pkg/services/live/pipeline/tree/
```

Result: empty output, exit code `0` (the packages compile cleanly in the default workspace‑aware build).

**Exact test command** used for the runtime evidence (repeated three times; see §4):

```
go test -count=1 -v -run TestBlitzyObs ./pkg/services/live/pipeline/
```

**`-race` command** (corroborating atomicity proof; see §4):

```
CGO_ENABLED=1 go test -race -count=1 -v -run TestBlitzyObs ./pkg/services/live/pipeline/
```

The observation instrument is a **temporary, in‑package test** (`package pipeline`) at `pkg/services/live/pipeline/blitzy_obs_test.go`. It calls the real exported constructor `NewCacheSegmentedTree`, the real exported `Get`, and the real unexported rebuild `fillOrg` (the same method the periodic writer calls), and inspects the unexported `radix`/`radixMu` to prove the lazy‑fill precondition. **It was removed after the investigation and `git status` was verified clean**, so the only persisted new artifact is this document (see §8). The full harness source and all raw outputs are in the Appendix (§10).

---

## 3. The mechanism at a glance

The entire routing cache is **83 lines** (`pkg/services/live/pipeline/rule_cache_segmented.go`). It has one struct and four methods:

| Symbol | `file:line` | Role |
|--------|-------------|------|
| `type CacheSegmentedTree struct` | `rule_cache_segmented.go:13-17` | Holds `radixMu sync.RWMutex` (L14), `radix map[int64]*tree.Node` (L15, the per‑org authoritative view), `ruleBuilder RuleBuilder` (L16) |
| `func NewCacheSegmentedTree(storage RuleBuilder) *CacheSegmentedTree` | `rule_cache_segmented.go:19-26` | Seeds the empty per‑org map (L21) and launches the background refresher `go s.updatePeriodically()` (L24) |
| `func (s *CacheSegmentedTree) updatePeriodically()` | `rule_cache_segmented.go:28-43` | The single background **writer**: snapshots orgIDs under the lock (L31‑35), rebuilds each via `fillOrg` (L36‑41), then `time.Sleep(20 * time.Second)` (L42) |
| `func (s *CacheSegmentedTree) fillOrg(orgID int64) error` | `rule_cache_segmented.go:46-60` | **Rebuild‑and‑swap**: `BuildRules` off‑lock (L49), then under `radixMu.Lock()` (L53) assigns `tree.New()` (L55) and repopulates via `AddRoute` (L56‑58) |
| `func (s *CacheSegmentedTree) Get(orgID int64, channel string) (*LiveChannelRule, bool, error)` | `rule_cache_segmented.go:62-83` | The subscriber **reader**: `RLock` presence check (L63‑65), lazy fill on miss (L66‑71), second `RLock` to read (L72‑73), radix‑tree match via `t.GetValue` (L78) |

Supporting contracts:

- `RuleBuilder` interface — `BuildRules(ctx context.Context, orgID int64) ([]*LiveChannelRule, error)` at `pkg/services/live/pipeline/rule_builder.go:6-8`. This is what `fillOrg` calls off‑lock.
- `LiveChannelRule` struct (with `OrgId` at `pipeline.go:127` and `Pattern` at `pipeline.go:133`) — `pkg/services/live/pipeline/pipeline.go:125`. Rules carry the channel `Pattern` that is inserted into the radix tree.
- The radix matcher itself — `pkg/services/live/pipeline/tree/tree.go`: `New()` at `tree.go:70`, `AddRoute` at `tree.go:116`, `GetValue` at `tree.go:384`. **The tree is not concurrency‑safe on its own** — which is precisely *why* the external `radixMu` is required.

The reader/writer interaction the four questions probe:

```
Single background writer                         Many concurrent readers
------------------------                         -----------------------
updatePeriodically()  (rule_cache_segmented.go:28-43)
  loop: refresh all orgs, then Sleep 20s (L42)
    fillOrg(orgID)    (L46-60)
      BuildRules(ctx,orgID)  OFF-lock (L49)       Get(orgID, channel)  (L62-83)
      radixMu.Lock()               (L53) <--------- radixMu.RLock() presence (L63-65)
      radix[orgID] = tree.New()    (L55)           (lazy) fillOrg on miss   (L67)
      AddRoute per rule            (L56-58)        radixMu.RLock() read     (L72-73)
      radixMu.Unlock (defer)       (L54)           t.GetValue("/"+channel)  (L78)
   [ the RWMutex lets the writer exclude readers ONLY during the swap+populate ]
```

---

## 4. Answers to Q1–Q4

All four answers draw on the same three runtime captures. The **exercised command** was:

```
go test -count=1 -v -run TestBlitzyObs ./pkg/services/live/pipeline/
```

run **three consecutive times** to satisfy the ≥2‑run stability requirement. **Run scale:** each run's `OBS‑B` phase runs for **3 seconds of wall‑clock time**, during which one writer goroutine loops `fillOrg(1)` (real rebuild‑and‑swap) while eight reader goroutines loop `Get`, reaching **millions of reads against hundreds of thousands of rebuild‑and‑swap cycles**. The **complete, unedited output of all three runs** (captured on this host — these are *observed* numbers; exact integers are host/timing dependent and differ run to run, which is expected):

```
########## RUN 1 ##########
=== RUN   TestBlitzyObs
OBS-A lazyFill: radixLenBeforeFirstGet=0 get(a/x)->ok=true err=<nil> pattern="a/x"
OBS-B atomicHandover: rebuilds=323343 reads=3982680 sawA=658539 sawB=671452 missCommon=0
--- PASS: TestBlitzyObs (3.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/live/pipeline	3.016s
########## RUN 2 ##########
=== RUN   TestBlitzyObs
OBS-A lazyFill: radixLenBeforeFirstGet=0 get(a/x)->ok=true err=<nil> pattern="a/x"
OBS-B atomicHandover: rebuilds=317426 reads=3910980 sawA=652154 sawB=655365 missCommon=0
--- PASS: TestBlitzyObs (3.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/live/pipeline	3.014s
########## RUN 3 ##########
=== RUN   TestBlitzyObs
OBS-A lazyFill: radixLenBeforeFirstGet=0 get(a/x)->ok=true err=<nil> pattern="a/x"
OBS-B atomicHandover: rebuilds=331453 reads=4091529 sawA=684011 sawB=685036 missCommon=0
--- PASS: TestBlitzyObs (3.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/live/pipeline	3.015s
```

**Stability:** across all three runs the invariants hold — `radixLenBeforeFirstGet=0` every run; `missCommon=0` every run; `sawA` and `sawB` both large (~650k–685k each); `reads` ~3.9–4.1M; `rebuilds` ~317k–331k. The values are stable in *kind* across runs, satisfying the ≥2‑run rule.

---

### Q1 / R1 — Where does the flow first take shape, and how do concurrent refresh + subscriber activity settle into a consistent state?

**Direct answer.** The flow first takes shape in the constructor **`NewCacheSegmentedTree`** (`rule_cache_segmented.go:19-26`). It does two things: it seeds an **empty** per‑org map — `radix: map[int64]*tree.Node{}` (`rule_cache_segmented.go:21`) — and it immediately launches the single background refresher goroutine — `go s.updatePeriodically()` (`rule_cache_segmented.go:24`). The subscriber side enters at **`Get`** (`rule_cache_segmented.go:62-83`). Crucially, an org's tree does **not** exist until the first `Get` for that org triggers a **lazy fill**: `Get` takes `radixMu.RLock()`, checks presence (`rule_cache_segmented.go:63-65`), and on a miss calls `s.fillOrg(orgID)` (`rule_cache_segmented.go:66-71`, the `fillOrg` call is at L67) to build the tree before serving. Concurrent refresh and subscriber activity settle into a consistent state because **both the periodic writer and the lazy‑fill reader funnel their mutation through the same `fillOrg` method**, whose swap is serialized by `radixMu` (the writer excludes readers only for the duration of the swap+populate).

**Exercised command & observed evidence** (the `OBS‑A` line proves lazy fill):

```
go test -count=1 -v -run TestBlitzyObs ./pkg/services/live/pipeline/
```

```
OBS-A lazyFill: radixLenBeforeFirstGet=0 get(a/x)->ok=true err=<nil> pattern="a/x"
```

**How to read it.** The harness constructs the cache with the real `NewCacheSegmentedTree` and, **before any `Get`**, inspects the private map length: `radixLenBeforeFirstGet=0` — the org's tree genuinely does not exist yet (the constructor seeded an empty map at `rule_cache_segmented.go:21`). The very first `Get(1, "a/x")` then returns `ok=true` with `pattern="a/x"` — i.e. the call itself lazily populated org 1 via `fillOrg` (`rule_cache_segmented.go:67`) and matched. This is the "settling" behavior: activity on a cold org converges to a populated, queryable tree through the first read.

**Causal reason.** `NewCacheSegmentedTree` deliberately does **no** eager population — it only starts the refresher (`rule_cache_segmented.go:24`). `updatePeriodically` (`rule_cache_segmented.go:28-43`) can only refresh orgs that are *already keys* in `radix` (it iterates `for orgID := range s.radix` at L32), so a brand‑new org would never be refreshed until something puts it in the map. `Get`'s lazy fill (`rule_cache_segmented.go:66-71`) is what first inserts the org, after which the periodic writer keeps it fresh. The two paths cannot corrupt each other because both mutate only inside `fillOrg`'s write‑locked section.

---

### Q2 / R2 — When does the old routing view "loosen its hold" and a new one take over, and what decides which view is authoritative?

**Direct answer.** The old view loosens its hold at exactly one instruction: **`s.radix[orgID] = tree.New()`** in `fillOrg` (`rule_cache_segmented.go:55`), executed while holding `radixMu.Lock()` (acquired at `rule_cache_segmented.go:53`, released by `defer` at L54). That single map‑entry reassignment replaces the entire previous per‑org tree with a brand‑new empty one, which is then repopulated by the `AddRoute` loop (`rule_cache_segmented.go:56-58`) under the *same* lock hold. **The authoritative view at any instant is simply whatever `radix[orgID]` points to when observed under `radixMu`** — there is no version counter, no generation id, no flag: authority is defined positionally by the map entry, and the `RWMutex` is what makes "observed under the mutex" well defined.

**Exercised command & observed evidence** (the `sawA`/`sawB` counters prove the view flips whole):

```
go test -count=1 -v -run TestBlitzyObs ./pkg/services/live/pipeline/
```

```
OBS-B atomicHandover: rebuilds=323343 reads=3982680 sawA=658539 sawB=671452 missCommon=0
```

**How to read it.** The harness's builder alternates rulesets on each `BuildRules` call: **ruleset A** (odd calls) contains the distinct pattern `a/x`, **ruleset B** (even calls) contains the distinct pattern `b/y`; both always contain the invariant `common/z`. As `fillOrg` swaps the tree ~323k times, readers see the distinct pattern flip between the two views: `sawA=658539` (reads that matched `a/x`) and `sawB=671452` (reads that matched `b/y`) are **both large and comparable**. That is the observable signature of the authoritative view changing wholesale between rebuilds — a reader that catches ruleset A matches `a/x` but not `b/y`, and vice‑versa; it never sees a blend. (Run 2: `sawA=652154 sawB=655365`; Run 3: `sawA=684011 sawB=685036` — same story.)

**Causal reason.** Because the whole tree is replaced by one pointer assignment (`rule_cache_segmented.go:55`) rather than mutated field‑by‑field, the handover is atomic *from a reader's perspective*: a reader holding `RLock` either read the map entry before the writer's `Lock` (seeing the old tree in full) or after the writer's `Unlock` (seeing the new tree in full). The Go memory model formalizes this — a writer's `Unlock` is ordered ahead of (happens‑before) any subsequent `RLock` (see §7) — so `radix[orgID]` is never observed mid‑transition.

**Sibling contrast.** This whole‑structure swap is what makes `CacheSegmentedTree` distinctive. The sibling components mutate their maps **in place** instead: `runstream/manager.go` edits entries under `s.mu.Lock()` (e.g. `runstream/manager.go:160`, `:336`) and refreshes via `time.NewTicker` (`runstream/manager.go:179`, `:181`); `managedstream/runner.go` edits its stream/rate maps under `r.mu.Lock()` (`managedstream/runner.go:119`) and `s.rateMu.Lock()` (`managedstream/runner.go:206`). Only `CacheSegmentedTree` throws away the entire per‑org tree and rebuilds it (§6).

---

### Q3 / R3 — Does the system ever briefly expose an incomplete/partial route, or does it preserve a stable snapshot?

**Direct answer.** It **never exposes an incomplete/partial route.** Consumers always receive a **complete, stable snapshot.** The reason is that the two mutating steps — assigning the empty tree `s.radix[orgID] = tree.New()` (`rule_cache_segmented.go:55`) and repopulating it with every route via the `AddRoute` loop (`rule_cache_segmented.go:56-58`) — occur under the **same single `radixMu.Lock()` hold** (acquired at L53, released by the deferred `Unlock` at L54). A reader in `Get` must take `radixMu.RLock()` (`rule_cache_segmented.go:72`) to read the tree, and the write lock excludes all readers for the whole swap+populate; therefore no reader can ever observe the empty intermediate tree or a partially‑added set of routes. The *only* inconsistency a consumer can observe is **bounded staleness** — routes up to one refresh interval old — not partial routes.

**Exercised command & observed evidence** (the `missCommon=0` invariant is the proof):

```
go test -count=1 -v -run TestBlitzyObs ./pkg/services/live/pipeline/
```

```
OBS-B atomicHandover: rebuilds=323343 reads=3982680 sawA=658539 sawB=671452 missCommon=0
```

**How to read it.** The pattern `common/z` is present in **both** rulesets, so a *correct* atomic swap means it must be matchable at **every** instant — before, during (from a reader's view there is no "during"), and after each rebuild. `missCommon` counts reads where `Get(1, "common/z")` returned `ok=false`. It is **`0`** — across **~323k rebuild‑and‑swap cycles concurrent with ~3.98M reads** in run 1, and again `0` in runs 2 and 3 (`reads=3910980` and `reads=4091529` respectively). If the swap were *not* atomic — if a reader could catch the tree after `tree.New()` (L55) but before `AddRoute` re‑added `common/z` (L56‑58) — `missCommon` would be non‑zero. It never is. That is direct runtime proof of "stable snapshot, never partial."

**Corroborating proof — the `-race` detector.** As a second, independent atomicity proof, the same harness was run under Go's race detector:

```
CGO_ENABLED=1 go test -race -count=1 -v -run TestBlitzyObs ./pkg/services/live/pipeline/
```

```
===== gcc/cc + CGO env =====
/usr/bin/gcc
/usr/bin/cc
1
gcc
gcc (Ubuntu 15.2.0-4ubuntu4) 15.2.0
===== -race run =====
=== RUN   TestBlitzyObs
OBS-A lazyFill: radixLenBeforeFirstGet=0 get(a/x)->ok=true err=<nil> pattern="a/x"
OBS-B atomicHandover: rebuilds=107089 reads=802323 sawA=135192 sawB=134476 missCommon=0
--- PASS: TestBlitzyObs (3.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/live/pipeline	4.044s
```

The run **passes cleanly with zero `DATA RACE` reports** and `missCommon=0`, confirming there is no unsynchronized access to `radix` between the writer and readers. The lower counts (`reads=802323` vs ~4M) are the **expected overhead of race instrumentation**, not a behavioral change. (Primary vs corroborating: the invariant probe `missCommon=0` is the **primary, portable** proof because it works with or without cgo; the `-race` clean pass is a corroborating proof that happens to be available on this host — see the honesty note in §8.)

**Causal reason & bounded staleness.** Completeness comes from the single‑lock‑hold rebuild (`rule_cache_segmented.go:53-58`). Staleness is bounded by two source constants: the writer sleeps `time.Sleep(20 * time.Second)` between full passes (`rule_cache_segmented.go:42`), and each build is capped by `context.WithTimeout(context.Background(), 5*time.Second)` (`rule_cache_segmented.go:47`). So between refreshes a reader may serve routes up to ~one interval old — a *stale but complete* snapshot, which is the deliberate trade‑off.

---

### Q4 / R4 — How do fast‑moving subscriber requests and periodic background updates weave together without losing routing integrity?

**Direct answer.** They are woven together by the single **`sync.RWMutex` named `radixMu`** (`rule_cache_segmented.go:14`). It admits **either many concurrent `Get` readers or a single `fillOrg` writer** at a time. Integrity is preserved by three deliberate choices: (1) the expensive rule build runs **off‑lock** — `s.ruleBuilder.BuildRules(ctx, orgID)` is called at `rule_cache_segmented.go:49`, *before* `radixMu.Lock()` at L53; (2) the write lock is held **only** for the swap+populate (`rule_cache_segmented.go:53-58`), keeping the readers‑excluded window as short as possible; and (3) all reads go through `radixMu.RLock()` (`rule_cache_segmented.go:63`, `:72`), so they parallelize freely whenever no writer is mid‑swap.

**Exercised command & observed evidence** (the raw read/rebuild throughput with zero integrity loss):

```
go test -count=1 -v -run TestBlitzyObs ./pkg/services/live/pipeline/
```

```
OBS-B atomicHandover: rebuilds=323343 reads=3982680 sawA=658539 sawB=671452 missCommon=0
```

**How to read it.** With eight reader goroutines and one writer goroutine running for 3 seconds, the layer sustained **~3.98M reads interleaved with ~323k rebuild‑and‑swap cycles** — and lost **zero** routing integrity (`missCommon=0`, and both `sawA`/`sawB` large, meaning reads kept matching correctly against whichever view was current). The reads:writes ratio of roughly **12:1** (≈3.98M : ≈323k) is exactly the read‑heavy regime `RWMutex` is designed for. This weaving is stable across all three runs (§4).

**Causal reason.** If `BuildRules` were called *inside* the write‑locked section, every rebuild would block all readers for the full build duration (up to the 5‑second timeout at `rule_cache_segmented.go:47`). By doing the heavy work off‑lock (`rule_cache_segmented.go:49`) and holding `radixMu` only for the pointer swap + `AddRoute` loop (`rule_cache_segmented.go:53-58`), the writer's exclusive window is tiny relative to the build, which is why millions of reads still get through. The `RWMutex` guarantees that during that tiny window readers wait rather than observe a torn tree — and the moment the writer's deferred `Unlock` (L54) fires, waiting readers proceed against the new complete view.

**Sibling contrast.** The two sibling caches also reconcile readers/writers with a `sync.RWMutex` (`runstream/manager.go:52`; `managedstream/runner.go:40`, plus a second `rateMu` at `:142`), so the *reader/writer discipline* is a shared convention across Grafana Live. What is unique to `CacheSegmentedTree` is combining that discipline with an off‑lock build and a whole‑tree swap, rather than in‑place edits (§6).

### Secondary paths — edge, error, and transitional states (Rule R7 coverage)

The primary Q1–Q4 answers above cover the happy path. The routing layer also has three implied **secondary / edge / error / transitional** states, each exercised run‑first with a **second temporary in‑package harness** (`pkg/services/live/pipeline/blitzy_adhoc_test_edge_test.go`, `package pipeline`) that drives the real `NewCacheSegmentedTree`, the real `Get`, and the real `updatePeriodically` goroutine. **Exercised command** (run **twice** for stability; the *complete, unedited* output of both runs is in §10.5, the harness source verbatim in §10.4; the harness was **removed after use** and `git status` verified clean — see §8):

```
go test -count=1 -v -run 'TestBlitzyObsErrWrap|TestBlitzyObsNoMatch|TestBlitzyObsPeriodicLogContinue' ./pkg/services/live/pipeline/
```

**(a) `Get` lazy‑fill error is wrapped — `rule_cache_segmented.go:69`.** When a subscriber `Get` triggers a lazy fill (`rule_cache_segmented.go:66-71`) and the off‑lock `BuildRules` fails, `Get` neither panics nor returns a bare error — it returns `nil, false, fmt.Errorf("error filling org: %w", err)` at `rule_cache_segmented.go:69`, wrapping the cause. Observed line (builder whose `BuildRules` always errors):

```
OBS-C errWrap: get(1,"a/x") on always-failing builder -> ruleIsNil=true ok=false err="error filling org: boom: simulated BuildRules failure"
```

*How to read it / causal reason.* The error string is exactly `error filling org: boom: simulated BuildRules failure`: the `error filling org: ` prefix is the literal wrap text at `rule_cache_segmented.go:69`, and `boom: simulated BuildRules failure` is the underlying `BuildRules` error surfaced through `%w` (so it is recoverable via `errors.Unwrap`/`errors.Is`). `ok=false` with a nil rule gives the caller a clean, inspectable failure. Because `fillOrg` returns at `rule_cache_segmented.go:50-51` **before** ever taking the write lock, a `Get`‑time build failure never touches `radix` — it cannot corrupt or partially populate the tree.

**(b) A populated org queried on an unmatched channel returns `(nil, false, nil)` — `rule_cache_segmented.go:79-80`.** After a successful fill, querying a channel that matches no route is **not** an error: `Get` reads the tree under `RLock`, calls `t.GetValue("/"+channel, true)` (`rule_cache_segmented.go:78`), finds `nodeValue.Handler == nil`, and returns `nil, false, nil` at `rule_cache_segmented.go:79-80` — the deterministic "no route" signal of the radix matcher (per `tree/readme.md`, a request matches exactly one route or none). Observed lines (builder publishing only pattern `a/x`):

```
OBS-D match:   get(1,"a/x")            -> pattern="a/x" ok=true err=<nil>
OBS-D noMatch: get(1,"no/such/channel") -> ruleIsNil=true ok=false err=<nil>
```

*How to read it / causal reason.* The first `Get(1, "a/x")` proves a successful lazy fill and match (`ok=true`, `pattern="a/x"`). The second `Get(1, "no/such/channel")` on the **now‑populated** org returns `ruleIsNil=true ok=false err=<nil>` — the distinguishing signature of the `rule_cache_segmented.go:79-80` path: `bool=false` means "no rule matched" while `error=nil` means "nothing went wrong." This is precisely how a caller tells an **unmatched channel** (`false, nil`) apart from a **fill failure** (`false, <wrapped error>` from case (a)).

**(c) A periodic‑refresh `BuildRules` failure is logged, and the loop continues — `rule_cache_segmented.go:38-40`.** The single background writer `updatePeriodically` (`rule_cache_segmented.go:28-43`) refreshes each known org via `fillOrg`; if one org's refresh returns an error it calls `logger.Error("Error filling orgId", "error", err, "orgId", orgID)` at `rule_cache_segmented.go:39` and **continues** to the next org (then keeps looping). This was exercised through the **real** `updatePeriodically` goroutine (launched by the constructor at `rule_cache_segmented.go:24`), with the package logger routed to stdout via the canonical operator API `log.SetupConsoleLogger("info")` — necessary because the *default* root logger discards output (`pkg/infra/log/log.go:50-54`); the L38‑40 code path is real and unmodified, only the log **sink** is configured, exactly as a running server's `[log.console]` config does. Two orgs are primed, org 1 is then flipped to fail while org 2 keeps succeeding, and the test waits ~24s to span at least one periodic pass (`time.Sleep(20 * time.Second)` at `rule_cache_segmented.go:42`). Observed lines (run 1; run 2 in §10.5 is identical in kind):

```
OBS-E prime:   org1Get(ok=true) org2Get(ok=true) org2Calls=1
OBS-E flip:    failOrg1=true; waiting ~24s for a periodic pass (updatePeriodically sleeps 20s at rule_cache_segmented.go:42)
logger=live.pipeline t=2026-07-08T04:50:42.709316292Z level=error msg="Error filling orgId" error="boom: simulated BuildRules failure for org 1" orgId=1
logger=live.pipeline t=2026-07-08T04:51:02.720954994Z level=error msg="Error filling orgId" error="boom: simulated BuildRules failure for org 1" orgId=1
OBS-E after:   org1Get(ok=true pattern="a/x") org2Get(ok=true) org1Fails=2 org2Calls=3
```

*How to read it / causal reason.* The two `logger=live.pipeline … level=error msg="Error filling orgId" … orgId=1` lines are the **real** `logger.Error` emissions from `rule_cache_segmented.go:39` — one per periodic pass — and their timestamps are ~20s apart (`04:50:42` → `04:51:02`), exactly the `time.Sleep(20 * time.Second)` interval at `rule_cache_segmented.go:42`. Crucially the loop **continued** past each error: `org2Calls` rose from `1` (priming) to `3` (two periodic refreshes of org 2), and `org2Get(ok=true)` confirms org 2 stayed queryable. Meanwhile `org1Get(ok=true pattern="a/x")` shows org 1 **still serves its previous rule** even though its own refresh failed — because `fillOrg` returns at `rule_cache_segmented.go:50-51` **before** the `s.radix[orgID] = tree.New()` swap (`rule_cache_segmented.go:55`), so a failed refresh leaves the old snapshot intact (a *stale but complete* view, consistent with the Q3 bounded‑staleness answer). This is stable across both runs (§10.5): `org1Fails=2`, `org2Calls=3`, org 1 stale‑preserved, org 2 refreshed, and two log lines ~20s apart; only the wall‑clock timestamps differ run‑to‑run.

---

## 5. The wiring finding — why direct construction is the *canonical* entry point (not a bypass)

A project rule requires exercising the real code path through its real entry point, and labeling anything non‑canonical. The following finding establishes that constructing `NewCacheSegmentedTree(builder)` directly (as the harness does) **is** canonical:

- `NewCacheSegmentedTree` is invoked in **non‑test production code only inside the dry‑run HTTP handler** `HandlePipelineConvertTestHTTP` — the function begins at `pkg/services/live/live.go:1123`, builds a `StorageRuleBuilder` (`live.go:1136-1142`), wraps it via `channelRuleGetter := pipeline.NewCacheSegmentedTree(builder)` (`live.go:1143`), then constructs `pipeline.New(channelRuleGetter)` (`live.go:1144`) and calls `.Get(...)`.
- The service field is declared as `Pipeline *pipeline.Pipeline` at `pkg/services/live/live.go:411`, but it is **never assigned anywhere in production**. A repo‑wide search for an assignment (`grep -rn "\.Pipeline\s*=" pkg/` excluding `pipeline.go`/tests, plus a `Pipeline:` struct‑literal search in `pkg/services/live/`) returns **nothing**.
- Consequently the subscriber path is nil‑guarded. `handleOnSubscribe` is at `live.go:613`; the guard `if g.Pipeline != nil` appears at `live.go:638` (also `:735`, `:969`) gating `g.Pipeline.Get(...)` at `live.go:639` (also `:736`, `:970`). In a **default server build the field is nil, so the cache is inactive** on the subscriber path.

**Conclusion (stated in the doc per the rule):** because `g.Pipeline` is unset in a default build, the canonical ways to drive the routing layer at runtime are (1) **construct `NewCacheSegmentedTree(builder)` directly and call `Get`** — exactly what the canonical unit test `rule_cache_segmented_test.go` does (`TestStorage_Get` constructs via `NewCacheSegmentedTree(&testBuilder{})` at `rule_cache_segmented_test.go:34`), and exactly what this investigation's harness does — or (2) the `HandlePipelineConvertTestHTTP` dry‑run endpoint. The harness is therefore a **canonical** driver of the real path, **not** a debug hook, fallback, or synthetic stand‑in. It calls the real exported constructor, the real exported `Get`, and the real unexported `fillOrg` (the same method `updatePeriodically` calls at `rule_cache_segmented.go:37`).

---

## 6. Sibling contrast — in‑place mutation vs. rebuild‑and‑swap

To make the "rebuild‑and‑swap" property concrete, contrast `CacheSegmentedTree` with two sibling Grafana Live components that also use `sync.RWMutex` over maps but **mutate their maps in place** rather than swapping whole structures:

| Component | Lock(s) | Refresh style | Mutation style |
|-----------|---------|---------------|----------------|
| `pipeline.CacheSegmentedTree` (`rule_cache_segmented.go`) | `radixMu sync.RWMutex` (`:14`) | `time.Sleep(20s)` loop in `updatePeriodically` (`:42`) | **Whole‑tree rebuild‑and‑swap**: `radix[orgID] = tree.New()` (`:55`) then repopulate (`:56-58`), all under one write‑lock hold |
| `runstream.Manager` (`runstream/manager.go`) | `mu sync.RWMutex` (`:52`) | `time.NewTicker` (`:179`, `:181`) | **In‑place**: edits map entries under `s.mu.Lock()` (`:160`, `:336`); reads under `s.mu.RLock()` (`:113`) |
| `managedstream.Runner` (`managedstream/runner.go`) | `mu sync.RWMutex` (`:40`) + `rateMu sync.RWMutex` (`:142`) | on‑demand | **In‑place**: edits under `r.mu.Lock()` (`:119`), rate map under `s.rateMu.Lock()` (`:206`) / `s.rateMu.RLock()` (`:224`) |

**The crux.** Only `CacheSegmentedTree` replaces an entire per‑org tree atomically — a brand‑new `tree.New()` (`rule_cache_segmented.go:55`) is populated and installed under a single `radixMu.Lock()` hold, so "the old view loosens its hold and a new one takes over" (Q2) in one indivisible step, and consumers see a "stable snapshot, never partial" (Q3). The siblings edit entries within an existing map, so their notion of a consistent view is per‑entry rather than per‑whole‑structure. This is *inferred* from reading their source (the lock/ticker line references above are verified); I did not run the siblings, since the question concerns the routing cache specifically.

Why the swap is even necessary: the radix tree (`tree/tree.go`) is **not** concurrency‑safe on its own (its `New`/`AddRoute`/`GetValue` at `tree.go:70`/`:116`/`:384` do no internal locking), and its matcher is deterministic and explicit‑only — per `tree/readme.md`, a request matches exactly one or no route, with support for named parameters (`:metric`) and catch‑all (`*rest`). Rebuilding a fresh tree and swapping it wholesale is the simplest way to update such a structure without ever exposing an inconsistent intermediate.

---

## 7. Is this idiomatic? (web validation)

The observed design — a `map` guarded by `sync.RWMutex`, heavy work done off‑lock, and a whole‑value swap under the write lock — is a textbook read‑heavy, periodically‑refreshed cache pattern. Validation against authoritative sources (≤1 short quote per source; otherwise paraphrased):

- **Official Go `sync` documentation** ([pkg.go.dev/sync](https://pkg.go.dev/sync)) is the primary reference. It documents that an `RWMutex` may be held by any number of readers or a single writer, and that once a goroutine calls `Lock`, subsequent `RLock` calls block until the writer has acquired and released the lock. The Go source comment states it plainly: "The lock can be held by an arbitrary number of readers or a single writer." This is exactly why `fillOrg`'s write‑locked swap (`rule_cache_segmented.go:53-58`) is atomic with respect to `Get` readers.
- **Go memory model guarantee** (same `sync` docs, paraphrased): the n'th `Unlock` is ordered ahead of the m'th `Lock` for `n < m`, and for any `RLock` there is an `Unlock` that is ordered ahead of it. This is the formal basis for the Q3 claim that an `RLock` reader observes *either* the pre‑swap *or* the post‑swap tree, never a mid‑write state.
- **map + `RWMutex` is the recommended general‑purpose concurrent‑map pattern**, as opposed to `sync.Map`. The official docs note `sync.Map` is optimized for write‑once/read‑many or disjoint‑key workloads — which is **not** this cache's pattern (it overwrites the *same* per‑org key on every refresh). A widely‑cited write‑up puts it directly: "For most applications, a regular map with an sync.RWMutex is a better choice." ([pratikpandey.substack.com](https://pratikpandey.substack.com/p/dive-deep-series-syncmap-in-golang)). A practitioner guide agrees that mutex‑protected maps are more flexible and often faster for general‑purpose concurrent access, and recommends the `RWMutex`‑map when the same keys are updated repeatedly ([oneuptime.com](https://oneuptime.com/blog/post/2026-01-25-sync-map-vs-mutex-maps-go/view)). This validates the choice of `radixMu` (`rule_cache_segmented.go:14`) over a lock‑free structure.
- **Doing heavy work off‑lock and keeping critical sections short** is documented best practice; naively releasing a read lock and re‑taking a write lock to publish a result breaks atomicity, whereas computing off‑lock and installing under one exclusive hold does not ([upstash.com](https://upstash.com/blog/upgradable-rwlock-for-go)). This validates calling `BuildRules` before `radixMu.Lock()` (`rule_cache_segmented.go:49` then `:53`).
- **`RWMutex` is preferred when reads greatly outnumber writes** — as one guide summarizes, "RWMutex handles a specific case: when reads are more common than writes." ([dev.to/shrsv](https://dev.to/shrsv/mutex-vs-rwmutex-in-golang-a-developers-guide-2mb)). The observed ~12:1 read:write ratio (§4) is squarely in that regime.

Framed in this document's own words: lookups and the whole‑tree swap are atomic and consistent, so consumers never observe half‑modified state — precisely the "stable snapshot, never partial" property the question asks about.

---

## 8. Constraints & honesty notes

- **`-race` is available on this host (correction to the task's stated assumption).** The task scoping assumed the race detector could not run because there was no C compiler for cgo. That is **false on this host**: `gcc (Ubuntu 15.2.0-4ubuntu4) 15.2.0` is present at `/usr/bin/gcc`, `CGO_ENABLED=1`, and `CC=gcc`, so `-race` **runs and passes clean** (§4, §10). Reporting exactly what was observed: the corroborating `-race` proof *is* included. Nonetheless the **primary** atomicity proof is the portable invariant probe (`missCommon=0`), which does not depend on cgo. (The observed gcc is `15.2.0`; an illustrative `13.3.0` mentioned during scoping was not what this host reports.)
- **Observed counts are host‑ and timing‑specific.** The integer counts (`rebuilds`, `reads`, `sawA`, `sawB`) vary run to run and machine to machine; only the **qualitative invariants** are stable and meaningful: `radixLenBeforeFirstGet=0`, `missCommon=0` in every run, and `sawA`/`sawB` both large. Any illustrative figures from scoping differ from these observed numbers — that is expected and required by the run‑first methodology.
- **Staleness is bounded, not eliminated.** The design guarantees *complete* snapshots, not *fresh* ones. Between refreshes a reader may serve routes up to one refresh interval old, governed by `time.Sleep(20 * time.Second)` (`rule_cache_segmented.go:42`) and the per‑build `5*time.Second` context timeout (`rule_cache_segmented.go:47`).
- **`fmt.Errorf` line correction.** The lazy‑fill error wrap in `Get` is `fmt.Errorf("error filling org: %w", err)` at **`rule_cache_segmented.go:69`** (an illustrative range of L66–L68 seen during scoping is off by one; the verified line is **L69**).
- **Edge/error states used a second temporary harness; the periodic logger is silent by default.** The §4 secondary paths (lazy-fill error wrap, no-match, and periodic log-and-continue) were observed with a second temporary in-package harness, `pkg/services/live/pipeline/blitzy_adhoc_test_edge_test.go` (also removed after use). The periodic `logger.Error` at `rule_cache_segmented.go:39` emits **nothing under a bare `go test`**, because the default root logger writes to `io.Discard` (`pkg/infra/log/log.go:50-54`); it was made visible with the canonical operator API `log.SetupConsoleLogger("info")` (`pkg/infra/log/log.go:519`), which routes the package logger to stdout exactly as a running server's `[log.console]` configuration does. The `updatePeriodically` L38-40 code path is real and unmodified — only the log *sink* was configured.
- **Read‑only integrity.** No existing source file was modified, added, or deleted. Two temporary in-package harnesses — `pkg/services/live/pipeline/blitzy_obs_test.go` (primary Q1-Q4 evidence, §10.1) and `pkg/services/live/pipeline/blitzy_adhoc_test_edge_test.go` (the §4 edge/error/transitional evidence, §10.4) — were created for observation, run, and then **removed**; `git status` was verified clean afterward, and `wc -l pkg/services/live/pipeline/rule_cache_segmented.go` remained **83**. This document is the only persisted new artifact.
- **Cache inactive in default build.** As established in §5, `g.Pipeline` is never assigned in production, so the routing cache is not on the live subscriber path in a default server build. The routing layer was therefore exercised via its canonical direct‑construction entry point, not a bypass.
- **Sibling behavior is inferred from reading, not run.** The §6 statements about `runstream` and `managedstream` mutating in place are *inferred* from their source (line references verified); those components were not executed because they are outside the routing‑cache question.

---

## 9. Coverage checklist

| Item | Concrete value | `file:line` | Observed evidence | Sibling/contrast | Causal reason |
|------|----------------|-------------|-------------------|------------------|---------------|
| **Q1** entry point | `NewCacheSegmentedTree` starts `go updatePeriodically()`; `Get` lazy‑fills | `rule_cache_segmented.go:19-26` (`:24`); `:62-71` (`fillOrg` call `:67`) | `radixLenBeforeFirstGet=0` → `get(a/x)->ok=true` | — | constructor does no eager fill; first `Get` inserts the org |
| **Q2** handover/authority | whole‑tree swap `radix[orgID]=tree.New()`; authoritative view = tree under `radixMu` | `rule_cache_segmented.go:53-55` | `sawA`/`sawB` both large (~650k+) | siblings mutate in place (`runstream:160`, `managedstream:119`) | single pointer reassignment ⇒ atomic from reader's view (memory model) |
| **Q3** stable vs partial | no partial exposure; bounded staleness | empty‑assign `:55` + repopulate `:56-58` under one hold; `Sleep(20s)` `:42`; `5s` timeout `:47` | `missCommon=0` across ~320k swaps + ~4M reads; `-race` clean | — | assign + repopulate share one `radixMu.Lock()` hold (`:53-54`) |
| **Q4** interleaving | `RWMutex` many readers or one writer; build off‑lock; short lock window | `radixMu` `:14`; `BuildRules` off‑lock `:49`; swap+populate `:53-58` | ~4M reads : ~320k rebuilds, `missCommon=0` | siblings share the RWMutex convention (`runstream:52`, `managedstream:40`) | heavy work off‑lock keeps the readers‑excluded window tiny |
| `fmt.Errorf` cited at **L69** | error wrap on lazy‑fill failure | `rule_cache_segmented.go:69` | `OBS-C` → `ok=false err="error filling org: …"` | — | verified L69; cause wrapped via `%w` |
| **Edge (a)** `Get` fill-error wrap | `nil, false, fmt.Errorf("error filling org: %w", err)` | `rule_cache_segmented.go:69` | `OBS-C` → `ruleIsNil=true ok=false err="error filling org: boom: …"` | — | `fillOrg` fails at `:50-51` before the swap ⇒ no partial state |
| **Edge (b)** no-match | `nil, false, nil` | `rule_cache_segmented.go:79-80` | `OBS-D noMatch` → `ok=false err=<nil>` | radix "exactly one or no route" (`tree/readme.md`) | `GetValue` handler nil ⇒ `false,nil` distinguishes a miss from an error |
| **Edge (c)** periodic log-and-continue | `logger.Error(...)`, then next org; outer loop continues | `rule_cache_segmented.go:38-40` (`:39`); sleep `:42` | `OBS-E`: two real log lines ~20s apart; `org2Calls=3`; org1 stale-preserved | siblings refresh via ticker (`runstream:179`) | error checked `:38`, logged `:39`, loop continues; failed fill preserves old tree (`:50-51`) |
| Wiring finding documented; harness labeled canonical | `Pipeline` unset in prod; construct directly | `live.go:411`, `:638-639`, `:1123`, `:1143` | grep for assignment returns nothing | canonical unit test `rule_cache_segmented_test.go:34` | — |
| Web validation present w/ quote discipline | idiomatic map+RWMutex, off‑lock build | — | §7 | — | — |
| Cleanup + `git status` clean stated | harness removed; core file 83 lines | §8 | — | — | — |
| Every behavioral claim has command + complete unedited output + `file:line` + name | — | throughout §4 | §4, §10 | — | — |

---

## 10. Appendix

### 10.1 The temporary observation harness (verbatim)

Created at `pkg/services/live/pipeline/blitzy_obs_test.go` as `package pipeline` (so it can drive the real unexported `fillOrg` and inspect the private `radix`/`radixMu` alongside the real exported `NewCacheSegmentedTree` and `Get`). **Removed after use** (see §8). Reproduced here verbatim as the instrument used:

```go
package pipeline

// TEMPORARY observation harness (Blitzy investigation). Deleted after use.
// In-package (package pipeline) so it can drive the REAL rebuild path fillOrg
// and inspect the private radix map/radixMu, alongside the real public
// NewCacheSegmentedTree constructor and real Get method.

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// obsAltBuilder is a real RuleBuilder. It alternates between two rulesets on
// each BuildRules call. BOTH rulesets always contain the invariant pattern
// "common/z"; the DISTINCT pattern is "a/x" (ruleset A, odd calls) vs "b/y"
// (ruleset B, even calls). First call (n=1, odd) => ruleset A (contains a/x).
type obsAltBuilder struct{ n atomic.Int64 }

func (b *obsAltBuilder) BuildRules(_ context.Context, _ int64) ([]*LiveChannelRule, error) {
	if b.n.Add(1)%2 == 1 {
		return []*LiveChannelRule{
			{OrgId: 1, Pattern: "a/x"},
			{OrgId: 1, Pattern: "common/z"},
		}, nil
	}
	return []*LiveChannelRule{
		{OrgId: 1, Pattern: "b/y"},
		{OrgId: 1, Pattern: "common/z"},
	}, nil
}

func TestBlitzyObs(t *testing.T) {
	// ---- OBS-A: lazy fill on a Get cache miss (R1) ----
	// Real constructor; nothing is pre-populated. Inspect radix len BEFORE the
	// first Get (expect 0), then the first Get must lazily fill org 1.
	sA := NewCacheSegmentedTree(&obsAltBuilder{})
	sA.radixMu.RLock()
	lenBefore := len(sA.radix)
	sA.radixMu.RUnlock()
	ruleA, okA, errA := sA.Get(1, "a/x")
	patA := ""
	if ruleA != nil {
		patA = ruleA.Pattern
	}
	fmt.Printf("OBS-A lazyFill: radixLenBeforeFirstGet=%d get(a/x)->ok=%v err=%v pattern=%q\n",
		lenBefore, okA, errA, patA)

	// ---- OBS-B: atomic view handover under concurrency (R2 + R3) ----
	// Real constructor + real fillOrg rebuild-and-swap (the SAME method the
	// periodic writer uses, invoked at high frequency to reach scale) racing
	// many real Get readers. Invariant probe: "common/z" is in BOTH rulesets,
	// so if the swap is atomic it must NEVER be missed (missCommon must be 0).
	s := NewCacheSegmentedTree(&obsAltBuilder{})
	_, _, _ = s.Get(1, "common/z") // prime org 1 so it is a known key

	var (
		reads, sawA, sawB, missCommon, rebuilds atomic.Int64
		stop                                    atomic.Bool
		wg                                      sync.WaitGroup
	)

	// Single periodic-style writer: real rebuild-and-swap via fillOrg.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for !stop.Load() {
			if err := s.fillOrg(1); err == nil {
				rebuilds.Add(1)
			}
		}
	}()

	// Many concurrent subscriber-style readers.
	const readers = 8
	for i := 0; i < readers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for !stop.Load() {
				if _, ok, _ := s.Get(1, "common/z"); !ok { // invariant
					missCommon.Add(1)
				}
				if _, ok, _ := s.Get(1, "a/x"); ok {
					sawA.Add(1)
				}
				if _, ok, _ := s.Get(1, "b/y"); ok {
					sawB.Add(1)
				}
				reads.Add(3)
			}
		}()
	}

	time.Sleep(3 * time.Second) // run at scale
	stop.Store(true)
	wg.Wait()

	fmt.Printf("OBS-B atomicHandover: rebuilds=%d reads=%d sawA=%d sawB=%d missCommon=%d\n",
		rebuilds.Load(), reads.Load(), sawA.Load(), sawB.Load(), missCommon.Load())
}
```

### 10.2 The code under observation (verbatim, 83 lines)

`pkg/services/live/pipeline/rule_cache_segmented.go` at HEAD `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`:

```go
package pipeline

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/grafana/grafana/pkg/services/live/pipeline/tree"
)

// CacheSegmentedTree provides a fast access to channel rule configuration.
type CacheSegmentedTree struct {
	radixMu     sync.RWMutex
	radix       map[int64]*tree.Node
	ruleBuilder RuleBuilder
}

func NewCacheSegmentedTree(storage RuleBuilder) *CacheSegmentedTree {
	s := &CacheSegmentedTree{
		radix:       map[int64]*tree.Node{},
		ruleBuilder: storage,
	}
	go s.updatePeriodically()
	return s
}

func (s *CacheSegmentedTree) updatePeriodically() {
	for {
		var orgIDs []int64
		s.radixMu.Lock()
		for orgID := range s.radix {
			orgIDs = append(orgIDs, orgID)
		}
		s.radixMu.Unlock()
		for _, orgID := range orgIDs {
			err := s.fillOrg(orgID)
			if err != nil {
				logger.Error("Error filling orgId", "error", err, "orgId", orgID)
			}
		}
		time.Sleep(20 * time.Second)
	}
}

func (s *CacheSegmentedTree) fillOrg(orgID int64) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	channels, err := s.ruleBuilder.BuildRules(ctx, orgID)
	if err != nil {
		return err
	}
	s.radixMu.Lock()
	defer s.radixMu.Unlock()
	s.radix[orgID] = tree.New()
	for _, ch := range channels {
		s.radix[orgID].AddRoute("/"+ch.Pattern, ch)
	}
	return nil
}

func (s *CacheSegmentedTree) Get(orgID int64, channel string) (*LiveChannelRule, bool, error) {
	s.radixMu.RLock()
	_, ok := s.radix[orgID]
	s.radixMu.RUnlock()
	if !ok {
		err := s.fillOrg(orgID)
		if err != nil {
			return nil, false, fmt.Errorf("error filling org: %w", err)
		}
	}
	s.radixMu.RLock()
	defer s.radixMu.RUnlock()
	t, ok := s.radix[orgID]
	if !ok {
		return nil, false, nil
	}
	nodeValue := t.GetValue("/"+channel, true)
	if nodeValue.Handler == nil {
		return nil, false, nil
	}
	return nodeValue.Handler.(*LiveChannelRule), true, nil
}
```

### 10.3 Complete, unedited outputs

**Three normal runs** — command: `go test -count=1 -v -run TestBlitzyObs ./pkg/services/live/pipeline/`

```
########## RUN 1 ##########
=== RUN   TestBlitzyObs
OBS-A lazyFill: radixLenBeforeFirstGet=0 get(a/x)->ok=true err=<nil> pattern="a/x"
OBS-B atomicHandover: rebuilds=323343 reads=3982680 sawA=658539 sawB=671452 missCommon=0
--- PASS: TestBlitzyObs (3.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/live/pipeline	3.016s
########## RUN 2 ##########
=== RUN   TestBlitzyObs
OBS-A lazyFill: radixLenBeforeFirstGet=0 get(a/x)->ok=true err=<nil> pattern="a/x"
OBS-B atomicHandover: rebuilds=317426 reads=3910980 sawA=652154 sawB=655365 missCommon=0
--- PASS: TestBlitzyObs (3.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/live/pipeline	3.014s
########## RUN 3 ##########
=== RUN   TestBlitzyObs
OBS-A lazyFill: radixLenBeforeFirstGet=0 get(a/x)->ok=true err=<nil> pattern="a/x"
OBS-B atomicHandover: rebuilds=331453 reads=4091529 sawA=684011 sawB=685036 missCommon=0
--- PASS: TestBlitzyObs (3.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/live/pipeline	3.015s
```

**`-race` run** — commands: `which gcc cc; go env CGO_ENABLED CC; gcc --version | head -1` then `CGO_ENABLED=1 go test -race -count=1 -v -run TestBlitzyObs ./pkg/services/live/pipeline/`

```
===== gcc/cc + CGO env =====
/usr/bin/gcc
/usr/bin/cc
1
gcc
gcc (Ubuntu 15.2.0-4ubuntu4) 15.2.0
===== -race run =====
=== RUN   TestBlitzyObs
OBS-A lazyFill: radixLenBeforeFirstGet=0 get(a/x)->ok=true err=<nil> pattern="a/x"
OBS-B atomicHandover: rebuilds=107089 reads=802323 sawA=135192 sawB=134476 missCommon=0
--- PASS: TestBlitzyObs (3.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/live/pipeline	4.044s
```

**Canonical build** — command: `go build ./pkg/services/live/pipeline/ ./pkg/services/live/pipeline/tree/` → empty output, exit `0`.

### 10.4 The edge/error observation harness (verbatim)

A **second** temporary harness, created at `pkg/services/live/pipeline/blitzy_adhoc_test_edge_test.go` as `package pipeline` (so it can drive the real unexported `fillOrg`/`updatePeriodically` paths and the real package-level `logger`, alongside the real exported `NewCacheSegmentedTree` and `Get`). It exercises the secondary/edge/error/transitional states for Rule R7 coverage. **Removed after use** (see §8). Reproduced here verbatim as the instrument used:

```go
package pipeline

// TEMPORARY edge/error observation harness (Blitzy investigation). Deleted after use.
//
// In-package (package pipeline) so it drives the REAL Get / fillOrg / updatePeriodically
// paths and the REAL package-level logger, alongside the real exported constructor
// NewCacheSegmentedTree. It exercises the secondary (edge/error/transitional) states
// implied by the question, per user Rule R7:
//
//	OBS-C  Get lazy-fill error wrapping                     rule_cache_segmented.go:69
//	OBS-D  no-match returns (nil, false, nil)               rule_cache_segmented.go:79-80
//	OBS-E  periodic BuildRules failure -> log-and-continue  rule_cache_segmented.go:38-40

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/grafana/grafana/pkg/infra/log"
)

// errBuilder is a real RuleBuilder whose BuildRules ALWAYS fails. It drives the
// Get lazy-fill error path (OBS-C): Get on a cold org calls fillOrg, whose
// BuildRules error is wrapped at rule_cache_segmented.go:69.
type errBuilder struct{}

func (errBuilder) BuildRules(_ context.Context, _ int64) ([]*LiveChannelRule, error) {
	return nil, fmt.Errorf("boom: simulated BuildRules failure")
}

// okBuilder is a real RuleBuilder that returns a single rule matching pattern
// "a/x" for org 1. It drives the successful-fill-then-no-match path (OBS-D).
type okBuilder struct{}

func (okBuilder) BuildRules(_ context.Context, _ int64) ([]*LiveChannelRule, error) {
	return []*LiveChannelRule{{OrgId: 1, Pattern: "a/x"}}, nil
}

// periodicBuilder is a real RuleBuilder used to drive the periodic log-and-continue
// path (OBS-E). org 1 succeeds until failOrg1 is set, then fails on every later call;
// org 2 always succeeds. The counters let us observe that after org 1 starts failing
// the periodic loop still refreshes org 2 (i.e. it continues past the logged error).
type periodicBuilder struct {
	failOrg1  atomic.Bool
	org1Fails atomic.Int64
	org2Calls atomic.Int64
}

func (b *periodicBuilder) BuildRules(_ context.Context, orgID int64) ([]*LiveChannelRule, error) {
	if orgID == 1 {
		if b.failOrg1.Load() {
			b.org1Fails.Add(1)
			return nil, fmt.Errorf("boom: simulated BuildRules failure for org 1")
		}
		return []*LiveChannelRule{{OrgId: 1, Pattern: "a/x"}}, nil
	}
	b.org2Calls.Add(1)
	return []*LiveChannelRule{{OrgId: 2, Pattern: "c/z"}}, nil
}

// OBS-C: Get lazy-fill error wrapping (rule_cache_segmented.go:69).
func TestBlitzyObsErrWrap(t *testing.T) {
	s := NewCacheSegmentedTree(errBuilder{})
	rule, ok, err := s.Get(1, "a/x")
	errStr := "<nil>"
	if err != nil {
		errStr = err.Error()
	}
	fmt.Printf("OBS-C errWrap: get(1,\"a/x\") on always-failing builder -> ruleIsNil=%v ok=%v err=%q\n",
		rule == nil, ok, errStr)
}

// OBS-D: successful fill then unmatched channel returns (nil, false, nil)
// (rule_cache_segmented.go:79-80).
func TestBlitzyObsNoMatch(t *testing.T) {
	s := NewCacheSegmentedTree(okBuilder{})

	r1, ok1, err1 := s.Get(1, "a/x") // successful lazy fill + match
	pat := ""
	if r1 != nil {
		pat = r1.Pattern
	}
	e1 := "<nil>"
	if err1 != nil {
		e1 = err1.Error()
	}
	fmt.Printf("OBS-D match:   get(1,\"a/x\")            -> pattern=%q ok=%v err=%s\n", pat, ok1, e1)

	r2, ok2, err2 := s.Get(1, "no/such/channel") // populated org, unmatched channel
	e2 := "<nil>"
	if err2 != nil {
		e2 = err2.Error()
	}
	fmt.Printf("OBS-D noMatch: get(1,\"no/such/channel\") -> ruleIsNil=%v ok=%v err=%s\n",
		r2 == nil, ok2, e2)
}

// OBS-E: periodic BuildRules failure -> log-and-continue (rule_cache_segmented.go:38-40).
// Uses the REAL updatePeriodically goroutine launched by the constructor, and the REAL
// package-level logger routed to stdout via the canonical operator API SetupConsoleLogger.
func TestBlitzyObsPeriodicLogContinue(t *testing.T) {
	// Canonical logging setup (what an operator does via the [log]/[log.console] config).
	// Without it, the default root logger discards output (pkg/infra/log/log.go:50-54).
	if err := log.SetupConsoleLogger("info"); err != nil {
		t.Fatalf("SetupConsoleLogger: %v", err)
	}

	b := &periodicBuilder{}
	s := NewCacheSegmentedTree(b) // starts `go s.updatePeriodically()`

	// Prime org 1 and org 2 (both succeed) so both become keys the periodic writer refreshes.
	_, ok1, _ := s.Get(1, "a/x")
	_, ok2, _ := s.Get(2, "c/z")
	fmt.Printf("OBS-E prime:   org1Get(ok=%v) org2Get(ok=%v) org2Calls=%d\n",
		ok1, ok2, b.org2Calls.Load())

	// Flip org 1 to fail on subsequent BuildRules calls; the periodic refresh will hit it.
	b.failOrg1.Store(true)
	fmt.Printf("OBS-E flip:    failOrg1=true; waiting ~24s for a periodic pass "+
		"(updatePeriodically sleeps 20s at rule_cache_segmented.go:42)\n")

	time.Sleep(24 * time.Second) // guarantee at least one periodic pass runs while org 1 fails

	// After the failing periodic pass:
	//   - org 1 must STILL serve its old rule (a failed fillOrg returns before the swap at
	//     rule_cache_segmented.go:50-51, so the previous snapshot is preserved), and
	//   - org 2 must still be refreshed (org2Calls increased => the loop CONTINUED past org 1).
	r1, ok1After, _ := s.Get(1, "a/x")
	pat1 := ""
	if r1 != nil {
		pat1 = r1.Pattern
	}
	_, ok2After, _ := s.Get(2, "c/z")
	fmt.Printf("OBS-E after:   org1Get(ok=%v pattern=%q) org2Get(ok=%v) org1Fails=%d org2Calls=%d\n",
		ok1After, pat1, ok2After, b.org1Fails.Load(), b.org2Calls.Load())
}
```

### 10.5 Edge/error complete, unedited outputs

**Two runs** — command: `go test -count=1 -v -run 'TestBlitzyObsErrWrap|TestBlitzyObsNoMatch|TestBlitzyObsPeriodicLogContinue' ./pkg/services/live/pipeline/` (the `##########` lines are run separators; timestamps differ run-to-run, all other values are stable):

```
########## EDGE RUN 1 ##########
=== RUN   TestBlitzyObsErrWrap
OBS-C errWrap: get(1,"a/x") on always-failing builder -> ruleIsNil=true ok=false err="error filling org: boom: simulated BuildRules failure"
--- PASS: TestBlitzyObsErrWrap (0.00s)
=== RUN   TestBlitzyObsNoMatch
OBS-D match:   get(1,"a/x")            -> pattern="a/x" ok=true err=<nil>
OBS-D noMatch: get(1,"no/such/channel") -> ruleIsNil=true ok=false err=<nil>
--- PASS: TestBlitzyObsNoMatch (0.00s)
=== RUN   TestBlitzyObsPeriodicLogContinue
OBS-E prime:   org1Get(ok=true) org2Get(ok=true) org2Calls=1
OBS-E flip:    failOrg1=true; waiting ~24s for a periodic pass (updatePeriodically sleeps 20s at rule_cache_segmented.go:42)
logger=live.pipeline t=2026-07-08T04:50:42.709316292Z level=error msg="Error filling orgId" error="boom: simulated BuildRules failure for org 1" orgId=1
logger=live.pipeline t=2026-07-08T04:51:02.720954994Z level=error msg="Error filling orgId" error="boom: simulated BuildRules failure for org 1" orgId=1
OBS-E after:   org1Get(ok=true pattern="a/x") org2Get(ok=true) org1Fails=2 org2Calls=3
--- PASS: TestBlitzyObsPeriodicLogContinue (24.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/live/pipeline	24.019s
########## EDGE RUN 2 ##########
=== RUN   TestBlitzyObsErrWrap
OBS-C errWrap: get(1,"a/x") on always-failing builder -> ruleIsNil=true ok=false err="error filling org: boom: simulated BuildRules failure"
--- PASS: TestBlitzyObsErrWrap (0.00s)
=== RUN   TestBlitzyObsNoMatch
OBS-D match:   get(1,"a/x")            -> pattern="a/x" ok=true err=<nil>
OBS-D noMatch: get(1,"no/such/channel") -> ruleIsNil=true ok=false err=<nil>
--- PASS: TestBlitzyObsNoMatch (0.00s)
=== RUN   TestBlitzyObsPeriodicLogContinue
OBS-E prime:   org1Get(ok=true) org2Get(ok=true) org2Calls=1
OBS-E flip:    failOrg1=true; waiting ~24s for a periodic pass (updatePeriodically sleeps 20s at rule_cache_segmented.go:42)
logger=live.pipeline t=2026-07-08T04:51:09.538030982Z level=error msg="Error filling orgId" error="boom: simulated BuildRules failure for org 1" orgId=1
logger=live.pipeline t=2026-07-08T04:51:29.547758937Z level=error msg="Error filling orgId" error="boom: simulated BuildRules failure for org 1" orgId=1
OBS-E after:   org1Get(ok=true pattern="a/x") org2Get(ok=true) org1Fails=2 org2Calls=3
--- PASS: TestBlitzyObsPeriodicLogContinue (24.00s)
PASS
ok  	github.com/grafana/grafana/pkg/services/live/pipeline	24.018s
```

---

*End of document. Deliverable: `blitzy/documentation/grafana_4550cfb5b728.md`. Source repository left unchanged (read‑only investigation); the temporary harness was removed and `git status` verified clean.*

