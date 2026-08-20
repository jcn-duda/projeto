// O warmup só pode ocupar Jackett antes de haver tráfego real. Uma marca sem
// timer é suficiente: o processo reinicia para iniciar um novo ciclo de boot.
let userTrafficAt = 0;

function noteUserRequest() {
  userTrafficAt = Date.now();
}

function hasUserTraffic() {
  return userTrafficAt > 0;
}

export { noteUserRequest, hasUserTraffic };
