#!/usr/bin/env node
/**
 * scripts/stream-parity.mjs
 *
 * Compara /stream do Node (7100) versus /stream nativo em Rust (7000),
 * na 2ª passada (SWR / aquecido), medindo hashes, ordem, contagem BR e latência.
 *
 * Uso:
 *   node scripts/stream-parity.mjs [--rust http://127.0.0.1:7000] [--node http://127.0.0.1:7100] [--encoded e30]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function getArg(flag, def) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
}

const RUST_BASE = getArg('--rust', 'http://127.0.0.1:7000');
const NODE_BASE = getArg('--node', 'http://127.0.0.1:7100');
const ENCODED = getArg('--encoded', 'e30');

// Casos representativos: BR nacionais, dublados globais, franquias/multiobra, animação, séries e anime.
const TEST_CASES = [
  { id: 'cidade-de-deus', type: 'movie', streamId: 'tt0317248', label: 'Cidade de Deus (BR Nacional)' },
  { id: 'tropa-de-elite', type: 'movie', streamId: 'tt0862716', label: 'Tropa de Elite (BR Nacional)' },
  { id: 'central-do-brasil', type: 'movie', streamId: 'tt0140889', label: 'Central do Brasil (BR Nacional)' },
  { id: 'auto-compadecida', type: 'movie', streamId: 'tt0261009', label: 'O Auto da Compadecida (BR Nacional)' },
  { id: 'carandiru', type: 'movie', streamId: 'tt0293005', label: 'Carandiru (BR Nacional)' },
  { id: 'bacurau', type: 'movie', streamId: 'tt9044788', label: 'Bacurau (BR Nacional)' },
  { id: 'inception', type: 'movie', streamId: 'tt1375666', label: 'Inception (Dublado Global)' },
  { id: 'matrix', type: 'movie', streamId: 'tt0133093', label: 'Matrix (Global EN)' },
  { id: 'interstellar', type: 'movie', streamId: 'tt0816692', label: 'Interstellar (Global)' },
  { id: 'parasita', type: 'movie', streamId: 'tt6751668', label: 'Parasita (Dublado BR)' },
  { id: 'harry-potter-1', type: 'movie', streamId: 'tt0241527', label: 'Harry Potter 1 (Multiobra/Pack)' },
  { id: 'kung-fu-panda-4', type: 'movie', streamId: 'tt1016148', label: 'Kung Fu Panda 4 (Animação/Pack)' },
  { id: 'breaking-bad-s01e01', type: 'series', streamId: 'tt0903747:1:1', label: 'Breaking Bad S01E01 (Série)' },
  { id: 'got-s08e03', type: 'series', streamId: 'tt0944947:8:3', label: 'Game of Thrones S08E03 (Série)' },
  { id: '3-percent-s01e01', type: 'series', streamId: 'tt5655606:1:1', label: '3% S01E01 (Série BR Nacional)' },
  { id: 'naruto-s01e01', type: 'series', streamId: 'tt0409591:1:1', label: 'Naruto S01E01 (Anime Dublado)' },
];

function extractHash(stream) {
  if (stream.infoHash) return stream.infoHash.toLowerCase();
  const url = stream.url || '';
  const match = /\/resolve\/([0-9a-fA-F]{40})/i.exec(url);
  if (match) return match[1].toLowerCase();
  return null;
}

function isBrStream(stream) {
  const full = `${stream.name || ''} ${stream.title || ''}`;
  return full.includes('🇧🇷') ||
    full.includes('DUB BR') ||
    full.includes('NAC BR') ||
    /\b(bludv|mico|comando|nerd|tdf|vaca|redetorrent)\b/i.test(full);
}

async function fetchStream(baseUrl, type, streamId) {
  const url = `${baseUrl}/${ENCODED}/stream/${type}/${streamId}.json`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Stremio/1.6' } });
    const ms = Date.now() - t0;
    if (!res.ok) {
      return { ok: false, status: res.status, ms, streams: [] };
    }
    const data = await res.json();
    return { ok: true, status: res.status, ms, streams: Array.isArray(data.streams) ? data.streams : [] };
  } catch (err) {
    return { ok: false, error: err.message, ms: Date.now() - t0, streams: [] };
  }
}

async function main() {
  console.log('='.repeat(95));
  console.log(`Comparativo de Paridade: Node (${NODE_BASE}) vs Rust (${RUST_BASE})`);
  console.log(`Configuração: ${ENCODED} | Total de casos: ${TEST_CASES.length}`);
  console.log('='.repeat(95));

  const results = [];

  for (const c of TEST_CASES) {
    process.stdout.write(`Avaliando: ${c.label.padEnd(42)} ... `);

    // 1ª passada (aquecimento)
    await Promise.all([
      fetchStream(NODE_BASE, c.type, c.streamId),
      fetchStream(RUST_BASE, c.type, c.streamId),
    ]);

    // Pequena pausa para garantir SWR assentado
    await new Promise((r) => setTimeout(r, 400));

    // 2ª passada (leitura SWR aquecida)
    const [nodeRes, rustRes] = await Promise.all([
      fetchStream(NODE_BASE, c.type, c.streamId),
      fetchStream(RUST_BASE, c.type, c.streamId),
    ]);

    const nodeHashes = nodeRes.streams.map(extractHash).filter(Boolean);
    const rustHashes = rustRes.streams.map(extractHash).filter(Boolean);

    const nodeBrCount = nodeRes.streams.filter(isBrStream).length;
    const rustBrCount = rustRes.streams.filter(isBrStream).length;

    // Coincidência de hashes
    const commonHashes = rustHashes.filter((h) => nodeHashes.includes(h));
    const matchPct = nodeHashes.length > 0
      ? Math.round((commonHashes.length / nodeHashes.length) * 100)
      : (rustHashes.length === 0 ? 100 : 0);

    // Ordem dos Top 3
    const top3Matches = [0, 1, 2].every((idx) => {
      if (idx >= nodeHashes.length && idx >= rustHashes.length) return true;
      return nodeHashes[idx] === rustHashes[idx];
    });

    const status = (nodeRes.ok && rustRes.ok)
      ? (matchPct >= 80 && Math.abs(nodeBrCount - rustBrCount) <= 1 ? 'PARIDADE' : 'DIVERGENCIA')
      : 'ERRO_HTTP';

    results.push({
      case: c,
      node: { ms: nodeRes.ms, total: nodeHashes.length, br: nodeBrCount, ok: nodeRes.ok },
      rust: { ms: rustRes.ms, total: rustHashes.length, br: rustBrCount, ok: rustRes.ok },
      matchPct,
      top3Matches,
      status,
    });

    console.log(`[${status}] Node: ${nodeHashes.length} (${nodeBrCount} BR) ${nodeRes.ms}ms | Rust: ${rustHashes.length} (${rustBrCount} BR) ${rustRes.ms}ms | Match: ${matchPct}%`);
  }

  console.log('\n' + '='.repeat(95));
  console.log('RESUMO FINAL:');
  let paridadeCount = 0;
  for (const r of results) {
    if (r.status === 'PARIDADE') paridadeCount++;
  }
  console.log(`Paridade alcançada em ${paridadeCount}/${results.length} casos.`);
  console.log('='.repeat(95));

  if (paridadeCount < results.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Falha na execução:', err);
  process.exit(1);
});
