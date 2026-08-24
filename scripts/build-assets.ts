#!/usr/bin/env node
/**
 * Copia os assets estáticos e resolvers para dentro de dist/ após a compilação do TypeScript.
 *
 * Preserva exatamente o que a imagem Docker e os testes em runtime dependem:
 * - src/public -> dist/src/public (página /configure e dashboard)
 * - test/fixtures -> dist/test/fixtures (fixtures de teste)
 * - jackett-bludv -> dist/jackett-bludv (definições cardigann)
 * - resolvers/ -> dist/resolvers/ (núcleo CommonJS e profiles dos resolvers)
 * - *-resolver/ -> dist/*-resolver/ (os 4 micro-resolvers carregados pelo br-resolvers)
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
  'resolvers',
];

const resolversToCopy = [
  'bludv-resolver',
  'comandotorrents-resolver',
  'nerdfilmes-resolver',
  'torrentdosfilmes-resolver',
];

function copyAndVerify(relativeSrc: string, relativeDst?: string) {
  const srcPath = path.join(root, relativeSrc);
  const dstPath = path.join(distRoot, relativeDst || relativeSrc);

  if (!fs.existsSync(srcPath)) {
    console.error(`[build-assets] Erro: caminho de origem obrigatório não existe: ${srcPath}`);
    process.exit(1);
  }

  fs.mkdirSync(dstPath, { recursive: true });
  fs.cpSync(srcPath, dstPath, { recursive: true });

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

  for (const resolver of resolversToCopy) {
    if (fs.existsSync(path.join(root, resolver))) {
      copyAndVerify(resolver);
    }
  }

  console.log('[build-assets] Todos os assets e resolvers foram copiados para dist/ com sucesso.');
} catch (err: any) {
  console.error('[build-assets] Falha crítica na cópia de assets:', err?.message || err);
  process.exit(1);
}
