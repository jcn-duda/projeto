# AGENTS.md — Adom Power-Movie

Guia para agentes de código trabalhando neste repositório. Assume que você já
leu o `README.md` (que é voltado ao **usuário**); este arquivo é sobre **como o
código funciona e como mexer nele sem quebrar**.

Documentos irmãos, quando o assunto for só deles: `DEBRID.md` (conta, ⚡,
limpeza), `PLANO_CACHE.md` (fases 0–2 já estão no código), `TEST_INFRA.md`
(harness e2e). Em conflito, o código e este arquivo vencem.

---

## O que é

Addon Stremio self-hosted que devolve streams de torrent, com foco em **conteúdo
brasileiro dublado** — que é o diferencial do projeto e a origem de quase toda a
complexidade do código.

Não há segundo addon na stack. O que sobe é só o **Adom** (`src/`), em container
único com Jackett + FlareSolverr + Caddy. Play é P2P puro ou via debrid
(Premiumize, AllDebrid, TorBox, Real-Debrid, Debrid-Link).

Praticamente todo trabalho de código acontece no **Adom**.

---

## Stack

- **Node ≥ 20, TypeScript + ESM** (`import`, não `require`), com build: o `tsc`
  compila `src/` e `test/` para `dist/`, e é `dist/` que roda — `npm start` é
  `node dist/src/addon.js`. A imagem de produção é `node:22-alpine` (é ela que
  tem `node:sqlite`).
  - **`noEmitOnError: true`**: build com erro de tipo não gera `dist/`. Se o
    `npm run build` falhar, o `dist/` continua sendo o da compilação anterior —
    não confie num `dist/` de build vermelho.
  - **Tipo em JSDoc é ignorado em `.ts`.** `@param {T}` e `/** @type {T} */`
    viram comentário inerte; o que vale é a sintaxe TS. Sobrou JSDoc de tipo
    pelo código — ele **descreve**, não verifica.
  - Rigor atual: `strictNullChecks` **e** `noImplicitAny` ligados. Parâmetro sem
    anotação é erro (TS7006) — o `any` continua permitido, mas só **explícito**,
    como decisão registrada. Onde o dado vem de API de terceiro (`m: any` num
    `.map` sobre resposta de debrid), `any` é a resposta honesta; onde o tipo é
    conhecido, use o tipo.
- **Duas dependências de produção**: `express`, `dotenv`. O
  `stremio-addon-sdk` ficou em `devDependencies` apenas como referência dos e2e;
  o protocolo em produção usa router Express próprio. Sem lodash, sem axios,
  sem cheerio — HTTP é `fetch` nativo e HTML é parseado com regex.
  **Não adicione dependências sem necessidade real.**
- **Dois módulos de processo, papéis distintos:**
  - `src/app.ts` — fábrica do Express (`createApp()`): manifest, stream
    handler e o registro das rotas (a montagem em si mora em `src/routes/`).
    Sem `listen`, sem warmup, sem carregar resolvers. É o que os testes
    importam.
  - `src/addon.ts` — processo: `listen`, resolvers embutidos, selo, catálogo,
    inventário do `.env`, varredura de magnets mortos, shutdown. **Importar
    este arquivo sobe o servidor.**
- **Docker: container único.** O `Dockerfile` raiz (multi-stage) embute addon +
  Jackett + FlareSolverr + Caddy, e o `docker-compose.yml` tem um serviço só
  (`adom`). Todos conversam por `127.0.0.1` — **nenhum hostname de container
  sobreviveu**: `JACKETT_URL`, `BR_RESOLVERS_HOST` (compose), os yml Cardigann
  (`http://127.0.0.1:870X`), o `Caddyfile` (`reverse_proxy 127.0.0.1:7000`) e o
  `FlareSolverrUrl` do `ServerConfig.json` foram rewired para loopback. Se
  adicionar um serviço novo, siga o mesmo padrão.

### Stack Docker (o que mora no container)

- `scripts/entrypoint.sh` supervisiona os 4 processos (caddy → jackett →
  flaresolverr → addon) com `wait -n` + `pipefail`: qualquer um que morrer
  derruba o container e o `restart: unless-stopped` recria tudo. Logs saem
  prefixados `[caddy]`, `[jackett]`, `[flaresolverr]`, `[addon]`.
- Os cinco `*-resolver` **não são containers**. `src/br-resolvers.ts` os
  carrega no processo do addon, cada um na própria porta (8700–8704), porque
  todos leem `PORT`/`SITE_URL` no `require`. `BR_RESOLVERS_EMBEDDED=false`
  volta ao modo de processos separados (não é o caminho de produção). Desde o
  núcleo comum (PLANO_MELHORIAS 5.4), cada `<nome>-resolver/server.js` é um
  shim que faz `require('../resolvers/profiles/<nome>')` — a lógica vive no
  `resolvers/` (CommonJS puro), e o `npm run build` copia o diretório inteiro
  para `dist/` junto dos shims.
- O healthcheck do Dockerfile é **quádruplo** (`/manifest.json` na 7000 + API
  do Jackett na 9117 + FlareSolverr na 8191 + API admin do Caddy na 2019, num
  `node -e fetch` só). A API do Caddy fica em loopback e prova processo+config
  sem depender de ACME/DNS; healthcheck que olha só o addon deixa os demais
  serviços mortos passarem despercebidos. **A sonda do Caddy vai com `Origin`
  explícito** (`http://127.0.0.1:2019`): a API admin faz origin check e o
  `fetch` do Node não manda o header, então sem ele a resposta é 403
  (`client is not allowed to access from origin ''`) e o container inteiro cai
  em unhealthy com os quatro processos vivos. Trocar `127.0.0.1` por
  `localhost` não resolve — é o header, não o host.
- **`ServerConfig.json` vive no volume** `./docker-data/jackett`, não na
  imagem: trocar a imagem não corrige nada lá. O `FlareSolverrUrl` precisa ser
  `http://127.0.0.1:8191` (sed de migração documentado no cabeçalho do
  compose); hostname errado = indexers com Cloudflare morrem silenciosamente.
- **FlareSolverr lê a env `PORT`**, que o `.env` define como `7000` pro addon
  — o entrypoint força `env PORT=8191` na linha dele por isso.
- As definitions Cardigann vêm da **imagem** (`jackett-bludv/*.yml` copiados
  para `/app/Jackett/Definitions`); o volume `/config` é só estado. Nunca
  monte volume sobre as definitions.
- `shm_size: 1gb` (Chromium) e `mem_limit: 3g` no compose: no container único
  um OOM do FlareSolverr reinicia a stack inteira — é o trade-off inerente da
  unificação, mitigado pelo restart.
- Cache do addon persiste em `./docker-data/addon` (`CACHE_DB_PATH` /
  `data/cache.db`). Sem o volume, toda rebuild esfria o L2.

---

## Comandos

```bash
npm run build             # tsc -> dist/ + copia assets (src/public, fixtures, resolvers)
npm start                 # sobe o addon de dist/ em http://127.0.0.1:7000/manifest.json
npm run dev               # idem, com --watch
npm test                  # node:test sobre dist/test/, lista explícita em package.json (sem rede)
npm run test:complete     # cobra que todo test/**/*.test.ts esteja nessa lista
npm run typecheck         # tsc --noEmit — precisa ficar em ZERO
npm run smoke             # valida o pipeline de ponta a ponta (rede de verdade)
npm run docker:up         # stack completa
npm run docker:logs       # logs do addon
node dist/scripts/magnets.js  # ocupação da conta do debrid (--apply para limpar)
```

**O `npm test` roda `dist/`, então build antes.** Editar `.ts` e rodar teste
direto exercita a compilação anterior — foi assim que erro de tipo passou
despercebido enquanto o build engolia a falha do `tsc`.

A lista do `npm test` é explícita (não é glob) porque `node --test` só expande
padrão a partir do Node 21. Arquivo `.test.ts` novo que não entra no
`package.json` passa despercebido e o CI fica verde à toa — por isso existe o
`test:complete`.

**Cinco harnesses não passam pelo `npm test`** — `test:stress`,
`test:adversarial`, `test:adversarial-m1`, `test:protector-m1` e
`test:challenger-m2` rodam código de bancada que o CI nunca executa. Quebra
neles só aparece no dia em que você precisar deles; rode antes de mexer em
`test/` para ter linha de base.

Quando "o ⚡ sumiu de todos os streams", comece por aqui — é diagnóstico, não
adivinhação:

```bash
curl -H "X-Indexer-Test-Token: $JACKETT_TEST_TOKEN" http://127.0.0.1:7000/debrid-status.json
```

O mesmo token abre `/metrics.json`, `/test-indexer.json`,
`/dashboard-status.json` e `/dashboard-action.json`. Sem `JACKETT_TEST_TOKEN`
no `.env` a rota fica desligada (503, mesmo com header correto); com o token
configurado, header errado ou ausente devolve 401 — o token vale só no
header `X-Indexer-Test-Token`, nunca como `?token=` (a página `/dashboard` em
si é pública e estática; o dado consolidado é que não).

Para checar o código sem subir servidor (importar `src/addon.ts` **abre a porta**
e fica pendurado — não use isso como smoke test), use o `npm run typecheck`: ele
substituiu o `node --check`, que só via sintaxe.

CI (`.github/workflows/ci.yml`) roda build + suíte em Node 20 e 22, e o
`typecheck` só na 22 (não depende da versão de runtime). Build da imagem só
dispara quando Dockerfile / compose / cards / lockfile mudam (`docker.yml`).

---

## Arquitetura do fluxo de busca

Um `stream` request do Stremio percorre exatamente este caminho:

```
addon.ts  processo (listen, warmup)
   └─ app.ts  defineStreamHandler
        └─ providers/index.ts  findStreams
             ├─ cache SWR (streams:v6)          ← só lista completa + debridKnown + tocável
             ├─ coalescing inFlight
             └─ doSearch
                  ├─ cinemeta.getMeta  ─┐ paralelo
                  ├─ tmdb.getTitles    ─┘  (título pt-BR)
                  ├─ collectRaw          ← search-plan + collection-window + graça BR
                  │    ├─ jackett.search (globais EN, agrupados)
                  │    ├─ jackett.search (BR/slow isolados, query em pt-BR nos BR)
                  │    ├─ prowlarr.search
                  │    ├─ torrentio.search  (pool global público, sem config/debrid)
                  │    ├─ bludv.search   (scraper direto, se BLUDV_ENABLED)
                  │    └─ account.search (inventário pronto AllDebrid/TorBox)
                  ├─ buildStreams        ← latest-writer; parcial e tardio
                  │    ├─ filtro por título    ← filterRelevantRaw (EN + PT; BR estrito)
                  │    ├─ pack multi-obra      ← só com debrid + ano (pickFile no play)
                  │    ├─ filtro por episódio  ← matchesEpisode (série)
                  │    ├─ sortAndLimit         ← pool ampliado + limites por qualidade
                  │    ├─ applyDebrid          ← cache/check + autofetch + HMAC
                  │    ├─ limitReservingBr     ← corte final, vagas BR + teto por indexer
                  │    └─ notice stream        ← lista vazia explica o estado, não some
                  └─ enqueueTail (serial, fora da resposta)
                       ├─ pack complementar (série fraca, mescla no lote)
                       ├─ refresh debrid (needsFullRefresh)
                       └─ varredura pt-BR nos globais (se não rodou inline)
```

**O aviso de lista vazia é montado em duas etapas, de propósito.** O
`buildStreams` cria só o **texto** (`{ name, notice: true }`), que é conteúdo da
busca e viaja para o cache; o **link** sai no `applyNoticeOrigin`, já na
resposta, com o origin daquela requisição (`PUBLIC_URL` ou o `Host` que o
cliente usou). Montar o link antes gravaria na entrada compartilhada o endereço
de quem perguntou primeiro — a TV que chama `192.168.0.23` deixaria esse link
para o celular que chama pelo domínio, e um `Host` forjado envenenaria o cache
do próximo. Sem origin nenhum o item é **descartado**: stream sem
`url`/`infoHash`/`externalUrl` não é renderizado por cliente nenhum e só
ocuparia a resposta. Há um quarto texto que **não** nasce no `buildStreams`: o
fallback do `raceWithDeadline`, para quando a busca estoura o prazo e continua
em background — só ali existe a garantia que a promessa "reabra em instantes"
descreve.

Série sem resultado por episódio tem fallback de pack no caminho crítico
(`"Nome S01"`, com a variante pt-BR junto) — as fontes BR só publicam
temporada inteira. Série com resultado **fraco** (ninguém atinge
`SEARCH_PACK_MIN_SEEDERS`, e áudio estrangeiro explícito não conta como
saudável) dispara o **pack tardio**, que mescla em vez de substituir.

A varredura pt-BR (`JACKETT_PT_SWEEP_GLOBAL`) consulta os indexers **globais**
com a raiz do título em português (`franchiseRoot`: sem subtítulo, sem ano,
sem SxxEyy). O dublado titulado em PT mora nesses trackers e a query em
inglês não o encontra. Ela tem **dois caminhos, e eles não são iguais**:

- **inline**, quando o `search-plan` consegue anexá-la ao plano crítico: vai
  com `recordStatus:false` (a variante pt-BR não pode marcar como offline um
  indexer que a busca principal viu de pé), mas **não** passa `ignoreBreaker` —
  ela divide orçamento com a resposta e respeita o circuito aberto;
- **tardia**, na fila de cauda quando a coleta saiu parcial ou a inline não
  rodou (`raw.sweepInline`): `recordStatus:false` **e** `ignoreBreaker:true`.
  Fora do caminho da resposta ela não disputa orçamento com ninguém, então
  pode acordar indexer recém-derrubado.

Não "uniformize" os dois passando `ignoreBreaker` na inline: o breaker existe
justamente para o indexer morto não comer o prazo da resposta.

### Configuração por usuário (`src/runtime.ts`)

Modelo Torrentio: as preferências viajam **codificadas na URL de instalação**
(`/<base64url>/manifest.json`), não em banco. O servidor é stateless.

- `config.ts` = padrões do **operador** (`.env`), estáticos, carregados uma vez.
- `runtime.ts` = overlay do **usuário**, por requisição, em `AsyncLocalStorage`.

**Regra:** o que o usuário pode escolher lê-se por `opts()`; o resto (URLs de
indexer, timeouts, credenciais de infra) continua vindo de `config`. Nunca leia
`config.maxResults` / `config.provider` / `config.debrid.apiKey` direto no
caminho de busca — esses foram movidos para `opts()` e ler o estático de volta
faz a config do usuário ser silenciosamente ignorada.

Timers e promises que disparam **depois** da request (recheck do autofetch,
refresh SWR, `enqueueTail`) saem do `AsyncLocalStorage`. Capture o contexto
com `runtime.capture()` **dentro** da request e restaure com `runtime.run()`
— senão `opts()` lê o `.env` e regrava o cache com a config errada.

Para expor uma opção nova: adicione em `SCHEMA` + `defaults()` (chave **curta**,
ela ocupa espaço na URL), consuma via `opts()`, e adicione o controle em
`src/public/configure.html` — o mapa `KEYS` do front **precisa bater** com o
`SCHEMA` do back.

Schema atual (chave curta → campo):

| chave | campo | nota |
|---|---|---|
| `p` | `providers` | jackett / prowlarr / torrentio / demo — `+` também separa lista |
| `q` | `qualities` | |
| `m` / `s` | `maxResults` / `minSeeders` | |
| `q4`/`q1`/`q7`/`q5`/`qs`/`qn` | cotas 4K…unknown | `qn` é balde próprio, não SD |
| `qi` | `maxPerIndexer` | teto global; 0 = sem limite |
| `b`/`bf`/`o` | vagas BR / BR primeiro / só BR | |
| `d`/`a`/`c`/`z` | dublado / preferir dublado / sem CAM / tamanho | |
| `ji`/`ip`/`jl` | indexers / prioridade / limites por id | |
| `ds`/`dk`/`dc` | serviço / chave / só cache | `dk` é `secret` (selo AES) |
| `bu` | `showUncachedBr` | BR fora do cache como P2P |
| `ab` | `autoFetchBr` | |

### Pool global Torrentio (Fase 1)

`src/providers/torrentio.ts` consulta a **API pública** do Torrentio
(`/stream/movie/<id>.json` e `/stream/series/<id>:<S>:<E>.json`) como mais uma
fonte no mesmo balde dos indexers — **sem segmento de config, sem apiKey, sem
debrid**; nenhuma chave do usuário sai do processo. Falha NUNCA derruba a busca:
fail-open (`[]`), com **circuit breaker local** (não é o do Jackett) cujo
timeout é `TORRENTIO_TIMEOUT_MS` e que abre em `TORRENTIO_BREAKER_FAILURES`
falhas seguidas por `TORRENTIO_BREAKER_COOLDOWN_MS`, meia-abrindo depois do
cooldown — só 429/5xx alimentam o breaker; 4xx (inclusive 400) pertencem à
obra/requisição e não provam o host caído. O `fileIdx` que o Torrentio propaga
por stream é **preservado inteiro** no `RawItem` (campo atravessa o pipeline com
`indexer: 'torrentio'`, `tracker` = rótulo após o ⚙️), mas **ainda não é
consumido** no play — nenhum toque em file-selector/HMAC.

Na configuração a fonte é um **toggle específico** (`torrentioToggle` na
configure), jamais um seletor genérico: liga/desliga só a presença de
`torrentio` na chave `p`, preservando base e ordem (jackett/prowlarr/demo vêm
do link salvo ou dos defaults). O `defaults()` injeta `torrentio` **por padrão**
na base real quando `TORRENTIO_ENABLED=true` (jackett/prowlarr/both ganham o
pool junto); o modo **demo é isolado** — sem rede, não mistura com o pool e o
toggle sequer é oferecido.

`jackettIndexers` aceita qualquer string vinda da URL — o caminho de busca
valida cada id contra `SAFE_INDEXER_ID` antes de montar a query. Qualidade
desconhecida tem balde próprio (`qn`), separado do SD: as fontes BR não
publicam resolução, e zerar o SD não pode desligar a prioridade brasileira
junto.

`indexerLimits` (`jl`) é um mapa compacto `id:limite` separado por vírgulas —
um card por indexador na página. Id fora do mapa herda o teto global
`maxPerIndexer`; `0` explícito significa sem limite, e o schema só aceita 0..20
(1..20 é o teto por indexador). A cota roda no corte final, na mesma passada da
qualidade; as vagas reservadas BR passam sem serem barradas, mas continuam
contando — a reserva fura o teto, não o amplia.

`indexerPriority` (`ip`) só desempatá no `sortAndLimit` / `dedupeByHash`; não
é ordem de consulta.

Com `RESOLVE_SECRET` definido, a página manda o segmento para `POST /seal-config`
e recebe o `dk` cifrado (`enc.v1.` + AES-256-GCM). Sem o segredo a chave viaja
em texto puro no base64url. URL antiga (chave crua) continua abrindo. Trocar o
`RESOLVE_SECRET` invalida os selos já emitidos — o usuário refaz o install em
`/configure`. O selo protege a credencial, não o acesso (isso é o `basic_auth`
do Caddyfile).

`prefix()` devolve o segmento de config da requisição corrente. A rota
`/resolve` depende dele: o link de play tem que voltar carregando a mesma
config, senão o debrid do usuário some na hora do play.

Ordem das rotas em `app.ts` é significativa: as rotas sem config vêm **antes**
de `app.use('/:userConfig', ...)`, senão `/manifest.json` seria interpretado como
segmento de configuração. Segmento que não decodifica devolve 404 — sem isso,
qualquer caminho de um segmento viraria um manifest válido servindo o `.env`.

---

## Camada de debrid (`src/debrid/`)

Registry de adaptadores; nada no resto do código conhece um serviço específico.
Cada adaptador exporta a mesma forma:

```js
{ id, label, short, cacheCheck, keyUrl, checkCached(apiKey, hashes), resolveLink(apiKey, hash, ep) }
```

**`cacheCheck` é a distinção que mais importa.** Declare com honestidade;
declarar `true` sem endpoint funcional é o pior dos mundos.

| Serviço | `cacheCheck` | Como sabe |
|---|---|---|
| Premiumize | `true` | lote instantâneo |
| TorBox | `true` | lote instantâneo |
| AllDebrid | `true` | `ready` do `/magnet/upload` (o `/magnet/instant` morreu) |
| Real-Debrid | ⚠️ dinâmico | `rdLedger.enabled && rdOracle.available()`. Com as duas, o `current()` do registry devolve `true` num clone; senão `false` (sem consulta; o play adiciona o magnet) |
| Debrid-Link | `false` | idem |

**Banco de magnets (`src/utils/magnetdb.ts`).** Histórico durável POR HASH,
escopado por serviço+conta (`mag:v1:<lado>:<adapterId>:<sha256(apiKey)>:<hash>`) —
nunca vaza credencial, não cruza contas. Alimenta duas decisões da listagem: o
filtro pré-checagem do `applyDebrid` (descarta o que provou estar quebrado,
antes de gastar lote — ou upload, na AllDebrid) e o desempate `instant` do
`sortAndLimit` (quem provou tocar na hora sobe acima dos seeders, DEPOIS de
episódio/qualidade/dublado/prioridade — histórico desempata, não reordena).
Regra de ouro: só evidência MEDIDA entra, e falso negativo (descartar magnet
bom) é pior que falso positivo.

- **`alive`** (TTL `MAGNET_ALIVE_TTL`, 7 dias): positivo confirmado na checagem
  de cache ou play que resolveu de verdade no `/resolve`. O atalho do davail
  (resposta toda servida do L1) também renova — mesma evidência, servida da
  memória; sem isso, título muito buscado matava o desempate no meio do TTL.
- **`bad`** (TTL `MAGNET_BAD_TTL`, 24h): ÚNICA origem é o `NoVideoError` do
  `pickFile` — a listagem veio com arquivos e nenhum é vídeo. `null` do
  `resolveLink` NÃO grava: ele cobre "ainda baixando", upload recusado e
  transferência fria na maioria dos adaptadores; condenar por null blacklists
  torrent bom por 24h (pior caso: o próprio autofetch baixa o torrent e o
  banco esconde o resultado pronto por um dia). `WorkPickError`/
  `EpisodePickError` também não — o pack pode servir outra obra/episódio.
  `markBad` apaga o `alive` do mesmo hash: bad vence, senão o instantSet
  empurrava ao topo um hash que o filtro ia cortar.

  **Recusa legal do Real-Debrid NÃO é `bad`.** Um ramo antigo do `rd-warmer`
  marcava `bad` no hash cuja sonda voltava `blocked` (HTTP 451 / error_code 35)
  — o serviço recusando o magnet por infringimento, não um torrent sem vídeo.
  Hoje o ramo `blocked` só grava `rdLedger.noteBlocked` (dedupe da sonda + corte
  ternário do `cachedOnly`) e nenhum `bad`. Os bads legados desse ramo são
  recuperados de forma seletiva: o fingerprint é `bad` do adapter `realdebrid` +
  `rdLedger.peek(hash) === 'blocked'` (NoVideoError legítimo nunca grava
  `blocked`). A varredura roda uma vez por processo no boot do warmer
  (`scanBlockedRdBads`, idempotente, sem clear amplo nem bump de namespace) e o
  reparo invalida o namespace `streams` uma vez quando encontra dano — as listas
  prontas foram construídas sem esses hashes e não se corrigiriam só apagando o
  `bad`. O índice/raw permanece quente para reconstruí-las. O
  `applyDebrid` tem self-healing por entrada (`bad+blocked` → `forgetBad`, o
  stream permanece; em `cachedOnly` o corte remove pelo ledger; fora dele volta
  P2P/sem ⚡). Métrica própria: `magnetdb.bad.clearedBlocked` — **não** conta
  como `magnetdb.dropped.bad`.

A fronteira **bad × dead**: mesmo TTL de 24h, mesmo ponto de filtro
(`applyDebrid`, pré-checagem), origens diferentes — bad é play sem vídeo
(banco de magnets), dead é estado terminal observado no recheck do autofetch
(blacklist própria, `autofetch:v3:dead:`). Manter separados: as evidências são
distintas e as métricas (`magnetdb.dropped.bad` / `magnetdb.dropped.dead`)
separam para o diagnóstico não culpar o lado errado. Unificar só se um
terceiro consumidor aparecer.

Kill-switches no `.env`: `MAGNET_DB=false` desliga o banco inteiro;
`MAGNET_ALIVE_TTL=0` e `MAGNET_BAD_TTL=0` desligam cada lado.

**Retenção durável do acervo BR (`adprot:v1`, `src/debrid/protected.ts`).** O
`held` volátil morre no restart e é liberado no ready — sozinho, ele deixava o
`dropReady` da busca seguinte apagar da conta justamente o BR dublado que o
autofetch subiu (o conteúdo caro de aquecer, sem cache no serviço). A camada
durável grava `{acceptedAt, readyAt}` por `adapter:conta:hash` (AllDebrid,
TTL ~10 anos, cota `adprot: 2000`) **só** quando o enqueue do pool `br`
real (`_br`+`_dubbed`, não `_lied`) é aceito — `any`/`seeds` nunca entram.
`dropReady`, `dropUncached`, `resolveLink` não-pronto e `sweepUndubbed`
consultam `isCleanupProtected` (volátil OU durável) e contam
`debrid.cleanup.protectedBrSkipped`. A retenção **não é eterna cega**:
`sweepDead` remove estado terminal (unprotect antes do delete),
`pruneMissing` cata registro de hash que saiu da conta, o `DubLieError` do
play destrava a liberação, e o `reconcile` (dentro do `checkCached`, na
conta de QUALQUER busca — a de usuário não tem varredura agendada) destrava
pending mais velho que o settle (`autoFetchTtl`) e acervo pronto que
regrediu a não-pronto. Kill-switch: `DEBRID_AUTO_FETCH_PROTECT_BR=false`
(restaura a limpeza sobre registro retido).

**Panorama no painel** (`/dashboard-status.json` → `magnetdb`): além dos
totais, o status agrega **por adapter** (`byAdapter`) os tamanhos de
alive/bad/lie e o TTL médio restante de cada lado, e mostra a **taxa ⚡**
(`debrid.check.cached` / `debrid.check.hashes`). Ambos contam exclusivamente
hashes enviados à rede: o numerador são positivos de resposta completa, e o
denominador são consultas reais. Hit local de `davail` fica separado em
`davail.servedHashes`; nunca entra na taxa, que assim não ultrapassa 100%.

AllDebrid **mede** ⚡, mas a consulta é um upload e **não é abortável**
(`abortSafeCacheCheck: false`). A corrida da resposta não cancela o trabalho:
abortar depois do upload perderia os ids necessários para a limpeza.

`debrid.checkCached()` devolve `{ cached, known, unusable? }`:

- `known: true` → dá pra confiar; cacheados ganham ⚡ e o filtro `cachedOnly` vale.
- `known: false` → **não é "nada em cache"**. Todos os streams passam pelo
  debrid, sem ⚡ nos não-confirmados, e `cachedOnly` é ignorado. O passe tardio
  tenta de novo (`needsFullRefresh`) e regrava o cache com o ⚡ quando a
  consulta completa.
- `unusable: { reason }` → o serviço não vai funcionar agora, por um motivo que
  só o usuário conserta. A lista volta como **P2P**.

Confundir os dois primeiros esconde a lista inteira. Foi por isso que `batched()`
(em `common.ts`) **propaga o erro quando todos os lotes falham**: token inválido
retornando "nenhum cacheado" com `cachedOnly` ligado zerava o resultado sem
nenhuma pista do motivo.

`partial:false` **não** prova que o debrid foi perguntado. A entrada do cache
carrega `debridKnown`. Sem esse campo o passe tardio promovia a lista sem ⚡ a
completa e o refresh desistia — raio nenhum pelo `CACHE_TTL` inteiro.
Entrada antiga sem o campo cai em `false` de propósito e paga uma checagem.

**Serviço inutilizável ≠ serviço instável.** Duas condições não são
transitórias e chegam à tela do mesmo jeito — o ⚡ some de TODOS os streams:

| `reason` | Como aparece | Conserto |
|---|---|---|
| `auth` | `AUTH_BAD_APIKEY` (AllDebrid responde com **HTTP 200**), 401/403 nos outros | chave nova + refazer a URL de instalação |
| `quota` | `Magnets limit reached (1000 accross all tabs)` | apagar magnets: `node dist/scripts/magnets.js` |

As duas barram o `/magnet/upload`, que é como a AllDebrid **checa cache** e
**resolve o play**. Prometer debrid nesse estado entrega uma lista em que nenhum
play funciona, então `applyDebrid` devolve os streams como torrent puro e o log
diz qual é o conserto. Elas também não pedem `needsFullRefresh`: como o conserto
é manual, revalidar a cada request só refazia Jackett + resolvers BR para chegar
na mesma lista (7s por busca, cache nunca assentando). Autofetch também não
roda — enfileirar download numa conta que recusa upload só gera erro em série.

Causas **misturadas** (um lote com auth, outro com timeout) não afirmam nada e
caem no genérico — classificar pela primeira faria a lista virar P2P por engano.

**A checagem SUJA a conta — e por isso ela também limpa.** Na AllDebrid não
existe consulta de disponibilidade (o `/magnet/instant` foi removido), então
checar cache é dar `/magnet/upload` de verdade em todos os hashes da busca.
`dropUncached` remove os que voltam não-prontos e `dropReady` remove os que
voltam prontos — sem o segundo, cada busca deixava dezenas de magnets na conta
para sempre (2300 em quatro dias, até estourar o teto e derrubar a checagem
inteira). Apagar o pronto é seguro: o cache é do SERVIÇO, não da conta, e o
play reenvia o hash na hora.

Três coisas nunca entram na limpeza por busca: o hash do autofetch
(`protected.ts`), o que **já era do usuário** (`knownBefore`) e, enquanto o
inventário não carrega, **ninguém** — o `null` é o fail-safe. Como o
`/magnet/upload` é idempotente e a resposta não diz se criou ou reaproveitou
(`{magnet, hash, name, size, ready, id}`, sem data), o adaptador inventaria a
conta uma vez por processo.

Lixo que a limpeza por busca nunca alcança (magnet morto que ninguém pesquisa)
é a varredura periódica `sweepDead` (`DEBRID_SWEEP_DEAD`). Ao contrário do
`dropReady`, ela **não** poupa o inventário do usuário: estado terminal não é
escolha de ninguém. Sem isso, mortos ocupam vaga até a AllDebrid recusar até
o `/magnet/delete` com 503.

Lixo **tocável** tem a própria varredura: `sweepUndubbed`
(`DEBRID_SWEEP_UNDUBBED`) remove magnets com mais de
`DEBRID_SWEEP_UNDUBBED_MIN_AGE_MS` cujo título cai no balde `lixo` do
`audioBucket` (legendado/estrangeiro que o autofetch acumulou). Por apagar
conteúdo que toca, as travas andam juntas — idade mínima, `held`, inventário
`knownBefore` — e inventário frio pula a rodada inteira (mesmo fail-safe do
`dropReady`).

Para comparação: o Comet/StremThru na AllDebrid **não mede** nada (o
`/magnets/check` devolve palpite de base colaborativa) e só toca a conta no
play, sem remover depois. O nosso ⚡ é medido; o preço é essa limpeza.

**Verificador (`/debrid-status.json`).** Encher a conta é invisível até estourar,
e aí o sintoma não aponta para a causa. O endpoint mostra a ocupação antes disso,
atrás do mesmo token do diagnóstico. Com a config na frente
(`/<config>/debrid-status.json`) ele usa a chave **daquela instalação** — que é
a que o app manda, e pode ser diferente da do `.env`. Acima de
`DEBRID_ACCOUNT_WARN_TOTAL` (800 magnets) ele devolve `warn: true` e registra
aviso. Premiumize usa `limit_used` (aviso em `DEBRID_ACCOUNT_WARN_LIMIT_USED`,
default 0.8); TorBox conta o `mylist`. Rate limit (`rate_limit_reached`) chega
como `reason: rate` — transitório, a lista **não** vira P2P. Na AllDebrid não
existe percentual: ela tem dois tetos que não batem entre si (30 "ativos" na
doc oficial, 1000 na mensagem de erro real) e nenhum é consultável — a versão
anterior dizia "231% ocupado" para uma conta que respondia normalmente.

**Painel (`/dashboard`).** A página é pública e estática; os dados vêm de
`/dashboard-status.json` e as ações de `POST /dashboard-action.json`, ambos
atrás do mesmo token de diagnóstico — só no header `X-Indexer-Test-Token`,
`?token=` nunca autentica. O status consolida serviços, métricas, cache, debrid
e resolvers para a página montar. As duas ações (`clear-cache`, `sweep-dead`)
são **globais**: agem sobre o estado do operador inteiro, não sobre a config de
uma instalação — limpar o cache esfria a instância toda de uma vez.

Para adicionar um serviço: crie o adaptador, registre em `ADAPTERS` e pronto —
`SERVICES` alimenta o seletor da página automaticamente.

**Paridade Real-Debrid (fases F1–F5).** O RD aposentou o
`/torrents/instantAvailability` (erro `37`), então o `cacheCheck` passou a ser
**dinâmico** em vez de `false` fixo. Três módulos próprios em `src/debrid/`
sustentam isso:

- **`rd-gate.ts` — governador único de escrita, por conta.** Serializa o
  `addMagnet`/escritas (concorrência 1) com filas por prioridade
  `play > cleanup > autofetch > probe`. AIMD no intervalo entre admissões: 429
  dobra o gap e, com `Retry-After` no erro, honra o cooldown sugerido; cinco
  sucessos consecutivos reduzem o gap em 10%. `cleanup` (DELETE) **fura o
  cooldown** — liberar vaga na conta não consome o recurso que o cooldown
  protege; play fura gap/cooldown só após `playMaxWaitMs`, e nem outro job em
  voo é preemptado. A sonda delega o cooldown ao gate. Motivo: o RD tem teto de
  250 req/min e bruteforce = bloqueio por tempo indefinido — é o serviço onde
  rajada de escrita é mais cara. Kill-switch: `DEBRID_RD_GATE=false` restaura o
  fluxo anterior (inclusive gap/cooldown locais da sonda).
- **`rd-ledger.ts` — ledger global e durável, sem escopo de conta.** O CDN do
  RD pertence ao SERVIÇO, não à conta que observou o resultado, então a chave
  `rdc:v2:<hash>` não leva `apiKey` nem `accountScope` — uma confirmação de uma
  instalação vale para todas. Estados `hit`/`miss`/`blocked` (`blocked` vence
  hit: 451 legal não pode ser apagado por caminho atrasado). Miss usa **backoff
  exponencial** (`DEBRID_RD_LEDGER_MISS_BACKOFF_MS`, 30min→3d) e **nunca
  condena**: falso negativo é pior que falso positivo, então serve só para a
  sonda não martelar e para o filtro do `cachedOnly`. Sinais gratuitos que
  alimentam o ledger (todos com `noteHit`/`noteMiss`/`noteBlocked`):
  inventário, `magnetdb.isAlive`, play/downloaded no `/resolve`, 451, `enqueue`
  pronto, recheck pronto, `torrentStatus` e a sonda RD. O oráculo consulta o
  ledger ANTES da rede (dedupe) — hash já resolvido não paga chamada. Convive
  com o `mag:alive` (por conta, play que funcionou naquela credencial).
  Kill-switch: `DEBRID_RD_LEDGER=false`.
- **`rd-oracle.ts` — oráculo multi-fonte.** Consulta as fontes habilitadas
  (StremThru `GET /v0/store/torz/check?hash=<csv>`, lotes de `maxHashes`, com
  headers `X-StremThru-Store-Name`/`X-StremThru-Store-Authorization`; e
  Torrentio `/…/stream/<type>/<id>.json`) em paralelo, com `Promise.allSettled`
  + fail-open e **um deadline único** para a chamada toda (não multiplica por
  lote/fonte): cada lote StremThru usa só o restante e **não inicia lote depois
  do prazo**; o Torrentio usa o mesmo restante. O segmento de config do
  Torrentio é **texto puro** `realdebrid=<key>` (não base64url), e a extração de
  hash **só aceita hash do conjunto pedido** — o token apiKey no path também é
  40-hex, e o antigo "primeiro 40-hex" confundia a chave com o hash real. Hit
  exige o marcador `[RD+]` exato no `name` (não `[RD]`; `[RD download]` é miss
  autoritativo). Fusão **true-wins**: `true` de qualquer fonte vence; `false` só
  da fonte que enumera com autoridade — item **não listado** pelo Torrentio
  (nem via `infoHash` nem via URL do conjunto pedido) é **desconhecido**, nunca
  miss (o acervo BR dublado que interessa é justamente o que o Torrentio não
  indexa). A chamada do Torrentio é cacheada por título (`rdt:v1:trt:`, TTL ~6h)
  para não bater em infra de terceiro a cada busca. **Fontes opt-in por padrão**:
  o oráculo liga (`enabled` true), mas `stremthruUrl` nasce **vazio** e
  `torrentio` nasce **`false`** — nenhuma credencial sai para terceiro sem
  endpoint/flag explícito (o URL do Torrentio permanece como default apenas para
  documentar o alvo; o `false` é o opt-in). Habilitada a fonte, token/key
  explícitos têm precedência; vazios, usam a apiKey efetiva da instalação
  recebida por `rdOracle.check` — atenção: isso envia a chave à fonte (terceiro
  a vê). `available()` exige fonte realmente utilizável com credencial efetiva.
  No `docker-compose.yml`, o `adom` recebe explicitamente
  `http://stremthru:8080`, a instância self-hosted da própria stack; o default
  vazio vale para execuções fora do compose. Kill-switch:
  `DEBRID_RD_ORACLE=false`.

Com ledger+oráculo ativos, o oráculo roda ANTES do `checkCached` no
`applyDebrid` e grava os veredictos no ledger; o `checkCached` do adaptador só
afirma `complete` quando todo hash tem evidência. **Filtro ternário do
`cachedOnly` para RD**: em vez de "tudo ou nada", remove **apenas o miss
confirmado** (`peek` = `miss`/`blocked`); o **desconhecido sobrevive** (abaixo
na ordenação). AllDebrid/Premiumize/TorBox não passam `missHashes` e mantêm o
comportamento antigo. No ranking, `debrid.knownInstant()` (via `rdLedger.isHit`)
entra ao lado de `magnetdb.isAlive` e `inventoryReady` — o ⚡ real sobrevive às
cotas de qualidade mesmo com seeders baixos. **cacheMaxAge real:** quando o
ledger cobriu o top-N (`debridKnown: true`), `streamsNeedRevalidation` devolve
`false` e a resposta sai com TTL completo (900s) em vez de 60s — a garantia do
`cachedOnly` passa a ser "confiar no ledger até expirar", não re-perguntar a
cada reabertura. Os três kill-switches juntos (`DEBRID_RD_GATE` /
`DEBRID_RD_LEDGER` / `DEBRID_RD_ORACLE`) derrubam a paridade e devolvem o RD ao
comportamento honesto de "não sei".

Resolução acontece **só no play** (rota `/resolve`), nunca na listagem: é uma
sequência de chamadas por torrent e não caberia no orçamento de busca. A
assinatura HMAC cobre `infoHash` + temporada/episódio + dica de obra (`w`).
Sem dica a string assinada é idêntica à antiga (URLs já cacheadas nos clientes
continuam verificando). Dica adulterada mudaria o arquivo tocado dentro de um
pack multi-obra.

`pickFile` escolhe o episódio (série) ou o maior vídeo (filme único). Pack
multi-obra (`_multiWork`) manda `work` assinado; `pickWorkFile` casa nomes +
ano contra o **basename**. Falha explícita (`WorkPickError` → 404) em vez de
tocar o filme errado. Em P2P o cliente baixaria o torrent inteiro — esses packs
são retidos na listagem quando não há debrid ou não há ano de catálogo.

Em série a escolha de episódio também é **explícita**: os padrões do `pickFile`
cobrem os formatos que os sites BR publicam — `S01E01`, `1x04`, `SSEE`, o `E02`
solto das releases BR ("1ª Temporada (2022) WEB-DL E02") e as variantes
`Episódio`/`capítulo`/`ep`/`cap`. Com **vários vídeos** e nenhum casando com o
episódio pedido, ele **lança `EpisodePickError` → 404** em vez de cair no maior
arquivo e tocar outro episódio em silêncio (o bug do True Detective: o post
anunciava S04 dublado e continha S03 em inglês — ali o "não casou o episódio" é
prova de conteúdo errado). Vídeo único continua compatível com torrent de
episódio sem nome técnico.

`DEBRID_RESOLVE_UNCACHED` (operador, não está no schema) manda o não-cacheado
pelo `/resolve` marcado `[AD download]`. Default off: escreve na conta a cada
play de fonte fria. `showUncachedBr` (`bu`) é outra coisa — deixa as vagas BR
como P2P enquanto o debrid baixa.

O registry também expõe `enqueue()` para o **autofetch**. Sem fonte dublada
tocável em cache, o addon manda o debrid baixar candidatos para o play da
próxima vez. Travas e arquitetura atuais (invariante 6):

- desligável (`autoFetchBr` / `ab`);
- suportado em todos os 5 serviços: nos adaptadores com `cacheCheck: true`
  (Premiumize, TorBox, AllDebrid) usa a disponibilidade; nos sem `cacheCheck`
  (Real-Debrid e Debrid-Link) habilita via `autofetchSource: true` com dedupe
  por `inventoryPeek()` síncrono da conta (`cache.get(dinvKey)` sem rede na
  resposta);
- até `DEBRID_AUTO_FETCH_MAX` (1..4) torrents imediatos por busca, com os
  excedentes indo para a **fila persistente** (`readQueue`/`writeQueue`, chave
  `autofetch:v3:q:sha256(searchKey)`);
- pool BR vazio cai em dublada global (`DEBRID_AUTO_FETCH_ANY`) e, em série,
  no pack de mais seeders (`DEBRID_AUTO_FETCH_TOP_SEEDS`);
- hold **por candidato imediato, antes** da checagem; marker só depois do aceite;
- recheck em fundo (`DEBRID_AUTO_FETCH_RECHECK_MS`) com detecção de **torrent
  morto** (`adapter.torrentStatus`): duas observações consecutivas de estado terminal
  removem o torrent da conta (`removeTorrent`), registram blacklist por 24h
  (`autofetch:v3:dead:`) e drenam automaticamente o próximo item da fila (`takeNext`),
  respeitando o orçamento horário (`DEBRID_AUTO_FETCH_ENQUEUE_MAX_HOUR` ou
  `adapter.enqueueHourlyLimit`). **Orçamento cheio não é recusa do torrent**:
  o `drainNext` pausa a drenagem daquele `adapter:conta` por
  `DEBRID_AUTO_FETCH_DRAIN_BACKOFF_MS` (60s) em vez de reenfileirar a mesma
  cabeça e reprocessá-la a cada recheck — o giro infinito era bug real;
- downloads lentos migram para o ciclo de **settle** (`DEBRID_AUTO_FETCH_SETTLE_MS`)
  até o TTL (`autoFetchTtl`), limitado por LRU (`DEBRID_AUTO_FETCH_SETTLE_MAX_LOTS`);
- **prefetch de série**: ao pesquisar um episódio de série com debrid ativo,
  dispara em background a busca do próximo episódio (`E+1`), dedupado por
  `autofetch:v3:pf:` com TTL de 12h;
- nunca entra no caminho da resposta — erro só vira log.

**`torrentStatus` é honesto por serviço, como o `cacheCheck`.** O recheck pede a
cada adaptador o estado real do torrent (`state` em
`ready`/`downloading`/`dead`/`unknown`) e, quando há sinal objetivo, `stalled`.
A diferença entre **morto** e **parado** decide o desfecho: dead colapsa em 2
rechecks consecutivos; um parado merece limiar próprio
(`DEBRID_AUTO_FETCH_STALL_STREAK`, default 3) porque falta de pares pode ser
transitória e matar na 1ª observação descartaria um download que ainda
esquentava. `0` desliga o stall — parado nunca derruba o download. Movimento
(progresso > 0 ou estado que não é dead nem stalled) **zera** a contagem: só
observações consecutivas derrubam.

| Serviço | `stalled` de onde vem | Limite honesto |
|---|---|---|
| Premiumize | **heurística**: `running` + progresso 0/ausente + mensagem atascada ("0 Bytes of 0 Bytes"/"from 0 peer") | a API não tem estado nativo de parada |
| TorBox | **nativo**: `download_state === "stalled"` | nenhuma — campo objetivo da API |
| AllDebrid / Real-Debrid / Debrid-Link | **nunca** — a API não expõe o sinal | sem `stalled`, só ready/downloading/dead |

O Premiumize ainda precisa **casar** a transferência a um hash antes de
indexá-la no lote (`transferHash`), em cascata: `src` com `btih:` → nome cru
com 40 hex → campo direto `hash`/`info_hash`. `src` sem btih (magnet só com
nome) cai nos campos seguintes; quem não casa com nenhum dos três volta `null`
e é contado como órfã (`debrid.pm.status.unmatched`), em vez de o recheck
inventar um hash com o qual limpar a conta por engano.

**Season Pack Fill só promete o que o recheck pode conferir.** Quando um pack
de temporada enfileirado por autofetch fica pronto, o addon invalida as buscas
da mesma temporada/conta e semeia a disponibilidade (`noteAvailable`) para o ⚡
voltar sem esperar o `CACHE_TTL`. Tudo isso roda **só** com `cacheCheck: true`
(Premiumize, TorBox, AllDebrid) — é o recheck do cache que prova ready. Em
Real-Debrid e Debrid-Link (`cacheCheck: false`) não existe essa prova: pack
pronto não marca nem semeia nada, sem promessa de ⚡, e a constatação fica para
o `resolveLink` do play. Não "conserte" ligando o fill nesses dois.

**Painel e configuração ao vivo do chupim (`src/utils/autofetch-live.ts`).**
Configuração em nível de **operador** (afeta a conta de debrid do operador,
enquanto `ab` na URL continua o opt-out individual). Mudanças aplicam ao vivo,
persistidas no SQLite sob `cfg:v1:autofetch` com cópia em memória, sem restart.
Integrado na aba `[Chupim / Autofetch]` do `/dashboard#autofetch` (as rotas
`/autofetch` e `/:userConfig/autofetch` redirecionam 302 para lá).
- `effective()` junta defaults do `.env` com overrides gravados;
- `set(patch)` valida cada campo com os mesmos clamps do `config.ts` (`autoFetchMax` 1..4, `queueDepth` 0..12, etc.) e rejeita chaves desconhecidas (400);
- `reset()` restaura os padrões do `.env`;
- `setPaused(bool)` / `isPaused()` permite pausar novos downloads de emergência mantendo a infra viva;
- `drainQueues()` esvazia todas as filas pendentes.
Ações protegidas atrás de `JACKETT_TEST_TOKEN` (`POST /dashboard-action.json`): `autofetch-pause`, `autofetch-drain`, `autofetch-config-get`, `autofetch-config-set`, `autofetch-config-reset`.

**Painel e configuração ao vivo do colhedor (`src/utils/harvester-live.ts`).**
Configuração em nível de **operador** para o colhedor em segundo plano e sementes populares do IMDb (`config.harvest` e `config.seed`). Mudanças aplicam ao vivo, persistidas no SQLite sob `cfg:v1:harvester` com cópia em memória, sem restart. Integrado na aba `[Colhedor / Harvester]` do `/dashboard#colhedor` (as rotas `/harvester` e `/:userConfig/harvester` redirecionam 302 para lá).
- `effective()` reúne defaults do `.env` com overrides gravados;
- `set(patch)` valida cada campo com os mesmos clamps do `config.ts` (`harvestMaxPerHour` 1..1000, `harvestQueueMax` 10..1000, `harvestDrainMaxWorks` 1..50, `harvestIdleWindowMs` 0..3600000, `seedMaxPerCycle` 1..100, `seedMinVotes` 0..100000, `seedIntervalH` 1..168, etc.) e rejeita chaves desconhecidas (400);
- `reset()` restaura os padrões do `.env`;
- `setPaused(bool)` / `isPaused()` pausa operacionalmente a colheita em segundo plano;
- `clearQueue()` esvazia a fila de obras pendentes de colheita.
Ações protegidas atrás de `JACKETT_TEST_TOKEN` (`POST /dashboard-action.json`): `harvest-config-get`, `harvest-config-set`, `harvest-config-reset`, `harvester-pause`, `harvester-drain`, `harvester-clear-queue`.

**Fase 3 — cobertura BR ⚡ (module `src/utils/br-coverage.ts`, knobs `harvestBrFirst`/`harvestBrMaxWaitMs`).**

A **3.1** torna a cadeia mensurável: o sampler `f3.br` (`start`) varre periodicamente a **coorte popular
persistida** — as mesmas listas IMDb que alimentam o colhedor (`src/providers/imdb-seed.ts`, chave
`seed:v1:cohort`), com o **top `F3_BR_TOP_PER_TYPE` por tipo** (default 100, clamp 1..100), incluindo
obras **já conhecidas** no índice e as **novas** enfileiradas. A coorte **exige a semente ativa**
(`seedEnabled` + `config.seed.apiKey` RAPIDAPI + `releaseIndex.enabled`); **sem coorte não há o que
medir** — `baselineAt=0` e `latest=null`, e a baseline só começa no primeiro sample com coorte. O
mesmo vale se a coorte expirar: gauges/latest são limpos e a janela de 48h recomeça, para a 3.3 nunca
decidir vazão com um alvo obsoleto. O
denominador é a coorte, **não o índice inteiro** (medir tudo dizia o que o addon já viu, não o que as
pessoas estão prestes a abrir). Candidatas são releases **BR dubladas e não-`lied`** (o post que mentiu o
áudio é ruído, não candidata; na obra, hit se qualquer hit; miss só se TODAS são miss; senão unknown).

O ⚡ é medido **no Real-Debrid**, por release, só com leituras quietas: ledger RD (`hit`/`miss`/`blocked`)
mais `davail`/`magnetdb.alive` **somente da conta do operador** — e só quando o serviço ativo é mesmo
`realdebrid` com `allowEnvKey` + `apiKey`. **`blocked` (451 legal) vence**: um davail/alive antigo não
ressuscita hash bloqueado, e volta `miss`. Sem conta do operador configurada, só o ledger decide. `miss`
e `unknown` ficam **separados** (positivo vence miss — falso negativo é o erro que a decisão de vazão
pagaria). Observabilidade pura: **zero rede e zero escrita no debrid** — nenhuma chamada a
`checkCached`/`enqueue`/`addMagnet` no sampler. Métricas/gauges ficam em memória (`metrics.ts`); só a
coorte persiste (SQLite pela semente). No `dashboard-status.json` o bloco `f3` expõe
`baselineAt`/`samples`/`latest` (com `cohortAt`, `targetWorks`, `indexedWorks`, `worksWithBr`,
`worksCached`, `worksKnownMiss`, `worksUnknown`, `releasesWithBr`/`releasesCached`, e os `TypeCounts`
de movie/series) e as razões `popularCoverage` (cached/target), `discoveryRate` (withBr/target) e
`brWarmRate` (cached/withBr). Em `/metrics.json` os gauges `f3.br.popular.*` publicam
`target`/`indexed`/`withBr`/`cached`/`knownMiss`/`unknown` (+ releases e as três razões). Kill-switches:
`F3_ENABLED=false` desliga a fase inteira; `F3_BR_ENABLED=false` desliga só o sampler, e
`F3_BR_TOP_PER_TYPE` regula o tamanho da coorte.

A **3.2** prioriza a fila do colhedor **só com evidência já conhecida, sem pré-sonda**: `next-episode`
(play real, rank 3) ou release BR dublada **não-`lied`** já no índice (rank 2) saem antes do FIFO;
obra sem evidência (pedida pelo usuário) fica no FIFO. **`lied` não prioriza.** `harvestBrMaxWaitMs`
(default 6h) é o bound de fome que impede obra sem evidência de ficar para trás para sempre. São flip
ao vivo no dashboard (`harvestBrFirst`/`harvestBrMaxWaitMs`, aba `[Colhedor / Harvester]`); desligar
`harvestBrFirst` restaura a ordem FIFO exata. Formato da fila `harvest:v1:q` NÃO muda (a priorização é
só reordenação no consumo, e a janela de capacidade preserva a cabeça prioritária já na fila).

A **3.3** é um **gate de decisão documentado**, não auto-tuning: após ≥48h do baseline no ar, o operador
decide a vazão com o bloco `f3` + `harvest.*` + `debrid.rd.warm.*` + `rdGate` (sobe colheita só se o
warmer drena; sobe warmer só sem 429/quota e com conta abaixo do teto). A 3.3 **não muda vazão nem faz
tuning sozinha** — nenhum knob dela ajusta nada automaticamente. Nunca subir a colheita além do que o
warmer absorve — fila `rdq` crescendo é backlog, não valor.


O registry também expõe `inventory()`: o que já está **pronto** na conta
(AllDebrid/TorBox/RD/DL) entra na busca como mais uma fonte
(`src/providers/account.ts`), memoizado por serviço+conta sob `dinv:v1:`. A
relevância de inventário (`filterInventoryRelevant`) aceita também **pack de
franquia** da mesma obra — coisa na conta é escolha do usuário, sinal que
resultado de tracker não tem; por isso essa exceção NÃO vale no caminho dos
indexers. `buildStreams` não re-aplica o filtro estrito em item com
`fromAccount`. Item de inventário é preexistente por definição: o `knownBefore`
já o protege do `dropReady`. Teto curto próprio (`DEBRID_INVENTORY_TIMEOUT_MS`,
1500): a primeira leitura custa ~700ms e a resposta não espera; estourou,
devolve `[]` e a próxima busca pega do memo (aquecido no boot para a conta do
operador).

---

## Cache multi-nível (fases 0–2 no código)

A chave `streams:v6` isola config do usuário + digest da conta
(`request-key.ts`). A versão de cada namespace vive em `src/utils/cache-keys.ts`
— bumpar lá invalida o formato antigo no boot (`loadFromDisk` apaga no disco o
que não bate com a versão corrente). Duas instalações do mesmo título **não**
compartilham a lista — ela carrega URLs de play assinadas. O trabalho caro
(Jackett + scrapers) é compartilhado mais abaixo.

| camada | chave | o que guarda | kill-switch |
|---|---|---|---|
| L1+L2 streams | `streams:v6:…` | lista já cortada, com HMAC | `CACHE_TTL=0` implícito via TTL curto / graça 0 |
| bruto por indexer | `raw:v1:jackett:…` | resultado cru, **sem** credencial | `RAW_CACHE_MAX_ITEMS=0` |
| SWR | `getWithStale` | serve expirada e revalida em fundo | `STREAM_STALE_GRACE_SECONDS=0` |

SWR só serve o que o `finish` promoveria a completa: `partial === false`,
`debridKnown === true` e pelo menos um stream **tocável** (`url` ou
`infoHash`). Item de aviso (`name` + `externalUrl`) não conta — senão a
janela de graça estenderia o estado ruim.

Hit de `raw` **não** pinta o card de status: medição ~0ms mentiria "online"
com o indexer no chão. `/all` do Jackett (sem `JACKETT_INDEXERS`) não passa
por `queryIndexer` e **não** usa o cache bruto — fora de escopo de propósito.

TTL de resultado vazio é curto (`RAW_CACHE_EMPTY_TTL`): 200 com zero itens
pode ser rate-limit, e herdar o TTL cheio congelaria o vazio.

Cotas do L1 (`cache.ts`): `streams` 2000, `raw` 800, `dlmag` 4000, `idx` 4000,
teto global 36000. `raw` é o namespace gordo (~100 KB no pior caso); não suba a
cota sem refazer a conta de memória do container de 3g. A SOMA das cotas é
30.500 — teto global **igual ou abaixo** da soma reintroduz o despejo global
antes da repartição por namespace (foi bug real).

Fase 3 (cache de disponibilidade por hash) **está** no código, em
`src/debrid/index.ts`: o namespace `davail` guarda `1`/`0` por
`adapter:conta:hash`, com TTLs separados (`DEBRID_AVAIL_POS_TTL` /
`DEBRID_AVAIL_NEG_TTL`) — o positivo pode durar mais, o negativo é curto porque
"não estava em cache" envelhece rápido. Detalhes que não são óbvios lendo só a
chamada:

- os **guards de prazo voltam antes** da camada `davail`, de propósito: a
  resposta é do prazo, não do cache;
- `forceFresh` pula a leitura (o passe tardio e o `/resolve` precisam da
  verdade do momento);
- serviço `unusable` **não grava nada** — a culpa é da conta, não do hash, e
  gravar `0` congelaria o erro por todo o TTL negativo;
- a escrita é em lote único, para não disparar uma evicção por hash com a cota
  do namespace saturada;
- `davail.servedHashes` conta o que a camada respondeu sem ir à rede.

O gate de 30% (`debrid.check.repeated / debrid.check.hashes` em 15 min) era o
critério para *implementar*. Já está implementado; hoje esse par de métricas
serve para **calibrar os TTLs**, não para decidir se a fase existe.

**O Real-Debrid tem três namespaces irmãos, separados de propósito (G1).** O
antigo `rdc:v1` nasceu **misturado** — a mesma chave `rdc:v1:<hash>` convivia
com o cache por título do Torrentio (`rdc:v1:trt:...`) e com a fila do warmer
(`rdc:v1:wq`) sob o MESMO prefixo. Cada um migrou para o próprio balde:

- **`rdc:v2:<hash>`, ledger de hashes.** Veredicto `hit`/`miss`/`blocked` por
  hash, sem `adapter`/`apiKey`/`accountScope` (o CDN do RD é do serviço, não da
  conta). É o namespace irmão do `davail` no MESMO L1/L2: herda a cotação do
  cache global, tem backoff exponencial no miss e precisa que `blocked`
  sobreviva a caminhos atrasados. `davail` grava `0`/`1` por conta e envelhece
  rápido no negativo — não "consolide" os dois em um só.
- **`rdt:v1:trt:<type>:<id>`, cache por título do Torrentio.** Guarda a resposta
  do oráculo por **Obra**, não por hash, com TTL próprio (~6h). Separado do
  ledger para o histórico por título não disputar cota com o veredicto por hash.
- **`rdq:v1:wq`, fila persistente do warmer.** Uma única chave que carrega o
  array de trabalho pendente. Isolado do ledger porque a fila não é histórico
  reconstructivo — é estado vivo; o bump do `rdc` tem que sobreviver ao contrário.

O bump de `rdc` v1→v2 (via `cache-keys.ts`, `NAMESPACE_VERSIONS`) executa uma
limpeza **one-shot e idempotente** no boot: descarrega, numa única passada,
**todos** os `rdc:v1:*` — misses suspeitos históricos (inflados pelo eco antigo
do oráculo) e os legados `trt`/`wq` embutidos. Na segunda subida a versão já é
v2, então a passada não se repete, e nada se perde funcionalmente: o Torrentio
é reconsultado e a fila é re-enfileirada sob demanda. `rdc:v2`, `rdt:v1` e
`rdq:v1` sobrevivem ao bump.

---

## Índice de releases e o addon como servidor (`idx:v5`, PLANO_MAGNETDB... ver
## PLANO no repo)

O addon responde do PRÓPRIO índice quando ele cobre a obra, e usa o Jackett
como alimentador assíncrono. Dois caminhos que não compartilham relógio:

```
RESPOSTA (<500ms):  /stream → idx + dinv → checagem no debrid → lista
COLHEITA (fundo):   fila de obras → Jackett com orçamento largo → filtro → idx
```

- **`src/utils/release-index.ts`** guarda por obra (`idx:v5:<imdbId>[:S:E]`) o
  mínimo da release `{ hash, title, size, indexer, isBr, quality, seeders,
  seenAt }`. Invariantes: sem config/credencial na chave (compartilhado entre
  instalações DE PROPÓSITO — guarda o que EXISTE, nunca o que está pronto em
  qual conta); só o que passou pelo filtro de relevância; dedupe por hash;
  item `fromAccount` NUNCA entra (é conhecimento da conta, não evidência
  pública). `seeders` é foto datada — quem ordena é o `sortAndLimit` sobre o
  estado atual.
- **Fast-path da conta** (`ACCOUNT_FAST_PATH`): inventário suficiente
  (`minReleases`) dispara `stopWhen` no `collectWithinWindow` — resposta sai
  na hora `partial` e o passe tardio de sempre promove. Não confundir: a
  resposta parcial com `cacheMaxAge: 0` é o que impede o cliente de segurar
  lista pobre.
- **Leitura do índice (Fase 3):** `idxPoolCovered` decide "índice cobre" com a
  MESMA noção de pool do autofetch (BR dublado → dublado global → melhor
  swarm). **Contagem pura nunca decide**: temporada só com legendado não pode
  impedir a busca BR dublada de rodar. Lacuna → caminho atual inteiro +
  colhedor enfileira a obra.
- **Colhedor** (`harvest:*`): fila persistente numa chave única
  (`harvest:v1:q`), alimentada por busca com lacuna e episódio seguinte
  (dedupe TTL 12h). Freio de atividade em JANELA DESLIZANTE
  (`activity.recentUserTraffic`) — diferente do `hasUserTraffic()` de boot que
  o warmup usa. Consulta sequencial com intervalo mínimo por indexer e teto
  horário: reduz carga total, mas não pode virar crawler.
- **Index-only** (`JACKETT_INDEX_ONLY_INDEXERS`, default: `redetorrent`,
  `apachetorrent`, `hdrtorrent`): ficam FORA do caminho da resposta e DENTRO
  do sistema via colhedor. Latência medida de 8–31s contra orçamento total de
  20s os derrubava no breaker a cada busca, e o retry PT→título original
  consumia o MESMO orçamento. O filtro roda antes do plano de busca; se todos
  os selecionados forem index-only, NÃO há fallback `/all` — a obra entra na
  fila do colhedor pelo caminho de sempre (miss/gap). Separado de
  `JACKETT_SLOW_INDEXERS`: lá o problema é o agrupamento do plano; aqui é
  PRESENÇA na resposta. Não "devolva" esses indexers à busca ao vivo sem
  medir de novo — o breaker aberto era o sintoma, não a causa.
- Kill-switches: `RELEASE_INDEX=false` / `RELEASE_INDEX_TTL=0` (índice),
  `ACCOUNT_FAST_PATH=false`, `HARVEST_ENABLED=false`.
- Critério de aceitação do plano: busca responde com o Jackett FORA do ar —
  coberto pelo teste "Fase 3: Jackett FORA DO AR" em
  `test/index-fast-path.test.ts`.

---

## Os seis invariantes que mais quebram

**1. O orçamento de tempo é sagrado.**
O cliente Stremio aborta em 10s. A cadeia é:

```
tempo QUE SOBROU do deadline − DEBRID_RESERVE_MS (4500) = orçamento da coleta
REPLY_DEADLINE_MS (9200)               prazo absoluto da resposta
BR_PARTIAL_GRACE_MS (1500), sem invadir DEBRID_CHECK_FLOOR_MS (1500)
JACKETT_INDEXER_TIMEOUT_MS (4000)      teto por indexer global, dentro do orçamento
JACKETT_BR_INDEXER_TIMEOUT_MS (20000)  total BR — PODE passar do deadline
JACKETT_DOWNLOAD_TIMEOUT_MS (8000)     teto por salto DENTRO do orçamento BR
DEBRID_CHECK_FORMAT_MARGIN_MS (500)    o que a checagem pode gastar na resposta
```

O orçamento da coleta é **dinâmico**: `collectRaw` recebe o `deadlineAt` da
requisição e calcula `remainingCheckBudget(deadlineAt) − debridReserve`, com
piso de 500ms. Não é uma fatia fixa de `replyDeadline`. Isso importa porque os
metadados rodam **antes** da coleta (Cinemeta 2500ms + TMDB 5000ms no pior
caso): com a fatia fixa, um Cinemeta lento empurrava a coleta para além do
deadline e o usuário via "reabra em instantes" em vez de lista parcial. Quem
mexer aqui tem que rodar `test/search-budget-metadata.test.ts`, que fixa esse
contrato com metadados lentos e assert no prazo.

Os indexers globais precisam caber no orçamento da coleta; os BR **não**.
`brIndexerTimeout` é o orçamento **total** de um indexer BR: busca **mais**
resolução de magnets. `resolveCardigannDownloads` recebe um `deadline` absoluto
e cada salto de protetor de link usa só o que sobrou.

`search-plan` **isola** BR e `JACKETT_SLOW_INDEXERS` em tarefas próprias: um
NerdFilmes de 7s não pode segurar o TPB fora do balde. Globais de teto curto
continuam agrupados.

A resposta não espera pelas fontes lentas: `collectWithinWindow` despeja num
balde compartilhado e devolve o que chegou no prazo. Se só chegaram globais,
concede a graça BR — algumas UIs não repetem a resposta parcial, então o passe
tardo sozinho não torna o dublado visível. Em **série** a graça só roda com
itens no balde: balde vazio cai no fallback de pack, e gastar a graça nessa
hora rouba o tempo dele.

Quando o resto termina, o passe tardio reescreve o cache com o lote completo
(`createLatestWriter` descarta escrita velha se o pack assumiu). Na busca fria
a raspagem sozinha leva 5–6s e ainda faltam os saltos do protetor — cortar no
meio descartava os BR por falta de infoHash. Por isso `buildStreams` foi
extraído de `doSearch`: os dois passes (parcial e tardio) rodam o mesmo
pós-processamento.

A checagem de cache no passo de resposta usa o que **sobrou** do deadline
(`remainingCheckBudget`). Coleta fria que come o orçamento inteiro degrada
para `known:false` e a lista sai não-vazia; o fundo repete sem teto curto.

Se você adicionar mais uma etapa de rede num provider **global**, ela precisa
caber no orçamento da coleta — foi exatamente esse o bug de resolves rodando
fora do `AbortSignal` da busca e somando o próprio timeout por cima.

Quando o deadline estoura, `findStreams` devolve `{ streams: [], partial: true }`
**mas a busca continua em background**. Resultado vazio ou parcial é cacheado
por pouco tempo (≤ 60s): pode ser só indexer fora do ar, e o Stremio precisa
poder perguntar de novo em breve. Handler HTTP: lista que precisa de
revalidação sai com `cacheMaxAge: 0` (vazio, parcial, debrid desconhecido).

**2. Origem BR é um campo, nunca um regex de título como única fonte.**
Providers marcam `isBr: true` no resultado cru. `looksPtBr(title)` **também**
liga o flag — tracker global hospeda dublado titulado em português, e sem isso
o item era julgado contra o nome em inglês e morria antes das vagas BR.
"Dual" sozinho em tracker global não basta; precisa de PT explícito.
`toStremioStream` converte em `_br`; `limitReservingBr` usa esse campo e o
remove antes de entregar ao Stremio.

Não volte a inferir origem por `/BLUDV|DUBLADO/i` no título **no lugar** do
flag do provider — releases de `comandotorrents`, `nerdfilmes` e
`torrentdosfilmesv2` não citam nenhum dos dois, e mesmo assim são BR.

Campos com prefixo `_` (`_br`, `_seeders`, `_quality`, `_multiWork`, …) são
**internos**. Se um deles vazar no objeto entregue ao Stremio, o player pode
rejeitar o stream.

Agregadores BR podem espelhar magnets globais: origem e áudio pertencem à
listagem que vence o merge; nunca propague `_br`/`_dubbed` do perdedor.
DUAL sem PT explícito não ganha vaga, prioridade nem autofetch só porque o
post veio de site BR.

**3. Fontes BR não publicam seeders.**
Elas entram com `seeders: 1` (0 seria descartado por `MIN_SEEDERS`). Consequência:
na ordenação elas ficam sempre por último e seriam eliminadas por releases de
centenas de seeders. Por isso:

- `sortAndLimit` corta num pool **ampliado** (`maxResults * CANDIDATE_POOL_FACTOR`),
  não no número final;
- o corte real é `limitReservingBr`, **depois** do debrid, com `BR_RESERVED_SLOTS`
  vagas garantidas.
- o teto por indexador (`jl`, fallback no `maxPerIndexer` / `qi`) roda na mesma
  passada da qualidade, dentro de `limitReservingBr`; as vagas reservadas BR
  estouram o teto sem serem cortadas, mas contam na cota — a reserva fura o
  teto, não o amplia.

Inverter essa ordem faz as fontes BR sumirem silenciosamente.

**4. Sites BR indexam por título em português.**
"Coringa", não "Joker". `tmdb.getTitles` resolve isso e a busca dispara **duas
queries**: a em inglês para indexers globais e a em pt-BR para os listados em
`JACKETT_PT_BR_INDEXERS` (default: os cinco cards locais + `redetorrent`,
`apachetorrent`, `hdrtorrent`). Todo caminho de busca precisa carregar as duas
— inclusive fallbacks de pack. O filtro `matchesName` também aceita qualquer
um dos nomes, senão a release dublada seria descartada por não bater com o
título em inglês.

BR e `JACKETT_BARE_TITLE_INDEXERS` (os três stock) **zeram** com token extra:
além do SxxEyy, o ano do filme também sai ("Coringa 2019" → 0 no redetorrent).
Os resolvers locais ficam **fora** dessa lista: lá o ano ajuda a relevância.
Sequência em romano vira variante arábica (`numeralSearchVariant`) no mesmo
indexer, dentro do deadline original.

A varredura pt-BR nos globais é o terceiro caminho, não um substituto das duas
queries. Query da varredura = `franchiseRoot(título pt)` — "Jornada nas
Estrelas: O Filme 1979" devolve 1 resultado, "Jornada nas Estrelas" devolve 13.

**5. Release BR passa por filtro de título ESTRITO, em duas camadas.**
Os sites BR são buscadores WordPress que devolvem posts "parecidos" para query
curta: buscar "Fallout" trazia "Missão: Impossível – Efeito Fallout", "Fallout
4 (PC)" e "Cesium Fallout" — todos aprovados por `matchesName` (palavra inteira)
e `matchesEpisode` (sem pista de temporada, passa), e o lixo tomava as vagas
reservadas do item 3. `matchesBrTitle` (format.ts) endurece com regra de
prefixo (primeiro token relevante do título = primeiro do nome procurado) e
regra de ano por tipo (lógica do pacote BRDUB): filme aceita ±2 (ano do
lançamento BR) e série só condena quando TODOS os anos do post são anteriores
à estreia −2 — o ano do post de série é o da temporada, então "Fallout 2ª
Temporada (2025)" passa contra catálogo 2024. 2+ anos no título é ambíguo e
passa. Ele roda DUAS vezes:
- no pré-filtro de `resolveCardigannDownloads`, ANTES de pagar o protetor de
  link — o ano vem da própria query de filme ("Coringa 2019"), e é isso que
  corta "Coringa: Delírio a Dois (2024)" sem gastar um magnet;
- no filtro de título de `buildStreams` (`filterRelevantRaw`), com o
  `meta.year` do catálogo — sem essa segunda passada o jogo ("Fallout 4 (PC)")
  passaria pelo pré-filtro (query de série não tem ano) e só morreria no debrid.

`meta.year` vem sujo do cinemeta ("2024–" para série em andamento): extraia o
primeiro token de 4 dígitos antes de comparar, senão `Number("2024–")` é NaN e
a regra de ano condena TODAS as releases reais.

Homônimo escondido no MESMO post é outra família de falso positivo, e o título
não a pega: HDRTorrent publica "O Corvo The Crow e Dual" com magnets de três
filmes (The Crow 1994, The Raven 2012, The Crow 2024 — todos "O Corvo" em PT).
Para FILME, a guarda do magnet (`magnetYearContradicts`) decodifica o `dn=` e,
se ele cita exatamente UM ano que contradiz o catálogo por mais de ±2, corta a
release mesmo com o título casando. Só roda fora de série/pack (o ano do pack é
o da temporada) e DEPOIS do titleMatches — falso negativo aqui descartaria
release boa por ruído de ano no nome; por isso exige um único ano contraditório.

A exceção de franquia do inventário da conta (`filterInventoryRelevant`) **não**
se aplica aos indexers. Globais usam `matchesName` + estrutura + identidade de
obra delimitada pelo marcador de episódio (`matchesEpisodeWorkIdentity`) —
spin-off com o mesmo token no título não pode herdar a vaga.

**6. Autofetch BR e `dropUncached` são forças opostas.**
`dropUncached` apaga da conta do debrid o que não está em cache (sem isso cada
busca deixa download fantasma); `autoFetchBrDubbed` faz o oposto de propósito —
enfileira as melhores fontes dubladas quando nada tocável está em cache. A ponte
é `src/debrid/protected.ts`: cada hash escolhido entra em `hold` **antes** da
checagem de cache e só é liberado se o download não acontecer. Inverter essa
ordem deixa a limpeza matar o download no meio da mesma busca — na AllDebrid a
própria checagem apaga da conta o que não está pronto.

Já não é "um torrent por busca": o teto é `DEBRID_AUTO_FETCH_MAX` (1..4), com
uma vaga por candidato compartilhada entre os passes (`acquireSearchSlot`).
`cachedOnly` deixou de ser trava — mesmo no modo misto, sem dublada em cache o
play da próxima vez depende do download. O resto das travas (known, toggle,
fire-and-forget) continua.

---

## Mapa dos arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src/addon.ts` | Processo: listen, warmup, resolvers, shutdown |
| `src/routes/services.ts` | `buildServices()`: monta o `AppServices` (config, debrid, cache, metrics, jackett, …) que os handlers de rota recebem |
| `src/routes/register.ts` | `registerRoutes()` — único ponto que monta as rotas (contrato de ordem: router do addon sem config, específicas, depois router com config) |
| `src/routes/stream.ts` | `createStreamHandler`: o handler de `/stream` por cima do `findStreams` |
| `src/routes/resolve.ts` / `public.ts` / `diagnostics.ts` | `makeResolveHandler` (`/resolve`), `makePublicHandlers` (`/configure`, `/dashboard`, `/defaults.json`, `/seal-config`), `makeDiagnosticHandlers` (`/metrics.json`, `/dashboard-status.json`, `/dashboard-action.json`, `/test-indexer.json`, `/debrid-status.json`) |
| `src/routes/addon-router.ts` | Router do protocolo Stremio que substituiu o `stremio-addon-sdk` no runtime (6.1): `createAddonInterface` + `makeAddonRouter` (manifest, `/stream`, CORS, `Cache-Control`). Lê o último segmento **cru** de `req.url`: `req.params` vem decodificado e quebraria a divisão dos extras |
| `src/routes/origin.ts` / `async.ts` / `state.ts` / `types.ts` | `originOf`/`streamsNeedRevalidation`; `asyncRoute` (wrapper do Express 4); `prefetchInFlight`; `AppServices`/`HandlerFactory` |
| `src/app.ts` | Fábrica Express (`createApp()`): manifest, `createStreamHandler`, `registerRoutes` — só compõe; reexporta `asyncRoute`, `originOf`, `streamsNeedRevalidation` |
| `src/config.ts` | Padrões do operador: todo `process.env` vira config **aqui** |
| `src/runtime.ts` | Config por usuário: schema, encode/decode/selo da URL, `opts()`, `capture()`/`run()` |
| `src/br-resolvers.ts` | Carrega os cinco `*-resolver` no processo do addon |
| `src/public/configure.html` | Página de configuração (HTML/CSS/JS puro, ES5, zero build) |
| `src/providers/index.ts` | Fachada pós split 5.1: reexporta os módulos irmãos + glue de `autofetchStatus` (não guarda estado próprio) |
| `src/providers/search-cache.ts` | `findStreams`, coalescing (`inFlight`), SWR (`debridRefreshSatisfied`, `staleRefreshEligible`, `scheduleStaleRefresh`), `hasPlayableStream` |
| `src/providers/search-orchestrator.ts` | `doSearch`, `collectRaw`, `poolCovered`, `idxPoolCovered`, `idxReleasesToRaw` |
| `src/providers/debrid-pipeline.ts` | `applyDebrid`, filtro pré-checagem, auditoria de áudio (`collectAuditCandidates`, `queueDubAudit`, `runDubAudit`) |
| `src/providers/stream-builder.ts` | `buildStreams`, `applyFileEvidence`, `applyNoticeOrigin`, `onlyNotice` |
| `src/providers/autofetch-runner.ts` | Seleção de candidatos, holds/markers, `drainNext`, recheck, settle, detecção de morte |
| `src/providers/search-plan.ts` | Isola BR/slow; query da varredura pt-BR (`franchiseRoot`) |
| `src/providers/collection-window.ts` | Balde compartilhado + graça da primeira fonte BR + `stopWhen` (fast-path da conta) |
| `src/providers/harvester.ts` | Colhedor: fila persistente de obras colhidas em fundo, freio de atividade, teto horário, varredura pt-BR nos globais |
| `src/utils/harvester-live.ts` | Camada de configuração ao vivo do Colhedor e Sementes IMDb persistida em SQLite |
| `src/utils/release-index.ts` | Índice de releases por obra (`idx:v5`): record/lookup/status — o que faz o addon responder sem Jackett |
| `src/providers/jackett.ts` | Consulta por indexer, cache `raw`, breaker, resolução Cardigann, `isBr`/`looksPtBr` |
| `src/providers/jackett-catalog.ts` | Catálogo de indexers (torznab) pra `/configure`, TTL e fallback do `.env` |
| `src/providers/indexer-status.ts` | Card online/slow/offline + `failStreak` do breaker (não sonda ao abrir a página) |
| `src/providers/prowlarr.ts` | Alternativa ao Jackett |
| `src/providers/torrentio.ts` | Pool global público da API Torrentio (Fase 1): fail-open, breaker local, `fileIdx` preservado |
| `src/providers/bludv.ts` | Scraper direto do BLUDV (fora do Jackett; default desligado) |
| `src/providers/account.ts` | Inventário pronto da conta como fonte (`fromAccount`) |
| `src/providers/autofetch.ts` | Marker, lock e vaga por busca do autofetch |
| `src/providers/demo.ts` | Big Buck Bunny — valida o pipeline sem indexer nenhum |
| `src/debrid/index.ts` | Registry + seleção por request + checagem com teto dinâmico + inventário |
| `src/debrid/file-selector.ts` | Seleção de arquivo no play: `pickFile`/`pickWorkFile`, `workCoverage`, `baseName`, erros (`WorkPickError`/`EpisodePickError`/`NoVideoError`/`DubLieError`) — extraído em 5.2, `common.ts` reexporta |
| `src/debrid/common.ts` | `magnetFor`, fetch JSON, lotes, `AuthError`/`QuotaError` — reexporta o file-selector |
| `src/debrid/protected.ts` | Hashes protegidos da limpeza durante o autofetch |
| `src/debrid/*.ts` | Um adaptador por serviço |
| `src/utils/format.ts` | Barrel pós split 5.3: reexporta os mesmos 58 nomes dos 7 submódulos (ver abaixo) |
| `src/utils/indexer-priority.ts` | `priorityMap`/`compareIndexerPriority` |
| `src/utils/tmdb.ts` / `cinemeta.ts` | Título pt-BR / título-ano do ecossistema Stremio |
| `src/utils/cache.ts` | L1 memória + L2 SQLite; cotas por namespace; `getWithStale` |
| `src/utils/cache-keys.ts` | Fonte única de versão de namespace (`NAMESPACE_VERSIONS`), prefixos legados (`raw1:`/`dinv1:`) e `prefix(ns)` |
| `src/utils/request-key.ts` | `streams:v6` + digest da conta (nunca a chave crua) |
| `src/utils/secret-box.ts` | AES-256-GCM do `dk` no install URL |
| `src/utils/sign.ts` | HMAC do `/resolve` (hash + ep + dica `w`) |
| `src/utils/deadline.ts` | `raceWithDeadline`, `remainingCheckBudget` |
| `src/utils/latest-writer.ts` | Só a escrita mais nova do passe tardio vence |
| `src/utils/logger.ts` | Níveis via `ADDON_LOG_LEVEL` (não `LOG_LEVEL` — essa é do FlareSolverr) |
| `src/utils/metrics.ts` | Contadores/histogramas do `/metrics.json` |
| `src/utils/diagnostic-guard.ts` | Token + rate limit das rotas operacionais |
| `src/utils/magnetdb.ts` | Banco de magnets por hash/adapter; panorama no dashboard: tamanhos por adapter, TTLs (e restante) e taxa ⚡ (`debrid.check.cached`/`hashes`) |
| `jackett-bludv/*.yml` | Definitions Cardigann dos indexers BR |
| `resolvers/` | Núcleo comum dos resolvers (CommonJS puro). Processo: `runtime.js`, `site-selector.js` (failover de host), `cache.js`, `http-server.js`, `flare.js`. Rede e segurança: `transport.js` (`followProtectedUrl` — o laço de saltos do protetor, um só para os cinco), `protector.js` (allowlist de host), `nested-url.js`. Conteúdo: `text.js`, `matching.js`, `search-posts.js`, `torznab.js`, `concurrency.js`. Perfis por site em `profiles/*.js` |
| `*-resolver/` | Shims de compatibilidade: `<nome>/server.js` faz `require('../resolvers/profiles/<nome>')` — a lógica está no núcleo em `resolvers/` |
| `types/domain.d.ts` | Tipos do domínio: `Stream` (união que exige ação), `ParsedSeasonEpisode`, `DebridAdapter`, `AccountStatus`, `MatchContext` |
| `test/helpers/stub.ts` | Dublê de `fetch`, `patch()` de módulo e `testOpts()` — o cast mora aqui, não espalhado |
| `test/e2e/e2e-harness.ts` | App real (`createApp`) + fetch dublê; zero rede externa |
| `Dockerfile` / `scripts/entrypoint.sh` / `docker-compose.yml` | Imagem única, supervisor, loopback |
| `scripts/magnets.ts` | Inventário/limpeza da conta |
| `scripts/check-test-list.ts` | Cobra a lista explícita do `npm test` |
| `scripts/build-assets.ts` | Copia para `dist/` os assets (`src/public`, `test/fixtures`, `jackett-bludv`), o `resolvers/` e os `*-resolver` |

Pós split 5.3, `src/utils/format.ts` virou um barrel que reexporta os mesmos
58 nomes de antes; a lógica mora nos 7 submódulos em `src/utils/` (sem ciclo,
cada um só importa dos que vêm antes): `title-normalization.ts` (base),
`episode-matching.ts` (episódio/temporada), `release-matching.ts`
(título/estrutura/filtros puros: `matchesName`, `matchesBrTitle`,
`filterRelevantRaw`, `magnetYearContradicts`, …), `audio-quality.ts`
(qualidade e áudio: `qualityFromTitle`, `looksPtBr`, …), `stream-quotas.ts`
(cotas: `limitByQualityAndIndexer`, `limitReservingBr`, …),
`search-names.ts` (queries de busca + `toStremioStream`) e
`stream-ranking.ts` (ordenação: `sortAndLimit`, `dedupeByHash`, pools do
autofetch). É o melhor lugar para testar comportamento sem subir rede.

---

## Convenções

**O typecheck é portão, não enfeite: `npm run typecheck` fica em ZERO.** Não há
mais `@ts-check` nem `@ts-nocheck` no repositório — todo `.ts` é verificado, e o
`noEmitOnError` impede build sujo. Se o contador subir, conserte antes de seguir:
1.661 erros abertos foi o estado em que o portão deixou de servir para qualquer
coisa, porque ninguém lê essa lista para achar o que importa.

**O teto de 400 linhas por arquivo é portão, com catraca: `npm run lint:lines`,**
baseline commitado em `.line-budget.json`. Arquivo NOVO acima de 400 reprova
sempre, sem escape; legado só reprova se CRESCER além do baseline — o escape é
`npm run lint:lines -- --bless`, que regrava o baseline daquele arquivo e o diff
do JSON entra no commit, visível na revisão. Quando o arquivo diminui, o script
regrava o baseline para baixo sozinho: a folga não acumula. A extração do JS/CSS
inline dos HTML do painel (§5.9) já foi feita: os módulos resultantes
(`configure-app.js`, `dashboard-*.js`) estão sob a catraca como qualquer `.js`;
os `.html` seguem fora da varredura (o filtro lê `.ts`/`.js`/`.css` — os módulos
extraídos e o CSS estão sob a catraca) — mas o
JS ancorado pelos testes continua INLINE neles por contrato (os testes regexam
corpos de função no html; mover seria quebra, ver §5.9). Sem o gatilho, arquivo
novo nasce com mil linhas e ninguém percebe até a extração ficar cara:
`vacatorrent.js` entrou com 1.025 linhas e nada reclamou.

**Tipe o que a função PRODUZ, não só o que ela recebe.** O valor está aí: por
muito tempo as anotações eram todas de entrada e nada cobrava o retorno — foi
assim que `parseTitleSeasonEpisode` ganhou um campo novo e quebrou oito
`deepEqual` que só apareceram ao rodar a suíte. Os contratos de domínio ficam em
`types/domain.d.ts`, e três merecem cuidado especial:

- **`Stream` é uma união que exige AÇÃO** (`url`, `infoHash`, `externalUrl` ou a
  marca interna `notice`). Um `{ name }` puro é reprovado na origem — ele não é
  renderizado por cliente nenhum e some da tela sem erro. Anotar a fábrica
  (`toStremioStream`) é o que faz esse erro aparecer em compilação.
- **`ParsedSeasonEpisode`** distingue `complete` (série inteira) de `seasonPack`
  (uma temporada nomeada). Mexer no retorno sem mexer no typedef falha na hora.
- **`DebridAdapter`** é o contrato dos cinco serviços. Foi anotando
  `debrid.current()` que apareceu um `accountStatus: Promise<unknown>` enquanto
  o código lia `status.limitUsed` — contrato subespecificado que nenhum teste
  pegaria.

**Falso positivo do compilador se resolve tornando o código verificável, não com
cast.** `Number.isFinite(x)` guardado num booleano intermediário não estreita
tipo; extrair a variável (`const fairUse = … ? Number(x) : null`) mantém o mesmo
comportamento e dispensa a mentira. Cast é último recurso, e quando for
inevitável, concentre num helper com comentário — como o dublê de `fetch` em
`test/helpers/stub.ts`, que guarda o cast num lugar só em vez de espalhar 180.

**Leitura de campo inexistente NÃO é pega** (em `.ts` como era em `.js`): o que
o portão cobre é construção de objeto fora do contrato e argumento de tipo
errado. Para a classe de bug que mais dói aqui — como tracker brasileiro escreve
título — quem protege continua sendo teste com dado real, não o compilador.

**Idioma.** Comentários, logs e mensagens em **português**. Nomes de variáveis e
funções em **inglês**. Mantenha assim.

**Comentários explicam o porquê, não o quê.** O padrão do repositório é comentar
a decisão não óbvia e a consequência de desfazê-la:

```js
// O site não publica seeds. 0 faria o filtro MIN_SEEDERS descartar a
// release antes de consultar o swarm; 1 é o valor neutro.
seeders: 1,
```

Não escreva `// itera sobre os resultados`.

**Logs são prefixados por subsistema**: `[search]`, `[jackett]`, `[bludv]`,
`[debrid]`, `[autofetch]`, `[account]`, `[cache]`, `[tmdb]`, `[resolve]`,
`[br]`. Use `console.warn` / `log.warn` para degradação esperada (indexer fora
do ar) e `error` só para falha real. Nível do addon: `ADDON_LOG_LEVEL`, nunca
`LOG_LEVEL`.

**Nada de config hardcoded.** Todo número ajustável entra em `src/config.ts` com
default e comentário, e no `.env.example` com a mesma explicação. Timeouts
literais espalhados pelo código são bug em potencial — eles escapam da cadeia de
orçamento do item 1.

**Falha de rede nunca derruba a busca.** Todo fan-out usa `Promise.allSettled`
(ou o equivalente no `collection-window`); todo provider tem `try/catch` que
devolve `[]` e loga. Um indexer fora do ar significa menos resultados, nunca
erro para o usuário.

**Circuit breaker** (`JACKETT_BREAKER_*`): indexer `offline` em N amostras
seguidas deixa de receber orçamento até o cooldown. `slow`/`degraded` não
abrem o circuito. `/test-indexer.json` ignora o breaker — é ele quem repara.
A varredura pt-BR **tardia** também ignora (`ignoreBreaker: true`): o dublado
raro mora justamente no indexer recém-derrubado, e fora do caminho da resposta
ela não gasta prazo de ninguém. A varredura **inline** não ignora — ela divide
o orçamento com a resposta.

---

## Armadilhas conhecidas

- **Importar `src/addon.ts` sobe o servidor.** Testes usam `createApp()` de
  `src/app.ts`. Não copie rotas no harness — o e2e já instancia o app real.
- **Caminho relativo mudou de profundidade com o `dist/`.** O código roda de
  `dist/src/...`, então `__dirname` e `require`/`import` relativos apontam para
  dentro de `dist/`. Dois casos já mordidos: o `DB_PATH` do cache precisa subir
  **três** níveis para achar `data/cache.db`, e os cinco `*-resolver` são
  carregados por `../<nome>-resolver/server` — no container eles têm que ser
  copiados para **`/app/dist/`**, não `/app/`. **Localmente isso passa
  despercebido** porque o `npm run build` já copia os resolvers para `dist/`; só
  o `docker run` revela. Mesma armadilha vale para asset: o `tsc` não copia
  `src/public/`, quem copia é o passo do `npm run build`.
- **"Temporada Completa" no singular é pack de UMA temporada, não da série.**
  `2ª Temporada Completa` cobre só a 2ª; `Todas as Temporadas`, `Série Completa`
  e `Temporadas Completas` (plural) é que cobrem tudo. Tratar o singular como
  cobertura total fazia S01/S02 entrarem na lista do S04E06. O parser também lê
  **lista de ordinais antes do plural** (`1ª 2ª 3ª … 7ª Temporadas`), que a regra
  de temporada única enxergava como só a última. Varredura em 3.794 títulos reais
  dos sete indexers BR: 470 passaram a ser cortados em alguma temporada, nenhum
  falso corte. O padrão mais comum entre eles é o post "Todas as Temporadas"
  cujo arquivo é **uma** temporada (`… Dual 3ª TEMPORADA … 8.27 GB`).
- **Pack pode mentir na descrição, e o `pickFile` entrega o maior arquivo.**
  Medido em True Detective: dois posts do NerdFilmes anunciados como "4ª
  Temporada (2024) DUBLADO", com ⚡, continham a **3ª temporada em inglês** —
  `pickFile(S4E6)` não achou `S04E06` e caiu no fallback do maior vídeo,
  devolvendo `S03E04`. Nenhum filtro de título pega isso: o título casa
  perfeitamente. O único ponto que vê a verdade é o `resolveLink`, onde os
  arquivos reais são listados. Ao mexer no `pickFile`, lembre que "não casou o
  episódio" e "não há episódio no nome" são casos **diferentes**: o primeiro é
  prova de conteúdo errado.
- **A PASTA do torrent carrega o `SxxEyy`, então todo arquivo dentro dela casa
  o episódio pelo caminho.** Medido em House of the Dragon S01E01 (fonte
  dublada do comandotorrents): a pasta era
  `House.of.the.Dragon.S01E01.1080p.FULL.WEB-DL.DUAL.5.1/` e os três arquivos
  dentro dela — propaganda de 22 MB, um `.mp4` de 65 MB e o episódio de 4,6 GB
  — casavam igual. O desempate era `strong[0]`, a **ordem do torrent**, que não
  diz nada sobre conteúdo: o player abria
  `1XBET.COM_promo_SHREK_dinheiro_livre.mp4` com a legenda certa por cima.
  Por isso o casamento mede primeiro o **nome do arquivo** (onde está a
  informação que distingue) e só cai para o caminho inteiro quando nenhum nome
  traz o marcador; empate real entre arquivos do MESMO episódio é decidido por
  tamanho. Não volte a decidir isso por ordem.
- **`isSiteAd` precisa pegar domínio COM texto depois.** Ele nasceu casando só
  o nome que é o domínio inteiro (`www.BLUDV.com.mp4`) e deixava passar
  `1XBET.COM_promo_SHREK_dinheiro_livre.mp4`. O separador exigido depois do TLD
  é `_`/`-`/espaço, **nunca ponto**: com ponto, `Filme.se.algo.mkv` (nome
  legítimo cujo token do meio é um TLD) viraria propaganda e o arquivo real
  sairia do pool. Ao afrouxar esse regex, rode
  `test/debrid-pick-work.test.ts` — o caso do TLD acidental está lá.
- **`matchesName` é o único portão de TÍTULO do caminho global de série — e a
  razão 0.6 é frágil em nome curto.** No caminho BR, `matchesBrTitle` encadeia
  três guardas por cima dele (precisão, prefixo, ano); no global de série, as
  guardas seguintes abstêm-se — `matchesEpisodeWorkIdentity` só decide quando o
  título carrega marcador de episódio (release de filme não carrega), e o
  prefixo/sequência de filme são pulados de propósito ("S01E02.From"). Caso
  medido: "Shaun of the Dead (2004)" entrava na busca de "The Walking Dead:
  Dead City" porque o nome pedia [the, walking, dead, dead, city] e o candidato
  marcava the + dead + dead = 3/5 = 0.600, exatamente o corte. Duas regras
  consertaram e **não podem voltar atrás**: `wanted` deduplicado (token
  repetido no nome não vale acerto dobrado) e artigo inglês fora do conjunto
  significativo (o filtro de comprimento `> 2` foi calibrado para ruído pt-BR
  de 1–2 letras e não pegava "the"; use o `LEADING_ARTICLES` existente, não
  uma lista nova — e preserve o fallback de nome curto que É artigo: "The
  Bear", "From"). Para a lacuna de ano, a série global ganhou a metade do ANO
  da `matchesTitleStructure` (helper `yearContradicts`, mesma regra que o BR
  já aplicava: só condena quando TODOS os anos do título são anteriores à
  estreia −2). Quanto mais curto o nome, mais exposta a razão: série-mãe
  "The Walking Dead" fazia 2/3 = 0.667 — pior que o spin-off.
- **"Sumiu o ⚡ de todos os streams" quase nunca é bug de código.** No fluxo
  normal, stream fora do cache sai **sem prefixo nenhum** (P2P); ver
  `[AD download]` em 100% dos itens significa que a checagem de cache não
  completou. Causas medidas, em ordem de frequência: conta do debrid no teto de
  magnets, chave recusada, e só então prazo. Cheque `/debrid-status.json` antes
  de investigar o pipeline — foi um caso real em que o "culpado" aparente era um
  commit de formatação de título.
- **"A primeira resposta veio sem dublado" também costuma ser config/prazo, não
  matching.** O BR existe e chega; o problema é quando (depois do deadline, no
  passe tardio) e o que o `cachedOnly` faz com os que chegam frios. Com
  `DEBRID_SHOW_UNCACHED_BR=false` (default), BR fora do cache é ocultado pelo
  corte — e `limitReservingBr` só traz de volta o que veio a tempo. Um log
  `[debrid]` distinto avisa "N fonte(s) BR fora do cache ocultada(s) pelo
  cachedOnly" apontando a página; a métrica que separa "veio e foi ocultado" de
  "nunca veio" é o bloco `searchFirst` do `/dashboard-status.json`. Ela mede
  sobre a primeira resposta **fria** de uma busca síncrona real e conta
  **fontes, não buscas**: `responses` é o denominador — uma resposta por
  primeira build COLD CONCLUÍDA DENTRO DO PRAZO (a que estourou o deadline cai
  no `search.deadline`, não conta aqui); `brFound`/`brCached`/`brHidden` veem o
  que entrou e o que o corte tirou (funil no buildStreams + corte no debrid);
  `brVisible` é quanto foi realmente entregue na abertura; e `brLate` soma só o
  **delta** positivo que os recaches tardios agregam acima do máximo já visto,
  nunca o total repetido (um recache não re-cobra o que o anterior já cobrou, e
  um recache que correu enquanto o first ainda não confirmou não conta nada).
  SWR, prefetch e o `observeFirstPass`/`observeLatePass` do `finish` separam a
  primeira resposta dos recaches. Não "consertar" trocando o default de
  `showUncachedBr` para `true` antes de medir — muda de comportamento
  silenciosamente para quem escolheu `cachedOnly` e o próprio log + métrica
  existem justamente para decidir com base na janela de dados.
- **Fase 2 de timing da primeira resposta (métricas em `/metrics.json`).** Onde
  o bloco `searchFirst` do dashboard conta **fontes**, cinco timers registram
  o **tempo** da mesma abertura: `search.first.metadata`, `search.first.collect.global`,
  `search.first.collect.br`, `search.first.debrid` e `search.first.total`. Os
  cinco são emitidos **atomicamente no mesmo bloco** e só quando o
  `search.first.responses` conta — ou seja, apenas quando a primeira build
  COLD de uma busca síncrona real terminou **dentro do deadline**. Corte por
  prazo não gera bloco: cai em `search.deadline`; `search.response` e
  `search.metadata` continuam registrando a execução quando ela termina em
  background, fora deste bloco.
  Global e BR são **envelopes paralelos** da janela de coleta: cada um mede o
  próprio orçamento e **não se somam** — o cheque não aprovaria `total ≈
  metadata + global + br + debrid`. Invocações **sequenciais** da mesma obra
  (episódio + pack complementar) **acumulam**: a abertura verdadeira é a do
  primeiro call; os demais entram juntos no mesmo `search.first`. Inventário da
  conta e leitura do índice aparecem como **residual no `total`** (não têm
  envelope próprio). O `search.first.total` mede a **execução fria**; quando o
  prefetch é promovido, ele inclui o **head-start** já feito em background.
- **A chave do `.env` e a da URL de instalação são independentes.** O app manda
  a dele selada no segmento de config; trocar só o `.env` não muda nada para
  quem já instalou, e uma pode estar quebrada enquanto a outra funciona.
- **AllDebrid tem `cacheCheck: true`.** Não trate como Real-Debrid. A consulta
  é upload, não aborta, e precisa da limpeza. README da tabela "consulta de
  cache = não" fala do endpoint instantâneo aposentado, não do comportamento
  atual do adaptador.
- **O snapshot que protege o acervo do usuário EXPIRA, e o refresh nunca é
  aguardado.** `ALLDEBRID_PREEXISTING_TTL_MS` (300s) existe porque o usuário
  também administra a conta fora do addon: uma referência congelada por
  processo autorizava apagar o que ele adicionou depois do boot. Duas regras
  que não podem ser invertidas ao mexer em `knownBefore`/`checkCached`:
  1. **Fail-safe fecha.** Enquanto `hashes` for `null` — refresh em voo,
     inventário que falhou, primeiro carregamento — os prontos ficam
     **protegidos**. Ausência de referência nunca autoriza remoção.
  2. **O refresh por TTL roda em fundo.** Só o PRIMEIRO inventário da conta é
     esperado, e mesmo esse com teto (`waitInventory`, limitado pelo
     `DEBRID_CHECK_FLOOR_MS`). Aguardar o refresh dentro do `checkCached` era
     um bug real: colocava um `/magnet/status` (timeout padrão de 6s, contra
     uma reserva de 4500ms) dentro do prazo da resposta uma vez a cada TTL —
     e, com o endpoint fora do ar, em TODA busca, porque a falha limpa o
     registro e a passada seguinte tentava de novo. Testes:
     `test/debrid-drop-uncached.test.ts`, que mede o tempo gasto.
- **`DEBRID_DROP_READY` e `DEBRID_DROP_UNCACHED` são switches independentes.**
  São dois lotes separados (`dropReady` e `dropDownload`) com métrica própria
  (`debrid.dropped.download`). Já foram um `if` só, e desligar o de download
  desligava silenciosamente a limpeza dos prontos.
- **O Link do indexer é input de terceiro.** `resolveDownloadMagnet` passa por
  `isSafeDownloadUrl` (`src/utils/net-safety.ts`) antes do fetch: bloqueia
  esquema não-http(s), loopback, RFC1918, CGNAT, link-local (incluindo o
  `169.254.169.254` de metadado de nuvem), multicast, reservados e os
  equivalentes IPv6 — ULA, link-local, IPv4-mapeado, 6to4, NAT64. O `fetch`
  usa `redirect: 'manual'`, então não há bypass por 302. **A proteção é sobre
  o literal**: hostname público que resolve para IP privado passaria, e fechar
  isso exigiria validar DNS antes do fetch — resíduo aceito de propósito, para
  não transformar indisponibilidade de DNS em falso bloqueio. `JACKETT_ALLOW_
  PRIVATE_DOWNLOAD_IPS=true` é o escape para quem roda resolvedor em rede
  privada nesse caminho.
- **Rota async no Express 4 precisa do `asyncRoute`.** O Express 4 não
  encaminha rejeição de handler `async` para o middleware de erro: sem
  wrapper, a requisição pendura até o cliente desistir. Toda rota async de
  `src/app.ts` vai embrulhada em `asyncRoute` (loga e responde 500 JSON). O
  `process.on('unhandledRejection')` do `src/addon.ts` é a rede de baixo, para
  promessa de fundo — **não** substitui o wrapper, e usá-lo como desculpa para
  não embrulhar uma rota troca crash ruidoso por requisição pendurada.
- **`cache.db` corrompido é renomeado, transiente não.** `openDatabase` só
  move para `.corrupt` e recria quando o erro é corrupção de verdade
  (`SQLITE_CORRUPT`/`SQLITE_NOTADB`, "malformed", "not a database"). `SQLITE_
  BUSY` (segunda instância no mesmo volume), stall de I/O e `EACCES` caem em
  memória e tentam de novo na próxima subida — renomear neles apagaria cache
  vivo por um glitch.
- **Mudou regra de matching? O rebuild do container NÃO invalida o cache.**
  `data/cache.db` é volume: sobrevive a `docker compose up -d --build`, e o
  `streams:v6` (lista pronta) e o `idx:v5` (acervo de releases já aprovadas)
  continuam servindo o que o filtro **antigo** deixou passar. Custou uma
  validação falsa: a correção estava no container, o teste isolado passava, e
  a resposta HTTP continuava trazendo o item errado. Depois de mexer em
  filtro/matching, zere antes de reconsultar:

  ```
  curl -s -X POST http://127.0.0.1:7000/dashboard-action.json \
    -H 'Content-Type: application/json' \
    -H "X-Indexer-Test-Token: $JACKETT_TEST_TOKEN" \
    -d '{"action":"clear-cache","confirm":true}'
  ```

  O header é `X-Indexer-Test-Token` (não `Authorization`) e `confirm: true` é
  obrigatório. Escopo por namespace (`{"scope":{"namespace":"streams"}}`) NÃO
  basta quando a regra afeta o índice — o `idx:v5` reentrega o item por outro
  caminho. Use o escopo global.
- **Ação destrutiva do painel exige `{"confirm": true}`.** `clear-cache` e
  `sweep-dead` devolvem 400 `confirmation_required` sem ele. São globais: não
  há escopo por instalação hoje.
- **Os sites BR trocam de domínio com frequência.** `BLUDV_URL`,
  `COMANDOTORRENTS_URL`, `NERDFILMES_URL`, `TORRENTDOSFILMES_URL` são
  configuráveis. Os resolvers ainda têm failover interno por saúde de **rede**
  (DNS/conexão/timeout — 0 resultados não troca de host). Parser quebrado
  geralmente é mudança de layout do WordPress, não bug de lógica.
- **Redirect permanente para domínio fora da allowlist vira fonte morta
  silenciosa.** O nerdfilmes migrou `xnerdfilmes.net` → `nerdviatorrents.net`
  (301) e o host novo não estava em `FALLBACK_SITE_SUFFIXES`: toda busca caía
  em `blocked_host` — que o `isNetworkError` exclui de propósito (erro de
  aplicação prova que o host respondeu), então o failover nunca sondava e o
  sintoma era "0 resultados" para sempre. O domínio novo precisa entrar em
  DOIS lugares: a allowlist (`FALLBACK_SITE_SUFFIXES` no
  `<nome>-resolver/server.js`) e o default em `src/config.ts`
  (`resolvers.<nome>Url`), que o carregador embutido injeta no `SITE_URL`
  quando a env falta. Até 2026-08 esse default não era lido por ninguém e o
  modo embutido caía no default hardcoded do server.js: editar config.ts era
  um no-op silencioso. O painel também passou a mostrar o host EFETIVO
  (`activeSite`, do seletor) em vez da env crua.
  O erro agora viaja com o host (`blocked_host:<host>`) e a busca loga warn
  distinto citando-o — fonte BR que só devolve vazio: procure esse warn antes
  de culpar o parser.
- **O bludv VOLTOU (2026-08-28), atrás de challenge do Cloudflare.** A queda
  por copyright (ACE) de agosto/2026 durou semanas: `bludvfilmes.xyz` → 301 →
  `bludvfilmes1.xyz`, que respondia 522 (origin morto) — e `bludvfilmes.org`
  ainda cai na página "Website is no Longer Available" da **Alliance for
  Creativity and Entertainment (ACE)**. Na revalidação de 2026-08-28 o
  `bludvfilmes1.xyz` passou a responder **403 "Just a moment..."** (origin
  vivo, só CF) e a passagem pelo FlareSolverr acima resolveu sem nenhuma
  mudança de código: busca real devolveu 11 resultados com magnet em ~2s
  (sessão quente) e o `/test-indexer.json` do card ficou verde. Os magnets
  voltaram a ser **diretos no HTML do post** (sem protetor). `bludvfilmes.net`
  e `bludv.to` continuam parkeados (ParkLogic) — inúteis como fallback.
- **O resolver bludv ganhou passagem pelo FlareSolverr** (para quando o site
  voltar): `fetchText` agora, ao receber 403 do Cloudflare, re-resolve via
  `POST <FLARE_SOLVERR_URL>/v1` e memoriza a sessão (`cf_clearance` + userAgent)
  por host em `flareSessions` (TTL `FLARE_SESSION_TTL_MS`, 20min). O fetch
  direto seguinte do MESMO host reusa o cookie sem pagar os ~20s do browser;
  `onDomainChange` limpa a sessão (o cf_clearance é por host). Só o domínio
  precisa estar na allowlist/candidatos — `bludvfilmes1.xyz` já entrou em
  `FALLBACK_SITE_SUFFIXES`.
- **Os protetores de link também trocam de host.** O torrentdosfilmes migrou
  de `systemads.net` para `systemads1.com` e TODO magnet passou a ser barrado
  porque só o host antigo estava na lista permitida. Magnet que some de um
  resolver só: cheque a allowlist do protetor antes de culpar o parser.
- **Vaca Torrent (vaqueirofilmes.com) tem protetor de múltiplos saltos.** A
  cadeia é `systemtech.space` → `t.co` → relay → landing `vacadb.org`
  (`URL_ETAPA2`) → gate-2 com o magnet em base64 no atributo `data-link` do
  body. Os contadores de 50s/clique/nova-aba são teatro client-side — o
  resolvedor replica tudo via HTTP, com seedCookies `enc_liberado` e
  `enc_etapa1_visto`, e decodifica o `data-link` (~7 saltos, ~1-2s em sessão
  quente). `vacadb.org` e `t.co` são hosts **assert-only** (endpoint do
  protetor, nunca descoberta). O domínio histórico `vacatorrentmov.com` faz
  301 → `vaqueirofilmes.com`; os dois ficam na allowlist do perfil para o
  redirect não virar `blocked_host`.
- **O laço de saltos do protetor é UM só, em `resolvers/transport.js`.** Os
  cinco perfis chamam `followProtectedUrl`; nenhum tem laço próprio. Isso
  importa porque é ele que chama `assertAllowedUrl` a cada salto — o mutante
  MUT-06 do harness adversarial cobre os cinco por esse caminho. Se algum
  perfil voltar a escrever o próprio laço, ele sai da cobertura sem que teste
  nenhum reclame. O teste do scheme é case-insensitive e a saída sai
  normalizada em `magnet:` minúsculo: o NerdFilmes publica `MAGNET:` em parte
  dos botões, e foi só por causa disso que ele teve laço próprio um dia.
- **Fontes BR não publicam tamanho por botão.** Os resolvedores mandam o
  sentinela "1 KB" (o Jackett exige o campo, e "0 B" invalida a release
  inteira no filtro de tamanho do cardigann); o addon trata ≤ 1 KB como
  desconhecido em vez de exibir valor inventado. Não "conserte" isso.
- **Post BR publica o blob de todas as qualidades como tag, e o prefixo diz
  "Dublada e Dual" mesmo no botão legendado.** Títulos REAIS do hdrtorrent:
  `"Fallout 1ª Temporada Dublada e Dual 1ª TEMPORADA LEGENDADA 720P 1080p,
  2160p, 720p, HD, WEB-DL"` — o sufixo separado por vírgula lista TODAS as
  qualidades do post, e o prefixo é convenção do site, não descrição do botão.
  Sem cortar o blob (`stripQualityTagBlob`), `qualityFromTitle` casava o
  "2160p" e classificava um botão 720P como 4K; sem a regra do **marcador mais
  específico vence**, `audioFromTitle` devolvia Dual para LEGENDADA. Duas
  consequências que não podem voltar: (1) o rótulo errado ocupava vaga BR
  reservada, enchia a cota de 4K com não-4K e dirigia o autofetch; (2) o
  índice de releases PERSISTE `dubbed`/`quality` com os mesmos classificadores
  e vive semanas — **corrigir classificador exige bump da versão do namespace
  (`idx:v5`), senão o conserto não aparece em obra já indexada**.
- **Reserva BR é POR FAIXA, e pack cobre faixa sem dublado próprio.**
  `BR_RESERVED_PER_QUALITY` garante até N fontes BR por balde de qualidade —
  a reserva global antiga deixava o 1080p BR abundante consumir tudo e a faixa
  4K/720p sem BR mesmo existindo fonte. Quando a faixa não tem release
  dublada PRÓPRIA, o pack dublado da temporada preenche a vaga dela (Fallout
  real: 720p/4K só legendado, dublado só no pack 1080p) — o áudio PT existe
  dentro do arquivo e o `pickFile` extrai o episódio. O pack nunca desloca
  dublado próprio nem ocupa duas vagas.
- **Não adicione indexers com FlareSolverr a `JACKETT_SLOW_INDEXERS`**
  (1337x, kickasstorrents…). O desafio Cloudflare é re-resolvido a cada busca
  (13–24s medidos só pra abrir a primeira página); eles abortariam igual, só
  mais tarde e gastando Chromium. Fora da lista de indexers é o lugar deles.
- **Buscador WordPress engasga com `:`** — `bludv.search` remove antes de
  consultar. Sintomas: título com subtítulo volta vazio.
- **Buscador WordPress BR devolve 0 para QUALQUER query acentuada.** Medido
  ao vivo em 5 títulos × 5 indexers BR: "Extermínio" → 0, "Exterminio" →
  8–16; com acento sempre 0. Por isso o `shapeSearchQuery` aplica
  `stripDiacritics` sob `isBr` — tira SÓ o diacrítico (caixa e pontuação
  ficam; `normalizeTitle` destruiria a query). Não "uniformize" aplicando aos
  globais: eles casam bem com acento (TPB achou 6 para "Extermínio") e a
  varredura pt-BR roda neles. O filtro pós-indexer não precisou mudar —
  `normalizeTitle` normaliza os dois lados.
- **`node:sqlite` não existe no Node 20.** `engines` declara `>=20` e o CI roda
  a matriz 20/22; o `openDatabase` faz `require` lazy dentro de `try/catch` (via
  `createRequire`, porque `import` estático quebraria o carregamento) e cai só
  em memória quando o módulo não existe. Não troque esse lazy por import
  estático: derruba o addon inteiro na versão sem o módulo.
- **HMAC do `/resolve` cobre a dica `w`.** Mudar o formato da rota ou os
  parâmetros do play exige manter todos eles dentro da assinatura. Sem `w` a
  string é a antiga.
- **Instalação sem config usa a `DEBRID_API_KEY` do `.env` por padrão.** Numa
  instância pública isso significa terceiros gastando a conta do operador.
  Defina `DEBRID_ALLOW_ENV_KEY=false` para transformar instalação sem `dk` em
  P2P puro; a chave explícita e selada do usuário continua funcionando.
- **`src/public/` não passa por build.** É HTML/CSS/JS servido cru, e o JS é ES5
  por escolha (roda no WebView de Fire TV e smart TV). Não introduza sintaxe
  moderna nem bundler ali.
- **O cache persiste em SQLite** (`data/cache.db` via `node:sqlite`,
  experimental no Node 22). Se o runtime não tiver o módulo o addon segue só
  em memória sem derrubar nada; `CACHE_PERSIST=false` desliga de propósito.
  Entrada antiga que era só um array ainda é lida (`findStreams`).
- **Suíte de testes cobre o que é puro e o e2e com fetch dublê.** `npm test`
  é a lista explícita; `npm run test:complete` cobra que nada tenha ficado de
  fora — e também que os 6 harnesses existam, compilem para `dist/` e estejam
  referenciados em algum script do `package.json` (eles ficam fora do CI, e
  sem essa checagem apodreciam sem ninguém notar). `npm run test:nerdfilmes`
  cobre um resolver contra a rede. Ao mexer em matching, debrid, cache,
  runtime, rotas ou o fluxo de busca, estenda `test/` (incluindo o tier e2e se
  o contrato HTTP mudou). Para o resto, `npm run smoke` ou um script pontual
  em `node -e`.
- **O harness adversarial MUTA o `dist/`.** `test/empirical-e2e-challenger.ts`
  injeta defeitos nos arquivos construídos para provar que a suíte os pega.
  Ele guarda o conteúdo original em memória e restaura em `finally` **e** nos
  handlers de `SIGINT`/`SIGTERM`/`uncaughtException`/`exit`. Se você adicionar
  uma mutação, ela tem que entrar na mesma lista de snapshot — mutação fora
  dela deixa o `dist/` corrompido quando o harness é interrompido, e o sintoma
  seguinte é um teste "falhando" que não tem nada a ver com o seu commit.
- **`assert.deepEqual` do `node:assert/strict` estreita o tipo.** A assinatura
  é `asserts actual is T`: depois de `assert.deepEqual(lista, [])`, o TS trata
  `lista` como `never[]` e qualquer uso posterior (`.includes(n)`) vira erro de
  compilação. Em asserção intermediária use `assert.equal(lista.length, 0)`.
- **`BR_RESOLVERS_HOST` é o único jeito de alcançar os resolvers.** Os cards
  Cardigann chamam `http://{{ ... }}/...` montado com essa env; no container
  único ela é `127.0.0.1`. Os resolvers escutam em 8700–8704 **só dentro do
  container** — nenhuma dessas portas é publicada no host.
- **Jackett no alpine é self-contained** (binário com libcoreclr embutida):
  precisa de `icu-libs`/`zlib`/`libstdc++` e das envs `XDG_CONFIG_HOME=/config`
  + `TMPDIR=/run/jackett-temp`. O FlareSolverr é python puro + chromium/chromedriver
  do apk (chromedriver precisa estar em `/app/chromedriver`, caminho hardcoded
  no código dele) + `xvfb`. Tudo isso já está no Dockerfile — se trocar a base,
  revalide a lista de pacotes.
- **Logo do addon é PNG.** O Stremio pede 256×256 png; SVG na lista de addons
  cai no ícone de engrenagem. `/configure` continua usando o SVG.
- **Item de aviso não é stream tocável.** Não use `streams.length > 0` como
  prova de lista boa (SWR, `complete` do finish, `hasPlayableStream`).
- **Antes de mudar matching, palavra, lista de indexer ou classificação
  BR/dublado**, meça no Jackett de verdade (saúde, query pt-BR vs título nu vs
  SxxEyy, varredura, breaker). Chute de regex nesse caminho é a forma mais
  cara de "consertar" um falso positivo.
- **`overrides.path-to-regexp` no `package.json` fecha um ReDoS de verdade,
  não ruído de `npm audit`.** O Express 4 depende diretamente de
  `path-to-regexp@~0.1.12` (`<=0.1.12` é vulnerável — 3 advisories de
  backtracking catastrófico), e o router próprio expõe
  `/stream/:type/:id/:extra?.json` sem `basic_auth` por padrão. O override
  força `^0.1.13` (mesma major, já corrigida) em toda a árvore. O
  `stremio-addon-sdk` ficou apenas em `devDependencies`, como referência nos
  três e2e que constroem um addon sintético; a cadeia
  `inquirer → external-editor → tmp` não entra na imagem nem em
  `npm audit --omit=dev`. Não faça `npm audit fix --force`.

## Git

Branch de trabalho: `esm`. Commits em português, prefixo
convencional (`feat:`, `fix:`). `adon-power-movie` é a linha antiga
(pré-migração TS/ESM) — o deploy e o cron que ainda a observam precisam ser
realinhados ou a `esm` precisa ser merged. `.env` é ignorado e **contém chaves
reais** — nunca faça commit dele nem cole seu conteúdo em output.
