# `adom-harvest` — embrião Fase E (fila do colhedor)

Crate **fora do caminho `/stream`**. Representa a fila persistente
`harvest:v1:q` que no TypeScript vive em `src/providers/harvest-queue.ts`,
orquestrada por `harvester.ts` / `harvest-worker.ts`.

Nesta fatia: **tipos + fila em memória + L2 SQLite (WAL) + ciclo `tick`
(freio/teto/drain stub) + testes**. Sem Jackett real, sem índice, sem gateway,
sem Docker.

## Contrato alinhado ao TS

| Conceito | TS | Rust (este crate) |
|---|---|---|
| Chave da fila | `prefix('harvest') + 'q'` → `harvest:v1:q` | `QUEUE_KEY` / `queue_key()` |
| Entrada | `HarvestEntry` | `HarvestEntry` |
| Resultado enqueue | `EnqueueOutcome` | `EnqueueOutcome` |
| Identidade | `obraIdentity` | `obra_identity` |
| Precedência | `reasonPriority` / `isPromotion` | `reason_priority` / `is_promotion` |
| Consumo | `takeHead` / `takeProbe` | `take_head` / `take_probe` |
| L2 | `cache.get` / `cache.set(QUEUE_KEY, …)` | `HarvestStore::load` / `save` |
| Dedupe 12h | `queueDedupeKey` / `wasRecentlyQueued` / `markRecentlyQueued` | `seen_key` / `was_recently_queued` / `mark_recently_queued` (`seen.rs`) |
| Balde horário | `HOUR_KEY` / `hourBucketTtlSeconds` / `hydrateCurrentHour` | `hour_key` / `hour_ttl_seconds` / `load_hour` / `save_hour` + `HarvestWorker::hydrate_hour` (`hour.rs`) |
| Flush | `load()` / `persist()` | `HarvestQueue::load_from` / `save_to` |
| Prioridade | `prioritizeQueue` + `hasBrDubbed(lookupQuiet)` | `prioritize` + trait `BrEvidence` (stub/callback; índice real ainda não) |
| Ciclo | `harvester.tick` / `harvestWorker` | `HarvestWorker::tick` + `TrafficSense` + `HarvestDrain` |

### Ciclo tick (embrião)

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

- Freio: `TrafficSense::is_busy()` ⇒ `SkippedBusy` (sem consumir fila).
- Teto: `queries_this_hour` / `note_queries` por balde UTC; `>= max_per_hour` ⇒ skip.
- Drain sync stub — async / Jackett ficam para depois.

Guardrails (iguais ao Arquivista):

1. Colhedor é **assíncrono** — nunca bloqueia a resposta do `/stream`.
2. Index-only fica **fora** do caminho de resposta (só o worker de fundo).
3. Contagem pura **nunca** decide cobertura do índice (`idxPoolCovered` —
   ainda não portado; mora no release-index).
4. `fromAccount` **nunca** entra no índice (fora do escopo desta fila).
5. Gateway **não** pluga este crate.

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

## O que NÃO está aqui (Fase E real)

- Ponte do `BrEvidence` para o índice real (`lookupQuiet` / `hasBrDubbed`).
- Coalescing in-flight (`harvest-inflight`) — só flag `in_flight` no worker.
- `takeProbe` sob tráfego (embrião: busy = skip inteiro).
- Seed IMDb, sonda `brProbe` completa, Jackett, painel, gateway.

## Testes

```bash
cargo test -p adom-harvest
```
