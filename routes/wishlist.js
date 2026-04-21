const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { authenticateToken } = require('../middleware/auth');

// GET /api/wishlist
router.get('/', authenticateToken, async (req, res) => {
    try {
        const userId = new ObjectId(req.user.id);
        const db = req.db;

        const wishlist = await db.collection('wishlists').findOne({ userId });

        if (!wishlist || !wishlist.products || wishlist.products.length === 0) {
            return res.json([]);
        }

        const products = await db.collection('products')
            .find({ _id: { $in: wishlist.products } })
            .toArray();

        res.json(products);
    } catch (error) {
        console.error("Error fetching wishlist:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// POST /api/wishlist/add
router.post('/add', authenticateToken, async (req, res) => {
    try {
        const userId = new ObjectId(req.user.id);
        const { productId } = req.body;
        const db = req.db;

        if (!productId) {
            return res.status(400).json({ message: "Product ID required" });
        }

        await db.collection('wishlists').updateOne(
            { userId },
            { $addToSet: { products: new ObjectId(productId) } },
            { upsert: true }
        );

        res.json({ success: true, message: "Added to wishlist" });
    } catch (error) {
        console.error("Error adding to wishlist:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// DELETE /api/wishlist/remove/:productId
router.delete('/remove/:productId', authenticateToken, async (req, res) => {
    try {
        const userId = new ObjectId(req.user.id);
        const { productId } = req.params;
        const db = req.db;

        await db.collection('wishlists').updateOne(
            { userId },
            { $pull: { products: new ObjectId(productId) } }
        );

        res.json({ success: true, message: "Removed from wishlist" });
    } catch (error) {
        console.error("Error removing from wishlist:", error);
        res.status(500).json({ message: "Server error" });
    }
});

module.exports = router;
