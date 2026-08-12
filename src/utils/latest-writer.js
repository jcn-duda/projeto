/**
 * Coordena versões concorrentes do mesmo valor. A fase invalida uma estratégia
 * antiga (episódio quando o fallback de pack começa); a revisão garante que o
 * lote mais novo da fase vença mesmo se o pós-processamento terminar antes.
 */
function createLatestWriter(build, commit) {
  let phase = 0;
  let revision = 0;

  async function run(input, expectedPhase = phase) {
    if (expectedPhase !== phase) return null;
    const ownRevision = ++revision;
    const value = await build(input);
    if (expectedPhase === phase && ownRevision === revision) await commit(value);
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

module.exports = { createLatestWriter };
