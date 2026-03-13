const { MongoClient } = require('mongodb');
require('dotenv').config();

async function check() {
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const db = client.db('xopunmart');
    const user = await db.collection('users').findOne({ email: 'shop1@gmail.com' });
    console.log("User in DB:");
    console.log("  ownerName:", user?.ownerName);
    console.log("  name:", user?.name);
    console.log("  email:", user?.email);
    console.log("  _id:", user?._id);
    console.log("  updatedAt:", user?.updatedAt);
    await client.close();
}

check().catch(console.error);
