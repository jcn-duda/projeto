# Fechamento do magnetdb por conta (mag) — plano fino

> Plano registrado em 2026-11-01 (branch `rust` @ `8a282584`), resultado da
> auditoria somente-leitura do Síndico com o Node já cortado da régua de
> escrita. Âncoras verificadas por leitura direta; confira o SÍMBOLO, não só
> a linha.

## 0. Estado medido

- A régua de escrita do `mag` já está no oráculo
  (`test/helpers/pipeline-oracle/play/magnetdb-writes.ts`; b680bcc0,
  0f7f3610, cdfa3eba). `src/utils/magnetdb.ts` (203 linhas) sobra com
  `peekBad`/`peekLie`/`forgetBadOf`/`status` + re-exports de
  `magnetdb-persist.ts`.
- `magnetState()` (ponte nativa, `debrid-state-native.ts`) tem 12 pontos
  vivos em `src/`, em 5 grupos: leitura de painel, ações do painel (1
  destrutiva), sweep de expirados, limpeza global e observabilidade F3
  (`br-coverage.ts:121`). **Nenhum** é decisão de busca — isso saiu para o
  oráculo.
- O painel client consome só 7 campos planos do `status()`
  (`view-magnets.ts:35-59`): `enabled, l1Entries, l1Max, sizeAlive,
  sizeBad, sizeLie, evictedQuota`. `byAdapter`, `counters`,
  `ttlRemainingBasis` e `_origem` NÃO são renderizados.
- **O Rust NÃO faz sweep próprio de `mag`/`davail`**: o único relógio de
  poda é o `setInterval` de 10 min do `magnetdb-persist.ts:215-225` (os
  únicos chamadores de `sweep` em produção são os da ponte napi,
  `adom-napi/src/debrid_state.rs:173,375`). O TTL só esconde a linha na
  leitura; quem apaga fisicamente e cobra o teto é o sweep.

## 1. Decisões

- **P1 — `forgetBadOf` permanece no Node via ponte.** A admin 8711 não tem
  rota mag-state (`store_admin.rs:184-199`); a destrutiva já tem confirmação
  central (`dashboard-actions.ts:52`), guarda de side, teto 100 e
  idempotência; a remoção física invalida o agregado no núcleo
  (`magnet_meta.rs:228`), sem janela de corrupção. Rota mag-state na admin
  é fatia Rust FUTURA opcional (§4), não compra disponibilidade agora.
- **P2 — o relógio de sweep não morre com o módulo.** Se `magnetdb-persist.ts`
  sair, extrair `sweepNativeNamespaces` + `setInterval(10min).unref()` para
  módulo próprio com dono explícito (`src/utils/mag-davail-sweep.ts`).
  Nunca duas varreduras ao mesmo tempo (podas concorrentes duplicam a
  invalidação do agregado).
- **P3 — `br-coverage.ts` SOBREVIVE**: leitura da conta do operador para
  pintar ⚡ da coorte (baseline F3.1), observabilidade pura, fora do caminho
  de busca. Mais um motivo para a ponte `debrid-state-native.ts` ficar de pé.
- **Desenho do estado-da-arte**: para `mag:v1` (que mora no `cache.db`
  compartilhado, onde o Node tem handle napi legítimo), o padrão é **ponte
  napi read-only**, não eco HTTP 503 (eco fica para quando o Node deixar de
  abrir o banco — caso do banco VIVO em `magnets.db`).

## 2. Fatias em ordem

### Fatia 1 — apagar o morto (`peekBad`/`peekLie`)
- `src/utils/magnetdb.ts` (apagar `:110-119` e o par no export `:200-202` —
  zero chamadores em produção, rg prova); testes migram para
  `magnetState().state(...)` direto (`test/dashboard-actions-magnet.test.ts:201-266`,
  padrão `setDebridStateForTest` de `debrid-state-native.ts:338-347`).
- Validação: typecheck, lint:lines, `dashboard-actions-magnet.test.ts` verde.

### Fatia 2 — `status()` por reconto direto; aposentar a amostra
- `status()` lê `summary()`/`liveCount()` (7 campos do client); APAGAR
  `adapterCounts`/`restoreFromAggregate`/`totalDiverges`/`adoptRebuild`/
  `ensureCountsLoaded`/`loadPersistentCounts`/`ttlRemainingBasis`
  (`magnetdb-persist.ts:45-206`), `savePersistentCounts` no-op
  (`:62-69`) + chamada no shutdown (`addon.ts:112`).
- O agregado `mag_meta:v1:counts` CONTINUA sendo escrito pelo gateway
  (`magnet_meta.rs:140` bump_counts) e servindo o próprio gateway.
- **VETO: não tocar `cache-keys.ts`** — golden `ck-magmeta`/`ck-versions`
  congela `mag`/`mag_meta` (`rust/golden/cache-keys.jsonl`,
  `corpus-cache-keys.json:16`); regenerar só no worktree esm.
- Testes a mover: `magnetdb-persist-basis.test.ts`, `magnet-db.test.ts:211`,
  `magnet-db-persistence.test.ts:268,286`,
  `magnet-db-empirical-challenge.test.ts:78-131,368,376` (script-filho por
  URL absoluta).

### Fatia 3 — relógio de sweep com dono explícito
- Novo `src/utils/mag-davail-sweep.ts` com `sweepNativeNamespaces` +
  `setInterval(10*60*1000).unref()`; boot importa; script-filhos apontam a
  URL nova. Gate: teste que dispara o sweep e prova remoção de vencidas
  (modelo `magnet-db.test.ts:155`).
- Risco de regressão silenciosa: timer morto ⇒ `cache.db` cresce sem teto e
  o teto de 50 mil nunca evicta.

## 3. Riscos transversais

1. MÉDIA — relógio órfão (coberto pela Fatia 3 obrigatória).
2. MÉDIA — golden `ck-magmeta`/`ck-versions` (veto acima).
3. BAIXA — contrato do bloco além do client (`byAdapter` sai sem
   renderizador; checar consumo externo ad-hoc antes).
4. BAIXA — destrutivas sem kill-switch dedicado (gancho natural:
   `config.magnetDb.enabled`, já gateia `magnetdb.ts:111,116`).
5. BAIXA — fachada presa por testes script-filho (mudança de fachada quebra
   dois testes de uma vez — atualizar URLs na mesma fatia).

## 4. Fatia opcional futura (fora desta leva)

mag-state na admin 8711 (`POST /mag-state/clear-bad` + `GET
/mag-state/status` em `store_admin.rs`): aí sim `magnetClearBad`/bloco
viram eco 503 no padrão `magnet-bank-admin` e `forgetBadOf` sai do TS.
Pré-condição: rota Rust + paridade de teto/confirm + painel aceitando 503.

## 5. Ordem vs davail

**SEQUENCIAL: Fatia 1 → 2 → 3 do mag → fatia davail.** Mesmos arquivos
(`cache.ts:326-343` branches gêmeos, `magnetdb-persist.ts:215-225` o MESMO
relógio varre mag E davail). O mag é o caso difícil (agregado + sentinela);
o davail é o caso fácil (sem agregado, sem mag_meta) e herda o módulo de
relógio e o padrão "status por reconto" já validados.
