# Checagem de cache da AllDebrid no Rust (`DEBRID_AL_RUST`)

Status: **opt-in, default OFF**. A rota Node `/internal/debrid/check` continua
sendo a que responde em produção; o corte F4.6 (remover a rota) **não** foi
feito. Este documento registra o contrato mapeado, o que o `adom-debrid` cobre,
o que ficou fora e como validar quando a conta AllDebrid sair de
`MAGNET_TOO_MANY`.

## 1. Contrato do Node

Caminho real da busca (`cache-check.checkCached` → adaptador
`alldebrid-check.checkCached`):

| Ponto | Node | Rust (`alldebrid_check.rs`) |
|---|---|---|
| Consulta | `/magnet/upload` com `magnets[]` (não há `/magnet/instant`) | idem, por lote |
| Lote | `DEBRID_BATCH_SIZE` (default **25**), lotes **em paralelo** | default 25, env; `JoinSet` (paralelo) |
| Teto | rota `/internal/debrid/check` recusa > **500** hashes | 500 primeiros enviados; excedente ⇒ `complete:false` (não é "frio") |
| Timeout | `DEBRID_CACHE_CHECK_TIMEOUT_MS` (default **10000**) por lote, mesmo teto | idem, env; lote estourado ⇒ `complete:false` com o hit parcial preservado |
| `cached` | `magnet.ready === true` (hash lower-case) | idem |
| `known` | `complete = failures === 0` (lotes) | idem; `known:false` nunca vira "nada em cache" |
| `unusable` | auth (`AUTH_*`, 401/403) e quota (`MAGNET_TOO_MANY*`) | mesmas réguas no `unwrap_payload`/`from_http`; rate limit **não** é unusable |
| Falha de lote | `allSettled`; todos falharam ⇒ auth/quota/rate do conjunto, senão "nenhum lote" | idem (agora inclui rate limit com `retry_after`) |
| Limpeza | remove prontos (`dropReady`) e frios (`dropUncached`), com hold/`knownBefore`/inventário | **portada** (`alldebrid_cleanup`/`alldebrid_delete`), atrás de `DEBRID_AL_CLEANUP` (default OFF). Só executa com `holdsComplete` + inventário; sem isso é read-only. Ver §8 |
| Falha da limpeza | só loga; não muda o veredito | idem (fila em fundo, não segura a resposta) |
| Nota por hash | `/magnet/status` só para `fileHashes` (fsz/resolução) | **fora** (ver §4) |
| Chave | `Authorization: Bearer` (nunca na URL/log) | idem; hashes vão na query, chave só no header |

O `debrid_seam` / `FrozenDebridCheck` consomem apenas
`{cached, known, unusable}`. `answer_of` já preserva ⚡ de hit parcial
(`known:false` com `cached` não vazio) e transforma o resto em `Unknown`
(nunca `Missing`).

## 2. Caminho nativo

- `adom-debrid::verdict::check_service_report` devolve `ServiceCheck
  { outcome, attempted }`. `attempted:false` significa que **nenhum** upload
  saiu (base recusada, lista vazia, sem chave).
- `adom-search::debrid_seam::AdapterDebridCheck` lê `DEBRID_AL_RUST` no
  `AdapterDebridFactory`:
  - `off` (default): comportamento anterior — reserva Node quando há
    `encoded`+`deadline`; sem reserva, checagem local.
  - `on`: nativa responde. Fallback Node **só** se `attempted:false` e
    `known:false`; depois de um upload real a resposta é `Unknown` (segundo
    upload dobraria o lixo na conta).
  - `shadow`: a nativa responde (lado vivo) e o Node entra como REFERÊNCIA
    numa thread própria, DEPOIS da resposta, comparando `cached`/`known`
    (`debrid.al.shadow.*`). O cliente não espera a comparação. Só tem efeito
    no caminho nativo do `/stream`; a sombra §9.1 (`stream-shadow`) usa
    `NoDebridFactory` e não checa debrid.
- A rota HTTP `/debrid/check` do sidecar responde a AllDebrid **apenas** com
  `DEBRID_AL_RUST=on`; `shadow` mantém 501 (é modo de observação do
  `adom-search`, não de corte). Sem chave responde `200` com
  `{known:false, complete:false}`.

## 3. Flags e rollback

| Env | Default | Efeito |
|---|---|---|
| `DEBRID_AL_RUST` | vazio/`off` | `off` = Node; `on` = nativa; `shadow` = nativa + comparação com o Node |
| `DEBRID_AL_SHADOW_PERCENT` | `100` | amostra determinística (FNV-1a do conjunto de hashes) |
| `DEBRID_AL_SHADOW_TIMEOUT_MS` | `5000` | prazo próprio da sombra |
| `DEBRID_AL_SHADOW_MAX_HASHES` | `50` (clamp 1..500) | teto de hashes reenviados pela sombra |
| `DEBRID_BATCH_SIZE` | `25` | lote da checagem (já existia no Node) |
| `DEBRID_CACHE_CHECK_TIMEOUT_MS` | `10000` | teto por lote |
| `DEBRID_AL_CLEANUP` | vazio/`off` | `on` habilita o plano de limpeza; sem os fatos (§8) a nativa segue read-only |
| `DEBRID_AL_CLEANUP_KILL` | vazio | `on/1/true/yes` suprime plano e fila (kill-switch de uma linha) |
| `DEBRID_AL_CLEANUP_BACKOFF_MS` | `400,800,1600` | espera por tentativa na fila de delete |
| `DEBRID_AL_CLEANUP_CONCURRENCY` | `4` | workers por execução de delete (1..8) |
| `ALLDEBRID_PREEXISTING_TTL_MS` | `300000` | TTL do snapshot `knownBefore` próprio; `0` desliga (fail-safe) |
| `CACHE_DB_PATH` | `data/cache.db` | leitura read-only de `adprot`/`adsub` |

Rollback: `DEBRID_AL_RUST=off` (ou remover a linha). Nada mais muda no caminho
Node; a rota `/internal/debrid/check` do Node não foi tocada.

## 4. O que ficou fora (bloqueia o F4.6)

1. **Feed de holds (volátil)**: a limpeza segura está portada (§8), mas o hold
   do autofetch em voo mora na memória do processo Node. O Rust não o enxerga:
   por isso a execução exige `holdsComplete` (o chamador prova que `heldHashes`
   cobre o lote) e, **sem esse fato, a nativa é read-only mesmo com a flag ON**.
   O `adom-search` in-process não tem como preenchê-lo; a rota 8710 aceita os
   fatos no corpo, mas o `rust-remote.ts` atual não os envia. Contrato exato em
   §8.4.
2. **`fileHashes`/`fsz`**: o Node lê `/magnet/status` dos packs prontos
   (`packFilesPerCheck`, `fileWaitTimeoutMs`) e grava a prova de
   arquivo/tamanho. A nativa não lê arquivos; a rota responde 200 sem essa
   prova (o `rust-remote` do Node não aplica `recordFileSizes` de qualquer
   forma).
3. **`davail`** (`debrid:*` no `cache.db`/`debrid.db`): o Node serve ⚡ de
   memória antes da rede e renova o banco de magnets. A nativa sempre
   pergunta ao serviço.
4. **Evicção/reconcile/revalidate suprimida** por busca (`scheduleEvict`,
   `scheduleReconcile`, `scheduleSuppressedRevalidate`): continuam Node.
5. **Medição real**: a conta do operador está em `MAGNET_TOO_MANY`; qualquer
   upload (nativa ou sombra) devolve quota. Não foi possível medir
   `cached`/`known` reais nem rodar a sombra com par válido. O que dá para
   validar offline é o contrato (fixtures de resposta, lotes, teto, timeout,
   unusable, limpeza); a paridade de produção segue pendente.
6. **F4.6**: a rota Node `/internal/debrid/check` **não** pode ser removida
   enquanto o feed de holds não existir. O `DEBRID_AL_RUST=on` é instrumento de
   paridade, não corte; sem `holdsComplete` a nativa não limpa a conta e não
   substitui o davail.

## 5. Métricas (`/metrics` do gateway)

`debrid.al.native.checks`, `.native.known_false`, `.native.unusable`,
`.native.fallback`, e `debrid.al.shadow.compared`, `.divergence`,
`.items_missing`, `.items_extra`, `.timeout`, `.error`, `.skipped`,
`.skipped_sample`.

A sombra **faz upload extra pela referência Node** (a consulta da AllDebrid é
um upload) e não limpa; use amostra baixa. `known:false`/`unusable` de
QUALQUER lado conta `skipped`, não divergência. O conjunto comparado é
limitado por `DEBRID_AL_SHADOW_MAX_HASHES` e o resultado nativo é filtrado
pelo MESMO conjunto (hash não perguntado não vira divergência falsa).

## 6. Como validar depois (conta saudável)

1. `DEBRID_AL_RUST=shadow`, `DEBRID_AL_SHADOW_PERCENT=5`,
   `DEBRID_AL_SHADOW_MAX_HASHES=25` por ≥ 24 h numa instalação com o corte
   nativo (`ROUTES_RUST=stream`) ou canário; a sombra §9.1 não checa debrid.
2. Exigir `debrid.al.shadow.divergence == 0` e `timeout/error == 0` na janela;
   conferir `debrid.al.shadow.skipped` (Node degradado não é par).
3. Só então `DEBRID_AL_RUST=on` em uma instalação de teste, com
   `DEBRID_RUST_SERVICES=alldebrid` **desligado** (a rota Node continua dona)
   e observar `debrid.al.native.*`.
4. Para o corte: a limpeza segura já está portada (§8), mas falta o feed de
   holds do Node (`holdsComplete` + `heldHashes`) e o `fileHashes`/`davail`.
   Só então `DEBRID_RUST_SERVICES=alldebrid` pode apontar a 8710 e a rota Node
   pode sair.

## 7. Testes

- `cargo test -p adom-debrid --lib` — fixtures de upload (cached/uncached),
  batch 25 em paralelo, teto 500, timeout parcial, auth/quota/rate, delete
  não-fatal, sem vazamento de chave, flag `on`/sem chave na API.
- `cargo test -p adom-debrid --lib` (limpeza) — flag OFF read-only, kill-switch,
  `holds_incomplete`, hold do chamador + registro volátil, `adprot` durável,
  `adsub`/`submitted` no inventário, preexistente, `dropReady`/`dropUncached`,
  fila com backoff/segunda rodada, quota/auth, `Retry-After`, gate por conta e
  a rota com `holdsComplete`/`knownBefore` no corpo.
- `cargo test -p adom-search --lib debrid_` — seam (`off`/`on`/`shadow`,
  fallback só pré-upload, unusable) e sombra (amostra, comparação,
  divergência).
- `cargo test -p adom-server` — `/metrics` expõe `debrid.al.*` zerado.

## 8. Limpeza segura (`DEBRID_AL_CLEANUP`, default OFF)

Porte de `src/debrid/protected.ts` + `alldebrid-cleanup.ts` para
`adom-debrid::alldebrid_cleanup` (plano/guardas) e `alldebrid_delete` (fila).

### 8.1 O que protege um hash (união; qualquer um mantém o magnet)

1. **`heldHashes`** — fato do chamador: hold volátil do autofetch em voo.
2. **Registro volátil do Rust** (`Holds`, TTL por conta+hash) — o autofetch
   nativo futuro chama `hold(account, hash, ttl)`; hoje nenhum chamador de
   produção o preenche.
3. **`adprot:v1:alldebrid:<conta>:<hash>`** no `cache.db` (retenção BR do
   autofetch), lido read-only com `CACHE_DB_PATH`. `peek` não promove LRU nem
   conta hit/miss.
4. **`knownBefore`** — snapshot da conta ANTES do upload. Sem snapshot nesta
   rodada, ninguém sai (fail-safe). O Rust carrega o próprio snapshot por
   `/magnet/status` (TTL `ALLDEBRID_PREEXISTING_TTL_MS`, refresh em fundo,
   nunca no prazo da resposta) e subtrai a posse: `adsub:v1` durável do
   `cache.db` e os hashes que ESTA instância subiu com prova
   (`rememberSubmitted`: só quando o snapshot mostrava que o hash não estava
   lá, como no Node).
5. **Autofetch**: `dropUncached` só roda com `holdsComplete=true`. Sem essa
   prova o download recém-aceito seria apagado no meio — é o motivo de a flag
   sozinha não limpar nada.

### 8.2 Gate e fila

- Flag OFF (`default`): `CacheReport.cleanup = None`; `drop_*` é ignorado e
  nem inventário é carregado. **Read-only de verdade.**
- ON: o plano nasce suprimido se `DEBRID_AL_CLEANUP_KILL` ligado
  (`kill_switch`), se `holdsComplete=false` (`holds_incomplete`), se nenhum
  `drop*` foi pedido (`no_drop_flags`) ou se não há inventário
  (`inventory_missing`). Só com tudo aberto os `CleanTarget`s são montados.
- A execução é **fire-and-forget** (`CleanupPlan::run` → `tokio::spawn`);
  a resposta do `/stream` não espera o backoff. Falha só loga.
- Fila: UMA execução em voo por conta (`accountScope`, sha256 da chave — a
  chave não entra no mapa/log), 4 workers, backoff 400/800/1600 ms, UMA
  segunda rodada para o que falhou. **Quota/auth** param a execução inteira;
  **rate limit** usa o `Retry-After` (teto 30 s) e continua; 503/rede é
  transitório. O kill-switch é relido a cada tentativa.
- `deleted` no relatório = ids PEDIDOS no plano (não prova de remoção). A prova
  real (`removed`) vive no `DeleteReport` da fila, base para o `adrm`/purga
  quando forem portados.

### 8.3 Métricas (`/metrics` do gateway e da 8710)

`debrid.al.cleanup.planned`, `.protected`, `.known_before`,
`.suppressed.<flag_off|kill_switch|holds_incomplete|no_drop_flags|inventory_missing>`,
`.removed`, `.failed`, `.stopped`. A 8710 também expõe
`rust.debrid.api.alldebrid_cleanup_*`.

### 8.4 Contrato exato para ligar a limpeza em produção

A rota `POST /debrid/check` aceita, para AllDebrid:

```json
{
  "service": "alldebrid",
  "apiKey": "...",
  "hashes": ["..."],
  "inventoryLoaded": true,
  "knownBefore": ["hash que já era da conta"],
  "heldHashes": ["hash protegido (hold volátil + adprot)"],
  "holdsComplete": true,
  "dropReady": true,
  "dropUncached": true
}
```

- `holdsComplete` só pode ser `true` quando `heldHashes` cobre **todos** os
  holds vivos para os hashes do lote (é isso que o `skipCleanup` do Node
  consulta: `isHeld || isDurablyProtected`).
- `inventoryLoaded`/`knownBefore` são o snapshot do Node (`preexisting`);
  ausentes, o Rust tenta o próprio `/magnet/status` e, sem ele, não apaga.
- O `rust-remote.ts` atual **não envia** esses campos e o seam in-process não
  tem o hold: enquanto essa ponte não existir, `DEBRID_AL_CLEANUP=on` é
  read-only na prática. Não remova a rota Node (F4.6) antes dela.

