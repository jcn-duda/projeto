# Project: Stremio Adom Improvements Roadmap (PLANO_MELHORIAS)

> Authoritative architectural specification, feature inventory, milestone plan, and interface contracts for the Stremio Adom enhancements and modular refactoring.

## Architecture

> **Estado (2026-08-31):** o M3 fechou, então as seções abaixo descrevem o
> layout que **já existe** em `src/` — não mais um alvo. A ressalva histórica
> ("isto é o alvo, não o presente") valia enquanto 22/A5 e 25/A6 estavam
> abertos. Confira a tabela de **Milestones** para o status de cada item;
> abertos: M4 (só a auditoria forense do Tier 5) e a janela de baseline do
> 6.3 dentro do M5 (aberta em 2026-08-24 22:58; os 7 dias vencem
> 2026-08-31 22:58 — a decisão de TTL só é legítima depois disso). O M6
> (catraca de linhas 5.8 + extração dos HTML do painel 5.9) fechou em 08-29.
>
> **Pós-M6 (2026-08-30)** — seis commits estendem o que já existe, sem
> milestone novo: `1062ef8` corrige o colhedor (tarefas M1–M6 do **plano do
> colhedor**, `docs/superpowers/plans/2026-08-30-colhedor-correcoes-cobertura-br.md`
> — rótulos do plano, **não** os milestones M1–M6 desta tabela); `a33f96a`
> desacopla o gate das features de operador (`DEBRID_OPERATOR_ENV_ACCOUNT`)
> da herança de chave; `f468fb0` põe banner de incidente com `reason`/`fix`
> no painel e memo de 60s na consulta de saúde da conta; `9b9d72d` adiciona
> `GET /test-resolver.json` (probe direto dos resolvedores BR, sem passar
> pelo Jackett); `9d3e2a6` implementa o ⚡ de memória no degradado
> (`DEBRID_ALIVE_AS_CACHE`, default desligado); `3d6f89d` adiciona o teste
> seguro de conta de debrid no painel (Fase 1 — sem salvar, sem trocar
> config). Medido no checkout em 2026-08-31: **117** arquivos `.ts` em
> `src/` totalizando **20.728 linhas**, e **90** arquivos `*.test.ts`
> (84 unit + 6 e2e), todos na lista explícita do `npm test`
> (`test:complete` verde). Para o porquê de cada decisão, `AGENTS.md`
> continua sendo a fonte de verdade — ele nunca descreve estado futuro como
> presente.
- **Process & Application Layer**:
  - `src/addon.ts`: Process runner, port listening, embedded Brazilian resolvers supervisor, global `unhandledRejection` handler, dead magnet cleaner, graceful shutdown.
  - `src/app.ts`: Express application factory (`createApp()`); route *registration* lives in `src/routes/register.ts` since §5.5 (`/manifest.json`, `/stream/:type/:id.json`, `/resolve/:infoHash`, `/configure`, `/dashboard`, `/seal-config`, `/metrics.json`, `/test-indexer.json`, `/test-resolver.json`, `/debrid-status.json`, `/dashboard-status.json`, `/dashboard-action.json`, plus the `PAGE_ASSETS` allowlist of panel CSS/JS added by §5.9).
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
  - `src/utils/title-normalization.ts`: Clean title normalization, entity decoding, infoHash extraction (base32 magnets included).
  - `src/utils/release-matching.ts`: Precision title matching, `matchesBrTitle`, `matchesEpisodeWorkIdentity`, `magnetYearContradicts`, franchise roots, sequence numerals (`extractSequenceMarkers`).
  - `src/utils/episode-matching.ts`: Season/episode parsing, season pack identification.
  - `src/utils/audio-quality.ts`: Audio/language classifiers, resolution detection, audio lie audit.
  - `src/utils/stream-ranking.ts`: Sorting algorithms, deduplication by hash, candidate selection pools.
  - `src/utils/stream-quotas.ts`: Multi-dimensional quotas (quality, indexer, Brazilian reserved slots).
  - `src/utils/search-names.ts`: Cinemeta/TMDB name resolution, Stremio ID parser, Stremio stream formatter.
  - `src/utils/format.ts`: Backward-compatible barrel re-exporting all formatting and ranking APIs.
  - `src/utils/net-safety.ts`: SSRF filter (`isSafeDownloadUrl`) for Torznab download links.
  - `src/utils/cache.ts`: SQLite L2 + in-memory L1 cache with corrupted database auto-recovery.
- **Brazilian Resolvers Microservices**:
  - `bludv-resolver`, `comandotorrents-resolver`, `nerdfilmes-resolver`, `torrentdosfilmes-resolver`, `vacatorrent-resolver`: Microservices running on internal ports 8700–8704 with shared core engine (`resolvers/` runtime).
- **Panel Layer** (`src/public/`):
  - `configure.html` + `configure.css` + `configure-app.js`; `dashboard.html` + `dashboard.css` + `dashboard-core.js` + `dashboard-panels.js` + `dashboard-status.js` + `dashboard-debrid-test.js` (teste seguro de conta, extraído dos panels ao se aproximar do teto da catraca — `3d6f89d`). ES5, zero build, served as static files through the closed `PAGE_ASSETS` allowlist in `src/routes/public.ts`. The HTML is served from memory with `?v=<content hash>` injected into the asset references, so the assets ship with `maxAge: '30d'` and a deploy can never pair new HTML with a cached old module. The JS anchored by the tests (function bodies matched by regex: `collect`/`apply`/`fromUrl`, `KEYS`, `renderMagnetDb`, the Chupim/Colhedor panels) stays **inline in the HTML by contract** — only the unanchored code was extracted (§5.9).

---

## Code Layout
- `src/**/*.ts`: 117 arquivos, 20.728 linhas (medido no checkout em 2026-08-31).
- `src/addon.ts`: Process entry point & lifecycle management.
- `src/app.ts`: Express application composition only; `src/routes/*.ts` holds registration and handlers.
- `src/config.ts`: Centralized operator environment configuration.
- `src/runtime.ts`: User configuration overlay (`opts()`, `AsyncLocalStorage`).
- `src/providers/*.ts`: Provider search orchestration, autofetch runner, debrid pipeline, stream builder.
- `src/debrid/*.ts`: Debrid adapters, file selector, common helpers.
- `src/utils/*.ts`: Format submodules, cache, net-safety, magnetdb, release-index.
- `resolvers/*.js`: Shared CommonJS core of the five Brazilian resolvers; `resolvers/profiles/*.js`: per-site parsers and rules.
- `src/public/*`: Panel pages (ES5, zero build) — HTML plus the CSS/JS extracted in §5.9.
- `scripts/check-line-budget.ts` + `.line-budget.json`: 400-line ratchet over `.ts`/`.js`/`.css` (§5.8, scope extended to `.css` on 08-29); `npm run lint:lines`.
- `test/*.test.ts`: Complete unit test suite (84 unit + 6 E2E = 90 files tracked in `package.json`; `test:complete` verde em 2026-08-31).
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
| 19 | A1b File Selector Extraction | Extract `src/debrid/file-selector.ts` and re-export via `src/debrid/common.ts` | M3 | DONE (2026-08-24) — PLANO_MELHORIAS §5.2. `src/debrid/file-selector.ts`: `pickFile`/`pickWorkFile`/`workCoverage`/`baseName` + `WorkPickError`/`EpisodePickError`/`NoVideoError`/`DubLieError`; `src/debrid/common.ts` re-exporta (autores originais preservados) |
| 20 | A2 Format Utility Modularization | Split `src/utils/format.ts` into 7 specialized submodules with barrel re-export | M3 | DONE (2026-08-23) — PLANO_MELHORIAS §5.3 |
| 21 | A1 Providers Modularization | Split `src/providers/index.ts` into 5 submodules | M3 | DONE (2026-08-23) — PLANO_MELHORIAS §5.1. Explicit `SearchPhase` (A3) not done; phase control stays implicit via latest-writer |
| 22 | A5 Centralized Config | Remove raw `process.env` calls in `src/app.ts` and route through `src/config.ts` | M3 | DONE (2026-08-24) — PLANO_MELHORIAS §5.6. `app.ts`, `routes/diagnostics.ts`, `utils/cache.ts`, `utils/logger.ts` and `debrid/index.ts` now read from `config`. The 12 remaining `process.env` hits are all in `src/br-resolvers.ts`, which mutates the env on purpose to hand it to the child resolvers, with guaranteed restore |
| 23 | A4 Brazilian Resolvers Shared Core | Extract common microservice engine into `resolvers/` core with site profiles | M3 | DONE (2026-08-24) — PLANO_MELHORIAS §5.4. CommonJS core in `resolvers/` (`runtime.js`, `site-selector.js`, `cache.js`, `protector.js`, `http-server.js`, `flare.js`, `text.js`, `matching.js`, `transport.js`, `nested-url.js`, `torznab.js`, `search-posts.js`, `concurrency.js`) + per-site profiles in `resolvers/profiles/*.js`; each `*-resolver/server.js` is a shim doing `require('../resolvers/profiles/<nome>')`; `build-assets.ts` copies `resolvers/` into `dist/`. **Second pass at `48b6773`:** the first conclusion left real duplication behind — NerdFilmes and TorrentDosFilmes still hand-rolled the protector hop loop (46 and 39 lines) instead of `followProtectedUrl`, `extractMetaRefresh` was byte-identical in two profiles and absent in the other two, and `mapLimit` had four copies. All four sites now share one transport, so mutant MUT-06 (host allowlist) covers four by the same path instead of two. Profiles 3,263 → 3,115 lines; core 474 → 539 |
| 24 | A1c Route Modularization | Modularize `src/app.ts` into route modules (`src/routes/*.ts`) | M3 | DONE (2026-08-24) — PLANO_MELHORIAS §5.5. Real path is `src/routes/` (`register.ts`, `services.ts`, `stream.ts`, `resolve.ts`, `public.ts`, `diagnostics.ts`, `origin.ts`, `state.ts`, `async.ts`, `types.ts`); `createApp()` only composes |
| 25 | A6 Type Refinements | Reduce explicit `any` types and introduce strongly-typed stream/adapter models | M3 | DONE (2026-08-24) — PLANO_MELHORIAS §5.7. Target was <150 explicit `any`; **143** at `e25ef29`, measured with the corrected AST counter (the previous one used `git ls-files 'src/**/*.ts'`, which skips the 6 files at the root of `src/` — it read 66 of 72 files and reported 149 where the real number was 156). Closed by `debrid/alldebrid.ts` 13 → 0 via `AllDebridMagnet`/`AllDebridFileNode` plus the existing `DebridFile[]`/`InventoryItem[]`; typing surfaced 4 latent `undefined` defects the `any` was hiding |
| 26 | Final Full Verification & Tier 5 Audit | Complete verification across the whole suite (1,193 at the time of writing; **1,509** on 2026-08-29), all 6 harnesses, and forensic audit | M4 | ORIGINAL_REQUEST |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M0 | Survey & Planning | Features 1–26 surveyed, mapped, baseline verified | none | DONE |
| M1 | Debrid Safety & Runtime Robustness | Features 1–10 (B1 tests 1.4/1.5, S3 diagnostic gate, S1.2 asyncRoute, S4 action confirmation, SQLite corrupted recovery, CI audit, SSRF filter remediation) | M0 | DONE |
| M2 | Core Guardrails, Regression Safety & Budget Verification | Features 11–18 (T1–T7, B3 E2E test verification, harness mutation safety) | M1 | DONE — T1–T7 in PLANO_MELHORIAS phase 3 (`c9a7888`, `e69450c`), B3 closed by phase 4 (4.1–4.3) |
| M3 | Modular Architectural Refactoring | Features 19–25 (A1–A6: file-selector, format split, providers split, config centralization, resolvers core, any reduction) | M2 | DONE (2026-08-24) — 20/A2 and 21/A1 on 08-23; 19/A1b, 23/A4, 24/A1c, 22/A5 and 25/A6 on 08-24. A3 (explicit `SearchPhase`) was never in scope: phase control stays implicit via latest-writer |
| M4 | Final Validation, Adversarial Hardening (Tier 5) & E2E Testing | Feature 26: Full regression validation (`npm test`, `npm run test:complete`, `npm run smoke`), all 6 bench harnesses, forensic audit | M3 | OPEN — regression half re-validated on 08-24 after Fase 6 (build, 1.200 tests, `test:complete` 66+6, the 6 harnesses, mutation score 10/10 — 20 sequential + 6 parallel, APPROVE) and again on **08-29** after M6: build, **1.509 tests**, `test:complete` **87+6**, `lint:lines` baseline OK, `npm run smoke` green against the rebuilt container. `npm run smoke` had its window recalibrated (PLANO_MELHORIAS 6.6) and passes with cold cache. What is still missing is the Tier 5 forensic audit, which does not run in any gate |
| M5 | Fase 6 — Longo prazo / opcionais | 6.1 SDK-out (router Express próprio), 6.2 clear-cache seletivo, 6.3 análise `davail`, 6.4 risco aceito do decode, 6.5/6.5b healthcheck quádruplo do Caddy, 6.6 janela do smoke, 6.7 checkJs medido, 6.8 export duplicado | M4 (6.1/6.2 dependiam do 5.5) | DONE (2026-08-24), exceto 6.3 com janela aberta: baseline 0 registrada (878 servidos vs 736 de rede = 54,4% de bypass local; gate antigo `repeated/hashes` em 20,9%), decisão de TTL (`DEBRID_AVAIL_POS_TTL`/`DEBRID_AVAIL_NEG_TTL`) após amostra de 7 dias — janela ainda em curso no sync de 2026-08-31: baseline aberta 2026-08-24 22:58, vence 2026-08-31 22:58; decidir antes disso é decidir sem dado. 6.7 documentada como "medido, não feito" (354 erros, 306 de `noImplicitAny` — tarefa própria, não ajuste de config) |
| M6 | Catraca de linhas & extração dos HTML do painel | §5.8 (teto de 400 linhas com baseline em `.line-budget.json`, núcleos compartilhados dos 5 perfis de resolver) e §5.9 (CSS/JS dos painéis em arquivos próprios) | M5 | DONE (2026-08-29) — `configure.html` 1.771→1.056 e `dashboard.html` 2.429→1.556, com 6 assets servidos por allowlist fechada; o JS ancorado pelos testes ficou inline por contrato. O scanner da catraca passou a varrer `.css` e o `configure.css` (505) entrou no baseline como débito registrado. Guarda-corpo: os testes de painel passaram **sem alteração**. A validação ao vivo achou 2 defeitos **pré-existentes** que a extração tornou visíveis (`displayValue` tratava "at" como substring — `hitRate` virava 31/12/1969 — e `uptimeS` em segundos ia para um formatador de milissegundos), corrigidos com teste de regressão que **executa** o módulo extraído |

---

## Interface Contracts
### `src/debrid/file-selector.ts` ↔ `src/debrid/common.ts`
- `pickFile(files, hash, opts)`: Selects canonical video file from torrent file list, handling multi-work collections, season/episode filters, audio flags.
- `pickWorkFile(files, work)`: Selects video matching target work title from collection.
- `WorkPickError`, `EpisodePickError`, `NoVideoError`, `DubLieError`: Strong error classes with type guards (`isWorkPickError`, etc.).

### `src/utils/format.ts` Barrel Re-export Contract
- Maintains 100% backward-compatible named exports for all 58 exported functions/constants across `title-normalization`, `release-matching`, `episode-matching`, `audio-quality`, `stream-ranking`, `stream-quotas`, `search-names`.

### `src/providers/index.ts` Facade Contract
- Re-exports `findStreams`, `applyDebrid`, `buildStreams`, `debridRefreshSatisfied`, `applyNoticeOrigin`, `onlyNotice`, `autofetchStatus`, `idxPoolCovered`, `poolCovered`.

### Express Async Route Contract
- `asyncRoute(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>)`: Catches unhandled rejections, logs error, returns HTTP 500 response, preventing process crash.
