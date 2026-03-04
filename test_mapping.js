const { MongoClient, ObjectId } = require('mongodb');
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
    const db = client.db('xopunmart');

    const allProducts = await db.collection('products').find().toArray();
    console.log(`Found ${allProducts.length} products`);

    const vendorIds = [...new Set(allProducts.map(p => p.vendorId).filter(id => id))];
    console.log(`Unique vendorId objects/strings:`, vendorIds);

    const stringVendorIds = [...new Set(allProducts.map(p => p.vendorId ? p.vendorId.toString() : null).filter(id => id))];
    console.log(`Stringified vendorIds:`, stringVendorIds);

    const vendors = await db.collection('users').find({ _id: { $in: vendorIds } }).toArray();
    console.log(`Found ${vendors.length} vendors with raw vendorIds array`);

    const vendorMap = {};
    vendors.forEach(v => vendorMap[v._id.toString()] = v);

    const onion = allProducts.find(p => p.name.includes('Onion'));

    if (onion && onion.vendorId) {
        console.log("Onion vendorId:", onion.vendorId, typeof onion.vendorId);
        console.log("Mapped vendor:", vendorMap[onion.vendorId.toString()] ? "YES" : "NO");
    }

    await client.close();
}
test().catch(console.error);
