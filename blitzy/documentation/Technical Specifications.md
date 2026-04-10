# Technical Specification

# 0. Agent Action Plan

## 0.1 Intent Clarification

### 0.1.1 Core Documentation Objective

Based on the provided requirements, the Blitzy platform understands that the documentation objective is to **create a new, comprehensive investigative document** that explains how the Grafana Live streaming routing layer maintains coherence while actively running — specifically how the routing rule cache refreshes in the background while users concurrently join and leave channels, how transitions between old and new routing views are handled, what decides which view is authoritative at any given instant, and whether stale or incomplete routes are ever exposed to consumers during periods of subscription surges and rapid rule changes.

- **Category:** Create new documentation
- **Documentation type:** Architecture deep-dive / Technical explainer

The user's requirements, restated with technical precision:

- **Routing table refresh coherence:** Explain how `CacheSegmentedTree` in `pkg/services/live/pipeline/rule_cache_segmented.go` rebuilds per-organization radix trees every 20 seconds via `updatePeriodically()`, and how the old routing view continues serving reads under `sync.RWMutex` until the new tree is atomically swapped in by `fillOrg()`.
- **Concurrent subscription/unsubscription safety:** Document how `handleOnSubscribe` and `handleOnPublish` in `pkg/services/live/live.go` resolve channel handlers concurrently, how the double-check locking pattern in `GetChannelHandler` prevents race conditions, and how the semaphore-gated `runConcurrentlyIfNeeded` caps per-client concurrency at 12 goroutines.
- **Old-to-new routing transition:** Explain the "snapshot replacement" model where `fillOrg()` creates a fresh `tree.New()`, populates it with all routes via `AddRoute`, then replaces the old tree under write lock — meaning there is never a partially-constructed tree visible to readers.
- **Stale route exposure:** Clarify that between refresh cycles (up to 20 seconds), the previous routing snapshot continues serving all lookups, and that this is a deliberate design choice offering bounded staleness in exchange for zero contention on the hot read path.
- **Stream lifecycle under churn:** Document how `runstream.Manager` serializes stream registrations through a single `registerCh` channel, how `watchStream` closes idle streams after `maxChecks` (3) presence checks at 5-second intervals, and how `HandleDatasourceUpdate` stops and resubmits streams atomically.

### 0.1.2 Special Instructions and Constraints

- **CRITICAL — Repository immutability:** The user explicitly states "the repository itself should remain unchanged and anything temporary should be cleaned up afterward." No existing files may be modified.
- **Implementation rule (SWE-AtlasQnA-Repo):** The output must be a single new markdown document named `grafana_4550cfb5b728.md` placed in the `blitzy/documentation` directory. It must comprehensively answer the questions posed and provide reasoning grounded in the codebase.
- **Observational tone:** The user's language suggests they want an intuitive feel — the document should balance precise code citations with explanatory narrative that makes the concurrency model accessible.
- **No attachments or Figma designs** were provided.

### 0.1.3 Technical Interpretation

These documentation requirements translate to the following technical documentation strategy:

- To document **routing table refresh coherence**, we will create a section in `blitzy/documentation/grafana_4550cfb5b728.md` that traces through `CacheSegmentedTree.updatePeriodically()` → `fillOrg()` → `tree.New()` + `AddRoute` → atomic replacement under `radixMu.Lock()`, with a Mermaid sequence diagram showing the read/write interleaving.
- To document **concurrent subscription safety**, we will explain the two-tier handler resolution in `handleOnSubscribe` (Pipeline rules first, fallback to `GetChannelHandler`), the double-check locking in `GetChannelHandler`, and the semaphore pattern for per-client concurrency.
- To document **the transition model**, we will explain the snapshot-replacement pattern — where a completely new radix tree is built from the current `RuleBuilder.BuildRules()` output and swapped in atomically, so any in-flight `Get()` call sees either the complete old tree or the complete new tree, never a partial one.
- To document **stale route behavior**, we will explain that during the up-to-20-second window between refreshes, lookups read from the previous snapshot, and that the first request for a never-seen org triggers a synchronous `fillOrg()` with a 5-second context timeout.
- To document **stream lifecycle management**, we will trace `SubmitStream` → `registerCh` → `registerStream` → `watchStream` + `runStream`, including exponential backoff on reconnection and subscriber-count-driven idle shutdown.

### 0.1.4 Inferred Documentation Needs

Based on code analysis, additional documentation needs surfaced:

- **Managed stream frame cache coherence:** `NamespaceStream.Push()` in `pkg/services/live/managedstream/runner.go` updates the frame cache and decides whether to publish schema+data or data-only based on `FrameCache.Update()` return value — this schema-change detection is a key coherence mechanism that should be documented.
- **HA survey-based channel aggregation:** `survey.CallManagedStreams()` in `pkg/services/live/survey/survey.go` uses a 1-second timeout Centrifuge Survey RPC to aggregate managed channels across all nodes, with deduplication and rate accumulation — this cross-node coherence path deserves coverage.
- **Organization-scoped channel isolation:** `orgchannel.PrependOrgID()` and `orgchannel.StripOrgID()` in `pkg/services/live/orgchannel/orgchannel.go` ensure strict tenant isolation by encoding `<orgID>/<channel>` — this prevents cross-tenant route confusion during concurrent operations.
- **Pipeline recursion protection:** The `visitedChannels` map in `pipeline.processInput()` and `processChannelFrames()` prevents infinite redirect loops when rules chain to other channels — a correctness mechanism relevant to routing integrity.
- **Frontend Centrifuge service connection lifecycle:** `CentrifugeService` in `public/app/features/live/centrifuge/service.ts` manages the WebSocket connection, channel caching, and `LiveDataStream` lifecycle — the client-side perspective on how routing changes are experienced by consumers.

## 0.2 Documentation Discovery and Analysis

### 0.2.1 Existing Documentation Infrastructure Assessment

Repository analysis reveals a **Hugo-based documentation site** in `docs/sources/` with Makefile-driven build orchestration, but **no existing deep-dive document specifically covering the live streaming routing layer's runtime coherence model**.

- **Documentation framework:** Hugo (static site generator), driven by `docs/Makefile` with `docs.mk` include
- **Documentation generator configuration:** `docs/Makefile`, `docs/docs.mk`, `docs/variables.mk`
- **Existing Grafana Live documentation:** `docs/sources/setup-grafana/set-up-grafana-live.md` — covers operational setup (WebSocket config, HA Redis setup, connection limits, proxy configuration) but does **not** address internal routing mechanics, concurrency model, or cache coherence
- **API documentation tools:** Not applicable for this task — no API surface is being documented
- **Diagram tools detected:** Mermaid is used extensively throughout the tech spec and is the standard for Grafana documentation
- **Documentation hosting:** Hugo-based site with Grafana's standard docs pipeline

Key finding: The existing `set-up-grafana-live.md` document focuses on **operational concerns** (connection limits, Redis HA engine, proxy WebSocket config) while the user's questions are about **internal runtime behavior** — a gap that requires a new document.

### 0.2.2 Repository Code Analysis for Documentation

The following search patterns were used to locate the live streaming routing layer's core components:

- **Folder deep search:** `pkg/services/live/` and all subpackages (9 subpackages explored to full depth)
- **Semantic file search:** "live streaming channel routing and subscription management"
- **Semantic folder search:** "live streaming routing layer for real-time data channels"
- **Direct file reads:** 20+ source files read in full

Key directories examined and their relevance to the documentation:

| Directory | Role in Routing Coherence | Files Read |
|-----------|--------------------------|------------|
| `pkg/services/live/` | Service bootstrap, handler dispatch, connection management | `live.go` (full: lines 1–1050+) |
| `pkg/services/live/pipeline/` | Rule cache, radix tree routing, pipeline execution | `rule_cache_segmented.go`, `pipeline.go`, `rule_builder.go`, `rule_cache_segmented_test.go` |
| `pkg/services/live/pipeline/tree/` | Radix tree pattern matching engine | `tree.go` (lines 1–100), `readme.md` |
| `pkg/services/live/managedstream/` | Stream caching, frame cache, namespace streams | `runner.go`, `cache.go`, `cache_memory.go` |
| `pkg/services/live/runstream/` | Plugin stream lifecycle, duplicate detection | `manager.go` (full) |
| `pkg/services/live/survey/` | HA cross-node channel aggregation | `survey.go` (full) |
| `pkg/services/live/orgchannel/` | Organization-scoped channel encoding | `orgchannel.go` (full via summary) |
| `pkg/services/live/livecontext/` | Request-scoped context propagation | `context.go` (full) |
| `pkg/services/live/pushws/` | WebSocket push transport | File summaries reviewed |
| `pkg/services/live/pushhttp/` | HTTP push gateway | File summaries reviewed |
| `public/app/features/live/centrifuge/` | Frontend Centrifuge service and channel adapter | `service.ts`, `channel.ts` summaries reviewed |

Related documentation found that provides context but does not address the user's questions:

- `docs/sources/setup-grafana/set-up-grafana-live.md` — operational setup guide
- `pkg/services/live/pipeline/tree/readme.md` — explains channel pattern matching semantics (from httprouter)
- `README.md` — project overview, no live-specific deep-dive

### 0.2.3 Web Search Research Conducted

No external web search was conducted because:

- The user's questions are entirely about Grafana's internal implementation, which can only be authoritatively answered by reading the source code
- The codebase itself is the single source of truth for routing coherence behavior
- Best practices for documenting concurrency models are well-established and do not require external research
- The Centrifuge library version (v0.33.3) and its semantics are documented in the codebase's usage patterns

### 0.2.4 Tech Spec Sections Reviewed

The following existing tech spec sections were retrieved and analyzed for background context:

| Section | Key Findings Relevant to This Task |
|---------|-----------------------------------|
| 4.10 REAL-TIME DATA STREAMING (GRAFANA LIVE) | WebSocket connection flow, pipeline data processing, managed stream orchestration with MemoryFrameCache and RedisFrameCache backends, runstream duplicate detection |
| 5.2 COMPONENT DETAILS (§5.2.7) | Grafana Live architecture overview including Centrifuge v0.33.3 integration, channel scope families, rule-based pipeline processing |
| 3.1 Programming Languages | Go 1.23.1 as the backend language; TypeScript 5.5.4 for frontend |
| 3.3 Open Source Dependencies | Centrifuge v0.33.3, go-redis v8.11.5, gorilla/websocket v1.5.3 |

## 0.3 Documentation Scope Analysis

### 0.3.1 Code-to-Documentation Mapping

The following modules require documentation coverage to comprehensively answer the user's questions about live streaming routing coherence:

- **Module: `pkg/services/live/pipeline/rule_cache_segmented.go`**
  - Public APIs: `NewCacheSegmentedTree()`, `CacheSegmentedTree.Get()`, `CacheSegmentedTree.fillOrg()`, `CacheSegmentedTree.updatePeriodically()`
  - Current documentation: **Missing** — no existing documentation explains the atomic tree replacement model
  - Documentation needed: Full explanation of the 20-second periodic refresh loop, the snapshot-replacement swap under `sync.RWMutex`, lazy org initialization on first `Get()`, and the 5-second context timeout on `fillOrg()`

- **Module: `pkg/services/live/pipeline/tree/tree.go`**
  - Public APIs: `New()`, `Node.AddRoute()`, `Node.GetValue()`
  - Current documentation: `readme.md` exists explaining pattern matching semantics — but not runtime behavior
  - Documentation needed: Explanation of how the radix tree is immutable after construction and how `GetValue()` provides lock-free lookups within a single tree snapshot

- **Module: `pkg/services/live/pipeline/pipeline.go`**
  - Public APIs: `New()`, `Pipeline.ProcessInput()`, `Pipeline.Get()`, `Pipeline.DataToChannelFrames()`
  - Current documentation: **Missing** — inline comments exist but no architectural documentation
  - Documentation needed: How the pipeline resolves rules per-request via `ruleGetter.Get()`, recursion protection via `visitedChannels`, and the Converter → FrameProcessor → FrameOutputter execution chain

- **Module: `pkg/services/live/live.go`**
  - Public APIs: `ProvideService()`, `GrafanaLive.Run()`, `handleOnSubscribe()`, `handleOnPublish()`, `GetChannelHandler()`, `GetChannelHandlerFactory()`
  - Current documentation: **Incomplete** — `set-up-grafana-live.md` covers operational setup only
  - Documentation needed: Two-tier handler resolution (Pipeline rules → fallback handler), double-check locking in `GetChannelHandler`, concurrent handler dispatch via semaphore, scope-based factory routing (grafana/plugin/datasource/stream)

- **Module: `pkg/services/live/managedstream/runner.go`**
  - Public APIs: `NewRunner()`, `Runner.GetOrCreateStream()`, `Runner.GetManagedChannels()`, `NamespaceStream.Push()`, `NamespaceStream.OnSubscribe()`
  - Current documentation: **Missing**
  - Documentation needed: Lazy stream creation under `sync.RWMutex`, schema-aware publish (data-only vs full frame), per-path minute-rate tracking in 60-slot sliding window, subscription replay from frame cache

- **Module: `pkg/services/live/runstream/manager.go`**
  - Public APIs: `NewManager()`, `Manager.Run()`, `Manager.SubmitStream()`, `Manager.HandleDatasourceUpdate()`, `Manager.HandleDatasourceDelete()`
  - Current documentation: **Missing**
  - Documentation needed: Serialized registration via `registerCh`, duplicate detection, subscriber-presence-driven idle shutdown, exponential backoff reconnection, datasource-event-driven stop-and-resubmit

- **Module: `pkg/services/live/managedstream/cache_memory.go`** and **`cache.go`**
  - Public APIs: `FrameCache` interface, `MemoryFrameCache.Update()`, `MemoryFrameCache.GetFrame()`, `MemoryFrameCache.GetActiveChannels()`
  - Current documentation: **Missing**
  - Documentation needed: How `Update()` detects schema changes via `SameSchema()`, the concurrency model with `sync.RWMutex`, and the distinction between schema-only and full frame retrieval

- **Module: `pkg/services/live/survey/survey.go`**
  - Public APIs: `NewCaller()`, `Caller.SetupHandlers()`, `Caller.CallManagedStreams()`
  - Current documentation: **Missing**
  - Documentation needed: HA cross-node channel aggregation via Centrifuge Survey RPC, 1-second timeout, deduplication with rate accumulation

- **Module: `pkg/services/live/orgchannel/orgchannel.go`**
  - Public APIs: `PrependOrgID()`, `StripOrgID()`
  - Current documentation: **Missing** (unit tests serve as specification)
  - Documentation needed: Brief explanation of org-scoped channel encoding as a tenant isolation mechanism

- **Module: `public/app/features/live/centrifuge/service.ts`**
  - Public APIs: `CentrifugeService` class, `getChannel()`, `getDataStream()`, `getQueryData()`
  - Current documentation: **Missing**
  - Documentation needed: Client-side perspective on channel caching, connection lifecycle, and how routing changes propagate to the frontend

### 0.3.2 Documentation Gap Analysis

Given the requirements and repository analysis, documentation gaps include:

- **Undocumented concurrency model:** No existing document explains how `sync.RWMutex` is used across the CacheSegmentedTree, ManagedStream Runner, MemoryFrameCache, and RunStream Manager to provide coherent concurrent access
- **Undocumented routing transition model:** The atomic snapshot-replacement pattern in `fillOrg()` is central to routing coherence but has no documentation
- **Missing architecture diagrams:** No Mermaid diagrams exist showing the flow from WebSocket subscription through handler resolution, rule lookup, and frame delivery
- **Missing lifecycle documentation:** The RunStream Manager's stream lifecycle (registration → watch → run → idle shutdown → resubmit) is undocumented
- **Missing HA coherence documentation:** The survey-based cross-node aggregation model is undocumented beyond the operational Redis setup guide
- **Missing client-side perspective:** How the frontend Centrifuge service experiences routing changes (channel caching, reconnection, stream buffering) is undocumented

## 0.4 Documentation Implementation Design

### 0.4.1 Documentation Structure Planning

The output document `blitzy/documentation/grafana_4550cfb5b728.md` will follow a structured deep-dive format designed to answer each of the user's questions progressively, building from foundational concepts to runtime dynamics:

```
blitzy/
└── documentation/
    └── grafana_4550cfb5b728.md
        ├── Introduction (scope and approach)
        ├── Architectural Foundation
        │   ├── Live service bootstrap and component wiring
        │   ├── Channel address model (scope/namespace/path)
        │   └── Organization-scoped channel isolation
        ├── The Routing Table: CacheSegmentedTree
        │   ├── Data structure (per-org radix trees)
        │   ├── The radix tree engine (from httprouter)
        │   ├── Pattern matching semantics
        │   └── How rules are materialized from storage
        ├── Periodic Refresh and Atomic Swap
        │   ├── The 20-second updatePeriodically loop
        │   ├── fillOrg: build-then-replace under write lock
        │   ├── Why readers never see a partial tree
        │   └── Bounded staleness as a design trade-off
        ├── Request-Time Route Resolution
        │   ├── Two-tier handler dispatch (Pipeline → fallback)
        │   ├── Lazy org initialization on first Get()
        │   ├── Double-check locking in GetChannelHandler
        │   └── Concurrent client dispatch via semaphore
        ├── Managed Stream Coherence
        │   ├── NamespaceStream lazy creation
        │   ├── Frame cache and schema-change detection
        │   ├── Publish routing by scope
        │   └── Subscription replay from cache
        ├── Plugin Stream Lifecycle
        │   ├── Serialized registration via registerCh
        │   ├── Duplicate detection
        │   ├── Subscriber-driven idle shutdown
        │   ├── Exponential backoff reconnection
        │   └── Datasource update/delete handling
        ├── HA Coherence: Cross-Node Aggregation
        │   ├── Redis-backed broker and presence
        │   ├── Survey RPC for managed channel discovery
        │   └── Rate accumulation and deduplication
        ├── Pipeline Recursion Protection
        │   └── The visitedChannels guard
        ├── Frontend Perspective
        │   ├── CentrifugeService connection lifecycle
        │   ├── Channel caching and shutdown cleanup
        │   └── LiveDataStream buffering model
        └── Summary of Coherence Guarantees
```

### 0.4.2 Content Generation Strategy

**Information Extraction Approach:**

- Extract the `sync.RWMutex` read/write interleaving pattern from `pkg/services/live/pipeline/rule_cache_segmented.go` to explain atomic swap semantics
- Extract the handler resolution flow from `pkg/services/live/live.go` lines 613–712 (`handleOnSubscribe`) and lines 840–878 (`GetChannelHandler`) to trace the two-tier dispatch
- Extract the stream lifecycle from `pkg/services/live/runstream/manager.go` to document registration, watch, run, and cleanup phases
- Extract frame cache update logic from `pkg/services/live/managedstream/cache_memory.go` lines 55–70 to explain schema-change detection
- Extract recursion protection from `pkg/services/live/pipeline/pipeline.go` lines 316–340 (`processChannelDataList`) to document the `visitedChannels` guard
- Create diagrams by mapping component relationships across `live.go`, `rule_cache_segmented.go`, `runner.go`, and `manager.go`

**Documentation Standards:**

- Markdown formatting with proper headers (# ## ### ####)
- Mermaid diagram integration for: routing table refresh sequence, handler dispatch flow, stream lifecycle state machine, HA survey aggregation
- Code citations as inline references: `Source: pkg/services/live/pipeline/rule_cache_segmented.go:28-44`
- Tables for concurrency primitive inventory and component responsibility mapping
- Consistent terminology: "routing table" (CacheSegmentedTree), "routing snapshot" (per-org radix tree), "rule" (LiveChannelRule), "handler" (ChannelHandler)

### 0.4.3 Diagram and Visual Strategy

Mermaid diagrams to create:

- **Sequence diagram:** Routing table periodic refresh showing the interleaving of reader goroutines and the writer goroutine during `fillOrg()` under `RWMutex`
- **Flowchart:** `handleOnSubscribe` two-tier handler resolution — Pipeline rule check → fallback to scope-based handler factory → double-check locking handler cache
- **State diagram:** RunStream Manager stream lifecycle — Submitted → Registered → Running (with watch) → Idle check → Closed (or Reconnecting with backoff)
- **Flowchart:** Frame cache update and schema-aware publish decision in `NamespaceStream.Push()`
- **Sequence diagram:** HA survey-based channel aggregation across multiple Grafana nodes
- **Component diagram:** Overall live routing architecture showing relationships between GrafanaLive, Pipeline, CacheSegmentedTree, ManagedStream Runner, RunStream Manager, and Survey Caller

## 0.5 Documentation File Transformation Mapping

### 0.5.1 File-by-File Documentation Plan

| Target Documentation File | Transformation | Source Code/Docs | Content/Changes |
|---------------------------|----------------|------------------|-----------------|
| `blitzy/documentation/grafana_4550cfb5b728.md` | CREATE | `pkg/services/live/pipeline/rule_cache_segmented.go`, `pkg/services/live/pipeline/pipeline.go`, `pkg/services/live/pipeline/tree/tree.go`, `pkg/services/live/live.go`, `pkg/services/live/managedstream/runner.go`, `pkg/services/live/managedstream/cache.go`, `pkg/services/live/managedstream/cache_memory.go`, `pkg/services/live/runstream/manager.go`, `pkg/services/live/survey/survey.go`, `pkg/services/live/orgchannel/orgchannel.go`, `pkg/services/live/livecontext/context.go`, `pkg/services/live/model/model.go`, `pkg/services/live/pipeline/rule_builder.go`, `pkg/services/live/pipeline/rule_cache_segmented_test.go`, `pkg/services/live/pipeline/tree/readme.md`, `public/app/features/live/centrifuge/service.ts`, `public/app/features/live/centrifuge/channel.ts`, `docs/sources/setup-grafana/set-up-grafana-live.md` | Comprehensive Q&A document explaining how the live streaming routing layer stays coherent at runtime: atomic routing table swap model, concurrent handler dispatch, stream lifecycle management, schema-aware frame caching, HA cross-node aggregation, and recursion protection. Includes Mermaid diagrams, code citations, and rationale-driven explanations. |
| `docs/sources/setup-grafana/set-up-grafana-live.md` | REFERENCE | N/A | Used as reference for existing documentation style, tone, and Hugo frontmatter conventions. Not modified. |
| `pkg/services/live/pipeline/tree/readme.md` | REFERENCE | N/A | Used as reference for pattern matching semantics. Not modified. |

### 0.5.2 New Documentation File Detail

```
File: blitzy/documentation/grafana_4550cfb5b728.md
Type: Architecture deep-dive / Technical Q&A
Source Code:
  - pkg/services/live/pipeline/rule_cache_segmented.go (primary — routing table)
  - pkg/services/live/pipeline/pipeline.go (pipeline execution)
  - pkg/services/live/pipeline/tree/tree.go (radix tree engine)
  - pkg/services/live/live.go (service bootstrap, handler dispatch)
  - pkg/services/live/managedstream/runner.go (stream cache orchestration)
  - pkg/services/live/managedstream/cache_memory.go (frame cache)
  - pkg/services/live/managedstream/cache.go (cache interface)
  - pkg/services/live/runstream/manager.go (plugin stream lifecycle)
  - pkg/services/live/survey/survey.go (HA aggregation)
  - pkg/services/live/orgchannel/orgchannel.go (tenant isolation)
  - pkg/services/live/livecontext/context.go (request context)
  - pkg/services/live/model/model.go (shared contracts)
  - pkg/services/live/pipeline/rule_builder.go (rule construction)
  - public/app/features/live/centrifuge/service.ts (frontend service)
  - public/app/features/live/centrifuge/channel.ts (frontend channel)
Sections:
  - Introduction (scope, approach, terminology)
  - Architectural Foundation (bootstrap, channel model, org isolation)
  - The Routing Table: CacheSegmentedTree (data structure, radix tree, pattern matching)
  - Periodic Refresh and Atomic Swap (20s loop, fillOrg, RWMutex semantics)
  - Request-Time Route Resolution (two-tier dispatch, lazy init, double-check locking)
  - Managed Stream Coherence (lazy creation, frame cache, schema detection, publish routing)
  - Plugin Stream Lifecycle (registration, duplicate detection, idle shutdown, backoff)
  - HA Coherence: Cross-Node Aggregation (Redis, survey RPC, dedup)
  - Pipeline Recursion Protection (visitedChannels guard)
  - Frontend Perspective (CentrifugeService, channel caching, LiveDataStream)
  - Summary of Coherence Guarantees
Diagrams:
  - Routing table refresh sequence diagram (RWMutex interleaving)
  - Handler dispatch flowchart (two-tier resolution)
  - Stream lifecycle state diagram (RunStream Manager)
  - Frame cache update flowchart (schema-aware publish)
  - HA survey aggregation sequence diagram
  - Component architecture diagram (overall live routing)
Key Citations:
  - pkg/services/live/pipeline/rule_cache_segmented.go:13-83
  - pkg/services/live/live.go:76-332, 613-878
  - pkg/services/live/runstream/manager.go:50-460
  - pkg/services/live/managedstream/runner.go:39-257
  - pkg/services/live/survey/survey.go:17-134
  - pkg/services/live/pipeline/pipeline.go:182-540
```

### 0.5.3 Documentation Configuration Updates

No documentation configuration changes are needed because:

- The output file is placed in `blitzy/documentation/`, which is a standalone output directory not integrated into Grafana's Hugo docs pipeline
- No `mkdocs.yml`, `docusaurus.config.js`, or `.readthedocs.yml` modifications are required
- No navigation or sidebar updates are needed

### 0.5.4 Cross-Documentation Dependencies

- **Shared content:** None — the document is self-contained
- **Navigation links:** The document will reference `docs/sources/setup-grafana/set-up-grafana-live.md` as a companion operational guide
- **Table of contents:** Self-contained within the document using markdown headers
- **Index/glossary updates:** Not applicable

## 0.6 Dependency Inventory

### 0.6.1 Documentation Dependencies

The following packages are relevant to this documentation exercise — not as tools to install, but as the runtime dependencies whose behavior must be accurately documented:

| Registry | Package Name | Version | Purpose |
|----------|--------------|---------|---------|
| Go modules | `github.com/centrifugal/centrifuge` | v0.33.3 | Core real-time messaging engine powering Grafana Live WebSocket connections, PUB/SUB, survey RPC, and presence management |
| Go modules | `github.com/go-redis/redis/v8` | v8.11.5 | Redis client used for HA broker, presence manager, and RedisFrameCache in clustered deployments |
| Go modules | `github.com/gorilla/websocket` | v1.5.3 | WebSocket protocol implementation used by Centrifuge and push WebSocket handlers |
| Go modules | `github.com/grafana/grafana-plugin-sdk-go` | (pinned in go.mod) | Plugin SDK providing `backend.RunStreamRequest`, `backend.StreamSender`, `data.Frame`, `data.FrameJSONCache`, and `live.ParseChannel` |
| Go modules | `golang.org/x/sync` | (pinned in go.mod) | Provides `errgroup.Group` used in `GrafanaLive.Run()` for concurrent background service orchestration |
| Go modules | `github.com/gobwas/glob` | (pinned in go.mod) | Glob pattern matching for WebSocket origin validation in `checkAllowedOrigin` |
| Go modules | `github.com/json-iterator/go` | (pinned in go.mod) | High-performance JSON serialization used for Live RPC and publish responses |
| Go std lib | `sync` | Go 1.23.1 | Provides `sync.RWMutex` (used in CacheSegmentedTree, ManagedStream Runner, MemoryFrameCache, RunStream Manager) and `sync.Once` |
| Go std lib | `context` | Go 1.23.1 | Request-scoped cancellation and timeout used throughout live handler dispatch and stream lifecycle |
| NPM | `centrifuge-js` | (pinned in package.json) | Frontend Centrifuge client library used by `CentrifugeService` for WebSocket connection, subscription, and RPC |
| NPM | `rxjs` | (pinned in package.json) | Reactive Extensions for JavaScript — provides `Observable`, `Subject`, `BehaviorSubject` used by `CentrifugeLiveChannel` and `LiveDataStream` |
| NPM | `comlink` | (pinned in package.json) | Worker communication bridge used to proxy CentrifugeService across Web Worker boundary |

### 0.6.2 Documentation Reference Updates

No link updates are required. The new document is self-contained in `blitzy/documentation/` and does not integrate into Grafana's existing documentation site navigation. Internal cross-references within the document use relative markdown header links.

## 0.7 Coverage and Quality Targets

### 0.7.1 Documentation Coverage Metrics

Current coverage analysis of the live streaming routing layer's internal documentation:

- **Routing table mechanics documented:** 0/4 key functions (0%) — `updatePeriodically()`, `fillOrg()`, `Get()`, `NewCacheSegmentedTree()` have no external documentation
- **Handler dispatch flow documented:** 0/3 key flows (0%) — `handleOnSubscribe`, `GetChannelHandler`, `GetChannelHandlerFactory` have no architectural documentation
- **Stream lifecycle documented:** 0/5 key phases (0%) — registration, watch, run, idle shutdown, and datasource-event handling have no documentation
- **HA coherence documented:** 1/3 mechanisms (33%) — Redis setup is documented in `set-up-grafana-live.md`, but survey RPC aggregation and cross-node deduplication are undocumented
- **Frame cache coherence documented:** 0/3 operations (0%) — `Update()` schema detection, `GetFrame()` replay, and `GetActiveChannels()` discovery are undocumented
- **Frontend perspective documented:** 0/3 components (0%) — `CentrifugeService`, `CentrifugeLiveChannel`, `LiveDataStream` lifecycle are undocumented in this context

**Target coverage:** 100% of the user's questions comprehensively answered, with every claim grounded in specific source code citations.

Coverage gaps to address:

| Component | Current | Target | Focus Areas |
|-----------|---------|--------|-------------|
| CacheSegmentedTree | 0% | 100% | Atomic swap, RWMutex semantics, 20s refresh, lazy init |
| Handler dispatch | 0% | 100% | Two-tier resolution, double-check locking, semaphore concurrency |
| RunStream Manager | 0% | 100% | Serialized registration, idle shutdown, backoff, datasource events |
| ManagedStream Runner | 0% | 100% | Lazy stream creation, schema-aware publish, frame cache |
| Survey Caller | 33% | 100% | RPC aggregation, dedup, rate accumulation |
| Pipeline execution | 0% | 100% | Rule resolution, recursion protection |
| Frontend service | 0% | 100% | Connection lifecycle, channel caching, data stream buffering |

### 0.7.2 Documentation Quality Criteria

**Completeness requirements:**

- Every user question is answered with a dedicated section
- All concurrency primitives (`sync.RWMutex`, `chan`, `context.WithCancel`, semaphore) are identified and their roles explained
- All timing constants are documented: 20-second refresh, 5-second context timeout, 5-second presence check, 100ms cool-down delay, 5-second max delay, 1-second survey timeout
- All state transitions are documented with Mermaid diagrams

**Accuracy validation:**

- Every technical claim cites a specific source file and line range
- Code examples are direct extractions from the repository (not invented)
- Concurrency behavior descriptions are validated against the actual `sync.RWMutex` usage patterns in the source
- The document distinguishes between "guaranteed" behaviors (e.g., atomic swap) and "bounded" behaviors (e.g., up-to-20-second staleness)

**Clarity standards:**

- Technical precision balanced with narrative accessibility — the user wants "an intuitive feel"
- Progressive disclosure: start with the high-level architecture, then drill into each mechanism
- Consistent terminology table provided at the start
- Each section opens with what the user would observe, then explains how the code achieves it

**Maintainability:**

- Source citations use `file:line-range` format for traceability
- Sections are modular so they can be updated independently as the codebase evolves
- Diagram source is embedded as Mermaid markdown (not external images)

### 0.7.3 Example and Diagram Requirements

- **Minimum diagrams:** 6 Mermaid diagrams as specified in section 0.4.3
- **Code snippet policy:** Short, focused extractions (2–5 lines) from source files with citations — not full function bodies
- **Verification method:** All citations will be cross-referenced against the actual file content retrieved during context gathering

## 0.8 Scope Boundaries

### 0.8.1 Exhaustively In Scope

**New documentation files:**

- `blitzy/documentation/grafana_4550cfb5b728.md` — the sole output artifact

**Source files analyzed for documentation content (read-only):**

- `pkg/services/live/pipeline/rule_cache_segmented.go` — routing table cache with atomic swap
- `pkg/services/live/pipeline/rule_cache_segmented_test.go` — test fixtures validating cache behavior
- `pkg/services/live/pipeline/pipeline.go` — pipeline execution engine with recursion protection
- `pkg/services/live/pipeline/rule_builder.go` — rule construction interface
- `pkg/services/live/pipeline/tree/tree.go` — radix tree pattern matching engine
- `pkg/services/live/pipeline/tree/readme.md` — pattern matching semantics reference
- `pkg/services/live/live.go` — central GrafanaLive service: bootstrap, handler dispatch, connection management
- `pkg/services/live/managedstream/runner.go` — managed stream orchestration and frame cache publish
- `pkg/services/live/managedstream/cache.go` — FrameCache interface
- `pkg/services/live/managedstream/cache_memory.go` — in-memory frame cache with schema detection
- `pkg/services/live/runstream/manager.go` — plugin stream lifecycle management
- `pkg/services/live/survey/survey.go` — HA cross-node channel aggregation
- `pkg/services/live/orgchannel/orgchannel.go` — org-scoped channel encoding
- `pkg/services/live/livecontext/context.go` — request-scoped context propagation
- `pkg/services/live/model/model.go` — shared ChannelHandler contracts and data models
- `pkg/services/live/pushws/*.go` — WebSocket push transport handlers
- `pkg/services/live/pushhttp/push.go` — HTTP push gateway
- `pkg/services/live/features/plugin.go` — plugin streaming bridge
- `pkg/services/live/features/broadcast.go` — broadcast channel handler
- `pkg/services/live/features/dashboard.go` — dashboard live handler
- `public/app/features/live/centrifuge/service.ts` — frontend Centrifuge service
- `public/app/features/live/centrifuge/channel.ts` — frontend channel adapter
- `public/app/features/live/centrifuge/LiveDataStream.ts` — frontend data stream adapter
- `public/app/features/live/live.ts` — frontend GrafanaLiveService adapter
- `docs/sources/setup-grafana/set-up-grafana-live.md` — existing operational docs (reference only)

**Documentation topics exhaustively in scope:**

- Routing table refresh coherence (atomic swap, bounded staleness)
- Concurrent handler dispatch safety (RWMutex, double-check locking, semaphore)
- Stream lifecycle management (registration, watch, run, shutdown, reconnect)
- Frame cache coherence (schema-change detection, subscription replay)
- HA cross-node coherence (Redis broker, survey aggregation, rate dedup)
- Pipeline recursion protection
- Frontend connection and channel lifecycle
- Organization-scoped channel isolation

### 0.8.2 Explicitly Out of Scope

- **Source code modifications:** No files in the repository will be modified (per user instruction and implementation rule)
- **Test file modifications:** No test files will be created or modified
- **Operational documentation updates:** `docs/sources/setup-grafana/set-up-grafana-live.md` will not be modified
- **Feature additions or code refactoring:** No code changes of any kind
- **Deployment configuration changes:** No configuration files will be modified
- **Non-Live subsystems:** Alerting, dashboards (except dashboard live handler), data source queries (except datasource-backed streams), plugins (except stream plugins), and all other Grafana subsystems
- **Performance benchmarking:** While timing constants are documented, no performance testing or optimization is in scope
- **Security analysis:** While authentication checks are mentioned in handler dispatch, a full security audit of the Live subsystem is out of scope
- **Redis internals:** The document covers Grafana's use of Redis for HA but does not document Redis itself
- **Centrifuge library internals:** The document covers Grafana's integration with Centrifuge v0.33.3 but does not document the Centrifuge library's internal implementation

## 0.9 Execution Parameters

### 0.9.1 Documentation-Specific Instructions

- **Documentation build command:** Not applicable — the output is a standalone markdown file in `blitzy/documentation/`, not integrated into Grafana's Hugo docs pipeline
- **Documentation preview command:** Standard markdown renderer (e.g., `cat blitzy/documentation/grafana_4550cfb5b728.md` or any markdown viewer)
- **Diagram generation command:** Mermaid diagrams are embedded inline in the markdown using triple-backtick mermaid blocks — no separate generation step required
- **Documentation deployment command:** Not applicable — the file is committed to the repository directly
- **Default format:** Markdown with Mermaid diagrams
- **Citation requirement:** Every section must reference source files using the format `Source: path/to/file.go:line-range`
- **Style guide to follow:** Narrative explanatory style matching the user's request for "an intuitive feel," balanced with precise code citations. Use the tone established in `docs/sources/setup-grafana/set-up-grafana-live.md` as a reference for Grafana documentation conventions.
- **Documentation validation:** Manual review — verify that all file paths and line references match the actual repository content; verify that all Mermaid diagrams render correctly

### 0.9.2 Output File Specification

- **File name:** `grafana_4550cfb5b728.md` (derived from the source branch name per implementation rule)
- **Location:** `blitzy/documentation/` directory
- **Format:** GitHub-flavored Markdown with Mermaid diagram blocks
- **Encoding:** UTF-8
- **Repository impact:** One new file created; zero existing files modified
- **Cleanup:** The user mentions "temporary scripts may be used for observation, but the repository itself should remain unchanged and anything temporary should be cleaned up afterward" — no temporary scripts are needed for this documentation task since all analysis was performed through tool-based repository inspection

## 0.10 Rules for Documentation

The following rules are derived from the user's explicit instructions and the project's implementation rules:

- **Do not modify any existing files in the source repository.** The repository must remain unchanged. The only permitted write operation is creating the new file `blitzy/documentation/grafana_4550cfb5b728.md`.
- **Provide thinking and rationale behind the answers.** The document must not simply state facts — it must explain *why* the system works the way it does, what design trade-offs were made, and what the consequences are for consumers.
- **Do not make assumptions — base answers on the code as the truth.** Every claim must be traceable to specific source code. Speculation about undocumented behavior must be clearly flagged as inference.
- **Place the generated document in the `blitzy/documentation` directory** in the destination repository, named `grafana_4550cfb5b728.md`.
- **Temporary scripts may be used for observation but must be cleaned up afterward.** No temporary files should remain in the repository after the task is complete.
- **Use Mermaid diagrams** for all architectural and flow visualizations — this is the standard used throughout the Grafana technical specification.
- **Include source code citations** for all technical details using the format `Source: path/to/file.go:line-range`.
- **Balance technical precision with accessibility** — the user explicitly wants "an intuitive feel" for how the system works, not just a code walkthrough.
- **Cover the complete lifecycle** — from the moment a routing rule is persisted, through its materialization in the radix tree, to its use during live subscription handling, to its eventual replacement during the next refresh cycle.

## 0.11 References

### 0.11.1 Source Files and Folders Searched

The following files and folders were searched and read to derive the conclusions in this Agent Action Plan:

**Core routing layer files (read in full):**

| File Path | Lines Read | Purpose |
|-----------|-----------|---------|
| `pkg/services/live/pipeline/rule_cache_segmented.go` | 1–83 | Routing table cache: atomic swap, periodic refresh, lazy org initialization |
| `pkg/services/live/pipeline/rule_cache_segmented_test.go` | 1–64 | Test fixtures validating pattern matching through CacheSegmentedTree |
| `pkg/services/live/pipeline/pipeline.go` | 1–540 | Pipeline execution: rule resolution, recursion protection, frame processing chain |
| `pkg/services/live/pipeline/rule_builder.go` | 1–8 | RuleBuilder interface contract |
| `pkg/services/live/pipeline/tree/tree.go` | 1–100 | Radix tree engine: Node, AddRoute, GetValue, pattern matching |
| `pkg/services/live/pipeline/tree/readme.md` | 1–32 | Pattern matching semantics: static, named, catch-all patterns |
| `pkg/services/live/live.go` | 1–1050 | GrafanaLive service: bootstrap, handler dispatch, subscribe/publish handling, channel resolution |
| `pkg/services/live/managedstream/runner.go` | 1–257 | ManagedStream Runner: lazy stream creation, frame push, schema detection, rate tracking |
| `pkg/services/live/managedstream/cache.go` | 1–18 | FrameCache interface definition |
| `pkg/services/live/managedstream/cache_memory.go` | 1–70 | In-memory frame cache with schema-change detection |
| `pkg/services/live/runstream/manager.go` | 1–460 | RunStream Manager: serialized registration, watch, run, backoff, datasource events |
| `pkg/services/live/survey/survey.go` | 1–134 | HA survey: cross-node channel aggregation, dedup, rate accumulation |
| `pkg/services/live/orgchannel/orgchannel.go` | (via summary) | Org-scoped channel encoding: PrependOrgID, StripOrgID |
| `pkg/services/live/livecontext/context.go` | 1–54 | Request-scoped context: signed user, stream ID, channel ID propagation |
| `pkg/services/live/model/model.go` | (via summary) | Shared contracts: ChannelHandler, SubscribeEvent, PublishEvent, LiveMessage |

**Supporting files (summaries reviewed):**

| File Path | Purpose |
|-----------|---------|
| `pkg/services/live/pushws/ws.go` | WebSocket connection setup: origin validation, ping/pong lifecycle |
| `pkg/services/live/pushws/push_pipeline.go` | Pipeline-backed WebSocket push handler |
| `pkg/services/live/pushws/push_stream.go` | Managed-stream-backed WebSocket push handler |
| `pkg/services/live/pushhttp/push.go` | HTTP push gateway: stream and pipeline push endpoints |
| `pkg/services/live/features/plugin.go` | Plugin streaming bridge: context resolution, stream submission |
| `pkg/services/live/features/broadcast.go` | Broadcast channel handler: message store, subscription replay |
| `pkg/services/live/features/dashboard.go` | Dashboard live handler: save/delete events, gitops broadcast |
| `pkg/services/live/pipeline/subscribe_managed_stream.go` | Managed-stream subscriber in pipeline |
| `pkg/services/live/pipeline/subscribe_builtin.go` | Built-in subscriber in pipeline |
| `pkg/services/live/pipeline/subscribe_multiple.go` | Multiple subscriber fan-out wrapper |
| `pkg/services/live/pipeline/frame_output_local_subscribers.go` | Frame output to local Centrifuge subscribers |
| `public/app/features/live/centrifuge/service.ts` | Frontend Centrifuge service: connection, channel caching, data streams |
| `public/app/features/live/centrifuge/channel.ts` | Frontend channel adapter: event stream, presence, lifecycle |
| `public/app/features/live/centrifuge/LiveDataStream.ts` | Frontend data stream: buffering, schema handling, teardown |
| `public/app/features/live/live.ts` | Frontend GrafanaLiveService: publish, query, stream normalization |

**Folders explored:**

| Folder Path | Depth | Children Examined |
|-------------|-------|-------------------|
| Repository root (`""`) | 0 | Full listing of 60+ children |
| `pkg/services/live/` | 1 | All 12 subpackages identified |
| `pkg/services/live/pipeline/` | 2 | All files and 3 subfolders (pattern, tree, testdata) |
| `pkg/services/live/pipeline/tree/` | 3 | All 6 files |
| `pkg/services/live/managedstream/` | 2 | All 7 files |
| `pkg/services/live/runstream/` | 2 | All 3 files |
| `pkg/services/live/survey/` | 2 | 1 file |
| `pkg/services/live/orgchannel/` | 2 | 2 files |
| `pkg/services/live/livecontext/` | 2 | 1 file |
| `pkg/services/live/pushws/` | 2 | 3 files |
| `pkg/services/live/pushhttp/` | 2 | 1 file |
| `pkg/services/live/model/` | 2 | 1 file |
| `public/app/features/live/centrifuge/` | 2 | 8 files |
| `docs/sources/setup-grafana/` | 2 | `set-up-grafana-live.md` |

**Tech spec sections retrieved:**

| Section | Content Used For |
|---------|-----------------|
| 4.10 REAL-TIME DATA STREAMING (GRAFANA LIVE) | Architectural overview, pipeline processing, managed stream backends |
| 5.2 COMPONENT DETAILS (§5.2.7) | Grafana Live architecture, Centrifuge integration, channel scope families |
| 3.1 Programming Languages | Go 1.23.1, TypeScript 5.5.4 version confirmation |
| 3.3 Open Source Dependencies | Centrifuge v0.33.3, go-redis v8.11.5, gorilla/websocket v1.5.3 version confirmation |

**Dependency manifests inspected:**

| File | Content Extracted |
|------|-------------------|
| `go.mod` | Go 1.23.1, centrifuge v0.33.3, go-redis v8.11.5, gorilla/websocket v1.5.3 |

### 0.11.2 Attachments

No attachments were provided for this project.

### 0.11.3 Figma Screens

No Figma screens were provided for this project.

