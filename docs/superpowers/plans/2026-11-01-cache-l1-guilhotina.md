# Guilhotina do cache L1 (F2-F6) — plano fino

> Plano registrado em 2026-11-01 (branch `rust` @ `8a282584`), auditoria
> somente-leitura do Síndico. Estado: F1 (telemetria `usage` por namespace,
> `5ed679a6`) pousada; a ordem acordada nas 5 frentes é L1 por último.

> **Execução (2026-11-02):** F3 em `ea0c368a`; F4 pousou com um desvio. O plano
> dizia que a expiração física passava ao `prune_expired`, mas só `fsz`/`tsz` o
> chamam. Para não deixar `tmdb`/`meta`/legados sem poda, a F4 criou
> `NativeKv::boot_housekeeping` no gateway.

## 0. Achado central

**O L1 do Node está clinicamente morto em produção**: nenhum consumidor de
dados chama `cache.get/set/peek` em `src/` — os únicos importadores vivos do
motor são telemetria e ações do painel (`snapshot`/`l2Stats`/`size`/`clear`/
`clearNamespace`) e o `close()` do shutdown. O que resta do Node no
`data/cache.db`:

1. Estado legítimo via **ponte nativa** (mesma tabela `cache`, execução no
   NativeKv): `cfg:v1:crawler|harvester|harvesterDebrid|autofetch`,
   `notify:v1:*`, `seed:v1:*`, `indexer-status:<id>` (SEM segmento de versão
   — dívida em `cache-quotas.ts:45-49`).
2. **Podas destrutivas** do motor no disco compartilhado (boot + timer 10 min
   + clear).
3. O **handle SQLite** aberto no MESMO arquivo do gateway (`cache-db.ts:62`).
4. Dois **baldes órfãos** (`rdt`, `dinv`) sem escritor/leitor nos DOIS lados
   (prova: `rdt` só em `WRITABLE_PREFIXES` de teste,
   `adom-debrid/src/store.rs:23`; `dinv` virou memo RAM do orquestrador,
   `adom-search/orchestrator/account.rs:74-98`).

**RISCO ALTO LATENTE (achado material)**: o `deleteStaleStmt` do boot do
Node roda sobre TODOS os `NAMESPACE_VERSIONS` exceto `idx` — inclusive os 16
RUST_OWNED — **sem as guardas `ownedGuards`** (`cache-db.ts:70,116-118` vs
`:67` que tem guarda). Se o gateway bumprar uma versão sem o TS acompanhar,
o boot do Node **apaga o namespace do gateway no disco compartilhado**. Hoje
o golden `ck-versions` segura a sincronia; **F4/F5 eliminam o canhão**.
Mitigação mínima se F4 demorar: pular os RUST_OWNED no laço (como já faz com
`idx`).

Universo do L1 do Node: 3.420 chaves (preso por
`test/cache-namespaces.test.ts:106-115`); folga do lado Rust apertada: 279
(`rust/golden/cache-quotas.jsonl:3`, `cq-universe: soma 92721, max 93000`).

## 1. Fatias

### F2 — aposentar `rdt` e `dinv` (baldes sem dono nos dois lados)
- `cache-quotas.ts` (entradas `rdt` 2500 / `dinv` 50 + reconta do cabeçalho),
  `cache-keys.ts` (`NAMESPACE_VERSIONS`; `LEGACY_PREFIXES` ganha `'rdt:'` e
  `'dinv:'`), `test/cache-namespaces.test.ts` (universo 3.420 → 870; casos
  de rdt migram para balde vivo ou `__default`).
- Pré-condição: telemetria F1 sem reads/writes de `rdt`/`dinv` por janela +
  grep sem chamador de dados. Tabelas do Rust NÃO mudam (sem golden novo).

### F3 — matar a hidratação do boot (`loadFromDisk`)
- `cache-db.ts` (`loadFromDisk` sai; `selectIndexStmt`/`selectValueStmt`
  morrem), `cache.ts:381`; testes de recovery/reload de `cache.test.ts`
  reescritos para validar só a poda. O Node para de varrer a tabela do
  gateway no boot (`:76` sem LIMIT).

### F4 — matar o Node como PODADOR do disco
- Fim do timer de 10 min (`cache.ts:383`), do `forget`→DELETE runtime e das
  podas de boot (`deleteExpiredStmt`/`deleteStaleStmt`/`deleteLegacyStmt`).
  **Elimina o canhão do `deleteStaleStmt` sem guardas.** Expiração física
  passa a ser exclusivamente do `prune_expired` do NativeKv (Rust); legados/
  versão ficam por conta de quem bumpra (o Rust tem `LEGACY_PREFIXES`
  próprio, `adom-core/src/cache_keys.rs:99`).
- Mitigação de risco: só bumprar `cfg/notify/seed` DEPOIS desta fatia com
  limpeza pelo lado do bumor.

### F5 — aposentar a persistência do Node (fim do handle SQLite)
- Apagar `cache-db.ts` e `cache-db-open.ts`; `persist`/`pending`/`clearDisk`/
  `close` fora de `cache.ts`; painel: `l2` perde `freelistCount`/
  `pendingWrites` (mantém `fileSizeBytes`/`walSizeBytes` por `fs.stat`), o
  truncate global passa a ser 100% da admin 8711.
- Pré-condição de contratos: **verificar que a admin 8711 cobre a tabela
  `cache` inteira** (não só `streams.db`) antes de pousar, senão o
  `clear-cache` para de zerar evidências do disco.

### F6 — A GUILHOTINA: fim do motor L1
- Fim do `store` (Map), cotas/evicção/`usage` no Node; `cache.ts` vira
  fachada de `clear`/`clearNamespace` (só pontes nativas); `snapshot()`
  morre (painel exibe só o `native:` do gateway). `cache-quotas.ts` sai do
  runtime (a política viva é `adom-core/src/cache_quotas.rs`). Sobrevive a
  catraca `cache-keys-debrid-owned.test.ts` (`cache-keys.ts` continua vivo
  para montar chaves da ponte e posse).

## 2. Ordem e o que NUNCA vira owned

**F2 → F3 → F4 → F5 → F6.** F2 barata; F3 deixa o L1 vazio (pré-requisito
lógico de F4); F4 mata as escritas destrutivas; F5 só é segura sem nada a
gravar; F6 é a sobra administrativa. Nenhuma fatia toca `streams:v21`/SWR.

NUNCA vira owned / nunca migre:
1. A política de cota/teto do Node sobre `cfg/notify/seed/indexer-status` —
   dono de execução é o processo Node (timers, cooldown, configs vivas do
   painel); saem do universo por aposentadoria (F2/F6), não por
   transferência de posse.
2. As tabelas de cota/versão do gateway (`mag`, `rdc`, `rdq`, `vres`...) —
   folga de 279 é apertada e é conta do gateway.
3. `metam:v1:` e `autofetch-worker:v1:` — literais por prefixo de propósito,
   sem entrada em NAMESPACE_VERSIONS.
4. O clear global — permanece duas mãos (Node limpa o que possui via ponte;
   gateway limpa o que possui via admin).

## 3. Riscos transversais

| Sev. | Risco | Evidência |
|---|---|---|
| ALTA (latente) | Poda cruzada de versão no boot sem guardas | `cache-db.ts:70,116-118` (eliminado em F4/F5) |
| MÉDIA | Folga 279 do universo Rust | `cache-quotas.jsonl:3` — reconta antes de cota nova |
| MÉDIA | `indexer-status` sem versão | `cache-quotas.ts:45-49` — mudança de formato exige migração de chave |
| BAIXA | Doc atrasada | `team/skills/cache/SKILL.md:24` diz teto 84.000 (real 93.000); `vres:v1` existe só no Rust (documentar em `cache-keys.ts`) |

## 4. Validação por fatia

TS: `npm run typecheck`, `npm test`, `npm run test:complete` (lista muda),
`npm run lint:lines -- --check`. Rust: `cargo test -p adom-core` (F2 —
prova tabela intacta), `-p adom-index` (F3/F4), `-p adom-debrid` (F4 — store
read-only intacto), `-p adom-server` (F5 — store_admin), `-p adom-search`
(F6 — SWR nativo intacto). Docker: `validate-docker.mjs` + checagem manual
do bloco `cache` do `/dashboard-status.json` e do `clear-cache` end-to-end
quando for F5/F6.
