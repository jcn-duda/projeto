// Catálogo durável — CLASSIFICAÇÃO E O RÓTULO DA PROVA.
//
// O veredito vem dos mesmos classificadores da busca (`audio-quality.ts`), mas
// o que fica gravado na linha do catálogo é o RÓTULO DA PROVA: do lado
// estrangeiro, 'cena' (marca EN forte de scene), 'audio' (áudio estrangeiro
// explícito) ou 'sim' (condenação sem marca forte); do lado BR, 'titulo'
// (absolvição só pelo título do post — fraca, não congela no upsert) e
// 'arquivo' (absolvição medida nos arquivos reais — durável, congela).
//
// Fachada pública: `src/utils/catalog.ts`; camada de linhas/engine:
// `catalog-rows.ts`.
import { foreignVerdict, hasExplicitForeignAudio, strongEnSceneMark, audioBucket } from './audio-quality.js';

export function foreignProofLabel(candidates: string[]): string {
  for (const p of candidates) {
    if (strongEnSceneMark(p)) return 'cena';
  }
  for (const p of candidates) {
    if (hasExplicitForeignAudio(p)) return 'audio';
  }
  return 'sim';
}

export type Proof = { bucket: string; audio: string; foreignProof: string; ptProof: string };

// Sem evidência de arquivo: o título do post é a única fonte.
export function classifyByTitle(filename: string): Proof {
  const verdict = foreignVerdict(filename);
  let foreignProof = '';
  let ptProof = '';
  if (verdict === 'condena') foreignProof = foreignProofLabel([filename]);
  else if (verdict === 'absolve') ptProof = 'titulo';
  return { audio: '', bucket: audioBucket(filename), foreignProof, ptProof };
}

// Prova dos ARQUIVOS reais (fileEvidence): o rótulo de áudio não vem do título.
export function classifyWithEvidence(filename: string, evidenceN: string | undefined): Proof {
  const paths = evidenceN ? [evidenceN] : [];
  const verdict = foreignVerdict(filename, paths);
  let foreignProof = '';
  let ptProof = '';
  if (verdict === 'condena') foreignProof = foreignProofLabel(paths.length ? [filename, ...paths] : [filename]);
  else if (verdict === 'absolve') ptProof = 'arquivo';
  return { bucket: audioBucket(filename), audio: '', foreignProof, ptProof };
}
