// @ts-check
function priorityMap(ids = []) {
  const map = new Map();
  ids.forEach((id, index) => {
    const key = String(id || '').trim().toLowerCase();
    if (key && !map.has(key)) map.set(key, index);
  });
  return map;
}

function rankFor(stream, ranks) {
  const source = String(stream?._indexer || '').trim().toLowerCase();
  return ranks.has(source) ? ranks.get(source) : Number.MAX_SAFE_INTEGER;
}

/** Prioridade só desempata dentro da mesma qualidade; busca segue paralela. */
function compareIndexerPriority(a, b, ranks) {
  if (!ranks || ranks.size === 0) return 0;
  return rankFor(a, ranks) - rankFor(b, ranks);
}

module.exports = { priorityMap, compareIndexerPriority };
