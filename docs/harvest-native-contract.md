# Colhedor nativo — contrato (`adom-harvest` no gateway)

Fase 5 da migração TS→Rust. O colhedor deixou de ser um worker do Node: a fila,
o dedupe, o balde horário, a sonda dirigida e o **drain** rodam no `adom-server`,
com as mesmas fontes nativas do `/stream`. O Node ficou com três coisas:
enfileirar, ler o estado e mandar pausar/drenar/limpar.

## Onde roda

```
adom-server (gateway)
  └─ thread "adom-harvest" (std::thread + runtime current_thread)
       └─ loop: pausa → budget → tick_async → persistência → notify/sleep
            └─ NetworkDrain (uma vez): MetaSources + JackettClient + índice/banco
```

- **Thread própria, não `tokio::spawn`.** `HarvestWorker::tick_async` segura
  `&dyn TrafficSense` e `&mut dyn HarvestDrainAsync`: a future **não é `Send`**.
  O runtime é `current_thread` (`enable_all`).
- O drain é **serial por ciclo** (uma obra por tick). `/harvest/drain` pede N
  ticks ao loop via budget + `oneshot`; o handler axum nunca roda `tick_async`.
- `.env` chega ao gateway por `env_file: .env` no compose. Não há servidor novo:
  as rotas montam no **admin do `streams.db`** (`127.0.0.1:8711`, middleware
  `X-Indexer-Test-Token` já existente).

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

Token: `X-Indexer-Test-Token` (`STREAM_STORE_ADMIN_TOKEN` → `DEBRID_INTERNAL_TOKEN`).
`harvest: None` (desligado ou store indisponível) responde o **mesmo formato**
com `enabled:false` / `disabled` / `0` — o Node não tem caminho especial.

| rota | corpo | resposta |
|---|---|---|
| `GET /harvest` | — | `{ok, enabled, paused, intervalMs, maxPerHour, queriesThisHour, depth, inflight, preview[], last[], counters{drained,failed}, store}` |
| `POST /harvest/enqueue` | `{imdbId, type, season?, episode?, reason, brProbe?}` | `{ok, accepted, reason}` (`reason` do `EnqueueReason`: `queued`, `promoted`, `coalesced`, `duplicate`, `dedupe`, `disabled`, `invalid`) |
| `POST /harvest/pause` | `{paused}` | `{ok, paused}` |
| `POST /harvest/drain` | `{max}` | `{ok, drained}` — **serial**: segundo clique concorrente devolve `0`; timeout do pedido 600 s |
| `POST /harvest/clear` | vazio ou `{}` | `{ok, cleared}` |
| `GET /harvest/pending?imdbId=` | — | `{ok, queued, brProbe}`; `400` sem IMDb válido |

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
3. **Régua**: `filter_relevant_raw` com os campos do build do orquestrador
   (`pre_home_release_cut`, margem, `title_precision_tail_cut`).
4. **Gravação**: `harvest_support::{release_entry_for, record_release}` →
   `ReleaseIndexSource::record` (índice nativo `idx:v14`).
5. **Contabilidade**: `responded == 0` ⇒ `failed`; `items` vazio ⇒ `ok` com 0
   gravações (nunca apaga o que o `/stream` já provou); gravação quebrada ⇒
   `failed` **com** as consultas debitadas.

Sem índice nativo o drain não gasta cota (`ok`, 0 consultas, loga uma vez). Sem
Jackett configurado a obra falha.

## Configuração (`.env`)

`HARVEST_ENABLED` (true) · `HARVEST_INTERVAL_MS` (60 s) · `HARVEST_IDLE_WINDOW_MS`
(10 min) · `HARVEST_MAX_HOUR` (teto de consultas/h) · `HARVEST_QUEUE_MAX` ·
`HARVEST_QUEUE_PREVIEW` · `HARVEST_DRAIN_MAX_WORKS` · `HARVEST_INDEXER_DELAY_MS` ·
`HARVEST_ENTRY_TTL` · `HARVEST_BR_FIRST` · `HARVEST_BR_MAX_WAIT_MS` ·
`JACKETT_INDEX_ONLY_HARVEST_TIMEOUT_MS`.

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

## O que não fazer

- **Não** rodar `tick_async` num handler axum (future `!Send`) nem trocar a
  thread por `tokio::spawn`.
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

## Dívidas declaradas

- O drain cobre **Jackett**; o coletor **BLUDV** nativo não entra na colheita.
- O tick segura `&mut HarvestQueue` durante todo o drain: com uma obra em voo,
  `enqueue`/`clear`/`pending` esperam o fim (sem travar thread, o mutex é do
  tokio). Consequência: o coalescing in-flight fica praticamente inalcançável
  pelo enqueue — o slot fecha antes de o lock liberar. `GET /harvest` não espera
  (lê o snapshot).
- O overlay `cfg:v1:harvester` do Node não chega ao Rust (o painel lê o estado
  nativo; o overlay antigo ficou sem consumidor).
- A fila é transferida por leitura direta do `cache.db`; não há "consumidor
  antigo parado" a negociar porque o corpo TS saiu na mesma virada.
