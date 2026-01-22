const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const admin = require('../firebase');
const { assignOrderToNearestRider } = require('../utils/orderAssignment');

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

            // SYNC TO FIRESTORE
            try {
                const firestoreOrder = {
                    ...orderData,
                    _id: result.insertedId.toString(), // Store Mongo ID as string
                    vendorId: orderData.vendorId.toString(),
                    userId: orderData.userId.toString(),
                    createdAt: admin.firestore.Timestamp.fromDate(orderData.createdAt),
                    updatedAt: admin.firestore.Timestamp.fromDate(orderData.updatedAt),
                    // Ensure lat/lng are simple objects or Geopoints
                    vendorLocation: orderData.vendorLocation ? {
                        latitude: orderData.vendorLocation.latitude,
                        longitude: orderData.vendorLocation.longitude
                    } : null
                };

                // Use MongoID as Doc ID in Firestore for easy mapping
                await admin.firestore().collection('orders').doc(result.insertedId.toString()).set(firestoreOrder);
                console.log("Synced order to Firestore:", result.insertedId.toString());
            } catch (fsError) {
                console.error("Firestore Sync Error (Create):", fsError);
            }

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
                // Fetch FCM Token from Firestore
                let vendorFcmToken = null;
                try {
                    // 1. Get Vendor's Firebase UID from MongoDB
                    const vendorUser = await req.db.collection('users').findOne({ _id: new ObjectId(vId) });
                    const vendorFirebaseUid = vendorUser ? vendorUser.firebaseUid : null;
                    const docIdToUse = vendorFirebaseUid || vId; // Fallback to MongoID (legacy)

                    console.log(`[FCM] Checking token for vendor ${vId} (FirebaseUID: ${vendorFirebaseUid || 'N/A'})...`);

                    // 2. Check 'vendors' collection (New App)
                    const vendorDoc = await admin.firestore().collection('vendors').doc(docIdToUse).get();
                    if (vendorDoc.exists) {
                        vendorFcmToken = vendorDoc.data().fcmToken;
                    } else {
                        // 3. Fallback: Check 'users' collection (Old App/Misconfig)
                        const userDoc = await admin.firestore().collection('users').doc(docIdToUse).get();
                        if (userDoc.exists) {
                            vendorFcmToken = userDoc.data().fcmToken;
                        }
                    }
                } catch (e) {
                    console.error(`[FCM] Error fetching token for vendor ${vId} from Firestore:`, e);
                }

                if (vendorFcmToken) {
                    console.log(`[FCM] Found vendor ${vId} with token: ${vendorFcmToken.substring(0, 10)}...`);
                    const messagePayload = {
                        notification: {
                            title: notificationData.title,
                            body: notificationData.message
                        },
                        data: {
                            type: 'order',
                            orderId: result.insertedId.toString()
                        },
                        token: vendorFcmToken
                    };

                    try {
                        const fcmResponse = await admin.messaging().send(messagePayload);
                        console.log(`[FCM] Push notification sent to vendor ${vId}. Response: ${fcmResponse}`);
                    } catch (fcmError) {
                        console.error(`[FCM] Error sending push to vendor ${vId}:`, fcmError);
                    }
                } else {
                    console.log(`[FCM] Vendor ${vId} has no FCM token in Firestore. Push skipped.`);
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

        // SYNC TO FIRESTORE
        try {
            await admin.firestore().collection('orders').doc(id).update({
                status: status,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (fsError) {
            console.error("Firestore Sync Error (Status Update):", fsError);
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

        // SYNC TO FIRESTORE
        try {
            await admin.firestore().collection('orders').doc(id).update({
                visibleToRiderId: null,
                status: 'pending',
                // Firestore doesn't support $addToSet in same way, need arrayUnion
                rejectedByRiders: admin.firestore.FieldValue.arrayUnion(riderId)
            });
        } catch (fsError) {
            console.error("Firestore Sync Error (Reject):", fsError);
        }

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
        let { riderId } = req.body;

        if (!riderId) {
            return res.status(400).json({ message: "Rider ID is required" });
        }

        let riderObjectId;

        // Resolve riderId to Mongo ObjectId
        if (ObjectId.isValid(riderId) && (String(new ObjectId(riderId)) === riderId)) {
            // It's a valid Mongo ID string
            riderObjectId = new ObjectId(riderId);
        } else {
            // Assume it's a Firebase UID
            console.log(`Looking up Mongo ID for Firebase UID: ${riderId}`);
            const user = await req.db.collection('users').findOne({ firebaseUid: riderId });
            if (!user) {
                return res.status(404).json({ message: "Rider not found for provided ID" });
            }
            riderObjectId = user._id;
            // Update riderId to be the Mongo ID for consistency in 'orders' collection
            // BUT we might need the Firebase UID for other things?
            // Actually, the app likely sends Mongo ID if it has it.
            // But if we start sending Firebase UID from app, we need this translation.
        }

        // Use atomic findOneAndUpdate to ensure no race condition
        const result = await req.db.collection('orders').findOneAndUpdate(
            {
                _id: new ObjectId(id),
                riderId: null, // Ensure not already taken
                $or: [
                    { visibleToRiderId: riderObjectId }, // Check Mongo ID
                    { visibleToRiderId: riderId } // Check whatever was passed (e.g. Firebase UID)
                ]
            },
            {
                $set: {
                    riderId: riderObjectId,
                    status: 'accepted',
                    updatedAt: new Date(),
                    riderAcceptedAt: new Date()
                }
            },
            { returnDocument: 'after' }
        );

        // SYNC TO FIRESTORE
        if (result) {
            try {
                await admin.firestore().collection('orders').doc(id).update({
                    riderId: riderId,
                    status: 'accepted',
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    riderAcceptedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            } catch (fsError) {
                console.error("Firestore Sync Error (Accept):", fsError);
            }
        }

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
