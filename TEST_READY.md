# TEST_READY — Suíte E2E e Hardening

## Estado

A suíte E2E está integrada ao gate de regressão por meio de `npm test` e do
workflow CI para Node 18 e Node 22. Não adiciona dependências npm nem acessa
serviços externos: usa mocks de `fetch` e servidores HTTP efêmeros em loopback.

## Cobertura

- Tier 1: cobertura funcional das 14 features.
- Tier 2: limites, entradas malformadas e invariantes.
- Tier 3: interações, concorrência, debrid e passe tardio.
- Tier 4: cenários ponta a ponta de filme BR, série com passe tardio, autofetch,
  degradação de rede e configurações simultâneas.
- Tier 5: matriz adversarial de 10 mutações, mais stress sequencial e paralelo.

O cenário de passe tardio prova a transição no cache de resultado parcial para
completo e, portanto, detecta a remoção da escrita tardia.

## Execução verificada

- `npm run test:complete`: 28 arquivos de teste registrados.
- `npm test`: 467 testes aprovados.
- `npm run test:stress`: 154 verificações aprovadas.
- `npm run test:adversarial`: 10/10 mutações detectadas, 20 execuções
  sequenciais e 6 workers paralelos aprovados.

`test:adversarial` modifica e restaura arquivos-fonte para testar as mutações;
execute-o apenas sem alterações concorrentes no working tree.
