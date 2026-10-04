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

- **Node ≥ 20, TypeScript + ESM**. `tsc` compila `src/`, `test/`, `resolvers/` e
  os `*-resolver/` para `dist/`, e **é `dist/` que roda** (`npm start` =
  `node dist/src/addon.js`). Produção: `node:22-alpine` (tem `node:sqlite`;
  Node 20 cai em memória — mantenha o `require` lazy).
- `noEmitOnError`: build com erro de tipo não gera `dist/`. `strictNullChecks` e
  `noImplicitAny` ligados; `any` só explícito. JSDoc de tipo em `.ts` é ignorado.
- **Só duas deps de produção** (`express`, `dotenv`). HTTP é `fetch`, HTML é
  regex. Não adicione dependência sem necessidade real.
- `src/app.ts` = fábrica Express (`createApp()`, o que os testes importam).
  `src/addon.ts` = processo (listen, warmup, shutdown) — **importá-lo sobe o
  servidor**.
- **Docker de container único, tudo em loopback** (`127.0.0.1`): nenhum hostname
  de container sobrevive. `scripts/entrypoint.sh` supervisiona caddy → jackett →
  flaresolverr → addon; qualquer um morrer derruba o container. Healthcheck
  quádruplo (7000, Jackett 9117, Flare 8191, API admin do Caddy 2019 **com
  `Origin` explícito**).
- Os oito `*-resolver` são **profiles importados no processo do addon**
  (portas 8700–8707, `src/br-resolvers.ts`), não containers.
- `ServerConfig.json` do Jackett vive no volume `./docker-data/jackett`;
  `FlareSolverrUrl` tem que ser `http://127.0.0.1:8191`. Definitions Cardigann
  vêm da imagem; nunca monte volume sobre elas. Cache do addon persiste em
  `./docker-data/addon` (`data/cache.db`, `data/magnets.db`).
- Indexer só sai da busca estacionando o card no Jackett (`park_stock_indexer`);
  o `.env` é só o default de instalações novas (o `ji` da URL manda). Id
  renomeado entra em `RETIRED_INDEXERS` (`src/config/helpers.ts`), não no `.env`.

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
- Diagnóstico: rotas `/debrid-status.json`, `/metrics.json`, `/test-indexer.json`,
  `/test-resolver.json`, `/dashboard-status.json`, `/dashboard-action.json`,
  `/stream-trace.json` exigem `X-Indexer-Test-Token` (só no header; sem
  `JACKETT_TEST_TOKEN` no `.env` ficam 503). Ação destrutiva exige
  `{"confirm": true}`. Painel operacional: `/painel` (10 abas).
- **Mudou regra de matching? `data/cache.db` sobrevive ao rebuild.** Zere antes
  de revalidar: `POST /dashboard-action.json {"action":"clear-cache","confirm":true}`
  (escopo global). Bump de namespace (`src/utils/cache-keys.ts`) só quando muda
  um RÓTULO persistido (`dubbed`, `quality`); relevância é refeita a cada busca.
- CI: build + suíte em Node 20/22, `typecheck` na 22, `npm audit --omit=dev`
  bloqueante. `docker.yml` tem filtros de push **e** PR — confira ao adicionar `COPY`.

---

## Fluxo de busca (um `stream` request)

```
app.ts → providers/index.ts findStreams
  ├─ cache SWR (streams:v21) + coalescing inFlight
  └─ doSearch: cinemeta + tmdb (pt-BR e en-US) em paralelo
       → collectRaw (search-plan + collection-window): jackett (globais EN
         agrupados; BR/slow isolados em pt-BR), prowlarr, torrentio, bludv,
         mico, inventário da conta
       → buildStreams (latest-writer; parcial e tardio): filtro de título →
         pack multiobra → episódio → sortAndLimit (pool ampliado) → applyDebrid
         → limitReservingBr → aviso se vazia
       → enqueueTail (fora da resposta): pack complementar, refresh debrid,
         varredura pt-BR nos globais
```

Pontos que mordem:
- **Host nunca vai para o cache.** Aviso de lista vazia e URL de `/resolve` são
  gravados relativos; `applyNoticeOrigin` monta o host na resposta, com o origin
  da requisição.
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
- Lista de arquivos (`fsz`) dá tamanho e resolução a pack/item sem 💾/sem
  resolução: TorBox e AllDebrid leem na checagem; Premiumize em fundo
  (`premiumize-files.ts`, vale na busca seguinte).
- **"Sumiu o ⚡ de todos" quase nunca é bug de código**: veja
  `/debrid-status.json` (teto de magnets, chave recusada, prazo).
- **AllDebrid**: checar cache = `/magnet/upload` real, não abortável → a checagem
  também limpa (`dropUncached`/`dropReady`). Nunca limpar: hash do autofetch
  (`protected.ts`), preexistente do usuário (`knownBefore`) e, com inventário
  ainda não carregado, **ninguém** (fail-safe fecha). Posse durável `adsub:v1`,
  anti-reenchimento `adrm:v1`, retenção BR `adprot:v1`. Varreduras destrutivas
  (`sweepDead`, `sweepUndubbed`, reconcile, revalidate) têm kill-switch próprio.
- **Banco de magnets por conta** (`magnetdb`): `alive`/`bad`/`lie` com TTL, só
  evidência medida, falso negativo é pior que falso positivo. `bad` só vem de
  `NoVideoError`; `lie` só do `DubLieError` (áudio EN em post PT).
  **Banco VIVO** (`magnet-bank*`, `data/magnets.db`): acervo permanente por hash
  do que o Jackett devolveu; alimenta a URI rica do play e o fallback 📦 quando
  um indexer falha. Captura é assíncrona e a busca nunca espera o disco.
- **Real-Debrid**: `rd-gate` (escrita serial, AIMD), `rd-ledger` (`rdc:v2`,
  global, miss nunca condena), `rd-oracle` (StremThru/Torrentio opt-in). Três
  kill-switches `DEBRID_RD_GATE/LEDGER/ORACLE`.
- **Autofetch (Chupim)**: baixa dublado BR quando nada tocável está em cache;
  pools `br > any > seeds`, cobertura por qualidade-alvo, teto por obra,
  recheck com detecção de torrent morto, fila persistente, sonda dirigida
  `br-probe`, evicção de fallbacks (OFF por padrão). `hold` **antes** da
  checagem, marker só após o aceite; nunca no caminho da resposta.
- Instalação sem config herda a chave do `.env` — numa instância pública use
  `DEBRID_ALLOW_ENV_KEY=false` (+ `DEBRID_OPERATOR_ENV_ACCOUNT=true` para o painel).
- Serviço novo: adaptador + entrada em `ADAPTERS`; o seletor da página se
  alimenta sozinho.

## Cache e índice

- `streams:v21` (lista pronta, por config+conta, com HMAC), `raw:v1` (cru por
  indexer, sem credencial), `davail` (⚡ por hash/conta), `rdc:v2`/`rdt:v1`/`rdq:v1`
  (RD), `idx:v14` (índice de releases), `mag` (magnetdb). Versões e cotas em
  `cache-keys.ts` / `cache-quotas.ts`; **todo namespace versionado precisa de cota
  explícita** e a soma tem que ficar abaixo do teto global (93.000).
- SWR só serve lista completa, `debridKnown` e com stream **tocável** (aviso não
  conta). Hit de `raw` não pinta o card de status.
- **Addon responde do próprio índice** quando ele cobre a obra (Jackett vira
  alimentador assíncrono); cobertura é por pool (BR dublado → dublado global →
  swarm), nunca contagem pura. **Colhedor** (fila `harvest:v1:q`) e indexers
  *index-only* (redetorrent, apache, hdr, 1337x) ficam fora do caminho da
  resposta. O colhedor pula cards que o raspador já cobre.
- **Mico Leão Dublado** é card virtual de indexer (consultado por IMDb, fora do
  Jackett) e também o 9º site do raspador.

## Raspagem de sites BR (motor multi-site)

O raspador visita os sites, página por página, e alimenta o acervo. Roda em
paralelo limitado (`CRAWL_MAX_PARALLEL`, default 3; Flare-sites numa faixa
única), cada site no seu ritmo, só com o app ocioso.

- Registro fechado (`crawl-sites/registry.ts`): 8 cards do Jackett + Mico.
  Site novo = adaptador + linha no registro; `module:null` é estado legítimo.
- Duas formas de descoberta: **sitemap** (Vaca, Nerd, TDF, Comando, Rede, BLUDV)
  e **listagem paginada** (HDR, Apache; fim por contagem, âncora só no
  incremental, `lastmod` vazio de propósito). Mico: paginação simples (filtro de
  gênero da API é quebrado) com **passo fixo de `skip`** (25 até 1000, depois 50 —
  `metas.length` NÃO mede o índice bruto), página vazia **intermitente** reconsultada
  e fim só após vazias seguidas (`MICO_CRAWL_MAX_PAGES`/`_EMPTY_RETRIES`/
  `_END_AFTER_EMPTIES`); catálogo real ≈ 20 mil obras por tipo; `lastmod` sintético
  por balde de releitura.
- **"Nada reconhecido" é FALHA, nunca "vazio e completo"** — `urls:[]` com
  `complete:true` avança o cursor por cima de acervo nunca lido.
- Identidade da página = `(site, url_key)` (caminho, sem host). Estado é por
  site; seleção pura em `crawl-site-select.ts` (com limite de fome para a
  descoberta). Fila serve novidade primeiro.
- `work-name.ts` (régua do `<h1>`) é **compartilhada** por 7 sites — mexer nela
  mexe em todos. TorrentDosFilmes (ano no meio, IMDb armadilha) tem régua própria.
- Séries: portão `CRAWL_SERIES_ENABLED` (default ligado, só global); página que
  declara uma temporada → `seasonPageGroups`; página que agrega (RedeTorrent, HDR
  sem temporada no slug) → `seriesRowGroups`. Release leva o magnet inteiro
  (o `dn=` é a evidência de episódio).
- **A sonda de 40 é o portão** de entrada de um site novo (Wilson ≥ 50%); ela
  mede também a régua do adaptador. Veredito é opt-in por `--write`.
- **Vaca (`vacatorrent`)**: o fetch do crawl é `fetchTextCrawl` do profile — direto
  primeiro (reusa a sessão quente) e **FlareSolverr só com desafio do Cloudflare**
  (domínio `vaqueirofilmes1.com` desafia o fetch direto frio; antes isso pausava o
  site por `error-streak`). Fica na faixa única `CRAWL_FLARE_SITES` e a resolução
  conta 1 requisição no custo da página; desafio persistente é erro, sem laço. Pelo
  Flare o sitemap do Yoast volta como **tabela HTML (viewer)**, não XML: o
  `parseSitemapEntries` cai em `parseViewerEntries` (`vaca-sitemap-viewer.ts`).
- Config por site no painel (`siteOverrides`); sites do painel nascem desligados.

---

## Os seis invariantes que mais quebram

1. **Orçamento de tempo é sagrado.** Cliente Stremio aborta em 10s. Coleta =
   deadline restante − `DEBRID_RESERVE_MS`; indexers globais cabem no orçamento,
   BR **não** (têm total próprio, saltos com deadline absoluto). Etapa de rede
   nova num provider global precisa caber nele. Deadline estourado devolve parcial
   e a busca continua em fundo (cache ≤ 60s). Rode
   `test/search-budget-metadata.test.ts` ao mexer.
2. **Origem BR é um campo** (`isBr` do provider), não regex de título como única
   fonte; `looksPtBr` também liga o flag. Dual sozinho nunca condena nem promove
   (precisa de PT/contexto, `ptTitleDual`, herança). Dual + idioma estrangeiro
   nomeado cai em `lixo`. Lista **ampla** (`namesForeignDubLanguage`) só nega BR;
   lista **mínima** (`hasExplicitForeignAudio`) é a única dos caminhos
   destrutivos — não uniformize. Campos `_*` são internos e não podem vazar.
3. **Fontes BR não publicam seeders** (`seeders:1` é placeholder): corte em pool
   ampliado e só depois `limitReservingBr` (vagas por faixa de qualidade, teto por
   indexer). Inverter a ordem faz o BR sumir. Gatilho de último recurso usa
   conjunto **vazio**, não fraco.
4. **Sites BR indexam por título em português** e zeram com acento/`:`/token
   extra: duas queries (en para globais, pt-BR para `JACKETT_PT_BR_INDEXERS`),
   `stripDiacritics` só sob `isBr`, todo fallback de pack carrega as duas.
5. **Release BR passa por filtro de título estrito** (`matchesBrTitle`: prefixo +
   ano por tipo) duas vezes (pré-resolve do protetor e `filterRelevantRaw`).
   `meta.year` vem sujo ("2024–"). Guardas anexas: `magnetYearContradicts`,
   `series-is-movie`, `franchiseExtensionContradicts`, `matchesShortNameIdentity`
   (nome de 1–2 tokens: identidade vira posição). Prefira corrigir a régua a
   criar lista de títulos proibidos.
6. **Autofetch e `dropUncached` são forças opostas**; a ponte é `protected.ts`
   (`hold` antes da checagem, liberado só se o download não ocorre).

---

## Mapa dos arquivos (resumo)

| Área | Onde |
|---|---|
| Processo / app / rotas | `src/addon.ts`, `src/app.ts`, `src/routes/*` (`register.ts` é o único ponto de montagem; `addon-router.ts` é o protocolo Stremio) |
| Config | `src/config.ts` + `src/config/*` (operador); `src/runtime.ts` (usuário) |
| Busca | `src/providers/` (`search-cache`, `search-orchestrator`, `search-plan`, `collection-window`, `stream-builder`, `debrid-pipeline`) |
| Fontes | `jackett*.ts`, `prowlarr.ts`, `torrentio.ts`, `bludv.ts`, `mico.ts`, `account.ts` |
| Autofetch / colhedor | `autofetch-*.ts`, `br-probe.ts`, `harvester*.ts`, `harvest-*.ts` |
| Raspador | `src/providers/crawl-*.ts`, `crawl-sites/*` |
| Debrid | `src/debrid/` (um adaptador por serviço; `alldebrid*.ts` é família; `rd-*.ts`; `file-selector.ts`; `protected.ts`) |
| Utils | `src/utils/` (`format.ts` é barrel de 7 submódulos; `cache*.ts`, `magnetdb*.ts`, `magnet-bank*.ts`, `release-index.ts`, `sign.ts`, `deadline.ts`…) |
| Clientes browser | `src/client/{configure,painel}/*.ts` (ESM nativo → `dist/src/public/client/`); `src/public/` é HTML/CSS servido cru |
| Resolvers BR | `resolvers/` (núcleo + `profiles/*.ts`), `*-resolver/server.ts` (shims) |
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
- Circuit breaker (`JACKETT_BREAKER_*`) só abre em `offline`; `/test-indexer.json`
  o ignora.
- Rota async no Express 4 precisa de `asyncRoute`.
- Metadado em `inFlight` usa `fetchJsonWithin` (prazo duro), nunca `fetch` cru.

## Armadilhas mais comuns

- Importar `src/addon.ts` abre a porta — testes usam `createApp()`.
- Caminhos relativos mudaram com o `dist/` (`dist/src/...`); só o `docker run`
  revela. `src/public/` não passa por build.
- Domínio de site BR que muda: allowlist do profile **+** `src/config/resolvers.ts`
  **+** `.env.example` (a env vence o default); protetor de link também troca de
  host. Site que responde 200 com "Novo Endereço" não aciona failover.
- Pack pode mentir na descrição; `pickFile` lança `EpisodePickError` quando há
  vários vídeos e nenhum casa o episódio, e mede o **nome do arquivo** antes do
  caminho. `isSiteAd` exige separador `_`/`-`/espaço (nunca ponto) após o TLD.
- "Temporada Completa" no singular é pack de **uma** temporada.
- `matchesName` é o único portão de título do global de série; `wanted`
  deduplicado e artigo fora do conjunto significativo — não volte atrás.
- FlareSolverr atende uma requisição por vez: indexer morto atrasa todos; não
  ponha indexer com Flare em `JACKETT_SLOW_INDEXERS` e mantenha o 1337x index-only.
- `Link` do indexer é input de terceiro (`isSafeDownloadUrl`, `redirect:'manual'`).
- Fontes BR mandam tamanho sentinela "1 KB" — não "conserte".
- `assert.deepEqual` estreita o tipo (`never[]`); use `assert.equal(len, 0)`.
- Antes de mudar matching/lista de indexer/classificação BR, **meça no Jackett
  de verdade**. Overrides `path-to-regexp` e `qs` no `package.json` fecham
  advisories reais — não faça `npm audit fix --force`.
- Sem ⚡ ou sem dublado na 1ª resposta costuma ser config/prazo
  (`DEBRID_SHOW_UNCACHED_BR`, bloco `searchFirst` do painel), não matching.

## Git

Branch de trabalho: `esm`. Commits em português com prefixo convencional
(`feat:`, `fix:`). `.env` é ignorado e **contém chaves reais** — nunca faça
commit nem cole seu conteúdo.
