/* Atualização do app Power Movie: o app consulta GET /app/latest.json e baixa
 * o instalador de GET /app/files/<nome>, sempre com
 * `Authorization: Bearer <APP_UPDATE_TOKEN>`.
 *
 * O APK leva as chaves do app compiladas (TMDB, debrid...), então nada aqui é
 * público: sem token configurado a rota inteira responde 404, e token errado
 * também responde 404 (não confirma que a rota existe).
 *
 * Os arquivos ficam em `APP_UPDATE_DIR` (padrão data/app-updates, no volume)
 * e são publicados pelo script do repositório do app. O servidor só lê.
 */

import fs from 'node:fs';
import path from 'node:path';
import type express from 'express';
import { authorized } from '../utils/diagnostic-guard.js';

interface AppUpdatesConfig { token: string; dir: string }

// Nome de arquivo plano: sem barra, sem `..`, sem ponto inicial.
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const CONTENT_TYPES: Record<string, string> = {
  '.apk': 'application/vnd.android.package-archive',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.tpk': 'application/octet-stream',
};

function bearer(req: express.Request): string {
  const header = req.get('authorization') || '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
}

function makeAppUpdateHandlers(getConfig: () => AppUpdatesConfig) {
  const allowed = (req: express.Request) => {
    const { token } = getConfig();
    return Boolean(token) && authorized(token, bearer(req));
  };

  const latest = (req: express.Request, res: express.Response) => {
    res.set('Cache-Control', 'no-store');
    if (!allowed(req)) return res.status(404).json({ error: 'não encontrado' });
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(getConfig().dir, 'latest.json'), 'utf8');
    } catch {
      return res.status(404).json({ error: 'nenhuma versão publicada' });
    }
    try {
      return res.json(JSON.parse(raw));
    } catch {
      // JSON quebrado no meio de uma publicação: melhor "sem atualização"
      // do que mandar o app baixar algo pela metade.
      return res.status(503).json({ error: 'versão em publicação' });
    }
  };

  const file = (req: express.Request, res: express.Response) => {
    if (!allowed(req)) return res.status(404).json({ error: 'não encontrado' });
    const name = String(req.params.name || '');
    if (!FILE_NAME.test(name) || name.includes('..')) {
      return res.status(404).json({ error: 'não encontrado' });
    }
    const type = CONTENT_TYPES[path.extname(name).toLowerCase()];
    if (!type) return res.status(404).json({ error: 'não encontrado' });
    res.set('Cache-Control', 'no-store');
    res.type(type);
    // `root` faz o Express recusar qualquer caminho fora do diretório; o
    // sendFile também atende Range, então download interrompido pode retomar.
    return res.sendFile(name, { root: getConfig().dir, dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'não encontrado' });
    });
  };

  return { latest, file };
}

export { makeAppUpdateHandlers };
