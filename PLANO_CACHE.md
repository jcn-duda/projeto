# Cache multi-nível v3 — revisão do PLANO_CACHE.md

Substitui o `PLANO_CACHE.md` da raiz. Mantém a direção da v2 (tiers, ordem por
risco/valor, kill-switch por TTL) e corrige o que a v2 dimensionou ou afirmou
errado sobre o código real.

> **Status histórico.** Este documento é o plano da época em que o projeto era
> CommonJS/JS. As **fases 0–2 já estão implementadas** no código; a fase 3
> continua **gateada** por métrica (`debrid.check.repeated / debrid.check.hashes`
> > 30% em 15 min). Os namespaces atuais são `streams:v5`, `raw:v1` e `dinv:v1`,
> centralizados em `src/utils/cache-keys.ts`. Menções a `streams:v4`, `raw1:` e
> a fontes `.js` no corpo são o nome/forma da época e ficaram como registro
> histórico — hoje a fonte é `.ts` com build para `dist/`.

## Contexto

A v2 está certa no diagnóstico principal: o trabalho caro (Jackett + scrapers
BR) está acoplado à chave `streams:v4`, que carrega config e digest da conta —
verificado em [request-key.js:18](src/utils/request-key.js:18). Duas configs
diferentes do mesmo título refazem a busca inteira. O Tier 3 (cache do bruto,
sem credencial) é a resposta certa, e a decisão de NÃO afrouxar a `streams:v4`
está correta: o valor cacheado contém URLs de play assinadas contra a chave de
debrid do usuário.

O que mudou desde a v2: subimos a **busca tardia de pack**
([index.js:768](src/providers/index.js:768)), que dispara `"Nome S03"` para
cada episódio fraco da mesma temporada. Sem cache do bruto, é uma varredura
completa de Jackett por episódio; com ele, o primeiro episódio paga e os demais
são hit. Esse virou o argumento mais concreto do Fase 1.

## Correções sobre a v2

1. **A cota `raw1: 3000` estoura a memória do container.** Medido num resultado
   real do therarbg: **862 bytes por item**. Com o teto de 250 itens da v2, cada
   entrada chega a 210 KB e 3000 entradas cheias são **~616 MB** no L1 (que é um
   `Map` em memória, [cache.js:6](src/utils/cache.js:6)). O container inteiro tem
   `mem_limit: 3g` ([docker-compose.yml:63](docker-compose.yml:63)) e divide isso
   com Jackett e FlareSolverr. Correção: teto de **120 itens** e cota **800** →
   pior caso ~79 MB, caso realista (~40 itens/entrada) ~26 MB.
2. **`MAX_ENTRIES: 21000` contradiz a própria justificativa.** O comentário do
   código diz "soma das cotas + folga" e hoje é 11000 para uma soma de 10.700.
   Com `raw1: 800` e `streams: 2000` a soma vai a 11.500 → **`MAX_ENTRIES:
   12000`**, não 21000.
3. **O `/all` NÃO se beneficia sem mudança.** A v2 afirma isso, mas o caminho
   agregado tem `fetch` próprio dentro de `search()`
   ([jackett.js:322](src/providers/jackett.js:322)) e não passa por
   `queryIndexer`. Ou o cache entra lá também, ou a frase sai do plano. Escolha:
   **fica fora do escopo** — o `/all` só roda sem `JACKETT_INDEXERS`, que não é
   a configuração desta instalação.
4. **O hit mente para o `indexer-status`.** Num hit de `fetchQuery`, o
   `search()` registra `ok:true` com `ms` ~0 ([jackett.js:365](src/providers/jackett.js:365))
   — uma medição que não aconteceu. Efeito: indexer que caiu fica verde no card
   por até o TTL, e é justamente o card usado para diagnosticar os `✗`.
5. **A elegibilidade do SWR deixa passar o item de aviso.** `partial === false &&
   streams.length > 0` é verdade para a lista que contém só o aviso
   ("Nenhuma fonte pronta…"). O `finish` já resolveu isso do outro lado exigindo
   um stream tocável para marcar `complete` ([index.js:678](src/providers/index.js:678));
   o SWR precisa do MESMO teste.
6. **Resultado vazio não pode herdar o TTL cheio.** Indexer que devolve 200 com
   zero itens por rate-limit congelaria o vazio por 15 min. TTL curto separado.

## Premissas (inalteradas da v2)

TypeScript/ESM com build (`tsc` → `dist/`), zero dependência nova, comentários
em português; nenhum dos seis invariantes do AGENTS.md é tocado; toda TTL nova é
env com `0` = desligado.

---

## Fase 0 — Instrumentar antes de cachear (1 commit, sem mudança de comportamento)

A v2 só instrumentava para decidir a Fase 3. Fazendo antes das três, cada fase
passa a ter linha de base:

- `cache.hit.<ns>` / `cache.miss.<ns>` por namespace em
  [cache.js:316](src/utils/cache.js:316), somando aos contadores globais que já
  existem (nada é removido do `/metrics.json`);
- `debrid.check.hashes` e `debrid.check.repeated` no `checkCached` do registry
  ([debrid/index.js](src/debrid/index.js)) — a v2 já pedia isso, só antecipado.
  Importante: o coalescing existente (`nonAbortableKey`,
  [debrid/index.js:68](src/debrid/index.js:68)) casa o **conjunto inteiro** de
  hashes ordenados, então ele NÃO cobre repetição por hash — é isso que a
  medição vai quantificar.

Rodar uma semana. Gate para a Fase 3: > 30% de hashes repetidos em 15 min.

---

## Fase 1 — Cache do resultado bruto (maior valor, menor risco)

### 1.1 Jackett (`src/providers/jackett.js`)

- Memoizar **apenas** a camada de rede `fetchQuery` dentro de `queryIndexer`.
  Chave `raw1:jackett:<indexer>:<type>:<shapedQuery>`, usando a saída de
  `shapeSearchQuery` ([jackett.js:~60](src/providers/jackett.js)) — que já
  remove `SxxEyy` nos indexers BR, então episódios da mesma temporada
  compartilham entrada por construção.
- **Fora do cache**: a cascata de fallback (decide por relevância com
  `matchContext`) e `resolveCardigannDownloads` (filtra por episódio). Num hit o
  resolve continua rodando, mas cada salto de protetor vira hit no `dlmag:`
  existente ([jackett.js:52](src/providers/jackett.js:52)).
- **Falha nunca é cacheada** — o circuit breaker e o `indexer-status` continuam
  sendo a resposta para indexer fora.
- **Vazio tem TTL próprio** (`RAW_CACHE_EMPTY_TTL`, default 120s): 200 com zero
  itens pode ser rate-limit disfarçado.
- **Teto de itens** `RAW_CACHE_MAX_ITEMS` (default 120): acima disso não cacheia.
- **No hit, não registrar status.** `queryIndexer` devolve a origem do resultado
  e `search()` pula o `indexerStatus.record` quando veio do cache (correção 4).
  O breaker não muda: sem requisição não há falha para contar.
- TTL: `RAW_CACHE_TTL` (default 900s) para os globais e `RAW_CACHE_TTL_BR`
  (default 1800s) para `ptBrIndexers` — são os que custam 20s de orçamento
  raspando WordPress e seguindo protetor, e os que mudam menos.

### 1.2 Scraper direto (`src/providers/bludv.js`)

Chave `raw1:bludv:<query>` no topo de `search()`
([bludv.js:146](src/providers/bludv.js:146)), mesmos TTL/tetos. Falha não
cacheia.

### 1.3 Núcleo (`src/utils/cache.js`)

- `QUOTAS`: `raw1: 800`, `streams` 1500 → 2000; `MAX_ENTRIES` 11000 → **12000**,
  com o comentário existente atualizado para a nova soma (11.500).
- Persistência SQLite mantida como está; vale acompanhar o tamanho do
  `cache.db` depois do deploy (é o mesmo dado no disco).

### 1.4 Testes

- `test/jackett-provider.test.js`: segunda chamada com a mesma shaped query não
  abre fetch; E01 e E02 num indexer BR compartilham entrada; acima de
  `RAW_CACHE_MAX_ITEMS` não cacheia; vazio usa o TTL curto; **hit não registra
  status**.
- `test/cache.test.js`: cota `raw1` despeja só o próprio namespace.

---

## Fase 2 — Stale-While-Revalidate no cache de streams

### 2.1 Núcleo: `cache.getWithStale(key, graceSeconds)`

- `{ value, stale: false }` dentro do TTL; `{ value, stale: true }` entre TTL e
  `expiresAt + grace`; `null` depois. Não chama `forget()` — o `get()` normal
  mantém a semântica dura de hoje ([cache.js:316](src/utils/cache.js:316)).
- `prune()` ([cache.js:273](src/utils/cache.js:273)) e `loadFromDisk()` passam a
  descartar só `expiresAt <= now - graceMax`. Sem isso o timer de 10 min
  ([cache.js:394](src/utils/cache.js:394)) mata o SWR na prática.

### 2.2 Pipeline (`findStreams`)

- Elegibilidade: `partial === false` **e** `debridKnown === true` **e** existe
  stream tocável. Esse último teste é o mesmo do `complete` em `finish` —
  **extrair para uma função nomeada** (ex.: `hasPlayableStream(streams)`) e usar
  nos dois lugares, para os critérios não divergirem (correção 5).
- Hit stale → responde na hora e agenda refresh fire-and-forget:
  - dedupe por mapa `refreshing`, separado do `inFlight` existente
    ([index.js:557](src/providers/index.js:557));
  - revalida antes de rodar: se alguém já reescreveu fresco, desiste;
  - roda dentro de `run(capture(), …)` — mesmo padrão do `runRecheck`
    ([index.js:204](src/providers/index.js:204)), senão `opts()` fora do
    `AsyncLocalStorage` lê os defaults do `.env` e regrava o cache com a config
    errada;
  - erro vira log, nunca afeta a resposta já enviada.
- Config: `STREAM_STALE_GRACE_SECONDS` (default 300; `0` volta ao `cache.get`).

### 2.3 Testes

`test/cache.test.js` (três estados + prune com janela de graça) e um
`test/swr-streams.test.js` novo: entrada completa dentro da graça responde sem
busca síncrona e agenda UM refresh; **entrada só-aviso não entra no caminho
stale**; entrada parcial idem.

---

## Fase 3 — Disponibilidade por hash (só com o gate da Fase 0)

Escopo idêntico ao da v2, que já estava correto:

- chave `davail1:<service>:<accountScope>:<hash>` (a conta entra de propósito:
  na AllDebrid "cacheado" nasce de um upload naquela conta);
- TTLs separados `DEBRID_AVAIL_POS_TTL` (900s) e `DEBRID_AVAIL_NEG_TTL` (120s);
- inserção **no registry** `debrid.checkCached`, não nos adaptadores; `known`
  só é `true` com resposta completa da API;
- `forceFresh: true` obrigatório no `runRecheck` — sem isso o negativo recém-
  gravado responderia "não cacheado" sobre o hash que o autofetch acabou de
  baixar, e o ⚡ nunca voltaria;
- serviços com `cacheCheck: false` não são afetados; quota `davail1: 5000`
  (entrada minúscula — booleano por hash — então a cota alta aqui é barata,
  ao contrário do `raw1`).

---

## Configuração nova

| Variável | Default | Fase |
|---|---|---|
| `RAW_CACHE_TTL` | `900` | 1 |
| `RAW_CACHE_TTL_BR` | `1800` | 1 |
| `RAW_CACHE_EMPTY_TTL` | `120` | 1 |
| `RAW_CACHE_MAX_ITEMS` | `120` | 1 |
| `STREAM_STALE_GRACE_SECONDS` | `300` | 2 |
| `DEBRID_AVAIL_POS_TTL` | `900` | 3 |
| `DEBRID_AVAIL_NEG_TTL` | `120` | 3 |

Todas com `0` = desligado, rollback sem deploy novo.

## Verificação ponta a ponta

1. `npm test` e `npm run smoke` a cada fase.
2. **Fase 1** — com o container no ar, buscar o mesmo título por duas configs
   diferentes e comparar no log o tempo de coleta; conferir
   `cache.hit.raw > 0` no `/metrics.json`. Caso concreto para medir: um
   episódio fraco de série antiga, onde a busca tardia de pack dispara
   `"Nome S03"` — o segundo episódio da mesma temporada deve mostrar o pack sem
   nova varredura.
3. **Fase 1, regressão do status** — derrubar um indexer (ou usar um dos que já
   falham, `rutor`/`tokyotosho`) e confirmar que ele **não** aparece verde no
   card por causa de hit.
4. **Fase 2** — requisição logo após o TTL responde em <50ms e o log mostra o
   refresh de fundo completando; repetir num título cuja lista seja só o aviso e
   confirmar que ele **não** é servido como stale.
5. **Fase 3** — `debrid.check.repeated` cai sem regressão no ciclo
   autofetch/recheck (o ⚡ continua voltando depois do download).
6. Memória: `docker stats` antes e depois da Fase 1; o teto do container é 3 GB
   compartilhado com Jackett e FlareSolverr.

## Riscos aceitos

- **Seeders congelam junto com o bruto.** O gate `packMinSeeders`
  ([config.js](src/config.js)) decide "episódio fraco" lendo esse número, então
  uma release pode cruzar o piso e a decisão só mudar no ciclo seguinte. Na
  janela de 15 min isso é irrelevante — vale uma linha de comentário no ponto de
  inserção, não um mecanismo.
- `cache.db` cresce com o `raw`. Acompanhar após o deploy da Fase 1.

## Fora de escopo

Alterar o shape ou o digest da `streams:v4`; cache negativo de indexer (o
breaker é a resposta); cachear o caminho `/all`; mudanças nos prazos do
invariante 1; dependências novas.

## Entrega

Um commit por fase na `adon-power-movie`, na ordem 0 → 1 → (medir) → 2 →
(gate) → 3.
