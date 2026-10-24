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
            └─ NetworkDrain (uma vez): MetaSources + JackettClient + índice/banco
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
unlock → drain_one(&entry).await      (metadados + Jackett + régua + gravação)
lock → is_probe efetivo → finish(&mut queue, &identity, outcome, now)
     → status/settle → publica → persiste → unlock
```

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
- **`is_probe` é lido ANTES do `finish`**:
  `entry.br_probe || queue.inflight().pending(&identity).is_some_and(|i| i.br_probe)`.
  É a intenção efetiva do slot, equivalente ao `isProbe = entry.brProbe ||
  intent?.brProbe` do TS. Sem isso, a sonda que coalesceu em voo numa execução
  completa nunca finalizaria e o `pending` duraria até o lease vencer.
- `GET /harvest` não participa do lock: lê o snapshot de `HarvestStatus`, que o
  loop publica a cada ciclo (skip incluso).

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

## Drain (as mesmas réguas do `/stream`)

1. **Metadados**: `MetaSources::lookup` (prazo 4 s) → `meta_from_lookup`, a
   mesma montagem de `query`/`pt_query`/`original_query` do orquestrador.
2. **Consultas**: um indexer por vez (`HARVEST_INDEXER_DELAY_MS`, default
   1 500 ms); lista vazia ⇒ ramo agregado `/all`. Indexer *index-only* usa
   `JACKETT_INDEX_ONLY_HARVEST_TIMEOUT_MS`. `record_status:false` (colheita não
   pinta o card de status).
3. **Sonda dirigida**: `entry.br_probe` troca a lista inteira pelo subset de
   `BrProbe::probe_indexers()` — a MESMA interseção do crate (index-only ∩ pt-BR
   − isentos da busca viva), na ordem de `index_only`. Os isentos vêm de
   `JACKETT_LIVE_EXEMPT_INDEXERS` (default `apachetorrent-cardigann`), lidos em
   `drain_shape.rs`; não existe segunda lista no drain. Interseção vazia não vira
   `/all`: a sonda não tem alvo e devolve `failed` com 0 consultas.
4. **Régua**: `filter_relevant_raw` com os campos do build do orquestrador
   (`pre_home_release_cut`, margem, `title_precision_tail_cut`).
5. **Gravação**: `harvest_support::{release_entry_for, record_release}` →
   `ReleaseIndexSource::record` (índice nativo `idx:v14`).
6. **Contabilidade**: `responded == 0` ⇒ `{ok:false, queries: attempted}` — a
   cota é debitada mesmo sem resposta, senão o teto horário não segura indexer
   morto. `items` vazio ⇒ `ok` com 0 gravações (nunca apaga o que o `/stream` já
   provou). Gravação quebrada ⇒ `{ok:false, queries: attempted}`.
7. **Evidência BR**: `last_found` = existe survivor `is_br` com `seeders > 0`
   nesta passada. O loop lê com `take_found()` e entrega ao desfecho.

Sem índice nativo o drain não gasta cota (`ok`, 0 consultas, loga uma vez). Sem
metadados nativos ou sem Jackett configurado a obra falha.

## Desfecho (`settle`)

`Settlement { is_probe, ok, br_found }` — struct para o `settle` caber no clippy
de 7 argumentos — resume o que o drain provou sobre a obra.

- **Sucesso** (`ok`): a obra sai da fila e o contador de tentativas é zerado. Se
  havia sonda, grava `Found` quando `br_found`, senão `Empty`.
- **Falha**: `tries += 1`; com `tries <= 3` (`MAX_ATTEMPTS`) a obra volta ao FIM
  da fila (`queue.tail`), acima disso sai da fila (loga). Se havia sonda, grava
  `Failed` — ou `Found`, porque `br_found` vence `ok` (a passada provou valor
  mesmo cortada).
- **Sem sonda** (`is_probe == false`): nenhum estado é gravado — colheita
  completa não inventa `Found`/`Empty`.
- O requeue existe porque, sem ele, a obra desapareceria com o `seen` de 12 h
  já gravado no aceite e a próxima busca só receberia `dedupe`.

A chave do contador é `entry_identity` (obra/S/E). Falha também interrompe o
budget do `POST /harvest/drain` (o loop dá `break`): insistir na mesma obra com
a fonte fora martela o Jackett.

## Configuração (`.env`)

`HARVEST_ENABLED` (true) · `HARVEST_INTERVAL_MS` (60 s) · `HARVEST_IDLE_WINDOW_MS`
(10 min) · `HARVEST_MAX_HOUR` (teto de consultas/h) · `HARVEST_QUEUE_MAX` ·
`HARVEST_QUEUE_PREVIEW` · `HARVEST_DRAIN_MAX_WORKS` · `HARVEST_INDEXER_DELAY_MS` ·
`HARVEST_ENTRY_TTL` · `HARVEST_BR_FIRST` · `HARVEST_BR_MAX_WAIT_MS` ·
`JACKETT_INDEX_ONLY_HARVEST_TIMEOUT_MS`.

`JACKETT_LIVE_EXEMPT_INDEXERS` (default `apachetorrent-cardigann`) define os
isentos retirados do subset da sonda; é lida em `drain_shape.rs`, fora do
`HarvestConfig`.

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
| `mod.rs` | `Inner`, `HarvestHandle` (enqueue/clear/pause/drain/pending) e `spawn` da thread |
| `serve.rs` | ciclo: pausa → budget → `begin` → `drain_one` sem lock → `is_probe` → `finish` → status/settle → persistência → notify/sleep |
| `drain.rs` | `NetworkDrain` (`HarvestDrainAsync`): metadados → Jackett → régua → índice; subset da sonda por `BrProbe::probe_indexers` |
| `drain_shape.rs` | conversões puras: `JACKETT_LIVE_EXEMPT_INDEXERS`, `MetaQuery` (`entry_meta_query`), `RelevanceItem` (`relevance_items`) |
| `settle.rs` | `Settler`/`Settlement`: requeue até `MAX_ATTEMPTS`, finalização da sonda, reset no sucesso |
| `enqueue.rs` | enqueue com dedupe 12 h (só grava `seen` no aceite) |
| `routes.rs` | rotas administrativas no `store_admin` |
| `status.rs` | snapshot `HarvestStatus`/`HarvestCounters` (não segura o lock da fila) |
| `traffic.rs` | `StreamTraffic`: janela de idle do `/stream` (`TrafficSense`) |
| `config.rs` | `HarvestConfig::from_env` (mesmos nomes/defaults do TS) |
| `worker_tests.rs` | testes do gateway: tick, teto, enqueue/dedupe, parser da rota |
| `settle_tests.rs` | testes do desfecho, sem rede |

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

72 testes em `adom-harvest` e 67 em `adom-server`. Os que fixam este contrato:

- `settle_tests.rs`: sucesso, `found`, `empty`, falha até o teto, reset do
  contador e sonda coalescida (entrada completa + `is_probe` efetivo).
- `adom-harvest::worker_tests`: `begin` abre o slot antes da rede (enqueue da
  mesma obra coalesce) e `finish` fecha depois; skip não consome nem abre slot.
- `adom-server::harvest::worker_tests`: tick/teto sem rede, enqueue + dedupe e o
  parser do corpo da rota.

`NetworkDrain` (Jackett/metadados reais), a thread do ciclo e as rotas HTTP
exigem gateway e indexer de pé.

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

## Dívidas declaradas

- O drain cobre **Jackett**; o coletor **BLUDV** nativo não entra na colheita.
- **Intenção FULL perdida quando a sonda vence**: `full_base` (entrada FULL que
  ganhou `br_probe` na fila) e `PendingIntent::full` (pedido FULL que coalesceu
  num run dirigido) são gravados, mas nenhum consumidor os lê. Nos dois casos o
  drain roda só o subset e, no sucesso, a obra sai da fila/slot sem varredura
  completa. A direção contrária — sonda coalescendo num run FULL — está coberta
  pelo `is_probe` efetivo.
- O overlay `cfg:v1:harvester` não chega ao Rust: os knobs `harvest*` do painel
  (`harvestMaxPerHour`, `harvestIntervalMs`, …) não têm consumidor no worker
  nativo, que lê só `.env`. Os campos de seed seguem valendo no Node.
- O teto de tentativas é volátil: `Settler::attempts` mora em memória, então um
  restart zera as 3 falhas e a obra volta a ser tentada.
