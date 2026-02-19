const admin = require('./firebase');
const { sendToUser, sendToTopic } = require('./utils/notificationSender');
const { MongoClient, ObjectId } = require('mongodb');
const dotenv = require('dotenv');

dotenv.config();

async function testNotification() {
    const uri = process.env.MONGO_URI || "mongodb://localhost:27017/xopunmart";
    const client = new MongoClient(uri);

    try {
        await client.connect();
        const db = client.db();
        console.log("Connected to MongoDB");

        // 1. Setup Test User
        const testUid = "test_user_123";
        const testEmail = "test@example.com";

        // Update/Insert Mongo User
        await db.collection('users').updateOne(
            { email: testEmail },
            {
                $set: {
                    firebaseUid: testUid,
                    name: "Test User",
                    email: testEmail,
                    role: "customer"
                }
            },
            { upsert: true }
        );

        const user = await db.collection('users').findOne({ email: testEmail });
        console.log(`Test user ready: ${user._id}`);

        // 2. Setup Firestore Token (Dummy)
        const dummyToken = "fcm_dummy_token_" + Date.now();
        await admin.firestore().collection('users').doc(testUid).set({
            fcmToken: dummyToken,
            updatedAt: new Date()
        });
        console.log(`Dummy Firestore token set for ${testUid}`);

        // 3. Send Notification
        await sendToUser(db, user._id, "Test Notification", "This is a test message from the backend script.", { type: 'system_test' });

        console.log("Test notification sent (check console for success/error from notificationSender)");

    } catch (e) {
        console.error("Test failed:", e);
    } finally {
        await client.close();
        // Force exit because firebase admin keeps process alive
        process.exit(0);
    }
}

testNotification();
