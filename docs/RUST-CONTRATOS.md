# RUST-CONTRATOS.md — contratos TS→Rust

Status: **EM CURSO**. Snapshot desta revisão: **`19b9879`** (branch `rust`;
`git describe` = `v1.1.0-103-g19b9879`; **96 commits** à frente de `022ae03`, o
`HEAD` que o §1 citava, e **59** à frente de `d8505b2`, a última revisão deste
arquivo). O crate `adom-core` declara **56 módulos** em `lib.rs` — a contagem é
por `mod` no `lib.rs`, não por arquivo `.rs` (são **63 `.rs`** sob `src/`,
incluindo `lib.rs` e os submódulos como `stream_quotas_extra/selection.rs`) —
cobertos por **54 datasets golden** (`.jsonl`) com **53 manifests**
(`stream-quotas-extra` não tem manifest). Os `.jsonl` somam **6.182 linhas**; a
soma de `corpus.cases` dos 53 manifests é **6.155** (a diferença de 27 é o
`stream-quotas-extra`, sem manifest).

O **HMAC de `/resolve`** agora **tem porte commitado** (`resolve_sign`,
§1/§3): deixou de ser contrato alvo. A ponte `adom-napi` também está commitada
(§3.1). Config, cache, rotas e providers seguem **PENDENTES** como contrato
(§5), embora as fatias **puras** de config e cache já estejam portadas (§3).

Documentação operacional de apoio à migração TS→Rust: descreve contratos **como
o código TS os cumpre hoje**, para servir de alvo de porte. Onde §3 afirma porte,
a afirmação é **de artefato** (módulo + golden + teste no crate), não de adoção:
o runtime continua TypeScript.

## 0. Escopo e método

Fontes lidas (existem no checkout; links relativos):

- [`src/utils/sign.ts`](../src/utils/sign.ts) — `signResolve`/`verifyResolve`
- [`src/providers/debrid-pipeline-core.ts`](../src/providers/debrid-pipeline-core.ts) — produtor da URL/`sig`
- [`src/routes/resolve.ts`](../src/routes/resolve.ts) — consumidor
- [`src/runtime.ts`](../src/runtime.ts) — `opts().debridApiKey`, `prefix()`
- [`src/config/debrid.ts`](../src/config/debrid.ts) — `resolveSecret`

Lado Rust lido nesta revisão:

- [`rust/crates/adom-core/src/lib.rs`](../rust/crates/adom-core/src/lib.rs) —
  **56 módulos** declarados e a API pública do crate
- [`rust/golden/`](../rust/golden/) — **54 `.jsonl` + 53 manifests** na árvore
  (todos commitados no snapshot; `stream-quotas-extra.jsonl` sem manifest)
- [`rust/crates/adom-core/tests/`](../rust/crates/adom-core/tests/) — **56
  arquivos**: 54 testes golden (53 `*_golden.rs` + `golden_corpus.rs`, o piloto
  histórico de `title-normalization`) e `unicode_parity.rs`; `tests/common/mod.rs`
  é suporte
- [`scripts/golden/`](../scripts/golden/) — geradores, corpus, checkers e a
  política de hash de fonte (`source-fingerprint.mjs`)

"Verificado" = lido no fonte nesta revisão. As contagens têm **método e data**
(snapshot `19b9879`, 2026-10-12): módulos por `mod` no `lib.rs`; casos por
`corpus.cases`/`output.lines` do manifest e por linhas do `.jsonl`. Os **gates**
de build (fmt/clippy/test) vêm do baseline executado em revisão de agente e
**não** foram re-executados nesta tarefa (§3, §4). As linhas do §1 são do
`HEAD 022ae03` e podem deslocar; o path é o link estável. Identificadores
(funções, chaves, campos) são preservados. O runtime de produção continua
**TypeScript**; a única ponte ativa é [`src/utils/rust-core.ts`](../src/utils/rust-core.ts),
que instala `normalizeTitle` no [`src/addon.ts`](../src/addon.ts) sob `RUST_CORE`
(default **off**) — nenhuma das demais funções portadas é consumida no runtime.
**Isto é paridade de artefato, não adoção.**

## 1. Contrato HMAC de `/resolve` (VERIFICADO; porte `resolve_sign` commitado)

### 1.1 Payload assinado (exato)

`src/utils/sign.ts:33`:

```
payload = `${infoHash}${ep}${hint ? `&w=${hint}` : ''}`
```

- `infoHash` — 40 hex, **minúsculo** (produtor usa `s.infoHash`; verificador
  baixa para minúsculo antes, `resolve.ts:37`).
- `ep` — fragmento literal; ver §1.2.
- `hint` — JSON cru (string); quando **presente** acrescenta `&w=<json>`; quando
  ausente, **nada** (nem separador).
- Algoritmo: **HMAC-SHA256**, saída **hex minúsculo** (`sign.ts:34`).
- Chave: ver §1.3.

### 1.2 `ep`: filme vazio × S/E com `?` literal

Produtor (`debrid-pipeline-core.ts:250`):

```
const ep = season != null && episode != null ? `?s=${season}&e=${episode}` : '';
```

Verificador (`resolve.ts:42`) reconstrói com a **mesma** regra a partir dos
valores já parseados da query. Filme: `ep === ''`. S/E: `ep` **inclui o `?` à
frente** (`?s=<season>&e=<episode>`) — o `?` é **byte do payload assinado**, não
separador de URL. Montagem da URL (`debrid-pipeline-core.ts:279-280`):
`` `${prefix()}/resolve/${s.infoHash}${ep}${ep ? '&' : '?'}` `` + `w=` opcional +
`sig=`. Produtor emite `s`/`e` canônicos; um `s` não canônico (zeros à esquerda)
divergiria.

### 1.3 Seleção da chave (fallback)

`src/utils/sign.ts:16`:

```
return config.debrid.resolveSecret || opts().debridApiKey || '';
```

1. `config.debrid.resolveSecret` = `process.env.RESOLVE_SECRET || ''`
   (`src/config/debrid.ts:393`) — segredo do operador.
2. `opts().debridApiKey` — chave de debrid efetiva da requisição, no **segmento
   de config da URL** (chave curta `dk`; `src/runtime.ts:69`) ou herdada do ENV
   **só** com `config.debrid.allowEnvKey` (`src/runtime.ts:131`).
3. `''` — sem segredo ativo: `signResolve` devolve `''` e `verifyResolve`
   devolve `false` (rota não assinável, §1.6).

Nenhum valor real de chave é documentado aqui.

### 1.4 `hint` (JSON) — forma e ordem

Campos observados no produtor (`debrid-pipeline-core.ts:261-268`): `n` (nomes),
`y` (ano, pode ser JSON `null` **dentro** do objeto), `p: 1` (pack multiobra),
`d: 1` (promessa de dublado), `i` (IMDb id). São **chaves de um único objeto
JSON** — não há componente separado por campo.

Contrato a preservar:

- **Assinado cru, antes de codificar.** Produtor assina `hintJson` (`:269`,`:273`)
  e só depois aplica `encodeURIComponent` na URL (`:280`). Verificador recebe
  `req.query.w` **já URL-decodificado pelo Express** (`resolve.ts:40`) e assina
  o valor cru.
- **Ordem das chaves importa.** `JSON.stringify` preserva a ordem de inserção e
  o HMAC é sobre a string; o contrato **não** é "canonical JSON com sort" —
  ordenar mudaria a assinatura.
- **Ausência = string vazia, nunca `"null"`.** Sem hint → `hint = ''`; sem S/E →
  `ep = ''`. `y: null` é `null` JSON **dentro** do objeto, não ausência.

### 1.5 API `sign`/`verify` (tipos)

`src/utils/sign.ts`:

- `signResolve(infoHash: string, ep = '', hint = '')` → `string` (hex) ou `''`.
- `verifyResolve(infoHash: string, ep: string, sig: unknown, hint = '')` →
  `boolean`.

Só strings; `hint` é `string`, `sig` entra como `unknown` para ser estreitado.
A serialização do hint é responsabilidade do chamador (§1.4).

### 1.6 `verify` — semântica (sem guard inventado)

`src/utils/sign.ts:38-44`:

1. `expected = signResolve(...)`; se `expected === ''` → `false`.
2. `typeof sig !== 'string'` → `false` (sig ausente em `req.query` é
   `undefined`).
3. `Buffer.from(expected)` / `Buffer.from(sig)` (utf8); compara
   `a.length === b.length` **antes** de `crypto.timingSafeEqual`.

A reproduzir **sem** acrescentar regex:

- **Não há validação de formato da `sig`** (nem hex, nem tamanho por regex):
  só igualdade de bytes.
- **Uppercase não casa** — `digest('hex')` é minúsculo e a comparação é byte a
  byte.
- `sig` malformada/curta/longa → `false` pelo check de `length`.
- O único regex da rota é o do `infoHash` (`/^[a-f0-9]{40}$/i`, `resolve.ts:38`),
  aplicado ao hash já lowercased — não à `sig`. `Buffer.from` não valida hex.

### 1.7 Rota e contexto de acesso

- `resolve.ts:40` lê `req.query.w` só quando string; `:43` chama
  `services.verifyResolve(infoHash, ep, req.query.sig, hint)` e devolve **403**
  se falhar. A checagem só roda **quando há debrid** (`services.debrid.current()`,
  `:41`).
- O gate do `/resolve` é o **HMAC** (com debrid) — **não** o
  `X-Indexer-Test-Token` das rotas de diagnóstico, nem rate-limit global.
- Redirect: `302` no `/resolve` (`resolve.ts:74`); `307` no `addon-router` para
  `stream` (`src/routes/addon-router.ts:124`). Não abrir o documentor completo
  de rotas nesta etapa.

## 2. Oráculo golden (VERIFICADO — 54 datasets, 53 manifests)

O que esta seção descrevia como "planejado" **existe e roda**. No snapshot
`19b9879` (2026-10-12) o diretório [`rust/golden/`](../rust/golden/) tem **54
`.jsonl`** e **53 manifests** — todos os datasets têm manifest menos
`stream-quotas-extra.jsonl`. A soma de linhas é **6.182** (**6.155** pela soma de
`corpus.cases` dos manifests); as contagens por dataset estão no mapa do §3. A
leva 4 commitada somou `catalog-classify` (50), `metric-id` (71), `request-key`
(65) e `crawl-store-rules` (169), e `audio-cleanup-verdicts` foi a 130 casos.

Contrato comum a todos os oráculos, no padrão de
`scripts/golden/dump-title-normalization.mjs` (o gerador vive no branch `esm`):
manifest `adom-golden-manifest/1`; corpus com `id` estável (**nunca renomear ou
reciclar**; caso novo entra no fim com id novo); `.jsonl` com o comportamento do
`dist` vivo; `sha256` de fonte, artifact, corpus e saída; `--check` só leitura.
Nenhum caminho de checagem abre rede, lê `.env` real, toca `data/*.db` ou fala
com debrid. Chaves de HMAC dos goldens são **fictícias** (prefixo
`adom-golden-resolve-sign-FAKE-`, declarado no manifest como
`kind: fictitious-test-key`); o gerador recusa assinar com chave que não tenha o
prefixo.

**Proveniência dos hashes.** `sourceSha256` é **recalculado pelo checker Node**
(que re-executa o `dist` vivo e compara byte a byte); o teste Rust lê o
`output.sha256`/`corpus.sha256` do manifest e confere contra o `.jsonl`/corpus
commitados; `artifactSha256` pina o artefato de `dist/` de onde a saída foi
gerada, como proveniência (não é recomputado por todos os checkers). O `--check`
não escreve nem atualiza expectativas.

### 2.1 Política de hash da fonte (EOL)

[`scripts/golden/source-fingerprint.mjs`](../scripts/golden/source-fingerprint.mjs)
normaliza **só o fim de linha da FONTE** (`CRLF → LF`, casando apenas o par
`\r\n`; um `\r` isolado fica intacto) antes do SHA-256. Motivo: o mesmo `.ts`
versionado tem CRLF num checkout Windows e LF em outro, e o hash mudaria sem o
conteúdo mudar. **Nada** de corpus, saída `.jsonl`, payload de HMAC ou `hint`
passa por essa normalização — esses continuam byte a byte (a ordem das chaves do
JSON é preservada). O rótulo `sourceHashLineEndings: "LF"` documenta a política
no manifest.

Manifests gerados **antes** do commit `fef1cf6` (que introduziu a política) não
têm o campo e podem carregar hash **residual de CRLF**; `config-encoding` e
`reply-budget` foram corrigidos no commit `f305f44`. No snapshot, **21**
manifests declaram `sourceHashLineEndings`: `audio-cleanup-verdicts`,
`audio-presentation`, `br-pool-selection`, `catalog-classify`, `config-encoding`,
`crawl-store-rules`, `indexer-priority`, `magnet-uri`,
`matching-vocabulary-regex`, `matching-vocabulary-sets`,
`matching-vocabulary-title-tokens`, `metric-id`, `release-name-matching`,
`reply-budget`, `request-key`, `resolve-sign`, `stream-display`,
`stream-relabel`, `stream-trace`, `tmdb-br-aliases`, `video-header`. Os demais
já eram LF (hash bruto == hash LF), logo dispensam o rótulo.

### 2.2 Ferramentas (três gerações coexistem)

| Ferramenta | Cobre | Como rodar |
| --- | --- | --- |
| [`dump-title-normalization.mjs`](../scripts/golden/dump-title-normalization.mjs) — **18 chaves de `--fn`** (no branch `esm`; aqui só o `package.json` delega) | 18 goldens: `title-normalization`, `matching-vocabulary`, `matching-vocabulary-sets`, `matching-vocabulary-regex`, `matching-tokens-text`, `matching-tokens-decisions`, `matching-latin-ranges`, `short-name-tail`, `catalog-year`, `br-origin`, `magnet-uri`, `franchise`, `episode-parse`, `multiwork-pack`, `stream-quotas`, `release-work`, `release-title-rules`, `release-name-matching` | `npm run golden:titles:check` (delega a `../adom-esm`). Para `--fn`, rode `node scripts/golden/dump-title-normalization.mjs --check --fn <chave>` **dentro de `../adom-esm`** |
| 7 `gen-*.mjs` + 8 `registry-*.mjs` (`--check`, `--force`) | as 5 fatias do fim da lista acima, por fora do gerador unificado (`gen-multiwork-pack`, `gen-stream-quotas`, `gen-release-work`, `gen-release-title-rules`, `gen-release-name-matching`), mais `gen-cache` (cache) e `gen-latin-table` (tabela interna) | `node scripts/golden/gen-<nome>.mjs --check` |
| [`dump-resolve-sign.mjs`](../scripts/golden/dump-resolve-sign.mjs) + `resolve-sign-oracle.mjs` | `resolve-sign` | `npm run golden:resolve-sign:check` |
| [`dump-release-labels.mjs`](../scripts/golden/dump-release-labels.mjs) + `release-labels-oracle.mjs` | `release-labels` | `npm run golden:release-labels:check` |
| [`dump-pt-audio-guards.mjs`](../scripts/golden/dump-pt-audio-guards.mjs) | `pt-audio-guards` | `npm run golden:pt-audio-guards:check` |
| [`dump-search-name-helpers.mjs`](../scripts/golden/dump-search-name-helpers.mjs) + `search-name-helpers-oracle.mjs` | `search-name-helpers` | `npm run golden:search-name-helpers:check` |
| `dump-indexer-priority.mjs` — **no branch `esm`** (removido deste branch) | `indexer-priority` | dentro de `../adom-esm`: `npm run golden:indexer-priority -- --force` (regerar) |
| [`dump-audio-presentation.mjs`](../scripts/golden/dump-audio-presentation.mjs) + `audio-presentation-oracle.mjs` | `audio-presentation` | `npm run golden:audio-presentation:check` |
| [`dump-audio-cleanup-verdicts.mjs`](../scripts/golden/dump-audio-cleanup-verdicts.mjs) + `audio-cleanup-verdicts-oracle.mjs` | `audio-cleanup-verdicts` | `npm run golden:audio-cleanup-verdicts:check` |
| [`dump-stream-display.mjs`](../scripts/golden/dump-stream-display.mjs) + `stream-display-oracle.mjs` | `stream-display` (porte Rust, `dd7c7c2`) | `npm run golden:stream-display:check` |
| [`dump-stream-relabel.mjs`](../scripts/golden/dump-stream-relabel.mjs) + `stream-relabel-oracle.mjs` | `stream-relabel` (porte Rust, `4d6fcbb`) | `npm run golden:stream-relabel:check` |
| [`dump-stream-trace.mjs`](../scripts/golden/dump-stream-trace.mjs) + `stream-trace-oracle.mjs` | `stream-trace` (porte Rust, `e2b083b`) | `npm run golden:stream-trace:check` |
| [`dump-catalog-classify.mjs`](../scripts/golden/dump-catalog-classify.mjs) + `catalog-classify-oracle.mjs` | `catalog-classify` (porte Rust, `a4ee159`) | `npm run golden:catalog-classify:check` |
| [`dump-metric-id.mjs`](../scripts/golden/dump-metric-id.mjs) + `metric-id-oracle.mjs` | `metric-id` (porte Rust, `bbe43d8`) | `npm run golden:metric-id:check` |
| [`dump-request-key.mjs`](../scripts/golden/dump-request-key.mjs) + `request-key-oracle.mjs` | `request-key` (porte Rust, `0df9c5c`) | `npm run golden:request-key:check` |
| [`dump-crawl-store-rules.mjs`](../scripts/golden/dump-crawl-store-rules.mjs) + `crawl-store-rules-oracle.mjs` | `crawl-store-rules` (porte Rust, `19b9879`; travas em `4b57a2b`) | `npm run golden:crawl-store-rules:check` |
| [`dump-video-header.mjs`](../scripts/golden/dump-video-header.mjs) + `video-header-oracle.mjs` | `video-header` | linha de comando |
| [`dump-tmdb-br-aliases.mjs`](../scripts/golden/dump-tmdb-br-aliases.mjs) + `tmdb-br-aliases-oracle.mjs` | `tmdb-br-aliases` | linha de comando |
| [`dump-br-pool-selection.mjs`](../scripts/golden/dump-br-pool-selection.mjs) + `br-pool-selection-oracle.mjs` | `br-pool-selection` | linha de comando |
| [`dump-config-encoding.mjs`](../scripts/golden/dump-config-encoding.mjs) | `config-encoding` | linha de comando |
| [`registry-matches-br-title.mjs`](../scripts/golden/registry-matches-br-title.mjs) | `matches-br-title` (tem `resolve` que importa o `dist`, mas não está ligado a runner nem a `--fn` — §4) | — |
| **nenhum gerador** | `reply-budget` (**órfão**: manifest existe, gerador não) | — |

Complementos: os `build-corpus-*.mjs` produzem os corpus; `gen-latin-table.mjs`
produz a tabela interna `latin_table.rs`; `generate-stream-quotas-extra.mjs`
produz `stream-quotas-extra.jsonl` (que **não** tem manifest). São pares de
scripts npm: `golden:titles`, `golden:resolve-sign`, `golden:release-labels`,
`golden:pt-audio-guards`, `golden:audio-cleanup-verdicts`,
`golden:crawl-store-rules`, `golden:metric-id`, `golden:catalog-classify`,
`golden:request-key`, `golden:search-name-helpers`,
`golden:audio-presentation`, `golden:stream-display`, `golden:stream-relabel` e
`golden:stream-trace`; `video-header`, `tmdb-br-aliases`, `br-pool-selection` e
`config-encoding` rodam por linha de comando.

Os oráculos de `franchise` e `indexer-priority` não vivem mais neste branch: o
oráculo TS congelado (`franchise-base.ts` e `indexer-priority.ts`) segue no branch
`esm`, e é de lá que se regenera — `npm run golden:titles -- --fn franchise
--force` e `npm run golden:indexer-priority -- --force` dentro de `../adom-esm`.
Os `.jsonl`/manifests/corpus continuam commitados aqui e são conferidos pelos
testes Rust.

Do lado Node, o teste permanente
[`test/golden-title-normalization.test.ts`](../test/golden-title-normalization.test.ts)
cobre **só** o checker de `title-normalization` (173 casos, fixtures em diretório
temporário do SO, leitura estrita de bytes e mtime). Os outros oráculos são
verificados pelos testes Rust e pelo `--check` manual.

## 3. Estado da migração (contexto, não contrato)

Runtime de produção é **TS** (`dist/` roda; a única ponte ativa é
`src/utils/rust-core.ts` → `normalizeTitle` no `addon.ts`, sob `RUST_CORE` off). O
Rust de hoje é **paridade verificada no corpus, não adoção**: `rust/crates/adom-core` porta
**56 módulos** (contagem por `mod` no `lib.rs`), quase todos **função pura**
(texto/objeto → valor), cobertos por **54 datasets golden** e um teste por
golden. **Não se deve ler esta lista como "pipeline migrado"**: só as unidades
puras abaixo ganharam implementações Rust; suas versões TS não foram retiradas.
Busca, providers, debrid, crawl e o wiring de I/O continuam em `src/` (§5).

Mapa de capacidades (módulo Rust · API pública · fonte TS · golden/casos). A
contagem de casos é do snapshot `19b9879`: **6.182** linhas de `.jsonl` no total;
a soma de `corpus.cases` dos 53 manifests é **6.155** (faltam os 27 de
`stream-quotas-extra`, sem manifest). As colunas abaixo vêm do manifest quando
existe.

**normalização / texto base**

| Módulo | API pública | Fonte TS | Golden (casos) |
| --- | --- | --- | --- |
| `title_normalization` | `normalize_title` | `title-normalization.ts` | `title-normalization` (173) |
| `decode_entities` | `decode_entities` | `title-normalization.ts` | `decode-entities` (25) |
| `collapse_acronyms` | `collapse_acronyms` | `title-normalization.ts` | `collapse-acronyms` (19) |
| `strip_diacritics` | `strip_diacritics` | `title-normalization.ts` | `strip-diacritics` (20) |
| `dedupe_names` | `dedupe_names` | `title-normalization.ts` | `dedupe-names` (14) |
| `magnet_display_name` | `magnet_display_name` | `title-normalization.ts` | `magnet-display-name` (17) |
| `bytes_to_size` | `bytes_to_size` | `title-normalization.ts` | `bytes-to-size` (20) |
| `info_hash` | `extract_info_hash` | `title-normalization.ts` | `magnet-uri` (op `info`) |
| `js_text` | helpers internos de semântica JS (`js_stringify`, `b64url_*`, `js_slice_units`…) | — | sem golden |
| `js_text16` | `JsText` (unidade de código UTF-16; ver §3.2) | — | sem golden (contrato §3.2) |
| `latin_table` | tabela interna | — | verificado por `matching-latin-ranges` |

**tokens e decisões**

| Módulo | API pública | Fonte TS | Golden (casos) |
| --- | --- | --- | --- |
| `matching_vocabulary` | `title_tokens`, `vocabulary_contents`, `year_range_test`, `episode_token_test` | `matching-vocabulary.ts` | `matching-vocabulary-title-tokens` (203), `-sets` (13), `-regex` (246) |
| `matching_tokens` | `extract_sequence_markers`, `episode_work_tokens`, `first_work_token`, `first_unmarked_token`, `is_non_naming_token`, `is_non_latin_token`, `Marker` | `matching-tokens.ts` | `matching-tokens-text` (243), `matching-latin-ranges` (1) |
| `matching_decisions` | `title_precision`, `year_contradicts`, `named_sequel_contradicts`, `live_action_year_contradicts`, `adaptation_identity_contradicts`, `first_significant_token` | `matching-tokens.ts` | `matching-tokens-decisions` (50) |

**ano / nome curto**

| Módulo | API pública | Fonte TS | Golden (casos) |
| --- | --- | --- | --- |
| `catalog_year` | `catalog_year_of`, `catalog_alt_year_of` | `catalog-year.ts` | `catalog-year` (14) |
| `short_name_tail` | `short_name_tail_contradicts` | `short-name-tail.ts` | `short-name-tail` (15) |

**franquia / pack**

| Módulo | API pública | Fonte TS | Golden (casos) |
| --- | --- | --- | --- |
| `franchise` | `franchise_base_contradicts`, `franchise_extension_contradicts`, `name_coverage_tokens`, `is_multi_work_collection` | `franchise-base.ts` (oráculo no branch `esm`; porte em `adom-core::franchise`) | `franchise` (415) |
| `multiwork_pack` | `admits_multi_work_pack`, `collection_root`, `collection_root_tokens`, `covers_year`, `pack_year_source` | `multiwork-pack.ts` | `multiwork-pack` (264) |

**episódio**

| Módulo | API pública | Fonte TS | Golden (casos) |
| --- | --- | --- | --- |
| `episode_parse` | `parse_title_season_episode`, `season_coverage_excludes`, `ParsedSeasonEpisode` | `episode-matching.ts` | `episode-parse` (890) |
| `episode_matching` | `matches_episode`, `is_season_pack_release`, `is_season_pack_fill_eligible` | `episode-matching.ts` | `episode-matching` (40) |
| `episode_series_matching` | `matches_episode_work_identity`, `matches_global_series_no_marker` | `release-title-rules.ts` | `episode-series-matching` (25) |

**cache (nomes de namespace e cotas — NÃO o SQL/`data/*.db`)**

| Módulo | API pública | Fonte TS | Golden (casos) |
| --- | --- | --- | --- |
| `cache_keys` | `cache_key`, `is_versioned`, `namespace_version`, `prefix`, `LEGACY_PREFIXES`, `mag_meta_counts_key` | `cache-keys.ts` | `cache-keys` (54) |
| `cache_quotas` | `headroom`, `namespace_for`, `quota_for`, `universe_len`, `universe_total`, `validate_quotas`, `MAX_ENTRIES` | `cache-quotas.ts` | `cache-quotas` (128) |

**nomes / cotas de stream**

| Módulo | API pública | Fonte TS | Golden (casos) |
| --- | --- | --- | --- |
| `release_name_matching` | `matches_name`, `franchise_root`, `franchise_roots`, `ends_with_sequence_marker`, `contains_token_run` | `release-name-matching.ts` | `release-name-matching` (434) |
| `release_title_rules` | `matches_title_structure`, `short_name_identity`, `matches_short_name_identity`, `ShortNameIdentity` | `release-title-rules.ts` | `release-title-rules` (63) |
| `matches_br_title` | `matches_br_title` (recebe `cut_tail` em vez de ler config) | `release-title-rules.ts` | `matches-br-title` (50) |
| `release_work` | `episode_parse_specificity`, `choose_episode_parse`, `route_work_location`, `release_fits_request`, `release_work_targets`, `WorkTarget` | `release-work.ts` | `release-work` (72) |
| `stream_quotas` | `limit_by_indexer` | `stream-quotas.ts` | `stream-quotas` (87) |
| `stream_quotas_extra` | `stream_quality`, `quality_from_title`, `select_quality_candidates`, `limit_by_quality`, `limit_by_quality_and_indexer`, `limit_reserving_br`, `QUALITY_KEYS`, `UNKNOWN_QUALITY` | `stream-quotas.ts` + `stream-quotas-candidate.ts` | `stream-quotas-extra` (27; **sem manifest**) |

**crypto / config / funções puras (NÃO o schema de usuário completo)**

| Módulo | API pública | Fonte TS | Golden (casos) |
| --- | --- | --- | --- |
| `resolve_sign` | `sign_resolve`, `verify_resolve` | `sign.ts` | `resolve-sign` (24) |
| `config_encoding` | `decode_config`, `encode_config`, `parse_segment`, `seal_segment` | `runtime.ts` (+ `secret-box.ts`) | `config-encoding` (48) |
| `dk_seal` | `derive_dk_key`, `is_sealed`, `seal_dk`, `unseal_dk` | `secret-box.ts` | `config-encoding` (op `seal`/`open`/`isSealed`) |
| `reply_budget` | `remaining_check_budget` | `deadline.ts` | `reply-budget` (14) |

O `parse_segment`/`encode_config` cobre as funções **puras** de `runtime.ts`; o
`SCHEMA`/`defaults()` completo (campos, defaults, clamps, `KEYS` do configurador)
fica no TS e **não** é mapeado aqui (§5). O `seal` do Node usa `randomBytes(12)`;
no Rust o nonce é parâmetro (função pura, golden determinístico) — a camada
chamadora fornece os 12 bytes.

**métricas / chave de request**

| Módulo | API pública | Fonte TS | Golden (casos) |
| --- | --- | --- | --- |
| `metric_id` | `safe_metric_id`, `indexer_fallback_metric_key` | `metric-id.ts` | `metric-id` (71) |
| `request_key` | `account_scope`, `streams_cache_scope`, `streams_cache_key` | `request-key.ts` | `request-key` (65) |

**catálogo / aliases / pools BR**

| Módulo | API pública | Fonte TS | Golden (casos) |
| --- | --- | --- | --- |
| `catalog_classify` | `classify_by_title`, `classify_with_evidence`, `foreign_proof_label`, `Proof` | `catalog-classify.ts` | `catalog-classify` (50) |
| `tmdb_br_aliases` | `filter_br_aliases`, `MAX_BR_ALIASES` | `tmdb-br-aliases.ts` | `tmdb-br-aliases` (86) |
| `br_pool_selection` | `br_dubbed_pool`, `any_dubbed_pool`, `top_seeded_pool`, `fallback_blocked`, `is_autofetch_target_quality`, `pick_br_dubbed_by_target_qualities`, `PoolOptions`, `PoolStream` | `autofetch-pools.ts` | `br-pool-selection` (94) |

**vídeo**

| Módulo | API pública | Fonte TS | Golden (casos) |
| --- | --- | --- | --- |
| `video_header` | `is_mp4`, `parse_mp4_tail`, `parse_video_resolution`, `quality_from_resolution`, `VideoResolution` | `video-header.ts` | `video-header` (106) |

**stream (display / relabel / trace)**

| Módulo | API pública | Fonte TS | Golden (casos) |
| --- | --- | --- | --- |
| `stream_display` | `stream_display_name`, `compact_tracker`, `StreamDisplayConfig`, `StreamDisplayOptions`, `StreamNameStyle`, `UserDisplayOptions` | `stream-display.ts` | `stream-display` (124) |
| `stream_relabel` | `relabel`, `RelabelOptions`, `RelabelStream` | `stream-relabel.ts` | `stream-relabel` (129) |
| `stream_trace` | `create_stream_trace`, `clone_stream_trace`, `stage_trace`, `set_trace_stage`, `set_trace_chupim`, `drop_trace`, `finalize_trace`, `sanitize_trace_label`, `sanitize_chupim_note`, `serialize_trace`, `TraceValue`, caps (`STREAM_TRACE_*`) | `stream-trace.ts` | `stream-trace` (138) |

**estado de crawl (regras puras — NÃO o SQL/`data/*.db`)**

| Módulo | API pública | Fonte TS | Golden (casos) |
| --- | --- | --- | --- |
| `crawl_store_rules` | `apply_result`, `decide_upsert`, `empty_counters`, `error_backoff_ms`, `parse_progress`, `parse_status`, `parse_url_row`, `progress_advanced`, `render_progress`, `render_url`, `with_dry_flag`, `CRAWL_GIVE_UP_MS`, `DEFAULT_RETRY_BASE_MS`, `ERROR_BACKOFF_CAP_MS`, `URL_COLUMNS` | `crawl-store-rules.ts` | `crawl-store-rules` (169) |

**URL**

| Módulo | API pública | Fonte TS | Golden (casos) |
| --- | --- | --- | --- |
| `crawl_url_key` | `crawl_url_key` | `crawl-url-key.ts` | `crawl-url-key` (24) |
| `net_safety` | `is_safe_download_url` | `net-safety.ts` | `net-safety` (28) |

`crawl_url_key` usa o pathname do parser WHATWG (`new URL` do Node) e **não**
prova paridade para qualquer UTF-8: o golden tem **24 casos**. `net_safety`
(`isSafeDownloadUrl`) tem **28 casos** — prova esses 28, não uma cobertura ASCII
universal.

**rótulos de release / guardas de áudio**

| Módulo | API pública | Fonte TS | Golden (casos) |
| --- | --- | --- | --- |
| `release_labels` | `source_from_title`, `edition_from_title`, `compact_audio` | `audio-quality.ts` | `release-labels` (124) |
| `pt_audio_guards` | `explicit_pt_audio`, `has_explicit_foreign_audio` | `audio-quality.ts` | `pt-audio-guards` (140) |
| `audio_lang` | `generic_dub_proves_pt`, `foreign_lang_named_for_bucket`, `names_foreign_dub_language` | `audio-cleanup.ts` | `audio-lang` (71) |
| `audio_presentation` | `strip_quality_tag_blob`, `audio_from_title`, `looks_pt_br` | `audio-quality.ts` | `audio-presentation` (170) |
| `audio_cleanup_verdicts` | `has_pt_audio_mark`, `strong_en_scene_mark`, `dubbed_lie_verdict`, `en_scene_mirror_title`, `dn_contradicts_dub_claim`, `DubbedLieVerdict` | `audio-cleanup.ts` | `audio-cleanup-verdicts` (130) |

**guardas de release / origem**

| Módulo | API pública | Fonte TS | Golden (casos) |
| --- | --- | --- | --- |
| `release_guards` | `text_years_contradict`, `magnet_year_contradicts`, `magnet_season_contradicts` | `release-filters.ts` | `release-guards` (19) |
| `non_feature_release` | `is_home_source`, `is_non_feature`, `pre_home_release_contradicts` | `non-feature-release.ts` | `non-feature-release` (40) |
| `br_origin` | `has_pt_signs`, `br_origin_mark` | `br-origin.ts` | `br-origin` (439) |
| `magnet_uri` | `sanitize_magnet`, `default_magnet` | `magnet-uri.ts` | `magnet-uri` (46) |

**consulta de busca / prioridade de indexer**

| Módulo | API pública | Fonte TS | Golden (casos) |
| --- | --- | --- | --- |
| `search_name_helpers` | `resolve_search_names`, `resolve_original_step_name`, `parse_stremio_id`, `build_search_query`, `numeral_search_variant`, `mark_debrid_name`, `matches_quality_filter` | `search-names.ts` | `search-name-helpers` (141) |
| `indexer_priority` | `priority_map`, `compare_indexer_priority` | `indexer-priority.ts` (oráculo no branch `esm`; porte em `adom-core::indexer_priority`) | `indexer-priority` (70) |

As contagens acima são **do artefato** — não são meta nem prova de fase
concluída; não extrapolar para declarar "Fase 0/1 concluída".

Gates do workspace no baseline (revisão de agente; **não** re-executados nesta
tarefa): o gate do coordenador — `cargo test --workspace --locked`,
`cargo clippy --workspace --all-targets --locked -- -D warnings` e
`cargo fmt --all -- --check` — passou sobre as APIs registradas; `cargo audit`
**não** foi re-executado nesta revisão. No fechamento da leva, os **15 aliases**
`golden:*:check` passaram contra o `dist` disponível; isso não significa que
todos os 54 datasets tiveram o checker Node executado. Também passaram
`npm run typecheck`, `npm run lint:lines` e `npm run test:complete`. A catraca
Rust contou **122 arquivos**, incluindo linhas vazias, com máximo de **399**.
`node_modules` precisou ser restaurado por `npm ci`; a causa de ter ficado vazio
não foi demonstrada. O baseline `9fb915d` tinha clippy
vermelho; `ad50b10` zerou fmt/clippy (seleção de `struct` pura e fontes portadas
válidas). Toolchain pinada em [`rust-toolchain.toml`](../rust/rust-toolchain.toml)
= **1.92.0** — primeira estável com `char::UNICODE_VERSION = (17,0,0)`, o mesmo
Unicode 17.0.0 do Node v22.23.2 do oráculo. **Não** extrapolar para uma toolchain
antiga (ex.: 1.83) nem declarar "sempre zero" num contexto futuro que não mapeia
Feature/Prod.

Benchmark: [`rust/benchmarks/local-ts-baseline.json`](../rust/benchmarks/local-ts-baseline.json)
é **observacional, local** (`win32`), **passivo** (sem forçar busca/play nem HTTP
externo), com `controlledBenchmark:false` e `rustComparison:false`. p50/p95 são
**NULOS** nesta amostra (a janela do servidor não é reportada pelo endpoint) —
nulo não é zero. Não há servidor Rust neste checkout, logo nenhuma comparação
TS-vs-Rust é feita ou afirmada. Sem suposições de deploy em VPS.

## 3.1 Ponte NAPI e oráculos em andamento

- **`adom-napi`** (`rust/crates/adom-napi`, **commitado**): 12 exports —
  `normalizeTitle`, `signResolve`, `verifyResolve`, `matchesBrTitle`,
  `parseTitleSeasonEpisode`, `matchesName`, `sanitizeMagnet`, `defaultMagnet`,
  `extractInfoHash`, `brOriginMark`, `hasPtSigns`, `limitByIndexer`. É **só
  wrapping**: cada função delega a `adom_core::*` — inclusive
  `sign_resolve`/`verify_resolve`, que **encaminham** para o núcleo criptográfico
  (`adom-core::resolve_sign`); **não há HMAC duplicado**. Tem
  [`tests/napi_parity.rs`](../rust/crates/adom-napi/tests/napi_parity.rs) com
  **34 testes** (executados em revisão de agente, não re-executados aqui). O
  workspace declara `members = ["crates/adom-core", "crates/adom-napi"]`.
- **Diferença latente**: o binding `verifyResolve` tipa `sig: String`, enquanto o
  TS aceita `unknown` e devolve `false` para não-string. Hoje **não há consumidor
  TS** do binding (§4); a diferença só apareceria quando `src/` começar a
  consumi-lo.
- **Oráculos com porte Rust concluído (levas 3 e 4)**: `js_text16` (o tipo),
  `stream-display` (124, `dd7c7c2`), `stream-relabel` (129, `4d6fcbb`),
  `stream-trace` (138, `e2b083b`), `audio-cleanup-verdicts` (130, `6474084` +
  `edcac01`), `catalog-classify` (50, `a4ee159`), `metric-id` (71, `bbe43d8`),
  `request-key` (65, `0df9c5c`) e `crawl-store-rules` (169, `19b9879`, travas em
  `4b57a2b`) estão em `lib.rs` com paridade verificada nos respectivos corpora, e os
  `npm run golden:<nome>:check` seguem valendo. Traps declarados nos manifestos:
  - `stream-display`/`stream-relabel`: `compactTracker` fatia em unidades UTF-16
    e pode produzir surrogate isolado (**4 + 4** vetores — `sd-083`…`sd-086` no
    display e `i-01`/`i-02`/`i-03`/`i-08` no relabel). Resolvido pelo contrato
    `JsText` (§3.2): o órfão **sobrevive** no `Vec<u16>` e é re-escapado como
    `\uXXXX` na serialização, sem U+FFFD.
  - `stream-trace`: 2 vetores de borda 59/159 com surrogate isolado; item cap
    300, `account-*` 60, label 60, chupim 160.
  - O campo `expected` do `relabel`/`trace` é **JSON-texto** (`JSON.stringify`);
    o do `display` é **texto cru** e é **omitido** nos órfãos — o leitor Rust
    aceita `expected` ausente (`Option<String>`). Uniformizar o contrato segue
    como fatia própria.

## 3.2 Contrato de texto UTF-16 (`JsText`) — VERIFICADO

`adom-core::JsText` (módulo `js_text16`) representa a string JS como `Vec<u16>` —
**unidade de código UTF-16**, não `char`. Portes que cortam em índice de string
(`slice`, `substring`, teto de 60/160) precisam dele, porque um corte pode cair
no meio de um par substituto e o JS **preserva** o órfão.

- **Onde usar**: funções cujo resultado dependa de `String.prototype.slice` ou de
  contagem de unidades (`compactTracker`, `streamDisplayName`,
  `sanitizeTraceLabel`, `sanitizeChupimNote`).
- **Onde NÃO usar**: payload assinado (HMAC de `/resolve`), chave de cache e
  serialização de produção — esses contratos **não** usam `JsText` e a paridade
  provada é só a dos casos do corpus (§1), **não** uma paridade universal de
  `String`. `JsText` não entra em `resolve_sign`, `cache-keys` nem `dk_seal`.
- **`js_slice(a, b)`**: corta como o `slice` do JS (índices em unidades; par
  substituto partido permanece órfão).
- **`js_stringify()`**: serializa escapando o órfão como `\uXXXX` (hex
  minúsculo, como o `JSON.stringify`), nunca `to_string_lossy` nem U+FFFD.
- **`from_json_string_literal(s)`**: decodifica um literal JSON de volta para as
  unidades, recompondo o órfão — é o caminho de leitura dos `expected` em
  JSON-texto.
- **Proibições**: não expor `to_string_lossy` público; não comparar golden por
  `String` com perda (comparar por `expectedJson`/unidades).
- **Dívidas de paridade do `stream-trace` (P3, latentes)**: `cloneStreamTrace`
  reconstrói forma fixa (feito); `spread` de item não-objeto, coerção de
  `stages`/`accountItems` a partir de string, ordem de chave inteiro-símile e
  `Number`→`String` fora do range inteiro divergem do JS, mas só para entradas
  fora do contrato tipado do chamador — documentadas, não corrigidas.

## 4. Riscos e ambiguidades

Da fatia HMAC (§1) — continuam válidos:

- **Ordem de chaves do `hint`**: porte que serialize com sort gera assinatura
  diferente. Ambiguidade real a preservar, não resolver.
- **`ep` com `?` embutido**: tratar `ep` como "só `s=`/`e=`" quebra o payload.
- **Semântica do `sig`**: adicionar validação de hex/uppercase aceitaria ou
  rejeitaria casos que o TS não rejeita; reproduzir `length`+`timingSafeEqual`
  sobre bytes utf8.
- **Chave por requisição**: a assinatura depende da chave efetiva da request
  (URL/ENV), não de estado global.

Do estado atual da migração:

- **Porte ≠ adoção**: nenhuma das funções portadas substitui caminho TS em
  runtime; o que segura regressão é o `--check` do oráculo, manualmente. Nada
  obriga o `dist` a continuar batendo depois que o `src/` mudar — um `--fn`
  esquecido deixa golden e fonte desalinhados sem nenhum teste gritando.
- **Lacuna de CI reconhecida (sem verifier novo)**: o `rust.yml` roda
  `cargo test --workspace --locked` / clippy / fmt / audit, mas o único teste
  Node permanente é o de `title-normalization`; os demais goldens são
  **derivados do `dist` atual** e dependem do `--check` chamado à mão. Essa
  lacuna (fonte `src/` × artefato `dist/`) é reconhecida aqui e **não** se cria
  um verifier novo nesta tarefa.
- **Binding estreita `sig` para `String`**: o núcleo aceita `Option<&str>` e o TS
  aceita `unknown`; o wrapper NAPI tipa `String`. Diferença latente, sem
  consumidor TS hoje.
- **A árvore é compartilhada com portes paralelos e muda enquanto se documenta**:
  qualquer afirmação de estado precisa ser refeita (`git status` + `cargo test`)
  antes de ser citada. Há alterações **não commitadas do usuário** (fora do
  `HEAD` desta revisão) em `rust/golden/episode-matching.jsonl`,
  `rust/golden/matches-br-title.jsonl` e corpus correlatos; as contagens deste
  arquivo são do `HEAD 19b9879`, **não** dessas alterações de working tree.
- **`E0463` observado, causa NÃO demonstrada**: um erro de build `E0463` (crate
  não encontrado) foi observado em execução de agente, mas a causa **não** está
  demonstrada — **não** atribuir a corrupção do crate/workspace nem tratá-lo
  como estado atual.
- **`matches-br-title` sem oráculo vivo**: é o único golden cujo `expected` foi
  traçado de testes TS (`test/br-title.test.ts`,
  `test/br-title-edition.test.ts`), não do `dist`. O
  [`registry-matches-br-title.mjs`](../scripts/golden/registry-matches-br-title.mjs)
  tem um `resolve` que importa o `dist`, mas não está ligado a runner nem ao
  `--fn` do gerador unificado (`--fn matches-br-title` **não existe**). Ele prova
  paridade com o comportamento *testado*, não com o *executado*: se o TS divergir
  dos próprios testes, o golden continua "batendo". Ligar ao gerador e regenerar
  contra o `dist` antes de contar como portado.
- **`reply-budget` órfão**: tem manifest e 14 casos, mas **nenhum gerador** em
  `scripts/golden/` — não é regenerável hoje. O `sourceSha256` residual de CRLF
  foi corrigido em `f305f44` (política LF aplicada por metadata), mas segue sem
  gerador.
- **`stream-quotas-extra` sem manifest**: 27 casos gerados por
  `generate-stream-quotas-extra.mjs`, mas sem manifest de integridade — a
  contagem não tem ateste de hash.
- **`request-key` — limites de paridade**: o JS usa números IEEE-754; acima de
  **2^53**, certos inteiros do JSON são arredondados pelo `JSON.parse` do Node para
  `f64` e o módulo Rust continua emitindo os dígitos exatos do `serde_json` —
  limite **não exercitado** pelo corpus. Além disso, o módulo **duplica de
  propósito** a coerção/`JSON.stringify` ordenado de `js_text` (o `stringify` de
  lá não reordena chaves de índice), com **risco de drift a vigiar**; o único
  símbolo reusado é `prefix('streams')` de `cache_keys`. `options` que não seja
  objeto JSON cai em `{}` (divergência fora do corpus, coberta no teste próprio,
  não no golden).
- **`metric-id` — unidade UTF-16**: `replace(/[^a-z0-9_.-]/g,'_')` opera por
  **unidade** UTF-16 (sem flag `/u`), então um par astral vira **dois** `_`; a
  substituição percorre `encode_utf16`, não `char`. `safeMetricId`/`indexerFallbackMetricKey`
  compartilham a regra entre produtor e consumidor — divergência zeraria o
  indicador para sempre.
- **Cobertura de checker Node desigual**: só `title-normalization` tem teste
  permanente no `test/`; os demais dependem de `--check` chamado à mão, e
  `matches-br-title`/`reply-budget`/`stream-quotas-extra` têm lacuna de
  gerador/manifest (§3.1/§4).
- **`matching-latin-ranges` tem 1 caso**: a comparação com o JS é feita pelo
  teste Rust varrendo o Unicode contra a linha única do golden; não há corpus por
  codepoint, logo o `--check` cobre formato/hash, não comportamento ponto a ponto.
- **`adom-napi` testa o core, não o binding**: os 34 testes chamam
  `adom_core::*` direto (o wrapper é conversão de tipo trivial), então a
  conversão Node↔Rust (incl. `Vec<Option<String>>`, `HashMap`) não é exercitada
  em runtime Node.
- **Comentários de doc em `.rs` defasados (P2, não editar aqui)**: o cabeçalho de
  `config_encoding.rs` sugere `aes-gcm = "0.11.1"` / `scrypt = "0.12.0"` e diz
  "não editei `lib.rs` nem `Cargo.toml`", mas
  [`adom-core/Cargo.toml`](../rust/crates/adom-core/Cargo.toml) pina
  **`aes-gcm = "0.10"`** e **`scrypt = "0.11"`**, e `lib.rs` já declara os
  módulos. Vale a versão do Cargo; corrigir o comentário fica fora deste escopo.
- **Divergência UTF-16 no config**: `String(x).slice(0, N)` corta em unidades
  UTF-16 e pode deixar surrogate órfão; em Rust não existe `String` com surrogate
  isolado. **Não** prometer que o `serde_json`/`String` do Rust reproduz surrogate
  órfão — a diferença só toca chave com emoji no limite.
- **URL/benchmark sem prova universal**: `crawl-url-key` (24) e `net-safety` (28)
  provam os casos do corpus; o benchmark de baseline é ad-hoc, observacional e
  não versiona comparação TS-vs-Rust.

## 5. Contratos PENDENTES

Núcleo planejado no mega-plano — **nada disso foi portado**, e nada foi lido no
fonte como contrato:

- `DDL4` (nome conforme mega-plano; escopo a confirmar);
- `stores`/SQL (`data/*.db`) e DDL — o §3 cobre só **nomes de namespace e cotas**
  do cache, não a camada de armazenamento;
- contrato de env / HTTP / test mocks upstream e `ADOM_TARGET` (F0 parcial);
- `SCHEMA`/`defaults()`/`KEYS` do config de usuário (o §3 cobre só as funções
  puras de `runtime.ts`).

Restos dos arquivos já iniciados (o que **ainda** falta; o resto já tem porte
commitado e está no mapa do §3):

- `search-names.ts` → `toStremioStream`, `passesQualityFilter` e a lista
  `TRACKERS` continuam **PENDENTES** (dependem de tipos de stream/módulos não
  portados); o `streamDisplayName` reexportado **já tem porte** (`stream_display`,
  §3);
- `stream-quotas.ts` → as funções exportadas (`QUALITY_KEYS`, `streamQuality`,
  `selectQualityCandidates`, `limitByIndexer`, `limitByQualityAndIndexer`,
  `limitByQuality`, `limitReservingBr`) **já têm porte** (`stream_quotas` +
  `stream_quotas_extra`), e o `stream-trace.ts` completo (família `dropTrace`/
  `onSelected`) **já tem porte** (`stream_trace`, §3.1);
- `stream-relabel.ts` → `relabel` **já tem porte** (`stream_relabel`, §3.1;
  depende de `display` e de `compactTracker`, ambos portados);
- `audio-quality.ts` → `compactTracker` **já tem porte** (`stream_display`,
  §3.2); `audioFromTitle` e `looksPtBr` (`audio_presentation`); `sourceFromTitle`,
  `editionFromTitle`, `compactAudio` (`release_labels`), `qualityFromTitle`
  (`stream_quotas_extra`), `explicitPtAudio`, `hasExplicitForeignAudio`
  (`pt_audio_guards`), `hasPtAudioMark`, `strongEnSceneMark`, `dubbedLieVerdict`
  (`audio_cleanup_verdicts`). `audioBucket` e `foreignVerdict` já existem como
  helpers privados de `catalog_classify`; sua API pública independente ainda
  não foi portada;
- `runtime.ts` → `defaults()`, `opts()`, `prefix()`, `capture()`, `run()` e o
  `log.warn` do `open` ficam no TS de propósito (leem `config.*`/AsyncLocalStorage);
- `matching-vocabulary.ts` → as 13 constantes exportadas (`PACK_WORDS` …
  `STRONG_PACK_WORDS`, `EPISODE_TOKEN`, `YEAR_RANGE`) são verificadas **por
  conteúdo** (`vocabulary_contents`, `year_range_test`, `episode_token_test`); não
  há API pública que as exponha como conjuntos — quem portar consumo precisa
  primeiro decidir essa API.

Já cobertos por inteiro: `matching-tokens.ts` (12 exports, entre
`matching_tokens` e `matching_decisions`), `multiwork-pack.ts` (6 exports),
`release-name-matching.ts` (7 exports), `title-normalization.ts` (os helpers
`decodeEntities`, `collapseAcronyms`, `stripDiacritics`, `dedupeNames`,
`magnetDisplayName`, `bytesToSize` ganharam porte próprio), `stream-trace.ts`,
`stream-relabel.ts` e `stream-display.ts` (nos contratos medidos pelos corpora).
`audio-quality.ts` tem os portes listados acima; `audioBucket`/`foreignVerdict`
seguem privados de `catalog_classify`, sem API pública independente.

Fora de `src/utils` — intocados: providers, rotas (`resolve.ts`,
`addon-router.ts`), cache/DB, debrid, crawl e o contrato de env/HTTP/mocks.
