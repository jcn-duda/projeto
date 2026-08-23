# PLANO_MELHORIAS — Roadmap de correções, robustez e refactor

Plano de execução derivado da auditoria de 2026-08-22 (4 investigações paralelas:
arquitetura, corretude, adversarial e cobertura de teste, com verificação manual
dos achados críticos). Autocontido: pode ser executado por um agente sem acesso
à análise original. Em conflito, o código e o `AGENTS.md` vencem.

**Princípios:**

1. Cada fase é shippable sozinha (build verde + suíte 100% + typecheck 0).
2. Testes de proteção ANTES do refactor arquitetural (rede de segurança primeiro).
3. `npm run typecheck` em ZERO é portão de saída de toda tarefa.
4. Todo `.test.ts` novo entra na lista explícita do `package.json` (o
   `npm run test:complete` cobra).
5. Números ajustáveis → sempre em `src/config.ts` + `.env.example`.
6. Commits em português, prefixo convencional, um commit por tarefa ou grupo
   coeso da fase. Sem push sem pedido.

**Esforço:** S = <4h, M = 1–2 dias, L = 3–5 dias.

---

## Inventário de achados (IDs usados no plano)

### Bugs críticos (corretude, evidência verificada)

| ID | Achado | Evidência |
|---|---|---|
| B1 | Snapshot `preexisting` da AllDebrid estático por processo: magnets do usuário adicionados após o boot são apagados pela limpeza (perda de dado, defaults ativos) | `src/debrid/alldebrid.ts` (map `preexisting`) |
| B2 | `dropReady`/`dropUncached` viraram um switch único: `DROP_UNCACHED=false` também desliga a limpeza dos prontos | `src/debrid/alldebrid.ts` (`if (drop.length && dropUncached)`) |
| B3 | Metadados (cinemeta 2500ms + TMDB 5000ms) rodam antes da coleta sem descontar o budget fixo (4700ms): metadados lentos → aviso "reabra em instantes" em vez de lista parcial | `src/providers/index.ts` (`budget` em `collectRaw` vs `deadlineAt` de `findStreams`) |
| B4 | `drainNext` reenfileira a mesma cabeça quando o orçamento horário esgota — gira para sempre sem avançar | `src/providers/index.ts` (`drainNext`) + `src/providers/autofetch.ts` (`checkAndRecordBudget`) |

### Riscos de segurança/robustez

| ID | Achado | Evidência |
|---|---|---|
| S1 | Sem `process.on('unhandledRejection')`; Express 4 não captura promise de rota async → crash derruba a stack inteira (via `wait -n` do entrypoint) | `src/addon.ts`; rotas async em `src/app.ts` |
| S2 | SSRF: `fetch(item.downloadUrl)` do Link Torznab sem allowlist (site BR comprometido aponta para `169.254.169.254`/loopback) | `src/providers/jackett.ts` (`resolveDownloadMagnet`) |
| S3 | `/debrid-status.json` e `/metrics.json` fora do `diagnosticGate` (as demais rotas de diagnóstico passam) | `src/app.ts` |
| S4 | Ações globais destrutivas do dashboard (`clear-cache`, `sweep-dead`) sem confirmação; `basic_auth` do Caddyfile comentado | `src/app.ts`, `Caddyfile` |
| S5 | `@types/node@^26` com runtime `node:22-alpine`: typecheck aprova API inexistente no container | `package.json` |

### Dívida arquitetural

| ID | Achado |
|---|---|
| A1 | `src/providers/index.ts` (2.134 linhas): 4 domínios num módulo (busca, debrid, autofetch/recheck, builder/cache) |
| A2 | `src/utils/format.ts` (2.068 linhas): normalização, matching, áudio, episódio, ranking, cotas e queries |
| A3 | `doSearch` (~396 linhas) com estados implícitos (parcial, fase, latest-writer, tails) |
| A4 | 4 resolvers JS duplicam núcleo inteiro (parseHost, allowlist, probe, cache, hops, HTTP server) |
| A5 | `process.env` lido fora de `config.ts` (`app.ts`, `cache.ts`, `logger.ts`; `br-resolvers.ts` muta `process.env`) |
| A6 | 286 `any` explícitos concentrados nas fronteiras internas (80 em `providers/index.ts`) |

### Gaps de teste

| ID | Lacuna |
|---|---|
| T1 | `magnetYearContradicts` (format.ts) — zero testes |
| T2 | `matchesEpisodeWorkIdentity` — zero testes |
| T3 | `debridlink.ts` — único adaptador sem teste de sucesso (só 401) |
| T4 | Season fill com `cacheCheck:false` (lado negativo) e `STALL_STREAK=0` sem teste |
| T5 | Fórmula da graça BR `min(grace, reserve − floor)` sem assert direto |
| T6 | Harness `test:adversarial` edita `dist/` in-place: interrupção corrompe o build |
| T7 | 5 harnesses fora do CI não checados nem pelo `test:complete` (rot invisível) |

### Divergências doc × código (AGENTS.md)

| ID | Divergência |
|---|---|
| D1 | Doc cita `DEBRID_RESERVE_MS` 2800; código usa 4500 (`config.ts`) |
| D2 | Doc diz "Fase 3 (davail) não está no código"; está (`debrid/index.ts`) |
| D3 | Varredura pt-BR inline não passa `ignoreBreaker` (só a tardia passa) — doc ambígua |

---

## Estado atual (importante)

**As tarefas marcadas ✅ abaixo já estão implementas na árvore de trabalho,
NÃO commitadas** (origem: subagente arquiteto que extrapolou o mandato
somente-leitura em 2026-08-22; trabalho auditado via diff, typecheck 0,
build ok, 1.070/1.070 testes e `test:complete` ok). Arquivos envolvidos:
`.env.example`, `package.json`, `package-lock.json`, `src/addon.ts`,
`src/config.ts`, `src/debrid/alldebrid.ts`, `src/providers/autofetch.ts`,
`src/providers/index.ts`, `src/providers/jackett.ts`,
`src/utils/net-safety.ts` (novo), `test/debrid-drop-uncached.test.ts`,
`test/jackett-provider.test.ts`.

Decisão pendente do operador: commitar como "fase 1+2" ou descartar
(`git checkout -- .` + remover `src/utils/net-safety.ts`) e reexecutar do
zero. O plano assume que **fica**.

---

## Fase 0 — Alinhamento da documentação

**Objetivo:** AGENTS.md voltar a ser fonte de verdade. Esforço S. Risco nulo.

| # | Tarefa | Arquivo |
|---|---|---|
| 0.1 ✅ (parcial) | Corrigir `DEBRID_RESERVE_MS` 2800→4500 e o orçamento da coleta (4700ms) no invariante 1 | `AGENTS.md` |
| 0.2 | Corrigir "Fase 3 (davail) não está no código" — descrever o `davail` existente e reavaliar o gate de 30% com as métricas reais | `AGENTS.md` |
| 0.3 | Documentar que a varredura pt-BR **inline** não ignora breaker (só a tardia) | `AGENTS.md` |
| 0.4 | Documentar as envs novas desta roadmap (`ALLDEBRID_PREEXISTING_TTL_MS`, `DEBRID_AUTO_FETCH_DRAIN_BACKOFF_MS`, `JACKETT_ALLOW_PRIVATE_DOWNLOAD_IPS`) | `AGENTS.md`, `README.md` se couber |
| 0.5 | Atualizar armadilhas conhecidas: snapshot preexistente agora expira; SSRF bloqueado por padrão em `resolveDownloadMagnet` | `AGENTS.md` |

**Validação:** leitura; sem código.
**Critério de aceite:** nenhuma afirmação do AGENTS.md contradiz o código nos pontos D1–D3.

---

## Fase 1 — Bugs críticos da AllDebrid (B1, B2)

**Objetivo:** parar de apagar acervo/download do usuário. Risco do bug: ALTO
(perda de dado com defaults ativos). Risco da correção: médio (toca a limpeza —
o subsistema que já derrubou a conta no passado).

| # | Tarefa | Status |
|---|---|---|
| 1.1 | B1: snapshot `preexisting` ganha TTL (`ALLDEBRID_PREEXISTING_TTL_MS`, default 300s). Vencido → refresh **antes** de qualquer drop de prontos; refresh em voo ou falho → `preexistentes` null → prontos **protegidos** (fail-safe fecha, nunca abre). `PreexistingEntry` tipado com `loadedAt` | ✅ implementado |
| 1.2 | B2: lotes separados `dropReady` (dispara sob `DEBRID_DROP_READY`) e `dropDownload` (dispara sob `DEBRID_DROP_UNCACHED`), métrica própria `debrid.dropped.download` | ✅ implementado |
| 1.3 | Testes: "os dois switches desligados não apagam nada" ajustado; novo "DEBRID_DROP_UNCACHED=false não desliga a limpeza dos prontos" | ✅ implementado |

**Pendência da fase (a fazer):**

| # | Tarefa | Arquivo |
|---|---|---|
| 1.4 | Teste do TTL do snapshot: com `preexistingTtlMs` curto, magnet adicionado pelo usuário **depois** do primeiro snapshot (via `/magnet/status` do mock) não é mais removido após expirar | `test/debrid-drop-uncached.test.ts` |
| 1.5 | Teste do fail-safe: refresh do inventário falhando (mock 500) → nenhuma remoção de prontos, busca segue normal | `test/debrid-drop-uncached.test.ts` |

**Validação:** `npm run typecheck && npm run build && npm test`.
**Aceite:** suíte 100%; cenário do B1 (aquisição pós-boot protegida) coberto por teste.
**Rollback:** as envs novas default mantêm comportamento próximo ao antigo; `ALLDEBRID_PREEXISTING_TTL_MS=0` desliga a expiração (não recomendado).

---

## Fase 2 — Robustez e segurança barata (S1–S5, B3, B4)

**Objetivo:** remover modos de falha de processo inteiro e superfície de abuso. Risco baixo.

| # | Tarefa | Status |
|---|---|---|
| 2.1 | S1: `process.on('unhandledRejection')` em `src/addon.ts` com métrica `process.unhandled_rejection` + log `[process]` (não mata o processo: logar e seguir; crash de verdade é papel do `wait -n` do supervisor) | ✅ implementado |
| 2.2 | S2: `src/utils/net-safety.ts` — `isSafeDownloadUrl` (esquema http(s), bloqueia loopback/privado/link-local/localhost literal, IPv6 `::1`/ULA; escape `JACKETT_ALLOW_PRIVATE_DOWNLOAD_IPS` para operador que roda resolvedor privado) aplicado em `resolveDownloadMagnet` + teste de SSRF | ✅ implementado |
| 2.3 | S5: `@types/node` pin `^22` (runtime `node:22-alpine`) + `engines` do lockfile alinhado | ✅ implementado |
| 2.4 | B4: `drainNext` — recusa por orçamento move a cabeça para o FIM da fila (`[...remaining, next]`) + backoff `budgetBlockedUntil` (`DEBRID_AUTO_FETCH_DRAIN_BACKOFF_MS`, default 60s) para não girar fila a cada recheck | ✅ implementado |
| 2.5 | B3: `collectRaw` aceita `deadlineAt` e calcula `budget` como tempo RESTANTE menos a reserva (`remainingCheckBudget(deadlineAt) - debridReserve`, piso 500ms) em vez de fatia fixa; `doSearch` passa o deadline nas duas coletas (normal e pack) | ✅ implementado |
| 2.6 | S3: `/debrid-status.json` e `/metrics.json` passam pelo `diagnosticGate.enter()` (mesmo rate limit das outras rotas de diagnóstico) | ☐ a fazer — `src/app.ts` |
| 2.7 | S1 (parte 2): wrapper `asyncRoute(fn)` (catch → 500 + log) nas 6 rotas async de `src/app.ts` — Express 4 não encaminha rejeição de handler async | ☐ a fazer — `src/app.ts`, novo helper |
| 2.8 | S4: ações destrutivas do dashboard exigem `{"confirm": true}` no body (`clear-cache`, `sweep-dead`); documentar no painel; avaliar reabilitar `basic_auth` do Caddyfile ou registrar a decisão | ☐ a fazer — `src/app.ts`, `src/public/dashboard.html` |
| 2.9 | Cache L2 corrompido no boot: renomear para `cache.db.corrupt` e recriar vazio (hoje: fallback memória silenciosa, arquivo ruim fica para sempre) | ☐ a fazer — `src/utils/cache.ts` (`openDatabase`) |
| 2.10 | `npm audit --omit=dev` como passo do CI (falha soft: warning, não block) | ☐ a fazer — `.github/workflows/ci.yml` |

**Testes novos:** 2.6 (401/429 sem e com rajada), 2.7 (rota que rejeita devolve 500 e não derruba), 2.8 (ação sem `confirm` é 400; com `confirm` executa), 2.9 (arquivo com lixo no boot → `.corrupt` criado + banco novo).
**Validação:** typecheck + build + `npm test` + `npm run test:complete`.
**Rollback:** cada item é independente e revertível isoladamente.

**Nota sobre o 2.2:** a proteção cobre IPs/hosts **literais**. Hostname público
que resolve para IP privado exigiria validação DNS pré-fetch — aceito como
resíduo (custo/benefício; documentar na armadilha do AGENTS.md).

**Nota sobre o 2.5:** a mudança de semântica do budget precisa do teste 4.1
(fase 4) para travar o comportamento — não commitar 2.5 sem o teste da fase 4
no mesmo ramo de trabalho.

---

## Fase 3 — Rede de segurança de testes (T1–T5)

**Objetivo:** fechar as lacunas de maior risco de regressão ANTES de qualquer
refactor. Esforço M. Risco nulo (só teste).

| # | Tarefa | Onde | O que asserta |
|---|---|---|---|
| 3.1 | T1: `magnetYearContradicts` | `test/format.test.ts` (ou novo `test/br-year-guard.test.ts`) | filme com UM ano contraditório >±2 no `dn=` é cortado; 2+ anos passa; série/pack não roda a guarda; roda DEPOIS do titleMatches |
| 3.2 | T2: `matchesEpisodeWorkIdentity` | idem | spin-off com token compartilhado não herda vaga (obra distinta); mesmo universo passa; sem marcador de episódio não condena |
| 3.3 | T5: fórmula da graça BR | `test/providers` (ou extender `collection-window.test.ts`) | `min(brPartialGrace, max(0, debridReserve − debridCheckFloor))` com reserve curto/longo — a janela extra nunca invade o floor; cobre também o novo budget restante do 2.5 (metadados lentos ⇒ budget da coleta encolhe, graça respeita floor) |
| 3.4 | T4a: season fill negativo | `test/autofetch.test.ts` | adaptador com `cacheCheck:false` (RD/DL): pack pronto NÃO semeia `davail` nem conta métrica de season-fill |
| 3.5 | T4b: `STALL_STREAK=0` | `test/autofetch.test.ts` | `autoFetchStallStreak=0` + `torrentStatus` stalled → NÃO colapsa nem remove (parado nunca derruba) |
| 3.6 | T3: `debridlink` sucesso | novo `test/debridlink.test.ts` | `resolveLink` de sucesso (seedbox → poll → pickFile), `enqueue`, `checkCached` devolve `Set` vazio com `known` honesto |
| 3.7 | T6: harness mutante seguro | `test/empirical-e2e-challenger.js` (e irmãos) | operar sobre CÓPIA do `dist/` (snapshot + restore em `finally`), nunca in-place; targets por regex tolerante ou assinatura estrutural |
| 3.8 | T7: harnesses no `test:complete` | `scripts/check-test-list.ts` + `package.json` | checagem de sanidade dos 5 harnesses (existência, imports resolvem com `node --check`, fixtures presentes) sem executá-los no CI |

**Ordem interna:** 3.7 primeiro (protege o próprio instrumento), depois 3.1–3.6, 3.8 por último.
**Validação:** `npm test` + `test:complete`; 3.7 validado rodando `npm run test:adversarial` UMA vez com interrupt simulado (Ctrl+C no meio → `dist/` intacto).
**Gate da fase:** sem 3.1–3.3 e 3.7 verdes, a fase 5 não começa.

---

## Fase 4 — Orçamento de busca: fechamento do B3

**Objetivo:** o comportamento novo do budget (2.5) ficar provado, não só
compilado. Esforço S–M.

| # | Tarefa |
|---|---|
| 4.1 | Teste e2e (tier2 ou `swr-streams`-style) com cinemeta lento (2500ms) + TMDB miss (5000ms): resposta NÃO estoura o deadline; lista parcial sai com BR incluída quando o indexer responde; `cacheMaxAge: 0` no parcial |
| 4.2 | Métrica: `search.deadline` segmentada por causa (metadata vs providers) para o dashboard não culpar o indexer quando o cinemeta comeu o orçamento — avaliar `search.metadata.duration_ms` |
| 4.3 | Revisar `Math.max(500, …)`: piso de 500ms para a coleta é intencional? Se a coleta não cabe mais, é melhor devolver parcial imediatamente do que arremessar 500ms de Jackett — decidir e documentar |

**Risco:** médio — mexe no invariante 1. Qualquer mudança aqui exige releitura
da seção "orçamento de tempo" do AGENTS.md antes.

---

## Fase 5 — Refactor arquitetural incremental

**Objetivo:** reduzir o custo de manutenção sem mudar comportamento. Cada
subfase termina com suíte 100% + `test:adversarial`/`test:stress` verdes
(harnesses são a prova de que o refactor não enfraqueceu nada).

**Ordem** (da maior razão risco/benefício para a menor):

### 5.1 — Split de `src/providers/index.ts` (A1) — esforço L

Migrar funções para módulos irmãos mantendo `index.ts` como fachada que
reexporta (imports atuais dos 63 testes não mudam):

- `providers/autofetch-runner.ts` — seleção de candidatos, holds/markers,
  `drainNext`, recheck, settle, detecção de morte (`index.ts:74–544` hoje);
- `providers/debrid-pipeline.ts` — `applyDebrid`, filtro pré-checagem,
  refresh (`:545–715`);
- `providers/search-orchestrator.ts` — `doSearch`, `collectRaw`, passes,
  fallback de pack, harvest, varredura pt-BR (`:1076–1824`);
- `providers/stream-builder.ts` — `buildStreams`, `limitReservingBr`,
  notices (`:1831–2090`);
- `providers/search-cache.ts` — coalescing, SWR, latest-writer (`:1257–1373`).

Contrato: cada módulo exporta funções puras + fábricas que recebem
dependências (cache, debrid, metrics) por parâmetro; nada de singleton
escondido. Estados implícitos de fase viram `SearchPhase` explícito (A3):
`'collecting' | 'response-built' | 'late-collecting' | 'pack-fallback' | 'enriching' | 'completed'`.

**Estratégia:** uma extração por commit, suíte + harnesses entre cada uma.
Começar pela `autofetch-runner` (fronteira mais limpa).

### 5.2 — Extração de `pickFile`/`pickWorkFile` (A1b) — esforço S

`src/debrid/file-selector.ts` com `selectEpisodeFile`, `selectWorkFile`,
`selectMovieVideo` (tipos `WorkPickError`/`EpisodePickError` juntos).
`common.ts` reexporta. Testes existentes de `debrid-pick-work` não mudam.

### 5.3 — Split de `src/utils/format.ts` (A2) — esforço M

`utils/title-normalization.ts`, `release-matching.ts`, `episode-matching.ts`,
`audio-quality.ts`, `stream-ranking.ts`, `stream-quotas.ts`,
`search-names.ts`; `format.ts` vira barrel de reexports (a remoção do barrel
é decisão posterior, com grep de uso). Testes novos ficam nos módulos novos;
os antigos continuam passando via reexport.

### 5.4 — Núcleo comum dos resolvers (A4) — esforço M

`resolvers/runtime.js`, `site-selector.js`, `cache.js`, `protector.js`,
`http-server.js` + `profiles/{bludv,comandotorrents,nerdfilmes,torrentdosfilmes}.js`.
CommonJS puro, sem build novo; `npm run build` passa a copiar `resolvers/`
para `dist/` (mesmo mecanismo dos `*-resolver/` hoje). Os testes de parser
por site continuam apontando para os profiles. Migração um resolver por vez,
começando pelo `torrentdosfilmes` (o que mais troca de protetor — maior dor).

### 5.5 — Rotas de `app.ts` (A1c) — esforço M

`app/stream-route.ts`, `resolve-route.ts`, `diagnostic-routes.ts`,
`dashboard-routes.ts`, `config-routes.ts`; handlers recebem `AppServices`
(debrid, cache, metrics, jackett). `createApp()` só compõe e registra.
Aproveitar para aplicar o wrapper `asyncRoute` (2.7) em tudo que for movido.

### 5.6 — `process.env` centralizado (A5) — esforço S

`config.resolvers.portOffset`, `config.cache.persist`, `config.cache.dbPath`,
`config.logging.level`. `br-resolvers.ts` mantém a mutação de `process.env`
(compatibilidade dos servidores legados) mas encapsulada com restauração
garantida e comentário. Leituras diretas em `app.ts`/`cache.ts`/`logger.ts`
sóno bootstrap, vindo da config.

### 5.7 — Redução de `any` (A6) — esforço contínuo

Prioridade: opções de `applyDebrid`/`buildStreams`, respostas por adaptador
(`PremiumizeTransfer`, `TorboxRow`, `AllDebridMagnet`), handlers Express com
`Request`/`Response`. `unknown` na fronteira externa + normalização imediata.
Meta da fase: <150 ocorrências em `src/`.

**Gate da fase 5:** após CADA subfase: `npm run typecheck && npm run build
&& npm test && npm run test:complete` + `npm run test:stress && npm run
test:adversarial && npm run test:adversarial-m1 && npm run test:protector-m1
&& npm run test:challenger-m2` (baseline dos harnesses tirada na fase 3.7).
**Rollback:** subfase inteira revertível por commit revert; barrel/reexport
garante que nenhum consumidor quebra no meio.

---

## Fase 6 — Longo prazo / opcionais

| # | Tarefa | Nota |
|---|---|---|
| 6.1 | Avaliar substituir `stremio-addon-sdk` (parado desde 2019, ~30 transitivas): implementação própria do router (o app já monta Express) | só depois do 5.5 |
| 6.2 | Dashboard: escopo seletivo de `clear-cache` (por namespace/instalação) | depende do 5.5 |
| 6.3 | `davail`/fase-3: reavaliar o gate `debrid.check.repeated > 30%` com métricas reais (D2 diz que já existe) | análise, não código |
| 6.4 | Rate limit no decode de segmento `/<config>/…` (CPU leve, sem observabilidade) | teórico |
| 6.5 | Healthcheck do Caddy no triplo (hoje coberto só pelo `wait -n`) | operacional |

---

## Grafo de dependências

```
Fase 0 (docs) ────────────────────────────── independente, sempre pode rodar
Fase 1 (B1,B2) ──┐
Fase 2 (S*,B3,B4)─┼─→ Fase 4 (fecha B3 com testes; depende de 2.5)
                  │      │
                  └─→ Fase 3 (testes T1–T7; independente de 1/2, mas 3.3
                         cobre o comportamento do 2.5 — rodar 3.3 depois)
                         │
                         └─→ Fase 5 (refactors; GATE: 3.1–3.3 + 3.7 verdes)
                                └─→ Fase 6 (6.1/6.2 dependem do 5.5)
```

- Fase 2.6–2.10 não dependem de nada; podem rodar em paralelo com a fase 1.
- 5.1–5.7 são sequenciais entre si (mesmos arquivos), mas 5.2 e 5.4 são
  independentes das demais e podem intercalar.
- Fase 3.7 (harness seguro) é pré-requisito de TODA a fase 5.

## Validação global (por fase)

```
npm run typecheck      # portão: ZERO
npm run build          # dist/ atual (test roda dist)
npm test               # 1.070+ testes, zero falha
npm run test:complete  # lista explícita fechada
# fase 2+ (tocou runtime de rede/debrid):
node dist/scripts/smoke.js          # pipeline ponta a ponta, rede de verdade
# fase 5 (todas as subfases):
npm run test:stress && npm run test:adversarial && npm run test:adversarial-m1 \
  && npm run test:protector-m1 && npm run test:challenger-m2
```

**Não pode regredir:** invariante 1 (orçamento), vagas BR no corte final,
`_campos` internos fora da resposta, SWR só serve lista completa+tocável,
soma de cotas < teto global (30.500 < 36.000), métricas `magnetdb.dropped.*`
separadas.

## Riscos do próprio plano

| Risco | Mitigação |
|---|---|
| 1.1 muda a limpeza que historicamente derrubou contas | TTL default conservador (300s = mesmo ritmo do inventário `dinv`); fail-safe fecha (sem snapshot fresco, prontos ficam); testes 1.4/1.5 |
| 2.5 (budget restante) encurta demais a coleta em metadados lentos | piso 500ms + teste 4.1; se o parcial piorar, revisar o 4.3 (devolver parcial imediato) |
| 5.x refactor introduz corrida latest-writer/passe tardio | extração um commit por vez + harnesses como prova; `SearchPhase` explícito exatamente para isso |
| 5.4 unificar resolvers quebra failover de domínio | um resolver por vez; `test:nerdfilmes` + fixtures reais por site |
| Commits empilhados confundirem rollback | um commit por tarefa coesa; mensagem referencia o ID (ex.: `fix: B1 snapshot preexistente expira (PLANO_MELHORIAS 1.1)`) |
