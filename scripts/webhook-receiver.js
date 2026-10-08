const http = require('http');

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      console.log('WEBHOOK RECEIVED:', req.method, req.url, body);
      res.writeHead(200);
      res.end('ok');
    });
  })
  .listen(4000, () => console.log('webhook receiver on http://localhost:4000'));