# AGENTS.md — Adom Power-Movie

Guia para agentes de código trabalhando neste repositório. Assume que você já
leu o `README.md` (que é voltado ao **usuário**); este arquivo é sobre **como o
código funciona e como mexer nele sem quebrar**.

---

## O que é

Addon Stremio self-hosted que devolve streams de torrent, com foco em **conteúdo
brasileiro dublado** — que é o diferencial do projeto e a origem de quase toda a
complexidade do código.

Dois addons convivem na stack:

- **Comet + Real-Debrid** — addon principal, terceiro, roda em container.
- **Adom** — o addon Node deste repositório (`src/`), P2P + Premiumize.

Praticamente todo trabalho de código acontece no **Adom**.

## Stack

- **Node ≥ 18**, CommonJS (`require`, não `import`). Sem TypeScript, sem build.
- **Duas dependências**: `express` e `stremio-addon-sdk`. `dotenv` para config.
  Sem lodash, sem axios, sem cheerio — HTTP é `fetch` nativo e HTML é parseado
  com regex. **Não adicione dependências sem necessidade real.**
- **Docker: container único.** O `Dockerfile` raiz (multi-stage, base
  `node:22-alpine`) embute addon + Jackett + FlareSolverr + Caddy, e o
  `docker-compose.yml` tem um serviço só (`adom`). Todos conversam por
  `127.0.0.1` — **nenhum hostname de container sobreviveu**: `JACKETT_URL`,
  `BR_RESOLVERS_HOST` (compose), os yml Cardigann (`http://127.0.0.1:870X`),
  o `Caddyfile` (`reverse_proxy 127.0.0.1:7000`) e o `FlareSolverrUrl` do
  `ServerConfig.json` foram rewired para loopback. Se adicionar um serviço
  novo, siga o mesmo padrão.

### Stack Docker (o que mora no container)

- `scripts/entrypoint.sh` supervisiona os 4 processos (caddy → jackett →
  flaresolverr → addon) com `wait -n` + `pipefail`: qualquer um que morrer
  derruba o container e o `restart: unless-stopped` recria tudo. Logs saem
  prefixados `[caddy]`, `[jackett]`, `[flaresolverr]`, `[addon]`.
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

## Comandos

```bash
npm start                 # sobe o addon em http://127.0.0.1:7000/manifest.json
npm run dev               # idem, com --watch
npm test                  # node:test: format, runtime, sign, jackett-catalog, autofetch
npm run smoke             # valida o pipeline de ponta a ponta
npm run docker:up         # stack completa
npm run docker:logs       # logs do addon
node scripts/magnets.js   # ocupação da conta do debrid (--apply para limpar)
```

Quando "o ⚡ sumiu de todos os streams", comece por aqui — é diagnóstico, não
adivinhação:

```bash
curl -H "X-Indexer-Test-Token: $JACKETT_TEST_TOKEN" http://127.0.0.1:7000/debrid-status.json
```

Para checar sintaxe sem subir servidor (`require('./src/addon')` **abre a porta**
e fica pendurado — não use isso como smoke test):

```bash
node --check src/providers/index.js
```

---

## Arquitetura do fluxo de busca

Um `stream` request do Stremio percorre exatamente este caminho:

```
addon.js  defineStreamHandler
   └─ providers/index.js  findStreams        ← cache + coalescing + deadline
        └─ doSearch
             ├─ cinemeta.getMeta   ─┐ paralelo
             ├─ tmdb.getTitles     ─┘  (título pt-BR)
             ├─ collectRaw          ← balde compartilhado + orçamento + passe tardio
             │    ├─ jackett.search (indexers globais escolhidos pelo usuário, EN)
             │    ├─ jackett.search (indexers BR escolhidos, query em pt-BR)
             │    ├─ prowlarr.search
             │    └─ bludv.search   (scraper direto, query em pt-BR)
             └─ buildStreams        ← pós-processamento, reusado pelos dois passes
                  ├─ filtro por título    ← matchesName contra EN + PT
                  ├─ filtro por episódio  ← matchesEpisode (série)
                  ├─ sortAndLimit         ← pool ampliado + limites por qualidade
                  ├─ applyDebrid          ← cache/check + autofetch BR
                  └─ limitReservingBr     ← corte final, vagas garantidas pra BR
```

Série sem resultado por episódio tem fallback de pack (`"Nome S01"`, com a
variante pt-BR junto) — as fontes BR só publicam temporada inteira.

### Configuração por usuário (`src/runtime.js`)

Modelo Torrentio: as preferências viajam **codificadas na URL de instalação**
(`/<base64url>/manifest.json`), não em banco. O servidor é stateless.

- `config.js` = padrões do **operador** (`.env`), estáticos, carregados uma vez.
- `runtime.js` = overlay do **usuário**, por requisição, em `AsyncLocalStorage`.

**Regra:** o que o usuário pode escolher lê-se por `opts()`; o resto (URLs de
indexer, timeouts, credenciais de infra) continua vindo de `config`. Nunca leia
`config.maxResults` / `config.provider` / `config.debrid.apiKey` direto no
caminho de busca — esses foram movidos para `opts()` e ler o estático de volta
faz a config do usuário ser silenciosamente ignorada.

Para expor uma opção nova: adicione em `SCHEMA` + `defaults()` (chave **curta**,
ela ocupa espaço na URL), consuma via `opts()`, e adicione o controle em
`src/public/configure.html` — o mapa `KEYS` do front **precisa bater** com o
`SCHEMA` do back.

O schema atual já carrega: fontes (`p`), qualidades (`q`), limites por
qualidade (`q4`/`q1`/`q7`/`q5`/`qs`/`qn`), vagas e prioridade BR (`b`/`bf`/`o`),
dublado (`d`/`a`), sem CAM (`c`), tamanho máximo (`z`), indexers do Jackett
(`ji`/`jl`) e o trio debrid (`ds`/`dk`/`dc`). `jackettIndexers` aceita qualquer
string vinda da URL — o caminho de busca valida cada id contra
`SAFE_INDEXER_ID` antes de montar a query. Qualidade desconhecida tem balde
próprio (`qn`), separado do SD: as fontes BR não publicam resolução, e zerar o
SD não pode desligar a prioridade brasileira junto.

`indexerLimits` (`jl`) é um mapa compacto `id:limite` separado por vírgulas —
um card por indexador na página. Id fora do mapa herda o teto global
`maxPerIndexer`; `0` explícito significa sem limite, e o schema só aceita 0..20
(1..20 é o teto por indexador). A cota roda no corte final, na mesma passada da
qualidade; as vagas reservadas BR passam sem serem barradas, mas continuam
contando — a reserva fura o teto, não o amplia.

`prefix()` devolve o segmento de config da requisição corrente. A rota
`/resolve` depende dele: o link de play tem que voltar carregando a mesma
config, senão o debrid do usuário some na hora do play.

Ordem das rotas em `addon.js` é significativa: as rotas sem config vêm **antes**
de `app.use('/:userConfig', ...)`, senão `/manifest.json` seria interpretado como
segmento de configuração. Segmento que não decodifica devolve 404 — sem isso,
qualquer caminho de um segmento viraria um manifest válido servindo o `.env`.

### Camada de debrid (`src/debrid/`)

Registry de adaptadores; nada no resto do código conhece um serviço específico.
Cada adaptador exporta a mesma forma:

```js
{ id, label, cacheCheck, keyUrl, checkCached(apiKey, hashes), resolveLink(apiKey, hash, ep) }
```

**`cacheCheck` é a distinção que mais importa.** Real-Debrid, AllDebrid e
Debrid-Link aposentaram os endpoints de disponibilidade instantânea; só
Premiumize e TorBox ainda respondem em lote. Por isso `debrid.checkCached()`
devolve `{ cached, known }`:

- `known: true` → dá pra confiar; cacheados ganham ⚡ e o filtro `cachedOnly` vale.
- `known: false` → **não é "nada em cache"**. Todos os streams passam pelo
  debrid, sem ⚡, e `cachedOnly` é ignorado.
- `unusable: { reason }` → o serviço não vai funcionar agora, por um motivo que
  só o usuário conserta. A lista volta como **P2P** (ver abaixo).

Confundir os dois primeiros esconde a lista inteira. Foi por isso que `batched()`
(em `common.js`) **propaga o erro quando todos os lotes falham**: token inválido
retornando "nenhum cacheado" com `cachedOnly` ligado zerava o resultado sem
nenhuma pista do motivo.

**Serviço inutilizável ≠ serviço instável.** Duas condições não são
transitórias e chegam à tela do mesmo jeito — o ⚡ some de TODOS os streams:

| `reason` | Como aparece | Conserto |
|---|---|---|
| `auth` | `AUTH_BAD_APIKEY` (AllDebrid responde com **HTTP 200**), 401/403 nos outros | chave nova + refazer a URL de instalação |
| `quota` | `Magnets limit reached (1000 accross all tabs)` | apagar magnets: `node scripts/magnets.js` |

As duas barram o `/magnet/upload`, que é como a AllDebrid **checa cache** e
**resolve o play**. Prometer debrid nesse estado entrega uma lista em que nenhum
play funciona, então `applyDebrid` devolve os streams como torrent puro e o log
diz qual é o conserto. Elas também não pedem `needsFullRefresh`: como o conserto
é manual, revalidar a cada request só refazia Jackett + resolvers BR para chegar
na mesma lista (7s por busca, cache nunca assentando).

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

Duas coisas nunca entram na limpeza: o hash do autofetch (`protected.js`) e o
que **já era do usuário**. Como o `/magnet/upload` é idempotente e a resposta
não diz se criou ou reaproveitou (`{magnet, hash, name, size, ready, id}`, sem
data), o adaptador inventaria a conta uma vez por processo e protege o que
encontrou. Enquanto esse inventário não carrega, a limpeza dos prontos não roda
— o `null` é o fail-safe.

Para comparação: o Comet delega ao StremThru, que na AllDebrid **não mede** nada
(o `/magnets/check` devolve palpite de base colaborativa) e só toca a conta no
play, sem remover depois. O nosso ⚡ é medido; o preço é essa limpeza.

**Verificador (`/debrid-status.json`).** Encher a conta é invisível até estourar,
e aí o sintoma não aponta para a causa. O endpoint mostra a ocupação antes disso,
atrás do mesmo token do diagnóstico:

```bash
curl -H "X-Indexer-Test-Token: $JACKETT_TEST_TOKEN" http://127.0.0.1:7000/debrid-status.json
```

Com a config na frente (`/<config>/debrid-status.json`) ele usa a chave **daquela
instalação** — que é a que o app manda, e pode ser diferente da do `.env`. Acima
de `DEBRID_ACCOUNT_WARN_TOTAL` (800 magnets) ele devolve `warn: true` e registra
aviso. Não existe percentual: a AllDebrid tem dois tetos que não batem entre si
(30 "ativos" na doc oficial, 1000 na mensagem de erro real) e nenhum é
consultável — a versão anterior dizia "231% ocupado" para uma conta que
respondia normalmente.

Para adicionar um serviço: crie o adaptador, registre em `ADAPTERS` e pronto —
`SERVICES` alimenta o seletor da página automaticamente. Declare `cacheCheck`
com honestidade; declarar `true` sem endpoint funcional é o pior dos mundos.

Resolução acontece **só no play** (rota `/resolve`), nunca na listagem: é uma
sequência de chamadas por torrent e não caberia no orçamento de busca.

O registry também expõe `enqueue()` para o **autofetch BR**: sem fonte dublada
tocável em cache, o addon manda o debrid baixar o melhor candidato para o play
da próxima vez. Os detalhes e as travas estão no invariante 6.

### Os seis invariantes que mais quebram

**1. O orçamento de tempo é sagrado.**
O cliente Stremio aborta em 10s. A cadeia é:

```
REPLY_DEADLINE_MS (9200) − DEBRID_RESERVE_MS (2800) = orçamento da coleta
JACKETT_INDEXER_TIMEOUT_MS (4000)      teto por indexer global, dentro do orçamento
JACKETT_BR_INDEXER_TIMEOUT_MS (20000)  total BR — PODE passar do deadline
JACKETT_DOWNLOAD_TIMEOUT_MS (8000)     teto por salto DENTRO do orçamento BR
```

Os indexers globais precisam caber no orçamento da coleta; os BR **não**.
`brIndexerTimeout` é o orçamento **total** de um indexer BR: busca **mais**
resolução de magnets. `resolveCardigannDownloads` recebe um `deadline` absoluto
e cada salto de protetor de link usa só o que sobrou. A resposta não espera
pelas fontes lentas: `collectRaw` despeja num balde compartilhado e devolve o
que chegou no prazo; quando o resto termina, um **passe tardio** reescreve o
cache com o lote completo. Na busca fria a raspagem sozinha leva 5-6s e ainda
faltam os saltos do protetor — cortar no meio descartava os BR por falta de
infoHash. Por isso `buildStreams` foi extraído de `doSearch`: os dois passes
(parcial e tardio) rodam o mesmo pós-processamento.

Se você adicionar mais uma etapa de rede num provider **global**, ela precisa
caber no orçamento da coleta — foi exatamente esse o bug de resolves rodando
fora do `AbortSignal` da busca e somando o próprio timeout por cima.

Quando o deadline estoura, `findStreams` devolve `[]` **mas a busca continua em
background**. Resultado vazio é cacheado por pouco tempo (≤ 60s): pode ser só
indexer fora do ar, e o Stremio precisa poder perguntar de novo em breve.

**2. Origem BR é um campo, nunca um regex de título.**
Providers marcam `isBr: true` no resultado cru; `toStremioStream` converte em
`_br`; `limitReservingBr` usa esse campo e o remove antes de entregar ao Stremio.
Não volte a inferir origem por `/BLUDV|DUBLADO/i` no título — releases de
`comandotorrents`, `nerdfilmes` e `torrentdosfilmesv2` não citam nenhum dos dois.

Campos com prefixo `_` (`_br`, `_seeders`, `_quality`) são **internos**. Se um
deles vazar no objeto entregue ao Stremio, o player pode rejeitar o stream.

**3. Fontes BR não publicam seeders.**
Elas entram com `seeders: 1` (0 seria descartado por `MIN_SEEDERS`). Consequência:
na ordenação elas ficam sempre por último e seriam eliminadas por releases de
centenas de seeders. Por isso:

- `sortAndLimit` corta num pool **ampliado** (`maxResults * CANDIDATE_POOL_FACTOR`),
  não no número final;
- o corte real é `limitReservingBr`, **depois** do debrid, com `BR_RESERVED_SLOTS`
  vagas garantidas.
- o teto por indexador (`jl`, fallback no `maxPerIndexer` global) roda na mesma
  passada da qualidade, dentro de `limitReservingBr`; as vagas reservadas BR
  estouram o teto sem serem cortadas, mas contam na cota — a reserva fura o
  teto, não o amplia.

Inverter essa ordem faz as fontes BR sumirem silenciosamente.

**4. Sites BR indexam por título em português.**
"Coringa", não "Joker". `tmdb.getTitles` resolve isso e a busca dispara **duas
queries**: a em inglês para indexers globais e a em pt-BR para os listados em
`JACKETT_PT_BR_INDEXERS`. Todo caminho de busca precisa carregar as duas —
inclusive fallbacks. O filtro `matchesName` também aceita qualquer um dos nomes,
senão a release dublada seria descartada por não bater com o título em inglês.

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
- no filtro de título de `buildStreams`, com o `meta.year` do catálogo — sem
  essa segunda passada o jogo ("Fallout 4 (PC)") passaria pelo pré-filtro
  (query de série não tem ano) e só morreria no debrid.

`meta.year` vem sujo do cinemeta ("2024–" para série em andamento): extraia o
primeiro token de 4 dígitos antes de comparar, senão `Number("2024–")` é NaN e
a regra de ano condena TODAS as releases reais.

**6. Autofetch BR e `dropUncached` são forças opostas.**
`dropUncached` apaga da conta do debrid o que não está em cache (sem isso cada
busca deixa download fantasma); `autoFetchBrDubbed` faz o oposto de propósito —
enfileira a melhor fonte BR dublada quando nada tocável está em cache. A ponte
é `src/debrid/protected.js`: o hash escolhido entra em `hold` **antes** da
checagem de cache e só é liberado se o download não acontecer. Inverter essa
ordem deixa a limpeza matar o download no meio da mesma busca — na AllDebrid a
própria checagem apaga da conta o que não está pronto. Travas do autofetch:
um torrent por busca, só com `cacheCheck: true` (sem resposta confiável não dá
pra saber o que falta), desligável por `autoFetchBr`, e o disparo nunca entra
no caminho da resposta — erro só vira log.

---

## Mapa dos arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src/addon.js` | Manifest, stream handler, servidor Express, rotas `/resolve`, `/configure`, `/defaults.json` e `/test-indexer.json` |
| `src/config.js` | Padrões do operador: todo `process.env` vira config **aqui** |
| `src/runtime.js` | Config por usuário: schema, encode/decode da URL, `opts()` |
| `src/public/configure.html` | Página de configuração (HTML/CSS/JS puro, zero build) |
| `src/providers/index.js` | Orquestração: cache, coalescing, deadline, passe tardio, debrid, corte final |
| `src/providers/jackett.js` | Consulta por indexer em paralelo + resolução Cardigann |
| `src/providers/jackett-catalog.js` | Catálogo de indexers do Jackett (torznab) pra página de configuração, com TTL e fallback pros do `.env` |
| `src/providers/prowlarr.js` | Alternativa ao Jackett |
| `src/providers/bludv.js` | Scraper direto do BLUDV (fora do Jackett) |
| `src/providers/demo.js` | Big Buck Bunny — valida o pipeline sem indexer nenhum |
| `src/debrid/index.js` | Registry de serviços de debrid + seleção por requisição |
| `src/debrid/common.js` | `magnetFor`, fetch JSON, `pickFile`, lotes de cache, classificação de erro (`AuthError`/`QuotaError`) |
| `src/debrid/protected.js` | Hashes protegidos da limpeza `dropUncached` durante o autofetch |
| `src/debrid/*.js` | Um adaptador por serviço (premiumize, realdebrid, …) |
| `src/utils/format.js` | Normalização, dedupe, ordenação, `matchesName`, `matchesBrTitle` — **lógica pura** |
| `src/utils/indexer-priority.js` | `priorityMap`/`compareIndexerPriority` — desempate por indexer escolhido |
| `src/utils/tmdb.js` | Título pt-BR a partir do IMDb id |
| `src/utils/cinemeta.js` | Título/ano oficiais do ecossistema Stremio |
| `src/utils/cache.js` | Cache em memória (L1) persistido em SQLite pra sobreviver a restart |
| `jackett-bludv/*.yml` | Definições Cardigann dos indexers BR (copiadas para a imagem pelo Dockerfile raiz) |
| `*-resolver/` | Microserviços que seguem protetores de link dos sites BR (rodam embutidos no addon) |
| `Dockerfile` | Multi-stage único: caddy + jackett (linuxserver, digest pinado) + flaresolverr + addon |
| `scripts/entrypoint.sh` | Supervisor dos 4 processos (`wait -n`, prefixos de log) |
| `scripts/magnets.js` | Inventário/limpeza dos magnets da conta (conta cheia derruba a checagem de cache) |
| `docker-compose.yml` | Serviço único `adom`: portas, volumes (`docker-data/`), overrides de loopback |

`src/utils/format.js` concentra as funções puras (`matchesName`,
`matchesEpisode`, `parseTitleSeasonEpisode`, `parseStremioId`, `sortAndLimit`,
`dedupeByHash`, limites por qualidade e por indexador) — é o melhor lugar para
testar comportamento sem subir rede.

---

## Convenções

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
`[debrid]`, `[autofetch]`, `[cache]`, `[tmdb]`, `[resolve]`. Use `console.warn`
para degradação esperada (indexer fora do ar) e `console.error` só para falha
real.

**Nada de config hardcoded.** Todo número ajustável entra em `src/config.js` com
default e comentário, e no `.env.example` com a mesma explicação. Timeouts
literais espalhados pelo código são bug em potencial — eles escapam da cadeia de
orçamento do item 1.

**Falha de rede nunca derruba a busca.** Todo fan-out usa `Promise.allSettled`;
todo provider tem `try/catch` que devolve `[]` e loga. Um indexer fora do ar
significa menos resultados, nunca erro para o usuário.

---

## Armadilhas conhecidas

- **`require('./src/addon')` sobe o servidor.** Não é importável para teste.
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
- **Os sites BR trocam de domínio com frequência.** `BLUDV_URL` e
  `NERDFILMES_URL` são configuráveis por isso. Parser quebrado geralmente é
  mudança de layout do WordPress, não bug de lógica.
- **Os protetores de link também trocam de host.** O torrentdosfilmes migrou
  de `systemads.net` para `systemads1.com` e TODO magnet passou a ser barrado
  porque só o host antigo estava na lista permitida. Magnet que some de um
  resolver só: cheque a allowlist do protetor antes de culpar o parser.
- **Fontes BR não publicam tamanho por botão.** Os resolvedores mandam o
  sentinela "1 KB" (o Jackett exige o campo, e "0 B" invalida a release
  inteira no filtro de tamanho do cardigann); o addon trata ≤ 1 KB como
  desconhecido em vez de exibir valor inventado. Não "conserte" isso.
- **Agregadores BR podem espelhar magnets globais.** Mesmo infoHash em
  YTS/RARBG/TPB não prova áudio PT: origem e áudio pertencem à listagem que
  vence o merge; nunca propague `_br`/`_dubbed` do perdedor.
- **Não adicione indexers com FlareSolverr a `JACKETT_SLOW_INDEXERS`**
  (1337x, kickasstorrents…). O desafio Cloudflare é re-resolvido a cada busca
  (13-24s medidos só pra abrir a primeira página); eles abortariam igual, só
  mais tarde e gastando Chromium. Fora da lista de indexers é o lugar deles.
- **Buscador WordPress engasga com `:`** — `bludv.search` remove antes de
  consultar. Sintomas: título com subtítulo volta vazio.
- **`AbortSignal.any` não existe no Node 18.** `engines` declara `>=18`; prefira
  calcular orçamento restante a compor sinais.
- **A rota `/resolve/:infoHash` é assinada com HMAC.** O parâmetro `sig` cobre
  `infoHash` + temporada/episódio; o segredo é `RESOLVE_SECRET` ou, na falta
  dele, a API key de debrid da requisição. Se mudar o formato da rota ou os
  parâmetros que o play usa, mantenha todos eles dentro da assinatura.
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
- **Suíte de testes cobre o que é puro.** `npm test` roda `node:test` sobre
  `format.js`, `sign.js`, `runtime.js`, `jackett-catalog.js` e a lógica de
  autofetch/proteção (`test/autofetch.test.js`) — sem rede.
  `npm run test:nerdfilmes` cobre só um resolver. Ao mexer nesses módulos,
  estenda os testes em `test/`; para o resto, valide com `npm run smoke` ou um
  script pontual em `node -e`.
- **`BR_RESOLVERS_HOST` é o único jeito de alcançar os resolvers.** Os cards
  Cardigann chamam `http://{{ ... }}/...` montado com essa env; no container
  único ela é `127.0.0.1`. Os resolvers escutam em 8700-8703 **só dentro do
  container** — nenhuma dessas portas é publicada no host.
- **Jackett no alpine é self-contained** (binário com libcoreclr embutida):
  precisa de `icu-libs`/`zlib`/`libstdc++` e das envs `XDG_CONFIG_HOME=/config`
  + `TMPDIR=/run/jackett-temp`. O FlareSolverr é python puro + chromium/chromedriver
  do apk (chromedriver precisa estar em `/app/chromedriver`, caminho hardcoded
  no código dele) + `xvfb`. Tudo isso já está no Dockerfile — se trocar a base,
  revalide a lista de pacotes.

## Git

Branch de trabalho: `adon-power-movie`. Commits em português, prefixo
convencional (`feat:`, `fix:`). `.env` é ignorado e **contém chaves reais** —
nunca faça commit dele nem cole seu conteúdo em output.
