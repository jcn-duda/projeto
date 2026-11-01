# Corte final da família TS do banco VIVO (`magnet-bank*`)

> **Plano registrado para execução futura — NÃO executado.** O dono do
> `magnets.db` já é o gateway (F3.3) e a pré-condição POUSOU em 2026-11-01
> (rotas `GET /magnet-bank/status|search` na admin + painel lendo pela ponte):
> o que falta é apagar o resto da família TS. Âncoras confirmadas por leitura
> direta e `rg` em 2026-11-01, branch `rust`; onde o texto marca "fatia em
> curso", é o estado atual do working tree. Números de linha deslocam com
> edição — confira o SÍMBOLO, não só a linha.
>
> Este plano não apaga nada sozinho: cada fase abaixo é um corte com apagão
> verificado, commit separado e gates verdes.

---

## 1. Regra do apagão (vale para TODAS as fases)

Um módulo da família só é apagado com **ZERO chamador de produção** — código em
`src/` fora da própria família. **Teste próprio não é permissão**: teste que
exercita o módulo sai (ou migra para o oráculo) junto com ele, e o nome precisa
sair da lista explícita do `package.json` (`npm run test:complete` exige a
lista coerente com `test/**/*.test.ts`).

- Oráculo congelado (`test/helpers/pipeline-oracle/`) é RÉGUA, não chamador
  descartável: os símbolos que ele usa migram PARA o oráculo antes do corte
  (precedentes: a mescla do import, `pipeline-oracle/magnet-bank-import.ts`,
  e as escritas do magnetdb, `pipeline-oracle/play/magnetdb-writes.ts`).
- Pré-condição mecânica de cada apagão, verificável por comando:

  ```bash
  rg -n "magnet-bank-(search|rows|memory|merge|read|schema)" src/ --glob '!src/utils/magnet-bank-*.ts'
  ```

  vazio = zero chamador de produção do módulo a cortar.

## 2. Estado de partida (verificado 2026-11-01, `rust`)

O gateway é o único escritor do acervo: captura nativa no fim do tail da busca
(`rust/crates/adom-search/src/orchestrator/late.rs:241-243` → `capture_items`,
contrato em `orchestrator/index_source.rs:118-133`; o efeito `magnet_capture`
do Node não existe mais, `index_source.rs:10-11`), regras em
`adom-store/src/magnet_bank_capture.rs`, SQL em `magnet_bank_write.rs`/
`magnet_bank_upsert.rs`, índices `magnet_last_seen`/`magnet_source_last_seen`
em `magnet_bank.rs:86-87`. Leitura da busca nativa (`MagnetBankSource`,
`adom-store/src/index_impl.rs:106-178`) alimenta instantânea/fallback
(`orchestrator/fallback.rs:127-158`, config `orchestrator/config.rs:105-165`).
Import/backfill do gateway: `POST /magnet-bank/import`
(`adom-server/src/magnet_bank_admin.rs:62-64`, backfill no boot :166-180),
ponte Node `src/utils/magnet-bank-native.ts:43-71` (`importNativeBank`), rotas
`src/routes/magnet-bank-transfer.ts` montadas em `src/routes/register.ts:56-57`.

**Pré-condição POUSADA (2026-11-01):** `GET /magnet-bank/status` e
`GET /magnet-bank/search` montadas na admin do gateway
(`magnet_bank_admin.rs`, mesmas guardas do import) e as ações
`magnet-bank-summary`/`magnet-bank-search`
(`src/routes/dashboard-actions-magnet.ts`) lendo pela ponte
`magnet-bank-native.ts` com 503 `magnet-bank-admin` quando ela não responde.
A busca do painel não tem mais chamador de produção do
`magnet-bank-search.ts` — a ação pede à admin.

## 3. Inventário da família e destino

Consumidores verificados por `rg`/leitura em 2026-11-01. Formato:
`arquivo:linha` do import/uso.

### Cortam (candidatos)

**`src/utils/magnet-bank-search.ts`** — busca read-only do painel. Sai
PRIMEIRO (a fatia em curso remove o único chamador).

- Produção: `src/routes/dashboard-actions-magnet.ts:19` (uso `searchBank` :130).
- Teste: `test/magnet-bank-search.test.ts:7`.
- Após a fatia em curso, a ação `magnet-bank-search` pede à admin — zero
  chamador de produção.

**`src/utils/magnet-bank-read.ts`** — helpers síncronos de leitura.

- Produção: só a fachada `src/utils/magnet-bank.ts:21,25`. Sai com a raiz.

**`src/utils/magnet-bank-merge.ts`** — regras puras de merge/extração.

- Produção: fachada `src/utils/magnet-bank.ts:16-18,23` e
  `src/utils/magnet-bank-read.ts:12` (`workTuple`).
- Testes/oráculo: `test/magnet-bank-backfill.test.ts:9`,
  `test/cam-label-indexonly.test.ts:8`,
  `test/helpers/pipeline-oracle/magnet-bank-import.ts:22` (`isRicherUri`),
  `test/helpers/pipeline-oracle/magnet-bank-backfill.ts:19`
  (`classifiedDubbed`) — estes dois migram para o oráculo antes do corte.

**`src/utils/magnet-bank-rows.ts`** — engine SQL (`node:sqlite`) e abertura.

- Produção: fachada `src/utils/magnet-bank.ts:13-14,24`;
  `src/utils/magnet-bank-read.ts:10-11`; tipos em
  `magnet-bank-memory.ts:16`, `magnet-bank-merge.ts:20`,
  `magnet-bank-transfer.ts:18`.
- Testes: `test/magnet-bank.test.ts:15`,
  `test/magnet-bank-transfer.test.ts:15-16`,
  `test/magnet-bank-memory-lru.test.ts:20`; tipo no oráculo
  `test/helpers/pipeline-oracle/magnet-bank-import.ts:23`.

**`src/utils/magnet-bank-memory.ts`** — engine de memória (LRU).

- Produção: só `src/utils/magnet-bank-rows.ts:35` (`memoryEngine`). Sai com
  `-rows`.

**`src/utils/magnet-bank-schema.ts`** — tipos/codec das linhas.

- Produção: `src/utils/magnet-bank-rows.ts:33-37`,
  `src/utils/magnet-bank-memory.ts:17`. Sai com `-rows`.
- Teste: `test/magnet-bank-memory-lru.test.ts:21` (tipo).

**`src/utils/magnet-bank.ts`** — FACHADA (fila de captura fixture, leitura
reexportada, `status()` memoizado, ciclo de vida). ÚLTIMA a sair: é a raiz de
quase tudo. Consumidores de produção HOJE (cada um é uma pré-condição):

- `src/addon.ts:14` — ciclo de vida: `openIfEnabled()` :36, `close()` :117.
- `src/routes/services.ts:17` + tipo em `src/routes/types.ts:16` (wiring
  `services.magnetBank`).
- `src/debrid/common.ts:4` — `magnetBank.lookup(infoHash)?.uri` :29 (URI rica
  do play).
- `src/utils/magnetdb-inspect.ts:20` — `magnetBank.lookup(item.hash)?.uri`
  :68 (inventário mag do painel).
- `src/utils/release-index-media.ts:2-3` — `readEngine` alimenta
  `bankRowsForMediaSource` (:11), consumido por `src/utils/release-index.ts:23`
  e :58 (`bankRowsNapi(bankRowsForMediaSource(...))` no `record` napi do
  índice).
- `src/routes/dashboard-actions-magnet.ts:116` e
  `src/routes/dashboard-status-blocks.ts:303` — `services.magnetBank.status()`
  (a ação vira leitura da admin na fatia em curso; o bloco do status é outro
  ponto a migrar).
- `src/routes/magnet-bank-transfer.ts:22` — `flushBarrier`/
  `invalidateStatusCache`/`readEngine` (export :48/:55, import :86/:101).
- Testes (11): `test/magnet-bank.test.ts:14`, `magnet-bank-search.test.ts:6`,
  `magnet-bank-status.test.ts:9`, `magnet-for-play.test.ts:12`,
  `magnet-bank-transfer.test.ts:14`, `magnet-bank-lifecycle.test.ts:13`,
  `dashboard-actions-magnet.test.ts:12`, `dashboard-magnet-bank.test.ts:18`,
  `magnet-bank-memory-lru.test.ts:18`, `release-index-tracker.test.ts:10`,
  `test/helpers/magnet-bank-fixture.ts:8`.

### Ficam (fora deste corte)

**`src/utils/magnet-bank-native.ts`** — ponte da admin do gateway (import
:43-71; as leituras `GET /magnet-bank/status`/`/search` da fatia em curso
entram aqui). Consumidor: `src/routes/magnet-bank-transfer.ts:24`;
`test/magnet-bank-native.test.ts:7`.

**`src/utils/magnet-bank-transfer.ts`** e **`src/routes/magnet-bank-transfer.ts`**
— export NDJSON é I/O do Node hoje (`exportLines` :59 lê a engine local; rota
montada em `src/routes/register.ts:56-57`). FICAM enquanto o export for I/O do
Node — e com eles a fachada (a rota importa `readEngine`/`flushBarrier`
da fachada, :22). Consumidores extras: `test/magnet-bank-transfer.test.ts:20`,
`test/helpers/pipeline-oracle/magnet-bank-import.ts:21` (constantes), e a
rota por `src/routes/register.ts:4`.

**`src/utils/magnet-bank-lie.ts`** — usa a ponte mag nativa
(`magnetState().liveLies`, :25) e tende a ficar. Único chamador é o caminho de
captura da fachada (`magnet-bank.ts:9`, uso :210 — fixture desde a T2-L4);
reavaliar no corte da raiz: sai com ela, salvo decisão de levar a régua do
`lie` global para outro dono.

## 4. Ordem sugerida (uma fase = um commit)

1. **Fase 0 — pré-condição (fatia em curso):** `GET /magnet-bank/status|search`
   na admin + leituras na `magnet-bank-native.ts` + ações do painel lendo pela
   admin com 503. Sem ela, nada abaixo executa.
2. **Fase 1 — `magnet-bank-search.ts`:** apagar módulo, o import em
   `dashboard-actions-magnet.ts:19` e `test/magnet-bank-search.test.ts` (tirar
   da lista do `package.json`). Apagão: `rg "magnet-bank-search" src/` só
   dentro da família.
3. **Fase 2 — migrar as leituras residuais de produção** (inventário em
   andamento decide a ponte): `debrid/common.ts:29` (play),
   `magnetdb-inspect.ts:68` (inventário), `release-index-media.ts` via
   `release-index.ts:58` (record napi do índice), `dashboard-status-blocks.ts:303`
   (bloco de status do painel) e o ciclo de vida `addon.ts:36,117`. Candidato
   natural: leitura read-only napi do `magnets.db` (padrão `RawStore` napi /
   `MagnetBankStore` do `adom-store`) ou via admin — decisão da fatia de
   inventário, não deste plano. Esta fase NÃO apaga nada.
4. **Fase 3 — decisão do export:** enquanto o export for I/O do Node, a rota +
   `magnet-bank-transfer.ts` (utils) ficam e a fachada fica com eles. O corte
   da raiz só executa quando o export mudar de dono (streaming pela admin do
   gateway ou leitura pela ponte napi da Fase 2).
5. **Fase 4 — corte da raiz, numa vez só:** réguas do `-merge` usadas por
   oráculo/testes migram para `test/helpers/pipeline-oracle/`; depois apagar
   JUNTOS `magnet-bank.ts` + `-read` + `-merge` + `-rows` + `-memory` +
   `-schema` (+ `-lie`, se decidido) e os testes da lista. Apagão final:
   `rg -n "magnet-bank" src/` só mostra `-native.ts`, `-transfer.ts` e a rota.

Rollback de cada fase: commit anterior (padrão do projeto; não há flag de
fatia).

## 5. Teste de catraca sugerido

- **Gates por fase:** `npm run typecheck` (zero), `npm test`, e o comando de
  apagão da §1 antes de cada delete. `npm run lint:lines` não regride (só
  apaga); os goldens `magnet-bank-instant`/`source` (napi, conferidos no
  `../adom-esm`) não são afetados.
- **Catraca de ausência:** um `test/magnet-bank-cut.test.ts` novo, na lista do
  `package.json`, que assera `!fs.existsSync` para cada arquivo já cortado e
  cresce a cada fase — reintrodução silenciosa quebra o CI.
- **Prova de comportamento preservado:** antes da Fase 4, conferir que a leitura
  napi/admin devolve o MESMO shape consumido por `debrid/common.ts:29` (URI)
  e `release-index.ts:58` (`BankRow` para o `record` napi) — o oráculo
  `pipeline-oracle/magnet-bank-import.ts` continua rodando contra a régua
  movida.
