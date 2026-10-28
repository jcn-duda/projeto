# Colhedor nativo — contrato (`adom-harvest` no gateway)

Fase 5 da migração TS→Rust. O colhedor deixou de ser um worker do Node: a fila,
o dedupe, o balde horário, a sonda dirigida e o **drain** rodam no `adom-server`,
com as mesmas fontes nativas do `/stream`. O Node ficou com três coisas:
enfileirar, ler o estado e mandar pausar/drenar/limpar.

## Onde roda

```
adom-server (gateway)
  └─ thread "adom-harvest" (std::thread + runtime current_thread)
       └─ loop: pausa → budget → begin → drain → finish → settle → persistência → notify/sleep
            └─ NetworkDrain (uma vez): MetaSources + JackettClient + BLUDV FULL + índice/banco
```

- **Thread própria, não `tokio::spawn`.** O loop é dono exclusivo do
  `HarvestWorker` e do `NetworkDrain`. A porta pronta do crate (`tick_async`) não
  é `Send` (`&dyn TrafficSense` + `&mut dyn HarvestDrainAsync`) e o gateway não a
  usa: o ciclo é `begin`/`finish`. Runtime `current_thread` (`enable_all`).
- O drain é **serial por ciclo** (uma obra por tick). `/harvest/drain` pede N
  ticks ao loop via budget + `oneshot`; o handler axum nunca roda o ciclo.
- `.env` chega ao gateway por `env_file: .env` no compose. Não há servidor novo:
  as rotas montam no **admin do `streams.db`** (`127.0.0.1:8711`, middleware
  `X-Indexer-Test-Token` já existente).

## O lock da fila (curto: begin → drain → finish)

```
lock → begin(&mut queue, &traffic, now)
         ├─ Skip(outcome) → publica o snapshot, encerra o ciclo
         └─ Run { entry, identity }
unlock → drain_one(&entry).await      (metadados + Jackett + BLUDV FULL + régua + gravação)
lock → snapshot do slot → finish → settle → persiste → unlock
```

Uma iteração é `run_iteration` em `serve.rs` (o loop de produção só orça budget,
hora e notify/sleep). O teste injeta um drain com barreira no mesmo corpo.

- **`begin`** roda as guardas (`disabled` → `paused` → `in_flight` → `busy` →
  vazio → teto horário), consome a cabeça, abre o slot em voo
  (`HarvestInflight::begin`) e devolve a `identity` que fecha o ciclo. O lock sai
  antes de qualquer I/O.
- **`drain_one` roda SEM o lock.** A rede pode durar bem mais que os 2 s de
  timeout da ponte Node; `enqueue`/`clear`/`pending` não esperam uma obra
  inteira. Como o slot já está aberto quando o lock é liberado, um pedido da
  MESMA obra **coalesce** (`coalesced`) em vez de virar segunda entrada — é o
  que torna o coalescing in-flight alcançável na prática.
- **`finish`** debita `outcome.queries` no balde, fecha o slot (o `end` só casa a
  identidade da obra) e derruba a flag `in_flight`. Falha do drain fecha o slot
  igual; requeue é do desfecho, não do worker.
- **O snapshot do slot é lido ANTES do `finish`**: `Settlement.intent =
  queue.inflight().pending(&identity)`. A sonda anexada e a FULL remanescente
  saem desse envelope, não de um campo relido depois do `end`.
- **Prioridade** usa `EvidenceSnapshot` (uma leitura nativa por identidade, fora
  do lock). O comparador, o ingresso e o `preview` só vêem essa foto. Sem SQL no
  comparador e sem rede com o lock da fila.
- `GET /harvest` não participa do lock: lê o snapshot de `HarvestStatus`, que o
  loop publica a cada ciclo (skip incluso). `fullIntent` nunca entra no JSON
  público (`#[serde(skip)]` + normalização da ponte).

## Estado (MESMO `data/cache.db` do Node)

O `HarvestStore` usa o schema `cache(key, value, expires_at)` — idêntico ao
`cache-db.ts`. **Zero migração**: o Rust abre o arquivo que o Node já usa.

| chave | conteúdo | TTL |
|---|---|---|
| `harvest:v1:q` | fila serializada (L2 do `HarvestQueue`) | `HARVEST_ENTRY_TTL` (7 d) |
| `harvest:v1:seen:<sha256>` | dedupe 12 h por obra/S/E | 12 h (só grava no **aceite**) |
| `harvest:v1:hour` | `{hour, count}` do balde horário | fim da hora + 60 s |

O namespace `harvest` é **RUST_OWNED** no Node (`RUST_OWNED_PREFIXES` em
`src/utils/cache-keys.ts`): o Node não carrega no L1, não grava no SQLite e não
poda. `clear-cache` não zera o balde horário (seria burlar o teto).

### Lease da sonda (`pending`) e TTL

A sonda grava `autofetch:v3:probe:<sha256(type:imdb:season:episode)>` no MESMO
`cache.db` (`probe_key`, crate `adom-harvest`).

| Regra | Valor | Onde |
|---|---|---|
| Lease do `pending` | `PENDING_LEASE_MS` = **10 min** | `adom-harvest/src/probe.rs:41-43` |
| TTL do registro | `max(BR_PROBE_TTL_S, 10 min)` — o piso é o lease | `probe.rs:149-152` (`write_pending`) |
| Retry de `failed`/`capped` | `RETRY_MS` = **5 min** | `probe.rs:45-46` |
| TTL lido pelo colhedor | `br_probe_ttl_seconds()` = `BR_PROBE_TTL_S` (default `43 200`, clamp) | `harvest/config.rs:88-93` |
| Quem usa | `Settler::new(br_probe_ttl_seconds())` | `harvest/serve.rs:91-93` |

Piso de 10 min não é folga: é o lease. Antes ele só existia no crate de origem;
com `BR_PROBE_TTL_S` menor que o lease o registro nasceria vencido e o
`pending` nunca seria lido. Quem FINALIZA o estado é o colhedor
(`settle.rs` → `BrProbe::finalize`); `probe_step::finish` existe no worker
(ainda com `#[allow(dead_code)]`) e não é o caminho de produção — constante
fixa no loop divergia do `BR_PROBE_TTL_S` que `probe_job.rs:49-50` lê a cada
job, e o `brProbeTtl` do Node lia um prazo diferente do que o gateway escrevia.

## Contrato HTTP (admin 8711)

Token: `X-Indexer-Test-Token` (`STREAM_STORE_ADMIN_TOKEN` → `DEBRID_INTERNAL_TOKEN`
→ `JACKETT_TEST_TOKEN`).
`harvest: None` (desligado ou store indisponível) responde o **mesmo formato**
com `enabled:false` / `disabled` / `0` — o Node não tem caminho especial.

| rota | corpo | resposta |
|---|---|---|
| `GET /harvest` | — | `{ok, enabled, paused, intervalMs, maxPerHour, idleWindowMs, queueMax, queriesThisHour, depth, inflight, preview[], last[], counters{drained,failed}, store}` |
| `POST /harvest/enqueue` | `{imdbId, type, season?, episode?, reason, brProbe?}` | `{ok, accepted, reason}` (`reason` do `EnqueueReason`: `queued`, `promoted`, `coalesced`, `duplicate`, `dedupe`, `disabled`, `invalid`) |
| `POST /harvest/pause` | `{paused}` | `{ok, paused}` |
| `POST /harvest/config` | overrides do painel (o objeto de `cfg:v1:harvester`; `{}` = `.env`) | `{ok, applied, enabled, paused, intervalMs, maxPerHour, idleWindowMs, queueMax}` |
| `POST /harvest/drain` | `{max}` | `{ok, drained}` — **serial**: segundo clique concorrente devolve `0`; timeout do pedido 600 s; a primeira falha encerra o budget |
| `POST /harvest/clear` | vazio ou `{}` | `{ok, cleared}` |
| `GET /harvest/pending?imdbId=` | — | `{ok, queued, brProbe}`; `400` sem IMDb válido |

**Config ao vivo.** O `.env` do gateway decide se a thread existe
(`HARVEST_ENABLED=false` não sobe nada); o painel ajusta o colhedor de pé:
`harvestEnabled`, `harvestMaxPerHour`, `harvestIntervalMs`,
`harvestIdleWindowMs`, `harvestQueueMax`, `harvestDrainMaxWorks`,
`harvestIndexerDelayMs`, `harvestEntryTtl`, `harvestBrFirst`,
`harvestBrMaxWaitMs` e `paused` (`seed*` é do Node). O Node grava o overlay em
`cfg:v1:harvester` (fonte do boot do gateway, `harvest/live.rs`) e o empurra
por `POST /harvest/config`; sem ponte, o painel recebe `nativeApplied:false` e
o ajuste vale no próximo restart. Teto de fila menor não corta a fila atual.

`preview[]`/`last[]` usam camelCase (`imdbId`, `mediaType`→`type`, `queries`,
`at`) — o espelho TS é `NativeHarvestEntry`/`NativeHarvestLast` em
`src/utils/harvest-native.ts`.

## Drain (fontes reais)

1. **Metadados**: `MetaSources::lookup` (prazo 4 s) → `meta_from_lookup`, a
   mesma montagem de `query`/`pt_query`/`original_query` do orquestrador.
2. **Jackett**: um indexer por vez (`HARVEST_INDEXER_DELAY_MS`, default
   1 500 ms); lista vazia ⇒ ramo agregado `/all`. Indexer *index-only* usa
   `JACKETT_INDEX_ONLY_HARVEST_TIMEOUT_MS`. `record_status:false` (colheita não
   pinta o card de status). Contagem = alvos Jackett tentados, não hops HTTP
   internos nem BLUDV.
3. **Sonda dirigida**: `entry.br_probe` troca a lista inteira pelo subset de
   `BrProbe::probe_indexers()` — a MESMA interseção do crate (index-only ∩ pt-BR
   − isentos da busca viva), na ordem de `index_only`. Os isentos vêm de
   `JACKETT_LIVE_EXEMPT_INDEXERS` (default `apachetorrent-cardigann`), lidos em
   `drain_shape.rs`; não existe segunda lista no drain. Interseção vazia não vira
   `/all`: a sonda não tem alvo e devolve `failed` com 0 consultas. Sonda **não**
   consulta BLUDV.
4. **BLUDV (só FULL)**: depois do Jackett, com `BLUDV_ENABLED` e
   `BludvSearchOpts { dubbed_only: false }`. Query PT não vazia; senão a EN.
   Não debita o contador Jackett e **nunca certifica** completude. Kill-switch,
   prazo e SSRF (`allow_private_url`) são os do cliente. Sem resposta Jackett
   válida, BLUDV aproveitável grava suplemento e o drain continua falho.
5. **Régua**: `filter_relevant_raw` com os campos do build do orquestrador
   (`pre_home_release_cut`, margem, `title_precision_tail_cut`).
6. **Gravação suplementar**: `release.supplemental = entry.br_probe ||
   !jackett_complete`. `jackett_complete` só com ≥1 alvo planejado e todos
   respondidos. Chave nova suplementar nasce parcial; chave existente preserva
   `partial`. FULL com todos os alvos Jackett ok é escrita normal. Lote vazio
   não apaga nem limpa parcialidade.
7. **Found e invalidação**: ler o índice antes e depois da escrita confirmada.
   Found exige hash novo (case-insensitive), BR dublado, não `lied`, não
   `source=autofetch`, seeds > 0; se já havia BR dublado, qualidade exata
   `1080p`. Transição BR/upgrade invalida só os streams da obra no store
   compartilhado. Falha de escrita não produz Found; falha de invalidação não
   apaga a prova e fica pendente para retry local.

Sem índice nativo o drain falha com 0 consultas (não anuncia sucesso
descartado). Sem metadados nativos ou sem Jackett configurado a obra falha.

## Corte do teto (`truncated` → `capped`)

`DrainOutcome` carrega `truncated: bool` ao lado de `ok`/`queries`
(`adom-harvest/src/worker_types.rs:64-96`, construtor `with_truncated`): `true`
significa que o teto horário cortou alvos **planejados** — a passada não
consultou tudo o que a régua pediu.

- `drain.rs:309-313` calcula `truncated = batch.remaining_targets > 0` sobre
  `SourceBatch` (`drain_sources.rs:29-33`: `attempted`/`answered`/
  `remaining_targets`); `jackett_complete = !truncated &&
  jackett_targets_complete(...)`, então corte também marca o registro como
  parcial.
- `harvest/serve.rs:223-229` monta `Settlement { ..., capped: outcome.truncated }`.
- `settle.rs:99-107` finaliza o registro da sonda na ordem
  `found` > `capped` > `empty` > `failed`.

| Desfecho | Estado final | Por quê |
|---|---|---|
| `br_found` | `found` | achado é prova |
| `capped` (teto cortou alvo) | `capped` | ausência NÃO foi provada |
| `ok` (todos os alvos respondidos) | `empty` | ausência provada |
| falha sem corte | `failed` | a falha segue visível em `last`/contadores |

**Nunca `empty` depois de corte.** `empty` diz "já procurei, não existe" e é
lido como prova por até 12 h: gravar isso depois de um teto que cortou alvos
escondia a obra por 12 h. `capped` e `failed` usam `RETRY_MS` (5 min) e liberam
os seeds, mantendo a obra elegível. O contrato está coberto por
`harvest/capped_tests.rs`.

## Desfecho (`settle`) e FULL ↔ sonda

`Settlement { intent, ok, br_found, capped }` captura o slot **antes** do
`finish`; `capped` é o `DrainOutcome::truncated` daquela obra (ver a seção
anterior).

| Execução | Resultado | Retorno |
|---|---|---|
| FULL | sucesso | nenhum; absorveu a mesma identidade |
| Sonda sem FULL | sucesso | nenhum |
| Sonda com FULL | sucesso | exatamente uma FULL (`br_probe` limpo) |
| FULL (com ou sem sonda anexada) | falha 1–3 | uma FULL, motivo efetivo promovido |
| Sonda sem FULL | falha 1–3 | uma sonda |
| Sonda com FULL | falha 1–3 | uma FULL, motivo FULL preservado |
| Qualquer modo | 4ª falha | descarte explícito (loga quatro, não três) |

- Sucesso zera o contador, inclusive quando deixa FULL remanescente.
- Retorno usa `tail` (sem ingresso público nem dedupe). A sonda anexada a um
  FULL termina, mas o retry não vira sonda.
- Identidade da fila: IMDb + S/E. Dedupe 12 h continua por obra+motivo.
- `save_to`/`replace` não truncam o snapshot aceito. Ingresso novo distinto
  aplica o teto (BR-first = cauda priorizada; senão o mais antigo por
  `enqueued_at`). Reduzir o teto por config não corta a fila atual.

Estado final da sonda (só quando `entry.br_probe` ou o intent é sonda): ordem
`found` > `capped` > `empty` > `failed`, decidida em `settle.rs:92-107` e
gravada com `finalize`. `capped` vence `failed` porque a falha de fonte já
aparece no `last`/contadores do status — o que o registro precisa dizer é que o
plano ficou incompleto.

A chave do contador é `entry_identity`. Falha interrompe o budget do
`POST /harvest/drain`. O contador de tentativas é **volátil** (memória): restart
depois do save reconstrói a fila, não o número de falhas.

## Configuração (`.env`)

`HARVEST_ENABLED` (true) · `HARVEST_INTERVAL_MS` (60 s) · `HARVEST_IDLE_WINDOW_MS`
(10 min) · `HARVEST_MAX_HOUR` (teto de consultas/h) · `HARVEST_QUEUE_MAX` ·
`HARVEST_QUEUE_PREVIEW` · `HARVEST_DRAIN_MAX_WORKS` · `HARVEST_INDEXER_DELAY_MS` ·
`HARVEST_ENTRY_TTL` · `HARVEST_BR_FIRST` · `HARVEST_BR_MAX_WAIT_MS` ·
`JACKETT_INDEX_ONLY_HARVEST_TIMEOUT_MS`.

`JACKETT_LIVE_EXEMPT_INDEXERS` (default `apachetorrent-cardigann`) define os
isentos retirados do subset da sonda; é lida em `drain_shape.rs`, fora do
`HarvestConfig`.

Régua final dos dois knobs (o oráculo é `src/config/jackett.ts:146` +
`src/config/helpers.ts:12-18`): `JACKETT_INDEX_ONLY_INDEXERS` é `env || default`
— ausente/`""` → **default**, e `"   "` (só espaços) é TRUTHY no Node, logo
**lista VAZIA** (nunca o default). `JACKETT_LIVE_EXEMPT_INDEXERS` é `??` —
ausente → default, `""`/`"   "` → kill-switch (lista vazia). As três portas Rust
são `drain_shape.rs:37-61`, `adom-search/src/orchestrator/jackett_collector_env.rs:25-40`
e `stream_config.rs:192`; o teste de paridade entre as duas primeiras vive em
`drain_shape.rs` (`regua_das_envs_igual_ao_adom_search`).

`BR_PROBE_TTL_S` (default `43 200` s) é o TTL do registro da sonda, lido pelos
dois lados: `probe_job.rs:49-50` no worker e `br_probe_ttl_seconds()` no
colhedor. O `pending` nunca nasce com prazo menor que o lease de 10 min.

`CACHE_PERSIST=false` põe o raw do BLUDV em memória, mas a fila do colhedor
continua no `CACHE_DB_PATH` — desligar o colhedor é `HARVEST_ENABLED=false`.

## Ponte no Node (`src/utils/harvest-native.ts`)

Best-effort, igual ao `streams-store-native`: timeout, backoff após 2 falhas,
nenhuma chamada derruba busca/play/boot.

- `enqueueNativeHarvest` — fire-and-forget, chamada pelos efeitos da busca
  (`/internal/search/effects`); `brProbe:true` é propagado.
- `pendingNativeHarvest` — `findQueued` do `br-probe`. `null` (ponte caída) é
  "não sei", **não** "não está na fila": o `pending` fica como está.
- `refreshHarvestStatus` + `startHarvestPolling` (30 s, `unref`) mantêm o
  espelho síncrono que o bloco do painel lê; `harvestStatusSnapshot` nunca espera
  rede.
- `pauseNativeHarvest` / `drainNativeHarvest` / `clearNativeHarvest` — ações do
  painel. `refreshLanded` distingue "gateway não respondeu" de "0 de verdade".

`/test-indexer.json` responde **410**: não existe mais busca de teste no Node.

## Mapa de arquivos

Gateway — `rust/crates/adom-server/src/harvest/`:

| arquivo | papel |
|---|---|
| `mod.rs` | `Inner`, `spawn` da thread; métodos administrativos em `handle.rs` |
| `serve.rs` | ciclo: pausa → budget → `run_iteration` → hora → notify/sleep |
| `drain.rs` | `NetworkDrain`: metadados → Jackett → BLUDV FULL → régua → índice |
| `drain_sources.rs` | consultas e merge; BLUDV não decide matching nem certifica |
| `drain_record.rs` | filtro → escrita → delta Found → invalidação da obra |
| `drain_shape.rs` | conversões puras: isentos, `MetaQuery`, `RelevanceItem`, `jackett_complete` |
| `evidence.rs` | `EvidenceSnapshot` para prioridade/preview/evicção |
| `settle.rs` | `Settler`/`Settlement`: FULL remanescente, 3 reinserções, 4ª falha, `capped` |
| `enqueue.rs` | enqueue com dedupe 12 h (só grava `seen` no aceite) |
| `routes.rs` | rotas administrativas no `store_admin` |
| `status.rs` | snapshot `HarvestStatus`/`HarvestCounters` (não segura o lock da fila) |
| `traffic.rs` | `StreamTraffic`: janela de idle do `/stream` (`TrafficSense`) |
| `config.rs` | `HarvestConfig::from_env` (mesmos nomes/defaults do TS) |
| `loop_tests.rs` | uma iteração com barreira; restart após save; dedupe; TTL; balde |
| `network_tests.rs` | `NetworkDrain` real contra stubs locais |
| `worker_tests.rs` | tick/teto/enqueue sem rede |
| `settle_tests.rs` | desfecho, sem rede |
| `capped_tests.rs` | teto que corta alvo grava `capped`; todos respondidos grava `empty` |

Crate — `rust/crates/adom-harvest/src/`:

| arquivo | papel |
|---|---|
| `worker.rs` | `HarvestWorker`: guardas, `begin`/`finish`, `tick`/`tick_async`, `TickStart` |
| `inflight.rs` | `HarvestInflight`: slot único, coalescing, `PendingIntent` |
| `queue.rs` | `HarvestQueue`: FIFO, promoção, `take_next(busy)`, L2 |
| `probe.rs` | `BrProbe`: estados, lease, `request`, `finalize`, `probe_indexers` |
| `store.rs` / `hour.rs` / `seen.rs` | L2 `harvest:v1:q`, balde horário, dedupe 12 h |
| `worker_tests.rs` | `begin`/`finish` com coalescing durante a rede; skip não abre slot |

## Testes

Os que fixam este contrato no gateway (`cargo test -p adom-server harvest::`):

- `loop_tests.rs`: barreira/oneshot no mesmo `run_iteration`; coalescing da
  mesma identidade e permanência da outra; restart lê a fila persistida
  (não é recuperação de crash no meio da rede); dedupe 12 h; TTL da fila;
  balde da mesma hora e virada.
- `network_tests.rs`: `NetworkDrain` real contra metadados/Jackett/BLUDV
  locais — alvos, índice, parcialidade, retry e invalidação da obra.
- `settle_intent_tests.rs` / `settle_tests.rs`: FULL ↔ sonda, 4ª falha, reset.
- `capped_tests.rs`: `DrainOutcome::truncated` → `capped` (e `empty` só com
  todos os alvos respondidos).
- Ponte Node (`test/harvest-native.test.ts`, `test/harvester-panel.test.ts`):
  config sem restart, pausa, `nativeApplied:false` quando a ponte cai, reset
  para defaults, pending e preview sem `fullIntent`.

A thread de produção e as rotas HTTP ainda exigem gateway de pé.

## O que não fazer

- **Não** rodar o ciclo num handler axum nem trocar a thread por `tokio::spawn`.
- **Não** segurar o lock da fila durante a rede: volta o bloqueio da ponte
  (timeout de 2 s) e o coalescing in-flight deixa de acontecer.
- **Não** deixar o `finish` fora do caminho de erro: slot preso vira
  `SkippedInFlight` para sempre.
- **Não** duplicar a lista da sonda: o subset é `BrProbe::probe_indexers()`.
- **Não** reintroduzir consumidor da fila no Node: dois drenos disputam o mesmo
  item e o dedupe de 12 h passa a mentir.
- **Não** zerar `harvest:v1:hour` no `clear` (burla o teto) nem no boot.
- **Não** gravar `seen` antes do aceite (um `duplicate`/`coalesced` bloquearia a obra
  por 12 h sem trabalho).
- **Não** trocar `record_status` para `true`: colheita não é busca de usuário.

## Rollback

Commit/imagem anterior. Não existe `HARVEST_OWNER=node` — o corpo TS
(`jackett*.ts`, `search-plan.ts`, `bludv.ts`, `harvest-*`, `harvester*`) foi
apagado junto com a virada. `HARVEST_ENABLED=false` desliga o worker sem mexer
nas fontes nativas do `/stream`.

A fila é lida direto do `cache.db`; não há "consumidor antigo parado" a negociar
porque o corpo TS saiu na mesma virada.

## Limites (não cobertos — 5H)

Config ao vivo (`POST /harvest/config` + overlay `cfg:v1:harvester`) **já
chega** ao worker/fila/drain no próximo ciclo; `nativeApplied:false` só quando
a ponte falha. Seed continua no Node.

O recorte 5A–5G **não** cobre:

- crash no meio do drain (inflight não é durável; não há exactly-once);
- journal/transação única entre fila, índice, sonda e balde;
- fencing de invalidação contra um commit SWR concorrente;
- preempção de uma obra já em execução;
- teto horário rígido entre cada consulta Jackett (as guardas operam no
  início do tick);
- reparo automático de SQLite corrompido.

Restart depois de `settle`+`save` reconstrói a fila persistida, o dedupe e o
balde da hora corrente. Isso não é recuperação de crash em voo. Tentativas
(`Settler::attempts`) continuam voláteis.
