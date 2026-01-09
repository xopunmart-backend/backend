const { MongoClient } = require('mongodb');

const url = 'mongodb://127.0.0.1:27017';
const client = new MongoClient(url);
const dbName = 'xopunmart';

async function main() {
    try {
        await client.connect();
        console.log('Connected.');
        const db = client.db(dbName);
        const users = await db.collection('users').find({}).project({ name: 1, email: 1, role: 1 }).toArray();

        console.log('--- ALL USERS ---');
        users.forEach(u => console.log(`${u.name} (${u.email}): ${u.role}`));
        console.log('-----------------');

    } catch (e) {
        console.error(e);
    } finally {
        await client.close();
    }
}

main();
