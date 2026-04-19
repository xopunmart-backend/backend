const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const admin = require('../firebase');
const { authenticateToken } = require('../middleware/auth');
const { assignOrderToNearestRider, assignOrderBatchToNearestRider } = require('../utils/orderAssignment');
const { sendToUser, sendToTopic } = require('../utils/notificationSender');




// POST /api/orders - Create new order(s) from cart
router.post('/', async (req, res) => {
    try {
        const { userId, address, paymentMethod, location, couponCode, discountAmount, directItems, contactName, contactPhone } = req.body;

        if (!userId || !address) {
            return res.status(400).json({ message: "User ID and address are required" });
        }

        // 1. Determine items source (Cart vs Direct)
        let itemsToProcess = [];

        if (directItems && Array.isArray(directItems) && directItems.length > 0) {
            itemsToProcess = directItems;
        } else {
            // Get User's Cart (MongoDB)
            const cart = await req.db.collection('carts').findOne({ userId });
            if (!cart || !cart.items || cart.items.length === 0) {
                return res.status(400).json({ message: "Cart is empty" });
            }
            itemsToProcess = cart.items;
        }

        // Fetch Customer Details (MongoDB) needed for Denormalization
        const customer = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
        if (!customer) {
            return res.status(404).json({ message: "Customer not found" });
        }

        // Fetch Settings from Firestore
        const settingsSnap = await admin.firestore().collection('settings').doc('pricing').get();
        const settings = settingsSnap.exists ? settingsSnap.data() : {};
        
        const handlingFee = settings.handlingFee ?? 0;
        const baseDeliveryFee = settings.deliveryCharge ?? 0;
        const freeDeliveryThreshold = settings.freeDeliveryThreshold ?? 0;
        const firstXOrdersFree = settings.freeDeliveryFirstXOrders ?? 0; // consistent name
        const riderEarning = settings.riderEarning ?? 0;

        // Fetch User's Total Order Count from Profile (Using firebaseUid from MongoDB customer doc)
        let userOrderCount = 0;
        const firestoreUserId = customer.firebaseUid; // The ID used in Firestore
        
        if (firestoreUserId) {
            try {
                const userSnap = await admin.firestore().collection('users').doc(firestoreUserId).get();
                if (userSnap.exists) {
                    userOrderCount = userSnap.data().totalOrders ?? 0;
                }
            } catch(e) {
                console.error("Failed to fetch user totalOrders from Firestore:", e);
            }
        }

        // 2. Enrich items & Group by Vendor
        const vendorOrders = {}; // Map<vendorId, orderData>
        let globalCartTotal = 0.0;

        for (const item of itemsToProcess) {
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

                // Check Store Status and Timings
                if (vendorUser) {
                    if (vendorUser.isOnline === false) {
                        return res.status(400).json({ message: `Shop ${vendorUser.name || 'Vendor'} is currently closed.` });
                    }


                }

                vendorOrders[vId] = {
                    vendorId: vId,
                    userId: userId,
                    items: [],
                    totalAmount: 0,
                    status: 'pending',
                    paymentMethod: paymentMethod || 'COD',
                    // Customer & Address Info (Denormalized)
                    address: address || {}, // Shipping Address Object
                    customerName: contactName || ((customer && customer.name) ? customer.name : 'Unknown'),
                    customerPhone: contactPhone || ((customer && customer.phone || customer.phoneNumber)) ? (customer.phone || customer.phoneNumber) : '',
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
            const lineTotal = lineItem.price * lineItem.quantity;
            vendorOrders[vId].totalAmount += lineTotal;
            globalCartTotal += lineTotal;
        }

        if (Object.keys(vendorOrders).length === 0) {
            return res.status(400).json({ message: "No valid products found in cart" });
        }

        // 3. Apply Discount & Save to Firestore
        const createdOrderIds = [];
        const totalDiscount = parseFloat(discountAmount) || 0;

        // Multi-Vendor Fee Logic
        // We charge a fee for each additional vendor beyond the first one.
        // settings is already fetched above at line 32
        const multiVendorFee = settings.multiVendorFee ?? 10;
        const vendorCount = Object.keys(vendorOrders).length;
        const totalMultiVendorCharge = vendorCount > 1 ? (vendorCount - 1) * multiVendorFee : 0;
        let isFirstOrderProcessed = false;

        const isMultiVendor = vendorCount > 1;
        const groupId = isMultiVendor ? uuidv4() : null;

        // Collect data for batch assignment
        const batchOrdersForAssignment = [];

        for (const vId in vendorOrders) {
            const orderData = vendorOrders[vId];

            if (groupId) {
                orderData.groupId = groupId;
            }

            // Pro-rate discount
            // (OrderTotal / GlobalTotal) * TotalDiscount
            let orderDiscount = 0;
            if (totalDiscount > 0 && globalCartTotal > 0) {
                orderDiscount = (orderData.totalAmount / globalCartTotal) * totalDiscount;
            }

            // Ensure discount doesn't exceed total
            if (orderDiscount > orderData.totalAmount) orderDiscount = orderData.totalAmount;

            // Apply Fees
            // Logic Update: Apply Delivery and Handling fees ONLY to the first order in the batch.
            // Multi-Vendor Fee is also applied to the first order.

            let currentDeliveryFee = 0;
            let currentHandlingFee = 0;
            let currentOrderMultiVendorFee = 0;
            let currentRiderEarning = settings.extraShopRiderFee ?? 10; // Default to extra fee

            if (!isFirstOrderProcessed) {
                // Determine delivery fee based on GLOBAL cart total, not individual order total
                // Note: handling logic asks for single delivery fee. 
                // We use globalCartTotal calculated in step 2.
                // Pricing Logic Implementation:
                // IF (userOrderCount < firstXOrdersFree) => deliveryFee = 0, handlingFee = 0
                // ELSE IF (globalCartTotal >= freeDeliveryThreshold) => deliveryFee = 0
                // ELSE => deliveryFee = baseDeliveryCharge

                if (firstXOrdersFree > 0 && userOrderCount < firstXOrdersFree) {
                    currentDeliveryFee = 0;
                    currentHandlingFee = 0;
                    console.log(`[Pricing] Free Order applied! userOrderCount (${userOrderCount}) < firstXOrdersFree (${firstXOrdersFree})`);
                } else if (globalCartTotal >= freeDeliveryThreshold) {
                    currentDeliveryFee = 0;
                    currentHandlingFee = handlingFee;
                    console.log(`[Pricing] Free Delivery applied! globalCartTotal (${globalCartTotal}) >= threshold (${freeDeliveryThreshold})`);
                } else {
                    currentDeliveryFee = baseDeliveryFee;
                    currentHandlingFee = handlingFee;
                    console.log(`[Pricing] Standard fees applied. Delivery: ${currentDeliveryFee}, Handling: ${currentHandlingFee}`);
                }

                if (totalMultiVendorCharge > 0) {
                    currentOrderMultiVendorFee = totalMultiVendorCharge;
                }

                currentRiderEarning = riderEarning; // First order gets base earning

                isFirstOrderProcessed = true;
            }

            orderData.itemsTotal = parseFloat(orderData.totalAmount.toFixed(2)); // Pure product total
            // subtotal = items + fees
            orderData.subtotal = parseFloat((orderData.totalAmount + currentDeliveryFee + currentHandlingFee + currentOrderMultiVendorFee).toFixed(2));

            orderData.deliveryFee = currentDeliveryFee;
            orderData.handlingFee = currentHandlingFee;
            orderData.multiVendorFee = currentOrderMultiVendorFee;


            orderData.riderEarning = currentRiderEarning;

            orderData.discount = parseFloat(orderDiscount.toFixed(2));
            orderData.totalAmount = parseFloat((orderData.subtotal - orderDiscount).toFixed(2));

            if (couponCode) {
                orderData.couponCode = couponCode;
            }

            // Create Document
            const docRef = await admin.firestore().collection('orders').add(orderData);
            const orderId = docRef.id;
            createdOrderIds.push(orderId);

            console.log(`[Firestore] Created Order ${orderId} | Sub: ${orderData.subtotal} | Disc: ${orderData.discount} | Final: ${orderData.totalAmount} | Group: ${groupId}`);

            // 4b. Increment User's totalOrders count in Firestore
            if (firestoreUserId) {
                try {
                    await admin.firestore().collection('users').doc(firestoreUserId).update({
                        totalOrders: admin.firestore.FieldValue.increment(1)
                    });
                    console.log(`[User] Incremented totalOrders for Firestore UID: ${firestoreUserId}`);
                } catch (e) {
                    console.error("Failed to increment user totalOrders in Firestore:", e);
                }
            }

            if (orderData.vendorLocation) {
                batchOrdersForAssignment.push({
                    orderId: orderId,
                    vendorLocation: orderData.vendorLocation
                });
            }

            // 5. Notifications (Vendor)
            try {
                // Use centralized sender which saves to DB
                await sendToUser(
                    req.db,
                    vId, // vendorId string
                    'New Order Received',
                    `You have received a new order of ₹${orderData.totalAmount}`,
                    { type: 'order', orderId: orderId }
                );
            } catch (e) {
                console.error("Vendor Notification Error:", e);
            }
        }

        // 4. Trigger Assignment (Async)
        // If Grouped, call Batch Assignment. Else call Single.
        if (batchOrdersForAssignment.length > 0) {
            if (groupId && batchOrdersForAssignment.length > 1) {
                // Batch Assignment
                assignOrderBatchToNearestRider(req.db, groupId, batchOrdersForAssignment);
            } else {
                // Single Assignments (Loop though likely only 1 if not grouped, but safer to loop)
                for (const item of batchOrdersForAssignment) {
                    assignOrderToNearestRider(req.db, item.orderId, item.vendorLocation);
                }
            }
        }

        // 6. Clear Cart (ONLY if not a direct buy)
        if (!directItems) {
            await req.db.collection('carts').updateOne(
                { userId },
                { $set: { items: [], updatedAt: new Date() } }
            );
        }

        // Notify Admin
        sendToTopic(
            'admin_notifications',
            'New Order Received! 🛍️',
            `Order #${createdOrderIds[0].substring(createdOrderIds[0].length - 6).toUpperCase()} placed by ${customer ? customer.name : 'Customer'}`,
            { type: 'order', orderId: createdOrderIds[0] }
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
        const { vendorId, riderId } = req.query;
        let query = admin.firestore().collection('orders');

        if (vendorId) {
            query = query.where('vendorId', '==', vendorId);
        }
        if (riderId) {
            query = query.where('riderId', '==', riderId);
        }

        let snapshot;
        if (vendorId || riderId) {
            // If filtering, don't use orderBy in query to avoid index errors
            snapshot = await query.get();
        } else {
            snapshot = await query.orderBy('createdAt', 'desc').get();
        }

        const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // Sort in memory (descending)
        orders.sort((a, b) => {
            const dateA = a.createdAt ? new Date(a.createdAt._seconds * 1000) : new Date(0);
            const dateB = b.createdAt ? new Date(b.createdAt._seconds * 1000) : new Date(0);
            return dateB - dateA;
        });

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

        const updateData = {
            status: status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (status === 'cancelled') {
            updateData.assignmentStatus = 'cancelled';
            updateData.visibleToRiderId = null; // Remove from rider's view immediately
        } else if (status === 'delivered' || status === 'completed') {
            updateData.assignmentStatus = 'completed';
        }

        // 1. Update Status in Firestore
        await orderRef.update(updateData);

        // 2. Post-Update Logic (Wallet, Rider Availability, Notifications)
        const orderDoc = await orderRef.get();
        const order = orderDoc.data();

        if (status === 'completed' || status === 'cancelled') {
            if (order) {
                // Credit Wallet Logic (MongoDB)
                if (status === 'completed' && order.paymentMethod !== 'COD_UNPAID') {
                    // Fetch dynamic commission
                    const settingsDoc = await req.db.collection('settings').findOne({ type: 'global_config' });
                    const settings = settingsDoc ? settingsDoc.config : {};
                    const commissionPercent = settings.vendorCommission !== undefined ? settings.vendorCommission : 5; // Default 5%

                    const baseAmount = order.itemsTotal || order.totalAmount;
                    const commissionRate = commissionPercent / 100;
                    const commissionAmount = baseAmount * commissionRate;
                    const netAmount = baseAmount - commissionAmount;

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
                    let updateOp = { $set: { isAvailable: true } };
                    let rEarning = typeof order.riderEarning === 'number' ? order.riderEarning : 15;

                    if (status === 'completed') {
                        updateOp.$inc = { walletBalance: rEarning };
                    }

                    await req.db.collection('users').updateOne(
                        riderQuery,
                        updateOp
                    );

                    if (status === 'completed') {
                        const rUser = await req.db.collection('users').findOne(riderQuery);
                        if (rUser) {
                            await req.db.collection('transactions').insertOne({
                                userId: rUser._id,
                                type: 'credit',
                                amount: rEarning,
                                description: `Delivery Earnings #${id.substring(id.length - 6).toUpperCase()}`,
                                orderId: id,
                                createdAt: new Date()
                            });
                        }
                    }
                }
            }
        }

        // --- NEW: Notify Customer ---
        if (order && order.userId) {
            let title = '';
            let body = '';
            // Normalize status to lowercase for comparison
            const s = status.toLowerCase();

            switch (s) {
                case 'confirmed':
                    title = 'Order Confirmed! ✅';
                    body = `Your order #${id.substring(id.length - 6).toUpperCase()} has been confirmed.`;
                    break;
                case 'preparing':
                    title = 'Preparing your Order 🍳';
                    body = 'The restaurant is preparing your food.';
                    break;
                case 'ready':
                    title = 'Order Ready 🥡';
                    body = 'Your order is packed and waiting for pickup.';
                    break;
                case 'out_for_delivery':
                case 'picked_up':
                    title = 'Out for Delivery 🛵';
                    body = 'Your rider is on the way!';
                    break;
                case 'completed':
                case 'delivered':
                    title = 'Delivered 🎉';
                    body = 'Your order has been delivered. Enjoy!';
                    break;
                case 'cancelled':
                    title = 'Order Cancelled ❌';
                    body = 'Your order has been cancelled.';
                    break;
            }

            if (title && body) {
                // Async call - don't await blocking response
                // Pass userId (usually MongoID string) directly
                sendToUser(req.db, order.userId, title, body, { type: 'order', orderId: id });
            }
        }
        // ----------------------------


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
            .where('status', 'in', ['pending', 'preparing', 'ready', 'requesting_rider']);
        // .where('riderId', '==', null); // REMOVED: Excludes riderId="" which happens often

        const snapshot = await query.orderBy('createdAt', 'desc').get();
        let orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // Strict JS Filter: Exclude if riderId is present and not empty string
        orders = orders.filter(o => {
            const hasRider = o.riderId && o.riderId.toString().trim() !== '';
            return !hasRider;
        });

        if (riderId) {
            orders = orders.filter(o =>
                !o.visibleToRiderId ||
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
        console.log(`[Accept Route] Request to accept order ${id} by rider ${riderId}`);

        if (!riderId) return res.status(400).json({ message: "Rider ID required" });

        const orderRef = admin.firestore().collection('orders').doc(id);

        let assignedRiderId = riderId;
        // Normalize Rider ID (Use Firebase UID preference if available)
        let firebaseUidForVisibility = riderId;
        if (ObjectId.isValid(riderId)) {
            const riderDoc = await req.db.collection('users').findOne({ _id: new ObjectId(riderId) });
            if (riderDoc && riderDoc.firebaseUid) {
                firebaseUidForVisibility = riderDoc.firebaseUid;
            }
        }

        // Transaction to ensure atomicity
        await admin.firestore().runTransaction(async (t) => {
            const doc = await t.get(orderRef);
            console.log(`[Accept Route] Fetched order ${id}, exists: ${doc.exists}`);
            if (!doc.exists) throw new Error(`Order not found for ID: ${id}`);

            const data = doc.data();

            // CHECK FOR BATCH
            let ordersToUpdate = [{ ref: orderRef, data: data }];

            if (data.groupId) {
                // Fetch all orders in this group
                const groupSnap = await t.get(
                    admin.firestore().collection('orders').where('groupId', '==', data.groupId)
                );
                ordersToUpdate = []; // Reset and fill with group
                groupSnap.forEach(gDoc => {
                    ordersToUpdate.push({ ref: gDoc.ref, data: gDoc.data() });
                });
            }

            // Validate ALL orders in batch
            for (const item of ordersToUpdate) {
                if (item.data.riderId) throw new Error("One or more orders in this batch are already accepted");

                // Check visibility permission
                if (item.data.visibleToRiderId && item.data.visibleToRiderId !== riderId) {
                    if (item.data.visibleToRiderId.toString() !== riderId.toString()) {
                        // Secondary Check: The riderId might be MongoID, but visibleToRiderId is FirebaseUID
                        const riderStart = await req.db.collection('users').findOne({ _id: new ObjectId(riderId) });
                        if (!riderStart || riderStart.firebaseUid !== item.data.visibleToRiderId) {
                            throw new Error("Order not assigned to you");
                        }
                    }
                }
            }

            // Update ALL orders
            for (const item of ordersToUpdate) {
                t.update(item.ref, {
                    riderId: riderId,
                    visibleToRiderId: firebaseUidForVisibility, // Keep visible to rider so active stream works using Firebase UID
                    status: 'accepted',
                    assignmentStatus: 'assigned', // Remove from all riders' "New Requests" stream
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    riderAcceptedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        });

        // Mark Rider Busy (MongoDB)
        let riderQuery = {};
        if (ObjectId.isValid(riderId)) {
            riderQuery = { _id: new ObjectId(riderId) };
        } else {
            riderQuery = { firebaseUid: riderId };
        }
        await req.db.collection('users').updateOne(riderQuery, { $set: { isAvailable: false } });

        res.json({ success: true, message: "Order(s) accepted" });
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

// GET /api/orders/batch/:groupId
router.get('/batch/:groupId', async (req, res) => {
    try {
        const { groupId } = req.params;
        const snapshot = await admin.firestore().collection('orders').where('groupId', '==', groupId).get();

        if (snapshot.empty) return res.status(404).json({ message: "Batch not found" });

        const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json(orders);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
