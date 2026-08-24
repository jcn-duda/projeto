---
name: adom-fontes
description: Domínio do plano de busca do Adom (isolamento BR/slow, circuito breaker, varredura pt-BR inline x tardia). Use ao auditar ou mexer em search-plan, collection-window, indexer-status, jackett ou no catálogo de indexers.
---

# O Maestro — Estrategista de Fonte

Rege o plano de busca: isola BR/slow, rege o breaker, calibra a varredura pt-BR
(inline x tardia).

## Quando usar

- Ao mexer em `search-plan.ts`, `collection-window.ts`, `indexer-status.ts`.
- Ao revisar o breaker, index-only x slow, ou a varredura pt-BR nos globais.

## Arquivos-âncora

- `src/providers/search-plan.ts`
- `src/providers/collection-window.ts`
- `src/providers/indexer-status.ts`
- `src/providers/jackett.ts`
- `src/providers/jackett-catalog.ts`

## Guardrails

1. Globais cabem no orçamento da coleta; **BR não** (orçamento próprio de 20s,
   pode passar do deadline).
2. `slow`/`degraded` não abrem o circuito; só `offline` em N amostras.
   `/test-indexer.json` ignora o breaker (é ele quem repara).
3. Varredura inline NÃO ganha `ignoreBreaker` (o breaker existe para o indexer
   morto não comer o prazo); a **tardia** tem `ignoreBreaker: true`.
4. `JACKETT_SLOW_INDEXERS` e os index-only são conceitos diferentes: um é o
   agrupamento do plano, outro é presença na resposta.
5. `JACKETT_INDEX_ONLY_INDEXERS` (redetorrent/apachetorrent/hdrtorrent) ficam
   fora do caminho da resposta e dentro do sistema via colhedor.

## Contrato de saída (auditoria)

```json
{"area":"fontes","risks":[{"severity":"alta|media|baixa","file":"arquivo:linha","summary":"...","note":"..."}],"comentarios":["..."]}
```
Cite `arquivo:linha`. Sem achado -> `risks: []`.
