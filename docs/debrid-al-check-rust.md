# Checagem de cache da AllDebrid no Rust (`DEBRID_AL_RUST`)

Status: **default ON desde o F4.6** — no `docker-compose.yml`, e o mesmo vale
para o feed de holds e a limpeza (`DEBRID_AL_RUST=on`, `DEBRID_AL_HOLDS=on`,
`DEBRID_AL_CLEANUP=on`); o default do CÓDIGO segue `off` (processo sem compose,
teste/CLI). A rota Node `/internal/debrid/check` **saiu como respondedora**:
com `on` ela responde **410**; com `off` continua funcional e é o rollback de
uma linha (`DEBRID_AL_RUST=off`), o mesmo eixo que o Rust relê. `shadow`
mantém a rota viva porque ali o Node é a REFERÊNCIA da comparação. O motivo
histórico do adiamento era objetivo: o nativo era read-only sem o feed de
holds do autofetch. Esse feed existe agora nos DOIS caminhos (corpo do sidecar
e rota `/internal/debrid/holds` para o seam in-process, `DEBRID_AL_HOLDS`), e a
limpeza nativa só apaga com `holdsComplete` + inventário (`may_delete`
fail-closed). O que **não** mudou: a conta do operador segue em
`MAGNET_TOO_MANY`, então não há medição real de `cached`/`known` nem de
remoção — o check nativo responde `unusable: quota` (igual ao Node) e a
limpeza fica suprimida (`inventory_missing`) até o snapshot voltar. Ver §4.5 e
§6.

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
| Limpeza | remove prontos (`dropReady`) e frios (`dropUncached`), com hold/`knownBefore`/inventário | **portada** (`alldebrid_cleanup`/`alldebrid_delete`), atrás de `DEBRID_AL_CLEANUP` (default do corte **ON**, código `off`). Só executa com `holdsComplete` + inventário; sem isso é read-only. Os fatos do Node chegam pelo corpo da 8710 (sidecar) ou pelo feed `/internal/debrid/holds` (seam in-process, `DEBRID_AL_HOLDS`). Ver §8 |
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
  - `off`: comportamento anterior — reserva Node quando há
    `encoded`+`deadline`; sem reserva, checagem local. **Rollback** do corte.
  - `on` (default do `docker-compose.yml`): nativa responde. Fallback Node
    **só** se `attempted:false` e `known:false`; depois de um upload real a
    resposta é `Unknown` (segundo upload dobraria o lixo na conta). Como a
    rota de reserva responde **410** nesse modo, esse fallback residual vira
    `Unknown` honesto, sem upload extra.
  - `shadow`: a nativa responde (lado vivo) e o Node entra como REFERÊNCIA
    numa thread própria, DEPOIS da resposta, comparando `cached`/`known`
    (`debrid.al.shadow.*`). O cliente não espera a comparação. Só tem efeito
    no caminho nativo do `/stream`; a sombra §9.1 (`stream-shadow`) usa
    `NoDebridFactory` e não checa debrid. A rota Node **segue viva** aqui: é a
    referência.
- A rota HTTP `/debrid/check` do sidecar responde a AllDebrid **apenas** com
  `DEBRID_AL_RUST=on`; `shadow` mantém 501 (é modo de observação do
  `adom-search`, não de corte). Sem chave responde `200` com
  `{known:false, complete:false}`.
- A rota Node `/internal/debrid/check` responde **410** com `on` (F4.6) e
  **200** com `off`/`shadow`. A guarda (loopback + token) vem antes: fora do
  loopback/sem token continua 403/401, nunca 410.

## 3. Flags e rollback

| Env | Default do corte (compose) | Default do código | Efeito |
|---|---|---|---|
| `DEBRID_AL_RUST` | `on` | vazio/`off` | `off` = Node (rota `/internal/debrid/check` viva); `on` = nativa (rota 410); `shadow` = nativa + comparação com o Node (rota viva) |
| `DEBRID_AL_SHADOW_PERCENT` | `100` | `100` | amostra determinística (FNV-1a do conjunto de hashes) |
| `DEBRID_AL_SHADOW_TIMEOUT_MS` | `5000` | `5000` | prazo próprio da sombra |
| `DEBRID_AL_SHADOW_MAX_HASHES` | `50` (clamp 1..500) | `50` | teto de hashes reenviados pela sombra |
| `DEBRID_BATCH_SIZE` | `25` | `25` | lote da checagem (já existia no Node) |
| `DEBRID_CACHE_CHECK_TIMEOUT_MS` | `10000` | `10000` | teto por lote |
| `DEBRID_AL_CLEANUP` | `on` | vazio/`off` | `on` habilita o plano de limpeza; sem os fatos (§8) a nativa segue read-only |
| `DEBRID_AL_HOLDS` | `on` | vazio/`off` | `on` liga o feed do seam in-process (`/internal/debrid/holds`): hold volátil + `adprot` + `knownBefore` + drops. Só tem efeito com `DEBRID_AL_RUST=on`, `DEBRID_AL_CLEANUP=on` e AllDebrid; fora disso a nativa é read-only |
| `DEBRID_AL_HOLDS_TIMEOUT_MS` | `800` | `800` | prazo do POST interno do feed (mínimo 1 ms; falha = read-only) |
| `DEBRID_AL_CLEANUP_KILL` | vazio | vazio | `on/1/true/yes` suprime plano e fila (kill-switch de uma linha) |
| `DEBRID_AL_CLEANUP_BACKOFF_MS` | `400,800,1600` | idem | espera por tentativa na fila de delete |
| `DEBRID_AL_CLEANUP_CONCURRENCY` | `4` | `4` | workers por execução de delete (1..8) |
| `ALLDEBRID_PREEXISTING_TTL_MS` | `300000` | idem | TTL do snapshot `knownBefore` próprio; `0` desliga (fail-safe) |
| `CACHE_DB_PATH` | `data/cache.db` | idem | leitura read-only de `adprot`/`adsub` |

Rollback: `DEBRID_AL_RUST=off` (ou remover a linha). A rota Node volta a
responder e a checagem/limpeza viram 100% Node — é o mesmo eixo que o Rust
relê, sem rebuild. Para desligar só a limpeza (mantendo o check nativo):
`DEBRID_AL_CLEANUP=off`; para suprimir a fila sem desligar o plano:
`DEBRID_AL_CLEANUP_KILL=on`. **Se a rota Node for um dia removida do branch**,
o rollback da fatia deixa de ser env e passa a ser a imagem/commit anterior
(como já é o rollback funcional do `/stream`).

## 4. O que ficou fora do corte

1. **Feed de holds (volátil)** — **ponte pronta nos DOIS caminhos**:
   - **Sidecar (8710):** `src/debrid/rust-remote.ts` envia, para a AllDebrid,
     `inventoryLoaded`, `knownBefore`, `heldHashes`, `holdsComplete`,
     `dropReady` e `dropUncached` no corpo do `/debrid/check` quando a checagem
     vai para o sidecar (`DEBRID_RUST_SERVICES=alldebrid`) **e**
     `DEBRID_AL_CLEANUP=on`. Com a limpeza OFF nada é enviado. (Com
     `DEBRID_AL_RUST=off` o sidecar devolve 501 e o TS assume; os fatos
     preparados não custam leitura extra, porque a checagem Node espera o MESMO
     snapshot.) Ver `src/debrid/alldebrid-cleanup-facts.ts` e §8.4.
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
     `DEBRID_AL_RUST=on` + `DEBRID_AL_CLEANUP=on` (no `shadow` a nativa é
     observação e não limpa), então a flag OFF não adiciona nenhuma chamada.
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
   upload (nativa ou sombra) devolve quota. Não foi possível medir
   `cached`/`known` reais nem rodar a sombra com par válido. O que dá para
   validar offline é o contrato (fixtures de resposta, lotes, teto, timeout,
   unusable, limpeza, feed de holds); a paridade de produção segue pendente.
   No corte, o check nativo responde `unusable: quota` — o MESMO estado que o
   Node devolvia com a rota (a lista volta como P2P, sem autofetch/passe
   tardio) — e a limpeza nativa fica suprimida por `inventory_missing` até o
   `/magnet/status` voltar. Nada é mascarado: `debrid.al.native.unusable` e
   `debrid.al.cleanup.suppressed.inventory_missing` contam o caso.
6. **F4.6 (executado)**: o default do corte é `DEBRID_AL_RUST=on` +
   `DEBRID_AL_HOLDS=on` + `DEBRID_AL_CLEANUP=on` no `docker-compose.yml`. A
   rota Node `/internal/debrid/check` **saiu como respondedora** (410 no modo
   `on`), mas o código e o caminho `off` FICAM: `DEBRID_AL_RUST=off` é o
   rollback de uma linha e devolve a rota ao ar — na mesma linha de raciocínio
   do resto do corte (env → rota interna). Se a rota for apagada no futuro, o
   rollback da fatia passa a exigir a imagem/commit anterior.

## 5. Métricas (`/metrics` do gateway)

`debrid.al.native.checks`, `.native.known_false`, `.native.unusable`,
`.native.fallback`, `debrid.al.holds.ok`, `.holds.missing`,
`.holds.incomplete`, `.holds.account_mismatch`, e `debrid.al.shadow.compared`,
`.divergence`, `.items_missing`, `.items_extra`, `.timeout`, `.error`,
`.skipped`, `.skipped_sample`.

O feed de holds (`DEBRID_AL_HOLDS=on`) só anda com
`DEBRID_AL_RUST=on` + `DEBRID_AL_CLEANUP=on`: `holds.ok` = fatos aceitos e
cobrindo o lote; `.missing` = rota indisponível/erro (read-only); `.incomplete`
= respondeu mas a cobertura não fechou (read-only); `.account_mismatch` = fatos
de outra conta, descartados. Do lado Node, a rota conta
`rust.debrid.holds.feed` / `.incomplete`.

A sombra **faz upload extra pela referência Node** (a consulta da AllDebrid é
um upload) e não limpa; use amostra baixa. `known:false`/`unusable` de
QUALQUER lado conta `skipped`, não divergência. O conjunto comparado é
limitado por `DEBRID_AL_SHADOW_MAX_HASHES` e o resultado nativo é filtrado
pelo MESMO conjunto (hash não perguntado não vira divergência falsa).

## 6. Como validar depois (conta saudável)

O corte já está LIGADO por default; o que falta é medir paridade/remoção com a
conta fora de quota. Roteiro:

1. `DEBRID_AL_RUST=shadow`, `DEBRID_AL_SHADOW_PERCENT=5`,
   `DEBRID_AL_SHADOW_MAX_HASHES=25` por ≥ 24 h numa instalação com o corte
   nativo (`ROUTES_RUST=stream`). A sombra NÃO desliga a rota Node (é a
   referência) e não limpa; a sombra §9.1 não checa debrid.
2. Exigir `debrid.al.shadow.divergence == 0` e `timeout/error == 0` na janela;
   conferir `debrid.al.shadow.skipped` (Node degradado não é par).
3. Voltar `DEBRID_AL_RUST=on` e observar `debrid.al.native.*` (com a conta
   saudável, `.unusable` tem que ficar em 0 e `.checks` acompanhar as buscas).
4. Para a limpeza nativa: a limpeza segura já está portada (§8) e o feed de
   holds cobre o sidecar (corpo do `/debrid/check`) e o seam in-process
   (`/internal/debrid/holds`, `DEBRID_AL_HOLDS=on`). Com
   `DEBRID_RUST_SERVICES=alldebrid` + `DEBRID_AL_RUST=on` +
   `DEBRID_AL_CLEANUP=on`, a nativa limpa com os fatos do Node; conferir
   `debrid.al.cleanup.*` e `rust.debrid.cleanup.holds_incomplete` (tem que ficar
   em 0 nesse caminho). No seam in-process, além das três flags
   (`DEBRID_AL_RUST`, `DEBRID_AL_CLEANUP`, `DEBRID_AL_HOLDS`), conferir
   `debrid.al.holds.ok` > 0 e `.missing`/`.incomplete`/`.account_mismatch` em
   0, e `debrid.al.cleanup.suppressed.inventory_missing` em 0 (é o sintoma de
   conta em quota). Comparar `debrid.al.cleanup.removed` com o que o painel
   mostra na conta. Continuam fora o `fileHashes`/`fsz` (§4.2), o `davail`
   (§4.3) e as varreduras (§4.4) — por isso a rota Node ainda existe como
   rollback.

## 7. Testes

- `cargo test -p adom-debrid --lib` — fixtures de upload (cached/uncached),
  batch 25 em paralelo, teto 500, timeout parcial, auth/quota/rate, delete
  não-fatal, sem vazamento de chave, flag `on`/sem chave na API.
- `cargo test -p adom-debrid --lib` (limpeza) — flag OFF read-only, kill-switch,
  `holds_incomplete`, hold do chamador + registro volátil, `adprot` durável,
  `adsub`/`submitted` no inventário, preexistente, `dropReady`/`dropUncached`,
  fila com backoff/segunda rodada, quota/auth, `Retry-After`, gate por conta e
  a rota com `holdsComplete`/`knownBefore` no corpo.
- `cargo test -p adom-debrid --lib` (holds) — parsing estrito da rota
  (`account`/`evaluated`/`holdsComplete` obrigatórios, corpo antigo recusado),
  `covers` fail-closed (lote/casing/hash vazio/conta), cliente (token no
  header, `encoded` no corpo, sem apiKey, timeout/erro = sem fatos) e o gate
  `DEBRID_AL_HOLDS` (default do corte ON, sem token/fora do loopback = `None`).
- `cargo test -p adom-search --lib debrid_` — seam (`off`/`on`/`shadow`,
  fallback só pré-upload, unusable), sombra (amostra, comparação, divergência)
  e feed de holds (`on` entrega os fatos do lote inteiro; erro/mesma conta
  divergente/cobertura parcial = read-only; `shadow`, outro serviço e
  `DEBRID_AL_CLEANUP=off` não consultam o feed).
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
- `test/internal-debrid-check.test.ts` (Node) — a rota Node (corpo
  `encoded`/`deadline_at`) e o corte do F4.6: `DEBRID_AL_RUST=on` ⇒ **410**
  (sem chamar adaptador); `off` seguindo o caminho de sempre; `shadow`
  seguindo viva (é a referência).
- `test/debrid-al-cut-default.test.ts` (Node) — guarda dos DEFAULTs do corte
  no `docker-compose.yml` (`DEBRID_AL_RUST`/`HOLDS`/`CLEANUP` = `on`, com
  `:off` como override de rollback), o 410 da rota e a prova de que
  `/stream` e `/resolve` continuam montados/respondendo com o mesmo contrato
  (410/503 e 400 de hash malformado).
- Captura congelada (`scripts/golden/capture-stream-e2e.mjs --with-internal`)
  usa `/internal/debrid/check` para gravar `inputs/debrid.json`: rode a captura
  com `DEBRID_AL_RUST=off` (o corpus commitado e o replay não dependem disso).

## 8. Limpeza segura (`DEBRID_AL_CLEANUP`, default ON no corte)

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

- Flag OFF (rollback; default do código): `CacheReport.cleanup = None`;
  `drop_*` é ignorado e nem inventário é carregado. **Read-only de verdade.**
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
`DEBRID_AL_HOLDS=on` + `DEBRID_AL_RUST=on` + `DEBRID_AL_CLEANUP=on`).

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
- `DEBRID_AL_HOLDS` (default ON no corte) é o rollback de uma linha do feed:
  OFF não constrói o cliente, não faz POST e a nativa segue read-only. A rota
  `/internal/debrid/check` responde 410 no modo `on` (F4.6) e volta a responder
  com `DEBRID_AL_RUST=off`.
- Ponte implementada: `heldHashes` = união `isHeld` + `isDurablyProtected`
  varrendo **cada hash do lote** (o hold é chaveado por conta+hash, sem
  coringa) — logo `holdsComplete:true` é cobertura real do lote. Hash ilegível,
  chave vazia (`accountScope` = `none`) ou falha na leitura do `adprot` ⇒
  `holdsComplete:false`, mantendo na lista o que foi provado (fail-closed).
- `inventoryLoaded`/`knownBefore` vêm do `knownBefore` do Node: snapshot
  vigente ⇒ `true` + hashes; vencido/frio ⇒ `false` (refresh segue em fundo e
  o Rust usa o próprio snapshot — nunca apaga sem referência). Serviços que não
  são a AllDebrid não recebem os campos. A rota Node
  `/internal/debrid/check` (corpo `encoded`/`deadline_at`) responde 410 no modo
  `on`; é a reserva que sobra para o rollback `off`.

