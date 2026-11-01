# Corte do fallback de metadados — plano fino da fatia 3 (rota + providers TS)

> Plano registrado em 2026-10-31 (branch `rust` @ `0fdeaae9`). Refina o
> plano-gordo [`2026-10-30-corte-fallback-meta.md`](2026-10-30-corte-fallback-meta.md)
> (fatias 1–5) para o corte da rota `POST /internal/search/meta` e dos
> providers TS — e corrige âncoras que deslocaram ou estavam erradas lá
> (ex.: os providers vivem em `src/utils/`, NÃO em `src/providers/`;
> `src/providers/tmdb.ts` nunca existiu no histórico). Âncoras verificadas
> por leitura direta na data; números de linha deslocam com edição — confira
> o SÍMBOLO antes de cortar, não só a linha. Nada aqui executa nada.
>
> **A pré-condição destravou** (commit `23d17b0f`, "feat(rust): contadores
> meta persistem no KV nativo"): os contadores `meta.*` agora sobrevivem ao
> deploy (`metam:v1:counts`, flush por minuto, reidratação no boot) e a
> janela ≥ 48h passa a contar de verdade no próximo deploy.

---

## 1. Mapa do fallback hoje

### 1.1 Lado Rust — quem chama `POST /internal/search/meta`

```text
rust/crates/adom-server/src/stream.rs:132-137
  → NodeRoutes::from_env() → Some(routes) → stream_meta::meta_source(Some(routes))
    (comentário C5: "fonte nativa de metadados, com o Node de FALLBACK")
rust/crates/adom-server/src/stream.rs:148-157
  → o MESMO `routes` alimenta o tail/efeitos (NativeTailEffects) e
    with_internal_routes(routes) — NÃO derrubar junto (risco nº 1)
rust/crates/adom-server/src/stream.rs:162-168
  → ramo `None` JÁ EXISTE: sem rotas Node, meta_source(None) — modelo vivo
    do "sem fallback"
rust/crates/adom-server/src/stream_meta.rs:25-40
  → meta_source(): nativo primário (:44-63, MetaSources + MetaCacheStore no
    MESMO cache.db do Node, mesmas chaves `meta:`/`tmdb:`/`tmdbc:`/`tmdbh:` —
    doc :5-6); com rotas: FallbackMetaSource::new(native, node) na :39
rust/crates/adom-search/src/internal_client.rs:63-67
  → InternalSearchClient::meta() = POST /internal/search/meta
    (base 127.0.0.1:7100 na :22, teto 15s na :24; token no header
    X-Indexer-Test-Token e `encoded` no corpo — invariante 5;
    from_env :46-57; ensure_loopback :127-153)
rust/crates/adom-search/src/orchestrator/internal_routes.rs:59-61
  → NodeRoutes::from_env (None sem token); :64-67 impl InternalRoutes::meta
rust/crates/adom-search/src/orchestrator/meta.rs:164-186
  → NodeMetaSource — ÚNICO chamador de `routes.meta` no orquestrador
    (:180; grep confirmado em adom-search inteiro)
rust/crates/adom-search/src/orchestrator/meta_native.rs:107-112, :147-200
  → FallbackMetaSource::resolve: primário nativo; nome vazio → incomplete;
    has_real_title :142-145; contadores só aqui dentro (:150-194)
```

Onde os contadores nascem e onde o pior caso já vive sem fallback:

```text
rust/crates/adom-search/src/orchestrator/meta_metrics.rs:20-33
  → RESOLVE_TOTAL "meta.resolve.total" (denominador), NATIVE_OK/INCOMPLETE/ERROR,
    FALLBACK_USED/EMPTY/ERROR — os 7 nomes
rust/crates/adom-server/src/main.rs:24,:83
  → meta_metrics_flush::spawn_from_env() no boot (reidrata + flush por minuto)
rust/crates/adom-server/src/meta_metrics_flush.rs:29-31,:44,:85-100
  → chave única `metam:v1:counts` (permanente, ttl<=0), FLUSH_INTERVAL 60s,
    fail-open; reidratação restore_from_kv :68-81
rust/crates/adom-server/src/proxy.rs:75-76
  → GET /metrics publica os 7 contadores (meta_metrics_snapshot)
rust/crates/adom-server/src/proxy.rs:306-308
  → is_internal_path: a fachada recusa /internal/* ANTES do proxy (o Caddy
    também bloqueia) — continua valendo depois do corte (efeitos seguem)
rust/crates/adom-search/src/orchestrator/respond.rs:12
  → NOTICE_SEARCHING ("Procurando fontes — reabra em instantes") — a resposta
    de degradação quando nativo falha e não há fallback; usada em route.rs:98
rust/crates/adom-search/src/orchestrator/frozen_gate/replay.rs:46
  → o replay do golden e2e usa NodeMetaSource com rotas CONGELADAS em memória
    (frozen_routes) — NÃO bate na rota Node; não bloqueia o corte
```

### 1.2 Lado Node — o que a rota faz

```text
src/routes/register.ts:6,:66
  → import { registerInternalSearch } from './internal-search.js' e montagem
    antes do overlay /:userConfig
src/routes/internal-search.ts:115-135
  → registerInternalSearch: monta POST /internal/search/meta (:126-129, com
    rejectedByGuard na :127) e chama registerInternalSearchEffects na :134
src/routes/internal-search.ts:50-109 (handleMeta)
  → decodeTarget do `encoded` (:57); valida type/id (/:60-64, parseStremioId);
    prazo clientReplyDeadline (:68-69); runtime.run + withinDeadline (:73-84);
    Promise.all getMeta+getTitles (:77); opt-ins multiwork/homeRelease (:79-82);
    resposta {ok,type,id,imdb_id,season,episode,meta,titles,multiWork?,homeReleaseAt?}
    (:91-102); 504 DEADLINE (:86-89); 500 no catch (:103-108)
src/routes/internal-search.ts:31
  → re-export de isLoopbackAddress (definida em internal-search-shared.ts:19);
    único consumidor do re-export é o teste que morre junto
    (test/internal-search-routes.test.ts:17)
src/routes/internal-search-shared.ts (FICA — a rota de efeitos usa)
  → rejectedByGuard :28-42 (403 loopback / 503 sem token / 401 token errado),
    decodeTarget :47-54, withinDeadline :57-59, DEADLINE :16
src/routes/internal-search-effects.ts:153-160
  → registerInternalSearchEffects(router, services) — FICA; monta
    /internal/search/effects na :156 (mesma assinatura da troca em register.ts)
```

### 1.3 Providers TS — o que fazem de vivo e quem importa

Módulos e tamanho atual (contado no leitor de arquivos, 2026-10-31):

| Módulo | Linhas | Vida hoje |
|---|---|---|
| `src/utils/cinemeta.ts` | 173 | `getMeta` :95-170 (único export :172): GET `v3-cinemeta` (:114), chave `meta:{tipo}:{imdb}` (:96), miss negativo (:12-17, :150, :158-161), marca de schema v2 (:78-79), `episodes` por temporada (:132), `episodeAired` por episódio (:144), TTL 86400 (:147), métrica `meta.cinemeta.miss.served` (:100) |
| `src/utils/tmdb.ts` | 324 | `getTitles` :103-213 + `getCollection` :299-321 (exports :323): `/find` pt-BR (:130-133), 2ª `/find` en-US `fetchEnglishTitle` (:38-60 — título canônico, NUNCA `original_*` :29-31; recall 12 vs 43 :25-26), aliases BR (:167), chave `tmdb:` (:106), coleção `tmdbc:` (:215, :301), `readCollection` find→movie→collection (:248-288), TTL longo só com consultas ok (:179-186), métrica `meta.tmdb.miss.served` (:110) |
| `src/utils/tmdb-br-aliases.ts` | 81 | `fetchBrAliases` (rede, :52-78) + `filterBrAliases` (:36 — decisão INTEIRA no núcleo, `adom-core::tmdb_br_aliases`) |
| `src/utils/tmdb-home-release.ts` | 84 | `getHomeReleaseAt` :50-75 (rede), `peekHomeReleaseAt` :78-81 (**sem chamador — órfão**), `earliestHomeRelease` :36-46; prefixo `tmdbh:` (:19) |
| `src/providers/tmdb-multiwork.ts` | 66 | `startMultiWorkDiscovery` :31-45 (flag+filme+debrid :42), `startHomeReleaseLookup` :52-57, `resolveMultiWork` :59-63 |
| `src/utils/multiwork-pack.ts` | 137 | wrapper fino do napi (`adom_core::multiwork_pack`, comentário :24-26): `collectionRoot` :73-75, `collectionRootTokens` :68, `coversYear` :82, `packYearSource` :91, `admitsMultiWorkPack` :113-127, `COLLECTION_NOISE` :36-42 |

Grep completo de imports (caminhos relativos incluídos; `src/`, `test/`,
`scripts/` — 2026-10-31):

```text
cinemeta.js  → src/routes/internal-search.ts:21 (getMeta)
              | test/episode-size.test.ts:18 · test/observability.test.ts:9
              | test/meta-cache.test.ts:12 · test/episode-size-meta-update.test.ts:5
              | test/cinemeta.test.ts:13
tmdb.js      → src/routes/internal-search.ts:22 (getTitles)
              | src/providers/tmdb-multiwork.ts:3 (import * as tmdb → getCollection :44)
              | test/observability.test.ts:10 · test/tmdb.test.ts:13
              | test/tmdb-english-title.test.ts:17 · test/tmdb-br-aliases.test.ts:13
              | test/meta-cache.test.ts:13 · test/multiwork-pack.test.ts:27 (getCollection)
tmdb-multiwork.js    → src/routes/internal-search.ts:23 (:80-81) · test/multiwork-pack.test.ts:26
tmdb-home-release.js → src/providers/tmdb-multiwork.ts:4 (:56) · test/non-feature-release.test.ts:9
tmdb-br-aliases.js   → src/utils/tmdb.ts:6 (:167) · test/tmdb-br-aliases.test.ts:14
multiwork-pack.js    → src/utils/tmdb.ts:5 (:283 collectionRoot) · test/multiwork-pack.test.ts:21-22
```

Não-consumidores (falso positivo do grep): `src/utils/search-names.ts:101-103`
é COMENTÁRIO (sem import); `src/utils/release-filters.ts:24` e
`types/domain.d.ts:408` são docs de campo.

## 2. O que é cortável e o que fica

### 2.1 Cortável (a fatia inteira)

- **Lado Rust**: o wiring do fallback — `meta_source(Some(routes))` em
  `stream.rs:137`, `FallbackMetaSource` (`meta_native.rs:107-200`) e o método
  `meta()` de `internal_client.rs:63-67` (só servia ao fallback; o
  `InternalSearchClient` e `NodeRoutes` FICAM para os efeitos).
- **Lado Node**: a rota — `src/routes/internal-search.ts` inteiro (136 l) e a
  troca do ponto de montagem em `register.ts:6,:66`.
- **Providers TS**: os 6 módulos da tabela §1.3 (865 linhas; com a rota,
  ~1.001).
- **Config**: `tmdb()` (`src/config/providers.ts:70-88`) e `cinemeta()`
  (:90-102); import/composição em `src/config.ts:16,:38-39`.
- **Testes órfãos** e cotas/tooling: ver §4 (passos 3-4).

### 2.2 Fica

- **O tail de efeitos**: `NodeRoutes::from_env`
  (`internal_routes.rs:59-61`), `InternalSearchClient` (`effects` em
  `internal_client.rs:70-73`), `with_internal_routes` (`stream.rs:157`,
  `mod.rs:333`) e a rota Node `registerInternalSearchEffects`
  (`internal-search-effects.ts:153-160`) com os irmãos compartilhados
  (`internal-search-shared.ts`).
- **O primário nativo**: `NativeMetaSource` + `meta_from_lookup`
  (`meta_native.rs:43-99, :204-269`) e `MetaCacheStore` no mesmo `cache.db`
  (`stream_meta.rs:44-63`) — mesmas chaves/valores do Node, o cache não esfria
  e não há migração de chave.
- **`NodeMetaSource`/`meta_from_response`** (`meta.rs:152, :164-186`): o
  replay do frozen gate passa por eles (`frozen_gate/replay.rs:46`) — com
  rotas congeladas, sem rede.
- **Os contadores `meta.*` e o flush**: `meta_metrics.rs`, `meta_metrics_flush.rs`
  e a guarda `'metam:v1:'` em `RUST_OWNED_PREFIXES`
  (`src/utils/cache-keys.ts:353-359`) — após o corte eles medem o nativo
  sozinho; a aposentadoria deles é OUTRA fatia, depois da decisão.
- **Envs `CINEMETA_*`/`TMDB_*`/`SEARCH_PRE_HOME_RELEASE_*` no `.env`/`.env.example`**:
  o Rust lê as MESMAS (`adom-sources/src/config.rs:123-165` —
  `CINEMETA_TIMEOUT_MS` :139, `TMDB_API_KEY` :146, `TMDB_TIMEOUT_MS` :147,
  `TMDB_CACHE_TTL` :148, `TMDB_UNLOCALIZED_TTL` :149, `TMDB_MISS_TTL` :150,
  `TMDB_TRANSIENT_MISS_TTL` :151, `TMDB_COLLECTION_TIMEOUT_MS` :152,
  `SEARCH_PRE_HOME_RELEASE_TTL/_CUT` :153-158).
- **`cache-keys.ts` NÃO MUDA**: `meta:`/`tmdb:`/`tmdbc:`/`tmdbh:` não estão em
  `NAMESPACE_VERSIONS` nem em `RUST_OWNED` (`cache-keys.ts:26, :245-248`);
  `cache-db.ts:116-118` só varre versionados no boot, e o load :127-135 usa
  `namespaceFor`+`quotaFor` — sem entrada, caem no `__default` (500), mesmo
  teto de hoje.
- **Goldens e corpora do núcleo**: `rust/golden/tmdb-br-aliases.*`,
  `rust/golden/multiwork-pack.*` e `scripts/golden/corpus-tmdb-br-aliases.json`
  / `corpus-multiwork-pack.json` — são `include_bytes!`/`include_str!` dos
  testes de integridade do `adom-core`
  (`rust/crates/adom-core/tests/tmdb_br_aliases_golden.rs:19-21`,
  `multiwork_pack_golden.rs:19-21`) e os hashes validados são os do
  `.jsonl`/corpus (:64-68), NÃO do arquivo TS. Apagar o TS não quebra
  `cargo test`.

### 2.3 Consumidores fora do fallback (o que mudaria o escopo)

**Não existe nenhum.** Grep completo (§1.3): todo consumidor de runtime de
`cinemeta.ts`/`tmdb.ts` é a rota do fallback ou módulo que só a rota consome
(`tmdb-multiwork.ts`, `tmdb-home-release.ts` via `tmdb-multiwork`,
`tmdb-br-aliases.ts` via `tmdb.ts`, `multiwork-pack.ts` via `tmdb.ts`). Os
demais consumidores são testes. Consequências:

- O corte é COMPLETO — nenhuma fatia parcial necessária, nada bloqueia.
- `peekHomeReleaseAt` (`tmdb-home-release.ts:78-81`) já é código órfão hoje
  (o AGENTS.md:768 cita o build TS do passado; o build é nativo) — morre junto.
- `multiwork-pack.ts` é "vocabulário exportado" (régua napi), mas a decisão
  mora no núcleo e o golden cobre (`multiwork_pack_golden.rs`); os exports
  `collectionRootTokens`/`coversYear`/`packYearSource`/`admitsMultiWorkPack`
  só têm consumidor de teste (`test/multiwork-pack.test.ts:21`).
- O único consumidor indireto que sobrevive ao corte é o replay do frozen
  gate (rotas congeladas) e a CAPTURA de goldens novos:
  `scripts/golden/capture-stream-e2e.mjs --with-internal` captura
  `inputs/meta.json` batendo na rota (:76, :391, :554-568; lacuna declarada
  na :101) — risco 5 de §6.

## 3. Critério de decisão (janela e limiar)

- **Instrumento**: `/metrics` do gateway, contadores
  `meta.resolve.total` (denominador), `meta.native.ok/incomplete/error`,
  `meta.fallback.used/empty/error` (`meta_metrics.rs:20-33`).
- **Persistência (a novidade de `23d17b0f`)**: snapshot inteiro em
  `metam:v1:counts` (KV nativo, permanente) a cada 60 s
  (`meta_metrics_flush.rs:29-31, :44`) e reidratação no boot (:68-81,
  chamado em `main.rs:83`). Recriar container NÃO zera mais a janela.
- **Invalidadores da janela** (recomeçam de zero, fail-open):
  `cache.clear()` do painel trunca a tabela inteira e leva a linha junto
  (`meta_metrics_flush.rs:13-15`); KV indisponível (:69-72). A leitura
  falha só loga (:73-79, :95-97).
- **Coleta** (porta do gateway só loopback; rodar na VPS):

  ```bash
  ssh jcn@200.23.180.38 "curl -s http://127.0.0.1:7000/metrics | grep 'meta\.'"
  ```

- **Janela sugerida**: mínimo 48 h contínuas (plano-gordo §1) — recomendado
  5-7 dias para cobrir a variação semanal do catálogo. O relógio começa no
  deploy que trouxe `23d17b0f`.
- **Limiar de corte** (sobre a janela inteira; proporção de
  `meta.resolve.total`):
  - `meta.fallback.used` < 0,5% — o pior caso que a fatia remove;
  - `meta.native.error` < 1% — se alto, o fallback está mascarando falha de
    rede do primário; consertar o primário ANTES de cortar (sem fallback,
    erro do primário vira `NOTICE_SEARCHING`, `respond.rs:12`);
  - `meta.fallback.empty + meta.fallback.error` < 0,5% — o Node quase nunca
    acrescenta nem no que devolve.
- **Limitação da medida**: os contadores são agregados O(1) sem série
  temporal — registrar leituras diárias na tabela do relatório da fatia
  (data, total, usados, vazios, erros) em vez de confiar só no acumulado.

## 4. Passos de corte (ordenados; um commit por passo, gates verdes)

**O passo 0 fecha a janela ANTES do passo 1 — depois do passo 1 os contadores
congelam** (só existem dentro de `FallbackMetaSource::resolve`,
`meta_native.rs:150-194`; com `meta_source(None)` nada incrementa).

### Passo 0 — medir e decidir (sem código)

Coleta diária dos `meta.*` (comando §3), tabela no relatório, decisão pelos
limiares. Pré-condição de TUDO o que vem abaixo.

### Passo 1 — Rust DESLIGA o fallback (não apaga nada)

- `rust/crates/adom-server/src/stream.rs:137`: trocar
  `meta_source(Some(routes.clone() as Arc<dyn InternalRoutes>))` por
  `meta_source(None)`. O ramo `None` da :162-168 é o modelo vivo; sem
  fallback o comportamento de pior caso já existe: `meta_load` deriva
  metadados do próprio id e `respond.rs` devolve `NOTICE_SEARCHING` (:12,
  usada em `route.rs:98`).
- **INTACTOS**: `NodeRoutes::from_env` (:132), o tail/efeitos (:148-157) e
  `with_internal_routes` (:157) — o MESMO `routes` serve os efeitos.
- Validar: boot do gateway sem erro de fonte (`build_orchestrator_from`
  exige fonte nativa, `stream.rs:118-124`); `/stream` devolve título nativo
  ou `NOTICE_SEARCHING` quando o nativo falha; efeitos seguem fluindo (202
  do `/internal/search/effects`); `meta.*` congelam no `/metrics` (esperado).
- Gates: `cargo test -p adom-search --test search_budget_metadata`
  (invariante 1, AGENTS.md:672-674), `cargo test` dos crates tocados,
  `npm run parity:frozen` (`package.json:77`), imagem + `validate-docker`.

### Passo 2 — Rust APAGA o fallback

- Apagar `FallbackMetaSource` (`meta_native.rs:107-200`) e os testes dele
  (mapear `meta_native_tests.rs`/`meta_corpus_tests.rs` na execução — o
  corpus que exercita `meta_from_lookup` FICA com o `NativeMetaSource`).
- **MIGRAR os contadores** `meta.resolve.total`/`meta.native.*` para o
  `NativeMetaSource::resolve` no MESMO commit: hoje só o
  `FallbackMetaSource::resolve` incrementa (`meta_native.rs:150, :156, :158,
  :163, :180`) — sem a migração o `/metrics` fica CEGO no commit crítico.
- `FALLBACK_*` sai de `meta_metrics.rs` (:29-33, `KEYS` :35-43; o `restore`
  descarta chave fora de `KEYS`, :79-85 — contador aposentado não reaparece).
- `meta()` de `internal_client.rs:63-67` morre (únicos chamadores eram
  `NodeRoutes::meta` → `NodeMetaSource`, e o replay usa rotas congeladas).
- **FICAM**: `NodeMetaSource`/`meta_from_response` (`meta.rs:152, :164-186`)
  — replay do frozen gate (`frozen_gate/replay.rs:46`).
- Validar: `/metrics` publica `meta.*` com o novo dono; `cargo test`;
  `parity:frozen`.

### Passo 3 — Node: a rota

- `src/routes/register.ts:6`: trocar o import para
  `registerInternalSearchEffects` de `./internal-search-effects.js`;
  `src/routes/register.ts:66`: trocar a chamada (mesma assinatura,
  `internal-search-effects.ts:153`).
- Apagar JUNTOS: `src/routes/internal-search.ts` (136 l) +
  `test/internal-search-routes.test.ts` (187 l; importa :15-19, monta :53).
- **Consumidor que o plano-gordo não listou**: 
  `test/internal-search-effects.test.ts:20` importa `registerInternalSearch`
  e monta com ele (:54, :67) — trocar para `registerInternalSearchEffects`
  (o teste prova o fio da rota de efeitos, não o meta).
- `internal-search-shared.ts` FICA (efeitos usa :17); o re-export
  `isLoopbackAddress` de `internal-search.ts:31` morre com o arquivo —
  único consumidor era o teste apagado (:17). Aproveitar para arrumar o
  comentário defasado do cabeçalho de `internal-search-shared.ts:3-4`
  ("rotas de leitura (meta/state/collect)" — essas rotas já não existem).
- `scripts/validate-docker.mjs:181-212`: as três checagens da rota meta saem
  ou mudam de alvo — a checagem "de fora → recusado" (:181-201) pode apontar
  para `/internal/search/effects` (mesma guarda, `proxy.rs:306-308` recusa
  antes do proxy); a checagem "de dentro → 200" (:206-212) some.
- `package.json:299`: remover `test/internal-search-routes.test.js` da lista
  `testFiles`.
- Gates: `npm run typecheck` (ZERO), `npm test` (roda `dist/`) +
  `npm run test:complete` (lista em dia), `npm run lint:lines`.

### Passo 4 — Node: providers, config, cotas e tooling

Apagar módulos (865 linhas) + testes inteiros, e tirar da lista
`testFiles` (`package.json`):

```text
src/utils/cinemeta.ts            (173l)  test/cinemeta.test.ts                  (:174)
src/utils/tmdb.ts                (324l)  test/tmdb.test.ts                      (:374)
src/utils/tmdb-br-aliases.ts     ( 81l)  test/tmdb-br-aliases.test.ts           (:372)
src/utils/tmdb-home-release.ts   ( 84l)  test/tmdb-english-title.test.ts        (:373)
src/providers/tmdb-multiwork.ts  ( 66l)  test/meta-cache.test.ts                (:318)
src/utils/multiwork-pack.ts      (137l)  test/multiwork-pack.test.ts            (:321)
                                         test/episode-size-meta-update.test.ts  (:263)
```

Testes PARCIAIS (arquivo fica, casos saem):

- `test/observability.test.ts:9-10` — os testes de miss servido
  (`meta.cinemeta.miss.served`/`meta.tmdb.miss.served`) morrem com as
  métricas; remover os casos e os imports, manter o resto do arquivo.
- `test/episode-size.test.ts:18` — `getMeta` é fixture; trocar por stub
  inline (o teste usa `helpers/stub.ts:19` para isso).
- `test/non-feature-release.test.ts:9` — `earliestHomeRelease` é função pura
  inline; mover os casos para o oráculo (`test/helpers/pipeline-oracle/`) ou
  apagar — a regra nativa vive em `adom-sources/src/tmdb/home_release.rs`.

Config:

- `src/config/providers.ts:70-88` (`tmdb()`) e `:90-102` (`cinemeta()`) saem;
  `src/config.ts:16` (import) e `:38-39` (composição) saem.
- `.env.example` NÃO perde as envs — o Rust as lê (§2.2). O comentário
  :1492-1499 (que descreve o fallback vivo) é da fatia de docs (passo 5).

Cotas (cuidado com golden):

- `src/utils/cache-quotas.ts`: entradas `tmdb: 500` (:55), `tmdbc: 500`
  (:60), `meta: 500` (:61) são as únicas referidas por estes módulos
  (`tmdbh:` nunca teve cota — cai no `__default`, :154/:168-170). Apagar as
  três exige: recontar o universo do cabeçalho (:14-21, hoje 87.221+500) e
  atualizar a dívida conhecida (:45-51). ALTERNATIVA conservadora (sem
  regeneração de golden): deixar as cotas — sem escritor no Node elas ficam
  inertes e o teto efetivo não muda (sem entrada, `__default` = 500 igual).
  O `golden:cache-quotas` (`package.json:61-62` → `scripts/golden/gen-cache.mjs`)
  pinna `rust/golden/cache-quotas.{jsonl,manifest.json}` com hash da FONTE e
  do artefato (`gen-cache.mjs:13-14`) — mexeu na tabela, regenerar com
  `--force` (nunca editar o `.jsonl` à mão); `rust/golden/cache-keys.*` não
  muda (nada a fazer em `cache-keys.ts`).

Tooling órfão (limpeza):

- `scripts/golden/gen-multiwork-pack.mjs` + `scripts/golden/registry-multiwork-pack.mjs`
  ficam SEM alvo (hash da fonte `src/utils/multiwork-pack.ts` —
  `registry-multiwork-pack.mjs:20`): apagar no mesmo commit.
- `scripts/golden/tmdb-br-aliases-oracle.mjs` FICA como proveniência
  (padrão de `docs/RUST-CONTRATOS.md:256` — o runner do oráculo vive aqui,
  o dump é do branch `esm`).
- `scripts/golden/corpus-tmdb-br-aliases.json` e
  `corpus-multiwork-pack.json` FICAM (include_str! dos testes do núcleo,
  §2.2).

Gates do passo: typecheck/test/test:complete/lint:lines +
`npm run golden:cache-quotas:check` (se cotas mudaram) + `cargo test -p
adom-core` (goldens de `multiwork-pack`/`tmdb-br-aliases` intactos).

### Passo 5 — docs e contratos

Reconciliar (verificar linha a linha antes — o arquivo anda):

```text
AGENTS.md                    :229-243 (fluxo: "metadados em fallback"),
                             :266 (diagrama), :715 (tabela Busca)
docs/AGENTS-DETALHADO.md     :226
docs/RUST-CONTRATOS.md       :291
docs/rust-stream-contract.md :39 e :876
docs/migracao-stream-rust.md :172
.env.example                 :1492-1499 (comentário do fallback vivo)
rust/golden/stream-e2e/README.md :186 (nota do --with-internal/meta.json)
```

## 5. Rollback

Padrão do projeto para TODAS as fatias: **commit/imagem anterior, não env**
(AGENTS.md:172-176; o mesmo padrão de `HARVEST_OWNER` inexistente,
AGENTS.md:580). Nada de kill-switch novo (`META_FALLBACK=on` seria segundo
dono — não criar).

- Passo 1: reversível numa linha (reverter o argumento de `meta_source`);
  rollback do passo 2.
- Passos 2-4: `git revert` do commit devolve o código apagado (o estado
  revertido é o validado pelos gates do passo anterior) + rebuild da imagem.
- A cada passo, o deploy anterior é a imagem de volta (o `cache.db`
  sobrevive; as chaves `meta:`/`tmdb:`/`tmdbc:`/`tmdbh:` são escritas pelo
  nativo nos dois lados — sem migração, sem esfriar).
- `metam:v1:counts` sobrevive a qualquer rollback (namespace `RUST_OWNED`,
  `cache-keys.ts:359`) — a janela de medição não perde o acumulado.

## 6. Riscos

1. **Risco nº 1 — o tail**: o MESMO `NodeRoutes`/`InternalRoutes` que alimenta
   o fallback serve os efeitos (`stream.rs:137` vs `:148-157`); derrubar o
   tail junto é o erro que o passo 1 existe para evitar. Teste mínimo: 202
   do `/internal/search/effects` depois de cada passo Rust.
2. **`meta.native.error` vira o único sinal**: sem fallback, erro do primário
   é `NOTICE_SEARCHING` para o usuário (`respond.rs:12`). Medir
   `meta.native.error / meta.resolve.total` na janela ANTES (limiar §3) e
   vigiar depois do passo 1.
3. **Séries**: o fallback devolvia `episodes`/`episodeAired` que alimentam o
   teto de episódio recente e a média de pack (`cinemeta.ts:132, :144`); o
   nativo devolve o equivalente (`episode_aired` em `meta_native.rs:14-16,
   :241-247, :258`). Antes do passo 2, conferir no corpus
   (`meta_corpus_tests.rs`) que os casos de série cobrem o gate
   `has_real_title` (`meta_native.rs:142-145`).
4. **Título canônico en-US**: a 2ª `/find` do TS (`tmdb.ts:38-60`, recall
   12 vs 43) tem equivalente nativo no `adom-sources` (`lib.rs:14-18` —
   títulos en/pt/original + aliases BR). Confirmar que o caso-motivo
   (original não-inglês, ex. "Se sei vivo spara", `tmdb.ts:23-26`) está no
   corpus nativo antes de apagar.
5. **Captura de goldens `--with-internal`**: casos novos não terão
   `inputs/meta.json` (`capture-stream-e2e.mjs:101, :554-568`;
   `stream_e2e_parity/part2.rs:231` manda recapturar). Decidir ANTES do
   passo 3: lacuna documentada (o replay usa o que há) ou captura nativa do
   metadado — não descobrir no passo 5 (mesmo risco 2 do plano-gordo).
6. **Golden de cotas**: mexer em `cache-quotas.ts` sem regenerar
   `rust/golden/cache-quotas.*` quebra o `--check` (hash da fonte,
   `gen-cache.mjs:13-14`) e o CI de goldens (`.github/workflows/rust.yml`
   consome `rust/golden/**`). Na dúvida, não mexer (alternativa §4).
7. **`validate-docker.mjs` vermelho**: as checagens da rota meta (:181-212)
   falham após o passo 3 se não forem atualizadas no MESMO commit — a
   validação de container é gate de deploy.
8. **Não apagar a medição nesta fatia**: `meta_metrics_flush.rs`,
   `metam:v1:counts` e a guarda `'metam:v1:'` (`cache-keys.ts:359`) ficam —
   é o termômetro pós-corte. A aposentadoria é fatia própria, depois de
   decidir que os números já não dirigem nada.
9. **Cache não esfria, mas confirme o formato**: o nativo grava as mesmas
   chaves/valores (`stream_meta.rs:5-6`); não renomear chave nem bump de
   namespace nesta fatia — `cache-db.ts:116-118` apaga linha que não bata
   com a versão dos versionados, e `meta:`/`tmdb:` vivem fora deles
   (dívida :45-51 de `cache-quotas.ts`).
10. **Corpora são intocáveis**: `corpus-tmdb-br-aliases.json` /
    `corpus-multiwork-pack.json` são `include_str!` de testes Rust
    (`tmdb_br_aliases_golden.rs:21`, `multiwork_pack_golden.rs:21`) — apagar
    quebra `cargo test` mesmo com o TS fora.

## 7. Ordem e resumo

```text
janela medida (passo 0) → 1 Rust desliga → 2 Rust apaga (contadores migram)
→ 3 rota Node + efeitos-test + validate-docker → 4 providers + config + cotas
→ 5 docs
```

Cada passo é o rollback do seguinte; a janela fecha no passo 0 e os contadores
congelam a partir do passo 1 — nada de decidir depois de começar.

## Leituras (passo 0)

> Leitura por SSH só-leitura na VPS (`jcn@200.23.180.38`): `git log`,
> `docker ps`/`inspect`, `tail`/`grep` do `/home/jcn/adom-deploy.log` e `curl
> GET http://127.0.0.1:7000/metrics` (loopback, dentro do servidor). Nada foi
> escrito na VPS; nada commitado.

### Leitura de 2026-11-01 03:21 (-03:00)

Estado do deploy:

| Item | Valor |
|---|---|
| Commit em produção | `cdfa3eba` (2026-10-31 15:03:37 -03:00, "refactor(debrid): módulos TS sem uso em produção vão para o oráculo") |
| Deploy mais recente no log | 2026-11-01 01:45:03 `cdfa3eba` (de `0fdeaae9`), fim 02:30:28; depois disso o log só registra `fetch` sem commit novo |
| Commit da pré-condição | `23d17b0f` entrou pelo deploy de `0fdeaae9` — 2026-10-31 03:05:03, build concluído 03:50:18 (`merge-base --is-ancestor` confirma; o commit anterior, `409d5a55`, é de 10-30 14:00, antes do commit existir) |
| Container | `stremio-adom` Up ~50 min (healthy); `StartedAt` 2026-11-01T05:30:19Z (02:30:19 -03:00); `RestartCount=0`, `OOMKilled=false`, `ExitCode=0` |
| Reinício de relógio? | Não — a recriação de 02:30 não zerou os contadores: o boot loga `[gateway] meta.* restaurado do deploy anterior` (reidratação de `metam:v1:counts`) |

Contadores (`/metrics`, 2026-11-01 03:21 -03:00):

| Contador | Valor |
|---|---|
| `meta.resolve.total` | 25 |
| `meta.native.ok` | 25 |
| `meta.native.incomplete` | 0 |
| `meta.native.error` | 0 |
| `meta.fallback.used` | 0 |
| `meta.fallback.empty` | 0 |
| `meta.fallback.error` | 0 |

Bônus da mesma leitura (fora do alvo): `debrid.al.cleanup.planned` 275 /
`removed` 174 / `failed` 101, `debrid.al.cleanup.suppressed.inventory_missing`
1, `debrid.al.holds.ok` 12, `debrid.al.native.checks` 12. `stream.cache.*` NÃO
existe no `/metrics` (moram na admin 8711, `GET /streams/stats`).

Derivação:

- Relógio da leitura: 2026-11-01 03:21 -03:00. Início da janela: primeiro boot
  com persistência, 2026-10-31 ~03:50 -03:00 (fim do build do deploy que
  trouxe `23d17b0f`).
- Janela decorrida: **~23 h 31 min** (24 h 25 min contados do commit
  `23d17b0f`, 02:55:41; 24 h 16 min do início do deploy, 03:05:03). Faltam
  ~24 h 30 min para 48 h (fecharia 2026-11-02 ~03:50).
- Taxas sobre `meta.resolve.total`=25: primário nativo ok **100%** (25/25);
  `native.incomplete` 0%; `native.error` 0% (limiar <1% §3);
  `fallback.used` 0% (limiar <0,5%); `fallback.empty+error` 0% (limiar
  <0,5%).

Limites desta leitura (o que não foi validado):

- Contadores são agregados O(1) sem série temporal: não há como provar
  retroativamente que nenhum `cache.clear()` do painel truncou
  `metam:v1:counts` dentro da janela (invalidador §3).
- A reidratação foi confirmada pela linha de log de boot; o conteúdo exato da
  linha KV não foi lido (leitura direta do `cache.db` ficou fora do escopo
  só-leitura acordado — só ssh/git/docker ps/inspect/cat/curl GET).
- O volume absoluto (`resolve.total`=25) é plausível para o tráfego desta
  instância (o caminho rápido do orquestrador dispensa meta), mas não há
  medida independente de requisições para cruzar.

**Veredito: JANELA ABERTA** — ~23 h 31 min decorridas (< 48 h; o §3 recomenda
5-7 dias). Registrar e seguir coletando: os limiares já são atendidos com
folga nos parciais, mas a decisão do passo 0 só fecha com a janela completa.
Os passos 1-5 permanecem travados até lá.

### Leitura de 2026-11-01 14:51 (-03:00)

Mesma rotina só-leitura (`date`, `git log`, `docker inspect`, `tail` do
`adom-deploy.log` e `curl GET /metrics` em loopback).

Estado do deploy:

| Item | Valor |
|---|---|
| Commit em produção | `cdfa3eba` (2026-10-31 15:03:37 -03:00) — **sem mudança** desde a leitura anterior |
| Deploy mais recente no log | só linhas `FETCH_HEAD`; nenhum checkout/build novo desde o de 01:45 (fim 02:30) |
| Container | `stremio-adom` `StartedAt` 2026-11-01T05:30:19Z (02:30:19 -03:00), `healthy`, `RestartCount=0`, `OOMKilled=false`, `ExitCode=0` |
| Reinício de relógio? | Não — o processo é o mesmo da leitura anterior e os contadores não zeraram |

Contadores (`/metrics`, 2026-11-01 14:51 -03:00):

| Contador | Valor | Δ vs 03:21 |
|---|---|---|
| `meta.resolve.total` | 25 | 0 |
| `meta.native.ok` | 25 | 0 |
| `meta.native.incomplete` | 0 | 0 |
| `meta.native.error` | 0 | 0 |
| `meta.fallback.used` | 0 | 0 |
| `meta.fallback.empty` | 0 | 0 |
| `meta.fallback.error` | 0 | 0 |

Derivação:

- Relógio da leitura: 2026-11-01 14:51 -03:00. Início da janela: 2026-10-31
  ~03:50 -03:00 (fim do build que trouxe `23d17b0f`).
- Janela decorrida: **~35 h 01 min**; faltam ~13 h para 48 h (fecharia
  2026-11-02 ~03:50 -03:00).
- Taxas sobre `meta.resolve.total`=25 (inalteradas): nativo ok **100%** (25/25);
  `native.incomplete` 0%; `native.error` 0% (limiar <1%); `fallback.used` 0%
  (limiar <0,5%); `fallback.empty+error` 0% (limiar <0,5%).

Limites desta leitura — o que muda a decisão:

- **Amostra congelada.** Δ = 0 em 11 h 30 min: o caminho rápido do
  orquestrador dispensa o resolutor de metadados e o tráfego deste intervalo
  não passou por ele. A janela está aberta em **tempo de calendário**, mas o
  N continua 25 — os limiares são atendidos por construção (25/25 ok), não por
  volume medido. Fechar em 48 h com N≈25 é decisão de baixa confiança.
- Os contadores seguem sem série temporal; a única prova de que nada foi
  truncado é a continuidade (nenhum boot e nenhum `cache.clear()` no
  intervalo — o `StartedAt` não mudou).
- Volume absoluto continua sem medida independente de requisições para cruzar.

**Veredito: JANELA ABERTA (amostra insuficiente).** Manter a coleta e registrar
uma leitura por dia; se o Δ continuar 0, a decisão do passo 0 precisa de uma
das duas saídas antes de cortar: (a) esperar a recomendação do §3 (5-7 dias) até
haver amostra nova, ou (b) registrar explicitamente que o corte é aceito com
N=25 e zero `fallback.used` — o que o plano permite, desde que a decisão fique
assinada neste relatório. Os passos 1-5 continuam travados.

### Assinatura do passo 0 — 2026-11-01

Saída escolhida: **(b) corte aceito com N=25**, decisão do operador em
2026-11-01 (após a leitura de 14:51).

Base da decisão, explícita e com o que ela NÃO cobre:

- Evidência usada: `meta.resolve.total`=25, `meta.native.ok`=25 (100%),
  `native.incomplete`/`native.error`/`fallback.used`/`fallback.empty`/
  `fallback.error` todos em 0 — coletados em ~35 h 01 min de calendário com
  persistência em `metam:v1:counts` e sem reinício de relógio no intervalo.
- Limiares do §3 atendidos com folga (todos os de fallback em 0%, `native.ok`
  100%), mas **a janela é fechada por decisão, não por volume**: o Δ ficou 0 em
  11 h 30 min (amostra congelada, caminho rápido do orquestrador dispensa o
  resolutor). N=25 é amostra pequena para a recomendação de 5-7 dias do §3.
- O que justifica cortar assim mesmo: o pior caso do passo 1 já é código vivo e
  testado — `meta_load` deriva metadados do próprio id e a resposta degrada em
  `NOTICE_SEARCHING` (`respond.rs:12`); o passo 1 é reversível numa linha e não
  apaga nada. O risco residual é de disponibilidade de metadado, não de queda.
- O que fica devendo: série temporal de `fallback.used` sob tráfego real. Depois
  do passo 1 os contadores `meta.fallback.*` congelam por desenho; a aposentadoria
  deles (passo 2 e fatia própria) deve registrar que a decisão foi tomada com
  N=25 e que não haverá segunda janela com o fallback vivo.

Sinais de reversão no pós-corte: aumento de `NOTICE_SEARCHING` na resposta de
`/stream` para obras que ontem tinham metadado (o sintoma visível de
`meta.native.error` sem fallback). Ação: reverter o argumento de `meta_source`
em `stream.rs` (rollback do passo 1) antes de investigar o primário.

Passos 1-5 liberados a partir daqui.
