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

**O que continua aberto:** fase 0 (parcialmente — ver abaixo) e fase 6. A fase
4 foi concluída em 2026-08-24; a fase 5 foi concluída: 5.1 e 5.3 em 2026-08-23; 5.2, 5.4 e 5.5 em
2026-08-24; 5.6 e 5.7 em 2026-08-24 (meta por código explícito hoje em 149,
sem converter payloads externos cegamente). A alegação anterior de 147 não é
uma métrica válida e foi substituída pelo contador de AST em §5.7.

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
passaram a conter apenas parsers, regras e caches **específicos do site** —
por desenho, não como duplicação a migrar; cada um carrega o que o núcleo
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
- **Transporte e protetores**: `transport.js` (cadeia HTTP idêntica de BluDV
  e ComandoTorrents: `followProtectedUrl`, saltos/protetor de link,
  `assertAllowedUrl`), `nested-url.js` (desempacotamento da URL envelope do
  Cardigann em `/resolve`), `torznab.js` (capacidades/`capsXml` dos feeds
  com formato idêntico) e `protector.js` (allowlist de host).

As quatro extrações desta conclusão rodaram o gate completo da fase 5 e
preservaram os exports dos shims; parser por site continua nos profiles,
que é exatamente onde a regra específica deve morar.

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
`node -e "const ts=require('typescript'),fs=require('fs'),cp=require('child_process');let n=0;for(const f of cp.execFileSync('git',['ls-files','src/**/*.ts'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean)){const s=ts.createSourceFile(f,fs.readFileSync(f,'utf8'),ts.ScriptTarget.Latest,true);const w=x=>{if(x.kind===ts.SyntaxKind.AnyKeyword)n++;ts.forEachChild(x,w)};w(s)};console.log(n)"`.
Baseline registrado em 2026-08-24: **274**; a alegação intermediária de **147**
não é comparável por misturar linhas e texto. Medição atual da AST: **149**
(<150), sem converter payloads externos cegamente em `unknown`.

**Categorias residuais legítimas (mantidas como `any`, decisão registrada):**
- **Payloads de terceiros** — respostas de debrid, Jackett/Torznab e sites BR,
  cujas formas não são contrato nosso; normaliza-se após o `fetch`, não se
  tipa como `unknown` no ponto de recebimento.
- **`node:sqlite` sem tipagem no Node 20** — o `require` lazy (compat 20/22)
  não expõe tipos; o `any` documenta o acesso à API que só existe em runtime.
- **Compatibilidade SDK/Jackett** — superfícies herdadas do
  `stremio-addon-sdk` e das definitions Cardigann cujo contrato não é
  verificável por tipo.
- **Pools polimórficos** — coleções heterogêneas de fontes/streams de natureza
  distinta, em que a união tipada custaria casts mais frágeis que o `any`
  anotado no ponto de acesso.

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
Fase 0 (docs)      ✅ exceto 0.6 (README)
Fase 1 (B1,B2)     ✅ + 1.6/1.7 (refresh em fundo, achado da revisão)
Fase 2 (S*,B3,B4)  ✅ — resíduo menor no 2.4 (rotação + backoff redundantes)
Fase 3 (T1–T7)     ✅ — GATE da fase 5 satisfeito
Fase 4             ✅ 4.1–4.3
   │
   └─→ Fase 5 (refactors) ─→ Fase 6 (6.1/6.2 dependem do 5.5)
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
5.6/5.7 continuam em aberto e fora do escopo desta rodada.

## Validação global (por fase)

```
npm run typecheck      # portão: ZERO
npm run build          # dist/ atual (test roda dist)
npm test               # 1.117+ testes, zero falha
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
