import http from 'node:http';

export function startHealthServer(port, getState) {
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/' || url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, ...getState() }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  server.listen(port, () => console.log(`[health] http server listening on :${port}`));
  return server;
}
