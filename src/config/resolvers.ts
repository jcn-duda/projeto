import { BLUDV_DEFAULT_URL, list } from './helpers.js';

// Fábrica (não objeto pronto): módulo ESM é cacheado, e cada re-avaliação do
// compositor src/config.ts (ex.: bust de cache nos testes) precisa reler o
// process.env — a chamada re-executa, o objeto de módulo não.
// Defaults dos sites BR. O carregador embutido (src/br-resolvers.ts) passa
// cada `*Url` como `siteUrl` explícito para a factory do profile, então É AQUI
// que se troca um domínio derrubado -- o default hardcoded dentro do profile
// só vale para o modo container separado.
export const resolvers = () => ({
  embedded: String(process.env.BR_RESOLVERS_EMBEDDED || 'true') === 'true',
  host: process.env.BR_RESOLVERS_HOST || '127.0.0.1',
  // Desloca as portas dos resolvedores (8700..8708); o probe do painel usa a
  // mesma base para achar a porta certa de cada card.
  portOffset: Number(process.env.BR_RESOLVERS_PORT_OFFSET || 0) || 0,
  // Teto do teste DIRETO do resolvedor pelo painel (/test-resolver.json). A
  // busca no site pode passar por FlareSolverr/protetor de link, então o
  // default é largo; mínimo de 1s porque abaixo disso o probe não mede
  // busca nenhuma, só registra ruído de rede local.
  probeTimeoutMs: Math.max(1000, Number(process.env.RESOLVERS_PROBE_TIMEOUT_MS) || 25000),
  // As portas também pertencem à infraestrutura do addon. Os profiles
  // (ESM nativo) recebem-nas em br-resolvers.ts via config explícita da factory.
  ports: {
    bludv: 8700,
    comandotorrents: 8701,
    nerdfilmes: 8702,
    torrentdosfilmes: 8703,
    vacatorrent: 8704,
    redetorrent: 8705,
    apachetorrent: 8706,
    hdrtorrents: 8707,
    // TorrentGalaxy: o transporte do cliente HTTP C# do Jackett cai no
    // desafio do Cloudflare (200 com 0 itens), então a busca global passa
    // pelo mesmo binário Rust dos sites BR (mesma rede Docker, loopback).
    torrentgalaxy: 8708,
  },
  bludvUrl: (process.env.BLUDV_URL || BLUDV_DEFAULT_URL).replace(/\/$/, ''),
  comandotorrentsUrl: (process.env.COMANDOTORRENTS_URL || 'https://comandotorrents.to').replace(/\/$/, ''),
  // nerdviatorrents.net migrou para filmesviatorrents.net (301 permanente); o
  // domínio novo precisa estar também na allowlist do resolver, senão o
  // redirect vira blocked_host e a fonte morre em silêncio.
  // 2026-10-24: xfilmeshd.org responde 301 para xfilmeshd.net.
  nerdfilmesUrl: (process.env.NERDFILMES_URL || 'https://www.xfilmeshd.net').replace(/\/$/, ''),
  torrentdosfilmesUrl: (process.env.TORRENTDOSFILMES_URL || 'https://torrentdosfilmes-v2.xyz').replace(/\/$/, ''),
  // Vaca Torrent trocou de domínio de novo (2026-10-01): vaqueirofilmes1.com.
  // vaqueirofilmes.com e vacatorrentmov.com agora servem só a página "Novo
  // Endereço" (200, sem sitemap nem busca). Os três ficam na allowlist do
  // profile, para redirect/failover não virar blocked_host.
  vacatorrentUrl: (process.env.VACATORRENT_URL || 'https://vaqueirofilmes1.com').replace(/\/$/, ''),
  // Rede Torrent: atrás de desafio Cloudflare (o resolver resolve via
  // FlareSolverr), com magnets diretos no HTML do post.
  redetorrentUrl: (process.env.REDETORRENT_URL || 'https://www.redetorrent.xyz').replace(/\/$/, ''),
  // Apache Torrent: buscador PHP próprio com sessão+token por sessão (o
  // resolver mantém a sessão); magnets diretos no post, sem protetor. O apex
  // apachetorrent.com faz 301 para o plural apachetorrents.com — os DOIS ficam
  // na allowlist do profile, senão o redirect vira blocked_host e a fonte morre
  // em silêncio (a env VENCE este default; confira o .env.example).
  apachetorrentUrl: (process.env.APACHETORRENT_URL || 'https://apachetorrents.com').replace(/\/$/, ''),
  // HDR Torrents: busca nativa quebrada (devolve a homepage), o resolver
  // raspa as páginas de listagem e casa a query contra o catálogo em cache.
  // Magnets diretos no post, sem protetor de link.
  hdrtorrentsUrl: (process.env.HDRTORRENTS_URL || 'https://hdrtorrents.net').replace(/\/$/, ''),
  // TorrentGalaxy é GLOBAL (en-US), não BR: mesmo binário Rust e mesmo padrão
  // de card Cardigann local, só que o site não é de dublado português.
  torrentgalaxyUrl: (process.env.TORRENTGALAXY_URL || 'https://torrentgalaxy.one').replace(/\/$/, ''),
  extraProtectors: list(process.env.EXTRA_ALLOWED_PROTECTORS),
});
