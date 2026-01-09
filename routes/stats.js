const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');

// GET /api/stats/dashboard
router.get('/dashboard', async (req, res) => {
    try {
        const db = req.db;

        // 1. Count Active Vendors (role: 'vendor')
        // Assuming 'users' collection has 'role' field.
        // We permit 'vendor' role. Adjust if you have a status field like 'active'.
        const activeVendors = await db.collection('users').countDocuments({ role: 'vendor' });

        // 2. Count Active Customers (role: 'customer')
        const activeCustomers = await db.collection('users').countDocuments({ role: 'customer' });

        // 3. Order Stats
        // Assuming 'orders' collection
        // Pending orders could be status 'pending' or similar.
        const pendingOrders = await db.collection('orders').countDocuments({ status: 'pending' });

        // Total Revenue
        // Sum of 'total' field in 'orders' collection.
        // Assuming 'total' is a number. If it's a string, this aggregation might need parsing, 
        // but robust design suggests storing money as numbers/decimals.
        const revenueResult = await db.collection('orders').aggregate([
            {
                $group: {
                    _id: null,
                    totalRevenue: { $sum: "$total" }
                }
            }
        ]).toArray();

        const totalRevenue = revenueResult.length > 0 ? revenueResult[0].totalRevenue : 0;

        res.json({
            totalRevenue,
            activeVendors,
            activeCustomers,
            pendingOrders
        });

    } catch (error) {
        console.error("Stats error:", error);
        res.status(500).json({ message: "Server error fetching stats" });
    }
});

// GET /api/stats/vendor?vendorId=...
router.get('/vendor', async (req, res) => {
    try {
        const { vendorId } = req.query;
        if (!vendorId) {
            return res.status(400).json({ message: "Vendor ID is required" });
        }

        const db = req.db;
        const vId = new ObjectId(vendorId);

        // 1. Today's Revenue
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const revenueResult = await db.collection('orders').aggregate([
            {
                $match: {
                    vendorId: vId,
                    createdAt: { $gte: startOfDay },
                    status: { $ne: 'cancelled' }
                }
            },
            {
                $group: {
                    _id: null,
                    total: { $sum: "$total" }
                }
            }
        ]).toArray();
        const todayRevenue = revenueResult.length > 0 ? revenueResult[0].total : 0;

        // 2. Today's Orders Count
        const todayOrders = await db.collection('orders').countDocuments({
            vendorId: vId,
            createdAt: { $gte: startOfDay }
        });

        // 3. Pending Orders (Total)
        const pendingOrders = await db.collection('orders').countDocuments({
            vendorId: vId,
            status: 'pending' // or 'Placed', check case sensitivity? assuming lowercase
        });

        // 4. Products Count (Stock items)
        const productsCount = await db.collection('products').countDocuments({
            vendorId: vId
        });

        res.json({
            todayRevenue,
            todayOrders,
            pendingOrders,
            productsCount
        });

    } catch (error) {
        console.error("Vendor stats error:", error);
        res.status(500).json({ message: error.message || "Server error" });
    }
});

module.exports = router;
