// Aba Raspagens POR SITE (Fase 8 multi-site): o override de cada site, o
// veredito da sonda e o formulário que grava `crawl-config-set/reset` com
// `site` no corpo. Sem DOM e sem rede: o modelo puro é chamado direto e o
// componente de apresentação também (a casca com hooks é verificada por
// padrão de fonte, como nas demais telas do painel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ageText,
  blockedText,
  clampSiteNumber,
  globalOverride,
  overrideKey,
  probeBadge,
  probeText,
  probeVerdictOf,
  siteConfigDiff,
  siteConfigHint,
  siteFormOf,
  siteOverride,
  siteProbe,
  siteRotationLabel,
  skipText,
  SITE_CONFIG_KEYS,
  type SiteConfigForm as SiteFormValues,
} from '../src/client/painel/raspagens-site.js';
import { crawlSiteCards, crawlSummary, siteStateLabel } from '../src/client/painel/raspagens-model.js';
import { SiteConfigForm } from '../src/client/painel/view-raspagem-site-config.js';
import { expand, textOf } from './helpers/painel-vnode.js';
import { CLIENT_ASSETS } from '../src/routes/public.js';

function crawlFixture(over: Record<string, any> = {}) {
  return {
    enabled: true,
    dryRun: false,
    paused: false,
    site: 'vacatorrent',
    sitesConfigured: ['vacatorrent', 'nerdfilmes'],
    maxPerHour: 500,
    delayMs: 700,
    sites: [
      { id: 'vacatorrent', label: 'Vaca Torrent', total: 10, byStatus: { done: 10 } },
      { id: 'nerdfilmes', label: 'NerdFilmes', total: 0, byStatus: {} },
    ],
    ...over,
  };
}

test('siteOverride herda o global campo a campo e marca a divergência', () => {
  const summary = crawlSummary(crawlFixture());

  // Sem `siteConfig`: herda tudo do topo e não inventa divergência.
  const herd = siteOverride({ id: 'a' }, summary);
  assert.equal(herd.enabled, true);
  assert.equal(herd.dryRun, false);
  assert.equal(herd.delayMs, 700);
  assert.equal(herd.maxPerHour, 500);
  assert.deepEqual(herd.overridden, []);

  // `siteConfig` parcial: o que falta vem do global (não vira 0 nem false).
  const partial = siteOverride({ id: 'a', siteConfig: { delayMs: 1500 } }, summary);
  assert.equal(partial.delayMs, 1500);
  assert.equal(partial.maxPerHour, 500, 'campo ausente no siteConfig herda o global');
  assert.equal(partial.enabled, true);
  // Divergência COMPUTADA: o valor difere do global mesmo sem lista declarada.
  assert.deepEqual(partial.overridden, ['delayMs']);

  // Lista declarada também entra, mesmo sem diferença de valor.
  const declared = siteOverride({ id: 'a', siteConfig: { delayMs: 700, overridden: ['delayMs'] } }, summary);
  assert.deepEqual(declared.overridden, ['delayMs'], 'o backend declara, o painel respeita');

  // Payload ausente/não-objeto não quebra nem afirma.
  assert.equal(siteOverride(null, summary).delayMs, 700);
  assert.equal(siteOverride({ siteConfig: 'x' }, summary).delayMs, 700);
  assert.deepEqual(globalOverride(null).overridden, [], 'sem summary o global é neutro');
});

test('probeVerdictOf tolera o casing e recusa valor desconhecido', () => {
  assert.equal(probeVerdictOf('go'), 'go');
  assert.equal(probeVerdictOf('GO'), 'go');
  assert.equal(probeVerdictOf('no-go'), 'no-go');
  assert.equal(probeVerdictOf('NO_GO'), 'no-go');
  assert.equal(probeVerdictOf('inconclusive'), 'inconclusive');
  assert.equal(probeVerdictOf('CONDICIONAL'), 'inconclusive');
  assert.equal(probeVerdictOf('PENDENTE'), 'pending');
  assert.equal(probeVerdictOf('talvez'), null, 'veredito desconhecido é ausente, não "go"');
  assert.equal(probeVerdictOf(undefined), null);
});

test('siteProbe: sem veredito não afirma GO e o gate falha fechado', () => {
  const summary = crawlSummary(crawlFixture());
  const gated = (verdict?: unknown) => siteProbe({ id: 'a', probe: { required: true, verdict } }, summary);

  const none = siteProbe({ id: 'a' }, summary);
  assert.equal(none.verdict, null);
  assert.equal(none.block, false);
  assert.equal(none.inRotation, true, 'sem o gate, site sem veredito ainda roda');
  assert.equal(none.out, null);

  const blocked = gated();
  assert.equal(blocked.verdict, null, 'ausente nunca vira GO');
  assert.equal(blocked.inRotation, false, 'CRAWL_REQUIRE_PROBE sem GO = fora da rotação');
  assert.equal(blocked.out, 'sem-go');

  for (const verdict of ['no-go', 'inconclusive', 'pending']) {
    const probe = gated(verdict);
    assert.equal(probe.inRotation, false, `${verdict} não fecha o gate`);
    assert.equal(probe.out, 'sem-go');
  }
  const go = gated('go');
  assert.equal(go.inRotation, true, 'só o GO entra com o gate ligado');
  assert.equal(go.out, null);

  // `ok` decide a rotação, mas NUNCA vira veredito: o motor responde
  // `ok:true` para qualquer site com o gate desligado, mesmo sem sonda rodada.
  const semSonda = siteProbe({ id: 'a', probe: { required: false, verdict: null, ok: true, at: null } }, summary);
  assert.equal(semSonda.verdict, null, 'ok:true sem sonda não é GO');
  assert.equal(semSonda.inRotation, true, 'gate desligado: o site roda mesmo sem veredito');
  assert.deepEqual(probeBadge(semSonda), { text: 'SONDA NÃO RODADA', variant: 'neutral' });

  // O gate do topo é a reserva quando o site não traz `probe.required`.
  const legado = siteProbe({ id: 'a' }, crawlSummary(crawlFixture({ probeBlock: true })));
  assert.equal(legado.block, true);
  assert.equal(legado.out, 'sem-go');
});

test('blockedBy do gate explica a falta de liberação (o motor é a autoridade)', () => {
  const summary = crawlSummary(crawlFixture());
  const semVeredito = siteProbe({ id: 'a', probe: { required: true, verdict: null, ok: false, blockedBy: 'sem-veredito' } }, summary);
  assert.equal(semVeredito.out, 'sem-go');
  assert.equal(blockedText(semVeredito.blockedBy), 'sonda nunca rodou');
  assert.match(probeText(semVeredito), /Sem liberação: sonda nunca rodou/);

  const parcial = siteProbe({ id: 'a', probe: { required: true, verdict: 'go', ok: false, blockedBy: 'amostra-incompleta' } }, summary);
  assert.equal(parcial.out, 'sem-go', 'GO com amostra incompleta NÃO libera — o gate do motor decide');
  assert.equal(parcial.verdict, 'go', 'o veredito gravado continua visível');
  assert.match(probeText(parcial), /amostra incompleta/);

  assert.equal(blockedText(null), '');
  assert.equal(blockedText('codigo-novo'), 'codigo-novo', 'código desconhecido não vira rótulo inventado');
});

test('siteProbe: taxa ausente é null (não 0%) e site desligado sai da rotação', () => {
  const summary = crawlSummary(crawlFixture());
  const probe = siteProbe(
    { id: 'a', probe: { verdict: 'go', at: 1000, counts: { sample: 40 }, rates: { valid: 1, magnet: 0.42 } } },
    summary,
  );
  assert.equal(probe.sample, 40);
  assert.equal(probe.rates.valid, 100);
  assert.equal(probe.rates.magnet, 42);
  assert.equal(probe.rates.identify, null, 'taxa não medida é null, nunca 0%');
  assert.equal(probe.rates.magnetsPerPage, null);

  // Desligado no próprio site vale mais que o GO: a exclusão é do operador.
  const off = siteProbe({ id: 'a', siteConfig: { enabled: false }, probe: { verdict: 'go' } }, summary);
  assert.equal(off.inRotation, false);
  assert.equal(off.out, 'desligado');

  // `skipReason` do motor é a autoridade da exclusão (mesmo com o gate solto).
  const pulado = siteProbe({ id: 'a', skipReason: 'probe', probe: { verdict: 'go' } }, summary);
  assert.equal(pulado.out, 'sem-go', 'o motor pulou o site: o painel mostra o motivo dele');
  assert.equal(pulado.skip, 'probe');
  assert.equal(siteProbe({ id: 'a', skipReason: 'teto-horario' }, summary).out, null, 'teto horário não é exclusão');

  const reasons = siteProbe({ id: 'a', probe: { verdict: 'no-go', reasons: ['sem-botao-de-torrent', ''] } }, summary);
  assert.deepEqual(reasons.reasons, ['sem-botao-de-torrent'], 'string vazia some da lista');
});

test('probeBadge, probeText e ageText: ausente é neutral e diz por quê', () => {
  const summary = crawlSummary(crawlFixture());
  const open = crawlSummary(crawlFixture({ probeBlock: true }));

  assert.deepEqual(probeBadge(siteProbe({ probe: { verdict: 'go' } }, summary)), { text: 'SONDA GO', variant: 'ok' });
  assert.deepEqual(probeBadge(siteProbe({ probe: { verdict: 'no-go' } }, summary)), { text: 'SONDA SEM GO', variant: 'err' });
  assert.deepEqual(probeBadge(siteProbe({ probe: { verdict: 'inconclusive' } }, summary)), { text: 'SONDA CONDICIONAL', variant: 'warn' });
  assert.deepEqual(probeBadge(siteProbe({ probe: { verdict: 'pending' } }, summary)), { text: 'SONDA PENDENTE', variant: 'warn' });
  const virgin = probeBadge(siteProbe({}, summary));
  assert.equal(virgin.variant, 'neutral', '"não rodada" nunca é ok: ninguém mediu');

  const semVeredito = probeText(siteProbe({}, crawlSummary(crawlFixture({ probeBlock: true }))));
  assert.match(semVeredito, /fora da rotação/, 'com o gate ligado o texto diz o porquê');

  const agora = Date.now();
  const medido = probeText(
    siteProbe({ probe: { verdict: 'go', at: agora - 2 * 3_600_000, counts: { sample: 40 }, rates: { valid: 1, magnet: 0.9, identify: 0.8 } } }, summary),
    agora,
  );
  assert.match(medido, /há 2h/);
  assert.match(medido, /amostra 40/);
  assert.match(medido, /com torrent 90%/);
  assert.match(medido, /identificadas 80%/);

  const reprovado = probeText(siteProbe({ probe: { verdict: 'no-go', reasons: ['abaixo-limiar:magnet'] } }, summary), agora);
  assert.match(reprovado, /abaixo-limiar:magnet/);

  // O formato que o GATE do backend entrega (Fase 8): o painel consome o
  // veredito MEDIDO, e `null` é "não medido" (a tela omite, nunca mostra 0%).
  const gate = {
    verdict: 'go', ok: true, at: agora - 3_600_000, sample: 40, blockedBy: null,
    rates: { valid: 0.95, magnet: 0.8, identify: 0.7, magnetsPerPage: 1.4 }, reasons: ['no-work-dominante'],
  };
  const comGate = probeText(siteProbe({ probe: gate }, summary), agora);
  assert.match(comGate, /válidas 95% com torrent 80% identificadas 70%/);
  assert.match(comGate, /1\.4 magnet\(s\)\/página · no-work-dominante/, 'a média e a ressalva do GO aparecem');
  const semMedida = siteProbe({ probe: { ...gate, rates: null, reasons: [] } }, summary);
  assert.equal(semMedida.rates.valid, null);
  assert.doesNotMatch(probeText(semMedida, agora), /válidas|magnet\(s\)\/página|no-work/);

  assert.equal(ageText(agora, agora), 'agora');
  assert.equal(ageText(agora - 5 * 60_000, agora), 'há 5min');
  assert.equal(ageText(agora - 3 * 86_400_000, agora), 'há 3d');
  assert.equal(ageText(agora + 60_000, agora), 'agora', 'relógio adiantado não vira "há -1min"');
});

test('siteRotationLabel diz o porquê de um site não estar na vez', () => {
  const summary = crawlSummary(crawlFixture());
  const override = siteOverride({}, summary);
  const go = siteProbe({ probe: { verdict: 'go' } }, summary);
  const semGo = siteProbe({ probe: { required: true, verdict: 'no-go', ok: false } }, summary);

  assert.equal(siteRotationLabel(override, go, true, true), 'na rotação');
  assert.equal(siteRotationLabel(override, go, false, true), 'ocioso');
  assert.equal(siteRotationLabel(override, go, false, false), 'sem estado');
  assert.equal(siteRotationLabel(override, semGo, false, true), 'fora da rotação · sem GO');
  assert.equal(
    siteRotationLabel({ ...override, enabled: false }, go, false, true),
    'fora da rotação · desligado',
  );

  // `skipReason` do motor tem rótulo próprio; código novo cai no próprio id.
  assert.equal(skipText('teto-horario'), 'teto horário');
  assert.equal(skipText('pausado'), 'pausado');
  assert.equal(skipText('outro-motivo'), 'outro-motivo');
  assert.equal(skipText(null), '');
});

test('clamps, delta e semeadura do formulário por site', () => {
  assert.equal(clampSiteNumber('delayMs', -5), 0);
  assert.equal(clampSiteNumber('delayMs', 99_999), 60_000);
  assert.equal(clampSiteNumber('delayMs', 700.9), 700);
  assert.equal(clampSiteNumber('maxPerHour', 0), 1, 'teto por hora nunca é 0 (pararia o site)');
  assert.equal(clampSiteNumber('maxPerHour', 999_999), 20_000);
  assert.equal(clampSiteNumber('maxPerHour', Number.NaN), 0, 'NaN não vira valor aplicado');

  const summary = crawlSummary(crawlFixture());
  const override = siteOverride({ siteConfig: { dryRun: true, maxPerHour: 900 } }, summary);
  const form = siteFormOf(override);
  assert.deepEqual(form, { enabled: true, dryRun: true, delayMs: 700, maxPerHour: 900 });

  // Sem alteração: patch vazio e nenhuma chave — o botão nasce desabilitado.
  const same = siteConfigDiff(form, override);
  assert.deepEqual(same.patch, {});
  assert.deepEqual(same.changedKeys, []);

  // Só o que muda: o resto do override não volta no POST.
  const changed = siteConfigDiff({ ...form, delayMs: 1500, enabled: false }, override);
  assert.deepEqual(changed.patch, { enabled: false, delayMs: 1500 });
  assert.deepEqual(changed.changedKeys, ['enabled', 'delayMs']);
  assert.deepEqual([...SITE_CONFIG_KEYS].sort(), ['delayMs', 'dryRun', 'enabled', 'maxPerHour'], 'as 4 chaves do ajuste por site');

  // A chave de ressincronia muda quando o poll traz override novo.
  assert.notEqual(overrideKey(override), overrideKey({ ...override, delayMs: 1500 }));
  assert.equal(overrideKey(override), overrideKey(siteOverride({ siteConfig: { dryRun: true, maxPerHour: 900 } }, summary)));

  assert.match(siteConfigHint(override, globalOverride(summary)), /No override: dryRun, maxPerHour/);
  assert.match(siteConfigHint(siteOverride({}, summary), globalOverride(summary)), /Tudo herdado do global/);
});

test('crawlSiteCards preenche override/probe e o estado diz a exclusão', () => {
  const crawl = crawlFixture({
    probeBlock: true,
    sites: [
      { id: 'vacatorrent', label: 'Vaca Torrent', total: 10, byStatus: { done: 10 }, siteConfig: { dryRun: true }, probe: { verdict: 'go' } },
      { id: 'nerdfilmes', label: 'NerdFilmes', total: 0, byStatus: {}, siteConfig: { enabled: false } },
    ],
  });
  const [vaca, nerd] = crawlSiteCards(crawl);
  const summary = crawlSummary(crawl);

  assert.equal(vaca.override.dryRun, true, 'o override do site chega no card');
  assert.deepEqual(vaca.override.overridden, ['dryRun']);
  assert.equal(vaca.probe.verdict, 'go');
  assert.equal(vaca.probe.inRotation, true);
  assert.equal(nerd.override.enabled, false);
  assert.equal(nerd.probe.out, 'desligado');
  assert.equal(nerd.probe.verdict, null, 'sem veredito porque a sonda não rodou');

  assert.equal(siteStateLabel(vaca, summary), 'ativo');
  assert.equal(siteStateLabel(nerd, summary), 'fora da rotação · desligado');
  const semGo = crawlSiteCards(crawlFixture({ probeBlock: true, sites: [{ id: 'a', total: 1, byStatus: { done: 1 } }] }))[0];
  assert.equal(siteStateLabel(semGo, summary), 'fora da rotação · sem GO', 'gate ligado sem veredito bloqueia o site');

  // O gate também é lido pelo nome alternativo do dono do crawl-status.
  assert.equal(crawlSummary(crawlFixture({ requireProbe: true })).probeBlock, true);
  assert.equal(crawlSummary(crawlFixture()).probeBlock, false);

  // Motor desligado no topo = site fora da rotação: a config efetiva do site
  // herda o global, e o card precisa dizer isso em vez de "ocioso".
  const desligado = crawlSiteCards(crawlFixture({ enabled: false, site: 'vacatorrent' }))[0];
  assert.equal(desligado.override.enabled, false);
  assert.equal(siteStateLabel(desligado, crawlSummary(crawlFixture({ enabled: false }))), 'fora da rotação · desligado');

  // Pausa do SITE (crawl-site-pause) é distinta da pausa do motor.
  const pausado = crawlSiteCards(crawlFixture({ sites: [{ id: 'a', total: 5, byStatus: { pending: 5 }, paused: true }] }))[0];
  assert.equal(pausado.paused, true);
  assert.equal(siteStateLabel(pausado, crawlSummary(crawlFixture())), 'pausado');
});

test('SiteConfigForm: 4 campos, delta no apply, "ao vivo" e o descarte destrutivo', () => {
  const crawl = crawlFixture({
    sites: [{ id: 'vacatorrent', label: 'Vaca Torrent', total: 10, byStatus: { done: 10 }, siteConfig: { maxPerHour: 900 } }],
  });
  const summary = crawlSummary(crawl);
  const card = crawlSiteCards(crawl)[0];
  const applied: Array<Partial<SiteFormValues>> = [];
  let discarded = 0;
  let reset = 0;

  const form = siteFormOf(card.override);
  const vnode = SiteConfigForm({
    card,
    summary,
    form: { ...form, delayMs: 1500 },
    pending: false,
    onChange: () => {},
    onApply: (patch: Partial<SiteFormValues>) => applied.push(patch),
    onDiscard: () => { discarded += 1; },
    onReset: () => { reset += 1; },
  });

  const text = textOf(vnode);
  assert.match(text, /Ajuste do site vacatorrent/);
  assert.match(text, /Raspagem deste site/);
  assert.match(text, /Modo simulação deste site/);
  assert.match(text, /Pausa entre páginas \(ms\)/);
  assert.match(text, /Teto de requisições por hora/);
  assert.match(text, /1 alteração\(ões\) a aplicar/, 'com pendência, o badge é o que trava o formulário');
  assert.match(text, /herdado do global/, 'o que não diverge diz de onde vem');
  assert.equal((text.match(/ao vivo/g) || []).length, 1, 'selo por campo divergente (maxPerHour)');

  const elements = expand(vnode);
  const apply = elements.find((n) => n.type === 'button' && textOf(n).includes('Aplicar no site'));
  const discard = elements.find((n) => n.type === 'button' && textOf(n).includes('Descartar'));
  const back = elements.find((n) => n.type === 'button' && textOf(n).includes('Voltar ao global'));
  assert.ok(apply && discard && back);
  assert.equal(apply.props.disabled, false, 'há alteração: o botão aplica');
  assert.equal(discard.props.disabled, false);

  apply.props.onClick();
  assert.deepEqual(applied, [{ delayMs: 1500 }], 'o POST leva só o delta, com o site no envelope');
  discard.props.onClick();
  back.props.onClick();
  assert.equal(discarded, 1);
  assert.equal(reset, 1);
  assert.match(String(back.props.class), /painel-btn-danger/, 'voltar ao global é a ação destrutiva do cartão');

  // Sem alteração o apply nasce desligado (POST sem mudança não existe).
  const clean = expand(SiteConfigForm({
    card, summary, form, pending: false, onChange: () => {}, onApply: () => {}, onDiscard: () => {}, onReset: () => {},
  }));
  const cleanApply = clean.find((n) => n.type === 'button' && textOf(n).includes('Aplicar no site'));
  assert.equal(cleanApply?.props.disabled, true);
  assert.match(textOf(clean), /1 campo\(s\) ao vivo/, 'em dia, o badge é o que já diverge do global');
});

test('wiring: ajuste por site manda `site`, sonda é leitura e os módulos são servidos', () => {
  const read = (rel: string) => readFileSync(new URL('../../src/client/painel/' + rel, import.meta.url), 'utf8');
  const view = read('view-raspagens.ts');
  const configView = read('view-raspagem-site-config.ts');

  assert.match(view, /SITE_SET_ACTION = 'crawl-site-config-set'/, 'ajuste por site é ação nova, separada do global');
  assert.match(view, /SITE_RESET_ACTION = 'crawl-site-config-reset'/);
  assert.match(view, /SITE_PAUSE_ACTION = 'crawl-site-pause'/);
  assert.match(view, /site:\s*card\.id,\s*patch/, 'o patch vai no envelope com o site');
  assert.match(view, /site:\s*card\.id,\s*paused:\s*!card\.paused/, 'pausar site leva o estado alvo');
  // Janela em torno do handler: o reset por site é destrutivo e confirmado.
  const resetAt = view.indexOf('SITE_RESET_ACTION,');
  const resetBlock = resetAt >= 0 ? view.slice(resetAt, resetAt + 900) : '';
  assert.match(resetBlock, /danger:\s*true/, 'voltar ao global é destrutivo e confirmado');
  assert.match(resetBlock, /confirmLabel:\s*'Voltar ao global'/);
  assert.doesNotMatch(view, /'crawl-probe'|'crawl-site-probe'/, 'a sonda é CLI: o painel não dispara ação inexistente');
  assert.doesNotMatch(configView, /postAction|fetch\(/, 'a casca do cartão não busca: o POST é injetado');

  assert.match(view, /probeBadge\(card\.probe\)/, 'o veredito da sonda entra no card do site');
  assert.match(view, /probeText\(card\.probe\)/);
  assert.match(view, /siteRotationLabel\(/, 'a rotação é lida do modelo, não montada na view');

  assert.ok(CLIENT_ASSETS.includes('client/painel/raspagens-site.js'), 'modelo do ajuste por site precisa de rota');
  assert.ok(CLIENT_ASSETS.includes('client/painel/view-raspagem-site-config.js'), 'cartão de ajuste precisa de rota');
  assert.ok(CLIENT_ASSETS.includes('client/painel/view-raspagem-site-history.js'), 'histórico do site precisa de rota');
});
