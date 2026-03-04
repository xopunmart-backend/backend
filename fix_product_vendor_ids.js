const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');

async function fixVendorIds() {
    const envFile = fs.readFileSync('.env', 'utf-8');
    let uri = '';
    envFile.split('\n').forEach(line => {
        if (line.startsWith('MONGO_URI=')) {
            uri = line.substring('MONGO_URI='.length).trim();
        }
    });

    if (!uri) {
        console.error('MONGO_URI not found in .env');
        process.exit(1);
    }

    const client = new MongoClient(uri);

    try {
        await client.connect();
        const db = client.db('xopunmart');
        const collection = db.collection('products');

        // Find all products where vendorId is a string
        const products = await collection.find({ vendorId: { $type: "string" } }).toArray();
        console.log(`Found ${products.length} products with a string vendorId.`);

        let updatedCount = 0;
        for (const prod of products) {
            if (ObjectId.isValid(prod.vendorId)) {
                await collection.updateOne(
                    { _id: prod._id },
                    { $set: { vendorId: new ObjectId(prod.vendorId) } }
                );
                updatedCount++;
            } else {
                console.warn(`Invalid vendorId string for product ${prod._id}: ${prod.vendorId}`);
            }
        }

        console.log(`Successfully updated ${updatedCount} products.`);

    } finally {
        await client.close();
    }
}

fixVendorIds().catch(console.error);
