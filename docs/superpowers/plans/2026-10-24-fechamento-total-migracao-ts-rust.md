# Fechamento total da migração TS → Rust (fases 3, 4, 5H, 6 e 7)

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> (ou `executing-plans`) para executar tarefa por tarefa. Cada fatia é um commit.
> Passos em checkbox (`- [ ]`).

**Goal:** terminar a migração do Adom até o Node ser casca de HTTP (rotas, painel,
`/configure`, config e efeitos que restarem), com Rust dono de regra, estado,
debrid, fontes, cache, índice e dos workers de fundo — apagando o TypeScript
correspondente na MESMA fatia que o torna inalcançável.

**Architecture:** três trilhas paralelas por leva, com arquivos disjuntos:
**T1** hardening do colhedor (5H), **T2** estado/debrid (fases 3 e 4), **T3**
Chupim, ingestão do raspador e workers (fases 6 e 7). A receita é a já provada
no repo: provar no Rust com o TS intacto → Node vira fachada/ponte → apagar o
TS. Um commit por fatia; rollback = commit/imagem anterior (nunca knob de env em
caminho de leitura).

**Tech Stack:** Node ≥ 20 + TypeScript/ESM (`dist/` roda), Rust 1.92.0 pinada em
`rust/rust-toolchain.toml`, napi-rs (`adom-napi`), SQLite (`cache.db`,
`streams.db`, `crawl.db`, `magnets.db`) e o branch `esm` (worktree
`E:/adom-esm`) como oráculo dos goldens.

---

## 1. Regras de execução (valem em toda fatia)

- **Três frentes em paralelo por leva, uma por trilha.** Dentro da mesma trilha
  as fatias são **seriais** (elas compartilham arquivos). Nunca dois agentes no
  mesmo arquivo; se duas trilhas colidirem em um arquivo, a fatia vira serial e
  o plano é corrigido antes de começar.
- **Validação local antes do commit** (PowerShell, um comando por linha):
  ```powershell
  npm run typecheck
  npm run build
  npm test
  npm run test:complete
  npm run lint:lines -- --check
  git diff --check
  ```
  E, quando a fatia toca `.rs`:
  ```powershell
  cd rust
  cargo fmt --all
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets --locked -- -D warnings
  cargo test --workspace --locked
  cd ..
  node scripts/check-rust-lines.mjs
  ```
- **Gate do `/stream`** quando a fatia toca busca, fontes, cache ou debrid:
  ```powershell
  npm run parity:frozen
  cd rust
  cargo test -p adom-search --test stream_e2e_parity
  cargo test -p adom-search --test search_budget_metadata
  cd ..
  ```
- **Commit sem push.** `git add` só dos arquivos da fatia. O working tree tem
  lixo alheio permanente (`.cursor/`, `.codex/`, `plugins/`,
  `docker-compose.override.yml`, `.cursor/agents/*.md`) que **nunca** entra.
  `package-lock.json` está modificado e não é da fatia: não arraste.
- **Prefixo convencional por área, assunto em português sem acento:**
  `feat(harvest): …`, `fix(search): …`, `refactor(state): …`,
  `refactor(autofetch): …`, `refactor(crawl): …`, `docs(plano): …`.
- **Apagar o TS é parte da fatia.** Uma fatia que torna um arquivo inalcançável
  termina com `DeleteFile` + remoção da entrada em `package.json` →
  `testFiles` (senão `npm run test:complete` e `npm test` quebram). Arquivo
  untracked não conta: use `git rm` só quando o arquivo está rastreado.
- **Teste `.test.ts` novo entra em `testFiles`**; teste `.test.ts` apagado sai
  da lista na mesma fatia.
- **Goldens não são regenerados aqui.** Os checks cujo corpo TS saiu do `src/`
  rodam no worktree `../adom-esm`. Para regenerar: `cd ../adom-esm && npm run
  golden:<x> -- --force`. Nunca edite `rust/golden/*.jsonl` neste checkout.
- **Nada fora de `test/` importa de `test/`.** Nenhum teste importa
  `src/addon.ts` (sobe o servidor).
- **Não faça:** push, deploy, `git add -A`, limpar `data/*.db`, habilitar
  switch destrutivo, mexer no `.env` do operador, `npm install` sem necessidade
  (a leva 0 é a única que instala).
- **Catraca:** 400 linhas por fonte `.ts`/`.js`/`.css` e por `.rs`. Baseline
  `.line-budget.json` vazia: arquivo novo acima do teto reprova. Quando um
  arquivo medido aqui estiver perto do teto (`probe_tests.rs` 399,
  `probe.rs` 390, `worker.rs` 371, `drain_sources_tests.rs` 372), o código novo
  nasce em **arquivo novo**, citado na fatia.
- **Container local:** só rebuildar quando a fatia mudar imagem/entrypoint. Se
  medir comportamento ao vivo, rebuild antes — o container local está hoje **1
  commit atrás** do HEAD.

---

## 2. Estado de partida medido (2026-10-24, `rust` @ `9cd6e0fe`)

| Item | Medido |
|---|---|
| Git | `rust` @ `9cd6e0fe` = `origin/rust` (sincronizado). Working tree: `package-lock.json` modificado + untracked alheios. 3 stashes. |
| Toolchain local | `node_modules` **sem** `typescript`/`@types` (só deps de produção). `npm run typecheck` falha. `dist/` (839 arquivos) é artefato anterior. |
| Container local | `stremio-adom` `healthy`, criado 21:05 (-03) contra HEAD de 21:13 → **1 commit atrás**. |
| Suíte | não medida nesta sessão (toolchain). Última medição declarada no repo: `npm test` 2.495/2.495 e `cargo test --workspace` 0 falhas em `2026-10-24`. |
| `RUST_OWNED` | `['idx','streams','raw']` por namespace + `harvest` por prefixo (`src/utils/cache-keys.ts:201-218`). |
| `davail` | escritores todos Node (`cache-check.ts:158`, `:193`, `:383`); **zero** leitura/escrita de produção no Rust (store do arquivo é read-only, `adom-debrid/src/store.rs:56-67`). |
| `mag`/`mag_meta` | escritores Node (`magnetdb.ts:112/150/207`, `magnetdb-persist.ts:64`); Rust lê só `bad`/`lie` (`adom-store/src/magnet_db.rs:29-31`). |
| `adsub`/`adrm`/`adprot` | escritores Node (`alldebrid-inventory.ts:112`, `alldebrid-reupload.ts:92`, `protected.ts:98/123`); Rust lê (`cleanup_durable.rs:148-227`). |
| `magnets.db` | `magnet`/`magnet_source`: só Node. `magnet_work`: Rust + Node, ambos com CAS (`magnet_bank_write.rs:150-151`, `magnet-bank-rows.ts:155`). |
| `/debrid/*` | `/debrid/check` nativo nos 5; `/debrid/link` e `/debrid/resolve` nos 5; `/debrid/account` nos 4 (Debrid-Link 501); `/debrid/files` só Premiumize. |
| `DEBRID_RUST_SERVICES` | `.env` usa `real-debrid`/`debrid-link`, mas os ids do registry são `realdebrid`/`debridlink` (`registry.ts:68`) → **2 serviços nunca são envolvidos**. A normalização é código (`src/config/debrid.ts:16`). |
| 5H | **não existe** journal, inflight durável, `run_id`, fencing, preempção intradrain, teto entre consultas nem `quick_check`. Só `LatestWriter` (intra-busca, em memória). |
| Ingestão do crawl | sidecar → `POST /internal/crawl-result` → `identifyWork` (TMDB Node) → `recordCrawlReleases` (banco vivo + índice + invalidação). |
| Chupim | 25 arquivos / **4.232 linhas** + 25 testes / **6.302 linhas**; 17 módulos puros já portados em `adom-core`, mas só 3 fiados no Node (`release_filters`, decisão em lote, `filter_known_cache`). |
| Métricas de cronômetro | `teto` do harvest é checado só no `plan` (`adom-harvest/src/worker.rs:255-257`) e debitado só no `finish` (`:282`). |

**Correções à matriz histórica** (o plano de 2026-10-23 está defasado nestes
pontos; não repetir como estado vivo):

1. `raw:v1` **não** tem dois escritores: o escritor TS do Jackett saiu com a
   fase 5 e `raw` entrou em `RUST_OWNED` por namespace inteiro.
2. "commit local sem push" expirou: `origin/rust` acompanha o HEAD.
3. A fase 3 residual **não é** falta de porte de rede — é (a) apagar corpos TS
   que só rodam no 501, (b) `/debrid/files` fora do Premiumize, (c)
   `accountStatus` do Debrid-Link (seguirá 501 para sempre).
4. A fase 6 residual **não é** "reescrever a rota": depende da posse de
   `magnets.db` (fase 4) e de identificação TMDB nativa.

---

## 3. Decisões de arquitetura (fechadas)

### 3.1 Dono final por estado

| Estado | Dono final | Como chega lá |
|---|---|---|
| `streams`, `idx`, `raw`, `harvest` | Rust (já) | — |
| `magnet`, `magnet_source` | Rust | busca captura no `late`; raspador captura no recorder nativo; o Node para de emitir `magnet_capture` e de chamar `captureItems` |
| `magnet_work` | Rust | já tem CAS; o Node deixa de escrever na fatia do recorder nativo |
| `davail`, `mag`, `mag_meta` | Rust | **juntos**, na fatia do worker do Chupim (os três nascem da mesma função `checkCached`) |
| `adsub`, `adprot` | Rust | na fatia do worker do Chupim (posse/proteção é pré-requisito do delete) |
| `adrm` | Rust | na fatia das varreduras AllDebrid |
| `autofetch:*`, `rdq:*` | Rust | na fatia do estado do Chupim |
| `cfg:v1:*` | Node (control plane) | painel continua escrevendo; o gateway recebe `POST /autofetch/config` e `POST /harvest/config` |
| `crawl.db` (`crawl_url`/`crawl_run`/`crawl_state`) | Sidecar Rust (já) | 3 escritas residuais do Node viram rotas do sidecar |

**Rejeitado:** dividir `mag` por prefixo (`alive` no Node, `bad`/`lie` no Rust).
`markBad` apaga o `alive` do mesmo hash na mesma função (`magnetdb.ts:151-154`);
com donos diferentes o `alive` velho sobreviveria e pintaria ⚡ falso. `mag`
move inteiro ou não move.

**Rejeitado:** entregar `davail` ao Rust antes do Chupim. O único escritor vivo
é a orquestração de checagem que o autofetch consome; transferir antes é troca
de dono sem consumidor e cria duas versões do insumo do recheck.

### 3.2 KV nativo para o estado do Chupim

Novo `rust/crates/adom-store/src/kv.rs` — `NativeKv`, sobre a **mesma** tabela
`cache (key, value, expires_at)` do `data/cache.db`, com o mesmo `SCHEMA` e o
mesmo padrão do `HarvestStore` (`adom-harvest/src/store.rs:28-37`):

```rust
pub struct NativeKv { conn: Mutex<Connection> }

impl NativeKv {
    pub fn open(path: &Path) -> Result<Self, String>;
    pub fn open_memory() -> Result<Self, String>;
    pub fn get_json(&self, key: &str, now_ms: i64) -> Result<Option<serde_json::Value>, String>;
    pub fn put_json(&self, key: &str, value: &serde_json::Value, ttl_seconds: u64, now_ms: i64) -> Result<(), String>;
    pub fn forget(&self, key: &str) -> Result<usize, String>;
    pub fn keys_matching(&self, prefix: &str, now_ms: i64) -> Result<Vec<String>, String>;
    pub fn clear_prefix(&self, prefix: &str) -> Result<usize, String>;
}
```

Regras: `get_json`/`keys_matching` apagam a linha expirada (como o
`cache.get` do TS); `put_json` com `ttl_seconds == 0` grava com `expires_at =
i64::MAX` (TTL desligado, como `setMany` faz em `cache.ts:231`); o namespace é
declarado em `RUST_OWNED_PREFIXES` **antes** do primeiro uso (senão o L1 do
Node nasce com uma fila velha). `keys_matching` é obrigatório para
`autofetch-suppressed`/`autofetch-obra` — hoje **não existe** no `RawCacheStore`
(`adom-index/src/raw.rs` só tem `get/peek/set/clear_all`).

### 3.3 Fence de invalidação (5H-C)

Tabela nova no MESMO `data/streams.db`, fora do namespace de cache (para
`clear_all` não apagar o contador):

```sql
CREATE TABLE IF NOT EXISTS streams_meta (
    key   TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);
```

- Chaves: `gen:obra:<tipo>:<tt[:S:E]>` e `gen:epoch`.
- `invalidate_for_obra` passa a ser **uma transação**: `BEGIN IMMEDIATE` →
  `INSERT … ON CONFLICT DO UPDATE SET value = value + 1` na obra →
  `DELETE` das chaves da obra → `COMMIT`.
- `clear_all`, `clear_by_suffix` e `invalidate_for_hash` incrementam
  `gen:epoch` (o último, também a geração de cada obra cujas chaves removeu).
- `fence_for_key(&self, key) -> Fence { obra: u64, epoch: u64 }`.
- `set_fenced(key, value, ttl, now, fence) -> Result<bool, String>`: na mesma
  transação, lê as gerações; se `fence.epoch < epoch` ou `fence.obra < obra`,
  devolve `Ok(false)` (descarta) e **não** grava.

No `adom-search`: `SwrStore` (`cache.rs:103-116`) ganha `fence_for_key` e
`set_fenced`; `MemorySwrStore` ganha dois `HashMap` + `AtomicU64` para testes;
`SearchInput` ganha `fence`; a captura acontece em `route.rs:40` e
`refresh.rs:32`, **antes** do `get_with_stale`; o commit usa `set_fenced` em
`finish.rs:187-193` e `late.rs:330-335`; `StaleRescue` também é filtrado.

### 3.4 Crate do Chupim

- `rust/crates/adom-autofetch` — máquina de estado pura + fila/lease/obra/
  suppressed/terminal, dependendo de `adom-core` (regras já portadas) e
  `adom-store` (`NativeKv`, banco de magnets). **Sem rede.**
- `rust/crates/adom-server/src/autofetch/` — worker com thread própria, no
  molde de `src/harvest/`: `mod.rs`, `config.rs`, `drain.rs`, `routes.rs`,
  `status.rs`, `warmer.rs`. É ele que chama `adom-debrid` (rede) e grava
  `davail`/`mag`/`adsub`/`adprot`.
- Efeitos `autofetch`, `autofetch_batch`, `rd_warmer`, `dub_audit`, `br_probe`,
  `season_key` deixam de atravessar HTTP: o worker nativo consome direto. O
  `POST /internal/search/effects` continua existindo só para os efeitos que o
  Node ainda executa (`magnet_capture` some na T2-L1; `dub_audit` some na
  T3-L6).
- `dub-audit` continua **oportunista** (fila em memória, limitada) — torná-lo
  durável é mudança de produto, não porte.
- Paridade: regras puras por golden (`adom-core/tests/*_golden.rs`); worker por
  teste de comportamento com stubs (`NetworkDrain` é o precedente do harvest),
  **não** por golden de rede.

### 3.5 Fase 2 (metadados) — fora do executável local

Remover `FallbackMetaSource` e `POST /internal/search/meta` exige janela
observada em produção. Instrumentação já está commitada (`696e0d9d`). Esta
fase fica na **Leva 9**, marcada como bloqueada por autorização de medição em
produção; não é pré-requisito das outras.

---

## 4. Levas

Cada leva tem 3 fatias, uma por trilha. As fatias de uma mesma trilha são
seriais (leva N+1 da trilha depende da leva N dela). As três trilhas nunca
compartilham arquivo.

| Leva | T1 — Colhedor (5H) | T2 — Estado / debrid | T3 — Chupim / raspador |
|---|---|---|---|
| 0 | (base: toolchain + baseline + código morto) — agente único | — | — |
| 1 | A1 teto rígido por consulta | L1 captura nativa do banco de magnets | L1 fiar regras puras do Chupim |
| 2 | A2 preempção intradrain | L2 `NativeKv` + ponte de leitura napi | L2 identificação TMDB nativa |
| 3 | A3 integridade/quarentena SQLite | L3 fase 3 residual (corpos TS, ids, files) | L3 recorder/ingestão nativos |
| 4 | B1 slot em voo durável | L4 `magnet_work` dono único | L4 estado do Chupim nativo |
| 5 | B2 journal + outbox de invalidação | L5 `davail`/`mag`/`mag_meta` → Rust | L5 worker do Chupim (candidatos/batch/gate) |
| 6 | B3 replay/exactly-once | L6 `adsub`/`adprot` → Rust + fim do feed de holds | L6 worker do Chupim (recheck/evict/seeds) |
| 7 | C1 contador de geração + `set_fenced` | L7 `adrm` + dono das varreduras | L7 `rd-warmer` e `dub-audit` nativos |
| 8 | C2 captura/uso da fence nos commits | L8 limpeza de pontes e shims | L8 varreduras AllDebrid nativas |
| 9 | (bloqueada) fase 2 metadados — exige janela em produção | | |

---

## Leva 0 — Base confiável (agente único)

Sem base verde não se inicia refactor. Esta leva não muda comportamento.

### Task 0.1: restaurar o toolchain e medir a baseline

**Files:**
- Modify: `package-lock.json` (consequência do install — **não** commitar)

- [ ] **Step 1: instalar as devDependencies**

Run: `npm install`
Expected: `node_modules/.bin/tsc` existe; `node_modules/typescript` presente.

- [ ] **Step 2: rodar a baseline e registrar os números**

Run (um por linha):
```powershell
npm run typecheck
npm run build
npm test
npm run test:complete
npm run lint:lines -- --check
node scripts/check-rust-lines.mjs
```
Expected: `typecheck` exit 0; `build` gera `dist/src/addon.js`; `npm test`
imprime `# pass N` / `# fail 0`; `test:complete` lista todos os arquivos;
`lint:lines` com 0 acima do teto; catraca Rust com baseline 0.

- [ ] **Step 3: registrar a baseline no plano**

Acrescente ao final deste documento uma seção `## Baseline medida (Leva 0)`
com a contagem de `npm test`, `test:complete` e `check-rust-lines`. Se algo
falhar **antes** de qualquer mudança, pare e reporte: é dívida anterior, não
desta leva.

- [ ] **Step 4: commit da documentação da baseline**

```powershell
git add docs/superpowers/plans/2026-10-24-fechamento-total-migracao-ts-rust.md
git commit -m "docs(plano): baseline medida da leva 0 do fechamento total"
```

### Task 0.2: normalizar os ids de `DEBRID_RUST_SERVICES`

**Files:**
- Modify: `src/config/debrid.ts:16`
- Test: `test/debrid-rust-remote.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: escrever o teste que falha**

Em `test/debrid-rust-remote.test.ts`, adicione:

```ts
test('DEBRID_RUST_SERVICES aceita id com hifen e sem hifen', () => {
  assert.deepEqual(normalizeRustServices('real-debrid,debrid-link,alldebrid'), [
    'realdebrid', 'debridlink', 'alldebrid',
  ]);
  assert.deepEqual(normalizeRustServices('realdebrid'), ['realdebrid']);
});
```

Exporte `normalizeRustServices` de `src/config/debrid.ts`.

- [ ] **Step 2: rodar e ver falhar**

Run: `npm run build; node --test dist/test/debrid-rust-remote.test.js`
Expected: FAIL `normalizeRustServices is not a function`.

- [ ] **Step 3: implementar**

Em `src/config/debrid.ts`:

```ts
const SERVICE_ALIASES: Record<string, string> = {
  'real-debrid': 'realdebrid',
  'debrid-link': 'debridlink',
  'premiumize-me': 'premiumize',
};

export function normalizeRustServices(raw: string | undefined): string[] {
  return String(raw || '')
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean)
    .map((id) => SERVICE_ALIASES[id] ?? id);
}
```

E troque a linha 16 por `rustServices: normalizeRustServices(process.env.DEBRID_RUST_SERVICES),`.

- [ ] **Step 4: rodar e ver passar**

Run: `npm run build; node --test dist/test/debrid-rust-remote.test.js`
Expected: PASS.

- [ ] **Step 5: atualizar o `.env.example`**

Trocar o comentário defasado e os ids:
```
DEBRID_RUST_SERVICES=alldebrid,premiumize,realdebrid,torbox,debridlink
```

- [ ] **Step 6: commit**

```powershell
git add src/config/debrid.ts test/debrid-rust-remote.test.ts .env.example
git commit -m "fix(debrid): normaliza ids com hifen em DEBRID_RUST_SERVICES"
```

### Task 0.3: apagar o código morto provado

**Files:**
- Delete: `src/debrid/premiumize-files.ts`
- Modify: `src/providers/magnet-bank-hook.ts`
- Modify: `src/utils/magnet-bank.ts`
- Modify: `package.json` (`testFiles`, se houver teste dedicado)

- [ ] **Step 1: provar que não há chamador vivo**

```powershell
rg -n "premiumize-files|scheduleFileLists" src test
rg -n "markBankFilterOutcome|markFilterResult" src test
```
Expected: `scheduleFileLists` só em `premiumize.ts` (corpo que só roda no 501) e
`markBankFilterOutcome` só na própria definição. Se aparecer chamador vivo,
**não** apague e registre no plano.

- [ ] **Step 2: apagar**

Remover `markBankFilterOutcome` (`magnet-bank-hook.ts:69-73`),
`markFilterResult` (`magnet-bank.ts:243-253`) e `premiumize-files.ts` inteiro
com `DeleteFile`.

- [ ] **Step 3: gate**

```powershell
npm run typecheck
npm run build
npm test
npm run test:complete
```

- [ ] **Step 4: commit**

```powershell
git add -A src/debrid src/providers src/utils package.json
git commit -m "refactor(debrid): remove fileList e markFilterResult sem chamador"
```

> **Nota de execução (2026-10-24).** `premiumize-files.ts` (e o teste) e
> `markBankFilterOutcome` saíram, mas `markFilterResult` **ficou**: os testes
> `test/magnet-bank.test.ts` e `test/magnet-bank-lifecycle.test.ts` o chamam
> para exercitar `magnet_work`. A deleção dele (e desses casos) migrou para a
> **T2-L4**, quando a escrita de `magnet_work` for de vez do napi. O commit
> saiu como `c96aec3c` (sem o `markFilterResult`).

---

## Leva 1

### T1-A1: teto rígido entre consultas (`adom-harvest` + `adom-server/harvest`)

**Files:**
- Modify: `rust/crates/adom-harvest/src/worker.rs:115-120,156-162,255-282`
- Modify: `rust/crates/adom-server/src/harvest/drain.rs:324` (impl do trait)
- Modify: `rust/crates/adom-server/src/harvest/drain_sources.rs:131-188`
- Test: `rust/crates/adom-server/src/harvest/drain_sources_tests.rs:372` (cabe)

- [ ] **Step 1: escrever o teste que falha**

Em `drain_sources_tests.rs`:

```rust
#[test]
fn teto_rigido_corta_entre_alvos_jackett() {
    // balde com 119/120 e 10 alvos: só 1 consulta sai e `attempted == 1`.
    let batch = search_jackett_with_budget(&alvos_dez, 1, &stub);
    assert_eq!(batch.attempted, 1);
    assert!(batch.remaining_targets > 0);
}
```

- [ ] **Step 2: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-server --locked teto_rigido_corta_entre_alvos_jackett
```
Expected: FAIL — função inexistente.

- [ ] **Step 3: implementar**

1. `TickStart::Run` ganha `queries_left: u32` =
   `max_per_hour.saturating_sub(queries_this_hour(now))`.
2. `HarvestDrainAsync::drain_one(&mut self, entry, queries_left: u32)`.
3. `search_jackett` recebe `queries_left` e checa `attempted >= queries_left`
   **antes de cada alvo**, parando sem erro.
4. BLUDV continua fora do contador Jackett (contrato
   `docs/harvest-native-contract.md`): não entra no corte desta fatia.

- [ ] **Step 4: rodar e ver passar + gate**

```powershell
cd rust
cargo fmt --all
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
node scripts/check-rust-lines.mjs
```

- [ ] **Step 5: commit**

```powershell
git add rust/crates/adom-harvest rust/crates/adom-server/src/harvest
git commit -m "feat(harvest): teto horario rigido entre consultas do drain"
```

### T2-L1: captura nativa do banco de magnets no fim da busca

**Files:**
- Modify: `rust/crates/adom-store/src/magnet_bank_write.rs`
- Modify: `rust/crates/adom-search/src/orchestrator/late.rs:223-254`
- Delete: `rust/crates/adom-search/src/orchestrator/effects_capture.rs`
- Modify: `src/routes/internal-search-effects.ts:214-231` (remove o braço)
- Test: `rust/crates/adom-store/src/magnet_bank_tests.rs` (novo arquivo)

- [ ] **Step 1: escrever o teste que falha**

```rust
#[test]
fn captura_grava_magnet_e_source_e_preserva_passed_filter_mais_novo() {
    let bank = MagnetBankStore::open_memory().unwrap();
    let n = bank.capture_items(&dois_itens(), "jackett", &ctx(), 1_000).unwrap();
    assert_eq!(n, 2);
    let rows = bank.works_for_obra_many(&["tt1"], &["tt1"]).unwrap();
    assert_eq!(rows.len(), 1);
}
```

- [ ] **Step 2: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-store --locked captura_grava_magnet_e_source
```
Expected: FAIL — `capture_items` inexistente.

- [ ] **Step 3: implementar a captura no store**

Novo método em `magnet_bank_write.rs`, dentro de **uma transação**, espelhando
`applyOps`/`writeBatch` (`src/utils/magnet-bank.ts:159-191`,
`magnet-bank-rows.ts:285-302`): `INSERT OR REPLACE` em `magnet` e
`magnet_source`, `INSERT … ON CONFLICT` em `magnet_work` com o CAS já existente
(`passed_filter` só com `last_seen <= ?`; `last_seen = MAX(...)`).

- [ ] **Step 4: chamar no fim da busca e apagar o efeito**

Em `late.rs:223-254`, quando `MAGNET_BANK` estiver ligado, chamar
`bank.capture_items(&items, "jackett", &ctx, now_ms)` antes do envio de efeitos e **remover** o envio
`magnet_capture`. Apagar `effects_capture.rs` e retirar o braço
`case 'magnet_capture'` de `internal-search-effects.ts`.

- [ ] **Step 5: gate + commit**

```powershell
cd rust
cargo fmt --all
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
npm run typecheck
npm run build
npm test
npm run parity:frozen
git add rust/crates/adom-store rust/crates/adom-search src/routes
git commit -m "feat(search): captura do banco de magnets no fim da busca nativa"
```

### T3-L1: fiar as regras puras já portadas e apagar o TS

**Files:**
- Modify: `rust/crates/adom-napi/src/autofetch/mod.rs`
- Modify: `src/utils/rust-autofetch.ts`
- Delete: `src/providers/autofetch-{policy,fallback,obra-overflow,keys,chupim-trace,expired,progress,gates}.ts`
- Delete: `src/utils/autofetch-picks.ts` (pickers) — **só** se o passo 1 provar
- Delete: `test/autofetch-{policy,expired-ownership,progress,gate,obra-overflow-pending,filter-known,pickers}.test.ts`
- Modify: `package.json` (`testFiles`)

- [ ] **Step 1: provar quais chamadores existem**

```powershell
rg -n "autofetch-(policy|fallback|obra-overflow|keys|chupim-trace|expired|progress|gates)|autofetch-picks" src test
```
Expected: chamadores dentro de `src/providers/autofetch*.ts` e os testes. Se
`autofetch-picks` tiver chamador fora do autofetch (ex.: `stream-ranking.ts`),
**não** apague nesta fatia; registre.

- [ ] **Step 2: escrever o teste que falha**

Em `rust/crates/adom-napi/src/autofetch/tests.rs`, um caso por regra já
portada, afirmando que o binding devolve o mesmo que o golden:

```rust
#[test]
fn napi_reexpoe_as_regras_puras_do_chupim() {
    assert_eq!(dead_key("abc"), "autofetch:dead:abc");
    assert!(overflow_upgrade_allowed(&fatos_no_limite()));
}
```

- [ ] **Step 3: implementar a fiação**

Exportar no napi: `dead_key`, `overflow_upgrade_allowed`, `expired_removal_allowed`
(**não existe binding hoje**), `derive_stall`, `classify_enqueue`, `rollback_for`,
`to_queue_candidate`, `compose_queue_entries`, `pick_seeds_pool`, `set_trace_chupim`.
Em `src/utils/rust-autofetch.ts`, trocar as importações pelo núcleo — **sem**
knob de env: o núcleo é obrigatório.

- [ ] **Step 4: apagar o TS e ajustar `testFiles`**

Apagar os 8 arquivos e os testes dedicados; remover as entradas de
`package.json` → `testFiles`. Se um teste cobre orquestração (não a regra),
ele permanece até a fatia do worker.

- [ ] **Step 5: gate + commit**

```powershell
npm run typecheck
npm run build
npm test
npm run test:complete
npm run lint:lines -- --check
cd rust
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
git add src rust/crates/adom-napi test package.json
git commit -m "refactor(autofetch): fia regras puras no nucleo e apaga o TS morto"
```

> **Nota de execução (2026-10-24).** O Step 1 provou que os 8 módulos
> `autofetch-*.ts` **não estão mortos**: `autofetch-candidates.ts`, `drain.ts`,
> `recheck.ts`, `terminal.ts`, `settle.ts`, `obra.ts`, `runner.ts` e
> `autofetch.ts` os chamam, e `autofetch-picks` é usado por
> `src/utils/stream-ranking.ts:27-28`. A fatia entregou só a ponte napi
> (`rules.rs`, 12 bindings, commit `c5d83cb5`); a deleção acompanha a migração
> do worker em **T3-L4/L5/L6**.

---

## Leva 2

### T1-A2: preempção intradrain

**Files:**
- Modify: `rust/crates/adom-server/src/harvest/mod.rs:76-102`
- Modify: `rust/crates/adom-server/src/harvest/serve.rs:111-149`
- Modify: `rust/crates/adom-server/src/harvest/enqueue.rs:39-45`
- Test: `rust/crates/adom-server/src/harvest/loop_tests.rs` (356 linhas)

- [ ] **Step 1: escrever o teste que falha**

```rust
#[test]
fn preempcao_interrompe_o_drain_e_devolve_a_entrada_a_cabeca() {
    let inner = spawn_com_barreira();
    // enfileira obra de rank maior durante o drain
    enqueue_urgente(&inner, "tt999");
    inner.preempt.notify_one();
    let fila = inner.queue.lock().snapshot();
    assert_eq!(fila.head().unwrap().imdb_id, "tt999");
    assert!(fila.head().unwrap().resumed);
}
```

- [ ] **Step 2: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-server --locked preempcao_interrompe_o_drain
```
Expected: FAIL.

- [ ] **Step 3: implementar**

`Inner` ganha `preempt: tokio::sync::Notify`. `serve.rs:124` vira
`tokio::select!` entre `drain.drain_one(&entry, queries_left)` e
`inner.preempt.notified()`. Ao preemptar: (a) dropar o future, (b) reconstruir a
entrada com `queue.inflight().pending(&identity)` + a original, devolver com
`queue.head()` e `resumed: true`, (c) `probe.note_preempted` para renovar o
lease, (d) `worker.finish` com as consultas já gastas (do T1-A1), (e) **não**
rodar settle de falha. O `notify_one` dispara em `enqueue_with_dedupe` quando o
rank da nova entrada é maior que o do slot em voo.

- [ ] **Step 4: gate + commit**

```powershell
cd rust
cargo fmt --all
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
node scripts/check-rust-lines.mjs
git add rust/crates/adom-server/src/harvest
git commit -m "feat(harvest): preempcao intradrain devolve a entrada a cabeca"
```

> **Nota de execução (2026-10-24).** Entregue em `c68973d9`. O rank da obra em
> voo é lido **sob o lock da fila** (`Inner::set_inflight_rank`), senão o
> enqueue veria slot aberto sem rank e a urgência nunca preemptava. No
> drop do future só as consultas **já gastas** são debitadas
> (`DrainFound::take_spent`); o `Settler::note_preempted` renova o lease e a
> entrada volta à cabeça com `resumed: true` — nada de desfecho de falha.
> Dois riscos declarados: (a) um `notify_one` remanescente pode preemptar o
> ciclo seguinte numa corrida estreita (inofensivo — a entrada volta à fila);
> (b) o rank efetivo depois do coalescing é conservador: pode **deixar de**
> preemptar, nunca preemptar a mais.

### T2-L2: `NativeKv` e ponte de leitura napi

**Files:**
- Create: `rust/crates/adom-store/src/kv.rs`
- Create: `rust/crates/adom-store/src/kv_tests.rs`
- Modify: `rust/crates/adom-store/src/lib.rs`
- Modify: `rust/crates/adom-napi/src/lib.rs` (+ módulo `kv`)
- Create: `src/utils/native-kv.ts` (leitura pela ponte)
- Test: `test/native-kv.test.ts` (novo, adicionar em `testFiles`)

- [ ] **Step 1: escrever o teste Rust que falha**

```rust
#[test]
fn ttl_zero_persiste_e_expirado_some_na_leitura() {
    let kv = NativeKv::open_memory().unwrap();
    kv.put_json("autofetch:q", &json!([1]), 0, 1_000).unwrap();
    assert!(kv.get_json("autofetch:q", 10_000_000).unwrap().is_some());
    kv.put_json("autofetch:x", &json!(1), 1, 1_000).unwrap();
    assert!(kv.get_json("autofetch:x", 2_000).unwrap().is_none());
}
```

- [ ] **Step 2: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-store --locked ttl_zero_persiste
```
Expected: FAIL.

- [ ] **Step 3: implementar**

`kv.rs` conforme §3.2, sobre `CREATE TABLE IF NOT EXISTS cache (key, value,
expires_at)` (o mesmo schema de `adom-harvest/src/store.rs:28-37`).
`keys_matching(prefix)` faz `substr(key, 1, length(?1)) = ?1` **e** apaga as
linhas expiradas que encontrar. Binding napi: `nativeKvGetJson(key)` e
`nativeKvKeys(prefix)`.

- [ ] **Step 4: ponte no Node**

`src/utils/native-kv.ts` exporta `kvPeek(key)` e `kvKeys(prefix)`; qualquer
leitura de namespace Rust-owned passa por aqui (`cache.peek` devolve `null`
para chave estrangeira — é o mesmo desenho de `raw-store-native.ts`).

- [ ] **Step 5: gate + commit**

```powershell
cd rust
cargo fmt --all
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
npm run typecheck
npm run build
npm test
git add rust/crates/adom-store rust/crates/adom-napi src/utils test package.json
git commit -m "feat(store): kv nativo no cache.db e ponte de leitura napi"
```

> **Nota de execução (2026-10-24).** Entregue em `30158eda`, com uma correção
> de fronteira: o `NativeKv` **não pôde** morar no `adom-store`. O
> `adom-napi` não depende dele (e passar a depender puxaria `adom-search` e
> `reqwest` para dentro do `.node`). O KV foi para o **`adom-index`** (crate
> leve de SQLite que o napi já usa) e o `adom-store` só o reexporta
> (`pub use adom_index::{kv, NativeKv}`), então a fatia do Chupim continua
> importando de onde o plano dizia.
>
> O binding napi é uma **classe** (`new NativeKv(dbPath)` + `getJson`/`keys`/
> `setJson`), não funções soltas, para o Node não reabrir o `cache.db` a cada
> chamada. Caminho do banco: `config.cache.persist ? dbPath : ':memory:'`.
> `test/native-kv.test.ts` cobre leitura, miss, prefixo e TTL vencido; a regra
> em si fica em `cargo test -p adom-index kv::`.

### T3-L2: identificação TMDB nativa (fase 6.1)

**Files:**
- Modify: `rust/crates/adom-sources/src/tmdb/` (novo `search.rs`)
- Modify: `rust/crates/adom-crawl/src/` (identificação na página)
- Delete: `src/providers/crawl-identify.ts`
- Delete: `src/utils/tmdb-search.ts`
- Modify: `src/utils/tmdb.ts:328` (reexport)
- Delete: `test/crawl-identify.test.ts` (e entradas em `testFiles`)
- Test: `rust/crates/adom-sources/src/tmdb/search_tests.rs` (novo)

- [ ] **Step 1: escrever o teste que falha (Rust)**

```rust
#[tokio::test]
async fn identify_por_titulo_e_ano_devolve_imdb_ou_veredito() {
    let stub = StubTmdb::movie("Interestelar", 2014, "tt0816692");
    assert_eq!(search_by_title(&stub, "Interestelar", Some(2014)).await.unwrap(), Some("tt0816692".into()));
    assert_eq!(search_by_title(&stub, "Interestelar", Some(1990)).await.unwrap(), None);
}
```

- [ ] **Step 2: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-sources --locked identify_por_titulo
```
Expected: FAIL.

- [ ] **Step 3: implementar o porte**

Portar `searchByTitle` (`src/utils/tmdb-search.ts:174`) e `externalImdbId`
(`:243`) com os três veredictos do TS (`identified` / `unidentified` /
`ambiguous` / `unavailable`) exatamente como
`src/providers/crawl-identify.ts:163-210`. `unavailable` continua **retentável**
(500 ao sidecar), `unidentified`/`ambiguous` continuam terminais.

- [ ] **Step 4: apagar o TS e ajustar `testFiles`**

- [ ] **Step 5: gate + commit**

```powershell
npm run typecheck
npm run build
npm test
npm run test:complete
cd rust
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
git add src rust test package.json
git commit -m "refactor(crawl): identificacao tmdb nativa e fim do TMDB search do Node"
```

> **Nota de execução (2026-10-24).** O **porte Rust** foi entregue em
> `c6b55f97` (`search.rs`, `identify.rs`, `search_cache.rs`, stub e 25 testes),
> mas os Steps 4 e 5 **não fecharam** e a fatia foi partida:
>
> - **A fiação no `adom-crawl` não pode entrar agora**: o crate não depende de
>   `adom-sources`, e a identificação só é usada no caminho de gravação, que
>   hoje termina em `POST /internal/crawl-result` (Node). Fiar antes seria
>   código morto no sidecar.
> - **`src/providers/crawl-identify.ts` continua vivo**: quem o consome é
>   `src/routes/internal-crawl-result.ts` (+ `test/internal-crawl-result-identify`
>   e `test/crawl-identify`). Apagá-lo agora derrubaria a ingestão.
> - Logo, `test/crawl-identify.test.ts` **permanece** em `testFiles` (a
>   remoção foi revertida). O que sai de verdade — TMDB search do Node,
>   crawl-identify e a rota `internal-crawl-result` — vai junto da **T3-L3**,
>   quando a ingestão for nativa.
>
> Os reexports de `tmdb/mod.rs` estão sob `#[allow(unused_imports)]` de
> propósito: `tmdb` ainda é módulo privado em `adom-sources/src/lib.rs`; sem o
> `pub use` externo o rustc os vê como não usados. A T3-L3 remove a anotação ao
> fiar de fato.

---

## Leva 3

### T1-A3: integridade e quarentena do SQLite

**Files:**
- Create: `rust/crates/adom-store/src/integrity.rs`
- Create: `rust/crates/adom-harvest/src/integrity_tests.rs`
- Modify: `rust/crates/adom-store/src/streams.rs:59-73` (open)
- Modify: `rust/crates/adom-harvest/src/store.rs:50-63` (open) e `:194-204` (`read_row`)
- Modify: `rust/crates/adom-server/src/harvest/status.rs` e `routes.rs:64-80`
- Test: `rust/crates/adom-store/src/streams_tests.rs` (330 linhas — cabe)

- [ ] **Step 1: escrever os testes que falham**

```rust
#[test]
fn open_com_arquivo_corrompido_quarentena_e_recria() {
    let path = temp_corrompido(); // bytes "not a database"
    let store = StreamsStore::open(&path).expect("recria após quarentena");
    assert!(path.with_extension("corrupt").exists());
    assert!(store.get("streams:v21:movie:tt1:scope", 1).unwrap().is_none());
}

#[test]
fn status_do_harvest_mostra_store_degradado() {
    let store = HarvestStore::open(&temp_corrompido()).unwrap();
    assert!(store.degraded());
    let status = harvest_status(&store, 1_000);
    assert!(status.degraded);
    assert!(status.store_error.is_some());
}
```

- [ ] **Step 2: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-store --locked open_com_arquivo_corrompido
```
Expected: FAIL.

- [ ] **Step 3: implementar**

`integrity::open_quarantined(path)`: abre, roda `PRAGMA quick_check`; se !=
`ok`, renomeia para `<arquivo>.corrupt-<epoch>`, recria o schema, devolve
`(conn, degraded: bool)`. `StreamsStore::open` e `HarvestStore::open` passam a
usar. `read_row` distingue `QueryReturnedNoRows` (miss) de erro real
(propaga). `HarvestStore::load` com JSON inválido copia o valor para
`harvest:v1:q:corrupt` antes de devolver vazio. `status.rs`/`routes.rs` expõem
`degraded` e `storeError`.

- [ ] **Step 4: gate + commit**

```powershell
cd rust
cargo fmt --all
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
node scripts/check-rust-lines.mjs
git add rust/crates/adom-store rust/crates/adom-harvest rust/crates/adom-server/src/harvest
git commit -m "feat(store): quick_check, quarentena e status degradado"
```

> **Nota de execução (2026-10-24).** Entregue em `8bf3d1cb`. Dois desvios
> deliberados da spec:
>
> - **`MagnetDbStore` não quarentena.** Ele é read-only sobre o `cache.db`
>   escrito pelo Node: renomear deixaria o Node gravando num inode órfão e
>   criaria um `cache.db` novo e vazio. O `open_read_only_checked` só marca
>   `degraded`, loga e responde o motivo; a recuperação fica com quem abre
>   gravável.
> - **O helper é parametrizado pelo schema** (`open_quarantined(path, schema)`),
>   porque dois esquemas diferentes (`streams.db` e o `cache` do colhedor)
>   compartilham a quarentena. O `adom-harvest` não depende de `adom-store`,
>   então mantém um espelho documentado no próprio crate.
>
> Riscos residuais: (a) `HarvestStore::open` quarentena o `cache.db`
> compartilhado — só é seguro com o gateway subindo antes do Node; no Windows,
> se o Node estiver segurando o arquivo, o rename falha e o `open` devolve erro
> em vez de degradar; (b) `StreamsStore::degraded()` ainda não tem consumidor no
> gateway (só teste/log); (c) `GET /harvest` sem worker reporta
> `degraded:false`, então a causa de um `spawn` que devolveu `None` se perde
> nesse ramo.

### T2-L3: fase 3 residual — apagar os corpos TS inalcançáveis

**Files:**
- Modify: `src/debrid/rust-remote.ts:296-348`
- Delete: `src/debrid/premiumize.ts` → corpo `checkCached` (`:61`)
- Delete: `src/debrid/torbox.ts` → corpo `checkCached` (`:57`)
- Delete: `src/debrid/alldebrid-check.ts` → corpo `checkCached` (`:49`)
- Modify: `src/debrid/registry.ts:28-68`
- Modify: `src/debrid/index.ts`
- Test: `test/debrid-rust-remote.test.ts`

- [ ] **Step 1: provar quem ainda chama o corpo TS**

```powershell
rg -n "adapter\.checkCached|adapter\.resolveLink|adapter\.accountStatus|\.resolveLink\(" src
```
Expected: `cache-check.ts:353` (`checkCached`, atrás do wrapper),
`rust-remote.ts:307` (fallback 501), `actions.ts:8` (`resolveLink`). Se
`actions.resolveLink` tiver chamador de produção que **não** seja o play
nativo, **pare** e registre: significa que o Rust não cobre aquele caminho.

- [ ] **Step 2: escrever o teste que falha**

```ts
test('serviço coberto pelo Rust não devolve mais 501 em check/account', async () => {
  for (const id of ['premiumize', 'torbox', 'alldebrid', 'realdebrid']) {
    const res = await fetch('http://127.0.0.1:8710/debrid/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-adom-token': TOKEN },
      body: JSON.stringify({ service: id, hashes: ['0123456789abcdef0123456789abcdef01234567'] }),
    });
    assert.notEqual(res.status, 501, `${id} ainda 501`);
  }
});
```

Marque como `test.skip` quando a porta 8710 não estiver disponível localmente e
registre a limitação no topo do arquivo; o gate real é o teste de unidade do
despacho Rust (`api_dispatch.rs`).

- [ ] **Step 3: apagar os corpos e o fallback**

- Em `rust-remote.ts`, `checkCached`: `remote.status === 501` passa a ser
  `unchecked()` (contrato incompleto honesto), **não** segunda pergunta.
- `accountStatus`: 501 e falha de rede devolvem erro honesto para os 4
  serviços; o Debrid-Link mantém o corpo TS (não tem `accountStatus` nativo).
- Apagar os corpos `checkCached` de premiumize/torbox/alldebrid e o dinâmico do
  realdebrid; apagar `resolveLink` dos 5 adaptadores **somente** se o passo 1
  provou ausência de chamador fora do play nativo.
- `/debrid/files`: manter só a rota nativa (Premiumize); nenhum consumidor TS.

- [ ] **Step 4: gate + commit**

```powershell
npm run typecheck
npm run build
npm test
npm run test:complete
git add src/debrid test package.json
git commit -m "refactor(debrid): apaga corpos TS inalcancaveis atras do 501"
```

> **Nota de execução (2026-10-24).** Antecipada para a leva 2 e entregue em
> `99cd5477`. O desenho mudou: **501 deixou de ser "ainda não portado"** e
> virou "sem veredito nativo" — a checagem devolve `known:false` e a conta
> sobe `RustWriteError`; não existe segunda pergunta ao TS em nenhum dos dois.
> Junto veio a proteção que a mudança exigia: `GET /debrid-status.json`
> responde 200 com `reason:'debrid-bridge'` (antes, 500 `internal_error`) e o
> bloco `general` do painel faz `catch` no `accountStatus`, senão a ponte fora
> do ar derrubaria o painel (teste novo em `test/app-routes-admin.test.ts`).
>
> **Itens 3 e 4 continuam abertos, de propósito.** Os corpos de
> `checkCached`/`resolveLink` têm chamador vivo fora do `/stream`:
> `src/providers/live-check.ts:94` chama `checkCached` cru e
> `src/providers/dub-audit.ts:153` chega em `resolveLink` por `actions.ts:11`.
> Apagá-los agora quebraria o `dub-audit`; a remoção real vai com a **T3-L7**,
> quando o `dub-audit` for nativo. O passo 1 do plano continua sendo o portão
> (provar ausência de chamador) antes de qualquer `DeleteFile`.

### T3-L3: recorder e ingestão nativos (fase 6.2)

**Files:**
- Create: `rust/crates/adom-crawl/src/ingest/mod.rs` (+ `record.rs`, `locate.rs`, `tests.rs`)
- Modify: `rust/crates/adom-crawl/src/sidecar/server.rs` (+ rotas `requeue-simulated`, `reprocess-no-work`, `cursor`)
- Modify: `rust/crates/adom-crawl/src/motor/loop.rs:100-116`
- Delete: `src/routes/internal-crawl-result.ts`
- Delete: `src/providers/crawl-recorder.ts`
- Delete: `src/providers/magnet-bank-hook.ts`
- Delete: `src/utils/crawl-store.ts`, `crawl-store-rules.ts`, `crawl-store-memory.ts`, `crawl-store-migrate.ts`
- Delete: `src/providers/crawl-recovery.ts`, `crawl-actions.ts`, `crawl-cursor.ts`, `crawl-cursor-load.ts`
- Modify: `src/providers/crawler.ts`, `src/routes/dashboard-actions-crawl.ts`, `src/addon.ts:113`
- Modify: `package.json` (`testFiles`)
- Test: `rust/crates/adom-crawl/src/ingest/tests.rs` (novo)

- [ ] **Step 1: escrever o teste que falha (Rust)**

Três casos, com `IngestHarness` (helper do módulo: store em memória + TMDB
stub + coleta de invalidações) e a página de fixture de cada site:

```rust
#[tokio::test]
async fn grupo_de_serie_grava_uma_vez_por_locacao() {
    let ingest = IngestHarness::new().with_tmdb(StubTmdb::series(202, "tt555"));
    let out = ingest.apply("nerdfilmes", &season_page_groups(&pagina_de_serie()), 1_000).await.unwrap();
    assert_eq!(out.releases, 2, "S01E01 e S01E02");
    assert_eq!(out.index_rows, 2);
    assert_eq!(ingest.invalidations(), vec!["tt555".to_string()], "uma por obra");
}

#[tokio::test]
async fn pagina_sem_imdb_identifica_e_marca_no_work_quando_ambiguo() {
    let ingest = IngestHarness::new().with_tmdb(StubTmdb::ambiguous("Duna"));
    let out = ingest.apply("bludv", &[pagina_sem_imdb()], 1_000).await.unwrap();
    assert_eq!(out.works, 0);
    assert_eq!(out.mark, Some(MarkResult::Ambiguous));
    assert!(!out.retryable, "ambíguo é terminal");
}

#[tokio::test]
async fn gravacao_do_indice_invalida_a_obra_uma_unica_vez() {
    let ingest = IngestHarness::new().with_tmdb(StubTmdb::movie("tt777"));
    ingest.apply("hdr", &[pagina_de_filme()], 1_000).await.unwrap();
    ingest.apply("hdr", &[pagina_de_filme()], 2_000).await.unwrap();
    assert_eq!(ingest.invalidations(), vec!["tt777".to_string()]);
}
```

- [ ] **Step 2: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-crawl --locked grupo_de_serie_grava
```
Expected: FAIL.

- [ ] **Step 3: implementar o recorder**

Portar `createCrawlRecorder().record` (`src/providers/crawl-recorder.ts:159-211`)
com as três escritas na ordem do TS: banco vivo (`capture_items` do T2-L1) →
índice (`release_index_record.rs:21`) → transição BR (`adom_core::br_gap`) e
invalidação (`streams.rs:186`). Preservar: `partial`/`keepPartial`, contexto só
do catálogo (sem nomes → erro retentável), `shouldAbort` antes de cada escrita
(a cerca do passo) e `flushBarrier` (fila cheia → `queueDropped`).

- [ ] **Step 4: ligar o motor e mover as 3 escritas do Node**

`motor/loop.rs` passa a gravar direto (sem HTTP) e a marcar o resultado no
`crawl.db` com `MarkResult::from_work`. As rotas do painel (`requeueSimulated`,
`reprocessNoWork`, cursor legado) viram `POST /crawl/...` no sidecar;
`crawler.ts` deixa de abrir `crawl.db`.

- [ ] **Step 5: apagar o TS, ajustar `testFiles` e o `package.json`**

2.136 linhas medidas nesta fatia (§6).

- [ ] **Step 6: gate + commit**

```powershell
npm run typecheck
npm run build
npm test
npm run test:complete
npm run lint:lines -- --check
cd rust
cargo fmt --all
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
git add src rust test package.json
git commit -m "refactor(crawl): ingestao e recorder nativos e fim do crawl-result Node"
```

> **Nota de execução (2026-10-24).** Entregue pela metade, em dois commits, e a
> **fiação ainda não aconteceu**:
>
> - `d0cdcf12` — `adom-crawl/src/ingest/` (7 arquivos, 13 testes): porte de
>   `record` com a ordem do TS (`shouldAbort` → catálogo → filtro → captura →
>   `flushBarrier` → índice → `br_transition` → invalidação) e uma costura
>   `ObraCatalog` para o TMDB. `NativeStore::flush()` devolve `true` porque
>   `capture_items` já commita; a barreira existe pela costura.
> - `6946dfd7` — rotas administrativas no sidecar: `POST
>   /crawl/requeue-simulated`, `POST /crawl/reprocess-no-work`, `GET|POST
>   /crawl/cursor`. `site` é obrigatório (o TS caía no primeiro site
>   configurado; o sidecar recusa em vez de chutar). O cursor grava no
>   `crawl_state`, mas o motor ainda não o consome.
> - `46c05767` — `adom-sources` passa a reexportar busca/identify/TmdbSearchApi
>   em `lib.rs`; era o que faltava para o `adom-crawl` poder fiar o TMDB (o
>   `#[allow(unused_imports)]` do `tmdb/mod.rs` saiu junto).
>
> **EXECUTADA em `54209dc8`** (`feat(crawl): sidecar identifica e grava a pagina
> nativamente`). O que foi feito:
>
> - **Fiação:** `PageIngest` (`motor/ingest.rs`) é o contrato; `BatchCtx.ingest`
>   substituiu o `http` que fazia POST; `motor/deliver.rs` entrega a página com
>   `should_abort` no MESMO `Instant` do prazo da engine (`timeout_at`); e
>   `sidecar/wiring::production_ingest()` monta TMDB + `NativeStore::from_env()`
>   + invalidador de streams. Sem ingestão montada o tick devolve
>   `Skipped("ingest-pendente")` e **não reivindica URL** (cada `mark_result`
>   consome `tries` — reivindicar sem gravar queimava a fila).
> - **Node:** as três chamadas passaram a falar com o sidecar
>   (`postToSidecar` + `POST /crawl/reprocess-no-work`, `requeueSimulatedInSidecar`,
>   `readCursorFromSidecar`). O Node não escreve mais no `crawl.db`; a vista do
>   card (`cursorsView`) usa memória → ponte → leitura local do `crawl_state`.
> - **Apagados (10):** `internal-crawl-result.ts`, `crawl-recorder.ts`,
>   `magnet-bank-hook.ts`, `crawl-identify.ts`, `crawl-recovery.ts` e os 5 testes
>   deles (com as entradas de `testFiles`).
> - **Não saíram, com motivo:** `crawl-store*`, `crawl-cursor*`, `crawl-status.ts`
>   e `crawl-actions.ts`. O `crawl-status.ts` monta o painel com
>   `engine.listByStatus` (done/no-work/partial/error), `errorGroups`,
>   `latestRun` e `sumReleases`; o `GET /status` do sidecar devolve só
>   contadores (`SiteStatus` em `motor/types.rs`). Apagar antes de existir a rota
>   detalhada deixaria o painel sem lista de páginas e sem grupos de erro.
>
> **LACUNA BLOQUEANTE descoberta na auditoria (regressão de produção, não
> dívida estética):** os parsers de descoberta (`sitemap/`, listagem paginada)
> estão portados e testados, mas **nenhum código de produção os consome** —
> `rg "parse_sitemap|SitemapEntry"` fora de `sitemap/` dá zero, `rg -ni discover`
> só acha `mico_discovery`/`mico_lane`, e o `upsertUrls` do `crawl_store` não tem
> chamador. Os 8 sites do Jackett (Vaca, Nerd, TDF, Comando, Rede, BLUDV, HDR,
> Apache) não enfileiram URL nova desde `628392be`/`75d3d2b5`; só o Mico descobre.
> O cursor (`cursor:movie`/`cursor:tv_show`) só é lido/escrito pela admin do
> sidecar, nunca pela descoberta. **A ingestão nativa grava bem o que chega à
> fila — o que falta é alimentar a fila.** Próxima fatia da fase 6, antes de
> qualquer limpeza adicional do TS: fiar `discover` (sitemap/listing →
> `upsertUrls`) e o consumo do cursor no motor.
>
> **EXECUTADA (trilha de SITEMAP) em `93eeb96d`** (`feat(crawl): descoberta de
> sitemap no motor (fase 6)`). O que foi feito:
>
> - **`discovery/`** (`types`, `rules`, `config`, `fetch`, `service`, `mod`):
>   tabela dos SEIS sites de sitemap (Vaca, Nerd, TDF, Comando, Rede, BLUDV),
>   `KindModel::PerKind` (arquivos `movie-`/`tv_show-` e `movies-`/`tvshows-`) ×
>   `Mixed { tv_hidden_off }` (`post-sitemap*` do BLUDV esconde séries),
>   `EntryShape::Xml`/`XmlOrViewer`, corte incremental por `lastmod` com
>   `parse_iso_ms` sem `chrono` (`days_from_civil` do `br_core`), cursor por KIND
>   (`cursor:movie`/`cursor:tv_show`, legado `cursor` migrado para movie) e
>   `enqueue_discovered` (= `decideUpsert`), **nunca** `upsert_urls`.
> - **`motor/discovery_tick.rs`**: um site por tick, rodízio justo, relógio por
>   site (parcial volta no retry curto, completa no
>   `CRAWL_DISCOVERY_INTERVAL_MS`), custo da rodada no MESMO teto por hora das
>   páginas (`budget.rs`); a descoberta roda **antes** do claim (era o
>   `sem-fila` eterno de um site recém-ligado).
> - **`page_engine::fetch_crawl_text`**: direto primeiro e FlareSolverr só com
>   desafio do Cloudflare (mesmo perfil do `fetchTextCrawl` do TS).
> - **Regra dura preservada:** `urls: []` + `complete: true` nunca sai por
>   engano — corpo ilegível, zero entradas de obra e kind trocado são FALHA.
>   Lista vazia **depois** do corte incremental é completa legítima.
> - **Testes:** `discovery_tests.rs`, `discovery_service_tests.rs` e
>   `motor/discovery_tick_tests.rs` (49 testes; a lib `adom-crawl` foi de 491
>   para **540**). Dois bugs reais apareceram aqui e foram corrigidos: a fração
>   de segundos do `Date.parse` era ignorada, e `discover_once` fora do tick não
>   abria o `crawl.db`.
>
> **Lacuna remanescente da fase 6 (não é a mesma coisa):** a trilha de
> **LISTAGEM paginada** (HDR e Apache; cursor `lc1`, fim por contagem) continua
> sem consumidor no motor. Esses dois sites só voltam a descobrir quando essa
> trilha for fiada; até lá o motor deles trabalha apenas a fila existente. Nada
> de TS a apagar nessa fatia (o motor de crawl TS já saiu em T3-L3).
>
> **EXECUTADA (subtarefa A da listagem) no commit desta fatia** — núcleo puro,
> ainda sem fiação:
>
> - **`listing/base64url.rs`**: o crate não tem base64 e o token `lc1` precisa
>   dele; encode/decode sem padding no alfabeto url-safe, sem dependência nova.
> - **`listing/cursor.rs`** (porte de `crawl-cursor.ts`): `ListingCursor`
>   (`page`/`seen`/`anchor`/`round_page`/`sweep`/`head`/`rounds`), chave
>   `listing:<kind>:<caminho>`, token `lc1.<base64url>` com leitura estrita
>   (fora de forma = `None`, nunca adoção de lixo) e tolerância ao token
>   anterior aos contadores.
> - **`listing/read.rs`** (porte de `crawl-listing-read.ts`): `read_listing_page`
>   com a MESMA ordem do TS — round esgotado reinicia antes de consumir,
>   `max_pages` não consome, teto do round fecha sem cobertura (exceto
>   incremental sem âncora), âncora/fim declarado voltam para a página 1 com
>   `anchor = head`.
> - **`listing/walk.rs`** (porte de `listing-discover.ts`): o laço que anda a
>   listagem sobre um `ListingPageReader` injetado (o núcleo não conhece HTML),
>   com as duas travas de fim (CONTAGEM de cards brutos e página cheia
>   repetida), o portão de séries (`tv_show` gasta o request e não entra na
>   fila) e `complete && failures.is_empty()`.
> - **`ListingPageRead`** ganhou `enqueued` e `end_of_listing` — eram campos do
>   TS que faltavam para o orçamento e o fim por contagem chegarem ao cursor.
> - **Testes:** 34 novos (`base64url` 3, `tests_cursor` 9, `tests_read` 10,
>   `tests_walk` 12); a lib `adom-crawl` foi de 540 para **574** e o filtro
>   `listing` roda 44.
>
> **EXECUTADA (subtarefa B da listagem) no commit desta fatia** — a fila de
> HDR e Apache volta a encher:
>
> - **`discovery/types.rs`**: `DiscoveryReport.state_writes: Vec<(String,
>   String)>` (estado durável que a rodada quer gravar, EM ORDEM) e
>   `DiscoveryOptions` com `site_state` (lido pelo motor a partir de
>   `state_keys`), `listing_round_max_pages` e `now`; `state(key)` trata valor
>   vazio como ausente.
> - **`discovery/listing/`** (`config`, `series`, `reader`, `mod`): tabela
>   fechada dos dois sites (`/pagina/`, 20 cards por página cheia), portão de
>   séries `1:r2`/`0:r2` com chave irmã `listing:movie:/pagina/:series`
>   (inverter o portão apaga o cursor e recomeça da página 1), `SiteListingReader`
>   (único ponto que conhece HTML; failover de host memoizado; `hdr_*`/`apache_*`)
>   e `ListingDiscovery` (lê o estado, chama `walk_listing` e devolve o relatório
>   com o marcador ANTES do cursor em `state_writes`).
>   `complete_tv_show = emit_series && complete`: com séries desligadas as URLs
>   foram lidas e descartadas, e `true` afirmaria cobertura que não existe.
> - **`discovery/mod.rs`**: `SiteDiscovery::state_keys` (default vazio),
>   `RoutedDiscovery` (listagem × sitemap por `listing_config`) e
>   `discoverable_sites()` como UNIÃO das duas trilhas (8 sites);
>   `sitemap_sites()` continua sendo só os seis de sitemap.
> - **Motor** (`motor/discovery_tick.rs`): lê `state_keys` para
>   `opts.site_state` e grava `state_writes` **só depois** de
>   `enqueue_discovered` aceitar (`accepted`); falha de fila imprime que o estado
>   NÃO foi gravado e a rodada é refeita — cursor que anda antes do `enqueue`
>   avança por cima de descoberta que nunca entrou na fila.
>   `MotorConfig::listing_max_pages_per_round` é a porta de
>   `CRAWL_LISTING_MAX_PAGES_PER_ROUND` (default 20, `.max(1)` no sidecar).
>   **Decisão:** o motor NÃO encurta o agendamento de rodada incompleta
>   (`round-cap`); o retry curto faria a carga inicial consumir o teto de 1.500
>   req/h e morrer de fome as páginas. A cobertura inicial do Apache (2.123
>   páginas) sai a 20 páginas por intervalo — subir o knob quando a carga
>   importar.
> - **Testes:** 12 novos em `discovery/listing/tests_listing.rs` (tabela, união,
>   URL da página, 4 do portão, e2e com o HTML real de HDR e Apache, página sem
>   card = falha nunca vazio completo, reinício da página 1 com o cursor
>   apagado, failover de host) + 1 no motor
>   (`estado_duravel_da_trilha_e_lido_antes_e_gravado_depois`). O harness do
>   motor saiu para `motor/discovery_tick_test_support.rs` e os casos dividiram-se
>   em `discovery_tick_tests.rs` (relógio/rodízio) e
>   `discovery_tick_state_tests.rs` (custo, cursores, estado durável e costura)
>   para caber na catraca de 400 linhas. O filtro `listing` roda 56.

---

## Leva 4

### T1-B1: slot em voo durável (`adom-harvest`) — EXECUTADA

Hoje o slot em voo só existe em memória (`worker.rs`), então um restart no meio
do drain **perde** a entrada: ela sai da fila no `plan` e nunca volta. Esta fatia
faz o `claim` ser uma escrita.

**Causa raiz medida** (o plano supunha o `plan`): `take_head` tira a entrada da
memória e o drain roda sem o lock; o `enqueue` do Node (`harvest/handle.rs`)
persiste a fila durante o drain — sem a obra em voo — e um restart depois disso
a perde para sempre. Não era o `plan`, era a ESCRITA do enqueue.

**Desenho executado** (differe do plano em três pontos, todos deliberados):

- O arquivo é `lease.rs`, não `inflight.rs` — o nome já é do coalescing volátil
  da intenção (`HarvestInflight`), que é outra coisa.
- O slot NÃO virou dono do L2: continua a `HarvestQueue` (dono único na memória)
  e o `DurableSlot` é campo dela. O documento ganhou `{entries, inflight,
  attempts, terminal}` e TODO `save` leva o claim junto — inclusive o do
  `enqueue`. Um `HarvestStore::claim` separado voltaria a ter dois escritores.
- O claim é escrito no `begin` (`serve.rs`, logo depois de `worker.begin`), não
  no `plan`: é o único ponto que roda com o lock da fila e já conhece o `now`.

**Arquivos:**
- Create: `rust/crates/adom-harvest/src/lease.rs` (`Lease`, `InflightEntry`,
  `TerminalEntry`, `DurableSlot` + `impl HarvestQueue`) e `lease_tests.rs`
- Create: `rust/crates/adom-harvest/src/store_document.rs` (formato do valor:
  `StoredQueue`, `load_queue`/`save_queue`, migração do array legado) — o
  `store.rs` passou do teto com o documento embutido
- Create: `rust/crates/adom-server/src/harvest/durable_tests.rs`
- Modify: `queue.rs` (`slot`, `save_to`/`load_from` delegando, `clear` reseta),
  `worker.rs` (`open_slot`/`close_slot`), `store.rs`,
  `adom-server/src/harvest/{serve.rs,mod.rs}`, `lib.rs`

**Regras**
- Um slot só (o tick é serial). O TTL do lease (60 s) é diagnóstico.
- Boot/restart → o dono anterior morreu → a obra volta pelo FIM da fila na hora
  (`load_from` → `apply_stored` → `reclaim_dead_lease`); o boot regrava a fila
  para a mesma morte não contar duas vezes.
- `MAX_CLAIM_ATTEMPTS` (3) mortes de claim → `terminal` com
  `reason: "lease_expired"` (TTL 7 dias, prunado na leitura). Falha de drain NÃO
  passa por aqui — quem conta tentativa de colheita é o `Settler`.
- `clear` do painel zera também o slot (não devolve, não vira terminal).
- Migração: o documento novo é lido; o array cru continua aceito e é regravado
  no formato novo. `load`/`save` antigos ficaram `#[cfg(test)]`.

**Provas**
- 9 testes no crate: restart devolve o slot (`attempts = 1`), o save do enqueue
  não perde a obra em voo, a chave não some com fila vazia + slot vivo, finish
  idempotente, 3 mortes → terminal, terminal expira, claim órfão volta antes do
  próximo, `clear`, formato legado.
- `durable_tests.rs` no gateway: barreira no drain + `persist_queue` no meio →
  `load_queue().inflight` é a obra em voo; ao soltar, o `finish` fecha o slot.

**Gate**: `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets
--locked -- -D warnings`, `cargo test --workspace --locked` (EXIT 0),
`node scripts/check-rust-lines.mjs` (939 fontes, baseline 0) e
`git diff --check` — todos verdes.

<details>
<summary>Plano original (histórico) — desenho com `HarvestStore::claim`</summary>

**Files:**
- Create: `rust/crates/adom-harvest/src/inflight.rs`
- Create: `rust/crates/adom-harvest/src/inflight_tests.rs`
- Modify: `rust/crates/adom-harvest/src/store.rs` (struct do valor de
  `harvest:v1:q`; `load`/`save` no formato novo com migração do antigo)
- Modify: `rust/crates/adom-harvest/src/worker.rs:115-170` (claim/finish)
- Modify: `rust/crates/adom-server/src/harvest/drain.rs:300-340` (impl do trait)
- Modify: `rust/crates/adom-harvest/src/lib.rs` (reexport de `InflightEntry`)

- [ ] **Step 1: escrever o teste que falha**

Em `inflight_tests.rs`:

```rust
use crate::inflight::{InflightEntry, Lease};
use crate::store::HarvestStore;
use crate::{entry_for_tests, temp_store_path};

#[test]
fn slot_em_voo_sobrevive_ao_restart_e_volta_pela_lease() {
    let path = temp_store_path("inflight");
    let store = HarvestStore::open(&path).unwrap();
    store
        .enqueue_bulk(&[entry_for_tests("tt1"), entry_for_tests("tt2")], 1_000)
        .unwrap();

    let claimed = store.claim(&Lease::new("run-1", 1_000, 60_000), 1_000).unwrap();
    assert_eq!(claimed.len(), 1);
    let entry_id = claimed[0].entry_id.clone();
    drop(store);

    let reopened = HarvestStore::open(&path).unwrap();
    assert_eq!(reopened.load(2_000).unwrap().len(), 1, "o outro segue na fila");
    assert_eq!(reopened.inflight(2_000).unwrap().len(), 1, "o slot sobreviveu");

    assert_eq!(reopened.reclaim_expired(61_500).unwrap(), 1);
    assert_eq!(reopened.load(61_500).unwrap().len(), 2, "voltou para a fila");
    assert!(reopened.inflight(61_500).unwrap().is_empty());
    let back = reopened.load(61_500).unwrap();
    let again = back.iter().find(|e| e.entry_id == entry_id).unwrap();
    assert_eq!(again.attempts, 1, "a tentativa é contada no retorno");
}

#[test]
fn finish_remove_o_slot_e_e_idempotente() {
    let store = HarvestStore::open_memory().unwrap();
    store.enqueue_bulk(&[entry_for_tests("tt1")], 1_000).unwrap();
    let claimed = store.claim(&Lease::new("run-1", 1_000, 60_000), 1_000).unwrap();
    let entry_id = claimed[0].entry_id.clone();
    store.finish(&entry_id).unwrap();
    store.finish(&entry_id).unwrap();
    assert!(store.inflight(2_000).unwrap().is_empty());
    assert!(store.load(2_000).unwrap().is_empty());
}

#[test]
fn entrada_com_tres_tentativas_vai_para_terminal() {
    let store = HarvestStore::open_memory().unwrap();
    let mut entry = entry_for_tests("tt1");
    entry.attempts = 2;
    store.enqueue_bulk(&[entry], 1_000).unwrap();
    let claimed = store.claim(&Lease::new("run-1", 1_000, 1_000), 1_000).unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(store.reclaim_expired(3_000).unwrap(), 1);
    assert_eq!(store.load(3_000).unwrap().len(), 0, "não volta para a fila");
    assert_eq!(store.terminal(3_000).unwrap().len(), 1);
}
```

Se `entry_for_tests`/`temp_store_path` ainda não existirem em
`harvest/src/lib.rs`, crie-os ali como `#[cfg(test)] pub(crate)` (não invente
variante por arquivo de teste).

- [ ] **Step 2: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-harvest --locked slot_em_voo_sobrevive
```
Expected: FAIL — `no method named claim`.

- [ ] **Step 3: implementar**

`inflight.rs`:

```rust
use serde::{Deserialize, Serialize};

pub const MAX_ATTEMPTS: u32 = 3;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Lease {
    pub run_id: String,
    pub leased_at_ms: i64,
    pub lease_until_ms: i64,
}

impl Lease {
    pub fn new(run_id: &str, now_ms: i64, ttl_ms: i64) -> Self {
        Self {
            run_id: run_id.to_string(),
            leased_at_ms: now_ms,
            lease_until_ms: now_ms.saturating_add(ttl_ms),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InflightEntry {
    pub entry_id: String,
    pub entry: crate::HarvestEntry,
    pub lease: Lease,
}

impl InflightEntry {
    pub fn expired(&self, now_ms: i64) -> bool {
        now_ms >= self.lease.lease_until_ms
    }
}
```

Em `store.rs`, o valor de `harvest:v1:q` passa a ser
`{"entries":[…],"inflight":{…},"terminal":[…]}`. Compatibilidade: se o JSON
decodificar como `Vec<HarvestEntry>` (formato antigo), migre em memória e
regrave no próximo `save`. Métodos novos:

- `enqueue_bulk(&[HarvestEntry], now_ms)` — ignora `entry_id` já presente em
  `entries`/`inflight`/`terminal`.
- `claim(&Lease, now_ms) -> Result<Vec<InflightEntry>, String>` — tira a primeira
  de `entries`, grava em `inflight[entry_id]`, **um** save (uma transação de
  linha única).
- `inflight(now_ms) -> Result<Vec<InflightEntry>, String>` — filtra os não
  expirados na leitura (leitura pura; não apaga).
- `reclaim_expired(now_ms) -> Result<usize, String>` — para cada expirado:
  `entry.attempts += 1`; se `attempts < MAX_ATTEMPTS` volta para `entries`
  (no **fim**, para não furar a ordem), senão vai para `terminal` com
  `reason:"lease_expired"`.
- `finish(entry_id)` — remove de `inflight` (idempotente, devolve `Ok(())`).
- `terminal(now_ms)` — devolve os terminais não expirados.

No `worker.rs`, `plan` chama `claim` e mantém o `InflightEntry` no estado do
worker (nada de `Vec` paralelo em memória como fonte de verdade); `finish` do
tick chama `store.finish(&entry_id)`. `TickStart` não muda (o teto veio de
A1).

No `drain.rs`, a impl do trait lê o `entry_id` do `InflightEntry` recebido — não
gera id próprio.

- [ ] **Step 4: gate + commit**

```powershell
cd rust
cargo fmt --all
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
node scripts/check-rust-lines.mjs
```

```powershell
git add rust/crates/adom-harvest rust/crates/adom-server/src/harvest
```
```powershell
git commit -m "feat(harvest): slot em voo duravel com lease e retorno a fila"
```

</details>

### T2-L4: `magnet_work` com dono único (`adom-store`) — EXECUTADA

**O que o plano supunha:** que a T2-L1 tivesse deixado a captura 100% nativa e
que a T2-L2 tivesse entregado uma ponte de LEITURA do banco de magnets, de modo
que `src/utils/magnet-bank-rows.ts` pudesse ser apagado inteiro.

**Causa raiz medida** (o Step 1 mandava parar se houvesse escritor vivo; havia
código de escrita, mas nenhum no caminho da busca):

- A captura de produção JÁ é nativa: `adom-store::capture_items` e
  `mark_filter_outcome`, chamados no fim da busca (`adom-search` `late.rs`) e
  pelo recorder do `adom-crawl` (`ingest/store.rs`). O lado Rust de
  `magnet_work` (`upsert_work`/`mark_work_filter`, um SQL só para a API de uma
  linha e o lote) e os dois testes do CAS já estavam no HEAD (`ed47b1c3`).
- O único chamador de `captureItems` no `src` era `mico.search` — e ele NÃO
  tinha consumidor: `jackett-catalog.ts` importa o módulo só para
  `catalogEntry()`. Código morto desde que o `/stream` virou gateway.
- O que NÃO se confirmou: a T2-L2 entregou o `NativeKv` (cache.db), não uma
  ponte do `magnets.db`. `magnet-bank-rows.ts` é a ENGINE SQLite de leitura
  (painel, play, fallback, import/export); apagá-la hoje derruba o Node
  inteiro. O delete fica para a fatia da ponte napi desse banco.

**Corte executado:**
- `src/providers/mico.ts` reduzido a `MICO_ID` + `catalogEntry()`: saíram o
  `search` (fetch, breaker, `captureItems`), `fetchMicoStreams`, `mapStream`,
  as URLs de stream, `retryAfterMs`, `jackettOnly` e o estado do breaker.
- `test/mico.test.ts` cobre só o card virtual; `test/mico-fetch-deadline.test.ts`
  apagado (a regra de `fetchJsonWithin` segue coberta em `deadline.test.ts`) e
  as entradas saíram do `testFiles`.
- `magnet-bank.ts`: `captureItems`/`markFilterResult` marcados como FIXTURE — a
  produção não os chama. `flushBarrier` continua (import/export), com a fila
  vazia em produção.
- Com isso a prova do plano passa a valer literalmente: grep por
  `captureItems|markFilterResult|enqueueCaptureAndFilter` no `src` só acha as
  definições da fachada.

**Pendente (declarado):** apagar a engine TS (`magnet-bank-rows.ts`, ~397
linhas) exige a ponte napi do `magnets.db` (leitura + `writeBatch` do import).
Sem ela, "dono único" vale para o caminho de produção — busca, crawl e play —
mas não para o import manual do painel, que continua escrevendo pelo engine.

**Arquivos (executado):**
- Modify: `src/providers/mico.ts`, `src/utils/magnet-bank.ts`,
  `test/mico.test.ts`, `package.json`
- Delete: `test/mico-fetch-deadline.test.ts`

**Provas:** `npm run typecheck` (3 programas), `npm run build`, `npm test`
(2426 testes, 2425 pass, 0 fail, 1 skipped), `npm run test:complete` (273
arquivos), `npm run lint:lines -- --check` (644 arquivos, 0 acima do teto) e
`git diff --check`. Rust inalterado nesta fatia: `magnet_work_tests.rs` já cobre
o CAS (`cargo test -p adom-store`).

<details>
<summary>Plano original (histórico) — premissa de que não havia escritor TS</summary>

**Files:**
- Modify: `rust/crates/adom-store/src/magnet_bank_write.rs` (extrai
  `upsert_work` e `mark_work_filter` como API pública)
- Create: `rust/crates/adom-store/src/magnet_work_tests.rs`
- Modify: `rust/crates/adom-store/src/magnet_bank_write.rs` (`mod` de teste no
  `lib.rs`)
- Delete: `src/utils/magnet-bank-rows.ts` (só a escrita; a leitura do painel
  passa pela ponte da T2-L2)
- Modify: `src/utils/magnet-bank.ts`, `src/providers/magnet-bank-hook.ts`
- Modify: `package.json` (`testFiles`, se houver teste dedicado a apagar)

- [ ] **Step 1: provar que não há escritor TS vivo**

```powershell
rg -n "magnet_work" src
rg -n "upsertWork|markWork|writeBatch|applyOps" src
```
Expected: zero chamadas de **escrita**; sobra só leitura (`magnet-bank.ts`
consultando o banco). Se aparecer escrita viva, **pare** — a T2-L1 ficou
incompleta.

- [ ] **Step 2: escrever o teste que falha**

Em `magnet_work_tests.rs`:

```rust
#[test]
fn cas_nao_regride_passed_filter_nem_last_seen() {
    let bank = MagnetBankStore::open_memory().unwrap();
    bank.upsert_work("tt1", "tt1", 1_000).unwrap();
    bank.mark_work_filter("tt1", "tt1", true, 2_000).unwrap();

    // captura atrasada, com last_seen menor: não pode "desmarcar"
    bank.upsert_work("tt1", "tt1", 1_500).unwrap();
    let row = bank.work("tt1", "tt1").unwrap().expect("linha viva");
    assert!(row.passed_filter);
    assert_eq!(row.last_seen_ms, 2_000, "last_seen é MAX");
}

#[test]
fn mark_work_filter_em_linha_ausente_cria_sem_passed_filter() {
    let bank = MagnetBankStore::open_memory().unwrap();
    assert_eq!(bank.mark_work_filter("tt9", "tt9", true, 1_000).unwrap(), false);
    assert!(bank.work("tt9", "tt9").unwrap().is_none());
}
```

- [ ] **Step 3: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-store --locked cas_nao_regride
```
Expected: FAIL — `mark_work_filter` privado/inexistente.

- [ ] **Step 4: implementar e apagar o TS**

Tornar públicas as duas operações que já existem inline em
`capture_items`/`magnet_work` (renomear o `fn` privado, sem duplicar SQL):
`upsert_work(tipo, tt, last_seen_ms)` usa `last_seen = MAX(last_seen, ?)` e **não**
toca `passed_filter`; `mark_work_filter(tipo, tt, valor, now)` só atualiza linha
existente (`UPDATE … WHERE`) e devolve `rows_affected == 1`. `capture_items` passa
a chamar as duas.

Apagar `magnet-bank-rows.ts` com `DeleteFile` e tirar de `src/utils/magnet-bank.ts`
o import correspondente. Se houver teste `test/magnet-bank-rows.test.ts`,
apague junto e remova de `testFiles`.

- [ ] **Step 5: gate + commit**

```powershell
npm run typecheck
npm run build
npm test
npm run test:complete
npm run lint:lines -- --check
npm run parity:frozen
```

```powershell
cd rust
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
```

```powershell
git add src utils rust test package.json
```
```powershell
git commit -m "refactor(store): magnet_work com dono unico e sem escritor TS"
```

</details>

### T3-L4: estado do Chupim nativo (`adom-autofetch`) — EXECUTADA

**O que o plano especificava:** crate puro sobre o `NativeKv` com fila/hold/
obra/suppressed/terminal, **sem rede**, com o Node ainda drenando nesta leva.

**Executado:**

- `rust/crates/adom-autofetch` (novo membro do workspace): `state.rs` (chaves,
  TTLs e registros), `queue.rs` (`AutofetchQueue`: `enqueue`/`entries`/`len`/
  `take`, `hold`/`put_hold`/`is_held`/`release`, `marker`, `obra`),
  `suppressed.rs`, `terminal.rs` e `tests/queue_tests.rs` (9 testes).
- `NativeKv::forget` (em `adom-index`, reexportado por `adom-store`): sem
  remoção de linha não havia como tirar item da fila nem soltar o lease sem
  gravar tombstone.
- Regras invariantes no código: no `enqueue`, `suppressed` → `terminal` → fila,
  nessa ordem; `hold` DURÁVEL (sobrevive a reabrir o `cache.db`, provado com
  `tempfile`), ao contrário do `pending`/`searchSlots` de processo do Node;
  `marker` só no aceite (`release(accepted = true)`) e só para a rodada dona do
  lease (`run`, senão soltar o lease alheio viraria marca falsa); terminal barra
  o enqueue por 24 h e libera depois; `suppressed`/`terminal`/`hold` não colidem
  entre obras (digest com separador).

**Divergências do texto do plano (declaradas):**

1. **Nada foi fiado.** O crate não é importado por nenhum binário: o
   enfileiramento continua no Node até a T3-L5, então não há mudança de
   comportamento nesta leva.
2. **O modelo de chaves é o ALVO, não o do Node.** O Chupim real usa
   `q:<sha256(searchKey)>` com lista de `QueueCandidate`, `o:`, `m:`, `sup:`,
   `dead:` e hold em memória. O crate implementa a fila ÚNICA por obra+episódio
   com lease durável, como o plano manda; as duas metades convivem no mesmo
   `cache.db` (prefixos distintos) até a T3-L6 apagar o TS.
3. **`sha1` → `sha256`.** Não há crate de SHA-1 no workspace e hash não se
   escreve à mão; aqui o papel é encurtar a chave, não autenticar. O registro
   guarda a identidade inteira (`imdb_id` + S/E), então o painel sempre sabe
   QUAL obra está suprimida/terminal — a tabela do plano previa só `reason/at`.
4. **`adrm` não mora no `enqueue`.** A assinatura do plano (`enqueue(imdb, ep)`)
   não recebe hash; "hash com marca `adrm` é recusado" é regra dos pickers
   (`first_viable`), como a própria T3-L5 escreve.
5. **`adom-core` fora do `Cargo.toml`.** Nada das regras portadas é usado
   ainda; entra na T3-L5, quando gate e pickers passarem a chamá-las.
6. **Marker sem `id`.** A tabela manda `{at, source}`. O marker do Node guarda
   o id da transferência (o recheck do Premiumize reencontra o hash por ele): a
   T3-L6 precisa disso e terá que estender o registro e passar o id do aceite
   ao `release`.
7. **Fila sem CAS.** `get_json` + `put_json` não é transação; um escritor por
   vez (a thread do worker na T3-L5) é premissa documentada no módulo.

**Arquivos (executado):**
- Create: `rust/crates/adom-autofetch/{Cargo.toml,src/lib.rs,src/state.rs,src/queue.rs,src/suppressed.rs,src/terminal.rs,tests/queue_tests.rs}`
- Modify: `rust/Cargo.toml` (`members`), `rust/Cargo.lock`,
  `rust/crates/adom-index/src/kv.rs` (`forget`)

**Provas:** `cargo test -p adom-autofetch` (9 testes + 1 doc-test),
`cargo fmt --all`, `cargo clippy --workspace --all-targets --locked -- -D
warnings`, `cargo test --workspace --locked` e `node scripts/check-rust-lines.mjs`
(945 fontes, 0 acima do teto). Nenhum `.ts` tocado: gates TS não se aplicam.

<details>
<summary>Plano original (histórico) — tabela de chaves e testes de referência</summary>

Cria o crate puro que guarda fila/hold/obra/suppressed/terminal sobre o
`NativeKv` (T2-L2). **Nada de rede** — só estado. O Node continua drenando nesta
leva.

**Files:**
- Create: `rust/crates/adom-autofetch/Cargo.toml`
- Create: `rust/crates/adom-autofetch/src/lib.rs`
- Create: `rust/crates/adom-autofetch/src/state.rs` (chaves + tipos)
- Create: `rust/crates/adom-autofetch/src/queue.rs` (fila, dedupe por obra,
  `hold`, `lease`)
- Create: `rust/crates/adom-autofetch/src/suppressed.rs`
- Create: `rust/crates/adom-autofetch/src/terminal.rs`
- Create: `rust/crates/adom-autofetch/src/tests/queue_tests.rs`
- Modify: `rust/Cargo.toml` (`members`, `[workspace.dependencies]`)
- Modify: `rust/crates/adom-store/src/kv.rs` (adiciona `kv_tests` de prefixo)

- [ ] **Step 1: escrever o teste que falha**

Em `tests/queue_tests.rs`:

```rust
use adom_autofetch::queue::{AutofetchQueue, EnqueueOutcome, Hold};
use adom_store::kv::NativeKv;

fn queue() -> AutofetchQueue {
    AutofetchQueue::new(NativeKv::open_memory().unwrap())
}

#[test]
fn enfileira_uma_vez_por_obra_e_episodio() {
    let q = queue();
    assert_eq!(q.enqueue("tt1", None, 1_000).unwrap(), EnqueueOutcome::Enqueued);
    assert_eq!(q.enqueue("tt1", None, 1_001).unwrap(), EnqueueOutcome::Duplicate);
    assert_eq!(q.enqueue("tt1", Some((1, 2)), 1_002).unwrap(), EnqueueOutcome::Enqueued);
    assert_eq!(q.len(1_003).unwrap(), 2);
}

#[test]
fn hold_antes_da_checagem_e_marker_so_no_aceite() {
    let q = queue();
    q.enqueue("tt1", None, 1_000).unwrap();
    let hold = q.hold("tt1", None, "hash-a", 1_000).unwrap();
    assert!(q.is_held(&hold, 1_001).unwrap());
    q.release(&hold, false, 1_002).unwrap();
    assert!(!q.is_held(&hold, 1_003).unwrap());
    assert!(q.marker("hash-a", 1_003).unwrap().is_none(), "recusa não marca");

    let hold = q.hold("tt1", None, "hash-b", 1_004).unwrap();
    q.release(&hold, true, 1_005).unwrap();
    assert!(q.marker("hash-b", 1_006).unwrap().is_some(), "aceite marca");
}

#[test]
fn hold_expirado_nao_bloqueia_nova_tentativa() {
    let q = queue();
    q.enqueue("tt1", None, 1_000).unwrap();
    let stale = Hold::new("tt1", None, "hash-a", 1_000, 1_000);
    q.put_hold(&stale).unwrap();
    assert!(!q.is_held(&stale, 2_100).unwrap());
}

#[test]
fn suppressed_nao_entra_na_fila_e_sai_por_lista() {
    let q = queue();
    q.suppress("tt7", None, "desistiu", 1_000).unwrap();
    assert_eq!(q.enqueue("tt7", None, 1_001).unwrap(), EnqueueOutcome::Suppressed);
    assert_eq!(q.suppressed_keys(1_002).unwrap().len(), 1);
    q.unsuppress("tt7", None).unwrap();
    assert_eq!(q.enqueue("tt7", None, 1_003).unwrap(), EnqueueOutcome::Enqueued);
}
```

- [ ] **Step 2: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-autofetch --locked enfileira_uma_vez
```
Expected: FAIL — crate `adom-autofetch` não existe.

- [ ] **Step 3: implementar o crate**

`Cargo.toml` do crate: `adom-core` + `adom-store` + `serde`/`serde_json`
(do workspace), **sem** `reqwest`/`tokio-net`.

Chaves (namespace `autofetch:v1`, declarado em `RUST_OWNED_PREFIXES` na T3-L5):

| Chave | Conteúdo | TTL |
|---|---|---|
| `autofetch:v1:q` | `[{imdbId, season?, episode?, enqueued_at, attempts}]` | 7 d |
| `autofetch:v1:obra:<tt>` | `{queued, attempts, last_at, terminal?}` | 7 d |
| `autofetch:v1:hold:<sha1(obra+hash)>` | `{obra, hash, lease_until_ms, run}` | 15 min |
| `autofetch:v1:marker:<hash>` | `{at, source}` | 30 d |
| `autofetch:v1:suppressed:<sha1(obra+ep)>` | `{reason, at}` | 7 d |
| `autofetch:v1:terminal:<sha1(obra+ep)>` | `{reason, at}` | 24 h |

Regras que **não** podem variar: `hold` é gravado **antes** da checagem de
cache; o `marker` só é gravado no aceite (`release(accepted = true)`); hash com
marca `adrm` é recusado no `enqueue`; `suppressed` é checado antes da fila.

- [ ] **Step 4: gate + commit**

```powershell
cd rust
cargo fmt --all
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
node scripts/check-rust-lines.mjs
```

```powershell
git add rust/Cargo.toml rust/Cargo.lock rust/crates/adom-autofetch rust/crates/adom-store
```
```powershell
git commit -m "feat(autofetch): crate de estado nativo sobre o kv do cache.db"
```

</details>

---

## Leva 5

### T1-B2: journal de execução e outbox de invalidação — EXECUTADA

O drain que grava índice e morre antes da invalidação deixa lista velha no
`streams`. Esta fatia separa **o que já foi feito** (journal) do **que falta
propagar** (outbox), e a outbox é drenada mesmo sem busca.

**Desenho executado** (differe do plano em quatro pontos, todos deliberados):

- **O journal não ficou no `worker.rs`.** Quem conhece `identity`, o run e os
  DOIS desfechos (drain concluído e preempção) é o loop do gateway
  (`harvest/serve.rs`); o `HarvestWorker` do crate não vê a escrita do índice
  nem a outbox. `journal_begin` abre logo após o claim, `journal_finish` fecha
  logo após o `drain_one` e **antes** do `worker.finish`. O run fecha também na
  preempção — como `failed`, senão ficaria `running` por 24 h.
- **O dreno ganhou arquivo próprio** (`harvest/drain_outbox.rs`, fora do plano)
  com `OutboxReport {acked, failed, dead, store_error}`; `status.rs` expõe
  `outboxDead` (camelCase) e o loop escreve a contagem em cada passagem.
  Sem `StreamsStore` (diagnóstico), ninguém é ackado: os `tries` sobem e o alvo
  vai para a dead-letter — o painel mostra, nada some em silêncio.
- **`journal_tests.rs` cobre journal E outbox** (dono: `journal.rs`): os dois são
  o estado do MESMO drain, e um segundo arquivo de teste só gastaria a catraca.
- **`store.rs` ganhou `keys_with_prefix`/`forget_key`** — base das duas listas.
  `keys_with_prefix` filtra e **não apaga**: leitura não escreve; a linha
  vencida sai no `get_value`. `RunSlot {identity, run_id}` viaja junto para a
  preempção fechar o run sem reconstruir a chave (e o clippy não contar 8 args).

**Arquivos entregues:**
- Create: `rust/crates/adom-harvest/src/{journal.rs,outbox.rs,journal_tests.rs}`
- Create: `rust/crates/adom-server/src/harvest/drain_outbox.rs`
- Modify: `rust/crates/adom-harvest/src/{store.rs,lib.rs}`,
  `rust/crates/adom-server/src/harvest/{serve.rs,mod.rs,status.rs,drain.rs,drain_record.rs}`
  e `drain_record_tests.rs` (mecânico: `RecordArgs`/`retry_invalidations` +
  `outbox_registra_o_alvo_antes_de_invalidar`)

**Sequência do journal:** `begin` → `index` (só após a escrita confirmada) →
`invalidated` (só após o `ack`) → `finish`. A outbox recebe o alvo **antes** da
tentativa de invalidar: é o `pending` em memória que morre com o processo.

**Files:**
- Create: `rust/crates/adom-harvest/src/journal.rs`
- Create: `rust/crates/adom-harvest/src/outbox.rs`
- Create: `rust/crates/adom-harvest/src/journal_tests.rs`
- Modify: `rust/crates/adom-harvest/src/worker.rs` (chama journal antes/depois)
- Modify: `rust/crates/adom-harvest/src/lib.rs`
- Modify: `rust/crates/adom-server/src/harvest/drain.rs` (injeta o dreno da
  outbox no início do tick, **antes** do teto)

- [x] **Step 1: escrever os testes que falham**

Em `journal_tests.rs`:

```rust
#[test]
fn journal_guarda_um_estado_final_por_run_e_sobrescreve_o_anterior() {
    let store = HarvestStore::open_memory().unwrap();
    store.journal_begin("run-1", "tt1", 1_000).unwrap();
    store.journal_step("run-1", "index", 1_100).unwrap();
    store.journal_finish("run-1", "done", 1_200).unwrap();
    let run = store.journal_get("run-1", 1_300).unwrap().unwrap();
    assert_eq!(run.status, "done");
    assert_eq!(run.steps, vec!["index".to_string()]);
    assert_eq!(store.journal_keys(1_300).unwrap().len(), 1);
}

#[test]
fn outbox_sobrevive_e_entrega_uma_vez() {
    let store = HarvestStore::open_memory().unwrap();
    store.outbox_push("obra:tt1", 1_000).unwrap();
    store.outbox_push("obra:tt1", 1_001).unwrap();
    let lote = store.outbox_take(10, 1_002).unwrap();
    assert_eq!(lote.len(), 1, "dedupe por alvo");
    store.outbox_ack(&lote, 1_003).unwrap();
    assert!(store.outbox_take(10, 1_004).unwrap().is_empty());
}
```

- [x] **Step 2: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-harvest --locked journal_guarda_um_estado_final
```
Expected: FAIL.

- [x] **Step 3: implementar**

Journal em `harvest:v1:run:<run_id>` (TTL 24 h, cota do namespace `harvest`),
com `{obra, started_ms, finished_ms?, status: running|done|failed, steps: []}`.
`journal_begin` é idempotente; `journal_step` faz `push` só se ainda não existe
(ordem de execução preservada); `journal_finish` sobrescreve `status`.

Outbox em `harvest:v1:outbox`, lista de `{target, at_ms, tries}`, dedupe por
`target`, `outbox_take` incrementa `tries` e devolve o lote, `outbox_ack`
remove. `tries > 5` → linha vai para `harvest:v1:outbox:dead` e o status expõe
`outboxDead` (não engole).

No `drain.rs`, o primeiro passo do tick (antes de checar pausa/inflight) é
`drain_outbox()`: pega até 20 alvos, chama `StreamsStore::invalidate_for_obra`
para `obra:<tt>` e `invalidate_for_hash` para `hash:<hex>`, e dá `ack` só depois
do `Ok`. Erro de SQLite → não dá ack, conta `tries` e segue.

O worker chama `journal_begin` no claim, `journal_step("index")` após a escrita
do índice, `journal_step("invalidated")` após o `ack` da outbox e
`journal_finish` no fim do tick — **antes** de `store.finish(&entry_id)`.

- [x] **Step 4: gate + commit**

```powershell
cd rust
cargo fmt --all
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
node scripts/check-rust-lines.mjs
```

```powershell
git add rust/crates/adom-harvest rust/crates/adom-server/src/harvest
```
```powershell
git commit -m "feat(harvest): journal de execucao e outbox de invalidacao"
```

### T2-L5: `davail`, `mag` e `mag_meta` no Rust — L5a e L5b EXECUTADAS

Os três nascem da mesma função (`checkCached`) e morrem juntos. `mag` move
**inteiro**: `markBad` apaga o `alive` do mesmo hash na mesma função, então
divisão por prefixo pintaria ⚡ falso.

**DESVIO MEDIDO no código (antes de executar) — três correções ao plano:**

1. **O crate de destino não pode ser `adom-debrid`/`adom-store`.** O `.node`
   (`adom-napi`) só depende de crates leves (`adom-core`, `adom-index`,
   `adom-crawl`); puxar `adom-debrid` (reqwest/tokio/axum) ou `adom-store`
   (adom-search/adom-sources) embarcaria o stack de rede no addon Node — o
   próprio `Cargo.toml` do napi proíbe. O `adom-index` já é o crate leve do
   `cache.db` (hospeda `RawCacheStore` e `NativeKv`), então `davail` e a
   escrita de `mag` nascem lá (`adom-index/src/debrid_state.rs`).
2. **As chaves reais são escopadas por conta**, não `mag:v1:<hash>`:
   `mag:v1:<campo>:<adapter>:<accountScope>:<hash>` (ver `magnet_db.rs::mark_key`)
   e `davail:v1:<adapter>:<accountScope>:<hash>`. Sem o escopo, ⚡ de uma conta
   pintaria na lista de outra.
3. **`mag_meta` NÃO migra nesta fatia.** Os contadores (`adapterCounts`,
   `ttlRemainingSums`, `mag_meta:v1:counts`) são alimentados pelo
   `magnetdb-persist.ts` a partir das ESCRITAS do Node. Como as funções
   `markAlive`/`markBad`/`markLie` continuam sendo chamadas pelo Node (só a
   escrita passa à ponte), a contabilidade segue correta e `mag_meta` fica onde
   está. Mover os contadores exige agregação nativa — fatia própria.
4. **`bad`/`lie` NÃO são eternos**: usam `badTtl`/`lieTtl` da config, e
   `mark_alive` recusa hash com `bad` vivo (o filtro `isBad` do TS).

**Escopo executado (3 frentes):** `DavailStore` e `MagnetStateStore` em
`adom-index/src/debrid_state.rs` (+ testes), e a ponte de classes
`DavailState`/`MagnetState` em `adom-napi/src/debrid_state.rs`.

**Files:**
**L5a — EXECUTADA (estado nativo + ponte, commit desta fatia):**

- `adom-index/src/davail_state.rs` (`DavailStore`) + `magnet_state.rs`
  (`MagnetStateStore`), com testes próprios: 19 testes novos, crate em 60.
- Ponte `adom-napi/src/debrid_state.rs`: classes `DavailState` e
  `MagnetStateStore` (camelCase do napi-rs), com `:memory:` e erro `String` →
  `napi::Error`.
- `src/utils/debrid-state-native.ts` + `test/debrid-state-native.test.ts`
  (10 testes) + entrada em `testFiles`.
- Gate: fmt/clippy workspace 0, `cargo test --workspace` exit 0 (149 suítes),
  catraca `.rs` 956/0, `npm test` exit 0, `test:complete` 272/2,
  `lint:lines` 640/0.

**Divergências medidas ao executar (além das quatro acima):**

5. **`ttl_seconds <= 0` DESLIGA a janela: o store NÃO grava.** É a regra do
   `cache.setMany` do Node (`cache.ts:231`) e de todos os chamadores
   (`magnetdb.ts:86,144,202`, `cache-check.ts:157,192`); `0` é como o operador
   desliga a janela. "Permanente" (`expires_at = 0`) não existe neste par de
   namespaces: o boot do Node apaga `expires_at <= now`. Em `mark_bad` com TTL
   desligado o `alive` também NÃO é apagado (mesmo retorno antecipado do TS).
6. **`Option::None` num `#[napi(object)]` chega como `undefined`**, não `null`:
   o wrapper normaliza na fronteira (`normalizarMagnet`) para o contrato
   `MagnetSide | null` não mentir.
7. **`putMany` da ponte aplica UMA janela** a todas as flags; positivo e
   negativo (janelas diferentes) exigem duas chamadas — documentado no wrapper.

**L5b — EXECUTADA (a virada de dono, commit desta fatia).** `davail` e `mag`
entraram em `RUST_OWNED` (namespace **e** prefixo) e o Node deixou de ser
segundo escritor no `cache.db`:

- `cache-check.ts`, `br-coverage.ts` e `magnetdb.ts` leem/escrevem só pela
  ponte (`davailState()`/`magnetState()`); `magnetdb-inspect` enumera por
  `magnetState().entries/summary`, não mais por `cache.keysMatching('mag:')`.
- **A poda (`sweep`) é o ÚNICO caminho que apaga e contabiliza.**
  `state`/`stateSnapshot`/`entries`/`remaining` deixavam de apagar a linha
  vencida na leitura; apagar ali sumia com a linha SEM baixa no agregado
  durável (`mag_meta:v1:counts`, cujo decremento só existe nos `counts` da
  poda) e o `mark_alive` a recontava como nascida (`row_exists` por presença
  física) — o contador ficava inflado para sempre.
- `forget_bad_of` passou a devolver quantas LINHAS saíram (uma por conta): o
  booleano anterior perdia a segunda conta e o agregado não baixava.
- Teste novo `test/cache-keys-debrid-owned.test.ts` (3 testes) pina a posse
  (`set`/`forget`/`forgetMany` no-op, sem L1) e amarra `isSupportedHash` ao
  corpo de `is_valid_hash` do núcleo.
- Fixtures migradas: `magnet-db-persistence`, `magnet-db-empirical-challenge`
  (evicção provada pela ponte + poda), `dashboard-actions`, `debrid-avail` e
  `e2e/tier2-cache-storage` (o balde-amostra virou `meta:`).
- Gate: `typecheck` 0, `npm test` 2392 testes (2391 pass, 1 skip, 0 fail),
  `test:complete` 273/2, `lint:lines` 641/0, `cargo test -p adom-index` 73,
  `cargo fmt --check` 0, `clippy -p adom-index -p adom-napi --all-targets` 0,
  catraca `.rs` 959/0.

**PLANO ORIGINAL (referência, superado pelos itens acima):**

- Create: `rust/crates/adom-debrid/src/davail.rs`
- Create: `rust/crates/adom-debrid/src/davail_tests.rs`
- Create: `rust/crates/adom-store/src/magnet_db_write.rs`
- Create: `rust/crates/adom-store/src/magnet_db_write_tests.rs`
- Modify: `rust/crates/adom-debrid/src/store.rs:56-67` (deixa de ser read-only)
- Modify: `rust/crates/adom-napi/src/lib.rs` (ponte `davailGetMany` e
  `magnetStateSnapshot`)
- Modify: `src/debrid/cache-check.ts:145-195,297-311,369-388`
- Modify: `src/utils/magnetdb.ts:112,150,207` e `src/utils/magnetdb-persist.ts:64`
- Modify: `src/utils/cache-keys.ts:201-218`
- Create: `test/cache-keys-debrid-owned.test.ts` (+ entrada em `testFiles`)

- [ ] **Step 1: escrever os testes que falham**

Em `davail_tests.rs`:

```rust
#[test]
fn davail_ttl_zero_nao_expira_e_lote_devolve_so_presentes() {
    let store = DavailStore::open_memory().unwrap();
    let conta = AccountId::premiumize("k1");
    store.put("aaaa", &conta, true, 0, 1_000).unwrap();
    store.put("bbbb", &conta, false, 86_400, 1_000).unwrap();

    let lote = store
        .get_many(&["aaaa", "bbbb", "cccc"], &conta, 9_999_999)
        .unwrap();
    assert_eq!(lote.len(), 2, "hash desconhecido não aparece");
    assert!(lote["aaaa"], "TTL zero não expira");
    assert!(!lote["bbbb"]);
}

#[test]
fn conta_diferente_nao_ve_o_cache_da_outra() {
    let store = DavailStore::open_memory().unwrap();
    store.put("aaaa", &AccountId::premiumize("k1"), true, 600, 1_000).unwrap();
    assert!(store
        .get("aaaa", &AccountId::premiumize("k2"), 2_000)
        .unwrap()
        .is_none());
}
```

Em `magnet_db_write_tests.rs`:

```rust
#[test]
fn mark_bad_apaga_o_alive_do_mesmo_hash_na_mesma_transacao() {
    let db = MagnetDbStore::open_memory().unwrap();
    db.mark_alive("aaaa", 1_000).unwrap();
    db.mark_bad("aaaa", 1_001).unwrap();
    assert_eq!(db.state("aaaa", 1_002).unwrap(), Some(MagnetState::Bad));
    assert!(!db.is_alive("aaaa", 1_002).unwrap());
}

#[test]
fn lie_e_bad_sao_exclusivos_por_hash() {
    let db = MagnetDbStore::open_memory().unwrap();
    db.mark_alive("aaaa", 1_000).unwrap();
    db.mark_lie("aaaa", 1_001).unwrap();
    assert_eq!(db.state("aaaa", 1_002).unwrap(), Some(MagnetState::Lie));
}
```

Em `test/cache-keys-debrid-owned.test.ts`:

```ts
import { isForeignKey } from '../src/utils/cache-keys.js';

test('davail, mag e mag_meta são do Rust', () => {
  for (const key of ['davail:v1:premiumize:k1:abc', 'mag:v1:abc', 'mag_meta:v1:abc']) {
    assert.equal(isForeignKey(key), true, key);
  }
});
```

- [ ] **Step 2: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-debrid --locked davail_ttl_zero
cargo test -p adom-store --locked mark_bad_apaga_o_alive
```
Expected: FAIL — `DavailStore`/`mark_bad` inexistentes.

- [ ] **Step 3: implementar**

Chaves:

| Chave | Valor | TTL |
|---|---|---|
| `davail:v1:<serviço>:<conta>:<hash>` | `1`/`0` | ⚡ = 24 h; negativo = 6 h; TTL zero = não expira |
| `mag:v1:<hash>` | `alive`/`bad`/`lie` | sem expiração para `bad`/`lie`; `alive` 7 d |
| `mag_meta:v1:<hash>` | `{size, resolution, files}` | 30 d |

Regras que **não** podem variar: `mark_bad`/`mark_lie` apagam o `alive` do mesmo
hash na **mesma transação**; `bad` só vem de `NoVideoError` e `lie` só de
`DubLieError` — nenhum dos dois é inferido de timeout; falso negativo é pior que
falso positivo.

Ponte napi: `davailGetMany(servico, conta, hashes) -> Record<string, boolean>` e
`magnetStateSnapshot(hashes) -> Record<string, 'alive'|'bad'|'lie'>`.

No Node: `noteAvailable`/`noteUnavailable` perdem a escrita; a leitura L1 de
`cache-check.ts:304` e o lote de `:383/:388` passam a chamar a ponte; os três
namespaces entram em `RUST_OWNED` **antes** do primeiro uso.

- [ ] **Step 4: gate + commit**

```powershell
npm run typecheck
npm run build
npm test
npm run test:complete
npm run lint:lines -- --check
npm run parity:frozen
```

```powershell
cd rust
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
```

```powershell
git add src rust test package.json
```
```powershell
git commit -m "feat(debrid): davail, mag e mag_meta nativos e ponte de leitura"
```

### T3-L5: worker do Chupim — enfileiramento, pickers e gate

O estado é nativo (T3-L4). Esta fatia faz o **enfileiramento** ser nativo: os
efeitos `autofetch`/`autofetch_batch` deixam de atravessar HTTP e o Node não tem
mais fila própria. O **drain** (rede e debrid) continua no TS até a T3-L6.

**Files:**
- Create: `rust/crates/adom-server/src/autofetch/mod.rs`
- Create: `rust/crates/adom-server/src/autofetch/config.rs`
- Create: `rust/crates/adom-server/src/autofetch/routes.rs`
- Create: `rust/crates/adom-server/src/autofetch/pickers.rs`
- Create: `rust/crates/adom-server/src/autofetch/gate.rs`
- Create: `rust/crates/adom-server/src/autofetch/status.rs`
- Create: `rust/crates/adom-server/src/autofetch/enqueue_tests.rs`
- Modify: `rust/crates/adom-server/src/lib.rs` (thread `adom-autofetch`)
- Modify: `rust/crates/adom-search/src/orchestrator/late.rs` (não envia os dois
  efeitos)
- Modify: `src/routes/internal-search-effects.ts` (remove os dois braços)
- Modify: `src/autofetch/enqueue.ts` (lê a fila pela ponte, sem cache próprio)
- Modify: `src/utils/cache-keys.ts` (`autofetch` em `RUST_OWNED_PREFIXES`)
- Create: `test/autofetch-queue-bridge.test.ts` (+ entrada em `testFiles`)

- [ ] **Step 1: escrever os testes que falham**

```rust
#[test]
fn gate_nao_enfileira_quando_ha_stream_tocavel_em_cache() {
    let ctx = GateCtx::cached(&["aaaa"]);
    assert_eq!(enqueue_for(&ctx, &queue(), 1_000).unwrap(), EnqueueOutcome::Skipped);
}

#[test]
fn obra_terminal_nao_reenfileira_antes_do_ttl() {
    let ctx = GateCtx::cold();
    let q = queue();
    q.terminate("tt1", None, "dead", 1_000).unwrap();
    assert_eq!(enqueue_for(&ctx, &q, 2_000).unwrap(), EnqueueOutcome::Duplicate);
    assert_eq!(enqueue_for(&ctx, &q, 90_000_000).unwrap(), EnqueueOutcome::Enqueued);
}

#[test]
fn hash_com_marca_adrm_sai_antes_dos_pools() {
    let ctx = GateCtx::cold_with_candidates(&["aaaa", "bbbb"]);
    let mut marks = OwnershipStore::open_memory().unwrap();
    marks.mark_removed("aaaa", SweepKind::Content, 1_000).unwrap();
    let escolhido = first_viable(&ctx, &marks, 1_001).unwrap().unwrap();
    assert_eq!(escolhido, "bbbb", "o morto não pode parar a fila");
}
```

- [ ] **Step 2: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-server --locked gate_nao_enfileira_quando
```
Expected: FAIL.

- [ ] **Step 3: implementar**

Thread própria (`adom-autofetch`, molde de `adom-server/src/harvest/`), com:

- `config.rs`: `POST /autofetch/config` (control plane do Node) e a pausa do
  painel; overrides valem só em memória até o próximo boot, como hoje.
- `pickers.rs`: pools `br > any > seeds`; `adrm` e morto saem **antes** dos
  pools (senão o Chupim para no hash recusado a cada busca).
- `gate.rs`: só enfileira sem stream tocável em cache, sem cobertura por
  qualidade-alvo e sem terminal dentro do TTL.
- `status.rs`: fila, holds, terminais, `paused`, último erro — lido pelo painel
  pela admin do gateway (`GET /autofetch`).

O `late.rs` deixa de enviar `autofetch`/`autofetch_batch`; o Node perde os dois
braços em `internal-search-effects.ts` e passa a ler a fila pela ponte napi
(`autofetchQueueSnapshot`), sem `cache.get` próprio. `autofetch` entra em
`RUST_OWNED_PREFIXES` (o L1 do Node não carrega fila velha no boot).

- [ ] **Step 4: gate + commit**

```powershell
npm run typecheck
npm run build
npm test
npm run test:complete
npm run lint:lines -- --check
npm run parity:frozen
```

```powershell
cd rust
cargo fmt --all
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
node scripts/check-rust-lines.mjs
```

```powershell
git add src rust test package.json
```
```powershell
git commit -m "feat(autofetch): enfileiramento nativo com pickers e gate"
```

---

## Leva 6

### T1-B3: replay e exactly-once na retomada

Com o slot durável (B1) e o journal (B2), falta o **replay**: ao subir, o worker
reprocessa o que ficou `running` sem reaplicar escrita já marcada. É esta fatia
que fecha a 5H.

**Files:**
- Create: `rust/crates/adom-harvest/src/replay.rs`
- Create: `rust/crates/adom-harvest/src/replay_tests.rs`
- Create: `rust/crates/adom-harvest/src/run_id.rs`
- Modify: `rust/crates/adom-harvest/src/worker.rs` (boot do tick + passagem de
  `run_id`)
- Modify: `rust/crates/adom-harvest/src/store.rs` (`claim` recebe `run_id`)
- Modify: `rust/crates/adom-server/src/harvest/mod.rs` (chama `replay_pending`
  no boot da thread)
- Modify: `rust/crates/adom-server/src/harvest/status.rs` (`pendingRuns`,
  `replayedRuns`)

- [ ] **Step 1: escrever os testes que falham**

Em `replay_tests.rs`:

```rust
#[test]
fn retomada_nao_reaplica_passo_ja_marcado() {
    let store = HarvestStore::open_memory().unwrap();
    store.journal_begin("run-1", "tt1", 1_000).unwrap();
    store.journal_step("run-1", "index", 1_100).unwrap();
    // processo morreu: o journal ficou `running` e o slot em voo existe
    let pendentes = crate::replay::pending_runs(&store, 2_000).unwrap();
    assert_eq!(pendentes.len(), 1);
    assert_eq!(pendentes[0].steps, vec!["index".to_string()]);
    assert!(pendentes[0].missing_step("index") == false);
    assert!(pendentes[0].missing_step("invalidated"));
}

#[test]
fn run_id_e_unico_e_sobrevive_ao_restart() {
    let a = crate::run_id::new_run_id(1_000);
    let b = crate::run_id::new_run_id(1_000);
    assert_ne!(a, b);
    assert!(a.starts_with("h-"));
}

#[test]
fn entrada_repetida_no_replay_nao_duplica_escrita() {
    let store = HarvestStore::open_memory().unwrap();
    store.enqueue_bulk(&[entry_for_tests("tt1")], 1_000).unwrap();
    let lease = Lease::new("run-1", 1_000, 60_000);
    store.claim(&lease, 1_000).unwrap();
    let replayed = crate::replay::replay_pending(&store, 2_000).unwrap();
    assert_eq!(replayed.len(), 1);
    assert_eq!(store.inflight(2_000).unwrap().len(), 1, "não criou segundo slot");
}
```

- [ ] **Step 2: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-harvest --locked retomada_nao_reaplica
```
Expected: FAIL — módulo `replay` inexistente.

- [ ] **Step 3: implementar**

`run_id.rs`:

```rust
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// `h-<now_ms>-<seq>-<pid>`: legível no log e único por processo.
pub fn new_run_id(now_ms: i64) -> String {
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("h-{now_ms}-{seq}-{}", std::process::id())
}
```

`replay.rs`:

- `pending_runs(&store, now_ms) -> Vec<PendingRun>`: lê `harvest:v1:run:*` com
  `status == "running"` e devolve `{run_id, obra, steps, started_ms}`.
- `missing_step(&self, nome)` é `!steps.contains(nome)`.
- `replay_pending(&store, now_ms) -> Result<Vec<InflightEntry>, String>`: para
  cada run pendente, localiza o slot em voo pelo `run_id` da lease; se o slot
  existe, **reusa** (não cria outro). Se a lease venceu, `reclaim_expired`
  devolve à fila e o run é fechado como `failed` com `reason:"lease_lost"`.
  Se não há slot nem journal, o run é fechado como `failed`.
- O replay roda **uma vez** no boot da thread de harvest, antes do primeiro
  `tick`; `status.rs` publica `pendingRuns` (o que sobrou) e `replayedRuns`
  (quantos foram retomados).

No worker, `claim` recebe a `Lease` com o `run_id` gerado por
`new_run_id(now)`; `journal_begin` usa o mesmo id. O passo `invalidated` só é
marcado **depois** do `ack` da outbox (B2) — a ordem importa para o replay.

- [ ] **Step 4: gate + commit**

```powershell
cd rust
cargo fmt --all
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
node scripts/check-rust-lines.mjs
```

```powershell
git add rust/crates/adom-harvest rust/crates/adom-server/src/harvest
```
```powershell
git commit -m "feat(harvest): replay de runs pendentes com retomada exata"
```

### T2-L6: `adsub`/`adprot` no dono único — EXECUTADA (feed de holds mantido)

Posse (`adsub`) e proteção BR (`adprot`) são pré-requisito do delete da
AllDebrid: o `CleanupGate` nativo já as **lia** do `cache.db`
(`cleanup_durable.rs:148-227`), mas quem **escrevia** era o Node, com o
`cache.ts` mantendo um L1 paralelo para o mesmo estado. Esta fatia tirou o
segundo escritor.

**DESVIO MEDIDO no código (antes de executar) — o plano original pedia três
coisas que o código não sustenta:**

1. **O feed `POST /internal/debrid/holds` NÃO sai nesta fatia.** Ele não
   transporta só `adsub`/`adprot`: carrega também o **hold volátil** do
   autofetch (`held`, em memória em `protected.ts`) e o `knownBefore` (snapshot
   de pré-existência da conta), que só migram em T3-L5/T3-L6. Apagar a rota
   agora deixaria o `HoldsFacts::covers` sem cobertura de `evaluated` e o
   `may_delete` fecharia para TUDO. `src/routes/internal-debrid-holds.ts` e a
   rota em `adom-debrid/src/api.rs` **permanecem**.
2. **`OwnershipStore` (`adom-debrid/src/ownership.rs`) não foi criado.** Um
   store novo num crate que já lê o MESMO `cache.db` por `DurablePeek` seria um
   terceiro leitor do mesmo arquivo sem ganho — o que faltava não era leitor, era
   **dono único da escrita**. A escrita passou ao `NativeKv` do `adom-index`, que
   o `.node` já embarca (crate leve; `adom-debrid` puxaria reqwest/tokio para
   dentro do addon Node — o mesmo veto do T2-L5).
3. **`adprot` não é `{expires_at}` no corpo.** O registro é
   `{acceptedAt, readyAt}` e o vencimento mora na coluna `expires_at` do KV, como
   no `cache.set` do Node. Mudar o formato quebraria o `DurablePeek` nativo
   existente — e o TTL da retenção BR é o `DEBRID_AUTOFETCH_PROTECT_BR_TTL`.

**Escopo executado:**

- `adom-index/src/kv.rs`: `remaining_seconds` (mesma régua do
  `cache.peekRemaining`: ausente, permanente e vencida devolvem `None`; delta
  arredondado com `.5` para cima) e `forget_prefix` (DELETE por prefixo,
  devolvendo quantas linhas saíram). Testes em `kv_tests.rs` (crate em 75).
- `adom-napi/src/kv.rs`: `forget`, `remainingSeconds` e `forgetPrefix` na
  classe `NativeKv` (camelCase), somados ao `getJson`/`keys`/`setJson`.
- `src/utils/native-kv.ts`: superfície TS completa. **`kvSet` devolve `boolean`
  e NUNCA lança** — `protectBr`/`noteReady`/`persistSubmitted` são chamados no
  caminho do autofetch e o `cache.set` anterior também não lançava; a métrica só
  conta quando a linha entrou (`adprot.set`, `adprot.renewed`, `adsub.persisted`).
  `kvSetForTest` **lança** (semeadura de teste deve gritar).
- `src/utils/cache-keys.ts`: `adsub` e `adprot` em `RUST_OWNED` **e** em
  `RUST_OWNED_PREFIXES` (o prefixo é o que faz `cache.get/peek` cair na ponte em
  vez de devolver o L1 vazio).
- `src/utils/cache.ts`: `clear()` apaga os dois prefixos pelo nativo;
  `clearNamespace('adsub'|'adprot')` delega e soma a contagem do handle.
- `src/debrid/protected.ts` (9 sítios) e `src/debrid/alldebrid-inventory.ts`
  (`persistSubmitted`, `submittedAt`, `persistedSubmitted`, `forgetSubmitted`):
  leitura e escrita só pela ponte.
- Testes migrados (12 arquivos: `alldebrid-*`, `debrid-*` e o mock): quem
  semeava `cache.set(adsub/adprot)` usa `kvSet`; quem lia usa `kvPeek`.
- `test/debrid-kv-owned.test.ts` (novo, 4 testes, entrada em `testFiles`):
  posse por namespace/prefixo, roundtrip com TTL e `kvForget` idempotente,
  recusa de escrita/leitura pelo `cache` do Node e `clearNamespace` contando o
  que o núcleo apagou.

**Duas armadilhas medidas (custaram um debug):**

4. **`src/config.ts` é SNAPSHOT.** O import estático de `native-kv` (que puxa
   `config`) no topo de um teste que depois muda `CACHE_PERSIST`/
   `CACHE_DB_PATH` congela os valores ANTIGOS: o `persistence.open()` nunca abre
   o arquivo temporário, o `INSERT` estoura "no such table" e o `finally` mascara
   com `EBUSY` (handle `DatabaseSync` vazado). Por isso o teste da posse mora em
   arquivo próprio, com `:memory:` (o `setup-env` pina `CACHE_PERSIST=false`).
5. **`kvPeek` engole erro** (devolve `null`), então o `try/catch` de
   `heldHashesFor` que derrubava `complete` fica inalcançável pela ponte. Não é
   regressão de prova: o `CleanupGate` do Rust lê `adprot` direto do mesmo
   `cache.db` por `DurablePeek`, e o `cache.peek` anterior também nunca lançava.

**Gate executado:** `typecheck` 0, `build` 0, `npm test` 2395/0 (2396 testes,
1 skip, 78 suítes), `test:complete` 274 arquivos/2 harnesses,
`lint:lines -- --check` 642/0, `cargo fmt --all -- --check` 0,
clippy e `cargo test` do workspace 0, `cargo test -p adom-index` 75/0,
catraca `.rs` 959/0, `git diff --check` 0.

**Pendências que ficam para T3-L5/T3-L6:** hold volátil e `knownBefore`
nativos (só então o feed `/debrid/holds` e `src/routes/internal-debrid-holds.ts`
saem), e o `adrm` (anti-reenchimento) segue no `cache` do Node — é T2-L7.


### T3-L6: worker do Chupim (recheck, evict, seeds) e fim do autofetch TS

O estado já é nativo (T3-L4) e o enfileiramento já é do worker (T3-L5). Esta
fatia leva a **execução** para o Rust e apaga os 25 arquivos do Chupim no Node.

**Files:**
- Create: `rust/crates/adom-server/src/autofetch/recheck.rs`
- Create: `rust/crates/adom-server/src/autofetch/evict.rs`
- Create: `rust/crates/adom-server/src/autofetch/seeds.rs`
- Create: `rust/crates/adom-server/src/autofetch/season_fill.rs`
- Create: `rust/crates/adom-server/src/autofetch/drain_tests.rs`
- Modify: `rust/crates/adom-server/src/autofetch/{mod,drain,status}.rs`
- Delete: todos os `src/**/autofetch*.ts` (25 arquivos, §6)
- Delete: os 25 `test/autofetch*.test.ts` correspondentes
- Modify: `package.json` (`testFiles`)
- Modify: `src/addon.ts` (não sobe mais worker do Chupim)

- [ ] **Step 1: listar o que vai sair (prova antes de apagar)**

```powershell
rg --files src | rg "autofetch"
rg --files test | rg "autofetch"
rg -n "autofetch" src --glob "!**/autofetch*"
```
Expected: o terceiro comando mostra só o ponto de composição (`src/addon.ts`)
e o painel (`src/routes/dashboard-*`). Qualquer outro chamador vivo → registre e
**não** apague aquele arquivo nesta fatia.

- [ ] **Step 2: escrever os testes que falham**

Em `drain_tests.rs` (stubs de rede, sem tocar Jackett/debrid real):

```rust
#[test]
fn recheck_de_torrent_morto_marca_terminal_sem_redownload() {
    let stub = StubDrain::dead_torrent("aaaa");
    let out = drain_entry(&stub, entry_for("tt1"), &queue(), 1_000).unwrap();
    assert_eq!(out.kind, DrainKind::Dead);
    assert_eq!(out.redownloads, 0);
    assert!(queue().terminal_for("tt1", None, 1_001).unwrap().is_some());
}

#[test]
fn evict_nao_apaga_hash_com_posse_do_usuario() {
    let debit = StubDrain::cached_with_ownership(&["aaaa"], &["bbbb"]);
    let out = evict_step(&debit, &ownership_com(&["aaaa"]), 1_000).unwrap();
    assert_eq!(out.deleted, vec!["bbbb"]);
}

#[test]
fn season_fill_so_preenche_buraco_que_a_obra_declara() {
    let out = season_fill_step(&StubDrain::seasons(&[1, 2, 4]), entry_for("tt1"), 1_000).unwrap();
    assert_eq!(out.missing, vec![3]);
}
```

- [ ] **Step 3: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-server --locked recheck_de_torrent_morto
```
Expected: FAIL.

- [ ] **Step 4: implementar**

Portar as três cascatas por comportamento, **não** por tradução literal:

- `recheck`: sonda o magnet, distingue `Dead` (`NoVideoError` → `bad`), `Lie`
  (`DubLieError` → `lie`) e `Alive` (renova `alive`); nunca rebaixa a fila para
  P2P por morte de um candidato.
- `evict`: só apaga fallback (nunca posse do usuário nem hold do autofetch);
  usa `OwnershipStore` (T2-L6) e `MagnetDbStore` (T2-L5), sem HTTP.
- `seeds`: pools `br > any > seeds`, teto por obra e cobertura por
  qualidade-alvo; hash com marca `adrm` é descartado **antes** dos pools (senão
trava no próximo viável).
- `season_fill`: só preenche buraco declarado pela obra; temporada sem
  evidência não vira S1.

O worker consome a fila pelo `AutofetchQueue` (T3-L4) e grava o estado pela
mesma API. Efeitos `autofetch`/`autofetch_batch` deixam de existir; `br_probe` e
`season_key` idem.

- [ ] **Step 5: apagar o TS e ajustar `testFiles`**

`DeleteFile` em cada arquivo listado no Step 1 (25 `src/**/autofetch*.ts` + 25
testes). Remover as entradas correspondentes de `testFiles`. Remover do
`src/addon.ts` a chamada que sobe o worker.

- [ ] **Step 6: gate + commit**

```powershell
npm run typecheck
npm run build
npm test
npm run test:complete
npm run lint:lines -- --check
npm run parity:frozen
```

```powershell
cd rust
cargo fmt --all
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
node scripts/check-rust-lines.mjs
```

```powershell
git add -A src rust test package.json
```
```powershell
git commit -m "refactor(autofetch): worker nativo e fim do chupim em typescript"
```

> `git add -A src rust test` é autorizado **só** nesta fatia, e só depois de
> `git status --short` confirmar que não há lixo alheio dentro desses três
> caminhos. `package-lock.json`, `.cursor/`, `.codex/` e `plugins/` nunca entram.

---

## Leva 7

### T1-C1: contador de geração e `set_fenced` no `StreamsStore`

A outbox (B2) propaga a invalidação, mas **nada impede** uma busca que começou
antes de gravar a lista velha depois. Esta fatia cria o contador de geração que
a T1-C2 consome.

**Files:**
- Modify: `rust/crates/adom-store/src/streams.rs:48-235` (SCHEMA
  `streams_meta`, transação em `invalidate_for_obra`, `fence_for_key`,
  `set_fenced`)
- Create: `rust/crates/adom-store/src/streams_fence_tests.rs`
- Modify: `rust/crates/adom-store/src/lib.rs` (`mod` de teste)

- [ ] **Step 1: escrever os testes que falham**

Em `streams_fence_tests.rs`:

```rust
#[test]
fn invalidar_incrementa_a_geracao_da_obra() {
    let store = StreamsStore::open_memory().unwrap();
    store.set("streams:v21:movie:tt1:scope", &entry(), 600, 1_000).unwrap();
    let antes = store.fence_for_key("streams:v21:movie:tt1:scope").unwrap();
    assert_eq!(store.invalidate_for_obra("tt1").unwrap(), 1);
    let depois = store.fence_for_key("streams:v21:movie:tt1:scope").unwrap();
    assert!(depois.obra > antes.obra);
}

#[test]
fn escrita_com_fence_velha_e_descartada() {
    let store = StreamsStore::open_memory().unwrap();
    let velha = store.fence_for_key("streams:v21:movie:tt1:scope").unwrap();
    store.invalidate_for_obra("tt1").unwrap();
    assert_eq!(
        store.set_fenced("streams:v21:movie:tt1:scope", &entry(), 600, 1_000, &velha).unwrap(),
        false
    );
    assert!(store.get("streams:v21:movie:tt1:scope", 1_001).unwrap().is_none());
}

#[test]
fn escrita_com_fence_nova_e_aceita() {
    let store = StreamsStore::open_memory().unwrap();
    store.invalidate_for_obra("tt1").unwrap();
    let nova = store.fence_for_key("streams:v21:movie:tt1:scope").unwrap();
    assert!(store.set_fenced("streams:v21:movie:tt1:scope", &entry(), 600, 1_000, &nova).unwrap());
    assert!(store.get("streams:v21:movie:tt1:scope", 1_001).unwrap().is_some());
}

#[test]
fn clear_all_incrementa_o_epoch_e_invalida_tudo() {
    let store = StreamsStore::open_memory().unwrap();
    let velha = store.fence_for_key("streams:v21:movie:tt1:scope").unwrap();
    store.clear_all().unwrap();
    assert_eq!(
        store.set_fenced("streams:v21:movie:tt1:scope", &entry(), 600, 1_000, &velha).unwrap(),
        false
    );
}
```

- [ ] **Step 2: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-store --locked escrita_com_fence_velha
```
Expected: FAIL — `fence_for_key` inexistente.

- [ ] **Step 3: implementar**

No `SCHEMA` do `streams.rs` (fora do namespace de cache, para o `clear_all` não
apagar o contador):

```sql
CREATE TABLE IF NOT EXISTS streams_meta (
    key   TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);
```

```rust
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Fence {
    pub obra: u64,
    pub epoch: u64,
}
```

- `invalidate_for_obra`: uma transação `BEGIN IMMEDIATE`; `INSERT INTO
  streams_meta(key, value) VALUES(gen:obra:<tipo>:<tt[:S:E]>, 1) ON CONFLICT(key)
  DO UPDATE SET value = value + 1` **por obra encontrada**; `DELETE` das
  chaves; `COMMIT`. O nome da geração é derivado da **chave de cache**, então
  `movie` e `series` da mesma obra têm contadores distintos.
- `clear_all`, `clear_by_suffix`, `invalidate_for_hash`: incrementam
  `gen:epoch` na mesma transação do delete.
- `fence_for_key(&self, key) -> Result<Fence, String>`: `obra` do
  `gen:obra:<…>` daquela chave (0 se nunca invalidada) e `epoch` de `gen:epoch`.
- `set_fenced(&self, key, value, ttl, now, fence) -> Result<bool, String>`:
  numa transação única, lê as duas gerações; descarta (`Ok(false)`, sem gravar)
  se `fence.epoch < epoch` **ou** `fence.obra < obra`; senão faz o mesmo
  `INSERT … ON CONFLICT` do `set` e aplica a cota.

`set` continua existindo (caminhos que não vêm de busca); o worker do harvest e
o autofetch usam `set` — quem usa `set_fenced` é só o orquestrador (T1-C2).

- [ ] **Step 4: gate + commit**

```powershell
cd rust
cargo fmt --all
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
node scripts/check-rust-lines.mjs
```

```powershell
git add rust/crates/adom-store
```
```powershell
git commit -m "feat(store): contador de geracao por obra e escrita com fence"
```

### T2-L7: `adrm` no Rust e dono das varreduras

`adrm` é o anti-reenchimento das varreduras **de conteúdo**: o hash que a
varredura apagou não volta a ser tentado. Hoje é escrito pelo Node
(`alldebrid-reupload.ts:92`) e lido pelo Rust (`cleanup_durable.rs`).

**Files:**
- Modify: `rust/crates/adom-debrid/src/ownership.rs` (chaves `adrm:v1:<hash>`
  com `{reason, at}`)
- Modify: `rust/crates/adom-debrid/src/cleanup.rs` (marca só nas varreduras de
  conteúdo)
- Modify: `rust/crates/adom-debrid/src/ownership_tests.rs`
- Modify: `src/debrid/alldebrid-reupload.ts:92` (para de escrever)
- Modify: `src/utils/cache-keys.ts` (`adrm` em `RUST_OWNED`)
- Modify: `docs/debrid-al-check-rust.md` (dono novo + invariantes)

- [ ] **Step 1: escrever o teste que falha**

```rust
#[test]
fn marca_adrm_so_nas_varreduras_de_conteudo() {
    let store = OwnershipStore::open_memory().unwrap();
    store.mark_removed("aaaa", SweepKind::Hygiene, 1_000).unwrap();
    assert!(store.removed("aaaa", 1_001).unwrap().is_none(), "higiene nunca marca");
    store.mark_removed("bbbb", SweepKind::Content, 1_000).unwrap();
    assert!(store.removed("bbbb", 1_001).unwrap().is_some());
}

#[test]
fn hash_marcado_sai_dos_candidatos_antes_dos_pools() {
    let store = OwnershipStore::open_memory().unwrap();
    mark_removed(&store, "aaaa", SweepKind::Content, 1_000).unwrap();
    let candidatos = candidates_excluding_removed(&store, &["aaaa", "bbbb"], 1_001).unwrap();
    assert_eq!(candidatos, vec!["bbbb"]);
}
```

- [ ] **Step 2: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-debrid --locked marca_adrm_so_nas_varreduras
```
Expected: FAIL.

- [ ] **Step 3: implementar**

`SweepKind::{Hygiene, Content}` explícito no chamador; `mark_removed` só grava
`adrm:v1:<hash>` para `Content` (a higiene da checagem **nunca** marca — é a
mesma regra do TS hoje). `removed(hash, now)` devolve `Option<Reason>`.

No TS, `alldebrid-reupload.ts` perde a escrita (`adrm` entra em `RUST_OWNED`);
a leitura de painel continua pela ponte. Atualizar `docs/debrid-al-check-rust.md`
com a tabela de quem marca.

- [ ] **Step 4: gate + commit**

```powershell
npm run typecheck
npm run build
npm test
npm run test:complete
```

```powershell
cd rust
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
```

```powershell
git add src rust test docs/debrid-al-check-rust.md
```
```powershell
git commit -m "refactor(debrid): adrm nativo e varreduras com dono unico"
```

### T3-L7: `rd-warmer` e `dub-audit` nativos

São os dois últimos efeitos de fundo que ainda atravessam HTTP até o Node.

**Files:**
- Create: `rust/crates/adom-server/src/autofetch/warmer.rs`
- Create: `rust/crates/adom-server/src/autofetch/dub_audit.rs`
- Create: `rust/crates/adom-server/src/autofetch/warmer_tests.rs`
- Modify: `rust/crates/adom-search/src/orchestrator/late.rs` (não envia
  `rd_warmer`/`dub_audit`)
- Modify: `src/routes/internal-search-effects.ts` (remove os dois braços)
- Delete: `src/utils/rd-warmer.ts` (395 linhas)
- Delete: `src/utils/dub-audit.ts` (223 linhas)
- Modify: `package.json` (`testFiles`)

- [ ] **Step 1: provar ausência de chamador fora dos efeitos**

```powershell
rg -n "rd-warmer|scheduleWarmer|warmer" src
rg -n "dub-audit|dubAudit|scheduleDubAudit" src
```
Expected: só o braço do efeito em `internal-search-effects.ts` e o próprio
arquivo. Qualquer outro chamador vivo → registre e não apague.

- [ ] **Step 2: escrever o teste que falha**

```rust
#[test]
fn warmer_nao_duplica_run_e_respeita_o_gate() {
    let mut warmer = Warmer::new(StubRd::default(), 1_000);
    assert!(warmer.may_start(1_000));
    warmer.start("run-1", 1_000);
    assert!(!warmer.may_start(1_001), "um por vez");
    warmer.finish(true, 2_000);
    assert!(!warmer.may_start(2_001), "intervalo mínimo respeitado");
}

#[test]
fn dub_audit_e_oportunista_e_limitado() {
    let mut audit = DubAudit::new(3);
    for i in 0..10 {
        audit.offer(format!("hash-{i}"));
    }
    assert_eq!(audit.pending(), 3, "fila limitada, descarta o excedente");
}
```

- [ ] **Step 3: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-server --locked warmer_nao_duplica_run
```
Expected: FAIL.

- [ ] **Step 4: implementar e apagar o TS**

`warmer`: aquecimento do RD com gate (um run por vez + intervalo mínimo),
usando `adom-debrid` direto. `dub_audit`: fila em memória limitada, marcado como
**oportunista** (não vira durável — isso seria mudança de produto). No `late.rs`,
os dois efeitos deixam de ser enviados; o Node não os recebe mais.

`DeleteFile` em `src/utils/rd-warmer.ts`, `src/utils/dub-audit.ts` e nos testes
dedicados; remover de `testFiles`.

- [ ] **Step 5: gate + commit**

```powershell
npm run typecheck
npm run build
npm test
npm run test:complete
npm run lint:lines -- --check
npm run parity:frozen
```

```powershell
cd rust
cargo fmt --all
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
```

```powershell
git add src rust test package.json
```
```powershell
git commit -m "refactor(autofetch): rd-warmer e dub-audit nativos e fim dos efeitos"
```

---

## Leva 8

### T1-C2: captura e uso da fence nos commits do orquestrador

O contador existe (C1), mas ninguém o usa. Esta fatia fecha a 5H no caminho
quente: a busca captura a geração ao começar e **descarta** a lista se a obra foi
invalidada no meio.

**Files:**
- Modify: `rust/crates/adom-search/src/cache.rs:103-116` (`SwrStore` ganha
  `fence_for_key` e `set_fenced`)
- Modify: `rust/crates/adom-search/src/cache.rs` (`MemorySwrStore`: dois
  `Mutex<HashMap<String, u64>>`)
- Modify: `rust/crates/adom-search/src/orchestrator/route.rs:40` (captura)
- Modify: `rust/crates/adom-search/src/orchestrator/refresh.rs:32` (captura)
- Modify: `rust/crates/adom-search/src/orchestrator/input.rs` (`SearchInput.fence`)
- Modify: `rust/crates/adom-search/src/orchestrator/finish.rs:187-193` (commit)
- Modify: `rust/crates/adom-search/src/orchestrator/late.rs:330-335` (commit tardio)
- Modify: `rust/crates/adom-search/src/orchestrator/rescue.rs` (`StaleRescue`)
- Create: `rust/crates/adom-search/tests/fence_commit.rs`

- [ ] **Step 1: escrever os testes que falham**

Em `tests/fence_commit.rs`:

```rust
#[test]
fn commit_com_fence_velha_nao_grava_lista() {
    let store = MemorySwrStore::new();
    let ctx = ctx_for("tt1");
    let fence = store.fence_for_key(&ctx.cache_key);
    store.invalidate_for_obra("tt1").unwrap();
    let wrote = commit_with_fence(&store, &ctx, &list_for(&["aaaa"]), &fence);
    assert!(!wrote);
    assert!(store.get_with_stale(&ctx.cache_key, 0, 1_000).unwrap().is_none());
}

#[test]
fn rescue_nao_serve_lista_de_geracao_anterior() {
    let store = MemorySwrStore::new();
    let ctx = ctx_for("tt1");
    let fence = store.fence_for_key(&ctx.cache_key);
    store.put_stale(&ctx.cache_key, &list_for(&["aaaa"]), 1_000);
    store.invalidate_for_obra("tt1").unwrap();
    assert!(rescue_may_serve(&store, &ctx, &fence, 2_000).is_none());
}

#[test]
fn commit_com_fence_atual_grava_e_serve() {
    let store = MemorySwrStore::new();
    let ctx = ctx_for("tt1");
    let fence = store.fence_for_key(&ctx.cache_key);
    assert!(commit_with_fence(&store, &ctx, &list_for(&["aaaa"]), &fence));
    assert!(store.get_with_stale(&ctx.cache_key, 60, 1_000).unwrap().is_some());
}
```

- [ ] **Step 2: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-search --locked commit_com_fence_velha
```
Expected: FAIL — `fence_for_key` não existe no trait.

- [ ] **Step 3: implementar**

Adicione **dois métodos** ao trait existente (nada mais nele muda):

```rust
fn fence_for_key(&self, key: &str) -> Fence;
fn set_fenced(
    &self,
    key: &str,
    value: &StreamsEntry,
    ttl_seconds: u64,
    now_ms: u64,
    fence: Fence,
) -> bool;
```

- `StreamsSwr` delega para `StreamsStore::fence_for_key`/`set_fenced` (C1).
- `MemorySwrStore` guarda `obra_gen: Mutex<HashMap<String, u64>>` e
  `epoch: AtomicU64`; `invalidate_for_obra` incrementa a chave da obra, o
  `clear_all` incrementa o epoch.
- `SearchInput` ganha `fence: Fence`; `route.rs` e `refresh.rs` capturam
  **antes** de `get_with_stale` (se capturar depois, a invalidação no meio da
  leitura passa despercebida).
- `finish.rs` e `late.rs` chamam `set_fenced`; o retorno `false` **não é erro**:
  registra `stale_commit_dropped` no trace e segue sem servir a lista.
- `StaleRescue` compara a fence da captura com a atual antes de servir; geração
  antiga → não serve.

- [ ] **Step 4: gate + commit**

```powershell
cd rust
cargo fmt --all
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo test -p adom-search --test stream_e2e_parity
cargo test -p adom-search --test search_budget_metadata
cd ..
node scripts/check-rust-lines.mjs
```

```powershell
git add rust/crates/adom-search rust/crates/adom-store
```
```powershell
git commit -m "feat(search): commit com fence de geracao e rescue sem lista velha"
```

### T2-L8: limpeza das pontes e shims do debrid

Depois de L3, L5, L6 e L7, o `src/debrid/` fica só com o que ainda é do Node:
config, registry e o cliente HTTP do que o painel consulta. Esta fatia apaga o
resto — **só o provado**.

**Files:**
- Modify/Delete: `src/debrid/rust-remote.ts` (só as funções sem chamador)
- Delete: `src/debrid/index.ts` (se virar reexport vazio)
- Delete: `src/utils/davail-panel.ts`, `src/utils/debrid-marked.ts` (só se
  existirem e sem chamador)
- Delete: `test/debrid-*.test.ts` dos arquivos apagados
- Modify: `package.json` (`testFiles`)
- Modify: `docs/debrid-al-check-rust.md` (tabela final de donos)

- [ ] **Step 1: levantar o que sobrou**

```powershell
rg --files src\debrid
```
```powershell
rg -n "from '\./rust-remote|rustRemote|resolveLink|accountStatus|debridFiles" src
```
```powershell
rg -n "davail-panel|debrid-marked" src test
```
Expected: cada símbolo aparece em (a) a definição, (b) o painel (`/debrid-status`)
ou (c) a rota. Se um símbolo só aparecer na definição, ele sai nesta fatia.

- [ ] **Step 2: apagar**

Para cada símbolo sem chamador: remover a função, depois o `use`/`import`.
Arquivo que fica só com reexports vazios sai inteiro com `DeleteFile`. Remover
as entradas de `testFiles` **na mesma edição** do `package.json` — esquecer isso
quebra `npm test` e `test:complete`.

- [ ] **Step 3: gate + commit**

```powershell
npm run typecheck
npm run build
npm test
npm run test:complete
npm run lint:lines -- --check
npm run parity:frozen
```

```powershell
git add src test package.json docs/debrid-al-check-rust.md
```
```powershell
git commit -m "refactor(debrid): limpeza das pontes e shims sem consumidor"
```

### T3-L8: varreduras AllDebrid nativas e fim do debrid TS

As quatro varreduras (`sweepDead`, `sweepUndubbed`, reconcile, revalidate) são as
últimas escritoras de estado AllDebrid no Node. O Rust já faz a checagem e a
limpeza da checagem; falta o que é **destrutivo**.

**Files:**
- Modify: `rust/crates/adom-debrid/src/cleanup.rs` (as quatro varreduras)
- Modify: `rust/crates/adom-debrid/src/cleanup_tests.rs` (ou arquivo novo, pela
  catraca)
- Modify: `rust/crates/adom-debrid/src/api_dispatch.rs` (rotas de varredura)
- Delete: `src/debrid/alldebrid-inventory.ts`, `src/debrid/alldebrid-reupload.ts`,
  `src/debrid/alldebrid-delete-gate.ts` e os demais `alldebrid-*.ts` que
  ficarem sem chamador (provar com `rg` no Step 1)
- Delete: `src/utils/protected.ts` (já esvaziado por L6/L7)
- Delete: os `test/alldebrid-*.test.ts` correspondentes
- Modify: `package.json` (`testFiles`)
- Modify: `src/routes/dashboard-actions-debrid.ts` (chama a rota nativa)

- [ ] **Step 1: provar quem sobra**

```powershell
rg --files src | rg "alldebrid"
```
```powershell
rg -n "alldebrid-inventory|alldebrid-reupload|sweepDead|sweepUndubbed|reconcile|protected\.ts" src test
```
Expected: as varreduras apontam para a rota nativa nova; o que restar apontando
para corpo TS é chamador vivo e **fica** (registre no plano).

- [ ] **Step 2: escrever o teste que falha**

```rust
#[test]
fn varredura_destrutiva_exige_kill_switch_ligado() {
    let cfg = SweepConfig { cleanup_on: false, holds_on: true };
    let out = sweep_dead(&stub_inventory(&["aaaa"]), &cfg, 1_000).unwrap();
    assert_eq!(out.deleted, 0);
    assert_eq!(out.skipped_reason.as_deref(), Some("cleanup_off"));
}

#[test]
fn varredura_nao_apaga_hash_protegido_nem_do_usuario() {
    let store = OwnershipStore::open_memory().unwrap();
    store.record_owned("aaaa", "tt1", 1_000).unwrap();
    let cfg = SweepConfig { cleanup_on: true, holds_on: false };
    let out = sweep_dead(&stub_inventory(&["aaaa", "bbbb"]), &cfg, 2_000).unwrap();
    assert_eq!(out.deleted, vec!["bbbb"]);
    assert_eq!(out.kept, vec!["aaaa"]);
}
```

- [ ] **Step 3: rodar e ver falhar**

```powershell
cd rust
cargo test -p adom-debrid --locked varredura_destrutiva_exige
```
Expected: FAIL.

- [ ] **Step 4: implementar e apagar o TS**

Portar as quatro varreduras com as invariantes do contrato: kill-switch
(`DEBRID_AL_CLEANUP`/`DEBRID_AL_HOLDS`) **antes** de qualquer chamada
assíncrona; posse do usuário (`adsub`) e proteção BR (`adprot`) nunca apagadas;
`may_delete` fail-closed sem inventário; `adrm` marcado só nas varreduras de
conteúdo (L7). O painel chama a rota nativa com `{"confirm": true}`.

Apagar os arquivos provados sem chamador e as entradas de `testFiles`.

- [ ] **Step 5: gate + commit**

```powershell
npm run typecheck
npm run build
npm test
npm run test:complete
npm run lint:lines -- --check
```

```powershell
cd rust
cargo fmt --all
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ..
node scripts/check-rust-lines.mjs
```

```powershell
git add src rust test package.json
```
```powershell
git commit -m "refactor(debrid): varreduras alldebrid nativas e fim do debrid TS"
```

---

## Leva 9 — BLOQUEADA (fase 2, metadados)

**Estado:** bloqueada por autorização de janela de medição em produção. Não é
pré-requisito de nada das levas 0–8.

O que existe hoje: o gateway tem fonte de metadados nativa e o Node continua
como **fallback vivo** (`POST /internal/search/meta`). A instrumentação para
medir quantas buscas caem no fallback já está commitada (`696e0d9d`).

Critérios de desbloqueio (todos precisam valer):

1. Janela acordada com o operador, com rollback = imagem anterior já publicada.
2. `fallback_hits / total_searches` medido em produção por ≥ 24 h em **zero**.
3. `FallbackMetaSource` só então sai; o `POST /internal/search/meta` some junto
   com o ramo de fallback no orquestrador.

**Não escreva tarefas executáveis para esta leva até o critério 2 fechar.** Um
plano com código inventado para uma fase que ninguém pode validar é pior que
um plano que declara o bloqueio.

---

## 6. Apagáveis consolidados

Contagem de partida dos agentes de medição (2026-10-24). A contagem **oficial**
de cada fatia é o `git diff --stat` do commit dela — o número abaixo serve para
priorizar, não para fechar conta.

| Origem | Arquivos | Linhas `src/` | Fatia |
|---|---|---|---|
| Chupim (`autofetch*`) | 25 | 4.232 | T3-L4, T3-L5, T3-L6 |
| Ingestão/raspador (`crawl-*`, `internal-crawl-result`) | 11 | 2.136 | T3-L3 |
| Varreduras AllDebrid (`alldebrid-*`, `protected.ts`) | 6 | 1.598 | T2-L6, T2-L7, T3-L8 |
| `rd-warmer.ts` | 1 | 395 | T3-L7 |
| `dub-audit.ts` | 1 | 223 | T3-L7 |
| Pontes/shims sem consumidor | a medir | ≈ 322 | T2-L8 |
| Corpos atrás do 501, `premiumize-files.ts`, `markBankFilterOutcome`, `markFilterResult` | 5 | ≈ 420 | Task 0.3, T2-L3 |

**Total ≈ 8.900 linhas de `src/` + ≈ 6.300 linhas de teste.** Os 25 testes do
Chupim, os 11 do raspador e os 6 do AllDebrid saem **na mesma fatia** do código
que eles cobrem; teste de código apagado que fica na lista reprova
`npm run test:complete`.

---

## 7. Gates por leva

| Leva | TS | Rust | `/stream` | Extra |
|---|---|---|---|---|
| 0 | typecheck, build, test, test:complete, lint:lines | — | — | registrar baseline |
| 1 | typecheck, build, test, test:complete | fmt, clippy, test | parity:frozen | — |
| 2 | typecheck, build, test, test:complete, lint:lines | fmt, clippy, test | parity:frozen | linhas Rust |
| 3 | typecheck, build, test, test:complete, lint:lines | fmt, clippy, test | parity:frozen | linhas Rust |
| 4 | typecheck, build, test, test:complete, lint:lines | fmt, clippy, test | parity:frozen | linhas Rust |
| 5 | typecheck, build, test, test:complete, lint:lines | fmt, clippy, test | parity:frozen + e2e + budget | linhas Rust |
| 6 | typecheck, build, test, test:complete, lint:lines | fmt, clippy, test | parity:frozen | `git status` antes do `-A` |
| 7 | typecheck, build, test, test:complete, lint:lines | fmt, clippy, test | parity:frozen + e2e + budget | contrato AllDebrid |
| 8 | typecheck, build, test, test:complete, lint:lines | fmt, clippy, test | parity:frozen + e2e + budget | contrato AllDebrid |

`npm run build` **limpa `dist/` antes do `tsc`**: build vermelho deixa `dist/`
incompleto e o `npm test` seguinte mede lixo. Se o build falhar, corrija e
rebuilde antes de rodar a suíte.

Harnesses que **não** estão no CI e só rodam quando a fatia mexe em `test/` ou
em harness: `test:stress`, `test:adversarial`, `test:adversarial-m1`,
`test:protector-m1`, `test:challenger-m2`, `test:ranking-challenger`. O
adversarial **muta `dist/`**: mutante novo precisa entrar na lista de
snapshot/restauração, e símbolo movido de arquivo exige realinhar o `testFile`.

---

## 8. Riscos e rollback

| Risco | Onde morde | Mitigação na fatia | Rollback |
|---|---|---|---|
| Duas buscas gravando a mesma obra | `streams` (T1-C2) | fence capturada **antes** da leitura; `set_fenced` descarta | commit anterior |
| Fila do colhedor perdida no restart | `harvest:v1:q` (T1-B1) | `claim` = escrita; lease com retorno à fila | commit anterior |
| Invalidação não propagada | outbox (T1-B2) | dreno no início do tick, antes do teto | commit anterior |
| Escrita antiga sobrescrevendo a nova | `set_fenced` | geração por obra + epoch global | commit anterior |
| Duplo worker do Chupim | T3-L5 → T3-L6 | estado nativo + enfileiramento nativo; drain TS lê a fila nativa | commit anterior |
| Delete da AllDebrid sem inventário | `may_delete` | fail-closed (`complete == false` → read-only) | commit anterior |
| Kill-switch destrutivo esquecido | varreduras (T3-L8) | teste de `cleanup_off` obrigatório | commit anterior |
| L1 do Node com chave de dono Rust | `RUST_OWNED` | namespace entra na lista **antes** do primeiro uso | commit anterior |
| `testFiles` dessincronizado | `package.json` | teste apagado sai da lista na mesma edição | commit anterior |
| Catraca de 400 estourando | arquivo grande | código novo nasce em arquivo novo | commit anterior |

Regra única de rollback: **commit/imagem anterior**. Não existe knob de env
para desfazer dono de estado; um `RUST_OWNER=node` recriaria dois escritores e é
proibido (mesma decisão das fases 5 e 6).

---

## 9. Definição de pronto

A migração está fechada quando **todos** valem:

- [ ] `/stream` responde só pelo gateway Rust; o Node não monta lista.
- [ ] `RUST_OWNED` cobre `idx`, `streams`, `raw`, `davail`, `mag`, `mag_meta`,
  `adsub`, `adrm`, `adprot`, `autofetch` e `harvest`; nenhum desses namespaces
  tem escritor TS.
- [ ] `magnets.db` tem um escritor (Rust) e `magnet_work` também.
- [ ] O colhedor sobrevive a restart sem perder entrada, sem reaplicar escrita e
  sem deixar invalidação pendente (B1+B2+B3+C1+C2).
- [ ] O raspador grava direto do sidecar; `POST /internal/crawl-result` não
  existe.
- [ ] O Chupim roda em thread nativa; `src/**/autofetch*.ts` não existe.
- [ ] `rd-warmer` e `dub-audit` são nativos; nenhum efeito de fundo atravessa
  HTTP até o Node.
- [ ] A fase 3 não tem corpo TS alcançável atrás de 501.
- [ ] `npm run typecheck`, `build`, `test`, `test:complete`, `lint:lines --
  --check` verdes; `cargo clippy -D warnings` e `cargo test --workspace` verdes.
- [ ] `npm run parity:frozen` e os dois testes de contrato do `/stream` verdes.
- [ ] Nenhum arquivo `.ts`/`.rs` acima de 400 linhas.
- [ ] `npm run test:complete` sem órfão: todo `test/**/*.test.ts` na lista e
  toda entrada da lista apontando para arquivo existente.

Fase 2 (metadados) **não** entra nesta lista: é a Leva 9 e depende de janela em
produção.

---

## 10. Como despachar os três agentes

Uma leva = três agentes em paralelo, um por trilha. Cada agente recebe:

1. O caminho deste documento e **a fatia exata** (ex.: `T2-L5`), não a leva
   inteira.
2. A proibição explícita de tocar arquivo de outra trilha.
3. Os gates da §7 e a ordem: teste falha → implementa → gate → commit **sem
   push**.
4. A ordem de apagar o TS (Step de `DeleteFile` + `testFiles`) como parte da
   mesma fatia, sem adiar.

Ordem dentro do turno:

```
1. git status --short --branch        (baseline do working tree)
2. Agente T1 + Agente T2 + Agente T3  (paralelo, fatias da mesma leva)
3. Revisão entre levas                (git log -3 --stat; gates rerodados no HEAD)
4. Leva seguinte
```

Se duas trilhas colidirem em um arquivo, **pare a leva**: a fatia seguinte da
trilha que colidiu vira serial e este documento é corrigido antes de continuar.
Nenhum agente faz `git add -A` fora da T3-L6 (e lá só depois do `git status` do
Step 1).

---

## Baseline medida (Leva 0)

> Preencher na execução da Task 0.1, Step 3. Números de partida abaixo são a
> última medição declarada no repo (2026-10-24) e **não** substituem a medição
> local.

| Gate | Última medição declarada | Medido na Leva 0 (2026-10-24) | Medido na Leva 2 (2026-10-24) |
|---|---|---|---|
| `npm run typecheck` | — | exit 0 nos 3 programas | exit 0 nos 3 programas |
| `npm run build` | — | `dist/` gerado + assets copiados | idem |
| `npm test` | 2.495 pass / 0 fail | **2.484 pass / 0 fail** | **2.485 pass / 1 skip / 0 fail (2.486)** |
| `npm run test:complete` | todos os arquivos listados | **279 arquivos, 2 harnesses** | **279 arquivos, 2 harnesses** |
| `npm run lint:lines -- --check` | 0 acima do teto | **655 arquivos, 0 excedentes** | **655 arquivos, 0 excedentes** |
| `node scripts/check-rust-lines.mjs` | baseline 0 | **873 fontes, baseline 0** | **888 fontes, baseline 0** |
| `cargo test --workspace --locked` | 0 falhas | **146 resultados, 0 falhas** | **146 resultados, 0 falhas** |
| `cargo clippy -D warnings` | — | exit 0 | exit 0 (workspace, all-targets) |
