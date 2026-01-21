require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const admin = require('../firebase');

const uri = process.env.MONGO_URI;

if (!uri) {
    console.error("Please set MONGO_URI in .env");
    process.exit(1);
}

async function syncData() {
    const client = new MongoClient(uri);

    try {
        await client.connect();
        console.log("Connected to MongoDB for Sync...");

        const db = client.db('xopunmart');
        const usersCollection = db.collection('users');
        const ordersCollection = db.collection('orders');

        // 1. Sync Users
        console.log("--- Syncing Users ---");
        const users = await usersCollection.find({}).toArray();
        for (const user of users) {
            // We need a Firebase UID to be the key.
            // If the user has 'firebaseUid' (from new linkage), use it.
            // If not, we cannot create a valid auth-linked doc easily without logging in.
            // BUT, for the specific Rider failing (UXAodSrxtMRKXqS7JJn4Qsiomyq1), 
            // we might check if 'firebaseUid' is saved in Mongo.

            let uid = user.firebaseUid;
            // Fallback: IF we don't have firebaseUid, we can't sync effectively for Auth rules 
            // UNLESS we use the MongoID as the key, but the Auth UID is what matters.

            if (!uid) {
                // Skip users without linked Firebase UID for now, 
                // OR if you know the mapping manually (unlikely).
                // However, for testing, if we see 'firebaseUid' field, we use it.
                console.log(`Skipping user ${user.name} (${user._id}) - No Firebase UID linked.`);
                continue;
            }

            const userDoc = {
                _id: user._id.toString(), // Keep Mongo ID ref
                role: user.role,
                email: user.email,
                name: user.name,
                isOnline: user.isOnline || false,
                liveLocation: user.liveLocation ? {
                    latitude: user.liveLocation.latitude,
                    longitude: user.liveLocation.longitude
                } : null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };

            try {
                await admin.firestore().collection('users').doc(uid).set(userDoc, { merge: true });
                console.log(`Synced User: ${user.name} (${uid})`);
            } catch (e) {
                console.error(`Failed to sync user ${uid}:`, e);
            }
        }

        // 2. Sync Active/Pending Orders
        console.log("--- Syncing Orders ---");
        const orders = await ordersCollection.find({
            status: { $in: ['pending', 'requesting_rider', 'accepted', 'picked_up', 'on_delivery'] }
        }).toArray();

        for (const order of orders) {
            const firestoreOrder = {
                _id: order._id.toString(),
                vendorId: order.vendorId.toString(),
                userId: order.userId.toString(),
                riderId: order.riderId ? order.riderId.toString() : null,
                visibleToRiderId: order.visibleToRiderId ? order.visibleToRiderId.toString() : null,
                status: order.status,
                totalAmount: order.totalAmount,
                items: order.items,
                address: order.address,
                vendorLocation: order.vendorLocation ? {
                    latitude: order.vendorLocation.latitude,
                    longitude: order.vendorLocation.longitude
                } : null,
                createdAt: admin.firestore.Timestamp.fromDate(order.createdAt),
                updatedAt: admin.firestore.Timestamp.fromDate(order.updatedAt || new Date()),
                rejectedByRiders: order.rejectedByRiders ? order.rejectedByRiders.map(id => id.toString()) : []
            };

            try {
                await admin.firestore().collection('orders').doc(order._id.toString()).set(firestoreOrder, { merge: true });
                console.log(`Synced Order: ${order._id}`);
            } catch (e) {
                console.error(`Failed to sync order ${order._id}:`, e);
            }
        }

        console.log("Sync Complete.");

    } catch (error) {
        console.error("Sync Error:", error);
    } finally {
        await client.close();
    }
}

syncData();
