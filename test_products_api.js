const https = require('https');

https.get('https://xopunmart.onrender.com/api/products?vendorId=69744421de0b5b0403ccccb0&skipTimingFilter=true', (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const products = JSON.parse(data);
      console.log('Total products:', products.length);
      if (products.length > 0) {
        console.log('First product:', products[0].name, products[0].approvalStatus);
      }
    } catch (e) {
      console.log('Raw response (first 300 chars):', data.substring(0, 300));
    }
  });
}).on('error', (err) => {
  console.log('Error: ', err.message);
});
