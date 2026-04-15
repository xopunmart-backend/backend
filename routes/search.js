const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const admin = require('../firebase');

// GET /api/search?q=<query>
// Returns matched customers, products (max 5 each)
router.get('/', async (req, res) => {
    try {
        const db = req.db;
        const q = (req.query.q || '').trim();

        if (!q || q.length < 2) {
            return res.json({ customers: [], products: [], orders: [] });
        }

        const regex = new RegExp(q, 'i');

        // 1. Search Customers (MongoDB)
        const customers = await db.collection('users').find({
            role: 'user',
            $or: [
                { name: { $regex: regex } },
                { email: { $regex: regex } },
                { phoneNumber: { $regex: regex } },
                { phone: { $regex: regex } },
            ]
        }).limit(5).project({ password: 0 }).toArray();

        // 2. Search Products (MongoDB)
        const products = await db.collection('products').find({
            $or: [
                { name: { $regex: regex } },
                { category: { $regex: regex } },
            ]
        }).limit(5).project({ name: 1, price: 1, image: 1, category: 1 }).toArray();

        // 3. Search Orders (Firestore — search by customerName or short ID prefix)
        let orders = [];
        try {
            const snapshot = await admin.firestore().collection('orders')
                .orderBy('createdAt', 'desc')
                .limit(200)
                .get();

            const allOrders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            const ql = q.toLowerCase();
            orders = allOrders.filter(o => {
                const name = (o.customerName || '').toLowerCase();
                const shortId = o.id.slice(-6).toLowerCase();
                return name.includes(ql) || shortId.includes(ql);
            }).slice(0, 5).map(o => ({
                id: o.id,
                customerName: o.customerName,
                totalAmount: o.totalAmount,
                status: o.status,
            }));
        } catch (e) {
            console.error('Order search error:', e);
        }

        res.json({ customers, products, orders });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ message: 'Search failed' });
    }
});

module.exports = router;
