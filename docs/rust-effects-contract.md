# Efeitos de cauda do `/stream` — contrato e cobertura do orquestrador Rust

Este documento fixa **quem enfileira o quê** ao fim de uma busca e o que o
orquestrador nativo (`adom-search`) já consegue emitir sozinho. Ele era o
pré-requisito do F4.1: o pipeline de debrid do Node (`applyDebrid`) produzia
estes efeitos; se ele saísse antes de o Rust emitir os mesmos, o BR "secaria"
(o Chupim para de baixar, o colhedor para de colher, a auditoria de áudio para
de provar, a chave de temporada para de invalidar listas). No F4.4 o pipeline
TS saiu e `EFFECTS_RUST` virou **default on** — estas são as únicas emissões.

O transporte é a rota interna já existente `POST /internal/search/effects`
(`src/routes/internal-search-effects.ts`), fire-and-forget, resposta **202** com
`{ ok, accepted, rejected }`. O handler valida a forma de cada `kind` e roda
cada efeito dentro de `runtime.run(ctx do encoded)` — a conta do usuário vem do
`encoded` do corpo, nunca do `.env`.

## Flag e rollback

| Item | Valor |
|---|---|
| Env | `EFFECTS_RUST` (aceita `1/true/on/yes`) |
| Default | **ON** desde o F4.4 (env ausente = ligado; `off` desliga) |
| Onde liga | `adom-server` (`stream_config.rs` → `OrchestratorConfig::effects_enabled`) |
| Alcance | só o orquestrador nativo (o pipeline TS de busca saiu no F4.4) |
| Rollback | `EFFECTS_RUST=off` desliga a emissão (o Node continua executando as filas) e reiniciar o gateway |

Com o pipeline de debrid do Node fora, não há duplicação: a emissão nativa é a
única. `EFFECTS_RUST=off` **não** devolve a emissão ao Node — o Node não monta
mais lista; sem o lote do Rust, os efeitos de cauda deixam de ser enfileirados.

## Dono de cada efeito (2026-10-28, `rust` @ `721512eb`)

O emissor (`adom-search`) não é mais necessariamente o executor: o seam
`NativeTailEffects` (`rust/crates/adom-server/src/tail_effects.rs`) intercepta
o `kind` e decide **quem roda**. Regra única: efeito com dono nativo só é
consumido quando o dono está LIGADO **e** aceitou; qualquer recusa volta ao
Node na mesma posição e conta em `rejected`.

| `kind` | Dono hoje | Volta ao Node quando |
|---|---|---|
| `dub_audit` | **gateway** (incondicional desde T3-L7a) | payload fora da forma é `rejected`, não volta |
| `autofetch_batch` | **gateway** com `AUTOFETCH_WORKER=on` **e** canal aceitando | trava desligada, worker `prepared` ou canal cheio |
| `br_probe` | idem `autofetch_batch` (mesmo canal, `Job` do worker) | idem |
| `season_key` | idem `autofetch_batch` (escopo sai do próprio payload) | idem |
| `rd_warmer` | **gateway** (`NativeEffectSink` registrado em `stream.rs`) | escopo de conta não derivável (sem cofre/chave) |
| `harvester_enqueue` | **Node** (continua na rota interna) | sempre |

**Sem escopo derivável o efeito volta ao Node.** O escopo é
`adapter:sha256(chave)` e sai de duas fontes: o payload (`adapterId`+`account`
no `season_key`) ou o cofre em RAM (`Vault::ingest` sobre o `encoded` do lote).
Sem `AUTOFETCH_WORKER=on` o cofre **não existe** — nesse caso `autofetch_batch`,
`br_probe`, `season_key` e `rd_warmer` seguem todos ao Node, como antes.

**Estado real hoje:** `autofetch::spawn()` passa `None` como fábrica de debrid,
então `enabled = worker_enabled() && debrid.is_some()` é falso **mesmo com a
trava ligada**: o worker fica `prepared` e os três kinds do Chupim continuam
indo ao Node. `rd_warmer` já é nativo de verdade (o sink aceita o efeito e a
chave sai do cofre): sem escopo derivável o efeito volta ao Node na hora; se o
escopo foi aprendido mas a chave expirou entre a oferta e a drenagem, o lote é
descartado com `dropped_no_key` — não volta ao Node, porque já foi consumido.

## O que é emitido, quando

Uma vez por busca, no fim da fila tardia (`orchestrator/late.rs` →
`emit_effects`), depois da escrita nativa do índice/banco (R4) e já fora do
prazo do cliente:

1. `dub_audit`, `rd_warmer` e `autofetch_batch` — vêm do lote da passada
   **mais nova** (`FinishValue.effects`, calculado no `finish` porque depende do
   veredito de cache por stream e do lote pós-checagem). O `dub_audit` é
   **interceptado no gateway** desde a T3-L7a e não chega ao Node
   ([`dub-audit-native-contract.md`](dub-audit-native-contract.md));
2. `harvester_enqueue` (`next-episode`) — quando a lista final tem play de
   verdade e a obra é série com S/E;
3. `season_key` — emitido **na abertura** (`Orchestrator::handle`), antes do
   SWR, como o `findStreams` do Node (o hit de cache também registra).

A seleção roda sobre o **pool pós-debrid, antes do `limitReservingBr`** — a
mesma lista que o `applyDebrid` enxerga — e não sobre o corte final.

Reemissão: o Node reemite a cada `applyDebrid` (resposta e passes tardios). Aqui
o lote é o da passada final do tail; como a lista final é superconjunto das
anteriores e cada fila do Node dedupa (marker do Chupim, fila, pending da
auditoria), o efeito prático é o mesmo. As diferenças conhecidas estão em
`rd_warmer` (abaixo) e na conta `unusable` do autofetch.

Prazo: não há prazo de cliente no tail; o POST usa o timeout curto do
`InternalSearchClient` (15 s) e falha só vira log (`[search] effects …`).

## Efeitos

### `dub_audit` — interrogatório de áudio (NATIVO desde a T3-L7a)

A **seleção** continua aqui (abaixo); a **execução** saiu do Node:
`NativeTailEffects` (`rust/crates/adom-server/src/tail_effects.rs`) consome o
`kind` e roda fila + `resolve` + escritas no gateway. O lote não atravessa mais
`POST /internal/search/effects`, e o handler Node responde `rejected` para o kind.
Contrato completo em [`dub-audit-native-contract.md`](dub-audit-native-contract.md).

- Origem TS (histórica): `debrid-pipeline-core.ts:311`/`:382`, via
  `collectAuditCandidates`/`queueDubAudit` (`dub-audit.ts`, apagado).
- Quem interroga: os ⚡ com promessa/prova de dublado e, em série, os ⚡ que não
  NOMEIAM o episódio pedido (pack de temporada pode conter outra coisa).
- Payload (Rust): `{ adapter_id, api_key, candidates[], search_key }`; cada
  candidato `{ hash, season, episode, imdbId, work: {names, year, pack} | null,
  dubbed, needsPromote }`.
- `api_key` é a chave da conta efetiva (defaults do operador + overlay da URL);
  com a execução nativa ela **nunca sai do processo** do gateway.
- Idempotência (gateway): dedupe por `(adapter, api_key, hash, S, E)` na fila
  pendente, teto de 50, pula hash já `lie` no banco de magnets e hash já provado
  `missing` no índice; um drain por vez.
- Nomeie a fila: `rust/crates/adom-server/src/dub_audit.rs`; escritas:
  `dub_audit_writes.rs`; interceptação: `tail_effects.rs`.
- Kill-switch (gateway, desde a T3-L7a): `AUDIO_AUDIT` e
  `DEBRID_DUB_AUDIT_MAX` (lidos no boot); o handler Node não tem mais o braço.
- Seleção Rust: `list_builder/effects.rs::audit_seeds`; fio:
  `orchestrator/effects.rs::dub_audit`.

### `rd_warmer` — aquecimento do Real-Debrid (COBERTO, com divergência)

- Origem TS: `debrid-pipeline-core.ts:221-243` — até 10 hashes de cada tier:
  BR dublado (score 100), dublado global (50), melhor swarm (10, `minSeeders:1`),
  sempre fora de `_multiWorkAdmitted`/`_fromFallback` e fora do que já está em
  cache.
- Payload (Rust): `{ releases: [{ title, infoHash, isBr, dubbed }] }` — os
  hashes escolhidos pelos MESMOS picks do núcleo
  (`pick_br_dubbed_candidates`/`pick_any_dubbed_candidates`/
  `pick_top_seeded_candidates`), unidos e deduplicados.
- **Divergência conhecida**: o handler chama `queueRdWarmForRelevant`, que
  re-pontua (80/40/5) e corta em **10 hashes**. O TS enfileirava até 30 (3 × 10)
  com prioridade própria. Fidelidade hoje: até 10 por busca. Fechar a lacuna
  exige um `kind`/campo de score explícito na rota (`rendimento` vs prioridade)
  — não foi feito para não mudar o contrato do Node nesta fatia.
- **Execução nativa desde `9919104e`**: `NativeTailEffects` registra o sink
  `rd_warmer` (`rust/crates/adom-server/src/rd_warmer.rs`, lado de produção em
  `rd_warmer_rd.rs`, sonda em `rd_warmer_probe.rs`) e entrega o efeito com o
  escopo `realdebrid:sha256(chave)`; a chave sai do cofre (`VaultKey::rd_key`),
  nunca do payload. Fila em RAM, um drain por vez, teto por hora civil
  (`DEBRID_RD_WARM_MAX_HOUR`) e `hit`/`miss`/`blocked` no ledger `rdc:v2`.
  Sem escopo (cofre ausente, chave expirada) o efeito **não** é consumido: volta
  ao Node no mesmo lote.
- Kill-switch (gateway): `DEBRID_RD_WARM` (`false` desliga o sink; ausente =
  ligado), `DEBRID_RD_WARM_BATCH/QUEUE_MAX/MAX_HOUR/POLL_MS`. O ledger por hash
  no processamento é o `rdc:v2`; rate limit/quota são do `RdGateExecutor`
  compartilhado, sem backoff paralelo. Não portados: fila persistente
  `rdq:v1:wq`, balde horário em KV, janela ociosa e `markAlive` do boot.
- Seleção Rust: `list_builder/effects.rs::warmer_seeds`; fio:
  `orchestrator/effects.rs::rd_warmer`.

### `harvester_enqueue` — episódio seguinte (COBERTO)

- Origem TS: `search-orchestrator.ts:314-316` — série com play e S/E enfileira
  `episode + 1`, motivo `next-episode` (topo absoluto da fila do colhedor).
- Payload (Rust): `{ imdbId, type: "series", season, episode: e+1,
  reason: "next-episode" }`.
- Idempotência/gates (Node): `harvestQueue.enqueue` valida
  `releaseIndex.enabled`/`harvestEnabled`, dedupe obra+motivo por 12 h, promove
  motivo sem duplicar e respeita `harvestQueueMax`.
- Fio: `orchestrator/effects.rs::harvester_next_episode`, emitido em
  `late.rs::emit_effects` a partir da lista final (play = `url` **ou**
  `infoHash`).

### `season_key` — LRU de temporadas com pack pronto (COBERTO)

- Origem TS: `search-cache.ts:64-72` (`findStreams`, antes de consultar o cache)
  → `registerSeasonSearchKey`; invalida buscas antigas quando o pack da
  temporada chega (Season Pack Fill).
- Payload (Rust): `{ adapter_id, account, imdb, season, cache_key }`, com
  `account = accountScope(apiKey)` (SHA-256 hex) e `cache_key = input.key`
  (`streams:v21:…`). A chave crua nunca vira chave de mapa.
- Gates (Node): `autoFetchSeasonFill` e os tetos
  `autoFetchSeasonIndexMax/Keys`.
- Fio: `orchestrator/effects.rs::season_key`, emitido em `handle`.

### `harvester_enqueue` (`miss`/`gap`/`br-gap`) e `br_probe` — agora do Rust (R4)

Estes dois eram emitidos pela rota de leitura do índice
(`src/routes/internal-search-index.ts` → `enqueueIndexFollowUp`). Com o índice
nativo (R4) a leitura migrou junto e o orquestrador passou a emitir o MESMO
plano por `POST /internal/search/effects`
(`adom-search::orchestrator::index_effects`):

- `harvester_enqueue` com `reason` `miss` (índice vazio), `gap` (não cobre ou
  parcial) e `br-gap` (sonda inelegível);
- `br_probe` com `mode` `evidence`/`upgrade` quando cobre o pool mas falta BR
  dublado, com o portão de plausibilidade (evidência no índice OU no acervo).

As regras puras de BR-gap foram portadas para `adom_core::br_gap`; a leitura do
`idx:v14`/`magnets.db` e os detalhes do banco estão em
[`rust-index-bank-contract.md`](rust-index-bank-contract.md). `br_probe` sem o
acervo (`magnets.db` ausente) perde só a evidência do banco — o índice ainda
prova BR.

O índice e o banco são nativos e incondicionais desde o R4: as rotas Node
`/internal/search/index`, `/internal/search/index-write` e
`/internal/search/fallback` foram apagadas e não há outro emissor.

### `autofetch` — Chupim (COBERTO pelo lote `autofetch_batch`)

- Origem TS: `debrid-pipeline-core.ts:130-134` (`autoFetchCandidates`, que
  escolhe e SEGURA os hashes antes da checagem) e `:213-220`
  (`autoFetchBrDubbed`, que despacha depois do veredito de cache).
- **Por que um lote, e não a seleção no Rust**: a decisão depende de estado de
  PROCESSO que o orquestrador nativo não tem — config viva do painel
  (`autofetchLive.effective()`), teto por OBRA/reservas (`autofetch-obra.ts`),
  portões do enqueue (`classifyEnqueue`), `hold` durável
  (`debrid/protected.ts`), fila persistente (`autofetch.writeQueue`/`drainNext`)
  e `debrid.enqueue`. Em vez de duplicar esse estado, o Rust entrega os FATOS
  medidos (`kind: "autofetch_batch"`) e o Node roda as MESMAS funções.
- Payload (Rust → Node): `{ items[], cached[], known, season, episode, imdbId,
  searchKey }`.
  - `items` = o lote **pós-checagem e PRÉ-corte `cachedOnly`** (o BR frio que o
    corte esconde é justamente o alvo do download), sem pack multiobra admitido
    e sem reserva não elegível (`_fromFallback && !_fallbackFetchable`); ordem
    preservada. Cada item leva `infoHash`, `title`, `name` e os fatos internos
    `_br`, `_dubbed`, `_dubClaim`, `_seeders`, `_quality`, `_size`,
    `_packBytes`, `_fromFallback`, `_fallbackFetchable`, `_seedFloorWaived`,
    `_multiWorkAdmitted`, `_bankDub`, `_lied`, `_indexer`, `_tracker` (campo
    ausente é omitido);
  - `cached` = hashes confirmados em cache pela checagem, em minúsculas;
  - `known` = veredito do lote (`debrid_known && !needsDebridRefresh`); com
    `false`, o Node escolhe/segura e o despacho libera os holds sem enfileirar,
    como no `applyDebrid`. O handler ainda completa o veredito com o inventário
    da conta (`enrichInstantWithoutCacheCheck`): adaptador sem `cacheCheck`
    (RD/Debrid-Link) pode responder pelo acervo mesmo com `known:false` — esse
    estado é do Node e não viaja no payload.
- Handler Node: `src/providers/autofetch-batch.ts::runAutofetchBatch` —
  reconstrói os `Stream`s, aplica o mesmo filtro de entrada e chama
  `autoFetchCandidates` → `enrichInstantWithoutCacheCheck` →
  `autoFetchBrDubbed`. Nada do caminho normal muda: a rota só ENFILEIRA (202) e
  o teste do enqueue é o mesmo (`marker`, lock, `acquireSearchSlot`, teto por
  obra, conta bloqueada, orçamento, fila, `protectBr`).
- Seleção Rust: `list_builder/effects.rs::autofetch_items`; fio:
  `orchestrator/effects.rs::autofetch_batch`.
- **Worker nativo no gateway (desligado por padrão, `d51f53c0`/`d50a7bdd`).**
  Com `AUTOFETCH_WORKER=on` **e** a fábrica por conta presente, o lote vira um
  `Job { scope, payload }` no canal do worker (`autofetch::{enqueue,recheck,serve}`)
  e não atravessa mais o HTTP; o `scope` vem do cofre. Hoje a fábrica é `None`
  no boot (`autofetch::spawn`), então o worker fica `prepared` e o caminho real
  continua sendo o handler Node abaixo.
- Kill-switches (Node, inalterados): `autoFetchBr`, pausa do painel,
  `classifyEnqueue`, orçamento/janela ociosa e `config.debrid` do operador.
  `EFFECTS_RUST=off` desliga a emissão; não há outro emissor do `/stream` — o
  Node só executa as filas.
- O que **não** vai no lote e continua no Node: sonda BR (`br_probe`), purga da
  fila seeds, contadores de skip, trace do Chupim, `releaseIndex`/banco de
  magnets (usados pela seleção), inventário da conta e o `debrid.enqueue` em si.
- **Divergência conhecida**: conta `unusable` (auth/quota) não emite o lote —
  o Rust trata como os demais efeitos. No Node, o `applyDebrid` ainda roda a
  seleção antes de sair e libera os holds; a sonda/fila que ela gravaria nesse
  caminho não é replicada. Sem download possível, o efeito prático é nulo.

## Arquivos

| Papel | Arquivo |
|---|---|
| Seleção pura (dub_audit/warmer/autofetch) | `rust/crates/adom-search/src/list_builder/effects.rs` |
| Payloads de fio + gates locais | `rust/crates/adom-search/src/orchestrator/effects.rs` |
| Emissão no tail | `rust/crates/adom-search/src/orchestrator/late.rs` (`emit_effects`) |
| `season_key` na abertura | `rust/crates/adom-search/src/orchestrator/mod.rs` (`emit_season_key`) |
| Flag | `rust/crates/adom-server/src/stream_config.rs` (`EFFECTS_RUST`) |
| Contrato do Node | `src/routes/internal-search-effects.ts` |
| Seam de dono dos efeitos | `rust/crates/adom-server/src/tail_effects.rs` |
| Execução nativa do `dub_audit` | `rust/crates/adom-server/src/dub_audit.rs`, `dub_audit_writes.rs` |
| Execução nativa do `rd_warmer` | `rust/crates/adom-server/src/rd_warmer.rs`, `rd_warmer_rd.rs`, `rd_warmer_probe.rs` |
| Worker nativo do Chupim | `rust/crates/adom-server/src/autofetch/{mod,vault,enqueue,recheck,serve,ports,worker}.rs` |
| Handler do lote do Chupim | `src/providers/autofetch-batch.ts` |
| Teste TS do contrato | `test/internal-search-effects.test.ts`, `test/internal-search-autofetch-batch.test.ts` |
| Testes Rust | `orchestrator/effects_tests.rs`, `orchestrator/tests_pipeline.rs`, `list_builder/effects.rs` |
