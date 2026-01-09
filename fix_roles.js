const { MongoClient } = require('mongodb');

// Connection URL
const url = 'mongodb://127.0.0.1:27017';
const client = new MongoClient(url);

// Database Name
const dbName = 'xopunmart';

async function main() {
    try {
        await client.connect();
        console.log('Connected successfully to server');
        const db = client.db(dbName);
        const collection = db.collection('users');

        // Update 'rider' and 'rider1@gmail.com' to role 'rider'
        const updateResult = await collection.updateMany(
            { email: { $regex: /rider/i } },
            { $set: { role: 'rider', status: 'Approved' } } // Also approving them for convenience
        );

        console.log('Matched ' + updateResult.matchedCount + ' documents.');
        console.log('Modified ' + updateResult.modifiedCount + ' documents.');

    } catch (e) {
        console.error(e);
    } finally {
        await client.close();
        process.exit(0);
    }
}

main();
