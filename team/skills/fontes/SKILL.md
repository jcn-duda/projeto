---
name: adom-fontes
description: Domínio do plano de busca do Adom (isolamento BR/slow, circuito breaker, varredura pt-BR inline x tardia). Use ao auditar ou mexer no plano de busca nativo (`adom-core::search_plan`), na janela de coleta (`adom-search::collection_window`), em indexer-status ou no catálogo de indexers.
---

# O Maestro — Estrategista de Fonte

Rege o plano de busca: isola BR/slow, rege o breaker, calibra a varredura pt-BR
(inline x tardia).

## Quando usar

- Ao mexer em `rust/crates/adom-core/src/search_plan.rs`,
  `rust/crates/adom-search/src/collection_window.rs` ou `src/providers/indexer-status.ts`.
- Ao revisar o breaker, index-only x slow, ou a varredura pt-BR nos globais.

## Arquivos-âncora

- `rust/crates/adom-core/src/search_plan.rs` (porta de `search-plan.ts`; o TS foi
  removido na Fase 5)
- `rust/crates/adom-search/src/collection_window.rs` (porta de
  `collection-window.ts`, com os orçamentos em `collection_window_budgets.rs`)
- `src/providers/indexer-status.ts`
- `rust/crates/adom-sources/src/jackett/` (cliente Torznab, breaker, `query.rs`
  com `shape_search_query`, results/Cardigann)
- `rust/crates/adom-search/src/orchestrator/jackett_collector.rs`
  (`plan_jackett_searches`: a varredura inline sem `ignore_breaker`, a tardia com
  `record_status:false` + `ignore_breaker:true`)
- `rust/crates/adom-search/src/orchestrator/late.rs` (fila tardia: promoção,
  refresh de debrid, varredura pt-BR e index-write)
- `rust/crates/adom-server/src/harvest/drain.rs` (colheita nativa: Jackett +
  metadados + índice; `record_status:false`, breaker próprio)
- `src/providers/jackett-catalog.ts`

## Guardrails

1. Globais cabem no orçamento da coleta; **BR não** (orçamento próprio de 20s,
   pode passar do deadline).
2. `slow`/`degraded` não abrem o circuito; só `offline` em N amostras.
   `/test-indexer.json` responde 410 (a coleta é nativa); a sonda viva é
   `POST /harvest/drain` na admin do gateway, que **não** repara o breaker.
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
