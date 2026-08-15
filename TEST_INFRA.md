# TEST_INFRA.md — Stremio Adom Power-Movie E2E Testing Infrastructure

Este documento define a arquitetura, metodologia e contratos da suíte de testes de ponta a ponta (E2E) do **Stremio Adom Power-Movie**.

---

## 1. Filosofia e Metodologia de Teste

A suíte E2E foi concebida sob quatro princípios fundamentais:

1. **Opaque-Box (Caixa Opaca)**:
   - Os testes exercitam a aplicação através de suas interfaces públicas e contratos oficiais (rotas HTTP do Express, handlers do Stremio Addon SDK, rotas de resolução debrid, decodificação de URLs e contratos entre módulos).
   - Não há monkey patching invasivo de métodos de negócio nem asserções acopladas a detalhes internos não contratuais.
2. **Dependência de Rede Zero (Zero External Network Dependency)**:
   - Nenhum teste realiza chamadas externas à internet (Cinemeta, TMDB, Jackett externo, Real-Debrid, Premiumize, etc.).
   - Toda comunicação de rede é interceptada deterministicamente por servidores locais efêmeros ou roteadores de mock HTTP nativos (`globalThis.fetch`), garantindo testes rápidos, reproduzíveis e imunes a flutuações de rede ou indisponibilidade de serviços terceiros.
3. **Zero Novas Dependências npm**:
   - Todo o arcabouço de testes é construído exclusivamente com ferramentas nativas do Node.js (`node:test`, `node:assert/strict`, `node:http`, `node:crypto`) e as dependências estritas do projeto (`express`, `stremio-addon-sdk`, `dotenv`).
4. **Alinhamento Rigoroso com os Invariantes de `AGENTS.md` e `PROJECT.md`**:
   - Verificação contínua dos 6 invariantes fundamentais (orçamento de tempo sagrado, origem BR como campo, proteção a fontes BR com 1 seeder, consultas duplas em pt-BR/EN, filtro de título estrito em duas camadas e proteção do autofetch contra `dropUncached`).

---

## 2. Arquitetura do Test Harness (`test/e2e/e2e-harness.js`)

O arquivo `test/e2e/e2e-harness.js` fornece a infraestrutura compartilhada para os testes E2E:

```
┌──────────────────────────────────────────────────────────┐
│                   e2e-harness.js                         │
├────────────────────────────┬─────────────────────────────┤
│   HTTP & Server Lifecycle  │   Mock Fetch & Services     │
│  - createTestApp()         │  - withMockFetch()          │
│  - createTestServer()      │  - createMockFetch()        │
│  - request() helper        │  - Cinemeta / TMDB Mocks    │
│                            │  - Jackett Torznab XML Mock │
├────────────────────────────┼─────────────────────────────┤
│   Config & Cryptography    │   Debrid & Resolver Mocks   │
│  - encodeConfig()          │  - PM / RD / AD / TB / DL   │
│  - decodeConfig()          │  - BR Resolvers (8700-8703) │
│  - signResolve()           │  - Fixtures & Generators    │
└────────────────────────────┴─────────────────────────────┘
```

### 2.1 Componentes Principais

1. **`createTestApp({ configOverrides })`**:
   - Instancia uma aplicação Express com o middleware de roteamento do Adom, montando os handlers do Stremio Addon SDK (`/manifest.json`, `/stream/:type/:id.json`), rotas de resolução (`/resolve/:infoHash`), páginas de configuração (`/configure`, `/defaults.json`), diagnóstico (`/metrics.json`, `/test-indexer.json`) e selagem criptográfica (`/seal-config`).
2. **`createTestServer(app)`**:
   - Inicializa um servidor HTTP nativo em porta efêmera aleatória (`port 0`), provendo uma URL base isolada (`http://127.0.0.1:<port>`), métodos de requisição HTTP assíncronos (`request(method, path, options)`) e encerramento limpo (`close()`).
3. **`withMockFetch(handlers, fn)`**:
   - Executa uma função de teste assíncrona sob um contexto controlado de `fetch`, restaurando o `globalThis.fetch` original ao término (mesmo em caso de falha ou exceção) e limpando os caches L1/L2.
4. **Mock HTTP Services**:
   - **Cinemeta**: Responde metadados de filmes (`/meta/movie/:id.json`) e séries (`/meta/series/:id.json`).
   - **TMDB**: Fornece títulos localizados em português brasileiro (`/find/:id?external_source=imdb_id`).
   - **Jackett / Torznab**: Gera feeds XML padrão Torznab com suporte a seções CDATA, categorias de filmes/séries, tamanhos e sementes.
   - **Prowlarr**: Fornece endpoints de busca JSON (`/api/v1/search`).
   - **Debrid APIs**: Simula endpoints de disponibilidade de cache em lote, adição de torrents e resolução de links diretos para Premiumize, Real-Debrid, AllDebrid, TorBox e Debrid-Link.
   - **BR Resolvers (Portas 8700..8703)**: Emula os microserviços BLUDV, ComandoTorrents, NerdFilmes e TorrentDosFilmes (`/search`, `/resolve`, `/dl`, `/api`).

---

## 3. Mapeamento de Funcionalidades (Feature Inventory)

Mapeamento das 14 funcionalidades de `PROJECT.md` para a infraestrutura de testes:

| # | Funcionalidade | Módulos Impactados | Estratégia de Teste E2E |
|---|---|---|---|
| 1 | Dynamic Domain Validation | `*-resolver/server.js` | Testes com domínios dinâmicos, allowlists, fallback suffixes e rejeição de domínios estranhos |
| 2 | In-Memory Caching & Dedupe in BLUDV Resolver | `bludv-resolver/server.js` | Testes de cache de posts HTML, deduplicação em voo (`inFlight`), TTL e limites de tamanho |
| 3 | Standardized `siteEnv` Configuration | `src/br-resolvers.js` | Verificação do carregamento das variáveis `BLUDV_URL`, `COMANDOTORRENTS_URL`, `NERDFILMES_URL`, etc. |
| 4 | Enhanced Protector & JavaScript Extraction | `*-resolver/server.js` | Testes de extração de magnet direto, `DEST_URL`, `window.location` e saltos de redirecionamento |
| 5 | Title Matching & Deduplication Verification | `src/utils/format.js` | Validação de `matchesBrTitle`, tolerância de ano, preservação de `_br`/`_dubbed` no `dedupeByHash` |
| 6 | Cache Statement Pre-Compilation | `src/utils/cache.js` | Testes de persistência SQLite com statements pré-compilados, `forgetMany` e `prune` |
| 7 | Resilient Deserialization in Cache Load | `src/utils/cache.js` | Teste de recuperação tolerante a falhas no `loadFromDisk` com dados corrompidos |
| 8 | Search & Late-Pass Budget Optimization | `src/providers/index.js` | Testes de janelas de coleta, coalescing de buscas simultâneas e escrita tardia de cache |
| 9 | Prowlarr Provider Resilience & Unit Testing | `src/providers/prowlarr.js` | Teste defensivo de chamadas à API Torznab JSON do Prowlarr com mock de rede |
| 10 | Debrid Adapter Mock & Error Coverage | `src/debrid/*.js` | Testes com mocks para checagem em lote, `resolveLink`, `enqueue` e fallbacks em todos os 5 adaptadores |
| 11 | Torznab XML CDATA Resilience | `src/providers/jackett-catalog.js` | Testes de decodificação e limpeza de blocos `<![CDATA[...]]>` no catálogo Torznab |
| 12 | Architecture & Invariants Preservation | Toda a stack | Testes formais dos 6 invariantes de `AGENTS.md` (orçamentos, reserva BR, queries duplas, etc.) |
| 13 | E2E Testing Suite (Tiers 1-4) | `src/addon.js` | Testes ponta a ponta das rotas HTTP `/manifest.json`, `/stream/...`, `/resolve/...`, `/configure` |
| 14 | Final E2E Pass & Adversarial Hardening (Tier 5) | Toda a stack | Testes de segurança adversariais: adulteração de HMAC, configs maliciosas, ataques de payload |

---

## 4. Metodologia de Cobertura em 4 Camadas (4-Tier)

A suíte completa é estruturada em 4 camadas progressivas de teste:

```
┌─────────────────────────────────────────────────────────────┐
│  Tier 4: Failure Modes & Resilient Graceful Degradation     │  <- Falhas de rede, timeouts, DB corrompido
├─────────────────────────────────────────────────────────────┤
│  Tier 3: Concurrency, Rate-Limiting & Stress Scenarios      │  <- Coalescing, gates de diagnóstico, carga
├─────────────────────────────────────────────────────────────┤
│  Tier 2: Boundary & Corner Cases (Parameter Extremes)       │  <- Limites 8192b, clamping 0..100, sanitização
├─────────────────────────────────────────────────────────────┤
│  Tier 1: Feature Coverage (Opaque-Box Functional Contracts) │  <- 14 Features x >= 5 testes (>= 70 casos)
└─────────────────────────────────────────────────────────────┘
```

### Tier 1: Feature Coverage
- Validação funcional estrita dos contratos de cada uma das 14 features de `PROJECT.md`.
- No mínimo 5 casos de teste completos e independentes por feature (totalizando no mínimo 70 testes).

### Tier 2: Boundary & Corner Cases
- Testes nos limites extremos do sistema:
  - Tamanho máximo do segmento de URL (`8192` chars vs `8193` chars).
  - Clamping de valores inteiros (cotas de qualidade `0..100`, tamanho `0..200GB`, slots BR `0..40`).
  - Formatações exóticas de títulos e episódios (hífens, numerais romanos, múltiplos anos).

### Tier 3: Concurrency & Stress Scenarios
- Testes de alta concorrência:
  - Coalescência de requisições (`inFlight`) sob dezenas de clientes simultâneos.
  - Saturação de portas de admissão (`diagnosticGate`, `sealGate`).
  - Isolamento perfeito de contexto em `AsyncLocalStorage` entre requisições paralelas.

### Tier 4: Failure Mode & Graceful Degradation
- Testes de resiliência e degradação suave:
  - Comportamento sob queda de indexadores Torznab (500, 502, 504, timeout).
  - Degradação de debrid quando o orçamento de tempo expira (entrega de resolve links com `known: false`).
  - Fallback gracioso de cache SQLite para memória pura quando o banco está bloqueado ou indisponível.

---

## 5. Como Executar os Testes

Para rodar a suíte E2E Tier 1:

```bash
node --test test/e2e/tier1-feature-coverage.test.js
```

Para rodar toda a suíte de testes (unitários + E2E):

```bash
npm test
```

O gate também confirma que todo arquivo `*.test.js` sob `test/` está listado
explicitamente no script, inclusive os tiers E2E:

```bash
npm run test:complete
```

Os challengers de hardening não entram no CI principal. O primeiro é seguro
para rodar localmente; o segundo altera arquivos temporariamente e deve rodar
somente em um working tree limpo:

```bash
npm run test:stress
npm run test:adversarial
```
