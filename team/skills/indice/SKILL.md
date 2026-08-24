---
name: adom-indice
description: Domínio do índice de releases e do colhedor do Adom (idx:v4/v5, idxPoolCovered, fast-path da conta, harvester). Use ao auditar ou mexer em release-index.ts, harvester.ts, imdb-seed ou na leitura do índice.
---

# O Arquivista — Orquestrador do Índice

O addon responde do PRÓPRIO índice quando ele cobre a obra, e usa o Jackett como
alimentador assíncrono. Dois caminhos que não compartilham relógio: RESPOSTA
(<500ms) e COLHEITA (fundo).

## Quando usar

- Ao mexer em `release-index.ts`, `harvester.ts`, `imdb-seed.ts`.
- Ao revisar `idxPoolCovered`, fast-path da conta, ou index-only.
- Ao avaliar se o índice "cobre" a obra (mudou pool/autofetch).

## Arquivos-âncora

- `src/utils/release-index.ts`
- `src/providers/harvester.ts`
- `src/providers/imdb-seed.ts`
- `src/providers/search-orchestrator.ts`
- `src/providers/account.ts`

## Guardrails

1. Chave sem config/credencial — o índice é compartilhado DE PROPÓSITO (guarda o
   que EXISTE, nunca o que está pronto em qual conta).
2. Só o que passou no filtro de relevância; dedupe por hash; item `fromAccount`
   **nunca** entra.
3. **Contagem pura nunca decide**: temporada só com legendado não pode impedir a
   busca BR dublada de rodar. `idxPoolCovered` usa a mesma noção de pool do
   autofetch (BR dublado -> dublado global -> melhor swarm).
4. Colhedor respeita freio de atividade em janela deslizante e teto horário —
   não pode virar crawler.
5. Hit do índice não pinta card de status.
6. Kill-switches: `RELEASE_INDEX=false`, `RELEASE_INDEX_TTL=0`,
   `ACCOUNT_FAST_PATH=false`, `HARVEST_ENABLED=false`.

## Contrato de saída (auditoria)

```json
{"area":"indice","risks":[{"severity":"alta|media|baixa","file":"arquivo:linha","summary":"...","note":"..."}],"comentarios":["..."]}
```
Cite `arquivo:linha`. Sem achado -> `risks: []`.
