const http = require('http');

const data = JSON.stringify({
  productId: '65d49cdbc49c95ac1c618b76',
  userId: '65dd743058cbca9efcd256e6',
  rating: 5,
  comment: 'Great product!'
});

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/reviews',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, (res) => {
  let body = '';
  console.log('STATUS: ' + res.statusCode);
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => console.log('BODY: ' + body));
});

req.on('error', (e) => console.error('problem with request: ' + e.message));
req.write(data);
req.end();
