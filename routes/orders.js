const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const admin = require('../firebase');
const { calculateDistance } = require('../utils/geo');

// Helper: Find and assign nearest rider
async function assignOrderToNearestRider(db, orderId, vendorLocation, excludedRiderIds = []) {
    try {
        console.log(`Finding rider for order ${orderId} near`, vendorLocation);

        // 1. Find all online and available riders
        const riders = await db.collection('users').find({
            role: 'rider',
            isOnline: true,
            isAvailable: true,
            _id: { $nin: excludedRiderIds.map(id => new ObjectId(id)) }
        }).toArray();

        // 2. Filter riders with valid location
        const validRiders = riders.filter(r => r.liveLocation && r.liveLocation.latitude && r.liveLocation.longitude);

        if (validRiders.length === 0) {
            console.log("No available riders found.");
            // Reset visibleToRiderId if previously set, or keep null
            await db.collection('orders').updateOne(
                { _id: new ObjectId(orderId) },
                {
                    $set: {
                        visibleToRiderId: null,
                        status: 'pending', // Revert to pending
                        assignmentStatus: 'no_riders_available',
                        updatedAt: new Date()
                    }
                }
            );
            return null;
        }

        // 3. Calculate distances
        const ridersWithDistance = validRiders.map(rider => ({
            ...rider,
            distance: calculateDistance(vendorLocation, rider.liveLocation)
        }));

        // 4. Sort by distance
        ridersWithDistance.sort((a, b) => a.distance - b.distance);
        const nearestRider = ridersWithDistance[0];

        // 5. Assign
        await db.collection('orders').updateOne(
            { _id: new ObjectId(orderId) },
            {
                $set: {
                    visibleToRiderId: nearestRider._id,
                    status: 'requesting_rider',
                    assignmentStatus: 'assigned',
                    updatedAt: new Date()
                }
            }
        );

        console.log(`Assigned order ${orderId} to rider ${nearestRider._id} (${nearestRider.name}) at ${nearestRider.distance}m`);

        // TODO: Send FCM notification to rider
        return nearestRider;

    } catch (error) {
        console.error("Assignment Error:", error);
    }
}

// POST /api/orders - Create new order(s) from cart
router.post('/', async (req, res) => {
    try {
        const { userId, address, paymentMethod, location } = req.body;

        if (!userId || !address) {
            return res.status(400).json({ message: "User ID and address are required" });
        }

        // 1. Get User's Cart
        const cart = await req.db.collection('carts').findOne({ userId });
        if (!cart || !cart.items || cart.items.length === 0) {
            return res.status(400).json({ message: "Cart is empty" });
        }

        // 2. Enrich items with details (price, vendorId) to ensure accuracy
        const itemsWithDetails = [];
        const vendorOrders = {}; // Map<vendorId, { items: [], total: 0 }>

        for (const item of cart.items) {
            const product = await req.db.collection('products').findOne({ _id: new ObjectId(item.productId) });
            if (!product) continue; // Skip if product deleted

            const lineItem = {
                productId: item.productId,
                name: product.name,
                price: parseFloat(product.price),
                quantity: item.quantity,
                image: product.image,
                unit: product.unit,
                vendorId: product.vendorId // Assuming product has vendorId stored as ObjectId or string
            };

            const vId = product.vendorId.toString();

            if (!vendorOrders[vId]) {
                const vendorUser = await req.db.collection('users').findOne({ _id: product.vendorId });
                vendorOrders[vId] = {
                    vendorId: product.vendorId, // Keep original type
                    userId,
                    items: [],
                    totalAmount: 0,
                    status: 'pending', // pending, preparing, ready, picked, completed, cancelled
                    paymentMethod: paymentMethod || 'COD',
                    address,
                    location, // Customer lat/lng coordinates
                    vendorLocation: vendorUser ? vendorUser.liveLocation : null, // Store vendor location for assignment
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    visibleToRiderId: null, // Initially null
                    rejectedByRiders: [] // Track rejections
                };
            }

            vendorOrders[vId].items.push(lineItem);
            vendorOrders[vId].totalAmount += (lineItem.price * lineItem.quantity);
        }

        if (Object.keys(vendorOrders).length === 0) {
            return res.status(400).json({ message: "No valid products found in cart" });
        }

        // 3. Create Orders
        const createdOrders = [];
        const orderCollection = req.db.collection('orders');

        for (const vId in vendorOrders) {
            const orderData = vendorOrders[vId];
            // Format total to 2 decimals
            orderData.totalAmount = parseFloat(orderData.totalAmount.toFixed(2));

            const result = await orderCollection.insertOne(orderData);
            createdOrders.push({ ...orderData, _id: result.insertedId });

            // Trigger Smart Assignment
            if (orderData.vendorLocation) {
                // Run asynchronously to not block response
                assignOrderToNearestRider(req.db, result.insertedId, orderData.vendorLocation);
            }

            // Create Notification for Vendor
            try {
                const notificationData = {
                    userId: new ObjectId(vId),
                    title: 'New Order Received',
                    message: `You have received a new order of ₹${orderData.totalAmount}`,
                    type: 'order',
                    isRead: false,
                    createdAt: new Date()
                };

                await req.db.collection('notifications').insertOne(notificationData);

                // START: Send Push Notification
                const vendorUser = await req.db.collection('users').findOne({ _id: new ObjectId(vId) });
                if (vendorUser && vendorUser.fcmToken) {
                    const messagePayload = {
                        notification: {
                            title: notificationData.title,
                            body: notificationData.message
                        },
                        data: {
                            type: 'order',
                            orderId: result.insertedId.toString()
                        },
                        token: vendorUser.fcmToken
                    };

                    try {
                        await admin.messaging().send(messagePayload);
                        console.log(`Push notification sent to vendor ${vId}`);
                    } catch (fcmError) {
                        console.error(`Error sending push to vendor ${vId}:`, fcmError);
                    }
                }
                // END: Send Push Notification

            } catch (notifError) {
                console.error("Failed to create notification:", notifError);
                // Don't fail the order if notification fails
            }
        }

        // 4. Clear Cart
        await req.db.collection('carts').updateOne(
            { userId },
            { $set: { items: [], updatedAt: new Date() } }
        );

        res.status(201).json({
            message: "Order placed successfully",
            orders: createdOrders
        });

    } catch (error) {
        console.error("Create Order Error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// GET /api/orders?vendorId=...
router.get('/', async (req, res) => {
    try {
        const { vendorId } = req.query;

        const query = {};
        if (vendorId) {
            query.vendorId = new ObjectId(vendorId);
        }

        // Sort by newest first
        // Sort by newest first
        const pipeline = [
            { $match: query },
            { $sort: { createdAt: -1 } },
            {
                $lookup: {
                    from: 'users',
                    localField: 'userId',
                    foreignField: '_id',
                    as: 'customer'
                }
            },
            {
                $unwind: {
                    path: '$customer',
                    preserveNullAndEmptyArrays: true
                }
            },
            {
                $addFields: {
                    customerName: '$customer.name',
                    customerImage: '$customer.profileImage'
                }
            },
            {
                $project: {
                    customer: 0 // Remove the full customer object to save bandwidth
                }
            }
        ];

        const orders = await req.db.collection('orders').aggregate(pipeline).toArray();

        res.json(orders);
    } catch (error) {
        console.error("Get orders error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// GET /api/orders/user/:userId
router.get('/user/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        const orders = await req.db.collection('orders')
            .find({ userId: userId }) // userId is stored as string in create order
            .sort({ createdAt: -1 })
            .toArray();

        res.json(orders);
    } catch (error) {
        console.error("Get user orders error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// GET /api/orders/recent?vendorId=...
router.get('/recent', async (req, res) => {
    try {
        const { vendorId } = req.query;
        if (!vendorId) {
            return res.status(400).json({ message: "Vendor ID is required" });
        }

        const orders = await req.db.collection('orders')
            .find({ vendorId: new ObjectId(vendorId) })
            .sort({ createdAt: -1 })
            .limit(5)
            .toArray();

        res.json(orders);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});



// PATCH /api/orders/:id/status
router.patch('/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!status) {
            return res.status(400).json({ message: "Status is required" });
        }

        const result = await req.db.collection('orders').updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: status, updatedAt: new Date() } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ message: "Order not found" });
        }

        // START: Credit Wallet on Completion
        if (status === 'completed') {
            const order = await req.db.collection('orders').findOne({ _id: new ObjectId(id) });
            if (order && order.paymentMethod !== 'COD_UNPAID') {
                // Platform Commission Logic (10%)
                const commissionRate = 0.10;
                const commissionAmount = order.totalAmount * commissionRate;
                const netAmount = order.totalAmount - commissionAmount;

                await req.db.collection('users').updateOne(
                    { _id: order.vendorId },
                    { $inc: { walletBalance: netAmount } }
                );

                await req.db.collection('transactions').insertOne({
                    userId: order.vendorId,
                    type: 'credit',
                    amount: netAmount,
                    commission: commissionAmount,
                    description: `Order Payment #${id.substring(id.length - 6)} (Net)`,
                    orderId: new ObjectId(id),
                    createdAt: new Date()
                });

                await req.db.collection('orders').updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { platformCommission: commissionAmount, netVendorEarnings: netAmount } }
                );
            }
        }
        // END: Credit Wallet

        res.json({ message: "Order status updated", status });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /api/orders/available - Get orders ready for pickup
router.get('/available', async (req, res) => {
    try {
        // Find orders that are 'pending', 'preparing', or 'ready' and have NO rider assigned
        const pipeline = [
            {
                $match: {
                    status: { $in: ['pending', 'preparing', 'ready'] },
                    riderId: null // Matches null or missing field
                }
            },
            { $sort: { createdAt: -1 } },
            // Lookup Vendor details
            {
                $lookup: {
                    from: 'users',
                    localField: 'vendorId',
                    foreignField: '_id',
                    as: 'vendor'
                }
            },
            {
                $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true }
            },
            {
                $addFields: {
                    vendorName: '$vendor.name',
                    vendorAddress: '$vendor.address',
                    vendorLocation: '$vendor.liveLocation'
                }
            },
            {
                $project: {
                    vendor: 0 // Remove full object
                }
            }
        ];

        const richOrders = await req.db.collection('orders').aggregate(pipeline).toArray();

        res.json(richOrders);
    } catch (error) {
        console.error("Get available orders error:", error);
        res.status(500).json({ message: error.message || "Server error" });
    }
});

// PATCH /api/orders/:id/reject - Rider rejects an order
router.patch('/:id/reject', async (req, res) => {
    try {
        const { id } = req.params;
        const { riderId } = req.body;

        if (!riderId) {
            return res.status(400).json({ message: "Rider ID is required" });
        }

        const order = await req.db.collection('orders').findOne({ _id: new ObjectId(id) });
        if (!order) {
            return res.status(404).json({ message: "Order not found" });
        }

        if (order.visibleToRiderId && order.visibleToRiderId.toString() !== riderId) {
            return res.status(403).json({ message: "You are not assigned to this order" });
        }

        // Add to rejected list and find next
        await req.db.collection('orders').updateOne(
            { _id: new ObjectId(id) },
            {
                $addToSet: { rejectedByRiders: new ObjectId(riderId) },
                $set: { visibleToRiderId: null, status: 'pending' } // Temporarily reset
            }
        );

        // Re-fetch updated order to include the new rejection
        const updatedOrder = await req.db.collection('orders').findOne({ _id: new ObjectId(id) });
        const rejectedIds = updatedOrder.rejectedByRiders || [];

        // Assign to next
        if (updatedOrder.vendorLocation) {
            // Run async
            assignOrderToNearestRider(req.db, new ObjectId(id), updatedOrder.vendorLocation, rejectedIds);
        }

        res.json({ success: true, message: "Order rejected" });
    } catch (error) {
        console.error("Reject order error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// PATCH /api/orders/:id/accept - Rider accepts an order
router.patch('/:id/accept', async (req, res) => {
    try {
        const { id } = req.params;
        const { riderId } = req.body;

        if (!riderId) {
            return res.status(400).json({ message: "Rider ID is required" });
        }

        // Use atomic findOneAndUpdate to ensure no race condition
        // Only accept if NO riderId is set AND (visibleToRiderId matches OR it's open if we allow that)
        // Here we strictly check visibleToRiderId to prevent poaching if we want strict assignment

        const result = await req.db.collection('orders').findOneAndUpdate(
            {
                _id: new ObjectId(id),
                riderId: null, // Ensure not already taken
                $or: [
                    { visibleToRiderId: new ObjectId(riderId) },
                    // { visibleToRiderId: null } // Optional: allow snatching if open? No, stick to strict.
                ]
            },
            {
                $set: {
                    riderId: new ObjectId(riderId),
                    status: 'accepted',
                    updatedAt: new Date(),
                    riderAcceptedAt: new Date()
                }
            },
            { returnDocument: 'after' }
        );

        if (!result) { // Order not found or already taken or not visible
            // Check why failed
            const check = await req.db.collection('orders').findOne({ _id: new ObjectId(id) });
            if (!check) return res.status(404).json({ message: "Order not found" });
            if (check.riderId) return res.status(400).json({ message: "Order already accepted by another rider" });
            return res.status(403).json({ message: "Order not assigned to you" });
        }

        // Mark Rider as Busy
        await req.db.collection('users').updateOne(
            { _id: new ObjectId(riderId) },
            { $set: { isAvailable: false } }
        );

        // Notify Vendor
        // TODO: Add notification logic here

        res.json({ success: true, message: "Order accepted", order: result });
    } catch (error) {
        console.error("Accept order error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// GET /api/orders/:id
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const pipeline = [
            { $match: { _id: new ObjectId(id) } },
            // Lookup Vendor
            {
                $lookup: {
                    from: 'users',
                    localField: 'vendorId',
                    foreignField: '_id',
                    as: 'vendor'
                }
            },
            { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } },
            // Lookup Customer
            {
                $lookup: {
                    from: 'users',
                    localField: 'userId', // Assuming userId is customer
                    foreignField: '_id',
                    as: 'customer'
                }
            },
            { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
            {
                $addFields: {
                    vendorName: '$vendor.name',
                    vendorAddress: '$vendor.address', // Important for Pickup
                    vendorLocation: '$vendor.liveLocation',
                    customerName: '$customer.name',
                    // address is already in order usually, but let's ensure we have fallback
                    customerPhone: '$customer.phoneNumber'
                }
            },
            {
                $project: {
                    vendor: 0,
                    customer: 0
                }
            }
        ];

        const orders = await req.db.collection('orders').aggregate(pipeline).toArray();
        const order = orders[0];

        if (!order) {
            return res.status(404).json({ message: "Order not found" });
        }

        res.json(order);
    } catch (error) {
        console.error("Get order error:", error);
        res.status(500).json({ message: error.message || "Server error" });
    }
});

module.exports = router;
