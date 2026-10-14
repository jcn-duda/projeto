---
name: adom-project-evolution
description: Avalia o estado real, a fase atual, os riscos, as prioridades e a prontidao do Stremio Adom em E:/stremio adom, ou conduz a proxima etapa autorizada do roadmap. Use para evolucao, andamento, proxima fase, PLANO_MELHORIAS, PROJECT.md, saude, refactor, milestone ou continuidade do projeto. Nao use para uma correcao pontual sem relacao com status ou roadmap.
---

# Evolucao do Adom

Trabalhe no checkout real em `E:/stremio adom`. Distinga com evidencia o que foi entregue, o que so esta documentado, o que esta em andamento e qual e o proximo passo coerente.

## Fontes e precedencia

Em conflito, use esta ordem:

1. comportamento e testes do codigo atual;
2. `AGENTS.md`, fonte operacional;
3. Git: commits, branch, upstream, diff e nao rastreados;
4. `PLANO_MELHORIAS.md`, para dependencias e gates;
5. `PROJECT.md`, para o resumo arquitetural;
6. `README.md` e planos especializados.

`PROJECT.md` e `PLANO_MELHORIAS.md` podem atrasar ou divergir. Nao trate arquitetura alvo como implementada. Consulte `DEBRID.md`, `PLANO_CACHE.md`, `TEST_INFRA.md` ou `PLANO_SERVIDOR.md` quando o dominio exigir.

## Respeite o tipo de pedido

- Status, fase, risco ou proximo passo: diagnostique e recomende; nao edite.
- Continuar, evoluir, implementar ou concluir: escolha a menor unidade shippable autorizada, implemente e valide.
- Atualizacao documental: nao altere comportamento executavel.
- Analise nao autoriza commit, deploy, limpeza de conta ou outra mutacao externa.

## Auditoria ao vivo

Leia `AGENTS.md` por completo e execute antes do veredito ou da primeira edicao:

```powershell
git status --short --branch
git diff --stat
git branch -vv
git log --oneline --decorate -40
```

Se o veredito envolver comportamento ao vivo (`:7000`, painel, smoke), confira ANTES se o container corresponde ao HEAD: `docker inspect stremio-adom --format '{{.Created}}'` contra a data do commit. O container fica para tras do commit por padrao — codigo commitado nao e codigo rodando, e medir no container velho produz laudo falso (positivo E negativo). `docker compose up -d --build adom` sobe o HEAD; o `cache.db` sobrevive ao rebuild.

Depois leia as secoes de milestones e da fase candidata no roadmap, confira as afirmacoes no codigo/testes e examine o diff de todo arquivo ja modificado antes de toca-lo. Separe commits locais a frente do upstream, mudancas unstaged e arquivos nao rastreados. Uma caixa marcada no Markdown nao e prova suficiente.

Para explicar a evolucao, agrupe commits por capacidade, nao por quantidade. Use esta trajetoria apenas como mapa e reconstrua o estado atual ao vivo:

```text
addon self-hosted
  -> fontes e resolvers BR
  -> configuracao stateless e debrid multi-servico
  -> stack unica e cache persistente
  -> observabilidade, seguranca e protecao da conta
  -> TypeScript/ESM estrito (servidor)
  -> indice/colhedor e fast paths
  -> rede adversarial de testes
  -> modularizacao incremental com fachadas estaveis
  -> catraca de linhas e extracao dos HTML do painel
  -> Fase 8 conta AllDebrid (adsub/adrm/evict/reconcile; knobs destrutivos default OFF)
  -> P5 /stream-trace.json + bumps de namespace (streams v11 / idx v10 correntes)
  -> time de 12 agentes (team/adom-team.json + team/skills + .cursor/agents)
  -> saneamento pre-ESM (ciclos do painel, estado com dono, env explicita nos resolvers)
  -> ESM total: resolvers/ + *-resolver/ ESM; /configure e /dashboard em ESM nativo (src/client)
  -> resolvedores tipados integralmente em .ts (nenhuma fonte JS na ilha)
```

**Mapa rapido do roadmap (confira no codigo, nao so no MD):** M0–M6 DONE;
Fase 7 trilha C DONE, A/B operacionais na VPS; Fase 8 no codigo; Fase 9/P5
commitada; titulo EN canonico (`b223ffd`, segunda `/find` en-US no mesmo deadline)
e packs BR multiobra nativos por padrao (`d8bd23b`; `BR_MULTIWORK_PACKS` default
true, `false` e o kill-switch explicito). ESM total
fechado em 2026-09-12 (`3c20c39` saneamento, `31ddac9`
resolvers ESM, `1b3426c` clientes, `aec0a9a` resolvedores tipados em `.ts`,
`5e28d7d` fim do CommonJS nos testes); os unicos `createRequire` restantes sao
intencionais: `node:sqlite` lazy e leitura de `package.json` nos scripts. Aberto tipico:
7.1/7.5 na VPS, decisao de TTL do `davail`, ativacao explicita de knobs
destrutivos. Namespaces e cotas: leia `cache-keys.ts` e `cache-quotas.ts`
(`streams` v11, `idx` v10, `mag=50000`, teto 84000).

## Classificacao

- `VALIDADO`: existe no codigo e passou pelo gate exigido.
- `PARCIAL`: parte existe, ha diff em andamento, documento divergente ou gate incompleto.
- `PLANEJADO`: so ha especificacao ou dependencia aberta.
- `BLOQUEADO`: ha impedimento concreto fora do alcance; diga qual.
- `REGREDIDO`: contrato antes entregue deixou de valer; mostre a prova.

Para cada milestone relevante, registre entregas, evidencias, lacunas, risco residual e dependencia. Mostre divergencias documentais explicitamente, mas nao as corrija num pedido somente analitico.

## Escolha do proximo passo

Priorize: regressao ou risco de dados/conta; gate quebrado; trabalho ja iniciado que possa ser concluido sem absorver mudanca alheia; proxima subfase com dependencias atendidas; melhoria opcional.

Nao inicie refactor amplo com gates vermelhos. Nao misture subfases independentes. Se o working tree ja contiver a fase candidata, audite e conclua esse trabalho em vez de recria-lo.

## Contratos de implementacao

- Preserve toda mudanca alheia; nunca limpe o checkout para obter base verde.
- Use TypeScript + ESM e imports `.js` conforme o padrao compilado.
- Nao importe `src/addon.ts` como teste: ele abre o servidor.
- `npm test` roda `dist/`; faca build verde antes. O `npm run build` limpa `dist/` antes do `tsc`: build vermelho deixa `dist/` ausente ou incompleto — nunca rode esse `dist/`.
- Todo `test/**/*.test.ts` novo entra na chave `testFiles` do `package.json` e passa por `npm run test:complete`.
- Catraca de linhas (5.8): teto de 400 sobre `.ts`/`.js`/`.css`. O baseline `.line-budget.json` esta VAZIO: nenhum arquivo do escopo pode passar de 400 e `--bless` nao admite arquivo novo — a saida e dividir. Desde `aec0a9a` o portao mede tambem arquivo NAO rastreado (rascunho sem `git add` conta). O CI roda `npm run lint:lines -- --check`.
- Painel: `src/public/` so tem HTML/CSS/imagens. O JS de `/configure` e `/dashboard` e ESM nativo em `src/client/<nome>/*.ts`, com dois emits (`tsconfig.client.json` -> browser em `dist/src/public/client/`; `tsconfig.client.test.json` -> Node em `dist/src/client/`, so para testes). Modulo novo entra na allowlist FECHADA `CLIENT_ASSETS` de `src/routes/public.ts` (o boot le todos; ausente derruba o app). O entry leva `?v=` immutable; os filhos saem `no-cache` + ETag/304. Testes importam o emit de Node via `test/helpers/client.ts` / `test/helpers/dashboard.ts` — sem `new Function` nem regex de corpo de funcao. O painel exige WebView com ES modules (decisao C3).
- Resolvers: `resolvers/` e os seis `*-resolver/` sao TypeScript/ESM (nenhuma fonte `.js`), compilados pelo proprio `tsc` para `dist/` — o build-assets nao copia mais `resolvers/` e nao ha `/app/resolvers` na imagem. Os profiles sao import-safe (config por `resolvers/env-config.ts`, nunca `process.env` no topo), os tipos compartilhados moram em `resolvers/types.ts` e `src/br-resolvers.ts` importa os seis estaticamente. Nao reintroduza `require`, `module.exports`, fonte `.js` nem leitura de env no import.
- Opcao de usuario usa `runtime.ts`/`opts()`; infraestrutura usa `config.ts`.
- Titulo global canonico sem Cinemeta vem da segunda consulta TMDB `/find` em
  `en-US`, no mesmo deadline da pt-BR; nao use `alternative_titles` como fonte
  de matching nem congele falha transitoria pelo TTL longo.
- Pack BR multiobra e infraestrutura nativa do operador (default true; `false` e
  o kill-switch explicito), nao chave do schema de usuario: exige `BR_MULTIWORK_PACKS`
  ausente ou `true`, filme, debrid, nomes, ano, colecao TMDB, raiz contigua e
  cobertura do ano no titulo ou magnet (faixa que o inclui ou ano avulso com
  tolerancia de ±2). O pack admitido (`_multiWorkAdmitted`) nao vai para P2P,
  indice, autofetch ou warmer; o play usa `p:1` assinado e `pickWorkFile`.
- Trabalho tardio da request captura e restaura o contexto de runtime.
- Preserve fachadas e contratos durante refactors; atualize alvos de harnesses movidos quando necessario.
- Nao exponha `.env`, tokens ou chaves. Nao adicione dependencia sem necessidade real.
- Nao faca commit sem pedido; `comitar` nao significa `push`.

## Gates

Codigo comum (o `typecheck` cobre os tres programas: raiz e os dois do cliente):

```powershell
npm run typecheck
npm run build
npm test
npm run test:complete
npm run lint:lines -- --check
git diff --check
```

Refactor arquitetural ou alteracao de harness:

```powershell
npm run typecheck
npm run build
npm test
npm run test:complete
npm run lint:lines -- --check
npm run test:stress
npm run test:adversarial
npm run test:adversarial-m1
npm run test:protector-m1
npm run test:challenger-m2
npm run test:ranking-challenger
git diff --check
```

Para docs, revise o diff e rode `git diff --check -- <arquivos>`; nao alegue suite executada. `npm run smoke` usa rede real: rode apenas quando o escopo exigir e os servicos estiverem disponiveis. Nao resolva play frio nem limpe magnets sem autorizacao explicita.

## Entrega

Comece pelo veredito e informe: fase real e rotulo; evolucao confirmada por capacidades; evidencias; maior risco; proximo passo recomendado ou implementado; validacoes executadas e limites. Separe prontidao de codigo, suite local, Docker, servicos reais e producao.
