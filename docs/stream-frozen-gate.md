# Gate de paridade congelada do `/stream` (Fase 1)

Este documento define a **camada A** do gate da Fase 1: uma captura determinística
por caso, consumida pelo Node e pelo orquestrador Rust com as **mesmas entradas**.
A camada B (ao vivo, `scripts/stream-parity.mjs`) continua rodando como tendência
e não bloqueia.

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

**Node replay: 16/16.** **Rust: 13/16.** Os 3 abertos (bloqueiam o corte):

- `movie-matrix`: falta `p:1` no `w` do pack multiobra; o Node admite a
  trilogia pelo marcador de pack, o Rust ainda não.
- `series-anime-naruto-s01e01`: seleção/ranking de pack de anime (conjunto de
  hashes difere; o `instant` capturado não cobre o alive do banco).
- `series-breaking-bad-s01e01`: o item de conta `6a12ce77` (S01E01-07) mantém
  `💾` da stat base no Rust; o Node não pinta o total do pack de faixa.

Os 13 exatos: Cidade de Deus, Tropa de Elite, Central do Brasil, Auto da
Compadecida, Carandiru, Bacurau, Inception, Interstellar, Parasite, Harry
Potter 1, Kung Fu Panda 4, GOT S08E03 e 3% S01E01.

## Correções que o gate já forçou no Rust

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
