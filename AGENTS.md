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
- **Três dependências**: `express`, `stremio-addon-sdk`, `dotenv`. Sem lodash,
  sem axios, sem cheerio — HTTP é `fetch` nativo e HTML é parseado com regex.
  **Não adicione dependências sem necessidade real.**
- **Dois módulos de processo, papéis distintos:**
  - `src/app.ts` — fábrica do Express (`createApp()`): manifest, rotas, stream
    handler. Sem `listen`, sem warmup, sem carregar resolvers. É o que os
    testes importam.
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
- Os quatro `*-resolver` **não são containers**. `src/br-resolvers.ts` os
  carrega no processo do addon, cada um na própria porta (8700–8703), porque
  todos leem `PORT`/`SITE_URL` no `require`. `BR_RESOLVERS_EMBEDDED=false`
  volta ao modo de processos separados (não é o caminho de produção).
- O healthcheck do Dockerfile é **duplo** (`/manifest.json` na 7000 + API do
  Jackett na 9117 via `node -e fetch`) — healthcheck que olha só o addon deixa
  Jackett morto passar despercebido.
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

**Três harnesses não passam pelo `npm test`** — `test:stress`,
`test:adversarial` e `test:adversarial-m1` rodam código de bancada que o CI
nunca executa. Quebra neles só aparece no dia em que você precisar deles; rode
antes de mexer em `test/` para ter linha de base.

Quando "o ⚡ sumiu de todos os streams", comece por aqui — é diagnóstico, não
adivinhação:

```bash
curl -H "X-Indexer-Test-Token: $JACKETT_TEST_TOKEN" http://127.0.0.1:7000/debrid-status.json
```

O mesmo token abre `/metrics.json` e `/test-indexer.json`. Sem
`JACKETT_TEST_TOKEN` no `.env` os três devolvem 503; token errado, 401.

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
             ├─ cache SWR (streams:v5)          ← só lista completa + debridKnown + tocável
             ├─ coalescing inFlight
             └─ doSearch
                  ├─ cinemeta.getMeta  ─┐ paralelo
                  ├─ tmdb.getTitles    ─┘  (título pt-BR)
                  ├─ collectRaw          ← search-plan + collection-window + graça BR
                  │    ├─ jackett.search (globais EN, agrupados)
                  │    ├─ jackett.search (BR/slow isolados, query em pt-BR nos BR)
                  │    ├─ prowlarr.search
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
inglês não o encontra. Roda no plano crítico se couber; senão na fila
tardia, com `recordStatus:false` e `ignoreBreaker:true`.

### Configuração por usuário (`src/runtime.ts`)

Modelo Torrentio: as preferências viajam **codificadas na URL de instalação**
(`/<base64url>/manifest.json`), não em banco. O servidor é stateless.

- `config.js` = padrões do **operador** (`.env`), estáticos, carregados uma vez.
- `runtime.js` = overlay do **usuário**, por requisição, em `AsyncLocalStorage`.

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
| `p` | `providers` | jackett / prowlarr / demo |
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

Ordem das rotas em `app.js` é significativa: as rotas sem config vêm **antes**
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
| Real-Debrid | `false` | sem consulta; o play adiciona o magnet |
| Debrid-Link | `false` | idem |

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
(em `common.js`) **propaga o erro quando todos os lotes falham**: token inválido
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
(`protected.js`), o que **já era do usuário** (`knownBefore`) e, enquanto o
inventário não carrega, **ninguém** — o `null` é o fail-safe. Como o
`/magnet/upload` é idempotente e a resposta não diz se criou ou reaproveitou
(`{magnet, hash, name, size, ready, id}`, sem data), o adaptador inventaria a
conta uma vez por processo.

Lixo que a limpeza por busca nunca alcança (magnet morto que ninguém pesquisa)
é a varredura periódica `sweepDead` (`DEBRID_SWEEP_DEAD`). Ao contrário do
`dropReady`, ela **não** poupa o inventário do usuário: estado terminal não é
escolha de ninguém. Sem isso, mortos ocupam vaga até a AllDebrid recusar até
o `/magnet/delete` com 503.

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

Para adicionar um serviço: crie o adaptador, registre em `ADAPTERS` e pronto —
`SERVICES` alimenta o seletor da página automaticamente.

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

`DEBRID_RESOLVE_UNCACHED` (operador, não está no schema) manda o não-cacheado
pelo `/resolve` marcado `[AD download]`. Default off: escreve na conta a cada
play de fonte fria. `showUncachedBr` (`bu`) é outra coisa — deixa as vagas BR
como P2P enquanto o debrid baixa.

O registry também expõe `enqueue()` para o **autofetch**. Sem fonte dublada
tocável em cache, o addon manda o debrid baixar candidatos para o play da
próxima vez. Travas atuais (invariante 6):

- desligável (`autoFetchBr` / `ab`); some na página quando `cacheCheck` é false;
- exige `known` — sem saber o que está em cache enfileiraríamos às cegas
  (Real-Debrid e Debrid-Link ficam de fora; neles o `/resolve` do play já
  adiciona o magnet);
- até `DEBRID_AUTO_FETCH_MAX` (1..4) torrents por busca, vaga compartilhada
  entre passe parcial e tardio;
- pool BR vazio cai em dublada global (`DEBRID_AUTO_FETCH_ANY`) e, em série,
  no pack de mais seeders (`DEBRID_AUTO_FETCH_TOP_SEEDS`);
- hold **por candidato, antes** da checagem; marker só depois do aceite;
- recheck em fundo (`DEBRID_AUTO_FETCH_RECHECK_MS`) esquece o cache da busca
  quando o download fica pronto, senão o ⚡ espera o `CACHE_TTL`;
- nunca entra no caminho da resposta — erro só vira log.

O registry também expõe `inventory()`: o que já está **pronto** na conta
(AllDebrid/TorBox; nos demais é no-op) entra na busca como mais uma fonte
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

A chave `streams:v5` isola config do usuário + digest da conta
(`request-key.js`). A versão de cada namespace vive em `src/utils/cache-keys.ts`
— bumpar lá invalida o formato antigo no boot (`loadFromDisk` apaga no disco o
que não bate com a versão corrente). Duas instalações do mesmo título **não**
compartilham a lista — ela carrega URLs de play assinadas. O trabalho caro
(Jackett + scrapers) é compartilhado mais abaixo.

| camada | chave | o que guarda | kill-switch |
|---|---|---|---|
| L1+L2 streams | `streams:v5:…` | lista já cortada, com HMAC | `CACHE_TTL=0` implícito via TTL curto / graça 0 |
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

Cotas do L1 (`cache.js`): `streams` 2000, `raw` 800, `dlmag` 4000, teto
global 12000. `raw` é o namespace gordo (~100 KB no pior caso); não suba a
cota sem refazer a conta de memória do container de 3g.

Fase 3 (cache de disponibilidade por hash) **não** está no código. Gate
documentado no plano: `debrid.check.repeated / debrid.check.hashes` > 30% em
15 min. Não implemente por palpite.

---

## Os seis invariantes que mais quebram

**1. O orçamento de tempo é sagrado.**
O cliente Stremio aborta em 10s. A cadeia é:

```
REPLY_DEADLINE_MS (9200) − DEBRID_RESERVE_MS (2800) = orçamento da coleta
BR_PARTIAL_GRACE_MS (1500), sem invadir DEBRID_CHECK_FLOOR_MS (1500)
JACKETT_INDEXER_TIMEOUT_MS (4000)      teto por indexer global, dentro do orçamento
JACKETT_BR_INDEXER_TIMEOUT_MS (20000)  total BR — PODE passar do deadline
JACKETT_DOWNLOAD_TIMEOUT_MS (8000)     teto por salto DENTRO do orçamento BR
DEBRID_CHECK_FORMAT_MARGIN_MS (500)    o que a checagem pode gastar na resposta
```

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
`JACKETT_PT_BR_INDEXERS` (default: os quatro cards locais + `redetorrent`,
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
reservadas do item 3. `matchesBrTitle` (format.js) endurece com regra de
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
| `src/app.ts` | Fábrica Express: manifest, stream handler, `/resolve`, `/configure`, `/defaults.json`, `/seal-config`, `/metrics.json`, `/test-indexer.json`, `/debrid-status.json` |
| `src/config.ts` | Padrões do operador: todo `process.env` vira config **aqui** |
| `src/runtime.ts` | Config por usuário: schema, encode/decode/selo da URL, `opts()`, `capture()`/`run()` |
| `src/br-resolvers.ts` | Carrega os quatro `*-resolver` no processo do addon |
| `src/public/configure.html` | Página de configuração (HTML/CSS/JS puro, ES5, zero build) |
| `src/providers/index.ts` | Orquestração: SWR, coalescing, deadline, collectRaw, passe tardio, debrid, corte, aviso |
| `src/providers/search-plan.ts` | Isola BR/slow; query da varredura pt-BR (`franchiseRoot`) |
| `src/providers/collection-window.ts` | Balde compartilhado + graça da primeira fonte BR |
| `src/providers/jackett.ts` | Consulta por indexer, cache `raw`, breaker, resolução Cardigann, `isBr`/`looksPtBr` |
| `src/providers/jackett-catalog.ts` | Catálogo de indexers (torznab) pra `/configure`, TTL e fallback do `.env` |
| `src/providers/indexer-status.ts` | Card online/slow/offline + `failStreak` do breaker (não sonda ao abrir a página) |
| `src/providers/prowlarr.ts` | Alternativa ao Jackett |
| `src/providers/bludv.ts` | Scraper direto do BLUDV (fora do Jackett; default desligado) |
| `src/providers/account.ts` | Inventário pronto da conta como fonte (`fromAccount`) |
| `src/providers/autofetch.ts` | Marker, lock e vaga por busca do autofetch |
| `src/providers/demo.ts` | Big Buck Bunny — valida o pipeline sem indexer nenhum |
| `src/debrid/index.ts` | Registry + seleção por request + checagem com teto dinâmico + inventário |
| `src/debrid/common.ts` | `magnetFor`, fetch JSON, `pickFile`/`pickWorkFile`, lotes, `AuthError`/`QuotaError` |
| `src/debrid/protected.ts` | Hashes protegidos da limpeza durante o autofetch |
| `src/debrid/*.ts` | Um adaptador por serviço |
| `src/utils/format.ts` | Normalização, matching, dedupe, ordenação, cotas — **lógica pura** |
| `src/utils/indexer-priority.ts` | `priorityMap`/`compareIndexerPriority` |
| `src/utils/tmdb.ts` / `cinemeta.ts` | Título pt-BR / título-ano do ecossistema Stremio |
| `src/utils/cache.ts` | L1 memória + L2 SQLite; cotas por namespace; `getWithStale` |
| `src/utils/cache-keys.ts` | Fonte única de versão de namespace (`NAMESPACE_VERSIONS`), prefixos legados (`raw1:`/`dinv1:`) e `prefix(ns)` |
| `src/utils/request-key.ts` | `streams:v5` + digest da conta (nunca a chave crua) |
| `src/utils/secret-box.ts` | AES-256-GCM do `dk` no install URL |
| `src/utils/sign.ts` | HMAC do `/resolve` (hash + ep + dica `w`) |
| `src/utils/deadline.ts` | `raceWithDeadline`, `remainingCheckBudget` |
| `src/utils/latest-writer.ts` | Só a escrita mais nova do passe tardio vence |
| `src/utils/logger.ts` | Níveis via `ADDON_LOG_LEVEL` (não `LOG_LEVEL` — essa é do FlareSolverr) |
| `src/utils/metrics.ts` | Contadores/histogramas do `/metrics.json` |
| `src/utils/diagnostic-guard.ts` | Token + rate limit das rotas operacionais |
| `jackett-bludv/*.yml` | Definitions Cardigann dos indexers BR |
| `*-resolver/` | Seguem protetores de link; failover de domínio por saúde de rede |
| `types/domain.d.ts` | Tipos do domínio: `Stream` (união que exige ação), `ParsedSeasonEpisode`, `DebridAdapter`, `AccountStatus`, `MatchContext` |
| `test/helpers/stub.ts` | Dublê de `fetch`, `patch()` de módulo e `testOpts()` — o cast mora aqui, não espalhado |
| `test/e2e/e2e-harness.ts` | App real (`createApp`) + fetch dublê; zero rede externa |
| `Dockerfile` / `scripts/entrypoint.sh` / `docker-compose.yml` | Imagem única, supervisor, loopback |
| `scripts/magnets.ts` | Inventário/limpeza da conta |
| `scripts/check-test-list.ts` | Cobra a lista explícita do `npm test` |

`src/utils/format.ts` concentra as funções puras (`matchesName`,
`matchesBrTitle`, `matchesEpisode`, `filterRelevantRaw`,
`filterInventoryRelevant`, `looksPtBr`, `sortAndLimit`, `limitReservingBr`,
`dedupeByHash`, `pickBrDubbedCandidates`, …) — é o melhor lugar para testar
comportamento sem subir rede.

---

## Convenções

**O typecheck é portão, não enfeite: `npm run typecheck` fica em ZERO.** Não há
mais `@ts-check` nem `@ts-nocheck` no repositório — todo `.ts` é verificado, e o
`noEmitOnError` impede build sujo. Se o contador subir, conserte antes de seguir:
1.661 erros abertos foi o estado em que o portão deixou de servir para qualquer
coisa, porque ninguém lê essa lista para achar o que importa.

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
Varredura pt-BR também ignora (`ignoreBreaker: true`): o dublado raro mora
justamente no indexer recém-derrubado.

---

## Armadilhas conhecidas

- **Importar `src/addon.ts` sobe o servidor.** Testes usam `createApp()` de
  `src/app.ts`. Não copie rotas no harness — o e2e já instancia o app real.
- **Caminho relativo mudou de profundidade com o `dist/`.** O código roda de
  `dist/src/...`, então `__dirname` e `require`/`import` relativos apontam para
  dentro de `dist/`. Dois casos já mordidos: o `DB_PATH` do cache precisa subir
  **três** níveis para achar `data/cache.db`, e os quatro `*-resolver` são
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
- **"Sumiu o ⚡ de todos os streams" quase nunca é bug de código.** No fluxo
  normal, stream fora do cache sai **sem prefixo nenhum** (P2P); ver
  `[AD download]` em 100% dos itens significa que a checagem de cache não
  completou. Causas medidas, em ordem de frequência: conta do debrid no teto de
  magnets, chave recusada, e só então prazo. Cheque `/debrid-status.json` antes
  de investigar o pipeline — foi um caso real em que o "culpado" aparente era um
  commit de formatação de título.
- **A chave do `.env` e a da URL de instalação são independentes.** O app manda
  a dele selada no segmento de config; trocar só o `.env` não muda nada para
  quem já instalou, e uma pode estar quebrada enquanto a outra funciona.
- **AllDebrid tem `cacheCheck: true`.** Não trate como Real-Debrid. A consulta
  é upload, não aborta, e precisa da limpeza. README da tabela "consulta de
  cache = não" fala do endpoint instantâneo aposentado, não do comportamento
  atual do adaptador.
- **Os sites BR trocam de domínio com frequência.** `BLUDV_URL`,
  `COMANDOTORRENTS_URL`, `NERDFILMES_URL`, `TORRENTDOSFILMES_URL` são
  configuráveis. Os resolvers ainda têm failover interno por saúde de **rede**
  (DNS/conexão/timeout — 0 resultados não troca de host). Parser quebrado
  geralmente é mudança de layout do WordPress, não bug de lógica.
- **Os protetores de link também trocam de host.** O torrentdosfilmes migrou
  de `systemads.net` para `systemads1.com` e TODO magnet passou a ser barrado
  porque só o host antigo estava na lista permitida. Magnet que some de um
  resolver só: cheque a allowlist do protetor antes de culpar o parser.
- **Fontes BR não publicam tamanho por botão.** Os resolvedores mandam o
  sentinela "1 KB" (o Jackett exige o campo, e "0 B" invalida a release
  inteira no filtro de tamanho do cardigann); o addon trata ≤ 1 KB como
  desconhecido em vez de exibir valor inventado. Não "conserte" isso.
- **Não adicione indexers com FlareSolverr a `JACKETT_SLOW_INDEXERS`**
  (1337x, kickasstorrents…). O desafio Cloudflare é re-resolvido a cada busca
  (13–24s medidos só pra abrir a primeira página); eles abortariam igual, só
  mais tarde e gastando Chromium. Fora da lista de indexers é o lugar deles.
- **Buscador WordPress engasga com `:`** — `bludv.search` remove antes de
  consultar. Sintomas: título com subtítulo volta vazio.
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
  fora. `npm run test:nerdfilmes` cobre um resolver contra a rede. Ao mexer
  em matching, debrid, cache, runtime, rotas ou o fluxo de busca, estenda
  `test/` (incluindo o tier e2e se o contrato HTTP mudou). Para o resto,
  `npm run smoke` ou um script pontual em `node -e`.
- **`BR_RESOLVERS_HOST` é o único jeito de alcançar os resolvers.** Os cards
  Cardigann chamam `http://{{ ... }}/...` montado com essa env; no container
  único ela é `127.0.0.1`. Os resolvers escutam em 8700–8703 **só dentro do
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

## Git

Branch de trabalho: `adon-power-movie`. Commits em português, prefixo
convencional (`feat:`, `fix:`). `.env` é ignorado e **contém chaves reais** —
nunca faça commit dele nem cole seu conteúdo em output.
