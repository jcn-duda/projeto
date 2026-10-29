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
| `blocked` | `filterReuploadBlocked` tira do upload e o escape `unblockIfInventoryReady` devolve ⚡ só com prova `dinv` | campo **sempre presente** no outcome (vazio inclusive) listando o filtrado; `known`/`complete` intactos; a adoção é do Node |
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
(nunca `Missing`). O campo `blocked` do outcome é **transporte** para o Node
(não entra no veredito do seam): ele existe para o escape
`unblockIfInventoryReady` do `rust-remote.ts` — ver §2.

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
  `{known:false, complete:false, blocked:[]}`.
- **Escape do `adrm` (⚡ real):** o outcome carrega `blocked` (hashes que o
  filtro tirou do `/magnet/upload`, sempre presente). O `rust-remote.ts` lê o
  campo e, por hash, chama `unblockIfInventoryReady` (memo `dinv`, que só tem
  itens PRONTOS): com prova o hash volta ao `cached` e a marca é expurgada;
  sem memo/frio ou hash ausente, NADA muda (falha ao provar nunca destrava). É
  o mesmo escape do caminho TS (`alldebrid-check.ts`), agora também no nativo.
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
| `DEBRID_AL_SWEEP_APPLY` | `on` (`${DEBRID_AL_SWEEP_APPLY:-on}`) | `off` (ausente/vazio/lixo = OFF) | freio de APLICAÇÃO das quatro varreduras (`al_sweeps_env::apply_gate_on_from`): só o literal `on/1/true/yes` (aparado, sem caixa) abre o `Apply`. Sem ele, `DEBRID_AL_CLEANUP=on` vira `ReadOnly` (plano roda, `DELETE` não — `effective_from`). Desligar = rodada read-only; não devolve o agendador ao Node |
| `DEBRID_AL_SWEEP_MS` | vazio (= 6 h) | 6 h | intervalo mínimo por tipo de varredura; `0` desliga o agendamento (`interval_zero`); a primeira rodada espera um intervalo de propósito. Com `0` o runtime sai desligado inteiro (`enabled:false`), inclusive a rota manual |
| `DEBRID_AL_CLEANUP_KILL` | vazio | vazio | `on/1/true/yes` suprime plano e fila (kill-switch de uma linha) |
| `DEBRID_AL_CLEANUP_BACKOFF_MS` | `400,800,1600` | idem | espera por tentativa na fila de delete |
| `DEBRID_AL_CLEANUP_CONCURRENCY` | `4` | `4` | workers por execução de delete (1..8) |
| `ALLDEBRID_PREEXISTING_TTL_MS` | `300000` | idem | TTL do snapshot `knownBefore` próprio; `0` desliga (fail-safe) |
| `DEBRID_REUPLOAD_BLOCK` | vazio (= `true`) | `true` | kill-switch do anti-reenchimento (`adrm`), **compartilhado Node/Rust**: `false` desliga marcação E leitura nos dois lados |
| `ALLDEBRID_REUPLOAD_BLOCK_TTL_MS` | `259200000` (3d) | idem | validade do `adrm`; `0` desliga gravação E leitura (rollback de uma linha, também no filtro nativo) |
| `CACHE_DB_PATH` | `data/cache.db` | idem | leitura read-only de `adprot`/`adsub`/`adrm` |

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
4. **Evicção/reconcile/revalidate suprimida** por busca: **saíram do Node** no
   corte das varreduras (`alldebrid-evict.ts`, `alldebrid-reconcile.ts`,
   `alldebrid-suppressed-revalidate.ts` e os timers de `src/addon.ts`). Quem
   monta o plano, grava `adrm`, poda `adprot` e cura a fila `sup:` é o agendador
   NATIVO (`al_sweeps`), atrás de `DEBRID_AL_SWEEP_APPLY`. Rollback é
   imagem/commit anterior. Ver §8.7.
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
   FICAM como kill-switches do hold e do plano: default do código `off`, compose
   `on`; sem holds/inventário a nativa é read-only. O freio de APLICAÇÃO das
   quatro varreduras é `DEBRID_AL_SWEEP_APPLY` (código `off`, compose `on`) e o
   intervalo é `DEBRID_AL_SWEEP_MS`.
   **A fatia tem dois freios independentes**, e nenhum dos dois é rollback:
   (a) o gate `DEBRID_AL_SWEEP_APPLY` decide se o modo vira `Apply`
   (`al_sweeps_env::effective_from`: sem o gate, `on` em
   `DEBRID_AL_CLEANUP` vira `ReadOnly` — plano roda, `DELETE` não); (b) na rota
   manual, a **credencial destrutiva** (a segunda do `store_admin`, §9.1) mais
   `confirm:true` — sem a credencial o `POST /sweeps/run` responde
   `409 sweeps_requires_admin_token`/`403 sweeps_token_insufficient` e, sem
   `confirm`, `409 confirmation_required`, sempre antes de qualquer I/O na conta
   (`al_sweeps_admin::run`); a rodada **agendada** não pede `confirm`. Fechar
   (a) degrada tudo para read-only; fechar (b) só impede a rodada manual.
   Rollback da fatia continua sendo **imagem/commit anterior**: não existe env de
   DONO do agendador — o `spawn` é chamado uma vez por `proxy::run` e não há
   segundo laço (§9).

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
  a rota com `holdsComplete`/`knownBefore` no corpo. Inclui o kill-switch/TTL
  do `adrm` (`DEBRID_REUPLOAD_BLOCK`/`ALLDEBRID_REUPLOAD_BLOCK_TTL_MS`: flag
  OFF ou TTL 0 ⇒ `blocked_hashes` vazio) e o aviso único de `cache.db`
  ausente (fail-open preservado).
- `cargo test -p adom-debrid --lib` (`adrm`) — hash bloqueado não vai ao
  `/magnet/upload`, não tenta upload e aparece em `report.blocked`, com
  `known`/`complete` intactos; `outcome_json` sempre emite `blocked` (vazio
  inclusive).
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
- `test/debrid-rust-remote.test.ts` (Node) — escape do `adrm` no caminho
  nativo: outcome `{cached:[], blocked:[h], complete:true}` com memo `dinv`
  frio não inventa ⚡ e mantém a marca; com o hash PRONTO no memo ele entra no
  `cached` e a marca é expurgada (só para o hash provado).
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
  real (`removed`) vive no `DeleteReport` da fila e **não vira `adrm`**: o plano
  é só a higiene da checagem (`ready` + `uncached`), que no TS também não
  marcava (`scheduleDrop` só purgava a posse). Até 2026-10-24 a ponte
  `/internal/debrid/marked` gravava `adrm` para tudo o que a higiene apagava, e
  todo candidato fora do cache ficava bloqueado por 3 dias — o Chupim parou de
  baixar o dublado. A ponte hoje só leva `submitted` → `adsub`; o `adrm` é das
  varreduras de conteúdo (nativas: `sweepUndubbed` e reconcile) e do
  catálogo/painel do Node.

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

### 8.5 Donos depois da T2-L8 (limpeza das pontes)

Prova de que **nenhum arquivo** de `src/debrid/` saiu nesta fatia: o scan de
exports (nome ⇒ consumidores fora do próprio arquivo, em `src/`, `test/` e
`scripts/`) voltou a zero depois da redução, e as 31 chaves do objeto default de
`index.ts` têm chamador (painel, `/debrid-status`, `/addon.ts` ou teste).

O corte seguinte (varreduras da AllDebrid para o nativo) mudou parte deste
quadro: saíram `alldebrid-reconcile.ts`, `alldebrid-suppressed-revalidate.ts` e
`alldebrid-evict.ts` (com `config/debrid-reconcile.ts` e
`config/debrid-suppressed.ts`), e o objeto default de `index.ts` passou de 31
para **28** chaves (`sweepDeadEnv`/`sweepUndubbedEnv`/`sweepDeadCurrent` não
existem mais). Ver §8.7.

| Arquivo | Dono hoje | O que mudou |
|---|---|---|
| `index.ts` | Node | fica inteiro: objeto default = fachada do registry (28 chaves depois do corte — ver acima —, todas com consumidor) |
| `rust-remote.ts` | Node (ponte HTTP da 8710) | fica: `wrap` (registry), `RustWriteError`/`pullMetrics` (diagnóstico). `remoteOptions` deixou de ser público (auxiliar interno) |
| `alldebrid-inventory.ts`, `alldebrid-delete-gate.ts`, `protected.ts` | ainda Node | **não** apagados: são `knownBefore`/`adsub`/`adprot` do feed (`§8.4`), lidos a cada checagem nativa |
| `alldebrid-reupload.ts` | Node com estado do núcleo | fica: chamador do catálogo/painel e da higiene da checagem. As quatro varreduras são nativas e gravam `adrm` sem passar por aqui (`§8.6`, `§8.7`) |
| `davail-panel.ts`, `debrid-marked.ts` | — | não existem no checkout (o plano previa; a leitura é `internal-debrid-marked.ts`, viva) |

Superfície pública reduzida em 20 exports sem consumidor, todos mantidos como
tipos/auxiliares **internos** (`accountStatusFor`, `AccountTestOutcome`,
`CleanupFacts`, `FILE_SIZES_TTL_SECONDS`, `LiveResult`, `LiveVerdict`,
`rdGate*`/`RdGate*`, `LedgerState`, `RdLedgerWrite`, `takePlayFiles`,
`remoteOptions`) e um símbolo morto apagado de fato (`activeTorrentCount` do
Real-Debrid: a sonda usa `probeInstant`).

### 8.6 Dono do `adrm` (T2-L7)

O anti-reenchimento é **estado durável do núcleo**: a linha
`adrm:v1:<accountScope>:<hash>` (registro `{ at, name? }`) mora na tabela `cache`
do `data/cache.db` e é escrita pelo `NativeKv` do `adom-index`, pela ponte
`src/utils/native-kv.ts`. `adrm` entrou em `RUST_OWNED` **e** em
`RUST_OWNED_PREFIXES` (`src/utils/cache-keys.ts`), então o Node não carrega a
marca no L1 nem regrava no SQLite: `cache.get/peek` devolvem `null` e
`cache.set/forget` recusam.

| Quem | O quê | Como |
|---|---|---|
| Node (`alldebrid-reupload.ts`) | **escreve** em deleção INTENCIONAL do que ainda é dele (catálogo/painel) | `kvSet` (síncrono) |
| Gateway (`al_sweeps`) | **escreve** no `sweepUndubbed` e na cura dos represados; **lê** `adsub`/`adprot` para as travas | `DurablePeek`/KV nativo |
| Node (mesma unidade) | **lê** (partição do `/magnet/upload`, enqueue/Chupim) e **expurga** (prova no `dinv`, `--unblock`) | `kvPeek` / `kvForget` |
| Gateway (Rust) | **lê** e tira o hash do `/magnet/upload`; devolve os bloqueados em `blocked` | `DurablePeek` no mesmo arquivo |
| Higiene da checagem nativa | **nunca** escreve `adrm` | `marks_feed` só leva `submitted` → `adsub` |

Duas invariantes, ambas com teste:

1. **Só varredura de CONTEÚDO marca.** A higiene da checagem nativa (o
   `/magnet/upload` que a própria checagem faz) não devolve `removed` e não
   grava: marcar ali transformava todo candidato fora do cache em "apagado de
   propósito" por 3 dias e o Chupim parava de baixar o dublado. Prova em
   `rust/crates/adom-debrid/src/alldebrid_marks_tests.rs::limpeza_de_higiene_nao_devolve_adrm`
   e `test/debrid-al-holds-feed.test.ts` (`removed` de binário antigo é
   ignorado).
2. **A marca é visível ao gateway no instante da checagem.** O `cache.set`
   anterior só despejava no SQLite no próximo `setImmediate`; o `kvSet` faz
   `INSERT` imediato. Sem isso, a marca recém-gravada podia não barrar o upload
   seguinte.

Escrita que falha (núcleo ausente/disco) devolve `false` e conta
`debrid.reupload.markFailed` — nunca `marked`, para o painel não mentir. O memo
`dinv` é invalidado mesmo nesse caso: o magnet saiu da conta de qualquer jeito.

### 8.7 Dono das quatro varreduras (corte do TS)

O agendador é o **NATIVO** (`al_sweeps` no gateway): monta o plano, grava `adrm`
no `sweepUndubbed`, poda `adprot`, cura a fila `sup:` e só apaga com o gate
`DEBRID_AL_SWEEP_APPLY` (default do CÓDIGO `off`; só `on/1/true/yes` libera).
`DEBRID_AL_SWEEP_MS` é o intervalo por tipo (default 6 h; 0 desliga). Com o TS
fora, ele é o **dono único** das quatro.

| Varredura | Onde roda | O que sobrou no Node |
|---|---|---|
| `sweepDead` | nativo | o botão do painel pede a rodada nativa (`runNativeSweep('sweepDead')`, `src/routes/dashboard-actions-sweep.ts`), e só para a conta do operador |
| `sweepUndubbed` | nativo | `adrm`/`adsub`/`adprot` pelo KV nativo; a higiene da checagem (`dropReady`/`dropDownload`) segue no Node via `deleteMagnets` |
| `reconcile` (posse órfã) | nativo | nada |
| `revalidate` (represados `sup:`) | nativo | nada |

Saíram neste corte: os timers de `src/addon.ts`, `sweepDeadEnv`/`sweepUndubbedEnv`/
`sweepDeadCurrent` (`env-ops.ts` e a fachada `index.ts`), `sweepDead`/
`sweepUndubbed` de `alldebrid-cleanup.ts` e os três agendadores por busca. Em
`alldebrid-cleanup.ts` ficou a higiene da checagem: `skipCleanup` e
`deleteMagnets`/`deleteMagnetsNow`, atrás do gate B-4 por conta. `warmupEnv`
continua no Node — é inventário da conta do operador, não varredura.

## 9. Contrato admin das varreduras (8711)

As varreduras nativas não têm servidor próprio: `GET /sweeps` e
`POST /sweeps/run` são rotas do roteador do `store_admin`
(`rust/crates/adom-server/src/al_sweeps_admin.rs::router`), montadas por `merge`
em `store_admin::router_with_ownership`. Não há autenticação local nessas
rotas — o `auth` do `store_admin` cobre as duas. O listener é loopback
(`STREAM_STORE_ADMIN_LISTEN`, default `127.0.0.1:8711`) e o `docker-compose.yml`
**não publica** a porta (o bloco `ports` só abre 80/443, `${PORT:-7000}` e os
painéis 9117/8191): a sonda é por `docker exec`, nunca por fora do container.

### 9.1 Duas credenciais, de propósito

| credencial | de onde sai | para quê |
|---|---|---|
| token da admin (abre a superfície) | `store_admin::token_from_env`: `STREAM_STORE_ADMIN_TOKEN` → `DEBRID_INTERNAL_TOKEN` → `JACKETT_TEST_TOKEN` | TODAS as rotas, `GET /sweeps` inclusive — é o mesmo token de `/metrics.json`, `/dashboard-status.json` e dos scripts |
| token **destrutivo** | `store_admin::destructive_token_from_env`: `STREAM_STORE_ADMIN_TOKEN` → `DEBRID_INTERNAL_TOKEN` (`JACKETT_TEST_TOKEN` fica FORA) | libera o `DELETE` do `POST /sweeps/run`, depois do `auth` global |

As duas viajam no MESMO header `x-indexer-test-token` — não há segundo header:
o `store_admin::auth` compara o valor com a primeira e o handler compara o
mesmo valor com a segunda (`al_sweeps_admin::run` → `store_admin::tokens_match`).
Na prática o `POST` só passa quando o header é o token do `store_admin`; um
deploy em que só `JACKETT_TEST_TOKEN` está definido continua lendo o status
(`GET` 200) e leva `409` para executar. Os desfechos:

- sem credencial destrutiva configurada ⇒ `409 sweeps_requires_admin_token`
  (`reason:"no_destructive_token"`), **antes** de qualquer I/O na conta;
- token de diagnóstico (passa no `auth`, não é a segunda credencial) ⇒
  `403 sweeps_token_insufficient` (`reason:"diagnostic_token"`);
- header ausente/errado nem chega ao handler: o `auth` devolve `401
  unauthorized`; processo sem token algum devolve `503
  streams_admin_disabled`.

A ponte do Node manda o MESMO valor nas duas chamadas
(`src/utils/sweeps-native.ts::token`: `streamStore.token` —
`STREAM_STORE_ADMIN_TOKEN`/`DEBRID_INTERNAL_TOKEN` — com fallback
`config.jackett.testToken`), então o botão do painel só apaga quando a primeira
das duas envs existe.

Também não há `403` por escopo de conta: a conta é sempre a do operador
(`al_sweeps_admin::FORBIDDEN` recusa `apiKey`/`encoded`/`service`/`accountScope`
no corpo com `400 operator_only`).

### 9.2 `GET /sweeps` — status do agendador

| situação | status | corpo |
|---|---|---|
| runtime montado ou não | `200` | `ok:true`, `enabled`, `scheduled`, `mode`, `intervalMs`, `disabledReason` + a foto do snapshot |
| processo sem token | `503` | `{"ok":false,"error":"streams_admin_disabled"}` (`store_admin::auth`) |
| header ausente/errado | `401` | `{"ok":false,"error":"unauthorized"}` (`store_admin::auth`) |

O `200` vale **mesmo desligado** (`enabled:false` + `disabledReason`) e a rota
nunca faz I/O na conta: lê o snapshot em memória (`SweepAdmin::snapshot` →
`SweepSnapshot::to_json`). Campos: `running` (guard de anti-reentrada),
`startedAt`, `lastTickAt`, `nextDueAt`, `lastByKind` (relógio por tipo),
`counters` (`runs`, `manualRuns`, `reentered`, `notDue`, `missing`, `planned`,
`swept`, `sweptUndubbed`, `failed`, `blocked`, `calls`, `byKind`, `reasons`) e
`last` (`{at, manual, outcomes[], missing[]}`). Nenhum campo traz `apiKey`,
hash, id de magnet ou escopo de conta; `counters` nasce em zero a cada boot e
`last` é `null` até a primeira rodada que executou algo.

`disabledReason` só assume estes valores: `interval_zero` (`DEBRID_AL_SWEEP_MS`
≤ `0`) e `cleanup_off` (modo sem plano), de `al_sweeps_env::disabled_reason`;
`no_operator_account` e `http_client_unavailable`, de `al_sweeps_env::spawn`; e
`not_wired`, de `SweepAdmin::not_wired` (admin sem runtime injetado).

### 9.3 `POST /sweeps/run` — UMA varredura fora do relógio

A ordem das checagens é a do handler (`al_sweeps_admin::run`), e ela
determina o status:

| # | condição | status | `error` |
|---|---|---|---|
| 1 | corpo traz `apiKey`/`encoded`/`service`/`accountScope` não nulo | `400` | `operator_only` |
| 2 | `kind` ausente ou fora do vocabulário | `400` | `invalid_kind` |
| 3 | sem `Sweeper` e motivo de conta/cliente/runtime | `503` | `sweeps_unavailable` (+ `reason`) |
| 4 | sem `Sweeper` por env desligado | `409` | `sweeps_disabled` (+ `reason`) |
| 5 | credencial destrutiva não configurada | `409` | `sweeps_requires_admin_token` (`reason:"no_destructive_token"`) |
| 6 | header ≠ credencial destrutiva | `403` | `sweeps_token_insufficient` (`reason:"diagnostic_token"`) |
| 7 | modo `apply` e `confirm` ≠ `true` | `409` | `confirmation_required` |
| 8 | rodada em voo (anti-reentrada) | `409` | `sweep_in_progress` (`reason:"reentered"`, `running:true`) |
| 9 | tarefa abortada/panic | `500` | `sweep_failed` |
| 10 | executou | `200` | — (corpo de sucesso abaixo) |

Nos degraus 3 e 4 o `reason` é o `disabled_reason` do §9.2 (`not_wired`,
`no_operator_account`, `http_client_unavailable` ⇒ `503`; `cleanup_off`,
`interval_zero` ⇒ `409`, com `cleanup_off` como default quando o motivo é
`None`). A credencial (5/6) vem ANTES do `confirm`: sem a segunda credencial não
há nem confirmação a cobrar. Em `ReadOnly` o `confirm` é **ignorado** — só o
destruidor o exige.

**Um `kind` por chamada; não existe `all`.** O vocabulário é o de
`SweepKind::parse` (`alldebrid_sweeps_types.rs`): `sweepDead`, `sweepUndubbed`,
`reconcile`, `revalidate`, em qualquer caixa e aceitando `_`/`-`
(`sweep_dead`, `sweep-undubbed`). Qualquer outro valor — inclusive `all` — cai
em `400 invalid_kind`.

Corpo do sucesso (`al_sweeps_admin::ran_json`): `ok`, `kind`, `ran`, `mode`,
`applied`, `planned`, `swept`, `varridos`, `falhas`, `failed`, `blocked`,
`calls`, `stopped`, `missing` (booleano: o tipo acordou sem listagem da conta),
`reasons` e `at`. `varridos`/`falhas` repetem `swept`/`failed` porque o toast do
painel lê esses nomes desde antes da rota nativa
(`src/utils/sweeps-native.ts::runOf` repassa os dois). A rota só responde
depois de varrer; se o cliente cair, a rodada continua e o `GET` mostra
`running:true` até o `FlightGuard` soltar.

Sonda de dentro do container (a imagem é `node:22-alpine` e o `Dockerfile` faz
`apk add` **sem** `curl` — use o `wget` do busybox):

```bash
# status
wget -q -O - --header "x-indexer-test-token: $STREAM_STORE_ADMIN_TOKEN" \
  http://127.0.0.1:8711/sweeps

# uma varredura (o `confirm` só é exigido no modo apply)
wget -q -O - \
  --header "x-indexer-test-token: $STREAM_STORE_ADMIN_TOKEN" \
  --header "content-type: application/json" \
  --post-data '{"kind":"sweepDead","confirm":true}' \
  http://127.0.0.1:8711/sweeps/run
```

O token vai **só no header** (nunca na URL, que sobra em log de proxy). No
`POST`, o valor tem que ser a credencial DESTRUTIVA
(`STREAM_STORE_ADMIN_TOKEN`/`DEBRID_INTERNAL_TOKEN`): o token de diagnóstico
serve para o `GET` e leva `403 sweeps_token_insufficient` no `run`. Como a 8711
não é publicada, o comando roda com `docker compose exec adom sh -lc '...'`
(`DEPLOY.md` §8.2).
