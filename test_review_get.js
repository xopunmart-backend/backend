const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/reviews?productId=65d49cdbc49c95ac1c618b76',
  method: 'GET',
};

const req = http.request(options, (res) => {
  let body = '';
  console.log('STATUS: ' + res.statusCode);
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => console.log('BODY: ' + body));
});

req.on('error', (e) => console.error('problem with request: ' + e.message));
req.end();
