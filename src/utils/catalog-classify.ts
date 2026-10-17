// Catálogo durável — CLASSIFICAÇÃO E O RÓTULO DA PROVA.
//
// O veredito vem dos mesmos classificadores da busca (`audio-quality.ts`), mas
// o que fica gravado na linha do catálogo é o RÓTULO DA PROVA: do lado
// estrangeiro, 'cena' (marca EN forte de scene), 'audio' (áudio estrangeiro
// explícito) ou 'sim' (condenação sem marca forte); do lado BR, 'titulo'
// (absolvição só pelo título do post — fraca, não congela no upsert) e
// 'arquivo' (absolvição medida nos arquivos reais — durável, congela).
//
// A decisão inteira é do núcleo (`adom_core::catalog_classify`, golden contra o
// TS do `esm`); aqui só se montam as entradas e se traduz a saída. O módulo
// deixou de ser folha: lê `config.audioAudit` (as listas calibradas entram por
// PARÂMETRO, como em `audio-quality.ts`) e carrega o `.node` sob demanda.
//
// Fachada pública: `src/utils/catalog.ts`; camada de linhas/engine:
// `catalog-rows.ts`.
import config from '../config.js';
import { nativeCore } from './native-core.js';
import { coreJson } from './native-json.js';

/** Função do catálogo no `.node` (camelCase do napi-rs). */
type CatalogCore = {
  catalogClassify(input: string): string;
};

const catalogCore = () => nativeCore<CatalogCore>();

/** Listas calibradas do audit de dublagem (ptMarkers/enGroups). */
const ptMarkers = (): string[] => config.audioAudit.ptMarkers as string[];
const enGroups = (): string[] => config.audioAudit.enGroups as string[];

/** Uma travessia: `op` seleciona o rótulo ou uma das duas classificações. */
function catalogClassify(op: 'label' | 'title' | 'evidence', payload: Record<string, unknown>): string {
  return catalogCore().catalogClassify(coreJson({
    ...payload,
    op,
    ptMarkers: ptMarkers(),
    enGroups: enGroups(),
  }));
}

export function foreignProofLabel(candidates: string[]): string {
  return catalogClassify('label', { candidates: candidates.map((p) => String(p)) });
}

export type Proof = { bucket: string; audio: string; foreignProof: string; ptProof: string };

/** `bucket|audio|foreignProof|ptProof` é a linha canônica do golden. */
function proofOf(line: string): Proof {
  const [bucket, audio, foreignProof, ptProof] = line.split('|');
  return { audio, bucket, foreignProof, ptProof };
}

// Sem evidência de arquivo: o título do post é a única fonte.
export function classifyByTitle(filename: string): Proof {
  return proofOf(catalogClassify('title', { filename: String(filename ?? '') }));
}

// Prova dos ARQUIVOS reais (fileEvidence): o rótulo de áudio não vem do título.
export function classifyWithEvidence(filename: string, evidenceN: string | undefined): Proof {
  return proofOf(catalogClassify('evidence', {
    filename: String(filename ?? ''),
    evidence: evidenceN == null || evidenceN === '' ? null : String(evidenceN),
  }));
}
