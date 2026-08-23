# Project: Stremio Adom Improvements Roadmap (PLANO_MELHORIAS)

> Authoritative architectural specification, feature inventory, milestone plan, and interface contracts for the Stremio Adom enhancements and modular refactoring.

## Architecture

> **Estado (2026-08-23):** as seções abaixo descrevem o layout **alvo do M3**
> (`PLANO_MELHORIAS.md` fase 5), não necessariamente o que já existe em
> `src/`. Confira a tabela de **Milestones** para o status real de cada item
> (`DONE` = já existe no código; `PLANNED`/`IN_PROGRESS` = ainda não). Para o
> layout **atual** e o porquê de cada decisão, `AGENTS.md` é a fonte de
> verdade — ele nunca descreve estado futuro como presente.
- **Process & Application Layer**:
  - `src/addon.ts`: Process runner, port listening, embedded Brazilian resolvers supervisor, global `unhandledRejection` handler, dead magnet cleaner, graceful shutdown.
  - `src/app.ts`: Express application factory (`createApp()`), route definitions (`/manifest.json`, `/stream/:type/:id.json`, `/resolve/:infoHash`, `/configure`, `/seal-config`, `/metrics.json`, `/test-indexer.json`, `/debrid-status.json`, `/dashboard-status.json`, `/dashboard-action.json`).
- **Providers & Orchestration Layer**:
  - `src/providers/search-orchestrator.ts`: Query planning, Cinemeta/TMDB metadata, raw provider fan-out (`collectRaw`), Brazilian priority grace, pack fallbacks, enrichment tails. Phase control stays implicit via `latest-writer`'s `finish.phase()`/`finish.advance()` — no explicit `SearchPhase` state machine (A3 not implemented).
  - `src/providers/search-cache.ts`: Stale-While-Revalidate (SWR) cache handling, request coalescing (`inFlight`), background revalidation (`scheduleStaleRefresh`).
  - `src/providers/stream-builder.ts`: Stream parsing, relevance filtering, release index evidence, quota clamping, Brazilian slot reservation (`limitReservingBr`), notice generation.
  - `src/providers/debrid-pipeline.ts`: Bad/dead/miss magnet filtering, dynamic budget allocation (`remainingCheckBudget`), debrid cache checking, P2P degradation, HMAC signing, audio audit tails.
  - `src/providers/autofetch-runner.ts`: Candidate stream hold acquisition, persistent queue management (`drainNext`), hourly limit backoff, settle LRU, and periodic recheck loop.
  - `src/providers/index.ts`: Backward-compatible facade re-exporting provider APIs.
- **Debrid Layer**:
  - `src/debrid/file-selector.ts`: Video file parsing, multi-work collection resolution, episode matching, and error classes (`WorkPickError`, `EpisodePickError`, `NoVideoError`, `DubLieError`).
  - `src/debrid/common.ts`: Adapter common utilities, network helpers, re-exports from file-selector.
  - `src/debrid/alldebrid.ts`: AllDebrid adapter with snapshot TTL (`ALLDEBRID_PREEXISTING_TTL_MS`), fail-safe closed behavior, decoupled `dropReady` and `dropDownload` cleanups.
  - `src/debrid/{premiumize,torbox,realdebrid,debridlink}.ts`: Debrid adapters for Premiumize, TorBox, Real-Debrid, and Debrid-Link.
- **Utilities & Formatting Layer**:
  - `src/utils/title-normalization.ts`: Clean title normalization, entity decoding, sequence numerals.
  - `src/utils/release-matching.ts`: Precision title matching, `matchesBrTitle`, `matchesEpisodeWorkIdentity`, `magnetYearContradicts`, franchise roots.
  - `src/utils/episode-matching.ts`: Season/episode parsing, season pack identification.
  - `src/utils/audio-quality.ts`: Audio/language classifiers, resolution detection, audio lie audit.
  - `src/utils/stream-ranking.ts`: Sorting algorithms, deduplication by hash, candidate selection pools.
  - `src/utils/stream-quotas.ts`: Multi-dimensional quotas (quality, indexer, Brazilian reserved slots).
  - `src/utils/search-names.ts`: Cinemeta/TMDB name resolution, Stremio ID parser, Stremio stream formatter.
  - `src/utils/format.ts`: Backward-compatible barrel re-exporting all formatting and ranking APIs.
  - `src/utils/net-safety.ts`: SSRF filter (`isSafeDownloadUrl`) for Torznab download links.
  - `src/utils/cache.ts`: SQLite L2 + in-memory L1 cache with corrupted database auto-recovery.
- **Brazilian Resolvers Microservices**:
  - `bludv-resolver`, `comandotorrents-resolver`, `nerdfilmes-resolver`, `torrentdosfilmes-resolver`: Microservices running on internal ports 8700–8703 with shared core engine (`resolvers/` runtime).

---

## Code Layout
- `src/addon.ts`: Process entry point & lifecycle management.
- `src/app.ts`: Express application composition & route handlers.
- `src/config.ts`: Centralized operator environment configuration.
- `src/runtime.ts`: User configuration overlay (`opts()`, `AsyncLocalStorage`).
- `src/providers/*.ts`: Provider search orchestration, autofetch runner, debrid pipeline, stream builder.
- `src/debrid/*.ts`: Debrid adapters, file selector, common helpers.
- `src/utils/*.ts`: Format submodules, cache, net-safety, magnetdb, release-index.
- `test/*.test.ts`: Complete unit test suite (63+ files tracked in `package.json`).
- `test/e2e/*.test.ts`: Opaque-box E2E test suite (Tiers 1–4).
- `test/*challenger*.ts`, `test/*stress*.ts`, `test/*adversarial*.ts`: Empirical bench test harnesses.

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | B1 Snapshot TTL & Fail-Safe Closed | AllDebrid snapshot expiration (`ALLDEBRID_PREEXISTING_TTL_MS`) + fail-safe closed on mock 500 | M1 | PLANO_MELHORIAS §1 |
| 2 | B2 Decoupled Cleanups | Independent `dropReady` vs `dropDownload` cleanups and metrics in AllDebrid | M1 | PLANO_MELHORIAS §1 |
| 3 | S1 Unhandled Rejections & Async Routes | Top-level `unhandledRejection` handler + `asyncRoute` Express wrappers | M1 | PLANO_MELHORIAS §2 |
| 4 | S2 SSRF Net Safety | Torznab `isSafeDownloadUrl` blocking private IPs and link-local addresses | M1 | PLANO_MELHORIAS §2 |
| 5 | S3 Diagnostic Gate Enclosure | Enforce `diagnosticGate.enter('global')` on `/debrid-status.json` and `/metrics.json` | M1 | PLANO_MELHORIAS §2 |
| 6 | S4 Destructive Action Confirmation | Require `{"confirm": true}` for `clear-cache` and `sweep-dead` dashboard actions | M1 | PLANO_MELHORIAS §2 |
| 7 | S5 Node 22 Type Pinning | Pin `@types/node` to `^22.0.0` aligned with `node:22-alpine` runtime | M1 | PLANO_MELHORIAS §2 |
| 8 | B4 Autofetch Drain Backoff | Queue cycling on hourly budget exhaustion + backoff via `DEBRID_AUTO_FETCH_DRAIN_BACKOFF_MS` | M1 | PLANO_MELHORIAS §2 |
| 9 | Corrupted L2 SQLite Recovery | Auto-rename corrupted database to `cache.db.corrupt` and recreate clean DB on boot | M1 | PLANO_MELHORIAS §2.9 |
| 10 | Production CI Audit Step | Add `npm audit --omit=dev` non-blocking step to CI workflow | M1 | PLANO_MELHORIAS §2.10 |
| 11 | T1 Magnet Year Contradiction Tests | Test matrix for `magnetYearContradicts` in `test/format.test.ts` | M2 | PLANO_MELHORIAS §3.1 |
| 12 | T2 Episode Work Identity Tests | Test matrix for `matchesEpisodeWorkIdentity` in `test/format.test.ts` | M2 | PLANO_MELHORIAS §3.2 |
| 13 | T3 Debrid-Link Test Suite | Dedicated `test/debridlink.test.ts` covering success flows and mocks | M2 | PLANO_MELHORIAS §3.6 |
| 14 | T4 Season Fill & Stall Streak Tests | Tests for `cacheCheck:false` exclusion and `STALL_STREAK=0` in `test/autofetch.test.ts` | M2 | PLANO_MELHORIAS §3.4/3.5 |
| 15 | T5 Brazilian Grace Budget Tests | Test mathematical clamping of `priorityGrace` formula in `test/collection-window.test.ts` | M2 | PLANO_MELHORIAS §3.3 |
| 16 | T6 Adversarial Harness Mutation Safety | Interruption-safe in-memory snapshot and signal restore handlers in `test/empirical-e2e-challenger.ts` | M2 | PLANO_MELHORIAS §3.7 |
| 17 | T7 Harness Tracking in Test Complete | Verify all 6 bench harnesses in `scripts/check-test-list.ts` and `package.json` | M2 | PLANO_MELHORIAS §3.8 |
| 18 | B3 Search Budget Verification | E2E test verifying dynamic budget reduction with slow Cinemeta + TMDB miss | M2 | PLANO_MELHORIAS §4.1 |
| 19 | A1b File Selector Extraction | Extract `src/debrid/file-selector.ts` and re-export via `src/debrid/common.ts` | M3 | PLANO_MELHORIAS §5.2 |
| 20 | A2 Format Utility Modularization | Split `src/utils/format.ts` into 7 specialized submodules with barrel re-export | M3 | PLANO_MELHORIAS §5.3 |
| 21 | A1 Providers Modularization | Split `src/providers/index.ts` into 5 submodules | M3 | DONE (2026-08-23) — PLANO_MELHORIAS §5.1. Explicit `SearchPhase` (A3) not done; phase control stays implicit via latest-writer |
| 22 | A5 Centralized Config | Remove raw `process.env` calls in `src/app.ts` and route through `src/config.ts` | M3 | PLANO_MELHORIAS §5.6 |
| 23 | A4 Brazilian Resolvers Shared Core | Extract common microservice engine into `resolvers/` core with site profiles | M3 | PLANO_MELHORIAS §5.4 |
| 24 | A1c Route Modularization | Modularize `src/app.ts` into route modules (`app/*-routes.ts`) | M3 | PLANO_MELHORIAS §5.5 |
| 25 | A6 Type Refinements | Reduce explicit `any` types and introduce strongly-typed stream/adapter models | M3 | PLANO_MELHORIAS §5.7 |
| 26 | Final Full Verification & Tier 5 Audit | Complete verification across all 1,070+ tests, all 5 harnesses, and forensic audit | M4 | ORIGINAL_REQUEST |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M0 | Survey & Planning | Features 1–26 surveyed, mapped, baseline verified | none | DONE |
| M1 | Debrid Safety & Runtime Robustness | Features 1–10 (B1 tests 1.4/1.5, S3 diagnostic gate, S1.2 asyncRoute, S4 action confirmation, SQLite corrupted recovery, CI audit, SSRF filter remediation) | M0 | DONE |
| M2 | Core Guardrails, Regression Safety & Budget Verification | Features 11–18 (T1–T7, B3 E2E test verification, harness mutation safety) | M1 | IN_PROGRESS |
| M3 | Modular Architectural Refactoring | Features 19–25 (A1–A6: file-selector, format split, providers split, config centralization, resolvers core, any reduction) | M2 | IN_PROGRESS (21/A1 done) |
| M4 | Final Validation, Adversarial Hardening (Tier 5) & E2E Testing | Feature 26: Full regression validation (`npm test`, `npm run test:complete`, `npm run smoke`), all 5 bench harnesses, forensic audit | M3 | PLANNED |

---

## Interface Contracts
### `src/debrid/file-selector.ts` ↔ `src/debrid/common.ts`
- `pickFile(files, hash, opts)`: Selects canonical video file from torrent file list, handling multi-work collections, season/episode filters, audio flags.
- `pickWorkFile(files, work)`: Selects video matching target work title from collection.
- `WorkPickError`, `EpisodePickError`, `NoVideoError`, `DubLieError`: Strong error classes with type guards (`isWorkPickError`, etc.).

### `src/utils/format.ts` Barrel Re-export Contract
- Maintains 100% backward-compatible named exports for all 42+ functions/constants across `title-normalization`, `release-matching`, `episode-matching`, `audio-quality`, `stream-ranking`, `stream-quotas`, `search-names`.

### `src/providers/index.ts` Facade Contract
- Re-exports `findStreams`, `applyDebrid`, `buildStreams`, `debridRefreshSatisfied`, `applyNoticeOrigin`, `onlyNotice`, `autofetchStatus`, `idxPoolCovered`, `poolCovered`.

### Express Async Route Contract
- `asyncRoute(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>)`: Catches unhandled rejections, logs error, returns HTTP 500 response, preventing process crash.
