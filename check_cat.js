const { MongoClient } = require('mongodb');

async function main() {
    const uri = "mongodb+srv://xopunmart_db:xopunmart%2678@xopunmart.yrljy48.mongodb.net/?appName=xopunmart";
    const client = new MongoClient(uri);

    try {
        await client.connect();
        const db = client.db("xopunmart");
        const category = await db.collection("categories").findOne({ name: "Snacks & Namkeen" });
        console.log(JSON.stringify(category, null, 2));
    } finally {
        await client.close();
    }
}
main().catch(console.error);
