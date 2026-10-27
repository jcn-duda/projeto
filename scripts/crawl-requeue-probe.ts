import net from 'node:net';

/** Só uma recusa explícita prova que a porta está fechada. */
export function probePort(port: number, connect = (p: number) =>
  net.createConnection({ host: '127.0.0.1', port: p, timeout: 1500 })): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect(port);
    const done = (up: boolean) => { socket.destroy(); resolve(up); };
    socket.on('connect', () => done(true));
    socket.on('timeout', () => { socket.destroy(); reject(new Error('tempo esgotado')); });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
}
