/* Adom Power-Movie - /configure: estado compartilhado entre os módulos do
 * cliente. ESM nativo servido ao browser; nada toca o DOM no import — o
 * bindElements() preenche `el` e o init() do entry só então liga os eventos.
 *
 * Mutar PROPRIEDADE deste objeto é o canal de escrita entre módulos: binding
 * importado é somente leitura em ESM, então nenhum arquivo reatribui `state`. */

export interface ConfigureState {
  el: Record<string, any>;
  services: any[];
  jackettIndexers: any[];
  indexerPriority: string[];
  instanceDefaults: any;
  // Chave cifrada que veio no link aberto (blob opaco): fica fora do campo e é
  // reaproveitada se o usuário mexer noutra opção sem colar outra chave.
  sealedKey: string;
  providerBase: string[];
  torrentioOn: boolean;
  // Token descarta resposta atrasada do selo; timer é o debounce da digitação.
  sealToken: number;
  sealTimer: number | null;
  indexerStatusPollInFlight: boolean;
}

export const state: ConfigureState = {
  el: {},
  services: [],
  jackettIndexers: [],
  indexerPriority: [],
  instanceDefaults: null,
  sealedKey: '',
  providerBase: ['jackett'],
  torrentioOn: false,
  sealToken: 0,
  sealTimer: null,
  indexerStatusPollInFlight: false,
};

/** Restaura os padrões; usado pelos testes (o import do módulo é cacheado). */
export function resetConfigureState(): void {
  state.el = {};
  state.services = [];
  state.jackettIndexers = [];
  state.indexerPriority = [];
  state.instanceDefaults = null;
  state.sealedKey = '';
  state.providerBase = ['jackett'];
  state.torrentioOn = false;
  state.sealToken = 0;
  state.sealTimer = null;
  state.indexerStatusPollInFlight = false;
}
