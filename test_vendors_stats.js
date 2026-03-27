const { MongoClient } = require('mongodb');
const admin = require('./firebase');
require('dotenv').config();

async function testStats() {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/xopunmart';
    const client = new MongoClient(mongoUri);

    try {
        await client.connect();
        const db = client.db('xopunmart');
        console.log("Connected to MongoDB (xopunmart)");

        const query = { role: 'vendor' };
        const vendors = await db.collection('users')
            .find(query)
            .project({ password: 0 })
            .toArray();
        
        console.log(`Found ${vendors.length} vendors`);
        if (vendors.length > 0) {
            console.log(`Sample Vendor ID: ${vendors[0]._id.toString()} (Type: ${typeof vendors[0]._id.toString()})`);
        }

        const ordersSnapshot = await admin.firestore().collection('orders').limit(100).get();
        console.log(`Fetched ${ordersSnapshot.size} orders from Firestore`);
        
        const vendorStats = {};
        ordersSnapshot.forEach(doc => {
            const data = doc.data();
            const vId = data.vendorId;
            if (vId) {
                // Log the first order's vendorId type
                if (Object.keys(vendorStats).length === 0) {
                    console.log(`Sample Firestore vendorId: ${vId} (Type: ${typeof vId})`);
                }

                if (!vendorStats[vId]) {
                    vendorStats[vId] = { totalSales: 0, totalOrders: 0 };
                }
                vendorStats[vId].totalOrders++;
                if (data.status !== 'cancelled') {
                    vendorStats[vId].totalSales += (data.totalAmount || 0);
                }
            }
        });

        console.log("Vendor Stats Keys:", Object.keys(vendorStats));

        const vendorsWithStats = vendors.map(v => {
            const vidStr = v._id.toString();
            const stats = vendorStats[vidStr] || { totalSales: 0, totalOrders: 0 };
            return {
                name: v.name,
                id: vidStr,
                totalSales: stats.totalSales,
                totalOrders: stats.totalOrders
            };
        });

        const activeVendors = vendorsWithStats.filter(v => v.totalOrders > 0);
        console.log(`Found ${activeVendors.length} vendors with non-zero orders.`);
        console.log("Active Vendors:", JSON.stringify(activeVendors, null, 2));

    } catch (error) {
        console.error("Error:", error);
    } finally {
        await client.close();
        process.exit();
    }
}

testStats();
