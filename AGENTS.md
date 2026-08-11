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
- **Docker Compose** para a stack completa (Jackett + resolvers + Caddy).

## Comandos

```bash
npm start                 # sobe o addon em http://127.0.0.1:7000/manifest.json
npm run dev               # idem, com --watch
npm run docker:up         # stack completa
npm run docker:logs       # logs do addon
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
             ├─ collectRaw          ← dispara todos os providers em allSettled
             │    ├─ jackett.search  (indexers globais, query em inglês)
             │    ├─ jackett.search  (indexers BR, query em pt-BR)
             │    ├─ prowlarr.search
             │    └─ bludv.search    (scraper direto, query em pt-BR)
             ├─ filtro por título   ← matchesName contra EN + PT
             ├─ sortAndLimit        ← pool ampliado, não o corte final
             ├─ applyDebrid         ← premiumize cache/check
             └─ limitReservingBr    ← corte final, com vagas garantidas pra BR
```

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

Confundir os dois esconde a lista inteira. Foi por isso que `batched()` (em
`common.js`) **propaga o erro quando todos os lotes falham**: token inválido
retornando "nenhum cacheado" com `cachedOnly` ligado zerava o resultado sem
nenhuma pista do motivo.

Para adicionar um serviço: crie o adaptador, registre em `ADAPTERS` e pronto —
`SERVICES` alimenta o seletor da página automaticamente. Declare `cacheCheck`
com honestidade; declarar `true` sem endpoint funcional é o pior dos mundos.

Resolução acontece **só no play** (rota `/resolve`), nunca na listagem: é uma
sequência de chamadas por torrent e não caberia no orçamento de busca.

### Os quatro invariantes que mais quebram

**1. O orçamento de tempo é sagrado.**
O cliente Stremio aborta em 10s. A cadeia é:

```
JACKETT_INDEXER_TIMEOUT_MS (4000)  ─┐
JACKETT_BR_INDEXER_TIMEOUT_MS (7500) ─┼─ < REPLY_DEADLINE_MS (8500) < 10s do Stremio
JACKETT_DOWNLOAD_TIMEOUT_MS (8000) ──┘ teto por salto, DENTRO do orçamento BR
```

`brIndexerTimeout` é o orçamento **total** de um indexer BR: busca **mais**
resolução de magnets. `resolveCardigannDownloads` recebe um `deadline` absoluto e
cada salto de protetor de link usa só o que sobrou. Se você adicionar mais uma
etapa de rede num provider, ela **precisa** caber nesse mesmo deadline — foi
exatamente esse o bug de resolves rodando fora do `AbortSignal` da busca e
somando o próprio timeout por cima.

Quando o deadline estoura, `findStreams` devolve `[]` **mas a busca continua em
background** e popula o cache. Por isso resposta vazia é servida com
`cacheMaxAge: 0` — o Stremio precisa perguntar de novo.

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

Inverter essa ordem faz as fontes BR sumirem silenciosamente.

**4. Sites BR indexam por título em português.**
"Coringa", não "Joker". `tmdb.getTitles` resolve isso e a busca dispara **duas
queries**: a em inglês para indexers globais e a em pt-BR para os listados em
`JACKETT_PT_BR_INDEXERS`. Todo caminho de busca precisa carregar as duas —
inclusive fallbacks. O filtro `matchesName` também aceita qualquer um dos nomes,
senão a release dublada seria descartada por não bater com o título em inglês.

---

## Mapa dos arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src/addon.js` | Manifest, stream handler, servidor Express, rotas `/resolve` e `/configure` |
| `src/config.js` | Padrões do operador: todo `process.env` vira config **aqui** |
| `src/runtime.js` | Config por usuário: schema, encode/decode da URL, `opts()` |
| `src/public/configure.html` | Página de configuração (HTML/CSS/JS puro, zero build) |
| `src/providers/index.js` | Orquestração: cache, coalescing, deadline, debrid, corte final |
| `src/providers/jackett.js` | Consulta por indexer em paralelo + resolução Cardigann |
| `src/providers/prowlarr.js` | Alternativa ao Jackett |
| `src/providers/bludv.js` | Scraper direto do BLUDV (fora do Jackett) |
| `src/providers/demo.js` | Big Buck Bunny — valida o pipeline sem indexer nenhum |
| `src/debrid/index.js` | Registry de serviços de debrid + seleção por requisição |
| `src/debrid/common.js` | `magnetFor`, fetch JSON, `pickFile`, lotes de cache |
| `src/debrid/*.js` | Um adaptador por serviço (premiumize, realdebrid, …) |
| `src/utils/format.js` | Normalização, dedupe, ordenação, `matchesName` — **lógica pura** |
| `src/utils/tmdb.js` | Título pt-BR a partir do IMDb id |
| `src/utils/cinemeta.js` | Título/ano oficiais do ecossistema Stremio |
| `src/utils/cache.js` | Cache em memória, TTL + teto LRU-ish |
| `jackett-bludv/*.yml` | Definições Cardigann dos indexers BR |
| `*-resolver/` | Microserviços que seguem protetores de link dos sites BR |

`src/utils/format.js` concentra as funções puras (`matchesName`, `parseStremioId`,
`sortAndLimit`, `dedupeByHash`) — é o melhor lugar para testar comportamento sem
subir rede.

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
`[debrid]`, `[tmdb]`, `[resolve]`. Use `console.warn` para degradação esperada
(indexer fora do ar) e `console.error` só para falha real.

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
- **Os sites BR trocam de domínio com frequência.** `BLUDV_URL` e
  `NERDFILMES_URL` são configuráveis por isso. Parser quebrado geralmente é
  mudança de layout do WordPress, não bug de lógica.
- **Buscador WordPress engasga com `:`** — `bludv.search` remove antes de
  consultar. Sintomas: título com subtítulo volta vazio.
- **`AbortSignal.any` não existe no Node 18.** `engines` declara `>=18`; prefira
  calcular orçamento restante a compor sinais.
- **A rota `/resolve/:infoHash` não tem autenticação.** Quem descobrir a
  `PUBLIC_URL` consegue consumir a conta Premiumize. Se for mexer nela, considere
  assinar o path com HMAC.
- **Instalação sem config usa a `DEBRID_API_KEY` do `.env`.** Numa instância
  pública isso significa terceiros gastando a conta do operador. `/defaults.json`
  já omite a chave; a herança no caminho de busca é intencional (setup de um
  usuário só), mas é armadilha se a instância for compartilhada.
- **`src/public/` não passa por build.** É HTML/CSS/JS servido cru, e o JS é ES5
  por escolha (roda no WebView de Fire TV e smart TV). Não introduza sintaxe
  moderna nem bundler ali.
- **Não existe suíte de testes.** `npm run test:nerdfilmes` cobre só um resolver.
  Ao mexer em `format.js`, valide com um script pontual em `node -e`.

## Git

Branch de trabalho: `adon-power-movie`. Commits em português, prefixo
convencional (`feat:`, `fix:`). `.env` é ignorado e **contém chaves reais** —
nunca faça commit dele nem cole seu conteúdo em output.
