// Dual + idioma estrangeiro NOMEADO — o falso positivo do catálogo e da limpeza.
//
// O balde `dual` aceitava Dual/Multi SEM olhar qual idioma acompanhava o Dual,
// e o marcador `dual` de `hasPtAudioMark` absolvia o título no `foreignVerdict`:
// `Serenity … [Dual Audio] [Hindi DD 5.1]` ficava preso nos ~452 ambíguos do
// painel com `foreignProof` vazio — intocável pela Limpeza BR e pelo sweep.
//
// Os dois buracos têm consertos de força DIFERENTE de propósito, e este arquivo
// trava a fronteira entre eles:
//   - o BALDE usa o núcleo da guarda AMPLA (sem `MULTI`) → rebaixa para `lixo`,
//     que é triagem (painel + `clean-undubbed`);
//   - a CONDENAÇÃO destrutiva (`foreignVerdict`) continua exigindo a lista
//     MÍNIMA `hasExplicitForeignAudio` → Tamil/Korean/cirílico NUNCA apagam.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  audioBucket, audioFromTitle, looksPtBr, foreignVerdict, hasExplicitForeignAudio,
  hasPtAudioMark, dubbedLieVerdict,
} from '../src/utils/audio-quality.js';
import { classifyByTitle } from '../src/utils/catalog-classify.js';

const SERENITY = 'Serenity.2023.1080p.WEBRip.x264 [Dual Audio] [Hindi DD 5.1] [HDRip-1337x][TorrentCounter].mkv';

test('Dual/HINDI: o scan por título grava a prova estrangeira na linha do catálogo', () => {
  // Integração com o que fica persistido: `planForeignCleanup` filtra por
  // `foreignProof`, não por balde — prova vazia era o motivo de o item nunca
  // aparecer na prévia da Limpeza BR.
  const proof = classifyByTitle(SERENITY);
  assert.equal(proof.bucket, 'lixo');
  assert.equal(proof.foreignProof, 'audio', 'condenado pelo idioma nomeado, não por marca de cena');
  assert.equal(proof.ptProof, '', 'o marcador `dual` não absolve mais sob HINDI');
});

test('Dual/idioma: triagem ampla no balde, condenação só com o token da mínima', () => {
  // Tamil/Korean/Telugu entram no `lixo` da triagem e seguem `unknown` — um
  // idioma só entra na mínima depois de aparecer numa medição real.
  for (const t of [
    'Movie.2024.DUAL.Tamil.1080p.WEB-DL',
    'Movie.2024.DUAL.Korean.1080p.WEB-DL',
    'Movie.2024.Dual.Audio.Telugu.1080p.BluRay',
  ]) {
    assert.equal(audioBucket(t), 'lixo', `${t}: idioma nomeado rebaixa o balde`);
    assert.equal(audioFromTitle(t), 'Dual', `${t}: o rótulo de áudio não muda`);
    assert.equal(looksPtBr(t), false, `${t}: nunca promete BR`);
    assert.equal(foreignVerdict(t), 'unknown', `${t}: fora da mínima, nunca apaga`);
    assert.equal(hasExplicitForeignAudio(t), false, `${t}: a lista mínima não expandiu`);
    assert.equal(dubbedLieVerdict([t], true).lie, false, `${t}: sem grupo de cena EN não é lie`);
  }
  // CIRÍLICO + Dual: o SCRIPT nomeia uma língua que não é o português (balde),
  // mas script não é prova de idioma — o veredito continua `unknown`.
  const ciriloDual = 'Фильм 2024 DUAL 1080p WEB-DL';
  assert.equal(audioBucket(ciriloDual), 'lixo');
  assert.equal(foreignVerdict(ciriloDual), 'unknown');
});

test('Dual/idioma: MULTI puro e o padrão BR dominante não mudam de lado', () => {
  // As invariantes que a guarda NÃO pode tocar.
  assert.equal(audioBucket('Movie.2024.MULTI.1080p.BluRay.x264'), 'dual', 'MULTI sozinho afirma faixas, não idioma');
  assert.equal(audioBucket('The.Boys.S05E01-02.1080p.WEB-DL.DUAL.5.1'), 'dual', 'a classe dos duals ambíguos da conta');
  assert.equal(foreignVerdict('The.Boys.S05E01-02.1080p.WEB-DL.DUAL.5.1'), 'absolve', 'DUAL sem idioma segue marcador PT');
  assert.equal(hasPtAudioMark('Coringa.2019.1080p.AMZN.WEB-DL.DUAL.5.1.x264.mkv'), true, 'o padrão do WEB-DL dublado BR');
  assert.equal(audioBucket('Guardiões da Galáxia - Vol. 3 2023 1080p BluRay DUAL 5.1'), 'dub', 'Dual + PT vence ANTES da guarda');
});

test('Dual/idioma: a guarda do path acompanha a do título também para o dual', () => {
  assert.equal(hasPtAudioMark('Serenity.2023.1080p.WEBRip.Dual.Audio.Hindi.DD.5.1.mkv'), false, 'dual audio sob HINDI não prova PT');
  assert.equal(hasPtAudioMark('Serenity.2023.1080p.Dual.Hindi.Dublado.mkv'), true, 'marcador explícito vence o idioma');
  assert.equal(hasPtAudioMark('Фильм.2024.Dual.1080p.WEB-DL.mkv'), false, 'cirílico desmente o dual genérico no path');
});
