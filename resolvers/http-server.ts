import http from 'node:http';

function createServer(handler: http.RequestListener): http.Server {
  return http.createServer(handler);
}

function reply(
  response: http.ServerResponse,
  status: number,
  body: string,
  type = 'text/plain; charset=utf-8',
): void {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(body);
}

export { createServer, reply };
