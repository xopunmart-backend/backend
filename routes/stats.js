
const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const admin = require('../firebase');

// GET /api/stats/dashboard
router.get('/dashboard', async (req, res) => {
    try {
        const db = req.db;

        // 1. User Counts (MongoDB)
        const activeVendors = await db.collection('users').countDocuments({ role: 'vendor' });
        const activeCustomers = await db.collection('users').countDocuments({ role: 'customer' });
        const onlineRiders = await db.collection('users').countDocuments({ role: 'rider', isOnline: true });

        // 2. Fetch Orders from Firestore for Analytics
        // Optimization: For huge datasets, we should use distributed counters or BigQuery.
        // For MVP, fetching all non-archived orders is okay-ish, or better: fetch summary stats if we had them.
        // We will fetch ALL orders for now to ensure accuracy of "Total Revenue".
        // WARNING: This is expensive at scale.
        const ordersSnapshot = await admin.firestore().collection('orders').get();
        const orders = ordersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // 3. Process Orders in Memory
        let pendingOrders = 0;
        let activeDeliveries = 0;
        let totalRevenue = 0;
        let thisMonthRevenue = 0;
        let lastMonthRevenue = 0;
        let cancelledLoss = 0;

        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();
        const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastMonth = lastMonthDate.getMonth();

        // Helper to check date range
        const isThisMonth = (d) => d.getMonth() === currentMonth && d.getFullYear() === currentYear;
        const isLastMonth = (d) => d.getMonth() === lastMonth && (d.getFullYear() === currentYear || (currentMonth === 0 && d.getFullYear() === currentYear - 1));

        const orderCounts = {
            pending: 0,
            accepted: 0,
            out_for_delivery: 0,
            delivered: 0,
            cancelled: 0
        };

        const dailyRevenueMap = {}; // YYYY-MM-DD -> total
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        sevenDaysAgo.setHours(0, 0, 0, 0);

        orders.forEach(order => {
            const status = order.status || 'pending';
            const amount = parseFloat(order.totalAmount || 0);

            // Counts
            if (orderCounts[status] !== undefined) orderCounts[status]++;

            if (status === 'pending') pendingOrders++;
            if (['accepted', 'out_for_delivery'].includes(status)) activeDeliveries++;

            // Revenue
            if (status !== 'cancelled') {
                totalRevenue += amount;

                // Date parsing (Firestore Timestamp or JS Date string)
                let date;
                if (order.createdAt && order.createdAt.toDate) date = order.createdAt.toDate();
                else if (order.createdAt) date = new Date(order.createdAt);

                if (date) {
                    if (isThisMonth(date)) thisMonthRevenue += amount;
                    if (isLastMonth(date)) lastMonthRevenue += amount;

                    // Daily Revenue (Last 7 days)
                    if (date >= sevenDaysAgo) {
                        const dayStr = date.toISOString().split('T')[0];
                        dailyRevenueMap[dayStr] = (dailyRevenueMap[dayStr] || 0) + amount;
                    }
                }
            } else {
                cancelledLoss += amount;
            }
        });

        // 4. Trend
        let revenueTrend = 0;
        if (lastMonthRevenue === 0) {
            revenueTrend = thisMonthRevenue > 0 ? 100 : 0;
        } else {
            revenueTrend = ((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100;
        }

        // 5. Daily Revenue Array
        const dailyRevenue = Object.keys(dailyRevenueMap).sort().map(key => ({
            _id: key,
            total: dailyRevenueMap[key]
        }));

        // 6. Recent Orders (Top 10 sorted by date)
        const recentOrders = orders.sort((a, b) => { // descending
            const da = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate() : new Date(a.createdAt);
            const db = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
            return db - da;
        }).slice(0, 10);

        // 7. Recent Activity (Simplified)
        const recentActivity = recentOrders.map(o => ({
            type: 'order',
            title: `Order #${o.id.substring(0, 5)}...`,
            description: `Total: ${o.totalAmount}`,
            timestamp: o.createdAt,
            source: 'App',
            position: o.vendorLocation // Use vendor location as proxy if customer not available or mixed
        }));

        res.json({
            totalRevenue,
            totalRevenueTrend: revenueTrend,
            activeVendors,
            activeCustomers,
            pendingOrders,
            totalOrders: orders.length,
            activeDeliveries,
            onlineRiders,
            orderCounts,
            dailyRevenue,
            cancelledLoss,
            riderStats: { // Simplified
                onlineRiders,
                busyRiders: activeDeliveries // Approximation
            },
            recentActivity
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

        // Fetch Orders from Firestore for this Vendor
        const snapshot = await admin.firestore().collection('orders')
            .where('vendorId', '==', vendorId)
            .get();

        let todayRevenue = 0;
        let todayOrders = 0;
        let pendingOrders = 0;

        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        snapshot.forEach(doc => {
            const data = doc.data();
            const date = data.createdAt && data.createdAt.toDate ? data.createdAt.toDate() : new Date(data.createdAt);

            if (date >= startOfDay) {
                todayOrders++;
                if (data.status !== 'cancelled') {
                    todayRevenue += (data.totalAmount || 0);
                }
            }

            if (data.status === 'pending') {
                pendingOrders++;
            }
        });

        const productsCount = await req.db.collection('products').countDocuments({
            vendorId: new ObjectId(vendorId)
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
