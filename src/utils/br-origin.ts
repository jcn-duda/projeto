// Detecção de ORIGEM BR pelo título — o predicado que protege acervo na
// limpeza da conta (8.4 do PLANO_MELHORIAS). Errar aqui ABSOLVENDO é o lado
// certo do erro: falso positivo destrói acervo BR que custou horas de
// download (a cicatriz das 812 magnets registrada em alldebrid-cleanup.ts).

// ---------------------------------------------------------------------------
// Sinais de português (movidos de audio-quality.ts SEM mudança de
// comportamento). A busca consome hasPtSigns na rede de segurança do ranking
// (stream-ranking.ts) e não pode mudar de calibração por causa da limpeza —
// por isso o predicado segue byte a byte o que sempre foi.
// ---------------------------------------------------------------------------

// Sinais de título em português para o balde "sem marca mas parece BR":
// acentos quase exclusivos do pt-BR, vocabulário de post BR e marcadores de
// site/grupo nacional. Sem nada disso e sem marca de áudio, é release
// estrangeira — o padrão do que entope a conta. Classificador COMPARTILHADO:
// a limpeza da conta (scripts/clean-undubbed.ts) usa a mesma lógica da busca —
// uma segunda lista divergiria.
const PT_VOCAB = /\b(temporadas?|epis[oó]dios?|dublad[oa]s?|dublagem|nacional|complet[oa]s?|cole[cç][aã]o|vers[oõ]es?|estendid[oa]s?|guerra|mundial|estreia|cap[ií]tulos?|caminho|cidade|noite|vingan[cç]a|cora[cç][aã]o|paix[aã]o|f[uú]ria|selvagem|assassino|assassina|maldi[cç][aã]o)\b/i;
// `de` entra aqui: é a preposição portuguesa mais comum e sua ausência era a
// maior causa isolada de títulos BR sem acento caírem no balde `lixo`
// (medido: 19 de 20 títulos de teste). Exige 2+ ocorrências, então título
// estrangeiro com um "de" solto não basta.
const PT_STOP_TWO = (t: string) => (t.match(/\b(das?|de|dos?|n[ao]s?|umas?|para|com|entre|sobre|atr[aá]s)\b/gi) || []).length >= 2;
// Só hosts BR NOMEADOS contam. O alternador `www\.\w+\.org\s*-\s*` aceitava
// QUALQUER domínio `.org` — inclusive `www.UIndex.org -`, um espelho de cena EN
// que carimbava dezenas de releases da conta como sinal PT (medido: 122 linhas
// casando `www.UIndex.org -`, nenhuma delas BR). A marca do site BR já casa
// pelo token próprio (`www.nerdfilmes.org -` continua coberto por `nerdfilmes`).
// DEFEITO CONHECIDO, ainda NÃO corrigido de propósito: `bthd` não tem fronteira
// e casa DENTRO de outras palavras — `www.HDBTHD.com` (tracker chinês) vira
// "sinal PT". É a mesma forma do bug do `www.UIndex.org` descrito acima, e foi
// o único falso positivo entre os 42 duals que o `looksPtBr` passou a
// reconhecer (medido na conta do operador, 853 magnets).
//
// Por que não está consertado aqui: apertar este predicado tira proteção de
// itens hoje protegidos da limpeza (`audioBucket` devolveria `lixo` em vez de
// `pt`), ou seja, anda na direção DESTRUTIVA — exatamente o que a Fase 8 exige
// medir e autorizar antes, não corrigir de passagem. O custo de deixar como
// está é uma vaga BR ocupada por engano na lista; o custo de errar o conserto
// é acervo apagado. Ao consertar: exigir fronteira (`(?:^|[^a-z0-9])bthd`) e
// medir quantos itens saem do balde `pt` ANTES de qualquer `--apply`.
const BR_MARK = /(comandotorrents|bludv|nerdfilmes|torrentdosfilmes|wolverdon|andretpf|lapumia|megatorrents|hdtorrent|torrentbr|bthd)/i;

/** Sem marca de áudio, mas o título denuncia português (post BR sem marcação é o padrão). */
function hasPtSigns(title = ''): boolean {
  // Acentos case-insensitive: título TODO EM CAIXA ALTA ("OPERAÇÃO INVASÃO")
  // tem Ã/Ç maiúsculos e perdia o sinal — caía no balde 'lixo' e a varredura
  // destrutiva sweepUndubbed o apagava.
  return /[ãõ]/i.test(title) || /ç/i.test(title) || PT_VOCAB.test(title) || PT_STOP_TWO(title) || BR_MARK.test(title);
}

// ---------------------------------------------------------------------------
// Blindagem de ORIGEM BR da Fase 8 (8.4) — consumo EXCLUSIVO dos caminhos de
// limpeza (audioBucket/foreignVerdict). NÃO entre aqui sem medir: os 4 falsos
// positivos reais da conta ("X-Men - O Filme 1080p - The Pirate Filmes",
// "Troia - The Pirate Filmes", "Zumbilândia … Filmes M.H.G",
// "zumbilandia (www.thepiratefilmes.com)") são site BR com título em
// português que o balde `lixo` condenava por não citar "dublado".
// ---------------------------------------------------------------------------

// Marca de site BR do caminho de limpeza: a lista do BR_MARK (hosts nomeados)
// MAIS thepiratefilmes. A marca nova fica FORA do BR_MARK de propósito:
// hasPtSigns alimenta a rede de segurança do ranking (stream-ranking) e
// crescer lá muda o que o autofetch prioriza — a blindagem da limpeza não
// pode recalibrar a busca de carona.
const BR_SITE_MARKS = /(comandotorrents|bludv|nerdfilmes|torrentdosfilmes|wolverdon|andretpf|lapumia|megatorrents|hdtorrent|torrentbr|bthd|thepiratefilmes|piratefilmes)/i;

/**
 * Origem BR pelo nome, para NÃO apagar: marca de site BR, a palavra
 * portuguesa "filme(s)" ou qualquer sinal PT de hasPtSigns. Regra do operador:
 * *se tem nome BR, só pode ser BR* — e como a regra serve para NÃO apagar,
 * errar protegendo é o lado certo. Acentos além de ã/õ/ç (â de "Zumbilândia",
 * á/é/ô/ê) ficam FORA de propósito: são compartilhados com francês/italiano e
 * hasPtSigns não pode crescer nesse eixo sem mentir PT na busca; os casos
 * reais medidos são cobertos pelo nome do site e pela palavra "filmes".
 */
function brOriginMark(title = ''): boolean {
  const t = String(title || '');
  if (BR_SITE_MARKS.test(t)) return true;
  if (/\bfilmes?\b/i.test(t)) return true;
  return hasPtSigns(t);
}

export { hasPtSigns, brOriginMark };
