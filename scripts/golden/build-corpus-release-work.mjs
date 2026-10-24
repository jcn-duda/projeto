#!/usr/bin/env node
/**
 * Gera `scripts/golden/corpus-release-work.json`: casos de
 * `src/utils/release-work.ts` (episodeParseSpecificity, chooseEpisodeParse,
 * routeWorkLocation, releaseFitsRequest, releaseWorkTargets). Gerador
 * descartável do corpus; o arquivo commitado é a fonte.
 *
 * Entrada JSON com `op`: title (string), dn (string ou null), request
 * ({season, episode} ou null), year (número, texto ou ausente).
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(REPO, 'scripts/golden/corpus-release-work.json');

const cases = [];
const add = (note, obj) => cases.push({ note, input: JSON.stringify(obj) });
const req = (season, episode) => ({ season, episode });

// episodeParseSpecificity: episódio único > pack > série/faixa > nada.
add('specificity: episodio unico', { op: 'specificity', title: 'Dark S01E01 1080p WEB' });
add('specificity: temporada completa', { op: 'specificity', title: 'Dark S01 Complete 1080p' });
add('specificity: temporada em portugues', { op: 'specificity', title: 'Dark 1ª Temporada 1080p' });
add('specificity: temporada por extenso', { op: 'specificity', title: 'Dark Temporada 2 BluRay' });
add('specificity: faixa de episodios', { op: 'specificity', title: 'Dark S01E01-E03 1080p' });
add('specificity: serie completa', { op: 'specificity', title: 'Dark Complete Series 1080p' });
add('specificity: sem marcador e zero', { op: 'specificity', title: 'Dark 1080p WEB-DL' });
add('specificity: filme sem marcador e zero', { op: 'specificity', title: 'Monster Hunter 2021 1080p' });
add('specificity: duas temporadas vale 1', { op: 'specificity', title: 'Dark S01 S02 Completas' });
add('specificity: titulo vazio e zero', { op: 'specificity', title: '' });

// chooseEpisodeParse: dn so vence com mais precisao; empate fica com o titulo.
add('choose: sem dn usa o titulo', { op: 'choose', title: 'Dark S01E04 1080p', dn: null });
add('choose: dn vazio e ignorado', { op: 'choose', title: 'Dark S01E04 1080p', dn: '' });
add('choose: dn com episodio unico vence pack do titulo', { op: 'choose', title: 'Dark 2ª Temporada 1080p', dn: 'Dark.S02E05.1080p.WEB' });
add('choose: dn mais fraco nao vence', { op: 'choose', title: 'Dark S02E05 1080p', dn: 'Dark 2ª Temporada' });
add('choose: empate de especificidade fica com o titulo', { op: 'choose', title: 'Dark S03E01 1080p', dn: 'Dark.S01E02.1080p' });
add('choose: dn sem marcador nao vence', { op: 'choose', title: 'Dark S01 Complete', dn: 'Dark 1080p' });
add('choose: titulo sem marcador e dn com pack', { op: 'choose', title: 'Dark 1080p', dn: 'Dark S04 Complete' });
add('choose: dn de serie completa vence faixa de episodios', { op: 'choose', title: 'Dark S01E01-E03', dn: 'Dark Complete Series' });
add('choose: titulo vazio com dn de episodio', { op: 'choose', title: '', dn: 'Dark S01E02' });
add('choose: dn com ruido e marcador de episodio', { op: 'choose', title: 'Dark 4K HDR', dn: 'Dark.S05E09.2160p.HDR' });

// routeWorkLocation: release que declara outra obra vai para a dela.
add('route: episodio declarado no titulo vai para a obra dele', { op: 'route', title: 'Dark S01E05 1080p', dn: null, request: req(1, 2) });
add('route: outra temporada vai para a sua', { op: 'route', title: 'Dark S02E01 1080p', dn: null, request: req(1, 1) });
add('route: pack de outra temporada vira chave da temporada', { op: 'route', title: 'Dark S02 Complete', dn: null, request: req(1, 1) });
add('route: serie completa vira (-,-)', { op: 'route', title: 'Dark Complete Series', dn: null, request: req(1, 1) });
add('route: sem marcador fica no pedido', { op: 'route', title: 'Dark 1080p WEB', dn: null, request: req(2, 4) });
add('route: dn mais especifico redireciona', { op: 'route', title: 'Dark 3ª Temporada', dn: 'Dark.S03E07.1080p', request: req(3, 1) });
add('route: pack do titulo sem dn', { op: 'route', title: 'Dark 2ª Temporada 1080p', dn: null, request: req(2, 3) });
add('route: pedido de filme devolve o proprio pedido', { op: 'route', title: 'Monster Hunter S02E03', dn: null, request: req(null, null) });
add('route: pedido de filme com episodio mantem o episodio', { op: 'route', title: 'Monster Hunter 2021', dn: null, request: req(null, 5) });
add('route: pedido nulo equivale a filme', { op: 'route', title: 'Dark S01E01', dn: null, request: null });
add('route: episodio do dn com titulo sem marcador', { op: 'route', title: 'Dark 1080p', dn: 'Dark.S01E06.1080p', request: req(1, 2) });
add('route: pack de duas temporadas vira serie', { op: 'route', title: 'Dark S01 S02 Completas', dn: null, request: req(1, 1) });

// releaseFitsRequest: 1 cabe no pedido; 0 e prova de outra obra.
add('fits: episodio exato cabe', { op: 'fits', title: 'Dark S01E02 1080p', dn: null, request: req(1, 2) });
add('fits: outro episodio da mesma temporada nao cabe', { op: 'fits', title: 'Dark S01E03 1080p', dn: null, request: req(1, 2) });
add('fits: outra temporada nao cabe', { op: 'fits', title: 'Dark S02E02 1080p', dn: null, request: req(1, 2) });
add('fits: pack da temporada cabe em qualquer episodio', { op: 'fits', title: 'Dark S01 Complete', dn: null, request: req(1, 7) });
add('fits: pack de outra temporada nao cabe', { op: 'fits', title: 'Dark S03 Complete', dn: null, request: req(1, 1) });
add('fits: serie completa cabe', { op: 'fits', title: 'Dark Complete Series', dn: null, request: req(2, 4) });
add('fits: sem marcador cabe', { op: 'fits', title: 'Dark 1080p WEB', dn: null, request: req(1, 2) });
add('fits: pedido de filme sempre cabe', { op: 'fits', title: 'Monster Hunter S02E03', dn: null, request: req(null, null) });
add('fits: titulo com episodio errado e dn certo usa titulo', { op: 'fits', title: 'Dark S01E01 1080p', dn: 'Dark.S01E02.1080p', request: req(1, 2) });
add('fits: dn mais especifico com episodio certo cabe', { op: 'fits', title: 'Dark 1ª Temporada', dn: 'Dark.S01E02.1080p', request: req(1, 2) });
add('fits: dn errado derruba release de titulo certo sem marcador', { op: 'fits', title: 'Dark 1ª Temporada 1080p', dn: 'Dark.S01E09.1080p', request: req(1, 2) });
add('fits: pedido sem episodio cabe em episodio unico da temporada', { op: 'fits', title: 'Dark S01E09 1080p', dn: null, request: req(1, null) });
add('fits: pack de duas temporadas nao cabe na temporada 3', { op: 'fits', title: 'Dark S01 S02 Completas', dn: null, request: req(3, 1) });
add('fits: pack de duas temporadas cabe na temporada 2', { op: 'fits', title: 'Dark S01 S02 Completas', dn: null, request: req(2, null) });
add('fits: titulo vazio cabe', { op: 'fits', title: '', dn: null, request: req(1, 1) });
add('fits: dn vazio e ignorado', { op: 'fits', title: 'Dark S01E02', dn: '', request: req(1, 2) });

// releaseWorkTargets: obras em que a release deve ser recuperavel ([] no veto).
add('targets: episodio exato devolve so o pedido', { op: 'targets', title: 'Dark S01E02 1080p', dn: null, request: req(1, 2), year: 2017 });
add('targets: filme devolve so o pedido', { op: 'targets', title: 'Monster Hunter 2021 1080p', dn: null, request: req(null, null), year: 2021 });
add('targets: pack da temporada acrescenta a obra da temporada', { op: 'targets', title: 'Dark S01 Complete 1080p', dn: null, request: req(1, 4), year: 2017 });
add('targets: pack de temporada 2 no pedido de temporada 1 roteia para a sua', { op: 'targets', title: 'Dark S02 Complete', dn: null, request: req(1, 4), year: 2017 });
add('targets: serie completa acrescenta a obra inteira', { op: 'targets', title: 'Dark Complete Series', dn: null, request: req(1, 4), year: 2017 });
add('targets: episodio de outra temporada vai so para a sua', { op: 'targets', title: 'Dark S02E01 1080p', dn: null, request: req(1, 1), year: 2017 });
add('targets: pack de duas temporadas vira serie', { op: 'targets', title: 'Dark S01 S02 Completas', dn: null, request: req(1, 1), year: 2017 });
add('targets: sem marcador devolve o pedido', { op: 'targets', title: 'Dark 1080p WEB', dn: null, request: req(2, 3), year: 2017 });
add('targets: dn com episodio unico e titulo com pack', { op: 'targets', title: 'Dark 2ª Temporada 1080p', dn: 'Dark.S02E05.1080p', request: req(2, 1), year: 2017 });
add('targets: dn com pack acrescenta a temporada declarada', { op: 'targets', title: 'Dark 1080p', dn: 'Dark S03 Complete', request: req(1, 1), year: 2017 });
add('targets: pedido nulo equivale a filme', { op: 'targets', title: 'Dark S01E01', dn: null, request: null, year: 2017 });
add('targets: pedido sem episodio e pack', { op: 'targets', title: 'Dark S01 Complete', dn: null, request: req(1, null), year: 2017 });
add('targets: episodio pedido ausente no pack de outra temporada', { op: 'targets', title: 'Dark S02 Complete', dn: null, request: req(2, 9), year: 2017 });
add('targets: pack com episodio no titulo e mesmo episodio pedido', { op: 'targets', title: 'Dark S01E03 1080p', dn: null, request: req(1, 3), year: 2017 });
add('targets: live action com ano longe da estreia devolve vazio', { op: 'targets', title: 'Cowboy Bebop Live Action 2021 S01E01 1080p', dn: null, request: req(1, 1), year: 1998 });
add('targets: live action com ano proximo da estreia cabe', { op: 'targets', title: 'Cowboy Bebop Live Action 1999 S01E01 1080p', dn: null, request: req(1, 1), year: 1998 });
add('targets: live action no dn e ano de estreia como texto', { op: 'targets', title: 'Cowboy Bebop S01E01 1080p', dn: 'Cowboy.Bebop.Live.Action.2021.S01E01', request: req(1, 1), year: '1998' });
add('targets: live action sem ano declarado nao condena', { op: 'targets', title: 'Cowboy Bebop Live Action S01E01', dn: null, request: req(1, 1), year: 1998 });
add('targets: live action sem estreia conhecida nao condena', { op: 'targets', title: 'Cowboy Bebop Live Action 2021 S01E01', dn: null, request: req(1, 1), year: null });
add('targets: live action em filme nunca condena', { op: 'targets', title: 'Cowboy Bebop Live Action 2021', dn: null, request: req(null, null), year: 1998 });
add('targets: live action com faixa cobrindo a estreia nao condena', { op: 'targets', title: 'Cowboy Bebop Live Action 1990-2010 S01', dn: null, request: req(1, 1), year: 1998 });
add('targets: live action em pack sem ano de estreia', { op: 'targets', title: 'Cowboy Bebop Live Action 2021 S01 Complete', dn: null, request: req(1, 1) });
add('targets: pedido sem ano usa so a regra de parse', { op: 'targets', title: 'Dark S02 Complete', dn: null, request: req(1, 1) });
add('targets: serie sem ano e pack de outra temporada', { op: 'targets', title: 'Dark S03 Complete 1080p', dn: null, request: req(2, 2), year: 2017 });

const body = cases
  .map((c, i) => ({ id: `rw-${String(i + 1).padStart(3, '0')}`, input: c.input, note: c.note }))
  .map((c) => '    ' + JSON.stringify(c))
  .join(',\n');

writeFileSync(
  OUT,
  `{
  "version": "corpus-release-work/1",
  "note": "release-work.ts: episodeParseSpecificity, chooseEpisodeParse, routeWorkLocation, releaseFitsRequest, releaseWorkTargets. Entrada JSON com op. Saida: inteiro, texto ou 1/0. IDs estaveis.",
  "cases": [
${body}
  ]
}
`,
);
console.log(`[corpus] ${cases.length} casos`);
