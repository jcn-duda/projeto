# `stream-e2e` — corpus de ponta a ponta do `/stream`

Corpus **medido**, não inventado: cada caso é uma requisição REAL ao addon
rodando, e a pasta só é preenchida pela ferramenta
[`scripts/golden/capture-stream-e2e.mjs`](../../../scripts/golden/capture-stream-e2e.mjs).
É o material com que o orquestrador Rust é comparado — ver
`docs/rust-stream-contract.md` §9.

O diretório `cases/` traz a captura revisada (`request.json` + `response.json`
por caso, mais `manifest.json` na raiz). Não há caso "de exemplo" inventado —
só o que a ferramenta mediu. Regenerar sobrescreve; revise o diff antes de
commitar.

Estado no HEAD: os 51 casos têm `request.json` + `response.json`; o **piloto**
(`cases/movie-cidade-de-deus`) também tem `inputs/` e remonta **verde** pelo
`frozen_gate` (`cargo test -p adom-search --test stream_e2e_parity piloto`).
O batch dos 51 ainda **não** rodou: o teste `build_stream_list_parity_completa`
segue `#[ignore]` e, quando rodar, exige `inputs/` em todos os casos.

### Consumidor Rust (Fase A.5)

Harness em `rust/crates/adom-search/tests/stream_e2e_parity.rs`:

```bash
cd rust && cargo test -p adom-search --test stream_e2e_parity
```

Hoje o corpus traz `inputs/` só no piloto. Casos **com** `inputs/` remontam pelo
`frozen_gate` (`run_case_with_expected`): o `response.json` é envelope, o teste
extrai `body` e compara `streams`; o `request.json` mascarado (`{{config}}`) usa
`e30` no replay. O que roda em todos: carga + sha256 do manifest,
`parse_stream_path` contra `type`+`stream_id` e o `round-trip` do `contract`
(`StreamResponse`). Relógio e ordem da lista/chaves ficam fora do assert.

## Como gerar

Pré-requisitos: addon no ar (local: `npm run docker:up`, porta 7000; outra
instância: a porta correspondente, ex. 7100) e um segmento de config de usuário
**real** (o mesmo da install URL; sem ele a captura roda sem config e não
exercita debrid).

```bash
node scripts/golden/capture-stream-e2e.mjs --dry-run \
  --cases scripts/golden/casos.example.json

node scripts/golden/capture-stream-e2e.mjs \
  --base http://127.0.0.1:7000 \
  --token "$JACKETT_TEST_TOKEN" \
  --user-config "$SEGMENTO_BASE64URL" \
  --cases scripts/golden/casos.example.json
```

Captura com as entradas internas (o `/stream` continua sendo a resposta normal;
as rotas internas falam com o MESMO processo em loopback):

```bash
# dentro da rede do container, para o alvo ser 127.0.0.1:7100 (Node atrás do gateway)
docker exec stremio-adom node /tmp/capture-e2e.mjs \
  --base http://127.0.0.1:7100 --with-internal \
  --shadow-dir /tmp/adom-shadow --user-config e30 \
  --cases /tmp/casos.json --out /tmp/e2e-out --merge
```

- `--with-internal` captura `inputs/{meta,config}.json` por
  `POST /internal/search/meta|config`. **Só funciona contra imagem anterior ao
  corte de 2026-10-31**: no HEAD as duas rotas não existem (o metadado é
  nativo) e a captura recebe 404. Índice, coleta e debrid não têm rota Node
  desde R3/R4/R5 — vêm só do record do shadow ou do corpus congelado.
- `--shadow-dir <base>` faz o `/stream` com `X-Adom-Shadow-Id: <caso>` +
  `X-Adom-Shadow-Frozen: 1` e copia do record do shadow, no MESMO run, o que só
  ele grava: `proven-quality.json`, `apply-debrid.json`, `files.json`,
  `instant.json`, `fallback.json` e as versões exatas de `index.json`/`debrid.json`.
  Sem a qualidade provada o replay classifica item provado como "sem resolução" e
  a cota deixa passar um stream que o Node cortou.
- `--out` e `--merge` permitem recapturar um recorte sem apagar os outros casos;
  cada caso guarda o próprio `capturedAt`.

- `--dry-run` valida o arquivo de casos, imprime o plano e o que NÃO é
  capturado. Não toca a rede nem o disco.
- `--token` é opcional para o `/stream` (a rota é pública); serve para
  instâncias atrás de proxy que exigem o token de diagnóstico. Ele NUNCA é
  gravado.
- `--user-config` é opcional: sem ele o caminho perde o prefixo da config e o
  caso vira P2P/sem debrid.
- `--base` sem path; o script usa `origem + pathname`. Sem rede ele falha com
  mensagem explícita (nunca grava corpus vazio).

O arquivo de casos é seu (`--cases`); o modelo em
[`scripts/golden/casos.example.json`](../../../scripts/golden/casos.example.json)
tem os quatro formatos que interessam: filme, episódio, pack de temporada e
filme BR dublado.

Formato do arquivo de casos:

```json
{
  "format": "adom-stream-e2e-cases/1",
  "cases": [
    { "id": "movie-tt0133093", "type": "movie", "stream_id": "tt0133093", "label": "opcional" }
  ]
}
```

`id` vira nome de diretório: `[a-z0-9][a-z0-9._-]{0,63}`.
`stream_id` é o id do protocolo Stremio: `tt…`, `tt…:temporada` ou
`tt…:temporada:episódio`. `type` é `movie` ou `series`.

## O que é gravado

```
cases/<id>/request.json
cases/<id>/response.json
cases/<id>/inputs/meta.json        (com --with-internal)
cases/<id>/inputs/config.json
cases/<id>/inputs/collect.json
cases/<id>/inputs/index.json
cases/<id>/inputs/debrid.json
cases/<id>/inputs/proven-quality.json  (com --shadow-dir)
cases/<id>/inputs/apply-debrid.json
cases/<id>/inputs/files.json
cases/<id>/inputs/instant.json
cases/<id>/inputs/fallback.json
manifest.json
```

O bloco acima é o formato completo do gerador. `meta.json` e `config.json`
saíram do caminho vivo no corte de 2026-10-31, e `collect.json`/`debrid.json`
saíram antes (R3/R5): num corpus novo só `request`/`response` e o que o
`--shadow-dir` copiar. O corpus commitado não tem nenhum deles.

`request.json`:

```json
{
  "method": "GET",
  "path": "/{{config}}/stream/movie/tt0133093.json",
  "headers": { "user-agent": "adom-stream-e2e/1" },
  "user_config_sha256": "<sha256 do segmento, ou null>"
}
```

`response.json`:

```json
{
  "status": 200,
  "headers": { "content-type": "application/json; charset=utf-8", "cache-control": "max-age=0, public" },
  "cacheMaxAge": 0,
  "body": { "streams": [], "cacheMaxAge": 0 }
}
```

Quando o corpo não é JSON (erro de proxy, HTML), entra `body_raw` (texto) em vez
de `body`. `cacheMaxAge` é copiado do corpo para o diff não precisar descer no
JSON.

`manifest.json` (`format: "adom-stream-e2e/1"`):

- `capturedAt` — a ÚNICA data do corpus (provenance);
- `node` — `process.version` de quem capturou;
- `base` — sempre `{{base}}` (o host real não é versionado);
- `user_config_sha256` — identifica a instalação sem guardar a credencial;
- `cases[]` — por caso: `id`, `type`, `stream_id`, `dir`, `status`,
  `cacheMaxAge` e `files` com o **sha256** de cada arquivo;
- `notCaptured` — a lista de lacunas (abaixo), repetida no manifesto para que
  nenhum consumidor a leia como "cobertura completa".

Os arquivos são escritos em ordem determinística (casos ordenados por `id`) e
sem timestamp: o mesmo addon, com o mesmo `--user-config`, produz o mesmo
`request.json`. `response.json` varia só com o que o addon responder.

## Mascaramento (o corpus é commitado)

| O que | Vira | Por quê |
|---|---|---|
| segmento de config na URL/corpo | `{{config}}` | pode conter a chave de debrid em base64url (reversível) |
| token `X-Indexer-Test-Token` | `{{token}}` | credencial de diagnóstico |
| origem do addon (`--base` ou `PUBLIC_URL` embutido no `/resolve/…`) | `{{base}}` | Host é por instalação e vaza topologia da rede |
| `?sig=` / `&sig=` | `sig={{sig}}` | HMAC depende do segredo do operador |
| headers `Host`, `Date`, `ETag`, `Age` | não gravados | não são contrato e não são determinísticos |

URLs absolutas de terceiros (trackers em `sources`, por exemplo) permanecem: são
dado público do torrent e é o que permite comparar o item P2P. O sha256 do
segmento de config fica registrado para amarrar o caso à instalação sem guardar
o segredo; para reproduzir o replay é preciso passar `--user-config` de novo.

## O que este corpus AINDA NÃO mede (e por quê)

1. **Metadados da obra (Cinemeta/TMDB)** — os 50 casos sem fixture continuam só
   com a lista pronta. A rota que os capturava (`POST /internal/search/meta`) e
   os providers TS saíram no corte de 2026-10-31; `--with-internal` existe só
   para recapturar contra imagem anterior a esse corte.
2. **Itens crus por indexer** (antes de filtro de título, ranking e debrid) e o
   cache `raw:v1` — capturados por `POST /internal/search/collect` com
   `--with-internal` (re-consulta, não o lote exato do `/stream`).
3. **Respostas de cache do debrid** (⚡ por hash, arquivos de pack, tamanhos
   medidos) — `POST /internal/debrid/check` grava `inputs/debrid.json`; com
   `--shadow-dir` vale a versão exata do record (`files.json` incluso).
4. **HMAC e o segmento de config** — mascarados por segurança. O replay exige o
   segredo do operador; o corpus prova a forma da URL, não a assinatura.
5. **Relógio** — `Date`/`ETag`/`age` e a duração da requisição não entram: o
   prazo é medido pela métrica `stream.shadow.divergence`, não pelo arquivo.
6. **Estado do acervo** — banco de magnets e índice de releases no instante da
   captura não são versionados; o mesmo caso pode responder diferente depois de
   uma coleta.
7. **Ordem de chaves e ordem da lista** — preservadas no arquivo, mas a
   comparação de sombra as mascara (o Node não promete ordem estável entre
   variantes de item).

Essas lacunas são a razão de o corpus ser **aditivo**: quando a captura passar a
gravar as fixtures internas, os mesmos casos ganham arquivos novos (`raw.json`,
`debrid.json`) sem reescrever o que já foi medido. `meta.json` não entra nessa
lista: o metadado é nativo e não tem mais rota para capturar.

## Como o orquestrador Rust consome

1. Ler `manifest.json`, conferir `format` e o sha256 de cada arquivo (arquivo
   alterado fora do gerador — o caso é inválido).
2. Para cada caso, reconstruir a requisição a partir de `request.json` e do
   `--user-config` do replay, chamar o caminho nativo `/stream` e comparar com
   `response.json` **mascarando**: origem/host, segmento de config, `sig`,
   relógio, ordem da lista e ordem de chaves.
3. Divergência que sobra depois da máscara é candidata a bug de porte; a
   métrica `stream.shadow.divergence` (§9 do contrato) é o critério de corte por
   rota.
