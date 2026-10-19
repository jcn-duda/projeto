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

### F-1.1 — decisões puras (entregue)

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

1. **Contrato fixado** em `docs/rust-stream-contract.md` (inclui §0 operacional
   da Fase F): corpo Stremio, aviso de lista vazia, `applyNoticeOrigin` (URL
   relativa no cache, host só na resposta), HMAC do `/resolve` (infoHash + S/E +
   `w` + `p:1`), `cacheMaxAge` (0 quando a lista precisa revalidar; teto 60 s),
   estado parcial, erros e a identidade da requisição (`streams:v21`,
   config+conta, nunca host).
2. **Corpus de ponta a ponta** capturado com
   `scripts/golden/capture-stream-e2e.mjs` em `rust/golden/stream-e2e/`:
   **51 casos** com `request.json` + `response.json` (captura de
   `2026-10-19T01:11:18.652Z`, a mesma do `manifest.json`). O corpus **não**
   traz `meta.json`, `raw.json` nem `debrid.json`; por isso o harness de
   fixtures remonta **0/51** (todos `Skip`) e o replay 51/51 é só Node × Node.
   Captura com fixtures internas e o critério §9.4.5 seguem **pendentes**.
3. **Sombra** (`ROUTES_RUST=stream-shadow`): o Node responde, o Rust remonta com
   store `MemorySwrStore` isolado (nunca `STREAMS_DB`) e só as métricas
   `stream.shadow.*` do contrato §9.2 são públicas. É o **default** do override
   `docker-compose.gateway.yml` (contrato §0).

## F1 — Orquestrador Rust com a rede no Node por padrão

> **Estado no branch `rust`: F1 PARCIAL, sem push; branch ahead.** Nesta rodada
> entraram quatro commits locais: `4b50880f` (enriquecimento das rotas internas
> só com prova de arquivo), `b10df543` (F2.1: Jackett com `live` por indexer e
> sombra de fonte), `03adaa69` (regressão de `%` no matching) e `2729b9db`
> (comentário do `bank_hash`). A via viva por indexer do F1 está entregue
> (`CollectBatch.live`, merge pós-completion e `liveHashes`) e o Jackett nativo
> passou a emitir `live` na F2.1; o play offline aplica `play_disposition`; o
> corte **não** está aceito. Já fecham: `resolveUncached` só com debrid ativo e
> checagem utilizável (`Unusable` força P2P e dropa multiobra); composição
> conservadora quando um coletor não traz `live` (`all=Error`/`unknown` até a
> F2); `from_snapshot` perde o selo quando o hash aparece vivo; `promote_late`
> lê o estado vivo final; e `fallback` sai da lista final, depois do drop do
> `playDisposition`. Faltam o gate externo §9.4 (16/16 e ampliado **com hashes
> reais**), p50/p95 reais, corpus com fixtures internas (0/51), play externo
> por debrid e uma semana em `stream-shadow`; F3/F4 não iniciados. `stream`
> segue **experimental**; `stream-shadow` segue o default do override.

### Entregas anteriores (F-1/F1)

| Commit | Entrega | Limite/evidência |
|---|---|---|
| `79c7521f` | matching numérico: identidade completa no núcleo (`3%`, `24`, `9-1-1`) e regressão Node | portão real **não remedido**; relato de 10/16 com 6 deltas BR/hashes pendente |
| `7c78e0e4` | `ptTitleDual` decidido no núcleo e consumido in-process via `SearchMeta`/`BuildContext`, com wrapper TS fino e NAPI recompilado | 155.890 decisões do oráculo sem divergência (relato do executor) |
| `70a26a40` | apresentação: 👤0 e blob HDR fora do título, com qualidade/ranking preservados | fixtures de apresentação e fallback |
| `aa05f6a2` | reserva 📦 reinjetada após falha/pending/suspeito, dedupe por hash vivo, `_bankDub`/`fallbackFetchable`/vaga BR, fetch limitado pelo prazo (piso 100 ms, teto 1,5 s, fail-open) e sem persistir reserva no índice | fixtures de fallback e regressões Node |

### Entregas desta rodada (branch `rust`, sem push)

| Commit | Entrega | Limite/evidência |
|---|---|---|
| `4b50880f` | `enrichForRust` **síncrono**, só `applyFileEvidence`; `collect`/`index` não chamam `getTitles`/`ptTitleDual`. O núcleo decide chip/`_dubbed`/origem BR por `SearchMeta.titles` → `BuildContext`, sem espera de TMDB na rota | decisão in-process; o Node não envia o flag |
| `b10df543` | F2.1: Jackett com `search_outcomes` por indexer (`Ok`/`Empty`/`Failed`; timeout = `Failed`), `CollectBatch.live`, `empty` medido por `filter_relevant_raw` e sombra de fonte fire-and-forget | **PARCIAL/default OFF**; só Jackett; paridade real não medida |
| `03adaa69` | `%`: equivalência contextual (`percent` no lugar do símbolo) só em nome que carrega `%`; `3 Body Problem`, `24 Percent` e `100 Percent Wolf` seguem barrados | regressão medida no banco real (105 linhas, `tt4922804`); testes ativos |
| `2729b9db` | comentário do hash canônico do banco (`bank_hash` × `RawItem::hash`) | sem mudança de comportamento |

**Validação local (não é o gate §9.4).** Na imagem musl final `8580b705`,
`adom-core`, `adom-sources`, `adom-search` e `adom-server` saíram com exit 0;
os testes NAPI via Node fecharam 51/51; as fixtures nativas de HDR,
`ptTitleDual` e fallback passaram; e a sombra de fonte cobriu
equal/missing/extra/live/error/timeout. Isso **não** é o aceite: F1 continua
**PARCIAL** e faltam o gate 16/16 com hashes reais, o play externo por debrid,
p50/p95 e a semana em `stream-shadow`.

1. **Rotas internas** (feitas: `meta`, `state`, `collect`, `index`,
   `index-write`, `effects` e `debrid/check`):
   `POST /internal/search/meta`, `POST /internal/search/state`,
   `POST /internal/search/collect`, `POST /internal/search/index`,
   `POST /internal/search/index-write`, `POST /internal/search/effects` e
   `POST /internal/debrid/check`. Todas em loopback +
   `X-Indexer-Test-Token`, com o `encoded` no corpo para o `runtime.run` do Node
   (invariante 5). Saem em lote por etapa, nunca por item. O gateway Rust
   (`GATEWAY=on`) **recusa `/internal/*` antes do proxy** (o Caddy também
   bloqueia): a guarda de loopback do Node não vê o cliente real atrás do proxy,
   então a fachada é quem fecha a porta. No compose gateway,
   `INTERNAL_SEARCH_URL` / `INTERNAL_CHECK_URL` apontam a `127.0.0.1:7100`.

   **Enriquecimento (`collect`/`index`) — síncrono.** `enrichForRust` anexa só
   a prova de ARQUIVO (`applyFileEvidence`); as rotas **não** chamam
   `getTitles` nem calculam `ptTitleDual`, e a resposta não espera TMDB. O
   núcleo decide chip, `_dubbed` e origem BR in-process pelos títulos de
   `SearchMeta.titles` → `BuildContext.titles` → `apply_pt_title_dual`; o Node
   não precisa mandar o flag. Antes o cálculo era duplicado na rota e prendia
   a resposta a `getTitles` sem ganho.
2. **`adom-search`**: decode da config, chave de cache, prazo por requisição
   (`Dart/` = app, senão Stremio), SWR e `inFlight`, plano e janela de coleta,
   build no núcleo, `applyDebrid` pelos adaptadores no processo (herança de
   debrid do `.env` no gateway — `dd9330c4`), latest-writer e late promoter,
   fila tardia serial, corte externo com `partial:true` e busca em
   `tokio::spawn`, via do índice e via instantânea, trace gravado junto.
   Store nativo: `STREAMS_DB` (`data/streams.db`). Collect Jackett/Prowlarr/
   Torrentio/BLUDV/Mico in-process com opt-in
   `SOURCES_RUST=jackett|prowlarr|torrentio|bludv|mico` (CSV,
   case-insensitive): **composição**, não exclusão mútua — cada fonte listada
   coleta no Rust e o `NodeCollector` roda o resto com `skip_sources` (o Node
   pula as fontes já migradas). Default **OFF** = collect inteiro via
   `POST /internal/search/collect`.

   **Estado vivo por indexer (entregue).** `CollectBatch.live:
   Option<LiveBatchState>` transporta o `live.snapshot()` do `NodeCollector`
   (falhas, `pending`, `empty` e `all`); `live_state.rs` normaliza e funde
   (união dos conjuntos, `all` por prioridade `error` > `pending` > `ok` >
   `unknown`) e `merge_fast_with_live` faz o merge pós-`completion` nas três
   vias (instantânea, resgate e índice coberto). Falha de tarefa/subcoletor
   sintetiza `all=Error` conservador; na composição, coletor sem `live` também
   entra como `unknown_failure` (`all=Error`/`unknown`), então a ausência nunca
   vira "respondeu" até a fonte emitir `live` nativo (F2). A reserva 📦 cujo hash
   aparece na coleta viva sai (`liveHashes`, por hash); o selo `from_snapshot`
   cai quando o indexer da marca respondeu **ou** quando o mesmo hash aparece
   vivo. `promote_late` consome o snapshot vivo FINAL (pós-`completion`), nunca
   `None` por omissão. Sem contrato vivo (coletor nativo isolado ou Node
   antigo), vale a régua antiga. Coberto por `live_state_wiring.rs` (em
   `adom-search`); nesta rodada, `cargo test --workspace`, `clippy -D warnings`
   e `fmt` deram exit 0. O coletor **Jackett** nativo passou a emitir `live` na
   F2.1 (`search_outcomes`); Prowlarr/Torrentio/BLUDV/Mico seguem sem `live`
   nativo até a F2.
3. **Paridade (pendente)**: o corpus da F0 é só `request/response` e remonta
   0/51; o critério formal §9.4 continua **não medido**. O gate operacional
   `scripts/stream-parity.mjs` cobre 16 casos do corpus (atende aos 15+),
   compara conjunto EXATO de hashes e de BR, recusa Node×Node/sombra e mede
   p50/p95 por perfil (Stremio 10 s, Dart 15 s); self-test 14/14. Nesta rodada o
   corte real **não foi remedido**: o relato do usuário é 10/16, com 6 deltas de
   BR/hashes ainda pendentes. A validação local exercitou o gateway, mas não
   rodou esse gate contra o corte nativo; o script é ferramenta, não aceite.
4. **Corte local experimental** `ROUTES_RUST=stream` (opt-in no override;
   **não** é o default): o Node na 7100 vira reserva (internal +
   `/resolve`/painel). Ainda **não** pronto — evidência: BR some; exige
   paridade BR+cotas antes de qualquer promoção. Caveat: 1ª hit a frio pode
   vir só com aviso “reabra” (`49482cc7`); reabrir antes de acusar regressão
   de matching. `scripts/validate-docker.mjs` só exige stream tocável — não
   mede paridade BR.
5. **Play offline (parcial)**: `finish`/`finalize` já aplicam
   `play_disposition` (degradado/`resolveUncached`/cacheado). O knob
   `resolveUncached` só atua com debrid ativo e checagem utilizável; `Unusable`
   (auth/quota) devolve P2P como `known:false` (TTL curto, sem autofetch) e dropa
   o multiobra. O drop acontece antes de
   `limit_reserving_br`, e `fallback` é lido da lista FINAL (depois do drop e do
   corte); `DebridLink` entra como `known:false`; URLs e HMAC foram testadas nos
   cinco serviços. Mas o `/resolve` nativo ainda é proxy/501: o play externo
   real **não** foi validado por debrid.

## F2 — Fontes e metadados em Rust (uma por commit, cada uma com sombra)

**Estado: F2.1 PARCIAL, default OFF.** `SOURCES_RUST_SHADOW` (CSV) é vazio por
default e `SOURCES_RUST` segue OFF; a sombra de fonte compara **só Jackett** e
**não** é o critério §9.4. O contrato e o recorte estão em
`docs/rust-stream-contract.md`.

**F2.1 — Jackett com `live` e sombra de fonte (`b10df543`).** `search_outcomes`
devolve um `QueryOutcome` por indexer: `Ok`/`Empty` são resposta válida
(`Empty` = 200 sem item relevante para a obra, medido por
`filter_relevant_raw`; itens de outra obra contam como `Empty`); `Failed` cobre
HTTP/rede/envelope/breaker e **timeout** (= `Failed`, sem engolir o motivo).
`CollectBatch.live` leva o estado por indexer ao orquestrador;
`record_status:false` (sweep inline/tardio) não pinta `live`/`partial`, e a
varredura tardia nem roda sombra (`skipped_late`). No modo sombra o nativo
ignora o breaker e não o registra; no caminho de resposta breaker/status
continuam valendo.

A sombra (`SOURCES_RUST_SHADOW=jackett`) roda **fire-and-forget**
(`tokio::spawn`) e compara, por indexer, o conjunto de hashes normalizados e o
`live` (`failed`/`pending`/`empty`/`all`); o lado Node roda em `read_only`, sem
inventário da conta, captura no banco, status/breaker nem cache bruto. Só a
consulta principal entra na comparação. Métricas: `source.shadow.compared`,
`divergence`, `items_missing`, `items_extra`, `live_divergence`, `timeout`,
`error`, `partial_divergence`, `skipped`, `skipped_late`; `partial` diferente
conta só em `partial_divergence` (informativa), nunca em `divergence`.

**Limitações (F2.2):** o `ji` por requisição ainda usa `JACKETT_INDEXERS` do
processo na rota read-only; `live` nativo só existe para Jackett; Prowlarr,
Torrentio, BLUDV e Mico são ignorados pela sombra (sem identidade de indexer
normalizada) e não têm `live`; **paridade real não foi medida** e a sombra de
fonte não substitui §9.4.

**Próximas partes:** metadados (Cinemeta/TMDB) e inventário da conta; depois
Prowlarr → Torrentio (fail-open, breaker local) → BLUDV/Mico (reusar
`adom-resolvers`/`mico_net`) e o que hoje é 501 no `adom-debrid` (`check` de
RD/TorBox/AllDebrid, `files`, `account`). Cada fonte migrada sai da rota
`collect`. O Jackett mantém Torznab/JSON, globais agrupados e BR isolados em
pt-BR (invariante 4, breaker só em `offline`).

## F3 — Estado em Rust

**Estado:** não iniciada nesta rodada; contrato pronto em
`docs/rust-stream-contract.md`. `raw:v1`, `idx:v14`, banco VIVO (`magnets.db`)
e `davail` num store Rust no padrão de `adom-debrid/src/store.rs`, com
importação única do `cache.db`. Painel e `/stream-trace.json`/
`/dashboard-status.json` passam a ler do Rust por rota interna.

## F4 — Corte final

**Estado:** não iniciada nesta rodada; contrato pronto em
`docs/rust-stream-contract.md`. Só depois de paridade BR+cotas e critério §9.4:
`ROUTES_RUST=stream` vira padrão; saem `search-orchestrator`, `search-cache`,
`stream-builder*`, `debrid-pipeline*` e as rotas internas de coleta. O Node fica
com configure, painel, `/resolve` (até ser portado) e config.

---

## Ordem prática de trabalho

O que trava o quê:

- F-1.2/F-1.3 não dependem de F0 nem de F1 — são a mesma receita barata
  (módulo puro + golden + napi + casca TS) e podem andar em paralelo com F0 e
  com a F1.
- A sombra da F0 **só é honesta depois** que o orquestrador da F1 existir: sem
  ele não há "remontar a resposta", só um proxy que finge comparar.
- O override gateway fica em **sombra** (`stream-shadow`). Corte
  `ROUTES_RUST=stream` é experimental e **não** default; critério formal
  §9.4 + paridade BR+cotas travam a promoção. Não confundir smoke/
  `validate-docker.mjs` (só tocável) com aceite do corte, nem “compose
  local” com “F4 no compose principal”.
- A F2.1 começou sobre a rota `collect` em `read_only`; as próximas fontes só
  avançam quando esse contrato estabilizar. Migrar fonte com a rota ainda
  mudando joga trabalho fora.

## Verificação de ponta (por corte, não por fatia)

1. `cargo test`, clippy, fmt na raiz de `rust/`.
2. `npm run typecheck`, `npm test`, `npm run lint:lines`.
3. Prazo: portar `test/search-budget-metadata.test.ts` para o Rust.
   `adom-search/tests/search_budget_metadata.rs` já tem **7 testes** rodando
   pelo `Orchestrator` real (orçamento do metadata, piso de 500 ms, perfis
   Stremio/Dart e graça BR), mas o porte segue **parcial**: atribuição por
   `search.deadline.*`, timer `search.metadata` e métricas `search.first.*`
   ainda não têm equivalentes no orquestrador Rust. Medir p50 e p95 reais do
   `/stream` com Stremio (10 s) e com o app Power Movie (15 s) antes e depois
   continua pendente; testes offline não substituem essa medição.
4. Docker / smoke gateway: checklist §0.6 do contrato (`compose` + `curl`).
   `validate-docker.mjs` só checa tocável — **não** paridade BR (contrato
   §0.7). Antes de promover corte: `clear-cache`; cobrir série, filme, pack e
   BR dublado + cotas — Node desligado **e** ligado. 1ª hit a frio: §0.5.
5. Play: `/resolve` de um item de cada debrid pela lista gerada no Rust (o HMAC
   tem que valer). No orquestrador Rust, `finish`/`finalize` já aplicam
   `play_disposition` e as URLs/HMAC foram testadas offline nos cinco serviços,
   mas o `/resolve` nativo segue proxy/501 — o play externo real por debrid
   **não** foi validado.
