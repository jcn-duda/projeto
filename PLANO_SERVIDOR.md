# O addon como servidor — índice próprio de releases

Plano para inverter a relação com o Jackett: hoje o addon é um **proxy de busca
síncrono** (cada requisição do Stremio dispara raspagem ao vivo e a resposta
espera por ela); o alvo é ele ser o **servidor** — responder do próprio índice em
milissegundos e usar o Jackett como alimentador assíncrono.

> **Status.** Plano, nada implementado. Todas as medições citadas são desta
> instância em 2026-08-21, commit `3aa8da5`, com o container de pé.

## Contexto: o que dói hoje

O caminho de uma busca é sempre o mesmo, esteja o título quente ou frio:

```
Stremio → /stream → coleta ao vivo (Jackett + BLUDV + conta) → checagem no
debrid → lista
         └── orçamento de coleta: replyDeadline 9200ms − debridReserve 4500ms
```

Consequências medidas:

- **~5s por busca**, mesmo repetindo o mesmo título minutos depois (a lista sai
  do `streams:v5`, mas só enquanto o TTL de 900s durar).
- **A resposta sai `partial` por design.** Os indexers BR levam 6-8s e estouram
  o orçamento de coleta; o addon responde com o que tem e promove depois. É a
  razão de o `npm run smoke` "falhar" em completude sem haver bug.
- **Indexer fora do ar atrasa todo mundo.** No log desta sessão: `rutor ✗`,
  `1337x ✗`, `wolfmax4k ✗`. Quem paga o timeout é a requisição do usuário.
- **O trabalho caro é jogado fora.** A raspagem é guardada em `raw:v1` por
  15-30 min, chaveada por **query de indexer** — não por obra. Trinta minutos
  depois, a mesma obra recomeça do zero.

O addon já tem quase tudo para não trabalhar assim. Falta a peça que amarra.

## O que já existe (e não se joga fora)

| peça | o que faz hoje | papel no alvo |
|---|---|---|
| `raw:v1` ([jackett.ts:300](src/providers/jackett.ts:300)) | cache do bruto por `indexer:type:query`, TTL 900s (1800s BR), teto 120 itens | matéria-prima do índice; continua como está |
| `streams:v5` | lista final por config+conta, TTL 900s | vira cache de apresentação, não a memória |
| `dinv:v1` ([account.ts](src/providers/account.ts)) | conta do debrid como fonte — **1301 itens prontos (AllDebrid), 887 (TorBox)** | fonte instantânea, promovida na Fase 1 |
| `mag:v1` ([magnetdb.ts](src/utils/magnetdb.ts)) | juiz por hash: `bad` descarta, `alive` desempata | filtro e ordenação **sobre** o índice |
| `davail:v1` | disponibilidade por hash, TTL curto | continua respondendo ⚡ |
| [warmup.ts](src/warmup.ts) + [activity.ts](src/providers/activity.ts) | esquenta títulos do `WARMUP_TITLES` no boot, com freio na primeira requisição real | **o motor do colhedor já existe** — falta generalizar |
| [autofetch.ts](src/providers/autofetch.ts) | fila persistente, recheck, blacklist de morto | inalterado |
| [latest-writer.ts](src/utils/latest-writer.ts) | promoção parcial → completo (SWR) | é o que permite responder cedo sem mentir |
| [collection-window.ts](src/providers/collection-window.ts) | orçamento, graça para fonte BR prioritária | passa a reger o colhedor, não a resposta |

**A peça que falta é uma só:** memória indexada **por obra**, não por query nem
por hash.

## A peça nova: índice de releases (`idx:v1`)

```
idx:v1:<imdbId>[:<season>[:<episode>]]  →  { at, releases: [ ... ] }
```

Cada release guarda o mínimo que a listagem precisa e **nada de credencial**:

```
{ hash, title, size, indexer, isBr, quality, seeders, seenAt }
```

Invariantes (as mesmas que já regem o `raw:v1`, e pelas mesmas razões):

1. **Sem config do usuário e sem chave de debrid na chave.** É o que faz o
   índice ser compartilhado entre instalações — e é o que impede vazar lista
   privada de uma conta para outra: o índice guarda o que EXISTE, nunca o que
   está pronto em qual conta (isso é `davail` e `mag`, ambos escopados por
   conta).
2. **Só o que já passou pelo filtro de relevância** (`filterRelevantRaw` /
   `matchesEpisode`). Lixo de outra obra não entra — o índice não pode virar um
   despejo do Jackett.
3. **Deduplicação por hash**, mantendo o registro mais recente.
4. **`seeders` é uma foto datada** (`seenAt`), não verdade corrente. Quem decide
   ordem final continua sendo o `sortAndLimit` sobre o estado atual (`alive`,
   `davail`), não o número congelado.

**Dimensionamento.** ~200 bytes por release × 40 releases = ~8 KB por chave.
Cota proposta: **4000 chaves** (~32 MB no pior caso, L1 em memória + SQLite).

**Atenção à invariante que acabamos de consertar:** a soma das cotas hoje é
26.000 contra `MAX_ENTRIES = 30000`. Somar `idx: 4000` fecha exatamente em
30.000 — e teto **igual** à soma já reintroduz o problema do `98cd842`. A Fase 2
sobe `MAX_ENTRIES` para **36.000** junto com a cota nova, não depois.

## Arquitetura alvo

Dois caminhos que deixam de compartilhar o relógio:

```
CAMINHO DA RESPOSTA (síncrono, alvo: <500ms)
  /stream → índice (idx) + conta (dinv) → checagem no debrid → lista
                                            └── mag/davail decidem ⚡ e ordem

CAMINHO DA COLHEITA (assíncrono, sem usuário esperando)
  fila de obras → Jackett/BLUDV com orçamento LARGO → filtro de relevância → idx
     ↑                                                                        │
     └── alimentada por: busca com lacuna · autofetch · próximos episódios ───┘
```

A diferença que importa: hoje o orçamento de coleta existe porque **o usuário
está esperando**. No colhedor não há ninguém esperando — ele pode dar ao Jackett
os 20s que os indexers BR realmente levam, sem prejudicar ninguém, e ainda
respeitar o freio de atividade que o `warmup` já implementa.

---

## Simulação de desempenho: addon vs Jackett

Medido nesta instância em 2026-08-21, usando o `raw:v1` que já existe como
**simulacro do índice** — é a Fase 0 antecipada: dá para medir o teto do plano
sem escrever uma linha de armazenamento novo.

| cenário | latência | streams | como foi medido |
|---|---|---|---|
| **Hoje, frio** (Jackett ao vivo) | **5,3 – 6,7s** | 19 / 22 / 9 | 3 títulos novos, primeira busca |
| **Índice + `davail` quente** (zero rede) | **55ms** | 22 | `raw` todo quente, `streams:v5` apagado, container reiniciado |
| **Índice + checagem fria** (rede só no debrid) | **~0,7s** | 22 | composição: 55ms − 1ms + 620ms de checagem medida |
| Hit do `streams:v5` (já hoje) | 3 – 9ms | idem | repetição imediata da mesma busca |

O caso do meio é o número que importa: **mesma lista, mesmos 22 streams, 55ms
contra 5,3s** — 96× mais rápido, e a única coisa que mudou foi a origem dos
resultados brutos.

### Onde o tempo é gasto hoje

Decomposição do caminho frio, com os números que o próprio addon loga:

| componente | custo medido | o índice remove? |
|---|---|---|
| coleta (Jackett + BLUDV) | **4700ms** — o orçamento inteiro, esgotado | **sim** |
| checagem no debrid | 267 / 506 / 620 / 628ms (fria), 1ms (davail quente) | não |
| filtro + ordenação + serialização | **~54ms** (55ms totais − 1ms de checagem) | não |

### O achado que muda a prioridade do plano

O orçamento não é gasto esperando indexer que **responde** — é gasto esperando
indexer que **falha ou arrasta**: `redetorrent 3,5s` e `20,0s`,
`bludv-cardigann 8,4s`, `1337x ✗`, `rutor ✗`, `wolfmax4k ✗`, `kickasstorrents-to
✗`. E consulta que falha não gera entrada no `raw` — corretamente, porque erro
não é resultado. A consequência é que **o custo do indexer quebrado é pago de
novo em toda busca**, e nenhuma camada de cache o elimina.

Por isso a Fase 3 (Jackett no tail) vale mais do que a Fase 2 sozinha: guardar
release não tira o timeout do caminho crítico; só **parar de consultar
sincronamente** tira. Medição que confirma: quando o breaker já tinha marcado os
indexers ruins e todo o `raw` estava quente, a busca saiu em 55ms; na rodada em
que a coleta rodou de novo, o mesmo título voltou a custar 4,65s **mesmo com 200
entradas `raw` vivas**.

### Limite honesto da simulação

O `raw:v1` é chaveado por `indexer:type:query` e vive 15-30 min. O índice
proposto é chaveado por obra e vive 30 dias — ou seja, o cenário de 55ms hoje só
acontece por acidente, dentro da janela curta do `raw`. O plano não inventa
velocidade nova: ele **torna permanente** um estado que já é alcançável e raro.

## Fase 0 — medir antes de construir

Construir o índice sem saber quanto ele acertaria é apostar. Antes de qualquer
linha de armazenamento, instrumentar o que já roda:

- `search.idx.wouldHit` / `search.idx.wouldMiss` — simular a consulta ao índice
  usando o `raw:v1` que já existe, sem escrever nada.
- `search.account.sufficient` — quantas buscas a conta sozinha já responderia
  com candidato tocável (é o gate da Fase 1).
- `search.jackett.wastedMs` — tempo gasto em indexer que não contribuiu com
  nenhum item que sobreviveu ao filtro.

**Critério de decisão:** se `wouldHit` ficar abaixo de ~30% em uma semana de uso
real, o índice não paga o custo e o plano para na Fase 1. Escrito aqui de
propósito, para a fase seguinte não virar inevitável só porque foi planejada.

Isto exige `JACKETT_TEST_TOKEN` no `.env` — hoje `/metrics.json` está fechado
nesta instância e não há como ler contador nenhum sem entrar no SQLite.

## Fase 1 — fast-path da conta do debrid

O que já discutimos: se a conta sozinha entrega candidato tocável suficiente
para a obra pedida, responde **na hora** e joga o Jackett para o tail, que
recacheia a lista enriquecida.

- **Ganho:** título já baixado abre em milissegundos, e fica imune a indexer
  caído.
- **Escopo:** `providers/index.ts` — um corte no `collectWithinWindow` quando a
  tarefa da conta volta com N itens relevantes, e o resto da coleta segue em
  background pelo `latest-writer`.
- **Ponto a verificar antes de prometer:** o `finish`/`latest-writer` precisa
  aceitar corte antecipado sem quebrar o SWR e o `cacheMaxAge` — hoje a resposta
  sai `partial` de propósito e é isso que alimenta a revalidação. Se não sair de
  graça, a fase cresce.
- **Limite honesto:** só cobre o que ESTA conta já tem. Título novo continua
  custando o mesmo.

## Fase 2 — o índice existe e é ESCRITO (leitura ainda não)

Toda busca que hoje já roda passa a alimentar o `idx:v1` com o que sobreviveu ao
filtro de relevância. Nada muda no caminho da resposta.

- Escrita no mesmo ponto onde o `raw` já é consolidado, depois do
  `filterRelevantRaw`.
- Cota `idx: 4000` + `MAX_ENTRIES: 36000` no mesmo commit (ver acima).
- TTL longo (proposta: **30 dias**), porque release não deixa de existir por
  envelhecer — quem a desqualifica é o `mag`/`dead`, não o relógio.
- Kill-switch: `RELEASE_INDEX=false` e `RELEASE_INDEX_TTL=0`.

Rodar assim por alguns dias dá o dado que a Fase 0 simulou, agora real: quantas
chaves, que tamanho médio, quanto do teto ocupa.

## Fase 3 — o índice é LIDO, e o Jackett vira segundo

A inversão propriamente dita:

1. A busca lê `idx` + `dinv` primeiro. Se o conjunto tem candidato suficiente
   (por qualidade/BR/quantidade, com os mesmos critérios do `sortAndLimit`),
   **responde já**.
2. O Jackett roda no tail, enriquece o índice e promove a lista pelo SWR — o
   mesmo mecanismo que hoje promove o passe tardio.
3. Se o índice não cobre (obra nova, temporada nova, lacuna de episódio), o
   caminho atual roda inteiro, sem regressão.

**Regra de segurança:** "índice cobre" nunca pode ser decidido por contagem
pura. Uma temporada indexada só com legendado não pode impedir a busca BR
dublada de rodar — o critério tem que incluir a mesma noção de pool que o
autofetch já usa (BR dublado / global dublado / melhor swarm).

## Fase 4 — o colhedor

Generalizar o `warmup` em um colhedor contínuo:

- **Fila de obras a colher**, persistente, alimentada por: busca que achou
  lacuna, episódio seguinte de série assistida (o `prefetchKey` do autofetch já
  faz algo assim), temporada nova de série no índice.
- **Freio de atividade**, que já existe: `hasUserTraffic()` corta o ciclo na
  primeira requisição real. Precisa evoluir de "marca de boot" para janela
  deslizante (colher enquanto ninguém usa há N minutos).
- **Orçamento largo** — 20s+ por indexer BR, porque não há ninguém esperando.
- **Teto de educação com os indexers:** concorrência baixa e intervalo mínimo
  entre consultas ao mesmo indexer. O colhedor reduz carga total (a mesma obra
  deixa de ser raspada a cada busca), mas não pode virar um crawler.

## Fase 5 — visibilidade

O índice sem observabilidade é uma caixa-preta que ninguém sabe se ajuda:

- Painel do índice no dashboard: chaves, tamanho, hit rate, idade média,
  obras mais servidas sem Jackett.
- `idx.hit` / `idx.miss` / `idx.served` / `idx.grown` separados por tipo.
- Uma linha no log por busca servida só pela memória — é o número que prova a
  tese do plano.

---

## Riscos e limites

1. **Release velha.** Um hash de 3 meses pode ter morrido. Mitigação já
   existente: a checagem de cache roda a cada busca, e `bad`/`dead` filtram
   antes dela. Pior caso: o item aparece como `[AD download]` em vez de ⚡ —
   degradação, não erro.
2. **Crescimento.** O índice cresce por obra buscada, não por busca. LRU por
   cota resolve, mas exige a aritmética do teto respeitada (Fase 2).
3. **Memória.** O L1 é um `Map` em processo. 32 MB de índice sobre ~80 MB de
   RSS medidos é aceitável dentro do `mem_limit: 3g`, mas tem que ser medido de
   novo depois da Fase 2, não assumido.
4. **Semântica de cache do Stremio.** Responder mais rápido com lista menor e
   promover depois é exatamente o que o SWR já faz — mas `cacheMaxAge` mal
   ajustado faz o cliente segurar a lista pobre. Qualquer corte antecipado
   (Fases 1 e 3) precisa manter `cacheMaxAge: 0` enquanto a coleta não fechou.
5. **Conta compartilhada.** O índice é público entre instalações **de
   propósito**; `davail`/`mag` continuam por conta. Essa fronteira não pode
   borrar — é ela que impede uma instalação de descobrir o que a outra tem.
6. **O que este plano NÃO é:** não é expor o índice como serviço para fora, nem
   virar tracker/indexer. Isso muda o perfil legal e operacional do projeto e
   fica explicitamente fora de escopo.

## Testes por fase

| fase | teste automatizado | teste real |
|---|---|---|
| 0 | contadores existem e não mudam comportamento | ler `/metrics.json` (exige token) por uma semana |
| 1 | conta suficiente → resposta sem esperar Jackett; conta insuficiente → caminho atual | busca de título já na conta, medir latência antes/depois |
| 2 | escrita alimenta `idx`; filtro de relevância aplicado; kill-switch desliga | tamanho e contagem no SQLite depois de N buscas |
| 3 | índice cobre → serve dele; só legendado no índice → NÃO impede busca BR; lacuna → caminho completo | mesma busca com Jackett **derrubado de propósito** deve responder |
| 4 | fila persiste, freio corta na requisição real, teto de concorrência | observar log com o container ocioso |
| 5 | painel renderiza sem token quando fechado | abrir o dashboard |

O teste da Fase 3 com o Jackett derrubado é o critério de aceitação do plano
inteiro: **se a busca responde com o Jackett fora do ar, o addon virou o
servidor.**

## Ordem e risco

| Fase | Escopo | Risco |
|---|---|---|
| 0 | contadores | nenhum; é o que autoriza as outras |
| 1 | fast-path da conta | baixo, valor imediato; depende do `latest-writer` aceitar corte |
| 2 | escrever o índice + cotas | baixo (nada lê ainda); mexe em memória |
| 3 | ler o índice, Jackett no tail | **alto** — muda o que o usuário vê; precisa do gate por pool |
| 4 | colhedor | médio; precisa de teto de educação com indexer |
| 5 | painel e métricas | baixo |

## Decisões em aberto

1. **TTL do índice:** 30 dias é chute defensável. Alternativa: sem TTL, só LRU
   por cota — release não expira, só é esquecida por pressão.
2. **Granularidade de série:** chave por episódio, por temporada, ou as duas?
   Pack cobre a temporada inteira e hoje já existe `isSeasonPackFillEligible`
   para decidir isso — reusar essa regra em vez de criar outra.
3. **Fase 1 antes da 0?** Ela tem valor próprio e independe da medição. Se você
   quiser resultado visível já, ela pode ir primeiro; a Fase 0 só é
   pré-requisito da 2 em diante.
