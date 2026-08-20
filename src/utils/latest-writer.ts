/**
 * Coordena versões concorrentes do mesmo valor. A fase invalida uma estratégia
 * antiga (episódio quando o fallback de pack começa); a revisão garante que o
 * lote mais novo da fase vença mesmo se o pós-processamento terminar antes.
 */
function createLatestWriter(build: (input: any) => any, commit: (value: any) => void, useful: (value: any) => boolean = (value: any) => Array.isArray(value) && value.length > 0) {
  let phase = 0;
  let revision = 0;
  let usefulPhase = -1;

  async function run(input: any, expectedPhase = phase) {
    const ownRevision = ++revision;
    const value = await build(input);
    const current = expectedPhase === phase && ownRevision === revision;
    // Um episódio tardio útil ainda pode salvar a busca quando o fallback de
    // pack também volta vazio. Porém uma fase antiga vazia jamais substitui uma
    // fase nova, e nenhum lote antigo substitui resultado útil mais recente.
    const staleRescue = expectedPhase < phase && useful(value) && usefulPhase < expectedPhase;
    if (current || staleRescue) {
      await commit(value);
      if (useful(value)) usefulPhase = Math.max(usefulPhase, expectedPhase);
    }
    return value;
  }

  run.phase = () => phase;
  run.advance = () => {
    phase += 1;
    revision += 1;
    return phase;
  };
  return run;
}

export { createLatestWriter };
