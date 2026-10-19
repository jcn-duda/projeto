# `adom-parity` — harness de paridade do corpus `stream-e2e`

Crate Rust que lê o corpus medido em `rust/golden/stream-e2e`, normaliza a
resposta do `/stream` e compara Node × Rust com diff legível. É a base do
critério de zero divergência do §9 de
[`docs/rust-stream-contract.md`](../../../docs/rust-stream-contract.md).

## Como pluga (`StreamSource` → orquestrador)

A trait `StreamSource` (`src/runner.rs`) é a fronteira do runner. A implementação
sobre o orquestrador está em `src/orchestrator_source.rs`:

| Tipo | Uso |
|---|---|
| `ReplaySource` | `--replay`: corpus × ele mesmo (normalizador) |
| `OrchestratorSource` | stubs injetados (`CaseFixtures`) — testes / um caso |
| `FixtureOrchestratorSource` | por caso: lê `meta.json` + `raw.json` (+ `debrid.json`) no dir do caso; **sem esses arquivos → `Skip` honesto** |

Fluxo da remontagem:

1. troca `{{config}}` no path por `e30` (ou `SourceOptions::config_segment`);
2. `StreamRequest::from_path` + `Orchestrator::handle` (runtime tokio);
3. serializa `StreamResponse` → `Value` e o runner normaliza dos dois lados (§9).

Collector / meta / debrid são stubs (mesma ideia dos testes do `adom-search`).
Não depende de `adom-server`, nem de rede Jackett/debrid reais.

## O corpus real (inspecionado, não presumido)

Captura de `2026-10-19T01:11:18.652Z`, Node `v22.23.2`, manifest
`adom-stream-e2e/1`, 51 casos versionados em `cases/<id>/`.

| Item | Valor medido |
|---|---|
| Casos | **51** (27 `movie`, 24 `series`) |
| Arquivos por caso | **`request.json` + `response.json`** |
| Trace/meta/raw/debrid por etapa | **nenhum** (0 arquivos) |
| `body_raw` (resposta não-JSON) | 0 (todos os 51 têm `body` JSON) |
| Status | 200 nos 51; `cacheMaxAge` = 0 nos 51 |
| Streams no total | **271** (máximo 11 em um caso) |
| Listas vazias | 9 |
| Aviso de lista vazia (1 item só com `externalUrl`) | 10 |
| Casos com item P2P (`infoHash` + `sources`) | 4 |
| Casos com item debrid (`url` `/resolve/…`) | 28 |
| Itens com `infoHash` / `url` / `size` / `behaviorHints` / `sources` | 23 / 238 / 220 / 261 / 23 |

`request.json`: `method`, `path` (sempre `/{{config}}/stream/<type>/<id>.json`),
`headers` (`user-agent: adom-stream-e2e/1`) e `user_config_sha256`.

`response.json`: envelope `{status, headers, cacheMaxAge, body}`; headers só
`content-type` e `cache-control`; `body` é `{streams, cacheMaxAge}`.

Campos de stream observados: `name`, `title`, `infoHash`, `sources`, `url`,
`externalUrl`, `size`, `behaviorHints.bingeGroup` (o `--dump` imprime o
conjunto exato). As variantes são exatamente
as do contrato: P2P (`infoHash` + `sources`), debrid (`url` + `size`), aviso
(`name` + `externalUrl`) e o caso sem `size` (um item de One Piece).

As lacunas declaradas no manifest (`notCaptured`) continuam valendo: o corpus
não mede meta/raw/debrid, HMAC, relógio nem estado do acervo. O harness é
**aditivo**: se o gerador passar a gravar `trace.json`/`meta.json`, o leitor já
confere o sha256 de todo arquivo listado em `files` e o `--dump` mostra os
arquivos por etapa.

### Quantos casos comparam de verdade (remontagem Rust)

| Modo | Comparados | Notas |
|---|---|---|
| `--replay` / `ReplaySource` | **51/51** | forma do Node × si (não é paridade de pipeline) |
| `FixtureOrchestratorSource` no corpus atual | **0/51** | todos `Skip` — sem `meta.json`/`raw.json` |
| Teste com stubs / dir temporário com fixtures | **1** (sintético) | prova a costura + máscaras §9 |

## O que ainda falta (Fase A → paridade plena)

1. **Captura de entradas internas** no gerador do corpus: por caso,
   `meta.json` (obra/queries), `raw.json` (lote pré-build) e idealmente
   `debrid.json` (hashes ⚡ / unusable). As rotas internas já existem no HEAD
   (`/internal/search/*` e `/internal/debrid/check`), mas o corpus atual **não**
   tem nenhuma dessas fixtures: `FixtureOrchestratorSource` remonta **0/51** e o
   replay 51/51 não é paridade de pipeline.
2. **Segredo HMAC / config real** alinhados ao Node da captura (`RESOLVE_SECRET`
   ou chave de debrid da sessão) — hoje o stub usa `chave-teste`; `sig` já é
   mascarado no diff, mas divergência de dica `w=` ainda conta.
3. **Opções do usuário** do segmento capturado (não só `e30` = `{}`): o path do
   corpus mascara `{{config}}`; falta gravar o segmento concreto ou um
   `options.json` para a chave SWR / rótulos baterem.
4. **`--replay --orchestrator`** (ou flag equivalente) no binário: hoje
   `--replay` só usa `ReplaySource`; a remontagem fixture é exercida nos testes.
5. **Fontes reais** (Jackett / rotas `/internal/search/*`): os coletores
   nativos opt-in existem em `adom-search` (`SOURCES_RUST`), mas este crate não
   os liga no runner e não toca `adom-server` / `adom-debrid`.
6. **SWR / acervo / passe tardio** no golden: o corpus é uma foto da 1ª
   resposta; estado de cache e fila tardia ficam fora até o gerador os medir.
7. **Gate operacional** (`scripts/stream-parity.mjs`, fora deste crate): 16
   casos do corpus, gate exato de hashes+BR e p50/p95 Stremio/Dart; ainda **não**
   rodou contra o corte nativo real (container sem `GATEWAY`/`ROUTES_RUST` e
   atrás do HEAD).

## Uso

```bash
cd rust
cargo run -p adom-parity -- --dump          # valida o corpus e imprime o retrato
cargo run -p adom-parity -- --dump --json   # mesma coisa em JSON
cargo run -p adom-parity -- --replay       # corpus contra ele mesmo
cargo run -p adom-parity -- --replay --base http://127.0.0.1:7000 \
  --config-segment "$SEGMENTO"             # máscaras §9 no replay
```

`--dump` sai com código 1 se houver erro de integridade/contrato; `--strict`
também reprova aviso. `--replay` é o teste de fumaça do normalizador: 51/51
iguais e zero divergência.

## O que o normalizador cobre

- **Ordem**: streams ordenados por `infoHash`, `url`, `title`, `externalUrl`
  (JSON canônico desempata); chaves de objeto ordenadas recursivamente.
- **Máscaras**: origem/host de `url`/`externalUrl` → `{{base}}`; `sig=<valor>` →
  `sig={{sig}}`; segmento de config injetado → `{{config}}`.
- **Voláteis**: `trace`, `metrics`, `timings`, `elapsedMs`, `capturedAt`,
  `timestamp`, `date`/`etag`/`age` etc. fora; campos `_*` fora.
- **`cacheMaxAge`**: comparado por default (é contrato); `--ignore-cache-max-age`
  mascara quando o TTL for deliberadamente diferente.
- **`sources`**: preservado (é dado público do torrent; a origem do tracker não
  vira `{{base}}`).
- **Idempotência**: normalizar a saída normalizada devolve o mesmo resultado.

## Diff

Compara por identidade (`infoHash` → `/resolve/<hash>` → URL → `externalUrl` →
título), então um item ausente não gera cascata nos seguintes. Cada linha traz
campo + índice + esperado × obtido, por exemplo:

```
streams[0].title: esperado="A" obtido="A mudou"
streams.length: esperado=2 obtido=1
```

## Testes

```bash
cd rust
cargo test -p adom-parity
```

- `tests/corpus.rs`: os 51 casos carregam, sha256 confere, stats batem, nenhum
  arquivo por etapa, e casos parciais/temperados não entram em panic.
- `tests/normalize.rs`: idempotência, insensibilidade a ordem, sensibilidade a
  campos, máscaras e corpo parcial.
- `tests/runner.rs`: replay 51/51, divergência fabricada, `body_raw` pulado,
  binário `--dump` e `--replay`.
- `tests/orchestrator_source.rs`: remontagem com stubs (§9), corpus sem
  fixtures → 51 skips, dir temporário com `meta`/`raw`/`debrid` → Match.
