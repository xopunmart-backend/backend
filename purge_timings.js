require('dotenv').config();
const { MongoClient } = require('mongodb');

async function run() {
    const uri = process.env.MONGO_URI;
    if (!uri) {
        console.error("No MONGO_URI string provided.");
        process.exit(1);
    }
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db('xopunmart');
        const users = db.collection('users');

        const result = await users.updateMany(
            { storeTimings: { $exists: true } },
            { $unset: { storeTimings: "" } }
        );

        console.log(`Successfully removed storeTimings from ${result.modifiedCount} vendors.`);
    } catch (e) {
        console.error(e);
    } finally {
        await client.close();
    }
}

run();
