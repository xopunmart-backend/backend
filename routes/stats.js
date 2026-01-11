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
        const totalOrders = await db.collection('orders').countDocuments({}); // Total Orders

        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const todayOrders = await db.collection('orders').countDocuments({ createdAt: { $gte: startOfDay } }); // Today's Orders

        const activeDeliveries = await db.collection('orders').countDocuments({ status: { $in: ['accepted', 'out_for_delivery'] } }); // Active Deliveries

        const onlineRiders = await db.collection('users').countDocuments({ role: 'rider', status: 'online' }); // Online Riders

        // Total Revenue
        // Sum of 'total' field in 'orders' collection.
        // Assuming 'total' is a number. If it's a string, this aggregation might need parsing, 
        // but robust design suggests storing money as numbers/decimals.
        const revenueResult = await db.collection('orders').aggregate([
            {
                $group: {
                    _id: null,
                    totalRevenue: { $sum: "$totalAmount" }
                }
            }
        ]).toArray();

        const totalRevenue = revenueResult.length > 0 ? revenueResult[0].totalRevenue : 0;


        // 4. Recent Activity
        // Fetch last 5 orders
        const recentOrders = await db.collection('orders').find({})
            .sort({ createdAt: -1 })
            .limit(5)
            .project({ _id: 1, totalAmount: 1, userId: 1, createdAt: 1 }) // minimized fields
            .toArray();

        // Fetch last 5 users
        const recentUsers = await db.collection('users').find({})
            .sort({ createdAt: -1 })
            .limit(5)
            .project({ _id: 1, name: 1, role: 1, createdAt: 1 })
            .toArray();

        // Combine and Format
        let activities = [];

        recentOrders.forEach(order => {
            activities.push({
                type: 'order',
                message: `New Order: $${order.totalAmount}`,
                time: order.createdAt
            });
        });

        recentUsers.forEach(user => {
            activities.push({
                type: 'user',
                message: `New ${user.role}: ${user.name}`,
                time: user.createdAt
            });
        });

        // Sort by time descending
        activities.sort((a, b) => new Date(b.time) - new Date(a.time));

        // Take top 10
        const recentActivity = activities.slice(0, 10);

        // 5. Order Status Counts (All time for now, or adhere to a filter if implemented later)
        const orderCounts = {
            pending: await db.collection('orders').countDocuments({ status: 'pending' }),
            accepted: await db.collection('orders').countDocuments({ status: 'accepted' }),
            out_for_delivery: await db.collection('orders').countDocuments({ status: 'out_for_delivery' }),
            delivered: await db.collection('orders').countDocuments({ status: 'delivered' }),
            cancelled: await db.collection('orders').countDocuments({ status: 'cancelled' })
        };

        // 6. Latest 10 Orders with Customer Name
        const latestOrders = await db.collection('orders').aggregate([
            { $sort: { createdAt: -1 } },
            { $limit: 10 },
            {
                $lookup: {
                    from: 'users',
                    localField: 'userId',
                    foreignField: '_id',
                    as: 'customer'
                }
            },
            {
                $project: {
                    _id: 1,
                    totalAmount: 1,
                    status: 1,
                    createdAt: 1,
                    customerName: { $arrayElemAt: ["$customer.name", 0] }
                }
            }
        ]).toArray();


        // 7. Revenue Chart Data (Last 7 Days)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        sevenDaysAgo.setHours(0, 0, 0, 0);

        const dailyRevenue = await db.collection('orders').aggregate([
            {
                $match: {
                    createdAt: { $gte: sevenDaysAgo },
                    status: { $in: ['delivered', 'accepted', 'out_for_delivery', 'pending'] } // broad inclusion for revenue view
                }
            },
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                    total: { $sum: "$totalAmount" }
                }
            },
            { $sort: { _id: 1 } }
        ]).toArray();

        // 8. Revenue Breakdown (COD/Online)
        // Assuming paymentMethod field 'cod' vs others
        const revenueBreakdownRaw = await db.collection('orders').aggregate([
            { $match: { status: { $ne: 'cancelled' } } },
            {
                $group: {
                    _id: "$paymentMethod",
                    total: { $sum: "$totalAmount" }
                }
            }
        ]).toArray();

        // Normalize IDs to lower case for check if possible, matching 'cod'
        let codTotal = 0;
        let onlineTotal = 0;
        revenueBreakdownRaw.forEach(item => {
            const method = (item._id || 'online').toString().toLowerCase(); // default to online if missing
            if (method === 'cod') {
                codTotal += item.total;
            } else {
                onlineTotal += item.total;
            }
        });
        const revenueBreakdown = { cod: codTotal, online: onlineTotal };


        // 9. Cancelled Order Loss
        const cancelledResult = await db.collection('orders').aggregate([
            { $match: { status: 'cancelled' } },
            { $group: { _id: null, total: { $sum: "$totalAmount" } } }
        ]).toArray();
        const cancelledLoss = cancelledResult.length > 0 ? cancelledResult[0].total : 0;

        // 10. Timeframe Revenue
        const startOfWeek = new Date();
        startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay()); // Sunday
        startOfWeek.setHours(0, 0, 0, 0);

        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);

        const timeframeRevenueRaw = await db.collection('orders').aggregate([
            {
                $facet: {
                    today: [
                        { $match: { createdAt: { $gte: startOfDay }, status: { $ne: 'cancelled' } } },
                        { $group: { _id: null, total: { $sum: "$totalAmount" } } }
                    ],
                    week: [
                        { $match: { createdAt: { $gte: startOfWeek }, status: { $ne: 'cancelled' } } },
                        { $group: { _id: null, total: { $sum: "$totalAmount" } } }
                    ],
                    month: [
                        { $match: { createdAt: { $gte: startOfMonth }, status: { $ne: 'cancelled' } } },
                        { $group: { _id: null, total: { $sum: "$totalAmount" } } }
                    ]
                }
            }
        ]).toArray();

        const timeframeRevenue = {
            today: timeframeRevenueRaw[0].today[0]?.total || 0,
            week: timeframeRevenueRaw[0].week[0]?.total || 0,
            month: timeframeRevenueRaw[0].month[0]?.total || 0
        };

        // 11. Rider Stats
        // Busy Riders: Riders with active orders
        const busyRidersList = await db.collection('orders').distinct('riderId', {
            status: { $in: ['accepted', 'out_for_delivery'] },
            riderId: { $ne: null }
        });
        const busyRiders = busyRidersList.length;

        // Orders waiting for rider (Accepted by vendor but no rider assigned)
        const waitingForRider = await db.collection('orders').countDocuments({
            status: 'accepted',
            riderId: null
        });

        // Delayed Deliveries (Out for delivery > 45 mins)
        const fortyFiveMinsAgo = new Date(Date.now() - 45 * 60 * 1000);
        const delayedDeliveries = await db.collection('orders').countDocuments({
            status: 'out_for_delivery',
            updatedAt: { $lt: fortyFiveMinsAgo } // Assuming updatedAt is set when status changes
        });

        // Today Completed
        const todayCompleted = await db.collection('orders').countDocuments({
            status: 'delivered',
            updatedAt: { $gte: startOfDay } // better to use updatedAt for completion time
        });

        const riderStats = {
            onlineRiders, // reused from above
            busyRiders,
            waitingForRider,
            delayedDeliveries,
            todayCompleted
        };

        // 12. Vendor Stats
        // Top 5 Vendors by Revenue
        const topVendors = await db.collection('orders').aggregate([
            { $match: { status: { $ne: 'cancelled' } } },
            {
                $group: {
                    _id: "$vendorId",
                    totalRevenue: { $sum: "$totalAmount" },
                    orderCount: { $sum: 1 }
                }
            },
            { $sort: { totalRevenue: -1 } },
            { $limit: 5 },
            {
                $lookup: {
                    from: 'users',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'vendor'
                }
            },
            { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    _id: 1,
                    name: { $ifNull: ["$vendor.name", "Unknown Vendor"] },
                    totalRevenue: 1,
                    orderCount: 1
                }
            }
        ]).toArray();

        // Vendor Status Counts
        const totalVendorsCount = await db.collection('users').countDocuments({ role: 'vendor' });
        // Assuming 'isActive' defaults to true if missing, or we check recent login? 
        // Let's just use a simple query for now.
        const activeVendorsReal = await db.collection('users').countDocuments({ role: 'vendor', isActive: { $ne: false } });

        // Pending Payouts (Mock logic based on wallet balance > 500)
        const pendingPayoutVendors = await db.collection('users').countDocuments({ role: 'vendor', walletBalance: { $gt: 500 } });

        // 13. Geo-tagged Activities
        const geoActivities = [];

        // Fetch recent orders with location
        const geoOrders = await db.collection('orders')
            .find({ "address": { $exists: true } })
            .sort({ createdAt: -1 })
            .limit(50)
            .toArray();

        geoOrders.forEach(order => {
            if (order.address && (order.address.latitude || order.address.lat)) {
                geoActivities.push({
                    type: 'order',
                    role: 'customer', // Initiator
                    position: {
                        latitude: order.address.latitude || order.address.lat,
                        longitude: order.address.longitude || order.address.lng
                    },
                    title: `Order #${order._id.toString().slice(-4)}`,
                    subtitle: order.address.city || 'Customer Location',
                    description: `Total: ${order.totalAmount}`,
                    timestamp: order.createdAt,
                    source: 'App'
                });
            }
        });

        // Fetch recent users with location (if available)
        // Assuming users have 'location' or 'address' field
        const geoUsers = await db.collection('users')
            .find({ "address": { $exists: true } })
            .sort({ createdAt: -1 })
            .limit(20)
            .toArray();

        geoUsers.forEach(user => {
            if (user.address && (user.address.latitude || user.address.lat)) {
                geoActivities.push({
                    type: 'signup',
                    role: user.role || 'customer',
                    position: {
                        latitude: user.address.latitude || user.address.lat,
                        longitude: user.address.longitude || user.address.lng
                    },
                    title: `New ${user.role}`,
                    subtitle: user.address.city || 'User Location',
                    description: user.name,
                    timestamp: user.createdAt,
                    source: 'Web'
                });
            }
        });

        // Sort combined activities
        geoActivities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        res.json({
            totalRevenue,
            activeVendors,
            activeCustomers,
            pendingOrders,
            totalOrders,
            todayOrders,
            activeDeliveries,
            onlineRiders,
            orderCounts,
            latestOrders,
            dailyRevenue,
            revenueBreakdown,
            cancelledLoss,
            timeframeRevenue,
            riderStats,
            vendorStats,
            recentActivity: geoActivities // Replacing text-only activity with rich geo object
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
                    total: { $sum: "$totalAmount" }
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
