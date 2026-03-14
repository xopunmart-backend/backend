require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');

async function run() {
  const uri = process.env.MONGO_URI;
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('xopunmart');
    const p = await db.collection('products').findOne({ vendorId: "69744421de0b5b0403ccccb0" });
    const p2 = await db.collection('products').findOne({ vendorId: new ObjectId("69744421de0b5b0403ccccb0") });
    fs.writeFileSync('type_res2.txt', "String match: " + (p ? "Found" : "Not Found") + "\nObjectId match: " + (p2 ? "Found" : "Not Found"));
  } catch (error) {
    fs.writeFileSync('type_res2.txt', error.toString());
  } finally {
    await client.close();
  }
}

run();
