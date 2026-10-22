# Contrato do `/stream` — o que o orquestrador Rust precisa reproduzir

Status: **contrato F0 fixado** a partir do TypeScript. Desde o **F4.4** o corte
nativo é o **PADRÃO** e, desde o **R8**, é **fixo**: `GATEWAY=on` e
`ROUTES_RUST=stream` moram no `docker-compose.yml` e o `entrypoint.sh` sempre
sobe o gateway (7000) com o Node na 7100. O pipeline TS de busca saiu e o
`/stream` do Node responde **410** (503 só no diagnóstico de proxy com
`ROUTES_RUST` vazio/`health`). As seções §9.4/§9.5 (sombra e canário) são
**histórico**: o código e as flags (`stream-shadow`, `STREAM_SHADOW_MODE`,
`STREAM_CANARY_*`, `STREAM_FROZEN_*`) foram **removidos no R1**, porque a
referência era o `/stream` do Node, que não existe mais. O gate vigente é o
corpus congelado (`cargo test -p adom-search --test stream_frozen_parity`,
16/16) e o corpus e2e 51/51 (`--test stream_e2e_parity`). Rollback de qualquer
fatia é commit/imagem anterior, não env. Nada nos §§1–8 é proposta: cada
afirmação tem `arquivo:linha` do fonte real. O orquestrador vive em
[`rust/crates/adom-search`](../rust/crates/adom-search/src/lib.rs); a fachada
que corta a rota é [`adom-server`](../rust/crates/adom-server/src/stream.rs).
As referências de `src/providers/*` nos §§1–8 são a **derivação original** do
contrato (branch `esm`/commit `c11cb720`): esses arquivos saíram no F4.4 e o
código vigente é o Rust indicado em cada seção.

Ordem de leitura sugerida: §0 (estado operacional) → §1 (rota) → §2 (corpo) →
§3 (aviso) → §5 (cache) → §7 (identidade) → §9 (métrica). Os §§4/6/8 são as
regras que mais quebram.

---

## 0. Estado operacional (F4.4 — corte nativo é o padrão; R8 — fixo)

### 0.1 Compose padrão e override de diagnóstico

O **compose padrão** já sobe o gateway (`docker-compose.yml`), sem modo
configurável:

| Env | Valor | Papel |
|---|---|---|
| `GATEWAY` | `on` (fixo) | `adom-server` na 7000; Node atrás na 7100 |
| `ROUTES_RUST` | `stream` (fixo) | corte nativo do `/stream` |
| `INTERNAL_SEARCH_URL` / `INTERNAL_CHECK_URL` | `http://127.0.0.1:7100` | rotas internas (meta/effects/holds) — **nunca** `:7000` (a fachada recusa `/internal/*`) |

O `entrypoint.sh` **sempre** inicia o gateway; binário ausente é erro fatal. O
`docker-compose.gateway.yml` é **só diagnóstico**: publica o Node em
`127.0.0.1:7100` e não muda flag nenhuma. `ROUTES_RUST=` (vazio) e
`ROUTES_RUST=health` continuam como **diagnóstico do proxy** (o gateway só
encaminha; nesse caso o `/stream` do Node responde 503) — não são modo de
busca.

Rollback de **todas** as fatias (fontes, conta, índice, banco, metadados,
AllDebrid, store, trace, crawl) é **commit/imagem anterior**. As flags de
rollback por env (`SOURCES_RUST`, `ACCOUNT_RUST`, `INDEX_RUST`, `BANK_RUST`,
`META_RUST`, `DEBRID_AL_RUST`, `STREAM_STORE_RUST`, `STREAM_BAD_RUST`,
`STREAM_SHADOW_MODE`, `STREAM_CANARY_*`, `STREAM_FROZEN_*`, `GATEWAY=off`,
`ROUTES_RUST=stream-shadow`) **não existem mais**. Continuam existindo só os
knobs que ainda governam comportamento vivo: `EFFECTS_RUST=off` (default ON —
desliga a emissão de efeitos, ver
[`rust-effects-contract.md`](rust-effects-contract.md)). O play não tem knob:
`/resolve` é nativo e incondicional (§0.8).

**R3**: a checagem/limpeza da AllDebrid é nativa e incondicional; a rota Node
`/internal/debrid/check` foi apagada. `DEBRID_AL_HOLDS`/`DEBRID_AL_CLEANUP`
FICAM como kill-switches das varreduras **destrutivas** (default do código OFF,
compose ON): sem holds/inventário a nativa é read-only. Contrato em
[`debrid-al-check-rust.md`](debrid-al-check-rust.md).

Desde o **F4.7** (fase C) o play por debrid é **nativo e incondicional** no
gateway: não há flag, o Node não monta a rota e não há proxy de rollback. HMAC,
`pickFile`, adaptadores e status/texto de erro são os do Node; efeitos L1
(`magnetdb`/`davail`/invalidação/ledger) continuam sendo GRAVADOS pelo Node
pelas rotas internas. Detalhe e limites no §0.8.

Sombra e canário são **histórico** (§9): o código saiu no R1 e não há
instrumento de comparação no binário.

### 0.2 Debrid com herança do `.env`

Install sem `dk` na URL herda a fatia debrid do operador
(`DEBRID_SERVICE` / `DEBRID_API_KEY` / `DEBRID_CACHED_ONLY` /
`DEBRID_SHOW_UNCACHED_BR`, gate `DEBRID_ALLOW_ENV_KEY`) via
`operator_debrid_defaults_from_env` no gateway (`adom-server/src/stream.rs`,
commit `dd9330c4`). Sem isso o orquestrador caía em `NoDebridCheck` (lista só
`infoHash`, sem ⚡/`/resolve`) enquanto o Node na 7100 aplicava debrid — o
smoke Docker com chave só no `.env` depende dessa herança (não confundir
com aceite de paridade BR).

### 0.3 Collect: nativo e incondicional (F4.4; R5)

- As **cinco fontes** (jackett, prowlarr, torrentio, bludv, mico) e o
  inventário da conta rodam no Rust, sem flag: `SOURCES_RUST`/`ACCOUNT_RUST` e
  o `NodeCollector` (com `skip_sources` e `POST /internal/search/collect`)
  saíram no R5. Gateway sem **nenhuma** fonte nativa montada é **erro de
  boot**.
- Metadados: o nativo é a fonte primária e o Node é **fallback vivo** por
  `POST /internal/search/meta` (R6) — a taxa de fallback ainda não foi medida.
- Índice e banco são nativos (R4). Falha ao abrir `idx:v14`/`magnets.db`
  degrada **sem índice** (log `[search]`, métrica `index.rust.source_missing`),
  nunca cai no Node.
- `EFFECTS_RUST` (default ON) e o feed de holds são os únicos caminhos em que o
  orquestrador ainda chama o Node.

### 0.3.1 Prova de arquivo/qualidade no item (`provenQuality`)

A prova viaja **no próprio item** (`RawItem`), não há campo/rota extra no
protocolo; no corte quem a popula é a via nativa do índice/banco (as rotas Node
saíram no R4). Os nomes TS abaixo são os da derivação original, mantidos como
referência do contrato:

- `provenAudio`/`provenName` — `applyFileEvidence` (evidência do `releaseIndex`);
- `provenQuality` — `stampProvenQuality` (`fsz` + `pickFile` + nome do arquivo
  escolhido; senão a medição `vres` já feita). Sem sonda nova na rota.

O Rust lê em `RawItem::proven_quality` e o `map_stream` usa ANTES do título: é o
que decide o balde de qualidade do `limit_reserving_br`. Sem o campo o índice
manda o release como "sem resolução" e o corte troca o BR por um 4K global
(Interestelar BR `f320`, 2026-10-20).

`files_by_hash` (memo `fsz` do build) **não** é o portador da prova: só o gate
congelado o injeta (`with_files_by_hash`); no caminho de produção ele segue
vazio e o Rust só o usaria para 💾/tamanho. Medido no replay: com `files` e sem
`provenQuality` a lista diverge igual a não ter prova; com `provenQuality` e sem
`files` a lista bate (só o chip de áudio muda, prova separada).

### 0.3.2 Tamanho de pack (`💾` / `📦 pack`) no replay

O Node anota tamanho **duas vezes**: `stream-builder.ts` (pré-debrid) e
`debrid-pipeline-core.ts` (pós). O `📦 pack` só nasce na 2ª quando a 1ª já
preencheu o `💾`, e a 2ª NÃO roda quando o veredito é `unusable` (auth/quota) —
por isso o mesmo item alterna entre `💾 X` e `💾 X 📦 pack X` conforme o memo
`fsz`/`tsz` no instante do build. O record grava o estado de CADA passada:

- `inputs/files.json`/`totals.json` — pós-checagem (o que o replay já usava);
- `inputs/files-build.json`/`totals-build.json` — pré-debrid. `{}` = a passada
  rodou com o memo frio; ausência = captura antiga (o replay mantém a régua
  anterior, sem a 1ª passada).

O replay (`FrozenCase` → `with_build_pass` → `BuildContext.files_at_build`)
roda o mesmo composto nas duas passadas — total do torrent → anotação → corte do
texto → fill do 💾 — e, com `unusable`, usa o estado do pré sem repetir a
anotação de pack. **Produção ainda não busca `fsz`/`tsz`**: no corte nativo os
títulos de pack podem divergir do Node (gap de contrato).

### 0.3.3 Aviso de coleta vazia no comparador

Expected sem streams ou só com avisos não é comparável (§9.4 item 6, histórico):
a comparação **pula** (não conta `compared` nem `divergence`) — a 2ª request congelada pode
herdar a coleta vazia/parcial da original enquanto a captura tem o lote. O
envelope do aviso **perde o campo `notice`** (vira `{name, externalUrl:
".../configure"}`), então o reconhecimento é por flag, pelo texto
(`Procurando fontes`/`reabra em instantes`/`fora do cache`) e pelo
`externalUrl` sem `url`/`infoHash`. Retry não resolve: a coleta vazia é
transiente e a captura já é a melhor evidência do build.

### 0.3.4 Cache hermético: o veredito vem do `apply-debrid.json`

O `debrid.json` da captura pode ser de OUTRA chamada (na época, a rota Node
`/internal/debrid/check`, hoje apagada — a checagem é nativa desde o R3 —, com a
conta em quota) e o replay então marcava
`[AD download]` onde o expected mostra `[AD⚡]`. O veredito POR HASH passa a sair
do `apply-debrid.json` — o `name` aplicado é o veredito final que gerou o
expected: `⚡` = em cache, prefixo `[` sem `⚡` = fora do cache com link do
debrid, sem prefixo = P2P. A sobreposição só vale quando o lote tem algum `⚡`
(evidência de cache fresco); sem isso vale o `debrid.json`/`calls` — capturas
antigas do corpus não têm `⚡` e não mudam.

### 0.4 Store SWR: `STREAMS_DB` no nativo

| Modo | Store | Path |
|---|---|---|
| corte (`ROUTES_RUST=stream`) | `StreamsStore` (SQLite) → fallback memória se abrir falhar → último recurso `MemorySwrStore` | `STREAMS_DB` ou default `data/streams.db` (volume `docker-data/addon`) |

A antiga sombra usava um `MemorySwrStore` fresco só para não furar o
compare-only (hit/DELETE no SQLite do nativo). Com a sombra removida no R1,
esse caminho não existe mais.

### 0.5 Caveat conhecido: 1ª hit a frio

Na 1ª requisição a frio (store vazio, Jackett/Flare frios, sem SWR) a coleta
pode assentar **parcial** sem candidatos. Desde `49482cc7`, parcial/collect
falho com lista vazia devolve o aviso
`Procurando fontes — reabra em instantes` (não mais `{ "streams": [] }`
silencioso nesse caso). Filme *completo* sem candidatos ainda pode ser `[]`.
A 2ª hit / SWR costuma preencher tocáveis — não tratar só o aviso na 1ª batida
como regressão de matching sem repetir a busca.

### 0.6 Gap de CI

Nenhum workflow em `.github/workflows/` exercita o corte de ponta a ponta:

- `rust.yml` — crates + goldens (sem HTTP do `adom-server` com corte);
- `docker.yml` — build da imagem (sem smoke de `/stream` nativo);
- `ci.yml` — suíte Node.

Validar o corte é **manual/local**. O YAML de CI **não** entra nesta fatia
docs. Smoke mínimo (compose padrão §0.1; Matrix `tt0133093`) — só forma HTTP,
**não** é aceite de paridade:

```bash
# O compose padrão já sobe o gateway; o override gateway.yml só publica o Node
# em 127.0.0.1:7100 (diagnóstico) e não é necessário para este smoke.
docker compose up -d --build --force-recreate adom
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
script **não** prova paridade BR+cotas: o corte já é o padrão (R8) e o gate é o
corpus congelado (§0.6 e §9.4 item 5, `npm run parity:frozen` 16/16).

### 0.8 Play `/resolve`: nativo e incondicional

O play por debrid é resolvido **no gateway**, sem flag e sem proxy: o handler
Node (`src/routes/resolve.ts`) e o `respondWhenRustApplied` saíram na fase C, e
não há env que devolva a rota ao Node — rollback é **commit/imagem anterior**.

- O gateway valida o HMAC (`resolve_play_from` + `verify_resolve_play`) e
  resolve no Rust (`adom_debrid::play`), com o mesmo `pickFile` e o mesmo
  status/texto de erro do Node: 400 hash inválido, 403 assinatura inválida,
  404 "ainda está baixando" (sem link), 404 NoVideo/DubLie/EpisodePick/WorkPick,
  429 rate limit, 451 bloqueio legal e 502 para o resto. Nada é encaminhado ao
  Node.
- A config do usuário sai do segmento da URL (`ds`/`dk`) com o default do
  operador; sem adaptador (`current()` null) a rota devolve o mesmo 404 do Node
  e não exige HMAC. `RESOLVE_SECRET` segue como segredo do HMAC (precede o `dk`
  da URL).
- **AllDebrid no teto:** o `/magnet/upload` recusa com `MAGNET_TOO_MANY` e o
  nativo devolve **502** explícito (`kind=quota`), sem mascarar em 404 nem cair
  no proxy — um segundo upload pioraria a conta.
- **Efeitos L1** (`magnetdb`/`davail`, invalidação do `streams.db`, ledger/memo
  do RD) continuam sendo **GRAVADOS pelo Node**: o gateway manda para
  `POST /internal/resolve/effects` (loopback + token) e, no erro, espera a
  gravação antes de responder; o hold do autofetch da AllDebrid vem de
  `POST /internal/resolve/facts`. Sem token interno o play responde, mas não
  grava nada (log no boot). O 302 e os erros são nativos; a observabilidade
  pós-play é do Node.
- **HMAC/origin:** o payload (`hash + ?s=S&e=E + &w=<hint>`) e a URL relativa
  não mudaram; `manifest` e URLs de play não precisam de bump.

Medido em **2026-10-20** (container `stremio-adom`, `GATEWAY=on`, Node na 7100,
com `ROUTES_RUST=stream-shadow` — flag da época, removida no R1):

- `/debrid-status.json` (loopback + `X-Indexer-Test-Token`):
  `{"service":"alldebrid","magnets":977,"ready":972,"active":5,"error":0,"cached":false,"warn":false,"warnAt":4000}`.
  O `warnAt=4000` não antecipa o teto real de 1000: o primeiro sinal é o erro de
  upload. O mesmo vale para o freio do autofetch
  (`DEBRID_AUTO_FETCH_PAUSE_AT=2000`): os dois limiares do app estão acima do
  teto do serviço, então nada freia antes do `MAGNET_TOO_MANY`.
- O `/magnet/upload` do AllDebrid (que É a checagem de cache e a **1ª etapa** do
  `resolveLink`, `src/debrid/alldebrid-play.ts:42`) recusa até hash que já está
  `Ready` na conta: `MAGNET_TOO_MANY` — `Magnets limit reached (1000 accross all
  tabs)`. O teto efetivo não é derivável da listagem: ela devolve 977, mas nem
  um único upload passa (o adaptador já documenta a discrepância dos dois
  limites em `alldebrid-api.ts:216-222`).
- `/resolve/<hash>?sig=…` pela **7000** (gateway) e pela **7100** (Node) devolveu
  **502**; o log é `[resolve] Magnets limit reached (1000 accross all tabs)`.
- O mesmo item está `Ready` (1 arquivo,
  `Kung.Fu.Panda.4.2024.1080p.WEBRip.Dublado.mkv`, 1.952.177.653 bytes) e o
  `/link/unlock` devolve link em `rpiqwx.debrid.it` que responde **206**
  `bytes 0-0/1952177653`. O arquivo é tocável; o bloqueio é o teto de magnets,
  não o link.

O **302** de play real já foi observado na janela de sombra (histórica) com a
conta folgada (estado do operador, antes de o corpus encher a conta). Nesta medição ele **não** se
reproduz: 502 em todas as tentativas. Não prometer play por AllDebrid enquanto o
teto não for liberado — a prova de play real exige `/resolve` devolvendo **302**
para um link tocável.

Limpeza segura medida na mesma conta: 972 `Ready` + 5 `Downloading` + **0**
terminal ⇒ `sweepDead` = 0 (a ação `sweep-dead` do painel devolveu
`{"varridos":0,"falhas":0}`); nenhum não-pronto órfão ⇒ `dropUncached` = 0;
`reconcile` desligado (`DEBRID_RECONCILE=false`) e os 68 magnets com posse
`adsub` tinham <24 h (piso de idade) ⇒ 0 candidatos; `sweepUndubbed` também não
alcança (os 43 nomes com veredito estrangeiro são todos <7 dias e vários são
filmes BR, como `Central.do.Brasil` e `Carandiru`). O `cleanup-preview` do painel
devolve `targets: []` (`notCondemned: 761`). Em resumo: **a limpeza automática do
app não libera vaga** — os 904 magnets sem posse são tratados como acervo
protegido e a condenação por nome não é segura.

Ação do operador (manual, fora do app): apagar no painel do AllDebrid magnets
que não sejam acervo BR nem os 5 downloads ativos, até o `/magnet/upload` voltar
a aceitar. `DEBRID_BATCH_SIZE=25`, então liberar **≥25** (ideal ~50) evita que o
primeiro lote volte a bater no teto; depois repetir a busca e só declarar play
por debrid com `/resolve` **302** medido. Não usar `cleanup-apply`/
`includeKnown` como atalho: o preview não seleciona alvos e os "estrangeiros" por
nome incluem filmes BR.

Não medido nesta rodada: o play nativo contra um debrid real (só contrato,
fixtures e testes offline; o caminho de proxy foi o exercitado) e qualquer
limpeza destrutiva — nenhuma foi executada.

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

O contrato fixa a **forma**, não a ordem: a comparação da sombra (histórica)
mascarava ordem de
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

- `infoHash` minúsculo (o verificador baixa antes: `resolve_native.rs`, `resolve_play_from`).
- `ep` é fragmento literal, **sem** `&` inicial: vazio para filme,
  `?s=<S>&e=<E>` para episódio (`src/providers/debrid-pipeline-core.ts:250`).
  O `?` faz parte do payload, não é separador de URL.
- `hint` é JSON **cru** (string), com `&w=` à frente; ausente = nada.

### 4.2 Dica `w` (JSON, ordem de inserção preservada)

Campos possíveis (`src/providers/debrid-pipeline-core.ts:261-268`, lidos em
`rust/crates/adom-server/src/resolve_hint.rs`):

| Campo | Significado |
|---|---|
| `n` | lista de nomes da obra (até 4 no consumo, `resolve_hint.rs`) |
| `y` | ano (`null` é JSON `null` dentro do objeto) |
| `p: 1` | pack multiobra BR (`BR_MULTIWORK_PACKS`), nunca P2P inteiro |
| `d: 1` | promessa de dublado (claim/prova/`_bankDub`) |
| `i` | IMDb id (`tt…`), sempre que a obra é conhecida |

A ordem das chaves importa: o HMAC é sobre a string, não sobre JSON canônico.
O `w` na URL é `encodeURIComponent(hintJson)` **depois** de assinar
(`debrid-pipeline-core.ts:278-283`); o Express entrega `req.query.w` já
decodificado e a verificação assina o valor cru (`resolve_hint.rs`).

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

`resolve_native.rs` (`valid_hash` + `verify_resolve_play`): hash precisa casar
`/^[a-f0-9]{40}$/i` (senão **400**); a checagem HMAC só roda **quando há debrid**
(`services.debrid.current()`), e falha → **403** `assinatura inválida`. Status do
play: **302** para o link, **404** (sem vídeo / episódio ausente / ainda
baixando), **429** (rate limit), **451** (bloqueio legal), **502** (falha do
debrid) — a régua única é `adom_debrid::resolve_effect`.

O router do `/stream` usa **307** para `response.redirect` (não usado hoje pelo
handler) — `src/routes/addon-router.ts:123-125`.

Estado operacional do play (inclui o bloqueio por teto do AllDebrid e a
diferença Node × nativo) em §0.8.

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
- Invalidação por obra: `invalidateStreamsForObra` (`src/utils/br-gap.ts`, nos
  efeitos do play nativo após 451/mentira/episódio ausente).

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
| `/resolve` com hash inválido | **400** texto | `resolve_native.rs`, `valid_hash` |
| `/resolve` sem HMAC válido (com debrid) | **403** `assinatura inválida` | `resolve_native.rs`, `verify_resolve_play` |
| `/resolve` sem link / sem vídeo / episódio ausente | **404** | `resolve_native.rs` + `adom_debrid::resolve_effect` |
| `/resolve` rate limit / bloqueio legal / falha | **429** / **451** / **502** | `resolve_native.rs` + `adom_debrid::resolve_effect` |
| `OPTIONS` | **204** (CORS) | `addon-router.ts:64-71` |

Observação de contrato: **o `/stream` quase não usa status de erro** — o cliente
Stremio trata não-200 como addon quebrado. Erro de busca vira lista vazia + 200;
500 só quando o handler inteiro estoura (bug), e mesmo assim a mensagem é
genérica (nada de stack/segredo).

---

## 9. Sombra e canário — HISTÓRICO (removidos no R1)

> **Histórico (R1):** sombra e canário foram **removidos do binário**. Não
> existem mais `stream-shadow`, `STREAM_SHADOW_MODE`, `STREAM_CANARY_*`,
> `STREAM_FROZEN_*` nem os contadores `stream.shadow.*`/`stream.canary.*`.
> O gate vigente é o corpus congelado (§0.6; `npm run parity:frozen`, 16/16) e o
> e2e 51/51 (`--test stream_e2e_parity`). Este §9 fica pela rastreabilidade da
> janela que autorizou o corte — nada aqui é knob vigente.

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

`STREAM_SHADOW_MODE=frozen|direct` (default `frozen`) escolhe o comparador da
sombra. `frozen` é o caminho F4.2 (2ª request congelada + `FrozenCase`).
`direct` (F4.3) ignora a captura mesmo com `STREAM_FROZEN_SHADOW_BASE` e usa a
remontagem ao vivo (`build_shadow_orchestrator`) contra o corpo normal do Node
— o mesmo fallback de quando não há base; sem token/env, a sombra pula sem
falso `divergence`. Como o remount usa `NoDebridFactory`, com debrid a
comparação direta é pré-debrid × pós-debrid (divergência esperada); por isso o
default segue `frozen` e o `direct` é informativo/transição, não o alarme da
janela §9.4. Rollback: `STREAM_SHADOW_MODE=frozen`.

### 9.2 Contadores e amostra

| Nome | Tipo | Semântica |
|---|---|---|
| `stream.shadow.compared` | contador | 1 por busca comparada (o denominador) |
| `stream.shadow.divergence` | contador | **1 por busca que divergiu**, independente de quantos itens/campos divergiram |
| `stream.shadow.divergence.items` | contador | soma dos itens divergentes na busca (magnitude, não frequência) |
| `stream.shadow.timeout` | contador | Rust estourou o prazo e não produziu corpo comparável |
| `stream.shadow.error` | contador | Rust falhou (panic/erro interno); nunca conta como divergência |
| `stream.shadow.rustMs` | observação | tempo do Rust até o corpo (alvo: ≤ prazo do Node) |

No corte (`ROUTES_RUST=stream`) a sombra não roda; os nomes acima continuam
exclusivos do modo `stream-shadow`. O instrumento equivalente no corte é
`stream.canary.*` (§9.5), com seleção determinística e flag própria.

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

Estado da camada A (2026-10-20): **16 casos**, **16/16 Node e 16/16 Rust**
(`cargo test -p adom-search --test stream_frozen_parity`, 3 execuções verdes).
O comando é `cargo test -p adom-search --test stream_frozen_parity` (ou
`npm run parity:frozen`); o alvo NÃO é `#[ignore]`. Fechar a camada A não é
aceite do corte: a Fase 2 (BR+cotas, sombra ≥500 buscas/≥72 h, corpus e2e
recapturado e `/resolve`) segue obrigatória.

Corte é **por rota**, com canário: 5 % → 50 % → 100 %, exigindo **zero**
divergência em cada degrau por ≥ 24 h. Regrediu, volta um degrau e a rota
continua Node. O contador `stream.shadow.divergence` **não** pode ser apagado
depois do corte: ele vira o alarme permanente do caminho nativo.

No corte (`ROUTES_RUST=stream`) a sombra não roda; o instrumento de alarme
dessa janela é o canário do §9.5 (`stream.canary.*`), em modo `frozen` ou
`direct`, mais os contadores nativos `stream.canary.native.*` (fonte sem
oráculo Node). Ele **não** substitui os itens 1–7 acima nem decide os degraus
5 % → 50 % → 100 % — a distribuição e a promoção continuam manuais.

### 9.5 Canário do corte nativo (`STREAM_CANARY_PERCENT`/`_MODE`, F4.2/F4.3)

`ROUTES_RUST=stream` tem prioridade sobre `stream-shadow` (`proxy.rs`), então
no corte não existe comparação rodando. O canário é o instrumento mínimo de
alarme/amostragem para essa janela: ele amostra o corte e compara em paralelo,
sem depender de o oráculo Node responder a todas as buscas.

> **F4.4 (histórico):** os dois modos do canário comparavam com o `/stream` do
> Node, que responde 410/503 desde o corte. O código fica como instrumento —
> **não** como gate; ligar `STREAM_CANARY_PERCENT>0` só produz divergência
> falsa. O gate vigente é o corpus congelado (§F4 de
> `docs/migracao-stream-rust.md`).

- **Flags**: `STREAM_CANARY_PERCENT` inteiro `0..100`, default **0 (OFF)**; e
  `STREAM_CANARY_MODE=frozen|direct`, default **`frozen`** (histórico da janela
  §9.4). Só agem quando `ROUTES_RUST` contém o token exato `stream`; com
  proxy ou `stream-shadow` o percentual é ignorado (`/metrics` mostra 0).
- **Seleção determinística**: FNV-1a de 64 bits sobre o **path** da requisição
  (`/<config>/stream/<tipo>/<id>.json`, que já inclui o segmento `encoded`) →
  balde `hash % 100`; amostra se `balde < percentual`. O mesmo path cai sempre
  no mesmo balde (não repete/omite entre requisições); 0 nunca amostra, 100
  amostra todas. Query/corpo não entram no hash.
- **Modo `frozen` (F4.2, default/rollback)**: a resposta do cliente continua
  sendo a do corte; depois dela o gateway dispara em `tokio::spawn` a MESMA
  segunda request congelada da sombra (`X-Adom-Shadow-Id` +
  `X-Adom-Shadow-Frozen: 1`) ao Node 7100, espera o caso em
  `STREAM_FROZEN_SHADOW_BASE/<id>` e roda
  `frozen_gate::run_case_with_expected`, comparando só `streams`. Exige
  `STREAM_FROZEN_MODE=shadow` + `STREAM_FROZEN_SHADOW_BASE` no Node e
  `INTERNAL_SEARCH_URL` + `JACKETT_TEST_TOKEN` no gateway (hidratação de
  `config.json`). Sem base congelada o boot avisa e as amostras são puladas.
- **Modo `direct` (F4.3, sem `FrozenCase`)**: depois da resposta, o gateway faz
  uma segunda request ao Node com o MESMO path/headers e **só**
  `X-Adom-Shadow-Frozen: 1` (sem `X-Adom-Shadow-Id` → o Node não grava corpus).
  O Node roda o pipeline fresco (sem SWR/fast-path/índice/prefetch) e devolve a
  lista; o gateway compara o **corpo real do corte** com esse corpo por
  identidade (§9.3). Não há captura em disco, `FrozenCase`, replay nem
  hidratação de `config.json`: o canário direto sobrevive à aposentadoria da
  instrumentação congelada e não precisa de `STREAM_FROZEN_*`. Um Node antigo
  com a sombra congelada ligada também responde fresco (o header já existia);
  sem ela, o Node responde a produção normal — o alarme continua, com mais
  ruído de SWR. Custo: uma busca fresca por amostra (~`percent`% do tráfego).
- **Aviso/vazio**: se o **Node** devolve aviso/coleta vazia (§9.4 item 6), a
  amostra é `skipped` (não é comparável). Se o **corte** devolve aviso e o Node
  tinha lista, isso é divergência de verdade — o corte esvaziou.
- **Contadores nativos**: com `percent > 0` (qualquer modo), toda resposta do
  corte alimenta `stream.canary.native.*` sem chamar o Node: `cut` (respostas),
  `streams` (soma), `empty` (lista vazia), `notice` (aviso/coleta vazia) e
  `invalid` (JSON inesperado). É a fonte de alarme que não depende do oráculo;
  a razão `empty/cut` é o indicador de "o corte esvaziou" quando não há Node.
- **Métricas em `/metrics`**:

| Nome | Semântica |
|---|---|
| `stream.canary.percent` | gauge com o percentual efetivo (0..100) |
| `stream.canary.direct` | gauge 1 = modo direto, 0 = congelado |
| `stream.canary.sampled` | buscas encaminhadas à segunda request |
| `stream.canary.compared` | comparações concluídas (denominador) |
| `stream.canary.divergence` | 1 por busca divergente |
| `stream.canary.divergence.items` | soma dos itens divergentes |
| `stream.canary.timeout` | replay/segunda request estourou o prazo |
| `stream.canary.error` | falha de captura/config/replay/rede (nunca divergência) |
| `stream.canary.skipped` | aviso/coleta vazia do Node, não comparável (§9.4 item 6) |
| `stream.canary.native.cut` | respostas do corte observadas (fonte sem Node) |
| `stream.canary.native.streams` | soma de streams devolvidos pelo corte |
| `stream.canary.native.empty` | respostas do corte com `streams` vazio |
| `stream.canary.native.notice` | respostas do corte com aviso/coleta vazia |
| `stream.canary.native.invalid` | corpo do corte que não é JSON de `/stream` |

- **Alarme**: `stream.canary.divergence`/`.items` > 0 na janela é o sinal de
  regressão do caminho nativo; `compared` é o denominador e `timeout`/`error`
  não contam como divergência. A linha de log sai com prefixo `[canary]` e o
  mesmo diff do replay da sombra. No modo direto o diff de identidade é o
  mesmo (§9.3), mas nasce do corpo que o cliente recebeu. O snapshot do
  canário **não** semeia `stream.shadow.*`: o `/metrics` mescla os dois e a
  sobrescrita com zero cegava a janela da sombra.
- **O que ele NÃO cobre**:
  1. **Rollout**: não é divisão de tráfego nem promove a rota. Os degraus
     5 % → 50 % → 100 % do §9.4 continuam manuais (e o rollback é voltar o
     percentual/rota, não o canário).
  2. **Critério §9.4**: não substitui cobertura ≥ 500 buscas/≥ 72 h,
     distribuição mínima, corpus congelado e revisor humano. A amostra é
     determinística por path — a 5 % ela pode omitir uma classe inteira
     (série, configs com/sem `dk`) até o balde cair; não prova distribuição.
  3. **Campos fora do diff e SWR**: `cacheMaxAge`/`stale*` ficam fora (como na
     sombra). No modo `direct` o Node é forçado fresco; se o corte serviu SWR,
     a diferença de geração da lista aparece como divergência. É alarme de
     regressão, não prova de zero divergência do §9.4.
  4. **Play/debrid**: não cobre `/resolve`, resolução de link nem o oráculo
     Node para tudo — só o pipeline de `/stream`.
  5. **Persistência**: `stream.canary.*` é RAM e zera no restart; não há janela
     persistida. O custo da segunda request é real e cresce com o percentual
     (100 % ≈ uma busca fresca por busca do corte).

**Rollback (histórico)**: `STREAM_CANARY_PERCENT=0` (default da época) ou
`STREAM_CANARY_MODE=frozen` + base congelada (o caminho F4.2 existia no
binário). A rota e a sombra `stream-shadow` não mudavam.

---

## 10. Estado do caminho nativo e pendências

O corte é o **padrão fixo** desde o R8 (§0.1): `GATEWAY=on` +
`ROUTES_RUST=stream` no `docker-compose.yml` e o `entrypoint.sh` sempre inicia o
gateway (7000, Node na 7100). Rollback de qualquer fatia é **commit/imagem
anterior**, não env. "Feito" abaixo significa no caminho nativo — não é aceite
de paridade BR+cotas, que é dos gates (§0.6).

| # | Item | Estado |
|---|---|---|
| 1 | fatia debrid do `defaults()` do operador no decode | **feito** no gateway (`operator_debrid_defaults_from_env`, `dd9330c4`); selo `dk` / `secret-box` segue no Node no decode completo da URL |
| 2 | opções na chave (incl. `resolveUncached`) | **feito** no orquestrador (`OrchestratorConfig`) |
| 3 | SWR + graça + coalescing | **feito** (`SwrStore` / `STREAMS_DB` no nativo); o store em memória da sombra saiu no R1 |
| 4 | metadados Cinemeta/TMDB (+ multiobra / data doméstica) | **nativo como fonte primária** (R6); o Node é **fallback vivo** por `POST /internal/search/meta` — a taxa de fallback ainda não foi medida |
| 5 | plano / orçamentos de coleta | decisões no núcleo; a janela roda no nativo (R5) |
| 6 | coleta Jackett/Prowlarr/Torrentio/BLUDV/Mico/… + `raw:v1` | **feito e incondicional** (R5): as cinco fontes e o inventário da conta no Rust; `SOURCES_RUST`, `NodeCollector` e `/internal/search/collect` não existem; sem fonte nativa montada o gateway não sobe |
| 7 | pipeline de build (filtro, ranking, cotas, aviso) | **feito** no orquestrador/núcleo; régua no corpus congelado (`parity:frozen` 16/16) e no e2e (`stream_e2e_parity` 51/51) |
| 8 | debrid (`applyDebrid`, ⚡, HMAC na URL) | **feito** com adaptadores + checagem nativa (R3); `INTERNAL_CHECK_URL` serve só ao feed de holds; autofetch/efeitos de cauda seguem no Node |
| 9 | assinatura `/resolve` no servidor | **feito**: guarda HMAC + play nativo por debrid, incondicionais; o handler Node e o proxy saíram e o rollback é commit/imagem anterior |
| 10 | host/origin e `prefix()` no egresso | **feito** no caminho nativo |
| 11 | `partial`/deadline + busca em fundo | **feito** no orquestrador |
| 12 | `cacheMaxAge` / `stale*` / `Cache-Control` | parcial — ver tipo `StreamResponse` e handler nativo |
| 13 | mapeamento de erro → status (incl. `/resolve`) | parcial no gateway; o play do `/resolve` é nativo desde a fase C (linha 9) |
| 14 | métricas e `stream-trace` | sombra/canário saíram no R1; o alarme do nativo é a própria lista/HTTP e a métrica `index.rust.source_missing`; painel/`stream-trace` rodam no Node, que lê o store nativo pela API admin (`STREAM_STORE_ADMIN_*`, F4.4a) |
| 15 | `staleRevalidate`/`staleError` no tipo | ainda estreito no contrato do crate |
| 16 | `/internal/search/*` | **meta** e **effects** da busca, **debrid/holds** e as rotas do sidecar (`crawl-result`, `activity`); `state/config/collect/index/index-write/fallback` e `/internal/debrid/check` **não existem**; a fachada recusa `/internal/*` antes do proxy |

O `docker-compose.gateway.yml` é só o **override de diagnóstico** que publica o
Node em `127.0.0.1:7100`; não muda rota nem flag. `ROUTES_RUST=` (vazio) e
`ROUTES_RUST=health` são diagnóstico do proxy, não modo de busca; neles o
`/stream` do Node responde 503.

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
   mais comum e o teste byte a byte cobre P2P, debrid e aviso; a comparação da
   sombra (histórica) mascarava a ordem.
4. **`request_cache_key`**: não existe `request_key` em `adom-core`; o nome do
   crate é um apelido de `streams_cache_key` (§7.2).
5. **`/stream` com `:extra`**: rejeitado por `parse_stream_path`; o Node ignora
   o segmento para o handler mas o usa na URL. Implementar quando a fatia do
   `extra` chegar.
