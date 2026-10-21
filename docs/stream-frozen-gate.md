# Gate de paridade congelada do `/stream` (Fase 1)

> **F4.4/R1:** o lado Node do gate (a 1ª metade do par) foi aposentado com o
> `/stream` do Node (410/503) e o harness de runtime (`STREAM_FROZEN_MODE`,
> `STREAM_CANARY_*`, `scripts/stream-parity.mjs`) foi **removido no R1**. O
> corpus congelado **continua sendo o gate**, rodado pelo Rust
> (`npm run parity:frozen` → `stream_frozen_parity`, 16/16) e pelos testes de
> lista (`stream_e2e_parity`, 51/51); capturar casos novos exige uma imagem
> anterior ao F4.4. O texto abaixo descreve o desenho da Fase 1 e fica como
> registro histórico, não como runtime.

Este documento define a **camada A** do gate da Fase 1: uma captura determinística
por caso, consumida pelo Node e pelo orquestrador Rust com as **mesmas entradas**.
A camada B (ao vivo, `scripts/stream-parity.mjs`) foi **removida no R1**; o gate
vigente é só o corpus congelado.

O objetivo é separar duas coisas que hoje se misturam no `stream-parity`:
**divergência de pipeline** (filtro, ranking, cotas, debrid, apresentação) e
**ruído de coleta** (Jackett/Flare/banco lidos em instantes diferentes).

## Regra de ouro

Nenhum lado pode tocar a rede nem o SQLite de produção durante o replay. O Node
reproduz o pipeline a partir dos arquivos; o Rust recebe os mesmos arquivos pelas
rotas internas (`FrozenRoutes`). O que sobrar de diferença é divergência de
pipeline.

## Formato

```
rust/golden/stream-frozen/<case>/
  request.json                 # caso, tipo, id, prazo, sha256 do encoded
  inputs/meta.json             # resposta de POST /internal/search/meta
  inputs/index.json            # resposta de POST /internal/search/index
  inputs/collect.json          # { responses: [ { key, response } ] }
  inputs/fallback.json         # resposta de POST /internal/search/fallback
  inputs/debrid.json           # { results: { hash: {cached,known,unusable?} }, calls: [...] }
  inputs/apply-debrid.json     # { entries: [ { key, signals, output } ] }  (só o Node replay)
  inputs/instant.json          # conjunto `instant` REAL do sort (magnetdb/inventário/knownInstant)
  inputs/files.json            # opcional: arquivos do debrid por hash (💾 exato de pack)
  inputs/config.json           # números do operador + opções decodificadas (sem segredo)
  expected/node-response.json  # envelope final do Node (mascarado)
  manifest.json                # sha256 de cada arquivo + lacunas declaradas
```

`case` é o `id` de `scripts/golden/casos-stream-e2e.json` (ex.:
`movie-cidade-de-deus`).

### `request.json`

```json
{
  "format": "adom-stream-frozen-request/1",
  "case": "movie-cidade-de-deus",
  "type": "movie",
  "stream_id": "tt0317248",
  "encoded_sha256": "<sha256 do segmento>",
  "encoded_len": 3,
  "deadline_ms": 60000,
  "captured_at": "2026-10-20T...",
  "node_version": "v22.23.3",
  "mode": "record"
}
```

O segmento de config **nunca** é gravado (pode conter a chave de debrid em
base64url reversível). No replay, o operador passa o mesmo segmento por
`--encoded`/`STREAM_FROZEN_ENCODED`.

### `collect.json`

O Node faz mais de uma coleta por busca (principal, pack, varredura pt-BR). Cada
chamada vira uma entrada:

```json
{
  "key": { "imdb": "tt0317248", "type": "movie", "season": null, "episode": null,
           "scope": "all", "query": "City of God 2004", "pt_query": "Cidade de Deus 2002" },
  "response": { "items": [], "partial": false, "sweepInline": false,
                "live": { "failed": [], "pending": [], "empty": [], "served": [], "all": "ok" } }
}
```

O replay casa pela `key` exata; se não houver, cai para `(imdb, scope)`; se ainda
não houver, devolve lote vazio. O lote vazio é **declarado** no relatório — nunca
confundido com "a fonte respondeu vazio".

### `debrid.json`

```json
{
  "service": "alldebrid",
  "results": { "<hash>": { "cached": true, "known": true } },
  "calls": [ { "hashes": ["..."], "file_hashes": [], "known": true, "unusable": null } ]
}
```

`known:false` continua significando "ninguém perguntou" — não vira "nada em
cache". `unusable` (auth/quota) é preservado: a lista volta P2P.

### `apply-debrid.json`

Só o Node replay consome. Guarda a saída de `applyDebrid` **e** os sinais de
`onCacheResult` (`known`, `needsFullRefresh`, `autofetchCount`, `trustDropped`),
porque é deles que saem `debridKnown`/`cacheMaxAge`.

## Determinismo

A captura roda com:

> **Histórico:** as envs e o fluxo abaixo descrevem o harness da Fase 1,
> removido no R1. Nenhuma delas é knob vigente.

| Env | Valor | Por quê |
|---|---|---|
| `RELEASE_INDEX` | `false` | tira a via do índice; o piloto mede collect → build → debrid |
| `MAGNET_BANK` | `false` | tira instantânea e reserva 📦; o piloto não depende do banco vivo |
| `CACHE_DB_PATH` | arquivo temporário (`<tmp>/cache.db`) | nenhum SWR de execução anterior |
| `APP_REPLY_DEADLINE_MS` | `60000` (ou `STREAM_FROZEN_DEADLINE_MS`) | o lote completa; o corte de 10 s/15 s é medido na camada B |
| `STREAM_FROZEN_MODE` | `record` / `replay` | liga o gravador/reprodutor |
| `STREAM_FROZEN_DIR` | diretório do caso | onde os arquivos vivem |
| `STREAM_FROZEN_DEADLINE_MS` | `180000` nos casos lentos | BR/Flare levam 20 s por indexer; 60 s saía `partial` |

`cacheMaxAge` e os avisos continuam sendo contrato; só relógio, host, `sig`,
segmento de config, ordem da lista e ordem de chaves ficam fora do diff (§9.3 do
`rust-stream-contract.md`).

## Fluxo

1. **Gravar** (Node real, com as envs acima):
   `POST /internal/search/config` → `inputs/config.json`; a requisição
   `/stream` grava `meta`, `collect`, `index`, `fallback`, `debrid`,
   `instant`, `apply-debrid` e `expected/node-response.json`. O record desliga
   o **fast-path da conta** (senão o lote sai `partial` antes dos indexers) e
   `files.json` só existe quando o debrid leu a lista de arquivos.
2. **Replay Node**: mesma env, `STREAM_FROZEN_MODE=replay`; a resposta é
   comparada com `expected/node-response.json`. Divergência aqui significa que a
   captura está incompleta (não é bug do Rust).
3. **Replay Rust**: `cargo test -p adom-search --test stream_frozen_parity`
   monta o `Orchestrator` com `FrozenRoutes`/`FrozenDebridFactory` e compara
   com o mesmo `expected/node-response.json`.

## Comando

```bash
cargo test -p adom-search --test stream_frozen_parity -- --nocapture
# equivalemte: npm run parity:frozen
```

O alvo **não** é `#[ignore]`: enquanto houver divergência o comando fica
vermelho, de propósito. Um gate verde com zero casos não prova nada; o
`#[ignore]` foi removido e o status abaixo é o medido.

## Estado medido (2026-10-20, 16 casos)

**Node replay: 16/16.** **Rust: 16/16** (`cargo test -p adom-search --test
stream_frozen_parity`: 1 passed, 0 failed; 3 execuções consecutivas verdes).
Nenhum caso aberto nesta camada.

Os 16: Cidade de Deus, Tropa de Elite, Central do Brasil, Auto da Compadecida,
Carandiru, Bacurau, Inception, Interstellar, Parasite, Harry Potter 1, Kung Fu
Panda 4, Matrix, GOT S08E03, 3% S01E01, Breaking Bad S01E01 e Naruto S01E01.

## Sombra congelada (Fase 2)

A sombra live antiga comparava a lista **pré-debrid** do Rust (`NoDebridFactory`)
com a resposta **pós-debrid** do Node; o contador dava 100 % de divergência por
escopo, não por pipeline. A sombra congelada mede o mesmo caso dos dois lados:

1. O gateway manda a request normal do cliente **sem** header de captura.
2. Depois da resposta, dispara uma segunda request ao Node 7100 com o mesmo
   path/UA/`encoded` + `X-Adom-Shadow-Id` e `X-Adom-Shadow-Frozen: 1`.
3. O Node roda essa segunda em `behaviorFrozen` (sem SWR/fast-path), grava
   `inputs/{meta,index,collect,fallback,debrid,apply-debrid,instant}` e
   `expected/node-response.json` em `<base>/<id>/`; o `frozenDir` viaja no
   `AsyncLocalStorage` (uma request não contamina a outra). O `config.json` é
   hidratado pelo gateway via `POST /internal/search/config`.
4. O gateway roda `FrozenRoutes`/`FrozenDebridFactory` com o mesmo caso
   (`run_case_with_expected`) e compara **só `streams`** com a resposta frozen
   do Node (`cacheMaxAge`/`stale*` do modo normal ficam fora).
5. `compared` conta a comparação; `divergence`/`items` só quando o conjunto de
   identidades difere; caso sem `collect`/`meta` (ou segunda request falhou) é
   `skipped`, nunca divergência.

A request normal do cliente continua igual (SWR e fast-path intactos); a
segunda request é o custo da sombra. O caminho antigo
(`build_shadow_orchestrator`) fica como fallback quando a captura não existe.

**Recorte pré-debrid (2026-10-20, 512 da imagem `42b9c3e5`).** O replay usa a
chave `service|cachedOnly|hash1,hash2,...` do `apply-debrid.json` como a lista
de candidatos que o Node passou ao debrid. É a única captura dessa fronteira:
`releaseIndex.fileEvidence`/`provenAudio` não entram no corpus, e sem o recorte
o replay re-derivava filtros e/ou mantinha item que o Node já tinha descartado
(94 buscas: 3 filmes, extras TorrentDos/Apache BR, ausentes TPB/Lime/AllDebrid).
A prova de áudio vem **só da primeira entrada** (a passada da resposta), nunca
da tardia — o `apply-debrid.json` também guarda a passada de fundo e ela podia
rotular DUAL um item que o corpo do cliente não tinha. A máscara segue a ordem
do Node (`stream-frozen-store.maskString`): `sig` → `encoded` → `origin`.

**Últimos 10 (512).** Três correções de replay, todas só no harness:
`apply-debrid` fechado como P2P vence o memo `cached:true` do `debrid.json`
(4 casos de quota) e `P2p` não vira `/resolve`; o título/tamanho de pack vem do
`apply-debrid` quando o replay ficaria na média (5 Breaking Bad, `💾 751.32 MB`
em vez de `639.27`), sem tocar nos 40 packs em que o Node não emite `📦`; e, se a
ordem divergir, o harness tenta a leitura sem `instant.json` e só aceita se o
corpo inteiro bater — `instant.json` é a última escrita do record e o HP1 usava
o conjunto da 1ª resposta. Resultado: os 10/10 fecham; 16/16 do gate e 51/51 do
e2e seguem verdes.


- `DEFAULT_TRACKERS` em `list_builder/helpers.rs`: o Node não copia `tr=` do
  magnet; todo P2P sai com a lista fixa e `sources` (antes vinha sem).
- `behaviorHints.bingeGroup` (`powerm-<qualidade>-<fonte>`) em `map_stream`.
- `instantHashes` (inventário da conta) no `BuildOptions`/`sort`: sem ele o
  desempate cai em seeders e troca itens do mesmo balde (Cidade de Deus 720p).
- Sentinela de tamanho (`1 KB`/`500 GB`) descartado em `raw_item.rs`
  (`known_size`), como `UNKNOWN_SIZE_MAX` do Node; antes aparecia `💾 1.00 KB`
  nos itens Apache.
- `sig` idempotente e `{{base}}`/`{{config}}` normalizados no diff.
- `FrozenCase` monta o `MetaResponse` com IMDb **base** + temporada/episódio
  (antes `tt…:1:1` vazava na dica `w` de toda série).
- `episode_counts` aceita o mapa `meta.episodes` do Node (além de `videos`):
  sem isso o `💾` médio de pack nunca era calculado no Rust.
- `inputs/instant.json`: o conjunto `instant` REAL do sort (alive do magnetdb +
  inventário + knownInstant), capturado no build do Node. Derivar só dos
  `fromAccount` super-aplicava (Carandiru) e não cobria alive fora da conta
  (Naruto/GOT).
- `map_stream` preenche `tracker`/`magnet_dn`/`indexer` normalizado: o
  `dedupe_by_hash`/`relabel_merged` lê os dois e o `name` perdia o chip do
  tracker quando o vencedor era trocado.
- `FrozenRoutes` não remove mais `indexOnly` do recorte priority/nonpriority:
  a ordem bruta do lote `all` é a que o Node usou no dedupe (Auto da
  Compadecida).
- `multi_work` genérico (`is_multi_work_collection(title) || admitted`) em
  `RankingStream`/`BuiltStream`: o `p:1` do `/resolve` usa `workHint &&
  _multiWork`, não a admissão (Matrix - Trilogia).
- `drop_pack_text_totals` depois da anotação no `list_builder` (mesma ordem do
  napi/TS): remove o `💾`/`size` do total de pack silencioso/faixa e guarda
  `_packBytes` (Naruto Complete, Breaking Bad S01E01-07). Packs anotados com
  `📦` ficam intactos.

## Lacunas declaradas (nesta fatia)

- Índice e banco vivo ficam desligados no piloto; entram na Fase 2, com
  `inputs/index.json`/`fallback.json` preenchidos.
- A ordem da lista e o relógio não são comparados (§9.3).
- HMAC: `sig` é mascarado; o replay Rust usa um segredo vazio. A assinatura é
  validada separadamente no `/resolve`.
- O `encoded` não é versionado; sem ele o replay usa `e30` (sem chave na URL).

## Limpeza

A instrumentação Node (`src/utils/stream-frozen.ts` e as fachadas
`collect-orchestrator-frozen.ts`/`debrid-check-frozen.ts`) **sai na F4**, junto
com o orquestrador TS. Enquanto o Node for o oráculo, ela é o que prova que a
captura contém tudo que o pipeline leu.

Desde o F4.3 o **runtime não depende mais dela para o alarme**:

- o comportamento "fresco" (sem SWR/fast-path/índice/prefetch) mora em
  `src/utils/stream-fresh.ts`; o header `X-Adom-Shadow-Frozen: 1` vale mesmo
  sem `STREAM_FROZEN_MODE` (`STREAM_FRESH_REQUESTS=off` restaura o acoplamento);
- o canário do corte tem `STREAM_CANARY_MODE=direct`: compara o corpo real do
  corte com o Node fresco, sem `FrozenCase`/captura/config;
- a sombra tem `STREAM_SHADOW_MODE=direct`: compara o corpo normal do Node com
  a remontagem, sem captura;
- `stream.canary.native.*` dá o alarme sem oráculo Node.

O caminho congelado (`STREAM_CANARY_MODE=frozen`/`STREAM_SHADOW_MODE=frozen`,
default) e o corpus continuam no binário até a janela §9.4 terminar e o
deploy provar o caminho novo; só então a instrumentação e o
`frozen_gate` de runtime saem (os alvos de teste `stream_frozen_parity` e
`stream_e2e_parity` podem continuar usando o corpus).
