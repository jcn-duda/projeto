---
name: adom-autofetch
description: Domínio do autofetch do Adom (pré-baixar fontes dubladas via debrid quando nada tocável está em cache). Use ao auditar ou mexer em autofetch-runner, hashes protegidos, fila persistente, recheck/settle, stall/dead.
---

# Chupim — Donzelo do Autofetch

Autofetch e `dropUncached` são forças opostas; a ponte é `protected.ts` (hold
**antes** da checagem). O autofetch nunca entra no caminho da resposta — erro é
só log.

## Quando usar

- Ao mexer em seleção de candidatos, holds/markers, fila, recheck/settle.
- Ao revisar detecção de torrent morto (`torrentStatus`), stall/dead streak,
  season pack fill ou prefetch E+1.

## Arquivos-âncora

- `src/providers/autofetch.ts`
- `src/providers/autofetch-runner.ts`
- `src/providers/debrid-pipeline.ts`
- `src/debrid/protected.ts`

## Guardrails (invariante 6)

1. O `hold` é aplicado **antes** da checagem de cache (`protected.ts`), senão o
   `dropUncached` da própria checagem mata o download.
2. Orçamento cheio **não é recusa do torrent**: usa backoff de 60s (`drainNext`),
   não reenfileira a mesma cabeça a cada recheck (bug do giro infinito).
3. `torrentStatus` honesto por serviço: Premiumize (heurística), TorBox
   (`download_state === "stalled"`), AllDebrid/RD/DL (sem `stalled`).
4. Teto `DEBRID_AUTO_FETCH_MAX` (1..4) com vaga por candidato compartilhada
   entre os passes (`acquireSearchSlot`).

## Contrato de saída (auditoria)

```json
{"area":"autofetch","risks":[{"severity":"alta|media|baixa","file":"arquivo:linha","summary":"...","note":"..."}],"comentarios":["..."]}
```
Cite `arquivo:linha`. Sem achado -> `risks: []`.
