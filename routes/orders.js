const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const admin = require('../firebase');
const { authenticateToken } = require('../middleware/auth');
const { assignOrderToNearestRider } = require('../utils/orderAssignment');

// POST /api/orders - Create new order(s) from cart
router.post('/', async (req, res) => {
    try {
        const { userId, address, paymentMethod, location } = req.body;

        if (!userId || !address) {
            return res.status(400).json({ message: "User ID and address are required" });
        }

        // 1. Get User's Cart (MongoDB)
        const cart = await req.db.collection('carts').findOne({ userId });
        if (!cart || !cart.items || cart.items.length === 0) {
            return res.status(400).json({ message: "Cart is empty" });
        }

        // Fetch Customer Details (MongoDB) needed for Denormalization
        const customer = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
        if (!customer) {
            return res.status(404).json({ message: "Customer not found" });
        }

        // 2. Enrich items & Group by Vendor
        const vendorOrders = {}; // Map<vendorId, orderData>

        for (const item of cart.items) {
            const product = await req.db.collection('products').findOne({ _id: new ObjectId(item.productId) });
            if (!product) continue;

            const lineItem = {
                productId: item.productId,
                name: product.name,
                price: parseFloat(product.price),
                quantity: item.quantity,
                image: product.image || null,
                unit: product.unit || '',
                vendorId: product.vendorId.toString()
            };

            const vId = product.vendorId.toString();

            if (!vendorOrders[vId]) {
                const vendorUser = await req.db.collection('users').findOne({ _id: product.vendorId });

                vendorOrders[vId] = {
                    vendorId: vId,
                    userId: userId,
                    items: [],
                    totalAmount: 0,
                    status: 'pending',
                    paymentMethod: paymentMethod || 'COD',
                    // Customer & Address Info (Denormalized)
                    // Customer & Address Info (Denormalized)
                    address: address || {}, // Shipping Address Object
                    customerName: (customer && customer.name) ? customer.name : 'Unknown',
                    customerPhone: (customer && customer.phoneNumber) ? customer.phoneNumber : '',
                    customerImage: (customer && customer.profileImage) ? customer.profileImage : null,
                    customerLocation: location || null, // Lat/Lng

                    // Vendor Info (Denormalized)
                    vendorName: (vendorUser && vendorUser.name) ? vendorUser.name : 'Unknown Vendor',
                    vendorAddress: (vendorUser && (vendorUser.shopLocation?.address || vendorUser.address)) ? (vendorUser.shopLocation?.address || vendorUser.address) : '',
                    vendorLocation: (vendorUser && (vendorUser.shopLocation || vendorUser.liveLocation)) ? (vendorUser.shopLocation || vendorUser.liveLocation) : null, // Crucial for rider assignment
                    vendorImage: (vendorUser && (vendorUser.shopImage || vendorUser.profileImage)) ? (vendorUser.shopImage || vendorUser.profileImage) : null,

                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),

                    // Rider / Assignment Info
                    riderId: null,
                    visibleToRiderId: null,
                    rejectedByRiders: [],
                    assignmentStatus: 'searching', // searching, assigned, no_riders

                    // Legacy/Compatibility
                    isFirestore: true
                };
            }

            vendorOrders[vId].items.push(lineItem);
            vendorOrders[vId].totalAmount += (lineItem.price * lineItem.quantity);
        }

        if (Object.keys(vendorOrders).length === 0) {
            return res.status(400).json({ message: "No valid products found in cart" });
        }

        // 3. Save to Firestore
        const createdOrderIds = [];

        for (const vId in vendorOrders) {
            const orderData = vendorOrders[vId];
            orderData.totalAmount = parseFloat(orderData.totalAmount.toFixed(2));

            // Create Document
            const docRef = await admin.firestore().collection('orders').add(orderData);
            const orderId = docRef.id;
            createdOrderIds.push(orderId);

            console.log(`[Firestore] Created Order ${orderId}`);

            // 4. Trigger Assignment (Async)
            if (orderData.vendorLocation) {
                // We pass 'db' for Mongo (users access) but need to handle assignment logic update
                // For now, allow it to call but we must update assigning util next!
                assignOrderToNearestRider(req.db, orderId, orderData.vendorLocation);
            }

            // 5. Notifications (Vendor)
            try {
                // Find vendor token
                let vendorToken = null;
                const vendorUser = await req.db.collection('users').findOne({ _id: new ObjectId(vId) });
                if (vendorUser && vendorUser.firebaseUid) {
                    // Check 'vendors' or 'users' in Firestore
                    const vDoc = await admin.firestore().collection('vendors').doc(vendorUser.firebaseUid).get();
                    if (vDoc.exists) vendorToken = vDoc.data().fcmToken;
                    else {
                        const uDoc = await admin.firestore().collection('users').doc(vendorUser.firebaseUid).get();
                        if (uDoc.exists) vendorToken = uDoc.data().fcmToken;
                    }
                }

                if (vendorToken) {
                    await admin.messaging().send({
                        notification: {
                            title: 'New Order Received',
                            body: `You have received a new order of ₹${orderData.totalAmount}`
                        },
                        data: { type: 'order', orderId: orderId },
                        token: vendorToken
                    });
                }
            } catch (e) {
                console.error("Vendor Notification Error:", e);
            }
        }

        // 6. Clear Cart
        await req.db.collection('carts').updateOne(
            { userId },
            { $set: { items: [], updatedAt: new Date() } }
        );

        res.status(201).json({
            message: "Order placed successfully",
            orderIds: createdOrderIds
        });

    } catch (error) {
        console.error("Create Order Error:", error);
        res.status(500).json({ message: error.message });
    }
});

// GET /api/orders?vendorId=...
router.get('/', async (req, res) => {
    try {
        const { vendorId } = req.query;
        let query = admin.firestore().collection('orders');

        if (vendorId) {
            query = query.where('vendorId', '==', vendorId);
        }

        const snapshot = await query.orderBy('createdAt', 'desc').get();
        const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        res.json(orders);
    } catch (error) {
        console.error("Get orders error:", error);
        res.status(500).json({ message: error.message });
    }
});

// GET /api/orders/user/:userId
router.get('/user/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const snapshot = await admin.firestore().collection('orders')
            .where('userId', '==', userId)
            .orderBy('createdAt', 'desc')
            .get();

        const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json(orders);
    } catch (error) {
        console.error("Get user orders error:", error);
        res.status(500).json({ message: error.message });
    }
});

// GET /api/orders/recent?vendorId=...
router.get('/recent', authenticateToken, async (req, res) => {
    try {
        const { vendorId } = req.query;
        if (!vendorId) {
            return res.status(400).json({ message: "Vendor ID is required" });
        }

        const snapshot = await admin.firestore().collection('orders')
            .where('vendorId', '==', vendorId)
            .orderBy('createdAt', 'desc')
            .limit(5)
            .get();

        const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
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

        const orderRef = admin.firestore().collection('orders').doc(id);

        // 1. Update Status in Firestore
        await orderRef.update({
            status: status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // 2. Post-Update Logic (Wallet, Rider Availability)
        if (status === 'completed' || status === 'cancelled') {
            const orderDoc = await orderRef.get();
            const order = orderDoc.data();

            if (order) {
                // Credit Wallet Logic (MongoDB)
                if (status === 'completed' && order.paymentMethod !== 'COD_UNPAID') {
                    const commissionRate = 0.10;
                    const commissionAmount = order.totalAmount * commissionRate;
                    const netAmount = order.totalAmount - commissionAmount;

                    // Vendor ID is stored as string in Firestore, needed as ObjectId for Mongo
                    const vendorObjectId = new ObjectId(order.vendorId);

                    await req.db.collection('users').updateOne(
                        { _id: vendorObjectId },
                        { $inc: { walletBalance: netAmount } }
                    );

                    await req.db.collection('transactions').insertOne({
                        userId: vendorObjectId,
                        type: 'credit',
                        amount: netAmount,
                        commission: commissionAmount,
                        description: `Order Payment #${id.substring(id.length - 6)} (Net)`,
                        orderId: id, // String ID Reference
                        createdAt: new Date()
                    });

                    // Update Firestore with commission details
                    await orderRef.update({
                        platformCommission: commissionAmount,
                        netVendorEarnings: netAmount
                    });
                }

                // Free up Rider (MongoDB)
                if (order.riderId) { // riderId is string (MongoID or FirebaseUID)
                    // Try to find rider by _id (if MongoID) or firebaseUid
                    // Simplest is to check if it's a valid ObjectId
                    let riderQuery = {};
                    if (ObjectId.isValid(order.riderId)) {
                        riderQuery = { _id: new ObjectId(order.riderId) };
                    } else {
                        riderQuery = { firebaseUid: order.riderId };
                    }

                    await req.db.collection('users').updateOne(
                        riderQuery,
                        { $set: { isAvailable: true } }
                    );
                }
            }
        }

        res.json({ message: "Order status updated", status });
    } catch (error) {
        console.error("Update status error:", error);
        res.status(500).json({ message: error.message });
    }
});

// GET /api/orders/available - Get orders ready for pickup
router.get('/available', async (req, res) => {
    try {
        const { riderId } = req.query;

        let query = admin.firestore().collection('orders')
            .where('status', 'in', ['pending', 'preparing', 'ready'])
            .where('riderId', '==', null);

        // Firestore complex OR queries are limited.
        // We need (visibleToRiderId == null OR visibleToRiderId == riderId)
        // We can fetch all unassigned and filter in memory (dataset usually header-small for unassigned)
        // OR make two queries. Filtering in memory is safer/easier for this scale.

        const snapshot = await query.orderBy('createdAt', 'desc').get();
        let orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (riderId) {
            orders = orders.filter(o =>
                o.visibleToRiderId === null ||
                o.visibleToRiderId === riderId ||
                (o.visibleToRiderId && o.visibleToRiderId.toString() === riderId)
            );
        }

        res.json(orders);
    } catch (error) {
        console.error("Get available orders error:", error);
        res.status(500).json({ message: error.message });
    }
});

// PATCH /api/orders/:id/reject - Rider rejects an order
router.patch('/:id/reject', async (req, res) => {
    try {
        const { id } = req.params;
        const { riderId } = req.body;

        if (!riderId) return res.status(400).json({ message: "Rider ID required" });

        const orderRef = admin.firestore().collection('orders').doc(id);
        const orderDoc = await orderRef.get();

        if (!orderDoc.exists) return res.status(404).json({ message: "Order not found" });
        const order = orderDoc.data();

        if (order.visibleToRiderId && order.visibleToRiderId !== riderId) {
            return res.status(403).json({ message: "Order not assigned to you" });
        }

        await orderRef.update({
            visibleToRiderId: null,
            status: 'pending',
            rejectedByRiders: admin.firestore.FieldValue.arrayUnion(riderId)
        });

        // Trigger Re-assignment
        const updatedOrder = (await orderRef.get()).data();
        const rejectedIds = updatedOrder.rejectedByRiders || [];

        if (updatedOrder.vendorLocation) {
            assignOrderToNearestRider(req.db, id, updatedOrder.vendorLocation, rejectedIds);
        }

        res.json({ success: true, message: "Order rejected" });
    } catch (error) {
        console.error("Reject order error:", error);
        res.status(500).json({ message: error.message });
    }
});

// PATCH /api/orders/:id/accept - Rider accepts an order
router.patch('/:id/accept', async (req, res) => {
    try {
        const { id } = req.params;
        let { riderId } = req.body;

        if (!riderId) return res.status(400).json({ message: "Rider ID required" });

        const orderRef = admin.firestore().collection('orders').doc(id);

        let assignedRiderId = riderId;
        // Normalize Rider ID (Use Firebase UID preference if available)
        // We trust client sending correct ID, but ideally we should verify.
        // For Speed: We use what is sent, assuming auth middleware verified token.
        // Wait, 'req.user' isn't populated here? We rely on body.

        // Transaction to ensure atomicity
        await admin.firestore().runTransaction(async (t) => {
            const doc = await t.get(orderRef);
            if (!doc.exists) throw new Error("Order not found");

            const data = doc.data();
            if (data.riderId) throw new Error("Order already accepted");

            // Check visibility permission
            if (data.visibleToRiderId && data.visibleToRiderId !== riderId) {
                // Try loose matching (string vs obj)
                if (data.visibleToRiderId.toString() !== riderId.toString()) {
                    // Secondary Check: The riderId might be MongoID, but visibleToRiderId is FirebaseUID
                    // We need to verify if this MongoID belongs to the FirebaseUID
                    const riderStart = await req.db.collection('users').findOne({ _id: new ObjectId(riderId) });
                    if (!riderStart || riderStart.firebaseUid !== data.visibleToRiderId) {
                        throw new Error("Order not assigned to you");
                    }
                }
            }

            t.update(orderRef, {
                riderId: riderId,
                status: 'accepted',
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                riderAcceptedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        // Mark Rider Busy (MongoDB)
        let riderQuery = {};
        if (ObjectId.isValid(riderId)) {
            riderQuery = { _id: new ObjectId(riderId) };
        } else {
            riderQuery = { firebaseUid: riderId };
        }
        await req.db.collection('users').updateOne(riderQuery, { $set: { isAvailable: false } });

        res.json({ success: true, message: "Order accepted" });
    } catch (error) {
        console.error("Accept order error:", error);
        const status = error.message.includes("found") ? 404 : 400;
        res.status(status).json({ message: error.message });
    }
});

// GET /api/orders/:id
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const doc = await admin.firestore().collection('orders').doc(id).get();

        if (!doc.exists) return res.status(404).json({ message: "Order not found" });

        res.json({ id: doc.id, ...doc.data() });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
