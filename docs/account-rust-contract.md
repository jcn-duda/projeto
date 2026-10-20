# Contrato do inventário nativo da conta (F3)

Estado: **implementado e default ON desde o F4.4** (`ACCOUNT_RUST` ausente =
`on`; `shadow` compara, `off` volta à tarefa Node da conta). Nada mais no
caminho Node depende desta flag: com `off`, o orquestrador pede a conta pela
rota interna `/internal/search/collect`; rollback é desligar a env e reiniciar
o processo (nenhum estado persistido é criado por esta fatia).

Escopo desta fatia: o inventário da conta como **fonte da busca** (o que
sustenta a "conta-como-fonte" e o fast-path do `collectRaw`) e o veredito
`known`/`unusable` da leitura. **Não** entram aqui autenticação, enqueue,
autofetch, hold/proteção, limpeza, `davail`, banco de magnets nem o índice —
continuam no Node (lista fechada no fim deste documento).

## 1. O contrato mapeado (Node, hoje)

### 1.1 `account.ts:72-148` — a conta como fonte

`search(matchContext, trace)`:

1. `debrid.inventory()` com teto **próprio** (`DEBRID_INVENTORY_TIMEOUT_MS`,
   default 1500 ms) — estourou, devolve `[]` e a próxima busca pega o memo;
2. `audioSignalsMany(titles)` — UMA travessia do núcleo devolvendo as quatro
   sondas por título:
   - `ptAudio` (`looksPtBr`) → vira `isBr` **antes** do filtro;
   - `explicitForeign` (`hasExplicitForeignAudio`) → lista MÍNIMA, dos caminhos
     destrutivos;
   - `legendado` (`audioFromTitle(title) === 'Legendado'`) → não ocupa vaga de
     reserva;
   - `brOrigin` (`brOriginMark`) → origem BR **pelo nome** (8.4);
3. `brOriginOnly = brOrigin && !ptAudio && !explicitForeign && !legendado` —
   origem BR não prova áudio: dá vaga reservada (`_br`), NUNCA `_dubbed`;
4. `filterInventoryRelevant(raw, matchContext, onRejected)` — o filtro
   ESTRITO dos indexers **mais** a exceção de pack multiobra da mesma franquia
   (a conta é escolha já paga, não palpite de tracker). Motivos mapeados para
   trace: `account-title`, `account-magnet-year`, `account-named-sequel`,
   `identity`, `account-episode`, `account-series-work`,
   `account-movie-is-series`, `account-series-is-movie`, `pre-home-release`,
   `non-feature`;
5. item devolvido: `{ title, infoHash, seeders: 1, size, tracker: label,
   indexer: 'debrid', isBr: isBr || brOriginOnly, brOriginOnly, fromAccount:
   true }`. `seeders: 1` é o valor neutro das fontes BR (0 morreria no piso de
   seeders antes de virar stream).

Métricas Node (continuam lá no modo `off`): `search.account.read/readItems/
empty/items/allFiltered/error/sufficient`.

### 1.2 `inventory` por serviço (`src/debrid/`)

| Serviço | Endpoint | "Pronto" | Título | Tamanho |
|---|---|---|---|---|
| AllDebrid | `GET /magnet/status` | `ready` ou `status` Ready (case-insensitive) | `filename` | `size` |
| TorBox | `GET /torrents/mylist` | `download_finished \|\| download_present` | `name` | `size` |
| Real-Debrid | `GET /torrents` paginado | `status === 'downloaded'` (exato) | `filename` | `bytes` |
| Debrid-Link | `GET /seedbox/list` | `Number(downloadPercent) < 100` descarta (ausente = NaN **não** descarta) | `name` | `totalSize \|\| size` |
| Premiumize | — | sem inventário no TS (no-op) | — | — |

Todos: hash em lower-case, título com `trim`, descarta hash/título vazio e
título que É o próprio hash (magnet sem metadado).

### 1.3 Memo `dinv:` e caches vizinhos

- `dinv:<adapter>:<accountScope>` — inventário PRONTO, TTL
  `DEBRID_INVENTORY_TTL` (300 s), escopo por conta (`accountScope` = sha256 da
  chave). Falha **não** é cacheada. `inventoryPeek` é leitura síncrona sem
  rede (usada pelo índice e pelo painel); `note`/`forget` são upsert/remoção
  **só com memo quente** (play/autofetch/delete).
- `davail:<adapter>:<conta>:<hash>` — ⚡ por hash/conta (positivo 900 s,
  negativo curto). Fica no Node; o inventário nativo não grava nem lê.
- `adsub:v1` (posse durável AllDebrid), `adrm:v1` (anti-reenchimento),
  `adprot:v1` (retenção BR) — hold/proteção/limpeza. Ficam no Node.
- Real-Debrid: `inventory()` também faz `rdLedger.noteHit(readyHashes)`
  (`rdc:v2`); AllDebrid: o inventário alimenta `preexisting`/`knownBefore` da
  limpeza. Os dois são EFEITOS e ficam no Node.

### 1.4 Fast-path da conta (`collectRaw`)

`accountFastPath = { enabled: ACCOUNT_FAST_PATH (default true), minReleases:
ACCOUNT_FAST_MIN_RELEASES (2), waitMs: ACCOUNT_FAST_WAIT_MS (450) }`.

No `collectWithinWindow`, `stopWhen`:

- só o lote com `meta.source === 'account'` decide;
- `batch.length >= minReleases`;
- com `opts().preferDubbed`, o lote precisa cobrir dublado
  (`poolCovered(batch, { season, requireDubbed: true })`);
- disparando, a resposta sai **parcial** (`cacheMaxAge: 0`) e a coleta segue
  em fundo; o passe tardio promove a lista completa.

`readOnly` (sombra de fonte) desliga a conta: `accountSource = !readOnly && …`.
Ela também exige `DEBRID_INVENTORY_SOURCE` e `debrid.current()` (serviço +
chave).

### 1.5 Consumidores

- **F4.1b / build**: item `fromAccount` **pula o filtro de título** do build
  (`list_builder`), porque já passou pelo filtro DELE (estrito + franquia).
  Por isso o filtro é parte do contrato da fonte, não do build.
- **Índice/instantânea**: `search-index-path.ts` anexa `accountItems` via
  `debrid.inventoryPeek` — ainda Node (F4.5).
- **Autofetch/Chupim**: usa `status` da conta, `protected.ts`, `davail` e o
  banco de magnets; não lê `dinv` diretamente. Continua Node.
- **Painel/`/debrid-status.json`**: `accountStatus`, ocupação, saúde — Node.

## 2. O que o Rust implementa (flags OFF)

### 2.1 `adom-debrid::account` — leitura pura

`fetch_inventory(service, api_key, InventoryOpts) -> Result<AccountInventory,
String>`:

- `AccountInventory { items: Vec<InventoryItem { title, info_hash, size, id }>,
  known: bool, unusable: Option<(UnusableKind, String)> }`;
- `known: true` = o serviço respondeu (lista vazia é RESPOSTA);
  `known: false` = rede/prazo/rate limit (nunca "vazio");
- `unusable` = só `auth`/`quota` (mesma taxonomia do `verdict`/`common.ts`,
  inclusive upgrade de mensagem crua de Debrid-Link);
- serviço conhecido sem inventário (Premiumize) → vazio `known: true`;
  serviço desconhecido → `Err` (o chamador cai na reserva Node);
- teto de itens (`DEBRID_INVENTORY_MAX`) e timeout total por `tokio::time::
  timeout` (`DEBRID_INVENTORY_TIMEOUT_MS`);
- nenhum log de chave/título/corpo; nenhuma escrita.

Fixtures cobertas em `account_tests.rs` (servidor axum em loopback):
vazio, parcial (só prontos, hash-título descartado), auth, quota, transitório
(500), prazo curto, TorBox, Real-Debrid (id preservado), Debrid-Link
(`downloadPercent` ausente conta como pronto), teto de itens.

### 2.2 `adom-search::orchestrator::account` — fonte, filtro e fast-path

- `NativeAccountSource`: HTTP do `adom-debrid` + memo **em processo**
  (chave `serviço:accountScope`, TTL `DEBRID_INVENTORY_TTL`, teto de 64 contas,
  erro nunca cacheado). O namespace `dinv` **não** é tocado — o store Rust não
  é dono dele. O Node dedupa a leitura EM VOO por conta; aqui buscas idênticas
  já são coalescidas pelo `InFlight` do orquestrador, mas buscas diferentes da
  mesma conta podem ler em paralelo (divergência conhecida, sem efeito na
  lista).
- `signals_of`/`br_origin_only`: as quatro sondas do `audioSignalsMany` com as
  funções do núcleo (`audio_signals`, `has_explicit_foreign_audio`,
  `br_origin_mark`); a composição é a do `account.ts`.
- `account_raw_items`: `filter_inventory_relevant` do núcleo com
  `RelevanceQuery` (names, year, altYear, isSeries, **season/episode**,
  multiWorkRoot, `homeReleaseAt: None` — o `matchContext` do Node também não
  leva esse campo) e o shape exato do item (seeders 1, tracker = label,
  indexer `debrid`, `fromAccount`, `isBr`, `brOriginOnly`).
- `fast_path_decision`: réplica do `stopWhen` (`NotAccount`/`TooFew`/
  `NotCovered`/`Covered`) com `pool_covered` do núcleo.
- `sampled`: amostra determinística por obra (FNV-1a 64, % 10.000) — a mesma
  obra não oscila entre amostrada/não amostrada.
- Integração no `collect_scoped` (`search.rs`): a tarefa da conta deixa de ser
  um `routes.collect(...)` no modo `on` e passa a ser a fonte nativa; o
  fast-path vira `stop_when` da janela.

### 2.3 Sombra (`ACCOUNT_RUST=shadow`)

- O Node responde (tarefa de sempre); o nativo roda em fundo;
- a referência Node é o **próprio lote da tarefa primária** entregue por
  `oneshot` — nenhuma segunda chamada à rota e nenhum bloqueio do cliente;
- compara o lote **depois do filtro** (a mesma unidade que o build consome):
  diferença simétrica de hashes + contagem;
- amostragem determinística (`ACCOUNT_SHADOW_SAMPLE`, default 0.1); fora da
  amostra só conta `account.shadow.not_sampled`, sem leitura nativa;
- `known:false`/`unusable` → `skipped` (não é divergência de fonte);
  erro/timeout → `error`/`timeout`, nunca `divergence`.

Métricas em `/metrics` (namespace próprio, sem colidir com `search.account.*`
do Node): `account.rust.fetch/items/empty/known/unusable_auth/unusable_quota/
unknown/memo_hit/source_missing`, `account.node`, `account.fast_path`,
`account.fast_path.skipped`, `account.shadow.compared/divergence/
items_missing/items_extra/not_sampled/skipped/timeout/error`.

## 3. Flags e rollback

| Env | Default | Efeito |
|---|---|---|
| `ACCOUNT_RUST` | ausente = `on` (F4.4) | `off` = Node (rota interna de collect); `shadow` = Node + comparação; `on` = nativo responde a conta |
| `ACCOUNT_SHADOW_SAMPLE` | `0.1` | fração 0..=1 amostrada (determinística por IMDb) |
| `ACCOUNT_SHADOW_TIMEOUT_MS` | `2500` | teto da leitura nativa na sombra |
| `DEBRID_INVENTORY_SOURCE` | `true` | desligado, a conta não é fonte (nem nativo nem sombra) |
| `DEBRID_INVENTORY_TTL` | `300` | TTL do memo nativo (s) |
| `DEBRID_INVENTORY_MAX` | `3000` | teto de itens |
| `DEBRID_INVENTORY_TIMEOUT_MS` | `1500` | teto da leitura como fonte |
| `ACCOUNT_FAST_PATH` | `true` | fast-path da conta (só no modo `on`) |
| `ACCOUNT_FAST_MIN_RELEASES` | `2` | mínimo de releases do lote |
| `DEBRID_AUTO_FETCH_MIN_SEEDERS` | `3` | piso de seeders do `poolCovered` do fast-path (o Node usa `autoFetchMinSeeders`, não o `MIN_SEEDERS` do build) |

**Rollback:** `ACCOUNT_RUST=off` (ou remover) + reiniciar; o gateway volta a
pedir a conta ao Node na próxima busca. Nenhum arquivo/estado novo é criado
(o memo é memória do processo). O corte nativo (`ROUTES_RUST=stream`) não é
necessário para testar: `stream-shadow` já monta o orquestrador.

## 4. O que fica Node-only (por desenho)

- **auth/credencial**: a chave chega no `encoded` e é usada só no adaptador;
  `DEBRID_ALLOW_ENV_KEY`/conta do operador, seleção do serviço e fallback de
  chave do `.env` continuam no Node.
- **enqueue/autofetch (Chupim)**: `br-probe`, hold, fila persistente, marker
  pós-aceite, recheck, evicção e `DEBRID_RESOLVE_UNCACHED` — Node.
- **hold/proteção/limpeza**: `protected.ts`, `adsub/adrm/adprot`,
  `dropUncached`/`dropReady`, `sweepDead`/`sweepUndubbed`, reconcile,
  revalidate — Node (o inventário nativo NÃO apaga nada).
- **`davail`** (⚡ por hash/conta), **banco de magnets vivo** (`magnets.db`),
  **cache `raw:v1`/`idx:v14`**, **`dinv` persistido**: Node.
- **Real-Debrid `noteHit`** no ledger `rdc:v2` e **AllDebrid `preexisting`/
  `knownBefore`**: efeitos do inventário Node; o nativo não os reproduz.
- **índice/instantânea**: `accountItems` do `search-index-path.ts` ainda vêm
  de `debrid.inventoryPeek` (Node) — F4.5.
- **status/painel**: `accountStatus`, ocupação, saúde e caches de painel.
- **play/`/resolve`**: o `id` do torrent (Real-Debrid) é preservado no
  `InventoryItem`, mas não viaja no `RawItem`; a resolução continua no Node,
  que lista/lembra a conta pelo próprio memo.
- **métricas** `search.account.*` (quando `off`, são as do Node).

## 5. Testes (sem Docker)

- `cargo test -p adom-debrid --lib account` — 16 testes (fixtures de
  inventário, `known`/`unusable`, teto, prazo).
- `cargo test -p adom-search --lib account` — 25 testes (sondas, filtro por
  obra e por episódio, shape do item, fast-path, amostragem, modo, memo,
  integração `collect_scoped` com e sem tarefa Node, sombra).
- Gates: `cargo test -p adom-debrid -p adom-sources -p adom-search
  -p adom-server -p adom-store`, `cargo test -p adom-parity`,
  `npm run parity:frozen` (16/16) e `cargo run -p adom-parity -- --replay`
  (51/51).
- `cargo fmt --check`/`cargo clippy` nos arquivos desta fatia.

## 6. Contratos que o Rust ainda não tem (F4.5)

1. **Índice**: o nativo não é dono do `idx:v14`/`accountItems`; a instantânea
   do índice continua no Node.
2. **Banco de magnets e `davail`**: não há store Rust no caminho da conta —
   sem `rdc:v2` `noteHit`, sem `dinv` persistido, sem `adsub/adrm/adprot`.
3. **`unusable` no build**: a conta nativa marca `unusable` só nas métricas e
   no skip do fast-path; o veredito que muda a lista continua sendo o do
   `checkCached` (`AdapterDebridCheck`), que já cobre auth/quota.
4. **Autofetch**: o Chupim continua lendo a conta pelo Node.
