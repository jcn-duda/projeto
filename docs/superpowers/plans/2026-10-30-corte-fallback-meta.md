# Corte do fallback de metadados — a fatia TS→Rust dos ~2.900 linhas

> Plano registrado para execução futura. Validado por recon em 2026-10-30
> (branch `rust`). Cada âncora foi confirmada por leitura direta na data;
> números de linha deslocam com edição — confira o SÍMBOLO antes de cortar,
> não só a linha. Nada aqui é estimativa.
>
> Este plano NÃO executa nada: é o registro do caminho seguro para a sessão
> que vier executar. A doc nunca mente sobre o estado — enquanto as fatias
> não pousarem, o fallback de metadados do Node segue VIVO.

---

## 1. Pré-condição dura: janela ≥ 48h dos contadores `meta.*`

**Não executa a Fatia 1 sem a janela.** A decisão de cortar o fallback é
baseada em quanto o Node realmente responde de fallback em produção.

- **Baseline aberto em**: `2026-10-30T06:04:51Z`, commit `d1193e5b`.
- **ATENÇÃO**: os contadores `meta.*` são do PROCESSO do gateway — a cada
  **recriação de container eles ZERAM**. Se o container foi recriado, a
  janela de 48h recomeça do zero (o relógio é do container, não do calendário).
- **Regra de coleta** (rodar na VPS; o curl é local, a porta não é exposta):

  ```bash
  ssh jcn@200.23.180.38 "curl -s http://127.0.0.1:7000/metrics | grep 'meta\.'"
  ```

- O que a janela precisa mostrar: a fração real de `meta.resolve.total` que
  cai no Node (`meta.fallback.*` — título real, vazio, erro) contra o
  primário nativo (`meta.native.ok/empty/error`). É a medida do pior caso que
  a Fatia 1 remove.
- Onde os nomes nascem: `rust/crates/adom-search/src/orchestrator/meta_metrics.rs`
  (`RESOLVE_TOTAL = "meta.resolve.total"`, `NATIVE_OK = "meta.native.ok"`, …).
  A doc do arquivo diz em quem a régua mede hoje — ver §Fatia 2.

## 2. Estado de partida (verificado 2026-10-30, `rust` @ `dae6f744`)

```text
rust/crates/adom-server/src/stream.rs:137
  → let meta = stream_meta::meta_source(Some(routes.clone() as Arc<dyn InternalRoutes>));
    (comentário C5 acima da linha: "fonte nativa de metadados, com o Node de
    FALLBACK (rede fora/título não resolvido)")
rust/crates/adom-server/src/stream.rs:162-169
  → ramo `None` JÁ EXISTE como modelo do "sem fallback":
    "sem rotas Node — tail indisponível; metadados só nativos" + meta_source(None)
rust/crates/adom-search/src/orchestrator/meta_native.rs:107
  → pub struct FallbackMetaSource { primary, fallback }  (região ~:101-200)
rust/crates/adom-search/src/orchestrator/meta_metrics.rs:20
  → RESOLVE_TOTAL "meta.resolve.total" — doc do arquivo: mede por chamada de
    `FallbackMetaSource::resolve` (os contadores só existem no fallback hoje)
src/routes/register.ts:66
  → registerInternalSearch(app, services)   (o recon citou :68; deslocou)
src/routes/internal-search.ts:115
  → export function registerInternalSearch — monta as rotas de leitura (meta)
    e chama registerInternalSearchEffects na :134
src/routes/internal-search.ts:31
  → re-export de isLoopbackAddress (definida em internal-search-shared.ts:19)
test/internal-search-routes.test.ts:17
  → único consumidor do re-export (morre junto)
```

## 3. As 5 fatias, na ordem segura

Cada fatia é commit separado, gates verdes, e o estado do anterior é o
rollback do seguinte.

### Fatia 1 — Rust DESLIGA o fallback (não apaga nada)

- `rust/crates/adom-server/src/stream.rs:137`: montar SÓ o nativo — trocar
  `meta_source(Some(routes.clone() as Arc<dyn InternalRoutes>))` por
  `meta_source(None)`. O ramo `None` da :162-169 é o modelo vivo disso.
- **INTACTOS**: `NodeRoutes::from_env` e o tail/efeitos. O MESMO `NodeRoutes`
  serve os efeitos (`/internal/search/effects`) — o corte é SÓ no argumento
  de `meta_source`. Não derrube o tail junto: **é o risco nº 1 do plano**.
- Comportamento sem fallback já existe HOJE como pior caso, nada novo a
  inventar: `meta_load.rs:44-62` deriva metadados do próprio id quando não há
  título, e `respond.rs` responde `NOTICE_SEARCHING`.
- Verificação da fatia: boot do gateway sem erro de fonte; `/stream` devolve
  título nativo ou `NOTICE_SEARCHING` quando o nativo falha; efeitos seguem
  fluindo para o Node; `meta.*` continuam publicados (até a Fatia 2).
- Rollback: reverter a linha (o fallback volta a ser passado).

### Fatia 2 — Rust APAGA o fallback

- Apagar `FallbackMetaSource`
  (`rust/crates/adom-search/src/orchestrator/meta_native.rs:101-200`,
  struct na :107) e os testes dele.
- **MIGRAR os contadores** `meta.resolve.total`/`meta.native.*` para o
  `NativeMetaSource` no MESMO commit: hoje eles são emitidos só dentro do
  `FallbackMetaSource::resolve` (doc de `meta_metrics.rs:3-6`). Sem a
  migração, o `/metrics` fica CEGO exatamente no commit que mais precisa de
  números (a régua passa a ser o nativo sozinho).
- `FALLBACK_*` sai de `meta_metrics.rs` (constantes e doc).
- O método `meta()` de `internal_client.rs` MORRE — só servia ao fallback.
- **FICAM**: `NodeMetaSource`/`meta_from_response` — o replay do frozen gate
  passa por eles.
- Verificação: `/metrics` publica `meta.*` com o novo dono; `cargo test`;
  typecheck.

### Fatia 3 — Node: a rota

- `src/routes/register.ts` (:66 hoje; o recon citou :68): trocar
  `registerInternalSearch(app, services)` → `registerInternalSearchEffects(...)`.
- Apagar JUNTOS: `src/routes/internal-search.ts` +
  `test/internal-search-routes.test.ts`.
- Ponto de conferência antes de apagar: `internal-search.ts:31` re-exporta
  `isLoopbackAddress` (definida em `internal-search-shared.ts:19`); o único
  consumidor do re-export é o teste que morre junto — confirme que nada mais
  importa de `./internal-search.js` (grep no src e test).
- `scripts/validate-docker.mjs:181-210`: atualizar as checagens da rota meta
  (a rota deixa de existir; as checagens de efeitos ficam).

### Fatia 4 — Node: módulos, config e cotas

Apagar módulos + testes inteiros:

```text
src/providers/cinemeta.ts            (173l)
src/providers/tmdb.ts                (324l)
src/providers/tmdb-br-aliases.ts     ( 82l)
src/providers/tmdb-home-release.ts   ( 84l)
src/providers/tmdb-multiwork.ts      ( 65l)
src/providers/multiwork-pack.ts      (137l)
```

Testes inteiros: `cinemeta.test.ts`, `tmdb.test.ts`,
`tmdb-english-title.test.ts`, `tmdb-br-aliases.test.ts`,
`meta-cache.test.ts`, `multiwork-pack.test.ts`,
`episode-size-meta-update.test.ts`.

Testes PARCIAIS: `observability.test.ts` (2 testes de miss),
`episode-size.test.ts` (fixture), `non-feature-release.test.ts` (inline).

Config: `cinemeta()` em `config/providers.ts:90-102`; campos de `tmdb()`;
keys em `config.ts:16,39`.

Cotas: entradas `tmdb:`/`tmdbc:`/`meta:` em `cache-quotas.ts` (l.55-61).

- **cache-keys.ts NÃO MUDA**: os prefixeds `meta:`, `tmdb:`, `tmdbc:`,
  `tmdbh:` não estão em `NAMESPACE_VERSIONS` nem em `RUST_OWNED` — nada a
  fazer lá. Ver o risco do corpus (`ck-*`) em §4 antes de tocar em
  cache-keys por qualquer motivo.
- Envs `CINEMETA_*`/`TMDB_*` FICAM no `.env`: o Rust lê as mesmas.

### Fatia 5 — docs

Quando o corte pousar, reconciliar (verificar linha a linha antes — o
arquivo anda):

```text
AGENTS.md                    :229-243 e :664  (fluxo de busca / tabela Busca)
docs/AGENTS-DETALHADO.md     :226
docs/RUST-CONTRATOS.md       :291
docs/rust-stream-contract.md :39 e :876
docs/migracao-stream-rust.md :172
.env.example
```

## 4. Riscos registrados

1. **Risco nº 1: o tail.** O mesmo `NodeRoutes` que alimenta o fallback de
   meta serve os efeitos. A Fatia 1 corta APENAS o argumento de
   `meta_source`; derrubar `NodeRoutes::from_env`/tail junto é o erro que
   este plano existe para evitar.
2. **Goldens novos com `--with-internal`** sairiam SEM `inputs/meta.json`
   (a rota não existirá mais): decidir entre lacuna permanente documentada
   ou captura nativa ANTES/NA Fatia 1 — não deixar para descobrir na Fatia 5.
3. **Monitorar `meta.native.error` após o corte**: com o fallback fora, todo
   erro do primário é silêncio/NOTICE_SEARCHING para o usuário — o contador
   nativo vira o único sinal de saúde de metadados.
4. **`ck-*` do corpus-cache-keys prende formas de chave**: os casos moram em
   `scripts/golden/corpus-cache-keys.json` + `registry-cache-keys.mjs` e o
   golden congelado `rust/golden/cache-keys.jsonl` (ex.: `ck-magmeta` →
   `mag_meta:v1:counts`). Não mexer em cache-keys sem conferir o corpus e o
   golden.

## 5. Ordem de execução e rollback (resumo)

```text
janela 48h dos meta.*  →  Fatia 1 (Rust desliga)  →  Fatia 2 (Rust apaga)
→ Fatia 3 (rota Node)  →  Fatia 4 (módulos/config/cotas)  →  Fatia 5 (docs)
```

Cada fatia é o rollback da seguinte (reverter o commit anterior e o estado
do código volta a ser o validado pelos gates daquela fatia). A Fatia 1 é
reversível numa linha; a partir da Fatia 2 o rollback volta código apagado —
por isso a janela de contadores vem ANTES de tudo.
