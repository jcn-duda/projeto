import { LEADING_ARTICLES, YEAR_RANGE, PACK_WORDS, STRONG_PACK_WORDS, titleTokens } from './matching-vocabulary.js';

// Cobertura de busca e identidade de franquia: as funções que respondem "com
// quanto do nome procurado este título casa" (matchesName) e "esta release é
// coleção de mais de uma obra / de qual franquia" (isMultiWorkCollection,
// franchiseRoot*). São a base que `release-title-rules.ts` compõe nos portões
// estritos, e que `search-names.ts` usa para query e marcação de pack.

/**
 * Descarta resultados que claramente não são o título procurado — indexers
 * costumam devolver "parecidos" para queries curtas.
 *
 * Três armadilhas. As duas primeiras medidas em título pt-BR curto (que é
 * justamente o que vai pros sites BR); a terceira, em série global de nome
 * curto:
 *
 * - comparar por SUBSTRING da string inteira fazia "dia" casar dentro de
 *   "diabo": "Dia D" (Disclosure Day) aceitava "O Diabo Veste Prada 2";
 * - descartar palavra de até 2 letras esvazia o título quando ele é curto —
 *   "Dia D" virava o token único `dia` e aceitava "Um Dia de Sorte em Nova
 *   York" e "Homem-Aranha: Um Novo Dia". As seis vagas reservadas iam para o
 *   lixo e empurravam pra fora a fonte dublada correta;
 * - token repetido e artigo inglês inflavam os acertos: o filtro de ruído
 *   (até 2 letras) foi calibrado para artigo pt-BR e não pegava "the" (3
 *   letras), e o `wanted` não era deduplicado — "The Walking Dead: Dead
 *   City" pedia [the, walking, dead, dead, city] e "Shaun of the Dead
 *   (2004)" marcava the + dead + dead = 3/5 = 0.600, exatamente no corte.
 *   Como o caminho global de série não tem guarda de ano depois desta
 *   (release de filme não carrega marcador de episódio, então a checagem de
 *   identidade abstém), o filme entrava na lista da série. Artigo sai do
 *   conjunto significativo e `wanted` é deduplicado.
 *
 */
function matchesName(title: string, name: string, tokens: string[] | null = null) {
  const all = titleTokens(name);
  // Palavra de 1-2 letras costuma ser ruído ("o", "de", "a") — e artigo
  // inglês também ("the" tem 3 letras e escapa do filtro de comprimento).
  // Mas quando sobra menos de dois tokens, ela É o título ("The Bear",
  // "From"): aí vale mais que o ruído que evita.
  const long = all.filter((w) => w.length > 2 && !LEADING_ARTICLES.has(w));
  const base = long.length >= 2 ? long : all;
  const wanted = [...new Set(base)];
  // `wanted` vazio só resta de nome sem token aproveitável (vazio ou só
  // ruído). Retornar true seria passe livre: quem chama em lote via
  // names.some() aprovaria QUALQUER título contra esse nome. Lista vazia é
  // preferível — não há evidência do que casar, então negar é mais seguro
  // que aceitar às cegas.
  if (wanted.length === 0) return false;
  // Token inteiro, não pedaço de palavra. `tokens` opcionais: quem chama em
  // lote (filterRelevantRaw) já normalizou o título e não paga de novo.
  const got = new Set(tokens || titleTokens(title));
  const hits = wanted.filter((w) => got.has(w)).length;
  return hits / wanted.length >= 0.6;
}

/**
 * Título de coleção com mais de uma obra (pack de filmes). Serve à guarda de
 * listagem: sem debrid o play acontece direto no cliente, que escolhe o MAIOR
 * arquivo do pack — "todos os filmes" tocando o filme errado em silêncio.
 * Exige os dois sinais juntos: palavra de empacotamento E faixa de anos.
 */
function isMultiWorkCollection(title = '') {
  const raw = String(title);
  const tokens = titleTokens(raw);
  if (tokens.some((t) => STRONG_PACK_WORDS.has(t))) return true;
  // Palavra fraca ("todos", "filmes", "completa") só conta com faixa de anos:
  // sozinha ela também aparece em "Todas as Temporadas" e em edição especial.
  if (!YEAR_RANGE.test(raw)) return false;
  return tokens.some((token) => PACK_WORDS.has(token));
}

// Sequência no fim do título: romano canônico, número de 1-2 dígitos ou
// "Parte N". A trava de 2+ palavras na raiz protege "Distrito 9", onde o
// número É o nome da obra.
const SEQUENCE_TAIL = /\s+(?:parte\s+)?(?:[ivx]{1,4}|\d{1,2})$/i;

/**
 * Raiz da franquia de um título: corta o subtítulo ("Jornada nas Estrelas: O
 * Filme" → "Jornada nas Estrelas") e o marcador de sequência no fim ("II",
 * "2", "Parte 2"), sempre exigindo 2+ palavras no resultado — quem hospeda o
 * dublado da continuação costuma ser a COLEÇÃO da franquia, e "Jornada nas
 * Estrelas II" devolve 0 resultados onde "Jornada nas Estrelas" devolve 14.
 *
 * Alimenta a varredura pt-BR (search-plan) e a exceção de franquia do
 * inventário da conta (`filterInventoryRelevant`).
 */
function franchiseRoot(title: string) {
  const raw = String(title || '').trim();
  if (!raw) return '';
  // Casa o PRIMEIRO separador entre os três suportados; a âncora inicial
  // impede cortar no meio de um subtítulo.
  const cut = raw.match(/^([^:–—]+?)([:–—].*)?$/);
  let head = raw;
  if (cut) {
    const candidate = cut[1].trim();
    if (candidate.split(/\s+/).filter(Boolean).length >= 2) head = candidate;
  }
  const root = head.replace(SEQUENCE_TAIL, '').trim();
  if (root && root.split(/\s+/).filter(Boolean).length >= 2) return root;
  return head;
}

/**
 * O título termina em marcador de sequência ("Parte II", "2", "III")? É o
 * MESMO corte que o `franchiseRoot` aplica no fim — exposto como pergunta
 * para o gate do degrau de franquia não espelhar o regex. Só olha o fim: quem
 * protege "Distrito 9" (número é o nome da obra) é a trava de 2+ palavras do
 * `franchiseRoot`, e quem exige que o marcador tenha sido realmente cortado é
 * o `franchise !== bare` do plano de busca.
 */
function endsWithSequenceMarker(title: string) {
  return SEQUENCE_TAIL.test(String(title || '').trim());
}

/** Raízes de franquia normalizadas de todos os nomes conhecidos da obra. */
function franchiseRoots(names: string[] = []): string[] {
  const roots = new Set<string>();
  for (const name of names) {
    const normalized = titleTokens(franchiseRoot(name)).join(' ');
    if (normalized) roots.add(normalized);
  }
  return [...roots];
}

/** O título contém a raiz como sequência contígua de palavras normalizadas. */
function containsTokenRun(title: string, normalizedRoot: string) {
  const haystack = titleTokens(title);
  const needle = String(normalizedRoot || '').split(' ').filter(Boolean);
  if (!needle.length || haystack.length < needle.length) return false;
  for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    if (needle.every((tok, j) => haystack[i + j] === tok)) return true;
  }
  return false;
}

export {
  matchesName,
  isMultiWorkCollection,
  franchiseRoot,
  franchiseRoots,
  endsWithSequenceMarker,
  containsTokenRun,
};
