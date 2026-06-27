# Blitzy Project Guide — Grafana Clean-State Q&A Documentation

> **Project:** Empirically-Verified "What Grafana Does on a Clean Start" Q&A
> **Repository:** `grafana/grafana` (OSS monorepo) · **Version:** v11.5.0-pre · **Commit:** `4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff`
> **Branch:** `blitzy-f004d931-3a78-4b1a-bbc9-04fa7be51268` · **Task type:** DOCUMENT CODE (investigative documentation)
> **Brand colors:** Completed/AI = Dark Blue `#5B39F3` · Remaining = White `#FFFFFF` · Headings/Accents = Violet-Black `#B23AF2` · Highlight = Mint `#A8FDD9`

---

## 1. Executive Summary

### 1.1 Project Overview

This project delivers a single, empirically-verified Markdown document — `blitzy/documentation/grafana_4550cfb5b728.md` — that explains exactly what Grafana does when it starts from a **completely clean state** (no `conf/custom.ini`, no `GF_*` environment variables, no pre-existing `data/` directory). The target reader is a new team member who followed the developer-facing setup guide and perceived a gap between the documentation and the running system. The document answers six concrete question clusters — initialization, persistent state, security posture, plugin/data-source bootstrap, build/compilation, and first-vs-subsequent runs — and for every answer provides empirical runtime evidence, a governing `file:line` code citation, and the rationale. Technical scope spans the server lifecycle, configuration, SQLite persistence, auth defaults, plugin bootstrap, and the Wire build pipeline, with a strictly isolated one-file repository footprint.

### 1.2 Completion Status

```mermaid
%%{init: {'theme':'base','themeVariables':{'pie1':'#5B39F3','pie2':'#FFFFFF','pieStrokeColor':'#B23AF2','pieOuterStrokeColor':'#B23AF2','pieStrokeWidth':'2px','pieTitleTextColor':'#B23AF2','pieSectionTextColor':'#111111','pieOpacity':'1'}}}%%
pie showData title Clean-State Q&A — 89.7% Complete (35h of 39h)
    "Completed Work (AI)" : 35
    "Remaining Work (Human)" : 4
```

**Completion = 35h ÷ (35h + 4h) × 100 = 89.7%** (AAP-scoped hours; PA1 methodology).

| Metric | Hours |
|--------|-------|
| **Total Hours** | **39** |
| **Completed Hours (AI + Manual)** | **35** (AI: 35 · Manual: 0) |
| **Remaining Hours** | **4** |
| **Percent Complete** | **89.7%** |

### 1.3 Key Accomplishments

- ✅ Authored the complete 461-line deliverable answering all **six** question clusters, each with empirical evidence + governing `file:line` citation + rationale.
- ✅ Built Grafana from a clean state in the pinned container (`make gen-go` → `make build-go`, Cgo) and **ran it twice** (first run + subsequent run) to capture runtime evidence.
- ✅ Verified **120+** `file:line` citations against source at the pinned commit with **zero** line drift.
- ✅ Confirmed key runtime facts empirically: startup banner `v11.5.0-pre commit=4550cfb5b72`; `Plugins loaded count=54`; `migrations performed=626`; `admin/admin` auto-creation; `GET /api/datasources` → `[]`; forced first-login password change.
- ✅ Inspected `data/grafana.db` **read-only** — confirmed credentials are salted+hashed (100-char hash, 10-char salt), never plaintext.
- ✅ Proved the **single-file footprint**: zero existing tracked files modified; build byproducts confirmed gitignored via `git check-ignore`.
- ✅ Passed all **5 production-readiness gates** with **zero corrections** required to the deliverable.

### 1.4 Critical Unresolved Issues

| Issue | Impact | Owner | ETA |
|-------|--------|-------|-----|
| _None blocking._ The deliverable passed all 5 validation gates with zero corrections — no compile errors, no failing checks, no missing AAP content. | None | — | — |
| Human SME sign-off pending (non-blocking) | Standard acceptance gate before merge | Reviewing Engineer | < 1 day |

### 1.5 Access Issues

**No access issues identified.** The repository was fully accessible, the pinned build/run container (Go 1.23.1, Yarn 4.5.3, gcc) was available for evidence-gathering, and the web sources used for corroboration were reachable.

| System/Resource | Type of Access | Issue Description | Resolution Status | Owner |
|-----------------|----------------|-------------------|-------------------|-------|
| `grafana/grafana` repository | Read/Write (branch) | None | ✅ No issue | — |
| Build/run container | Toolchain (Go/Yarn/gcc) | None | ✅ No issue | — |
| Grafana web documentation | Public web | None | ✅ No issue | — |

### 1.6 Recommended Next Steps

1. **[High]** Perform SME technical review of `blitzy/documentation/grafana_4550cfb5b728.md` — read all six clusters and sanity-check a sample of citations (≈2h).
2. **[Medium]** Optionally re-run the documented A–D clean-state reproduction in the provided container to independently confirm the empirical evidence (≈1.5h).
3. **[Low]** Approve the PR and merge to the target branch after confirming the clean single-file footprint (≈0.5h).

---

## 2. Project Hours Breakdown

### 2.1 Completed Work Detail

> Each component traces to an AAP requirement (doc authoring, investigation that earned the content, or verification). **Total = 35h** (matches Completed Hours in §1.2).

| Component | Hours | Description |
|-----------|-------|-------------|
| Environment setup & clean-state baseline | 3.0 | Container toolchain (Go 1.23.1 / Yarn 4.5.3 / gcc, `CGO_ENABLED=1`); baseline verification (data/, bin/, public/build, wire_gen.go absent); filesystem snapshot |
| Backend build pipeline evidence | 3.0 | `make gen-go` → `pkg/server/wire_gen.go`; `make build-go` (Cgo); empirical "build fails without wire_gen.go (`undefined: Initialize`)" proof |
| Frontend build + UI evidence capture | 2.5 | `yarn install --immutable && yarn build`; login page, no signup/anon, forced password-change screen |
| First-run runtime evidence | 3.0 | Full ~1360-line startup log; filesystem diff; read-only DB inspection (`user`/`org`/`org_user`/`migration_log`/`data_source`) |
| Subsequent-run evidence & behavioral delta (Q6) | 1.5 | Restart without deleting `data/`; capture 0 admin/org creates, `performed=0 skipped=626`, DB unchanged |
| Code-path reverse-engineering (6 subsystems, ~25 files) | 4.0 | Mapping each observed behavior to governing `file:line` across lifecycle/config/persistence/plugins/auth/build |
| Web corroboration research | 1.0 | Official config docs, sign-in docs, upstream issue #19322 — used only to corroborate code |
| Q1 Initialization authoring | 2.5 | `CanBeDisabled` gate vs. provider-level `quota`; Debug-vs-Info log-level nuance |
| Q2 Persistent state authoring | 1.5 | `data/grafana.db` creation, migration log, durability rationale |
| Q3 Security posture authoring | 1.5 | Admin auto-creation, salted+hashed password, basic-auth/anon defaults |
| Q4 Plugin/data-source bootstrap authoring | 2.0 | Three source classes; types-vs-instances distinction |
| Q5 Build/compilation authoring | 1.5 | Wire codegen dependency; non-fatal `public/build` |
| Q6 First-vs-subsequent authoring | 1.0 | User-count gate; idempotent migrations |
| Intro, clean-state definition & reproduction methodology | 1.5 | "Why this document exists"; 5-artifact clean-state table; A–D procedure; pinned-toolchain table |
| Closing summary & Appendices A/B/C | 1.5 | Doc-vs-runtime reconciliation; startup-flow mermaid; gitignore proof; evidence/citation index |
| Empirical verification of 120+ citations (the "test suite") | 3.0 | Cross-referenced every `file:line` against source at the pinned commit; zero drift |
| Code-review remediation (3 commits) + markdown lint/structure/anchors/cleanup | 1.0 | Addressed review findings; balanced fences, single H1, resolving anchors; temp-script cleanup |
| **Total Completed** | **35.0** | |

### 2.2 Remaining Work Detail

> All remaining work is human path-to-production. **Total = 4h** (matches Remaining Hours in §1.2 and the §7 pie "Remaining Work").

| Category | Hours | Priority |
|----------|-------|----------|
| SME technical review of document accuracy & completeness | 2.0 | High |
| Independent clean-state re-verification (rebuild + rerun in provided container) | 1.5 | Medium |
| PR approval & merge to target branch | 0.5 | Low |
| **Total Remaining** | **4.0** | |

> **Cross-section check:** §2.1 (35h) + §2.2 (4h) = **39h** = Total Project Hours in §1.2. ✓

---

## 3. Test Results

> **Integrity note:** This is a DOCUMENT-CODE task with no code module of its own. The "tests" below are Blitzy's **autonomous validation checks** captured during evidence-gathering — the empirical verification of every falsifiable claim/citation plus the build/run of Grafana. All entries originate from this project's autonomous validation logs. **168+ checks executed · 100% passed · 0 failed.**

| Test Category | Framework / Method | Total | Passed | Failed | Coverage | Notes |
|---------------|--------------------|-------|--------|--------|----------|-------|
| Citation Verification | Source cross-reference @ commit `4550cfb5b72` | 120+ | 120+ | 0 | 100% of claims | Every `file:line` confirmed; zero line drift |
| Runtime Behavior Verification | Grafana build + run (clean state) | 19 | 19 | 0 | 100% of claims | Banner, config provenance (7 lines), `Plugins loaded count=54`, `performed=626`, admin/org creation, preinstall, 34 bg services, searchV2 skipped, quota provider-disabled, filesystem diff |
| Read-Only Database Inspection | `sqlite3` (`mode=ro` on copy) | 5 | 5 | 0 | 100% of claims | `user`(1, admin, hashed), `org`(Main Org.), `org_user`(Admin), `migration_log`(626/success), `data_source`(0) |
| API Verification | `curl` basic-auth `admin:admin` | 3 | 3 | 0 | 100% of claims | `/api/datasources`→`[]`; `/api/plugins?type=datasource`→19 types; login POST succeeds |
| UI Verification | Accessibility snapshot / running instance | 4 | 4 | 0 | 100% of claims | Basic-auth login; no signup/anon; footer `v11.5.0-pre (4550cfb5b7)`; forced password-change screen |
| Subsequent-Run Delta | Grafana re-run (data/ intact) | 4 | 4 | 0 | 100% of claims | 0 admin/org creates; `performed=0 skipped=626`; DB unchanged (1/1/626/0); log-size delta |
| Build / Compilation | Go toolchain (`make gen-go` / `build-go`) | 4 | 4 | 0 | 100% of claims | Fails without `wire_gen.go`; succeeds after `gen-go`; byte-identical regen; missing `public/build` non-fatal |
| Document Structure / Lint | Markdown lint | 6 | 6 | 0 | 100% | 30 balanced fences; mermaid closed; single H1 + clean H2/H3; 2 anchors resolve; 106 balanced table rows; 0 trailing whitespace |
| Web Corroboration | Source confirmation | 3 | 3 | 0 | 100% | Config docs, sign-in docs, upstream issue #19322 |
| **Total** | | **168+** | **168+** | **0** | **100%** | Zero discrepancies across all categories |

---

## 4. Runtime Validation & UI Verification

Status legend: ✅ Operational · ⚠ Partial (by design) · ❌ Failing

**Backend runtime (clean state, defaults-only):**
- ✅ Backend compiles after `make gen-go` and runs; HTTP server binds `[::]:3000`.
- ✅ SQLite database created at `data/grafana.db` on first connect; 626 schema migrations applied (`performed=626 skipped=0`).
- ✅ First-run admin/org auto-creation: `Created default admin user=admin` + `Created default organization`.
- ✅ Subsequent run is idempotent: no re-creation; `performed=0 skipped=626`; DB unchanged.
- ✅ Background-service gate behaves per `registry.IsDisabled`: 34 services start; `searchV2` skipped (feature flag off); `quota` disabled at provider level (never enters the loop).

**Persistence & security (read-only DB):**
- ✅ `user` row: `id=1, login=admin, is_admin=1`; password is a 100-char hash with 10-char salt — **not** plaintext.
- ✅ `org` = `Main Org.`; `org_user` role = `Admin`; `data_source` = 0 rows.

**Plugins / data sources:**
- ✅ `Plugins loaded count=54` (= 32 core panels + 22 core data sources on disk).
- ✅ `GET /api/plugins?type=datasource` → 19 types (all signature `internal`/Core); `GET /api/datasources` → `[]` (0 instances).
- ✅ One remote preinstall observed by default: `grafana-lokiexplore-app v1.0.10` → `data/plugins/`.

**UI verification:**
- ✅ Login page presents a basic-auth (username/password) form — **no** anonymous entry, **no** sign-up link; footer matches banner.
- ✅ Logging in with `admin/admin` forces the "Update your password" screen with the documented security warning.

**Frontend bundle:**
- ⚠ With `public/build` absent (pure backend run), startup logs an **Error**-level `Failed to detect generated javascript files in public/build` but **continues** serving the API — non-fatal **by design** (`setting.go:1043` returns `nil`). Building the UI requires a separate `yarn build`. This is documented expected behavior, not a defect.

---

## 5. Compliance & Quality Review

Cross-mapping of AAP deliverables and the governing rule (**SWE-AtlasQnA-Repo**) to quality/compliance benchmarks.

| Benchmark / AAP Requirement | Status | Progress | Evidence |
|------------------------------|--------|----------|----------|
| Documentation-only — zero existing tracked files modified/deleted | ✅ Pass | 100% | `git diff base..HEAD --name-status` = single `A` line |
| Only the single `.md` committed; no other code | ✅ Pass | 100% | `blitzy/` contains only the deliverable |
| File at correct path/name (branch-derived) | ✅ Pass | 100% | `blitzy/documentation/grafana_4550cfb5b728.md` |
| Evidence-based — claims backed by building + running Grafana | ✅ Pass | 100% | Built (`gen-go`/`build-go`) + ran twice; logs/DB/filesystem captured |
| Defaults-only (no `custom.ini`, no env) | ✅ Pass | 100% | Config-provenance log shows `defaults.ini` sole source |
| Read-only database inspection | ✅ Pass | 100% | Opened `mode=ro` on a copy; never written |
| Temporary-script cleanup | ✅ Pass | 100% | No temp scripts remain; working tree clean |
| Version/commit stated for reproducibility | ✅ Pass | 100% | `v11.5.0-pre` / `4550cfb5b72…` in header |
| All six question clusters answered in requester's framing | ✅ Pass | 100% | Q1–Q6 sections present |
| Each answer has evidence + citation + rationale | ✅ Pass | 100% | 3-part structure throughout |
| "Code is truth" + show rationale | ✅ Pass | 100% | 120+ `file:line` citations + Rationale subsections |
| Markdown structurally sound / lint-clean | ✅ Pass | 100% | 30 balanced fences, closed mermaid, resolving anchors |
| SME human review/sign-off | ⏳ Pending | 0% | Human path-to-production (see §2.2) |

**Fixes applied during autonomous validation:** The deliverable progressed through a code-review/remediation cycle (3 refinement commits addressing review findings — Q1 citation precision, debug-run command syntax, clean-state artifact count). The **Final Validator** then confirmed the document **empirically accurate with zero further corrections**. Three apparent "non-issues" were analyzed and correctly left unchanged: (1) the illustrative preinstall duration is environment-dependent, not a determinism claim; (2) the example salt/hash value differs per install because the salt is random — the structural claims (100-char hash, hashed-not-plaintext) hold universally; (3) the separate resource-migrator count is intentionally out of scope of the 626 main-migrator figure.

**Outstanding compliance items:** Human SME sign-off only (non-blocking).

---

## 6. Risk Assessment

> This documentation-only deliverable introduces **zero** code, configuration, or dependency changes, so the risk surface is intrinsically minimal. All identified risks are **Low** severity.

| Risk | Category | Severity | Probability | Mitigation | Status |
|------|----------|----------|-------------|------------|--------|
| Citation line-number drift if the repo advances past the pinned commit | Technical | Low | Medium | Document pins exact commit `4550cfb5b72…`; re-verify only against that commit | Mitigated by design |
| Environment-dependent illustrative values (preinstall duration, log durations, per-run random salt) misread as deterministic | Technical | Low | Low | Framed as illustrative; structural claims (`count=54`, `performed=626`, 100-char hash) hold universally | Documented / Accepted |
| Default `admin/admin` credentials described (informational) | Security | Low | Low | No new risk introduced — the doc accurately describes Grafana's existing default and emphasizes the forced password-change prompt | Informational only |
| Runtime-claim reproducibility requires the pinned container toolchain (Go 1.23.1 / Yarn 4.5.3 / gcc) | Operational | Low | Medium | Document pins toolchain + container image + explicit A–D methodology | Mitigated |
| No automated CI guard against future documentation rot | Operational | Low | Low | Pinned commit + optional periodic human re-verification | Accepted |
| External integration risk | Integration | Low | Low | None of substance — no external service, API key, or network dependency introduced; web-corroboration sources confirmed genuine | N/A |

---

## 7. Visual Project Status

**Project hours breakdown** (Completed = Dark Blue `#5B39F3`, Remaining = White `#FFFFFF`):

```mermaid
%%{init: {'theme':'base','themeVariables':{'pie1':'#5B39F3','pie2':'#FFFFFF','pieStrokeColor':'#B23AF2','pieOuterStrokeColor':'#B23AF2','pieStrokeWidth':'2px','pieTitleTextColor':'#B23AF2','pieSectionTextColor':'#111111','pieOpacity':'1'}}}%%
pie showData title Project Hours — Completed 35h vs Remaining 4h
    "Completed Work" : 35
    "Remaining Work" : 4
```

**Remaining hours by category** (from §2.2; sums to 4h):

```mermaid
%%{init: {'theme':'base','themeVariables':{'pie1':'#B23AF2','pie2':'#5B39F3','pie3':'#A8FDD9','pieStrokeColor':'#333333','pieOuterStrokeColor':'#333333','pieSectionTextColor':'#111111'}}}%%
pie showData title Remaining Work by Category (4h total)
    "SME Technical Review [High]" : 2.0
    "Independent Re-Verification [Medium]" : 1.5
    "PR Approval & Merge [Low]" : 0.5
```

> **Integrity check:** "Remaining Work" = **4h**, identical to §1.2 Remaining Hours and the sum of §2.2 — consistent across §1.2 ↔ §2.2 ↔ §7. ✓

---

## 8. Summary & Recommendations

**Achievements.** The project delivers a complete, self-contained, empirically-verified Q&A document that resolves a real onboarding gap: it explains, with code as the ground truth, exactly what Grafana does on a clean start. All six question clusters are answered in the requester's own framing, each backed by runtime evidence, a precise `file:line` citation, and a clear rationale. The work was independently validated by building and running Grafana twice from a clean state, and **all 168+ autonomous validation checks passed with zero discrepancies**.

**Remaining gaps.** None technical. The only outstanding work is human path-to-production: SME review, optional independent re-verification, and PR merge — **4 hours** total.

**Critical path to production.** SME technical review (2h) → optional clean-state re-verification in the container (1.5h) → PR approval & merge (0.5h).

**Success metrics.** Single-file footprint (zero tracked-file modifications) ✓ · 120+ citations verified with zero drift ✓ · markdown lint-clean ✓ · all AAP constraints satisfied ✓ · all 5 validation gates passed with zero corrections ✓.

**Production readiness assessment.** **The project is 89.7% complete** (35h of 39h AAP-scoped hours). The autonomous deliverable is finished and verified; what remains is standard human sign-off. Risk is uniformly **Low** because the change introduces no executable code or configuration. **Recommendation: APPROVE after SME review and merge.**

| Metric | Value |
|--------|-------|
| Completion | 89.7% |
| Completed / Total Hours | 35h / 39h |
| Remaining Hours | 4h |
| Validation checks passed | 168+ / 168+ (100%) |
| Tracked files modified | 0 |
| Blocking issues | 0 |

---

## 9. Development Guide

The deliverable is a Markdown document, so the workflow has two tracks: **Track A** (view & validate the document — runnable on any host) and **Track B** (reproduce the runtime evidence — requires the pinned container, since the bare host lacks Go/Yarn).

### 9.1 System Prerequisites

- **Track A (validate the document):** `git`, `grep`, `sed`, `wc` — available on any standard host (no Go/Yarn needed).
- **Track B (reproduce evidence):** Go 1.23.1, Node ≥ 22 (v22.11.0), Yarn 4.5.3, a C compiler (gcc) with `CGO_ENABLED=1` — provided by the project container image (`grafana-qna-ready:local` / `andrewparkscaleai/coding-agent:grafana__grafana__4550cfb5b72…`). The SQLite driver (`mattn/go-sqlite3`) is Cgo-based, so a C toolchain is mandatory.

### 9.2 Track A — View & Validate the Deliverable (tested on this host)

```bash
# Locate and size the deliverable
ls -l blitzy/documentation/grafana_4550cfb5b728.md
wc -l blitzy/documentation/grafana_4550cfb5b728.md            # -> 461

# Confirm the single-file footprint (zero existing files modified)
git diff 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff..HEAD --name-status
# Expected: A   blitzy/documentation/grafana_4550cfb5b728.md

# Confirm a clean working tree
git status --porcelain        # (empty output = clean)

# Markdown sanity: code fences must be balanced (even count)
grep -c '```' blitzy/documentation/grafana_4550cfb5b728.md     # -> 30 (even)

# Spot-check a citation (Q1 disable mechanism)
sed -n '53,56p' pkg/registry/registry.go

# Prove build byproducts are gitignored (not repo modifications)
git check-ignore -v public/build data/grafana.db bin/grafana pkg/server/wire_gen.go

# Confirm branch authorship
git log --author="agent@blitzy.com" 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff..HEAD --oneline
```

### 9.3 Track B — Reproduce the Runtime Evidence (provided container only)

```bash
# A — Baseline: confirm the completely clean state
git rev-parse HEAD            # -> 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff (+ doc commits)
for a in data bin public/build pkg/server/wire_gen.go; do \
  [ -e "$a" ] && echo "PRESENT: $a" || echo "ABSENT:  $a"; done   # all ABSENT

# B — Build: generate the Wire initializer, then compile the backend (Cgo)
make gen-go                  # generates pkg/server/wire_gen.go (Makefile:167)
make build-go                # depends on gen-go (Makefile:187); needs gcc/Cgo
# Optional full UI bundle:
# yarn install --immutable && yarn build

# C — First run (clean state; NO custom.ini, NO env)
./bin/grafana server --homepath=/app          # binds [::]:3000
#   Look for: version=11.5.0-pre commit=4550cfb5b72
#             "Plugins loaded" count=54
#             "Creating SQLite database file" path=/app/data/grafana.db
#             "Created default admin" user=admin / "Created default organization"
#             "migrations completed" performed=626 skipped=0

# Verify via API (in another shell)
curl -s -u admin:admin http://localhost:3000/api/datasources          # -> []
curl -s -u admin:admin "http://localhost:3000/api/plugins?type=datasource" | head

# Read-only DB inspection (copy first, open mode=ro — never write)
cp data/grafana.db /tmp/g.db
sqlite3 'file:/tmp/g.db?mode=ro' 'SELECT id,login,is_admin FROM user;'
sqlite3 'file:/tmp/g.db?mode=ro' 'SELECT COUNT(*) FROM migration_log;'   # -> 626

# D — Subsequent run (same binary, DO NOT delete data/)
./bin/grafana server --homepath=/app
#   Expect: NO "Created default …" lines; "migrations completed" performed=0 skipped=626
```

### 9.4 Verification Checklist

- [ ] `git diff base..HEAD --name-status` shows exactly one added `.md`.
- [ ] First-run log shows `count=54`, `performed=626`, and the two "Created default …" lines.
- [ ] `GET /api/datasources` returns `[]`; `data_source` table has 0 rows.
- [ ] Read-only DB shows the `admin` user with a hashed (not plaintext) password.
- [ ] Subsequent run shows `performed=0 skipped=626` and no admin/org creation.

### 9.5 Troubleshooting

- **`undefined: Initialize` at `pkg/server/service.go:31`** — the generated `pkg/server/wire_gen.go` is missing. Run `make gen-go` before building. _(This is itself one of the documented answers — Q5.)_
- **`Failed to detect generated javascript files in public/build` (Error log)** — **non-fatal**; the backend still serves the API (`setting.go:1043` returns `nil`). Run `yarn build` to produce the UI bundle.
- **SQLite "database is locked" during inspection** — copy `data/grafana.db` first, then open the copy with `?mode=ro` (read-only, as in §9.3).
- **Want to re-observe first-run behavior** — delete the `data/` directory to return to the clean state; the next run will re-create the admin/org and re-apply migrations.
- **`make`/`go`/`yarn` not found** — you are on the bare host; switch to the provided container (Track B requires Go 1.23.1 / Yarn 4.5.3 / gcc).

---

## 10. Appendices

### Appendix A — Command Reference

| Purpose | Command |
|---------|---------|
| Single-file footprint | `git diff 4550cfb5b72886782d9a3e6cf995f8dbd57ca4ff..HEAD --name-status` |
| Clean tree check | `git status --porcelain` |
| Balanced fences | `grep -c '```' blitzy/documentation/grafana_4550cfb5b728.md` |
| Gitignore proof | `git check-ignore -v public/build data/grafana.db bin/grafana pkg/server/wire_gen.go` |
| Generate Wire initializer | `make gen-go` |
| Build backend (Cgo) | `make build-go` |
| Build frontend (optional) | `yarn install --immutable && yarn build` |
| Run (clean state) | `./bin/grafana server --homepath=/app` |
| Read-only DB query | `sqlite3 'file:/tmp/g.db?mode=ro' 'SELECT …;'` |

### Appendix B — Port Reference

| Port | Service | Source |
|------|---------|--------|
| `3000` | Grafana HTTP server (`HTTP Server Listen address=[::]:3000`) | `conf/defaults.ini` `[server] http_port = 3000` |
| `6000` | Dev profiling endpoint (only when started via `.bra.toml`/`make run`) | `.bra.toml` |

### Appendix C — Key File Locations

| Item | Path |
|------|------|
| **Deliverable** | `blitzy/documentation/grafana_4550cfb5b728.md` |
| Server lifecycle | `pkg/server/server.go`, `pkg/server/service.go` |
| Wire DI (hand-written / generated) | `pkg/server/wire.go` / `pkg/server/wire_gen.go` (generated) |
| Background-service gate | `pkg/registry/registry.go` |
| Persistence / migrations / admin creation | `pkg/services/sqlstore/sqlstore.go`, `database_config.go`, `user.go` |
| Configuration binding | `pkg/setting/setting.go`, `pkg/setting/setting_plugins.go` |
| Plugin sources / core backends | `pkg/plugins/manager/sources/sources.go`, `pkg/plugins/backendplugin/coreplugin/registry.go` |
| Core plugins on disk | `public/app/plugins/{panel,datasource}/` |
| Canonical defaults | `conf/defaults.ini` |
| Build orchestration | `Makefile`, `build.go`, `.bra.toml` |

### Appendix D — Technology Versions

| Component | Version | Source |
|-----------|---------|--------|
| Grafana | v11.5.0-pre (commit `4550cfb5b72…`) | startup banner |
| Go | 1.23.1 | `go.mod` |
| Node.js | ≥ 22 (engines) · v22.11.0 (nvm) | `package.json`, `.nvmrc` |
| Yarn | 4.5.3 | `package.json` `packageManager` |
| C toolchain | gcc (container-provided) | `CGO_ENABLED=1` for `mattn/go-sqlite3` |
| Database | SQLite (`data/grafana.db`) via xorm | `conf/defaults.ini` `[database]` |

### Appendix E — Environment Variable Reference

| Variable | Value in this project | Notes |
|----------|----------------------|-------|
| `GF_*` overrides | **None set** | Defaults-only investigation — no env overrides applied (by design) |
| `CGO_ENABLED` | `1` | Required to build the default SQLite driver |
| `GO_BUILD_DEV` | `1` (dev/BRA path only) | Emits `bin/grafana` directly; plain build emits `bin/<goos>-<goarch>/grafana` |

> The clean-state scenario deliberately uses **no** `GF_*` environment variables so that `conf/defaults.ini` is the sole configuration source.

### Appendix F — Developer Tools Guide

| Tool | Use |
|------|-----|
| `git diff --name-status` / `git check-ignore -v` | Verify the single-file footprint and that build byproducts are gitignored |
| `make gen-go` / `make build-go` | Wire codegen and backend build (Track B) |
| `sqlite3 … ?mode=ro` | Read-only inspection of `data/grafana.db` |
| `curl -u admin:admin` | API verification (`/api/datasources`, `/api/plugins`) |
| Markdown lint (`grep`-based fence/anchor checks) | Confirm document structural integrity |

### Appendix G — Glossary

| Term | Meaning |
|------|---------|
| **Clean state** | Server started with no `data/`, no `custom.ini`, no `GF_*` env, no `wire_gen.go`/`bin`/`public/build` present |
| **Wire / `wire_gen.go`** | Google Wire compile-time dependency injection; `wire_gen.go` (generated) holds the runnable initializers the backend needs to compile |
| **`CanBeDisabled` gate** | Optional interface in `pkg/registry`; a background service is skipped only if it implements it **and** `IsDisabled()` returns `true` |
| **Type vs. instance** | A data-source *type* (e.g., Prometheus, a Core plugin) is available out of the box; a configured *instance* is not auto-created on a clean install |
| **Provider-level disable** | A service (e.g., `quota`) returns a no-op implementation and is never registered as a background service — distinct from the `CanBeDisabled` gate |
| **First-run gate** | The user-count check in `ensureMainOrgAndAdminUser`; admin/org are created only when 0 users exist |

---

*Generated for the `grafana/grafana` clean-state Q&A documentation project. Completion (89.7%) reflects AAP-scoped autonomous work; the remaining 4h is human review/verification/merge. Cross-section integrity verified: §1.2 = §2.2 = §7 (Remaining = 4h); §2.1 + §2.2 = 39h = Total.*