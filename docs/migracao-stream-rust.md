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

### F-1.2 — regras do finish, do late e do cache

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
| `instant_window` | `src/providers/magnet-bank-instant.ts` (janela da via instantânea) | puro sobre `now` |
| `pick_source` | `src/providers/magnet-bank-fallback.ts:116` | reserva do banco; `allFailed` × `failedIndexers` |
| `is_recent_release` | `src/providers/magnet-bank-instant.ts:123` | `now` injetável |
| `play_disposition` | `src/providers/debrid-play-guard.ts:25` | `resolve \| p2p \| drop`; pack multiobra admitido **nunca** vira P2P inteiro |
| `limit_reserving_br` | já portado (`stream_quotas_extra`) | só cabe trocar o chamador TS |
| `filter_known_cache` | já portado (`br_pool_selection::picks`) | idem |
| `stream_display`, `stream_relabel`, `catalog_classify` | já portados | idem |

Ao fim de F-1 o Node não decide mais nada da busca: fica rede, estado e tempo.

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
   (invariante 5). Saem em lote por etapa, nunca por item.
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
