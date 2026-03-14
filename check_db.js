const { MongoClient } = require('mongodb');

async function run() {
  const uri = 'mongodb://127.0.0.1:27017';
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('xopunmart');
    const products = await db.collection('products').find().sort({_id:-1}).limit(5).toArray();
    console.log(JSON.stringify(products, null, 2));
  } finally {
    await client.close();
  }
}

run().catch(console.dir);
