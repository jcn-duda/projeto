import type { Server } from 'node:http';

export type ResolverAudio = string;

export interface ResolverLink {
  url: string;
  quality: number | null;
  size: string | null;
  audio: ResolverAudio;
  source: string | null;
  episode: number | null;
}

export type ResolverLinkInput = Partial<ResolverLink>;

export interface ResolverPost {
  url: string;
  title: string;
  poster?: string | null;
  original?: string | null;
  date?: string | null;
}

export interface ResolverCacheEntry {
  expiresAt: number;
  value: unknown;
}

export interface ResolverCache {
  clear(): void;
  get(key: string): ResolverCacheEntry;
  set(key: string, entry: ResolverCacheEntry): this;
  has(key: string): boolean;
  delete(key: string): boolean;
  keys(): IterableIterator<string>;
  readonly size: number;
}

export interface SiteSelector {
  url(): string;
  hosts(): string[];
  onDomainChange(listener: (url: string) => void): void;
  noteFailure(): Promise<void>;
}

export interface ResolverProfile {
  createServer(): Server;
  siteSelector: SiteSelector;
  parsePosts(html: string | null | undefined): ResolverPost[];
  parseDownloadLinks(html: string | null | undefined, baseUrl?: string): ResolverLink[];
  parsePostDate(html: string | null | undefined): string | null;
  parseSize(value: string | null | undefined): number | null;
  releaseTitle(title: string, link: ResolverLinkInput, index?: number): string;
  cleanPostTitle(title: string): string;
  normalizeQuery(query: string): string;
  searchPageHtml(items: Array<{ post: ResolverPost; link: ResolverLinkInput; index: number }>): string;
  assertAllowedUrl(url: string | null | undefined): URL;
  extractMagnet(html: string | null | undefined): string | null;
  extractMetaRefresh(html: string | null | undefined): string | null;
  extractEpisode(text: string | null | undefined): number | null;
  nextProtectedUrl(html: string | null | undefined, baseUrl?: string): string | null;
  decodeEntities(text: string): string;
  normalizeQuality(text: string): number | null;
  normalizeSource(text: string): string | null;
  isDetailHost(url: string): boolean;
  isProtectorHost(url: string): boolean;
  isGenericListPost(title: string | null | undefined): boolean;
  normalizeFilterText(text: string): string;
  stripTrailingYears(tokens: string[]): string[];
  computeWantedTokens(query: string): string[];
  matchesResolverQuery(post: Pick<ResolverPost, 'title'>, query: string): boolean;
  normalizeSeasonValue(value: RegExpMatchArray | readonly string[] | string | number | null): number | null;
  matchesSeasonSeason(post: Pick<ResolverPost, 'title'>, season: RegExpMatchArray | readonly string[] | string | number | null): boolean;
  selectSearchPosts(html: string, query: string, season?: RegExpMatchArray | readonly string[] | string | number | null): ResolverPost[];
  buttonId(link: { url: string }): string | null;
  pickButton<T extends { url: string }>(links: T[], index: number, id: string | null, count: string | number | null): T | null;
  unwrapResolverUrl(url: string, seed?: { index?: string | null; hash?: string | null; count?: string | null }): { url: string | null; index: string | null; hash: string | null; count: string | null };
  getPostLinks(url: string): Promise<{ links: ResolverLink[] }>;
  resolvePost(url: string, options?: { audio?: ResolverAudio }): Promise<string>;
  resolveBest(url: string): Promise<string>;
  resolveButton(url: string, index: number, hash?: string | null, count?: string | number | null): Promise<string>;
  searchPosts(query: string): Promise<ResolverPost[]>;
  fetchFollowingAllowed(url: string, baseUrl?: string): Promise<string>;
  isValidDirectMagnet(url: string): boolean;
  pubDate(value: string | null | undefined): string | null;
  pickBestLink(links: ResolverLink[], options?: { audio?: ResolverAudio }): ResolverLink;
  sortLinks(links: ResolverLink[]): ResolverLink[];
  createSiteSelector(...args: unknown[]): SiteSelector;
  isNetworkError(error: unknown): boolean;
  getFlareSession(host: string): { userAgent: string; cookies: string } | null;
  buildFlareHeaders(host: string): Record<string, string>;
  fetchText(url: string): Promise<string>;
  fetchTextViaFlare(url: string): Promise<string>;
  cache: ResolverCache;
  postCache: ResolverCache;
  searchCache: ResolverCache;
  magnetCache: ResolverCache;
  inFlight: Map<string, Promise<unknown>>;
}
