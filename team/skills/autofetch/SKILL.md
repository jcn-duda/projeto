---
name: adom-autofetch
description: Domínio do autofetch do Adom (pré-baixar fontes dubladas via debrid quando nada tocável está em cache). Use ao auditar ou mexer no worker NATIVO do Chupim (`rust/crates/adom-server/src/autofetch/`), nos fatos que ele grava e o Node lê (marker/hold/registro F2), na fila persistente, no recheck/settle ou em stall/dead.
---

# Chupim — Donzelo do Autofetch

Autofetch e `dropUncached` são forças opostas; a ponte é `protected.ts` (hold
**antes** da checagem). O autofetch nunca entra no caminho da resposta — erro é
só log.

O **corpo TS do Chupim saiu de `src/` na leva B4 (2026-10-28)**: quem executa
fila, cascata, pools, recheck, settle, sonda e season é o worker nativo do
gateway. A trava é `AUTOFETCH_WORKER`, e o default `on` não mora no código: é a
interpolação `${AUTOFETCH_WORKER:-on}` do `docker-compose.yml:68`, que o `.env`
da VPS vence — só o literal `on` liga (`mod.rs:128-130`). No Node ficam as
PONTES e os LEITORES (painel, `markerActive`, `adsub`/`adprot`), não a gravação:
o marker com `obra` e o registro F2 `autofetch:v3:o:<digest>` também nascem no
ACEITE NATIVO (`enqueue.rs:299-316`, `enqueue_obra.rs:294-295`), e `pf:` não tem
escritor nenhum. Rollback = imagem/commit anterior: `AUTOFETCH_WORKER=off`
desliga o Chupim e o efeito de trabalho morre na rota do Node (só conta em
`nativeOnly`).

## Quando usar

- Ao mexer em seleção de candidatos, holds/markers, fila, recheck/settle.
- Ao revisar detecção de torrent morto (`torrentStatus`), stall/dead streak,
  season fill (o prefetch E+1 morreu com o TS).

## Arquivos-âncora

- `rust/crates/adom-server/src/autofetch/` — laço e execução: `mod.rs` (trava
  `AUTOFETCH_WORKER`), `serve.rs`/`serve_jobs.rs` (passagem e despacho por
  `Job.kind`), `enqueue*.rs` (lote, portões, teto por obra, holds), `recheck.rs`
  e `recheck_expire.rs`, `probe_job.rs`/`probe_step.rs`, `season_*`, `evict_*`,
  `suppressed_step.rs`, `vault.rs` (credencial em RAM)
- `rust/crates/adom-autofetch/src/v3/` — réguas puras: `cascade`, `seeds`,
  `queue`, `drain`, `recheck`, `obra`/`obra_reservation`, `probe`, `season`,
  `evict`, `suppressed`
- `src/providers/autofetch.ts` (ponte/painel: reindexação no boot,
  `markerActive`, `isDeadQuiet`), `autofetch-marker.ts`, `autofetch-obra*.ts`,
  `autofetch-evict.ts` (leitor da prova `er:` — `hasBrReady`; política e
  executor são `evict_job.rs`/`evict_step.rs`)
- `src/debrid/protected.ts` (hold), `src/utils/autofetch-native.ts`,
  `rust-autofetch.ts` (ponte da admin 8711), `rust/crates/adom-search/src/debrid_seam.rs`
- Golden de contrato dos passos: `rust/golden/autofetch-{probe,season,evict,suppressed}-step.*`

## Guardrails (invariante 6)

1. O `hold` é aplicado **antes** da checagem de cache (`protected.ts`), senão o
   `dropUncached` da própria checagem mata o download.
2. Orçamento cheio **não é recusa do torrent**: o dreno do worker devolve a
   cabeça à fila com backoff (`v3/drain.rs`, `enqueue_drain.rs`), em vez de
   reenfileirar a mesma cabeça a cada recheck (bug do giro infinito).
3. `torrentStatus` honesto por serviço: Premiumize (heurística), TorBox
   (`download_state === "stalled"`), AllDebrid/RD/DL (sem `stalled`).
4. Teto `DEBRID_AUTO_FETCH_MAX` (1..12) com vaga por candidato compartilhada
   entre os passes (`enqueue_holds.rs`); pool `br` cobre por qualidade-alvo
   (1×720 + 1×1080 + 1×4K), não por "já tem algum BR".
5. Pool seeds (`autoFetchTopSeedsMax` 1..4) **não** some quando
   `autoFetchAnyDubbed=false` — cascata `br > any > seeds` (`v3/cascade.rs`).
6. Orçamento cheio devolve a cabeça à frente e pausa com backoff; falha de
   `torrentStatus` **não** zera streak (`stall_threshold`, `recheck.rs:277-279`).

## Contrato de saída (auditoria)

```json
{"area":"autofetch","risks":[{"severity":"alta|media|baixa","file":"arquivo:linha","summary":"...","note":"..."}],"comentarios":["..."]}
```
Cite `arquivo:linha`. Sem achado -> `risks: []`.
