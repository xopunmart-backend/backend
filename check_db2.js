require('dotenv').config();
const { MongoClient } = require('mongodb');
const fs = require('fs');

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("No MONGO_URI");
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('xopunmart');
    const products = await db.collection('products').find({}).sort({_id:-1}).limit(5).toArray();
    fs.writeFileSync('output3.json', JSON.stringify(products, null, 2));
  } finally {
    await client.close();
  }
}

run().catch(console.dir);
