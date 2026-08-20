function priorityMap(ids: string[] = []) {
  const map: Map<string, number> = new Map();
  ids.forEach((id: string, index: number) => {
    const key = String(id || '').trim().toLowerCase();
    if (key && !map.has(key)) map.set(key, index);
  });
  return map;
}

function rankFor(stream: any, ranks: Map<string, number>): number {
  const source = String(stream?._indexer || '').trim().toLowerCase();
  return ranks.get(source) ?? Number.MAX_SAFE_INTEGER;
}

/** Prioridade só desempata dentro da mesma qualidade; busca segue paralela. */
function compareIndexerPriority(a: any, b: any, ranks: Map<string, number>): number {
  if (!ranks || ranks.size === 0) return 0;
  return rankFor(a, ranks) - rankFor(b, ranks);
}

export { priorityMap, compareIndexerPriority };
