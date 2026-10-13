// Núcleo dos oráculos de golden do resolver Rust. Cada site chama goldenRun
// com os ganchos do profile TS; a saída é um JSON único por site, lido pelo
// teste `rust/crates/adom-resolvers/tests/<site>_golden.rs`.
//
// Formato (campos de link em snake_case, como o ResolverLink do Rust):
// {
//   site, self_url,
//   search: [{ fixture, base_url, posts: [{title,url,poster,date,year}] }],
//   posts:  [{ fixture, post, links|null, error|null, titles: [..], html|null, rss|null }],
//   titles: [{ post, link, index, out }],      // releaseTitle combinatório
//   clean:  [[entrada, saída], ...]            // cleanTitle sobre um corpus
// }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURES = path.join(ROOT, 'test/fixtures');
const OUT_DIR = path.join(ROOT, 'rust/crates/adom-resolvers/tests/golden');

export const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const SNAKE = { episodeLast: 'episode_last', realTitle: 'real_title' };
const LINK_KEYS = ['url', 'quality', 'size', 'audio', 'episode', 'episode_last', 'season', 'source', 'real_title', 'description'];

/** Link TS → JSON com as chaves do ResolverLink do Rust (ausente = null). */
export function linkJson(link) {
  const out = Object.fromEntries(LINK_KEYS.map((k) => [k, null]));
  for (const [key, value] of Object.entries(link || {})) {
    const k = SNAKE[key] || key;
    if (LINK_KEYS.includes(k)) out[k] = value ?? null;
    else out[`_extra_${k}`] = value ?? null;
  }
  return out;
}

export function postJson(post) {
  return {
    title: post.title ?? '',
    url: post.url ?? '',
    poster: post.poster ?? null,
    date: post.date ?? null,
    year: typeof post.year === 'number' ? post.year : null,
  };
}

/** Título do post da fixture: <h1>, senão og:title, senão o nome do arquivo. */
export function postTitleOf(html, name) {
  const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1 && strip(h1[1])) return strip(h1[1]);
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return og[1];
  return name.replace(/\.html?$/, '');
}

/** Combinações de link para o releaseTitle (cobre tags, episódio e opção N). */
export function titleCombos(titles) {
  const cases = [];
  for (const title of titles) {
    for (const quality of [null, 1080, 2160]) {
      for (const audio of [null, 'dublado', 'legendado', 'desconhecido']) {
        for (const source of [null, 'WEB-DL', 'BLU-RAY']) {
          for (const size of [null, '2.4 GB']) {
            for (const [episode, episodeLast] of [[null, null], [5, null], [5, 7]]) {
              for (const index of [null, 2]) {
                cases.push({ title, link: { url: 'magnet:?xt=urn:btih:x', quality, audio, source, size, episode, episodeLast }, index });
              }
            }
          }
        }
      }
    }
  }
  return cases;
}

const EXTRA_TITLES = [
  'A Casa do Dragão 1ª Temporada Torrent (2022) WEB-DL 720p/1080p/4K Dual Áudio',
  'Oppenheimer Torrent (2023) BluRay 1080p 2160p Dual Áudio 5.1 Download',
  'The Boys – 4ª Temporada Completa Torrent (2024) WEB-DL Legendado | Dublado',
  'Duna: Parte Dois (2024) REMUX HDR10+ Dolby Vision Áudio Original',
  'Batman: A Queda do Morcego – Parte 1 Torrent (2026) WEB-DL 1080p Dual Áudio',
  'Coração de Lutador &#8211; Torrent (2019) HD TV Nacional Grátis Online',
  'S.W.A.T. 7ª Temporada Torrent (2024) WEB-RIP 720p HD Assistir',
];

function corpusTitles() {
  const out = [];
  for (const f of ['br-corpus.json', 'title-precision-corpus.json']) {
    const c = JSON.parse(fixture(f));
    for (const item of c.itens || []) out.push(item.t ?? item.title);
  }
  return out.filter(Boolean);
}

/**
 * @param {object} cfg
 * @param {string} cfg.site
 * @param {string[]} [cfg.searchFixtures]
 * @param {(html: string) => any[]} [cfg.parsePosts]
 * @param {string[]} cfg.postFixtures
 * @param {string} cfg.baseUrl  origem usada para montar a URL do post
 * @param {(html: string, postUrl: string) => any[]} cfg.postLinks
 * @param {(post: any, link: any, index: any) => string} cfg.releaseTitle
 * @param {(items: any[]) => string} [cfg.searchPageHtml]
 * @param {(items: any[], category: number) => string} [cfg.rssXml]
 * @param {(title: string) => string} [cfg.cleanTitle]
 * @param {(name: string, html: string) => any} [cfg.postOf] post sintético da fixture
 */
export async function goldenRun(cfg) {
  const out = { site: cfg.site, self_url: null, search: [], posts: [], titles: [], clean: [] };

  for (const name of cfg.searchFixtures || []) {
    const posts = cfg.parsePosts(fixture(name)).map(postJson);
    out.search.push({ fixture: name, base_url: cfg.baseUrl, posts });
  }

  const postTitles = [];
  for (const [i, name] of cfg.postFixtures.entries()) {
    const html = fixture(name);
    const slug = name.replace(/\.(html?|json)$/, '').replace(/[^a-z0-9-]+/gi, '-');
    const post = cfg.postOf
      ? cfg.postOf(name, html)
      : { title: postTitleOf(html, name), url: `${cfg.baseUrl}/${slug}/`, poster: i === 0 ? '/wp-content/uploads/capa&poster.jpg' : null };
    postTitles.push(post.title);
    const entry = { fixture: name, post: postJson(post), links: null, error: null, titles: [], html: null, rss: null };
    let links;
    try {
      links = cfg.postLinks(html, post.url);
    } catch (err) {
      entry.error = String(err?.message || err);
      out.posts.push(entry);
      continue;
    }
    entry.links = links.map(linkJson);
    entry.titles = links.map((link, index) => cfg.releaseTitle(post, link, index));
    const items = links.map((link, index) => ({ post, link, index, count: links.length }));
    if (cfg.searchPageHtml) entry.html = cfg.searchPageHtml(items);
    if (cfg.rssXml) entry.rss = cfg.rssXml(items, 2000);
    out.posts.push(entry);
  }

  // self_url: o prefixo do href de download da primeira página com item.
  for (const p of out.posts) {
    const m = p.html && p.html.match(/href="([^"]*?)\/resolve\?/);
    if (m) { out.self_url = m[1]; break; }
  }

  const combos = titleCombos([EXTRA_TITLES[0], postTitles[0]].filter(Boolean));
  for (const c of combos) {
    const post = { title: c.title, url: `${cfg.baseUrl}/x/` };
    out.titles.push({ post: postJson(post), link: linkJson(c.link), index: c.index, out: cfg.releaseTitle(post, c.link, c.index) });
  }

  if (cfg.cleanTitle) {
    for (const t of [...EXTRA_TITLES, ...postTitles, ...corpusTitles()]) out.clean.push([t, cfg.cleanTitle(t)]);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${cfg.site}.json`);
  // Compacto: o golden é lido por máquina e o diff que importa é o do teste.
  fs.writeFileSync(file, `${JSON.stringify(out)}\n`);
  const linkCount = out.posts.reduce((n, p) => n + (p.links?.length || 0), 0);
  console.log(`[golden] ${cfg.site}: ${out.search.length} busca(s), ${out.posts.length} post(s), ${linkCount} botões, ${out.titles.length} títulos, ${out.clean.length} limpezas → ${path.relative(ROOT, file)}`);
}
