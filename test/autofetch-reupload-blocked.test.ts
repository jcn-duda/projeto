// Chupim × anti-reenchimento (`adrm`). Hash que a limpeza apagou de propósito
// é recusado pelo `enqueue`; se ele continuasse candidato, o Chupim parava
// nele a cada busca e nunca tentava o próximo viável. Medido em 2026-10-24:
// Lanterns S01E08 preso num pack russo morto (`Lanterns.S01.WEB-DLRip.Dub.WM`,
// kickasstorrents-to, 0 seeds) com um 1080p de 3522 seeds esperando na fila.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../src/runtime.js';
import * as metrics from '../src/utils/metrics.js';
import * as held from '../src/debrid/protected.js';
import { accountScope } from '../src/utils/request-key.js';
import { autoFetchCandidates } from '../src/providers/autofetch-runner.js';
import { forgetReuploadBlock, markReuploadBlocked } from '../src/debrid/alldebrid-reupload.js';

const API_KEY = 'chave-reupload-chupim';
const account = accountScope(API_KEY);
const BLOQUEADO = 'b'.repeat(40);
const VIAVEL = 'c'.repeat(40);
const counter = (key: string) => metrics.snapshot().counters[key] || 0;

const run = (fn: () => unknown) => runtime.run(
  {
    opts: {
      ...runtime.defaults(),
      debridService: 'premiumize',
      debridApiKey: API_KEY,
      dubbedOnly: false,
      debridCachedOnly: true,
      autoFetchBr: true,
    },
    encoded: 'cfg',
  },
  fn,
);

const brDub = (infoHash: string) => ({
  infoHash,
  name: '1080p DUB BR · Rede Torrent',
  title: 'Lanterns.2026.S01E08.1080p.WEB-DL.DUBLADO.PT.BR',
  _br: true,
  _dubbed: true,
  _quality: '1080p',
});

afterEach(() => {
  forgetReuploadBlock(account, BLOQUEADO);
  held.release(BLOQUEADO, account);
  held.release(VIAVEL, account);
});

test('hash bloqueado para re-upload não vira candidato; o próximo viável é escolhido', async () => {
  assert.equal(markReuploadBlocked(account, BLOQUEADO, 'Lanterns.S01.WEB-DLRip.Dub.WM'), true, 'marca adrm gravada');
  const antes = counter('autofetch.reupload-blocked-skipped');

  const out = (await run(() => autoFetchCandidates([brDub(BLOQUEADO), brDub(VIAVEL)] as any, {}))) as Array<
    { stream: { infoHash?: string }; pool: string }
  >;

  const hashes = out.map((c) => String(c.stream.infoHash).toLowerCase());
  assert.ok(!hashes.includes(BLOQUEADO), 'o hash apagado de propósito não volta como candidato');
  assert.ok(hashes.includes(VIAVEL), 'o Chupim segue para o próximo viável');
  assert.ok(counter('autofetch.reupload-blocked-skipped') > antes, 'o corte fica mensurado');
  assert.equal(held.isHeld(BLOQUEADO, account), false, 'nenhum hold para o bloqueado');
});

test('sem marca, o mesmo hash continua elegível (o filtro não corta à toa)', async () => {
  const out = (await run(() => autoFetchCandidates([brDub(BLOQUEADO)] as any, {}))) as Array<
    { stream: { infoHash?: string } }
  >;
  assert.equal(out.length, 1);
  assert.equal(String(out[0].stream.infoHash).toLowerCase(), BLOQUEADO);
});
