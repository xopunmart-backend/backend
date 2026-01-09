const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');

// Helper to get cart collection
const getCartCollection = (req) => req.db.collection('carts');
const getProductsCollection = (req) => req.db.collection('products');

// GET /:userId - Get cart for a user
router.get('/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userId) return res.status(400).json({ message: "User ID required" });

        const cart = await getCartCollection(req).findOne({ userId });

        if (!cart) {
            return res.json({ items: [], total: 0 });
        }

        // Enrich items with product details
        const enrichedItems = [];
        let total = 0;

        for (const item of cart.items) {
            let product = null;
            try {
                product = await getProductsCollection(req).findOne({ _id: new ObjectId(item.productId) });
            } catch (e) {
                // Invalid ID format or not found
            }

            if (product) {
                const itemTotal = (parseFloat(product.price) || 0) * item.quantity;
                total += itemTotal;
                enrichedItems.push({
                    productId: item.productId,
                    name: product.name,
                    price: product.price,
                    image: product.image,
                    quantity: item.quantity,
                    unit: product.unit,
                    vendorId: product.vendorId
                });
            }
        }

        res.json({ items: enrichedItems, total: parseFloat(total.toFixed(2)) });
    } catch (error) {
        console.error("Get Cart Error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// POST /add - Add item to cart
router.post('/add', async (req, res) => {
    try {
        const { userId, productId, quantity } = req.body;
        if (!userId || !productId) return res.status(400).json({ message: "Missing fields" });

        const qty = parseInt(quantity) || 1;

        let cart = await getCartCollection(req).findOne({ userId });

        if (!cart) {
            cart = {
                userId,
                items: [],
                createdAt: new Date(),
                updatedAt: new Date()
            };
        }

        const existingItemIndex = cart.items.findIndex(i => i.productId === productId);

        if (existingItemIndex > -1) {
            cart.items[existingItemIndex].quantity += qty;
        } else {
            cart.items.push({ productId, quantity: qty });
        }

        cart.updatedAt = new Date();

        await getCartCollection(req).updateOne(
            { userId },
            { $set: cart },
            { upsert: true }
        );

        res.json({ message: "Item added to cart" });

    } catch (error) {
        console.error("Add to Cart Error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// PUT /update - Update item quantity
router.put('/update', async (req, res) => {
    try {
        const { userId, productId, quantity } = req.body;
        if (!userId || !productId) return res.status(400).json({ message: "Missing fields" });

        const qty = parseInt(quantity);
        if (qty < 1) {
            // If quantity is less than 1, we could remove it, or return error. 
            // Let's assume frontend calls remove for 0, but we can handle it here too.
            // For now, let's just create an update.
        }

        await getCartCollection(req).updateOne(
            { userId, "items.productId": productId },
            { $set: { "items.$.quantity": qty, updatedAt: new Date() } }
        );

        res.json({ message: "Cart updated" });

    } catch (error) {
        console.error("Update Cart Error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// DELETE /remove - Remove item from cart
router.delete('/remove', async (req, res) => {
    try {
        const { userId, productId } = req.body;
        if (!userId || !productId) return res.status(400).json({ message: "Missing fields" });

        await getCartCollection(req).updateOne(
            { userId },
            {
                $pull: { items: { productId } },
                $set: { updatedAt: new Date() }
            }
        );

        res.json({ message: "Item removed" });

    } catch (error) {
        console.error("Remove Item Error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// DELETE /clear - Clear cart
router.delete('/clear', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ message: "User ID required" });

        await getCartCollection(req).updateOne(
            { userId },
            { $set: { items: [], updatedAt: new Date() } }
        );

        res.json({ message: "Cart cleared" });

    } catch (error) {
        console.error("Clear Cart Error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

module.exports = router;
