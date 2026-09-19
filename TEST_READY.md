# TEST_READY — Suíte E2E e Hardening

## Estado

A suíte E2E está integrada ao gate de regressão por meio de `npm test` e do
workflow CI para Node 20 e Node 22. Não adiciona dependências npm nem acessa
serviços externos: usa mocks de `fetch` e servidores HTTP efêmeros em loopback.

## Cobertura

- Tier 1: cobertura funcional das 14 features.
- Tier 2: limites, entradas malformadas e invariantes.
- Tier 3: interações, concorrência, debrid e passe tardio.
- Tier 4: cenários ponta a ponta de filme BR, série com passe tardio, autofetch,
  degradação de rede e configurações simultâneas.
- Tier 5: matriz adversarial de 10 mutações, mais stress sequencial e paralelo.
- Clientes ESM do painel (`/configure` e `/dashboard`): os testes importam o
  emit de Node de `src/client/` com DOM falso (`test/helpers/client.ts`,
  `test/helpers/dashboard.ts`) e amarram o grafo emitido à allowlist
  `CLIENT_ASSETS`.

O cenário de passe tardio prova a transição no cache de resultado parcial para
completo e, portanto, detecta a remoção da escrita tardia.

## Execução verificada

Snapshot de 2026-09-12 no `5e28d7d` (branch `esm`, ESM total e resolvedores em
TypeScript), Node 22.23.2
local; reconfirme após alterações grandes na suíte.

- `npm run test:complete`: 237 arquivos de teste registrados e 10 harnesses validados.
- `npm test`: 2269 testes aprovados, 0 falhas.
- `npm run test:stress`: 154 verificações aprovadas (12 + 7 + 135).
- `npm run test:adversarial`: 10/10 mutações detectadas, 20 execuções
  sequenciais e 6 workers paralelos aprovados.
- `npm run typecheck`: zero erros nos três programas.

`test:adversarial` modifica e restaura os arquivos compilados em `dist/` para
testar as mutações; execute-o apenas sem alterações concorrentes no working
tree (e rebuild antes, se `dist/` estiver velho).
