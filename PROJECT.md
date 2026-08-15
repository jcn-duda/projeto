# Project: Stremio Adom Power-Movie Resilience & Performance Enhancement

## Architecture
- **Orquestração Principal**: Stremio Addon SDK rodando em Express (`src/addon.js`), com configuração dinâmica stateless por URL via `AsyncLocalStorage` (`src/runtime.js`).
- **Coleta e Fan-out de Provedores**: `src/providers/index.js` gerencia o pipeline `doSearch` / `collectRaw` / `buildStreams`, dividindo consultas globais (Jackett/Prowlarr) e brasileiras (Jackett PT-BR + Scraper BLUDV nativo), com orçamento estrito de deadline (`REPLY_DEADLINE_MS = 9200ms`, `DEBRID_RESERVE_MS = 2800ms`) e passe tardio assíncrono para fontes lentas (`createLatestWriter`).
- **Microserviços de Resolução Local**: Quatro servidores HTTP embutidos (`bludv-resolver:8700`, `comandotorrents-resolver:8701`, `nerdfilmes-resolver:8702`, `torrentdosfilmes-resolver:8703`) supervisionados por `src/br-resolvers.js` em loopback `127.0.0.1`.
- **Camada de Debrid**: Registry unificado (`src/debrid/index.js`) com 5 adaptadores (Premiumize, Real-Debrid, AllDebrid, TorBox, Debrid-Link), checagem em lote paralela, fallback dinâmico sob deadline, autofetch de dublados BR (`src/providers/autofetch.js`) e proteção contra `dropUncached` via `src/debrid/protected.js`.
- **Camada de Cache**: L1 em memória (Map bounded a 2000 entradas com LRU) + L2 persistido em SQLite via `node:sqlite` (`DatabaseSync` em WAL mode) com fallback gracioso para memória.
- **Processamento de Título e Filtragem**: `src/utils/format.js` provê normalização, deduplicação por hash, cálculo estrito de compatibilidade de títulos BR (`matchesBrTitle`), reserva de cotas brasileiras (`limitReservingBr`) e ordenação por qualidade.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Dynamic Domain Validation | Substituir validação de hostname hardcoded (`xnerdfilmes.net`, `torrentdosfilmes-v2.xyz`) por verificação dinâmica contra `SITE_URL` e `ALLOWED_SUFFIXES` | M1 | Survey Explorer 1 |
| 2 | In-Memory Caching & Dedupe in BLUDV Resolver | Implementar cache de post HTML e deduplicação de requisições concorrentes (`postCache` e `inFlight`) no `bludv-resolver` | M1 | Survey Explorer 1 |
| 3 | Standardized `siteEnv` Configuration | Padronizar matriz `RESOLVERS` em `src/br-resolvers.js` com isolamento de `siteEnv` para todos os 4 resolvers (`BLUDV_URL`, `COMANDOTORRENTS_URL`, etc.) | M1 | Survey Explorer 1 |
| 4 | Enhanced Protector & JavaScript Extraction | Fortalecer extração de links e magnets em todos os resolvers contra protetores com JavaScript (`DEST_URL`, `DOWNLOAD_URL`) e permitir `EXTRA_ALLOWED_PROTECTORS` | M1 | Survey Explorer 1 |
| 5 | Title Matching & Deduplication Verification | Assegurar que nenhuma alteração nos resolvers comprometa o strict title matching (`matchesBrTitle`) ou introduza falsos positivos | M1 | Survey Explorer 1 |
| 6 | Cache Statement Pre-Compilation | Pré-compilar statements de `DatabaseSync` (`insertStmt`, `deleteStmt`, `pruneStmt`) em `src/utils/cache.js` para eliminar overhead de compilação SQL por operação | M2 | Survey Explorer 2 |
| 7 | Resilient Deserialization in Cache Load | Proteger `JSON.parse` por linha em `loadFromDisk()` para tolerar registros SQLite corrompidos sem abortar a recuperação do cache | M2 | Survey Explorer 2 |
| 8 | Search & Late-Pass Budget Optimization | Validar e otimizar a coordenação de janelas de coleta (`collectWithinWindow`), coalescing e atualização tardia de cache sem overruns de deadline | M2 | Survey Explorer 2 |
| 9 | Prowlarr Provider Resilience & Unit Testing | Criar testes unitários para `src/providers/prowlarr.js` com mock de fetch para garantir tratamento defensivo de falhas de rede e payloads inválidos | M3 | Survey Explorer 3 |
| 10 | Debrid Adapter Mock & Error Coverage | Adicionar cobertura de teste com mocks para chamadas `resolveLink` e `enqueue` nos adaptadores Debrid (RD, TB, DL, PM) | M3 | Survey Explorer 3 |
| 11 | Torznab XML CDATA Resilience | Fortalecer o parser XML em `src/providers/jackett-catalog.js` para decodificar e limpar seções CDATA sem deixar resquícios | M3 | Survey Explorer 3 |
| 12 | Architecture & Invariants Preservation | Assegurar conformidade contínua com os 6 invariantes de `AGENTS.md`, CommonJS puro e topologia Docker loopback | M3 | Survey Explorer 3 |
| 13 | E2E Testing Suite (Tiers 1-4) | Suíte de testes ponta a ponta opaque-box cobrindo todas as funcionalidades de busca, resolução, debrid e fallbacks | E2E Track | Requirements |
| 14 | Final E2E Pass & Adversarial Hardening (Tier 5) | Validação 100% da suíte E2E e geração de testes adversariais para caminhos não cobertos | Final M | Requirements |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| E2E | E2E Testing Track | Design e criação da suíte E2E independente (Tiers 1-4) e publicação de TEST_READY.md | none | DONE |
| 1 | M1: Resiliência dos Resolvers e Scrapers BR | Features 1, 2, 3, 4, 5: Domínios dinâmicos, cache no BLUDV, siteEnv, extração de protetores JS e testes | none | DONE |
| 2 | M2: Performance de Cache e Passe Tardio | Features 6, 7, 8: Statements pré-compilados SQLite, loadFromDisk resiliente, orquestração de deadline | M1 | DONE |
| 3 | M3: Concorrência de Provedores e Debrid | Features 9, 10, 11, 12: Testes Prowlarr, mocks Debrid, CDATA Torznab, conformidade com invariantes | M2 | DONE |
| 4 | Final Milestone: Validação E2E e Hardening | Feature 14: Execução 100% da suíte E2E (Tiers 1-4) + Fase 2: Hardening Adversarial (Tier 5) | E2E, M3 | DONE |

## Interface Contracts
### `src/br-resolvers.js` ↔ Microserviços Resolvers (`8700..8703`)
- **Protocolo**: HTTP REST interno em `127.0.0.1:870x`.
- **Endpoints**:
  - `GET /search?q=:query` → retorna HTML sintético com links `<a href="...">` e texto com título e tamanho.
  - `GET /resolve?url=:encodedUrl` ou `POST /resolve` → retorna texto puro com a URL magnet resolvida (`magnet:?...`).
  - `GET /dl?url=:encodedUrl` → redireciona 302 com header `Location: magnet:?...`.
  - `GET /api?t=caps` e `GET /api?t=search` → XML Torznab padronizado.
- **Tratamento de Erros**: Qualquer falha de rede, timeout ou domínio inválido deve retornar status 502/504 ou texto vazio sem derrubar o processo Node.

### `src/providers/index.js` ↔ `src/utils/cache.js`
- **Assinaturas**:
  - `cache.get(key: string): any | null`
  - `cache.set(key: string, value: any, ttlSeconds: number): void`
  - `cache.forget(key: string): void`
  - `cache.forgetMany(keys: string[]): void`
- **Garantias**: Operações L1 síncronas e instantâneas; persistência SQLite assíncrona/WAL sem bloqueio; degradação silenciosa para L1 se SQLite indisponível.

### `src/providers/index.js` ↔ Provedores (`jackett.js`, `prowlarr.js`, `bludv.js`)
- **Assinaturas**:
  - `provider.search(name: string, type: string, id: string, queryOpts: object, signal?: AbortSignal): Promise<RawStream[]>`
- **Garantias**: Retornam array de `RawStream` (`{ title, magnet, infoHash, seeders, size, tracker, isBr, downloadUrl }`), nunca lançam exceções não tratadas.

## Code Layout
- `src/addon.js` — Servidor Express, manifest, rotas de stream e resolve
- `src/config.js` — Configuração estática do operador (.env)
- `src/runtime.js` — Configuração dinâmica por usuário (AsyncLocalStorage, URL schema)
- `src/br-resolvers.js` — Supervisor dos 4 microserviços de resolução BR
- `bludv-resolver/server.js` — Microserviço BLUDV (porta 8700)
- `comandotorrents-resolver/server.js` — Microserviço ComandoTorrents (porta 8701)
- `nerdfilmes-resolver/server.js` — Microserviço NerdFilmes (porta 8702)
- `torrentdosfilmes-resolver/server.js` — Microserviço TorrentDosFilmes (porta 8703)
- `src/providers/index.js` — Orquestrador de busca, deadline e passe tardio
- `src/providers/jackett.js` — Provedor Torznab Jackett e resolução Cardigann
- `src/providers/jackett-catalog.js` — Catálogo Torznab de indexadores Jackett
- `src/providers/prowlarr.js` — Provedor alternativo Prowlarr
- `src/providers/bludv.js` — Scraper nativo BLUDV
- `src/debrid/index.js` — Registry de adaptadores Debrid
- `src/debrid/common.js` — Utilitários de debrid e checagem em lote
- `src/debrid/protected.js` — Gerenciador de hashes protegidos de dropUncached
- `src/debrid/*.js` — Adaptadores individuais de debrid
- `src/utils/cache.js` — Gerenciador de cache L1 (Map) e L2 (node:sqlite)
- `src/utils/format.js` — Normalização de títulos, matchesBrTitle, cotas e ordenação
- `test/` — Suíte de testes unitários nativa (node:test)
- `jackett-bludv/*.yml` — Definições Cardigann para os indexadores BR
