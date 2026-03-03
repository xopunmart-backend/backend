const http = require('http');

http.get('http://localhost:3000/products?category=' + encodeURIComponent('Snacks & Namkeen') + '&approvalStatus=approved', (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
        const products = JSON.parse(data);
        console.log(JSON.stringify(products.map(p => ({ name: p.name, category: p.category })), null, 2));
    });
}).on('error', (err) => console.error(err));
