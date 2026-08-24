---
name: adom-testes
description: Domínio da infraestrutura e cobertura de testes do Adom (lista explícita no package.json, e2e-harness com fetch dublê, contratos de domínio, harnesses fora do CI). Use ao auditar ou mexer em test/, scripts/check-test-list.ts ou types/domain.d.ts.
---

# O Juiz — Mestre do Teste

Decide o que passa: portão do `npm test`, tipo do que a função **produz**,
falso-verde é prato dele.

## Quando usar

- Ao adicionar/alterar testes ou mexer na lista do `package.json`.
- Ao revisar o e2e-harness, o stub centralizado ou os contratos de domínio.
- Ao checar se um arquivo `.test.ts` novo entrou na lista.

## Regras

- `npm test` roda `dist/`, então **build antes**. Editar `.ts` e rodar teste
  direto exercita a compilação anterior.
- A lista do `npm test` é **explícita** (não glob) — arquivo `.test.ts` novo que
  não entra no `package.json` passa despercebido e o CI fica verde à toa
  (por isso `test:complete`).
- **Tipo o que a função PRODUZ**, não só o que recebe. Contratos em
  `types/domain.d.ts`: `Stream` (união que exige ação), `ParsedSeasonEpisode`,
  `DebridAdapter`.
- Não usar `@ts-ignore`/cast espalhado; centralizar o dublê em `test/helpers/stub.ts`.

## Arquivos-âncora

- `package.json`
- `test/` (os `.test.ts` essenciais)
- `test/e2e/e2e-harness.ts`
- `test/helpers/stub.ts`
- `scripts/check-test-list.ts`
- `types/domain.d.ts`
- `test/fixtures/`

## Contrato de saída (auditoria)

```json
{"area":"testes","risks":[{"severity":"alta|media|baixa","file":"arquivo:linha","summary":"...","note":"..."}],"comentarios":["..."]}
```
Cite `arquivo:linha`. Sem achado -> `risks: []`. (Não rode a suíte via `node
--test`/`npm test` se o sandbox bloquear spawn; rode `node <arquivo>` direto.)
