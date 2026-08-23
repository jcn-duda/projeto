# Original User Request

> **Documento histórico.** Registra a solicitação original (ago/2026). As
> premissas "CommonJS sem build", `node --check` e os caminhos `.js` não
> representam o projeto atual — TypeScript/ESM com build (`tsc` → `dist/`) e
> `npm run typecheck` como portão. Consulte `AGENTS.md` para o estado vigente.

## 2026-08-15T03:14:16Z

Executar análise arquitetural aprofundada, auditoria de código e implementação de melhorias de resiliência e performance no addon Stremio Adom Power-Movie.

Working directory: E:/stremio adom
Integrity mode: development

## Requirements

### R1. Resiliência e Confiabilidade dos Resolvers e Scrapers BR
- Auditar e fortalecer os microserviços de resolução (`bludv-resolver`, `comandotorrents-resolver`, `nerdfilmes-resolver`, `torrentdosfilmes-resolver`) e scrapers nativos contra falhas de rede, mudanças de URLs/layouts WordPress e protetores de link.
- Garantir que qualquer falha, lentidão ou bloqueio em uma fonte específica nunca derrube a busca global nem atrase os resultados de outras fontes dentro do orçamento de tempo (`REPLY_DEADLINE_MS`).
- Manter strict title matching (`matchesBrTitle`) e deduplicação sem falsos positivos.

### R2. Otimização de Performance, Latência e Gerenciamento de Cache
- Otimizar a camada de cache SQLite / memória (`src/utils/cache.js`) e a orquestração do passe tardio (`doSearch` / `collectRaw`).
- Reduzir contenção e overhead assíncrono no fan-out de consultas a indexadores e chamadas de checagem de cache Debrid (`src/debrid/`).
- Assegurar conformidade absoluta com o orçamento de tempo do Stremio (resposta rápida no primeiro passe e enriquecimento confiável no passe tardio).

### R3. Preservação Arquitetural e Invariantes do Sistema
- Preservar todas as regras de `AGENTS.md`: CommonJS sem build, dependências estritamente mínimas (`express`, `stremio-addon-sdk`, `dotenv`), ambiente Docker unificado em `127.0.0.1`, isolamento dos resolvers locais em portas internas.
- Manter o contrato de configuração por URL stateless via `opts()` (`src/runtime.js`).

## Acceptance Criteria

### Testes e Integridade
- [x] 100% dos testes da suíte nativa (`npm test`) continuam passando sem regressões.
- [x] Checagem de sintaxe limpa (`node --check src/providers/index.js` e em todos os arquivos modificados).
- [x] Nenhuma nova dependência npm desnecessária adicionada ao `package.json`.

### Resiliência & Performance
- [x] Todos os resolvers e provedores tratam erros com `try/catch` defensivos e logs prefixados (`[jackett]`, `[bludv]`, `[debrid]`, etc.).
- [x] Consultas e resoluções respeitam estritamente os timeouts e sinais de cancelamento configurados.
- [x] A persistência SQLite lida de forma graciosa com concorrência ou indisponibilidade do módulo nativo sem quebrar o processo.

## Follow-up — 2026-08-16T05:29:15Z

Surgically enhance the ComandoTorrents Jackett indexer definition and microservice resolver for optimal extraction accuracy, link protector resilience, and rigorous fixture-based test coverage.

Working directory: E:/stremio adom
Integrity mode: development

## Requirements

### R1. Robust HTML Parsing & Metadata Extraction
Refine and harden the parsing logic in `comandotorrents-resolver/server.js` and `jackett-bludv/comandotorrents.yml` to accurately extract:
- Audio streams (distinguishing `dublado`/`dual áudio` vs `legendado`, ensuring section context does not contaminate adjacent buttons).
- Video resolutions (`2160p`/`4K`, `1080p`, `720p`, `SD`) and source codecs (`WEB-DL`, `BluRay`, `REMUX`, etc.).
- Episode numbering (`E01`, `EP 02`) vs full season packs (`TEMPORADA COMPLETA` resetting episode count to `null`).
- Clean release titles stripped of WordPress/SEO fluff (`Torrent`, `Download`, `Grátis`, `Completo`) while strictly preserving original titles and required metadata tags.

### R2. Link Protector & Redirect Resilience
Strengthen the link unrolling and magnet resolution pipeline in `comandotorrents-resolver/server.js`:
- Support diverse protector patterns (direct `magnet:?`, URL-encoded magnets, JavaScript variables like `DEST_URL`/`DOWNLOAD_URL`, meta refresh tags, and multi-hop HTTP 3xx/location hops).
- Maintain strict domain whitelist enforcement (`ALLOWED_SUFFIXES`) and defensive timeouts.

### R3. Comprehensive Test Suite & Regression Proof
Develop extensive unit and regression tests in the test suite (e.g. expanding `test/br-parsers.test.js` or creating dedicated test modules and fixtures):
- Cover edge cases including complex movie posts, multi-season pack listings, episodic series, 4K HDR releases, and multi-hop protector redirects.
- Ensure all existing and new test suites pass with zero regressions.

## Acceptance Criteria

### Parsing Accuracy & Clean Output
- [ ] Correctly identifies audio language across different WordPress post formats without false 'dublado' tags on subtitled releases.
- [ ] Correctly parses single episode numbers and clears episode tracking on season pack buttons.
- [ ] Strips vitrine/SEO noise from release titles and generates clean, standard release names.
- [ ] Size extraction parses standard Brazilian/Portuguese unit notations, safely defaulting to the `1 KB` sentinel when absent.

### Resolver Robustness
- [ ] Resolves multi-hop link protectors and JS redirects to target magnet links within the timeout budget.
- [ ] Gracefully handles unreachable or malformed protector URLs without crashing the resolver service.

### Automated Verification
- [ ] Full test suite (`npm test`) passes with 100% success rate across all existing 340+ tests and new test cases.
- [ ] Fixture-backed test cases explicitly demonstrate and prove improved extraction accuracy on previously ambiguous or fragile post layouts.

## Follow-up — 2026-08-22T22:25:31Z

Execute the full roadmap of corrections, robustness enhancements, safety mechanisms, and architectural refactoring for the self-hosted Stremio Adom addon, following the specifications of PLANO_MELHORIAS.md and AGENTS.md.

Working directory: E:/stremio adom
Integrity mode: development

## Requirements

### R1. Debrid Safety & Lifecycle (AllDebrid B1/B2)
- Implement TTL and refresh logic for pre-existing magnets inventory (`ALLDEBRID_PREEXISTING_TTL_MS`) to protect post-boot user acquisitions.
- Ensure fail-safe closed behavior: if inventory refresh fails, do not drop ready magnets.
- Decouple `dropReady` and `dropDownload` cleanup routines so uncached toggle does not disable ready drops.
- Cover all lifecycle scenarios with comprehensive unit tests (`test/debrid-drop-uncached.test.ts`).

### R2. Runtime Robustness & Network Safety (S1–S5, B4)
- Add top-level `unhandledRejection` handling and Express 4 async route wrappers to avoid process crashes.
- Enforce network safety checks on Torznab download URLs to block local/private IP SSRF by default.
- Gate diagnostic endpoints (`/debrid-status.json`, `/metrics.json`) behind diagnostic rate limiting.
- Require explicit confirmation payloads for destructive dashboard actions (`clear-cache`, `sweep-dead`).
- Address auto-fetch drain backoff (`DEBRID_AUTO_FETCH_DRAIN_BACKOFF_MS`) to prevent busy spinning.

### R3. Core Guardrails & Regression Safety Suite (T1–T7)
- Implement automated tests for magnet year contradiction (`magnetYearContradicts`), episode work identity matching (`matchesEpisodeWorkIdentity`), and Brazilian grace budget formulas.
- Ensure adversarial and empirical e2e test harnesses operate on isolated workspace/snapshots rather than mutating active build artifacts in-place.
- Verify that all test harnesses and files are registered and tracked in `package.json` test completion checks.

### R4. Search Budget Recalibration (B3)
- Deduct metadata retrieval time (Cinemeta/TMDB) from the search deadline dynamically so torrent indexers are given an accurate remaining budget without exceeding total deadline.
- Add regression tests proving partial responses return without tripping timeouts when metadata is slow.

### R5. Modular Architectural Refactoring (A1–A6)
- Incrementally split monolithic modules (`src/providers/index.ts`, `src/utils/format.ts`) into specialized submodules with clean boundaries (e.g., `autofetch-runner.ts`, `debrid-pipeline.ts`, `search-orchestrator.ts`, `stream-builder.ts`, `title-normalization.ts`, `release-matching.ts`).
- Maintain backward-compatible barrel re-exports during transition so all existing tests and imports remain intact.
- Extract common resolver engine logic for Brazilian scrapers while maintaining individual site profiles.
- Progressively reduce unstructured `any` types across boundaries to explicit, strongly-typed interfaces.

## Acceptance Criteria

### Typecheck & Compilation
- [ ] `npm run typecheck` passes with exactly 0 type errors (`strictNullChecks` & `noImplicitAny` enabled).
- [ ] `npm run build` compiles `src/` cleanly into `dist/` with `noEmitOnError: true`.

### Test Suite & Harness Validation
- [ ] `npm test` executes the complete test suite with 100% passes (0 failures across all 1,070+ test cases).
- [ ] `npm run test:complete` confirms every `*.test.ts` file is tracked in `package.json`.
- [ ] Empirical, stress, and adversarial test harnesses (`npm run test:stress`, `npm run test:adversarial`, `npm run test:adversarial-m1`, `npm run test:protector-m1`, `npm run test:challenger-m2`) pass cleanly without corrupting the working tree.

### Functional Invariants
- [ ] Time budget constraints (Invariant 1) are strictly preserved across all search phases.
- [ ] Reserved Brazilian stream slots and dubbing priorities remain intact in final stream generation.
- [ ] Debrid account state integrity is preserved (no accidental deletion of user torrents).
- [ ] Smoke test (`node dist/scripts/smoke.js`) succeeds against real network endpoints where configured.

