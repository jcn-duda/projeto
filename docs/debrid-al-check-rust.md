# Checagem de cache da AllDebrid no Rust

Status: **nativa e incondicional desde o R3** — a checagem é um
`/magnet/upload` real feito pelo Rust em toda busca com AllDebrid; não existe
mais flag de modo (`DEBRID_AL_RUST` saiu) nem rota Node
`/internal/debrid/check` (foi apagada). O default do CÓDIGO das varreduras
**destrutivas** é `off` (`DEBRID_AL_CLEANUP`, `DEBRID_AL_HOLDS`) e o
`docker-compose.yml` sobe as duas `on`; sem os fatos do feed de holds ou sem
inventário a nativa é **read-only**. Rollback da fatia é **commit/imagem
anterior**, não env.

O motivo histórico do adiamento era objetivo: o nativo era read-only sem o
feed de holds do autofetch. Esse feed existe agora nos DOIS caminhos (corpo do
sidecar na 8710 e rota `/internal/debrid/holds` para o seam in-process,
`DEBRID_AL_HOLDS`), e a limpeza nativa só apaga com `holdsComplete` +
inventário (`may_delete` fail-closed). O que **não** mudou: a conta do
operador segue em `MAGNET_TOO_MANY`, então não há medição real de
`cached`/`known` nem de remoção — o check nativo responde `unusable: quota`
(igual ao Node) e a limpeza fica suprimida (`inventory_missing`) até o
snapshot voltar. Ver §4.5 e §6.

## 1. Contrato do Node

Caminho real da busca (`cache-check.checkCached` → adaptador
`alldebrid-check.checkCached`):

| Ponto | Node (contrato histórico; rota apagada no R3) | Rust (`alldebrid_check.rs`) |
|---|---|---|
| Consulta | `/magnet/upload` com `magnets[]` (não há `/magnet/instant`) | idem, por lote |
| Lote | `DEBRID_BATCH_SIZE` (default **25**), lotes **em paralelo** | default 25, env; `JoinSet` (paralelo) |
| Teto | a rota interna recusava > **500** hashes | 500 primeiros enviados; excedente ⇒ `complete:false` (não é "frio") |
| Timeout | `DEBRID_CACHE_CHECK_TIMEOUT_MS` (default **10000**) por lote, mesmo teto | idem, env; lote estourado ⇒ `complete:false` com o hit parcial preservado |
| `cached` | `magnet.ready === true` (hash lower-case) | idem |
| `known` | `complete = failures === 0` (lotes) | idem; `known:false` nunca vira "nada em cache" |
| `unusable` | auth (`AUTH_*`, 401/403) e quota (`MAGNET_TOO_MANY*`) | mesmas réguas no `unwrap_payload`/`from_http`; rate limit **não** é unusable |
| Falha de lote | `allSettled`; todos falharam ⇒ auth/quota/rate do conjunto, senão "nenhum lote" | idem (agora inclui rate limit com `retry_after`) |
| Limpeza | remove prontos (`dropReady`) e frios (`dropUncached`), com hold/`knownBefore`/inventário | **portada** (`alldebrid_cleanup`/`alldebrid_delete`), atrás de `DEBRID_AL_CLEANUP` (kill-switch destrutivo: default do código `off`, compose `on`). Só executa com `holdsComplete` + inventário; sem isso é read-only. Os fatos do Node chegam pelo corpo da 8710 (sidecar) ou pelo feed `/internal/debrid/holds` (seam in-process, `DEBRID_AL_HOLDS`). Ver §8 |
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
- `adom-search::debrid_seam::AdapterDebridCheck` é o adaptador único: a
  checagem da AllDebrid é nativa e **incondicional**, sem fallback Node e sem
  eixo `off`/`on`/`shadow`. Depois de um upload real a resposta é `Unknown`
  (segundo upload dobraria o lixo na conta).
- A rota HTTP `/debrid/check` do sidecar (8710) responde a AllDebrid como os
  demais serviços, incondicionalmente. Sem chave responde `200` com
  `{known:false, complete:false}`.
- A rota Node `/internal/debrid/check` foi **apagada no R3**; nenhum caminho
  do Node responde checagem de cache.

## 3. Flags vivas e rollback

| Env | Default do corte (compose) | Default do código | Efeito |
|---|---|---|---|
| `DEBRID_AL_CLEANUP` | `on` | vazio/`off` | kill-switch das varreduras **destrutivas**: `off` = read-only de verdade (`drop_*` ignorado, inventário não é carregado); `on` habilita o plano, que ainda exige os fatos (§8) |
| `DEBRID_AL_HOLDS` | `on` | vazio/`off` | liga o feed do seam in-process (`/internal/debrid/holds`): hold volátil + `adprot` + `knownBefore` + drops. Só tem efeito com `DEBRID_AL_CLEANUP=on` e AllDebrid; fora disso a nativa é read-only |
| `DEBRID_BATCH_SIZE` | `25` | `25` | lote da checagem (já existia no Node) |
| `DEBRID_CACHE_CHECK_TIMEOUT_MS` | `10000` | `10000` | teto por lote |
| `DEBRID_AL_HOLDS_TIMEOUT_MS` | `800` | `800` | prazo do POST interno do feed (mínimo 1 ms; falha = read-only) |
| `DEBRID_AL_CLEANUP_KILL` | vazio | vazio | `on/1/true/yes` suprime plano e fila (kill-switch de uma linha) |
| `DEBRID_AL_CLEANUP_BACKOFF_MS` | `400,800,1600` | idem | espera por tentativa na fila de delete |
| `DEBRID_AL_CLEANUP_CONCURRENCY` | `4` | `4` | workers por execução de delete (1..8) |
| `ALLDEBRID_PREEXISTING_TTL_MS` | `300000` | idem | TTL do snapshot `knownBefore` próprio; `0` desliga (fail-safe) |
| `CACHE_DB_PATH` | `data/cache.db` | idem | leitura read-only de `adprot`/`adsub` |

A checagem em si **não tem rollback por env**: ela é incondicional. Rollback da
fatia é **commit/imagem anterior** (a rota e o código do Node não existem mais
no branch). Para desligar só a limpeza, mantendo a checagem nativa:
`DEBRID_AL_CLEANUP=off`; para suprimir a fila sem desligar o plano:
`DEBRID_AL_CLEANUP_KILL=on`.

## 4. O que ficou fora do corte

1. **Feed de holds (volátil)** — **ponte pronta nos DOIS caminhos**:
   - **Sidecar (8710):** `src/debrid/rust-remote.ts` envia, para a AllDebrid,
     `inventoryLoaded`, `knownBefore`, `heldHashes`, `holdsComplete`,
     `dropReady` e `dropUncached` no corpo do `/debrid/check` quando a checagem
     vai para o sidecar (`DEBRID_RUST_SERVICES=alldebrid`) **e**
     `DEBRID_AL_CLEANUP=on`. Com a limpeza OFF nada é enviado. Os fatos
     preparados não custam leitura extra, porque a auditoria do Node usa o MESMO
     snapshot. Ver `src/debrid/alldebrid-cleanup-facts.ts` e §8.4.
   - **Seam in-process (`DEBRID_AL_HOLDS`, default ON no corte):**
     `adom-search::debrid_seam` pergunta os fatos à nova rota
     `POST /internal/debrid/holds` (loopback + token, corpo
     `{encoded, service, hashes}`, sem apiKey) ANTES do `/magnet/upload` nativo
     e os entrega a `verdict::check_service_report_with`. A rota responde
     `{account, inventoryLoaded, knownBefore, heldHashes, evaluated,
     holdsComplete, dropReady, dropUncached}`; `account` é o `sha256` da chave
     (o Rust compara com `account_scope` da própria chave) e `evaluated` são os
     hashes do lote que a auditoria do Node realmente avaliou. O Rust exige
     `evaluated` cobrindo TODOS os hashes do lote **e** `holdsComplete:true`;
     corpo antigo sem `evaluated` é recusado. Qualquer falha (sem token, HTTP,
     corpo estranho, conta divergente, cobertura parcial) mantém a nativa
     READ-ONLY — nenhum hash sai. O feed só é consultado com
     `DEBRID_AL_HOLDS=on` + `DEBRID_AL_CLEANUP=on`, então desligar o feed não
     adiciona nenhuma chamada.
   `holdsComplete` só é `true` quando todos os hashes do lote foram avaliados
   nas duas camadas do Node (`isHeld || isDurablyProtected`); chave vazia, hash
   ilegível ou falha na leitura durável ⇒ `false` (fail-closed).
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
   upload devolve quota. Não foi possível medir `cached`/`known` reais. O que
   dá para validar offline é o contrato (fixtures de resposta, lotes, teto,
   timeout, unusable, limpeza, feed de holds); a paridade de produção segue
   pendente. No corte, o check nativo responde `unusable: quota` — o MESMO
   estado que o Node devolvia com a rota (a lista volta como P2P, sem
   autofetch/passe tardio) — e a limpeza nativa fica suprimida por
   `inventory_missing` até o `/magnet/status` voltar. Nada é mascarado:
   `debrid.al.native.unusable` e
   `debrid.al.cleanup.suppressed.inventory_missing` contam o caso.
6. **R3 (executado)**: a checagem/limpeza é NATIVA e incondicional; a flag
   `DEBRID_AL_RUST` e a rota Node `/internal/debrid/check` foram **apagadas**
   (sem modo `off`/`on`/`shadow`). `DEBRID_AL_HOLDS`/`DEBRID_AL_CLEANUP`
   FICAM como kill-switches das varreduras **destrutivas**: default do código
   `off`, compose `on`; sem holds/inventário a nativa é read-only. Rollback da
   fatia é **imagem/commit anterior**, não env.

## 5. Métricas (`/metrics` do gateway)

`debrid.al.native.checks`, `.native.known_false`, `.native.unusable`,
`debrid.al.holds.ok`, `.holds.missing`, `.holds.incomplete`,
`.holds.account_mismatch`.

O feed de holds (`DEBRID_AL_HOLDS=on`) só anda com `DEBRID_AL_CLEANUP=on`:
`holds.ok` = fatos aceitos e cobrindo o lote; `.missing` = rota
indisponível/erro (read-only); `.incomplete` = respondeu mas a cobertura não
fechou (read-only); `.account_mismatch` = fatos de outra conta, descartados.
Do lado Node, a rota conta `rust.debrid.holds.feed` / `.incomplete`.

A antiga sombra (`debrid.al.shadow.*`, com upload extra pela referência Node)
foi removida junto com o código no R1/R3; não há comparação em produção.
`known:false`/`unusable` são observados pelo lado nativo
(`.native.known_false`/`.native.unusable`) e não entram como divergência de
nada.

## 6. Como validar depois (conta saudável)

A checagem já está LIGADA (incondicional); o que falta é medir o resultado
real com a conta fora de quota. Roteiro:

1. Com a conta saudável, observar `debrid.al.native.*`: `.unusable` tem que
   ficar em 0 e `.checks` acompanhar as buscas; `.known_false` só aparece em
   lote perdido/prazo.
2. Para a limpeza nativa: a limpeza segura já está portada (§8) e o feed de
   holds cobre o sidecar (corpo do `/debrid/check`) e o seam in-process
   (`/internal/debrid/holds`, `DEBRID_AL_HOLDS=on`). Com
   `DEBRID_RUST_SERVICES=alldebrid` + `DEBRID_AL_CLEANUP=on`, a nativa limpa
   com os fatos do Node; conferir `debrid.al.cleanup.*` e
   `rust.debrid.cleanup.holds_incomplete` (tem que ficar em 0 nesse caminho).
   No seam in-process, além das duas flags (`DEBRID_AL_CLEANUP`,
   `DEBRID_AL_HOLDS`), conferir `debrid.al.holds.ok` > 0 e
   `.missing`/`.incomplete`/`.account_mismatch` em 0, e
   `debrid.al.cleanup.suppressed.inventory_missing` em 0 (é o sintoma de conta
   em quota). Comparar `debrid.al.cleanup.removed` com o que o painel mostra na
   conta.
3. Continuam fora o `fileHashes`/`fsz` (§4.2), o `davail` (§4.3) e as
   varreduras (§4.4). Não há mais modo de comparação em produção: a paridade
   com o Node se prova pelo corpus congelado e pelo comportamento com a conta
   saudável, não por sombra.

## 7. Testes

- `cargo test -p adom-debrid --lib` — fixtures de upload (cached/uncached),
  batch 25 em paralelo, teto 500, timeout parcial, auth/quota/rate, delete
  não-fatal, sem vazamento de chave, checagem sem chave na API.
- `cargo test -p adom-debrid --lib` (limpeza) — flag OFF read-only, kill-switch,
  `holds_incomplete`, hold do chamador + registro volátil, `adprot` durável,
  `adsub`/`submitted` no inventário, preexistente, `dropReady`/`dropUncached`,
  fila com backoff/segunda rodada, quota/auth, `Retry-After`, gate por conta e
  a rota com `holdsComplete`/`knownBefore` no corpo.
- `cargo test -p adom-debrid --lib` (holds) — parsing estrito da rota
  (`account`/`evaluated`/`holdsComplete` obrigatórios, corpo antigo recusado),
  `covers` fail-closed (lote/casing/hash vazio/conta), cliente (token no
  header, `encoded` no corpo, sem apiKey, timeout/erro = sem fatos) e o gate
  `DEBRID_AL_HOLDS` (default do compose ON e do código OFF; sem token/fora do
  loopback = `None`).
- `cargo test -p adom-search --lib debrid_` — seam (incondicional, fallback só
  pré-upload, unusable) e feed de holds (`on` entrega os fatos do lote inteiro;
  erro/mesma conta divergente/cobertura parcial = read-only;
  `DEBRID_AL_CLEANUP=off` não consulta o feed).
- `cargo test -p adom-server` — `/metrics` expõe `debrid.al.*` zerado.
- `test/debrid-al-holds-feed.test.ts` (Node) — a rota do feed: guarda
  (loopback+token), entrada inválida, hold volátil + `adprot`, `evaluated`
  cobrindo o lote, `holdsComplete` fail-closed, inventário frio × quente
  (`knownBefore`), chave vazia, `dropReady`/`dropUncached` e o corpo do sidecar
  seguindo sem `account`/`evaluated`.
- `test/debrid-al-cleanup-facts.test.ts` (Node) — ponte do corpo: hold volátil
  + `adprot` em `heldHashes`, `holdsComplete` completo × ilegível/chave vazia
  (fail-closed), `inventoryLoaded`/`knownBefore` frio × vigente,
  `dropReady`/`dropUncached`, e o `wrap` mantendo os campos antigos
  (`service`/`apiKey`/`hashes`/`timeoutMs`/`fileHashes`/`fileWaitTimeoutMs`) e
  omitindo os fatos nos outros serviços.
- `test/debrid-al-cut-default.test.ts` (Node) — guarda dos DEFAULTs do
  `docker-compose.yml` (`DEBRID_AL_HOLDS`/`DEBRID_AL_CLEANUP` = `on` com
  `:-on`, `off` como kill-switch), `GATEWAY`/`ROUTES_RUST` literais, override de
  diagnóstico sem flag nenhuma, `/stream` aposentado (503/410) e `/resolve`
  recusando hash malformado com 400.
- Captura congelada (`rust/golden/stream-e2e/inputs/debrid.json`): o corpus
  commitado já tem o veredito por hash. A rota Node que o gerava não existe
  mais (R3); recapturar do zero exigiria uma fonte equivalente, e o replay não
  depende disso.

## 8. Limpeza segura (`DEBRID_AL_CLEANUP`, kill-switch destrutivo; ON no compose)

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

- `DEBRID_AL_CLEANUP` OFF (default do código; kill-switch):
  `CacheReport.cleanup = None`; `drop_*` é ignorado e nem inventário é
  carregado. **Read-only de verdade.**
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
`rust.debrid.api.alldebrid_cleanup_*`. Do lado Node, a ponte conta
`rust.debrid.cleanup.facts` (fatos montados) e `rust.debrid.cleanup.holds_incomplete`
(prova de cobertura falhou) — os dois só andam com `DEBRID_AL_CLEANUP=on` no
caminho do sidecar. O feed in-process conta `rust.debrid.holds.feed` e
`rust.debrid.holds.incomplete` (só com a rota chamada, ou seja
`DEBRID_AL_HOLDS=on` + `DEBRID_AL_CLEANUP=on`).

### 8.4 Contrato exato da limpeza no corte

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
- O `rust-remote.ts` **já envia** esses campos (via
  `src/debrid/alldebrid-cleanup-facts.ts`) quando `DEBRID_AL_CLEANUP=on` — com
  a flag OFF nada é enviado e o caminho nativo de paridade fica idêntico ao
  anterior (nenhuma leitura extra de `/magnet/status`).
- O seam in-process recebe os MESMOS fatos pela rota
  `POST /internal/debrid/holds` (guardada por loopback + token), com dois
  campos a mais: `account` (sha256 da chave, conferido contra
  `account_scope(apiKey)` no Rust) e `evaluated` (hashes do lote realmente
  avaliados). O Rust só aceita `holdsComplete:true` se `evaluated` cobrir todos
  os hashes do lote; resposta sem `evaluated` é de Node antigo e é recusada.
  Corpo do feed:
  `{encoded, service, hashes}` → `{ok, service, account, inventoryLoaded,
  knownBefore, heldHashes, evaluated, holdsComplete, dropReady, dropUncached}`.
  A chave NUNCA vai no JSON (o `encoded` é decodificado no runtime do usuário).
  Qualquer falha mantém a nativa read-only — inclusive conta divergente.
- `DEBRID_AL_HOLDS` (default ON no compose) é o kill-switch de uma linha do
  feed: OFF não constrói o cliente, não faz POST e a nativa segue read-only. A
  rota Node `/internal/debrid/check` foi **apagada no R3**; rollback da fatia é
  imagem/commit anterior.
- Ponte implementada: `heldHashes` = união `isHeld` + `isDurablyProtected`
  varrendo **cada hash do lote** (o hold é chaveado por conta+hash, sem
  coringa) — logo `holdsComplete:true` é cobertura real do lote. Hash ilegível,
  chave vazia (`accountScope` = `none`) ou falha na leitura do `adprot` ⇒
  `holdsComplete:false`, mantendo na lista o que foi provado (fail-closed).
- `inventoryLoaded`/`knownBefore` vêm do `knownBefore` do Node: snapshot
  vigente ⇒ `true` + hashes; vencido/frio ⇒ `false` (refresh segue em fundo e
  o Rust usa o próprio snapshot — nunca apaga sem referência). Serviços que não
  são a AllDebrid não recebem os campos.

