# Colhedor — Correções + Cobertura BR (Design)

Data: 2026-08-30
Status: aprovado
Escopo: `src/providers/harvest-worker.ts`, dois pontos em
`src/providers/harvester.ts`, testes em `test/harvester.test.ts`. Nada toca o
`tick`, a fila, a semente ou o índice.

## Contexto

O colhedor mantém o índice de releases (`idx:v6`) vivo em fundo: fila
persistente de obras, teto horário de consultas (120/h), janela de ociosidade
(10 min), varredura pt-BR nos globais + laço de indexers por obra (~31
consultas/obra ≈ 4 obras/h). A análise encontrou três defeitos de contrato e
dois buracos de cobertura BR:

1. **Config ao vivo ignorada dentro do worker.** O `tick` lê
   `live.harvestMaxPerHour`/`live.harvestIdleWindowMs`, mas o `harvestOne` lê
   os estáticos `config.harvest.maxPerHour`/`config.harvest.idleWindowMs`
   (harvest-worker.ts:111,117,147,148). Mudar esses dois campos no painel só
   afeta a decisão de *começar* a obra — dentro dela vale o `.env`.
2. **`topReleases` não é top.** O envio ao rdWarmer mapeia score 80/40/5 mas
   o `.slice(0, 10)` pega os 10 primeiros na ordem de coleta, sem ordenar —
   BR dublado pode ficar fora do warmer (harvest-worker.ts:192-205).
3. **`checkQuotaWarning` a cada tick.** Cada ciclo ocioso (60s) chama
   `accountStatus` do debrid sem cooldown (harvester.ts:69).
4. **bludv só com título pt do TMDB.** `if (config.bludv.enabled && ptQuery)`
   — obra sem título pt-BR no TMDB nunca consulta o BluDV na colheita.
5. **Varredura pt-BR tudo-ou-nada.** Se o teto não cobre os 12 alvos inteiros,
   a varredura é pulada por completo — e ela é quem acha o dublado titulado em
   PT nos trackers globais.

## Mudanças

### M1 — Config ao vivo dentro do worker (bug 1)

`harvestOne` captura `const live = harvesterLive.effective()` UMA vez no topo
e substitui:

- `config.harvest.idleWindowMs` → `live.harvestIdleWindowMs` (2 usos);
- `config.harvest.maxPerHour` → `live.harvestMaxPerHour` (2 usos).

Snapshot único no início (não releitura por iteração): o guard
`queriesThisHour() + attempted >= teto` precisa de um teto estável durante a
obra. `indexerDelayMs` já é live e não muda.

### M2 — rdWarmer recebe o BR primeiro (bug 2 + cobertura)

`topReleases` ganha `.sort((a, b) => b.score - a.score)` antes do
`slice(0, 10)`. Teto 10 mantido (educação com o oracle RD). Com score 80/40/5,
BR dublado passa a ocupar as vagas do warmer sempre que existir.

### M3 — Cooldown no aviso de quota (bug 3)

Marcador no cache `harvest:v1:quotaWarn` com TTL = cooldown:

- Padrão 6h; env nova `HARVEST_QUOTA_WARN_COOLDOWN_MS` (0 desliga o cooldown,
  não o aviso).
- Com marcador presente, `checkQuotaWarning` retorna sem chamar
  `accountStatus`.
- Fail-open: erro ao ler/gravar o marcador não impede o aviso; erro na própria
  `accountStatus` NÃO grava marcador (rede caída tenta de novo no tick
  seguinte — a checagem é barata quando o erro é instantâneo).
- O marcador é gravado a cada checagem BEM-SUCEDIDA, sã ou não a conta. O
  problema é a chamada de rede a cada 60s, não só o spam do webhook: com o
  cooldown na checagem, a conta leva no máximo uma consulta por janela; o
  aviso em si continua condicionado a `magnets >= magnetsWarn`.

### M4 — bludv com fallback de query (cobertura)

`const bludvQuery = ptQuery || query;` e a condição vira só
`config.bludv.enabled`. Site BR publica post em PT que casa com título
original o tempo todo; sem título pt no TMDB a colheita não pode ficar cega ao
BluDV.

### M5 — Varredura pt-BR parcial (cobertura)

Guard atual: `queriesThisHour() + sweepTargets.length >= config.harvest.maxPerHour`
pula tudo. Nova lógica:

```
const restante = live.harvestMaxPerHour - queriesThisHour();
const fatia = restante > 0 ? sweepTargets.slice(0, restante) : [];
if (!fatia.length) { log de teto; } else { varre só a `fatia` }
```

- A fatia respeita o gap por indexer existente e conta na mesma moeda do teto
  (`attempted += fatia.length`).
- Ordem dos alvos é a que `ptSweepIndexers` já devolve (sem reordenação nova).
- Métrica nova `harvest.sweep.partial` conta as vezes em que a fatia foi menor
  que o total de alvos.

### M6 — Descarte por cortes repetidos deixa rastro (observabilidade)

No `tick`, ramo da obra cortada com `tries > 3`: além de limpar o contador,
`metrics.count('harvest.capped.dropped')` — hoje a obra some da fila sem sinal.

## Fora de escopo

- Vazão do ciclo (deadline por obra, ciclos adaptativos, batch).
- Persistir `attemptsByObra` entre restarts.
- Re-colheita de índice envelhecido, semente com viés BR.

## Testes

Tudo em `test/harvester.test.ts` (já listado no `npm test`):

1. Override live de `harvestMaxPerHour`/`harvestIdleWindowMs` muda o
   comportamento DENTRO de `harvestOne` (sem restart/bust de config).
2. Warmers enfileirados em ordem de score (BR dublado primeiro, 80 > 40 > 5).
3. `checkQuotaWarning` não repete a chamada de `accountStatus` dentro do
   cooldown; sem aviso (magnets abaixo do limiar) o marcador não é gravado.
4. bludv chamado com a query original quando `ptQuery` é nulo.
5. Varredura parcial: orçamento que cobre K < 12 alvos consulta exatamente K e
   conta `harvest.sweep.partial`; orçamento zero pula com log.
6. Obra cortada 4 vezes conta `harvest.capped.dropped`.

## Salvaguardas

- Kill-switch novo: só `HARVEST_QUOTA_WARN_COOLDOWN_MS` (M3). Os demais são
  conserto de contrato; revert via git.
- Validação: `npm run typecheck` zero → `npm run build` → `npm test`.
- Sem mudança de formato de cache/índice/fila; sem bump de namespace.
