#!/usr/bin/env node
/**
 * Limpeza de magnets SEM áudio pt-BR na conta AllDebrid.
 *
 * A conta enche com o que o autofetch baixa pelo pool de swarm e com checagem
 * de cache que vira upload: release estrangeira que ninguém assiste ocupa vaga
 * do que interessa. Este script classifica pelo TÍTULO com os MESMOS
 * classificadores calibrados do addon (src/utils/audio-quality.ts) — uma
 * segunda lista aqui divergiria da busca.
 *
 * Baldes:
 *   dub  — dublado/nacional/dual+PT explícito (looksPtBr). NUNCA entra na mira.
 *   dual — Dual/Multi sem PT ao lado. Ambíguo: fica por padrão.
 *   pt   — sem marca de áudio, mas com sinal de português no título (post BR
 *          sem marcação é o padrão dos sites). Fica por padrão.
 *   lixo — legendado, áudio estrangeiro explícito, ou sem marca NEM sinal de
 *          PT. É isso que sai com --apply.
 *
 * Só lista, por padrão. Apagar exige --apply: a remoção é definitiva.
 *
 *   node scripts/clean-undubbed.js                          # inventário por balde
 *   node scripts/clean-undubbed.js --apply                  # apaga o balde lixo
 *   node scripts/clean-undubbed.js --include-dual --apply   # dual ambíguo junto
 *   node scripts/clean-undubbed.js --include-unmarked --apply
 *   node scripts/clean-undubbed.js --limit 100 --apply      # teto por rodada
 *
 * Expurgo do anti-reenchimento (8.14): hash que a limpeza intencional apagou
 * fica marcado em `adrm:v1` para NÃO voltar ao /magnet/upload. Liberar um
 * hash (ex.: o marcador pegou algo que voltou a ser útil) não toca a conta:
 *
 *   node scripts/clean-undubbed.js --unblock <hash>         # um ou vários
 *   node scripts/clean-undubbed.js --unblock <hash1>,<hash2>
 *
 * Proteção: magnets com menos de --min-age horas (padrão 6 = autoFetchTtl) não
 * entram na mira — o script roda fora do processo e não vê os holds em memória
 * do autofetch; 6h é exatamente o prazo em que um hold expira.
 *
 * A chave sai de DEBRID_API_KEY (.env) ou de --key. Nada é impresso dela.
 */
import 'dotenv/config';
import { audioBucket } from '../src/utils/audio-quality.js';
import type { AudioBucket } from '../src/utils/audio-quality.js';

const API = 'https://api.alldebrid.com/v4.1';
const AGENT = 'stremio-adom';

function parseArgs(argv: string[]) {
  const args = {
    apply: false,
    includeDual: false,
    includeUnmarked: false,
    minAge: 6,
    limit: 0,
    key: '',
    unblock: [] as string[],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--include-dual') args.includeDual = true;
    else if (arg === '--include-unmarked') args.includeUnmarked = true;
    else if (arg === '--min-age') args.minAge = Number(argv[++i]);
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--key') args.key = String(argv[++i] || '');
    else if (arg === '--unblock') args.unblock.push(String(argv[++i] || ''));
  }
  return args;
}

async function call(key: string, path: string, params: Record<string, any> = {}) {
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

const fmt = (bytes: any) => {
  const n = Number(bytes) || 0;
  if (n <= 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
};

const day = (ts: any) => (ts ? new Date(Number(ts) * 1000).toISOString().slice(0, 10) : '?');

const BUCKET_LABEL: Record<AudioBucket, string> = {
  dub: 'dublado PT (mantido sempre)',
  dual: 'dual/multi sem PT (mantido por padrão)',
  pt: 'sem marca, sinal de PT (mantido por padrão)',
  lixo: 'SEM áudio PT (mira da limpeza)',
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = args.key || process.env.DEBRID_API_KEY || '';
  if (!key) {
    console.error('Sem chave. Use --key <apikey> ou defina DEBRID_API_KEY no .env.');
    process.exit(1);
  }

  // Expurgo do anti-reenchimento (8.14): modo independente da varredura —
  // misturar "liberar hash" com "apagar baldes" na mesma execução convidaria ao
  // engano. Usa a MESMA conta escopada do addon e o MESMO cache (peek/forget
  // em L1+L2); nunca toca a conta de magnets e nunca imprime a chave.
  if (args.unblock.length) {
    const hashes = args.unblock
      .flatMap((bruto) => bruto.split(/[,\s]+/))
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    if (!hashes.length) {
      console.error('Nenhum hash em --unblock.');
      process.exit(1);
    }
    const reupload = await import('../src/debrid/alldebrid-reupload.js');
    const { accountScope } = await import('../src/utils/request-key.js');
    const cacheStore = await import('../src/utils/cache.js');
    const account = accountScope(key);
    let liberados = 0;
    let semMarcador = 0;
    for (const hash of [...new Set(hashes)]) {
      if (reupload.reuploadBlocked(account, hash)) {
        reupload.forgetReuploadBlock(account, hash);
        liberados += 1;
        console.log(`  liberado: ${hash.slice(0, 16)}…`);
      } else {
        semMarcador += 1;
      }
    }
    // Fecha o L2 para o forget não se perder na fila de despejo ao sair.
    cacheStore.close();
    console.log(`Anti-reenchimento: ${liberados} hash(es) liberado(s)${semMarcador ? ` | sem marcador: ${semMarcador}` : ''}`);
    return;
  }

  const data = await call(key, '/magnet/status');
  const list: any[] = Array.isArray(data?.magnets) ? data.magnets : [];
  if (!list.length) {
    console.log('Nenhum magnet na conta.');
    return;
  }

  const nowS = Math.floor(Date.now() / 1000);
  const minAgeS = (Number.isFinite(args.minAge) ? Math.max(0, args.minAge) : 6) * 3600;

  const buckets: Record<AudioBucket, any[]> = { dub: [], dual: [], pt: [], lixo: [] };
  let recentes = 0;
  for (const m of list) {
    // Recente demais pode ser download do autofetch ainda segurado em memória:
    // o script não vê o hold, então respeita o prazo dele por idade.
    if (nowS - (Number(m.uploadDate) || 0) < minAgeS) {
      recentes += 1;
      continue;
    }
    buckets[audioBucket(String(m.filename || ''))].push(m);
  }

  const totalBytes = list.reduce((sum, m) => sum + (Number(m.size) || 0), 0);
  console.log(`Conta: ${list.length} magnet(s), ${fmt(totalBytes)} — teto AllDebrid 1000 (${Math.round((list.length / 1000) * 100)}%)`);
  if (recentes) console.log(`Protegidos por idade (< ${args.minAge}h, podem estar em download pelo addon): ${recentes}\n`);
  else console.log('');

  for (const b of ['dub', 'dual', 'pt', 'lixo'] as AudioBucket[]) {
    const bytes = buckets[b].reduce((sum, m) => sum + (Number(m.size) || 0), 0);
    console.log(`${buckets[b].length.toString().padStart(5)}  ${fmt(bytes).padStart(9)}  ${BUCKET_LABEL[b]}`);
  }

  let alvo = buckets.lixo;
  if (args.includeDual) alvo = alvo.concat(buckets.dual);
  if (args.includeUnmarked) alvo = alvo.concat(buckets.pt);
  alvo.sort((a, b) => (a.uploadDate || 0) - (b.uploadDate || 0));
  if (args.limit > 0) alvo = alvo.slice(0, args.limit);

  if (!alvo.length) {
    console.log('\nNada na mira.');
    return;
  }

  const alvoBytes = alvo.reduce((sum, m) => sum + (Number(m.size) || 0), 0);
  console.log(`\nMira: ${alvo.length} magnet(s), ${fmt(alvoBytes)} — conta cairia para ~${list.length - alvo.length} (${Math.round(((list.length - alvo.length) / 1000) * 100)}% do teto)`);
  alvo.slice(0, 15).forEach((m) => {
    console.log(`  ${day(m.uploadDate)}  ${fmt(m.size).padStart(9)}  ${String(m.filename || '').slice(0, 70)}`);
  });
  if (alvo.length > 15) console.log(`  … e mais ${alvo.length - 15}`);

  if (!args.apply) {
    console.log('\nNada foi apagado. Confira a mira e repita com --apply para apagar.');
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
  console.log(`Removidos: ${ok}${falhas ? ` | falhas: ${falhas}` : ''} | restam ~${list.length - ok}`);
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
