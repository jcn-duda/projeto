#!/usr/bin/env node
/**
 * Inventário e limpeza dos magnets da conta AllDebrid.
 *
 * Existe porque a checagem de cache da AllDebrid é um /magnet/upload: com a
 * conta no teto ("Magnets limit reached (1000 accross all tabs)") a checagem
 * inteira falha, o ⚡ some de todos os streams e o play para de resolver. O
 * dropUncached do addon só limpa o que ELE mesmo subiu numa checagem que
 * funcionou — quando a conta já encheu, o círculo não se fecha sozinho.
 *
 * Só lista, por padrão. Apagar exige --apply escrito à mão: a remoção é
 * definitiva e o que sai daqui não volta.
 *
 *   node scripts/magnets.js                    # inventário
 *   node scripts/magnets.js --older 50         # o que os 50% mais antigos seriam
 *   node scripts/magnets.js --older 50 --apply # apaga esses 50%
 *   node scripts/magnets.js --all --apply      # apaga todos
 *
 * A chave sai de DEBRID_API_KEY (.env) ou de --key. Nada é impresso dela.
 */
const API = 'https://api.alldebrid.com/v4.1';
const AGENT = 'stremio-adom';

function parseArgs(argv) {
  const args = { older: null, all: false, apply: false, key: '', keep: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') args.all = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--older') args.older = Number(argv[++i]);
    else if (arg === '--keep') args.keep = Number(argv[++i]);
    else if (arg === '--key') args.key = String(argv[++i] || '');
  }
  return args;
}

async function call(key, path, params = {}) {
  const url = new URL(`${API}${path}`);
  url.searchParams.set('agent', AGENT);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json();
  if (data.status === 'error') {
    throw new Error(data.error?.message || data.error?.code || `HTTP ${res.status}`);
  }
  return data.data;
}

const fmt = (bytes) => {
  const n = Number(bytes) || 0;
  if (n <= 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
};

const day = (ts) => (ts ? new Date(Number(ts) * 1000).toISOString().slice(0, 10) : '?');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let key = args.key;
  if (!key) {
    try {
      require('dotenv').config();
    } catch { /* sem dotenv: a chave tem que vir por --key ou pelo ambiente */ }
    key = process.env.DEBRID_API_KEY || '';
  }
  if (!key) {
    console.error('Sem chave. Use --key <apikey> ou defina DEBRID_API_KEY no .env.');
    process.exit(1);
  }

  const data = await call(key, '/magnet/status');
  const list = Array.isArray(data?.magnets) ? data.magnets : [];
  if (!list.length) {
    console.log('Nenhum magnet na conta.');
    return;
  }

  // Mais antigo primeiro: é o que sai quando o pedido é "os N% antigos".
  const magnets = [...list].sort((a, b) => (a.uploadDate || 0) - (b.uploadDate || 0));
  const ready = magnets.filter((m) => m.ready || m.status === 'Ready');
  const totalBytes = magnets.reduce((sum, m) => sum + (Number(m.size) || 0), 0);

  console.log(`Conta: ${magnets.length} magnet(s) — ${ready.length} prontos, ${fmt(totalBytes)}`);
  console.log(`Mais antigo: ${day(magnets[0].uploadDate)} | mais novo: ${day(magnets[magnets.length - 1].uploadDate)}`);
  console.log(`Limite da AllDebrid: 1000 (${Math.round((magnets.length / 1000) * 100)}% ocupado)\n`);

  let alvo = [];
  if (args.all) alvo = magnets;
  else if (args.older > 0) alvo = magnets.slice(0, Math.floor((magnets.length * args.older) / 100));
  else if (args.keep > 0) alvo = magnets.slice(0, Math.max(0, magnets.length - args.keep));

  if (!alvo.length) {
    console.log('Nada selecionado. Use --older <pct>, --keep <n> ou --all.');
    console.log('Os 10 mais antigos:');
    magnets.slice(0, 10).forEach((m) => {
      console.log(`  ${day(m.uploadDate)}  ${fmt(m.size).padStart(9)}  ${String(m.filename || '').slice(0, 60)}`);
    });
    return;
  }

  const alvoBytes = alvo.reduce((sum, m) => sum + (Number(m.size) || 0), 0);
  console.log(`Selecionados: ${alvo.length} magnet(s), ${fmt(alvoBytes)} — de ${day(alvo[0].uploadDate)} a ${day(alvo[alvo.length - 1].uploadDate)}`);
  alvo.slice(0, 8).forEach((m) => {
    console.log(`  ${day(m.uploadDate)}  ${fmt(m.size).padStart(9)}  ${String(m.filename || '').slice(0, 60)}`);
  });
  if (alvo.length > 8) console.log(`  … e mais ${alvo.length - 8}`);

  if (!args.apply) {
    console.log(`\nNada foi apagado. Para apagar de verdade, repita com --apply.`);
    return;
  }

  console.log(`\nApagando ${alvo.length}…`);
  let ok = 0;
  let falhas = 0;
  for (const magnet of alvo) {
    try {
      await call(key, '/magnet/delete', { id: magnet.id });
      ok += 1;
      if (ok % 50 === 0) console.log(`  ${ok}/${alvo.length}`);
    } catch (err) {
      falhas += 1;
      if (falhas <= 3) console.error(`  falha em ${magnet.id}: ${err.message}`);
    }
  }
  console.log(`Removidos: ${ok}${falhas ? ` | falhas: ${falhas}` : ''} | restam ~${magnets.length - ok}`);
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
