# Índice de releases e banco de magnets nativos (F4.5)

Este documento fixa o contrato do **índice** (`idx:v14` no `cache.db`) e do
**banco de magnets vivo** (`data/magnets.db`) lidos/escritos pelo orquestrador
nativo (`adom-search`), atrás de `INDEX_RUST`/`BANK_RUST`. É o pré-requisito do
corte do `/stream`: sem ele, `POST /internal/search/index` e
`/internal/search/fallback` continuam sendo o caminho do Node para a resposta
rápida, a reserva 📦 e a escrita do índice. **No F4.4 os dois viraram default
`on`** — o caminho Node é o rollback por env.

## Flags e rollback

| Env | Valores | Default | O que faz |
|---|---|---|---|
| `INDEX_RUST` | `off` / `shadow` / `on` (ou `1/true/yes`) | **on** (F4.4) | `on`: o nativo lê `idx:v14`, decide cobertura/instantânea, escreve o índice e emite o follow-up. `shadow`: Node responde; o nativo recomputa em fundo e compara. `off`: rota interna do Node. |
| `BANK_RUST` | `off` / `shadow` / `on` | **on** (F4.4) | `on`: o nativo lê o `magnets.db` (instantânea + reserva 📦) e grava `passed_filter` na escrita do índice. `shadow`: Node responde e o nativo compara. `off`: rota interna do Node. |
| `INDEX_SHADOW_SAMPLE` | `0..=1` | `0.1` | Amostra determinística por IMDb id (FNV-1a). Fora da amostra conta só `index.shadow.not_sampled`. |

Rollback: `INDEX_RUST=off`/`BANK_RUST=off` (ou remover e deixar o default, que
agora é `on`) e reiniciar o gateway. As chaves e o schema SQLite são os do
Node, então um rollback vê o mesmo índice/banco que o nativo gravou — nada é
migrado.

Combinações:

- `INDEX_RUST=on` sem store injetado → caminho Node intacto + métrica
  `index.rust.source_missing` (degradação honesta).
- `BANK_RUST=on` sozinho → reserva 📦 nativa; a **instantânea** exige
  `INDEX_RUST=on` (é uma das saídas da leitura do índice).
- A marca de `passed_filter` na escrita exige os dois.
- `INDEX_RUST=shadow` compara instantânea/efeitos só com `BANK_RUST` nativo:
  sem o banco, o nativo não tem como reproduzir a foto nem a evidência BR do
  acervo, e a comparação seria divergência falsa (`index.shadow.skipped`).

## Contrato do índice (`cache.db`, namespace `idx`)

| Item | Valor |
|---|---|
| Chave | `idx:v14:<imdb>` (`…:S<n>`, `…:S<n>E<m>`) — `src/utils/release-index.ts` |
| Valor | `{at, partial, releases[]}` (TTL `RELEASE_INDEX_TTL`, default 30 d) |
| Release | `{hash,title,size,indexer,tracker?,isBr,dubbed,quality,seeders,seenAt,lied,source?,mediaSource?}` |
| Cota | `quota_for("idx")`; despejo do que expira primeiro, só dentro do namespace |
| Leitura | episódio → temporada → raiz, dedupe por hash com o `seenAt` mais recente |
| `partial` | qualquer das três chaves marcada bloqueia o fast-path do índice |
| Escrita | merge por hash (mais recente vence), roteamento por título/`dn=`, `isBr`/`dubbed`/`lied` OR-aderentes, `seeders` pelo máximo, corte protegido BR, `keepPartial` nunca rebaixa |

O JSON é campo a campo o do Node (`undefined` = campo ausente; `size:null`
quando desconhecido). A fonte de mídia (`mediaSource`) usa o núcleo
(`release_index_media`), que consulta o acervo em lote.

## Contrato do banco (`magnets.db`)

Schema idêntico ao `src/utils/magnet-bank-rows.ts` (`magnet`, `magnet_source`,
`magnet_work`; `season`/`episode` = -1 para nulo).

- Leitura da obra: `worksForObraMany` (por alvo, `passed_filter DESC,
  last_seen DESC`, `LIMIT` por alvo, texto integral via `magnet` em lote);
  `sourcesForMany` em chunks de 200.
- Extração de hash: `hashOf` (`infoHash`, `magnet`, `MagnetUri`, `Guid`, o
  primeiro válido).
- Escrita: `markBankFilterOutcome` grava `passed_filter` (1/0) e `last_seen` nas
  linhas que JÁ existem, por hash e por alvo (obra do pedido + packs que o
  título declara). Fonte sem captura não cria órfão.
- **Captura (`captureItems`) continua no Node.** Quem alimenta o acervo é a
  coleta viva (`/internal/search/collect`); coletores nativos
  (`SOURCES_RUST=jackett|…`) ainda não capturam.

## O que o nativo serve

Ordem e marcas são as de `search-index-path.ts`:

1. **instantânea** (`BANK_RUST=on`): janela adaptativa
   (`instantWindow`, núcleo) → seleção (`adom_core::select_instant`) →
   `filterRelevantRaw` → cobertura (`idxPoolCovered`). Itens do acervo saem com
   `fromFallback` (📦/~N) e `fallbackFetchable` quando `passed_filter=1` ou a
   fonte é index-only. Resposta = acervo + índice + conta.
2. **índice coberto**: releases do índice com `fromSnapshot` (a foto também
   exibe 📦 até a promoção tardia) + conta. Na via NÃO-instantânea a marca é
   neutralizada, como o `idxReleasesToRaw` do Node.
3. **conta** (`ACCOUNT_RUST=on`/`shadow`): `account.search` equivalente, com o
   teto `ACCOUNT_FAST_WAIT_MS` (default 450 ms). Sem fonte nativa, a conta fica
   de fora do caminho nativo (documentado; o Node continua sendo a fonte da F3
   quando `ACCOUNT_RUST=off`).
4. **reserva 📦** (`BANK_RUST=on`): `collectFallbackForBuild` sem HTTP, com as
   mesmas linhas, tetos e `allowedSourceIndexer` do pedido. Vivo vence sempre.

## Efeitos do índice

`enqueueIndexFollowUp` foi portado para `adom-search::orchestrator::index_effects`
e é emitido por `POST /internal/search/effects` (202, fire-and-forget) em toda
busca com `INDEX_RUST=on`:

- `harvester_enqueue` com `reason` `miss` (índice vazio), `gap` (não cobre ou
  parcial) e `br-gap` (sonda inelegível);
- `br_probe` com `mode` `evidence`/`upgrade` quando cobre o pool mas falta BR
  dublado — portão de plausibilidade: evidência BR no índice OU no acervo
  (`bankHasBrRow`); sem nenhuma, nada é emitido (`no-evidence`).

As regras puras de BR-gap vivem em `adom_core::br_gap` (portadas de
`utils/br-gap.ts`). O handler do Node passou a honrar `fallbackBrGap` da sonda:
sonda inelegível enfileira a obra no colhedor com motivo `br-gap`, a mesma rede
do TS. `EFFECTS_RUST` continua dono dos efeitos do pipeline de debrid; o
follow-up do índice NÃO depende dele (era papel da rota de leitura).

## Sombra e métricas

`/metrics` do gateway expõe:

- `index.rust.lookup/hit/partial/miss/gap/served/recorded/record.failed/
  bank_marked/instant/instant.skip.*/br_gap*/effects/source_missing`;
- `index.shadow.compared/divergence/index_missing/index_extra/instant_missing/
  instant_extra/order/coverage/partial/instant_eligible/account/effects/
  not_sampled/skipped/error`;
- `bank.shadow.compared/divergence/items_missing/items_extra/not_sampled`.

A sombra roda em `tokio::spawn` depois da resposta do Node, nunca segura o
cliente e nunca grava. A comparação cobre conjunto, ordem, cobertura, `partial`,
instantânea elegível, itens da conta e o plano de efeitos.

## Fora deste recorte (honesto)

- **Prova de arquivo** (`applyFileEvidence`: `provenAudio`/`provenQuality`/
  `provenName`) não é anexada pelo caminho nativo do índice: o orquestrador não
  tem o memo `fsz`/`tsz` (o `with_files_by_hash` de produção é vazio). O Node
  continua anexando quando a rota dele responde.
- **Captura** do acervo (ver acima).
- **Histórico ruim da conta** (`pruneKnownBroken`: `mag` bad/lie/dead/miss) não
  é consultado pela reserva nativa: a rota do Node corta esses hashes antes da
  checagem. A reserva nativa ainda os apresenta (o build/play decide depois).
- **Cota do índice**: o despejo nativo é do que expira primeiro (mesma régua dos
  stores do gateway); o `cache.set` do Node despeja o LRU mais antigo. Sob
  pressão de cota (4.000 chaves), o conjunto exato retido pode divergir.
- **L1 do Node × escrita nativa**: o `cache.ts` mantém um L1 em memória com
  escrita síncrona para o SQLite. A escrita nativa chega ao disco, mas uma
  entrada `idx` já lida pelo processo Node pode continuar em memória até o TTL
  (30 d) ou a evicção por cota. No corte, as leituras de índice do Node ficam
  restritas a colhedor/autofetch/sonda; a busca do `/stream` lê o disco. É a
  mesma convivência aceita por `meta:`/`raw:v1` (rollback = reiniciar o Node).
  O caminho inverso não perde: o Node grava com `persist` síncrono e o Rust lê
  o arquivo.
- **Métricas `search.idx.*`** do Node não são replicadas: o nativo tem os
  contadores `index.rust.*`/`bank.shadow.*` no `/metrics` do gateway.
- **Manutenção do índice** que não é leitura/gravação de lote: `clearPartial`,
  `markLied`, `markMissing`/`markMissingSeason`, `forgetAutofetchHash`,
  `snapshotWorks`/`snapshotAllWorks` seguem no Node (usados por colhedor,
  play e catálogo).
- **Config de painel** (`autofetchLive.effective()`, tetos editados em runtime):
  o nativo lê o `.env` no boot; divergência possível até reiniciar. Os números
  são os mesmos defaults do Node.
- **Trace/ledger** da busca não é preenchido pelo caminho nativo do índice (a
  rota Node também não o preenche hoje).
- `INDEX_RUST=on` com `release_index_ttl=0`/`RELEASE_INDEX=false` não lê nem
  escreve (mesma régua do `enabled()` do TS).

## Testes

- `adom-core`: `br_gap`, `release_index_cut`, `instant_bank` (seleção,
  dublado, tetos, dedupe, rótulo BR velho).
- `adom-store`: leitura/escrita no formato do Node, reabertura/restart,
  roteamento, `partial`/`keepPartial`, corte protegido, fonte de mídia por
  hash; `magnets.db` (ordem, filtro por indexer, `mark_filter_outcome` só em
  linha existente, pack declarado, `hasBrRow`, restart).
- `adom-search`: follow-up (miss/gap/br-gap/sonda), instântanea (janela,
  filtro, cobertura, marcas), `fast_path` (snapshot limpo), filtro de provider,
  `partial`, série (episódio/pack/raiz), sombra (comparadores).
- Node: `test/internal-search-index.test.ts` (`effects` no corpo),
  `test/internal-search-effects.test.ts` (`br_probe` inelegível → `br-gap`,
  agendado não duplica).

## F3.1a — provas laterais do `idx:v14` no adom-store (Node inalterado)

Portadas para `adom-store` (`release_index_prova.rs`), com as mesmas chaves e o
mesmo JSON do Node: `markMissing`/`markMissingSeason`/`isMissing` (chaves
`idx:v14:miss:…` e `missS:…`), `markFileEvidence`/`fileEvidence` (`file:<hash>`),
`markLied`, `clearPartial`, `forgetAutofetchHash` e as leituras por varredura
`snapshotWorks`/`snapshotAllWorks`.

Diferenças conscientes:
- o Node regrava com o TTL restante arredondado em segundos; o Rust mantém o
  `expires_at` da linha (o instante de expiração não anda);
- `isMissing`/`isMissingQuiet` viram uma função só (o Rust não promove LRU);
- as métricas `search.idx.*` continuam no Node.

Ainda no Node: as chamadas, a F3.1b (leitura por rota) e a F3.1c (o Node para de
gravar `idx:`). Nada deste recorte é usado pelo caminho do `/stream` ainda.

## F3.1 — o Node usa o IdxStore (dono único do `idx:v14`)

O Node não grava mais o `idx:` no L1 nem no SQLite: `release-index.ts` é uma
fachada sobre o `IdxStore` (`release-index-store.ts`, síncrono, via napi). O
boot não carrega nem apaga linhas `idx` (`cache-db.ts`); `cache.clear()` e
`clearNamespace('idx')` chamam o Rust. `status().entries` vem da contagem do Rust.

Perdas conscientes:
- `search.idx.routed` e `search.idx.protCap` deixaram de contar: a decisão de
  roteamento e de corte protegido agora é do Rust, que não emite métricas.
- O rollback `INDEX_OWNER=node` do plano NÃO foi implementado: manter o caminho
  antigo exigiria dois escritores. Reverter = commit/imagem anterior.
- O TTL restante não é mais asserido no TS (o Rust mantém `expires_at`).

Diagnóstico: `idxHasKey(key)` (exata, para testes de roteamento) e o napi `hasKey`.
