const { MongoClient, ObjectId } = require('mongodb');
const { sendToUser } = require('./utils/notificationSender');
const dotenv = require('dotenv');

dotenv.config();

async function sendTest() {
    const uri = process.env.MONGO_URI || "mongodb://localhost:27017/xopunmart";
    const client = new MongoClient(uri);

    try {
        await client.connect();
        const db = client.db();

        let userIdStr = "69748c94f5c53583699970c5"; // The user logged in on flutter app

        console.log(`Sending to user ID: ${userIdStr}`);
        await sendToUser(
            db,
            new ObjectId(userIdStr),
            "Test Real Notification",
            "This is a live test notification from our new script!",
            { type: 'order' }
        );
        console.log("Success!");
    } catch (e) {
        console.error(e);
    } finally {
        await client.close();
        process.exit(0);
    }
}

sendTest();
