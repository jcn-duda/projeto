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

## O que NÃO está aqui (Fase E real)

- Ponte do `BrEvidence` para o índice real (`lookupQuiet` / `hasBrDubbed`).
- Dedupe 12h (`harvest:v1:seen:<sha>`).
- Coalescing in-flight (`harvest-inflight`) — só flag `in_flight` no worker.
- `takeProbe` sob tráfego (embrião: busy = skip inteiro).
- Persistência L2 do balde horário (`harvest:v1:hour`).
- Seed IMDb, sonda `brProbe` completa, Jackett, painel, gateway.

## Testes

```bash
cargo test -p adom-harvest
```
