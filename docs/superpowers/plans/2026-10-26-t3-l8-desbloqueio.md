# T3-L8 remesida — a cadeia de desbloqueio real das varreduras AllDebrid

> Complemento de medição para a fatia **T3-L8** ("varreduras AllDebrid nativas
> e fim do debrid TS") do plano
> [`2026-10-24-fechamento-total-migracao-ts-rust.md`](2026-10-24-fechamento-total-migracao-ts-rust.md).
> A tabela de premissas falsas daquela fatia foi registrada no commit
> `8dd9086d`; este doc mede o que a próxima sessão precisa para EXECUTAR a
> fatia sem re-medir nada. Não altera o plano nem
> `docs/debrid-al-check-rust.md`.

**Medido em:** 2026-10-26, branch `rust` @ `8dd9086d` (worktree principal).
**Método:** `grep -rn` + leitura direta; comando e resultado citados junto de
cada afirmação. Nada aqui é estimativa.

---

## 1. Resumo da cadeia

A T3-L8 é a última fatia do debrid TS e é a que apaga conteúdo pago. Hoje ela
está bloqueada por DUAS filas de chamadores vivos:

1. **T3-L5+T3-L6 (Chupim nativo)** derrubam 16 dos 20 importadores de
   produção de `protected.ts`, todos os chamadores de `alldebrid-inventory.ts`
   fora do `src/debrid/`, 3 de `alldebrid-reupload.ts` e o ÚLTIMO chamador do
   check orquestrado do Node (`autofetch-recheck.ts:234`) — o que torna a
   família `alldebrid-check/evict/reconcile/suppressed-revalidate/play`
   inalcançável de vez.
2. **T3-L7b (rd-warmer nativo)** derruba `src/providers/rd-warmer.ts:12`.
3. **Nenhuma leva derruba** o que sobra: os timers do operador
   (`addon.ts:58-74` → `env-ops.ts`), as 12 ações destrutivas do painel
   (`dashboard-actions.ts`) sobre `catalog-env.ts` + `catalog-cleanup/dedup`,
   o feed `/internal/debrid/marked` e o script `scripts/clean-undubbed.ts`.
   **É isso que a T3-L8 absorve** — não "as quatro varreduras" do plano
   original.

Ordem segura: **T3-L5 + T3-L6 (mesma leva, fila `v3` por sha da busca) →
T3-L7b → T3-L8**. Portar só o corpo das varreduras antes disso deixaria duas
cópias do único código que apaga acervo (decisão já registrada no plano,
§T3-L8).

---

## 2. Estado de partida medido

Comando → resultado (2026-10-26, `rust` @ `8dd9086d`):

```text
grep -rln "debrid/protected\|'\./protected" src --include="*.ts"
  → 20 arquivos de produção (13 fora + 7 dentro de src/debrid/)
grep -rln "src/debrid/protected" test --include="*.ts" | wc -l
  → 60 arquivos de teste
find src -name "autofetch*.ts" ! -path "*/routes/*" | wc -l  → 30 (5.369 linhas)
find src -name "autofetch*.ts" | wc -l                        → 32 (+2 rotas do painel)
wc -l src/debrid/alldebrid*.ts src/debrid/protected.ts src/debrid/inventory-memo.ts
  → 2.858 linhas (família em src/debrid/)
ls rust/crates/adom-server/src/autofetch/  → não existe (worker nativo ainda não)
ls rust/crates/adom-autofetch/src/         → lib, queue, state, suppressed, terminal (T3-L4 feita)
```

Correções de caminho que o plano original (e notas antigas) erravam e que a
medição fechou: `src/providers/live-check.ts` e `src/providers/dub-audit.ts`
**não existem mais** (`dub-audit` saiu na T3-L7a, `1403d68a`); o `live-check`
hoje é `src/debrid/live-check.ts`, consumido só por
`src/routes/stream-trace.ts:28`, com allowlist fechada
(`ALLOWED_RAW = torbox, premiumize`; `NEVER_LIVE = alldebrid, realdebrid,
debridlink` — `live-check.ts:29-38`).

---

## 3. Mapa de `src/debrid/protected.ts` (288 linhas)

### 3.1 O que o arquivo é

Duas camadas de proteção contra a limpeza automática
(`protected.ts:1-22`):

- **`held` (volátil, `Map` em memória):** o hash escolhido para baixar agora,
  TTL do autofetch. `hold`/`release`/`isHeld` (`:50-70`).
- **`adprot:v1` (durável):** registro `{acceptedAt, readyAt}` por
  adapter+conta+hash, **escrito pela ponte napi `NativeKv`**
  (`kvSet`/`kvPeek`/`kvForget`/`kvKeys`/`kvRemaining` —
  `src/utils/native-kv.ts:40-97`), não pelo `cache.ts` do Node.
  `protectBr` (`:93`), `noteReady` (`:109`), `reconcile` (`:147`),
  `unprotect` (`:169`), `pruneMissing` (`:259`).

Exports (`protected.ts:287`): `hold`, `release`, `isHeld`, `protectBr`,
`noteReady`, `unprotect`, `reconcile`, `isDurablyProtected`,
`isCleanupProtected`, `pruneMissing`, `heldHashesFor` (+ tipo `HoldAudit`).
`heldHashesFor` (`:222-247`) é a prova de cobertura que o feed de holds
entrega ao gateway (`complete` fail-closed).

Escrituras `adprot` no TS: `:98`, `:123`, `:155`, `:163`, `:174`, `:274`,
`:280`. `HELD_ADAPTER = 'alldebrid'` (`:32`) — só o AllDebrid recebe proteção
durável; o `hold` volátil, porém, é consultado pelo Premiumize também (§3.2).

### 3.2 Os 20 importadores de produção em `src/`

Funções usadas por arquivo, medidas com
`grep -o "held\.[a-zA-Z]*" <arquivo> | sort -u`:

**Fora de `src/debrid/` (13) — todos do Chupim/efeitos, todos morrem com
T3-L5+L6, exceto os dois marcados:**

| # | Importador | Usa | Papel |
|---|---|---|---|
| 1 | `src/providers/autofetch-runner.ts:15` | `protectBr`, `release` | marker pós-aceite (`protectBr` depois do enqueue) e liberação |
| 2 | `src/providers/autofetch-candidates.ts:10` | `hold` | hold ANTES da checagem (candidato escolhido) |
| 3 | `src/providers/autofetch-recheck.ts:6` | `hold`, `noteReady`, `protectBr`, `release`, `unprotect` | ciclo completo do recheck |
| 4 | `src/providers/autofetch-settle.ts:2` | `release` | libera no settle |
| 5 | `src/providers/autofetch-gates.ts:23` | `release` | libera nos gates |
| 6 | `src/providers/autofetch-seeds-pool.ts:3` | `release` | libera no pool seeds |
| 7 | `src/providers/autofetch-terminal.ts:21` | `release`, `unprotect` | estado terminal destrava `adprot` |
| 8 | `src/providers/autofetch-drain.ts:15` | `isHeld`, `isDurablyProtected` | dreno respeita proteção |
| 9 | `src/providers/autofetch-evict.ts:37` | `isHeld`, `isDurablyProtected` | evicção 8.16 respeita proteção |
| 10 | `src/providers/autofetch-expired.ts:17` | `isCleanupProtected` | expirados respeitam proteção |
| 11 | `src/providers/rd-warmer.ts:12` | `isHeld` | warmer RD não aquece hash em download — **morre na T3-L7b** |
| 12 | `src/utils/catalog-cleanup.ts:10` | `isCleanupProtected` (`:68`) | limpeza do catálogo pula protegido — **fica para a T3-L8** |
| 13 | `src/utils/catalog-dedup.ts:10` | `isCleanupProtected` (`:38`, `:239`) | dedup do catálogo pula protegido — **fica para a T3-L8** |

**Dentro de `src/debrid/` (7) — a própria família AllDebrid:**

| # | Importador | Usa | Papel |
|---|---|---|---|
| 14 | `alldebrid-check.ts:4` | `noteReady`, `reconcile` (`:159`) | corpo TS do check: assenta/reconcilia `adprot` na leitura |
| 15 | `alldebrid-cleanup.ts:4` | `isCleanupProtected` (`skipCleanup :20`), `isHeld` (`:176`), `unprotect` (`:185`), `pruneMissing` (`:163`) | as duas varreduras + gate `skipCleanup` |
| 16 | `alldebrid-cleanup-facts.ts:31` | `heldHashesFor` (import nomeado) | fatos do feed `/debrid/check` e `/internal/debrid/holds` |
| 17 | `alldebrid-suppressed-revalidate.ts:46` | `isHeld` | revalidação dos suprimidos não apaga em download |
| 18 | `premiumize.ts:4` | `isHeld` (`:334`) | **sweepDead do PREMIUMIZE** respeita hold volátil — não morre com a família AllDebrid |
| 19 | `rust-link-facts.ts:10` | `isCleanupProtected` (import nomeado) | fato `held` do `resolveLink` no wrap nativo (`rust-remote.ts:329`) |
| 20 | `rust-resolve-magnet.ts:3` | `unprotect` (`:27`) | efeito DubLie do PLAY NATIVO destrava `adprot` (`applyMagnetEffect`, chamado por `rust-resolve-apply.ts` e `internal-resolve.ts:26`) |

### 3.3 Testes

60 arquivos em `test/` importam `src/debrid/protected.js` (grep acima). Os 8
`test/alldebrid-*.test.ts` estão todos em `testFiles` (`package.json`): 
`alive-cache`, `dead-status`, `delete-gate`, `evict`, `reconcile`,
`reupload-inventory`, `reupload`, `submitted`. Saem na mesma fatia dos
arquivos que cobrem.

---

## 4. Inventário real da família AllDebrid em `src/debrid/`

Arquivos que existem de verdade (13 + suportes; linhas medidas):

| Arquivo | Linhas | O que é |
|---|---|---|
| `alldebrid.ts` | 40 | fachada/re-export do adapter |
| `alldebrid-api.ts` | 272 | cliente cru (`call`, `id`, `isDeadMagnet`, `ACTIVE_STATES`, `magnetFiles`) |
| `alldebrid-check.ts` | 277 | corpo TS do `checkCached` + os 3 agendamentos destrutivos (`:252`, `:258`, `:263`) |
| `alldebrid-cleanup.ts` | 296 | `enqueueDelete`/`deleteMagnets`/`skipCleanup`/`sweepDead`/`sweepUndubbed` |
| `alldebrid-cleanup-facts.ts` | 134 | fatos (`heldHashes`/`knownBefore`/`inventoryLoaded`) para a checagem nativa |
| `alldebrid-evict.ts` | 166 | evicção por busca 8.16 (`scheduleEvict`) |
| `alldebrid-fallback-evict.ts` | 137 | evicção de fallbacks (`evictFallbacks`) |
| `alldebrid-inventory.ts` | 328 | DONO de `knownBefore`/`submitted`/`adsub` (`persistSubmitted :113`) |
| `alldebrid-play.ts` | 214 | `resolveLink`/`enqueue`/`torrentStatus`/`removeTorrent` TS |
| `alldebrid-reconcile.ts` | 214 | reconcile em fundo (`scheduleReconcile`) |
| `alldebrid-reupload.ts` | 175 | anti-reenchimento `adrm` (`markReuploadBlocked :98`, `unblockIfInventoryReady`) |
| `alldebrid-suppressed-revalidate.ts` | 245 | revalidação dos suprimidos (`scheduleSuppressedRevalidate`) |
| `protected.ts` | 288 | §3 |
| `inventory-memo.ts` | 72 | memo `dinv` do inventário |
| `rust-check-blocked.ts` | 60 | `adoptBlockedReady` (⚡ escondido pelo filtro nativo) |
| `rust-link-facts.ts` | 21 | fato `held` do resolve |
| `rust-resolve-magnet.ts` | 30 | aplicação do efeito magnet do play nativo |
| `catalog-env.ts` | 333 | wrapper do catálogo do OPERADOR (11 ações) |
| `env-ops.ts` | 99 | timers do operador (`warmupEnv`, `sweepDeadEnv`, `sweepUndubbedEnv`, `sweepDeadCurrent`) |

Satélites fora de `src/debrid/`: `src/utils/catalog-cleanup.ts` (169),
`src/utils/catalog-dedup.ts` (318), `src/utils/rust-debrid-clean.ts` (28),
`src/providers/debrid-cache-steps.ts` (158), `src/routes/internal-debrid-holds.ts`
(110), `src/routes/internal-debrid-marked.ts` (124),
`scripts/clean-undubbed.ts` (218).

### 4.1 Chamadores de `alldebrid-inventory.ts` (todos, com `file:line`)

Produção, diretos:

| Chamador | Importa | Uso |
|---|---|---|
| `alldebrid-check.ts:9` | `preexisting`, `knownBefore`, `waitInventory`, `rememberSubmitted`, `forgetSubmitted` | corpo TS do check |
| `alldebrid-play.ts:6` | `rememberSubmitted`, `waitProvenanceReference` | play TS |
| `alldebrid-cleanup.ts:10` | `preexistingHashes` | `sweepUndubbed` espera o snapshot frio (`:238`) |
| `alldebrid-cleanup-facts.ts:32` | `inventoryFacts` | fatos da checagem nativa |
| `alldebrid-evict.ts:34` | `preexistingHashes` | evicção 8.16 (`:97`) |
| `alldebrid-fallback-evict.ts:31` | `forgetSubmitted`, `submittedAt` | evicção de fallbacks |
| `alldebrid-reconcile.ts:52` | `preexistingHashes`, `forgetSubmitted`, `submittedAt` | reconcile (`:128`) |
| `alldebrid-suppressed-revalidate.ts:51` | `forgetSubmitted`, `submittedAt` | revalidação |
| `providers/autofetch-expired.ts:18` | `knownBefore`, `submittedAt` | Chupim |
| `providers/autofetch-evict.ts:43` | `hasDurableOwnership` | Chupim (`:218`) |
| `routes/internal-debrid-marked.ts:28` | `rememberSubmittedProven` | **feed do gateway**: posse `adsub` do que a checagem NATIVA subiu |

Via re-export do adapter (`alldebrid.ts:26`: `warmInventory`,
`preexistingHashes`, `hasDurableOwnership`):

- `env-ops.ts:29-38` — `warmInventory` no boot (`addon.ts:58`).
- `catalog-env.ts:195-198` — `operatorKnownHashes` → `adapter.preexistingHashes`
  (usado por `cleanupApplyEnv :288` e `cleanupPreviewEnv :272`).

### 4.2 Chamadores de `alldebrid-reupload.ts` (todos, com `file:line`)

| Chamador | Importa | Uso |
|---|---|---|
| `alldebrid-check.ts:12` | `filterReuploadBlocked`, `unblockIfInventoryReady` | corpo TS do check |
| `alldebrid-play.ts:8` | `reuploadBlocked`, `unblockIfInventoryReady` | play TS |
| `alldebrid-cleanup.ts:8` | `markReuploadBlocked` | `sweepUndubbed` marca o que saiu (`:284`) |
| `alldebrid-evict.ts:37` | `markReuploadBlocked` | evicção 8.16 |
| `alldebrid-fallback-evict.ts:30` | `markReuploadBlocked` | evicção de fallbacks |
| `alldebrid-reconcile.ts:55` | `markReuploadBlocked` | reconcile |
| `catalog-env.ts:8` | `markReuploadBlocked` | `reuploadHook` (`:56-63`), injetado em `dedupApplyEnv :135`, `manualDeleteEnv :233`, `cleanupApplyEnv :304` |
| `rust-check-blocked.ts:16` | `unblockIfInventoryReady` | `adoptBlockedReady`, chamado no WRAP da checagem (`rust-remote.ts:302`) — vivo enquanto o wrap do check existir |
| `providers/autofetch-candidates.ts:11` | `reuploadBlocked`, `unblockIfInventoryReady` | Chupim |
| `providers/debrid-cache-steps.ts:9` | `reuploadBlocked` | enriquecimento ⚡ sem `cacheCheck`; ÚNICO consumidor é `autofetch-batch.ts` (Chupim) |
| `scripts/clean-undubbed.ts:126` | import dinâmico (`reuploadBlocked`/`forgetReuploadBlock`) | CLI `--unblock` do operador |

---

## 5. Onde mora o gate de deleção hoje

### 5.1 O que já é nativo e incondicional (contrato R3)

- **A regra `pode apagar?`**: `mayDeleteHash`
  (`src/utils/rust-debrid-clean.ts:20-25`) chama o núcleo
  `adom_core::debrid_may_delete::may_delete` (`debrid_may_delete.rs:15-17`;
  `inventory_loaded && !known_before && !protected` — fail-closed). O TS só
  transporta os fatos.
- **A higiene da checagem** (`dropReady`/`dropUncached`): rota
  `POST /debrid/check` nativa com `inventoryLoaded`/`knownBefore`/
  `heldHashes`/`holdsComplete`/`dropReady`/`dropUncached`
  (`adom-debrid/src/api_dispatch.rs:82-85`; contrato §8.4); gate
  `CleanupGate` (`cleanup_plan.rs:14-42`) com supressão
  `kill_switch`/`holds_incomplete`/`no_drop_flags`/`inventory_missing`; fila
  de delete nativa (`alldebrid_delete.rs` — porte de `deleteMagnetsNow`: gate
  por conta, 4 workers, backoff 400/800/1600, kill-switch relido a cada
  tentativa). A higiene NUNCA grava `adrm`
  (`docs/debrid-al-check-rust.md` §8.2/§8.6).
- **A leitura do estado durável** (`adprot`/`adsub`/`adrm`):
  `cleanup_durable.rs` é read-only — o cabeçalho diz "Nada aqui grava"
  (`:1-5`), e em produção o `Store` é aberto READ-ONLY contra o `cache.db`
  (`api.rs:81` → `store.rs:56-65`, `read_only: true`). A lista
  `WRITABLE_PREFIXES` (`store.rs:20-31`, inclui `adsub`/`adrm`/`adprot`/
  `autofetch:v3`) é a INTENÇÃO de dono, não o estado atual.
- **Flags**: `DEBRID_AL_CLEANUP` (código OFF, compose ON),
  `DEBRID_AL_HOLDS` (feed, compose ON), `DEBRID_AL_CLEANUP_KILL`
  (`.env.example:1281-1297`).

### 5.2 O que ainda roda no Node

- **O gate único por conta (`enqueueDelete`) é inline** em
  `alldebrid-cleanup.ts:49-65`, serializando `deleteMagnets` (`:90-96`) por
  `accountScope`. O arquivo `alldebrid-delete-gate.ts` **não existe**
  (`rg --files src | rg alldebrid-delete-gate` → vazio);
  `test/alldebrid-delete-gate.test.ts` cobre o corpo inline.
- **As varreduras de conteúdo**, todas com escrita `adrm`/`adprot`:
  - Timers do processo: `addon.ts:58` (`warmupEnv`), `:62-64` (`sweepDeadEnv`
    + interval), `:70-74` (`sweepUndubbedEnv` + interval defasado) →
    `env-ops.ts:47-93` despacha pelo adapter do `.env`
    (`config.debrid.service`). **O Premiumize tem `sweepDead` próprio**
    (`premiumize.ts:300`) e é alcançado pelo mesmo despacho.
    **Painel**: `dashboard-actions.ts:55-57` (`sweep-dead` =
    `sweepDeadCurrent ?? sweepDeadEnv`), `:210-284` (11 ações de catálogo:
    `catalog-scan`, `catalog-report`, `dedup_preview`, `dedup`, `catalog-list`,
    `catalog-manual`, `audit_requeue`, `audit`, `cleanup-preview`/
    `cleanup-apply` — a lista de ações em `:35-43`) → `catalog-env.ts`
    (usa `preexistingHashes`, `adapter.deleteMagnets`, `markReuploadBlocked`,
    `held.isCleanupProtected`).
  - Agendados no corpo TS do check: `scheduleEvict`
    (`alldebrid-check.ts:252`), `scheduleReconcile` (`:258`),
    `scheduleSuppressedRevalidate` (`:263`). **No corte default eles NÃO
    rodam**: `registry.current()` envolve o adapter com o wrap nativo quando
    o serviço está em `DEBRID_RUST_SERVICES` (`registry.ts:68`) e o corpo TS
    do check só é alcançado num install que EXCLUA o `alldebrid` dessa env
    (default do `.env.example:1260` inclui). O último chamador que chega ao
    check orquestrado é o Chupim: `autofetch-recheck.ts:234`
    (`debrid.checkCached`) — não há outro (`grep -rn "\.checkCached(" src`
    fora de `src/debrid/` → só esse).
- **Feeds para a nativa** (loopback + token):
  - `POST /internal/debrid/holds` (`internal-debrid-holds.ts`) →
    `alldebridHoldsFeedFacts` (importada em `internal-debrid-holds.ts:30`) →
    `heldHashesFor` (`protected.ts:222`) + `inventoryFacts`. Existe porque o
    hold volátil é memória DESTE processo (pendência registrada na T2-L6,
    plano `:2449-2451`).
  - `POST /internal/debrid/marked` (`internal-debrid-marked.ts:28` →
    `rememberSubmittedProven`) → grava `adsub` do que a checagem NATIVA subiu.
    É a única escritora de `adsub` viva no caminho do `/stream`.

### 5.3 Donos de `adsub`/`adrm`/`adprot` hoje

**Escritor: o Node, pela ponte napi `NativeKv`** (`native-kv.ts:63-79`;
mesma tabela `cache` do `data/cache.db`, escrita IMEDIATA — sem L1, sem
despejo diferido; `RUST_OWNED` + `RUST_OWNED_PREFIXES` cobrem os três,
`cache-keys.ts:210/236-238`):

| Namespace | Quem grava (TS) | Onde |
|---|---|---|
| `adsub:v1` | `alldebrid-inventory.ts` | `:113` (`persistSubmitted`), `:169` (`forgetSubmitted`); rota `marked` via `rememberSubmittedProven` |
| `adrm:v1` | `alldebrid-reupload.ts` | `:98` (`markReuploadBlocked`), `:118` (`forgetReuploadBlock`) |
| `adprot:v1` | `protected.ts` | `:98`, `:123`, `:155`, `:163`, `:174`, `:274`, `:280` |

**Leitor: o gateway**, read-only (`cleanup_durable.rs`, `DurablePeek`); a
partição de upload do `/magnet/upload` nativo expurga `adrm`
(`rust-check-blocked.ts` do lado Node). O `cache.ts` do Node recusa
leitura/escrita desses prefixos (guarda `isRustOwnedPrefix`).

---

## 6. A cadeia de desbloqueio: quem derruba o quê

### 6.1 T3-L5 + T3-L6 (Chupim nativo — BLOQUEADAS juntas pelo formato da fila, plano `:2159-2182`)

Derrubam (com prova de chamador acima):

- 10 arquivos `autofetch-*` importadores de `protected.ts` (§3.2 #1-10) e o
  restante dos 30 `autofetch*.ts` (5.369 linhas hoje).
- Chamadores Chupim de `inventory`/`reupload`: `autofetch-expired.ts:18`,
  `autofetch-evict.ts:43` + `adapter.evictFallbacks` (`:243`, exportado por
  `alldebrid.ts:28`), `autofetch-candidates.ts:11`,
  `debrid-cache-steps.ts:9` (único consumidor: `autofetch-batch.ts`).
- O ÚLTIMO chamador do check orquestrado (`autofetch-recheck.ts:234`) e do
  `debrid.enqueue` (`autofetch-recheck.ts:146`, `autofetch-runner.ts:104`).
  A partir daí `cache-check.checkCached` e `alldebrid-check.ts` (e os três
  agendados, e `alldebrid-play.ts`) ficam sem NENHUM caminho de produção —
  nem unwrapped, pois `live-check` é allowlist torbox/premiumize e o
  `dub-audit` (último consumidor de `actions.resolveLink`) já saiu na
  T3-L7a (`grep -rn "\.resolveLink(" src` fora de `src/debrid/` → vazio).
- O feed `/internal/debrid/holds`: o hold volátil migra para o Rust
  (contrato §8.1 item 2 — "`Holds` ... o autofetch nativo futuro chama
  `hold(account, hash, ttl)`; hoje nenhum chamador de produção o preenche").
  **Atenção de ordem**: apagar a rota ANTES do hold nativo existir deixa a
  limpeza nativa read-only para sempre (fail-closed por desenho).

### 6.2 T3-L7b (rd-warmer nativo — PENDENTE, plano `:2917-2949`)

Derruba `src/providers/rd-warmer.ts:12` (`held.isHeld`), as ações
`warm-pause`/`warm-resume`/`warm-drain` do painel
(`dashboard-actions.ts:97-114`) e o `warm` do `/diagnostics`. Move `rdq:v1`
para o gateway.

### 6.3 Nenhuma leva derruba — é o escopo REAL da T3-L8

| Chamador vivo | O que a T3-L8 precisa absorver |
|---|---|
| `addon.ts:58-74` + `env-ops.ts` | worker nativo das varreduras do operador (`warmInventory`, `sweepDead`, `sweepUndubbed`) no gateway, com os MESMOS kill-switches |
| `dashboard-actions.ts:55-57` (`sweep-dead`) | rota administrativa nativa (padrão F4.4a, `{"confirm": true}`) |
| `dashboard-actions.ts:210-284` (catálogo) | as 11 ações do `catalog-env.ts` + `catalog-cleanup.ts`/`catalog-dedup.ts` (487 linhas) — varredura destrutiva sobre o acervo do operador, com `preexistingHashes`, `markReuploadBlocked` e `isCleanupProtected` |
| `routes/internal-debrid-marked.ts` | fim do feed quando a posse (`adsub`) e o inventário (`knownBefore`) passarem a ser escritos pelo próprio gateway (o `Store` read-only de `api.rs:81` precisa virar escritor ou o estado migra de tabela) |
| `scripts/clean-undubbed.ts:126` | substituto do `--unblock` (rota admin) antes de apagar `alldebrid-reupload.ts` |
| `premiumize.ts:334` (`held.isHeld`) | decidir: sweep do Premiumize migra junto OU `protected.ts` sai só depois de um segundo passo |
| `rust-resolve-magnet.ts:27` (`unprotect`) | efeito do play nativo aplicado no Node (contrato atual, AGENTS.md: "efeitos do play (aplicação)") — mover a escrita `adprot` para o gateway muda esse contrato; decidir consciente |

### 6.4 O que a T3-L8 APAGA de fato (já sem chamador após 6.1/6.2)

`alldebrid-check.ts`, `alldebrid-evict.ts`, `alldebrid-fallback-evict.ts`,
`alldebrid-reconcile.ts`, `alldebrid-suppressed-revalidate.ts`,
`alldebrid-play.ts`, `rust-check-blocked.ts` (o wrap do checkCached de
`rust-remote.ts:285-314` fica sem chamador; o wrap do `resolveLink` também —
`actions.resolveLink` está órfão desde a T3-L7a),
`alldebrid-cleanup-facts.ts` (com o fim dos feeds), `cache-check.ts` (entrada
orquestrada; `peekDavail`/`noteUnavailable` têm consumidores próprios e
ficam), `actions.ts` (superfície `resolveLink`/`enqueue` sem chamador),
`rust-link-facts.ts`, `rust-resolve-magnet.ts`/`rust-resolve-apply.ts`
(se o contrato dos efeitos mudar — ver 6.3), mais os 8
`test/alldebrid-*.test.ts` e os 60+ imports de teste de `protected`.

---

## 7. Lista exata do que SOBRA para a T3-L8 cortar

Depois de T3-L5+L6 e T3-L7b fechadas, a T3-L8 corta (linhas medidas hoje — a
conta oficial é o `git diff --stat` da fatia):

| Grupo | Arquivos | Linhas |
|---|---|---|
| Varreduras + gate + API | `alldebrid-cleanup.ts`, `alldebrid-api.ts` (o que sobrar de chamador nativo), `env-ops.ts` (parte AllDebrid) | ~670 |
| Estado de posse/proteção | `alldebrid-inventory.ts`, `alldebrid-reupload.ts`, `protected.ts` (parcial — ver 6.3), `inventory-memo.ts` | ~863 |
| Catálogo do operador | `catalog-env.ts`, `utils/catalog-cleanup.ts`, `utils/catalog-dedup.ts` | ~820 |
| Feeds | `routes/internal-debrid-holds.ts` (se T3-L6 não o tiver apagado), `routes/internal-debrid-marked.ts`, `alldebrid-cleanup-facts.ts` | ~368 |
| Regra wrapper | `utils/rust-debrid-clean.ts` (a regra já é nativa) | 28 |
| CLI | `scripts/clean-undubbed.ts` (substituído por rota admin) | 218 |
| Testes | 8 `alldebrid-*.test.ts` + os de catálogo/holds/marked/gate + `testFiles` | — |

E o estado: `adsub`/`adrm`/`adprot` passam a ter ESCRITOR no gateway (hoje o
gateway é read-only no `cache.db`, `api.rs:81`) — **decisão de mecanismo é
parte da fatia**: o gateway grava direto no SQLite compartilhado (precisa
abandonar o read-only de `store.rs` com guarda de prefixo) ou um novo store
próprio. `cache-keys.ts`/`cache-quotas.ts` acompanham os namespaces.

**Definição de pronto (delta)** — hoje a §9 do plano exige: Chupim nativo
(`src/**/autofetch*.ts` inexistente — restam 30 fora das rotas do painel /
5.369 linhas) e `rd-warmer` nativo. A T3-L8 está pronta quando, ALÉM disso:

- [ ] `sweepDead`/`sweepUndubbed`/`warmInventory`/catálogo rodam no gateway com
  `DEBRID_AL_CLEANUP`/`DEBRID_AL_HOLDS`/`DEBRID_AL_CLEANUP_KILL` e teste de
  `cleanup_off` obrigatório (risco "kill-switch esquecido" do plano §8).
- [ ] `src/debrid/alldebrid-*.ts`, `protected.ts` (ou seu resíduo do
  Premiumize/play, por decisão), `catalog-env.ts`, `catalog-cleanup.ts`,
  `catalog-dedup.ts`, `internal-debrid-holds.ts`, `internal-debrid-marked.ts`
  e `scripts/clean-undubbed.ts` não existem; `grep -rn "alldebrid-" src`
  devolve só o registry/config.
- [ ] `adsub`/`adrm`/`adprot` têm escritor único (gateway); nenhuma escrita TS
  permanece (`grep -rn "kvSet\|kvForget" src/debrid` → vazio).
- [ ] As ações destrutivas do painel falam com a API administrativa do gateway
  (loopback + token + `confirm:true`), padrão F4.4a.
- [ ] `testFiles` sem os testes apagados; `npm run test:complete` sem órfão.

---

## 8. Riscos e ordem segura final (medidos)

| Risco | Evidência | Por quê (uma linha) |
|---|---|---|
| Apagar `protected.ts` inteiro na T3-L8 | `premiumize.ts:334` usa `held.isHeld`; `rust-resolve-magnet.ts:27` usa `unprotect` | dois consumidores não-AllDebrid sobrevivem à família; sem decisão prévia a fatia quebra o sweep do Premiumize e o efeito DubLie do play |
| Feed `/debrid/holds` fora antes do hold nativo | contrato §8.1 item 2: nenhum chamador preenche o `Holds` do Rust hoje | a limpeza nativa é fail-closed: sem o feed ela NUNCA apaga (silenciosamente) |
| Gateway read-only no `cache.db` | `api.rs:81` + `store.rs:56-65` (`read_only: true`) | a posse (`adsub`) que hoje volta pela rota `marked` precisa de um escritor novo no lado nativo; sem isso a checagem nativa classifica o próprio upload como acervo do usuário |
| Portar varreduras com o Chupim vivo | 16 chamadores Chupim vivos (§3.2, §6.1) | duas cópias do código que apaga acervo, dois donos para o mesmo kill-switch — a razão do bloqueio registrada em `8dd9086d` |
| `env-ops` apagado por inteiro | `env-ops.ts:47-93` despacha `adapter.sweepDead` por `config.debrid.service`; Premiumize tem sweep próprio (`premiumize.ts:300`) | o despacho por adapter continua existindo (ou migra) mesmo após a T3-L8 |
| CLI `clean-undubbed` sem substituto | `scripts/clean-undubbed.ts:126` importa `alldebrid-reupload.js` | é a única via de desbloquear `adrm` fora do painel; apagar o módulo sem rota admin tira a chave de emergência do operador |
| Instalação com `alldebrid` fora de `DEBRID_RUST_SERVICES` | `registry.ts:68` (wrap condicional); corpo TS do check vivo até a fatia | após a T3-L8 não existe corpo TS para voltar; rollback = commit/imagem anterior, sem knob — mesmo regime do R3 |

**Ordem segura final** (cada passo com rollback = commit anterior):

1. **T3-L5 + T3-L6 na mesma leva** — adotar a fila real (`autofetch:v3:q:<sha>`
   + `QueueCandidate`) no crate e subir o worker; sem isso o enfileiramento
   nativo gravaria numa fila que o dreno TS nunca lê (plano `:2165-2182`).
2. **T3-L7b** — `rdq` + agendador do warmer no gateway (dono de processo é do
   gateway, não do Node).
3. **T3-L8** — worker das varreduras + catálogo + feeds no gateway, decisão do
   escritor de `adsub`/`adrm`/`adprot`, APÓS cada passo provar ausência de
   chamador com `rg` (o Step 1 do plano original continua sendo o portão).
