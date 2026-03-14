const https = require('https');

https.get('https://xopunmart.onrender.com/api/products?vendorId=69744421de0b5b0403ccccb0', (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const products = JSON.parse(data);
      console.log('Total products:', products.length);
      console.log(JSON.stringify(products.slice(0, 3), null, 2));
    } catch (e) {
      console.log('Error parsing:', e);
      console.log('Raw data:', data);
    }
  });
}).on('error', (err) => {
  console.log('Error: ', err.message);
});
