# Migração da orquestração de `/stream` para Rust — mapa das fatias

Plano de execução do *strangler* descrito no pedido original. Cada fatia é um
commit, o branch fica funcional em cada um, e a régua de aceite é sempre a
mesma: `cargo test` + `cargo fmt --check` + `cargo clippy` verdes, `npm run
typecheck` em zero, suíte Node verde e `npm run lint:lines` sem regressão.

Este documento é o **mapa**, não a regra: em conflito com o código, o código
vence. `AGENTS.md` continua sendo a fonte dos invariantes.

> **Nota de vigência (R8):** as fatias R0–R8 removeram o TS que o Rust já
> cobria e, com ele, as flags de modo/rollback por env. O estado vigente está
> no [§R](#r--remoção-do-ts-r0r8) no fim deste documento; os textos das fatias
> F0–F4 abaixo são o **histórico da execução** — onde citam flags removidas,
> elas aparecem como registro da época, não como knob.

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
   `stream.shadow.*` do contrato §9.2 são públicas. Era o default do override
   `docker-compose.gateway.yml` **até o F4.4**; com o `/stream` do Node
   aposentado (410/503) a referência não existe mais — hoje é instrumento
   histórico e o gate é o corpus congelado (§F4).

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
   F2.1 (`search_outcomes`); o Prowlarr na F2.2, o Torrentio na F2.3, o Mico na
   F2.4 e o BLUDV na F2.5 passaram a emitir `live` por FONTE.
3. **Paridade (pendente)**: o corpus da F0 é só `request/response` e remonta
   0/51; o critério formal §9.4 continua **não medido**. O gate operacional
   `scripts/stream-parity.mjs` (removido no R1) cobria 16 casos do corpus
   (atende aos 15+), comparava conjunto EXATO de hashes e de BR, recusava
   Node×Node/sombra e media p50/p95 por perfil (Stremio 10 s, Dart 15 s);
   self-test 14/14. Nesta rodada o
   corte real **não foi remedido**: o relato do usuário é 10/16, com 6 deltas de
   BR/hashes ainda pendentes. A validação local exercitou o gateway, mas não
   rodou esse gate contra o corte nativo; o script é ferramenta, não aceite.
4. **Corte local experimental** `ROUTES_RUST=stream` (histórico da F1; desde o
   R8 o corte é fixo no compose): o Node na 7100 vira reserva (internal +
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
   cinco serviços. O `/resolve` nativo por debrid é **incondicional** (fase C do
   F4.7: sem `RESOLVE_RUST`, rollback = commit/imagem anterior); o play externo
   real continua **não** validado ponta a ponta (sem Docker nesta rodada).

## F2 — Fontes e metadados em Rust (uma por commit, cada uma com sombra)

**Estado: F2.5 PARCIAL (Jackett/Prowlarr/Torrentio/Mico/BLUDV) + C5
(metadados nativos), default OFF.**
`SOURCES_RUST_SHADOW` (CSV) é vazio por default e `SOURCES_RUST` segue OFF; a
sombra de fonte compara **Jackett, Prowlarr, Torrentio, Mico e BLUDV** e **não**
é o critério §9.4. `META_RUST`/`META_RUST_SHADOW` também são OFF. O contrato e
o recorte estão em `docs/rust-stream-contract.md`.

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

**F2.2 — Prowlarr com identidade do Node, `live` e sombra.** O item do Prowlarr
no TS não tem `indexer`: só `tracker` (`indexer || indexerId`), e é dele que
nasce o `_indexer` do stream (`search-names.ts:250`). O coletor nativo passou a
usar **o tracker como `indexer`/`tracker`** e `sources:["tracker:<tracker>"]`;
antes fixava `indexer:"prowlarr"`, o que jogava a cota por indexador e o chip
⚙️ para uma fonte que o Node não conhece. `isBr` continua `false` (o
`looksPtBr(title)` decide no build) e título/seeders/tamanho/hash são
preservados.

`ProwlarrClient::search_outcome` distingue resposta válida (`Ok`, inclusive
vazia) de configuração (`Disabled`/`BlockedUrl`, sem consulta) e de falha
declarada (`Http(429/5xx)`, `InvalidJson`, `Network`, `Timeout`); o `search()`
antigo segue fail-open devolvendo `Vec`. O `live` nativo é **por fonte**
(`"prowlarr"`, como o Mico): `Ok` = conjuntos vazios, `Empty` = resposta válida
sem item relevante (`filter_relevant_raw`), `Failed` = consulta tentada e não
respondida. `all` fica **sempre `Unknown`** (o agregado só existe no ramo
`/all` do Jackett), `pending` nunca é inventado e falha de configuração não vira
falha viva.

**F2.3 — Torrentio com identidade do Node, `live` e sombra.** O
`src/providers/torrentio.ts` publica `indexer:"torrentio"` (o AGREGADOR, não o
tracker interno), `tracker` = rótulo depois do `⚙️` na linha de metadados
(vazio → o Node cai no `indexer`, e o `⚙️` mostra "torrentio"), `infoHash`
minúsculo, `title` sem a linha `👤 … ⚙️`, `seeders` (`?? 0`), `size` (só quando
> 0) e `fileIdx` truncado. O coletor nativo passou a levar **`tracker`**
(também em `sources:["tracker:<rótulo>"]`), a limpar o `size` pela régua
`known_size` do item cru e a preservar `fileIdx` em `RawItem.extra` (o
`raw_item_from_value` também o guarda, então o caminho do Node não perde o
campo). `isBr` continua `false` — o áudio vem do título no build, como nos
demais indexadores globais.

`TorrentioClient::search_outcome` distingue resposta válida (`Ok`, inclusive
JSON sem `streams`), configuração (`Disabled`/`BlockedUrl`/`NoEndpoint`, sem
consulta) e falha declarada (`Http(429/5xx)`, `InvalidJson`, `Network`,
`Timeout`) mais `BreakerOpen` (consulta pulada pelo circuito); o `search()`
antigo segue fail-open devolvendo `Vec`. **O breaker só é lido/escrito no
caminho vivo** (`TorrentioSearchOptions::LIVE`): a sombra usa `SHADOW`, ignora
o circuito aberto e não o abre/reseta (mesmo contrato do `readOnly` do TS, com
cliente próprio). O `live` nativo é **por fonte** (`"torrentio"`): `Ok` =
conjuntos vazios, `Empty` = resposta válida sem item relevante
(`filter_relevant_raw`) ou 4xx da obra (host vivo, obra sem release — o Node
também não alimenta o breaker em 4xx), `Failed` = 429/5xx/rede/timeout/JSON
inválido/breaker aberto. `all` fica **sempre `Unknown`**, `pending` nunca é
inventado e configuração não vira falha viva.

**F2.4 — Mico com identidade/parse do Node, `live` e sombra (C4).** O
`src/providers/mico.ts` é card VIRTUAL por IMDb (fora do Jackett): título da
primeira linha sem `👥`/`💾`/`(langs)`/`…`, hash 40-hex minúsculo, `seeders`
(`👥`, default 1), `size` (`💾` > 0), `indexer:"mico"` e `isBr`
(`looksPtBr(title)` ou `(brazil`). O parser nativo passou a ser fiel também nos
pontos que divergiam: `strip_pictographic` usa a tabela REAL de
`Extended_Pictographic` (o aproximado por blocos apagava ①/あ e símbolos
comuns), os `(langs)` exigem a lista `[a-z]+(, [a-z]+)*` (sem vírgula sobrando),
`size` aceita `2.1GB` sem espaço e avança até o primeiro match válido, e os
trackers do magnet saem na ORDEM do `Set` do Node (com `encodeURIComponent`
fiel: `!*'()~` não são escapados), sem `dn=`.

`MicoClient::search_outcome` distingue resposta válida (`Ok`, inclusive JSON
sem `streams`), configuração (`Disabled`/`BlockedUrl`/`NoEndpoint`),
`BreakerOpen`, `Pending` (deadline do coletor vencido — o Node teria a consulta
em voo), `Http(4xx)` (obra, NEUTRO no breaker e vira `empty`/`responded:true`),
`Http(429/5xx)`, `InvalidJson`, `Network` e `Timeout`. O `Retry-After` cobre
segundos (`Number`, inclusive `1.5`/`0x10`/`1e2`) e data HTTP (RFC 1123/850/
asctime via `httpdate`), com piso zero. O `search()` antigo segue fail-open em
`Vec`; o breaker só é lido/escrito no caminho vivo (`MicoSearchOptions::LIVE`) e
a sombra usa `SHADOW` (ignora o circuito aberto e não o abre/reseta).

O `live` nativo é **por fonte** (`"mico"`): `Ok` = conjuntos vazios, `Empty` =
resposta válida sem item relevante (`filter_relevant_raw`) ou 4xx da obra,
`Failed` = 429/5xx/rede/timeout do CLIENTE/JSON inválido/breaker aberto,
`Pending` = prazo do coletor vencido (lote `partial`). `all` fica sempre
`Unknown` (o Mico não tem ramo `/all`). Como o Node **emite live para o Mico**
(`noteStart(["mico"])` + `onQueryResult` no `collectRawLive`), a sombra roda o
par com `compare_live:true`: `ok`/`empty`/`failed`/`pending` são comparados e
`live_divergence` cobre as quatro combinações.

**F2.5 — BLUDV com identidade/título do Node, `live`, `raw:v1` e sombra (C3).**
O `src/providers/bludv.ts` publica `tracker:"BLUDV"` e **não** publica
`indexer`/`sources` no cru; o `_indexer` do stream nasce do tracker
(`"BLUDV"` → `"bludv"`) e o chip é `⚙️ BLUDV` (o nativo agora mantém o
`tracker`; antes o rótulo caía em `indexer` minúsculo). `sources` do contrato
continua sendo a lista FIXA de trackers do Node (`DEFAULT_TRACKERS`), nunca
`tracker:BLUDV`. O título é o `releaseTitle` do TS: `cleanPostTitle` (7
remoções) + tag do BOTÃO `[<qualidade>p <fonte> DUBLADO|LEGENDADO]`, com
qualidade/fonte/áudio classificados pelo contexto `segmento + âncora`
(`normalizeQuality`/`normalizeSource`/marcadores NACIONAL/PORTUGUÊS/[DUB]/[LEG]).
`size` vem da última ocorrência `N GB/MB` do contexto e passa por `known_size`
(1 KB sentinela = desconhecido); `seeders` é o neutro 1; `isBr: true`.

O `redirect:'follow'` do TS foi preservado **manualmente**: o cliente usa
`Policy::none()` e segue cada `Location` validando `is_safe_download_url` no
hop seguinte (SSRF preservado; um redirect para privado fora da origem é
barrado antes do GET) e o prazo absoluto cobre todos os hops. Posts e links
rodam com concorrência limitada (`BLUDV_CONCURRENCY`, default 6) e a ordem do
documento é preservada — o custo de manter sequencial era o scrape inteiro
(~1 post a cada dois saltos de protetor).

`dubbedOnly` chega pelo `CollectJob`/`RequestSelection` e filtra o botão
`legendado` DENTRO do scrape, como o `opts().dubbedOnly` do Node; o default do
operador (`BLUDV_DUBBED_ONLY=true`) virou o default de `BuildOptions` e o
`d=false` da URL vence o default (o overlay do `SCHEMA` já fazia isso).

`BludvClient::search_outcome` distingue resposta válida (`Ok`), configuração
(`Disabled`/`BlockedUrl`, sem consulta) e falha declarada (`Http(429/5xx)`,
`Failed` = rede/timeout/redirect inválido). O `live` nativo é **por fonte**
(`"bludv"`): `Ok` = item relevante, `Empty` = resposta válida sem item relevante
(inclusive 4xx da obra), `Failed` = 429/5xx/rede/timeout; `all` fica sempre
`Unknown` e `pending` nunca é inventado. O Node **não** emite live para o
BLUDV, então a sombra roda o par com `compare_live:false` e compara só a
IDENTIDADE (hashes agrupados por `indexer || tracker` — o item cru do BLUDV só
tem `tracker`).

`raw:v1` do BLUDV (`raw:v1:bludv:d|t:<query>`, valor `{items}`) só é
lido/gravado no caminho VIVO (`SOURCES_RUST=bludv`): o gateway injeta o mesmo
`cache.db` do Node (`CACHE_DB_PATH`, cota `raw` de 800) no coletor; a sombra
monta o cliente com `read_only` e não toca o cache bruto. Lote com portão de
anúncio fica `incomplete` e não é cacheado (mesmo `notePending` do Node).

A sombra (`SOURCES_RUST_SHADOW=jackett,prowlarr,torrentio,mico,bludv`) roda
**fire-and-forget** (`tokio::spawn`) e compara, por indexer, o conjunto de
hashes normalizados e o `live` (`failed`/`pending`/`empty`/`all`); o lado Node
roda em `read_only`, sem inventário da conta, captura no banco, status/breaker
nem cache bruto. Só a consulta principal entra na comparação. Para Prowlarr,
Torrentio e BLUDV o `live` **não** é comparado: o `collectRawLive` do Node não
emite `onQueryResult` para eles, então a referência sai vazia/`unknown` e a
comparação acusaria divergência falsa em toda falha. A sombra deles compara a
IDENTIDADE (hashes por `_indexer`/tracker); o `live` nativo vale na produção com
`SOURCES_RUST=prowlarr,torrentio,bludv`. Para o Mico, o Node emite
`pending`/`failed`/`empty`, então o `live` é comparado e conta
`live_divergence`. O nativo do BLUDV não faz captura no banco, card/status nem
`raw:v1` na sombra; o nativo do Mico também não. Métricas: `source.shadow.compared`,
`divergence`, `items_missing`, `items_extra`, `live_divergence`, `timeout`,
`error`, `partial_divergence`, `skipped`, `skipped_late`; `partial` diferente
conta só em `partial_divergence` (informativa), nunca em `divergence`.

**F2.6/C5 — Metadados nativos (Cinemeta/TMDB/coleção/home release), `META_RUST`
OFF.** O orquestrador troca `NodeMetaSource` (rota interna) por
`NativeMetaSource`: `adom_sources::MetaSources` faz o `/find` duplo (pt-BR e
en-US no MESMO prazo), aliases BR filtrados pelo núcleo, coleção multiobra e 1º
lançamento doméstico sob teto próprio (`min(deadline, now + cap)`). A montagem
do `SearchMeta` é COMPARTILHADA com o caminho Node
(`build_search_meta`/`MetaParts`): nome, aliases na ordem do
`resolveSearchNames`, ano/`altYear` (`catalog_year_of`), query, degrau pt-BR
(com o ANO do TMDB, não o escolhido), varredura pt, degrau do original e raiz
multiobra saem da mesma função. Com rotas internas o Node é o **fallback**
(nativo errado/sem nome) e o default segue sendo ele; sem rotas, o nativo vira
a única fonte (antes a busca ficava sem metadados).

**Cache = o do Node.** `MetaCacheStore` (`adom-store`) usa o MESMO
`CACHE_DB_PATH`/`cache.db` e as MESMAS chaves/valores do Node:
`meta:{tipo}:{imdb}` (`{name, year, type, episodes?, released?, firstAired?,
episodeAired?, __metaV:2}` ou `{miss:true}`), `tmdb:{imdb}`
(`{pt, original, en, br, year}` ou `{miss:true}`), `tmdbc:{imdb}` (`{info}` /
`{info:null}` / `{miss:true}`) e `tmdbh:{imdb}` (`{at}`). Entrada no formato
antigo é MISS (o Node também reconsulta uma vez); a cota por namespace é a do
núcleo (`meta`/`tmdb`/`tmdbc` = 500, despejo do que expira primeiro). Restart ou
queda não esfriam o metadado e o Node lê o que o Rust gravou.

**`episodeAired` real.** `meta.episodeAired["S:E"]` vira
`SearchMeta.episode_aired_at_ms` pelo parser determinístico do núcleo
(`adom_core::parse_date_ms`, o mesmo do banco de magnets) nas DUAS fontes. O
`BuildContext` recebe o campo e a guarda de pré-air (48 h) finalmente roda —
antes `episode_aired_at_ms` era `None` fixo. `firstAired` segue o TS
(`meta.firstAired ?? episodeAired[S:E]`) e `released`/`firstAired` vão no
`SearchIndexRequest` (a janela recente do índice usava `null`). O 1º lançamento
doméstico (`homeReleaseAt`) também passou a entrar no filtro de título: o
`relevance_query` passava `None` fixo e `preHomeReleaseCut` ficava morto no
caminho nativo. As PRECONDIÇÕES dos opt-ins agora são as do Node
(`BR_MULTIWORK_PACKS` E sem temporada E não demo E debrid ativo; data doméstica
só com `SEARCH_PRE_HOME_RELEASE_CUT`, sem temporada e não demo), lidas do `.env`
em `operator_search_build_from_env`.

**Sombra de metadados (`META_RUST_SHADOW`, independente de `META_RUST`).**
Envolve a fonte primária e roda a OUTRA em `tokio::spawn` DEPOIS da resposta:
nunca segura o cliente. Compara `name`, `names` (ordem), `year`, `altYear`,
coleção (raiz/query), `homeReleaseAt`, `episodeAired` (ms) e as queries
pt-BR/original/varredura; `titles` não entra (sai dos mesmos pt/original/en).
Amostra determinística por `kind:id` (`META_RUST_SHADOW_PERCENT`, 0..=100,
default 100) e prazo próprio (`META_RUST_SHADOW_TIMEOUT_MS`); não amostrado conta
`meta.shadow.skipped_sample` e nem chama a referência. A referência nativa usa
`ReadOnlyMetaStore` (lê o cache quente do Node, nunca grava). Divergência
incrementa `meta.shadow.divergence` + `divergence_fields` + o contador do campo;
timeout/erro da referência NÃO são divergência. Métricas: `meta.shadow.compared`,
`divergence`, `divergence_fields`, `name/names/year/alt_year/collection/
home_release/episode_aired/pt_query/sweep_query/original_query` + `_divergence`,
`timeout`, `error`, `skipped`, `skipped_sample`.

**Testes C5:** `adom-store` cobre roundtrip dos quatro namespaces, formato do
Node, leitura de entrada gravada pelo Node, formato antigo → MISS, expiração +
restart, chave de outro namespace e cota. `adom-search` cobre
`episodeAired`/`firstAired`/home release na rota, a guarda de 48 h PONTA A PONTA
no build (47 h fica, 49 h sai, sem data não roda), o mapeamento nativo
(filme/série/coleção/ano), o corpus de títulos
(`scripts/golden/corpus-search-name-helpers.json`: `meta_from_lookup` ×
`meta_from_response` campo a campo) e a sombra (igual não conta, divergência
conta por campo, amostra 0 pula sem chamar a referência, referência lenta não
segura o cliente, erro/timeout não são divergência, primário com erro não
compara).

**Limitações (C5):** `first_seen` do banco de magnets continua fora (é insumo da
F3): o pré-air da CONTA segue usando só `publishedAt` — release de conta sem
data de publicação não é pega pela guarda de 48 h. `tmdb_id`/
`original_language` não são persistidos (o Node também não os grava). A sombra
compara só requisições amostradas e não substitui §9.4; paridade de metadados
com a API real não foi medida (o corpus cobre a MONTAGEM, não a rede).

**Limitações (F2.5):** `live` nativo existe para Jackett (por indexer),
Prowlarr, Torrentio, Mico e BLUDV (por fonte). O de Prowlarr/Torrentio/BLUDV
não tem referência no Node (o `collectRawLive` não emite para eles) e por isso
não é comparado; o do Mico é. **Paridade real não foi medida** e a sombra de
fonte não substitui §9.4. O BLUDV não tem `episodeOf` no título nativo (o Node
acrescenta o sufixo `E01` do passo âncora-local; o título do post continua
carregando a temporada/episódio). O `ji` por requisição
já vale para os dois lados (C0b): `JACKETT_INDEXERS` do processo é só fallback
de instalação sem `ji`, e o Mico lê o card virtual `"mico"` desse mesmo `ji`
(ou `MICO_DEFAULT` sem `ji`).

**Próximas partes:** inventário da conta (F3 — leitura nativa atrás de
`ACCOUNT_RUST`, `off` por default; contrato em
[`account-rust-contract.md`](account-rust-contract.md)) e o restante de
`adom-debrid` (o que hoje é 501: `check` de RD/TorBox/AllDebrid, `files`,
`account`). Metadados (Cinemeta/TMDB) já têm porte puro atrás de `META_RUST`
(OFF) e sombra própria. O BLUDV já tem cliente próprio (C3/F2.5, sem reusar o
binário `adom-resolvers`). Cada fonte migrada sai da rota `collect`. O Jackett
mantém Torznab/JSON, globais agrupados e BR isolados em
pt-BR (invariante 4, breaker só em `offline`).

## F3 — Estado em Rust

**Estado:** F3.1 entregue (`idx:v14`); F3.2 entregue (`raw:v1`); banco VIVO e
`davail` ainda sem dono único. Alvo de cada namespace: um store Rust no padrão de
`adom-debrid/src/store.rs`, com importação única do `cache.db`; painel e
`/stream-trace.json`/`/dashboard-status.json` lendo do Rust.

### F3.1 — `idx:v14` com dono único (entregue)

Commits `18bbc4dd` (F3.1a, provas no `adom-store`) → `62bdce6c` (crate
`adom-index`) → `6799045b`/`d8d41e88` (napi `IdxStore`) → `78f23bb5`/`f1b09818`/
`0dd78287` (Node vira fachada).

- O Rust é o único escritor. `release-index.ts` é fachada sobre o `IdxStore`
  (`release-index-store.ts`, napi síncrono); o orquestrador (`INDEX_RUST`) e a
  rota `/internal/search/index` leem pelo mesmo `adom-index`.
- O Node não grava `idx:` no L1 nem no SQLite: `cache.set`/`persist`/`forget`
  recusam o namespace; o boot não carrega, não expira e não apaga linha `idx`;
  `cache.clear()` e `clearNamespace('idx')` chamam o Rust.
- Prefixo morto (`idx:v13`…) some no `open` do `adom-index`; expirado, na
  leitura e no `enforce_quota`. `status().entries` vem do Rust.
- Perdas conscientes: `search.idx.routed`/`search.idx.protCap` não contam mais;
  o TTL restante não é asserido no TS; **não há `INDEX_OWNER=node`** —
  rollback = commit/imagem anterior.
- Contrato e diferenças em [`rust-index-bank-contract.md`](rust-index-bank-contract.md)
  (F3.1a/F3.1).

### F3.2 — `raw:v1` com dono único (entregue)

A escrita viva já era do Rust (coletor BLUDV nativo desde o R5, no mesmo
`cache.db`); a fatia fecha o segundo escritor e a leitura que sobrava no Node.
O store (`RawCacheStore`) saiu do `adom-store` para o `adom-index` (crate leve,
sem rede) — o `.node` e o gateway compartilham o MESMO código, como o
`ReleaseIndexStore`.

- O escritor TS do Jackett (`jackett-query.ts`) saiu com a pilha TS; o `raw`
  vira `RUST_OWNED` pelo namespace INTEIRO (`cache-keys.ts`) — sai o prefixo
  `raw:v1:bludv:`. `cache.set`/`persist`/`forget` recusam qualquer linha `raw`;
  o boot não carrega, não expira e não apaga (`ownedGuards` protege o
  namespace da poda do L2).
- A leitura do diagnóstico (`trace-recompute`, `/stream-trace.json` sem trace)
  vai pela ponte napi `RawStore` (`raw-store-native.ts`, `peek_json` síncrono
  sobre o mesmo `cache.db`) — leitura quiet, sem LRU e sem contador.
- `cache.clear()` e `clearNamespace('raw')` chamam `RawStore::clear` (napi); a
  ação `clear-cache {scope:{namespace:"raw"}}` do painel alcança o Rust por aí.
- A cota de 800 é aplicada no Rust (`enforce_quota`, despejo do que expira
  primeiro); a moldura de chave do Jackett (`rawKeyFor`) fica no
  `trace-recompute` enquanto houver linha legada a explicar.
- Perda consciente: `cache.hit.raw`/`cache.miss.raw` não existem mais (o L1 do
  Node não vê o namespace). Rollback = commit/imagem anterior.

### O que falta

| namespace | hoje | falta |
|---|---|---|
| banco VIVO (`magnets.db`) | captura e escrita no Node (`magnet-bank*`); o Rust (nativo desde o R4) lê em lote e grava só o veredito do filtro (`MagnetBankSource`) | captura no Rust e os índices `magnet_last_seen`/`magnet_source_last_seen` sob o mesmo dono; painel lendo do Rust |
| `davail` (⚡ por hash/conta) | o Node grava no `cache.db`; o `adom-debrid` copia uma vez na subida (`import.rs`, marcador `__debrid:import:v1`) | dono único — hoje são dois escritores que divergem depois do import |

Cada um segue a receita do F3.1: provas laterais no Rust com o Node inalterado,
depois o Node vira fachada e recusa o namespace no L1/L2.

## F4 — Corte final (F4.4 ENTREGUE, sem Docker)

**Estado no branch `rust`:** o F4.4 foi executado com autorização explícita do
operador para **pular a janela §9.4** (evidência substituta: corpus congelado
16/16 + e2e 51/51 + os gates de código; Docker/rebuild ficam para o deploy).
Aceite do corte agora é **por commit/imagem**, não por soak.

O que mudou:

- **Defaults**: `GATEWAY=on` e `ROUTES_RUST=stream` no `docker-compose.yml`
  (Node na 7100); `EFFECTS_RUST` = `on` (único knob de fatia que sobrou, com
  `off` como rollback). As flags das demais fatias (`SOURCES_RUST`,
  `META_RUST`, `ACCOUNT_RUST`, `INDEX_RUST`, `BANK_RUST`, `DEBRID_AL_RUST`,
  `STREAM_STORE_RUST`, `STREAM_BAD_RUST`) **não existem mais** — saíram nas
  R2–R6 e os caminhos são incondicionais. A checagem/limpeza da AllDebrid é
  nativa desde o R3 (a rota Node `/internal/debrid/check` foi apagada);
  `DEBRID_AL_HOLDS`/`DEBRID_AL_CLEANUP` ficam só como kill-switches
  destrutivos. Rollback de qualquer fatia é commit/imagem anterior. Contrato
  em [`debrid-al-check-rust.md`](debrid-al-check-rust.md).
- **Pipeline TS removido**: `search-orchestrator`, `search-cache`,
  `stream-builder*`, `debrid-pipeline*`/`debrid-play-guard`,
  `search-metadata-load`, `tail-enqueue`, `search-late-promoter`,
  `search-sweep-tail` e `search-commit`. O `/stream` do Node responde **410**
  com `GATEWAY=on`+`ROUTES_RUST=stream` e **503** sem gateway.
- **O que ficou no Node**: meta (fallback), effects, debrid/holds, as rotas do
  sidecar, `/resolve` (default), painel/config e o raspador. Coleta, índice,
  banco e metadados primários são nativos; as rotas
  `state/collect/index/index-write/fallback` e `/internal/debrid/check` foram
  apagadas nas R0–R6. `applyDebrid`/`play-guard` seguem só como **oráculo
  congelado** em `test/helpers/pipeline-oracle/`.
- **Testes**: os que mediam o pipeline TS saíram (190 testes); os que mediam
  decisões que o Node ainda executa foram migrados para o oráculo/`collectRaw`.
  O harness adversarial MUT-09/MUT-10 foi realinhado para o oráculo.
- **Sombra/canário/frozen**: **removidos do código no R1** (não há
  instrumento no binário); o `docker-compose.gateway.yml` virou só o override
  de diagnóstico que publica o Node em `127.0.0.1:7100`.

Limite honesto: sem Docker/rebuild nesta rodada, **não** há prova de boot do
container com o gateway default. O deploy deve rodar o checklist do contrato §0
e o `clear-cache` antes de medir; a 1ª abertura a frio ainda pode vir só com
aviso (§0.5).

**Dependências do pipeline — RESOLVIDAS no F4.4a:**

O F4.4a fechou os itens 1–3 com uma API administrativa do store nativo
(`adom-server::store_admin`, loopback + token) consumida pelo Node. O que era
"inerte" agora tem caminho:

1. **`/resolve` alcança o `streams.db`.** `invalidateStreamsForObra`
   (`src/utils/br-gap.ts`) continua limpando o L1 do Node e passa a enfileirar
   `POST /streams/invalidate {"imdbId"}`; os ramos de erro do `/resolve`
   (`NoVideoError`/`DubLieError`/`EpisodePickError` e o caminho `rustServices`)
   fazem `flush` antes de responder, então a reabertura imediata já reconstrói.
   O 451 (`invalidateStreamsOnBlocked`) limpa o nativo em best-effort, atrás do
   mesmo cooldown. Há também `{"hash"}` para o item resolvido (a URL relativa
   de `/resolve/<hash>` é o que sobra na entrada).
2. **`clear-cache` do painel limpa o nativo.** Escopo global → namespace todo;
   `{namespace:"streams"}` → idem; `{installation:true}` → chaves com o MESMO
   sufixo `:<streamsCacheScope>`; qualquer outro namespace não toca o nativo. A
   resposta ganhou o campo `native` (`{attempted, ok, removed, error?}`) para o
   operador ver o que aconteceu de fato.
3. **`/stream-trace.json` lê o ledger nativo.** Quando o L1 do Node não tem a
   obra (o caso do corte), a rota chama `GET /streams/trace?type=&id=[&key=]` e
   devolve o MESMO contrato (`origin:'cached'`, `cache.remainingS/partial/
   debridKnown/stale`, `trace`, `recompute:null`, `live`), com
   `source:'rust'`. A chave exata do segmento vai em `key`; sem ela o Rust
   escolhe a build mais recente da obra. `STREAM_TRACE=false` continua zerando
   a exposição (o `serializeTrace` do Node roda sobre o ledger do Rust).
4. **`bad`/`lie` no build nativo.** A poda é **incondicional desde o R2**
   (não existe `STREAM_BAD_RUST`): o build injeta em
   `BuildContext.broken_hashes` os hashes `mag:v1:{bad|lie}:<adapter>:<conta>:`
   vivos, lidos do `cache.db` por `adom-store::MagnetDbStore` (conexão
   read-only). O build marca `_broken` e o `finalize` corta antes da checagem —
   a mesma régua do `pruneKnownBroken`, agora aplicada aos itens que a coleta e
   o índice NATIVOS produzem (eles não passam pela rota de evidência do Node).
5. **F4.6 → R3**: a checagem/limpeza da AllDebrid é nativa e **incondicional**;
   a flag `DEBRID_AL_RUST` e a rota Node `/internal/debrid/check` foram
   **apagadas**. `DEBRID_AL_HOLDS`/`DEBRID_AL_CLEANUP` ficam como kill-switches
   das varreduras destrutivas (default do código OFF, compose ON). A conta do
   operador segue em `MAGNET_TOO_MANY`, então o check nativo responde
   `unusable: quota` (mesmo estado do caminho Node) e a limpeza nasce suprimida
   por `inventory_missing` — fail-closed, sem remoção. Detalhe em
   [`debrid-al-check-rust.md`](debrid-al-check-rust.md).

**Contrato da API administrativa (`STREAM_STORE_ADMIN_LISTEN`, default
`127.0.0.1:8711`)** — token `X-Indexer-Test-Token`
(`STREAM_STORE_ADMIN_TOKEN` → `DEBRID_INTERNAL_TOKEN` → `JACKETT_TEST_TOKEN`;
sem token, 503). Ela é montada SÓ no processo `adom-server` com
`ROUTES_RUST` contendo `stream` (fixo no compose desde o R8), nunca na 7000
pública (o gateway recusa `/internal/*`) e nunca por Caddy.

| rota | efeito |
|---|---|
| `POST /streams/invalidate` `{"imdbId":"tt…"}` | apaga as chaves da obra |
| `POST /streams/invalidate` `{"hash":"<40hex>"}` | apaga as entradas que citam o hash |
| `POST /streams/clear` `{}` / `{"suffix":":…"}` | limpa tudo / só o escopo da instalação |
| `GET /streams/trace?type=&id=[&key=]` | ledger + estado da entrada da obra |
| `GET /streams/stats` | ocupação/cota (diagnóstico) |

**Rollback (histórico):** as flags `STREAM_STORE_RUST`/`STREAM_BAD_RUST` não
existem mais (R2/R4): o store admin é incondicional no corte e a poda
`bad`/`lie` também. O rollback da fatia é **commit/imagem anterior**. Nenhuma
das duas afeta a BUSCA: são invalidação/observabilidade, e a lista continua
sendo servida pelo orquestrador.

---

## Ordem prática de trabalho

O que trava o quê:

- F-1.2/F-1.3 não dependem de F0 nem de F1 — são a mesma receita barata
  (módulo puro + golden + napi + casca TS) e podem andar em paralelo com F0 e
  com a F1.
- A sombra da F0 **só é honesta depois** que o orquestrador da F1 existir: sem
  ele não há "remontar a resposta", só um proxy que finge comparar.
- **F4.4 mudou o gate**: a sombra/canário comparavam com o `/stream` do Node,
  que saiu. O gate vigente é o corpus congelado (`parity:frozen`, 16/16) e o
  e2e (`stream_e2e_parity`, 51/51); não confundir smoke/`validate-docker.mjs`
  (só tocável) com paridade BR+cotas. Rollback do corte = imagem/commit
  anterior (não existe `GATEWAY=off`; o override de diagnóstico não muda a
  rota).
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
   `play_disposition` e as URLs/HMAC foram testadas offline nos cinco serviços.
   O `/resolve` é nativo e incondicional (fase C) e tem testes de
   contrato/fixtures; o play externo real por debrid **não** foi validado
   ponta a ponta nesta rodada (sem Docker).

---

## R — remoção do TS (R0–R8)

Série executada depois do F4.4 para apagar do branch o que o Rust já cobria.
Cada fatia é um commit e o branch ficou funcional em cada um. O rollback de
**todas** é **commit/imagem anterior**, não env: nenhuma das flags de fatia
citadas nas seções acima existe como knob hoje, e as que ainda aparecem neste
documento são registro histórico da execução.

### R.1 — O que saiu × o que ficou

| Área | Saiu (fatia) | Ficou |
|---|---|---|
| Lixo sem chamador | `fake-release.ts`, `seed-floor.ts`, `latest-writer.ts`, `config.search.packTail`, rota `/internal/search/state` (R0) | — |
| Corte `/stream` | modo `off`/`shadow`/`on` do `RUST_CORE`; `shadow.rs`/`canary.rs`; `STREAM_SHADOW_MODE`; `STREAM_CANARY_*`; `STREAM_FROZEN_*`; `stream-parity.mjs`/`stream-frozen*.mjs`; `utils/stream-frozen*.ts`, `stream-fresh.ts`, `collect-orchestrator-frozen.ts`, `routes/internal-search-config.ts` (R1); `shadowCrawlPage` (R7) | `/stream` do gateway na 7000 (`GATEWAY=on` + `ROUTES_RUST=stream`, fixos no compose desde o R8); o Node na 7100 responde 410 |
| Fontes e conta | `NodeCollector`, `SOURCES_RUST`, `ACCOUNT_RUST`, `POST /internal/search/collect`, `collect-orchestrator.ts` e o plano/janela TS (R5) | as cinco fontes nativas (jackett, prowlarr, torrentio, bludv, mico) e o inventário da conta, incondicionais; gateway sem fonte nativa montada é erro de boot |
| Índice e banco | `INDEX_RUST`, `BANK_RUST`, rotas `/internal/search/index`, `/internal/search/index-write` e `/internal/search/fallback`; `release-index`/`magnet-bank-*` TS (R4) | `idx:v14` e `magnets.db` com dono único no Rust; falha ao abrir degrada sem índice (log `[search]`, métrica `index.rust.source_missing`), nunca cai no Node |
| Metadados | `META_RUST` (R6) | metadados nativos como fonte primária; `POST /internal/search/meta` é o fallback vivo do Node (taxa de fallback não medida) |
| AllDebrid | `DEBRID_AL_RUST`, rota `/internal/debrid/check` (R3) | checagem/limpeza nativas e incondicionais; `DEBRID_AL_HOLDS`/`DEBRID_AL_CLEANUP` só como kill-switches das varreduras destrutivas |
| Store/trace | `STREAM_STORE_RUST`, `STREAM_BAD_RUST` (R2) | `STREAM_STORE_ADMIN_*` (API admin em 8711) e a poda `bad`/`lie`, incondicionais |
| Crawl | `shadowCrawlPage` e o modo do `RUST_CORE` (R7) | `CRAWL_ENGINE=rust` default; `CRAWL_ENGINE=ts` fica porque a suíte depende do loop TS; `captureCrawlPage`/`scrubCrawlPage` em `src/utils/crawl-capture.ts`; `RUST_CORE_PATH` |

### R.2 — Regra de rollback

Rollback de qualquer fatia é **commit/imagem anterior**. Não há `GATEWAY=off`,
`SOURCES_RUST=off`, `INDEX_RUST=off` nem similares; `ROUTES_RUST` vazio não é
rollback de produção — é diagnóstico do proxy, junto com `health`. O que
continua sendo env de operação:

- `ROUTES_RUST=` (vazio) e `ROUTES_RUST=health` — **diagnóstico do proxy**
  (nesses casos o `/stream` do Node responde 503, não 200);
- `docker-compose.gateway.yml` — só publica o Node em `127.0.0.1:7100`;
- `EFFECTS_RUST=off` (default ON) — desliga a emissão de efeitos;
- `DEBRID_AL_HOLDS`/`DEBRID_AL_CLEANUP` — kill-switches destrutivos;
- `STREAM_STORE_ADMIN_*`, `RUST_CORE_PATH` e `CRAWL_ENGINE`.

### R.3 — Gates que ficaram

| Gate | Comando | Estado |
|---|---|---|
| Paridade congelada | `npm run parity:frozen` (`cargo test -p adom-search --test stream_frozen_parity`) | 16/16, corpus em `rust/golden/stream-frozen/` |
| e2e do `/stream` | `cargo test -p adom-search --test stream_e2e_parity` | 51/51, corpus em `rust/golden/stream-e2e/` |
| Orçamento de metadados | `cargo test -p adom-search --test search_budget_metadata` | 7 testes; o porte segue parcial (ver "Verificação de ponta", item 3) |

Os gates de sombra/canário (`stream.shadow.*`, `stream.canary.*`) não existem
mais: não há oráculo Node para comparar. `validate-docker.mjs` continua sendo
só "tem stream tocável", não paridade BR+cotas.

### R.4 — O que ficou fora da remoção

- **Efeitos** (`EFFECTS_RUST`, default ON): o Rust emite, o Node executa as
  filas (`/internal/search/effects`).
- **Feed de holds** da AllDebrid (`/internal/debrid/holds`).
- **Banco VIVO** (`magnets.db`), `raw:v1` e `davail` — caminhos que a série R
  não moveu de dono.
- **Rotas internas vivas**: `POST /internal/search/meta`,
  `POST /internal/search/effects`, `POST /internal/debrid/holds`,
  `POST /internal/crawl-result` e `GET /internal/activity`.

## F4.7 — `/resolve` nativo (fases A e C entregues; incondicional)

**Fase A (`536f3c63`)**: o gateway resolve o play E grava
o que ele prova. O efeito sai pronto do núcleo (`resolve_effect`) e o Node o
aplica pela rota `POST /internal/resolve/effects` (loopback + token), com os
mesmos helpers do modo `DEBRID_RUST_SERVICES` (`applyResolveEffects`,
`applyPlayEffects`, `markAlive`). No erro o gateway espera a gravação (e o
flush do store nativo) antes do 404; no sucesso o 302 sai na hora. Na
AllDebrid o hold do autofetch vem de `POST /internal/resolve/facts` (antes era
`held:true` fixo); sem resposta, o play não apaga o frio. O `i` da dica volta a
ser lido. Prazo da ponte: `RESOLVE_EFFECTS_TIMEOUT_MS` (2 s).

**Teste real (Docker local, 2026-10-22)**:

| debrid | casos | resultado |
|---|---|---|
| AllDebrid | filme ⚡, pack S1E1, frio protegido pelo Chupim, frio sem hold | 302 + link 206; arquivo do episódio certo; protegido ficou na conta; sem hold apagou e gravou `davail=0` |
| Premiumize | 2 filmes ⚡, pack S1E1, 1 filme dublado | 302 + link MKV (`1a45dfa3`); `S01E01` escolhido no pack; +1 efeito por play |
| TorBox | — | **pendente** (falta a URL de instalação) |
| Real-Debrid, Debrid-Link | — | só fixtures |

Observado: um 502 passageiro (`kind=other`) na AllDebrid, que resolveu na
tentativa seguinte — suspeita de corrida com a limpeza nativa da busca, não
confirmada (o gateway só loga o tipo do erro).

**Fase C (concluída)**: o `/resolve` é nativo e incondicional no gateway. O
handler Node (`src/routes/resolve.ts`), o `respondWhenRustApplied` e o proxy
(`GATEWAY_RESOLVE_PROXY`) foram removidos; o gateway não encaminha mais o play
ao Node. Os `resolveLink`/`rust-remote` do Node FICAM: o `dub-audit` os usa.
Rollback passou a ser **commit/imagem anterior** — não há env que devolva a
rota ao Node.

Pendências de validação (não bloqueiam a fase C):
1. Teste real na TorBox; na Premiumize, o caso fora do cache (exige config sem
   `cachedOnly`).
2. Sem vídeo, dublagem falsa e episódio ausente só têm teste por fixture e de
   rota; validar no real quando aparecer um caso.

## Leva C1 — worker nativo do Chupim (2026-10-28)

Esta leva fecha as lacunas P1 do worker nativo do Chupim **sem** cumprir o flip
B4: os passos existem e compilam, mas o laço ainda não os chama e o TS do
Chupim continua dono desses fluxos. Base: `47e475fb` + a leva C1 (working tree
da branch `rust`).

### O que foi fiado

| Peça | O que entrou | Onde |
|---|---|---|
| Represa `sup:` | `suppressed_step` (drain, `DrainReport`, `register_factory`, `last`) e a rota `POST /autofetch/suppressed-drain` rodando o passo de verdade; o `GET /autofetch` publica `suppressed`, `suppressedSource` e `lastSuppressedDrain` | `autofetch/suppressed_step.rs`, `autofetch/routes.rs` |
| Porta `evict` | evicção por hash SÓ na AllDebrid (`/magnet/status` → `remove(id)`), guarda `may_delete` reutilizada, kill-switch duplo e teto por chamada | `adom-debrid/src/autofetch_ports_evict.rs` |
| Evicção F6 | política pura (`plan`, com veto final `may_delete`) + executor (`execute`, para no primeiro erro) sobre a régua do crate | `autofetch/evict_step.rs` (ainda fora do `mod.rs`) |
| Sonda `br_probe` | `plan`/`execute`/`settle`, `ProbeStepConfig`, `ProbeSkipReason`, lease `pending` e KV `autofetch:v3:probe:<sha256>` | `autofetch/probe_step.rs` |
| Season Pack Fill | `plan`/`plan_fill`/`execute`/`take`, `SEASON_PREFIX`, índice em KV com a chave lógica do TS | `autofetch/season_step.rs` |
| Crate | `v3::evict::execute`/`EvictReport`/`EvictStop` e as decisões puras de sonda e temporada | `adom-autofetch/src/v3/{evict,probe,season}.rs` |

### O que ficou pendente

1. **`evict_step` fora do binário.** O arquivo existe (com testes próprios), mas
   `autofetch/mod.rs` ainda não o declara: falta `mod evict_step;`. A fiação
   prevista é `serve.rs::timers`, depois de o recheck provar o ready BR.
2. **`probe_step` e `season_step` sem chamador.** Estão declarados com
   `#[allow(dead_code)]` e nenhum ramo do laço os chama. Como o canal JÁ aceita
   os dois kinds, o lote entra e é recusado por `enqueue::run` com
   `no-search-key` — e, depois do aceite, **não volta ao Node** (`Deferred` só
   existe antes do `submit`). Enquanto o ramo não existir, a sonda e o Season
   Pack Fill de produção continuam sendo os do TS.
3. **Fábrica do dreno não registrada.** `suppressed_step::register_factory` não
   é chamado no `boot::spawn_at`, então a rota responde `factory-unavailable`
   mesmo com `AUTOFETCH_WORKER=on`. É uma linha no boot.
4. **Flip B4 não feito.** O TS do Chupim (`src/providers/autofetch*.ts`,
   `src/debrid/alldebrid-fallback-evict.ts`) segue dono de sonda, Season Pack
   Fill, evicção de fallbacks, dreno no ciclo, `pf:`/`obra:` e
   `harvester_enqueue`. Regra: **não apagar o TS antes de fiar o substituto** —
   passo escrito não é passo consumido.
5. **Aceitação em produção** com duas contas de serviços diferentes, incluindo
   uma passagem de evicção com o kill-switch ligado e o dreno da represa pelo
   painel.
