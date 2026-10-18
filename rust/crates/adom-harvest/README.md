# `adom-harvest` — embrião Fase E (fila do colhedor)

Crate **fora do caminho `/stream`**. Representa a fila persistente
`harvest:v1:q` que no TypeScript vive em `src/providers/harvest-queue.ts`,
orquestrada por `harvester.ts` / `harvest-worker.ts`.

Nesta fatia: **tipos + fila em memória + L2 SQLite (WAL) + testes**. Sem tick,
sem Jackett, sem índice, sem gateway, sem Docker.

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
queue.load_from(&store, now_ms)?;
queue.enqueue(HarvestRequest::movie("tt0111161", "miss"));
queue.save_to(&store, DEFAULT_ENTRY_TTL_SECONDS, now_ms)?;
```

## O que NÃO está aqui (Fase E real)

- `prioritizeQueue` com evidência BR (`hasBrDubbed` + `lookupQuiet`).
- Dedupe 12h (`harvest:v1:seen:<sha>`).
- Coalescing in-flight (`harvest-inflight`).
- Ciclo tick/drain, freio de tráfego, teto horário (`harvester.ts` /
  `harvest-worker.ts`).
- Seed IMDb, sonda `brProbe` completa, painel.

## Testes

```bash
cargo test -p adom-harvest
```
