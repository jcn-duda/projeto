import { BLUDV_DEFAULT_URL, list } from './helpers.js';

// Fábrica (não objeto pronto): módulo ESM é cacheado, e cada re-avaliação do
// compositor src/config.ts (ex.: bust de cache nos testes) precisa reler o
// process.env — a chamada re-executa, o objeto de módulo não.
// Defaults dos sites BR. O carregador embutido (src/br-resolvers.ts) injeta
// estes valores no SITE_URL de cada resolvedor quando a env não vem do .env,
// então É AQUI que se troca um domínio derrubado -- o default hardcoded no
// <nome>-resolver/server.js só vale para o modo container separado.
export const resolvers = () => ({
  embedded: String(process.env.BR_RESOLVERS_EMBEDDED || 'true') === 'true',
  host: process.env.BR_RESOLVERS_HOST || '127.0.0.1',
  portOffset: Number(process.env.BR_RESOLVERS_PORT_OFFSET || 0) || 0,
  // As portas também pertencem à infraestrutura do addon. Os profiles
  // CommonJS recebem-nas pela ponte temporária em br-resolvers.ts.
  ports: {
    bludv: 8700,
    comandotorrents: 8701,
    nerdfilmes: 8702,
    torrentdosfilmes: 8703,
    vacatorrent: 8704,
  },
  bludvUrl: (process.env.BLUDV_URL || BLUDV_DEFAULT_URL).replace(/\/$/, ''),
  comandotorrentsUrl: (process.env.COMANDOTORRENTS_URL || 'https://comandotorrents.to').replace(/\/$/, ''),
  // xnerdfilmes.net migrou para nerdviatorrents.net (301 permanente); o
  // domínio novo precisa estar também na allowlist do resolver, senão o
  // redirect vira blocked_host e a fonte morre em silêncio.
  nerdfilmesUrl: (process.env.NERDFILMES_URL || 'https://www.nerdviatorrents.net').replace(/\/$/, ''),
  torrentdosfilmesUrl: (process.env.TORRENTDOSFILMES_URL || 'https://torrentdosfilmes-v2.xyz').replace(/\/$/, ''),
  // Vaca Torrent trocou de domínio: vacatorrentmov.com redireciona para
  // vaqueirofilmes.com (mesmo tema WP, marca "VACA TT"), e o domínio antigo
  // ainda responde "Acesso Bloqueado" a crawler. Os dois ficam na allowlist
  // do profile para o redirect não virar blocked_host.
  vacatorrentUrl: (process.env.VACATORRENT_URL || 'https://vaqueirofilmes.com').replace(/\/$/, ''),
  extraProtectors: list(process.env.EXTRA_ALLOWED_PROTECTORS),
});
