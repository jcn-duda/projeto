# Migração da orquestração de `/stream` para Rust — mapa das fatias

Plano de execução do *strangler* descrito no pedido original. Cada fatia é um
commit, o branch fica funcional em cada um, e a régua de aceite é sempre a
mesma: `cargo test` + `cargo fmt --check` + `cargo clippy` verdes, `npm run
typecheck` em zero, suíte Node verde e `npm run lint:lines` sem regressão.

Este documento é o **mapa**, não a regra: em conflito com o código, o código
vence. `AGENTS.md` continua sendo a fonte dos invariantes.

## Régua de aceite comum

| Gate | Comando | Critério |
|---|---|---|
| Núcleo | `cargo test -p adom-core` | todos os goldens, incluindo os novos |
| Ponte | `cargo test -p adom-napi` | bindings carregam e não panicam |
| Estilo | `cargo fmt --check`, `cargo clippy --all-targets` | sem aviso novo |
| Tipos | `npm run typecheck` | zero |
| Suíte | `npm test` | verde |
| Tamanho | `npm run lint:lines` | nenhum arquivo novo > 400 linhas |
| Paridade | golden contra o TS do worktree `esm` | byte a byte (objetos por `Value`) |

Goldens cujo corpo TS já saiu deste branch se conferem **contra o `esm`**, nunca
contra o shim local: `npm run golden:<x>:check` roda dentro de `../adom-esm`
(`scripts/golden/run-esm-golden.mjs`). Gerar é sempre
`cd ../adom-esm && node scripts/golden/dump-<x>.mjs --force`, e os dois
artefatos (`.jsonl` + `.manifest.json`) vêm para `rust/golden/` deste branch.

---

## F-1 — Decisões puras da orquestração (o TS só orquestra)

### F-1.1 (em execução nesta rodada)

| Módulo Rust | Fonte TS | Conteúdo |
|---|---|---|
| `search_plan.rs` | `src/providers/search-plan.ts` | `plan_jackett_queries`, `live_indexers`, `pt_sweep_indexers`, `pt_sweep_query`, `pt_sweep_query_for`, `dubbed_sweep_query_for` |
| `collection_budget.rs` | `src/providers/collection-budget.ts` | `compute_collection_budget`, `compute_priority_grace` |
| `search_pool_coverage.rs` | `src/providers/search-pool-coverage.ts` | `pool_covered`, `idx_pool_covered` |

### F-1.2 — regras do finish, do late e do cache (ligadas na ponte)

| Alvo | Onde está hoje | O que vira função pura |
|---|---|---|
| TTL do commit | `src/providers/search-orchestrator.ts:164-199` | entrada `{streams_tocáveis, partial, debrid_known, needs_refresh, has_fallback, cache_ttl, fallback_ttl}` → `{grava: bool, ttl, partial}` |
| Promoção tardia | `src/providers/search-late-promoter.ts:16-57` | `{grew, partial, phase_eq, hit_partial, hit_fallback, hit_streams_vazio, live_needs_fallback, live_any_failure}` → `Reconstruir \| Promover \| Esquecer \| Nada` |
| Elegibilidade do SWR | `src/providers/search-cache.ts:200-207` | `debrid_refresh_satisfied`, `stale_refresh_eligible` (reusa `autofetch_policy::has_playable_stream`) |

Cuidados que o golden precisa exercitar: lista com reserva (`fallback`) nunca é
completa; TTL de reserva respeita `min(CACHE_TTL, FALLBACK_STREAMS_TTL)` e
`<= 0` não grava; lista vazia com indexer falho continua `partial`; `debridKnown`
é copiado na promoção (não refaz checagem); `trace` sobrevive à promoção.

### F-1.3 — via do banco, guarda de play e lista final

| Alvo | Onde está hoje | Observação |
|---|---|---|
| `instant_window` | `src/providers/magnet-bank-instant.ts:139` | **feito e ligado**: `adom-core::search_bank`, golden de 27 casos, napi `instantWindow`. O TS lê `config.magnetBank.*` DENTRO da casca e passa os números; o núcleo clampa. O golden prende o comportamento sob os defaults (min=max=7d, freshMax=2h) |
| `pick_source` | `src/providers/magnet-bank-fallback.ts:116` | **feito e ligado**: golden de 12 casos, napi `pickSource` (devolve o ÍNDICE); pegou que o conjunto `failed` do TS NÃO é normalizado (só o `source.indexer` é) |
| `is_recent_release` | `src/providers/magnet-bank-instant.ts:123` | **feito e ligado**: sobe com o `instant_window`, sobre o subconjunto UTC de `Date.parse`, napi `isRecentRelease` |
| `play_disposition` | `src/providers/debrid-play-guard.ts:25` | **feito e ligado**: `adom-core::play_disposition`, golden de 18 casos, napi `playDispositions` em LOTE no laço principal; o `materialize` do ramo degradado segue na avulsa (lote de 1) |
| `limit_reserving_br` | já portado (`stream_quotas_extra`) | **feito e ligado**: napi `limitReservingBr` devolve `{selected, eligible, replaced, dropped}`; o porte congelou também o ledger (`quality-quota`/`indexer-limit`/`br-guarantee-replaced`) e a casca escreve o `max-results` |
| `filter_known_cache` | já portado (`br_pool_selection::picks`) | **feito e ligado**: napi `filterKnownCache` devolve `{kept, visibleBr, dropped}`; a casca escreve o `dropTrace` |
| `catalog_classify` | já portado | **feito e ligado**: napi `catalogClassify` (as listas `ptMarkers`/`enGroups` entram por parâmetro) |
| `stream_display`, `stream_relabel` | já portados | **continuam no TS até o F1**: devolvem `JsText` e a travessia napi é UTF-8 (surrogate órfão viraria U+FFFD). O orquestrador in-process consome o porte sem essa perda |

**Decisão de `Date.parse`** (em `adom-core::search_bank`): o porte aceita o
subconjunto determinístico — `YYYY`, `YYYY-MM`, `YYYY-MM-DD` (UTC) e
`YYYY-MM-DDTHH:MM[:SS[.fff]]` COM offset (`Z`/`±HH:MM`/`±HHMM`). Formato fora
disso, datetime sem offset (que no JS é interpretado no FUSO do processo) e dia
impossível viram `0` (o `NaN` do TS). Cinemeta/TMDB mandam ISO com `Z`; quem
precisar de mais formatos regenera o golden com o corpus novo.

**F-1 ligada na ponte (exceto display/relabel).** `search-commit`,
`play-disposition`, `magnet-bank`, `limitReservingBr`, `filterKnownCache` e
`catalogClassify` têm napi + casca TS; as decisões rodam no núcleo e a travessia
acontece onde a função já era chamada (o play usa lote). `display`/`relabel`
ficam de fora de propósito até o F1: o `String` do napi-rs é UTF-8 e não carrega
unidade surrogate órfã — o `JsText` do núcleo preserva, a fronteira não. O F1 os
consome in-process.

O Node fica com rede, estado, tempo e o trace (I/O); a decisão da busca está no
núcleo. O `.jsonl` continua sendo o mesmo dos dois lados: o oráculo dos goldens
novos é o TS do worktree `../adom-esm`.

---

## F0 — Contrato e medição em sombra

1. **Contrato fixado** em `docs/rust-stream-contract.md`: corpo Stremio, aviso de
   lista vazia, `applyNoticeOrigin` (URL relativa no cache, host só na resposta),
   HMAC do `/resolve` (infoHash + S/E + `w` + `p:1`), `cacheMaxAge` (0 quando a
   lista precisa revalidar; teto 60 s), estado parcial, erros e a identidade da
   requisição (`streams:v21`, config+conta, nunca host).
2. **Corpus de ponta a ponta** capturado com
   `scripts/golden/capture-stream-e2e.mjs` em `rust/golden/stream-e2e/`.
3. **Sombra** (`ROUTES_RUST=stream-shadow`): o Node responde, o Rust remonta com
   as mesmas entradas e só a métrica `stream.shadow.divergence` é pública. Corte
   por rota só com divergência zero sobre tráfego real.

## F1 — Orquestrador Rust com a rede ainda no Node

1. **Rotas internas** (feito o primeiro par: `meta` e `state`):
   `POST /internal/search/meta`, `POST /internal/search/state`, e ainda
   `collect`, `debrid/check`, `index/write`, `effects`. Todas em loopback +
   `X-Indexer-Test-Token`, com o `encoded` no corpo para o `runtime.run` do Node
   (invariante 5). Saem em lote por etapa, nunca por item. O gateway Rust
   (`GATEWAY=on`) **recusa `/internal/*` antes do proxy** (o Caddy também
   bloqueia): a guarda de loopback do Node não vê o cliente real atrás do proxy,
   então a fachada é quem fecha a porta.
2. **`adom-search`**: decode da config, chave de cache, prazo por requisição
   (`Dart/` = app, senão Stremio), SWR e `inFlight`, plano e janela de coleta,
   build no núcleo, `applyDebrid` pelos adaptadores no processo, latest-writer e
   late promoter, fila tardia serial, corte externo com `partial:true` e busca
   em `tokio::spawn`, via do índice e via instantânea, trace gravado junto.
3. **Paridade** com o golden da F0 e sombra sem divergência.
4. **Corte** `ROUTES_RUST=stream` local; o Node vira reserva.

## F2 — Fontes e metadados em Rust (uma por commit, cada uma com sombra)

Jackett (Torznab/JSON, globais agrupados, BR isolados em pt-BR — invariante 4,
breaker só em `offline`) → Prowlarr → Torrentio (fail-open, breaker local) →
BLUDV/Mico (reusar `adom-resolvers`/`mico_net`) → inventário da conta →
Cinemeta/TMDB (`/find` duplo no mesmo prazo, travas do `tmdb_br_aliases`) →
completar no `adom-debrid` o que hoje é 501 (`check` de RD/TorBox/AllDebrid,
`files`, `account`). Cada fonte migrada sai da rota `collect`.

## F3 — Estado em Rust

`raw:v1`, `idx:v14`, banco VIVO (`magnets.db`) e `davail` num store Rust no
padrão de `adom-debrid/src/store.rs`, com importação única do `cache.db`. Painel
e `/stream-trace.json`/`/dashboard-status.json` passam a ler do Rust por rota
interna.

## F4 — Corte final

`ROUTES_RUST=stream` vira padrão; saem `search-orchestrator`, `search-cache`,
`stream-builder*`, `debrid-pipeline*` e as rotas internas de coleta. O Node fica
com configure, painel, `/resolve` (até ser portado) e config.

---

## Ordem prática de trabalho

O que trava o quê:

- F-1.2/F-1.3 não dependem de F0 nem de F1 — são a mesma receita barata
  (módulo puro + golden + napi + casca TS) e podem andar em paralelo com F0/F1.1.
- A sombra da F0 **só é honesta depois** que o orquestrador da F1.2 existir: sem
  ele não há "remontar a resposta", só um proxy que finge comparar.
- O corte por rota (`ROUTES_RUST=stream`) depende de F1.3 (paridade + sombra).
- F2 só começa quando a rota `collect` da F1.1 estiver estável: migrar fonte com
  a rota ainda mudando joga trabalho fora.

## Verificação de ponta (por corte, não por fatia)

1. `cargo test`, clippy, fmt na raiz de `rust/`.
2. `npm run typecheck`, `npm test`, `npm run lint:lines`.
3. Prazo: `test/search-budget-metadata.test.ts` portado para o Rust; medir p50 e
   p95 do `/stream` com Stremio (10 s) e com o app Power Movie (15 s) antes e
   depois.
4. Docker: `docker compose up -d --build --force-recreate adom` com `GATEWAY=on`
   e `ROUTES_RUST=stream`, depois `clear-cache`. Checar painel, manifest e
   configure 200, e `/stream` de série, filme, pack e BR dublado — com o Node
   desligado **e** ligado.
5. Play: `/resolve` de um item de cada debrid pela lista gerada no Rust (o HMAC
   tem que valer).
