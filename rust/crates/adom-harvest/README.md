# `adom-harvest` — embrião Fase E (fila do colhedor)

Crate **fora do caminho `/stream`**. Representa a fila persistente
`harvest:v1:q` que no TypeScript vive em `src/providers/harvest-queue.ts`,
orquestrada por `harvester.ts` / `harvest-worker.ts`.

Nesta fatia: **tipos + fila em memória + testes unitários**. Sem tick, sem
Jackett, sem índice, sem gateway, sem Docker.

## Contrato alinhado ao TS

| Conceito | TS | Rust (este crate) |
|---|---|---|
| Chave da fila | `prefix('harvest') + 'q'` → `harvest:v1:q` | `QUEUE_KEY` / `queue_key()` |
| Entrada | `HarvestEntry` | `HarvestEntry` |
| Resultado enqueue | `EnqueueOutcome` | `EnqueueOutcome` |
| Identidade | `obraIdentity` | `obra_identity` |
| Precedência | `reasonPriority` / `isPromotion` | `reason_priority` / `is_promotion` |
| Consumo | `takeHead` / `takeProbe` | `take_head` / `take_probe` |

Guardrails (iguais ao Arquivista):

1. Colhedor é **assíncrono** — nunca bloqueia a resposta do `/stream`.
2. Index-only fica **fora** do caminho de resposta (só o worker de fundo).
3. Contagem pura **nunca** decide cobertura do índice (`idxPoolCovered` —
   ainda não portado; mora no release-index).
4. `fromAccount` **nunca** entra no índice (fora do escopo desta fila).

## O que NÃO está aqui (Fase E real)

- Persistência L2 (`cache.set(harvest:v1:q, …)`) / SQLite espelhando o cache.
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
