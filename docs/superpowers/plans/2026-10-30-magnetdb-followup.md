# Follow-up do magnetdb — régua da metade de escrita aguardando a leva de debrid

> Plano registrado em 2026-10-30 (branch `rust` @ `dae6f744`). Separa o que
> JÁ foi feito hoje do que FALTA, com a pré-condição explícita de execução.
> Âncoras verificadas por leitura direta na data; confira o SÍMBOLO, não só a
> linha.

---

## 1. O que já foi feito hoje (`dae6f744`)

- **Mescla do import congelada no oráculo**:
  `test/helpers/pipeline-oracle/magnet-bank-import.ts` (249 linhas). O
  cabeçalho do próprio oráculo registra a origem: saiu do
  `src/utils/magnet-bank-transfer.ts`; quem mescla/grava o acervo hoje é o
  gateway (`POST /magnet-bank/import` na admin 8711,
  `adom-store::magnet_bank_import`) — a rota Node só spoola o arquivo e
  repassa. Ficam VIVOS no módulo do `src/`: o lado EXPORT (`exportLines`,
  `groupByHash`) e o formato do arquivo NDJSON
  (`TRANSFER_FORMAT`/`TRANSFER_VERSION`, importados do módulo vivo).
- **A régua dos 4 helpers do oráculo agora fala com a ponte** `magnetState()`
  (de `src/utils/debrid-state-native.ts`) — sem L1 do Node no meio.
- **`src/utils/magnet-bank-transfer.ts`: 287 → 60 linhas.**
- Commit: `dae6f744`
  ("refactor(magnets): mescla do import congelada no oraculo e regua dos
  helpers passa pela ponte").

## 2. O que FALTA — com pré-condição explícita

**Só execute quando a sessão de debrid pousar as remoções em:**

- `src/debrid/cache-check.ts` — `noteAvailable` (definida na :110, export na
  :148);
- `src/debrid/rust-resolve-magnet.ts` — `applyMagnetEffect` (definida na :11;
  pontos de escrita da régua por volta das :19/:23);
- `src/debrid/rust-resolve-apply.ts`.

Enquanto esses chamadores existirem, as funções régua abaixo são CÓDIGO VIVO:
apagá-las quebra a escrita de evidência (`alive`/`bad`/`lie`) do banco de
magnets.

Quando a pré-condição pousar:

1. **Apagar de `src/utils/magnetdb.ts` as funções régua** (hoje em 384
   linhas; bloco de export na :379-383):
   - `markAlive` (:84)
   - `markBad` (:147)
   - `markLie` (:236)
   - `renewAlive` (:291)
   - `forgetBad` (:191)
   - `isAlive` (:128)
   - `isBad` (:176)
   - `isLie` (:252)
   - `peekAlive` (:266)
2. **Migrar os testes de régua** para `setDebridStateForTest`
   (`src/utils/debrid-state-native.ts:338`; exemplo vivo em
   `test/debrid-state-native.test.ts:37`) ou para cópia congelada no oráculo
   — os candidatos são os `test/magnet-db*.test.ts` que importam as funções
   régua (conferir import a import antes de mover).
3. **O que SOBRA no arquivo**: `peekBad`/`peekLie` (leituras sem efeito),
   `forgetBadOf` (limpeza do painel, por adapter) e `status()` (diagnóstico),
   mais os re-exports de `magnetdb-persist.ts` — **~214 linhas finais**.

## 3. Riscos registrados

1. **O painel ainda lista `mag:`** — não cortar nada antes de portar as
   telas:
   - `src/routes/dashboard-status-blocks.ts:295`:
     `out.magnetdb = services.magnetdb.status()` (bloco `magnetdb` da aba);
   - `dashboard-actions-magnet.ts` (ações do painel sobre o banco);
   - `src/utils/cache.ts:342-343`: o `clearNamespace` do Node tem branches
     `wanted === 'davail' ? davailState().clear()` e
     `wanted === 'mag' ? magnetState().clear()`.
2. **`ck-magmeta` no corpus-cache-keys prende a chave `mag_meta`**: o caso
   vive em `scripts/golden/corpus-cache-keys.json:16` +
   `scripts/golden/registry-cache-keys.mjs:62` (op `magmeta`) e no golden
   congelado `rust/golden/cache-keys.jsonl:3`
   (`mag_meta:v1:counts`; forma em `src/utils/cache-keys.ts:77`). Mexer em
   cache-keys sem regenerar/revalidar o golden quebra o corpus — na dúvida,
   não mexe.
3. **Goldens `magnet-bank-*` são COMPARTILHADOS com `E:/adom-esm`** — o
   `.jsonl` é o mesmo dos dois lados. **Nunca regenerar daqui**; regenerar é
   coisa do worktree do ESM (`cd ../adom-esm && npm run golden:<x> -- --force`).
4. **Drift de doc `AGENTS.md:210-211`** (sweepNativeNamespaces não chama
   kvPruneExpired): **reconciliado na doc em 2026-10-30** — o relógio de
   10 min do `magnetdb-persist` dispara `sweepNativeNamespaces`, que é
   varredura NATIVA (`magnetState().sweep`/`davailState().sweep`), e o
   `kvPruneExpired` da ponte (`src/utils/native-kv.ts:97`) ficou sem chamador
   no processo (só o teste o exercita). Pendência de CÓDIGO registrada aqui:
   dar dono ou remover o `kvPruneExpired` morto na leva que mexer em
   `native-kv.ts`.

## 4. Executado em 2026-10-30

- **Pré-condição cumprida**: o glue de play saiu de `src/debrid/` para
  `test/helpers/pipeline-oracle/play/`. Conferido por grep: nenhum arquivo de
  `src/` chama `markAlive`/`markBad`/`markLie`/`renewAlive`/`forgetBad`/
  `isAlive`/`isBad`/`isLie`/`peekAlive` do magnetdb (só o próprio
  `magnetdb.ts`; `debrid-state-native.ts` tem métodos homônimos na ponte, que
  não são estas funções).
- **Movido para o oráculo**
  `test/helpers/pipeline-oracle/play/magnetdb-writes.ts`: `markAlive`,
  `isAlive`, `markBad`, `isBad`, `forgetBad`, `markLie`, `isLie`, `peekAlive`
  e `renewAlive`, com os corpos copiados sem alteração.
- **Importadores migrados**: 12 testes em `test/` e os dois glues do oráculo
  (`play/davail.ts`, `play/rust-resolve-magnet.ts`) passaram a chamar
  `magnetdbWrites.*`. Os dois testes que montam scripts-filhos como string
  (`magnet-db-persistence`, `magnet-db-empirical-challenge`) carregam o módulo
  novo pela URL absoluta (`MAGNETDB_WRITES_URL`).
- **`src/utils/magnetdb.ts`: 384 -> 209 linhas.** Ficou com `peekBad`,
  `peekLie`, `forgetBadOf`, `status`, os tipos e os re-exports de
  `magnetdb-persist.ts`. `peekAlive` foi para o oráculo (era leitura de
  decisão, não de painel), e não ficou no `src/`.
