require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const axios = require('axios');

const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/xopunmart';
const client = new MongoClient(uri);

const API_URL = 'http://localhost:3000/api';

async function run() {
    try {
        await client.connect();
        const db = client.db('xopunmart');
        console.log("Connected to DB");

        // 1. Create/Update Test Rider 1
        const rider1Id = new ObjectId();
        await db.collection('users').updateOne(
            { _id: rider1Id },
            {
                $set: {
                    name: "Test Rider 1",
                    role: "rider",
                    isOnline: true,
                    isAvailable: true,
                    liveLocation: { latitude: 28.6139, longitude: 77.2090 }, // New Delhi
                    // fcmToken: "test_token_1" // No longer stored in Mongo
                }
            },
            { upsert: true }
        );
        console.log("Created Test Rider 1:", rider1Id.toString());

        // 2. Create/Update Test Rider 2 (Further away)
        const rider2Id = new ObjectId();
        await db.collection('users').updateOne(
            { _id: rider2Id },
            {
                $set: {
                    name: "Test Rider 2",
                    role: "rider",
                    isOnline: true,
                    isAvailable: true,
                    liveLocation: { latitude: 28.6200, longitude: 77.2100 }, // Slightly further
                    // fcmToken: "test_token_2" // No longer stored in Mongo
                }
            },
            { upsert: true }
        );
        console.log("Created Test Rider 2:", rider2Id.toString());

        // 3. Create Order via API
        // Need a valid user ID and product with vendor
        // Let's seed a dummy user and product/vendor first to be safe
        const userId = new ObjectId();
        const vendorId = new ObjectId();
        const productId = new ObjectId();

        await db.collection('users').updateOne({ _id: userId }, { $set: { name: 'Test User' } }, { upsert: true });
        await db.collection('users').updateOne(
            { _id: vendorId },
            { $set: { name: 'Test Vendor', liveLocation: { latitude: 28.6138, longitude: 77.2089 } } }, // Very close to Rider 1
            { upsert: true }
        );
        await db.collection('products').updateOne(
            { _id: productId },
            { $set: { name: 'Test Product', price: 100, vendorId: vendorId } },
            { upsert: true }
        );
        await db.collection('carts').updateOne(
            { userId: userId.toString() },
            { $set: { items: [{ productId: productId.toString(), quantity: 1 }] } },
            { upsert: true }
        );

        console.log("Creating Order...");
        const createRes = await axios.post(`${API_URL}/orders`, {
            userId: userId.toString(),
            address: { street: "Test Address" },
            paymentMethod: "COD",
            location: { latitude: 28.0, longitude: 77.0 }
        });

        const orderId = createRes.data.orders[0]._id;
        console.log("Order Created:", orderId);

        // 4. Wait for async assignment
        console.log("Waiting for assignment...");
        await new Promise(r => setTimeout(r, 2000));

        // 5. Check Assignment
        const order = await db.collection('orders').findOne({ _id: new ObjectId(orderId) });
        console.log("Order visibleToRiderId:", order.visibleToRiderId);

        if (order.visibleToRiderId && order.visibleToRiderId.toString() === rider1Id.toString()) {
            console.log("SUCCESS: Assigned to Rider 1 (Nearest)");
        } else {
            console.error("FAILURE: Not assigned to Rider 1. Assigned to:", order.visibleToRiderId);
        }

        // 6. Test Rejection
        console.log("Rejecting by Rider 1...");
        await axios.patch(`${API_URL}/orders/${orderId}/reject`, {
            riderId: rider1Id.toString()
        });

        console.log("Waiting for re-assignment...");
        await new Promise(r => setTimeout(r, 2000));

        const orderRe = await db.collection('orders').findOne({ _id: new ObjectId(orderId) });
        console.log("Order visibleToRiderId:", orderRe.visibleToRiderId);
        console.log("Rejected By:", orderRe.rejectedByRiders);

        if (orderRe.visibleToRiderId && orderRe.visibleToRiderId.toString() === rider2Id.toString()) {
            console.log("SUCCESS: Re-assigned to Rider 2");
        } else {
            console.error("FAILURE: Not re-assigned to Rider 2");
        }

    } catch (e) {
        console.error("Test Failed:", e.response ? e.response.data : e.message);
    } finally {
        await client.close();
    }
}

run();
