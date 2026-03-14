require('dotenv').config();
const { MongoClient } = require('mongodb');

async function run() {
  const uri = process.env.MONGO_URI;
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('xopunmart');
    const p = await db.collection('products').findOne({ vendorId: "69744421de0b5b0403ccccb0" });
    const p2 = await db.collection('products').findOne({ vendorId: new require('mongodb').ObjectId("69744421de0b5b0403ccccb0") });
    console.log("String match:", p ? "Found" : "Not Found");
    console.log("ObjectId match:", p2 ? "Found" : "Not Found");
  } finally {
    await client.close();
  }
}

run().catch(console.dir);
