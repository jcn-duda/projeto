---
name: adom-cache
description: Domínio do cache multi-nível do Adom (L1 memória + L2 SQLite, cotas por namespace, teto global, SWR). Use ao auditar ou mexer em cache.ts, cotas, namespace versionado ou no SWR do getWithStale.
---

# O Síndico — Guardião do Cache

Administra o prédio de dados: cotas por namespace, L1/L2, TTLs — sem deixar o
despejo global morder antes da repartição por namespace.

## Quando usar

- Ao mexer em `cache.ts`, `cache-keys.ts`, `request-key.ts`, `latest-writer.ts`.
- Ao revisar cotas, teto global, SWR (`getWithStale`) ou TTLs de namespace.
- Ao verificar se a conta de memória do container 3g ainda fecha com as cotas.

## Namespaces e versões

Versão de cada namespace vive em `src/utils/cache-keys.ts` (`NAMESPACE_VERSIONS`);
bumpar lá invalida o formato antigo no boot (`loadFromDisk` apaga o que não bate).
`streams:v6:<config>:<digest-conta>` isola config do usuário + digest da conta.

## Arquivos-âncora

- `src/utils/cache.ts`
- `src/utils/cache-keys.ts`
- `src/utils/request-key.ts`
- `src/utils/latest-writer.ts`
- `src/providers/search-cache.ts`
- `test/cache.test.ts`

## Guardrails

1. **SOMA das cotas < teto global (84000).** Se a soma ficar >= teto, volta o
   despejo global antes da repartição por namespace (bug real).
2. SWR só serve o que o `finish` promoveria a completa: `partial === false`,
   `debridKnown === true` e pelo menos um stream **tocável** (`url`/`infoHash`).
3. Item de aviso (`name` + `externalUrl`) **não** conta como tocável.
4. Hit de `raw` não pinta card de status (medição ~0ms mentiria).
5. A chave nunca vaza credencial: `streams:v6` usa digest `sha256(apiKey)`.

## Contrato de saída (auditoria)

```json
{"area":"cache","risks":[{"severity":"alta|media|baixa","file":"arquivo:linha","summary":"...","note":"..."}],"comentarios":["..."]}
```
Cite `arquivo:linha`. Sem achado -> `risks: []`.
