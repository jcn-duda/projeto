// O app Power Movie espera 17s (2026-10-04); o Stremio aborta perto de 10s.
// Só o cliente do app (User-Agent Dart) ganha o prazo maior.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import config from '../src/config.js';
import * as runtime from '../src/runtime.js';

test('User-Agent do app ganha o prazo dele; Stremio e vazio ficam no padrão', () => {
  assert.equal(runtime.clientReplyDeadline('Dart/3.13 (dart:io)'), config.appReplyDeadline);
  assert.equal(runtime.clientReplyDeadline('Mozilla/5.0 Stremio/4.4.168'), null);
  assert.equal(runtime.clientReplyDeadline('libmpv'), null);
  assert.equal(runtime.clientReplyDeadline(undefined), null);
});

test('o prazo da requisição vem do contexto; fora dele, o REPLY_DEADLINE', () => {
  assert.equal(runtime.replyDeadline(), config.replyDeadline);
  runtime.run({ replyDeadlineMs: 15000 }, () => assert.equal(runtime.replyDeadline(), 15000));
  runtime.run({ replyDeadlineMs: null }, () => assert.equal(runtime.replyDeadline(), config.replyDeadline));
});

test('APP_REPLY_DEADLINE_MS=0 desliga e regex inválida não derruba', () => {
  const mutable = config as { appReplyDeadline: number; appClientUa: string };
  const before = { ms: mutable.appReplyDeadline, ua: mutable.appClientUa };
  try {
    mutable.appReplyDeadline = 0;
    assert.equal(runtime.clientReplyDeadline('Dart/3.13 (dart:io)'), null);
    mutable.appReplyDeadline = 15000;
    mutable.appClientUa = '([';
    assert.equal(runtime.clientReplyDeadline('Dart/3.13 (dart:io)'), null);
  } finally {
    mutable.appReplyDeadline = before.ms;
    mutable.appClientUa = before.ua;
  }
});

test('o prazo do app cabe nos 17s com folga', () => {
  assert.ok(config.appReplyDeadline > config.replyDeadline);
  assert.ok(config.appReplyDeadline <= 17000 - 1500);
});
