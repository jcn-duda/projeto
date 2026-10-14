---
name: adom-testes
description: Domínio da infraestrutura e cobertura de testes do Adom (lista explícita no package.json, e2e-harness com fetch dublê, contratos de domínio, testes do cliente ESM, harnesses fora do CI). Use ao auditar ou mexer em test/, scripts/check-test-list.ts ou types/domain.d.ts.
---

# O Juiz — Mestre do Teste

Decide o que passa: portão do `npm test`, tipo do que a função **produz**,
falso-verde é prato dele.

## Quando usar

- Ao adicionar/alterar testes ou mexer na lista do `package.json`.
- Ao revisar o e2e-harness, o stub centralizado ou os contratos de domínio.
- Ao checar se um arquivo `.test.ts` novo entrou na lista.
- Ao testar o cliente ESM do painel (`src/client/`).

## Regras

- `npm test` roda `dist/`, então **build antes**. Editar `.ts` e rodar teste
  direto exercita a compilação anterior; build vermelho deixa `dist/` ausente
  ou incompleto (o build limpa antes do `tsc`).
- A lista do `npm test` é **explícita** (chave `testFiles` do `package.json`,
  não glob) — arquivo `.test.ts` novo que não entra nela passa despercebido e
  o CI fica verde à toa (por isso `test:complete`).
- **Tipo o que a função PRODUZ**, não só o que recebe. Contratos em
  `types/domain.d.ts`: `Stream` (união que exige ação), `ParsedSeasonEpisode`,
  `DebridAdapter`.
- Não usar `@ts-ignore`/cast espalhado; centralizar o dublê em `test/helpers/stub.ts`.
- **Regex de texto não é teste de comportamento.** Dois defeitos do
  `displayValue` sobreviveram a 1.507 testes porque os testes de painel casavam
  corpos de função dentro do html. Hoje o JS do painel é ESM em
  `src/client/<nome>/*.ts`: **importe o módulo real** do emit de Node
  (`dist/src/client/`) via `test/helpers/client.ts` ou
  `test/helpers/dashboard.ts` (DOM falso em `test/helpers/dashboard-dom.ts`) e
  afirme a saída. Nada de `new Function(fonte)`, regex de corpo de função ou
  ordem de `<script>`.
- **Catraca de linhas** (`npm run lint:lines -- --check` no CI): teto de 400
  sobre `.ts`/`.js`/`.css`. O baseline `.line-budget.json` está vazio, então
  arquivo de teste que passa de 400 **reprova sem escape** — `--bless` não
  admite arquivo novo; divida o teste. Rascunho ainda não adicionado ao git
  também é medido.
- **Harnesses fora do CI:** 10 arquivos em 6 scripts (`test:stress`,
  `test:adversarial`, `test:adversarial-m1`, `test:protector-m1`,
  `test:challenger-m2`, `test:ranking-challenger`), cobrados pelo
  `test:complete`. O `test:adversarial` muta `dist/` e amarra `testFile` a nome
  de arquivo: ao mover símbolo entre módulos, confirme que a mutação continua
  capturada.

## Arquivos-âncora

- `package.json`
- `test/` (os `.test.ts` essenciais)
- `scripts/check-line-budget.ts` + `.line-budget.json`
- `test/e2e/e2e-harness.ts`
- `test/helpers/stub.ts`
- `test/helpers/client.ts`, `test/helpers/dashboard.ts`, `test/helpers/dashboard-dom.ts`
- `tsconfig.client.test.json`
- `scripts/check-test-list.ts`
- `types/domain.d.ts`
- `test/fixtures/`

## Contrato de saída (auditoria)

```json
{"area":"testes","risks":[{"severity":"alta|media|baixa","file":"arquivo:linha","summary":"...","note":"..."}],"comentarios":["..."]}
```
Cite `arquivo:linha`. Sem achado -> `risks: []`. (Não rode a suíte via `node
--test`/`npm test` se o sandbox bloquear spawn; rode `node <arquivo>` direto.)
