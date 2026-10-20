# Efeitos de cauda do `/stream` — contrato e cobertura do orquestrador Rust

Este documento fixa **quem enfileira o quê** ao fim de uma busca e o que o
orquestrador nativo (`adom-search`) já consegue emitir sozinho. Ele é o
pré-requisito do F4.1: o pipeline de debrid do Node (`applyDebrid`) é hoje quem
produz estes efeitos; se ele sair antes de o Rust emitir os mesmos, o BR
"seca" (o Chupim para de baixar, o colhedor para de colher, a auditoria de
áudio para de provar, a chave de temporada para de invalidar listas).

O transporte é a rota interna já existente `POST /internal/search/effects`
(`src/routes/internal-search-effects.ts`), fire-and-forget, resposta **202** com
`{ ok, accepted, rejected }`. O handler valida a forma de cada `kind` e roda
cada efeito dentro de `runtime.run(ctx do encoded)` — a conta do usuário vem do
`encoded` do corpo, nunca do `.env`.

## Flag e rollback

| Item | Valor |
|---|---|
| Env | `EFFECTS_RUST` (aceita `1/true/on/yes`) |
| Default | **OFF** — nada muda em relação ao comportamento atual |
| Onde liga | `adom-server` (`stream_config.rs` → `OrchestratorConfig::effects_enabled`) |
| Alcance | só o orquestrador nativo; a sombra §9.1 continua sem tail e sem efeitos |
| Rollback | remover/zerar a env (ou `EFFECTS_RUST=off`) e reiniciar o gateway |

Ligar `EFFECTS_RUST` com o pipeline de debrid do Node **ainda ativo** duplica a
emissão: as filas do Node dedupam (marker do Chupim, fila do warmer, fila do
colhedor com dedupe de 12 h, pending da auditoria por hash+S/E), mas o custo de
rede dobra. O uso previsto é o corte `ROUTES_RUST=stream` **com** o pipeline TS
de debrid desligado.

## O que é emitido, quando

Uma vez por busca, no fim da fila tardia (`orchestrator/late.rs` →
`emit_effects`), depois do `index-write` e já fora do prazo do cliente:

1. `dub_audit` e `rd_warmer` — vêm do lote da passada **mais nova**
   (`FinishValue.effects`, calculado no `finish` porque depende do veredito de
   cache por stream);
2. `harvester_enqueue` (`next-episode`) — quando a lista final tem play de
   verdade e a obra é série com S/E;
3. `season_key` — emitido **na abertura** (`Orchestrator::handle`), antes do
   SWR, como o `findStreams` do Node (o hit de cache também registra).

A seleção roda sobre o **pool pós-debrid, antes do `limitReservingBr`** — a
mesma lista que o `applyDebrid` enxerga — e não sobre o corte final.

Reemissão: o Node reemite a cada `applyDebrid` (resposta e passes tardios). Aqui
o lote é o da passada final do tail; como a lista final é superconjunto das
anteriores e cada fila do Node dedupa, o efeito prático é o mesmo. A diferença
conhecida está em `rd_warmer` (abaixo).

Prazo: não há prazo de cliente no tail; o POST usa o timeout curto do
`InternalSearchClient` (15 s) e falha só vira log (`[search] effects …`).

## Efeitos

### `dub_audit` — interrogatório de áudio (COBERTO)

- Origem TS: `debrid-pipeline-core.ts:311` (cache desconhecido) e `:382` (cache
  conhecido), via `collectAuditCandidates`/`queueDubAudit` (`dub-audit.ts`).
- Quem interroga: os ⚡ com promessa/prova de dublado e, em série, os ⚡ que não
  NOMEIAM o episódio pedido (pack de temporada pode conter outra coisa).
- Payload (Rust): `{ adapter_id, api_key, candidates[], search_key }`; cada
  candidato `{ hash, season, episode, imdbId, work: {names, year, pack} | null,
  dubbed, needsPromote }`.
- `api_key` é a chave da conta efetiva (defaults do operador + overlay da URL) e
  viaja só no corpo da rota interna (loopback + `X-Indexer-Test-Token`).
- Idempotência (Node): dedupe por hash+S/E na fila pendente, teto de 50, pula
  hash já `lie` no banco de magnets e hash já provado `missing` no índice.
- Kill-switch (Node): `config.audioAudit.enabled` e
  `config.debrid.dubAuditTailMax > 0` — Rust emite mesmo com eles off; o handler
  descarta.
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
- Kill-switch (Node): `config.debrid.rdWarm.enabled` + `rdWarmer.rdInPlay()`
  (painel/env/chave de sessão), ledger/alive por hash no processamento,
  `queueMax`, `maxPerHour`, janela ociosa e `rdGate`.
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

### `harvester_enqueue` (`miss`/`gap`/`br-gap`) e `br_probe` — NÃO emitidos pelo Rust

Estes dois **não estão perdidos hoje**: quem os emite é a própria rota de
leitura do índice, `POST /internal/search/index`
(`src/routes/internal-search-index.ts:86-108` → `enqueueIndexFollowUp`,
`search-index-path.ts:130-183`), que o orquestrador nativo chama em toda busca
rápida. Eles só saem quando a LEITURA do índice migrar para o Rust.

Contrato exato que falta para migrar essa emissão:

- linhas do índice por obra/localização (as mesmas de `releaseIndex.lookup`) com
  `source` (`autofetch` ou indexer), `indexer`, `title`, `isBr`, `dubbed`,
  `quality`, `hash`, `magnet`;
- `partial` (`releaseIndex.isPartial`), `covered`
  (`idxPoolCovered`, já portado em `adom_core::idx_pool_covered`) e
  `autofetchSeeded` (`indexed.some(r => r.source === 'autofetch')`);
- evidência BR do índice e do **banco de magnets** para o portão da sonda
  (`hasBrEvidence`/`hasBrDubbed` de `utils/br-gap.ts` e `bankHasBrRow` de
  `utils/magnet-bank-query.ts`) — `br-gap` ainda não foi portado ao núcleo;
- estado da sonda (`probeEnabled`/`probeBlocksSeeds`: `autoFetchBrProbe`,
  interseção index-only ∩ pt-BR, registro `pending` com lease).

Enquanto o índice for lido pelo Node, nada a fazer: a rota já cobre.

### `autofetch` — Chupim (NÃO coberto; contrato que falta)

- Origem TS: `debrid-pipeline-core.ts:130-134` (`autoFetchCandidates`, que
  escolhe e SEGURA os hashes antes da checagem) e `:213-220`
  (`autoFetchBrDubbed`, que despacha depois do veredito de cache).
- Por que o Rust não emite: a decisão não é só a cascata `br → any → seeds`
  (essa já está no núcleo). Ela depende de estado de PROCESSO que o
  orquestrador nativo não tem:
  - config viva do painel (`autofetchLive.effective()`: `autoFetchMax`,
    `autoFetchTopSeeds/Max`, `autoFetchAnyDubbed`, `autoFetchQueue(+Depth)`,
    tetos de raros, `autoFetchTtl`, `autoFetchMinSeeders`, `ptFirst`);
  - visão do teto por OBRA (`autofetch-obra.ts`: `obra_entries` +
    `pending_reservations`, reserva síncrona antes de qualquer `await`);
  - portões do enqueue (`classifyEnqueue`): marker no cache, lock em voo,
    vaga por busca (`acquireSearchSlot`), conta bloqueada, orçamento horário;
  - `hold` durável por hash (`debrid/protected.ts`) e a fila persistente
    (`autofetch.writeQueue`, `drainNext`, recheck por lotes);
  - `debrid.enqueue(hash)` — o upload em si, no adaptador Node.
- Contrato mínimo que falta (uma de duas opções):
  1. **Rota/kg de lote**: um `kind` que receba a lista pós-debrid com os fatos
     internos (`infoHash`, `_br`, `_dubbed`, `_dubClaim`, `_seeders`,
     `_quality`, `_fromFallback`, `_fallbackFetchable`, `_seedFloorWaived`,
     `_multiWorkAdmitted`, `title`, `name`) mais
     `{ cached[], known, season, episode, imdbId, searchKey }` e rode
     `autoFetchCandidates` + `autoFetchBrDubbed` no Node (o código já existe e
     continua sendo o dono do estado). Hoje nenhum `kind` da rota aceita isso e
     o Rust não carrega esses fatos depois da materialização do `StreamItem`.
  2. Trazer ao Rust o estado acima (painel + cache de marker/obra/fila +
     `debrid.enqueue`), o que é uma fatia inteira, não um payload.

## Arquivos

| Papel | Arquivo |
|---|---|
| Seleção pura (dub_audit/warmer) | `rust/crates/adom-search/src/list_builder/effects.rs` |
| Payloads de fio + gates locais | `rust/crates/adom-search/src/orchestrator/effects.rs` |
| Emissão no tail | `rust/crates/adom-search/src/orchestrator/late.rs` (`emit_effects`) |
| `season_key` na abertura | `rust/crates/adom-search/src/orchestrator/mod.rs` (`emit_season_key`) |
| Flag | `rust/crates/adom-server/src/stream_config.rs` (`EFFECTS_RUST`) |
| Contrato do Node | `src/routes/internal-search-effects.ts` |
| Teste TS do contrato | `test/internal-search-effects.test.ts` |
| Testes Rust | `orchestrator/effects_tests.rs`, `orchestrator/tests_pipeline.rs`, `list_builder/effects.rs` |
