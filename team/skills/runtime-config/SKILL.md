---
name: adom-runtime-config
description: Domínio da configuração por usuário do Adom (overlay via AsyncLocalStorage + opts(), selo AES do dk, SCHEMA <-> KEYS do front). Use ao auditar ou mexer em runtime.ts, config.ts, secret-box.ts ou no contrato da URL de install.
---

# O Chaveiro — Guardião do Runtime/Config

As preferências do usuário viajam codificadas na URL de instalação
(`/<base64url>/manifest.json`), não em banco. O servidor é stateless.
`config.ts` = padrões do **operador** (`.env`); `runtime.ts` = overlay do
**usuário**, por requisição, em `AsyncLocalStorage`.

## Regra central

O que o usuário pode escolher lê-se por **`opts()`**. Nunca ler
`config.maxResults`/`config.provider`/`config.debrid.apiKey` direto no caminho
de busca — esses foram movidos para `opts()` e ler o estático de volta faz a
config do usuário ser silenciosamente ignorada.

## Timers pós-request

Timers e promises que disparam **depois** da request saem do `AsyncLocalStorage`.
Capture com `runtime.capture()` **dentro** da request e restaure com
`runtime.run()` — senão `opts()` lê o `.env` e regrava o cache com a config
errada.

## Arquivos-âncora

- `src/runtime.ts`
- `src/config.ts`
- `src/utils/secret-box.ts`
- `src/public/configure.html` (HTML + CSS; o JS saiu para `src/client/configure/`
  e o HTML só carrega o entry ESM `/client/configure/entry.js`)
- `src/client/configure/*.ts` (cliente ESM nativo: `keys.ts` tem o `KEYS`,
  `view.ts` o `collect`/`render`/presets, `init.ts` o `apply`/`fromUrl`/wiring;
  emitido por `tsconfig.client.json` no browser e por
  `tsconfig.client.test.json` no Node para os testes)
- `src/routes/public.ts` (inclui a allowlist FECHADA `PAGE_ASSETS` e a
  `CLIENT_ASSETS` do cliente de `/configure`)
- `src/routes/register.ts` (ordem: rota sem config antes do overlay `/:userConfig`)

## Guardrails

1. No caminho de busca, config do usuário NUNCA por `config.*` direto — `opts()`.
2. Toda opção nova tem `SCHEMA` + `defaults()` (chave curta) + controle no `KEYS`
   do front em **sincronia**.
3. Segmento que não decodifica -> 404 (senão qualquer caminho viraria manifest
   válido servindo o `.env`).
3b. Asset novo do painel entra na `PAGE_ASSETS` **por nome**. Nome arbitrário
   vindo da URL abriria leitura fora de `public/`; o HTML referencia por
   caminho ABSOLUTO (`/configure.css`) porque a página responde tanto em
   `/configure` quanto em `/<config>/configure`; e o `?v=<hash>` é injetado no
   HTML em memória (a rota casa pelo path, então a query não entra na
   allowlist) — é o que permite `maxAge` de 30d sem skew de deploy.
3c. Módulo do cliente ESM de `/configure` entra na `CLIENT_ASSETS` **por nome**
   (caminho aninhado `client/configure/<arquivo>.js`). O entry versionado é
   `immutable`; os filhos importados saem `no-cache` e revalidam por ETag/304.
   Mexer no cliente é editar `src/client/configure/*.ts`, nunca o `.js` emitido.
4. `prefix()` carrega a mesma config no link de play (`/resolve`).

## Contrato de saída (auditoria)

```json
{"area":"runtime_config","risks":[{"severity":"alta|media|baixa","file":"arquivo:linha","summary":"...","note":"..."}],"comentarios":["..."]}
```
Cite `arquivo:linha`. Sem achado -> `risks: []`.
