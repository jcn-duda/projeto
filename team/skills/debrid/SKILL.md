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

## Ocupação da conta AllDebrid (Fase 8)

Consultar cache **escreve** na conta, então existe uma maquinaria inteira só
para ela não encher. Ordem em que as peças agem:

| Peça | Alcança | Default |
|---|---|---|
| `dropReady` / `dropUncached` | o que ESTA busca subiu | ON |
| `adsub:v1` (posse durável) | não apaga nada — decide **de quem é** | ON (TTL 7d) |
| `adrm:v1` (anti-reenchimento) | impede re-subir o que a limpeza apagou | ON (TTL 3d) |
| `sweepDead` / `sweepUndubbed` | morto / pronto sem áudio PT — NATIVAS (`al_sweeps` no gateway) | agendadas; só apagam com `DEBRID_AL_SWEEP_APPLY` (código OFF, compose ON) |
| `reconcile` / `revalidate` | posse órfã que a limpeza NÃO alcançou (H2) e fila `sup:` — nativas, sem arquivo TS | mesmo gate `DEBRID_AL_SWEEP_APPLY` |
| evicção por busca (`evict_step`/`evict_job`) | mais antigos provadamente estrangeiros | passagem do worker nativo (não é varredura) |

Três coisas que só se aprende errando:

- **Posse em memória é catraca.** Enquanto `submitted` era um `Map`, o restart
  apagava a posse e o snapshot seguinte adotava o lixo do próprio addon como
  acervo do usuário — imortal. Com deploy a cada hora, a conta foi de ~0 a 904
  em 8 dias. Toda posse precisa sobreviver ao restart.
- **Ausência de dado nunca autoriza remoção.** Snapshot `null`, `uploadDate`
  ausente, inventário frio: em todos, o certo é **não apagar**. Vale para
  `dropReady`, `dropDownload`, sweeps, evicção e reconcile, sem exceção.
- **Supressão ≠ decisão.** Não apagar porque o snapshot prova que é do usuário
  é decisão; não apagar porque o snapshot não chegou é falta de autoridade, e o
  hash fica órfão. Contam separado (`debrid.drop.suppressedReady`); somar os
  dois escondeu um vazamento por semanas.

## Arquivos-âncora

- `src/debrid/index.ts`, `common.ts`, `file-selector.ts`, `protected.ts`
- `src/debrid/alldebrid*.ts` — **família de módulos**, não um arquivo:
  `-api`, `-check` (a checagem que é upload), `-inventory` (`knownBefore` +
  `adsub`), `-cleanup` (gate único `deleteMagnets`) + `-cleanup-facts`,
  `-reupload` (`adrm`), `-play`. `alldebrid.ts` é só fachada. As varreduras
  (`sweepDead`/`sweepUndubbed`/`reconcile`/`revalidate`) não têm arquivo aqui:
  são o `al_sweeps` do gateway
- `premiumize.ts`, `realdebrid.ts`, `torbox.ts`, `debridlink.ts`
- `src/debrid/account-status.ts`

## Guardrails

1. AllDebrid tem `cacheCheck:true` via upload; a consulta SUJA a conta — por
   isso `dropReady` remove o pronto e `dropUncached` o não-pronto.
2. `batched()` propaga o erro quando TODOS os lotes falham.
3. `null` de `resolveLink` **não** grava `bad` (cobre "ainda baixando"/recusado).
4. Serviço `unusable` não pede `needsFullRefresh` nem roda autofetch.
5. Contrato `DebridAdapter` consistente (`types/domain.d.ts`).
6. **Todo caminho que deleta passa pelo gate único** (`deleteMagnets`) e vale
   **só para a conta do operador** — chave BYO de instalação nunca sofre
   varredura, evicção ou reconcile.
7. **Blindagem BR é inegociável na limpeza.** Origem de site BR no nome ou
   título em português nunca condena, mesmo sem a palavra "dublado". A regra
   serve para NÃO apagar: errar protegendo é o lado certo do erro. Falso
   positivo aqui destrói acervo que custou horas de download.
8. Posse só se etiqueta com **prova de criação** (hash ausente do snapshot), e
   só se purga quando o magnet saiu **de verdade** (`removedIds`) — falha de
   delete não purga, porque o magnet continua lá e continua sendo nosso.

## Contrato de saída (auditoria)

```json
{"area":"debrid","risks":[{"severity":"alta|media|baixa","file":"arquivo:linha","summary":"...","note":"..."}],"comentarios":["..."]}
```
Cite `arquivo:linha`. Sem achado -> `risks: []`.
