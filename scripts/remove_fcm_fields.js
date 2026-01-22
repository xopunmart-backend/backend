require('dotenv').config();
const { MongoClient } = require('mongodb');

const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/xopunmart';
const client = new MongoClient(uri);

async function run() {
    try {
        await client.connect();
        const db = client.db('xopunmart'); // Adjust DB name if needed, usually in connection string or env
        console.log("Connected to DB");

        console.log("Removing 'fcmToken' field from all users...");

        const result = await db.collection('users').updateMany(
            { fcmToken: { $exists: true } },
            { $unset: { fcmToken: "" } }
        );

        console.log(`Matched ${result.matchedCount} users.`);
        console.log(`Modified ${result.modifiedCount} users (removed fcmToken).`);

    } catch (e) {
        console.error("Migration Failed:", e);
    } finally {
        await client.close();
    }
}

run();
