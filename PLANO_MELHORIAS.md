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
| A6 | 274 `any` explícitos (baseline 2026-08-24) concentrados nas fronteiras internas — meta por ocorrências explícitas de código; ver §5.7 para a medição atual |
| A7 | Teto de 400 linhas/arquivo sem gatilho automático: 58 arquivos acima do teto (excedente 20.031) na medição de 2026-08-28; vacatorrent.js nasceu com 1.025 linhas e nada reclamou — wc -l nos arquivos versionados; ver §5.8 |

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

| ID | Divergência | Estado |
|---|---|---|
| D1 | Doc cita `DEBRID_RESERVE_MS` 2800; código usa 4500 (`config.ts`) | ✅ corrigido — e o invariante 1 agora descreve o orçamento **dinâmico**, não a fatia fixa |
| D2 | Doc diz "Fase 3 (davail) não está no código"; está (`debrid/index.ts`) | ✅ corrigido — confirmado em produção local: `davail.servedHashes` contando |
| D3 | Varredura pt-BR inline não passa `ignoreBreaker` (só a tardia passa) — doc ambígua | ✅ corrigido — os dois caminhos descritos separadamente |

---

## Estado atual (2026-08-22, pós-auditoria de revisão)

**Fases 1, 2 e 3 estão commitadas e verdes.** A decisão de "commitar ou
descartar a árvore de trabalho" que este documento descrevia foi resolvida —
o trabalho ficou, em cinco commits:

| Commit | Cobre |
|---|---|
| `bda6a7c` | B1, B2 — snapshot com TTL, lotes de drop separados |
| `780809b` | S1 (completo), S2, S3, S4, 2.9, 2.10 |
| `e69450c` | B3, B4, T6 |
| `c9a7888` | T1, T2, T3, T7 |
| `54239f3` | `PROJECT.md` + este plano |

Baseline verificado: `typecheck` 0, build ok, **1.117/1.117 testes**,
`test:complete` ok com os 6 harnesses validados.

**Uma correção entrou depois, na revisão** (fase 1, ver 1.6 abaixo): o refresh
do snapshot por TTL era **aguardado** dentro do `checkCached`, o que colocava
um `/magnet/status` de até 6s dentro de uma reserva de debrid de 4500ms — uma
vez a cada TTL, e em toda busca enquanto o endpoint estivesse fora do ar. O
refresh passou a rodar em fundo; só o primeiro inventário da conta é esperado,
com teto pelo `DEBRID_CHECK_FLOOR_MS`.

**O que continua aberto (2026-08-24):** fases 0–6 estão no código (0.6 ✅ —
o grafo antigo que dizia “exceto README” estava atrasado). Aberto de verdade:
janela de 7 dias do **6.3** (TTL do `davail` ainda não se mexe), resíduo
menor do **2.4** (rotação da fila com backoff já pausando), **6.7** (`checkJs`
medido, não feito) e a **Fase 7** (operação / produção — só especificada, sem
execução neste commit). A auditoria forense do Tier 5 (M4) não é gate.

A meta de `any` está em **143** (`e25ef29`), medida com o contador de AST
corrigido de §5.7 — o anterior varria 66 dos 72 arquivos e por isso reportava
149 onde o número real era 156. As alegações de 147 e 149 foram substituídas.

Duas conclusões desta rodada foram declaradas antes de estarem completas e
ficaram registradas com a correção no lugar: **5.4** (três funções ainda eram
duplicação real nos profiles, migradas em `48b6773`) e **5.7** (a meta só foi
batida em `e25ef29`). Ambas seguem o mesmo padrão — o critério de conclusão era
descritivo ("os arquivos existem") em vez de uma métrica verificável. Ver
"Riscos do próprio plano".

---

## Fase 0 — Alinhamento da documentação

**Objetivo:** AGENTS.md voltar a ser fonte de verdade. Esforço S. Risco nulo.

| # | Tarefa | Arquivo |
|---|---|---|
| 0.1 ✅ | D1: `DEBRID_RESERVE_MS` 2800→4500 **e** a troca da fatia fixa pelo orçamento dinâmico (`remainingCheckBudget − reserva`, piso 500ms) no invariante 1 | `AGENTS.md` |
| 0.2 ✅ | D2: o `davail` existe (`debrid/index.ts`) — documentados os TTLs separados, o `forceFresh`, o "unusable não grava", a escrita em lote e o `davail.servedHashes`. O gate de 30% deixou de ser critério de implementação e virou critério de calibragem dos TTLs | `AGENTS.md` |
| 0.3 ✅ | D3: os dois caminhos da varredura pt-BR descritos separadamente — inline (`recordStatus:false`, **sem** `ignoreBreaker`, divide orçamento) e tardia (os dois flags, fora do caminho da resposta) | `AGENTS.md` |
| 0.4 ✅ | Envs novas documentadas com o porquê no `.env.example` (as três) e no `AGENTS.md` | `.env.example`, `AGENTS.md` |
| 0.5 ✅ | Armadilhas novas: snapshot que expira + refresh em fundo, switches de drop independentes, guarda de SSRF (com o resíduo de DNS explícito), `asyncRoute` do Express 4, `cache.db.corrupt` só em corrupção real, `confirm` do painel, harness que muta o `dist/`, `deepEqual` que estreita tipo | `AGENTS.md` |
| 0.6 ✅ | `README.md`: nada a fazer — ele delega a documentação de envs ao `.env.example` (não mantém tabela própria), e as três entraram lá com o porquê | `README.md` |

**Validação:** leitura; sem código.
**Critério de aceite:** nenhuma afirmação do AGENTS.md contradiz o código nos
pontos D1–D3. **Atingido** para D1, D2 e D3.

---

## Fase 1 — Bugs críticos da AllDebrid (B1, B2)

**Objetivo:** parar de apagar acervo/download do usuário. Risco do bug: ALTO
(perda de dado com defaults ativos). Risco da correção: médio (toca a limpeza —
o subsistema que já derrubou a conta no passado).

| # | Tarefa | Status |
|---|---|---|
| 1.1 | B1: snapshot `preexisting` ganha TTL (`ALLDEBRID_PREEXISTING_TTL_MS`, default 300s). Vencido → refresh disparado **em fundo** (ver 1.6), e enquanto ele não chega nenhum pronto é apagado; refresh em voo ou falho → `preexistentes` null → prontos **protegidos** (fail-safe fecha, nunca abre). `PreexistingEntry` tipado com `loadedAt` | ✅ implementado |
| 1.2 | B2: lotes separados `dropReady` (dispara sob `DEBRID_DROP_READY`) e `dropDownload` (dispara sob `DEBRID_DROP_UNCACHED`), métrica própria `debrid.dropped.download` | ✅ implementado |
| 1.3 | Testes: "os dois switches desligados não apagam nada" ajustado; novo "DEBRID_DROP_UNCACHED=false não desliga a limpeza dos prontos" | ✅ implementado |

| 1.4 ✅ | Teste do TTL do snapshot: magnet adicionado pelo usuário **depois** do primeiro snapshot não é removido após expirar | `test/debrid-drop-uncached.test.ts` |
| 1.5 ✅ | Teste do fail-safe: refresh do inventário falhando (mock 500) → nenhuma remoção de prontos, busca segue normal | `test/debrid-drop-uncached.test.ts` |
| 1.6 ✅ | **Correção da correção (achado da revisão):** o refresh por TTL era aguardado dentro do `checkCached` — um `/magnet/status` de até 6s (timeout padrão do adaptador) dentro de uma reserva de 4500ms, uma vez a cada TTL e em TODA busca enquanto o endpoint falhasse (o `.catch` limpa o registro e a passada seguinte retentava). Agora o refresh roda **em fundo**: `knownBefore` dispara e devolve `null`, e enquanto a foto nova não chega os prontos ficam protegidos. Só o PRIMEIRO inventário da conta é esperado, via `waitInventory`, com teto de `DEBRID_CHECK_FLOOR_MS` | `src/debrid/alldebrid.ts` |
| 1.7 ✅ | Testes de latência do 1.6: (a) `/magnet/status` lento após o TTL não atrasa o `checkCached`; (b) primeiro inventário lento demais devolve a checagem no teto **sem** apagar prontos. O 1.4 passou a cobrar o contrato novo: a passada que dispara o refresh não apaga nada, a seguinte já usa a foto nova | `test/debrid-drop-uncached.test.ts` |

**Validação:** `npm run typecheck && npm run build && npm test`.
**Aceite:** suíte 100%; cenário do B1 (aquisição pós-boot protegida) coberto por teste. **Atingido** (1.117/1.117).
**Rollback:** as envs novas default mantêm comportamento próximo ao antigo; `ALLDEBRID_PREEXISTING_TTL_MS=0` desliga a expiração (não recomendado).

**Nota de projeto (1.6):** a lição vale para o resto do plano — proteger o
acervo é uma decisão de *dado*, e o dado que falta protege por si só. Sempre
que o fail-safe já fecha na ausência de informação, buscar essa informação de
forma síncrona dentro do prazo da resposta é custo puro: dá para pagar depois,
em fundo, e deixar a passada atual protegida.

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
| 2.6 ✅ | S3: `/debrid-status.json` e `/metrics.json` passam pelo `diagnosticGate.enter()` (mesmo token e rate limit das outras rotas de diagnóstico) | `src/app.ts` |
| 2.7 ✅ | S1 (parte 2): wrapper `asyncRoute(fn)` (catch → 500 + log) nas 6 rotas async de `src/app.ts` | `src/app.ts` |
| 2.8 ✅ | S4: `clear-cache` e `sweep-dead` devolvem 400 `confirmation_required` sem `{"confirm": true}` | `src/app.ts`, `src/public/dashboard.html` |
| 2.9 ✅ | Cache L2 corrompido no boot vira `cache.db.corrupt` + banco novo — **só em corrupção real** (`SQLITE_CORRUPT`/`SQLITE_NOTADB`/"malformed"). `SQLITE_BUSY`, stall de I/O e `EACCES` caem em memória sem tocar no volume | `src/utils/cache.ts` |
| 2.10 ✅ | `npm audit --omit=dev` como passo do CI | `.github/workflows/ci.yml` |

**Validação:** typecheck + build + `npm test` + `npm run test:complete`. **Atingido.**
**Rollback:** cada item é independente e revertível isoladamente.

**Nota sobre o 2.2 (resíduo aceito):** a proteção cobre IPs/hosts **literais** —
e cobre bem: esquema, loopback, RFC1918, CGNAT, link-local (incl. o
`169.254.169.254` de metadado de nuvem), multicast, reservados, e no IPv6 ULA,
link-local, site-local, IPv4-mapeado, IPv4-compatível, 6to4, NAT64 e o prefixo
de descarte. O construtor `URL` canonicaliza host numérico (`http://2130706433/`
vira `127.0.0.1`) antes da checagem, e o `fetch` usa `redirect: 'manual'` — não
há bypass por notação exótica nem por 302. **O que fica aberto** é hostname
público que resolve para IP privado: fechar exigiria validar DNS antes do
fetch, e o custo é transformar indisponibilidade de DNS em falso bloqueio.
Documentado na armadilha do AGENTS.md.

**Nota sobre o 2.4 (dívida menor):** ficaram os dois mecanismos — o backoff
`budgetBlockedUntil` **e** a rotação `[...remaining, next]`. Com o backoff, a
rotação não é mais necessária, e como o `takeNext` varre em ordem (a cabeça é o
melhor candidato), ela rebaixa o melhor item a cada estouro de orçamento.
Simplificar para `[next, ...remaining]` é um commit de uma linha; não é urgente.

---

## Fase 3 — Rede de segurança de testes (T1–T7) ✅ CONCLUÍDA

**Objetivo:** fechar as lacunas de maior risco de regressão ANTES de qualquer
refactor. Esforço M. Risco nulo (só teste).

Todas as oito tarefas estão no código (`c9a7888` e `e69450c`). O gate da fase
5 (3.1–3.3 + 3.7 verdes) está **satisfeito**.

| # | Tarefa | Onde | O que asserta |
|---|---|---|---|
| 3.1 ✅ | T1: `magnetYearContradicts` | `test/format.test.ts` (ou novo `test/br-year-guard.test.ts`) | filme com UM ano contraditório >±2 no `dn=` é cortado; 2+ anos passa; série/pack não roda a guarda; roda DEPOIS do titleMatches |
| 3.2 ✅ | T2: `matchesEpisodeWorkIdentity` | idem | spin-off com token compartilhado não herda vaga (obra distinta); mesmo universo passa; sem marcador de episódio não condena |
| 3.3 ✅ | T5: fórmula da graça BR | `test/providers` (ou extender `collection-window.test.ts`) | `min(brPartialGrace, max(0, debridReserve − debridCheckFloor))` com reserve curto/longo — a janela extra nunca invade o floor; cobre também o novo budget restante do 2.5 (metadados lentos ⇒ budget da coleta encolhe, graça respeita floor) |
| 3.4 ✅ | T4a: season fill negativo | `test/autofetch.test.ts` | adaptador com `cacheCheck:false` (RD/DL): pack pronto NÃO semeia `davail` nem conta métrica de season-fill |
| 3.5 ✅ | T4b: `STALL_STREAK=0` | `test/autofetch.test.ts` | `autoFetchStallStreak=0` + `torrentStatus` stalled → NÃO colapsa nem remove (parado nunca derruba) |
| 3.6 ✅ | T3: `debridlink` sucesso | novo `test/debridlink.test.ts` | `resolveLink` de sucesso (seedbox → poll → pickFile), `enqueue`, `checkCached` devolve `Set` vazio com `known` honesto |
| 3.7 ✅ | T6: harness mutante seguro | `test/empirical-e2e-challenger.js` (e irmãos) | operar sobre CÓPIA do `dist/` (snapshot + restore em `finally`), nunca in-place; targets por regex tolerante ou assinatura estrutural |
| 3.8 ✅ | T7: harnesses no `test:complete` | `scripts/check-test-list.ts` + `package.json` | checagem de sanidade dos 5 harnesses (existência, imports resolvem com `node --check`, fixtures presentes) sem executá-los no CI |

**Ordem interna:** 3.7 primeiro (protege o próprio instrumento), depois 3.1–3.6, 3.8 por último.
**Validação:** `npm test` + `test:complete`; 3.7 validado rodando `npm run test:adversarial` UMA vez com interrupt simulado (Ctrl+C no meio → `dist/` intacto).
**Gate da fase:** sem 3.1–3.3 e 3.7 verdes, a fase 5 não começa.

---

## Fase 4 — Orçamento de busca: fechamento do B3

**Objetivo:** o comportamento novo do budget (2.5) ficar provado, não só
compilado. Esforço S–M.

| # | Tarefa |
|---|---|
| 4.1 ✅ | Teste com cinemeta lento (2500ms) + TMDB miss (5000ms): resposta NÃO estoura o deadline. `test/search-budget-metadata.test.ts`, mais os dois T5 do `collection-window` |
| 4.2 ✅ | `search.deadline` agora preserva o total e segmenta em `.metadata`/`.providers`. O corte é de metadata também quando ela termina depois da janela normal de coleta (`deadlineAt − debridReserve`): o piso de 500ms pode deixar provider em voo, mas não muda a causa. `search.metadata` é timer (avg/p95/max) no `/metrics.json`, consolidado no `/dashboard-status.json` e exibido no dashboard. Prova: `test/search-budget-metadata.test.ts` reproduz os dois lados, inclusive provider lento depois de metadata que já consumiu seu orçamento. |
| 4.3 ✅ | Revisar `Math.max(500, …)`: **decisão — manter.** É intencional, não sobra de fatia fixa. `remainingCheckBudget(deadlineAt) − debridReserve` fica negativo quando metadados lentos já corroeram a reserva; sem o piso, `collectRaw` desistiria sem tentar e a resposta sairia known:false/vazia de bandeja. O piso não pode estourar o `replyDeadline`: o `raceWithDeadline` de `findStreams` corta `doSearch` no relógio absoluto (mesmo `deadlineAt`), **independente** do orçamento interno — pior caso é a resposta chegar até 500ms mais perto do corte externo, nunca depois. Trocar por devolver parcial na hora (orçamento 0) não evita corte nenhum (o relógio externo já protege) — só troca uma tentativa real de coleta por known:false garantido, pior para quem usa. Documentado em `src/providers/index.ts` junto do cálculo |

**Risco:** médio — mexe no invariante 1. Qualquer mudança aqui exige releitura
da seção "orçamento de tempo" do AGENTS.md antes.

---

## Fase 5 — Refactor arquitetural incremental

**Objetivo:** reduzir o custo de manutenção sem mudar comportamento. Cada
subfase termina com suíte 100% + `test:adversarial`/`test:stress` verdes
(harnesses são a prova de que o refactor não enfraqueceu nada).

**Ordem** (da maior razão risco/benefício para a menor):

### 5.1 ✅ — Split de `src/providers/index.ts` (A1) — esforço L — CONCLUÍDA (2026-08-23)

Migradas as funções para módulos irmãos, `index.ts` como fachada que
reexporta (os imports dos 63 arquivos de teste que consomem a fachada não
mudaram):

- `providers/autofetch-runner.ts` — seleção de candidatos, holds/markers,
  `drainNext`, recheck, settle, detecção de morte;
- `providers/debrid-pipeline.ts` — `applyDebrid`, filtro pré-checagem,
  auditoria de áudio (`collectAuditCandidates`, `queueDubAudit`, `runDubAudit`);
- `providers/stream-builder.ts` — `buildStreams`, `applyFileEvidence`,
  `applyNoticeOrigin`, `onlyNotice`;
- `providers/search-cache.ts` — `findStreams`, coalescing (`inFlight`), SWR
  (`debridRefreshSatisfied`, `staleRefreshEligible`, `scheduleStaleRefresh`),
  `hasPlayableStream`;
- `providers/search-orchestrator.ts` — `doSearch`, `collectRaw`,
  `poolCovered`, `idxPoolCovered`, `idxReleasesToRaw`.

`search-cache.ts` e `search-orchestrator.ts` saíram no MESMO commit: eles se
referenciam em ciclo (`doSearch` chama `hasPlayableStream`/
`debridRefreshSatisfied`; `findStreams`/`scheduleStaleRefresh` chamam
`doSearch`). ESM aceita import circular entre módulos irmãos quando o uso
fica dentro de corpo de função — nunca em top-level — e é exatamente esse o
caso; confirmado pelo typecheck, build e pela suíte inteira.

`index.ts` caiu de 2220 para 17 linhas: só import + reexport dos 9 nomes
públicos, mais o glue de `autofetchStatus` (agrega `autofetchRunnerStatus()`
de `autofetch-runner.js` com `searchesInFlightCount()` de `search-cache.js`
— não guarda mais estado próprio).

**Não feito:** o `SearchPhase` explícito (A3, `'collecting' |
'response-built' | 'late-collecting' | 'pack-fallback' | 'enriching' |
'completed'`) mencionado no contrato original — o split foi mecânico, sem
introduzir a máquina de estados nova. O controle de fase continua implícito
via `finish.phase()`/`finish.advance()` do `latest-writer`. Fica como
follow-up separado se algum dia valer o risco.

`test/empirical-e2e-challenger.ts` precisou de dois ajustes: MUT-09 e MUT-10
miravam string literal em `dist/src/providers/index.js`, e as duas saíram de
lá com `applyDebrid`/`doSearch` — o harness falhou alto ("Target not found")
até os `file:` apontarem para `debrid-pipeline.js`/`search-orchestrator.js`.
Exatamente o comportamento que a rede de segurança deveria ter.

**Estratégia usada:** uma extração por commit (autofetch-runner →
debrid-pipeline → stream-builder → search-cache+search-orchestrator juntos),
gate completo (`typecheck`, `build`, `npm test`, `test:complete`,
`test:adversarial`, `test:adversarial-m1`, `test:protector-m1`,
`test:challenger-m2`, `test:stress`) entre cada uma.

### 5.2 ✅ — Extração de `pickFile`/`pickWorkFile` (A1b) — esforço S — CONCLUÍDA (2026-08-24)

`src/debrid/file-selector.ts` ganhou a lógica do play: `pickFile`,
`pickWorkFile`, `workCoverage`, `looksMultiWorkFiles`, `baseName`, `isSiteAd`
e as marcas `VIDEO_EXT`/`SAMPLE`/`EXTRA`, junto dos erros
`WorkPickError`/`EpisodePickError`/`NoVideoError`/`DubLieError` (com os
respectivos type guards, reexportados abertos via `export { … }`). `common.ts`
virou reexport do módulo — manteve só `magnetFor`, fetch JSON, lotes,
`AuthError`/`QuotaError` e re-exporta `DebridFile` — então os consumidores que
importavam de `common.js` não mudaram uma linha. Os nomes originais foram
preservados (a extração não seguiu os nomes provisórios
`selectEpisodeFile`/`selectWorkFile`/`selectMovieVideo` do plano original).
Testes existentes de `debrid-pick-work` passam sem mudança.

### 5.3 ✅ — Split de `src/utils/format.ts` (A2) — esforço M — CONCLUÍDA (2026-08-23)

2.307 linhas / 57 exports em 7 módulos, camadas sem ciclo (cada um só importa
dos que vêm antes):

1. `title-normalization.ts` — base, zero dependência interna:
   `bytesToSize`, `extractInfoHash`, `decodeEntities`, `normalizeTitle`;
2. `episode-matching.ts` — usa title-normalization: `parseTitleSeasonEpisode`,
   `seasonCoverageExcludes`, `matchesEpisode`, `isSeasonPackRelease`,
   `isSeasonPackFillEligible`;
3. `release-matching.ts` — usa title-normalization + episode-matching:
   `matchesName`, `matchesBrTitle`, `matchesTitleStructure`,
   `matchesEpisodeWorkIdentity`, `isMultiWorkCollection`, `franchiseRoot(s)`,
   `containsTokenRun`, `filterInventoryRelevant`, `filterRelevantRaw`,
   `magnetYearContradicts` — exporta `TECH_NOISE`/`LEADING_ARTICLES` para
   quem precisa deles fora do módulo;
4. `audio-quality.ts` — usa title-normalization + release-matching (só
   `TECH_NOISE`, para o vocabulário do blob de tags): `UNKNOWN_QUALITY`,
   `qualityFromTitle`, `stripQualityTagBlob`, `sourceFromTitle`,
   `audioFromTitle`, `editionFromTitle`, `explicitPtAudio`, `hasPtAudioMark`,
   `strongEnSceneMark`, `dubbedLieVerdict`, `hasExplicitForeignAudio`,
   `looksPtBr`, `compactAudio`, `compactTracker`;
5. `stream-quotas.ts` — usa audio-quality + episode-matching:
   `QUALITY_KEYS`, `streamQuality`, `selectQualityCandidates`,
   `limitByIndexer`, `limitByQualityAndIndexer`, `limitByQuality`,
   `limitReservingBr`;
6. `search-names.ts` — usa title-normalization + release-matching +
   stream-quotas: `TRACKERS`, `streamDisplayName`, `markDebridName`,
   `matchesQualityFilter`, `passesQualityFilter`, `toStremioStream`,
   `resolveSearchNames`, `parseStremioId`, `buildSearchQuery`,
   `numeralSearchVariant` — "search-names" é nome de compromisso: o módulo
   também é o formatador de stream do Stremio, porque `toStremioStream` usa
   os mesmos classificadores de áudio/qualidade que os nomes de busca;
7. `stream-ranking.ts` — o mais dependente (audio-quality + episode-matching +
   stream-quotas + search-names): `relabel`, `dedupeByHash`, `brDubbedPool`,
   `anyDubbedPool`, `topSeededPool`, `pickBrDubbedCandidate(s)`,
   `pickAnyDubbedCandidates`, `pickTopSeededCandidates`, `hasCachedBrDubbed`,
   `canAutoFetchBr`, `uncachedBrHashes`, `filterKnownCache`, `sortAndLimit`.

`format.ts` virou barrel puro: reexporta os mesmos 57 nomes de antes, na
mesma assinatura — os ~19 arquivos de teste e os consumidores em
`src/providers/`/`src/debrid/` que importam de `utils/format.js` não
mudaram uma linha. A remoção do barrel continua decisão posterior.

Diferente do 5.1 (uma extração por commit), o split de `format.ts` saiu num
commit só: as constantes de matching (`TECH_NOISE`, `PACK_WORDS`,
`LEADING_ARTICLES`, `STOP_AT`…) são compartilhadas por funções de módulos-
alvo DIFERENTES de um jeito que não dá pra separar em fatias
independentemente verificáveis sem duplicar constante ou deixar um estado
intermediário quebrado. O gate rodou inteiro (typecheck, build, suíte,
`test:complete`, os 5 harnesses) antes do commit, não entre extrações.

O harness adversarial (`test/empirical-e2e-challenger.ts`) precisou de mais
3 ajustes de caminho — MUT-01 (`matchesBrTitle` → `release-matching.js`),
MUT-02 (`dedupeByHash` → `stream-ranking.js`), MUT-08 (`limitReservingBr` →
`stream-quotas.js`) — mesmo padrão do MUT-09/MUT-10 no 5.1.

### 5.4 ✅ — Núcleo comum dos resolvers (A4) — esforço M — CONCLUÍDA (2026-08-24)

`resolvers/` é o núcleo CommonJS dos quatro resolvedores do processo
embutido. Os perfis por site em
`resolvers/profiles/{bludv,comandotorrents,nerdfilmes,torrentdosfilmes}.js`
carregam parsers, regras e caches **específicos do site** — o que o núcleo
comum não deve assumir. Cada `<nome>-resolver/server.js` é um shim de
compatibilidade que faz `require('../resolvers/profiles/<nome>')` e reexporta
o módulo, então o carregador embutido da `br-resolvers.ts` (caminho histórico
`../<nome>-resolver/server`) e os consumidores legados não mudaram.
`scripts/build-assets.ts` passou a copiar `resolvers/` inteiro para `dist/`
(junto dos shims), e o `Dockerfile` mantém o núcleo em `/app/resolvers` no
stage final para inspeção operacional. Testes de parser por site continuam
apontando para os profiles.

Núcleos compartilhados relevantes em `resolvers/`, com um dono único e sem
cópia nos profiles:

- **Processo**: `runtime.js`, `site-selector.js` (failover por host),
  `cache.js` (L1), `http-server.js` e `flare.js` (passagem
  Cloudflare/FlareSolverr) — núcleo de boot já entregue antes desta
  conclusão.
- **Seleção de posts**: `search-posts.js` (pré-filtro de posts e da
  temporada antes do limite, ordem comum reutilizada pelos quatro profiles).
- **Documento e texto**: `text.js` (decode de entidades e texto comum das
  páginas).
- **Matching e identidade**: `matching.js` (matching da busca, temporada,
  listas genéricas e identidade de botão — `createHash` de dedupe).
- **Transporte e protetores**: `transport.js` (cadeia HTTP dos **quatro**
  perfis: `followProtectedUrl`, saltos/protetor de link, `assertAllowedUrl`),
  `nested-url.js` (desempacotamento da URL envelope do Cardigann em
  `/resolve`), `torznab.js` (capacidades/`capsXml` dos feeds com formato
  idêntico) e `protector.js` (allowlist de host).
- **Concorrência**: `concurrency.js` (`mapLimit` com teto, `limit` e
  `onError` explícitos).

As quatro extrações desta conclusão rodaram o gate completo da fase 5 e
preservaram os exports dos shims; parser por site continua nos profiles,
que é exatamente onde a regra específica deve morar.

**Segunda passada (2026-08-24, `48b6773`) — o que ainda era duplicação real.**
A redação anterior desta seção dizia que o resíduo nos profiles era "por
desenho, não duplicação a migrar". Não era verdade para três funções, e a
contagem que sustentava a afirmação (nomes de função repetidos nos quatro
arquivos) inflava o problema em um sentido e o escondia em outro: das 19
repetidas, 5 já eram adaptadores de 3 linhas ligando as constantes do site ao
núcleo — `assertAllowedUrl` já delegava a `sharedAssertAllowedUrl`, então o
risco de "corrigir a allowlist em quatro lugares" **não existia**. A métrica
honesta é linha de lógica duplicada, não nome repetido.

O que de fato faltava migrar:

- **`fetchFollowingAllowed`** — NerdFilmes e TorrentDosFilmes ainda tinham o
  laço de saltos do protetor escrito à mão (46 e 39 linhas), repetindo o que
  `followProtectedUrl` já fazia, enquanto BluDV e ComandoTorrents delegavam.
  Com os quatro no mesmo transporte, o mutante **MUT-06** (allowlist de host)
  passa a cobrir os quatro pelo mesmo caminho em vez de dois.
- **`extractMetaRefresh`** — byte-idêntico em BluDV e ComandoTorrents, ausente
  nos outros dois, que usavam um regex inline mais fraco. Virou um só em
  `text.js`, com o `decode` por parâmetro (variante rica × histórica); os
  quatro ganharam o parser que aguenta aspas aninhadas no `content`.
- **`mapLimit`** — quatro cópias diferindo só na fonte do limite e em logar ou
  não o erro.

Para absorver o NerdFilmes, `followProtectedUrl` ficou case-insensitive no
scheme e normaliza para `magnet:` minúsculo — era só por causa do `MAGNET:`
que ele publica em parte dos botões que o laço próprio existia; para os outros
três a normalização é no-op. Perfis **3.263 → 3.115** linhas, núcleo
**474 → 539**.

Continuam nos profiles, corretamente, as seis funções com quatro
implementações genuinamente distintas: `parseDownloadLinks`, `parsePosts`,
`getPostLinks`, `resolveButton`, `searchPageHtml` e `releaseTitle`.

### 5.5 ✅ — Rotas de `app.ts` (A1c) — esforço M — CONCLUÍDA (2026-08-24)

`app.ts` caiu de 737 para 39 linhas: virou `createApp()` que só compõe —
manifest, `createStreamHandler` (de `routes/stream.ts`) e `registerRoutes`
(de `routes/register.ts`); reexporta `asyncRoute`, `originOf` e
`streamsNeedRevalidation`. A montagem toda mora em `src/routes/`:
`services.ts` (`buildServices()` → `AppServices`), `register.ts` (único ponto
de montagem das rotas), `stream.ts`, `resolve.ts` (`makeResolveHandler`),
`public.ts` (`/configure`, `/dashboard`, `/defaults.json`, `/seal-config`),
`diagnostics.ts` (`/metrics.json`, `/dashboard-status.json`,
`/dashboard-action.json`, `/test-indexer.json`, `/debrid-status.json`),
`origin.ts`, `async.ts`, `state.ts` (`prefetchInFlight`) e `types.ts`
(`AppServices`/`HandlerFactory`). Os handlers recebem `AppServices` (debrid,
cache, metrics, jackett). `asyncRoute` (2.7) continua aplicado nas rotas
async. Os testes de rota seguem passando por cima do app real (`createApp`).
O nome de diretório ficou `routes/`, não `app/*-routes.ts` como o plano
provisório sugeria.

### 5.6 — `process.env` centralizado (A5) — esforço S — CONCLUÍDO

`config.resolvers` (inclusive controles de carga, host, offset, portas e URLs
dos sites), `config.cache.persist`, `config.cache.dbPath`, `config.logging.level`
e os limiares de conta do debrid são a fonte dos consumidores TypeScript.
`br-resolvers.ts` mantém apenas a ponte explícita de mutação/restauração de
`process.env` para compatibilidade dos profiles CommonJS; seus valores vêm de
`config` e ela não faz leitura de controle do ambiente.

Critério de saída: `git grep -n 'process\.env' -- 'src/**/*.ts'` só pode
encontrar `config.ts` e a ponte de compatibilidade documentada em
`br-resolvers.ts`; os valores de controle dessa ponte precisam vir de `config`.
Scripts CLI, testes e `resolvers/**/*.js` ficam fora desta métrica porque são
processos/ambientes distintos.

### 5.7 ✅ — Redução de `any` (A6) — esforço contínuo — CONCLUÍDA (2026-08-24)

Prioridade atendida: opções de `applyDebrid`/`buildStreams`, respostas por
adaptador (`PremiumizeTransfer`, `TorboxRow`, `AllDebridMagnet`), handlers
Express com `Request`/`Response`. Metodologia: `unknown` na fronteira externa
+ normalização imediata — `any` só permanece onde a tipagem seria uma mentira
ou um cast cego sobre contrato de terceiro.

**Métrica reproduzível:** a sondagem oficial é
`@(git grep -n -E '\bany\b' -- src).Count` no PowerShell. Ela conta **linhas**
com o token e hoje retorna **146**. Quando ela retornava 152, os cinco itens
subtraídos para chegar aos 147 documentados eram os quatro literais em
`autofetch-runner.ts` — `pool = 'any'`, `autofetch.any-dubbed` e os dois testes
de `pool === 'any'` — e `source || 'any'` em `search-names.ts`; nenhum é o tipo
`any`. Logo, os cinco são falsos positivos de strings, não tipos reais. Há ainda
um sexto falso positivo independente, o comentário em `net-safety.ts`; por isso
147 não era uma métrica honesta de ocorrências explícitas e foi aposentado.

A meta “menos de 150” usa ocorrências explícitas do tipo `any`, não linhas nem
texto. Para reproduzi-la, execute o contador da AST do TypeScript:
`node -e "const ts=require('typescript'),cp=require('child_process');let n=0;for(const f of cp.execFileSync('git',['ls-tree','-r','--name-only','HEAD','src'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(f=>f.endsWith('.ts'))){const s=ts.createSourceFile(f,cp.execFileSync('git',['show','HEAD:'+f],{encoding:'utf8'}),ts.ScriptTarget.Latest,true);const w=x=>{if(x.kind===ts.SyntaxKind.AnyKeyword)n++;ts.forEachChild(x,w)};w(s)};console.log(n)"`.

> **Correção do contador (2026-08-24).** A versão anterior usava
> `git ls-files 'src/**/*.ts'`, e esse pathspec **não casa os arquivos na raiz
> de `src/`**: ficavam de fora `addon.ts`, `app.ts`, `br-resolvers.ts`,
> `config.ts`, `runtime.ts` e `warmup.ts` — 66 arquivos contados de 72 reais,
> escondendo 5 ocorrências (`runtime.ts` 4, `br-resolvers.ts` 1). O comando
> acima usa `git ls-tree -r`, que enxerga os 72. Por isso o **149** registrado
> antes não era o número real: medido com o contador corrigido, o mesmo commit
> (`4b84127`) tinha **156** — ou seja, a meta ainda não estava batida quando
> foi declarada.

Baseline registrado em 2026-08-24: **274**; a alegação intermediária de **147**
não é comparável por misturar linhas e texto. Medições com o contador
corrigido, todas sobre os 72 arquivos:

| Commit | `any` (AST) | Nota |
|---|---|---|
| `4b84127` | 156 | quando 5.7 foi declarada concluída — acima da meta |
| `e25ef29` | **143** | **abaixo de 150** ✅ |

O fechamento veio de `src/debrid/alldebrid.ts` (13 → 0): `AllDebridMagnet` e
`AllDebridFileNode` dão forma ao que `/magnet/status` e a árvore de arquivos da
v4.1 devolvem, e `flattenFiles`/`inventory` passaram a declarar `DebridFile[]` e
`InventoryItem[]` — tipos que já existiam e eram reconstruídos como `any[]`.

Tipar expôs **quatro defeitos latentes** que o `any` escondia: `m.hash` e `m.id`
são opcionais na resposta da API e iam direto para `held.isHeld(hash: string)` e
`dropMagnets(ids: (string|number)[])`. O filtro logo acima já garantia `m.id`,
mas o compilador não propaga isso pelo `filter`: os dois usos viraram `flatMap`,
que diz o mesmo sem asserção. Corrigidos na fronteira, não silenciados com cast.

**Categorias residuais legítimas (mantidas como `any`, decisão registrada):**
- **Payloads de terceiros** — respostas de debrid, Jackett/Torznab e sites BR,
  cujas formas não são contrato nosso; normaliza-se após o `fetch`, não se
  tipa como `unknown` no ponto de recebimento.
- **`node:sqlite` sem tipagem no Node 20** — o `require` lazy (compat 20/22)
  não expõe tipos; o `any` documenta o acesso à API que só existe em runtime.
- **Compatibilidade Jackett** — superfícies das definitions Cardigann cujo
  contrato não é verificável por tipo.
- **Pools polimórficos** — coleções heterogêneas de fontes/streams de natureza
  distinta, em que a união tipada custaria casts mais frágeis que o `any`
  anotado no ponto de acesso.

**Gate da fase 5:** após CADA subfase: `npm run typecheck && npm run build
&& npm test && npm run test:complete` + `npm run test:stress && npm run
test:adversarial && npm run test:adversarial-m1 && npm run test:protector-m1
&& npm run test:challenger-m2` (baseline dos harnesses tirada na fase 3.7).
**Rollback:** subfase inteira revertível por commit revert; barrel/reexport
garante que nenhum consumidor quebra no meio.

### 5.8 — Orçamento de linhas por arquivo (A7)

**Decisão (catraca, não teto retroativo).** A medição de 2026-08-28 — 206
arquivos versionados no escopo (`src/`, `resolvers/`, `scripts/`, `test/`,
`types/`, `*-resolver/`), 65.864 linhas, **58 acima de 400**, excedente somado
**20.031** — inviabiliza teto duro retroativo: ninguém reescreve vinte mil
linhas para o CI ficar verde, e um teto que reprova sempre é um teto que ninguém
lê. A catraca resolve porque só encolhe sozinha, com três regras: **(A)**
arquivo NOVO acima de 400 reprova sempre, sem escape; **(B)** arquivo existente
acima do baseline reprova, com escape explícito `npm run lint:lines -- --bless`,
que regrava o baseline daquele arquivo — o diff do `.line-budget.json` entra no
commit; **(C)** quando o arquivo diminui, o script regrava o baseline para baixo
sozinho. O gate nunca reprova em silêncio: todo agravamento fica escrito no
JSON e todo bless fica visível no diff.

**Modos.** `npm run lint:lines` verifica e aplica a regra C;
`npm run lint:lines -- --bless` regrava crescimentos (não dispensa a regra A —
arquivo novo acima de 400 reprova mesmo em modo bless);
`npm run lint:lines -- --check` é o modo CI: nunca escreve, e a regra C vira
aviso (a máquina não commita).

**Métrica reproduzível.** O comando oficial é `npm run lint:lines -- --check`
(roda de `dist/` como todo script — build antes). O baseline é
`.line-budget.json` na raiz do repositório, commitado, com `limite`, `gerado`,
`excedente` e `arquivos` (só os arquivos acima de 400). A contagem de linhas é
bytes `\n` + 1 se o último byte não for `\n` — imune a CRLF (`* text=auto` +
autocrlf no Windows) e conta **1025** no `resolvers/profiles/vacatorrent.js`,
não os 1024 do `wc -l`: o arquivo termina sem newline. O script é a autoridade,
não a medição que originou o plano.

> **Correção do pathspec (2026-08-28; escopo estendido a `.css` em 2026-08-29).**
> O escopo da varredura é
> `git ls-files src resolvers scripts test types "*-resolver/**"`, filtrado a
> `.ts`/`.js`/`.css` sem `.d.ts` (o `.css` entrou quando a Fase 3 deu arquivo
> próprio ao CSS dos painéis — antes ele vivia inline no html, fora de escopo).
> Duas armadilhas, ambas medidas: GLOBS de pathspec
> `'src/**/*.ts'` **não casam os arquivos na raiz de `src/`** — o mesmo
> precedente do contador da §5.7, que varria 66 dos 72 arquivos; e o glob puro
> `"*-resolver"`, a forma escrita primeiro neste plano, casa **zero** arquivos
> dos shims — `git ls-files src resolvers scripts test types "*-resolver"`
> devolve exatamente os mesmos 237 caminhos que sem o argumento, enquanto
> `*-resolver/**` adiciona os 21 arquivos dos cinco `*-resolver/`. Por isso a
> forma com `/**` é a oficial.

**Baseline por commit.** Como na §5.7, a catraca é medida pelo script, não pelo
plano:

| Commit | Excedente | Entradas (>400) | Nota |
|---|---|---|---|
| `a9932aa` (Fase 1, portão no ar) | **20.032** | 58 | primeira medição do script: 210 varridos com o pathspec corrigido (203 dos diretórios + os 7 `.js` dos cinco `*-resolver/`); os 10 arquivos sem newline final somam +1 na contagem, mas só o `vacatorrent.js` (1024 → 1025) está acima do teto. Medição do plano que originou a fase: 20.031 / 58 em 206 arquivos (`wc -l`, 2026-08-28) |
| item 1 — `src/config.ts` (Fase 2) | 19.653 | 57 | split em 10 seções por domínio (`src/config/`); a entrada saiu do JSON (779 → 58) e a superfície `export default config` não mudou |
| item 2 — `src/debrid/index.ts` (Fase 2) | 19.111 | 56 | barrel de 53 linhas sobre 7 módulos irmãos sem ciclo (registry, cache-check/davail, inventário, status de conta, env-ops, actions, catálogo); default com as mesmas 27 chaves na mesma ordem |
| item 3 — `src/utils/cache.ts` (Fase 2) | 18.813 | 55 | estado mutável ficou no `cache.ts` (286); irmãos são política pura (`cache-quotas.ts`) e fábrica de persistência (`cache-db.ts`) — o teste de cache-busting com `import('?query')` pegou o vazamento de estado entre instâncias e ditou a forma |
| item 4 — par harvester (Fase 2) | 18.648 | 53 | `harvester.ts` 506 → 180 (fila em `harvest-queue.ts`, colheita unitária em `harvest-worker.ts`) e `harvester-live.ts` 459 → 138 (validação/clamps em `harvester-live-schema.ts`); ambos saíram do JSON. No gate seguinte a catraca pegou `cache-db.ts` do item 3 com 409 linhas (invisível à regra A enquanto não-rastreado) — extraído em `cache-db-open.ts` (`0aa41bf`) |
| item 5 — `debrid-pipeline.ts` (Fase 2) | 18.322 | 52 | barrel de 10 linhas sobre core (`applyDebrid`, 375), etapas extraídas (`debrid-pipeline-steps.ts`, 271) e auditoria de áudio (`dub-audit.ts`, 185); a MUT-09 do harness adversarial foi repontuada para `debrid-pipeline-core.js` (mesmo defeito injetado, "CAUGHT" confirmado) |
| item 6 — `realdebrid.ts` (Fase 2) | 18.150 | 51 | três módulos em camada única sem ciclo: core HTTP/paginação (`realdebrid-core.ts`, 117), fluxo de play/autofetch (`realdebrid-play.ts`, 264) e montagem do adaptador (239); os 15 exports do adaptador preservados, spread do registry idêntico |
| item 7 — `alldebrid.ts` (Fase 2) | 17.766 | 50 | fachada de 37 linhas sobre api (216), inventory (124, dono do snapshot `knownBefore`), cleanup (210, `skipCleanup`/BR preservado), check (109, upload + `dropReady`/`dropUncached` independentes) e play (102); 20 exports de runtime verificados no `dist/` |
| item 8 — `diagnostics.ts` (Fase 2) | 17.674 | 49 | despacho por ação extraído (`dashboard-actions.ts`, 341 — mapa com as 28 ações, allowlist derivada das chaves, `DESTRUCTIVE_ACTIONS` com confirm); `diagnostics.ts` fica em 203 com os mesmos 5 handlers; 2 testes do `catalog-panel` que regexavam o TEXTO do fonte passam a importar os conjuntos exportados |
| item 9, passo 1 — núcleo `site-profile.js` (Fase 2) | 17.509 | 49 | factory do bootstrap repetido nos 5 profiles (206 linhas: allowlist, trio de guards delegando ao `protector.js` — MUT-06 intacto, failover, boot); perfis encolhem 27-38 linhas cada, exports idênticos (47/54/40/32/31); sem estado mutável em núcleo (fresh-require do stress prova) |
| item 9, passo 2 — adoção de `cache.js` (Fase 2) | 17.341 | 49 | bludv/comando/tdf/vaca trocam os mapas TTL+coalescing+escritos à mão por `createCache(limit, { inFlight })` (+4 no núcleo, retrocompatível); shapes e chaves literais dos testes preservados (R-3), tetos não uniformizados; −164 líquidas |
| item 9, passo 3 — núcleo `magnet-extract.js` (Fase 2) | 17.024 | 49 | extractor parametrizado das 3 variantes (básica tdf/nerd, rica comando/bludv, rica+base64 vaca — R-6 provado por fixture) + `discoverNextUrl` do `nextProtectedUrl` com `jsVarPattern` por perfil (listas de variável JS divergem de propósito); regex pré-compiladas no closure (R-7); −317 líquidas |
| item 9, passo 4 — núcleos `release-rules.js` + `release-format.js` (Fase 2) | 16.488 | 49 | classificadores/episódio/máquina de estados da âncora (301) e títulos/feeds/normalizeQuery/laço de fallback (232); 5 perfis encolhem (bludv 972→810, vaca 880→766, nerd 637→567, comando 569→402, tdf 429→406 — ainda acima do teto, débito honesto no JSON); 2 divergências do módulo parcial abortado corrigidas na auditoria; R-4/R-5 preservados por parâmetro (typo BLRAY da vaca, saída própria do nerd/tdf, pack `\bbatch\b`) |
| item 9, passos 5+6 — núcleo `resolver-http.js` + flare (Fase 2) | 16.351 | 47 | roteador comum (157 linhas, hooks por perfil — zero `if` por site) e `flare.js` absorve o FlareSolverr do bludv (16→133, relocalização com reexport); **comando e tdf SAÍRAM do JSON** (384/386); bludv 719, vaca 748, nerd 547 ficam como débito honesto — split horizontal só se churn justificar. Bônus: o gate pegou regressão do passo 4 (`magnetButtonCacheKey` sem import no nerd — `/resolve` e `/dl` com 502) que os 1506 testes não viam; corrigida com import + teste novo da rota (1507 testes) |
| escopo estendido a `.css` (pós-Fase 3, achado de revisão) | 16.456 | 48 | o scanner passou a varrer `.css` e o baseline foi regenerado: `src/public/configure.css` (505, era inline no html fora de qualquer escopo) entra como débito registrado — sem isso a garantia "sem exceção nenhuma" do 5.9 não se sustentava |

**Backlog de resgate, ordenado por churn** (commits nos últimos 90 dias — os
que mais se mexem primeiro, não os maiores primeiro; é onde a catraca morde,
porque é nesses arquivos que o `--bless` vai aparecer):

| # | Arquivo | Linhas | Commits (90d) | Costura |
|---|---|---|---|---|
| 1 | `src/config.ts` | 779 | 42 | objeto com seções nítidas (debrid sozinho ocupa as linhas 367–676, jackett as 35–121) → `src/config/<seção>.ts` compostos num `config.ts` de ~50 linhas, mesmo padrão de barrel do §5.1 |
| 2 | `src/debrid/index.ts` | 942 | 21 | camada de env (`catalogListEnv`/`manualDeleteEnv`, `b159524`) separável do core |
| 3 | `src/utils/cache.ts` | 698 | 20 | os níveis de cache já são camadas conceituais |
| 4 | `src/providers/harvester.ts` | 506 | 18 | par com `harvester-live.ts` (459), também acima |
| 5 | `src/providers/debrid-pipeline.ts` | 726 | 14 | |
| 6 | `src/debrid/realdebrid.ts` | 572 | 14 | |
| 7 | `src/debrid/alldebrid.ts` | 784 | 13 | |
| 8 | `src/routes/diagnostics.ts` | 492 | 13 | cresce a cada ação nova do dashboard; despacho por ação é a costura óbvia |

Baixo churn/alto tamanho ficam para depois — a catraca não morde neles:
`catalog.ts` (1.064 linhas / 5 commits), `vacatorrent.js` (1.024 / 2),
`autofetch-live.ts` (495 / 1). Caso à parte único: os cinco profiles de
resolver (`bludv` 1.136, `vacatorrent` 1.024, `comandotorrents` 731, `nerdfilmes`
717, `torrentdosfilmes` 528 — 4.136 linhas com estrutura repetida). O §5.4 já
extraiu o núcleo comum uma vez e o vacatorrent chegou depois; uma **segunda**
rodada de núcleo comum vale mais que cinco splits independentes.

**Regra de execução do backlog** (herdada do §5.1/§5.4): uma extração por
commit, barrel/reexport preservando os nomes públicos, e o gate da fase 5 após
cada subfase (`npm run typecheck && npm run build && npm test &&
npm run test:complete` + os cinco harnesses: `test:stress`, `test:adversarial`,
`test:adversarial-m1`, `test:protector-m1`, `test:challenger-m2`).
**Rollback:** `git revert` da subfase inteira. A cada subfase, anotar na tabela
de baseline acima o novo excedente (como a §5.7 faz com o contador de `any`) e
remover a entrada do arquivo que caiu abaixo de 400.

**Riscos registrados.** Ruído de `--bless` no começo: `format.test.ts` (2.753
linhas) e `autofetch.test.ts` (2.861) somam 33 commits em 90 dias — uma
sequência de blesses sem queda aparece na tabela e é sinal para agendar a
extração daquele arquivo, não para continuar abençoando. Split mecânico
piorando o código: TS/ESM obriga a exportar o que era interno — seguir o padrão
de camadas sem ciclo do §5.3 e preferir deixar o débito no JSON a forçar split
ruim.

### 5.9 — Extração dos HTML do painel ✅

**Concluída** (configure no `80de8fc`, dashboard no `f98b677`). Extrair o JS e o
CSS inline de `src/public/dashboard.html` (2.429 linhas) e `src/public/configure.html`
(1.771) para arquivos próprios em `src/public/`, servidos como estáticos — o
`scripts/build-assets.ts` já copia o diretório inteiro para `dist/`, então não há
passo de build novo. Os módulos JS resultantes entraram no escopo da catraca
(5.8) sem exceção nenhuma (todos ≤ 400 no nascimento); o CSS ganhou arquivo
próprio na mesma fase e o **scanner foi estendido a `.css`** na sequência — o
`configure.css` (505 linhas, até então inline no html e fora de qualquer escopo)
entrou no baseline como débito registrado, sujeito à catraca como qualquer
legado (correção de revisão: a redação original prometia "sem exceção nenhuma"
que a ferramenta não sustentava). **Guarda-corpo:**
`test/dashboard.test.ts` e `test/configure-html.test.ts` (e os de painel
`catalog-panel`/`harvester-panel`) passaram **sem alteração**.

Resultado:

| Arquivo | Antes | Depois | Extraído |
|---|---|---|---|
| `configure.html` | 1.771 | 1.056 | `configure.css` (505) + `configure-app.js` (221: el/estado, base64url, selo, wiring) |
| `dashboard.html` | 2.429 | 1.556 | `dashboard.css` (201) + `dashboard-core.js` (324) + `dashboard-panels.js` (186) + `dashboard-status.js` (203) |

**O contrato que a extração revelou:** os testes regexam CORPOS de função e
âncoras de texto DENTRO do html (`collect`/`apply`/`render`/`fromUrl`,
`renderMagnetDb`, os painéis do Chupim/Colhedor, a seção Conta/Catálogo inteira,
bloco de limites, boot saved/else) — **essas partes continuam inline por
contrato**, e só o não-ancorado sai. Scripts extraídos são top-level (a IIFE do
inline foi desembrulhada para o escopo global compartilhado), ES5 puro, ordem
core → panels → status → inline; caminhos absolutos (`/configure.css`) porque as
páginas respondem em `/configure` e `/:userConfig/configure`. Servidor:
`PAGE_ASSETS` em `src/routes/public.ts` — allowlist FECHADA (nome arbitrário na
URL abriria traversal), rotas no loop de `register.ts`.

**Lição registrada** (tentativa descartada): a primeira extração foi feita num
worktree criado sobre base desatualizada do `origin/esm` — o dashboard de lá
não tinha os +1.471 linhas de painéis novos e o configure não tinha o toggle do
Torrentio; cherry-pick conflitou e o trabalho foi refeito direto no checkout.
Worktree de agente herda o push, não o HEAD local — conferir a base antes de
delegar trabalho que depende do estado corrente.

---

## Fase 6 — Longo prazo / opcionais

| # | Tarefa | Nota |
|---|---|---|
| 6.1 ✅ | `stremio-addon-sdk` saiu do runtime: router Express próprio preserva manifest/stream, CORS, `Cache-Control` e mounts raiz/config; SDK ficou em devDeps como referência dos 3 e2e | concluída após 5.5 |
| 6.2 ✅ | Dashboard: `clear-cache` seletivo por namespace ou pela instalação corrente; sem `scope` preserva limpeza global | concluída após 5.5 |
| 6.3 ✅ | `davail`: amostra local de 2026-08-24 (uptime 1.822s) teve 112/360 = **31,1%** de hashes repetidos e 186 servidos do L1; acima do gate histórico de 30%, mantém TTLs 900s/120s. **Baseline 0 (22:58 do mesmo dia, janela de 7 dias aberta):** contadores acumulados do container: `davail.servedHashes`=878 vs `debrid.check.hashes`=736 → **54,4%** das checagens de hash atendidas localmente; `debrid.check.cached`=507/736; gate antigo `repeated/hashes` em 154/736 = 20,9%. A métrica de decisão da janela é `servedHashes/(servedHashes+hashes)` — o ratio `repeated/hashes` mede redescobrimento, não valor do cache, e infla com corrida perdida/timeout sem reuse real. Coleta diária autenticada por 7 dias antes de tocar TTL | análise, sem código; decisão de TTL pendente da janela |
| 6.4 ✅ | Decode de config (máximo 8 KB, regex + base64 + JSON) é CPU limitado; risco aceito sem rate limit enquanto não houver abuso observado. `/seal-config` já tem gate próprio | decisão teórica, sem código |
| 6.5 ✅ | Healthcheck passou a quádruplo: addon, Jackett, FlareSolverr e API admin loopback do Caddy (`:2019/config/`) | operacional |
| 6.5b ✅ | A sonda do Caddy precisa de `Origin` explícito (`http://127.0.0.1:2019`): a API admin faz origin check e o `fetch` do Node não manda o header, então ela respondia **403** e reprovava o container com os quatro processos vivos. Não apareceu na hora porque o container em pé era anterior à quarta sonda; só quebraria no rebuild seguinte | `23c64c2` |
| 6.6 ✅ | Janela do `npm run smoke` recalibrada: 5 tentativas × 1,5s davam ~12s contra um orçamento de **20s** de UM indexer BR (`JACKETT_BR_INDEXER_TIMEOUT_MS`), então cache genuinamente frio reprovava **por construção** e todo deploy novo dava vermelho falso. Agora 8 × 3,5s; medido: converge na 3ª–4ª tentativa e o smoke passa com o cache zerado |
| 6.7 | `checkJs` nos `resolvers/`: **medido, não feito.** Ligar `checkJs: true` + `resolvers/**/*.js` no include produz **354 erros**, dos quais 306 são ruído de `noImplicitAny` (TS7006/TS7031 — parâmetro de função JS sem anotação) e 21 são artefato de inferência em default `= {}` (TS2339), não defeitos. Com `noEmitOnError` isso quebra o build, então a mudança exige anotar ~306 parâmetros e é tarefa própria, não um ajuste de config. O que o experimento pagou está na 6.8 |
| 6.8 ✅ | `siteSelector` estava **exportado duas vezes** no mesmo `module.exports` de `bludv`, `comandotorrents` e `torrentdosfilmes` (achado do experimento da 6.7, TS1117). Sem efeito hoje — o segundo sobrescreve com o mesmo valor —, mas é a chave duplicada que vira bug silencioso no dia em que os dois lados divergirem |

---

## Fase 7 — Operação e produção (PLANEJADA — 2026-08-24)

**Objetivo:** 30 dias de produção estável. A Fase 6 fechou o refactor; esta
fase **não** abre split de módulo. Código de `HEAD` na auditoria: `esm`
`4baf8e1`. Esforço: A/B = S operacional; C1 = S de código quando autorizado.
Risco: **deploy** (A1) e **dado/conta** (A2) — não prazo de busca.

**Princípio:** não abrir refactor amplo. Cada item tem trilha, aceite e o
que é proibido. `AGENTS.md` descreve só o presente; o futuro mora aqui.
Este capítulo **não autoriza** limpeza de magnets, `push`, rebuild na VPS
nem commit de `metrics_live.json`.

Ordem: trilha A → B → C. C só com A verde e medida (ou bug) da B.

```
Trilha A (produção, 0 código)
  └─→ Trilha B (medir, depois de A1)
        └─→ Trilha C (código mínimo)
              └─→ explicitamente fora
```

### Trilha A — Produção (primeiro; 0 código)

| # | Tarefa | Trilha | Esforço | Risco | Dependência | Status | Aceite |
|---|---|---|---|---|---|---|---|
| 7.1 | Qual código está no ar. O cron em `DEPLOY.md` ainda pode observar `adon-power-movie` | A1 | S | deploy | — | PLANEJADO | script/`crontab` puxa `esm`; `git log -1` na VPS = `origin/esm`. Sem isso, melhoria local não chega na TV |
| 7.2 | Saúde do debrid. “Sumiu o raio” quase nunca é bug (teto / chave) | A2 | S | dado | 7.1 ajuda o diagnóstico, não bloqueia o check | PLANEJADO | `GET /debrid-status.json` com `X-Indexer-Test-Token`; ocupação abaixo do aviso. Teto → `node dist/scripts/magnets.js` **só com autorização explícita** — este plano não autoriza |
| 7.3 | Página de configurar na internet. `Caddyfile` tem `basic_auth` comentado; `CONFIGURE_PAGE_PASSWORD` não é lido por ninguém | A3 | S | acesso | VPS com `ADDON_DOMAIN` público | PLANEJADO | na VPS, `/configure` pede senha. Em LAN pode ficar aberto |
| 7.4 | Fonte BR morta. BLUDV fora do ar (ACE / 522). Amostra local (`metrics_live.json`, **não commitado**): `bludv-cardigann` ~20s | A4 | S | prazo | mirror vivo **ou** fora da resposta | PLANEJADO | env com mirror **ou** indexer fora do caminho crítico (padrão `JACKETT_INDEX_ONLY_INDEXERS`). Sem mirror, não “consertar parser” |

### Trilha B — Medir (depois de A1)

| # | Tarefa | Trilha | Esforço | Risco | Dependência | Status | Aceite |
|---|---|---|---|---|---|---|---|
| 7.5 | Janela `davail` (continuação do 6.3). Baseline 0: 878 servidos vs 736 de rede (~54% local). Decisão: `servedHashes / (servedHashes + hashes)` — **não** `repeated/hashes` | B1 | S (coleta) | prazo se TTL errado | 7.1 (métrica da instância no ar) | PLANEJADO | 7 dias de coleta autenticada **antes** de mudar `DEBRID_AVAIL_POS_TTL` / `NEG_TTL`. Código só depois da janela |
| 7.6 | Jackett desperdiçado (`search.jackett.wastedQueries` / `wastedMs` em `src/providers/jackett.ts`) | B2 | S | prazo | 7.1 | PLANEJADO | 7 dias de série; só então cortar indexer. Sem feeling |
| 7.7 | Premiumize órfãos (`debrid.pm.status.unmatched` alto na amostra) | B3 | S | dado se reescrever `transferHash` no escuro | 7.1 | PLANEJADO | confirmar transferência sem hash casável (já em `AGENTS.md`) vs regressão. Sem evidência nova, não reescrever `transferHash` |
| 7.8 | M4 / Tier 5 forense (HMAC adulterado, config maliciosa — `TEST_INFRA.md` item 14) | B4 | M | nulo se só auditoria | M3 feito; **não** é gate de deploy | DONE (2026-08-31) | executada fora de gate, por desenho: gates verdes (`typecheck` 0, `build`, `test:complete` 90+6, `lint:lines` baseline OK), camada de segurança **209/209** (HMAC adulterado/ausente → 403, `secret-box` fail-closed, config malformada → 404, `?token=` → 401, 429), regressão **1.563/1.563**, `test:adversarial` APPROVE com mutações **10/10** (MUT-03 HMAC, MUT-07 secretBox; 20 seq + 6 par; `dist/` restaurado), stress 19+135, adversarial-m1 69/69, protector 42/42, challenger 11/11. Sem correção. Não misturar com 7.1 |

### Trilha C — Código mínimo (só com A verde e bug/medida)

| # | Tarefa | Trilha | Esforço | Risco | Dependência | Status | Aceite |
|---|---|---|---|---|---|---|---|
| 7.9 | Resíduo 2.4: orçamento cheio em `autofetch-runner.ts` escreve `[...remaining, next]` e rebaixa o melhor; `budgetBlockedUntil` já pausa | C1 | S | dado (fila) | A verde; não urgente | PLANEJADO | `[next, ...remaining]` + teste do `drainNext`. Um commit |
| 7.10 | `checkJs` nos `resolvers/` (6.7): 354 erros, 306 `noImplicitAny` | C2 | L | build (`noEmitOnError`) | — | **FORA dos 30 dias** | anotar JS é tarefa própria, não ajuste de `tsconfig` |
| 7.11 | `SearchPhase` explícito (A3). Fase já é `latest-writer` | C3 | M | passe tardio | bug concreto de corrida | **NÃO FAZER** sem bug | — |

### Explicitamente fora (não fazer nesta fase)

- Novo split de `providers/` / `format.ts` / `app.ts`.
- Caça a `any` nas APIs de debrid.
- Validar DNS no SSRF (hostname público → IP privado): custo é busca morta quando o DNS falha.
- Commitar `metrics_live.json`.
- `npm audit fix --force`.
- Devolver BLUDV / index-only ao caminho crítico sem medir latência de novo.
- Tratar este capítulo como autorização de limpeza de magnets, `push` ou rebuild na VPS.

**Validação desta edição (2026-08-24):** só `git diff --check` nos markdowns.
Não alegar suíte, smoke ou Docker. Executar a Fase 7 começa por **7.1 na VPS**.
Código (7.9) e TTL do `davail` só com medida da trilha B.

**Rollback:** reverter o commit de docs; nenhum comportamento executável muda.

---

## Fase 8 — Desentupimento da conta AllDebrid e retorno do BR dublado (EM EXECUÇÃO — 2026-08-31)

**Objetivo:** o dublado voltar à lista. Hoje ele some 100% das vezes, medido.
Esta fase **não** abre refactor e **não** mexe em busca, parser ou ranking — o
defeito não está lá. Código de `HEAD` no diagnóstico: `esm` `3d6f89d`
(produção no ar no mesmo commit). Risco dominante: **dado/conta** (a Trilha B é
destrutiva e irreversível), depois **prazo** (a Trilha A muda o que aparece na
tela já na busca seguinte).

**Progresso executado (2026-08-31):**

- **8.2 aplicado na VPS** (`DEBRID_SHOW_UNCACHED_BR=true`, stack recriada e
  saudável). Limite medido: o toggle só vale para install URL que **não**
  codifica `bu` — a página `/configure` grava `bu` sempre, então o re-save da
  URL de instalação é o passo que fecha o `brHidden` (modelo stateless
  funcionando como desenhado).
- **8.4 NO CÓDIGO** (`d7db22d`): blindagem `brOriginMark` nos caminhos de
  limpeza (`audioBucket`/`foreignVerdict`); `hasPtSigns` da busca intocado.
  Mira 347 → ~343 (4 falsos positivos saem com fixture).
- **8.15 NO CÓDIGO** (`289dbfd`): posse durável `adsub:v1` (TTL 7d, knob
  `ALLDEBRID_SUBMITTED_TTL_MS`) com regra de proveniência — etiqueta só com
  prova de criação (hash ausente do snapshot); enqueue do autofetch etiqueta
  incondicional (`proven: true`). Catraca quebrada.
- **8.14 NO CÓDIGO** (`b06d440`): marcador `adrm:v1` (TTL 3d,
  `DEBRID_REUPLOAD_BLOCK`) gravado só por deleção intencional bem-sucedida
  (`sweepUndubbed`, catálogo/painel, 8.16); T1 do dedup nunca marca (o hash
  sobrevive); bloqueia checagem e autofetch, nunca play explícito; guarda no
  atalho `DEBRID_ALIVE_AS_CACHE`; expurgo `--unblock`.
- **8.16 NO CÓDIGO** (`a264b7c`): evicção por busca, **default OFF**
  (`DEBRID_EVICT_PER_SEARCH`), só conta do operador, seleção em conjunção,
  piso/teto, fire-and-forget, in-flight por conta, `adrm` do 8.14 nos
  removidos, e **gate único de delete por conta** (serializa dropReady,
  dropUncached, sweeps, painel e evicção — B-4).
- Gates dos 4 commits: typecheck 0, build verde, 1594/1594 testes,
  `test:complete` 94+6, catraca verde, revisão independente APPROVE no 8.14
  (após corrigir o T1) e no 8.16.
- **8.17 NO CÓDIGO** (`bdf00ea`): reconcile da posse órfã + fail-safe do
  `dropDownload`. Fecha H1/H2 (abaixo). Default **ON**, teto 25/rodada,
  intervalo mínimo 5min, só conta do operador. Ver a linha 8.17 na Trilha C.
- **Painel** (`fba39e1`, `1c297ca`): `sem-debrid` do anônimo deixa de virar
  banner de problema numa instância pública segura, e conta do operador `ok`
  em `accounts` mostra online/warn em vez de "não medido". Testes de runtime
  do painel extraídos para `test/dashboard-panel-runtime.test.ts`.
- Gates conferidos de forma independente em `bdf00ea`: typecheck 0, build
  verde, **1617/1617**, `test:complete` **97+6**, catraca baseline OK.

**H1/H2 — o vazamento que sobrou depois do 8.15** (medido: resíduo +25 após uma
rodada de buscas). Dois buracos distintos, ambos no `alldebrid-check.ts`:

- **H1 — supressão silenciosa.** O `dropReady` não apagava quando o snapshot
  `knownBefore` estava em refresh ou era a primeira checagem do processo. Isso
  é falta de **autoridade**, não decisão de proteger — mas o código somava os
  dois casos e ninguém voltava para buscar o hash depois. Agora a supressão por
  falta de autoridade conta `debrid.drop.suppressedReady` à parte.
- **H2 — eco perdido nunca retomado.** Hash etiquetado como nosso que a limpeza
  não conseguiu remover (lote que estourou o prazo, delete recusado com 503,
  hash omitido no eco do upload) ficava pronto na conta **para sempre**: não
  está morto (escapa do `sweepDead`) nem provado estrangeiro (escapa do
  `sweepUndubbed`). É o alvo exclusivo do reconcile.

Achado colateral, e o mais grave dos três: o **`dropDownload` nunca teve o
fail-safe do `dropReady`**. Ele apagava por `!skipCleanup` apenas, sem consultar
o snapshot — magnet que o **usuário** pôs para baixar era removido pela nossa
checagem de cache. Não é ocupação, é dano ao acervo, e estava no código desde
antes desta fase.

**Teste ao vivo em Docker (2026-08-31, `bdf00ea`)** — duas rodadas na conta
real, faseadas:

- *Rodada 1, reconcile OFF.* Busca fria `tt1119646` em 5,27s, recache 3ms; 10
  streams, todos tocáveis, 9 ⚡, 4 BR (2 DUAL, 1 DUB, 1 dublado PT). Checagem de
  25 hashes, 21 em cache, **21 removidos** (18 prontos + 3 downloads). Resíduo
  da busca: **+4**, contra os +23 medidos em produção. Boot mostrou `838
  preexistente(s) […] (23 subido(s) pelo addon)` — o `adsub` do 8.15 provado ao
  vivo **através de um recreate de container**, que é exatamente onde a catraca
  agia.
- *Rodada 2, reconcile ON com teto 3.* `reconcile: 3/3 magnet(s) com posse
  remanescente removido(s) (3 marcado(s) "não re-subir") (3 posse(s)
  purgada(s))`. Diff completo da conta (853 hashes antes × 855 depois)
  confirma **exatamente 3** removidos: dois `The Hangover` em inglês com upload
  às 18:51 — *o resíduo da rodada 1* — e um `BIG_BUCK_BUNNY.iso` órfão bem mais
  antigo. **Nenhum** com marca BR, nome em português ou origem de site BR; os
  838 preexistentes intocados. `cache.db`: `adrm=3` (um por removido, bate com
  `removedIds`), `adsub=55`. Sem regressão de latência — o reconcile roda
  depois da resposta.
- **Sem cobertura ao vivo:** `debrid.drop.suppressedReady` ficou **0** nas duas
  rodadas (inventário quente as duas vezes). O guard de H1 tem teste unitário,
  mas só apareceria numa busca disparada nos primeiros segundos após o boot.
- **Docker local validado ao vivo** (2026-08-31): rebuild verde, container
  healthy (addon + Jackett + FlareSolverr + Caddy, zero restart/OOM). Busca
  `Se Beber, Não Case` (`tt1119646`) fria em 5,18s: 8 streams tocáveis,
  6 ⚡ e 2 BR; recache em 33ms: `max-age=900`, 9 streams, 6 ⚡ e 3 BR
  (Kickass, Comando, BluDV). A checagem enviou 28 hashes, removeu 22 sem falha
  e persistiu 26 `adsub`; após restart, 4 resíduos ainda na conta continuaram
  reconhecidos como uploads do addon. Hash sintético `adrm` ficou fora do
  upload (`complete=true`, `cached=0`) e foi liberado ao final. Probe real:
  resolver Nerdfilmes 5 resultados/3,52s; Jackett/Cardigann 2 resultados com
  magnet/3,00s. O 8.16 permaneceu OFF e não apagou nada.
- **Ainda sem push/deploy — agora são SETE commits:** só 8.2 está na VPS.
  8.4/8.15/8.14/8.16/8.17 (`d7db22d`, `289dbfd`, `b06d440`, `a264b7c`,
  `bdf00ea`) e os dois do painel (`fba39e1`, `1c297ca`) foram validados no
  Docker local; produção continua em `3d6f89d` até autorização de push/deploy.
  A fila cresceu, e com ela o tamanho do salto — o `adsub` do 8.15 nunca rodou
  em produção, e é nele que o 8.17 confia para autorizar deleção.
- **Pendências da fase:** 8.5 (Trilha B destrutiva — exige ok por rodada),
  8.6/8.3 (só depois de folga medida), re-save da URL de install (8.2), a
  decisão de ligar o knob do 8.16 na VPS depois de 48h de observação, e a
  primeira subida do 8.17 (ver a nota de sequência na linha dele).

**Princípio:** nenhuma decisão de ocupação sem o teto real medido, e nenhum
`--apply` sem a blindagem BR no lugar. O checklist do 7.2 (Fase 7, ainda
PLANEJADA como trilha) foi aplicado aqui como diagnóstico e respondeu
"ocupação no limite, teto/chave ok" — o palpite era que o problema seria teto
ou chave; a medição mostrou que é **gate nosso + relógio que nunca dispara**.
Esta fase substitui aquele palpite pelos números abaixo.

> Referências de linha no texto abaixo (ex.: `catalog-env.ts:224`,
> `alldebrid-check.ts:89`) estão pinadas no diagnóstico `3d6f89d` — os
> símbolos (`includeKnown`, `scheduleDrop`, `sweepUndubbed`) é que valem depois
> dos commits desta fase. B-1/B-2/B-3/B-4 e T1 são os achados da revisão
> adversarial independente de 2026-08-31 sobre esta fase (B-1 = re-etiqueta de
> acervo pela posse persistida; B-2 = evicção alcançando conta de usuário;
> B-3 = condenação por título vs prova de arquivo; B-4 = rajada de deletes
> concorrentes; T1 = dedup de mesmo hash).

### Diagnóstico (medido em produção, 2026-08-31)

Cadeia causal completa, cada elo com a sua evidência:

| # | Elo | Evidência |
|---|---|---|
| 1 | A descoberta funciona | `[search] varredura pt-BR: 84 resultado(s)` para "Se Beber, Não Case!" |
| 2 | 100% do BR é ocultado | `search.first.brFound=10`, `search.first.brHidden=10` |
| 3 | Quem oculta | `DEBRID_CACHED_ONLY=true` + `DEBRID_SHOW_UNCACHED_BR` ausente (default `false`, `src/config/debrid.ts:35`); log `(0 em cache)` em **toda** busca — nunca um BR cacheado |
| 4 | O Chupim, que consertaria o elo 3, está parado | `autofetch.account-gated=22`; `[autofetch] AllDebrid com conta cheia — nenhum download enfileirado` |
| 5 | Por que está parado | `autoFetchPauseAt` default **800** (`src/config/debrid.ts:210`) contra **904** magnets na conta. É limiar NOSSO, não da AllDebrid — `src/debrid/account-status.ts:13` já dizia "ajuste se a sua conta aguentar mais" |
| 6 | A varredura que liberaria espaço nunca roda | `src/addon.ts:43`: 1º disparo em `interval/2` = **3h** após o boot, via `setTimeout` em memória. Deploys de 30/08: 15:19, 16:21, 17:40, 19:33, 22:11 — intervalos de 1h02, 1h19, 1h53 e 2h38. **Nenhum alcançou 3h.** Cada deploy recria o container e zera o timer |
| 7 | E se rodasse, não resolveria | `sweepUndubbed` exclui `preexistentes` (trava `knownBefore` em `alldebrid-cleanup.ts`): dos 904, ~870 são preexistentes e **imunes por desenho**. A varredura só alcança o que o próprio addon subiu |
| 8 | **A catraca do `preexistente`** (achado de 2026-08-31; a hipótese anterior, "`uploadDate` não mede idade", foi **refutada** pelo operador: a conta foi zerada, as datas são reais) | A conta saiu de ~0 para **904 em 8 dias** (2026-08-24 a 08-31; 423 só em 08-30) **sem o autofetch participar** — ele está gateado desde cedo. Causa: `submitted` é `Map` em MEMÓRIA (`alldebrid-inventory.ts:37`) e some no restart; o snapshot seguinte lê `/magnet/status` e classifica **tudo que estiver na conta** como acervo do usuário (`knownBefore`), imune ao `sweepUndubbed`. Como o container reinicia a cada deploy (5× em 08-30), **o addon lava a própria sujeira como acervo do usuário a cada deploy**. Já conhecido para o painel, que ganhou o escape `includeKnown` (`catalog-env.ts:224`); a varredura automática continua presa |

**CUSTO POR BUSCA (medido 2026-08-31, painel da AllDebrid + API):** uma única
busca de "Se Beber, Não Case" deixou **23 magnets** na conta — todos com
`Completed on` de 30/08 entre 22:03 e 23:07, a janela de teste. Destes, **1**
é dublado (e do *Parte 3*, não do filme aberto). Painel: `890 Ready + 8 in
progress + 30 failed = 928` — `failed` e `in progress` **também ocupam slot**,
logo restam ~**72 vagas**, não 96. A 23 slots por busca, o teto de 1000 é
atingido em **~3 buscas**. A vazão é a checagem de cache (que na AllDebrid é
upload), **não** o autofetch — ele está gateado. Consequência para o plano: a
Trilha B (estoque) compra dias; só o 8.15 (catraca) e o 8.14 (anti-reentrada)
mudam o regime.

**Composição da conta** (`clean-undubbed.js`, modo leitura, sem `--apply`):

```
904 magnet(s), 10.1 TB — teto AllDebrid 1000 (90%)
  38   171.8 GB  dublado PT (mantido sempre)
 278     2.7 TB  dual/multi sem PT (ambíguo, mantido por padrão)
  37   405.8 GB  sem marca, sinal de PT (mantido por padrão)
 347     4.4 TB  SEM áudio PT (mira da limpeza)
Mira: 347 -> conta cairia para ~557 (56% do teto)
```

> Trecho do relatório: os quatro baldes exibidos somam 700; os 204 restantes
> ficaram em saídas residuais do script (sem balde exibido acima).

**Falsos positivos já identificados na mira** — varredura própria sobre os 904
com o classificador do addon achou **4 releases brasileiros condenados** por não
terem a palavra "dublado" no título:

```
X-Men - O Filme 1080p - The Pirate Filmes
Troia - The Pirate Filmes
Zumbilândia (2009) Bluray 1080p Filmes M.H.G
zumbilandia (www.thepiratefilmes.com)
```

Todos de site BR, título em português. É exatamente a cicatriz registrada em
`alldebrid-cleanup.ts:150` ("foi assim que a conta chegou a 812 magnets" /
"falso positivo aqui destrói acervo que custou horas de download").

**Conflito de teto a resolver antes de tudo:** o operador informou que a conta
aguenta ~2000 magnets; o script reporta teto **1000**, número que vem da
mensagem de erro real da AllDebrid citada em `scripts/magnets.ts:6`
(`"Magnets limit reached (1000 accross all tabs)"`). Com 904 no ar, a diferença
entre 1000 e 2000 decide se existem 96 ou 1096 vagas. **Subir o gate sem fechar
isso troca "sem dublado" por "sem debrid nenhum"**: a checagem de cache da
AllDebrid é um upload, e conta no teto derruba o ⚡ de TODOS os streams.

### Trilha A — Parar o sangramento (reversível; nada é apagado)

| # | Tarefa | Trilha | Esforço | Risco | Dependência | Status | Aceite |
|---|---|---|---|---|---|---|---|
| 8.1 | **Teto real da conta — RESOLVIDO (2026-08-31).** É **1000 magnets**. Confirmado por fonte EXTERNA e independente: o erro `MAGNET_TOO_MANY` da AllDebrid devolve `"Magnets limit reached (1000 accross all tabs)"` (mesmo typo em "accross" da resposta real), reportado no cliente `rdt-client` (issue 421), sem relação com este projeto. O "2000" informado é `limitedHostersQuotas.dailyuploads` do `/user` — quota de **hoster**, não slot de magnet. O `/user` **não expõe** o teto de magnets, e o 1000 dos nossos scripts (`clean-undubbed.ts:126`/`:147`, `magnets.ts:94`) é hardcoded — correto por acaso, mas era circular como evidência. Há também relato de teto de **30 simultâneos em download** (bate com a nota de `account-status.ts`); irrelevante aqui (`In progress` = 8) | A1 | S | dado | — | **DONE (2026-08-31)** | ocupação real **928/1000** (890 ready + 8 in progress + 30 failed — `failed` e `in progress` ocupam slot): restam **72 vagas**. A 23 slots/busca, ~3 buscas até o teto. Libera 8.3 e, com o 8.4 no ar, destrava 8.5→8.6 |
| 8.2 | Visibilidade imediata do BR: `DEBRID_SHOW_UNCACHED_BR=true` no `.env` da VPS. Os BR ocultados voltam como P2P puro, sem depender de cache nem de ocupação de conta | A2 | S | prazo | nenhuma (não toca ocupação) | **DONE na VPS (2026-08-31)** — falta re-save da URL de install | `search.first.brHidden` cai a 0 na busca seguinte e o dublado aparece na lista. Reversível numa linha. **Não substitui a Trilha C** — trata sintoma. **Limite medido:** a página grava `bu` sempre na URL; installs antigas com `bu=0` continuam ocultando até o usuário regenerar o link |
| 8.3 | Alinhar `accountWarnTotal` (hoje 800) ao teto de 8.1; senão o aviso vira ruído permanente e deixa de significar alguma coisa | A3 | S | nulo | 8.1 | PLANEJADO | o log de aviso volta a ser exceção, não linha de toda rodada |

### Trilha B — Desentupir (DESTRUTIVA; autorização explícita por rodada)

> Esta trilha apaga conteúdo de uma conta real. **Nada aqui é autorizado por
> este documento.** Cada `--apply` exige "ok" do operador na hora, para aquela
> rodada, com a mira revisada. O que sai não volta.

| # | Tarefa | Trilha | Esforço | Risco | Dependência | Status | Aceite |
|---|---|---|---|---|---|---|---|
| 8.4 | **Blindagem BR antes de qualquer `--apply`** (pré-requisito absoluto). Origem de site BR no nome (`thepiratefilmes`, `filmes`, `comando`, `bludv`, `lapumia`, `torrentdosfilmes`) ou título em português **nunca** condena, mesmo sem a marca "dublado". Regra do operador: *se tem nome BR, só pode ser BR* — e como a regra serve para **não apagar**, errar protegendo é o lado certo do erro | B1 | S | dado, se pulada | — | **DONE (`d7db22d`)** | os 4 falsos positivos conhecidos saem da mira (347 -> ~343), com os 4 nomes reais como fixture de teste. **Sem isto, 8.5 não roda** |
| 8.5 | Limpeza faseada, nunca de uma vez: `--limit 50` na 1ª rodada, conferir a conta, só então ampliar. Os mais antigos primeiro (o script já ordena) | B2 | M | dado | 8.1, 8.4 | PLANEJADO | a ocupação cai; **nenhum** item dos baldes `dublado PT`, `sinal de PT` ou `dual` some; a diferença de contagem bate exatamente com o `--limit` pedido |
| 8.6 | Só então reavaliar `autoFetchPauseAt`, com folga mínima de 200 slots até o teto de 8.1 | B3 | S | prazo | 8.5 | PLANEJADO | `autofetch.account-gated` para de crescer e `autofetch.enqueued` volta a subir. Ajuste ao vivo pela aba `[Chupim / Autofetch]`, sem deploy nem restart |

### Trilha C — Corrigir os mecanismos (código; é aqui que fica consertado)

| # | Tarefa | Trilha | Esforço | Risco | Dependência | Status | Aceite |
|---|---|---|---|---|---|---|---|
| 8.7 | **Relógio persistente da varredura.** Trocar o `setTimeout`/`setInterval` em memória (`src/addon.ts:42-48`) por marca de "última execução" no `cache.db`, que sobrevive ao rebuild. Deploy frequente deixa de matar a rotina por inanição | C1 | S | dado (varre mais cedo) | — | PLANEJADO | com deploys a cada 1h, a varredura roda dentro da janela configurada. Teste que simula reinício antes do intervalo e prova que a rodada acontece |
| 8.8 | **Instrumentar a varredura.** Hoje é silenciosa quando não roda — o "nunca disparou" só apareceu por arqueologia de log. Contadores `debrid.sweep.undubbed.{run,skipped,swept}` com o motivo do skip | C2 | S | nulo | — | PLANEJADO | `/metrics.json` mostra a última execução e o motivo da última pulada, sem precisar de `docker logs` |
| 8.9 | **Gate degradar em vez de desistir.** Conta cheia hoje para o Chupim inteiro; havendo BR dublado na fila e não-dublado antigo ocupando espaço, a troca vale. Liberar espaço sob demanda, ou ao menos manter o pool `br` enfileirando | C3 | M | dado (apaga sob pressão) | 8.7 e 8.8 no ar e medidos | PLANEJADO | com a conta no limiar, o pool `br` ainda enfileira e `any`/`seeds` seguem barrados. **Não** fazer antes de 8.7/8.8 — sem medição é palpite |
| 8.10 | `sweepUndubbed` alcançar preexistentes **sob trava explícita** (opt-in, default desligado). Hoje `knownBefore` os torna imortais: certo como padrão, errado quando 96% da conta é preexistente | C4 | M | **alto** (dado) | 8.4 no ar; 8.5 executada com sucesso ao menos uma vez | PLANEJADO | knob próprio, default `false`, com a blindagem de 8.4 obrigatória no caminho. Havendo dúvida, **não fazer**: o operador limpa à mão com o script |
| 8.15 | **Quebrar a catraca do `preexistente`** (raiz da vazão). Persistir `submitted` no `cache.db` para que o que o addon subiu continue sendo dele após o restart, em vez de virar "acervo do usuário" no snapshot seguinte. Sem isto, qualquer limpeza é esteira: 5 deploys/dia relançam a catraca | C5 | M | médio (a varredura passa a alcançar de verdade) | — | **DONE NO CÓDIGO (`289dbfd`)** — ainda sem deploy | `adsub:v1`, TTL 7d, prova de criação; teste de restart/B-1. Docker local: 26 registros persistidos; após restart, 4 resíduos ainda na conta continuaram fora de `knownBefore` |
| 8.16 | **Evicção por busca** (ideia do operador: "cada busca temos que deletar os gringos mais velhos"). Terceiro `scheduleDrop` em `alldebrid-check.ts:89`, irmão de `dropReady`/`dropUncached`: a busca que deposita ~23 magnets remove ~23 dos mais antigos provadamente estrangeiros. Torna a ocupação **estacionária em vez de monotônica** e dispensa o relógio (8.7) para este fim — o gatilho é o próprio tráfego. **Desenho completo na seção abaixo** | C6 | M | médio (destrutivo no caminho quente; mitigado por ser em fundo) | **8.15 obrigatório antes** — com a catraca de pé não alcança 96% da conta | **DONE NO CÓDIGO (`a264b7c`), DEFAULT OFF; aguardando deploy + decisão de ativar** | mecânica coberta por 11 testes + gate global de delete B-4; aceite de ocupação/p50/zero BR exige 48h em produção com knob ligado deliberadamente |
| 8.17 | **Reconcile da posse órfã + fail-safe do `dropDownload`** (H1/H2, medidos como resíduo +25 após uma rodada de buscas). Três peças: (a) varredura em fundo do que é NOSSO por `adsub`, está pronto, não é preexistente e passa no anti-re-add (`uploadDate` posterior à etiqueta NUNCA sai; sem data também não) — é o único mecanismo que alcança o eco perdido; (b) `dropDownload` adota o fail-safe do `dropReady`, fechando o apagamento de magnet que o **usuário** pôs para baixar; (c) métrica `debrid.drop.suppressedReady` separando supressão por falta de autoridade de decisão de proteger | C7 | M | médio (destrutivo, mas só sobre posse provada) | **8.15 obrigatório** — a etiqueta `adsub` é a autorização de deleção | **DONE NO CÓDIGO (`bdf00ea`), DEFAULT OFF; ativação explícita** | 1617/1617, revisão independente APPROVE (O2 corrigido). Docker local: 3/3 removidos no teto, todos sem sinal BR, dois deles o resíduo comprovado da busca anterior; `adrm=3` bate com `removedIds`; 838 preexistentes intocados. Deixar o `adsub` rodar um ciclo, conferir o `/metrics.json` e só então ligar explicitamente torna o deploy reversível |

### Trilha D — Política (decisão de produto; depois dos números)

| # | Tarefa | Trilha | Esforço | Risco | Dependência | Status | Aceite |
|---|---|---|---|---|---|---|---|
| 8.11 | Orçamento de ocupação: teto alvo, quanto do acervo é intocável, quanto fica para o giro do Chupim | D1 | S | nulo (doc) | 8.1, 8.5 | PLANEJADO | números escritos aqui, com o comando que os reproduz ao lado |
| 8.12 | **Auditoria de áudio por ARQUIVO** para o balde ambíguo (278 `dual/multi`, 2,7 TB). É a saída que o próprio código aponta: "o catálogo resolve com auditoria dos ARQUIVOS, não com palpite de título" | D2 | L | nulo, se só leitura | 8.11 | PLANEJADO | amostra auditada pela faixa de áudio real; só então decidir se `dual` vira mira. **Nunca** condenar `dual` por título |
| 8.13 | **Positivo longo para o acervo BR protegido** (ideia do operador: "memorizar os magnets como positivo sempre"). Como regra geral **é a alternativa já rejeitada** em `AGENTS.md:423` — a AllDebrid recicla inativo em ~3 dias e um `1` velho mentiria para sempre, gerando ⚡ que não toca. A variante defensável é restrita ao pool `adprot` (BR retido, que o addon mantém vivo de propósito): ali o argumento do reciclo não vale igual | D3 | M | **alto** (confiança no ⚡) | 8.12; medição de falha de play | PLANEJADO | taxa de play que falha após ⚡ medida ANTES e DEPOIS; se subir, reverter. Escopo máximo: hashes com `adprot` ativo. **Nunca** global — ⚡ que mente é pior que ⚡ ausente |
| 8.14 | **Anti-reenchimento: marcador durável do que a limpeza apagou** (ideia do operador). Hoje `sweepUndubbed` deleta e **não registra nada** (`alldebrid-cleanup.ts:214`), e a memória de cache dura **900s** (`availPosTtl`, `config/debrid.ts:79`). Resultado: 15 min depois da limpeza, a busca seguinte re-sobe o mesmo gringo para checar cache e a conta reenche com o que acabou de sair — a limpeza vira esteira eterna. Gravar por hash um marcador **"apagado de propósito, não re-subir"**, NÃO um `davail=1` eterno: o marcador não toca o ⚡ (logo não mente quando a AllDebrid reciclar) e ainda cobre o gringo que nunca esteve cacheado | D4 | M | baixo | 8.4 no ar; 8.5 para medir efeito real | **DONE NO CÓDIGO (`b06d440`)** — ainda sem deploy/8.5 | `adrm:v1`, TTL 3d, blindagem BR, `--unblock`, guarda alive-as-cache; Docker local com hash sintético provou bloqueio (`complete=true`, `cached=0`) e expurgo. Efeito de ocupação depende da primeira limpeza autorizada |

### Atalho já existente (usar antes de escrever código)

A limpeza pelo painel tem o escape `includeKnown` (`catalog-env.ts:224`), criado justamente porque o `knownBefore` anulava a limpeza no processo recém-subido. Ou seja: **para a rodada manual de 8.5 a ferramenta já existe** — 8.10 deixa de ser "escrever a limpeza de preexistentes" e passa a ser "decidir se a varredura AUTOMÁTICA ganha o mesmo escape". Fazer 8.15 primeiro pode tornar 8.10 desnecessário: com `submitted` persistido, o lixo do addon deixa de ser classificado como acervo e a varredura normal já o alcança.

### 8.16 — Evicção por busca: cada busca paga a própria conta (DESENHO)

**Ideia do operador (2026-08-31):** *"cada busca temos que deletar os gringos
mais velhos"*. É a melhor resposta ao problema desta fase, e **substitui** a
varredura periódica como mecanismo principal — 8.7 (relógio persistente) deixa
de ser necessário para este fim, porque **não há relógio**: o gatilho é o
próprio tráfego que causa o entupimento.

**Por que é superior à varredura de 6h:**

| | varredura periódica (hoje) | evicção por busca (8.16) |
|---|---|---|
| gatilho | timer de 6h em memória | a busca que acabou de encher |
| sobrevive a deploy | não (elo 6 do diagnóstico) | sim — não depende de uptime |
| acompanha a vazão | não (fixa) | sim — auto-balanceada |
| quando a conta está parada | roda à toa | não roda (nada entrou) |

Uma busca deposita ~23 magnets; se ela também remover ~23 dos mais antigos, a
ocupação vira **estacionária em vez de monotônica**. É o único item do plano que
ataca o regime, não o estoque.

**Onde:** `scheduleDrop` em `src/debrid/alldebrid-check.ts:89`, que já é
fire-and-forget (`"Sem travar a busca: limpeza é efeito colateral, não
resposta"`) e já lê o resultado de `dropMagnets`. Um terceiro `scheduleDrop`,
irmão de `dropReady`/`dropUncached`.

**Regras de seleção (todas obrigatórias, conjunção):**

1. `foreignVerdict(...) === 'condena'` — estrangeiro **provado**, nunca
   "ausência de marca PT" (trava dura 2).
2. Blindagem BR do 8.4 aplicada antes de tudo (trava dura 3).
3. Nunca `held` nem `adprot` (acervo BR retido).
4. Nunca estado ativo (`ACTIVE_STATES`) — download em curso não é lixo.
5. Ordem: **mais antigo primeiro** (`uploadDate` crescente).
6. Nunca o que esta própria busca acabou de subir.

**Orçamento (a parte que evita o desastre):**

- **Teto por busca:** `HARVEST_EVICT_MAX_PER_SEARCH`, default **conservador**
  (sugestão: 25, na ordem do que uma busca deposita). Nunca ilimitado.
- **Piso de ocupação:** só evicta acima de `HARVEST_EVICT_FLOOR` (sugestão:
  600). Conta folgada **não** apaga nada — sem isso, o addon corroeria o acervo
  em uso normal.
- **Alvo, não corte:** evictar aproximadamente o que a busca depositou, não
  "tudo que se qualifica".

**Dependência crítica:** enquanto a catraca do `preexistente` (elo 8) estiver de
pé, esta evicção **não alcança 96% da conta** — `knownBefore` protege tudo.
Logo **8.15 vem antes**, ou o 8.16 nasce inócuo. Os dois juntos são o conserto:
8.15 devolve ao addon a posse do próprio lixo, 8.16 faz o lixo sair no ritmo em
que entra, e 8.14 impede que volte.

**Risco e a lição que ele reabre:** é limpeza destrutiva disparada pelo caminho
quente. A Fase 1 já registrou o caso "corrigir um risco de DADO criou um risco
de PRAZO" (item 1.6, em *Riscos do próprio plano*), quando uma chamada de rede
entrou na reserva do debrid. Aqui a mitigação é a mesma lição aplicada: **fora
da resposta, em fundo, sem `await` no caminho do stream**, exatamente como o
`scheduleDrop` já faz. Se qualquer variante exigir esperar o resultado antes de
responder, **está errada**.

**Aceite:**

- ocupação **estacionária** por 48h de uso real (não monotônica): série de
  `debrid.account.total` sem tendência de alta;
- `debrid.evicted.perSearch` contando, e **zero** remoção de item dos baldes
  `dublado PT`, `sinal de PT` ou `dual`;
- p50 da busca **inalterado** (a evicção não pode aparecer no prazo);
- com a conta abaixo do piso, o contador fica em zero.

**Rollback:** knob próprio com default desligado até o aceite; desligar é uma
linha.

### Travas duras (não podem regredir em nenhum item)

1. **Balde `dublado PT` nunca entra em mira** — nenhuma rodada, nenhuma flag.
2. **Ausência da marca "dublado" não é condenação** — foi o que causou o
   incidente das 812.
3. **Origem BR no nome protege**, mesmo sem marca de áudio (8.4).
4. **`--apply` só com autorização da rodada**, e sempre com `--limit`.
5. **Nenhuma mudança de ocupação antes de 8.1** (teto real medido).
6. Ambíguo (`dual`, `unknown`) **fica**, até a auditoria de arquivo (8.12).

### Explicitamente fora (não fazer nesta fase)

- Mexer em busca, parser, ranking ou cotas: o diagnóstico isenta os três.
- `DEBRID_CACHED_ONLY=false` global — desliga o ⚡ como política e troca um
  problema por outro; o 8.2 resolve o BR sem esse custo.
- Subir `autoFetchPauseAt` antes de 8.1 e 8.5.
- `--apply` sem `--limit`, ou sobre os 347 de uma vez.
- Novo documento de plano: esta fase mora aqui, junto da Fase 7.
- Tratar este capítulo como autorização de limpeza — ele **descreve** a limpeza
  e a **condiciona**; não a autoriza.

**Ordem executada/revista em 2026-08-31:**

1. `8.2` — **aplicado na VPS**; falta re-save da URL com `bu=1` para installs
   que gravaram o default antigo.
2. `8.4` — **feito primeiro no código (`d7db22d`)**: proteger antes de
   destravar. A ordem original punha 8.15 antes; revisão adversarial mostrou
   que isso ampliaria o alcance da varredura enquanto os 4 BR falsos positivos
   ainda estavam na mira.
3. `8.15` — **feito (`289dbfd`)**: quebra a catraca com proveniência B-1.
4. `8.14` — **feito (`b06d440`)**: marcador anti-reentrada pronto antes do
   evictor; revisão corrigiu T1 do dedup (o mesmo hash sobrevive, então não
   pode receber bloqueio).
5. `8.16` — **feito (`a264b7c`), default OFF**: torna a ocupação estacionária
   quando ligado; `8.7`/`8.8` viram opcionais para este fim (8.8 continua útil
   como observabilidade). Gate B-4 serializa todos os deletes por conta.
6. **Próximo:** push/deploy dos commits 2–5, ainda não autorizado; depois
   decidir deliberadamente quando ligar o 8.16 e observar 48h.
7. `8.5` — limpeza de estoque com `includeKnown`, **somente com autorização
   explícita por rodada**. Os mecanismos agora fazem a limpeza durar; nenhuma
   rodada foi executada nesta sessão.
8. `8.6`/`8.3` só depois de folga real; `8.9`/`8.10` com métrica na mão; por
   fim `8.11`/`8.12`/`8.13`.

> **Inversão registrada:** a primeira leitura desta fase pôs `8.7` (relógio
> persistente) como "o conserto real e barato". O 8.16 o superou: não adianta
> consertar o relógio de uma varredura que roda a cada 6h quando a vazão é de
> ~23 magnets por busca. Consertar o gatilho errado teria custado um commit e
> deixado o regime intacto.

**Rollback:** 8.2 é uma linha do `.env` (reversível na hora). No código,
`git revert` individual de `d7db22d` (8.4), `289dbfd` (8.15) ou `b06d440`
(8.14); o 8.14 ainda tem escape em runtime (`DEBRID_REUPLOAD_BLOCK=false`,
TTL 0) e expurgo por hash (`--unblock`); o 8.16 é revert de `a264b7c` ou só
`DEBRID_EVICT_PER_SEARCH=false` (default OFF). **A Trilha B não tem rollback**
— é exatamente a razão de 8.4 vir antes de 8.5.

---

## Grafo de dependências

```
Fase 0 (docs)      ✅ (0.6 README: nada a fazer — envs no .env.example)
Fase 1 (B1,B2)     ✅ + 1.6/1.7 (refresh em fundo, achado da revisão)
Fase 2 (S*,B3,B4)  ✅ — resíduo menor no 2.4 (rotação + backoff; 7.9)
Fase 3 (T1–T7)     ✅ — GATE da fase 5 satisfeito
Fase 4             ✅ 4.1–4.3
   │
   └─→ Fase 5 (refactors) ─→ Fase 6 (6.1–6.8; 6.3 janela; 6.7 medido)
                                └─→ Fase 7 (operação) PLANEJADA
                                      └─→ Fase 8 EM EXECUÇÃO (derivada do
                                          diagnóstico do 7.2 aplicado)
                                          8.2 na VPS; 8.4/8.15/8.14/8.16
                                          em commits locais validados, sem push
```

- 5.1–5.7 são sequenciais entre si (mesmos arquivos), mas 5.2, 5.4 e 5.5 são
  independentes das demais e podem intercalar.
- Fase 3.7 (harness seguro) é pré-requisito de TODA a fase 5 — **atendido**.

**Decisão sobre a fase 5 (histórico).** Uma revisão anterior recomendava
adiar 5.1/5.3 até um bug concreto ficar caro por causa do tamanho do
arquivo, e fazer só 5.6/5.2 no lugar — risco real do sistema é corrida de
latest-writer e orçamento de tempo, exatamente o que um split de módulo
quebra com mais facilidade, e harness que não pega um bug hoje não pega o
que o refactor introduzir. **Decisão explícita, 2026-08-23: fazer 5.1 e 5.3
mesmo assim**, contra essa recomendação — as duas saíram completas (ver
acima) com o gate cheio (typecheck, build, suíte, `test:complete`, os 5
harnesses adversariais) rodando verde antes de cada commit, e nenhum deles
quebrou. `providers/index.ts` (2.220 linhas) e `utils/format.ts` (2.307
linhas), os dois maiores arquivos do repo, não existem mais como monólito.
5.6 e 5.7 foram concluídas depois, em 2026-08-24.

## Validação global (por fase)

```
npm run typecheck      # portão: ZERO
npm run build          # dist/ atual (test roda dist)
npm test               # 1.193 testes hoje, zero falha
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
| **Materializado:** corrigir um risco de DADO criou um risco de PRAZO (1.6) | O primeiro conserto do B1 pôs uma chamada de rede sem relação com a resposta dentro da reserva do debrid. Lição para o resto do plano: quando o fail-safe já fecha na ausência de informação, buscar essa informação de forma síncrona no caminho da resposta é custo puro — pague em fundo. Ao mexer no invariante 1 ou na limpeza, **meça tempo no teste**, não só comportamento |
| 2.5 (budget restante) encurta demais a coleta em metadados lentos | piso 500ms + teste 4.1; se o parcial piorar, revisar o 4.3 (devolver parcial imediato) |
| 5.x refactor introduz corrida latest-writer/passe tardio | extração um commit por vez + harnesses como prova; `SearchPhase` explícito exatamente para isso |
| 5.4 unificar resolvers quebra failover de domínio | um resolver por vez; `test:nerdfilmes` + fixtures reais por site |
| Commits empilhados confundirem rollback | um commit por tarefa coesa; mensagem referencia o ID (ex.: `fix: B1 snapshot preexistente expira (PLANO_MELHORIAS 1.1)`) |
| **Materializado:** subfase declarada concluída sem métrica que sustente a conclusão (5.4 e 5.7) | As duas foram marcadas ✅ com critério descritivo — "o núcleo existe", "os tipos foram criados" — e as duas estavam incompletas: 5.4 deixou três funções ainda duplicadas nos profiles, 5.7 declarou <150 quando o contador real dava 156. Lição: **toda subfase fecha com um número reproduzível no próprio plano** (linhas duplicadas, `any` da AST, ocorrências de `process.env`), com o comando ao lado. Métrica também pode mentir: a contagem por nome de função repetido inflava o resíduo de 5.4 (adaptador de 3 linhas conta igual a laço de 46), e o glob `src/**/*.ts` do contador de 5.7 varria 66 dos 72 arquivos — **valide o instrumento antes de declarar a meta batida** |
| **Materializado:** healthcheck novo passou despercebido porque o container em pé era antigo (6.5b) | A quarta sonda respondia 403 e só quebraria no rebuild seguinte. Lição: mudança em `HEALTHCHECK`/`Dockerfile` exige `docker compose up -d --build` **e** verificar o `Health.Log` do container recriado — mais um caso negativo (derrubar a dependência e ver o check reprovar), senão um check que passa por acidente parece correto |
