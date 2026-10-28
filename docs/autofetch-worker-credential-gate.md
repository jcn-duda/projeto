# Gate de credencial do worker nativo do Chupim (T3-L5/L6)

**Status (2026-10-28, branch `rust` + leva C1):** a **opção (2) — cofre em
memória por conta — está IMPLEMENTADA** (`d51f53c0`, refinada por `d50a7bdd` e
`4e0617e6`), a **fábrica de produção dos cinco serviços também** (`0159b9f2`,
`autofetch/build.rs`) e o `docker-compose.yml` liga `AUTOFETCH_WORKER=on`. O
gate deixou de ser o bloqueio: os TRÊS kinds do Chupim são despachados pelo laço
(`autofetch/serve_jobs.rs:57-64`), a represa drena com a fábrica registrada no
boot e a evicção F6 roda no ciclo com kill-switch próprio. O que falta é o
**flip B4** — apagar o TS do Chupim — e ele depende dos FATOS que só o Node
produz (fim deste documento).

**O bloqueio original:** o dreno/recheck do Chupim rodava no Node dentro do
`RuntimeContext` da requisição e a chave do debrid vinha de
`opts().debridApiKey`; o worker nativo do gateway (`rust/crates/adom-server`) não
tem esse contexto — e fila/marker/dead no KV (`autofetch:v3:q:`, `:m:`, `:dead:`)
não guardam credencial por desenho (`QueueCandidate` em
`adom-autofetch/src/v3/candidate.rs:65`; valor do marker em
`adom-core/src/autofetch_marker.rs:44-61`).

## (a) De onde a chave vem hoje

1. `debridApiKey` (`dk`) viaja no install URL (`SCHEMA`,
   `src/runtime.ts:60-91`); `/:userConfig` decodifica e abre o ALS
   (`src/routes/register.ts:90-93`). `opts()` lê o store (`runtime.ts:268-270`),
   `capture()` o devolve (:287-289) e `run()` o restaura (:323-325).
2. O gateway emite `autofetch_batch` com o `encoded` da requisição no corpo
   (`orchestrator/late.rs:250-279`); o payload do lote NÃO leva a chave
   (`orchestrator/effects.rs:198-215`) e o cliente interno exige `encoded`
   (`internal_client.rs:85-95`). O Node decodifica o corpo (`internal-search-shared.ts:47-53`),
   monta `ctx` e roda o efeito sob ele (`internal-search-effects.ts:196-204`).
3. `enqueueAutofetch` faz `capture()` (`autofetch-runner.ts:55`) e passa o
   contexto a `scheduleRecheck` (:147), guardado em `lot.ctx`
   (`autofetch-recheck.ts:61-86`); `runRecheck` restaura com `run(lot.ctx)`
   (:215) e usa `opts().debridApiKey` em `drainNext` (:99), `accountScope`
   (:229), `torrentStatus` (:256) e `maybeEvictFallbacks` (:309) — são
   ESCRITAS no debrid, não só o `enqueue`.

A chave existe **só em RAM** (`recheckLots` é um `Map` de processo,
`autofetch-recheck.ts:48`). O gateway já vê o `encoded`
(`adom-search/src/request.rs:21-43`), sabe extrair a chave no processo
(`adom-search/src/resolve_url.rs:320-329`, o caminho do `/resolve`) e o
`dub_audit` já fazia isso: chave no efeito (`orchestrator/effects.rs:99-100`),
interceptada em `adom-server/src/tail_effects.rs`, só em memória
(`adom-server/src/dub_audit.rs`).

## (b) Por que o gateway precisa decidir

O worker é um laço de fundo (recheck de horas, TTL do autofetch) fora de
qualquer requisição. Três desenhos, e eles mudam **quem** opera o Chupim:

1. **Job com chave pela admin/loopback** — rota nova em `store_admin.rs` (hoje só
   `/streams/*`, `/harvest*` e `/autofetch*`; loopback + token).
2. **Cofre em memória por conta** — decodificar o `encoded` que já chega e
   guardar `{account_scope -> apiKey}` enquanto houver lote; é o desenho do
   `dub_audit` e dispensa transporte novo.
3. **Só a conta do operador** — `DEBRID_API_KEY` já é lida para os defaults
   (`resolve_native.rs`); usuários BYO (`dk`) ficam sem Chupim.

## (c) Custo de cada opção

| opção | segurança | estado |
|---|---|---|
| (1) job com chave | segunda entrada de credencial (além de `/internal/*`) no token que hoje só mexe em store/colhedor; exige autorização por conta e idempotência contra injeção de job | se precisar sobreviver ao restart, a chave teria de ser persistida — proibido — e degenera para (2) |
| (2) cofre em memória | N chaves BYO em texto puro no gateway (hoje só no Node); nunca em KV/log (precedente do `dub_audit`: "só em memória, nunca em log") | **implementada**: N chaves em RAM com TTL/LRU por conta; restart zera o cofre |
| (3) só operador | zero chave de usuário (só a env, e só com `DEBRID_ALLOW_ENV_KEY=true`); menor custo | quebra o Chupim de quem usa `dk`; fila/marker/dead são por `accountScope` (`request_key.rs:40-47`), então fila mista exigiria filtro por conta |

## (d) Recomendação original

**(2), alimentado pelo `encoded` que já chega no `EffectsBatch`** — sem rota
admin nova e sem `api_key` no payload. (1) só se o job tiver de nascer fora de
uma busca (painel), reaproveitando token/loopback da admin. (3) fica como
kill-switch de instalação pública (recusar `dk` no worker), não como desenho.

---

## O cofre real (`d51f53c0`)

Arquivo: `rust/crates/adom-server/src/autofetch/vault.rs` (testes no
`vault_tests.rs` ao lado). Um `HashMap<String, Entry>` em RAM protegido por
`Mutex`, um dono por processo (`Arc`, sem `Clone`), obtido por
`autofetch::shared_vault()`.

| Item | Como é |
|---|---|
| Chave do mapa | `adapter:conta`, com `conta = account_scope(chave)` (SHA-256 hex, `adom_core::account_scope`) — o MESMO valor da fila, do marker e do `dead:`; `Vault::scope_of` recusa serviço ou chave vazios |
| Entrada | `Vault::ingest(encoded, now)` decodifica o `encoded` com `resolve_native::debrid_config` (o caminho do `/resolve`, com o `RESOLVE_SECRET` do operador) e guarda só se houver adaptador |
| Quem alimenta | `tail_effects::effects` chama `ingest` **antes** de rotear qualquer efeito — inclusive lote que só tem `dub_audit` |
| TTL | `Policy::key_ttl_ms` = `DEBRID_AUTO_FETCH_TTL` (default `6 * 3600` s → **6 h**) × 1000; expirada é apagada na leitura |
| LRU | teto `DEBRID_AUTO_FETCH_VAULT_MAX` (default **64**, clamp 1..1024); sai sempre o de `seq` mais baixo (uso mais antigo), **nunca** o escopo recém-inserido; `key()` conta como toque, `sweep(now)` poda e `forget(scope)` descarta a conta |
| Leitora única | a fábrica por conta (`ports::factory`), que chama `Vault::key(scope, now)` **a cada passo**; o laço do worker nunca guarda chave nem adaptador entre lotes |
| `Debug` | `Secret` imprime `<redacted>`; `Vault` imprime `Vault { contas, ttl_ms, cap }` — **nunca** escopo nem chave. Não há `Serialize`; o painel só mostra `vaultAccounts` (contagem) |
| Zeragem | `Secret` sobrescreve o próprio buffer com `0` no `Drop` (expirada, esquecida ou evictada) |
| Existência | `shared_vault()` devolve `None` quando `AUTOFETCH_WORKER != "on"`: sem consumidor, o processo não guarda chave de usuário |
| Persistência | **nenhuma**: não grava em KV, disco nem env; não loga a chave nem em erro de decodificação (devolve `None`) |

### O que o cofre NÃO cobre

1. **Não se repõe no boot.** Não existe credencial persistida — por desenho. A
   fila (`autofetch:v3:q:`) e os lotes (`autofetch:v3:lot:`) **sobrevivem** ao
   restart no KV e o worker os conta no boot (`hydrate`), mas, sem chave, cada
   passo é **pulado** com o motivo `no-credential` até uma busca nova alimentar
   o cofre. Na prática: a fila espera, não morre — e não há como drená-la sem
   alguém usando o addon.
2. **Não sobrevive a restart nem a reciclagem de processo.** Qualquer restart do
   gateway zera o cofre por inteiro (e, com ele, as chaves de todas as contas).
   O `in_flight`/fila em RAM do warmer e os contadores do ciclo também zeram.
3. **Não cobre chave trocada no cliente.** A chave nova entra no próximo
   `encoded` e cria um escopo novo; o escopo antigo expira pelo TTL (a fila
   antiga daquela conta continua lá, órfã de credencial).
4. **Não cobre a conta do operador sem `dk`.** Sem `encoded` com chave, o efeito
   volta ao Node (ver abaixo) — não há leitura de `DEBRID_API_KEY` como atalho
   dentro do cofre.

### O que ainda falta para o flip

1. **A fábrica de produção (cinco serviços) — ENTREGUE** (`0159b9f2`).
   `autofetch/build.rs` monta `Build` (cliente HTTP, KV, `cache.db`, **um**
   `RdGateExecutor` por processo, `RdKvStore` e o ledger) e devolve a
   `factory(vault)` sobre `ports::factory`; `boot::production_factory` só a cria
   com `AUTOFETCH_WORKER=on` **e** cofre vivo. O `AdapterBuilder` escolhe o
   serviço (`alldebrid`/`torbox`/`premiumize`/`realdebrid`/`debridlink`);
   serviço fora dos cinco devolve `None` e o passo é pulado, nunca erro do lote.
2. **Boot — FIADO.** `autofetch::spawn()` continua passando `None`, mas isso
   agora significa "monte a de PRODUÇÃO quando a trava estiver ligada"
   (`boot::spawn_at`); `spawn_with(Some(factory))` ficou como injeção de teste.
   A fábrica usa o MESMO `RdGateExecutor`/`RdKvStore` das outras pontas do
   processo, e sem cliente HTTP o worker volta a `prepared` em vez de quebrar o
   boot.
3. **Varreduras AllDebrid — agendador FIADO, `Apply` ainda freado** (`bf846820`
   + `016b3690`). `al_sweeps` (`rust/crates/adom-server/src/al_sweeps.rs`, ligado
   em `main.rs`) monta os fatos, respeita `DEBRID_AL_SWEEP_MS` e roda as quatro
   decisões puras com `may_delete` fail-closed. Mas a listagem nativa não prova
   posse (`adsub`), retenção (`adprot`) nem a fila `sup:` — fatos do `cache.db`
   do Node —, então `DEBRID_AL_CLEANUP=on` fica em `ReadOnly`
   (`native::ROW_PROOFS_COMPLETE`). **Correção da leva C1:** a gravação do
   `adrm` da EVICÇÃO não está mais sem fio — `evict_job::mark_removed`
   (`autofetch/evict_job.rs:352-378`) grava `{"at":now}` e nunca poda marca, gated
   por `DEBRID_REUPLOAD_BLOCK` e com o TTL de `ALLDEBRID_REUPLOAD_BLOCK_TTL_MS`.
   Sem fio continua só o `adrm` das VARREDURAS (`al_sweeps`, `ReadOnly`).
4. **Flip B4 — pendente, e menor do que era.** A trava já está `on` no compose
   (`94268f0a`) e o laço já consome os passos. Falta a bateria de aceitação com
   duas contas de serviços diferentes e o **flip do TS**. O que ainda prende o
   TS ao Node não é mais "passo sem chamador": são os fatos que nascem lá
   (marker com `obra`, registro F2 `autofetch:v3:o:<digest>`, `adsub`/`adprot`,
   `pf:`) e o `harvester_enqueue`.

Com a fábrica e o boot fiados, o gate deixou de ser o bloqueio do worker: quem
ainda decide o destino de um efeito é o seam do tail (escopo derivável ou não,
canal aceitando ou não) e, depois do aceite, o próprio passo. O que continua no
Node é o que depende de FATOS que o gateway não produz — ver a seção seguinte.

---

## O que a leva C1 mudou no gate (2026-10-28)

As três peças novas (evicção F6, dreno da represa e sonda dirigida) **não
carregam `dk`**. Elas recebem o mesmo vocabulário que o cofre já fala:
`adapter:sha256(chave)`, nunca a chave crua.

| Peça | Como chega à credencial |
|---|---|
| `adom_autofetch::v3::evict` via `evict_step` | nada de chave: o plano é puro (`EvictFacts`/`EvictGates`); quem toca a conta é o `&dyn AutofetchDebrid` já resolvido pela fábrica |
| `suppressed_step::drain` | recebe a `DebridFactory` e resolve `adapter:conta` **por entrada**; escopo sem chave viva é `kept`, não falha |
| `probe_step` | nenhuma credencial: pede a obra ao colhedor NATIVO (`HarvestHandle::enqueue` com `brProbe`) e grava o lease no KV |
| `season_step` | nenhuma credencial: `adapter_id` + `account` (digest) vêm do payload do efeito |

**O escopo é `adapter:sha256(chave)` nos quatro.** Em `season_key` o `account`
do payload JÁ É o digest, e `tail_effects::payload_scope` monta o escopo sem
re-hashear; nos outros o caminho é o cofre (`Vault::ingest` →
`Vault::scope_of`). O `drain` da represa é o único que resolve a conta no meio
da passagem: ele relê o registro e usa o **id atual**, para não apagar um
transfer que outro ator trocou.

**A fábrica vem de `autofetch/build.rs`** (`0159b9f2`): `Build::new` cria o
cliente HTTP, compartilha o KV e o `cache.db`, cria **um** `RdGateExecutor` por
processo e devolve `factory(vault)` sobre `ports::factory`. É a MESMA fábrica
que o laço recebe — então a chave é lida do cofre a cada passo, e nenhum passo
guarda adaptador entre lotes.

Kill-switches que continuam valendo na credencial:

- evicção: `DEBRID_AUTO_FETCH_EVICT_FALLBACK` (default **false**) e, por cima,
  `DEBRID_AL_CLEANUP_KILL`; teto `DEBRID_EVICT_MAX_PER_CALL` (só aperta);
- represa: `DEBRID_SUPPRESSED_DRAIN_MAX` (teto por passagem) e
  `DEBRID_SUPPRESSED_TTL` preservado ao reagendar o `nextAt`;
- sonda: `AUTOFETCH_BR_PROBE` **e** `RELEASE_INDEX` (sem índice não há onde
  escrever), além da pausa do worker;
- Season Pack Fill: `DEBRID_AUTO_FETCH_SEASON_FILL` e
  `DEBRID_AUTO_FETCH_SEASON_INDEX_MAX` (`0` desliga só o índice).

O que ainda depende de FATOS do Node (não é fiação do gateway): o marker com
`obra` e o registro F2 `autofetch:v3:o:<digest>` nascem na ponte napi
(`adom-napi/src/autofetch/state_v3.rs`), e o `enqueue` nativo grava marker SEM
meta (`enqueue.rs:331`); `adsub`/`adprot` e `pf:` também. Sem eles a evicção é
fail-closed (`evict-no-marker`/`evict-no-record`). As duas pendências de fiação
da leva anterior **fecharam**: `suppressed_step::register_factory` é chamado em
`boot::spawn_at` (`autofetch/boot.rs:110-112`) e `mod evict_step;` está
declarado em `autofetch/mod.rs:55-56`.

## A trava `AUTOFETCH_WORKER` (default conservador)

| Item | Contrato |
|---|---|
| Valor que liga | só o literal `on` (`autofetch/mod.rs:127-129`: `var("AUTOFETCH_WORKER").map(\|v\| v == "on") == Ok(true)`) |
| Ausente / vazio / `1` / `true` | `prepared`: canal desligado, efeito volta ao Node |
| Sem trava | `boot::production_factory` devolve `None` antes de qualquer I/O (`boot.rs:44-51`) e `shared_vault()` não cria cofre (`vault.rs:235-242`) |
| Trava ligada, sem cofre | `production_factory` devolve `None` + log "worker fica prepared" (`boot.rs:52-55`) |
| Trava ligada, sem cliente HTTP | `Build::new` devolve `None` (`build.rs:66-79`): `prepared` |
| Trava ligada, sem KV | `open_kv` falha ⇒ `spawn_at` devolve `None` (`boot.rs:102`) |

**Ausência de chave nunca derruba o boot.** Chave ausente é escopo sem cofre: o
passo é pulado com `no-credential` (`serve_jobs.rs:107-110`), a fila persistida
espera no KV e nada vira erro de processo. O mesmo vale para `br_probe` sem
colhedor: o `submit` devolve `false` e o efeito volta ao Node
(`mod.rs:99-101`) — recusa de trabalho, não falha de boot.
