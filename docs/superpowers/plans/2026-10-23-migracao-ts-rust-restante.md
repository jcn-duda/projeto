# Terminar a migração TS → Rust (branch `rust`) — plano executável

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> (ou `executing-plans`) para executar tarefa por tarefa. Cada tarefa é uma fatia
> commitável. Passos em checkbox (`- [ ]`).

**Goal:** fechar a migração TS → Rust do Adom sem quebrar o branch, até o Node ser
casca de API/rotas/config/painel e o Rust ser dono de regra, debrid, fontes,
cache, indexação e SQLite.

**Architecture:** receita já provada nas fatias F3.1 e R0–R8: provar no Rust com o
Node intacto → Node vira fachada → apagar o TS. Um commit por fatia; rollback =
commit/imagem anterior (nada de knob por env em caminho de leitura).

**Tech Stack:** Node ≥ 20 + TypeScript/ESM (`dist/` roda), Rust 1.92.0 pinada em
`rust/rust-toolchain.toml`, napi-rs (`adom-napi`), lado a lado com o branch `esm`
(worktree `E:/adom-esm`) que é o oráculo dos goldens.

---

## Regras de execução (valem em toda tarefa)

- **2–3 agentes em paralelo por leva**, em áreas independentes (arquivos
  disjuntos). Nunca dois agentes no mesmo arquivo; conflito de arquivo vira
  tarefa serial.
- **Validação local por parte**, antes do commit:
  `npm run typecheck` zero · `npm run build` · `npm test` (a baseline declarada
  abaixo não pode crescer) · `npm run lint:lines` sem regredir ·
  `cargo fmt --all -- --check` · `cargo clippy -p <crate> -- -D warnings` ·
  `cargo test -p <crate>` · `node scripts/check-rust-lines.mjs`.
- **Commit sem push.** `git add` só dos arquivos da fatia — o working tree tem
  WIP do usuário (19 arquivos rastreados) e lixo não rastreado (`.cursor/`,
  `.codex/`, `plugins/`, `docker-compose.override.yml`) que nunca entram.
- Prefixo convencional por área, em português sem acento no assunto:
  `refactor(ci): …`, `refactor(fase1): …`, `feat(search): …`, `fix(debrid): …`.
- **Push não faz parte deste plano.** Produção acompanha `origin/rust`; enquanto
  não houver push, nada muda na VPS. Toda etapa operacional (canário na VPS,
  `.env`, medição em produção) fica explicitamente **bloqueada por autorização**.
- Nada fora de `test/` importa de `test/`.

## Estado de partida (medido em 2026-10-23, `rust` @ `e0fe72eb`)

| Item | Medido |
|---|---|
| Produção | `e0fe72eb`, branch `rust`, cron segue `origin/rust`, container `healthy`, `RestartCount=0`, `OOMKilled=false` |
| CI do mesmo commit | CI ✅ · Docker ✅ · **Rust ❌** |
| Causa do Rust vermelho | passo "Golden dos filtros" chama `golden:series-episode-filter:check`, ausente em `origin/esm` (o commit existe só no `esm` local, 4 à frente) |
| Efeito colateral | `cargo test`, `clippy`, `fmt`, `catraca` e `cargo audit` ficam **PULADOS** |
| Catraca `.rs` (400 linhas) | **45 fontes acima do teto**, maior `rust/crates/adom-search/src/orchestrator/frozen_gate.rs` = 1973 |
| Suíte Node | `npm test`: 2957 testes, **2943 pass / 14 fail** — todas nas áreas do WIP do usuário (season fill, clear-cache por instalação, `/stream-trace.json`, `mode=live`, `tier1`) |
| WIP do usuário | `package.json`, `rd-probe.ts` (deletado), `rd-warmer.ts`, `br-gap.ts`, `cache*.ts` e 12 testes — **preservado em `stash@{1}`** (código) e `stash@{0}` (teste `debrid-rd-instant-probe`); working tree de código limpo |
| `fallback.indexer.*` | não existe mais produtor (nem Node nem Rust incrementam) → `fallbackServed` do painel é 0 por construção |
| `config.magnetBank.fallback*` | 3 chaves declaradas em `src/config/cache.ts`, **zero leitores** |

---

## Execução (branch `rust`, 2026-10-23) — commitado, sem push

| fatia | commit | o que fechou |
|---|---|---|
| Fase 0.1 + 0.2 | `89bdc467` | passo de golden tolerante no CI; catraca `.rs` vira ratchet (`scripts/check-rust-lines.mjs` + `rust/.line-budget.json`) e o heredoc Python saiu |
| Fase 1.1 | `ce6af184` | `warmup` apagado: arquivo, chamada no boot, fábrica, chaves do `.env.example`, teste e entrada em `testFiles` |
| Fase 1.2 + 1.3 | `74bbc940` | knobs mortos do `config.cache` fora; `fallbackServed` publica `null` (não medido) no bloco e no painel |
| Fase 2.1–2.2 | `696e0d9d` | `meta.fallback.*` e `meta.native.incomplete` no `meta_metrics` e nos `/metrics` do gateway |
| Fase 3.2 | `1b827c78` | `asCheck` lê `unusable` do envelope 200 (auth/quota): não vira "desconhecido" |
| Fase 3.1 | `19e22795` | `/debrid/account` cobre os quatro serviços com `accountStatus`; Debrid-Link segue 501 |
| Fase 4.0.5 (mitigação) | `ec0c1420` | `magnet_work` sem lost update: `UPDATE` monotônico no Rust + upsert com CAS (`readLastSeen`) no Node |
| Fase 4.2(a) | `e0b32cec` | o Node para de escrever `raw:v1:bludv:*`; o gateway fica dono da chave |
| Fase 4.1(a) | `3837c087` | teste fixa o dono do `davail`: contra o arquivo do Node, `put` recusa |
| Fase 3.1 (item 3) | `e9049660` | `accountStatus`/`fileLink` não perguntam duas vezes: recusa sobe, 501/rede usam o TS |
| Fase 5 (dedupe) | `faabecb8` | `harvest:v1:seen:<sha256>` no crate: chave e TTL do TS, ler não renova, gravar só após o aceite |
| Fase 5 (balde horário) | `7bb95fec` | `harvest:v1:hour` durável: `{hour, count}`, TTL até o fim da hora + 60 s, hidrata só a hora corrente |
| Fase 5 (inflight) | `f1a4a5e0` | slot único no `HarvestQueue`: enqueue da mesma obra devolve `coalesced`; tick abre/fecha |
| Fase 4.2(b) | `4a9e01a8` | o Node trata `raw:v1:bludv:` como prefixo ESTRANGEIRO no L1/L2: `get`/`set`/`setMany`/`forget`/`persist`, boot e poda do expirado |
| Fase 5 (`takeProbe`) | `072f8fc3` | sob tráfego o tick consome só `br_probe`; sem sonda, `SkippedBusy` sem tocar na cabeça |
| Fase 3.1 (`fileLink`) | `c7c505ee` | `fileLink` sai do tipo, do `rust-remote`, do Premiumize e da medição de cabeçalho — não tinha chamador vivo |
| Fase 4.2(c) | `4026b545` | `streams` Rust-owned: o L1 do Node não guarda a lista pronta, o trace recomputa no ramo nativo e a invalidação (obra/instalação/clear) vai pela ponte administrativa; `rd-probe` apagado |
| Fase 6 (Mico) | `b2ee8881` | Mico no sidecar Rust: `mico_discovery`, `mico_page`, `mico_lane`, `own_pace`, `url_key` e registry `rust: true` |
| Fase 5 (probe) | `b8cace24` | máquina de estado do `br-probe` no `adom-harvest` (17 testes) e `peekRawFor` lendo o envelope `{ items }` |
| Catraca `.rs` | `02e75284` | 45 fontes acima de 400 reduzidas nos seis crates; baseline do `.line-budget.json` vazio |

Gate local desta rodada (`rust` @ `02e75284`): `typecheck` zero · `build` · `npm test` **2956 testes, 2956 pass / 0 fail** · `test:complete` 337 arquivos + 2 harnesses · `lint:lines` 758 fontes, 0 acima do teto · `check-rust-lines.mjs` (824 fontes, baseline **0**) · `cargo fmt --check` · `cargo clippy --workspace --all-targets --locked -- -D warnings` · `cargo test --workspace --locked` **0 falhas**.

Um flake estrutural apareceu e foi corrigido na raiz: `DeleteConfig::fast()` lia `DEBRID_AL_CLEANUP_KILL` do env do processo (outra suíte liga a variável em paralelo e a fila voltava vazia) — agora `kill: Some(false)`, config de teste hermética.

Gate local da rodada anterior: `typecheck` zero · `build` · `npm test` **2965 testes, 2965 pass / 0 fail** (WIP fora do working tree; ver stashes abaixo) · `lint:lines` 758 fontes, 0 acima do teto ·
`check-rust-lines.mjs` (741 fontes, baseline 45) · `cargo fmt --check` ·
`cargo clippy -D warnings` em `adom-store`, `adom-debrid` e `adom-harvest` · `cargo test -p adom-store` (42),
`-p adom-debrid` (193) e `-p adom-harvest` (49).

O WIP de `cache*`/`br-gap`/`rd-warmer`/`rd-probe` (e o teste novo de sonda) foi **preservado em dois stashes** antes da fatia 4.2(b) — `stash@{1}` (código) e `stash@{0}` (teste `debrid-rd-instant-probe`). O working tree de código está limpo; `.cursor/`, `.codex/`, `plugins/` e `docker-compose.override.yml` seguem intocados.

---

## Execução — Fase 5 fechada (working tree, sem commit)

| fatia | onde | o que fechou |
|---|---|---|
| h1 async | `adom-harvest` | `TickPlan`/`plan` com as guardas; `HarvestDrainAsync` (`Pin<Box<dyn Future + Send>>`) + `tick_async`; testes em `worker_tests.rs` |
| h2 ponte | `adom-search` | `harvest_support` público (`raw_items_from_jackett`, `release_entry_for`, `record_release`); `RawItem`/`ReleaseEntry` reexportados |
| h3 worker | `adom-server` | `harvest/{mod,config,drain,status,routes,enqueue,traffic}.rs`; thread `adom-harvest`; rotas na admin 8711; `stream_traffic` marcado no `/stream` |
| h4 Node | `src/` | `harvest-native.ts` (ponte), efeitos → `enqueueNativeHarvest`, `br-probe` → `pendingNativeHarvest`, `trace-recompute` lê `raw:v1` do napi, `/test-indexer.json` 410, `harvest` em `RUST_OWNED_PREFIXES` |
| h5 painel | `src/routes`+`src/client` | bloco `harvest` e ações (pausa/drenar/limpar) pela ponte; `test-all-indexers` 410 |
| h6 corte | `src/providers`, `test/` | 16 arquivos / **3.254 linhas** apagados; 33 testes + 1 helper (**7.299 linhas**); 21 testes adaptados; `harvest-native.test.ts` novo |

Gate local: `typecheck` 0 · `build` · `npm test` **2.528 testes, 0 fail** · `test:complete` 283 arquivos + 2 harnesses · `lint:lines` 677 fontes, 0 acima · `check-rust-lines.mjs` 838 fontes, baseline 0 · `cargo fmt` · `cargo clippy --workspace --all-targets -D warnings` · `cargo test --workspace --locked` **0 falhas**.


Ainda aberto, com o motivo real:

- **Fase 3.1 (matriz)** — `/debrid/files` só Premiumize. `adapter.fileLink` **saiu** (`c7c505ee`):
  não tinha chamador vivo em `src/`, só o teste e o `rust-remote` que o embrulhava. Debrid-Link
  segue 501 nas duas rotas; resta decidir se `files` sai no corte da Fase 3.4.
- **Fase 3.3/3.4** — canário AllDebrid e apagar corpos Node de `checkCached`/`resolveLink`/
  `accountStatus`: **bloqueado por push + autorização**.
- **Fase 2.3/2.4** — medir ~1 semana em produção e só então remover `FallbackMetaSource`:
  **bloqueado por push**.
- **Fase 4.1(b)(c) e 4.3** — ponte de leitura do `davail` (`br-coverage`/painel) e mover a
  escrita junto com `mag:v1`: dependem da Fase 3 (a escrita sai da mesma função da checagem).
  O WIP não é mais bloqueio: `RUST_OWNED`/`isForeignKey` já estão no HEAD.
  Medição: **não há uma única leitura/escrita de `davail` no Rust** (`grep davail rust/crates` vazio),
  então a ponte de leitura não tem fonte nativa e a escrita continua no Node até a Fase 3.4.
- **Fase 4.2(c) — FECHADA** (`4026b545`). A tentativa anterior foi retomada pela raiz: o ramo
  nativo do trace passou a recomputar quando `found && trace == null` (via `native.searchMeta`), os
  canários de L1 viraram mock da ponte (`test/helpers/streams-bridge.ts`: trace/invalidate/clear) e
  só então `rd-probe` foi apagado. `RUST_OWNED` agora é `['idx','streams']`; `br-gap`, `rd-warmer`,
  `dub-audit`, `harvest-worker` e `crawl-recorder` trocaram "contagem de entradas removidas" por
  "pedido aceito pela ponte" (`invalidated: boolean`).
- **Fase 4.4** — o CAS fechou o lost update; declarar um único executor de `magnet_work` e o
  ensaio de restauração continuam **bloqueados por push**.
- **Fase 5 — FECHADA** (working tree, sem commit). O gateway consome o
  `adom-harvest` com as fontes nativas: fila/L2 (`harvest:v1:q`), dedupe 12h,
  balde horário, coalescing, `take_probe` sob tráfego e a máquina do `br-probe`
  rodam no `adom-server`; a pilha TS (`jackett*`/`search-plan`/`bludv`/`harvest-*`/
  `harvester*`) saiu. Contrato em `docs/harvest-native-contract.md`. Dívida: o
  drain cobre Jackett (BLUDV nativo fora) e a ponte do `BrEvidence` para o
  índice segue pendente.
- **Fases 6–7** — o Mico já roda no sidecar (`adom-crawl`, `rust: true`);
  `dub-audit`/`rd-warmer` seguem no Node (Fase 7).

Dívida residual declarada (medida, não silenciosa):

- **TS do Mico** — `src/providers/crawl-sites/{mico,mico-shared,mico-series}.ts` continuam no
  repositório **só como legado de teste**: o registro já é `rust: true` e o motor TS nunca os toca
  em runtime. Quem os mantém vivos é `scripts/crawl-site-probe.ts` (sonda de 40) e os testes
  `crawl-mico*`, `crawl-site-probe-mico`, `mico-fetch-deadline` e `mico-diag`. Aposentar exige
  fatia própria: sonda lendo o sidecar, reescrita desses testes e só então apagar os três arquivos.
- **`CRAWL_ENGINE=ts`** fica (a suíte depende do loop TS dos oito cards), mas o Mico não está mais
  nesse caminho.

---

## Atualização 2026-10-24 — fechamento funcional do colhedor

Plano detalhado: [`2026-10-24-fechamento-funcional-colhedor-rust.md`](2026-10-24-fechamento-funcional-colhedor-rust.md).
O retrato de 2026-10-23 acima permanece **histórico** (partida `e0fe72eb`, 14
falhas Node, 45 `.rs` acima do teto, dois escritores `raw`, motor TS do Mico
ainda citado como dívida de runtime). Não repetir esses números como estado
atual: a suíte e a catraca já zeraram depois; `raw` tem dono Rust; o Mico de
produção é o sidecar.

**Status atual do colhedor (commit local, sem push/deploy):** 5A–5G
entregues; gates da seção 6 do plano 2026-10-24 em exit 0. Aceite do recorte
funcional, não paridade operacional 5H.

| fatia | o que fechou |
|---|---|
| 5A | Intenção FULL simétrica; envelope persistido sem truncar |
| 5B | Settlement devolve FULL remanescente; snapshot do slot antes do `finish` |
| 5C | Escrita suplementar; sonda/FULL incompleto não certificam |
| 5D | Found via delta do índice; invalidação nativa só da obra |
| 5E | `EvidenceSnapshot` + prioridade real; evicção BR-first/FIFO |
| 5F | BLUDV só FULL, nunca certifica, não debita Jackett |
| 5G | `run_iteration` testável; loop com barreira; `NetworkDrain` contra stubs locais; restart após save; contrato e docs |

Contrato vivo: `docs/harvest-native-contract.md`. Dívida antiga de config ao
vivo **já entregue** (`POST /harvest/config` + overlay). Dívida antiga
"BLUDV fora / BrEvidence pendente" **já entregue** em 5E–5F.

**Ainda fora deste recorte (5H e o resto da migração):** crash no meio do
drain, inflight durável, exactly-once, fencing SWR, preempção intradrain, teto
rígido por consulta; fases 3/4 (adapters/estado), fallback de metadados,
ingestão `crawl-result`, autofetch/recheck e demais workers.

---

## Fase 0 — Base confiável (executar agora)

### Task 0.1: destravar o job Rust no CI — ✅ feito (`89bdc467`)

**Files:**
- Modify: `.github/workflows/rust.yml:121-129`

Motivo: um oráculo ausente no `esm` remoto não pode pular `cargo test`, `clippy`,
`fmt`, catraca e `audit` — é exatamente o gate que protege os crates que a
migração toca. O próprio workflow já usa esse padrão de "avisa em vez de falhar"
no passo seguinte (`rust.yml:152-156`).

- [ ] **Step 1: trocar o run do passo por laço tolerante**

```yaml
      - name: Golden dos filtros contra o TypeScript do esm
        working-directory: ../adom-esm
        env:
          RUST_CORE: 'off'
          DOTENV_CONFIG_PATH: test/fixtures/env-empty
        run: |
          for s in golden:release-filters:check golden:inventory-filter:check \
                   golden:series-episode-filter:check; do
            if npm run | grep -q " $s\$"; then
              npm run "$s"
            else
              echo "[golden-esm] AVISO: o branch esm ainda não tem '$s'; commite o dump/oráculo/corpus lá"
            fi
          done
```

- [ ] **Step 2: conferir a paridade local de verdade**

No worktree `E:/adom-esm` (que TEM os 4 commits), rodar com
`RUST_CORE=off DOTENV_CONFIG_PATH=test/fixtures/env-empty`:
`npm run golden:release-filters:check`, `golden:inventory-filter:check`,
`golden:series-episode-filter:check`. Esperado: `OK: … batem com o dist vivo`.

- [ ] **Step 3: commit**

```bash
git add .github/workflows/rust.yml
git commit -m "refactor(ci): golden ausente no esm avisa em vez de pular o job Rust"
```

### Task 0.2: catraca `.rs` vira ratchet com baseline — ✅ feito (`89bdc467`) e zerada em `02e75284`

**Files:**
- Create: `scripts/check-rust-lines.mjs`
- Create: `rust/.line-budget.json` (gerado por `--bless`, 45 entradas)
- Modify: `.github/workflows/rust.yml:190-216` (remove o heredoc Python)
- Modify: `package.json` (script `lint:lines:rust`)

Motivo: o teto absoluto de 400 já nasceu morto (45 violações, 24k linhas). O
projeto já tem a solução para o lado TS — `.line-budget.json` com catraca, onde
legado só diminui e arquivo novo acima do teto reprova. Aplicar a mesma régua é
coerente e honesto; `--bless` fica como escape visível no diff.

- [ ] **Step 1: criar o script**

```js
#!/usr/bin/env node
/**
 * Catraca de linhas do workspace Rust — par do `npm run lint:lines`.
 *
 * Regra: arquivo novo acima de 400 reprova; arquivo legado listado no baseline
 * só pode DIMINUIR. O baseline é `rust/.line-budget.json`, chave = caminho
 * relativo à raiz do repo. `--bless` regrava o baseline (escape visível no diff).
 *
 * Por que ratchet e não teto absoluto: o teto entrou no CI depois de o código
 * já ter 45 fontes maiores que ele, e o job ficou vermelho/pulado desde então —
 * gate permanentemente desligado não protege nada.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CRATES = path.join(ROOT, 'rust', 'crates');
const BASELINE = path.join(ROOT, 'rust', '.line-budget.json');
const LIMIT = 400;
const SKIP = new Set(['target', 'vendor']);
const BLESS = process.argv.includes('--bless');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.rs')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = walk(CRATES).sort();
if (files.length === 0) {
  console.error('catraca .rs: nenhuma fonte em rust/crates - falha (vazio nao e verde)');
  process.exit(1);
}

const counts = new Map();
for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  counts.set(rel, readFileSync(file, 'utf8').split('\n').length - 1);
}

if (BLESS) {
  const over = [...counts].filter(([, n]) => n > LIMIT).sort((a, b) => b[1] - a[1]);
  const body = Object.fromEntries(over);
  writeFileSync(BASELINE, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`catraca .rs: baseline regravado com ${over.length} arquivo(s)`);
  process.exit(0);
}

let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
} catch {
  console.error('catraca .rs: baseline ausente ou invalido (rode --bless)');
  process.exit(1);
}

const failures = [];
for (const [rel, n] of counts) {
  const base = baseline[rel];
  if (base == null) {
    if (n > LIMIT) failures.push(`${rel}: ${n} linhas (novo, teto ${LIMIT})`);
    continue;
  }
  if (n > base) failures.push(`${rel}: ${n} linhas (regrediu de ${base})`);
}
for (const rel of Object.keys(baseline)) {
  const n = counts.get(rel);
  if (n == null) console.warn(`catraca .rs: ${rel} sumiu (remova do baseline)`);
  else if (n <= LIMIT) console.warn(`catraca .rs: ${rel} voltou ao teto (${n}); pode sair do baseline`);
}

console.log(`catraca .rs: ${counts.size} fonte(s), baseline ${Object.keys(baseline).length}, teto ${LIMIT}`);
if (failures.length) {
  for (const line of failures) console.error(`ACIMA/REGREDIU: ${line}`);
  process.exit(1);
}
```

- [ ] **Step 2: gerar o baseline**

Run: `node scripts/check-rust-lines.mjs --bless`
Expected: `baseline regravado com 45 arquivo(s)`; conferir que
`frozen_gate.rs` = 1973 e que nenhum arquivo ≤ 400 entrou.

- [ ] **Step 3: verificar o gate**

Run: `node scripts/check-rust-lines.mjs`
Expected: `catraca .rs: 733 fonte(s), baseline 45, teto 400` e exit 0.

- [ ] **Step 4: trocar o passo do CI**

Substituir o passo "Catraca de 400 linhas (.rs)" (heredoc Python) por:

```yaml
      - name: Catraca de linhas Rust (.rs)
        working-directory: .
        run: node scripts/check-rust-lines.mjs
```

- [ ] **Step 5: script npm**

Em `package.json`, junto de `lint:lines`:

```json
"lint:lines:rust": "node scripts/check-rust-lines.mjs"
```

- [ ] **Step 6: commit**

```bash
git add scripts/check-rust-lines.mjs rust/.line-budget.json .github/workflows/rust.yml package.json
git commit -m "refactor(ci): catraca .rs vira ratchet com baseline visivel"
```

### Task 0.3: baseline do WIP do usuário — ✅ resolvida (`c8fb7ff0`)

O usuário autorizou remover o WIP. Ele foi **preservado em dois stashes** e a suíte voltou ao
baseline limpo: `npm test` **2965/2965**, sem baseline temporária. As 14 falhas listadas abaixo
(com a numeração antiga) eram do WIP de `streams` fora do L1; a numeração atual do diagnóstico de
uma retomada da Fase 4.2(c) é 15 falhas e está registrada no bloco "Ainda aberto".

Nomes exatos para diff de baseline (guardar em `test_baseline.txt` local, fora do
git): LRU do índice (320), season fill "Temporada Completa" (322), clear-cache por
instalação (908), Tier 2 e2e (1320), `mode=live` (2397, 2398), `/stream-trace.json`
(2408, 2410–2416).

---

## Fase 1 — Limpeza barata (executar agora, em paralelo à Fase 0)

### Task 1.1: apagar o warmup — ✅ feito (`ce6af184`)

**Files:**
- Delete: `src/warmup.ts`
- Delete: `test/warmup.test.ts` (e remover da lista `testFiles` do `package.json`)
- Modify: `src/addon.ts` (import + `warmup.start()`)
- Modify: `src/config/harvest.ts` (fábrica `warmup`, linhas 6-18)
- Modify: `src/config.ts:24,32`
- Modify: `.env.example:971-979`
- Modify: `test/harvester-sweep.test.ts:249` (só o texto do assert)

Motivo: o warmup aquece `raw:v1` do Jackett, que o `/stream` nativo não lê; a
captura do banco de magnets já é nativa (`magnet_capture`) e o colhedor cobre o
aquecimento. **Efeito colateral registrado:** sai a pré-alimentação do banco por
lista curada no boot — aceito, o colhedor assume.

- [ ] **Step 1: apagar arquivo e chamada**

```ts
// src/addon.ts — remover
// import warmup from './warmup.js';
// warmup.start().catch((err) => log.warn('[warmup] falha no boot:', err?.message || err));
```

- [ ] **Step 2: apagar a fábrica e a chave**

```ts
// src/config/harvest.ts — remover a função `warmup` inteira (linhas 6-18)
// src/config.ts — `import { warmup, ... }` vira `import { releaseIndex, ... }`
//                 e remover a linha `warmup: warmup(),`
```

- [ ] **Step 3: apagar do `.env.example`**

Remover `WARMUP_ENABLED`, `WARMUP_TITLES`, `WARMUP_CONCURRENCY`,
`WARMUP_INDEXER_DELAY_MS`, `WARMUP_TIMEOUT_MS`, `WARMUP_SKIP_SLOW` e o cabeçalho
do bloco, com o equivalente em comentário dizendo que o colhedor cobre o
aquecimento.

- [ ] **Step 4: apagar o teste**

`git rm test/warmup.test.ts` e remover a entrada em `testFiles`
(`package.json`). Rodar `npm run test:complete` para confirmar zero pendências.

- [ ] **Step 5: validar e commitar**

Run: `npm run typecheck` (0) · `npm run build` · `npm test` (14 falhas de
baseline, zero novas) · `npm run lint:lines`

```bash
git add src/addon.ts src/config.ts src/config/harvest.ts .env.example package.json
git rm --cached test/warmup.test.ts
git commit -m "refactor(fase1): apaga o warmup do boot (raw do Jackett nao alimenta a busca nativa)"
```

### Task 1.2: apagar `config.magnetBank.fallback*` — ✅ feito (`74bbc940`)

**Files:**
- Modify: `src/config/cache.ts:98-105`
- Modify: `.env.example:740,743,744` (só comentário — as chaves FICAM)

Motivo: as três chaves ficaram declaradas "para o knob existir no `.env` antes da
feature"; o fallback 📦 hoje é do núcleo Rust, que lê as envs direto em
`adom-server/src/stream_config.rs`. Zero leitores no Node (medido por grep em
`src/`).

- [ ] **Step 1: remover as chaves e o comentário morto**

```ts
// src/config/cache.ts — remover:
//   fallbackEnabled, fallbackMaxPerIndexer, fallbackGlobalMax
// manter: instantEnabled/instantMinMs/instantMaxMs/instantFreshMaxMs
```

- [ ] **Step 2: ajustar `.env.example` (sem remover chave)**

**As três linhas `MAGNET_BANK_FALLBACK`, `MAGNET_BANK_FALLBACK_MAX` e
`MAGNET_BANK_FALLBACK_GLOBAL_MAX` FICAM.** Elas são lidas direto do ambiente pelo
gateway (`rust/crates/adom-server/src/stream_config.rs:110-118`); removê-las do
`.env.example` apagaria a documentação de um knob vivo. Troque apenas o
comentário para dizer que o fallback 📦 é do gateway (lido direto das envs), não
da `config.cache` do Node.

- [ ] **Step 3: validar e commitar**

Run: `npm run typecheck` · `npm run build` · `npm test` (baseline) ·
`grep -r "fallbackEnabled\|fallbackMaxPerIndexer\|fallbackGlobalMax" src/` (vazio)

```bash
git add src/config/cache.ts .env.example
git commit -m "refactor(fase1): remove knobs mortos do fallback do banco de magnets"
```

### Task 1.3: `fallbackServed` para de mentir 0 — ✅ feito (`74bbc940`)

**Files:**
- Modify: `src/routes/dashboard-status-blocks.ts:311-324`
- Modify: `src/client/painel/saude-model.ts:94`
- Test: o teste do bloco `indexers` que afirma `fallbackServed`

Motivo: o contador `fallback.indexer.<id>` não tem produtor — nem o Node (o
fallback 📦 saiu do build na fase 1) nem o Rust (só existe o construtor da
chave, `adom-core::metric_id`). O bloco publica 0 como se fosse medida.

- [ ] **Step 1: publicar "não medido", não zero**

```ts
// src/routes/dashboard-status-blocks.ts — no bloco `indexers`
      ...indexer,
      breaker: services.jackett.breakerSnapshot(indexer.id),
      flagSlow: indexer.status == null ? null : indexer.status.state === 'slow',
      // Sem produtor (o fallback 📦 é do gateway e não conta por indexer):
      // ausência é "não medido" — nunca 0, que passaria por medida.
      fallbackServed: null,
```

- [ ] **Step 2: o cliente para de converter em 0**

```ts
// src/client/painel/saude-model.ts
    servedFromMemory: finiteNumber(obj.fallbackServed),
```

- [ ] **Step 3: atualizar o teste do bloco e o rótulo**

O teste que espera `fallbackServed: 0` passa a esperar `null`; onde a UI exibe o
badge, `null` vira "não medido" (não some nem vira 0).

- [ ] **Step 4: validar e commitar**

Run: `npm run typecheck` · `npm run build` · `npm test` (baseline) ·
`npm run lint:lines`

```bash
git add src/routes/dashboard-status-blocks.ts src/client/painel/saude-model.ts test/
git commit -m "fix(painel): fallbackServed sem produtor vira nao medido em vez de zero"
```

---

## Fase 2 — Metadados só no Rust (depois da Fase 0)

1. Instrumentar `FallbackMetaSource` (`rust/crates/adom-search/src/orchestrator/meta_native.rs:102-129`)
   com `meta.fallback.used|empty|error` e — **correção do plano anterior** —
   `meta.native.incomplete`, porque `meta_from_lookup` preenche `name` com o
   próprio IMDb (linhas 150-157) e faz o fallback parecer desnecessário mesmo
   quando os títulos faltaram.
2. Expor nos `/metrics` do gateway e no bloco `metrics` do painel.
3. Medir ~1 semana em produção (**bloqueado: exige push**).
4. Só então remover `FallbackMetaSource` do gateway e `POST /internal/search/meta`.
   `cinemeta.ts`/`tmdb.ts` do Node ficam (colhedor, raspador, crawl-identify).

Aceite: taxa de fallback medida com numerador **e** denominador; teste com fontes
nativas falhando de propósito; zero `source_missing` novo nos logs.

## Fase 3 — Debrid remoto (depois da Fase 0)

1. Fechar a matriz **serviço × método × chamador** da 8710. Hoje: `/debrid/account`
   sem AllDebrid/TorBox (501), `/debrid/files` só Premiumize, e
   `src/debrid/rust-remote.ts:333-349` volta ao Node em qualquer falha.
2. Corrigir `asCheck` (`rust-remote.ts:280-283`): `unusable` chega em HTTP 200
   (auth/quota) e hoje é descartado — vira "desconhecido", não erro de conta.
3. Canário AllDebrid na VPS (**bloqueado: exige push + autorização**).
4. Só apagar corpos Node de `checkCached`/`resolveLink`/`fileLink`/`accountStatus`
   com **zero 501, zero fallback residual e zero chamador** por serviço.

Aceite: teste de envelope real `200 + unusable` (não só erro HTTP); nenhum hash
vira miss por auth/quota; nenhuma chamada dupla ao serviço.

## Fase 4 — F3: estado com dono único

### Fase 4.0 — matriz de propriedade (medida em 2026-10-23)

Medido no checkout com `rg -n` e leitura de código, não de memória. O WIP não
commitado de `cache*` foi lido e **não** é base de decisão: ele generaliza
`RUST_OWNED` de `idx` para `idx`+`streams` (`src/utils/cache-keys.ts:190-192`) e
ainda afirma `raw` no L1 do Node (`test/cache-namespaces.test.ts:317`) — é o
mecanismo que o corte vai reusar, não o estado final.

Duas definições que a matriz usa:

- **dono de execução** = processo com o timer/rota/loop que chama a escrita.
  "Dono de linguagem" não basta: os dois processos montam o mesmo volume
  (`docker-data/addon`) e escrevem nos mesmos arquivos.
- **dois escritores** = os dois processos gravam a MESMA chave/linha do MESMO
  arquivo. Namespace diferente no mesmo SQLite não é conflito.

Veredito: `davail` **dono único (Node)** · `raw:v1` **dois escritores** ·
`mag:v1`/`mag_meta:v1` **dono único (Node)** · `data/magnets.db` **dois
escritores**.

> Correção de escopo que a medição impõe: o item 3 do plano (`magnets.db`)
> junta dois stores diferentes. `mag:v1`/`mag_meta:v1` moram no `cache.db`
> (versão, TTL, cota); `data/magnets.db` é arquivo próprio, permanente, sem
> namespace nem TTL nem cota (`src/config/cache.ts:75`;
> `rust/crates/adom-store/src/magnet_bank.rs:512-519`). Abaixo são seções
> separadas porque o corte de um não é o corte do outro.

#### 4.0.1 `davail:v1` — dono único (processo Node)

Chave `davail:v1:<adapter>:<accountScope>:<hash>` (`src/debrid/cache-check.ts:145-147`;
`accountScope` = sha256 da apiKey, `src/utils/request-key.ts:9-12`).

| chave/prefixo | dono de execução | escritores | leitores | TTL/cota | limpeza |
|---|---|---|---|---|---|
| `davail:v1:*` | **Node** — `cache-check.ts` roda no addon; nenhuma rota, timer ou loop do gateway grava o namespace | `cache-check.ts:158` (`noteAvailable`, valor 1), `:193` (`noteUnavailable`, valor 0), `:377`/`:380` → `:383` (`setMany` do lote pós-rede). Gatilhos: autofetch (`autofetch-recheck.ts:234` chama `debrid.checkCached`; `:285` chama `noteAvailable`) e efeito de play (`internal-resolve.ts:83` → `rust-play-effects.ts:50-53`); play AllDebrid no Node grava igual (`alldebrid-play.ts:25-26`) | `cache-check.ts:304` (positivo serve sem rede → ⚡/`cachedForAutofetch` do Chupim); `src/utils/br-coverage.ts:118-121` (`releaseStatus`: 1=hit, 0=miss → `catalog-scan.ts:109` e painel `dashboard-status-blocks.ts:289`); `debrid-cache-steps.ts:139` (`peekDavail` 0 fresco **veta** o atalho `DEBRID_ALIVE_AS_CACHE`) | `DEBRID_AVAIL_POS_TTL` 900 s (`src/config/debrid.ts:98`), `DEBRID_AVAIL_NEG_TTL` 120 s (`:101`); cota 1.000 (`src/utils/cache-quotas.ts:70`; espelho `rust/crates/adom-core/src/cache_quotas.rs:58`) | TTL + LRU da própria cota (`src/utils/cache.ts:30-47`, prune a cada 10 min em `:341`), purga de expirado/versão no boot (`src/utils/cache-db.ts:102-135`) e `maintain` a cada 15 min (`:276`). Kill-switch: TTL 0 desliga escrita e leitura (`cache-check.ts:157`, `:192`, `:297`, `:300`, `:369`) |

**Sem dois escritores — evidência, não suposição.** `rg -n "davail" rust/crates --glob "*.rs"`
devolve 28 linhas em 16 arquivos e **nenhuma escrita de produção**: comentários
(`adom-search/src/orchestrator/account.rs:3` — "O Node segue dono … do
`davail`"; `adom-debrid/src/alldebrid.rs:91`; `resolve_native.rs:13-16`),
testes (`adom-debrid/src/store_tests.rs:5-13`, todos em `open_memory`) e as
tabelas de chave/cota (`adom-core/src/cache_keys.rs:52`,
`cache_quotas.rs:58`). O store do gateway no arquivo real abre READ-ONLY
(`adom-debrid/src/store.rs:56-66`) e `put` recusa (`:109-111`); `davail:v1:`
consta em `WRITABLE_PREFIXES` (`:19`), mas essa lista só governa o store em
memória dos testes (`store_tests.rs:5`). O comentário de replay
(`frozen_gate.rs:1231-1234`) também não lê o namespace.

**Nuance que muda o corte.** O `/stream` nativo não consulta `davail` (R3: a
checagem é nativa, `adom-debrid/src/verdict.rs`; `/internal/debrid/check` foi
apagado). O namespace serve hoje três consumidores: o autofetch — único chamador
vivo de `debrid.checkCached` em `src/` (`autofetch-recheck.ts:234`; `rg`
"debrid.checkCached" em `src/providers|src/routes|src/utils` só acha esse), o
play (negativo de 120 s) e o painel/coverage. Transferir a escrita sem levar os
três é troca de dono sem consumidor.

#### 4.0.2 `raw:v1` — dois escritores

| chave/prefixo | dono de execução | escritores | leitores | TTL/cota | limpeza |
|---|---|---|---|---|---|
| `raw:v1:bludv:{d\|t}:<q>` | **Rust** no `/stream` (`adom-server/src/stream.rs:103` → `:239-247`) **e Node** no harvester (`harvest-worker.ts:264` → `bludv.ts:234`) | Rust: `bludv/client.rs:183-185` (`set`), `raw.rs:135-141` (INSERT ON CONFLICT + `enforce_quota`). Node: `bludv.ts:190` (chave), `:234` (`cache.set`) | Rust: `bludv/client.rs:206-218` (`get`, que **apaga expirado**: `raw.rs:107`). Node: `bludv.ts:192` (`cache.get`, só L1) | Node `RAW_CACHE_TTL` 900 s / `TTL_BR` 1800 s / `EMPTY_TTL` 120 s (`src/config/cache.ts:19-29`); Rust lê as MESMAS envs (`adom-sources/src/bludv/config.rs:85-87`); cota 800 nos dois (`cache-quotas.ts:67`; `raw.rs:42-44`) | TTL + LRU da cota no Node (`cache.ts:30-47`, `:341`) e `enforce_quota` no Rust (`raw.rs:141`) — os dois despejam no MESMO arquivo |
| `raw:v1:jackett:<indexer>:<type>:<q>` | **Node** (`jackett.ts:131` → `jackett-query-indexer.ts:194`; chamado pelo harvester em `harvest-worker.ts:229` e `harvest-sweep.ts:110`) | `jackett-query-indexer.ts:134` (chave), `:194` (`cache.set`) | `jackett-query-indexer.ts:136` (`cache.get`); `jackett-query.ts:78-83` (`peekRawFor` → `cache.peek`) alimentando `trace-recompute.ts:88` | idem acima | idem acima |

**Dois escritores (conflito real, mesmo arquivo e mesma chave):**

- **Chave idêntica.** Rust monta `raw:v1:bludv:{d|t}:<q>`
  (`bludv/client.rs:504-509`, com teste afirmando a string em `:588-594`) e o
  Node monta a mesma em `bludv.ts:190`. `sources_rust.rs:25-27` confirma que o
  store só é injetado no BLUDV (`:41`), então o `raw` do Jackett é Node-only.
- **Node apaga linha do Rust.** `raw` não está em `RUST_OWNED`
  (`cache-keys.ts:190`), então `cache.forget` não bloqueia: `cache.ts:256-263`
  → `cache-db.ts:219-229` roda `DELETE FROM cache WHERE key = ?`. Pior: `get`
  expirado chama `forget` (`cache.ts:111-112`), então uma cópia velha no L1 do
  Node **deleta a linha fresca que o Rust acabou de gravar** com a mesma chave.
- **Cegueira nos dois sentidos.** `cache.get` lê só L1 (`cache.ts:102-127`) e o
  L2 só é lido no boot (`cache-db.ts:102-135`); linha escrita pelo Rust fica
  invisível ao Node até reiniciar. No outro sentido, o Rust não vê o L1 do Node
  e reescreve a chave quando o TTL do disco expira.
- **Não há env que separe os dois.** `RAW_CACHE_TTL_BR`/`RAW_CACHE_MAX_ITEMS`
  desligam o cache nos dois processos (`src/config/cache.ts:15-29` ×
  `bludv/config.rs:85-98`), então o corte não pode ser kill-switch de env: é
  mudança de código (ou o Node para de escrever a metade BLUDV, ou o Rust para
  de receber o store).
- **Precedente que prova o perigo.** `rdc:v2` mora no mesmo arquivo e é
  read-only no Rust exatamente por isto: "o L1 do Node é a autoridade do
  arquivo, não relê o disco depois do boot e o flush sobrescreveria a linha do
  gateway" (`stream.rs:163-169`; `store.rs:45-49`). `raw:v1` é o mesmo desenho
  **sem** a guarda.

#### 4.0.3 `mag:v1` / `mag_meta:v1` — dono único (processo Node)

| chave/prefixo | dono de execução | escritores | leitores | TTL/cota | limpeza |
|---|---|---|---|---|---|
| `mag:v1:{alive\|bad\|lie}:<adapter>:<scope>:<hash>` | **Node** (`src/utils/magnetdb.ts`) | `magnetdb.ts:112` (`setMany` de `markAlive`), `:150` (`cache.set` de `markBad`) + `:154` (`cache.forget` do alive), `:207` (`cache.set` de `markLie`), `:189-195` (`forgetBadKey`) | `magnetdb.ts:127` (`isAlive` → ⚡ por histórico em `debrid-cache-steps.ts:145`), `:166` (`isBad`), `:220` (`isLie`), `:228-236` (`peek*`), `:265` (`status` do painel); Rust lê só `bad`/`lie` read-only (`adom-store/src/magnet_db.rs:31`, `:74-79`, ligado em `stream.rs:151-159`) | `MAGNET_ALIVE_TTL` 7 d, `MAGNET_BAD_TTL` 24 h, `MAGNET_LIE_TTL` 7 d (`src/config/audit.ts:14-19`); cota `mag` 50.000 (`cache-quotas.ts:79`) | TTL + LRU da cota; `markBad` apaga o alive do mesmo hash (`magnetdb.ts:151-154`). Sem purga própria: expira e cai no `prune`/boot |
| `mag_meta:v1:counts` | **Node** (`magnetdb-persist.ts`) | `magnetdb-persist.ts:54-64` (`cache.set` no `setImmediate` de `:69`) | `magnetdb-persist.ts:132` (`cache.peek` na retomada) | TTL `max(aliveTtl, 7 d)` (`:64`); cota 1 (`cache-quotas.ts:81`) | Sobrescrita do próprio agregado; nenhuma remoção dedicada |

Sem dois escritores: o Rust abre `data/cache.db`/`mag:v1` com
`SQLITE_OPEN_READ_ONLY` (`magnet_db.rs:74-79`) e não há `put` de `mag` em
produção — `WRITABLE_PREFIXES` (`adom-debrid/src/store.rs:20-21`) só vale para
`open_memory` (`:69-77`), usado por testes (`store_tests.rs:18`). Risco real é o
oposto: **o corte de `davail` arrasta este namespace**, porque `checkCached`
grava os dois na mesma função (`cache-check.ts:383` e `:388`) e o `noteAvailable`
também grava `davail=1` e `markAlive` juntos (`:158` e `:162`).

#### 4.0.4 `data/magnets.db` — dois escritores (`magnet_work`)

| chave/prefixo | dono de execução | escritores | leitores | TTL/cota | limpeza |
|---|---|---|---|---|---|
| `magnet`, `magnet_source` (PK `hash`/`hash+indexer`) | **Node** (`src/utils/magnet-bank.ts` → `magnet-bank-rows.ts:276-292`) | `magnet-bank.ts:237` (`captureItems`), `:225` (`writeBatch` com as três tabelas) | leitura nativa do Rust (`magnet_bank.rs:153-156`, `:303-327`) para instantânea/`pickSource` | **sem TTL e sem cota** (acervo permanente) | Nenhuma automática. `DELETE FROM magnet` existe só em `clearRows` (`magnet-bank-rows.ts:196-198`), chamado por `resetForTests` (`:379-382`) |
| `magnet_work` (`hash+imdb+season+episode`) | **Rust** no fim da busca (`late.rs:215`) **e Node** na fila de captura/filtro (`magnet-bank.ts:222`) | Rust: `magnet_bank.rs:339-376` (`UPDATE … SET passed_filter = ?1, last_seen = ?2` em transação). Node: `magnet-bank.ts:243` (`markFilterResult`) e `:237` (`captureItems`), incluindo o efeito `magnet_capture` que o Rust emite (`late.rs:236` → `internal-search-effects.ts:203`) e o crawler (`crawl-recorder.ts:141`) | O próprio Rust lê para instantânea/filtro (`magnet_bank.rs:153-156`, `:186-188`) e o Node lê no `applyOps` (`magnet-bank.ts:150`, `:202`) | **sem TTL e sem cota** | idem: nada apaga em produção |

**Dois escritores (lost update vivo):**

- Rust grava `passed_filter`/`last_seen` com `UPDATE` incondicional dentro de
  transação (`magnet_bank.rs:365-369`), sem CAS nem guarda de `last_seen`.
- Node grava a MESMA linha **sobrescrevendo** `passed_filter` com o valor lido
  antes: `applyOps` resolve `mark.passedFilter` em `magnet-bank.ts:150`/`:202` e
  `mergeWork` faz `{ ...prev, passedFilter: mark.passedFilter }`
  (`magnet-bank-merge.ts:205-221` — o comentário `:205` diz "é SOBRESCRITO").
- A ordem é de propósito, e é o que cria a janela: no mesmo request o Rust marca
  primeiro (`late.rs:215`) e só então pede a captura ao Node com
  `resetPassedFilter:false` (`late.rs:171-175`, `internal-search-effects.ts:194-201`).
  Se a fila do Node atrasar (é `setTimeout(run, 0)`, `magnet-bank.ts:68-73`), a
  captura lê antes da marca e regrava o valor velho por cima.
- Não há TTL nem cota para amortecer: o valor errado fica até alguém regravar.

#### 4.0.5 Corte proposto (ordem, rollback, bloqueio)

A ordem `davail` → `raw:v1` → `magnets.db` **continua segura** como ordem de
corte (fácil → difícil), mas ela **não** é a ordem de gravidade: o lost update de
`magnet_work` está vivo hoje (`4.0.4`) e não deve esperar o corte de `raw:v1`.
Mitigação imediata, sem trocar dono: `UPDATE` monotônico/CAS em
`magnet_bank.rs:365-369` (só avança `last_seen`, e `passed_filter` só com
`last_seen <= ?`) + `mergeWork` do Node condicionado a `last_seen` — é o aceite
"leitura–merge–gravação atômica" sem transferência.

1. **`davail` — declarar dono, não transferir.** Transferir = implementar
   `noteAvailable`/`noteUnavailable`/davail-positivo no Rust **e** apagar as
   três escritas do Node (`cache-check.ts:158`, `:193`, `:383`) na mesma
   entrega; manter os dois é o bug que a fase quer evitar. Ordem interna:
   (a) fixar o dono por teste (Rust recusa `put` de `davail` no store de
   arquivo — hoje só vale para memória); (b) dar ao painel/`br-coverage` uma
   ponte de leitura antes de qualquer mudança de processo (`br-coverage.ts:118`
   usa `cache.peek`, que é L1 do Node); (c) só então mover a escrita, junto com
   `mag:v1` (`4.0.3`), porque saem da mesma função.
   Rollback: reverter o commit; o dado é TTL de 15 min/2 min, não há migração.
2. **`raw:v1` — parar um escritor antes de declarar dono.** (a) ✅ `e0b32cec`: o Node parou de
   escrever `raw:v1:bludv:*` (`bludv.ts:234`) — o Rust já cobre a mesma chave
   (`client.rs:183-185`); (b) ✅ `4a9e01a8`: o Node trata o prefixo `raw:v1:bludv:`
   como estrangeiro (**por prefixo** — `RUST_OWNED` é por namespace e `raw` é
   compartilhado por BLUDV e Jackett): `get`/`peek`/`set`/`setMany`/`forget`/
   `forgetMany`/`persist`, boot e poda do expirado; (c) `raw:v1:jackett:*` fica no
   Node até a Fase 5, porque o coletor Jackett nativo ignora o store
   (`sources_rust.rs:25-27`). Sem (a), qualquer "dono único" é falso.
   Rollback: imagem anterior; as linhas expiram em ≤ 30 min e o schema é o
   mesmo, então não há migração a desfazer.
   **Bloqueado por push:** medir a taxa de hit do `raw` BLUDV depois de (a) —
   precisa de tráfego e do volume de produção.
3. **`mag:v1`/`mag_meta:v1` — junto com `davail`, não depois.** Mesma função
   (`cache-check.ts:388`), mesmo play (`magnetdb.ts:112`). O Rust já é
   read-only; o corte é só apagar a escrita Node quando a checagem migrar.
   Rollback: reverter o commit (TTL 7 d/24 h, sem migração).
4. **`magnets.db` — por último, e por transação, não por transferência.**
   (a) CAS nos dois lados (`magnet_bank.rs:365-369` + `magnet-bank-merge.ts:205`);
   (b) declarar um único executor de `magnet_work` — o Rust já marca no fim da
   busca e o Node só precisa parar de sobrescrever; (c) `magnet`/`magnet_source`
   continuam Node-only (o Rust não cria linha, `magnet_bank.rs:335-337`) e podem
   ficar para a Fase 5. **Não transferir as três tabelas juntas.**
   Rollback: backup do `magnets.db` com os dois produtores parados e drenados —
   restaurar SQLite **não** desfaz exclusão no debrid, mas aqui não há debrid
   envolvido; a perda aceitável é a janela de `last_seen` do lote.
   **Bloqueado por push:** ensaio de restauração em cópia isolada e canário do
   CAS com tráfego real.

O que **não** muda com esta matriz: `streams:v21`/`idx:v14` seguem Rust-owned
(`cache-keys.ts:190-192`; ponte da admin API em `streams-store-native.ts:9`/`:147`),
e o `magnetdb`/`davail` continuam no caminho de efeito do play
(`internal-resolve.ts:83`) até a Fase 3 fechar.

Aceite por namespace:
- leitura–merge–gravação atômica (CAS/transação ou dono único de execução);
- leitores antigos não observam cópia obsoleta (bloqueio explícito no L1/L2);
- `br-coverage`, painel e `/stream-trace.json` leem do dono novo;
- backup consistente com produtores parados e drenados; restauração ensaiada em
  cópia isolada. **Restaurar SQLite não desfaz exclusão no debrid** — declarar a
  perda aceitável por corte.

## Fase 5 — Colhedor no Rust

Antes de apagar `jackett*.ts`/`search-plan.ts`/`bludv.ts`/`harvest-*`/`harvester*`:
- portar a coordenação da sonda BR (`br-probe` decide `pending` pela fila);
- trocar os contratos vivos de diagnóstico/painel e o `peekRawFor` local do
  `trace-recompute` (sem virar busca de rede);
- dedupe 12h, balde horário durável, coalescing em voo, `take_probe` sob tráfego,
  `BrEvidence` e `idxPoolCovered` no `adom-harvest`;
- transferir a fila (`harvest:v1:q`) com consumidor antigo parado e órfãos
  recuperados; replay idempotente;
- **só então** apagar por ausência comprovada de consumidor.

**Estado em `b8cace24`:** a coordenação da sonda virou máquina de estado no crate
(`adom-harvest::probe`, alvo → tentativa → prazo → veredito, 17 testes) e o
`peekRawFor` do trace lê o envelope `{ items }` do `raw:v1` sem rede (contrato
`test/warm-cache-contract.test.ts`, 0 hit/0 miss no recompute).

**Fechada (working tree, sem commit).** O gateway usa o crate com as fontes
nativas e a pilha TS saiu:

- `tick_async` no crate (`HarvestDrainAsync`); a future **não é `Send`**, então o
  worker roda em `std::thread` + runtime `current_thread` no `adom-server`;
- drain com `MetaSources` → `JackettClient` → `filter_relevant_raw` →
  `harvest_support::{release_entry_for, record_release}` (índice nativo);
- fila/dedupe/balde no MESMO `data/cache.db` do Node (schema `cache` idêntico);
  namespace `harvest` Rust-owned no Node;
- contrato HTTP na admin do gateway (`GET /harvest`, `POST
  /harvest/enqueue|pause|drain|clear`, `GET /harvest/pending`) — detalhe em
  [`docs/harvest-native-contract.md`](../../harvest-native-contract.md);
- apagados: `src/providers/{jackett*,bludv,search-plan,harvest-*,harvester*}`
  (16 arquivos, 3.254 linhas) e 33 testes + 1 helper (7.299 linhas).

Dívidas declaradas: o drain cobre Jackett (o coletor BLUDV nativo não entra na
colheita); o overlay `cfg:v1:harvester` do Node não chega ao Rust; a captura
assíncrona do banco de magnets continua no caminho do `/stream`.

## Fase 6 — Raspador do Mico no Rust

Plugar `mico.rs` + `mico_net` no motor do sidecar **junto** com: scheduler TS
(`crawler.ts:126-145`), claim do Rust (`store/ops.rs:142-148`), `ownPace`, full
sweep de 24h, fim por vazias seguidas, progresso monotônico de séries.

Depois: `rust: true` no registro, apagar `crawl-sites/mico*`, `CRAWL_ENGINE=ts` e
reescrever os testes que dependem do loop TS.

**Estado em `b2ee8881`: feito o runtime, pendente o legado.** No sidecar entraram
`mico_discovery` (passo fixo 25→50, página vazia intermitente, fim por vazias
seguidas, `MAX_PAGES`/`EMPTY_RETRIES`/`END_AFTER_EMPTIES`), `mico_page`, `mico_lane`
(`own_pace` fora das vagas de `CRAWL_MAX_PARALLEL`), `store/url_key` e o registry
com `rust: true`. `crawler.ts` não agenda mais o Mico. O que **não** foi feito e
virou dívida declarada: `crawl-sites/mico*` ainda existem para a sonda
de 40 (`scripts/crawl-site-probe.ts`) e os testes `crawl-mico*`; `CRAWL_ENGINE=ts`
fica porque a suíte depende do loop TS dos oito cards do Jackett.

Subfase explícita que faltava no plano anterior: **fechar a ingestão do crawl**
(hoje `engine Rust → POST Node → identify/record → mark_result`). Migrar só o
Mico não elimina essa fronteira para os outros oito sites.

## Fase 7 — Chupim e o resto do fundo

Separar por contrato de recuperação: autofetch/recheck · br-probe · rd-warmer ·
dub-audit · varreduras (`sweepDead`/`sweepUndubbed`). Cada um entrega:
contexto explícito de conta/adaptador · recuperação após crash · reconciliação
quando o serviço aceitou mas a resposta se perdeu · idempotência dos efeitos ·
um único consumidor durante o cutover.

`dub-audit` preserva o caráter oportunista (durável seria mudança funcional).

## Fica no Node (alvo final)

Express/rotas de config, `/configure`, painel, `/dashboard-*.json`, auth/token das
rotas de diagnóstico e o feed de holds enquanto durar a Fase 3b.

---

## Verificação por fase

**Local (todo commit):**

```bash
npm run typecheck && npm run build && npm test && npm run test:complete
npm run lint:lines -- --check
node scripts/check-rust-lines.mjs
cd rust && cargo fmt --all -- --check && cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

**Gates do `/stream`** (ao tocar busca/fontes/debrid):

```bash
npm run parity:frozen
cd rust && cargo test -p adom-search --test stream_e2e_parity
cargo test -p adom-search --test search_budget_metadata
```

**Docker local** (ao tocar imagem/entrypoint/compose): `docker compose up -d --build`,
`docker inspect stremio-adom --format '{{.State.Health.Status}}'` = `healthy`.

**Produção** (só após push autorizado, skill `adom-vps`): deploy no log ·
`healthy` · sem restart/OOM · memória < 3 GiB · `/stream` filme+série · play
AllDebrid · logs sem `source_missing` · métrica da fase.

**Rollback:** commit/imagem anterior; backup de `docker-data/addon` antes de
qualquer fase que mude formato de banco (Fase 4).

## Riscos declarados

| Risco | Onde | Mitigação |
|---|---|---|
| CI continua vermelho no remoto até push do `esm` | `origin/esm` sem os 4 commits | Task 0.1 transforma em aviso; paridade provada localmente no worktree |
| Gate .rs morto esconde regressão de tamanho | 45 fontes > 400 | Task 0.2 (ratchet) — arquivo novo acima do teto reprova |
| WIP do usuário contamina "verde" | 14 falhas | baseline explícita; nunca `git add -A` |
| Apagar warmup tira pré-alimentação do banco | `src/warmup.ts` | colhedor cobre; medir captura após o corte |
| Fallback de metadados mascarado por `name = imdb` | `meta_native.rs:113-157` | `meta.native.incomplete` antes de qualquer corte |
| Dois escritores no mesmo SQLite | Fase 4 | dono de execução + transferência com produtores parados |
