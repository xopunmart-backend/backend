const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const admin = require('../firebase');

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
                vendorOrders[vId] = {
                    vendorId: product.vendorId, // Keep original type
                    userId,
                    items: [],
                    totalAmount: 0,
                    status: 'pending', // pending, preparing, ready, picked, completed, cancelled
                    paymentMethod: paymentMethod || 'COD',
                    address,
                    location, // Save lat/lng coordinates
                    createdAt: new Date(),
                    updatedAt: new Date()
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

// GET /api/orders/:id
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const order = await req.db.collection('orders').findOne({ _id: new ObjectId(id) });

        if (!order) {
            return res.status(404).json({ message: "Order not found" });
        }

        res.json(order);
    } catch (error) {
        console.error("Get order error:", error);
        res.status(500).json({ message: "Server error" });
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

module.exports = router;
