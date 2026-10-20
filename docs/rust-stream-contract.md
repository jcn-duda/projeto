# Contrato do `/stream` — o que o orquestrador Rust precisa reproduzir

Status: **contrato F0 fixado** a partir do TypeScript; override gateway em
**sombra por default** (`ROUTES_RUST=stream-shadow`). Corte nativo
(`ROUTES_RUST=stream`) é **experimental** — não está pronto como default:
falta paridade BR + cotas (evidência operacional: BR some no corte). Nada nos
§§1–8 é proposta: cada afirmação tem `arquivo:linha` do fonte real. O
orquestrador vive em
[`rust/crates/adom-search`](../rust/crates/adom-search/src/lib.rs); a fachada
que corta a rota é [`adom-server`](../rust/crates/adom-server/src/stream.rs).

Ordem de leitura sugerida: §0 (estado operacional) → §1 (rota) → §2 (corpo) →
§3 (aviso) → §5 (cache) → §7 (identidade) → §9 (métrica). Os §§4/6/8 são as
regras que mais quebram.

---

## 0. Estado operacional (Fase F — sombra default; corte experimental)

### 0.1 Override local (sombra default; corte experimental)

Override opt-in (o compose padrão **não** o carrega). Default do YAML:
`ROUTES_RUST=stream-shadow` — Node responde; Rust remonta e só incrementa
`stream.shadow.*` (§9).

```bash
docker compose -f docker-compose.yml -f docker-compose.gateway.yml up -d --build
```

| Env | Valor no override | Papel |
|---|---|---|
| `GATEWAY` | `on` | `adom-server` na 7000; Node atrás na 7100 |
| `ROUTES_RUST` | `stream-shadow` | sombra (default deste override) |
| `INTERNAL_SEARCH_URL` / `INTERNAL_CHECK_URL` | `http://127.0.0.1:7100` | meta/collect/tail e reserva de debrid — **nunca** `:7000` (a fachada recusa `/internal/*`) |

Corte nativo (`ROUTES_RUST=stream`, token exato) é **experimental**: força o
handler Rust a responder `/stream`. Ainda **não** está pronto para default —
evidência de uso: conteúdo BR some da lista. Exige paridade BR+cotas (e o
critério formal §9.4) antes de qualquer promoção. Com `stream` e
`stream-shadow` no mesmo CSV, o corte nativo vence (`adom-server/src/proxy.rs`).

### 0.2 Debrid com herança do `.env`

Install sem `dk` na URL herda a fatia debrid do operador
(`DEBRID_SERVICE` / `DEBRID_API_KEY` / `DEBRID_CACHED_ONLY` /
`DEBRID_SHOW_UNCACHED_BR`, gate `DEBRID_ALLOW_ENV_KEY`) via
`operator_debrid_defaults_from_env` no gateway (`adom-server/src/stream.rs`,
commit `dd9330c4`). Sem isso o orquestrador caía em `NoDebridCheck` (lista só
`infoHash`, sem ⚡/`/resolve`) enquanto o Node na 7100 aplicava debrid — o
smoke Docker com chave só no `.env` depende dessa herança (não confundir
com aceite de paridade BR).

### 0.3 Collect: Node por padrão; Jackett Rust opt-in

- Default do corte: collect/meta/tail via `POST /internal/search/*` no Node
  (`NodeRoutes`, precisa `JACKETT_TEST_TOKEN` + `INTERNAL_SEARCH_URL`).
- Opt-in `SOURCES_RUST=jackett|prowlarr|torrentio|bludv|mico` (CSV,
  case-insensitive): collect nativo (`JackettCollector` /
  `ProwlarrCollector` / `TorrentioCollector` / `BludvCollector` /
  `MicoCollector`); **composição**: cada fonte listada coleta no Rust e o
  `NodeCollector` roda o resto com `skip_sources` (as fontes já migradas, que o
  Node pula no `/internal/search/collect`). Meta/tail seguem no Node quando as
  rotas internas existem. Default **OFF**.

### 0.4 Store SWR: `STREAMS_DB` no nativo; memória na sombra

| Modo | Store | Path |
|---|---|---|
| `ROUTES_RUST=stream` | `StreamsStore` (SQLite) → fallback memória se abrir falhar → último recurso `MemorySwrStore` | `STREAMS_DB` ou default `data/streams.db` (volume `docker-data/addon`) |
| `ROUTES_RUST=stream-shadow` | **sempre** `MemorySwrStore` fresco | nunca abre `STREAMS_DB` (hit/DELETE no SQLite do nativo furaria o compare-only) |

Sombra: `shadow_mode` (não grava/promove/tail em fundo) + `NoDebridFactory` +
`NoopTailEffects` — só observa.

### 0.5 Caveat conhecido: 1ª hit a frio

Na 1ª requisição a frio (store vazio, Jackett/Flare frios, sem SWR) a coleta
pode assentar **parcial** sem candidatos. Desde `49482cc7`, parcial/collect
falho com lista vazia devolve o aviso
`Procurando fontes — reabra em instantes` (não mais `{ "streams": [] }`
silencioso nesse caso). Filme *completo* sem candidatos ainda pode ser `[]`.
A 2ª hit / SWR costuma preencher tocáveis — não tratar só o aviso na 1ª batida
como regressão de matching sem repetir a busca.

### 0.6 Gap de CI

Nenhum workflow em `.github/workflows/` sobe o override gateway nem fixa
`ROUTES_RUST=stream` / `stream-shadow`:

- `rust.yml` — crates + goldens (sem HTTP do `adom-server` com corte);
- `docker.yml` — build da imagem (sem `docker-compose.gateway.yml`, sem smoke
  de `/stream` nativo);
- `ci.yml` — suíte Node.

Validar sombra/corte é **manual/local**. O YAML de CI **não** entra nesta fatia
docs. Smoke mínimo (override §0.1; Matrix `tt0133093`) — só forma HTTP, **não**
é aceite de paridade:

```bash
docker compose -f docker-compose.yml -f docker-compose.gateway.yml \
  up -d --build --force-recreate adom
# aguardar container healthy; depois:
curl -sf http://127.0.0.1:7000/health                    # {"ok":true} (proxy → Node :7100)
curl -sf -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:7000/manifest.json                    # 200 (mesmo alvo do healthcheck Docker)
curl -sf http://127.0.0.1:7000/stream/movie/tt0133093.json | head -c 240
# Esperado: HTTP 200 + JSON com "streams"; 1ª hit a frio pode ser só aviso §0.5 —
# repetir a 2ª. Falha se 5xx/HTML ou `{"streams":[]}` silencioso sem aviso.
# NÃO tratar isto (nem validate-docker.mjs) como paridade BR+cotas — ver §0.7.
```

### 0.7 `validate-docker.mjs` ≠ paridade BR

[`scripts/validate-docker.mjs`](../scripts/validate-docker.mjs) confere health,
manifest e que `/stream` devolve **pelo menos um stream tocável**
(`url`/`infoHash`/`externalUrl`). Conta `dublado` só como detalhe do log —
**não falha** se BR sumir nem compara cotas/reserva com o Node. Verde no
script **não** autoriza `ROUTES_RUST=stream` como default.

---

## 1. Rota e parâmetros

### 1.1 Caminho

- Padrão montado uma única vez em `src/routes/addon-router.ts:109`:
  `GET /stream/:type/:id/:extra?.json`. O router é montado **duas vezes** em
  `src/routes/register.ts:69` (sem config) e `src/routes/register.ts:93`
  (dentro de `/:userConfig`). Os dois caem no mesmo handler.
- Formas aceitas na prática:
  - `/stream/<type>/<id>.json` (instalação sem config);
  - `/<config>/stream/<type>/<id>.json` (com config).
- `<type>` é `movie` ou `series`; `<id>` é `tt…` (filme) ou `tt…:S:E` (série) —
  ver `src/utils/search-names.ts:330` (`parseStremioId`, divisor `:`).
  Tipo desconhecido **não** é validado na rota: chega em `findStreams`, que
  testa `id.startsWith('tt')` e devolve `{ streams: [], partial: false }` para o
  resto (`src/providers/search-cache.ts:46-48`).
- `:extra?.json` existe no padrão mas esta fatia **não** o consome: o SDK lia o
  último segmento **cru** de `req.url` porque `req.params` vem decodificado e
  quebraria a divisão dos extras (`src/routes/addon-router.ts:110-118`). O
  orquestrador Rust pode rejeitar `extra` até a fatia que o implementar.
- CORS: `Access-Control-Allow-Origin: *` em toda resposta e `204` no `OPTIONS`
  (`src/routes/addon-router.ts:64-71`).

### 1.2 Config na URL

- O segmento tem que casar `^[A-Za-z0-9_-]+$` e ter no máximo **8192**
  caracteres (`src/runtime.ts:27`, `src/runtime.ts:236`; o teto é em unidades
  UTF-16, mas o charset já restringe a ASCII). Fora disso, `decode` devolve
  `null` e o roteador responde **404** com texto `configuração inválida`
  (`src/routes/register.ts:71-75`).
- O conteúdo é `JSON.parse(Buffer.from(segmento, 'base64url'))` e precisa ser um
  **objeto** (array/string/número são recusados) — `src/runtime.ts:235-244`.
- Sobre o objeto cru aplica-se o `SCHEMA` (`src/runtime.ts:44-75`) e depois
  `normalize` (`src/runtime.ts:170-202`): chaves curtas (`p`, `q`, `m`, `ji`,
  `dk`, …) viram nomes longos (`providers`, `qualities`, `maxResults`, …) e o
  resultado é **mesclado sobre `defaults()`** (`src/runtime.ts:93-138`), nunca
  sobre um objeto vazio. Chave desconhecida é ignorada.
- A config vive em `AsyncLocalStorage` por requisição (`src/runtime.ts:15-23`,
  `:302-304`); `opts()` lê dali — invariante 5: **preferência do usuário nunca
  vem do `.env`** no caminho de busca (`src/runtime.ts:247-249`).
- `prefix()` devolve `/<config>` ou `''` e é o que a URL de `/resolve` e o link
  do aviso carregam (`src/runtime.ts:256-259`).

### 1.3 O que **não** é parâmetro

- `Host`/`PUBLIC_URL` **não** entram na chave nem no cache; só na resposta
  (§3.3).
- Nenhum `?query` do `/stream` é lido hoje; `req.query` do Express não é
  consultado pelo handler (`src/routes/stream.ts:8-10`).
- A conta do debrid não vem de header: vem do `dk` dentro do segmento
  (`src/runtime.ts:69`, `src/runtime.ts:127-131`).
- **`/internal/*` não é superfície pública.** As rotas internas de busca
  (`meta`/`state`) exigem loopback + `X-Indexer-Test-Token`; com `GATEWAY=on` o
  gateway Rust recusa `/internal` e `/internal/*` antes do proxy (o Caddy também
  bloqueia). O orquestrador fala com o Node direto — nunca pela porta pública.

---

## 2. Corpo da resposta Stremio

### 2.1 Envelope

`src/routes/stream.ts:46-55`:

```json
{ "streams": [...], "cacheMaxAge": 0 }
{ "streams": [...], "cacheMaxAge": 900,
  "staleRevalidate": 3600, "staleError": 86400 }
```

- Serialização: `res.type('application/json').send(JSON.stringify(response))`
  (`src/routes/addon-router.ts:126`).
- `streams` é sempre **array** (vazio é válido); `cacheMaxAge` é sempre inteiro.
- `staleRevalidate = cacheMaxAge * 4` e `staleError = 86400` só aparecem no
  caminho "lista completa" (`src/routes/stream.ts:50-55`).
- O mesmo objeto alimenta o header `Cache-Control`
  (`src/routes/addon-router.ts:73-83`): `max-age`, `stale-while-revalidate`,
  `stale-if-error`, e `, public` no fim.

### 2.2 Campos de um item

O item é montado por `toStremioStream` (`src/utils/search-names.ts:96-276`),
passa pelo corte final (`src/utils/stream-quotas.ts:333-334`) e pelo egresso
(`applyNoticeOrigin`, §3).

| Campo | Origem | Quando existe |
|---|---|---|
| `name` | `streamDisplayName` (`search-names.ts:208-218`) | todo item de torrent/aviso |
| `title` | `search-names.ts:219` — release completa + `👤`/`💾`/`📦`/`⚙️` | torrent e aviso |
| `infoHash` | `search-names.ts:220` (btih de 40 hex) | item **P2P**; apagado no item debrid (`debrid-pipeline-core.ts:281`) |
| `sources` | `TRACKERS.map(t => 'tracker:'+t)` (`search-names.ts:221`, lista em `:39`) | item P2P; apagado no debrid (`:282`) |
| `behaviorHints.bingeGroup` | `search-names.ts:222-225` (`powerm-<qualidade|na>-<fonte|any>`) | todo torrent |
| `url` | `debrid-pipeline-core.ts:278-283` (path `/resolve/…` com `sig`) | item resolvido no play |
| `externalUrl` | `stream-builder.ts:356-362` | **só** o aviso de lista vazia |
| `size` | `stream-builder.ts:347-353` (`streamSizeLabel`, `episode-size.ts:66-70`) | quando o `title` tem `💾 n.nn GB` e há origin |
| `_*` | internos | **nunca** saem |

O `💾` do §2.2 é marcador **de texto** dentro do `title`, não campo: o Stremio
não o conhece. O campo `size` é o chip do app Power Movie, derivado do mesmo
`💾` na hora da resposta (por isso o comentário de `stream-builder.ts:341-346`).

### 2.3 O que NUNCA vai ao cliente (e o que nunca vai ao cache)

- Campos internos removidos em `limitReservingBr`
  (`src/utils/stream-quotas.ts:334`): `_br`, `_seeders`, `_quality`, `_size`,
  `_dubbed`, `_dubClaim`, `_indexer`, `_tracker`, `_multiWork`,
  `_multiWorkAdmitted`, `_packBytes`, `_bytes`, `_lied`, `_seedFloorWaived`,
  `_magnetDn`.
- Removidos só no egresso (`applyNoticeOrigin`, `stream-builder.ts:347-353`):
  `_fromFallback`, `_fromSnapshot`, `_fallbackFetchable`, `_bankDub`; e a marca
  `notice` (`:357-362`).
- **No cache** o que não entra é o **host**: aviso e `/resolve` são gravados
  relativos (`stream-builder.ts:324-336`, `src/providers/debrid-pipeline-core.ts:270-283`).
  A lista em si (com `_fromFallback`) **entra** no cache — é assim que o `finish`
  sabe que a entrada é reserva (`src/providers/search-orchestrator.ts:160-163`).

### 2.4 Ordem de chaves

A ordem do JSON do Node é a da construção do objeto e **varia por variante**:

- P2P: `name`, `title`, `infoHash`, `sources`, `behaviorHints`
  (`search-names.ts:205-276`), e `size` por último se aplicável;
- debrid: `name`, `title`, `behaviorHints`, `url`, `size` (o spread de
  `debrid-pipeline-core.ts:274-283` põe `url` no fim; `infoHash`/`sources`
  viram `undefined` e o `JSON.stringify` os omite);
- aviso: `name`, `externalUrl` (`stream-builder.ts:356-362`).

O contrato fixa a **forma**, não a ordem: a comparação de sombra mascara ordem de
chaves e ordem da lista (§9). O struct `StreamItem` do crate foi declarado na
ordem acima para bater byte a byte nas três variantes quando possível
(`rust/crates/adom-search/src/contract.rs`).

---

## 3. Aviso de lista vazia e `applyNoticeOrigin`

### 3.1 Onde o aviso nasce

`buildStreams` (`src/providers/stream-builder.ts:244-296`) escolhe UM texto,
nesta ordem de precedência, e só quando `SEARCH_NOTICE_STREAM` está ligado
(`config.search.noticeStream`, `src/config/search.ts:134`; default `true`):

| Condição | Texto |
|---|---|
| sonda BR pendente (`isBrProbePending`) | `⏳ Busca de dublado BR na fila — aguarde a colheita` |
| `autofetchCount > 0` e dublada oculta | `⏳ Baixando BR dublado no debrid — reabra em alguns minutos` |
| `autofetchCount > 0` | `⏳ Baixando no debrid — reabra em alguns minutos` |
| dubladas existiam e o cachedOnly escondeu **todas** | `Fontes BR dubladas existem, mas ainda fora do cache do debrid` |
| todas as candidatas cortadas por histórico ruim | `Nenhuma fonte pronta — N resultado(s) descartado(s) por histórico ruim nesta conta do debrid` |
| havia candidatas, nenhuma pronta | `Nenhuma fonte pronta — N resultado(s) fora do cache` |
| série sem nada | `Nada pronto ainda — procurando a temporada; reabra em instantes` |
| caso contrário | **nenhum aviso** |

- Lista vazia → o aviso **é** a lista (`[{ name, notice: true }]`).
- Lista com Dual/gringo e o BR todo escondido pelo `cachedOnly` → o aviso é
  **anexado** ao fim, nunca substitui (`stream-builder.ts:287-292`).
- Quarto estado, fora do `buildStreams`: quando o prazo estoura, o texto é
  `Procurando fontes — reabra em instantes` (`src/providers/search-cache.ts:169-176`).

### 3.2 Marca interna e egresso

- `notice: true` é marca interna (`types/domain.d.ts:215-216`); o aviso não tem
  `url`/`infoHash`/`externalUrl` enquanto está no cache.
- `onlyNotice` decide o `cacheMaxAge: 0` (`stream-builder.ts:371-374`;
  `src/routes/stream.ts:47-49`).
- `applyNoticeOrigin` (`stream-builder.ts:337-369`) faz, na resposta:
  1. limpa `_fromFallback`/`_fromSnapshot`/`_fallbackFetchable`/`_bankDub` e
     deriva `size`;
  2. monta `base = PUBLIC_URL || origin() || ''` (sem barra final);
  3. `link = base ? base + prefix() + '/configure' : ''`;
  4. `notice` → `{ ...rest, externalUrl: link }`; sem `base`, o item é
     **descartado** (`[]`);
  5. `url` de `/resolve` → troca o origin pelo `base` atual, preservando
     `pathname + search` (inclusive `sig`/`w`/`s`/`e`). Lista antiga com URL
     absoluta também é reescrita (`stream-builder.ts:310-322`);
  6. `/resolve` sem `base` → descartado.
- `origin()` vem do middleware de `src/routes/register.ts:65-68`, que usa
  `originOf` (`src/routes/origin.ts:17-26`): `PUBLIC_URL` do operador
  (`src/config/debrid.ts:390`) ou `protocolo://Host`, com validação de Host por
  regex — Host forjado não volta na resposta.
- Regra de ouro: **texto do aviso e path do `/resolve` viajam no cache; host só
  na resposta**. Montar antes gravaria o endereço de quem perguntou primeiro.

---

## 4. HMAC do `/resolve` (referência: `docs/RUST-CONTRATOS.md` §1)

### 4.1 Payload

`src/utils/sign.ts:30-35`:

```
payload = `${infoHash}${ep}${hint ? `&w=${hint}` : ''}`
HMAC-SHA256(chave, payload) → hex minúsculo
```

- `infoHash` minúsculo (o verificador baixa antes: `src/routes/resolve.ts:85-86`).
- `ep` é fragmento literal, **sem** `&` inicial: vazio para filme,
  `?s=<S>&e=<E>` para episódio (`src/providers/debrid-pipeline-core.ts:250`).
  O `?` faz parte do payload, não é separador de URL.
- `hint` é JSON **cru** (string), com `&w=` à frente; ausente = nada.

### 4.2 Dica `w` (JSON, ordem de inserção preservada)

Campos possíveis (`src/providers/debrid-pipeline-core.ts:261-268`, lidos em
`src/routes/resolve.ts:96-107`):

| Campo | Significado |
|---|---|
| `n` | lista de nomes da obra (até 4 no consumo, `resolve.ts:102`) |
| `y` | ano (`null` é JSON `null` dentro do objeto) |
| `p: 1` | pack multiobra BR (`BR_MULTIWORK_PACKS`), nunca P2P inteiro |
| `d: 1` | promessa de dublado (claim/prova/`_bankDub`) |
| `i` | IMDb id (`tt…`), sempre que a obra é conhecida |

A ordem das chaves importa: o HMAC é sobre a string, não sobre JSON canônico.
O `w` na URL é `encodeURIComponent(hintJson)` **depois** de assinar
(`debrid-pipeline-core.ts:278-283`); o Express entrega `req.query.w` já
decodificado e a verificação assina o valor cru (`resolve.ts:88`).

### 4.3 Chave

`src/utils/sign.ts:15-17`: `config.debrid.resolveSecret || opts().debridApiKey || ''`.
Sem segredo, `signResolve` devolve `''` e `verifyResolve` devolve `false` (rota
não assinável). Nenhum valor real é documentado.

### 4.4 Forma da URL de play

`src/providers/debrid-pipeline-core.ts:278-283`:

```
<prefix>/resolve/<infoHash>[?s=S&e=E][&w=<hint>]&sig=<hex>
```

`prefix` é `/<config>` (`src/runtime.ts:256-259`) — o play carrega a MESMA
config, senão o debrid do usuário some na hora de tocar.

### 4.5 Verificação e resposta

`src/routes/resolve.ts:84-94`: hash precisa casar `/^[a-f0-9]{40}$/i` (senão
**400**); a checagem HMAC só roda **quando há debrid** (`services.debrid.current()`),
e falha → **403** `assinatura inválida`. Status do play: **302** para o link,
**404** (sem vídeo / episódio ausente / ainda baixando), **429** (rate limit),
**451** (bloqueio legal), **502** (falha do debrid) — `resolve.ts:109-233`.

O router do `/stream` usa **307** para `response.redirect` (não usado hoje pelo
handler) — `src/routes/addon-router.ts:123-125`.

---

## 5. `cacheMaxAge`: quando é 0 e quando pode ser > 0

### 5.1 Regra do handler

`src/routes/stream.ts:46-55`:

```ts
const streams = applyNoticeOrigin(result.streams);
if (onlyNotice(result.streams) || streamsNeedRevalidation(result)) {
  return { streams, cacheMaxAge: 0 };
}
return { streams, cacheMaxAge: config.cacheTtl, staleRevalidate: cacheTtl*4, staleError: 86400 };
```

`streamsNeedRevalidation` (`src/routes/origin.ts:13-15`) é `true` quando:

- lista vazia (`!streams.length`), **incluindo** a lista que só tem aviso;
- `partial === true` (deadline estourado ou lote parcial);
- `needsDebridRefresh === true`;
- `debridKnown === false` (a checagem do debrid não é confiável).

Ou seja: `cacheMaxAge > 0` **só** para lista completa, com debrid conferido e
stream tocável. `onlyNotice` cobre o caso "tem 1 item, é aviso".

### 5.2 `staleRevalidate` / `staleError`

Só no caminho `> 0`: `staleRevalidate = cacheTtl * 4`, `staleError = 86400`
(`src/routes/stream.ts:53-54`). Viram `stale-while-revalidate`/`stale-if-error`
no `Cache-Control` (`src/routes/addon-router.ts:73-83`). Ainda **não** modelados
no crate (§10).

### 5.3 O teto de 60 s NÃO é o `cacheMaxAge` — é o TTL da entrada

Ponto que mais confunde, então explícito:

- `cacheMaxAge` da resposta = `config.cacheTtl` (default **900 s**,
  `src/config/cache.ts:7`; `CACHE_TTL`). Não há corte em 60 s na resposta.
- O **TTL gravado no cache** é que tem teto de 60 s quando a entrada **não** é
  completa (`src/providers/search-orchestrator.ts:170-190`):

  ```ts
  const ttl = hasFallback ? fallbackTtl
            : complete ? config.cacheTtl
            : Math.min(config.cacheTtl, 60);
  ```

  `complete = hasPlayableStream(streams) && !partial && debridKnown && !fallback`
  (`search-orchestrator.ts:170`). Entrada com reserva do banco usa
  `min(cacheTtl, FALLBACK_STREAMS_TTL=120)` (`:173`, `src/config/cache.ts:18`).
- Além do TTL, existe a **graça** do SWR (`STREAM_STALE_GRACE_SECONDS`, default
  300; `src/config/cache.ts:12`): entrada expirada dentro da graça ainda é
  servida **na hora** se for completa, tocável e `debridKnown`
  (`src/providers/search-cache.ts:99-108`, `:200-207`), com refresh em fundo.

Resumo operacional: **resposta "não confiável" → `cacheMaxAge: 0` + TTL ≤ 60 s;
resposta confiável → `cacheMaxAge: CACHE_TTL` + TTL `CACHE_TTL` (+ graça)**.

---

## 6. Estado parcial (`partial: true`) e busca em fundo

- O prazo é **por requisição** (`src/runtime.ts:281-294`): `REPLY_DEADLINE_MS`
  (9200, `src/config/search.ts:74`) ou, para UA que casa `APP_CLIENT_UA`
  (`^Dart/`, `src/config/search.ts:80`), `APP_REPLY_DEADLINE_MS` (15000,
  `src/config/search.ts:79`). O middleware de `register.ts:65-68` grava esse
  valor no contexto antes do router.
- `findStreams` corre a busca contra `raceWithDeadline(task, replyMs, …)`
  (`src/providers/search-cache.ts:160-177`). Ao perder a corrida:
  - `metrics.count('search.deadline')` e o log `[search] deadline de Nms`;
  - devolve `{ streams: [{ name: 'Procurando fontes — reabra em instantes', notice: true }] }`
    (`SEARCH_NOTICE_STREAM` ligado) **ou** `{ streams: [] }`, sempre com
    `partial: true`.
- `partial` **não** é "cache": a busca continua em fundo (`inFlight`,
  `search-cache.ts:120-147`) e o resultado completo reescreve o cache
  (latest-writer) — `src/providers/search-orchestrator.ts:131-194`.
- `partial` também nasce de reserva (`_fromFallback`/`_fromSnapshot`) e de lote
  parcial da coleta (`search-orchestrator.ts:160-163`).
- O handler converte `partial` em `cacheMaxAge: 0` (§5.1). O `staleRevalidate`
  **não** é enviado nesse caminho.
- Prazo de coleta = deadline restante − `DEBRID_RESERVE_MS`
  (`src/providers/search-cache.ts:111-118`); etapa de rede nova num provider
  global precisa caber nele (invariante 1). Série tem fallback de pack no
  caminho crítico + pack tardio sempre mesclando (AGENTS.md, "Série").

---

## 7. Identidade da requisição e namespace

### 7.1 Fórmula

`src/providers/search-cache.ts:62-63` + `src/utils/request-key.ts:9-24`:

```
streams:v21:<type>:<id>:<JSON.stringify(opts SEM debridApiKey)>:account:<accountScope(dk)>
```

- `prefix('streams')` = `streams:v21:` (`src/utils/cache-keys.ts:70,187`);
  versão/quotas em `cache-keys.ts`/`cache-quotas.ts`.
- `opts` é `opts()` **mais** `resolveUncached: config.debrid.resolveUncached`
  (`search-cache.ts:63`) — a decisão de resolver frio no play muda a `url` de
  cada stream, então entra no shape persistido.
- `accountScope(dk)` = SHA-256 hex da chave, ou `'none'` sem chave
  (`request-key.ts:9-12`). A chave crua **nunca** entra na chave, no log ou no
  cache.
- **Host nunca entra**: `streamsCacheKey` não recebe origin. Dois clientes com o
  mesmo install URL compartilham a entrada e cada um recebe o host na resposta
  (§3).
- A ordem das propriedades de `opts` é a de `defaults()` (`src/runtime.ts:93-138`)
  e **importa** (`JSON.stringify` preserva inserção). O crate delega a
  `adom_core::streams_cache_key`, que reproduz essa ordem
  (`rust/crates/adom-core/src/request_key.rs:49-76`).

### 7.2 Nome da função no Rust

O TS não tem `requestKey`: a identidade é `streamsCacheKey` (o arquivo se chama
`request-key.ts` e exporta `accountScope`/`streamsCacheKey`/`streamsCacheScope`).
`adom_core` porta `account_scope`, `streams_cache_key` e `streams_cache_scope`.
`adom-search::request_cache_key` delega a `streams_cache_key` e documenta essa
equivalência — **não** existe uma segunda fórmula a inventar.

### 7.3 Uso na busca

- Leitura: `cache.getWithStale(cacheKey, grace)` (`search-cache.ts:74-81`);
  `get()` puro apaga a entrada expirada e não serve ao SWR.
- Escrita: `cache.set(cacheKey, { streams, partial, debridKnown, trace, searchMeta, fallback? }, ttl)`
  (`search-orchestrator.ts:183-190`).
- Coalescing: `inFlight` por chave (`search-cache.ts:120-156`); refresh SWR em
  mapa separado (`refreshing`, `:30`, `:213-238`).
- Registrar a chave por temporada para o autofetch (`search-cache.ts:64-70`).
- Invalidação por obra: `invalidateStreamsForObra` (`src/utils/br-gap.ts`, usado
  em `resolve.ts` após 451/mentira/episódio ausente).

---

## 8. Erros e códigos (o que o Stremio recebe)

| Situação | Status/corpo | Fonte |
|---|---|---|
| Config na URL inválida (não decodifica) | **404** `text/plain` `configuração inválida` | `src/routes/register.ts:71-75` |
| Handler lança exceção | **500** `{"err":"handler error"}` | `src/routes/addon-router.ts:127-130` |
| `resource !== 'stream'` | rejeita com `noHandler` → `next()` (404 do Express) | `addon-router.ts:56-58`, `:128` |
| Erro **dentro** do handler de stream | **200** `{"streams":[],"cacheMaxAge":0}` + `log.error('[stream]')` | `src/routes/stream.ts:56-59` |
| `id` que não começa com `tt` | **200** `{"streams":[],"partial":false}` → `cacheMaxAge: 0` | `src/providers/search-cache.ts:46-48` |
| Prazo estourado | **200** aviso/lista vazia + `cacheMaxAge: 0` | `search-cache.ts:160-177`, `stream.ts:47-49` |
| `redirect` no response | **307** | `addon-router.ts:123-125` |
| `/resolve` com hash inválido | **400** texto | `src/routes/resolve.ts:86` |
| `/resolve` sem HMAC válido (com debrid) | **403** `assinatura inválida` | `resolve.ts:89-94` |
| `/resolve` sem link / sem vídeo / episódio ausente | **404** | `resolve.ts:117-121`, `:137-152`, `:203-229` |
| `/resolve` rate limit / bloqueio legal / falha | **429** / **451** / **502** | `resolve.ts:157-167`, `:231-232` |
| `OPTIONS` | **204** (CORS) | `addon-router.ts:64-71` |

Observação de contrato: **o `/stream` quase não usa status de erro** — o cliente
Stremio trata não-200 como addon quebrado. Erro de busca vira lista vazia + 200;
500 só quando o handler inteiro estoura (bug), e mesmo assim a mensagem é
genérica (nada de stack/segredo).

---

## 9. Métrica de sombra: `stream.shadow.divergence`

### 9.1 Modo sombra

Com `ROUTES_RUST=stream-shadow` o Node responde o `/stream` e o orquestrador
Rust roda **em paralelo**, com o MESMO contexto de requisição (config
decodificada, deadline, origin), e **só compara**. Store isolado em memória
(§0.4); sem debrid, sem gravação SWR, sem efeitos de cauda. Timeout ou erro do
Rust não afeta o usuário.

Com `ROUTES_RUST=stream` (opt-in experimental, §0.1) o cliente **não** passa
pelo Node nem pela sombra: o nativo responde. Default do override continua
sombra. Os contadores abaixo seguem úteis com sombra ligada; no corte puro o
alarme operacional é a lista/HTTP do próprio caminho nativo — e BR+cotas
ainda precisam fechar antes de qualquer default.

### 9.2 Contadores e amostra

| Nome | Tipo | Semântica |
|---|---|---|
| `stream.shadow.compared` | contador | 1 por busca comparada (o denominador) |
| `stream.shadow.divergence` | contador | **1 por busca que divergiu**, independente de quantos itens/campos divergiram |
| `stream.shadow.divergence.items` | contador | soma dos itens divergentes na busca (magnitude, não frequência) |
| `stream.shadow.timeout` | contador | Rust estourou o prazo e não produziu corpo comparável |
| `stream.shadow.error` | contador | Rust falhou (panic/erro interno); nunca conta como divergência |
| `stream.shadow.rustMs` | observação | tempo do Rust até o corpo (alvo: ≤ prazo do Node) |

Amostra do diff (só quando `divergence` incrementa, no máximo **1 por busca**,
truncada em 4 KiB):

```json
{
  "searchKeyHash": "<sha256 da streamsCacheKey — nunca a chave crua>",
  "type": "movie", "id": "tt…", "partial": true,
  "nodeBodyHash": "<sha256 do corpo normalizado>",
  "rustBodyHash": "<sha256 do corpo normalizado>",
  "diff": {
    "cacheMaxAge": { "node": 0, "rust": 900 },
    "streamCount": { "node": 3, "rust": 2 },
    "items": [
      { "index": 0, "field": "url", "node": "{{base}}/…/resolve/…?sig={{sig}}", "rust": null }
    ]
  },
  "masked": true
}
```

### 9.3 O que a comparação MASCARA (fora do diff)

1. **Relógio**: `capturedAt`, headers `Date`/`Age`/`ETag`, duração de qualquer
   etapa, `staleRevalidate` derivado de relógio — nada disso entra no hash nem
   no diff.
2. **Ordem**: da lista de `streams` (ordena por `infoHash`, depois `url`, depois
   `externalUrl`) e de chaves de objeto (JSON canônico com chaves ordenadas).
   O Node não promete ordem estável entre variantes (§2.4).
3. **HMAC/config/host**: `sig` vira `{{sig}}`; o segmento de config vira
   `{{config}}`; a origem do addon (inclusive `PUBLIC_URL` diferente do `Host`)
   vira `{{base}}`. Sem isso o diff acusaria diferença de portal, não de lógica.
4. **Contadores internos** (`metrics`, `trace`) e qualquer campo `_*`.

Tudo o mais é contrato: `cacheMaxAge`, `staleRevalidate` (quando presente),
quantidade e identidade dos streams, `name`/`title`/`size`/`sources`/
`behaviorHints`/`externalUrl`.

### 9.4 Critério de "zero divergência" antes do corte por rota

Uma rota (par `type` × variante de resposta) só pode ser cortada quando TODOS
os itens abaixo valerem na janela:

1. **Cobertura**: ≥ **500** buscas reais comparadas (`stream.shadow.compared`) e
   ≥ **72 h** contínuas com sombra ligada — as duas condições, não uma.
2. **Distribuição mínima** dentro da janela: filme e série; com e sem debrid;
   com e sem ⚡; com e sem aviso (as 4 variantes do §3.1 que a instalação
   alcança); pack multiobra admitido; config com e sem `dk`.
3. **Zero** `stream.shadow.divergence` e zero `stream.shadow.divergence.items`
   na janela (inclusive nos casos de borda acima).
4. **Zero** `stream.shadow.timeout` e `stream.shadow.error` na mesma janela.
5. **Camada A — corpus congelado**: `npm run parity:frozen`
   (`rust/golden/stream-frozen`, contrato em
   [`stream-frozen-gate.md`](stream-frozen-gate.md)) com **100 %** dos casos
   batendo depois da máscara (§9.3). Node e Rust consomem as MESMAS entradas
   (meta, lotes crus, inventário da conta, veredito de debrid): divergência ali
   é pipeline, não ruído de coleta. A captura precisa ter sido recapturada na
   mesma versão.
6. **Camada B — ao vivo (informativa)**: `scripts/stream-parity.mjs` continua
   rodando como tendência; não bloqueia sozinha, mas **zero BR faltando** na
   janela. O ruído de coleta (Jackett/Flare/banco lidos em instantes diferentes)
   não pode ser confundido com divergência de pipeline.
7. **Revisor humano** assina a amostra: os últimos 8 KiB de diffs vazios e a
   lista de casos cobertos.

Estado da camada A (2026-10-20): **16 casos**, **13 exatos** (Node replay
16/16). As 3 divergências abertas — `movie-matrix` (`p:1` de multiobra),
`series-anime-naruto-s01e01` (seleção/ranking de pack) e
`series-breaking-bad-s01e01` (total de pack de faixa no 💾) — estão listadas em
`stream-frozen-gate.md` e bloqueiam o corte até a Fase 2 fechar. O comando é
`cargo test -p adom-search --test stream_frozen_parity` (ou
`npm run parity:frozen`); o alvo NÃO é `#[ignore]`.

Corte é **por rota**, com canário: 5 % → 50 % → 100 %, exigindo **zero**
divergência em cada degrau por ≥ 24 h. Regrediu, volta um degrau e a rota
continua Node. O contador `stream.shadow.divergence` **não** pode ser apagado
depois do corte: ele vira o alarme permanente do caminho nativo.

---

## 10. O que ainda falta / o que já entrou no caminho nativo

Estado da Fase F: **sombra default** no override gateway; corte
`ROUTES_RUST=stream` só experimental. Fonte TS continua a régua. Código Rust
já responde no caminho nativo quando o token `stream` está ligado — mas isso
**não** implica aceite: falta paridade BR+cotas (§0.1 / §0.7).

| # | Item | Estado |
|---|---|---|
| 1 | fatia debrid do `defaults()` do operador no decode | **feito** no gateway (`operator_debrid_defaults_from_env`, `dd9330c4`); selo `dk` / `secret-box` segue no Node no decode completo da URL |
| 2 | opções na chave (incl. `resolveUncached`) | **feito** no orquestrador (`OrchestratorConfig`) |
| 3 | SWR + graça + coalescing | **feito** (`SwrStore` / `STREAMS_DB` no nativo; `MemorySwrStore` na sombra) |
| 4 | metadados Cinemeta/TMDB (+ multiobra / data doméstica) | via `POST /internal/search/meta` (Node); porte puro de fontes = F2 |
| 5 | plano / orçamentos de coleta | decisões no núcleo; janela ainda orquestrada com I/O Node |
| 6 | coleta Jackett/Prowlarr/Torrentio/BLUDV/Mico/… + `raw:v1` | default: `POST /internal/search/collect`; opt-in `SOURCES_RUST=jackett\|prowlarr\|torrentio\|bludv\|mico` (composição: fontes nativas + `NodeCollector` com `skip_sources`; sem `raw:v1` nessa fatia) |
| 7 | pipeline de build (filtro, ranking, cotas, aviso) | orquestrador/núcleo; **paridade BR+cotas ainda aberta** (bloqueia default do corte) |
| 8 | debrid (`applyDebrid`, ⚡, HMAC na URL) | **feito** com adaptadores + reserva Node (`INTERNAL_CHECK_URL`); autofetch/efeitos de cauda ainda no Node |
| 9 | assinatura `/resolve` no servidor | guarda HMAC nativa opt-in (`ROUTES_RUST=resolve`); play completo ainda no Node |
| 10 | host/origin e `prefix()` no egresso | **feito** no caminho nativo |
| 11 | `partial`/deadline + busca em fundo | **feito** no orquestrador |
| 12 | `cacheMaxAge` / `stale*` / `Cache-Control` | parcial — ver tipo `StreamResponse` e handler nativo |
| 13 | mapeamento de erro → status (incl. `/resolve`) | parcial no gateway; `/resolve` play no Node |
| 14 | métricas e `stream-trace` | sombra §9; painel/`stream-trace` ainda leem o Node |
| 15 | `staleRevalidate`/`staleError` no tipo | ainda estreito no contrato do crate |
| 16 | `/internal/search/*` | **feito** meta/state/collect (e correlatos) no Node; fachada recusa `/internal/*` antes do proxy |

Override gateway: sombra (`stream-shadow`). Produção e o compose principal
também **não** usam `ROUTES_RUST=stream` — F4 em
[`migracao-stream-rust.md`](migracao-stream-rust.md) só depois de paridade
BR+cotas + §9.4.

---

## 11. Divergências conhecidas desta fatia (decisões, não bugs)

1. **UA do app**: `runtime.clientReplyDeadline` usa `new RegExp(config.appClientUa)`
   (`src/runtime.ts:286-294`), cujo default `^Dart/` é **case-sensitive** e
   configurável por env. `adom-search::reply_deadline_ms` compara o prefixo
   ASCII **sem caixa**, como pedido para esta fatia. Antes do corte, confirmar
   com o `APP_CLIENT_UA` do operador: UA em caixa diferente da regex ganharia
   prazo diferente entre Node e Rust.
2. **`decode_user_config` sem defaults e sem selo**: aplica o overlay sobre `{}`
   e passa segredo vazio (`adom_search::decode_user_config`). Com uma `dk`
   selada, o valor volta selado — a integração precisa chamar
   `adom_core::decode_config` com os defaults reais e o `RESOLVE_SECRET`.
3. **Ordem das chaves** não é contrato (§2.4): o struct do crate segue a ordem
   mais comum e o teste byte a byte cobre P2P, debrid e aviso; a sombra mascara
   ordem.
4. **`request_cache_key`**: não existe `request_key` em `adom-core`; o nome do
   crate é um apelido de `streams_cache_key` (§7.2).
5. **`/stream` com `:extra`**: rejeitado por `parse_stream_path`; o Node ignora
   o segmento para o handler mas o usa na URL. Implementar quando a fatia do
   `extra` chegar.
