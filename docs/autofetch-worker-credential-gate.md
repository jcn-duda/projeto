# Gate de credencial do worker nativo do Chupim (T3-L5/L6)

**Status (2026-10-28, branch `rust` @ `721512eb`):** a **opção (2) — cofre em
memória por conta — está IMPLEMENTADA** (`d51f53c0`, refinada por `d50a7bdd` e
`4e0617e6`). O worker nativo existe de ponta a ponta, mas continua **desligado
por padrão**: sem `AUTOFETCH_WORKER=on` o cofre nem é criado e os efeitos do
Chupim seguem ao Node (só o `dub_audit` é nativo incondicional). O que ainda
falta não é o cofre — é a **fábrica de produção** dos cinco adaptadores e o flip
(fim deste documento).

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

1. **A fábrica de produção (cinco serviços).** `autofetch::ports` já tem o
   adaptador (`PortedDebrid` sobre `adom_debrid::autofetch_ports`, construtores
   `realdebrid`/`alldebrid`/`torbox`/`premiumize`/`debridlink`) e a
   `factory(vault, build)`; **não existe o `AdapterBuilder` de produção** que
   escolha o serviço e monte as portas. Hoje só o duplo de teste
   (`fakes.rs::factory_for`) e os testes de `ports_tests.rs` chamam a fábrica.
2. **`spawn_with(Some(factory))` no boot.** `autofetch::spawn()` (chamado em
   `proxy.rs`) passa **`None`** de propósito: `enabled = worker_enabled() &&
   debrid.is_some()`, então **mesmo com `AUTOFETCH_WORKER=on` o worker fica
   `prepared`** e `submit` devolve `false`. O `TODO(flip)` em
   `autofetch/worker.rs` explica o porquê: montar a fábrica exige o
   `RdGateExecutor`/`RdUncertainStore` **compartilhados** com o play nativo, e
   nenhum dos dois nasce hoje no `adom-server`.
3. **Varreduras AllDebrid no boot.** `adom-debrid/src/alldebrid_sweeps*.rs`
   (`bf846820`) entrega as quatro decisões puras e o executor com `may_delete`
   fail-closed, mas o próprio módulo declara "fora desta fatia (wiring no
   gateway, não feito aqui)": montar fatos, agendar e gravar o `adrm` continua
   no Node.
4. **Flip do kill-switch** (default `on` ou `on` no compose) e a bateria de
   aceitação com duas contas de serviços diferentes.

Enquanto a fábrica de produção e o `spawn_with(Some(..))` não fecham, o efeito
do Chupim continua **voltando ao Node** pelo seam do tail — é ele que paga o
gate na prática.
