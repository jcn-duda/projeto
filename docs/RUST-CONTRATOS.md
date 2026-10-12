# RUST-CONTRATOS.md — contratos TS→Rust

Status: **EM CURSO**. A fatia **HMAC de `/resolve`** foi verificada contra o
fonte em `HEAD 022ae03` e **ainda não tem porte registrado** (§1, §3.1). A
revisão da migração em `HEAD ec850cf` (branch `rust`) conta **18 módulos
portados, cobertos por 18 goldens** (§3): os contratos de `src/utils/*.ts` que
eles cobrem foram lidos no fonte e ancorados em oráculo (§2). Há ainda **duas fatias
em andamento na árvore de trabalho, sem commit** (§3.1). Config, cache,
rotas e providers seguem **PENDENTES** (§5).

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

Fontes do lado Rust lidos nesta revisão — a verificação deixou de cobrir uma
fatia só e passou a cobrir o crate inteiro:

- [`rust/crates/adom-core/src/lib.rs`](../rust/crates/adom-core/src/lib.rs) —
  módulos portados e API pública do crate
- [`rust/golden/`](../rust/golden/) — 20 `.jsonl` + 20 manifests na árvore:
  **18 commitados** (§3) e 2 sem commit (§3.1)
- [`rust/crates/adom-core/tests/`](../rust/crates/adom-core/tests/) — um teste
  golden por oráculo (19 `*_golden.rs` + `golden_corpus.rs` para o
  `title-normalization`, que é o piloto histórico), mais `unicode_parity.rs`
- [`scripts/golden/`](../scripts/golden/) — geradores, corpus e checkers do
  oráculo Node

"Verificado" = lido no fonte nesta revisão (e, no §2 e §3, também executado).
As linhas citadas no §1 são do `HEAD 022ae03` e podem deslocar; o path é o link
estável. Identificadores (funções, chaves, campos) são preservados. O runtime de
produção continua **TypeScript**: nenhum arquivo em `src/` importa o crate Rust.
No Rust há hoje **18 módulos portados, cobertos por 18 goldens** (§3) — não mais
só `normalizeTitle`; o HMAC de `/resolve` continua **sem porte registrado** (§3.1).

## 1. Contrato HMAC de `/resolve` (VERIFICADO)

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

## 2. Oráculo golden (VERIFICADO — 19 com oráculo `dist`, 1 sem)

O que esta seção descrevia como "planejado" **existe e roda verde**. O par do
HMAC está fechado: [`scripts/golden/dump-resolve-sign.mjs`](../scripts/golden/dump-resolve-sign.mjs)
(gerador + `--check`),
[`scripts/golden/corpus-resolve-sign.json`](../scripts/golden/corpus-resolve-sign.json)
e
[`rust/golden/resolve-sign.jsonl`](../rust/golden/resolve-sign.jsonl) (mais o
manifest) — **24 casos**, `registry:
["resolve-sign/signResolve", "resolve-sign/verifyResolve"]`, e chaves
**fictícias** declaradas no manifest (`kind: fictitious-test-key`; o gerador
recusa assinar com chave que não tenha o prefixo `adom-golden-resolve-sign-FAKE-`).

Contrato comum a todos os oráculos, no padrão de
[`scripts/golden/dump-title-normalization.mjs`](../scripts/golden/dump-title-normalization.mjs):
manifest `adom-golden-manifest/1`; corpus com `id` estável (**nunca renomear ou
reciclar**; caso novo entra no fim com id novo); `.jsonl` com o comportamento do
`dist` vivo; `sha256` de fonte, artifact, corpus e saída; `--check` só leitura.
Nenhum caminho de checagem abre rede, lê `.env` real, toca `data/*.db` ou fala
com debrid.

Três gerações de ferramenta coexistem:

| Ferramenta | Cobre | Como rodar |
| --- | --- | --- |
| [`dump-title-normalization.mjs`](../scripts/golden/dump-title-normalization.mjs) — **18 chaves de `--fn`** (13 no registro `FUNCTIONS` + 5 entradas vindas dos `registry-*.mjs`) | os 18 goldens portados do §3: `title-normalization`, `matching-vocabulary`, `matching-vocabulary-sets`, `matching-vocabulary-regex`, `matching-tokens-text`, `matching-tokens-decisions`, `matching-latin-ranges`, `short-name-tail`, `catalog-year`, `br-origin`, `magnet-uri`, `franchise`, `episode-parse` + `multiwork-pack`, `stream-quotas`, `release-work`, `release-title-rules`, `release-name-matching` | `npm run golden:titles:check` (padrão `title-normalization`) ou `node scripts/golden/dump-title-normalization.mjs --check --fn <chave>` |
| 5 pares `gen-*.mjs` + `registry-*.mjs` (`--check`, `--force`) | as mesmas 5 fatias do fim da lista acima, por fora do gerador unificado | `node scripts/golden/gen-<nome>.mjs --check` |
| [`dump-resolve-sign.mjs`](../scripts/golden/dump-resolve-sign.mjs) + `resolve-sign-oracle.mjs` (filho isolado) | `resolve-sign` | `npm run golden:resolve-sign:check` |
| **nenhum dumper** | `matches-br-title` (50 casos, só na árvore — §3.1) | não há: os esperados foram traçados dos testes TS, não do `dist` (ver §4) |

Total na árvore: **20 `.jsonl`**, dos quais **19 regeneráveis contra o `dist`
vivo**; `matches-br-title` é a exceção.

Complementos: 12 `build-corpus-*.mjs` produzem os corpus; `gen-latin-table.mjs`
produz a tabela interna `latin_table.rs`. Só `golden:titles` e
`golden:resolve-sign` têm script no [`package.json`](../package.json) — os
demais rodam por linha de comando.

Executado nesta revisão (não presumido):

```
node scripts/golden/dump-resolve-sign.mjs --check
  [golden] OK: rust/golden/resolve-sign.jsonl (24 casos batem com o dist vivo)
node scripts/golden/dump-title-normalization.mjs --check --fn br-origin
  [golden] OK: rust/golden/br-origin.jsonl (439 casos batem com o dist vivo)
node scripts/golden/gen-stream-quotas.mjs --check
  [golden] OK: 87 casos, saída e manifest batem com o dist
node scripts/golden/dump-title-normalization.mjs --check --fn matches-br-title
  [golden] FALHA: --fn desconhecido: matches-br-title
             (válidos: os 18 nomes da tabela)
```

Do lado Node, o teste permanente
[`test/golden-title-normalization.test.ts`](../test/golden-title-normalization.test.ts)
cobre **só** o checker de `title-normalization` (173 casos, fixtures em diretório
temporário do SO, leitura estrita de bytes e mtime). Os outros oráculos são
verificados pelos testes Rust e pelo `--check` manual.

## 3. Estado da migração (contexto, não contrato)

Runtime de produção é **TS** (`dist/` roda; nenhum `src/` importa o crate). O Rust
de hoje é **paridade provada, não adoção**: `rust/crates/adom-core` porta **18
módulos** extraídos de `src/utils/*.ts` (a base commitada; o `lib.rs` da árvore
declara 20 — os dois extras estão no §3.1), todos **função pura** (texto/objeto →
valor), cobertos por **18 goldens** e um teste por golden. Os 18 goldens cobrem
17 dos 18 módulos: `js_text` não tem golden (é helper interno de semântica de
texto do JS) e `latin_table` é verificada pelo golden `matching-latin-ranges`,
compartilhado com `matching_tokens`.

Ordem do porte (commits da branch `rust`, mais antigo → mais recente), com a API
pública de [`lib.rs`](../rust/crates/adom-core/src/lib.rs):

| # | Módulo Rust | API pública | Fonte TS | Golden (`rust/golden/`) | Casos |
| --- | --- | --- | --- | --- | --- |
| 1 | `title_normalization` | `normalize_title` | `title-normalization.ts` | `title-normalization` | 173 |
| 2 | `matching_vocabulary` | `title_tokens` | `matching-vocabulary.ts` | `matching-vocabulary-title-tokens` | 203 |
| 3 | `matching_vocabulary` | `vocabulary_contents` | idem (constantes `PACK_WORDS`, `TECH_NOISE`, …) | `matching-vocabulary-sets` | 13 |
| 4 | `matching_vocabulary` | `year_range_test`, `episode_token_test` | idem (`YEAR_RANGE`, `EPISODE_TOKEN`) | `matching-vocabulary-regex` | 246 |
| 5 | `matching_tokens` | `extract_sequence_markers`, `episode_work_tokens`, `first_work_token`, `is_non_naming_token`, `Marker` | `matching-tokens.ts` | `matching-tokens-text` | 243 |
| 6 | `matching_tokens` + `latin_table` | `is_non_latin_token` (linha única com as faixas latinas; a varredura do Unicode é feita no teste) | idem | `matching-latin-ranges` | 1 |
| 7 | `matching_decisions` | `title_precision`, `year_contradicts`, `named_sequel_contradicts`, `live_action_year_contradicts`, `adaptation_identity_contradicts`, `first_significant_token` | idem | `matching-tokens-decisions` | 50 |
| 8 | `matching_tokens` | `first_unmarked_token` (campo `unm` do mesmo golden) | idem | `matching-tokens-text` | — |
| 9 | `short_name_tail` | `short_name_tail_contradicts` | `short-name-tail.ts` | `short-name-tail` | 15 |
| 10 | `catalog_year` | `catalog_year_of`, `catalog_alt_year_of` | `catalog-year.ts` | `catalog-year` | 14 |
| 11 | `br_origin` | `has_pt_signs`, `br_origin_mark` | `br-origin.ts` | `br-origin` | 439 |
| 12 | `magnet_uri` + `info_hash` | `sanitize_magnet`, `default_magnet`, `extract_info_hash` | `magnet-uri.ts` (`extractInfoHash` vem de `title-normalization.ts`) | `magnet-uri` (`op: info/sanitize/default`) | 46 |
| 13 | `franchise` | `franchise_base_contradicts`, `franchise_extension_contradicts`, `name_coverage_tokens`, `is_multi_work_collection` | `franchise-base.ts` (+ helpers de `release-name-matching.ts`) | `franchise` | 415 |
| 14 | `episode_parse` | `parse_title_season_episode`, `season_coverage_excludes`, `ParsedSeasonEpisode` | `episode-matching.ts` | `episode-parse` | 887 |
| 15 | `multiwork_pack` | `admits_multi_work_pack`, `collection_root`, `collection_root_tokens`, `covers_year`, `pack_year_source` | `multiwork-pack.ts` | `multiwork-pack` | 264 |
| 16 | `stream_quotas` | `limit_by_indexer` | `stream-quotas.ts` | `stream-quotas` | 87 |
| 17 | `release_work` | `episode_parse_specificity`, `choose_episode_parse`, `route_work_location`, `release_fits_request`, `release_work_targets`, `WorkTarget` | `release-work.ts` | `release-work` | 72 |
| 18 | `release_title_rules` | `matches_title_structure`, `short_name_identity`, `matches_short_name_identity`, `ShortNameIdentity` | `release-title-rules.ts` | `release-title-rules` | 63 |
| 19 | `release_name_matching` | `matches_name`, `franchise_root`, `franchise_roots`, `ends_with_sequence_marker`, `contains_token_run` | `release-name-matching.ts` | `release-name-matching` | 434 |

As linhas 5 e 8 são o mesmo golden (`matching-tokens-text`), contado uma vez; a
linha 6 tem golden próprio. **Total: 18 goldens portados,
3665 casos** (com `resolve-sign`, 24 casos, são 19 goldens / 3689 casos no
diretório). `release_name_matching` absorveu `franchise_root` e
`contains_token_run`, que `multiwork_pack` tinha como cópias privadas (`ec850cf`).
Esses números são **do artefato** — não são meta nem prova de fase concluída; não
extrapolar para declarar "Fase 0/1 concluída".

Como reproduzir: `cd rust; cargo test -p adom-core`. Na presente revisão a suíte
inteira passa — **21 binários de teste (20 de golden + `unicode_parity.rs`), 106
testes, 0 falhas** — inclusive os dois alvos que ainda não têm commit, listados em
§3.1. Os 18 goldens do quadro acima são os **commitados**.

### 3.1 Portes em andamento na árvore (sem commit)

Dois portes estão na árvore de trabalho **sem `git add`** — verdes hoje, mas não
registrados, então não entram no quadro do §3 (a ponte NAPI, no fim, também é da
árvore e não é porte):

- **`resolve-sign`** — `src/resolve_sign.rs` + `tests/resolve_sign_golden.rs`, com
  `mod resolve_sign;` e `pub use resolve_sign::{sign_resolve, verify_resolve}` já
  escritos em `lib.rs`, e as deps `hmac`/`sha2`/`subtle` já em
  `crates/adom-core/Cargo.toml` (arquivos modificados). O golden (24 casos) bate
  com o `dist` (§2). Enquanto não houver commit, o §1 continua sendo **contrato
  alvo**, não porte.
- **`matches-br-title`** — `src/matches_br_title.rs` +
  `tests/matches_br_title_golden.rs`, `pub use matches_br_title::matches_br_title`
  em `lib.rs`, e `rust/golden/matches-br-title.jsonl` + manifest (50 casos,
  `registry: matches-br-title/matchesBrTitle`). **Este golden não tem oráculo**:
  o próprio
  [`scripts/golden/registry-matches-br-title.mjs`](../scripts/golden/registry-matches-br-title.mjs)
  declara que foi "gerado manualmente (corpus + JSONL) porque o dist não estava
  disponível", com os esperados traçados de
  [`test/br-title.test.ts`](../test/br-title.test.ts) e
  `test/br-title-edition.test.ts`; o comando de regeneração que o arquivo sugere
  (`--fn matches-br-title`) **não existe** no gerador (§2).
- `rust/crates/adom-napi/` — crate **sem `git add`**, mas com `rust/Cargo.toml`
  **já modificado** para incluí-lo em `members`, e o lock atualizado. Expõe
  `normalize_title`, `sign_resolve` e `verify_resolve` por NAPI-RS;
  `cargo check -p adom-napi` passa na árvore. Ele **reimplementa o HMAC** em vez
  de delegar ao `adom-core`, não tem nenhum teste próprio (só `src/lib.rs` e
  `build.rs`), e o comentário do workspace em `rust/Cargo.toml` ainda afirma que
  "só existe o crate `adom-core`" — defasado.

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

Novos, do estado atual da migração:

- **Porte ≠ adoção**: nenhuma das funções portadas substitui caminho TS em
  runtime; o que segura regressão é o `--check` do oráculo, manualmente. Nada
  obriga o `dist` a continuar batendo depois que o `src/` mudar — um `--fn`
  esquecido deixa golden e fonte desalinhados sem nenhum teste gritando.
- **Dois HMAC no mesmo repositório**: `adom-core::resolve_sign` (WIP) e
  `adom-napi::sign_resolve`/`verify_resolve` implementam o contrato separadamente.
  São duas definições a manter iguais; o napi já **estreitou `sig` para
  `String`**, enquanto o TS aceita `unknown` e devolve `false` para não-string —
  diferença latente que só aparece quando o `src/` começar a consumir o binding.
- **Verde sem commit ≠ portado**: `resolve_sign_golden` e
  `matches_br_title_golden` passam na árvore atual, mas nenhum dos dois existe em
  `HEAD`. A árvore é compartilhada com portes paralelos e muda enquanto se
  documenta: qualquer afirmação de estado precisa ser refeita (`git status` +
  `cargo test`) antes de ser citada.
- **`matches-br-title` sem oráculo**: é o único golden do diretório cujo
  `expected` não veio do `dist` vivo — veio de testes TS, e não tem `--check`.
  Ele prova paridade com o comportamento *testado*, não com o comportamento
  *executado*: se o TS divergir dos próprios testes, o golden continua "batendo".
  Registrar a chave no gerador unificado (ou criar dumper próprio) e regenerar
  contra o `dist` antes de contar essa fatia como portada.
- **§3 não significa "arquivo migrado"**: os arquivos parcialmente portados
  têm funções deixadas de propósito fora (dependem de `config`, de módulo ainda
  não portado, ou de I/O). A lista do que falta está no §5.
- **Cobertura de checker Node desigual**: só `title-normalization` tem teste
  permanente no `test/`; os outros 19 oráculos com `dist` dependem de `--check`
  chamado à mão (18 via `--fn`, 1 via `golden:resolve-sign:check`) e
  `matches-br-title` não tem nenhum (§3.1).
- **`matching-latin-ranges` tem 1 caso**: a comparação com o JS é feita pelo
  teste Rust varrendo o Unicode contra a linha única do golden; não há corpus
  por codepoint, logo o `--check` desse golden cobre formato/hash, não
  comportamento ponto a ponto.
- **`adom-napi` entra no build sem teste**: o crate virou member do workspace na
  árvore (`members = ["crates/adom-core", "crates/adom-napi"]`, sem commit) e
  `cargo check` passa, mas **não há nenhum `tests/` nele** — a compilação é o
  único ateste. Os exemplos de doc (`import { normalizeTitle } from
  '../rust/adom-napi/index.js'`) descrevem um consumo que ainda não existe em
  `src/`. O comentário do `rust/Cargo.toml` ficou descrevendo a fatia antiga.

## 5. Contratos PENDENTES

Núcleo planejado no mega-plano — **nada disso foi portado**, e nada foi lido no
fonte como contrato:

- config base64url (segmento de URL) e `secret-box` (selo da `dk`);
- `DDL4` (nome conforme mega-plano; escopo a confirmar);
- namespace de cache + quotas (`cache-keys.ts`/`cache-quotas.ts`);
- contrato de env / HTTP / test mocks.

Restos dos arquivos já iniciados em §3 (portados, **incompletos** — entram como
pendência, cada um com fonte lido quando a etapa dele for autorizada):

- `src/utils/sign.ts` → `resolve_sign` e o binding NAPI: em andamento na árvore,
  sem commit (§3.1);
- `title-normalization.ts`: `decodeEntities`, `collapseAcronyms`,
  `stripDiacritics`, `dedupeNames`, `magnetDisplayName`, `bytesToSize` (foram só
  `normalizeTitle` e `extractInfoHash`);
- `release-title-rules.ts`: `matchesEpisodeWorkIdentity` e
  `matchesGlobalSeriesNoMarker`, que leem `config.search.titlePrecisionTailCut`;
  `matchesBrTitle` tem porte em andamento na árvore (sem commit, golden sem
  oráculo — §3.1), que recebe `cut_tail` como parâmetro em vez de ler config, e
  embute os pisos `TITLE_PRECISION_MIN` (0.70 com cut, 0.65 sem) e
  `SERIES_TITLE_PRECISION_MIN` (0.70) em vez de expô-los como constantes;
- `episode-matching.ts`: `matchesEpisode`, `isSeasonPackRelease`,
  `isSeasonPackFillEligible`;
- `stream-quotas.ts`: `streamQuality`, `selectQualityCandidates`, `limitByQuality`,
  `limitByQualityAndIndexer`, `limitReservingBr`, `QUALITY_KEYS` (foi só
  `limitByIndexer`);
- `matching-vocabulary.ts`: as 13 constantes exportadas (`PACK_WORDS` …
  `STRONG_PACK_WORDS`, `EPISODE_TOKEN`, `YEAR_RANGE`) são verificadas **por
  conteúdo** (`vocabulary_contents`, `year_range_test`, `episode_token_test`); não
  há API pública que as exponha como conjuntos — quem portar consumo precisa
  primeiro decidir essa API.

Já cobertos por inteiro: `matching-tokens.ts` (12 exports, todos portados entre
`matching_tokens` e `matching_decisions`), `multiwork-pack.ts` (6 exports) e
`release-name-matching.ts` (7 exports).

Fora de `src/utils` — intocados: providers, rotas (`resolve.ts`,
`addon-router.ts`), cache/DB, debrid, crawl e o contrato de env/HTTP/mocks.
