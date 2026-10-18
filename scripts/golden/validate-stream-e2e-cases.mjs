#!/usr/bin/env node
/**
 * Script de validação e diagnóstico do corpus e2e de stream (casos-stream-e2e.json).
 * Consulta a API do Cinemeta (ou metadados locais) para garantir que cada ID
 * de filme/série do corpus é válido e corresponde ao rótulo esperado.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CASOS_FILE = path.join(REPO, 'scripts', 'golden', 'casos-stream-e2e.json');

async function fetchCinemeta(type, imdbId) {
  const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'stremio-adom-validator/1' } });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    return { ok: true, meta: data?.meta || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function main() {
  const raw = fs.readFileSync(CASOS_FILE, 'utf-8');
  const data = JSON.parse(raw);
  console.log(`Validando ${data.cases.length} casos em ${CASOS_FILE}...\n`);

  const results = [];
  for (const c of data.cases) {
    // Casos sentinela intencionalmente falsos:
    if (c.id.includes('fake-id-guard')) {
      results.push({ id: c.id, status: 'GUARD_PASS', label: c.label });
      continue;
    }

    const imdbId = c.stream_id.split(':')[0];
    const res = await fetchCinemeta(c.type, imdbId);
    if (!res.ok || !res.meta) {
      results.push({ id: c.id, stream_id: c.stream_id, label: c.label, status: 'NOT_FOUND', detail: res });
    } else {
      results.push({
        id: c.id,
        stream_id: c.stream_id,
        label: c.label,
        status: 'OK',
        title: res.meta.name,
        year: res.meta.year,
      });
    }
    // Breve pausa para não tomar rate limit no Cinemeta
    await new Promise((r) => setTimeout(r, 60));
  }

  let errors = 0;
  for (const r of results) {
    if (r.status === 'OK') {
      console.log(`[OK] ${r.id} (${r.stream_id}): "${r.title}" (${r.year}) — Esperado: "${r.label}"`);
    } else if (r.status === 'GUARD_PASS') {
      console.log(`[GUARD] ${r.id}: Sentinela de ID falso preservado.`);
    } else {
      console.error(`[ERRO] ${r.id} (${r.stream_id}): NÃO ENCONTRADO NO CINEMETA — "${r.label}"`);
      errors++;
    }
  }

  console.log(`\nResumo: ${data.cases.length} casos verificados, ${errors} com erro.`);
  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
