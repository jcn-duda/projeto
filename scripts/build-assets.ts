#!/usr/bin/env node
/**
 * Copia para dist/ apenas os ASSETS NÃO-COMPILÁVEIS após o tsc.
 *
 * Preserva exatamente o que a imagem Docker e os testes em runtime dependem:
 * - src/public -> dist/src/public (HTML/CSS/imagens de /configure e dashboard)
 * - test/fixtures -> dist/test/fixtures (fixtures de teste)
 * - jackett-bludv -> dist/jackett-bludv (definições cardigann)
 *
 * `resolvers/` e os seis `*-resolver/` NÃO são mais copiados: o próprio tsc
 * compila a ilha inteira (include `resolvers/**` e `*-resolver/**`) e emite os
 * .js em dist/. Copiar fontes aqui sobrescrevia o emit e vazava `.ts` para
 * dentro da imagem. O filtro de `.ts` permanece como guarda-corpo para assets
 * que um dia carreguem tipo.
 *
 * Falha em voz alta caso qualquer diretório essencial falhe ao ser copiado ou não exista.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Identifica a raiz do projeto (onde mora package.json)
const up = path.join(__dirname, '..');
const root = fs.existsSync(path.join(up, 'package.json')) ? up : path.join(up, '..');
const distRoot = path.join(root, 'dist');

if (!fs.existsSync(distRoot)) {
  console.error(`[build-assets] Erro: diretório dist não encontrado em ${distRoot}. Execute o tsc antes.`);
  process.exit(1);
}

const assetsToCopy = [
  'src/public',
  'test/fixtures',
  'jackett-bludv',
];

function copyAndVerify(relativeSrc: string, relativeDst?: string) {
  const srcPath = path.join(root, relativeSrc);
  const dstPath = path.join(distRoot, relativeDst || relativeSrc);

  if (!fs.existsSync(srcPath)) {
    console.error(`[build-assets] Erro: caminho de origem obrigatório não existe: ${srcPath}`);
    process.exit(1);
  }

  fs.mkdirSync(dstPath, { recursive: true });
  // Nunca copia fonte `.ts`/`.d.ts`: esses arquivos pertencem ao tsc (emit) ou
  // ao contrato de tipos, não ao runtime de dist/.
  fs.cpSync(srcPath, dstPath, {
    recursive: true,
    filter: (source) => !source.endsWith('.ts'),
  });

  if (!fs.existsSync(dstPath)) {
    console.error(`[build-assets] Erro: falha ao verificar destino copiado: ${dstPath}`);
    process.exit(1);
  }

  const entries = fs.readdirSync(dstPath);
  if (entries.length === 0) {
    console.error(`[build-assets] Erro: diretório de destino copiado está vazio: ${dstPath}`);
    process.exit(1);
  }
}

try {
  for (const asset of assetsToCopy) {
    if (fs.existsSync(path.join(root, asset))) {
      copyAndVerify(asset);
    }
  }

  console.log('[build-assets] Assets não-compiláveis copiados para dist/ com sucesso.');
} catch (err: any) {
  console.error('[build-assets] Falha crítica na cópia de assets:', err?.message || err);
  process.exit(1);
}
