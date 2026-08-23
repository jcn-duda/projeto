import type { ParsedSeasonEpisode } from '../../types/domain.js';
import { normalizeTitle } from './title-normalization.js';

interface SeasonEpisodeOptions {
  season?: number | null;
  episode?: number | null;
}

/**
 * Extrai temporada/episódio do título da release. Cobre os formatos que os
 * indexers usam de fato: "S01E04", "S01E01-E10", "1x04", "S01" (pack) e as
 * variações pt-BR dos sites BR ("1ª Temporada", "Temporada 1", "Episódio 4").
 *
 * O tipo de retorno trava o CONTRATO: acrescentar ou tirar campo daqui sem
 * mexer na interface vira erro na hora. Foi assim que `seasonPack` quebrou oito
 * `deepEqual` de uma vez — o teste só acusou depois de rodar a suíte inteira.
 */
function parseTitleSeasonEpisode(title = ''): ParsedSeasonEpisode {
  const raw = String(title);
  const t = normalizeTitle(title);
  const seasons = new Set<number>();
  const episodes = new Set<number>();

  // "s01e04", "s01 e04", "s01e01 e10" (intervalo), "s01e01e02"
  for (const m of t.matchAll(/s(\d{1,2})((?:\s?e\s?\d{1,3})+)/g)) {
    seasons.add(Number(m[1]));
    const eps = [...m[2].matchAll(/e\s?(\d{1,3})/g)].map((x) => Number(x[1]));
    if (eps.length >= 2) {
      // Intervalo ("E01-E10" chega como "e01 e10"): tudo entre o menor e o maior.
      const lo = Math.min(...eps);
      const hi = Math.max(...eps);
      for (let i = lo; i <= hi; i += 1) episodes.add(i);
    } else {
      eps.forEach((e) => episodes.add(e));
    }
  }

  // Trackers BR usam "T01 E004" e "T01E004". Lemos a sequência no título
  // cru porque a normalização apaga hífen: E001-E010 é intervalo, enquanto
  // E001 e E002, E001, E002 e E001 E010 são listas.
  for (const m of raw.matchAll(/(?:^|[^a-z0-9])t(\d{1,2})\s*e\s?(\d{1,3})/gi)) {
    seasons.add(Number(m[1]));
    const eps = [Number(m[2])];
    let cursor = m.index + m[0].length;
    let ranged = false;
    while (cursor < raw.length) {
      const next = raw.slice(cursor).match(/^(?:\s*([-–—])\s*|\s*(?:e|and)\s+|\s*,\s*|\s+)e\s?(\d{1,3})/i);
      if (!next) break;
      ranged ||= Boolean(next[1]);
      eps.push(Number(next[2]));
      cursor += next[0].length;
    }
    if (ranged) {
      const lo = Math.min(...eps);
      const hi = Math.max(...eps);
      for (let i = lo; i <= hi; i += 1) episodes.add(i);
    } else {
      eps.forEach((episode) => episodes.add(episode));
    }
  }

  // "1x04"
  for (const m of t.matchAll(/(\d{1,2})x(\d{1,3})/g)) {
    seasons.add(Number(m[1]));
    episodes.add(Number(m[2]));
  }

  // Faixa: "1ª até 8ª Temporada", "1 a 5 temporadas". Antes só o último número
  // era lido, então o pack de 1 a 8 não cobria o S01E01 que o usuário pediu.
  // `(?:\s*a)?` cobre o ordinal: o site escreve tanto "1ª até 8ª" (o ª vira
  // espaço na normalização) quanto "1a ate 8a" (o a fica colado no dígito).
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})(?:\s*a)?\s*(?:ate|a)\s*(\d{1,2})(?!\d)(?:\s*a)?\s*temporadas?/g)) {
    const lo = Math.min(Number(m[1]), Number(m[2]));
    const hi = Math.max(Number(m[1]), Number(m[2]));
    // Faixa absurda é erro de leitura, não pack de 50 temporadas.
    if (hi - lo <= 30) for (let i = lo; i <= hi; i += 1) seasons.add(i);
  }

  // LISTA de ordinais antes de "Temporadas" no PLURAL: "1ª 2ª 3ª 4ª 5ª 6ª e 7ª
  // Temporadas". Só o último número encosta na palavra, então o padrão de
  // temporada única lia [7] sozinho e o pack inteiro sumia das seis primeiras.
  // Medido no hdrtorrent, em Game of Thrones: era o único falso corte numa
  // varredura de 3.794 títulos reais dos indexers BR.
  //
  // O plural é a âncora: no singular ("… e 7ª Temporada") o número colado é a
  // temporada do item, e os anteriores são outra coisa. `(?<![a-z0-9])` impede
  // que dígito preso a palavra técnica entre na conta ("DDP5 1 Atmos").
  for (const m of t.matchAll(/((?:(?<![a-z0-9])\d{1,2}\s+){2,}(?:e\s+)?(?<![a-z0-9])\d{1,2}\s+)temporadas/g)) {
    for (const num of m[1].match(/\d{1,2}/g) || []) {
      const season = Number(num);
      // Mesmo teto da faixa: número fora disso é ruído lido como temporada.
      if (season >= 1 && season <= 30) seasons.add(season);
    }
  }

  // Pack: "s01", "s01 s03" (multi-temporada), "season 1", "1 temporada", "temporada 1"
  for (const m of t.matchAll(/s(\d{1,2})(?![\de])/g)) seasons.add(Number(m[1]));
  // `(?!\d)` impede que o ANO logo depois vire temporada: "Temporada (2011)"
  // casava como temporada 20, pegando os dois primeiros dígitos.
  for (const m of t.matchAll(/(?:season|temporada)\s?(\d{1,2})(?!\d)/g)) seasons.add(Number(m[1]));
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})(?!\d)\s?a?\s?temporada/g)) seasons.add(Number(m[1]));

  // Série inteira: "Todas as Temporadas", "Série Completa", "Temporadas
  // Completas" (plural). Sem isto o pack completo não declarava temporada
  // nenhuma e só sobrevivia pela brecha de "título sem pista nenhuma passa".
  const complete = /(?:todas?\s+(?:as\s+)?temporadas|serie\s+completa|temporadas\s+completas)/.test(t);
  // "2ª Temporada Completa" é pack da temporada nomeada, não da série inteira.
  // Tratar o singular como cobertura total fazia S01/S02 entrar no S04E06.
  const seasonPack = /temporada\s+completa/.test(t);

  // Episódio solto em pt-BR só conta quando a temporada já apareceu; senão
  // "Episódio II" de filme (Star Wars) viraria episódio de série.
  if (seasons.size && episodes.size === 0) {
    for (const m of t.matchAll(/epis[oó]dio\s?(\d{1,3})/g)) episodes.add(Number(m[1]));
    // Os resolvers BR titulam "1ª Temporada (2022) WEB-DL E02": o "e02" solto
    // é o episódio da release. Sem este parse, o E02 passava pelo filtro do
    // E01 e tomava as vagas reservadas BR. Fora do contexto de temporada o
    // "e" é conjunção ("Lilo e Stitch 2"), por isso a mesma trava do Episódio.
    const loose = [...t.matchAll(/(?<![a-z0-9])e(\d{1,3})(?![a-z0-9])/g)].map((m) => Number(m[1]));
    if (loose.length >= 2) {
      // "E01 a E10" é intervalo, como no formato SxxEyy acima.
      const lo = Math.min(...loose);
      const hi = Math.max(...loose);
      for (let i = lo; i <= hi; i += 1) episodes.add(i);
    } else {
      loose.forEach((e) => episodes.add(e));
    }
  }

  return { seasons: [...seasons], episodes: [...episodes], complete, seasonPack };
}

/** Cobertura explícita que exclui a temporada pedida não pode virar "talvez". */
function seasonCoverageExcludes(parsed: ParsedSeasonEpisode, season: number | null | undefined) {
  // "Todas as Temporadas ... 3ª Temporada" não cobre implicitamente a S01:
  // complete só vale como cobertura total quando NÃO há temporada explícita.
  return season != null && parsed.seasons.length > 0 && !parsed.seasons.includes(season);
}

/**
 * O indexer devolve a temporada inteira quando a busca é por "Nome S01E01" —
 * sem este filtro a lista de E01 vinha recheada de E03, E04, E06, E09.
 * Pack de temporada (sem episódio no título) continua valendo: é dele que o
 * debrid tira o arquivo certo, e é o formato que as fontes BR publicam.
 *
 */
function matchesEpisode(title: string, { season, episode }: SeasonEpisodeOptions = {}) {
  if (season == null || episode == null) return true;
  const t = normalizeTitle(title);
  const { seasons, episodes, complete } = parseTitleSeasonEpisode(title);

  // Série inteira cobre o episódio pedido. Pack de uma temporada não: quem
  // decide é a temporada que o título nomeia, no teste logo abaixo.
  if (complete && seasons.length === 0) return true;

  // "Nº Temporada Completa" no singular declara a cobertura EXATA do pack
  // (regra medida na varredura dos títulos BR): uma menção descritiva de outra
  // temporada no MESMO título não amplia o que ele contém. Medido no True
  // Detective: "2ª Temporada Dublada e Dual 1ª TEMPORADA COMPLETA" entregava
  // só arquivos S01 e entrava na lista pedindo S02E01, porque o parser fundia
  // as duas menções em seasons=[2,1]. O plural ("1ª 2ª 3ª Temporadas
  // Completa") não casa aqui — 'temporadas' tem o s antes do espaço. E a
  // FAIXA declarada ("1ª até 8ª Temporada Completa", caso real do corpus)
  // cobre o intervalo inteiro, não a última.
  const rangePack = /\b(\d{1,2})\s*a?\s*(?:ate|a|to)\s+(\d{1,2})\s*a?\s*temporada\s+completa\b/.exec(t);
  if (rangePack && season != null) {
    const lo = Math.min(Number(rangePack[1]), Number(rangePack[2]));
    const hi = Math.max(Number(rangePack[1]), Number(rangePack[2]));
    if (season < lo || season > hi) return false;
  } else {
    const declaredPack =
      t.match(/\b(\d{1,2})\s*a?\s*temporada\s+completa\b/) ||
      t.match(/\btemporada\s+(\d{1,2})(?!\d)\s+completa\b/);
    if (declaredPack && season != null && Number(declaredPack[1]) !== season) return false;
  }

  // Nenhuma pista de temporada/episódio: não dá pra afirmar que é errado
  // (release BR costuma vir só como "Nome Dublado"), então passa.
  if (seasons.length === 0 && episodes.length === 0) return true;

  if (seasonCoverageExcludes({ seasons, episodes, complete, seasonPack: false }, season)) return false;
  if (episodes.length && !episodes.includes(episode)) return false;
  return true;
}

/**
 * A release cobre a temporada inteira pedida? ("S01", "1ª Temporada",
 * "Série Completa"/"Todas as Temporadas"). Em busca de série o autofetch
 * prefere pack a episódio avulso: um download serve o binge todo.
 */
function isSeasonPackRelease(stream: any, season: number | null) {
  if (season == null || !stream) return false;
  const { seasons, episodes, complete, seasonPack } = parseTitleSeasonEpisode(stream.title || stream.name || '');
  if (complete && !seasons.length) return true;
  if (episodes.length) return false;
  if (seasons.length) return seasons.includes(season);
  // Sem número no título, a busca que trouxe o item era da temporada pedida.
  return seasonPack;
}

/**
 * Variante ESTREITA do isSeasonPackRelease, só para o Season Pack Fill.
 * Exige que o título PROVE a temporada: número casando com a pedida, ou
 * série completa ("Todas as Temporadas" cobre qualquer uma). "Temporada
 * Completa" SEM número diz qual temporada é só na cabeça de quem publicou —
 * o post do NerdFilmes anunciando S04 e contendo S03 é exatamente esse caso.
 * Semear ⚡ e invalidar caches a partir dele promete o que o pack não provou
 * conter; aí o fill não roda e a constatação fica para o pickFile do play.
 */
function isSeasonPackFillEligible(stream: any, season: number | null) {
  if (season == null || !stream) return false;
  const { seasons, episodes, complete } = parseTitleSeasonEpisode(stream.title || stream.name || '');
  if (episodes.length) return false;
  if (complete && !seasons.length) return true;
  return seasons.includes(season);
}

export {
  parseTitleSeasonEpisode,
  seasonCoverageExcludes,
  matchesEpisode,
  isSeasonPackRelease,
  isSeasonPackFillEligible,
};
