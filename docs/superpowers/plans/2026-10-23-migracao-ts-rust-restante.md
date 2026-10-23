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
| WIP do usuário | `package.json`, `rd-probe.ts` (deletado), `rd-warmer.ts`, `br-gap.ts`, `cache*.ts` e 12 testes — **não é nosso; não commitar sem decisão dele** |
| `fallback.indexer.*` | não existe mais produtor (nem Node nem Rust incrementam) → `fallbackServed` do painel é 0 por construção |
| `config.magnetBank.fallback*` | 3 chaves declaradas em `src/config/cache.ts`, **zero leitores** |

---

## Fase 0 — Base confiável (executar agora)

### Task 0.1: destravar o job Rust no CI

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

### Task 0.2: catraca `.rs` vira ratchet com baseline

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

### Task 0.3: baseline do WIP do usuário — **BLOQUEADA**

As 14 falhas de `npm test` vêm do WIP (streams fora do L1). Enquanto não houver
decisão do usuário (terminar e commitar × deixar intocado), toda validação de
fatia roda com **baseline declarada**: as 14 falhas não podem crescer, e
qualquer falha nova reprova a fatia.

Nomes exatos para diff de baseline (guardar em `test_baseline.txt` local, fora do
git): LRU do índice (320), season fill "Temporada Completa" (322), clear-cache por
instalação (908), Tier 2 e2e (1320), `mode=live` (2397, 2398), `/stream-trace.json`
(2408, 2410–2416).

---

## Fase 1 — Limpeza barata (executar agora, em paralelo à Fase 0)

### Task 1.1: apagar o warmup

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

### Task 1.2: apagar `config.magnetBank.fallback*`

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

### Task 1.3: `fallbackServed` para de mentir 0

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

Ordem por risco: `davail` → `raw:v1` → `magnets.db`. Cada namespace precisa de
**matriz de propriedade**: dono de execução (não só de linguagem) → consumidores
→ TTL/cota → invalidação → limpeza → transferência → rollback.

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
- dedupe 12h, `inflight`, `BrEvidence` e `idxPoolCovered` no `adom-harvest`;
- transferir a fila (`harvest:v1:q`) com consumidor antigo parado e órfãos
  recuperados; replay idempotente;
- **só então** apagar por ausência comprovada de consumidor.

## Fase 6 — Raspador do Mico no Rust

Plugar `mico.rs` + `mico_net` no motor do sidecar **junto** com: scheduler TS
(`crawler.ts:126-145`), claim do Rust (`store/ops.rs:142-148`), `ownPace`, full
sweep de 24h, fim por vazias seguidas, progresso monotônico de séries.

Depois: `rust: true` no registro, apagar `crawl-sites/mico*`, `CRAWL_ENGINE=ts` e
reescrever os testes que dependem do loop TS.

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
