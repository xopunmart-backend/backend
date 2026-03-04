const https = require('https');
const fs = require('fs');

https.get('https://xopunmart.onrender.com/api/products', (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        try {
            const products = JSON.parse(data);
            const onion = products.find(p => p.name.includes('Onion')) || products[0];
            console.log('Product vendorId is:', onion.vendorId);
            console.log('Vendor object was:', onion.vendor);
            console.log(JSON.stringify(onion, null, 2));
        } catch (e) { }
    });
});
