/**
 * Métricas puras do probe Jev dub-lie (ETAPA 2) — matriz expected ×
 * resposta, latência, tokens e custo estimado (requisito 3).
 *
 * FORA DO CAMINHO CRÍTICO: nada daqui é importado por `src/`. Nenhuma
 * função toca rede, relógio global ou ambiente: toda a entrada vem por
 * parâmetro, o que permite testar com linhas sintéticas.
 */

/** Veredito binário do noul contra o threshold (default >=). */
export function judge(noul, threshold) {
  return noul >= threshold;
}

/** Célula da matriz: tp/fp (esperado lie), fn/tn (esperado honesto). */
export function classifyRow(expectLie, predLie) {
  if (expectLie && predLie) return 'tp';
  if (!expectLie && predLie) return 'fp';
  if (expectLie && !predLie) return 'fn';
  return 'tn';
}

/**
 * Estatísticas de latência (ms): avg, min, p50, p95, max por
 * nearest-rank sobre a lista ordenada. Lista vazia → null.
 */
export function latencyStats(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    n: sorted.length,
    avgMs: Math.round((sum / sorted.length) * 10) / 10,
    minMs: sorted[0],
    p50Ms: pick(50),
    p95Ms: pick(95),
    maxMs: sorted[sorted.length - 1],
  };
}

/**
 * Custo estimado em USD: tokens/1e6 × preço por milhão. Preço 0 ou
 * ausente em qualquer lado → null (não configurado; o relatório diz
 * como configurar). Fórmula documentada no cabeçalho do probe.
 */
export function estimateCost(tokensIn, tokensOut, priceInPerM, priceOutPerM) {
  const pIn = Number(priceInPerM);
  const pOut = Number(priceOutPerM);
  if (!(pIn > 0) || !(pOut > 0)) return null;
  return (Number(tokensIn || 0) / 1e6) * pIn + (Number(tokensOut || 0) / 1e6) * pOut;
}

function emptyCell() {
  return { tp: 0, fp: 0, fn: 0, tn: 0, err: 0, total: 0 };
}

/**
 * Consolida as linhas da corrida em um relatório mensurável.
 * Linhas com `error` contam em `errors`/`byGroup.*.err` e NÃO entram na
 * matriz (fail-open: a corrida inteira pode ter falhado e o relatório
 * continua saindo, deixando o buraco explícito).
 */
export function summarize({ rows, meta }) {
  const matrix = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const fpIds = [];
  const fnIds = [];
  const errorRows = [];
  const byGroup = {};
  const latencies = [];
  const tokens = { requests: 0, input: 0, output: 0 };

  for (const row of rows) {
    const cell = (byGroup[row.group] ||= emptyCell());
    cell.total++;
    if (row.error != null) {
      errorRows.push({ id: row.id, error: String(row.error) });
      cell.err++;
      continue;
    }
    cell[row.kind]++;
    matrix[row.kind]++;
    if (row.kind === 'fp') fpIds.push(row.id);
    if (row.kind === 'fn') fnIds.push(row.id);
    if (typeof row.latencyMs === 'number') latencies.push(row.latencyMs);
    if (row.usage && typeof row.usage.input === 'number') {
      tokens.requests++;
      tokens.input += row.usage.input;
      tokens.output += row.usage.output || 0;
    }
  }

  const lie = rows.filter((r) => r.expectLie === true).length;
  const honest = rows.filter((r) => r.expectLie === false).length;
  const decided = matrix.tp + matrix.tn + matrix.fp + matrix.fn;
  const accPct = decided ? Math.round(((matrix.tp + matrix.tn) / decided) * 1000) / 10 : null;
  const estimatedCostUsd = estimateCost(
    tokens.input,
    tokens.output,
    meta?.costInputPerM,
    meta?.costOutputPerM,
  );

  return {
    meta: {
      model: meta?.model ?? '',
      threshold: meta?.threshold,
      concurrency: meta?.concurrency,
      timeoutMs: meta?.timeoutMs,
      promptVersion: meta?.promptVersion ?? '',
      corpusSha256: meta?.corpusSha256 ?? '',
      corpusSha12: (meta?.corpusSha256 ?? '').slice(0, 12),
      generatedAt: meta?.generatedAt ?? '',
    },
    corpus: { total: rows.length, lie, honest },
    matrix,
    decided,
    errors: errorRows.length,
    accPct,
    disagreements: matrix.fp + matrix.fn,
    fpIds,
    fnIds,
    errorRows,
    byGroup,
    latency: latencyStats(latencies),
    tokens: tokens.requests > 0 ? tokens : null,
    cost: {
      estimatedUsd: estimatedCostUsd != null ? Math.round(estimatedCostUsd * 1e6) / 1e6 : null,
      configured: estimatedCostUsd != null,
      priceInputPerM: meta?.costInputPerM ?? 0,
      priceOutputPerM: meta?.costOutputPerM ?? 0,
    },
  };
}

/** Tabela por família, ordenada por nome. */
function renderByGroup(byGroup) {
  const lines = [];
  for (const group of Object.keys(byGroup).sort()) {
    const c = byGroup[group];
    lines.push(
      `  ${group.padEnd(16)} total=${String(c.total).padStart(2)} tp=${c.tp} tn=${c.tn} fp=${c.fp} fn=${c.fn} err=${c.err}`,
    );
  }
  return lines.join('\n');
}

/** Relatório humano (requisito 3). NUNCA inclui a chave — só metadados.
 * Defensivo: campos ausentes degradam para `n/d`/zero em vez de lançar
 * (o relatório é o último suspiro de uma corrida que pode ter falhado). */
export function renderReport(s) {
  const m = s?.meta ?? {};
  const matrix = s?.matrix ?? { tp: 0, fp: 0, fn: 0, tn: 0 };
  const corpus = s?.corpus ?? { total: 0, lie: 0, honest: 0 };
  const byGroup = s?.byGroup ?? {};
  const fpIds = s?.fpIds ?? [];
  const fnIds = s?.fnIds ?? [];
  const errorRows = s?.errorRows ?? [];
  const tokens = s?.tokens ?? null;
  const cost = s?.cost ?? { configured: false };
  const L = [];
  L.push(`=== ${m.reportTitle ?? 'Jev dub-lie probe'} — relatório ===`);
  L.push(`modelo=${m.model ?? 'n/d'} threshold=${m.threshold ?? 'n/d'} prompt=${m.promptVersion ?? 'n/d'} corpus=${m.corpusSha12 ?? 'n/d'}`);
  L.push(`fan-out: concorrência=${m.concurrency ?? 'n/d'} timeout_ms=${m.timeoutMs ?? 'n/d'}`);
  L.push(`corpus: ${corpus.total} casos (${corpus.lie} lie / ${corpus.honest} honest)`);
  L.push(
    `matriz: tp=${matrix.tp} tn=${matrix.tn} fp=${matrix.fp} fn=${matrix.fn} ` +
      `erros=${errorRows.length} decididos=${(matrix.tp ?? 0) + (matrix.tn ?? 0) + (matrix.fp ?? 0) + (matrix.fn ?? 0)}/${corpus.total}`,
  );
  L.push(`acordo (acc): ${s?.accPct == null ? 'n/d' : `${s.accPct}%`} · discordâncias: ${s?.disagreements ?? (matrix.fp + matrix.fn)}`);
  L.push(`falsos positivos (denunciou honesto): ${fpIds.length ? fpIds.join(', ') : 'nenhum'}`);
  L.push(`falsos negativos (absolveu mentira): ${fnIds.length ? fnIds.join(', ') : 'nenhum'}`);
  if (errorRows.length) {
    L.push('falhas (fora da matriz):');
    for (const e of errorRows) L.push(`  ${e.id}: ${e.error}`);
  }
  L.push('por família:');
  L.push(renderByGroup(byGroup));
  L.push(
    s?.latency
      ? `latência/request: avg=${s.latency.avgMs}ms p50=${s.latency.p50Ms}ms p95=${s.latency.p95Ms}ms ` +
        `min=${s.latency.minMs}ms max=${s.latency.maxMs}ms (n=${s.latency.n})`
      : 'latência/request: n/d',
  );
  if (tokens) {
    L.push(`tokens: requests=${tokens.requests} input=${tokens.input} output=${tokens.output}`);
    L.push(
      cost.configured
        ? `custo estimado: US$ ${cost.estimatedUsd} (in US$${cost.priceInputPerM}/M · out US$${cost.priceOutputPerM}/M)`
        : 'custo estimado: n/d — configure JEV_DUB_LIE_COST_INPUT_PER_M e JEV_DUB_LIE_COST_OUTPUT_PER_M (USD por 1M tokens)',
    );
  } else {
    L.push('tokens: nenhum uso retornado pela API');
  }
  return L.join('\n');
}
