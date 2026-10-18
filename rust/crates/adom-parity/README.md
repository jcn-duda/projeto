# `adom-parity` — harness de paridade do corpus `stream-e2e`

Crate Rust que lê o corpus medido em `rust/golden/stream-e2e`, normaliza a
resposta do `/stream` e compara Node × Rust com diff legível. É a base do
critério de zero divergência do §9 de
[`docs/rust-stream-contract.md`](../../../docs/rust-stream-contract.md).

Não depende de `adom-search`: enquanto o orquestrador não expõe API estável, a
fonte Rust entra pela trait `StreamSource` (ou por uma closure). O ponto exato
de costura está no TODO de [`src/runner.rs`](src/runner.rs).

## O corpus real (inspecionado, não presumido)

Captura de `2026-10-18T01:58:21.378Z`, Node `v22.23.2`, manifest
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

## Uso

```bash
cd rust
cargo run -p adom-parity -- --dump          # valida o corpus e imprime o retrato
cargo run -p adom-parity -- --dump --json   # mesma coisa em JSON
cargo run -p adom-parity -- --replay       # corpus contra ele mesmo
cargo run -p adom-parity -- --replay --base http://127.0.0.1:7000 \
  --config-segment "$SEGMENTO"             # quando a fonte real entrar
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
CARGO_TARGET_DIR="$TEMP/adom-parity-target" cargo test -p adom-parity
```

- `tests/corpus.rs`: os 51 casos carregam, sha256 confere, stats batem, nenhum
  arquivo por etapa, e casos parciais/temperados não entram em panic.
- `tests/normalize.rs`: idempotência, insensibilidade a ordem, sensibilidade a
  campos, máscaras e corpo parcial.
- `tests/runner.rs`: replay 51/51, divergência fabricada, `body_raw` pulado,
  binário `--dump` e `--replay`.
