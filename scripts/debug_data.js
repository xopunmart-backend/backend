require('dotenv').config();
const { MongoClient } = require('mongodb');
const admin = require('../firebase');

const uri = process.env.MONGO_URI;

async function debugData() {
    console.log("--- DEBUG DATA START ---");
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db('xopunmart');

        console.log("\n1. Checking MongoDB Users...");
        const users = await db.collection('users').find({}).toArray();
        console.log(`Found ${users.length} users in MongoDB.`);

        for (const u of users) {
            console.log(`- User: ${u.name} | Role: ${u.role} | MongoID: ${u._id} | FirebaseUID: ${u.firebaseUid || 'MISSING'}`);

            if (u.firebaseUid) {
                console.log(`  -> Checking Firestore for UID: ${u.firebaseUid}...`);
                const snap = await admin.firestore().collection('users').doc(u.firebaseUid).get();
                if (snap.exists) {
                    console.log(`     [OK] Found in Firestore. Role: ${snap.data().role}`);
                } else {
                    console.log(`     [FAIL] NOT FOUND in Firestore!`);
                }
            }
        }

    } catch (e) {
        console.error("Debug Error:", e);
    } finally {
        await client.close();
        console.log("\n--- DEBUG DATA END ---");
    }
}

debugData();
