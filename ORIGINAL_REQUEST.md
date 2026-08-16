# Original User Request

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
