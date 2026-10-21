// Evidência que só o Node tem, anexada aos itens que as rotas internas devolvem
// (`collect`/`index`): a prova de ARQUIVO do índice (`applyFileEvidence`), a
// prova de QUALIDADE do arquivo que o play tocaria (`stampProvenQuality`) e o
// histórico RUIM da conta (`broken`).
//
// O `ptTitleDual` NÃO é calculado aqui. A decisão mora no núcleo do orquestrador
// Rust: os títulos da obra chegam em `/internal/search/meta`
// (`SearchMeta.titles`) → `BuildContext.titles` → `apply_pt_title_dual`, que
// marca o lote in-process antes do build. Recalcular na rota duplicava a régua e
// prendia a resposta a `getTitles` sem ganho — o Node não precisa mandar o flag.
import type { RawItem, Stream } from '../../types/domain.js';
import { applyFileEvidence } from '../providers/stream-file-evidence.js';
import { stampProvenQuality } from '../providers/probed-quality.js';
import { pruneKnownBroken } from '../providers/debrid-cache-steps.js';
import { hashOf } from '../utils/magnet-bank-merge.js';
import { accountScope } from '../utils/request-key.js';
import debrid from '../debrid/index.js';
import { opts } from '../runtime.js';

/** Obra da busca: `season`/`episode`/`imdbId` ativam a prova fina do índice. */
export type BrokenScope = { season?: number | null; episode?: number | null; imdbId?: string | null };

/** Escopo por requisição: prova de qualidade (nomes/ano) + histórico da conta. */
export type EvidenceScope = BrokenScope & {
  names?: string[];
  year?: number | string | null;
};

/**
 * Marca `broken: true` no que o histórico da CONTA já provou quebrado (bad,
 * lie, dead ou idx-miss) — a mesma régua do `pruneKnownBroken` que o Node
 * aplica antes da checagem do debrid. O Rust não tem o banco de magnets da
 * conta: sem a marca, o `/stream` nativo exibia hash que o Node corta (medido
 * em Cidade de Deus: release do Comando com `lie` no Node e na lista do Rust).
 * Precisa rodar DENTRO do `runtime.run` do usuário (chave e adaptador vêm do
 * contexto); sem debrid configurado não marca nada, como o Node.
 */
export function markKnownBroken(items: RawItem[], scope: BrokenScope = {}): RawItem[] {
  const adapter = debrid.current();
  if (!adapter || items.length === 0) return items;
  const apiKey = opts().debridApiKey;
  if (!apiKey) return items;
  const probes = items
    .map((item) => ({ item, infoHash: hashOf(item) }))
    .filter((p) => p.infoHash);
  const { streams } = pruneKnownBroken(
    probes.map((p) => ({ infoHash: p.infoHash, _lied: Boolean((p.item as any).lied) }) as unknown as Stream),
    adapter.id,
    { apiKey, trustScope: accountScope(apiKey), ...scope },
  );
  const alive = new Set(streams.map((s) => s.infoHash));
  for (const p of probes) {
    if (!alive.has(p.infoHash)) (p.item as any).broken = true;
  }
  return items;
}

/**
 * Anexa a prova de arquivo/qualidade do índice e a marca `broken`. Síncrono e
 * sem rede: a rota devolve o lote imediatamente; a decisão de
 * chip/`_dubbed`/origem BR fica no Rust.
 *
 * `provenQuality` é o campo que o `RawItem` do Rust já consome: sem ele o corte
 * nativo classifica o release no balde "sem resolução" e a cota de qualidade
 * troca o BR por um global 4K (Interestelar, 2026-10-20).
 */
export function enrichForRust(items: RawItem[], scope: EvidenceScope = {}): RawItem[] {
  return markKnownBroken(stampProvenQuality(applyFileEvidence(items), scope), scope);
}
