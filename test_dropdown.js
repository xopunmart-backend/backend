const http = require('http');

http.get('http://localhost:3000/products', (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        try {
            const products = JSON.parse(data);
            console.log('Sample product:', products.find(p => p.name === 'Onion') || products[0]);
        } catch (e) { console.error('Error parsing products:', e.message); }
    });
}).on('error', (e) => {
    console.error(e);
});

http.get('http://localhost:3000/vendors', (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        try {
            const vendors = JSON.parse(data);
            console.log('Sample vendor:', vendors[0]);
        } catch (e) { console.error('Error parsing vendors:', e.message); }
    });
}).on('error', (e) => {
    console.error(e);
});
