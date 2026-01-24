
require('dotenv').config();
const { MongoClient } = require('mongodb');

const uri = process.env.MONGO_URI;

if (!uri) {
    console.error("Error: MONGO_URI is not defined in .env file");
    process.exit(1);
}

const client = new MongoClient(uri);

async function inspectVendors() {
    try {
        await client.connect();
        console.log("Connected to MongoDB!");

        const db = client.db('xopunmart');

        const vendors = await db.collection('users').find({ role: 'vendor' }).project({ status: 1, email: 1, _id: 0 }).toArray();

        console.log("Found vendors:", vendors);

        const counts = {};
        vendors.forEach(v => {
            const s = v.status || 'UNDEFINED';
            counts[s] = (counts[s] || 0) + 1;
        });

        console.log("Status Counts:", counts);

        // Also check if there's an 'isApproved' field just in case
        const approvedCheck = await db.collection('users').findOne({ role: 'vendor', isApproved: { $exists: true } });
        if (approvedCheck) {
            console.log("Found 'isApproved' field:", approvedCheck);
        } else {
            console.log("No 'isApproved' field found on sampled vendor.");
        }

    } catch (error) {
        console.error("Error:", error);
    } finally {
        await client.close();
    }
}

inspectVendors();
