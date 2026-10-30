# AGENTS.md — Adom Power-Movie

Guia curto para agentes de código. É o **resumo**: a versão completa, com
medições, datas e histórico de cada decisão, está em
[`docs/AGENTS-DETALHADO.md`](docs/AGENTS-DETALHADO.md) — consulte-a (grep pela
palavra-chave) antes de mexer numa área que este arquivo só menciona.
`README.md` é voltado ao usuário; `DEBRID.md`, `PLANO_CACHE.md` e
`TEST_INFRA.md` cobrem só os assuntos deles. Em conflito, o código vence.

---

## O que é

Addon Stremio self-hosted que devolve streams de torrent, com foco em
**conteúdo brasileiro dublado** — origem de quase toda a complexidade. Roda em
container único (Adom + Jackett + FlareSolverr + Caddy). Play é P2P puro ou via
debrid (Premiumize, AllDebrid, TorBox, Real-Debrid, Debrid-Link). Quase todo
trabalho de código é em `src/`.

## Stack

- **Node ≥ 20, TypeScript + ESM**. `tsc` compila `src/`, `test/` e `scripts/`
  para `dist/`, e **é `dist/` que roda** (`npm start` =
  `node dist/src/addon.js`). Produção: `node:22-alpine` (tem `node:sqlite`;
  Node 20 cai em memória — mantenha o `require` lazy).
- `noEmitOnError`: build com erro de tipo não gera `dist/`. `strictNullChecks` e
  `noImplicitAny` ligados; `any` só explícito. JSDoc de tipo em `.ts` é ignorado.
- **Só duas deps de produção** (`express`, `dotenv`). HTTP é `fetch`, HTML é
  regex. Não adicione dependência sem necessidade real.
- `src/app.ts` = fábrica Express (`createApp()`, o que os testes importam).
  `src/addon.ts` = processo (listen, workers, shutdown) — **importá-lo sobe o
  servidor**.
- **Docker de container único, tudo em loopback** (`127.0.0.1`): nenhum hostname
  de container sobrevive. `scripts/entrypoint.sh` supervisiona caddy → jackett →
  flaresolverr → gateway (`adom-server`, 7000) → addon (Node, 7100); qualquer um
  morrer derruba o container. Healthcheck quádruplo (7000, Jackett 9117, Flare
  8191, API admin do Caddy 2019 **com `Origin` explícito**).
- **Ponte Rust** (`rust/crates/adom-napi`, napi-rs): o Dockerfile compila o
  `.node` para musl (estágio `rustcore`, `-crt-static`) em `dist/rust/`; o
  `npm run build` o copia de `rust/target` depois de limpar `dist/`. O núcleo é
  **obrigatório** (`native-core.ts`; o boot o carrega, testes sob demanda) e
  **não tem modo**: não existe `RUST_CORE=off|shadow|on`. `RUST_CORE_PATH` só
  aponta o binário quando ele não é o empacotado (teste/CLI).
  O núcleo decide **tudo que é regra**: os **filtros** (`filterRelevantRaw`/
  `filterInventoryRelevant` e `filterSeriesEpisodeRaw`, em lote, devolvendo só
  índices e o motivo; pre-air e o enriquecimento pelo banco de magnets
  continuam no TS), o **parse de magnet e texto** (`title-normalization`:
  `normalizeTitle`, `extractInfoHash`, `decodeEntities`, `bytesToSize`), o
  **S/E** (`parseTitleSeasonEpisode`, temporada do título), **áudio e origem**
  (`audio-quality`, `audio-cleanup`, `looksPtBr`), o **pré-resolve BR do
  protetor** (`pre_resolve`: relevância → temporada → episódio → dedupe →
  `resolveCandidateScore` → teto → guarda de URL, numa chamada), o **casamento
  de títulos** (`matchesBrTitle`, `matchesName`, `short_name_tail`,
  `non_feature_release`), o **ranking** (dedupe + sortAndLimit), o **💾 de
  episódio** (`annotateEpisodeSizes`), a **fonte de mídia do índice**, a
  **seleção do autofetch** (imediatos e fila; o laço e a cascata são do
  worker nativo desde a B4 — ao TS sobraram a ponte e o painel) e as
  decisões de debrid (**`pickFile`**,
  **veredito de cache**, **ledger/gate do RD**, **limpeza**) e, desde a ponte da
  F-1, o **fim da busca** (`search_finish`: commit, promoção tardia, SWR), a
  **saída de cada stream** (`play_disposition`), a **via do banco de magnets**
  (`search_bank`: janela, recente, fonte), o **corte final**
  (`limit_reserving_br`/`filter_known_cache`) e a **classificação do catálogo**
  (`catalog_classify`). O CI compila o napi antes da suíte.
  O TS que sobra é **I/O e rede** (fetch/HTTP, disco, processos) mais o
  **vocabulário exportado** (listas/constantes e os wrappers finos que chamam o
  núcleo) — mexeu numa régua, mexa no `adom-core`; o `src/` só transporta.
  Goldens cujo corpo TS saiu daqui são conferidos contra o TS do `esm`
  (`scripts/golden/run-esm-golden.mjs`): títulos, parsers do crawl,
  filtros (`release-filters`, `inventory-filter`, `series-episode-filter`) e,
  desde o G6, áudio/rótulos (`audio-presentation`, `pt-audio-guards`,
  `release-labels`, `audio-cleanup-verdicts`), `search-name-helpers`,
  `search-commit`, `play-disposition`, `magnet-bank-instant`/`source`,
  `catalog-classify`, `stream-display`, `stream-quotas-candidate`,
  `release-index-media`, `stream-trace`/`stream-relabel` e `pre-resolve`.
  Nesses, `npm run golden:<x>:check` roda DENTRO do worktree `../adom-esm`;
  nada de regenerar aqui (o `.jsonl` é o mesmo dos dois lados). Para regenerar,
  `cd ../adom-esm && npm run golden:<x> -- --force`.
  Um limite conhecido da fronteira: o `String` do napi-rs é UTF-8 e **não
  carrega code unit UTF-16 órfã** (surrogate sozinho vira U+FFFD). O `JsText`
  do núcleo preserva o órfão (é o contrato de `stream-relabel`/`stream-trace`);
  quem perde é só a travessia Node↔Rust, e por isso esses checks não rodam no
  shim local. O orquestrador in-process consome o porte de
  `stream_display`/`stream_relabel` sem atravessar a fronteira de string; a
  casca TS deles (com `dedupeByHash`/`sortAndLimit`, `limitBy*`/
  `limitReservingBr` e o `toStremioStream`) saiu de `src/` na fase 1 e vive só
  no oráculo de teste (`test/helpers/pipeline-oracle/format.ts`), que chama o
  núcleo pelo napi.
  Por chamada o napi é ~2× mais lento que o TS (travessia de string): o ganho de
  velocidade só existe com API em lote.
  Código Rust quebrado no working tree quebra a imagem.
- **Onde o Rust já substituiu o TS, o TS saiu** (a versão TS segue no branch
  `esm`, que é o oráculo dos goldens): os **nove resolvers** (oito BR + o
  TorrentGalaxy, que é global) são o binário `adom-resolvers` (portas
  8700–8708, supervisionado pelo entrypoint; o `src/br-resolvers.ts` só lista e
  testa) e o **raspador dos nove sites** (oito cards + Mico) é o sidecar
  `adom-sidecar`, que o entrypoint sempre sobe. O loop TS do crawl, o adaptador
  TS do Mico, a sonda CLI de 40 e o knob `CRAWL_ENGINE` saíram; o `crawler.ts` é
  só fachada do painel (status, pausa, "reprocessar sem obra"; "reprocessar
  erros" e "zerar" vão ao sidecar). O diretório TS `resolvers/` saiu inteiro
  (último consumidor era o provider BLUDV); o oráculo dos goldens de resolver
  roda com `--dist=../adom-esm/dist`.
- `ServerConfig.json` do Jackett vive no volume `./docker-data/jackett`;
  `FlareSolverrUrl` tem que ser `http://127.0.0.1:8191`. Definitions Cardigann
  vêm da imagem; nunca monte volume sobre elas. Cache do addon persiste em
  `./docker-data/addon` (`data/cache.db`, `data/magnets.db`).
- Indexer só sai da busca estacionando o card no Jackett (`park_stock_indexer`);
  o `.env` é só o default de instalações novas (o `ji` da URL manda). Id
  renomeado entra em `RETIRED_INDEXERS` (`src/config/helpers.ts`), não no `.env`.
- **Id aposentado precisa de rename em DOIS lugares.** O `RETIRED_INDEXERS` do
  TS cobre a lista padrão (`indexerList()`), mas o `ji` **selado na URL** não
  passa por ela: o rename vive em `src/runtime.ts` (`normalize`/`normalizeIntMap`)
  e no Rust (`adom-core::retired_indexers`, aplicado em `config_encoding`,
  `collect.rs` e `stream_config.rs`). Sem os dois, uma instalação existente
  perde o indexer na URL. `test/config-indexer-aliases.test.ts` amarra os dois
  mapas (lê o arquivo Rust) para os lados não divergirem.
- **O cliente HTTP do Jackett é .NET/SChannel: não passa em todo site.** O
  `torrentgalaxyclone` stock devolvia HTTP 200 com ZERO itens — a página de
  desafio do Cloudflare, byte-idêntica para qualquer User-Agent (node, Chrome,
  `Jackett/1.0`, curl, vazio). Medido: `reqwest` 0.12 + rustls passa (10/10,
  0,22–0,61 s); FlareSolverr passa mas custa 2,7–3,8 s (não serve ao caminho
  quente). O site virou card local `torrentgalaxy-cardigann`, servido pelo
  resolver Rust na 8708; o stock fica estacionado e o id é **renomeado** para o
  novo (não some da lista). Por ser **global P2P**, o card NÃO segue as regras
  dos BR: devolve a página inteira (`max_posts` 50, a busca é lazy), publica os
  seeders reais da listagem (`div.seeders`; 0 = morto, sem dado = neutro 1) e
  mantém os pontos do nome de cena (`DDP5.1`, `H.264`).
- **`wolfmax4k` foi estacionado, não consertado.** O Wolftorrent exige Turnstile
  (`POST /api/descargas` → 403 sem token) e o download final é blob cifrado
  (`enlacito.com`): sem browser não há magnet, e o FlareSolverr não resolve o
  desafio. O card fica estacionado e o id **continua listado** (aparece offline,
  religável) — por isso ele NÃO entra no mapa de aposentados (lá o id seria
  renomeado, e o rename sumiria com o id que o operador quer manter). Desde o
  Jackett v0.24.2903 (2026-10-24) o indexer C# `wolfmax4k` **não existe mais**
  no Jackett (ele apaga o card e responde "Unknown indexer"): religar não é
  opção, e o `park_stock_indexer wolfmax4k` só age em instalação antiga.

## Comandos

```bash
npm run build        # tsc -> dist/ + copia assets
npm test             # node:test sobre dist/test/, lista explícita (pretest compila)
npm run test:complete   # exige todo test/**/*.test.ts na lista do package.json
npm run typecheck    # tsc --noEmit nos 3 programas — tem que ficar em ZERO
npm run lint:lines   # teto de 400 linhas/arquivo, com catraca (.line-budget.json)
npm run smoke        # pipeline ponta a ponta (rede real)
npm run docker:up / docker:logs
```

- **Build antes de testar**: `npm test` roda `dist/`. Teste `.test.ts` novo precisa
  entrar na lista do `package.json` (senão o CI fica verde à toa).
- Seis scripts de harness (`test:stress`, `test:adversarial*`, `test:protector-m1`,
  `test:challenger-m2`, `test:ranking-challenger`) **não passam pelo CI**; rode
  antes de mexer em `test/`. O harness adversarial **muta o `dist/`** — mutação
  nova entra na lista de snapshot/restauração; ao mover símbolo entre arquivos,
  realinhe o `testFile` do mutante.
- Diagnóstico: rotas `/debrid-status.json`, `/metrics.json`,
  `/test-resolver.json`, `/dashboard-status.json`, `/dashboard-action.json`,
  `/stream-trace.json` exigem `X-Indexer-Test-Token` (só no header; sem
  `JACKETT_TEST_TOKEN` no `.env` ficam 503). Ação destrutiva exige
  `{"confirm": true}`. Painel operacional: `/painel` (10 abas).
  **`/test-indexer.json` responde 410** (busca de teste): coleta e colheita são
  nativas — o estado do colhedor mora em `GET /harvest` na admin do gateway.
  **`/internal/*`** (meta e effects da busca e a rota do sidecar (activity);
  os fatos de limpeza da AllDebrid e o `held` do play são do gateway, não há
  rota Node para eles) só existe em loopback + token; a
  fachada Rust recusa `/internal/*` antes do proxy (o Caddy também bloqueia). A
  guarda de loopback do Node **não** distingue o cliente atrás do proxy — a
  recusa tem que estar na fachada. **O corte nativo é FIXO**: o
  `docker-compose.yml` sobe `GATEWAY=on` + `ROUTES_RUST=stream` e o
  `entrypoint.sh` sempre inicia o gateway (7000, com o Node na 7100); o
  `/stream` do Node responde **410**. `ROUTES_RUST=` (vazio) e
  `ROUTES_RUST=health` são **diagnóstico do proxy** (nesse caso o `/stream` do
  Node responde 503). `docker-compose.gateway.yml` é só o override que publica o
  Node em `127.0.0.1:7100`; rollback de TODAS as fatias é commit/imagem
  anterior, não env. Detalhe em `docs/rust-stream-contract.md` §0 e §R de
  `docs/migracao-stream-rust.md`.
  **R3**: a checagem/limpeza da AllDebrid é NATIVA e incondicional (não existe
  `DEBRID_AL_RUST`; a rota Node `/internal/debrid/check` foi apagada). As
  **quatro varreduras destrutivas** (`sweepDead`, `sweepUndubbed`, reconcile da
  posse e cura dos represados) também são NATIVAS: o agendador é o do gateway
  (`al_sweeps`) e o Node **não é mais chamador** de nenhuma delas. O freio de
  APLICAÇÃO é `DEBRID_AL_SWEEP_APPLY` (default do código OFF, compose ON; sem
  ele a rodada monta o plano e fica read-only); `DEBRID_AL_HOLDS`/
  `DEBRID_AL_CLEANUP` seguem como kill-switches do hold e do plano (sem
  holds/inventário a nativa é read-only). Contrato em
  `docs/debrid-al-check-rust.md`.
  **F4.4a**: o gateway sobe uma API administrativa do store nativo em
  `127.0.0.1:8711` (`STREAM_STORE_ADMIN_*`, token no header) que o Node usa
  para invalidar por obra/hash, limpar no `clear-cache` e ler o
  `/stream-trace.json`; ela é incondicional no corte. Contrato em
  `docs/migracao-stream-rust.md` §F4 (F4.4a). O **recompute do trace é
  NATIVO do gateway** (2026-10-30, `eeb02b94`): a admin 8711 recomputa
  quando `found && trace == null` e devolve o `RecomputeOutcome`
  (`attempted/basis/built/builtAt/note/items`) SEM gravar no store (leitura
  quiet); o caminho offline do Node e o `src/utils/trace-recompute.ts`
  saíram — o porte vivo é
  `rust/crates/adom-server/src/trace_recompute_core.rs`. Limitação
  conhecida: o `basis` do recompute nativo não inclui itens
  só-de-inventário (`dinv`); nesse caso o adapter cai no default do
  operador. O **status por indexer** do
  painel também sai dela: o cliente Jackett nativo grava a última consulta
  viva e a foto do circuito (`adom-sources::jackett::status_board`), `GET
  /indexers/status` expõe, e `src/providers/indexer-status-native.ts` lê a
  cada 30 s e grava pelo `indexerStatus.record` (estado, TTL da medição,
  alerta de BR offline). Sem a ponte o painel mostra todos "desconhecido".
  O **catálogo de indexers** (`/configure` e painel) também saiu da coleta do
  Node: o gateway coleta o XML do Jackett (`adom-sources::jackett::catalog`),
  guarda memo/TTL com retry de fallback (`catalog_admin`), expõe `GET
  /indexers/catalog` na mesma admin, e `src/providers/catalog-native.ts` lê.
  F4.6 (2026-10-30) apagou o fallback TS `jackett-catalog.ts` e o aquecedor
  `startAutoRefresh` do `src/addon.ts`: a ponte é a ÚNICA fonte do catálogo
  (`/defaults.json`, blocos general/indexers do painel) — com a admin fora,
  mostram lista VAZIA (degradação de gateway degradado, não erro). Sem
  `JACKETT_INDEXERS` explícita, quem define a lista de busca é o GATEWAY (ele
  consulta o Jackett no modo automático); no Node o array nasce vazio e o
  catálogo exibido vem só da ponte.
  O **hit-rate do cache de streams é do gateway** (C4, 2026-10-30): o
  `orchestrator/route.rs::handle` conta `stream.cache.hit`/`stale_served`/`miss`
  SÓ no caminho user-facing (o refresh de fundo e o `/streams/trace` não
  inflam a medida) e as escritas `stream.cache.write` vêm do `set_fenced` de
  `finish.rs`/`late.rs`; `GET /streams/stats` na admin devolve os contadores e
  o `hitRate` (null com total=0). A ponte `src/utils/streams-stats-native.ts`
  lê com fail-open SEM backoff (um 404 de gateway velho não pode congelar a
  invalidação por obra) e o bloco `cache` do painel
  (`dashboard-cache-block.ts`) acrescenta `native:` SÓ quando o gateway
  respondeu; a view mostra gateway → local (só com consultas) → '—', nunca
  0% falso. Contadores são da RAM do processo: zeram no restart.
  O **KV persistente do Node é só a ponte nativa** (`src/utils/native-kv.ts`):
  órfãos do L1 (`notify`, `imdb-seed`, `indexer-status`, `magnetdb-persist`)
  e as chaves `cfg:v1:*` (`autofetch-live*`, `harvester-*`, `crawler-live`)
  leem/escrevem pela mesma tabela `cache` do `data/cache.db` (kvSet com
  `ttl<=0` grava permanente — gate `ttl>0` obrigatório). O relógio de 10 min
  é o `setInterval` PRÓPRIO do `magnetdb-persist` (`sweepNativeNamespaces`):
  a varredura de `mag`/`davail` é NATIVA (o núcleo devolve a contagem
  removida por lado); a ponte não tem mais `kvPruneExpired` (o `prune_expired`
  do `NativeKv` é só do Rust). Órfãos do Chupim na mesma régua: o
  **resumo da obra** lê SÓ pela ponte nativa (`listObraKeysNative`/
  `readObraNative`; quem grava o registro é o commit nativo — `dd6f1f97`). E
  a **régua do magnetdb**: a mescla do import do acervo está congelada no
  oráculo `test/helpers/pipeline-oracle/magnet-bank-import.ts` (quem
  mescla/grava o acervo é o gateway) e os helpers do oráculo falam com a
  ponte `magnetState()`; a metade de ESCRITA do `magnetdb.ts`
  (`markAlive`/`markBad`/`markLie`/`renewAlive`/`forgetBad` e derivadas) é
  régua pendente da leva de debrid — plano em
  `docs/superpowers/plans/2026-10-30-magnetdb-followup.md`.
- **Mudou regra de matching? `data/cache.db` sobrevive ao rebuild.** Zere antes
  de revalidar: `POST /dashboard-action.json {"action":"clear-cache","confirm":true}`
  (escopo global). Bump de namespace (`src/utils/cache-keys.ts`) só quando muda
  um RÓTULO persistido (`dubbed`, `quality`); relevância é refeita a cada busca.
- CI: build + suíte em Node 20/22, `typecheck` na 22, `npm audit --omit=dev`
  bloqueante. `docker.yml` tem filtros de push **e** PR — confira ao adicionar `COPY`.

---

## Fluxo de busca (um `stream` request)

Desde o F4.4 o `/stream` é do **gateway Rust** (`adom-server` → `adom-search`);
o Node não monta mais lista. O Node fica com I/O e rede: metadados em
**fallback**, painel, `/configure` e o estado do
raspador (o crawl em si é do sidecar).

```
Caddy → adom-server (:7000) → Orchestrator (adom-search)
  ├─ cache SWR nativo (data/streams.db, streams:v21) + coalescing inFlight
  ├─ metadados: nativo (fonte primária) + POST /internal/search/meta (fallback vivo)
  ├─ coleta: as CINCO fontes nativas (jackett, prowlarr, torrentio, bludv, mico)
  │  e o inventário da conta — incondicional
  ├─ índice/banco: nativos (`adom-index`/`IdxStore`, `data/magnets.db`)
  ├─ build no núcleo (filtro → multiobra → episódio → ranking → debrid →
  │  cotas → aviso) — MESMA régua dos goldens
  └─ efeitos (EFFECTS_RUST, default ON): POST /internal/search/effects
```

Gateway sem NENHUMA fonte nativa montada é **erro de boot**. O Node fora desse
caminho: `POST /internal/search/meta` (fallback), `/internal/search/effects`,
a rota do sidecar (`/internal/activity`),
painel/config e as pontes do Chupim (o crawl é do sidecar). O
`harvester_enqueue` entra direto na fila do colhedor do gateway
(`adom-server::harvest_effect`); se chegar ao Node, é só contado em `nativeOnly`.
O **colhedor é do gateway** (`adom-harvest`, thread própria): o Node só
enfileira, lê estado e manda pausar/drenar/limpar pela API administrativa
(§Cache e índice). O `/resolve` é nativo e incondicional no gateway (HMAC + debrid); o
efeitos do play (magnetdb, proteção, ledger, listas) são gravados pelo PRÓPRIO
gateway nos stores nativos (`play_effects_native*.rs`); a rota
`/internal/resolve/effects` saiu (responde 404). Os fatos de limpeza da AllDebrid
(hold do autofetch, `knownBefore`, `adprot`) e o `held` do play são calculados
PELO GATEWAY (`adom-server::al_cleanup_facts` e `resolve_bridge`, a partir do KV
nativo): as rotas `/internal/debrid/holds` e `/internal/resolve/facts` saíram e
respondem 404. As rotas `/internal/search/state|config|collect|index|index-write|fallback`
e `/internal/debrid/check` também **não existem mais**.

Pontos que mordem:
- **Host nunca vai para o cache.** Aviso de lista vazia e URL de `/resolve` são
  gravados relativos; `apply_notice_origin` (Rust) monta o host na resposta, com
  o origin da requisição.
- **Config por usuário** viaja codificada na URL (`/<base64url>/manifest.json`),
  servidor stateless. Preferência do usuário lê-se por `opts()` (`src/runtime.ts`),
  **nunca** de `config.*` no caminho de busca. Timer/promise pós-request precisa de
  `runtime.capture()` + `runtime.run()`. Opção nova: `SCHEMA` + `defaults()` (chave
  curta) + controle em `src/client/configure/` (o `KEYS` tem que bater). Rotas sem
  config vêm **antes** de `/:userConfig` em `app.ts`.
- **Série**: fallback de pack no caminho crítico; **pack tardio** sempre roda e
  mescla. A **varredura pt-BR** (raiz do título em português nos globais) tem
  dois caminhos: inline (`recordStatus:false`, respeita o breaker) e tardia
  (`ignoreBreaker:true`) — não uniformize. A task da varredura é marca
  estrutural (`sweep:true`), não comparação de texto.
- **Episódio × data**: release global (não BR; na conta só o first_seen do acervo) publicada ou vista
  mais de `SEARCH_PREAIR_RELEASE_MARGIN_MS` (48h) antes da estreia sai da lista
  daquele episódio (pack velho não o contém; quem o nomeia é falsa).
- **Título canônico en-US** vem de uma 2ª `/find` no mesmo deadline; só
  `title`/`name`, nunca `original_*`. Aliases BR do TMDB têm travas
  (`tmdb-br-aliases.ts`). Cache longo só se as consultas deram `ok:true`.
- **Packs BR multiobra** (`BR_MULTIWORK_PACKS`, default true): admitidos só
  filme + debrid + ano de catálogo + evidência de coleção cobrindo o ano; nunca
  P2P inteiro, nunca no índice público, nunca no autofetch; HMAC leva `p:1` e a
  dica de obra `w`; `pickWorkFile` escolhe o filme.
- **Torrentio** (pool público): fail-open, breaker local, `fileIdx` preservado
  mas não consumido; fora dos defaults (`TORRENTIO_DEFAULT=false`).

## Debrid (`src/debrid/`)

Registry de adaptadores `{id, label, cacheCheck, checkCached, resolveLink, …}`;
o resto do código não conhece serviço específico. Resolução só no **play**
(`/resolve`), nunca na listagem. HMAC cobre `infoHash` + S/E + dica `w`.

- **`cacheCheck` tem que ser honesto**: Premiumize/TorBox/AllDebrid `true`;
  Real-Debrid dinâmico (ledger+oráculo); Debrid-Link `false`.
- `checkCached` → `{cached, known, unusable?}`. `known:false` **não** é "nada em
  cache" (lista passa sem ⚡, `cachedOnly` ignorado, passe tardio refaz).
  `unusable` (`auth`/`quota`) → lista volta como P2P, sem autofetch nem refresh.
  `partial:false` não prova que o debrid foi perguntado (`debridKnown`).
- **O Node não checa cache nem toca play**: a busca e o `/resolve` são do
  gateway. O `wrap` de `src/debrid/rust-remote.ts` só põe a CONTA
  (`accountStatus`, 8710) por cima do adaptador — 501/queda sobem
  `RustWriteError`, recusa (`auth`/`quota`/`rate_limit`) sobe como o erro dele.
  A checagem e o play da ponte que os testes exercitam moram no oráculo
  (`check-bridge.ts`, `play/bridge.ts`); o adaptador cru, em `raw-adapter.ts`.
  Também saiu o aquecimento de inventário no boot (`warmupEnv`): só alimentava
  essa checagem do Node.
- **Varredura manual de mortos do painel (não-AllDebrid) é nativa**: o Node
  chama `POST /debrid/sweep-dead` na 8710 (`src/debrid/rust-sweep.ts`); a régua
  é `adom-debrid::premiumize_sweep` (error sai sempre; parado só na 2ª
  observação após `DEBRID_SWEEP_DEAD_MIN_AGE_MS`; hold ilegível = segurado).
  Outros serviços → 501 → painel "indisponível". O TS ficou no oráculo.
- Lista de arquivos (`fsz`) dá tamanho e resolução a pack/item sem 💾/sem
  resolução. `fsz`/`tsz` são `RUST_OWNED` no KV nativo: a checagem nativa grava
  (`adom-debrid::file_sizes` — TorBox a lista, Premiumize o total), o play do
  Node grava pela ponte `native-kv.ts`, e o build do `/stream` lê por hash
  (`FileSizesSource`, ligado em `adom-server::file_sizes_source`). O build
  escolhe quem precisa da lista (`list_builder::file_wants`: pack, multiobra,
  faixa de episódios, sem tamanho, "sem resolução") e entrega por `want_files`:
  TorBox pede `list_files` no lote; AllDebrid lê `/magnet/status` dos prontos
  (teto `DEBRID_PACK_FILES_PER_CHECK`) numa task em fundo que roda ANTES da
  limpeza (que apagaria o pronto). A lista vale a partir da próxima resposta
  (o build não espera a leitura). A **prova de arquivo** (`idx:v14:file:<hash>`,
  `{a,e,q,n}`) entra nos itens antes do build (`orchestrator::file_evidence`, o
  `applyFileEvidence` do TS): sem ela nenhum claim vira dublado. A auditoria de
  dublagem grava essa prova no OK e só invalida a obra se a prova promove; o
  candidato OK não volta por `DEBRID_DUB_AUDIT_OK_TTL_MS` — antes, cada busca
  re-auditava e invalidava a obra, e a lista pronta nunca ficava no cache
  (CPU ~18 ms/req e `/magnet/upload` a cada acesso). Nome sem resolução →
  medição do cabeçalho: AllDebrid por `/link/unlock`, outros por `adapter.fileLink`.
- **"Sumiu o ⚡ de todos" quase nunca é bug de código**: veja
  `/debrid-status.json` (teto de magnets, chave recusada, prazo). Sem veredito
  da ponte ele responde **200** com `reason:'debrid-bridge'` (não 500) e o bloco
  `general` do painel marca `debrid:false` sem derrubar o resto.
- **AllDebrid**: checar cache = `/magnet/upload` real, não abortável → a checagem
  também limpa (`dropUncached`/`dropReady`). Nunca limpar: hash do autofetch
  (`protected.ts`), preexistente do usuário (`knownBefore`) e, com inventário
  ainda não carregado, **ninguém** (fail-safe fecha). Posse durável `adsub:v1`,
  anti-reenchimento `adrm:v1` (SÓ das varreduras de conteúdo — a higiene da
  checagem nunca marca; a posse do que a checagem nativa sobe é gravada pelo
  próprio gateway no KV nativo, `adom-debrid::marks_feed`), retenção BR
  `adprot:v1`. As varreduras destrutivas (`sweepDead`,
  `sweepUndubbed`, reconcile, revalidate) são NATIVAS (`al_sweeps`) e o TS não é
  mais chamador de nenhuma; o gate de aplicação é `DEBRID_AL_SWEEP_APPLY`.
  **R3**: a checagem/limpeza é NATIVA e incondicional — não existe
  `DEBRID_AL_RUST` e a rota Node `/internal/debrid/check` foi apagada. A nativa
  lê os holds pelo gateway (`al_cleanup_facts`, KV nativo) e só apaga com
  `holdsComplete` + inventário (`may_delete` fail-closed); sem snapshot é
  read-only (`inventory_missing`). `DEBRID_AL_HOLDS`/`DEBRID_AL_CLEANUP` FICAM
  como kill-switches do hold e do plano (código OFF, compose ON).
  Conta em `MAGNET_TOO_MANY` ⇒ `unusable: quota` (lista P2P), nunca ⚡ falso.
  Rollback da fatia: commit/imagem anterior. Contrato em
  `docs/debrid-al-check-rust.md`.
- **Banco de magnets por conta** (`magnetdb`): `alive`/`bad`/`lie` com TTL, só
  evidência medida, falso negativo é pior que falso positivo. `bad` só vem de
  `NoVideoError`; `lie` só do `DubLieError` (áudio EN em post PT).
  **Banco VIVO** (`magnet-bank*`, `data/magnets.db`): acervo permanente por hash
  do que o Jackett devolveu; alimenta a URI rica do play e o fallback 📦 quando
  um indexer falha. Captura é assíncrona e a busca nunca espera o disco.
  **O Node não grava no `magnets.db`**: o import do painel descompacta o
  upload num spool (`/tmp/adom-magnets-import-*.ndjson`) e o gateway mescla
  (`POST /magnet-bank/import` na admin 8711, credencial destrutiva + `confirm`;
  `adom-store::magnet_bank_import*`); o backfill de `dubbed`/`quality` roda no
  boot do gateway. `importLines`/`backfillClassification` TS ficam como régua.
  Os índices `magnet_last_seen` / `magnet_source_last_seen` seguram o `MAX` do
  status do painel: sem eles o poll travava o event loop por ~7 s. A via rápida
  do `/stream` é do orquestrador nativo (`adom-search/orchestrator/fast_path.rs`:
  instantânea antes do índice coberto); a leitura do índice/instantânea para o
  fallback também é nativa (R4) — as rotas Node `/internal/search/index` e
  `/internal/search/collect` saíram junto com `search-index-path.ts` e
  `collect-orchestrator.ts`. O tail da busca coleta com prazo próprio
  (`SEARCH_TAIL_COLLECT_MS`) e, na promoção, tira o 📦 de reserva/foto que a
  coleta ao vivo superou (`merge_fast_with_live`, espelho de
  `dropInstantFallbacks`/`clearInstantSnapshots`). O núcleo calcula `ptTitleDual` in-process com os
  títulos de `SearchMeta`/`BuildContext`; `origin_is_br` combina essa evidência,
  título PT e o flag `isBr`, respeitando o veto de espelho de cena EN.
  Com a prova:
  no Rust, chip DUB/DUAL/NAC e `dubbed` só com ela (`list_builder::audio_proof`,
  o `audioForChip` do `toStremioStream`); o título sozinho é `dub_claim`.
  Série no Rust tem o fallback de pack e o pack tardio do TS
  (`orchestrator/pack.rs`, `SEARCH_PACK_TAIL`): fonte BR só publica pack.
- **Real-Debrid**: `rd-ledger` (`rdc:v2`, global, miss nunca condena; namespace
  `RUST_OWNED` — o Node decide mas grava/lê só pela ponte `native-kv.ts`, sem L1),
  `rd-oracle` (StremThru/Torrentio opt-in). O gate AIMD de escrita é NATIVO
  (`RdGateExecutor`, `DEBRID_RD_GATE*` lidos pelo Rust) e é o MESMO do
  autofetch (`shared_gate`). "Fase 2 fatia 2" é o corte de
  `rd-gate`/`realdebrid-play` no TS (play, checagem e conta do RD nativos), e
  `rd-ledger` fica no Node por enquanto. Kill-switches
  `DEBRID_RD_GATE/LEDGER/ORACLE`.
- **Warmer RD é NATIVO** (`4b640cbb`, Fase 1): quem aquece é o gateway
  (`rust/crates/adom-server/src/rd_warmer*`). Fila/quota em `rdq:v1:wq`/
  `rdq:v1:hour` (namespace `rdq` `RUST_OWNED`, relido no boot) e intent/posse
  duráveis em `rdq:v1:uncertain|owned`; o tick respeita
  `DEBRID_RD_WARM_INTERVAL_MS`/`_IDLE_WINDOW_MS` e o `stream_traffic` do
  `/stream`; o gate é o `shared_gate` do autofetch; o magnetdb nativo pula
  `bad`, marca `alive` e desfaz o `bad` de recusa legal (451). Credencial do
  operador: `.env` (`DEBRID_ALLOW_ENV_KEY`/`DEBRID_OPERATOR_ENV_ACCOUNT`) ou
  painel (`cfg:v1:harvesterDebrid`, selado com `RESOLVE_SECRET`,
  `adom_core::unseal_dk`). Admin `127.0.0.1:8711`: `GET /rd-warm` e
  `POST /rd-warm/pause|resume|drain` (token destrutivo; dreno com `confirm`).
  Desde `b5b2fb8e` (Fase 2 fatia 1) o Node só tem a ponte
  `src/utils/rd-warm-native.ts` (painel e `/debrid-status.json`): sem snapshot
  `rd.warm` é `null` e as ações devolvem `native-unavailable` — não há warmer
  local nem `rdWarmer.start()`.
- **Autofetch (Chupim)**: baixa dublado BR quando nada tocável está em cache;
  pools `br > any > seeds`, cobertura por qualidade-alvo, teto por obra,
  recheck com detecção de torrent morto, fila persistente, sonda dirigida
  `br-probe`, evicção de fallbacks (OFF por padrão). O **corpo TS saiu** (leva
  B4, 2026-10-28): quem executa é o **worker nativo do gateway**, que liga com
  `AUTOFETCH_WORKER=on` (o compose liga); a fábrica dos cinco serviços nasce em
  `autofetch/build.rs` e o cofre de credencial é **RAM** (TTL 6 h, por
  `adapter:conta`, nada em KV/log). Ver a seção seguinte.
  `hold` **antes** da
  checagem, marker só após o aceite; nunca no caminho da resposta. Hash com
  marca `adrm` (apagado de propósito) sai dos candidatos ANTES dos pools,
  como o morto — senão o Chupim parava nele a cada busca (o `enqueue` recusa)
  e nunca tentava o próximo viável.
- Instalação sem config herda a chave do `.env` — numa instância pública use
  `DEBRID_ALLOW_ENV_KEY=false` (+ `DEBRID_OPERATOR_ENV_ACCOUNT=true` para o painel).
- Serviço novo: adaptador + entrada em `ADAPTERS`; o seletor da página se
  alimenta sozinho.

## Worker nativo do Chupim (leva C1; corte do TS na B4)
- `AUTOFETCH_WORKER` é o gate único do dono: o compose traz
  `${AUTOFETCH_WORKER:-on}` (`docker-compose.yml:68`), o `.env` da VPS vence a
  interpolação **e** o `env_file`, e `worker_enabled()` aceita SÓ o literal `on`
  (`rust/crates/adom-server/src/autofetch/mod.rs:128-130`). Desde o corte do TS
  não existe segundo dono: `true`/`1`/vazio/`off` param o Chupim inteiro e o
  efeito de trabalho fica sem quem execute — rollback é commit/imagem anterior.
- Com a trava, o boot monta a fábrica dos cinco serviços
  (`autofetch/boot.rs::production_factory`) e a injeta no laço
  (`boot.rs:103-106`); a chave vem do cofre em RAM, escopo `adapter:sha256`. Sem
  `HttpClient`/cofre a fábrica não existe e o worker fica `phase:"prepared"` —
  não é "sem credencial": sem chave o laço é `active` com `vaultAccounts:0`.
- Já consome, pelo `kind` do job (`autofetch/serve_jobs.rs:57-65`):
  `autofetch_batch` (enqueue → recheck → dreno), `br_probe` (`probe_job`) e
  `season_key` (`season_step`); a cada passagem, a represa `sup:`
  (`serve.rs:155` → `suppressed_step`) e a evicção F6 (`serve.rs:175-176`).
  Kind desconhecido vira `Skip("unknown-kind")` — não volta ao Node.
- **O corpo TS do Chupim SAIU** (leva B4, 2026-10-28), como antes o dos
  resolvers e o do raspador. Em `src/providers/` o assunto virou **ponte e
  painel**: `autofetch.ts` (encolhido — reindexação no boot, `markerActive` de
  `autofetch-marker.ts`), `autofetch-obra*` (registro F2: o aceite
  NATIVO grava e o Node lê no resumo do painel), `autofetch-marker.ts` (chave,
  valor e `forget` do marker — a gravação de produção é do aceite nativo),
  `autofetch-gate.ts`,
  `autofetch-keys.ts`, `autofetch-suppressed.ts`, `autofetch-evict.ts` (leitor
  da prova `er:`: só `hasBrReady`; política e executor são nativos),
  `utils/autofetch-live*` e
  `utils/autofetch-trace.ts` (`trace.chupim` e `lastSkips` — **sem escritor
  desde o corte**: os dois anéis ficam vazios, os números do laço vêm do
  worker nativo pela admin 8711) e
  as pontes (`utils/autofetch-native.ts`, `autofetch-state-native.ts`,
  `rust-autofetch.ts`). A rota `/internal/search/effects` não executa mais
  nenhum kind: `harvester_enqueue` (o gateway o enfileira no colhedor),
  `rd_warmer` e os três de trabalho (`autofetch_batch`, `br_probe`,
  `season_key`) são aceitos na forma e somados em `nativeOnly`, sem executor
  do outro lado.
- **Não é mais do Node**: a posse `adsub` é gravada pela checagem nativa
  (`adom-debrid::marks_feed`) e a retenção `adprot` pelo aceite/auditoria
  nativos; o Node só lê pela ponte. O agendamento das varreduras da
  AllDebrid **não** está mais aqui: as quatro rodam no gateway (`al_sweeps`,
  gate `DEBRID_AL_SWEEP_APPLY`). O marker com `obra` e o registro F2 **não**
  estão mais aqui: o aceite nativo grava os dois (`enqueue.rs:299-316`,
  `enqueue_obra.rs:294-295`).
- **Dono por namespace**: fila (`autofetch:v3:q:`), marker (`m:`) e blacklist
  (`dead:`) são escritos pelo worker no KV nativo; a represa `sup:` é escrita e
  drenada no Rust (`recheck_expire.rs` → `SuppressedV3`, `suppressed_step`);
  o "drenar represa" do painel também é só nativo — sem o passo rodar ele
  responde `native-unavailable`, não há dreno local no Node (era segundo dono
  e, no RD, escrita fora do `shared_gate`).
  O registro da obra (`autofetch:v3:o:`) é gravado pelo commit nativo
  (`enqueue_obra.rs:294-295`) e LIDO pela evicção (`evict_job.rs:176-177`);
  `pf:` hoje só tem construtor de chave, sem escritor
  (`src/utils/cache-keys.ts:264-266`).
- **Não reintroduza o TS do Chupim**: o trabalho que o canal aceita não volta ao
  Node (`Deferred` só existe antes do `submit`), então um "fallback" novo é dono
  duplicado do mesmo lote. Ordem do corte e o que é rollback: `DEPLOY.md` §8.3 e
  §8.4.

## Cache e índice

- `streams:v21` (lista pronta, por config+conta, com HMAC), `raw:v1` (cru por
  indexer, sem credencial), `davail` (⚡ por hash/conta), `rdc:v2`/`rdt:v1`/`rdq:v1`
  (RD), `harvest:v1:*` (fila/seen/hour do colhedor nativo), `idx:v14` (índice de
  releases; dono único: o núcleo Rust, `IdxStore`), `mag` (magnetdb). Versões e cotas em
  `cache-keys.ts` / `cache-quotas.ts`; **todo namespace versionado precisa de cota
  explícita** e a soma tem que ficar abaixo do teto global (93.000).
- **`raw:v1` e `harvest:v1:*` também são do Rust.** O `RawCacheStore` mora no
  `adom-index` (crate leve) e é usado pelo gateway e pelo `.node`; o Node não
  guarda `raw`/`harvest` no L1 nem grava no SQLite — o `raw` é `RUST_OWNED` pelo
  namespace inteiro (o escritor TS do Jackett saiu; `cache.clear()` e
  `clearNamespace('raw')` chamam o Rust) e o `harvest` segue por prefixo; o Node
  lê o `raw` pela ponte napi (`raw-store-native.ts`, diagnóstico) e o `harvest`
  pela admin do gateway. O `rdq` (fila/quota do warmer RD) entrou inteiro no
  `RUST_OWNED` na Fase 1 do warmer: `rdq:v1:wq`/`rdq:v1:hour` e o intent
  `rdq:v1:uncertain|owned` são do Rust, e o Node não grava `rdq` no L1/SQLite.
- **`idx:v14` tem um dono só (o Rust).** O Node acessa por `IdxStore` (napi síncrono, `src/utils/release-index-store.ts`) e não grava o `idx:` no L1 nem no SQLite. O boot não carrega nem apaga linhas `idx`; `cache.clear()` e `clearNamespace('idx')` chamam o Rust. Não há `INDEX_OWNER=node`: rollback = commit/imagem anterior. Diagnóstico de chave exata: `idxHasKey` (no TS) e `hasKey` (napi).
- **KV de estado Rust-owned: `NativeKv`** (tabela `cache` do mesmo
  `data/cache.db`): store em `rust/crates/adom-index/src/kv.rs`, binding napi na
  classe `NativeKv` (`adom-napi/src/kv.rs`), reexportado pelo `adom-store`. O
  Node fala pela ponte (`src/utils/native-kv.ts`, `kvPeek`/`kvKeys`/`kvSet`/
  `kvForget`): sem L1 e sem regravar no SQLite. Dono vivo: a fila
  (`autofetch:v3:q:`), o marker (`m:`) e a blacklist (`dead:`) do Chupim, mais a
  represa `sup:` (escrita e drenada no Rust); `pf:` segue no L1 do Node e
  `obra:`/`probe:` são gravados pela ponte com decisão do Node.
- SWR só serve lista completa, `debridKnown` e com stream **tocável** (aviso não
  conta). Hit de `raw` não pinta o card de status.
- **Addon responde do próprio índice** quando ele cobre a obra (Jackett vira
  alimentador assíncrono); cobertura é por pool (BR dublado → dublado global →
  swarm), nunca contagem pura. **Colhedor nativo** e indexers *index-only*
  (redetorrent, apache, hdr, 1337x, kickasstorrents-ws) ficam fora do caminho da resposta. O
  colhedor nativo NÃO pula os cards que o raspador já cobre (o skip era do
  colhedor TS, `crawl-coverage.ts`, apagado; a régua segue no `esm` se um dia
  for portada). Resposta do índice
  sem NENHUM stream tocável (tudo fora do cache com cachedOnly) coleta ao vivo
  na hora se sobra `SEARCH_INDEX_RESCUE_MIN_MS` (`rescueEmptyIndexAnswer`).
- **Colhedor nativo (`adom-harvest` no `adom-server`)**: thread própria
  (`adom-harvest`, runtime `current_thread` — `tick_async` não é `Send`), que
  drena a fila `harvest:v1:q` no MESMO `data/cache.db` do Node (schema `cache`
  idêntico, zero migração) com Jackett, metadados, índice e banco nativos — as
  mesmas fontes do `/stream`. Guardas no tick: desligado → pausado → inflight →
  tráfego recente (só sonda) → fila vazia → teto `HARVEST_MAX_HOUR`.
  **Preempção intradrain**: obra NOVA de rank maior aceita no enqueue derruba o
  future do drain em voo (`serve.rs`); a entrada volta à cabeça com
  `resumed:true`, só as consultas já gastas são debitadas e o lease da sonda
  renova (`settler.note_preempted`) — preempção não é falha. O rank em voo é
  lido sob o lock da fila (`Inner::set_inflight_rank`). Fila,
  dedupe 12h (`harvest:v1:seen:<sha>`), balde horário (`harvest:v1:hour`) e
  `br-probe` são do Rust; o namespace `harvest` é **RUST_OWNED** no Node (não
  carrega no L1, não grava no SQLite). O painel e os efeitos falam pela admin do
  gateway (`GET /harvest`, `POST /harvest/enqueue|pause|drain|clear|config`,
  `GET /harvest/pending?imdbId=`, loopback `127.0.0.1:8711`, token no header) via
  `src/utils/harvest-native.ts`. A config ao vivo do painel (`cfg:v1:harvester`,
  overrides sobre o `.env`) é do Node: o gateway a lê no boot e recebe cada
  mudança por `POST /harvest/config`; a pausa do painel também grava nela. Rollback = commit/imagem anterior; não há
  `HARVEST_OWNER=node`.
- **Mico Leão Dublado** é card virtual de indexer (consultado por IMDb, fora do
  Jackett) e também o 9º site do raspador.

## Raspagem de sites BR (motor multi-site)

O raspador visita os sites, página por página, e alimenta o acervo. Roda em
paralelo limitado (`CRAWL_MAX_PARALLEL`, default 3; Flare-sites numa faixa
única), cada site no seu ritmo, só com o app ocioso.

- Registro fechado (`crawl-sites/registry.ts`): 8 cards do Jackett + Mico.
  **Os nove são do sidecar Rust** (`rust/crates/adom-crawl`, `rust: true` no
  registro); não há motor TS. As regras abaixo sobre descoberta, réguas e
  séries valem para o Rust (porte fiel do TS do `esm`, oráculo do golden
  `crawl-policy`).
- Duas formas de descoberta: **sitemap** (Vaca, Nerd, TDF, Comando, Rede, BLUDV)
  e **listagem paginada** (HDR, Apache; fim por contagem, âncora só no
  incremental, `lastmod` vazio de propósito). Mico: paginação simples (filtro de
  gênero da API é quebrado) com **passo fixo de `skip`** (25 até 1000, depois 50 —
  `metas.length` NÃO mede o índice bruto), página vazia **intermitente** reconsultada
  e fim só após vazias seguidas (`MICO_CRAWL_MAX_PAGES`/`_EMPTY_RETRIES`/
  `_END_AFTER_EMPTIES`); catálogo real ≈ 20 mil obras por tipo; `lastmod` sintético
  por balde de releitura. Varredura completa (~50 min na VPS) só a cada
  `MICO_CRAWL_FULL_SWEEP_HOURS` (24, data em `crawl_state` `full-sweep:<tipo>`);
  entre elas a rodada é incremental (`discoverKind`): para após
  `MICO_CRAWL_KNOWN_PAGES_TO_STOP` páginas só com obras na fila, sai `complete`
  (sem retry curto) mas não move o cursor.
- **Mico tem ritmo próprio** (`ownPace` na `SITE_TABLE`): o limitador é o
  `MICO_CRAWL_MIN_GAP_MS` do adaptador. Fica fora do teto horário (do site e
  agregado), da janela de ociosidade e da espera do `delayMs`, e o custo dele não
  entra no teto agregado dos outros sites, e roda POR FORA das vagas do
  `CRAWL_MAX_PARALLEL`. Só site sem Jackett/FlareSolverr pode ter `ownPace`.
- **Passo tem prazo duro** (`boundedStep`, `stepDeadlineFor`): linha
  `CRAWL_STEP_DEADLINE_MS` (~700s, conta do Mico), faixa Flare
  `CRAWL_FLARE_STEP_DEADLINE_MS` (~44 min), descoberta de sitemap/listagem
  `CRAWL_DISCOVERY_DEADLINE_MS` (5 min no sidecar) e descoberta do Mico
  `MICO_CRAWL_DISCOVERY_DEADLINE_MS` (2 h, macio entre páginas + duro de 1 min
  a mais; ela roda DENTRO do passo da lane — sem prazo, a lane ficou ~18 h sem
  ler em 2026-10-26). `Retry-After` do Mico tem teto (`MICO_RETRY_AFTER_MAX_MS`,
  10 min) e passo lento da lane vai ao log. Ao vencer, a geração é invalidada: escrita
  tardia é barrada pela cerca (`isAborted`, que também para os laços de
  botão/episódio) e marker/cursor de descoberta só grava via `commit` diferido.
- **"Nada reconhecido" é FALHA, nunca "vazio e completo"** — `urls:[]` com
  `complete:true` avança o cursor por cima de acervo nunca lido.
- Identidade da página = `(site, url_key)` (caminho, sem host). Estado é por
  site; seleção pura no sidecar (`adom-crawl::policy::crawl_site_select`, com
  limite de fome para a descoberta). Fila serve novidade primeiro. O Node não
  escolhe site nem anda cursor: o card só lê (`crawl-cursor-load.ts`).
- A régua do `<h1>` (`adom-crawl::work_name`) é **compartilhada** por 7 sites —
  mexer nela mexe em todos. TorrentDosFilmes (ano no meio, IMDb armadilha) tem
  régua própria.
- Séries: portão `CRAWL_SERIES_ENABLED` (default ligado, só global); página que
  declara uma temporada → `seasonPageGroups`; página que agrega (RedeTorrent, HDR
  sem temporada no slug) → `seriesRowGroups`. Release leva o magnet inteiro
  (o `dn=` é a evidência de episódio). Linha sem temporada nunca vai à raiz:
  sai em `unlocated` e só vira S1 se a obra tem UMA temporada no TMDB
  (`tvSeasonCount`, decidido no `crawl-page`). HDR: ficha `TVSeries` pedida
  como filme é lida como série agregada.
- **A sonda de 40 é o portão** de entrada de um site novo (Wilson ≥ 50%); o
  CLI TS (`probe:crawl-site`) saiu com o último adaptador TS. Hoje o gate só lê
  o veredito gravado; o `adom-crawl probe` lê UMA URL, não a amostra de 40.
  Cuidado: o "Zerar site" do sidecar apaga o `crawl_state` inteiro, veredito
  incluído (o TS o preservava).
- **Vaca (`vacatorrent`)**: o fetch do crawl é `fetchTextCrawl` do profile — direto
  primeiro (reusa a sessão quente) e **FlareSolverr só com desafio do Cloudflare**
  (domínio `vaqueirofilmes1.com` desafia o fetch direto frio; antes isso pausava o
  site por `error-streak`). Fica na faixa única `CRAWL_FLARE_SITES` e a resolução
  conta 1 requisição no custo da página; desafio persistente é erro, sem laço. Pelo
  Flare o sitemap do Yoast volta como **tabela HTML (viewer)**, não XML: o
  `parseSitemapEntries` cai em `parseViewerEntries` (`vaca-sitemap-viewer.ts`).
- **Identificação TMDB é NATIVA (T3-L3, `54209dc8`).** O `adom-crawl` declara
  `adom-sources` e liga `identify`/`get_titles` (`TmdbCatalog`,
  `ingest/native.rs`) à costura `ObraCatalog`: a página sem IMDb ganha o mesmo
  veredito de quatro estados (`identified|unidentified|ambiguous|unavailable` —
  só o último é retentável) e os nomes do filtro saem do `Titles` do cliente,
  aliases BR incluídos. O sidecar grava a página no próprio processo:
  `POST /internal/crawl-result` e `src/providers/crawl-identify.ts` **não
  existem mais**. Sem `TMDB_API_KEY` a fiação não monta a ingestão (sem nomes o
  `record` queimaria `tries` de toda página). A invalidação do `streams.db` do
  gateway sai pela API admin (`POST /streams/invalidate`), fail-open.
- Config por site no painel (`siteOverrides`); sites do painel nascem desligados.

---

## Os seis invariantes que mais quebram

1. **Orçamento de tempo é sagrado.** Cliente Stremio aborta em 10s; o app
   Power Movie (User-Agent `Dart/`) espera 17s e recebe `APP_REPLY_DEADLINE_MS`
   (15000) — o prazo é por requisição (`runtime.replyDeadline()`). Coleta =
   deadline restante − `DEBRID_RESERVE_MS`; indexers globais cabem no orçamento,
   BR **não** (têm total próprio, saltos com deadline absoluto). Etapa de rede
   nova num provider global precisa caber nele. Deadline estourado devolve parcial
   e a busca continua em fundo (cache ≤ 60s). Rode
   `cargo test -p adom-search --test search_budget_metadata` ao mexer (o porte
   para Rust substituiu `test/search-budget-metadata.test.ts` no F4.4).
2. **Origem BR é um campo** (`isBr` do provider), não regex de título como única
   fonte; `looksPtBr` também liga o flag. Dual sozinho nunca condena nem promove
   (precisa de PT/contexto, `ptTitleDual`, herança). Dual + idioma estrangeiro
   nomeado cai em `lixo`. Lista **ampla** (`namesForeignDubLanguage`) só nega BR;
   lista **mínima** (`hasExplicitForeignAudio`) é a única dos caminhos
   destrutivos — não uniformize. Desde o G3 a **decisão** (áudio, origem,
   veredito de dublagem falsa) mora no núcleo (`adom-core::audio`); o TS só
   entrega os campos (`isBr`, `dubbedFrom`) e lê o rótulo. Campos `_*` são
   internos e não podem vazar.
3. **Com debrid que checa cache + cachedOnly, o piso de seeders não corta antes
   da checagem** (`seedFloorFor`, `SEARCH_CACHED_ONLY_IGNORES_SEEDS`): o ⚡ decide.
   **Fontes BR não publicam seeders** (`seeders:1` é placeholder): corte em pool
   ampliado e só depois `limitReservingBr` (vagas por faixa de qualidade, teto por
   indexer). Inverter a ordem faz o BR sumir. Gatilho de último recurso usa
   conjunto **vazio**, não fraco.
4. **Sites BR indexam por título em português** e zeram com acento/`:`/token
   extra: duas queries (en para globais, pt-BR para `JACKETT_PT_BR_INDEXERS`),
   `stripDiacritics` só sob `isBr`, todo fallback de pack carrega as duas. O
   texto da query é moldado no núcleo (`normalizeTitle`/`shapeSearchQuery` e a
   sigla com ponto); o TS só faz o fetch.
5. **Release BR passa por filtro de título estrito** (`matchesBrTitle`: prefixo +
   ano por tipo) duas vezes (pré-resolve do protetor e `filterRelevantRaw`).
   `meta.year` vem sujo ("2024–"). Guardas anexas: `magnetYearContradicts`,
   `series-is-movie`, `franchiseExtensionContradicts`, `matchesShortNameIdentity`
   (nome de 1–2 tokens: identidade vira posição) — desde o G4/G5 todas essas
   réguas decidem no núcleo (`pre_resolve`, `matches_br_title_prepared`,
   `adom-core::short_name_tail`, `non_feature_release`); o TS só transporta o
   veredito e o motivo. Prefira corrigir a régua a criar lista de títulos
   proibidos.
6. **Autofetch e `dropUncached` são forças opostas**; a ponte é `protected.ts`
   (`hold` antes da checagem, liberado só se o download não ocorre).

---

## Mapa dos arquivos (resumo)

| Área | Onde |
|---|---|
| Processo / app / rotas | `src/addon.ts`, `src/app.ts`, `src/routes/*` (`register.ts` é o único ponto de montagem; `addon-router.ts` é o protocolo Stremio) |
| Config | `src/config.ts` + `src/config/*` (operador); `src/runtime.ts` (usuário) |
| Busca | Gateway/orquestrador: `rust/crates/adom-search` (fontes, conta, índice/banco e metadados nativos); no Node ficou o fallback de metadados (`/internal/search/meta`, em `src/routes/internal-search.ts`), os efeitos (o feed de holds saiu: o gateway calcula os fatos; `applyDebrid` só no oráculo de teste `test/helpers/pipeline-oracle/`; o `dub_audit` é nativo desde a T3-L7a) |
| Fontes | `mico.ts` + `jackett-catalog.ts` no Node; Jackett, Prowlarr, Torrentio e BLUDV nativos em `adom-sources`; conta em `adom-search` (`orchestrator/account.rs`) |
| Autofetch / colhedor | Worker nativo do Chupim em `rust/crates/adom-server/src/autofetch/` (fila, recheck, sonda, temporada, represa `sup:` e evicção F6) — o corpo TS saiu na B4. No Node ficam `adsub`/`adprot`, as pontes e o painel — `autofetch.ts` encolhido, `autofetch-obra*`, `autofetch-marker.ts`, `utils/autofetch-native.ts`. Fila e worker do colhedor são do gateway (`adom-harvest`) e o Node só tem a ponte `src/utils/harvest-native.ts` |
| Raspador | Motor, identificação e ingestão no sidecar (`rust/crates/adom-crawl`); no Node ficam os cards (`crawl-sites/registry.ts`), o estado/painel (`crawl-*.ts`, `crawl-store*`, `crawler-live*`) e as ações (`dashboard-actions-crawl.ts`) |
| Debrid | `src/debrid/` (um adaptador por serviço; `alldebrid*.ts` é família; `rd-*.ts`; `file-selector.ts`; `protected.ts`; `rust-remote.ts` é a ponte da checagem/conta/play no 8710). Warmer RD: nativo no gateway (`rust/crates/adom-server/src/rd_warmer*`, admin 8711: `/rd-warm`) e no Node só a ponte `utils/rd-warm-native.ts` |
| Utils | `src/utils/` (`format.ts` é barrel de 7 submódulos; `cache*.ts`, `magnetdb*.ts`, `magnet-bank*.ts`, `release-index.ts` + `release-index-store.ts`, `native-kv.ts` (leitura do KV nativo), `sign.ts`, `deadline.ts`…) |
| Clientes browser | `src/client/{configure,painel}/*.ts` (ESM nativo → `dist/src/public/client/`); `src/public/` é HTML/CSS servido cru |
| Resolvers BR | `rust/crates/adom-resolvers` (Rust); não há mais resolver em TS (oráculo no `esm`) |
| Tipos / testes | `types/domain.d.ts`; `test/` (`helpers/stub.ts`, `e2e/e2e-harness.ts`) |
| Infra | `Dockerfile`, `docker-compose.yml`, `scripts/entrypoint.sh`, `jackett-bludv/*.yml` |

## Convenções

- **`npm run typecheck` fica em ZERO** e **`lint:lines` não regride** (arquivo novo
  >400 linhas reprova; legado só pode diminuir; `--bless` é o escape visível no diff).
- **Tipe o que a função produz.** `Stream` é união que exige ação (`url`/`infoHash`/
  `externalUrl`/`notice`); `DebridAdapter` e `ParsedSeasonEpisode` em
  `types/domain.d.ts`. Falso positivo do compilador: torne o código verificável;
  cast só concentrado em helper.
- Comentários, logs e mensagens em **português**; identificadores em **inglês**.
  Comente o **porquê** (decisão não óbvia), nunca o quê.
- Logs com prefixo de subsistema (`[search]`, `[debrid]`, …); nível via
  `ADDON_LOG_LEVEL` (nunca `LOG_LEVEL`).
- **Nada de config hardcoded**: número ajustável vai em `src/config.ts` + `.env.example`.
- **Falha de rede nunca derruba a busca**: `Promise.allSettled`, `try/catch` → `[]` + log.
- Circuit breaker (`JACKETT_BREAKER_*`) só abre em `offline`; a antiga
  `/test-indexer.json` (410) o ignorava. O breaker é do cliente nativo; o
  painel o lê pela ponte de status (`breakerFor`), o Node não tem breaker.
- Rota async no Express 4 precisa de `asyncRoute`.
- Metadado em `inFlight` usa `fetchJsonWithin` (prazo duro), nunca `fetch` cru.

## Armadilhas mais comuns

- Importar `src/addon.ts` abre a porta — testes usam `createApp()`.
- Caminhos relativos mudaram com o `dist/` (`dist/src/...`); só o `docker run`
  revela. `src/public/` não passa por build.
- Domínio de site BR que muda: registro do Rust (`adom-resolvers/src/main.rs`,
  `adom-crawl::site_profiles`) **+** `src/config/resolvers.ts` **+**
  `.env.example` (a env vence o default); protetor de link também troca de
  host. Site que responde 200 com "Novo Endereço" não aciona failover.
- Pack pode mentir na descrição; `pickFile` lança `EpisodePickError` quando há
  vários vídeos e nenhum casa o episódio, e mede o **nome do arquivo** antes do
  caminho. `isSiteAd` exige separador `_`/`-`/espaço (nunca ponto) após o TLD.
- "Temporada Completa" no singular é pack de **uma** temporada.
- Cinemeta e TMDB com anos a mais de 2 de distância: o filtro aceita os DOIS
  (`altYear`, `catalog-year.ts`) — Monster: global "2018", BR "2021". Filme de
  nome de um token com palavra que nomeia entre o nome e o ano é outra obra
  (a regra do short-name-tail vive no núcleo, `adom-core::short_name_tail`;
  "Monster Hunter 2021").
- Filme antes do 1º lançamento doméstico no TMDB (`tmdb-home-release.ts`):
  release WEB/BluRay/HDTV/DVD não é ele (The Odyssey do Nolan × o "The Odyssey
  (2026)" da Tubi); CAM/TS passa. Trailer/teaser/trilha saiam sempre
  (regra do non-feature no núcleo, `adom-core::non_feature_release`). O build
  lê a data por `peekHomeReleaseAt`.
- Sigla com ponto ("G.O.R.A.", "S.W.A.T.") vira uma palavra (`collapseAcronyms`)
  no `normalizeTitle` e na consulta dos **globais** (`shapeSearchQuery`); os BR
  ficam com os pontos (BLUDV: "S.W.A.T." 127, "SWAT" 0).
- `matchesName` é o único portão de título do global de série; `wanted`
  deduplicado e artigo fora do conjunto significativo — não volte atrás.
- FlareSolverr atende uma requisição por vez: indexer morto atrasa todos; não
  ponha indexer com Flare em `JACKETT_SLOW_INDEXERS` e mantenha o 1337x index-only.
- `Link` do indexer é input de terceiro (`isSafeDownloadUrl`, `redirect:'manual'`).
- Fontes BR mandam tamanho sentinela "1 KB" — não "conserte".
- `assert.deepEqual` estreita o tipo (`never[]`); use `assert.equal(len, 0)`.
- Antes de mudar matching/lista de indexer/classificação BR, **meça no Jackett
  de verdade**. Overrides `path-to-regexp`, `proxy-addr` e `qs` no `package.json` fecham
  advisories reais — não faça `npm audit fix --force`.
- Sem ⚡ ou sem dublado na 1ª resposta costuma ser config/prazo
  (`DEBRID_SHOW_UNCACHED_BR`, bloco `searchFirst` do painel), não matching.

## Git

Branch de trabalho: `rust` (o `esm` é o oráculo dos goldens, no checkout
irmão `E:/adom-esm`). Commits em português com prefixo convencional
(`feat:`, `fix:`). `.env` é ignorado e **contém chaves reais** — nunca faça
commit nem cole seu conteúdo.
