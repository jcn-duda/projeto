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
`{ ok, accepted, rejected, nativeOnly }`. O handler valida a forma de TODOS os
kinds conhecidos e NÃO executa nenhum: todos entram em `nativeOnly` (os donos
são o worker do Chupim, o sink do warmer RD e o colhedor do gateway). O lote com
`nativeOnly > 0` sai com um `warn`, porque chegar aqui significa que o dono
nativo recusou ou está desligado.

## Flag e rollback

| Item | Valor |
|---|---|
| Env | `EFFECTS_RUST` (aceita `1/true/on/yes`) |
| Default | **ON** desde o F4.4 (env ausente = ligado; `off` desliga) |
| Onde liga | `adom-server` (`stream_config.rs` → `OrchestratorConfig::effects_enabled`) |
| Alcance | só o orquestrador nativo (o pipeline TS de busca saiu no F4.4) |
| Rollback | `EFFECTS_RUST=off` desliga a emissão (sem lote, as duas filas do Node — `rd_warmer`/`harvester_enqueue` — ficam sem o que executar) e reiniciar o gateway |

Com o pipeline de debrid do Node fora, não há duplicação: a emissão nativa é a
única. `EFFECTS_RUST=off` **não** devolve a emissão ao Node — o Node não monta
mais lista; sem o lote do Rust, os efeitos de cauda deixam de ser enfileirados.

## Dono de cada efeito (2026-10-28, `rust` @ `721512eb`)

O emissor (`adom-search`) não é mais necessariamente o executor: o seam
`NativeTailEffects` (`rust/crates/adom-server/src/tail_effects.rs`) intercepta
o `kind` e decide **quem roda**. Regra única: efeito com dono nativo só é
consumido quando o dono está LIGADO **e** aceitou; a recusa produz `Deferred`
(o efeito segue ao Node na mesma posição e conta em `rejected` do seam).

| `kind` | Dono hoje | `Deferred`/`Forward` do seam |
|---|---|---|
| `dub_audit` | **gateway** (incondicional desde T3-L7a) | payload fora da forma é `rejected`, não volta |
| `autofetch_batch` | **gateway** (worker nativo, `AUTOFETCH_WORKER=on`) | sem a trava, `prepared` ou canal cheio: vai ao Node, que **não executa** (só `nativeOnly`) |
| `br_probe` | idem `autofetch_batch` (mesmo canal, `Job` do worker) | idem |
| `season_key` | idem `autofetch_batch` (escopo sai do próprio payload) | idem |
| `rd_warmer` | **gateway** (`NativeEffectSink` registrado em `stream.rs`) | escopo de conta não derivável (sem cofre/chave): vai ao Node, que **não executa** (só `nativeOnly`) |
| `harvester_enqueue` | **gateway** (`adom-server::harvest_effect`, fila do colhedor) | sem colhedor (`HARVEST_ENABLED=false`): vai ao Node, que **não executa** (só `nativeOnly`) |

**`Deferred` não é execução.** Depois do corte da B4 o seam ainda produz
`Deferred` para os kinds de trabalho (`tail_effects.rs:136-156`), mas o destino
não tem mais o executor: a rota valida a forma, soma em `nativeOnly` e não chama
nada. Na prática, worker em `prepared` = lote aceito no 202 e descartado. Os
únicos kinds que hoje voltam ao Node **e rodam lá** são `rd_warmer` (sem escopo,
o Node ainda enfileira o aquecimento) e `harvester_enqueue` (`Forward`).

O escopo é `adapter:sha256(chave)` e sai de duas fontes: o payload
(`adapterId`+`account` no `season_key`) ou o cofre em RAM (`Vault::ingest` sobre
o `encoded` do lote). Sem `AUTOFETCH_WORKER=on` o cofre **não existe**: os três
kinds de trabalho ficam sem escopo e o efeito vira `Deferred` — não há braço no
Node que os execute.

**Estado real hoje (pós-B4, 2026-10-28):** `boot::spawn_at` monta a fábrica de
PRODUÇÃO (`autofetch/build.rs`) quando `AUTOFETCH_WORKER=on` e o cofre do
processo existe; o `docker-compose.yml` traz `${AUTOFETCH_WORKER:-on}` (o `.env`
da VPS vence a interpolação). Logo
`enabled = worker_enabled() && debrid.is_some()` é verdadeiro no deploy padrão e
os TRÊS kinds do Chupim são consumidos no gateway (ver "Destino do `Job` por
kind", abaixo). `worker_enabled()` aceita só o literal `on`
(`autofetch/mod.rs:128-130`): ausente, vazio, `1` ou `true` mantêm `prepared` —
e o efeito de trabalho, sem executor no Node, morre (rollback = imagem/commit
anterior). `rd_warmer` já é nativo de verdade (o sink aceita o efeito e a chave
sai do cofre): sem escopo derivável o efeito volta ao Node na hora; se o escopo
foi aprendido mas a chave expirou entre a oferta e a drenagem, o lote é
descartado com `dropped_no_key` — não volta ao Node, porque já foi consumido.

## Destino do `Job` por kind — leva C1 (2026-10-28)

O canal é um só (`mpsc` de `serve::CHANNEL_CAPACITY`, 64) e os três kinds do
Chupim entram nele como `Job { kind, scope, payload }`
(`autofetch/enqueue.rs:46-57`), com `scope` = `adapter:sha256(chave)` —
derivado do payload (`season_key`) ou do cofre (`autofetch_batch`, `br_probe`).

**O `kind` viaja no canal porque o laço despacha por ele**
(`tail_effects::NativeWorkQueue::submit`, `tail_effects.rs:63-70`): sem ele,
sonda e season cairiam em `enqueue::run` e seriam recusadas como `empty-batch`
— o trabalho sumiria sem chegar ao passo nem voltar ao Node. O despacho é
`serve_jobs.rs::Engine::batch` (`:57-65`):

| `Job.kind` | Passo | Recusa |
|---|---|---|
| `AUTOFETCH_BATCH` | `enqueue_batch` → `enqueue::run` → `recheck::schedule` | — |
| `BR_PROBE` | `probe` → `probe_job::run` → `probe_step::{plan,execute}` | sem colhedor montado o `submit` devolve `false` (`mod.rs:99-101`): o efeito **volta ao Node** |
| `SEASON_KEY` | `season` → `season_step::{plan,execute}` | — |
| outro | — | `Skip("unknown-kind")`: aceito e descartado NO gateway |

`br_probe` sem colhedor é recusado no `submit`, não no passo
(`autofetch/mod.rs:84-101`): o passo precisa do `HarvestHandle` para enfileirar
a obra, e marcar `Native` para morrer na fila do worker seria trabalho
silencioso. Com colhedor montado, o passo roda e a recusa posterior
(`no-harvester`, `queue-full`, `paused`) fica no gateway.

**Aceite não tem volta.** `Deferred` só existe ANTES do `submit`: sem escopo
derivável, canal desligado (`prepared`) ou `try_send` cheio, o efeito segue ao
Node na mesma posição e conta em `rejected`. Do lado de lá ele **não roda mais**
(entra em `nativeOnly`), então `Deferred` de trabalho é lote perdido — o aceite
do Node não é execução. Depois do `submit`, quem recusa o passo é o próprio
worker (`Skip`/`refused`) e o lote NÃO é reenviado — é a diferença entre "o Node
recebeu e descartou" e "o gateway recebeu e desistiu".

### `autofetch_batch` — lote pós-debrid (consumido)

| Item | Como é |
|---|---|
| Consome | `serve_jobs.rs::Engine::batch` → `enqueue_batch` → `enqueue::run` (escritor único da fila v3) → `recheck::schedule`; o dreno do lote terminal é `enqueue_drain::drain_one` |
| Payload | `{ items[], cached[], known, season, episode, imdbId, searchKey }` — detalhe na seção "`autofetch` — Chupim (COBERTO pelo lote `autofetch_batch`)", abaixo |
| Lê do lote | `searchKey`, `known` e `items` (`enqueue_items::parse_items`); o resto é contexto |
| `prepared` | sem canal (`enabled=false`): `Deferred`; o Node só conta em `nativeOnly` |
| Pausado | o lote ENTRA e roda; `CascadeFacts.paused` manda tudo para `deferred` (nada é enfileirado) e `classify_enqueue` recusa por `paused`; cada motivo entra em `skips` no `GET /autofetch` |
| Fila cheia | dois sentidos: canal (`try_send` falha → `Deferred`) e fila v3 persistida, cortada pelo `queueDepth` do `LivePolicy` no `write_queue` — o adiado nunca se perde |
| Volta ao Node | só antes do `submit`, e sem executor do outro lado (`nativeOnly`). Depois, `refused` do lote (`no-search-key`, `empty-batch`, `unknown-cache`, `in-flight`) e `no-credential` do passo ficam no gateway: a fila já gravada espera no KV |

**Registro do Chupim no índice (`source:'autofetch'`) — escritor NATIVO.** A B4 cortou
`recordAutofetchRelease` com o runner TS e os leitores ficaram inertes
(`native_index.rs:139-166`: filtro de indexador + `autofetch_seeded` → via rápida;
`index_effects.rs:109-118`: `gap` no follow-up). O ACEITE do lote (`enqueue.rs`, depois
de `commit_obra`) chama `index_record::keep` → `ReleaseIndexStore::record` com
`source = autofetch`, no formato do TS; pool `seeds` sem prova de dublagem não grava
(`Skip("index-no-dub")`). A gravação sai do caminho da resposta (canal `try_send` +
thread dona do `cache.db`; falha = `Skip("index-error")`, o aceite já é durável) e
NÃO é cobertura BR: `br_gap.rs:28-30,88-92` e `search_pool_coverage.rs:283-287`
excluem a fonte, que é promovida a observação pública quando uma busca real revê o
hash. `RELEASE_INDEX` off/TTL 0 = sem sink; `forget_autofetch_hash` volta a ter alvo.

**Perda limitada a 256 no shutdown — decisão ACEITA, não bug.** O canal do escritor tem
teto fixo de 256 (`index_record_ops.rs:32`) e o aceite usa `try_send`: cheio vira
`Refuse::Full` (backoff) e o laço do lote NUNCA espera (`:76-84`). O `JoinHandle` da
thread `adom-idx-record` não é guardado em lugar nenhum (`:62-74`), então no shutdown do
processo a thread morre com até 256 `Keep`/`Forget` ainda no canal — o `for op in rx`
só drenaria se alguém esperasse a thread, e ninguém espera. É aceitável porque o índice
é CACHE reconstruível: o aceite do lote já está durável (marker/obra/fila) e a busca
seguinte volta a coletar; o efeito é a obra ficar fora do fast-path do índice até uma
nova observação. Não acrescentar drain no shutdown: sincronizar o desligamento não
devolve nada que a próxima busca não recupere.

### `br_probe` — sonda dirigida (consumido)

| Item | Como é |
|---|---|
| Consome | `serve_jobs.rs::Engine::probe` (`:68-86`) → `probe_job::run` → `probe_step::{plan,execute}`. O estado FINAL (`found`/`empty`/`failed`/`capped`) é do colhedor (`harvest/settle.rs`), não do worker |
| Payload | `{ imdbId, type: "movie"\|"series", season?, episode?, mode: "evidence"\|"upgrade" }` (`orchestrator/index_effects.rs::effect_entries`) |
| Lê do lote | `imdbId` (tem que ser `tt…`), `type`, `season`, `episode`; `mode` NÃO é lido — a sonda sai como `br-gap` dirigido |
| Alvo e estado | index-only ∩ pt-BR menos os isentos da busca viva (`ProbeStepConfig::indexers`); registro em `autofetch:v3:probe:<sha256>` (`probe_key`), com `pending` só depois de a fila do colhedor confirmar a entrada com `brProbe` |
| TTL | `ProbeStepConfig::from_env` lê `BR_PROBE_TTL_S` (default `43 200`, piso `60`) a cada job (`probe_job.rs:41-56`); o `pending` tem piso próprio de 10 min (`PENDING_LEASE_MS`, `adom-harvest/src/probe.rs:43`) |
| Teto de fila | `queue_len >= HARVEST_QUEUE_MAX` → `Skip("queue-full")`, sem tocar o KV (o `enqueue` do colhedor recusaria por `Capacity` e evictaria a cauda) |
| `prepared` | `Deferred`; o Node conta em `nativeOnly` e não executa (`br-probe.ts` saiu na B4 — o passo é `probe_job.rs`) |
| Pausado | `Skip("paused")` — o mesmo `Control::paused`; nada é escrito no KV |
| Volta ao Node | só antes do `submit`: sem colhedor, `AutofetchHandle::submit` devolve `false` (e o Node só conta em `nativeOnly`). Depois do aceite, `Skip` do passo (`paused`, `queue-full`, `release-index-off`, `disabled`, `no-intersection`, `pending`, `found`) NÃO volta ao Node |

O teto horário do colhedor que corta alvos planejados grava `capped` — não
`empty`; a ordem de decisão está em `harvest-native-contract.md`.

**Divergência conhecida (`AUTOFETCH_BR_PROBE`):** o passo lê o toggle com
`trim()` (`probe_job.rs:104`), enquanto a régua do pool (`enqueue_gates.rs:109-117`)
e o `String(env || 'true') === 'true'` do Node não fazem `trim` —
`" true "` LIGA a sonda e DESLIGA o pool dublado.

### `season_key` — Season Pack Fill (consumido)

| Item | Como é |
|---|---|
| Consome | `serve_jobs.rs::Engine::season` (`:89-103`) → `season_step::{plan,execute}` (registro no KV); o preenchimento é `season_fill.rs`, chamado na passagem quando o pack fica pronto |
| Payload | `{ adapter_id, account, imdb, season, cache_key }`; `account` já É o digest (não se re-hasheia) |
| Lê do lote | os cinco campos; `account == "none"`, `imdb` sem `tt`, `season <= 0` ou texto vazio → `Skip("invalid")` |
| KV | `autofetch:v3:season:<adapter>:<conta>:<imdb>:<temporada>` (`season_step::SEASON_PREFIX`) guarda as `cache_key`s da temporada |
| Consumo do índice | ordem `peek` → `sink` → `take` (`season_fill.rs`): o índice só é apagado DEPOIS de a invalidação do `streams.db` confirmar. Sem sink registrado o registro fica vivo e a passagem seguinte tenta de novo |
| `prepared` | `Deferred`; o Node conta em `nativeOnly` |
| Pausado | `Skip("paused")` no registro E no preenchimento |
| Fila cheia | não existe para este kind; o que existe é toggle/teto: `DEBRID_AUTO_FETCH_SEASON_FILL` off → `fill-off`, `DEBRID_AUTO_FETCH_SEASON_INDEX_MAX=0` → `index-off` |
| Volta ao Node | só antes do `submit`, sem executor do outro lado; aceito, a recusa (`invalid`, `paused`, `fill-off`, `index-off`, `not-pack`) fica no gateway |

Os motivos de `Skip` mantêm os nomes que o painel do Node já conta (`invalid`,
`paused`, `queue-full`, `index-off`, `fill-off`, `pending`, `found`, `empty`,
`retry`, `no-intersection`, `release-index-off`, `disabled`), para o contador
não mudar de nome no meio do flip.

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

Reemissão: até o F4.4 o Node reemia a cada `applyDebrid` (resposta e passes
tardios). Hoje só o tail nativo emite: o lote é o da passada final, e como a
lista final é superconjunto das
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

- Origem TS (histórica nos dois casos; `debrid-pipeline-core.ts` removido no F4.4): `debrid-pipeline-core.ts:311`/`:382`, via
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

- Origem TS (histórica; `debrid-pipeline-core.ts` removido no F4.4): `:221-243` — até 10 hashes de cada tier:
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

- Origem TS (histórica; `search-orchestrator.ts` removido no F4.4): `:314-316` — série com play e S/E enfileira
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

- Origem TS (histórica; `search-cache.ts` removido no F4.4): `:64-72` (`findStreams`, antes de consultar o cache)
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

- Origem TS (histórica, arquivo removido no F4.4): `debrid-pipeline-core.ts:130-134` (`autoFetchCandidates`,
  que escolhia e SEGURAVA os hashes antes da checagem) e `:213-220`
  (`autoFetchBrDubbed`, que despachava depois do veredito de cache). O pipeline
  saiu no F4.4; o corpo do Chupim saiu na B4.
- **Por que um lote** (razão histórica, mantida porque explica o payload): a
  decisão depende de estado de PROCESSO — config viva do painel
  (`autofetchLive.effective()`), teto por OBRA/reservas, portões do enqueue,
  `hold` durável (`debrid/protected.ts`) e a fila persistente. O Rust entrega os
  FATOS medidos (`kind: "autofetch_batch"`) e o dono do trabalho os aplica.
  Desde a B4 esse dono é o **worker nativo** — não há mais handler TS.
- Payload (Rust → consumidor): `{ items[], cached[], known, season, episode,
  imdbId, searchKey }`.
  - `items` = o lote **pós-checagem e PRÉ-corte `cachedOnly`** (o BR frio que o
    corte esconde é justamente o alvo do download), sem pack multiobra admitido
    e sem reserva não elegível (`_fromFallback && !_fallbackFetchable`); ordem
    preservada. Cada item leva `infoHash`, `title`, `name` e os fatos internos
    `_br`, `_dubbed`, `_dubClaim`, `_seeders`, `_quality`, `_size`,
    `_packBytes`, `_fromFallback`, `_fallbackFetchable`, `_seedFloorWaived`,
    `_multiWorkAdmitted`, `_bankDub`, `_lied`, `_indexer`, `_tracker` (campo
    ausente é omitido);
  - `cached` = hashes confirmados em cache pela checagem, em minúsculas;
  - `known` = veredito do lote (`debrid_known && !needsDebridRefresh`). O
    enriquecimento pelo inventário da conta (`enrichInstantWithoutCacheCheck`,
    que respondia pelo acervo mesmo com `known:false` para adaptador sem
    `cacheCheck` como RD/Debrid-Link) sobrevive em
    `src/providers/debrid-cache-steps.ts` para o oráculo, **sem consumidor de
    produção** desde a B4.
- Consumidor: o worker nativo. Com `AUTOFETCH_WORKER=on` **e** a fábrica por
  conta presente, o lote vira um `Job { kind, scope, payload }` no canal
  (`autofetch/{serve,serve_jobs,enqueue,recheck}`) e não atravessa o HTTP; o
  `scope` vem do cofre. `boot::production_factory` (`autofetch/boot.rs:42-59`)
  monta a fábrica de PRODUÇÃO no boot; sem a trava, sem cofre ou sem cliente
  HTTP (`build.rs:66-79`) o worker fica `prepared` — e o lote encaminhado ao Node
  só conta em `nativeOnly` (não há segundo executor). Boot nunca quebra.
- Seleção Rust: `list_builder/effects.rs::autofetch_items`; fio:
  `orchestrator/effects.rs::autofetch_batch`.
- Kill-switches: `autoFetchBr` e a pausa do painel (config ao vivo
  `cfg:v1:autofetch`, que o Node grava e o gateway lê), os portões do enqueue
  (`autofetch/enqueue_gates.rs`), orçamento/janela ociosa e `config.debrid` do
  operador. `EFFECTS_RUST=off` desliga a emissão; não há outro emissor do
  `/stream`.
- O que **não** vai no lote e continua no Node: `harvester_enqueue`, os FATOS de
  posse/retenção (`adsub`/`adprot`, que o nativo só LÊ) e o painel. O marker com
  `obra` e o registro F2 são gravados pelo aceite nativo (`enqueue.rs:299-316`,
  `enqueue_obra.rs:294-295`). Os motivos de
  skip do painel vêm do worker (`GET /autofetch` da admin 8711), não do Node. A
  sonda, a Season Pack Fill e o dreno da represa são passos do laço (os três
  kinds acima).
- **Divergência conhecida**: conta `unusable` (auth/quota) não emite o lote —
  o Rust trata como os demais efeitos. Sem download possível, o efeito prático
  é nulo.

## Arquivos

| Papel | Arquivo |
|---|---|
| Seleção pura (dub_audit/warmer/autofetch) | `rust/crates/adom-search/src/list_builder/effects.rs` |
| Payloads de fio + gates locais | `rust/crates/adom-search/src/orchestrator/effects.rs` |
| Emissão no tail | `rust/crates/adom-search/src/orchestrator/late.rs` (`emit_effects`) |
| `season_key` na abertura | `rust/crates/adom-search/src/orchestrator/mod.rs` (`emit_season_key`) |
| Flag | `rust/crates/adom-server/src/stream_config.rs` (`EFFECTS_RUST`) |
| Seam de dono dos efeitos | `rust/crates/adom-server/src/tail_effects.rs` |
| Execução nativa do `dub_audit` | `rust/crates/adom-server/src/dub_audit.rs`, `dub_audit_writes.rs` |
| Execução nativa do `rd_warmer` | `rust/crates/adom-server/src/rd_warmer.rs`, `rd_warmer_rd.rs`, `rd_warmer_probe.rs` |
| Worker nativo do Chupim | `rust/crates/adom-server/src/autofetch/{mod,vault,enqueue,recheck,serve,ports,build,worker}.rs` |
| Fábrica de produção (5 serviços, gate RD único) | `rust/crates/adom-server/src/autofetch/build.rs` |
| Passo `br_probe` (régua + lease) | `rust/crates/adom-server/src/autofetch/probe_step.rs` |
| Passo `br_probe` (produção: config por job) | `rust/crates/adom-server/src/autofetch/probe_job.rs` |
| Passo `season_key` (registro no KV) | `rust/crates/adom-server/src/autofetch/season_step.rs` |
| Season Pack Fill (execução + invalidação) | `rust/crates/adom-server/src/autofetch/season_fill.rs` |
| Evicção F6 (política + executor) | `rust/crates/adom-server/src/autofetch/evict_step.rs` |
| Evicção F6 (produção: fatos + `adrm`) | `rust/crates/adom-server/src/autofetch/evict_job.rs` |
| Despacho do canal por `kind` | `rust/crates/adom-server/src/autofetch/serve_jobs.rs` |
| Goldens de contrato dos quatro passos | `rust/golden/autofetch-{probe,season,evict,suppressed}-step.{jsonl,manifest.json}` |
| Gerador dos goldens (manual) | `scripts/golden/contract-autofetch-steps.mjs` |
| Dreno da represa `sup:` | `rust/crates/adom-server/src/autofetch/suppressed_step.rs` |
| Porta `evict` (só AllDebrid) | `rust/crates/adom-debrid/src/autofetch_ports_evict.rs` |
| Rotas do painel do worker | `rust/crates/adom-server/src/autofetch/routes.rs` |
| Contrato da rota no Node (2 kinds executados, `nativeOnly`) | `src/routes/internal-search-effects.ts` |
| Teste TS do contrato | `test/internal-search-effects.test.ts`, `test/autofetch-cut-edges.test.ts` (catraca do corte) |
| Testes Rust | `orchestrator/effects_tests.rs`, `orchestrator/tests_pipeline.rs`, `list_builder/effects.rs` |
