const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const { authenticateToken } = require('../middleware/auth');

const admin = require('../firebase');

const JWT_SECRET = process.env.JWT_SECRET || 'xopunmart_secret_key_123';






// GET /api/wallet/admin/all-transactions
router.get('/admin/all-transactions', async (req, res) => {
    try {
        // In a real app, verify admin role here
        // const userId = new ObjectId(req.user.id);
        // ... check role ...

        // Fetch all transactions
        const transactions = await req.db.collection('transactions')
            .find({})
            .sort({ createdAt: -1 })
            .limit(100)
            .toArray();

        // Calculate stats
        const pendingPayouts = await req.db.collection('transactions').aggregate([
            { $match: { type: 'debit', status: 'pending' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]).toArray();

        const completedPayouts = await req.db.collection('transactions').aggregate([
            { $match: { type: 'debit', status: 'processed' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]).toArray();

        // Commission (mock or calculate from orders?)
        // Let's assume commission is 10% of total revenue from stats for now, or just send 0 if not tracked in transactions
        const totalCommission = 0; // Placeholder

        res.json({
            transactions,
            stats: {
                pendingPayouts: pendingPayouts[0]?.total || 0,
                completedPayouts: completedPayouts[0]?.total || 0,
                totalCommission
            }
        });
    } catch (error) {
        console.error("Admin transactions error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// GET /api/wallet
// Get wallet balance and transaction history
router.get('/', authenticateToken, async (req, res) => {
    try {
        const userId = new ObjectId(req.user.id);

        // 1. Get User Balance
        const user = await req.db.collection('users').findOne(
            { _id: userId },
            { projection: { walletBalance: 1, role: 1, firebaseUid: 1, isOnline: 1, lastOnlineAt: 1, onlineSessions: 1 } }
        );

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        const balance = user.walletBalance || 0;

        // 2. Get Transactions
        const transactions = await req.db.collection('transactions')
            .find({ userId: userId })
            .sort({ createdAt: -1 })
            .limit(50)
            .toArray();

        // 3. Get Today's Trips for Rider
        let todayTrips = 0;
        let onlineHours = "0h 0m";

        if (user.role === 'rider') {
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            // Fetch today's completed orders for rider from Firestore
            let todayTripsCount = 0;
            try {
                const firebaseUid = user.firebaseUid;
                const riderIdStr = userId.toString();

                const snapshot = await admin.firestore().collection('orders')
                    .where('status', '==', 'completed')
                    .get();

                snapshot.forEach(doc => {
                    const orderData = doc.data();
                    if (orderData.riderId === riderIdStr || orderData.riderId === firebaseUid) {
                        // Check if completed today
                        const timestamp = orderData.updatedAt || orderData.createdAt;
                        if (timestamp) {
                            let date;
                            // Handle both Firestore Timestamp and JS Date
                            if (typeof timestamp.toDate === 'function') {
                                date = timestamp.toDate();
                            } else if (timestamp instanceof Date) {
                                date = timestamp;
                            } else if (typeof timestamp === 'string') {
                                date = new Date(timestamp);
                            }

                            if (date && date >= today) {
                                todayTripsCount++;
                            }
                        }
                    }
                });
                todayTrips = todayTripsCount;
            } catch (err) {
                console.error("Error fetching today's trips from Firestore:", err);
            }

            // Calculate onlineHours
            let totalMs = 0;
            const now = new Date();

            // Add accumulated ms from already-closed offline sessions today
            if (user.onlineSessions && user.onlineSessions.date === now.toDateString()) {
                totalMs += (user.onlineSessions.totalMs || (user.onlineSessions.minutes ? user.onlineSessions.minutes * 60000 : 0));
            }

            // Add ms from the currently active ongoing session
            if (user.isOnline && user.lastOnlineAt) {
                const lastOnline = new Date(user.lastOnlineAt);
                if (now.toDateString() === lastOnline.toDateString()) {
                    totalMs += (now - lastOnline);
                }
            }

            const totalMinutes = Math.floor(totalMs / 60000);

            const hrs = Math.floor(totalMinutes / 60);
            const mins = totalMinutes % 60;
            onlineHours = `${hrs}h ${mins}m`;
        }

        res.json({
            balance: balance,
            transactions: transactions,
            todayTrips: todayTrips,
            onlineHours: onlineHours
        });

    } catch (error) {
        console.error("Wallet fetch error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// POST /api/wallet/withdraw
// Request a withdrawal
router.post('/withdraw', authenticateToken, async (req, res) => {
    try {
        const userId = new ObjectId(req.user.id);
        const { amount, bankDetails } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ message: "Invalid amount" });
        }

        const user = await req.db.collection('users').findOne({ _id: userId });
        const currentBalance = user.walletBalance || 0;

        if (currentBalance < amount) {
            return res.status(400).json({ message: "Insufficient balance" });
        }

        // 1. Create Debit Transaction
        const transaction = {
            userId: userId,
            type: 'debit',
            amount: parseFloat(amount),
            description: 'Withdrawal Request',
            status: 'pending', // pending, processed, rejected
            bankDetails: bankDetails || user.bankDetails,
            createdAt: new Date()
        };

        const result = await req.db.collection('transactions').insertOne(transaction);

        // 2. Deduct Bundle (Wait for admin approval? Or deduct immediately?)
        // Usually deduct immediately to prevent double spend.
        await req.db.collection('users').updateOne(
            { _id: userId },
            { $inc: { walletBalance: -parseFloat(amount) } }
        );

        res.json({
            success: true,
            message: "Withdrawal request submitted",
            transactionId: result.insertedId,
            newBalance: currentBalance - amount
        });

    } catch (error) {
        console.error("Withdrawal error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// GET /api/wallet/payment-methods
// Get saved payment methods
router.get('/payment-methods', authenticateToken, async (req, res) => {
    try {
        const userId = new ObjectId(req.user.id);

        // 1. Fetch saved methods from payment_methods collection
        const methods = await req.db.collection('payment_methods')
            .find({ userId: userId })
            .toArray();

        // 2. Fetch User Profile Bank Details
        const user = await req.db.collection('users').findOne(
            { _id: userId },
            { projection: { bankDetails: 1 } }
        );

        // 3. Append Profile Bank Details if available
        if (user && user.bankDetails && user.bankDetails.accountNumber) {
            // Check if profile bank details are somewhat complete
            methods.unshift({
                _id: 'profile_linked_bank', // Virtual ID
                type: 'bank',
                isProfile: true, // Flag to identify
                details: {
                    bankName: user.bankDetails.bankName,
                    accountNo: user.bankDetails.accountNumber,
                    ifsc: user.bankDetails.ifscCode,
                    holderName: user.bankDetails.accountHolderName
                },
                alias: `${user.bankDetails.bankName || 'Bank'} (Profile Default)`
            });
        }

        res.json(methods);
    } catch (error) {
        console.error("Fetch payment methods error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// POST /api/wallet/payment-methods
// Add a new payment method
router.post('/payment-methods', authenticateToken, async (req, res) => {
    try {
        const userId = new ObjectId(req.user.id);
        const { type, details, alias } = req.body; // type: 'bank' | 'upi'

        if (!['bank', 'upi'].includes(type) || !details) {
            return res.status(400).json({ message: "Invalid data" });
        }

        const newMethod = {
            userId,
            type,
            details, // Bank: { accountNo, ifsc, bankName, holderName } | UPI: { vpa }
            alias: alias || (type === 'bank' ? details.bankName : 'UPI ID'),
            createdAt: new Date()
        };

        const result = await req.db.collection('payment_methods').insertOne(newMethod);
        newMethod._id = result.insertedId;

        res.json(newMethod);
    } catch (error) {
        console.error("Add payment method error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// DELETE /api/wallet/payment-methods/:id
router.delete('/payment-methods/:id', authenticateToken, async (req, res) => {
    try {
        const userId = new ObjectId(req.user.id);
        const methodId = new ObjectId(req.params.id);

        const result = await req.db.collection('payment_methods').deleteOne({
            _id: methodId,
            userId: userId
        });

        if (result.deletedCount === 0) {
            return res.status(404).json({ message: "Not found" });
        }

        res.json({ message: "Deleted successfully" });
    } catch (error) {
        console.error("Delete payment method error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

module.exports = router;
