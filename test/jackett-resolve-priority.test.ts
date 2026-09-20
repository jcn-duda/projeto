// --- Priorização inteligente de resolução de protetores (/dl) ---
//
// Posts de sites BR frequentemente agregam múltiplos botões de download por post
// (720p, 1080p, 4K, Dual Áudio, CAM). Como o Adom possui um teto de downloads
// a resolver por indexer (`config.jackett.maxDownloadResolves`), os candidatos
// devem ser priorizados antes do corte pelo teto para que qualidades superiores
// (4K, 1080p, Dual Áudio, Bluray/WEB-DL) não sejam descartadas enquanto links
// inferiores (720p, SD, CAM) consomem a cota.
import { test } from 'node:test';
import assert from 'node:assert';

import config from '../src/config.js';
import jackett from '../src/providers/jackett.js';
import { resolveCandidateScore } from '../src/providers/jackett-resolve.js';
import { fakeResponse, makeFetch, withJackett } from './helpers/jackett-fetch.js';

test('resolveCandidateScore prioriza qualidades superiores, dual áudio e fontes limpas', () => {
  // 1. Áudio e resolução
  const s4kDual = resolveCandidateScore({ title: 'Filme (2024) 4K 2160p Dual Áudio WEB-DL' });
  const s1080pDual = resolveCandidateScore({ title: 'Filme (2024) 1080p Dual Áudio WEB-DL' });
  const s1080pDub = resolveCandidateScore({ title: 'Filme (2024) 1080p Dublado WEB-DL' });
  const s720pDub = resolveCandidateScore({ title: 'Filme (2024) 720p Dublado WEB-DL' });
  const sSd = resolveCandidateScore({ title: 'Filme (2024) SD Dublado' });
  const sCam = resolveCandidateScore({ title: 'Filme (2024) 1080p Dual Áudio CAM' });

  assert.ok(s4kDual > s1080pDual, `4K Dual (${s4kDual}) deve superar 1080p Dual (${s1080pDual})`);
  assert.ok(s1080pDual > s1080pDub, `Dual (${s1080pDual}) deve superar Dublado simples (${s1080pDub})`);
  assert.ok(s1080pDub > s720pDub, `1080p (${s1080pDub}) deve superar 720p (${s720pDub})`);
  assert.ok(s720pDub > sSd, `720p (${s720pDub}) deve superar SD (${sSd})`);
  assert.ok(s1080pDub > sCam, `1080p limpo (${s1080pDub}) deve superar release CAM (${sCam})`);

  // Faixas estruturais de áudio: Dublado / Dual / Nacional NUNCA perdem para Legendado
  const s480pDub = resolveCandidateScore({ title: 'Filme (2024) 480p DUBLADO' });
  const sDubSemRes = resolveCandidateScore({ title: 'Filme (2024) [DUBLADO]' });
  const sNacSemRes = resolveCandidateScore({ title: 'Filme (2024) [NACIONAL]' });
  const s4kLegBluray = resolveCandidateScore({ title: 'Filme (2024) 2160p LEGENDADO BLU-RAY' });
  const s1080pLegBluray = resolveCandidateScore({ title: 'Filme (2024) 1080p LEGENDADO BLU-RAY' });
  const sOpcaoNeutra = resolveCandidateScore({ title: 'Filme (2024) [opcao 3]' });

  assert.ok(s480pDub > s4kLegBluray, `Dublado 480p (${s480pDub}) deve superar Legendado 4K BluRay (${s4kLegBluray})`);
  assert.ok(sDubSemRes > s4kLegBluray, `[DUBLADO] sem resolução (${sDubSemRes}) deve superar Legendado 4K BluRay (${s4kLegBluray})`);
  assert.ok(sNacSemRes > s4kLegBluray, `[NACIONAL] sem resolução (${sNacSemRes}) deve superar Legendado 4K BluRay (${s4kLegBluray})`);

  // Faixas: dublado (qualquer) > legendado 1080p BluRay > CAM 1080p Dual/sem áudio.
  // Qualidade ordena DENTRO da faixa (legendado 4K > legendado 720p; ambos > CAM).
  const sCamDual = resolveCandidateScore({ title: 'Filme (2024) 1080p Dual Áudio CAM' });
  const sCamNude = resolveCandidateScore({ title: 'Filme (2024) 1080p CAM' });
  const sLeg720 = resolveCandidateScore({ title: 'Filme (2024) 720p LEGENDADO WEB-DL' });
  assert.ok(s480pDub > s1080pLegBluray, `Dublado 480p (${s480pDub}) > Legendado 1080p BluRay (${s1080pLegBluray})`);
  assert.ok(s1080pLegBluray > sCamDual, `Legendado 1080p BluRay (${s1080pLegBluray}) > CAM Dual (${sCamDual})`);
  assert.ok(s1080pLegBluray > sCamNude, `Legendado 1080p BluRay (${s1080pLegBluray}) > CAM sem áudio (${sCamNude})`);
  assert.ok(s4kLegBluray > sLeg720, `Legendado 4K (${s4kLegBluray}) > Legendado 720p (${sLeg720})`);
  assert.ok(sLeg720 > sCamDual, `Legendado 720p (${sLeg720}) > qualquer CAM Dual (${sCamDual})`);
  assert.ok(s4kLegBluray > sCamDual, `Legendado 4K (${s4kLegBluray}) > qualquer CAM Dual (${sCamDual})`);

  // Botões neutros sem metadados típicos de posts BR ([Opção 3]) não devem ficar atrás de legendado declarado
  assert.ok(sOpcaoNeutra > s1080pLegBluray, `Opção neutra (${sOpcaoNeutra}) deve superar Legendado 1080p BluRay (${s1080pLegBluray})`);
  assert.ok(sOpcaoNeutra > s4kLegBluray, `Opção neutra (${sOpcaoNeutra}) deve superar Legendado 4K BluRay (${s4kLegBluray})`);

  // 2. Fontes: BluRay > WEB-DL > WEBRip/HDTV > CAM
  const bluray = resolveCandidateScore({ title: 'Filme (2024) 1080p Dual BluRay' });
  const webdl = resolveCandidateScore({ title: 'Filme (2024) 1080p Dual WEB-DL' });
  const webrip = resolveCandidateScore({ title: 'Filme (2024) 1080p Dual WEBRip' });
  assert.ok(bluray > webdl, `BluRay (${bluray}) deve superar WEB-DL (${webdl})`);
  assert.ok(webdl > webrip, `WEB-DL (${webdl}) deve superar WEBRip (${webrip})`);

  // 3. Séries com episódio exato recebem bônus principal
  const epMatch = resolveCandidateScore(
    { title: 'Serie S01E01 1080p Dual' },
    { season: 1, episode: 1 },
  );
  const packMatch = resolveCandidateScore(
    { title: 'Serie 1ª Temporada Completa 1080p Dual' },
    { season: 1, episode: 1 },
  );
  const otherEp = resolveCandidateScore(
    { title: 'Serie S01E05 1080p Dual' },
    { season: 1, episode: 1 },
  );
  assert.ok(epMatch > packMatch, `Episódio exato (${epMatch}) deve superar pack (${packMatch})`);
  assert.ok(packMatch > otherEp, `Pack (${packMatch}) deve superar outro episódio (${otherEp})`);
});

test('resolveCardigannDownloads seleciona os melhores candidatos respeitando maxDownloadResolves', async () => {
  const fetchImpl = makeFetch();
  const savedMax = config.jackett.maxDownloadResolves;
  config.jackett.maxDownloadResolves = 2; // Teto restrito de 2 downloads

  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      // Simula um post com múltiplos botões na ordem típica de sites BR (720p primeiro, 1080p depois, CAM)
      return fakeResponse({
        Results: [
          { Title: 'Deadpool 3 (2024) 720p Dublado CAM', Seeders: 1, Link: 'http://protector.test/dl-cam' },
          { Title: 'Deadpool 3 (2024) 720p Dublado WEBRip', Seeders: 2, Link: 'http://protector.test/dl-720p' },
          { Title: 'Deadpool 3 (2024) 1080p Dual Áudio WEB-DL', Seeders: 5, Link: 'http://protector.test/dl-1080p' },
          { Title: 'Deadpool 3 (2024) 2160p 4K Dual Áudio BluRay', Seeders: 3, Link: 'http://protector.test/dl-4k' },
        ],
      });
    }
    const magnet = 'magnet:?xt=urn:btih:' + 'b'.repeat(40) + '&dn=Resolved';
    return fakeResponse(null, { location: magnet });
  };

  try {
    await withJackett(fetchImpl, async () => {
      const items = await jackett.search('Deadpool 3 2024', 'movie', ['bludv-cardigann'], {
        matchContext: { names: ['Deadpool 3', 'Deadpool & Wolverine'], year: 2024, isSeries: false, season: null, episode: null },
      });

      // Com maxDownloadResolves = 2, devem ter sido resolvidos exatamente os 2 melhores:
      // 1º 4K Dual Áudio BluRay e 2º 1080p Dual Áudio WEB-DL
      const resolvedUrls = fetchImpl.protectorCalls();
      assert.equal(resolvedUrls.length, 2, 'deve resolver exatamente 2 itens');
      assert.ok(resolvedUrls.includes('http://protector.test/dl-4k'), 'deve resolver 4k');
      assert.ok(resolvedUrls.includes('http://protector.test/dl-1080p'), 'deve resolver 1080p');
      assert.ok(!resolvedUrls.includes('http://protector.test/dl-720p'), 'não deve desperdiçar cota com 720p');
      assert.ok(!resolvedUrls.includes('http://protector.test/dl-cam'), 'não deve desperdiçar cota com CAM');

      assert.equal(items.length, 2);
      assert.equal(items[0].title, 'Deadpool 3 (2024) 2160p 4K Dual Áudio BluRay');
      assert.equal(items[1].title, 'Deadpool 3 (2024) 1080p Dual Áudio WEB-DL');
    });
  } finally {
    config.jackett.maxDownloadResolves = savedMax;
  }
});

test('estabilidade da ordenação preserva ordem relativa original entre itens com mesmo score', async () => {
  const fetchImpl = makeFetch();
  const savedMax = config.jackett.maxDownloadResolves;
  config.jackett.maxDownloadResolves = 2;

  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({
        Results: [
          { Title: 'Oppenheimer (2023) 1080p Dual Áudio WEB-DL [Opção 1]', Seeders: 1, Link: 'http://protector.test/op1' },
          { Title: 'Oppenheimer (2023) 1080p Dual Áudio WEB-DL [Opção 2]', Seeders: 1, Link: 'http://protector.test/op2' },
          { Title: 'Oppenheimer (2023) 1080p Dual Áudio WEB-DL [Opção 3]', Seeders: 1, Link: 'http://protector.test/op3' },
        ],
      });
    }
    const magnet = 'magnet:?xt=urn:btih:' + 'c'.repeat(40) + '&dn=Resolved';
    return fakeResponse(null, { location: magnet });
  };

  try {
    await withJackett(fetchImpl, async () => {
      const items = await jackett.search('Oppenheimer 2023', 'movie', ['bludv-cardigann'], {
        matchContext: { names: ['Oppenheimer'], year: 2023, isSeries: false, season: null, episode: null },
      });

      const resolvedUrls = fetchImpl.protectorCalls();
      assert.equal(resolvedUrls.length, 2);
      assert.equal(resolvedUrls[0], 'http://protector.test/op1', 'primeiro da ordem original');
      assert.equal(resolvedUrls[1], 'http://protector.test/op2', 'segundo da ordem original');

      assert.equal(items.length, 2);
      assert.equal(items[0].title, 'Oppenheimer (2023) 1080p Dual Áudio WEB-DL [Opção 1]');
      assert.equal(items[1].title, 'Oppenheimer (2023) 1080p Dual Áudio WEB-DL [Opção 2]');
    });
  } finally {
    config.jackett.maxDownloadResolves = savedMax;
  }
});
