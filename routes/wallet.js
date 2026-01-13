const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'xopunmart_secret_key_123';

// Middleware to authenticate token
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// GET /api/wallet
// Get wallet balance and transaction history
router.get('/', authenticateToken, async (req, res) => {
    try {
        const userId = new ObjectId(req.user.id);

        // 1. Get User Balance
        const user = await req.db.collection('users').findOne(
            { _id: userId },
            { projection: { walletBalance: 1 } }
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

        res.json({
            balance: balance,
            transactions: transactions
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
        const methods = await req.db.collection('payment_methods')
            .find({ userId: userId })
            .toArray();
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
