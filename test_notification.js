const admin = require('./firebase');
const { sendToUser, sendToTopic } = require('./utils/notificationSender');
const { MongoClient, ObjectId } = require('mongodb');
const dotenv = require('dotenv');

dotenv.config();

async function testNotification() {
    const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/xopunmart";
    const client = new MongoClient(uri);

    try {
        await client.connect();
        const db = client.db();
        console.log("Connected to MongoDB");

        // 1. Find a user with a firebaseUid (simulate finding a real user)
        // You might need to adjust this query to find YOUR specific user if you know the email
        const user = await db.collection('users').findOne({ firebaseUid: { $exists: true } });

        if (!user) {
            console.log("No user found with firebaseUid to test.");
            return;
        }

        console.log(`Found user: ${user.email} (${user._id})`);

        // 2. Send Notification
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
