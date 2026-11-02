# davail dono único — a fatia que sobrou é documental

> Plano registrado em 2026-11-01 (branch `rust` @ `8a282584`), auditoria
> somente-leitura do Fiandeiro. **A pendência declarada estava desatualizada:
> davail JÁ é RUST_OWNED no código.** O que falta é a declaração e a limpeza
> dos comentários que dizem o contrário.

## 0. Estado medido (o código já é o alvo)

- `davail` está em `RUST_OWNED` (`cache-keys.ts:247`) e em
  `RUST_OWNED_PREFIXES` (`:338`), exigido pela catraca
  (`test/cache-keys-debrid-owned.test.ts:50,56`). O L1 do Node já o trata
  como intocável (`isRustOwned`/`isForeignKey`).
- **Único escritor de produção é o play nativo**:
  `play_effects_native_writes.rs:56-68` (`note_unavailable` →
  `davail.put(..., false, ttl, ...)`; gate `ttl<=0`; TTL lido de
  `DEBRID_AVAIL_NEG_TTL`, default 120 s, `play_effects_native.rs:82,147`).
  Grava SÓ o negativo.
- **Escritor positivo é órfão por desenho**: a evidência positiva da checagem
  nativa vai para `mag:alive` (`magnet_alive.rs:130-153`) e o veredito do
  check da busca vive em memo RAM (`adom-search/debrid_seam.rs:68,105-151`).
  davail=1 só existe no oráculo (`pipeline-oracle/play/davail.ts:26,57`).
  Não há `avail_pos_ttl` no Rust.
- **Leitores**: `account_catalog_facts.rs:145-167` (leitor principal do
  gateway: ledger RD → davail.get → mag.state Alive) e
  `src/utils/br-coverage.ts:105-128` (sampler F3 do Node, conta do operador,
  fora do caminho de busca). **O build de busca NÃO lê davail do disco**
  (0 matches de `DavailStore` em adom-search).
- **Manutenção**: sweep pelo relógio de 10 min (`magnetdb-persist.ts:215-225`);
  clear do dashboard pela ponte (`cache.ts:326,343` via
  `dashboard-actions-cache.ts:54`); NÃO existe rota de clear na admin 8711
  para davail (e não vale criar — ver mag).
- `cache-check.ts`/`live-check.ts` **não mudam** — davail só aparece em
  comentário neles. `availPosTtl/availNegTtl` de `config/debrid.ts:93,96` não
  têm consumidor de produção (só o oráculo; o Rust lê o env direto).

## 1. A fatia documental (arquivos que MUDAM: só texto)

1. **`AGENTS.md`** (§Cache e índice) — acrescentar davail à declaração de
   dono único, no padrão de `raw`/`harvest`/`idx`: "davail:v1 é do Rust
   (`DavailStore`, adom-index); o único escritor de produção é o play nativo
   (`note_unavailable`, negativo, `DEBRID_AVAIL_NEG_TTL`); o Node não grava
   davail no L1/SQLite — lê pela ponte para o diagnóstico F3, mantém o
   relógio de sweep e faz o clear do dashboard via ponte". Registrar que o
   positivo de produção é `mag:alive`, não davail (mata a pergunta "cadê o
   put(true)?").
2. **Comentários Rust stale** (12 pontos): `davail_state.rs:13-16` (doc
   falsa: diz que o boot do Node apaga `expires_at=0` — falso hoje,
   `cache-db.ts:41-46`), `store_tests.rs:52`, `account.rs:24-25`,
   `orchestrator/account.rs:3-4`, `frozen_gate/debrid.rs:46`,
   `alldebrid.rs:112,116`, `api_alldebrid.rs:5`, `alldebrid_play_tests.rs:94,187`,
   `finalize_play.rs:9`. O TESTE `store_tests.rs:57`
   (`davail_no_arquivo_do_node_e_somente_leitura`) permanece válido — só o
   comentário sai.
3. **`docs/AGENTS-DETALHADO.md:2037-2063`** — reescrever a seção da Fase 3:
   apontar `DavailStore`/ponte; remover `servedHashes` e
   `debrid-pipeline-steps.ts` (alive-as-cache hoje vive só no oráculo,
   `pipeline-oracle/debrid-instant-steps.ts:153-156`); manter a regra irmã
   do rdc (`:2070-2075`) e o aviso "não consolide davail × rdc".
4. **`src/utils/cache-quotas.ts:62-64`** — comentário atualizado (a cota
   1000 hoje é só teto do sweep; valor e soma global não mudam).
5. Opcional defensivo: guard/try-catch na chamada da ponte no callback do
   relógio (`magnetdb-persist.ts:218`) e no `nativeClears.davail`
   (`cache.ts:343`) — `davailState()` lança se o napi não expõe a classe
   (`debrid-state-native.ts:318-319`) e exceção em callback de `setInterval`
   é uncaught.

## 2. Riscos

| Sev. | Risco | Dica |
|---|---|---|
| MÉDIA | Docs Rust dizem "dono é o Node" — um dev pode reintroduzir escrita TS/fallback | Limpar os 12 pontos no commit documental |
| MÉDIA | Golden `ck-versions`/`ck-magmeta` congela `["davail","v1"]` | NÃO tocar `cache-keys.ts`; nenhum bump; regeneração só no esm |
| BAIXA | SWR `debridKnown`/cachedOnly | davail não entra no build de busca — nada a fazer |
| BAIXA | Ponte falha → exceção em timer/clear | Guards opcionais do item 5 |
| BAIXA | Fail-open do F3 (`br-coverage.ts:174`) | try/catch no laço do sampler degradando a release a `'unknown'` |

## 3. Critério de pronto e validação

1. `rg -n "davail"` em comentários/docs sem afirmação de posse do Node.
2. `AGENTS.md` §Cache declara davail com dono único.
3. `git diff` limitado a AGENTS.md, docs, comentários e guards — nenhum
   arquivo funcional muda semântica.
4. Catraca `cache-keys-debrid-owned` verde SEM edição (já exige davail).
5. Goldens `ck-versions`/`ck-magmeta` byte-idênticos.
6. TS: typecheck + suíte amarrada (cache-keys-debrid-owned, cache-namespaces,
   magnet-db, br-coverage, dashboard-actions, debrid-rust-remote,
   alldebrid-alive-cache). Rust: `cargo test -p adom-index -p adom-debrid -p
   adom-server -p adom-search` (doc-comments malformados quebram compilação).
   validate-docker no fechamento.

## 4. Ordem

**Depois do fechamento do mag** (a declaração do davail referencia o mag
como evidência positiva de produção — `account_catalog_facts.rs:161-167` lê
davail E depois mag; se o mag mudar depois, a declaração envelhece). Se os
dois saírem juntos, consolidar num único commit por arquivo. Nunca
intercalar.
