# TypeSafe / System One — Probes Jev dub-lie e audio-classify (ETAPAS 2–3)

> **Status desta validação:** corridas ONLINE reais executadas em 2026-09-22
> (68 chamadas, 0 erro, latência média ~400–430 ms/chamada):
> **`dub-lie` 38/38 (100%)** — menor positivo 0,67 / maior negativo 0,54 com
> threshold 0,55, **margem estreita**; **`audio-classify` 26/30 (86,7%)** —
> 8 TP, 18 TN e **4 FN em títulos contraditórios** (idioma estrangeiro + PT no
> mesmo título). **Limitações:** o ground truth do audio-classify é o PRÓPRIO
> `looksPtBr` (não humano — acordo com a regra que ele imita é validação
> circular); threshold 0,55 mantido por causa da margem e dos FN; qualquer
> rebaixo de threshold exige revisão humana do corpus contraditório. Os
> probes validaram contrato wire, allowlist e latência — **não** validam
> acurácia de produção nem autorizam decisão automática (ver §15).

Este documento é a operação dos experimentos TypeSafe no Adom Power-Movie.
Fonte conceitual obrigatória:
[Introduction — Atomic questions, composed in code](https://docs.typesafe.ai/introduction#atomic-questions-composed-in-code)
e a documentação oficial correlata citada no código
(`.cursor/skills/typesafe-ai/SKILL.md`, `https://docs.typesafe.ai/llms.txt`).
`AGENTS.md` permanece a fonte canônica do repositório; este arquivo descreve
apenas o experimento.

---

## 1. Objetivo e não objetivo

**Objetivo.** Replay mensurável da hipótese *"post prometeu dublado BR ×
arquivos entregam outra coisa"* — o `DubLieError` do `pickFile` do Adom —
usando um Noul do System One (`is_dub_lie`) avaliado sobre um corpus com
ground truth, produzindo matriz expected × resposta, latência, tokens e
custo estimado.

**Não objetivo.**
- Não entra no caminho crítico de busca (ver §2).
- Não substitui as regras determinísticas do Adom (`looksPtBr`,
  `filterRelevantRaw`, `matchesBrTitle`, `foreignVerdict`, o próprio
  `DubLieError`): decisão registrada no cabeçalho de
  `scripts/jev-dub-lie-probe.mjs` — *TypeSafe não entra na primeira resposta
  nem substitui regras determinísticas do Adom*.
- Não é serviço em produção: nenhum código em `src/` importa estes módulos.
- Não é avaliação de qualidade do modelo nesta validação (dry-run não mede
  qualidade).

**Arquivos do experimento** (todos fora de `src/`):

| Arquivo | Responsabilidade |
|---|---|
| `scripts/jev-dub-lie-probe.mjs` | CLI: `--dry-run`, modo online, config, relatório |
| `scripts/jev-dub-lie-cases.mjs` | Corpus `CASES` com ground truth |
| `scripts/jev-dub-lie-payload.mjs` | Allowlist do estado, `QUESTIONS`, fingerprint, `planBatches` |
| `scripts/jev-dub-lie-metrics.mjs` | `judge`, matriz, latência, tokens, custo, `renderReport` |
| `scripts/jev-dub-lie-client.mjs` | `askOnce`/`runCorpus`: fan-out, timeout, retry, fail-open |
| `test/jev-dub-lie-probe.test.ts` | Prova local SEM rede (na lista do `npm test`) |
| `scripts/jev-audio-classify-probe.mjs` | CLI da ETAPA 3: audita o claim PT-BR só pelo título |
| `scripts/jev-audio-classify-cases.mjs` | Corpus cujo esperado é o classificador determinístico atual |
| `scripts/jev-audio-classify-payload.mjs` | Estado allowlist `post_title` e Noul `is_ptbr_dub` |
| `test/jev-audio-classify-probe*.test.ts` | Contrato local e CLI da ETAPA 3, ambos sem rede |

### ETAPA 3 — `audio-classify`

O probe irmão `jev-audio-classify-probe.mjs` pergunta se o título anuncia
dublagem pt-BR (`is_ptbr_dub`) antes de existir evidência de arquivo. Ele
reutiliza cliente, fan-out, retry, métricas e fail-open da ETAPA 2, mas envia
somente `post_title`: não envia indexer, arquivos, magnet, hash ou configuração.

O `expectPtBr` do corpus foi extraído do `looksPtBr` atual. Portanto, essa etapa
mede **concordância com a regra determinística viva**, não verdade externa nem
acurácia de produção. Divergência é candidata a revisão; nunca autoriza mudar
`_br`, `_dubClaim`, `_dubbed`, ranking ou limpeza automaticamente. Assim como
o dub-lie, o probe não é importado por `src/`, só teve `--dry-run` validado e
continua aguardando uma chamada real controlada para medir contrato wire,
latência, tokens, custo e comportamento do modelo.

---

## 2. Por que não entra no caminho crítico

Por construção, não por configuração:

- Nenhum arquivo dos probes é importado por `src/` (afirmação repetida no
  cabeçalho dos oito `.mjs`).
- O caminho crítico de busca tem orçamento sagrado
  (`REPLY_DEADLINE_MS`, `DEBRID_RESERVE_MS` etc. em `AGENTS.md`); uma
  chamada a modelo por caso (~dezenas de ms a segundos) não caberia e não
  é desejada lá.
- O veredito de `lie` hoje é determinístico e barato (`DubLieError` no
  `pickFile`, pós-debrid). O probe é **replay offline** da mesma hipótese,
  para medir se um Noul concordaria — evidência para uma decisão futura,
  não um passo do pipeline; nenhuma decisão de busca, ranking, autofetch
  ou limpeza lê saída do probe.

---

## 3. Estado estruturado e allowlist

O System One recebe um **estado estruturado** (não um prompt solto). O
estado deste probe é montado por `buildState()` em
`scripts/jev-dub-lie-payload.mjs` com **cópia campo a campo, nunca spread**:

```js
STATE_FIELDS = ['post_title', 'indexer', 'video_files']
buildState(c) → { post_title: c.post, indexer: c.indexer, video_files: [...c.files] }
```

Três travas garantem a allowlist:

1. **`buildState` só copia os três campos** — um caso contaminado com
   `magnet`, `hash`, `apiKey`, `sig` ou `config` tem o extra simplesmente
   descartado (provado no teste "allowlist" com caso sujo proposital).
2. **`validateCorpus` reprova o corpus inteiro** se qualquer caso carregar
   campo fora de `ALLOWED_CASE_FIELDS`
   (`id`, `group`, `expectLie`, `post`, `indexer`, `files`), se algum
   texto casar `FORBIDDEN_IN_CASE`
   (`magnet|xt=urn:btih|apikey|api_key|bearer|password|secret|signature`
   ou hash BTIH 40-hex solto — fronteira: 39/41 hex não casam) ou se houver
   `id` duplicado.
   Corpus inválido → sai com código 3 via `process.exitCode` (sem exit
   forçado; o stderr flusha).
3. **A chave viaja só no header** `Authorization: Bearer` e nunca é
   impressa nem devolvida nas linhas (`renderReport` não inclui credencial;
   o teste checa `!/Bearer\s+\S/`).

Nenhum magnet, hash, config de instalação, conta ou credencial sai do
processo.

---

## 4. Perguntas atômicas, avaliadas independentemente, composição em código

Pela documentação oficial
([Atomic questions, composed in code](https://docs.typesafe.ai/introduction#atomic-questions-composed-in-code)):

- Cada pergunta deve ser **específica e bem delimitada** — um "gut-check"
  que um especialista resolveria em segundos com o contexto certo.
- Perguntas são avaliadas **em paralelo e em isolamento** contra o mesmo
  estado numa única chamada; adicionar perguntas muda pouco a latência e
  não gera context-rot.
- Se a decisão exigir múltiplos fatores independentes, **decomponha**: faça
  uma pergunta por fator e **combine os resultados com lógica no seu
  código** — pesos e limiares ficam no código, não no prompt.

Neste probe há **uma pergunta atômica** (`QUESTIONS.is_dub_lie`, tipo
`noul`, versão `PROMPT_VERSION = 'dub-lie-q3'`): o post prometeu dublagem
PT-BR enquanto os nomes de arquivo indicam release **sem** áudio PT-BR?
A composição em código é o próprio `judge()` + `classifyRow()` (§5): o
threshold e a matriz moram em `jev-dub-lie-metrics.mjs`, não no texto da
pergunta. Uma pergunta futura (ex.: "há promo-only?", "o ano casa?") seria
um segundo Noul no MESMO `QUESTIONS`, avaliado em isolamento — a combinação
(`AND`/`OR`/pesos) continuaria no código, alterável sem reescrever prompt.

Critérios `true`/`false` do `QUESTIONS.is_dub_lie` documentam explicitamente:
marcas `Dual/Dublado/PT-BR` no arquivo são dublagem honesta; grupos de cena
EN sem marca PT são EN; idioma nomeado não-PT (Hindi/Tamil/FR/Rus/cirílico)
não é PT-BR mesmo com "Dual/MULTI" no post; `.srt` não é áudio dublado;
post sem promessa PT (incl. `LEGENDADO`) **não é mentira**.

---

## 5. O probe representa um Noul e transforma probabilidade em decisão

Pela tabela de primitivos oficiais, **Noul** = *"Is this statement true?"*,
devolvendo `noul` (0–1). Não há `confidence` separado no Noul.

No probe (`jev-dub-lie-client.mjs` + `jev-dub-lie-metrics.mjs`):

1. **Request:** `POST {state, model, questions}` com
   `questions.is_dub_lie = { type: 'noul', instructions, criteria }`.
2. **Resposta:** `json.answers.is_dub_lie.noul` (número). Resposta sem
   `noul` numérico é falha **permanente** (retry não conserta).
3. **Decisão binária por threshold** (`judge`):

   ```js
   judge(noul, threshold) → predLie = noul >= threshold
   ```

   Default `threshold = 0.55` (`JEV_DUB_LIE_THRESHOLD` / `--threshold`).
   `0.55 ≥ 0.55 → true`; `0.5499 → false` (travado no teste).
4. **Matriz** (`classifyRow(expectLie, predLie)`): `tp`/`fn` são casos
   esperados como lie; `fp`/`tn`, casos esperados como honestos. `fp` é o erro caro (denunciar post
   honesto rebaixa release boa) — mesmo princípio do banco de magnets:
   falso positivo de condenação é o pior caso.

Ou seja: **probabilidade (`noul`) → decisão (`predLie`) → métrica
(`tp/fp/fn/tn`) acontece 100% em código**, não no prompt — exatamente a
recomendação de "atomic questions, composed in code".

---

## 6. Corpus e fingerprint

**Corpus** (`scripts/jev-dub-lie-cases.mjs`): 38 casos — **16 `lie` /
22 `honest`** (assimétrico de propósito, viés honesto). Cada caso tem
`id` estável, `group` (família), `expectLie` (ground truth), `post`
(a promessa), `indexer`, `files` (a evidência real do debrid).

Famílias (`group`) exigidas pelo teste: `cena-en`, `idioma-nomeado`,
`cirilico-rus`, `pack`, `promo`, `legenda`, `pt-context`, `ano` — cada uma
ambígua precisa ter lados lie **e** honesto. Pares gêmeos separam sinal de
ruído na mesma família (ex.: `lie-promo-only` × `ok-promo-with-real-dub`;
`lie-crow-wrong-year` × `ok-corvo-1994-certo`).

**Fingerprint** (`corpusFingerprint`): SHA-256 canônico (chaves ordenadas,
sem relógio) de `promptVersion + questions + casos`. `sha256` completo vai
no `meta.corpusSha256` do relatório; o seco de 12 hex
(`corpus_sha256_12` / `corpusSha12`) identifica a corrida. Mudou pergunta
ou qualquer caso → hash muda → corridas deixam de ser comparáveis por
engano. Estável e sensível, provado no teste "fingerprint".

**BATCHING/PLANO** (`planBatches(cases, size)`): divide em lotes sem
perder, duplicar ou reordenar; último lote pode ser parcial. No modo atual
o **fan-out é 1 caso por request** (contrato SystemOne: um `state` por
chamada — empacotar casos inventaria formato que a API não tem);
`planBatches` existe como primitiva de planejamento testada, não como o
modo padrão do `runCorpus`.

---

## 7. Dry-run local (sem rede, sem chave)

```bash
node scripts/jev-dub-lie-probe.mjs --dry-run
```

O que faz (função `dryRun`): valida o corpus (`validateCorpus`; erro →
exit 3), imprime contagem/famílias, `prompt_version`, fingerprint de 12
caracteres, modelo/threshold/concorrência/timeout/tentativas efetivos, o
**plano de fan-out** (`N requests, 1 caso/request, no máximo C em voo`),
a allowlist OK, um payload de exemplo (`buildState` do primeiro caso) e a
orientação de custo. **Não abre socket, não lê `TYPESAFE_API_KEY`.**

**Limitação explícita:** o dry-run **não mede qualidade do modelo** — não
há noul, não há matriz, não há latência/tokens/custo reais. Ele valida o
experimento, não o modelo. **Nenhuma chamada real foi feita nesta
validação.**

Saída esperada (marcadores do teste): `modo=dry-run` com a alegação
limitada (`garantia por construção`, não sandbox), `corpus=38 casos`,
`allowlist=OK`, `prompt_version=`, o fingerprint e `"post_title"` no
payload; nenhuma credencial, nenhum `key_len`.

Códigos de saída (cabeçalho do probe): `0` corrida/relatório concluído
(mesmo com erros por caso — fail-open); `1` auth recusada (relatório
parcial); `2` sem chave no modo online; `3` corpus/args inválidos.

---

## 8. Execução online (futura) — envs e flags reais do código

Somente com chave; a chave é lida SÓ no modo online (`loadKey`: env
`TYPESAFE_API_KEY` ou linha `TYPESAFE_API_KEY=` no `.env` — já documentado
em `.env.example`). **Nunca é impressa.**

```bash
node --env-file=.env scripts/jev-dub-lie-probe.mjs
node --env-file=.env scripts/jev-dub-lie-probe.mjs --json
```

**Knobs env** (todos opcionais; defaults e clamps exatos do código):

| env | default | clamp/obs |
|---|---|---|
| `TYPESAFE_API_KEY` | — | obrigatória só no online; sai no header `Bearer` |
| `JEV_DUB_LIE_ENDPOINT` | `https://api.typesafe.ai/v1/systemone` | `POST` |
| `JEV_DUB_LIE_MODEL` | `jev-latest` | |
| `JEV_DUB_LIE_THRESHOLD` | `0.55` | 0..1 |
| `JEV_DUB_LIE_CONCURRENCY` | `4` | 1..16 |
| `JEV_DUB_LIE_TIMEOUT_MS` | `30000` | 1000..300000 |
| `JEV_DUB_LIE_MAX_ATTEMPTS` | `2` | 1..5 |
| `JEV_DUB_LIE_COST_INPUT_PER_M` | `0` | USD/1M tokens in; 0 = `n/d` |
| `JEV_DUB_LIE_COST_OUTPUT_PER_M` | `0` | USD/1M tokens out; 0 = `n/d` |

**Flags CLI** (precedem a env): `--dry-run`, `--json` (sem valor);
`--model <m>`, `--threshold <0..1>`, `--concurrency <n>`,
`--timeout-ms <n>`, `--max-attempts <n>` — aceita a forma `--flag=value`.
Flag desconhecida, valor ausente (fim de linha ou outra flag) ou fora da
faixa → exit `3`.

Auth recusada (401/403) → mensagem orientando gerar chave em `https://typesafe.ai`, exit `1` (via `process.exitCode`).

---

## 9. Batching, fan-out e concorrência

- **Fan-out padrão:** `runCorpus` (`jev-dub-lie-client.mjs`) processa o
  corpus com **N workers** (`concurrency`, default 4, clamp 1..16), um
  índice atômico por worker, **1 caso por request**. Não é sequencial por
  caso nem empacotamento múltiplo.
- **Ordem preservada:** as linhas saem na ORDEM DO CORPUS mesmo com
  término fora de ordem (teste dedicado).
- **`planBatches`:** primitiva pura de divisão em lotes (sem perda /
  duplicação / reordenação), disponível para planejamento — o fan-out
  executado hoje é por concorrência, não por lote na API.
- **Auth para o agendamento:** em 401/403 os workers param de agendar;
  requests JÁ EM VOO com concorrência > 1 concluem (podem também falhar
  auth, cada um com a própria linha `auth-recusada` e `attempts` real);
  casos nunca enviados viram linha `auth-parada` com `attempts: 0`
  (buraco silencioso seria pior que erro visível).
- **Nada se repete nem trava:** um request BEM-SUCEDIDO nunca é repetido;
  callback `onRow` que lança é engolido (fail-open) sem reagendação.

---

## 10. Timeout, retries e fail-open

**Timeout:** cada request usa `AbortController` próprio com
`timeoutMs` (`JEV_DUB_LIE_TIMEOUT_MS`, default 30000); estouro vira erro
com `timeout: true` (`timeout após Nms`).

**Retry** (até `maxAttempts`, default 2):

| situação | retry? |
|---|---|
| 429 / 5xx / timeout / erro de rede | sim, com backoff (`Retry-After` honrado até 5s, senão `500 × tentativa`) |
| 401/403 (auth) | **não** — para a corrida (`authStopped`) |
| resposta sem `noul` numérico | **não** (permanente) |
| outro 4xx | não |

**Fail-open:** erro nunca derruba a corrida. Cada caso falho vira linha
com `error` (e `byGroup.*.err`); a matriz conta só linhas decididas; o
relatório sai mesmo com todos os casos errados, com as falhas listadas.
`runCorpus` **nunca lança** — devolve as linhas completas.

---

## 11. Métricas: matriz, latência, tokens, custo

`summarize` + `renderReport` (`jev-dub-lie-metrics.mjs`):

- **Matriz** `tp/tn/fp/fn`, `decided`, `errors`, `accPct` (acordo sobre
  decididos), `disagreements` (= fp+fn), listas `fpIds`/`fnIds` e
  `errorRows`.
- **Por família:** tabela `total/tp/tn/fp/fn/err` por `group`.
- **Latência/request:** `avg`, `min`, `p50`, `p95`, `max` (nearest-rank);
  lista vazia → `n/d`.
- **Tokens:** agregados de `usage.input`/`usage.output` quando a API
  devolver `input_tokens|prompt_tokens` / `output_tokens|completion_tokens`
  (leitura defensiva). Sem usage → `tokens: nenhum uso retornado pela API`.
- **Custo estimado (USD):** `tokens/1e6 × preço`. Preços em
  `JEV_DUB_LIE_COST_INPUT_PER_M` / `JEV_DUB_LIE_COST_OUTPUT_PER_M`
  (USD por 1M tokens). Qualquer lado `0`/ausente → `n/d` e o relatório
  diz como configurar — **nunca inventa preço**.

`--json` emite o `summary` completo para agregação.

---

## 12. Segurança e privacidade

- **Allowlist rígida** (§3): só `post_title`, `indexer`, `video_files` no
  estado; validação rejeita corpus contaminado.
- **Chave:** só env/`.env` (gitignored); header `Authorization` apenas;
  nunca em stdout, log, relatório ou JSON.
- **Corpus sem credencial:** `validateCorpus` barra magnet/hash/apikey em
  qualquer texto.
- **Endpoint** configurável (`JEV_DUB_LIE_ENDPOINT`) — em ambiente
  controlado, aponte para o host autorizado; o default é o oficial
  `https://api.typesafe.ai/v1/systemone`.
- **Fora do addon:** nenhum dado de usuário/instalação real viaja — os
  casos são fixtures estáticas.

---

## 13. Critérios de sucesso e rollback

**Sucesso da ETAPA 2 (já coberto pelos testes locais SEM rede):**
1. corpus ≥ 30 casos, ids únicos, viés honesto, 8 famílias com ambos os lados;
2. allowlist exata (`post_title`/`indexer`/`video_files`) e caso sujo não vaza;
3. fingerprint estável/sensível/curto;
4. `planBatches` sem perda/duplicação/reordenação;
5. métricas puras (matriz, latência, custo) corretas;
6. cliente: ordem, 429→retry, 5xx→fail-open com attempts reais, 401→auth-parada,
   AbortSignal→timeout, `onRow` que lança engolido — via `fetchImpl` injetado;
7. CLI `--dry-run` sem chave/rede com os marcadores, e exit 3 para args inválidos.

**Sucesso online (ainda NÃO avaliado — exige corrida real):** relatório
com `decided` alto, `fp` baixo (erro caro), fingerprint registrado e
tokens/custo coerentes. Métrica de decisão para eventual integração
futura seria, por exemplo, `fp = 0` nas famílias sensíveis — **fora do
escopo desta validação**.

**Rollback / desligar o experimento:**
- Nos PROBES, não há kill-switch em runtime porque nada em `src/` depende
  deles — rollback é simplesmente não rodar a CLI (ou remover os arquivos do
  probe em commit próprio, se desejado). **O RUNTIME shadow (§15) tem
  kill-switch próprio**: `TYPESAFE_RUNTIME_ENABLED=false` (default) descarta a
  fila pendente e bloqueia novas leituras/escritas do cache `tsj` — sem limpar
  o cache. Uma chamada JÁ EM VOO conclui (janela ≤ 3000 ms) e grava o
  julgamento/métrica antes do desligamento; é ruído desprezível, não um
  caminho de decisão.
- `TYPESAFE_API_KEY` ausente → online aborta com exit 2; dry-run continua
  funcionando; no runtime, ausência de chave equivale a desligado.
- O `.env.example` mantém `TYPESAFE_API_KEY=` opcional e comentado; removê-la
  do `.env` local não afeta o addon.

---

## 14. Como testar localmente

```bash
# 0) build (a suíte roda dist/ e os arquivos de TESTE são .ts compilados;
#    os .mjs do probe NÃO exigem build: o teste importa a FONTE scripts/)
npm run build

# 1) suíte do probe (na lista explícita do npm test)
npm test
# ou só os arquivos compilados:
node --test dist/test/jev-dub-lie-probe.test.js dist/test/jev-dub-lie-probe-cli.test.js

# 2) dry-run do CLI (sem chave, sem rede)
node scripts/jev-dub-lie-probe.mjs --dry-run

# 3) typecheck do repositório (o probe é .mjs de scripts/, fora do tsc;
#    o teste .ts passa pelo programa raiz)
npm run typecheck

# 4) integridade do diff de documentação
git diff --check -- docs/TYPESAFE_SYSTEM_ONE.md
```

**Cobertura dos testes** (`test/jev-dub-lie-probe.test.ts` +
`test/jev-dub-lie-probe-cli.test.ts`): corpus, allowlist, fingerprint,
batching, métricas (render defensivo), cliente (rede injetada; attempts
reais, auth com concorrência, `onRow` que lança, threshold default) e o
CLI por spawn do script real (dry-run, exit 3, `--flag=value`). Nenhuma
função abre socket.

**Referências:** [Atomic questions, composed in code](https://docs.typesafe.ai/introduction#atomic-questions-composed-in-code) · [índice da docs](https://docs.typesafe.ai/llms.txt) · `.cursor/skills/typesafe-ai/SKILL.md` · `AGENTS.md` (regras do repo) · `.env.example` → `TYPESAFE_API_KEY`

---

## 15. RUNTIME SHADOW-ONLY (ETAPA 4) — mede, nunca decide

A integração do TypeSafe no runtime do Adom é **SOMBRA**: classifica títulos
pós-filtro em fila assíncrona e compara com o veredito determinístico
(`looksPtBr`/`_br`) — produz **SÓ MÉTRICA de concordância**. **Default OFF**
(`TYPESAFE_RUNTIME_ENABLED=false`): sem a flag (ou sem chave) o runtime é
inerte **por construção** — zero fetch, zero leitura e zero escrita de cache
(curto-circuito ANTES do fingerprint). Nenhuma decisão de busca, ranking,
vaga BR, `_dubClaim`/`_dubbed`/`lie`, índice, banco de magnets, limpeza ou
autofetch lê qualquer saída deste runtime — garantido por teste de grafo
(`test/typesafe-shadow-graph.test.ts`), que reprova qualquer import de
`src/ai/` nos módulos de decisão e só permite a fachada no caminho de
resposta.

**Arquivos** (`src/ai/`, todos sob o teto de linhas, sem dependência nova):

| Arquivo | Responsabilidade |
|---|---|
| `src/ai/types.ts` | Tipos públicos (`JevAudioJudgment`, `EnqueueResult`, `AskErrorKind`) |
| `src/ai/questions-audio.ts` | Espelho TS da pergunta validada online (paridade travada por teste) |
| `src/ai/typesafe-client.ts` | Única dona do fetch: Bearer no header, 1 tentativa, timeout ≤ 3000 ms, parse defensivo, fail-open |
| `src/ai/audio-judgment-cache.ts` | Cache do julgamento CRU (`tsj:v1`, cota 500, TTL de config) |
| `src/ai/audio-judgment-queue.ts` | Fila deduplicada + orçamento hora/DIA + breaker/auth-stop + comparação shadow |
| `src/ai/index.ts` | Fachada ÚNICA (`shadowAudioJudgments` produtor, `aiStatus` resumo) |

**Fluxo:** o produtor é `prepareCandidateStreams` (pós-filtro determinístico
de título) — enfileira até 12 títulos únicos por build (teto
`SHADOW_PER_BUILD_MAX`; excedente vira métrica `build-capped` e volta na
próxima busca), fire-and-forget, **nunca awaited pela resposta**. O drain roda
em `setImmediate`, lê SÓ `config.typesafe` (nunca `opts()`), com concorrência
1..4 e **1 tentativa por item** (quem re-pede é a próxima busca; o cache evita
re-chamada).

**Limites de custo (todos de operador, em `src/config/typesafe.ts`):**
`queueMax` teto DURO de fila (excedente descarta — não existe fila infinita),
`hourlyCap`/`dailyCap` janelas independentes, `cooldownMs` base do backoff
(fator 2^n até 32x), auth 401/403 para 30 min com um único warn por processo,
rate 429 honra Retry-After (teto 5 min). O timeout do cliente tem TETO de
3000 ms (contrato do slice).

**Cache `tsj:v1`:** chave `sha256(título normalizado | model | promptVersion)`,
valor `{ n, m, at }` — noul CRU (threshold aplicado só na comparação shadow),
sem título, sem chave, sem config. Namespace registrado com cota explícita
(500) e a conta do universo recalculada (92.721 ≤ teto 93.000, folga 279).

**Observabilidade:** métricas `typesafe.*` no `/metrics.json` (enqueue por
resultado, call ok/erro por kind FECHADO, budget hora/dia, breaker, cache
hit/miss, shadow agree/disagree com lado fixo, latency, tokens, fila) e bloco
compacto `typesafe` no `/dashboard-status.json` (`aiStatus()`: enabled, model,
promptVersion, fila, orçamento, cooldown). Nenhuma métrica leva texto de
título.

**Por que shadow e não overlay (diferença do plano M1):** os resultados
online recomendam cautela — o 26/30 tem 4 FN justamente nos títulos
contraditórios que seriam o domínio do overlay, e o ground truth atual é
circular (`looksPtBr`). Promover release por IA antes de ground truth humano
arriscaria vaga BR em título que a própria regra rejeitaria com razão. A
fase shadow mede a concordância EM PRODUÇÃO sem apostar nada; o overlay
(§16) foi além da fase de promessa: é monotônico no sentido de **só derrubar**
uma promessa genérica fraca — nunca promove — e nasceu com kill-switch de
fábrica.

---

## 16. OVERLAY GATEADO (ETAPA C) — o Jev no termo fraco do DUB genérico

Primeira influência da IA numa decisão, e por isso o desenho mais conservador
possível. **Default ON** — o default vive na fábrica de config
(`src/config/typesafe.ts`; **adicionar manualmente `TYPESAFE_OVERLAY_ENABLED=true`
ao `.env.example` local** — a linha não está no arquivo de exemplo do repo) e
a env é **kill-switch**: `=false` desliga na hora (rollback imediato e
baseline determinística; testes que precisam do legado desligam a flag
explicitamente). Dois fatos tornam o default ON seguro:

- **cache vazio é no-op honesto:** todo lookup é miss, e **ausência de cache
  preserva `true`** — o overlay não muda nada até o runtime shadow (§15)
  povoar o `tsj`;
- com a flag desligada o caminho é byte-a-byte o legado — `overlayDropsDub`
  devolve `false` ANTES de fingerprint e de qualquer leitura de cache (zero
  trabalho, zero métrica; travado por teste em `test/typesafe-overlay.test.ts`).

**O que muda com ON — só isto:** o Jev influencia SOMENTE o termo fraco
`genericDubProvesPt` dentro de `explicitPtAudio` (`src/utils/audio-quality.ts`):

- **marca PT forte => `true` SEM IA** (`DUBLAD[OA]`, `DUBLAGEM`, `DUB-BR`,
  `AUDIO PT-BR`, `PT-BR` sem LEGENDADO ao lado) — o overlay nunca é consultado
  para elas;
- **sem generic DUB => `false`** — como sempre;
- **generic DUB isolado (`[DUB]`, `Dubbed`, `DUB`) => `!overlayDropsDub`** —
  a única porta de influência.

`overlayDropsDub` (`src/ai/index.ts`, a fachada ÚNICA) é leitura **CACHE-ONLY
e SÍNCRONA** do julgamento da pergunta 1 (`is_ptbr_dub`, fingerprint =
`normalizeTitle(título) | model | PROMPT_VERSION`): **nunca faz fetch,
enqueue, escrita ou espera** — quem popula o cache é o runtime shadow (§15).
Regras da decisão:

- **noul <= 0.15 derruba `true`->`false`** (negativa CONFIANTE do modelo);
  o limiar é deliberadamente estreito porque o lado perigoso é o FP de
  condenação (derrubar dublado de verdade — os 4 FN medidos estavam no lado
  positivo do modelo);
- **ausência de cache preserva `true`** (miss não decide nada);
- **monotônico por construção:** o overlay só retira uma promessa genérica
  fraca, nunca promove — `false` nunca vira `true`;
- **memo curto** (512 fingerprints) guarda SOMENTE decisão vinda de HIT; miss
  nunca é memoizado — a escrita posterior do shadow é vista na próxima
  chamada, e `resetForTests` limpa o memo.

**Propagação e travas.** A opção `{ overlay?: boolean }` (default: aplica,
respeitando o kill-switch) atravessa `audioFromTitle` e `looksPtBr`. Três
locais fixam `{ overlay: false }` de propósito:

1. **`release-index.ts`** — o índice PERSISTE `dubbed`/`isBr` por semanas: a
   leitura viva do cache não pode reescrever retroativamente o acervo, então a
   classificação do idx fica determinística e **NÃO exige bump de namespace**
   (`idx` segue `v10`);
2. **`hasExplicitForeignAudio`** — lista MÍNIMA que CONDENA e apaga da conta
   (sweep/limpeza): a absolvição do generic DUB não pode ser retirada por IA;
3. **`foreignVerdict`** — o lado que ABSOLVE alimenta limpeza destrutiva;
   travado no legado pelo mesmo motivo (assimetria do AGENTS.md: ausência de
   PT nunca condena, condenação exige prova mínima).

O resto (listagem, ranking, cotas, Chupim, selos) flui pelo default — é o
efeito desejado: release que só se sustentava no `[DUB]` genérico perde vaga
BR quando o Jev diz com confiança que não é pt-BR.

**Cache version:** a lista pronta carrega a classificação (`_br`/`_dubbed`/
`_dubClaim`), então `streams` foi de **v14 para v15** (listas servidas antes
do overlay não podem congelar o rótulo antigo até o TTL).

**Grafo:** `audio-quality.ts` saiu do `DECISION_MODULES` de
`test/typesafe-shadow-graph.test.ts` e é o ÚNICO módulo de decisão liberado —
e somente à fachada `ai/index.js` (teste novo no mesmo arquivo prova isso; o
ciclo ESM `audio-quality <-> ai/index` é seguro porque o uso é em runtime, e o
teste carrega `audio-quality` ANTES da fachada para exercitar os dois lados).

**Métricas e painel:** `typesafe.overlay.consulted` (toda leitura com ON),
`.cache-miss` (sem julgamento no cache) e `.applied` (derrubadas efetivas) no
`/metrics.json`; bloco `overlay` no `typesafe` do `/dashboard-status.json`
(`aiStatus()`), renderizado na aba Jev do `/painel` como card "Overlay Jev
(ETAPA C)" com os três contadores e a cobertura do cache — sem ação nova
(o knob é do `.env` do operador).

**Portão de confiança** (o overlay está no ar; isto é o que acompanhar antes
de CONFIAR nos números e decidir mantê-lo ligado em produção séria):

1. **>= 200 julgamentos reais** da pergunta 1 acumulados pelo runtime shadow
   (cache `tsj` vivo — o overlay é inútil sem acervo);
2. **cobertura consulted/miss** no painel em nível saudável: alto `cache-miss`
   significa overlay consultando títulos que o shadow ainda não julgou —
   aumentar exposição do shadow antes de ligar;
3. **zero FP em famílias sensíveis** — amostragem manual dos títulos
   `applied`: nenhum generic DUB derrubado que fosse dublado pt-BR de verdade
   (corpus `jev-audio-classify-cases.mjs` como checklist);
4. **revisão humana dos 4 FN** do audio-classify (§ Status da validação):
   são o limite conhecido do modelo no exato domínio do overlay;
5. **reavaliar a cota `tsj`** (500) — o overlay multiplica as leituras por
   busca; hit não promove LRU de forma anômala e o namespace não pode virar
   gargalo de evicção com a contagem durável do `mag`.

Rollback: `TYPESAFE_OVERLAY_ENABLED=false` — inércia total, comprovada por
teste; nada do cache é apagado e o shadow segue medindo. O default ON com o
shadow OFF (instalação nova) é o cenário mais comum e permanece no-op: sem
runtime shadow, o cache nunca enche e o overlay nunca derruba nada.
