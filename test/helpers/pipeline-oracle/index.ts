// Oráculo congelado do pipeline de debrid — superfície ÚNICA que os testes
// importam. Existe para o F4.4 poder remover `src/providers/debrid-pipeline*` e
// `debrid-play-guard.ts` sem apagar a suíte: os testes continuam medindo a
// MESMA decisão congelada no commit c11cb720.
//
// A cópia não puxa `search-orchestrator`/`search-cache`/`stream-builder*`: só as
// dependências que sobrevivem ao corte. Não adicione produção aqui.
export { applyDebrid } from './debrid-pipeline.js';
export { playDisposition, playDispositions } from './debrid-play-guard.js';
export type {
  PlayDisposition,
  PlayBatchFacts,
  PlayDispositionOptions,
  PlayDispositionSingleOptions,
} from './debrid-play-guard.js';
export type { ApplyDebridOptions } from './types.js';
