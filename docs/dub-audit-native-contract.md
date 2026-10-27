# `dub_audit` nativo — contrato do interrogatório de áudio (T3-L7a)

O interrogatório de áudio era o último efeito de cauda que **executava no Node**:
o Rust decidia os candidatos, montava o `kind: "dub_audit"` e o handler
`POST /internal/search/effects` chamava `queueDubAudit` → `runDubAudit`
(`src/providers/dub-audit.ts`). Desde a T3-L7a o gateway executa o efeito
inteiro; o `kind` **não atravessa mais a rota** e o arquivo TS foi apagado.

O que **não** mudou: a **seleção** continua no núcleo (`adom_search`), porque ela
depende do veredito de cache e do pós-processamento da lista — os dois já são
nativos. O gateway só recebe o lote pronto e o executa.

## Topologia

```
Caddy → adom-server (:7000) → Orchestrator (adom-search)
  ├─ fim da busca: build_effects → EffectsBatch { dub_audit, rd_warmer, autofetch_batch }
  └─ TailEffects = NativeTailEffects
       ├─ kind == "dub_audit" → parse_effect → DubAudit::offer → spawn(DubAudit::drain)
       └─ resto               → NodeTailEffects → POST /internal/search/effects (Node)
```

- `NativeTailEffects` (`rust/crates/adom-server/src/tail_effects.rs`) separa os
  efeitos **sem reordenar** os demais: o lote que sobra vai ao alvo de sempre
  (`NodeTailEffects`), com o mesmo `encoded` (a conta do usuário).
- `accepted`/`rejected` são somados: o `dub_audit` aceito conta no mesmo
  contador que o Node devolveria. Payload fora da forma vira `rejected` e log —
  **nunca** vira varredura.
- A drenagem é fire-and-forget: a rota já responde `202` e o interrogatório não
  entra no caminho de quem pediu a lista.

## Payload (inalterado)

Produzido por `adom_search::orchestrator::effects::dub_audit` sobre
`EffectSeeds::audit` (`list_builder/effects.rs::audit_seeds`):

```json
{
  "adapter_id": "alldebrid",
  "api_key": "…",
  "candidates": [
    {
      "hash": "40 hex minúsculo",
      "season": 1, "episode": 4,
      "imdbId": "tt1234567",
      "work": { "names": ["…"], "year": 2019, "pack": false },
      "dubbed": true,
      "needsPromote": false
    }
  ]
}
```

`api_key` é a chave da conta efetiva (defaults do operador + overlay da URL) e
**nunca** vai para log. `parse_effect` valida adapter/chave não vazios e hash de
40 hex; qualquer desvio rejeita o lote inteiro.

## Execução

| Etapa | Regra |
|---|---|
| Fila | em memória, teto **50** (`PENDING_CAP`), descarta o excedente mais antigo |
| Dedupe | por `(adapter, api_key, hash, season, episode)` — reoferta não gasta consulta |
| Pré-filtro | hash já `lie` nesta conta ou já provado `missing` para o episódio é descartado no `offer` |
| Drenagem | `min(DEBRID_DUB_AUDIT_MAX, pendentes)`; **um drain por vez** (`in_flight`) |
| Resolve | o MESMO `PlayResolver` do `/resolve` (`DebridPlay`), com `held = false` |
| Conta | a do **candidato** (capturada no `offer`), não a do ALS do momento da drenagem |

O TS agendava um `setImmediate` por oferta, então rajadas podiam abrir N resolves
concorrentes; aqui o `in_flight` serializa. É a divergência de comportamento mais
visível — e a desejada: a fila do debrid do usuário deixa de receber rajada.

## Veredito

| Saída do `resolve` | Escritas |
|---|---|
| `Ok` com `dubbed && needsPromote` | invalida as listas da obra (`streams.invalidate_for_obra`) para a claim virar `_dubbed` |
| `Ok` sem promoção | nada |
| `dub_lie` | `mag.lie` (TTL `MAGNET_LIE_TTL`) + `adprot` destravado + `idx.mark_lied` + invalida a obra |
| `episode_pick` **com** `evidence` | `idx.mark_missing` (S/E) e, com `declared_episodes` vazio, `mark_missing_season`; invalida a obra |
| `episode_pick` **sem** `evidence` | nada — ambiguidade não é prova de outro episódio |
| outro erro (rede/credencial/quota) | nada — o candidato volta na próxima busca |

Escritas em `rust/crates/adom-server/src/dub_audit_writes.rs` (`NativeWrites`),
direto nos stores do núcleo, sem rota interna:

| Escrita | Store |
|---|---|
| `lie` | `adom_index::MagnetStateStore` (`state`/`mark_lie`) |
| `lied`/`miss`/`missS` | `adom_store::ReleaseIndexStore` (`mark_lied`/`mark_missing`/`mark_missing_season`) |
| `adprot` destravado | `adom_index::NativeKv::forget` da chave `adprot:v1:<adapter>:<account_scope>:<hash>` |
| invalidação por obra | `adom_store::StreamsStore::invalidate_for_obra` |

Falha de abertura de um store degrada **só** a escrita correspondente (log
`[audit]`): o `resolve` não depende deles.

## Config e kill-switches

| Env | Default | Efeito |
|---|---|---|
| `AUDIO_AUDIT` | `true` | desligado, `offer` não enfileira nada |
| `DEBRID_DUB_AUDIT_MAX` | `2` | tamanho do lote por drenagem (`0` desliga) |
| `MAGNET_DB` + `MAGNET_LIE` | `true` | `false` impede gravar `lie` (o resto do veredito continua) |
| `MAGNET_LIE_TTL` | 7 dias | validade da marca `lie` |

Todas são lidas no **boot** do gateway (`DubAuditConfig::from_env`), como eram no
boot do Node: não há config viva de painel neste efeito. `EFFECTS_RUST=off`
desliga a emissão do lote inteiro (o interrogatório deixa de existir).

## Divergências conhecidas vs. o TS

1. **Sem métricas.** O TS emitia `debrid.audit.lie.tail` e
  `debrid.audit.episode`; o núcleo não tem esse registrador e a contagem não foi
  recriada (o log de cada veredito permanece). Quem quiser o número lê o log.
2. **Sem `cache.forget(searchKey)`.** A chave de busca do TS nunca alcançava
  `streams` (namespace RUST_OWNED); a invalidação sempre foi por obra, que é o
  que ficou. `extraKeys` (as chaves de buscas anteriores) deixou de existir junto.
3. **`needsPromote` promove por obra.** O TS acumulava `okKeys`/`okImdb` e
  invalidava no fim do lote; aqui a invalidação é imediata por candidato. O efeito
  prático é o mesmo, e o número de invalidações pode ser maior num lote com
  vários hashes da mesma obra.
4. **Log por `eprintln!`.** O formato é o mesmo (`[audit] tail provou …`), mas sai
  no stderr do gateway, não no logger do Node (sem timestamp/rotação próprios).

## Arquivos

| Papel | Arquivo |
|---|---|
| Fila, drenagem e veredito | `rust/crates/adom-server/src/dub_audit.rs` |
| Escritas do veredito | `rust/crates/adom-server/src/dub_audit_writes.rs` |
| Interceptação do efeito | `rust/crates/adom-server/src/tail_effects.rs` |
| Fiação no boot | `rust/crates/adom-server/src/stream.rs` |
| Seleção (inalterada) | `rust/crates/adom-search/src/list_builder/effects.rs` (`audit_seeds`) |
| Payload | `rust/crates/adom-search/src/orchestrator/effects.rs` (`dub_audit`) |
| Contrato do Node (sem o braço) | `src/routes/internal-search-effects.ts` |
| Oráculo congelado do TS | `test/helpers/pipeline-oracle/dub-audit.ts` |

## Testes

- `dub_audit_tests.rs` — 13 casos: fila/teto/dedupe/pré-filtro, `dub_lie`,
  `episode_pick` com e sem prova, erro genérico, promoção, drenagem serializada
  e `parse_effect`.
- `dub_audit_writes_tests.rs` — paridade SQLite: `lie` (e isolamento por conta),
  `adprot` destravado, `miss` por episódio e `missS` quando o arquivo não declara
  episódio.
- `tail_effects_tests.rs` — o `dub_audit` fica no gateway, o resto vai ao alvo na
  mesma ordem, payload inválido é rejeitado sem chamar o alvo, e o aceite dispara
  a drenagem em segundo plano.
- `test/internal-search-effects.test.ts` — prova o lado do Node: `dub_audit` e
  `magnet_capture` são `rejected` (kinds com dono nativo).
