const { MongoClient } = require('mongodb');
const fs = require('fs');

async function test() {
    const envFile = fs.readFileSync('.env', 'utf-8');
    let uri = '';
    envFile.split('\n').forEach(line => {
        if (line.startsWith('MONGO_URI=')) {
            uri = line.substring('MONGO_URI='.length).trim();
        }
    });

    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db();

    const product = await db.collection('products').findOne({ name: /Onion/i });
    fs.writeFileSync('output_raw_product.json', JSON.stringify(product, null, 2));

    await client.close();
}
test().catch(console.error);
