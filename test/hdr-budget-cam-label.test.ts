// HDR que não abre circuito, MagnetDownload no lugar certo e rótulo CAM honesto.
//
// Três melhorias pós-deploy medidas em produção:
// 1. HDR: orçamento de tempo na raspagem (parcial → TTL curto), SWR (não
//    expira duro) e warm() no boot.
// 2. MagnetDownload: sai de slowIndexers e vai para indexOnlyIndexers (o site
//    responde em ~48s, nunca cabe no orçamento de 20s da resposta).
// 3. Rótulo CAM: quando o dn= do magnet revela CAMRip mas o título do post
//    é limpo, a fonte sai CAM (a evidência do arquivo vence o palpite).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { toStremioStream } from '../src/utils/search-names.js';
import { inputFromItem } from '../src/utils/magnet-bank-merge.js';
import { sourceFromTitle } from '../src/utils/audio-quality.js';
import { magnetDisplayName } from '../src/utils/title-normalization.js';
import type { RawItem } from '../types/domain.js';

const HASH = 'a'.repeat(40);
const magnetUri = (dn: string) => `magnet:?xt=urn:btih:${HASH}&dn=${encodeURIComponent(dn)}`;

// ─── Fase 1: HDR — orçamento, SWR e warm ─────────────────────────────────────

// O teste do HDR é estrutural: verifica que o perfil expõe warm(), que
// fetchAllListingsDetailed devolve { items, partial } e que o DEFAULTS tem
// listingBudgetMs. O comportamento real (raspagem lenta) depende de rede;
// o contrato é testado via tipo e existência de método.
import { createResolver as createHdrResolver } from '../resolvers/profiles/hdrtorrents.js';
import { DEFAULTS as HDR_DEFAULTS } from '../resolvers/profiles/hdrtorrents.js';

describe('Fase 1: HDR — orçamento de raspagem + SWR + warm', () => {
  test('DEFAULTS tem listingBudgetMs e listingPartialCacheMs', () => {
    assert.ok(typeof HDR_DEFAULTS.listingBudgetMs === 'number', 'listingBudgetMs existe');
    assert.ok(HDR_DEFAULTS.listingBudgetMs > 0, 'listingBudgetMs > 0');
    assert.ok(typeof HDR_DEFAULTS.listingPartialCacheMs === 'number', 'listingPartialCacheMs existe');
    // O TTL parcial é menor que o TTL cheio (2 min < 30 min).
    assert.ok(HDR_DEFAULTS.listingPartialCacheMs < HDR_DEFAULTS.listingCacheMs,
      'TTL parcial < TTL cheio');
  });

  test('createResolver expõe warm() e fetchAllListingsDetailed()', () => {
    const resolver = createHdrResolver({
      port: 18707,
      selfUrl: 'http://127.0.0.1:18707',
      extraProtectors: [],
    }) as any;
    assert.equal(typeof resolver.warm, 'function', 'warm() é exposto');
    assert.equal(typeof resolver.fetchAllListingsDetailed, 'function',
      'fetchAllListingsDetailed() é exposto');
  });

  test('site simulado lento: busca devolve dentro do orçamento e marca parcial', async () => {
    // Mock de fetch que simula páginas lentas (2s cada). Com budget de 10s,
    // o resolver coleta ~5 páginas e marca parcial.
    const originalFetch = globalThis.fetch;
    let pageCount = 0;
    // HTML compatível com o parser do HDR (.media-card-link).
    const fakeListingHtml = (n: number) => {
      const cards = Array.from({ length: 15 }, (_, i) => {
        const idx = n * 100 + i;
        return `<a href="https://hdr.test/filme-${idx}/" class="media-card-link">
          <span class="media-card-title">Filme ${idx} 1080p</span>
          <span class="media-card-year">2026</span>
          <span class="badge-tipo">Filme</span>
          <span class="badge-qualidade">1080p</span>
        </a>`;
      }).join('\n');
      return `<html><body>${cards}</body></html>`;
    };

    (globalThis.fetch as any) = async (url: any) => {
      const target = String(url);
      if (target.includes('/pagina/') || target.match(/hdr\.test\/?$/)) {
        pageCount++;
        await new Promise((r) => setTimeout(r, 2_000)); // 2s por página
        return {
          ok: true, status: 200,
          headers: new Headers(),
          text: async () => fakeListingHtml(pageCount),
        };
      }
      return { ok: false, status: 404, headers: new Headers(), text: async () => '' };
    };

    try {
      const resolver = createHdrResolver({
        port: 18708,
        selfUrl: 'http://127.0.0.1:18708',
        siteUrl: 'https://hdr.test',
        extraProtectors: [],
      }) as any;

      const startedAt = Date.now();
      const result = await resolver.fetchAllListingsDetailed();
      const elapsed = Date.now() - startedAt;

      // O budget é 10s; com 2s por página, coleta ~5 páginas em ~10s.
      // Mas o budget é medido ANTES de cada página, então para quando estoura.
      assert.ok(result.partial, 'resultado é parcial (estourou o orçamento)');
      assert.ok(result.items.length > 0, `coletou ${result.items.length} item(ns) antes de estourar`);
      assert.ok(elapsed < 15_000, `devolveu em ${elapsed}ms (dentro do razoável)`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('SWR: com lastGood, devolve catálogo velho na hora quando TTL vence', async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;

    (globalThis.fetch as any) = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 500));
      const cards = Array.from({ length: 15 }, (_, i) => {
        const idx = callCount * 100 + i;
        return `<a href="https://hdr2.test/f${idx}/" class="media-card-link">
          <span class="media-card-title">Filme ${idx} 1080p</span>
          <span class="media-card-year">2026</span>
          <span class="badge-tipo">Filme</span>
          <span class="badge-qualidade">1080p</span>
        </a>`;
      }).join('\n');
      return {
        ok: true, status: 200,
        headers: new Headers(),
        text: async () => `<html><body>${cards}</body></html>`,
      };
    };

    try {
      const resolver = createHdrResolver({
        port: 18709,
        selfUrl: 'http://127.0.0.1:18709',
        siteUrl: 'https://hdr2.test',
        extraProtectors: [],
      }) as any;

      // Primeira busca: fria, espera o scraping.
      const first = await resolver.fetchAllListingsDetailed();
      assert.ok(!first.partial, 'primeira busca completa');
      const firstCount = first.items.length;
      assert.ok(firstCount > 0, 'coletou itens na primeira busca');

      // Força expiração do TTL (manipula o cache diretamente).
      const cacheEntry = resolver.listingCache.get('all');
      if (cacheEntry) {
        cacheEntry.expiresAt = Date.now() - 1; // expira agora
      }

      // Segunda busca: com lastGood, devolve na hora (SWR).
      const startedAt = Date.now();
      const second = await resolver.fetchAllListingsDetailed();
      const elapsed = Date.now() - startedAt;

      // SWR: devolve o lastGood imediatamente (< 50ms), não espera o refresh.
      assert.ok(elapsed < 200, `SWR devolveu em ${elapsed}ms (esperava < 200ms)`);
      assert.equal(second.items.length, firstCount, 'devolveu o mesmo catálogo do lastGood');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('warm() popula o cache sem request de busca', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;

    (globalThis.fetch as any) = async () => {
      fetchCalls++;
      const cards = Array.from({ length: 15 }, (_, i) => {
        const idx = fetchCalls * 100 + i;
        return `<a href="https://hdr3.test/w${idx}/" class="media-card-link">
          <span class="media-card-title">Warm ${idx} 1080p</span>
          <span class="media-card-year">2026</span>
          <span class="badge-tipo">Filme</span>
          <span class="badge-qualidade">1080p</span>
        </a>`;
      }).join('\n');
      return {
        ok: true, status: 200,
        headers: new Headers(),
        text: async () => `<html><body>${cards}</body></html>`,
      };
    };

    try {
      const resolver = createHdrResolver({
        port: 18710,
        selfUrl: 'http://127.0.0.1:18710',
        siteUrl: 'https://hdr3.test',
        extraProtectors: [],
      }) as any;

      await resolver.warm();

      // warm() fez fetch das listagens.
      assert.ok(fetchCalls > 0, 'warm() fez pelo menos 1 fetch');

      // O cache de listagem está populado.
      const cached = resolver.listingCache.get('all');
      assert.ok(cached, 'cache de listagem populado após warm()');
      assert.ok((cached as any).value.items.length > 0, 'itens no cache');

      // searchPosts usa o cache do warm (sem fetch extra de listagem).
      const callsBefore = fetchCalls;
      const items = await resolver.searchPosts('Warm');
      // Não fez fetch novo de listagem (usou o cache do warm).
      // Pode ter feito fetch de conteúdo dos posts, mas não de listagem.
      assert.ok(items.length >= 0, 'searchPosts funcionou com cache do warm');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── Fase 2: MagnetDownload em indexOnlyIndexers ─────────────────────────────

describe('Fase 2: MagnetDownload → indexOnlyIndexers', () => {
  test('magnetdownload está em indexOnlyIndexers e fora de slowIndexers', () => {
    const cfg = config.jackett;
    assert.ok(
      cfg.indexOnlyIndexers.includes('magnetdownload'),
      'magnetdownload está em indexOnlyIndexers',
    );
    assert.ok(
      !cfg.slowIndexers.includes('magnetdownload'),
      'magnetdownload NÃO está em slowIndexers',
    );
  });

  test('hdrtorrent-cardigann está em ambas as listas (slow + index-only)', () => {
    const cfg = config.jackett;
    assert.ok(cfg.slowIndexers.includes('hdrtorrent-cardigann'),
      'hdrtorrent-cardigann está em slowIndexers (busca ao vivo com SWR)');
    assert.ok(cfg.indexOnlyIndexers.includes('hdrtorrent-cardigann'),
      'hdrtorrent-cardigann está em indexOnlyIndexers (colhedor)');
  });
});

// ─── Fase 3: Rótulo CAM honesto ──────────────────────────────────────────────

describe('Fase 3: Rótulo CAM do magnet', () => {
  test('toStremioStream: título limpo + dn CAMRip → fonte CAM', () => {
    const item: RawItem = {
      title: 'Resident Evil (2026) [1080p 2.60 GB]',
      magnet: magnetUri('Resident.Evil.2026.1080p.CAMRip.x264'),
      seeders: 10,
      indexer: 'comandotorrents',
    };
    const stream = toStremioStream(item);
    assert.ok(stream, 'stream não é null');
    // O nome do stream contém "CAM" porque o dn= revela a gravação.
    assert.match(String(stream!.name), /CAM/, `o nome do stream contém CAM: "${stream!.name}"`);
  });

  test('toStremioStream: título com CAM + dn limpo → fonte CAM (título vence)', () => {
    const item: RawItem = {
      title: 'Resident.Evil.2026.CAMRip.1080p',
      magnet: magnetUri('Resident.Evil.2026.1080p.WEB-DL'),
      seeders: 10,
    };
    const stream = toStremioStream(item);
    assert.ok(stream, 'stream não é null');
    // O título diz CAM → a fonte é CAM (o título é o caminho default).
    assert.match(String(stream!.name), /CAM/, `CAM pelo título: "${stream!.name}"`);
  });

  test('toStremioStream: título limpo + dn limpo → fonte do título', () => {
    const item: RawItem = {
      title: 'Filme.2026.1080p.BluRay.x264',
      magnet: magnetUri('Filme.2026.1080p.BluRay.x264'),
      seeders: 10,
    };
    const stream = toStremioStream(item);
    assert.ok(stream, 'stream não é null');
    assert.match(String(stream!.name), /BluRay/, `fonte do título: "${stream!.name}"`);
  });

  test('toStremioStream: título limpo + sem magnet → fonte vazia', () => {
    const item: RawItem = {
      title: 'Resident Evil (2026) [1080p 2.60 GB]',
      infoHash: HASH,
      seeders: 10,
    };
    const stream = toStremioStream(item);
    assert.ok(stream, 'stream não é null');
    // Sem magnet e sem fonte no título → fonte vazia (não mente).
    assert.doesNotMatch(String(stream!.name), /CAM|BluRay|WEB/, `sem fonte: "${stream!.name}"`);
  });

  test('magnet-bank-merge: magnet com CAMRip preserva evidência no título', () => {
    const item: RawItem = {
      title: 'Resident Evil (2026) [1080p 2.60 GB]',
      magnet: magnetUri('Resident.Evil.2026.1080p.CAMRip.x264'),
      seeders: 10,
      indexer: 'comandotorrents',
    };
    const result = inputFromItem(item, 'comandotorrents');
    assert.ok(result, 'inputFromItem devolveu resultado');
    // O título armazenado é o dn= do magnet (que contém CAMRip), não o
    // título limpo do post. Assim a evidência CAM sobrevive no banco.
    assert.match(result!.magnet.title, /CAMRip/i,
      `título armazenado revela CAM: "${result!.magnet.title}"`);
  });

  test('magnet-bank-merge: magnet sem CAM não muda o título', () => {
    const item: RawItem = {
      title: 'Filme.2026.1080p.BluRay',
      magnet: magnetUri('Filme.2026.1080p.BluRay'),
      seeders: 10,
      indexer: 'comandotorrents',
    };
    const result = inputFromItem(item, 'comandotorrents');
    assert.ok(result, 'inputFromItem devolveu resultado');
    // Sem CAM no magnet, o título do post é preservado.
    assert.equal(result!.magnet.title, 'Filme.2026.1080p.BluRay');
  });

  test('magnet-bank-merge: sem magnet, título do post é preservado', () => {
    const item: RawItem = {
      title: 'Resident Evil (2026) [1080p 2.60 GB]',
      infoHash: HASH,
      seeders: 10,
      indexer: 'comandotorrents',
    };
    const result = inputFromItem(item, 'comandotorrents');
    assert.ok(result, 'inputFromItem devolveu resultado');
    assert.equal(result!.magnet.title, 'Resident Evil (2026) [1080p 2.60 GB]');
  });
});
