// Freio de atividade dos trabalhos de fundo. A marca simples (boot) é o que o
// warmup usa; a janela deslizante é o que o colhedor precisa — ele roda
// CONTINUAMENTE, então "nunca houve tráfego" não descreve mais o estado: a
// pergunta certa é "há quanto tempo ninguém usa".
let userTrafficAt = 0;

function noteUserRequest() {
  userTrafficAt = Date.now();
}

/** Marca de boot: qualquer tráfego passado corta o trabalho de uma vez. */
function hasUserTraffic() {
  return userTrafficAt > 0;
}

/** Janela deslizante: tráfego dentro dos últimos `windowMs` ms trava o ciclo. */
function recentUserTraffic(windowMs: number) {
  return userTrafficAt > 0 && Date.now() - userTrafficAt < windowMs;
}

export { noteUserRequest, hasUserTraffic, recentUserTraffic };
