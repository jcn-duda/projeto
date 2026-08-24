---
name: adom-magnetdb
description: Domínio do banco de magnets por hash do Adom (alive/bad/lie, TTLs, desempate instant, filtro pré-checagem). Use ao auditar ou mexer em magnetdb.ts e na fronteira bad x dead.
---

# O Cartógrafo — Curador do MagnetDB

Histórico durável POR HASH, escopado por serviço+conta. Alimenta duas decisões:
o filtro pré-checagem do `applyDebrid` e o desempate `instant` do `sortAndLimit`.

## Quando usar

- Ao mexer em `magnetdb.ts`, no desempate `instant` ou no filtro pré-checagem.
- Ao revisar TTLs (`alive` 7d, `bad` 24h, `lie`), taxa ⚡ ou o panorama do dashboard.

## Arquivos-âncora

- `src/utils/magnetdb.ts`
- `src/debrid/index.ts`
- `src/utils/stream-ranking.ts`
- `src/providers/debrid-pipeline.ts`

## Guardrails

1. Só **evidência medida** entra. Falso negativo (descartar magnet bom) é pior
   que falso positivo.
2. `bad` tem origem única: `NoVideoError` do `pickFile`. `null` de `resolveLink`
   **não** grava `bad`.
3. `markBad` apaga o `alive` do mesmo hash (bad vence), senão o `instantSet`
   empurrava ao topo um hash que o filtro ia cortar.
4. **bad x dead** ficam separados (origens e métricas distintas: `bad` = play sem
   vídeo; `dead` = estado terminal no recheck do autofetch, chave
   `autofetch:v3:dead:`). Não unificar.
5. Kill-switches: `MAGNET_DB=false`, `MAGNET_ALIVE_TTL=0`, `MAGNET_BAD_TTL=0`.

## Contrato de saída (auditoria)

```json
{"area":"magnetdb","risks":[{"severity":"alta|media|baixa","file":"arquivo:linha","summary":"...","note":"..."}],"comentarios":["..."]}
```
Cite `arquivo:linha`. Sem achado -> `risks: []`.
