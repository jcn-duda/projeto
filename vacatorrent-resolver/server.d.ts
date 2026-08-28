import type { Server } from 'node:http';
import type { SiteSelector } from '../types/resolver-shim.js';

// Interface do perfil vacatorrent, independente do ResolverProfile compartilhado
// (este perfil publica mais parsers e assinaturas próprias; os outros 4 perfis e o
// carregador embutido nao dependem destes nomes). Usada pelos testes e pelo shim.
export interface VacaWork {
  url: string;
  title: string;
  type: 'Filme' | 'Série';
  year: number | null;
  poster: string | null;
  idioma: string | null;
  imdb: string | null;
}

export interface VacaLink {
  url: string;
  quality: number | null;
  source: string | null;
  size: string | null;
  audio: string | null;
  episode: number | null;
}

interface VacaProfile {
  createServer(): Server;
  siteSelector: SiteSelector;
  parseSearchJson(text: string): VacaWork[];
  parseDownloadLinks(html: string, baseUrl?: string, options?: { season?: number | null; realTitle?: string | null }): VacaLink[];
  extractBatchTitle(html: string): string | null;
  releaseTitle(post: { title?: string; year?: number | string | null } | string, link: Partial<VacaLink>, index?: number): string;
  searchPageHtml(items: Array<unknown>): string;
  assertAllowedUrl(url: string): URL;
  isDetailHost(url: string): boolean;
  isProtectorHost(url: string): boolean;
  normalizeQuery(query: string): string;
  nextProtectedUrl(html: string, baseUrl?: string): string | null;
}

declare const resolver: VacaProfile;
export = resolver;