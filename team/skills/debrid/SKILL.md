---
name: adom-debrid
description: Domínio da camada de debrid do Adom (registry de adaptadores, cacheCheck honesto, limpeza da conta, pickFile). Use ao auditar ou mexer em src/debrid/*, na semântica known:false/unusable ou na limpeza da conta.
---

# O Fiandeiro — Fiandeiro do Debrid

Tece e desfia a conta: mede ⚡ mas limpa (`dropUncached`/`dropReady`) — o preço
de tecer. Nada no resto do código conhece um serviço específico; o registry
(`src/debrid/index.ts`) é a fronteira.

## `cacheCheck` honesto

| Serviço | `cacheCheck` | Como sabe |
|---|---|---|
| Premiumize | `true` | lote instantâneo |
| TorBox | `true` | lote instantâneo |
| AllDebrid | `true` | `ready` do `/magnet/upload` (o `/magnet/instant` morreu) |
| Real-Debrid | `false` | sem consulta; o play adiciona o magnet |
| Debrid-Link | `false` | idem |

Declarar `cacheCheck:true` sem endpoint funcional é o pior dos mundos.

## Semântica de `checkCached`

- `known:true` -> confia; cacheados ganham ⚡, `cachedOnly` vale.
- `known:false` -> **não é "nada em cache"**; todos passam pelo debrid sem ⚡,
  `cachedOnly` ignorado. O passe tardio tenta de novo (`needsFullRefresh`).
- `unusable:{reason}` -> serviço não vai funcionar por motivo que só o usuário
  conserta (auth/quota); lista volta como **P2P**.

## Arquivos-âncora

- `src/debrid/index.ts`, `common.ts`, `file-selector.ts`, `protected.ts`
- `src/debrid/alldebrid.ts`, `premiumize.ts`, `realdebrid.ts`, `torbox.ts`, `debridlink.ts`
- `src/providers/account.ts`

## Guardrails

1. AllDebrid tem `cacheCheck:true` via upload; a consulta SUJA a conta — por
   isso `dropReady` remove o pronto e `dropUncapped` o não-pronto.
2. `batched()` propaga o erro quando TODOS os lotes falham.
3. `null` de `resolveLink` **não** grava `bad` (cobre "ainda baixando"/recusado).
4. Serviço `unusable` não pede `needsFullRefresh` nem roda autofetch.
5. Contrato `DebridAdapter` consistente (`types/domain.d.ts`).

## Contrato de saída (auditoria)

```json
{"area":"debrid","risks":[{"severity":"alta|media|baixa","file":"arquivo:linha","summary":"...","note":"..."}],"comentarios":["..."]}
```
Cite `arquivo:linha`. Sem achado -> `risks: []`.
