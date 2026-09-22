#!/usr/bin/env node
/**
 * Protótipo offline: Jev julga "post prometeu dublado BR × arquivos parecem EN?".
 * Uso: node --env-file=.env scripts/jev-dub-lie-probe.mjs
 * Não entra no npm test (rede + chave). Threshold default 0.55.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API = 'https://api.typesafe.ai/v1/systemone';
const THRESHOLD = Number(process.env.JEV_DUB_LIE_THRESHOLD || 0.55);

function loadKey() {
  if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    const m = raw.match(/^TYPESAFE_API_KEY=(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
}

/** Casos no formato que o audit do Adom vê: promessa do post + paths reais. */
const CASES = [
  // --- lies (esperado: noul alto) — medidos / casos do AGENTS + e2e ---
  {
    id: 'lie-td-rarbg',
    expectLie: true,
    post: 'True Detective 4ª Temporada (2024) DUBLADO 1080p',
    indexer: 'nerdfilmes',
    files: ['True.Detective.S03E04.1080p.WEBRip.x264.DD5.1-RARBG.mkv'],
  },
  {
    id: 'lie-td-killers',
    expectLie: true,
    post: 'True Detective 4ª Temporada Completa Dublado Dual Áudio',
    indexer: 'comandotorrents',
    files: ['True.Detective.S03E01.1080p.BluRay.x264-KILLERS.mkv'],
  },
  {
    id: 'lie-td-afm72',
    expectLie: true,
    post: '[WWW.BLUDV.TV] True Detective 4ª Temporada DUBLADO',
    indexer: 'bludv',
    files: ['True.Detective.2014.S03E06.720p.HDTV.x264-afm72.mkv'],
  },
  {
    id: 'lie-td-tovar',
    expectLie: true,
    post: 'True Detective S04 Dublado 1080p WEB-DL',
    indexer: 'redetorrent-cardigann',
    files: ['True.Detective.S03E03.1080p.WEB.h264-ToVaR.mkv'],
  },
  {
    id: 'lie-metcon',
    expectLie: true,
    post: 'True Detective S03E03 1080p BR',
    indexer: 'redetorrent-cardigann',
    files: ['True.Detective.S03E03.1080p.WEB.H264-METCON.mkv'],
  },
  {
    id: 'lie-crow-wrong-year',
    expectLie: true,
    post: 'O Corvo (2024) Dublado Dual Áudio 1080p',
    indexer: 'hdrtorrent-cardigann',
    files: ['The.Crow.1994.1080p.BluRay.x264.DTS-FGT.mkv'],
  },
  {
    id: 'lie-yify-under-br-post',
    expectLie: true,
    post: 'Fallout 1ª Temporada Dublada e Dual 1080p',
    indexer: 'nerdfilmes',
    files: ['Fallout.S01E01.1080p.WEB.h264-ETHEL.mkv', 'Fallout.S01E02.1080p.WEB.h264-ETHEL.mkv'],
  },
  {
    id: 'lie-promo-only',
    expectLie: true,
    post: 'House of the Dragon S01E01 DUBLADO 1080p',
    indexer: 'comandotorrents',
    files: [
      'House.of.the.Dragon.S01E01.1080p.FULL.WEB-DL.DUAL.5.1/1XBET.COM_promo_SHREK.mp4',
      'House.of.the.Dragon.S01E01.1080p.FULL.WEB-DL.x264-FLUX.mkv',
    ],
  },
  {
    id: 'lie-english-scene-pack',
    expectLie: true,
    post: 'Goliath 3ª Temporada Completa Dublado',
    indexer: 'torrentdosfilmesv2',
    files: ['Goliath.S02E01.1080p.WEB.x264-ION10.mkv'],
  },
  {
    id: 'lie-sparks',
    expectLie: true,
    post: 'Oppenheimer (2023) Dublado 2160p',
    indexer: 'vacatorrent',
    files: ['Oppenheimer.2023.2160p.MA.WEB-DL.DDP5.1.Atmos.H265-SPARKS.mkv'],
  },
  // --- honest (esperado: noul baixo) ---
  {
    id: 'ok-dual-audio-br',
    expectLie: false,
    post: 'Trilogia - Se Beber, Não Case! (2009-2013) 5.1 BluRay Dual Áudio 1080p',
    indexer: 'bludv',
    files: ['Se.Beber.Nao.Case.1.2009.1080p.BluRay.Dual.Audio.BR.mkv'],
  },
  {
    id: 'ok-dublado-explicit',
    expectLie: false,
    post: 'Coringa (2019) Dublado 1080p BluRay',
    indexer: 'nerdfilmes',
    files: ['Coringa.2019.1080p.BluRay.Dublado.BR.mkv'],
  },
  {
    id: 'ok-ptbr-mark',
    expectLie: false,
    post: 'Fallout 1ª Temporada (2024) Dual Áudio 1080p',
    indexer: 'comandotorrents',
    files: ['Fallout.S01E01.1080p.WEB-DL.Dual.Audio.PT-BR.mkv'],
  },
  {
    id: 'ok-nacional',
    expectLie: false,
    post: 'Cidade de Deus (2002) Dual Áudio 1080p',
    indexer: 'bludv',
    files: ['Cidade.de.Deus.2002.1080p.BluRay.Dual.Audio.mkv'],
  },
  {
    id: 'ok-legendado-honest',
    expectLie: false,
    post: 'Dune Part Two (2024) LEGENDADO 1080p',
    indexer: 'thepiratebay',
    files: ['Dune.Part.Two.2024.1080p.WEB.h264-ETHEL.mkv'],
  },
  {
    id: 'ok-yts-en-honest',
    expectLie: false,
    post: 'Oppenheimer 2023 1080p BluRay YTS',
    indexer: 'yts',
    files: ['Oppenheimer.2023.1080p.BluRay.x264.YTS.mkv'],
  },
  {
    id: 'ok-dual-5.1-br',
    expectLie: false,
    post: 'House of the Dragon 1ª Temporada Dual 5.1 1080p',
    indexer: 'comandotorrents',
    files: ['House.of.the.Dragon.S01E01.1080p.WEB-DL.DUAL.5.1.BR.mkv'],
  },
  {
    id: 'ok-web-dl-dublado',
    expectLie: false,
    post: 'The Bear 3ª Temporada Dublado 720p',
    indexer: 'redetorrent-cardigann',
    files: ['The.Bear.S03E01.720p.WEB-DL.Dublado.mkv'],
  },
  {
    id: 'ok-pack-same-season',
    expectLie: false,
    post: 'Fallout 1ª Temporada Completa Dual Áudio 1080p',
    indexer: 'nerdfilmes',
    files: [
      'Fallout.S01E01.1080p.WEB-DL.Dual.Audio.mkv',
      'Fallout.S01E02.1080p.WEB-DL.Dual.Audio.mkv',
    ],
  },
  {
    id: 'ok-pt-title-dual',
    expectLie: false,
    post: 'Lanternas Verdes (2011) Dual Áudio 1080p',
    indexer: 'hdrtorrent-cardigann',
    files: ['Lanternas.Verdes.2011.1080p.BluRay.Dual.Audio.mkv'],
  },
];

const QUESTIONS = {
  is_dub_lie: {
    type: 'noul',
    instructions: {
      question:
        'Did the torrent post promise Brazilian Portuguese dubbed audio, while the actual video file names indicate an English-only scene release (no PT/BR/Dual/Dublado in the real files)?',
      note:
        'Post title and indexer are the claim. File paths are the evidence after debrid lists the torrent. Dual/Dublado/PT-BR in filenames is honest BR dub. English scene groups (RARBG, KILLERS, SPARKS, METCON, ETHEL, ION10, afm72, ToVaR, YTS) without PT marks are English. If the post only says LEGENDADO or does not claim dub, that is not a lie.',
    },
    criteria: {
      true: 'Post claims DUBLADO/Dual Áudio/PT dub; files look English-only scene release',
      false: 'Honest: files match the dub claim, or post never claimed Brazilian dub',
    },
  },
};

async function ask(key, state) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ state, model: 'jev-latest', questions: QUESTIONS }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function stateOf(c) {
  return {
    post_title: c.post,
    indexer: c.indexer,
    video_files: c.files,
  };
}

async function main() {
  const key = loadKey();
  if (!key) {
    console.error('TYPESAFE_API_KEY ausente (.env ou env).');
    process.exit(2);
  }
  console.log(`casos=${CASES.length} threshold=${THRESHOLD} key_len=${key.length}`);

  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  let errors = 0;
  const rows = [];

  for (const c of CASES) {
    try {
      const out = await ask(key, stateOf(c));
      const noul = out?.answers?.is_dub_lie?.noul;
      if (typeof noul !== 'number') throw new Error(`resposta sem noul: ${JSON.stringify(out)}`);
      const predLie = noul >= THRESHOLD;
      const ok = predLie === c.expectLie;
      if (c.expectLie && predLie) tp++;
      else if (!c.expectLie && !predLie) tn++;
      else if (!c.expectLie && predLie) fp++;
      else fn++;
      const mark = ok ? 'OK' : 'MISS';
      const line = `${mark} ${c.id} expect=${c.expectLie ? 'lie' : 'ok'} noul=${noul.toFixed(3)} pred=${predLie ? 'lie' : 'ok'}`;
      console.log(line);
      rows.push({ id: c.id, expectLie: c.expectLie, noul, predLie, ok });
    } catch (e) {
      errors++;
      console.error(`ERR ${c.id}: ${e.message}`, e.body ? JSON.stringify(e.body) : '');
      if (e.status === 401 || e.status === 403) {
        console.error('Auth falhou — gere outra chave em https://typesafe.ai e atualize TYPESAFE_API_KEY no .env');
        process.exit(1);
      }
    }
  }

  const decided = tp + tn + fp + fn;
  const acc = decided ? ((tp + tn) / decided) * 100 : 0;
  console.log('---');
  console.log(`tp=${tp} tn=${tn} fp=${fp} fn=${fn} errors=${errors} acc=${acc.toFixed(1)}%`);
  if (errors && !decided) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
