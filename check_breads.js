const { MongoClient } = require('mongodb');

async function main() {
    const uri = "mongodb+srv://xopunmart_db:xopunmart%2678@xopunmart.yrljy48.mongodb.net/?appName=xopunmart";
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db("xopunmart");
        const breads = await db.collection("products").find({ name: { $regex: /Bread/i } }).project({ name: 1, category: 1 }).toArray();
        console.log(JSON.stringify(breads, null, 2));

    } finally {
        await client.close();
    }
}
main().catch(console.error);
