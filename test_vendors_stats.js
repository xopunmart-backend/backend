const { MongoClient } = require('mongodb');
const admin = require('./firebase');
require('dotenv').config();

async function testStats() {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/xopunmart';
    const client = new MongoClient(mongoUri);

    try {
        await client.connect();
        const db = client.db();
        console.log("Connected to MongoDB");

        const query = { role: 'vendor' };
        const vendors = await db.collection('users')
            .find(query)
            .project({ password: 0 })
            .toArray();
        
        console.log(`Found ${vendors.length} vendors`);

        const ordersSnapshot = await admin.firestore().collection('orders').get();
        console.log(`Fetched ${ordersSnapshot.size} orders from Firestore`);
        
        const vendorStats = {};
        ordersSnapshot.forEach(doc => {
            const data = doc.data();
            const vId = data.vendorId;
            if (vId) {
                if (!vendorStats[vId]) {
                    vendorStats[vId] = { totalSales: 0, totalOrders: 0 };
                }
                vendorStats[vId].totalOrders++;
                if (data.status !== 'cancelled') {
                    vendorStats[vId].totalSales += (data.totalAmount || 0);
                }
            }
        });

        console.log("Vendor Stats Map:", JSON.stringify(vendorStats, null, 2));

        const vendorsWithStats = vendors.map(v => {
            const stats = vendorStats[v._id.toString()] || { totalSales: 0, totalOrders: 0 };
            return {
                name: v.name,
                id: v._id.toString(),
                totalSales: stats.totalSales,
                totalOrders: stats.totalOrders
            };
        });

        console.log("Vendors with Stats (Sample):", JSON.stringify(vendorsWithStats.slice(0, 5), null, 2));

    } catch (error) {
        console.error("Error:", error);
    } finally {
        await client.close();
        process.exit();
    }
}

testStats();
