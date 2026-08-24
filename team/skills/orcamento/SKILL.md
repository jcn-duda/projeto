---
name: adom-orcamento
description: Domínio do orçamento de tempo da resposta do Adom (deadline do Stremio ~10s). Use ao auditar ou mexer em qualquer etapa de rede do caminho de busca, para garantir que ela caiba na cadeia REPLY_DEADLINE -> DEBRID_RESERVE -> grace -> floor.
---

# Cronos — Cronógrafo do Orçamento

Tempo é sagrado. O cliente Stremio aborta em ~10s; cada passo de rede precisa
caber na cadeia de orçamento, e quem quebra a regra vira "reabra em instantes"
em vez de lista.

## Quando usar

- Ao adicionar/alterar qualquer chamada de rede num provider **global**.
- Ao mexer em metadados (Cinemeta/TMDB), coleta, checagem de cache ou autofetch.
- Ao revisar se um timeout literal novo está dentro da cadeia de config.

## A cadeia (defaults)

```
tempo que sobrou do deadline − DEBRID_RESERVE_MS (4500) = orçamento da coleta
REPLY_DEADLINE_MS (9200)               prazo absoluto da resposta
BR_PARTIAL_GRACE_MS (1500), sem invadir DEBRID_CHECK_FLOOR_MS (1500)
JACKETT_INDEXER_TIMEOUT_MS (4000)      teto por indexer global, dentro do orçamento
JACKETT_BR_INDEXER_TIMEOUT_MS (20000)  total BR — PODE passar do deadline
JACKETT_DOWNLOAD_TIMEOUT_MS (8000)     teto por salto DENTRO do orçamento BR
DEBRID_CHECK_FORMAT_MARGIN_MS (500)    o que a checagem pode gastar na resposta
```

Orçamento da coleta é **dinâmico**: `collectRaw` recebe `deadlineAt` e calcula
`remainingCheckBudget(deadlineAt) − debridReserve`, com piso de 500ms. Não é
fatia fixa de `replyDeadline`.

## Arquivos-âncora

- `src/utils/deadline.ts`
- `src/config.ts`
- `src/providers/search-orchestrator.ts`
- `src/providers/collection-window.ts`
- `test/search-budget-metadata.test.ts`

## Guardrails

1. Uma etapa de rede nova num provider **global** precisa caber no orçamento da
   coleta e usar o `AbortSignal` da busca (o bug histórico foi resolve somando o
   próprio timeout por cima).
2. Os indexers globais cabem no orçamento; os **BR não** (orçamento próprio de
   20s, pode passar do deadline).
3. A graça BR respeita `DEBRID_CHECK_FLOOR_MS`.
4. Nada de timeout literal hardcoded fora de `src/config.ts`.

## Contrato de saída (auditoria)

```json
{"area":"orcamento","risks":[{"severity":"alta|media|baixa","file":"arquivo:linha","summary":"...","note":"..."}],"comentarios":["..."]}
```
Cite sempre `arquivo:linha`. Sem achado material -> `risks: []`.
