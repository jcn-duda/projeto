#!/usr/bin/env node
/**
 * Catraca de "orçamento de linhas por arquivo" (Fase 1) — teto de 400 linhas.
 *
 * O teto não é aplicado aos arquivos que JÁ passaram: isso reescreveria o
 * acervo inteiro de uma vez. A catraca tem três regras:
 *   A (dura, sem escape): arquivo NOVO acima do teto reprova, mesmo com
 *     --bless — crescer a dívida é sempre proibido.
 *   B (catraca): arquivo do baseline só pode crescer via --bless explícito.
 *   C (só encolhe sozinho): arquivo que encolhe regrava o baseline para baixo
 *     automaticamente — a dívida só pode diminuir sem cerimônia.
 *
 * O baseline (.line-budget.json) guarda SOMENTE os arquivos acima do teto;
 * quem está abaixo não precisa de registro (a regra A o cobre se subir).
 * Sem baseline, o modo padrão gera um do estado atual (bootstrap).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mesma resolução de raiz de scripts/check-test-list.ts: roda de scripts/ ou
// de dist/scripts/ (npm run lint:lines executa node dist/scripts/check-line-budget.js).
const up = path.join(__dirname, '..');
const buildRoot = fs.existsSync(path.join(up, 'package.json')) ? up : null;
const root = buildRoot || path.join(up, '..'); // raiz do package.json

const LIMITE = 400;
const BASELINE_PATH = path.join(root, '.line-budget.json');

interface Baseline {
  limite: number;
  gerado: string;
  excedente: number;
  arquivos: Record<string, number>;
}

/**
 * Listagem dos arquivos via git, com DIRETÓRIOS como argumento.
 *
 * ARMADILHA MEDIDA AQUI (mesma família da §5.7 do PLANO_MELHORIAS, onde um
 * glob de pathspec em src não casa arquivos na RAIZ de src/ e escondia
 * config.ts, app.ts, addon.ts, br-resolvers.ts, runtime.ts e warmup.ts): o
 * plano original pedia o glob puro "*-resolver", e aqui ele casa ZERO arquivos
 * dos shims — `git ls-files src resolvers scripts test types "*-resolver"`
 * devolve exatamente os mesmos 237 caminhos que sem o argumento. Com
 * "*-resolver/**" entram os 21 arquivos dos cinco diretórios de resolver
 * (bludv, comandotorrents, nerdfilmes, torrentdosfilmes, vacatorrent).
 */
function listarArquivos(): string[] {
  // git ls-files lista o ÍNDICE, não o disco: rascunhos locais não-rastreados
  // (scratch/, .env.bak-*) não triplicam o portão, e o que o CI examina é
  // exatamente o estado commitado. A regra A (arquivo novo) dispara no
  // `git add` — encenar um arquivo novo no índice já a exercita.
  const raw = execFileSync(
    'git',
    ['ls-files', 'src', 'resolvers', 'scripts', 'test', 'types', '*-resolver/**'],
    { encoding: 'utf8', cwd: root },
  );
  return raw
    .split(/\r?\n/)
    .map((linha) => linha.trim())
    .filter(
      (linha) =>
        linha.length > 0 &&
        (linha.endsWith('.ts') || linha.endsWith('.js')) &&
        !linha.endsWith('.d.ts'), // types/ é contrato declarativo, não código
    );
}

/**
 * Número de linhas que o EDITOR mostra: contagem de bytes 0x0A + 1 se o
 * arquivo não termina em newline. Contar \n em Buffer é imune a CRLF (o
 * working tree Windows tem CRLF por `* text=auto` + core.autocrlf=true; o CI
 * Linux tem LF) e não depende de decodificação. Caso real medido:
 * resolvers/profiles/vacatorrent.js termina em ';' sem newline — `wc -l` diz
 * 1024, o editor mostra 1025; sem o ajuste o baseline ficaria errado por 1.
 */
function contarLinhas(caminhoRel: string): number | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(path.join(root, caminhoRel));
  } catch {
    return null; // listado pelo git mas ausente no disco
  }
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) n++;
  }
  if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) n++;
  return n;
}

function hojeISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function excedenteDe(arquivos: Record<string, number>): number {
  let soma = 0;
  for (const linhas of Object.values(arquivos)) soma += linhas - LIMITE;
  return soma;
}

function escreverBaseline(arquivos: Record<string, number>): void {
  // Chaves em ordem alfabética para diff estável entre execuções.
  const ordenado: Record<string, number> = {};
  for (const k of Object.keys(arquivos).sort()) ordenado[k] = arquivos[k];
  const baseline: Baseline = {
    limite: LIMITE,
    gerado: hojeISO(),
    excedente: excedenteDe(ordenado),
    arquivos: ordenado,
  };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
}

function lerBaseline(): Baseline | null {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  if (!parsed || typeof parsed !== 'object' || !parsed.arquivos) {
    console.error(`baseline inválida: ${BASELINE_PATH} não tem o campo "arquivos"`);
    process.exit(1);
  }
  return parsed;
}

// --- entrada: --bless e --check são mutuamente exclusivos ---
const args = process.argv.slice(2);
const temBless = args.includes('--bless');
const temCheck = args.includes('--check');
const desconhecidos = args.filter((a) => a !== '--bless' && a !== '--check');
if (temBless && temCheck) {
  console.error('use --bless OU --check, não os dois');
  process.exit(1);
}
if (desconhecidos.length > 0) {
  console.error(`argumento desconhecido: ${desconhecidos.join(', ')}`);
  process.exit(1);
}

const caminhos = listarArquivos();
const linhasAtuais = new Map<string, number | null>();
let varridos = 0;
let acimaTeto = 0;
let excedenteAtual = 0;
for (const caminho of caminhos) {
  const linhas = contarLinhas(caminho);
  linhasAtuais.set(caminho, linhas);
  if (linhas === null) continue; // ausente no disco; tratado adiante
  varridos++;
  if (linhas > LIMITE) {
    acimaTeto++;
    excedenteAtual += linhas - LIMITE;
  }
}

const baseline = lerBaseline();
const notaEscrita: string[] = [];

// --- bootstrap: sem baseline, gera do estado atual ---
if (baseline === null) {
  if (temCheck) {
    console.error('baseline ausente (.line-budget.json): rode npm run lint:lines localmente para gerar o baseline');
    process.exit(1);
  }
  const arquivos: Record<string, number> = {};
  for (const [caminho, linhas] of linhasAtuais) {
    if (linhas !== null && linhas > LIMITE) arquivos[caminho] = linhas;
  }
  escreverBaseline(arquivos);
  console.log(
    `${varridos} arquivo(s) varridos; ${acimaTeto} acima do teto; excedente ${excedenteAtual}; baseline gerado.`,
  );
  process.exit(0);
}

// --- regra A: arquivo novo acima do teto (sem escape, nem com --bless) ---
const novosAcima: string[] = [];
for (const [caminho, linhas] of linhasAtuais) {
  if (linhas !== null && linhas > LIMITE && !(caminho in baseline.arquivos)) {
    novosAcima.push(caminho);
  }
}

// --- regra B: arquivo do baseline cresceu ---
const cresceram: Array<{ caminho: string; antes: number; agora: number }> = [];
// --- regra C: encolheu (regrava para baixo no modo padrão) ---
const encolheram: Array<{ caminho: string; antes: number; agora: number }> = [];
// --- prune: arquivo do baseline sumiu do disco/da listagem ---
const sumiram: string[] = [];

const arquivosNovo: Record<string, number> = { ...baseline.arquivos };
for (const [caminho, anterior] of Object.entries(baseline.arquivos)) {
  const atual = linhasAtuais.get(caminho);
  if (atual === undefined || atual === null) {
    sumiram.push(caminho);
    delete arquivosNovo[caminho];
    continue;
  }
  if (atual > anterior) cresceram.push({ caminho, antes: anterior, agora: atual });
  else if (atual < anterior) {
    encolheram.push({ caminho, antes: anterior, agora: atual });
    // Só encolhe sozinho: regrava para baixo; caiu ao teto ou abaixo, sai do mapa.
    if (atual > LIMITE) arquivosNovo[caminho] = atual;
    else delete arquivosNovo[caminho];
  }
}
cresceram.sort((a, b) => a.caminho.localeCompare(b.caminho));
encolheram.sort((a, b) => a.caminho.localeCompare(b.caminho));
novosAcima.sort();
sumiram.sort();

// --check é modo de leitura: NUNCA escreve, nem regra C nem bless.
const precisaEscrever =
  !temCheck && (encolheram.length > 0 || sumiram.length > 0 || (temBless && cresceram.length > 0));

console.log(
  `${varridos} arquivo(s) varridos; ${acimaTeto} acima do teto; excedente ${excedenteAtual}; ` +
    (precisaEscrever ? 'baseline regravado.' : 'baseline OK.'),
);

let falhou = false;

// Regra B (catraca): com --bless regrava em vez de reprovar; nos outros modos é falha.
if (cresceram.length > 0) {
  if (temBless) {
    for (const c of cresceram) {
      arquivosNovo[c.caminho] = c.agora;
      notaEscrita.push(`bless: ${c.caminho} ${c.antes} → ${c.agora}`);
    }
  } else {
    falhou = true;
    console.error('acima do baseline:');
    for (const c of cresceram) {
      console.error(`  ${c.caminho}  ${c.antes} → ${c.agora}  (+${c.agora - c.antes})`);
    }
  }
}

// Regra C (encolheu): modo padrão/bless já aplicou em arquivosNovo; --check só avisa.
if (encolheram.length > 0 || sumiram.length > 0) {
  if (temCheck) {
    if (encolheram.length > 0) {
      console.error('baseline desatualizada (arquivo encolheu); rode npm run lint:lines sem --check para regravar:');
      for (const c of encolheram) {
        console.error(`  ${c.caminho}  ${c.antes} → ${c.agora}  (-${c.antes - c.agora})`);
      }
    }
    if (sumiram.length > 0) {
      console.error('baseline desatualizada (arquivo sumiu do disco/da listagem); rode npm run lint:lines sem --check para regravar:');
      for (const caminho of sumiram) console.error(`  ${caminho}`);
    }
  } else {
    for (const c of encolheram) {
      notaEscrita.push(
        c.agora > LIMITE
          ? `encolheu: ${c.caminho} ${c.antes} → ${c.agora}`
          : `saiu do baseline (≤ ${LIMITE}): ${c.caminho} ${c.antes} → ${c.agora}`,
      );
    }
    for (const caminho of sumiram) notaEscrita.push(`removido do baseline (ausente): ${caminho}`);
  }
}

// Regra A: reprova sempre; arquivo novo acima do teto NUNCA entra no JSON via bless.
if (novosAcima.length > 0) {
  falhou = true;
  console.error(`arquivo novo acima do teto (${LIMITE}):`);
  for (const caminho of novosAcima) {
    const linhas = linhasAtuais.get(caminho) as number;
    console.error(`  ${caminho}  ${linhas}  (+${linhas - LIMITE})`);
  }
}

if (falhou) {
  console.error('extraia, ou registre com: npm run lint:lines -- --bless');
  if (precisaEscrever) escreverBaseline(arquivosNovo); // --bless grava mesmo saindo 1
  process.exit(1);
}

if (precisaEscrever) {
  escreverBaseline(arquivosNovo);
  for (const nota of notaEscrita) console.log(nota);
}
// Nada mudou: não escreve — segunda execução precisa sair 0 com JSON byte-idêntico.
process.exit(0);
