# `adom-harvest` — fila do colhedor (rodando no gateway)

Crate **fora do caminho `/stream`**. É a fila persistente `harvest:v1:q`, o
dedupe 12h, o balde horário, o coalescing em voo e a máquina do `br-probe`.

Desde a Fase 5 quem consome é o **gateway** (`adom-server::harvest`): uma thread
própria drena com as fontes nativas do `adom-sources` e grava no índice nativo.
O corpo TS que fazia isso (`src/providers/{harvester,harvest-*,jackett*,bludv,
search-plan}.ts`) foi apagado — o Node só enfileira, lê o estado e manda
pausar/drenar/limpar pela admin do gateway. Contrato em
[`docs/harvest-native-contract.md`](../../../docs/harvest-native-contract.md).

O crate segue **puro** (sem cliente Jackett, sem índice, sem HTTP): quem tem
rede é o drain do `adom-server`.

## Contrato alinhado ao TS

| Conceito | TS (histórico, branch `esm`) | Rust (este crate) |
|---|---|---|
| Chave da fila | `prefix('harvest') + 'q'` → `harvest:v1:q` | `QUEUE_KEY` / `queue_key()` |
| Entrada | `HarvestEntry` | `HarvestEntry` |
| Resultado enqueue | `EnqueueOutcome` | `EnqueueOutcome` |
| Identidade | `obraIdentity` | `obra_identity` |
| Precedência | `reasonPriority` / `isPromotion` | `reason_priority` / `is_promotion` |
| Consumo | `takeHead` / `takeProbe` | `take_head` / `take_probe` / `take_next(busy)` |
| L2 | `cache.get` / `cache.set(QUEUE_KEY, …)` | `HarvestStore::load` / `save` |
| Dedupe 12h | `queueDedupeKey` / `wasRecentlyQueued` / `markRecentlyQueued` | `seen_key` / `was_recently_queued` / `mark_recently_queued` (`seen.rs`) |
| Coalescing em voo | `harvest-inflight` (`begin`/`end`/`coalesce`/`pendingIntent`) | `HarvestInflight` (`inflight.rs`), slot dentro da fila |
| Balde horário | `HOUR_KEY` / `hourBucketTtlSeconds` / `hydrateCurrentHour` | `hour_key` / `hour_ttl_seconds` / `load_hour` / `save_hour` + `HarvestWorker::hydrate_hour` (`hour.rs`) |
| Flush | `load()` / `persist()` | `HarvestQueue::load_from` / `save_to` |
| Prioridade | `prioritizeQueue` + `hasBrDubbed(lookupQuiet)` | `prioritize` + trait `BrEvidence` (stub/callback; índice real ainda não) |
| Ciclo | `harvester.tick` / `harvestWorker` | `HarvestWorker::tick` + `TrafficSense` + `HarvestDrain` |
| Ciclo com rede | `harvester.tick` (await do Jackett) | `begin`/`finish` + `HarvestDrainAsync` (ou `tick_async` tudo-em-um) |

### Ciclo tick

```rust
use adom_harvest::{
    DrainOutcome, HarvestQueue, HarvestQueueConfig, HarvestRequest, HarvestWorker,
    HarvestWorkerConfig, StubTraffic,
};

let mut queue = HarvestQueue::new(HarvestQueueConfig::default());
queue.enqueue(HarvestRequest::movie("tt0111161", "miss"));
let mut worker = HarvestWorker::new(HarvestWorkerConfig::default());
let mut drain = |_e| DrainOutcome::ok_with_queries(1);
let out = worker.tick(&mut queue, &StubTraffic { busy: false }, &mut drain, now_ms);
```

- Decisão ÚNICA (`plan`, privada): disabled → paused → in_flight → busy
  (sem sonda ⇒ `SkippedBusy`) → vazio → teto horário → `take_next`. `tick` e
  `tick_async` só diferem no `await` do drain — as guardas não podem divergir.
- Freio: `TrafficSense::is_busy()` ⇒ só `take_next(true)` (`take_probe`);
  sem sonda na fila ⇒ `SkippedBusy` sem consumir nada.
- Teto: `queries_this_hour` / `note_queries` por balde UTC; `>= max_per_hour` ⇒ skip.
- Slot em voo: `open_slot` (`begin` + flag) antes do drain e `close_slot`
  (`note_queries` + `end` + flag) depois — inclusive quando o drain falha.
- `begin`/`finish` são as metades públicas do ciclo: `begin` devolve `TickStart`
  (`Skip` ou `Run { entry, identity }`) e `finish` debita/fecha. É o que permite
  soltar o lock da fila durante a rede.
- Drain **sync** (`HarvestDrain`) para stub/teste; o cliente Jackett não mora
  aqui.

### Porta async (gateway)

O gateway (`adom-server`) drena a fila com rede no meio: implementa
`HarvestDrainAsync` (future **boxed** só para o trait continuar chamável por
`&mut dyn`) e chama `begin` → `drain_one` → `finish`, soltando o lock da fila
entre as duas metades. A semântica é a do `tick`: skip devolve o mesmo
`TickOutcome` **sem tocar na fila**; drenar abre o slot da obra em voo, debita
`outcome.queries` e fecha o slot. `tick_async` é a porta tudo-em-um equivalente
(mesmo `Drained { entry, outcome }`), usada nos testes.

```rust
use std::future::Future;
use std::pin::Pin;

use adom_harvest::{DrainOutcome, HarvestDrainAsync, HarvestEntry};

struct Jackett(/* client + deadline */);

impl HarvestDrainAsync for Jackett {
    fn drain_one<'a>(
        &'a mut self,
        entry: &'a HarvestEntry,
    ) -> Pin<Box<dyn Future<Output = DrainOutcome> + Send + 'a>> {
        Box::pin(async move {
            // fetch real; erro vira `DrainOutcome::failed()`, nunca panic.
            DrainOutcome::ok_with_queries(1)
        })
    }
}

let out = worker
    .tick_async(&mut queue, &traffic, &mut jackett, now_ms)
    .await;
```

Cancelar o future no meio do drain deixa o slot aberto (o tick é serial por
contrato): quem chama espera o ciclo terminar em vez de abortá-lo.

O future do `tick_async` **não** é `Send` — `&dyn TrafficSense` e `&mut dyn
HarvestDrainAsync` só seriam se os traits trouxessem `Sync`/`Send`. O loop do
gateway roda em thread própria (runtime `current_thread`); `tokio::spawn`
direto exigiria `HarvestDrainAsync: Send` **e** `&(dyn TrafficSense + Sync)`
(não está no contrato desta fatia).

Guardrails (iguais ao Arquivista):

1. Colhedor é **assíncrono** — nunca bloqueia a resposta do `/stream`.
2. Index-only fica **fora** do caminho de resposta (só o worker de fundo).
3. Contagem pura **nunca** decide cobertura do índice (`idxPoolCovered` —
   ainda não portado; mora no release-index).
4. `fromAccount` **nunca** entra no índice (fora do escopo desta fila).
5. Gateway **não** drena no caminho da resposta — só em fundo, via
   `begin`/`finish` na thread do loop.

## Persistência L2

Mesmo schema WAL de `adom-store` / `debrid.db` (`cache` com
`key`/`value`/`expires_at`). Uma chave só (`harvest:v1:q`); mutação continua
em `HarvestQueue` (memória); `save_to` é o `cache.set` periódico.

```rust
let store = HarvestStore::open_memory()?; // ou open(path)
let mut queue = HarvestQueue::new(HarvestQueueConfig::default());
let evidence = StubBrEvidence::with_dubbed(["tt0111161::"]);
queue.load_from(&store, now_ms, Some(&evidence))?;
queue.enqueue(HarvestRequest::movie("tt0111161", "miss"));
queue.save_to(&store, DEFAULT_ENTRY_TTL_SECONDS, now_ms)?;
```

### Priorização BR

```rust
use adom_harvest::{prioritize, PrioritizeConfig, StubBrEvidence};

let mut ev = StubBrEvidence::new();
ev.insert("tt3000002", None, None);
let ordered = prioritize(&entries, &PrioritizeConfig::default(), &ev, now_ms);
// ou callback: prioritize(&entries, &cfg, &|id, s, e| id == "tt3000002", now_ms);
```

`load_from(..., Some(&evidence))` aplica a mesma ordem após ler o L2.
Sem evidência (`None`), a ordem do disco é preservada.

## Dedupe 12h

`harvest:v1:seen:<sha256(obraIdentity:reason)>`, valor `"1"`, TTL de 12h —
mesmo contrato do `harvest-queue.ts`. Duas regras que o teste fixa:

- **Ler não renova**: `was_recently_queued` só consulta (e apaga o expirado).
- **Gravar é depois do aceite**: `mark_recently_queued` é chamado pelo
  chamador quando o pedido entra na fila — gravar antes engolia a promoção de
  motivo (`miss` → `br-gap`) como duplicata.

```rust
use adom_harvest::{mark_recently_queued, was_recently_queued, HarvestStore};

if !was_recently_queued(&store, &entry, now_ms)? {
    mark_recently_queued(&store, &entry, now_ms)?;
}
```

## Balde horário durável

`harvest:v1:hour` guarda `{hour, count}` da hora civil UTC. Sem ele, restart
ou deploy zera o teto da hora e o colhedor pode estourar `HARVEST_MAX_HOUR` de
novo — risco de ban no indexer.

- **TTL**: até o fim do balde + 60 s, mínimo 60 (`hour_ttl_seconds`).
- **Leitura**: só aceita a hora corrente e `count > 0` (`load_hour`); JSON
  podre ou hora velha devolvem `None`.
- **Semeio**: `HarvestWorker::hydrate_hour` nunca regride o contador — o disco
  só completa o que o processo ainda não debitou.
- Gravar continua sendo do chamador (o worker não tem store), como no TS, onde
  `noteQueries` hidrata antes de somar e faz `cache.set`.

```rust
use adom_harvest::{load_hour, save_hour, HarvestStore};

if let Some(stored) = load_hour(&store, now_ms)? {
    worker.hydrate_hour(stored.count, now_ms);
}
// após o drain:
worker.note_queries(queries, now_ms);
save_hour(&store, worker.queries_this_hour(now_ms), now_ms)?;
```

## Coalescing em voo

Enquanto o tick colhe uma obra, `HarvestQueue::enqueue` da MESMA obra não
cria segunda entrada: devolve `coalesced` e funde a intenção no slot
(`HarvestInflight`), como no `harvest-inflight.ts`.

- Precedência só **sobe** (`reason_priority`); `br_probe` é OR-aderente.
- A intenção FULL (não-dirigida) fica à parte: um run dirigido cobre só o
  subset index-only∩pt-BR e não satisfaz um pedido de colheita inteira.
- O tick abre o slot com a cabeça consumida e o fecha em `end`; obra diferente
  nunca casa e nunca derruba o slot.
- `priority_at` só acompanha `br-gap`; fora da janela o campo fica ausente.

```rust
use adom_harvest::{HarvestIntent, HarvestQueue};

queue.inflight_mut().begin(&identity, HarvestIntent::from_entry(&entry));
let out = queue.enqueue(HarvestRequest::movie("tt0111161", "br-gap"));
assert_eq!(out.reason, EnqueueReason::Coalesced); // nada novo na fila
queue.inflight().pending(&identity); // intenção efetiva após o drain
```

## O que NÃO está aqui (Fase E real)

- Ponte do `BrEvidence` para o índice real (`lookupQuiet` / `hasBrDubbed`).
- Seed IMDb, sonda `brProbe` completa, **cliente** Jackett (quem preenche
  `HarvestDrainAsync` é o gateway), painel.

## Testes

```bash
cargo test -p adom-harvest
```
