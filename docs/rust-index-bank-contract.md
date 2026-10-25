# Índice de releases e banco de magnets nativos (F4.5)

Este documento fixa o contrato do **índice** (`idx:v14` no `cache.db`) e do
**banco de magnets vivo** (`data/magnets.db`) lidos/escritos pelo orquestrador
nativo (`adom-search`). O índice e o banco têm **dono único no Rust desde o R4**,
sem flag e sem rota Node de fallback: `POST /internal/search/index`,
`/internal/search/index-write` e `/internal/search/fallback` foram apagadas.
Falha ao abrir o `idx:v14`/`magnets.db` degrada sem índice (log `[search]`,
métrica `index.rust.source_missing`) e **não** cai no Node. Rollback = commit ou
imagem anterior.

## Sem flags; rollback por commit/imagem

Não há `INDEX_RUST`/`BANK_RUST` nem amostra de sombra: os caminhos são
**incondicionais desde o R4** e o rollback é **commit/imagem anterior**. As
chaves e o schema SQLite são os do Node, então a imagem anterior vê o mesmo
índice/banco que o nativo gravou — nada é migrado.

- Store ausente/inacessível → o nativo degrada **sem índice**: log `[search]` e
  métrica `index.rust.source_missing`; não existe caminho Node.
- A marca de `passed_filter` na escrita acompanha a escrita do índice (as duas
  são nativas).

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
- Escrita: `capture_items` (Rust) grava `magnet`, `magnet_source` e
  `magnet_work` numa transação, com CAS: `passed_filter` não regride e
  `last_seen` é `MAX`. O `/stream` chama do `late.rs` (`capture_native_bank`),
  antes dos efeitos; erro só loga, a resposta não espera o disco.
  `markFilterResult` (TS) segue para o colhedor/aquecimento e não cria órfão de
  fonte não-Jackett.
- A captura do `/stream` é **nativa**: a lista que a coleta ao vivo devolveu vai
  para o acervo pelo próprio orquestrador, sem passar por `/internal/*`.

## O que o nativo serve

Ordem e marcas são as de `search-index-path.ts`:

1. **instantânea**: janela adaptativa
   (`instantWindow`, núcleo) → seleção (`adom_core::select_instant`) →
   `filterRelevantRaw` → cobertura (`idxPoolCovered`). Itens do acervo saem com
   `fromFallback` (📦/~N) e `fallbackFetchable` quando `passed_filter=1` ou a
   fonte é index-only. Resposta = acervo + índice + conta.
2. **índice coberto**: releases do índice com `fromSnapshot` (a foto também
   exibe 📦 até a promoção tardia) + conta. Na via NÃO-instantânea a marca é
   neutralizada, como o `idxReleasesToRaw` do Node.
3. **conta**: `account.search` equivalente, com o
   teto `ACCOUNT_FAST_WAIT_MS` (default 450 ms). A conta é nativa e
   incondicional desde o R5 (gateway sem fonte nativa montada não sobe).
4. **reserva 📦**: `collectFallbackForBuild` sem HTTP, com as
   mesmas linhas, tetos e `allowedSourceIndexer` do pedido. Vivo vence sempre.

## Efeitos do índice

`enqueueIndexFollowUp` foi portado para `adom-search::orchestrator::index_effects`
e é emitido por `POST /internal/search/effects` (202, fire-and-forget) em toda
busca:

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

## Métricas

`/metrics` do gateway expõe:

- `index.rust.lookup/hit/partial/miss/gap/served/recorded/record.failed/
  bank_marked/instant/instant.skip.*/br_gap*/effects/source_missing`.

A sombra do índice/banco foi **removida no R1**: não há mais
`index.shadow.*`/`bank.shadow.*` nem comparação em `tokio::spawn`.

## Fora deste recorte (honesto)

- **Prova de arquivo** (`applyFileEvidence`: `provenAudio`/`provenQuality`/
  `provenName`) não é anexada pelo caminho nativo do índice: o orquestrador não
  tem o memo `fsz`/`tsz` (o `with_files_by_hash` de produção é vazio).
- **Captura** do acervo (ver acima).
- **Histórico ruim da conta** (`pruneKnownBroken`: `mag` bad/lie/dead/miss) não
  é consultado pela reserva nativa: o build/play decide depois.
- **Cota do índice**: o despejo nativo é do que expira primeiro (mesma régua dos
  stores do gateway); o `cache.set` do Node despeja o LRU mais antigo. Sob
  pressão de cota (4.000 chaves), o conjunto exato retido pode divergir.
- **L1 do Node × escrita nativa**: o `cache.ts` mantém um L1 em memória com
  escrita síncrona para o SQLite. A escrita nativa chega ao disco, mas uma
  entrada `idx` já lida pelo processo Node pode continuar em memória até o TTL
  (30 d) ou a evicção por cota. No corte, as leituras de índice do Node ficam
  restritas a colhedor/autofetch/sonda; a busca do `/stream` lê o disco. É a
  mesma convivência aceita por `meta:`/`raw:v1`.
  O caminho inverso não perde: o Node grava com `persist` síncrono e o Rust lê
  o arquivo.
- **Métricas `search.idx.*`** do Node não são replicadas: o nativo tem os
  contadores `index.rust.*` no `/metrics` do gateway.
- **Manutenção do índice** que não é leitura/gravação de lote: `clearPartial`,
  `markLied`, `markMissing`/`markMissingSeason`, `forgetAutofetchHash`,
  `snapshotWorks`/`snapshotAllWorks` seguem no Node (usados por colhedor,
  play e catálogo).
- **Config de painel** (`autofetchLive.effective()`, tetos editados em runtime):
  o nativo lê o `.env` no boot; divergência possível até reiniciar. Os números
  são os mesmos defaults do Node.
- **Trace/ledger** da busca não é preenchido pelo caminho nativo do índice.
- Com `release_index_ttl=0`/`RELEASE_INDEX=false` o índice não é lido nem
  escrito (mesma régua do `enabled()` do TS).

## Testes

- `adom-core`: `br_gap`, `release_index_cut`, `instant_bank` (seleção,
  dublado, tetos, dedupe, rótulo BR velho).
- `adom-store`: leitura/escrita no formato do Node, reabertura/restart,
  roteamento, `partial`/`keepPartial`, corte protegido, fonte de mídia por
  hash; `magnets.db` (ordem, filtro por indexer, `mark_filter_outcome` só em
  linha existente, pack declarado, `hasBrRow`, restart).
- `adom-search`: follow-up (miss/gap/br-gap/sonda), instântanea (janela,
  filtro, cobertura, marcas), `fast_path` (snapshot limpo), filtro de provider,
  `partial`, série (episódio/pack/raiz).
- Node: `test/internal-search-effects.test.ts` (`br_probe` inelegível →
  `br-gap`, agendado não duplica).

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

A F3.1 absorveu a F3.1b/F3.1c: o Node não grava mais `idx:` e a leitura da busca
é do orquestrador nativo; a rota interna foi apagada no R4.

## F3.1 — o Node usa o IdxStore (dono único do `idx:v14`)

O Node não grava mais o `idx:` no L1 nem no SQLite: `release-index.ts` é uma
fachada sobre o `IdxStore` (`release-index-store.ts`, síncrono, via napi). O
boot não carrega, não expira e não descarta versão velha de `idx` (`cache-db.ts`);
`cache.set`/`persist`/`forget` recusam o namespace; `cache.clear()` e
`clearNamespace('idx')` chamam o Rust. Prefixo morto (`idx:v13` etc.) some no
`open` do `adom-index`; expirado some na leitura e no `enforce_quota`.
`status().entries` vem do Rust.

Perdas conscientes:
- `search.idx.routed` e `search.idx.protCap` deixaram de contar: a decisão de
  roteamento e de corte protegido agora é do Rust, que não emite métricas.
- O rollback `INDEX_OWNER=node` do plano NÃO foi implementado: manter o caminho
  antigo exigiria dois escritores. Reverter = commit/imagem anterior.
- O TTL restante não é mais asserido no TS (o Rust mantém `expires_at`).

Diagnóstico: `idxHasKey(key)` (exata, para testes de roteamento) e o napi `hasKey`.
